(() => {
  if (!window.firebase) return;
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const root = document.documentElement;

  const fnav = document.getElementById('fnav');
  const brand = fnav && fnav.querySelector('.fnav-brand');
  const actions = fnav && fnav.querySelector('.fnav-actions');
  if (!fnav || !brand || !actions) return;

  // Mark the existing Login / Sign up links so CSS can hide them when signed in
  actions.querySelectorAll('a').forEach(a => a.classList.add('fnav-guest'));

  // Put the brand and the greeting in one column: "Integrate" on top, "[logo] Hello, Name" under it
  const left = document.createElement('div');
  left.className = 'fnav-left';
  brand.parentNode.insertBefore(left, brand);
  left.appendChild(brand);
  const hello = document.createElement('div');
  hello.className = 'fnav-hello';
  left.appendChild(hello);

  // Log out button (only visible when signed in)
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'fnav-btn fnav-btn--ghost fnav-out';
  out.textContent = 'Log out';
  out.addEventListener('click', () => {
    auth.signOut().then(() => { location.href = 'index.html'; });
  });
  actions.appendChild(out);

  // Keep page content clear of the top bar, since the greeting makes it taller
  function setNavH() {
    root.style.setProperty('--nav-h', fnav.offsetHeight + 'px');
  }

  // Get the logo saved at signup (cached for the session so it doesn't flicker between pages)
  async function loadLogo(uid) {
    const key = 'fnav-logo:' + uid;
    const cached = sessionStorage.getItem(key);
    if (cached !== null) return cached;
    try {
      const snap = await firebase.firestore().doc('users/' + uid + '/profile/info').get();
      const logo = (snap.exists && snap.data().logo) || '';
      try { sessionStorage.setItem(key, logo); } catch (e) {}
      return logo;
    } catch (e) {
      return '';
    }
  }

  function renderHello(user, logo) {
    const first = (user.displayName || '').trim().split(/\s+/)[0] || (user.email || '').split('@')[0] || 'there';
    hello.textContent = '';
    if (logo) {
      const img = new Image();
      img.alt = '';
      img.src = logo;
      img.addEventListener('load', setNavH);
      hello.appendChild(img);
    } else {
      const av = document.createElement('span');
      av.className = 'fnav-av';
      av.textContent = first.charAt(0).toUpperCase();
      hello.appendChild(av);
    }
    const t = document.createElement('span');
    t.className = 'fnav-hello-text';
    t.textContent = 'Hello, ' + first;
    hello.appendChild(t);
    setNavH();
  }

  auth.onAuthStateChanged(async user => {
    root.classList.toggle('signed-in', !!user);
    root.classList.add('auth-ready');
    if (!user) { hello.textContent = ''; setNavH(); return; }
    renderHello(user, '');                       // show the name right away
    const logo = await loadLogo(user.uid);       // then add the logo when it arrives
    if (logo && auth.currentUser) renderHello(user, logo);
  });
})();