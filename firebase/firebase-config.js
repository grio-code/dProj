
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCc1Xs2gFzJtALHu2NJkgQz4hbIH2qbGeU",
  authDomain: "integrate-software.firebaseapp.com",
  projectId: "integrate-software",
  storageBucket: "integrate-software.firebasestorage.app",
  messagingSenderId: "959476541983",
  appId: "1:959476541983:web:cf1c68f584fc77c23c032a",
  measurementId: "G-YW9BXZ87YY"};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();