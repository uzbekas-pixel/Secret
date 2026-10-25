// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAfv7LpUR8JRjdM3tgDwH7Js5pOJ_eCKQ8",
  authDomain: "our-secret-dde53.firebaseapp.com",
  projectId: "our-secret-dde53",
  storageBucket: "our-secret-dde53.firebasestorage.app",
  messagingSenderId: "1026368032462",
  appId: "1:1026368032462:web:f113c28910bf93b03b0a9f",
  measurementId: "G-BE0KK31976"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const db = getFirestore(app);
export const storage = getStorage(app);
export { app, analytics };