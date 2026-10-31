// ตัวเชื่อม Firebase SDK (แยกไฟล์ไว้เพื่อให้เปลี่ยนเวอร์ชันได้ที่เดียว)
const V = '12.0.0';
const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const authMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const fsMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
import { firebaseConfig } from './config.js';

export const app = appMod.initializeApp(firebaseConfig);
export const auth = authMod.getAuth(app);
export const db = fsMod.initializeFirestore(app, {
  localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
});

export const {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser
} = authMod;

export const {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, where, onSnapshot,
  writeBatch, runTransaction, serverTimestamp, increment, arrayUnion, documentId, Timestamp, deleteField
} = fsMod;
