/* Open Heart Media CRM: Home, Clients, Onboarding pages. Loaded after the outreach script. */
(function () {
  var HQ = { data: null, onb: null, loading: false, me: null, mail: null, mailLoading: false, cal: null, calLoading: false, tasks: [], cw: null, workTab: '', ctab: 'overview', ctabSlug: '', brain: {}, facts: {}, packs: {}, packWeek: {}, hols: {}, copy: {}, shots: {}, working: {}, shotSel: {}, content: {}, guides: null, guideDoc: {} };
  var COLORS = ['#2f6fd0', '#e22a24', '#17935f', '#6552d1', '#c98a0b', '#0f7c8c', '#c2185b', '#455a9c'];
  // One icon family: 24px grid, 1.8 stroke, round caps.
  // Icons: Lucide (ISC license), 24px grid, round caps and joins.
  var P = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
    task: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
    kanban: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    circle: '<circle cx="12" cy="12" r="10"/>',
    edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    team: '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
  };
  var ALIAS = { '\u25A3': 'home', '\u2726': 'building', '\u2709': 'clipboard', '\u25A6': 'kanban', '\u{1F381}': 'gift', '\u271A': 'plus', '\u260E': 'phone', '\u2605': 'star', '\u21A9': 'reply', '\u2713': 'task', '\u2691': 'flag', '\u2261': 'list', '\u25CB': 'circle', '\u270E': 'edit', '\u2298': 'ban', '\u2715': 'x' };
  function ico(n, cls) { return '<svg class="ico ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || '') + '</svg>'; }
  window.hqIcon = function (n) { n = ALIAS[n] || n; return P[n] ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + P[n] + '</svg>' : null; };

  function brand(c) { return (c && c.color) || hue((c && c.name) || ''); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function ini(n) { var w = String(n).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + ((w[1] || '')[0] || (w[0] || '')[1] || '')).toUpperCase(); }
  function e(s) { return esc(s == null ? '' : String(s)); }
  function dshort(d) { if (!d) return ''; return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  var STATUS = { active: 'Active', ending: 'Ending', seasonal: 'Seasonal', ads_off: 'Ads off', onboarding: 'Onboarding', internal: 'Ours', returning: 'Returning', proposal: 'Proposal' };
  var KIND = { retainer: 'Retainer', website: 'Website', returning: 'Returning', proposal: 'Pending' };
  var clientTab = 'all';
  function root() { return document.getElementById('hq'); }

  function health(c) {
    if (!c.work) return { k: '', t: c.syncing ? 'Syncing' : 'Not synced', col: '#bcc5d3' };
    if (!c.work.linked) return { k: '', t: 'Not linked', col: '#bcc5d3' };
    if (c.work.overdue > 0) return { k: 'red', t: c.work.overdue + ' late', col: '#d6342d' };
    return { k: 'green', t: c.work.open ? 'On track' : 'All clear', col: '#17935f' };
  }
  function progress(c) {
    if (!c.work || !c.work.lists) return 0; var done = 0, tot = 0;
    c.work.lists.forEach(function (l) { var m = /(\d+)\/(\d+)/.exec(l.ratio || ''); if (m) { done += +m[1]; tot += +m[2]; } });
    return tot ? Math.round(done / tot * 100) : 0;
  }
  function avatar(c, size) {
    var h = health(c), p = progress(c), circ = 2 * Math.PI * 24, off = circ * (1 - p / 100);
    return '<div class="avr"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') + '><svg viewBox="0 0 56 56"><circle class="tr" cx="28" cy="28" r="24"/><circle class="pg" cx="28" cy="28" r="24" stroke="' + h.col + '" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (c.work && c.work.linked ? off.toFixed(1) : circ.toFixed(1)) + '"/></svg>' +
      (c.logo ? '<div class="av lg" style="background-image:url(' + e(c.logo) + ')"></div>' : '<div class="av" style="background:' + hue(c.name) + '">' + e(ini(c.name)) + '</div>') + '</div>';
  }
  function card(c, i) {
    var h = health(c), w = c.work;
    return '<a class="cl" tabindex="0" style="--bc:' + e(brand(c)) + ';animation-delay:' + Math.min(i || 0, 12) * 35 + 'ms" onclick="hqNav(\'hq:client:' + e(c.slug) + '\')" onkeydown="if(event.key===\'Enter\')hqNav(\'hq:client:' + e(c.slug) + '\')">' +
      '<div class="cl-top">' + avatar(c) +
      '<div style="min-width:0"><div class="cl-name">' + e(c.name) + '</div><div class="cl-sub">' + e(c.note || (c.services || []).join(' · ') || (KIND[c.kind] || 'Client')) + '</div></div>' +
      '<div style="margin-left:auto" class="hl ' + h.k + '"><i></i>' + e(h.t) + '</div></div>' +
      '<div class="chips"><span class="chip st-' + e(c.status) + '">' + e(STATUS[c.status] || c.status) + '</span>' +
      (KIND[c.kind] && c.kind !== 'retainer' ? '<span class="chip">' + e(KIND[c.kind]) + '</span>' : '') + (c.status === 'onboarding' && !(c.onboarding && c.onboarding.count) ? '<span class="chip need">Waiting on onboarding form</span>' : '') + '</div>' +
      (w && w.linked ? '<div class="cl-foot"><span><b>' + w.open + '</b>open</span><span class="od"><b>' + w.overdue + '</b>late</span>' + (w.nextDue ? '<span style="margin-left:auto">Next <b style="font-size:13px">' + e(dshort(w.nextDue)) + '</b></span>' : '') + '</div>' : '') +
      '</a>';
  }
  function gauge(pct, label, color) {
    var circ = 2 * Math.PI * 44, off = circ * (1 - Math.max(0, Math.min(100, pct || 0)) / 100);
    return '<div class="gauge"><div class="ring"><svg viewBox="0 0 104 104"><circle class="tr" cx="52" cy="52" r="44"/><circle class="pg" cx="52" cy="52" r="44" stroke="' + color + '" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg><div class="num">' + (pct == null ? '-' : Math.round(pct) + '%') + '</div></div><span>' + e(label) + '</span></div>';
  }

  async function fetchHq(force) {
    if (HQ.loading) return; HQ.loading = true;
    try { if (force) await fetch('/api/hq/refresh'); HQ.data = await api('/api/hq'); if (HQ.data.clients.some(function (c) { return c.syncing; }) && (HQ.syncTries = (HQ.syncTries || 0) + 1) <= 30) setTimeout(function () { HQ.data = null; fetchHq(false).then(function () { if (document.body.classList.contains('hqmode')) show(navKey); }); }, 7000); else HQ.syncTries = 0; HQ.onb = (await api('/api/onboarding')).responses || []; try { HQ.me = await api('/api/me'); } catch (x) {} try { HQ.tasks = (await api('/api/tasks')).tasks || []; } catch (x) { HQ.tasks = []; } }
    catch (err) { HQ.err = err.message; }
    HQ.loading = false;
  }
  function firstName() { return HQ.me && !HQ.me.legacy && HQ.me.name ? String(HQ.me.name).split(' ')[0] : ''; }
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function skeleton() { return '<div class="sk" style="height:210px;margin-bottom:16px"></div><div class="bento"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>'; }
  function tile(l, v, s, icon, cls) { return '<div class="tile rise ' + cls + '"><div class="chipi">' + ico(icon) + '</div><div class="l">' + e(l) + '</div><div class="v">' + e(v) + '</div><div class="s">' + e(s) + '</div></div>'; }

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function allWork(d) {
    var today = todayStr(), rows = [];
    (HQ.tasks || []).forEach(function (t) {
      var c = d.clients.filter(function (x) { return x.slug === t.client; })[0];
      rows.push({ k: 'crm', id: t.id, title: t.title, client: c ? c.name : '', who: t.owner_name, ownerId: t.owner, due: t.due, dueTime: t.due_time, overdue: !!(t.due && t.due < today && t.status !== 'done'), done: t.status === 'done', src: t.source || {}, auto: t.auto });
    });
    d.clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.forEach(function (t) { rows.push({ k: 'bc', title: t.title, client: c.name, who: t.who, due: t.due, overdue: t.overdue, url: t.url, done: false }); }); }); });
    return rows;
  }
  function isMine(x) {
    var me = HQ.me, fn = (firstName() || '').toLowerCase();
    if (x.k === 'crm') return !!(me && x.ownerId === me.id);
    return !!(fn && String(x.who || '').toLowerCase().indexOf(fn) > -1);
  }
  function myTasks(d) { var all = allWork(d).filter(function (x) { return !x.done; }); return { all: all.map(function (x) { return { t: x, c: { name: x.client } }; }), mine: all.filter(isMine).map(function (x) { return { t: x, c: { name: x.client } }; }) }; }
  function sc(title, icon, big, sub, rows, go, tone) {
    return '<a class="sc ' + (tone || '') + '" tabindex="0" onclick="' + go + '" onkeydown="if(event.key===\'Enter\'){' + go + '}"><div class="sh"><span class="si">' + ico(icon) + '</span><span class="st">' + e(title) + '</span><span class="sa">' + ico('arrow') + '</span></div>' +
      '<div class="sbig">' + e(big) + '</div><div class="ssub">' + e(sub) + '</div>' +
      (rows && rows.length ? '<div class="srows">' + rows.slice(0, 3).map(function (r) { return '<div class="sr"><i class="' + (r[1] || '') + '"></i><span>' + e(r[0]) + '</span></div>'; }).join('') + '</div>' : '') + '</a>';
  }
  async function loadCal() {
    if (!HQ.me || HQ.me.legacy || HQ.calLoading || HQ.cal) return;
    HQ.calLoading = true;
    try { HQ.cal = await api('/api/me/calendar'); } catch (er) { HQ.cal = { connected: false, error: er.message }; }
    HQ.calLoading = false;
  }
  function evDate(x) { return x.allDay ? new Date(String(x.start).slice(0, 10) + 'T12:00:00') : new Date(x.start); }
  function dayLabel(d) {
    var t = new Date(); t.setHours(0, 0, 0, 0); var x = new Date(d); x.setHours(0, 0, 0, 0); var diff = Math.round((x - t) / 864e5);
    if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow';
    return x.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function agenda() {
    var c = HQ.cal, me = HQ.me, view = HQ.calView || 'two';
    var seg = '<div class="seg"><button class="' + (view === 'two' ? 'on' : '') + '" onclick="hqCalView(\'two\')">Next 2 days</button><button class="' + (view === 'week' ? 'on' : '') + '" onclick="hqCalView(\'week\')">This week</button></div>';
    var head = '<div class="ph2"><h3>' + ico('calendar') + 'Schedule</h3>' + seg + '<span class="acts2"><a class="ib" title="Choose calendars" onclick="hqCalPick()">' + ico('sliders') + '</a><a class="ib" title="Open Google Calendar" href="https://calendar.google.com" target="_blank" rel="noopener">' + ico('external') + '</a></span></div>' +
      (HQ.calPick && c && c.calendars ? '<div class="calpick">' + c.calendars.map(function (k) { return '<label class="cb"><input type="checkbox" ' + (k.hidden ? '' : 'checked') + ' onchange="hqCalToggle()" data-cid="' + e(k.id) + '"> <i style="background:' + e(k.color || '#999') + '"></i> ' + e(k.name) + '</label>'; }).join('') + '</div>' : '');
    var wrap = function (b) { return '<div class="panel agenda">' + head + b + '</div>'; };
    if (!me || me.legacy) return wrap('<div class="empty">' + ico('calendar') + 'Sign in with your own email to see your calendar.</div>');
    if (!c) return wrap('<div class="sk" style="height:150px"></div>');
    if (!c.connected) return wrap('<div class="empty">' + ico('calendar') + 'Connect your Google account to see meetings and shoots here.<br><br><a class="btn2 red" href="/api/me/gmail/connect">Connect Google</a></div>');
    if (c.needsCalendar) return wrap('<div class="empty">' + ico('alert') + (c.apiOff ? 'Google Calendar is not turned on for this project yet. In Google Cloud, open APIs & Services, then Library, search Google Calendar API and click Enable.' : 'Calendar access was not granted. On the Mail page click Disconnect, then connect Google again and allow the calendar permission.') + '</div>');
    if (c.error) return wrap('<div class="empty">' + ico('alert') + e(c.error) + '</div>');
    var ev = c.events || [], today = new Date(); today.setHours(0, 0, 0, 0);
    var sameDay = function (x, d) { var a = evDate(x); return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth() && a.getDate() === d.getDate(); };
    var row = function (x) {
      var tm = x.allDay ? 'All day' : evDate(x).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', ' ');
      return '<a class="ag" href="' + e(x.link) + '" target="_blank" rel="noopener"><span class="at' + (x.allDay ? ' ad' : '') + '">' + e(tm) + '</span><i style="background:' + e(x.color || '#13233f') + '"></i><span class="an">' + e(x.title) + '</span><span class="ap">' + e(x.project || '') + '</span></a>';
    };
    if (view === 'week') {
      var mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); if (today.getDay() === 0 || today.getDay() === 6) mon.setDate(mon.getDate() + 7);
      var cols = '';
      for (var k = 0; k < 7; k++) {
        var d = new Date(mon); d.setDate(mon.getDate() + k);
        var list = ev.filter(function (x) { return sameDay(x, d); });
        if (k >= 5 && !list.length) continue;
        var isT = d.getTime() === today.getTime();
        cols += '<div class="wk' + (isT ? ' today' : '') + '"><div class="wh2"><b>' + d.toLocaleDateString('en-US', { weekday: 'short' }) + '</b><span>' + d.getDate() + '</span>' + (list.length ? '<em>' + list.length + '</em>' : '') + '</div>' +
          (list.length ? list.slice(0, 4).map(function (x) { return '<a class="wv" href="' + e(x.link) + '" target="_blank" rel="noopener" style="--ec:' + e(x.color || '#13233f') + '"><span>' + e(x.allDay ? 'All day' : evDate(x).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', ' ')) + '</span>' + e(x.title) + '</a>'; }).join('') + (list.length > 4 ? '<div class="wm">+' + (list.length - 4) + ' more</div>' : '') : '<div class="wn">Clear</div>') + '</div>';
      }
      return wrap('<div class="wkgrid">' + cols + '</div>');
    }
    var tom = new Date(today), out = ''; tom.setDate(tom.getDate() + 1);
    [[today, 'Today'], [tom, 'Tomorrow']].forEach(function (p) {
      var list = ev.filter(function (x) { return sameDay(x, p[0]); }).sort(function (a, b) { return (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0); });
      out += '<div class="dsec"><div class="dh"><b>' + p[1] + '</b><span>' + p[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</span></div>' +
        (list.length ? list.slice(0, 5).map(row).join('') + (list.length > 5 ? '<a class="ag more" onclick="hqCalView(\'week\')">+' + (list.length - 5) + ' more, see the week</a>' : '') : '<div class="dn2">Nothing scheduled</div>') + '</div>';
    });
    return wrap('<div class="dgrid">' + out + '</div>');
  }
  window.hqCalView = function (v) { HQ.calView = v; var el = root(); if (el && navKey === 'hq:home') el.innerHTML = home(); };
  window.hqCalPick = function () { HQ.calPick = !HQ.calPick; var el = root(); if (el && document.body.classList.contains('hqmode')) el.innerHTML = home(); };
  window.hqCalToggle = async function () {
    var hidden = []; document.querySelectorAll('.calpick input').forEach(function (i) { if (!i.checked) hidden.push(i.getAttribute('data-cid')); });
    try { await api('/api/me/calendar/prefs', 'POST', { hidden: hidden }); HQ.cal = null; await loadCal(); var el = root(); if (navKey === 'hq:home') el.innerHTML = home(); } catch (er) { toast(er.message); }
  };
  function stat(title, icon, big, sub, go, tone) {
    return '<a class="st ' + (tone || '') + '" tabindex="0" onclick="' + go + '" onkeydown="if(event.key===\'Enter\'){' + go + '}"><span class="si">' + ico(icon) + '</span><div><div class="sv">' + e(big) + '</div><div class="sl">' + e(title) + '</div><div class="ss">' + e(sub) + '</div></div><span class="sa">' + ico('arrow') + '</span></a>';
  }
  function home() {
    var d = HQ.data, Pr = state.prospects || [], me = HQ.me, fn = firstName();
    var clients = d.clients.filter(function (c) { return c.status !== 'internal'; });
    var activeC = clients.filter(function (c) { return ['active', 'onboarding', 'ads_off', 'seasonal', 'ending'].indexOf(c.status) > -1; });
    var tasks = myTasks(d), late = tasks.all.filter(function (x) { return x.t.overdue; }), mine = tasks.mine, mineLate = mine.filter(function (x) { return x.t.overdue; });
    var replies = Pr.filter(function (p) { return typeof needsResponse === 'function' && needsResponse(p); });
    var mm = HQ.mail;
    var att = [];
    late.slice(0, 5).forEach(function (x) { att.push('<div class="item"><div class="bub">' + ico('alert') + '</div><div><b>' + e(x.t.title) + '</b><div class="m">' + e(x.c.name) + ' · ' + e(x.t.who || 'Unassigned') + ' · due ' + e(dshort(x.t.due)) + ' · ' + (x.t.url ? '<a href="' + e(x.t.url) + '" target="_blank" rel="noopener">Open</a>' : '<a onclick="hqNav(\'hq:work\')">Open</a>') + '</div></div></div>'); });
    replies.slice(0, 3).forEach(function (p) { att.push('<div class="item"><div class="bub amber">' + ico('reply') + '</div><div><b>' + e(p.business) + ' replied</b><div class="m">Outreach · <a onclick="navTo(\'replied\')">Open</a></div></div></div>'); });
    if (mm && mm.connected && mm.unread) att.push('<div class="item"><div class="bub blue">' + ico('mail') + '</div><div><b>' + mm.unread + ' unread from clients</b><div class="m"><a onclick="hqNav(\'hq:mail\')">Open mail</a></div></div></div>');
    if (d.onboardingNoProject) att.push('<div class="item"><div class="bub blue">' + ico('clipboard') + '</div><div><b>' + d.onboardingNoProject + ' new onboarding form' + (d.onboardingNoProject > 1 ? 's' : '') + '</b><div class="m"><a onclick="hqNav(\'hq:onboarding\')">Review</a></div></div></div>');
    var sub = !d.connected ? 'Connect Basecamp to see everyone\'s work.' : (fn && mine.length ? mine.length + ' to-do' + (mine.length > 1 ? 's' : '') + ' assigned to you' + (mineLate.length ? ', ' + mineLate.length + ' late' : '') : late.length ? late.length + ' late across clients' : 'You are all caught up.');
    var strip = clients.map(function (c) {
      return '<a class="lg-t" tabindex="0" style="--bc:' + e(brand(c)) + '" onclick="hqNav(\'hq:client:' + e(c.slug) + '\')" title="' + e(c.name) + '">' + avatar(c, 54) + '<span>' + e(c.name) + '</span></a>';
    }).join('');
    return '<div class="hero3 rise"><div class="hmain"><div class="eyebrow3">' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>' +
      '<h2>' + greeting() + (fn ? ', ' + e(fn) : '') + '</h2><p>' + e(sub) + '</p></div><div class="hbtn">' +
      (d.connected ? '' : '<a class="btn2 red" href="/api/basecamp/connect">' + ico('link') + 'Connect Basecamp</a>') +
      '<button class="btn2 glass" onclick="hqRefresh()" aria-label="Refresh">' + ico('refresh') + 'Refresh</button></div></div>' +
      '<div class="stats">' +
      stat(fn ? 'My work' : 'Open work', 'task', fn ? mine.length : tasks.all.length, mineLate.length ? mineLate.length + ' late' : 'open to-dos', "hqNav('hq:work')", mineLate.length ? 'bad' : '') +
      stat('Late', 'alert', d.connected ? late.length : '-', 'across all clients', "hqNav('hq:work')", late.length ? 'bad' : 'ok') +
      stat('Client mail', 'mail', mm && mm.connected ? (mm.unread || 0) : '-', mm && mm.connected ? 'unread' : 'not connected', "hqNav('hq:mail')", mm && mm.connected && mm.unread ? 'warn' : '') +
      stat('Clients', 'users', activeC.length, 'active now', "hqNav('hq:clients')") +
      (me && me.pipeline ? stat('Outreach', 'kanban', replies.length, replies.length === 1 ? 'reply waiting' : 'replies waiting', "hqNav('hq:outreach')", replies.length ? 'warn' : '') : '') + '</div>' +
      '<div class="hcols">' + agenda() + '<div class="panel"><h3>Needs attention' + (att.length ? '<span class="ct">' + att.length + '</span>' : '') + '</h3>' +
      (att.length ? att.join('') : '<div class="empty">' + ico('check') + 'All clear. Nothing needs you.</div>') + '</div></div>' +
      '<div class="sec" style="margin-top:26px"><div><h3>Your clients</h3></div><a class="lnk" onclick="hqNav(\'hq:clients\')">See all</a></div><div class="lgrid">' + strip + '</div>';
  }

  function work() {
    var d = HQ.data, me = HQ.me, f = HQ.workTab || (me && !me.legacy ? 'mine' : 'all'), all = allWork(d), rows;
    if (f === 'done') rows = all.filter(function (x) { return x.done; });
    else { rows = all.filter(function (x) { return !x.done; }); if (f === 'mine') rows = rows.filter(isMine); if (f === 'late') rows = rows.filter(function (x) { return x.overdue; }); }
    rows.sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; });
    var tab = function (k, l) { return '<button class="tb ' + (f === k ? 'on' : '') + '" onclick="HQ_work(\'' + k + '\')">' + l + '</button>'; };
    var real = me && !me.legacy, isAdmin = me && me.role === 'admin';
    var clientsOpt = d.clients.filter(function (c) { return c.status !== 'internal'; }).map(function (c) { return '<option value="' + e(c.slug) + '">' + e(c.name) + '</option>'; }).join('');
    var ownerSel = isAdmin && HQ.users ? '<select id="nt_o">' + HQ.users.filter(function (u) { return u.active; }).map(function (u) { return '<option value="' + e(u.id) + '"' + (u.id === me.id ? ' selected' : '') + '>' + e(u.name) + '</option>'; }).join('') + '</select>' : '';
    var form = real ? '<details class="sm" style="margin-bottom:14px"><summary>Add a task</summary><div class="frm" style="margin-top:12px;grid-template-columns:2fr 1.2fr 1fr ' + (ownerSel ? '1fr ' : '') + 'auto"><div><label for="nt_t">What needs doing</label><input id="nt_t" placeholder="e.g. Send Crocker the shoot schedule"></div>' +
      '<div><label for="nt_c">Client</label><select id="nt_c"><option value="">No client</option>' + clientsOpt + '</select></div><div><label for="nt_d">Due</label><input id="nt_d" type="date"></div>' + (ownerSel ? '<div><label for="nt_o">Assign to</label>' + ownerSel + '</div>' : '') +
      '<button class="btn2 red" onclick="hqAddTask()">Add</button></div></details>' : '';
    var total = all.filter(function (x) { return !x.done; }).length;
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Work</h3><p>Your tasks, client emails that need a reply, and to-dos from Basecamp.</p></div>' + (real ? '<button class="btn2 line" onclick="hqSyncMail()">' + ico('refresh') + 'Check mail now</button>' : '') + '</div>' +
      '<div class="note2" style="margin-bottom:12px"><b>Content is due every Friday at 5:00 PM.</b> No exceptions. Each Monday this page shows the content you are making that week. Client email replies are due the next business day.</div><div class="tabs">' + (real ? tab('mine', 'Mine') : '') + tab('late', 'Late') + tab('all', 'Everyone') + tab('done', 'Done') + '</div>' + form +
      (!d.connected ? '<div class="banner">' + ico('alert') + '<div>Basecamp is not connected, so only CRM tasks show. <a class="lnk" href="/api/basecamp/connect">Connect</a></div></div>' : '') +
      '<div class="panel">' + (rows.length ? rows.map(function (x) {
        var mine = me && (x.ownerId === me.id), canClose = x.k === 'crm' && (mine || (me && me.role === 'admin'));
        var link = x.k === 'bc' ? '<a href="' + e(x.url) + '" target="_blank" rel="noopener">' + e(x.title) + '</a>' : (x.src && x.src.type === 'email' && x.src.mailbox === (me && me.id) ? '<a href="https://mail.google.com/mail/u/' + encodeURIComponent(me.email) + '/#inbox/' + e(x.src.thread) + '" target="_blank" rel="noopener">' + e(x.title) + '</a>' : '<span>' + e(x.title) + '</span>');
        return '<div class="td' + (x.done ? ' dn' : '') + '">' + (x.k === 'crm' ? '<button class="ckb ' + (x.done ? 'on' : '') + '" ' + (canClose ? 'onclick="hqTaskDone(\'' + e(x.id) + '\',' + (x.done ? 'false' : 'true') + ')"' : 'disabled') + ' aria-label="' + (x.done ? 'Reopen' : 'Mark done') + '">' + (x.done ? ico('check') : '') + '</button>' : '<span class="ck"></span>') +
          '<div style="min-width:0">' + link + '<div class="who">' + (x.src && x.src.type === 'email' ? '<span class="chip need" style="margin-right:6px">Email</span>' : '') + e(x.client) + (x.client ? ' · ' : '') + e(x.who || 'Unassigned') + (x.auto ? ' · ' + e(x.auto) : '') + '</div></div>' +
          '<span class="due ' + (x.overdue ? 'od' : '') + '">' + (x.due ? (x.overdue ? 'Late · ' : '') + e(dshort(x.due)) + (x.dueTime === '17:00' ? ', 5 PM' : '') : '') + '</span></div>';
      }).join('') : '<div class="empty">' + ico('check') + (f === 'mine' ? 'Nothing assigned to you right now.' : 'Nothing here.') + '</div>') + '</div>' +
      '<p class="hint" style="margin-top:10px">' + total + ' open in total.</p>';
  }
  window.hqTaskDone = async function (id, done) { try { await api('/api/tasks/' + id + '/done', 'POST', { done: done }); await refreshTasks(); show('hq:work'); } catch (er) { toast(er.message); } };
  window.hqAddTask = async function () {
    var g = function (i) { return (document.getElementById(i) || {}).value || ''; };
    try { await api('/api/tasks', 'POST', { title: g('nt_t'), client: g('nt_c'), due: g('nt_d'), owner: g('nt_o') || undefined }); toast('Added'); await refreshTasks(); show('hq:work'); } catch (er) { toast(er.message); }
  };
  window.hqSyncMail = async function () { try { toast('Checking mail...'); var r = await api('/api/tasks/sync', 'POST', {}); await refreshTasks(); toast(r.created ? r.created + ' new task' + (r.created > 1 ? 's' : '') : 'No new client emails'); show('hq:work'); } catch (er) { toast(er.message); } };
  async function refreshTasks() { try { HQ.tasks = (await api('/api/tasks')).tasks || []; } catch (er) {} }
  window.HQ_work = function (k) { HQ.workTab = k; show('hq:work'); };
  window.HQ_ctab = function (k) { clientTab = k; show('hq:clients'); };

  function clients() {
    var d = HQ.data, all = d.clients.filter(function (c) { return c.status !== 'internal'; });
    var list = clientTab === 'all' ? all : all.filter(function (c) { return (c.kind || 'retainer') === clientTab; });
    var n = function (k) { return all.filter(function (c) { return (c.kind || 'retainer') === k; }).length; };
    var tab = function (k, l, c) { return '<button class="tb ' + (clientTab === k ? 'on' : '') + '" onclick="HQ_ctab(\'' + k + '\')">' + l + ' <span>' + c + '</span></button>'; };
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Clients</h3><p>Open one for everything about them.</p></div></div>' +
      '<div class="tabs">' + tab('all', 'All', all.length) + tab('retainer', 'Retainer', n('retainer')) + tab('website', 'Website', n('website')) + tab('returning', 'Returning', n('returning')) + tab('proposal', 'Pending', n('proposal')) + '</div>' +
      (d.connected ? '' : '<div class="banner">' + ico('alert') + '<div><b>Basecamp is not connected,</b> so to-dos are hidden. <a class="lnk" href="/api/basecamp/connect">Connect Basecamp</a></div></div>') +
      '<div class="cl-grid">' + (list.map(card).join('') || '<div class="empty">Nobody here yet.</div>') + '</div>';
  }

  function clientPage(slug) {
    var c = HQ.data.clients.filter(function (x) { return x.slug === slug; })[0];
    if (!c) return '<div class="empty">Client not found.</div>';
    var h = health(c), w = c.work, mine = (HQ.onb || []).filter(function (r) { return r.client === slug; });
    var formUrl = location.origin + '/onboarding?client=' + encodeURIComponent(slug), lists = '';
    if (w && w.linked) {
      var tdRow = function (t) { return '<div class="td"><span class="ck"></span><div><a href="' + e(t.url) + '" target="_blank" rel="noopener">' + e(t.title) + '</a><div class="who">' + e(t.who || 'Unassigned') + '</div></div><span class="due ' + (t.overdue ? 'od' : '') + '">' + (t.due ? (t.overdue ? 'Late · ' : '') + e(dshort(t.due)) : '') + '</span></div>'; };
      var openLists = w.lists.filter(function (l) { return l.open.length; }), doneLists = w.lists.filter(function (l) { return !l.open.length; });
      lists = openLists.map(function (l) {
        var m = /(\d+)\/(\d+)/.exec(l.ratio || ''), pct = m && +m[2] ? Math.round(+m[1] / +m[2] * 100) : 0, rows = l.open.slice().sort(function (x, y) { return String(x.due || '9') < String(y.due || '9') ? -1 : 1; });
        return '<div style="margin-bottom:18px"><div class="list-h"><b>' + e(l.name) + '</b><span>' + e(l.ratio ? l.ratio + ' done' : '') + ' · <a class="lnk" href="' + e(l.url) + '" target="_blank" rel="noopener">Basecamp</a></span></div><div class="pbar"><i style="width:' + pct + '%"></i></div>' +
          rows.slice(0, 3).map(tdRow).join('') + (rows.length > 3 ? '<details class="sm" style="margin-top:6px"><summary>' + (rows.length - 3) + ' more, due later</summary>' + rows.slice(3).map(tdRow).join('') + '</details>' : '') + '</div>';
      }).join('') + (doneLists.length ? '<details class="sm"><summary>' + doneLists.length + ' finished list' + (doneLists.length > 1 ? 's' : '') + '</summary><div style="padding:6px 2px;font-size:13px;color:#4a5468">' + doneLists.map(function (l) { return e(l.name) + ' (' + e(l.ratio || 'done') + ')'; }).join('<br>') + '</div></details>' : '');
      if (!lists) lists = '<div class="empty">No to-do lists in this project yet.</div>';
    } else if (!HQ.data.connected) {
      lists = '<div class="empty">' + ico('link') + 'Connect Basecamp to see this client\'s to-dos.<br><br><a class="btn2 red" href="/api/basecamp/connect">Connect Basecamp</a></div>';
    } else {
      if (c.syncing || /429|rate limit/i.test(c.workError || '')) lists = '<div class="empty">' + ico('refresh') + 'Syncing with Basecamp. This takes a few seconds the first time, and the page will fill in on its own.</div>'; else
      lists = '<div class="empty">' + ico('link') + 'No Basecamp project found for ' + e(c.name) + '. Paste its link:</div><div class="linkrow"><input id="bcl" placeholder="https://app.basecamp.com/.../projects/12345"><button class="btn2 red" onclick="hqLink(\'' + e(slug) + '\')">Link</button></div>' + (c.workError ? '<div style="color:var(--bad);margin-top:8px;font-size:12.5px">' + e(c.workError) + '</div>' : '');
    }
    var onb = mine.length ? mine.slice().reverse().map(function (r) { return '<details class="sm"><summary>' + e(r.contact_name || r.email) + ' · ' + e(new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</summary><pre>' + e(r.summary || JSON.stringify(r.answers, null, 2)) + '</pre></details>'; }).join('')
      : '<p class="hint" style="margin:0">No answers yet. Send them this link:</p><div class="linkrow"><input readonly value="' + e(formUrl) + '" onclick="this.select()" aria-label="Onboarding link"><button class="btn2 line" onclick="navigator.clipboard.writeText(\'' + e(formUrl) + '\');toast(\'Link copied\')">Copy</button></div>';
    var tl = '';
    mine.slice().reverse().forEach(function (r) { tl += '<div class="ev"><b>Onboarding form submitted</b><div class="m">' + e(new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) + ' · ' + e(r.contact_name || r.email) + '</div></div>'; });
    if (w && w.linked) tl += '<div class="ev"><b>Basecamp project linked</b><div class="m">' + e(w.project.name) + '</div></div>';
    if (!tl) tl = '<div class="empty" style="padding:8px 0">Nothing logged yet.</div>';
    return '<button class="back" onclick="hqNav(\'hq:clients\')">' + ico('back') + 'All clients</button>' +
      '<div class="banner-h rise" style="--cc:' + brand(c) + '"><div class="row">' + avatar(c, 76) + '<div class="grow"><h2>' + e(c.name) + '</h2>' +
      '<div class="chips" style="margin-top:10px"><span class="chip">' + e(STATUS[c.status] || c.status) + '</span>' + (c.services || []).map(function (s) { return '<span class="chip">' + e(s) + '</span>'; }).join('') + '</div></div>' +
      '<div class="hl ' + h.k + '" style="font-size:14px"><i style="width:10px;height:10px"></i>' + e(h.t) + '</div></div></div>' +
      (c.note ? '<div class="banner">' + ico('alert') + '<div>' + e(c.note) + '</div></div>' : '') +
      tabsBar(c) + (HQ.ctab && HQ.ctab !== 'overview' ? tabBody(c) : '<div class="two"><div class="panel"><h3>Work</h3>' + lists + '</div><div style="display:grid;gap:16px">' +
      '<div class="panel"><h3>Who handles it</h3>' + ownerRow('Website', c.website_owner) + ownerRow('Ads', c.ads_owner) + ownerRow('Account manager', c.account_owner) +
      (w && w.linked ? '<div class="kv"><span>Basecamp</span><a class="lnk" href="' + e(w.project.url) + '" target="_blank" rel="noopener">Open project</a></div>' : '') + '</div>' +
      ((mine.length || c.status === 'onboarding') ? '<div class="panel"><h3>Onboarding answers</h3>' + onb + '</div>' : '') +
      linksPanel(c) + editPanel(c) +
      '<div class="panel"><h3>Activity</h3><div class="tl" style="margin-top:12px">' + tl + '</div></div></div></div>');
  }
  function ownerRow(l, v) { return '<div class="kv"><span>' + e(l) + '</span><b>' + (v ? e(v) : '<span style="font-weight:500;color:var(--mut)">Not assigned</span>') + '</b></div>'; }
  var SERV = ['Website', 'Local SEO and Google profile', 'Paid ads', 'Social content', 'Video and photo', 'Email and SMS', 'CRM'];
  function editPanel(c) {
    if (!(HQ.me && HQ.me.role === 'admin')) return '';
    var users = (HQ.users || []).filter(function (u) { return u.active; });
    var sel = function (id, cur) { return '<select id="' + id + '"><option value="">Not assigned</option>' + users.map(function (u) { return '<option' + (u.name === cur ? ' selected' : '') + '>' + e(u.name) + '</option>'; }).join('') + '</select>'; };
    var opt = function (arr, cur) { return arr.map(function (a) { return '<option value="' + a[0] + '"' + (a[0] === cur ? ' selected' : '') + '>' + a[1] + '</option>'; }).join(''); };
    return '<details class="sm" style="background:#fff"><summary>Edit details</summary><div class="ed">' +
      '<label>Type</label><select id="ed_kind">' + opt([['retainer', 'Retainer'], ['website', 'Website client'], ['returning', 'Returning'], ['proposal', 'Proposal pending']], c.kind || 'retainer') + '</select>' +
      '<label>Status</label><select id="ed_status">' + opt([['active', 'Active'], ['ending', 'Ending'], ['seasonal', 'Seasonal'], ['ads_off', 'Ads off'], ['onboarding', 'Onboarding'], ['returning', 'Returning'], ['proposal', 'Proposal']], c.status) + '</select>' +
      '<label>What we do for them</label><div class="chk">' + SERV.map(function (sv, i) { return '<label class="cb"><input type="checkbox" id="ed_s' + i + '"' + ((c.services || []).indexOf(sv) > -1 ? ' checked' : '') + '> ' + e(sv) + '</label>'; }).join('') + '</div>' +
      '<label>Website lead</label>' + sel('ed_web', c.website_owner) + '<label>Ads lead</label>' + sel('ed_ads', c.ads_owner) + '<label>Account manager</label>' + sel('ed_acc', c.account_owner) +
      '<label>Posting days</label><div class="chk">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return '<label class="cb"><input type="checkbox" id="ed_d' + d + '"' + ((c.cadence && c.cadence.days || []).indexOf(d) > -1 ? ' checked' : '') + '> ' + d + '</label>'; }).join('') + '</div><label>Schedule note (mix, filming, extras)</label><input id="ed_cn" value="' + e((c.cadence && c.cadence.note) || '') + '">' +
      '<label>Their email addresses or domains (comma separated)</label><input id="ed_dom" value="' + e((c.domains || []).join(', ')) + '" placeholder="theirbusiness.com, owner@gmail.com">' +
      '<label>Note</label><input id="ed_note" value="' + e(c.note || '') + '" placeholder="Anything the team should know">' +
      '<button class="btn2 red" style="margin-top:12px" onclick="hqSaveClient(\'' + e(c.slug) + '\')">Save</button></div></details>';
  }
  window.hqSaveClient = async function (slug) {
    var g = function (id) { return (document.getElementById(id) || {}).value || ''; };
    var svcs = SERV.filter(function (sv, i) { var b = document.getElementById('ed_s' + i); return b && b.checked; });
    try { await api('/api/hq/client/' + slug, 'PUT', { kind: g('ed_kind'), status: g('ed_status'), services: svcs, website_owner: g('ed_web'), ads_owner: g('ed_ads'), account_owner: g('ed_acc'), note: g('ed_note'), cadence: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter(function (d) { var b = document.getElementById('ed_d' + d); return b && b.checked; }), note: g('ed_cn') }, domains: g('ed_dom').split(',').map(function (x) { return x.trim(); }).filter(Boolean) }); toast('Saved'); window.hqRefresh(); } catch (er) { toast(er.message); }
  };

  function onboarding() {
    var rows = HQ.onb || [];
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Onboarding</h3><p>Everything new clients tell us, in one place.</p></div><a class="btn2 red" href="/onboarding" target="_blank" rel="noopener">' + ico('clipboard') + 'Open the client form</a></div>' +
      '<div class="panel">' + (rows.length ? rows.map(function (r) {
        return '<details class="sm"><summary>' + e(r.business) + ' <span class="chip" style="margin-left:8px">' + e(r.client || 'older form') + '</span> <span style="color:var(--mut);font-weight:400;font-size:13px">· ' + e(new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + (r.basecamp ? ' · <a class="lnk" href="' + e(r.basecamp.url) + '" target="_blank" rel="noopener">Basecamp</a>' : '') + '</span></summary><pre>' + e(r.summary || JSON.stringify(r.answers, null, 2)) + '</pre></details>';
      }).join('') : '<div class="empty">' + ico('inbox') + 'No submissions yet. Add <code>?client=their-name</code> to the form link so answers file under that client.</div>') + '</div>';
  }


  var OUT_INFO = {
    board: ['Pipeline board', 'Every lead on one board by stage.', 'kanban', ''],
    replied: ['Replied', 'They wrote back. Answer these first.', 'reply', 'hot'], booked: ['Booked', 'Calls on the calendar.', 'check', 'win'],
    won: ['Won', 'Closed deals.', 'flag', 'win'], sent: ['Awaiting reply', 'Emailed, nothing back yet.', 'mail', ''],
    inbound: ['Inbound', 'People who came to us.', 'star', 'hot'], giveaway: ['Giveaway', 'Entrants from the giveaway.', 'gift', ''],
    manual: ['Manual', 'Added by hand, never auto-emailed.', 'plus', ''], nosite: ['No Website', 'Call list of businesses without a site.', 'phone', ''],
    new: ['Queue', 'Waiting to be drafted.', 'circle', 'cold'], drafted: ['Drafted', 'Written, waiting for approval.', 'edit', ''],
    all: ['All leads', 'The full list in a table.', 'list', 'cold'], unreachable: ['Unreachable', 'No working email or phone.', 'ban', 'cold'], rejected: ['Rejected', 'Pulled from outreach.', 'x', 'cold']
  };
  function outCount(k) {
    var live = (state.prospects || []).filter(function (p) { return !p.internal && p.status !== 'test'; });
    for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i][1].length; j++) { var it = NAV[i][1][j]; if (it[0] === k) return it[3] ? live.filter(it[3]).length : live.length; }
    return live.length;
  }
  function ocard(k, i) {
    var o = OUT_INFO[k]; return '<button class="oc ' + o[3] + '" style="animation-delay:' + i * 30 + 'ms" onclick="navTo(\'' + k + '\')"><div class="top2"><div class="ci">' + ico(o[2]) + '</div><span class="arrow">' + ico('arrow') + '</span></div><div class="n">' + outCount(k).toLocaleString() + '</div><div class="lb">' + e(o[0]) + '</div><div class="ds">' + e(o[1]) + '</div></button>';
  }
  // ---- Winners for Ads: three taps for Ariel ----
  var WHY = ['Most views', 'Most saves', 'Most shares', 'Most comments', 'Got leads'];
  async function adsPage() {
    var r; try { r = await api('/api/hq/winners-all'); } catch (x) { return '<div class="panel"><div class="empty">' + e(x.message) + '</div></div>'; }
    var opts = r.clients.map(function (c) { return '<option value="' + e(c.slug) + '">' + e(c.name) + '</option>'; }).join('');
    var lab = { new: 'New', in_ads: 'In ads', not_a_fit: 'Not a fit' };
    var cards = r.winners.map(function (w) {
      return '<div class="panel" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div class="nm">' + e(w.client) + ' <span class="em">' + e(w.platform || '') + '</span></div><div style="margin:6px 0;word-break:break-word">' + e(w.post) + '</div>' + (w.why ? '<div class="em">Why: ' + e(w.why) + '</div>' : '') + '</div><div style="white-space:nowrap"><span class="chip st-' + (w.ad_status === 'in_ads' ? 'active' : 'internal') + '">' + lab[w.ad_status] + '</span></div></div>' +
        '<div style="margin-top:10px"><button class="btn2 red mini" onclick="hqAdSt(\'' + e(w.slug) + '\',\'' + e(w.id) + '\',\'in_ads\')">Using in ads</button> <button class="btn2 line mini" onclick="hqAdSt(\'' + e(w.slug) + '\',\'' + e(w.id) + '\',\'not_a_fit\')">Not a fit</button> <button class="btn2 line mini cpy" data-copy="' + e(w.post) + '">Copy link</button></div></div>';
    }).join('');
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Winners for Ads</h3><p>Mark a post that did well. It becomes a proven format in the next packs and a task for the ads owner. Nothing is boosted.</p></div></div>' +
      '<div class="panel" style="margin-bottom:16px"><h3>Mark a winner</h3><div class="frm" style="margin-top:12px"><div><label>Client</label><select id="wa_c">' + opts + '</select></div><div><label>Platform</label><select id="wa_p"><option>Instagram</option><option>Facebook</option><option>TikTok</option><option>LinkedIn</option><option>YouTube</option></select></div><div style="grid-column:1/-1"><label>Link to the post</label><input id="wa_l" placeholder="Paste the link"></div><div style="grid-column:1/-1"><label>Why it won (tap one)</label><div id="wa_w" style="display:flex;gap:8px;flex-wrap:wrap">' + WHY.map(function (x, i) { return '<button type="button" class="btn2 line mini" id="wy' + i + '" onclick="hqWhy(' + i + ')">' + x + '</button>'; }).join('') + '</div></div></div><div style="margin-top:12px"><button class="btn2 red" onclick="hqWinAll()">Mark winner</button></div></div>' +
      (cards || '<div class="panel"><div class="empty">No winners marked yet.</div></div>');
  }
  var WHYSEL = '';
  window.hqWhy = function (i) { WHYSEL = WHY[i]; WHY.forEach(function (x, k) { var b = document.getElementById('wy' + k); if (b) b.className = 'btn2 ' + (k === i ? 'red' : 'line') + ' mini'; }); };
  window.hqWinAll = async function () {
    var v = function (id) { return (document.getElementById(id) || {}).value || ''; }, slug = v('wa_c');
    try { var r = await fetch('/api/hq/winners/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ post: v('wa_l'), platform: v('wa_p'), why: WHYSEL }) }); var j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not save'); WHYSEL = ''; toast(j.task ? 'Saved. A task went to the ads owner.' : 'Saved'); show('hq:ads'); } catch (x) { toast(String(x.message || x)); }
  };
  window.hqAdSt = async function (slug, id, st) { try { await api('/api/hq/winners/' + slug + '/' + id + '/ad', 'POST', { status: st }); } catch (x) { toast(x.message); } show('hq:ads'); };

  // ---- Blogs: written, copy and paste ready ----
  async function blogsPage() {
    var r; try { r = await api('/api/hq/blogs'); } catch (x) { return '<div class="panel"><div class="empty">' + e(x.message) + '</div></div>'; }
    var admin = HQ.me && HQ.me.role === 'admin', opts = r.clients.map(function (c) { return '<option value="' + e(c.slug) + '">' + e(c.name) + '</option>'; }).join('');
    var busy = r.busy && r.busy.running ? '<div class="note2" style="margin-bottom:12px">Writing one post for every client: ' + r.busy.done + ' of ' + r.busy.total + ' done. Refresh in a minute.</div>' : '';
    var cards = r.blogs.map(function (b) {
      var full = b.title + '\n\n' + b.body + (b.cta ? '\n\n' + b.cta : '');
      return '<div class="panel" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div class="em">' + e(b.client) + ' · keyword: ' + e(b.keyword) + '</div><div class="nm" style="font-size:17px;margin:4px 0">' + e(b.title) + '</div></div><span class="chip st-' + (b.status === 'published' ? 'active' : 'internal') + '">' + (b.status === 'published' ? 'Published' : 'Ready') + '</span></div>' +
        '<div class="em" style="margin:4px 0">Meta: ' + e(b.meta) + '</div>' + (b.verify && b.verify.length ? '<div class="note2" style="margin:8px 0"><b>Check before publishing:</b> ' + e(b.verify.join(' · ')) + '</div>' : '') +
        '<details class="sm"><summary>Read the post</summary><div style="white-space:pre-wrap;font-size:14px;line-height:1.6;margin-top:8px">' + e(b.body) + '</div></details>' +
        '<div style="margin-top:10px"><button class="btn2 red mini cpy" data-copy="' + e(full) + '">Copy title + post</button> <button class="btn2 line mini cpy" data-copy="' + e(b.title) + '">Copy title</button> <button class="btn2 line mini cpy" data-copy="' + e(b.meta) + '">Copy meta</button> <button class="btn2 line mini" onclick="hqBlogSt(\'' + e(b.id) + '\',\'' + (b.status === 'published' ? 'ready' : 'published') + '\')">' + (b.status === 'published' ? 'Mark ready' : 'Mark published') + '</button></div></div>';
    }).join('');
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Blogs</h3><p>Two a month per client. Written from each client\'s brain and research, ready to copy into their site. Frank publishes.</p></div></div>' + busy +
      '<div class="panel" style="margin-bottom:16px"><h3>Write one</h3><div class="frm" style="margin-top:12px"><div><label>Client</label><select id="bl_c">' + opts + '</select></div><div><label>Topic (optional)</label><input id="bl_t" placeholder="Leave blank and it picks from the research"></div></div><div style="margin-top:12px"><button class="btn2 red" onclick="hqBlogWrite()">Write a blog post</button>' + (admin ? ' <button class="btn2 line" onclick="hqBlogAll()">Write one for every client</button>' : '') + '</div></div>' + (cards || '<div class="panel"><div class="empty">No posts yet.</div></div>');
  }
  window.hqBlogWrite = async function () { var v = function (id) { return (document.getElementById(id) || {}).value || ''; }; toast('Writing. This takes about a minute.'); try { await api('/api/hq/blogs/' + v('bl_c') + '/write', 'POST', { topic: v('bl_t') }); } catch (x) { toast(x.message); return; } show('hq:blogs'); };
  window.hqBlogAll = async function () { if (!confirm('Write one post for every active client? It runs in the background.')) return; try { await api('/api/hq/blogs/write-all', 'POST', {}); toast('Started'); } catch (x) { toast(x.message); } show('hq:blogs'); };
  window.hqBlogSt = async function (id, st) { try { await api('/api/hq/blogs/' + id + '/status', 'POST', { status: st }); } catch (x) { toast(x.message); } show('hq:blogs'); };

  // ---- Announcements on Home ----
  async function loadAnn() { try { HQ.ann = await api('/api/announcements'); } catch (x) { HQ.ann = { items: [] }; } }
  function annBox() {
    var a = HQ.ann || { items: [] }, admin = a.admin, items = a.items || [];
    var list = items.map(function (x) { return '<div class="item" style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 12px;margin-bottom:8px;border-radius:12px;background:' + (x.level === 'alert' ? '#fde8e7' : '#eef3fb') + '"><div><b>' + (x.level === 'alert' ? 'Alert' : 'Reminder') + ':</b> ' + e(x.text) + (admin ? '<div class="em">To ' + (x.to === 'all' ? 'everyone' : (x.to || []).length + ' people') + ' · ' + x.dismissed_count + ' dismissed</div>' : '') + '</div>' + (admin ? '<button class="btn2 line mini" onclick="hqAnnDel(\'' + e(x.id) + '\')">Remove</button>' : '<button class="btn2 line mini" onclick="hqAnnDone(\'' + e(x.id) + '\')">Done</button>') + '</div>'; }).join('');
    var form = admin ? '<details class="sm" style="margin-bottom:12px"><summary>Send an alert or reminder to the team</summary><div class="ed"><label>Message</label><input id="an_t" maxlength="500"><label>Type</label><select id="an_l"><option value="reminder">Reminder</option><option value="alert">Alert</option></select><label>Hide after (optional)</label><input id="an_e" type="date"><button class="btn2 red" style="margin-top:8px" onclick="hqAnnSend()">Send to everyone</button></div></details>' : '';
    return (list || form) ? '<div style="margin-bottom:16px">' + list + form + '</div>' : '';
  }
  window.hqAnnSend = async function () { var v = function (id) { return (document.getElementById(id) || {}).value || ''; }; try { await api('/api/announcements', 'POST', { text: v('an_t'), level: v('an_l'), expires: v('an_e'), to: 'all' }); toast('Sent'); } catch (x) { toast(x.message); return; } await loadAnn(); show('hq:home'); };
  window.hqAnnDone = async function (id) { try { await api('/api/announcements/' + id + '/dismiss', 'POST', {}); } catch (x) {} await loadAnn(); show('hq:home'); };
  window.hqAnnDel = async function (id) { if (!confirm('Remove this for everyone?')) return; try { await api('/api/announcements/' + id, 'DELETE'); } catch (x) {} await loadAnn(); show('hq:home'); };
  function sproutBox(posts, cname) {
    var by = {}; posts.forEach(function (p) { if (p.status === 'approved') (by[p.client] = by[p.client] || []).push(p); });
    var ks = Object.keys(by);
    return '<div class="panel" style="margin-bottom:16px"><h3>Send to Sprout</h3><p class="hint" style="margin-top:0">Sprout takes one file per client. In Sprout: Publishing, Calendar, the three dots at the top right, <b>Bulk Post Import</b>. Pick that client\'s profiles, drop the file in, choose <b>mm/dd/yyyy</b>, and tick <b>Schedule posts as Drafts</b> so you can look before anything goes live. Videos are not supported by Sprout import, so videos and posts without a public image link are left out of the file and stay here.</p>' +
      (ks.length ? ks.map(function (k) { return '<a class="btn2 red mini" style="margin:4px 6px 0 0" href="/api/queue/export.csv?client=' + encodeURIComponent(k) + '">' + e(cname(k)) + ' (' + by[k].length + ')</a>'; }).join('') : '<div class="em">Nothing is approved yet.</div>') + '</div>';
  }
  var QSTAT = { approved: ['Approved', 'ok'], waiting: ['Waiting', 'warn'], held: ['Held', 'bad'] };
  async function queuePage() {
    if (!HQ.me || !HQ.me.queue) return '<div class="sec"><div><h3 style="font-size:28px">Posting Queue</h3></div></div><div class="panel"><div class="empty">' + ico('alert') + 'The posting queue is private to Zac.</div></div>';
    var r; try { r = await api('/api/queue'); } catch (x) { return '<div class="panel"><div class="empty">' + e(x.message) + '</div></div>'; }
    HQ.queue = r;
    var posts = r.posts.filter(function (p) { return !p.sent_at; }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    var nA = posts.filter(function (p) { return p.status === 'approved'; }).length;
    var opts = r.clients.map(function (c) { return '<option value="' + e(c.slug) + '">' + e(c.name) + '</option>'; }).join('');
    var cname = function (s) { var c = r.clients.filter(function (x) { return x.slug === s; })[0]; return c ? c.name : s; };
    var rows = posts.map(function (p) {
      var rule = r.rules[p.client], st = QSTAT[p.status] || QSTAT.waiting, why = '';
      if (p.status !== 'approved') { if (!p.caption) why = 'No caption yet.'; else if (rule && rule.captionBy && p.caption_by !== rule.captionBy) why = 'Waiting on ' + rule.captionBy + '\'s caption.'; else if (rule) why = 'Waiting on ' + rule.approvers.join(' or ') + '.'; else why = 'Waiting on you.'; }
      var appr = rule ? '<select onchange="hqQ(\'' + p.id + '\',{approved_by:this.value})"><option value="">Approved by...</option>' + rule.approvers.map(function (a) { return '<option' + (p.approved_by === a ? ' selected' : '') + '>' + e(a) + '</option>'; }).join('') + '</select>' : '';
      var cap = rule && rule.captionBy ? '<label style="font-size:12px"><input type="checkbox"' + (p.caption_by === rule.captionBy ? ' checked' : '') + ' onchange="hqQ(\'' + p.id + '\',{caption_by:this.checked?\'' + rule.captionBy + '\':\'\'})"> ' + e(rule.captionBy) + ' wrote it</label>' : '';
      return '<tr><td><div class="nm">' + e(cname(p.client)) + '</div><div class="em">' + e(p.platforms || '') + '</div></td><td class="em">' + e(p.date) + '<br>' + e(p.time) + '</td><td style="max-width:360px"><div style="white-space:pre-wrap;font-size:13px">' + e(p.caption || '(no caption)') + '</div>' + (p.cta ? '<div class="em">CTA: ' + e(p.cta) + '</div>' : '') + (p.media ? '<div class="em">Media: ' + e(p.media) + '</div>' : '') + '</td>' +
        '<td><span class="chip st-' + (st[1] === 'ok' ? 'active' : 'internal') + '">' + st[0] + '</span><div class="em">' + e(why) + '</div>' + cap + appr + '</td><td style="text-align:right;white-space:nowrap"><button class="btn2 line mini cpy" data-copy="' + e([p.caption, p.cta && (p.caption || '').indexOf(p.cta) < 0 ? p.cta : ''].filter(Boolean).join('\n\n')) + '">Copy caption</button> <button class="btn2 line mini" onclick="hqQ(\'' + p.id + '\',{status:\'approved\'})">Approve</button> <button class="btn2 line mini" onclick="hqQ(\'' + p.id + '\',{status:\'held\'})">Hold</button> <button class="btn2 line mini" onclick="hqQDel(\'' + p.id + '\')">Delete</button></td></tr>';
    }).join('');
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Posting Queue</h3><p>Only posts marked Approved go in the file for Sprout. Everything else stays here with the reason it is waiting. Private to you.</p></div></div>' + sproutBox(posts, cname) +
      '<div class="panel" style="margin-bottom:16px"><h3>Add a post</h3><div class="frm" style="margin-top:12px"><div><label>Client</label><select id="qc">' + opts + '</select></div><div><label>Platforms</label><input id="qp" placeholder="Instagram, Facebook, LinkedIn"></div><div><label>Date</label><input id="qd" type="date"></div><div><label>Time</label><input id="qt" type="time"></div><div style="grid-column:1/-1"><label>Caption</label><textarea id="qk" rows="4"></textarea></div><div><label>CTA</label><input id="qa"></div><div><label>Media (file name or link)</label><input id="qm"></div></div><div style="margin-top:12px"><button class="btn2 red" onclick="hqQAdd()">Add to queue</button></div></div>' +
      '<div class="panel"><table class="ttab"><thead><tr><th>Client</th><th>When</th><th>Post</th><th>Approval</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="em">Nothing in the queue.</td></tr>') + '</tbody></table></div>';
  }
  window.hqQ = async function (id, body) { try { await api('/api/queue/' + id, 'PATCH', body); } catch (er) { toast(er.message); } show('hq:queue'); };
  window.hqQDel = async function (id) { if (!confirm('Delete this post from the queue?')) return; try { await api('/api/queue/' + id, 'DELETE'); } catch (er) { toast(er.message); } show('hq:queue'); };
  window.hqQAdd = async function () {
    var g = function (i) { return (document.getElementById(i) || {}).value || ''; };
    try { await api('/api/queue', 'POST', { client: g('qc'), platforms: g('qp'), date: g('qd'), time: g('qt'), caption: g('qk'), cta: g('qa'), media: g('qm') }); toast('Added'); } catch (er) { toast(er.message); return; }
    show('hq:queue');
  };
  function conversions(cv) {
    var live = cv && cv.live, rows = [['Visiting Nurse (VNPHC)', 'Forms first'], ['Matchett Homes', 'Forms first'], ['Sun & Shield', 'Forms first'], ['iFab', 'Forms first'], ['ABLS (America\'s Best Lighting)', 'Forms first'], ['NABS', 'Forms first'], ['Open Heart Media (our own ads)', 'Forms first']];
    var steps = ['Put the capture script on the client site so every form saves the ad click ID.', 'Set the client site as an allowed origin and test one form.', 'Confirm the client\'s Google Ads has an offline "Booked Job" conversion action (import type).', 'Add the Meta pixel ID and access token for the client.', 'Ask the client each month for booked jobs and job values.', 'Mark booked jobs in the dashboard. Upload the Google file and let Meta events send.'];
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Conversions</h3><p>Real leads from ads, sent back to Google and Meta so they optimize for booked jobs. Primary conversions are forms and calls of 60 seconds or more.</p></div>' + (live ? '<a class="btn2 red" href="' + e(cv.url) + '" target="_blank" rel="noopener">Open the dashboard</a>' : '') + '</div>' +
      '<div class="panel" style="margin-bottom:16px"><h3>' + ico(live ? 'check' : 'alert') + (live ? ' Live' : ' Built and tested, not live yet') + '</h3><p class="hint">' + (live ? 'The dashboard has a tab per client with leads, outcomes and the Google file.' : 'The dashboard and capture script are built and pass their tests. It goes live after the hosting accounts are connected. Until then this page is the setup checklist.') + '</p></div>' +
      '<div class="panel" style="margin-bottom:16px"><h3>Ads clients on the list</h3><p class="hint">Forms are tracked first. Call tracking comes next and applies to every client below: calls of 60 seconds or more from an ad count as a real conversion.</p>' + rows.map(function (r) { return '<div class="kv"><span>' + e(r[0]) + '</span><b>' + e(r[1]) + ' · Calls: to set up</b></div>'; }).join('') + '</div>' +
      '<div class="panel"><h3>Setup for each client</h3><ol style="line-height:1.8;margin:10px 0 0 18px">' + steps.map(function (s) { return '<li>' + e(s) + '</li>'; }).join('') + '</ol></div>';
  }
  function outreach() {
    var g = function (title, sub, keys) { return '<div class="sec"><div><h3>' + title + '</h3><p>' + sub + '</p></div></div><div class="og">' + keys.map(ocard).join('') + '</div>'; };
    var f = function (k, l) { return '<button onclick="navTo(\'' + k + '\')"><b>' + outCount(k).toLocaleString() + '</b><span>' + l + '</span></button>'; };
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Outreach</h3><p>Cold email and new business. Click any box to open it.</p></div></div>' +
      '<div class="funnel">' + f('all', 'Leads') + f('sent', 'Contacted') + f('replied', 'Replied') + f('booked', 'Booked') + f('won', 'Won') + '</div>' +
      g('Pipeline', 'Where each conversation stands.', ['replied', 'sent', 'booked', 'won']) +
      g('Where leads come from', 'Different lists, different rules.', ['inbound', 'giveaway', 'nosite', 'manual']) +
      g('The list', 'Everything behind the scenes.', ['board', 'new', 'drafted', 'all', 'unreachable', 'rejected']);
  }
  async function team() {
    var me = HQ.me; var box = '';
    if (!me || me.role !== 'admin') return '<div class="sec"><div><h3 style="font-size:28px">Team</h3><p>Only admins can manage logins.</p></div></div><div class="panel"><div class="empty">' + ico('alert') + 'Ask Zac or Griffin to add or reset a login.</div></div>';
    var r = await api('/api/admin/users'); HQ.users = r.users;
    var rows = r.users.map(function (u) {
      return '<tr><td><div class="nm">' + e(u.name) + '</div><div class="em">' + e(u.title || 'No job role set') + ' · ' + e(u.email) + '</div></td><td><span class="chip st-' + (u.role === 'admin' ? 'internal' : 'active') + '">' + (u.role === 'admin' ? 'Admin' : 'Member') + '</span>' + (u.active ? '' : ' <span class="chip st-ending">Off</span>') + (u.must_change ? ' <span class="chip need">Needs new password</span>' : '') + '</td>' +
        '<td class="em">' + (u.last_login ? e(new Date(u.last_login).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : 'Never') + '</td><td style="text-align:right;white-space:nowrap">' +
        '<button class="btn2 line mini" onclick="hqTitle(\'' + e(u.id) + '\')">Set job role</button> <button class="btn2 line mini" onclick="hqReset(\'' + e(u.id) + '\')">Reset password</button> <button class="btn2 line mini" onclick="hqPipe(\'' + e(u.id) + '\',' + (u.pipeline ? 'false' : 'true') + ')">' + (u.pipeline ? 'Pipeline: on' : 'Pipeline: off') + '</button> ' +
        (me.id !== u.id ? '<button class="btn2 line mini" onclick="hqActive(\'' + e(u.id) + '\',' + (u.active ? 'false' : 'true') + ')">' + (u.active ? 'Turn off' : 'Turn on') + '</button>' : '') + '</td></tr>';
    }).join('');
    var ln = []; try { ln = (await api('/api/lanes')).lanes; } catch (x) {}
    var lanePanel = '<div class="panel" style="margin-bottom:16px"><h3>Who handles what</h3><p class="hint">Client emails and new tasks go to the person for that kind of work.</p>' + ln.map(function (l) { return '<div class="kv"><span>' + e(l.label) + '</span><select onchange="hqLane(\'' + e(l.key) + '\',this.value)" style="padding:8px 10px;border:1px solid var(--hair2);border-radius:9px;min-height:36px;font:inherit"><option value="">' + (l.name ? '' : 'No login yet: ' + e(l.email)) + '</option>' + r.users.filter(function (u) { return u.active; }).map(function (u) { return '<option value="' + e(u.email) + '"' + (u.email === l.email ? ' selected' : '') + '>' + e(u.name) + '</option>'; }).join('') + '</select></div>'; }).join('') + '</div>';
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Team</h3><p>Everyone who can log in. Each person sees their own name.</p></div></div><div id="tempbox"></div>' + rosterPanel(r.users) + lanePanel +
      '<div class="panel" style="margin-bottom:16px"><h3>Add a person</h3><div class="frm" style="margin-top:12px"><div><label for="nu_n">Name</label><input id="nu_n" placeholder="Full name"></div><div><label for="nu_e">Email</label><input id="nu_e" type="email" placeholder="name@openheartmediaco.com"></div><div><label for="nu_t">Job role</label><input id="nu_t" placeholder="e.g. Web Developer"></div><div><label for="nu_r">Access</label><select id="nu_r"><option value="member">Member</option><option value="admin">Admin</option></select></div><button class="btn2 red" onclick="hqAddUser()">Add</button></div></div>' +
      '<div class="panel"><table class="ttab"><thead><tr><th>Person</th><th>Access</th><th>Last in</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  var ROSTER = [
    ['Griffin Baker', 'griffin@openheartmediaco.com', 'Operations & Account Manager', true],
    ['Brad Baker', 'brad@openheartmediaco.com', 'Director of Strategic Growth', true],
    ['Ariel Lewis', 'ariel@openheartmediaco.com', 'Director of Client Strategies', false],
    ['Frank LaDue', 'frank@openheartmediaco.com', 'Web Developer / Graphic Designer', false],
    ['Michelle Baker', 'michelle@openheartmediaco.com', 'Director of Sales', false],
    ['Hiroshi Yamamoto Farfan', 'hiroshi@openheartmediaco.com', 'Lead Editor', false],
    ['Mafer Rivera', 'mafer@openheartmediaco.com', 'Graphic Designer / Copywriter', false],
    ['Valeria Sweat', 'valeria@openheartmediaco.com', 'Copywriter', false],
    ['Tristen King', 'tristen@openheartmediaco.com', 'Lead Videographer', false],
    ['Lisa Rodgers', 'lisa@openheartmediaco.com', 'Corporate Sales', false]
  ];
  function rosterPanel(existing) {
    var have = {}; (existing || []).forEach(function (u) { have[u.email] = 1; });
    var rows = ROSTER.filter(function (r) { return !have[r[1]]; });
    if (!rows.length) return '';
    return '<div class="panel" style="margin-bottom:16px"><h3>Add the whole team</h3><p class="hint">Everyone from Basecamp, with their job role. Everyone is ticked. Untick anyone who should wait, and tick Admin for people who should manage logins.</p>' +
      '<table class="ttab"><thead><tr><th></th><th>Person</th><th>Job role</th><th>Admin</th></tr></thead><tbody>' + rows.map(function (r, i) {
        return '<tr><td><input type="checkbox" id="rt_on' + i + '"' + ' checked' + '></td><td><div class="nm">' + e(r[0]) + '</div><div class="em">' + e(r[1]) + '</div></td><td class="em" style="display:table-cell">' + e(r[2]) + '</td><td><input type="checkbox" id="rt_ad' + i + '"' + (r[3] ? ' checked' : '') + '></td></tr>';
      }).join('') + '</tbody></table><div style="margin-top:14px"><button class="btn2 red" onclick="hqAddTeam()">Add selected</button></div></div>';
  }
  window.hqAddTeam = async function () {
    var have = {}; (HQ.users || []).forEach(function (u) { have[u.email] = 1; });
    var rows = ROSTER.filter(function (r) { return !have[r[1]]; }), out = [], fail = [];
    for (var i = 0; i < rows.length; i++) {
      var on = document.getElementById('rt_on' + i); if (!on || !on.checked) continue;
      var ad = document.getElementById('rt_ad' + i);
      try { var r = await api('/api/admin/users', 'POST', { name: rows[i][0], email: rows[i][1], title: rows[i][2], role: ad && ad.checked ? 'admin' : 'member' }); out.push([rows[i][0], rows[i][1], r.temp_password]); }
      catch (er) { fail.push(rows[i][0] + ': ' + er.message); }
    }
    await show('hq:team');
    var b = document.getElementById('tempbox'); if (!b) return;
    var text = out.map(function (o) { return o[0] + ' | ' + o[1] + ' | ' + o[2]; }).join('\n');
    b.innerHTML = '<div class="tempbox"><b>Temporary passwords (shown once)</b><div style="margin:12px 0;display:grid;gap:6px">' + out.map(function (o) { return '<div>' + e(o[0]) + ' &nbsp;<span style="color:#9db3d6">' + e(o[1]) + '</span> &nbsp;<code style="font-size:15px">' + e(o[2]) + '</code></div>'; }).join('') + '</div>' +
      (fail.length ? '<div style="color:#ff9d97;font-size:13px">' + e(fail.join(' · ')) + '</div>' : '') +
      '<button class="btn2 glass" onclick="navigator.clipboard.writeText(' + e(JSON.stringify(text)) + ');toast(\'Copied\')">Copy all</button>' +
      '<div style="color:#9db3d6;font-size:13px;margin-top:10px">Send each person their own password privately. They choose their own the first time they log in. Close this page and these are gone.</div></div>';
    window.scrollTo(0, 0);
  };

  function showTemp(who, pw) {
    var b = document.getElementById('tempbox'); if (!b) return;
    b.innerHTML = '<div class="tempbox"><b>Temporary password for ' + e(who) + '</b><div style="margin:10px 0"><code>' + e(pw) + '</code></div><div style="color:#9db3d6;font-size:13px">Send it to them privately. It is shown once. They pick their own password the first time they log in.</div></div>';
    window.scrollTo(0, 0);
  }
  window.hqAddUser = async function () {
    var n = document.getElementById('nu_n').value, em = document.getElementById('nu_e').value, ro = document.getElementById('nu_r').value, ti = document.getElementById('nu_t').value;
    try { var r = await api('/api/admin/users', 'POST', { name: n, email: em, role: ro, title: ti }); await show('hq:team'); showTemp(r.user.name, r.temp_password); } catch (er) { toast(er.message); }
  };
  window.hqReset = async function (id) {
    if (!confirm('Reset this password? Their old password stops working.')) return;
    try { var r = await api('/api/admin/users/' + id + '/reset', 'POST', {}); var u = (HQ.users || []).filter(function (x) { return x.id === id; })[0]; await show('hq:team'); showTemp(u ? u.name : 'them', r.temp_password); } catch (er) { toast(er.message); }
  };
  window.hqTitle = async function (id) {
    var u = (HQ.users || []).filter(function (x) { return x.id === id; })[0]; var t = prompt('Job role for ' + (u ? u.name : 'this person') + ' (for example Web Developer, Ads Strategist):', (u && u.title) || '');
    if (t === null) return; try { await api('/api/admin/users/' + id + '/title', 'POST', { title: t }); show('hq:team'); } catch (er) { toast(er.message); }
  };
  window.hqLane = async function (lane, email) { if (!email) return; try { await api('/api/admin/lanes', 'POST', { lane: lane, email: email }); toast('Saved'); } catch (er) { toast(er.message); show('hq:team'); } };
  window.hqPipe = async function (id, on) { if (!confirm(on ? 'Let this person see the sales pipeline (prospects and outreach)?' : 'Hide the sales pipeline from this person?')) return; try { await api('/api/admin/users/' + id + '/pipeline', 'POST', { pipeline: on }); show('hq:team'); } catch (er) { toast(er.message); } };
  window.hqActive = async function (id, on) { try { await api('/api/admin/users/' + id + '/active', 'POST', { active: on }); show('hq:team'); } catch (er) { toast(er.message); } };


  async function loadMail(force) {
    if (!HQ.me || HQ.me.legacy) return;
    if (HQ.mailLoading) return; if (HQ.mail && !force) return;
    HQ.mailLoading = true;
    try { HQ.mail = await api('/api/me/mail'); } catch (er) { HQ.mail = { connected: false, error: er.message }; }
    HQ.mailLoading = false;
  }
  function ago2(ms) {
    var m = Math.round((Date.now() - ms) / 60000); if (m < 60) return Math.max(m, 1) + 'm'; var hr = Math.round(m / 60); if (hr < 24) return hr + 'h'; return Math.round(hr / 24) + 'd';
  }
  function mail() {
    var m = HQ.mail, me = HQ.me;
    var head = '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Mail</h3><p>Email from your clients, pulled from your own Gmail.</p></div></div>';
    if (!me || me.legacy) return head + '<div class="panel"><div class="empty">' + ico('mail') + 'Sign in with your own email to connect Gmail.</div></div>';
    if (!m) return head + '<div class="sk" style="height:140px"></div>';
    if (!m.connected) {
      return head + '<div class="panel" style="max-width:640px"><h3>Connect your Gmail</h3><p class="hint">The CRM reads your inbox to find email from client addresses and shows it here, so nothing from a client gets missed. It does not send, delete or change anything, and it only shows mail from addresses you have linked to a client. You can disconnect any time.</p>' +
        (m.configured === false ? '<div class="banner">' + ico('alert') + '<div>Google is not set up on the server yet.</div></div>' : '<a class="btn2 red" href="/api/me/gmail/connect">' + ico('mail') + 'Connect my Gmail</a>') + (m.error ? '<p style="color:var(--bad);margin-top:10px;font-size:13px">' + e(m.error) + '</p>' : '') + '</div>';
    }
    var byC = {}; (m.matched || []).forEach(function (x) { (byC[x.client.slug] = byC[x.client.slug] || { n: x.client.name, items: [] }).items.push(x); });
    var blocks = Object.keys(byC).map(function (k) {
      return '<div class="panel" style="margin-bottom:14px"><h3>' + e(byC[k].n) + '<span class="ct">' + byC[k].items.length + '</span></h3>' + byC[k].items.map(function (x) {
        return '<a class="mrow" href="https://mail.google.com/mail/u/' + encodeURIComponent(m.account || 0) + '/#inbox/' + e(x.thread) + '" target="_blank" rel="noopener"><i class="' + (x.unread ? 'un' : '') + '"></i><div><b>' + e(x.name) + '</b><span class="sj">' + e(x.subject) + '</span><span class="sn">' + e(x.snippet) + '</span></div><em>' + e(ago2(x.date)) + '</em></a>';
      }).join('') + '</div>';
    }).join('');
    var clientsList = (HQ.data && HQ.data.clients || []).filter(function (c) { return c.status !== 'internal'; });
    var isAdmin = me.role === 'admin';
    var unm = (m.unmatched || []).length ? '<div class="panel"><h3>Who are these?</h3><p class="hint">Senders from your inbox that are not linked to a client yet. Link a company to a client and its email shows up above.</p>' + m.unmatched.map(function (u, i) {
      return '<div class="urow"><div style="min-width:0"><b>' + e(u.domain) + '</b><div class="em2">' + e(u.count) + ' email' + (u.count > 1 ? 's' : '') + ' · ' + e(u.example) + '</div></div>' + (isAdmin ? '<select id="um' + i + '"><option value="">Choose client</option>' + clientsList.map(function (c) { return '<option value="' + e(c.slug) + '">' + e(c.name) + '</option>'; }).join('') + '</select><button class="btn2 line mini" onclick="hqLinkDomain(' + i + ',\'' + e(u.domain) + '\')">Link</button>' : '') + '</div>';
    }).join('') + '</div>' : '';
    return head + '<div class="mhead"><span>Connected as <b>' + e(m.account || me.email) + '</b> · ' + (m.unread || 0) + ' unread from clients</span><span><a class="lnk" onclick="hqMailRefresh()">Refresh</a> · <a class="lnk" onclick="hqMailOff()">Disconnect</a></span></div>' +
      (m.error ? '<div class="banner">' + ico('alert') + '<div>' + e(m.error) + '</div></div>' : '') +
      (blocks || '<div class="panel"><div class="empty">' + ico('inbox') + 'No client email in the last 14 days' + (isAdmin ? '. Link a sender below, or add email addresses on each client page.' : '.') + '</div></div>') + unm;
  }
  window.hqMailRefresh = async function () { HQ.mail = null; show('hq:mail'); };
  window.hqMailOff = async function () { if (!confirm('Disconnect your Gmail from the CRM?')) return; try { await api('/api/me/gmail/disconnect', 'POST', {}); HQ.mail = null; HQ.cal = null; show('hq:mail'); } catch (er) { toast(er.message); } };
  window.hqLinkDomain = async function (i, domain) {
    var slug = (document.getElementById('um' + i) || {}).value; if (!slug) { toast('Choose a client first'); return; }
    var c = HQ.data.clients.filter(function (x) { return x.slug === slug; })[0] || {};
    try { await api('/api/hq/client/' + slug, 'PUT', { domains: (c.domains || []).concat([domain]) }); toast('Linked'); HQ.data = null; HQ.mail = null; await fetchHq(false); show('hq:mail'); } catch (er) { toast(er.message); }
  };


  // ---- client page tabs: Overview, Content, Brain, Guidelines ----
  var DRIVE_ROOT = 'https://drive.google.com/drive/folders/1WD7bOn5UUWQ69L6ftSwRTHulK8i_TeiK';
  function tabsBar(c) {
    var t = function (k, l) { return '<button class="tb ' + ((HQ.ctab || 'overview') === k ? 'on' : '') + '" onclick="hqCTab(\'' + k + '\')">' + l + '</button>'; };
    return '<div class="tabs" style="margin-top:4px">' + t('overview', 'Overview') + t('content', 'Content') + t('pack', 'Weekly pack') + t('copy', 'Copy') + t('brain', 'Brain') + t('formats', 'Formats') + t('look', 'Look') + t('guides', 'Guidelines') + '</div>';
  }
  window.hqCTab = function (k) { HQ.ctab = k; show(navKey); };
  function tabBody(c) { var t = HQ.ctab; return t === 'content' ? contentTab(c) : t === 'pack' ? packTab(c) : t === 'copy' ? copyTab(c) : t === 'brain' ? brainTab(c) : t === 'guides' ? guidesTab(c) : t === 'formats' ? formatsTab(c) : t === 'look' ? lookTab(c) : ''; }
  function linksPanel(c) {
    var rows = [];
    if (c.drive) rows.push(['Drive: ' + c.name, 'https://drive.google.com/drive/folders/' + c.drive]);
    rows.push(['Drive: all clients', DRIVE_ROOT]);
    if (c.work && c.work.linked) rows.push(['Basecamp project', c.work.project.url]);
    if (c.website) rows.push(['Website', c.website]);
    return '<div class="panel"><h3>Folders and links</h3>' + rows.map(function (r) { return '<div class="kv"><span>' + e(r[0]) + '</span><a class="lnk" href="' + e(r[1]) + '" target="_blank" rel="noopener">Open</a></div>'; }).join('') + '</div>';
  }
  function clientEvents(c) {
    var ev = (HQ.cal && HQ.cal.events) || [], keys = (c.match || []).concat([(c.name || '').toLowerCase()]).filter(Boolean).map(function (k) { return k.toLowerCase(); });
    return ev.filter(function (x) { var t = (x.title + ' ' + (x.project || '')).toLowerCase(); return keys.some(function (k) { return t.indexOf(k) > -1; }); });
  }
  function contentTab(c) {
    var d = HQ.content[c.slug], me = HQ.me, cal = HQ.cal;
    var evs = clientEvents(c), calHtml;
    if (!me || me.legacy) calHtml = '<div class="empty">Sign in with your own login to see the calendar.</div>';
    else if (!cal || !cal.connected) calHtml = '<div class="empty">' + ico('clock') + 'Connect Google on the Mail page to see filming dates.</div>';
    else if (!evs.length) calHtml = '<div class="empty">' + ico('check') + 'Nothing on the calendar for ' + e(c.name) + ' in the next two weeks.</div>';
    else calHtml = evs.slice(0, 8).map(function (x) { var dt = evDate(x); return '<a class="ev2" href="' + e(x.link) + '" target="_blank" rel="noopener" style="--ec:' + e(x.color || '#13233f') + '"><span class="tm">' + e(dayLabel(dt) + (x.allDay ? '' : ', ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))) + '</span><div><b>' + e(x.title) + '</b>' + (x.where ? '<span class="wh">' + e(x.where) + '</span>' : '') + '</div><em>' + e(x.project || x.cal) + '</em></a>'; }).join('');
    var body;
    if (!d) body = '<div class="sk" style="height:160px"></div>';
    else if (d.legacy || d.connected === false) body = '<div class="empty">' + ico('mail') + 'Connect your Google account on the Mail page to see uploads.</div>';
    else if (d.noFolder) body = '<div class="empty">' + ico('inbox') + 'No Drive folder is linked to this client yet.</div>';
    else if (d.needsDrive) body = '<div class="empty">' + ico('alert') + (d.apiOff ? 'Google Drive is not turned on for this project yet. In Google Cloud, open APIs & Services, then Library, search Google Drive API and click Enable.' : 'Drive access was not granted. On the Mail page click Disconnect, then connect Google again and allow Drive.') + '</div>';
    else if (d.error) body = '<div class="empty">' + ico('alert') + e(d.error) + '</div>';
    else if (!d.weeks.length && !(d.unnamed || []).length) body = '<div class="empty">' + ico('check') + 'No files in the Reels, Drone or Photos folders.</div>';
    else body = d.weeks.map(function (w) {
      var g = {}, order = []; w.items.forEach(function (x) { var k = [x.type, x.label, x.subject, x.shot, x.uploaded].join('|'); if (!g[k]) { g[k] = { x: x, n: 0 }; order.push(k); } g[k].n++; });
      var byLabel = {}; w.items.forEach(function (x) { var k = x.type + ' ' + x.label; byLabel[k] = (byLabel[k] || 0) + 1; });
      var sum = Object.keys(byLabel).map(function (k) { return '<span class="chip">' + byLabel[k] + ' ' + e(k) + '</span>'; }).join(' ');
      var rows = order.slice(0, 6).map(function (k) { var x = g[k].x, n = g[k].n; return '<div class="td"><div style="min-width:0"><a href="' + e(x.url) + '" target="_blank" rel="noopener">' + e(x.subject) + ' · ' + e(x.label) + '</a><div class="who">' + e(x.type) + ' · shot ' + e(dshort(x.shot.slice(0, 4) + '-' + x.shot.slice(4, 6) + '-' + x.shot.slice(6, 8))) + ' · uploaded ' + e(dshort(x.uploaded)) + '</div></div><span class="due">' + (n > 1 ? '<b>' + n + ' files</b> · ' : '') + 'Due ' + e(dshort(x.due)) + '</span></div>'; }).join('');
      return '<div style="margin-bottom:20px"><div class="list-h"><b>Week of ' + e(dshort(w.week)) + '</b><span>' + w.items.length + ' file' + (w.items.length > 1 ? 's' : '') + '</span></div><div class="chips" style="margin:0 0 6px">' + sum + '</div>' + rows + (order.length > 6 ? '<div class="hint" style="margin:8px 0 0">+ ' + (order.length - 6) + ' more groups. Open the Drive folder for the rest.</div>' : '') + '</div>';
    }).join('') + ((d.unnamed || []).length ? '<div class="note2" style="margin-top:6px"><b>' + d.unnamed.length + ' file' + (d.unnamed.length > 1 ? 's' : '') + ' need renaming</b> to the standard (CLIENT_TYPE_DATE_Subject_LABEL_001) before they can be filed: ' + d.unnamed.slice(0, 5).map(function (u) { return '<a class="lnk" href="' + e(u.url) + '" target="_blank" rel="noopener">' + e(u.name) + '</a>'; }).join(', ') + '</div>' : '');
    var folders = (d && d.folders && d.folders.length ? d.folders.map(function (f) { return '<a class="chip" style="text-decoration:none" href="' + e(f.url) + '" target="_blank" rel="noopener">' + e(f.name) + '</a>'; }).join(' ') : '');
    return '<div class="two"><div class="panel"><h3>Content by week</h3><p class="hint">Uploaded footage grouped by shoot day, subject and label. Due is 10 business days after upload.</p>' + body + '</div><div style="display:grid;gap:16px">' +
      '<div class="panel"><h3>Next on the calendar</h3>' + calHtml + '</div>' + linksPanel(c) + (folders ? '<div class="panel"><h3>Drive folders</h3><div class="chips" style="margin-top:6px">' + folders + '</div></div>' : '') + '</div></div>';
  }
  function nextShootDate(c) {
    var evs = clientEvents(c).filter(function (x) { return /shoot|film/i.test(x.title + ' ' + x.cal); });
    if (!evs.length) return ''; var d = evDate(evs[0]); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function shotText(l) {
    var n = function (a, f) { return a.map(function (x, i) { return (i + 1) + '. ' + f(x); }).join('\n'); };
    return l.name + '\n\nTALKING HEAD SCRIPTS TO FILM\n' + n(l.hooks, function (h) { return scriptText(h); }) + '\n\nB-ROLL TO GET\n' + n(l.broll, function (b) { return b.shot; }) + '\n\nPHOTOS TO GET\n' + n(l.photos, function (p) { return p.shot + (p.label ? ' (' + p.label + ')' : ''); }) + '\n\nMUST-GETS\n' + n(l.mustgets, function (m) { return m.shot + (m.for ? ' (for ' + m.for + ')' : ''); }) + (l.notes ? '\n\nNOTES\n' + l.notes : '');
  }
  function shotPanel(c) {
    var lists = HQ.shots[c.slug], me = HQ.me, real = me && !me.legacy;
    var sel = HQ.shotSel[c.slug], l = lists && lists.length ? (lists.filter(function (x) { return x.id === sel; })[0] || lists[0]) : null;
    var def = nextShootDate(c);
    var bar = real ? '<div class="shbar"><div><label for="sh_d">Shoot date</label><input id="sh_d" type="date" value="' + e(def || (l ? l.date : '')) + '"></div><button class="btn2 red" id="sh_b" onclick="hqGenShot(\'' + e(c.slug) + '\')">' + ico('refresh') + (l ? 'Rewrite now' : 'Write one now') + '</button>' + (def ? '<span class="hint" style="margin:0">Next shoot on the calendar: ' + e(dshort(def)) + '</span>' : '') + '</div>' : '<div class="empty" style="padding:8px 0">Sign in with your own login to write shot lists.</div>';
    var body = '';
    if (l) {
      var sec = function (title, items) { return '<div class="shsec"><h4>' + title + '</h4>' + items + '</div>'; };
      body = '<div class="shhead"><span class="chip st-internal">' + e(l.name) + '</span>' + lists.map(function (x) { return '<a class="chip' + (x.id === l.id ? ' st-active' : '') + '" style="cursor:pointer;text-decoration:none" onclick="hqShotSel(\'' + e(c.slug) + '\',\'' + e(x.id) + '\')">' + e(dshort(x.date)) + '</a>'; }).join('') + '<span class="hint" style="margin:0 0 0 auto">Written ' + e(new Date(l.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + ' · ' + (l.basis && l.basis.working ? 'from top posts' : 'no top-post data') + (l.basis && l.basis.archive ? ' + archive gaps' : '') + '</span></div>' +
        sec('Talking head scripts to film', l.hooks.map(function (x, i) { return '<div class="shi cpy" title="Click to copy the full script" data-copy="' + e(scriptText(x)) + '"><span class="pn">' + (i + 1) + '</span><div><b>Hook: ' + e(x.hook) + '</b>' + (x.body && x.body.length ? '<ol style="margin:6px 0 4px 18px;padding:0;font-size:13.5px">' + x.body.map(function (b) { return '<li>' + e(b) + '</li>'; }).join('') + '</ol>' : '') + (x.cta ? '<div style="font-size:13.5px"><b>CTA:</b> ' + e(x.cta) + '</div>' : '') + (x.onscreen ? '<div style="font-size:13px;color:#4a5468"><b>Text on screen:</b> ' + e(x.onscreen) + '</div>' : '') + '<div class="who">' + (x.level ? '<span class="chip">Level ' + x.level + '</span> ' : '') + (x.mimic ? 'Copies: ' + e(x.mimic) : '') + (x.why ? ' · ' + e(x.why) : '') + '</div>' + (x.verify && x.verify.length ? '<div class="vf">VERIFY: ' + e(x.verify.join('; ')) + '</div>' : '') + '</div></div>'; }).join('')) +
        sec('B-roll to get', l.broll.map(function (x, i) { return '<div class="shi"><span class="pn">' + (i + 1) + '</span><div><b>' + e(x.shot) + '</b>' + (x.why ? '<div class="who">' + e(x.why) + '</div>' : '') + '</div></div>'; }).join('')) +
        sec('Photos to get', l.photos.map(function (x, i) { return '<div class="shi"><span class="pn">' + (i + 1) + '</span><div><b>' + e(x.shot) + '</b>' + (x.label ? '<div class="who"><span class="chip">' + e(x.label) + '</span></div>' : '') + '</div></div>'; }).join('')) +
        sec('Must-gets', l.mustgets.map(function (x, i) { return '<div class="shi"><span class="pn">' + (i + 1) + '</span><div><b>' + e(x.shot) + '</b>' + (x.for ? '<div class="who">For: ' + e(x.for) + '</div>' : '') + '</div></div>'; }).join('')) +
        (l.notes ? '<p class="hint">' + e(l.notes) + '</p>' : '') +
        '<div class="shfoot"><button class="btn2 line" data-copy="' + e(shotText(l)) + '" onclick="navigator.clipboard.writeText(this.getAttribute(\'data-copy\'));toast(\'Shot list copied\')">Copy the shot list</button>' + (real ? '<button class="btn2 line" onclick="hqShotTask(\'' + e(c.slug) + '\',\'' + e(l.id) + '\')">' + ico('task') + 'Send to the field team</button>' : '') + '</div>';
    } else body = '<div class="empty" style="padding:14px 0">' + ico('clipboard') + 'No shot list yet. Pick the shoot date and write one. It uses this client\'s top posts, what is working in their industry and what is missing from the archive.</div>';
    return '<div class="panel" style="margin-bottom:16px"><h3>Shot list</h3><p class="hint" style="margin-top:0">Written automatically on the Monday of any week a shoot is on the film calendar, and sent to the field team. Named CLIENT_SHOTLIST_DATE. Click a hook to copy it.</p>' + (HQ.genErr ? '<div class="banner">' + ico('alert') + '<div>' + e(HQ.genErr) + '</div></div>' : '') + '' + bar + body + '</div>';
  }
  function workingPanel(c) {
    var md = HQ.working[c.slug], admin = HQ.me && HQ.me.role === 'admin';
    var head = '<div class="ph"><h3>What is working now</h3>' + (admin ? '<a class="lnk" onclick="hqWorkEdit(\'' + e(c.slug) + '\')">Update</a>' : '') + '</div>';
    if (HQ.workEdit === c.slug) return '<div class="panel" style="margin-bottom:16px">' + head + '<p class="hint">Paste the latest top posts or results. The next shot list will use this.</p><textarea id="wk_t" rows="10" style="width:100%;padding:12px;border:1px solid var(--hair2);border-radius:10px;font:13px/1.5 ui-monospace,Menlo,monospace">' + e(md || '') + '</textarea><div style="margin-top:10px;display:flex;gap:8px"><button class="btn2 red" onclick="hqWorkSave(\'' + e(c.slug) + '\')">Save</button><button class="btn2 line" onclick="hqWorkEdit(\'\')">Cancel</button></div></div>';
    return '<div class="panel md" style="margin-bottom:16px">' + head + (md ? mdHtml(md) : '<div class="empty" style="padding:10px 0">Nothing pulled yet. Paste this client\'s top posts and the shot list will build on them.</div>') + '</div>';
  }

  async function pollJob(id, onWait) {
    for (var i = 0; i < 100; i++) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      var j; try { j = await api('/api/hq/jobs/' + id); } catch (x) { continue; }
      if (j.status === 'done') return true;
      if (j.status === 'error') throw new Error(j.error || 'It failed. Try again.');
      if (onWait) onWait(i);
    }
    throw new Error('This is taking too long. Try again in a minute.');
  }
  window.hqShotSel = function (slug, id) { HQ.shotSel[slug] = id; show(navKey); };
  window.hqWorkEdit = function (slug) { HQ.workEdit = slug; show(navKey); };
  window.hqWorkSave = async function (slug) { var v = (document.getElementById('wk_t') || {}).value || ''; try { await api('/api/hq/working/' + slug, 'PUT', { md: v }); HQ.working[slug] = v; HQ.workEdit = ''; toast('Saved'); show(navKey); } catch (er) { toast(er.message); } };
  window.hqGenShot = async function (slug) {
    var d = (document.getElementById('sh_d') || {}).value || ''; var b = document.getElementById('sh_b');
    if (!d) { toast('Pick the shoot date first'); return; }
    if (b) { b.disabled = true; b.textContent = 'Writing... about a minute'; }
    try { var r = await api('/api/hq/shotlists/' + slug, 'POST', { date: d }); await pollJob(r.job, function (i) { if (b) b.textContent = 'Writing... ' + (i * 3 + 3) + 's'; }); HQ.shots[slug] = (await api('/api/hq/shotlists/' + slug)).lists; HQ.shotSel[slug] = (HQ.shots[slug][0] || {}).id; await refreshTasks(); toast('Shot list ready and sent to the field team'); } catch (er) { HQ.genErr = er.message; toast(er.message); }
    show(navKey);
  };
  window.hqShotTask = async function (slug, id) { try { var r = await api('/api/hq/shotlists/' + slug + '/' + id + '/task', 'POST', {}); await refreshTasks(); toast('Sent to ' + r.owner); } catch (er) { toast(er.message); } };

  // ---- Weekly pack ----
  function mondayStr(off) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * off); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function defaultWeek() { var dow = new Date().getDay(); return mondayStr(dow === 0 || dow >= 4 ? 1 : 0); }
  function packText(c, p) {
    return c.name + ', week of ' + p.week + (p.theme ? '\nTheme: ' + p.theme : '') + '\n\n' + p.rows.map(function (r, i) {
      return (i + 1) + '. ' + r.date + ' ' + r.type + (r.time ? ' (' + r.time + ')' : '') + (r.trigger ? ' [' + r.trigger + ']' : '') + '\nIdea: ' + r.idea + '\nHook: ' + r.hook + '\nShots: ' + r.shots.join('; ') + '\nOn-screen: ' + r.onscreen + (r.design ? '\nDesign: ' + r.design : '') + '\nCaption: ' + r.caption.hook + '\n' + r.caption.body + '\n' + r.caption.cta + (r.verify.length ? '\nVERIFY: ' + r.verify.join('; ') : '');
    }).join('\n\n');
  }
  function winnersPanel(c) {
    var ws = (HQ.winners && HQ.winners[c.slug]) || [];
    return '<div class="panel"><h3>Winners</h3><p class="hint" style="margin-top:0">Posts that clearly worked. They become proven formats in the next packs and a task for the ads owner to add them to the campaign concept, angle and creatives. Nothing is boosted.</p>' +
      (ws.length ? ws.slice(0, 6).map(function (w) { return '<div class="kv"><span><b>' + e(w.post) + '</b> ' + (w.platform ? '(' + e(w.platform) + ')' : '') + (w.why ? '<br><span class="hint" style="margin:0">' + e(w.why) + '</span>' : '') + '</span><span class="hint" style="margin:0">' + e(dshort(w.at.slice(0, 10))) + '</span></div>'; }).join('') : '<p class="hint">None marked yet.</p>') +
      '<details class="sm" style="margin-top:10px"><summary>Mark a winner</summary><div class="ed"><label>Which post (link or short description)</label><input id="wn_p"><label>Platform</label><input id="wn_pl" placeholder="Instagram, Facebook, TikTok"><label>Why it worked (numbers if you have them)</label><input id="wn_w"><label>Concept</label><input id="wn_c"><label>Angle</label><input id="wn_a"><button class="btn2 red" style="margin-top:10px" onclick="hqWinner(\'' + e(c.slug) + '\')">Save winner</button></div></details></div>';
  }
  window.hqWinner = async function (slug) {
    var v = function (id) { return (document.getElementById(id) || {}).value || ''; };
    try { var r = await fetch('/api/hq/winners/' + slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ post: v('wn_p'), platform: v('wn_pl'), why: v('wn_w'), concept: v('wn_c'), angle: v('wn_a') }) }); var j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not save'); HQ.winners[slug] = null; HQ.winners[slug] = (await api('/api/hq/winners/' + slug)).winners; toast(j.task ? 'Saved, and a task was added for the ads owner' : 'Saved'); show(navKey); } catch (x) { toast(String(x.message || x)); }
  };
  function promoPanel(c, promos) {
    var admin = HQ.me && HQ.me.role === 'admin';
    var rows = (promos || []).map(function (p, i) { return '<div class="kv"><span><b>' + e(p.name) + '</b> ' + e(dshort(p.start)) + (p.end && p.end !== p.start ? ' to ' + e(dshort(p.end)) : '') + (p.details ? '<br><small style="color:var(--mut)">' + e(p.details) + '</small>' : '') + '</span><span style="white-space:nowrap">' + (p.confirmed ? '<span class="chip st-active">Client confirmed</span>' : '<span class="chip need">Not confirmed</span>') + (admin ? ' <a class="lnk" onclick="hqPromoDel(\'' + e(c.slug) + '\',' + i + ')">Remove</a>' : '') + '</span></div>'; }).join('');
    var form = admin ? '<details class="sm" style="margin-top:10px"><summary>Add a promo</summary><div class="ed"><label>Name</label><input id="pm_n" placeholder="e.g. Black Friday free install"><label>Starts</label><input id="pm_s" type="date"><label>Ends</label><input id="pm_e" type="date"><label>Exact offer and terms</label><input id="pm_d" placeholder="Offer, price, deadline, fine print, as the client wrote it"><label class="cb"><input type="checkbox" id="pm_c"> The client confirmed this in writing</label><button class="btn2 red" style="margin-top:8px" onclick="hqPromoAdd(\'' + e(c.slug) + '\')">Add</button></div></details>' : '';
    return '<div class="panel" style="margin-bottom:16px"><h3>Promos</h3><p class="hint" style="margin-top:0">A promo only gets posts once the client confirms the offer, dates and terms in writing. The pack starts teasing it 7 days before.</p>' + (rows || '<div class="empty" style="padding:8px 0;text-align:left">No promos on the books.</div>') + form + '</div>';
  }
  function packTab(c) {
    var me = HQ.me, real = me && !me.legacy, data = HQ.packs[c.slug], wk = HQ.packWeek[c.slug] || defaultWeek();
    if (!data) return '<div class="sk" style="height:220px"></div>';
    var cadDays = (c.cadence && c.cadence.days) || [], pack = (data.packs || []).filter(function (x) { return x.week === wk; })[0];
    var chips = [0, 1, 2, 3].map(function (k) { var m = mondayStr(k), has = (data.packs || []).some(function (x) { return x.week === m; }); return '<a class="chip' + (m === wk ? ' st-internal' : '') + '" style="cursor:pointer;text-decoration:none" onclick="hqPackWeek(\'' + e(c.slug) + '\',\'' + m + '\')">' + (k === 0 ? 'This week' : k === 1 ? 'Next week' : 'Week of ' + e(dshort(m))) + (has ? ' ✓' : '') + '</a>'; }).join(' ');
    var hl = (HQ.hols[wk] || []).map(function (h) { return '<span class="chip st-seasonal">' + e(h.name) + ' ' + e(dshort(h.date)) + '</span>'; }).join(' ');
    var bar = '<div class="shbar"><div style="flex:1;min-width:240px"><label>Week</label><div class="chips" style="margin:0">' + chips + '</div></div>' +
      (real && cadDays.length ? '<button class="btn2 red" id="pk_b" onclick="hqPackGen(\'' + e(c.slug) + '\')">' + ico('refresh') + (pack ? 'Rewrite this week' : 'Write this week') + '</button>' : '') +
      (real && pack && !pack.released ? '<button class="btn2 line" onclick="hqPackRelease(\'' + e(c.slug) + '\')">' + ico('task') + 'Release to the team</button>' : '') + '</div>';
    var gerr = HQ.genErr ? '<div class="banner">' + ico('alert') + '<div><b>Could not write it.</b> ' + e(HQ.genErr) + '</div></div>' : '';
    var warn = gerr + (!cadDays.length ? '<div class="banner">' + ico('alert') + '<div><b>No posting days set for ' + e(c.name) + '.</b> Open the Overview tab, then Edit details, and tick the days they post.</div></div>' : '');
    var meta = '<div class="hint" style="margin:0 0 10px">Posting ' + e(cadDays.join(', ') || 'days not set') + (c.cadence && c.cadence.note ? ' · ' + e(c.cadence.note) : '') + '</div>' + (hl ? '<div class="chips" style="margin:0 0 12px"><span class="hint" style="margin:0">National holidays this week:</span> ' + hl + '</div>' : '');
    var stale = pack && pack.stale ? '<div class="banner">' + ico('alert') + '<div>A promo changed after this pack was written. Rewrite it so the posts match.</div></div>' : '';
    var rel = pack && pack.released ? '<div class="note2" style="margin:0 0 12px">Released to the team ' + e(new Date(pack.released.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '. Editing, design and caption tasks are on their Work pages.</div>' : '';
    var body;
    if (!pack) body = '<div class="empty" style="padding:14px 0">' + ico('clipboard') + 'No pack for this week yet. It writes one post for every posting day, from the brain, the confirmed facts, what is working, the holidays and the promos.</div>';
    else body = (pack.theme ? '<p class="hint" style="margin:0 0 10px"><b>Theme:</b> ' + e(pack.theme) + '</p>' : '') + pack.rows.map(function (r) {
      var d = new Date(r.date + 'T12:00:00');
      return '<div class="pk"><div class="pkd"><b>' + e(d.toLocaleDateString('en-US', { weekday: 'short' })) + '</b><span>' + e(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span><em>' + e(r.type) + '</em></div><div class="pkb">' +
        '<div class="chips" style="margin:0 0 6px">' + (r.planned && r.topic ? '<span class="chip st-active">Plan: ' + e(r.topic) + '</span>' : '') + (r.trigger ? '<span class="chip st-seasonal">' + e(r.trigger) + '</span>' : '') + (r.level ? '<span class="chip">Level ' + r.level + '</span>' : '') + (r.design ? '<span class="chip st-internal">' + e(r.design) + '</span>' : '') + (r.platforms ? '<span class="chip">' + e(r.platforms) + '</span>' : '') + (r.time ? '<span class="chip">' + e(r.time) + '</span>' : '') + '</div>' +
        '<div class="pkh cpy" title="Click to copy" data-copy="' + e(r.hook) + '">' + e(r.hook || '(no hook)') + '</div>' + (r.idea ? '<div class="pks">' + e(r.idea) + '</div>' : '') +
        (r.shots.length ? '<div class="pkl"><b>' + (r.type === 'Reel' ? 'Shots / archive pull' : 'Visuals') + '</b><ul>' + r.shots.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul></div>' : '') +
        (r.onscreen ? '<div class="pkl"><b>' + (/carousel|graphic/i.test(r.type||'') ? (/carousel/i.test(r.type||'') ? 'Card text' : 'Text on graphic') : 'On-screen text') + '</b> ' + e(r.onscreen) + '</div>' : '') +
        '<div class="pkc cpy" title="Click to copy the caption" data-copy="' + e(r.caption.hook + '\n\n' + r.caption.body + '\n\n' + r.caption.cta + (r.hashtags && r.hashtags.length ? '\n\n' + r.hashtags.join(' ') : '')) + '"><b>Caption</b><br>' + e(r.caption.hook) + '<br>' + e(r.caption.body) + '<br><u>' + e(r.caption.cta) + '</u>' + (r.hashtags && r.hashtags.length ? '<br><span class="hint">' + e(r.hashtags.join(' ')) + '</span>' : '') + '</div>' +
        (r.basis ? '<div class="pkl"><b>Why:</b> ' + e(r.basis) + '</div>' : '') + (r.gates.length ? '<div class="pkl"><b>Gates:</b> ' + e(r.gates.join('; ')) + '</div>' : '') + (r.verify.length ? '<div class="vf">VERIFY: ' + e(r.verify.join('; ')) + '</div>' : '') +
        (r.missing ? '<div class="vf">The AI skipped this slot. Rewrite the week.</div>' : '') + '</div></div>';
    }).join('') + (pack.notes ? '<p class="hint">' + e(pack.notes) + '</p>' : '') + '<div class="shfoot"><button class="btn2 line" data-copy="' + e(packText(c, pack)) + '" onclick="navigator.clipboard.writeText(this.getAttribute(\'data-copy\'));toast(\'Pack copied\')">Copy the whole week</button></div>';
    return '<div class="two"><div class="panel"><h3>Weekly pack</h3><p class="hint" style="margin-top:0">Written from this client\'s brain, delivered one week at a time. Click a hook or a caption to copy it.</p>' + warn + bar + meta + stale + rel + body + '</div><div style="display:grid;gap:16px">' + promoPanel(c, data.promos) + winnersPanel(c) + '</div></div>';
  }
  window.hqPackWeek = async function (slug, w) { HQ.packWeek[slug] = w; await loadHols(w); show(navKey); };
  async function loadHols(w) { if (HQ.hols[w]) return; try { var to = new Date(w + 'T12:00:00'); to.setDate(to.getDate() + 6); var t = to.getFullYear() + '-' + ('0' + (to.getMonth() + 1)).slice(-2) + '-' + ('0' + to.getDate()).slice(-2); HQ.hols[w] = (await api('/api/hq/holidays?from=' + w + '&to=' + t)).holidays; } catch (x) { HQ.hols[w] = []; } }
  window.hqPackGen = async function (slug) {
    var w = HQ.packWeek[slug] || defaultWeek(), b = document.getElementById('pk_b');
    if (b) { b.disabled = true; b.textContent = 'Writing the week... about a minute'; }
    try { var r = await api('/api/hq/packs/' + slug, 'POST', { week: w }); await pollJob(r.job, function (i) { if (b) b.textContent = 'Writing the week... ' + (i * 3 + 3) + 's'; }); HQ.packs[slug] = await api('/api/hq/packs/' + slug); HQ.genErr = ''; toast('Pack ready'); } catch (er) { HQ.genErr = er.message; toast(er.message); }
    show(navKey);
  };
  window.hqPackRelease = async function (slug) {
    var w = HQ.packWeek[slug] || defaultWeek(); if (!confirm('Create the editing, design and caption tasks for this week now?')) return;
    try { var r = await api('/api/hq/packs/' + slug + '/' + w + '/release', 'POST', {}); HQ.packs[slug] = await api('/api/hq/packs/' + slug); await refreshTasks(); toast(r.tasks.length + ' tasks created'); } catch (er) { toast(er.message); }
    show(navKey);
  };
  async function savePromos(slug, list) { await api('/api/hq/client/' + slug + '/promos', 'PUT', { promos: list }); HQ.packs[slug] = await api('/api/hq/packs/' + slug); }
  window.hqPromoAdd = async function (slug) {
    var g = function (i) { return (document.getElementById(i) || {}).value || ''; }, cur = (HQ.packs[slug] && HQ.packs[slug].promos) || [];
    if (!g('pm_n') || !g('pm_s')) { toast('Add a name and a start date'); return; }
    try { await savePromos(slug, cur.concat([{ name: g('pm_n'), start: g('pm_s'), end: g('pm_e') || g('pm_s'), details: g('pm_d'), confirmed: !!(document.getElementById('pm_c') || {}).checked }])); toast('Promo saved'); show(navKey); } catch (er) { toast(er.message); }
  };
  window.hqPromoDel = async function (slug, i) { var cur = ((HQ.packs[slug] && HQ.packs[slug].promos) || []).slice(); cur.splice(i, 1); try { await savePromos(slug, cur); show(navKey); } catch (er) { toast(er.message); } };

  function copyTab(c) {
    var md = HQ.copy[c.slug];
    var ideas = factsPanel(c) + shotPanel(c) + workingPanel(c);
    if (md == null) return ideas + '<div class="sk" style="height:200px"></div>';
    if (!md) return ideas + '<div class="panel"><div class="empty">' + ico('inbox') + 'No copy research for ' + e(c.name) + ' yet.</div></div>';
    return ideas + '<div class="panel md"><p class="hint" style="margin-top:0">Click any headline idea to copy it. Anything marked VERIFY needs the client to confirm before it runs.</p>' + mdHtml(md) + '</div>';
  }
  function brainTab(c) {
    var md = HQ.brain[c.slug];
    if (md == null) return '<div class="sk" style="height:200px"></div>';
    if (!md) return '<div class="panel"><div class="empty">' + ico('inbox') + 'No brain file for ' + e(c.name) + ' yet.</div></div>';
    return factsPanel(c) + '<div class="panel md">' + mdHtml(md) + '</div>';
  }
  function factsPanel(c) {
    var f = HQ.facts[c.slug], admin = HQ.me && HQ.me.role === 'admin';
    var head = '<div class="ph"><h3>' + ico('check') + ' Confirmed facts</h3>' + (admin ? '<a class="lnk" onclick="hqFactsEdit(\'' + e(c.slug) + '\')">Edit</a>' : '') + '</div><p class="hint" style="margin-top:0">What the team has verified about ' + e(c.name) + '. These override everything in the brain below and drive the shot lists.</p>';
    if (HQ.factsEdit === c.slug) return '<div class="panel" style="margin-bottom:16px;border-left:4px solid var(--ok)">' + head + '<textarea id="fx_t" rows="8" style="width:100%;padding:12px;border:1px solid var(--hair2);border-radius:10px;font:14px/1.5 Inter,sans-serif" placeholder="One fact per line, for example: We do wall graphics, storefronts and wraps.">' + e(f || '') + '</textarea><div style="margin-top:10px;display:flex;gap:8px"><button class="btn2 red" onclick="hqFactsSave(\'' + e(c.slug) + '\')">Save</button><button class="btn2 line" onclick="hqFactsEdit(\'\')">Cancel</button></div></div>';
    return '<div class="panel md" style="margin-bottom:16px;border-left:4px solid ' + (f ? 'var(--ok)' : 'var(--warn)') + '">' + head + (f ? mdHtml(f) : '<div class="empty" style="padding:6px 0;text-align:left">Not confirmed yet. Add what ' + e(c.name) + ' really does, and the shot lists will follow it.</div>') + '</div>';
  }
  window.hqFactsEdit = function (slug) { HQ.factsEdit = slug; show(navKey); };
  window.hqFactsSave = async function (slug) { var v = (document.getElementById('fx_t') || {}).value || ''; try { await api('/api/hq/facts/' + slug, 'PUT', { md: v }); HQ.facts[slug] = v; HQ.factsEdit = ''; toast('Saved'); show(navKey); } catch (er) { toast(er.message); } };
  function scriptText(x) { return 'HOOK: ' + x.hook + (x.body && x.body.length ? '\nBODY:\n- ' + x.body.join('\n- ') : '') + (x.cta ? '\nCTA: ' + x.cta : '') + (x.onscreen ? '\nTEXT ON SCREEN: ' + x.onscreen : ''); }
  function lookTab(c) {
    var L = HQ.look && HQ.look[c.slug]; if (L == null) return '<div class="sk" style="height:200px"></div>';
    if (L.none) return '<div class="panel"><h3>Look</h3><p class="hint" style="margin-top:0">No visual guide built for this client yet. It needs the palette, fonts, a feed grid and saved reference images.</p></div>';
    var e = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); };
    var sw = (L.palette || []).map(function (p) { return '<div style="flex:1;min-width:140px;border:1px solid #e3e3e8;border-radius:10px;overflow:hidden"><div style="background:' + e(p.hex) + ';height:64px"></div><div style="padding:8px 10px"><b>' + e(p.name) + '</b> <code>' + e(p.hex) + '</code><div class="hint" style="margin:4px 0 0">' + e(p.use) + '</div></div></div>'; }).join('');
    var wk = (L.weekly || []).map(function (w) { return '<div style="flex:1;min-width:150px;border:1px solid #e3e3e8;border-radius:10px;padding:8px 10px"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + e(w.accent) + ';border:1px solid #ccc;vertical-align:-2px"></span> <b>' + e(w.week) + ': ' + e(w.name) + '</b><div class="hint" style="margin:4px 0 0">' + e(w.note) + '</div></div>'; }).join('');
    var gr = (L.grid || []).map(function (g) { return '<div style="aspect-ratio:4/5;background:' + e(g.bg) + ';color:' + e(g.fg) + ';display:flex;flex-direction:column;justify-content:flex-end;padding:8px;font-weight:800;font-size:12px;line-height:1.1;text-transform:uppercase"><span style="font-size:9px;opacity:.7;font-weight:600">' + e(g.t) + '</span>' + e(g.text) + '</div>'; }).join('');
    var rf = (L.refs || []).map(function (r) { return '<div style="flex:1;min-width:200px;max-width:280px"><a href="' + e(r.url) + '" target="_blank" rel="noopener"><img src="' + e(r.img) + '" alt="' + e(r.label) + '" style="width:100%;border-radius:10px;border:1px solid #e3e3e8" onerror="this.style.display=\'none\'"></a><div style="margin-top:6px"><b>' + e(r.label) + '</b></div><div class="hint" style="margin:2px 0 0">' + e(r.note) + '</div></div>'; }).join('');
    var pal = (L.palette || []).filter(function (p) { return p.name !== 'White'; });
    var gridData = (L.grid && L.grid.length) ? L.grid : (function () { var kinds = ['Reel cover', 'Photo', 'Graphic', 'Photo', 'Reel cover', 'Review card', 'Big number', 'Reel cover', 'Photo'], out = []; for (var i = 0; i < 9; i++) { var a = pal[i % (pal.length || 1)] || { hex: '#222' }, dark = i % 3 === 1; out.push({ t: kinds[i], bg: dark ? '#2b2f3a' : a.hex, fg: '#ffffff', text: dark ? 'Real photo' : 'Headline here' }); } return out; })();
    gr = gridData.map(function (g) { return '<div style="aspect-ratio:4/5;background:' + e(g.bg) + ';color:' + e(g.fg) + ';display:flex;flex-direction:column;justify-content:flex-end;padding:8px;font-weight:800;font-size:12px;line-height:1.1;text-transform:uppercase"><span style="font-size:9px;opacity:.7;font-weight:600">' + e(g.t) + '</span>' + e(g.text) + '</div>'; }).join('');
    var R = L.reel || { bg: '#14141a', hook: '#ffffff', hl: '#ffffff' };
    var band = function (top, h, label) { return '<div style="position:absolute;left:0;right:0;top:' + top + '%;height:' + h + '%;background:repeating-linear-gradient(45deg,rgba(255,60,60,.22),rgba(255,60,60,.22) 6px,rgba(255,60,60,.1) 6px,rgba(255,60,60,.1) 12px);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 6px">' + label + '</div>'; };
    var phone = '<div style="position:relative;width:216px;height:384px;background:' + e(R.bg) + ';border-radius:14px;overflow:hidden;border:1px solid #cfd0d8;flex:none">' + band(0, 14, 'Keep text out: app UI') + band(65, 35, 'Keep text out: caption, buttons') +
      '<div style="position:absolute;right:0;top:14%;bottom:35%;width:12%;background:rgba(255,60,60,.14)"></div>' +
      '<div style="position:absolute;left:8%;right:16%;top:20%;text-align:center;color:' + e(R.hook) + ';font-weight:900;font-size:22px;line-height:1.05;text-transform:uppercase">HOOK TEXT<br><span style="color:' + e(R.hl) + '">IN 1 SECOND</span></div>' +
      '<div style="position:absolute;left:8%;right:16%;top:44%;text-align:center;color:#fff;font-weight:700;font-size:13px;background:rgba(0,0,0,.45);padding:4px 6px;border-radius:6px">Burned-in captions, middle third, 8 words or fewer</div></div>';
    var reel = '<h4>Reels: where text goes and the hook visual</h4><div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">' + phone + '<ul style="flex:1;min-width:240px;margin:0">' +
      '<li><b>Hook text:</b> upper-middle, centered, in ' + e(R.hook) + ' with the highlight word in ' + e(R.hl) + '. In the first second.</li>' +
      '<li><b>Captions:</b> middle third, 8 words or fewer per card, a new card or shot every 2 to 3 seconds.</li>' +
      '<li><b>Off limits:</b> top 14%, bottom 35% and the right edge (red). The app covers them.</li>' +
      '<li><b>Two hooks:</b> the audio hook is the first spoken line from the talking head. The visual hook is different words on screen. No talking head: the text is the only hook and the first frame shows the result, not a logo.</li>' +
      '<li><b>Cover frame:</b> the hook frame, tinted with that week\'s accent.</li>' +
      '<li class="hint">Placement numbers are Meta safe-zone guidance from memory, not yet re-checked against Meta\'s current spec. VERIFY before final designs.</li></ul></div>';
    return '<div class="panel"><h3>Look: palette and feed</h3><p class="hint" style="margin-top:0">' + e(L.source) + '</p>' +
      '<h4>Palette</h4><div style="display:flex;gap:10px;flex-wrap:wrap">' + sw + '</div>' +
      '<h4>Type</h4><ul>' + (L.fonts || []).map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>' +
      '<h4>Rules</h4><ul>' + (L.rules || []).map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>' +
      '<h4>Weekly color rotation</h4><div style="display:flex;gap:10px;flex-wrap:wrap">' + wk + '</div>' +
      '<h4>Feed grid mockup (what the profile should look like)' + ((L.grid && L.grid.length) ? '' : ' <span class="hint">(placeholder layout in this client\'s colors, not final copy)</span>') + '</h4><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;max-width:420px">' + gr + '</div>' +
      reel + '<h4>Competitor references (saved images, click for the live ad)</h4><div style="display:flex;gap:14px;flex-wrap:wrap">' + (rf || '<span class="hint">No competitor images saved yet. Next step: save 2 to 3 local competitor ads for this client.</span>') + '</div></div>';
  }
  function formatsTab(c) { var f = HQ.fmt && HQ.fmt[c.slug]; if (f == null) return '<div class="sk" style="height:200px"></div>'; return '<div class="panel"><h3>Formats and rules</h3><p class="hint" style="margin-top:0">Graphic and static ad formats with example copy, the Reel hook and text on screen system, and caption rules. Every Reel and graphic in the weekly pack follows this.</p><div class="md">' + mdHtml(f) + '</div></div>'; }
  function guidesTab(c) {
    var g = HQ.guides; if (!g) return '<div class="sk" style="height:200px"></div>';
    var cur = HQ.guideKey || (g[0] && g[0].key), doc = HQ.guideDoc[cur];
    return '<div class="two" style="grid-template-columns:260px 1fr"><div class="panel"><h3>Guidelines</h3><p class="hint">One system for every client.</p>' + g.map(function (x) { return '<a class="gl ' + (x.key === cur ? 'on' : '') + '" onclick="hqGuide(\'' + e(x.key) + '\')">' + e(x.title) + '</a>'; }).join('') + '</div><div class="panel md">' + (doc == null ? '<div class="sk" style="height:200px"></div>' : mdHtml(doc)) + '</div></div>';
  }
  window.hqGuide = async function (k) { HQ.guideKey = k; if (HQ.guideDoc[k] == null) { try { HQ.guideDoc[k] = (await api('/api/hq/guidelines/' + k)).md; } catch (x) { HQ.guideDoc[k] = ''; } } show(navKey); };
  // Small markdown renderer: headings, lists, bold, code, links, tables, rules.
  function mdInline(t) {
    t = e(t);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, '$1<i>$2</i>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="lnk" href="$2" target="_blank" rel="noopener">$1</a>').replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a class="lnk" href="$2" target="_blank" rel="noopener">$2</a>');
    return t;
  }
  function mdHtml(src) {
    var lines = String(src).replace(/\r/g, '').split('\n'), out = [], i = 0, list = null, para = [];
    function flushP() { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; } }
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    while (i < lines.length) {
      var ln = lines[i], m;
      if (/^\s*$/.test(ln)) { flushP(); closeList(); i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) { flushP(); closeList(); var lv = Math.min(m[1].length + 1, 5); out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>'); i++; continue; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flushP(); closeList(); out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushP(); closeList(); var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim(); }); };
        var hd = cells(ln); i += 2; var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        var hcol = hd.map(function (x) { return /headline/i.test(x); });
        out.push('<div class="mdt"><table><thead><tr>' + hd.map(function (x) { return '<th>' + mdInline(x) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (x, ci) { return hcol[ci] ? '<td class="cpy" title="Click to copy" data-copy="' + e(x.replace(/^"|"$/g, '')) + '">' + mdInline(x) + '</td>' : '<td>' + mdInline(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'); continue;
      }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(ln))) { flushP(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + mdInline(m[1]) + '</li>'); i++; continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(ln))) { flushP(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + mdInline(m[1]) + '</li>'); i++; continue; }
      closeList(); para.push(ln.trim()); i++;
    }
    flushP(); closeList(); return out.join('');
  }
  async function loadClientData(slug) {
    var tab = HQ.ctab;
    if (HQ.ctabSlug !== slug) { HQ.ctabSlug = slug; }
    if (tab === 'pack') {
      HQ.winners = HQ.winners || {}; if (HQ.winners[slug] == null) { try { HQ.winners[slug] = (await api('/api/hq/winners/' + slug)).winners; } catch (x) { HQ.winners[slug] = []; } }
      var w = HQ.packWeek[slug] || defaultWeek(); await loadHols(w);
      if (HQ.packs[slug] == null) { try { HQ.packs[slug] = await api('/api/hq/packs/' + slug); } catch (x) { HQ.packs[slug] = { packs: [], promos: [] }; } }
    }
    if (tab === 'copy') {
      if (!HQ.cal && HQ.me && !HQ.me.legacy) await loadCal();
      if (HQ.shots[slug] == null) { try { HQ.shots[slug] = (await api('/api/hq/shotlists/' + slug)).lists; } catch (x) { HQ.shots[slug] = []; } }
      if (HQ.working[slug] == null) { try { HQ.working[slug] = (await api('/api/hq/working/' + slug)).md; } catch (x) { HQ.working[slug] = ''; } }
    }
    if (tab === 'copy' && HQ.copy[slug] == null) { try { HQ.copy[slug] = (await api('/api/hq/copy/' + slug)).md; } catch (x) { HQ.copy[slug] = ''; } }
    if ((tab === 'brain' || tab === 'copy') && HQ.facts[slug] == null) { try { HQ.facts[slug] = (await api('/api/hq/facts/' + slug)).md; } catch (x) { HQ.facts[slug] = ''; } }
    if (tab === 'brain' && HQ.brain[slug] == null) { try { HQ.brain[slug] = (await api('/api/hq/brain/' + slug)).md; } catch (x) { HQ.brain[slug] = ''; } }
    if (tab === 'formats') { HQ.fmt = HQ.fmt || {}; if (HQ.fmt[slug] == null) { try { HQ.fmt[slug] = (await api('/api/hq/formats/' + slug)).md || ''; } catch (x) { HQ.fmt[slug] = ''; } } }
    if (tab === 'look') { HQ.look = HQ.look || {}; if (HQ.look[slug] == null) { try { HQ.look[slug] = await api('/api/hq/look/' + slug); } catch (x) { HQ.look[slug] = { none: true }; } } }
    if (tab === 'guides' && !HQ.guides) { try { HQ.guides = (await api('/api/hq/guidelines')).docs; var k = HQ.guideKey || (HQ.guides[0] && HQ.guides[0].key); if (k && HQ.guideDoc[k] == null) HQ.guideDoc[k] = (await api('/api/hq/guidelines/' + k)).md; } catch (x) { HQ.guides = []; } }
    if (tab === 'content') {
      if (!HQ.cal && HQ.me && !HQ.me.legacy) await loadCal();
      if (HQ.content[slug] == null) { try { HQ.content[slug] = await api('/api/hq/content/' + slug); } catch (x) { HQ.content[slug] = { error: x.message }; } }
    }
  }



  function weekBoard() {
    var w = HQ.wb; if (!w) return '<div class="sk" style="height:120px;margin-bottom:16px"></div>';
    var VC = { good: ['Good to go', 'var(--ok,#17935f)'], missing: ['Missing', 'var(--bad,#d6342d)'], progress: ['In progress', '#8a94a6'] };
    return w.weeks.map(function (wk) {
      var body = wk.clients.length ? wk.clients.map(function (c) {
        var up = ((HQ.cw && HQ.cw.rows) || []).filter(function (r) { return r.slug === c.slug; })[0], v = VC[c.verdict];
        var upl = up ? (wk.label.indexOf('Last') === 0 ? up.lastWeek : up.thisWeek) : null;
        return '<div class="panel" style="margin-bottom:10px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + (c.logo ? '<span class="mini-av" style="background-image:url(' + e(c.logo) + ')"></span>' : '') + '<b style="font-size:15px">' + e(c.name) + '</b><span style="font-size:12px;font-weight:700;color:' + v[1] + '">' + v[0] + '</span>' + (upl !== null ? '<span class="hint" style="margin:0">' + upl + ' file' + (upl === 1 ? '' : 's') + ' uploaded to Drive that week</span>' : '') + '</div>' +
          c.items.map(function (i) {
            var col = i.status === 'done' ? '#17935f' : i.status === 'late' ? '#d6342d' : '#8a94a6', lbl = i.status === 'done' ? 'Done' : i.status === 'late' ? 'Late' : 'Open';
            return '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--hair2,#e6e9f0)"><div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap"><span><b style="color:' + col + '">' + lbl + '</b> · ' + e(i.title) + '</span><span class="hint" style="margin:0">' + e(i.owner || 'Unassigned') + ' · due ' + e(dshort(i.due)) + ' 5 PM</span></div>' +
              (i.pieces.length ? '<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#4a5468">' + i.pieces.map(function (p) { return '<li>' + e(dshort(p.date)) + ' ' + e(p.type) + (p.what ? ': ' + e(p.what) : '') + '</li>'; }).join('') + '</ul>' : '') + '</div>';
          }).join('') + '</div>';
      }).join('') : '<div class="panel"><div class="empty">Nothing was due ' + (wk.label.indexOf('Last') === 0 ? 'last week' : 'this week') + ' yet.</div></div>';
      return '<h3 style="margin:18px 0 8px">' + e(wk.label) + ' <span class="hint" style="font-weight:400">' + e(dshort(wk.start)) + ' to ' + e(dshort(wk.end)) + '</span></h3>' + body;
    }).join('');
  }
  function contentWeek() {
    var d = HQ.cw, head = '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Content</h3><p>What was uploaded each week, what is due, and what is on the film calendar. Every file must be named CLIENT_TYPE_DATE_Subject_LABEL_001.</p></div></div>';
    var shoots = ((HQ.cal && HQ.cal.events) || []).filter(function (x) { return /shoot|film/i.test(x.title + ' ' + x.cal); }).slice(0, 6);
    var sh = '<div class="panel" style="margin-bottom:16px"><h3>' + ico('film') + ' Next on the film calendar</h3>' + (shoots.length ? shoots.map(function (x) { var dt = evDate(x); return '<a class="ag" href="' + e(x.link) + '" target="_blank" rel="noopener" style="grid-template-columns:200px 8px minmax(0,1fr)"><span class="at">' + e(dayLabel(dt)) + (x.allDay ? '' : ', ' + e(dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))) + '</span><i style="background:' + e(x.color || '#e22a24') + '"></i><span class="an">' + e(x.title) + '</span></a>'; }).join('') : '<div class="empty" style="padding:10px 0">' + (HQ.cal && HQ.cal.connected ? 'No shoots on the calendar in the next two weeks.' : 'Connect Google on the Mail page to see filming dates.') + '</div>') + '</div>';
    var bd = weekBoard();
    if (!d) return head + sh + bd + '<div class="sk" style="height:180px"></div>';
    if (d.legacy || d.connected === false) return head + sh + '<div class="panel"><div class="empty">' + ico('mail') + 'Connect your Google account on the Mail page to see uploads.</div></div>';
    var st = d.state; if (st && (st.needsDrive || st.error) && !d.rows.length) return head + sh + '<div class="panel"><div class="empty">' + ico('alert') + (st.needsDrive ? (st.apiOff ? 'Google Drive is not turned on for this project yet. In Google Cloud, open APIs & Services, then Library, search Google Drive API and click Enable.' : 'Drive access was not granted. On the Mail page click Disconnect, then connect Google again and allow Drive.') : e(st.error)) + '</div></div>';
    var tot = d.rows.reduce(function (a, r) { return a + r.thisWeek; }, 0), ren = d.rows.reduce(function (a, r) { return a + r.unnamed; }, 0);
    return head + sh + bd + '<div class="panel"><h3>Uploads by client</h3><p class="hint">Week of ' + e(dshort(d.thisWk)) + ': <b>' + tot + '</b> piece' + (tot === 1 ? '' : 's') + ' uploaded' + (ren ? ' · <b style="color:var(--bad)">' + ren + ' file' + (ren > 1 ? 's' : '') + ' need renaming</b>' : '') + '</p>' +
      '<table class="ttab"><thead><tr><th>Client</th><th>This week</th><th>Last week</th><th>Next due</th><th>Needs rename</th></tr></thead><tbody>' + d.rows.map(function (r) {
        var c = HQ.data.clients.filter(function (x) { return x.slug === r.slug; })[0] || { name: r.name };
        return '<tr class="clk" onclick="hqOpenContent(\'' + e(r.slug) + '\')"><td><div class="nm" style="display:flex;align-items:center;gap:10px">' + (c.logo ? '<span class="mini-av" style="background-image:url(' + e(c.logo) + ')"></span>' : '') + e(r.name) + '</div></td><td><b>' + r.thisWeek + '</b></td><td>' + r.lastWeek + '</td><td>' + (r.nextDue ? e(dshort(r.nextDue)) : '<span class="em">None</span>') + '</td><td>' + (r.unnamed ? '<span class="chip st-ending">' + r.unnamed + '</span>' : '<span class="em">0</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  window.hqOpenContent = function (slug) { HQ.ctab = 'content'; navKey = 'hq:client:' + slug; if (typeof renderNav === 'function') renderNav(); show(navKey); };

  // Phone bottom bar
  function mnav() {
    var el = document.getElementById('mnav'); if (!el) { el = document.createElement('nav'); el.id = 'mnav'; el.setAttribute('aria-label', 'Main'); document.body.appendChild(el); }
    var items = [['hq:home', 'home', 'Home'], ['hq:work', 'check', 'Work'], ['hq:mail', 'mail', 'Mail'], ['hq:clients', 'users', 'Clients']]; if (window.pipelineOK !== false) items.push(['hq:outreach', 'kanban', 'Outreach']);
    el.innerHTML = items.map(function (it) { return '<button class="' + ((navKey === it[0] || (it[0] === 'hq:outreach' && String(navKey).indexOf('hq:') !== 0)) ? 'on' : '') + '" onclick="navTo(\'' + it[0] + '\')">' + ico(it[1]) + '<span>' + it[2] + '</span></button>'; }).join('');
  }

  async function show(key) {
    document.body.classList.add('hqmode');
    var titles = { 'hq:home': 'Home', 'hq:clients': 'Clients', 'hq:onboarding': 'Onboarding', 'hq:outreach': 'Outreach', 'hq:team': 'Team', 'hq:work': 'Work', 'hq:mail': 'Mail', 'hq:content': 'Content', 'hq:how': 'How We Work', 'hq:manual': 'Users Manual', 'hq:conversions': 'Conversions', 'hq:queue': 'Posting Queue', 'hq:ads': 'Winners for Ads', 'hq:blogs': 'Blogs' };
    document.body.classList.remove('outdetail'); document.body.classList.toggle('hqout', key === 'hq:outreach');
    document.getElementById('viewTitle').textContent = titles[key] || 'Client';
    var el = root();
    if (!HQ.data) { el.innerHTML = skeleton(); await fetchHq(false); }
    if (!HQ.data) { el.innerHTML = '<div class="empty">Could not load: ' + e(HQ.err || 'error') + '</div>'; return; }
    if (key === 'hq:home') { if (!HQ.ann) await loadAnn(); el.innerHTML = annBox() + home(); if (HQ.me && !HQ.me.legacy) { if (!HQ.mail && !HQ.mailLoading) loadMail().then(function () { if (navKey === 'hq:home') el.innerHTML = annBox() + home(); }); if (!HQ.cal && !HQ.calLoading) loadCal().then(function () { if (navKey === 'hq:home') el.innerHTML = annBox() + home(); }); } }
    else if (key === 'hq:clients') el.innerHTML = clients();
    else if (key === 'hq:onboarding') el.innerHTML = onboarding();
    else if (key === 'hq:mail') { el.innerHTML = mail(); if (!HQ.mail) { await loadMail(); if (navKey === 'hq:mail') el.innerHTML = mail(); } }
    else if (key === 'hq:how') { if (!HQ.how) { try { HQ.how = await (await fetch('/how.html', { cache: 'no-cache' })).text(); } catch (x) { HQ.how = '<p>Could not load this page.</p>'; } } el.innerHTML = '<div class="hw">' + HQ.how + '</div>'; }
    else if (key === 'hq:content') { if (HQ.me && !HQ.me.legacy) { if (!HQ.cal) await loadCal(); el.innerHTML = contentWeek(); if (!HQ.wb) { try { HQ.wb = await api('/api/hq/week-board'); } catch (x) { HQ.wb = { weeks: [] }; } if (navKey === 'hq:content') el.innerHTML = contentWeek(); } if (!HQ.cw) { try { HQ.cw = await api('/api/hq/content-week'); } catch (x) { HQ.cw = { connected: false }; } if (navKey === 'hq:content') el.innerHTML = contentWeek(); } } else el.innerHTML = contentWeek(); }
    else if (key === 'hq:work') { if (HQ.me && HQ.me.role === 'admin' && !HQ.users) { try { HQ.users = (await api('/api/admin/users')).users; } catch (x) {} } el.innerHTML = work(); }
    else if (key === 'hq:ads') { el.innerHTML = await adsPage(); }
    else if (key === 'hq:blogs') { el.innerHTML = await blogsPage(); }
    else if (key === 'hq:queue') { el.innerHTML = await queuePage(); }
    else if (key === 'hq:manual') { if (!HQ.manual) { try { HQ.manual = await (await fetch('/manual.html', { cache: 'no-cache' })).text(); } catch (x) { HQ.manual = '<p>Could not load this page.</p>'; } } el.innerHTML = '<div class="hw">' + HQ.manual + '</div>'; }
    else if (key === 'hq:conversions') { var cv = {}; try { cv = await api('/api/conversions/status'); } catch (x) {} el.innerHTML = conversions(cv); }
    else if (key === 'hq:outreach') el.innerHTML = (HQ.me && HQ.me.pipeline) ? outreach() : '<div class="sec"><div><h3 style="font-size:28px">Outreach</h3></div></div><div class="panel"><div class="empty">' + ico('alert') + 'The sales pipeline is limited to Lisa, Michelle, Brad, Griffin and Zac.</div></div>';
    else if (key === 'hq:team') el.innerHTML = await team();
    else if (key.indexOf('hq:client:') === 0) { if (HQ.me && HQ.me.role === 'admin' && !HQ.users) { try { HQ.users = (await api('/api/admin/users')).users; } catch (x) {} } await loadClientData(key.slice(10)); el.innerHTML = clientPage(key.slice(10)); }
    window.scrollTo(0, 0); mnav();
  }
  window.hqNav = function (key) {
    if (String(key).indexOf('hq:') !== 0) { document.body.classList.remove('hqmode', 'hqout'); document.body.classList.add('outdetail'); navKey = key; mnav(); if (typeof renderNav === 'function') renderNav(); return false; }
    if (String(key).indexOf('hq:client:') === 0 && navKey !== key) HQ.ctab = 'overview';
    navKey = key; if (typeof renderNav === 'function') renderNav(); show(key); return true;
  };
  window.hqRefresh = async function () { HQ.data = null; root().innerHTML = skeleton(); await fetchHq(true); show(navKey); };
  window.hqLink = async function (slug) {
    var v = (document.getElementById('bcl') || {}).value || '';
    try { await api('/api/hq/client/' + slug + '/link', 'POST', { project: v }); toast('Linked'); window.hqRefresh(); } catch (er) { toast(er.message); }
  };
  window.hqRerender = function () { if (HQ.data && document.body.classList.contains('hqmode')) show(navKey); };
  document.addEventListener('click', function (ev) { var t = ev.target.closest && ev.target.closest('.cpy'); if (t && navigator.clipboard) { navigator.clipboard.writeText(t.getAttribute('data-copy') || t.textContent).then(function () { toast('Copied'); }); } });
  mnav();
})();
