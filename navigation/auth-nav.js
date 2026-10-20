// /* auth-nav.js
//    Shows the bottom dock (.dock) only while a user is signed in.

//    How it works:
//    1. The moment this file runs, it injects a style that hides the dock, so a signed-out
//       visitor never sees it flash on screen.
//    2. Once the page has loaded, it asks Firebase Auth who is signed in and removes that
//       style when someone is. If the person logs out, the style comes back and the dock hides again.
//    3. If Firebase can't be reached or isn't configured, the dock stays hidden.

//    Add this to the <head> of every page that has the dock (home, allLists, dailyLog, newList):
//      <script src="/navigation/auth-nav.js"></script>
//    Put it as a plain script tag (no "defer") so the dock is hidden before the first paint. */
// (function () {
//   // Path to the file that sets window.FIREBASE_CONFIG. Change it if yours lives somewhere else.
//   var CONFIG_SRC = "/firebase/firebase-config.js";
//   var FIREBASE_VERSION = "10.12.2"; // same version the other pages use
//   var BASE = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";

//   // 1. Hide the dock right away
//   var gate = document.createElement("style");
//   gate.id = "dock-auth-gate";
//   gate.textContent = ".dock{display:none!important}";
//   document.head.appendChild(gate);

//   function showDock() {
//     if (gate.parentNode) gate.parentNode.removeChild(gate);
//   }
//   function hideDock() {
//     if (!gate.parentNode) document.head.appendChild(gate);
//   }

//   function loadScript(src) {
//     return new Promise(function (resolve, reject) {
//       var s = document.createElement("script");
//       s.src = src;
//       s.onload = resolve;
//       s.onerror = function () { reject(new Error("Couldn't load " + src)); };
//       document.head.appendChild(s);
//     });
//   }

//   // Load only the pieces the page hasn't already loaded itself
//   function ensureFirebase() {
//     var p = Promise.resolve();
//     if (!window.firebase) p = p.then(function () { return loadScript(BASE + "firebase-app-compat.js"); });
//     p = p.then(function () {
//       if (!firebase.auth) return loadScript(BASE + "firebase-auth-compat.js");
//     });
//     p = p.then(function () {
//       if (!window.FIREBASE_CONFIG) return loadScript(CONFIG_SRC);
//     });
//     return p;
//   }

//   // 2. Watch the sign-in state
//   function start() {
//     ensureFirebase().then(function () {
//       var cfg = window.FIREBASE_CONFIG || {};
//       if (!cfg.apiKey || /PASTE/.test(cfg.apiKey)) {
//         console.warn("auth-nav: Firebase isn't configured, so the dock stays hidden.");
//         return;
//       }
//       if (!firebase.apps.length) firebase.initializeApp(cfg);
//       firebase.auth().onAuthStateChanged(function (user) {
//         if (user) showDock(); else hideDock();
//       });
//     }).catch(function (err) {
//       console.warn("auth-nav:", err.message || err);
//     });
//   }

//   // Wait until the page's own scripts have run, so Firebase isn't loaded twice
//   if (document.readyState === "complete") start();
//   else window.addEventListener("load", start);
// })();