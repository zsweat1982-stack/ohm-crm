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
async function draftEmail(p) {
  const prompt = `You are an elite cold-email copywriter for Open Heart Media (OHM), owned by Zac. OHM helps local businesses GET MORE LEADS AND GROW REVENUE. That is what you sell: the outcome (more customers, more booked jobs, more revenue), NOT the mechanism. Video, content, and websites are just how OHM gets there, so mention them only lightly if at all. Lead with the money.

Write ONE short cold email to this local business to get a reply saying yes to a free personalized growth audit (where Zac shows exactly where they are losing leads and revenue, and how to capture more). The audit leads to a discovery call.

BUSINESS:
- Name: ${p.business}
- Type: ${p.category}
- City: ${p.city}, GA
- Google rating: ${p.rating || 'n/a'} from ${p.reviews || 'n/a'} reviews
- Website: ${p.website || 'n/a'}

RULES (follow exactly):
- Under 100 words. Sound like a real local person, not marketing. Use contractions.
- Line 1 body: a SPECIFIC, genuine positive observation about THEM (reference their real rating/reviews or their standing as a ${p.category} in ${p.city}). Must feel impossible to have sent to anyone else.
- Then the OUTCOME-based gap: a business this good is almost certainly leaving leads and revenue on the table, because the people searching for a ${p.category} in ${p.city} are not all finding them or booking. Frame it as money and customers they are missing, not a feature they lack. Do not lecture about video or social.
- Then point them to a short breakdown you put together showing where those lost leads and dollars are. One quick line, then put the exact token [LINK] on its own line where the link will go.
- After the link, one soft line like "worth a look?" Then sign.
- Sign: Zac, Open Heart Media
- NO em dashes. No dashes as punctuation. No exclamation marks. No "hope this finds you well". No buzzwords like "leverage", "synergy", "unlock", "scale".

Also write a lowercase, personal, outcome-flavored subject line under 45 chars (hint at more customers/leads/revenue, no hype, no exclamation). Examples of the vibe: "more patients in ${p.city}", "leads you're probably missing", "quick idea to grow ${p.business}".

Return ONLY JSON: {"subject": "...", "body": "..."}`;

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  let txt = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Be robust: pull the first {...} block if Claude adds any preamble.
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) txt = m[0];
  const out = JSON.parse(txt);
  // Inject the tracked one-page link (ref = this prospect, so clicks attribute back).
  const link = `${LANDING_URL}?ref=${p.id}`;
  if (out.body && out.body.includes('[LINK]')) out.body = out.body.replace('[LINK]', link);
  else if (out.body) out.body = out.body.replace(/\n*Zac,/, `\n\n${link}\n\nZac,`);
  return out;
}
const LANDING_URL = process.env.LANDING_URL || `http://localhost:${process.env.PORT || 4100}/go`;

// ---------- SCANNING AUDIT ENGINE (real website + social scan) ----------
async function scanWebsite(rawUrl) {
  let url = (rawUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const out = { url, reachable: false, https: url.startsWith('https'), title: null, description: null,
    hasPhone: false, hasEmailLink: false, hasForm: false, hasBooking: false, mobileViewport: false, socials: {} };
  if (!url) return out;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (OHM Audit Bot)' } });
    out.reachable = res.ok;
    out.finalUrl = res.url;
    const html = (await res.text()).slice(0, 500000);
    out.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    out.description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || null;
    out.mobileViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    out.hasPhone = /href=["']tel:/i.test(html);
    out.hasEmailLink = /href=["']mailto:/i.test(html);
    out.hasForm = /<form/i.test(html);
    out.hasBooking = /(book now|schedule|appointment|calendly|acuity|book online|reserve|request (a )?quote)/i.test(html);
    const socialRe = { facebook: /facebook\.com\/[A-Za-z0-9._%-]+/i, instagram: /instagram\.com\/[A-Za-z0-9._%-]+/i,
      tiktok: /tiktok\.com\/@?[A-Za-z0-9._%-]+/i, youtube: /youtube\.com\/[A-Za-z0-9@._%/-]+/i,
      linkedin: /linkedin\.com\/(company|in)\/[A-Za-z0-9._%-]+/i };
    for (const [k, re] of Object.entries(socialRe)) { const m = html.match(re); if (m) out.socials[k] = m[0]; }
  } catch (e) { out.error = e.message; }
  return out;
}

async function runPageSpeed(url) {
  if (!url) return null;
  try {
    const key = process.env.PAGESPEED_KEY ? `&key=${process.env.PAGESPEED_KEY}` : '';
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility${key}`;
    const r = await fetch(api, { signal: AbortSignal.timeout(28000) });
    if (!r.ok) return null;
    const d = await r.json();
    const c = d.lighthouseResult?.categories || {};
    const s = x => x?.score != null ? Math.round(x.score * 100) : null;
    return { performance: s(c.performance), seo: s(c.seo), accessibility: s(c.accessibility) };
  } catch { return null; }
}

async function generateAuditReport(p, scan, ps, answers) {
  const prompt = `You are a sharp marketing auditor at Open Heart Media (OHM). Produce a REAL, specific growth audit for a local business, based ONLY on the scan data below. It must feel researched, not generic. Tie every finding to lost leads or revenue.

BUSINESS: ${p.business || 'this business'}, a ${p.category || 'local business'} in ${p.city || 'their area'}, GA. Google rating ${p.rating || 'n/a'} from ${p.reviews || 'n/a'} reviews.
THEIR STATED GOAL: ${answers.goal || 'more customers'}

WEBSITE SCAN: ${JSON.stringify({ reachable: scan.reachable, https: scan.https, mobileReady: scan.mobileViewport, clearPhone: scan.hasPhone, leadForm: scan.hasForm, onlineBooking: scan.hasBooking, title: scan.title, metaDescription: scan.description ? 'present' : 'MISSING' })}
GOOGLE PAGESPEED (mobile, 0-100): ${ps ? JSON.stringify(ps) : 'unavailable'}
SOCIAL LINKS FOUND ON SITE: ${Object.keys(scan.socials).length ? Object.keys(scan.socials).join(', ') : 'NONE detected'}

Score each area honestly from the data. Low PageSpeed = low website score. No meta description / no lead form / no online booking = points off. Few/no socials = low social score. Strong Google rating helps visibility score.

Return ONLY JSON:
{
 "websiteScore": <0-100>,
 "websiteWhy": "2 sentences explaining exactly why the website scored this, citing the real scan data (PageSpeed number, HTTPS, mobile, lead form, meta description). Be specific.",
 "visibilityScore": <0-10>,
 "visibilityWhy": "2 sentences explaining the local visibility score, citing their Google rating, review count vs a typical ${p.category} in ${p.city}, and how findable they are.",
 "socialScore": <0-10>,
 "socialWhy": "2 to 3 sentences explaining the social score in real depth: which platforms were found or missing on their site (${Object.keys(scan.socials).join(', ') || 'none found'}), what that means for a ${p.category}, and specifically what is holding the score down (no presence, inconsistent posting, no video, missing platforms). This must feel substantive, not one vague line.",
 "headline": "one line, e.g. 'Here is where ${p.business || 'your business'} is leaving leads on the table'",
 "findings": [ {"area":"Website|Local visibility|Social|Conversion","title":"punchy specific title","detail":"2 sentences tied to lost leads/revenue, referencing the actual scan finding"} ],
 "summary": "2 sentences, direct and honest",
 "estimate": "one line on the money/leads impact of fixing these"
}
Give 4 to 5 findings, ordered by biggest revenue impact. The three "Why" fields must each be specific and genuinely explain the number. No em dashes. No hype words. Specific to the scan, never generic.`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1100, messages: [{ role: 'user', content: prompt }] });
  let txt = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = txt.match(/\{[\s\S]*\}/); if (m) txt = m[0];
  return JSON.parse(txt);
}

// ---------- Branded PDF audit report ----------
function buildAuditPDF(business, report, bookingUrl) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = 612, M = 48, NAVY = '#0f1a30', NAVY2 = '#16233d', RED = '#df3131', MUT = '#8a97ad';
    const clr = (v, max) => v / max >= .7 ? '#2fae5f' : v / max >= .4 ? '#e0a340' : RED;
    // header band
    doc.rect(0, 0, W, 120).fill(NAVY);
    try { doc.image(path.join(__dirname, 'public', 'media', 'logo-white.png'), M, 38, { height: 30 }); } catch (e) {}
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(10).text('GROWTH AUDIT', M, 82, { characterSpacing: 2 });
    doc.fillColor('#c1cde3').font('Helvetica').fontSize(11).text(business || 'Your business', M, 96);
    // headline
    let y = 152;
    doc.fillColor('#12203a').font('Helvetica-Bold').fontSize(20).text(report.headline || 'Where you are leaving leads on the table', M, y, { width: W - M * 2, lineGap: 2 });
    y = doc.y + 18;
    // overall score card
    const overall = Math.round((Number(report.websiteScore) + Number(report.visibilityScore) * 10 + Number(report.socialScore) * 10) / 3);
    doc.roundedRect(M, y, W - M * 2, 84, 12).fill(NAVY);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(46).text(String(overall), M + 26, y + 18, { continued: true }).fillColor('#9fb0cf').fontSize(18).text(' /100');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text('Overall growth score', M + 150, y + 28);
    doc.fillColor('#c1cde3').font('Helvetica').fontSize(11).text(overall >= 70 ? 'Solid foundation, real room to grow' : overall >= 45 ? 'Leaving real money on the table' : 'Big, fixable gaps costing you leads', M + 150, y + 47);
    y += 104;
    const nl = need => { if (y + need > 720) { doc.addPage(); y = 56; } };
    // score breakdown WITH explanations (depth)
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(11).text('SCORE BREAKDOWN', M, y, { characterSpacing: 1 });
    y += 22;
    const rows = [['Website', report.websiteScore, 100, report.websiteWhy], ['Local visibility', report.visibilityScore, 10, report.visibilityWhy], ['Social', report.socialScore, 10, report.socialWhy]];
    rows.forEach(r => {
      nl(70);
      doc.roundedRect(M, y, 66, 54, 8).fill('#f4f2ec');
      doc.fillColor(clr(r[1], r[2])).font('Helvetica-Bold').fontSize(24).text(String(r[1]), M, y + 10, { width: 66, align: 'center' });
      doc.fillColor(MUT).font('Helvetica').fontSize(8).text('/ ' + r[2], M, y + 36, { width: 66, align: 'center' });
      doc.fillColor('#12203a').font('Helvetica-Bold').fontSize(13).text(r[0], M + 82, y + 2, { width: W - M * 2 - 82 });
      doc.fillColor('#57607a').font('Helvetica').fontSize(10.5).text(r[3] || '', M + 82, doc.y + 2, { width: W - M * 2 - 82, lineGap: 1 });
      y = Math.max(y + 54, doc.y) + 16;
    });
    // findings
    nl(40);
    y += 6;
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(11).text('WHAT IS COSTING YOU LEADS', M, y, { characterSpacing: 1 });
    y += 22;
    (report.findings || []).forEach((f, i) => {
      nl(60);
      doc.circle(M + 9, y + 7, 9).fill(RED);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text(String(i + 1), M, y + 3, { width: 18, align: 'center' });
      doc.fillColor('#12203a').font('Helvetica-Bold').fontSize(12.5).text(f.title, M + 30, y, { width: W - M * 2 - 30 });
      doc.fillColor('#57607a').font('Helvetica').fontSize(10.5).text(f.detail, M + 30, doc.y + 2, { width: W - M * 2 - 30, lineGap: 1 });
      y = doc.y + 14;
    });
    // upside
    nl(90);
    y += 4;
    const uh = doc.heightOfString('The upside: ' + (report.estimate || ''), { width: W - M * 2 - 40, fontSize: 12 }) + 28;
    doc.roundedRect(M, y, W - M * 2, uh, 10).fill(NAVY2);
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(12).text('The upside: ', M + 20, y + 14, { continued: true, width: W - M * 2 - 40 }).fillColor('#fff').font('Helvetica').text(report.estimate || '', { width: W - M * 2 - 40 });
    y += uh + 22;
    // CTA
    doc.fillColor('#12203a').font('Helvetica-Bold').fontSize(13).text('Want us to fix these and grow your business?', M, y);
    doc.fillColor(MUT).font('Helvetica').fontSize(11).text('Book a free 15 minute call: ', M, doc.y + 4, { continued: true }).fillColor(RED).text(bookingUrl);
    // footer
    doc.fillColor(MUT).font('Helvetica').fontSize(9).text('Open Heart Media  ·  Georgia  ·  zac@openheartmediaco.com', M, 730, { width: W - M * 2, align: 'center' });
    doc.end();
  });
}

// ---------- ONE living landing page (the funnel) + metrics ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const CALENDLY = process.env.CALENDLY_URL || 'https://calendly.com/openheartmedia/discovery';
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

function renderLandingPage(ref) {
  const prospect = ref && prospects.find(x => x.id === ref);
  const bizName = prospect ? prospect.business : null;
  const prefillSite = prospect ? (prospect.website || '') : '';
  const site = loadSite();
  const video = site.videoEmbed
    ? `<div class="vframe"><iframe src="${site.videoEmbed}" frameborder="0" allowfullscreen></iframe></div>`
    : `<div class="vframe"><video src="/media/ohm-promo.mp4" autoplay muted loop playsinline controls preload="metadata"></video></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Free growth audit · Open Heart Media</title>
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
.case{border-top:1px solid var(--line)}
.case.cream{background:var(--cream);color:var(--ink);border-top:0}
.chero{display:flex;align-items:baseline;gap:20px;flex-wrap:wrap;margin-bottom:8px}
.bignum{font-size:clamp(58px,12vw,120px);font-weight:900;letter-spacing:-.04em;line-height:.9;color:var(--red);font-variant-numeric:tabular-nums}
.case.cream .bignum{color:var(--navy)}
.chero .cl{font-size:15px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--soft)}
.ctitle{font-size:clamp(24px,3.6vw,34px);font-weight:800;letter-spacing:-.01em;margin:6px 0 26px;max-width:20ch}
.cstory{display:grid;grid-template-columns:1fr 1fr 1fr;gap:22px;margin-top:8px}
.cstory .blk h4{font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--red);margin-bottom:8px}
.case.cream .cstory .blk h4{color:var(--navy)}
.cstory .blk p{font-size:15px;color:#c3c3c3;line-height:1.6}.case.cream .cstory .blk p{color:#57534e}
.cmetrics{display:flex;gap:30px;flex-wrap:wrap;margin-top:30px;padding-top:26px;border-top:1px solid var(--line)}.case.cream .cmetrics{border-top:1px solid var(--lineL)}
.cmetrics .m b{font-size:26px;font-weight:900;display:block;font-variant-numeric:tabular-nums}.cmetrics .m span{font-size:13px;color:var(--soft)}
/* video */
.vframe{aspect-ratio:16/9;border-radius:18px;overflow:hidden;background:#000;margin-top:28px;border:1px solid var(--line);box-shadow:0 30px 80px -30px rgba(0,0,0,.8)}
.vframe video,.vframe iframe{width:100%;height:100%;object-fit:cover;display:block}
/* booking */
.book{background:var(--ink2);text-align:center}
.book h2{font-size:clamp(30px,4.4vw,46px);font-weight:900;letter-spacing:-.02em;max-width:18ch;margin:0 auto}
.book p{color:#cfcfcf;font-size:18px;margin:18px auto 8px;max-width:52ch}
.calwrap{margin-top:30px;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:#fff}
.foot{padding:40px 32px;text-align:center;color:var(--soft);font-size:13px;border-top:1px solid var(--line)}
.hide{display:none}
@media(max-width:720px){.sec{padding:64px 22px}.hero{padding:80px 22px 64px}.scoregrid,.cstory{grid-template-columns:1fr}.formwrap{padding:24px}}
</style></head><body>
<div class="nav"><img class="logo" src="/media/logo-white.png" alt="Open Heart Media"/><a class="navcta" href="#book">Book a call</a></div>

<section class="hero">
  <div class="inner">
    <div class="eyebrow reveal">${bizName ? 'Free growth audit for ' + esc(bizName) : 'Free instant growth audit'}</div>
    <h1 class="reveal">You're a great business. You're just <em>leaving money</em> on the table.</h1>
    <p class="sub reveal">We scan your website and online presence live, then show you the exact gaps quietly costing you leads and revenue. Free, instant, no call required to see it.</p>

    <div class="formwrap reveal" id="auditbox">
      <h2>Get your free instant audit</h2>
      <p class="fp">About 20 seconds. We scan your site live and show your scores.</p>
      <label for="f_site">Your website</label>
      <input id="f_site" placeholder="yourbusiness.com" value="${esc(prefillSite)}"/>
      <label for="f_goal">What matters most right now</label>
      <select id="f_goal"><option value="more leads">More leads</option><option value="more phone calls">More phone calls</option><option value="more booked appointments">More booked appointments</option><option value="more sales">More sales</option><option value="more of everything">More of everything</option></select>
      <label for="f_email">Where should we send your audit</label>
      <input id="f_email" type="email" placeholder="you@yourbusiness.com"/>
      <button class="btn" id="run">Scan my business</button>
      <p class="err" id="err"></p>
    </div>
  </div>
</section>

<section class="sec results hide" id="result"></section>

<section class="case" id="proof">
  <div class="inner">
    <div class="eyebrow reveal">Proof, not promises</div>
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
    <div class="eyebrow reveal" style="text-align:center">Book your free call</div>
    <h2 class="reveal">Let's find the leads your business is missing.</h2>
    <p class="reveal">Grab a free 15 minute call. We'll walk through your audit and exactly what we'd do. No pitch, no pressure.</p>
    <div class="calwrap reveal"><div class="calendly-inline-widget" data-url="${CALENDLY}?hide_gdpr_banner=1&utm_content=${esc(ref || '')}" style="min-width:320px;height:700px"></div></div>
  </div>
</section>

<div class="foot">Open Heart Media · Georgia · zac@openheartmediaco.com</div>

<script src="https://assets.calendly.com/assets/external/widget.js" async></script>
<script>
  var REF = ${JSON.stringify(ref || '')};
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
  document.getElementById('run').addEventListener('click', function(){
    var email=document.getElementById('f_email').value.trim();
    var sitev=document.getElementById('f_site').value.trim();
    var goal=document.getElementById('f_goal').value;
    var err=document.getElementById('err');
    if(email.indexOf('@')<0){ err.textContent='Please enter a valid email.'; return; }
    err.textContent=''; var btn=this; btn.disabled=true; btn.textContent='Scanning your business...';
    fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:REF,email:email,website:sitev,goal:goal})})
     .then(function(r){return r.json();})
     .then(function(d){
       if(d.error){ err.textContent=d.error; btn.disabled=false; btn.textContent='Scan my business'; return; }
       var a=d.report;
       var biz=d.business||'your business';
       function cls(v,max){var p=v/max;return p>=.7?'sc-good':p>=.4?'sc-mid':'sc-bad';}
       function mtr(v,max){return '<div class="meter"><i style="width:'+Math.max(6,Math.round(v/max*100))+'%"></i></div>';}
       var overall=Math.round((Number(a.websiteScore)+Number(a.visibilityScore)*10+Number(a.socialScore)*10)/3);
       var verdict=overall>=70?'Solid foundation, real room to grow':overall>=45?'Leaving real money on the table':'Big, fixable gaps costing you leads';
       function scard(v,max,label){return '<div class="scard '+cls(v,max)+'"><b>'+v+'<span class="of">/'+max+'</span></b><span>'+label+'</span>'+mtr(v,max)+'</div>';}
       function colHex(v,max){var p=v/max;return p>=.7?'#3fbf6a':p>=.4?'#e0a340':'#df3131';}
       var bd=[['Website',a.websiteScore,100,a.websiteWhy],['Local visibility',a.visibilityScore,10,a.visibilityWhy],['Social',a.socialScore,10,a.socialWhy]].map(function(r){return '<div class="find"><div class="n" style="background:'+colHex(r[1],r[2])+'">'+r[1]+'</div><div><h3>'+r[0]+'  <span style="color:#8fa0bd;font-weight:600;font-size:14px">'+r[1]+'/'+r[2]+'</span></h3><p>'+esc(r[3]||'')+'</p></div></div>';}).join('');
       var findings=(a.findings||[]).map(function(f,i){return '<div class="find"><div class="n">'+(i+1)+'</div><div><h3>'+esc(f.title)+'</h3><p>'+esc(f.detail)+'</p></div></div>';}).join('');
       var html='<div class="inner">'
        +'<div class="rhead"><img class="rlogo" src="/media/logo-white.png" alt="Open Heart Media"/><div class="rtag">Growth Audit · '+esc(biz)+'</div></div>'
        +'<div class="ctitle" style="color:var(--ink)">'+esc(a.headline||'Where you are leaving leads on the table')+'</div>'
        +'<div class="grade"><div class="gbig">'+overall+'<span>/100</span></div><div class="glabel"><b>Overall growth score</b><span>'+verdict+'</span></div></div>'
        +'<div class="scoregrid">'+scard(a.websiteScore,100,'Website')+scard(a.visibilityScore,10,'Local visibility')+scard(a.socialScore,10,'Social')+'</div>'
        +'<div class="fhead">Score breakdown</div>'+bd
        +'<div class="fhead" style="margin-top:22px">What is costing you leads</div>'+findings
        +'<div class="est"><b>The upside: </b>'+esc(a.estimate||'')+'</div>'
        +'<a class="btn" id="rbook" href="#book" style="max-width:360px;margin:28px auto 0;text-decoration:none">Book my free call to fix this</a></div>';
       var res=document.getElementById('result'); res.innerHTML=html; res.classList.remove('hide');
       document.getElementById('auditbox').style.display='none';
       document.getElementById('rbook').addEventListener('click',function(){track('click');});
       res.scrollIntoView({behavior:'smooth'});
     })
     .catch(function(){ err.textContent='Something went wrong. Please try again.'; btn.disabled=false; btn.textContent='Scan my business'; });
  });
</script>
</body></html>`;
}
function sentToday() {
  const today = new Date().toISOString().slice(0, 10);
  return prospects.filter(p => p.status === 'sent' && (p.sent_at || '').slice(0, 10) === today).length;
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
const PUBLIC_PATHS = ['/go', '/api/track', '/api/calendly-webhook', '/login', '/api/login', '/api/logout'];
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
  const wonValue = prospects.filter(p => p.status === 'won').reduce((s, p) => s + (Number(p.deal_value) || 0), 0);
  const openValue = prospects.filter(p => ['replied', 'booked'].includes(p.status)).reduce((s, p) => s + (Number(p.deal_value) || 0), 0);
  res.json({ prospects, counts, sentToday: sentToday(), dailyCap: DAILY_CAP, team: TEAM, wonValue, openValue });
});

// Team members who can be "on" a response. Configurable via TEAM env (comma list).
const TEAM = (process.env.TEAM || 'Zac,Michelle').split(',').map(s => s.trim()).filter(Boolean);

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
app.get('/go', (req, res) => {
  res.send(renderLandingPage(req.query.ref));
});

// Preview the branded PDF audit design (sample data)
app.get('/api/audit-pdf-preview', async (_, res) => {
  const sample = { websiteScore: 42, visibilityScore: 7, socialScore: 6,
    websiteWhy: 'Your site scored a 38 on Google mobile PageSpeed and is still running on HTTP instead of HTTPS, so it loads slowly and browsers flag it as not secure. There is a booking link but no clear meta description, which weakens how you show up in search.',
    visibilityWhy: 'A 4.9 rating from 820 reviews is elite for a med spa and puts you near the top in Canton, which is why this score is high. The gap is that not everyone searching for a med spa in Canton is finding you first, so some of that reputation never converts.',
    socialWhy: 'We found Facebook and Instagram linked from your site but no TikTok or YouTube, and no sign of consistent recent posting. For a med spa, short before-and-after video is what drives new bookings, and right now that channel is barely working, which is the single biggest reason this score is a 6 and not a 9.',
    headline: 'Here is where The Beauty Barn is leaving booked appointments on the table',
    findings: [
      { title: 'No HTTPS, so browsers flag you Not Secure', detail: 'New clients entering their info at booking see a security warning and leave. That is booked revenue lost at the finish line.' },
      { title: 'Missing meta description costs you clicks from Google', detail: 'Google auto-generates a weak snippet, so people searching for a med spa in Canton scroll past you to a competitor.' },
      { title: 'Your reviews are elite, your content engine is not', detail: '820 five-star reviews prove people love you, but no consistent content means new clients never see it before they book elsewhere.' }],
    estimate: 'Fixing these could conservatively recover 8 to 15 additional booked appointments a month at your review volume.' };
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
const NOTIFY = (process.env.NOTIFY_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
async function notifyBooking(info) {
  if (!process.env.SENDGRID_API_KEY || !NOTIFY.length) return;
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
  if (!process.env.SENDGRID_API_KEY || !NOTIFY.length) return;
  const text = `New audit completed (hot lead).\n\n`
    + `Business: ${p?.business || 'unknown'}\n`
    + `Email:    ${email}\n`
    + `Website:  ${p?.website || 'n/a'}\n`
    + `Scores:   website ${report.websiteScore}/100, visibility ${report.visibilityScore}/10, social ${report.socialScore}/10\n\n`
    + (report.findings || []).map(f => `- ${f.title}`).join('\n')
    + `\n\nThey saw this and got a Book-a-call CTA. Follow up fast.`;
  const msg = { to: NOTIFY, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject: `🔥 Audit completed${p?.business ? ' — ' + p.business : ''}`, text };
  if (pdf) msg.attachments = [{ content: pdf.toString('base64'), filename: 'audit-' + (p?.business || 'lead').replace(/[^a-z0-9]/gi, '-') + '.pdf', type: 'application/pdf', disposition: 'attachment' }];
  try { await sgMail.sendMultiple(msg); } catch (e) { console.error('[notifyAudit]', e.message); }
}

// Email the branded PDF audit to the prospect who filled out the form
async function sendAuditToProspect(to, business, report, pdf, bookingUrl) {
  if (!process.env.SENDGRID_API_KEY || !to) return;
  const overall = Math.round((Number(report.websiteScore) + Number(report.visibilityScore) * 10 + Number(report.socialScore) * 10) / 3);
  const text = `Hi,\n\nHere is your free growth audit for ${business || 'your business'}, attached as a PDF.\n\nYour overall growth score came in at ${overall} out of 100. The biggest thing costing you leads right now: ${report.findings?.[0]?.title || 'a few fixable gaps'}.\n\nWant us to fix these and grow your business? Grab a free 15 minute call here:\n${bookingUrl}\n\nZac\nOpen Heart Media`;
  try {
    await sgMail.send({ to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `your growth audit for ${business || 'your business'}`, text,
      attachments: [{ content: pdf.toString('base64'), filename: 'growth-audit.pdf', type: 'application/pdf', disposition: 'attachment' }] });
  } catch (e) { console.error('[audit-email]', e.message); }
}

// Run the live scan + audit when a prospect fills out the form
app.post('/api/audit', async (req, res) => {
  const { ref, email, goal, website } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  const p = ref && prospects.find(x => x.id === ref);
  const site = website || (p && p.website) || '';
  try {
    const scan = await scanWebsite(site);
    const ps = await runPageSpeed(scan.finalUrl || scan.url);
    const report = await generateAuditReport(p || {}, scan, ps, { goal });
    const bookingUrl = `${CALENDLY}?utm_content=${p?.id || ''}`;
    let pdf = null;
    try { pdf = await buildAuditPDF(p?.business || 'your business', report, bookingUrl); } catch (e) { console.error('[pdf]', e.message); }
    if (p) {
      p.audit_email = email; p.audit_goal = goal || null; p.audit_report = report;
      p.audit_scan = { pagespeed: ps, socials: scan.socials, reachable: scan.reachable };
      p.status = 'audited'; p.audited_at = new Date().toISOString(); p.updated_at = p.audited_at;
      save(prospects);
    }
    events.push({ type: 'audit', ref: ref || null, ts: new Date().toISOString(), email, business: p?.business || null });
    saveMetrics();
    await notifyAudit(p, email, report, pdf);
    if (pdf) await sendAuditToProspect(email, p?.business, report, pdf, bookingUrl);
    res.json({ report, business: p?.business || null });
  } catch (e) { console.error('[audit]', e.message); res.status(500).json({ error: 'scan failed, please try again' }); }
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
  const queue = prospects.filter(p => p.status === 'approved' && p.email && p.email.includes('@'));
  let sent = 0; const errors = [];
  for (const p of queue) {
    if (budget <= 0) break;
    try {
      const [r] = await sgMail.send({
        to: p.email,
        from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
        subject: p.subject, text: p.body,
      });
      p.status = 'sent'; p.sent_at = new Date().toISOString(); p.updated_at = p.sent_at;
      p.provider_id = r.headers['x-message-id'] || null;
      sent++; budget--; save(prospects);
      await new Promise(r => setTimeout(r, 800));
    } catch (e) { errors.push({ id: p.id, error: e.response?.body?.errors?.[0]?.message || e.message }); }
  }
  res.json({ sent, remainingBudget: budget, errors });
});

// ---------- 3 / 7 / 10 day follow-up sequence ----------
async function draftFollowup(p, step) {
  const link = `${LANDING_URL}?ref=${p.id}`;
  const angles = {
    1: 'Circle back gently, one or two short lines. Ask if they got a chance to run their free audit. Warm, low pressure.',
    2: 'Open with one quick proof point (we recently drove about 90x return on ad spend, $2.34M in tracked revenue, for a local home services business). Then invite them to grab their free audit.',
    3: 'Last friendly touch, one or two lines. Say you will leave it here, and the free audit is open anytime if they want it.',
  };
  const prompt = `Write a very short follow-up email (2 to 3 sentences) from Zac at Open Heart Media to ${p.business}, a ${p.category} in ${p.city} GA. This is follow-up ${step} of 3. ${angles[step]} Reference their business naturally. Put the exact token [LINK] on its own line for the audit link. Sign "Zac, Open Heart Media". No em dashes, no exclamation marks, no hype. Lowercase subject under 45 chars. Return ONLY JSON {"subject":"...","body":"..."}`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  let t = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  const o = JSON.parse(t);
  if (o.body) o.body = o.body.includes('[LINK]') ? o.body.replace('[LINK]', link) : o.body + '\n\n' + link;
  return o;
}
const FOLLOWUP_DAYS = { 1: 3, 2: 7, 3: 10 };
async function runFollowups() {
  const now = Date.now(); let sent = 0;
  for (const p of prospects) {
    if (!p.sent_at || !p.email || !p.email.includes('@')) continue;
    if (['booked', 'replied', 'rejected'].includes(p.status)) continue; // stop sequence once they act
    const step = (p.followup_step || 0) + 1;
    if (step > 3) continue;
    const days = (now - new Date(p.sent_at).getTime()) / 86400000;
    if (days < FOLLOWUP_DAYS[step]) continue;
    try {
      const msg = await draftFollowup(p, step);
      await sgMail.send({ to: p.email, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME }, subject: msg.subject, text: msg.body });
      p.followup_step = step; p.last_followup_at = new Date().toISOString(); p.updated_at = p.last_followup_at;
      save(prospects); sent++;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) { console.error('[followup]', p.id, e.message); }
  }
  return sent;
}
app.post('/api/run-followups', async (_, res) => { res.json({ sent: await runFollowups() }); });
setInterval(() => { runFollowups().then(n => n && console.log('[followups] sent', n)); }, 6 * 60 * 60 * 1000);

app.post('/api/reseed', (_, res) => { prospects = seedFromCsv(); res.json({ count: prospects.length }); });

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => console.log(`OHM Outreach dashboard on http://localhost:${PORT}`));
