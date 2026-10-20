// ============================================================
// CamiloRey — aplicación (una sola página, rutas con #/...)
// Datos: site/data/*.json (los genera GitHub Actions cada ~5 min), cifrados:
// el sitio es solo para miembros (js/vault.js).
// En vivo: js/live.js (Rushbet/Kambi directo, cada 2 s).
// Cuenta y visitas: js/firebase.js (opcional).
// ============================================================

import { icon, hydrateIcons } from './icons.js?v=__V__';
import { onLive, currentLive, findLive } from './live.js?v=__V__';
import * as FB from './firebase.js?v=__V__';
import * as REST from './fsrest.js?v=__V__';
import * as Vault from './vault.js?v=__V__';
import { startI18n } from './i18n.js?v=__V__';
import { tapFx, followFx, fxEnabled, setFx, sendFx, messageFx, endFx } from './feedback.js?v=__V__';
import { initChat, syncUser as syncChatUser, fmt as chatFmt, isClosed as chatClosed, idleDue as chatIdleDue, closingMsgs as chatClosingMsgs, chatAvatar } from './chat.js?v=__V__';
import { TELEGRAM_URL, SUPPORT_EMAIL, ADMIN_EMAIL, VAPID_PUBLIC_KEY } from './config.js?v=__V__';

const TZ = 'America/Bogota';
const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetBody = $sheet.querySelector('.sheet-body');

const data = { stats: null, picks: [], results: [], calendar: { days: [], matches: [] }, bankroll: null, loaded: false, error: null };
const ui = { day: 1, calFilter: 'all', calView: 'next', pickFilter: 'all', resRange: 'd30', formTab: 'L5', followRange: 'd7', liveFilter: 'all', bankTab: 'mine' };
let follows = new Set(readLocal('cr_follows', []));
let liveUnsub = null;
let sheetUnsub = null;
let account = null;
let fbStarted = false; // Firebase se arranca después de la primera pantalla (startFirebase)
let profile = null; // { name, photo } editable, guardado en Firestore
let membership = null; // { until, active } de la colección members
let premiumData = null; // contenido Premium (picks completos + Análisis IA)

const isPremiumUser = () => isAdmin() || Boolean(membership?.active);
// El sitio es solo para miembros: sin acceso vigente se ve la pantalla de
// bloqueo (viewLock) y los datos no se pueden abrir (están cifrados).
const hasAccess = () => Boolean(account) && isPremiumUser();
const OPEN_ROUTES = new Set(['login', 'registro', 'ayuda', 'privacidad', 'terminos']);

// Rellena los picks bloqueados y agrega el Análisis IA con el contenido
// Premium (solo llega si la cuenta tiene membresía, por reglas).
function applyPremium() {
  if (!premiumData) return;
  const fill = (p) => {
    const x = p && premiumData[p.id];
    if (!x) return;
    if (p.locked) Object.assign(p, { fav: x.fav, c: x.c, o: x.o, locked: false, premium: true });
    p.why = x.why;
  };
  data.picks.forEach(fill);
  for (const m of data.calendar.matches) {
    if (!m.pick) continue;
    const x = premiumData[m.id];
    if (!x) continue;
    if (m.pick.locked) Object.assign(m.pick, { fav: x.fav, c: x.c, o: x.o, locked: false, premium: true });
    m.pick.why = x.why;
  }
}

// Partidos sin pick: análisis de ambos lados y cuotas prepartido (solo admin).
let adminNoPick = {};

// Pick elegido por el admin para un partido (colección "tipster"), en el
// mismo formato que un pick del sistema para poder dibujarlo en las tarjetas.
function tipsterPickFor(m) {
  const t = (tipsterCache || []).find((x) => Number(x.mid) === m.id);
  if (!t) return null;
  return { fav: t.fav, c: null, o: t.odds ?? null, tipster: true, mode: t.mode || 'pre', note: t.note || '', res: m.st === 'f' ? (m.w === t.fav ? 'hit' : 'miss') : 'pending' };
}

async function refreshPremium() {
  if (isAdmin()) adminNoPick = (await FB.loadAdminLedger().catch(() => ({}))).nopick || adminNoPick;
  membership = account ? await FB.loadMembership().catch(() => membership) : null;
  if (!hasAccess()) return clearData();
  if (FB.enabled) await loadTipster(true);
  premiumData = await FB.loadPremiumContent().catch(() => premiumData);
  applyPremium();
  maybePremiumWelcome();
}

// Sin acceso (cerró sesión o se le venció): no dejar nada en pantalla.
function clearData() {
  Object.assign(data, { stats: null, picks: [], results: [], calendar: { days: [], matches: [] }, bankroll: null, loaded: false, error: null });
  premiumData = null;
  tipsterCache = null;
  Vault.forget();
}

// Bienvenida a Premium: se muestra una sola vez por cada activación o
// renovación (se recuerda la fecha de vencimiento ya mostrada).
function maybePremiumWelcome() {
  if (!membership?.active || isAdmin() || !$sheet.hidden) return;
  const key = membership.until.toISOString();
  if (readLocal('cr_prem_welcome', '') === key) return;
  writeLocal('cr_prem_welcome', key);
  showPremiumWelcome(membership.until);
}

// También la usa el panel admin como vista previa.
function showPremiumWelcome(until) {
  const fecha = until.toLocaleDateString(LOC(), { day: 'numeric', month: 'long', year: 'numeric' });
  const perks = ['Picks de alta confianza (60% o más)', 'Análisis con IA por partido', 'Bankroll con criterio de Kelly', 'Alertas de picks en tu celular'];
  $sheetBody.innerHTML = `
    <div class="pw-head">
      <div class="pw-crown">${crownSvg()}</div>
      <div class="pw-over">SUSCRIPCIÓN ACTIVA</div>
      <h2>Bienvenido a CamiloRey Premium</h2>
      <p>Tu suscripción está activa hasta ${esc(fecha)}.</p>
    </div>
    <div class="pw-card">
      <span class="pw-badge">ACCESO COMPLETO</span>
      <div class="pw-title"><span class="pw-ic">${crownSvg()}</span><div><b>CamiloRey Premium</b><small>Para quien sigue los picks en serio</small></div></div>
      <ul class="pw-list">${perks.map((p) => `<li>${esc(p)}<span>✓</span></li>`).join('')}</ul>
    </div>
    <button class="btn pw-btn" id="btn-pw-start">Comenzar a Explorar</button>`;
  $sheet.hidden = false;
  $sheet.classList.add('pw');
  document.body.style.overflow = 'hidden';
}

function crownSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z"/><path d="M5 18h14"/></svg>';
}

// Bloque "solo Premium" reutilizable.
function premiumLock(title, text) {
  return `<div class="premium-lock"><div class="pl-ic">⭐</div><b>${esc(title)}</b><p>${esc(text)}</p><a class="btn primary" href="#/premium">Conocer Premium</a></div>`;
}

const userName = () => profile?.name || account?.displayName || account?.email?.split('@')[0] || 'Usuario';
const userPhoto = () => profile?.photo || account?.photoURL || null;
function userAvatar(size) {
  const ph = userPhoto();
  return ph ? `<img src="${esc(ph)}" alt="" referrerpolicy="no-referrer">` : esc(initials(userName()));
}

// Recorta al centro y achica la imagen elegida a 256x256 JPEG (~15 KB).
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 256;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = S;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------------- utilidades ----------------

function readLocal(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
}
function writeLocal(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}
// Idioma elegido en Perfil (es / en): define el formato de fechas y horas.
function LOC() {
  return readLocal('cr_lang', 'es') === 'en' ? 'en-US' : 'es-CO';
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => new Intl.DateTimeFormat(LOC(), { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }).format(new Date(iso));
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const todayKey = () => dayKey(new Date().toISOString());
function dayLabel(key) {
  const t = todayKey();
  const d = new Date(`${key}T12:00:00-05:00`);
  const y = dayKey(new Date(Date.now() - 86400e3).toISOString());
  const m = dayKey(new Date(Date.now() + 86400e3).toISOString());
  if (key === t) return 'Hoy';
  if (key === y) return 'Ayer';
  if (key === m) return 'Mañana';
  return new Intl.DateTimeFormat(LOC(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).format(d);
}
const longDate = () => new Intl.DateTimeFormat(LOC(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date());
const pct = (v) => (v == null ? '—' : `${String(v).replace('.', ',')}%`);
// Cuotas en el formato elegido en Perfil: decimal (1.57), americano
// (−175 / +150) o fraccional (4/7).
function odds(o) {
  if (!o) return '—';
  const d = Number(o);
  const fmt = readLocal('cr_odds', 'decimal');
  if (fmt === 'american') return d >= 2 ? `+${Math.round((d - 1) * 100)}` : `−${Math.round(100 / (d - 1))}`;
  if (fmt === 'fractional') {
    // Mejor fracción con denominador hasta 20 (como las cuotas británicas).
    const x = d - 1;
    let best = [Math.round(x), 1];
    for (let den = 1; den <= 20; den++) {
      const num = Math.round(x * den);
      if (Math.abs(num / den - x) < Math.abs(best[0] / best[1] - x) - 1e-9) best = [num, den];
    }
    const g = (a, b) => (b ? g(b, a % b) : a);
    const k = g(best[0], best[1]) || 1;
    return `${best[0] / k}/${best[1] / k}`;
  }
  return d.toFixed(2);
}
const initials = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const fmtInt = (n) => new Intl.NumberFormat(LOC()).format(n || 0);
const cop = (n) => `$${new Intl.NumberFormat(LOC(), { maximumFractionDigits: 0 }).format(Math.round(n || 0))}`;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${cop(Math.abs(n))}`;

// Avatar redondo: usa la miniatura propia (160 px, ~6 KB) si existe; la foto
// original de tt.league-pro.com pesa 150-300 KB.
function avatar(p, cls = 'avatar') {
  const src = p?.th || p?.av;
  if (src) {
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${esc(initials(p.n))}</div>'">`;
  }
  return `<div class="${cls}">${esc(initials(p?.n))}</div>`;
}

function formDots(str, n, cls = 'form') {
  const s = (str || '').slice(0, n).split('').filter(Boolean);
  if (!s.length) return `<div class="${cls}"><small style="color:var(--faint);font-size:11px">sin historial</small></div>`;
  return `<div class="${cls}">${s.map((c) => `<i class="${c === 'W' ? 'w' : 'l'}">${c}</i>`).join('')}</div>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------- datos ----------------

// Los archivos llegan cifrados: Vault los abre con la llave del miembro.
async function getJson(name) {
  const r = await fetch(`data/${name}.json?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return Vault.open(await r.arrayBuffer());
}

async function loadData() {
  if (!hasAccess()) return clearData();
  try {
    const [stats, picks, results, calendar] = await Promise.all([getJson('stats'), getJson('picks'), getJson('results'), getJson('calendar')]);
    Object.assign(data, { stats, picks, results, calendar, loaded: true, error: null });
    loadAnnounce();
    applyPremium();
  } catch (e) {
    // Sin llave: el acceso se acaba de vencer o se lo quitaron. Se revisa la
    // membresía y, si ya no tiene, se bloquea.
    if (e instanceof Vault.NoAccess) await refreshPremium();
    data.error = e.message;
    data.loaded = true;
  }
}

// Todos los partidos conocidos por id (para Seguidos / notificaciones).
function allById() {
  const map = new Map();
  for (const m of data.calendar.matches) map.set(m.id, { ...m, ...(m.pick || {}) });
  for (const p of data.results) map.set(p.id, { ...(map.get(p.id) || {}), ...p });
  for (const p of data.picks) map.set(p.id, { ...(map.get(p.id) || {}), ...p });
  return map;
}

// ---------------- seguidos ----------------

function isFollowed(id) {
  return follows.has(id);
}
async function toggleFollow(id) {
  if (follows.has(id)) {
    follows.delete(id);
    tapFx();
  } else {
    follows.add(id);
    followFx();
  }
  writeLocal('cr_follows', [...follows]);
  if (FB.user()) FB.saveFollows([...follows]).catch(() => {});
  document.querySelectorAll(`[data-follow="${id}"]`).forEach((b) => b.classList.toggle('on', follows.has(id)));
  toast(follows.has(id) ? 'Agregado a Seguidos' : 'Quitado de Seguidos');
}

// ---------------- piezas ----------------

// Cruce partido en vivo (Rushbet) ↔ partido nuestro. Dos jugadores pueden
// enfrentarse VARIAS veces el mismo día (grupos y después 3er puesto o
// final), así que no basta con los nombres: solo cuentan partidos que no
// hayan terminado, y si hay más de uno, el de hora más cercana a ahora.
function ourMatchForLive(e) {
  const now = Date.now();
  const byId = new Map();
  for (const x of [...data.calendar.matches, ...data.picks]) if (x.st !== 'f') byId.set(x.id, x);
  const cands = [...byId.values()].filter((x) => findLive([e], x.a.n, x.b.n));
  if (!cands.length) return null;
  cands.sort((x, y) => Math.abs(new Date(x.at).getTime() - now) - Math.abs(new Date(y.at).getTime() - now));
  const best = cands[0];
  return data.calendar.matches.find((x) => x.id === best.id) || best;
}

function liveFor(m) {
  if (!m || m.st === 'f') return null;
  const e = currentLive().all.find((ev) => findLive([ev], m.a.n, m.b.n));
  if (!e || ourMatchForLive(e)?.id !== m.id) return null;
  return findLive([e], m.a.n, m.b.n);
}

function midBlock(m) {
  const lv = liveFor(m);
  const ph = m.ph ? `<span class="badge red">🏆 ${esc(m.ph)}</span>` : '';
  if (m.st === 'f') {
    return `<div class="mid">${ph || '<span class="badge">Terminado</span>'}<span class="score">${m.sa}-${m.sb}</span><span class="played">${icon('clock')} ${fmtTime(m.at)}</span><span class="tn">${esc(m.tn)}</span></div>`;
  }
  if (lv) {
    return `<div class="mid" data-live-mid="${m.id}"><span class="badge live">EN VIVO</span><span class="score">${lv.setsHome}-${lv.setsAway}</span><span class="tn">${m.ph ? `${esc(m.ph)} · ` : ''}${esc(lv.ptsHome)} : ${esc(lv.ptsAway)} pts</span></div>`;
  }
  return `<div class="mid">${ph}<span class="time">${fmtTime(m.at)}</span><span class="tn">${esc(m.tn)}</span></div>`;
}

function matchCard(m, pick = m.pick || (m.c || m.locked ? m : null) || tipsterPickFor(m), { showForm = true } = {}) {
  if (pick?.locked) {
    // Pick Premium pendiente: el usuario gratis ve el partido, no el pick.
    return `
  <article class="card" data-match="${m.id}">
    <div class="match" data-open="${m.id}">
      <div class="side">${avatar(m.a)}<span class="nm">${esc(m.a.n)}</span>${showForm ? formDots(m.fa, 5) : ''}</div>
      ${midBlock(m)}
      <div class="side">${avatar(m.b)}<span class="nm">${esc(m.b.n)}</span>${showForm ? formDots(m.fb, 5) : ''}</div>
    </div>
    <a class="pickbar locked-bar" href="#/premium"><span class="who">🔒 <b>Pick Premium</b> · alta confianza</span><span class="badge red">Ver con Premium</span></a>
  </article>`;
  }
  const favA = pick && pick.fav === m.a.id;
  const favB = pick && pick.fav === m.b.id;
  const fav = favA ? m.a : favB ? m.b : null;
  const res = pick?.res === 'hit' ? '<span class="badge win">✓ Acierto</span>' : pick?.res === 'miss' ? '<span class="badge loss">✗ Fallo</span>' : '';
  return `
  <article class="card" data-match="${m.id}">
    <div class="match" data-open="${m.id}">
      <div class="side ${favA ? 'fav' : ''}">${avatar(m.a)}<span class="nm">${esc(m.a.n)}</span>${showForm ? formDots(m.fa, 5) : ''}</div>
      ${midBlock(m)}
      <div class="side ${favB ? 'fav' : ''}">${avatar(m.b)}<span class="nm">${esc(m.b.n)}</span>${showForm ? formDots(m.fb, 5) : ''}</div>
    </div>
    ${
      pick
        ? `<div class="pickbar">
        <span class="who">Pick: <b>${esc(fav?.n)}</b> gana</span>
        ${pick.tipster ? '<span class="badge red">👑 TIPSTER</span>' : `${pick.premium ? '<span class="badge red" title="Pick Premium">⭐</span>' : ''}<span class="conf${pick.c < PAREJO ? ' low' : ''}" ${pick.c < PAREJO ? 'title="Partido parejo: baja confianza"' : ''}>${pick.c}%</span>`}
        <span class="odds">${odds(pick.o)}</span>
        ${res}
        ${pick.res === 'pending' ? `<button class="follow ${isFollowed(m.id) ? 'on' : ''}" data-follow="${m.id}" aria-label="Seguir pick">${icon('heart')}</button>` : ''}
      </div>`
        : ''
    }
  </article>`;
}

// Tarjeta de marcador en vivo. Si el partido es nuestro (ourMatch), se
// orienta el evento de Kambi a nuestro jugador A/B y se muestran sus fotos.
function liveCard(e, ourMatch, { inSheet = false } = {}) {
  let players = [null, null];
  if (ourMatch) {
    const oriented = findLive([e], ourMatch.a.n, ourMatch.b.n);
    if (oriented) {
      e = oriented;
      players = [ourMatch.a, ourMatch.b];
    }
  }
  const pick = ourMatch ? ourMatch.pick || (ourMatch.c ? ourMatch : null) : null;
  // data-u marca las partes que cambian (marcador, sets, saque): en cada
  // actualización solo se reemplazan esas, nunca las fotos (no parpadean).
  const u = `${e.id}`;
  const row = (side, name, sets, pts, serving, p) => `
    <div class="live-row">
      <div class="p">${p ? avatar(p, 'avatar sm') : ''}<span>${esc(p?.n || name)}</span><i class="serve-slot" data-u="${u}-sv${side}">${serving ? '<i class="ball" title="Saca"></i>' : ''}</i>${pick && p && pick.fav === p.id ? '<span class="badge red" style="padding:1px 6px;font-size:10px">PICK</span>' : ''}</div>
      <div class="sets" data-u="${u}-st${side}">${sets.map((s) => `<span class="${s.won ? 'won' : ''}">${s.v}</span>`).join('')}</div>
      <div class="pts" data-u="${u}-pt${side}">${esc(pts)}</div>
    </div>`;
  const setsH = e.sets.map((s) => ({ v: s.h, won: s.h > s.a && (s.h >= 11 || s.a >= 11) }));
  const setsA = e.sets.map((s) => ({ v: s.a, won: s.a > s.h && (s.h >= 11 || s.a >= 11) }));
  return `
  <article class="card live-card" data-ev="${u}" ${ourMatch && !inSheet ? `data-open="${ourMatch.id}" style="cursor:pointer"` : ''}>
    <div class="live-head"><span><span class="badge live">EN VIVO</span> &nbsp;${esc(ourMatch?.tn || e.group)}${ourMatch?.ph ? ` · 🏆 ${esc(ourMatch.ph)}` : ''}</span><b style="color:var(--text)" data-u="${u}-sc">${e.setsHome} - ${e.setsAway}</b></div>
    ${row('h', e.home, setsH, e.ptsHome, e.homeServe === true, players[0])}
    ${row('a', e.away, setsA, e.ptsAway, e.homeServe === false, players[1])}
    ${
      pick && !inSheet
        ? pick.locked
          ? '<div class="pickbar" style="padding:8px 0 0;border-top:1px solid var(--line);margin-top:6px"><span class="who">🔒 <b style="color:#facc15">Pick Premium</b> · alta confianza</span></div>'
          : `<div class="pickbar" style="padding:8px 0 0;border-top:1px solid var(--line);margin-top:6px"><span class="who">Nuestro pick: <b>${esc(pick.fav === ourMatch.a.id ? ourMatch.a.n : ourMatch.b.n)}</b></span><span class="conf">${pick.c}%</span></div>`
        : ''
    }
  </article>`;
}

function skeleton(n = 3) {
  return Array.from({ length: n }, () => '<div class="skel"></div>').join('');
}

function empty(ic, title, text) {
  return `<div class="empty"><div class="ic">${icon(ic)}</div><b>${esc(title)}</b><p>${text}</p></div>`;
}

function errorBox() {
  return data.error ? `<div class="note" style="border-color:var(--red)">No se pudieron cargar los datos (${esc(data.error)}). Revisa tu conexión y recarga.</div>` : '';
}

// ---------------- vistas ----------------

// Fondo animado del saludo: alterna cada día (hora de Colombia) entre el
// brillo que flota (A) y el destello (C), como pidió el usuario el 19-oct.
const heroFx = () => (Math.floor(Date.parse(todayKey()) / 86400e3) % 2 ? 'fx-c' : 'fx-a');

// ---------- Aviso para los miembros (site/announce.json) ----------
// Lo escribe el admin (con Claude). audience "admin" = prueba, solo lo ve el
// admin; "all" = todos los miembros. scripts/notify.js manda la misma
// notificación una vez por persona. Se oculta al leerlo o al tocar Ocultar.
let announce = null;
async function loadAnnounce() {
  try {
    const r = await fetch(`announce.json?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
    announce = r.ok ? await r.json() : null;
  } catch {
    announce = null;
  }
  maybeAnnounce();
}
// Ventana emergente (en cualquier pestaña), una sola vez por aviso. Si la
// persona tiene abierta la ficha de un partido, espera a la próxima recarga.
function maybeAnnounce() {
  if (!annVisible() || !$sheet.hidden || readLocal('cr_ann_seen', '') === announce.id) return;
  writeLocal('cr_ann_seen', announce.id);
  $sheetBody.innerHTML = `<div class="ann-modal">
    <div class="ann-ic">${icon('bell')}</div>
    <span class="overline">Aviso importante${announce.audience === 'all' ? '' : ' · prueba (solo admin)'}</span>
    <h2>${esc(announce.title)}</h2>
    <div class="ann-page">${(announce.sections || []).map((x) => `<h3>${esc(x.h)}</h3><p>${esc(x.t)}</p>`).join('')}</div>
    <button type="button" class="btn primary" id="btn-ann-ok" style="margin-top:16px">Entendido</button>
    <a class="btn ghost" href="#/bankroll" id="btn-ann-bank" style="margin-top:8px">Ir a Mi Bankroll</a>
  </div>`;
  $sheet.hidden = false;
  document.body.style.overflow = 'hidden';
}
const annVisible = () => Boolean(announce?.id) && (announce.audience === 'all' || isAdmin());
function viewAviso() {
  if (!annVisible()) return `<div class="subhead"><a class="back" href="#/">${icon('left')} Inicio</a><h1>Aviso</h1></div>${empty('bell', 'Sin avisos', 'No hay avisos nuevos por ahora.')}`;
  writeLocal('cr_ann_seen', announce.id);
  return `<div class="subhead"><a class="back" href="#/">${icon('left')} Inicio</a><h1>${esc(announce.title)}</h1></div>
  <div class="card pad ann-page">${(announce.sections || []).map((x) => `<h3>${esc(x.h)}</h3><p>${esc(x.t)}</p>`).join('')}</div>
  <a class="btn primary" style="margin-top:14px" href="#/bankroll">Ir a Mi Bankroll</a>`;
}

function viewInicio() {
  // Estadísticas de Inicio: SOLO los picks destacados (con su resultado real).
  const fs = data.stats?.featured;
  const total = fs ? fs.all.hit + fs.all.miss : 0;
  const name = account ? userName().split(' ')[0] : null;
  const streak = fs?.streak || 0;
  const streakTxt = streak > 0 ? `${streak}W 🔥` : streak < 0 ? `${-streak}L` : '—';
  const pend = data.picks;
  const avgOdds = fs?.avgOdds ? odds(fs.avgOdds) : '—';
  const next = upcomingPicks();
  const featured = next.find((p) => p.ft); // solo el elegido por el sistema (60%+ y cuota > 1.60)

  return `
  <section class="hero ${heroFx()}">
    <h1>${name ? `Hola, ${esc(name)} 👋` : 'Picks de hoy 🏓'}</h1>
    <p>${esc(longDate())} · ${pend.length} picks activos · Liga Pro Checa</p>
  </section>
  ${errorBox()}
  <div class="overline" style="margin:16px 2px 0">⭐ Picks destacados</div>
  <div class="tiles" style="margin-top:8px">
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${pct(fs?.all?.pct)}</div><div class="hint">${total ? `${fs.all.hit} de ${total}` : 'sin resueltos aún'}</div></div>
    <div class="tile"><div class="overline">Racha</div><div class="val ${streak > 0 ? 'pos' : streak < 0 ? 'neg' : ''}">${streakTxt}</div><div class="hint">destacados seguidos</div></div>
    <div class="tile"><div class="overline">Cuota prom.</div><div class="val">${avgOdds}</div><div class="hint">de los destacados</div></div>
  </div>
  ${
    fs?.last?.length
      ? `<div class="card pad" style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="overline" style="margin-right:auto">Últimos destacados</span>${fs.last
          .slice()
          .reverse()
          .map((x) => `<span class="h2h-res ${x.res === 'hit' ? 'w' : 'l'}" style="margin:0;width:22px;height:22px" title="${esc(x.fav)} · ${x.c}%">${x.res === 'hit' ? '✓' : '✗'}</span>`)
          .join('')}</div>`
      : ''
  }

  <div id="tipster-home"></div>
  ${
    featured
      ? `<div class="section-h"><h2>${icon('trophy')} Pick destacado</h2></div>${matchCard(featured, featured)}`
      : data.loaded && next.length
      ? `<div class="section-h"><h2>${icon('trophy')} Pick destacado</h2></div><p class="note">${icon('info')} Ahora no hay pick destacado: ningún pick de 60% o más tiene cuota mayor a 1,60. Aparece solo en cuanto haya uno.</p>`
      : ''
  }

  <div class="section-h"><h2><i class="live-dot red"></i> En vivo ahora</h2><a class="link" href="#/envivo">Ver todo</a></div>
  <div id="live-home">${skeleton(1)}</div>
  ${hotHtml()}
  ${data.loaded && !next.length ? empty('clock', 'Sin picks por ahora', 'Los picks se generan unas horas antes de cada torneo. Vuelve en un rato.') : ''}
  ${footer()}`;
}

// ---------- Premium ----------
function viewPremium() {
  const active = isPremiumUser();
  const until = membership?.until;
  const perk = (ic, t, s) => `<div class="row"><span class="ic" style="font-size:18px">${ic}</span><span class="tx"><b>${t}</b><small>${s}</small></span>${active ? '<span class="badge win">✓</span>' : '<span>🔒</span>'}</div>`;
  return `
  <div class="subhead"><a class="back" href="javascript:history.back()">${icon('left')} Atrás</a><h1>Premium</h1></div>
  <div class="premium-hero">
    <div style="font-size:42px">⭐</div>
    <h2>CamiloRey Premium</h2>
    ${
      active
        ? `<p><b>Tu membresía está activa</b>${isAdmin() ? ' (administrador)' : until ? ` hasta el <b>${esc(until.toLocaleDateString(LOC(), { day: 'numeric', month: 'long', year: 'numeric' }))}</b>` : ''}.</p>`
        : '<p>Desbloquea todo el poder del sistema.</p>'
    }
  </div>
  <div class="list" style="margin-top:14px">
    ${perk('🔥', 'Picks de alta confianza', 'Los picks de 60% o más, antes del partido')}
    ${perk('🧠', 'Análisis IA de cada pick', 'Por qué gana: rating, mercado, cruce directo, rachas y forma del día')}
    ${perk('💰', 'Mi Bankroll con Kelly', 'Cuánto apostar en cada pick que sigues, saldo y ROI')}
    ${perk('🔔', 'Notificaciones en el celular', 'Nuevo pick destacado y resultado de tus picks seguidos')}
  </div>
  ${
    active
      ? ''
      : `<div class="card pad" style="margin-top:14px">
      <b>¿Cómo activarlo?</b>
      <p style="font-size:13px;color:var(--muted);margin:6px 0 12px">1) ${account ? 'Ya tienes cuenta ✓' : '<a class="textlink" href="#/registro">Crea tu cuenta</a> (con Google o correo)'}.<br>2) Escríbenos por Telegram con el correo de tu cuenta${account?.email ? ` (<b>${esc(account.email)}</b>)` : ''}.<br>3) Te activamos Premium y se desbloquea al instante.</p>
      <a class="btn primary tg" href="${esc(telegramLink(`Hola, buen día. Me gustaría obtener Premium en el Sistema de CamiloRey.${account?.email ? ` El correo de mi cuenta es ${account.email}.` : ''} ¡Muchas gracias!`))}" target="_blank" rel="noopener">${icon('telegram')} Pedir Premium por Telegram</a>
    </div>`
  }
  ${footer()}`;
}

// ---------- Notificaciones push ----------
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function viewNotificaciones() {
  setTimeout(renderNotificaciones, 0);
  return `<div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Notificaciones</h1></div><div id="notif-page">${skeleton(2)}</div>`;
}

async function renderNotificaciones() {
  const box = document.getElementById('notif-page');
  if (!box) return;
  if (!FB.enabled || !account) {
    box.innerHTML = `${empty('bell', 'Inicia sesión', 'Las notificaciones avisan de los picks que sigues, así que necesitas una cuenta.')}<a class="btn primary" href="#/login">Iniciar sesión</a>`;
    return;
  }
  if (!isPremiumUser()) {
    box.innerHTML = premiumLock('Las notificaciones son Premium', 'Recibe en tu celular cada nuevo pick destacado y el resultado de los picks que sigues, aunque tengas la página cerrada.');
    return;
  }
  if (!pushSupported()) {
    box.innerHTML = isIOS() && !isStandalone()
      ? `<div class="note"><b>En iPhone:</b> primero agrega CamiloRey a tu pantalla de inicio (botón Compartir → "Agregar a inicio"), ábrelo desde ese ícono y vuelve aquí para activarlas.</div>`
      : '<div class="note">Este navegador no permite notificaciones. Prueba con Chrome.</div>';
    return;
  }
  const st = (await FB.loadPushState().catch(() => null)) || { push: [], notify: { start: true, end: true, change: true, featured: true } };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const here = Boolean(sub && st.push.some((s) => s.endpoint === sub.endpoint));
  const denied = Notification.permission === 'denied';
  const pref = (k, ic, t, s) => `<button class="row check ${st.notify[k] ? 'on' : ''}" data-npref="${k}"><span class="ic">${ic}</span><span class="tx"><b>${t}</b><small>${s}</small></span><span class="tick"></span></button>`;
  box.innerHTML = `
  <div class="card pad" style="display:flex;align-items:center;gap:12px">
    <span style="font-size:28px">${here ? '🔔' : '🔕'}</span>
    <div style="flex:1"><b>${here ? 'Activadas en este dispositivo' : 'Desactivadas en este dispositivo'}</b><div style="font-size:12px;color:var(--muted)">${denied ? 'Bloqueaste las notificaciones en el navegador: actívalas en la configuración del sitio.' : 'Te avisamos aunque tengas la página cerrada.'}</div></div>
  </div>
  <button class="btn ${here ? 'ghost' : 'primary'}" style="margin-top:10px" id="${here ? 'btn-push-off' : 'btn-push-on'}" ${denied ? 'disabled' : ''}>${here ? 'Desactivar en este dispositivo' : '🔔 Activar notificaciones'}</button>
  <div class="overline" style="margin:22px 4px 8px">Quiero recibir</div>
  <div class="list">
    ${pref('featured', '⭐', 'Nuevo pick destacado', 'El pick de más confianza del momento')}
    ${pref('change', '🔄', 'Cambio en mis picks seguidos', 'Si al revisarlo antes de empezar el pick cambia de jugador')}
    ${pref('end', '✅', 'Resultado de mis picks seguidos', 'Si ganó o perdió, con el marcador')}
  </div>
  <p class="note" style="margin-top:14px">Solo te avisamos de los picks destacados, de los cambios y del resultado de los picks que sigues con el ♥. Pueden llegar con unos minutos de diferencia: el sistema revisa cada ~5 minutos.</p>`;
}

async function pushOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('No diste permiso para notificaciones');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) }));
    const json = sub.toJSON();
    const st = await FB.loadPushState();
    const push = [...(st?.push || []).filter((s) => s.endpoint !== json.endpoint), { endpoint: json.endpoint, keys: json.keys }].slice(-5);
    await FB.savePushState({ push });
    toast('🔔 Notificaciones activadas');
  } catch (e) {
    toast('No se pudieron activar: ' + (e.message || e));
  }
  renderNotificaciones();
}

async function pushOff() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const st = await FB.loadPushState();
    await FB.savePushState({ push: (st?.push || []).filter((s) => !sub || s.endpoint !== sub.endpoint) });
    if (sub) await sub.unsubscribe();
    toast('Notificaciones desactivadas');
  } catch (e) {
    toast(e.message || 'Error');
  }
  renderNotificaciones();
}

// ---------- Panel de administrador (solo la cuenta admin) ----------
let tipsterCache = null; // picks del tipster leídos de Firestore

async function loadTipster(force = false) {
  if (!FB.enabled || !hasAccess()) return [];
  if (tipsterCache && !force) return tipsterCache;
  try {
    // Solo miembros (reglas): va con la sesión, por la librería de Firebase.
    tipsterCache = await FB.listTipster();
  } catch {
    tipsterCache = [];
  }
  return tipsterCache;
}

function viewAdmin() {
  if (!isAdmin()) return `<div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Admin</h1></div>${empty('shield', 'Solo administrador', 'Entra con la cuenta admin para ver este panel.')}`;
  const now = Date.now();
  const next = data.calendar.matches.filter((m) => m.st === 's' && new Date(m.at).getTime() > now).slice(0, 80);
  setTimeout(renderAdminPanel, 0);
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Panel admin</h1></div>
  <div class="section-h"><h2>📅 Resumen del día</h2><span class="badge red">Solo admin</span></div>
  <div id="admin-daily">${skeleton(2)}</div>
  <div class="section-h" id="admin-chats"><h2>💬 Soporte en vivo</h2><span class="badge" id="admin-chats-count"></span></div>
  <div id="admin-chats-box">${skeleton(1)}</div>
  <div class="section-h"><h2>👑 Publicar pick del tipster</h2></div>
  <form class="card pad" id="tipster-form">
    <label class="field"><span>Partido</span>
      <select name="mid" class="inline-input" style="width:100%" required>
        <option value="">Elige un partido próximo…</option>
        ${next.map((m) => `<option value="${m.id}">${fmtTime(m.at)} · ${esc(m.a.n)} vs ${esc(m.b.n)} · ${esc((m.tn || '').replace(/^Tournament\s*/i, ''))}</option>`).join('')}
      </select></label>
    <div class="field"><span>¿Quién gana?</span><div class="seg seg-full" id="tipster-side"><button type="button" data-side="a" disabled>Jugador A</button><button type="button" data-side="b" disabled>Jugador B</button></div></div>
    <label class="field"><span>Nota (opcional)</span><input name="note" maxlength="160" class="inline-input" style="width:100%;border-color:var(--line)" placeholder="Ej: viene muy fuerte hoy"></label>
    <button class="btn primary" type="submit">Publicar pick</button>
  </form>
  <div id="admin-tipster">${skeleton(1)}</div>
  <div class="section-h"><h2>⭐ Miembros · acceso al sitio</h2></div>
  <form class="card pad" id="member-form">
    <label class="field"><span>Correo de la cuenta del usuario (sirve si entra con Google o con correo)</span>
      <input name="email" type="email" required class="inline-input" style="width:100%;border-color:var(--line)" placeholder="usuario@gmail.com"></label>
    <div class="field"><span>Duración</span><div class="seg seg-full" id="member-days">${[1, 7, 30, 90, 365].map((d) => `<button type="button" data-mdays="${d}" class="${d === 30 ? 'on' : ''}">${d === 365 ? '1 año' : d === 1 ? '1 día' : d + ' días'}</button>`).join('')}</div></div>
    <button class="btn primary" type="submit">Dar acceso</button>
    <p style="font-size:12px;color:var(--muted);margin:8px 0 0">Sin acceso vigente nadie puede ver el sitio. Si ya tenía acceso, los días se suman a su fecha de vencimiento; al vencerse se bloquea solo. Al usuario le aparece automáticamente una bienvenida. <button type="button" class="textlink" id="btn-pw-preview">Ver cómo se ve</button></p>
  </form>
  <div id="admin-members">${skeleton(1)}</div>
  <div class="section-h"><h2>📊 Visitas</h2></div>
  <div id="admin-visits">${skeleton(1)}</div>
  <div class="section-h"><h2>👥 Usuarios</h2></div>
  <div id="admin-users">${skeleton(2)}</div>`;
}

// Resumen del día (solo admin): picks jugados, ganados, perdidos,
// efectividad, unidades y confianza, con gráfica de los últimos 14 días.
// Sale del historial privado (admin/ledger), que trae TODOS los picks.
let dailyRows = null;
const dayName = (key, opts = { weekday: 'short', day: '2-digit', month: '2-digit' }) =>
  new Intl.DateTimeFormat(LOC(), { ...opts, timeZone: TZ }).format(new Date(`${key}T12:00:00-05:00`));

async function renderAdminDaily(reload = true) {
  const box = document.getElementById('admin-daily');
  if (!box || !isAdmin()) return;
  try {
    if (reload || !dailyRows) dailyRows = (await FB.loadAdminLedger()).rows || [];
  } catch (e) {
    box.innerHTML = `<div class="note">No se pudo cargar el resumen (${esc(e.code || e.message)}).</div>`;
    return;
  }
  // Solo picks publicados (los "no publicados" de antes no cuentan).
  const done = dailyRows.filter((x) => x.res === 'hit' || x.res === 'miss').filter((x) => x.st !== 'np');
  const byDay = new Map();
  for (const x of done) {
    const k = dayKey(x.at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(x);
  }
  const sum = (list) => {
    const hit = list.filter((x) => x.res === 'hit').length;
    const withO = list.filter((x) => x.o);
    const units = withO.reduce((s, x) => s + (x.res === 'hit' ? x.o - 1 : -1), 0);
    return { n: list.length, hit, miss: list.length - hit, pct: list.length ? Math.round((hit / list.length) * 1000) / 10 : null, units: Math.round(units * 100) / 100, withO: withO.length };
  };
  const today = todayKey();
  const keys = [...byDay.keys()].sort().reverse();
  if (!ui.adminDay || (!byDay.has(ui.adminDay) && ui.adminDay !== today)) ui.adminDay = byDay.has(today) || !keys.length ? today : keys[0];
  const sel = ui.adminDay;
  const list = (byDay.get(sel) || []).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const s = sum(list);
  const pending = dailyRows.filter((x) => x.res === 'pending' && dayKey(x.at) === sel).length;
  const band = (lo, hi) => sum(list.filter((x) => x.c >= lo && x.c < hi));
  const bands = [
    ['60% o más', band(60, 101)],
    ['55–59% (parejos)', band(55, 60)],
    ['50–54% (parejos)', band(50, 55)]
  ];
  const unitsTxt = (u) => `${u > 0 ? '+' : ''}${String(u).replace('.', ',')}`;

  // Gráfica: últimos 14 días con datos, barras de ganados/perdidos con el
  // nombre del día y la fecha debajo, y la efectividad arriba.
  const chartDays = keys.slice(0, 14).reverse();
  const max = Math.max(1, ...chartDays.map((k) => byDay.get(k).length));
  const chart = chartDays.length
    ? `<div class="card pad" style="margin-top:12px">
      <div class="block-h" style="margin:0 0 6px"><span class="overline">Últimos días</span><div class="legend"><span><i style="background:var(--win)"></i>Ganados</span><span><i style="background:var(--red)"></i>Perdidos</span></div></div>
      <div class="scroll-x"><div class="dchart" style="min-width:${chartDays.length * 46}px">${chartDays
        .map((k) => {
          const d = sum(byDay.get(k));
          return `<button type="button" class="dcol ${k === sel ? 'on' : ''}" data-aday="${k}">
            <span class="dpct ${d.pct >= 55 ? 'pos-t' : d.pct < 50 ? 'neg-t' : ''}">${d.pct == null ? '—' : Math.round(d.pct) + '%'}</span>
            <span class="dbar"><i class="h" style="height:${(d.hit / max) * 110}px"></i><i class="m" style="height:${(d.miss / max) * 110}px"></i></span>
            <span class="dname">${esc(dayName(k, { weekday: 'short' }))}</span><span class="ddate">${esc(dayName(k, { day: '2-digit', month: '2-digit' }))}</span>
          </button>`;
        })
        .join('')}</div></div>
    </div>`
    : '';

  box.innerHTML = `
    <div class="seg seg-full" style="grid-auto-flow:column;overflow-x:auto;margin-bottom:12px">${[today, ...keys.filter((k) => k !== today)]
      .slice(0, 7)
      .map((k) => `<button type="button" data-aday="${k}" class="${k === sel ? 'on' : ''}">${esc(k === today ? 'Hoy' : dayName(k))}</button>`)
      .join('')}</div>
    <div class="card pad">
      <div class="overline" style="text-transform:none;font-size:13px;color:var(--text)">${esc(dayName(sel, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</div>
      <div class="tiles" style="margin-top:10px">
        <div class="tile"><div class="overline">Efectividad</div><div class="val ${s.pct >= 55 ? 'pos' : s.pct != null && s.pct < 50 ? 'neg' : ''}">${pct(s.pct)}</div><div class="hint">${s.n} jugados${pending ? ` · ${pending} pendientes` : ''}</div></div>
        <div class="tile"><div class="overline">Ganados</div><div class="val pos">${s.hit}</div><div class="hint">aciertos</div></div>
        <div class="tile"><div class="overline">Perdidos</div><div class="val neg">${s.miss}</div><div class="hint">fallos</div></div>
      </div>
      <div class="tiles" style="margin-top:8px">
        <div class="tile"><div class="overline">Unidades</div><div class="val ${s.units > 0 ? 'pos' : s.units < 0 ? 'neg' : ''}">${s.withO ? unitsTxt(s.units) : '—'}</div><div class="hint">1u a cada pick con cuota (${s.withO})</div></div>
        ${bands
          .slice(0, 2)
          .map(([t, b]) => `<div class="tile"><div class="overline">${t}</div><div class="val">${pct(b.pct)}</div><div class="hint">${b.hit} de ${b.n}</div></div>`)
          .join('')}
      </div>
      <p class="note" style="margin:10px 0 0">Parejos (50–54%): ${bands[2][1].hit} de ${bands[2][1].n}${bands[2][1].n ? ` (${pct(bands[2][1].pct)})` : ''}.</p>
    </div>
    ${chart}
    ${
      list.length
        ? `<div class="card scroll-x" style="margin-top:12px"><table class="ledger"><thead><tr><th>Hora</th><th>Partido</th><th>Pick</th><th class="num">Cuota</th><th class="num">Resultado</th></tr></thead><tbody>
      ${list
        .map(
          (x) => `<tr data-open="${x.id}" style="cursor:pointer"><td>${fmtTime(x.at)}</td><td class="who">${esc(x.a)} vs ${esc(x.b)}${x.ph ? `<small>${esc(x.ph)}</small>` : ''}</td><td>${esc(x.fav)} <span class="conf${x.c < PAREJO ? ' low' : ''}">${x.c}%</span></td><td class="num">${odds(x.o)}</td><td class="num ${x.res === 'hit' ? 'pos-t' : 'neg-t'}">${x.res === 'hit' ? '✓ Ganado' : '✗ Perdido'}</td></tr>`
        )
        .join('')}</tbody></table></div>`
        : `<p class="note" style="margin-top:12px">Todavía no hay picks jugados este día.</p>`
    }`;
  // La gráfica arranca mostrando el día elegido (por defecto, el más reciente).
  const sc = box.querySelector('.dchart')?.parentElement;
  const on = box.querySelector('.dcol.on');
  if (sc) sc.scrollLeft = on ? on.getBoundingClientRect().left - sc.getBoundingClientRect().left + sc.scrollLeft - sc.clientWidth / 2 + on.clientWidth / 2 : sc.scrollWidth;
}

// Pantalla propia del admin para el chat (la abre el botón flotante).
function viewSoporte() {
  if (!isAdmin()) return `<div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Soporte en vivo</h1></div>${empty('shield', 'Solo administrador', 'Entra con la cuenta admin para ver las conversaciones.')}`;
  setTimeout(() => {
    startAdminChats();
    renderAdminChats();
  }, 0);
  return `
  <div class="subhead"><a class="back" href="javascript:history.back()">${icon('left')} Atrás</a><h1>Soporte en vivo</h1></div>
  <div class="section-h" id="admin-chats"><h2>💬 Conversaciones</h2><span class="badge" id="admin-chats-count"></span></div>
  <div id="admin-chats-box">${skeleton(2)}</div>
  ${footer()}`;
}

// ---------- Soporte en vivo: conversaciones (solo admin) ----------
// Se escuchan en vivo desde que entra la cuenta admin: el botón flotante
// muestra un punto si hay mensajes sin leer y el panel se actualiza solo.
let adminChats = null;
let adminChatsErr = null;
let adminChatUnsub = null;
let adminChatDel = null; // uid con "¿seguro?" de borrar pendiente
let adminSeenIds = null; // mensajes ya vistos (para sonar solo con los nuevos)

function startAdminChats() {
  if (adminChatUnsub || !isAdmin()) return;
  adminChatUnsub = true;
  FB.adminWatchChats((list, err) => {
    // Sonido y vibración cuando un usuario escribe (no en la primera carga).
    if (list) {
      const ids = new Set(list.flatMap((c) => (c.msgs || []).map((m) => m.id)));
      // Solo cuando te necesitan (pidió persona): lo que responde la IA no suena.
      if (adminSeenIds && list.some((c) => c.human && (c.msgs || []).some((m) => m.r === 'u' && !adminSeenIds.has(m.id)))) messageFx();
      adminSeenIds = ids;
    }
    adminChats = list;
    adminChatsErr = list ? null : err;
    adminIdleSweep();
    const dot = document.querySelector('#chat-fab .chat-dot');
    if (dot) dot.hidden = !(list || []).some((c) => c.unreadAdmin);
    renderAdminChats();
  })
    .then((fn) => (adminChatUnsub = fn))
    .catch((e) => {
      adminChatsErr = e;
      renderAdminChats();
    });
}

// Cierre por inactividad también desde el lado del admin (por si el usuario
// se fue del sitio): se revisa con cada cambio y cada 30 s.
let adminChatEnd = null; // uid con "¿Quedó resuelto?" abierto
function adminIdleSweep() {
  for (const c of adminChats || []) {
    const due = chatIdleDue(c.msgs);
    if (due) FB.adminAppend(c.id, chatClosingMsgs('auto', null, due), { human: false, unreadAdmin: false }, (cur) => !chatClosed(cur)).catch(() => {});
  }
}
setInterval(() => isAdmin() && adminIdleSweep(), 30e3);

async function adminEndChat(uid, res) {
  adminChatEnd = null;
  endFx();
  await FB.adminAppend(uid, chatClosingMsgs('admin', res), { human: false, unreadAdmin: false, unreadUser: true }, (cur) => !chatClosed(cur)).catch((e) => toast(e.message));
  renderAdminChats();
}

function renderAdminChats() {
  const box = document.getElementById('admin-chats-box');
  if (!box) return;
  if (adminChatsErr) {
    box.innerHTML = `<div class="note">No se pudieron leer las conversaciones (${esc(adminChatsErr.code || adminChatsErr.message)}). Revisa que las reglas de Firestore tengan la parte de "chats".</div>`;
    return;
  }
  if (!adminChats) {
    box.innerHTML = skeleton(1);
    return;
  }
  const count = document.getElementById('admin-chats-count');
  const pend = adminChats.filter((c) => c.unreadAdmin).length;
  if (count) count.textContent = pend ? `${pend} sin leer` : `${adminChats.length}`;
  if (!adminChats.length) {
    box.innerHTML = '<p class="note">Todavía nadie ha escrito al chat. Cuando alguien toque "Hablar con una persona", te aparece aquí y te llega una notificación al celular (si las tienes activadas).</p>';
    return;
  }
  const sel = adminChats.find((c) => c.id === ui.chatSel);
  const who = { u: null, ai: 'IA', admin: 'Tú' };
  const when = (iso) => (iso ? `${dayLabel(dayKey(iso))} ${fmtTime(iso)}` : '');
  const rows = adminChats
    .map((c) => {
      const last = (c.msgs || []).slice(-1)[0];
      const closed = chatClosed(c.msgs);
      return `<button type="button" class="row chat-row ${c.id === ui.chatSel ? 'on' : ''}" data-chatsel="${esc(c.id)}">
        ${chatAvatar('u', c.photo, c.name || c.email)}
        <span class="tx"><b>${esc(c.name || c.email || 'Usuario')}${c.unreadAdmin ? ' <span class="badge red">Nuevo</span>' : ''}${closed ? ' <span class="badge">Cerrado</span>' : c.human ? ' <span class="badge">Pide persona</span>' : ''}</b><small>${esc(when(c.lastAt))} · ${esc((last?.t || '').slice(0, 70))}</small></span>
      </button>`;
    })
    .join('');
  const thread = sel
    ? `<div class="card pad chat-thread">
      <div class="block-h" style="margin:0 0 8px"><div style="display:flex;align-items:center;gap:10px">${chatAvatar('u', sel.photo, sel.name || sel.email)}<div><b>${esc(sel.name || 'Usuario')}</b><small style="display:block;color:var(--muted)">${esc(sel.email || '')}</small></div></div><button type="button" class="mini-btn" data-chatsel="">Cerrar</button></div>
      <div class="chat-body admin" id="admin-chat-body">${(sel.msgs || [])
        .map((m) =>
          m.r === 'sys'
            ? `<div class="chat-sys ${m.res === 'yes' ? 'ok' : m.res === 'no' ? 'ko' : ''}">${icon(m.res === 'yes' ? 'checkc' : m.by === 'auto' ? 'clock' : 'info')}<span>${esc(m.t)} · ${esc(when(m.at))}</span></div>`
            : `<div class="cline ${m.r === 'admin' ? 'me' : ''}">${m.r === 'u' ? chatAvatar('u', sel.photo, sel.name || sel.email) : m.r === 'admin' ? chatAvatar('admin', userPhoto(), userName()) : chatAvatar('ai')}<div class="cmsg ${m.r === 'u' ? 'ai' : m.r === 'admin' ? 'me' : 'bot'}"><small>${esc(m.r === 'u' ? sel.name || 'Usuario' : m.auto ? 'Mensaje automático' : who[m.r])} · ${esc(when(m.at))}</small><div class="bub">${chatFmt(m.t)}</div></div></div>`
        )
        .join('')}</div>
      <form id="admin-chat-form" class="chat-form" style="margin-top:10px" autocomplete="off"><textarea name="msg" rows="2" maxlength="1000" placeholder="${chatClosed(sel.msgs) ? 'Chat cerrado: si escribes, se abre de nuevo…' : 'Escribe tu respuesta…'}" required></textarea><button class="chat-send" type="submit" aria-label="Enviar">${icon('send')}</button></form>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        ${
          chatClosed(sel.msgs)
            ? ''
            : adminChatEnd === sel.id
            ? `<span style="font-size:13px;font-weight:700">¿Quedó resuelto?</span>
               <button type="button" class="mini-btn ok" data-chatend="yes">Resuelto</button>
               <button type="button" class="mini-btn" data-chatend="no">Sin resolver</button>
               <button type="button" class="textlink" data-chatend="">Cancelar</button>`
            : `<button type="button" class="mini-btn" data-chatendask="${esc(sel.id)}">${icon('x')} Finalizar chat</button>`
        }
        <button type="button" class="mini-btn" data-chatdel="${esc(sel.id)}">${adminChatDel === sel.id ? '¿Seguro? Toca otra vez para borrar' : 'Borrar conversación'}</button>
      </div>
    </div>`
    : '';
  // Si llega un mensaje mientras escribes, no se pierde lo escrito.
  const oldTa = box.querySelector('#admin-chat-form textarea');
  const draft = oldTa?.value || '';
  const hadFocus = oldTa && document.activeElement === oldTa;
  box.innerHTML = `${thread}<div class="list" style="margin-top:${sel ? 12 : 0}px">${rows}</div>`;
  const newTa = box.querySelector('#admin-chat-form textarea');
  if (newTa && draft) newTa.value = draft;
  if (newTa && hadFocus) newTa.focus();
  const body = document.getElementById('admin-chat-body');
  if (body) body.scrollTop = body.scrollHeight;
  if (sel?.unreadAdmin) FB.adminMarkRead(sel.id).catch(() => {});
}

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'admin-chat-form') return;
  ev.preventDefault();
  const ta = ev.target.querySelector('textarea');
  const text = ta.value.trim();
  if (!text || !ui.chatSel) return;
  ta.value = ''; // se vacía antes: la lista se redibuja en vivo al llegar la respuesta
  sendFx();
  try {
    await FB.adminReply(ui.chatSel, text, userPhoto());
  } catch (e) {
    const cur = document.querySelector('#admin-chat-form textarea');
    if (cur && !cur.value) cur.value = text;
    toast(`No se pudo enviar: ${e.code || e.message}`);
  }
});

async function renderAdminPanel() {
  if (!isAdmin()) return;
  renderAdminDaily();
  startAdminChats();
  renderAdminChats();
  // Picks del tipster publicados
  const tbox = document.getElementById('admin-tipster');
  const tips = (await loadTipster(true)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const byId = allById();
  if (tbox)
    tbox.innerHTML = tips.length
      ? `<div class="list" style="margin-top:10px">${tips
          .slice(0, 20)
          .map((t) => {
            const m = byId.get(Number(t.mid));
            const res = m && m.st === 'f' ? (m.w === t.fav ? '✅' : '❌') : '⏳';
            return `<div class="row"><span class="ic">${res}</span><span class="tx"><b>${esc(t.favName)} gana</b><small>${esc(dayLabel(dayKey(t.at)))} ${fmtTime(t.at)} · vs ${esc(t.opName)}${t.note ? ' · ' + esc(t.note) : ''}</small></span><button class="mini-btn" data-tdel="${esc(t.id)}">Borrar</button></div>`;
          })
          .join('')}</div>`
      : '<p class="note" style="margin-top:10px">Aún no has publicado picks del tipster.</p>';
  // Miembros (acceso al sitio)
  renderMembers();
  // Visitas por día
  const vbox = document.getElementById('admin-visits');
  try {
    const [days, c, priv] = await Promise.all([FB.visitsByDay(14), FB.getCounters(), FB.loadAdminLedger().catch(() => ({}))]);
    adminUsers = priv.users ?? null;
    const max = Math.max(1, ...days.map((x) => x.count));
    if (vbox)
      vbox.innerHTML = `<div class="card pad"><div class="tiles" style="margin:0 0 12px"><div class="tile"><div class="overline">Hoy</div><div class="val">${fmtInt(c.today)}</div></div><div class="tile"><div class="overline">Total</div><div class="val">${fmtInt(c.total)}</div></div><div class="tile"><div class="overline">Usuarios</div><div class="val">${(adminUsers ?? '—')}</div></div></div>
        <div class="bars">${days.map((x) => `<div class="b" title="${x.d}: ${x.count}"><i class="h" style="height:${(x.count / max) * 100}px;background:var(--red)"></i></div>`).join('')}</div>
        <div class="bars-x"><span>${esc(days[0].d.slice(5))}</span><span>${esc(days[days.length - 1].d.slice(5))}</span></div></div>`;
  } catch (e) {
    if (vbox) vbox.innerHTML = `<p class="note">No se pudieron leer las visitas (${esc(e.code || e.message)}).</p>`;
  }
  // Usuarios
  const ubox = document.getElementById('admin-users');
  try {
    const users = (await FB.listUsers()).sort((a, b) => ((a.created || '') < (b.created || '') ? 1 : -1));
    if (ubox)
      ubox.innerHTML = `<div class="list">${users
        .map((u) => `<div class="row"><span class="ic">${esc(initials(u.name || u.email))}</span><span class="tx"><b>${esc(u.name || '—')}</b><small>${esc(u.email)} · ${u.created ? esc(new Date(u.created).toLocaleDateString(LOC())) : ''} · ${u.follows} seguidos${u.push ? ' · 🔔' : ''}</small></span></div>`)
        .join('')}</div><p class="foot">${users.length} usuarios registrados</p>`;
  } catch (e) {
    if (ubox) ubox.innerHTML = `<p class="note">No se pudo leer la lista (${esc(e.code || e.message)}). Hay que actualizar las reglas de Firestore.</p>`;
  }
}

async function renderMembers() {
  const box = document.getElementById('admin-members');
  if (!box) return;
  try {
    const list = (await FB.adminListMembers()).sort((a, b) => (b.until?.getTime() || 0) - (a.until?.getTime() || 0));
    const now = Date.now();
    box.innerHTML = list.length
      ? `<div class="list" style="margin-top:10px">${list
          .map((x) => {
            const active = x.until && x.until.getTime() > now;
            const left = active ? Math.ceil((x.until.getTime() - now) / 86400e3) : 0;
            return `<div class="row"><span class="ic">${active ? '⭐' : '⌛'}</span><span class="tx"><b>${esc(x.email)}</b><small>${active ? `Activo · vence ${esc(left <= 2 ? x.until.toLocaleString(LOC(), { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }) : x.until.toLocaleDateString(LOC()))} (${left} ${left === 1 ? 'día' : 'días'})` : `Vencido${x.until ? ' el ' + esc(x.until.toLocaleDateString(LOC())) : ''}`}</small></span><button class="mini-btn" data-mquit="${esc(x.email)}">Quitar</button></div>`;
          })
          .join('')}</div><p class="foot">${list.filter((x) => x.until && x.until.getTime() > now).length} activos · ${list.length} en total</p>`
      : '<p class="note" style="margin-top:10px">Todavía no hay miembros.</p>';
  } catch (e) {
    box.innerHTML = `<p class="note">No se pudo leer (${esc(e.code || e.message)}). Hay que actualizar las reglas de Firestore.</p>`;
  }
}

let memberDays = 30;
document.addEventListener('click', async (ev) => {
  const d = ev.target.closest('[data-mdays]');
  if (d) {
    memberDays = Number(d.dataset.mdays);
    document.querySelectorAll('[data-mdays]').forEach((b) => b.classList.toggle('on', b === d));
    return;
  }
  const q = ev.target.closest('[data-mquit]');
  if (q && isAdmin()) {
    if (q.dataset.confirm !== '1') {
      q.dataset.confirm = '1';
      q.textContent = '¿Seguro?';
      return;
    }
    await FB.adminRemoveMember(q.dataset.mquit);
    toast('Acceso quitado');
    renderMembers();
  }
});
document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'member-form') return;
  ev.preventDefault();
  const email = String(new FormData(ev.target).get('email') || '').trim().toLowerCase();
  if (!email.includes('@')) return toast('Escribe un correo válido');
  try {
    const until = await FB.adminSetMember(email, memberDays);
    toast(`⭐ Acceso activo para ${email} hasta ${memberDays === 1 ? until.toLocaleString(LOC(), { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }) : until.toLocaleDateString(LOC())}`);
    ev.target.reset();
    renderMembers();
  } catch (e) {
    toast(e.code === 'permission-denied' ? 'Falta actualizar las reglas de Firestore' : FB.errorText(e));
  }
});

// Tarjeta del pick del tipster en Inicio (el próximo que no ha empezado).
async function renderTipsterHome() {
  const box = document.getElementById('tipster-home');
  if (!box) return;
  const tips = await loadTipster();
  const byId = allById();
  const now = Date.now();
  const upcoming = tips.filter((t) => new Date(t.at).getTime() > now - 3 * 3600e3).sort((a, b) => (a.at < b.at ? -1 : 1));
  const st = data.stats?.tipster;
  const head = `<div class="section-h"><h2>👑 Pick del tipster</h2>${st && st.hit + st.miss ? `<span class="badge win">${st.hit}/${st.hit + st.miss} aciertos</span>` : ''}</div>`;
  if (!upcoming.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    head +
    upcoming
      .slice(0, 3)
      .map((t) => {
        const m = byId.get(Number(t.mid));
        if (!m) return '';
        const card = matchCard(m, { fav: t.fav, c: null, tipster: true, o: m.pick?.o ?? m.o, res: m.st === 'f' ? (m.w === t.fav ? 'hit' : 'miss') : 'pending' });
        return `<div class="tipster-wrap">${card}${t.note ? `<p class="tipster-note">💬 ${esc(t.note)}</p>` : ''}</div>`;
      })
      .join('');
}

// ---------- Perfil de jugador ----------
function viewJugador(id) {
  setTimeout(() => renderJugador(Number(id)), 0);
  return `<div class="subhead"><a class="back" href="javascript:history.back()">${icon('left')} Atrás</a><h1>Jugador</h1></div><div id="player-page">${skeleton(3)}</div>`;
}

async function renderJugador(id) {
  const box = document.getElementById('player-page');
  if (!box) return;
  let d;
  try {
    d = await getJson(`players/${id}`);
  } catch {
    box.innerHTML = empty('user', 'Sin ficha', 'Este jugador no tiene partidos recientes en nuestros datos.');
    return;
  }
  const p = d.p;
  const pctM = d.month.w + d.month.l ? Math.round((d.month.w / (d.month.w + d.month.l)) * 100) : null;
  const form = d.last.slice(0, 10).map((x) => (x.w ? 'W' : 'L')).join('');
  const upcoming = data.calendar.matches.filter((m) => m.st !== 'f' && (m.a.id === id || m.b.id === id));
  const photo = p.cut
    ? `<img class="fc-cut" src="${esc(p.cut)}" alt="">`
    : p.th || p.av
    ? `<img class="fc-raw" src="${esc(p.th || p.av)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="fc-ini">${esc(initials(p.n))}</span>`;
  const fmtD = (iso) => new Intl.DateTimeFormat(LOC(), { day: '2-digit', month: '2-digit', timeZone: TZ }).format(new Date(iso));
  box.innerHTML = `
  <div class="player-hero">
    <div class="fc-photo">${photo}<span class="fc-flag"><svg viewBox="0 0 30 20"><rect width="30" height="10" fill="#fff"/><rect y="10" width="30" height="10" fill="#d7141a"/><path d="M0 0 15 10 0 20z" fill="#11457e"/></svg></span></div>
    <div class="ph-info">
      <h2>${esc(p.n)}</h2>
      <div class="ph-sub">Liga Pro Checa · Rating <b>${p.r ?? '—'}</b></div>
      ${d.streak >= 3 ? `<span class="badge win">🔥 ${d.streak} victorias seguidas</span>` : d.streak <= -3 ? `<span class="badge loss">${-d.streak} derrotas seguidas</span>` : ''}
      <div style="margin-top:10px">${formDots(form, 10, 'form lg')}</div>
    </div>
  </div>
  <div class="tiles">
    <div class="tile"><div class="overline">Últimos 30 días</div><div class="val">${pctM == null ? '—' : pctM + '%'}</div><div class="hint">${d.month.w}G · ${d.month.l}P</div></div>
    <div class="tile"><div class="overline">Racha</div><div class="val ${d.streak > 0 ? 'pos' : d.streak < 0 ? 'neg' : ''}">${d.streak > 0 ? d.streak + 'W' : d.streak < 0 ? -d.streak + 'L' : '—'}</div><div class="hint">actual</div></div>
    <div class="tile"><div class="overline">Títulos</div><div class="val">${d.titles.count} 🏆</div><div class="hint">torneos ganados</div></div>
  </div>
  ${upcoming.length ? `<div class="section-h"><h2>${icon('clock')} Próximos partidos</h2></div><div class="grid-2">${upcoming.map((m) => matchCard(m)).join('')}</div>` : ''}
  <div class="section-h"><h2>Últimos partidos</h2><span class="badge">${d.last.length}</span></div>
  <div class="h2h-list">${d.last
    .map(
      (x) => `<div class="pl-row" data-open="${x.id}">
        <div class="h2h-date">${fmtD(x.at)} ${fmtTime(x.at)}<small>${esc(x.ph ? `${x.ph} · ${x.tn}` : x.tn)}</small></div>
        <div class="pl-op" data-player="${x.op.id}">${avatar(x.op, 'avatar sm')}<span>vs ${esc(x.op.n)}</span></div>
        <div class="pl-res"><b>${esc(x.s)}</b><span class="h2h-res ${x.w ? 'w' : 'l'}">${x.w ? 'G' : 'P'}</span></div>
      </div>`
    )
    .join('')}</div>
  ${
    d.rivals.length
      ? `<div class="section-h"><h2>Rivales frecuentes</h2></div><div class="h2h-list">${d.rivals
          .map((r) => {
            const tot = r.w + r.l;
            return `<div class="pl-row" data-player="${r.p.id}" style="cursor:pointer">
              <div class="pl-op">${avatar(r.p, 'avatar sm')}<span>${esc(r.p.n)}</span></div>
              <div class="pl-bar"><span style="width:${(r.w / tot) * 100}%"></span></div>
              <div class="pl-res"><b>${r.w}-${r.l}</b></div>
            </div>`;
          })
          .join('')}</div>`
      : ''
  }
  ${
    d.titles.recent.length
      ? `<div class="section-h"><h2>🏆 Torneos ganados</h2><span class="badge">${d.titles.count}</span></div><div class="list">${d.titles.recent
          .map((t) => `<div class="row"><span class="ic">🏆</span><span class="tx"><b>${esc(t.tn)}</b><small>${esc(new Intl.DateTimeFormat(LOC(), { day: 'numeric', month: 'long', timeZone: TZ }).format(new Date(t.at)))}</small></span></div>`)
          .join('')}</div>`
      : ''
  }
  ${footer()}`;
}

function hotHtml() {
  const list = data.stats?.hot || [];
  if (!list.length) return '';
  return `<div class="section-h"><h2>🔥 Jugadores en racha</h2></div>
  <div class="hot-strip">${list
    .map(
      (h) => `<button class="hot-chip" data-player="${h.p.id}">${avatar(h.p, 'avatar')}<b>${esc(h.p.n)}</b><span class="badge win">${h.streak}W 🔥</span><small>${h.w7}-${h.l7} en 7 días</small></button>`
    )
    .join('')}</div>`;
}

// Campeones (ganadores de la final) de los torneos de las últimas horas.
function championsHtml() {
  const list = data.stats?.champions || [];
  if (!list.length) return '';
  return `
  <div class="section-h"><h2>👑 Campeones</h2><span class="badge">${list.length}</span></div>
  <div class="fgrid">${list
    .map((c) => {
      // Recorte mediano (260 px): la tarjeta es chica; el grande (420 px) solo en el perfil.
      const photo = c.champ.md || c.champ.cut
        ? `<img class="fc-cut" src="${esc(c.champ.md || c.champ.cut)}" alt="" loading="lazy">`
        : c.champ.th || c.champ.av
        ? `<img class="fc-raw" src="${esc(c.champ.th || c.champ.av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
        : `<span class="fc-ini">${esc(initials(c.champ.n))}</span>`;
      return `<article class="fcard champ" data-player="${c.champ.id}" style="cursor:pointer">
        <div class="fc-photo">${photo}<span class="crown">👑</span><span class="fc-flag"><svg viewBox="0 0 30 20"><rect width="30" height="10" fill="#fff"/><rect y="10" width="30" height="10" fill="#d7141a"/><path d="M0 0 15 10 0 20z" fill="#11457e"/></svg></span></div>
        <div class="fc-body">
          <small class="fc-league">${esc(c.tn)}</small>
          <b class="fc-name">${esc(c.champ.n)}</b>
          <span class="fc-pill champ-pill">🏆 CAMPEÓN</span>
          <small class="fc-sub"><b style="color:var(--text)">${c.isFinal ? 'Final' : 'Último'} ${esc(c.score)}</b> vs ${esc(c.rival.n)}</small>
          <small class="fc-sub">${esc(dayLabel(dayKey(c.at)))} · ${new Intl.DateTimeFormat(LOC(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(new Date(c.at))}</small>
          <small class="fc-sub">Ganó ${c.wins} de ${c.played}</small>
        </div>
      </article>`;
    })
    .join('')}</div>`;
}

// Actualiza un contenedor de tarjetas en vivo sin redibujarlo: si siguen
// los mismos partidos, solo cambia las partes marcadas con data-u (números
// y saque). Si cambió la lista de partidos, ahí sí lo redibuja entero.
function patchLive(box, html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const ids = (root) => [...root.querySelectorAll('[data-ev]')].map((x) => x.dataset.ev).join(',');
  if (!box.querySelector('[data-ev]') || ids(box) !== ids(tmp)) {
    box.innerHTML = html;
    return;
  }
  tmp.querySelectorAll('[data-u]').forEach((n) => {
    const cur = box.querySelector(`[data-u="${n.dataset.u}"]`);
    if (cur && cur.innerHTML !== n.innerHTML) cur.innerHTML = n.innerHTML;
  });
}

// Punto rojo en la pestaña En vivo cuando hay partidos de la Liga Pro en juego.
function liveDot(state) {
  const d = document.getElementById('tab-live-dot');
  if (d && state.at) d.hidden = !state.liga.length;
}

function renderLiveHome(state) {
  liveDot(state);
  const box = document.getElementById('live-home');
  if (!box) return;
  const ours = data.calendar.matches;
  const list = state.liga.length ? state.liga : [];
  if (!state.at) return;
  if (!list.length) {
    // Sin partidos en vivo: los campeones de los torneos recientes.
    const html = `<div class="note">No hay partidos de la Liga Pro Checa en vivo en este momento.</div>${championsHtml()}`;
    if (box.dataset.html !== html) {
      box.innerHTML = html;
      box.dataset.html = html; // no se redibuja cada 2 s (las fotos no parpadean)
    }
    return;
  }
  delete box.dataset.html;
  patchLive(box, list.map((e) => liveCard(e, ourMatchForLive(e))).join(''));
}

function viewCalendario() {
  const days = data.calendar.days;
  if (!days.length) return `<h1 class="page-title">Calendario</h1>${data.loaded ? errorBox() || empty('calendar', 'Sin partidos', 'Aún no hay partidos cargados.') : skeleton(4)}`;
  ui.day = Math.max(0, Math.min(days.length - 1, ui.day));
  const key = days[ui.day];
  const dayList = data.calendar.matches.filter((m) => dayKey(m.at) === key);
  const total = dayList.length;
  // Estado de cada partido: terminado / en vivo / próximo.
  const stateOf = (m) => (m.st === 'f' ? 'done' : m.st === 'l' || liveFor(m) || new Date(m.at).getTime() <= Date.now() ? 'live' : 'next');
  const counts = { next: 0, live: 0, done: 0 };
  dayList.forEach((m) => counts[stateOf(m)]++);
  if (ui.calView !== 'next' && ui.calView !== 'done') ui.calView = 'next';
  let list = dayList.filter((m) => stateOf(m) === ui.calView);
  // Resultados: del más reciente al más antiguo (por hora de juego).
  if (ui.calView === 'done') list.sort((a, b) => new Date(b.at) - new Date(a.at) || b.id - a.id);
  if (ui.calFilter === 'pick') list = list.filter((m) => m.pick);
  // Agrupado por torneo, en orden de hora.
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.t)) groups.set(m.t, { name: m.tn, at: m.at, items: [] });
    groups.get(m.t).items.push(m);
  }
  return `
  <h1 class="page-title">Calendario</h1>
  <div class="page-sub"><i class="live-dot"></i>${total} partidos · ${esc(dayLabel(key))}</div>
  <div class="toolbar">
    <div class="daynav">
      <button data-day="-1" ${ui.day === 0 ? 'disabled' : ''} aria-label="Día anterior">${icon('left')}</button>
      <b>${esc(dayLabel(key))}</b>
      <button data-day="1" ${ui.day === days.length - 1 ? 'disabled' : ''} aria-label="Día siguiente">${icon('right')}</button>
    </div>
    <button class="chip-btn ${ui.calFilter === 'pick' ? 'on' : ''}" data-calf="${ui.calFilter === 'pick' ? 'all' : 'pick'}">${icon('flame')} Con pick</button>
  </div>
  <div class="seg seg-full" style="margin-bottom:14px">
    <button data-calv="next" class="${ui.calView === 'next' ? 'on' : ''}">Próximos <em>${counts.next}</em></button>
    <button data-calv="done" class="${ui.calView === 'done' ? 'on' : ''}">Resultados <em>${counts.done}</em></button>
  </div>
  ${
    ui.calView === 'done' && list.length
      ? `<div class="grid-2">${list.map((m) => matchCard(m)).join('')}</div>`
      : groups.size
      ? [...groups.values()]
          .map(
            (g) => `<div class="section-h"><h2 style="font-size:14px">${esc(g.name)}</h2><span class="badge">${fmtTime(g.at)}</span></div>
            <div class="grid-2">${g.items.map((m) => matchCard(m)).join('')}</div>`
          )
          .join('')
      : empty(
          ui.calView === 'live' ? 'live' : 'calendar',
          ui.calView === 'live' ? 'Nada en vivo' : ui.calView === 'done' ? 'Sin resultados todavía' : 'Sin partidos por jugar',
          ui.calView === 'live'
            ? 'No hay partidos de este día en juego ahora. Mira la pestaña En vivo para todas las ligas.'
            : ui.calView === 'done'
            ? 'Aún no termina ningún partido de este día' + (ui.calFilter === 'pick' ? ' con pick.' : '.')
            : 'No quedan partidos por jugar este día' + (ui.calFilter === 'pick' ? ' con pick.' : '.')
        )
  }
  ${footer()}`;
}

// Solo picks de partidos que todavía no empiezan (los en vivo/jugados van a
// Calendario y a la pestaña En vivo).
function upcomingPicks() {
  const now = Date.now();
  return data.picks.filter((p) => p.st === 's' && new Date(p.at).getTime() > now && !liveFor(p));
}

function viewPicks() {
  let list = upcomingPicks();
  if (ui.pickFilter === 'high') list = list.filter((p) => p.locked || p.premium || p.c >= 60);
  if (ui.pickFilter === 'odds') list = list.filter((p) => p.o && p.o >= 1.6);
  return `
  <h1 class="page-title">Predicciones</h1>
  <div class="page-sub"><i class="live-dot"></i>${upcomingPicks().length} próximos picks · ${esc(longDate())}</div>
  <div class="toolbar">
    <div class="seg">
      <button data-pf="all" class="${ui.pickFilter === 'all' ? 'on' : ''}">Todos</button>
      <button data-pf="high" class="${ui.pickFilter === 'high' ? 'on' : ''}">Alta confianza</button>
      <button data-pf="odds" class="${ui.pickFilter === 'odds' ? 'on' : ''}">Cuota +1.60</button>
    </div>
  </div>
  <div class="card pad" style="display:flex;align-items:center;gap:10px;font-size:13px">${icon('clock')}<span style="flex:1">Se actualiza solo cada ~5 min${data.stats?.updatedAt ? ` · última: <b>${fmtTime(data.stats.updatedAt)}</b>` : ''}</span></div>
  <div style="margin-top:12px">${!data.loaded ? skeleton(3) : list.length ? `<div class="grid-2">${list.map((p) => matchCard(p, p)).join('')}</div>` : errorBox() || empty('flame', 'Sin picks en este filtro', 'Los picks se publican unas horas antes de cada torneo.')}</div>
  ${footer()}`;
}

const FOLLOW_RANGES = [
  ['d7', 'Últimos 7 días', 7],
  ['d30', 'Últimos 30 días', 30],
  ['all', 'Todo', 99999]
];

// Tarjeta de pick seguido (estilo de la referencia: foto grande del
// jugador elegido, estado arriba a la derecha, píldora y barra de sets).
function followCard(p) {
  const favA = p.fav === p.a.id;
  const fav = favA ? p.a : p.b;
  const riv = favA ? p.b : p.a;
  const lv = liveFor(p);
  let favSets = null;
  if (p.st === 'f' && p.sa != null) favSets = favA ? p.sa : p.sb;
  else if (lv) favSets = favA ? lv.setsHome : lv.setsAway;
  const rivSets = p.st === 'f' && p.sa != null ? (favA ? p.sb : p.sa) : lv ? (favA ? lv.setsAway : lv.setsHome) : null;
  const status =
    p.res === 'hit'
      ? '<span class="fc-st hit" title="Acertado">✓</span>'
      : p.res === 'miss'
      ? '<span class="fc-st miss" title="Fallado">✕</span>'
      : lv
      ? '<span class="fc-st live" title="En vivo"><i></i></span>'
      : '';
  const pillCls = p.res === 'hit' ? 'win' : p.res === 'miss' ? 'loss' : 'pend';
  const tn = (p.tn || '').replace(/^Tournament\s*/i, '');
  const score = favSets != null ? `<span class="fc-score ${lv ? 'live' : ''}">${favSets}-${rivSets}${lv ? ` · ${esc(lv.ptsHome)}:${esc(lv.ptsAway)}` : ''}</span>` : '';
  // Foto: recorte sin fondo si existe; si no, la foto original encuadrada.
  const photo = fav.md || fav.cut
    ? `<img class="fc-cut" src="${esc(fav.md || fav.cut)}" alt="" loading="lazy">`
    : fav.th || fav.av
    ? `<img class="fc-raw" src="${esc(fav.th || fav.av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `
  <article class="fcard ${p.res === 'miss' ? 'is-miss' : ''}" data-open="${p.id}" data-match="${p.id}" data-ev="f${p.id}">
    <div class="fc-photo">
      ${photo || `<span class="fc-ini">${esc(initials(fav.n))}</span>`}
      <span data-u="f${p.id}-st" style="display:contents">${status}</span>
      <span class="fc-flag" title="República Checa"><svg viewBox="0 0 30 20"><rect width="30" height="10" fill="#fff"/><rect y="10" width="30" height="10" fill="#d7141a"/><path d="M0 0 15 10 0 20z" fill="#11457e"/></svg></span>
    </div>
    <div class="fc-body">
      <small class="fc-league">${esc(p.ph ? `${p.ph} · ${tn}` : `Tournament ${tn}`)}</small>
      <b class="fc-name">${esc(fav.n)}</b>
      <small class="fc-sub">vs ${esc(riv.n)} · ${new Intl.DateTimeFormat(LOC(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(new Date(p.at))}</small>
      <span class="fc-pill ${pillCls}">${esc(fav.n.toUpperCase())} GANA</span>
      <span data-u="f${p.id}-sc" style="display:contents">${score}</span>
      <div class="fc-conf"><div class="fc-bar"><span style="width:${Math.max(8, ((p.c - 50) / 30) * 100)}%"></span></div><b>${p.c}</b></div>
    </div>
  </article>`;
}

// ---------- En vivo: todos los partidos de tenis de mesa en juego ----------
function viewEnVivo() {
  return `
  <h1 class="page-title">En vivo</h1>
  <div class="page-sub"><i class="live-dot red"></i><span id="live-count">Cargando...</span></div>
  <div class="toolbar"><div class="seg">
    <button data-lf="all" class="${ui.liveFilter === 'all' ? 'on' : ''}">Todos</button>
    <button data-lf="pick" class="${ui.liveFilter === 'pick' ? 'on' : ''}">Con pick</button>
  </div></div>
  <div id="live-page">${skeleton(3)}</div>
  ${footer()}`;
}

function renderLivePage(state) {
  liveDot(state);
  const box = document.getElementById('live-page');
  if (!box || !state.at) return;
  // Solo la Liga Pro Checa.
  const ours = data.calendar.matches;
  let list = state.liga.map((e) => ({ e, m: ourMatchForLive(e) }));
  if (ui.liveFilter === 'pick') list = list.filter((x) => x.m?.pick);
  document.getElementById('live-count').textContent = `Liga Pro Checa · ${state.liga.length} ${state.liga.length === 1 ? 'partido' : 'partidos'} en juego · se actualiza cada 2 s`;
  if (!list.length) {
    box.innerHTML = empty(
      'live',
      'Nada en vivo ahora',
      ui.liveFilter === 'all' ? 'No hay partidos de la Liga Pro Checa en juego en este momento. Mira los próximos en Calendario.' : 'Ningún partido con pick se está jugando ahora.'
    );
    return;
  }
  patchLive(box, `<div class="grid-2">${list.map((x) => liveCard(x.e, x.m)).join('')}</div>`);
}

function viewSeguidos() {
  const map = allById();
  const range = FOLLOW_RANGES.find((r) => r[0] === ui.followRange) || FOLLOW_RANGES[0];
  const since = Date.now() - range[2] * 86400e3;
  const all = [...follows].map((id) => map.get(id)).filter((p) => p && p.c && !p.locked && p.fav);
  const items = all.filter((p) => new Date(p.at).getTime() >= since || p.res === 'pending').sort((a, b) => (a.at < b.at ? 1 : -1));
  const done = items.filter((p) => p.res === 'hit' || p.res === 'miss');
  const active = items.length - done.length;
  const hit = done.filter((p) => p.res === 'hit').length;
  let streak = 0;
  for (const p of done) {
    const s = p.res === 'hit' ? 1 : -1;
    if (!streak || Math.sign(streak) === s) streak += s;
    else break;
  }
  const withOdds = items.filter((p) => p.o);
  const avgOdds = withOdds.length ? odds(withOdds.reduce((a, p) => a + p.o, 0) / withOdds.length) : '—';
  return `
  <div class="seg-head">
    <div><h1 class="page-title">Seguidos</h1>
    <div class="page-sub"><i class="live-dot"></i>${active} activos · ${items.length} total</div></div>
    <div class="seg-tools">
      <button class="chip-btn" data-frange="next">${icon('calendar')} ${esc(range[1])}</button>
    </div>
  </div>
  ${FB.enabled && !account ? '<div class="banner" style="margin:0 0 12px"><span>Inicia sesión para guardar tus seguidos en todos tus dispositivos</span><a class="textlink" href="#/login">Entrar</a></div>' : ''}
  <div class="tiles" style="margin-top:0">
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${done.length ? pct(Math.round((hit / done.length) * 1000) / 10) : '—'}</div></div>
    <div class="tile"><div class="overline">Racha</div><div class="val ${streak > 0 ? 'pos' : streak < 0 ? 'neg' : ''}">${streak > 0 ? `${streak}W 🔥` : streak < 0 ? `${-streak}L` : '—'}</div></div>
    <div class="tile"><div class="overline">Cuota prom.</div><div class="val">${avgOdds}</div></div>
  </div>
  <div style="margin-top:16px">${items.length ? `<div class="fgrid">${items.map(followCard).join('')}</div>` : empty('heart', 'Sin seguimientos en este rango', 'Toca el corazón ♥ en cualquier pick para seguirlo, o prueba un rango de fechas diferente.')}</div>
  ${active ? `<div class="float-active"><i></i>${active} ${active === 1 ? 'activo' : 'activos'}</div>` : ''}
  ${footer()}`;
}

function viewResultados() {
  const s = data.stats;
  const r = s?.[ui.resRange];
  const days = ui.resRange === 'd7' ? 7 : ui.resRange === 'd30' ? 30 : 9999;
  const since = Date.now() - days * 86400e3;
  const list = data.results.filter((p) => new Date(p.at).getTime() >= since);
  const series = (s?.series || []).slice(ui.resRange === 'd7' ? -7 : -30);
  const max = Math.max(1, ...series.map((x) => x.hit + x.miss));
  return `
  <h1 class="page-title">Resultados</h1>
  <div class="page-sub">Picks resueltos y verificados automáticamente</div>
  <div class="toolbar"><div class="seg">
    <button data-rr="d7" class="${ui.resRange === 'd7' ? 'on' : ''}">7 días</button>
    <button data-rr="d30" class="${ui.resRange === 'd30' ? 'on' : ''}">30 días</button>
    <button data-rr="all" class="${ui.resRange === 'all' ? 'on' : ''}">Todo</button>
  </div></div>
  <div class="tiles">
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${pct(r?.pct)}</div><div class="hint">${r ? `${r.hit} ✓ · ${r.miss} ✗` : ''}</div></div>
    <div class="tile"><div class="overline">Unidades</div><div class="val ${r?.units > 0 ? 'pos' : r?.units < 0 ? 'neg' : ''}">${r ? (r.units > 0 ? '+' : '') + String(r.units).replace('.', ',') : '—'}</div><div class="hint">stake fijo 1u</div></div>
    <div class="tile"><div class="overline">ROI</div><div class="val ${r?.roi > 0 ? 'pos' : r?.roi < 0 ? 'neg' : ''}">${pct(r?.roi)}</div><div class="hint">${r?.staked || 0} con cuota</div></div>
  </div>
  ${
    series.length && ui.resRange !== 'all'
      ? `<div class="card pad" style="margin-top:12px">
      <div class="block-h" style="margin:0"><span class="overline">Aciertos por día</span><div class="legend"><span><i style="background:var(--win)"></i>Acierto</span><span><i style="background:var(--red)"></i>Fallo</span></div></div>
      <div class="bars">${series.map((x) => `<div class="b" title="${x.d}: ${x.hit}✓ ${x.miss}✗"><i class="h" style="height:${(x.hit / max) * 100}px"></i><i class="m" style="height:${(x.miss / max) * 100}px"></i></div>`).join('')}</div>
      <div class="bars-x"><span>${esc(series[0].d.slice(5))}</span><span>${esc(series[series.length - 1].d.slice(5))}</span></div>
    </div>`
      : ''
  }
  <div class="section-h"><h2>Historial</h2><span class="badge">${list.length}</span></div>
  ${!data.loaded ? skeleton(3) : list.length ? `<div class="grid-2">${list.slice(0, 80).map((p) => matchCard(p, p, { showForm: false })).join('')}</div>` : errorBox() || empty('chart', 'Aún no hay resultados', 'Cuando terminen los partidos con pick, aparecen aquí con su resultado real.')}
  ${footer()}`;
}

// Línea de saldo (SVG) con área roja y la banca inicial punteada.
function bankChart(series, start) {
  const pts = [{ d: 'inicio', bal: start }, ...series];
  if (pts.length < 2) return '';
  const W = 600, H = 170, P = 8, PB = 18;
  const vals = pts.map((p) => p.bal);
  const min = Math.min(...vals, start), max = Math.max(...vals, start);
  const span = max - min || 1;
  const x = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - min) / span) * (H - P - PB);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.bal).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evolución de la banca">
    <defs><linearGradient id="bankfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e10600" stop-opacity=".35"/><stop offset="1" stop-color="#e10600" stop-opacity="0"/></linearGradient></defs>
    <line class="base" x1="${P}" x2="${W - P}" y1="${y(start)}" y2="${y(start)}"/>
    <path class="ar" d="${line} L${x(pts.length - 1)},${H - PB} L${x(0)},${H - PB} Z"/>
    <path class="ln" d="${line}"/>
  </svg>
  <div class="bars-x"><span>${esc(pts[1].d.slice(5))}</span><span>${esc(pts[pts.length - 1].d.slice(5))}</span></div>`;
}

// ---------- Mi Bankroll (Kelly) — para cada usuario ----------
// Misma fórmula del sitio anterior: f* = (b·p − q) / b, con p = confianza,
// b = cuota − 1, ajustada por el nivel de riesgo. Tope de 10% de la banca
// por apuesta (Kelly puro puede pedir montos muy altos con cuotas altas).
const RISK = {
  seguro: { label: 'Seguro', sub: '¼ Kelly', m: 0.25 },
  equilibrado: { label: 'Equilibrado', sub: '½ Kelly', m: 0.5 },
  agresivo: { label: 'Agresivo', sub: 'Kelly completo', m: 1 }
};
const KELLY_CAP = 0.1;
// Moneda de la banca de cada usuario (bank.cur). step: redondeo de los
// montos sugeridos (pesos colombianos de a 100, dólares de a 0,50, etc.).
const CURRENCIES = {
  COP: { n: 'Peso colombiano', step: 100 },
  USD: { n: 'Dólar', step: 0.5 },
  EUR: { n: 'Euro', step: 0.5, sym: '€' },
  MXN: { n: 'Peso mexicano', step: 1 },
  PEN: { n: 'Sol peruano', step: 0.5, sym: 'S/ ' },
  CLP: { n: 'Peso chileno', step: 100 },
  ARS: { n: 'Peso argentino', step: 10 },
  VES: { n: 'Bolívar venezolano', step: 1, sym: 'Bs ' },
  BOB: { n: 'Boliviano', step: 1, sym: 'Bs ' },
  PYG: { n: 'Guaraní paraguayo', step: 1000, sym: '₲' },
  UYU: { n: 'Peso uruguayo', step: 1 },
  BRL: { n: 'Real brasileño', step: 0.5, sym: 'R$' },
  GTQ: { n: 'Quetzal', step: 1, sym: 'Q' },
  CRC: { n: 'Colón costarricense', step: 10, sym: '₡' },
  DOP: { n: 'Peso dominicano', step: 1 }
};
const bankCur = () => (CURRENCIES[bankSettings()?.cur] ? bankSettings().cur : 'COP');
const roundStake = (n) => {
  const st = CURRENCIES[bankCur()].step;
  return Math.round(Math.round(n / st) * st * 100) / 100;
};
function money(n) {
  const cur = bankCur();
  const dec = CURRENCIES[cur].step < 1 ? 2 : 0;
  const txt = new Intl.NumberFormat(LOC(), { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(dec ? n || 0 : Math.round(n || 0));
  const sym = CURRENCIES[cur].sym || '$';
  return sym + txt + (sym === '$' && cur !== 'COP' ? ' ' + cur : '');
}
const signedMoney = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
// Monto escrito por la persona: con decimales solo si la moneda los usa
// ("25.000" en pesos = 25000; "7,50" en dólares = 7.5).
function parseMoney(str) {
  const t = String(str || '');
  if (CURRENCIES[bankCur()].step >= 1) return Number(t.replace(/\D/g, '')) || 0;
  return Number(t.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) || 0;
}
// "Apostar igual": si Kelly dice no apostar (la cuota no paga el riesgo),
// la persona puede apostarle de todos modos con el monto que ella escriba
// (sugerido: 1% de la banca). Se guarda en su configuración como
// bank.force = { idPick: monto }; antes era una lista de ids (= 1%).
const FORCED_PCT = 0.01;
// Por debajo de esta confianza el pick se marca como parejo (baja confianza).
// Medido el 19-oct: los de 55-59% acertaban ~49%, como los de 50-54%.
const PAREJO = 60;
// Desde aquí, si la cuota paga poco se sugiere la apuesta mínima en vez de
// "No apostar" (los picks anteriores no cambian la banca ya calculada).
const LOW_FROM = '2026-10-19T06:00:00Z';
const forcedMap = (s) => (Array.isArray(s?.force) ? Object.fromEntries(s.force.map((id) => [id, 0])) : { ...(s?.force || {}) });
const forcedStake = (amt, bal) => Math.max(0, Math.min(bal, amt || roundStake(bal * FORCED_PCT)));
// Solo se puede apostar igual o quitar antes de que empiece el partido.
const betOpen = (p) => p.st === 's' && new Date(p.at).getTime() > Date.now();

// Probabilidad para Kelly: el acierto real de los picks de esa franja de
// confianza (stats.calib, lo calcula update.js); si no hay, la confianza.
const realProb = (c) => data.stats?.calib?.[Math.min(70, Math.floor(c / 5) * 5)] ?? c / 100;

function kellyFraction(confidence, o, multiplier) {
  if (!o || o <= 1) return 0;
  const p = realProb(confidence);
  const b = o - 1;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, Math.min(KELLY_CAP, f * multiplier));
}

function bankSettings() {
  return profile?.bank || readLocal('cr_kelly', null);
}

async function saveBankSettings(s) {
  writeLocal('cr_kelly', s);
  if (account) {
    profile = { ...(profile || {}), bank: s };
    FB.saveBankSettings(s).catch(() => {});
  }
}

// Simula la banca del usuario apostando con Kelly en los picks que SIGUE,
// en orden cronológico. Los pendientes reciben el monto sugerido con el
// saldo actual.
function userBank() {
  const s = bankSettings();
  if (!s?.start) return null;
  const m = (RISK[s.risk] || RISK.equilibrado).m;
  const map = allById();
  const items = [...follows].map((id) => map.get(id)).filter((p) => p && p.c).sort((a, b) => (a.at < b.at ? -1 : 1));
  let bal = s.start;
  let peak = bal;
  let dd = 0;
  let staked = 0;
  let bets = 0;
  let hits = 0;
  const rows = [];
  const pending = [];
  const byDay = new Map();
  const fm = forcedMap(s);
  const skip = new Set((s.skip || []).map(Number));
  for (const p of items) {
    const kf = kellyFraction(p.c, p.o, m);
    // low: la cuota paga poco para esta confianza. Se apuesta el monto que
    // eligió la persona o, desde LOW_FROM, la apuesta mínima sugerida.
    const low = !kf && p.o > 1;
    const force = low && !skip.has(p.id) && (String(p.id) in fm || p.at >= LOW_FROM);
    const f = force ? FORCED_PCT : kf;
    if (p.res === 'hit' || p.res === 'miss') {
      const stake = force ? forcedStake(fm[p.id], bal) : roundStake(bal * f);
      if (!stake) {
        rows.push({ p, stake: 0, profit: 0, bal, skip: true });
        continue;
      }
      const profit = p.res === 'hit' ? Math.round(stake * (p.o - 1)) : -stake;
      bal += profit;
      staked += stake;
      bets++;
      if (p.res === 'hit') hits++;
      peak = Math.max(peak, bal);
      dd = Math.max(dd, peak - bal);
      rows.push({ p, stake, profit, bal, f, force });
      byDay.set(dayKey(p.at), bal);
    } else pending.push({ p, f, force, amt: fm[p.id] });
  }
  return {
    s,
    bal,
    profit: bal - s.start,
    staked,
    roi: staked ? Math.round(((bal - s.start) / staked) * 1000) / 10 : null,
    bets,
    hits,
    dd,
    rows: rows.reverse(),
    custom: new Set(Object.keys(fm).map(Number)),
    pend: pending.map((x) => ({ ...x, stake: x.force ? forcedStake(x.amt, bal) : roundStake(bal * x.f) })),
    series: [...byDay.entries()].map(([d, b]) => ({ d, bal: b }))
  };
}

function kellySettingsHtml() {
  const s = bankSettings() || { start: '', risk: 'equilibrado' };
  return `<div class="card pad">
    <label class="field"><span>Moneda con la que apuestas</span><select id="kelly-cur">${Object.entries(CURRENCIES).map(([k, c]) => `<option value="${k}" ${bankCur() === k ? 'selected' : ''}>${c.n} (${k})</option>`).join('')}</select></label>
    <label class="field"><span>Banca inicial (${bankCur()})</span><input id="kelly-start" inputmode="numeric" placeholder="${bankCur() === 'COP' ? 'Ej: 500000' : 'Ej: 100'}" value="${s.start || ''}"></label>
    <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px">Nivel de riesgo</span>
    <div class="seg seg-full">${Object.entries(RISK)
      .map(([k, r]) => `<button data-risk="${k}" class="${(s.risk || 'equilibrado') === k ? 'on' : ''}">${r.label}<em>${r.sub}</em></button>`)
      .join('')}</div>
  </div>`;
}

function kellyBodyHtml() {
  const u = userBank();
  if (!u) return `<div class="note" style="margin-top:12px">Escribe tu banca inicial arriba para empezar. Después toca el ♥ en los picks que quieras seguir: tu banca se ajusta sola con cada resultado.</div>`;
  const pendList = u.pend.filter((x) => new Date(x.p.at).getTime() > Date.now() - 3 * 3600e3);
  return `
  <div class="bank-hero" style="margin-top:12px">
    <div class="overline">Mi banca actual</div>
    <div class="big">${money(u.bal)}</div>
    <div class="delta ${u.profit >= 0 ? 'pos-t' : 'neg-t'}">${signedMoney(u.profit)} · ROI ${pct(u.roi)}</div>
    <div style="font-size:12px;color:#a1a1aa;margin-top:6px">Inició con ${money(u.s.start)} · ${RISK[u.s.risk || 'equilibrado'].label} (${RISK[u.s.risk || 'equilibrado'].sub})</div>
  </div>
  <div class="tiles">
    <div class="tile"><div class="overline">Apuestas</div><div class="val">${u.bets}</div><div class="hint">${u.hits} ganadas</div></div>
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${u.bets ? pct(Math.round((u.hits / u.bets) * 1000) / 10) : '—'}</div></div>
    <div class="tile"><div class="overline">Máx. caída</div><div class="val neg" style="font-size:17px">${u.dd ? '−' + money(u.dd) : '—'}</div></div>
  </div>
  ${u.series.length ? `<div class="card pad" style="margin-top:12px"><div class="overline">Evolución de mi banca</div>${bankChart(u.series, u.s.start)}</div>` : ''}

  <div class="section-h"><h2>${icon('clock')} Por apostar</h2><span class="badge">${pendList.length}</span></div>
  <div class="list">${
    pendList.length
      ? pendList
          .map(({ p, f, stake, force }) => {
            const fav = p.fav === p.a.id ? p.a : p.b;
            const open = betOpen(p);
            const head = `<span class="who"><b>${esc(fav.n)} gana</b><small>${fmtTime(p.at)} · ${p.c}% · cuota ${odds(p.o)}${force ? (u.custom.has(p.id) ? ' · monto elegido por ti' : ' · apuesta mínima sugerida') : ''}</small></span>`;
            // Editor del monto (sin data-open: tocar el campo no abre la ficha)
            if (ui.kEdit === p.id && open) {
              const def = force ? stake : forcedStake(0, u.bal);
              return `<div class="stake-row kedit">${head}<div class="kbox">
                <small class="warn-t">Riesgo alto: la cuota paga poco para esta confianza. Escribe cuánto quieres apostar (máximo tu banca: ${money(u.bal)}).</small>
                <div class="krow"><input class="kamt" data-kamt="${p.id}" data-odds="${p.o}" inputmode="numeric" value="${def}" aria-label="Monto a apostar"><span class="kwin">gana ${money(def * (p.o - 1))}</span></div>
                <div class="krow"><button type="button" class="mini-btn kforce" data-kok="${p.id}">Apostar</button><button type="button" class="mini-btn" data-kcancel="1">Cancelar</button></div>
              </div></div>`;
            }
            const amt = force
              ? `<span class="amt">${money(stake)}<small class="warn-t">Riesgo alto: la cuota paga poco</small>${open ? `<span class="kbtns"><button type="button" class="mini-btn" data-kedit="${p.id}">Cambiar</button><button type="button" class="mini-btn" data-kquit="${p.id}">No apostar</button></span>` : ''}</span>`
              : f
              ? `<span class="amt">${money(stake)}<small>${(f * 100).toFixed(1).replace('.', ',')}% · gana ${money(stake * (p.o - 1))}</small></span>`
              : `<span class="amt" style="color:var(--muted);font-size:12px">No apostar<small style="color:var(--muted)">${p.o ? 'la cuota no paga el riesgo' : 'sin cuota'}</small>${p.o > 1 && open ? `<button type="button" class="mini-btn kforce" data-kedit="${p.id}">Apostar</button>` : ''}</span>`;
            return `<div class="stake-row" data-open="${p.id}" style="cursor:pointer">${head}${amt}</div>`;
          })
          .join('')
      : '<div class="stake-row"><span class="who"><small>No tienes picks seguidos por jugar. Toca el ♥ en un pick para agregarlo.</small></span></div>'
  }</div>

  <div class="section-h"><h2>${icon('chart')} Mi historial</h2><span class="badge">${u.rows.length}</span></div>
  <div class="list">${
    u.rows.length
      ? u.rows
          .slice(0, 60)
          .map(({ p, stake, profit, bal, skip, force }) => {
            const fav = p.fav === p.a.id ? p.a : p.b;
            return `<div class="stake-row" data-open="${p.id}" style="cursor:pointer"><span class="who"><b>${p.res === 'hit' ? '✓' : '✗'} ${esc(fav.n)}</b><small>${esc(dayLabel(dayKey(p.at)))} · ${p.c}% · cuota ${odds(p.o)}${skip ? ' · no se apostó' : ` · ${money(stake)}${force ? ' · riesgo alto' : ''}`}</small></span><span class="amt ${profit > 0 ? 'pos-t' : profit < 0 ? 'neg-t' : ''}">${skip ? '—' : signedMoney(profit)}<small style="color:var(--muted)">${money(bal)}</small></span></div>`;
          })
          .join('')
      : '<div class="stake-row"><span class="who"><small>Cuando terminen los partidos que sigues, aquí ves cuánto ganaste o perdiste en cada uno.</small></span></div>'
  }</div>
  <p class="note" style="margin-top:14px">${icon('info', 'icon').replace('class="icon"', 'class="icon" style="display:inline;width:14px;height:14px;vertical-align:-2px"')} <b>Criterio de Kelly:</b> calcula qué porcentaje de tu banca apostar según la confianza del pick y la cuota. Usa el acierto real de los picks con esa confianza. Si la cuota paga poco, sugiere una <b>apuesta mínima</b> (1% de tu banca) marcada como riesgo alto; puedes cambiar el monto o tocar <b>No apostar</b>. Tope: 10% de la banca por apuesta. Es una simulación con los picks que sigues; apuesta con responsabilidad.</p>`;
}

function viewBankroll() {
  if (!data.loaded) return `<h1 class="page-title">Mi Bankroll</h1>${skeleton(3)}`;
  if (!isPremiumUser())
    return `<h1 class="page-title">Mi Bankroll</h1><div class="page-sub">Kelly sobre los picks que sigues</div>${premiumLock('Mi Bankroll es Premium', 'Con Premium llevas tu banca con el criterio de Kelly: cuánto apostar en cada pick que sigues, tu saldo, ROI y gráfico, que se ajustan solos con cada resultado.')}`;
  const admin = isAdmin();
  if (!admin) ui.bankTab = 'mine';
  return `
  <h1 class="page-title">${ui.bankTab === 'system' ? 'Bankroll del sistema' : 'Mi Bankroll'}</h1>
  <div class="page-sub"><i class="live-dot"></i>${ui.bankTab === 'system' ? 'Banca simulada de CamiloRey · solo admin' : 'Kelly sobre los picks que sigues'}</div>
  ${admin ? `<div class="seg seg-full" style="margin-bottom:14px"><button data-bt="mine" class="${ui.bankTab === 'mine' ? 'on' : ''}">Mi bankroll</button><button data-bt="system" class="${ui.bankTab === 'system' ? 'on' : ''}">🔒 Sistema</button></div>` : ''}
  ${
    ui.bankTab === 'system'
      ? `<div id="admin-system">${skeleton(3)}</div>`
      : `${FB.enabled && !account ? '<div class="banner" style="margin:0 0 12px"><span>Inicia sesión para guardar tu banca y tus seguidos en todos tus dispositivos</span><a class="textlink" href="#/login">Entrar</a></div>' : ''}
         ${kellySettingsHtml()}<div id="kelly-body">${kellyBodyHtml()}</div>`
  }
  ${footer()}`;
}

function isAdmin() {
  return Boolean(account?.email && account.email.toLowerCase() === ADMIN_EMAIL);
}

// Bankroll del sistema + historial apuesta por apuesta (solo admin, desde
// Firestore admin/ledger — las reglas rechazan a cualquier otra cuenta).
async function renderAdminLedger() {
  const box = document.getElementById('admin-system');
  if (!box || !isAdmin()) return;
  try {
    const { rows, summary: b, updatedAt } = await FB.loadAdminLedger();
    const hero = b
      ? `<div class="bank-hero">
        <div class="overline">Banca del sistema</div>
        <div class="big">${cop(b.balance)}</div>
        <div class="delta ${b.profit >= 0 ? 'pos-t' : 'neg-t'}">${signed(b.profit)} · ROI ${pct(b.roi)}</div>
        <div style="font-size:12px;color:#a1a1aa;margin-top:6px">Inició con ${cop(b.start)} · ${b.bets} apuestas · ${b.hits} ganadas</div>
      </div>
      <div class="tiles">
        <div class="tile"><div class="overline">Apostado</div><div class="val" style="font-size:17px">${cop(b.staked)}</div></div>
        <div class="tile"><div class="overline">Efectividad</div><div class="val">${b.bets ? pct(Math.round((b.hits / b.bets) * 1000) / 10) : '—'}</div></div>
        <div class="tile"><div class="overline">Máx. caída</div><div class="val neg" style="font-size:17px">${b.maxDrawdown ? '−' + cop(b.maxDrawdown) : '—'}</div></div>
      </div>
      ${b.series?.length ? `<div class="card pad" style="margin-top:12px"><div class="overline">Evolución de la banca</div>${bankChart(b.series, b.start)}</div>` : ''}`
      : '<div class="note">El resumen aparece en la próxima actualización (cada ~5 min).</div>';
    // Todos los picks: los apostados mueven la banca; el resto se muestra
    // con su estado (pendiente, en juego, por resolver, sin cuota...).
    const ST = { pre: 'Pendiente', live: 'En juego', wait: 'Por resolver', nodds: 'Sin cuota · no se apostó', np: 'No publicado (<55%)' };
    const f = ui.ledgerF || 'all';
    const counts = {
      all: rows.length,
      bet: rows.filter((x) => x.profit != null).length,
      open: rows.filter((x) => x.res === 'pending').length,
      done: rows.filter((x) => x.res !== 'pending').length
    };
    const shown = rows.filter((x) => (f === 'bet' ? x.profit != null : f === 'open' ? x.res === 'pending' : f === 'done' ? x.res !== 'pending' : true));
    const resCell = (x) => {
      if (x.profit != null) return `<td class="num ${x.profit >= 0 ? 'pos-t' : 'neg-t'}">${x.res === 'hit' ? '✓ ' : '✗ '}${signed(x.profit)}</td>`;
      const mark = x.res === 'hit' ? '<b class="pos-t">✓</b> ' : x.res === 'miss' ? '<b class="neg-t">✗</b> ' : '';
      return `<td class="num"><span style="color:var(--muted);font-size:11px">${mark}${esc(ST[x.st] || '—')}</span></td>`;
    };
    const filters = `<div class="seg seg-full" style="margin-bottom:10px;grid-auto-flow:row;grid-template-columns:1fr 1fr;border-radius:16px">${[
      ['all', 'Todos'],
      ['bet', 'Apostados'],
      ['open', 'Pendientes'],
      ['done', 'Terminados']
    ]
      .map(([k, t]) => `<button type="button" data-ledger-f="${k}" class="${f === k ? 'on' : ''}">${t} <em>${counts[k]}</em></button>`)
      .join('')}</div>`;
    const table = rows.length
      ? `${filters}<div class="card scroll-x"><table class="ledger"><thead><tr><th>Partido</th><th>Pick</th><th class="num">Cuota</th><th class="num">Apuesta</th><th class="num">Resultado</th><th class="num">Banca</th></tr></thead><tbody>
        ${shown
          .map(
            (x) => `<tr data-open="${x.id}" style="cursor:pointer"><td class="who">${esc(x.a)} vs ${esc(x.b)}<small>${esc(dayLabel(dayKey(x.at)))} ${fmtTime(x.at)}${x.ph ? ' · ' + esc(x.ph) : ''}</small></td><td>${esc(x.fav)} <span class="conf${x.c < PAREJO ? ' low' : ''}">${x.c}%</span></td><td class="num">${odds(x.o)}</td><td class="num">${x.stake != null ? cop(x.stake) : '—'}</td>${resCell(x)}<td class="num">${x.bal != null ? cop(x.bal) : '—'}</td></tr>`
          )
          .join('')}
        </tbody></table></div><p class="foot" style="margin-top:8px">${shown.length} de ${rows.length} picks · ${counts.bet} apostados · actualizado ${updatedAt ? fmtTime(updatedAt) : '—'}</p>`
      : empty('wallet', 'Aún no hay picks', 'Cada pick del sistema aparece aquí, con su resultado cuando termina el partido.');
    box.innerHTML = `${hero}<div class="section-h"><h2>🔒 Historial de apuestas</h2><span class="badge red">Solo admin</span></div>${table}`;
  } catch (e) {
    box.innerHTML = `<div class="note">No se pudo cargar el bankroll del sistema (${esc(e.code || e.message)}).</div>`;
  }
}

function viewPerfil() {
  const u = account;
  return `
  <div class="subhead"><a class="back" href="#/inicio">${icon('left')} Atrás</a><h1>Perfil</h1></div>
  ${
    u
      ? `<a class="usercard" href="#/cuenta"><div class="av">${userAvatar()}</div><div style="flex:1;min-width:0"><b>${esc(userName())}</b><small>${esc(u.email || '')}</small><small>Miembro desde ${esc(new Date(u.metadata?.creationTime || Date.now()).toLocaleDateString(LOC(), { month: 'short', year: 'numeric' }))}</small></div>${icon('chev')}</a>`
      : FB.enabled
      ? `<div class="usercard"><div class="av">${icon('user')}</div><div style="flex:1"><b>Invitado</b><small>Inicia sesión para guardar tus picks seguidos</small></div></div>
         <a class="btn primary" style="margin-top:10px" href="#/login">Iniciar sesión o crear cuenta</a>`
      : `<div class="usercard"><div class="av">${icon('user')}</div><div style="flex:1"><b>Invitado</b><small>Las cuentas se activan muy pronto</small></div></div>`
  }
  <div class="overline" style="margin:22px 4px 8px">Ajustes</div>
  <div class="list">
    ${isAdmin() ? `<a class="row" href="#/admin"><span class="ic" style="color:var(--red-2)">${icon('shield')}</span><span class="tx"><b>Panel admin</b><small>Pick del tipster, visitas y usuarios</small></span><span class="chev">${icon('chev')}</span></a>` : ''}
    <a class="row" href="#/premium"><span class="ic" style="font-size:18px">⭐</span><span class="tx"><b>Premium</b><small>${isPremiumUser() ? (isAdmin() ? 'Activo (administrador)' : `Activo hasta ${esc(membership.until.toLocaleDateString(LOC(), { day: 'numeric', month: 'short', year: 'numeric' }))}`) : 'Picks de alta confianza, análisis IA, bankroll y avisos'}</small></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/notificaciones"><span class="ic">${icon('bell')}</span><span class="tx"><b>Notificaciones</b><small>Avisos de tus picks en el celular</small></span><span class="chev">${icon('chev')}</span></a>
    <button class="row check ${fxEnabled() ? 'on' : ''}" data-fx="1"><span class="ic">${icon('bolt')}</span><span class="tx"><b>Sonido y vibración</b><small>Un toque suave al cambiar de pestaña</small></span><span class="tick"></span></button>
    <a class="row" href="#/tema"><span class="ic">${icon('moon')}</span><span class="tx"><b>Tema</b><small>${esc({ dark: 'Oscuro', light: 'Claro', system: 'Sistema' }[readLocal('cr_theme_raw', 'dark')] || 'Oscuro')}</small></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/cuotas"><span class="ic">${icon('chart')}</span><span class="tx"><b>Formato de cuotas</b><small>${esc(ODDS_FORMATS[readLocal('cr_odds', 'decimal')]?.[0] || 'Decimal')} · ${esc(odds(1.57))}</small></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/idioma"><span class="ic">${icon('globe')}</span><span class="tx"><b>Idioma</b><small>${readLocal('cr_lang', 'es') === 'en' ? 'English' : 'Español'}</small></span><span class="chev">${icon('chev')}</span></a>
    ${TELEGRAM_URL ? `<a class="row" href="${esc(TELEGRAM_URL)}" target="_blank" rel="noopener"><span class="ic">${icon('telegram')}</span><span class="tx"><b>Telegram de CamiloRey</b><small>Pagos, renovación y soporte</small></span><span class="chev">${icon('chev')}</span></a>` : ''}
    <a class="row" href="#/ayuda"><span class="ic">${icon('help')}</span><span class="tx"><b>Ayuda y FAQ</b><small>Preguntas frecuentes, contacto</small></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/privacidad"><span class="ic">${icon('shield')}</span><span class="tx"><b>Privacidad</b><small>Datos y seguridad de cuenta</small></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/terminos"><span class="ic">${icon('doc')}</span><span class="tx"><b>Términos de servicio</b><small>Uso informativo, no es casa de apuestas</small></span><span class="chev">${icon('chev')}</span></a>
  </div>
  ${u ? `<button class="btn ghost" style="margin-top:18px" id="btn-logout">${icon('logout')} Cerrar sesión</button>` : ''}
  ${footer()}`;
}

function viewCuenta() {
  const u = account;
  if (!u) return viewLogin();
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Info de cuenta</h1></div>
  <div class="photo-edit">
    <label class="pe-av" title="Cambiar foto">
      <span class="av">${userAvatar()}</span>
      <span class="pe-cam">${icon('camera')}</span>
      <input type="file" id="photo-input" accept="image/*" hidden>
    </label>
    <label for="photo-input" class="textlink" style="cursor:pointer">Cambiar foto</label>
    ${profile?.photo ? '<button class="textlink" id="btn-photo-del" style="color:var(--muted);font-size:12px">Quitar foto</button>' : ''}
  </div>
  <div class="list">
    <div class="row" id="name-row">
      <span class="ic">${icon('user')}</span>
      <span class="tx"><small>Nombre completo</small><b>${esc(userName())}</b></span>
      <button class="mini-btn" id="btn-name-edit">Editar</button>
    </div>
    <form class="row" id="name-form" hidden>
      <span class="ic">${icon('user')}</span>
      <input name="name" maxlength="40" value="${esc(userName())}" class="inline-input" autocomplete="name" required>
      <button class="mini-btn red" type="submit">Guardar</button>
    </form>
    <div class="row"><span class="ic">${icon('mail')}</span><span class="tx"><small>Correo</small><b>${esc(u.email || '—')}</b></span></div>
    <div class="row"><span class="ic">${icon('calendar')}</span><span class="tx"><small>Miembro desde</small><b>${esc(new Date(u.metadata?.creationTime || Date.now()).toLocaleDateString(LOC(), { day: 'numeric', month: 'long', year: 'numeric' }))}</b></span></div>
    <div class="row"><span class="ic">${icon('shield')}</span><span class="tx"><small>ID de usuario</small><b style="font-family:var(--mono);font-size:12px">${esc(u.uid)}</b></span></div>
  </div>
  <button class="btn ghost" style="margin-top:18px;color:var(--loss)" id="btn-delete">${icon('trash')} Eliminar cuenta</button>
  <p id="del-confirm" class="note" hidden>¿Seguro? Se borran tu cuenta y tus picks seguidos. <button class="textlink" id="btn-delete-yes">Sí, eliminar</button></p>`;
}

function viewTema() {
  const cur = readLocal('cr_theme_raw', 'dark');
  const opt = (k, ic, t, s) => `<button class="row check ${cur === k ? 'on' : ''}" data-theme-set="${k}"><span class="ic">${icon(ic)}</span><span class="tx"><b>${t}</b><small>${s}</small></span><span class="tick"></span></button>`;
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Tema</h1></div>
  <div class="overline" style="margin:4px 4px 8px">Seleccionar tema</div>
  <div class="list">
    ${opt('dark', 'moon', 'Oscuro', 'Negro con rojo (recomendado)')}
    ${opt('light', 'sun', 'Claro', 'Fondo claro con rojo')}
    ${opt('system', 'monitor', 'Sistema', 'Sigue el ajuste del dispositivo')}
  </div>
  <p class="note" style="margin-top:14px"><b>Nota:</b> el modo sistema cambia solo entre claro y oscuro según la apariencia de tu celular o PC.</p>`;
}

const ODDS_FORMATS = {
  decimal: ['Decimal', 'Ej: 1.57 · 2.50 (el de Rushbet)'],
  american: ['Americano', 'Ej: −175 · +150'],
  fractional: ['Fraccional', 'Ej: 4/7 · 3/2']
};

function viewCuotas() {
  const cur = readLocal('cr_odds', 'decimal');
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Formato de cuotas</h1></div>
  <div class="list">${Object.entries(ODDS_FORMATS)
    .map(([k, [t, s]]) => `<button class="row check ${cur === k ? 'on' : ''}" data-oddsfmt="${k}"><span class="ic" style="font-weight:800;font-size:12px">${k === 'decimal' ? '1.57' : k === 'american' ? '−175' : '4/7'}</span><span class="tx"><b>${t}</b><small>${s}</small></span><span class="tick"></span></button>`)
    .join('')}</div>
  <p class="note" style="margin-top:14px">Se aplica a todas las cuotas de la página. La de 1.57 se ve así: <b>${esc(odds(1.57))}</b>.</p>`;
}

function viewIdioma() {
  const cur = readLocal('cr_lang', 'es');
  const opt = (k, t, s) => `<button class="row check ${cur === k ? 'on' : ''}" data-lang="${k}"><span class="ic" style="font-weight:800;font-size:12px">${k.toUpperCase()}</span><span class="tx"><b>${t}</b><small>${s}</small></span><span class="tick"></span></button>`;
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Idioma</h1></div>
  <div class="list">${opt('es', 'Español', 'Idioma original')}${opt('en', 'English', 'Interface in English')}</div>
  <p class="note" style="margin-top:14px">El análisis de cada pick y las páginas legales se muestran en español.</p>`;
}

const FAQ = [
  ['Predicciones', [
    ['¿Cómo se generan las predicciones?', 'Cada ~5 minutos un proceso automático lee los torneos de la Liga Pro Checa, calcula para cada partido el rating de los jugadores, su racha, el historial entre ellos (H2H y patrones de alternancia), la forma del día y la cuota real de Rushbet, y con eso estima quién es el favorito. Cuando hay suficientes resultados, un modelo de machine learning reentrena solo y toma la decisión.'],
    ['¿Qué significa el % de confianza?', 'Es la probabilidad que el sistema le da al favorito de ganar, en una escala honesta de 50% (partido parejo) a 80% (el máximo: en el tenis de mesa nada es seguro y no vamos a prometer más). Por debajo de 60% el partido se marca como parejo (baja confianza): enfócate en los de 60% o más. Referencia: 60-64% confianza media, 65-69% buena, 70-80% alta. Aun con 75%, 1 de cada 4 picks se pierde: por eso mostramos todos los resultados.'],
    ['¿El marcador en vivo es en tiempo real?', 'Sí. Se lee directo del feed en vivo de Rushbet cada 2 segundos, con el marcador punto a punto y set por set.'],
    ['¿Los resultados son reales?', 'Sí. Cada pick se marca como acierto o fallo automáticamente cuando el partido termina, con el resultado oficial. No se borra ni se edita ningún pick.']
  ]],
  ['Cuenta', [
    ['¿Para qué crear una cuenta?', 'Para guardar tus picks seguidos y verlos desde cualquier dispositivo. Puedes entrar con Google o con tu correo.'],
    ['¿Cómo elimino mi cuenta?', 'Perfil → toca tu tarjeta → Eliminar cuenta. Se borran tus datos de inmediato.']
  ]],
  ['Cuotas', [
    ['¿De dónde salen las cuotas?', 'Del tablero público de Rushbet, en formato decimal. Si un partido no aparece en Rushbet, el pick sale sin cuota.'],
    ['¿Qué son las unidades y el ROI?', 'Es el rendimiento si se apostara siempre 1 unidad a cada pick con cuota: un acierto suma (cuota − 1) y un fallo resta 1. El ROI es la ganancia dividida entre lo apostado.']
  ]]
];

function viewAyuda() {
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Ayuda y FAQ</h1></div>
  <div class="usercard" style="margin-bottom:14px"><div class="av" style="background:#1c1c1f">${icon('help')}</div><div><b>Ayuda y FAQ</b><small>Encuentra respuestas o escríbenos</small></div></div>
  <div class="list"><div class="row"><span class="ic">${icon('mail')}</span><span class="tx"><b>Soporte por correo</b><small>${esc(SUPPORT_EMAIL)}</small></span></div></div>
  ${FAQ.map(([sec, qs]) => `<div class="overline" style="margin:22px 4px 8px">${esc(sec)}</div><div class="list">${qs.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`).join('')}
  <div class="overline" style="margin:22px 4px 8px">Legal</div>
  <div class="list">
    <a class="row" href="#/privacidad"><span class="ic">${icon('shield')}</span><span class="tx"><b>Política de privacidad</b></span><span class="chev">${icon('chev')}</span></a>
    <a class="row" href="#/terminos"><span class="ic">${icon('doc')}</span><span class="tx"><b>Términos de servicio</b></span><span class="chev">${icon('chev')}</span></a>
  </div>
  ${footer()}`;
}

function viewLegal(kind) {
  const priv = kind === 'privacidad';
  const body = priv
    ? `<h3>Qué datos guardamos</h3><p>Si creas una cuenta: tu nombre, correo y la lista de picks que sigues. El inicio de sesión lo maneja Google Firebase; nunca vemos tu contraseña.</p>
       <h3>Contador de visitas</h3><p>Contamos una visita por navegador por día, sin guardar quién eres ni tu IP.</p>
       <h3>Tus derechos</h3><p>Puedes eliminar tu cuenta y todos tus datos desde Perfil → Info de cuenta → Eliminar cuenta, o escribiendo a ${esc(SUPPORT_EMAIL)}.</p>
       <h3>Menores de edad</h3><p>El sitio no está dirigido a menores de 18 años.</p>`
    : `<h3>Naturaleza del servicio</h3><p>CamiloRey publica predicciones de tenis de mesa generadas con estadística y machine learning, <b>solo con fines informativos y de entretenimiento</b>. No es una casa de apuestas, no recibe ni procesa apuestas y no garantiza resultados.</p>
       <h3>Responsabilidad</h3><p>Cualquier decisión de apostar es tuya. Apuesta solo lo que puedas permitirte perder. Si sientes que el juego es un problema, busca ayuda.</p>
       <h3>Elegibilidad</h3><p>Debes tener al menos 18 años y cumplir las leyes de tu país.</p>
       <h3>Datos de terceros</h3><p>Los partidos y resultados provienen de tt.league-pro.com y las cuotas y el marcador en vivo de Rushbet. Pueden tener demoras o errores.</p>`;
  return `<div class="subhead"><a class="back" href="#/ayuda">${icon('left')} Atrás</a><h1>${priv ? 'Privacidad' : 'Términos'}</h1></div><div class="card pad prose">${body}</div>${footer()}`;
}

function viewLogin(mode = 'login') {
  if (!FB.enabled) return `<div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>Cuenta</h1></div>${empty('user', 'Muy pronto', 'El inicio de sesión se activará en los próximos días.')}`;
  if (account) {
    location.hash = '#/perfil';
    return '';
  }
  const reg = mode === 'registro';
  return `
  <div class="subhead"><a class="back" href="#/perfil">${icon('left')} Atrás</a><h1>${reg ? 'Crear cuenta' : 'Iniciar sesión'}</h1></div>
  <div class="card pad">
    <button class="btn google" id="btn-google"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continuar con Google</button>
    <div class="or">o con tu correo</div>
    <form id="form-auth" data-mode="${reg ? 'registro' : 'login'}">
      ${reg ? '<label class="field"><span>Nombre</span><input name="name" autocomplete="name" required maxlength="60"></label>' : ''}
      <label class="field"><span>Correo</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="6" required></label>
      <div class="err" id="auth-err" hidden></div>
      <button class="btn primary" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
    </form>
    <div style="display:flex;justify-content:space-between;margin-top:14px">
      <a class="textlink" href="${reg ? '#/login' : '#/registro'}">${reg ? 'Ya tengo cuenta' : 'Crear cuenta nueva'}</a>
      ${reg ? '' : '<button class="textlink" id="btn-reset">Olvidé mi contraseña</button>'}
    </div>
  </div>`;
}

function footer() {
  return `<div class="foot" id="foot-counter"></div><div class="foot">CamiloRey · Predicciones informativas, no es casa de apuestas · +18</div>`;
}

// ---------------- hoja del partido ----------------

// ---------- Partido sin pick del sistema ----------
// Para todos: aviso de que el sistema lo ve parejo, o el pick del admin si
// eligió uno. Para el admin: editor para elegir pick (prepartido o en vivo)
// con la cuota prepartido y el Análisis IA del jugador elegido.
const pickEdit = { side: null, mode: null, open: false };

function whyListHtml(why) {
  if (!why) return '<p class="an-src">Sin análisis disponible para este partido.</p>';
  return `${why.pro.length ? `<ul class="why pro">${why.pro.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${why.con.length ? `<div class="overline" style="margin:12px 0 6px">A tener en cuenta</div><ul class="why con">${why.con.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <p class="an-src">${icon('info')} ${esc(why.src)}.</p>`;
}

function noPickBlock(m, lv) {
  const tp = tipsterPickFor(m);
  const tFav = tp ? (tp.fav === m.a.id ? m.a : m.b) : null;
  const shown = tp
    ? `<div class="block"><div class="analysis" style="border-color:rgba(250,204,21,.5)">
        <div class="an-head">${icon('crown')}<div><b>Pick del tipster: ${esc(tFav.n)} gana</b><small>${tp.mode === 'live' ? 'Pick en vivo' : 'Pick prepartido'}${tp.o ? ` · cuota ${odds(tp.o)}` : ''}</small></div></div>
        ${tp.note ? `<p class="tipster-note" style="margin:0">💬 ${esc(tp.note)}</p>` : ''}
        ${tp.res === 'hit' ? '<div class="badge win" style="margin-top:10px">✓ Resultado: acierto</div>' : tp.res === 'miss' ? '<div class="badge loss" style="margin-top:10px">✗ Resultado: fallo</div>' : ''}
      </div></div>`
    : '<div class="block"><p class="note">El sistema no alcanzó a analizar este partido (empezó antes de tener sus datos).</p></div>';
  if (!isAdmin() || m.st === 'f') return shown;

  const np = adminNoPick[m.id] || {};
  if (!pickEdit.open) {
    return `${shown}<button class="btn ghost" style="margin-top:4px" data-pe-open="1">${icon('crown')} ${tp ? 'Cambiar pick del tipster' : 'Elegir pick (admin)'}</button>`;
  }
  const mode = pickEdit.mode || (lv || m.st === 'l' ? 'live' : 'pre');
  const side = pickEdit.side;
  const sideBtn = (k, p, o) => {
    const conf = np.c != null ? (np.fav === p.id ? np.c : 100 - np.c) : null;
    return `<button type="button" class="pe-side ${side === k ? 'on' : ''}" data-pe-side="${k}">${avatar(p, 'avatar sm')}<b>${esc(p.n)}</b><small>Cuota prepartido <b>${o ? odds(o) : '—'}</b></small>${conf != null ? `<small>Modelo: ${conf}%</small>` : ''}</button>`;
  };
  const chosen = side === 'a' ? m.a : side === 'b' ? m.b : null;
  return `${shown}
  <div class="block pe-box">
    <div class="block-h"><span class="overline">${icon('crown')} Elegir pick (solo admin)</span><button class="mini-btn" data-pe-close="1">Cancelar</button></div>
    <div class="pe-sides">${sideBtn('a', m.a, np.oA)}${sideBtn('b', m.b, np.oB)}</div>
    <div class="seg seg-full" style="margin:12px 0"><button type="button" data-pe-mode="pre" class="${mode === 'pre' ? 'on' : ''}">Prepartido</button><button type="button" data-pe-mode="live" class="${mode === 'live' ? 'on' : ''}">En vivo</button></div>
    ${
      chosen
        ? `<div class="analysis"><div class="an-head">${icon('bolt')}<div><b>Análisis IA</b><small>Argumentos a favor y en contra de ${esc(chosen.n)}</small></div></div>${whyListHtml(side === 'a' ? np.whyA : np.whyB)}</div>
           <input class="inline-input" id="pe-note" maxlength="160" placeholder="Nota (opcional)" style="width:100%;margin-top:12px;border-color:var(--line)" value="${esc(tp?.note || '')}">
           <button class="btn primary" style="margin-top:10px" data-pe-save="${m.id}">Publicar: ${esc(chosen.n)} gana${(side === 'a' ? np.oA : np.oB) ? ` · cuota ${odds(side === 'a' ? np.oA : np.oB)}` : ''}</button>`
        : '<p class="note">Toca un jugador para ver su Análisis IA y publicar el pick.</p>'
    }
    ${tp ? `<button class="btn ghost" style="margin-top:8px;color:var(--loss)" data-tdel="${m.id}">Borrar pick del tipster</button>` : ''}
  </div>`;
}

// Enfrentamientos directos en lista, estilo Sofascore: fecha y torneo a la
// izquierda, los dos jugadores con su marcador en sets, el ganador en negrita.
// H2H completo del año (data/h2h/{idMenor}-{idMayor}.json): se pide al
// abrir la pestaña H2H y se redibuja la ficha cuando llega.
const h2hCache = new Map();
function h2hFull(m, redraw) {
  const lo = Math.min(m.a.id, m.b.id);
  const key = `${lo}-${Math.max(m.a.id, m.b.id)}`;
  if (!h2hCache.has(key)) {
    h2hCache.set(key, undefined);
    getJson(`h2h/${key}`)
      .then((d) => h2hCache.set(key, d))
      .catch(() => h2hCache.set(key, null))
      .finally(() => $sheet._redraw === redraw && redraw());
    return 'loading';
  }
  const d = h2hCache.get(key);
  if (d === undefined) return 'loading';
  if (!d) return null;
  // Desde el punto de vista del jugador A de ESTE partido, solo antes de él.
  const list = d.l
    .filter((x) => x.at < m.at)
    .map((x) => ({ at: x.at, tn: x.tn, ph: x.ph, w: x.w, sa: m.a.id === lo ? x.s[0] : x.s[1], sb: m.a.id === lo ? x.s[1] : x.s[0] }));
  const [y, mo, da] = (d.from || '2026-01-01').split('-');
  return { list, full: d.full !== false, since: `${da}/${mo}/${y}` };
}

// L5 / L10 estilo Sofascore: últimos partidos de cada jugador ANTES de este
// partido, con fecha, torneo, rival y marcador (data/players/{id}.json).
const playerCache = new Map();
function playerLast(pid, beforeIso, redraw) {
  if (!playerCache.has(pid)) {
    playerCache.set(pid, undefined);
    getJson(`players/${pid}`)
      .then((d) => playerCache.set(pid, d))
      .catch(() => playerCache.set(pid, null))
      .finally(() => $sheet._redraw === redraw && redraw());
    return null;
  }
  const d = playerCache.get(pid);
  return d ? (d.last || []).filter((x) => x.at < beforeIso) : null;
}

function formListHtml(p, f, n, last) {
  const fmtD = (iso) => new Intl.DateTimeFormat(LOC(), { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ }).format(new Date(iso));
  const list = (last || []).slice(0, n);
  const w = list.length ? list.filter((x) => x.w).length : f.slice(0, n).split('').filter((c) => c === 'W').length;
  const total = list.length || f.slice(0, n).length;
  const head = `<div class="formrow" style="margin:14px 0 4px"><span class="who" style="width:auto;flex:1;font-size:13px">${esc(p.n)}</span><span class="rec">${w}G-${total - w}P</span></div><div style="margin-bottom:8px">${formDots(f, n, 'form lg')}</div>`;
  if (!list.length) return head;
  const rows = list
    .map((x) => {
      const [s1, s2] = String(x.s || '-').split('-');
      return `<div class="h2h-row one-res" data-player="${x.op.id}" style="cursor:pointer">
        <div class="h2h-date">${fmtD(x.at)}<small>${esc(x.ph ? `${x.ph} · ${x.tn}` : x.tn)}</small></div>
        <div class="h2h-names"><div class="${x.w ? 'w' : ''}">${esc(p.n)}</div><div class="${x.w ? '' : 'w'}">${esc(x.op.n)}</div></div>
        <div class="h2h-score"><div class="${x.w ? 'w' : ''}">${s1 ?? '-'}</div><div class="${x.w ? '' : 'w'}">${s2 ?? '-'}</div></div>
        <span class="h2h-res big ${x.w ? 'w' : 'l'}">${x.w ? 'G' : 'P'}</span>
      </div>`;
    })
    .join('');
  return `${head}<div class="h2h-list">${rows}</div>`;
}

const H2H_SHOW = 10; // cruces visibles antes de "Mostrar más"
function h2hListHtml(m, winsA, total, label) {
  const full = m.h2hL || [];
  const list = ui.h2hMore ? full : full.slice(0, H2H_SHOW);
  const more =
    full.length > H2H_SHOW
      ? `<button type="button" class="h2h-more" data-h2hmore="1">${ui.h2hMore ? 'Mostrar menos' : `Mostrar más (${full.length - H2H_SHOW} enfrentamientos más)`}</button>`
      : '';
  const fmtD = (iso) => new Intl.DateTimeFormat(LOC(), { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ }).format(new Date(iso));
  const rows = list.length
    ? list
        .map((x) => {
          const aw = x.w != null ? x.w === m.a.id : x.sa > x.sb;
          return `<div class="h2h-row">
            <div class="h2h-date">${fmtD(x.at)}<small>${esc(x.ph ? `${x.ph} · ${x.tn}` : x.tn)}</small></div>
            <div class="h2h-names"><div class="${aw ? 'w' : ''}">${esc(m.a.n)}</div><div class="${aw ? '' : 'w'}">${esc(m.b.n)}</div></div>
            <div class="h2h-score"><div class="${aw ? 'w' : ''}">${x.sa ?? '-'}<span class="h2h-res ${aw ? 'w' : 'l'}">${aw ? 'G' : 'P'}</span></div><div class="${aw ? '' : 'w'}">${x.sb ?? '-'}<span class="h2h-res ${aw ? 'l' : 'w'}">${aw ? 'P' : 'G'}</span></div></div>
          </div>`;
        })
        .join('')
    : (m.h2h || '')
        .split('')
        .map((c) => `<div class="h2h-row"><div class="h2h-date">—</div><div class="h2h-names"><div class="${c === 'A' ? 'w' : ''}">${esc(m.a.n)}</div><div class="${c === 'A' ? '' : 'w'}">${esc(m.b.n)}</div></div><div class="h2h-score"><div>${c === 'A' ? 'G' : 'P'}</div><div>${c === 'A' ? 'P' : 'G'}</div></div></div>`)
        .join('');
  return `
    <div class="h2h-sum"><b>${winsA}</b><span class="lbl">${label || `Últimos ${total} enfrentamientos`}<br>${esc(m.a.n)} · ${esc(m.b.n)}</span><b>${total - winsA}</b></div>
    <div class="h2h-list">${rows}${more}</div>`;
}

// Tabla del grupo del torneo y lo que se juega cada jugador en el partido
// (scripts/lib/standings.js: 1.º-2.º final, 3.º-4.º 3er puesto, 5.º fuera).
const GROUP_Q = { F: ['Final', 'win'], T: ['3er puesto', ''], N: ['Sin final', ''], X: ['Fuera', 'loss'] };
function groupBlock(m) {
  const rows = data.calendar.groups?.[m.t];
  if (!rows) return '';
  m = data.calendar.matches.find((x) => x.id === m.id) || m; // datos recién recargados
  const tr = rows
    .map((r) => {
      const q = GROUP_Q[r.q];
      const me = r.p === m.a.id || r.p === m.b.id;
      return `<tr class="${me ? 'me' : ''}"><td class="num">${r.pos}</td><td class="who" data-player="${r.p}">${esc(r.n)}${q ? ` <span class="gq ${q[1]}">${q[0]}</span>` : ''}</td><td class="num">${r.w}-${r.l}</td><td class="num">${r.sw}-${r.sl}</td><td class="num">${r.bw != null ? `${r.bw}-${r.bl}` : '—'}</td><td class="num"><b>${r.pts}</b></td></tr>`;
    })
    .join('');
  const k = m.gk;
  const need = !k
    ? ''
    : k.early
    ? `<p class="note">${icon('info')} ${m.st === 'f' ? 'Todavía faltaban muchos partidos del grupo: los dos peleaban por la final.' : 'Todavía faltan muchos partidos del grupo: los dos pelean por la final.'}</p>`
    : [[m.a, k.a], [m.b, k.b]].map(([p, x]) => (x ? `<div class="gneed ${x.k}"><b>${esc(p.n)}</b><span>${esc(x.t)}</span></div>` : '')).join('');
  return `<div class="block" id="sheet-group">
      <div class="block-h"><span class="overline">Tabla del grupo</span><span style="font-size:11px;color:var(--muted)">1.º-2.º final · 3.º-4.º 3er puesto${rows.length >= 5 ? ' · 5.º fuera' : ''}</span></div>
      <div class="h2h-list scroll-x"><table class="ledger gtable"><thead><tr><th class="num">#</th><th>Jugador</th><th class="num">G-P</th><th class="num">Sets</th><th class="num">Bolas</th><th class="num">Puntos</th></tr></thead><tbody>${tr}</tbody></table></div>
      ${need ? `<div class="overline" style="margin:12px 0 6px">${m.st === 'f' ? 'Lo que se jugaba cada uno antes de este partido' : 'Lo que se juega cada uno'}</div>${need}` : ''}
    </div>`;
}

function openMatch(id) {
  const m = allById().get(Number(id));
  if (!m) return;
  Object.assign(pickEdit, { side: null, mode: null, open: false });
  ui.h2hMore = false;
  tapFx(); // "tic" y vibración al abrir un partido
  const pick = m.pick || (m.c ? m : null);
  const draw = () => {
    const lv = liveFor(m);
    const favA = pick && pick.fav === m.a.id;
    const cA = pick ? (favA ? pick.c : 100 - pick.c) : 50;
    const fav = pick ? (favA ? m.a : m.b) : null;
    const tab = ui.formTab;
    const n = tab === 'L10' ? 10 : 5;
    const h2hWinsA = (m.h2h || '').split('').filter((c) => c === 'A').length;
    const h2hTotal = (m.h2h || '').length;
    const center = m.st === 'f'
      ? `<div class="mid"><span class="badge">${esc(m.ph || 'Terminado')}</span><span class="score">${m.sa}-${m.sb}</span><span class="tn">Se jugó ${esc(dayLabel(dayKey(m.at)).toLowerCase())} · ${fmtTime(m.at)}</span></div>`
      : lv
      ? `<div class="mid"><span class="badge live">EN VIVO</span><span class="score">${lv.setsHome}-${lv.setsAway}</span><span class="tn">${esc(lv.ptsHome)} : ${esc(lv.ptsAway)}</span></div>`
      : `<div class="mid"><span class="badge red">● ${fmtTime(m.at)}</span><div class="vs">VS</div></div>`;
    $sheetBody.innerHTML = `
    <div class="sheet-hero">
      <div class="side ${favA ? 'fav' : ''}" data-player="${m.a.id}" style="cursor:pointer">${avatar(m.a, 'avatar lg')}<span class="nm" style="font-size:15px">${esc(m.a.n)}</span><span class="sub">Rating ${m.a.r ?? '—'}</span></div>
      ${center}
      <div class="side ${pick && !favA ? 'fav' : ''}" data-player="${m.b.id}" style="cursor:pointer">${avatar(m.b, 'avatar lg')}<span class="nm" style="font-size:15px">${esc(m.b.n)}</span><span class="sub">Rating ${m.b.r ?? '—'}</span></div>
    </div>
    <div class="kv">
      <div><small>${m.ph ? esc(m.ph) : 'Torneo'}</small><b style="font-size:13px">${esc((m.tn || '').replace(/^Tournament\s*/i, ''))}</b></div>
      <div><small>Cuota</small><b>${odds(pick?.o)}</b></div>
      <div><small>Estado</small><b class="red" style="font-size:14px">${m.st === 'f' ? 'FINAL' : lv ? 'EN VIVO' : 'PROGRAMADO'}</b></div>
    </div>
    ${pick && !pick.locked && pick.chg ? `<p class="note" style="margin:12px 0 0">${icon('info')} El sistema cambió este pick al revisarlo antes de empezar (con la forma del día y la cuota más recientes).</p>` : ''}
    ${pick?.locked ? `<div style="margin-top:12px">${premiumLock('Pick Premium de alta confianza', 'El sistema tiene un pick de 60% o más para este partido. Hazte Premium para ver a quién elige, su confianza, la cuota y el análisis.')}</div>` : ''}
    ${pick && !pick.locked && pick.res === 'pending' ? `<button class="btn ${isFollowed(m.id) ? 'ghost' : 'primary'}" style="margin:12px 0 2px" data-follow-btn="${m.id}">${icon('heart')} ${isFollowed(m.id) ? 'Dejar de seguir' : 'Seguir este pick'}</button>` : ''}
    ${
      lv
        ? `<div class="block"><div class="block-h"><span class="overline">Marcador en vivo</span><span class="badge live">cada 2 s</span></div><div id="sheet-live">${liveCard(lv, m, { inSheet: true })}</div></div>`
        : ''
    }
    <div class="block">
      <div class="block-h"><span class="overline">Forma reciente</span><div class="seg">${['L5', 'L10', 'H2H'].map((t) => `<button data-ft="${t}" class="${tab === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      ${
        tab === 'H2H'
          ? (() => {
              const full = h2hFull(m, draw);
              if (full === 'loading') return h2hTotal ? '<div class="note">Cargando enfrentamientos…</div>' : '<p class="note">Sin enfrentamientos directos registrados.</p>';
              if (full) {
                const span = full.full ? 'en 2026' : `desde el ${full.since}`;
                const loading = full.full ? '' : `<p class="note" style="margin-top:8px">${icon('info')} Se está cargando el historial completo de 2026 desde tt.league-pro; los enfrentamientos anteriores al ${full.since} aparecerán en las próximas horas.</p>`;
                if (!full.list.length) return `<p class="note">Sin enfrentamientos directos ${span}.</p>${loading}`;
                const wA = full.list.filter((x) => x.w === m.a.id).length;
                return h2hListHtml({ ...m, h2hL: full.list }, wA, full.list.length, `${full.list.length} enfrentamientos ${span}`) + loading;
              }
              return h2hTotal ? h2hListHtml(m, h2hWinsA, h2hTotal) : '<p class="note">Sin enfrentamientos directos registrados.</p>';
            })()
          : [m.a, m.b].map((p, i) => formListHtml(p, (i ? m.fb : m.fa) || '', n, playerLast(p.id, m.at, draw))).join('')
      }
    </div>
    ${groupBlock(m)}
    ${
      pick?.locked
        ? ''
        : pick
        ? `<div class="block">
      <div class="block-h"><span class="overline">Probabilidad de victoria</span><span style="font-size:11px;color:var(--muted)">según el modelo</span></div>
      <div class="prob"><b>${cA}%</b><div class="meter"><span style="width:${cA}%"></span><span class="other" style="width:${100 - cA}%"></span></div><b>${100 - cA}%</b></div>
      <div class="prob-x"><span>${esc(m.a.n)}</span><span>${esc(m.b.n)}</span></div>
      ${pick.c < PAREJO ? `<p class="note" style="margin:10px 0 0">${icon('info')} Partido parejo: el modelo ve poca ventaja (menos de ${PAREJO}%). Es un pick de baja confianza.</p>` : ''}
    </div>
    <div class="block">
      <div class="analysis">
        <div class="an-head">${icon('bolt')}<div><b>Análisis IA</b><small>Por qué el sistema elige a ${esc(fav.n)}</small></div><span class="conf" style="font-size:20px">${pick.c}%</span></div>
        ${
          !isPremiumUser() && pick.res === 'pending'
            ? `<p class="an-src" style="font-size:13px">🔒 El análisis completo de por qué el sistema elige a este jugador (rating, mercado, cruce directo, patrón de rachas y forma del día) es parte de <a class="textlink" href="#/premium">Premium</a>.</p>`
            : pick.why
            ? `${pick.why.pro.length ? `<ul class="why pro">${pick.why.pro.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
               ${pick.why.con.length ? `<div class="overline" style="margin:12px 0 6px">A tener en cuenta</div><ul class="why con">${pick.why.con.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
               <p class="an-src">${icon('info')} ${esc(pick.why.src)}.</p>`
            : `<p class="an-src">Pick: <b>${esc(fav.n)}</b> gana con ${pick.c}% de confianza${pick.o ? ` (cuota ${odds(pick.o)})` : ''}. Rating ${m.a.r ?? '—'} vs ${m.b.r ?? '—'}${h2hTotal ? `, cruce directo ${h2hWinsA}-${h2hTotal - h2hWinsA}` : ''}.</p>`
        }
        ${pick.res === 'hit' ? '<div class="badge win" style="margin-top:10px">✓ Resultado: acierto</div>' : pick.res === 'miss' ? '<div class="badge loss" style="margin-top:10px">✗ Resultado: fallo</div>' : ''}
      </div>
    </div>`
        : noPickBlock(m, lv)
    }`;
  };
  draw();
  $sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  $sheet._redraw = draw;
  $sheet._refreshGroup = () => {
    const box = document.getElementById('sheet-group');
    const html = groupBlock(m);
    if (box && html && box.outerHTML !== html) box.outerHTML = html;
  };
  sheetUnsub?.();
  // En vivo: solo se actualiza el marcador de la ficha (las fotos no se
  // recargan). Si el partido empieza o termina, ahí sí se redibuja.
  let wasLive = Boolean(liveFor(m));
  sheetUnsub = onLive(() => {
    if ($sheet.hidden) return;
    const lv = liveFor(m);
    if (Boolean(lv) !== wasLive) {
      wasLive = Boolean(lv);
      return draw();
    }
    const box = document.getElementById('sheet-live');
    if (lv && box) patchLive(box, liveCard(lv, m, { inSheet: true }));
    const center = $sheetBody.querySelector('.sheet-hero .mid .score');
    if (lv && center) center.textContent = `${lv.setsHome}-${lv.setsAway}`;
  });
}

// Avisos de la campana: SOLO picks destacados (nuevos y su resultado) y
// el resultado de los picks que el usuario sigue. Nada del resto del sistema.
function notifItems() {
  const items = new Map();
  const map = allById();
  // Resultados de mis picks seguidos
  for (const id of follows) {
    const p = map.get(id);
    if (!p || (p.res !== 'hit' && p.res !== 'miss')) continue;
    const fav = p.fav === p.a.id ? p.a : p.b;
    items.set(id, { at: p.at, ic: p.res === 'hit' ? 'trophy' : 'x', t: p.res === 'hit' ? `✅ Ganó tu pick: ${fav.n}` : `❌ Perdió tu pick: ${fav.n}`, s: `${p.a.n} ${p.sa}-${p.sb} ${p.b.n}`, id });
  }
  // Picks seguidos (o el destacado) que cambiaron de jugador antes de empezar
  for (const p of upcomingPicks()) {
    if (!p.chg || p.locked || items.has(p.id) || !(follows.has(p.id) || p.ft)) continue;
    const fav = p.fav === p.a.id ? p.a : p.b;
    items.set(p.id, { at: p.at, ic: 'bolt', t: `🔄 ${p.ft ? 'Cambió el pick destacado' : 'Cambió tu pick'}: ahora ${fav.n}`, s: `${p.a.n} vs ${p.b.n} · ${p.c}% · ${fmtTime(p.at)}`, id: p.id, fresh: true });
  }
  // Destacados ya resueltos
  for (const x of data.stats?.featured?.last || []) {
    if (items.has(x.id)) continue;
    items.set(x.id, { at: x.at, ic: x.res === 'hit' ? 'trophy' : 'x', t: `⭐ Destacado ${x.res === 'hit' ? '✅ acertado' : '❌ fallado'}: ${x.fav}`, s: `${x.c}% de confianza${x.o ? ` · cuota ${odds(x.o)}` : ''}`, id: x.id });
  }
  // Destacado actual (nuevo)
  const cur = upcomingPicks().find((p) => p.ft);
  if (cur && !items.has(cur.id)) {
    const fav = cur.fav === cur.a.id ? cur.a : cur.b;
    items.set(cur.id, { at: cur.at, ic: 'flame', t: `⭐ Nuevo pick destacado: ${fav.n} gana`, s: `${cur.a.n} vs ${cur.b.n} · ${cur.c}% · ${fmtTime(cur.at)}`, id: cur.id, fresh: true });
  }
  return [...items.values()].sort((a, b) => (a.fresh ? -1 : b.fresh ? 1 : a.at < b.at ? 1 : -1));
}

function openNotifications() {
  const items = notifItems();
  writeLocal('cr_notif_keys', items.map((i) => i.t));
  $sheetBody.innerHTML = `
    <h2 style="margin:6px 0 4px;font-size:20px">Notificaciones</h2>
    <p style="color:var(--muted);font-size:13px;margin:0 0 14px">Picks destacados y resultados de los picks que sigues</p>
    ${FB.enabled ? `<a class="btn ghost" style="margin-bottom:12px" href="#/notificaciones">${icon('bell')} Recibir estos avisos en el celular</a>` : ''}
    <div class="list">${items.length ? items.slice(0, 20).map((i) => `<button class="row" data-open="${i.id}"><span class="ic">${icon(i.ic)}</span><span class="tx"><b>${esc(i.t)}</b><small>${esc(i.s)}</small></span></button>`).join('') : '<div class="row"><span class="tx"><small>Sin novedades por ahora.</small></span></div>'}</div>`;
  $sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  writeLocal('cr_notif_seen', Date.now());
  document.querySelector('#btn-notif .dot').hidden = true;
}

function closeSheet() {
  $sheet.hidden = true;
  $sheet.classList.remove('pw');
  document.body.style.overflow = '';
  sheetUnsub?.();
  sheetUnsub = null;
}

// ---------------- pantalla de bloqueo ----------------

// Enlace a Telegram con el mensaje ya escrito.
const telegramLink = (text) => `${TELEGRAM_URL}?text=${encodeURIComponent(text)}`;

function viewLock() {
  const head = `<img class="lock-logo" src="icons/icon-512.png" alt="CamiloRey" width="132" height="132">`;
  // Mientras Firebase dice si hay sesión (un instante al abrir).
  if (!FB.authReady()) return `<section class="lock">${head}<p class="lock-wait">Cargando…</p></section>`;
  if (!Vault.supported())
    return `<section class="lock">${head}<h1>Actualiza tu navegador</h1><p>Este navegador es muy antiguo para abrir CamiloRey. Usa Chrome o Safari actualizados.</p></section>`;
  const intro = '<p>Un espacio exclusivo para nuestros miembros: picks de tenis de mesa analizados con nuestro modelo IA, marcador en vivo y resultados verificados de la Liga Pro Checa.</p>';
  if (!account) {
    return `<section class="lock">${head}
      <div class="lock-over">Sistema de CamiloRey</div>
      <h1>¡Te damos la bienvenida!</h1>${intro}
      <a class="btn primary" href="#/login">Iniciar sesión</a>
      <a class="btn ghost" href="#/registro">Crear cuenta</a>
      <a class="btn tg" href="${esc(telegramLink('Hola, buen día. Me gustaría obtener acceso al Sistema de CamiloRey. ¿Me podrías indicar cómo hacerlo? ¡Muchas gracias!'))}" target="_blank" rel="noopener">${icon('telegram')} Solicitar acceso por Telegram</a>
      <p class="note">¿Aún no eres miembro? Crea tu cuenta y escríbenos por Telegram con tu correo. Con gusto activamos tu acceso.</p>
    </section>`;
  }
  const expired = membership && !membership.active;
  const fecha = expired ? membership.until.toLocaleDateString(LOC(), { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const msg = `Hola, buen día. Me gustaría ${expired ? 'renovar' : 'activar'} mi acceso al Sistema de CamiloRey. El correo de mi cuenta es ${account.email || ''}. Quedo pendiente. ¡Muchas gracias!`;
  return `<section class="lock">${head}
    <div class="lock-over">Sistema de CamiloRey</div>
    <h1>Hola, ${esc(userName().split(' ')[0])}</h1>
    <div class="card pad lock-card">${
      expired
        ? `Tu acceso finalizó el <b>${esc(fecha)}</b>. Gracias por ser parte del Sistema de CamiloRey: puedes renovarlo cuando quieras y seguir disfrutando de todos los picks.`
        : 'Tu cuenta ya está creada, pero todavía no tiene un acceso activo. Escríbenos por Telegram y con gusto lo activamos.'
    }<br><small>Cuenta: <b>${esc(account.email || '')}</b></small></div>
    <a class="btn primary tg" href="${esc(telegramLink(msg))}" target="_blank" rel="noopener">${icon('telegram')} ${expired ? 'Renovar mi acceso' : 'Solicitar acceso'} por Telegram</a>
    <p class="note">Apenas activemos tu acceso, el sitio se abrirá automáticamente en esta pantalla, sin necesidad de recargar.</p>
    <button class="btn ghost" id="btn-logout">Cerrar sesión</button>
  </section>`;
}

// ---------------- enrutador ----------------

const ROUTES = {
  inicio: viewInicio,
  calendario: viewCalendario,
  picks: viewPicks,
  envivo: viewEnVivo,
  seguidos: viewSeguidos,
  bankroll: viewBankroll,
  resultados: viewBankroll,
  perfil: viewPerfil,
  cuenta: viewCuenta,
  jugador: viewJugador,
  admin: viewAdmin,
  soporte: viewSoporte,
  notificaciones: viewNotificaciones,
  premium: viewPremium,
  tema: viewTema,
  cuotas: viewCuotas,
  idioma: viewIdioma,
  ayuda: viewAyuda,
  aviso: viewAviso,
  privacidad: () => viewLegal('privacidad'),
  terminos: () => viewLegal('terminos'),
  login: () => viewLogin('login'),
  registro: () => viewLogin('registro')
};

function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'inicio').toLowerCase();
  document.body.classList.toggle('locked', !hasAccess());
  if (!hasAccess() && !OPEN_ROUTES.has(name)) {
    liveUnsub?.();
    liveUnsub = null;
    $view.innerHTML = viewLock();
    return;
  }
  const fn = ROUTES[name] || viewInicio;
  $view.innerHTML = fn(location.hash.replace(/^#\/?/, '').split('/')[1]);
  const tab = name === 'resultados' ? 'bankroll' : name;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  liveUnsub?.();
  liveUnsub = null;
  if (name === 'inicio' || !ROUTES[name]) liveUnsub = onLive(renderLiveHome);
  else if (name === 'envivo') liveUnsub = onLive(renderLivePage);
  else if (['calendario', 'picks'].includes(name)) {
    // Si un partido de la lista empezó, se redibuja para sacarlo (los en
    // vivo se ven solo en la pestaña En vivo).
    liveUnsub = onLive(() => {
      const map = allById();
      const started = [...document.querySelectorAll('#view [data-match]')].some((c) => {
        const m = map.get(Number(c.dataset.match));
        return m && m.st !== 'f' && liveFor(m);
      });
      if (started && $sheet.hidden) {
        const y = window.scrollY;
        route();
        window.scrollTo(0, y);
      }
    });
  }
  else if (name === 'seguidos') {
    // Con seguidos en vivo: actualiza solo marcador y estado de cada
    // tarjeta (las fotos no se recargan).
    liveUnsub = onLive(() => {
      const map = allById();
      if (![...follows].some((id) => map.get(id) && liveFor(map.get(id)))) return;
      const grid = $view.querySelector('.fgrid');
      if (!grid || !$sheet.hidden) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = viewSeguidos();
      const fresh = tmp.querySelector('.fgrid');
      if (fresh) patchLive(grid, fresh.innerHTML);
    });
  }
  renderCounter();
  if (tab === 'bankroll') renderAdminLedger();
  if (name === 'inicio' || !ROUTES[name]) renderTipsterHome();
}

// Contador del pie: se lee de Firestore como máximo cada 5 minutos (antes
// eran 3 lecturas en cada cambio de pantalla) y solo después de cargar
// Firebase (que se carga un instante después de la primera pantalla).
let counterCache = { at: 0, c: null };
let adminUsers = null; // cuentas registradas reales (parte privada del admin)
async function renderCounter() {
  const el = document.getElementById('foot-counter');
  // Visitas y usuarios: solo los ve la cuenta admin.
  if (!el || !FB.enabled || !fbStarted || !isAdmin()) return;
  try {
    if (Date.now() - counterCache.at > 5 * 60e3) {
      counterCache = { at: Date.now(), c: await FB.getCounters() };
      adminUsers = (await FB.loadAdminLedger().catch(() => ({}))).users ?? adminUsers;
    }
    const c = counterCache.c;
    if (c) el.innerHTML = `${icon('eye', 'icon').replace('class="icon"', 'class="icon" style="display:inline;width:13px;height:13px;vertical-align:-2px"')} ${fmtInt(c.today)} visitas hoy · ${fmtInt(c.total)} en total · ${(adminUsers ?? '—')} usuarios`;
  } catch {}
}

// ---------------- eventos ----------------

// Vibración y "tic" al tocar pestañas (barra de abajo y pestañas internas).
document.addEventListener(
  'click',
  (ev) => {
    if (ev.target.closest('.tabbar a, .seg button, .chip-btn, .daynav button')) tapFx();
  },
  true
);

document.addEventListener('click', async (ev) => {
  const fxRow = ev.target.closest('[data-fx]');
  if (fxRow) {
    setFx(!fxEnabled());
    fxRow.classList.toggle('on', fxEnabled());
    tapFx();
    return;
  }
  // Tocar un jugador abre su perfil (tiene prioridad sobre abrir el partido).
  const pl = ev.target.closest('[data-player]');
  if (pl && !ev.target.closest('[data-follow]')) {
    closeSheet();
    location.hash = '#/jugador/' + pl.dataset.player;
    return;
  }
  const t = ev.target.closest('button, a, [data-open]');
  if (!t) return;

  if (t.dataset.follow) {
    ev.stopPropagation();
    return toggleFollow(Number(t.dataset.follow));
  }
  if (t.dataset.followBtn) {
    await toggleFollow(Number(t.dataset.followBtn));
    return $sheet._redraw?.();
  }
  // Apostar igual: abrir el editor del monto, confirmar, cancelar o quitar.
  const kid = Number(t.dataset.kedit || t.dataset.kok || t.dataset.kquit || 0);
  if (kid || t.dataset.kcancel) {
    const redrawBank = () => {
      const box = document.getElementById('kelly-body');
      if (box) box.innerHTML = kellyBodyHtml();
    };
    if (t.dataset.kcancel) {
      ui.kEdit = null;
      return redrawBank();
    }
    const pk = allById().get(kid);
    if (!pk || !betOpen(pk)) {
      ui.kEdit = null;
      toast('El partido ya empezó: no se puede cambiar la apuesta');
      return redrawBank();
    }
    const cur = bankSettings() || { start: 0 };
    const fm = forcedMap(cur);
    if (t.dataset.kedit) {
      ui.kEdit = kid;
      redrawBank();
      const inp = document.querySelector(`[data-kamt="${kid}"]`);
      inp?.focus();
      inp?.select();
      return;
    }
    const sk = new Set((cur.skip || []).map(Number));
    if (t.dataset.kquit) {
      delete fm[kid];
      sk.add(kid);
    } else {
      sk.delete(kid);
      const bal = userBank()?.bal || 0;
      const amt = parseMoney(document.querySelector(`[data-kamt="${kid}"]`)?.value);
      if (!amt) return toast('Escribe cuánto quieres apostar');
      if (amt > bal) return toast(`No puedes apostar más que tu banca (${money(bal)})`);
      fm[kid] = amt;
      ui.kEdit = null;
      toast(`Apuesta guardada: ${money(amt)}`);
    }
    await saveBankSettings({ ...cur, force: fm, skip: [...sk] });
    return redrawBank();
  }
  if (t.dataset.open) return openMatch(t.dataset.open);
  if (t.dataset.day) {
    ui.day += Number(t.dataset.day);
    return route();
  }
  if (t.dataset.risk) {
    const cur = bankSettings() || { start: 0 };
    await saveBankSettings({ ...cur, risk: t.dataset.risk });
    document.querySelectorAll('[data-risk]').forEach((b) => b.classList.toggle('on', b === t));
    const box = document.getElementById('kelly-body');
    if (box) box.innerHTML = kellyBodyHtml();
    return;
  }
  if (t.dataset.bt) {
    ui.bankTab = t.dataset.bt;
    return route();
  }
  if (t.dataset.lf) {
    ui.liveFilter = t.dataset.lf;
    document.querySelectorAll('[data-lf]').forEach((b) => b.classList.toggle('on', b === t));
    return renderLivePage(currentLive());
  }
  if (t.dataset.frange) {
    const i = FOLLOW_RANGES.findIndex((r) => r[0] === ui.followRange);
    ui.followRange = FOLLOW_RANGES[(i + 1) % FOLLOW_RANGES.length][0];
    return route();
  }
  if (t.dataset.calv) {
    ui.calView = t.dataset.calv;
    return route();
  }
  if (t.dataset.calf) {
    ui.calFilter = t.dataset.calf;
    return route();
  }
  if (t.dataset.pf) {
    ui.pickFilter = t.dataset.pf;
    return route();
  }
  if (t.dataset.rr) {
    ui.resRange = t.dataset.rr;
    return route();
  }
  if (t.dataset.ft) {
    ui.formTab = t.dataset.ft;
    return $sheet._redraw?.();
  }
  if (t.dataset.h2hmore) {
    ui.h2hMore = !ui.h2hMore;
    return $sheet._redraw?.();
  }
  if (t.dataset.chatsel !== undefined) {
    ui.chatSel = t.dataset.chatsel || null;
    adminChatDel = null;
    renderAdminChats();
    if (ui.chatSel) document.getElementById('admin-chats')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (t.dataset.chatendask) {
    adminChatEnd = t.dataset.chatendask;
    return renderAdminChats();
  }
  if (t.dataset.chatend !== undefined) {
    const res = t.dataset.chatend;
    const uid = adminChatEnd;
    if (!res || !uid) {
      adminChatEnd = null;
      return renderAdminChats();
    }
    return adminEndChat(uid, res);
  }
  if (t.dataset.chatdel) {
    if (adminChatDel !== t.dataset.chatdel) {
      adminChatDel = t.dataset.chatdel;
      return renderAdminChats();
    }
    await FB.adminDeleteChat(t.dataset.chatdel).catch((e) => toast(e.message));
    adminChatDel = null;
    ui.chatSel = null;
    return;
  }
  if (t.dataset.aday) {
    ui.adminDay = t.dataset.aday;
    return renderAdminDaily(false);
  }
  if (t.dataset.ledgerF) {
    ui.ledgerF = t.dataset.ledgerF;
    return renderAdminLedger();
  }
  if (t.dataset.oddsfmt) {
    writeLocal('cr_odds', t.dataset.oddsfmt);
    return route();
  }
  if (t.dataset.lang) {
    writeLocal('cr_lang', t.dataset.lang);
    location.reload(); // la traducción se aplica al cargar
    return;
  }
  if (t.dataset.themeSet) {
    setTheme(t.dataset.themeSet);
    return route();
  }
  if (t.id === 'btn-pw-preview') return showPremiumWelcome(new Date(Date.now() + memberDays * 86400e3));
  if (t.id === 'btn-ann-ok' || t.id === 'btn-ann-bank') closeSheet();
  if (t.id === 'btn-pw-start') {
    closeSheet();
    ui.pickFilter = 'high';
    if (location.hash === '#/picks') route();
    else location.hash = '#/picks';
    return;
  }
  if (t.id === 'btn-profile') return (location.hash = '#/perfil');
  if (t.id === 'btn-notif') return openNotifications();
  if (t.classList.contains('sheet-close')) return closeSheet();
  if (t.id === 'btn-google') {
    try {
      await FB.loginGoogle();
      location.hash = '#/inicio';
    } catch (e) {
      showAuthError(FB.errorText(e));
    }
  }
  if (t.id === 'btn-reset') {
    const email = document.querySelector('#form-auth [name=email]')?.value.trim();
    if (!email) return showAuthError('Escribe tu correo arriba y vuelve a tocar "Olvidé mi contraseña".');
    try {
      await FB.resetPassword(email);
      toast('Te enviamos un correo para cambiar la contraseña');
    } catch (e) {
      showAuthError(FB.errorText(e));
    }
  }
  if (t.id === 'btn-logout') {
    await FB.logout();
    toast('Sesión cerrada');
    location.hash = '#/inicio';
  }
  if (t.id === 'btn-delete') document.getElementById('del-confirm').hidden = false;
  if (t.id === 'btn-delete-yes') {
    try {
      await FB.deleteAccount();
      toast('Cuenta eliminada');
      location.hash = '#/inicio';
    } catch (e) {
      toast(e.code === 'auth/requires-recent-login' ? 'Por seguridad, cierra sesión, vuelve a entrar e inténtalo de nuevo.' : FB.errorText(e));
    }
  }
});

$sheet.addEventListener('click', (ev) => {
  if (ev.target === $sheet) closeSheet();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('[data-kamt]')) {
    ev.preventDefault();
    document.querySelector(`[data-kok="${ev.target.dataset.kamt}"]`)?.click();
    return;
  }
  if (ev.key === 'Escape' && !$sheet.hidden) closeSheet();
});

// ---------- notificaciones: botones ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('#btn-push-on, #btn-push-off, [data-npref]');
  if (!t) return;
  if (t.id === 'btn-push-on') return pushOn();
  if (t.id === 'btn-push-off') return pushOff();
  const st = await FB.loadPushState();
  const notify = { ...st.notify, [t.dataset.npref]: !st.notify[t.dataset.npref] };
  await FB.savePushState({ notify });
  t.classList.toggle('on', notify[t.dataset.npref]);
});

// ---------- panel admin: pick del tipster ----------
let tipsterSide = null;
document.addEventListener('change', (ev) => {
  if (ev.target.name !== 'mid' || !ev.target.closest('#tipster-form')) return;
  const m = allById().get(Number(ev.target.value));
  tipsterSide = null;
  document.querySelectorAll('#tipster-side [data-side]').forEach((b) => {
    const p = m ? (b.dataset.side === 'a' ? m.a : m.b) : null;
    b.textContent = p ? p.n : b.dataset.side === 'a' ? 'Jugador A' : 'Jugador B';
    b.disabled = !p;
    b.classList.remove('on');
  });
});
document.addEventListener('click', async (ev) => {
  const sideBtn = ev.target.closest('#tipster-side [data-side]');
  if (sideBtn) {
    tipsterSide = sideBtn.dataset.side;
    document.querySelectorAll('#tipster-side [data-side]').forEach((b) => b.classList.toggle('on', b === sideBtn));
    return;
  }
  const del = ev.target.closest('[data-tdel]');
  if (del && isAdmin()) {
    await FB.deleteTipster(del.dataset.tdel);
    await loadTipster(true);
    toast('Pick del tipster borrado');
    renderAdminPanel();
    if (!$sheet.hidden) $sheet._redraw?.();
    return;
  }
  // Editor de pick del admin en la ficha del partido
  const pe = ev.target.closest('[data-pe-open], [data-pe-close], [data-pe-side], [data-pe-mode], [data-pe-save]');
  if (pe && isAdmin()) {
    if (pe.dataset.peOpen) pickEdit.open = true;
    if (pe.dataset.peClose) Object.assign(pickEdit, { open: false, side: null });
    if (pe.dataset.peSide) pickEdit.side = pe.dataset.peSide;
    if (pe.dataset.peMode) pickEdit.mode = pe.dataset.peMode;
    if (pe.dataset.peSave) {
      const m = allById().get(Number(pe.dataset.peSave));
      const np = adminNoPick[m.id] || {};
      const fav = pickEdit.side === 'a' ? m.a : m.b;
      const op = pickEdit.side === 'a' ? m.b : m.a;
      const mode = pickEdit.mode || (liveFor(m) || m.st === 'l' ? 'live' : 'pre');
      try {
        pe.disabled = true;
        await FB.saveTipster({ mid: m.id, fav: fav.id, favName: fav.n, opName: op.n, at: m.at, tn: m.tn, note: (document.getElementById('pe-note')?.value || '').trim().slice(0, 160), odds: (pickEdit.side === 'a' ? np.oA : np.oB) ?? null, mode });
        await loadTipster(true);
        Object.assign(pickEdit, { open: false, side: null });
        toast(`Pick publicado: ${fav.n} gana`);
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'Sin permiso: revisa las reglas de Firestore' : FB.errorText(e));
      }
    }
    $sheet._redraw?.();
    return;
  }
});
document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'tipster-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const m = allById().get(Number(f.get('mid')));
  if (!m) return toast('Elige un partido');
  if (!tipsterSide) return toast('Elige quién gana');
  const fav = tipsterSide === 'a' ? m.a : m.b;
  const op = tipsterSide === 'a' ? m.b : m.a;
  try {
    await FB.saveTipster({ mid: m.id, fav: fav.id, favName: fav.n, opName: op.n, at: m.at, tn: m.tn, note: String(f.get('note') || '').trim().slice(0, 160) });
    toast('Pick del tipster publicado');
    ev.target.reset();
    tipsterSide = null;
    route();
  } catch (e) {
    toast(e.code === 'permission-denied' ? 'Falta actualizar las reglas de Firestore' : FB.errorText(e));
  }
});

// ---------- editar perfil (nombre y foto) ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  if (t.id === 'btn-name-edit') {
    document.getElementById('name-row').hidden = true;
    const form = document.getElementById('name-form');
    form.hidden = false;
    form.querySelector('input').focus();
  }
  if (t.id === 'btn-photo-del') {
    await FB.saveProfile({ photo: null });
    profile = { ...profile, photo: null };
    renderAuthHeader();
    route();
    toast('Foto quitada');
  }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'name-form') return;
  ev.preventDefault();
  const name = String(new FormData(ev.target).get('name') || '').trim().slice(0, 40);
  if (!name) return;
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  try {
    await FB.saveProfile({ name });
    profile = { ...profile, name };
    renderAuthHeader();
    route();
    toast('Nombre actualizado');
  } catch (e) {
    toast(FB.errorText(e));
    btn.disabled = false;
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'photo-input' || !ev.target.files?.[0]) return;
  const file = ev.target.files[0];
  if (!file.type.startsWith('image/')) return toast('Elige una imagen');
  toast('Subiendo foto...');
  try {
    const photo = await resizePhoto(file);
    await FB.saveProfile({ photo });
    profile = { ...profile, photo };
    renderAuthHeader();
    route();
    toast('Foto actualizada');
  } catch (e) {
    toast(e.message || 'No se pudo cambiar la foto');
  }
});

// Mi Bankroll: guarda la banca inicial y recalcula sin perder el foco.
document.addEventListener('input', (ev) => {
  if (ev.target.matches?.('[data-kamt]')) {
    const v = parseMoney(ev.target.value);
    const win = ev.target.parentElement.querySelector('.kwin');
    if (win) win.textContent = `gana ${money(v * (Number(ev.target.dataset.odds) - 1))}`;
    return;
  }
  if (ev.target.id !== 'kelly-start') return;
  const start = Number(ev.target.value.replace(/\D/g, '').slice(0, 13)) || 0;
  const cur = bankSettings() || { risk: 'equilibrado' };
  clearTimeout(ev.target._t);
  writeLocal('cr_kelly', { ...cur, start });
  if (profile?.bank) profile = { ...profile, bank: { ...cur, start } }; // bankSettings() lee primero el perfil
  const box = document.getElementById('kelly-body');
  if (box) box.innerHTML = kellyBodyHtml();
  // Al guardar se toma la configuración más reciente (pudo cambiar en estos 800 ms).
  ev.target._t = setTimeout(() => saveBankSettings({ ...(bankSettings() || cur), start }), 800);
});

// Moneda de la banca: se guarda y se redibuja Mi Bankroll con ese formato.
document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'kelly-cur') return;
  const cur = bankSettings() || { risk: 'equilibrado' };
  await saveBankSettings({ ...cur, cur: ev.target.value });
  const lbl = document.querySelector('#kelly-start')?.closest('.field')?.querySelector('span');
  if (lbl) lbl.textContent = `Banca inicial (${ev.target.value})`;
  const box = document.getElementById('kelly-body');
  if (box) box.innerHTML = kellyBodyHtml();
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'form-auth') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (ev.target.dataset.mode === 'registro') await FB.registerEmail(String(f.get('name')).trim(), String(f.get('email')).trim(), String(f.get('password')));
    else await FB.loginEmail(String(f.get('email')).trim(), String(f.get('password')));
    toast('¡Bienvenido!');
    location.hash = '#/inicio';
  } catch (e) {
    showAuthError(FB.errorText(e));
  } finally {
    btn.disabled = false;
  }
});

function showAuthError(msg) {
  const el = document.getElementById('auth-err');
  if (!el) return toast(msg);
  el.textContent = msg;
  el.hidden = false;
}

function setTheme(raw) {
  writeLocal('cr_theme_raw', raw);
  try {
    localStorage.setItem('cr_theme', raw);
  } catch {}
  const t = raw === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : raw;
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name=theme-color]').setAttribute('content', t === 'light' ? '#f4f4f5' : '#0a0a0b');
}

// ---------------- arranque ----------------

window.addEventListener('hashchange', () => {
  closeSheet();
  route();
  window.scrollTo(0, 0);
});

hydrateIcons();
startI18n();
Vault.setLoader(() => FB.loadVault());
// Primera pantalla: "Cargando…" hasta saber si hay sesión con acceso; los
// datos se cargan en startFirebase (solo para miembros).
route();

// Punto rojo en la campana si hay un aviso (destacado o resultado de un
// seguido) que todavía no se vio.
function updateBellDot() {
  const seenKeys = new Set(readLocal('cr_notif_keys', []));
  document.querySelector('#btn-notif .dot').hidden = !notifItems().some((i) => !seenKeys.has(i.t));
}
updateBellDot();

// Datos nuevos cada minuto (el sync corre cada ~5 min).
setInterval(async () => {
  if (document.visibilityState === 'hidden') return;
  // Con la ficha de un partido abierta no se redibuja todo (se perdería lo
  // que la persona está mirando): solo se actualiza la tabla del grupo, para
  // que las posiciones se muevan solas a medida que terminan los partidos.
  if (!$sheet.hidden) {
    await loadData();
    $sheet._refreshGroup?.();
    return;
  }
  // Revisa el acceso cada minuto: si el admin lo acaba de activar, se
  // desbloquea sin recargar (con la bienvenida); si venció, se bloquea.
  if (account) await refreshPremium();
  await loadData();
  // No redibujar si la persona está escribiendo (ej. respondiendo un chat).
  if (document.activeElement?.matches?.('#view textarea, #view input, #view select')) return;
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
  updateBellDot();
}, 60000);

// Botón "Entrar" visible arriba cuando no hay sesión; con sesión, el
// ícono de perfil muestra la inicial o la foto de la cuenta.
function renderAuthHeader() {
  const btn = document.getElementById('btn-login');
  const prof = document.getElementById('btn-profile');
  btn.hidden = !FB.enabled || Boolean(account);
  prof.innerHTML = account ? `<span class="me-dot">${userAvatar()}</span>` : icon('user');
}
renderAuthHeader();

// Firebase (~170 KB) se carga DESPUÉS de mostrar los picks, para que la
// primera pantalla salga rápido. Si la persona ya tenía sesión, se carga de
// inmediato para que no vea "Entrar" ni candados de más.
function startFirebase() {
  if (fbStarted) return;
  fbStarted = true;
  FB.onAuth(async (u) => {
    if (!FB.authReady()) return; // aviso inicial, antes de que Firebase sepa si hay sesión
    account = u;
    writeLocal('cr_had_session', Boolean(u));
    profile = u ? await FB.loadProfile().catch(() => null) : null;
    await refreshPremium();
    // Datos solo con acceso vigente (refreshPremium ya los borró si no).
    if (hasAccess()) await loadData();
    renderAuthHeader();
    syncChatUser();
    if (isAdmin()) startAdminChats();
    if (u) {
      const remote = await FB.loadFollows().catch(() => null);
      if (remote) {
        follows = new Set([...remote, ...follows]);
        writeLocal('cr_follows', [...follows]);
        FB.saveFollows([...follows]).catch(() => {});
      }
    }
    // También con la bienvenida Premium abierta si detrás está el bloqueo o
    // "Cargando…": si no, al cerrarla seguiría esa pantalla.
    if ($sheet.hidden || $view.querySelector('.lock')) route();
    window.crSplashDone?.(); // pantalla de carga (index.html)
  });
}
// Firebase se carga siempre al abrir: sin sesión con acceso no se ve nada.
startFirebase();
REST.countVisit().catch(() => {});

// ---------- Soporte en vivo (chat con IA + persona) ----------

// Combinadas para el chat: las cuentas (cuota total y probabilidad) se hacen
// aquí, exactas, y la IA solo las presenta. Solo con picks que el usuario
// puede ver (los Premium bloqueados no entran), con cuota, que empiezan en
// más de 5 min y sin repetir jugador (dos partidos del mismo jugador no son
// independientes).
function comboCandidates() {
  const now = Date.now();
  return data.picks
    .filter((p) => !p.locked && p.fav && p.o && p.o >= 1.15 && p.o <= 3.5 && p.res === 'pending' && new Date(p.at).getTime() > now + 5 * 60e3 && new Date(p.at).getTime() < now + 24 * 3600e3)
    .sort((a, b) => b.c - a.c || (a.at < b.at ? -1 : 1));
}

function pickCombo(cands, { legs, minOdds = 0, maxLegs = legs }) {
  const out = [];
  const used = new Set();
  for (const p of cands) {
    if (used.has(p.a.id) || used.has(p.b.id)) continue;
    out.push(p);
    used.add(p.a.id);
    used.add(p.b.id);
    const odds = out.reduce((s, x) => s * x.o, 1);
    if (out.length >= legs && odds >= minOdds) break;
    if (out.length >= maxLegs) break;
  }
  return out.length >= 2 ? out : null;
}

function comboText(name, legs) {
  if (!legs) return '';
  const odds = legs.reduce((s, x) => s * x.o, 1);
  const prob = legs.reduce((s, x) => s * (x.c / 100), 1);
  const legTxt = legs
    .map((p) => {
      const fav = p.fav === p.a.id ? p.a : p.b;
      return `   - ${fav.n} gana (${p.a.n} vs ${p.b.n}, ${dayLabel(dayKey(p.at))} ${fmtTime(p.at)}) · confianza ${p.c}% · cuota ${p.o.toFixed(2)}`;
    })
    .join('\n');
  return `* ${name}: ${legs.length} selecciones · CUOTA TOTAL ${odds.toFixed(2)} · probabilidad estimada de acertar todas ${Math.round(prob * 100)}%\n${legTxt}`;
}

function combosForChat() {
  const cands = comboCandidates();
  if (cands.length < 2) return '- Ahora mismo no hay suficientes picks con cuota por jugar para armar una combinada (se necesitan al menos 2). Explícalo y sugiere volver más tarde.';
  const lines = [
    comboText('Doble (las 2 de más confianza)', pickCombo(cands, { legs: 2 })),
    comboText('Triple (las 3 de más confianza)', pickCombo(cands, { legs: 3 })),
    comboText('Cuota alta (~3 o más, máximo 4 selecciones)', pickCombo(cands, { legs: 2, minOdds: 3, maxLegs: 4 }))
  ].filter(Boolean);
  const list = cands
    .slice(0, 15)
    .map((p) => {
      const fav = p.fav === p.a.id ? p.a : p.b;
      return `   - ${fav.n} gana (${p.a.n} vs ${p.b.n}, ${dayLabel(dayKey(p.at))} ${fmtTime(p.at)}) · confianza ${p.c}% · cuota ${p.o.toFixed(2)}`;
    })
    .join('\n');
  return `${[...new Set(lines)].join('\n')}\n- Picks disponibles para combinadas a medida (de más a menos confianza; no repitas jugador ni partido):\n${list}`;
}

function chatContext() {
  const s = data.stats;
  const h = s?.model?.holdout;
  const feat = data.picks.find((p) => p.ft);
  const tp = (tipsterCache || []).find((t) => t.at && new Date(t.at).getTime() > Date.now() - 3 * 3600e3);
  const lines = [];
  if (feat) {
    const fav = feat.fav === feat.a.id ? feat.a : feat.b;
    lines.push(`- Pick destacado ahora (público): ${fav.n} gana en ${feat.a.n} vs ${feat.b.n}, ${dayLabel(dayKey(feat.at))} a las ${fmtTime(feat.at)}, confianza ${feat.c}%${feat.o ? `, cuota ${feat.o}` : ''}.`);
  } else lines.push('- Ahora mismo no hay pick destacado publicado.');
  if (tp) lines.push(`- Pick del tipster reciente: ${tp.favName} gana contra ${tp.opName}.`);
  if (s?.featured) lines.push(`- Resultados de los picks destacados: ${JSON.stringify(s.featured).slice(0, 300)}`);
  return {
    now: new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: TZ }).format(new Date()),
    user: account ? `${account.displayName || 'sin nombre'} (${account.email || 'sin correo'}), con sesión iniciada` : 'visitante sin sesión iniciada',
    premium: isAdmin() ? 'es el administrador del sitio' : isPremiumUser() ? `sí, activo${membership?.until ? ` hasta ${membership.until.toLocaleDateString('es-CO')}` : ''}` : 'no',
    model: h?.all ? `Acierto del modelo medido en partidos que no vio: ${h.all.acc}% en todos, ${h.c55?.acc}% en los de 55% o más y ${h.c60?.acc}% en los de 60% o más. Es una medición, no una garantía.` : '',
    extra: lines.join('\n'),
    combos: combosForChat(),
    premiumLocked: !isPremiumUser() && data.picks.some((p) => p.locked && new Date(p.at).getTime() > Date.now())
  };
}

initChat({
  FB,
  getUser: () => account,
  getProfile: () => ({ name: userName(), photo: userPhoto() }),
  isPremium: () => isPremiumUser(),
  isAdmin: () => isAdmin(),
  context: chatContext,
  openLogin: () => (location.hash = '#/login'),
  openAdmin: () => {
    location.hash = '#/soporte';
    window.scrollTo(0, 0);
  },
  onTap: () => {
    tapFx();
    startFirebase(); // para guardar la conversación si hay sesión
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
