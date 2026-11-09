/* Open Heart Media CRM: Home, Clients, Onboarding pages. Loaded after the outreach script. */
(function () {
  var HQ = { data: null, onb: null, loading: false };
  var COLORS = ['#2f6fd0', '#e22a24', '#1c7a52', '#6b5bd2', '#b3730c', '#0f7c8c', '#c2185b', '#455a9c'];
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function ini(n) { var w = String(n).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + ((w[1] || '')[0] || (w[0] || '')[1] || '')).toUpperCase(); }
  function e(s) { return esc(s == null ? '' : String(s)); }
  function dshort(d) { if (!d) return ''; var x = new Date(d + 'T12:00:00'); return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  var STATUS = { active: 'Active', ending: 'Ending', seasonal: 'Seasonal', ads_off: 'Ads off', onboarding: 'Onboarding', internal: 'Ours' };

  function root() { return document.getElementById('hq'); }
  function health(c) {
    if (!c.work || !c.work.linked) return { k: '', t: c.work === null ? 'Not synced' : 'Not linked' };
    if (c.work.overdue > 0) return { k: 'red', t: c.work.overdue + ' late' };
    if (c.work.open === 0) return { k: 'green', t: 'All clear' };
    return { k: 'green', t: 'On track' };
  }
  function progress(c) {
    if (!c.work || !c.work.lists) return 0; var done = 0, tot = 0;
    c.work.lists.forEach(function (l) { var m = /(\d+)\/(\d+)/.exec(l.ratio || ''); if (m) { done += +m[1]; tot += +m[2]; } });
    return tot ? Math.round(done / tot * 100) : 0;
  }
  function card(c) {
    var h = health(c), w = c.work, p = progress(c);
    return '<a class="cl" onclick="hqNav(\'hq:client:' + e(c.slug) + '\')">' +
      '<div class="cl-top"><div class="av" style="background:' + hue(c.name) + '">' + e(ini(c.name)) + '</div>' +
      '<div><div class="cl-name">' + e(c.name) + '</div><div class="cl-sub">' + e(c.note || (c.services || []).join(' · ') || 'No services listed') + '</div></div>' +
      '<div class="hl ' + h.k + '"><i></i>' + e(h.t) + '</div></div>' +
      '<div class="chips"><span class="chip st-' + e(c.status) + '">' + e(STATUS[c.status] || c.status) + '</span>' +
      (c.onboarding && c.onboarding.count ? '<span class="chip">Onboarded</span>' : (c.status === 'internal' ? '' : '<span class="chip" style="background:#fff1d6;color:#a86400">No onboarding form</span>')) + '</div>' +
      (w && w.linked ? '<div class="bar"><i style="width:' + p + '%"></i></div><div class="cl-stats"><span><b>' + w.open + '</b> open</span><span class="od"><b>' + w.overdue + '</b> late</span>' + (w.nextDue ? '<span>Next due <b>' + e(dshort(w.nextDue)) + '</b></span>' : '') + '</div>' : '') +
      '</a>';
  }

  async function fetchHq(force) {
    if (HQ.loading) return;
    HQ.loading = true;
    try {
      if (force) await fetch('/api/hq/refresh');
      HQ.data = await api('/api/hq');
      HQ.onb = (await api('/api/onboarding')).responses || [];
    } catch (err) { HQ.err = err.message; }
    HQ.loading = false;
  }

  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

  function home() {
    var d = HQ.data, P = state.prospects || [];
    var clients = d.clients.filter(function (c) { return c.status !== 'internal'; });
    var active = clients.filter(function (c) { return c.status === 'active' || c.status === 'onboarding' || c.status === 'ads_off'; }).length;
    var open = 0, late = 0;
    clients.forEach(function (c) { if (c.work && c.work.linked) { open += c.work.open; late += c.work.overdue; } });
    var replies = P.filter(function (p) { return typeof needsResponse === 'function' && needsResponse(p); });
    var noProj = d.onboardingNoProject;
    var att = [];
    clients.forEach(function (c) {
      if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.filter(function (t) { return t.overdue; }).forEach(function (t) {
        att.push('<div class="att"><span class="dot"></span><div><b>' + e(t.title) + '</b><div class="m">' + e(c.name) + ' · ' + e(t.who || 'unassigned') + ' · was due ' + e(dshort(t.due)) + ' · <a href="' + e(t.url) + '" target="_blank">open in Basecamp</a></div></div></div>');
      }); });
    });
    replies.slice(0, 5).forEach(function (p) { att.push('<div class="att"><span class="dot amber"></span><div><b>' + e(p.business) + ' replied</b><div class="m">Outreach · <a onclick="navTo(\'replied\')">open replies</a></div></div></div>'); });
    if (noProj) att.push('<div class="att"><span class="dot blue"></span><div><b>' + noProj + ' onboarding form' + (noProj > 1 ? 's' : '') + ' without a Basecamp project</b><div class="m"><a onclick="hqNav(\'hq:onboarding\')">Review submissions</a></div></div></div>');
    var noForm = clients.filter(function (c) { return c.status === 'active' && !(c.onboarding && c.onboarding.count); });
    var upcoming = [];
    clients.forEach(function (c) { if (c.work && c.work.linked) c.work.lists.forEach(function (l) { l.open.forEach(function (t) { if (t.due && !t.overdue) upcoming.push({ d: t.due, t: t.title, c: c.name, u: t.url }); }); }); });
    upcoming.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    var up = upcoming.slice(0, 7).map(function (u) { return '<div class="att"><span class="dot green"></span><div><b>' + e(u.t) + '</b><div class="m">' + e(u.c) + ' · due ' + e(dshort(u.d)) + '</div></div></div>'; }).join('');
    var sent = P.filter(function (p) { return ['sent', 'replied', 'booked', 'won'].indexOf(p.status) > -1; }).length;
    var by = function (s) { return P.filter(function (p) { return p.status === s; }).length; };
    var connectCard = d.connected ? '' :
      '<div class="note2"><b>Connect Basecamp to light this page up.</b> Every client\'s to-dos, late work and due dates will show here and on each client page. <a class="lnk" href="/api/basecamp/connect">Connect Basecamp</a></div>';
    return '<div class="hq-hero"><div><div class="hq-date">' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>' +
      '<h2>' + greeting() + ', Zac</h2><p>Here is what needs you today.</p></div>' +
      '<div><button class="cta ghost" onclick="hqRefresh()">Refresh</button></div></div>' + connectCard +
      '<div class="hq-kpis">' +
      '<div class="kpi kp-blue"><div class="l">Clients</div><div class="v">' + active + '</div><div class="s">active right now</div></div>' +
      '<div class="kpi kp-' + (late ? 'bad' : 'good') + '"><div class="l">Late work</div><div class="v">' + (d.connected ? late : '-') + '</div><div class="s">' + (d.connected ? open + ' open to-dos across clients' : 'connect Basecamp') + '</div></div>' +
      '<div class="kpi kp-warn"><div class="l">Onboarding</div><div class="v">' + d.onboardingTotal + '</div><div class="s">form' + (d.onboardingTotal === 1 ? '' : 's') + ' received' + (noForm.length ? ' · ' + noForm.length + ' clients not yet' : '') + '</div></div>' +
      '<div class="kpi kp-' + (replies.length ? 'warn' : 'good') + '"><div class="l">Replies waiting</div><div class="v">' + replies.length + '</div><div class="s">from outreach</div></div></div>' +
      '<div class="hq-grid"><div class="card2"><h3>Needs attention' + (att.length ? '<span class="ct">' + att.length + '</span>' : '') + '</h3>' +
      (att.length ? att.slice(0, 9).join('') : '<div class="empty">Nothing is late and nobody is waiting on you. Nice.</div>') + '</div>' +
      '<div class="card2"><h3>Coming up</h3>' + (up || '<div class="empty">' + (d.connected ? 'No dated work coming up.' : 'Due dates appear here once Basecamp is connected.') + '</div>') + '</div></div>' +
      '<div class="sec-h"><h3>Clients</h3><a class="lnk" onclick="hqNav(\'hq:clients\')">See all</a></div>' +
      '<div class="cl-grid">' + clients.slice(0, 8).map(card).join('') + '</div>' +
      '<div class="sec-h" style="margin-top:26px"><h3>Outreach</h3><a class="lnk" onclick="navTo(\'board\')">Open pipeline</a></div>' +
      '<div class="card2"><div class="strip"><div><b>' + P.filter(function (p) { return !p.internal; }).length + '</b><span>Leads</span></div><div><b>' + sent + '</b><span>Contacted</span></div><div><b>' + by('replied') + '</b><span>Replied</span></div><div><b>' + by('booked') + '</b><span>Booked</span></div><div><b>' + by('won') + '</b><span>Won</span></div></div></div>';
  }

  function clients() {
    var d = HQ.data;
    return '<div class="hq-hero"><div><h2>Clients</h2><p>' + d.clients.length + ' on the books. Click one for everything about them.</p></div></div>' +
      (d.connected ? '' : '<div class="note2"><b>Basecamp is not connected,</b> so to-dos and late work are hidden. <a class="lnk" href="/api/basecamp/connect">Connect Basecamp</a></div>') +
      '<div class="cl-grid">' + d.clients.map(card).join('') + '</div>';
  }

  function clientPage(slug) {
    var c = HQ.data.clients.filter(function (x) { return x.slug === slug; })[0];
    if (!c) return '<div class="empty">Client not found.</div>';
    var h = health(c), w = c.work, mine = (HQ.onb || []).filter(function (r) { return r.client === slug; });
    var formUrl = location.origin + '/onboarding?client=' + encodeURIComponent(slug);
    var lists = '';
    if (w && w.linked) {
      lists = w.lists.map(function (l) {
        return '<div style="margin-bottom:16px"><div class="list-h"><b>' + e(l.name) + '</b><span>' + e(l.ratio ? l.ratio + ' done' : '') + ' · <a class="lnk" href="' + e(l.url) + '" target="_blank">Basecamp</a></span></div>' +
          (l.open.length ? l.open.map(function (t) { return '<div class="td"><span class="ck"></span><div><a href="' + e(t.url) + '" target="_blank">' + e(t.title) + '</a><div class="who">' + e(t.who || 'Unassigned') + '</div></div><span class="due ' + (t.overdue ? 'od' : '') + '">' + (t.due ? (t.overdue ? 'Late ' : '') + e(dshort(t.due)) : '') + '</span></div>'; }).join('') : '<div class="empty" style="padding:6px 0">Everything here is done.</div>') + '</div>';
      }).join('') || '<div class="empty">No to-do lists in this project yet.</div>';
    } else if (!HQ.data.connected) {
      lists = '<div class="empty">Connect Basecamp to see this client\'s to-dos. <a class="lnk" href="/api/basecamp/connect">Connect</a></div>';
    } else {
      lists = '<div class="empty">No Basecamp project found for ' + e(c.name) + '. Paste its link:</div><div class="linkrow"><input id="bcl" placeholder="https://app.basecamp.com/.../buckets/12345..."><button class="cta" onclick="hqLink(\'' + e(slug) + '\')">Link</button></div>' + (c.workError ? '<div class="m" style="color:#c4261d;margin-top:8px">' + e(c.workError) + '</div>' : '');
    }
    var onb = mine.length ? mine.slice().reverse().map(function (r) { return '<details class="sm"><summary>' + e(r.contact_name || r.email) + ' · ' + e(new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</summary><pre>' + e(r.summary || JSON.stringify(r.answers, null, 2)) + '</pre></details>'; }).join('')
      : '<div class="empty" style="padding:6px 0">No answers yet. Send them this link:</div><div class="linkrow"><input readonly value="' + e(formUrl) + '" onclick="this.select()"><button class="cta ghost" onclick="navigator.clipboard.writeText(\'' + e(formUrl) + '\');toast(\'Link copied\')">Copy</button></div>';
    return '<a class="back" onclick="hqNav(\'hq:clients\')">&larr; All clients</a>' +
      '<div class="ch-head"><div class="av" style="background:' + hue(c.name) + '">' + e(ini(c.name)) + '</div><div><h2>' + e(c.name) + '</h2>' +
      '<div class="chips" style="margin-top:6px"><span class="chip st-' + e(c.status) + '">' + e(STATUS[c.status] || c.status) + '</span>' + (c.services || []).map(function (s) { return '<span class="chip">' + e(s) + '</span>'; }).join('') + '</div></div>' +
      '<div class="hl ' + h.k + '" style="margin-left:auto;font-size:14px"><i style="width:13px;height:13px"></i>' + e(h.t) + '</div></div>' +
      (c.note ? '<div class="note2">' + e(c.note) + '</div>' : '') +
      '<div class="two"><div class="card2"><h3>Work</h3>' + lists + '</div><div>' +
      '<div class="card2" style="margin-bottom:16px"><h3>Team</h3><div class="kv2"><span>Website</span><b>' + e(c.website_owner) + '</b></div><div class="kv2"><span>Ads</span><b>' + e(c.ads_owner) + '</b></div>' +
      (w && w.linked ? '<div class="kv2"><span>Basecamp</span><a class="lnk" href="' + e(w.project.url) + '" target="_blank">Open project</a></div>' : '') + '</div>' +
      '<div class="card2"><h3>Onboarding answers</h3>' + onb + '</div></div></div>';
  }

  function onboarding() {
    var rows = (HQ.onb || []);
    return '<div class="hq-hero"><div><h2>Onboarding</h2><p>Everything new clients tell us, one place.</p></div><div><a class="cta" href="/onboarding" target="_blank">Open the client form</a></div></div>' +
      '<div class="card2">' + (rows.length ? rows.map(function (r) {
        return '<details class="sm"><summary>' + e(r.business) + ' <span class="chip" style="margin-left:6px">' + e(r.client || 'older form') + '</span> <span class="m" style="color:var(--mut);font-weight:400">· ' + e(new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + (r.basecamp ? ' · <a class="lnk" href="' + e(r.basecamp.url) + '" target="_blank">Basecamp</a>' : '') + '</span></summary><pre>' + e(r.summary || JSON.stringify(r.answers, null, 2)) + '</pre></details>';
      }).join('') : '<div class="empty">No submissions yet. Add <code>?client=their-name</code> to the form link for each client so their answers file under their name.</div>') + '</div>';
  }

  async function show(key) {
    document.body.classList.add('hqmode');
    var titles = { 'hq:home': 'Home', 'hq:clients': 'Clients', 'hq:onboarding': 'Onboarding' };
    document.getElementById('viewTitle').textContent = titles[key] || 'Client';
    var el = root();
    if (!HQ.data) { el.innerHTML = '<div class="empty">Loading your clients…</div>'; await fetchHq(false); }
    if (!HQ.data) { el.innerHTML = '<div class="empty">Could not load: ' + e(HQ.err || 'error') + '</div>'; return; }
    if (key === 'hq:home') el.innerHTML = home();
    else if (key === 'hq:clients') el.innerHTML = clients();
    else if (key === 'hq:onboarding') el.innerHTML = onboarding();
    else if (key.indexOf('hq:client:') === 0) el.innerHTML = clientPage(key.slice(10));
    window.scrollTo(0, 0);
  }

  window.hqNav = function (key) {
    if (String(key).indexOf('hq:') !== 0) { document.body.classList.remove('hqmode'); return false; }
    navKey = key; if (typeof renderNav === 'function') renderNav();
    show(key); return true;
  };
  window.hqRefresh = async function () { HQ.data = null; document.getElementById('hq').innerHTML = '<div class="empty">Refreshing…</div>'; await fetchHq(true); show(navKey); };
  window.hqLink = async function (slug) {
    var v = (document.getElementById('bcl') || {}).value || '';
    try { await api('/api/hq/client/' + slug + '/link', 'POST', { project: v }); toast('Linked'); window.hqRefresh(); } catch (er) { toast(er.message); }
  };
  window.hqRerender = function(){ if (HQ.data && document.body.classList.contains('hqmode')) show(navKey); };
  window.hqStart = function () { window.hqNav('hq:home'); };
})();
