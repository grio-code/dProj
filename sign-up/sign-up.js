// Create-a-workspace wizard (modeled on Slack's flow):
//   1 Email  ->  2 Verify (emailed link)  ->  3 Name the workspace  ->  4 Profile  ->  5 Invite teammates
// People who arrive from an invite (signup.html?w=WORKSPACE_ID) skip steps 3 and 5 and join that workspace instead.
//
// Data written to Firestore:
//   workspaces/{wid}                    name, ownerId, createdAt
//   workspaces/{wid}/members/{uid}      role (owner|member), displayName, username, email, photo, joinedAt
//   workspaces/{wid}/invites/{email}    one doc per invited email (removed when that person joins)
//   workspaces/{wid}/usernames/{name}   claims a username so two people can't share one
//   users/{uid}/profile/info            name, username, logo (profile photo), workspaceId
(() => {
  'use strict';
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();
  const $ = id => document.getElementById(id);

  // ---------- Settings you may want to change ----------
  const APP_URL = 'allLists.html';                              // where to go once setup is finished
  const PAGE_URL = location.origin + location.pathname;         // this page; emailed links come back here
  const MAX_PHOTO_BYTES = 2 * 1024 * 1024;                      // 2 MB
  const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // SVG left out on purpose: it can carry scripts
  const MIN_PASSWORD = 8;
  const MAX_INVITES = 25;
  const RESEND_SECONDS = 30;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const USER_RE = /^[a-z0-9._-]{3,30}$/;

  // The top-bar Login / Sign up buttons stay hidden until auth-ui.js says "ready". This page doesn't use auth-ui.js, so show them.
  document.documentElement.classList.add('auth-ready');

  // ---------- Tiny helpers ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function setErr(id, text) {
    const el = $(id);
    el.textContent = text || '';
    const input = el.parentElement.querySelector('input, textarea');
    if (input && input.type !== 'file') { if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }
  function showMsg(text, isError = true) {
    const m = $('msg');
    m.textContent = text || '';
    m.hidden = !text;
    m.style.borderColor = isError ? 'var(--danger)' : 'var(--done)';
  }
  // Disable a button while an action runs, and always bring it back afterwards
  async function busy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }
  function friendly(code, fallback) {
    return ({
      'auth/invalid-email': 'That email address doesn\u2019t look right.',
      'auth/too-many-requests': 'Too many attempts. Try again in a bit.',
      'auth/quota-exceeded': 'Too many emails sent today. Try again tomorrow.',
      'auth/network-request-failed': 'Network problem. Check your connection and try again.',
      'auth/operation-not-allowed': 'Email-link sign-in isn\u2019t turned on yet. In the Firebase console, open Authentication > Sign-in method > Email/Password and enable "Email link".',
      'auth/unauthorized-continue-uri': 'This website isn\u2019t on the authorized domains list yet. Add it in Firebase console > Authentication > Settings > Authorized domains.',
      'auth/invalid-action-code': 'That link has expired or was already used. Enter your email to get a new one.',
      'auth/expired-action-code': 'That link has expired. Enter your email to get a new one.',
      'auth/weak-password': 'Choose a stronger password.',
      'auth/requires-recent-login': 'For security, please start over and confirm your email again.',
      'permission-denied': 'You don\u2019t have permission to do that. If this keeps happening, the Firestore rules may not be published yet.'
    })[code] || fallback || 'Something went wrong. Please try again.';
  }

  // ---------- State ----------
  const qs = new URLSearchParams(location.search);
  if (qs.get('w')) store.set('pendingWid', qs.get('w'));            // remember which workspace the invite is for
  const invitedWid = qs.get('w') || store.get('pendingWid') || '';
  const ctx = { user: null, profile: {}, wid: '', workspaceName: '', isOwner: false, invited: !!invitedWid, claimed: '' };
  let seq = 0; // guards against an older sign-in check finishing after a newer one

  // ---------- Steps ----------
  const TITLES = {
    email: 'Create your workspace', verify: 'Check your email', confirmEmail: 'Confirm your email',
    workspace: 'Name your workspace', profile: 'Set up your profile', invite: 'Invite your team', done: 'You\u2019re all set'
  };
  const ORDER = ['email', 'verify', 'workspace', 'profile', 'invite'];
  const PROGRESS = { email: 'email', verify: 'verify', confirmEmail: 'verify', workspace: 'workspace', profile: 'profile', invite: 'invite', done: null };

  function showStep(name) {
    document.querySelectorAll('.step').forEach(s => { s.hidden = s.dataset.step !== name; });
    $('stepTitle').textContent = TITLES[name] || TITLES.email;
    const cur = PROGRESS[name];
    const idx = cur ? ORDER.indexOf(cur) : ORDER.length;       // "done" marks every step finished
    document.querySelectorAll('#wsSteps li').forEach(li => {
      const i = ORDER.indexOf(li.dataset.s);
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-current', i === idx);
    });
    $('wsSteps').classList.toggle('is-invitee', !!ctx.invited);
    const first = document.querySelector('.step[data-step="' + name + '"] input:not([type=file]), .step[data-step="' + name + '"] textarea');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }

  // ================= STEP 1: email =================
  async function sendLink(email) {
    const url = PAGE_URL + (invitedWid ? '?w=' + encodeURIComponent(invitedWid) : '');
    await auth.sendSignInLinkToEmail(email, { url, handleCodeInApp: true });
    store.set('emailForSignIn', email);
  }
  $('emailForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const email = $('wEmail').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setErr('wEmailErr', 'Enter a valid email, like you@company.com.');
    setErr('wEmailErr', '');
    try {
      await busy($('emailBtn'), 'Sending\u2026', () => sendLink(email));
      $('verifyEmail').textContent = email;
      startCooldown();
      showStep('verify');
    } catch (ex) {
      console.error(ex);
      showMsg(friendly(ex.code, 'Could not send the email. Try again.'));
    }
  });

  // ================= STEP 2: verify =================
  let cooldown = null;
  function startCooldown() {
    let left = RESEND_SECONDS;
    const b = $('resendBtn');
    b.disabled = true;
    clearInterval(cooldown);
    const tick = () => {
      b.textContent = left > 0 ? 'Resend email (' + left + 's)' : 'Resend email';
      if (left <= 0) { b.disabled = false; clearInterval(cooldown); }
      left--;
    };
    tick();
    cooldown = setInterval(tick, 1000);
  }
  $('resendBtn').addEventListener('click', async () => {
    const email = store.get('emailForSignIn');
    if (!email) { showStep('email'); return; }
    try {
      await sendLink(email);
      showMsg('Email sent again.', false);
      startCooldown();
    } catch (ex) { showMsg(friendly(ex.code, 'Could not send the email. Try again.')); }
  });
  $('changeEmailBtn').addEventListener('click', () => { showMsg(''); showStep('email'); });

  // The emailed link opened on a different browser or device: we don't know the email, so ask for it
  $('confirmForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const email = $('cEmail').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setErr('cEmailErr', 'Enter a valid email, like you@company.com.');
    setErr('cEmailErr', '');
    await busy($('confirmBtn'), 'Confirming\u2026', () => completeLink(email));
  });

  async function completeLink(email) {
    try {
      showMsg('Confirming your email\u2026', false);
      await auth.signInWithEmailLink(email, location.href);
      store.del('emailForSignIn');
      history.replaceState(null, '', PAGE_URL + (invitedWid ? '?w=' + encodeURIComponent(invitedWid) : ''));
      showMsg('');
      // onAuthStateChanged (below) takes it from here
    } catch (ex) {
      console.error(ex);
      history.replaceState(null, '', PAGE_URL);
      showStep(ex.code === 'auth/invalid-email' ? 'confirmEmail' : 'email');
      showMsg(ex.code === 'auth/invalid-email' ? 'That email doesn\u2019t match the one the link was sent to.' : friendly(ex.code, 'Could not confirm your email. Try again.'));
    }
  }

  // ================= Where does this person go next? =================
  async function readWorkspace(wid) {
    try { const s = await db.doc('workspaces/' + wid).get(); return s.exists ? s.data() : null; }
    catch (e) { return null; }
  }
  async function resume(user) {
    const my = ++seq;
    ctx.user = user;
    const pSnap = await db.doc('users/' + user.uid + '/profile/info').get().catch(() => null);
    if (my !== seq) return;
    ctx.profile = pSnap && pSnap.exists ? pSnap.data() : {};
    ctx.wid = ctx.profile.workspaceId || '';
    ctx.claimed = ctx.profile.username || '';

    if (ctx.wid && ctx.profile.username) { location.replace(APP_URL); return; } // already fully set up

    if (ctx.wid) {                                  // has a workspace but hasn't finished their profile
      const ws = await readWorkspace(ctx.wid);
      if (my !== seq) return;
      ctx.workspaceName = ws ? ws.name : '';
      ctx.isOwner = !!ws && ws.ownerId === user.uid;
      ctx.invited = !ctx.isOwner;
      return enterProfile();
    }
    if (invitedWid) {                               // arrived from an invite link: this only works if THIS email was invited
      const ws = await readWorkspace(invitedWid);
      if (my !== seq) return;
      if (ws) {
        ctx.wid = invitedWid; ctx.workspaceName = ws.name; ctx.isOwner = false; ctx.invited = true;
        return enterProfile();
      }
      store.del('pendingWid');
      ctx.invited = false;
      showStep('workspace');
      showMsg('There\u2019s no invitation for ' + user.email + ' on that workspace. Ask the person who invited you to use this address, or create your own workspace below.');
      return;
    }
    ctx.invited = false;
    showStep('workspace');
  }
  function enterProfile() {
    if (ctx.user.displayName && !$('pName').value) $('pName').value = ctx.user.displayName;
    if (!$('pUser').value) $('pUser').value = ((ctx.user.email || '').split('@')[0] || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
    $('profileIntro').textContent = ctx.invited && ctx.workspaceName
      ? 'You\u2019re joining ' + ctx.workspaceName + '. Add your name and a photo so your team knows who you are.'
      : 'Add your name and a photo so your team knows who you are.';
    showStep('profile');
  }

  // ================= STEP 3: name the workspace =================
  $('wName').addEventListener('input', () => { $('wNameCount').textContent = $('wName').value.length; });
  $('workspaceForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const name = $('wName').value.trim();
    if (!name) return setErr('wNameErr', 'Give your workspace a name.');
    if (name.length > 50) return setErr('wNameErr', 'Keep it to 50 characters or fewer.');
    setErr('wNameErr', '');
    try {
      await busy($('workspaceBtn'), 'Creating\u2026', async () => {
        const uid = ctx.user.uid;
        const ref = ctx.wid ? db.doc('workspaces/' + ctx.wid) : db.collection('workspaces').doc();
        if (ctx.wid) await ref.update({ name });
        else await ref.set({ name, ownerId: uid, createdAt: TS() });
        await db.doc('users/' + uid + '/profile/info').set({ workspaceId: ref.id }, { merge: true });
        ctx.wid = ref.id; ctx.workspaceName = name; ctx.isOwner = true; ctx.invited = false;
      });
      enterProfile();
    } catch (ex) {
      console.error(ex);
      showMsg(friendly(ex.code, 'Could not create the workspace. Try again.'));
    }
  });

  // ================= STEP 4: profile =================
  $('pUser').addEventListener('input', () => { $('pUser').value = $('pUser').value.toLowerCase().replace(/\s+/g, ''); });
  $('pwToggle').addEventListener('click', () => {
    const i = $('pPassword'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('pwToggle').textContent = show ? 'Hide' : 'Show';
    $('pwToggle').setAttribute('aria-pressed', String(show));
  });

  // Photo: pick or drop, check, preview
  const photo = { file: null, url: null };
  function clearPhoto() {
    $('pPhoto').value = '';
    photo.file = null;
    if (photo.url) { URL.revokeObjectURL(photo.url); photo.url = null; }
    $('photoPreview').textContent = 'No photo';
    $('photoName').textContent = 'Choose or drop an image';
    $('photoRemove').hidden = true;
    setErr('pPhotoErr', '');
  }
  function acceptPhoto(file) {
    if (!file) return clearPhoto();
    if (!PHOTO_TYPES.includes(file.type)) { clearPhoto(); return setErr('pPhotoErr', 'Use a PNG, JPG or WebP image.'); }
    if (file.size > MAX_PHOTO_BYTES) { clearPhoto(); return setErr('pPhotoErr', 'That image is over 2 MB. Choose a smaller one.'); }
    setErr('pPhotoErr', '');
    if (photo.url) URL.revokeObjectURL(photo.url);
    photo.file = file;
    photo.url = URL.createObjectURL(file);
    $('photoPreview').textContent = '';
    const img = new Image();
    img.src = photo.url;
    img.alt = 'Profile photo preview';
    $('photoPreview').appendChild(img);
    $('photoName').textContent = file.name;
    $('photoRemove').hidden = false;
  }
  $('pPhoto').addEventListener('change', () => acceptPhoto($('pPhoto').files[0]));
  $('photoRemove').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); clearPhoto(); });
  const drop = $('photoDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    $('pPhoto').files = dt.files;
    acceptPhoto(file);
  });
  // Crops to a square and shrinks to 256px so it fits comfortably in a Firestore document (1 MB limit)
  async function shrinkPhoto(file, size = 256) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/webp', 0.85);
  }

  $('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const name = $('pName').value.trim();
    const uname = $('pUser').value.trim().toLowerCase();
    const pw = $('pPassword').value;
    let ok = true;
    if (!name) { setErr('pNameErr', 'Enter your display name.'); ok = false; } else setErr('pNameErr', '');
    if (!USER_RE.test(uname)) { setErr('pUserErr', 'Use 3 to 30 lowercase letters, numbers, periods, dashes or underscores.'); ok = false; } else setErr('pUserErr', '');
    if (pw.length < MIN_PASSWORD) { setErr('pPasswordErr', 'Use at least ' + MIN_PASSWORD + ' characters.'); ok = false; } else setErr('pPasswordErr', '');
    if (!ok || $('pPhotoErr').textContent) return;

    try {
      await busy($('profileBtn'), 'Saving\u2026', async () => {
        const user = ctx.user, wid = ctx.wid;
        const photoData = photo.file ? await shrinkPhoto(photo.file) : (ctx.profile.logo || null);

        await user.updatePassword(pw);                       // lets them use login.html (email + password) next time
        await user.updateProfile({ displayName: name });

        // Claim the username (unique within this workspace)
        const claimRef = db.doc('workspaces/' + wid + '/usernames/' + uname);
        const claim = await claimRef.get();
        if (claim.exists && claim.data().uid !== user.uid) { const err = new Error('taken'); err.code = 'username-taken'; throw err; }
        if (!claim.exists) await claimRef.set({ uid: user.uid, createdAt: TS() });
        if (ctx.claimed && ctx.claimed !== uname) await db.doc('workspaces/' + wid + '/usernames/' + ctx.claimed).delete().catch(() => {});
        ctx.claimed = uname;

        // Join the workspace as owner (the creator) or member (an invited person)
        await db.doc('workspaces/' + wid + '/members/' + user.uid).set({
          role: ctx.isOwner ? 'owner' : 'member',
          displayName: name, username: uname, email: user.email, photo: photoData, joinedAt: TS()
        });
        await db.doc('users/' + user.uid + '/profile/info').set({
          name, username: uname, logo: photoData, workspaceId: wid, updatedAt: TS()
        }, { merge: true });
        if (ctx.invited) await db.doc('workspaces/' + wid + '/invites/' + (user.email || '').toLowerCase()).delete().catch(() => {});
        store.del('pendingWid');
      });
    } catch (ex) {
      console.error(ex);
      if (ex.code === 'username-taken') return setErr('pUserErr', 'That username is taken. Try another.');
      return showMsg(friendly(ex.code, 'Could not save your profile. Try again.'));
    }
    if (ctx.isOwner) showStep('invite'); else showDone([], []);
  });

  // ================= STEP 5: invite teammates =================
  $('inviteForm').addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const own = (ctx.user.email || '').toLowerCase();
    const list = Array.from(new Set($('iEmails').value.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))).filter(em => em !== own);
    if (!list.length) return setErr('iEmailsErr', 'Enter at least one email address, or choose Skip for now.');
    const bad = list.filter(em => !EMAIL_RE.test(em));
    if (bad.length) return setErr('iEmailsErr', 'These don\u2019t look right: ' + bad.join(', '));
    if (list.length > MAX_INVITES) return setErr('iEmailsErr', 'Invite up to ' + MAX_INVITES + ' people at a time.');
    setErr('iEmailsErr', '');

    const sent = [], failed = [];
    await busy($('inviteBtn'), 'Sending\u2026', async () => {
      for (const em of list) {
        try {
          await db.doc('workspaces/' + ctx.wid + '/invites/' + em).set({
            email: em, invitedBy: ctx.user.uid, invitedByName: ctx.user.displayName || '', createdAt: TS()
          });
        } catch (ex) { console.error(ex); failed.push(em); continue; }
        try {
          await auth.sendSignInLinkToEmail(em, { url: PAGE_URL + '?w=' + encodeURIComponent(ctx.wid), handleCodeInApp: true });
          sent.push(em);
        } catch (ex) { console.error(ex); failed.push(em); }
      }
    });
    showDone(sent, failed);
  });
  $('skipInvite').addEventListener('click', () => showDone([], []));

  // ================= Done =================
  function showDone(sent, failed) {
    $('doneText').textContent = ctx.isOwner
      ? (ctx.workspaceName || 'Your workspace') + ' is ready.'
      : 'You\u2019ve joined ' + (ctx.workspaceName || 'the workspace') + '.';
    const parts = [];
    if (sent.length) parts.push('Invitation sent to ' + sent.join(', ') + '.');
    if (failed.length) parts.push('We couldn\u2019t email ' + failed.join(', ') + ' (they\u2019re still invited: share the link below).');
    $('doneInvites').textContent = parts.join(' ');
    $('doneInvites').hidden = !parts.length;
    $('linkRow').hidden = !ctx.isOwner;
    $('shareLink').value = PAGE_URL + '?w=' + encodeURIComponent(ctx.wid);
    showStep('done');
  }
  $('copyLink').addEventListener('click', async () => {
    const input = $('shareLink');
    try { await navigator.clipboard.writeText(input.value); showMsg('Link copied.', false); }
    catch (e) { input.focus(); input.select(); showMsg('Select the link and copy it.', false); }
  });
  $('goApp').addEventListener('click', () => { location.href = APP_URL; });

  // ================= Start =================
  const isLink = auth.isSignInWithEmailLink(location.href);
  auth.onAuthStateChanged(user => {
    if (user) resume(user);
    else if (!isLink) showStep('email');
  });
  if (isLink) {
    const email = store.get('emailForSignIn');
    if (email) completeLink(email); else showStep('confirmEmail');
  }
})();