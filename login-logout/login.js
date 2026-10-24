// ©Gianna G. Dimperio 2026
(() => {
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const $ = id => document.getElementById(id);
  const form = $('loginForm'), msg = $('msg'), btn = $('emailBtn');

  function showMsg(text, isError = true) {
    msg.textContent = text;
    msg.hidden = !text;
    msg.style.borderColor = isError ? 'var(--danger)' : 'var(--done)';
  }
  function authMessage(code) {
    return ({
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/invalid-email': 'That email address doesn\u2019t look right.',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/too-many-requests': 'Too many attempts. Try again in a bit.',
      'auth/network-request-failed': 'Network problem. Check your connection.'
    })[code] || 'Could not log you in. Try again.';
  }

  $('pwToggle').addEventListener('click', () => {
    const i = $('loginPassword'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('pwToggle').textContent = show ? 'Hide' : 'Show';
    $('pwToggle').setAttribute('aria-pressed', String(show));
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    showMsg('');
    const email = $('loginEmail').value.trim(), pw = $('loginPassword').value;
    if (!email || !pw) return showMsg('Enter your email and password.');
    btn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(email, pw);
      location.href = 'index.html';
    } catch (ex) {
      showMsg(authMessage(ex.code));
      btn.disabled = false;
    }
  });

  $('forgotBtn').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    if (!email) return showMsg('Type your email above first, then tap Forgot password.');
    try {
      await auth.sendPasswordResetEmail(email);
      showMsg('Password reset email sent. Check your inbox.', false);
    } catch (ex) { showMsg(authMessage(ex.code)); }
  });
})();