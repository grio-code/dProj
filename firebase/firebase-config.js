  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyCc1Xs2gFzJtALHu2NJkgQz4hbIH2qbGeU",
    authDomain: "integrate-software.firebaseapp.com",
    projectId: "integrate-software",
    storageBucket: "integrate-software.firebasestorage.app",
    messagingSenderId: "959476541983",
    appId: "1:959476541983:web:cf1c68f584fc77c23c032a",
    measurementId: "G-YW9BXZ87YY"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);