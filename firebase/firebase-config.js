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
  const auth = getAuth(app);
  const googleProvider = new GoogleAuthProvider();