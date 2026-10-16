// ============================================================
// Login (Google o correo) y contador de visitas con Firebase
// (plan Spark gratuito, sin tarjeta). Si FIREBASE_CONFIG es null todo
// esto queda apagado y el sitio funciona sin login.
//
// Firestore guarda:
//   stats/visits            { count }  visitas totales (1 por navegador por día)
//   stats/visits-AAAA-MM-DD { count }  visitas de ese día
//   stats/users             { count }  cuentas creadas
//   users/{uid}             { name, email, created, follows: [ids] }
// Las reglas de seguridad (FIRESTORE_RULES.txt) solo dejan sumar de a 1
// en los contadores y que cada usuario lea/escriba su propio documento.
// ============================================================

import { FIREBASE_CONFIG } from './config.js?v=__V__';

const V = '10.12.2';
let fb = null; // { auth, db, m: {módulos} }
let currentUser = null;
const authListeners = new Set();

export const enabled = Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);

async function load() {
  if (!enabled) return null;
  if (fb) return fb;
  const [app, auth, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
  ]);
  const instance = app.initializeApp(FIREBASE_CONFIG);
  const a = auth.getAuth(instance);
  a.languageCode = 'es';
  fb = { auth: a, db: fs.getFirestore(instance), A: auth, F: fs };
  auth.onAuthStateChanged(a, async (u) => {
    currentUser = u;
    if (u) await ensureUserDoc(u).catch(() => {});
    authListeners.forEach((fn) => fn(u));
  });
  return fb;
}

export function onAuth(fn) {
  authListeners.add(fn);
  fn(currentUser);
  load().catch(() => {});
  return () => authListeners.delete(fn);
}

export function user() {
  return currentUser;
}

function bogotaDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// Suma 1 visita por navegador por día (no por recarga).
export async function countVisit() {
  if (!enabled) return;
  const day = bogotaDay();
  try {
    if (localStorage.getItem('cr_visit') === day) return;
  } catch (e) {}
  const f = await load();
  const { doc, setDoc, increment } = f.F;
  await Promise.all([
    setDoc(doc(f.db, 'stats', 'visits'), { count: increment(1) }, { merge: true }),
    setDoc(doc(f.db, 'stats', `visits-${day}`), { count: increment(1) }, { merge: true })
  ]);
  try {
    localStorage.setItem('cr_visit', day);
  } catch (e) {}
}

export async function getCounters() {
  if (!enabled) return null;
  const f = await load();
  const { doc, getDoc } = f.F;
  const [t, d] = await Promise.all([getDoc(doc(f.db, 'stats', 'visits')), getDoc(doc(f.db, 'stats', `visits-${bogotaDay()}`))]);
  // El número de usuarios ya no sale de un contador (sumaba de más): lo
  // cuenta GitHub Actions con las cuentas reales y viene en stats.json.
  return { total: t.data()?.count || 0, today: d.data()?.count || 0 };
}

async function ensureUserDoc(u) {
  const f = await load();
  const { doc, getDoc, setDoc } = f.F;
  const ref = doc(f.db, 'users', u.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { name: u.displayName || '', email: u.email || '', created: new Date().toISOString(), follows: [] });
  } else if (!snap.data().email && u.email) {
    // El correo se usa para Premium y notificaciones: que nunca falte.
    await setDoc(ref, { email: u.email, created: snap.data().created || new Date().toISOString() }, { merge: true });
  }
}

// Perfil editable (nombre y foto). La foto se guarda como imagen pequeña
// (data URL JPEG ~15 KB) dentro de users/{uid}: Firebase Storage exige
// plan de pago, Firestore no.
export async function loadProfile() {
  if (!currentUser) return null;
  const f = await load();
  const snap = await f.F.getDoc(f.F.doc(f.db, 'users', currentUser.uid));
  const d = snap.data() || {};
  return { name: d.name || currentUser.displayName || '', photo: d.photo || null, bank: d.bank || null };
}

export async function saveProfile({ name, photo }) {
  if (!currentUser) return;
  const f = await load();
  const patch = {};
  if (name != null) {
    patch.name = name;
    await f.A.updateProfile(currentUser, { displayName: name });
  }
  if (photo !== undefined) patch.photo = photo;
  await f.F.setDoc(f.F.doc(f.db, 'users', currentUser.uid), patch, { merge: true });
}

// Historial de apuestas (solo admin: las reglas de Firestore rechazan a
// cualquier otra cuenta). Lo escribe GitHub Actions en admin/ledger.
export async function loadAdminLedger() {
  const f = await load();
  const snap = await f.F.getDoc(f.F.doc(f.db, 'admin', 'ledger'));
  if (!snap.exists()) return { updatedAt: null, summary: null, rows: [] };
  const d = snap.data();
  const parsed = JSON.parse(d.data || '[]');
  // Formato actual { summary, ledger }; el primero era solo la lista.
  return Array.isArray(parsed)
    ? { updatedAt: d.updatedAt, summary: null, rows: parsed }
    : { updatedAt: d.updatedAt, summary: parsed.summary || null, rows: parsed.ledger || [] };
}

// ---------- Notificaciones push ----------
// users/{uid}.push = [suscripciones del navegador], .notify = { start, end, featured }
export async function loadPushState() {
  if (!currentUser) return null;
  const f = await load();
  const d = (await f.F.getDoc(f.F.doc(f.db, 'users', currentUser.uid))).data() || {};
  return { push: d.push || [], notify: { start: true, end: true, featured: true, ...(d.notify || {}) } };
}

export async function savePushState({ push, notify }) {
  if (!currentUser) return;
  const f = await load();
  const patch = {};
  if (push) patch.push = push;
  if (notify) patch.notify = notify;
  await f.F.setDoc(f.F.doc(f.db, 'users', currentUser.uid), patch, { merge: true });
}

// ---------- Membresía Premium ----------
// members/{correo en minúsculas} = { until: Timestamp, days, updatedAt }.
// Se asocia al CORREO, así funciona entre con Google o con correo/clave.
const emailKey = (e) => String(e || '').trim().toLowerCase();

export async function loadMembership() {
  if (!currentUser?.email) return null;
  const f = await load();
  const snap = await f.F.getDoc(f.F.doc(f.db, 'members', emailKey(currentUser.email)));
  if (!snap.exists()) return null;
  const until = snap.data().until?.toDate?.() || null;
  return until ? { until, active: until.getTime() > Date.now() } : null;
}

// Pick completo de los picks Premium y Análisis IA (solo Premium por reglas).
export async function loadPremiumContent() {
  const f = await load();
  const snap = await f.F.getDoc(f.F.doc(f.db, 'premium', 'content'));
  return snap.exists() ? JSON.parse(snap.data().data || '{}') : null;
}

export async function adminListMembers() {
  const f = await load();
  const snap = await f.F.getDocs(f.F.collection(f.db, 'members'));
  return snap.docs.map((d) => ({ email: d.id, until: d.data().until?.toDate?.() || null, days: d.data().days || null }));
}

// Activa o extiende: suma los días desde hoy o desde que vence, lo que sea más tarde.
export async function adminSetMember(email, days) {
  const f = await load();
  const ref = f.F.doc(f.db, 'members', emailKey(email));
  const cur = (await f.F.getDoc(ref)).data()?.until?.toDate?.();
  const base = cur && cur.getTime() > Date.now() ? cur.getTime() : Date.now();
  const until = new Date(base + days * 86400e3);
  await f.F.setDoc(ref, { until: f.F.Timestamp.fromDate(until), days, updatedAt: new Date().toISOString() });
  return until;
}

export async function adminRemoveMember(email) {
  const f = await load();
  await f.F.deleteDoc(f.F.doc(f.db, 'members', emailKey(email)));
}

// ---------- Panel admin ----------

// Picks del tipster: colección pública "tipster" (las reglas solo dejan
// escribir a la cuenta admin). Id del documento = id del partido.
export async function listTipster() {
  const f = await load();
  const snap = await f.F.getDocs(f.F.collection(f.db, 'tipster'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveTipster(pick) {
  const f = await load();
  await f.F.setDoc(f.F.doc(f.db, 'tipster', String(pick.mid)), { ...pick, created: new Date().toISOString() });
}

export async function deleteTipster(id) {
  const f = await load();
  await f.F.deleteDoc(f.F.doc(f.db, 'tipster', String(id)));
}

// Usuarios registrados (solo admin puede leerlos, por reglas).
export async function listUsers() {
  const f = await load();
  const snap = await f.F.getDocs(f.F.collection(f.db, 'users'));
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, name: x.name || '', email: x.email || '', created: x.created || null, push: Array.isArray(x.push) ? x.push.length : 0, follows: (x.follows || []).length };
  });
}

// Visitas por día de los últimos n días (documentos stats/visits-AAAA-MM-DD).
export async function visitsByDay(n = 14) {
  const f = await load();
  const days = [];
  for (let k = n - 1; k >= 0; k--) {
    days.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(Date.now() - k * 86400e3)));
  }
  const snaps = await Promise.all(days.map((d) => f.F.getDoc(f.F.doc(f.db, 'stats', `visits-${d}`))));
  return days.map((d, i) => ({ d, count: snaps[i].data()?.count || 0 }));
}

// Configuración del "Mi Bankroll" (Kelly) de cada usuario: { start, risk }.
export async function saveBankSettings(bank) {
  if (!currentUser) return;
  const f = await load();
  await f.F.setDoc(f.F.doc(f.db, 'users', currentUser.uid), { bank }, { merge: true });
}

export async function loadFollows() {
  if (!currentUser) return null;
  const f = await load();
  const snap = await f.F.getDoc(f.F.doc(f.db, 'users', currentUser.uid));
  return snap.data()?.follows || [];
}

export async function saveFollows(ids) {
  if (!currentUser) return;
  const f = await load();
  await f.F.setDoc(f.F.doc(f.db, 'users', currentUser.uid), { follows: ids.slice(-300) }, { merge: true });
}

// ---------------- acciones de cuenta ----------------

const ERRORS = {
  'auth/invalid-email': 'El correo no es válido.',
  'auth/missing-password': 'Escribe tu contraseña.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/wrong-password': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
  'auth/popup-closed-by-user': 'Cerraste la ventana de Google antes de terminar.',
  'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet.'
};
export function errorText(e) {
  return ERRORS[e?.code] || e?.message || 'Algo salió mal.';
}

export async function loginGoogle() {
  const f = await load();
  const provider = new f.A.GoogleAuthProvider();
  try {
    await f.A.signInWithPopup(f.auth, provider);
  } catch (e) {
    // Navegadores que bloquean ventanas emergentes (algunos móviles).
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await f.A.signInWithRedirect(f.auth, provider);
    } else throw e;
  }
}

export async function loginEmail(email, password) {
  const f = await load();
  await f.A.signInWithEmailAndPassword(f.auth, email, password);
}

export async function registerEmail(name, email, password) {
  const f = await load();
  const cred = await f.A.createUserWithEmailAndPassword(f.auth, email, password);
  if (name) await f.A.updateProfile(cred.user, { displayName: name });
  await ensureUserDoc({ ...cred.user, displayName: name });
  authListeners.forEach((fn) => fn(f.auth.currentUser));
}

export async function resetPassword(email) {
  const f = await load();
  await f.A.sendPasswordResetEmail(f.auth, email);
}

export async function logout() {
  const f = await load();
  await f.A.signOut(f.auth);
}

export async function deleteAccount() {
  const f = await load();
  const u = f.auth.currentUser;
  if (!u) return;
  await f.F.deleteDoc(f.F.doc(f.db, 'users', u.uid)).catch(() => {});
  await f.A.deleteUser(u);
}
