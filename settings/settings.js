// Settings page: your profile, the workspace, its members, and (for the owner) admin controls.
//
// Reads / writes the same Firestore data the sign-up wizard creates:
//   users/{uid}/profile/info            name, username, logo (profile photo), workspaceId
//   workspaces/{wid}                    name, ownerId, createdAt, logo (company logo, added here)
//   workspaces/{wid}/members/{uid}      role, displayName, username, email, photo, joinedAt
//   workspaces/{wid}/invites/{email}    pending invitations
(() => {
  'use strict';
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();
  const $ = id => document.getElementById(id);

  const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
  const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // no SVG: it can carry scripts
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_INVITES = 25;
  const SIGNUP_URL = new URL('signup.html', location.href).href.split('?')[0];

  const st = { user: null, profile: {}, wid: '', ws: {}, members: [], invites: [], isOwner: false };
  const pending = { userPhoto: undefined, wsLogo: undefined }; // undefined = unchanged, '' = removed, data URL = new

  // ---------- Helpers ----------
  function showMsg(text, isError = false) {
    const m = $('msg');
    m.textContent = text || '';
    m.hidden = !text;
    m.classList.toggle('is-error', !!isError);
    if (text && !isError) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 4000);
  }
  function setErr(id, text) {
    $(id).textContent = text || '';
    const input = $(id).parentElement.querySelector('input:not([type=file]), textarea');
    if (input) text ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
  }
  async function busy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }
  function friendly(ex, fallback) {
    console.error(ex);
    return ({
      'permission-denied': 'You don’t have permission to do that. If this keeps happening, the Firestore rules may need to be republished.',
      'auth/too-many-requests': 'Too many attempts. Try again in a bit.',
      'auth/network-request-failed': 'Network problem. Check your connection and try again.',
      'unavailable': 'Network problem. Check your connection and try again.'
    })[ex && ex.code] || fallback;
  }
  function fmtDate(ts) {
    const d = ts && ts.toDate ? ts.toDate() : null;
    return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  }
  // Fill a .st-pic box with an image, or with a letter when there is none
  function setPic(el, src, letter) {
    el.textContent = '';
    el.classList.toggle('is-letter', !src);
    if (src) { const img = new Image(); img.alt = ''; img.src = src; el.appendChild(img); }
    else el.textContent = (letter || '?').trim().charAt(0).toUpperCase();
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Read an image file into a small data URL that fits in a Firestore document (1 MB limit).
  // Photos are cropped to a square; logos are fit inside the square so wide logos aren't cut off.
  async function readImage(file, mode) {
    if (!PHOTO_TYPES.includes(file.type)) throw new Error('Use a PNG, JPG or WebP image.');
    if (file.size > MAX_PHOTO_BYTES) throw new Error('That image is over 2 MB. Choose a smaller one.');
    const bmp = await createImageBitmap(file);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (mode === 'cover') {
      const s = Math.min(bmp.width, bmp.height);
      g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    } else {
      const k = Math.min(size / bmp.width, size / bmp.height);
      const w = bmp.width * k, h = bmp.height * k;
      g.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
    }
    return c.toDataURL('image/webp', 0.85);
  }

  // ---------- Load everything ----------
  async function load(user) {
    st.user = user;
    const p = await db.doc('users/' + user.uid + '/profile/info').get();
    st.profile = p.exists ? p.data() : {};
    st.wid = st.profile.workspaceId || '';
    if (!st.wid || !st.profile.username) { location.replace('signup.html'); return; } // setup not finished

    const w = await db.doc('workspaces/' + st.wid).get();
    if (!w.exists) { showMsg('Your workspace couldn’t be found.', true); return; }
    st.ws = w.data();
    st.isOwner = st.ws.ownerId === user.uid;
    document.documentElement.classList.toggle('is-owner', st.isOwner);

    await loadPeople();
    renderAll();
    $('stLayout').hidden = false;
    // Jump to the section in the address (#user, #workspace...) now that it is visible
    if (location.hash) { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }
    watchToc();
  }
  async function loadPeople() {
    const ms = await db.collection('workspaces/' + st.wid + '/members').get();
    st.members = ms.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : (a.displayName || '').localeCompare(b.displayName || '')));
    try {
      const is = await db.collection('workspaces/' + st.wid + '/invites').get();
      st.invites = is.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { st.invites = []; }
  }

  // ---------- Render ----------
  function renderAll() { renderUser(); renderWorkspace(); renderPeople(); renderAdmin(); }

  function renderUser() {
    const me = st.members.find(m => m.id === st.user.uid) || {};
    const name = st.profile.name || st.user.displayName || '';
    $('uName').value = name;
    $('uUser').value = st.profile.username ? '@' + st.profile.username : '';
    $('uEmail').value = st.user.email || '';
    $('uRole').textContent = st.isOwner ? 'Owner' : 'Member';
    $('uRole').className = 'role' + (st.isOwner ? ' role--owner' : '');
    $('uJoined').textContent = me.joinedAt ? 'Joined ' + fmtDate(me.joinedAt) : '';
    const photo = pending.userPhoto !== undefined ? pending.userPhoto : (st.profile.logo || '');
    setPic($('uPic'), photo, name || st.user.email);
    $('uPhotoRemove').hidden = !photo;
  }

  function renderWorkspace() {
    const owner = st.members.find(m => m.role === 'owner' || m.id === st.ws.ownerId);
    setPic($('wPicView'), st.ws.logo || '', st.ws.name);
    $('wNameView').textContent = st.ws.name || 'Untitled workspace';
    $('wSub').textContent = st.isOwner ? 'You own this workspace' : 'You’re a member';
    $('wOwner').textContent = owner ? (owner.displayName || owner.email || '—') : '—';
    $('wCreated').textContent = fmtDate(st.ws.createdAt);
    $('wCount').textContent = String(st.members.length);
    $('wPending').textContent = String(st.invites.length);
    $('wId').textContent = st.wid;
  }

  function renderPeople() {
    const list = $('memberList');
    list.textContent = '';
    st.members.forEach(m => {
      const li = el('li');
      const pic = el('div', 'st-pic st-pic--round');
      setPic(pic, m.photo || '', m.displayName || m.email);
      const who = el('div', 'st-person');
      const b = el('b', null, m.displayName || m.email || 'Unknown');
      if (m.id === st.user.uid) b.appendChild(el('span', 'you', ' (you)')).style.display = 'inline';
      who.appendChild(b);
      who.appendChild(el('span', null, [m.username ? '@' + m.username : '', m.email].filter(Boolean).join(' · ')));
      li.append(pic, who, el('span', 'role' + (m.role === 'owner' ? ' role--owner' : ''), m.role === 'owner' ? 'Owner' : 'Member'));
      if (st.isOwner && m.id !== st.user.uid) {
        const rm = el('button', 'btn btn--sm btn--danger', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => removeMember(m, rm));
        li.appendChild(rm);
      }
      list.appendChild(li);
    });

    const inv = $('inviteList');
    inv.textContent = '';
    $('inviteHead').hidden = !st.invites.length;
    st.invites.forEach(i => {
      const li = el('li');
      const pic = el('div', 'st-pic st-pic--round');
      setPic(pic, '', i.email || i.id);
      const who = el('div', 'st-person');
      who.appendChild(el('b', null, i.email || i.id));
      who.appendChild(el('span', null, 'Invited ' + fmtDate(i.createdAt) + (i.invitedByName ? ' by ' + i.invitedByName : '')));
      li.append(pic, who, el('span', 'role role--pending', 'Pending'));
      if (st.isOwner) {
        const rv = el('button', 'btn btn--sm btn--quiet', 'Revoke');
        rv.type = 'button';
        rv.addEventListener('click', () => revokeInvite(i, rv));
        li.appendChild(rv);
      }
      inv.appendChild(li);
    });
  }

  function renderAdmin() {
    if (!st.isOwner) return;
    $('wName').value = st.ws.name || '';
    const logo = pending.wsLogo !== undefined ? pending.wsLogo : (st.ws.logo || '');
    setPic($('wPic'), logo, st.ws.name);
    $('wLogoRemove').hidden = !logo;
    $('shareLink').value = SIGNUP_URL + '?w=' + encodeURIComponent(st.wid);
  }

  // ---------- 1. Your profile ----------
  $('uPhoto').addEventListener('change', async () => {
    const f = $('uPhoto').files[0];
    $('uPhoto').value = '';
    if (!f) return;
    try { pending.userPhoto = await readImage(f, 'cover'); setErr('uPhotoErr', ''); renderUser(); }
    catch (e) { setErr('uPhotoErr', e.message); }
  });
  $('uPhotoRemove').addEventListener('click', () => { pending.userPhoto = ''; renderUser(); });

  $('userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('uName').value.trim();
    if (!name) return setErr('uNameErr', 'Enter your display name.');
    setErr('uNameErr', '');
    try {
      await busy($('userSave'), 'Saving…', async () => {
        const photo = pending.userPhoto !== undefined ? (pending.userPhoto || null) : (st.profile.logo || null);
        await st.user.updateProfile({ displayName: name });
        await db.doc('users/' + st.user.uid + '/profile/info').set({ name, logo: photo, updatedAt: TS() }, { merge: true });
        await db.doc('workspaces/' + st.wid + '/members/' + st.user.uid).update({ displayName: name, photo });
        st.profile.name = name; st.profile.logo = photo;
        const me = st.members.find(m => m.id === st.user.uid);
        if (me) { me.displayName = name; me.photo = photo; }
        pending.userPhoto = undefined;
      });
      renderAll();
      if (window.fnavRefresh) window.fnavRefresh();
      showMsg('Profile saved.');
    } catch (ex) { showMsg(friendly(ex, 'Could not save your profile. Try again.'), true); }
  });

  $('pwReset').addEventListener('click', async () => {
    try {
      await busy($('pwReset'), 'Sending…', () => auth.sendPasswordResetEmail(st.user.email));
      showMsg('Password reset link sent to ' + st.user.email + '.');
    } catch (ex) { showMsg(friendly(ex, 'Could not send the email. Try again.'), true); }
  });

  // ---------- 4. Admin: workspace name + logo ----------
  $('wLogo').addEventListener('change', async () => {
    const f = $('wLogo').files[0];
    $('wLogo').value = '';
    if (!f) return;
    try { pending.wsLogo = await readImage(f, 'contain'); setErr('wLogoErr', ''); renderAdmin(); }
    catch (e) { setErr('wLogoErr', e.message); }
  });
  $('wLogoRemove').addEventListener('click', () => { pending.wsLogo = ''; renderAdmin(); });

  $('wsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('wName').value.trim();
    if (!name) return setErr('wNameErr', 'Give your workspace a name.');
    if (name.length > 50) return setErr('wNameErr', 'Keep it to 50 characters or fewer.');
    setErr('wNameErr', '');
    try {
      await busy($('wsSave'), 'Saving…', async () => {
        const logo = pending.wsLogo !== undefined ? (pending.wsLogo || null) : (st.ws.logo || null);
        await db.doc('workspaces/' + st.wid).update({ name, logo });
        st.ws.name = name; st.ws.logo = logo;
        pending.wsLogo = undefined;
      });
      renderAll();
      if (window.fnavRefresh) window.fnavRefresh();
      showMsg('Workspace saved.');
    } catch (ex) { showMsg(friendly(ex, 'Could not save the workspace. Try again.'), true); }
  });

  // ---------- 4. Admin: invite people ----------
  $('inviteForm').addEventListener('submit', async e => {
    e.preventDefault();
    const taken = new Set(st.members.map(m => (m.email || '').toLowerCase()));
    const list = Array.from(new Set($('iEmails').value.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)));
    if (!list.length) return setErr('iEmailsErr', 'Enter at least one email address.');
    const bad = list.filter(em => !EMAIL_RE.test(em));
    if (bad.length) return setErr('iEmailsErr', 'These don’t look right: ' + bad.join(', '));
    const already = list.filter(em => taken.has(em));
    if (already.length) return setErr('iEmailsErr', 'Already in the workspace: ' + already.join(', '));
    if (list.length > MAX_INVITES) return setErr('iEmailsErr', 'Invite up to ' + MAX_INVITES + ' people at a time.');
    setErr('iEmailsErr', '');

    const sent = [], failed = [];
    await busy($('inviteBtn'), 'Sending…', async () => {
      for (const em of list) {
        try {
          await db.doc('workspaces/' + st.wid + '/invites/' + em).set({
            email: em, invitedBy: st.user.uid, invitedByName: st.user.displayName || '', createdAt: TS()
          });
        } catch (ex) { console.error(ex); failed.push(em); continue; }
        try {
          await auth.sendSignInLinkToEmail(em, { url: SIGNUP_URL + '?w=' + encodeURIComponent(st.wid), handleCodeInApp: true });
          sent.push(em);
        } catch (ex) { console.error(ex); failed.push(em); }
      }
      await loadPeople();
    });
    renderAll();
    $('iEmails').value = '';
    const parts = [];
    if (sent.length) parts.push('Invitation sent to ' + sent.join(', ') + '.');
    if (failed.length) parts.push('Couldn’t email ' + failed.join(', ') + '. Share the invite link with them instead.');
    showMsg(parts.join(' '), !sent.length);
  });

  $('copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('shareLink').value); showMsg('Invite link copied.'); }
    catch (e) { $('shareLink').focus(); $('shareLink').select(); }
  });

  // ---------- 3. Members: remove / revoke (owner) ----------
  async function removeMember(m, btn) {
    if (!confirm('Remove ' + (m.displayName || m.email) + ' from ' + (st.ws.name || 'this workspace') + '? They’ll lose access to its lists.')) return;
    try {
      await busy(btn, 'Removing…', () => db.doc('workspaces/' + st.wid + '/members/' + m.id).delete());
      st.members = st.members.filter(x => x.id !== m.id);
      renderAll();
      showMsg((m.displayName || m.email) + ' was removed.');
    } catch (ex) { showMsg(friendly(ex, 'Could not remove that person. Try again.'), true); }
  }
  async function revokeInvite(i, btn) {
    if (!confirm('Cancel the invitation for ' + (i.email || i.id) + '?')) return;
    try {
      await busy(btn, 'Revoking…', () => db.doc('workspaces/' + st.wid + '/invites/' + i.id).delete());
      st.invites = st.invites.filter(x => x.id !== i.id);
      renderAll();
      showMsg('Invitation for ' + (i.email || i.id) + ' cancelled.');
    } catch (ex) { showMsg(friendly(ex, 'Could not cancel that invitation. Try again.'), true); }
  }

  // ---------- Section links: highlight the section you're looking at ----------
  function watchToc() {
    const links = Array.from(document.querySelectorAll('.st-toc a'));
    const mark = id => links.forEach(a => a.classList.toggle('is-active', a.getAttribute('href') === '#' + id));
    const io = new IntersectionObserver(entries => {
      entries.filter(en => en.isIntersecting).forEach(en => mark(en.target.id));
    }, { rootMargin: '-35% 0px -55% 0px' });
    document.querySelectorAll('.st-card').forEach(c => { if (c.offsetParent) io.observe(c); });
    mark((location.hash || '#user').slice(1));
  }

  // ---------- Start ----------
  const stop = auth.onAuthStateChanged(user => {
    stop();
    if (!user) { location.replace('login.html'); return; }
    load(user).catch(ex => showMsg(friendly(ex, 'Could not load your settings. Refresh to try again.'), true));
  });
})();
