/* Open Heart Media CRM: Home, Clients, Onboarding pages. Loaded after the outreach script. */
(function () {
  var HQ = { data: null, onb: null, loading: false, me: null };
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

  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function ini(n) { var w = String(n).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + ((w[1] || '')[0] || (w[0] || '')[1] || '')).toUpperCase(); }
  function e(s) { return esc(s == null ? '' : String(s)); }
  function dshort(d) { if (!d) return ''; return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  var STATUS = { active: 'Active', ending: 'Ending', seasonal: 'Seasonal', ads_off: 'Ads off', onboarding: 'Onboarding', internal: 'Ours' };
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
      '<div class="av" style="background:' + hue(c.name) + '">' + e(ini(c.name)) + '</div></div>';
  }
  function card(c, i) {
    var h = health(c), w = c.work;
    return '<a class="cl" tabindex="0" style="animation-delay:' + Math.min(i || 0, 12) * 35 + 'ms" onclick="hqNav(\'hq:client:' + e(c.slug) + '\')" onkeydown="if(event.key===\'Enter\')hqNav(\'hq:client:' + e(c.slug) + '\')">' +
      '<div class="cl-top">' + avatar(c) +
      '<div style="min-width:0"><div class="cl-name">' + e(c.name) + '</div><div class="cl-sub">' + e(c.note || (c.services || []).join(' · ') || 'No services listed') + '</div></div>' +
      '<div style="margin-left:auto" class="hl ' + h.k + '"><i></i>' + e(h.t) + '</div></div>' +
      '<div class="chips"><span class="chip st-' + e(c.status) + '">' + e(STATUS[c.status] || c.status) + '</span>' +
      (c.onboarding && c.onboarding.count ? '<span class="chip">Onboarded</span>' : (c.status === 'internal' ? '' : '<span class="chip need">No onboarding form</span>')) + '</div>' +
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

  function crow(c, i) {
    var h = health(c), w = c.work, p = progress(c);
    var meter = w && w.linked ? '<div class="mt"><div class="pbar" style="margin:0"><i style="width:' + p + '%"></i></div><span>' + p + '%</span></div>' : '<div class="mt na">Not synced</div>';
    var stat = w && w.linked ? '<span class="ct1"><b>' + w.open + '</b> open</span>' + (w.overdue ? '<span class="ct1 bad"><b>' + w.overdue + '</b> late</span>' : '') : '';
    return '<a class="crow" tabindex="0" style="--bc:' + e(c.color || hue(c.name)) + ';animation-delay:' + Math.min(i, 14) * 25 + 'ms" onclick="hqNav(\'hq:client:' + e(c.slug) + '\')" onkeydown="if(event.key===\'Enter\')hqNav(\'hq:client:' + e(c.slug) + '\')">' +
      avatar(c, 42) + '<div class="nm"><b>' + e(c.name) + '</b><span>' + e((c.services || []).join(' · ') || c.note || '') + '</span></div>' +
      '<span class="chip st-' + e(c.status) + '">' + e(STATUS[c.status] || c.status) + '</span>' + meter +
      '<div class="cs">' + stat + '</div><span class="nx">' + (w && w.nextDue ? e(dshort(w.nextDue)) : '') + '</span><span class="chev">' + ico('arrow') + '</span></a>';
  }
  function home() {
    var d = HQ.data, Pr = state.prospects || [];
    var clients = d.clients.filter(function (c) { return c.status !== 'internal'; });
    var active = clients.filter(function (c) { return c.status === 'active' || c.status === 'onboarding' || c.status === 'ads_off'; }).length;
    var open = 0, late = 0, done = 0, tot = 0, linked = 0, ontrack = 0;
    clients.forEach(function (c) { if (c.work && c.work.linked) { linked++; open += c.work.open; late += c.work.overdue; if (!c.work.overdue) ontrack++; c.work.lists.forEach(function (l) { var m = /(\d+)\/(\d+)/.exec(l.ratio || ''); if (m) { done += +m[1]; tot += +m[2]; } }); } });
    var replies = Pr.filter(function (p) { return typeof needsResponse === 'function' && needsResponse(p); });
    var att = [];
    clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.filter(function (t) { return t.overdue; }).forEach(function (t) {
      att.push('<div class="item"><div class="bub">' + ico('alert') + '</div><div><b>' + e(t.title) + '</b><div class="m">' + e(c.name) + ' · ' + e(t.who || 'Unassigned') + ' · was due ' + e(dshort(t.due)) + ' · <a href="' + e(t.url) + '" target="_blank" rel="noopener">Open</a></div></div></div>'); }); }); });
    replies.slice(0, 4).forEach(function (p) { att.push('<div class="item"><div class="bub amber">' + ico('reply') + '</div><div><b>' + e(p.business) + ' replied</b><div class="m">Outreach · <a onclick="navTo(\'replied\')">Open replies</a></div></div></div>'); });
    if (d.onboardingNoProject) att.push('<div class="item"><div class="bub blue">' + ico('clipboard') + '</div><div><b>' + d.onboardingNoProject + ' onboarding form' + (d.onboardingNoProject > 1 ? 's have' : ' has') + ' no Basecamp project</b><div class="m"><a onclick="hqNav(\'hq:onboarding\')">Review</a></div></div></div>');
    var noForm = clients.filter(function (c) { return c.status === 'active' && !(c.onboarding && c.onboarding.count); });
    var upcoming = [];
    clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.forEach(function (t) { if (t.due && !t.overdue) upcoming.push({ d: t.due, t: t.title, c: c.name }); }); }); });
    upcoming.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    var up = upcoming.slice(0, 5).map(function (u) { return '<div class="item"><div class="bub green">' + ico('clock') + '</div><div><b>' + e(u.t) + '</b><div class="m">' + e(u.c) + ' · ' + e(dshort(u.d)) + '</div></div></div>'; }).join('');
    var sent = Pr.filter(function (p) { return ['sent', 'replied', 'booked', 'won'].indexOf(p.status) > -1; }).length;
    var by = function (s) { return Pr.filter(function (p) { return p.status === s; }).length; };
    var need = att.length;
    var sub = !d.connected ? 'Connect Basecamp and every client\'s work shows up here.' : need ? need + ' thing' + (need > 1 ? 's' : '') + ' need you today.' : 'Nothing is late and nobody is waiting on you.';
    var trackPct = linked ? ontrack / linked * 100 : null, workPct = tot ? done / tot * 100 : null;
    var ks = function (cls, l, v, s) { return '<div class="kc ' + cls + '"><span class="kl">' + e(l) + '</span><b class="kv2">' + e(v) + '</b><span class="ks">' + e(s) + '</span></div>'; };
    return '<div class="hero2 rise"><div class="hl2"><div class="eyebrow">' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>' +
      '<h2>' + greeting() + (firstName() ? ', ' + e(firstName()) : '') + '</h2><p>' + e(sub) + '</p><div class="acts">' +
      (d.connected ? '<button class="btn2 red" onclick="hqNav(\'hq:clients\')">' + ico('users') + 'All clients</button>' : '<a class="btn2 red" href="/api/basecamp/connect">' + ico('link') + 'Connect Basecamp</a>') +
      '<a class="btn2 glass" href="/onboarding" target="_blank" rel="noopener">' + ico('clipboard') + 'Client form</a>' +
      '<button class="btn2 glass" onclick="hqRefresh()" aria-label="Refresh">' + ico('refresh') + 'Refresh</button></div></div>' +
      '<div class="gauges">' + gauge(trackPct, 'On track', '#5fe3a1') + gauge(workPct, 'Work done', '#7db4ff') + '</div></div>' +
      '<div class="kstrip rise">' + ks('', 'Clients', active, 'active now') + ks(late ? 'bad' : 'good', 'Late work', d.connected ? late : '-', d.connected ? open + ' open to-dos' : 'connect Basecamp') +
      ks('', 'Onboarding', d.onboardingTotal, noForm.length ? noForm.length + ' clients to go' : 'forms received') + ks(replies.length ? 'warn' : 'good', 'Replies waiting', replies.length, 'from outreach') + '</div>' +
      '<div class="hgrid"><div class="panel plist"><div class="ph"><h3>Clients</h3><a class="lnk" onclick="hqNav(\'hq:clients\')">Open all</a></div>' +
      '<div class="crows">' + clients.map(crow).join('') + '</div></div>' +
      '<div class="side"><div class="panel"><h3>Needs attention' + (need ? '<span class="ct">' + need + '</span>' : '') + '</h3>' +
      (need ? att.slice(0, 6).join('') : '<div class="empty">' + ico('check') + 'All clear.</div>') + '</div>' +
      '<div class="panel"><h3>Coming up</h3>' + (up || '<div class="empty">' + ico('clock') + (d.connected ? 'Nothing dated yet.' : 'Appears once Basecamp is connected.') + '</div>') + '</div></div></div>' +
      '<div class="panel orow"><div class="oh"><h3>Outreach</h3><a class="lnk" onclick="hqNav(\'hq:outreach\')">Open</a></div><div class="strip">' +
      '<div><b>' + Pr.filter(function (p) { return !p.internal; }).length.toLocaleString() + '</b><span>Leads</span></div><div><b>' + sent + '</b><span>Contacted</span></div><div><b>' + by('replied') + '</b><span>Replied</span></div><div><b>' + by('booked') + '</b><span>Booked</span></div><div><b>' + by('won') + '</b><span>Won</span></div></div></div>';
  }

  function clients() {
    var d = HQ.data;
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Clients</h3><p>' + d.clients.length + ' on the books. Open one for everything about them.</p></div></div>' +
      (d.connected ? '' : '<div class="banner">' + ico('alert') + '<div><b>Basecamp is not connected,</b> so to-dos and late work are hidden. <a class="lnk" href="/api/basecamp/connect">Connect Basecamp</a></div></div>') +
      '<div class="cl-grid">' + d.clients.map(card).join('') + '</div>';
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
      '<div class="banner-h rise" style="--cc:' + hue(c.name) + '"><div class="row">' + avatar(c, 76) + '<div class="grow"><h2>' + e(c.name) + '</h2>' +
      '<div class="chips" style="margin-top:10px"><span class="chip">' + e(STATUS[c.status] || c.status) + '</span>' + (c.services || []).map(function (s) { return '<span class="chip">' + e(s) + '</span>'; }).join('') + '</div></div>' +
      '<div class="hl ' + h.k + '" style="font-size:14px"><i style="width:10px;height:10px"></i>' + e(h.t) + '</div></div></div>' +
      (c.note ? '<div class="banner">' + ico('alert') + '<div>' + e(c.note) + '</div></div>' : '') +
      '<div class="two"><div class="panel"><h3>Work</h3>' + lists + '</div><div style="display:grid;gap:16px">' +
      '<div class="panel"><h3>Team</h3><div class="kv"><span>Website</span><b>' + e(c.website_owner) + '</b></div><div class="kv"><span>Ads</span><b>' + e(c.ads_owner) + '</b></div>' +
      (w && w.linked ? '<div class="kv"><span>Basecamp</span><a class="lnk" href="' + e(w.project.url) + '" target="_blank" rel="noopener">Open project</a></div>' : '') + '</div>' +
      '<div class="panel"><h3>Onboarding answers</h3>' + onb + '</div>' +
      '<div class="panel"><h3>Activity</h3><div class="tl" style="margin-top:12px">' + tl + '</div></div></div></div>';
  }

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
      return '<tr><td><div class="nm">' + e(u.name) + '</div><div class="em">' + e(u.email) + '</div></td><td><span class="chip st-' + (u.role === 'admin' ? 'internal' : 'active') + '">' + (u.role === 'admin' ? 'Admin' : 'Member') + '</span>' + (u.active ? '' : ' <span class="chip st-ending">Off</span>') + (u.must_change ? ' <span class="chip need">Needs new password</span>' : '') + '</td>' +
        '<td class="em">' + (u.last_login ? e(new Date(u.last_login).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : 'Never') + '</td><td style="text-align:right;white-space:nowrap">' +
        '<button class="btn2 line mini" onclick="hqReset(\'' + e(u.id) + '\')">Reset password</button> ' +
        (me.id !== u.id ? '<button class="btn2 line mini" onclick="hqActive(\'' + e(u.id) + '\',' + (u.active ? 'false' : 'true') + ')">' + (u.active ? 'Turn off' : 'Turn on') + '</button>' : '') + '</td></tr>';
    }).join('');
    return '<div class="sec rise"><div><h3 style="font-size:28px;letter-spacing:-.03em">Team</h3><p>Everyone who can log in. Each person sees their own name.</p></div></div><div id="tempbox"></div>' +
      '<div class="panel" style="margin-bottom:16px"><h3>Add a person</h3><div class="frm" style="margin-top:12px"><div><label for="nu_n">Name</label><input id="nu_n" placeholder="Full name"></div><div><label for="nu_e">Email</label><input id="nu_e" type="email" placeholder="name@openheartmediaco.com"></div><div><label for="nu_r">Role</label><select id="nu_r"><option value="member">Member</option><option value="admin">Admin</option></select></div><button class="btn2 red" onclick="hqAddUser()">Add</button></div></div>' +
      '<div class="panel"><table class="ttab"><thead><tr><th>Person</th><th>Access</th><th>Last in</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function showTemp(who, pw) {
    var b = document.getElementById('tempbox'); if (!b) return;
    b.innerHTML = '<div class="tempbox"><b>Temporary password for ' + e(who) + '</b><div style="margin:10px 0"><code>' + e(pw) + '</code></div><div style="color:#9db3d6;font-size:13px">Send it to them privately. It is shown once. They pick their own password the first time they log in.</div></div>';
    window.scrollTo(0, 0);
  }
  window.hqAddUser = async function () {
    var n = document.getElementById('nu_n').value, em = document.getElementById('nu_e').value, ro = document.getElementById('nu_r').value;
    try { var r = await api('/api/admin/users', 'POST', { name: n, email: em, role: ro }); await show('hq:team'); showTemp(r.user.name, r.temp_password); } catch (er) { toast(er.message); }
  };
  window.hqReset = async function (id) {
    if (!confirm('Reset this password? Their old password stops working.')) return;
    try { var r = await api('/api/admin/users/' + id + '/reset', 'POST', {}); var u = (HQ.users || []).filter(function (x) { return x.id === id; })[0]; await show('hq:team'); showTemp(u ? u.name : 'them', r.temp_password); } catch (er) { toast(er.message); }
  };
  window.hqActive = async function (id, on) { try { await api('/api/admin/users/' + id + '/active', 'POST', { active: on }); show('hq:team'); } catch (er) { toast(er.message); } };

  // Phone bottom bar
  function mnav() {
    var el = document.getElementById('mnav'); if (!el) { el = document.createElement('nav'); el.id = 'mnav'; el.setAttribute('aria-label', 'Main'); document.body.appendChild(el); }
    var items = [['hq:home', 'home', 'Home'], ['hq:clients', 'users', 'Clients'], ['hq:onboarding', 'clipboard', 'Onboarding'], ['hq:outreach', 'kanban', 'Outreach']];
    el.innerHTML = items.map(function (it) { return '<button class="' + ((navKey === it[0] || (it[0] === 'hq:outreach' && String(navKey).indexOf('hq:') !== 0)) ? 'on' : '') + '" onclick="navTo(\'' + it[0] + '\')">' + ico(it[1]) + '<span>' + it[2] + '</span></button>'; }).join('');
  }

  async function show(key) {
    document.body.classList.add('hqmode');
    var titles = { 'hq:home': 'Home', 'hq:clients': 'Clients', 'hq:onboarding': 'Onboarding', 'hq:outreach': 'Outreach', 'hq:team': 'Team' };
    document.body.classList.remove('outdetail'); document.body.classList.toggle('hqout', key === 'hq:outreach');
    document.getElementById('viewTitle').textContent = titles[key] || 'Client';
    var el = root();
    if (!HQ.data) { el.innerHTML = skeleton(); await fetchHq(false); }
    if (!HQ.data) { el.innerHTML = '<div class="empty">Could not load: ' + e(HQ.err || 'error') + '</div>'; return; }
    if (key === 'hq:home') el.innerHTML = home();
    else if (key === 'hq:clients') el.innerHTML = clients();
    else if (key === 'hq:onboarding') el.innerHTML = onboarding();
    else if (key === 'hq:outreach') el.innerHTML = outreach();
    else if (key === 'hq:team') el.innerHTML = await team();
    else if (key.indexOf('hq:client:') === 0) el.innerHTML = clientPage(key.slice(10));
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
