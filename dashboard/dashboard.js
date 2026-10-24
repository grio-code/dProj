// ©Gianna G. Dimperio 2026

// Workspace dashboard: what index.html shows once someone is signed in.
//
// Projects hold punch lists. A project is made on new-project.html; its punch lists are jobs with projectId set,
// and a project's progress is all of its punch lists added together.
//
// Left column:  the Project picker, "New project", and the section menu.
// Dashboard:    greeting with today's weather, a one-line summary, workspace facts, Needs your attention (coming soon),
//               Recent activity, Up next (every open punch item) and Your projects (progress across each project's lists).
// Projects:     a card per project (index.html#projects, the dock's "My Projects"), punch lists not in a project yet,
//               and one project's page with its details, timeline, punch lists and daily logs.
//
// Firestore data:
//   users/{uid}/profile/info                 name, workspaceId
//   workspaces/{wid}                         name, ownerId
//   workspaces/{wid}/members/{uid}           displayName, email, canEdit, admin
//   projects (workspaceId == wid)            name, community, lot, address, description, date, startDate, endDate, phases, createdAt, updatedAt
//   jobs (workspaceId == wid)                the punch lists: projectId, lot, community, description, openCount, totalCount, createdAt, updatedAt, archived
//   jobs/{id}/custom/{itemId}                text, room, trade, createdAt         (the punch items)
//   jobs/{id}/items/{itemId}                 done, doneAt, signedBy, trade        (their status)
//   jobs/{id}/rooms/{roomId}                 name
//   jobs/{id}/hidden/{roomId}                hidden
// Writes: "Move to project" for a punch list that isn't in a project yet (jobs/{id}.projectId), and "Delete project" (admins only).
// Editing a project happens on new-project.html?edit={id}.
// The sidebar's Project picker focuses the dashboard on one project (st.focus): the facts, summary, Up next, Recent activity and
// Your projects panels then show only that project. "All projects" clears it. The choice is kept for the browser session.
// Weather comes from Open-Meteo (free, no key), using the browser's location.
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
  const NEARLY_DONE = 3;       // this few left = "is N items from done" in the summary
  const MAX_DETAIL_JOBS = 60;  // read items for at most this many punch lists (most recent first)
  const TASKS_SHOWN = 8;       // open items shown in Up next before "Show all"

  const st = {
    user: null, profile: {}, wid: '', ws: {}, members: [], projects: [], jobs: [], loose: [],
    canEdit: false, isAdmin: false, focus: '', loaded: false, allTasks: false, projectsFailed: false
  };

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
  // "2026-10-20" -> a Date at local noon (so time zones don't shift the day)
  const parseDay = s => { const d = s ? new Date(s + (s.length === 10 ? 'T12:00' : '')) : null; return d && !isNaN(d) ? d : null; };
  const fmtDay = s => { const d = parseDay(s); return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; };
  const fmtShort = s => { const d = parseDay(s); return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''; };
  const cut = (s, n) => s.length > n ? s.slice(0, n - 2).trim() + '…' : s;
  // A punch list's title, the same one My Lists shows: "Lot 12 · Oakwood · Final walk"
  function listTitle(j) {
    if (j.name) return j.name;
    const desc = (j.description || '').replace(/\s+/g, ' ').trim();
    return [j.lot && 'Lot ' + j.lot, j.community, desc].filter(Boolean).join(' · ') || 'Untitled punch list';
  }
  function listShort(j) {
    if (j.name) return cut(j.name, 32);
    const desc = (j.description || '').replace(/\s+/g, ' ').trim();
    if (desc) return cut(desc, 32);
    if (j.lot) return 'Lot ' + j.lot;
    return cut(listTitle(j), 28);
  }
  const projName = p => p.name || [p.lot && 'Lot ' + p.lot, p.community].filter(Boolean).join(' · ') || 'Untitled project';
  const projShort = p => cut(projName(p), 32);
  const listUrl = id => 'allLists.html?job=' + encodeURIComponent(id);
  const projUrl = id => '#projects/' + encodeURIComponent(id);
  const projOf = j => j.projectId ? st.projects.find(p => p.id === j.projectId) || null : null;
  function memberName(uid) {
    const m = st.members.find(x => x.id === uid);
    return m ? (m.displayName || m.email || 'Someone') : 'Someone';
  }
  const trim = (s, n = 60) => cut(String(s || '').replace(/\s+/g, ' ').trim(), n);
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
    list: '<svg viewBox="0 0 24 24"><path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>'
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
    st.isAdmin = st.ws.ownerId === user.uid || me.admin === true; // the owner plus anyone made an admin in Settings
    st.canEdit = st.isAdmin || me.canEdit === true;

    const [ps, js] = await Promise.all([
      db.collection('projects').where('workspaceId', '==', st.wid).get().catch(e => { console.error('Projects:', e); st.projectsFailed = true; return { docs: [] }; }),
      db.collection('jobs').where('workspaceId', '==', st.wid).get()
    ]);
    st.projects = ps.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => !x.archived);
    st.jobs = js.docs.map(d => ({ id: d.id, ...d.data() })).filter(j => !j.archived)
      .map(j => Object.assign(j, { _items: null, _last: Math.max(toMs(j.updatedAt), toMs(j.createdAt)) }))
      .sort((a, b) => b._last - a._last);
    link_();
    try { const f = sessionStorage.getItem('int-focus'); if (f && st.projects.some(p => p.id === f)) st.focus = f; } catch (e) {}

    renderHello();
    renderBrand();
    renderAll(); // first pass from the saved counts, so the page fills in fast
    await loadItems(st.jobs.slice(0, MAX_DETAIL_JOBS));
    st.loaded = true;
    link_();
    renderAll();
  }

  // Attach each punch list to its project; lists without a (known) project are "loose"
  function link_() {
    st.projects.forEach(p => { p._lists = []; });
    st.loose = [];
    st.jobs.forEach(j => { const p = projOf(j); p ? p._lists.push(j) : st.loose.push(j); });
    st.projects.forEach(p => { p._last = Math.max(toMs(p.updatedAt), toMs(p.createdAt), ...p._lists.map(j => j._last)); });
    st.projects.sort((a, b) => b._last - a._last);
  }

  // Read each punch list's items, statuses and rooms. One failing list doesn't stop the others.
  async function loadItems(jobs) {
    await Promise.all(jobs.map(async j => {
      try {
        const get = c => db.collection('jobs/' + j.id + '/' + c).get().then(s => Object.fromEntries(s.docs.map(d => [d.id, d.data()])));
        const [custom, items, rooms, hidden] = await Promise.all([get('custom'), get('items'), get('rooms'), get('hidden')]);
        j._items = Object.entries(custom)
          .filter(([, c]) => c && c.text && !(hidden[c.room] && hidden[c.room].hidden))
          .map(([id, c]) => {
            const r = items[id] || {};
            return {
              id, text: c.text, roomName: (rooms[c.room] && rooms[c.room].name) || 'Other',
              trade: r.trade || c.trade || '', done: !!r.done, doneAt: toMs(r.doneAt), signedBy: r.signedBy || '',
              createdAt: toMs(c.createdAt)
            };
          });
        j._items.forEach(it => { j._last = Math.max(j._last, it.doneAt, it.createdAt); });
      } catch (e) { console.error('Could not read punch list ' + j.id, e); }
    }));
  }

  // Open and total items on one punch list: worked out from its items when we have them, otherwise its saved counts
  function listCounts(j) {
    if (j._items) return { open: j._items.filter(i => !i.done).length, total: j._items.length };
    return { open: typeof j.openCount === 'number' ? j.openCount : 0, total: j.totalCount || 0 };
  }
  // A project's progress is every punch list in it added together
  function projCounts(p) {
    const c = (p._lists || []).reduce((s, j) => { const x = listCounts(j); s.open += x.open; s.total += x.total; return s; }, { open: 0, total: 0 });
    c.pct = c.total ? Math.round((c.total - c.open) / c.total * 100) : 0;
    c.lists = (p._lists || []).length;
    return c;
  }

  function analyze() {
    const projects = st.projects.map(p => ({ p, ...projCounts(p) }));
    // With a project picked in the sidebar, everything on the dashboard is about that project only
    const focus = st.focus ? st.projects.find(p => p.id === st.focus) || null : null;
    if (st.focus && !focus && st.loaded) st.focus = ''; // it was deleted
    const jobs = focus ? focus._lists : st.jobs;
    const shown = focus ? projects.filter(x => x.p === focus) : projects;
    const openTotal = jobs.reduce((s, j) => s + listCounts(j).open, 0);
    const weekAgo = Date.now() - 7 * DAY;
    const signedWeek = jobs.reduce((s, j) => s + (j._items || []).filter(i => i.done && i.doneAt >= weekAgo).length, 0);

    // Up next: every open punch item, oldest first (the longest-waiting work comes first)
    const tasks = [];
    jobs.forEach(j => (j._items || []).forEach(i => { if (!i.done) tasks.push({ ...i, job: j }); }));
    tasks.sort((a, b) => (a.createdAt || Infinity) - (b.createdAt || Infinity));

    // Recent activity, newest first
    const events = [];
    jobs.forEach(j => {
      (j._items || []).forEach(i => {
        if (i.done && i.doneAt) events.push({ t: i.doneAt, kind: 'signed', who: i.signedBy || 'Someone', what: i.text, job: j });
        if (i.createdAt) events.push({ t: i.createdAt, kind: 'added', what: i.text, job: j });
      });
      const c = toMs(j.createdAt);
      if (c) events.push({ t: c, kind: 'list', who: memberName(j.ownerId), job: j });
    });
    (focus ? [focus] : st.projects).forEach(p => { const c = toMs(p.createdAt); if (c) events.push({ t: c, kind: 'project', who: memberName(p.ownerId), proj: p }); });
    events.sort((a, b) => b.t - a.t);

    return { projects, shown, focus, jobs, openTotal, signedWeek, tasks, events: events.slice(0, 10) };
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

  // Workspace logo and name at the top of the sidebar (the dashboard has no top bar)
  function renderBrand() {
    const name = st.ws.name || 'Workspace';
    $('dbWsName').textContent = name;
    const box = $('dbWsLogo');
    box.textContent = '';
    if (st.ws.logo) { const img = new Image(); img.alt = ''; img.src = st.ws.logo; box.appendChild(img); }
    else box.textContent = name.trim().charAt(0).toUpperCase();
  }

  function renderAll() {
    const a = analyze();
    // One section failing (say, a panel missing from index.html) must not stop the others, Projects included
    [renderPicker, renderBrief, renderFacts, renderTasks, renderFeed, renderProgress, renderProjects].forEach(fn => {
      try { fn(a); } catch (ex) { console.error(fn.name + ' failed:', ex); }
    });
    route();
  }

  // Project picker: projects only (their punch lists are on each project's page)
  function renderPicker(a) {
    const sel = $('dbJob');
    const keep = st.focus;
    sel.textContent = '';
    sel.appendChild(new Option(a.projects.length ? 'All projects (' + a.projects.length + ')' : 'No projects yet', ''));
    a.projects.forEach(x => sel.appendChild(new Option(projName(x.p) + (x.open ? '  (' + x.open + ' open)' : ''), x.p.id)));
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
    $('dbNewProj').hidden = !st.canEdit;
  }
  // Picking a project focuses the dashboard on it; "All projects" shows everything again
  $('dbJob').addEventListener('change', e => {
    st.focus = e.target.value;
    try { st.focus ? sessionStorage.setItem('int-focus', st.focus) : sessionStorage.removeItem('int-focus'); } catch (ex) {}
    renderAll();
    if (location.hash !== '#dashboard') location.hash = '#dashboard';
  });

  // One sentence: how much is open, and which project is closest to done. Parts that point somewhere are links.
  function renderBrief(a) {
    const b = $('dbBrief');
    b.textContent = '';
    b.classList.remove('is-loading');
    const parts = [];
    const add = (text, href) => parts.push({ text, href });
    if (a.focus) {
      const c = a.shown[0];
      if (!c.lists) add(projName(a.focus) + ' has no punch lists yet.');
      else if (!st.loaded) add('Checking ' + projName(a.focus) + '…');
      else {
        if (a.openTotal) add(plural(a.openTotal, 'item') + (a.openTotal === 1 ? ' is' : ' are') + ' still open on ');
        else add('Every punch item on ');
        add(projName(a.focus), projUrl(a.focus.id));
        add(a.openTotal ? (a.openTotal <= NEARLY_DONE ? ', so it is almost done.' : '.') : ' is signed off.');
      }
    } else if (!a.projects.length && !st.jobs.length) {
      add('Your workspace is ready. ');
      add(st.canEdit ? 'Create your first project.' : 'Projects will show up here once an editor creates one.', st.canEdit ? 'new-project.html' : null);
    } else {
      if (a.openTotal) { add(plural(a.openTotal, 'item'), '#next'); add(a.openTotal === 1 ? ' is still open' : ' are still open'); }
      else add('Every punch item is signed off');
      const close = a.projects.filter(x => x.open > 0 && x.open <= NEARLY_DONE).sort((x, y) => x.open - y.open)[0];
      if (close) { add(', and '); add(projShort(close.p), projUrl(close.p.id)); add(' is ' + plural(close.open, 'item') + ' from done.'); }
      else add('.');
    }
    parts.forEach(p => b.appendChild(p.href ? link(p.href, null, p.text) : document.createTextNode(p.text)));
    if (st.loaded) { b.classList.remove('is-ready'); void b.offsetWidth; b.classList.add('is-ready'); }
  }

  function renderFacts(a) {
    $('fProjects').textContent = a.shown.length;
    $('fOpen').textContent = a.openTotal;
    $('fOpenBox').classList.toggle('is-hot', a.openTotal > 0);
    $('fSigned').textContent = st.loaded ? a.signedWeek : '–';
    $('fTeam').textContent = st.members.length;
  }

  // Where an item lives: room · punch list · project
  function whereOf(t) {
    const p = projOf(t.job);
    return [t.roomName, listShort(t.job), p && projShort(p), t.trade].filter(Boolean).join(' · ');
  }

  // Up next: open punch items, each linking to its punch list
  function renderTasks(a) {
    const ul = $('dbTasks');
    const more = $('dbMoreTasks');
    ul.textContent = '';
    $('nextCount').textContent = a.tasks.length ? plural(a.tasks.length, 'open task') : '';
    more.hidden = true;
    if (!st.loaded) { ul.appendChild(el('li', 'db-empty', 'Loading open tasks…')); return; }
    if (!a.tasks.length) {
      ul.appendChild(el('li', 'db-empty', a.jobs.length ? 'No open tasks. Every punch item is signed off.' : (a.focus ? 'Open punch items show up here once this project has punch lists.' : 'Open punch items show up here once your projects have punch lists.')));
      return;
    }
    const shown = st.allTasks ? a.tasks : a.tasks.slice(0, TASKS_SHOWN);
    shown.forEach(t => {
      const li = el('li');
      const aEl = link(listUrl(t.job.id));
      const box = el('span', 'box'); box.setAttribute('aria-hidden', 'true');
      aEl.append(box, el('b', null, t.text), el('span', 'where', whereOf(t)));
      if (t.createdAt) { const age = el('span', 'age', ago(t.createdAt)); age.title = 'Added ' + new Date(t.createdAt).toLocaleString(); aEl.appendChild(age); }
      li.appendChild(aEl);
      ul.appendChild(li);
    });
    if (a.tasks.length > TASKS_SHOWN) {
      more.hidden = false;
      more.textContent = st.allTasks ? 'Show fewer' : 'Show all ' + a.tasks.length + ' open tasks';
    }
  }
  $('dbMoreTasks').addEventListener('click', () => { st.allTasks = !st.allTasks; renderTasks(analyze()); });

  // A link to where a punch list lives: its project's page, or the list itself when it isn't in a project
  function listLink(j) {
    const p = projOf(j);
    return p ? link(projUrl(p.id), null, projShort(p)) : link(listUrl(j.id), null, listShort(j));
  }

  function renderFeed(a) {
    const ul = $('dbFeed');
    ul.textContent = '';
    if (!st.loaded && !a.events.length) { ul.appendChild(el('li', 'db-empty', 'Loading activity…')); return; }
    if (!a.events.length) { ul.appendChild(el('li', 'db-empty', a.focus ? 'Sign-offs, new items and punch lists for this project show up here as your team works.' : 'Sign-offs, new items, punch lists and projects show up here as your team works.')); return; }
    let day = '';
    a.events.forEach((e, idx) => {
      const d = dayLabel(e.t);
      if (d !== day) { day = d; ul.appendChild(el('li', 'db-day', d)); }
      const li = el('li', 'db-ev ev-' + e.kind);
      const nextE = a.events[idx + 1];
      if (!nextE || dayLabel(nextE.t) !== d) li.classList.add('is-last');
      const dot = el('span', 'dot');
      dot.innerHTML = { signed: ICON.check, added: ICON.plus, list: ICON.list, project: ICON.folder }[e.kind];
      const body = el('div');
      const p = el('p');
      const T = t => document.createTextNode(t);
      if (e.kind === 'signed') p.append(T(e.who + ' signed off “' + trim(e.what) + '” on '), listLink(e.job));
      else if (e.kind === 'added') p.append(T('“' + trim(e.what) + '” added to '), listLink(e.job));
      else if (e.kind === 'list') {
        const pr = projOf(e.job);
        if (pr) p.append(T(e.who + ' added the punch list ' + listShort(e.job) + ' to '), link(projUrl(pr.id), null, projShort(pr)));
        else p.append(T(e.who + ' started the punch list '), link(listUrl(e.job.id), null, listShort(e.job)));
      } else p.append(T(e.who + ' created the project '), link(projUrl(e.proj.id), null, projShort(e.proj)));
      const time = el('time', null, ago(e.t));
      time.dateTime = new Date(e.t).toISOString();
      body.append(p, time);
      li.append(dot, body);
      ul.appendChild(li);
    });
  }

  function tape(pct, done, label) {
    const t = el('div', 'db-tape' + (done ? ' is-done' : ''));
    t.setAttribute('role', 'progressbar');
    t.setAttribute('aria-valuemin', '0');
    t.setAttribute('aria-valuemax', '100');
    t.setAttribute('aria-valuenow', String(pct));
    if (label) t.setAttribute('aria-label', label);
    const i = el('i');
    i.style.setProperty('--p', pct);
    t.appendChild(i);
    return t;
  }
  const progressText = c => !c.lists ? 'No punch lists yet'
    : !c.total ? plural(c.lists, 'punch list') + ', no items yet'
    : (c.open ? plural(c.open, 'open item') + ' of ' + c.total : 'All ' + c.total + ' items signed off') + ' across ' + plural(c.lists, 'punch list');

  // Your projects (dashboard): each project's progress across all of its punch lists
  function renderProgress(a) {
    const ul = $('dbProgress');
    if (!ul) return; // this page has no "Your projects" panel
    ul.textContent = '';
    if (!a.shown.length) {
      ul.appendChild(el('li', 'db-empty', st.projectsFailed ? 'Projects couldn’t load. Republish the Firestore rules, then refresh.' : 'Your projects appear here with how close each one is to done.'));
      return;
    }
    a.shown.slice(0, 6).forEach(x => {
      const li = el('li');
      const aEl = link(projUrl(x.p.id));
      aEl.append(el('b', null, projName(x.p)), el('span', 'num', x.total ? x.pct + '%' : '—'),
        tape(x.pct, x.total > 0 && x.open === 0, projName(x.p) + ' progress'),
        el('small', null, progressText(x) + (x.p._last ? '. Last activity ' + ago(x.p._last) + '.' : '.')));
      li.appendChild(aEl);
      ul.appendChild(li);
    });
  }

  // ---------- Projects (My Projects) ----------
  function renderProjects(a) {
    $('newProject').hidden = !st.canEdit;
    const q = ($('projSearch').value || '').trim().toLowerCase();
    const grid = $('dbProjects');
    grid.textContent = '';
    const match = (...xs) => !q || xs.join(' ').toLowerCase().includes(q);
    const shown = a.projects.filter(x => match(projName(x.p), x.p.address, x.p.community, x.p.lot, ...(x.p._lists || []).map(listTitle)));
    if (st.projectsFailed) grid.appendChild(el('p', 'db-empty', 'Projects couldn’t load: permission denied. Republish the Firestore rules (they now include projects), then refresh.'));
    else if (!shown.length) grid.appendChild(el('p', 'db-empty', a.projects.length ? 'No projects match “' + q + '”.' : (st.canEdit ? 'No projects yet. Use New project to create your first one.' : 'No projects yet.')));
    shown.forEach(x => {
      const card = link(projUrl(x.p.id), 'db-proj db-glass');
      const tag = !x.lists ? el('span', 'db-tag', 'No punch lists yet')
        : x.total === 0 ? el('span', 'db-tag', 'No items yet')
        : x.open === 0 ? el('span', 'db-tag is-done', 'Signed off')
        : el('span', 'db-tag is-open', plural(x.open, 'open item'));
      const stat = el('div', 'stat');
      const left = el('span');
      if (x.total) left.append(el('b', null, x.pct + '%'), document.createTextNode(' done')); else left.textContent = plural(x.lists, 'punch list');
      stat.append(left, el('span', null, x.p._last ? 'Updated ' + ago(x.p._last) : ''));
      const where = [x.p.address, [x.p.lot && 'Lot ' + x.p.lot, x.p.community].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      card.append(tag, el('h3', null, projName(x.p)), el('div', 'where', where || 'No address yet'),
        tape(x.pct, x.total > 0 && x.open === 0, 'Progress'), stat);
      grid.appendChild(card);
    });

    // Punch lists made before projects existed (or whose project was removed): list them so they can be moved into one
    const box = $('dbLoose');
    box.textContent = '';
    const loose = st.loose.filter(j => match(listTitle(j), j.address, j.community, j.lot));
    box.hidden = !loose.length;
    if (!loose.length) return;
    const h = el('div', 'db-panel-h');
    h.append(el('h3', null, 'Punch lists not in a project'));
    box.append(h, el('p', 'db-sub', st.canEdit && a.projects.length ? 'Move each one into its project so its progress counts there.' : 'These punch lists aren’t part of a project yet.'));
    const ul = el('ul', 'db-loose');
    loose.forEach(j => {
      const c = listCounts(j);
      const li = el('li');
      const a1 = link(listUrl(j.id), 'db-loose-name');
      a1.append(el('b', null, listTitle(j)), el('span', null, c.total ? plural(c.open, 'open item') + ' of ' + c.total : 'No items yet'));
      li.appendChild(a1);
      if (st.canEdit && a.projects.length) li.appendChild(moveSelect(j, a.projects));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  $('projSearch').addEventListener('input', () => renderProjects(analyze()));

  function moveSelect(j, projects) {
    const wrap = el('div', 'db-select db-move');
    const sel = el('select');
    sel.setAttribute('aria-label', 'Move ' + listTitle(j) + ' to a project');
    sel.appendChild(new Option('Move to project…', ''));
    projects.forEach(x => sel.appendChild(new Option(projName(x.p), x.p.id)));
    sel.addEventListener('change', async () => {
      const pid = sel.value;
      if (!pid) return;
      sel.disabled = true;
      try {
        await db.doc('jobs/' + j.id).set({ projectId: pid, updatedAt: new Date().toISOString() }, { merge: true });
        j.projectId = pid;
        link_();
        renderAll();
        toast(listTitle(j) + ' moved to ' + projName(projOf(j)) + '.');
      } catch (ex) {
        console.error(ex);
        sel.value = '';
        sel.disabled = false;
        toast(ex && ex.code === 'permission-denied' ? 'Only editors can move punch lists.' : 'Couldn’t move it. Check your connection.');
      }
    });
    wrap.appendChild(sel);
    return wrap;
  }

  // Delete a project (admins only; the Firestore rules enforce it too).
  // Its punch lists are kept: they lose their project and show up under "Punch lists not in a project".
  async function deleteProject(p, btn) {
    if (!st.isAdmin) { toast('Only workspace admins can delete projects.'); return; }
    const n = (p._lists || []).length;
    const msg = 'Delete “' + projName(p) + '”?\n\n'
      + (n ? 'Its ' + plural(n, 'punch list') + ' will not be deleted. ' + (n === 1 ? 'It' : 'They') + ' will move to “Punch lists not in a project”.\n\n' : '')
      + 'This can’t be undone.';
    if (!confirm(msg)) return;
    btn.disabled = true;
    try {
      await db.doc('projects/' + p.id).delete();
      st.projects = st.projects.filter(x => x.id !== p.id);
      if (st.focus === p.id) { st.focus = ''; try { sessionStorage.removeItem('int-focus'); } catch (e) {} }
      st.jobs.forEach(j => { if (j.projectId === p.id) j.projectId = ''; }); // local view only; the lists keep a dead link until moved
      link_();
      location.hash = '#projects';
      renderAll();
      toast('Deleted “' + projName(p) + '”.');
    } catch (ex) {
      console.error(ex);
      btn.disabled = false;
      toast(ex && ex.code === 'permission-denied' ? 'Only workspace admins can delete projects. Make sure the Firestore rules are republished.' : 'Couldn’t delete the project. Check your connection.');
    }
  }

  // Timeline: start and target dates, and each phase marked done / in progress / upcoming
  function timelineBox(p) {
    const phases = Array.isArray(p.phases) ? p.phases.filter(x => x && x.name) : [];
    if (!p.startDate && !p.endDate && !phases.length) return null;
    const box = el('section', 'db-timeline db-glass');
    box.appendChild(el('h3', null, 'Timeline'));
    const dl = el('dl', 'db-dl');
    dl.style.margin = '0 0 ' + (phases.length ? '14px' : '0');
    let remain = '';
    const end = parseDay(p.endDate);
    if (end) {
      const days = Math.ceil((end - new Date()) / DAY);
      remain = days > 0 ? plural(days, 'day') + ' left' : days === 0 ? 'Due today' : plural(-days, 'day') + ' past target';
    }
    [['Start', fmtDay(p.startDate)], ['Target completion', fmtDay(p.endDate)], ['Time left', remain || '—']]
      .forEach(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.appendChild(d); });
    box.appendChild(dl);
    if (phases.length) {
      const ol = el('ol', 'db-phases');
      const today = new Date();
      phases.forEach(ph => {
        const s = parseDay(ph.start), e = parseDay(ph.end);
        const li = el('li');
        let state = '';
        if (e && e < today) li.classList.add('is-past');
        else if (s && s <= today && (!e || e >= today)) { li.classList.add('is-now'); state = 'In progress'; }
        const dates = [fmtShort(ph.start), fmtShort(ph.end)].filter(Boolean).join(' – ');
        li.append(el('b', null, ph.name), el('span', null, dates || 'No dates'));
        if (state) li.appendChild(el('em', null, state));
        ol.appendChild(li);
      });
      box.appendChild(ol);
    }
    return box;
  }

  // One project's page: details and overall progress, timeline, then tabs for Punch lists and Daily logs
  function renderDetail(id) {
    const box = $('projDetail');
    box.textContent = '';
    const p = st.projects.find(x => x.id === id);
    box.appendChild(link('#projects', 'db-back', '‹ My projects'));
    if (!p) { box.appendChild(el('p', 'db-empty', st.loaded ? 'That project was not found. It may have been deleted.' : 'Loading…')); return; }
    const c = projCounts(p);
    const newList = 'allLists.html?new=1&project=' + encodeURIComponent(p.id);

    const top = el('div', 'db-detail-top db-glass');
    const head = el('div');
    head.append(el('h2', null, projName(p)), el('p', 'db-sub', p.address || 'No address yet'));
    top.appendChild(head);
    const actions = el('div', 'db-detail-actions');
    if (st.canEdit) {
      actions.appendChild(link(newList, 'db-btn db-btn--main', 'New punch list'));
      actions.appendChild(link('new-project.html?edit=' + encodeURIComponent(p.id), 'db-btn', 'Edit project'));
    }
    if (st.isAdmin) {
      const del = el('button', 'db-btn db-btn--danger', 'Delete project');
      del.type = 'button';
      del.addEventListener('click', () => deleteProject(p, del));
      actions.appendChild(del);
    }
    if (actions.children.length) top.appendChild(actions);
    const dl = el('dl', 'db-dl');
    [['Lot', p.lot || '—'], ['Community', p.community || '—'], ['Project date', fmtDay(p.date)],
     ['Progress', c.total ? (c.total - c.open) + ' of ' + c.total + ' items (' + c.pct + '%)' : '—'],
     ['Punch lists', String(c.lists)], ['Created by', memberName(p.ownerId)]]
      .forEach(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.appendChild(d); });
    top.append(tape(c.pct, c.total > 0 && c.open === 0, 'Project progress across all punch lists'), dl);
    if (p.description) { const n = el('p', 'db-sub', p.description); n.style.gridColumn = '1 / -1'; top.appendChild(n); }
    box.appendChild(top);
    const tl = timelineBox(p);
    if (tl) box.appendChild(tl);

    // Tabs
    const tabs = el('div', 'db-tabs db-glass');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Project sections');
    const panels = el('div');
    const mk = (key, label) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.id = 'tab-' + key;
      b.setAttribute('aria-controls', 'panel-' + key);
      tabs.appendChild(b);
      const pn = el('div');
      pn.id = 'panel-' + key;
      pn.setAttribute('role', 'tabpanel');
      pn.setAttribute('aria-labelledby', b.id);
      panels.appendChild(pn);
      return [b, pn];
    };
    const [tLists, pLists] = mk('lists', 'Punch lists (' + c.lists + ')');
    const [tLogs, pLogs] = mk('logs', 'Daily logs');
    const select = which => {
      [[tLists, pLists], [tLogs, pLogs]].forEach(([b, pn]) => {
        const on = b === which;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        pn.hidden = !on;
      });
    };
    tLists.addEventListener('click', () => select(tLists));
    tLogs.addEventListener('click', () => select(tLogs));
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const to = document.activeElement === tLists ? tLogs : tLists;
      select(to); to.focus();
    });

    // Punch lists tab: each list with its own progress; open ones first
    if (!p._lists.length) {
      const empty = el('div', 'db-soon db-glass');
      empty.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON.list.replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</svg>';
      empty.append(el('h3', null, 'No punch lists yet'),
        el('p', null, st.canEdit ? 'Add a punch list for each walk: pre-drywall, final, buyer orientation. Their progress adds up here.' : 'Punch lists for this project show up here once an editor adds them.'));
      if (st.canEdit) empty.appendChild(link(newList, 'db-btn db-btn--main', 'New punch list'));
      pLists.appendChild(empty);
    } else {
      const ul = el('ul', 'db-lists');
      p._lists.map(j => ({ j, ...listCounts(j) }))
        .sort((x, y) => (y.open > 0) - (x.open > 0) || y.j._last - x.j._last)
        .forEach(x => {
          const pct = x.total ? Math.round((x.total - x.open) / x.total * 100) : 0;
          const li = el('li');
          const aEl = link(listUrl(x.j.id), 'db-glass');
          aEl.append(el('b', null, listTitle(x.j)), el('span', 'num', x.total ? pct + '%' : '—'),
            tape(pct, x.total > 0 && x.open === 0, listTitle(x.j) + ' progress'),
            el('small', null, (x.total ? (x.open ? plural(x.open, 'open item') + ' of ' + x.total : 'All ' + x.total + ' signed off') : 'No items yet')
              + (x.j._last ? '. Last activity ' + ago(x.j._last) + '.' : '.')));
          li.appendChild(aEl);
          ul.appendChild(li);
        });
      pLists.appendChild(ul);
    }

    // Daily logs tab: placeholder until the feature is built
    const soon = el('div', 'db-soon db-glass');
    soon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>';
    soon.append(el('span', 'db-pill', 'Coming soon'), el('h3', null, 'Daily logs'),
      el('p', null, 'Record weather, crew on site, deliveries and progress photos for this project each day.'));
    pLogs.appendChild(soon);

    box.append(tabs, panels);
    select(tLists);
  }

  // ---------- Sections (from the address) ----------
  const VIEWS = ['dashboard', 'projects', 'schedule', 'files', 'selections', 'messages'];
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    let [view, sub] = h.split('/');
    if (!VIEWS.includes(view)) { sub = ''; view = 'dashboard'; } // #next, #activity... are spots on the dashboard
    VIEWS.forEach(v => { $('v-' + v).hidden = v !== view; });
    root.querySelectorAll('.db-nav a').forEach(a => a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    const sel = $('dbJob');
    sel.value = st.focus;
    if (sel.value !== st.focus) sel.value = '';
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

  // ---------- Weather: today's forecast next to the greeting ----------
  // Uses the browser's location (asked once, with a button) and Open-Meteo. The last place is remembered on this device.
  const WX_LOC = 'int-wx-loc', WX_CACHE = 'int-wx';
  const useF = /^en-(US|LR|MM)|^(my|lr)/i.test(navigator.language || 'en-US'); // Fahrenheit for US English
  function wxDesc(code) {
    if (code === 0) return ['Clear', 'sun'];
    if (code === 1) return ['Mostly clear', 'sun'];
    if (code === 2) return ['Partly cloudy', 'partly'];
    if (code === 3) return ['Cloudy', 'cloud'];
    if (code === 45 || code === 48) return ['Foggy', 'cloud'];
    if (code >= 51 && code <= 57) return ['Drizzle', 'rain'];
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return ['Rain', 'rain'];
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['Snow', 'snow'];
    if (code >= 95) return ['Thunderstorms', 'storm'];
    return ['', 'cloud'];
  }
  const WX_ICON = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>',
    partly: '<path d="M8.5 4.5v1.4M3.4 9.6h1.4M4.9 6l1 1M12.1 6l-1 1"/><path d="M5.6 12.4a3.6 3.6 0 1 1 6.3-3.3"/><path d="M8 19.5h9.2a3.3 3.3 0 0 0 .3-6.6 4.7 4.7 0 0 0-9-.5A3.6 3.6 0 0 0 8 19.5z"/>',
    cloud: '<path d="M7 18.5h10.5a3.8 3.8 0 0 0 .3-7.6 5.4 5.4 0 0 0-10.4-.6A4.1 4.1 0 0 0 7 18.5z"/>',
    rain: '<path d="M7 15.5h10.5a3.8 3.8 0 0 0 .3-7.6 5.4 5.4 0 0 0-10.4-.6A4.1 4.1 0 0 0 7 15.5z"/><path d="M8.5 18.5l-1 2M12.5 18.5l-1 2M16.5 18.5l-1 2"/>',
    snow: '<path d="M7 15.5h10.5a3.8 3.8 0 0 0 .3-7.6 5.4 5.4 0 0 0-10.4-.6A4.1 4.1 0 0 0 7 15.5z"/><path d="M8.5 19.5h.01M12 20.5h.01M15.5 19.5h.01"/>',
    storm: '<path d="M7 15h10.5a3.8 3.8 0 0 0 .3-7.6 5.4 5.4 0 0 0-10.4-.6A4.1 4.1 0 0 0 7 15z"/><path d="M12.5 15l-2 3.5h3l-2 3.5"/>'
  };
  function showWeather(w) {
    const box = $('dbWeather');
    box.textContent = '';
    const [desc, icon] = wxDesc(w.code);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = WX_ICON[icon];
    const deg = n => Math.round(n) + '°';
    const text = el('span', 'wx-text');
    text.append(el('span', null, (desc || 'Today') + (w.rain != null ? ', ' + w.rain + '% chance of rain' : '')),
      el('span', null, 'High ' + deg(w.hi) + ', low ' + deg(w.lo)));
    box.append(svg, el('b', null, deg(w.now)), text);
    box.setAttribute('aria-label', 'Weather today: ' + deg(w.now) + ' now, ' + (desc || '').toLowerCase() + '. High ' + deg(w.hi) + ', low ' + deg(w.lo) + (w.rain != null ? ', ' + w.rain + ' percent chance of rain' : '') + '.');
  }
  async function fetchWeather(lat, lon) {
    try { const c = JSON.parse(sessionStorage.getItem(WX_CACHE) || 'null'); if (c && Date.now() - c.at < 30 * 6e4 && Math.abs(c.lat - lat) < .05 && Math.abs(c.lon - lon) < .05) return showWeather(c.w); } catch (e) {}
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3)
      + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=1' + (useF ? '&temperature_unit=fahrenheit' : '');
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('weather ' + r.status);
      const d = await r.json();
      const w = {
        now: d.current.temperature_2m, code: d.current.weather_code,
        hi: d.daily.temperature_2m_max[0], lo: d.daily.temperature_2m_min[0],
        rain: d.daily.precipitation_probability_max ? d.daily.precipitation_probability_max[0] : null
      };
      try { sessionStorage.setItem(WX_CACHE, JSON.stringify({ at: Date.now(), lat, lon, w })); } catch (e) {}
      showWeather(w);
    } catch (e) { console.warn('Weather unavailable', e); $('dbWeather').textContent = ''; }
  }
  function askLocation() {
    const box = $('dbWeather');
    if (!navigator.geolocation) { box.textContent = ''; return; }
    box.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try { localStorage.setItem(WX_LOC, JSON.stringify({ lat, lon })); } catch (e) {}
      fetchWeather(lat, lon);
    }, () => {
      box.textContent = '';
      box.appendChild(el('span', null, 'Allow location in your browser to see today’s weather.'));
    }, { maximumAge: 30 * 6e4, timeout: 10000 });
  }
  function weatherButton() {
    const box = $('dbWeather');
    box.textContent = '';
    const b = el('button', 'db-btn', 'Show today’s weather');
    b.type = 'button';
    b.addEventListener('click', askLocation);
    box.appendChild(b);
  }
  async function startWeather() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(WX_LOC) || 'null'); } catch (e) {}
    let state = '';
    try { if (navigator.permissions) state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (e) {}
    if (state === 'granted') askLocation();                // refresh the location quietly
    else if (saved) fetchWeather(saved.lat, saved.lon);    // last place we knew
    else if (state !== 'denied') weatherButton();          // ask only when they choose to
  }

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
    startWeather();
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