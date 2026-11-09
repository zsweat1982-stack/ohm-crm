/* Open Heart Media CRM: Home, Clients, Onboarding pages. Loaded after the outreach script. */
(function () {
  var HQ = { data: null, onb: null, loading: false, me: null, mail: null, mailLoading: false, cal: null, calLoading: false };
  var COLORS = ['#2f6fd0', '#e22a24', '#17935f', '#6552d1', '#c98a0b', '#0f7c8c', '#c2185b', '#455a9c'];
  // One icon family: 24px grid, 1.8 stroke, round caps.
  var P = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 010 6.8"/><path d="M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h4"/>',
    kanban: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8h14v-8"/><path d="M12 8C10 4 6.5 4.5 7 6.5 7.4 8 12 8 12 8zM12 8c2-4 5.5-3.5 5-1.5C16.6 8 12 8 12 8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v3"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    flag: '<path d="M5 21V4"/><path d="M5 5h12l-2 4 2 4H5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<path d="M12 4l9.5 16h-19z"/><path d="M12 10v4M12 17.5h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link: '<path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1"/><path d="M14 10a4 4 0 00-5.6 0l-3 3A4 4 0 0011 18.6l1-1"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    refresh: '<path d="M20 11a8 8 0 00-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0014 4l2-2"/><path d="M20 20v-5h-5"/>',
    inbox: '<path d="M3 13l3-8h12l3 8"/><path d="M3 13v6h18v-6h-5l-1.5 2h-5L8 13z"/>'
  };
  var ALIAS = { '▣': 'home', '✦': 'users', '✉': 'clipboard', '▦': 'kanban', '\u{1F381}': 'gift', '✚': 'plus', '☎': 'phone', '★': 'star', '↩': 'reply', '✓': 'check', '⚑': 'flag', '≡': 'list', '○': 'circle', '✎': 'edit', '⊘': 'ban', '✕': 'x' };
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
    if (!c.work) return { k: '', t: 'Not synced', col: '#bcc5d3' };
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
    try { if (force) await fetch('/api/hq/refresh'); HQ.data = await api('/api/hq'); HQ.onb = (await api('/api/onboarding')).responses || []; try { HQ.me = await api('/api/me'); } catch (x) {} }
    catch (err) { HQ.err = err.message; }
    HQ.loading = false;
  }
  function firstName() { return HQ.me && !HQ.me.legacy && HQ.me.name ? String(HQ.me.name).split(' ')[0] : ''; }
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function skeleton() { return '<div class="sk" style="height:210px;margin-bottom:16px"></div><div class="bento"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>'; }
  function tile(l, v, s, icon, cls) { return '<div class="tile rise ' + cls + '"><div class="chipi">' + ico(icon) + '</div><div class="l">' + e(l) + '</div><div class="v">' + e(v) + '</div><div class="s">' + e(s) + '</div></div>'; }

  function myTasks(d) {
    var me = (firstName() || '').toLowerCase(), out = [];
    d.clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.forEach(function (t) { out.push({ t: t, c: c }); }); }); });
    return { all: out, mine: me ? out.filter(function (x) { return String(x.t.who || '').toLowerCase().indexOf(me) > -1; }) : [] };
  }
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
  function dayLabel(d) {
    var t = new Date(); t.setHours(0, 0, 0, 0); var x = new Date(d); x.setHours(0, 0, 0, 0); var diff = Math.round((x - t) / 864e5);
    if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow';
    return x.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function agenda() {
    var c = HQ.cal, me = HQ.me, head = '<div class="ph"><h3>' + ico('clock') + ' Coming up</h3><a class="lnk" href="https://calendar.google.com" target="_blank" rel="noopener">Open calendar</a></div>';
    if (!me || me.legacy) return '<div class="panel agenda">' + head + '<div class="empty">' + ico('clock') + 'Sign in with your own email to see your calendar.</div></div>';
    if (!c) return '<div class="panel agenda">' + head + '<div class="sk" style="height:200px"></div></div>';
    if (!c.connected) return '<div class="panel agenda">' + head + '<div class="empty">' + ico('clock') + 'Connect your Google account to see meetings and shoots here.<br><br><a class="btn2 red" href="/api/me/gmail/connect">Connect Google</a></div></div>';
    if (c.needsCalendar) return '<div class="panel agenda">' + head + '<div class="empty">' + ico('alert') + 'Calendar access was not granted. Disconnect and reconnect Google on the Mail page to add it.</div></div>';
    if (c.error) return '<div class="panel agenda">' + head + '<div class="empty">' + ico('alert') + e(c.error) + '</div></div>';
    var ev = c.events || [];
    if (!ev.length) return '<div class="panel agenda">' + head + '<div class="empty">' + ico('check') + 'Nothing on the calendar for the next two weeks.</div></div>';
    var groups = {}, order = [];
    ev.forEach(function (x) { var k = new Date(x.start).toDateString(); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(x); });
    return '<div class="panel agenda">' + head + order.slice(0, 5).map(function (k) {
      return '<div class="day"><div class="dl">' + e(dayLabel(groups[k][0].start)) + '</div>' + groups[k].slice(0, 6).map(function (x) {
        var tm = x.allDay ? 'All day' : new Date(x.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return '<a class="ev2" href="' + e(x.link) + '" target="_blank" rel="noopener" style="--ec:' + (/film/i.test(x.cal) ? '#e22a24' : /meeting/i.test(x.cal) ? '#2f6fd0' : '#13233f') + '"><span class="tm">' + e(tm) + '</span><div><b>' + e(x.title) + '</b>' + (x.where ? '<span class="wh">' + e(x.where) + '</span>' : '') + '</div><em>' + e(x.cal) + '</em></a>';
      }).join('') + '</div>';
    }).join('') + '</div>';
  }
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
    late.slice(0, 5).forEach(function (x) { att.push('<div class="item"><div class="bub">' + ico('alert') + '</div><div><b>' + e(x.t.title) + '</b><div class="m">' + e(x.c.name) + ' · ' + e(x.t.who || 'Unassigned') + ' · due ' + e(dshort(x.t.due)) + ' · <a href="' + e(x.t.url) + '" target="_blank" rel="noopener">Open</a></div></div></div>'); });
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
      stat(fn ? 'My work' : 'Open work', 'check', fn ? mine.length : tasks.all.length, mineLate.length ? mineLate.length + ' late' : 'open to-dos', "hqNav('hq:work')", mineLate.length ? 'bad' : '') +
      stat('Late', 'alert', d.connected ? late.length : '-', 'across all clients', "hqNav('hq:work')", late.length ? 'bad' : 'ok') +
      stat('Client mail', 'mail', mm && mm.connected ? (mm.unread || 0) : '-', mm && mm.connected ? 'unread' : 'not connected', "hqNav('hq:mail')", mm && mm.connected && mm.unread ? 'warn' : '') +
      stat('Clients', 'users', activeC.length, 'active now', "hqNav('hq:clients')") +
      stat('Outreach', 'kanban', replies.length, replies.length === 1 ? 'reply waiting' : 'replies waiting', "hqNav('hq:outreach')", replies.length ? 'warn' : '') + '</div>' +
      '<div class="hcols">' + agenda() + '<div class="panel"><h3>Needs attention' + (att.length ? '<span class="ct">' + att.length + '</span>' : '') + '</h3>' +
      (att.length ? att.join('') : '<div class="empty">' + ico('check') + 'All clear. Nothing needs you.</div>') + '</div></div>' +
      '<div class="sec" style="margin-top:26px"><div><h3>Your clients</h3></div><a class="lnk" onclick="hqNav(\'hq:clients\')">See all</a></div><div class="lgrid">' + strip + '</div>';
  }

  function work() {
    var d = HQ.data, fn = (firstName() || '').toLowerCase(), f = HQ.workTab || (fn ? 'mine' : 'all'), rows = [];
    d.clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.forEach(function (t) { rows.push({ t: t, c: c, l: l.name }); }); }); });
    var total = rows.length;
    if (f === 'mine') rows = rows.filter(function (x) { return fn && String(x.t.who || '').toLowerCase().indexOf(fn) > -1; });
    if (f === 'late') rows = rows.filter(function (x) { return x.t.overdue; });
    rows.sort(function (a, b) { return (a.t.due || '9999') < (b.t.due || '9999') ? -1 : 1; });
    var tab = function (k, l) { return '<button class="tb ' + (f === k ? 'on' : '') + '" onclick="HQ_work(\'' + k + '\')">' + l + '</button>'; };
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Work</h3><p>Every open to-do across clients, from Basecamp.</p></div></div>' +
      '<div class="tabs">' + (fn ? tab('mine', 'Mine') : '') + tab('late', 'Late') + tab('all', 'Everyone') + '</div>' +
      (!d.connected ? '<div class="banner">' + ico('alert') + '<div>Connect Basecamp to see work. <a class="lnk" href="/api/basecamp/connect">Connect</a></div></div>' : '') +
      '<div class="panel">' + (rows.length ? rows.map(function (x) {
        return '<div class="td"><span class="ck"></span><div style="min-width:0"><a href="' + e(x.t.url) + '" target="_blank" rel="noopener">' + e(x.t.title) + '</a><div class="who">' + e(x.c.name) + ' · ' + e(x.t.who || 'Unassigned') + '</div></div><span class="due ' + (x.t.overdue ? 'od' : '') + '">' + (x.t.due ? (x.t.overdue ? 'Late · ' : '') + e(dshort(x.t.due)) : '') + '</span></div>';
      }).join('') : '<div class="empty">' + ico('check') + (f === 'mine' ? 'Nothing assigned to you right now.' : 'Nothing here.') + '</div>') + '</div>' +
      '<p class="hint" style="margin-top:10px">' + total + ' open to-dos in total.</p>';
  }
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
      lists = w.lists.map(function (l) {
        var m = /(\d+)\/(\d+)/.exec(l.ratio || ''), pct = m && +m[2] ? Math.round(+m[1] / +m[2] * 100) : 0;
        return '<div style="margin-bottom:22px"><div class="list-h"><b>' + e(l.name) + '</b><span>' + e(l.ratio ? l.ratio + ' done' : '') + ' · <a class="lnk" href="' + e(l.url) + '" target="_blank" rel="noopener">Basecamp</a></span></div><div class="pbar"><i style="width:' + pct + '%"></i></div>' +
          (l.open.length ? l.open.map(function (t) { return '<div class="td"><span class="ck"></span><div><a href="' + e(t.url) + '" target="_blank" rel="noopener">' + e(t.title) + '</a><div class="who">' + e(t.who || 'Unassigned') + '</div></div><span class="due ' + (t.overdue ? 'od' : '') + '">' + (t.due ? (t.overdue ? 'Late · ' : '') + e(dshort(t.due)) : '') + '</span></div>'; }).join('') : '<div class="empty" style="padding:12px 0">Everything here is done.</div>') + '</div>';
      }).join('') || '<div class="empty">No to-do lists in this project yet.</div>';
    } else if (!HQ.data.connected) {
      lists = '<div class="empty">' + ico('link') + 'Connect Basecamp to see this client\'s to-dos.<br><br><a class="btn2 red" href="/api/basecamp/connect">Connect Basecamp</a></div>';
    } else {
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
      '<div class="two"><div class="panel"><h3>Work</h3>' + lists + '</div><div style="display:grid;gap:16px">' +
      '<div class="panel"><h3>Who handles it</h3>' + ownerRow('Website', c.website_owner) + ownerRow('Ads', c.ads_owner) + ownerRow('Account manager', c.account_owner) +
      (w && w.linked ? '<div class="kv"><span>Basecamp</span><a class="lnk" href="' + e(w.project.url) + '" target="_blank" rel="noopener">Open project</a></div>' : '') + '</div>' +
      ((mine.length || c.status === 'onboarding') ? '<div class="panel"><h3>Onboarding answers</h3>' + onb + '</div>' : '') +
      editPanel(c) +
      '<div class="panel"><h3>Activity</h3><div class="tl" style="margin-top:12px">' + tl + '</div></div></div></div>';
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
      '<label>Their email addresses or domains (comma separated)</label><input id="ed_dom" value="' + e((c.domains || []).join(', ')) + '" placeholder="theirbusiness.com, owner@gmail.com">' +
      '<label>Note</label><input id="ed_note" value="' + e(c.note || '') + '" placeholder="Anything the team should know">' +
      '<button class="btn2 red" style="margin-top:12px" onclick="hqSaveClient(\'' + e(c.slug) + '\')">Save</button></div></details>';
  }
  window.hqSaveClient = async function (slug) {
    var g = function (id) { return (document.getElementById(id) || {}).value || ''; };
    var svcs = SERV.filter(function (sv, i) { var b = document.getElementById('ed_s' + i); return b && b.checked; });
    try { await api('/api/hq/client/' + slug, 'PUT', { kind: g('ed_kind'), status: g('ed_status'), services: svcs, website_owner: g('ed_web'), ads_owner: g('ed_ads'), account_owner: g('ed_acc'), note: g('ed_note'), domains: g('ed_dom').split(',').map(function (x) { return x.trim(); }).filter(Boolean) }); toast('Saved'); window.hqRefresh(); } catch (er) { toast(er.message); }
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
        '<button class="btn2 line mini" onclick="hqTitle(\'' + e(u.id) + '\')">Set job role</button> <button class="btn2 line mini" onclick="hqReset(\'' + e(u.id) + '\')">Reset password</button> ' +
        (me.id !== u.id ? '<button class="btn2 line mini" onclick="hqActive(\'' + e(u.id) + '\',' + (u.active ? 'false' : 'true') + ')">' + (u.active ? 'Turn off' : 'Turn on') + '</button>' : '') + '</td></tr>';
    }).join('');
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Team</h3><p>Everyone who can log in. Each person sees their own name.</p></div></div><div id="tempbox"></div>' + rosterPanel(r.users) +
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
    return '<div class="panel" style="margin-bottom:16px"><h3>Add the whole team</h3><p class="hint">Everyone from Basecamp, with their job role. Uncheck anyone you do not want, and tick Admin for people who should manage logins.</p>' +
      '<table class="ttab"><thead><tr><th></th><th>Person</th><th>Job role</th><th>Admin</th></tr></thead><tbody>' + rows.map(function (r, i) {
        return '<tr><td><input type="checkbox" id="rt_on' + i + '" checked></td><td><div class="nm">' + e(r[0]) + '</div><div class="em">' + e(r[1]) + '</div></td><td class="em" style="display:table-cell">' + e(r[2]) + '</td><td><input type="checkbox" id="rt_ad' + i + '"' + (r[3] ? ' checked' : '') + '></td></tr>';
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

  // Phone bottom bar
  function mnav() {
    var el = document.getElementById('mnav'); if (!el) { el = document.createElement('nav'); el.id = 'mnav'; el.setAttribute('aria-label', 'Main'); document.body.appendChild(el); }
    var items = [['hq:home', 'home', 'Home'], ['hq:work', 'check', 'Work'], ['hq:mail', 'mail', 'Mail'], ['hq:clients', 'users', 'Clients'], ['hq:outreach', 'kanban', 'Outreach']];
    el.innerHTML = items.map(function (it) { return '<button class="' + ((navKey === it[0] || (it[0] === 'hq:outreach' && String(navKey).indexOf('hq:') !== 0)) ? 'on' : '') + '" onclick="navTo(\'' + it[0] + '\')">' + ico(it[1]) + '<span>' + it[2] + '</span></button>'; }).join('');
  }

  async function show(key) {
    document.body.classList.add('hqmode');
    var titles = { 'hq:home': 'Home', 'hq:clients': 'Clients', 'hq:onboarding': 'Onboarding', 'hq:outreach': 'Outreach', 'hq:team': 'Team', 'hq:work': 'Work', 'hq:mail': 'Mail' };
    document.body.classList.remove('outdetail'); document.body.classList.toggle('hqout', key === 'hq:outreach');
    document.getElementById('viewTitle').textContent = titles[key] || 'Client';
    var el = root();
    if (!HQ.data) { el.innerHTML = skeleton(); await fetchHq(false); }
    if (!HQ.data) { el.innerHTML = '<div class="empty">Could not load: ' + e(HQ.err || 'error') + '</div>'; return; }
    if (key === 'hq:home') { el.innerHTML = home(); if (HQ.me && !HQ.me.legacy) { if (!HQ.mail && !HQ.mailLoading) loadMail().then(function () { if (navKey === 'hq:home') el.innerHTML = home(); }); if (!HQ.cal && !HQ.calLoading) loadCal().then(function () { if (navKey === 'hq:home') el.innerHTML = home(); }); } }
    else if (key === 'hq:clients') el.innerHTML = clients();
    else if (key === 'hq:onboarding') el.innerHTML = onboarding();
    else if (key === 'hq:mail') { el.innerHTML = mail(); if (!HQ.mail) { await loadMail(); if (navKey === 'hq:mail') el.innerHTML = mail(); } }
    else if (key === 'hq:work') el.innerHTML = work();
    else if (key === 'hq:outreach') el.innerHTML = outreach();
    else if (key === 'hq:team') el.innerHTML = await team();
    else if (key.indexOf('hq:client:') === 0) { if (HQ.me && HQ.me.role === 'admin' && !HQ.users) { try { HQ.users = (await api('/api/admin/users')).users; } catch (x) {} } el.innerHTML = clientPage(key.slice(10)); }
    window.scrollTo(0, 0); mnav();
  }
  window.hqNav = function (key) {
    if (String(key).indexOf('hq:') !== 0) { document.body.classList.remove('hqmode', 'hqout'); document.body.classList.add('outdetail'); navKey = key; mnav(); if (typeof renderNav === 'function') renderNav(); return false; }
    navKey = key; if (typeof renderNav === 'function') renderNav(); show(key); return true;
  };
  window.hqRefresh = async function () { HQ.data = null; root().innerHTML = skeleton(); await fetchHq(true); show(navKey); };
  window.hqLink = async function (slug) {
    var v = (document.getElementById('bcl') || {}).value || '';
    try { await api('/api/hq/client/' + slug + '/link', 'POST', { project: v }); toast('Linked'); window.hqRefresh(); } catch (er) { toast(er.message); }
  };
  window.hqRerender = function () { if (HQ.data && document.body.classList.contains('hqmode')) show(navKey); };
  mnav();
})();
