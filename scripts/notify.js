// ============================================================
// CamiloRey — notificaciones push (Web Push) desde GitHub Actions.
//
// 1. Entra a Firebase con la cuenta "bot" (BOT_EMAIL / BOT_PASSWORD). Las
//    reglas de Firestore le dejan LEER los usuarios y SOLO actualizar su
//    campo "push" (para borrar suscripciones vencidas).
// 2. Busca eventos en el estado: partido seguido que empezó, que terminó
//    (con resultado del pick) y pick destacado nuevo.
// 3. Manda la notificación a cada suscripción (web-push + llaves VAPID).
// Lo ya avisado queda en state.notified para no repetir.
// ============================================================

const FIREBASE_PROJECT = 'camilorey-1399c';
const FIREBASE_API_KEY = 'AIzaSyAjEK6Ca7_NEDiPMJv9iqwNLx1DY8WOog0';
const SITE = 'https://cash3y3-star.github.io/camilorey/';
const DOCS = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// Valor de Firestore (REST) → JS
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}
// JS → valor de Firestore (REST)
function toFs(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFs) } };
  if (typeof x === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toFs(v)])) } };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  return { stringValue: String(x) };
}

async function botToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.BOT_EMAIL, password: process.env.BOT_PASSWORD, returnSecureToken: true })
  });
  if (!r.ok) throw new Error(`login bot: HTTP ${r.status}`);
  return (await r.json()).idToken;
}

async function listUsers(token) {
  const users = [];
  let pageToken = '';
  do {
    const r = await fetch(`${DOCS}/users?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`leer usuarios: HTTP ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const f = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFs(v)]));
      users.push({ path: d.name, follows: f.follows || [], push: f.push || [], notify: f.notify || {} });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return users;
}

async function savePush(token, user, push) {
  await fetch(`https://firestore.googleapis.com/v1/${user.path}?updateMask.fieldPaths=push`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { push: toFs(push) } })
  });
}

// state: estado de update.js; helpers: { name(pid), featuredId }
async function runNotifications(state, helpers) {
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.BOT_EMAIL) return console.log('Push: sin llaves/bot configurados, se omite');
  let webpush;
  try {
    webpush = require('web-push');
  } catch {
    return console.log('Push: falta el paquete web-push');
  }
  webpush.setVapidDetails('mailto:lospeepff@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  // Primera vez: se marcan como avisados los partidos que ya empezaron o
  // terminaron, para no mandar de golpe notificaciones viejas.
  const firstRun = !state.notified || !Object.keys(state.notified).length;
  state.notified = state.notified || {};
  const N = state.notified;
  if (firstRun) {
    for (const [id, m] of Object.entries(state.matches)) {
      if (m.st === 'f') N[id] = { s: 1, f: 1 };
      else if (m.st === 'l' || new Date(m.at).getTime() <= Date.now()) N[id] = { s: 1 };
    }
    N._featured = helpers.featuredId || null;
    return console.log('Push: primera corrida, se marcan los eventos existentes sin enviar');
  }

  const token = await botToken();
  const users = (await listUsers(token)).filter((u) => u.push.length);
  if (!users.length) return console.log('Push: nadie suscrito todavía');

  // Eventos de partidos seguidos.
  const followed = new Set(users.flatMap((u) => u.follows.map(Number)));
  const events = []; // { mid?, kind, title, body, url, tag }
  const now = Date.now();
  for (const mid of followed) {
    const m = state.matches[mid];
    const p = state.picks[mid];
    if (!m || !p) continue;
    const key = String(mid);
    N[key] = N[key] || {};
    const label = `${helpers.name(m.a)} vs ${helpers.name(m.b)}`;
    const fav = helpers.name(p.fav);
    if (m.st === 'f' && !N[key].f) {
      const won = m.w === p.fav;
      events.push({ mid, kind: 'end', title: won ? `✅ ¡Pick acertado! ${fav}` : `❌ Pick fallado: ${fav}`, body: `${label} · ${m.sa}-${m.sb}`, url: `${SITE}#/seguidos`, tag: `m${mid}` });
      N[key].f = 1;
      N[key].s = 1;
    }
    // Por pedido: no se avisa cuando empieza el partido, solo el resultado.
  }
  // Pick destacado nuevo.
  if (helpers.featuredId && N._featured !== helpers.featuredId) {
    const p = state.picks[helpers.featuredId];
    const m = state.matches[helpers.featuredId];
    if (p && m) {
      events.push({ kind: 'featured', title: `⭐ Nuevo pick destacado: ${helpers.name(p.fav)}`, body: `${helpers.name(m.a)} vs ${helpers.name(m.b)} · ${p.c}% de confianza${p.o ? ` · cuota ${p.o.toFixed(2)}` : ''}`, url: SITE, tag: 'featured' });
    }
    N._featured = helpers.featuredId;
  }
  if (!events.length) return console.log('Push: sin eventos nuevos');

  let sent = 0;
  for (const u of users) {
    const prefs = { start: true, end: true, featured: true, ...u.notify };
    const mine = events.filter((e) => (e.kind === 'featured' ? prefs.featured : prefs[e.kind] && u.follows.map(Number).includes(e.mid)));
    if (!mine.length) continue;
    const alive = [];
    for (const sub of u.push) {
      let ok = true;
      for (const e of mine) {
        try {
          await webpush.sendNotification(sub, JSON.stringify(e), { TTL: 3600 });
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) ok = false; // suscripción vencida
        }
      }
      if (ok) alive.push(sub);
    }
    if (alive.length !== u.push.length) await savePush(token, u, alive);
  }
  // Limpia avisos viejos (partidos que ya no están en el estado).
  for (const k of Object.keys(N)) if (k !== '_featured' && !state.matches[k]) delete N[k];
  console.log(`Push: ${events.length} eventos, ${sent} notificaciones enviadas`);
}

module.exports = { runNotifications, botToken, toFs };
