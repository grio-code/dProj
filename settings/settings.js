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
    $('uRole').textContent = st.isOwner ? 'Owner' : me.canEdit ? 'Editor' : 'Member';
    $('uRole').className = 'role' + (st.isOwner ? ' role--owner' : me.canEdit ? ' role--editor' : '');
    $('uJoined').textContent = (me.joinedAt ? 'Joined ' + fmtDate(me.joinedAt) + '. ' : '')
      + (st.isOwner || me.canEdit ? 'You can edit lists.' : 'You can check items off. Ask the owner if you need to edit lists.');
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
      const isOwnerRow = m.role === 'owner' || m.id === st.ws.ownerId;
      li.append(pic, who);
      if (st.isOwner && !isOwnerRow) {
        // ADDED: the owner decides who can edit lists. Everyone else can only check items off.
        li.appendChild(editToggle(m));
      } else {
        li.appendChild(el('span', 'role' + (isOwnerRow ? ' role--owner' : m.canEdit ? ' role--editor' : ''),
          isOwnerRow ? 'Owner' : m.canEdit ? 'Editor' : 'Member'));
      }
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
        const em = i.email || i.id;
        li.appendChild(sendMenu([em]));
        const rv = el('button', 'btn btn--sm btn--quiet', 'Revoke');
        rv.type = 'button';
        rv.addEventListener('click', () => revokeInvite(i, rv));
        li.appendChild(rv);
      }
      inv.appendChild(li);
    });
  }

  // ADDED: "Can edit lists" switch on a member's row (owner only)
  function editToggle(m) {
    const lab = el('label', 'st-switch');
    lab.title = 'Editors can add, change and remove rooms, items and lists. Others can only check items off.';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = m.canEdit === true;
    cb.setAttribute('aria-label', 'Let ' + (m.displayName || m.email) + ' edit lists');
    cb.addEventListener('change', async () => {
      const on = cb.checked;
      cb.disabled = true;
      try {
        await db.doc('workspaces/' + st.wid + '/members/' + m.id).update({ canEdit: on });
        m.canEdit = on;
        showMsg((m.displayName || m.email) + (on ? ' can now edit lists.' : ' can now only check items off.'));
      } catch (ex) {
        cb.checked = !on;
        showMsg(friendly(ex, 'Could not change that. Try again.'), true);
      } finally { cb.disabled = false; }
    });
    lab.append(cb, el('span', 'st-switch-ui'), el('span', 'st-switch-text', 'Can edit lists'));
    return lab;
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
  // The invitation is a message the owner sends from their own email (or text). We don't rely on Firebase's
  // sign-in email for this: on the free Spark plan Firebase sends only 5 sign-in-link emails a day for the whole
  // project, those emails don't mention the workspace, and they often land in spam. Saving the quota also means
  // the invited person's own confirmation email (sent when they open the link and enter their address) goes out.
  const inviteUrl = () => SIGNUP_URL + '?w=' + encodeURIComponent(st.wid);
  const inviteSubject = () => 'Join ' + (st.ws.name || 'our workspace') + ' on Integrate';
  function inviteText(email) {
    const from = st.profile.name || st.user.displayName || 'Your team';
    return [
      'Hi,',
      '',
      from + ' invited you to join ' + (st.ws.name || 'our workspace') + ' on Integrate.',
      '',
      'To join:',
      '1. Open this link: ' + inviteUrl(),
      '2. Enter ' + (email ? 'this email address: ' + email : 'the email address this invitation was sent to') + ' (it has to match exactly).',
      '3. We’ll email you a confirmation link. Open it, then add your name and a password.',
      '',
      'If the confirmation email doesn’t show up in a few minutes, check your spam folder.',
      '',
      'See you there,',
      from
    ].join('\n');
  }
  // Ways to send the invitation. A plain mailto: link only works when the computer has an email app set up
  // (otherwise the browser opens a blank page), so webmail compose links are offered too.
  // One person goes in To; several go in Bcc so invitees don't see each other's addresses.
  function composeLinks(emails) {
    const one = emails.length === 1;
    const to = one ? emails[0] : '';
    const bcc = one ? '' : emails.join(',');
    const subject = inviteSubject();
    const body = inviteText(one ? emails[0] : '');
    const qs = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    return [
      { label: 'Gmail', href: 'https://mail.google.com/mail/?' + qs({ view: 'cm', fs: '1', to, bcc, su: subject, body }), web: true },
      { label: 'Outlook', href: 'https://outlook.office.com/mail/deeplink/compose?' + qs({ to, bcc, subject, body }), web: true },
      { label: 'Email app', href: 'mailto:' + encodeURIComponent(to) + '?' + qs({ bcc, subject, body }), web: false }
    ];
  }
  function linkBtn(l, cls) {
    const a = el('a', cls, l.label);
    a.href = l.href;
    if (l.web) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  }
  function copyBtn(emails, cls, label) {
    const b = el('button', cls, label || 'Copy text');
    b.type = 'button';
    b.addEventListener('click', () => copyText(inviteText(emails.length === 1 ? emails[0] : ''),
      'Invitation copied. Paste it into an email or text message.'));
    return b;
  }
  // "Send invite" button with a small menu (used on each pending invite)
  function sendMenu(emails) {
    const wrap = el('div', 'st-menu');
    const btn = el('button', 'btn btn--sm', 'Send invite ▾');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'st-menu-list');
    menu.hidden = true;
    composeLinks(emails).forEach(l => menu.appendChild(linkBtn(l, 'st-menu-item')));
    menu.appendChild(copyBtn(emails, 'st-menu-item', 'Copy text'));
    const set = open => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.st-menu-list').forEach(m => { if (m !== menu) m.hidden = true; });
      set(menu.hidden);
    });
    menu.addEventListener('click', () => set(false));
    wrap.append(btn, menu);
    return wrap;
  }
  document.addEventListener('click', () => document.querySelectorAll('.st-menu-list').forEach(m => { m.hidden = true; }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.st-menu-list').forEach(m => { m.hidden = true; }); });

  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); showMsg(okMsg); }
    catch (e) { window.prompt('Copy this:', text); }
  }

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

    const added = [], failed = [];
    await busy($('inviteBtn'), 'Adding…', async () => {
      for (const em of list) {
        try {
          await db.doc('workspaces/' + st.wid + '/invites/' + em).set({
            email: em, invitedBy: st.user.uid, invitedByName: st.profile.name || st.user.displayName || '', createdAt: TS()
          });
          added.push(em);
        } catch (ex) { console.error(ex); failed.push(em); }
      }
      await loadPeople();
    });
    renderAll();
    if (failed.length) showMsg(friendly({ code: 'permission-denied' }, '') + ' Not added: ' + failed.join(', '), true);
    if (!added.length) return;
    $('iEmails').value = '';
    showInviteResult(added);
  });

  // After adding: the next step is sending the message, so put it right there
  function showInviteResult(emails) {
    const box = $('inviteResult');
    box.textContent = '';
    box.appendChild(el('b', null, emails.length === 1 ? emails[0] + ' can now join.' : emails.length + ' people can now join.'));
    box.appendChild(el('p', null, 'Last step: send them the invitation. It has the link and step-by-step directions. Pick how you send email:'));
    const row = el('div', 'st-actions');
    composeLinks(emails).forEach(l => row.appendChild(linkBtn(l, 'btn')));
    row.appendChild(copyBtn(emails, 'btn', 'Copy text'));
    box.appendChild(row);
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('copyLink').addEventListener('click', () => copyText($('shareLink').value, 'Invite link copied.'));

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