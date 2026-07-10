import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import sgMail from '@sendgrid/mail';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data', 'prospects.json');
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
 "visibilityScore": <0-10>,
 "socialScore": <0-10>,
 "headline": "one line, e.g. 'Here is where ${p.business || 'your business'} is leaving leads on the table'",
 "findings": [ {"area":"Website|Local visibility|Social|Conversion","title":"punchy specific title","detail":"2 sentences tied to lost leads/revenue, referencing the actual scan finding"} ],
 "summary": "2 sentences, direct and honest",
 "estimate": "one line on the money/leads impact of fixing these"
}
Give 4 to 5 findings, ordered by biggest revenue impact. No em dashes. No hype words. Specific to the scan, never generic.`;
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1100, messages: [{ role: 'user', content: prompt }] });
  let txt = r.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = txt.match(/\{[\s\S]*\}/); if (m) txt = m[0];
  return JSON.parse(txt);
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

const METRICS = path.join(__dirname, 'data', 'metrics.json');
function loadMetrics() { try { return JSON.parse(fs.readFileSync(METRICS, 'utf8')); } catch { return []; } }
function saveMetrics() { fs.writeFileSync(METRICS, JSON.stringify(events, null, 2)); }
let events = loadMetrics();

function renderLandingPage(ref) {
  const prospect = ref && prospects.find(x => x.id === ref);
  const bizName = prospect ? prospect.business : null;
  const prefillSite = prospect ? (prospect.website || '') : '';
  const site = loadSite();
  const video = site.videoEmbed
    ? `<div class="video"><iframe src="${site.videoEmbed}" frameborder="0" allowfullscreen></iframe></div>`
    : `<div class="video"><video src="/media/ohm-promo.mp4" controls preload="metadata" playsinline style="width:100%;height:100%;object-fit:cover"></video></div>`;
  const casesHtml = (site.cases || []).map(c => `<div class="case"><b>${esc(c.stat)}</b><span>${esc(c.label)}</span></div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Free growth audit · Open Heart Media</title>
<style>
:root{--ink:#1c1c1c;--navy:#1a2b4c;--red:#df3131;--blue:#5e97ff;--soft:#6b7280;--line:#e7e4dc;--bg:#fff;--cream:#fcfaf5}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.nav{display:flex;align-items:center;padding:16px 28px;background:var(--ink)}
.logo{font-weight:800;letter-spacing:.5px;color:#fff}.logo span{color:var(--red)}
.wrap{max-width:820px;margin:0 auto;padding:48px 24px 80px}
.tag{color:var(--red);font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:12px}
h1{font-size:38px;line-height:1.13;margin:8px 0 14px}
.lead{font-size:19px;color:var(--soft);margin-bottom:30px}
.card{background:var(--cream);border:1px solid var(--line);border-radius:14px;padding:24px 26px;margin:18px 0}
.card h2{margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--soft)}
.gap{display:flex;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}.gap:last-child{border-bottom:0}
.gnum{flex:0 0 32px;height:32px;border-radius:50%;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.gap h3{margin:2px 0 4px;font-size:17px}.gap p{margin:0;color:var(--soft)}
.video{aspect-ratio:16/9;border-radius:14px;overflow:hidden;margin:22px 0;background:#000}
.video iframe{width:100%;height:100%}
.cases{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin:18px 0}
.case{background:var(--cream);border:1px solid var(--line);border-radius:12px;padding:18px}
.case b{font-size:25px;color:var(--red);display:block;font-weight:800}.case span{font-size:13px;color:var(--soft)}
.form h2{font-size:22px;text-transform:none;letter-spacing:0;color:var(--ink);margin:0 0 6px}
label{display:block;font-size:13px;color:var(--soft);margin:12px 0 4px}
input,select{width:100%;padding:12px;border:1px solid #d8d4ca;border-radius:9px;font:inherit;background:#fff}
.btn{display:inline-block;background:var(--red);color:#fff;font-weight:700;padding:15px 34px;border-radius:10px;text-decoration:none;font-size:16px;cursor:pointer;border:0;width:100%;margin-top:16px}
.btn:disabled{opacity:.6}
.scores{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:6px 0 18px}
.score{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;text-align:center}
.score b{font-size:30px;font-weight:800;display:block;color:var(--navy)}.score span{font-size:12px;color:var(--soft)}
.find{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}.find:last-child{border-bottom:0}
.dot{flex:0 0 10px;height:10px;border-radius:50%;background:var(--red);margin-top:7px}
.find h3{margin:0 0 3px;font-size:16px}.find p{margin:0;color:var(--soft);font-size:15px}
.cta{background:var(--ink);color:#fff;border-radius:16px;padding:32px;text-align:center;margin-top:26px}
.cta h2{color:#fff;font-size:23px;margin:0 0 8px}.cta p{color:#c7cad1;margin:0 0 18px}
.cta .btn{background:var(--red);max-width:320px;margin:0 auto}
.est{font-weight:600;font-size:17px;color:var(--navy);margin-top:8px}
.foot{text-align:center;color:var(--soft);font-size:13px;margin-top:40px}
.hide{display:none}
@media(max-width:640px){.cases,.scores{grid-template-columns:1fr}h1{font-size:30px}}
</style></head><body>
<div class="nav"><div class="logo">OPEN HEART <span>MEDIA</span></div></div>
<div class="wrap">
  <div class="tag">${bizName ? 'Free growth audit for ' + esc(bizName) : 'For local Georgia businesses'}</div>
  <h1>See exactly where your business is losing leads and revenue.</h1>
  <p class="lead">We scan your website and online presence live, then show you the specific gaps costing you customers. Free, instant, no call required to get it.</p>

  <div class="card form" id="auditbox">
    <h2>Get your free instant audit</h2>
    <p style="color:var(--soft);margin:0 0 4px">Takes about 20 seconds. We will scan your site and show your scores.</p>
    <label>Your website</label>
    <input id="f_site" placeholder="yourbusiness.com" value="${esc(prefillSite)}"/>
    <label>What matters most right now</label>
    <select id="f_goal">
      <option value="more leads">More leads</option>
      <option value="more phone calls">More phone calls</option>
      <option value="more booked appointments">More booked appointments</option>
      <option value="more sales">More sales</option>
      <option value="more of everything">More of everything</option>
    </select>
    <label>Where should we send your audit</label>
    <input id="f_email" type="email" placeholder="you@yourbusiness.com"/>
    <button class="btn" id="run">Scan my business</button>
    <p id="err" style="color:var(--red);font-size:13px;margin:8px 0 0"></p>
  </div>

  <div id="result" class="hide"></div>

  <h2 style="margin-top:40px">Real results we have driven</h2>
  ${video}
  <div class="cases">${casesHtml}</div>

  <div class="foot">Open Heart Media · Georgia · zac@openheartmediaco.com</div>
</div>
<script>
  var REF = ${JSON.stringify(ref || '')};
  var CAL = ${JSON.stringify(CALENDLY)};
  function track(t){ try{ navigator.sendBeacon('/api/track', new Blob([JSON.stringify({type:t,ref:REF})],{type:'application/json'})); }catch(e){} }
  track('view');
  function bookUrl(){ var u=CAL; if(REF)u+=(u.indexOf('?')>-1?'&':'?')+'utm_content='+encodeURIComponent(REF); return u; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  document.getElementById('run').addEventListener('click', function(){
    var email=document.getElementById('f_email').value.trim();
    var site=document.getElementById('f_site').value.trim();
    var goal=document.getElementById('f_goal').value;
    var err=document.getElementById('err');
    if(email.indexOf('@')<0){ err.textContent='Please enter a valid email.'; return; }
    err.textContent='';
    var btn=this; btn.disabled=true; btn.textContent='Scanning your business...';
    fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:REF,email:email,website:site,goal:goal})})
     .then(function(r){ return r.json(); })
     .then(function(d){
       if(d.error){ err.textContent=d.error; btn.disabled=false; btn.textContent='Scan my business'; return; }
       var a=d.report;
       var findings=(a.findings||[]).map(function(f){ return '<div class="find"><div class="dot"></div><div><h3>'+esc(f.title)+'</h3><p>'+esc(f.detail)+'</p></div></div>'; }).join('');
       var html='<div class="card"><div class="tag" style="margin-bottom:6px">Your audit results</div>'
         +'<h2 style="font-size:22px;text-transform:none;letter-spacing:0;color:var(--ink);margin:0 0 14px">'+esc(a.headline||'Your growth audit')+'</h2>'
         +'<div class="scores"><div class="score"><b>'+a.websiteScore+'</b><span>Website / 100</span></div>'
         +'<div class="score"><b>'+a.visibilityScore+'</b><span>Local visibility / 10</span></div>'
         +'<div class="score"><b>'+a.socialScore+'</b><span>Social / 10</span></div></div>'
         +findings+'<p class="est">'+esc(a.estimate||'')+'</p></div>'
         +'<div class="cta"><h2>Want us to fix these and grow your '+esc(goal)+'?</h2>'
         +'<p>Book a free 15 minute call. We will walk through your audit and exactly what we would do. No pitch, no pressure.</p>'
         +'<a class="btn" id="book" href="'+bookUrl()+'" target="_blank" rel="noopener">Book my free call</a></div>';
       var res=document.getElementById('result'); res.innerHTML=html; res.classList.remove('hide');
       document.getElementById('auditbox').classList.add('hide');
       document.getElementById('book').addEventListener('click', function(){ track('click'); });
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

// Public routes stay open (prospects must reach these); everything else is password-locked
// when DASHBOARD_PASSWORD is set (for public hosting). Local runs with no password = open.
const PUBLIC_PATHS = ['/go', '/api/track', '/api/calendly-webhook'];
app.use((req, res, next) => {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return next(); // local dev, no lock
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString().split(':')[1] : null;
  if (token === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="OHM"').status(401).send('Auth required');
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/prospects', (_, res) => {
  const counts = {};
  for (const p of prospects) counts[p.status] = (counts[p.status] || 0) + 1;
  res.json({ prospects, counts, sentToday: sentToday(), dailyCap: DAILY_CAP });
});

app.patch('/api/prospects/:id', (req, res) => {
  const p = prospects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  for (const k of ['email', 'subject', 'body', 'status']) {
    if (req.body[k] !== undefined) p[k] = req.body[k];
  }
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

async function notifyAudit(p, email, report) {
  if (!process.env.SENDGRID_API_KEY || !NOTIFY.length) return;
  const text = `New audit completed (hot lead).\n\n`
    + `Business: ${p?.business || 'unknown'}\n`
    + `Email:    ${email}\n`
    + `Website:  ${p?.website || 'n/a'}\n`
    + `Scores:   website ${report.websiteScore}/100, visibility ${report.visibilityScore}/10, social ${report.socialScore}/10\n\n`
    + (report.findings || []).map(f => `- ${f.title}`).join('\n')
    + `\n\nThey saw this and got a Book-a-call CTA. Follow up fast.`;
  try {
    await sgMail.sendMultiple({ to: NOTIFY, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `🔥 Audit completed${p?.business ? ' — ' + p.business : ''}`, text });
  } catch (e) { console.error('[notifyAudit]', e.message); }
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
    if (p) {
      p.audit_email = email; p.audit_goal = goal || null; p.audit_report = report;
      p.audit_scan = { pagespeed: ps, socials: scan.socials, reachable: scan.reachable };
      p.status = 'audited'; p.audited_at = new Date().toISOString(); p.updated_at = p.audited_at;
      save(prospects);
    }
    events.push({ type: 'audit', ref: ref || null, ts: new Date().toISOString(), email, business: p?.business || null });
    saveMetrics();
    await notifyAudit(p, email, report);
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
