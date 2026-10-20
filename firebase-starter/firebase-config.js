// Firebase settings for Integrate Software (project: integrate-software).
// This is the plain-script version of the config. The "import ... from 'firebase/app'" version Firebase shows
// only works with a build tool (npm), and this app loads Firebase with <script> tags in allLists.html instead.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCc1Xs2gFzJtALHu2NJkgQz4hbIH2qbGeU",
  authDomain: "integrate-software.firebaseapp.com",
  projectId: "integrate-software",
  storageBucket: "integrate-software.firebasestorage.app",
  messagingSenderId: "959476541983",
  appId: "1:959476541983:web:26e9a5af914cfa013c032a",
  measurementId: "G-37DJJ71KYC"
};
 
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const app = initializeApp({ /* your existing firebaseConfig */ });
export const auth = getAuth(app);