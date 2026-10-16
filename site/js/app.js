// ============================================================
// CamiloRey — aplicación (una sola página, rutas con #/...)
// Datos: site/data/*.json (los genera GitHub Actions cada ~10 min).
// En vivo: js/live.js (Rushbet/Kambi directo, cada 2 s).
// Cuenta y visitas: js/firebase.js (opcional).
// ============================================================

import { icon, hydrateIcons } from './icons.js';
import { onLive, currentLive, findLive } from './live.js';
import * as FB from './firebase.js';
import { TELEGRAM_URL, SUPPORT_EMAIL } from './config.js';

const TZ = 'America/Bogota';
const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetBody = $sheet.querySelector('.sheet-body');

const data = { stats: null, picks: [], results: [], calendar: { days: [], matches: [] }, bankroll: null, loaded: false, error: null };
const ui = { day: 1, calFilter: 'all', pickFilter: 'all', resRange: 'd30', formTab: 'L5', followRange: 'd7' };
let follows = new Set(readLocal('cr_follows', []));
let liveUnsub = null;
let sheetUnsub = null;
let account = null;

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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }).format(new Date(iso));
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
  return new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).format(d);
}
const longDate = () => new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date());
const pct = (v) => (v == null ? '—' : `${String(v).replace('.', ',')}%`);
const odds = (o) => (o ? Number(o).toFixed(2) : '—');
const initials = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const fmtInt = (n) => new Intl.NumberFormat('es-CO').format(n || 0);
const cop = (n) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0))}`;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${cop(Math.abs(n))}`;

function avatar(p, cls = 'avatar') {
  if (p?.av) {
    return `<img class="${cls}" src="${esc(p.av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${esc(initials(p.n))}</div>'">`;
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

async function getJson(name) {
  const r = await fetch(`data/${name}.json?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function loadData() {
  try {
    const [stats, picks, results, calendar] = await Promise.all([getJson('stats'), getJson('picks'), getJson('results'), getJson('calendar')]);
    const bankroll = await getJson('bankroll').catch(() => null);
    Object.assign(data, { stats, picks, results, calendar, bankroll, loaded: true, error: null });
  } catch (e) {
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
  if (follows.has(id)) follows.delete(id);
  else follows.add(id);
  writeLocal('cr_follows', [...follows]);
  if (FB.user()) FB.saveFollows([...follows]).catch(() => {});
  document.querySelectorAll(`[data-follow="${id}"]`).forEach((b) => b.classList.toggle('on', follows.has(id)));
  toast(follows.has(id) ? 'Agregado a Seguidos' : 'Quitado de Seguidos');
}

// ---------------- piezas ----------------

function liveFor(m) {
  if (m.st === 'f') return null;
  const started = m.st === 'l' || new Date(m.at).getTime() <= Date.now();
  if (!started) return null;
  return findLive(currentLive().all, m.a.n, m.b.n);
}

function midBlock(m) {
  const lv = liveFor(m);
  const ph = m.ph ? `<span class="badge red">🏆 ${esc(m.ph)}</span>` : '';
  if (m.st === 'f') {
    return `<div class="mid">${ph || '<span class="badge">Terminado</span>'}<span class="score">${m.sa}-${m.sb}</span><span class="tn">${esc(m.tn)}</span></div>`;
  }
  if (lv) {
    return `<div class="mid" data-live-mid="${m.id}"><span class="badge live">EN VIVO</span><span class="score">${lv.setsHome}-${lv.setsAway}</span><span class="tn">${m.ph ? `${esc(m.ph)} · ` : ''}${esc(lv.ptsHome)} : ${esc(lv.ptsAway)} pts</span></div>`;
  }
  return `<div class="mid">${ph}<span class="time">${fmtTime(m.at)}</span><span class="tn">${esc(m.tn)}</span></div>`;
}

function matchCard(m, pick = m.pick || (m.c ? m : null), { showForm = true } = {}) {
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
        <span class="conf">${pick.c}%</span>
        <span class="odds">${odds(pick.o)}</span>
        ${res}
        ${pick.res === 'pending' ? `<button class="follow ${isFollowed(m.id) ? 'on' : ''}" data-follow="${m.id}" aria-label="Seguir pick">${icon('heart')}</button>` : ''}
      </div>`
        : ''
    }
  </article>`;
}

function liveCard(e, ourMatch) {
  const row = (name, sets, pts, serving, mine) => `
    <div class="live-row">
      <div class="p">${serving ? '<i class="serve"></i>' : ''}<span>${esc(name)}</span></div>
      <div class="sets">${sets.map((s) => `<span class="${s.won ? 'won' : ''}">${s.v}</span>`).join('')}</div>
      <div class="pts">${esc(pts)}</div>
    </div>`;
  const setsH = e.sets.map((s) => ({ v: s.h, won: s.h > s.a && (s.h >= 11 || s.a >= 11) }));
  const setsA = e.sets.map((s) => ({ v: s.a, won: s.a > s.h && (s.h >= 11 || s.a >= 11) }));
  return `
  <article class="card live-card" ${ourMatch ? `data-open="${ourMatch.id}" style="cursor:pointer"` : ''}>
    <div class="live-head"><span><span class="badge live">EN VIVO</span> &nbsp;${esc(e.group)}</span><b style="color:var(--text)">${e.setsHome} - ${e.setsAway}</b></div>
    ${row(e.home, setsH, e.ptsHome, e.homeServe === true)}
    ${row(e.away, setsA, e.ptsAway, e.homeServe === false)}
    ${ourMatch?.pick ? `<div class="pickbar" style="padding:8px 0 0;border-top:1px solid var(--line);margin-top:6px"><span class="who">Nuestro pick: <b>${esc(ourMatch.pick.fav === ourMatch.a.id ? ourMatch.a.n : ourMatch.b.n)}</b></span><span class="conf">${ourMatch.pick.c}%</span></div>` : ''}
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

function viewInicio() {
  const s = data.stats;
  const name = account?.displayName?.split(' ')[0];
  const streak = s?.streak || 0;
  const streakTxt = streak > 0 ? `${streak}W 🔥` : streak < 0 ? `${-streak}L` : '—';
  const pend = data.picks;
  const avgOdds = (() => {
    const list = [...pend, ...data.results.slice(0, 40)].filter((p) => p.o);
    return list.length ? (list.reduce((a, p) => a + p.o, 0) / list.length).toFixed(2) : '—';
  })();
  const featured = pend.find((p) => p.ft) || pend[0];
  const upcoming = pend.filter((p) => p !== featured && new Date(p.at) > Date.now()).slice(0, 4);

  return `
  <section class="hero">
    <h1>${name ? `Hola, ${esc(name)} 👋` : 'Picks de hoy 🏓'}</h1>
    <p>${esc(longDate())} · ${pend.length} picks activos · Liga Pro Checa</p>
  </section>
  ${errorBox()}
  <div class="tiles">
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${pct(s?.d7?.pct)}</div><div class="hint">últimos 7 días</div></div>
    <div class="tile"><div class="overline">Racha</div><div class="val ${streak > 0 ? 'pos' : streak < 0 ? 'neg' : ''}">${streakTxt}</div><div class="hint">picks seguidos</div></div>
    <div class="tile"><div class="overline">Cuota prom.</div><div class="val">${avgOdds}</div><div class="hint">picks recientes</div></div>
  </div>
  ${s?.d7?.hit + s?.d7?.miss ? `<div class="banner"><span>⭐ CamiloRey acertó <b>${s.d7.hit}/${s.d7.hit + s.d7.miss}</b> en los últimos 7 días</span><a class="textlink" href="#/bankroll">Ver</a></div>` : ''}

  <div class="section-h"><h2><i class="live-dot red"></i> En vivo ahora</h2><a class="link" href="#/calendario">Calendario</a></div>
  <div id="live-home">${skeleton(1)}</div>

  ${
    featured
      ? `<div class="section-h"><h2>${icon('trophy')} Pick destacado</h2></div>${matchCard(featured, featured)}`
      : ''
  }
  <div class="section-h"><h2>${icon('flame')} Próximos picks</h2><a class="link" href="#/picks">Ver todos</a></div>
  ${!data.loaded ? skeleton(2) : upcoming.length ? `<div class="grid-2">${upcoming.map((p) => matchCard(p, p)).join('')}</div>` : empty('clock', 'Sin picks por ahora', 'Los picks se generan unas horas antes de cada torneo. Vuelve en un rato.')}
  ${footer()}`;
}

function renderLiveHome(state) {
  const box = document.getElementById('live-home');
  if (!box) return;
  const ours = data.calendar.matches;
  const list = state.liga.length ? state.liga : [];
  if (!state.at) return;
  if (!list.length) {
    const others = state.all.slice(0, 6);
    box.innerHTML = `<div class="note">No hay partidos de la Liga Pro en vivo en este momento.${others.length ? ' Otros partidos de tenis de mesa en vivo:' : ''}</div>${
      others.length ? `<div class="grid-2" style="margin-top:10px">${others.map((e) => liveCard(e, null)).join('')}</div>` : ''
    }`;
    return;
  }
  box.innerHTML = list
    .map((e) => {
      const m = ours.find((x) => findLive([e], x.a.n, x.b.n));
      return liveCard(e, m);
    })
    .join('');
}

function viewCalendario() {
  const days = data.calendar.days;
  if (!days.length) return `<h1 class="page-title">Calendario</h1>${data.loaded ? errorBox() || empty('calendar', 'Sin partidos', 'Aún no hay partidos cargados.') : skeleton(4)}`;
  ui.day = Math.max(0, Math.min(days.length - 1, ui.day));
  const key = days[ui.day];
  let list = data.calendar.matches.filter((m) => dayKey(m.at) === key);
  const total = list.length;
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
    <div class="seg"><button data-calf="all" class="${ui.calFilter === 'all' ? 'on' : ''}">Todos</button><button data-calf="pick" class="${ui.calFilter === 'pick' ? 'on' : ''}">Con pick</button></div>
  </div>
  ${
    groups.size
      ? [...groups.values()]
          .map(
            (g) => `<div class="section-h"><h2 style="font-size:14px">${esc(g.name)}</h2><span class="badge">${fmtTime(g.at)}</span></div>
            <div class="grid-2">${g.items.map((m) => matchCard(m)).join('')}</div>`
          )
          .join('')
      : empty('calendar', 'Sin partidos', ui.calFilter === 'pick' ? 'No hay picks para este día.' : 'No hay partidos este día.')
  }
  ${footer()}`;
}

function viewPicks() {
  let list = data.picks.slice();
  if (ui.pickFilter === 'high') list = list.filter((p) => p.c >= 68);
  if (ui.pickFilter === 'odds') list = list.filter((p) => p.o && p.o >= 1.6);
  return `
  <h1 class="page-title">Predicciones</h1>
  <div class="page-sub"><i class="live-dot"></i>${data.picks.length} picks · ${esc(longDate())}</div>
  <div class="toolbar">
    <div class="seg">
      <button data-pf="all" class="${ui.pickFilter === 'all' ? 'on' : ''}">Todos</button>
      <button data-pf="high" class="${ui.pickFilter === 'high' ? 'on' : ''}">Alta confianza</button>
      <button data-pf="odds" class="${ui.pickFilter === 'odds' ? 'on' : ''}">Cuota +1.60</button>
    </div>
  </div>
  <div class="card pad" style="display:flex;align-items:center;gap:10px;font-size:13px">${icon('clock')}<span style="flex:1">Se actualiza solo cada ~10 min${data.stats?.updatedAt ? ` · última: <b>${fmtTime(data.stats.updatedAt)}</b>` : ''}</span></div>
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
      : `<span class="fc-st wait" title="Pendiente">${icon('clock')}</span>`;
  const pillCls = p.res === 'hit' ? 'win' : p.res === 'miss' ? 'loss' : 'pend';
  const progress = favSets == null ? 0 : Math.min(100, (favSets / 3) * 100);
  const tn = (p.tn || '').replace(/^Tournament\s*/i, '');
  return `
  <article class="fcard" data-open="${p.id}" data-match="${p.id}">
    <div class="fc-photo">
      ${fav.av ? `<img src="${esc(fav.av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <span class="fc-ini">${esc(initials(fav.n))}</span>
      ${status}
      <span class="fc-tag">CR</span>
    </div>
    <div class="fc-body">
      <small class="fc-league">${esc(p.ph ? `${p.ph} · ${tn}` : tn)}</small>
      <b class="fc-name">${esc(fav.n)}</b>
      <small class="fc-sub">${esc(fav.n)} vs ${esc(riv.n)}</small>
      <small class="fc-sub">${esc(dayLabel(dayKey(p.at)))} · ${fmtTime(p.at)}${p.o ? ` · cuota ${odds(p.o)}` : ''}</small>
      <span class="fc-pill ${pillCls}"><i></i>GANA EL PARTIDO · ${p.c}%</span>
      <div class="fc-bar"><span style="width:${progress}%"></span></div>
      <div class="fc-sets"><span>${favSets == null ? '0' : favSets}${rivSets != null ? ` <em>- ${rivSets} sets</em>` : ''}</span>${lv ? `<span class="fc-live">${esc(lv.ptsHome)}:${esc(lv.ptsAway)}</span>` : ''}</div>
    </div>
  </article>`;
}

function viewSeguidos() {
  const map = allById();
  const range = FOLLOW_RANGES.find((r) => r[0] === ui.followRange) || FOLLOW_RANGES[0];
  const since = Date.now() - range[2] * 86400e3;
  const all = [...follows].map((id) => map.get(id)).filter((p) => p && p.c);
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
  const avgOdds = withOdds.length ? (withOdds.reduce((a, p) => a + p.o, 0) / withOdds.length).toFixed(2) : '—';
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

function myStakesHtml() {
  const b = data.bankroll;
  const bank = Number(readLocal('cr_bank', 0)) || 0;
  const stakeById = new Map((b?.pendingStakes || []).map((s) => [s.id, s.stake]));
  const list = data.picks.filter((p) => stakeById.has(p.id) && new Date(p.at) > Date.now()).slice(0, 12);
  if (!bank) return '<div class="stake-row"><span class="who"><small>Escribe tu banca arriba para ver cuánto apostar en cada pick.</small></span></div>';
  if (!list.length) return '<div class="stake-row"><span class="who"><small>No hay picks con cuota por jugar en este momento.</small></span></div>';
  const factor = bank / (b?.start || 2000000);
  return list
    .map((p) => {
      const fav = p.fav === p.a.id ? p.a : p.b;
      const st = Math.round((stakeById.get(p.id) * factor) / 100) * 100;
      return `<div class="stake-row" data-open="${p.id}" style="cursor:pointer"><span class="who"><b>${esc(fav.n)} gana</b><small>${fmtTime(p.at)} · ${p.c}% · cuota ${odds(p.o)}</small></span><span class="amt">${cop(st)}<small>gana ${cop(st * (p.o - 1))}</small></span></div>`;
    })
    .join('');
}

function viewBankroll() {
  const b = data.bankroll;
  const s = data.stats;
  const r = s?.[ui.resRange];
  const bank = Number(readLocal('cr_bank', 0)) || '';
  if (!data.loaded) return `<h1 class="page-title">Bankroll</h1>${skeleton(3)}`;
  return `
  <h1 class="page-title">Bankroll</h1>
  <div class="page-sub"><i class="live-dot"></i>Banca simulada de CamiloRey · se actualiza sola</div>
  ${
    b
      ? `<div class="bank-hero">
      <div class="overline">Banca actual</div>
      <div class="big">${cop(b.balance)}</div>
      <div class="delta ${b.profit >= 0 ? 'pos-t' : 'neg-t'}">${signed(b.profit)} · ROI ${pct(b.roi)}</div>
      <div style="font-size:12px;color:#a1a1aa;margin-top:6px">Inició con ${cop(b.start)} · ${b.bets} apuestas · ${b.hits} ganadas</div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="overline">Apostado</div><div class="val" style="font-size:17px">${cop(b.staked)}</div></div>
      <div class="tile"><div class="overline">Efectividad</div><div class="val">${b.bets ? pct(Math.round((b.hits / b.bets) * 1000) / 10) : '—'}</div></div>
      <div class="tile"><div class="overline">Máx. caída</div><div class="val neg" style="font-size:17px">${b.maxDrawdown ? '−' + cop(b.maxDrawdown) : '—'}</div></div>
    </div>
    ${b.series.length ? `<div class="card pad" style="margin-top:12px"><div class="overline">Evolución de la banca</div>${bankChart(b.series, b.start)}</div>` : '<div class="note" style="margin-top:12px">El gráfico aparece cuando se resuelvan los primeros picks con cuota.</div>'}`
      : '<div class="note">El bankroll se calcula en la próxima actualización (cada ~10 min).</div>'
  }

  <div class="section-h"><h2>${icon('wallet')} Tu banca</h2></div>
  <div class="card pad">
    <label class="field" style="margin:0"><span>¿Con cuánto dinero juegas? (COP)</span>
      <div class="money-input"><input id="bank-input" inputmode="numeric" placeholder="Ej: 500000" value="${bank}"></div></label>
    <p style="font-size:12px;color:var(--muted);margin:8px 0 0">Te sugerimos cuánto apostar en cada pick con la misma proporción del bankroll de CamiloRey (5% a 12,5% según la confianza). Se guarda solo en este dispositivo.</p>
  </div>
  <div class="list" id="my-stakes" style="margin-top:10px">${myStakesHtml()}</div>

  <div class="section-h"><h2>${icon('chart')} Efectividad</h2></div>
  <div class="toolbar"><div class="seg">
    <button data-rr="d7" class="${ui.resRange === 'd7' ? 'on' : ''}">7 días</button>
    <button data-rr="d30" class="${ui.resRange === 'd30' ? 'on' : ''}">30 días</button>
    <button data-rr="all" class="${ui.resRange === 'all' ? 'on' : ''}">Todo</button>
  </div></div>
  <div class="tiles" style="margin-top:0">
    <div class="tile"><div class="overline">Efectividad</div><div class="val">${pct(r?.pct)}</div><div class="hint">${r ? `${r.hit} ✓ · ${r.miss} ✗` : ''}</div></div>
    <div class="tile"><div class="overline">Unidades</div><div class="val ${r?.units > 0 ? 'pos' : r?.units < 0 ? 'neg' : ''}">${r ? (r.units > 0 ? '+' : '') + String(r.units).replace('.', ',') : '—'}</div><div class="hint">stake fijo 1u</div></div>
    <div class="tile"><div class="overline">ROI</div><div class="val ${r?.roi > 0 ? 'pos' : r?.roi < 0 ? 'neg' : ''}">${pct(r?.roi)}</div><div class="hint">${r?.staked || 0} con cuota</div></div>
  </div>

  <div class="section-h"><h2>Historial de apuestas</h2><span class="badge">${b?.ledger?.length || 0}</span></div>
  ${
    b?.ledger?.length
      ? `<div class="card scroll-x"><table class="ledger"><thead><tr><th>Partido</th><th>Pick</th><th class="num">Cuota</th><th class="num">Apuesta</th><th class="num">Resultado</th><th class="num">Banca</th></tr></thead><tbody>
      ${b.ledger
        .map((x) => {
          const fav = x.fav === x.a.id ? x.a : x.b;
          return `<tr data-open="${x.id}" style="cursor:pointer"><td class="who">${esc(x.a.n)} vs ${esc(x.b.n)}<small>${esc(dayLabel(dayKey(x.at)))} ${fmtTime(x.at)}${x.ph ? ' · ' + esc(x.ph) : ''}</small></td><td>${esc(fav.n)} <span class="conf">${x.c}%</span></td><td class="num">${odds(x.o)}</td><td class="num">${cop(x.stake)}</td><td class="num ${x.profit >= 0 ? 'pos-t' : 'neg-t'}">${x.res === 'hit' ? '✓ ' : '✗ '}${signed(x.profit)}</td><td class="num">${cop(x.bal)}</td></tr>`;
        })
        .join('')}
      </tbody></table></div>`
      : empty('wallet', 'Aún no hay apuestas resueltas', 'Cuando terminen los partidos con pick y cuota, cada apuesta aparece aquí con su ganancia o pérdida.')
  }
  ${footer()}`;
}

function viewPerfil() {
  const u = account;
  return `
  <div class="subhead"><a class="back" href="#/inicio">${icon('left')} Atrás</a><h1>Perfil</h1></div>
  ${
    u
      ? `<a class="usercard" href="#/cuenta"><div class="av">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(u.displayName || u.email))}</div><div style="flex:1;min-width:0"><b>${esc(u.displayName || 'Usuario')}</b><small>${esc(u.email || '')}</small><small>Miembro desde ${esc(new Date(u.metadata?.creationTime || Date.now()).toLocaleDateString('es-CO', { month: 'short', year: 'numeric' }))}</small></div>${icon('chev')}</a>`
      : FB.enabled
      ? `<div class="usercard"><div class="av">${icon('user')}</div><div style="flex:1"><b>Invitado</b><small>Inicia sesión para guardar tus picks seguidos</small></div></div>
         <a class="btn primary" style="margin-top:10px" href="#/login">Iniciar sesión o crear cuenta</a>`
      : `<div class="usercard"><div class="av">${icon('user')}</div><div style="flex:1"><b>Invitado</b><small>Las cuentas se activan muy pronto</small></div></div>`
  }
  <div class="overline" style="margin:22px 4px 8px">Ajustes</div>
  <div class="list">
    <a class="row" href="#/tema"><span class="ic">${icon('moon')}</span><span class="tx"><b>Tema</b><small>${esc({ dark: 'Oscuro', light: 'Claro', system: 'Sistema' }[readLocal('cr_theme_raw', 'dark')] || 'Oscuro')}</small></span><span class="chev">${icon('chev')}</span></a>
    ${TELEGRAM_URL ? `<a class="row" href="${esc(TELEGRAM_URL)}" target="_blank" rel="noopener"><span class="ic">${icon('telegram')}</span><span class="tx"><b>Canal de Telegram</b><small>Recibe los picks al instante</small></span><span class="chev">${icon('chev')}</span></a>` : ''}
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
  <div style="display:grid;place-items:center;margin:10px 0 18px"><div class="usercard" style="background:none;border:0;padding:0"><div class="av" style="width:84px;height:84px;font-size:32px">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(u.displayName || u.email))}</div></div></div>
  <div class="list">
    <div class="row"><span class="ic">${icon('user')}</span><span class="tx"><small>Nombre</small><b>${esc(u.displayName || '—')}</b></span></div>
    <div class="row"><span class="ic">${icon('mail')}</span><span class="tx"><small>Correo</small><b>${esc(u.email || '—')}</b></span></div>
    <div class="row"><span class="ic">${icon('calendar')}</span><span class="tx"><small>Miembro desde</small><b>${esc(new Date(u.metadata?.creationTime || Date.now()).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }))}</b></span></div>
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

const FAQ = [
  ['Predicciones', [
    ['¿Cómo se generan las predicciones?', 'Cada ~10 minutos un proceso automático lee los torneos de la Liga Pro Checa, calcula para cada partido el rating de los jugadores, su racha, el historial entre ellos (H2H y patrones de alternancia), la forma del día y la cuota real de Rushbet, y con eso estima quién es el favorito. Cuando hay suficientes resultados, un modelo de machine learning reentrena solo y toma la decisión.'],
    ['¿Qué significa el % de confianza?', 'Es la probabilidad que el sistema le da al favorito de ganar, en una escala honesta de 50% (partido parejo) a 80% (el máximo: en el tenis de mesa nada es seguro y no vamos a prometer más). Solo publicamos picks desde 55%. Referencia: 55-61% confianza media, 62-67% buena, 68-80% alta. Aun con 75%, 1 de cada 4 picks se pierde: por eso mostramos todos los resultados.'],
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

function openMatch(id) {
  const m = allById().get(Number(id));
  if (!m) return;
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
      ? `<div class="mid"><span class="badge">${esc(m.ph || 'Terminado')}</span><span class="score">${m.sa}-${m.sb}</span></div>`
      : lv
      ? `<div class="mid"><span class="badge live">EN VIVO</span><span class="score">${lv.setsHome}-${lv.setsAway}</span><span class="tn">${esc(lv.ptsHome)} : ${esc(lv.ptsAway)}</span></div>`
      : `<div class="mid"><span class="badge red">● ${fmtTime(m.at)}</span><div class="vs">VS</div></div>`;
    $sheetBody.innerHTML = `
    <div class="sheet-hero">
      <div class="side ${favA ? 'fav' : ''}">${avatar(m.a, 'avatar lg')}<span class="nm" style="font-size:15px">${esc(m.a.n)}</span><span class="sub">Rating ${m.a.r ?? '—'}</span></div>
      ${center}
      <div class="side ${pick && !favA ? 'fav' : ''}">${avatar(m.b, 'avatar lg')}<span class="nm" style="font-size:15px">${esc(m.b.n)}</span><span class="sub">Rating ${m.b.r ?? '—'}</span></div>
    </div>
    <div class="kv">
      <div><small>${m.ph ? esc(m.ph) : 'Torneo'}</small><b style="font-size:13px">${esc((m.tn || '').replace(/^Tournament\s*/i, ''))}</b></div>
      <div><small>Cuota</small><b>${odds(pick?.o)}</b></div>
      <div><small>Estado</small><b class="red" style="font-size:14px">${m.st === 'f' ? 'FINAL' : lv ? 'EN VIVO' : 'PROGRAMADO'}</b></div>
    </div>
    ${
      lv
        ? `<div class="block"><div class="block-h"><span class="overline">Marcador en vivo</span><span class="badge live">cada 2 s</span></div>${liveCard(lv, null)}</div>`
        : ''
    }
    <div class="block">
      <div class="block-h"><span class="overline">Forma reciente</span><div class="seg">${['L5', 'L10', 'H2H'].map((t) => `<button data-ft="${t}" class="${tab === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      ${
        tab === 'H2H'
          ? h2hTotal
            ? `<div class="formrow"><span class="who">${esc(m.a.n)}</span>${formDots((m.h2h || '').split('').map((c) => (c === 'A' ? 'W' : 'L')).join(''), 10, 'form lg')}<span class="rec">${h2hWinsA}-${h2hTotal - h2hWinsA}</span></div><p class="note" style="margin-top:8px">${esc(m.a.n)} ganó ${h2hWinsA} de los últimos ${h2hTotal} cruces contra ${esc(m.b.n)} (más reciente a la izquierda).</p>`
            : '<p class="note">Sin enfrentamientos directos registrados.</p>'
          : [m.a, m.b]
              .map((p, i) => {
                const f = (i ? m.fb : m.fa) || '';
                const w = f.slice(0, n).split('').filter((c) => c === 'W').length;
                return `<div class="formrow"><span class="who">${esc(p.n)}</span>${formDots(f, n, 'form lg')}<span class="rec">${w}W-${f.slice(0, n).length - w}L</span></div>`;
              })
              .join('')
      }
    </div>
    ${
      pick
        ? `<div class="block">
      <div class="block-h"><span class="overline">Probabilidad de victoria</span><span style="font-size:11px;color:var(--muted)">según el modelo</span></div>
      <div class="prob"><b>${cA}%</b><div class="meter"><span style="width:${cA}%"></span><span class="other" style="width:${100 - cA}%"></span></div><b>${100 - cA}%</b></div>
      <div class="prob-x"><span>${esc(m.a.n)}</span><span>${esc(m.b.n)}</span></div>
    </div>
    <div class="block">
      <div class="analysis">
        <div class="an-head">${icon('bolt')}<div><b>Análisis IA</b><small>Por qué el sistema elige a ${esc(fav.n)}</small></div><span class="conf" style="font-size:20px">${pick.c}%</span></div>
        ${
          pick.why
            ? `${pick.why.pro.length ? `<ul class="why pro">${pick.why.pro.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
               ${pick.why.con.length ? `<div class="overline" style="margin:12px 0 6px">A tener en cuenta</div><ul class="why con">${pick.why.con.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
               <p class="an-src">${icon('info')} ${esc(pick.why.src)}.</p>`
            : `<p class="an-src">Pick: <b>${esc(fav.n)}</b> gana con ${pick.c}% de confianza${pick.o ? ` (cuota ${odds(pick.o)})` : ''}. Rating ${m.a.r ?? '—'} vs ${m.b.r ?? '—'}${h2hTotal ? `, cruce directo ${h2hWinsA}-${h2hTotal - h2hWinsA}` : ''}.</p>`
        }
        ${pick.res === 'hit' ? '<div class="badge win" style="margin-top:10px">✓ Resultado: acierto</div>' : pick.res === 'miss' ? '<div class="badge loss" style="margin-top:10px">✗ Resultado: fallo</div>' : ''}
      </div>
      ${pick.res === 'pending' ? `<button class="btn ${isFollowed(m.id) ? 'ghost' : 'primary'}" style="margin-top:12px" data-follow-btn="${m.id}">${icon('heart')} ${isFollowed(m.id) ? 'Dejar de seguir' : 'Seguir este pick'}</button>` : ''}
    </div>`
        : '<div class="block"><p class="note">Este partido no tiene pick: el sistema lo ve demasiado parejo (menos de 55% de confianza) y prefiere no recomendarlo.</p></div>'
    }`;
  };
  draw();
  $sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  $sheet._redraw = draw;
  sheetUnsub?.();
  sheetUnsub = onLive(() => {
    if (!$sheet.hidden && liveFor(m)) draw();
  });
}

function openNotifications() {
  const items = [];
  for (const p of data.picks.slice(0, 12)) {
    const fav = p.fav === p.a.id ? p.a : p.b;
    items.push({ at: p.at, ic: 'flame', t: `Pick: ${fav.n} gana`, s: `${p.a.n} vs ${p.b.n} · ${p.c}% · ${fmtTime(p.at)}`, id: p.id });
  }
  for (const p of data.results.slice(0, 12)) {
    const fav = p.fav === p.a.id ? p.a : p.b;
    items.push({ at: p.at, ic: p.res === 'hit' ? 'trophy' : 'x', t: `${p.res === 'hit' ? '✅ Acierto' : '❌ Fallo'}: ${fav.n}`, s: `${p.a.n} ${p.sa}-${p.sb} ${p.b.n}`, id: p.id });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  $sheetBody.innerHTML = `
    <h2 style="margin:6px 0 4px;font-size:20px">Notificaciones</h2>
    <p style="color:var(--muted);font-size:13px;margin:0 0 14px">Picks nuevos y resultados recientes</p>
    ${TELEGRAM_URL ? `<a class="btn primary" style="margin-bottom:12px" href="${esc(TELEGRAM_URL)}" target="_blank" rel="noopener">${icon('telegram')} Recibir avisos por Telegram</a>` : ''}
    <div class="list">${items.length ? items.slice(0, 20).map((i) => `<button class="row" data-open="${i.id}"><span class="ic">${icon(i.ic)}</span><span class="tx"><b>${esc(i.t)}</b><small>${esc(i.s)}</small></span></button>`).join('') : '<div class="row"><span class="tx"><small>Sin novedades por ahora.</small></span></div>'}</div>`;
  $sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  writeLocal('cr_notif_seen', Date.now());
  document.querySelector('#btn-notif .dot').hidden = true;
}

function closeSheet() {
  $sheet.hidden = true;
  document.body.style.overflow = '';
  sheetUnsub?.();
  sheetUnsub = null;
}

// ---------------- enrutador ----------------

const ROUTES = {
  inicio: viewInicio,
  calendario: viewCalendario,
  picks: viewPicks,
  seguidos: viewSeguidos,
  bankroll: viewBankroll,
  resultados: viewBankroll,
  perfil: viewPerfil,
  cuenta: viewCuenta,
  tema: viewTema,
  ayuda: viewAyuda,
  privacidad: () => viewLegal('privacidad'),
  terminos: () => viewLegal('terminos'),
  login: () => viewLogin('login'),
  registro: () => viewLogin('registro')
};

function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'inicio').toLowerCase();
  const fn = ROUTES[name] || viewInicio;
  $view.innerHTML = fn();
  const tab = name === 'resultados' ? 'bankroll' : name;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  liveUnsub?.();
  liveUnsub = null;
  if (name === 'inicio' || !ROUTES[name]) liveUnsub = onLive(renderLiveHome);
  else if (['calendario', 'picks'].includes(name)) liveUnsub = onLive(() => refreshLiveMids());
  else if (name === 'seguidos') {
    // Redibuja solo si hay algún seguido en vivo (marcador y barra de sets).
    liveUnsub = onLive(() => {
      const map = allById();
      if (![...follows].some((id) => map.get(id) && liveFor(map.get(id)))) return;
      if ($sheet.hidden) $view.innerHTML = viewSeguidos();
    });
  }
  renderCounter();
}

// Actualiza solo los marcadores en vivo de las tarjetas visibles.
function refreshLiveMids() {
  const map = allById();
  document.querySelectorAll('[data-match]').forEach((card) => {
    const m = map.get(Number(card.dataset.match));
    if (!m || m.st === 'f') return;
    const mid = card.querySelector('.mid');
    const html = midBlock(m);
    if (mid && mid.outerHTML !== html) {
      mid.outerHTML = html;
      card.querySelector('.mid')?.classList.add('flash');
    }
  });
}

async function renderCounter() {
  const el = document.getElementById('foot-counter');
  if (!el || !FB.enabled) return;
  try {
    const c = await FB.getCounters();
    if (c) el.innerHTML = `${icon('eye', 'icon').replace('class="icon"', 'class="icon" style="display:inline;width:13px;height:13px;vertical-align:-2px"')} ${fmtInt(c.today)} visitas hoy · ${fmtInt(c.total)} en total · ${fmtInt(c.users)} usuarios`;
  } catch {}
}

// ---------------- eventos ----------------

document.addEventListener('click', async (ev) => {
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
  if (t.dataset.open) return openMatch(t.dataset.open);
  if (t.dataset.day) {
    ui.day += Number(t.dataset.day);
    return route();
  }
  if (t.dataset.frange) {
    const i = FOLLOW_RANGES.findIndex((r) => r[0] === ui.followRange);
    ui.followRange = FOLLOW_RANGES[(i + 1) % FOLLOW_RANGES.length][0];
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
  if (t.dataset.themeSet) {
    setTheme(t.dataset.themeSet);
    return route();
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
  if (ev.key === 'Escape' && !$sheet.hidden) closeSheet();
});

// Banca personal: guarda y recalcula solo la lista (sin perder el foco).
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'bank-input') return;
  const digits = ev.target.value.replace(/\D/g, '').slice(0, 13);
  writeLocal('cr_bank', Number(digits) || 0);
  const box = document.getElementById('my-stakes');
  if (box) box.innerHTML = myStakesHtml();
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
route();
await loadData();
route();

// Punto rojo en la campana si hay picks nuevos desde la última vez.
const seen = readLocal('cr_notif_seen', 0);
if (data.picks.some((p) => new Date(p.at).getTime() > seen - 6 * 3600e3) && Date.now() - seen > 30 * 60e3) {
  document.querySelector('#btn-notif .dot').hidden = false;
}

// Datos nuevos cada minuto (el sync corre cada ~10 min).
setInterval(async () => {
  if (document.visibilityState === 'hidden' || !$sheet.hidden) return;
  await loadData();
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}, 60000);

FB.onAuth(async (u) => {
  account = u;
  if (u) {
    const remote = await FB.loadFollows().catch(() => null);
    if (remote) {
      follows = new Set([...remote, ...follows]);
      writeLocal('cr_follows', [...follows]);
      FB.saveFollows([...follows]).catch(() => {});
    }
  }
  if ($sheet.hidden) route();
});
FB.countVisit().catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
