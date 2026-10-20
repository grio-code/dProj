import { auth, db } from "./firebase.js";
import { createUserWithEmailAndPassword, updateProfile, deleteUser }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"; 

(() => {
  // ---------- Settings you may want to change ----------
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;                       // 2 MB
  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // SVG is left out on purpose: it can carry scripts
  const MIN_PASSWORD = 8;
  const AFTER_SIGNUP_URL = 'index.html';                  // where to go once the account is created

  // ---------- Grab the page elements ----------
  const $ = id => document.getElementById(id);
  const form = $('signupForm'), msg = $('msg'), btn = $('signupBtn');
  const f = {
    name: $('suName'), phone: $('suPhone'), email: $('suEmail'), company: $('suCompany'),
    logo: $('suLogo'), password: $('suPassword'), confirm: $('suConfirm')
  };
  const err = {
    name: $('suNameErr'), phone: $('suPhoneErr'), email: $('suEmailErr'), company: $('suCompanyErr'),
    logo: $('suLogoErr'), password: $('suPasswordErr'), confirm: $('suConfirmErr')
  };

  // ---------- Small helpers ----------
  const digitsOnly = s => s.replace(/\D/g, '');

  function setError(key, text) {
    err[key].textContent = text || '';
    // The file input is hidden, so there is nothing to outline for the logo
    if (key !== 'logo') f[key].setAttribute('aria-invalid', text ? 'true' : 'false');
    if (!text && key !== 'logo') f[key].removeAttribute('aria-invalid');
  }
  function showMsg(text, isError = true) {
    msg.textContent = text;
    msg.hidden = !text;
    msg.style.borderColor = isError ? 'var(--danger)' : 'var(--done)';
  }

  // ---------- Show / hide password (both password fields) ----------
  document.querySelectorAll('.pw-toggle').forEach(t => t.addEventListener('click', () => {
    const input = $(t.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    t.textContent = show ? 'Hide' : 'Show';
    t.setAttribute('aria-pressed', String(show));
  }));

  // ---------- Phone: format as (555) 123-4567 while typing ----------
  f.phone.addEventListener('input', () => {
    const d = digitsOnly(f.phone.value);
    // Keep a leading + for international numbers and leave those unformatted
    if (f.phone.value.trim().startsWith('+')) { f.phone.value = '+' + d.slice(0, 15); return; }
    const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6, 10);
    f.phone.value = d.length > 6 ? `(${a}) ${b}-${c}` : d.length > 3 ? `(${a}) ${b}` : d.length ? `(${a}` : '';
  });

  // ---------- Password strength bar ----------
  function strength(p) {
    let s = 0;
    if (p.length >= MIN_PASSWORD) s++;
    if (/[a-z]/i.test(p) && /\d/.test(p)) s++;
    if (p.length >= 12 || /[^A-Za-z0-9]/.test(p)) s++;
    return p ? Math.max(s, 1) : 0;
  }
  f.password.addEventListener('input', () => {
    $('pwMeter').dataset.level = strength(f.password.value);
    $('pwMeter').firstElementChild.style.width = (strength(f.password.value) * 33.4) + '%';
    if (f.confirm.value) validators.confirm();   // keep the match check fresh
  });

  // ---------- Logo upload: pick or drop, check, preview ----------
  const drop = $('logoDrop'), preview = $('logoPreview'), nameEl = $('logoName'), removeBtn = $('logoRemove');
  let previewUrl = null;

  function clearLogo() {
    f.logo.value = '';
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    preview.textContent = 'No logo';
    nameEl.textContent = 'Choose or drop an image';
    removeBtn.hidden = true;
    setError('logo', '');
  }
  function acceptLogo(file) {
    if (!file) return clearLogo();
    if (!LOGO_TYPES.includes(file.type)) { clearLogo(); return setError('logo', 'Use a PNG, JPG or WebP image.'); }
    if (file.size > MAX_LOGO_BYTES) { clearLogo(); return setError('logo', 'That image is over 2 MB. Choose a smaller one.'); }
    setError('logo', '');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.textContent = '';
    const img = new Image();
    img.src = previewUrl;
    img.alt = 'Logo preview';
    preview.appendChild(img);
    nameEl.textContent = file.name;
    removeBtn.hidden = false;
  }
  f.logo.addEventListener('change', () => acceptLogo(f.logo.files[0]));
  removeBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); clearLogo(); });

  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const dt = new DataTransfer();          // put the dropped file into the real input so it submits with the form
    dt.items.add(file);
    f.logo.files = dt.files;
    acceptLogo(file);
  });

  // ---------- Validation: each returns true when the field is OK ----------
  const validators = {
    name() {
      const v = f.name.value.trim();
      if (!v) return setError('name', 'Enter your full name.'), false;
      setError('name'); return true;
    },
    phone() {
      const d = digitsOnly(f.phone.value);
      if (!d) return setError('phone', 'Enter your phone number.'), false;
      if (d.length < 10 || d.length > 15) return setError('phone', 'Enter a phone number with at least 10 digits.'), false;
      setError('phone'); return true;
    },
    email() {
      const v = f.email.value.trim();
      if (!v) return setError('email', 'Enter your email address.'), false;
      if (!f.email.checkValidity()) return setError('email', 'Enter a valid email, like you@example.com.'), false;
      setError('email'); return true;
    },
    company() {
      const v = f.company.value.trim();
      if (!v) return setError('company', 'Enter your company name.'), false;
      setError('company'); return true;
    },
    logo() {
      // The logo is optional. If a file is chosen it was already checked in acceptLogo().
      return !err.logo.textContent;
    },
    password() {
      const p = f.password.value;
      if (!p) return setError('password', 'Create a password.'), false;
      if (p.length < MIN_PASSWORD) return setError('password', `Use at least ${MIN_PASSWORD} characters.`), false;
      if (!/[a-z]/i.test(p) || !/\d/.test(p)) return setError('password', 'Include at least one letter and one number.'), false;
      setError('password'); return true;
    },
    confirm() {
      if (!f.confirm.value) return setError('confirm', 'Type your password again.'), false;
      if (f.confirm.value !== f.password.value) return setError('confirm', 'The passwords don\u2019t match.'), false;
      setError('confirm'); return true;
    }
  };
  // Check a field when the person leaves it, and clear its error as they fix it
  Object.keys(validators).forEach(k => {
    if (k === 'logo') return;
    f[k].addEventListener('blur', validators[k]);
    f[k].addEventListener('input', () => { if (f[k].getAttribute('aria-invalid') === 'true') validators[k](); });
  });

  // ---------- Build the data to send ----------
  function buildPayload() {
    const data = new FormData();
    data.append('name', f.name.value.trim());
    data.append('phone', digitsOnly(f.phone.value));   // digits only, e.g. 5551234567
    data.append('email', f.email.value.trim().toLowerCase());
    data.append('company', f.company.value.trim());
    if (f.logo.files[0]) data.append('logo', f.logo.files[0]);
    data.append('password', f.password.value);
    return data;
  }

  // ---------- THE ONE PLACE TO CONNECT A BACKEND ----------
  // Replace the body of this function with your real sign-up call. It receives the FormData above and
  // must return a Promise: resolve when the account is created, or throw an Error with a message to show the person.
  // Example for a plain server endpoint:
  //   const res = await fetch('/api/signup', { method: 'POST', body: data });
  //   if (!res.ok) throw new Error((await res.json()).message || 'Could not create your account.');
  // Never log or store the password in the browser.
   // Shrinks the logo to 256px so it fits comfortably in a Firestore document (1 MB limit)
  async function shrinkLogo(file, max = 256) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.85);
  }

  function authMessage(code) {
    return ({
      'auth/email-already-in-use': 'An account with that email already exists. Try logging in.',
      'auth/invalid-email': 'That email address doesn\u2019t look right.',
      'auth/weak-password': 'Choose a stronger password.',
      'auth/network-request-failed': 'Network problem. Check your connection and try again.',
      'auth/too-many-requests': 'Too many attempts. Try again in a bit.'
    })[code] || 'Could not create your account. Try again.';
  }

  async function createAccount(data) {
    const email = data.get('email'), password = data.get('password');
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      throw new Error(authMessage(e.code));
    }
    try {
      await updateProfile(cred.user, { displayName: data.get('name') });
      const logoFile = data.get('logo');
      const logo = logoFile instanceof File ? await shrinkLogo(logoFile) : null;
      await setDoc(doc(db, 'users', cred.user.uid, 'profile', 'info'), {
        name: data.get('name'),
        phone: data.get('phone'),
        company: data.get('company'),
        logo,
        createdAt: serverTimestamp()
      });
    } catch (e) {
      console.error(e);
      await deleteUser(cred.user).catch(() => {});   // roll back so they can retry with the same email
      throw new Error('We couldn\u2019t save your profile. Please try again.');
    }
  }

  // ---------- Submit ----------
  form.addEventListener('submit', async e => {
    e.preventDefault();       // stop the page from reloading and putting the password in the address bar
    showMsg('');
    const results = Object.keys(validators).map(k => [k, validators[k]()]);
    const firstBad = results.find(([, ok]) => !ok);
    if (firstBad) {
      const el = firstBad[0] === 'logo' ? drop : f[firstBad[0]];
      (el.focus ? el : drop).focus?.();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Creating account\u2026';
    try {
      await createAccount(buildPayload());
      showMsg('Account created. Taking you in\u2026', false);      
      setTimeout(() => { location.href = AFTER_SIGNUP_URL; }, 900);
    } catch (ex) {
      showMsg(ex.message || 'Could not create your account. Try again.');
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();