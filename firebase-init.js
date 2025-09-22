// Uzupełnij konfigurację poniżej danymi z konsoli Firebase → Ustawienia projektu → Konfiguracja SDK
// Ten plik jest modułem ES (type="module" w index.html)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

// WSTAW SWOJĄ KONFIGURACJĘ
export const firebaseConfig = {
  apiKey: 'AIzaSyD6AaAtiTqm8kATGZe5wjGLPhrmHzpORIs',
  authDomain: 'tomaga-database.firebaseapp.com',
  projectId: 'tomaga-database',
  storageBucket: 'tomaga-database.firebasestorage.app',
  messagingSenderId: '258082692204',
  appId: '1:258082692204:web:c3a3f66a32b8cbf9468c49',
  measurementId: 'G-CQMKK9P9BJ'
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);


