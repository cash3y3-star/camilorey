// ============================================================
// Configuración del sitio.
//
// FIREBASE_CONFIG: pegá acá el objeto "firebaseConfig" que te da
// Firebase (Configuración del proyecto → Tus apps → Web). Mientras
// sea null, el login y el contador de visitas quedan desactivados y
// el resto del sitio funciona igual.
// ============================================================

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAjEK6Ca7_NEDiPMJv9iqwNLx1DY8WOog0',
  authDomain: 'camilorey-1399c.firebaseapp.com',
  projectId: 'camilorey-1399c',
  storageBucket: 'camilorey-1399c.firebasestorage.app',
  messagingSenderId: '130311419366',
  appId: '1:130311419366:web:67f92d4a870d9425aed227'
};

// Llave pública VAPID para las notificaciones push (la privada está como
// secreto en GitHub Actions).
export const VAPID_PUBLIC_KEY = 'BC4ijSXVGAin17xn3kLYtpYgUR1Hhy7AApRvjcXIsfwQd36uFw8__LL2TbpBdSezM380neDfWznGrjLGA9r799c';

// Link del canal de Telegram (opcional). Ej: 'https://t.me/micanal'
export const TELEGRAM_URL = null;

// Cuenta administradora: la única que ve el historial de apuestas.
// (La protección real está en las reglas de Firestore, no acá.)
export const ADMIN_EMAIL = 'camilosimanca77@gmail.com';

// Correo de contacto que se muestra en Ayuda.
export const SUPPORT_EMAIL = 'lospeepff@gmail.com';
