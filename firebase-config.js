// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
// const firebaseConfig = {
//   apiKey: "AIzaSyCc1Xs2gFzJtALHu2NJkgQz4hbIH2qbGeU",
//   authDomain: "integrate-software.firebaseapp.com",
//   projectId: "integrate-software",
//   storageBucket: "integrate-software.firebasestorage.app",
//   messagingSenderId: "959476541983",
//   appId: "1:959476541983:web:26e9a5af914cfa013c032a",
//   measurementId: "G-37DJJ71KYC"
// };

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
 

// Initialize Firebase
const app = initializeApp(FIREBASE_CONFIG);
const analytics = getAnalytics(app);

