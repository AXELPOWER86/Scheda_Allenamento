// Incolla qui l'oggetto che Firebase ti mostra in:
// Impostazioni progetto > Generali > Le tue app > App web > "Configurazione SDK".
// NON e' un segreto: la sicurezza e' data dalle regole Firestore e dai domini autorizzati.
// Your web app's Firebase configuration

// Import the functions you need from the SDKs you need

import { initializeApp } from "firebase/app";

// TODO: Add SDKs for Firebase products that you want to use

// https://firebase.google.com/docs/web/setup#available-libraries


// Your web app's Firebase configuration

const firebaseConfig = {

  apiKey: "AIzaSyAm5cG4Ts94_P-mBwK2B2rIk6Y7ulhvZQQ",

  authDomain: "scheda-allenamento-204e7.firebaseapp.com",

  projectId: "scheda-allenamento-204e7",

  storageBucket: "scheda-allenamento-204e7.firebasestorage.app",

  messagingSenderId: "827874604830",

  appId: "1:827874604830:web:12f01c9c1a998c5a42fb0f"

};


// Initialize Firebase

const app = initializeApp(firebaseConfig);
