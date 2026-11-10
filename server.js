import 'dotenv/config';
import compression from 'compression';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import sgMail from '@sendgrid/mail';
import PDFDocument from 'pdfkit';
import crypto from 'crypto';
import dns from 'dns/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Runtime data lives in DATA_DIR (a persistent disk in production). The committed ./data folder
// is the seed: on first boot to a fresh disk, copy the seed prospects in so nothing is lost.
const SEED_DIR = path.join(__dirname, 'data');
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));
const DATA_DIR = process.env.DATA_DIR || SEED_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
if (DATA_DIR !== SEED_DIR) {
  for (const f of ['prospects.json', 'metrics.json']) {
    const dst = path.join(DATA_DIR, f), src = path.join(SEED_DIR, f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
}
const DATA = path.join(DATA_DIR, 'prospects.json');
const CSV = path.join(__dirname, '..', 'PROSPECTS_cherokee_LOCAL.csv');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// New cold outreach and follow-ups now have SEPARATE daily budgets, so a heavy follow-up day
// can no longer starve new prospecting. Total daily volume from this domain is the SUM of the
// two, so raising either one raises the reputation load. COLD_DAILY_CAP falls back to the old
// DAILY_SEND_CAP so existing deploys keep working.
const COLD_DAILY_CAP = Number(process.env.COLD_DAILY_CAP || process.env.DAILY_SEND_CAP) || 40;
const FOLLOWUP_DAILY_CAP = Number(process.env.FOLLOWUP_DAILY_CAP) || 40;
const DAILY_CAP = COLD_DAILY_CAP;   // kept for anything still reading the old name
// Transient failures deserve a retry, but not forever.
const MAX_SEND_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS) || 4;

// ---------- storage (simple JSON file) ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return null; }
}
function save(rows) { fs.writeFileSync(DATA, JSON.stringify(rows, null, 2)); }

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
function seedFromCsv() {
  const raw = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '');
  const lines = raw.trim().split('\n');
  const headers = parseCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim());
  const idx = n => headers.indexOf(n);
  const rows = lines.slice(1).map((l, i) => {
    const c = parseCsvLine(l).map(x => x.replace(/^"|"$/g, ''));
    return {
      id: 'P' + String(i + 1).padStart(3, '0'),
      business: c[idx('title')] || '',
      category: c[idx('categoryName')] || '',
      city: c[idx('city')] || '',
      phone: c[idx('phone')] || '',
      website: c[idx('website')] || '',
      rating: c[idx('totalScore')] || '',
      reviews: c[idx('reviewsCount')] || '',
      email: '',
      subject: '',
      body: '',
      status: 'new',        // new -> drafted -> approved -> sent -> replied / rejected
      updated_at: new Date().toISOString(),
    };
  });
  save(rows);
  return rows;
}
let prospects = load() || seedFromCsv();

// ---------- No-website call list ----------
// Calling leads, never emailed. They live in the same list as everything else so the board,
// owners and notes all work, but every sender, drafter, scanner and purger skips them: they carry
// source 'callleads' and do_not_email, and sendMail itself refuses them as the last line of defence.
// The data ships in data/call_leads.json and is merged in on every boot. Merging only ever adds new
// leads and refreshes the research fields, so nobody's owner, contact name, call outcome, notes or
// status is overwritten by a deploy.
let CALL_SCRIPTS = [];
function ensureCallLeads() {
  let src;
  try { src = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'call_leads.json'), 'utf8')); }
  catch (e) { console.warn('[callleads] no call_leads.json:', e.message); return; }
  CALL_SCRIPTS = src.scripts || [];
  const byId = new Map(prospects.filter(x => x.source === 'callleads').map(x => [x.id, x]));
  const nowIso = new Date().toISOString();
  let added = 0, refreshed = 0;
  for (const l of src.leads || []) {
    const research = { ...l.info, lead_id: l.lead_id, maps_url: l.maps_url };
    const cur = byId.get(l.id);
    if (!cur) {
      prospects.push({
        id: l.id, business: l.business, category: l.category, city: l.city, phone: l.phone,
        website: '', rating: l.rating, reviews: l.reviews, email: '', subject: '', body: '', notes: [],
        handled_by: '', deal_value: '', contact_first: '', contact_name: l.contact_name || '',
        contact_name_source: l.contact_name_source || '',
        status: l.removed ? 'lost' : 'calllist', source: 'callleads', do_not_email: true,
        call_outcome: l.removed ? 'Actually has a website' : '', call_tier: l.tier, call_flags: l.flags, calllead: research,
        created_at: nowIso, updated_at: nowIso,
      });
      added++;
    } else {
      cur.do_not_email = true; cur.email = cur.email || '';
      cur.call_tier = l.tier; cur.call_flags = l.flags; cur.calllead = research;
      if (l.removed && cur.status === 'calllist') { cur.status = 'lost'; cur.call_outcome = 'Actually has a website'; cur.updated_at = nowIso; }
      cur.business = cur.business || l.business;
      refreshed++;
    }
  }
  if (added) save(prospects);
  console.log('[callleads] added', added, 'refreshed', refreshed, 'total', (src.leads || []).length);
}
ensureCallLeads();

// One-time, idempotent. bounced_at and complained_at did not exist until the September metrics
// fix, so every send before it has no delivery outcome stamped on it and would read as clean.
// Recover the real outcomes from the error strings and notes the webhook already wrote.
// Deliberately narrow: only the three errors that mean the mail actually failed at the mail layer
// count as bounces. 'On the SendGrid suppression list' does NOT, because that list is also fed by
// unsubscribes and complaints, and neither is a bounce.
(function backfillDeliveryOutcomes() {
  const HARD = /^(Hard bounce|Dropped before sending|Blocked by the receiving server)/i;
  let b = 0, c = 0;
  for (const p of prospects) {
    if (!p.bounced_at && HARD.test(String(p.last_send_error || ''))) {
      p.bounced_at = p.updated_at || p.sent_at || new Date().toISOString();
      b++;
    }
    if (!p.complained_at && Array.isArray(p.notes)
        && p.notes.some(n => /Marked this as spam/i.test(String(n && n.text || '')))) {
      p.complained_at = p.updated_at || p.unsubscribed_at || new Date().toISOString();
      c++;
    }
  }
  if (b || c) {
    try { save(prospects); } catch {}
    console.log(`[backfill] stamped ${b} bounces and ${c} complaints from historical records`);
  }
})();

// ---------- Claude draft ----------
// Lightweight AI-visibility probe: does an AI assistant actually recognize this business? Training-knowledge only, no guessing.
async function aiVisibilityProbe(business, city, category) {
  if (!process.env.ANTHROPIC_API_KEY || !business) return null;
  try {
    const probe = `You are testing whether AI assistants recognize a specific local business. Answer ONLY from your own training knowledge. Do NOT guess, infer, or invent. If you do not genuinely and specifically recognize this exact business, set known to false.
Business: "${business}"${city ? ', in ' + city + ', GA' : ''}${category ? ' - a ' + category : ''}.
Return ONLY JSON: {"known": true|false, "confidence": "high|medium|low", "wouldRecommend": true|false, "competitorsKnown": true|false, "whatAiKnows": "one honest sentence"}`;
    const r = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: 300, messages: [{ role: 'user', content: probe }] });
    if (!((r.content || []).find(b => b && b.type === 'text')?.text || '').includes('{')) { console.error('[ai] no JSON, stop_reason', r.stop_reason, 'blocks', (r.content || []).map(b => b.type).join(',')); try { r = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: maxTokens || 4000, system, messages: [{ role: 'user', content: user + '\n\nReturn only the JSON object, nothing else.' }] }); } catch (e) {} }
  let t = ((r.content || []).find(b => b && b.type === 'text')?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const m = t.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

// Each prospect's own worst-scoring category picks the angle. That is what stops a thousand
// emails sharing one shape: businesses fail differently, so the batch diverges on real data
// rather than on a rotation we invented. Spam filters cluster identical patterns, and so do
// humans who compare notes.
const ANGLES = {
  'Website & Speed':      { key: 'speed',    subj: ['how long your site takes to load', 'your site on a phone', 'slow on mobile'] },
  'Converting Visitors':  { key: 'convert',  subj: ['no way to book you online', 'nowhere to click on your site'] },
  'Tracking & Data':      { key: 'tracking', subj: ['no tracking on your site', 'where your leads come from'] },
  'AI Search Presence (AIO)': { key: 'ai',   subj: ['ai assistants do not know you yet', 'when people ask ai for a {cat}'] },
  'AI Search':            { key: 'ai',       subj: ['ai assistants do not know you yet', 'when people ask ai for a {cat}'] },
  'Local Visibility':     { key: 'local',    subj: ['{n} reviews and still hard to find'] },
  'Getting Found (SEO)':  { key: 'seo',      subj: ['not on page one for {cat} in {city}', 'what google cannot read on your site'] },
  'Social & Content':     { key: 'social',   subj: ['nothing for people to look at'] },
};

function pickAngle(p) {
  const cats = (p.audit_report && p.audit_report.categories) || [];
  if (!cats.length) return null;
  const ranked = cats.slice()
    .sort((a, b) => (Number(a.score) || 0) - (Number(b.score) || 0))
    .filter(c => ANGLES[c.name]);
  if (!ranked.length) return null;
  // Tracking is the weakest area on most small business sites, so always taking the single worst
  // made most of the batch say the same thing. Alternate between the two weakest on a stable hash
  // of the lead id: still driven by their real scores, but the batch stops looking like one email.
  const h = crypto.createHash('sha1').update(String(p.id)).digest()[0];
  const pick = ranked.length > 1 && (h & 1) ? ranked[1] : ranked[0];
  return { ...ANGLES[pick.name], name: pick.name, score: Number(pick.score), why: pick.why || '' };
}

async function draftEmail(p) {
  const rep = p.audit_report;

  // No stored report means this lead was never pre-scanned. Rather than invent an observation we
  // have not actually made, fall back to the live AI probe, which is a real check.
  if (!rep || !(rep.findings || []).length) return draftEmailUnscanned(p);

  // The angle, the leading finding and the measured facts used to be assembled here and pushed
  // into the prompt. They are deliberately gone. Nothing about this prospect's site, profile or
  // scores may reach the copy, so computing it would only invite someone to wire it back in.
  // pickAngle and ANGLES are kept because the report page still uses them.

  // Rotated in code, not chosen by the model, for the reason above.
  // Naming the cold email disarms it. Pretending it is anything else is the thing that makes people
  // delete it, and a business owner who has just been told their site is broken by a stranger is
  // not in a buying mood unless you take the sting out first.
  const OPENERS = [
    "Cold email, I know. This one's short.",
    "Cold email. I'll be quick.",
    "Yes, this is a cold email. It's a short one.",
    "Cold outreach, so I'll get straight to it.",
    "This is a cold email, but it's about your business, not mine.",
    "Cold email. Thirty seconds, then I'm gone.",
  ];
  const opener = OPENERS[crypto.createHash('sha1').update('open:' + p.id).digest()[0] % OPENERS.length];

  const CLOSERS = [
    'Worth a look?',
    "Thought you'd want to know.",
    'Happy to walk you through it.',
    "It's already done, just say the word.",
    'Might be worth ten minutes.',
    'Take a look when you get a second.',
  ];
  const closer = CLOSERS[crypto.createHash('sha1').update('close:' + p.id).digest()[0] % CLOSERS.length];

  // NO FINDINGS IN THE COPY. Not in the subject, not in the body, not as a number, not as a
  // paraphrase. This used to lead on the single worst finding, and the whole class of failure came
  // from that: the copy asserted something about a stranger's business and we were not in a
  // position to be sure. Scott Hessing got "0 Google reviews since 2023" and had 161 of them.
  //
  // The review data is the clearest case but not the only one. Google Places returns at most 5
  // reviews sorted by RELEVANCE and never by date, so "newest we saw is 1,277 days old" never
  // meant "no review in 3.5 years", it meant the newest of the two Google chose to show us was
  // that old. Three more businesses got a recency claim built on that, and every one of them was
  // unsupportable even though it matched our stored data exactly. The conversion signals carry the
  // same risk: hasForm, hasBooking and hasPhone are raw HTML only, so on a JS-rendered site they
  // can be wrong the same way the tracking tags were.
  //
  // So the email no longer diagnoses. It says we put a breakdown together and here it is. The
  // findings still exist, they are still good, and the prospect reads them on the report page
  // where they are shown with their own context and caveats. What we will not do is compress one
  // of them into a subject line and assert it to someone who knows their own business better
  // than we do.
  const prompt = `You are Michelle at Open Heart Media in Canton, Georgia. You are writing one cold email to a local business owner.

CRITICAL CONTEXT: we have ALREADY put together a breakdown of this business's online presence. It is built and waiting at the link. You are NOT offering to run anything, NOT asking permission, NOT inviting them to request an audit. Never use the words "free audit", and never ask them to run, request or start a scan.

BUSINESS: ${p.business}, a ${p.category} in ${p.city}, GA.

THE SINGLE MOST IMPORTANT RULE, ABOVE EVERY OTHER RULE BELOW:
You do not know anything about this business beyond its name, category and city. You have NOT been given their findings and you will NOT be given them. Therefore:
- State NO fact, problem, gap, weakness, score, measurement or observation about their website, their Google profile, their reviews, their rankings, their speed, their booking, their tracking or their social presence.
- Use NO numbers about them of any kind. No counts, no scores, no times, no percentages, no dates, no durations.
- Do NOT guess, imply, hint at or hedge toward a problem. Not "your site might be slow", not "most painters in your area are losing calls", not "there is probably something here".
- If you catch yourself writing a sentence that could be true or false about their business, delete it.
The report is what makes the claims. The email exists to hand it over, nothing more.

WRITE:
1. Subject line. SENTENCE CASE (capital first letter only, everything else lowercase unless a proper noun). UNDER 45 CHARACTERS. No exclamation marks, no ALL CAPS, never the words "free" or "audit", never a number, never a claim about them.
   It may name their business, their city, or their category, and it may say that something has been written up or put together for them. That is the whole permitted range. Good shapes: "Something we put together for ${p.business}", "A breakdown of ${p.business} online", "We looked at ${p.business}", "Wrote this up for a ${(p.category || 'local business').toLowerCase()} in ${p.city}".

2. Body. UNDER 55 WORDS TOTAL. FOUR SHORT BLOCKS separated by blank lines:

   Line 1: write exactly this opener and nothing else: ${opener}
   Line 2: say plainly that you looked at how ${p.business} shows up online and wrote up what you found. One sentence. No conclusions from it.
   Line 3: one short handoff, for example "It's here:" or "Have a look:"
   [LINK]
   Line 4: write exactly this closing line and nothing else: ${closer}

3. Sign exactly, on three lines:
Michelle Baker
Open Heart Media
openheartmediaco.com

TONE: direct and human. A person in Canton who spent some time on their business and is handing over the result. Contractions always. Never chatty, never padded, never apologetic. Brevity is the courtesy.

HARD RULES:
- Under 55 words. Shorter always wins.
- NEVER make them feel stupid, judged or behind. You are not telling them anything is wrong, because you are not telling them anything at all.
- Dry wit in the phrasing is welcome. Smugness is not.
- NO third-party statistics, no research citations, no percentages.
- Do not mention video, social or web design as services.

BANNED WORDS AND PHRASES: em dashes and any dash used as punctuation, exclamation marks, "hope this finds you well", "quick question", "I wanted to reach out", "leverage", "unlock", "scale", "solutions", "circle back", "synergy", "in today's digital landscape".

Return ONLY JSON: {"subject": "...", "body": "..."}`;

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }],
  });
  return finishDraft(r, p);
}

// Fallback for a lead with no stored report: the live AI-visibility probe is a real observation,
// so it is honest to lead with it.
async function draftEmailUnscanned(p) {
  // This used to lead on the live AI visibility probe, or on their review numbers when the probe
  // came back clean. Both are claims about the prospect and both are out for the same reason as
  // everywhere else: the probe tells us what one model happens to know, which is not the same as
  // what a buyer sees, and the review numbers cannot carry the weight the copy put on them.
  // A lead with no stored breakdown gets the plainest possible version. There is nothing to say
  // yet, so the email does not pretend otherwise.
  const OPENERS = [
    "Cold email, I know. This one's short.",
    "Cold email. I'll be quick.",
    "Cold outreach, so I'll get straight to it.",
  ];
  const opener = OPENERS[crypto.createHash('sha1').update('open:' + p.id).digest()[0] % OPENERS.length];
  const prompt = `You are Michelle at Open Heart Media in Canton, Georgia, writing one cold email to ${p.business}, a ${p.category} in ${p.city}, GA.

THE SINGLE MOST IMPORTANT RULE: you know nothing about this business except its name, category and city. State NO fact, problem, gap, score or observation about their website, Google profile, reviews, rankings, speed, booking, tracking or social presence. Use NO numbers about them. Do not guess at a problem or hint at one. If a sentence could be either true or false about their business, delete it.

WRITE:
Line 1: exactly this opener and nothing else: ${opener}
Line 2: say you work with local businesses around ${p.city} and you can put together a breakdown of how ${p.business} shows up online, covering the site, search and how easy they are to contact. One sentence. Offer it, do not claim anything about them.
Line 3: one short line asking if they want it. Then the token [LINK] alone on its own line.
Then sign exactly on three lines: Michelle Baker / Open Heart Media / openheartmediaco.com

RULES: subject in SENTENCE CASE, UNDER 45 CHARACTERS, no exclamation marks, never the words "free" or "audit", never a number, never a claim about them. Body UNDER 50 WORDS, plain words, contractions. BANNED: em dashes and dashes as punctuation, exclamation marks, "hope this finds you well", "leverage", "unlock", "scale", "solutions". Invent no numbers.

Return ONLY JSON: {"subject": "...", "body": "..."}`;

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }],
  });
  return finishDraft(r, p);
}

function finishDraft(r, p) {
  let txt = ((r.content || []).find(b => b && b.type === 'text')?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) txt = m[0];
  const out = JSON.parse(txt);

  // The model complies with the no-dash rule most of the time, which is not the same as always.
  const deDash = t => typeof t === 'string'
    ? t.replace(/\s*[—–]\s*/g, ', ').replace(/\s+--\s+/g, ', ').replace(/--/g, ', ')
    : t;
  out.subject = deDash(out.subject || '');
  out.body = deDash(out.body || '');

  // Subject discipline, enforced rather than requested: lowercase, no trailing punctuation, and
  // trimmed at a word boundary if it ran long.
  // Sentence case, not lowercase: lowercase reads as a peer note to a founder and as carelessness
  // to a roofer, and it is a well known cold-email tell either way. Requested in the prompt and
  // enforced here, because casing is exactly the kind of instruction a model drifts on.
  out.subject = out.subject.replace(/[!.]+$/, '').trim();
  if (out.subject) out.subject = out.subject.charAt(0).toUpperCase() + out.subject.slice(1);
  if (out.subject.length > 45) {
    // Cutting at 45 and stopping used to leave the subject hanging mid-clause ("Your site takes
    // 6.9 seconds to load on a"), which reads as a broken email rather than a short one. Trim the
    // partial word, then keep dropping trailing connectives until the line ends on a word that can
    // actually end a sentence. If that leaves nothing usable, keep the model's line intact and let
    // the inbox truncate it, because an over-long real sentence beats a severed one.
    let cut = out.subject.slice(0, 45).replace(/\s+\S*$/, '').trim();
    let prev;
    do {
      prev = cut;
      cut = cut.replace(/[\s,;:]+(?:in|on|at|to|of|for|a|an|the|your|our|and|or|with|from|by|into|about|that|this|is|are|was|were|it|its|you|they|who|when|where|how|why)$/i, '').trim();
    } while (cut !== prev);
    out.subject = cut.length >= 18 ? cut : out.subject.trim();
  }

  // These emails are plain text, deliberately, because that is what survives spam filters and
  // reads like a person. Plain text has no preheader to set: Gmail builds the preview from the
  // opening of the body. So rather than pretend we control a separate field, compute exactly what
  // the inbox will show and store it, so it can be read and edited before anything is sent.
  out.preview = '';
  const link = reportUrl(p);
  if (out.body.includes('[LINK]')) out.body = out.body.replace('[LINK]', link);
  else out.body = out.body.replace(/\n*Michelle,/, `\n\n${link}\n\nMichelle,`);
  if (!out.body.includes(link)) out.body += `\n\n${link}`;
  // Asked for in the prompt and dropped every single time, so it is enforced rather than requested.
  if (!/Michelle/i.test(out.body)) out.body = out.body.replace(/\s*$/, '') + '\n\nMichelle Baker\nOpen Heart Media';
  out.preview = out.body.replace(/\s+/g, ' ').trim().slice(0, 110);
  // A recognisable domain they can look up themselves. Wariness about links from strangers is
  // reasonable, and the answer is giving them something checkable, not a shorter URL.
  if (!/openheartmediaco\.com\s*$/i.test(out.body)) out.body = out.body.replace(/\s*$/, '') + '\nopenheartmediaco.com';
  out.body = out.body.replace(/^Michelle,?\s*$/m, 'Michelle Baker');
  // Same grounding check the follow-ups get. Function declarations hoist, so this resolves even
  // though assertGrounded is defined further down the file.
  return assertGrounded(out, p, 'cold email');
}

// Origin of the public site, derived from LANDING_URL so there is one place to change it.
const SITE_ORIGIN = (process.env.PUBLIC_URL
  || (process.env.LANDING_URL || '').replace(/\/go\/?$/, '')
  || `http://localhost:${process.env.PORT || 4100}`).replace(/\/$/, '');
const META_PIXEL_ID = process.env.META_PIXEL_ID || '';
const GA4_ID = process.env.GA4_ID || '';
const LANDING_URL = process.env.LANDING_URL || `http://localhost:${process.env.PORT || 4100}/go`;

// ---------- SCANNING AUDIT ENGINE (multi-page website + social + marketing + AI-search scan) ----------
const AUDIT_UA = 'Mozilla/5.0 (compatible; OHMAuditBot/1.0; +https://openheartmediaco.com)';
// Security plugins on WordPress (Wordfence and friends) and most WAF bot rules reject any agent
// they do not recognise, so a self-identifying string gets a 403 from a perfectly healthy site:
// azerplumb.com answers 403 to the line above and 200 to this one. That surfaced to the prospect
// as "we could not load your site", which is both wrong and embarrassing on a page selling audits.
// We lead with the honest identity and only fall back when we are actively blocked.
const AUDIT_UA_FALLBACK = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BLOCKED = new Set([401, 403, 405, 406, 409, 418, 429, 451]);

function stripText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|quot|#39|apos|mdash|ndash);/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fetchPage(url, timeout = 12000) {
  try {
    // From: keeps us identifiable to anyone reading their logs even on the fallback attempt.
    const get = ua => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': ua, 'From': 'zac@openheartmediaco.com', 'Accept': 'text/html,application/xhtml+xml' } });
    let res = await get(AUDIT_UA);
    if (BLOCKED.has(res.status)) {
      console.warn('[audit] blocked with', res.status, 'on', url, '- retrying as a standard browser');
      res = await get(AUDIT_UA_FALLBACK);
    }
    // 900KB was too small: heavy page builders (Wix, Squarespace, etc.) routinely front-load huge
    // amounts of inline script/CSS/JSON before the real body content, so real signals like the H1
    // and images were getting silently truncated away on larger sites. 6MB comfortably covers that
    // while still bounding memory on a pathological response.
    const html = (await res.text()).slice(0, 6000000);
    return { ok: res.ok, status: res.status, finalUrl: res.url, html };
  } catch (e) { return { ok: false, error: e.message, finalUrl: url, html: '' }; }
}

// Tighter social detection: ignore share/pixel/plugin/intent links, keep real profile links only.
// Social icons that exist on the page but link nowhere (no href, "#", or a script stub). Common in
// page builders where the icon was added and the address never filled in. The owner sees an icon;
// a visitor clicking it goes nowhere.
function extractDeadSocials(html) {
  const out = {};
  const plats = 'facebook|instagram|twitter|youtube|linkedin|pinterest|tiktok';
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const cls = (attrs.match(/class\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const hit = cls.match(new RegExp('(?:social|icon)[^\\s]*?-(' + plats + ')\\b|\\bfa-(' + plats + ')\\b|\\be-fab-(' + plats + ')\\b', 'i'));
    if (!hit) continue;
    const plat = (hit[1] || hit[2] || hit[3]).toLowerCase();
    const href = (attrs.match(/href\s*=\s*["']([^"']*)["']/i) || [null, null])[1];
    if (href === null || /^\s*(#|javascript:)/i.test(href) || href.trim() === '') out[plat] = true;
  }
  return out;
}
function extractSocials(html) {
  const out = {};
  const bad = /(sharer|share\.php|\/tr\b|\/tr\?|plugins|dialog|intent|\/share|\/events\/|widgets|badge|oembed|\/plugins\/)/i;
  const reserved = /^\/(share|sharer|intent|home|login|signup|privacy|tos|hashtag|explore|tr|plugins|dialog|help|policies|policy|about\/)/i;
  const patterns = {
    facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-]{2,}(?:\/[A-Za-z0-9.\-]+)?/ig,
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]{2,}/ig,
    tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.]{2,}/ig,
    youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[A-Za-z0-9_\-]{2,}/ig,
    linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_\-]{2,}/ig,
    x: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{2,}/ig,
  };
  for (const [k, re] of Object.entries(patterns)) {
    const matches = html.match(re) || [];
    const good = matches.map(m => m.split('?')[0]).find(m => {
      if (bad.test(m)) return false;
      const p = m.replace(/^https?:\/\/[^/]+/i, '');
      return !reserved.test(p);
    });
    if (good) out[k] = good;
  }
  return out;
}

// Per-page conversion/trust signals, tightened to cut false positives. OR-merged across pages.
function pageSignals(html) {
  const text = stripText(html);
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const hasForm = forms.some(f =>
    (/(type=["'](email|tel)["']|<textarea|name=["'][^"']*(email|e-mail|phone|message|comment|fullname|contact)[^"']*["'])/i.test(f))
    && !/(role=["']search["']|type=["']search["']|id=["'][^"']*search|name=["'](search|q|query|s)["']|action=["'][^"']*search)/i.test(f));
  const hasBooking = /(book (now|online|an?\s+appointment)|schedule (an?\s+|your\s+)?(appointment|consultation|visit|call|service)|calendly\.com|acuityscheduling|squareup\.com\/appointments|setmore|book(sy|ing)\.|vagaro|mindbodyonline|housecallpro|request (an?\s+|your\s+)?(appointment|quote|estimate))/i.test(html);
  // This used to demand the words "subscribe", "sign up" or "join" near "newsletter".
  // Our own form says "Send me the guide" and was reported as no email capture at all.
  // A visible email input that is not a login or a search box is email capture,
  // whatever the button happens to say. The vocabulary match is kept as a second
  // route in, not as a requirement.
  const emailInput = /<input[^>]+type=["']email["']/i.test(html);
  const looksLikeLogin = /<input[^>]+type=["']password["']/i.test(html);
  const newsletterWords = /(subscribe|sign\s?up|join)[^<>]{0,45}(newsletter|email list|mailing list|our email|updates)/i.test(text)
    || /(join our (email|mailing) list|get (our )?newsletter)/i.test(text)
    || /(send me|get) (the |your |our )?(guide|checklist|playbook|report|free)/i.test(text);
  const hasNewsletter = emailInput && !looksLikeLogin && (newsletterWords || /<form/i.test(html));
  const hasLiveChat = /(intercom|drift\.com|tawk\.to|zendesk|tidio|crisp\.chat|hubspot[^"']*conversations|livechatinc|customerchat|messenger[^"']*chat|gorgias|podium|chatwoot|olark|liveperson)/i.test(html);
  const hasCta = /(get (a |your )?(free )?(quote|estimate|consultation|demo|assessment|inspection|pricing)|request (a |your )?(free )?(quote|estimate|consultation|callback|appointment)|book (a |your |now|online|an appointment)|schedule (a |your |an? |now|online)|call now|claim your|get started|start (your|a) )/i.test(html);
  // tel: links are written many ways: tel:+17703452010, tel:(770) 345-2010, tel:770-345-2010, tel:%20770...
  // The old pattern needed a digit straight after "tel:", so any link that began with "(" or a space was
  // missed and the report told the owner "no clickable phone number" about a number they had linked.
  const hasPhone = /href=["']\s*tel:[\s+()%0-9a-f-]{0,6}[0-9]/i.test(html);
  // A published number that is not wrapped in a tel: link is still a phone number.
  // Reporting "no phone number" to a business whose number is printed on their own
  // homepage is the single most credibility-destroying thing this audit can do, and
  // it happened. Click-to-call stays the strict check, because that is what the item
  // claims to measure, but we now also record whether a number is visible at all so
  // the written report can say "your number is there but it is not tappable" instead
  // of "you have no phone number".
  const phoneTextRe = /(\(\d{3}\)\s*|\b\d{3}[.\-\s])\d{3}[.\-\s]\d{4}\b/;
  const phoneVisible = hasPhone || phoneTextRe.test(text);
  const hasEmailLink = /href=["']mailto:[^"']+@/i.test(html);
  // The scanner strips <script> before building `text`, which removes JSON-LD, so an
  // address that lives only in structured data read as no address at all. On our own
  // site that produced "no physical address on the site" while 225 Reformation Pkwy
  // sat in the LocalBusiness schema. Check both, and keep them apart: an address in
  // schema only is a real finding, but it is a different finding from having none.
  const streetRe = /\b\d{1,6}\s+([A-Za-z0-9.'\-]+\s){1,4}(street|st\.?|ave\.?|avenue|road|rd\.?|blvd\.?|boulevard|drive|dr\.?|lane|ln\.?|way|court|ct\.?|suite|ste\.?|hwy|highway|pkwy|parkway|place|pl\.?|circle|cir\.?|trail|terrace)\b/i;
  // This was hardcoded to Georgia: it required the literal "GA" and a 3xxxx ZIP. Any
  // business outside Georgia was told it had no address on its site, no matter how
  // plainly the address was printed. A Hilton Head SC practice with "1 Row Boat Rd,
  // Hilton Head Island, SC 29928" on its contact page scored a flat zero for local
  // trust because of this line. The audit runs on out-of-state leads now, so match any
  // US state, and accept a street line plus any ZIP as the general case.
  const US_STATE = "A[LKSZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY]";
  const cityStateZip = new RegExp("\\b[A-Za-z.'\\-\\s]{2,28},\\s*(?:" + US_STATE + ")\\.?\\s+\\d{5}(?:-\\d{4})?\\b");
  const zipAnywhere = /\b\d{5}(?:-\d{4})?\b/;
  const napVisible = cityStateZip.test(text) || (streetRe.test(text) && zipAnywhere.test(text));
  const napInSchema = /"streetAddress"\s*:\s*"[^"]{4,}"/i.test(html)
    || /itemprop=["']streetAddress["']/i.test(html);
  const napAddress = napVisible || napInSchema;
  const schemaKnownType = /("@type"\s*:\s*"?(LocalBusiness|Dentist|MedicalBusiness|MedicalClinic|Restaurant|Attorney|LegalService|HomeAndConstructionBusiness|Plumber|Electrician|RoofingContractor|GeneralContractor|Contractor|MovingCompany|ProfessionalService|Store|HealthAndBeautyBusiness|BeautySalon|HairSalon|DaySpa|AutoRepair|RealEstateAgent|Physician|Dentistry)"?|itemtype=["'][^"']*schema\.org\/(LocalBusiness|[A-Za-z]*Business))/i.test(html);
  // Business types are a long tail (ExerciseGym, HealthClub, Locksmith, ...), so the named list
  // above cannot be complete and a miss prints a false "no local business markup". A JSON-LD
  // block with a street address, coordinates or opening hours attached to a specific type is a
  // local business description whatever the type is called.
  const ldBlocks = (html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []).join(' ');
  const generic = /^(WebSite|WebPage|ImageObject|BreadcrumbList|ListItem|SearchAction|PostalAddress|GeoCoordinates|OpeningHoursSpecification|ContactPoint|Person|Article|BlogPosting|NewsArticle|CollectionPage|ItemList|Offer|Product|VideoObject|Question|Answer|FAQPage|SiteNavigationElement|WPHeader|WPFooter|EntryPoint|Rating|AggregateRating|Review|PropertyValue)$/i;
  const ldTypes = [...ldBlocks.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
  const schemaLocalBusiness = schemaKnownType
    || (/"@type"\s*:\s*"(PostalAddress|GeoCoordinates|OpeningHoursSpecification)"|"openingHours"/.test(ldBlocks)
        && ldTypes.some(t => !generic.test(t)));
  const faqSchema = /("@type"\s*:\s*"?(FAQPage|Question)"?)/i.test(html);
  const sameAs = /"sameAs"\s*:/i.test(html);
  return { text, hasForm, hasBooking, hasNewsletter, hasLiveChat, hasCta, hasPhone, phoneVisible, hasEmailLink, napAddress, napVisible, napInSchema, schemaLocalBusiness, faqSchema, sameAs };
}

// Which named AI crawlers are explicitly blocked in robots.txt (ignores wildcard-only rules to avoid false alarms).
function aiCrawlerBlocks(robotsTxt) {
  const bots = ['GPTBot','ClaudeBot','Claude-Web','anthropic-ai','PerplexityBot','Google-Extended','CCBot','Applebot-Extended','Bytespider'];
  const blocked = [];
  const groups = robotsTxt.split(/\n(?=\s*user-agent:)/i);
  for (const g of groups) {
    const uas = [...g.matchAll(/user-agent:\s*([^\n\r]+)/ig)].map(m => m[1].trim());
    const disallowAll = /(^|\n)\s*disallow:\s*\/\s*($|\n)/i.test(g) && !/(^|\n)\s*allow:\s*\/\s*($|\n)/i.test(g);
    if (!disallowAll) continue;
    for (const bot of bots) if (uas.some(u => u.toLowerCase() === bot.toLowerCase())) blocked.push(bot);
  }
  return [...new Set(blocked)];
}

// Prospects who arrive from a cold email carry ?ref=<id> so we know who they are. Anyone who lands
// organically, or who was forwarded the link, does not, and the form never asks for a company name.
// Without this the report is addressed to "your business" and the Google Business lookup is skipped
// entirely, which reads as a form letter at the exact moment we are trying to look thorough. The
// page title is the best source we already have: strip the tagline that follows the usual
// separators and keep the leading brand.
function deriveBusinessName(scan) {
  const t = (scan?.title || '').trim();
  if (t) {
    const head = t.split(/\s+[|·•–—-]\s+/)[0].trim();
    if (head.length >= 2 && head.length <= 60 && !/^(home|welcome|index)$/i.test(head)) return head;
  }
  const host = (scan?.host || '').replace(/^www\./, '').split('.')[0];
  return host ? host.charAt(0).toUpperCase() + host.slice(1) : null;
}

// One place that turns whatever the prospect typed into an absolute URL. The scan normalized it
// internally, but PageSpeed was handed the raw string, and Google's API rejects a bare hostname
// outright ("Values must match: (?i)(url:|origin:)?http(s)?://.*"). Since most people type
// "theirsite.com", speed and Core Web Vitals were quietly missing from most audits, and with them
// the rendered-Chrome fallbacks that stop JS-heavy sites being false-flagged.
function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return ''; }
}

// The audit form took anything non-empty as a website. Griffin submitted the SendGrid click
// tracking link out of one of our own emails, url9899.openheartmediaco.com/ls/click?upn=..., and
// the scanner dutifully scanned the redirect shell: Tracking & Data came back 0/100 because there
// was nothing there to find, and every other score was measuring a hop, not a business. A lead who
// pastes the wrong thing should be told at the form while they are still sitting there, not handed
// a confident report about a URL that is not theirs.
const TRACKER_PATTERNS = [
  /^url\d+\./i, /\/ls\/click/i,                              // SendGrid
  /(^|\.)list-manage\.com$/i,                                  // Mailchimp
  /(^|\.)hubspotlinks\.com$/i, /(^|\.)hs-sites\.com$/i,        // HubSpot
  /(^|\.)klclick\d*\.com$/i, /(^|\.)klaviyomail\.com$/i,      // Klaviyo
  /(^|\.)rs6\.net$/i,                                          // Constant Contact
  /^(bit\.ly|t\.co|tinyurl\.com|lnkd\.in|goo\.gl|ow\.ly|buff\.ly|rb\.gy|is\.gd|cutt\.ly)$/i,
];
// A profile on somebody else's platform is not a website. We can audit a site; we cannot audit a
// Facebook page, and pretending otherwise produces a report the owner knows is wrong on sight.
const NOT_A_WEBSITE = [
  [/(^|\.)google\.[a-z.]+$/i, 'that is a Google Maps or Google listing link'],
  [/(^|\.)g\.page$/i, 'that is a Google listing link'],
  [/(^|\.)facebook\.com$/i, 'that is a Facebook page'],
  [/(^|\.)instagram\.com$/i, 'that is an Instagram profile'],
  [/(^|\.)linkedin\.com$/i, 'that is a LinkedIn page'],
  [/(^|\.)(twitter\.com|x\.com)$/i, 'that is an X profile'],
  [/(^|\.)tiktok\.com$/i, 'that is a TikTok profile'],
  [/(^|\.)yelp\.[a-z.]+$/i, 'that is a Yelp listing'],
  [/(^|\.)nextdoor\.com$/i, 'that is a Nextdoor page'],
  [/(^|\.)openheartmediaco\.com$/i, 'that is our website, not yours'],
];

function looksLikeTracker(u) {
  try {
    const url = new URL(u);
    return TRACKER_PATTERNS.some(re => re.test(url.hostname) || re.test(url.pathname));
  } catch { return false; }
}

// Returns { url } when it is scannable, or { error } with something the lead can act on.
async function resolveSiteUrl(raw) {
  let u = normalizeUrl(raw);
  if (!u) return { error: 'That does not look like a web address. Enter it like yourbusiness.com' };

  // A tracking link is recoverable: it is a redirect, so follow it and audit where it lands.
  if (looksLikeTracker(u)) {
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'user-agent': AUDIT_UA } });
      if (r.url && !looksLikeTracker(r.url)) u = r.url;
      else return { error: 'That is a link from an email, not a website. Enter your own web address, like yourbusiness.com' };
    } catch {
      return { error: 'That is a link from an email, not a website. Enter your own web address, like yourbusiness.com' };
    }
  }

  let host;
  try { host = new URL(u).hostname.replace(/^www\./i, ''); }
  catch { return { error: 'That does not look like a web address. Enter it like yourbusiness.com' }; }

  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { error: 'That is not a public web address. Enter it like yourbusiness.com' };
  }
  if (PLACEHOLDER_DOMAINS.has(host)) {
    return { error: 'That looks like a placeholder address. Enter your real web address, like yourbusiness.com' };
  }
  for (const [re, why] of NOT_A_WEBSITE) {
    if (re.test(host)) return { error: `We can only audit a website, and ${why}. Enter your own web address, like yourbusiness.com` };
  }
  return { url: u };
}

async function scanWebsite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const out = {
    url, reachable: false, https: url.startsWith('https'), redirectsToHttps: false, finalUrl: null,
    // content / SEO
    title: null, titleLen: 0, description: null, descriptionLen: 0, h1Count: 0, wordCount: 0,
    mobileViewport: false, favicon: false, ogTitle: false, ogImage: false, schemaLocalBusiness: false, faqSchema: false, sameAs: false, canonical: false,
    // conversion
    hasPhone: false, phoneVisible: false, hasEmailLink: false, hasForm: false, hasBooking: false, hasNewsletter: false,
    hasLiveChat: false, hasCta: false, napAddress: false, napVisible: false, napInSchema: false,
    // tracking / data
    analytics: false, analyticsType: null, fbPixel: false, googleAdsTag: false,
    // media / trust
    imgCount: 0, imgMissingAlt: 0, hasVideo: false, mixedContent: false, copyrightYear: null,
    // social
    socials: {}, deadSocials: {},
    // crawl coverage + AI search readiness
    pagesScanned: [], host: null, robotsFound: false, aiCrawlersAllowed: null, aiCrawlersBlocked: [], llmsTxt: false,
  };
  if (!url) return out;

  let home = await fetchPage(url, 13000);
  if (!home.html) { out.error = home.error || 'unreachable'; return out; }
  // Sanity check: real content with zero images AND zero H1 tags is an unusual combination that
  // usually means the fetch caught the site mid-deploy, rate-limited, or otherwise degraded rather
  // than a genuinely empty page. Retry once before trusting a result like that as ground truth.
  const looksIncomplete = h => {
    const imgs = (h.match(/<img[\s>]/gi) || []).length;
    const h1s = (h.match(/<h1[\s>]/gi) || []).length;
    const textLen = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    return imgs === 0 && h1s === 0 && textLen > 1500;
  };
  if (looksIncomplete(home.html)) {
    await new Promise(r => setTimeout(r, 1500));
    const retry = await fetchPage(url, 13000);
    if (retry.html && !looksIncomplete(retry.html)) home = retry;
  }
  out.reachable = home.ok;
  out.finalUrl = home.finalUrl;
  out.https = (home.finalUrl || url).startsWith('https');
  out.redirectsToHttps = out.https;
  let origin = null;
  try { const u = new URL(out.finalUrl || url); origin = u.origin; out.host = u.host.replace(/^www\./, ''); } catch {}
  const html = home.html;
  // Same trap as the 900KB body truncation, one level down. Page builders front-load a megabyte of
  // inline script and CSS before the real metadata: on our own Wix site </head> sits at offset
  // ~1.05M, so a fixed 220KB window missed the canonical tag and every Open Graph tag and reported
  // them as missing on a site that has them. Use the document's real head when it gives us one.
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 1500000);

  // ----- homepage-only SEO signals -----
  out.title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() || null;
  out.titleLen = out.title ? out.title.length : 0;
  out.description = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1] || null;
  out.descriptionLen = out.description ? out.description.length : 0;
  out.mobileViewport = /<meta[^>]+name=["']viewport["']/i.test(head);
  out.favicon = /<link[^>]+rel=["'][^"']*icon/i.test(head);
  out.ogTitle = /<meta[^>]+property=["']og:title["']/i.test(head);
  out.ogImage = /<meta[^>]+property=["']og:image["']/i.test(head);
  out.canonical = /<link[^>]+rel=["']canonical["']/i.test(head);
  out.h1Count = (html.match(/<h1[\s>]/gi) || []).length;

  // ----- tracking / data (homepage) -----
  if (/googletagmanager\.com\/gtm|GTM-[A-Z0-9]{4,}/i.test(html)) { out.analytics = true; out.analyticsType = 'Google Tag Manager'; }
  else if (/gtag\s*\(|googletagmanager\.com\/gtag|["']G-[A-Z0-9]{6,}["']/i.test(html)) { out.analytics = true; out.analyticsType = 'Google Analytics 4'; }
  else if (/google-analytics\.com\/analytics|ga\(\s*['"]create|UA-\d{4,}-\d/i.test(html)) { out.analytics = true; out.analyticsType = 'Universal Analytics (legacy)'; }
  else if (/plausible\.io|matomo|piwik|fathom|clarity\.ms|hotjar|cloudflareinsights|simpleanalyticscdn|umami|posthog|mixpanel|heapanalytics|segment\.com\/analytics|stats\.wp\.com|wp-statistics/i.test(html)) { out.analytics = true; out.analyticsType = 'Other analytics'; }
  out.fbPixel = /connect\.facebook\.net\/[^"']*fbevents|fbq\(\s*['"]init/i.test(html);
  out.googleAdsTag = /AW-\d{6,}|googleadservices\.com\/pagead\/conversion|google_conversion_id/i.test(html);

  // ----- media / trust (homepage) -----
  const imgs = html.match(/<img[^>]*>/gi) || [];
  out.imgCount = imgs.length;
  // alt="" is the correct markup for a decorative image, not a defect. The old test
  // required one or more characters inside the quotes, so every properly marked
  // decorative image was counted as a fault. On our own site that reported "6 of 8
  // images have no alt text" when all eight had the attribute and none were wrong.
  // Count only images with no alt attribute at all.
  out.imgMissingAlt = imgs.filter(t => !/\salt\s*=/i.test(t)).length;
  out.imgDecorative = imgs.filter(t => /\salt\s*=\s*["']\s*["']/i.test(t)).length;
  out.hasVideo = /(<video[\s>]|youtube\.com\/embed|player\.vimeo\.com|wistia|\.mp4["']|<iframe[^>]+(youtube|vimeo))/i.test(html);
  out.mixedContent = out.https && /(src|href)=["']http:\/\/(?!localhost|127\.)/i.test(html);
  out.copyrightYear = (html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i) || [])[1] || null;

  // ----- merge conversion + trust signals across homepage AND key inner pages -----
  const merge = (h) => {
    const s = pageSignals(h);
    out.hasForm ||= s.hasForm; out.hasBooking ||= s.hasBooking; out.hasNewsletter ||= s.hasNewsletter;
    out.hasLiveChat ||= s.hasLiveChat; out.hasCta ||= s.hasCta; out.hasPhone ||= s.hasPhone;
    out.phoneVisible ||= s.phoneVisible;
    out.hasEmailLink ||= s.hasEmailLink; out.napAddress ||= s.napAddress;
    out.schemaLocalBusiness ||= s.schemaLocalBusiness; out.faqSchema ||= s.faqSchema; out.sameAs ||= s.sameAs;
    Object.assign(out.socials, extractSocials(h));
    Object.assign(out.deadSocials, extractDeadSocials(h));
    return s;
  };
  const homeSig = merge(html);
  out.wordCount = homeSig.text ? homeSig.text.split(' ').length : 0;
  out.pagesScanned.push('/');

  if (origin && out.host) {
    // discover up to 4 key internal pages (contact / about / services / booking) on the same host
    // Match on the LINK TEXT as well as the URL, and keep a fallback.
    // The old version tested keywords against the URL only, against a short list. A real
    // site crawled on Sep 18 had /our-story, /recipes, /shop, /rum-and-reason and
    // /responsibility-and-legal. Not one matched, so the scanner never left the homepage
    // and then reported no phone, no address, no form and no CTA for a business that
    // publishes all four. Absence of a crawl is not absence of the thing.
    const anchors = [...html.matchAll(/<a[^>]+href=["']([^"'#\s]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)]
      .map(m => ({ href: m[1], label: stripText(m[2] || '') }));
    const want = /(contact|about|service|book|appointment|quote|schedule|team|staff|location|hour|review|testimonial|faq|pricing|price|rate|gallery|portfolio|menu|shop|store|product|work|project|story|who-we-are|get-in-touch|reach|visit|our-)/i;
    const skip = /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mov|doc|xls)$|^(mailto:|tel:|javascript:)|\/(cart|checkout|account|login|signin|register|privacy|terms|legal|sitemap)(\/|$)/i;
    const seen = new Set([out.finalUrl]);
    const targets = [], spare = [];
    for (const a of anchors) {
      let abs; try { abs = new URL(a.href, out.finalUrl).href.split('#')[0]; } catch { continue; }
      try { if (new URL(abs).host.replace(/^www\./, '') !== out.host) continue; } catch { continue; }
      if (seen.has(abs) || skip.test(abs) || skip.test(a.href)) continue;
      seen.add(abs);
      if (want.test(abs) || want.test(a.label)) { if (targets.length < 8) targets.push(abs); }
      else if (spare.length < 8) spare.push(abs);
    }
    // Never stay stuck on the homepage. If nothing matched the vocabulary, walk the first
    // few internal pages anyway, because a site we did not read is not a site with nothing on it.
    while (targets.length < 5 && spare.length) targets.push(spare.shift());
    const pages = await Promise.all(targets.map(u => fetchPage(u, 9000)));
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].ok && pages[i].html) {
        const s2 = merge(pages[i].html);
        out.wordCount += s2.text ? s2.text.split(' ').length : 0;
        out.fbPixel ||= /connect\.facebook\.net\/[^"']*fbevents|fbq\(\s*['"]init/i.test(pages[i].html);
        out.pagesScanned.push(targets[i].replace(origin, '') || '/');
      }
    }

    // ----- AI-search readiness: robots.txt AI-crawler policy + llms.txt -----
    try {
      const rob = await fetchPage(origin + '/robots.txt', 7000);
      if (rob.ok && /user-agent/i.test(rob.html)) {
        out.robotsFound = true;
        out.aiCrawlersBlocked = aiCrawlerBlocks(rob.html);
        out.aiCrawlersAllowed = out.aiCrawlersBlocked.length === 0;
      } else { out.aiCrawlersAllowed = true; }
    } catch { out.aiCrawlersAllowed = null; }
    try { const l = await fetchPage(origin + '/llms.txt', 5000); out.llmsTxt = l.ok && l.html.trim().length > 20; } catch {}
  }
  return out;
}

// Google's PageSpeed API is highly inconsistent in latency: if it doesn't already have a cached
// Lighthouse result for a URL, it runs a live Chrome audit that can take 20-60s or time out
// entirely; once run once, a follow-up call for the same URL often hits cache and returns in
// under a second. Confirmed directly: one call to the same URL timed out at 25s, the very next
// call completed in 602ms. A single timeout value can't fix that, so runPageSpeed retries once
// on a timeout/failure before giving up, since the second attempt has a real shot at hitting cache.
// Measured across live prospect sites, Lighthouse answers anywhere between 17s and 62s for the
// same set, so this is a long tail rather than a fixed cost. 70s clipped that tail and lost the
// speed data on about a third of runs. PageSpeed runs in parallel with everything else, so a
// higher ceiling costs the slow minority some wall clock and costs the fast majority nothing.
// Lighthouse needs 60-120s on a heavy page builder site (our own homepage makes 266 requests and
// takes 8.7s to paint), and 95s was cutting it off often enough that most audits of sites like
// ours had no speed data at all. The whole job budget is 6 minutes and PageSpeed is kicked off
// before everything else, so waiting longer costs nothing on fast sites.
const PAGESPEED_TIMEOUT_MS = Number(process.env.PAGESPEED_TIMEOUT_MS) || 150000;

// Vendor endpoints are matched narrowly and deliberately: an early version matched the substring
// "arc" and hit a Wix bundle URL, reporting live chat on a site that had none. A false pass is
// worse than a miss here, because the prospect knows their own site.
function renderedSignals(audits) {
  const reqs = (audits?.['network-requests']?.details?.items || []).map(i => String(i.url || ''));
  if (!reqs.length) return null;
  const seen = re => reqs.some(u => re.test(u));
  return {
    ga4: seen(/googletagmanager\.com\/gtag\/js|google-analytics\.com|\/g\/collect\?/i),
    gtm: seen(/googletagmanager\.com\/gtm\.js/i),
    metaPixel: seen(/connect\.facebook\.net\/[a-z_]+\/fbevents\.js|facebook\.com\/tr[\/?]/i),
    googleAds: seen(/googleadservices\.com|googleads\.g\.doubleclick\.net|gtag\/js\?id=AW-/i),
    // leadconnectorhq/msgsndr is GoHighLevel, which is what a lot of agency-built local sites run
    // their chat widget on. It was missing here, so our own site reported "no live chat" with the
    // widget sitting in the corner of the page.
    chat: seen(/tawk\.to|intercom(cdn|\.io)|js\.driftt\.com|client\.crisp\.chat|code\.tidio\.co|livechatinc\.com|js\.hs-scripts\.com|podium\.com|olark\.com|birdeye\.com|leadconnectorhq\.com|msgsndr\.com|zdassets\.com|smooch\.io|gorgias\.chat|front\.com\/chat|chatway|jivosite|zalo|manychat/i),
    video: seen(/youtube\.com\/embed|youtube-nocookie\.com|player\.vimeo\.com|fast\.wistia|videodelivery\.net/i),
    requests: reqs.length,
  };
}

// Rendered evidence may only ever turn a signal ON. It proves a tag is present; it can never be
// used to prove one is absent, because Lighthouse sees a single page load and consent gating can
// legitimately defer a tag.
function mergeRenderedSignals(scan, ps) {
  const r = ps && ps.rendered;
  if (!r || !scan) return scan;
  if (r.ga4 || r.gtm) {
    scan.analytics = true;
    scan.analyticsType = scan.analyticsType || (r.ga4 ? 'Google Analytics 4' : 'Google Tag Manager');
  }
  if (r.metaPixel) scan.fbPixel = true;
  if (r.googleAds) scan.googleAdsTag = true;
  if (r.chat) scan.hasLiveChat = true;
  if (r.video) scan.hasVideo = true;
  return scan;
}

async function runPageSpeed(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const attempt = async () => {
    const key = process.env.PAGESPEED_KEY ? `&key=${process.env.PAGESPEED_KEY}` : '';
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices${key}`;
    const r = await fetch(api, { signal: AbortSignal.timeout(PAGESPEED_TIMEOUT_MS) });
    // A non-OK response used to return null indistinguishably from a parse miss, so a quota or
    // outage looked identical to a site with no data and neither was ever logged. Surface it.
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const err = new Error(`PageSpeed HTTP ${r.status} ${body.slice(0, 160)}`);
      err.status = r.status;
      throw err;
    }
    const d = await r.json();
    const c = d.lighthouseResult?.categories || {};
    const a = d.lighthouseResult?.audits || {};
    const s = x => x?.score != null ? Math.round(x.score * 100) : null;
    const num = k => a[k]?.numericValue != null ? a[k].numericValue : null;
    const passed = k => a[k]?.score != null ? a[k].score >= 0.9 : null;
    // Core Web Vitals + key timings (numericValue in ms, except CLS unitless)
    return {
      performance: s(c.performance), seo: s(c.seo), accessibility: s(c.accessibility), bestPractices: s(c['best-practices']),
      lcp: num('largest-contentful-paint'), cls: num('cumulative-layout-shift'), tbt: num('total-blocking-time'),
      fcp: num('first-contentful-paint'), si: num('speed-index'),
      lcpLabel: a['largest-contentful-paint']?.displayValue || null,
      clsLabel: a['cumulative-layout-shift']?.displayValue || null,
      tbtLabel: a['total-blocking-time']?.displayValue || null,
      // Lighthouse renders the page in real Chrome, so these fix false negatives on JS-rendered sites.
      renderedTitle: passed('document-title'),
      renderedMetaDesc: passed('meta-description'),
      renderedViewport: passed('viewport'),
      isCrawlable: passed('is-crawlable'),
      httpStatusOk: passed('http-status-code'),
      // Every request real Chrome actually made. Raw HTML cannot see a tag that a site builder,
      // tag manager or consent tool injects at runtime, and Wix/Squarespace/GTM sites inject all
      // of them, so an HTML-only scan reported live analytics and pixels as missing. A network
      // request to the vendor is direct proof the tag fired.
      rendered: renderedSignals(a),
    };
  };
  // Retrying a timeout is pointless: the first attempt already consumed the stage budget, so the
  // retry is guaranteed to be killed before it lands. Only genuinely transient server-side answers
  // are worth a second call, and only quickly.
  const retryable = e => e?.status === 429 || (e?.status >= 500 && e?.status <= 599);
  try {
    return await attempt();
  } catch (e) {
    if (!retryable(e)) {
      console.warn('[audit] PageSpeed unavailable for', url, '-', e.message);
      return null;
    }
    try {
      await new Promise(r => setTimeout(r, 1500));
      return await attempt();
    } catch (e2) {
      console.warn('[audit] PageSpeed failed twice for', url, '-', e2.message);
      return null;
    }
  }
}

// ---------- Google Business Profile scan (Places API) ----------
async function scanGBP(business, city, siteHost) {
  const key = process.env.PLACES_KEY || process.env.GOOGLE_API_KEY || process.env.PAGESPEED_KEY;
  if (!key || !business) return null;
  try {
    // One transient failure or an over-specific query used to leave the whole Local Visibility
    // category unmeasured, so the lookup tries the query two ways before giving up.
    let pid = null, lastStatus = null;
    for (const text of [`${business} ${city || ''} GA`, `${business} ${city || ''}`]) {
      const q = encodeURIComponent(text.replace(/\s+/g, ' ').trim());
      for (let attempt = 0; attempt < 2 && !pid; attempt++) {
        try {
          const find = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${key}`, { signal: AbortSignal.timeout(10000) });
          const fd = await find.json();
          lastStatus = fd.status || null;
          pid = fd.candidates?.[0]?.place_id || null;
          if (fd.status && !['OK', 'ZERO_RESULTS'].includes(fd.status)) await new Promise(r => setTimeout(r, 800));
          else break;
        } catch (e) { lastStatus = e.message; }
      }
      if (pid) break;
    }
    if (!pid) console.warn('[gbp] no profile for', business, '-', lastStatus);
    // No candidate is a lookup miss, not proof the business is absent from Google. Scoring it as
    // "not found" put a 0 and the words "not on Google" in front of owners who have a profile.
    // null means unmeasured everywhere downstream, so the category is left out instead.
    if (!pid) return null;
    const fields = 'name,rating,user_ratings_total,opening_hours,website,formatted_phone_number,formatted_address,business_status,types,url,photos,reviews,editorial_summary';
    const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=${fields}&key=${key}`, { signal: AbortSignal.timeout(10000) });
    const dd = await det.json();
    const r = dd.result || {};
    // Verify the match: does the profile's linked website match the site we scanned, or the name align?
    let verified = null, matchHost = null;
    if (r.website) { try { matchHost = new URL(r.website).host.replace(/^www\./, ''); } catch {} }
    const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hostOk = siteHost && matchHost ? matchHost === siteHost.replace(/^www\./, '') : null;
    const nameOk = r.name && business ? (() => { const a = norm(r.name), b = norm(business); return !!a && !!b && (a.includes(b) || b.includes(a)); })() : null;
    // Either signal is enough to trust the match. Both failing means Google handed back a
    // different business, and its rating, review count and hours would be reported as theirs.
    if (hostOk === true || nameOk === true) verified = true;
    else if (hostOk === false || nameOk === false) verified = false;
    if (verified === false) return null;
    let latestReviewDays = null;
    if (Array.isArray(r.reviews) && r.reviews.length) {
      const newest = Math.max(...r.reviews.map(rv => rv.time || 0));
      if (newest) latestReviewDays = Math.round((Date.now() / 1000 - newest) / 86400);
    }
    const cats = (r.types || []).filter(t => !['point_of_interest', 'establishment', 'store'].includes(t));
    return {
      found: true, name: r.name || null, rating: r.rating ?? null, reviews: r.user_ratings_total ?? null,
      hasHours: !!r.opening_hours, websiteOnGbp: !!r.website, phoneOnGbp: !!r.formatted_phone_number,
      photos: Array.isArray(r.photos) ? r.photos.length : 0, categories: cats, primaryCategory: cats[0] || null,
      status: r.business_status || null,
      // editorial_summary is Google's OWN curated blurb, not the owner-written "from the business"
      // description, and Google returns it for almost no local listing. Reading it as "description
      // filled in" reported a FAIL on profiles that are fully filled in, including our own. We
      // cannot see that field at all, so we say so instead of guessing.
      hasDescription: r.editorial_summary?.overview ? true : null,
      latestReviewDays,
      // Place Details returns at most 5 reviews chosen by relevance, not recency. On a profile with
      // more reviews than that, the newest one we can see says nothing about the newest one there
      // is, so review recency is only trustworthy when we can see the whole set.
      reviewSample: Array.isArray(r.reviews) ? r.reviews.length : 0,
      reviewRecencyReliable: Array.isArray(r.reviews) && r.reviews.length > 0
        && (r.user_ratings_total == null || r.user_ratings_total <= r.reviews.length),
      verified, matchHost,
    };
  } catch (e) { return null; }
}

// ---------- AI Search Presence (AIO) audit ----------
// Combines deterministic AI-readiness signals from the crawl with a live check of what AI models actually know.
async function scanAIO(business, city, category, scan) {
  if (scan.limited) {
    // Nothing on-page can be judged, but whether AI models recognise the business is independent
    // of whether their firewall let us in, and it is usually the most interesting finding anyway.
    const visibility = await aiVisibilityProbe(business, city, category);
    return { ready: null, visibility, probed: !!visibility, score: null, limited: true };
  }
  const ready = {
    aiCrawlersAllowed: scan.aiCrawlersAllowed !== false,
    aiCrawlersBlocked: scan.aiCrawlersBlocked || [],
    schema: !!scan.schemaLocalBusiness,
    faqSchema: !!scan.faqSchema,
    sameAs: !!scan.sameAs,
    contentDepth: (scan.wordCount || 0) >= 600,
    napClear: !!scan.napAddress,
    llmsTxt: !!scan.llmsTxt,
  };
  // Live visibility probe: reflects what AI assistants actually know from training. An honest signal
  // of AI-search presence for a local business (usually "not known yet" = the real opportunity).
  const visibility = await aiVisibilityProbe(business, city, category);
  let score = 0, max = 85;
  score += ready.aiCrawlersAllowed ? 22 : 0;
  score += ready.schema ? 20 : 0;
  score += ready.sameAs ? 10 : 0;
  score += ready.faqSchema ? 10 : 0;
  score += ready.contentDepth ? 10 : 0;
  score += ready.napClear ? 8 : 0;
  score += ready.llmsTxt ? 5 : 0;
  // The live probe carries 15 of the 100 points. When it could not run those points were
  // unearnable, so a perfectly healthy site was capped at 85 for a reason that had nothing to do
  // with the business. Score against what we were actually able to measure.
  if (visibility) { max = 100; score += visibility.known ? 10 : 0; score += visibility.wouldRecommend ? 5 : 0; }
  return { ready, visibility, probed: !!visibility, score: Math.min(100, Math.round((score / max) * 100)) };
}

// Build a full pass/fail checklist from the scan so the audit shows everything we looked at.
function buildChecklist(scan, ps, gbp, aio) {
  const socials = Object.keys(scan.socials || {});
  const deadList = Object.keys(scan.deadSocials || {}).filter(k => !socials.includes(k === 'twitter' ? 'x' : k));
  // With the crawl refused, every raw-HTML signal is absent because we never saw the HTML, not
  // because the site lacks it. Same rule as everywhere else: unmeasured reports as unmeasured.
  const lim = !!scan.limited;
  const L = v => (lim ? null : v);
  const LN = note => (lim ? 'not checked, the site refused our scanner' : note);
  // A page whose raw HTML carries almost no text is a JavaScript shell: the markup we
  // read is a loader, and the real content arrives after execution. Our fetcher does not
  // execute anything. Calling a form, a phone link or an address "missing" on that
  // evidence is a guess presented as a finding, which is exactly the complaint that
  // started this. Same tri-state rule the tracking tags already use: true when we saw
  // it, false only when we genuinely read a real page and it was not there, null when
  // we could not honestly look.
  const jsShell = !lim && scan.reachable === true && (scan.wordCount || 0) < 60;
  const C = v => (lim ? null : (v ? true : (jsShell ? null : false)));
  const CN = note => lim ? 'not checked, the site refused our scanner'
    : jsShell ? 'could not verify, this page builds its content with JavaScript'
    : note;
  // Rendered-DOM fallbacks: if the raw HTML missed it but Lighthouse (real Chrome) saw it, trust
  // Lighthouse. Tri-state on purpose. Lighthouse returns a null score for an audit it did not run,
  // and azerplumb.com came back with exactly that for viewport, which the old boolean collapsed
  // into a failure and reported as "mobile viewport is not configured" on a site that is fine.
  // False only when we genuinely read the page and the thing was not there.
  const sawIt = (raw, rendered) => raw === true ? true
    : rendered === true ? true
    : rendered === false ? false
    : (!lim && scan.reachable === true) ? false
    : null;
  const hasTitle = sawIt(!!scan.title, ps?.renderedTitle);
  const hasMetaDesc = sawIt(!!scan.description, ps?.renderedMetaDesc);
  const hasViewport = sawIt(scan.mobileViewport === true, ps?.renderedViewport);
  const aioGroup = aio && aio.limited ? { group: 'AI Search Presence (AIO)', items: [
    ...(aio.visibility ? [
      { label: 'AI assistants recognize your business', ok: !!aio.visibility.known, note: aio.visibility.known ? (aio.visibility.confidence || '') + ' confidence' : 'not recognized' },
      { label: 'AI would recommend you in your category', ok: !!aio.visibility.wouldRecommend },
    ] : []),
    { label: 'On-page AI readiness (schema, entity links, crawler access)', ok: null, note: 'not checked, the site refused our scanner' },
  ]} : aio ? { group: 'AI Search Presence (AIO)', items: [
    { label: 'AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot)', ok: aio.ready.aiCrawlersAllowed, note: aio.ready.aiCrawlersBlocked.length ? 'blocking ' + aio.ready.aiCrawlersBlocked.join(', ') : 'open' },
    { label: 'Structured data so AI can read your business', ok: aio.ready.schema },
    { label: 'Entity links (sameAs) connecting your profiles', ok: aio.ready.sameAs },
    { label: 'FAQ / Q&A content AI can quote', ok: aio.ready.faqSchema },
    { label: 'Enough page depth for AI to summarize you', ok: aio.ready.contentDepth, note: (scan.wordCount || 0) + ' words' },
    { label: 'llms.txt guidance file for AI models', ok: aio.ready.llmsTxt },
    ...(aio.visibility ? [
      { label: 'AI assistants recognize your business', ok: !!aio.visibility.known, note: aio.visibility.known ? (aio.visibility.confidence || '') + ' confidence' : 'not recognized' },
      { label: 'AI would recommend you in your category', ok: !!aio.visibility.wouldRecommend },
    ] : []),
  ]} : null;
  // Absence of evidence is not evidence of absence. Runtime-injected tags are invisible to a raw
  // HTML scan, so without Lighthouse's rendered view we cannot honestly call a tag missing.
  const canVerifyTags = !!(ps && ps.rendered) && !lim;
  const tagOk = v => v ? true : (canVerifyTags ? false : null);
  const tagNote = v => v ? '' : (canVerifyTags ? '' : 'could not verify on this run');
  const gbpGroup = gbp && gbp.found ? { group: 'Google Business Profile', items: [
    { label: 'Business profile found on Google', ok: true, note: gbp.verified === false ? 'match unverified' : '' },
    { label: 'Strong star rating (4.5+)', ok: gbp.rating != null ? gbp.rating >= 4.5 : null, note: gbp.rating != null ? gbp.rating + '/5' : '' },
    { label: 'Healthy review count (50+)', ok: gbp.reviews != null ? gbp.reviews >= 50 : null, note: gbp.reviews != null ? gbp.reviews + ' reviews' : '' },
    // The newest review Google shows us is a lower bound, not the whole truth. Seeing a recent one
    // PROVES recency. Seeing only old ones does not prove the opposite, because Google returns five
    // reviews chosen by relevance rather than by date. So a recent sighting passes outright, and an
    // old one reports the real number it found without asserting nothing newer exists. Marking the
    // whole check n/a threw away a fact that is usually true and worth raising.
    { label: 'Getting recent reviews (last 60 days)',
      ok: gbp.latestReviewDays == null ? null
          : gbp.latestReviewDays <= 60 ? true
          : gbp.reviewRecencyReliable === false ? null
          : false,
      note: gbp.latestReviewDays == null ? ''
            : gbp.latestReviewDays <= 60 ? gbp.latestReviewDays + ' days ago'
            : gbp.reviewRecencyReliable === false
              ? 'newest of the ' + gbp.reviewSample + ' reviews Google exposes is ' + gbp.latestReviewDays + ' days old, out of ' + gbp.reviews + ' total'
              : gbp.latestReviewDays + ' days ago' },
    { label: 'Business hours listed', ok: gbp.hasHours },
    { label: 'Website linked on profile', ok: gbp.websiteOnGbp },
    { label: 'Phone number on profile', ok: gbp.phoneOnGbp },
    { label: 'Photos on profile', ok: gbp.photos >= 5, note: gbp.photos ? gbp.photos + (gbp.photos >= 10 ? '+' : '') + ' photos' : 'none' },
    { label: 'Business description filled in', ok: gbp.hasDescription, note: gbp.hasDescription === null ? 'not exposed by Google\'s API, check the profile directly' : '' },
  ]} : (gbp && gbp.found === false ? { group: 'Google Business Profile', items: [
    { label: 'Business profile found on Google', ok: false, note: 'not found' },
  ]} : null);
  return [
    { group: 'Foundation & Speed', items: [
      { label: 'Secure HTTPS connection', ok: scan.https },
      { label: 'Mobile friendly (responsive viewport)', ok: hasViewport, note: hasViewport === null ? 'not checked' : '' },
      { label: 'Mobile page speed', ok: ps?.performance != null ? ps.performance >= 50 : null, note: ps?.performance != null ? ps.performance + '/100' : 'n/a' },
      { label: 'Largest Contentful Paint under 2.5s', ok: ps?.lcp != null ? ps.lcp <= 2500 : null, note: ps?.lcpLabel || '' },
      { label: 'Layout stable while loading (CLS)', ok: ps?.cls != null ? ps.cls <= 0.1 : null, note: ps?.clsLabel || '' },
      { label: 'No insecure mixed content', ok: L(!scan.mixedContent), note: LN('') },
    ]},
    { group: 'Getting Found (SEO)', items: [
      { label: 'Page title present and sized right', ok: scan.title ? (scan.titleLen >= 15 && scan.titleLen <= 65) : hasTitle, note: scan.title ? scan.titleLen + ' chars' : (hasTitle === true ? 'present, seen in the rendered page' : hasTitle === null ? 'not checked' : 'missing') },
      { label: 'Meta description present and sized right', ok: scan.description ? (scan.descriptionLen >= 70 && scan.descriptionLen <= 165) : hasMetaDesc, note: scan.description ? scan.descriptionLen + ' chars' : (hasMetaDesc === true ? 'present, seen in the rendered page' : hasMetaDesc === null ? 'not checked' : 'missing') },
      { label: 'Single clear H1 headline', ok: L(scan.h1Count === 1), note: LN(scan.h1Count + ' found') },
      { label: 'Local business schema markup', ok: C(scan.schemaLocalBusiness), note: CN('') },
      { label: 'Canonical tag set', ok: L(scan.canonical), note: LN('') },
      { label: 'Enough content on the page', ok: L(scan.wordCount >= 300), note: LN(scan.wordCount + ' words') },
    ]},
    ...(gbpGroup ? [gbpGroup] : []),
    ...(aioGroup ? [aioGroup] : []),
    { group: 'Turning Visitors Into Leads', items: [
      { label: 'Click to call phone number', ok: C(scan.hasPhone), note: scan.hasPhone ? '' : (scan.phoneVisible ? 'a phone number is shown but it is not a tappable tel: link' : CN('')) },
      { label: 'Lead capture form', ok: C(scan.hasForm), note: CN('') },
      { label: 'Online booking / scheduling', ok: C(scan.hasBooking), note: CN('') },
      { label: 'Clear call to action', ok: C(scan.hasCta), note: CN('') },
      { label: 'Live chat', ok: tagOk(scan.hasLiveChat), note: tagNote(scan.hasLiveChat) },
      { label: 'Email / newsletter capture', ok: C(scan.hasNewsletter), note: CN('') },
      { label: 'Address listed (local trust)', ok: C(scan.napAddress), note: CN('') },
    ]},
    { group: 'Tracking & Ad Readiness', items: [
      { label: 'Website analytics installed', ok: tagOk(scan.analytics), note: scan.analytics ? (scan.analyticsType || '') : tagNote(scan.analytics) },
      { label: 'Facebook / Meta pixel (retargeting)', ok: tagOk(scan.fbPixel), note: tagNote(scan.fbPixel) },
      { label: 'Google Ads conversion tag', ok: tagOk(scan.googleAdsTag), note: tagNote(scan.googleAdsTag) },
    ]},
    { group: 'Content, Media & Social', items: [
      { label: 'Video on site', ok: C(scan.hasVideo), note: CN('') },
      { label: 'Images have alt text', ok: lim ? null : (scan.imgCount ? scan.imgMissingAlt === 0 : null), note: LN(scan.imgCount ? (scan.imgCount - scan.imgMissingAlt) + '/' + scan.imgCount : 'none') },
      { label: 'Social share preview (Open Graph)', ok: L(scan.ogTitle && scan.ogImage), note: LN('') },
      { label: 'Facebook linked', ok: C(socials.includes('facebook')), note: CN('') },
      { label: 'Instagram linked', ok: C(socials.includes('instagram')), note: CN('') },
      { label: 'YouTube linked', ok: C(socials.includes('youtube')), note: CN('') },
      { label: 'TikTok linked', ok: L(socials.includes('tiktok')), note: LN('') },
      // Only ever false: an icon with no working link. Null (unmeasured) otherwise.
      { label: 'Social icons link to real profiles', ok: deadList.length ? false : null, note: deadList.join(', ') },
    ]},
  ];
}

async function generateAuditReport(p, scan, ps, gbp, answers, aio) {
  const checklist = buildChecklist(scan, ps, gbp, aio);
  // The report is read by the business owner, who knows their own site. Telling them a pixel is
  // missing when it is live, or that their Google description is empty when it is filled in, loses
  // the deal on the spot. Anything we could not actually measure is named here so the model treats
  // it as unknown instead of turning a blind spot into a finding.
  const unverifiable = [];
  const caveated = [];
  if (scan.limited) {
    unverifiable.push('EVERYTHING ON THE PAGE ITSELF. Their server refused our scanner, so we never received the HTML. We have Google Lighthouse\'s rendered measurements and their Google Business Profile, and nothing else. Do not comment on their content, contact options, forms, booking, tracking tags, social links, schema or headings in any way, and do not imply any of them are missing. Say once, plainly, that a firewall on their hosting blocked our scanner so this report covers speed, Google visibility and AI presence only, and note that the block itself is worth checking since it can also affect how search engines reach the site.');
  }
  if (!ps) unverifiable.push('page load speed, Core Web Vitals, and anything about how fast or slow the site is');
  if (!ps || !ps.rendered) unverifiable.push('analytics, Meta pixel, Google Ads tag and live chat (these are injected after page load and cannot be seen without a rendered page load)');
  if (gbp && gbp.found && gbp.hasDescription === null) unverifiable.push('whether the Google Business Profile description is filled in (Google does not expose it)');
  if (gbp && gbp.found && !gbp.primaryCategory) unverifiable.push('the Google Business Profile primary category (Google did not return one)');
  if (gbp && gbp.found && gbp.reviewRecencyReliable === false && gbp.latestReviewDays != null && gbp.latestReviewDays > 60) {
    // Not a blind spot, a bounded one. The model may use the real number as long as it says where
    // the number came from and does not claim to know nothing newer exists.
    caveated.push(`the newest of the ${gbp.reviewSample} reviews Google exposes is ${gbp.latestReviewDays} days old, out of ${gbp.reviews} total. You may raise review freshness using exactly that framing ("the most recent review Google shows us is ${gbp.latestReviewDays} days old"), but never state or imply they have received no reviews since, because Google returns reviews by relevance and may be hiding newer ones`);
  }
  const flat = checklist.flatMap(g => g.items.map(i => `${i.ok === true ? 'PASS' : i.ok === false ? 'FAIL' : 'n/a'} - ${g.group}: ${i.label}${i.note ? ' (' + i.note + ')' : ''}`)).join('\n');
  const prompt = `You are a senior growth strategist at Open Heart Media (OHM). Produce a thorough, elite growth audit for a local business based ONLY on the real scan data below. It must read like a paid consultant did it: specific, researched, and honest. Tie findings to lost leads and revenue. This report is what earns the discovery call, so it must be genuinely valuable and impressively detailed, while keeping the exact HOW of fixing things at a strategic level (name the gap and the opportunity, do not write the full implementation playbook).

BUSINESS: ${p.business || 'this business'}, a ${p.category || 'local business'} in ${p.city || 'their area'}, GA. Google rating ${p.rating || 'n/a'} from ${p.reviews || 'n/a'} reviews.
${answers.firstName
  ? `PERSON WHO REQUESTED THIS AUDIT: ${answers.firstName}. Address them by their first name ONCE, warmly and naturally, in the summary (for example open the summary with "${answers.firstName}, ..."). Do not overuse the name or use it in the findings.`
  : `NOBODY REQUESTED THIS AUDIT: it was built ahead of contact, so there is no name to use. Do NOT open with a greeting of any kind and do NOT write "Hey there", "Hi there" or "there". Open the summary on the business itself.`}
WHAT THEY WANT MORE OF: ${answers.goal || 'more customers'}  (weave this in naturally where relevant. NEVER write the phrases "stated goal", "stated business goal", or "your stated goal". Just refer to what they want in plain words.)

FULL TECHNICAL + MARKETING SCAN (real, just run):
GOOGLE PAGESPEED (mobile): ${ps ? JSON.stringify({ performance: ps.performance, seo: ps.seo, accessibility: ps.accessibility, bestPractices: ps.bestPractices, LCP: ps.lcpLabel, CLS: ps.clsLabel, TBT: ps.tbtLabel }) : 'NOT MEASURED on this run. You do NOT have a speed number for this site. Do not state one, do not estimate one, and do not imply the site is fast or slow.'}
SITE SIGNALS: ${JSON.stringify({ reachable: scan.reachable, https: scan.https, mobileViewport: scan.mobileViewport, title: scan.title, titleLen: scan.titleLen, metaDescription: scan.description ? 'present (' + scan.descriptionLen + ' chars)' : 'MISSING', h1Count: scan.h1Count, wordCount: scan.wordCount, schemaLocalBusiness: scan.schemaLocalBusiness, canonical: scan.canonical, hasPhone: scan.hasPhone, hasForm: scan.hasForm, hasBooking: scan.hasBooking, hasCta: scan.hasCta, hasLiveChat: scan.hasLiveChat, hasNewsletter: scan.hasNewsletter, napAddress: scan.napAddress, addressVisibleOnPage: scan.napVisible, addressInStructuredDataOnly: !!(scan.napInSchema && !scan.napVisible), analytics: scan.analyticsType || false, facebookPixel: scan.fbPixel, googleAdsTag: scan.googleAdsTag, hasVideo: scan.hasVideo, images: scan.imgCount, imagesMissingAlt: scan.imgMissingAlt, ogShareTags: scan.ogTitle && scan.ogImage, mixedContent: scan.mixedContent })}
GOOGLE BUSINESS PROFILE (live from Google Places): ${gbp && gbp.found ? JSON.stringify({ rating: gbp.rating, reviews: gbp.reviews, latestReviewDaysAgo: gbp.latestReviewDays, hoursListed: gbp.hasHours, websiteLinked: gbp.websiteOnGbp, phoneListed: gbp.phoneOnGbp, photos: gbp.photos, descriptionFilled: gbp.hasDescription, primaryCategory: gbp.primaryCategory, status: gbp.status }) : (gbp && gbp.found === false ? 'NO GOOGLE BUSINESS PROFILE FOUND (major local visibility gap)' : 'not checked')}
SOCIAL PROFILES LINKED FROM SITE: ${Object.keys(scan.socials).length ? Object.keys(scan.socials).join(', ') : 'NONE detected'}
PAGES ACTUALLY SCANNED (not just homepage): ${(scan.pagesScanned || ['/']).join(', ')}  (conversion, contact, and trust signals were merged across all of these pages, so if a signal is FAIL it is genuinely missing site-wide, not just off the homepage)
AI SEARCH PRESENCE (AIO): ${aio ? JSON.stringify({ score: aio.score, onPageReadiness: aio.ready ? undefined : 'NOT CHECKED, their server refused our scanner', aiCrawlersAllowed: aio.ready?.aiCrawlersAllowed, aiCrawlersBlocked: aio.ready?.aiCrawlersBlocked, structuredData: aio.ready?.schema, faqSchema: aio.ready?.faqSchema, entityLinks_sameAs: aio.ready?.sameAs, llmsTxt: aio.ready?.llmsTxt, contentDepthOk: aio.ready?.contentDepth, aiKnowsThisBusiness: aio.visibility ? aio.visibility.known : 'not tested', aiWouldRecommend: aio.visibility ? aio.visibility.wouldRecommend : 'not tested', whatAiKnows: aio.visibility ? aio.visibility.whatAiKnows : null, aiKnowsCompetitors: aio.visibility ? aio.visibility.competitorsKnown : null }) : 'not checked'}

PASS/FAIL CHECKLIST (already computed, use it to ground your scores):
${flat}

COULD NOT BE VERIFIED ON THIS RUN: ${unverifiable.length ? unverifiable.join('; ') : 'nothing, every signal above was measured'}
${caveated.length ? 'PARTIALLY MEASURED, USE ONLY AS DESCRIBED: ' + caveated.join('; ') : ''}
Treat everything on that line as UNKNOWN. Never present an unverified item as a failure, a gap, or something they are missing, and never score a category down for it. Any checklist item marked "n/a" was not measured either: do not describe an n/a item as missing, broken or absent. If an unverified item matters to the story, say plainly that it was not measured on this run. Being wrong about something the owner can see for themselves destroys the credibility of the whole report, so when in doubt, leave it out.

Score each of the seven categories 0-100 HONESTLY from the data (a site failing many checks should score low, do not inflate). Base "Local Visibility" mostly on the LIVE Google Business Profile data above (rating, review count and recency versus a typical ${p.category} in ${p.city}, whether hours/website/photos/description are filled, and whether a profile exists at all) plus on-site schema and address. Base "Tracking & Data" on analytics, pixel, and ads tag. For "Social & Content", focus on PRESENCE and OPTIMIZATION, not follower counts (we do not have those): which platforms they are and are not on, whether they have video, and the opportunity to optimize their profiles (complete bios, consistent branding and handles, a clear link in bio, regular posting, and short video content for a ${p.category}). For "AI Search Presence (AIO)", base the score on the AIO data above: whether AI crawlers are blocked (a hard cap on the score if they are), whether structured data and sameAs entity links exist, content depth, and the LIVE probe of whether AI models actually recognize this business. If AI does not know them yet, that is a real and urgent gap, not a minor one. The site title, meta description, and mobile viewport were cross-checked against Google's real rendered Chrome result, so treat those signals as accurate even for JavaScript-heavy sites. Every "why" must cite specific real findings.

Return ONLY JSON:
{
 "headline": "one specific line, e.g. 'Where ${p.business || 'your business'} is quietly losing customers'",
 "overallVerdict": "one honest sentence summarizing the state of their online presence",
 "categories": [
   {"name": "Website & Speed", "score": <0-100>, "why": ${ps
     ? '"2 sentences citing the real PageSpeed number, HTTPS, mobile, Core Web Vitals"'
     : '"2 sentences on HTTPS, mobile viewport and mixed content ONLY. Speed was not measured on this run, so say plainly that load speed could not be measured this time and score this category from the secure-connection and mobile-friendly checks alone. Never cite or estimate a speed number, a load time or a Core Web Vital."'}},
   {"name": "Getting Found (SEO)", "score": <0-100>, "why": "2 sentences citing title/meta/schema/H1/content findings"},
   {"name": "Converting Visitors", "score": <0-100>, "why": "2 sentences citing phone, form, booking, CTA, chat findings"},
   {"name": "Local Visibility", "score": <0-100>, "why": "2 to 3 sentences citing the LIVE Google Business Profile data: rating and review count and recency vs a typical ${p.category} in ${p.city}, and whether hours, website, photos, and description are filled in on the profile"},
   {"name": "Tracking & Data", "score": <0-100>, "why": "2 sentences on analytics, Meta pixel, Google Ads tag, and what not tracking costs them"},
   {"name": "Social & Content", "score": <0-100>, "why": "2 to 3 sentences on which platforms they are and are not on, video presence, and the specific opportunity to optimize their profiles (bios, consistent branding, link in bio, posting cadence) for a ${p.category}. Do not mention follower counts."},
   {"name": "AI Search Presence (AIO)", "score": <0-100>, "why": "2 to 3 sentences on whether AI assistants (ChatGPT, Google AI Overviews, Perplexity) can find and recommend them: cite whether AI crawlers are allowed, whether structured data and entity links exist for AI to read, and whether AI models recognise this business by name yet (we tested what a leading model knows, so refer to "AI assistants" or "AI models" generally and never claim we ran a live query against ChatGPT, Perplexity or Google AI Overviews). Frame not-being-known as the single biggest emerging visibility gap: buyers increasingly ask AI for recommendations, and if the AI has never heard of them, they are invisible in that channel while competitors may not be."}
 ],
 "findings": [ {"title": "punchy specific title", "detail": "2 to 3 sentences tied to lost leads or revenue, referencing the actual scan finding", "impact": "High|Medium|Low"} ],
 "quickWins": ["3 to 4 short fixes they could do fast, each one line, specific to what failed"],
 "summary": "2 to 3 sentences, direct and honest, that make working with OHM the obvious next step without giving away the full playbook",
 "estimate": ""
}
Give 5 to 7 findings ordered by biggest revenue impact. No em dashes. No hype words like leverage, unlock, synergy, supercharge. Specific to THIS scan, never generic.`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  let txt = ((r.content || []).find(b => b && b.type === 'text')?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = txt.match(/\{[\s\S]*\}/); if (m) txt = m[0];
  const report = JSON.parse(txt);
  // Enforce the no-em-dash rule: strip em/en dashes and "--" substitutes the model sometimes emits.
  const deDash = s => typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ').replace(/\s+--\s+/g, ', ').replace(/--/g, ', ') : s;
  const scrub = o => Array.isArray(o) ? o.map(scrub) : (o && typeof o === 'object' ? (Object.keys(o).forEach(k => o[k] = scrub(o[k])), o) : deDash(o));
  scrub(report);
  report.checklist = checklist;
  report.pagespeed = ps || null;
  // Lets the canary, the dashboard and the PDF tell a fully measured audit apart from one that is
  // missing a real input. Without it a partial audit is indistinguishable from a complete one.
  report.speedMeasured = !!ps;
  report.limited = !!scan.limited;
  // Mark it on the category itself so the overall score can leave it out rather than average in a
  // number nobody measured.
  if (!ps) {
    const speedCat = (report.categories || []).find(c => /speed/i.test(c.name || ''));
    if (speedCat) speedCat.measured = false;
  }
  return report;
}

// overall growth score = average of the six category scores
function overallScore(report) {
  // A category we could not measure is excluded rather than averaged in. Including an unmeasured
  // "Website & Speed" pulled the headline number toward whatever the blind spot happened to be.
  const cats = (report.categories || []).filter(c => c.measured !== false);
  if (!cats.length) return 0;
  return Math.round(cats.reduce((s, c) => s + (Number(c.score) || 0), 0) / cats.length);
}

// ---------- Branded PDF audit report (thorough, multi-page) ----------
function buildAuditPDF(business, report, bookingUrl) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = 612, H = 792, M = 48, CW = W - M * 2;
    const NAVY = '#0f1a30', NAVY2 = '#16233d', RED = '#df3131', INK = '#12203a', BODY = '#57607a', MUT = '#8a97ad', LINE = '#e7e4dc';
    const GREEN = '#2fae5f', AMBER = '#e0a340';
    const scoreColor = v => v >= 70 ? GREEN : v >= 45 ? AMBER : RED;
    let y = 0;
    const foot = () => {
      doc.fillColor(MUT).font('Helvetica').fontSize(8).text('Open Heart Media  ·  Georgia  ·  openheartmediaco.com', M, H - 34, { width: CW, align: 'center', lineBreak: false });
    };
    const nl = need => { if (y + need > H - 56) { doc.addPage(); y = 56; } };
    const sectionLabel = t => { doc.fillColor(RED).font('Helvetica-Bold').fontSize(10.5).text(t.toUpperCase(), M, y, { characterSpacing: 1.5 }); y = doc.y + 12; };

    // ---- header band ----
    doc.rect(0, 0, W, 122).fill(NAVY);
    try { doc.image(path.join(__dirname, 'public', 'media', 'logo-white.png'), M, 36, { height: 30 }); } catch (e) {}
    doc.rect(M, 74, 34, 3).fill(RED);
    doc.fillColor('#c1cde3').font('Helvetica-Bold').fontSize(10).text('GROWTH AUDIT', M, 86, { characterSpacing: 2 });
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text(business || 'Your business', M, 99, { width: CW - 120 });
    doc.fillColor('#8ea0c0').font('Helvetica').fontSize(9).text(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), M, 99, { width: CW, align: 'right' });

    // ---- headline + overall ----
    y = 150;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(19).text(report.headline || 'Where your business is quietly losing customers', M, y, { width: CW, lineGap: 1 });
    y = doc.y + 14;
    const overall = overallScore(report);
    const verdict = report.overallVerdict || (overall >= 70 ? 'Solid foundation with real room to grow.' : overall >= 45 ? 'A working presence that is leaving real money on the table.' : 'Big, fixable gaps are costing you leads right now.');
    // Box grows to fit the verdict text so long summaries never overflow the box.
    const vTop = 46, vW = CW - 196;
    const vH = doc.font('Helvetica').fontSize(10.5).heightOfString(verdict, { width: vW });
    const boxH = Math.max(92, vTop + vH + 18);
    doc.roundedRect(M, y, CW, boxH, 12).fill(NAVY);
    doc.fillColor(scoreColor(overall)).font('Helvetica-Bold').fontSize(50).text(String(overall), M + 26, y + 20, { continued: true }).fillColor('#9fb0cf').fontSize(18).text(' /100');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text('Overall growth score', M + 170, y + 24);
    doc.fillColor('#c1cde3').font('Helvetica').fontSize(10.5).text(verdict, M + 170, y + vTop, { width: vW });
    y += boxH + 20;

    // ---- category breakdown ----
    sectionLabel('Score breakdown by area');
    (report.categories || []).forEach(c => {
      const why = c.why || '';
      const whyH = doc.font('Helvetica').fontSize(10).heightOfString(why, { width: CW - 82 });
      const rowH = Math.max(52, whyH + 26);
      nl(rowH + 10);
      doc.roundedRect(M, y, 62, 50, 8).fill('#f5f3ee');
      doc.fillColor(scoreColor(Number(c.score))).font('Helvetica-Bold').fontSize(23).text(String(c.score), M, y + 9, { width: 62, align: 'center' });
      doc.fillColor(MUT).font('Helvetica').fontSize(7.5).text('/ 100', M, y + 34, { width: 62, align: 'center' });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12.5).text(c.name, M + 78, y + 1, { width: CW - 82 });
      doc.fillColor(BODY).font('Helvetica').fontSize(10).text(why, M + 78, doc.y + 2, { width: CW - 82, lineGap: 1 });
      y = Math.max(y + 50, doc.y) + 14;
    });

    // ---- Core Web Vitals / real metrics ----
    const ps = report.pagespeed;
    if (ps) {
      nl(120);
      y += 4;
      sectionLabel('Google performance metrics (mobile)');
      const chips = [
        ['Performance', ps.performance != null ? ps.performance + '/100' : 'n/a', ps.performance],
        ['SEO', ps.seo != null ? ps.seo + '/100' : 'n/a', ps.seo],
        ['Accessibility', ps.accessibility != null ? ps.accessibility + '/100' : 'n/a', ps.accessibility],
        ['Best practices', ps.bestPractices != null ? ps.bestPractices + '/100' : 'n/a', ps.bestPractices],
        ['Load (LCP)', ps.lcpLabel || 'n/a', ps.lcp != null ? (ps.lcp <= 2500 ? 80 : 30) : null],
        ['Stability (CLS)', ps.clsLabel || 'n/a', ps.cls != null ? (ps.cls <= 0.1 ? 80 : 30) : null],
      ];
      const cwv = (CW - 10 * 2) / 3;
      chips.forEach((c, i) => {
        const col = i % 3, row = Math.floor(i / 3);
        const cx = M + col * (cwv + 10), cy = y + row * 60;
        doc.roundedRect(cx, cy, cwv, 50, 8).fill('#f5f3ee');
        doc.fillColor(c[2] == null ? MUT : scoreColor(c[2])).font('Helvetica-Bold').fontSize(17).text(String(c[1]), cx + 12, cy + 10, { width: cwv - 24 });
        doc.fillColor(BODY).font('Helvetica').fontSize(8.5).text(c[0], cx + 12, cy + 32, { width: cwv - 24 });
      });
      y += 60 * Math.ceil(chips.length / 3) + 10;
    }

    // ---- full scanned checklist (the rundown) ----
    nl(60);
    y += 2;
    sectionLabel('Everything we scanned');
    doc.fillColor(BODY).font('Helvetica').fontSize(9.5).text('A live check of your site across the signals that drive local growth. Green passed, red is an opportunity.', M, y, { width: CW });
    y = doc.y + 12;
    const mark = (x, cy, ok) => {
      if (ok === true) { doc.lineWidth(1.6).strokeColor(GREEN).moveTo(x, cy + 1).lineTo(x + 3, cy + 4).lineTo(x + 8, cy - 3).stroke(); }
      else if (ok === false) { doc.lineWidth(1.6).strokeColor(RED).moveTo(x, cy - 3).lineTo(x + 8, cy + 4).moveTo(x + 8, cy - 3).lineTo(x, cy + 4).stroke(); }
      else { doc.lineWidth(1.6).strokeColor(MUT).moveTo(x, cy + 1).lineTo(x + 8, cy + 1).stroke(); }
    };
    (report.checklist || []).forEach(group => {
      nl(40);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(group.group, M, y);
      y = doc.y + 6;
      group.items.forEach(it => {
        nl(20);
        mark(M + 1, y + 6, it.ok);
        doc.fillColor(INK).font('Helvetica').fontSize(10).text(it.label, M + 18, y, { width: CW - 120, lineBreak: false });
        if (it.note) doc.fillColor(MUT).font('Helvetica').fontSize(9).text(String(it.note), M, y + 1, { width: CW, align: 'right', lineBreak: false });
        y += 17;
      });
      y += 8;
    });

    // ---- findings ----
    nl(50);
    y += 4;
    sectionLabel('What is costing you leads');
    (report.findings || []).forEach((f, i) => {
      const bodyX = M + 30, bodyW = CW - 30;         // text column, left of the number circle
      const titleW = f.impact ? bodyW - 74 : bodyW;  // reserve room for the pill on the title line
      const titleH = doc.font('Helvetica-Bold').fontSize(12.5).heightOfString(f.title, { width: titleW });
      const detailH = doc.font('Helvetica').fontSize(10).heightOfString(f.detail || '', { width: bodyW });
      nl(Math.max(titleH, 16) + detailH + 22);
      const impactC = f.impact === 'High' ? RED : f.impact === 'Medium' ? AMBER : MUT;
      doc.circle(M + 9, y + 8, 9).fill(NAVY);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text(String(i + 1), M, y + 4, { width: 18, align: 'center' });
      // impact pill, top right
      if (f.impact) { doc.roundedRect(W - M - 68, y - 1, 68, 15, 7).fill(impactC); doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7).text(f.impact.toUpperCase() + ' IMPACT', W - M - 68, y + 3, { width: 68, align: 'center', lineBreak: false }); }
      // title (kept clear of the pill)
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12.5).text(f.title, bodyX, y, { width: titleW });
      // detail always starts below both the title and the pill
      const detailY = Math.max(doc.y, y + 16) + 5;
      doc.fillColor(BODY).font('Helvetica').fontSize(10).text(f.detail, bodyX, detailY, { width: bodyW, lineGap: 1 });
      y = doc.y + 16;
    });

    // ---- quick wins ----
    if (report.quickWins && report.quickWins.length) {
      nl(50 + report.quickWins.length * 18);
      y += 4;
      sectionLabel('Quick wins you can start now');
      report.quickWins.forEach(q => {
        nl(20);
        doc.circle(M + 4, y + 6, 2).fill(RED);
        doc.fillColor(BODY).font('Helvetica').fontSize(10.5).text(q, M + 16, y, { width: CW - 16 });
        y = doc.y + 8;
      });
    }

    // ---- upside + CTA ----
    nl(150);
    y += 8;
    // The 'upside' revenue box was removed 2026-10-18: it was an invented dollar projection.
    // The heading and summary are variable height, and the button was positioned from doc.y after
    // they were already drawn, so on a long summary the button landed on top of the page footer.
    // Measure the whole block first and break the page before drawing any of it.
    const ctaHead = 'Want us to help you close these gaps?';
    const ctaBody = report.summary || 'Thirty minutes to walk through what this scan turned up and what is actually costing you customers. Then we build your gameplan. No pitch, no pressure.';
    const headH = doc.font('Helvetica-Bold').fontSize(14).heightOfString(ctaHead, { width: CW });
    const bodyH = doc.font('Helvetica').fontSize(10.5).heightOfString(ctaBody, { width: CW, lineGap: 1 });
    nl(headH + 5 + bodyH + 12 + 40 + 12);   // + button height + breathing room above the footer
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(ctaHead, M, y);
    doc.fillColor(BODY).font('Helvetica').fontSize(10.5).text(ctaBody, M, doc.y + 5, { width: CW, lineGap: 1 });
    y = doc.y + 12;
    doc.roundedRect(M, y, 250, 40, 9).fill(RED);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12.5).text('Book your free discovery call', M, y + 14, { width: 250, align: 'center', link: bookingUrl, underline: false });
    doc.fillColor(MUT).font('Helvetica').fontSize(9.5).text('30 minutes. No pitch, no pressure.', M + 262, y + 15, { width: CW - 262, link: bookingUrl });

    // footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); foot(); }
    doc.end();
  });
}

// ---------- ONE living landing page (the funnel) + metrics ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const CALENDLY = process.env.CALENDLY_URL || 'https://calendly.com/michelle-openheartmediaco/discovery-call-with-open-heart-media';
// Editable page content (video + case studies) — edit app/data/site.json, no code changes needed.
const SITE_FILE = path.join(__dirname, 'data', 'site.json');
function loadSite() {
  const defaults = {
    videoEmbed: process.env.HYPE_VIDEO_EMBED || '',
    cases: [
      // Fallback only, used if data/site.json is unreadable. Kept identical to site.json and to
      // the website so a missing file can never put invented proof points on the page.
      { stat: '$2.34M', label: 'tracked revenue on $26K in ad spend, home services' },
      { stat: '$896,551', label: 'in a single 110 day season. 2,198 orders at a $408 average, e-commerce' },
      { stat: '$4M to $6M', label: 'projected 2026 revenue, up from 2025. Care hours up 30.4% in July and 23.1% in August, home care' },
    ],
  };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')) }; } catch { return defaults; }
}

const METRICS = path.join(DATA_DIR, 'metrics.json');
function loadMetrics() { try { return JSON.parse(fs.readFileSync(METRICS, 'utf8')); } catch { return []; } }
function saveMetrics() { fs.writeFileSync(METRICS, JSON.stringify(events, null, 2)); }
let events = loadMetrics();

// What a cold prospect sees the moment they click the link in their email. Their report already
// exists, so there is nothing to request, nothing to wait for and no form: showing one here would
// ask them to apply for something we already made. The whole page is the finding, then the call.
// Short report: only checks the scanner actually measured, in plain words, with no model-written
// prose. Anything unmeasured is left off the page instead of shown as a failure. The long
// report still exists and still renders when a record has no checklist.
function renderSnapshot(p) {
  const rep = p.audit_report || {};
  const items = {};
  (rep.checklist || []).forEach(g => (g.items || []).forEach(i => { items[i.label] = i; }));
  const scope = 'on the pages we checked';
  const specs = [
    { label: 'Mobile page speed', pass: n => `Loads fast on phones (${n}/100 on Google's speed test)`,
      fail: n => `Slow to load on phones (${n}/100 on Google's speed test)`, fix: 'Speed up the site on phones' },
    { label: 'Click to call phone number', pass: () => 'Tap-to-call phone number',
      fail: () => `No tap-to-call phone number found ${scope}`, fix: 'Add a tap-to-call phone number' },
    { label: 'Lead capture form', pass: () => 'Contact form so visitors can reach you',
      fail: () => `No contact form found ${scope}`, fix: 'Add a simple contact form' },
    { label: 'Online booking / scheduling', pass: () => 'Online booking',
      fail: () => `No online booking found ${scope}`, fix: 'Let customers book online', passOnly: true },
    { label: 'Secure HTTPS connection', pass: () => 'Secure connection (HTTPS)',
      fail: () => 'Site is not on a secure connection', fix: 'Move the site to a secure connection' },
    { label: 'Mobile friendly (responsive viewport)', pass: () => 'Set up for phone screens',
      fail: () => 'Not set up for phone screens', fix: 'Make the layout phone friendly' },
    { label: 'Website analytics installed', pass: () => 'Visitor analytics installed',
      fail: () => `No visitor analytics found ${scope}`, fix: 'Install analytics to see where customers come from', passOnly: true },
    { label: 'Local business schema markup', pass: () => 'Local business markup, so Google knows who and where you are',
      fail: () => `No local business markup ${scope}, so Google gets less detail on who and where you are`, fix: 'Add local business markup' },
    { label: 'Page title present and sized right', pass: () => 'Search listing title set',
      fail: () => 'Search listing title is missing or the wrong length', fix: 'Fix the search listing title' },
    { label: 'Meta description present and sized right', pass: () => 'Search listing description set',
      fail: () => 'Search listing description is missing or the wrong length', fix: 'Fix the search listing description' },
    { label: 'Single clear H1 headline', pass: () => 'One clear main headline per page',
      fail: () => 'Some pages we checked have more than one main headline, which blurs what each page is about', fix: 'Give each page one clear headline' },
    { label: 'AI assistants recognize your business', pass: () => 'AI assistants recognized the business when we asked',
      fail: () => 'AI assistants did not recognize the business when we asked', fix: 'Get the business recognized by AI assistants' },
    { label: 'Video on site', pass: () => 'Video on the site',
      fail: () => `No video found ${scope}`, fix: 'Add video to the site' },
  ];
  const num = it => { const m = String((it && it.note) || '').match(/(\d+)\s*\/\s*100/); return m ? m[1] : ''; };
  const good = [], bad = [];
  for (const sp of specs) {
    const it = items[sp.label];
    if (!it || (it.ok !== true && it.ok !== false)) continue;       // unmeasured: say nothing
    // Absence of booking or video cannot be proven from static HTML: stores, embeds and widgets
    // load them after the page renders. Those only ever show as a pass.
    if (!it.ok && sp.passOnly) continue;
    if (!it.ok && sp.label === 'Single clear H1 headline') {
      // Zero and several are different problems; "more than one" printed for a page with none
      // is simply false.
      const c = Number((String(it.note || '').match(/(\d+)\s*found/) || [])[1]);
      if (c === 0) { bad.push({ text: 'No main headline (H1) found on the home page, which tells Google less about what the page is about', fix: 'Add one clear main headline to each page' }); continue; }
      if (!(c > 1)) continue;                                   // count unknown: say nothing
    }
    (it.ok ? good : bad).push({ text: (it.ok ? sp.pass : sp.fail)(num(it)), fix: sp.fix });
  }
  // Social is one check built from two measured links, so one missing profile is not a failure.
  const fbIt = items['Facebook linked'], igIt = items['Instagram linked'];
  const socials = [fbIt, igIt].filter(i => i && (i.ok === true || i.ok === false));
  if (socials.length === 2) {
    // Pass only. Icons with an empty or script-set link look present to the owner while the
    // scanner finds no profile URL, so a "not linked" claim is not safe to print.
    if (socials.some(i => i.ok === true)) good.push({ text: 'Social profiles linked from the site', fix: '' });
  }
  const dead = items['Social icons link to real profiles'];
  if (dead && dead.ok === false && dead.note) {
    const names = dead.note.split(', ').map(x => ({ youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' }[x] || x.charAt(0).toUpperCase() + x.slice(1))).join(', ');
    bad.push({ text: `The social icons on the site (${names}) are there but do not link to anything`, fix: 'Link the social icons to your real profiles' });
  }
  const measured = good.length + bad.length;
  const when = p.prescan_at ? new Date(p.prescan_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const lead = bad.length ? bad[0].fix : 'Your basics are in good shape';
  const headline = bad.length
    ? `We checked the website for ${esc(p.business || 'your business')} and found ${bad.length === 1 ? 'one thing' : bad.length + ' things'} worth fixing`
    : `${esc(p.business || 'Your')} website passed every check we ran`;
  const li = (arr, cls, mark) => arr.map(x => `<li class="${cls}"><span class="snap-mark">${mark}</span>${esc(x.text)}</li>`).join('');
  return `
<style>
.snap{padding:76px 32px 40px}.snap .inner{max-width:760px}
.snap h1{font-size:clamp(26px,3.6vw,40px);font-weight:900;line-height:1.15;letter-spacing:-.015em;margin:0 0 14px}
.snap .sub{color:#cfd6e4;font-size:18px;line-height:1.55;max-width:56ch}
.snap-score{display:flex;align-items:baseline;gap:12px;margin:34px 0 8px}
.snap-score b{font-size:64px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.snap-score span{color:#98a3ba;font-size:17px;font-weight:600}
.snap-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}
@media(max-width:640px){.snap{padding:56px 20px 30px}.snap-grid{grid-template-columns:1fr}}
.snap-col{background:#182640;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:22px}
.snap-col h2{font-size:12px;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;margin:0 0 14px}
.snap-col ul{list-style:none;margin:0;padding:0}
.snap-col li{display:flex;gap:10px;font-size:15px;line-height:1.45;margin-bottom:12px;color:#e6ebf5}
.snap-mark{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#0f1a30}
.snap-col.ok h2{color:#3fbf6a}.snap-col.ok .snap-mark{background:#3fbf6a}
.snap-col.no h2{color:#ff7b7b}.snap-col.no .snap-mark{background:#ff7b7b}
.snap-note{color:#8fa0bd;font-size:13px;line-height:1.5;margin-top:22px;max-width:62ch}
</style>
<section class="snap">
  <div class="inner">
    <div class="eyebrow">Website check &middot; ${esc(p.business || 'your business')}</div>
    <h1>${headline}</h1>
    <p class="sub">${bad.length ? 'Here is what is working, and what we would fix first.' : 'Nice work. If you want to go further, we are happy to talk about what comes next.'}</p>
    ${measured ? `<div class="snap-score"><b>${good.length}/${measured}</b><span>checks passing</span></div>` : ''}
    <div class="snap-grid">
      ${good.length ? `<div class="snap-col ok"><h2>Working well</h2><ul>${li(good, 'g', '&#10003;')}</ul></div>` : ''}
      ${bad.length ? `<div class="snap-col no"><h2>Worth fixing${bad.length > 1 ? ', in order' : ''}</h2><ul>${li(bad, 'b', '!')}</ul></div>` : ''}
    </div>
    <a class="btn" id="rbook" href="#book" style="max-width:360px;margin:34px 0 0;text-decoration:none;display:block;text-align:center">${bad.length ? 'Talk through the fixes (free discovery call)' : 'Book a free call'}</a>
    <p class="snap-note">Based on an automated scan of ${esc(p.website ? p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : 'your public website')}${when ? ' on ' + when : ''}. Anything we could not measure is left out, speed scores can shift a little between tests, and some things, like tags that load late, are not always detectable.</p>
  </div>
</section>`;
}

function renderPrescannedReport(p) {
  if (process.env.SNAPSHOT_OFF !== '1' && Array.isArray((p.audit_report || {}).checklist) && p.audit_report.checklist.length) return renderSnapshot(p);
  const rep = p.audit_report || {};
  const cats = rep.categories || [];
  const overall = cats.length
    ? Math.round(cats.reduce((s, c) => s + (Number(c.score) || 0), 0) / cats.length)
    : 0;
  const col = v => v >= 70 ? '#3fbf6a' : v >= 45 ? '#e0a340' : '#df3131';
  const cls = v => v >= 70 ? 'sc-good' : v >= 45 ? 'sc-mid' : 'sc-bad';
  const verdict = rep.overallVerdict
    || (overall >= 70 ? 'Solid foundation, real room to grow'
      : overall >= 45 ? 'Leaving real money on the table'
        : 'Big, fixable gaps costing you leads');

  const scards = cats.map(c => `<div class="scard ${cls(Number(c.score))}"><b>${Number(c.score)}<span class="of">/100</span></b><span>${esc(c.name)}</span><div class="meter"><i style="width:${Math.max(6, Math.round(Number(c.score)))}%"></i></div></div>`).join('');
  const breakdown = cats.map(c => `<div class="find"><div class="n" style="background:${col(Number(c.score))}">${Number(c.score)}</div><div><h3>${esc(c.name)} <span style="color:#8fa0bd;font-weight:600;font-size:14px">${Number(c.score)}/100</span></h3><p>${esc(c.why || '')}</p></div></div>`).join('');
  const findings = (rep.findings || []).map((f, i) => {
    const ic = f.impact === 'High' ? '#df3131' : f.impact === 'Medium' ? '#e0a340' : '#8fa0bd';
    return `<div class="find"><div class="n">${i + 1}</div><div><h3>${esc(f.title)}${f.impact ? ` <span style="font-size:11px;font-weight:700;color:#fff;background:${ic};padding:2px 7px;border-radius:20px;vertical-align:middle">${esc(String(f.impact).toUpperCase())}</span>` : ''}</h3><p>${esc(f.detail || '')}</p></div></div>`;
  }).join('');
  const quick = (rep.quickWins || []).map(q => `<li style="margin-bottom:8px;color:#c7d0e0">${esc(q)}</li>`).join('');
  const top = (rep.findings || [])[0];

  return `
<section class="hero report">
  <div class="inner">
    <div class="eyebrow reveal">Growth audit &middot; ${esc(p.business || 'your business')}</div>
    <h1 class="reveal">${esc(rep.headline || 'Where you are quietly losing customers')}</h1>
    ${top ? `<p class="sub reveal">${esc(top.detail || '')}</p>` : ''}
    <a class="btn reveal" id="rbook_top" href="#book" style="max-width:320px;margin-top:10px;text-decoration:none;display:block;text-align:center">Book my free discovery call</a>
    <p class="fp reveal" style="margin-top:10px">Thirty minutes. No pitch, no pressure.</p>
  </div>
</section>

<section class="sec results">
  <div class="inner">
    <div class="grade reveal"><div class="gbig">${overall}<span>/100</span></div><div class="glabel"><b>Overall growth score</b><span>${esc(verdict)}</span></div></div>
    <div class="scoregrid reveal">${scards}</div>
    <div class="fhead reveal">Score breakdown</div>${breakdown}
    <div class="fhead reveal" style="margin-top:26px">What is costing you customers</div>${findings}
    ${quick ? `<div class="fhead reveal" style="margin-top:22px">Quick wins you can start now</div><ul style="margin:8px 0 0;padding-left:20px">${quick}</ul>` : ''}
    <a class="btn" id="rbook" href="#book" style="max-width:360px;margin:30px auto 0;text-decoration:none;display:block;text-align:center">Book my free discovery call</a>
  </div>
</section>`;
}

function renderLandingPage(ref, token) {
  const found = ref && prospects.find(x => x.id === ref);
  // Sequential ids: without a valid signature this still named the business and prefilled its
  // website, which leaks the prospect list itself even when the findings stay hidden.
  const prospect = found && reportTokenValid(found.id, token) ? found : null;
  const bizName = prospect ? prospect.business : null;
  const prefillSite = prospect ? (prospect.website || '') : '';
  // A lead we already scanned skips the whole request flow and lands straight on their findings.
  const prescanned = !!(prospect && prospect.audit_report && (prospect.prescan_at || prospect.audited_at)
    && reportTokenValid(prospect.id, token));
  const site = loadSite();
  const video = site.videoEmbed
    ? `<div class="vframe"><iframe src="${site.videoEmbed}" frameborder="0" allowfullscreen></iframe></div>`
    : `<div class="vframe"><video src="/media/ohm-promo.mp4" autoplay muted loop playsinline controls preload="metadata"></video></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${prescanned ? esc(bizName || 'Your') + ' website check · Open Heart Media' : 'Free growth audit · Open Heart Media'}</title>
${META_PIXEL_ID ? `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;
s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${META_PIXEL_ID}');fbq('track','PageView');
</script>` : ''}
${GA4_ID ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA4_ID}');</script>` : ''}
${prescanned ? `<meta name="robots" content="noindex,nofollow,noarchive"/>
<meta name="referrer" content="no-referrer"/>` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<noscript><style>.reveal{opacity:1 !important;transform:none !important}</style></noscript>
<style>
:root{--ink:#0f1a30;--ink2:#0b1424;--navy:#1a2b4c;--red:#df3131;--blue:#5e97ff;--cream:#fcfaf5;--soft:#98a3ba;--line:rgba(255,255,255,.1);--lineL:#eceae3}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:Inter,-apple-system,sans-serif;color:#fff;background:var(--ink);-webkit-font-smoothing:antialiased;line-height:1.5}
.nav{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:16px 32px;background:rgba(15,26,48,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.logo{height:30px;display:block}
.navcta{font-size:14px;font-weight:600;color:#fff;text-decoration:none;background:var(--red);padding:9px 18px;border-radius:8px;transition:transform .2s,filter .2s}.navcta:hover{filter:brightness(1.1);transform:translateY(-1px)}
.sec{padding:96px 32px}.inner{max-width:960px;margin:0 auto}
.eyebrow{color:var(--red);font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:12px;margin-bottom:18px}
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1)}
.reveal.in{opacity:1;transform:none}
@media(prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}}
/* hero */
.hero{padding:120px 32px 90px;background:radial-gradient(1200px 500px at 70% -10%,rgba(94,151,255,.14),transparent 60%),var(--ink)}
.hero h1{font-size:clamp(38px,6.4vw,72px);font-weight:900;letter-spacing:-.02em;line-height:1.02;max-width:15ch}
.hero h1 em{font-style:normal;color:var(--red)}
/* The audit headline is a whole sentence about their business, so it needs a smaller size and
   a much wider measure than the marketing hero it shares markup with. */
.hero.report h1{font-size:clamp(27px,3.5vw,44px);line-height:1.14;max-width:24ch;letter-spacing:-.015em}
.hero.report .sub{max-width:62ch}
.hero.report{padding:76px 32px 56px}
.hero p.sub{font-size:clamp(17px,2.2vw,21px);color:#cfcfcf;max-width:56ch;margin:26px 0 0;line-height:1.55}
.trust{display:flex;gap:26px;flex-wrap:wrap;margin-top:40px;color:var(--soft);font-size:14px;font-weight:500}
.trust b{color:#fff;font-weight:800;font-size:22px;display:block;font-variant-numeric:tabular-nums}
/* audit form */
.formwrap{margin-top:52px;background:linear-gradient(180deg,#22314f,#182640);border:1px solid var(--line);border-radius:20px;padding:32px;max-width:560px;box-shadow:0 30px 80px -30px rgba(0,0,0,.7)}
.formwrap h2{font-size:24px;font-weight:800;letter-spacing:-.01em}
.formwrap .fp{color:var(--soft);font-size:14px;margin:6px 0 18px}
label{display:block;font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--soft);margin:16px 0 7px}
input,select{width:100%;padding:14px 15px;border:1px solid #33466b;border-radius:11px;font:inherit;font-size:15px;background:#122039;color:#fff;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(94,151,255,.2)}
input::placeholder{color:#6b6b6b}
.frow{display:flex;gap:12px}.frow>div{flex:1;min-width:0}.frow label{margin-top:16px}
input.invalid{border-color:var(--red);box-shadow:0 0 0 3px rgba(223,49,49,.18)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--red);color:#fff;font-weight:700;font-size:16px;padding:16px 30px;border-radius:12px;border:0;cursor:pointer;width:100%;margin-top:22px;transition:transform .15s,filter .2s;font-family:inherit}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px)}.btn:active{transform:scale(.99)}.btn:disabled{opacity:.6;cursor:default;transform:none}
.err{color:#ff8a8a;font-size:13px;margin-top:10px;min-height:16px}
/* results */
.results{background:#0d1729;color:#fff}
.results .ctitle{color:#fff !important}
.results .scard{background:#16233d;border-color:rgba(255,255,255,.09)}
.results .scard .of{color:#7f8ca8}
.results .scard span{color:#9fb0cf}
.results .scard .meter{background:rgba(255,255,255,.13)}
.results .find{border-bottom-color:rgba(255,255,255,.1)}
.results .find .n{background:var(--red)}
.results .find h3{color:#fff}
.results .find p{color:#b7c1d6}
.results .est{background:#16233d;border:1px solid rgba(223,49,49,.4);color:#fff}
.rhead{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.rlogo{height:32px}
.rtag{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--red);border-left:2px solid rgba(255,255,255,.18);padding-left:14px}
.grade{display:flex;align-items:center;gap:22px;background:linear-gradient(135deg,#1c2d4e,#14233f);border:1px solid rgba(255,255,255,.08);color:#fff;border-radius:18px;padding:26px 30px;margin:4px 0 28px}
.gbig{font-size:66px;font-weight:900;line-height:.9;font-variant-numeric:tabular-nums}.gbig span{font-size:26px;color:#9fb0cf;font-weight:800}
.glabel b{font-size:17px;font-weight:700;display:block}.glabel span{font-size:14px;color:#c1cde3}
.sc-good b{color:#178a49 !important}.sc-good .meter i{background:#178a49}
.sc-mid b{color:#c07d0c !important}.sc-mid .meter i{background:#c07d0c}
.sc-bad b{color:var(--red) !important}.sc-bad .meter i{background:var(--red)}
.fhead{font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--red);margin:6px 0 4px}
.scoregrid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:8px 0 26px}
.scard{background:#fff;border:1px solid var(--lineL);border-radius:16px;padding:24px 18px;text-align:center;position:relative;overflow:hidden}
.scard b{font-size:clamp(38px,7vw,54px);font-weight:900;color:var(--navy);display:block;line-height:1;font-variant-numeric:tabular-nums}
.scard .of{color:#b9b6ac;font-weight:700}.scard span{font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--soft);margin-top:8px;display:block}
.scard .meter{height:5px;border-radius:3px;background:#eceae3;margin-top:14px;overflow:hidden}.scard .meter i{display:block;height:100%;background:var(--red);border-radius:3px}
.find{display:flex;gap:16px;padding:20px 0;border-bottom:1px solid var(--lineL)}.find:last-child{border-bottom:0}
.find .n{flex:0 0 30px;height:30px;border-radius:9px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
.find h3{font-size:18px;font-weight:700;margin-bottom:4px}.find p{color:#5c5c5c;font-size:15px}
.est{background:var(--ink);color:#fff;border-radius:16px;padding:22px 26px;margin-top:22px;font-size:18px;font-weight:600;line-height:1.5}.est b{color:var(--red)}
/* case studies */
.case{border-top:1px solid var(--line);position:relative;overflow:hidden;padding:56px 32px 64px}
.case.cream{background:var(--cream);color:var(--ink);border-top:0}
/* soft light bloom behind the headline number so the stat reads as the hero of the section */
.case::before{content:"";position:absolute;top:-140px;left:-120px;width:520px;height:520px;border-radius:50%;
  background:radial-gradient(closest-side,rgba(223,49,49,.14),transparent 70%);pointer-events:none}
.case.cream::before{background:radial-gradient(closest-side,rgba(26,43,76,.10),transparent 70%)}
.case .inner{position:relative}
.secheading{font-size:clamp(24px,3.3vw,36px);font-weight:900;letter-spacing:-.02em;line-height:1.16;max-width:24ch;margin:10px 0 8px}
.secsub{font-size:16px;color:var(--soft);max-width:52ch;margin:0 0 44px}
.chero{display:flex;align-items:baseline;gap:20px;flex-wrap:wrap;margin-bottom:4px}
.bignum{font-size:clamp(62px,12.5vw,132px);font-weight:900;letter-spacing:-.045em;line-height:.88;
  font-variant-numeric:tabular-nums;
  background:linear-gradient(180deg,#ff5b57 0%,var(--red) 62%,#a5211f 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 6px 26px rgba(223,49,49,.28))}
.case.cream .bignum{background:linear-gradient(180deg,#33507f 0%,var(--navy) 70%,#0b1526 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;filter:none}
/* industry + timeframe reads as a tag, not stray caption text */
.chero .cl{font-size:12px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:var(--soft);
  border:1px solid var(--line);border-radius:100px;padding:7px 14px;align-self:center;white-space:nowrap}
.case.cream .chero .cl{border-color:var(--lineL);color:#6b6560}
.ctitle{font-size:clamp(25px,3.7vw,36px);font-weight:800;letter-spacing:-.015em;margin:14px 0 30px;max-width:22ch;line-height:1.18}
.cstory{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:8px}
/* each beat becomes a card, so challenge -> action -> result reads as a sequence */
.cstory .blk{background:rgba(255,255,255,.035);border:1px solid var(--line);border-radius:14px;padding:20px 20px 22px;
  border-top:3px solid var(--red);transition:transform .25s ease,background .25s ease}
.cstory .blk:hover{transform:translateY(-3px);background:rgba(255,255,255,.06)}
.case.cream .cstory .blk{background:rgba(26,43,76,.04);border-color:var(--lineL);border-top-color:var(--navy)}
.case.cream .cstory .blk:hover{background:rgba(26,43,76,.07)}
.cstory .blk h4{font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:var(--red);margin-bottom:10px}
.case.cream .cstory .blk h4{color:var(--navy)}
.cstory .blk p{font-size:14.5px;color:#c3c3c3;line-height:1.62}.case.cream .cstory .blk p{color:#57534e}
/* metrics as tiles rather than a loose text row */
.cmetrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:26px;padding-top:0;border-top:0}
.case.cream .cmetrics{border-top:0}
.cmetrics .m{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;padding:16px 16px 14px}
.case.cream .cmetrics .m{background:rgba(26,43,76,.045);border-color:var(--lineL)}
.cmetrics .m b{font-size:30px;font-weight:900;display:block;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.05}
.cmetrics .m span{font-size:12.5px;color:var(--soft);display:block;margin-top:6px;line-height:1.35}
/* video */
.vframe{aspect-ratio:16/9;border-radius:18px;overflow:hidden;background:#000;margin-top:28px;border:1px solid var(--line);box-shadow:0 30px 80px -30px rgba(0,0,0,.8)}
.vframe video,.vframe iframe{width:100%;height:100%;object-fit:cover;display:block}
/* booking */
.book{background:var(--ink2);text-align:center}
.book h2{font-size:clamp(30px,4.4vw,46px);font-weight:900;letter-spacing:-.02em;max-width:none;margin:0 auto;white-space:nowrap}
.book p{color:#cfcfcf;font-size:18px;margin:18px auto 8px;max-width:52ch}
.calwrap{margin-top:30px;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:#fff;max-width:100%}
.calwrap .calendly-inline-widget{width:100%}
.foot{padding:40px 32px;text-align:center;color:var(--soft);font-size:13px;border-top:1px solid var(--line)}
.foot a{color:#fff;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.25);padding-bottom:1px;transition:border-color .2s}
.foot a:hover{border-color:var(--red)}
.foot .flearn{color:var(--red);border-bottom-color:rgba(223,49,49,.4)}
.hide{display:none}
@media(max-width:720px){.case{padding:44px 22px 52px}.sec{padding:64px 22px}.hero{padding:80px 22px 64px}.scoregrid,.cstory{grid-template-columns:1fr}.cmetrics{grid-template-columns:1fr 1fr}.chero{gap:12px}.formwrap{padding:24px}.book h2{font-size:clamp(20px,5.7vw,30px);max-width:none;white-space:nowrap}.book p{font-size:15.5px;max-width:40ch}.book .inner{padding:0}.calwrap{min-width:0}.calwrap .calendly-inline-widget{min-width:0 !important}}
@media(max-width:360px){.book h2{white-space:normal;font-size:22px}.frow{flex-direction:column;gap:0}}
</style></head><body>
<div class="nav"><img class="logo" src="/media/logo-white.png" alt="Open Heart Media"/><a class="navcta" href="#book">Book a call</a></div>

${prescanned ? renderPrescannedReport(prospect) : `<section class="hero">
  <div class="inner">
    <div class="eyebrow reveal">${bizName ? 'Free growth audit for ' + esc(bizName) : 'Free growth audit'}</div>
    <h1 class="reveal">You're a great business. You're just <em>leaving money</em> on the table.</h1>
    <p class="sub reveal">Tell us where to look. We go through your website, your Google presence and whether AI assistants can find you at all, by hand, and then walk you through exactly what is costing you leads.</p>

    <div class="formwrap reveal" id="auditbox">
      <h2>Request your free growth audit</h2>
      <p class="fp">A real person goes through it, not a scanner. Usually back to you within one business day.</p>
      <div class="frow">
        <div><label for="f_first">First name</label><input id="f_first" placeholder="Jane"/></div>
        <div><label for="f_last">Last name</label><input id="f_last" placeholder="Doe"/></div>
      </div>
      <label for="f_biz">Business name</label>
      <input id="f_biz" placeholder="Your business"/>
      <label for="f_site">Your website</label>
      <input id="f_site" placeholder="yourbusiness.com" value="${esc(prefillSite)}"/>
      <label for="f_goal">What matters most right now</label>
      <select id="f_goal"><option value="more leads">More leads</option><option value="more phone calls">More phone calls</option><option value="more booked appointments">More booked appointments</option><option value="more sales">More sales</option><option value="more of everything">More of everything</option></select>
      <label for="f_email">Your email</label>
      <input id="f_email" type="email" placeholder="you@yourbusiness.com"/>
      <label for="f_phone">Best number to reach you</label>
      <input id="f_phone" type="tel" placeholder="(770) 555 0100"/>
      <div style="position:absolute;left:-9999px" aria-hidden="true"><input id="f_company_website" tabindex="-1" autocomplete="off"/></div>
      <button class="btn" id="run">Request my audit</button>
      <p class="err" id="err"></p>
    </div>
  </div>
</section>

<section class="sec results hide" id="result"></section>`}

<section class="case" id="proof">
  <div class="inner">
    <div class="eyebrow reveal">The receipts</div>
    <h2 class="reveal secheading">Real campaigns. Real revenue.</h2>
    <p class="reveal secsub">Not vague quotes and not rounded-up screenshots. Three engagements, every number traced back to the dollar, and the full report attached to each one.</p>
    <div class="chero reveal"><span class="bignum">$2.34M</span><span class="cl">Home services · Cherokee County, GA</span></div>
    <div class="ctitle reveal">Tracked revenue on $26K in ad spend, traced back to the dollar.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>They had the product and they had the reputation. What they did not have was a single tracked lead. No paid presence, no call logging, no pipeline, and revenue that moved with the season instead of with a system.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>We built the system: high-intent search, Performance Max for reach and retargeting, every call and text logged, and monthly optimization against real numbers.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>Twenty months later, $2,340,409 traced back to the dollar.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">$136,000</b><span>Nov to Dec 2024</span></div><div class="m"><b>$989,233</b><span>Full year 2025</span></div><div class="m"><b>$445,390</b><span>Jan to Apr 2026</span></div></div>
    <p class="reveal" style="margin-top:22px"><a href="https://openheartmediaco.com/case-studies/home-services-2-34m/" target="_blank" rel="noopener" style="color:inherit;font-weight:700;border-bottom:1px solid currentColor;text-decoration:none">Read the full case study &rarr;</a></p>
  </div>
</section>

<section class="case cream">
  <div class="inner">
    <div class="chero reveal"><span class="bignum">$896,551</span><span class="cl">E-commerce · In a single 110 day season</span></div>
    <div class="ctitle reveal">Nearly nine hundred thousand dollars, and by September email alone was producing better than a quarter of all revenue.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>A seasonal brand with one short window to make the year.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>We ran paid media through the peak while building the owned channel underneath it.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>Nearly nine hundred thousand dollars across 2,198 orders in 110 days, with average order value holding above $400 every single month, so none of the growth came from discounting. By September, email alone was producing better than a quarter of all revenue.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">2,198</b><span>Orders</span></div><div class="m"><b>$408</b><span>Average order value</span></div><div class="m"><b>15.7%</b><span>Of revenue from email</span></div></div>
    <p class="reveal" style="margin-top:22px"><a href="https://openheartmediaco.com/case-studies/ecommerce-peak-season/" target="_blank" rel="noopener" style="color:inherit;font-weight:700;border-bottom:1px solid currentColor;text-decoration:none">Read the full case study &rarr;</a></p>
  </div>
</section>

<section class="case">
  <div class="inner">
    <div class="chero reveal"><span class="bignum">$4M to $6M</span><span class="cl">Healthcare · Private home care</span></div>
    <div class="ctitle reveal">In a single year, on a fully tracked channel.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>Families were searching and finding somebody else.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>We pointed a fully tracked search channel at skilled nursing, the highest value care this agency can staff, and held the targeting to the four counties where it can actually put a nurse.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>July and August, the two months home care writes off as slow, grew 30% and 23% against the same months last year. The client now projects $6 million for 2026 against $4 million in 2025.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">+30.4%</b><span>July care hours</span></div><div class="m"><b>+23.1%</b><span>August care hours</span></div><div class="m"><b>5.95%</b><span>Ad click rate</span></div></div>
    <p class="reveal" style="margin-top:22px"><a href="https://openheartmediaco.com/case-studies/healthcare-home-care/" target="_blank" rel="noopener" style="color:inherit;font-weight:700;border-bottom:1px solid currentColor;text-decoration:none">Read the full case study &rarr;</a></p>
  </div>
</section>

<section class="sec">
  <div class="inner">
    <div class="eyebrow reveal">See it for yourself</div>
    <div class="ctitle reveal" style="color:#fff;max-width:24ch">What it looks like to work with us.</div>
    ${video}
  </div>
</section>

<section class="sec book" id="book">
  <div class="inner">
    <div class="eyebrow reveal" style="text-align:center">Book Your Free Discovery Call</div>
    <h2 class="reveal">Find out why the phone isn't ringing.</h2>
    <p class="reveal">The phone isn't ringing like it used to. You're spending on ads and can't tell what's working. Someone smaller than you keeps showing up where you should be. Thirty minutes to get to the bottom of it, then we build your gameplan. No pitch, no pressure.</p>
    <div class="calwrap reveal"><div class="calendly-inline-widget" data-url="${CALENDLY}?hide_gdpr_banner=1&hide_event_type_details=1&utm_content=${esc(ref || '')}" style="min-width:320px;height:700px"></div></div>
  </div>
</section>

<div class="foot">Open Heart Media · Learn more about us · <a href="https://openheartmediaco.com" target="_blank" rel="noopener">openheartmediaco.com</a></div>

<script src="https://assets.calendly.com/assets/external/widget.js" async></script>
<script>
  var REF = ${JSON.stringify(ref || '')};
  // There is a server side esc() with the same name, which is why this went unnoticed: every
  // esc(...) inside this script is plain text in the browser, not interpolated, so the browser was
  // calling a function that was never defined here. Any code path reaching it threw a
  // ReferenceError and stopped dead.
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function track(t){ try{ navigator.sendBeacon('/api/track', new Blob([JSON.stringify({type:t,ref:REF})],{type:'application/json'})); }catch(e){} }
  track('view');
  var revs=document.querySelectorAll('.reveal');
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.08});
    revs.forEach(function(el){io.observe(el);});
    // safety net: never leave content hidden
    setTimeout(function(){revs.forEach(function(el){el.classList.add('in');});},1600);
  } else { revs.forEach(function(el){el.classList.add('in');}); }
  var vid=document.querySelector('.vframe video');
  if(vid){ vid.loop=true; vid.muted=true; vid.setAttribute('loop',''); vid.play().catch(function(){}); vid.addEventListener('ended',function(){ try{vid.currentTime=0; vid.play();}catch(e){} }); }
  document.querySelector('.navcta').addEventListener('click',function(){track('click');});
  // The report variant of this page has no form, so these elements do not exist there.
  var runBtn=document.getElementById('run');
  if(runBtn) runBtn.addEventListener('click', function(){
    function v(id){ var el=document.getElementById(id); return el ? el.value.trim() : ''; }
    var first=v('f_first'), last=v('f_last'), biz=v('f_biz'), sitev=v('f_site');
    var email=v('f_email'), phone=v('f_phone'), goal=v('f_goal');
    var err=document.getElementById('err');
    var fields=[['f_first',first],['f_last',last],['f_biz',biz],['f_email',email],['f_phone',phone]];
    fields.forEach(function(f){ var el=document.getElementById(f[0]); if(el) el.classList.remove('invalid'); });
    var missing=fields.filter(function(f){return !f[1];});
    if(missing.length){ missing.forEach(function(f){ var el=document.getElementById(f[0]); if(el) el.classList.add('invalid'); });
      err.textContent='Please fill in all fields.'; return; }
    if(email.indexOf('@')<1){ document.getElementById('f_email').classList.add('invalid'); err.textContent='Please enter a valid email.'; return; }
    if(phone.replace(/\D/g,'').length<10){ document.getElementById('f_phone').classList.add('invalid'); err.textContent='Please enter a phone number we can reach you on.'; return; }
    err.textContent=''; var btn=this; btn.disabled=true; btn.textContent='Sending...';
    function fail(msg){ err.textContent=msg||'Something went wrong. Please try again, or call 404-491-1466.';
      btn.disabled=false; btn.textContent='Request my audit'; }

    // Nothing is scanned or scored in front of the visitor any more. This only has to save the
    // lead and tell the team; the audit itself is done by a person afterwards.
    fetch('/api/qualify',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ ref:REF, name:(first+' '+last).trim(), business:biz, website:sitev,
        email:email, phone:phone, goal:goal, source:'go-landing',
        company_website:v('f_company_website') })})
     .then(function(r){return r.json();})
     .then(function(j){
       if(j && j.error) return fail(j.error);
       try{ if(window.fbq) fbq('track','Lead',{content_name:'growth audit request'}); }catch(e){}
       try{ if(window.gtag) gtag('event','generate_lead',{currency:'USD',value:1}); }catch(e){}
       confirmed(first);
     })
     .catch(function(){ fail(); });

    function confirmed(name){
      var box=document.getElementById('auditbox');
      box.innerHTML='<h2>Got it. We are on it.</h2>'
        +'<p class="fp" style="font-size:15px;line-height:1.6">Thanks '+esc(name)+'. One of us is going through your site, your Google presence and your AI search visibility by hand right now.</p>'
        +'<p class="fp" style="font-size:15px;line-height:1.6;margin-top:14px">You will hear from us within one business day. If you would rather pick a time yourself, grab a slot below.</p>'
        +'<a class="btn" id="rbook" href="#book" style="margin-top:18px;text-decoration:none;display:block;text-align:center">Book my call</a>';
      var b=document.getElementById('rbook');
      if(b) b.addEventListener('click',function(){track('click');});
      box.scrollIntoView({behavior:'smooth'});
    }
  });
</script>
</body></html>`;
}
function sentToday() {
  const today = new Date().toISOString().slice(0, 10);
  return prospects.filter(p => (p.sent_at || '').slice(0, 10) === today).length;
}

// ---------- CAN-SPAM compliance ----------
// Every commercial message we originate must carry a working opt-out and a physical postal
// address. The model was asked to include these in the drafted copy and did so unreliably, so
// they are appended in code instead: the copy path can never drop them.
const COMPANY = process.env.COMPANY_NAME || 'Open Heart Media';
// Anything submitted from one of our own mailboxes is a test of the form, not a lead. It still
// gets saved and still gets its email so the test is a real test, but it never raises an alert,
// never enters the follow-up sequence and never shows up in a count of inbound demand. Twelve of
// the eighteen "stranded leads" found on 24 Sep were our own team trying the audit tool.
const OWN_DOMAIN = (process.env.OWN_DOMAIN || 'openheartmediaco.com').toLowerCase();
function isOwnTeam(addr) {
  const e = String(addr || '').toLowerCase().trim();
  return e.endsWith('@' + OWN_DOMAIN);
}
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS
  || '225 Reformation Pkwy, Suite 200 Office #28, Canton, GA 30114';
const PUBLIC_URL = (process.env.PUBLIC_URL || LANDING_URL.replace(/\/go\/?$/, '')).replace(/\/$/, '');

// Signed so the link cannot be walked to unsubscribe someone else, and so a scraped link from one
// prospect's email does nothing to another's record.
// A report URL carries a frank assessment of a named business. The ids are sequential, so an
// unsigned link let anyone who received one email read the report for every other prospect simply
// by counting up. Same HMAC approach as the unsubscribe links.
function reportToken(id) {
  return crypto.createHmac('sha256', AUTH_SECRET).update('report:' + id).digest('hex').slice(0, 16);
}
function reportSlug(p) {
  const name = String(p.business || 'report')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38)
    .replace(/-+$/, '');
  return `${name || 'report'}-${reportToken(p.id).slice(0, 8)}`;
}
function reportUrl(p) {
  // e.g. https://reports.openheartmediaco.com/report/elite-landscape-services-c923e315
  // "/r/" read as a redirect, which is the shape people have learned to distrust. "/report/" says
  // what is actually on the other side.
  return `${SITE_ORIGIN}/report/${reportSlug(p)}`;
}
function reportTokenValid(id, t) {
  if (!t) return false;
  const want = Buffer.from(reportToken(id));
  const got = Buffer.from(String(t));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function unsubToken(id) {
  return crypto.createHmac('sha256', AUTH_SECRET).update('unsub:' + id).digest('hex').slice(0, 24);
}
function unsubUrl(id) {
  return `${PUBLIC_URL}/unsubscribe?id=${encodeURIComponent(id)}&t=${unsubToken(id)}`;
}
// Used for direct answers to an inbound request. CAN-SPAM's opt-out requirement covers
// commercial mail, not a reply to someone who just handed us their number, and putting an
// unsubscribe link on an acknowledgement is how a hot lead accidentally suppresses itself.
// SendGrid click tracking rewrites every URL it finds. In a text-only email that rewritten
// URL is what the reader SEES: a 300 character tracking string wrapping over three lines, twice,
// which is enough for Gmail to clip the message. Sending an HTML part fixes it without giving up
// click data, because tracking replaces the href and leaves the anchor text alone.
function htmlEscape(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function textToHtml(text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>()]+)/g);
  const body = parts.map((chunk, i) => {
    if (i % 2 === 0) return htmlEscape(chunk).replace(/\n/g, '<br>');
    const shown = htmlEscape(chunk.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    return `<a href="${htmlEscape(chunk)}" style="color:#1a4fa0">${shown}</a>`;
  }).join('');
  return '<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">'
    + '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;'
    + 'font-size:15px;line-height:1.6;color:#111111;max-width:600px;padding:8px 0">'
    + body + '</div></body></html>';
}

function transactionalFooter() {
  return `\n\n\n${COMPANY} \u00b7 ${COMPANY_ADDRESS}`;
}

function complianceFooter(p) {
  return '\n\n\n'
    + `You are receiving this because ${COMPANY} works with local businesses in your area.\n`
    + `To stop hearing from us, click here: ${unsubUrl(p.id)}\n`
    + `Or just reply STOP and we will not contact you again.\n\n`
    + `${COMPANY} · ${COMPANY_ADDRESS}`;
}

// A permanent failure is a bad address, not a bad moment. Retrying it does nothing but damage
// sender reputation, so these park the lead instead of leaving it in the queue.
function isPermanentFailure(err) {
  const code = err?.code || err?.response?.statusCode;
  const msg = (err?.response?.body?.errors?.[0]?.message || err?.message || '').toLowerCase();
  if (code === 400 || code === 413) return true;
  return /invalid|does not (exist|contain)|malformed|not a valid|blocked|bounce|suppress|unsubscrib|spam report/.test(msg);
}

// The one place mail leaves this system. Suppression and the footer are enforced here so a new
// send path cannot be added later that quietly skips either.
// ---------- Is this address worth spending domain reputation on? ----------
// The only test this system ever applied to an address was whether it contained an "@". Every row
// came in from a scrape and nothing looked at it again, which held up fine for as long as nothing
// was actually sent. The first real batch had four addresses in fifteen that should never have
// gone out: two placeholder domains belonging to unrelated companies, one web agency, and one
// misspelled domain with no mail server at all.
//
// A hard bounce and a stranger's spam complaint both cost the sending domain, and a young domain
// has no reputation to spend. So the check happens here, once, in the one place every message
// passes through, rather than depending on somebody reading the list first.

// Domains that are template boilerplate rather than a business. Scrapers lift these straight off
// a site's own placeholder copy, and they resolve to real companies who never heard of the lead.
const PLACEHOLDER_DOMAINS = new Set([
  'company.com', 'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com',
  'mysite.com', 'yoursite.com', 'website.com', 'email.com', 'test.com', 'sample.com',
  'fashionshop.com', 'secret.com', 'mydomain.com', 'sitename.com',
]);

const mxCache = new Map();                                   // domain -> { ok, ts }
const MX_TTL_MS = 24 * 60 * 60 * 1000;
async function domainAcceptsMail(domain) {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.ts < MX_TTL_MS) return hit.ok;
  let ok;
  try {
    const mx = await dns.resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch (e) {
    // NXDOMAIN and "no records" are answers: nothing there accepts mail. A timeout or a resolver
    // failure is not an answer, so let it through rather than parking a good lead on a bad lookup.
    ok = !(e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA'));
  }
  mxCache.set(domain, { ok, ts: Date.now() });
  return ok;
}

// Returns null when the address is worth sending to, or a human readable reason when it is not.
async function addressProblem(email) {
  const addr = String(email || '').trim();
  // Deliberately stricter than "has an @". The scrape put fragments of Google Maps URLs in this
  // column ("+LLC/@34.10254", "//www.google.com/maps/place/.../@33.665614"), and those satisfy any
  // check loose enough to accept a real address but loose enough to accept a slash or a numeric
  // TLD. No slashes, and the TLD has to be letters.
  if (!/^[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}$/.test(addr)) return 'not a valid email address';
  const domain = addr.split('@')[1].toLowerCase();
  if (PLACEHOLDER_DOMAINS.has(domain)) {
    return `${domain} is placeholder text a scraper lifted from their site, not their real address`;
  }
  if (!(await domainAcceptsMail(domain))) {
    return `${domain} has no mail server, so this would hard bounce`;
  }
  return null;
}

// ---------- SendGrid suppression sync ----------
// addressProblem() checks syntax, placeholder domains and whether the DOMAIN accepts mail. It
// cannot tell that a real domain has no such mailbox, which is what "552 mailbox not found" and
// "550 user unknown" are, and those were 21 of 344 sends. SendGrid already knows every address
// that has failed: it keeps bounces, blocks and invalids and silently drops future mail to them.
// The CRM was never told, so it kept drafting (an Anthropic call each) and attempting addresses
// that could never be delivered. Pull that list in and park them once.
const SUPPRESSED = new Set();

async function refreshSuppressions() {
  if (!process.env.SENDGRID_API_KEY) return 0;
  const groups = ['bounces', 'blocks', 'invalid_emails', 'spam_reports'];
  let added = 0;
  for (const g of groups) {
    try {
      const r = await fetch(`https://api.sendgrid.com/v3/suppression/${g}?limit=500`, {
        headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      });
      if (!r.ok) continue;
      for (const row of await r.json()) {
        const e = String(row.email || '').toLowerCase();
        if (e && !SUPPRESSED.has(e)) { SUPPRESSED.add(e); added++; }
      }
    } catch (e) { console.error('[suppression]', g, e.message); }
  }
  // Park anyone in the pipeline who is on that list, so they stop consuming queue slots.
  let parked = 0;
  const now = new Date().toISOString();
  for (const p of prospects) {
    const e = (p.email || '').toLowerCase();
    if (!e || !SUPPRESSED.has(e)) continue;
    if (p.status === 'unreachable' || p.status === 'won' || p.status === 'lost') continue;
    p.status = 'unreachable';
    p.updated_at = now;
    p.last_send_error = 'On the SendGrid suppression list, mail to this address is dropped.';
    parked++;
  }
  if (parked) { try { save(prospects); } catch {} }
  console.log(`[suppression] ${SUPPRESSED.size} known-bad addresses, parked ${parked} prospects`);
  return parked;
}

function isSuppressed(email) {
  return SUPPRESSED.has(String(email || '').toLowerCase());
}

setTimeout(() => { refreshSuppressions().catch(e => console.error('[suppression]', e.message)); }, 20 * 1000);
setInterval(() => { refreshSuppressions().catch(e => console.error('[suppression]', e.message)); }, 6 * 60 * 60 * 1000);

async function sendMail(p, subject, body, { kind = 'outreach', attachments = null, transactional = false } = {}) {
  if (p.do_not_email || p.source === 'callleads') throw Object.assign(new Error('call lead: never emailed'), { permanent: true, callLead: true });
  if (p.unsubscribed_at) throw Object.assign(new Error('lead has unsubscribed'), { suppressed: true });
  // The role-address filter exists to stop us COLD-mailing info@ and sales@. When someone fills in
  // our own form and asks us to contact them, refusing to answer because they typed a shared
  // mailbox is the wrong call. Opt-out, suppression and bounce checks still apply to everything.
  if (!transactional && !isMailableBusiness(p.email)) throw Object.assign(new Error('not a mailable business address'), { permanent: true });
  if (isSuppressed(p.email)) {
    throw Object.assign(new Error('SendGrid already suppresses this address, it would be dropped'), { permanent: true });
  }
  const problem = await addressProblem(p.email);
  if (problem) throw Object.assign(new Error(problem), { permanent: true });
  const fullText = body + (transactional ? transactionalFooter() : complianceFooter(p));
  const msg = {
    to: p.email,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject,
    text: fullText,
    html: textToHtml(fullText),
    trackingSettings: { subscriptionTracking: { enable: false } },
    customArgs: { prospect_id: String(p.id), kind },
  };
  if (attachments && attachments.length) msg.attachments = attachments;
  const [r] = await sgMail.send(msg);
  // Every outbound email stamps these, whatever path it came from. seq_anchor_at is the first
  // touch and is what the follow-up sequence counts from; sent_at keeps doing only what it did
  // before, marking a cold send against the daily cap. Using one field for both jobs is what
  // left every inbound lead outside the sequence: a guide download, an audit report and a form
  // reply are all real touches, and none of them set sent_at.
  p.last_touch_at = new Date().toISOString();
  if (!p.seq_anchor_at) p.seq_anchor_at = p.sent_at || p.last_touch_at;
  return r;
}


// ---------- API ----------
const app = express();
app.disable('x-powered-by');
// gzip everything that is text. The pages and API answers are large and were being sent uncompressed.
app.use(compression({ threshold: 1024 }));
app.set('trust proxy', 1);   // Render sits behind one proxy; without this every visitor shares one IP for rate limiting
// Security headers on every response. HSTS only over https so local development still works.
// No Content-Security-Policy yet: the pages use inline handlers, and a half-right CSP would break them.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (String(req.headers['x-forwarded-proto'] || '').includes('https')) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Universal team login (one shared password, cookie session) ----------
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'ohm-default-secret';
if (process.env.APP_PASSWORD && !process.env.AUTH_SECRET) console.warn('[security] AUTH_SECRET is not set, so the shared-password cookie uses a public default. Set AUTH_SECRET on Render, or set DISABLE_SHARED_PASSWORD=1 once everyone has their own login.');
// Once every person has their own login, set DISABLE_SHARED_PASSWORD=1 on Render. The shared password then stops working entirely.
const SHARED_PW_OFF = process.env.DISABLE_SHARED_PASSWORD === '1';
const AUTH_TOKEN = crypto.createHmac('sha256', AUTH_SECRET).update('ohm-team-access-v1').digest('hex');

// ---------- Individual logins ----------
// Each person has their own email + password. Passwords are stored as scrypt hashes, never in clear.
// Sessions are signed with a random secret kept on the data disk (not derived from AUTH_SECRET).
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_SECRET_FILE = path.join(DATA_DIR, 'session_secret.txt');
let SESS_SECRET = '';
try { SESS_SECRET = fs.readFileSync(SESS_SECRET_FILE, 'utf8').trim(); } catch {}
if (!SESS_SECRET) { SESS_SECRET = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SESS_SECRET_FILE, SESS_SECRET, { mode: 0o600 }); } catch {} }
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 }); }
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') }; }
function checkPw(user, pw) {
  if (!user || !user.salt || !user.hash) return false;
  const h = crypto.scryptSync(String(pw), user.salt, 64);
  const b = Buffer.from(user.hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}
function tempPassword() { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let o = ''; for (const b of crypto.randomBytes(12)) o += a[b % a.length]; return o.slice(0, 4) + '-' + o.slice(4, 8) + '-' + o.slice(8, 12); }
(function seedUsers() {
  if (loadUsers().length) return;
  const seed = { id: 'u_' + crypto.randomBytes(4).toString('hex'), email: 'zac@openheartmediaco.com', name: 'Zac Sweat', role: 'admin', active: true, created_at: new Date().toISOString(), must_change: true };
  Object.assign(seed, hashPw(process.env.APP_PASSWORD || tempPassword()));
  try { saveUsers([seed]); console.log('[users] seeded zac@openheartmediaco.com (uses the current shared team password until changed)'); } catch (e) { console.error('[users] seed failed -', e.message); }
})();
function signSession(uid, days) { const exp = Date.now() + days * 864e5; const body = uid + '.' + exp; return body + '.' + crypto.createHmac('sha256', SESS_SECRET).update(body).digest('hex'); }
function readSession(tok) {
  const m = /^(u_[a-f0-9]+)\.(\d+)\.([a-f0-9]{64})$/.exec(tok || ''); if (!m) return null;
  const want = crypto.createHmac('sha256', SESS_SECRET).update(m[1] + '.' + m[2]).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(want)) || Date.now() > +m[2]) return null;
  const u = loadUsers().find(x => x.id === m[1]); return u && u.active !== false ? u : null;
}
function cookieOpts(req) { return 'HttpOnly; Path=/; SameSite=Lax' + (String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''); }
// Returns the signed-in user (or the legacy shared-password user) and sets req.user.
function authedUser(req) {
  if (req.user) return req.user;
  const u = readSession(getCookie(req, 'ohm_sess'));
  if (u) { req.user = { id: u.id, name: u.name, email: u.email, role: u.role, must_change: !!u.must_change }; return req.user; }
  if (!SHARED_PW_OFF && getCookie(req, 'ohm_auth') === AUTH_TOKEN) { req.user = { id: 'legacy', name: 'Team', email: '', role: 'member', legacy: true }; return req.user; }
  return null;
}
const loginHits = new Map();
function loginLimited(key, max) {
  const now = Date.now(), win = 15 * 60e3, hits = (loginHits.get(key) || []).filter(t => now - t < win);
  if (hits.length >= (max || 8)) { loginHits.set(key, hits); return true; }
  hits.push(now); loginHits.set(key, hits); return false;
}
// Prospect-facing routes + login stay open; everything else needs the cookie (when APP_PASSWORD set).
// Prospect-facing routes stay open: the landing page, its live-scan audit submit, tracking
// beacon, and the Calendly webhook. Everything else needs the team login cookie.
// '/unsubscribe' MUST stay here: CAN-SPAM requires the opt-out to work without the recipient
// creating an account or logging in to anything.
// '/api/gmail/callback' has to be here: Google redirects the browser back to PUBLIC_URL, which is
// the go. host, while the team cookie was set on app. A cookie is not sent across hosts, so the
// callback would bounce to /login and drop the one time code. The code is worthless without the
// client secret, and Google will only redirect to a URI registered on the OAuth client.
const PUBLIC_PATHS = ['/go', '/r', '/report', '/unsubscribe', '/healthz', '/robots.txt', '/api/track', '/api/calendly-webhook', '/api/sendgrid-events', '/api/gmail/callback', '/login', '/api/login', '/api/logout', '/api/subscribe', '/api/giveaway', '/api/qualify', '/guide', '/onboarding', '/api/onboarding', '/qm']
// '/api/audit' was public so the landing page could run a scan in front of a visitor. Nothing
// public triggers an audit any more: leads come in through /api/qualify and the team runs the
// audit themselves, so the endpoint now sits behind the team login like everything else.;
function getCookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m ? m[1] : null; }
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();                                   // no lock if unset (local dev)
  if (req.path.startsWith('/media/')) return next();                 // assets used by public /go page
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (authedUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
});

function renderLogin(err) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open Heart Media CRM</title><meta name="theme-color" content="#0f1b30"><style>
:root{--ink:#0b1220;--red:#e22a24}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
 background:radial-gradient(60% 80% at 100% 0%,rgba(226,42,36,.35),transparent 60%),radial-gradient(60% 80% at 0% 100%,rgba(47,111,208,.35),transparent 60%),linear-gradient(135deg,#13264a,#0a1226)}
.card{width:100%;max-width:400px;background:#fff;border-radius:22px;padding:38px 34px 30px;box-shadow:0 30px 80px -20px rgba(0,0,0,.6)}
.logo{height:38px;margin-bottom:22px}
h1{font-size:23px;font-weight:800;letter-spacing:-.025em;margin:0 0 4px}
p.sub{color:#68758c;font-size:14px;margin:0 0 22px}
label{display:block;font-size:12px;font-weight:600;color:#3a465c;margin:0 0 6px;letter-spacing:.02em}
input{width:100%;padding:13px 14px;border:1px solid #d5dce8;border-radius:12px;background:#fbfcfe;font:inherit;margin-bottom:16px;min-height:46px}
input:focus{outline:2px solid #6aa0ff;outline-offset:1px;background:#fff}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--red);color:#fff;font-weight:700;font-size:15px;cursor:pointer;min-height:48px;box-shadow:0 10px 24px -10px rgba(226,42,36,.8)}
button:hover{background:#f03a34}
.err{color:#c4261d;font-size:13.5px;margin:-4px 0 14px;min-height:18px}
.alt{display:block;margin-top:18px;text-align:center;font-size:13px;color:#68758c;cursor:pointer;text-decoration:underline}
.foot{margin-top:22px;text-align:center;color:#9aa7bd;font-size:11px;letter-spacing:.14em}
</style></head><body>
<div class="card">
  <img class="logo" src="/media/logo-navy.png" alt="Open Heart Media"/>
  <h1>Welcome back</h1><p class="sub">Sign in to the Open Heart Media CRM.</p>
  <form method="POST" action="/api/login" id="f">
    <div id="emailRow"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" placeholder="you@openheartmediaco.com" autofocus/></div>
    <label for="pw" id="pwl">Password</label><input id="pw" type="password" name="password" autocomplete="current-password"/>
    <div class="err">${err ? 'That email and password did not match. Try again.' : ''}</div>
    <button type="submit">Sign in</button>
  </form>
  <a class="alt" id="alt" onclick="var r=document.getElementById('emailRow');var on=r.style.display==='none';r.style.display=on?'':'none';document.getElementById('email').disabled=!on;document.getElementById('pwl').textContent=on?'Password':'Shared team password';this.textContent=on?'Use the shared team password instead':'Sign in with your email instead'">Use the shared team password instead</a>
  <div class="foot">OPEN HEART MEDIA CRM</div>
</div></body></html>`;
}
app.get('/login', (_, res) => res.send(renderLogin(false)));
app.post('/api/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 254);
  const password = String((req.body && req.body.password) || '').slice(0, 200);
  const key = (req.ip || 'x') + '|' + email;
  if (loginLimited('ip|' + (req.ip || 'x'), 40) || loginLimited(key)) return res.status(429).send('Too many attempts. Wait 15 minutes and try again.');
  if (email) {
    let u = loadUsers().find(x => x.email === email && x.active !== false);
    // Recovery: the first admin account that has never had its own password set will also accept the shared team password.
    if (u && !checkPw(u, password) && APP_PASSWORD && password === APP_PASSWORD && u.must_change && u.role === 'admin' && u.email === 'zac@openheartmediaco.com') {
      const all = loadUsers(); const t = all.find(x => x.id === u.id); Object.assign(t, hashPw(APP_PASSWORD)); saveUsers(all); u = t;
    }
    if (u && checkPw(u, password)) {
      u.last_login = new Date().toISOString(); try { saveUsers(loadUsers().map(x => x.id === u.id ? u : x)); } catch {}
      res.setHeader('Set-Cookie', `ohm_sess=${signSession(u.id, 30)}; ${cookieOpts(req)}; Max-Age=${60 * 60 * 24 * 30}`);
      return res.redirect(u.must_change ? '/account?first=1' : '/');
    }
    return res.status(401).send(renderLogin(true));
  }
  if (APP_PASSWORD && !SHARED_PW_OFF && password === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `ohm_auth=${AUTH_TOKEN}; ${cookieOpts(req)}; Max-Age=${60 * 60 * 24 * 30}`);
    return res.redirect('/');
  }
  res.status(401).send(renderLogin(true));
});
app.post('/api/logout', (req, res) => { const o = cookieOpts(req); res.setHeader('Set-Cookie', [`ohm_auth=; ${o}; Max-Age=0`, `ohm_sess=; ${o}; Max-Age=0`]); res.json({ ok: true }); });

app.get('/api/me', (req, res) => { const u = authedUser(req); if (!u) return res.status(401).json({ error: 'auth required' }); const full = u.id && u.id !== 'legacy' ? (loadUsers().find(x => x.id === u.id) || {}) : {};
  res.json({ id: u.id, name: u.name, email: u.email, title: full.title || '', role: u.role, must_change: !!u.must_change, legacy: !!u.legacy, pipeline: hasPipeline(u), queue: !u.legacy && String(u.email || '').toLowerCase() === 'zac@openheartmediaco.com' }); });
app.post('/api/me/password', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(401).json({ error: 'Sign in with your own email to change a password.' });
  const { current, next } = req.body || {};
  const users = loadUsers(), u = users.find(x => x.id === me.id);
  if (!u || !checkPw(u, current || '')) return res.status(400).json({ error: 'Your current password is not right.' });
  if (String(next || '').length < 10) return res.status(400).json({ error: 'Use at least 10 characters.' });
  Object.assign(u, hashPw(next)); u.must_change = false; saveUsers(users); res.json({ ok: true });
});
app.get('/account', (req, res) => {
  const u = authedUser(req);
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your account</title>
<style>body{font:15px/1.5 Inter,-apple-system,sans-serif;background:#f3f5f9;margin:0;display:flex;justify-content:center;padding:40px 16px;color:#0b1220}.c{max-width:420px;width:100%;background:#fff;border:1px solid #e6eaf1;border-radius:18px;padding:30px;box-shadow:0 12px 40px -18px rgba(11,18,32,.3)}h1{margin:0 0 4px;font-size:22px;letter-spacing:-.02em}p{color:#667489;margin:0 0 18px}label{display:block;font-size:12px;font-weight:600;margin:0 0 6px}input{width:100%;padding:12px;border:1px solid #d5dce8;border-radius:10px;margin-bottom:14px;font:inherit}button{padding:12px 18px;border:0;border-radius:10px;background:#e22a24;color:#fff;font-weight:700;cursor:pointer;font-size:15px}a{color:#2f6fd0}#m{margin-top:12px;font-size:14px}</style>
<div class="c"><h1>${esc(u && u.name || 'Account')}</h1><p>${req.query.first ? 'Welcome. Pick your own password to finish setting up.' : esc(u && u.email || '')}</p>
${u && u.legacy ? '<p>You are signed in with the shared team password. Ask Zac for your own login.</p><a href="/">Back to the CRM</a>' : `<form id="f"><label>Current password</label><input type="password" id="cur" autocomplete="current-password" required><label>New password (10 or more characters)</label><input type="password" id="nw" autocomplete="new-password" minlength="10" required><button>Save password</button><div id="m"></div></form><p style="margin-top:18px"><a href="/">Back to the CRM</a></p>`}</div>
<script>var f=document.getElementById('f');if(f)f.onsubmit=async function(e){e.preventDefault();var r=await fetch('/api/me/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:cur.value,next:nw.value})});var j=await r.json();document.getElementById('m').textContent=r.ok?'Saved. Taking you to the CRM...':(j.error||'Could not save.');if(r.ok)setTimeout(function(){location.href='/'},900)}</script>`);
});
function requireAdmin(req, res) { const u = authedUser(req); if (u && u.role === 'admin') return u; res.status(403).json({ error: 'Admins only.' }); return null; }
const pubUser = u => ({ id: u.id, name: u.name, email: u.email, title: u.title || '', role: u.role, active: u.active !== false, must_change: !!u.must_change, last_login: u.last_login || '', pipeline: hasPipeline({ id: u.id }) });
app.get('/api/admin/users', (req, res) => { if (!requireAdmin(req, res)) return; res.json({ users: loadUsers().map(pubUser) }); });
app.post('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80), email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 254);
  const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'member';
  if (!name || !looksLikeEmail(email)) return res.status(400).json({ error: 'Add a name and a valid email.' });
  const users = loadUsers(); if (users.some(x => x.email === email)) return res.status(400).json({ error: 'That email already has a login.' });
  const temp = tempPassword();
  const title = String((req.body && req.body.title) || '').trim().slice(0, 80);
  const u = { id: 'u_' + crypto.randomBytes(4).toString('hex'), email, name, title, role, active: true, must_change: true, created_at: new Date().toISOString(), ...hashPw(temp) };
  users.push(u); saveUsers(users); res.json({ user: pubUser(u), temp_password: temp });
});
app.post('/api/admin/users/:id/reset', (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const users = loadUsers(), u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Not found.' });
  const temp = tempPassword(); Object.assign(u, hashPw(temp)); u.must_change = true; saveUsers(users); res.json({ temp_password: temp });
});
app.post('/api/admin/users/:id/active', (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  if (me.id === req.params.id) return res.status(400).json({ error: 'You cannot turn off your own login.' });
  const users = loadUsers(), u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Not found.' });
  u.active = !!(req.body && req.body.active); saveUsers(users); res.json({ ok: true });
});
app.post('/api/admin/users/:id/title', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = loadUsers(), u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Not found.' });
  u.title = String((req.body && req.body.title) || '').trim().slice(0, 80); saveUsers(users); res.json({ ok: true });
});
app.post('/api/admin/users/:id/role', (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  if (me.id === req.params.id) return res.status(400).json({ error: 'Ask another admin to change your role.' });
  const users = loadUsers(), u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Not found.' });
  u.role = (req.body && req.body.role) === 'admin' ? 'admin' : 'member'; saveUsers(users); res.json({ ok: true });
});

// ---------- Sales pipeline lock ----------
// Only these five people may see prospects, outreach, email sending, audits or outreach metrics.
// Enforced here on the server, so hiding a tab in the browser is not what protects the data.
// An admin can change the list per person on the Team page (users.json "pipeline": true/false);
// until a person has an explicit setting, this default list decides.
const PIPELINE_DEFAULT = new Set(['zac@openheartmediaco.com', 'lisa@openheartmediaco.com', 'michelle@openheartmediaco.com', 'brad@openheartmediaco.com', 'griffin@openheartmediaco.com']);
function hasPipeline(u) {
  if (!u || u.legacy || !u.id || u.id === 'legacy') return false;   // the old shared password never sees the pipeline
  const full = loadUsers().find(x => x.id === u.id); if (!full || full.active === false) return false;
  if (typeof full.pipeline === 'boolean') return full.pipeline;
  return PIPELINE_DEFAULT.has(String(full.email || '').toLowerCase());
}
const PIPELINE_PATHS = ['/api/prospects', '/api/generate-all', '/api/send-approved', '/api/prescan', '/api/run-followups', '/api/mailchimp', '/api/autosend-status', '/api/autosend-pause', '/api/run-autosend', '/api/reseed', '/api/metrics', '/api/audit', '/api/audit-pdf-preview', '/api/gmail/connect', '/api/gmail/status', '/api/gmail/check'];
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (!PIPELINE_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (hasPipeline(authedUser(req))) return next();
  return res.status(403).json({ error: 'The sales pipeline is limited to Lisa, Michelle, Brad, Griffin and Zac.' });
});
// ---------- Posting queue (Zac only) ----------
// One list of every post that is waiting to go to Sprout. Locked to Zac's own login on the server:
// no other admin, and not the old shared password. Only posts marked Approved ever reach the export.
const QUEUE_FILE = path.join(DATA_DIR, 'post_queue.json');
const QUEUE_OWNER = 'zac@openheartmediaco.com';
// Who has to approve, per client. Everyone not listed here is approved by Zac alone.
const QUEUE_RULES = {
  urc:   { approvers: ['Carrie'], captionBy: 'Griffin', note: 'Griffin writes the caption first, then Carrie approves.' },
  nitro: { approvers: ['Drew', 'Brian Rosenberg'], note: 'Client approval needed.' },
  bkvf:  { approvers: ['Meg', 'Bryan', 'Rob', 'Haley'], note: 'Client approval needed.' },
  cisga: { approvers: ['Adrienne', 'Jamie'], note: 'Client approval needed.' },
};
function zacOnly(req, res) {
  const u = authedUser(req);
  if (u && !u.legacy && String(u.email || '').toLowerCase() === QUEUE_OWNER) return u;
  res.status(403).json({ error: 'The posting queue is private to Zac.' }); return null;
}
const loadQueue = () => readJson(QUEUE_FILE, []);
const saveQueue = q => fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
const qClean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// Returns an error string when a post is not allowed to be Approved yet.
function approvalProblem(p) {
  const r = QUEUE_RULES[p.client];
  if (!p.caption) return 'Add the caption first.';
  if (!r) return '';
  if (r.captionBy && p.caption_by !== r.captionBy) return r.captionBy + ' has to write this caption first.';
  if (!p.approved_by || !r.approvers.includes(p.approved_by)) return 'Needs approval from ' + r.approvers.join(' or ') + '.';
  return '';
}
app.get('/api/queue', (req, res) => { if (!zacOnly(req, res)) return; res.json({ posts: loadQueue(), rules: QUEUE_RULES, clients: loadClients().filter(c => c.status !== 'proposal').map(c => ({ slug: c.slug, name: c.name })) }); });
app.post('/api/queue', (req, res) => {
  if (!zacOnly(req, res)) return;
  const b = req.body || {};
  const p = { id: 'q_' + crypto.randomBytes(5).toString('hex'), client: qClean(b.client, 60), platforms: qClean(b.platforms, 120), date: qClean(b.date, 10), time: qClean(b.time, 8), caption: qClean(b.caption, 5000), cta: qClean(b.cta, 300), media: qClean(b.media, 500), notes: qClean(b.notes, 500), caption_by: qClean(b.caption_by, 40), approved_by: '', status: 'waiting', created_at: new Date().toISOString() };
  if (!p.client) return res.status(400).json({ error: 'Pick a client.' });
  const q = loadQueue(); q.push(p); saveQueue(q); res.json({ post: p });
});
app.patch('/api/queue/:id', (req, res) => {
  if (!zacOnly(req, res)) return;
  const q = loadQueue(), p = q.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  for (const [k, n] of [['platforms', 120], ['date', 10], ['time', 8], ['caption', 5000], ['cta', 300], ['media', 500], ['notes', 500], ['caption_by', 40], ['approved_by', 40]]) if (b[k] !== undefined) p[k] = qClean(b[k], n);
  if (b.status !== undefined) {
    if (!['waiting', 'approved', 'held'].includes(b.status)) return res.status(400).json({ error: 'Bad status.' });
    if (b.status === 'approved') { const why = approvalProblem(p); if (why) return res.status(400).json({ error: why }); }
    p.status = b.status;
  } else if (p.status === 'approved' && approvalProblem(p)) p.status = 'waiting';   // an edit that breaks the approval drops it back
  saveQueue(q); res.json({ post: p });
});
app.delete('/api/queue/:id', (req, res) => { if (!zacOnly(req, res)) return; try { fs.rmSync(qDir(req.params.id), { recursive: true, force: true }); } catch {} saveQueue(loadQueue().filter(x => x.id !== req.params.id)); res.json({ ok: true }); });
// Approved posts only, as a CSV for Sprout's Bulk Post Import (Professional plan). One file per client,
// because the profiles are picked in Sprout's Import Posts window, not in the file. Columns are Sprout's own,
// case sensitive: date, time_24hr, message_text, link_url, public_image_url, tags. Rules from Sprout's help article:
// rows in date order, at least 10 minutes apart, no videos, images must be a public https link.
app.get('/api/queue/export.csv', (req, res) => {
  if (!zacOnly(req, res)) return;
  const client = String(req.query.client || '');
  if (!client) return res.status(400).json({ error: 'Pick one client. Sprout takes one file per set of profiles.' });
  const isVideo = m => /\.(mp4|mov|m4v|avi|webm)(\?|$)/i.test(m), isImgUrl = m => /^https:\/\/\S+$/i.test(m);
  const all = loadQueue().filter(p => p.client === client && !p.sent_at);
  const approved = all.filter(p => p.status === 'approved' && !approvalProblem(p));
  const skipped = [];
  const ok = approved.filter(p => {
    if ((p.files || []).some(f => !Q_IMG.test(f.name)) || (p.media && isVideo(p.media))) { skipped.push('video'); return false; }
    if (!(p.files || []).length && p.media && !isImgUrl(p.media)) { skipped.push('image link'); return false; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !/^\d{2}:\d{2}$/.test(p.time)) { skipped.push('date or time'); return false; }
    return true;
  }).sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
  let last = 0, nudged = 0;
  const rows = ok.map(p => {
    let t = Date.parse(p.date + 'T' + p.time + ':00Z') / 60000;
    if (t < last + 10) { t = last + 10; nudged++; }
    last = t; const d = new Date(t * 60000).toISOString();
    const msg = [p.caption, p.cta && !p.caption.includes(p.cta) ? p.cta : ''].filter(Boolean).join('\n\n');
    const link = (msg.match(/https?:\/\/[^\s)]+/) || [''])[0];
    const img = (p.files || []).find(f => Q_IMG.test(f.name)), pub = img ? String(process.env.CRM_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '') + '/qm/' + img.token + (img.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase() : (p.media || '');
    return [d.slice(5, 7) + '/' + d.slice(8, 10) + '/' + d.slice(0, 4), d.slice(11, 16), msg, link, pub, ''];
  });
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="sprout-' + client.replace(/[^a-z0-9-]/g, '') + '.csv"');
  res.setHeader('X-Held-Back', String(all.length - ok.length)); res.setHeader('X-Skipped', skipped.join(',')); res.setHeader('X-Nudged', String(nudged));
  res.send('﻿' + [['date', 'time_24hr', 'message_text', 'link_url', 'public_image_url', 'tags']].concat(rows).map(r => r.map(cell).join(',')).join('\n'));
});
// ---- Media for queued posts: videos and graphics kept here so the whole package is in one place ----
// Stored on the data disk, cleared 7 days after the post date. Images of approved posts get an unguessable public link
// so Sprout's bulk import can read them. Videos are never public.
const QMEDIA_DIR = path.join(DATA_DIR, 'queue_media');
const Q_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|m4v|webm)$/i, Q_IMG = /\.(jpe?g|png|gif|webp)$/i;
const qDir = id => path.join(QMEDIA_DIR, String(id).replace(/[^a-z0-9_]/gi, ''));
app.post('/api/queue/:id/media', express.raw({ type: '*/*', limit: '250mb' }), (req, res) => {
  if (!zacOnly(req, res)) return;
  const q = loadQueue(), p = q.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Not found.' });
  let name = ''; try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch {}
  name = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!Q_EXT.test(name)) return res.status(400).json({ error: 'Add a picture or a video (jpg, png, gif, webp, mp4, mov).' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'That file was empty.' });
  p.files = p.files || []; if (p.files.length >= 12 && !p.files.some(f => f.name === name)) return res.status(400).json({ error: 'Twelve files per post is the limit.' });
  try {
    fs.mkdirSync(qDir(p.id), { recursive: true }); fs.writeFileSync(path.join(qDir(p.id), name), req.body);
    p.files = p.files.filter(f => f.name !== name); p.files.push({ name, size: req.body.length, token: crypto.randomBytes(12).toString('hex'), at: new Date().toISOString() });
    saveQueue(q); res.json({ ok: true, files: p.files });
  } catch (e) { res.status(500).json({ error: 'Could not save the file: ' + String(e.message || e).slice(0, 100) }); }
});
app.get('/api/queue/:id/media/:file', (req, res) => {
  if (!zacOnly(req, res)) return;
  const p = loadQueue().find(x => x.id === req.params.id), f = p && (p.files || []).find(x => x.name === req.params.file); if (!f) return res.status(404).json({ error: 'Not found.' });
  res.download(path.join(qDir(p.id), f.name), f.name);
});
app.delete('/api/queue/:id/media/:file', (req, res) => {
  if (!zacOnly(req, res)) return;
  const q = loadQueue(), p = q.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Not found.' });
  const f = (p.files || []).find(x => x.name === req.params.file); if (f) { try { fs.unlinkSync(path.join(qDir(p.id), f.name)); } catch {} p.files = p.files.filter(x => x !== f); saveQueue(q); }
  res.json({ ok: true });
});
// Public image link for an APPROVED post only. The token is random and the link dies when the post is deleted or cleared.
app.get('/qm/:token', (req, res) => {
  const t = String(req.params.token || '').replace(/\.[a-z0-9]+$/i, '');
  for (const p of loadQueue()) { const f = (p.files || []).find(x => x.token === t); if (f) { if (p.status !== 'approved' || !Q_IMG.test(f.name)) break; res.set('Cache-Control', 'public, max-age=3600'); return res.sendFile(path.join(qDir(p.id), f.name)); } }
  res.status(404).end();
});
function queueCleanup() {
  try {
    const q = loadQueue(), cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10); let n = 0;
    for (const p of q) if ((p.files || []).length && ((p.date && p.date < cut) || (p.sent_at && p.sent_at.slice(0, 10) < cut))) { try { fs.rmSync(qDir(p.id), { recursive: true, force: true }); } catch {} p.files = []; n++; }
    if (n) { saveQueue(q); console.log('[queue] cleared media for', n, 'old posts'); }
  } catch (e) { console.error('[queue] cleanup failed -', e.message); }
}
setInterval(queueCleanup, 6 * 60 * 60 * 1000); setTimeout(queueCleanup, 60 * 1000);
app.post('/api/queue/:id/sent', (req, res) => { if (!zacOnly(req, res)) return; const q = loadQueue(), p = q.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Not found.' }); p.sent_at = new Date().toISOString(); saveQueue(q); res.json({ ok: true }); });
// ---------- Winners for ads: one simple list across clients ----------
app.get('/api/hq/winners-all', (req, res) => {
  if (!authedUser(req)) return res.status(401).json({ error: 'auth required' });
  const all = readJson(WINNERS_FILE, {}), names = Object.fromEntries(loadClients().map(c => [c.slug, c.name])), out = [];
  for (const [slug, list] of Object.entries(all)) for (const w of list) out.push({ ...w, slug, client: names[slug] || slug, ad_status: w.ad_status || 'new' });
  out.sort((a, b) => (a.at < b.at ? 1 : -1)); res.json({ winners: out.slice(0, 120), clients: loadClients().filter(c => ['active', 'seasonal'].includes(c.status)).map(c => ({ slug: c.slug, name: c.name })) });
});
app.post('/api/hq/winners/:slug/:id/ad', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const st = String((req.body && req.body.status) || ''); if (!['new', 'in_ads', 'not_a_fit'].includes(st)) return res.status(400).json({ error: 'Bad status.' });
  const all = readJson(WINNERS_FILE, {}), w = (all[req.params.slug] || []).find(x => x.id === req.params.id); if (!w) return res.status(404).json({ error: 'Not found.' });
  w.ad_status = st; w.ad_by = me.name; w.ad_at = new Date().toISOString(); fs.writeFileSync(WINNERS_FILE, JSON.stringify(all, null, 2)); res.json({ ok: true });
});

// ---------- Blogs for every client (written, copy and paste ready for Frank) ----------
const BLOGS_FILE = path.join(DATA_DIR, 'blogs.json');
const loadBlogs = () => readJson(BLOGS_FILE, []);
const saveBlogs = b => fs.writeFileSync(BLOGS_FILE, JSON.stringify(b, null, 2));
async function writeBlog(slug, topicHint) {
  const c = loadClients().find(x => x.slug === slug); if (!c) throw new Error('Unknown client.');
  const ctx = clientContext(slug, c), prior = loadBlogs().filter(b => b.slug === slug).map(b => b.title).slice(-30);
  const system = 'You write blog posts for a small business website. Copy rules: American spelling, no em dashes or en dashes, no hedges, no AI words (delve, elevate, unlock, seamless, robust, leverage, transform, game-changer), numbers beat adjectives, front-load the point, plain and specific. Never invent statistics, awards, prices, guarantees, licenses or customer names; use only facts in the client brain, or say nothing. Pick one topic of the form industry problem (what a real customer searches when something goes wrong or they are deciding), not service plus city. Return ONLY JSON: {"title":"","keyword":"","meta":"","body":"","cta":"","facts_to_verify":[""]}. "meta" is 150 characters or fewer. "body" is 700 to 900 words as plain text: an opening that answers the question in two sentences, then 4 to 6 sections each starting with a line "## Heading", short paragraphs, one clear call to action at the end. "cta" is one sentence with the client\'s real action. "facts_to_verify" lists any claim a human must confirm before publishing.';
  const user = 'CLIENT: ' + c.name + '\n' + (c.services && c.services.length ? 'SERVICES: ' + c.services.join(', ') + '\n' : '') + (topicHint ? 'TOPIC REQUESTED: ' + topicHint + '\n' : '') + 'ALREADY WRITTEN (do not repeat): ' + (prior.join(' | ') || 'none') + '\n\nCLIENT BRAIN AND RESEARCH:\n' + ctx.brain + '\n\nFRAMEWORKS:\n' + ctx.frameworks;
  const j = await aiJson(system, user, 4500);
  const clean = v => String(v || '').replace(/—|–/g, ',').trim();
  const b = { id: 'b_' + crypto.randomBytes(5).toString('hex'), slug, title: clean(j.title).slice(0, 160), keyword: clean(j.keyword).slice(0, 80), meta: clean(j.meta).slice(0, 170), body: clean(j.body).slice(0, 12000), cta: clean(j.cta).slice(0, 300), verify: (j.facts_to_verify || []).map(clean).slice(0, 10), status: 'ready', created_at: new Date().toISOString() };
  if (!b.title || !b.body) throw new Error('The AI returned an empty post. Try again.');
  const all = loadBlogs(); all.push(b); saveBlogs(all); return b;
}
app.get('/api/hq/blogs', (req, res) => {
  if (!authedUser(req)) return res.status(401).json({ error: 'auth required' });
  const names = Object.fromEntries(loadClients().map(c => [c.slug, c.name]));
  res.json({ blogs: loadBlogs().map(b => ({ ...b, client: names[b.slug] || b.slug })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 200), clients: loadClients().filter(c => ['active', 'seasonal'].includes(c.status)).map(c => ({ slug: c.slug, name: c.name })), busy: blogJob });
});
let blogJob = null;
app.post('/api/hq/blogs/:slug/write', async (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  try { const b = await writeBlog(String(req.params.slug).replace(/[^a-z0-9-]/g, ''), String((req.body && req.body.topic) || '').slice(0, 200)); res.json({ blog: b }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Admin: one post for every active client, one after another in the background.
app.post('/api/hq/blogs/write-all', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (blogJob && blogJob.running) return res.json({ ok: true, already: true });
  const slugs = loadClients().filter(c => ['active', 'seasonal'].includes(c.status) && !['nabs'].includes(c.slug)).map(c => c.slug);
  blogJob = { running: true, total: slugs.length, done: 0, failed: [] };
  (async () => { for (const sl of slugs) { try { await writeBlog(sl, ''); } catch (e) { blogJob.failed.push(sl + ': ' + String(e.message || e).slice(0, 120)); } blogJob.done++; } blogJob.running = false; })();
  res.json({ ok: true, total: slugs.length });
});
app.post('/api/hq/blogs/:id/status', (req, res) => {
  if (!authedUser(req)) return res.status(401).json({ error: 'auth required' });
  const st = String((req.body && req.body.status) || ''); if (!['ready', 'published'].includes(st)) return res.status(400).json({ error: 'Bad status.' });
  const all = loadBlogs(), b = all.find(x => x.id === req.params.id); if (!b) return res.status(404).json({ error: 'Not found.' });
  b.status = st; if (st === 'published') b.published_at = new Date().toISOString(); saveBlogs(all); res.json({ ok: true });
});

// ---------- Announcements: admin pushes alerts and reminders to Home ----------
const ANN_FILE = path.join(DATA_DIR, 'announcements.json');
const loadAnn = () => readJson(ANN_FILE, []);
const saveAnn = a => fs.writeFileSync(ANN_FILE, JSON.stringify(a, null, 2));
app.get('/api/announcements', (req, res) => {
  const u = authedUser(req); if (!u || u.legacy) return res.json({ items: [] });
  const now = new Date().toISOString().slice(0, 10), items = loadAnn().filter(a => !a.expires || a.expires >= now);
  if (u.role === 'admin') return res.json({ admin: true, items: items.map(a => ({ ...a, dismissed_count: Object.keys(a.dismissed || {}).length })), users: loadUsers().filter(x => x.active !== false).map(x => ({ id: x.id, name: x.name })) });
  res.json({ items: items.filter(a => (a.to === 'all' || (Array.isArray(a.to) && a.to.includes(u.id))) && !(a.dismissed || {})[u.id]).map(a => ({ id: a.id, text: a.text, level: a.level, at: a.at })) });
});
app.post('/api/announcements', (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const b = req.body || {}, text = String(b.text || '').replace(/—|–/g, ',').trim().slice(0, 500); if (!text) return res.status(400).json({ error: 'Write the message.' });
  const to = b.to === 'all' || !Array.isArray(b.to) ? 'all' : b.to.map(String).slice(0, 50);
  const a = { id: 'a_' + crypto.randomBytes(4).toString('hex'), text, to, level: b.level === 'alert' ? 'alert' : 'reminder', expires: /^\d{4}-\d{2}-\d{2}$/.test(b.expires || '') ? b.expires : '', at: new Date().toISOString(), by: me.name, dismissed: {} };
  const all = loadAnn(); all.unshift(a); saveAnn(all.slice(0, 200)); res.json({ ok: true, id: a.id });
});
app.post('/api/announcements/:id/dismiss', (req, res) => { const u = authedUser(req); if (!u || u.legacy) return res.status(400).json({ error: 'Sign in with your own login.' }); const all = loadAnn(), a = all.find(x => x.id === req.params.id); if (a) { a.dismissed = a.dismissed || {}; a.dismissed[u.id] = new Date().toISOString(); saveAnn(all); } res.json({ ok: true }); });
app.delete('/api/announcements/:id', (req, res) => { if (!requireAdmin(req, res)) return; saveAnn(loadAnn().filter(x => x.id !== req.params.id)); res.json({ ok: true }); });
app.get('/api/conversions/status', (req, res) => {
  if (!authedUser(req)) return res.status(401).json({ error: 'auth required' });
  const url = process.env.CONVERSION_CRM_URL || '';
  res.json({ live: /^https:\/\//.test(url), url: /^https:\/\//.test(url) ? url.replace(/\/$/, '') + '/app' : '' });
});
app.post('/api/admin/users/:id/pipeline', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = loadUsers(), u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Not found.' });
  u.pipeline = !!(req.body && req.body.pipeline); saveUsers(users); res.json({ ok: true, pipeline: u.pipeline });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/prospects', (_, res) => {
  const counts = {};
  for (const p of prospects) counts[p.status] = (counts[p.status] || 0) + 1;
  // Every full report inlined here made this response 16MB, which the dashboard pulled on each
  // load and which was enough to take the instance down (observed: a 502 followed by a restart).
  // The UI only reads audit_report.categories, so findings, checklist, summary and the raw scan
  // stay on the server and are fetched per lead when someone actually opens one.
  const slim = prospects.map(p => {
    const { audit_report, audit_scan, ...rest } = p;
    // The list renders only the name and the score. Each category also carries a two to three
    // sentence "why", which across seven categories and 1,413 leads was most of what remained.
    return audit_report
      ? { ...rest, audit_report: { categories: (audit_report.categories || []).map(c => ({ name: c.name, score: c.score })) } }
      : rest;
  });
  const wonValue = prospects.filter(p => p.status === 'won').reduce((s, p) => s + (Number(p.deal_value) || 0), 0);
  const openValue = prospects.filter(p => ['replied', 'booked'].includes(p.status)).reduce((s, p) => s + (Number(p.deal_value) || 0), 0);
  res.json({ prospects: slim, counts, sentToday: sentToday(), dailyCap: DAILY_CAP, team: TEAM, wonValue, openValue, callScripts: CALL_SCRIPTS });
});

// Team members who can be "on" a response. Configurable via TEAM env (comma list).
const TEAM = (process.env.TEAM || 'Michelle,Brad,Griffin,Lisa').split(',').map(s => s.trim()).filter(Boolean);

// Full record including the report, for the single lead being viewed.
app.get('/api/prospects/:id', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

app.patch('/api/prospects/:id', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const prevStatus = p.status;
  for (const k of ['email', 'subject', 'body', 'status', 'handled_by', 'contact_name', 'call_outcome']) {
    if (req.body[k] !== undefined) p[k] = req.body[k];
  }
  if (req.body.deal_value !== undefined) {
    const v = Number(String(req.body.deal_value).replace(/[^0-9.]/g, ''));
    p.deal_value = isNaN(v) ? 0 : v;
  }
  // stamp the moment a lead moves into a key stage, so the timeline is real
  if (req.body.status && req.body.status !== prevStatus) {
    const now = new Date().toISOString();
    const stamp = { replied: 'replied_at', booked: 'booked_at', won: 'won_at', lost: 'lost_at', rejected: 'rejected_at' };
    if (stamp[req.body.status] && !p[stamp[req.body.status]]) p[stamp[req.body.status]] = now;
  }
  p.updated_at = new Date().toISOString();
  save(prospects);
  res.json(p);
});

// Append a timestamped note to a lead's activity log
// One click on a held or failed lead: run their audit again and deliver it. Same path a prospect
// submission takes, so it re-applies the quality gate rather than force sending whatever we have.
app.post('/api/prospects/:id/rerun-audit', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const email = p.audit_email || p.email;
  const site = p.website;
  if (!email) return res.status(400).json({ error: 'no email on this lead, nothing to send to' });
  if (!site) return res.status(400).json({ error: 'no website on this lead, nothing to scan' });
  const jobId = crypto.randomBytes(12).toString('hex');
  enqueueAudit(jobId, {
    ref: p.id, email, goal: p.audit_goal || null,
    firstName: p.contact_first || '', lastName: p.contact_last || '',
    isTest: false, site, p, lookup: null,
    bizName: p.business || null, bizCity: p.city || null, bizCategory: p.category || null,
  });
  p.audit_rerun_at = new Date().toISOString();
  try { save(prospects); } catch (e) { console.error('[rerun] save failed -', e.message); }
  res.json({ started: true, jobId });
});

// Removing leads is irreversible, so it defaults to telling you what it WOULD remove and writes a
// timestamped backup of the whole file before it touches anything.
// Bulk import of a scraped list. Deduped on the address itself and on the domain, because the
// old list carried 153 duplicate records and drafting for a duplicate burns an Anthropic call to
// produce copy the send guard then throws away.
// A prospect typed in by hand. Lives in its own Manual column, is never drafted or emailed by the
// automation (do_not_email, status 'manual', source 'manual'), and joins the normal board once
// someone moves it to another stage.
app.post('/api/prospects/manual', (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const business = clip(b.business, 120);
  if (!business) return res.status(400).json({ error: 'Business name is required' });
  const city = clip(b.city, 60), phone = clip(b.phone, 40);
  const digits = phone.replace(/\D/g, '');
  const dupe = prospects.find(p => !p.internal && (
    (digits.length >= 7 && String(p.phone || '').replace(/\D/g, '') === digits) ||
    (String(p.business || '').trim().toLowerCase() === business.toLowerCase() && String(p.city || '').trim().toLowerCase() === city.toLowerCase())));
  if (dupe) return res.status(409).json({ error: `Already in the CRM: ${dupe.business || dupe.email} (${dupe.status})`, id: dupe.id });
  const nowIso = new Date().toISOString();
  const who = clip(b.handled_by, 40);
  const note = clip(b.note, 1000);
  const p = {
    id: 'M' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    business, category: clip(b.category, 60), city, phone,
    website: clip(b.website, 200), rating: '', reviews: '',
    email: normEmail(b.email), subject: '', body: '',
    notes: note ? [{ ts: nowIso, by: who || null, text: note }] : [],
    handled_by: who, deal_value: '', contact_first: '', contact_name: clip(b.contact_name, 80),
    status: 'manual', source: 'manual', do_not_email: true,
    created_at: nowIso, updated_at: nowIso,
  };
  prospects.push(p);
  save(prospects);
  res.json(p);
});

// Bulk version of the manual add, for a CSV of local businesses (title, categoryName, city,
// postalCode, phone, website, totalScore, reviewsCount). Same rules: Manual column, never emailed,
// skipped when the phone or the business name plus city is already in the CRM.
app.post('/api/prospects/manual/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 3000) : [];
  if (!rows.length) return res.status(400).json({ error: 'send { rows: [...] }' });
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const dig = s => String(s || '').replace(/\D/g, '');
  const phones = new Set(prospects.map(p => dig(p.phone)).filter(d => d.length >= 7));
  const names = new Set(prospects.map(p => String(p.business || '').trim().toLowerCase() + '|' + String(p.city || '').trim().toLowerCase()));
  const nowIso = new Date().toISOString();
  let added = 0, dupes = 0, bad = 0;
  for (const r of rows) {
    const business = clip(r.business || r.title, 120);
    if (!business) { bad++; continue; }
    const city = clip(r.city, 60), phone = clip(r.phone, 40), d = dig(phone);
    const key = business.toLowerCase() + '|' + city.toLowerCase();
    if ((d.length >= 7 && phones.has(d)) || names.has(key)) { dupes++; continue; }
    prospects.push({
      id: 'M' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase(),
      business, category: clip(r.category || r.categoryName, 60), city, phone,
      website: clip(r.website, 200), zip: clip(r.zip || r.postalCode, 12),
      rating: clip(r.rating || r.totalScore, 8), reviews: clip(r.reviews || r.reviewsCount, 10),
      email: '', subject: '', body: '', notes: [], handled_by: '', deal_value: '', contact_first: '', contact_name: '',
      status: 'manual', source: 'manual', do_not_email: true, created_at: nowIso, updated_at: nowIso,
    });
    if (d.length >= 7) phones.add(d);
    names.add(key); added++;
  }
  if (added) save(prospects);
  res.json({ added, dupes, bad, total: prospects.length });
});

app.post('/api/prospects/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'send { rows: [...] }' });
  const seenEmail = new Set(prospects.map(p => normEmail(p.email)).filter(Boolean));
  const seenDomain = new Set(prospects.map(p => normEmail(p.email).split('@')[1]).filter(Boolean));
  let added = 0, dupeEmail = 0, dupeDomain = 0, bad = 0;
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    const email = normEmail(r.email);
    if (!looksLikeEmail(email)) { bad++; continue; }
    if (seenEmail.has(email)) { dupeEmail++; continue; }
    const dom = email.split('@')[1];
    if (seenDomain.has(dom)) { dupeDomain++; continue; }
    prospects.push({
      id: 'B' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      business: String(r.business || '').slice(0, 120),
      category: String(r.trade || r.category || '').slice(0, 60),
      city: String(r.city || '').slice(0, 60),
      phone: String(r.phone || ''), website: String(r.website || ''),
      rating: String(r.rating || ''), reviews: String(r.reviews || ''),
      email, subject: '', body: '', notes: [], handled_by: '', deal_value: '',
      contact_first: '', contact_name: '',
      status: 'new', source: String(req.body.source || 'import'),
      created_at: nowIso, updated_at: nowIso,
    });
    seenEmail.add(email); seenDomain.add(dom); added++;
  }
  if (added) save(prospects);
  res.json({ added, dupeEmail, dupeDomain, bad, total: prospects.length });
});

app.post('/api/prospects/purge', (req, res) => {
  const { reason = 'unreachable', confirm = false } = req.body || {};
  const match = p => {
    if (p.source === 'callleads') return false;   // call leads have no email or site by design
    if (reason === 'unreachable') return !!p.prescan_error && !p.prescan_at && !p.audit_report;
    if (reason === 'no_email') return !(p.audit_email || p.email);
    return false;
  };
  const doomed = prospects.filter(match);
  const sample = doomed.slice(0, 15).map(p => ({ id: p.id, business: p.business, website: p.website, error: p.prescan_error }));
  if (!confirm) return res.json({ dryRun: true, reason, wouldRemove: doomed.length, remaining: prospects.length - doomed.length, sample });
  let backup = null;
  try {
    backup = DATA.replace(/\.json$/, '') + '.backup-' + Date.now() + '.json';
    fs.writeFileSync(backup, JSON.stringify(prospects, null, 2));
  } catch (e) { return res.status(500).json({ error: 'refusing to purge, backup failed: ' + e.message }); }
  const ids = new Set(doomed.map(p => p.id));
  const kept = prospects.filter(p => !ids.has(p.id));
  prospects.length = 0; prospects.push(...kept);
  save(prospects);
  console.warn('[purge] removed', ids.size, 'leads for', reason, '- backup at', backup);
  res.json({ removed: ids.size, remaining: prospects.length, backup, reason });
});

app.post('/api/prospects/:id/note', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty note' });
  if (!Array.isArray(p.notes)) p.notes = [];
  p.notes.push({ ts: new Date().toISOString(), by: (req.body?.by || '').trim() || null, text });
  p.updated_at = new Date().toISOString();
  save(prospects);
  res.json(p);
});

// Take ownership of a lead (or release it with who=''). Logged as a note so the history shows who had it.
app.post('/api/prospects/:id/claim', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const who = String(req.body?.who || '').trim().slice(0, 40);
  const prev = p.handled_by || '';
  if (who === prev) return res.json(p);
  p.handled_by = who;
  p.claimed_at = who ? new Date().toISOString() : null;
  if (!Array.isArray(p.notes)) p.notes = [];
  p.notes.push({ ts: new Date().toISOString(), by: who || prev || null, text: who ? (prev ? 'Taken over from ' + prev + ' by ' + who : 'Claimed by ' + who) : 'Released by ' + prev });
  p.updated_at = new Date().toISOString();
  save(prospects);
  res.json(p);
});

// Preview is derived, never authored: recomputing it here keeps it honest for leads drafted
// before this existed.
function inboxPreview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 110);
}
app.post('/api/prospects/:id/generate', async (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.source === 'callleads') return res.status(400).json({ error: 'call lead: we phone these, never email' });
  if (p.source === 'manual') return res.status(400).json({ error: 'manual prospect: added by hand, not part of the cold email sequence' });
  try {
    const d = await draftEmail(p);
    p.subject = d.subject; p.body = d.body; p.preview = inboxPreview(d.body);
    if (p.status === 'new') p.status = 'drafted';
    p.updated_at = new Date().toISOString();
    save(prospects);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-all', async (req, res) => {
  const limit = Number(req.body?.limit) || 25;
  const todo = prospects.filter(p => p.source !== 'callleads' && p.source !== 'manual' && (p.status === 'new' || (!p.body && p.status !== 'sent'))).slice(0, limit);
  let done = 0;
  for (const p of todo) {
    try {
      const d = await draftEmail(p);
      p.subject = d.subject; p.body = d.body; p.preview = inboxPreview(d.body);
      if (p.status === 'new') p.status = 'drafted';
      p.updated_at = new Date().toISOString();
      done++;
      save(prospects);
    } catch (e) { /* skip on error */ }
  }
  res.json({ drafted: done });
});

// THE living landing page — one URL for everyone. ?ref=<prospectId> for attribution.
// Public and unauthenticated by design: an opt-out that requires a login is not an opt-out.
app.get('/unsubscribe', (req, res) => {
  const { id, t } = req.query;
  const p = prospects.find(x => String(x.id) === String(id));
  let ok = false;
  if (p && t) {
    const want = Buffer.from(unsubToken(p.id));
    const got = Buffer.from(String(t));
    ok = got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  if (ok && !p.unsubscribed_at) {
    p.unsubscribed_at = new Date().toISOString();
    p.status = 'rejected';           // already halts the follow-up sequence
    p.updated_at = p.unsubscribed_at;
    if (!Array.isArray(p.notes)) p.notes = [];
    p.notes.push({ ts: p.unsubscribed_at, by: null, text: 'Unsubscribed via email link.' });
    save(prospects);
    console.log('[unsub]', p.id, p.business);
  }
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Unsubscribed</title><body style="margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1a2b4c">
<div style="max-width:520px;margin:14vh auto;padding:40px;background:#fff;border-radius:14px;text-align:center">
<h1 style="margin:0 0 12px;font-size:26px">You're unsubscribed</h1>
<p style="margin:0;color:#5a6478">${ok ? 'We will not contact you again. Sorry for the interruption.' : 'That link is no longer valid. Reply STOP to any of our emails and we will remove you.'}</p>
<p style="margin:22px 0 0;font-size:13px;color:#8b93a1">${COMPANY} &middot; ${COMPANY_ADDRESS}</p>
</div></body>`);
});

// Readable counterpart to /go?ref=..&t=.. . The trailing 8 hex characters are the signature; the
// name in front of them is there so the link previews as a report rather than as a redirect.
app.get(['/report/:slug', '/r/:slug'], (req, res) => {
  const m = String(req.params.slug || '').match(/([0-9a-f]{8})$/i);
  if (!m) return res.redirect('/go');
  const short = m[1].toLowerCase();
  const p = prospects.find(x => reportToken(x.id).slice(0, 8) === short);
  if (!p) return res.redirect('/go');
  // Record the visit HERE, on the server, rather than trusting a browser call.
  // This link is the only one in a cold email, so arriving on it IS the click.
  // /api/track was written to do this and nothing ever called it, so every
  // prospect who read their own audit stayed at status "sent", which made the
  // warmest people in the pipeline invisible. Server side cannot be blocked by
  // an ad blocker, a privacy setting or a mail client prefetching nothing.
  recordReportVisit(p, req);
  res.send(renderLandingPage(p.id, reportToken(p.id)));
});

// Shared by the report link and by /go?ref=, so both entry points attribute.
function recordReportVisit(p, req) {
  if (!p) return;
  // Mail scanners fetch links to check them. A hit with no browser-shaped user
  // agent is not a person, and counting it would flip prospects to "clicked"
  // the moment a corporate filter looked at the mail.
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  if (!/Mozilla|Chrome|Safari|Firefox|Edg/i.test(ua)) return;
  const now = new Date().toISOString();
  let changed = false;
  if (!p.viewed_at) { p.viewed_at = now; changed = true; }
  if (!p.clicked_at) { p.clicked_at = now; changed = true; }
  if (p.status === 'sent') { p.status = 'clicked'; changed = true; }
  if (changed) {
    p.updated_at = now;
    events.push({ type: 'click', ref: p.id, ts: now });
    try { saveMetrics(); } catch {}
    try { save(prospects); } catch {}
    console.log('[attribution] report read by', p.business || p.email, '->', p.status);
  }
}

app.get('/go', (req, res) => {
  const ref = req.query.ref;
  if (ref) {
    const p = prospects.find(x => x.id === ref);
    if (p && reportToken(p.id) === req.query.t) recordReportVisit(p, req);
  }
  res.send(renderLandingPage(ref, req.query.t));
});

// Every prospect report is a public URL carrying a frank, named assessment of somebody else's
// business. Indexed, those become search results about a local company, published by us, that the
// owner never asked for. The page itself is noindex; this is the belt to that pair of braces, and
// it also keeps the team CRM out of the index.
app.get('/robots.txt', (_, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /go?ref=',
    'Disallow: /r/',
    'Disallow: /report/',
    'Disallow: /api/',
    'Disallow: /login',
    'Disallow: /unsubscribe',
    'Allow: /go',
    'Disallow: /',
  ].join('\n') + '\n');
});

// Preview the branded PDF audit design (sample data mirroring a real scan)
app.get('/api/audit-pdf-preview', async (_, res) => {
  const sampleScan = { url: 'https://thebeautybarn.com', https: true, mobileViewport: true, title: 'The Beauty Barn Med Spa | Canton GA', titleLen: 35,
    description: null, descriptionLen: 0, h1Count: 2, wordCount: 420, schemaLocalBusiness: false, canonical: true,
    hasPhone: true, hasEmailLink: false, hasForm: true, hasBooking: true, hasCta: true, hasLiveChat: false, hasNewsletter: false, napAddress: true,
    analytics: false, analyticsType: null, fbPixel: false, googleAdsTag: false, hasVideo: false, imgCount: 22, imgMissingAlt: 14,
    ogTitle: true, ogImage: false, mixedContent: false, socials: { facebook: 'facebook.com/beautybarn', instagram: 'instagram.com/beautybarn' } };
  const samplePs = { performance: 38, seo: 82, accessibility: 71, bestPractices: 75, lcp: 4100, cls: 0.02, tbt: 620,
    lcpLabel: '4.1 s', clsLabel: '0.02', tbtLabel: '620 ms' };
  const sample = {
    headline: 'Where The Beauty Barn is quietly losing booked appointments',
    overallVerdict: 'A strong reputation held back by a slow, under-tracked website that is not converting its traffic.',
    categories: [
      { name: 'Website & Speed', score: 44, why: 'Mobile PageSpeed came in at 38 out of 100 with a Largest Contentful Paint of 4.1 seconds, well past the 2.5 second mark, so the page feels slow on a phone. HTTPS and mobile layout are in place, which keeps this from scoring lower.' },
      { name: 'Getting Found (SEO)', score: 52, why: 'The page is missing a meta description and has two H1 tags instead of one, and there is no local business schema, so Google has less to work with. The title is present and sized reasonably, which helps.' },
      { name: 'Converting Visitors', score: 68, why: 'Click to call, a lead form, and online booking are all present, which is strong. There is no live chat and no email capture, so visitors who are not ready to book have no lighter way to raise a hand.' },
      { name: 'Local Visibility', score: 82, why: 'A 4.9 rating from 820 reviews is elite for a med spa in Canton and puts real trust behind the name. Missing local business schema and inconsistent address markup keep it from fully translating into search visibility.' },
      { name: 'Tracking & Data', score: 20, why: 'No analytics, no Meta pixel, and no Google Ads tag were detected, so there is no way to see where visitors come from or to retarget them. Every dollar of future marketing would be flying blind.' },
      { name: 'Social & Content', score: 40, why: 'Facebook and Instagram are linked but TikTok and YouTube are absent, and no video was found on the site. For a med spa, short before and after video is the single biggest driver of new bookings, and that channel is missing.' },
    ],
    findings: [
      { title: 'You are not tracking a single visitor', detail: 'No analytics or pixel means you cannot see what is working or retarget the people who visited and did not book. This quietly caps the return on any ad or content spend before it starts.', impact: 'High' },
      { title: 'A 4.1 second mobile load is bleeding bookings', detail: 'Most of your traffic is on a phone, and pages this slow lose a large share of visitors before they ever see your offer. That is booked revenue lost at the front door.', impact: 'High' },
      { title: 'Missing meta description costs you clicks from Google', detail: 'Google auto generates a weak snippet, so people searching for a med spa in Canton scroll past you to a competitor with a sharper listing.', impact: 'Medium' },
      { title: 'Elite reviews, no video engine', detail: '820 five star reviews prove people love you, but with no video and thin social, new clients never feel that before they book elsewhere.', impact: 'Medium' },
      { title: 'No local business schema', detail: 'Without structured data, search engines are guessing at your hours, location, and service, which weakens how you show up in local results.', impact: 'Low' },
    ],
    quickWins: ['Add a meta description to the homepage', 'Install Google Analytics 4 and the Meta pixel this week', 'Compress the hero images to cut load time', 'Add alt text to the 14 images missing it'],
    summary: 'The reputation is already there. The gap is a slow, invisible website that is not capturing or measuring the demand you have earned. That is exactly the kind of thing we fix.',
    estimate: '',
  };
  const sampleGbp = { found: true, rating: 4.9, reviews: 820, latestReviewDays: 12, hasHours: true, websiteOnGbp: true, phoneOnGbp: true, photos: 10, hasDescription: false, primaryCategory: 'spa', status: 'OPERATIONAL' };
  sample.checklist = buildChecklist(sampleScan, samplePs, sampleGbp);
  sample.pagespeed = samplePs;
  const pdf = await buildAuditPDF('The Beauty Barn', sample, `${CALENDLY}?utm_content=preview`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="growth-audit-sample.pdf"');
  res.send(pdf);
});

// Tracking beacon from the landing page (view / click)
app.post('/api/track', (req, res) => {
  const { type, ref } = req.body || {};
  if (!['view', 'click'].includes(type)) return res.status(400).end();
  events.push({ type, ref: ref || null, ts: new Date().toISOString() });
  saveMetrics();
  // reflect engagement on the matching prospect for the pipeline
  const p = ref && prospects.find(x => x.id === ref);
  if (p) {
    if (type === 'view' && !p.viewed_at) p.viewed_at = new Date().toISOString();
    if (type === 'click') { p.clicked_at = new Date().toISOString(); if (p.status === 'sent') p.status = 'clicked'; }
    save(prospects);
  }
  res.status(204).end();
});

// Calendly webhook — fires when someone books (invitee.created) or cancels.
// Set this URL as a webhook in Calendly. We attribute via utm_content=<prospectId>.
const NOTIFY_FALLBACK = 'zac@openheartmediaco.com';
// Internal notifications go to the owner alone by default. Every audit, audit failure, booking and
// canary alert used to fan out to the whole NOTIFY_EMAILS list, so a single systemic problem (the
// API credit balance hitting zero, which degrades every run) paged four people repeatedly for one
// thing one person was already fixing. Deliberately ignores NOTIFY_EMAILS rather than depending on
// that env var being edited, because a Render env change needs a manual deploy to take effect.
// Set NOTIFY_SOLO=false to put the whole team back on internal notifications.
// This does NOT touch prospect-facing mail: audit reports, follow-ups and outreach are addressed to
// the prospect and are unaffected.
const NOTIFY_SOLO = process.env.NOTIFY_SOLO !== 'false';
const OWNER_EMAIL = process.env.OWNER_EMAIL || NOTIFY_FALLBACK;
const NOTIFY = (NOTIFY_SOLO ? OWNER_EMAIL : (process.env.NOTIFY_EMAILS || NOTIFY_FALLBACK))
  .split(',').map(s => s.trim()).filter(Boolean);
// Two lists, because two different jobs. NOTIFY carries the system alarms (canary, failures, held
// audits) and stays with whoever fixes things. SALES carries the commercial events (a booking, a
// completed audit) and has to include whoever is actually selling: Michelle sends every one of
// these emails and hosts the discovery call, so a booking landing only in Zac's inbox is a lead
// waiting on a forward.
const SALES = (process.env.SALES_EMAILS || `${OWNER_EMAIL},michelle@openheartmediaco.com`)
  .split(',').map(s => s.trim()).filter(Boolean);
console.log('[notify] alarms ->', NOTIFY.join(', '), '| sales ->', SALES.join(', '));
console.log(NOTIFY_SOLO
  ? `[notify] solo mode: internal notifications go to ${NOTIFY.join(', ')} only. Set NOTIFY_SOLO=false to notify the whole team.`
  : `[notify] team mode: internal notifications go to ${NOTIFY.join(', ')}.`);
// Silence here used to be indistinguishable from success.
function notifyTargets(what) {
  if (!process.env.SENDGRID_API_KEY) { console.warn('[notify] no SENDGRID_API_KEY, cannot send', what); return []; }
  if (!NOTIFY.length) { console.error('[notify] NOBODY to notify about', what, '- set NOTIFY_EMAILS'); return []; }
  return NOTIFY;
}
async function notifyBooking(info) {
  if (!notifyTargets('a booking').length) return;
  const text = `New discovery call booked.\n\n`
    + `Name:  ${info.name || 'n/a'}\n`
    + `Email: ${info.email || 'n/a'}\n`
    + `When:  ${info.start || 'n/a'}\n`
    + `From business: ${info.business || 'unknown'}\n`
    + `Event: ${info.eventName || 'Discovery call'}\n`;
  try {
    await sgMail.sendMultiple({
      to: SALES,
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `📅 New call booked${info.business ? ' — ' + info.business : ''}`,
      text,
    });
  } catch (e) { console.error('[notify] failed:', e.message); }
}

app.post('/api/calendly-webhook', async (req, res) => {
  res.status(200).end(); // ack fast
  try {
    const ev = req.body || {};
    if (ev.event !== 'invitee.created') return;
    const payload = ev.payload || {};
    const ref = (payload.tracking && (payload.tracking.utm_content || payload.tracking.salesforce_uuid)) || null;
    const p = ref && prospects.find(x => x.id === ref);
    const info = {
      name: payload.name || (payload.first_name ? `${payload.first_name} ${payload.last_name || ''}`.trim() : null),
      email: payload.email,
      start: payload.scheduled_event?.start_time || payload.event?.start_time || null,
      eventName: payload.scheduled_event?.name || 'Discovery call',
      business: p ? p.business : null,
    };
    events.push({ type: 'booked', ref, ts: new Date().toISOString(), info });
    saveMetrics();
    if (p) { p.status = 'booked'; p.booked_at = new Date().toISOString(); save(prospects); }
    await notifyBooking(info);
    console.log('[booking] booked:', info.business || info.email);
  } catch (e) { console.error('[calendly-webhook]', e.message); }
});

// A degraded report is the deterministic fallback: real numbers, but none of the written analysis
// that makes the audit worth reading. Sending that to a prospect spends the one impression we get
// on our weakest possible artifact, so it is held and worked by hand instead of delivered.
async function notifyAuditHeld(p, email, report, reason) {
  if (!notifyTargets('a held audit').length) return;
  const text = `HELD, not sent to the prospect.\n\n`
    + `A real lead completed the audit form, but the report came back degraded so it was not emailed to them.\n\n`
    + `Business: ${p?.business || 'unknown'}\n`
    + `Contact:  ${p?.contact_name || ''} <${email}>\n`
    + `Website:  ${p?.website || 'n/a'}\n`
    + `Reason:   ${reason}\n\n`
    + `Scores from the scan (these are accurate, only the written report is missing):\n`
    + (report.categories || []).map(c => `  ${c.name}: ${c.score}/100${c.measured === false ? ' (not measured)' : ''}`).join('\n')
    + `\n\nThe lead is in the CRM under "Audit held". Fix the cause, re-run their scan, then send it.`;
  try {
    await sgMail.sendMultiple({ to: NOTIFY, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `⚠️ Audit HELD, needs a resend${p?.business ? ': ' + p.business : ''}`, text });
  } catch (e) { console.error('[notifyAuditHeld]', e.message); }
}

async function notifyAudit(p, email, report, pdf) {
  if (!notifyTargets('a completed audit').length) return;
  const text = `New audit completed (hot lead).\n\n`
    + `Business: ${p?.business || 'unknown'}\n`
    + `Email:    ${email}\n`
    + `Website:  ${p?.website || 'n/a'}\n`
    + `Overall growth score: ${overallScore(report)}/100\n`
    + (report.categories || []).map(c => `  ${c.name}: ${c.score}/100`).join('\n') + `\n\n`
    + (report.findings || []).map(f => `- [${f.impact || ''}] ${f.title}`).join('\n')
    + `\n\nThey saw this and got a Book-a-call CTA. Follow up fast.`;
  const msg = { to: SALES, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject: `🔥 Audit completed${p?.business ? ': ' + p.business : ''}`, text };
  if (pdf) msg.attachments = [{ content: pdf.toString('base64'), filename: 'audit-' + (p?.business || 'lead').replace(/[^a-z0-9]/gi, '-') + '.pdf', type: 'application/pdf', disposition: 'attachment' }];
  try { await sgMail.sendMultiple(msg); } catch (e) { console.error('[notifyAudit]', e.message); }
}

// Email the branded PDF audit to the prospect who filled out the form
async function sendAuditToProspect(to, business, report, pdf, bookingUrl) {
  if (!process.env.SENDGRID_API_KEY || !to) return;
  const overall = overallScore(report);
  const biz = business || 'your business';
  const topGap = report.findings?.[0]?.title || 'a few fixable gaps';
  // Plain-text fallback (the raw URL lives here, out of sight of most readers)
  // The form collects a first name, so the delivery email should use it rather than opening "Hi,".
  const greet = report.recipientFirst ? `Hi ${report.recipientFirst},` : 'Hi,';
  const text = `${greet}\n\nHere is your free growth audit for ${biz}, attached as a PDF.\n\nYour overall growth score came in at ${overall} out of 100. The biggest thing costing you leads right now: ${topGap}.\n\nWant us to help you close these gaps? Book a free 30 minute discovery call:\n${bookingUrl}\n\nMichelle\nOpen Heart Media`;
  // Branded HTML with a clean button instead of a raw link
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f1a30;line-height:1.55">
  <div style="background:#1a2b4c;border-radius:12px 12px 0 0;padding:22px 26px;border-bottom:3px solid #df3131">
    <div style="color:#fff;font-weight:800;font-size:16px;letter-spacing:.3px">OPEN HEART MEDIA</div>
    <div style="color:#8ea0c0;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Growth Audit</div>
  </div>
  <div style="border:1px solid #e4e9f2;border-top:0;border-radius:0 0 12px 12px;padding:26px">
    <p style="margin:0 0 14px">${esc(greet)}</p>
    <p style="margin:0 0 14px">Here is your free growth audit for <b>${esc(biz)}</b>, attached as a PDF.</p>
    <p style="margin:0 0 6px">Your overall growth score:</p>
    <div style="font-size:34px;font-weight:800;color:#1a2b4c;margin:0 0 14px">${overall}<span style="font-size:16px;color:#8a97ad">/100</span></div>
    <p style="margin:0 0 20px">The biggest thing costing you leads right now: <b>${esc(topGap)}</b>.</p>
    <p style="margin:0 0 18px">Want us to help you close these gaps? Grab a free 30 minute discovery call. No pitch, no pressure.</p>
    <a href="${bookingUrl}" style="display:inline-block;background:#df3131;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 30px;border-radius:10px">Book your discovery call</a>
    <p style="margin:26px 0 0;color:#68758c;font-size:13px">Michelle<br/>Open Heart Media</p>
  </div>
</div>`;
  try {
    await sgMail.send({ to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `your growth audit for ${biz}`, text, html,
      attachments: [{ content: pdf.toString('base64'), filename: 'growth-audit.pdf', type: 'application/pdf', disposition: 'attachment' }] });
  } catch (e) { console.error('[audit-email]', e.message); }
}

// Run the live scan + audit when a prospect fills out the form.
// TEST MODE: pass {"test": true}. Nothing is emailed to the prospect, no team blast,
// no prospect record is touched. If AUDIT_TEST_EMAIL is set, a single copy goes only there.
// ---------- Audit job queue ----------
// The full audit pipeline (multi page crawl + PageSpeed + Places + two Claude calls + PDF) runs
// 60 to 120 seconds. Running that inside the prospect's HTTP request meant any browser, proxy or
// CDN timeout surfaced as a generic "scan failed" even when the scan was fine. The request now
// returns a job id immediately and the page polls for the result, so a slow scan can never look
// like a broken one.
const auditJobs = new Map();
const JOB_TTL_MS = 45 * 60 * 1000;
const jobSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, j] of auditJobs) if (now - j.updatedAt > JOB_TTL_MS) auditJobs.delete(id);
}, 5 * 60 * 1000);
if (jobSweeper.unref) jobSweeper.unref();

// ---------- Concurrency control ----------
// Each audit makes Claude + Google calls and holds a full page crawl in memory. Letting an
// unbounded number run at once on one small instance is how you get rate limits and OOM kills
// during a send burst, so scans queue past a small cap instead of all starting at once.
const MAX_CONCURRENT_AUDITS = Number(process.env.MAX_CONCURRENT_AUDITS || 3);
let activeAudits = 0;
const auditQueue = [];
function pumpAuditQueue() {
  while (activeAudits < MAX_CONCURRENT_AUDITS && auditQueue.length) {
    const next = auditQueue.shift();
    const job = auditJobs.get(next.jobId);
    if (!job || job.state !== 'queued') continue;
    activeAudits++;
    job.state = 'running'; job.stage = 'Starting your scan'; job.updatedAt = Date.now(); persistJobs();
    runAuditJob(next.jobId, next.opts).finally(() => { activeAudits--; pumpAuditQueue(); });
  }
}
function enqueueAudit(jobId, opts) {
  auditJobs.set(jobId, {
    state: 'queued', stage: 'Waiting to start', startedAt: Date.now(), updatedAt: Date.now(),
    result: null, error: null,
    // Kept so the job can be rebuilt after a restart. The prospect record is deliberately not
    // stored: it is re-resolved from `ref` so a resumed job cannot write back a stale copy.
    resume: opts.silent ? null : {
      ref: opts.ref || null, email: opts.email, goal: opts.goal || null,
      firstName: opts.firstName, lastName: opts.lastName, isTest: !!opts.isTest,
      site: opts.site, bizName: opts.bizName, bizCity: opts.bizCity, bizCategory: opts.bizCategory,
    },
  });
  auditQueue.push({ jobId, opts });
  persistJobs();
  pumpAuditQueue();
}

// ---------- Job durability across restarts ----------
// The job map is in memory, so a deploy or a crash mid-scan used to leave the prospect polling a
// job id that no longer existed. They saw "that scan expired" after already handing over their
// details, which is the worst possible moment to look broken. Jobs are mirrored to disk and
// anything unfinished is re-queued on boot.
const JOBS_FILE = path.join(DATA_DIR, 'audit_jobs.json');
let jobsDirty = false;
function persistJobs() { jobsDirty = true; }
function flushJobs() {
  if (!jobsDirty) return;
  jobsDirty = false;
  const out = [];
  for (const [id, j] of auditJobs) {
    if (!j.resume) continue;                       // canaries are throwaway
    out.push([id, j]);
  }
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(out)); }
  catch (e) { console.error('[audit] could not persist jobs -', e.message); }
}
const jobFlusher = setInterval(flushJobs, 2000);
if (jobFlusher.unref) jobFlusher.unref();

function restoreJobs() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(saved)) return;
  let resumed = 0, kept = 0;
  for (const [id, j] of saved) {
    if (!j || !j.resume) continue;
    if (Date.now() - (j.updatedAt || 0) > JOB_TTL_MS) continue;
    if (j.state === 'done' || j.state === 'error') {
      auditJobs.set(id, j);                        // finished: keep the result pollable
      kept++;
      continue;
    }
    // Was queued or running when the process went away, so the work never completed. The email is
    // the last step of the job, which means an interrupted run has not contacted anyone yet and
    // re-running it cannot duplicate a send.
    const r = j.resume;
    const p = !r.isTest && r.ref ? prospects.find(x => x.id === r.ref) : null;
    const lookup = r.isTest && r.ref ? prospects.find(x => x.id === r.ref) : null;
    auditJobs.set(id, { ...j, state: 'queued', stage: 'Resuming your scan', updatedAt: Date.now() });
    auditQueue.push({ jobId: id, opts: { ...r, p, lookup } });
    resumed++;
  }
  if (resumed || kept) console.log('[audit] restored', kept, 'finished and re-queued', resumed, 'interrupted scans');
  if (resumed) pumpAuditQueue();
}

// ---------- Bulk pre-scan ----------
// Running the audit live while a prospect watches puts a 2 minute wait, and every dependency we do
// not control, directly in front of the one person we are trying to impress. Building every report
// before outreach removes that entirely: the email carries real findings, the link opens a report
// that already exists, and a site that fails is a row to fix quietly rather than a broken page in
// front of a buyer. It also gives the copy something specific to say per business.
const prescanState = {
  running: false, stop: false, total: 0, done: 0, ok: 0, failed: 0,
  startedAt: null, finishedAt: null, current: null, lastError: null,
};

async function prescanOne(p) {
  const jobId = 'pre-' + crypto.randomBytes(6).toString('hex');
  auditJobs.set(jobId, { state: 'running', stage: 'prescan', startedAt: Date.now(), updatedAt: Date.now(), result: null, error: null });
  try {
    await runAuditJob(jobId, {
      ref: p.id, email: null, goal: null, firstName: '', lastName: '',
      isTest: false, prescan: true, site: p.website, p,
      bizName: p.business, bizCity: p.city, bizCategory: p.category,
    });
    return auditJobs.get(jobId)?.state === 'done';
  } finally {
    auditJobs.delete(jobId);                       // never persisted, never polled by a prospect
  }
}

// A full rescan used to mean "every lead, right now", held only in memory. Render restarted this
// instance about an hour into a twelve hour run and the job vanished, and auto-resume did nothing
// because it only looked for leads with no report at all, which by then was none of them. Any run
// long enough to matter will outlive the process, so the target set is now derived from the data
// itself: rescan anything whose last scan predates the cutoff. A restart resumes automatically,
// and leads already redone are skipped instead of repeated.
// The cutoff was one-directional ("anything last scanned BEFORE this"), which fits a fix rolling
// forward. It does not fit an outage: when the Anthropic credit balance ran out mid-run, every
// lead scanned AFTER that moment got a deterministic fallback narrative instead of a written
// report. Those are the leads that need redoing, and they are the newest ones, so `before` alone
// can only select them by also reselecting the ~950 that are already good. `after` is the other
// half of the same window, and both persist so a restart still resumes the right set.
const RESCAN_STALE_FILE = path.join(DATA_DIR, 'rescan_before.json');
function rescanWindow() {
  try {
    const j = JSON.parse(fs.readFileSync(RESCAN_STALE_FILE, 'utf8'));
    return { before: j.before || null, after: j.after || null, until: j.set_at || null };
  } catch { return { before: null, after: null, until: null }; }
}
function rescanCutoff() { return rescanWindow().before; }
function setRescanCutoff(iso, after) {
  if (iso || after) fs.writeFileSync(RESCAN_STALE_FILE, JSON.stringify({ before: iso || null, after: after || null, set_at: new Date().toISOString() }));
  else { try { fs.unlinkSync(RESCAN_STALE_FILE); } catch {} }
}
function prescanTargets({ force = false, mailableOnly = false } = {}) {
  const { before, after, until } = rescanWindow();
  return prospects.filter(p => {
    if (p.source === 'callleads') return false;
    if (!p.website || !/^https?:\/\//i.test(p.website)) return false;
    // Rescan only the leads the daily sender can actually reach, in the order it will reach them.
    if (mailableOnly && (p.status !== 'new' || p.unsubscribed_at || !isMailableBusiness(p.email))) return false;
    if (force) return true;
    if (!p.prescan_at && !p.prescan_failed_at) return true;          // never scanned
    const last = [p.prescan_at, p.prescan_failed_at].filter(Boolean).sort().pop() || '';
    if (before && last < before) return true;                         // scanned before the fix
    // The outage window needs BOTH ends. `before` is self closing: redoing a lead stamps it with
    // now, which is later than the cutoff, so it drops out of the set. `after` is not, because a
    // fresh timestamp is still later than the outage and the lead reselects itself forever. The
    // moment the instruction was written is the upper bound, so anything redone since is done.
    if (after && last > after && (!until || last < until)) return true;
    return false;
  });
}

async function runPrescan({ limit = 0, force = false, mailableOnly = false, only = null } = {}) {
  if (prescanState.running) return prescanState;
  let queue = Array.isArray(only) ? only : prescanTargets({ force, mailableOnly });
  if (limit > 0) queue = queue.slice(0, limit);
  Object.assign(prescanState, {
    running: true, stop: false, total: queue.length, done: 0, ok: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, current: null, lastError: null,
  });
  console.log('[prescan] starting on', queue.length, 'sites');

  const workers = Math.max(1, MAX_CONCURRENT_AUDITS);
  let cursor = 0;
  const worker = async () => {
    while (!prescanState.stop) {
      const p = queue[cursor++];
      if (!p) return;
      prescanState.current = p.business || p.website;
      try {
        const ok = await prescanOne(p);
        ok ? prescanState.ok++ : prescanState.failed++;
      } catch (e) {
        prescanState.failed++;
        prescanState.lastError = `${p.business || p.website}: ${e.message}`;
        console.error('[prescan]', p.id, e.message);
      }
      prescanState.done++;
      if (prescanState.done % 25 === 0) {
        console.log(`[prescan] ${prescanState.done}/${prescanState.total} (${prescanState.ok} ok, ${prescanState.failed} failed)`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  prescanState.running = false;
  prescanState.current = null;
  prescanState.finishedAt = new Date().toISOString();
  // The standing instruction has done its job once nothing is stale. Clearing it stops a restart
  // from re-queueing a rescan that already finished.
  if (!prescanState.stop && rescanCutoff() && !prescanTargets().length) {
    setRescanCutoff(null);
    console.log('[prescan] rescan complete, cutoff cleared');
  }
  console.log(`[prescan] finished: ${prescanState.ok} ok, ${prescanState.failed} failed of ${prescanState.total}`);
  return prescanState;
}

// ---------- Per IP rate limit ----------
// /api/audit is public and expensive. This stops a bot or a stuck retry loop from burning the
// Claude budget, without getting in the way of a real prospect running one or two scans.
const AUDIT_RATE_MAX = Number(process.env.AUDIT_RATE_MAX || 5);
const AUDIT_RATE_WINDOW_MS = 60 * 60 * 1000;
const auditHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (auditHits.get(ip) || []).filter(t => now - t < AUDIT_RATE_WINDOW_MS);
  if (hits.length >= AUDIT_RATE_MAX) { auditHits.set(ip, hits); return true; }
  hits.push(now); auditHits.set(ip, hits);
  if (auditHits.size > 5000) for (const [k, v] of auditHits) if (!v.some(t => now - t < AUDIT_RATE_WINDOW_MS)) auditHits.delete(k);
  return false;
}

// ---------- Audit outcome log (reliability visibility) ----------
// Without this the only way to know the audit is failing is for someone to complain, which is
// exactly how the last outage was found. Rolling log survives restarts.
const AUDIT_LOG = path.join(DATA_DIR, 'audit_log.json');
function loadAuditLog() { try { return JSON.parse(fs.readFileSync(AUDIT_LOG, 'utf8')); } catch { return []; } }
let auditLog = loadAuditLog();
function recordAuditOutcome(entry) {
  auditLog.push({ ts: new Date().toISOString(), ...entry });
  if (auditLog.length > 500) auditLog = auditLog.slice(-500);
  try { fs.writeFileSync(AUDIT_LOG, JSON.stringify(auditLog, null, 2)); } catch (e) { console.error('[auditlog]', e.message); }
}
function auditHealth() {
  const day = auditLog.filter(e => Date.now() - new Date(e.ts).getTime() < 24 * 60 * 60 * 1000 && !e.canary);
  const ok = day.filter(e => e.ok).length;
  const canaries = auditLog.filter(e => e.canary).slice(-10);
  return {
    last24h: { attempts: day.length, succeeded: ok, failed: day.length - ok, degraded: day.filter(e => e.degraded).length,
               successRate: day.length ? Math.round((ok / day.length) * 100) : null },
    inFlight: activeAudits, queued: auditQueue.length,
    lastCanary: canaries.length ? canaries[canaries.length - 1] : null,
    recentFailures: auditLog.filter(e => !e.ok).slice(-5),
  };
}

// Hard ceiling on any single stage so one hung dependency cannot stall the whole pipeline.
function withTimeout(promise, ms, labelStr) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${labelStr} exceeded ${ms}ms`)), ms); }),
  ]);
}
// Optional enrichment: log and continue with a fallback instead of failing the audit.
async function softStage(promise, ms, labelStr, fallback = null) {
  try { return await withTimeout(promise, ms, labelStr); }
  catch (e) { console.warn('[audit] degraded, continuing without', labelStr, '-', e.message); return fallback; }
}

// If Claude is unavailable or returns unparseable JSON we still owe the prospect a report. This
// derives one straight from the deterministic pass/fail checklist we already computed.
function fallbackReport(p, scan, ps, gbp, aio, answers) {
  const checklist = buildChecklist(scan, ps, gbp, aio);
  // null means "no measurable items", which is different from a low score. Handing back 50 put a
  // made-up number on a category we knew nothing about, which is the exact fault this whole pass
  // exists to remove.
  const scoreOf = names => {
    const items = checklist.filter(g => names.includes(g.group)).flatMap(g => g.items).filter(i => i.ok !== null && i.ok !== undefined);
    if (!items.length) return null;
    return Math.round((items.filter(i => i.ok === true).length / items.length) * 100);
  };
  const cat = (name, score, why) => score === null
    ? { name, score: 0, measured: false, why: 'Not measured on this run, so it is left out of the overall score.' }
    : { name, score, why };
  const perf = ps && typeof ps.performance === 'number' ? ps.performance : null;
  const categories = [
    { name: 'Website & Speed', score: perf !== null ? perf : (scoreOf(['Foundation & Speed']) ?? 0),
      measured: perf !== null,
      why: perf !== null ? 'Scored from the live technical scan of the site.'
        : 'Page speed could not be measured on this run, so this covers only the secure connection and mobile checks. Speed is not included in the overall score.' },
    cat('Getting Found (SEO)', scoreOf(['Getting Found (SEO)']), 'Scored from on page SEO signals found during the crawl.'),
    cat('Converting Visitors', scoreOf(['Turning Visitors Into Leads']), 'Scored from the contact, form, booking and call to action signals found across the pages scanned.'),
    cat('Local Visibility', scoreOf(['Google Business Profile']), 'Scored from the live Google Business Profile lookup.'),
    cat('Tracking & Data', scoreOf(['Tracking & Ad Readiness']), 'Scored from the analytics and advertising tags detected on the site.'),
    cat('Social & Content', scoreOf(['Content, Media & Social']), 'Scored from the social profiles linked from the site and the media found on it.'),
    cat('AI Search Presence (AIO)', aio && typeof aio.score === 'number' ? aio.score : scoreOf(['AI Search Presence (AIO)']), 'Scored from AI crawler access, structured data and a live check of whether AI assistants recognize this business.'),
  ];
  const failed = checklist.flatMap(g => g.items.filter(i => i.ok === false).map(i => ({ group: g.group, label: i.label })));
  const findings = failed.slice(0, 6).map(f => ({
    title: f.label,
    detail: `Our scan flagged this under ${f.group}. Left as is, it quietly costs you enquiries that never reach you.`,
    impact: 'Medium',
  }));
  return {
    headline: `Where ${p.business || 'your business'} is losing customers online`,
    overallVerdict: 'Your scan completed and found real, fixable gaps.',
    categories,
    findings: findings.length ? findings : [{ title: 'Solid foundation', detail: 'The scan did not surface major technical failures. The opportunity is in visibility and content.', impact: 'Low' }],
    quickWins: failed.slice(0, 4).map(f => `Fix: ${f.label}`),
    summary: `${answers.firstName || 'Thanks'}, here is what our scan found across your website, your Google presence and your visibility in AI search. The items below are the ones costing you the most.`,
    estimate: 'Closing these gaps typically recovers enquiries that are currently reaching competitors instead.',
    checklist,
    pagespeed: ps || null,
    speedMeasured: !!ps,
    limited: !!scan.limited,
    degraded: true,
  };
}

// Absolute ceiling on a single audit. Individual stage timeouts rely on setTimeout firing on
// schedule, which is not guaranteed if the event loop is busy. A soak run against 20 real
// prospect sites produced two jobs that ran 19 and 31 minutes despite every stage being
// nominally capped, and neither reproduced in isolation or under concurrency. Rather than guess
// at the cause, the remaining budget is now recomputed before every stage so total runtime is
// bounded by construction: once the budget is gone we ship the deterministic report we can
// already build instead of continuing to wait.
const MAX_JOB_MS = Number(process.env.MAX_AUDIT_JOB_MS || 6 * 60 * 1000);

async function runAuditJob(jobId, opts) {
  const job = auditJobs.get(jobId);
  const setStage = s => { if (job) { job.stage = s; job.updatedAt = Date.now(); persistJobs(); } };
  const { ref, email, goal, firstName, lastName, isTest, site, p, lookup, bizName, bizCity, bizCategory } = opts;
  const t0 = Date.now();
  const deadline = t0 + MAX_JOB_MS;
  const left = () => deadline - Date.now();
  // Every stage gets the smaller of its own budget and whatever is left of the job budget.
  const budget = (want, min = 1) => Math.max(min, Math.min(want, left()));
  const timings = {};
  const timed = async (name, fn) => { const s = Date.now(); try { return await fn(); } finally { timings[name] = Date.now() - s; } };
  try {
    // PageSpeed is the long pole at roughly 50s, and it does not need anything the scan produces:
    // Lighthouse follows redirects itself, so the submitted URL is enough. Starting it here instead
    // of after the scan overlaps it with the scan, the Google Business lookup, the AI probe and the
    // written report, which takes it off the critical path almost entirely. Kicked off before the
    // first await so it is genuinely running during the scan, with the rejection handler attached
    // immediately so a failure can never surface as an unhandled rejection.
    const psPromise = softStage(runPageSpeed(site), budget(PAGESPEED_TIMEOUT_MS + 15000), 'PageSpeed');

    setStage('Scanning your website');
    const scan = await timed('scan', () => withTimeout(scanWebsite(site), budget(75000), 'website scan'));
    if (!scan.reachable && !scan.title) {
      // Being refused is not the same as being down. Host firewalls routinely block datacenter IPs
      // (azerplumb.com answers us with a 403 from Render and a 200 from a laptop), while Google's
      // Lighthouse crawls from Google's own ranges and gets through. If it did, we still hold real
      // rendered measurements of the page and owe the prospect a report built on them, rather than
      // telling the owner of a perfectly healthy site that we could not load it.
      const psEarly = await psPromise;
      if (!psEarly) throw new Error(`could not reach ${site}`);
      console.warn('[audit] crawl refused for', site, '- continuing on Lighthouse data alone');
      scan.limited = true;
      scan.host = scan.host || (() => { try { return new URL(site.startsWith('http') ? site : 'https://' + site).host.replace(/^www\./, ''); } catch { return null; } })();
    }

    // Falls back to the site's own title so an organic visitor still gets a named report and a
    // real Google Business lookup instead of both being skipped.
    const resolvedBiz = bizName || deriveBusinessName(scan);

    setStage('Checking speed, Google and AI visibility');
    // allSettled, not all: an outage at Google or Anthropic must degrade the report, never kill it.
    const [ps, gbp, aio] = await timed('enrich', () => Promise.all([
      psPromise,
      softStage(scanGBP(resolvedBiz, bizCity, scan.host), budget(25000), 'Google Business Profile'),
      softStage(scanAIO(resolvedBiz, bizCity, bizCategory, scan), budget(45000), 'AI visibility'),
    ]));

    // Fold rendered-Chrome evidence back into the scan before anything is scored, written or saved,
    // so the checklist, the report, the PDF and the stored record all agree on one set of facts.
    mergeRenderedSignals(scan, ps);

    setStage('Writing your report');
    let report;
    const buildFallback = () => fallbackReport(p || lookup || { business: resolvedBiz }, scan, ps, gbp, aio, { firstName });
    if (left() < 20000) {
      // Not enough budget left to be worth asking the model. Ship what we already know.
      console.warn('[audit] job', jobId, 'out of budget before report generation, using deterministic fallback');
      report = buildFallback();
    } else {
      try {
        report = await timed('report', () => withTimeout(generateAuditReport(p || lookup || {}, scan, ps, gbp, { goal, firstName }, aio), budget(90000), 'report generation'));
      } catch (e) {
        console.warn('[audit] report generation failed once -', e.message, left() > 30000 ? '- retrying' : '- no budget to retry');
        try {
          if (left() < 30000) throw new Error('no budget for retry');
          report = await timed('report_retry', () => withTimeout(generateAuditReport(p || lookup || {}, scan, ps, gbp, { goal, firstName }, aio), budget(90000), 'report generation retry'));
        } catch (e2) {
          console.error('[audit] report generation failed twice, using deterministic fallback -', e2.message);
          report = buildFallback();
          report.degradedReason = e2.message;
        }
      }
    }
    report.recipientFirst = firstName;
    report.recipientName = `${firstName} ${lastName}`.trim();

    setStage('Building your PDF');
    const bookingUrl = `${CALENDLY}?utm_content=${p?.id || ''}`;
    let pdf = null;
    try { pdf = await timed('pdf', () => withTimeout(buildAuditPDF(resolvedBiz || 'your business', report, bookingUrl), budget(30000), 'PDF build')); }
    catch (e) { console.error('[audit] pdf failed, continuing without attachment -', e.message); }

    // The prospect already has their result at this point. Email delivery must never fail the job.
    if (opts.silent) {
      // Canary run: exercise the whole pipeline, email nobody, write nothing.
      job.result = { canary: true, report, business: resolvedBiz };
    } else if (opts.prescan) {
      // Built ahead of outreach, so there is nobody waiting and nobody to email. Deliberately does
      // NOT set status or audited_at: those mean the prospect asked for an audit and received it,
      // and the follow-up copy branches on them to decide whether to say "did you get a chance to
      // run it". A pre-scanned lead has not seen anything yet and is still cold.
      if (p) {
        p.audit_report = report;
        p.audit_scan = { pagespeed: ps, gbp, aio, socials: scan.socials, deadSocials: scan.deadSocials, reachable: scan.reachable, pagesScanned: scan.pagesScanned };
        p.prescan_at = new Date().toISOString();
        p.prescan_error = null;
        p.updated_at = p.prescan_at;
        try { save(prospects); } catch (e) { console.error('[prescan] save failed -', e.message); }
      }
      job.result = { prescan: true, report, business: resolvedBiz };
    } else if (isTest) {
      const testTo = process.env.AUDIT_TEST_EMAIL || 'zac@openheartmediaco.com';
      if (pdf && process.env.SENDGRID_API_KEY) await softStage(sendAuditToProspect(testTo, resolvedBiz, report, pdf, bookingUrl), 30000, 'test email');
      job.result = { test: true, emailedTo: (pdf && process.env.SENDGRID_API_KEY) ? testTo : null, report, business: resolvedBiz };
    } else {
      // Quality gate on the one thing the prospect actually receives.
      const heldReason = report.degraded
        ? (report.degradedReason || 'the written report fell back to deterministic text')
        : null;
      const nowIso = new Date().toISOString();
      if (p) {
        p.audit_email = email; p.audit_goal = goal || null; p.audit_report = report;
        p.contact_first = firstName; p.contact_last = lastName; p.contact_name = `${firstName} ${lastName}`.trim();
        p.audit_scan = { pagespeed: ps, gbp, aio, socials: scan.socials, deadSocials: scan.deadSocials, reachable: scan.reachable, pagesScanned: scan.pagesScanned };
        if (heldReason) {
          // Deliberately NOT 'audited': that status means they received their report, and the
          // follow-up copy branches on it to ask whether they had a chance to read it.
          p.status = 'audit_held'; p.audit_held_at = nowIso; p.audit_held_reason = heldReason;
        } else {
          p.status = 'audited'; p.audited_at = nowIso;
          p.audit_held_at = null; p.audit_held_reason = null;
        }
        p.updated_at = nowIso;
        try { save(prospects); } catch (e) { console.error('[audit] save failed -', e.message); }
      }
      events.push({ type: 'audit', ref: ref || null, ts: nowIso, email, business: p?.business || null, held: !!heldReason });
      try { saveMetrics(); } catch {}
      if (heldReason) {
        console.warn('[audit] HELD, not emailing prospect', email, '-', heldReason);
        await softStage(notifyAuditHeld(p, email, report, heldReason), 30000, 'held notification');
      } else {
        await softStage(notifyAudit(p, email, report, pdf), 30000, 'team notification');
        if (pdf) await softStage(sendAuditToProspect(email, p?.business || resolvedBiz, report, pdf, bookingUrl), 30000, 'prospect email');
      }
      job.result = { report, business: p?.business || null, held: !!heldReason };
    }
    job.state = 'done';
    job.stage = 'Done';
    job.updatedAt = Date.now();
    persistJobs(); flushJobs();
    recordAuditOutcome({ ok: true, ms: Date.now() - t0, site, business: resolvedBiz, degraded: !!report.degraded, noPagespeed: !ps, timings, canary: !!opts.silent });
    // Per stage timings make a slow job diagnosable after the fact instead of a mystery.
    console.log('[audit] job', jobId, 'completed in', Date.now() - t0, 'ms for', resolvedBiz || site, report.degraded ? '(degraded report)' : '', JSON.stringify(timings));
  } catch (e) {
    console.error('[audit] job', jobId, 'failed at stage:', job?.stage, `(${Date.now() - t0}ms in)`, '-', e.message, '\n', e.stack);
    const unreachable = /could not reach/i.test(e.message);
    recordAuditOutcome({ ok: false, ms: Date.now() - t0, site, business: bizName, stage: job?.stage || null, error: e.message, timings, canary: !!opts.silent });
    // A prospect who filled the form is a real lead even when the scan fails. Flag the record so
    // the team can follow up by hand instead of the lead disappearing.
    if (opts.prescan && p) {
      // Nobody is waiting on this one, so a failure is a data problem to review in bulk later, not
      // an incident. Recorded on the lead and left out of the outreach list rather than alerted on.
      p.prescan_error = e.message;
      p.prescan_failed_at = new Date().toISOString();
      p.updated_at = p.prescan_failed_at;
      try { save(prospects); } catch {}
    } else if (!opts.silent && !isTest && p) {
      p.status = 'audit_failed';
      p.audit_error = e.message;
      p.audit_failed_at = new Date().toISOString();
      p.updated_at = p.audit_failed_at;
      try { save(prospects); } catch {}
      if (!unreachable) await softStage(notifyAuditFailure(p, e, job?.stage), 20000, 'failure alert');
    }
    if (job) {
      job.state = 'error';
      persistJobs();
      job.error = unreachable
        ? `We could not load ${site}. Please check the address and try again.`
        : 'The scan hit a snag on our side. Your details are saved and our team will follow up shortly.';
      job.updatedAt = Date.now();
    }
  }
}

// Tell the team the moment a real prospect's scan fails, so the lead can be worked manually.
async function notifyAuditFailure(p, err, stage) {
  if (!process.env.SENDGRID_API_KEY) return;
  const to = NOTIFY;
  await sgMail.send({
    to,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject: `Audit failed for ${p.business || p.website || 'a prospect'} - follow up needed`,
    html: `<p>A prospect completed the audit form but the scan failed, so they did not receive a report.</p>
<p><b>Business:</b> ${esc(p.business || 'n/a')}<br/>
<b>Contact:</b> ${esc(p.contact_name || 'n/a')}<br/>
<b>Email:</b> ${esc(p.audit_email || p.email || 'n/a')}<br/>
<b>Website:</b> ${esc(p.website || 'n/a')}<br/>
<b>Failed at:</b> ${esc(stage || 'unknown')}<br/>
<b>Reason:</b> ${esc(err.message)}</p>
<p>The lead is saved in the CRM with status <b>audit_failed</b>. Please follow up directly.</p>`,
  });
}

// ---------- Canary: prove the audit still works, on a schedule ----------
// The previous outage was found because a person happened to try it. This runs the real pipeline
// against a known site every hour and alerts the team on the transition into and out of failure.
const CANARY_SITE = process.env.CANARY_SITE || 'openheartmediaco.com';
let canaryFailures = 0;
let canaryDegraded = 0;
async function runCanary() {
  const jobId = 'canary-' + crypto.randomBytes(6).toString('hex');
  auditJobs.set(jobId, { state: 'running', stage: 'canary', startedAt: Date.now(), updatedAt: Date.now(), result: null, error: null });
  await runAuditJob(jobId, {
    ref: null, email: null, goal: 'canary', firstName: 'Canary', lastName: 'Check',
    isTest: true, silent: true, site: CANARY_SITE, p: null, lookup: null,
    bizName: 'Open Heart Media', bizCity: null, bizCategory: 'marketing agency',
  });
  const job = auditJobs.get(jobId);
  const ok = job && job.state === 'done';
  const rep = job?.result?.report || null;
  // A degraded run still counts as a success: the prospect gets a report, nothing throws, and the
  // health endpoint stays green. That is exactly how weeks of audits went out with a fabricated
  // speed score and no AI-written report while every alarm stayed silent. A report built on
  // missing inputs is an incident, so it now gets treated as one.
  const degradedWhy = !ok ? null
    : rep?.degraded ? `the written report fell back to the deterministic one: ${rep.degradedReason || 'the AI report call failed twice'}`
    : rep?.speedMeasured === false ? 'Google PageSpeed returned no data, so Website and Speed is scored without a speed measurement'
    : null;
  auditJobs.delete(jobId);
  if (ok && !degradedWhy) {
    if (canaryFailures >= 2 || canaryDegraded >= 2) {
      console.log('[canary] recovered after', canaryFailures, 'failures and', canaryDegraded, 'degraded runs');
      await softStage(alertTeam('Audit is working again', `The prospect audit recovered and is completing normally against ${CANARY_SITE}.`), 20000, 'canary recovery alert');
    }
    canaryFailures = 0;
    canaryDegraded = 0;
  } else if (ok) {
    canaryDegraded++;
    console.error('[canary] DEGRADED', canaryDegraded, 'in a row -', degradedWhy);
    if (canaryDegraded === 2) {
      await softStage(alertTeam('Audit scores are degraded', `The hourly check against ${CANARY_SITE} completed, but the report is being built on incomplete data ${canaryDegraded} runs in a row.<br/><br/>Reason: ${esc(degradedWhy)}<br/><br/>Prospects are still receiving reports, but the scores in them are not fully measured. Worth fixing before sending more cold email.`), 20000, 'canary degraded alert');
    }
  } else {
    canaryFailures++;
    console.error('[canary] FAILED', canaryFailures, 'in a row -', job?.error);
    // Alert on the second consecutive failure so one blip from Google does not page the team.
    if (canaryFailures === 2) {
      await softStage(alertTeam('Prospect audit is failing', `The hourly check against ${CANARY_SITE} has failed ${canaryFailures} times in a row.<br/><br/>Reason: ${esc(job?.error || 'unknown')}<br/><br/>Cold email prospects landing on go.openheartmediaco.com may not be getting their report. Worth checking before sending more.`), 20000, 'canary alert');
    }
  }
}
// ---------- Watching for replies ----------
// The footer promises "reply STOP and we will not contact you again", and until now that promise
// was kept by a person remembering to read the inbox. Nothing set a lead to 'replied' either, so
// somebody who wrote back "not interested" still collected follow ups on days 3, 7 and 10. The
// follow up loop already skips 'replied' and 'rejected'; it was never told when to.
//
// This watches Michelle's mailbox rather than intercepting her mail. SendGrid's Inbound Parse
// would need an MX record on a subdomain and would take delivery of the reply, so a human answer
// would arrive as a forward instead of a normal thread. Reading the mailbox leaves every reply
// exactly where she expects it and lets the CRM draw its own conclusions.
const GMAIL_TOKEN_FILE = path.join(DATA_DIR, 'gmail_token.json');
const GMAIL_SEEN_FILE = path.join(DATA_DIR, 'gmail_seen.json');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GMAIL_REDIRECT = process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_URL}/api/gmail/callback`;

function gmailToken() { try { return JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')); } catch { return null; } }
function saveGmailToken(t) { fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(t)); }
function gmailSeen() { try { return new Set(JSON.parse(fs.readFileSync(GMAIL_SEEN_FILE, 'utf8'))); } catch { return new Set(); } }
function saveGmailSeen(set) {
  // Bounded: only recent ids matter, and the query never looks back more than a few days anyway.
  const arr = [...set].slice(-4000);
  try { fs.writeFileSync(GMAIL_SEEN_FILE, JSON.stringify(arr)); } catch {}
}

async function gmailAccessToken() {
  const t = gmailToken();
  if (!t || !t.refresh_token) return null;
  if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60000) return t.access_token;
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: t.refresh_token, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (!r.ok) { console.error('[gmail] refresh failed', r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  saveGmailToken({ ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

// Step one of consent. Behind the team login, so only someone already in the CRM can start it.
app.get('/api/gmail/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).send('GOOGLE_CLIENT_ID is not set on this service.');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', GMAIL_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');       // force a refresh_token even on a repeat consent
  res.redirect(u.toString());
});

app.get('/api/gmail/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code returned.');
  const stUid = readGmailState(String(req.query.state || ''));
  if (stUid) return personalGmailCallback(String(code), stUid, res);
  try {
    const body = new URLSearchParams({
      code: String(code), client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GMAIL_REDIRECT, grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    const j = await r.json();
    if (!j.refresh_token) return res.status(400).send('Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.');
    saveGmailToken({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 });
    console.log('[gmail] connected');
    res.send('<body style="font:16px -apple-system,sans-serif;padding:40px">Gmail connected. Replies will now stop the follow up sequence automatically. You can close this tab.</body>');
  } catch (e) { res.status(500).send('Failed: ' + e.message); }
});


// ---------- Personal Gmail: each person connects their own, we show mail from client addresses ----------
const GMAIL_USERS_FILE = path.join(DATA_DIR, 'gmail_users.json');
function gUsers() { return readJson(GMAIL_USERS_FILE, {}); }
function saveGUsers(o) { fs.writeFileSync(GMAIL_USERS_FILE, JSON.stringify(o), { mode: 0o600 }); }
function signGmailState(uid) { const body = `u.${uid}.${Date.now()}`; return body + '.' + crypto.createHmac('sha256', SESS_SECRET).update(body).digest('hex').slice(0, 32); }
function readGmailState(st) {
  const m = /^u\.(u_[a-f0-9]+)\.(\d+)\.([a-f0-9]{32})$/.exec(st || ''); if (!m) return null;
  const want = crypto.createHmac('sha256', SESS_SECRET).update(`u.${m[1]}.${m[2]}`).digest('hex').slice(0, 32);
  if (!crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(want)) || Date.now() - +m[2] > 15 * 60e3) return null;
  return m[1];
}
app.get('/api/me/gmail/connect', (req, res) => {
  const me = authedUser(req);
  if (!me || me.legacy) return res.status(400).send('Sign in with your own email first (not the shared password).');
  if (!GOOGLE_CLIENT_ID) return res.status(400).send('Google is not set up on this service yet (GOOGLE_CLIENT_ID).');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', GOOGLE_CLIENT_ID); u.searchParams.set('redirect_uri', GMAIL_REDIRECT);
  u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly');
  u.searchParams.set('access_type', 'offline'); u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', signGmailState(me.id)); if (me.email) u.searchParams.set('login_hint', me.email);
  res.redirect(u.toString());
});
async function personalGmailCallback(code, uid, res) {
  try {
    const body = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GMAIL_REDIRECT, grant_type: 'authorization_code' });
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body }); const j = await r.json();
    if (!j.refresh_token) return res.status(400).send('Google did not return access. Remove the app at myaccount.google.com/permissions and try again.');
    const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + j.access_token } }); const pj = await pr.json().catch(() => ({}));
    const all = gUsers(); all[uid] = { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, account: pj.emailAddress || '' };
    saveGUsers(all); mailCache.delete(uid);
    res.send(`<body style="font:16px -apple-system,sans-serif;padding:40px;max-width:520px">Your Gmail is connected. You can close this tab and go back to the CRM, then open <b>Mail</b>.<br><br><a href="${CRM_URL}/">Open the CRM</a></body>`);
  } catch (e) { res.status(500).send('Failed: ' + e.message); }
}
async function userGmailToken(uid) {
  const all = gUsers(), t = all[uid]; if (!t || !t.refresh_token) return null;
  if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60000) return t.access_token;
  const body = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (!r.ok) { console.error('[gmail-user] refresh failed', r.status); return null; }
  const j = await r.json(); all[uid] = { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 }; saveGUsers(all); return j.access_token;
}
const mailCache = new Map();
const AUTOMATED = /(no-?reply|donotreply|do-not-reply|notifications?@|mailer-daemon|postmaster|bounce|newsletter|marketing@|updates@|support@(?:google|facebook|meta))/i;
async function mailFor(uid) {
  const hit = mailCache.get(uid); if (hit && Date.now() - hit.at < 180e3) return hit.data;
  const tok = await userGmailToken(uid); if (!tok) return { connected: false };
  const auth = { Authorization: 'Bearer ' + tok };
  const clients = loadClients().filter(c => c.status !== 'internal');
  const byDom = new Map(), byAddr = new Map(), terms = [];
  for (const c of clients) for (const d of (c.domains || [])) { const x = String(d).toLowerCase().trim(); if (!x) continue; if (x.includes('@')) { byAddr.set(x, c); terms.push(x); } else { byDom.set(x, c); terms.push('@' + x); } }
  const base = 'newer_than:14d -in:sent -in:chats -in:drafts';
  const lists = [`${base}`]; if (terms.length) lists.push(`${base} from:(${terms.join(' OR ')})`);
  const ids = new Map();
  for (const q of lists) {
    const lr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${q === base ? 60 : 50}&q=${encodeURIComponent(q)}`, { headers: auth });
    if (!lr.ok) throw new Error('Gmail list failed ' + lr.status);
    for (const m of ((await lr.json()).messages || [])) ids.set(m.id, m.threadId);
  }
  const arr = [...ids.entries()], msgs = [];
  for (let i = 0; i < arr.length; i += 10) {
    await Promise.all(arr.slice(i, i + 10).map(async ([id, threadId]) => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`, { headers: auth });
      if (!r.ok) return; const d = await r.json();
      const h = Object.fromEntries((d.payload && d.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(h.from || ''); const addr = String((m ? m[2] : h.from) || '').toLowerCase().trim(); const name = (m && m[1].trim()) || addr;
      msgs.push({ id, threadId, mid: (h['message-id'] || '').trim(), addr, name, subject: h.subject || '(no subject)', snippet: d.snippet || '', date: Number(d.internalDate) || 0, unread: (d.labelIds || []).includes('UNREAD') });
    }));
  }
  const own = /@openheartmediaco\.com$/i; const matched = [], unm = new Map(), team = [];
  for (const x of msgs) {
    const dom = x.addr.split('@')[1] || ''; if (!dom) continue;
    let c = byAddr.get(x.addr) || byDom.get(dom); if (!c) for (const [k, v] of byDom) if (dom.endsWith('.' + k)) { c = v; break; }
    if (c) { matched.push({ id: x.id, thread: x.threadId, mid: x.mid, name: x.name, addr: x.addr, subject: x.subject, snippet: x.snippet.slice(0, 160), date: x.date, unread: x.unread, client: { slug: c.slug, name: c.name } }); continue; }
    if (own.test(x.addr)) { if (!AUTOMATED.test(x.addr)) team.push({ id: x.id, thread: x.threadId, name: x.name, addr: x.addr, subject: x.subject, snippet: x.snippet.slice(0, 160), date: x.date, unread: x.unread }); continue; }
    if (FREEMAIL.test(dom) || AUTOMATED.test(x.addr)) continue;
    const u = unm.get(dom) || { domain: dom, count: 0, example: x.subject, from: x.name }; u.count++; unm.set(dom, u);
  }
  matched.sort((a, b) => b.date - a.date); team.sort((a, b) => b.date - a.date);
  const data = { connected: true, team: team.slice(0, 25), team_unread: team.filter(t => t.unread).length, account: (gUsers()[uid] || {}).account || '', matched: matched.slice(0, 60), unread: matched.filter(m => m.unread).length,
    unmatched: [...unm.values()].sort((a, b) => b.count - a.count).slice(0, 12) };
  mailCache.set(uid, { at: Date.now(), data }); return data;
}
app.get('/api/me/mail', async (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  if (me.legacy) return res.json({ connected: false, legacy: true });
  try { res.json({ ...(await mailFor(me.id)), configured: !!GOOGLE_CLIENT_ID }); } catch (e) { res.json({ connected: !!gUsers()[me.id], error: e.message.slice(0, 160), configured: !!GOOGLE_CLIENT_ID }); }
});

const calCache = new Map();
const CAL_PREFS_FILE = path.join(DATA_DIR, 'cal_prefs.json');
app.post('/api/me/calendar/prefs', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const p = readJson(CAL_PREFS_FILE, {}); p[me.id] = (Array.isArray(req.body && req.body.hidden) ? req.body.hidden : []).map(x => String(x).slice(0, 200)).slice(0, 50);
  fs.writeFileSync(CAL_PREFS_FILE, JSON.stringify(p)); calCache.delete(me.id); res.json({ ok: true });
});
app.get('/api/me/calendar', async (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  if (me.legacy) return res.json({ connected: false, legacy: true });
  const hit = calCache.get(me.id); if (hit && Date.now() - hit.at < 180e3) return res.json(hit.data);
  try {
    const tok = await userGmailToken(me.id);
    if (!tok) return res.json({ connected: false, configured: !!GOOGLE_CLIENT_ID });
    const auth = { Authorization: 'Bearer ' + tok };
    const cl = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', { headers: auth });
    if (cl.status === 403 || cl.status === 401) {
      const body = await cl.text().catch(() => '');
      const apiOff = /accessNotConfigured|has not been used|is disabled|SERVICE_DISABLED/i.test(body);
      return res.json({ connected: true, needsCalendar: true, apiOff, detail: body.slice(0, 200) });
    }
    if (!cl.ok) throw new Error('Calendar list failed ' + cl.status);
    const allCals = ((await cl.json()).items || []).filter(c => c.selected !== false && !/holiday/i.test(c.id || '') && !/^transferred from/i.test(c.summary || '')).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    const hidden = new Set((readJson(CAL_PREFS_FILE, {})[me.id] || []));
    const cals = allCals.filter(c => !hidden.has(c.id));
    const now = new Date(), end = new Date(now.getTime() + 14 * 864e5);
    const events = [];
    for (const c of cals.slice(0, 12)) {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events`);
      u.searchParams.set('timeMin', new Date(now.getTime() - 3 * 36e5).toISOString()); u.searchParams.set('timeMax', end.toISOString());
      u.searchParams.set('singleEvents', 'true'); u.searchParams.set('orderBy', 'startTime'); u.searchParams.set('maxResults', '25');
      const r = await fetch(u, { headers: auth }); if (!r.ok) continue;
      for (const ev of ((await r.json()).items || [])) {
        if (ev.status === 'cancelled') continue;
        events.push({ id: ev.id + c.id, title: ev.summary || '(no title)', start: ev.start.dateTime || ev.start.date, end: ev.end && (ev.end.dateTime || ev.end.date), allDay: !ev.start.dateTime, where: (ev.location || '').slice(0, 80), link: ev.htmlLink, cal: c.primary ? 'Mine' : (c.summary || '').trim(), color: c.backgroundColor || '' });
      }
    }
    // Clean up: drop placeholder blocks, pull a trailing "(Project)" out of the title, and merge copies of the same event.
    const clean = [];
    for (const ev of events) {
      if (/^\s*busy\b/i.test(ev.title)) continue;
      const m = /^(.*?)\s*\(([^()]{2,60})\)\s*$/.exec(ev.title); if (m && m[1].trim()) { ev.title = m[1].trim(); ev.project = m[2].trim(); }
      clean.push(ev);
    }
    const norm = e => e.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (e.allDay ? String(e.start).slice(0, 10) : new Date(e.start).toISOString().slice(0, 16));
    const byKey = new Map();
    for (const ev of clean) { const k = norm(ev), cur = byKey.get(k); if (!cur) byKey.set(k, ev); else if (cur.cal !== 'Mine' && ev.cal === 'Mine') byKey.set(k, { ...ev, project: ev.project || cur.project }); else if (!cur.project && ev.project) cur.project = ev.project; }
    const uniq = [...byKey.values()].sort((a, b) => { const ka = a.allDay ? String(a.start).slice(0, 10) + 'T00:00' : new Date(a.start).toISOString(), kb = b.allDay ? String(b.start).slice(0, 10) + 'T00:00' : new Date(b.start).toISOString(); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    const data = { connected: true, events: uniq.slice(0, 60), calendars: allCals.map(c => ({ id: c.id, name: c.primary ? 'Mine' : (c.summary || '').trim(), color: c.backgroundColor || '', hidden: hidden.has(c.id) })) }; calCache.set(me.id, { at: Date.now(), data }); res.json(data);
  } catch (e) { res.json({ connected: true, error: e.message.slice(0, 140) }); }
});

// ---------- Roles, tasks, and email-to-task ----------
// Lanes are the jobs people do. Each lane has a default person; a client can override web and ads.
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const LANES_FILE = path.join(DATA_DIR, 'lanes.json');
const LANE_DEFS = [['web', 'Web'], ['ads', 'Ads'], ['logistics', 'Logistics'], ['creative', 'Creative overview'], ['copy', 'Copy and scheduling'], ['graphics', 'Graphics'], ['content', 'Content flow'], ['field', 'Field team']];
const LANE_DEFAULT = { web: 'frank@openheartmediaco.com', ads: 'ariel@openheartmediaco.com', logistics: 'griffin@openheartmediaco.com', creative: 'zac@openheartmediaco.com',
  copy: 'valeria@openheartmediaco.com', graphics: 'mafer@openheartmediaco.com', content: 'hiroshi@openheartmediaco.com', field: 'tristen@openheartmediaco.com' };
function loadLanes() { return Object.assign({}, LANE_DEFAULT, readJson(LANES_FILE, {})); }
const LANE_RE = [
  ['ads', /\b(ads?|adwords|campaigns?|budget|ppc|google ads|meta ads|facebook ads|instagram ads|ad spend|cost per lead|cpl)\b/i],
  ['field', /\b(shoot|filming|photographer|on[- ]?site|location scout|b-?roll)\b/i],
  ['content', /\b(video|reels?|footage|edit(ing|s)?|rough cut|trailer)\b/i],
  ['graphics', /\b(logo|graphic|flyer|banner|brochure|brand(ing)? (kit|colors?)|fonts?)\b/i],
  ['copy', /\b(caption|copy|post|posting|content calendar|schedule[d]? (post|content)|blog|newsletter|approve|approval)\b/i],
  ['web', /\b(website|web ?site|site|domain|hosting|wordpress|wix|plugin|contact form|landing page|seo|dns|login|password)\b/i],
  ['logistics', /\b(invoice|billing|payment|contract|meeting|call|reschedule|renew|proposal|schedule)\b/i],
];
function classifyLane(text) { for (const [l, re] of LANE_RE) if (re.test(text || '')) return l; return null; }
function userByEmail(em) { return loadUsers().find(u => u.email === String(em || '').toLowerCase() && u.active !== false) || null; }
function userByName(n) { n = String(n || '').trim().toLowerCase(); return n ? loadUsers().find(u => u.active !== false && u.name.toLowerCase() === n) || null : null; }
// Who gets a task for this client and lane.
function ownerFor(client, lane) {
  let u = null;
  if (client) {
    if (lane === 'web') u = userByName(client.website_owner);
    if (lane === 'ads') u = userByName(client.ads_owner);
    if (!u && !lane) u = userByName(client.account_owner);
  }
  if (!u && lane) u = userByEmail(loadLanes()[lane]);
  if (!u && client) u = userByName(client.account_owner);
  return u || userByEmail(loadLanes().logistics) || loadUsers().find(x => x.role === 'admin') || null;
}
function loadTasks() { return readJson(TASKS_FILE, []); }
function saveTasks(t) { fs.writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2)); }
function nextBizDay(from) { const d = new Date(from || Date.now()); do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); return d.toISOString().slice(0, 10); }
const pubTask = (t, users) => ({ ...t, owner_name: (users.find(u => u.id === t.owner) || {}).name || '' });

app.get('/api/lanes', (req, res) => {
  if (!authedUser(req)) return res.status(401).json({ error: 'auth required' });
  const L = loadLanes(), users = loadUsers();
  res.json({ lanes: LANE_DEFS.map(([k, l]) => { const u = users.find(x => x.email === (L[k] || '').toLowerCase()); return { key: k, label: l, email: L[k] || '', name: u ? u.name : '' }; }) });
});
app.post('/api/admin/lanes', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { lane, email } = req.body || {}; if (!LANE_DEFS.some(x => x[0] === lane)) return res.status(400).json({ error: 'Unknown lane.' });
  if (!userByEmail(email)) return res.status(400).json({ error: 'That person has no login yet.' });
  const L = readJson(LANES_FILE, {}); L[lane] = String(email).toLowerCase(); fs.writeFileSync(LANES_FILE, JSON.stringify(L)); res.json({ ok: true });
});
app.get('/api/tasks', (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  const users = loadUsers(), cutoff = Date.now() - 7 * 864e5;
  let list = loadTasks().filter(t => t.status !== 'done' || (t.closed_at && new Date(t.closed_at).getTime() > cutoff));
  if (req.query.scope === 'mine') list = list.filter(t => t.owner === me.id);
  res.json({ tasks: list.map(t => pubTask(t, users)), me: me.id });
});
app.post('/api/tasks', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login to add tasks.' });
  const b = req.body || {}, title = String(b.title || '').trim().slice(0, 200); if (!title) return res.status(400).json({ error: 'Add a title.' });
  const owner = loadUsers().find(u => u.id === b.owner && u.active !== false) || userByEmail(me.email);
  const t = { id: 't_' + crypto.randomBytes(5).toString('hex'), title, client: String(b.client || '').slice(0, 60), lane: String(b.lane || '').slice(0, 20), owner: owner.id,
    due: /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : '', status: 'open', created_at: new Date().toISOString(), created_by: me.id, note: String(b.note || '').slice(0, 1000), source: { type: 'manual' } };
  const all = loadTasks(); all.push(t); saveTasks(all); res.json({ task: t });
});
app.post('/api/tasks/:id/done', (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  const all = loadTasks(), t = all.find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: 'Not found.' });
  if (t.owner !== me.id && me.role !== 'admin') return res.status(403).json({ error: 'Only the owner or an admin can close this.' });
  const done = !(req.body && req.body.done === false);
  t.status = done ? 'done' : 'open'; t.closed_at = done ? new Date().toISOString() : null; t.closed_by = done ? me.id : null; saveTasks(all); res.json({ ok: true });
});
app.post('/api/tasks/:id/assign', (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  const all = loadTasks(), t = all.find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: 'Not found.' });
  if (t.owner !== me.id && me.role !== 'admin') return res.status(403).json({ error: 'Only the owner or an admin can reassign.' });
  const u = loadUsers().find(x => x.id === (req.body && req.body.owner) && x.active !== false); if (!u) return res.status(400).json({ error: 'Pick a person.' });
  t.owner = u.id; saveTasks(all); res.json({ ok: true });
});

// Email to task. For each connected mailbox: a client email nobody has answered becomes a task for the right person,
// and the task closes itself once somebody on our domain replies in that thread.
const OWN_ADDR = /@openheartmediaco\.com$/i;
async function threadState(auth, threadId) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`, { headers: auth });
  if (!r.ok) return null; const j = await r.json(); const ms = j.messages || []; if (!ms.length) return null;
  const last = ms[ms.length - 1]; const h = Object.fromEntries((last.payload && last.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  const m = /<([^>]+)>/.exec(h.from || ''); const addr = String(m ? m[1] : h.from || '').toLowerCase();
  return { lastFromUs: OWN_ADDR.test(addr), lastDate: Number(last.internalDate) || 0 };
}
async function syncMailTasks(uid) {
  const tok = await userGmailToken(uid); if (!tok) return { created: 0, closed: 0 };
  const auth = { Authorization: 'Bearer ' + tok };
  mailCache.delete(uid); const data = await mailFor(uid); if (!data.connected) return { created: 0, closed: 0 };
  let tasks = loadTasks(), created = 0, closed = 0; const clients = loadClients(), cutoff = Date.now() - 7 * 864e5;
  const seenThreads = new Set();
  for (const m of (data.matched || [])) {
    if (m.date < cutoff) continue; const key = m.mid || (uid + ':' + m.id);
    if (tasks.some(t => t.source && (t.source.mid === key))) continue;
    if (seenThreads.has(m.thread)) continue; seenThreads.add(m.thread);
    const st = await threadState(auth, m.thread); if (!st || st.lastFromUs) continue;   // already answered
    const c = clients.find(x => x.slug === m.client.slug); const lane = classifyLane(m.subject + ' ' + m.snippet);
    const owner = ownerFor(c, lane); if (!owner) continue;
    tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title: `Reply to ${m.name}: ${m.subject}`.slice(0, 200), client: m.client.slug, lane: lane || '', owner: owner.id,
      due: nextBizDay(m.date), status: 'open', created_at: new Date().toISOString(), created_by: 'email', note: m.snippet,
      source: { type: 'email', mid: key, thread: m.thread, mailbox: uid, from: m.addr, name: m.name, subject: m.subject } });
    created++;
  }
  for (const t of tasks) {
    if (t.status !== 'open' || !t.source || t.source.type !== 'email' || t.source.mailbox !== uid) continue;
    const st = await threadState(auth, t.source.thread);
    if (st && st.lastFromUs) { t.status = 'done'; t.closed_at = new Date().toISOString(); t.closed_by = 'auto'; t.auto = 'Replied in the thread'; closed++; }
  }
  if (created || closed) saveTasks(tasks);
  return { created, closed };
}
app.post('/api/tasks/sync', async (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  try { res.json(await syncMailTasks(me.id)); } catch (e) { res.status(500).json({ error: e.message.slice(0, 160) }); }
});
let syncBusy = false;
async function syncAllMailTasks() {
  if (syncBusy || !GOOGLE_CLIENT_ID) return; syncBusy = true;
  try { for (const uid of Object.keys(gUsers())) { try { const r = await syncMailTasks(uid); if (r.created || r.closed) console.log('[tasks] sync', uid, r); } catch (e) { console.error('[tasks] sync failed', uid, e.message); } } } finally { syncBusy = false; }
}
setTimeout(syncAllMailTasks, 45e3); setInterval(syncAllMailTasks, 5 * 60e3);

// Morning digest (off unless NOTIFY_TASKS=1): one short email per person with their open tasks, weekdays about 8am Eastern.
const DIGEST_STAMP = path.join(DATA_DIR, 'task_digest_last.json');
async function sendTaskDigests() {
  if (process.env.NOTIFY_TASKS !== '1' || !process.env.SENDGRID_API_KEY) return;
  const now = new Date(), et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() === 0 || et.getDay() === 6 || et.getHours() < 8 || et.getHours() > 10) return;
  const day = et.toISOString().slice(0, 10); if (readJson(DIGEST_STAMP, {}).day === day) return;
  fs.writeFileSync(DIGEST_STAMP, JSON.stringify({ day }));
  const tasks = loadTasks().filter(t => t.status === 'open'), clients = loadClients();
  for (const u of loadUsers().filter(x => x.active !== false)) {
    const mine = tasks.filter(t => t.owner === u.id); if (!mine.length) continue;
    const lines = mine.slice(0, 15).map(t => `- ${t.title}${t.client ? ' (' + ((clients.find(c => c.slug === t.client) || {}).name || t.client) + ')' : ''}${t.due ? ', due ' + t.due : ''}`);
    try { await sgMail.send({ to: u.email, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME }, subject: `Your tasks today (${mine.length})`, text: `Good morning ${u.name.split(' ')[0]},\n\n${lines.join('\n')}\n\nOpen the CRM: ${CRM_URL}/\n` }); } catch (e) { console.error('[digest] failed', u.email, e.message); }
  }
}
setInterval(sendTaskDigests, 15 * 60e3);


// ---------- Client brain, guidelines, and content by week ----------
const BRAIN_DIR = path.join(__dirname, 'data', 'brains'), GUIDE_DIR = path.join(__dirname, 'data', 'guidelines');
app.get('/api/hq/brain/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, '');
  try { res.json({ md: fs.readFileSync(path.join(BRAIN_DIR, slug + '.md'), 'utf8') }); } catch { res.json({ md: '' }); }
});

// Ready-to-use copy for a client: pulled from the sections of their Brain that hold headline ideas, hooks, test ideas and customer language.
function brainCopy(md) {
  const lines = md.replace(/\r/g, '').split('\n'), heads = [];
  lines.forEach((l, i) => { const m = /^(#{2,3})\s+(.*)$/.exec(l); if (m) heads.push({ i, level: m[1].length, title: m[2].trim() }); });
  const blocks = heads.map((h, k) => { let end = lines.length; for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].i; break; } return { ...h, end }; });
  const find = re => blocks.filter(b => re.test(b.title));
  const voc = find(/voice-of-customer to copy/i)[0];
  const parts = [];
  const take = (b, skip) => { let body = lines.slice(b.i, b.end); if (skip) body = lines.slice(b.i, skip.i).concat(lines.slice(skip.end, b.end)); return body.join('\n').trim(); };
  if (voc) parts.push(['Headline ideas, ready to use', take({ ...voc, i: voc.i + 1 })]);
  for (const b of find(/test ideas/i)) parts.push(['Test ideas', take(b)]);
  for (const b of find(/^\d*\.?\s*what works/i).filter(x => x.level === 2)) parts.push(['What works, and hook patterns to reuse', take({ ...b, i: b.i + 1 }, voc && voc.i > b.i && voc.end <= b.end ? voc : null)]);
  for (const b of find(/customer language/i)) parts.push(['What customers say, in their words', take({ ...b, i: b.i + 1 })]);
  for (const b of find(/brand and voice/i)) parts.push(['Brand voice', take({ ...b, i: b.i + 1 })]);
  for (const b of find(/viral formats/i).filter(x => x.level === 2)) parts.push(['Formats that are working now', take({ ...b, i: b.i + 1 })]);
  return parts.filter(p => p[1]).map(p => '## ' + p[0] + '\n\n' + p[1].replace(/^#{2,3}\s+/gm, '#### ')).join('\n\n');
}
app.get('/api/hq/copy/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, '');
  let md = ''; try { md = brainCopy(fs.readFileSync(path.join(BRAIN_DIR, slug + '.md'), 'utf8')); } catch {}
  try { const ex = fs.readFileSync(path.join(__dirname, 'data', 'copy-extra', slug + '.md'), 'utf8').trim(); if (ex && !/^## Headline ideas/m.test(md)) md = '## Headline ideas, ready to use\n\n' + ex + (md ? '\n\n' + md : ''); } catch {}
  // The research bank (Reddit pain points, reviews, searches, hook bank, graphic formats) shows for every client.
  // Skip the Reddit block when the brain already shows "What customers say", so nothing prints twice.
  try {
    const rs = readResearch(slug);
    if (rs) {
      const secs = rs.split(/^(?=## )/m).filter(s => /^## \(/.test(s));
      const titleOf = s => (/^##\s*\([a-z]\)\s*(.+)$/m.exec(s) || [, ''])[1].trim();
      const have = /What customers say/i.test(md);
      const out = secs.filter(s => !(have && /^## \(a\)/.test(s))).map(s => '## Research: ' + titleOf(s) + '\n\n' + s.replace(/^## .*\n/, '').replace(/^#{2,3}\s+/gm, '#### ').trim());
      if (out.length) md = (md ? md + '\n\n' : '') + out.join('\n\n');
    }
  } catch {}
  res.json({ md });
});
app.get('/api/hq/guidelines', (req, res) => {
  const order = ['content-standards', 'footage-labeling', 'content-frameworks', 'static-ads', 'voice-of-customer'];
  const out = []; for (const k of order) { try { const t = fs.readFileSync(path.join(GUIDE_DIR, k + '.md'), 'utf8'); out.push({ key: k, title: (/^#\s+(.+)$/m.exec(t) || [, k])[1].trim() }); } catch {} }
  res.json({ docs: out });
});
app.get('/api/hq/guidelines/:key', (req, res) => {
  const k = String(req.params.key).replace(/[^a-z0-9-]/g, '');
  try { res.json({ md: fs.readFileSync(path.join(GUIDE_DIR, k + '.md'), 'utf8') }); } catch { res.json({ md: '' }); }
});
const FILE_RE = /^([A-Z]{2,6})_(REEL|DRONE|PHOTO)_(\d{8})_([A-Za-z0-9]+)_([A-Z]+)_(\d{3})\.[A-Za-z0-9]+$/;
function addBizDays(d, n) { const x = new Date(d); let c = 0; while (c < n) { x.setDate(x.getDate() + 1); if (x.getDay() !== 0 && x.getDay() !== 6) c++; } return x; }
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
const contentCache = new Map();
async function getContent(me, c) {
  if (!c.drive) return { connected: true, noFolder: true };
  const ck = me.id + ':' + c.slug, hit = contentCache.get(ck); if (hit && Date.now() - hit.at < 300e3) return hit.data;
  try {
    const tok = await userGmailToken(me.id); if (!tok) return { connected: false, configured: !!GOOGLE_CLIENT_ID };
    const auth = { Authorization: 'Bearer ' + tok };
    const list = async (q) => {
      const u = new URL('https://www.googleapis.com/drive/v3/files'); u.searchParams.set('q', q); u.searchParams.set('pageSize', '200');
      u.searchParams.set('fields', 'files(id,name,mimeType,createdTime,webViewLink)'); u.searchParams.set('orderBy', 'createdTime desc'); u.searchParams.set('supportsAllDrives', 'true'); u.searchParams.set('includeItemsFromAllDrives', 'true');
      const r = await fetch(u, { headers: auth }); if (!r.ok) { const b = await r.text().catch(() => ''); const e = new Error('drive ' + r.status); e.status = r.status; e.body = b; throw e; }
      return (await r.json()).files || [];
    };
    const kids = await list(`'${c.drive}' in parents and trashed = false`);
    const folders = kids.filter(f => f.mimeType === 'application/vnd.google-apps.folder').map(f => ({ name: f.name, url: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`, id: f.id }));
    const items = [];
    for (const f of folders.filter(f => /^(reels|drone|photos)$/i.test(f.name))) {
      for (const file of await list(`'${f.id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`)) items.push({ ...file, folder: f.name });
    }
    const weeksMap = new Map(), unnamed = [];
    for (const f of items.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))) {
      const m = FILE_RE.exec(f.name);
      if (!m) { unnamed.push({ name: f.name, url: f.webViewLink, folder: f.folder, uploaded: f.createdTime }); continue; }
      const due = addBizDays(f.createdTime, 10).toISOString().slice(0, 10), wk = mondayOf(f.createdTime);
      const w = weeksMap.get(wk) || { week: wk, items: [] };
      w.items.push({ id: f.id, n: w.items.length + 1, name: f.name, type: m[2], subject: m[4], label: m[5], shot: m[3], uploaded: f.createdTime.slice(0, 10), due, url: f.webViewLink });
      weeksMap.set(wk, w);
    }
    const weeks = [...weeksMap.values()].sort((a, b) => a.week < b.week ? 1 : -1).slice(0, 8);
    const data = { connected: true, folders: folders.map(f => ({ name: f.name, url: f.url })), weeks, unnamed: unnamed.slice(0, 30), total: items.length };
    contentCache.set(ck, { at: Date.now(), data }); return data;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { connected: true, needsDrive: true, apiOff: /accessNotConfigured|has not been used|disabled|SERVICE_DISABLED/i.test(e.body || '') };
    return { connected: true, error: String(e.message).slice(0, 140) };
  }
}
app.get('/api/hq/content/:slug', async (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  if (me.legacy) return res.json({ connected: false, legacy: true });
  const c = loadClients().find(x => x.slug === req.params.slug); if (!c) return res.status(404).json({ error: 'Unknown client.' });
  res.json(await getContent(me, c));
});

// When Tristen uploads footage, the editing and design tasks are created from it. Files already there when this first runs are baselined, not tasked.
const UPLOADS_STATE = path.join(DATA_DIR, 'uploads_state.json');
async function autoUploads() {
  if (!AUTO_ON() || !GOOGLE_CLIENT_ID) return;
  const uid = Object.keys(gUsers())[0]; if (!uid) return;
  const freshBySlug = {}; const prev = readJson(UPLOADS_STATE, null), first = !prev, seen = new Set((prev && prev.seen) || []), tasks = loadTasks(); let changed = false;
  for (const c of loadClients().filter(x => x.drive)) {
    try {
      contentCache.delete(uid + ':' + c.slug); const d = await getContent({ id: uid }, c); if (!d.weeks) continue;
      const items = d.weeks.flatMap(w => w.items), fresh = items.filter(i => i.id && !seen.has(i.id));
      if (!fresh.length) continue; fresh.forEach(i => seen.add(i.id)); changed = true; if (first) continue;
      freshBySlug[c.slug] = fresh.map(i => `${i.shot || ''} ${i.type || ''} ${i.label || ''} ${i.name || ''}`.trim()).slice(0, 30).join('\n');
      const byShot = new Map(); fresh.forEach(i => { (byShot.get(i.shot) || byShot.set(i.shot, []).get(i.shot)).push(i); });
      for (const [shot, list] of byShot) {
        const nice = shot.slice(4, 6) + '/' + shot.slice(6, 8), fd = fridayDue(), sl = (loadShotlists()[c.slug] || []).find(x => x.date === shot.slice(0, 4) + '-' + shot.slice(4, 6) + '-' + shot.slice(6, 8));
        const make = (lane, title, rows) => {
          if (!rows.length) return; const owner = ownerFor(c, lane); if (!owner) return;
          const count = {}; rows.forEach(r => { const k = r.type + ' ' + r.label; count[k] = (count[k] || 0) + 1; });
          const note = `Uploaded from the ${nice} shoot. ${Object.entries(count).map(([k, v]) => v + ' ' + k).join(', ')}.${sl ? ' Shot list: ' + sl.name + '.' : ''}\nFiles: https://drive.google.com/drive/folders/${c.drive}`;
          const open = tasks.find(t => t.status === 'open' && t.source && t.source.type === 'upload' && t.source.slug === c.slug && t.source.shot === shot && t.lane === lane);
          if (open) { open.note = note; open.title = title; return; }
          tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title, client: c.slug, lane, owner: owner.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: new Date().toISOString(), created_by: 'upload', note, source: { type: 'upload', slug: c.slug, shot } });
        };
        make('content', `Edit ${list.filter(r => r.type !== 'PHOTO').length} clips from the ${nice} shoot: ${c.name}`, list.filter(r => r.type !== 'PHOTO'));
        make('graphics', `Retouch and design from ${list.filter(r => r.type === 'PHOTO').length} photos, ${nice} shoot: ${c.name}`, list.filter(r => r.type === 'PHOTO'));
        console.log('[uploads] tasks for', c.slug, shot);
      }
    } catch (e) { console.error('[uploads] failed', c.slug, e.message); }
  }
  for (const [sl, txt] of Object.entries(freshBySlug)) if (!first) rebuildForNewContent(sl, uid, txt).catch(e => console.error('[pack] rebuild failed', sl, e.message));
  if (changed || first) { saveTasks(tasks); fs.writeFileSync(UPLOADS_STATE, JSON.stringify({ seen: [...seen].slice(-6000), at: new Date().toISOString() })); }
}
setTimeout(autoUploads, process.env.AUTO_FAST ? 12e3 : 150e3); setInterval(autoUploads, process.env.AUTO_FAST ? 10e3 : 15 * 60e3);


// Weekly board: every piece that is due, per client, for last week and this week, with what is done, late or still open.
app.get('/api/hq/week-board', (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  const cur = mondayOf(etNow()), last = addDaysStr(cur, -7), users = loadUsers(), nm = id => (users.find(u => u.id === id) || {}).name || '', tasks = loadTasks(), packs = loadPacks(), clients = loadClients();
  const nowET = etNow();
  const mk = (start) => {
    const end = addDaysStr(start, 6), out = [];
    for (const c of clients) {
      const mine = tasks.filter(t => t.client === c.slug && t.due && t.due >= start && t.due <= end && t.status !== 'dropped');
      if (!mine.length) continue;
      const items = mine.map(t => {
        let pieces = []; if (t.source && t.source.type === 'pack') { const pk = (packs[c.slug] || {})[t.source.week]; if (pk) pieces = (pk.rows || []).filter(r => t.lane === 'content' ? r.type === 'Reel' : t.lane === 'graphics' ? r.type !== 'Reel' : true).map(r => ({ date: r.date, type: r.type, what: String(r.hook || r.idea || '').slice(0, 110) })); }
        const done = t.status === 'done', todayS = ymdLocal(nowET), late = !done && (t.due < todayS || (t.due === todayS && nowET.getHours() >= 17));
        return { id: t.id, title: t.title, lane: t.lane, owner: nm(t.owner), due: t.due, status: done ? 'done' : late ? 'late' : 'open', pieces };
      });
      const verdict = items.every(i => i.status === 'done') ? 'good' : items.some(i => i.status === 'late') ? 'missing' : 'progress';
      out.push({ slug: c.slug, name: c.name, logo: c.logo || '', verdict, items });
    }
    const rank = { missing: 0, progress: 1, good: 2 }; out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.name.localeCompare(b.name));
    return { start, end, clients: out };
  };
  res.json({ weeks: [{ label: 'Due this week', ...mk(cur) }, { label: 'Last week: good to go or missing', ...mk(last) }] });
});

// Every client at a glance: pieces uploaded this week and last, the next due date, files that need renaming.
app.get('/api/hq/content-week', async (req, res) => {
  const me = authedUser(req); if (!me) return res.status(401).json({ error: 'auth required' });
  if (me.legacy) return res.json({ connected: false, legacy: true });
  const thisWk = mondayOf(new Date()), last = new Date(); last.setDate(last.getDate() - 7); const lastWk = mondayOf(last), today = new Date().toISOString().slice(0, 10);
  const clients = loadClients().filter(c => c.drive); const rows = []; let state = null;
  for (let k = 0; k < clients.length; k += 3) await Promise.all(clients.slice(k, k + 3).map(async c => {
    const d = await getContent(me, c);
    if (d.connected === false || d.needsDrive || d.error) { state = state || d; return; }
    const wk = w => (d.weeks.find(x => x.week === w) || { items: [] }).items;
    const upcoming = d.weeks.flatMap(w => w.items).map(i => i.due).filter(x => x >= today).sort()[0] || '';
    rows.push({ slug: c.slug, name: c.name, thisWeek: wk(thisWk).length, lastWeek: wk(lastWk).length, nextDue: upcoming, unnamed: (d.unnamed || []).length, total: d.total });
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ connected: true, state, rows, thisWk, lastWk });
});


// ---------- Living brain: shot lists generated from the brain + what is working ----------
const WORKING_DIR = path.join(__dirname, 'data', 'working');
const SHOTLISTS_FILE = path.join(DATA_DIR, 'shotlists.json');
const WORKING_LIVE = path.join(DATA_DIR, 'working');
function readWorking(slug) {
  try { return fs.readFileSync(path.join(WORKING_LIVE, slug + '.md'), 'utf8'); } catch {}
  try { return fs.readFileSync(path.join(WORKING_DIR, slug + '.md'), 'utf8'); } catch {}
  return '';
}
app.get('/api/hq/working/:slug', (req, res) => { const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, ''); res.json({ md: readWorking(slug) }); });
app.put('/api/hq/working/:slug', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, ''); const md = String((req.body && req.body.md) || '').slice(0, 30000);
  fs.mkdirSync(WORKING_LIVE, { recursive: true }); fs.writeFileSync(path.join(WORKING_LIVE, slug + '.md'), md); res.json({ ok: true });
});
function loadShotlists() { return readJson(SHOTLISTS_FILE, {}); }
app.get('/api/hq/shotlists/:slug', (req, res) => { const all = loadShotlists(); res.json({ lists: (all[String(req.params.slug)] || []).slice(0, 6) }); });


// Confirmed facts per client: a short list the team has verified. These override the brain and drive the shot list writer.
const FACTS_DIR = path.join(__dirname, 'data', 'facts'), FACTS_LIVE = path.join(DATA_DIR, 'facts');
function readFacts(slug) {
  try { return fs.readFileSync(path.join(FACTS_LIVE, slug + '.md'), 'utf8'); } catch {}
  try { return fs.readFileSync(path.join(FACTS_DIR, slug + '.md'), 'utf8'); } catch {}
  return '';
}
app.get('/api/hq/facts/:slug', (req, res) => { res.json({ md: readFacts(String(req.params.slug).replace(/[^a-z0-9-]/g, '')) }); });
app.put('/api/hq/facts/:slug', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, ''), md = String((req.body && req.body.md) || '').slice(0, 8000);
  fs.mkdirSync(FACTS_LIVE, { recursive: true }); fs.writeFileSync(path.join(FACTS_LIVE, slug + '.md'), md); res.json({ ok: true });
});


// Long AI work runs in the background; the page polls for the result so nothing times out.
const jobs = new Map();
function startJob(fn) { const id = 'j_' + crypto.randomBytes(4).toString('hex'), j = { id, status: 'running' }; jobs.set(id, j); fn().then(r => { j.status = 'done'; j.result = r; }).catch(e => { j.status = 'error'; j.error = String((e && e.message) || e).slice(0, 300); }); setTimeout(() => jobs.delete(id), 30 * 60e3); return id; }
app.get('/api/hq/jobs/:id', (req, res) => { if (!authedUser(req)) return res.status(401).json({ error: 'auth required' }); const j = jobs.get(req.params.id); res.json(j ? { status: j.status, error: j.error || '' } : { status: 'error', error: 'That job expired. Try again.' }); });
// Everything is due Friday at 5:00 PM Eastern, no exceptions.
function etNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function ymdLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fridayDue() { const d = etNow(), dow = d.getDay(); let add = dow >= 1 && dow <= 5 ? 5 - dow : (5 - dow + 7) % 7; if (dow === 5 && d.getHours() >= 17) add = 7; d.setDate(d.getDate() + add); return { due: ymdLocal(d), due_time: '17:00' }; }
function upcomingMonday() { const d = etNow(), dow = d.getDay(); d.setDate(d.getDate() + (dow === 1 ? 0 : (8 - dow) % 7)); return ymdLocal(d); }


// Everything in a client's Drive folder, filed or not: visit folders, raw camera files, talking-head folders. This is what the brain plans around.
const invCache = new Map();
async function getInventory(uid, c) {
  if (!c.drive) return null;
  const ck = uid + ':' + c.slug, hit = invCache.get(ck); if (hit && Date.now() - hit.at < 600e3) return hit.data;
  const tok = await userGmailToken(uid); if (!tok) return null; const auth = { Authorization: 'Bearer ' + tok };
  const list = async (q) => { const u = new URL('https://www.googleapis.com/drive/v3/files'); u.searchParams.set('q', q); u.searchParams.set('pageSize', '200'); u.searchParams.set('fields', 'files(id,name,mimeType,createdTime,modifiedTime,webViewLink)'); u.searchParams.set('orderBy', 'createdTime desc'); u.searchParams.set('supportsAllDrives', 'true'); u.searchParams.set('includeItemsFromAllDrives', 'true'); const r = await fetch(u, { headers: auth }); if (!r.ok) throw new Error('drive ' + r.status); return (await r.json()).files || []; };
  const isFolder = f => f.mimeType === 'application/vnd.google-apps.folder', out = [];
  try {
    const top = await list(`'${c.drive}' in parents and trashed = false`);
    const walk = async (folder, pathStr, depth) => {
      const kids = await list(`'${folder.id}' in parents and trashed = false`);
      const vids = kids.filter(f => /^video\//.test(f.mimeType) || /\.(mp4|mov|mxf|avi|m4v)$/i.test(f.name)), imgs = kids.filter(f => /^image\//.test(f.mimeType) || /\.(jpe?g|png|heic|raw|arw|cr2|dng)$/i.test(f.name));
      const subs = kids.filter(isFolder);
      if (vids.length || imgs.length) out.push({ path: pathStr, url: folder.webViewLink || 'https://drive.google.com/drive/folders/' + folder.id, created: (folder.createdTime || '').slice(0, 10), videos: vids.length, images: imgs.length, newest: (kids[0] && kids[0].createdTime || '').slice(0, 10), sample: vids.concat(imgs).slice(0, 4).map(f => f.name), named: vids.concat(imgs).filter(f => FILE_RE.test(f.name)).length });
      const recent = f => Date.now() - Date.parse(f.modifiedTime || f.createdTime || 0) < 60 * 864e5 || Date.now() - Date.parse(f.createdTime || 0) < 60 * 864e5;
      if (depth < 4) for (const sf of subs.filter(f => !/^archive$/i.test(f.name) || recent(f)).filter(f => !/archive/i.test(pathStr) || recent(f)).slice(0, 15)) await walk(sf, pathStr + ' / ' + sf.name, depth + 1);
    };
    for (const f of top.filter(isFolder)) await walk(f, f.name, 1);
    const data = { folders: out.sort((a, b) => String(b.newest || b.created).localeCompare(String(a.newest || a.created))).slice(0, 30) }; invCache.set(ck, { at: Date.now(), data }); return data;
  } catch (e) { return hit ? hit.data : null; }
}
function inventoryText(inv) {
  if (!inv) return 'Drive inventory not available. Do not guess what footage exists.';
  if (!inv.folders.length) return 'The client Drive folder has no footage outside the Archive.';
  return inv.folders.map(f => `- ${f.path}: ${f.videos} video and ${f.images} image files, newest ${f.newest || f.created}, ${f.named} named to standard. Examples: ${f.sample.join(', ')}`).join('\n');
}
app.get('/api/hq/inventory/:slug', async (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.json({ connected: false });
  const c = loadClients().find(x => x.slug === req.params.slug); if (!c || !c.drive) return res.json({ connected: true, noFolder: true });
  try { res.json({ connected: true, ...(await getInventory(me.id, c) || { folders: [] }) }); } catch (e) { res.json({ connected: true, folders: [], error: String(e.message).slice(0, 120) }); }
});
// Visual look for a client: palette, fonts, weekly color rotation, feed grid mockup, saved competitor reference images.
app.get('/api/hq/look/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, '');
  try { res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'look', slug + '.json'), 'utf8'))); } catch { res.json({ none: true }); }
});
// Format rules for a client, assembled from its brain and the team's plan: reels, text on screen, captions, graphics.
app.get('/api/hq/formats/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, ''); res.json({ md: formatRules(slug) });
});
function formatRules(slug) {
  let brain = ''; try { brain = fs.readFileSync(path.join(BRAIN_DIR, slug + '.md'), 'utf8'); } catch {}
  const PL = loadPlans(), gr = PL.guardrails[slug], parts = [];
  parts.push('## Reels\n- 1080x1920. Frame one carries the payoff; average watch time is about 8 seconds, so do not build for completion.\n- Hook: a talking-head line if the footage has one. If there is no talking hook, the hook is text on screen in the first second.\n- Text on screen: short, one idea per card, no em dashes, keep type away from the app UI at the top and bottom.\n- Caption: a hook, a body and one CTA. Work one or two target search keywords into the caption naturally, with the main one in the first line. End with up to 5 hashtags (never more): local and service tags first, then the current working tags. US spelling.');
  parts.push('## Graphics and static ads\n- Single designed frame, 1080x1350, real photos only. Use one of: editorial, color_poster, notes_app, reminders_app, imessage, annotated, polaroid_wall, grid_card, big_number, review_card, ticket_offer, and vary the design week to week.\n- Carousels: 5 cards or fewer, 1080x1350, one idea per card. Reserved for the highest-save teaching posts.\n- Holidays: thank you only. Offers only when the client confirms them in writing.');
  if (gr) parts.push('## This client\'s look and tone\n' + gr.look + '\n\n## This client\'s guardrails\n' + gr.rules);
  const lines = brain.split('\n').filter(l => /^\s*[-*]/.test(l) && /(on[- ]screen|text on screen|caption|CTA|hashtag|emoji|tone|voice|never say|do not say|words to use|avoid)/i.test(l)).map(l => l.trim()).slice(0, 14);
  if (lines.length) parts.push('## From the client brain\n' + lines.join('\n'));
  try { const ex = fs.readFileSync(path.join(__dirname, 'data', 'formats', slug + '.md'), 'utf8'); if (ex) parts.push('## Client-specific formats and examples\n' + ex.slice(0, 7000)); } catch {}
  return parts.join('\n\n');
}

function readResearch(slug) { try { return fs.readFileSync(path.join(__dirname, 'data', 'research', String(slug).replace(/[^a-z0-9-]/g, '') + '.md'), 'utf8'); } catch { return ''; } }
function readHashtags(slug) { try { return fs.readFileSync(path.join(__dirname, 'data', 'hashtags', String(slug).replace(/[^a-z0-9-]/g, '') + '.md'), 'utf8'); } catch { return ''; } }
const cleanTags = a => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,]+/)).map(t => String(t).trim().replace(/^#*/, '').replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean))].slice(0, 5).map(t => '#' + t);
const SHOTLIST_RULES = `You are the Open Heart Media content planner. You write ONE shot list for ONE shoot for ONE client. The team will film exactly what you write.
Rules:
- CONFIRMED FACTS are verified by the team and override anything in the brain. If they conflict with the brain, follow the confirmed facts. Never narrow what the client does below what the confirmed facts say.
- Use only facts in the client brain and the confirmed facts. Never invent stats, awards, testimonials, prices, specs, names or dates. If a hook depends on a fact the client has not confirmed, add it to "verify".
- Obey the client's compliance and claims section in the brain. If it forbids something, do not write it.
- Each talking-head item is a full script, not just a hook. "hook" is the spoken line in one breath (18 words or fewer), to ONE person in ONE moment, with something checkable. "body" is 3 or 4 short spoken points in order (about 60 words total), each with a checkable detail. "cta" is the last spoken line and names the next step (call, quote or website plus phone from the facts). "onscreen" is the visual hook text for the first second, worded differently from the spoken hook. Each script uses a different angle.
- Every script must come from the RESEARCH BANK or the RESEARCH PULLED THIS WEEK section: name the specific finding, top post or pattern it copies in "mimic" and "why". If that section is empty or old, say so in "notes" and do not pad.
- Base hooks and b-roll on what is proven and working: first the client's own top posts and anything labeled TESTED or PROVEN, then the formats and hook patterns in the brain labeled PROXY or OBSERVED. Prefer proven over hypothesis. Say which pattern each one copies in "mimic" and its evidence label in "why".
- B-roll and photo shots are specific and filmable in one visit (subject, angle, action). No vague items like "great footage".
- Use the five awareness levels (1 potential, 2 pain, 3 promise, 4 proof, 5 offer) and tag each hook with one.
- Anything the archive is missing (see ARCHIVE) should get priority in b-roll and photos.
- "mustgets" are shots a specific calendar post or open item needs, with the post or item it is for. If none are known, use the brain's open items to verify.
- CLIP BUDGET (strict). Over-filming is the team's biggest time sink, so every item states exactly how much to shoot. A talking-head script is 1 take (2 at most). A b-roll shot is 2 to 4 clips of 4 to 8 seconds each, never more than 4. A photo shot is 1 to 3 photos. A must-get is 1 to 3 clips. The whole shoot totals at most 40 clips, 25 photos and 6 takes. Write the exact number in "clips", "count" or "takes". Say in "notes" to stop shooting when the list is done and not to film extras. Prefer fewer, better clips.
- Copy rules: no em dashes, American spelling, no hedges, no AI words (delve, elevate, unlock, seamless, robust, leverage, transform, game-changer), numbers beat adjectives, front-load the point.
Return ONLY JSON, no prose, in this shape:
{"hooks":[{"hook":"","body":["",""],"cta":"","onscreen":"","mimic":"","level":1,"takes":1,"why":"","verify":[""]}],"broll":[{"shot":"","why":"","clips":3}],"photos":[{"shot":"","label":"TEAM|HEADSHOT|JOBSITE|PRODUCT|EVENT|LOCATION","count":2}],"mustgets":[{"shot":"","for":"","clips":2}],"notes":""}
Counts: 4 hooks, 6 b-roll, 4 photos, 3 mustgets.`;

function archiveSummary(slug) {
  for (const [k, v] of contentCache) if (k.endsWith(':' + slug) && v.data && v.data.weeks) {
    const counts = {}; v.data.weeks.forEach(w => w.items.forEach(i => { const key = i.type + ' ' + i.label; counts[key] = (counts[key] || 0) + 1; }));
    const all = ['REEL HOOK', 'REEL TALK', 'REEL BROLL', 'REEL PRODUCT', 'REEL EVENT', 'DRONE AERIAL', 'PHOTO TEAM', 'PHOTO JOBSITE', 'PHOTO PRODUCT', 'PHOTO LOCATION'];
    return 'Recent uploads by label: ' + all.map(a => a + '=' + (counts[a] || 0)).join(', ') + '. Labels at 0 or 1 are missing.';
  }
  return 'Archive inventory not available. Do not guess what is missing.';
}
async function aiJson(system, user, maxTokens) {
  if (process.env.FAKE_AI === '1') return JSON.parse(process.env.FAKE_AI_JSON || '{}');
  let r; try { r = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: maxTokens || 4000, system, messages: [{ role: 'user', content: user }] }); } catch (e) { const m = String((e && e.message) || e); throw new Error(/credit balance|billing/i.test(m) ? 'The Anthropic account is out of credits. Add credits and try again.' : /api[_ ]?key|authentication|401/i.test(m) ? 'The Anthropic key on the server is missing or wrong.' : 'The AI request failed: ' + m.slice(0, 140)); }
  let t = ((r.content || []).find(b => b && b.type === 'text')?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < 0) throw new Error('The AI did not return a usable answer (' + (r.stop_reason || 'no reason') + '). Try again in a minute.');
  return JSON.parse(t.slice(a, b + 1));
}
async function makeShotlist(slug, dateStr, who) {
  const c = loadClients().find(x => x.slug === slug); if (!c) throw new Error('Unknown client.');
  let brain = ''; try { brain = fs.readFileSync(path.join(BRAIN_DIR, slug + '.md'), 'utf8'); } catch {}
  if (!brain) throw new Error('This client has no brain file yet.');
  const sec = (re) => { const m = new RegExp('^## ' + re + '[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'mi').exec(brain); return m ? m[0].slice(0, 9000) : ''; };
  const context = [sec('1\\.'), sec('3\\.'), sec('4\\.'), sec('5\\.'), brainCopy(brain).slice(0, 14000), sec('9\\.'), sec('12\\.')].filter(Boolean).join('\n\n');
  let invTextShot = 'Drive inventory not available.'; try { const u2 = Object.keys(gUsers())[0]; if (u2) invTextShot = inventoryText(await getInventory(u2, c)); } catch {}
  const user = `CLIENT: ${c.name} (code ${c.code || ''})\nSHOOT DATE: ${dateStr}\n\nCONFIRMED FACTS (override the brain):\n${readFacts(slug).slice(0, 4000) || '(none confirmed yet)'}\n\nRESEARCH BANK (Reddit pain points and language, review and search findings, hooks and graphics with evidence labels; trust TESTED and PROVEN first, treat PROXY and OBSERVED as hypotheses):\n${readResearch(slug).slice(0, 9000) || '(no research bank saved yet for this client)'}\n\nWHAT IS WORKING NOW (client's own top posts):\n${readWorking(slug).slice(0, 6000) || '(none provided)'}\n\nARCHIVE: ${archiveSummary(slug)}\n\nFOOTAGE IN THE CLIENT'S DRIVE FOLDER NOW:\n${invTextShot}\n\nFORMAT AND TEXT-ON-SCREEN RULES:\n${formatRules(slug)}\n\nRESEARCH BANK (Reddit pain points and language, review and search findings, hooks and graphics with evidence labels):\n${readResearch(slug).slice(0, 9000) || '(none saved yet)'}\n\nRESEARCH PULLED THIS WEEK (top posts and what is working, keywords, hashtags; last updated per the file):\n${(readWorking(slug) || '(none saved yet)').slice(0, 5000)}\n${readHashtags(slug).slice(0, 1500)}\n\nCLIENT BRAIN (the source of truth):\n${context}`;
  const out = await aiJson(SHOTLIST_RULES, user, 4500);
  const clean = (x) => String(x == null ? '' : x).replace(/—|–/g, ',').trim();
  const arr = (v, f) => (Array.isArray(v) ? v : []).slice(0, 12).map(f);
  const item = { id: 'sl_' + crypto.randomBytes(4).toString('hex'), name: `${c.code || c.slug.toUpperCase()}_SHOTLIST_${dateStr.replace(/-/g, '')}`, date: dateStr, at: new Date().toISOString(), by: who || 'auto',
    hooks: arr(out.hooks, h => ({ hook: clean(h.hook), body: (Array.isArray(h.body) ? h.body : []).map(clean).filter(Boolean).slice(0, 5), cta: clean(h.cta), onscreen: clean(h.onscreen), mimic: clean(h.mimic), level: Number(h.level) || 0, takes: Math.min(2, Math.max(1, Number(h.takes) || 1)), why: clean(h.why), verify: (Array.isArray(h.verify) ? h.verify : []).map(clean).filter(Boolean) })),
    broll: arr(out.broll, b => ({ shot: clean(b.shot), why: clean(b.why), clips: Math.min(4, Math.max(1, Number(b.clips) || 3)) })), photos: arr(out.photos, p => ({ shot: clean(p.shot), label: clean(p.label), count: Math.min(3, Math.max(1, Number(p.count) || 1)) })),
    mustgets: arr(out.mustgets, m => ({ shot: clean(m.shot), for: clean(m.for), clips: Math.min(3, Math.max(1, Number(m.clips) || 2)) })), notes: clean(out.notes), basis: { working: !!readWorking(slug), archive: archiveSummary(slug).startsWith('Recent') } };
  // Totals are counted here, not trusted from the model.
  item.totals = { clips: item.broll.reduce((a, b) => a + b.clips, 0) + item.mustgets.reduce((a, m) => a + m.clips, 0), photos: item.photos.reduce((a, p) => a + p.count, 0), takes: item.hooks.reduce((a, h) => a + h.takes, 0) };
  const all = loadShotlists(); all[slug] = [item].concat((all[slug] || []).filter(x => x.date !== dateStr)).slice(0, 8);
  fs.writeFileSync(SHOTLISTS_FILE, JSON.stringify(all, null, 2));
  return item;
}
app.post('/api/hq/shotlists/:slug', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const d = String((req.body && req.body.date) || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Pick the shoot date.' });
  const slug = String(req.params.slug); res.json({ job: startJob(async () => { const l = await makeShotlist(slug, d, me.name); try { createShotTask(slug, l, me.name); } catch {} return l; }) });
});
function createShotTask(slug, list, who) {
  const c = loadClients().find(x => x.slug === slug), owner = c && ownerFor(c, 'field'); if (!owner) throw new Error('Nobody is set for the Field team.');
  const tasks = loadTasks(); if (tasks.some(t => t.source && t.source.type === 'shotlist' && t.source.id === list.id)) return owner.name;
  const note = ['HOOKS TO FILM', ...list.hooks.map((h, i) => (i + 1) + '. ' + h.hook), 'B-ROLL TO GET', ...list.broll.map((b, i) => (i + 1) + '. ' + b.shot), 'PHOTOS TO GET', ...list.photos.map((p, i) => (i + 1) + '. ' + p.shot), 'MUST-GETS', ...list.mustgets.map((m, i) => (i + 1) + '. ' + m.shot + (m.for ? ' (for ' + m.for + ')' : ''))].join('\n').slice(0, 1000);
  tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title: `Film: ${list.name}`, client: c.slug, lane: 'field', owner: owner.id, due: list.date, status: 'open', created_at: new Date().toISOString(), created_by: who || 'auto', note, source: { type: 'shotlist', id: list.id } });
  saveTasks(tasks); return owner.name;
}
app.post('/api/hq/shotlists/:slug/:id/task', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const list = (loadShotlists()[req.params.slug] || []).find(x => x.id === req.params.id); if (!list) return res.status(404).json({ error: 'Not found.' });
  try { res.json({ ok: true, owner: createShotTask(req.params.slug, list, me.name) }); } catch (e) { res.status(400).json({ error: e.message }); }
});


// Every shoot on the film calendar gets its shot list automatically, from Monday morning of its week, and the field team gets the task.
// On by default. Set AUTO_IDEAS=0 in Render to turn the automatic jobs off.
const AUTO_ON = () => process.env.AUTO_IDEAS !== '0';
async function autoShotlists() {
  if (!AUTO_ON() || !GOOGLE_CLIENT_ID) return;
  const et = etNow(), dow = et.getDay(), mon = new Date(et); mon.setDate(et.getDate() - ((dow + 6) % 7)); const monStr = ymdLocal(mon), sunStr = addDaysStr(monStr, 6);
  for (const uid of Object.keys(gUsers()).slice(0, 2)) {
    try {
      const tok = await userGmailToken(uid); if (!tok) continue; const auth = { Authorization: 'Bearer ' + tok };
      const cl = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', { headers: auth }); if (!cl.ok) continue;
      const cals = ((await cl.json()).items || []).filter(c => /film|shoot/i.test(c.summary || '')).slice(0, 3), clients = loadClients().filter(c => c.status !== 'internal');
      for (const cal of cals) {
        const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
        u.searchParams.set('timeMin', new Date(monStr + 'T00:00:00-05:00').toISOString()); u.searchParams.set('timeMax', new Date(sunStr + 'T23:59:00-04:00').toISOString()); u.searchParams.set('singleEvents', 'true'); u.searchParams.set('maxResults', '40');
        const r = await fetch(u, { headers: auth }); if (!r.ok) continue;
        for (const ev of ((await r.json()).items || [])) {
          const t = (ev.summary || '').toLowerCase(), date = (ev.start.dateTime || ev.start.date || '').slice(0, 10); if (!date || date < monStr || date > sunStr) continue;
          const c = clients.find(x => (x.match || []).concat([(x.name || '').toLowerCase()]).some(k => k && t.includes(k.toLowerCase())));
          if (!c || (loadShotlists()[c.slug] || []).some(x => x.date === date)) continue;
          try { const l = await makeShotlist(c.slug, date, 'auto'); createShotTask(c.slug, l, 'auto'); console.log('[shotlist] made', c.slug, date); } catch (e) { console.error('[shotlist] failed', c.slug, e.message); }
        }
      }
    } catch (e) { console.error('[shotlist] auto failed', e.message); }
  }
}
setTimeout(autoShotlists, process.env.AUTO_FAST ? 14e3 : 90e3); setInterval(autoShotlists, process.env.AUTO_FAST ? 60e3 : 60 * 60e3);


// ---------- Weekly content pack: the brain fills each client's content calendar, one week at a time ----------
const PACKS_FILE = path.join(DATA_DIR, 'packs.json');
function loadPacks() { return readJson(PACKS_FILE, {}); }
const DESIGNS = ['editorial', 'color_poster', 'notes_app', 'reminders_app', 'imessage', 'annotated', 'polaroid_wall', 'grid_card', 'big_number', 'review_card', 'ticket_offer'];
const DAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function loadPlans() {
  const dir = path.join(__dirname, 'data', 'plan'), out = { clients: {}, keydates: [], guardrails: {} };
  try { for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [k, v] of Object.entries(p.clients || {})) out.clients[k] = (out.clients[k] || []).concat(v); out.keydates.push(...(p.keydates || [])); Object.assign(out.guardrails, p.guardrails || {}); } } catch {}
  return out;
}
function weekDates(monday, days) { const m = new Date(monday + 'T12:00:00'); return days.map(d => { const x = new Date(m); x.setDate(m.getDate() + ((DAY_IDX[d] + 6) % 7)); return x.toISOString().slice(0, 10); }).sort(); }
function bizBefore(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); let c = 0; while (c < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) c++; } return d.toISOString().slice(0, 10); }
function clientContext(slug, c) {
  let brain = ''; try { brain = fs.readFileSync(path.join(BRAIN_DIR, slug + '.md'), 'utf8'); } catch {}
  if (!brain) throw new Error('This client has no brain file yet.');
  const sec = (re) => { const m = new RegExp('^## ' + re + '[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'mi').exec(brain); return m ? m[0].slice(0, 9000) : ''; };
  let fw = '', voc = ''; try { fw = fs.readFileSync(path.join(GUIDE_DIR, 'content-frameworks.md'), 'utf8').slice(0, 4200); } catch {} try { voc = fs.readFileSync(path.join(GUIDE_DIR, 'voice-of-customer.md'), 'utf8').slice(0, 2400); } catch {}
  return { brain: [sec('1\\.'), sec('2\\.'), sec('3\\.'), sec('4\\.'), sec('5\\.'), brainCopy(brain).slice(0, 15000), sec('8\\.|9\\.|10\\.'), sec('12\\.')].filter(Boolean).join('\n\n'), frameworks: fw + '\n\n' + voc };
}

// National holidays only (US-wide). Computed by rule so every year is covered.
function nthDow(y, m, dow, n) { const d = new Date(Date.UTC(y, m, 1)); let c = 0; while (true) { if (d.getUTCDay() === dow && ++c === n) return d; d.setUTCDate(d.getUTCDate() + 1); } }
function lastDow(y, m, dow) { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1); return d; }
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return new Date(Date.UTC(y, mo - 1, da)); }
function nationalHolidays(y) {
  const iso = d => d.toISOString().slice(0, 10), fix = (m, d) => new Date(Date.UTC(y, m, d)), thanks = nthDow(y, 10, 4, 4), bf = new Date(thanks); bf.setUTCDate(bf.getUTCDate() + 1);
  return [[fix(0, 1), "New Year's Day"], [nthDow(y, 0, 1, 3), 'Martin Luther King Jr. Day'], [fix(1, 14), "Valentine's Day"], [nthDow(y, 1, 1, 3), "Presidents' Day"], [easter(y), 'Easter'], [nthDow(y, 4, 0, 2), "Mother's Day"],
    [lastDow(y, 4, 1), 'Memorial Day'], [nthDow(y, 5, 0, 3), "Father's Day"], [fix(5, 19), 'Juneteenth'], [fix(6, 4), 'Independence Day'], [nthDow(y, 8, 1, 1), 'Labor Day'], [fix(9, 31), 'Halloween'],
    [fix(10, 11), 'Veterans Day'], [thanks, 'Thanksgiving'], [bf, 'Black Friday'], [fix(11, 24), 'Christmas Eve'], [fix(11, 25), 'Christmas Day'], [fix(11, 31), "New Year's Eve"]].map(([d, n]) => ({ date: iso(d), name: n }));
}
function holidaysBetween(a, b) { const y1 = +a.slice(0, 4), y2 = +b.slice(0, 4), out = []; for (let y = y1; y <= y2; y++) out.push(...nationalHolidays(y)); return out.filter(h => h.date >= a && h.date <= b).sort((x, y) => (x.date < y.date ? -1 : 1)); }
function addDaysStr(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
function promosFor(c, a, b) { return (c.promos || []).filter(p => p.start <= b && (p.end || p.start) >= a); }
app.get('/api/hq/holidays', (req, res) => { const a = String(req.query.from || ''), b = String(req.query.to || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return res.json({ holidays: [] }); res.json({ holidays: holidaysBetween(a, b) }); });
app.put('/api/hq/client/:slug/promos', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const all = loadClients(), c = all.find(x => x.slug === req.params.slug); if (!c) return res.status(404).json({ error: 'Unknown client.' });
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  c.promos = (Array.isArray(req.body && req.body.promos) ? req.body.promos : []).filter(p => p && p.name && ok(p.start)).slice(0, 20).map(p => ({ id: String(p.id || 'p_' + crypto.randomBytes(3).toString('hex')).slice(0, 20), name: String(p.name).slice(0, 120), start: p.start, end: ok(p.end) ? p.end : p.start, details: String(p.details || '').slice(0, 600), confirmed: !!p.confirmed }));
  c.promos_updated = new Date().toISOString(); c.saved = true; saveClients(all); res.json({ ok: true });
});

const PACK_RULES = `You are the Open Heart Media content planner. You write ONE WEEK of posts for ONE client, filling every slot you are given. The team will edit, design, caption and schedule exactly what you write.
Rules:
- CONFIRMED FACTS are verified and override the brain. Follow them first. Never narrow what the client does below what they say.
- Use only facts in the brain and confirmed facts. Never invent stats, awards, testimonials, prices, specs, names or dates. If something needs the client to confirm, put it in "verify".
- Obey the client's compliance and claims section. If it forbids something, do not write it. List the gates that apply to each post in "gates".
- Research-backed: every post uses a customer fear, desire or objection from the brain's customer-language section, a pattern from what is working, or a top post of the client. Say which in "basis" with its evidence label (OBSERVED, PROXY, HYPOTHESIS, TESTED, PROVEN). Nothing is PROVEN unless the brain says so.
- Vary the angle. Across the week cover different buyer levels (1 potential, 2 pain, 3 promise, 4 proof, 5 offer) and different formats. Organic goes first for levels 1 to 3.
- The plan's topics are the starting point, not a cage. NEW FOOTAGE comes first: if footage in the Drive folder (see FOOTAGE) fits a slot better than the planned topic, change that slot's topic to use it and say so in "change_reason" (set "changed" to true). Never move or drop a holiday, key-date or promo slot, and never break a client guardrail. In "uses" name the footage a Reel or graphic is built from (folder, subject or label). If a visit folder holds footage that is not named to standard, still plan around it and add to "verify" that it needs renaming and a look.
- When a Reel has no talking-head hook, the hook is text on screen in the first second: write it in "onscreen".
- For a Carousel, "onscreen" holds the copy for each card, written as Card 1, Card 2 and so on. For a Graphic it is the text on the graphic. Only Reels and talking heads use true on-screen video text.
- Series in CONFIRMED FACTS keep their cadence (for example one every two weeks) and are built from the footage named there. Every shoot under SHOOTS STILL BEING WORKED ON gets used across the coming weeks.
- Never leave a slot empty. With no recent footage, build from graphics and static ads, text-on-screen Reels, and the best footage already in the Drive folder (name it in "uses"), using proven topics from the brain and what is working.
- If NEW CONTENT JUST RECEIVED is given, replace the 1 or 2 weakest non-fixed slots (or as many as it takes if it describes a backlog of footage) with posts built from it (set "changed" true and "change_reason" to "New content received"). Do not change any other slot.
- Follow the FORMAT AND TEXT-ON-SCREEN RULES for this client exactly.
- Captions: work in one or two target keywords naturally, main keyword in the first line. Set "hashtags" to at most 5 tags per post (Instagram and Facebook), local and service tags first, then working tags from the list. Never invent a trending claim.
- If the slots come from the team's plan, keep each slot's date and type. (Topic may change only as described above.) If a topic says "Chris picks the clip" or "Pull from footage", the client picks existing footage: do not invent a topic. Write a hook frame and a caption with fill-in blanks marked VERIFY, and say what to look for in the archive.
- CLIPS. Every post says how many clips or photos to film in "clips": Reel 4 to 8 clips of 2 to 6 seconds, Talking head or Testimonial 1 take plus at most 2 b-roll clips, Carousel at most 5 photos, Graphic 0 or 1. Use archive footage first (clips 0 if nothing new is needed) and never ask for more than the post needs. The week total should be as small as it can be.
- Production reality: Reels are edits of footage (archive pull or the shoot) with the hook as on-screen text. Graphics are one designed frame. Carousels are 5 cards or fewer and at most 1 per week unless the client's schedule says otherwise. If the client does not film, every Reel needs an archive pull list and a stills fallback. Use the schedule note below for the client's real mix.
- Each post has: a one-breath hook (18 words or fewer, one person, one moment, one checkable detail), a shot list or archive pull list, on-screen text, and a caption with a hook, a body and a CTA. The CTA is one clear action.
- For Graphic and Carousel posts choose a design from this list: ${DESIGNS.join(', ')}. Vary the designs across the week.
- Platforms: say where it goes (Instagram, Facebook, LinkedIn). Time: use the best slot for that day (Mon 7 to 10 PM, Wed 8 to 9 AM, Thu 9 AM, Fri 6 to 8 AM) and say "schedule at Sprout best time" if the client has its own data.
- NATIONAL HOLIDAYS (listed in the request) are triggers. A holiday that falls on a slot, or the day after one, takes that slot as a holiday post in the client's own voice. If it falls on a day with no slot, use the closest slot before it. Only the holidays listed; never add local, niche or awareness days. Sensitive clients (health care, nonprofits, schools, veterans) get respectful posts with no sales. On Thanksgiving, Christmas and similar days use no offer and no CTA beyond the client's standard sign-off unless the client says otherwise. If the brain has holiday rules for this client, follow them.
- PROMOS (listed in the request) are triggers. Post about a promo only if it is marked CLIENT CONFIRMED, using the exact name, dates and terms given, with its real deadline. Start teasing 7 days before it begins. A promo marked NOT CONFIRMED must not be posted: put it in "notes" as waiting on the client. Never invent a discount, price or deadline.
- Copy rules: no em dashes or en dashes, American spelling, no hedges, no AI words (delve, elevate, unlock, seamless, robust, leverage, transform, game-changer, "it's not just X, it's Y"), numbers beat adjectives, front-load the point, sound unmistakably like this brand.
Return ONLY JSON in this shape, one row per slot, in date order:
{"theme":"","rows":[{"date":"YYYY-MM-DD","type":"Reel|Graphic|Carousel|Talking head|Testimonial","platforms":"","time":"","level":1,"clips":0,"idea":"","hook":"","shots":[""],"onscreen":"","design":"","caption":{"hook":"","body":"","cta":""},"basis":"","gates":[""],"verify":[""],"editing":"","trigger":"holiday name or promo name, or empty","keywords":[""],"hashtags":["#tag"],"uses":"footage used","changed":false,"change_reason":""}],"notes":""}`;
async function makePack(slug, monday, who, uid, opts) {
  opts = opts || {};
  const c = loadClients().find(x => x.slug === slug); if (!c) throw new Error('Unknown client.');
  const cad = c.cadence || {}, PL = loadPlans(), sundayD = addDaysStr(monday, 6);
  const planRows = (PL.clients[slug] || []).filter(r => r.date >= monday && r.date <= sundayD).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!planRows.length && !(cad.days || []).length) throw new Error('Set this client\'s posting days first (Edit details on the Overview tab).');
  let dates = planRows.length ? planRows.map(r => r.date) : weekDates(monday, cad.days); const ctx = clientContext(slug, c);
  if (opts.fromToday) { const t0 = ymdLocal(etNow()); dates = dates.filter(d => d >= t0); if (!dates.length) return null; }
  const planBy = new Map(planRows.map(r => [r.date, r])), gr = PL.guardrails[slug];
  const keyd = PL.keydates.filter(k => k.date && k.date >= monday && k.date <= sundayD).map(k => `${k.date} ${k.name}: ${k.what}`).join('\n');
  const sunday = addDaysStr(monday, 6), look = addDaysStr(monday, 13), hols = holidaysBetween(monday, look), pr = promosFor(c, monday, look);
  const hText = hols.length ? hols.map(h => h.date + ' ' + h.name + (h.date <= sunday ? ' (THIS WEEK)' : ' (next week, tease only if it fits)')).join('; ') : 'none';
  const pText = pr.length ? pr.map(p => `${p.name}: ${p.start} to ${p.end}. ${p.details || ''} [${p.confirmed ? 'CLIENT CONFIRMED' : 'NOT CONFIRMED, do not post'}]`).join('\n') : 'none';
  let invText = 'Drive inventory not available. Do not guess what footage exists.'; try { const u2 = uid || Object.keys(gUsers())[0]; if (u2) invText = inventoryText(await getInventory(u2, c)); } catch {}
  let wipText = '(none found)'; try { const u2 = uid || Object.keys(gUsers())[0]; const iv = u2 && await getInventory(u2, c); const cut = Date.now() - 45 * 864e5; const w = iv ? iv.folders.filter(f => Date.parse(f.newest || f.created || 0) > cut) : []; if (w.length) wipText = w.map(f => `- ${f.path} (${f.videos} videos, ${f.images} photos, shot or uploaded ${f.newest || f.created})`).join('\n'); } catch {}
  const usedText = Object.values(loadPacks()[slug] || {}).sort((a, b) => a.week < b.week ? 1 : -1).slice(0, 3).flatMap(p => (p.rows || []).filter(r => r.uses).map(r => `${p.week} ${r.date}: ${r.uses}`)).join('\n') || '(nothing recorded yet)';
  const fmt = formatRules(slug);
  const user = `CLIENT: ${c.name} (code ${c.code || ''})\nWEEK STARTING (Monday): ${monday}\nNATIONAL HOLIDAYS: ${hText}\nPROMOS: ${pText}\nSLOTS TO FILL (one post each)${planRows.length ? ' (FIXED BY THE TEAM\'S PLAN: keep each slot\'s date, type and topic and build it out)' : ''}:\n${dates.map(d => { const p = planBy.get(d); return d + ' ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T12:00:00').getDay()] + (p ? ' | ' + p.type + ' | ' + p.topic + (p.flag ? ' | HOLIDAY, KEY DATE OR PROMO' : '') : ''); }).join('\n')}\nSCHEDULE NOTE FROM THE TEAM: ${cad.note || '(none)'}\nKEY DATES THIS WEEK (team plan):\n${keyd || 'none'}\n${gr ? 'LOOK AND TONE: ' + gr.look + '\nTEAM GUARDRAILS: ' + gr.rules + '\n' : ''}\nCONFIRMED FACTS (override the brain):\n${readFacts(slug).slice(0, 4000) || '(none confirmed yet)'}\n\nFOOTAGE IN THE CLIENT'S DRIVE FOLDER RIGHT NOW (use the newest first):\n${invText}\n\nSHOOTS STILL BEING WORKED ON (every one of these must get used; spread their footage over the coming weeks and do not leave any unused):\n${wipText}\nALREADY USED IN RECENT PACKS (do not repeat the same footage for the same idea):\n${usedText}${opts.newFiles ? '\n\nNEW CONTENT JUST RECEIVED (build from this first):\n' + opts.newFiles : ''}\n\nFORMAT AND TEXT-ON-SCREEN RULES FOR THIS CLIENT:\n${fmt}\n\nKEYWORDS AND HASHTAGS FOR THIS CLIENT (evergreen tags, target keywords, and this week's working tags if present):\n${readHashtags(slug).slice(0, 3000) || '(none saved yet: derive 1 or 2 target keywords and local and service tags from the confirmed facts and brain; do not claim any tag is trending)'}\n\nWHAT IS WORKING NOW (client's own top posts):\n${readWorking(slug).slice(0, 5000) || '(none provided)'}\n\nFRAMEWORKS TO APPLY:\n${ctx.frameworks}\n\nCLIENT BRAIN (the source of truth):\n${ctx.brain}`;
  const out = await aiJson(PACK_RULES, user, 8000);
  const clean = (x) => String(x == null ? '' : x).replace(/—|–/g, ',').trim();
  const strs = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, 10);
  const byDate = new Map((Array.isArray(out.rows) ? out.rows : []).map(r => [String(r.date || '').slice(0, 10), r]));
  const rows = dates.map(d => {
    const r = byDate.get(d) || {}, pr = planBy.get(d); const t = pr ? pr.type : (/carousel/i.test(r.type) ? 'Carousel' : /graphic/i.test(r.type) ? 'Graphic' : 'Reel');
    return { date: d, type: t, platforms: clean(r.platforms), time: clean(r.time), level: Number(r.level) || 0, clips: Math.min(10, Math.max(0, Number(r.clips) || 0)), idea: clean(r.idea), hook: clean(r.hook), shots: strs(r.shots), onscreen: clean(r.onscreen),
      design: (t === 'Graphic' || t === 'Carousel') ? clean(r.design) : '', topic: pr ? pr.topic : '', planned: !!pr, caption: { hook: clean(r.caption && r.caption.hook), body: clean(r.caption && r.caption.body), cta: clean(r.caption && r.caption.cta) },
      basis: clean(r.basis), gates: strs(r.gates), verify: strs(r.verify), editing: clean(r.editing), trigger: clean(r.trigger), uses: clean(r.uses), keywords: strs(r.keywords).slice(0, 3), hashtags: cleanTags(r.hashtags), changed: !!r.changed && !(pr && pr.flag), change_reason: clean(r.change_reason), missing: !byDate.has(d) };
  });
  if (opts.prev) { const todayS = ymdLocal(etNow()), pm = new Map((opts.prev.rows || []).map(r => [r.date, r])); rows.forEach((r, i) => { const o = pm.get(r.date); const take = r.changed && r.date >= todayS && !(o && o.trigger); if (!take && o) rows[i] = o; }); }
  const pack = { week: monday, at: new Date().toISOString(), by: who || 'auto', theme: clean(out.theme), notes: clean(out.notes), rows, basis: { working: !!readWorking(slug), facts: !!readFacts(slug) }, inputs: { holidays: hols.filter(h => h.date <= sunday).map(h => h.name), promoStamp: c.promos_updated || '' }, released: null };
  const all = loadPacks(); all[slug] = Object.assign({}, all[slug] || {}); const prev = all[slug][monday]; if (prev && prev.released) pack.released = prev.released; if (opts.prev) { pack.theme = opts.prev.theme || pack.theme; pack.notes = opts.prev.notes || pack.notes; } all[slug][monday] = pack;
  fs.writeFileSync(PACKS_FILE, JSON.stringify(all, null, 2)); return pack;
}
app.get('/api/hq/packs/:slug', (req, res) => {
  const c = loadClients().find(x => x.slug === req.params.slug) || {}, p = loadPacks()[String(req.params.slug)] || {};
  res.json({ packs: Object.values(p).sort((a, b) => a.week < b.week ? 1 : -1).slice(0, 8).map(k => ({ ...k, stale: !k.released && !!(c.promos_updated && c.promos_updated !== ((k.inputs || {}).promoStamp || '')) && promosFor(c, k.week, addDaysStr(k.week, 13)).length > 0 })), promos: c.promos || [] });
});
app.post('/api/hq/packs/:slug', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const w = String((req.body && req.body.week) || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(w) || new Date(w + 'T12:00:00').getDay() !== 1) return res.status(400).json({ error: 'Pick a week that starts on a Monday.' });
  const slug = String(req.params.slug); res.json({ job: startJob(() => makePack(slug, w, me.name, me.id)) });
});
function releasePack(slug, week, whoName) {
  const all = loadPacks(), pack = (all[slug] || {})[week]; if (!pack) throw new Error('No pack for that week.'); if (pack.released) throw new Error('This pack was already released.');
  const c = loadClients().find(x => x.slug === slug), today = new Date().toISOString().slice(0, 10), tasks = loadTasks(), made = [];
  const clip = (t, n) => String(t || '').slice(0, n);
  const mk = (lane, title, rows, leadDays) => {
    if (!rows.length) return; const owner = ownerFor(c, lane); if (!owner) return;
    const fd = fridayDue();
    const note = rows.map(r => `${r.date} ${r.type}: ${clip(r.hook || r.idea, 110)}`).join('\n').slice(0, 1000);
    const t = { id: 't_' + crypto.randomBytes(5).toString('hex'), title, client: slug, lane, owner: owner.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: new Date().toISOString(), created_by: 'pack', note, source: { type: 'pack', slug, week } };
    tasks.push(t); made.push({ title: t.title, owner: owner.name, due: fd.due });
  };
  const wk = week.slice(5).replace('-', '/'), reels = pack.rows.filter(r => r.type === 'Reel'), gfx = pack.rows.filter(r => r.type !== 'Reel');
  mk('content', `Edit ${reels.length} reel${reels.length > 1 ? 's' : ''}: ${c.name}, week of ${wk}`, reels, 2);
  mk('graphics', `Design ${gfx.length} post${gfx.length > 1 ? 's' : ''}: ${c.name}, week of ${wk}`, gfx, 2);
  mk('copy', `Captions and scheduling: ${c.name}, week of ${wk} (${pack.rows.length} posts)`, pack.rows, 1);
  saveTasks(tasks); pack.released = { at: new Date().toISOString(), by: whoName || 'auto' }; fs.writeFileSync(PACKS_FILE, JSON.stringify(all, null, 2)); return made;
}
app.post('/api/hq/packs/:slug/:week/release', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  try { res.json({ ok: true, tasks: releasePack(String(req.params.slug), String(req.params.week), me.name) }); } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

// Winners: posts that worked. They feed the next packs as proven formats and become ad creative work for the ads owner.
const WINNERS_FILE = path.join(DATA_DIR, 'winners.json');
app.get('/api/hq/winners/:slug', (req, res) => { if (!authedUser(req)) return res.status(401).json({ error: 'auth required' }); res.json({ winners: (readJson(WINNERS_FILE, {})[String(req.params.slug)] || []).slice(0, 30) }); });
app.post('/api/hq/winners/:slug', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Sign in with your own login.' });
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/g, ''), c = loadClients().find(x => x.slug === slug); if (!c) return res.status(404).json({ error: 'Unknown client.' });
  const b = req.body || {}, t = (k, n) => String(b[k] || '').replace(/—|–/g, ',').trim().slice(0, n);
  const w = { id: 'w_' + crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), by: me.name, platform: t('platform', 40), post: t('post', 300), why: t('why', 400), concept: t('concept', 200), angle: t('angle', 200) };
  if (!w.post) return res.status(400).json({ error: 'Say which post it was (a link or a short description).' });
  const all = readJson(WINNERS_FILE, {}); all[slug] = [w].concat(all[slug] || []).slice(0, 60); fs.writeFileSync(WINNERS_FILE, JSON.stringify(all, null, 2));
  try { fs.mkdirSync(WORKING_LIVE, { recursive: true }); fs.writeFileSync(path.join(WORKING_LIVE, slug + '.md'), readWorking(slug).trimEnd() + `\n- WINNER marked ${w.at.slice(0, 10)} by ${w.by} (${w.platform || 'platform not given'}): ${w.post}. Why it worked: ${w.why || 'not given'}. Concept: ${w.concept || 'not given'}. Angle: ${w.angle || 'not given'}.\n`); } catch {}
  const owner = ownerFor(c, 'ads'), fd = fridayDue(); let task = null;
  if (owner) { const tasks = loadTasks(); task = { id: 't_' + crypto.randomBytes(5).toString('hex'), title: `Add winner to the campaign creative: ${c.name}`, client: slug, lane: 'ads', owner: owner.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: w.at, created_by: 'winners', note: `Winning post: ${w.post}\nWhy it worked: ${w.why}\nConcept: ${w.concept}\nAngle: ${w.angle}\nAdd it to the concept, angle and creatives for the campaigns. Do not boost the post.`, source: { type: 'winner', slug, id: w.id } }; tasks.push(task); saveTasks(tasks); }
  res.json({ ok: true, winner: w, task: !!task });
});
// Every Monday each ads owner gets one "what worked last week" check per client.
function weeklyReviewTasks() {
  const cur = mondayOf(etNow()), tasks = loadTasks(); let n = 0;
  for (const c of loadClients().filter(x => ['active', 'seasonal'].includes(x.status))) {
    if (tasks.some(t => t.source && t.source.type === 'review' && t.source.slug === c.slug && t.source.week === cur)) continue;
    const owner = ownerFor(c, 'ads'); if (!owner) continue; const fd = fridayDue();
    tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title: `What worked last week: ${c.name}. Mark any winners.`, client: c.slug, lane: 'ads', owner: owner.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: new Date().toISOString(), created_by: 'review', note: 'Open the client page, Weekly pack tab, Winners. Add any post that clearly worked. Winners go into the next packs and into the campaign creative.', source: { type: 'review', slug: c.slug, week: cur } }); n++;
  }
  if (n) { saveTasks(tasks); console.log('[review] tasks', n); }
}

// Weekly rhythm. Monday 6 AM Eastern: the pack for the following week is released and each person sees what they are making. Everything is due that Friday at 5:00 PM.
// The pack is written from Thursday on, so it is ready by Monday. Set AUTO_IDEAS=0 in Render to turn this off.
async function autoPacks() {
  if (!AUTO_ON()) return;
  const et = etNow(), dow = et.getDay(), hr = et.getHours(), M = upcomingMonday(), T = addDaysStr(M, 7);
  if (dow === 1 && hr >= 6) { try { weeklyReviewTasks(); } catch (e) { console.error('[review] failed', e.message); } }
  const eligible = loadClients().filter(x => ['active', 'seasonal', 'onboarding'].includes(x.status) && ((x.cadence || {}).days && x.cadence.days.length || (loadPlans().clients[x.slug] || []).length));
  for (const c of eligible) {
    try {
      let have = (loadPacks()[c.slug] || {})[T];
      if (!have && (dow === 0 || dow >= 4 || dow === 1)) { have = await makePack(c.slug, T, 'auto'); console.log('[pack] made', c.slug, T); }
      if (dow === 1 && hr >= 6 && have && !have.released) { releasePack(c.slug, T, 'auto'); console.log('[pack] released', c.slug, T); }
    } catch (e) { console.error('[pack] failed', c.slug, e.message); }
  }
}

// New content arrived: swap it into this week's or next week's calendar, replacing the weakest open slot. Already-released packs get a task for each swapped post.
async function rebuildForNewContent(slug, uid, filesText, o) {
  o = o || {}; const todayS = ymdLocal(etNow()), cur = mondayOf(etNow()), c = loadClients().find(x => x.slug === slug); if (!c) return;
  invCache.delete(uid + ':' + slug);
  for (const monday of (o.weeks || [cur, addDaysStr(cur, 7)])) {
    const prev = (loadPacks()[slug] || {})[monday];
    if (!prev) { if (!o.createMissing) continue; const np = await makePack(slug, monday, 'auto: backlog', uid, { newFiles: filesText, fromToday: monday === cur }); if (np) { if (monday <= addDaysStr(cur, 7)) { try { releasePack(slug, monday, 'auto'); } catch {} } console.log('[catchup] made', slug, monday); } continue; }
    const before = new Map(prev.rows.map(r => [r.date, JSON.stringify(r)]));
    const pack = await makePack(slug, monday, 'auto: new content', uid, { newFiles: filesText, prev, fromToday: monday === cur }); if (!pack) continue;
    const swapped = pack.rows.filter(r => before.get(r.date) !== JSON.stringify(r) && r.changed);
    if (!swapped.length) continue;
    console.log('[pack] swapped', slug, monday, swapped.map(r => r.date).join(','));
    if (pack.released) {
      const tasks = loadTasks(), fd = fridayDue();
      for (const r of swapped) for (const lane of [r.type === 'Reel' ? 'content' : 'graphics', 'copy']) { const owner = ownerFor(c, lane); if (!owner) continue; tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title: `Changed post, ${r.date}: ${c.name}`, client: slug, lane, owner: owner.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: new Date().toISOString(), created_by: 'pack', note: `New content received. ${r.change_reason}\n${String(r.hook || r.idea).slice(0, 200)}\nUses: ${r.uses}`, source: { type: 'pack', slug, week: monday } }); }
      saveTasks(tasks);
    }
  }
}

// One-time catch-up for the footage that arrived before everything was labeled: work it into the rest of this month's calendars.
const CATCHUP_FILE = path.join(DATA_DIR, 'catchup_nov2026.json');
async function autoCatchup() {
  if (!AUTO_ON() || !GOOGLE_CLIENT_ID) return; const uid = Object.keys(gUsers())[0]; if (!uid) return;
  const done = readJson(CATCHUP_FILE, {}), cur = mondayOf(etNow()), weeks = [0, 7, 14, 21, 28, 35].map(n => addDaysStr(cur, n));
  if (!done['carver-task']) {
    const hi = loadUsers().find(u => /hiroshi/i.test(u.name || '')), c = loadClients().find(x => x.slug === 'carver-plumbing');
    if (hi && c) { const tasks = loadTasks(), fd = fridayDue(); tasks.push({ id: 't_' + crypto.randomBytes(5).toString('hex'), title: 'Carver Plumbing videos: edit and deliver', client: 'carver-plumbing', lane: 'content', owner: hi.id, due: fd.due, due_time: fd.due_time, status: 'open', created_at: new Date().toISOString(), created_by: 'zac', note: 'Carver videos are due Friday at 5 PM. Two more testimonial interviews are still to be filmed (see the client facts).', source: { type: 'manual', slug: 'carver-plumbing' } }); saveTasks(tasks); done['carver-task'] = new Date().toISOString(); fs.writeFileSync(CATCHUP_FILE, JSON.stringify(done)); console.log('[catchup] carver task for', hi.name); }
    else console.log('[catchup] carver task skipped: no login for Hiroshi yet');
  }
  for (const slug of ['sun-and-shield', 'vnphc', 'bkvf', 'adnormous', 'ifab', 'urc', 'carver-plumbing']) {
    if (done[slug]) continue;
    try {
      const txt = 'BACKLOG OF RECENT FOOTAGE that has not been used yet. Place all of it across these weeks, one piece per open slot, newest and strongest first. Read the CONFIRMED FACTS and the SHOOTS STILL BEING WORKED ON list.\n' + (readFacts(slug) || '').slice(0, 2500);
      await rebuildForNewContent(slug, uid, txt, { weeks, createMissing: true }); done[slug] = new Date().toISOString(); fs.writeFileSync(CATCHUP_FILE, JSON.stringify(done)); console.log('[catchup] done', slug);
    } catch (e) { console.error('[catchup] failed', slug, e.message); }
  }
}
setTimeout(autoCatchup, process.env.AUTO_FAST ? 20e3 : 240e3);
setTimeout(autoPacks, process.env.AUTO_FAST ? 16e3 : 120e3); setInterval(autoPacks, process.env.AUTO_FAST ? 60e3 : 60 * 60e3);

app.post('/api/me/gmail/disconnect', (req, res) => {
  const me = authedUser(req); if (!me || me.legacy) return res.status(400).json({ error: 'Not signed in.' });
  const all = gUsers(); delete all[me.id]; saveGUsers(all); mailCache.delete(me.id); calCache.delete(me.id); res.json({ ok: true });
});

const STOP_RE = /^\s*(stop|unsubscribe|remove me|take me off|opt out|no thanks,? ?stop)\b/i;

// A prospect who replies from a different mailbox at the same company is still that prospect, so
// the domain is a fallback. Free mail hosts are excluded from that rule for obvious reasons.
const FREEMAIL = /^(gmail|yahoo|hotmail|outlook|live|aol|icloud|me|msn|comcast|bellsouth|att|verizon|proton|protonmail)\./i;
function prospectForSender(addr) {
  const email = String(addr || '').toLowerCase().trim();
  if (!email.includes('@')) return null;
  const exact = prospects.find(p => (p.sent_at || p.seq_anchor_at) && (p.email || '').toLowerCase().trim() === email);
  if (exact) return exact;
  const dom = email.split('@')[1];
  if (!dom || FREEMAIL.test(dom)) return null;
  return prospects.find(p => {
    if (!p.sent_at && !p.seq_anchor_at) return false;
    const pd = (p.email || '').toLowerCase().split('@')[1];
    return pd && pd === dom;
  }) || null;
}

async function checkGmailReplies() {
  if (!GOOGLE_CLIENT_ID || !gmailToken()) return 0;
  const tok = await gmailAccessToken();
  if (!tok) return 0;
  const auth = { Authorization: `Bearer ${tok}` };
  // Bounded window, and never our own outbound.
  const q = encodeURIComponent('newer_than:3d -in:sent -in:chats');
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${q}`, { headers: auth });
  if (!listRes.ok) { console.error('[gmail] list failed', listRes.status); return 0; }
  const { messages = [] } = await listRes.json();
  const seen = gmailSeen();
  let hits = 0;
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const detRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: auth });
    if (!detRes.ok) continue;
    const det = await detRes.json();
    const hdr = Object.fromEntries((det.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const from = (hdr.from || '').match(/<([^>]+)>/)?.[1] || (hdr.from || '');
    const p = prospectForSender(from);
    if (!p) continue;
    const now = new Date().toISOString();
    const snippet = det.snippet || '';
    const isStop = STOP_RE.test(snippet) || STOP_RE.test(hdr.subject || '');
    if (!Array.isArray(p.notes)) p.notes = [];
    if (isStop) {
      const firstStop = !p.unsubscribed_at;
      p.unsubscribed_at = p.unsubscribed_at || now;
      p.status = 'rejected';
      // Somebody who asks to stop gets one short confirmation back, and only the first time. Sent
      // straight through sgMail, not sendMail: sendMail refuses unsubscribed leads, and an opt-out
      // confirmation must not carry an unsubscribe footer.
      if (firstStop && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(from) && !/no-?reply|mailer-daemon|postmaster/i.test(from)) {
        try {
          const text = `You're unsubscribed. Thank you for letting us know, and sorry for the interruption.\n\nWe will not contact you again.${transactionalFooter()}`;
          await sgMail.send({
            to: from,
            from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
            subject: "You're unsubscribed",
            text, html: textToHtml(text),
          });
          p.notes.push({ ts: now, by: null, text: 'Sent the unsubscribe confirmation.' });
        } catch (e) { console.error('[gmail] unsubscribe confirmation failed', e.message); }
      }
      p.notes.push({ ts: now, by: null, text: `Replied asking to stop. Suppressed. "${snippet.slice(0, 120)}"` });
    } else if (p.status !== 'booked' && p.status !== 'won') {
      p.status = 'replied';
      p.replied_at = p.replied_at || now;
      p.notes.push({ ts: now, by: null, text: `Replied: "${snippet.slice(0, 160)}"` });
    } else { continue; }
    p.updated_at = now;
    hits++;
    try {
      if (notifyTargets('a reply').length) {
        await sgMail.sendMultiple({
          to: SALES,
          from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
          subject: isStop ? `Opt out: ${p.business || from}` : `Reply from ${p.business || from}`,
          text: `${isStop ? 'They asked to be removed and have been suppressed.' : 'They replied. The follow up sequence is stopped.'}\n\n`
            + `Business: ${p.business || 'unknown'}\nFrom: ${from}\nSubject: ${hdr.subject || ''}\n\n${snippet}\n\n`
            + `The full message is in the mailbox as normal.`,
        });
      }
    } catch (e) { console.error('[gmail] notify failed', e.message); }
  }
  if (hits) { try { save(prospects); } catch (e) { console.error('[gmail] save failed', e.message); } }
  saveGmailSeen(seen);
  if (hits) console.log('[gmail]', hits, 'replies matched to leads');
  return hits;
}

app.get('/api/gmail/status', (_, res) => {
  res.json({ configured: !!GOOGLE_CLIENT_ID, connected: !!gmailToken(), redirect: GMAIL_REDIRECT });
});
app.post('/api/gmail/check', async (_, res) => {
  try { res.json({ matched: await checkGmailReplies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

setInterval(() => { checkGmailReplies().catch(e => console.error('[gmail]', e.message)); }, 5 * 60 * 1000);
setTimeout(() => { checkGmailReplies().catch(() => {}); }, 60 * 1000);

// ---------- SendGrid delivery events ----------
// Sending was previously a one way street: sendMail reported whether SendGrid ACCEPTED the
// message, and nothing after that. A real bounce arrives minutes or hours later, asynchronously,
// so a dead address stayed 'sent' and then collected follow ups on days 3, 7 and 10. On a scraped
// list that is four hits on a mailbox that does not exist, repeated across however many bad rows
// the list carries, which is exactly how a young sending domain gets throttled.
//
// Every message already leaves with customArgs.prospect_id attached, so SendGrid hands the lead
// back to us in the event payload and no matching heuristics are needed. Email is only a fallback
// for anything sent before that was true.
const SG_EVENT_TOKEN = crypto.createHmac('sha256', AUTH_SECRET).update('sendgrid-events-v1').digest('hex').slice(0, 32);
function sgEventUrl() { return `${PUBLIC_URL}/api/sendgrid-events?k=${SG_EVENT_TOKEN}`; }

app.post('/api/sendgrid-events', async (req, res) => {
  // The URL carries an unguessable token derived from AUTH_SECRET. Anyone who cannot read the
  // server env cannot post here, and rotating AUTH_SECRET rotates this with it.
  const given = String(req.query.k || '');
  const want = Buffer.from(SG_EVENT_TOKEN);
  const got = Buffer.from(given);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(403).end();
  res.status(200).end();                       // ack immediately, SendGrid retries on anything else

  const batch = Array.isArray(req.body) ? req.body : [];
  let changed = 0;
  const complaints = [];
  for (const ev of batch) {
    const p = (ev.prospect_id && prospects.find(x => String(x.id) === String(ev.prospect_id)))
      || (ev.email && prospects.find(x => (x.email || '').toLowerCase() === String(ev.email).toLowerCase()));
    if (!p) continue;
    const now = new Date().toISOString();
    const park = (why) => {
      if (p.status !== 'unreachable') { p.status = 'unreachable'; changed++; }
      p.updated_at = now; p.last_send_error = why;
      if (!Array.isArray(p.notes)) p.notes = [];
      p.notes.push({ ts: now, by: null, text: why });
    };
    switch (ev.event) {
      case 'delivered':
        if (!p.delivered_at) { p.delivered_at = now; changed++; }
        break;
      case 'bounce':
        // 'blocked' is a receiving server saying not right now; a real bounce is the address
        // being wrong. Only the latter is permanent.
        if (ev.type === 'blocked') {
          p.soft_bounces = (p.soft_bounces || 0) + 1; changed++;
          if (p.soft_bounces >= 3) {
            p.bounced_at = p.bounced_at || now;
            park(`Blocked by the receiving server ${p.soft_bounces} times. Parked.`);
          }
        } else {
          p.bounced_at = p.bounced_at || now;
          park(`Hard bounce: ${ev.reason || 'address rejected'}`);
        }
        break;
      case 'dropped':
        // SendGrid refused to even attempt it, usually because the address is already suppressed.
        p.bounced_at = p.bounced_at || now;
        park(`Dropped before sending: ${ev.reason || 'on the suppression list'}`);
        break;
      case 'spamreport':
        // The most expensive event there is. Suppress permanently and tell someone.
        p.unsubscribed_at = p.unsubscribed_at || now;
        p.complained_at = p.complained_at || now;
        p.status = 'rejected'; p.updated_at = now; changed++;
        if (!Array.isArray(p.notes)) p.notes = [];
        p.notes.push({ ts: now, by: null, text: 'Marked this as spam. Suppressed permanently.' });
        complaints.push(p);
        break;
      case 'unsubscribe':
      case 'group_unsubscribe':
        if (!p.unsubscribed_at) {
          p.unsubscribed_at = now; p.status = 'rejected'; p.updated_at = now; changed++;
          if (!Array.isArray(p.notes)) p.notes = [];
          p.notes.push({ ts: now, by: null, text: 'Unsubscribed via SendGrid.' });
        }
        break;
      case 'open':
        // Weaker signal than a click, but it separates "the subject worked and the
        // offer did not" from "they never saw it", and those need different copy.
        if (!p.opened_at) { p.opened_at = now; changed++; }
        p.open_count = (p.open_count || 0) + 1;
        if (p.status === 'sent') { p.status = 'opened'; changed++; }
        break;
      case 'click':
        if (!p.clicked_at) { p.clicked_at = now; changed++; }
        if (!p.viewed_at) p.viewed_at = now;
        if (p.status === 'sent' || p.status === 'opened') { p.status = 'clicked'; changed++; }
        break;
      default: break;                          // processed, deferred and the rest are noise here
    }
  }
  if (changed) { try { save(prospects); } catch (e) { console.error('[sg-events] save failed -', e.message); } }
  if (complaints.length) {
    const rows = complaints.map(p => `${esc(p.business || p.id)} (${esc(p.email || '')})`).join('<br/>');
    await alertTeam('Spam complaint', `A recipient marked our cold email as spam.<br/><br/>${rows}<br/><br/>They are suppressed and will not be contacted again. Complaints are the fastest way to lose the sending domain, so if this happens more than once in a batch it is worth pausing and rereading the copy before sending more.`).catch(() => {});
  }
  if (batch.length) console.log('[sg-events]', batch.length, 'events,', changed, 'leads updated');
});

async function alertTeam(subject, html) {
  if (!process.env.SENDGRID_API_KEY) return;
  const to = NOTIFY;
  await sgMail.send({ to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME }, subject: `[OHM] ${subject}`, html });
}
if (process.env.CANARY_ENABLED !== 'false') {
  const canaryTimer = setInterval(() => { runCanary().catch(e => console.error('[canary]', e.message)); }, 60 * 60 * 1000);
  if (canaryTimer.unref) canaryTimer.unref();
  setTimeout(() => { runCanary().catch(e => console.error('[canary]', e.message)); }, 90 * 1000); // once shortly after boot
}

// Reliability endpoint for the team. Locked behind the same login as the dashboard.
// Full health stays behind the login: recentFailures carries prospect names and sites.
app.get('/api/health', (_, res) => res.json(auditHealth()));
// Liveness only, deliberately free of prospect data, so an external uptime monitor can reach it.
app.get('/healthz', (_, res) => {
  const h = auditHealth();
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), inFlight: h.inFlight, queued: h.queued,
             last24hSuccessRate: h.last24h.successRate });
});

// Poll target for the landing page. Public (matches the /api/audit prefix in PUBLIC_PATHS).
app.get('/api/audit/status/:id', (req, res) => {
  const job = auditJobs.get(req.params.id);
  if (!job) return res.status(404).json({ state: 'unknown', error: 'That scan expired. Please run it again.' });
  if (job.state === 'done') return res.json({ state: 'done', ...job.result });
  if (job.state === 'error') return res.json({ state: 'error', error: job.error });
  const stage = job.state === 'queued'
    ? (auditQueue.findIndex(q => q.jobId === req.params.id) > 0 ? 'Waiting in line, starting shortly' : 'Starting your scan')
    : job.stage;
  return res.json({ state: 'running', stage, elapsedMs: Date.now() - job.startedAt });
});

app.post('/api/audit', async (req, res) => {
  const { ref, email, goal, website, test } = req.body || {};
  const firstName = (req.body?.firstName || '').trim();
  const lastName = (req.body?.lastName || '').trim();
  // Campaign landing pages send a phone number and their traffic source alongside the scan. The
  // scan itself does not need either, but a lead with a phone number is worth calling and a lead
  // with a source is the only way to tell paid traffic from cold email later.
  const phone = String(req.body?.phone || '').trim().slice(0, 40);
  const bizTyped = String(req.body?.business || '').trim().slice(0, 200);
  const campaign = {};
  for (const k of ['source', 'page', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']) {
    const v = String(req.body?.[k] || '').trim().slice(0, 300);
    if (v) campaign[k] = v;
  }
  if (!firstName || !lastName) return res.status(400).json({ error: 'first and last name required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  if (!website || !website.trim()) return res.status(400).json({ error: 'website required' });
  // Validate before anything is enqueued, so a mistyped or pasted-tracking-link address comes back
  // to the lead immediately instead of becoming a scan of the wrong thing.
  const resolved = await resolveSiteUrl(website);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const isTest = test === true || test === 'true';
  const p = !isTest && ref && prospects.find(x => x.id === ref);
  const lookup = isTest && ref && prospects.find(x => x.id === ref); // for test GBP/name only, no writes
  const site = resolved.url || (p && p.website) || (lookup && lookup.website) || '';
  const bizName = (p && p.business) || (lookup && lookup.business) || null;
  const bizCity = (p && p.city) || (lookup && lookup.city) || null;
  const bizCategory = (p && p.category) || (lookup && lookup.category) || null;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!isTest && rateLimited(ip)) {
    return res.status(429).json({ error: 'You have run several scans already. Please give it an hour, or book a call and we will walk you through it.' });
  }

  // Capture the lead BEFORE scanning. Someone who typed their name, email and website into the
  // form is worth money whether or not the scan succeeds. Previously the record was only written
  // after a successful scan, so any failure lost the lead silently.
  let leadRow = p || null;
  if (!isTest) {
    const nowIso = new Date().toISOString();
    if (leadRow) {
      leadRow.contact_first = firstName; leadRow.contact_last = lastName;
      leadRow.contact_name = `${firstName} ${lastName}`.trim();
      leadRow.audit_email = email; leadRow.audit_goal = goal || null;
      if (phone) leadRow.phone = leadRow.phone || phone;
      if (bizTyped) leadRow.business = leadRow.business || bizTyped;
      if (Object.keys(campaign).length) leadRow.campaign = { ...(leadRow.campaign || {}), ...campaign };
      if (!['audited', 'booked', 'won', 'replied'].includes(leadRow.status)) leadRow.status = 'audit_requested';
      leadRow.audit_requested_at = nowIso; leadRow.updated_at = nowIso;
    } else {
      // Organic visitor with no ref: create a new lead so they are not lost.
      leadRow = {
        id: 'W' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
        business: bizTyped, category: '', city: '', phone, website: site,
        rating: '', reviews: '', email, subject: '', body: '', notes: '',
        handled_by: '', deal_value: '',
        contact_first: firstName, contact_last: lastName, contact_name: `${firstName} ${lastName}`.trim(),
        audit_email: email, audit_goal: goal || null,
        status: 'audit_requested', source: campaign.source || 'self_serve',
        campaign: Object.keys(campaign).length ? campaign : undefined,
        audit_requested_at: nowIso, updated_at: nowIso,
      };
      prospects.push(leadRow);
    }
    try { save(prospects); } catch (e) { console.error('[audit] lead capture save failed -', e.message); }
  }

  const jobId = crypto.randomBytes(12).toString('hex');
  enqueueAudit(jobId, { ref, email, goal, firstName, lastName, isTest, site, p: leadRow && !isTest ? leadRow : p, lookup, bizName: bizName || (leadRow && leadRow.business) || null, bizCity, bizCategory });
  res.status(202).json({ jobId, state: 'queued' });
});


// ---------- Lead magnet: the "Free guide" modal on the marketing site ----------
// The site lives on a different origin (and inside a sandboxed artifact frame while it is being
// designed), so this needs CORS and it cannot rely on a redirect. It answers JSON and the modal
// stays put.
//
// The guide is ATTACHED rather than only linked. A link alone means the lead has to click twice
// and the second click happens in a mail client we do not control. It also goes through sendMail
// like everything else, so the CAN-SPAM footer, the unsubscribe link and the address check are
// applied here exactly as they are on a cold send. There is deliberately no second path.
const GUIDE_PDF = path.join(__dirname, 'public', 'guide', 'rank-higher-without-us.pdf');
const GUIDE_URL = `${PUBLIC_URL}/guide/rank-higher-without-us.pdf`;
const SUB_RATE_MAX = Number(process.env.SUBSCRIBE_RATE_MAX || 4);
const subHits = new Map();
function subscribeRateLimited(ip) {
  const now = Date.now();
  const hits = (subHits.get(ip) || []).filter(t => now - t < AUDIT_RATE_WINDOW_MS);
  if (hits.length >= SUB_RATE_MAX) { subHits.set(ip, hits); return true; }
  hits.push(now); subHits.set(ip, hits);
  if (subHits.size > 5000) for (const [k, v] of subHits) if (!v.some(t => now - t < AUDIT_RATE_WINDOW_MS)) subHits.delete(k);
  return false;
}

function guideEmail(first) {
  const hi = first ? `Hi ${first},` : 'Hi,';
  // They asked for a guide. Hand them the guide. Everything this used to say about page counts,
  // which chapter to read and how the hours add up is already in the document, and stacking it
  // in front of the download turns a two second job into something to get through.
  return `${hi}

Your guide is attached.

If the attachment does not come through, you can download it here:
${GUIDE_URL}

Start with chapter one. It is about your website, and every other layer sits on top of it.

If you want it ran for you instead, just reply. This comes straight to us.

Michelle Baker
Open Heart Media`;
}


// ---------- The Content Day Giveaway entries ----------
// The giveaway landing page (a separate Netlify site) posts every entry here as well as to Netlify
// Forms, so the CRM has its own copy. Entries get their own column on the board and are NOT part of
// the cold sequence: no sent_at and no seq_anchor_at, so no autosend and no follow-up touches them.
app.options('/api/giveaway', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }).status(204).end();
});
app.post('/api/giveaway', async (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  const b = req.body || {};
  if (String(b['bot-field'] || b.company_hp || '').trim()) return res.json({ ok: true });   // honeypot
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const email = clip(b.email, 254).toLowerCase();
  const name = clip(b.name, 120), business = clip(b.business, 160);
  if (!name || !business || !looksLikeEmail(email)) return res.status(400).json({ error: 'Name, business and a valid email are required.' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (subscribeRateLimited(ip)) return res.status(429).json({ error: 'Too many entries from this connection.' });

  const nowIso = new Date().toISOString();
  const data = {
    giveaway_role: clip(b.role, 60), giveaway_industry: clip(b.industry, 80), giveaway_challenge: clip(b.challenge, 120),
    giveaway_instagram: clip(b.instagram, 100), giveaway_posts_video: clip(b.posts_video, 40), giveaway_website_status: clip(b.website_status, 40), giveaway_budget: clip(b.budget, 40), giveaway_referral: clip(b.referral, 200),
    giveaway_prize: clip(b.prize_choice, 60), giveaway_source: clip(b.source, 200), giveaway_opt_in_updates: b.consent_updates === 'yes' || b.consent_updates === true,
  };
  // One entry per business: match the mailbox first, then the business name.
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let row = prospects.find(x => (x.email || '').toLowerCase() === email)
         || prospects.find(x => x.source === 'giveaway' && norm(x.business) === norm(business));
  let duplicate = false;
  if (row && row.source === 'giveaway') {
    duplicate = true;
    row.giveaway_duplicates = (row.giveaway_duplicates || 0) + 1;
    row.updated_at = nowIso;
  } else if (row) {
    // Already in the CRM from the cold list. Keep the record, mark that they entered, and stop treating it as cold.
    Object.assign(row, data, { giveaway_entered_at: nowIso, updated_at: nowIso, source: 'giveaway' });
    row.contact_name = row.contact_name || name; row.contact_first = row.contact_first || name.split(' ')[0];
    if (!row.unsubscribed_at && !['booked', 'won'].includes(row.status)) row.status = 'giveaway';
  } else {
    row = {
      id: 'GW' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      business, category: data.giveaway_industry, city: clip(b.city, 80), phone: clip(b.phone, 40), website: clip(b.website, 200).replace(/^(?!https?:\/\/)(?!@)(?=\S+\.\S)/i, 'https://'),
      rating: '', reviews: '', email, subject: '', body: '', notes: '', handled_by: '', deal_value: '',
      contact_first: name.split(' ')[0], contact_name: name,
      status: 'giveaway', source: 'giveaway', giveaway_entered_at: nowIso, updated_at: nowIso,
      internal: isOwnTeam(email) || undefined,
      consent: { at: nowIso, ip, source: 'content-day-giveaway', page: clip(b.page, 200) },
      ...data,
    };
    prospects.push(row);
  }
  try { save(prospects); } catch (e) { console.error('[giveaway] save failed -', e.message); return res.status(500).json({ error: 'save failed' }); }
  console.log('[giveaway]', duplicate ? 'duplicate' : 'new entry', business);
  if (!duplicate && !row.internal) {
    softStage(alertTeam(`New giveaway entry: ${business}`,
      `<b>${esc(business)}</b><br>${esc(name)} (${esc(data.giveaway_role)})<br>${esc(email)} / ${esc(clip(b.phone, 40))}<br>${esc(clip(b.website, 200))}${data.giveaway_instagram ? '<br>Instagram: ' + esc(data.giveaway_instagram) : ''}<br>`
      + `Prize preference: ${esc(data.giveaway_prize)}<br>Industry: ${esc(data.giveaway_industry)}<br>Challenge: ${esc(data.giveaway_challenge)}<br>Website: ${esc(data.giveaway_website_status)}<br>Posts video: ${esc(data.giveaway_posts_video)}<br>Budget: ${esc(data.giveaway_budget)}<br>Referral: ${esc(data.giveaway_referral)}<br>Updates opt-in: ${data.giveaway_opt_in_updates ? 'yes' : 'no'}`),
      15000, 'giveaway alert').catch(() => {});
  }
  res.json({ ok: true, duplicate });
  if (!duplicate) {
    const first = (row.contact_first || name.split(' ')[0] || '').trim();
    const text = `${first ? 'Hi ' + first + ',' : 'Hi,'}

You are entered in the Open Heart Media Giveaway for ${business}. There is nothing else you need to do.

The winner is drawn on November 20 and chooses a new website or a day of production. We will contact the winner by email and phone, and we will announce it on Open Heart Media's social channels.

Whether or not you win, here is a thank-you for entering: 20% off any monthly subscription, or $250 off any one-time service, good through March 31, 2027. Just mention code CONTENTDAY when we talk.

If you want to use it, or you would like to talk about your business and what we can do for it, book a discovery call here:
https://calendly.com/michelle-openheartmediaco/discovery-call-with-open-heart-media

Thank you for entering.

Michelle Baker
Open Heart Media
openheartmediaco.com`;
    try {
      if (!process.env.SENDGRID_API_KEY) throw new Error('no SENDGRID_API_KEY');
      await sendMail(row, "You're entered: The Open Heart Media Giveaway", text, { kind: 'giveaway-confirm', transactional: true });
      row.giveaway_confirm_sent_at = new Date().toISOString(); delete row.giveaway_confirm_error;
    } catch (e) {
      row.giveaway_confirm_error = String(e.message || e).slice(0, 200);
      console.error('[giveaway] confirmation failed -', email, row.giveaway_confirm_error);
    }
    try { save(prospects); } catch {}
  }
});

app.options('/api/subscribe', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }).status(204).end();
});

app.post('/api/subscribe', async (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');

  const body = req.body || {};
  // Honeypot. A real person never fills a hidden field; a bot fills every field it finds.
  // Answer 200 so the bot cannot tell it was caught and does not come back to probe.
  if (String(body.company || '').trim()) return res.json({ ok: true });

  const first = String(body.name || body.first || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
  if (!first) return res.status(400).json({ error: 'Please add your first name.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (subscribeRateLimited(ip)) {
    return res.status(429).json({ error: 'That has been requested a few times already. Give it an hour, or just email us.' });
  }

  // Same address check the cold sends use. Sending a lead magnet to a dead domain still costs the
  // sending domain, and the person is standing right there so we can tell them instead of bouncing.
  const problem = await addressProblem(email);
  if (problem) {
    return res.status(400).json({ error: 'That email address does not look deliverable. Mind checking it?' });
  }

  const nowIso = new Date().toISOString();
  // Match on the mailbox itself and nothing else. This used to also match audit_email, so a
  // person typing their own address here could be matched to a DIFFERENT prospect who had once
  // been audited on their behalf, and the guide was then sent to that prospect's address instead
  // of to the person who asked for it. One record had email=rome@hartmanlawfirm.com with
  // audit_email=zac@openheartmediaco.com, so every internal test of this form delivered a guide
  // to a law firm. Whoever typed the address is who gets the email.
  let row = prospects.find(x => (x.email || '').toLowerCase() === email);

  if (row) {
    // Already known, possibly from the cold list. An inbound request is a much warmer signal than
    // a scrape, so record it, but never downgrade a status that is further along.
    row.contact_first = row.contact_first || first;
    row.contact_name = row.contact_name || first;
    row.guide_requested_at = nowIso;
    row.updated_at = nowIso;
    // Never paint over an opt-out. The status used to jump straight back to subscriber while
    // unsubscribed_at stayed set, so the dashboard showed a healthy lead that every send path
    // refuses, with nothing on screen saying why. Leave the opt-out visible instead.
    if (row.unsubscribed_at) {
      row.guide_error = `opted out ${row.unsubscribed_at.slice(0, 10)}, not mailed`;
    } else if (['new', 'drafted', 'approved', 'unreachable', 'rejected'].includes(row.status)) {
      row.status = 'subscriber';
    }
  } else {
    row = {
      id: 'G' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      business: '', category: '', city: '', phone: '', website: '',
      rating: '', reviews: '', email, subject: '', body: '', notes: '',
      handled_by: '', deal_value: '',
      contact_first: first, contact_name: first,
      status: 'subscriber', source: 'guide',
      guide_requested_at: nowIso, updated_at: nowIso,
      // CAN-SPAM wants to know where consent came from if it is ever questioned.
      internal: isOwnTeam(email) || undefined,
      consent: { at: nowIso, ip, source: 'free-guide-modal', page: String(body.page || '').slice(0, 200) },
    };
    prospects.push(row);
  }
  try { save(prospects); } catch (e) { console.error('[subscribe] save failed -', e.message); }

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[subscribe] no SENDGRID_API_KEY, captured but not sent:', email);
    return res.json({ ok: true, sent: false, url: GUIDE_URL });
  }

  try {
    const pdf = fs.readFileSync(GUIDE_PDF);
    await sendMail(row, 'Your copy of Rank Higher Without Us', guideEmail(first), {
      kind: 'guide',
      attachments: [{
        content: pdf.toString('base64'),
        filename: 'Rank-Higher-Without-Us.pdf',
        type: 'application/pdf',
        disposition: 'attachment',
      }],
    });
    // Deliberately NOT sent_at. That field drives the cold-outreach daily cap, and a requested
    // lead magnet must not eat a cold send from the day's budget.
    row.guide_sent_at = new Date().toISOString();
    row.updated_at = row.guide_sent_at;
    // They asked us for something and gave us an address to send it to, which is the cleanest
    // opt-in this business gets. Best effort: a Mailchimp outage must never fail the download.
    if (!row.internal) {
      try {
        const mc = await mailchimpUpsert(email, { first, tags: ['guide-download'] });
        if (mc.ok) { row.mailchimp_at = row.guide_sent_at; delete row.mailchimp_error; }
        else { row.mailchimp_error = mc.skipped; }
      } catch (e) {
        // Recorded on the row, not just the log. A silent catch here is how you end up staring
        // at a subscriber that never reached the audience with nothing on screen saying why.
        row.mailchimp_error = e.message.slice(0, 200);
        console.error('[mailchimp] guide push failed -', email, e.message);
      }
    }
    try { save(prospects); } catch (e) { console.error('[subscribe] save failed -', e.message); }
    return res.json({ ok: true, sent: true, url: GUIDE_URL });
  } catch (e) {
    const msg = e.response?.body?.errors?.[0]?.message || e.message;
    row.guide_error = msg;
    try { save(prospects); } catch {}
    console.error('[subscribe] send failed -', email, msg);
    // The lead is captured either way, so give them the file rather than a dead end.
    return res.status(200).json({ ok: true, sent: false, url: GUIDE_URL,
      note: 'We could not email it just now, but you can download it directly.' });
  }
});


// ---------- Client onboarding form ----------
// Replaces the Google Form, which asked clients to type their Facebook, LinkedIn, YouTube,
// TikTok and Twitter passwords into a spreadsheet. Every one of those platforms supports adding
// an agency as a delegated admin, so this form never has a password field and never will. It
// also covers the whole engagement rather than social alone, and drops the two questions the old
// form asked twice.
const ONBOARDING_FILE = path.join(DATA_DIR, 'onboarding.json');
function loadOnboarding() { try { return JSON.parse(fs.readFileSync(ONBOARDING_FILE, 'utf8')); } catch { return []; } }
function saveOnboarding(rows) { fs.writeFileSync(ONBOARDING_FILE, JSON.stringify(rows, null, 2)); }

const ONB_SECTIONS = [
  { t: 'Your business', d: 'This is what we publish everywhere, so it has to be exactly how you want it read.', f: [
    ['business', 'Business name', 'text', 1, 'Exactly as it should appear on Google, your site and every directory'],
    ['address', 'Full address', 'text', 1, 'Street, suite, city, state, ZIP. One character of difference splits a listing.'],
    ['phone', 'Main phone number', 'tel', 1, ''],
    ['website', 'Website', 'text', 0, 'Leave blank if you do not have one yet'],
    ['years', 'How long have you been in business?', 'text', 0, ''],
  ]},
  { t: 'Who we talk to', d: '', f: [
    ['contact_name', 'Your name', 'text', 1, ''],
    ['contact_email', 'Your email', 'email', 1, ''],
    ['contact_phone', 'Best number to reach you', 'tel', 0, ''],
    ['approver', 'Who can approve work?', 'text', 1, 'If that is not you, give us their name and email. Work stalls without this.'],
  ]},
  { t: 'What you do', d: 'Answer in the words a customer would use, not internal terms.', f: [
    ['services', 'What services do you want to be found for?', 'area', 1, 'One per line'],
    ['areas', 'What areas do you actually serve?', 'area', 1, 'Towns, counties or ZIP codes'],
    ['ideal', 'Describe your ideal customer', 'area', 0, ''],
    ['age', 'Rough age range of your current customers', 'text', 0, ''],
    ['model', 'Are you customer facing, online, or both?', 'select:Customer facing|Online|Both', 0, ''],
    ['b2b', 'Do you do any B2B work?', 'select:No|Some|Mostly B2B', 0, ''],
  ]},
  { t: 'The market', d: '', f: [
    ['competitors', 'Who do you lose work to?', 'area', 0, 'Names or websites. This tells us more than almost anything else on this form.'],
    ['different', 'What makes you the better choice?', 'area', 0, ''],
    ['obstacle', 'What is the single biggest thing in your way right now?', 'area', 0, ''],
    ['success', 'What does success look like six months from now?', 'area', 1, 'Be specific. "More leads" is hard to measure against.'],
  ]},
  { t: 'Brand and content', d: '', f: [
    ['brand_assets', 'Do you have logo files, brand colors or fonts?', 'select:Yes, I can send them|Some of it|No, we need these made', 0, ''],
    ['media', 'What photo or video already exists that we can use?', 'area', 0, 'We work from your archive first and only film what we agree.'],
    ['filming', 'If we do film, when are you available?', 'text', 0, ''],
    ['nogo', 'Anything we must never post about?', 'area', 0, 'Compliance rules, topics, competitors, anything sensitive'],
    ['avoid', 'Any accounts or people we should not engage with?', 'area', 0, ''],
    ['partners', 'Any sponsorships or partnerships we should know about?', 'area', 0, ''],
  ]},
  { t: 'Budget', d: '', f: [
    ['ad_budget', 'Monthly budget for paid advertising', 'select:Not yet decided|Under $500|$500 to $1,000|$1,000 to $2,500|$2,500 to $5,000|Over $5,000', 0, 'Separate from our fee. Says nothing about how we treat the account.'],
    ['notes', 'Anything else we should know?', 'area', 0, ''],
  ]},
];

const ONB_ACCESS = [
  ['acc_website', 'Website admin', 'Add us as an administrator, or send a login you create for us specifically.'],
  ['acc_gbp', 'Google Business Profile', 'Settings, People and access, Add, then invite michelle@openheartmediaco.com as Manager. You stay the Owner.'],
  ['acc_ga', 'Google Analytics and Search Console', 'Admin, Access management, add michelle@openheartmediaco.com as Editor.'],
  ['acc_ads', 'Google Ads', 'Tools, Access and security, invite us. Skip if you do not run ads.'],
  ['acc_meta', 'Facebook and Instagram', 'Meta Business Suite, Settings, People, Add people. Never share a personal password.'],
  ['acc_other', 'Other social accounts', 'LinkedIn, YouTube, TikTok. Each one supports adding a manager without a password.'],
  ['acc_dns', 'Domain and DNS', 'We do not need access, we just need to know who holds it, in case we need a record changed.'],
];

function onboardingPage(prefill) {
  const esc2 = v => esc(v == null ? '' : v);
  const field = ([k, label, type, req, hint]) => {
    const r = req ? ' <span class="rq">required</span>' : '';
    const h = hint ? `<div class="hint">${esc2(hint)}</div>` : '';
    let input;
    if (type === 'area') input = `<textarea name="${k}" rows="3"${req ? ' required' : ''}></textarea>`;
    else if (type.startsWith('select:')) {
      const opts = type.slice(7).split('|').map(o => `<option>${esc2(o)}</option>`).join('');
      input = `<select name="${k}"${req ? ' required' : ''}><option value="">Choose one</option>${opts}</select>`;
    } else {
      const v = prefill && prefill[k] ? ` value="${esc2(prefill[k])}"` : '';
      input = `<input type="${type}" name="${k}"${v}${req ? ' required' : ''}>`;
    }
    return `<div class="f"><label for="${k}">${esc2(label)}${r}</label>${h}${input}</div>`;
  };
  const sections = ONB_SECTIONS.map((s, i) => `
    <fieldset><legend><span class="sn">${String(i + 1).padStart(2, '0')}</span>${esc2(s.t)}</legend>
    ${s.d ? `<p class="sd">${esc2(s.d)}</p>` : ''}
    ${s.f.map(field).join('')}</fieldset>`).join('');
  const access = ONB_ACCESS.map(([k, name, how]) => `
    <label class="acc"><input type="checkbox" name="${k}" value="done">
      <span><b>${esc2(name)}</b><em>${esc2(how)}</em></span></label>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Client onboarding &middot; Open Heart Media</title>
<meta name="robots" content="noindex">
<style>
:root{--navy:#13233f;--ink:#0a1220;--red:#e22a24;--cream:#f4f1ea;--mut:#5c6a7e;--hair:#e0e4ec;--bg:#f6f7f9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#1d2a3d;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.hd{background:var(--navy);color:#fff;padding:40px 22px 44px}
.hd .in{max-width:720px;margin:0 auto}
.hd .eb{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8fa3c0;font-weight:700}
.hd h1{font-size:clamp(28px,5vw,40px);margin:12px 0 0;letter-spacing:-.025em;line-height:1.08;font-weight:800}
.hd p{max-width:52ch;margin:14px 0 0;color:#c3d3e8;font-size:16.5px}
.hd .bar{height:3px;width:46px;background:var(--red);border-radius:2px;margin-top:22px}
main{max-width:720px;margin:-24px auto 70px;padding:0 22px}
fieldset{background:#fff;border:1px solid var(--hair);border-radius:12px;padding:22px 24px 8px;margin:0 0 16px;
  box-shadow:0 1px 2px rgba(10,18,32,.05),0 12px 28px -22px rgba(10,18,32,.4)}
legend{font-weight:800;font-size:18px;color:var(--ink);padding:0 9px;letter-spacing:-.015em;display:flex;align-items:center;gap:9px}
.sn{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--red);font-weight:700}
.sd{margin:2px 0 16px;color:var(--mut);font-size:14.5px}
.f{margin:0 0 17px}
label{display:block;font-weight:600;font-size:14.5px;color:var(--ink);margin-bottom:5px}
.rq{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--red);
  background:#fdecea;padding:1px 6px;border-radius:4px;margin-left:5px;vertical-align:1px}
.hint{font-size:13px;color:var(--mut);margin:-1px 0 6px}
input,textarea,select{width:100%;padding:10px 12px;border:1px solid var(--hair);border-radius:8px;font:inherit;background:#fff;color:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--navy);box-shadow:0 0 0 3px rgba(19,35,63,.09)}
textarea{resize:vertical;min-height:78px}
.acc{display:flex;gap:11px;align-items:flex-start;font-weight:400;padding:12px 0;border-bottom:1px solid var(--hair);margin:0}
.acc:last-of-type{border-bottom:none}
.acc input{width:17px;height:17px;margin:3px 0 0;flex:none;accent-color:var(--navy)}
.acc b{display:block;font-size:14.5px;color:var(--ink)}
.acc em{display:block;font-style:normal;font-size:13.5px;color:var(--mut);margin-top:2px;line-height:1.5}
.pw{background:var(--cream);border-left:3px solid var(--red);border-radius:8px;padding:14px 16px;margin:0 0 18px;font-size:14.5px}
.pw b{color:var(--ink)}
button{width:100%;padding:15px;background:var(--red);color:#fff;border:0;border-radius:9px;font:inherit;
  font-weight:700;font-size:16px;cursor:pointer;letter-spacing:.01em}
button:hover{background:#c41f19}
button:disabled{opacity:.55;cursor:not-allowed}
.msg{margin:14px 0 0;padding:13px 16px;border-radius:8px;font-size:14.5px;display:none}
.msg.err{background:#fdecea;color:#a8231d;display:block}
.ft{text-align:center;color:var(--mut);font-size:13px;margin:26px 0 0}
.done{background:#fff;border:1px solid var(--hair);border-radius:12px;padding:44px 30px;text-align:center}
.done h2{font-size:25px;margin:0;color:var(--ink);letter-spacing:-.02em}
.done p{color:var(--mut);margin:12px auto 0;max-width:44ch}
</style></head><body>
<div class="hd"><div class="in">
  <div class="eb">Open Heart Media</div>
  <h1>Let's get started.</h1>
  <p>Fifteen minutes, once. This is everything we need to stop guessing and start work. Required fields are marked; the rest helps but will not hold anything up.</p>
  <div class="bar"></div>
</div></div>
<main>
<form id="f" novalidate>
${sections}
<fieldset><legend><span class="sn">07</span>Access</legend>
  <p class="sd">Tick each one as you do it. If something is not obvious, leave it and we will walk you through it.</p>
  <div class="pw"><b>We will never ask for a password.</b> Every platform below lets you add us alongside you, and you can remove us at any time. If anyone ever asks you to email a password, that is not us.</div>
  ${access}
</fieldset>
<button type="submit" id="sub">Send this to Open Heart Media</button>
<div class="msg" id="m"></div>
<div class="ft">Questions? Call 404-491-1466 or reply to the email that brought you here.</div>
</form>
</main>
<script>
var f=document.getElementById('f'),b=document.getElementById('sub'),m=document.getElementById('m');
f.addEventListener('submit',function(e){
  e.preventDefault();
  var miss=[].slice.call(f.querySelectorAll('[required]')).filter(function(el){return !el.value.trim();});
  if(miss.length){ m.className='msg err'; m.textContent='A few required answers are still blank. The first one is highlighted.';
    miss[0].focus(); miss[0].scrollIntoView({block:'center',behavior:'smooth'}); return; }
  m.className='msg'; b.disabled=true; b.textContent='Sending...';
  var d={}; new FormData(f).forEach(function(v,k){ d[k]=v; });
  fetch('/api/onboarding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
   .then(function(r){return r.json();})
   .then(function(r){
     if(r&&r.ok){ document.querySelector('main').innerHTML=
       '<div class="done"><h2>Got it. Thank you.</h2><p>That is everything we need to begin. You will hear from us within one business day, and your first call is already on the schedule.</p></div>';
       window.scrollTo(0,0); }
     else { throw new Error((r&&r.error)||'Something went wrong'); }
   })
   .catch(function(err){ m.className='msg err'; m.textContent=err.message+' Please try again, or call 404-491-1466.';
     b.disabled=false; b.textContent='Send this to Open Heart Media'; });
});
</script></body></html>`;
}

const ONBOARD_V2_FILE = path.join(__dirname, 'onboarding-form.html');
app.get('/onboarding', (req, res) => {
  try { res.set('Content-Type', 'text/html; charset=utf-8').set('X-Robots-Tag', 'noindex').send(fs.readFileSync(ONBOARD_V2_FILE, 'utf8')); }
  catch (e) { res.set('Content-Type', 'text/html').send(onboardingPage({ business: req.query.b || '' })); }
});
// The older, shorter form stays reachable for the team only (not a public path).
app.get('/onboarding-short', (req, res) => {
  res.set('Content-Type', 'text/html').send(onboardingPage({ business: req.query.b || '' }));
});

// New full onboarding form (v2). One row per submission, tagged with the client link code, so the
// team can see every client's answers separately. No password fields exist, and anything that
// looks like a credential is scrubbed before it is stored or emailed.
const ONB_CRED = /\b(pass(word|wd)?|pwd|login)\s*[:=]\s*\S+/gi;
function scrubText(v, counter) { return String(v == null ? '' : v).replace(ONB_CRED, () => { counter.n++; return '[removed, send this a safer way]'; }); }
function scrubDeep(v, counter, depth = 0) {
  if (depth > 6) return '';
  if (Array.isArray(v)) return v.slice(0, 200).map(x => scrubDeep(x, counter, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 200)) o[String(k).slice(0, 80)] = scrubDeep(x, counter, depth + 1); return o; }
  return scrubText(typeof v === 'string' ? v.slice(0, 6000) : v, counter);
}
async function handleOnboardingV2(d, req, res) {
  if (d.bot_field) return res.json({ ok: true });                          // honeypot: pretend success
  if (qualifyRateLimited(req.ip || 'x')) return res.status(429).json({ error: 'Too many submissions. Try again in a bit.' });
  const business = String(d.business_name || '').trim().slice(0, 160);
  const email = String(d.contact_email || '').trim().toLowerCase().slice(0, 254);
  if (!business) return res.status(400).json({ error: 'Please add your business name.' });
  if (!looksLikeEmail(email)) return res.status(400).json({ error: 'That email does not look right.' });
  const counter = { n: 0 };
  const client = String(d.client || 'unassigned').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'unassigned';
  const row = {
    id: 'O' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    at: new Date().toISOString(), v: 2, client, business, email,
    contact_name: scrubText(d.contact_name, counter).slice(0, 120),
    contact_phone: scrubText(d.contact_phone, counter).slice(0, 40),
    services: scrubText(d.services, counter).slice(0, 600),
    summary: scrubText(d.summary, counter).slice(0, 60000),
    answers: scrubDeep(d.answers || {}, counter),
  };
  if (counter.n) row.scrubbed = counter.n;
  const rows = loadOnboarding(); rows.push(row);
  try { saveOnboarding(rows); } catch (e) { console.error('[onboarding] save failed -', e.message); return res.status(500).json({ error: 'Could not save. Please try again.' }); }
  let bcNote = '';
  if (readJson(BC_TOKEN_FILE, null)) {
    try { const pr = await provisionBasecamp(row); bcNote = `Basecamp project created: ${pr.url}\n\n`; row.basecamp = pr; saveOnboarding(rows); }
    catch (e) { console.error('[onboarding] basecamp failed -', e.message); bcNote = `Basecamp project was NOT created (${e.message}). Create it by hand.\n\n`; }
  }
  try {
    if (process.env.SENDGRID_API_KEY && SALES.length) {
      await sgMail.sendMultiple({
        to: SALES, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
        replyTo: email,
        subject: `ONBOARDING COMPLETE: ${business} (${client})`,
        text: bcNote + row.summary + (counter.n ? `\n\nNote: ${counter.n} answer(s) looked like a credential and were removed before saving.\n` : ''),
      });
    }
  } catch (e) { console.error('[onboarding] notify failed -', e.message); }
  res.json({ ok: true, id: row.id });
}


// ---------- Basecamp: auto-create a client project when onboarding comes in ----------
// One-time setup: register an integration at launchpad.37signals.com/integrations with redirect URI
// https://app.openheartmediaco.com/api/basecamp/callback, put BASECAMP_CLIENT_ID and
// BASECAMP_CLIENT_SECRET in Render, then open /api/basecamp/connect while logged in.
const BC_ACCOUNT = process.env.BASECAMP_ACCOUNT_ID || '5689303';
const BC_TOKEN_FILE = path.join(DATA_DIR, 'basecamp_token.json');
const BC_PROJECTS_FILE = path.join(DATA_DIR, 'basecamp_projects.json');
const CRM_URL = (process.env.CRM_URL || 'https://app.openheartmediaco.com').replace(/\/$/, '');
const BC_UA = 'OHM CRM (zac@openheartmediaco.com)';
const BC_TEAM = { zac: 44772906, griffin: 44733453, ariel: 46843205, frank: 44842358 };
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
async function bcToken() {
  const t = readJson(BC_TOKEN_FILE, null);
  if (!t || !t.refresh_token) throw new Error('Basecamp is not connected. Open /api/basecamp/connect while logged in.');
  if (t.access_token && t.expires_at && Date.now() < t.expires_at - 3600e3) return t.access_token;
  const q = new URLSearchParams({ type: 'refresh', refresh_token: t.refresh_token, client_id: process.env.BASECAMP_CLIENT_ID || '', client_secret: process.env.BASECAMP_CLIENT_SECRET || '' });
  const r = await fetch('https://launchpad.37signals.com/authorization/token?' + q, { method: 'POST' });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Basecamp token refresh failed: ' + JSON.stringify(j).slice(0, 200));
  const nt = { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 1209600) * 1000 };
  fs.writeFileSync(BC_TOKEN_FILE, JSON.stringify(nt));
  return nt.access_token;
}
// Basecamp allows about 50 requests per 10 seconds. Requests go through one slow queue and wait out a 429.
let bcChain = Promise.resolve(), bcLast = 0;
function bcSlot() { const run = bcChain.then(async () => { const wait = Math.max(0, bcLast + 260 - Date.now()); if (wait) await new Promise(r => setTimeout(r, wait)); bcLast = Date.now(); }); bcChain = run.catch(() => {}); return run; }
async function bc(method, urlPath, body, tries = 0) {
  const tok = await bcToken();
  await bcSlot();
  const r = await fetch(`https://3.basecampapi.com/${BC_ACCOUNT}${urlPath}`, {
    method, headers: { Authorization: 'Bearer ' + tok, 'User-Agent': BC_UA, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 429 && tries < 4) { const ra = Number(r.headers.get('retry-after')) || 8; await new Promise(x => setTimeout(x, Math.min(ra, 15) * 1000 + 300)); return bc(method, urlPath, body, tries + 1); }
  const txt = await r.text();
  if (!r.ok) throw new Error(`Basecamp ${method} ${urlPath} -> ${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : {};
}
app.get('/api/basecamp/connect', (req, res) => {
  if (!process.env.BASECAMP_CLIENT_ID) return res.status(400).send('Set BASECAMP_CLIENT_ID and BASECAMP_CLIENT_SECRET in Render first.');
  const q = new URLSearchParams({ type: 'web_server', client_id: process.env.BASECAMP_CLIENT_ID, redirect_uri: CRM_URL + '/api/basecamp/callback' });
  res.redirect('https://launchpad.37signals.com/authorization/new?' + q);
});
app.get('/api/basecamp/callback', async (req, res) => {
  try {
    const q = new URLSearchParams({ type: 'web_server', client_id: process.env.BASECAMP_CLIENT_ID || '', client_secret: process.env.BASECAMP_CLIENT_SECRET || '',
      redirect_uri: CRM_URL + '/api/basecamp/callback', code: String(req.query.code || '') });
    const r = await fetch('https://launchpad.37signals.com/authorization/token?' + q, { method: 'POST' });
    const raw = await r.text();
    let j = {}; try { j = JSON.parse(raw); } catch { throw new Error('Basecamp said: ' + raw.slice(0, 160) + ' (Check BASECAMP_CLIENT_ID and BASECAMP_CLIENT_SECRET in Render. Client ID set: ' + (process.env.BASECAMP_CLIENT_ID ? 'yes' : 'NO') + ', Client Secret set: ' + (process.env.BASECAMP_CLIENT_SECRET ? 'yes' : 'NO') + ')'); }
    if (!r.ok || !j.refresh_token) throw new Error(JSON.stringify(j).slice(0, 200));
    fs.writeFileSync(BC_TOKEN_FILE, JSON.stringify({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 1209600) * 1000 }));
    res.send('Basecamp connected. New onboarding submissions will now create a project automatically. You can close this tab.');
  } catch (e) { res.status(500).send('Basecamp connect failed: ' + esc(e.message)); }
});
app.get('/api/basecamp/status', (req, res) => { if (!teamOnly(req, res)) return; res.json({ connected: !!readJson(BC_TOKEN_FILE, null), projects: readJson(BC_PROJECTS_FILE, {}) }); });

const BC_FOLDERS = ['Onboarding', 'Brand Assets', 'To be Approved', 'Ad Creative', 'Website', 'Reports', 'Research and Client Brain', 'Contracts and Billing'];
const BC_LAUNCH_GATE = [
  ['Onboarding answers reviewed with the client on the kickoff call', 'ariel', 'Read the onboarding answers in the CRM. Fill any "not sure" with the client on the call.'],
  ['Account access confirmed for every platform we need', 'ariel', 'Google Business Profile, Search Console, GA4, Google Ads, Meta, website admin. Invitations only, never passwords.'],
  ['Conversion tracking passes the test form and the 60 second test call', 'ariel', 'Lead reaches the inbox or CRM, GA4 shows form_submit and call_60s, Google Ads and Meta show the conversion.'],
  ['Break-even cost per lead written down with the owner', 'ariel', 'Average job value, close rate, margin, and the cost per lead that still makes money.'],
  ['Website Checklist run in full on the live site', 'frank', 'Every section and the Pass standards table. Mark each row Pass, or write a reason and fix date.'],
  ['Google Business Profile matches the website, 10 or more real photos', 'frank', 'Name, address and phone exactly match. Services, hours and categories complete.'],
  ['Ads Checklist run in full before any campaign launches', 'ariel', 'No ad account launches until tracking passes and a strategist signs.'],
  ['Strategist sign-off on the launch plan', 'griffin', 'A second person reviews tracking results, budget and the first 30 days of creative.'],
  ['First 30 days of content approved by the client', 'ariel', 'Approvals live in the To be Approved folder.'],
  ['Client reporting scheduled', 'griffin', 'Monthly blended report date set. Quarterly review date set.'],
  ['Monthly and Quarterly Checks list created for this client', 'griffin', 'Copy from an existing client. Website items to Frank, ads items to Ariel.'],
  ['Launch day: confirm everything is live and tell the client', 'griffin', 'Final walk through, then send the client the launch note.'],
];
async function provisionBasecamp(row) {
  const done = readJson(BC_PROJECTS_FILE, {});
  if (done[row.client] && row.client !== 'unassigned') return done[row.client];
  const proj = await bc('POST', '/projects.json', { name: row.business, description: `Client onboarding submitted ${row.at.slice(0, 10)}. Contact: ${row.contact_name || ''} ${row.email}` });
  const dock = Object.fromEntries((proj.dock || []).map(d => [d.name, d.id]));
  const B = proj.id;
  try { await bc('PUT', `/projects/${B}/people/users.json`, { grant: Object.values(BC_TEAM) }); } catch (e) { console.error('[basecamp] grant failed -', e.message); }
  if (dock.vault) for (const t of BC_FOLDERS) { try { await bc('POST', `/buckets/${B}/vaults/${dock.vault}/vaults.json`, { title: t }); } catch (e) { console.error('[basecamp] folder', t, e.message); } }
  if (dock.todoset) {
    const list = await bc('POST', `/buckets/${B}/todosets/${dock.todoset}/todolists.json`, { name: 'Launch gate (all 12 before going live)', description: 'Nothing goes live until every item here is closed.' });
    for (const [title, who, desc] of BC_LAUNCH_GATE) {
      try { await bc('POST', `/buckets/${B}/todolists/${list.id}/todos.json`, { content: title, description: `<p>${desc}</p>`, assignee_ids: [BC_TEAM[who]],
        completion_subscriber_ids: [BC_TEAM.griffin, BC_TEAM.zac], notify: false }); } catch (e) { console.error('[basecamp] todo', title, e.message); }
    }
  }
  if (dock.message_board) {
    try { await bc('POST', `/buckets/${B}/message_boards/${dock.message_board}/messages.json`, { subject: 'Onboarding answers',
      content: '<pre>' + esc(row.summary || '').slice(0, 90000) + '</pre>', status: 'active' }); } catch (e) { console.error('[basecamp] message', e.message); }
  }
  const out = { id: B, url: proj.app_url, at: new Date().toISOString() };
  done[row.client] = out; fs.writeFileSync(BC_PROJECTS_FILE, JSON.stringify(done, null, 2));
  return out;
}


// ---------- Open Heart Media CRM: client hub (Home, Clients, Onboarding) ----------
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const CLIENT_SEED = [
  { slug: 'sun-and-shield', promos: [{ id: 'p_thanks', name: 'THANKS: $100 off ceramic coating with a tint package', start: '2026-11-09', end: '2026-11-24', details: 'Code THANKS. Approved by Neal. Terms line on every post: valid with a full-vehicle window tint package, one offer per vehicle, cannot be combined, no cash value, mention the code, ends 11:59 PM on the last date. No promo posts on Veterans Day or Thanksgiving.', confirmed: true }, { id: 'p_bf', name: 'BLACK FRIDAY: $150 off PPF or ceramic with tint', start: '2026-11-27', end: '2026-11-30', details: 'Code FRIDAY. Approved by Neal. Same terms line. Black Friday LAST DAY post on Mon 11/30, ends 11:59 PM.', confirmed: true }], cadence: { days: ['Mon','Wed','Fri'], note: 'Bi-weekly Monday shoots with Neal. The 12-video plan is the shoot list. Nothing needs inventing between shoots.' }, code: 'SS', drive: '1XMWaL-O8WStjYgOhuzUWnDMiRIu1cGX7', logo: '/logos/sun-and-shield.png', color: '#1f2c78', name: 'Sun and Shield', status: 'active', services: [], match: ['sun and shield', 'sun & shield'] },
  { slug: 'matchett-homes', cadence: { days: ['Mon','Wed','Fri'], note: 'Filming is rare; most posts use existing footage.' }, code: 'MTCH', drive: '1QaDvSYRYmwDJyVWme2a104Wz645NJEX1', logo: '/logos/matchett-homes.png', color: '#90b040', name: 'Matchett Homes', status: 'active', services: [], match: ['matchett'] },
  { slug: 'ifab', cadence: { days: ['Mon','Wed','Fri'], note: 'Nothing new is filmed. Reels are archive re-cuts with a stills fallback. November plan: 6 reels, 5 carousels, 2 graphics.' }, code: 'IFAB', drive: '1tN7KiLRzkrJTrVfEaWrwzGC0UEt6DR98', logo: '/logos/ifab.png', color: '#921c1f', name: 'iFab', domains: ['ifabatl.com'], status: 'active', services: [], match: ['ifab'] },
  { slug: 'vnphc', cadence: { days: ['Mon','Wed','Fri'], note: 'Filming is rare. Use existing footage and staff or caregiver voices. No client stories.' }, code: 'VNPHC', drive: '1kmrBVMF-ZETl_-LEUwI0M8X9R7RrOYLh', logo: '/logos/vnphc.png', color: '#bad230', name: 'Visiting Nurse', status: 'active', services: [], match: ['vnphc', 'visiting nurse'] },
  { slug: 'adnormous', cadence: { days: ['Mon','Wed','Thu','Fri'], note: 'Consistent filming: installs and warehouse.' }, code: 'ADN', drive: '15AaQ-I5nrWGZ_mH3Bw8jtkZ_2sycu3Oa', logo: '/logos/adnormous.png', color: '#a71619', name: 'Adnormous', status: 'active', services: [], match: ['adnormous'] },
  { slug: 'cisga', cadence: { days: ['Mon','Wed','Fri'], note: 'Filming is rare: events and staff only. November plan: 3 reels, 8 carousels, 2 graphics. No student footage.' }, code: 'CISGA', drive: '1ktR5iqpuM0fI_rkw0YtqqEFlLdeM9xFr', logo: '/logos/cisga.png', color: '#dc332c', name: 'CISGA', domains: ['cisga.org'], status: 'active', services: [], match: ['cisga', 'communities in school'] },
  { slug: 'nitro', cadence: { days: ['Mon','Wed','Fri'], note: 'Plus one new best-seller product video a week (new footage). Other posts use existing footage and macros.' }, code: 'NITRO', drive: '18IEZgfAyWgbtsFGc0A-a82JcTeXNH3V4', logo: '/logos/nitro.png', color: '#6c0f14', name: 'Nitro', status: 'active', services: [], match: ['nitro', 'nitro pro racing'] },
  { slug: 'bkvf', cadence: { days: ['Mon','Wed','Thu','Fri'], note: 'Plus 1 to 2 Baja Gold creatives a week.' }, code: 'BKVF', drive: '1FTen0mIG36C8DIAYWOSS4cGRScsBKrnm', logo: '/logos/bkvf.png', color: '#1a1a1a', name: 'Brothers Keeper', status: 'ads_off', services: [], match: ['bkvf', 'brothers keeper'] },
  { slug: 'urc', cadence: { days: ['Mon','Wed','Thu','Fri'], note: 'Suggested weekly balance: 1 reel, 2 carousels, 1 graphic, one carousel to LinkedIn. Consistent filming: crew and sales reps.' }, code: 'URC', drive: '1vTvEJedXaL3P06iL6JODAJbciz9gdYUw', logo: '/logos/urc.png', color: '#1d2749', name: 'Universal Roofing & Construction', status: 'active', services: [], match: ['urc', 'universal roofing'] },
  { slug: 'open-heart-media', code: 'OHM', logo: '/logos/open-heart-media.png', color: '#1a2b4c', name: 'Open Heart Media', status: 'internal', services: [], match: ['open heart media'] },
  { slug: 'abls', cadence: { days: [], note: 'SET THE SCHEDULE: this client is ads-led. Organic is founder-first and owner-filmed.' }, code: 'ABLS', logo: '/logos/abls.png', color: '#eab831', name: "America's Best Lighting", status: 'seasonal', note: 'Seasonal. Likely ends at the end of November.', services: [], match: ['best lighting', 'abls'] },
  { slug: 'nabs', logo: '/logos/nabs.png', color: '#8c8f96', name: 'North Atlanta Birth Services', status: 'ending', note: 'Ending Nov 25.', services: [], match: ['nabs', 'north atlanta birth'] },
  { slug: 'sm-crocker', logo: '/logos/sm-crocker.png', color: '#a52c23', name: 'S.M Crocker', status: 'active', kind: 'website', services: [], match: ['crocker'] },
  { slug: 'jl-adams', logo: '/logos/jl-adams.png', color: '#641012', name: 'JL Adams Inc.', status: 'active', kind: 'website', services: [], match: ['jl adams'] },
  { slug: 'ts-wiring', logo: '/logos/ts-wiring.png', color: '#063661', name: 'TS Wiring', status: 'active', kind: 'website', services: [], match: ['ts wiring'] },
  { slug: 'carver-plumbing', logo: '/logos/carver-plumbing.png', color: '#1f4e79', name: 'Carver Plumbing', status: 'active', kind: 'website', services: [], match: ['carver plumbing'] },
  { slug: 'ontraxx', logo: '/logos/ontraxx.png', color: '#97292c', name: 'OnTraxx', status: 'returning', kind: 'returning', note: 'Coming back.', services: [], match: ['ontraxx'] },
  { slug: 'zach-haines', name: 'Zach Haines', status: 'proposal', kind: 'proposal', note: 'Proposal pending approval.', services: [], match: ['zach haines'] },
].map(c => ({ website_owner: '', ads_owner: '', account_owner: '', kind: 'retainer', domains: [], ...c }));
function loadClients() {
  let c = readJson(CLIENTS_FILE, null);
  if (!c) { c = CLIENT_SEED; try { fs.writeFileSync(CLIENTS_FILE, JSON.stringify(c, null, 2)); } catch {} }
  // keep match names fresh: add any new names from the built-in list to a saved client
  for (const sd of CLIENT_SEED) { if (!c.find(y => y.slug === sd.slug)) c.push({ ...sd }); }
  for (const sd of CLIENT_SEED) { const x = c.find(y => y.slug === sd.slug); if (x) { x.match = Array.from(new Set([...(x.match || []), ...sd.match])); x.name = sd.name; if (sd.logo) { x.logo = sd.logo; x.color = sd.color; } if (sd.cadence && !(x.cadence && x.cadence.edited)) x.cadence = sd.cadence; if (sd.promos && !x.promos_updated) x.promos = sd.promos; if (sd.code) x.code = sd.code; if (sd.drive) x.drive = sd.drive; if (!x.kind) x.kind = sd.kind; x.domains = Array.from(new Set([...(x.domains || []), ...(sd.domains || [])])); if (!x.edited) { x.services = []; x.website_owner = ''; x.ads_owner = ''; x.account_owner = ''; } } }
  // clients that only exist because they submitted the onboarding form
  const known = new Set(c.map(x => x.slug));
  for (const r of loadOnboarding()) {
    if (r.client && r.client !== 'unassigned' && !known.has(r.client)) {
      known.add(r.client);
      c.push({ slug: r.client, name: r.business || r.client, status: 'onboarding', services: [], kind: 'retainer', match: [String(r.business || r.client).toLowerCase()], website_owner: '', ads_owner: '', account_owner: '' });
    }
  }
  return c;
}
function saveClients(c) { fs.writeFileSync(CLIENTS_FILE, JSON.stringify(c.filter(x => x.status !== 'onboarding' || x.saved), null, 2)); }

let bcProjCache = { at: 0, list: [] };
async function bcProjects() {
  if (Date.now() - bcProjCache.at < 600e3 && bcProjCache.list.length) return bcProjCache.list;
  const out = [];
  for (let pg = 1; pg <= 10; pg++) { const r = await bc('GET', '/projects.json?page=' + pg); if (!Array.isArray(r) || !r.length) break; out.push(...r); if (r.length < 15) break; }
  bcProjCache = { at: Date.now(), list: out };
  return out;
}
const WORK_CACHE_FILE = path.join(DATA_DIR, 'work_cache.json');
const workCache = new Map(Object.entries(readJson(WORK_CACHE_FILE, {})));
let workSaveT = null; const saveWorkCache = () => { clearTimeout(workSaveT); workSaveT = setTimeout(() => { try { fs.writeFileSync(WORK_CACHE_FILE, JSON.stringify(Object.fromEntries(workCache))); } catch {} }, 2000); };
async function clientWorkRaw(c) {
  const hit = workCache.get(c.slug);
  if (hit && Date.now() - hit.at < 600e3) return hit.data;
  let projects; try { projects = await bcProjects(); } catch (e) { if (hit) return hit.data; throw e; }
  let proj = c.bc_project_id ? projects.find(p => String(p.id) === String(c.bc_project_id)) : null;
  if (!proj) {
    const keys = (c.match || []).map(m => m.toLowerCase());
    proj = projects.find(p => keys.some(k => String(p.name || '').toLowerCase() === k)) || projects.find(p => keys.some(k => String(p.name || '').toLowerCase().includes(k)));
  }
  if (!proj) { const d = { linked: false }; workCache.set(c.slug, { at: Date.now(), data: d }); return d; }
  const ts = (proj.dock || []).find(d => d.name === 'todoset');
  const today = new Date().toISOString().slice(0, 10);
  const lists = [];
  if (ts) {
    const tl = await bc('GET', `/buckets/${proj.id}/todosets/${ts.id}/todolists.json`);
    for (const l of tl.slice(0, 12)) {
      const todos = await bc('GET', `/buckets/${proj.id}/todolists/${l.id}/todos.json`);
      lists.push({ id: l.id, name: l.name, ratio: l.completed_ratio || '', url: l.app_url,
        open: todos.slice(0, 40).map(t => ({ id: t.id, title: t.title, due: t.due_on || '', url: t.app_url, who: (t.assignees || []).map(a => a.name.split(' ')[0]).join(', '), overdue: !!(t.due_on && t.due_on < today) })) });
    }
  }
  const allOpen = lists.flatMap(l => l.open);
  const d = { linked: true, project: { id: proj.id, name: proj.name, url: proj.app_url }, lists,
    open: allOpen.length, overdue: allOpen.filter(t => t.overdue).length,
    nextDue: allOpen.filter(t => t.due).map(t => t.due).sort()[0] || '' };
  workCache.set(c.slug, { at: Date.now(), data: d }); saveWorkCache();
  return d;
}
// Keep Basecamp data warm so the Clients page is never blank after a restart.
async function warmWork() { if (!readJson(BC_TOKEN_FILE, null)) return; for (const c of loadClients()) { try { await clientWorkRaw(c); } catch (e) { console.error('[warm]', c.slug, String(e.message).slice(0, 80)); } } }
setTimeout(warmWork, 25e3); setInterval(warmWork, 9 * 60e3);
async function clientWork(c) { try { return await clientWorkRaw(c); } catch (e) { const hit = workCache.get(c.slug); if (hit) return hit.data; throw e; } }
app.get('/api/hq', async (req, res) => {
  if (!teamOnly(req, res)) return;
  const clients = loadClients();
  const onb = loadOnboarding();
  const connected = !!readJson(BC_TOKEN_FILE, null);
  const out = [];
  await Promise.all(clients.map(async c => {
    const mine = onb.filter(r => r.client === c.slug);
    let work = null, workError = '';
    let syncing = false;
    if (connected) { try { const w = await Promise.race([clientWork(c), new Promise(r => setTimeout(() => r('__slow'), 5500))]); if (w === '__slow') { const st = workCache.get(c.slug); if (st) work = st.data; else syncing = true; } else work = w; } catch (e) { workError = e.message.slice(0, 120); } }
    out.push({ ...c, onboarding: { count: mine.length, last: mine.length ? mine[mine.length - 1].at : '' }, work, workError, syncing });
  }));
  const order = clients.map(c => c.slug);
  out.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  res.json({ clients: out, connected, onboardingTotal: onb.length, onboardingNoProject: onb.filter(r => r.v === 2 && !r.basecamp).length });
});
app.post('/api/hq/client/:slug/link', (req, res) => {
  if (!teamOnly(req, res)) return;
  const id = String((req.body && req.body.project) || '').match(/buckets\/(\d+)|projects\/(\d+)|^(\d+)$/);
  const pid = id && (id[1] || id[2] || id[3]);
  if (!pid) return res.status(400).json({ error: 'Paste the Basecamp project link.' });
  const all = loadClients(); const c = all.find(x => x.slug === req.params.slug);
  if (!c) return res.status(404).json({ error: 'Unknown client.' });
  c.bc_project_id = pid; c.saved = true; saveClients(all); workCache.delete(c.slug); res.json({ ok: true });
});
app.put('/api/hq/client/:slug', (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const all = loadClients(); const c = all.find(x => x.slug === req.params.slug);
  if (!c) return res.status(404).json({ error: 'Unknown client.' });
  const b = req.body || {};
  const SERV = ['Website', 'Local SEO and Google profile', 'Paid ads', 'Social content', 'Video and photo', 'Email and SMS', 'CRM'];
  const KINDS = ['retainer', 'website', 'returning', 'proposal'];
  const STAT = ['active', 'ending', 'seasonal', 'ads_off', 'onboarding', 'internal', 'returning', 'proposal'];
  if (KINDS.includes(b.kind)) c.kind = b.kind;
  if (STAT.includes(b.status)) c.status = b.status;
  if (Array.isArray(b.services)) c.services = b.services.filter(x => SERV.includes(x));
  for (const k of ['website_owner', 'ads_owner', 'account_owner']) if (typeof b[k] === 'string') c[k] = b[k].slice(0, 80);
  if (typeof b.note === 'string') c.note = b.note.slice(0, 300);
  if (b.cadence && typeof b.cadence === 'object') c.cadence = { days: (Array.isArray(b.cadence.days) ? b.cadence.days : []).filter(d => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].includes(d)), note: String(b.cadence.note || '').slice(0, 500), edited: true };
  if (Array.isArray(b.domains)) c.domains = Array.from(new Set(b.domains.map(x => String(x).toLowerCase().trim()).filter(x => /^[a-z0-9.@_+-]{3,80}$/.test(x)))).slice(0, 12);
  c.edited = true; c.saved = true; saveClients(all); workCache.delete(c.slug);
  res.json({ ok: true });
});
app.get('/api/hq/refresh', (req, res) => { if (!teamOnly(req, res)) return; workCache.clear(); bcProjCache = { at: 0, list: [] }; res.json({ ok: true }); });

app.post('/api/onboarding', async (req, res) => {
  const d = req.body || {};
  if (d.form === 'onboarding-v2') return handleOnboardingV2(d, req, res);
  const business = String(d.business || '').trim().slice(0, 160);
  const email = String(d.contact_email || '').trim().toLowerCase().slice(0, 254);
  if (!business) return res.status(400).json({ error: 'Please add your business name.' });
  if (!looksLikeEmail(email)) return res.status(400).json({ error: 'That email does not look right.' });

  // Defence in depth: the form has no password field, but a pasted answer could still contain one.
  // Strip anything that looks like a credential rather than storing it and hoping nobody looks.
  const SUSPECT = /\b(pass(word|wd)?|pwd|login)\s*[:=]\s*\S+/gi;
  const row = { id: 'O' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
                at: new Date().toISOString(), business, email, answers: {} };
  let scrubbed = 0;
  for (const [k, v] of Object.entries(d)) {
    let val = String(v == null ? '' : v).slice(0, 4000);
    const clean = val.replace(SUSPECT, (mm) => { scrubbed++; return '[removed, send this a safer way]'; });
    row.answers[k.slice(0, 60)] = clean;
  }
  if (scrubbed) row.scrubbed = scrubbed;

  const rows = loadOnboarding();
  rows.push(row);
  try { saveOnboarding(rows); } catch (e) { console.error('[onboarding] save failed -', e.message); }

  try {
    if (process.env.SENDGRID_API_KEY && SALES.length) {
      const lines = ONB_SECTIONS.flatMap(s => [`\n${s.t.toUpperCase()}`, ...s.f.map(([k, label]) =>
        `  ${label}: ${row.answers[k] || '(blank)'}`)]);
      const acc = ONB_ACCESS.map(([k, name]) => `  ${row.answers[k] ? 'done' : 'not yet'}  ${name}`);
      await sgMail.sendMultiple({
        to: SALES, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
        replyTo: email,
        subject: `ONBOARDING COMPLETE: ${business}`,
        text: `${business} finished the onboarding form.\n${lines.join('\n')}\n\nACCESS\n${acc.join('\n')}\n`
            + (scrubbed ? `\nNote: ${scrubbed} answer(s) looked like they contained a credential and were removed before saving.\n` : ''),
      });
    }
  } catch (e) { console.error('[onboarding] notify failed -', e.message); }

  res.json({ ok: true, id: row.id });
});

function teamOnly(req, res) {
  if (!APP_PASSWORD || authedUser(req)) return true;
  res.status(401).json({ error: 'auth required' }); return false;
}
app.get('/api/onboarding', (req, res) => { if (!teamOnly(req, res)) return; res.json({ responses: loadOnboarding().slice().reverse() }); });

// Team view: every submission, grouped by client link code. Behind the team login.
app.get('/admin/onboarding', (req, res) => {
  const rows = loadOnboarding().slice().reverse();
  const groups = {};
  for (const r of rows) (groups[r.client || (r.v === 2 ? 'unassigned' : 'older short form')] ||= []).push(r);
  const e = esc;
  const body = Object.keys(groups).sort().map(g => `<h2>${e(g)} <small>${groups[g].length} submission${groups[g].length > 1 ? 's' : ''}</small></h2>` +
    groups[g].map(r => `<details><summary><b>${e(r.business)}</b> &middot; ${e(r.contact_name || r.email)} &middot; ${e(new Date(r.at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}${r.scrubbed ? ' &middot; <span style="color:#c00">credential text removed</span>' : ''}</summary>
      <pre>${e(r.summary || JSON.stringify(r.answers, null, 2))}</pre></details>`).join('')).join('');
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onboarding submissions</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:900px;margin:30px auto;padding:0 18px;color:#13233f}h2{margin:30px 0 8px;border-bottom:2px solid #e22a24;padding-bottom:4px}h2 small{font-weight:400;color:#68758c;font-size:13px}details{background:#fff;border:1px solid #e0e4ec;border-radius:8px;padding:10px 14px;margin:8px 0}pre{white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,monospace}body{background:#f6f7f9}</style>
<h1>Onboarding submissions</h1>${body || '<p>No submissions yet.</p>'}`);
});

// ---------- Inbound qualified lead (contact form + campaign landing pages) ----------
// The website's long qualifying form and the cold-outreach landing page both post here. It was
// pointed at a route that did not exist, so every completed form came back 401 and the visitor
// got "that did not send". These are the warmest leads the business gets; they do not get to fail
// quietly. Public by necessity, so it carries the same honeypot and rate limit as /api/subscribe.
const QUALIFY_RATE_MAX = Number(process.env.QUALIFY_RATE_MAX || 6);
const qualHits = new Map();
function qualifyRateLimited(ip) {
  const now = Date.now();
  const hits = (qualHits.get(ip) || []).filter(t => now - t < AUDIT_RATE_WINDOW_MS);
  if (hits.length >= QUALIFY_RATE_MAX) { qualHits.set(ip, hits); return true; }
  hits.push(now); qualHits.set(ip, hits);
  if (qualHits.size > 5000) for (const [k, v] of qualHits) if (!v.some(t => now - t < AUDIT_RATE_WINDOW_MS)) qualHits.delete(k);
  return false;
}

// Everything the two forms can send. The website form asks all of it; the landing page asks for
// five fields and leaves the rest empty, which is deliberate: a paid click that has to answer
// twelve questions does not convert.
const QUALIFY_FIELDS = ['business', 'website', 'name', 'role', 'email', 'phone',
  'spend', 'value', 'timing', 'decision', 'term', 'tried', 'goal',
  'source', 'page', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gclid', 'fbclid', 'src'];

// What the lead gets back, immediately. Plain text, no pitch, and it answers the only two
// questions they have: did that go through, and when does someone get in touch.
// Scores a contact form submission for "this is somebody selling TO us". Three of the first four
// real submissions were outbound pitches using the form as a channel, and each would now trigger
// an automatic promise to call them back. This only ever gates the AUTO-REPLY: the row is still
// saved and the team is still alerted, so a false positive costs a courtesy email, never a lead.
const PITCH_PHRASES = [
  /\bi'?m from\b/i, /\bi am from\b/i, /\bwe help\b/i, /\bwe solve\b/i, /\bwe speciali[sz]e\b/i,
  /\bwe offer\b/i, /\bour (system|team|company|service)\b/i, /\bwould you be open\b/i,
  /\bis this something you\b/i, /\bno.{0,3}obligation\b/i, /\breaching out\b/i,
  /\bfree,? (no.{0,3}obligation )?(assessment|quote|consultation|audit)\b/i,
  /\bhope this (e.?mail )?finds you\b/i, /\blet me know if (you'?re )?interested\b/i,
];
function pitchScore(d) {
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const goal = String(d.goal || ''), tried = String(d.tried || '');
  const both = goal + '\n' + tried;
  const g = norm(goal), t = norm(tried);
  let score = 0; const why = [];
  // The same block pasted into both boxes is a script, not two answers.
  if (g && t && g.length > 60 && (g === t || g.slice(0, 120) === t.slice(0, 120))) { score += 2; why.push('same text in both fields'); }
  let hits = 0;
  for (const re of PITCH_PHRASES) if (re.test(both)) hits++;
  if (hits) { score += Math.min(2, hits); why.push(hits + ' selling phrase' + (hits > 1 ? 's' : '')); }
  // Addressed to us by name reads as outbound mail, not as someone describing their own business.
  if (new RegExp('\\b' + COMPANY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(both)) { score += 2; why.push('addressed to us by name'); }
  if (d.email && both.toLowerCase().includes(String(d.email).toLowerCase())) { score += 1; why.push('signature block'); }
  const site = norm(d.website).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  // Weighted light on purpose: a business with NO website is exactly who we want to hear from,
  // so an empty or dashed website box must never be enough on its own to flag anyone.
  if (/^(google|facebook|instagram|example)\.com$/.test(site)) { score += 2; why.push('bogus website'); }
  else if (!site || site === '-' || !site.includes('.')) { score += 1; why.push('no real website'); }
  return { score, why, pitch: score >= 3 };
}

function qualifyAckBody(first, d) {
  const digits = String(d.phone || '').replace(/\D/g, '').slice(-10);
  const pretty = digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : String(d.phone || '');
  return `${first ? 'Hi ' + first + ',' : 'Hi,'}

Got it. Your details are in front of us now.

${pretty ? 'Someone will call you on ' + pretty + ' within one business day.' : 'Someone will be in touch within one business day.'} If you would rather pick the time yourself, here is the calendar:

${CALENDLY}

Nothing else is needed from you right now. If anything changes before we speak, just reply to this email. It comes straight to us.

Michelle Baker
Open Heart Media
Canton, GA
404-491-1466`;
}

function qualifyEmailBody(d, row) {
  const line = (k, v) => (v ? `${k}: ${v}\n` : '');
  return `New lead from ${d.source || 'the website'}.

${line('Business', d.business)}${line('Website', d.website)}${line('Name', d.name)}${line('Role', d.role)}${line('Email', d.email)}${line('Phone', d.phone)}
${line('Monthly ad spend', d.spend)}${line('Average job value', d.value)}${line('Timing', d.timing)}${line('Decision maker', d.decision)}${line('Commitment', d.term)}
${line('What they have tried', d.tried)}${line('What they want', d.goal)}
${line('Campaign', [d.utm_source, d.utm_medium, d.utm_campaign].filter(Boolean).join(' / '))}${line('Landed on', d.page)}
In the CRM: ${process.env.APP_URL || 'https://app.openheartmediaco.com'}/#/prospect/${row.id}
`;
}

app.options('/api/qualify', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }).status(204).end();
});

app.post('/api/qualify', async (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  const body = req.body || {};

  // Honeypot, answered 200 so a bot learns nothing and does not come back to probe.
  if (String(body.company_website || body.company || '').trim()) return res.json({ ok: true });

  const d = {};
  for (const k of QUALIFY_FIELDS) d[k] = String(body[k] == null ? '' : body[k]).trim().slice(0, 500);
  d.email = d.email.toLowerCase().slice(0, 254);

  if (!d.name || !d.business) return res.status(400).json({ error: 'Please add your name and business.' });
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(d.email)) return res.status(400).json({ error: 'That email does not look right.' });
  if (d.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please add a phone number we can reach you on.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (qualifyRateLimited(ip)) {
    return res.status(429).json({ error: 'That has come through a few times already. Give it an hour, or call us on 404-491-1466.' });
  }

  const nowIso = new Date().toISOString();
  // Same rule as the guide form: the address they typed is the address we answer. Matching
  // audit_email here would send the acknowledgement to somebody else entirely.
  let row = prospects.find(x => (x.email || '').toLowerCase() === d.email);

  if (row) {
    // Known already, usually from the cold list. Somebody filling in a qualifying form is a far
    // stronger signal than a scrape, so it moves forward, but a status further along is never
    // walked backwards by an inbound form.
    row.business = row.business || d.business;
    row.website = row.website || d.website;
    row.phone = row.phone || d.phone;
    row.contact_name = row.contact_name || d.name;
    row.contact_first = row.contact_first || d.name.split(' ')[0];
    if (row.unsubscribed_at) {
      // They opted out of email but just asked us to call them. Keep the opt-out, flag the row.
      row.notes = Array.isArray(row.notes) ? row.notes : [];
      row.notes.push({ ts: nowIso, by: null, text: 'Submitted the contact form while unsubscribed. Email suppressed, call them.' });
      row.status = 'lead';
    } else if (['new', 'drafted', 'approved', 'unreachable', 'rejected', 'subscriber'].includes(row.status)) {
      row.status = 'lead';
    }
  } else {
    row = {
      id: 'L' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      business: d.business, category: '', city: '', phone: d.phone, website: d.website,
      rating: '', reviews: '', email: d.email, subject: '', body: '', notes: '',
      handled_by: '', deal_value: d.value || '',
      contact_first: d.name.split(' ')[0], contact_name: d.name,
      status: 'lead', source: d.source || 'website-form',
      created_at: nowIso, updated_at: nowIso,
      consent: { at: nowIso, ip, source: d.source || 'website-form', page: d.page },
    };
    prospects.push(row);
  }
  row.qualify = { at: nowIso, ...d };
  row.updated_at = nowIso;
  // Classify before anything goes out. Our own team testing the form is not demand, and somebody
  // using the form as an outbound channel must not be promised a call back.
  const ownTeam = isOwnTeam(d.email);
  const pitch = ownTeam ? { pitch: false, why: [] } : pitchScore(d);
  if (ownTeam) { row.internal = true; row.status = 'test'; }
  else if (pitch.pitch) {
    row.status = 'rejected';
    row.notes = Array.isArray(row.notes) ? row.notes : [];
    row.notes.push({ ts: nowIso, by: null, text: 'Looks like an outbound pitch at us, not a lead: ' + pitch.why.join(', ') + '. No auto-reply sent.' });
  }
  try { save(prospects); } catch (e) { console.error('[qualify] save failed -', e.message); }

  // The lead is on disk before anything else can fail. The notification is best effort: if
  // SendGrid is down the lead is still captured and still in the CRM.
  try {
    if (process.env.SENDGRID_API_KEY && SALES.length && !ownTeam) {
      await sgMail.sendMultiple({
        to: SALES,
        from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
        replyTo: d.email,
        // Shouted on purpose. This lands in two busy inboxes and it is the hottest signal the
        // business gets, so it must not read like one more notification.
        subject: pitch.pitch
          ? `Probably a pitch, not a lead: ${d.business}`
          : `LEAD FOLLOW UP IMMEDIATELY: ${d.business}${d.timing ? ' (' + d.timing + ')' : ''}`,
        text: qualifyEmailBody(d, row),
      });
    } else {
      console.warn('[qualify] captured but not notified:', d.email);
    }
  } catch (e) {
    console.error('[qualify] notify failed -', e.message);
  }

  // Answer the person. They handed over a phone number and got nothing back, which is the opposite
  // of what the form is for. Sent after the internal alert so a failure here can never stop the
  // team being told, and marked transactional because they asked us to contact them.
  if (!ownTeam && !pitch.pitch) {
    try {
      const firstName = String(d.name || '').trim().split(/\s+/)[0] || '';
      await sendMail(row, 'We got your details', qualifyAckBody(firstName, d), { kind: 'form-ack', transactional: true });
    } catch (e) {
      console.error('[qualify] ack to lead failed -', d.email, e.message);
    }
    try {
      const nameBits = String(d.name || '').trim().split(/\s+/);
      await mailchimpUpsert(d.email, { first: nameBits[0] || '', last: nameBits.slice(1).join(' '), tags: ['contact-form'] });
      row.mailchimp_at = new Date().toISOString();
      try { save(prospects); } catch {}
    } catch (e) {
      row.mailchimp_error = e.message.slice(0, 200);
      try { save(prospects); } catch {}
      console.error('[mailchimp] form push failed -', d.email, e.message);
    }
  } else {
    console.log('[qualify] no auto-reply:', d.email, ownTeam ? '(our own team)' : '(' + pitch.why.join(', ') + ')');
  }

  return res.json({ ok: true, id: row.id });
});

// Metrics aggregate for the dashboard
// Everything before the first real send was us: preview renders, link tests, a test booking, and
// a few report pages opened to check they worked. Counted alongside the campaign it produced a
// dashboard that was confidently wrong, most visibly a "visit rate" of 40% built from four
// visitors who arrived days before a single email existed. The baseline is the line between the
// two. Events stay on disk; the dashboard just stops counting the rehearsal.
const METRICS_BASELINE_FILE = path.join(DATA_DIR, 'metrics_baseline.json');
function metricsBaseline() {
  try { return JSON.parse(fs.readFileSync(METRICS_BASELINE_FILE, 'utf8')).since || null; } catch { return null; }
}
app.post('/api/metrics/baseline', (req, res) => {
  const since = req.body?.since || new Date().toISOString();
  if (since === 'clear') { try { fs.unlinkSync(METRICS_BASELINE_FILE); } catch {} return res.json({ since: null }); }
  fs.writeFileSync(METRICS_BASELINE_FILE, JSON.stringify({ since, set_at: new Date().toISOString() }));
  res.json({ since });
});

app.get('/api/metrics', (_, res) => {
  const since = metricsBaseline();
  const live = since ? events.filter(e => (e.ts || '') >= since) : events;
  const views = live.filter(e => e.type === 'view');
  const clicks = live.filter(e => e.type === 'click');
  const uniqRefsViewed = new Set(views.map(e => e.ref).filter(Boolean));
  const nameOf = id => (prospects.find(p => p.id === id)?.business) || id || '(untagged)';
  const perRef = {};
  for (const e of live) {
    const k = e.ref || '(untagged)';
    perRef[k] = perRef[k] || { business: nameOf(e.ref), views: 0, clicks: 0 };
    perRef[k][e.type === 'click' ? 'clicks' : 'views']++;
  }
  const booked = live.filter(e => e.type === 'booked');

  // Count what actually left the building. Keying this off status meant a bounce three minutes
  // later removed the lead from the sent total, so the denominator shrank every time delivery got
  // worse and the rates above it quietly improved.
  const outbound = prospects.filter(p => p.sent_at && (!since || p.sent_at >= since));
  const sent = outbound.length;

  // status === 'unreachable' is NOT a bounce. It is the catch-all for every reason a lead stops
  // being mailable: a hard bounce, yes, but also a suppression-list sync, a manual quarantine of
  // guessed addresses, and a prescan failure. Counting it as "bounced" is what put a 78% bounce
  // rate on this dashboard in September while SendGrid's own number for the same window was 3.5%.
  // 163 of those were the Sep 2 wrong-domain quarantine, addresses we pulled on purpose, and 63
  // more were the suppression sweep parking leads on days no mail went out at all.
  // Count the events SendGrid actually reported instead. bounced_at and complained_at are stamped
  // by the webhook and never by list hygiene, so they cannot drift the way status does.
  const bounced = outbound.filter(p => p.bounced_at).length;
  const complained = outbound.filter(p => p.complained_at).length;
  const unsubscribed = outbound.filter(p => p.unsubscribed_at && !p.complained_at).length;
  // Parked for hygiene, never a delivery failure. Reported so the number stays visible, but it
  // is deliberately kept out of the bounce rate.
  const parked = outbound.filter(p => p.status === 'unreachable' && !p.bounced_at).length;
  // Prefer the delivered event. Fall back to subtraction only for sends that predate the webhook.
  const confirmedDelivered = outbound.filter(p => p.delivered_at).length;
  const delivered = confirmedDelivered || Math.max(0, sent - bounced);

  res.json({
    since,
    totals: {
      sent,
      delivered,
      bounced,
      bounceRate: sent ? Math.round((bounced / sent) * 100) : 0,
      complained,
      complaintRate: delivered ? Number(((complained / delivered) * 100).toFixed(2)) : 0,
      unsubscribed,
      parked,
      views: views.length,
      uniqueVisitors: uniqRefsViewed.size,
      clicks: clicks.length,
      booked: booked.length,
      // Of the people who could have opened it, how many did. Delivered is the honest denominator:
      // a bounced address was never given the chance.
      visitRate: delivered ? Math.round((uniqRefsViewed.size / delivered) * 100) : 0,
      clickRate: views.length ? Math.round((clicks.length / views.length) * 100) : 0,
      bookRate: delivered ? Math.round((booked.length / delivered) * 100) : 0,
    },
    perRef: Object.entries(perRef).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.clicks - a.clicks || b.views - a.views),
  });
});

app.post('/api/prospects/:id/send', async (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!looksLikeEmail(p.email)) return res.status(400).json({ error: 'no valid email' });
  if (p.status !== 'approved') return res.status(400).json({ error: 'must be approved first' });
  if (p.unsubscribed_at) return res.status(400).json({ error: 'lead has unsubscribed' });
  try {
    // Must go through sendMail, not sgMail.send: sendMail is what attaches the CAN-SPAM footer
    // (unsubscribe link + physical address), honours the suppression check, and tags the message
    // with prospect_id for attribution. Sending one lead by hand from the dashboard is still a
    // commercial email and carries exactly the same obligations as the bulk run.
    const r = await sendMail(p, p.subject, p.body, { kind: 'cold' });
    p.status = 'sent'; p.sent_at = new Date().toISOString(); p.updated_at = p.sent_at;
    p.provider_id = r.headers['x-message-id'] || null;
    save(prospects);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.response?.body?.errors?.[0]?.message || e.message }); }
});

// Extracted from the route so the scheduler below and the button in the dashboard run the exact
// same code. Two implementations of "send the approved ones" would drift, and the one that drifts
// is the one nobody is watching.
// One inbox, one email. The same address sits on more than one record all the time:
// an owner running three businesses, a franchise sharing a head-office inbox, or a
// scraper that picked up the vendor behind the website instead of the business in
// front of it. On the current list 61 addresses are spread across 153 records, and
// acworth@ptsolutions.com appears eighteen times.
//
// Nothing in the selection looked at that. Each record was independently 'new', so
// each would be drafted and mailed on its own day. Eighteen cold emails to one inbox
// is not outreach, it is how a sending domain gets blocked, and it is exactly the
// kind of thing nobody notices until a recipient says something.
function normEmail(addr) { return String(addr || '').toLowerCase().trim(); }

// The only address check anywhere was `.includes('@')`, which is not a check. The
// scraper writes fragments of Google Maps URLs into the email field when it cannot
// find a real one, and every single one of them contains an @ because that is how
// Maps encodes coordinates:
//
//   //www.google.com/maps/place/shiloh+veterinary+hospital/@34.0448402
//   +llc/@34.10254
//
// Twenty-three of those are on the current list. They pass `.includes('@')`, go to
// SendGrid, and come back invalid, and invalid recipients are charged against the
// sending reputation of the domain the real outreach depends on. Structure only,
// deliberately: whether a well-formed address actually receives mail is SendGrid's
// question to answer, not something to guess at here.
function looksLikeEmail(addr) {
  const e = normEmail(addr);
  if (!e || e.length > 254 || /\s/.test(e)) return false;
  const m = e.match(/^[^@\s]+@([^@\s]+)$/);          // exactly one @
  if (!m) return false;
  const domain = m[1];
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;
  const tld = domain.split('.').pop();
  if (tld.length < 2 || /^\d+$/.test(tld)) return false;   // ".10254" is a coordinate
  if (e.includes('/')) return false;                        // a path, not an address
  return true;
}

// Not every address the scraper found belongs to a business we are allowed to pitch.
// Three kinds turned up on the current list and none of them should ever receive cold
// outreach:
//
//   .edu / .gov / .mil  - five emory.edu addresses were queued. A university is not a
//                         local business and mailing one is how a domain ends up on a
//                         blocklist that is very hard to get off.
//   mysite.com          - Wix's placeholder. It is what a site shows when the owner
//                         never replaced the template, so it is nobody's inbox.
//   vendor platforms    - addresses belonging to the software behind the website
//                         rather than the business in front of it.
//
// Deliberately narrow. A shared domain across several locations of one brand is a real
// prospect with one decision maker, and the duplicate guard already handles that by
// mailing it once. This list only covers addresses that are not a prospect at all.
const NOT_A_BUSINESS_DOMAIN = new Set([
  'mysite.com',        // Wix placeholder
  'locmaps.com',       // listings vendor
  'vagaro.com',        // salon booking platform, scraped off client sites
  'iboostweb.com',     // web agency that built the site
  'moatable.com',      // software vendor
  'wixpress.com', 'squarespace.com', 'godaddy.com', 'example.com', 'domain.com',
  'sentry.io', 'sentry.wixpress.com',
]);
const ROLE_LOCALPARTS = new Set([
  'info', 'contact', 'contactus', 'hello', 'admin', 'office', 'mail', 'email',
  'support', 'help', 'service', 'services', 'sales', 'inquiries', 'enquiries',
  'scheduling', 'schedule', 'appointments', 'booking', 'bookings', 'frontdesk',
  'reception', 'team', 'general', 'webmaster', 'billing', 'accounts', 'accounting',
]);

// Held back by hand: audit reports that still say "no tappable phone" on sites that have one.
// Override or extend with the SEND_SKIP env var (comma separated, case insensitive substrings of the business name).
const SEND_SKIP = (process.env.SEND_SKIP ||
  'MTak Roofing,Russell Family Dentistry,Affordable Vet Center,Atlanta Family Mortgage,Sage Home Loans,5 Stones Renovation,Corrective Chiropractic')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
function isHeldBack(p) {
  const n = String((p && p.business) || '').toLowerCase();
  return SEND_SKIP.some(k => n.includes(k));
}

// The report is what a recipient actually reads, so nothing is drafted or sent for a lead whose
// report cannot be trusted. Reports written before REPORT_FRESH_AFTER predate the accuracy fixes
// (the Sep 18 scanner pass and the Oct 24 writer fix); several said "zero tracking" on sites that
// run Tag Manager. A fallback report is deterministic filler, a thin crawl is not evidence, and a
// directory or booking-platform page is somebody else's site: scoring it describes the platform.
const REPORT_FRESH_AFTER = process.env.REPORT_FRESH_AFTER || '2026-10-24T00:00:00.000Z';
const PLATFORM_HOSTS = ['salonlofts.com', 'facebook.com', 'instagram.com', 'linktr.ee', 'linktree.com', 'yelp.com',
  'google.com', 'goo.gl', 'vagaro.com', 'styleseat.com', 'fresha.com', 'mindbodyonline.com', 'booksy.com',
  'thumbtack.com', 'angi.com', 'homeadvisor.com', 'nextdoor.com', 'yellowpages.com', 'mapquest.com',
  'bbb.org', 'tiktok.com', 'youtube.com', 'linkedin.com', 'x.com', 'twitter.com', 'houzz.com', 'zillow.com',
  'realtor.com', 'healthgrades.com', 'zocdoc.com', 'psychologytoday.com', 'avvo.com', 'findlaw.com',
  'justia.com', 'lawyers.com', 'doordash.com', 'ubereats.com', 'opentable.com', 'tripadvisor.com'];
function isPlatformHost(url) {
  try {
    const h = new URL(url).host.toLowerCase().replace(/^www\./, '');
    return PLATFORM_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch { return true; }
}
function reportSendable(p) {
  const r = p && p.audit_report;
  if (!r || typeof r !== 'object') return { ok: false, why: 'no report' };
  // The short report is built from the deterministic checklist, never from the model's prose, so a
  // fallback long report is fine as long as the checklist exists.
  if (r.degraded && !(Array.isArray(r.checklist) && r.checklist.length)) return { ok: false, why: 'fallback report without a checklist' };
  if (!p.prescan_at || p.prescan_at < REPORT_FRESH_AFTER) return { ok: false, why: 'report predates the accuracy fixes' };
  if (p.prescan_error) return { ok: false, why: 'last scan errored' };
  const sc = p.audit_scan;
  if (!sc || sc.reachable === false) return { ok: false, why: 'site was not reachable' };
  if (!Array.isArray(sc.pagesScanned) || sc.pagesScanned.length < 2) return { ok: false, why: 'fewer than 2 pages scanned' };
  if (isPlatformHost(p.website)) return { ok: false, why: 'website is a platform page, not their own site' };
  return { ok: true, why: '' };
}

function isMailableBusiness(addr) {
  const e = normEmail(addr);
  if (!looksLikeEmail(e)) return false;
  const domain = e.split('@')[1];
  const tld = domain.split('.').pop();
  if (tld === 'edu' || tld === 'gov' || tld === 'mil') return false;
  if (NOT_A_BUSINESS_DOMAIN.has(domain)) return false;
  if (e.startsWith('noreply@') || e.startsWith('no-reply@') || e.startsWith('donotreply@')) return false;
  if (e.startsWith('abuse@') || e.startsWith('postmaster@')) return false;
  // Guessed role addresses. The scraper synthesised info@<their-domain> whenever it could not
  // find a published address, and a triage of all 1,447 records found 599 of them, 41% of the
  // list. That share matches the 53% bounce rate almost exactly: these mailboxes mostly do not
  // exist. Mailing them is the fastest way to lose the sending domain, and no amount of subject
  // line work fixes an address that was invented. A real published info@ is rare enough that
  // excluding the whole shape is the right trade.
  const local = e.split('@')[0];
  if (ROLE_LOCALPARTS.has(local)) return false;
  return true;
}

// An address is spoken for once any record carrying it has been mailed, parked after
// failing, or replied. Queue states are included by the callers that need them.
function claimedAddresses(alsoCountQueued) {
  const claimed = new Set();
  for (const p of prospects) {
    if (!p.email) continue;
    const done = p.sent_at || p.status === 'sent' || p.status === 'unreachable'
      || p.status === 'opened' || p.status === 'booked' || p.status === 'won' || p.status === 'lost';
    const queued = alsoCountQueued && (p.status === 'drafted' || p.status === 'approved');
    if (done || queued) claimed.add(normEmail(p.email));
  }
  return claimed;
}

async function sendApprovedBatch(budget) {
  const queue = prospects.filter(p =>
    p.status === 'approved' && !p.unsubscribed_at && isMailableBusiness(p.email) && !isHeldBack(p));
  // Last line of defence. Two approved records can still share an address, so the set
  // grows as we go and the second one is parked rather than mailed.
  const alreadyMailed = claimedAddresses(false);
  let sent = 0; const errors = []; let parked = 0; let deduped = 0;
  for (const p of queue) {
    if (budget <= 0) break;
    const addr = normEmail(p.email);
    if (alreadyMailed.has(addr)) {
      p.status = 'duplicate';
      p.duplicate_of_email = addr;
      p.updated_at = new Date().toISOString();
      deduped++; save(prospects);
      console.log('[send] skipped duplicate address', addr, 'record', p.id);
      continue;
    }
    try {
      const r = await sendMail(p, p.subject, p.body, { kind: 'cold' });
      alreadyMailed.add(addr);
      p.status = 'sent'; p.sent_at = new Date().toISOString(); p.updated_at = p.sent_at;
      p.provider_id = r.headers['x-message-id'] || null;
      p.send_attempts = 0;
      sent++; budget--; save(prospects);
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      const msg = e.response?.body?.errors?.[0]?.message || e.message;
      // Leaving a failed lead at 'approved' meant it was retried on every run forever. Repeatedly
      // hard-bouncing the same address is the fastest way to lose the sending domain, so a
      // permanent failure parks the lead and transient ones get a bounded number of attempts.
      p.send_attempts = (p.send_attempts || 0) + 1;
      p.last_send_error = msg;
      if (e.suppressed || e.permanent || isPermanentFailure(e) || p.send_attempts >= MAX_SEND_ATTEMPTS) {
        p.status = 'unreachable';
        p.updated_at = new Date().toISOString();
        parked++;
      }
      save(prospects);
      errors.push({ id: p.id, error: msg, parked: p.status === 'unreachable' });
    }
  }
  return { sent, parked, deduped, remainingBudget: budget, errors };
}

app.post('/api/send-approved', async (req, res) => {
  const budget = COLD_DAILY_CAP - sentToday();
  if (budget <= 0) return res.json({ sent: 0, reason: 'daily cap reached' });
  res.json(await sendApprovedBatch(budget));
});

// ---------- 3 / 7 / 10 day follow-up sequence ----------
// Prose instructions did not hold. The audit prompt already carried an explicit order never to
// imply a business had received no reviews, and "0 Google reviews since 2023" went out anyway to a
// business with 161 of them. So this is enforced in code instead, on the generated copy, before it
// can reach a send.
//
// Review claims are the specific trap. Google Places returns at most 5 reviews chosen by RELEVANCE,
// never by date, so the newest review we can see is a LOWER BOUND and nothing more. No recency or
// absence claim can ever be supported by it, no matter how the data looks. The rule is therefore
// absolute rather than a threshold: the copy may state the review COUNT and the RATING, both of
// which Google gives us directly, and nothing else about reviews at all.
const REVIEW_NEGATION = /\b(no|zero|none|not|never|without|hasn'?t|haven'?t|lack(?:ing|s)?|missing|stopped|dry|drought)\b/i;
const REVIEW_TIMEFRAME = /\b(since|last|latest|newest|recent|recently|stale|ago|over a year|in a year|months?|years?|weeks?|days?|20\d\d)\b/i;

function reviewClaimProblem(text, p) {
  const truth = String(p && p.reviews != null ? p.reviews : '').trim();
  const rating = String(p && p.rating != null ? p.rating : '').trim();
  for (const raw of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!/review/i.test(sentence)) continue;
    if (REVIEW_NEGATION.test(sentence)) return `states an absence of reviews: "${sentence.slice(0, 120)}"`;
    if (REVIEW_TIMEFRAME.test(sentence)) return `makes a review recency claim, which our data can never support: "${sentence.slice(0, 120)}"`;
    for (const n of sentence.match(/\b\d[\d,.]*\b/g) || []) {
      const clean = n.replace(/[,.]$/, '');
      if (clean !== truth && clean !== rating) {
        return `cites a review figure (${clean}) that is not their real count (${truth || 'unknown'}): "${sentence.slice(0, 120)}"`;
      }
    }
  }
  return null;
}

// The copy is not allowed to make ANY claim about the prospect any more, and the cleanest way to
// enforce that mechanically is to ban the thing every such claim needs: a number about them.
// "0 Google reviews since 2023", "your last review is 3.5 years old", "your site takes 9 seconds",
// "your weakest area scored 43" all die here regardless of how the prompt drifts.
// The one permitted number is our own proof point, which is a fact about Open Heart Media rather
// than about them.
const ALLOWED_NUMBERS = /\b(?:90x|2\.34m|\$2\.34m)\b/gi;
function numericClaimProblem(text, { isBody }) {
  let t = String(text || '');
  if (isBody) {
    // Links carry digits and the signature block is fixed, so neither is a claim.
    t = t.split('\n').filter(l => !/https?:\/\//i.test(l) && !/openheartmediaco\.com/i.test(l)).join('\n');
  }
  t = t.replace(ALLOWED_NUMBERS, ' ');
  const hit = t.match(/\b\d[\d,.]*\b/);
  return hit ? `contains a number about the prospect (${hit[0]}), which the copy is not allowed to assert` : null;
}

// Throws rather than returning, so a caller that forgets to check cannot send the draft anyway.
function assertGrounded(o, p, where) {
  // The subject is a format, not a generated line. "Their Company/Open Heart Media" reads as a
  // note between two businesses rather than a pitch, it cannot drift, and it cannot assert
  // anything about them that we would then have to stand behind. Applied here because every
  // drafter, cold and follow-up alike, returns through this function.
  if (p && p.business) o.subject = `${p.business}/${COMPANY}`;
  for (const [field, text] of [['subject', o && o.subject], ['body', o && o.body]]) {
    const problem = reviewClaimProblem(text, p)
      || numericClaimProblem(text, { isBody: field === 'body' });
    if (problem) {
      const e = new Error(`${where} ${field} ${problem}`);
      e.ungrounded = true;
      throw e;
    }
  }
  return o;
}

async function draftFollowup(p, step) {
  const link = reportUrl(p);
  // A pre-scanned lead has a report but no audited_at: we built it, they did not request it.
  // What matters for the copy is whether they have SEEN it, which viewed_at records when they
  // land on the report page. Branching on audited_at here asked people who had already read
  // their scores whether they had got round to running one.
  const hasReport = !!p.audit_report;
  const seenIt = !!(p.viewed_at || p.clicked_at || p.audited_at || p.status === 'audited');
  const audited = hasReport && seenIt;
  // Third tier. Someone who opened and did not click is not the same person as
  // someone who never opened: the subject line worked and the offer did not.
  // Asking them again to go and click the same link repeats what already failed.
  const openedOnly = !seenIt && !!(p.opened_at || p.status === 'opened');
  // Same rule as the cold email: NO FINDINGS IN THE COPY. Every branch below used to inject the
  // top finding, the weakest category and its score straight into the prompt, and the never-opened
  // branch injected nothing at all while still demanding a specific finding, which is what
  // produced "0 Google reviews since 2023" for a business with 161 reviews. Neither version is
  // acceptable: one asserts things we cannot stand behind, the other invents them. The follow-ups
  // now differ by INTENT, not by which fact about the prospect they recite.
  let angles, context = '', length = '2 to 3', linkPurpose = 'the link to the breakdown we already put together for them';
  const NOCLAIMS = ' ABSOLUTE RULE: you have not been told anything about this business beyond its name, category and city, and you will not be. State no fact, problem, gap, score, measurement or observation about their website, Google profile, reviews, rankings, speed, booking, tracking or social presence. Use no numbers about them of any kind. Do not guess at a problem or hint at one. If a sentence you are writing could be either true or false about their business, delete it. The breakdown makes the claims; this email only points at it.';

  // Somebody who came to US is not the same person as somebody we found. Every branch below is
  // written for a prospect we audited unprompted, and says so: "we did the work", "you did not
  // request it", "never say your audit". Sent to a person who filled in our own form that copy is
  // simply wrong, and wrong in a way they will notice. Inbound gets its own track.
  const inbound = !p.sent_at;
  if (inbound) {
    const what = p.source === 'guide' ? 'downloaded our guide'
      : p.source === 'website-form' ? 'filled in our contact form and left a phone number'
      : 'asked us for a free audit of their site and has read it';
    context = `IMPORTANT: this person came to US. They ${what}. Never say you looked at their business unprompted, never say "we put together", never imply they did not ask. They did ask, and then nothing happened. Do not apologise for that and do not draw attention to how long it has been. They are a warm hand raised, so the tone is a peer following through, not a marketer prospecting.` + NOCLAIMS;
    length = '2 to 3 SHORT sentences';
    linkPurpose = 'the discovery call link';
    angles = {
      1: 'They took the thing and went quiet, which usually means they started reading and got busy, not that they are uninterested. One genuine question about what made them come looking in the first place. No pitch, no offer, nothing to book.',
      2: 'Give one concrete, specific thing they can act on this week, tied to what they came for. It must be genuinely useful on its own and cost them nothing. Explicitly ask for nothing back.',
      3: 'Now make the offer, and make it small. Fifteen minutes to talk through their actual situation, no deck and no presentation. Say plainly what happens on the call and what does not.',
      4: 'Three weeks in. One line of proof about OUR results, about 90x return on ad spend and $2.34M in tracked revenue for a local home services business. That number is about us and is the only number permitted here. Then one short question.',
      5: 'The last one. Two or three lines. Say you will stop writing, that what they took is theirs to keep either way, and leave one open line back. No pitch, no urgency, no final offer.',
    };
  } else if (audited) {
    // They have READ the breakdown and not booked. They already have the detail, so repeating it
    // was never the job anyway. Answer the objection instead.
    context = 'IMPORTANT: they have ALREADY OPENED AND READ the breakdown we put together on their business and sent them. They did not request it and they did not run anything, so never say "your audit", "you ran", "sign up" or "get your free audit". Speak as the person who did the work. THEY HAVE READ IT AND HAVE NOT BOOKED. They are not short of information. What is stopping them is doubt that it is worth a call, or not knowing what fixing any of it actually involves. Do not re-explain anything it said, and do not summarise it.' + NOCLAIMS;
    length = '3 to 4 SHORT sentences, tight and skimmable, no long paragraphs or run-on sentences';
    linkPurpose = 'the discovery call link (they can also revisit the breakdown there)';
    angles = {
      1: 'They read it and did nothing, so name that lightly and without guilt: they had a look, and nothing has changed since. Then make the ask smaller than they expect. Fifteen minutes, no deck, and you will talk through where you would start. End there.',
      2: 'One line of proof about OUR results, not theirs: about 90x return on ad spend and $2.34M in tracked revenue for a local home services business. That number is about us and is the only number permitted in this email. Then one sharp one-line CTA to a short call.',
      3: 'Neither ask landed, so stop asking and handle the objection directly. Name the most likely reason they have not replied: it is not the right quarter, or they are not sure what changing any of it would actually involve. Ask what would need to be true for it to be worth a conversation. One question, no offer.',
      4: 'Three weeks out. Give something away with no ask attached at all. One concrete thing they can do themselves this week, specific enough to be worth doing, and explicitly say you are not asking for anything back. End with a single open line they can reply to or ignore.',
      5: 'The last one. Short and human. Say plainly you are going to stop emailing. Leave the door open in a way that costs them nothing, and mean it. No pitch, no urgency, no final offer.',
    };
  } else if (openedOnly) {
    // Opened, did not click. The offer failed, not the subject. Make the ask smaller.
    context = 'IMPORTANT: they opened a previous email and did not click anything. The subject line reached them; the offer did not. They never ran anything: we looked at their business and wrote it up unprompted, so never ask whether they ran it or got round to it. Do not lead with the link.' + NOCLAIMS;
    linkPurpose = 'the link, mentioned once at the end and never as the main ask';
    angles = {
      1: 'The link did not work on them, so stop pushing it. Say in one line what the breakdown actually covers, as CATEGORIES only and never as findings: how fast the site is, how they turn up in search, whether it is easy to contact them. Then ask if they want it walked through instead of read. Nothing to book.',
      2: 'They ignored the first angle so do not repeat it. Come at it from the other side: offer fifteen minutes where you tell them what you would do first, whether or not they hire you. One short question.',
      3: 'They still have not clicked, so the format is wrong, not the timing. Offer it in a different shape: you will walk them through what you found on a short call, or write the three things back in the email itself so they never have to click anything. Let them pick.',
      4: 'Three weeks out and nothing has landed. One proof point about US, about 90x return on ad spend and $2.34M in tracked revenue for a local home services business, which is the only number permitted here. Then one short question and nothing else.',
      5: 'Three lines, dry and human. You have written a few times, they are busy, you get it. Say you will leave it there and the breakdown stays up either way.',
    };
  } else {
    // Never opened. The subject line failed, not the offer. Nothing else can be inferred, and
    // critically, nothing about their business may be asserted to make the new subject land.
    context = 'IMPORTANT: they have NEVER opened any email from us. Do not reference a previous email, do not say "following up", "circling back" or "reaching out again", because from where they sit this is the first one. The subject line is what failed, so it must be genuinely different from a standard one, but it must still make no claim about their business.' + NOCLAIMS;
    angles = {
      1: 'Treat this as a first email, because to them it is. Open by naming what you did, plainly: you spent some time on how their business shows up online and wrote it up. No preamble, no introduction, no diagnosis. One line that it is written down and waiting.',
      2: 'Still a cold open. Lead with the proof point as a fact about somebody else, about 90x return on ad spend and $2.34M tracked for a local home services business. That number is about us and is the only number permitted here. Then say the same kind of write-up already exists with their name on it.',
      3: 'Still a cold open, and the first two subjects failed. Come at it from the plainest angle available: say in one line what you actually do for businesses in their category in their county, with no claim about them at all. One short question at the end.',
      4: 'Three weeks in and nothing has been opened. Two lines, no more. Say the write-up on their business is still sitting there and nobody has read it. No pitch, no question, just the fact and the link.',
      5: 'Last one. Two or three lines. Say you have written a few times and they have not landed, which usually means the timing is wrong rather than the interest. Say the breakdown stays up and you will stop writing. Never say request, sign up or run.',
    };
  }
  const prompt = `Write a short follow-up email (${length}) from Michelle at Open Heart Media to ${p.business}, a ${p.category} in ${p.city} GA. This is follow-up ${step} of 5. ${context} ${angles[step]} Voice: a sharp operator who already did the work and is telling them what he found, not a marketer selling a service. Plain, direct, a little dry. Confident enough to give the fix away. Lead with the specific thing, short sentences, every line earns its place, skimmable, no filler. Never use hype, urgency, flattery, "I hope this finds you well", "just following up", "I wanted to reach out", "circling back", "synergy", "leverage", "unlock" or "game changer". Write like a person who has looked at 400 of these sites and is mildly, specifically annoyed on their behalf. Reference their business naturally. Any tip must be specific and genuinely useful free value, never generic. Put the exact token [LINK] on its own line for ${linkPurpose}. Sign "Michelle, Open Heart Media". ${inbound ? 'They came to us and asked for this themselves, so speak to them as somebody who raised their hand. Never say we looked at their business unprompted.' : 'We ran this audit ourselves and sent it to them unprompted, so never write "your audit", "run your audit", "request", "sign up", "claim" or "get your free audit": the report already exists and already has their name on it.'} No em dashes, no exclamation marks, no hype words. SUBJECT LINE, same discipline as the first email and this is not optional: sentence case, UNDER 45 CHARACTERS, and it must name something SPECIFIC about THEIR business, a number from their report, their city, their category or what they will lose. NEVER the words "free", "audit", "check in", "checking in", "circle back", "following up", "touching base", "just wanted to", or any form of "did you get a chance". Those went out for months and were opened zero times. If the subject would still make sense sent to a different business, it is wrong and you must rewrite it. Return ONLY JSON {"subject":"...","body":"..."}`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  let t = ((r.content || []).find(b => b && b.type === 'text')?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  const o = JSON.parse(t);
  // Enforce the no-em-dash rule on both subject and body.
  const deDash = s => typeof s === 'string' ? s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+--\s+/g, ', ').replace(/--/g, ', ') : s;
  o.subject = deDash(o.subject); o.body = deDash(o.body);
  if (o.body) o.body = o.body.includes('[LINK]') ? o.body.replace('[LINK]', link) : o.body + '\n\n' + link;
  return assertGrounded(o, p, `followup ${step}`);
}
const FOLLOWUP_DAYS = { 1: 3, 2: 7, 3: 10, 4: 21, 5: 35 };
// Minimum spacing between two touches to the same lead, whatever the step maths says. Without it
// a lead whose first email went out late can receive steps back to back on the same day.
const MIN_FOLLOWUP_GAP_DAYS = 2;

// One-time repair for rows created before the sequence learned about inbound leads. Cold
// prospects already work off sent_at and are left alone. Two things get fixed: rows from our own
// mailboxes are marked internal so they stop counting as demand, and an inbound lead that really
// did receive something gets its sequence anchored to the day it received it, so the follow-up
// engine can finally see it. Runs once at boot and is a no-op afterwards.
function backfillSequenceAnchors() {
  let flagged = 0, anchored = 0;
  for (const p of prospects) {
    if (!p.internal && isOwnTeam(p.email)) { p.internal = true; flagged++; }
    if (p.internal || p.seq_anchor_at || p.sent_at) continue;
    const touch = [p.guide_sent_at, p.audited_at, p.delivered_at].filter(Boolean).sort()[0];
    if (touch) { p.seq_anchor_at = touch; anchored++; }
  }
  if (flagged || anchored) {
    save(prospects);
    console.log('[backfill] marked', flagged, 'internal,', anchored, 'inbound leads anchored into the sequence');
  }
}
try { backfillSequenceAnchors(); } catch (e) { console.error('[backfill] failed -', e.message); }

async function runFollowups() {
  const now = Date.now(); let sent = 0, parked = 0;
  // Follow-ups have their own budget so they cannot eat the new-prospecting quota. They still
  // land in the same inboxes from the same domain, so the two caps together are the real daily
  // volume and both matter to reputation.
  let budget = FOLLOWUP_DAILY_CAP - followupsSentToday();
  for (const p of prospects) {
    if (budget <= 0) break;
    // Anchored on the first touch of any kind, not just a cold send, so a guide download, an
    // audit report or a form reply all start the sequence the same way.
    const anchor = p.seq_anchor_at || p.sent_at;
    if (!anchor || !looksLikeEmail(p.email)) continue;
    if (p.unsubscribed_at) continue;
    if (['booked', 'replied', 'rejected', 'won', 'lost', 'unreachable', 'test', 'giveaway'].includes(p.status)) continue;   // giveaway entries are never cold followed up
    if (p.source === 'giveaway' || p.source === 'callleads') continue;
    if (p.internal) continue;                                  // our own team testing the forms
    const step = (p.followup_step || 0) + 1;
    if (step > 5) continue;
    const days = (now - new Date(anchor).getTime()) / 86400000;
    if (days < FOLLOWUP_DAYS[step]) continue;
    if (p.last_followup_at && (now - new Date(p.last_followup_at).getTime()) / 86400000 < MIN_FOLLOWUP_GAP_DAYS) continue;
    try {
      const msg = await draftFollowup(p, step);
      await sendMail(p, msg.subject, msg.body, { kind: 'followup' + step });
      p.followup_step = step; p.last_followup_at = new Date().toISOString(); p.updated_at = p.last_followup_at;
      // Keep what actually went out. Only followup_step and a timestamp were recorded before, so
      // when a lead wrote back to say an email was wrong about his business there was no way to
      // see what we had said to him, or to anyone else. Working that out needed SendGrid's
      // activity API, which only retains a partial window, so some of what we sent is gone for
      // good. The copy is cheap to keep and the alternative is not being able to answer for it.
      if (!Array.isArray(p.followups_sent)) p.followups_sent = [];
      p.followups_sent.push({ step, at: p.last_followup_at, subject: msg.subject, body: msg.body });
      p.followup_attempts = 0;
      save(prospects); sent++; budget--;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      p.followup_attempts = (p.followup_attempts || 0) + 1;
      if (e.suppressed || e.permanent || isPermanentFailure(e) || p.followup_attempts >= MAX_SEND_ATTEMPTS) {
        p.status = 'unreachable'; p.updated_at = new Date().toISOString(); parked++;
      }
      save(prospects);
      console.error('[followup]', p.id, e.message, p.status === 'unreachable' ? '(parked)' : '');
    }
  }
  if (sent || parked) console.log('[followups] sent', sent, 'parked', parked);
  return sent;
}
function followupsSentToday() {
  const today = new Date().toISOString().slice(0, 10);
  return prospects.filter(p => (p.last_followup_at || '').slice(0, 10) === today).length;
}
// Returns immediately: a full run is hours of work, far past any HTTP timeout.
app.post('/api/prescan', (req, res) => {
  if (prescanState.running) return res.status(409).json({ error: 'a pre-scan is already running', state: prescanState });
  const limit = Number(req.body?.limit) || 0;
  const force = req.body?.force === true;
  const mailableOnly = req.body?.mailableOnly === true;
  const after = typeof req.body?.after === 'string' ? req.body.after : null;
  // Written before the run starts so a crash one minute in still leaves a resumable instruction.
  if (after) setRescanCutoff(null, after);
  else if (force && !limit && !mailableOnly) setRescanCutoff(new Date().toISOString());
  // engaged: rebuild the reports of people we have ALREADY emailed, since those are the ones
  // who will open the link and read it, and any made before the accuracy fixes are suspect.
  if (Array.isArray(req.body?.ids) && req.body.ids.length) {
    const only = prospects.filter(p => req.body.ids.includes(p.id) && p.website && /^https?:\/\//i.test(p.website));
    runPrescan({ only }).catch(e => console.error('[prescan] run failed -', e.message));
    return res.json({ started: true, queued: only.length, ids: true });
  }
  if (req.body?.engaged === true) {
    const only = prospects.filter(p => p.source !== 'callleads' && p.sent_at && !p.unsubscribed_at
      && ['sent', 'clicked', 'replied', 'audited', 'booked'].includes(p.status)
      && p.website && /^https?:\/\//i.test(p.website) && !isPlatformHost(p.website) && !reportSendable(p).ok);
    runPrescan({ only: limit > 0 ? only.slice(0, limit) : only }).catch(e => console.error('[prescan] run failed -', e.message));
    return res.json({ started: true, queued: limit > 0 ? Math.min(limit, only.length) : only.length, engaged: true });
  }
  const pending = prescanTargets({ force, mailableOnly }).length;
  runPrescan({ limit, force, mailableOnly }).catch(e => console.error('[prescan] run failed -', e.message));
  res.json({ started: true, queued: limit > 0 ? Math.min(limit, pending) : pending, cutoff: rescanCutoff() });
});
// Clears the standing instruction, so a rescan can be called off without stopping the process.
app.post('/api/prescan/clear-cutoff', (_, res) => { setRescanCutoff(null); res.json({ cleared: true }); });
app.post('/api/prescan/stop', (_, res) => { prescanState.stop = true; res.json({ stopping: true }); });
app.get('/api/prescan/status', (_, res) => {
  const withReport = prospects.filter(p => p.prescan_at && p.audit_report).length;
  const failed = prospects.filter(p => p.prescan_failed_at && !p.prescan_at).length;
  res.json({
    ...prescanState,
    remaining: prescanTargets().length,
    rescanCutoff: rescanCutoff(),
    reportsReady: withReport,
    permanentlyFailed: failed,
    totalProspects: prospects.length,
  });
});

app.post('/api/run-followups', async (_, res) => { res.json({ sent: await runFollowups() }); });

// A bare setInterval only fires while this process happens to be alive. The host restarts on
// deploy and idles the instance out, so an interval alone silently skips days. This keeps the
// interval as the fast path and adds a stamped catch-up that notices a missed day after any
// restart and runs once, so the sequence survives the process not being.
const FOLLOWUP_STAMP = path.join(DATA_DIR, 'followups_last_run.json');
function lastFollowupRun() {
  try { return new Date(JSON.parse(fs.readFileSync(FOLLOWUP_STAMP, 'utf8')).ts).getTime(); } catch { return 0; }
}
function stampFollowupRun() {
  try { fs.writeFileSync(FOLLOWUP_STAMP, JSON.stringify({ ts: new Date().toISOString() })); } catch {}
}
async function followupTick(reason) {
  if (sendingPaused()) return;
  if (Date.now() - lastFollowupRun() < 20 * 60 * 60 * 1000) return;   // already ran within the day
  stampFollowupRun();
  console.log('[followups] running,', reason);
  try { await runFollowups(); } catch (e) { console.error('[followups] run failed -', e.message); }
}
setInterval(() => followupTick('interval'), 60 * 60 * 1000);
setTimeout(() => followupTick('boot catch-up'), 90 * 1000);


// ---------- Held audit recovery ----------
// A held audit is the worst lead in the system to lose. They are not cold: they went to the page,
// typed in their site and their email, and asked for something. The report was withheld because it
// came back degraded, which in practice has meant one thing every time, the Anthropic key running
// out of credit. Michelle gets an internal alert, the lead gets nothing, and that is where it ends.
// Nothing retried them. audit_held was set in the audit job and cleared only if that same person
// happened to fill the form in a second time. Brad's sat held from 21 Aug and Griffin's from 7 Sep,
// four hours after the credits ran out, and neither would ever have been picked up by the system.
// Retry them once the model is answering again. A recovered report goes out through the ordinary
// path, so the lead receives the same email they would have got at the time.
const HELD_RETRY_GAP_MS = 6 * 60 * 60 * 1000;
const HELD_RETRY_MAX = 5;
async function heldAuditTick(reason) {
  const now = Date.now();
  const due = prospects.filter(p =>
    p.status === 'audit_held'
    && (p.audit_email || p.email)
    && p.website
    && (p.audit_retry_count || 0) < HELD_RETRY_MAX
    && now - new Date(p.audit_retry_at || 0).getTime() > HELD_RETRY_GAP_MS);
  if (!due.length) return;

  // The thing that held these is almost always the model being unreachable. Ask it one cheap
  // question first: if it is still down, every retry would degrade again, burn a full scan each,
  // and count against the attempt cap for nothing.
  if (!(await modelIsAnswering())) {
    console.log(`[held] ${due.length} held audit(s) waiting, model still unavailable, not retrying`);
    return;
  }

  // One per tick. These are slow jobs and there is never a queue of them worth rushing.
  const p = due[0];
  p.audit_retry_count = (p.audit_retry_count || 0) + 1;
  p.audit_retry_at = new Date().toISOString();
  try { save(prospects); } catch {}
  console.log(`[held] retrying ${p.id} (${p.audit_email || p.email}), attempt ${p.audit_retry_count}, ${reason}`);
  const jobId = crypto.randomBytes(12).toString('hex');
  enqueueAudit(jobId, {
    ref: p.id, email: p.audit_email || p.email, goal: p.audit_goal || null,
    firstName: p.contact_first || '', lastName: p.contact_last || '',
    isTest: false, site: p.website, p, lookup: null,
    bizName: p.business || null, bizCity: p.city || null, bizCategory: p.category || null,
  });
  if (p.audit_retry_count >= HELD_RETRY_MAX) {
    await alertTeam('Held audit giving up', `${esc(p.business || p.id)} (${esc(p.audit_email || p.email || '')}) has been retried ${HELD_RETRY_MAX} times and the report still will not generate cleanly.<br/><br/>This one needs a person. They asked for an audit and have not received it.`).catch(() => {});
  }
}

// Cheapest possible liveness check on the model. Costs a handful of tokens and answers the only
// question that matters before a retry: is it going to degrade again.
async function modelIsAnswering() {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}

setInterval(() => heldAuditTick('interval').catch(e => console.error('[held]', e.message)), 60 * 60 * 1000);
setTimeout(() => heldAuditTick('boot catch-up').catch(e => console.error('[held]', e.message)), 120 * 1000);


// ---------- Automatic daily cold send ----------
// Cold sending was the only part of this system that still needed a person. Follow-ups ran on
// their own hourly tick, but the first touch required somebody to draft a batch, approve it and
// press send. Any day that did not happen, nothing went out at all: on 29 Aug the queue held
// zero approved and 1,279 prospects that had never been drafted, so the day sent nothing while
// the list sat there. This closes that loop.
//
// Everything that gated a manual send still gates this one. sendMail refuses an unsubscribed
// lead, checks the address is deliverable before spending the sending domain on it, and parks a
// lead as unreachable after a permanent failure instead of retrying it forever.
// Opt IN, not opt out. This used to read `!== '0'`, which meant an unset variable
// turned automatic sending ON. A cleared dashboard value, a new environment, or a
// restored service would all start mailing strangers with nobody having decided
// that it should. The failure is silent and it is outbound, which is the worst
// combination. Now it sends only when AUTOSEND is explicitly '1'.
const AUTOSEND = process.env.AUTOSEND === '1';        // kill switch, no deploy needed

// ---------- Mailchimp ----------
// SendGrid does cold outreach and transactional mail; newsletters live in Mailchimp, which sends
// from its own infrastructure so a rough prospecting week cannot push client mail into spam.
// The only missing piece was the bridge: somebody downloads the guide and nothing carries them
// across, so the audience never grows. Idempotent by design (PUT on the subscriber hash), and a
// complete no-op until the two env vars are set, so it can ship before the key exists.
const MC_KEY = process.env.MAILCHIMP_API_KEY || '';
const MC_LIST = process.env.MAILCHIMP_LIST_ID || '';
const MC_DC = MC_KEY.includes('-') ? MC_KEY.split('-').pop() : '';

async function mailchimpUpsert(email, { first = '', last = '', tags = [] } = {}) {
  if (!MC_KEY || !MC_LIST || !MC_DC) return { skipped: 'mailchimp not configured' };
  const addr = String(email || '').trim().toLowerCase();
  if (!looksLikeEmail(addr)) return { skipped: 'not an address' };
  // Mailchimp addresses a member by the md5 of the lowercased email, so PUT is an upsert and a
  // second guide download does not come back as "Member Exists".
  const hash = crypto.createHash('md5').update(addr).digest('hex');
  const r = await fetch(`https://${MC_DC}.api.mailchimp.com/3.0/lists/${MC_LIST}/members/${hash}`, {
    method: 'PUT',
    headers: { Authorization: 'Basic ' + Buffer.from('key:' + MC_KEY).toString('base64'),
               'Content-Type': 'application/json' },
    body: JSON.stringify({
      email_address: addr,
      status_if_new: 'subscribed',          // never re-subscribe somebody who already opted out
      merge_fields: { FNAME: first || '', LNAME: last || '' },
      tags,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`mailchimp ${r.status}: ${body.slice(0, 160)}`);
  }
  return { ok: true };
}

// Diagnostic: ask Mailchimp which audiences the key can see, and whether the configured
// list id is one of them. Cheaper than hunting the Audience ID through the UI, and it says
// plainly whether a 404 is a wrong list or a wrong key.
app.get('/api/mailchimp/lists', async (_, res) => {
  if (!MC_KEY || !MC_DC) return res.status(400).json({ error: 'MAILCHIMP_API_KEY not set or has no datacentre suffix' });
  try {
    const r = await fetch(`https://${MC_DC}.api.mailchimp.com/3.0/lists?count=50&fields=lists.id,lists.name,lists.stats.member_count`,
      { headers: { Authorization: 'Basic ' + Buffer.from('key:' + MC_KEY).toString('base64') } });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: body.detail || body.title || 'mailchimp error', status: r.status });
    const lists = (body.lists || []).map(l => ({ id: l.id, name: l.name, members: l.stats?.member_count }));
    // Never echo the configured value: it is whatever was pasted into the env var, and if that
    // was the API key by mistake then printing it back leaks the key into whoever is looking.
    res.json({ dc: MC_DC, configuredLooksLikeAKey: MC_LIST.length > 20 || MC_LIST.includes('-'),
               matches: lists.some(l => l.id === MC_LIST), lists });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Deliverability governor ----------
// Volume is not the constraint, reputation is. A domain that keeps sending through a rising
// bounce rate stops reaching anybody, and that damage takes months to undo rather than days.
// So the day's cold cap is read off the last seven days of real SendGrid numbers instead of
// being a constant somebody picked once: a clean week earns more volume, a bad week loses it
// before the sending domain does, and a genuinely bad week stops the run entirely.
const COLD_FLOOR = Number(process.env.COLD_FLOOR || 20);
const COLD_CEILING = Number(process.env.COLD_CEILING || 90);
let healthCache = { at: 0, data: null };

async function sendingHealth() {
  const steady = { ok: true, cap: COLD_DAILY_CAP, why: 'stats unavailable, holding at the configured cap' };
  if (healthCache.data && Date.now() - healthCache.at < 3 * 60 * 60 * 1000) return healthCache.data;
  if (!process.env.SENDGRID_API_KEY) return steady;
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const r = await fetch(`https://api.sendgrid.com/v3/stats?start_date=${since}&aggregated_by=day`,
      { headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` } });
    if (!r.ok) return steady;
    const T = {};
    for (const day of await r.json())
      for (const st of (day.stats || []))
        for (const [k, v] of Object.entries(st.metrics || {})) T[k] = (T[k] || 0) + v;

    const req = T.requests || 0;
    if (req < 100) return { ok: true, cap: COLD_DAILY_CAP, why: `only ${req} sends in 7 days, too few to judge` };
    const delivered = T.delivered || 0;
    const deliveredPct = 100 * delivered / req;
    const bouncePct = 100 * ((T.bounces || 0) + (T.bounce_drops || 0) + (T.blocks || 0)) / req;
    // Complaints are measured against what actually arrived, which is the ratio mailbox
    // providers themselves watch. 0.1% is the line where Google and Microsoft start filtering.
    const spamPct = 100 * (T.spam_reports || 0) / Math.max(1, delivered);

    let h;
    if (bouncePct >= 8 || spamPct >= 0.3) {
      h = { ok: false, cap: 0, why: `halted: hard failures ${bouncePct.toFixed(2)}%, complaints ${spamPct.toFixed(3)}%` };
    } else if (bouncePct >= 4 || spamPct >= 0.1 || deliveredPct < 90) {
      h = { ok: true, cap: COLD_FLOOR, why: `throttled to ${COLD_FLOOR}: delivered ${deliveredPct.toFixed(1)}%, hard failures ${bouncePct.toFixed(2)}%, complaints ${spamPct.toFixed(3)}%` };
    } else if (deliveredPct >= 95 && bouncePct < 2 && spamPct < 0.05) {
      h = { ok: true, cap: Math.min(COLD_CEILING, COLD_DAILY_CAP + 10), why: `healthy at ${deliveredPct.toFixed(1)}% delivered, stepping up` };
    } else {
      h = { ok: true, cap: COLD_DAILY_CAP, why: `steady: delivered ${deliveredPct.toFixed(1)}%, hard failures ${bouncePct.toFixed(2)}%` };
    }
    h.stats = { requests: req, deliveredPct: +deliveredPct.toFixed(1), bouncePct: +bouncePct.toFixed(2), spamPct: +spamPct.toFixed(3) };
    healthCache = { at: Date.now(), data: h };
    return h;
  } catch (e) {
    console.error('[health] could not read SendGrid stats -', e.message);
    return steady;
  }
}
const AUTOSEND_HOUR_START = Number(process.env.AUTOSEND_HOUR_START || 9);
const AUTOSEND_HOUR_END = Number(process.env.AUTOSEND_HOUR_END || 16);
const AUTOSEND_TZ = process.env.AUTOSEND_TZ || 'America/New_York';
const AUTOSEND_STAMP = path.join(DATA_DIR, 'autosend_last_run.json');

function localNow() {
  // Render runs in UTC. A cold email that lands at 4am reads as a blast, so the window has to be
  // the recipient's working day, not the server's.
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: AUTOSEND_TZ, hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const hour = Number(f.find(x => x.type === 'hour').value);
  const day = f.find(x => x.type === 'weekday').value;
  return { hour, day };
}
function inSendWindow() {
  const { hour, day } = localNow();
  if (day === 'Sat' || day === 'Sun') return false;   // weekend cold email performs badly
  return hour >= AUTOSEND_HOUR_START && hour < AUTOSEND_HOUR_END;
}
function lastAutosendRun() {
  try { return new Date(JSON.parse(fs.readFileSync(AUTOSEND_STAMP, 'utf8')).ts).getTime(); } catch { return 0; }
}
function stampAutosendRun() {
  try { fs.writeFileSync(AUTOSEND_STAMP, JSON.stringify({ ts: new Date().toISOString() })); } catch {}
}

// Scans the leads the sender will reach next so every email goes out with a report written after
// the accuracy fixes. Without this the gate above would starve the queue, because almost every
// waiting lead was scanned on Aug 24. Bounded per day to keep API spend predictable.
async function ensureFreshReports(wanted) {
  if (prescanState.running) return;
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const spokenFor = claimedAddresses(true);
  const batch = [];
  for (const p of prospects) {
    if (batch.length >= wanted) break;
    if (p.source === 'callleads' || p.status !== 'new' || !isMailableBusiness(p.email) || p.unsubscribed_at || isHeldBack(p)) continue;
    if (!p.website || !/^https?:\/\//i.test(p.website) || isPlatformHost(p.website)) continue;
    if (reportSendable(p).ok) continue;
    if (p.prescan_failed_at && new Date(p.prescan_failed_at).getTime() > cutoff) continue;
    const addr = normEmail(p.email);
    if (spokenFor.has(addr)) continue;
    spokenFor.add(addr);
    batch.push(p);
  }
  if (!batch.length) return;
  console.log('[autosend] rescanning', batch.length, 'leads before drafting');
  await runPrescan({ only: batch });
}

async function runDailyCold() {
  // Cold sends now have their own cap, so a heavy follow-up day no longer reduces new outreach.
  // The cap itself is set by measured deliverability rather than by a constant, so a good week
  // earns more volume and a bad one loses it before the domain does.
  const health = await sendingHealth();
  if (!health.ok) {
    console.error('[autosend] not sending today -', health.why);
    return { sent: 0, drafted: 0, approved: 0, reason: health.why };
  }
  if (health.cap !== COLD_DAILY_CAP) console.log('[autosend] cap', health.cap, '-', health.why);
  let budget = health.cap - sentToday();
  if (budget <= 0) return { sent: 0, drafted: 0, approved: 0, reason: 'daily cap reached' };

  // Draft only what is missing, so a queue left over from yesterday is used before writing more.
  const readyNow = prospects.filter(p => p.status === 'approved').length;
  let drafted = 0;
  const need = budget - readyNow;
  if (need > 0) {
    // Reports are rebuilt first and only the ones that pass reportSendable are drafted below.
    try { await ensureFreshReports(Math.min(60, Math.ceil(need * 1.5))); }
    catch (e) { console.error('[autosend] rescan failed -', e.message); }
    // Skip addresses another record has already claimed, queued ones included. Drafting
    // for a duplicate costs an Anthropic call to produce copy that the send guard will
    // throw away, and on a list with 153 duplicate records that is real money.
    const spokenFor = claimedAddresses(true);
    const todo = [];
    for (const p of prospects) {
      if (todo.length >= need) break;
      if (p.status !== 'new' || !isMailableBusiness(p.email) || p.unsubscribed_at || isHeldBack(p)) continue;
      if (!reportSendable(p).ok) continue;
      const addr = normEmail(p.email);
      if (spokenFor.has(addr)) continue;
      spokenFor.add(addr);   // so a second record for the same address is skipped in this run too
      todo.push(p);
    }
    for (const p of todo) {
      try {
        const d = await draftEmail(p);
        p.subject = d.subject; p.body = d.body; p.preview = inboxPreview(d.body);
        p.status = 'drafted';
        p.updated_at = new Date().toISOString();
        drafted++;
        save(prospects);
      } catch (e) {
        console.error('[autosend] draft failed', p.id, e.message);
      }
    }
  }

  // A draft that came back empty is a failed generation, not something to mail to a stranger.
  let approved = 0;
  for (const p of prospects) {
    if (approved >= budget) break;
    if (p.status !== 'drafted') continue;
    if (!p.subject || !p.body || p.body.trim().length < 120) continue;
    if (p.unsubscribed_at || !isMailableBusiness(p.email) || isHeldBack(p)) continue;
    if (!reportSendable(p).ok) continue;
    p.status = 'approved';
    p.approved_by = 'auto';
    p.updated_at = new Date().toISOString();
    approved++;
  }
  if (approved) save(prospects);

  const result = await sendApprovedBatch(budget);
  console.log('[autosend] drafted', drafted, 'approved', approved, 'sent', result.sent, 'parked', result.parked);
  return { ...result, drafted, approved };
}

async function autosendTick(reason) {
  if (!AUTOSEND || sendingPaused()) return;
  const previous = lastAutosendRun();
  if (Date.now() - previous < 20 * 60 * 60 * 1000) return;  // once a day
  if (!inSendWindow()) return;
  // Stamped up front so two ticks cannot overlap on a slow run.
  stampAutosendRun();
  console.log('[autosend] running,', reason);
  let result = null;
  try { result = await runDailyCold(); }
  catch (e) { console.error('[autosend] run failed -', e.message); }

  // A run that achieved nothing must not consume the day. On 7 Sep the tick fired at 9:22am while
  // the Anthropic key was out of credit, so every draft threw, nothing was written, nothing was
  // sent, and the stamp still said the day was done. The next attempt would have been the
  // following morning: one upstream outage lasting minutes cost a full day of outreach, silently.
  // Roll the stamp back so the 30 minute interval picks it up again once the cause clears.
  const didSomething = result && ((result.sent || 0) > 0 || (result.drafted || 0) > 0);
  const cappedOut = result && result.reason === 'daily cap reached';
  if (!didSomething && !cappedOut) {
    try { fs.writeFileSync(AUTOSEND_STAMP, JSON.stringify({ ts: new Date(previous).toISOString() })); } catch {}
    console.warn('[autosend] run produced nothing, day not consumed, will retry on the next tick');
  }
}
// Same belt and braces as the follow-ups: the interval is the fast path, and the boot check
// catches a day missed while the instance was idled out or redeploying.
setInterval(() => autosendTick('interval'), 30 * 60 * 1000);
setTimeout(() => autosendTick('boot catch-up'), 120 * 1000);

// Manual trigger, for testing and for a day you want it to go early. Ignores the window and the
// once-a-day stamp on purpose, but still respects the cap.
// AUTOSEND is read from the environment once at boot, so the only way to stop sending was to
// change a Render env var and wait for a redeploy. That is a slow switch to reach for when copy is
// going out that should not be. This is the fast one: it holds in the data directory, so it also
// survives the restart that a redeploy causes.
const PAUSE_FILE = path.join(DATA_DIR, 'autosend_paused.json');
function sendingPaused() {
  try { return !!JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')).paused; } catch { return false; }
}
app.post('/api/autosend-pause', (req, res) => {
  const paused = req.body?.paused !== false;
  const reason = String(req.body?.reason || '').slice(0, 500);
  try {
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ paused, reason, at: new Date().toISOString() }));
  } catch (e) { return res.status(500).json({ error: e.message }); }
  console.warn(`[autosend] ${paused ? 'PAUSED' : 'resumed'}${reason ? ' - ' + reason : ''}`);
  res.json({ paused, reason });
});

app.post('/api/run-autosend', async (_, res) => {
  if (sendingPaused()) return res.status(409).json({ error: 'sending is paused, POST /api/autosend-pause {"paused":false} to resume' });
  try {
    stampAutosendRun();
    res.json(await runDailyCold());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/autosend-status', (_, res) => {
  const { hour, day } = localNow();
  // The pause switch lives on disk and survives a redeploy, but nothing reported it,
  // so the dashboard could not tell you whether tomorrow morning was going to send.
  // `enabled` is the environment variable read once at boot; `paused` is the fast
  // switch; `sending` is the only one of the three that answers the actual question.
  let pause = {};
  try { pause = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')); } catch {}
  res.json({
    enabled: AUTOSEND,
    paused: !!pause.paused,
    sending: AUTOSEND && !pause.paused,
    pausedReason: pause.reason || null,
    pausedAt: pause.at || null,
    window: `${AUTOSEND_HOUR_START}:00 to ${AUTOSEND_HOUR_END}:00 ${AUTOSEND_TZ}, weekdays`,
    localHour: hour, localDay: day, inWindow: inSendWindow(),
    lastRun: lastAutosendRun() ? new Date(lastAutosendRun()).toISOString() : null,
    coldDailyCap: COLD_DAILY_CAP,
    mailchimp: { key: !!MC_KEY, list: !!MC_LIST, dc: MC_DC || null },
    followupDays: FOLLOWUP_DAYS,
    model: 'claude-sonnet-5',
    health: healthCache.data || null,
    followupDailyCap: FOLLOWUP_DAILY_CAP,
    maxTotalPerDay: COLD_DAILY_CAP + FOLLOWUP_DAILY_CAP,
    sentToday: sentToday(), followupsToday: followupsSentToday(),
    coldBudgetLeft: Math.max(0, COLD_DAILY_CAP - sentToday()),
    followupBudgetLeft: Math.max(0, FOLLOWUP_DAILY_CAP - followupsSentToday()),
    queue: {
      approved: prospects.filter(p => p.status === 'approved').length,
      drafted: prospects.filter(p => p.status === 'drafted').length,
      new: prospects.filter(p => p.status === 'new').length,
    },
  });
});

app.post('/api/reseed', (_, res) => { prospects = seedFromCsv(); ensureCallLeads(); res.json({ count: prospects.length }); });

const PORT = process.env.PORT || 4100;
// Flush on the way down so a graceful redeploy loses nothing at all.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { flushJobs(); } catch {} process.exit(0); });
}

restoreJobs();

// The host restarts on every deploy and idles the instance out, and a pre-scan of the whole list
// is many hours of work. Without this, any restart silently abandons the run half finished and
// somebody has to notice and kick it off again. Targets are chosen by "has no report yet", so
// resuming simply continues where it stopped rather than redoing anything.
if (process.env.PRESCAN_AUTORESUME !== '0') {
  setTimeout(() => {
    const left = prescanTargets().length;
    if (!left || prescanState.running) return;
    console.log('[prescan] resuming after restart,', left, 'sites left');
    runPrescan({}).catch(e => console.error('[prescan] resume failed -', e.message));
  }, 120 * 1000);   // let the boot settle, and let the canary go first
}

app.listen(PORT, () => console.log(`OHM Outreach dashboard on http://localhost:${PORT}`));
