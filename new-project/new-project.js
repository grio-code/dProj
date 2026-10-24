// New project page (new-project.html). Opened from "New Project" in the bottom dock's + menu.
//
// Saves a project. Its punch lists are made afterwards from the project's page, and point back to it with projectId:
//   projects/{id}  ownerId, workspaceId, name, community, lot, address, description, date (project date),
//                  startDate, endDate, phases: [{ name, start, end }], createdAt, updatedAt
//   jobs/{listId}  ... projectId: {id}
// The Firestore rules (firebase-starter/firebase.rules, "projects") let editors create projects.
(() => {
  'use strict';
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const $ = id => document.getElementById(id);

  const STANDARD_PHASES = ['Site prep', 'Foundation', 'Framing', 'Rough-ins', 'Insulation and drywall', 'Finishes', 'Punch and closeout'];
  const MAX_PHASES = 20;
  const st = { uid: '', wid: '', canEdit: false, ready: false };

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  $('npDate').value = ymd(new Date());

  function showMsg(text) {
    const m = $('npMsg');
    m.textContent = text || '';
    m.hidden = !text;
    if (text) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function setErr(id, text, input) {
    $(id).textContent = text || '';
    if (input) text ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
  }

  // ---------- Phases ----------
  function field(cls, label, type, value) {
    const wrap = document.createElement('div');
    wrap.className = 'f ' + cls;
    const id = 'ph' + Math.random().toString(36).slice(2, 8);
    const l = document.createElement('label');
    l.htmlFor = id;
    l.textContent = label;
    const i = document.createElement('input');
    i.id = id;
    i.type = type;
    if (type === 'text') { i.maxLength = 60; i.placeholder = 'Framing'; i.autocomplete = 'off'; }
    i.value = value || '';
    wrap.append(l, i);
    return wrap;
  }
  function addPhase(name, start, end, focus) {
    const list = $('npPhases');
    if (list.children.length >= MAX_PHASES) { setErr('npPhaseErr', 'Up to ' + MAX_PHASES + ' phases.'); return; }
    const li = document.createElement('li');
    li.className = 'np-phase';
    const nameF = field('np-pname', 'Phase', 'text', name);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn--quiet np-rm';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => {
      const next = li.nextElementSibling || li.previousElementSibling;
      li.remove();
      (next ? next.querySelector('input') : $('npAddPhase')).focus();
    });
    li.append(nameF, field('np-pstart', 'Start', 'date', start), field('np-pend', 'End', 'date', end), rm);
    rm.setAttribute('aria-label', 'Remove phase');
    list.appendChild(li);
    if (focus) nameF.querySelector('input').focus();
  }
  $('npAddPhase').addEventListener('click', () => addPhase('', '', '', true));
  $('npStdPhases').addEventListener('click', () => {
    const have = new Set(Array.from(document.querySelectorAll('.np-pname input')).map(i => i.value.trim().toLowerCase()));
    STANDARD_PHASES.filter(p => !have.has(p.toLowerCase())).forEach(p => addPhase(p));
  });
  function readPhases() {
    return Array.from(document.querySelectorAll('.np-phase')).map(li => {
      const [n, s, e] = li.querySelectorAll('input');
      return { name: n.value.trim(), start: s.value, end: e.value, inputs: [n, s, e] };
    }).filter(p => p.name || p.start || p.end);
  }

  // ---------- Save ----------
  $('npForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    if (!st.ready) return showMsg('Still checking your account. Try again in a moment.');
    if (!st.canEdit) return showMsg('Only editors can create projects. Ask a workspace admin for editing access.');

    const name = $('npName').value.trim();
    const start = $('npStart').value, end = $('npEnd').value;
    let bad = null;
    setErr('npNameErr', name ? '' : 'Give the project a name.', $('npName'));
    if (!name) bad = bad || $('npName');
    const endBad = start && end && end < start;
    setErr('npEndErr', endBad ? 'Target completion is before the start date.' : '', $('npEnd'));
    if (endBad) bad = bad || $('npEnd');
    const phases = readPhases();
    setErr('npPhaseErr', '');
    for (const p of phases) {
      p.inputs.forEach(i => i.removeAttribute('aria-invalid'));
      if (!p.name) { p.inputs[0].setAttribute('aria-invalid', 'true'); setErr('npPhaseErr', 'Name each phase, or remove the ones you don’t need.'); bad = bad || p.inputs[0]; break; }
      if (p.start && p.end && p.end < p.start) { p.inputs[2].setAttribute('aria-invalid', 'true'); setErr('npPhaseErr', p.name + ' ends before it starts.'); bad = bad || p.inputs[2]; break; }
    }
    if (bad) { bad.focus(); return; }

    const btn = $('npSave');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    try {
      await db.doc('projects/' + id).set({
        ownerId: st.uid,
        workspaceId: st.wid,
        name,
        community: $('npCommunity').value.trim(),
        lot: $('npLot').value.trim(),
        address: $('npAddress').value.trim(),
        description: $('npDesc').value.trim(),
        date: $('npDate').value || ymd(new Date()),
        startDate: start || '',
        endDate: end || '',
        phases: phases.map(p => ({ name: p.name, start: p.start || '', end: p.end || '' })),
        createdAt: now,
        updatedAt: now
      });
      location.href = 'index.html#projects/' + encodeURIComponent(id);
    } catch (ex) {
      console.error(ex);
      btn.disabled = false;
      btn.textContent = 'Create project';
      showMsg(ex && ex.code === 'permission-denied'
        ? 'Couldn’t create the project: permission denied. Only editors can create projects, and the Firestore rules must be published.'
        : 'Couldn’t create the project. Check your connection and try again.');
    }
  });

  // ---------- Who is signed in, and may they create projects? ----------
  auth.onAuthStateChanged(async user => {
    if (!user) { location.replace('login.html'); return; }
    try {
      const p = await db.doc('users/' + user.uid + '/profile/info').get();
      const prof = p.exists ? p.data() : {};
      if (!prof.workspaceId || !prof.username) { location.replace('signup.html'); return; }
      st.uid = user.uid;
      st.wid = prof.workspaceId;
      const [w, m] = await Promise.all([db.doc('workspaces/' + st.wid).get(), db.doc('workspaces/' + st.wid + '/members/' + user.uid).get()]);
      const me = m.exists ? m.data() : {};
      st.canEdit = (w.exists && w.data().ownerId === user.uid) || me.admin === true || me.canEdit === true;
      st.ready = true;
      if (!st.canEdit) {
        showMsg('Only editors can create projects. Ask a workspace admin for editing access.');
        $('npSave').disabled = true;
      }
    } catch (ex) {
      console.error(ex);
      showMsg('Couldn’t load your workspace. Refresh to try again.');
    }
  });
})();