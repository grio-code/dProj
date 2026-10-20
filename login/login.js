// ================= SETTINGS =================
// Where to go after signing in. A ?next=/some/page in the address bar wins (only same-site paths are accepted).
const DEFAULT_AFTER_LOGIN = "/lists/allLists.html";
function afterLogin() {
  const n = new URLSearchParams(location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : DEFAULT_AFTER_LOGIN;
}

// ================= ELEMENTS =================
const btn = document.getElementById("googleBtn");
const label = document.getElementById("googleLabel");
const msg = document.getElementById("msg");

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("loginEmail");
const passEl = document.getElementById("loginPassword");
const emailBtn = document.getElementById("emailBtn");
const forgotBtn = document.getElementById("forgotBtn");
const pwToggle = document.getElementById("pwToggle");

function showMsg(text) { msg.textContent = text; msg.hidden = !text; }
// Disables both sign-in buttons while something is in progress; "which" decides which one shows the working label
function busy(on, which = "google") {
  btn.disabled = on;
  emailBtn.disabled = on;
  label.textContent = on && which === "google" ? "Signing in…" : "Continue with Google";
  emailBtn.textContent = on && which === "email" ? "Logging in…" : "Log in";
}

// Show / hide the password while typing
pwToggle.addEventListener("click", () => {
  const show = passEl.type === "password";
  passEl.type = show ? "text" : "password";
  pwToggle.textContent = show ? "Hide" : "Show";
  pwToggle.setAttribute("aria-pressed", String(show));
});

// Keep the content below the fixed top bar (same helper as the other pages)
function setNavH() {
  const n = document.getElementById("fnav");
  if (n) document.documentElement.style.setProperty("--nav-h", n.offsetHeight + "px");
}
setNavH();
window.addEventListener("resize", setNavH);
window.addEventListener("load", setNavH);

// ================= FIREBASE AUTH =================
const cfg = window.FIREBASE_CONFIG || {};
let auth = null;
if (window.firebase && cfg.apiKey && !/PASTE/.test(cfg.apiKey)) {
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    auth = firebase.auth();
  } catch (e) { auth = null; }
}

if (!auth) {
  document.getElementById("offlineBanner").hidden = false;
  btn.disabled = true;
  emailBtn.disabled = true;
  forgotBtn.disabled = true;
  emailEl.disabled = true;
  passEl.disabled = true;
} else {
  // Manual login with email and password
  form.addEventListener("submit", async e => {
    e.preventDefault();
    showMsg("");
    const email = emailEl.value.trim(), pass = passEl.value;
    if (!email) { showMsg("Enter your email address."); emailEl.focus(); return; }
    if (!pass) { showMsg("Enter your password."); passEl.focus(); return; }
    busy(true, "email");
    try {
      await auth.signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged below takes it from here
    } catch (err) {
      showMsg(friendly(err));
      busy(false);
      passEl.focus();
    }
  });

  // Send a password reset email to whatever address is typed in the Email box
  forgotBtn.addEventListener("click", async () => {
    showMsg("");
    const email = emailEl.value.trim();
    if (!email) { showMsg("Type your email above first, then tap Forgot password."); emailEl.focus(); return; }
    try {
      await auth.sendPasswordResetEmail(email);
      showMsg("If an account exists for " + email + ", a reset link is on its way. Check your spam folder too.");
    } catch (err) {
      showMsg(friendly(err));
    }
  });

  // Already signed in (or just came back from a redirect sign-in): skip the page
  auth.onAuthStateChanged(user => { if (user) location.replace(afterLogin()); });

  // If the redirect flow was used, this reports a failure when the person lands back here
  auth.getRedirectResult().catch(e => showMsg(friendly(e)));

  btn.addEventListener("click", async () => {
    showMsg("");
    busy(true);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" }); // always let the person pick the account
    try {
      // Popups don't work inside an iPhone home-screen app, so use a full-page redirect there
      if (navigator.standalone) { await auth.signInWithRedirect(provider); return; }
      await auth.signInWithPopup(provider);
      // onAuthStateChanged above takes it from here
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        try { await auth.signInWithRedirect(provider); return; } catch (e2) { e = e2; }
      }
      showMsg(friendly(e));
      busy(false);
    }
  });
}

// Turn Firebase error codes into plain messages
function friendly(e) {
  switch (e && e.code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return "Sign-in was cancelled. Tap the button to try again.";
    case "auth/network-request-failed": return "Couldn't reach Google. Check your connection and try again.";
    case "auth/unauthorized-domain": return "This site's address isn't approved for sign-in yet. Add it under Authentication › Settings › Authorized domains in the Firebase console.";
    case "auth/operation-not-allowed": return "This sign-in method is turned off. Turn it on under Authentication › Sign-in method in the Firebase console.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "That email and password don't match. Check them and try again.";
    case "auth/invalid-email": return "That doesn't look like a valid email address.";
    case "auth/missing-password": return "Enter your password.";
    case "auth/user-disabled": return "This account has been disabled.";
    case "auth/too-many-requests": return "Too many attempts. Wait a few minutes, or use Forgot password.";
    default: return "Couldn't sign in. Please try again.";
  }
}

 // Keep the page content clear of the fixed top bar
function setNavH() {
  const n = document.getElementById("fnav");
  if (n) document.documentElement.style.setProperty("--nav-h", n.offsetHeight + "px");
}
setNavH();
window.addEventListener("resize", setNavH);
window.addEventListener("load", setNavH);