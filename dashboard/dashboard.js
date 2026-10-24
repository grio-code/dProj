// Workspace dashboard: what index.html shows once someone is signed in.
//
// Left column:  the Job picker (every project in the workspace), "New project", and the section menu.
// Dashboard:    greeting with today's weather, a one-line summary, workspace facts,
//               Needs your attention (coming soon), Recent activity, and Up next (every open punch item).
// Projects:     a card per project, and one project's page with its details, timeline, punch list and daily logs.
//
// Reads the same Firestore data as My Lists (all-lists/allLists.js):
//   users/{uid}/profile/info                 name, workspaceId
//   workspaces/{wid}                         name, ownerId
//   workspaces/{wid}/members/{uid}           displayName, email, canEdit, admin
//   jobs (workspaceId == wid)                name, lot, community, address, description, date, startDate, endDate, phases,
//                                            openCount, totalCount, createdAt, updatedAt, archived
//   jobs/{id}/custom/{itemId}                text, room, trade, createdAt         (the punch items)
//   jobs/{id}/items/{itemId}                 done, doneAt, signedBy, trade        (their status)
//   jobs/{id}/rooms/{roomId}                 name
//   jobs/{id}/hidden/{roomId}                hidden
// Nothing here writes to Firestore. Weather comes from Open-Meteo (free, no key), using the browser's location.
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
  const MAX_DETAIL_JOBS = 40;  // read items for at most this many projects (most recent first)
  const TASKS_SHOWN = 8;       // open items shown in Up next before "Show all"

  const st = { user: null, profile: {}, wid: '', ws: {}, members: [], jobs: [], canEdit: false, loaded: false, allTasks: false };

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
  // Project name from New Project, otherwise the title My Lists uses: "Lot 12 · Oakwood · Final walk"
  function jobTitle(j) {
    if (j.name) return j.name;
    const desc = (j.description || '').replace(/\s+/g, ' ').trim();
    return [j.lot && 'Lot ' + j.lot, j.community, desc].filter(Boolean).join(' · ') || 'Untitled punch list';
  }
  // A short name for sentences
  function shortName(j) {
    if (j.name) return j.name.length > 32 ? j.name.slice(0, 30).trim() + '…' : j.name;
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
  const trim = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 2).trim() + '…' : s; };
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
    st.canEdit = st.ws.ownerId === user.uid || me.admin === true || me.canEdit === true;

    const js = await db.collection('jobs').where('workspaceId', '==', st.wid).get();
    st.jobs = js.docs.map(d => ({ id: d.id, ...d.data() })).filter(j => !j.archived)
      .map(j => Object.assign(j, { _items: null, _last: Math.max(toMs(j.updatedAt), toMs(j.createdAt)) }))
      .sort((a, b) => b._last - a._last);

    renderHello();
    renderAll(); // first pass from the project records alone, so the page fills in fast
    await loadItems(st.jobs.slice(0, MAX_DETAIL_JOBS));
    st.loaded = true;
    renderAll();
  }

  // Read each project's items, statuses and rooms. One failing project doesn't stop the others.
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
      } catch (e) { console.error('Could not read project ' + j.id, e); }
    }));
  }

  // Open and total counts: worked out from the items when we have them, otherwise the counts saved on the project
  function counts(j) {
    if (j._items) return { open: j._items.filter(i => !i.done).length, total: j._items.length };
    return { open: typeof j.openCount === 'number' ? j.openCount : 0, total: j.totalCount || 0 };
  }

  function analyze() {
    const jobs = st.jobs.map(j => { const c = counts(j); return { j, ...c, pct: c.total ? Math.round((c.total - c.open) / c.total * 100) : 0 }; });
    const openTotal = jobs.reduce((s, x) => s + x.open, 0);
    const weekAgo = Date.now() - 7 * DAY;
    const signedWeek = st.jobs.reduce((s, j) => s + (j._items || []).filter(i => i.done && i.doneAt >= weekAgo).length, 0);

    // Up next: every open punch item, oldest first (the longest-waiting work comes first)
    const tasks = [];
    st.jobs.forEach(j => (j._items || []).forEach(i => { if (!i.done) tasks.push({ ...i, job: j }); }));
    tasks.sort((a, b) => (a.createdAt || Infinity) - (b.createdAt || Infinity));

    // Recent activity, newest first
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

    return { jobs, openTotal, signedWeek, tasks, events: events.slice(0, 10) };
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
    renderJobPicker(a);
    renderBrief(a);
    renderFacts(a);
    renderTasks(a);
    renderFeed(a);
    renderProjects(a);
    route();
  }

  // Job picker: every project, newest activity first
  function renderJobPicker(a) {
    const sel = $('dbJob');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(new Option(a.jobs.length ? 'All jobs (' + a.jobs.length + ')' : 'No jobs yet', ''));
    a.jobs.forEach(x => sel.appendChild(new Option(jobTitle(x.j) + (x.open ? '  (' + x.open + ' open)' : ''), x.j.id)));
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
    $('dbNewProj').hidden = !st.canEdit;
  }
  $('dbJob').addEventListener('change', e => { location.hash = e.target.value ? 'projects/' + encodeURIComponent(e.target.value) : 'dashboard'; });

  // One sentence: how much is open, and what's closest to done. Parts that point somewhere are links.
  function renderBrief(a) {
    const b = $('dbBrief');
    b.textContent = '';
    b.classList.remove('is-loading');
    const parts = [];
    const add = (text, href) => parts.push({ text, href });
    if (!a.jobs.length) {
      add('Your workspace is ready. ');
      add(st.canEdit ? 'Create your first project.' : 'Projects will show up here once an editor creates one.', st.canEdit ? 'newProject.html' : null);
    } else {
      if (a.openTotal) { add(plural(a.openTotal, 'item'), '#next'); add(a.openTotal === 1 ? ' is still open' : ' are still open'); }
      else add('Every punch item is signed off');
      const close = a.jobs.filter(x => x.open > 0 && x.open <= NEARLY_DONE && x.total > 0).sort((x, y) => x.open - y.open)[0];
      if (close) { add(', and '); add(shortName(close.j), listUrl(close.j.id)); add(' is ' + plural(close.open, 'item') + ' from done.'); }
      else add('.');
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

  // Up next: open punch items, each linking to its punch list
  function renderTasks(a) {
    const ul = $('dbTasks');
    const more = $('dbMoreTasks');
    ul.textContent = '';
    $('nextCount').textContent = a.tasks.length ? plural(a.tasks.length, 'open task') : '';
    more.hidden = true;
    if (!st.loaded) { ul.appendChild(el('li', 'db-empty', 'Loading open tasks…')); return; }
    if (!a.tasks.length) {
      ul.appendChild(el('li', 'db-empty', a.jobs.length ? 'No open tasks. Every punch item is signed off.' : 'Open punch items show up here once your projects have them.'));
      return;
    }
    const shown = st.allTasks ? a.tasks : a.tasks.slice(0, TASKS_SHOWN);
    shown.forEach(t => {
      const li = el('li');
      const aEl = link(listUrl(t.job.id));
      const box = el('span', 'box'); box.setAttribute('aria-hidden', 'true');
      aEl.append(box, el('b', null, t.text), el('span', 'where', [t.roomName, shortName(t.job), t.trade].filter(Boolean).join(' · ')));
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

  function renderFeed(a) {
    const ul = $('dbFeed');
    ul.textContent = '';
    if (!st.loaded && !a.events.length) { ul.appendChild(el('li', 'db-empty', 'Loading activity…')); return; }
    if (!a.events.length) { ul.appendChild(el('li', 'db-empty', 'Sign-offs, new items and new projects show up here as your team works.')); return; }
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
      else p.append(document.createTextNode(e.who + ' created '), jl);
      const time = el('time', null, ago(e.t));
      time.dateTime = new Date(e.t).toISOString();
      body.append(p, time);
      li.append(dot, body);
      ul.appendChild(li);
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

  // ---------- Projects ----------
  function renderProjects(a) {
    $('newProject').hidden = !st.canEdit;
    const q = ($('projSearch').value || '').trim().toLowerCase();
    const grid = $('dbProjects');
    grid.textContent = '';
    const shown = a.jobs.filter(x => !q || [jobTitle(x.j), x.j.address, x.j.community, x.j.lot].join(' ').toLowerCase().includes(q));
    if (!shown.length) {
      grid.appendChild(el('p', 'db-empty', a.jobs.length ? 'No projects match “' + q + '”.' : (st.canEdit ? 'No projects yet. Use New project to create your first one.' : 'No projects yet.')));
      return;
    }
    shown.forEach(x => {
      const card = link(projUrl(x.j.id), 'db-proj db-glass');
      const tag = x.total === 0 ? el('span', 'db-tag', 'No items yet')
        : x.open === 0 ? el('span', 'db-tag is-done', 'Signed off')
        : el('span', 'db-tag is-open', plural(x.open, 'open item'));
      const t = tape(x.pct, x.total > 0 && x.open === 0);
      t.setAttribute('aria-label', 'Progress');
      const stat = el('div', 'stat');
      const left = el('span');
      if (x.total) left.append(el('b', null, x.pct + '%'), document.createTextNode(' done')); else left.textContent = 'No items';
      stat.append(left, el('span', null, x.j._last ? 'Updated ' + ago(x.j._last) : ''));
      const where = [x.j.address, x.j.name && [x.j.lot && 'Lot ' + x.j.lot, x.j.community].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      card.append(tag, el('h3', null, jobTitle(x.j)), el('div', 'where', where || 'No address yet'), t, stat);
      grid.appendChild(card);
    });
  }
  $('projSearch').addEventListener('input', () => renderProjects(analyze()));

  // Timeline: start and target dates, and each phase marked done / in progress / upcoming
  function timelineBox(j) {
    const phases = Array.isArray(j.phases) ? j.phases.filter(p => p && p.name) : [];
    if (!j.startDate && !j.endDate && !phases.length) return null;
    const box = el('section', 'db-timeline db-glass');
    box.appendChild(el('h3', null, 'Timeline'));
    const dl = el('dl', 'db-dl');
    dl.style.margin = '0 0 ' + (phases.length ? '14px' : '0');
    let remain = '';
    const end = parseDay(j.endDate);
    if (end) {
      const days = Math.ceil((end - new Date()) / DAY);
      remain = days > 0 ? plural(days, 'day') + ' left' : days === 0 ? 'Due today' : plural(-days, 'day') + ' past target';
    }
    [['Start', fmtDay(j.startDate)], ['Target completion', fmtDay(j.endDate)], ['Time left', remain || '—']]
      .forEach(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.appendChild(d); });
    box.appendChild(dl);
    if (phases.length) {
      const ul = el('ol', 'db-phases');
      const today = new Date();
      phases.forEach(p => {
        const s = parseDay(p.start), e = parseDay(p.end);
        const li = el('li');
        let state = '';
        if (e && e < today) { li.classList.add('is-past'); state = ''; }
        else if (s && s <= today && (!e || e >= today)) { li.classList.add('is-now'); state = 'In progress'; }
        const dates = [fmtShort(p.start), fmtShort(p.end)].filter(Boolean).join(' – ');
        li.append(el('b', null, p.name), el('span', null, dates || 'No dates'));
        if (state) li.appendChild(el('em', null, state));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    return box;
  }

  // One project's page: details, timeline, then tabs for Punch list and Daily logs
  function renderDetail(id) {
    const box = $('projDetail');
    box.textContent = '';
    const j = st.jobs.find(x => x.id === id);
    box.appendChild(link('#projects', 'db-back', '‹ All projects'));
    if (!j) { box.appendChild(el('p', 'db-empty', st.jobs.length || st.loaded ? 'That project was not found. It may have been archived or deleted.' : 'Loading…')); return; }
    const c = counts(j), pct = c.total ? Math.round((c.total - c.open) / c.total * 100) : 0;

    const top = el('div', 'db-detail-top db-glass');
    const head = el('div');
    head.append(el('h2', null, jobTitle(j)), el('p', 'db-sub', j.address || 'No address yet'));
    top.append(head, link(listUrl(j.id), 'db-btn db-btn--main', st.canEdit ? 'Open punch list' : 'View punch list'));
    const t = tape(pct, c.total > 0 && c.open === 0);
    t.setAttribute('aria-label', 'Punch list progress');
    const dl = el('dl', 'db-dl');
    [['Lot', j.lot || '—'], ['Community', j.community || '—'], ['Project date', fmtDay(j.date)],
     ['Signed off', c.total ? (c.total - c.open) + ' of ' + c.total + ' (' + pct + '%)' : 'No items yet'],
     ['Last activity', j._last ? ago(j._last) : '—'], ['Created by', memberName(j.ownerId)]]
      .forEach(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.appendChild(d); });
    top.append(t, dl);
    if (j.name && j.description) { const n = el('p', 'db-sub', j.description); n.style.gridColumn = '1 / -1'; top.appendChild(n); }
    box.appendChild(top);
    const tl = timelineBox(j);
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

    // Punch list tab: items grouped by room, rooms with the most open items first
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
            const bx = el('span', 'box'); bx.setAttribute('aria-hidden', 'true');
            const txt = el('span', null, i.text);
            if (i.done) txt.appendChild(el('span', 'sr-only', ' (signed off' + (i.signedBy ? ' by ' + i.signedBy : '') + ')'));
            li.append(bx, txt, el('span', 'trade', i.trade));
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
    let [view, sub] = h.split('/');
    if (!VIEWS.includes(view)) { sub = ''; view = 'dashboard'; } // #next, #activity... are spots on the dashboard
    VIEWS.forEach(v => { $('v-' + v).hidden = v !== view; });
    root.querySelectorAll('.db-nav a').forEach(a => a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    const sel = $('dbJob');
    sel.value = view === 'projects' && sub ? sub : '';
    if (sel.value !== (view === 'projects' && sub ? sub : '')) sel.value = '';
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