// Workspace dashboard: what index.html shows once someone is signed in.
//
// It answers three questions as soon as the page opens:
//   What needs my attention?   -> "Needs your attention" (stalled lists, big open counts, empty lists, invites nobody accepted)
//   What's happening?          -> "Your projects" (progress per punch list) and "Recent activity" (sign-offs, new items, new lists)
//   What should I do next?     -> "Up next", in priority order
// and the sentence at the top sums all three up.
//
// Reads the same Firestore data as My Lists (all-lists/allLists.js):
//   users/{uid}/profile/info                 name, workspaceId
//   workspaces/{wid}                         name, ownerId
//   workspaces/{wid}/members/{uid}           displayName, email, canEdit, admin
//   workspaces/{wid}/invites/{email}         pending invitations
//   jobs (workspaceId == wid)                lot, community, address, description, date, openCount, totalCount, createdAt, updatedAt, archived
//   jobs/{id}/custom/{itemId}                text, room, trade, createdAt         (the punch items)
//   jobs/{id}/items/{itemId}                 done, doneAt, signedBy, trade        (their status)
//   jobs/{id}/rooms/{roomId}                 name, floor
//   jobs/{id}/hidden/{roomId}                hidden
// Nothing here writes to Firestore.
(() => {
  'use strict';
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const $ = id => document.getElementById(id);
  const root = document.getElementById('db');
  if (!root) return;

  const DAY = 864e5;
  const STALE_DAYS = 7;        // open items and no activity for this long = stalled
  const BIG_OPEN = 10;         // this many open items = needs attention
  const NEARLY_DONE = 3;       // this few left = close it out
  const MAX_DETAIL_JOBS = 40;  // read items for at most this many lists (most recent first)

  const st = { user: null, profile: {}, wid: '', ws: {}, members: [], invites: [], jobs: [], canEdit: false, isAdmin: false, loaded: false };

  // ---------- Small helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(href, cls, text) { const a = el('a', cls, text); a.href = href; return a; }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const toMs = v => !v ? 0 : typeof v === 'string' ? (Date.parse(v) || 0) : v.toMillis ? v.toMillis() : v.toDate ? +v.toDate() : +v || 0;
  const daysSince = ms => ms ? Math.floor((Date.now() - ms) / DAY) : Infinity;
  function ago(ms) {
    if (!ms) return '';
    const m = Math.round((Date.now() - ms) / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return plural(h, 'hour') + ' ago';
    const d = Math.round(h / 24);
    if (d < 7) return d === 1 ? 'yesterday' : d + ' days ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function dayLabel(ms) {
    const d = new Date(ms), t = new Date();
    const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(t) - start(d)) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }
  const fmtDay = s => { const d = s ? new Date(s + (s.length === 10 ? 'T12:00' : '')) : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; };
  // Same title My Lists uses: "Lot 12 · Oakwood · Final walk"
  function jobTitle(j) {
    const desc = (j.description || '').replace(/\s+/g, ' ').trim();
    return [j.lot && 'Lot ' + j.lot, j.community, desc].filter(Boolean).join(' · ') || 'Untitled punch list';
  }
  // A short name for sentences: "Lot 12" or the community or the first words of the title
  function shortName(j) {
    if (j.lot) return 'Lot ' + j.lot;
    if (j.community) return j.community;
    const t = jobTitle(j);
    return t.length > 28 ? t.slice(0, 26).trim() + '…' : t;
  }
  const listUrl = id => 'allLists.html?job=' + encodeURIComponent(id);
  const projUrl = id => '#projects/' + encodeURIComponent(id);
  function memberName(uid) {
    const m = st.members.find(x => x.id === uid);
    return m ? (m.displayName || m.email || 'Someone') : 'Someone';
  }
  let toastTimer;
  function toast(text) {
    const t = $('dbToast');
    t.textContent = text;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 3200);
  }
  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>'
  };

  // ---------- Load ----------
  async function load(user) {
    st.user = user;
    const p = await db.doc('users/' + user.uid + '/profile/info').get();
    st.profile = p.exists ? p.data() : {};
    st.wid = st.profile.workspaceId || '';
    if (!st.wid || !st.profile.username) { location.replace('signup.html'); return; } // setup not finished

    const [w, ms] = await Promise.all([
      db.doc('workspaces/' + st.wid).get(),
      db.collection('workspaces/' + st.wid + '/members').get()
    ]);
    st.ws = w.exists ? w.data() : {};
    st.members = ms.docs.map(d => ({ id: d.id, ...d.data() }));
    const me = st.members.find(m => m.id === user.uid) || {};
    const isOwner = st.ws.ownerId === user.uid;
    st.isAdmin = isOwner || me.admin === true;
    st.canEdit = st.isAdmin || me.canEdit === true;
    try { st.invites = (await db.collection('workspaces/' + st.wid + '/invites').get()).docs.map(d => ({ id: d.id, ...d.data() })); }
    catch (e) { st.invites = []; }

    const js = await db.collection('jobs').where('workspaceId', '==', st.wid).get();
    st.jobs = js.docs.map(d => ({ id: d.id, ...d.data() })).filter(j => !j.archived)
      .map(j => Object.assign(j, { _items: null, _rooms: {}, _last: Math.max(toMs(j.updatedAt), toMs(j.createdAt)) }))
      .sort((a, b) => b._last - a._last);

    renderHello();
    renderAll(); // first pass from the list records alone, so the page fills in fast
    await loadItems(st.jobs.slice(0, MAX_DETAIL_JOBS));
    st.loaded = true;
    renderAll();
  }

  // Read each list's items, statuses and rooms. One failing list doesn't stop the others.
  async function loadItems(jobs) {
    await Promise.all(jobs.map(async j => {
      try {
        const get = c => db.collection('jobs/' + j.id + '/' + c).get().then(s => Object.fromEntries(s.docs.map(d => [d.id, d.data()])));
        const [custom, items, rooms, hidden] = await Promise.all([get('custom'), get('items'), get('rooms'), get('hidden')]);
        j._rooms = rooms;
        j._items = Object.entries(custom)
          .filter(([, c]) => c && c.text && !(hidden[c.room] && hidden[c.room].hidden))
          .map(([id, c]) => {
            const r = items[id] || {};
            return {
              id, text: c.text, room: c.room, roomName: (rooms[c.room] && rooms[c.room].name) || 'Other',
              trade: r.trade || c.trade || '', done: !!r.done, doneAt: toMs(r.doneAt), signedBy: r.signedBy || '',
              createdAt: toMs(c.createdAt)
            };
          });
        j._items.forEach(it => { j._last = Math.max(j._last, it.doneAt, it.createdAt); });
      } catch (e) { console.error('Could not read list ' + j.id, e); }
    }));
  }

  // Open and total counts: worked out from the items when we have them, otherwise the counts saved on the list
  function counts(j) {
    if (j._items) {
      const open = j._items.filter(i => !i.done).length;
      return { open, total: j._items.length };
    }
    return { open: typeof j.openCount === 'number' ? j.openCount : 0, total: j.totalCount || 0 };
  }

  // ---------- Analysis: the three answers ----------
  function analyze() {
    const jobs = st.jobs.map(j => {
      const c = counts(j);
      return { j, ...c, idle: daysSince(j._last), pct: c.total ? Math.round((c.total - c.open) / c.total * 100) : 0 };
    });
    const openTotal = jobs.reduce((s, x) => s + x.open, 0);
    const weekAgo = Date.now() - 7 * DAY;
    const signedWeek = st.jobs.reduce((s, j) => s + (j._items || []).filter(i => i.done && i.doneAt >= weekAgo).length, 0);

    // What needs my attention?
    const flags = [];
    jobs.forEach(x => {
      if (x.open > 0 && x.idle >= STALE_DAYS && x.idle !== Infinity)
        flags.push({ sev: 'high', score: 300 + x.idle, job: x.j, title: shortName(x.j) + ' has gone quiet', sub: 'No activity in ' + x.idle + ' days, with ' + plural(x.open, 'item') + ' still open', num: x.open });
      else if (x.open >= BIG_OPEN)
        flags.push({ sev: 'med', score: 200 + x.open, job: x.j, title: shortName(x.j) + ' has a long punch list', sub: x.pct + '% done so far', num: x.open });
      else if (x.total === 0)
        flags.push({ sev: 'low', score: 100, job: x.j, title: shortName(x.j) + ' has no punch items yet', sub: 'Created ' + (ago(toMs(x.j.createdAt)) || 'recently'), num: null });
    });
    if (st.isAdmin) st.invites.forEach(i => {
      const d = daysSince(toMs(i.createdAt));
      if (d >= 3 && d !== Infinity) flags.push({ sev: 'low', score: 50 + d, href: 'settings.html#members', title: (i.email || i.id) + " hasn't joined", sub: 'Invited ' + d + ' days ago', num: null });
    });
    flags.sort((a, b) => b.score - a.score);

    // What should I do next? (most useful first)
    const next = [];
    const nearly = jobs.filter(x => x.open > 0 && x.open <= NEARLY_DONE && x.total > 0).sort((a, b) => a.open - b.open);
    nearly.slice(0, 2).forEach(x => next.push({ title: 'Close out ' + shortName(x.j), sub: plural(x.open, 'item') + ' left to sign off', href: listUrl(x.j.id), action: 'Open list' }));
    const stale = jobs.filter(x => x.open > 0 && x.idle >= STALE_DAYS && x.idle !== Infinity).sort((a, b) => b.idle - a.idle);
    stale.slice(0, 2).forEach(x => next.push({ title: 'Check in on ' + shortName(x.j), sub: 'Quiet for ' + x.idle + ' days', href: listUrl(x.j.id), action: 'Open list' }));
    const busiest = jobs.filter(x => x.open > NEARLY_DONE && !stale.includes(x)).sort((a, b) => b.open - a.open)[0];
    if (busiest) next.push({ title: 'Work down ' + shortName(busiest.j), sub: plural(busiest.open, 'open item') + ', the most of any project', href: listUrl(busiest.j.id), action: 'Open list' });
    const empty = jobs.filter(x => x.total === 0);
    if (empty.length && st.canEdit) next.push({ title: 'Add items to ' + shortName(empty[0].j), sub: empty.length > 1 ? plural(empty.length, 'list') + ' have no items yet' : 'Walk the site and add what needs fixing', href: listUrl(empty[0].j.id), action: 'Add items' });
    if (!jobs.length && st.canEdit) next.push({ title: 'Start your first punch list', sub: 'Add a lot, rooms and the items that need fixing', href: 'allLists.html?new=1', action: 'New punch list', main: true });
    if (st.isAdmin && st.invites.length) next.push({ title: 'Follow up on ' + plural(st.invites.length, 'invitation'), sub: "They haven't joined the workspace yet", href: 'settings.html#members', action: 'View invites' });
    if (st.isAdmin && st.members.length < 2) next.push({ title: 'Invite your team', sub: 'Supers and trades can check items off from their phones', href: 'settings.html#admin', action: 'Invite people' });
    if (!next.length) next.push({ title: 'Everything is signed off', sub: st.canEdit ? 'Start the next punch list when you walk a new lot' : 'Nothing is waiting on you right now', href: st.canEdit ? 'allLists.html?new=1' : '#projects', action: st.canEdit ? 'New punch list' : 'See projects' });

    // What's happening? (newest first)
    const events = [];
    st.jobs.forEach(j => {
      (j._items || []).forEach(i => {
        if (i.done && i.doneAt) events.push({ t: i.doneAt, kind: 'signed', who: i.signedBy || 'Someone', what: i.text, job: j });
        if (i.createdAt) events.push({ t: i.createdAt, kind: 'added', what: i.text, job: j });
      });
      const c = toMs(j.createdAt);
      if (c) events.push({ t: c, kind: 'created', who: memberName(j.ownerId), job: j });
    });
    events.sort((a, b) => b.t - a.t);

    return { jobs, openTotal, signedWeek, flags, next: next.slice(0, 5), events: events.slice(0, 10) };
  }

  // ---------- Render ----------
  function renderHello() {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = ((st.profile.name || st.user.displayName || '').trim().split(/\s+/)[0]) || 'there';
    const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const p = $('dbHello');
    p.textContent = part + ', ';
    p.appendChild(el('b', null, first));
    p.appendChild(document.createTextNode('. ' + date + (st.ws.name ? ' at ' + st.ws.name : '') + '.'));
  }

  function renderAll() {
    const a = analyze();
    renderBrief(a);
    renderFacts(a);
    renderFlags(a);
    renderNext(a);
    renderProgress(a);
    renderFeed(a);
    renderProjects(a);
    route();
  }

  // The sentence that answers all three questions. Parts that point somewhere are links.
  function renderBrief(a) {
    const b = $('dbBrief');
    b.textContent = '';
    b.classList.remove('is-loading');
    const parts = [];
    const add = (text, href) => parts.push({ text, href });
    if (!a.jobs.length) {
      add('Your workspace is ready. ');
      add(st.canEdit ? 'Start your first punch list.' : 'Projects will show up here once an editor starts one.', st.canEdit ? 'allLists.html?new=1' : null);
    } else {
      const flagged = new Set(a.flags.filter(f => f.job).map(f => f.job.id)).size;
      if (flagged) { add(plural(flagged, 'project needs', 'projects need'), '#attention'); add(' you, '); }
      if (a.openTotal) { add(plural(a.openTotal, 'item'), '#progress'); add(a.openTotal === 1 ? ' is still open' : ' are still open'); }
      else add('every punch item is signed off');
      const first = a.next[0];
      const close = a.jobs.filter(x => x.open > 0 && x.open <= NEARLY_DONE && x.total > 0).sort((x, y) => x.open - y.open)[0];
      if (close) { add(', and '); add(shortName(close.j), listUrl(close.j.id)); add(' is ' + plural(close.open, 'item') + ' from done.'); }
      else if (first && a.openTotal) { add('. Next: '); add(first.title.charAt(0).toLowerCase() + first.title.slice(1), first.href); add('.'); }
      else add('.');
      parts[0].text = parts[0].text.charAt(0).toUpperCase() + parts[0].text.slice(1);
    }
    parts.forEach(p => b.appendChild(p.href ? link(p.href, null, p.text) : document.createTextNode(p.text)));
    if (st.loaded) { b.classList.remove('is-ready'); void b.offsetWidth; b.classList.add('is-ready'); }
  }

  function renderFacts(a) {
    $('fProjects').textContent = a.jobs.length;
    $('fOpen').textContent = a.openTotal;
    $('fOpenBox').classList.toggle('is-hot', a.openTotal > 0);
    $('fSigned').textContent = st.loaded ? a.signedWeek : '–';
    $('fTeam').textContent = st.members.length;
  }

  function renderFlags(a) {
    const ul = $('dbFlags');
    ul.textContent = '';
    if (!a.flags.length) {
      ul.appendChild(el('li', 'db-empty', a.jobs.length ? 'Nothing is stuck. Every project has had activity this week.' : 'Nothing yet. Flags show up here when a project goes quiet or piles up open items.'));
      return;
    }
    a.flags.slice(0, 5).forEach(f => {
      const li = el('li', 'db-flag sev-' + f.sev);
      const aEl = link(f.href || listUrl(f.job.id));
      aEl.append(el('b', null, f.title), el('span', null, f.sub));
      if (f.num != null) { const em = el('em', null, String(f.num)); em.title = 'Open items'; aEl.appendChild(em); }
      li.appendChild(aEl);
      ul.appendChild(li);
    });
    if (a.flags.length > 5) ul.appendChild(el('li', 'db-empty', 'And ' + plural(a.flags.length - 5, 'more') + '. See Projects for the full picture.'));
  }

  function renderNext(a) {
    const ol = $('dbNext');
    ol.textContent = '';
    a.next.forEach((n, i) => {
      const li = el('li');
      const txt = el('div');
      txt.append(el('b', null, n.title), el('span', null, n.sub));
      li.append(txt, link(n.href, 'db-btn' + (i === 0 || n.main ? ' db-btn--main' : ''), n.action));
      ol.appendChild(li);
    });
  }

  function tape(pct, done) {
    const t = el('div', 'db-tape' + (done ? ' is-done' : ''));
    t.setAttribute('role', 'progressbar');
    t.setAttribute('aria-valuemin', '0');
    t.setAttribute('aria-valuemax', '100');
    t.setAttribute('aria-valuenow', String(pct));
    const i = el('i');
    i.style.setProperty('--p', pct);
    t.appendChild(i);
    return t;
  }

  function renderProgress(a) {
    const ul = $('dbProgress');
    ul.textContent = '';
    if (!a.jobs.length) { ul.appendChild(el('li', 'db-empty', 'Your punch lists appear here with how close each one is to done.')); return; }
    a.jobs.slice(0, 6).forEach(x => {
      const li = el('li');
      const aEl = link(projUrl(x.j.id));
      const t = tape(x.pct, x.total > 0 && x.open === 0);
      t.setAttribute('aria-label', jobTitle(x.j) + ' progress');
      aEl.append(el('b', null, jobTitle(x.j)),
        el('span', 'num', x.total ? x.pct + '%' : '—'),
        t,
        el('small', null, (x.total ? (x.open ? plural(x.open, 'open item') + ' of ' + x.total : 'All ' + x.total + ' signed off') : 'No items yet') + (x.j._last ? '. Last activity ' + ago(x.j._last) + '.' : '')));
      li.appendChild(aEl);
      ul.appendChild(li);
    });
  }

  function renderFeed(a) {
    const ul = $('dbFeed');
    ul.textContent = '';
    if (!st.loaded && !a.events.length) { ul.appendChild(el('li', 'db-empty', 'Loading activity…')); return; }
    if (!a.events.length) { ul.appendChild(el('li', 'db-empty', 'Sign-offs, new items and new punch lists show up here as your team works.')); return; }
    let day = '';
    a.events.forEach((e, idx) => {
      const d = dayLabel(e.t);
      if (d !== day) { day = d; ul.appendChild(el('li', 'db-day', d)); }
      const li = el('li', 'db-ev ev-' + e.kind);
      const nextE = a.events[idx + 1];
      if (!nextE || dayLabel(nextE.t) !== d) li.classList.add('is-last');
      const dot = el('span', 'dot');
      dot.innerHTML = e.kind === 'signed' ? ICON.check : e.kind === 'added' ? ICON.plus : ICON.list;
      const body = el('div');
      const p = el('p');
      const jl = link(projUrl(e.job.id), null, shortName(e.job));
      if (e.kind === 'signed') p.append(document.createTextNode(e.who + ' signed off “' + trim(e.what) + '” on '), jl);
      else if (e.kind === 'added') p.append(document.createTextNode('“' + trim(e.what) + '” added to '), jl);
      else p.append(document.createTextNode(e.who + ' started a punch list for '), jl);
      const time = el('time', null, ago(e.t));
      time.dateTime = new Date(e.t).toISOString();
      body.append(p, time);
      li.append(dot, body);
      ul.appendChild(li);
    });
  }
  const trim = s => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 58).trim() + '…' : s; };

  // ---------- Projects ----------
  function renderProjects(a) {
    $('newProject').hidden = !st.canEdit;
    const q = ($('projSearch').value || '').trim().toLowerCase();
    const grid = $('dbProjects');
    grid.textContent = '';
    const shown = a.jobs.filter(x => !q || [jobTitle(x.j), x.j.address, x.j.community, x.j.lot].join(' ').toLowerCase().includes(q));
    if (!shown.length) {
      grid.appendChild(el('p', 'db-empty', a.jobs.length ? 'No projects match “' + q + '”.' : (st.canEdit ? 'No projects yet. Start a punch list to create your first one.' : 'No projects yet.')));
      return;
    }
    shown.forEach(x => {
      const card = link(projUrl(x.j.id), 'db-proj db-glass');
      const stale = x.open > 0 && x.idle >= STALE_DAYS && x.idle !== Infinity;
      const tag = x.total === 0 ? el('span', 'db-tag', 'No items yet')
        : x.open === 0 ? el('span', 'db-tag is-done', 'Signed off')
        : stale ? el('span', 'db-tag is-stale', 'Quiet ' + x.idle + ' days')
        : el('span', 'db-tag is-open', plural(x.open, 'open item'));
      const t = tape(x.pct, x.total > 0 && x.open === 0);
      t.setAttribute('aria-label', 'Progress');
      const stat = el('div', 'stat');
      const left = el('span'); if (x.total) left.append(el('b', null, x.pct + '%'), document.createTextNode(' done')); else left.textContent = 'No items';
      stat.append(left, el('span', null, x.j._last ? 'Updated ' + ago(x.j._last) : ''));
      card.append(tag, el('h3', null, jobTitle(x.j)), el('div', 'where', x.j.address || 'No address yet'), t, stat);
      grid.appendChild(card);
    });
  }
  $('projSearch').addEventListener('input', () => renderProjects(analyze()));

  // One project's page: details, then tabs for Punch list and Daily logs
  function renderDetail(id) {
    const box = $('projDetail');
    box.textContent = '';
    const j = st.jobs.find(x => x.id === id);
    box.appendChild(link('#projects', 'db-back', '‹ All projects'));
    if (!j) { box.appendChild(el('p', 'db-empty', st.loaded ? 'That project was not found. It may have been archived or deleted.' : 'Loading…')); return; }
    const c = counts(j), pct = c.total ? Math.round((c.total - c.open) / c.total * 100) : 0;

    const top = el('div', 'db-detail-top db-glass');
    const head = el('div');
    head.append(el('h2', null, jobTitle(j)), el('p', 'db-sub', j.address || 'No address yet'));
    top.append(head, link(listUrl(j.id), 'db-btn db-btn--main', st.canEdit ? 'Open punch list' : 'View punch list'));
    const t = tape(pct, c.total > 0 && c.open === 0);
    t.setAttribute('aria-label', 'Punch list progress');
    const dl = el('dl', 'db-dl');
    [['Lot', j.lot || '—'], ['Community', j.community || '—'], ['Punch list date', fmtDay(j.date)],
     ['Signed off', c.total ? (c.total - c.open) + ' of ' + c.total + ' (' + pct + '%)' : 'No items yet'],
     ['Last activity', j._last ? ago(j._last) : '—'], ['Started by', memberName(j.ownerId)]]
      .forEach(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.appendChild(d); });
    top.append(t, dl);
    box.appendChild(top);

    // Tabs
    const tabs = el('div', 'db-tabs db-glass');
    tabs.setAttribute('role', 'tablist');
    const panels = el('div');
    const mk = (key, label) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.id = 'tab-' + key;
      b.setAttribute('aria-controls', 'panel-' + key);
      tabs.appendChild(b);
      const p = el('div');
      p.id = 'panel-' + key;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', b.id);
      panels.appendChild(p);
      return [b, p];
    };
    const [tPunch, pPunch] = mk('punch', 'Punch list');
    const [tLogs, pLogs] = mk('logs', 'Daily logs');
    const select = which => {
      [[tPunch, pPunch], [tLogs, pLogs]].forEach(([b, p]) => {
        const on = b === which;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        p.hidden = !on;
      });
    };
    tPunch.addEventListener('click', () => select(tPunch));
    tLogs.addEventListener('click', () => select(tLogs));
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const to = document.activeElement === tPunch ? tLogs : tPunch;
      select(to); to.focus();
    });

    // Punch list tab: items grouped by room, open ones first
    if (!j._items) pPunch.appendChild(el('p', 'db-empty', st.loaded ? 'Couldn’t load this punch list’s items.' : 'Loading items…'));
    else if (!j._items.length) pPunch.appendChild(el('p', 'db-empty', 'No punch items yet. Open the punch list to add rooms and items.'));
    else {
      const rooms = {};
      j._items.forEach(i => { (rooms[i.roomName] = rooms[i.roomName] || []).push(i); });
      const wrap = el('div', 'db-rooms');
      Object.entries(rooms)
        .sort((x, y) => y[1].filter(i => !i.done).length - x[1].filter(i => !i.done).length || x[0].localeCompare(y[0]))
        .forEach(([name, items]) => {
          const open = items.filter(i => !i.done).length;
          const sec = el('section', 'db-room db-glass');
          const h = el('h3', null, name);
          h.appendChild(el('small', null, open ? open + ' open' : 'All signed off'));
          const ul = el('ul', 'db-items');
          items.sort((x, y) => x.done - y.done || x.createdAt - y.createdAt).forEach(i => {
            const li = el('li', i.done ? 'is-done' : '');
            const box = el('span', 'box'); box.setAttribute('aria-hidden', 'true');
            const txt = el('span', null, i.text);
            if (i.done) txt.appendChild(el('span', 'sr-only', ' (signed off' + (i.signedBy ? ' by ' + i.signedBy : '') + ')'));
            li.append(box, txt, el('span', 'trade', i.trade));
            ul.appendChild(li);
          });
          sec.append(h, ul);
          wrap.appendChild(sec);
        });
      pPunch.appendChild(wrap);
    }

    // Daily logs tab: placeholder until the feature is built
    const soon = el('div', 'db-soon db-glass');
    soon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>';
    soon.append(el('span', 'db-pill', 'Coming soon'), el('h3', null, 'Daily logs'),
      el('p', null, 'Record weather, crew on site, deliveries and progress photos for this project each day.'));
    pLogs.appendChild(soon);

    box.append(tabs, panels);
    select(tPunch);
  }

  // ---------- Sections (from the address) ----------
  const VIEWS = ['dashboard', 'projects', 'schedule', 'files', 'selections', 'messages'];
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    // #attention, #next, #progress, #activity are spots on the dashboard
    let [view, sub] = h.split('/');
    if (!VIEWS.includes(view)) { sub = ''; view = 'dashboard'; }
    VIEWS.forEach(v => { $('v-' + v).hidden = v !== view; });
    root.querySelectorAll('.db-nav a').forEach(a => a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    if (view === 'projects') {
      $('projList').hidden = !!sub;
      $('projDetail').hidden = !sub;
      if (sub) renderDetail(sub);
    }
  }
  let lastView = '';
  window.addEventListener('hashchange', () => {
    route();
    const h = location.hash.slice(1);
    const view = h.split('/')[0];
    const target = document.getElementById(h);
    if (target && !VIEWS.includes(view)) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (view !== lastView || h.includes('/')) window.scrollTo(0, 0);
    lastView = view;
  });

  // ---------- Files placeholder ----------
  const drop = $('dbDrop');
  const fileSoon = () => toast('Uploading files is coming soon.');
  $('dbFile').addEventListener('change', e => { if (e.target.files.length) fileSoon(); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', fileSoon);

  // ---------- Start ----------
  route();
  auth.onAuthStateChanged(user => {
    try { user ? localStorage.setItem('int-signed-in', '1') : localStorage.removeItem('int-signed-in'); } catch (e) {}
    if (!user) return; // guests see the marketing page
    load(user).catch(ex => {
      console.error(ex);
      const b = $('dbBrief');
      b.classList.remove('is-loading');
      b.textContent = ex && ex.code === 'permission-denied'
        ? 'Your projects couldn’t load: permission denied. Republish the Firestore rules, then refresh.'
        : 'Your projects couldn’t load. Check your connection and refresh.';
    });
  });
})();