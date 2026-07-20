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

// ---------- SCANNING AUDIT ENGINE (deep website + social + marketing scan) ----------
async function scanWebsite(rawUrl) {
  let url = (rawUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const out = {
    url, reachable: false, https: url.startsWith('https'), redirectsToHttps: false, finalUrl: null,
    // content / SEO
    title: null, titleLen: 0, description: null, descriptionLen: 0, h1Count: 0, wordCount: 0,
    mobileViewport: false, favicon: false, ogTitle: false, ogImage: false, schemaLocalBusiness: false, canonical: false,
    // conversion
    hasPhone: false, hasEmailLink: false, hasForm: false, hasBooking: false, hasNewsletter: false,
    hasLiveChat: false, hasCta: false, napAddress: false,
    // tracking / data
    analytics: false, analyticsType: null, fbPixel: false, googleAdsTag: false,
    // media / trust
    imgCount: 0, imgMissingAlt: 0, hasVideo: false, mixedContent: false, copyrightYear: null,
    // social
    socials: {},
  };
  if (!url) return out;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(13000), headers: { 'User-Agent': 'Mozilla/5.0 (OHM Audit Bot)' } });
    out.reachable = res.ok;
    out.finalUrl = res.url;
    out.redirectsToHttps = res.url.startsWith('https');
    out.https = res.url.startsWith('https');
    const html = (await res.text()).slice(0, 800000);
    const head = html.slice(0, 200000);

    // ----- content / SEO -----
    out.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    out.titleLen = out.title ? out.title.length : 0;
    out.description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || null;
    out.descriptionLen = out.description ? out.description.length : 0;
    out.mobileViewport = /<meta[^>]+name=["']viewport["']/i.test(head);
    out.favicon = /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(head);
    out.ogTitle = /<meta[^>]+property=["']og:title["']/i.test(head);
    out.ogImage = /<meta[^>]+property=["']og:image["']/i.test(head);
    out.canonical = /<link[^>]+rel=["']canonical["']/i.test(head);
    out.schemaLocalBusiness = /("@type"\s*:\s*"(LocalBusiness|Dentist|MedicalBusiness|Restaurant|Attorney|LegalService|HomeAndConstructionBusiness|ProfessionalService|Store|HealthAndBeautyBusiness)"|itemtype=["'][^"']*schema.org\/LocalBusiness)/i.test(html);
    out.h1Count = (html.match(/<h1[\s>]/gi) || []).length;
    const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.wordCount = textOnly ? textOnly.split(' ').length : 0;

    // ----- conversion -----
    out.hasPhone = /href=["']tel:/i.test(html);
    out.hasEmailLink = /href=["']mailto:/i.test(html);
    out.hasForm = /<form/i.test(html);
    out.hasBooking = /(book now|schedule|appointment|calendly|acuity|squareup\.com\/appointments|book online|reserve|request (a )?quote|get (a )?quote)/i.test(html);
    out.hasNewsletter = /(newsletter|subscribe|join (our )?(email|list|mailing)|sign up for)/i.test(html) || /<input[^>]+type=["']email["']/i.test(html);
    out.hasLiveChat = /(intercom|drift\.com|tawk\.to|zendesk|tidio|crisp\.chat|hubspot.*conversations|livechatinc|facebook.*customerchat|messenger.*chat|gorgias|podium)/i.test(html);
    out.hasCta = /(get (a |your )?(free )?(quote|estimate|consultation|audit|demo)|call now|contact us|book (a |your )?|schedule|request )/i.test(html);
    out.napAddress = /\b\d{1,6}\s+[A-Za-z0-9.\s]{3,40}\b(street|st\.?|ave\.?|avenue|road|rd\.?|blvd\.?|drive|dr\.?|lane|ln\.?|way|court|ct\.?|suite|ste\.?|hwy|highway|pkwy|parkway)\b/i.test(textOnly) || /\bGA\s+3\d{4}\b/.test(textOnly);

    // ----- tracking / data -----
    if (/googletagmanager\.com\/gtm|GTM-[A-Z0-9]+/i.test(html)) { out.analytics = true; out.analyticsType = 'Google Tag Manager'; }
    else if (/gtag\(|googletagmanager\.com\/gtag|G-[A-Z0-9]{6,}/i.test(html)) { out.analytics = true; out.analyticsType = 'Google Analytics 4'; }
    else if (/google-analytics\.com\/analytics|ga\('create'|UA-\d{4,}/i.test(html)) { out.analytics = true; out.analyticsType = 'Universal Analytics (legacy)'; }
    out.fbPixel = /connect\.facebook\.net\/[^"']*fbevents|fbq\(/i.test(html);
    out.googleAdsTag = /AW-\d{6,}|googleadservices\.com|google_conversion/i.test(html);

    // ----- media / trust -----
    const imgs = html.match(/<img[^>]*>/gi) || [];
    out.imgCount = imgs.length;
    out.imgMissingAlt = imgs.filter(t => !/alt=["'][^"']+["']/i.test(t)).length;
    out.hasVideo = /(<video|youtube\.com\/embed|player\.vimeo\.com|wistia|<iframe[^>]+youtube)/i.test(html);
    out.mixedContent = out.https && /(src|href)=["']http:\/\/(?!localhost)/i.test(html);
    out.copyrightYear = (html.match(/(?:©|&copy;|copyright)\s*(20\d{2})/i) || [])[1] || null;

    // ----- social -----
    const socialRe = { facebook: /facebook\.com\/[A-Za-z0-9._%-]+/i, instagram: /instagram\.com\/[A-Za-z0-9._%-]+/i,
      tiktok: /tiktok\.com\/@?[A-Za-z0-9._%-]+/i, youtube: /youtube\.com\/[A-Za-z0-9@._%/-]+/i,
      linkedin: /linkedin\.com\/(company|in)\/[A-Za-z0-9._%-]+/i, x: /(twitter\.com|x\.com)\/[A-Za-z0-9._%-]+/i };
    for (const [k, re] of Object.entries(socialRe)) { const m = html.match(re); if (m) out.socials[k] = m[0]; }
  } catch (e) { out.error = e.message; }
  return out;
}

async function runPageSpeed(url) {
  if (!url) return null;
  try {
    const key = process.env.PAGESPEED_KEY ? `&key=${process.env.PAGESPEED_KEY}` : '';
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices${key}`;
    const r = await fetch(api, { signal: AbortSignal.timeout(28000) });
    if (!r.ok) return null;
    const d = await r.json();
    const c = d.lighthouseResult?.categories || {};
    const a = d.lighthouseResult?.audits || {};
    const s = x => x?.score != null ? Math.round(x.score * 100) : null;
    const num = k => a[k]?.numericValue != null ? a[k].numericValue : null;
    // Core Web Vitals + key timings (numericValue in ms, except CLS unitless)
    return {
      performance: s(c.performance), seo: s(c.seo), accessibility: s(c.accessibility), bestPractices: s(c['best-practices']),
      lcp: num('largest-contentful-paint'), cls: num('cumulative-layout-shift'), tbt: num('total-blocking-time'),
      fcp: num('first-contentful-paint'), si: num('speed-index'),
      lcpLabel: a['largest-contentful-paint']?.displayValue || null,
      clsLabel: a['cumulative-layout-shift']?.displayValue || null,
      tbtLabel: a['total-blocking-time']?.displayValue || null,
    };
  } catch { return null; }
}

// ---------- Google Business Profile scan (Places API) ----------
async function scanGBP(business, city) {
  const key = process.env.PLACES_KEY || process.env.GOOGLE_API_KEY || process.env.PAGESPEED_KEY;
  if (!key || !business) return null;
  try {
    const q = encodeURIComponent(`${business} ${city || ''} GA`);
    const find = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${key}`, { signal: AbortSignal.timeout(10000) });
    const fd = await find.json();
    const pid = fd.candidates?.[0]?.place_id;
    if (!pid) return { found: false };
    const fields = 'name,rating,user_ratings_total,opening_hours,website,formatted_phone_number,business_status,types,url,photos,reviews,editorial_summary';
    const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=${fields}&key=${key}`, { signal: AbortSignal.timeout(10000) });
    const dd = await det.json();
    const r = dd.result || {};
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
      status: r.business_status || null, hasDescription: !!r.editorial_summary?.overview, latestReviewDays,
    };
  } catch (e) { return null; }
}

// Build a full pass/fail checklist from the scan so the audit shows everything we looked at.
function buildChecklist(scan, ps, gbp) {
  const socials = Object.keys(scan.socials || {});
  const gbpGroup = gbp && gbp.found ? { group: 'Google Business Profile', items: [
    { label: 'Business profile found on Google', ok: true },
    { label: 'Strong star rating (4.5+)', ok: gbp.rating != null ? gbp.rating >= 4.5 : null, note: gbp.rating != null ? gbp.rating + '/5' : '' },
    { label: 'Healthy review count (50+)', ok: gbp.reviews != null ? gbp.reviews >= 50 : null, note: gbp.reviews != null ? gbp.reviews + ' reviews' : '' },
    { label: 'Getting recent reviews (last 60 days)', ok: gbp.latestReviewDays != null ? gbp.latestReviewDays <= 60 : null, note: gbp.latestReviewDays != null ? gbp.latestReviewDays + ' days ago' : '' },
    { label: 'Business hours listed', ok: gbp.hasHours },
    { label: 'Website linked on profile', ok: gbp.websiteOnGbp },
    { label: 'Phone number on profile', ok: gbp.phoneOnGbp },
    { label: 'Photos on profile', ok: gbp.photos >= 5, note: gbp.photos ? gbp.photos + (gbp.photos >= 10 ? '+' : '') + ' photos' : 'none' },
    { label: 'Business description filled in', ok: gbp.hasDescription },
  ]} : (gbp && gbp.found === false ? { group: 'Google Business Profile', items: [
    { label: 'Business profile found on Google', ok: false, note: 'not found' },
  ]} : null);
  return [
    { group: 'Foundation & Speed', items: [
      { label: 'Secure HTTPS connection', ok: scan.https },
      { label: 'Mobile friendly (responsive viewport)', ok: scan.mobileViewport },
      { label: 'Mobile page speed', ok: ps?.performance != null ? ps.performance >= 50 : null, note: ps?.performance != null ? ps.performance + '/100' : 'n/a' },
      { label: 'Largest Contentful Paint under 2.5s', ok: ps?.lcp != null ? ps.lcp <= 2500 : null, note: ps?.lcpLabel || '' },
      { label: 'Layout stable while loading (CLS)', ok: ps?.cls != null ? ps.cls <= 0.1 : null, note: ps?.clsLabel || '' },
      { label: 'No insecure mixed content', ok: !scan.mixedContent },
    ]},
    { group: 'Getting Found (SEO)', items: [
      { label: 'Page title present and sized right', ok: scan.title ? (scan.titleLen >= 15 && scan.titleLen <= 65) : false, note: scan.title ? scan.titleLen + ' chars' : 'missing' },
      { label: 'Meta description present and sized right', ok: scan.description ? (scan.descriptionLen >= 70 && scan.descriptionLen <= 165) : false, note: scan.description ? scan.descriptionLen + ' chars' : 'missing' },
      { label: 'Single clear H1 headline', ok: scan.h1Count === 1, note: scan.h1Count + ' found' },
      { label: 'Local business schema markup', ok: scan.schemaLocalBusiness },
      { label: 'Canonical tag set', ok: scan.canonical },
      { label: 'Enough content on the page', ok: scan.wordCount >= 300, note: scan.wordCount + ' words' },
    ]},
    ...(gbpGroup ? [gbpGroup] : []),
    { group: 'Turning Visitors Into Leads', items: [
      { label: 'Click to call phone number', ok: scan.hasPhone },
      { label: 'Lead capture form', ok: scan.hasForm },
      { label: 'Online booking / scheduling', ok: scan.hasBooking },
      { label: 'Clear call to action', ok: scan.hasCta },
      { label: 'Live chat', ok: scan.hasLiveChat },
      { label: 'Email / newsletter capture', ok: scan.hasNewsletter },
      { label: 'Address listed (local trust)', ok: scan.napAddress },
    ]},
    { group: 'Tracking & Ad Readiness', items: [
      { label: 'Website analytics installed', ok: scan.analytics, note: scan.analyticsType || '' },
      { label: 'Facebook / Meta pixel (retargeting)', ok: scan.fbPixel },
      { label: 'Google Ads conversion tag', ok: scan.googleAdsTag },
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

async function generateAuditReport(p, scan, ps, gbp, answers) {
  const checklist = buildChecklist(scan, ps, gbp);
  const flat = checklist.flatMap(g => g.items.map(i => `${i.ok === true ? 'PASS' : i.ok === false ? 'FAIL' : 'n/a'} - ${g.group}: ${i.label}${i.note ? ' (' + i.note + ')' : ''}`)).join('\n');
  const prompt = `You are a senior growth strategist at Open Heart Media (OHM). Produce a thorough, elite growth audit for a local business based ONLY on the real scan data below. It must read like a paid consultant did it: specific, researched, and honest. Tie findings to lost leads and revenue. This report is what earns the discovery call, so it must be genuinely valuable and impressively detailed, while keeping the exact HOW of fixing things at a strategic level (name the gap and the opportunity, do not write the full implementation playbook).

BUSINESS: ${p.business || 'this business'}, a ${p.category || 'local business'} in ${p.city || 'their area'}, GA. Google rating ${p.rating || 'n/a'} from ${p.reviews || 'n/a'} reviews.
THEIR STATED GOAL: ${answers.goal || 'more customers'}

FULL TECHNICAL + MARKETING SCAN (real, just run):
GOOGLE PAGESPEED (mobile): ${ps ? JSON.stringify({ performance: ps.performance, seo: ps.seo, accessibility: ps.accessibility, bestPractices: ps.bestPractices, LCP: ps.lcpLabel, CLS: ps.clsLabel, TBT: ps.tbtLabel }) : 'unavailable'}
SITE SIGNALS: ${JSON.stringify({ reachable: scan.reachable, https: scan.https, mobileViewport: scan.mobileViewport, title: scan.title, titleLen: scan.titleLen, metaDescription: scan.description ? 'present (' + scan.descriptionLen + ' chars)' : 'MISSING', h1Count: scan.h1Count, wordCount: scan.wordCount, schemaLocalBusiness: scan.schemaLocalBusiness, canonical: scan.canonical, hasPhone: scan.hasPhone, hasForm: scan.hasForm, hasBooking: scan.hasBooking, hasCta: scan.hasCta, hasLiveChat: scan.hasLiveChat, hasNewsletter: scan.hasNewsletter, napAddress: scan.napAddress, analytics: scan.analyticsType || false, facebookPixel: scan.fbPixel, googleAdsTag: scan.googleAdsTag, hasVideo: scan.hasVideo, images: scan.imgCount, imagesMissingAlt: scan.imgMissingAlt, ogShareTags: scan.ogTitle && scan.ogImage, mixedContent: scan.mixedContent })}
GOOGLE BUSINESS PROFILE (live from Google Places): ${gbp && gbp.found ? JSON.stringify({ rating: gbp.rating, reviews: gbp.reviews, latestReviewDaysAgo: gbp.latestReviewDays, hoursListed: gbp.hasHours, websiteLinked: gbp.websiteOnGbp, phoneListed: gbp.phoneOnGbp, photos: gbp.photos, descriptionFilled: gbp.hasDescription, primaryCategory: gbp.primaryCategory, status: gbp.status }) : (gbp && gbp.found === false ? 'NO GOOGLE BUSINESS PROFILE FOUND (major local visibility gap)' : 'not checked')}
SOCIAL PROFILES LINKED FROM SITE: ${Object.keys(scan.socials).length ? Object.keys(scan.socials).join(', ') : 'NONE detected'}

PASS/FAIL CHECKLIST (already computed, use it to ground your scores):
${flat}

Score each of the six categories 0-100 HONESTLY from the data (a site failing many checks should score low, do not inflate). Base "Local Visibility" mostly on the LIVE Google Business Profile data above (rating, review count and recency versus a typical ${p.category} in ${p.city}, whether hours/website/photos/description are filled, and whether a profile exists at all) plus on-site schema and address. Base "Tracking & Data" on analytics, pixel, and ads tag. For "Social & Content", focus on PRESENCE and OPTIMIZATION, not follower counts (we do not have those): which platforms they are and are not on, whether they have video, and the opportunity to optimize their profiles (complete bios, consistent branding and handles, a clear link in bio, regular posting, and short video content for a ${p.category}). Every "why" must cite specific real findings.

Return ONLY JSON:
{
 "headline": "one specific line, e.g. 'Where ${p.business || 'your business'} is quietly losing customers'",
 "overallVerdict": "one honest sentence summarizing the state of their online presence",
 "categories": [
   {"name": "Website & Speed", "score": <0-100>, "why": "2 sentences citing the real PageSpeed number, HTTPS, mobile, Core Web Vitals"},
   {"name": "Getting Found (SEO)", "score": <0-100>, "why": "2 sentences citing title/meta/schema/H1/content findings"},
   {"name": "Converting Visitors", "score": <0-100>, "why": "2 sentences citing phone, form, booking, CTA, chat findings"},
   {"name": "Local Visibility", "score": <0-100>, "why": "2 to 3 sentences citing the LIVE Google Business Profile data: rating and review count and recency vs a typical ${p.category} in ${p.city}, and whether hours, website, photos, and description are filled in on the profile"},
   {"name": "Tracking & Data", "score": <0-100>, "why": "2 sentences on analytics, Meta pixel, Google Ads tag, and what not tracking costs them"},
   {"name": "Social & Content", "score": <0-100>, "why": "2 to 3 sentences on which platforms they are and are not on, video presence, and the specific opportunity to optimize their profiles (bios, consistent branding, link in bio, posting cadence) for a ${p.category}. Do not mention follower counts."}
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
  report.checklist = checklist;
  report.pagespeed = ps || null;
  return report;
}

// overall growth score = average of the six category scores
function overallScore(report) {
  const cats = report.categories || [];
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
    doc.roundedRect(M, y, CW, 92, 12).fill(NAVY);
    doc.fillColor(scoreColor(overall)).font('Helvetica-Bold').fontSize(50).text(String(overall), M + 26, y + 20, { continued: true }).fillColor('#9fb0cf').fontSize(18).text(' /100');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text('Overall growth score', M + 170, y + 24);
    doc.fillColor('#c1cde3').font('Helvetica').fontSize(10.5).text(report.overallVerdict || (overall >= 70 ? 'Solid foundation with real room to grow.' : overall >= 45 ? 'A working presence that is leaving real money on the table.' : 'Big, fixable gaps are costing you leads right now.'), M + 170, y + 46, { width: CW - 190 });
    y += 112;

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
    nl(90);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Want us to help you close these gaps?', M, y);
    doc.fillColor(BODY).font('Helvetica').fontSize(10.5).text(report.summary || 'Book a free 30 minute discovery call and we will walk through your biggest opportunities and see if we are the right fit.', M, doc.y + 5, { width: CW, lineGap: 1 });
    y = doc.y + 12;
    doc.roundedRect(M, y, 250, 38, 9).fill(RED);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12).text('Book your free discovery call', M, y + 13, { width: 250, align: 'center', link: bookingUrl, underline: false });
    doc.fillColor(MUT).font('Helvetica').fontSize(9).text(bookingUrl, M + 262, y + 15, { width: CW - 262, link: bookingUrl });

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
    <h2 class="reveal">Let's see if we're the right fit.</h2>
    <p class="reveal">Grab a free 30 minute discovery call. We'll get to know your business and be straight about whether what we do lines up with what you need. No pitch, no pressure.</p>
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
       var cats=a.categories||[];
       function cls(v){return v>=70?'sc-good':v>=45?'sc-mid':'sc-bad';}
       function mtr(v){return '<div class="meter"><i style="width:'+Math.max(6,Math.round(v))+'%"></i></div>';}
       function colHex(v){return v>=70?'#3fbf6a':v>=45?'#e0a340':'#df3131';}
       var overall=cats.length?Math.round(cats.reduce(function(s,c){return s+(Number(c.score)||0);},0)/cats.length):0;
       var verdict=a.overallVerdict||(overall>=70?'Solid foundation, real room to grow':overall>=45?'Leaving real money on the table':'Big, fixable gaps costing you leads');
       function scard(v,label){return '<div class="scard '+cls(v)+'"><b>'+v+'<span class="of">/100</span></b><span>'+esc(label)+'</span>'+mtr(v)+'</div>';}
       var scards=cats.map(function(c){return scard(Number(c.score),c.name);}).join('');
       var bd=cats.map(function(c){return '<div class="find"><div class="n" style="background:'+colHex(Number(c.score))+'">'+c.score+'</div><div><h3>'+esc(c.name)+'  <span style="color:#8fa0bd;font-weight:600;font-size:14px">'+c.score+'/100</span></h3><p>'+esc(c.why||'')+'</p></div></div>';}).join('');
       // full scanned checklist
       function markSym(ok){return ok===true?'<span style="color:#3fbf6a;font-weight:800">&#10003;</span>':ok===false?'<span style="color:#ff6a6a;font-weight:800">&#10007;</span>':'<span style="color:#8fa0bd">&#8211;</span>';}
       var checklist=(a.checklist||[]).map(function(g){
         var items=g.items.map(function(it){return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14px"><span style="width:16px;text-align:center">'+markSym(it.ok)+'</span><span style="flex:1;color:#dbe2ef">'+esc(it.label)+'</span>'+(it.note?'<span style="color:#8fa0bd;font-size:12px">'+esc(it.note)+'</span>':'')+'</div>';}).join('');
         return '<div style="margin-top:16px"><div style="font-weight:700;color:#fff;font-size:13px;margin-bottom:4px">'+esc(g.group)+'</div>'+items+'</div>';
       }).join('');
       var findings=(a.findings||[]).map(function(f,i){var ic=f.impact==='High'?'#df3131':f.impact==='Medium'?'#e0a340':'#8fa0bd';return '<div class="find"><div class="n">'+(i+1)+'</div><div><h3>'+esc(f.title)+(f.impact?' <span style="font-size:11px;font-weight:700;color:#fff;background:'+ic+';padding:2px 7px;border-radius:20px;vertical-align:middle">'+esc(f.impact).toUpperCase()+'</span>':'')+'</h3><p>'+esc(f.detail)+'</p></div></div>';}).join('');
       var quick=(a.quickWins||[]).map(function(q){return '<li style="margin-bottom:8px;color:#c7d0e0">'+esc(q)+'</li>';}).join('');
       var html='<div class="inner">'
        +'<div class="rhead"><img class="rlogo" src="/media/logo-white.png" alt="Open Heart Media"/><div class="rtag">Growth Audit · '+esc(biz)+'</div></div>'
        +'<div class="ctitle" style="color:var(--ink)">'+esc(a.headline||'Where you are leaving leads on the table')+'</div>'
        +'<div class="grade"><div class="gbig">'+overall+'<span>/100</span></div><div class="glabel"><b>Overall growth score</b><span>'+esc(verdict)+'</span></div></div>'
        +'<div class="scoregrid">'+scards+'</div>'
        +'<div class="fhead">Score breakdown</div>'+bd
        +'<div class="fhead" style="margin-top:22px">Everything we scanned</div>'+checklist
        +'<div class="fhead" style="margin-top:26px">What is costing you leads</div>'+findings
        +(quick?'<div class="fhead" style="margin-top:22px">Quick wins</div><ul style="margin:8px 0 0;padding-left:20px">'+quick+'</ul>':'')
        +'<div class="est"><b>The upside: </b>'+esc(a.estimate||'')+'</div>'
        +'<a class="btn" id="rbook" href="#book" style="max-width:360px;margin:28px auto 0;text-decoration:none">Book my free discovery call</a></div>';
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
// Prospect-facing routes stay open: the landing page, its live-scan audit submit, tracking
// beacon, and the Calendly webhook. Everything else needs the team login cookie.
const PUBLIC_PATHS = ['/go', '/api/audit', '/api/track', '/api/calendly-webhook', '/login', '/api/login', '/api/logout', '/api/ps-debug'];
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
const TEAM = (process.env.TEAM || 'Zac,Michelle,Brad,Griffin').split(',').map(s => s.trim()).filter(Boolean);

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

// TEMP diagnostic: shows why PageSpeed is or is not returning data (no key leak).
app.get('/api/ps-debug', async (req, res) => {
  const url = req.query.url || 'https://example.com';
  const key = process.env.PAGESPEED_KEY || '';
  const t0 = Date.now();
  try {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance${key ? '&key=' + key : ''}`;
    const r = await fetch(api, { signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    let errMsg = null; try { errMsg = JSON.parse(body)?.error?.message || null; } catch {}
    res.json({ pagespeedKeyPresent: !!key, placesKeyPresent: !!(process.env.PLACES_KEY), httpStatus: r.status, ok: r.ok, tookMs: Date.now() - t0, googleError: errMsg, snippet: body.slice(0, 200) });
  } catch (e) { res.json({ pagespeedKeyPresent: !!key, tookMs: Date.now() - t0, fetchError: e.message }); }
});

// THE living landing page — one URL for everyone. ?ref=<prospectId> for attribution.
app.get('/go', (req, res) => {
  res.send(renderLandingPage(req.query.ref));
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
  const text = `Hi,\n\nHere is your free growth audit for ${business || 'your business'}, attached as a PDF.\n\nYour overall growth score came in at ${overall} out of 100. The biggest thing costing you leads right now: ${report.findings?.[0]?.title || 'a few fixable gaps'}.\n\nWant us to help you close these gaps? Grab a free 30 minute discovery call here:\n${bookingUrl}\n\nZac\nOpen Heart Media`;
  try {
    await sgMail.send({ to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
      subject: `your growth audit for ${business || 'your business'}`, text,
      attachments: [{ content: pdf.toString('base64'), filename: 'growth-audit.pdf', type: 'application/pdf', disposition: 'attachment' }] });
  } catch (e) { console.error('[audit-email]', e.message); }
}

// Run the live scan + audit when a prospect fills out the form.
// TEST MODE: pass {"test": true}. Nothing is emailed to the prospect, no team blast,
// no prospect record is touched. If AUDIT_TEST_EMAIL is set, a single copy goes only there.
app.post('/api/audit', async (req, res) => {
  const { ref, email, goal, website, test } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  const isTest = test === true || test === 'true';
  const p = !isTest && ref && prospects.find(x => x.id === ref);
  const lookup = isTest && ref && prospects.find(x => x.id === ref); // for test GBP/name only, no writes
  const site = website || (p && p.website) || (lookup && lookup.website) || '';
  const bizName = (p && p.business) || (lookup && lookup.business) || null;
  const bizCity = (p && p.city) || (lookup && lookup.city) || null;
  try {
    const scan = await scanWebsite(site);
    const [ps, gbp] = await Promise.all([
      runPageSpeed(scan.finalUrl || scan.url),
      scanGBP(bizName, bizCity),
    ]);
    const report = await generateAuditReport(p || lookup || {}, scan, ps, gbp, { goal });
    const bookingUrl = `${CALENDLY}?utm_content=${p?.id || ''}`;
    let pdf = null;
    try { pdf = await buildAuditPDF(bizName || 'your business', report, bookingUrl); } catch (e) { console.error('[pdf]', e.message); }

    if (isTest) {
      // Only email a copy to the internal test address (Zac), never the team or the prospect.
      const testTo = process.env.AUDIT_TEST_EMAIL || 'zac@openheartmediaco.com';
      if (pdf && process.env.SENDGRID_API_KEY) { try { await sendAuditToProspect(testTo, bizName, report, pdf, bookingUrl); } catch (e) {} }
      return res.json({ test: true, emailedTo: (pdf && process.env.SENDGRID_API_KEY) ? testTo : null, report, business: bizName });
    }

    if (p) {
      p.audit_email = email; p.audit_goal = goal || null; p.audit_report = report;
      p.audit_scan = { pagespeed: ps, gbp, socials: scan.socials, reachable: scan.reachable };
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
