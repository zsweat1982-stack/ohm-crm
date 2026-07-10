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

// ---------- Claude: detailed personalized audit (for the landing page) ----------
async function draftAudit(p) {
  const prompt = `You are a growth strategist at Open Heart Media (OHM), which gets local businesses more leads and revenue. Create a detailed, specific, personalized growth audit for this business that will be shown on a branded landing page. It must feel researched and real, focused on OUTCOMES (more leads, customers, revenue), not on tactics for their own sake.

BUSINESS:
- Name: ${p.business}
- Type: ${p.category}
- City: ${p.city}, GA
- Google rating: ${p.rating || 'n/a'} from ${p.reviews || 'n/a'} reviews
- Website: ${p.website || 'n/a'}

Return ONLY JSON with this shape:
{
  "headline": "Growth Audit for ${p.business}",
  "strengths": "2 sentences on what they are clearly doing right (reference their real rating/reviews and standing as a ${p.category} in ${p.city}).",
  "gaps": [
    {"title": "short punchy gap title about lost leads/revenue", "detail": "2 sentences, specific, framed as money/customers being missed and why it happens for a ${p.category}"},
    {"title": "...", "detail": "..."},
    {"title": "...", "detail": "..."}
  ],
  "plan": "3 sentences on what OHM would do to capture those lost leads and grow their revenue. Confident, plain, outcome-focused.",
  "estimate": "one line on the realistic upside, e.g. 'even a 15% lift in booked ${p.category==='Medical spa'?'appointments':'jobs'} is real money each month'"
}
No em dashes anywhere. No hype words. Plain, sharp, credible.`;
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });
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
  const site = loadSite();
  const video = site.videoEmbed
    ? `<div class="video"><iframe src="${site.videoEmbed}" frameborder="0" allowfullscreen></iframe></div>`
    : `<div class="video ph">Your hype reel goes here</div>`;
  const casesHtml = (site.cases || []).map(c => `<div class="case"><b>${esc(c.stat)}</b><span>${esc(c.label)}</span></div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grow your local business · Open Heart Media</title>
<style>
:root{--ink:#0f1115;--gold:#c9a24b;--soft:#6b7280;--line:#e6e8ec;--bg:#fff;--panel:#f7f8fa}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.nav{display:flex;align-items:center;gap:10px;padding:18px 28px;border-bottom:1px solid var(--line)}
.logo{font-weight:800;letter-spacing:.5px}.logo span{color:var(--gold)}
.wrap{max-width:820px;margin:0 auto;padding:52px 24px 80px}
.tag{color:var(--gold);font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:12px}
h1{font-size:40px;line-height:1.12;margin:8px 0 14px}
.lead{font-size:20px;color:var(--soft);margin-bottom:30px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px 26px;margin:18px 0}
.card h2{margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--soft)}
.gap{display:flex;gap:16px;padding:16px 0;border-bottom:1px solid var(--line)}.gap:last-child{border-bottom:0}
.gnum{flex:0 0 34px;height:34px;border-radius:50%;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.gap h3{margin:2px 0 4px;font-size:18px}.gap p{margin:0;color:var(--soft)}
.video{aspect-ratio:16/9;border-radius:14px;overflow:hidden;margin:26px 0;background:#000}
.video iframe{width:100%;height:100%}
.video.ph{display:flex;align-items:center;justify-content:center;color:#8a8f98;background:var(--panel);border:1px dashed var(--line)}
.cases{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin:18px 0}
.case{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
.case b{font-size:26px;color:var(--gold);display:block}.case span{font-size:13px;color:var(--soft)}
.cta{background:var(--ink);color:#fff;border-radius:16px;padding:36px;text-align:center;margin-top:34px}
.cta h2{color:#fff;text-transform:none;letter-spacing:0;font-size:24px;margin:0 0 8px}
.cta p{color:#c7cad1;margin:0 0 20px}
.btn{display:inline-block;background:var(--gold);color:#1a1a1a;font-weight:800;padding:16px 36px;border-radius:10px;text-decoration:none;font-size:17px;cursor:pointer;border:0}
.foot{text-align:center;color:var(--soft);font-size:13px;margin-top:40px}
@media(max-width:640px){.cases{grid-template-columns:1fr}h1{font-size:31px}}
</style></head><body>
<div class="nav"><div class="logo">OPEN HEART <span>MEDIA</span></div></div>
<div class="wrap">
  <div class="tag">${bizName ? 'Growth audit prepared for ' + esc(bizName) : 'For local Georgia businesses'}</div>
  <h1>You're a great business. You're just leaving leads and revenue on the table.</h1>
  <p class="lead">Most local businesses lose customers they never even see, because the people searching right now are not all finding them or booking. We fix that, and the growth shows up in your numbers.</p>

  <div class="card"><h2>Where the leads and revenue slip away</h2>
    <div class="gap"><div class="gnum">1</div><div><h3>Invisible at the moment of search</h3><p>People looking for you on Google are landing on a competitor first. That is booked revenue walking out the door every week.</p></div></div>
    <div class="gap"><div class="gnum">2</div><div><h3>Traffic that never converts</h3><p>Visitors show up but do not book, because nothing on the page makes them act. We turn lookers into calls and appointments.</p></div></div>
    <div class="gap"><div class="gnum">3</div><div><h3>No engine bringing in new customers</h3><p>Referrals are great, but they are not predictable. We build a steady flow of new leads every single month.</p></div></div>
  </div>

  <h2 style="margin-top:38px">See what that looks like in real numbers</h2>
  ${video}
  <div class="cases">${casesHtml}</div>

  <div class="cta">
    <h2>Want to see exactly where your growth is hiding?</h2>
    <p>Book a free 15 minute call and we'll walk through it, no pitch, no pressure.</p>
    <button class="btn" id="book">Book my free call</button>
  </div>
  <div class="foot">Open Heart Media · Cherokee County, GA · zac@openheartmediaco.com</div>
</div>
<script>
  var REF = ${JSON.stringify(ref || '')};
  function track(type){ try{ navigator.sendBeacon('/api/track', new Blob([JSON.stringify({type:type,ref:REF})],{type:'application/json'})); }catch(e){} }
  track('view');
  document.getElementById('book').addEventListener('click', function(){ track('click'); var u=${JSON.stringify(CALENDLY)}; if(REF)u+=(u.indexOf('?')>-1?'&':'?')+'utm_content='+encodeURIComponent(REF); window.open(u,'_blank'); });
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

app.post('/api/reseed', (_, res) => { prospects = seedFromCsv(); res.json({ count: prospects.length }); });

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => console.log(`OHM Outreach dashboard on http://localhost:${PORT}`));
