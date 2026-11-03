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
      users.push({ path: d.name, email: String(f.email || '').toLowerCase(), follows: f.follows || [], push: f.push || [], notify: f.notify || {} });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return users;
}

// Solo los usuarios que siguen alguno de estos partidos (consulta, no toda la
// colección: cada documento leído gasta cuota gratis de Firestore).
async function usersFollowing(token, mids) {
  const users = new Map();
  const vals = [...new Set(mids.map(Number))];
  for (let i = 0; i < vals.length; i += 15) {
    const part = vals.slice(i, i + 15);
    const values = part.flatMap((id) => [{ integerValue: String(id) }, { stringValue: String(id) }]); // por si alguno quedó guardado como texto
    const r = await fetch(`${DOCS}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: { field: { fieldPath: 'follows' }, op: 'ARRAY_CONTAINS_ANY', value: { arrayValue: { values } } } } } })
    });
    if (!r.ok) throw new Error(`buscar seguidores: HTTP ${r.status}`);
    for (const { document: d } of await r.json()) {
      if (!d) continue;
      const f = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFs(v)]));
      users.set(d.name, { path: d.name, email: String(f.email || '').toLowerCase(), follows: f.follows || [], push: f.push || [], notify: f.notify || {} });
    }
  }
  return [...users.values()];
}

async function activeMembers(token) {
  const out = new Set();
  const r = await fetch(`${DOCS}/members?pageSize=300`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return out;
  const now = Date.now();
  for (const d of (await r.json()).documents || []) {
    const until = d.fields?.until?.timestampValue || d.fields?.until?.stringValue;
    if (until && new Date(until).getTime() > now) out.add(decodeURIComponent(d.name.split('/').pop()).toLowerCase());
  }
  return out;
}

// Correos con la prueba gratis de 24 h vigente (colección "trials", id =
// correo, { at }). Entran al sitio pero no son Premium: reciben push, pero
// sin revelar los picks de 60% o más.
const TRIAL_MS = 24 * 3600e3;
async function activeTrials(token) {
  const out = new Set();
  const now = Date.now();
  let pageToken = '';
  do {
    const r = await fetch(`${DOCS}/trials?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return out; // sin reglas publicadas todavía: nadie en prueba
    const j = await r.json();
    for (const d of j.documents || []) {
      const at = d.fields?.at?.timestampValue;
      if (at && new Date(at).getTime() + TRIAL_MS > now) out.add(decodeURIComponent(d.name.split('/').pop()).toLowerCase());
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Picks del tipster publicados (colección "tipster"). Sin permiso o sin
// respuesta devuelve null, para no confundirlo con "no hay picks".
async function listTips(token) {
  const r = await fetch(`${DOCS}/tipster?pageSize=1000`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return ((await r.json()).documents || []).map((d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFs(v)])));
}

async function savePush(token, user, push) {
  await fetch(`https://firestore.googleapis.com/v1/${user.path}?updateMask.fieldPaths=push`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { push: toFs(push) } })
  });
}

// state: estado de update.js; helpers: { name(pid), featuredIds: [ids] }
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
    N._featured = helpers.featuredIds || [];
    return console.log('Push: primera corrida, se marcan los eventos existentes sin enviar');
  }

  const token = await botToken();
  const ADMIN = 'camilosimanca77@gmail.com';
  const locked = (id) => Boolean(helpers.isLocked?.(state.picks[id]));
  const now = Date.now();
  // Ahorro de cuota de Firestore: antes se leían TODOS los usuarios, miembros
  // y pruebas cada 5 min aunque no hubiera nada que avisar, y la cuota gratis
  // diaria se agotaba (HTTP 429): desde ahí no salía ningún aviso. Ahora
  // primero se buscan los eventos y solo se leen los usuarios necesarios.
  const events = []; // { mid?, kind, title, body, url, tag }

  // Partidos que terminaron y aún no se revisaron. Los de hace más de 6 h se
  // marcan sin avisar (no se manda un resultado viejo).
  const finCand = [];
  for (const [id, m] of Object.entries(state.matches)) {
    if (m.st !== 'f' || !state.picks[id] || N[id]?.f) continue;
    if (new Date(m.at).getTime() < now - 6 * 3600e3) N[id] = { ...N[id], s: 1, f: 1 };
    else finCand.push(Number(id));
  }
  // Picks que cambiaron de jugador al revisarlos antes de empezar.
  const chgCand = Object.values(state.picks).filter((p) => {
    const m = state.matches[p.id];
    return p.chg && p.res === 'pending' && m && m.st === 's' && (N[String(p.id)]?.c || 0) < p.chg;
  });
  const isFt = (id) => (helpers.featuredIds || []).includes(id);

  // Picks destacados nuevos (uno por cada destacado que entra).
  const ftSent = new Set(Array.isArray(N._featured) ? N._featured : N._featured ? [N._featured] : []);
  for (const fid of helpers.featuredIds || []) {
    if (ftSent.has(fid)) continue;
    const p = state.picks[fid];
    const m = state.matches[fid];
    if (p && m) {
      events.push({ kind: 'featured', lk: locked(p.id), title: `⭐ Nuevo pick destacado: ${helpers.name(p.fav)}`, body: `${helpers.name(m.a)} vs ${helpers.name(m.b)} · ${p.c}% de confianza${p.o ? ` · cuota ${p.o.toFixed(2)}` : ''}`, url: SITE, tag: `featured-${p.id}`, teaser: { kind: 'featured', title: '⭐ Nuevo pick destacado Premium', body: `${helpers.name(m.a)} vs ${helpers.name(m.b)} · ${p.c}% de confianza · hazte Premium para ver a quién elige`, url: `${SITE}#/premium`, tag: `featured-${p.id}` } });
    }
  }
  const newFeatured = [...new Set([...(helpers.featuredIds || []), ...[...ftSent].filter((id) => state.picks[id]?.res === 'pending')])];

  // Picks Destacados CamiloRey Tipster: uno por pick nuevo, solo a Premium y
  // al admin, y solo si el partido no ha empezado.
  let newTips = null;
  try {
    const tips = await listTips(token);
    if (tips) {
      const propios = tips.filter((t) => !t.cambio);        // "cambio": no es un pick del tipster
      const primera = !Array.isArray(N._tips);
      const clave = (t) => `${Number(t.mid)}:${Number(t.fav)}`;  // con el ganador: si lo cambian, se avisa otra vez
      const viejos = new Set(N._tips || []);
      const vistos = new Set(propios.filter((t) => primera || viejos.has(Number(t.mid)) || viejos.has(clave(t))).map(clave));
      for (const t of propios) {
        const mid = Number(t.mid);
        const k = clave(t);
        if (vistos.has(k)) continue;
        vistos.add(k);
        const cambio = [...viejos].some((v) => String(v).startsWith(`${mid}:`));
        const m = state.matches[mid];
        if (!m || m.st !== 's' || new Date(m.at).getTime() <= now) continue;
        const cuota = Number(t.odds) > 1 ? ` · cuota ${Number(t.odds).toFixed(2)}` : '';
        events.push({ kind: 'tipster', title: `${cambio ? 'Cambio en Pick' : 'Pick'} Destacado CamiloRey Tipster: ${t.favName} gana`, body: `${t.favName} vs ${t.opName}${cuota}`, url: SITE, tag: `tip-${mid}` });
      }
      newTips = [...vistos];
    }
  } catch (e) {
    console.error(`Push tipster: ${e.message}`);
  }

  // Chat de soporte: aviso SOLO al admin cuando alguien pidió hablar con
  // una persona y hay mensajes sin leer (uno por mensaje nuevo).
  const chatEvents = [];
  const newChats = { ...(N._chats || {}) };
  if (N._test !== 1) {                     // prueba única, solo para el admin
    chatEvents.push({ kind: 'chat', title: 'Prueba de notificación CamiloRey', body: 'Si ves esto, las notificaciones llegan a este celular.', url: SITE, tag: 'prueba-1' });
  }
  try {
    for (const c of await pendingChats(token)) {
      if (newChats[c.uid] === c.lastAt) continue;
      newChats[c.uid] = c.lastAt;
      chatEvents.push({ kind: 'chat', title: `Chat en vivo: ${c.name || c.email || 'un usuario'} quiere hablar contigo`, body: String(c.last || '').slice(0, 120), url: `${SITE}#/admin`, tag: `chat${c.uid}` });
    }
  } catch (e) {
    console.error(`Push chat: ${e.message}`);
  }

  // Aviso para los miembros (site/announce.json): una notificación por
  // persona y por aviso. audience "admin" = prueba, solo al admin;
  // "premium" = solo miembros Premium (no los de prueba).
  let ann = null;
  try {
    ann = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'site', 'announce.json'), 'utf8'));
  } catch {}
  const annPending = Boolean(ann?.id && ann.push) && N._annOk !== ann.id;

  // ¿A quién hay que leer? Avisos para todos → todos los usuarios; solo
  // resultados o cambios de partidos seguidos → solo quien los sigue.
  const broadcast = events.length || chatEvents.length || annPending || chgCand.some((p) => isFt(p.id));
  const porSeguir = [...finCand, ...chgCand.map((p) => p.id)];
  if (!broadcast && !porSeguir.length) {
    N._featured = newFeatured;
    if (newTips) N._tips = newTips;
    return console.log('Push: sin eventos nuevos');
  }
  const premium = await activeMembers(token);
  const trials = await activeTrials(token);
  const leidos = broadcast ? await listUsers(token) : await usersFollowing(token, porSeguir);
  // Todo se leyó bien: desde aquí ya se puede marcar lo avisado.
  for (const id of finCand) {
    if (!leidos.some((u) => u.follows.map(Number).includes(id))) N[String(id)] = { ...N[String(id)], s: 1, f: 1 }; // nadie lo sigue: revisado
  }
  N._featured = newFeatured;
  if (newTips) N._tips = newTips;
  N._chats = newChats;
  N._test = 1;
  // Notificaciones gratis para quien tiene acceso: membresía activa
  // (colección "members", id = correo), prueba vigente o la cuenta admin.
  const users = leidos.filter((u) => u.push.length && (premium.has(u.email) || trials.has(u.email) || u.email === ADMIN));
  for (const u of users) u.trial = !premium.has(u.email) && u.email !== ADMIN;
  if (!users.length) return console.log('Push: nadie suscrito todavía');
  const log = { at: new Date().toISOString(), conPush: users.length, prueba: users.filter((u) => u.trial).length, admin: users.find((u) => u.email === ADMIN)?.push.length || 0, ok: 0, err: {}, adminRes: [] };

  // Eventos de partidos seguidos (los seguidores ya están en "leidos").
  const followed = new Set(leidos.flatMap((u) => u.follows.map(Number)));
  for (const mid of finCand) {
    if (!followed.has(mid)) continue;
    const m = state.matches[mid];
    const p = state.picks[mid];
    const key = String(mid);
    N[key] = N[key] || {};
    const won = m.w === p.fav;
    events.push({ mid, kind: 'end', title: won ? `✅ ¡Pick acertado! ${helpers.name(p.fav)}` : `❌ Pick fallado: ${helpers.name(p.fav)}`, body: `${helpers.name(m.a)} vs ${helpers.name(m.b)} · ${m.sa}-${m.sb}`, url: `${SITE}#/seguidos`, tag: `m${mid}` });
    N[key].f = 1;
    N[key].s = 1;
  }
  // Picks que cambiaron de jugador: aviso a quien sigue el partido y, si es
  // el destacado, a todos (una vez por cambio).
  for (const p of chgCand) {
    const ft = isFt(p.id);
    if (!followed.has(p.id) && !ft) continue;
    const m = state.matches[p.id];
    const key = String(p.id);
    N[key] = N[key] || {};
    N[key].c = p.chg;
    events.push({ mid: p.id, ft, lk: locked(p.id), kind: 'change', title: `🔄 ${ft ? 'Cambió el pick destacado' : 'Pick actualizado'}: ahora ${helpers.name(p.fav)}`, body: `${helpers.name(m.a)} vs ${helpers.name(m.b)} · ${p.c}% de confianza · revisado antes de empezar`, url: ft ? SITE : `${SITE}#/seguidos`, tag: `m${p.id}` });
  }
  N._ann = N._ann || {};
  const annSent = new Set(ann?.id ? N._ann[ann.id] || [] : []);
  const annFor = (u) => annPending && broadcast && (ann.audience === 'all' || (ann.audience === 'premium' && !u.trial) || u.email === ADMIN) && !annSent.has(u.email);
  const annEvent = ann?.push ? { kind: 'announce', title: ann.push.title, body: ann.push.body, url: `${SITE}#/aviso`, tag: `ann-${ann.id}` } : null;
  if (annPending && broadcast) N._annOk = ann.id; // ya pasó por todos los usuarios
  if (!events.length && !chatEvents.length && !users.some(annFor)) return console.log('Push: sin eventos nuevos');

  let sent = 0;
  for (const u of users) {
    const prefs = { start: true, end: true, change: true, featured: true, ...u.notify };
    // En prueba: el destacado de 60%+ llega sin el jugador y los cambios de
    // esos picks no se mandan (son contenido Premium).
    const mine = events
      .filter((e) => (e.kind === 'tipster' ? !u.trial && prefs.featured : e.kind === 'featured' ? prefs.featured : prefs[e.kind] && (e.ft || u.follows.map(Number).includes(e.mid))))
      .filter((e) => !(u.trial && e.lk && e.kind === 'change'))
      .map((e) => (u.trial && e.lk && e.teaser ? e.teaser : e));
    if (u.email === 'camilosimanca77@gmail.com') mine.push(...chatEvents);
    if (annFor(u)) {
      mine.push(annEvent);
      annSent.add(u.email);
    }
    if (!mine.length) continue;
    const alive = [];
    for (const sub of u.push) {
      let ok = true;
      for (const e of mine) {
        try {
          const { lk, teaser, ...payload } = e; // lk/teaser: solo para decidir aquí
          await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
          sent++;
          log.ok++;
          if (u.email === ADMIN) log.adminRes.push([String(sub.endpoint || '').split('/')[2], 'ok']);
        } catch (err) {
          const c = err.statusCode || String(err.message).slice(0, 60);
          log.err[c] = (log.err[c] || 0) + 1;
          if (u.email === ADMIN) log.adminRes.push([String(sub.endpoint || '').split('/')[2], c]);
          if (err.statusCode === 404 || err.statusCode === 410) ok = false; // suscripción vencida
        }
      }
      if (ok) alive.push(sub);
    }
    if (alive.length !== u.push.length) await savePush(token, u, alive);
  }
  if (ann?.id) N._ann = { [ann.id]: [...annSent] }; // solo se recuerda el aviso actual
  // Limpia avisos viejos (partidos que ya no están en el estado).
  for (const k of Object.keys(N)) if (!k.startsWith('_') && !state.matches[k]) delete N[k];
  N._logs = [...(N._logs || []), { ...log, eventos: [...events, ...chatEvents].map((e) => e.kind), aviso: annSent.size }].slice(-12);
  console.log(`Push: ${events.length + chatEvents.length} eventos, ${sent} notificaciones enviadas`);
}

// Chats donde el usuario pidió una persona y el admin no ha leído.
// Consulta solo esos chats (antes se leían todos cada 5 min).
async function pendingChats(token) {
  const eq = (fieldPath) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { booleanValue: true } } });
  const r = await fetch(`${DOCS}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'chats' }], where: { compositeFilter: { op: 'AND', filters: [eq('human'), eq('unreadAdmin')] } } } })
  });
  if (r.status === 403 || r.status === 404) return []; // reglas aún sin "chats" para el bot
  if (!r.ok) throw new Error(`leer chats: HTTP ${r.status}`);
  const out = [];
  for (const d of (await r.json()).map((x) => x.document).filter(Boolean)) {
    const f = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFs(v)]));
    if (!f.human || !f.unreadAdmin) continue;
    const msgs = Array.isArray(f.msgs) ? f.msgs : [];
    const last = [...msgs].reverse().find((m) => m && m.r === 'u');
    out.push({ uid: d.name.split('/').pop(), name: f.name, email: f.email, lastAt: f.lastAt, last: last?.t });
  }
  return out;
}

// Número REAL de cuentas registradas (documentos de usuario). Reemplaza al
// contador incremental, que sumaba de más.
async function countUsers() {
  if (!process.env.BOT_EMAIL) return null;
  try {
    return (await listUsers(await botToken())).length;
  } catch {
    return null;
  }
}

module.exports = { runNotifications, botToken, toFs, countUsers, activeMembers, activeTrials, listTips, DOCS };
