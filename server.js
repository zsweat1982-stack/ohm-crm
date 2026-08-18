import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import sgMail from '@sendgrid/mail';
import PDFDocument from 'pdfkit';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Runtime data lives in DATA_DIR (a persistent disk in production). The committed ./data folder
// is the seed: on first boot to a fresh disk, copy the seed prospects in so nothing is lost.
const SEED_DIR = path.join(__dirname, 'data');
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
const DAILY_CAP = Number(process.env.DAILY_SEND_CAP) || 40;
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

// ---------- Claude draft ----------
// Lightweight AI-visibility probe: does an AI assistant actually recognize this business? Training-knowledge only, no guessing.
async function aiVisibilityProbe(business, city, category) {
  if (!process.env.ANTHROPIC_API_KEY || !business) return null;
  try {
    const probe = `You are testing whether AI assistants recognize a specific local business. Answer ONLY from your own training knowledge. Do NOT guess, infer, or invent. If you do not genuinely and specifically recognize this exact business, set known to false.
Business: "${business}"${city ? ', in ' + city + ', GA' : ''}${category ? ' - a ' + category : ''}.
Return ONLY JSON: {"known": true|false, "confidence": "high|medium|low", "wouldRecommend": true|false, "competitorsKnown": true|false, "whatAiKnows": "one honest sentence"}`;
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: probe }] });
    let t = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
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

  const angle = pickAngle(p);
  // Rotate which finding leads, not which subject line: the subject has to be about the same thing
  // the body is about, and rotating them independently drifted them apart.
  const fh = crypto.createHash('sha1').update('finding:' + p.id).digest()[0];
  const top = (rep.findings.length > 1 && (fh & 1)) ? rep.findings[1] : rep.findings[0];
  const ps = p.audit_scan && p.audit_scan.pagespeed;
  const facts = [
    p.rating && p.reviews ? `Google rating ${p.rating} from ${p.reviews} reviews` : null,
    ps && ps.lcpLabel ? `mobile largest contentful paint ${ps.lcpLabel}` : null,
    ps && ps.performance != null ? `mobile PageSpeed performance score ${ps.performance} out of 100` : null,
    angle ? `their weakest area is ${angle.name} at ${angle.score} out of 100` : null,
  ].filter(Boolean);

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

  const subjHints = (angle ? angle.subj : ['what is costing you customers'])
    .map(t => t.replace('{cat}', (p.category || 'business').toLowerCase())
               .replace('{city}', (p.city || '').toLowerCase())
               .replace('{n}', String(p.reviews || '')))
    .join('" or "');

  const prompt = `You are Michelle at Open Heart Media in Canton, Georgia. You are writing one cold email to a local business owner.

CRITICAL CONTEXT: we have ALREADY scanned this business. The report is built and waiting at the link. You are NOT offering to run anything, NOT asking permission, NOT inviting them to request an audit. You are telling them one thing you already found. Never use the words "free audit", and never ask them to run, request or start a scan.

BUSINESS: ${p.business}, a ${p.category} in ${p.city}, GA.

WHAT THE SCAN ACTUALLY FOUND (use ONLY this, invent nothing):
- Biggest problem: ${top.title}
- Detail: ${top.detail || ''}
${facts.length ? '- Real measurements: ' + facts.join('; ') : ''}
${angle && angle.why ? '- Why that area scored badly: ' + angle.why : ''}

WRITE:
1. Subject line. SENTENCE CASE (capital first letter only, everything else lowercase unless it is a proper noun). UNDER 45 CHARACTERS. No exclamation marks, no ALL CAPS, never the words "free" or "audit", never their name.
   THE SUBJECT MUST BE ABOUT THE SAME PROBLEM AS THE BODY. Both come from "Biggest problem" above. Do not write a subject about one issue and a body about another. For tone, shapes like "${subjHints}" work, but the topic must match the finding.

2. Body. THIS IS THE PART THAT MATTERS. UNDER 65 WORDS TOTAL. Structure it as FIVE SHORT BLOCKS separated by blank lines, because a wall of text gets archived unread:

   Line 1: write exactly this opener and nothing else: ${opener}
   Line 2: the finding, about THEM, second person, one sentence, with ONE real number.
           Write "Your site takes 9 seconds to load on a phone." NOT "We ran a scan and found that your site is taking 9 seconds to load on mobile, which is the device most people use."
   Line 3: what it costs them in customers or money, one sentence, plain words. Then, in the SAME block, a short clause that takes the sting out by making clear this is invisible from the inside and not a failure on their part. For example "Nobody ever sees their own site on a bad connection", "It's the kind of thing that only shows up in a test", "Your web guy wouldn't catch this either". Vary the wording to fit the finding.
   Line 4: one short handoff, for example "Here's what that's costing you:" or "Full breakdown here:"
   [LINK]
   Line 5: write exactly this closing line and nothing else: ${closer}

3. Sign exactly, on three lines:
Michelle Baker
Open Heart Media
openheartmediaco.com

TONE: direct, but human. You are a person in Canton who looked at their business for ten minutes, not a scanner printing a result. Contractions always. Never chatty, never padded, never apologetic. Being brief IS the courtesy here, so do not add warm-up lines, but the close should sound like a person wrote it.

HARD RULES:
- Under 65 words. Count them. Shorter always wins.
- NEVER make them feel stupid. They built this business and are proud of it. The finding is a fact about a machine, not a verdict on them. No "unfortunately", no "sadly", no "you should have", no lecturing, and never imply carelessness.
- Dry wit is welcome in the phrasing. Smugness is not. If a line would make them wince rather than smile, cut it.
- NEVER open with "We ran a scan", "We scanned", "I ran your site through", or anything about our process. They do not care what we did, only what is true about them. State the finding directly.
- NO third-party statistics, no "Google's own data shows", no research citations, no percentages that are not about THEIR business. That is education, and nobody clicks because they learned something. They click because something of theirs is broken.
- One finding only. A second one means neither lands.
- Do not explain how to fix it. The fix is the product.
- Do not mention video, social or web design as services.

BANNED WORDS AND PHRASES: em dashes and any dash used as punctuation, exclamation marks, "hope this finds you well", "quick question", "I wanted to reach out", "leverage", "unlock", "scale", "solutions", "circle back", "synergy", "in today's digital landscape".

Return ONLY JSON: {"subject": "...", "body": "..."}`;

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }],
  });
  return finishDraft(r, p);
}

// Fallback for a lead with no stored report: the live AI-visibility probe is a real observation,
// so it is honest to lead with it.
async function draftEmailUnscanned(p) {
  const ai = await aiVisibilityProbe(p.business, p.city, p.category);
  const invisible = !!(ai && ai.known === false);
  const prompt = `You are Michelle at Open Heart Media in Canton, Georgia, writing one cold email to ${p.business}, a ${p.category} in ${p.city}, GA${p.rating && p.reviews ? `, rated ${p.rating} from ${p.reviews} Google reviews` : ''}.

${invisible
  ? `TRUE AND JUST CHECKED: we asked an AI assistant to recommend a ${p.category} in ${p.city} and ${p.business} did not come up. Lead with that, stated flatly. Then one line on what it costs: more buyers now ask AI assistants for a local ${p.category}, so whoever it does name gets the call.`
  : `Lead with one specific, genuine observation about their standing as a ${p.category} in ${p.city}, using their real review numbers. Then one line: a business this good is losing customers who never find or book them.`}

Then the token [LINK] alone on its own line, introduced as a breakdown you put together for them. Then one short, warm closing line, varied rather than the same every time. Sign exactly on three lines: Michelle Baker / Open Heart Media / openheartmediaco.com

RULES: subject in SENTENCE CASE (capital first letter only) and UNDER 45 CHARACTERS, no exclamation marks, never the words "free" or "audit", never their name. Body UNDER 50 WORDS in four short blocks separated by blank lines, plain words, contractions. Never open with "we ran a scan" or anything about our process, state the finding directly about them. No third-party statistics. The first body line must not repeat the subject. BANNED: em dashes and dashes as punctuation, exclamation marks, "hope this finds you well", "leverage", "unlock", "scale", "solutions". Invent no numbers.

Return ONLY JSON: {"subject": "...", "body": "..."}`;

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }],
  });
  return finishDraft(r, p);
}

function finishDraft(r, p) {
  let txt = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
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
    out.subject = out.subject.slice(0, 45).replace(/\s+\S*$/, '').trim();
  }

  const link = reportUrl(p);
  if (out.body.includes('[LINK]')) out.body = out.body.replace('[LINK]', link);
  else out.body = out.body.replace(/\n*Michelle,/, `\n\n${link}\n\nMichelle,`);
  if (!out.body.includes(link)) out.body += `\n\n${link}`;
  // Asked for in the prompt and dropped every single time, so it is enforced rather than requested.
  if (!/Michelle/i.test(out.body)) out.body = out.body.replace(/\s*$/, '') + '\n\nMichelle Baker\nOpen Heart Media';
  // A recognisable domain they can look up themselves. Wariness about links from strangers is
  // reasonable, and the answer is giving them something checkable, not a shorter URL.
  if (!/openheartmediaco\.com\s*$/i.test(out.body)) out.body = out.body.replace(/\s*$/, '') + '\nopenheartmediaco.com';
  out.body = out.body.replace(/^Michelle,?\s*$/m, 'Michelle Baker');
  return out;
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
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': AUDIT_UA } });
    // 900KB was too small: heavy page builders (Wix, Squarespace, etc.) routinely front-load huge
    // amounts of inline script/CSS/JSON before the real body content, so real signals like the H1
    // and images were getting silently truncated away on larger sites. 6MB comfortably covers that
    // while still bounding memory on a pathological response.
    const html = (await res.text()).slice(0, 6000000);
    return { ok: res.ok, status: res.status, finalUrl: res.url, html };
  } catch (e) { return { ok: false, error: e.message, finalUrl: url, html: '' }; }
}

// Tighter social detection: ignore share/pixel/plugin/intent links, keep real profile links only.
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
  const hasNewsletter = (/(subscribe|sign\s?up|join)[^<>]{0,45}(newsletter|email list|mailing list|our email|updates)/i.test(text) || /(join our (email|mailing) list|get (our )?newsletter)/i.test(text)) && /<input[^>]+type=["']email["']/i.test(html);
  const hasLiveChat = /(intercom|drift\.com|tawk\.to|zendesk|tidio|crisp\.chat|hubspot[^"']*conversations|livechatinc|customerchat|messenger[^"']*chat|gorgias|podium|chatwoot|olark|liveperson)/i.test(html);
  const hasCta = /(get (a |your )?(free )?(quote|estimate|consultation|demo|assessment|inspection|pricing)|request (a |your )?(free )?(quote|estimate|consultation|callback|appointment)|book (a |your |now|online|an appointment)|schedule (a |your |an? |now|online)|call now|claim your|get started|start (your|a) )/i.test(html);
  const hasPhone = /href=["']tel:\+?[0-9]/i.test(html);
  const hasEmailLink = /href=["']mailto:[^"']+@/i.test(html);
  const napAddress = /\b\d{1,6}\s+([A-Za-z0-9.'\-]+\s){1,4}(street|st\.?|ave\.?|avenue|road|rd\.?|blvd\.?|boulevard|drive|dr\.?|lane|ln\.?|way|court|ct\.?|suite|ste\.?|hwy|highway|pkwy|parkway|place|pl\.?|circle|cir\.?|trail|terrace)\b/i.test(text) && /\b(GA|Georgia)\b/.test(text)
    || /\b[A-Za-z.\s]{2,25},\s*GA\s+3\d{4}\b/.test(text);
  const schemaLocalBusiness = /("@type"\s*:\s*"?(LocalBusiness|Dentist|MedicalBusiness|MedicalClinic|Restaurant|Attorney|LegalService|HomeAndConstructionBusiness|Plumber|Electrician|RoofingContractor|GeneralContractor|Contractor|MovingCompany|ProfessionalService|Store|HealthAndBeautyBusiness|BeautySalon|HairSalon|DaySpa|AutoRepair|RealEstateAgent|Physician|Dentistry)"?|itemtype=["'][^"']*schema\.org\/(LocalBusiness|[A-Za-z]*Business))/i.test(html);
  const faqSchema = /("@type"\s*:\s*"?(FAQPage|Question)"?)/i.test(html);
  const sameAs = /"sameAs"\s*:/i.test(html);
  return { text, hasForm, hasBooking, hasNewsletter, hasLiveChat, hasCta, hasPhone, hasEmailLink, napAddress, schemaLocalBusiness, faqSchema, sameAs };
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

async function scanWebsite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const out = {
    url, reachable: false, https: url.startsWith('https'), redirectsToHttps: false, finalUrl: null,
    // content / SEO
    title: null, titleLen: 0, description: null, descriptionLen: 0, h1Count: 0, wordCount: 0,
    mobileViewport: false, favicon: false, ogTitle: false, ogImage: false, schemaLocalBusiness: false, faqSchema: false, sameAs: false, canonical: false,
    // conversion
    hasPhone: false, hasEmailLink: false, hasForm: false, hasBooking: false, hasNewsletter: false,
    hasLiveChat: false, hasCta: false, napAddress: false,
    // tracking / data
    analytics: false, analyticsType: null, fbPixel: false, googleAdsTag: false,
    // media / trust
    imgCount: 0, imgMissingAlt: 0, hasVideo: false, mixedContent: false, copyrightYear: null,
    // social
    socials: {},
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
  out.fbPixel = /connect\.facebook\.net\/[^"']*fbevents|fbq\(\s*['"]init/i.test(html);
  out.googleAdsTag = /AW-\d{6,}|googleadservices\.com\/pagead\/conversion|google_conversion_id/i.test(html);

  // ----- media / trust (homepage) -----
  const imgs = html.match(/<img[^>]*>/gi) || [];
  out.imgCount = imgs.length;
  out.imgMissingAlt = imgs.filter(t => !/alt=["'][^"']+["']/i.test(t)).length;
  out.hasVideo = /(<video[\s>]|youtube\.com\/embed|player\.vimeo\.com|wistia|\.mp4["']|<iframe[^>]+(youtube|vimeo))/i.test(html);
  out.mixedContent = out.https && /(src|href)=["']http:\/\/(?!localhost|127\.)/i.test(html);
  out.copyrightYear = (html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i) || [])[1] || null;

  // ----- merge conversion + trust signals across homepage AND key inner pages -----
  const merge = (h) => {
    const s = pageSignals(h);
    out.hasForm ||= s.hasForm; out.hasBooking ||= s.hasBooking; out.hasNewsletter ||= s.hasNewsletter;
    out.hasLiveChat ||= s.hasLiveChat; out.hasCta ||= s.hasCta; out.hasPhone ||= s.hasPhone;
    out.hasEmailLink ||= s.hasEmailLink; out.napAddress ||= s.napAddress;
    out.schemaLocalBusiness ||= s.schemaLocalBusiness; out.faqSchema ||= s.faqSchema; out.sameAs ||= s.sameAs;
    Object.assign(out.socials, extractSocials(h));
    return s;
  };
  const homeSig = merge(html);
  out.wordCount = homeSig.text ? homeSig.text.split(' ').length : 0;
  out.pagesScanned.push('/');

  if (origin && out.host) {
    // discover up to 4 key internal pages (contact / about / services / booking) on the same host
    const links = [...html.matchAll(/<a[^>]+href=["']([^"'#\s]+)["']/gi)].map(m => m[1]);
    const want = /(contact|about|service|book|appointment|quote|schedule|team|location|review|faq|pricing|gallery|portfolio|menu)/i;
    const seen = new Set([out.finalUrl]);
    const targets = [];
    for (const href of links) {
      if (targets.length >= 8) break;
      let abs; try { abs = new URL(href, out.finalUrl).href.split('#')[0]; } catch { continue; }
      try { if (new URL(abs).host.replace(/^www\./, '') !== out.host) continue; } catch { continue; }
      if (seen.has(abs) || !want.test(abs) || /\.(pdf|jpg|png|zip|mp4)$/i.test(abs)) continue;
      seen.add(abs); targets.push(abs);
    }
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
    const q = encodeURIComponent(`${business} ${city || ''} GA`);
    const find = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${key}`, { signal: AbortSignal.timeout(10000) });
    const fd = await find.json();
    const pid = fd.candidates?.[0]?.place_id;
    if (!pid) return { found: false };
    const fields = 'name,rating,user_ratings_total,opening_hours,website,formatted_phone_number,formatted_address,business_status,types,url,photos,reviews,editorial_summary';
    const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=${fields}&key=${key}`, { signal: AbortSignal.timeout(10000) });
    const dd = await det.json();
    const r = dd.result || {};
    // Verify the match: does the profile's linked website match the site we scanned, or the name align?
    let verified = null, matchHost = null;
    if (r.website) { try { matchHost = new URL(r.website).host.replace(/^www\./, ''); } catch {} }
    if (siteHost && matchHost) verified = matchHost === siteHost;
    else {
      const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (r.name && business) { const a = norm(r.name), b = norm(business); verified = a.includes(b) || b.includes(a); }
    }
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
  // Rendered-DOM fallbacks: if the raw HTML missed it but Lighthouse (real Chrome) saw it, trust Lighthouse.
  const hasTitle = !!scan.title || ps?.renderedTitle === true;
  const hasMetaDesc = !!scan.description || ps?.renderedMetaDesc === true;
  const hasViewport = scan.mobileViewport || ps?.renderedViewport === true;
  const aioGroup = aio ? { group: 'AI Search Presence (AIO)', items: [
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
  const canVerifyTags = !!(ps && ps.rendered);
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
      { label: 'Mobile friendly (responsive viewport)', ok: hasViewport },
      { label: 'Mobile page speed', ok: ps?.performance != null ? ps.performance >= 50 : null, note: ps?.performance != null ? ps.performance + '/100' : 'n/a' },
      { label: 'Largest Contentful Paint under 2.5s', ok: ps?.lcp != null ? ps.lcp <= 2500 : null, note: ps?.lcpLabel || '' },
      { label: 'Layout stable while loading (CLS)', ok: ps?.cls != null ? ps.cls <= 0.1 : null, note: ps?.clsLabel || '' },
      { label: 'No insecure mixed content', ok: !scan.mixedContent },
    ]},
    { group: 'Getting Found (SEO)', items: [
      { label: 'Page title present and sized right', ok: scan.title ? (scan.titleLen >= 15 && scan.titleLen <= 65) : (hasTitle ? true : false), note: scan.title ? scan.titleLen + ' chars' : (hasTitle ? 'present (JS-rendered)' : 'missing') },
      { label: 'Meta description present and sized right', ok: scan.description ? (scan.descriptionLen >= 70 && scan.descriptionLen <= 165) : (hasMetaDesc ? true : false), note: scan.description ? scan.descriptionLen + ' chars' : (hasMetaDesc ? 'present (JS-rendered)' : 'missing') },
      { label: 'Single clear H1 headline', ok: scan.h1Count === 1, note: scan.h1Count + ' found' },
      { label: 'Local business schema markup', ok: scan.schemaLocalBusiness },
      { label: 'Canonical tag set', ok: scan.canonical },
      { label: 'Enough content on the page', ok: scan.wordCount >= 300, note: scan.wordCount + ' words' },
    ]},
    ...(gbpGroup ? [gbpGroup] : []),
    ...(aioGroup ? [aioGroup] : []),
    { group: 'Turning Visitors Into Leads', items: [
      { label: 'Click to call phone number', ok: scan.hasPhone },
      { label: 'Lead capture form', ok: scan.hasForm },
      { label: 'Online booking / scheduling', ok: scan.hasBooking },
      { label: 'Clear call to action', ok: scan.hasCta },
      { label: 'Live chat', ok: tagOk(scan.hasLiveChat), note: tagNote(scan.hasLiveChat) },
      { label: 'Email / newsletter capture', ok: scan.hasNewsletter },
      { label: 'Address listed (local trust)', ok: scan.napAddress },
    ]},
    { group: 'Tracking & Ad Readiness', items: [
      { label: 'Website analytics installed', ok: tagOk(scan.analytics), note: scan.analytics ? (scan.analyticsType || '') : tagNote(scan.analytics) },
      { label: 'Facebook / Meta pixel (retargeting)', ok: tagOk(scan.fbPixel), note: tagNote(scan.fbPixel) },
      { label: 'Google Ads conversion tag', ok: tagOk(scan.googleAdsTag), note: tagNote(scan.googleAdsTag) },
    ]},
    { group: 'Content, Media & Social', items: [
      { label: 'Video on site', ok: scan.hasVideo },
      { label: 'Images have alt text', ok: scan.imgCount ? scan.imgMissingAlt === 0 : null, note: scan.imgCount ? (scan.imgCount - scan.imgMissingAlt) + '/' + scan.imgCount : 'none' },
      { label: 'Social share preview (Open Graph)', ok: scan.ogTitle && scan.ogImage },
      { label: 'Facebook linked', ok: socials.includes('facebook') },
      { label: 'Instagram linked', ok: socials.includes('instagram') },
      { label: 'YouTube linked', ok: socials.includes('youtube') },
      { label: 'TikTok linked', ok: socials.includes('tiktok') },
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
SITE SIGNALS: ${JSON.stringify({ reachable: scan.reachable, https: scan.https, mobileViewport: scan.mobileViewport, title: scan.title, titleLen: scan.titleLen, metaDescription: scan.description ? 'present (' + scan.descriptionLen + ' chars)' : 'MISSING', h1Count: scan.h1Count, wordCount: scan.wordCount, schemaLocalBusiness: scan.schemaLocalBusiness, canonical: scan.canonical, hasPhone: scan.hasPhone, hasForm: scan.hasForm, hasBooking: scan.hasBooking, hasCta: scan.hasCta, hasLiveChat: scan.hasLiveChat, hasNewsletter: scan.hasNewsletter, napAddress: scan.napAddress, analytics: scan.analyticsType || false, facebookPixel: scan.fbPixel, googleAdsTag: scan.googleAdsTag, hasVideo: scan.hasVideo, images: scan.imgCount, imagesMissingAlt: scan.imgMissingAlt, ogShareTags: scan.ogTitle && scan.ogImage, mixedContent: scan.mixedContent })}
GOOGLE BUSINESS PROFILE (live from Google Places): ${gbp && gbp.found ? JSON.stringify({ rating: gbp.rating, reviews: gbp.reviews, latestReviewDaysAgo: gbp.latestReviewDays, hoursListed: gbp.hasHours, websiteLinked: gbp.websiteOnGbp, phoneListed: gbp.phoneOnGbp, photos: gbp.photos, descriptionFilled: gbp.hasDescription, primaryCategory: gbp.primaryCategory, status: gbp.status }) : (gbp && gbp.found === false ? 'NO GOOGLE BUSINESS PROFILE FOUND (major local visibility gap)' : 'not checked')}
SOCIAL PROFILES LINKED FROM SITE: ${Object.keys(scan.socials).length ? Object.keys(scan.socials).join(', ') : 'NONE detected'}
PAGES ACTUALLY SCANNED (not just homepage): ${(scan.pagesScanned || ['/']).join(', ')}  (conversion, contact, and trust signals were merged across all of these pages, so if a signal is FAIL it is genuinely missing site-wide, not just off the homepage)
AI SEARCH PRESENCE (AIO): ${aio ? JSON.stringify({ score: aio.score, aiCrawlersAllowed: aio.ready.aiCrawlersAllowed, aiCrawlersBlocked: aio.ready.aiCrawlersBlocked, structuredData: aio.ready.schema, faqSchema: aio.ready.faqSchema, entityLinks_sameAs: aio.ready.sameAs, llmsTxt: aio.ready.llmsTxt, contentDepthOk: aio.ready.contentDepth, aiKnowsThisBusiness: aio.visibility ? aio.visibility.known : 'not tested', aiWouldRecommend: aio.visibility ? aio.visibility.wouldRecommend : 'not tested', whatAiKnows: aio.visibility ? aio.visibility.whatAiKnows : null, aiKnowsCompetitors: aio.visibility ? aio.visibility.competitorsKnown : null }) : 'not checked'}

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
 "estimate": "one line on the realistic leads/revenue upside of closing these gaps"
}
Give 5 to 7 findings ordered by biggest revenue impact. No em dashes. No hype words like leverage, unlock, synergy, supercharge. Specific to THIS scan, never generic.`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  let txt = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
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
    const est = report.estimate || '';
    const uh = doc.font('Helvetica').fontSize(11.5).heightOfString('The upside: ' + est, { width: CW - 40 }) + 26;
    doc.roundedRect(M, y, CW, uh, 10).fill(NAVY2);
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(11.5).text('The upside: ', M + 20, y + 13, { continued: true, width: CW - 40 }).fillColor('#fff').font('Helvetica').text(est, { width: CW - 40 });
    y += uh + 20;
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
      { stat: '+38%', label: 'more booked leads in 90 days (home services client)' },
      { stat: '3.1x', label: 'return on ad + content spend (local clinic)' },
      { stat: '+52', label: 'new monthly inbound calls (service business)' },
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
function renderPrescannedReport(p) {
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
    ${rep.estimate ? `<div class="est reveal"><b>The upside: </b>${esc(rep.estimate)}</div>` : ''}
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
<title>${prescanned ? esc(bizName || 'Your') + ' growth audit · Open Heart Media' : 'Free growth audit · Open Heart Media'}</title>
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
.case{border-top:1px solid var(--line);position:relative;overflow:hidden}
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
@media(max-width:720px){.sec{padding:64px 22px}.hero{padding:80px 22px 64px}.scoregrid,.cstory{grid-template-columns:1fr}.cmetrics{grid-template-columns:1fr 1fr}.chero{gap:12px}.formwrap{padding:24px}.book h2{font-size:clamp(20px,5.7vw,30px);max-width:none;white-space:nowrap}.book p{font-size:15.5px;max-width:40ch}.book .inner{padding:0}.calwrap{min-width:0}.calwrap .calendly-inline-widget{min-width:0 !important}}
@media(max-width:360px){.book h2{white-space:normal;font-size:22px}.frow{flex-direction:column;gap:0}}
</style></head><body>
<div class="nav"><img class="logo" src="/media/logo-white.png" alt="Open Heart Media"/><a class="navcta" href="#book">Book a call</a></div>

${prescanned ? renderPrescannedReport(prospect) : `<section class="hero">
  <div class="inner">
    <div class="eyebrow reveal">${bizName ? 'Free growth audit for ' + esc(bizName) : 'Free growth audit'}</div>
    <h1 class="reveal">You're a great business. You're just <em>leaving money</em> on the table.</h1>
    <p class="sub reveal">We go through your website, your Google presence and whether AI assistants can even find you, then send you the exact gaps quietly costing you leads and revenue. Free, and no call required to get it.</p>

    <div class="formwrap reveal" id="auditbox">
      <h2>Get your free growth audit</h2>
      <p class="fp">We build it by hand and send it to your inbox. No call required.</p>
      <div class="frow">
        <div><label for="f_first">First name</label><input id="f_first" placeholder="Jane"/></div>
        <div><label for="f_last">Last name</label><input id="f_last" placeholder="Doe"/></div>
      </div>
      <label for="f_site">Your website</label>
      <input id="f_site" placeholder="yourbusiness.com" value="${esc(prefillSite)}"/>
      <label for="f_goal">What matters most right now</label>
      <select id="f_goal"><option value="more leads">More leads</option><option value="more phone calls">More phone calls</option><option value="more booked appointments">More booked appointments</option><option value="more sales">More sales</option><option value="more of everything">More of everything</option></select>
      <label for="f_email">Where should we send your audit</label>
      <input id="f_email" type="email" placeholder="you@yourbusiness.com"/>
      <button class="btn" id="run">Send me my audit</button>
      <p class="err" id="err"></p>
    </div>
  </div>
</section>

<section class="sec results hide" id="result"></section>`}

<section class="case" id="proof">
  <div class="inner">
    <div class="eyebrow reveal">Proof, not promises</div>
    <h2 class="reveal secheading">We don't pitch you on what we could do. Here is what we already did.</h2>
    <p class="reveal secsub">Three real clients, real numbers, pulled straight from their accounts.</p>
    <div class="chero reveal"><span class="bignum">$2.34M</span><span class="cl">Home services · 20 months</span></div>
    <div class="ctitle reveal">From zero online presence to $2.34M in tracked revenue, on $26K of ad spend.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>A great local reputation but nothing digital working for them. No paid ads, no lead tracking, no reliable pipeline. Revenue moved with the season, not a system.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>Built a growth system, not a campaign. Google Search plus Performance Max on high intent buyers, every call and text tracked to the dollar, and monthly optimization.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>Twenty months of compounding growth. Average monthly revenue climbed from $68K to over $111K, with April 2026 the best month on record at $157,970.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">~90x</b><span>Return on ad spend</span></div><div class="m"><b>$0.39</b><span>Avg cost per click</span></div><div class="m"><b>2.91M</b><span>Impressions</span></div><div class="m"><b>67,100</b><span>Clicks, all traced to revenue</span></div></div>
  </div>
</section>

<section class="case cream">
  <div class="inner">
    <div class="chero reveal"><span class="bignum">$312.5K</span><span class="cl">E-commerce · first 30 days</span></div>
    <div class="ctitle reveal">Their best sales month in 23 months, without spending more on traffic.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>Strong product, loyal customers, but growth was decelerating three months straight, from +95% to +35% to +16%. Too many hands on strategy at once.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>One owner, one strategy, every channel aligned. Google, Meta, Amazon, organic social and email all reinforcing the same offer and audience insight.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>Growth reaccelerated inside 30 days. Traffic stayed roughly flat, but every visitor was simply worth more. Best sales month in nearly two years.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">+62%</b><span>Month over month growth</span></div><div class="m"><b>$401</b><span>Avg order value, 2-year high</span></div><div class="m"><b>$5.81</b><span>Revenue per session, best on record</span></div></div>
  </div>
</section>

<section class="case">
  <div class="inner">
    <div class="chero reveal"><span class="bignum">+96%</span><span class="cl">Home healthcare · 6 months</span></div>
    <div class="ctitle reveal">Six months of 2026 already beat their entire prior year online.</div>
    <div class="cstory">
      <div class="blk reveal"><h4>The challenge</h4><p>The prior year ran on social reach alone. Google was barely tested, phone calls were not tracked, and there was no way to tie spend to a real lead.</p></div>
      <div class="blk reveal"><h4>What we did</h4><p>One fully tracked channel. Consolidated budget into Performance Max, made the phone call the primary action, and tracked every call, form and contact-page visit.</p></div>
      <div class="blk reveal"><h4>The result</h4><p>$203,450 in internet and social sales through June, versus $196,052 for all of the prior year. Monthly pace more than doubled, now traceable to the dollar.</p></div>
    </div>
    <div class="cmetrics reveal"><div class="m"><b style="color:var(--red)">15%</b><span>Conversion rate, ~3x benchmark</span></div><div class="m"><b>229</b><span>Tracked conversions in one quarter</span></div><div class="m"><b>$1.74</b><span>Avg cost per click</span></div></div>
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
    var first=document.getElementById('f_first').value.trim();
    var last=document.getElementById('f_last').value.trim();
    var email=document.getElementById('f_email').value.trim();
    var sitev=document.getElementById('f_site').value.trim();
    var goal=document.getElementById('f_goal').value;
    var err=document.getElementById('err');
    var fields=[['f_first',first],['f_last',last],['f_site',sitev],['f_email',email]];
    fields.forEach(function(f){document.getElementById(f[0]).classList.remove('invalid');});
    var missing=fields.filter(function(f){return !f[1];});
    if(missing.length){ missing.forEach(function(f){document.getElementById(f[0]).classList.add('invalid');}); err.textContent='Please fill in all fields.'; return; }
    if(email.indexOf('@')<1){ document.getElementById('f_email').classList.add('invalid'); err.textContent='Please enter a valid email.'; return; }
    err.textContent=''; var btn=this; btn.disabled=true; btn.textContent='Sending...';
    function fail(msg){ err.textContent=msg||'Something went wrong. Please try again.'; btn.disabled=false; btn.textContent='Send me my audit'; }
    // The audit is built after this request returns, not while the visitor waits. Watching a
    // progress bar for two minutes was the single biggest thing that could go wrong in front of a
    // prospect: every dependency we do not control was on screen with them. Now the only thing
    // that has to succeed here is saving their details, and the report follows by email.
    fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:REF,firstName:first,lastName:last,email:email,website:sitev,goal:goal})})
     .then(function(r){return r.json();})
     .then(function(j){
       if(j.error) return fail(j.error);
       // The one moment we know a real lead exists. Everything upstream is just traffic.
       try{ if(window.fbq) fbq('track','Lead',{content_name:'growth audit'}); }catch(e){}
       try{ if(window.gtag) gtag('event','generate_lead',{currency:'USD',value:1}); }catch(e){}
       confirmed(first,email);
     })
     .catch(function(){ fail(); });

    function confirmed(name,to){
      var box=document.getElementById('auditbox');
      box.innerHTML='<h2>Your audit is on its way</h2>'
        +'<p class="fp" style="font-size:15px;line-height:1.6">Thanks '+esc(name)+'. We are putting your report together now and sending it to <b>'+esc(to)+'</b>. It usually lands within the hour.</p>'
        +'<p class="fp" style="font-size:15px;line-height:1.6;margin-top:14px">It covers your website, how you show up on Google, and whether AI assistants can find you at all. Most owners are surprised by that last one.</p>'
        +'<a class="btn" id="rbook" href="#book" style="margin-top:18px;text-decoration:none;display:block;text-align:center">Book my free discovery call</a>'
        +'<p class="fp" style="margin-top:12px;text-align:center">Or skip ahead and we will walk you through it live.</p>';
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
  return prospects.filter(p => p.status === 'sent' && (p.sent_at || '').slice(0, 10) === today).length;
}

// ---------- CAN-SPAM compliance ----------
// Every commercial message we originate must carry a working opt-out and a physical postal
// address. The model was asked to include these in the drafted copy and did so unreliably, so
// they are appended in code instead: the copy path can never drop them.
const COMPANY = process.env.COMPANY_NAME || 'Open Heart Media';
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
async function sendMail(p, subject, body, { kind = 'outreach' } = {}) {
  if (p.unsubscribed_at) throw Object.assign(new Error('lead has unsubscribed'), { suppressed: true });
  if (!p.email || !p.email.includes('@')) throw Object.assign(new Error('no valid email'), { permanent: true });
  const [r] = await sgMail.send({
    to: p.email,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject,
    text: body + complianceFooter(p),
    trackingSettings: { subscriptionTracking: { enable: false } },
    customArgs: { prospect_id: String(p.id), kind },
  });
  return r;
}


// ---------- API ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Universal team login (one shared password, cookie session) ----------
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'ohm-default-secret';
const AUTH_TOKEN = crypto.createHmac('sha256', AUTH_SECRET).update('ohm-team-access-v1').digest('hex');
// Prospect-facing routes + login stay open; everything else needs the cookie (when APP_PASSWORD set).
// Prospect-facing routes stay open: the landing page, its live-scan audit submit, tracking
// beacon, and the Calendly webhook. Everything else needs the team login cookie.
// '/unsubscribe' MUST stay here: CAN-SPAM requires the opt-out to work without the recipient
// creating an account or logging in to anything.
const PUBLIC_PATHS = ['/go', '/r', '/report', '/unsubscribe', '/healthz', '/robots.txt', '/api/audit', '/api/track', '/api/calendly-webhook', '/login', '/api/login', '/api/logout'];
function getCookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m ? m[1] : null; }
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();                                   // no lock if unset (local dev)
  if (req.path.startsWith('/media/')) return next();                 // assets used by public /go page
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (getCookie(req, 'ohm_auth') === AUTH_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
});

function renderLogin(err) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Open Heart Media — Sign in</title><style>
:root{--ink:#0f1a30;--navy:#1a2b4c;--red:#df3131;--blue:#5e97ff}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:var(--ink);display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{width:360px;background:#fff;border:1px solid #e4e9f2;border-radius:18px;padding:40px 36px 34px;text-align:center;box-shadow:0 12px 40px rgba(26,43,76,.10)}
.card::before{content:"";display:block;height:3px;width:46px;background:var(--red);border-radius:3px;margin:0 auto 26px}
.logo{height:40px;margin-bottom:24px}
h1{font-size:19px;font-weight:700;margin:0 0 6px;color:var(--ink)}
p.sub{color:#68758c;font-size:13px;margin:0 0 24px}
input{width:100%;padding:13px 14px;border:1px solid #d3dbe8;border-radius:11px;background:#fbfcfe;color:var(--ink);font:inherit;margin-bottom:12px}
input:focus{outline:none;border-color:var(--blue);background:#fff}
button{width:100%;padding:14px;border:0;border-radius:11px;background:var(--red);color:#fff;font-weight:700;font-size:15px;cursor:pointer}
button:hover{background:#c92626}
.err{color:var(--red);font-size:13px;margin-top:12px;min-height:16px}
.foot{margin-top:22px;color:#9aa7bd;font-size:11px;letter-spacing:.3px}
</style></head><body>
<div class="card">
  <img class="logo" src="/media/logo-navy.png" alt="Open Heart Media"/>
  <h1>Team sign in</h1><p class="sub">Enter the shared team password to access the CRM.</p>
  <form method="POST" action="/api/login">
    <input type="password" name="password" placeholder="Team password" autofocus/>
    <button type="submit">Sign in</button>
  </form>
  <div class="err">${err ? 'Wrong password. Try again.' : ''}</div>
  <div class="foot">OPEN HEART MEDIA · OUTREACH CRM</div>
</div></body></html>`;
}
app.get('/login', (_, res) => res.send(renderLogin(false)));
app.post('/api/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (APP_PASSWORD && password === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `ohm_auth=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`);
    return res.redirect('/');
  }
  res.status(401).send(renderLogin(true));
});
app.post('/api/logout', (_, res) => { res.setHeader('Set-Cookie', 'ohm_auth=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });

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
  res.json({ prospects: slim, counts, sentToday: sentToday(), dailyCap: DAILY_CAP, team: TEAM, wonValue, openValue });
});

// Team members who can be "on" a response. Configurable via TEAM env (comma list).
const TEAM = (process.env.TEAM || 'Zac,Michelle,Brad,Griffin').split(',').map(s => s.trim()).filter(Boolean);

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
  for (const k of ['email', 'subject', 'body', 'status', 'handled_by']) {
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

app.post('/api/prospects/:id/generate', async (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const d = await draftEmail(p);
    p.subject = d.subject; p.body = d.body;
    if (p.status === 'new') p.status = 'drafted';
    p.updated_at = new Date().toISOString();
    save(prospects);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-all', async (req, res) => {
  const limit = Number(req.body?.limit) || 25;
  const todo = prospects.filter(p => p.status === 'new' || (!p.body && p.status !== 'sent')).slice(0, limit);
  let done = 0;
  for (const p of todo) {
    try {
      const d = await draftEmail(p);
      p.subject = d.subject; p.body = d.body;
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
  res.send(renderLandingPage(p.id, reportToken(p.id)));
});

app.get('/go', (req, res) => {
  res.send(renderLandingPage(req.query.ref, req.query.t));
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
    estimate: 'Closing these gaps could realistically recover 8 to 15 additional booked appointments a month at your review volume.',
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
const NOTIFY = (process.env.NOTIFY_EMAILS || NOTIFY_FALLBACK)
  .split(',').map(s => s.trim()).filter(Boolean);
if (!process.env.NOTIFY_EMAILS) {
  console.warn(`[notify] NOTIFY_EMAILS is not set, falling back to ${NOTIFY_FALLBACK}. Set it to a comma separated list so the whole team is told about bookings and failures.`);
}
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
      to: NOTIFY,
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
  const msg = { to: NOTIFY, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject: `🔥 Audit completed${p?.business ? ' — ' + p.business : ''}`, text };
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

function prescanTargets({ force = false } = {}) {
  return prospects.filter(p =>
    p.website && /^https?:\/\//i.test(p.website) &&
    (force || (!p.prescan_at && !p.prescan_failed_at)));
}

async function runPrescan({ limit = 0, force = false } = {}) {
  if (prescanState.running) return prescanState;
  let queue = prescanTargets({ force });
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
  const scoreOf = names => {
    const items = checklist.filter(g => names.includes(g.group)).flatMap(g => g.items).filter(i => i.ok !== null && i.ok !== undefined);
    if (!items.length) return 50;
    return Math.round((items.filter(i => i.ok === true).length / items.length) * 100);
  };
  const perf = ps && typeof ps.performance === 'number' ? ps.performance : null;
  const categories = [
    // Without a speed measurement the only Foundation items left are HTTPS, viewport and mixed
    // content, and a site passing those three scored a confident 100 for "Website & Speed" while
    // its speed was entirely unknown. Flagged as unmeasured instead, and left out of the overall.
    { name: 'Website & Speed', score: perf !== null ? perf : scoreOf(['Foundation & Speed']),
      measured: perf !== null,
      why: perf !== null ? 'Scored from the live technical scan of the site.'
        : 'Page speed could not be measured on this run, so this covers only the secure connection and mobile checks. Speed is not included in the overall score.' },
    { name: 'Getting Found (SEO)', score: scoreOf(['Getting Found (SEO)']), why: 'Scored from on page SEO signals found during the crawl.' },
    { name: 'Converting Visitors', score: scoreOf(['Turning Visitors Into Leads']), why: 'Scored from the contact, form, booking and call to action signals found across the pages scanned.' },
    { name: 'Local Visibility', score: scoreOf(['Google Business Profile']), why: 'Scored from the live Google Business Profile lookup.' },
    { name: 'Tracking & Data', score: scoreOf(['Tracking & Ad Readiness']), why: 'Scored from the analytics and advertising tags detected on the site.' },
    { name: 'Social & Content', score: scoreOf(['Content, Media & Social']), why: 'Scored from the social profiles linked from the site and the media found on it.' },
    { name: 'AI Search Presence (AIO)', score: aio && typeof aio.score === 'number' ? aio.score : scoreOf(['AI Search Presence (AIO)']), why: 'Scored from AI crawler access, structured data and a live check of whether AI assistants recognize this business.' },
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
    if (!scan.reachable && !scan.title) throw new Error(`could not reach ${site}`);

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
        p.audit_scan = { pagespeed: ps, gbp, aio, socials: scan.socials, reachable: scan.reachable, pagesScanned: scan.pagesScanned };
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
      if (p) {
        p.audit_email = email; p.audit_goal = goal || null; p.audit_report = report;
        p.contact_first = firstName; p.contact_last = lastName; p.contact_name = `${firstName} ${lastName}`.trim();
        p.audit_scan = { pagespeed: ps, gbp, aio, socials: scan.socials, reachable: scan.reachable, pagesScanned: scan.pagesScanned };
        p.status = 'audited'; p.audited_at = new Date().toISOString(); p.updated_at = p.audited_at;
        try { save(prospects); } catch (e) { console.error('[audit] save failed -', e.message); }
      }
      events.push({ type: 'audit', ref: ref || null, ts: new Date().toISOString(), email, business: p?.business || null });
      try { saveMetrics(); } catch {}
      await softStage(notifyAudit(p, email, report, pdf), 30000, 'team notification');
      if (pdf) await softStage(sendAuditToProspect(email, p?.business || resolvedBiz, report, pdf, bookingUrl), 30000, 'prospect email');
      job.result = { report, business: p?.business || null };
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
  if (!firstName || !lastName) return res.status(400).json({ error: 'first and last name required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  if (!website || !website.trim()) return res.status(400).json({ error: 'website required' });
  const isTest = test === true || test === 'true';
  const p = !isTest && ref && prospects.find(x => x.id === ref);
  const lookup = isTest && ref && prospects.find(x => x.id === ref); // for test GBP/name only, no writes
  const site = website || (p && p.website) || (lookup && lookup.website) || '';
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
      if (!['audited', 'booked', 'won', 'replied'].includes(leadRow.status)) leadRow.status = 'audit_requested';
      leadRow.audit_requested_at = nowIso; leadRow.updated_at = nowIso;
    } else {
      // Organic visitor with no ref: create a new lead so they are not lost.
      leadRow = {
        id: 'W' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
        business: '', category: '', city: '', phone: '', website: site,
        rating: '', reviews: '', email, subject: '', body: '', notes: '',
        handled_by: '', deal_value: '',
        contact_first: firstName, contact_last: lastName, contact_name: `${firstName} ${lastName}`.trim(),
        audit_email: email, audit_goal: goal || null,
        status: 'audit_requested', source: 'self_serve', audit_requested_at: nowIso, updated_at: nowIso,
      };
      prospects.push(leadRow);
    }
    try { save(prospects); } catch (e) { console.error('[audit] lead capture save failed -', e.message); }
  }

  const jobId = crypto.randomBytes(12).toString('hex');
  enqueueAudit(jobId, { ref, email, goal, firstName, lastName, isTest, site, p: leadRow && !isTest ? leadRow : p, lookup, bizName: bizName || (leadRow && leadRow.business) || null, bizCity, bizCategory });
  res.status(202).json({ jobId, state: 'queued' });
});

// Metrics aggregate for the dashboard
app.get('/api/metrics', (_, res) => {
  const views = events.filter(e => e.type === 'view');
  const clicks = events.filter(e => e.type === 'click');
  const uniqRefsViewed = new Set(views.map(e => e.ref).filter(Boolean));
  const nameOf = id => (prospects.find(p => p.id === id)?.business) || id || '(untagged)';
  const perRef = {};
  for (const e of events) {
    const k = e.ref || '(untagged)';
    perRef[k] = perRef[k] || { business: nameOf(e.ref), views: 0, clicks: 0 };
    perRef[k][e.type === 'click' ? 'clicks' : 'views']++;
  }
  const booked = events.filter(e => e.type === 'booked');
  const sent = prospects.filter(p => ['sent', 'clicked', 'replied', 'booked'].includes(p.status)).length;
  res.json({
    totals: {
      sent,
      views: views.length,
      uniqueVisitors: uniqRefsViewed.size,
      clicks: clicks.length,
      booked: booked.length,
      clickRate: sent ? Math.round((uniqRefsViewed.size / sent) * 100) : 0,
      bookRate: views.length ? Math.round((clicks.length / views.length) * 100) : 0,
    },
    perRef: Object.entries(perRef).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.clicks - a.clicks || b.views - a.views),
  });
});

app.post('/api/prospects/:id/send', async (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!p.email || !p.email.includes('@')) return res.status(400).json({ error: 'no valid email' });
  if (p.status !== 'approved') return res.status(400).json({ error: 'must be approved first' });
  try {
    const [r] = await sgMail.send({
      to: p.email,
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: p.subject,
      text: p.body,
    });
    p.status = 'sent'; p.sent_at = new Date().toISOString(); p.updated_at = p.sent_at;
    p.provider_id = r.headers['x-message-id'] || null;
    save(prospects);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.response?.body?.errors?.[0]?.message || e.message }); }
});

app.post('/api/send-approved', async (req, res) => {
  let budget = DAILY_CAP - sentToday();
  if (budget <= 0) return res.json({ sent: 0, reason: 'daily cap reached' });
  const queue = prospects.filter(p =>
    p.status === 'approved' && !p.unsubscribed_at && p.email && p.email.includes('@'));
  let sent = 0; const errors = []; let parked = 0;
  for (const p of queue) {
    if (budget <= 0) break;
    try {
      const r = await sendMail(p, p.subject, p.body, { kind: 'cold' });
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
  res.json({ sent, parked, remainingBudget: budget, errors });
});

// ---------- 3 / 7 / 10 day follow-up sequence ----------
async function draftFollowup(p, step) {
  const link = reportUrl(p);
  // A pre-scanned lead has a report but no audited_at: we built it, they did not request it.
  // What matters for the copy is whether they have SEEN it, which viewed_at records when they
  // land on the report page. Branching on audited_at here asked people who had already read
  // their scores whether they had got round to running one.
  const hasReport = !!p.audit_report;
  const seenIt = !!(p.viewed_at || p.clicked_at || p.audited_at || p.status === 'audited');
  const audited = hasReport && seenIt;
  let angles, context = '', length = '2 to 3', linkPurpose = 'the free audit link';
  if (audited) {
    // They ALREADY ran the audit but have not booked. Reference their real results + add education / free value.
    const rep = p.audit_report || {};
    const topFinding = (rep.findings || [])[0];
    const weakest = (rep.categories || []).slice().sort((a, b) => (a.score || 0) - (b.score || 0))[0];
    const aio = p.audit_scan?.aio;
    const aiUnknown = !!(aio && aio.visibility && aio.visibility.known === false);
    context = `IMPORTANT: they have ALREADY run their free audit, so do NOT ask if they ran it. Reference what it showed.`
      + (topFinding ? ` The biggest gap their audit flagged was "${topFinding.title}": ${topFinding.detail || ''}` : '')
      + (weakest ? ` Their weakest scored area was ${weakest.name} at ${weakest.score} out of 100.` : '')
      + (aiUnknown ? ` Their audit tested whether a leading AI model recognises ${p.business} as a ${p.category} in ${p.city}, and it does not. Say "AI assistants" or "AI models" generally. Do NOT claim we queried ChatGPT, Perplexity or Google AI Overviews specifically, and do NOT call it a live search: we tested what the model knows, which is not the same thing. Buyers increasingly ask AI assistants for local recommendations, and a business the model has never heard of is invisible in that channel.` : '');
    length = '3 to 4 SHORT sentences, tight and skimmable, no long paragraphs or run-on sentences';
    linkPurpose = 'the discovery call link (they can also revisit their audit there)';
    angles = {
      1: 'Lead with the single most painful finding from their audit, stated plainly as lost customers or revenue (not jargon). Then give ONE concrete free fix in one sentence. End with a one-line invite to a short call to fix the rest.',
      2: aiUnknown
        ? `Lead with the AI-search shift: more buyers now ask AI assistants for a ${p.category}, and their audit found that AI models do not recognise ${p.business} yet, so they are invisible in that channel. Say "AI assistants" generally, never name ChatGPT or Perplexity as something we queried, and never call it a live search. One line on what that costs them. One sharp one-line CTA to a short call.`
        : 'One-line proof point (about 90x return on ad spend, $2.34M in tracked revenue, for a local home services business), tie it to their biggest gap in one line, then one sharp one-line CTA to a short call.',
      3: 'Very short. Restate their biggest pain in one line, leave one final quick tip, and a warm door-open close.',
    };
  } else {
    // They have not run the audit yet: nudge them to it.
    angles = {
      1: 'Circle back gently, one or two short lines. Ask if they got a chance to run their free audit. Warm, low pressure.',
      2: 'Open with one quick proof point (we recently drove about 90x return on ad spend, $2.34M in tracked revenue, for a local home services business). Then invite them to grab their free audit.',
      3: 'Last friendly touch, one or two lines. Say you will leave it here, and the free audit is open anytime if they want it.',
    };
  }
  const prompt = `Write a short follow-up email (${length}) from Michelle at Open Heart Media to ${p.business}, a ${p.category} in ${p.city} GA. This is follow-up ${step} of 3. ${context} ${angles[step]} Write like a sharp direct-response copywriter: lead with the pain, short punchy sentences, every line earns its place, skimmable, no filler, no long run-ons. Reference their business naturally. Any tip must be specific and genuinely useful free value, never generic. Put the exact token [LINK] on its own line for ${linkPurpose}. Sign "Michelle, Open Heart Media". No em dashes, no exclamation marks, no hype words. Lowercase subject under 45 chars. Return ONLY JSON {"subject":"...","body":"..."}`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  let t = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  const o = JSON.parse(t);
  // Enforce the no-em-dash rule on both subject and body.
  const deDash = s => typeof s === 'string' ? s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+--\s+/g, ', ').replace(/--/g, ', ') : s;
  o.subject = deDash(o.subject); o.body = deDash(o.body);
  if (o.body) o.body = o.body.includes('[LINK]') ? o.body.replace('[LINK]', link) : o.body + '\n\n' + link;
  return o;
}
const FOLLOWUP_DAYS = { 1: 3, 2: 7, 3: 10 };
// Minimum spacing between two touches to the same lead, whatever the step maths says. Without it
// a lead whose first email went out late can receive steps back to back on the same day.
const MIN_FOLLOWUP_GAP_DAYS = 2;

async function runFollowups() {
  const now = Date.now(); let sent = 0, parked = 0;
  // Follow-ups draw on the same daily budget as cold sends: they land in the same inboxes from the
  // same domain, and reputation does not care which queue a message came from.
  let budget = DAILY_CAP - sentToday() - followupsSentToday();
  for (const p of prospects) {
    if (budget <= 0) break;
    if (!p.sent_at || !p.email || !p.email.includes('@')) continue;
    if (p.unsubscribed_at) continue;
    if (['booked', 'replied', 'rejected', 'won', 'lost', 'unreachable'].includes(p.status)) continue;
    const step = (p.followup_step || 0) + 1;
    if (step > 3) continue;
    const days = (now - new Date(p.sent_at).getTime()) / 86400000;
    if (days < FOLLOWUP_DAYS[step]) continue;
    if (p.last_followup_at && (now - new Date(p.last_followup_at).getTime()) / 86400000 < MIN_FOLLOWUP_GAP_DAYS) continue;
    try {
      const msg = await draftFollowup(p, step);
      await sendMail(p, msg.subject, msg.body, { kind: 'followup' + step });
      p.followup_step = step; p.last_followup_at = new Date().toISOString(); p.updated_at = p.last_followup_at;
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
  const pending = prescanTargets({ force }).length;
  runPrescan({ limit, force }).catch(e => console.error('[prescan] run failed -', e.message));
  res.json({ started: true, queued: limit > 0 ? Math.min(limit, pending) : pending });
});
app.post('/api/prescan/stop', (_, res) => { prescanState.stop = true; res.json({ stopping: true }); });
app.get('/api/prescan/status', (_, res) => {
  const withReport = prospects.filter(p => p.prescan_at && p.audit_report).length;
  const failed = prospects.filter(p => p.prescan_failed_at && !p.prescan_at).length;
  res.json({
    ...prescanState,
    remaining: prescanTargets().length,
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
  if (Date.now() - lastFollowupRun() < 20 * 60 * 60 * 1000) return;   // already ran within the day
  stampFollowupRun();
  console.log('[followups] running,', reason);
  try { await runFollowups(); } catch (e) { console.error('[followups] run failed -', e.message); }
}
setInterval(() => followupTick('interval'), 60 * 60 * 1000);
setTimeout(() => followupTick('boot catch-up'), 90 * 1000);

app.post('/api/reseed', (_, res) => { prospects = seedFromCsv(); res.json({ count: prospects.length }); });

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
