/* OHM lead capture. One tag per client site:
   <script src="https://app.openheartmediaco.com/capture.js?key=CLIENT_FORM_KEY" async></script>   (data-key="..." also works)
   - Saves Google and Meta click IDs and UTM tags for 90 days (first and last touch).
   - When a visitor submits a form, sends name, phone, email, address and message plus those tags to the lead bank.
   - Never reads password, card or ID fields. Never blocks or changes the form. */
(function () {
  try {
    var s = document.currentScript || document.querySelector('script[src*="capture.js"]');
    // Tag managers can drop data-* attributes when they inject a script, so the key may also ride on the URL (?key=...).
    var key = s && (s.getAttribute('data-key') || new URL(s.src).searchParams.get('key')); if (!key) return;
    var endpoint = (s.getAttribute('data-endpoint') || new URL(s.src).origin + '/f/') + (s.getAttribute('data-endpoint') ? '' : key);
    var KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var ST = 'ohm_attr', DAYS = 90;
    function load() { try { return JSON.parse(localStorage.getItem(ST) || '{}'); } catch (e) { return {}; } }
    function save(o) { try { localStorage.setItem(ST, JSON.stringify(o)); } catch (e) {} }
    // 1. remember where the visitor came from
    var q = new URLSearchParams(location.search), found = {}, any = false;
    KEYS.forEach(function (k) { if (q.get(k)) { found[k] = q.get(k).slice(0, 300); any = true; } });
    var st = load(), now = Date.now();
    if (st.at && now - st.at > DAYS * 864e5) st = {};
    if (any) { st.last = found; if (!st.first) st.first = found; st.at = now; save(st); }
    function attribution() { var a = Object.assign({}, st.first || {}, st.last || {}); if (st.first && st.first.gclid && !a.gclid) a.gclid = st.first.gclid; return a; }
    // 2. read a form
    var SKIP = /pass|card|cvv|ssn|social|routing|account.?num|secret|token|captcha|bot-field|honeypot/i;
    function label(el) {
      var t = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '';
      if (!t && el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) t = l.textContent; }
      return String(t || '').trim().slice(0, 60);
    }
    function collect(root) {
      var out = {}, els = root.querySelectorAll('input,textarea,select');
      for (var i = 0; i < els.length; i++) {
        var el = els[i], type = (el.type || '').toLowerCase();
        if (['password', 'hidden', 'submit', 'button', 'file', 'checkbox', 'radio'].indexOf(type) > -1 && !(el.checked && (type === 'checkbox' || type === 'radio'))) continue;
        var lab = label(el), v = (el.value || '').trim(); if (!v || !lab || SKIP.test(lab)) continue;
        out[lab] = v.slice(0, 500);
      }
      return out;
    }
    function map(raw) {
      var r = { first_name: '', last_name: '', name: '', phone: '', email: '', address: '', message: '' }, extra = {};
      Object.keys(raw).forEach(function (k) {
        var v = raw[k], kl = k.toLowerCase();
        if (/e-?mail/.test(kl) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) r.email = r.email || v;
        else if (/phone|mobile|tel/.test(kl)) r.phone = r.phone || v;
        else if (/first/.test(kl)) r.first_name = r.first_name || v;
        else if (/last|surname/.test(kl)) r.last_name = r.last_name || v;
        else if (/^name$|full.?name|your name/.test(kl)) r.name = r.name || v;
        else if (/address|street|city|zip|postal/.test(kl)) r.address = r.address ? r.address + ', ' + v : v;
        else if (/message|comment|note|details|how can|tell us|question|describe/.test(kl)) r.message = r.message || v;
        else extra[k] = v;
      });
      r.extra = extra; return r;
    }
    var sent = {};
    function send(root, why, pre) {
      var data = pre || map(collect(root)), digits = (data.phone || '').replace(/\D/g, '');
      var valid = digits.length >= 10 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email);
      if (!valid) return;
      var id = digits || data.email; if (sent[id] && now2() - sent[id] < 15000) return; sent[id] = now2();
      var a = attribution(), body = Object.assign({}, a, data, {
        page_url: location.href.split('#')[0], referrer: document.referrer || '', form_name: why || 'website-form'
      });
      var json = JSON.stringify(body);
      try { if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
      try { fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }); } catch (e) {}
    }
    function now2() { return Date.now(); }
    function rootOf(el) { return el.closest('form') || el.closest('[role="form"]') || el.closest('section') || el.closest('[data-testid*="form" i]') || el.parentElement; }
    var stash = {};
    // WPForms submits by ajax. A native submit event fires even when validation or reCAPTCHA fails, so skip it for WPForms
    // and send once, after WPForms reports success, using the values captured when Submit was clicked.
    document.addEventListener('submit', function (e) { try { if (e.target && e.target.classList && e.target.classList.contains('wpforms-form')) { stash[e.target.id || 'wpf'] = map(collect(e.target)); return; } send(e.target, 'form-submit'); } catch (x) {} }, true);
    (function hookWpforms(tries) {
      var jq = window.jQuery;
      if (!jq) { if (tries < 40) setTimeout(function () { hookWpforms(tries + 1); }, 250); return; }
      jq(document).on('wpformsAjaxSubmitSuccess', function (e) {
        try { var f = e.target && e.target.closest ? e.target.closest('form') : null; var id = (f && f.id) || 'wpf'; send(f || document.body, 'wpforms-success', stash[id] || (f ? map(collect(f)) : null)); } catch (x) {}
      });
    })(0);
    document.addEventListener('click', function (e) {
      try {
        var b = e.target.closest && e.target.closest('button,[role="button"],input[type="submit"],a[role="button"]'); if (!b) return;
        var txt = (b.textContent || b.value || b.getAttribute('aria-label') || '').toLowerCase();
        if (!/submit|send|request|get started|book|contact|schedule|sign up|subscribe/.test(txt)) return;
        var root = rootOf(b); if (!root) return;
        if (!root.querySelector('input:not([type=hidden]),textarea')) return;
        if (root.classList && root.classList.contains('wpforms-form')) { stash[root.id || 'wpf'] = map(collect(root)); return; }   // sent on success below
        setTimeout(function () { try { send(root, 'button-click'); } catch (x) {} }, 50);
      } catch (x) {}
    }, true);
  } catch (e) {}
})();
