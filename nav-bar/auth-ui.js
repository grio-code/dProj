// Top-bar sign-in state, shared by every page.
// Signed in, the bar reads:   INTEGRATE / [workspace logo] Workspace name   |   [photo] Hello, Name   |   Log out
// The workspace and the greeting both open settings.html (workspace section / your profile section).
(() => {
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const root = document.documentElement;

  const fnav = document.getElementById('fnav');
  const brand = fnav && fnav.querySelector('.fnav-brand');
  const links = fnav && fnav.querySelector('.fnav-links');
  const actions = fnav && fnav.querySelector('.fnav-actions');
  if (!fnav || !brand || !actions) return;

  // Mark the existing Login / Sign up links so CSS can hide them when signed in
  actions.querySelectorAll('a').forEach(a => a.classList.add('fnav-guest'));

  // Left column: "Integrate" on top, the workspace (company logo + name) under it
  const left = document.createElement('div');
  left.className = 'fnav-left';
  brand.parentNode.insertBefore(left, brand);
  left.appendChild(brand);
  const ws = document.createElement('a');
  ws.className = 'fnav-ws';
  ws.href = 'settings.html#workspace';
  ws.title = 'Workspace settings';
  left.appendChild(ws);

  // Middle: the page links (if any) and "[photo] Hello, Name", on the same line as the brand and the buttons
  const center = document.createElement('div');
  center.className = 'fnav-center';
  fnav.insertBefore(center, actions);
  if (links) center.appendChild(links);
  const hello = document.createElement('a');
  hello.className = 'fnav-hello';
  hello.href = 'settings.html#user';
  hello.title = 'Your settings';
  center.appendChild(hello);

  // Log out button (only visible when signed in)
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'fnav-btn fnav-btn--ghost fnav-out';
  out.textContent = 'Log out';
  out.addEventListener('click', () => {
    clearCache();
    auth.signOut().then(() => { location.href = 'index.html'; });
  });
  actions.appendChild(out);

  // Keep page content clear of the top bar, since the workspace line makes it taller
  function setNavH() {
    root.style.setProperty('--nav-h', fnav.offsetHeight + 'px');
  }
  window.addEventListener('resize', setNavH);

  // ---------- Data: profile (name, photo) + workspace (name, logo) ----------
  // Cached for the browser session so the bar doesn't flicker between pages.
  // settings.html calls window.fnavRefresh() after saving so the bar picks up changes right away.
  const cacheKey = uid => 'fnav-info:' + uid;
  function clearCache() {
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith('fnav-')).forEach(k => sessionStorage.removeItem(k));
    } catch (e) {}
  }
  async function loadInfo(uid, fresh) {
    if (!fresh) {
      try { const c = sessionStorage.getItem(cacheKey(uid)); if (c) return JSON.parse(c); } catch (e) {}
    }
    const info = { photo: '', name: '', wsName: '', wsLogo: '' };
    try {
      const db = firebase.firestore();
      const p = await db.doc('users/' + uid + '/profile/info').get();
      const prof = p.exists ? p.data() : {};
      info.photo = prof.logo || '';
      info.name = prof.name || '';
      if (prof.workspaceId) {
        const w = await db.doc('workspaces/' + prof.workspaceId).get();
        if (w.exists) { info.wsName = w.data().name || ''; info.wsLogo = w.data().logo || ''; }
      }
      try { sessionStorage.setItem(cacheKey(uid), JSON.stringify(info)); } catch (e) {}
    } catch (e) { /* offline or rules not published: show what we have */ }
    return info;
  }

  // A small image, or a letter tile when there's no image
  function badge(src, letter, cls) {
    if (src) {
      const img = new Image();
      img.alt = '';
      img.className = cls;
      img.src = src;
      img.addEventListener('load', setNavH);
      return img;
    }
    const s = document.createElement('span');
    s.className = cls + ' fnav-letter';
    s.textContent = (letter || '?').charAt(0).toUpperCase();
    return s;
  }
  function textSpan(cls, text) {
    const t = document.createElement('span');
    t.className = cls;
    t.textContent = text;
    return t;
  }

  function render(user, info) {
    const full = (info.name || user.displayName || '').trim();
    const first = full.split(/\s+/)[0] || (user.email || '').split('@')[0] || 'there';

    hello.textContent = '';
    hello.appendChild(badge(info.photo, first, 'fnav-av'));
    hello.appendChild(textSpan('fnav-hello-text', 'Hello, ' + first));

    ws.textContent = '';
    ws.hidden = !info.wsName;
    if (info.wsName) {
      ws.appendChild(badge(info.wsLogo, info.wsName, 'fnav-ws-logo'));
      ws.appendChild(textSpan('fnav-ws-name', info.wsName));
    }
    setNavH();
  }

  async function refresh(fresh) {
    const user = auth.currentUser;
    if (!user) return;
    const info = await loadInfo(user.uid, fresh);
    if (auth.currentUser && auth.currentUser.uid === user.uid) render(user, info);
  }
  window.fnavRefresh = () => refresh(true);

  auth.onAuthStateChanged(async user => {
    root.classList.toggle('signed-in', !!user);
    root.classList.add('auth-ready');
    if (!user) { hello.textContent = ''; ws.textContent = ''; setNavH(); return; }
    render(user, { photo: '', name: '', wsName: '', wsLogo: '' }); // greeting right away
    refresh(false);                                                  // then photo + workspace when they arrive
  });
})();
