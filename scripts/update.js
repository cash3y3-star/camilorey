// ============================================================
// CamiloRey — actualización de partidos, picks y resultados
//
// Corre en GitHub Actions cada ~10 min (.github/workflows/update.yml).
// No usa ninguna base de datos de pago: el estado vive en archivos JSON
// dentro de data/ (rama "state" del repo, sobrescrita en cada corrida
// para que el repo no crezca) y lo que ve la página se escribe en
// site/data/ (publicado en GitHub Pages).
//
// Fuentes (las mismas del sitio anterior, camilorey-app):
//   - tt.league-pro.com: torneos, jugadores, partidos, resultados
//   - Rushbet/Kambi: cuotas prepartido (señal del modelo)
//
// Uso:
//   node scripts/update.js              corrida normal
//   node scripts/update.js --backfill 45  carga historial de 45 días (sin picks)
// ============================================================

const fs = require('fs');
const path = require('path');
const { fetchNuxtData } = require('./lib/tt');
const BACKFILL_PAUSE_MS = 1200;
const { fetchLigaProChecaOdds, findOdds } = require('./lib/rushbet');
const { computeConfidence } = require('./lib/confidence');
const { computeStake } = require('./lib/staking');
const BANK_START = 2000000; // banca inicial en COP, misma convención del sitio anterior
const { trainLogisticRegression, predictProbability, MIN_TRAINING_SAMPLES } = require('./lib/ml-model');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'site', 'data');
const MEDIA_BASE = 'https://api.league-pro.com';
const TZ = 'America/Bogota';

const MIN_CONFIDENCE_TO_PUBLISH = 55; // escala 50-80%: por debajo de 55 es casi una moneda
const MAX_CONFIDENCE = 80;
const FEATURED_MIN_ODDS = 1.6;
const HISTORY_DAYS = 120; // partidos terminados sin pick más viejos que esto se descartan

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- estado en disco ----------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Claves ordenadas: mismo contenido => mismo archivo byte a byte.
function writeJson(file, value, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, pretty ? 1 : 0));
}

const state = {
  players: readJson(path.join(STATE_DIR, 'players.json'), {}),
  tournaments: readJson(path.join(STATE_DIR, 'tournaments.json'), {}),
  matches: readJson(path.join(STATE_DIR, 'matches.json'), {}),
  picks: readJson(path.join(STATE_DIR, 'picks.json'), {})
};

function saveState() {
  for (const key of Object.keys(state)) writeJson(path.join(STATE_DIR, `${key}.json`), state[key]);
}

// ---------------- utilidades ----------------

function playerName(p) {
  return p.short_name_en || `${p.first_name_en || ''} ${p.surname_en || ''}`.trim();
}

function bogotaDay(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
}

function isTournamentFinished(sides) {
  const real = sides.filter((s) => !s.is_tba);
  return real.length > 0 && real.every((s) => s.place != null);
}

// Partidos terminados de un jugador, más nuevo primero.
function finishedMatchesOf(playerId) {
  return Object.values(state.matches)
    .filter((m) => m.st === 'f' && (m.a === playerId || m.b === playerId))
    .sort((x, y) => (x.at < y.at ? 1 : -1));
}

function recentStreak(playerId) {
  let streak = 0;
  for (const m of finishedMatchesOf(playerId).slice(0, 5)) {
    const won = m.w === playerId;
    if (streak === 0) streak = won ? 1 : -1;
    else if (streak > 0 === won) streak += won ? 1 : -1;
    else break;
  }
  return streak;
}

// Mismo análisis de rachas dentro del cruce directo que el sitio anterior
// (ver lib/confidence.js: alternancia / racha típica de la pareja).
function headToHead(aId, bId) {
  const data = Object.values(state.matches)
    .filter((m) => m.st === 'f' && ((m.a === aId && m.b === bId) || (m.a === bId && m.b === aId)))
    .sort((x, y) => (x.at < y.at ? 1 : -1))
    .slice(0, 10);
  if (data.length === 0) {
    return { h2hWinsA: 0, h2hTotal: 0, currentStreakPlayerId: null, currentStreakLength: 0, typicalRunLength: null, isPerfectAlternation: false };
  }
  const runs = [];
  for (const m of [...data].reverse()) {
    const last = runs[runs.length - 1];
    if (last && last.winnerId === m.w) last.length++;
    else runs.push({ winnerId: m.w, length: 1 });
  }
  const completed = runs.slice(0, -1);
  const current = runs[runs.length - 1];
  return {
    h2hWinsA: data.filter((m) => m.w === aId).length,
    h2hTotal: data.length,
    currentStreakPlayerId: current.winnerId,
    currentStreakLength: current.length,
    typicalRunLength: completed.length ? completed.reduce((s, r) => s + r.length, 0) / completed.length : null,
    isPerfectAlternation: completed.length >= 3 && runs.every((r) => r.length === 1)
  };
}

function tournamentForm(playerId, tournamentId, beforeIso) {
  const played = Object.values(state.matches).filter(
    (m) => m.t === tournamentId && m.st === 'f' && m.at < beforeIso && (m.a === playerId || m.b === playerId)
  );
  const wins = played.filter((m) => m.w === playerId).length;
  return { wins, losses: played.length - wins };
}

// ---------------- modelo ----------------

// Reentrena con todos los picks resueltos (label = ganó el jugador A).
function trainModel() {
  const rows = Object.values(state.picks)
    .filter((p) => (p.res === 'hit' || p.res === 'miss') && p.f)
    .map((p) => {
      const m = state.matches[p.id];
      if (!m || m.w == null) return null;
      return { ...p.f, hit: m.w === m.a };
    })
    .filter(Boolean);
  return { weights: rows.length ? trainLogisticRegression(rows) : null, trainingCount: rows.length };
}

function generatePick(match, sideA, sideB, odds, model) {
  const h2h = headToHead(match.a, match.b);
  const formA = tournamentForm(match.a, match.t, match.at);
  const formB = tournamentForm(match.b, match.t, match.at);
  const oddsImpliedProbA = odds ? 1 / odds.oddsA / (1 / odds.oddsA + 1 / odds.oddsB) : null;
  const streakA = recentStreak(match.a);
  const streakB = recentStreak(match.b);

  const { confidence: raw, factors } = computeConfidence({
    ratingDiff: (sideA.rating_before_tournament || 0) - (sideB.rating_before_tournament || 0),
    streakA,
    streakB,
    h2hWinsA: h2h.h2hWinsA,
    h2hTotal: h2h.h2hTotal,
    h2hCurrentStreakIsA: h2h.currentStreakPlayerId === match.a ? true : h2h.currentStreakPlayerId === match.b ? false : null,
    h2hCurrentStreakLength: h2h.currentStreakLength,
    h2hTypicalRunLength: h2h.typicalRunLength,
    h2hIsPerfectAlternation: h2h.isPerfectAlternation,
    oddsImpliedProbA,
    todayFormWinsA: formA.wins,
    todayFormLossesA: formA.losses,
    todayFormWinsB: formB.wins,
    todayFormLossesB: formB.losses
  });
  delete factors.weights;

  // Confianza HONESTA, escala 50-80%: 50% = partido parejo, 80% = tope (en
  // esta liga ningún pick justifica más). La escala vieja del sitio
  // anterior daba al favorito siempre 70-92%, aunque el partido fuera parejo.
  // Con muestra suficiente decide el modelo entrenado y se muestra su
  // probabilidad real (con tope); si no, la fórmula, reescalada a 50-80.
  const useModel = model.weights && model.trainingCount >= MIN_TRAINING_SAMPLES;
  let favA, pFav;
  if (useModel) {
    const pA = predictProbability(model.weights, factors);
    favA = pA >= 0.5;
    pFav = favA ? pA : 1 - pA;
  } else {
    // computeConfidence devuelve 70 + raw*20 (raw de -1 a 1 aprox., a favor de A).
    const rawScore = Math.max(-1, Math.min(1, (raw - 70) / 20));
    favA = rawScore >= 0;
    pFav = 0.5 + Math.abs(rawScore) * 0.3;
  }
  const confidence = Math.round(Math.max(0.5, Math.min(MAX_CONFIDENCE / 100, pFav)) * 100);

  return {
    id: match.id,
    fav: favA ? match.a : match.b,
    c: confidence,
    o: odds ? (favA ? odds.oddsA : odds.oddsB) : null,
    f: factors,
    // Datos crudos con los que se decidió — base del "Análisis IA".
    x: {
      rA: sideA.rating_before_tournament ?? null,
      rB: sideB.rating_before_tournament ?? null,
      sA: streakA,
      sB: streakB,
      hA: h2h.h2hWinsA,
      hT: h2h.h2hTotal,
      hCur: h2h.currentStreakPlayerId === match.a ? 'a' : h2h.currentStreakPlayerId === match.b ? 'b' : null,
      hLen: h2h.currentStreakLength,
      hTyp: h2h.typicalRunLength != null ? Math.round(h2h.typicalRunLength * 10) / 10 : null,
      hAlt: h2h.isPerfectAlternation,
      fA: [formA.wins, formA.losses],
      fB: [formB.wins, formB.losses],
      pA: oddsImpliedProbA != null ? Math.round(oddsImpliedProbA * 1000) / 1000 : null,
      n: model.trainingCount
    },
    pub: confidence >= MIN_CONFIDENCE_TO_PUBLISH,
    src: useModel ? 'ml' : 'formula',
    res: 'pending',
    created: new Date().toISOString()
  };
}

function resolvePick(match) {
  const pick = state.picks[match.id];
  if (!pick || pick.res !== 'pending' || match.w == null) return null;
  pick.res = pick.fav === match.w ? 'hit' : 'miss';
  pick.resolved = new Date().toISOString();
  return pick.res;
}

// ---------------- lectura de tt.league-pro.com ----------------

// Reintenta si el sitio limita las consultas (espera 20 s, 60 s, 3 min).
async function fetchTT(pathname) {
  const waits = [20e3, 60e3, 180e3];
  for (let i = 0; ; i++) {
    try {
      return await fetchNuxtData(pathname);
    } catch (e) {
      if (!e.rateLimited || i >= waits.length) throw e;
      console.log(`  límite de consultas, esperando ${waits[i] / 1000}s...`);
      await sleep(waits[i]);
    }
  }
}

async function listTournaments(dateFrom, dateTo) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const data = await fetchTT(`/en/tournaments?date_from=${dateFrom}&date_to=${dateTo}&page=${page}`);
    if (!data['tournaments-page-data']) throw new Error(`Listado de torneos sin datos (${dateFrom}..${dateTo} pág. ${page})`);
    const list = data['tournaments-page-data']?.tournaments;
    const items = list?.items || [];
    out.push(...items.map((t) => ({ id: t.id, start: t.start_at })));
    const { total_items, limit, offset } = list?.pagination || {};
    if (!items.length || offset == null || offset + limit >= total_items) break;
    await sleep(250);
  }
  return out;
}

async function processTournament(id, { makePicks, rushbet, model, totals }) {
  const detail = await fetchTT(`/en/tournaments/${id}`);
  const pageData = detail['tournament-page']?.pageData;
  if (!pageData) return;
  const sides = pageData.widgets.sides || [];
  const finished = isTournamentFinished(sides);

  for (const s of sides) {
    if (!s.player?.id) continue;
    state.players[s.player.id] = {
      n: playerName(s.player),
      av: s.player.avatar ? `${MEDIA_BASE}${s.player.avatar}` : null,
      r: s.rating_after_tournament ?? s.rating_before_tournament ?? state.players[s.player.id]?.r ?? null
    };
  }
  const winnerSide = finished ? sides.find((s) => s.place === 1) : null;
  state.tournaments[id] = {
    n: pageData.tournament.name_en,
    at: pageData.tournament.start_date,
    st: finished ? 'f' : 's',
    w: winnerSide?.player?.id || null
  };

  const sidesById = new Map(sides.map((s) => [s.id, s]));
  for (const m of pageData.widgets.matches || []) {
    if (m.side_one_id === m.side_two_id) continue; // fase eliminatoria sin definir
    const sideA = sidesById.get(m.side_one_id);
    const sideB = sidesById.get(m.side_two_id);
    if (!sideA?.player || !sideB?.player) continue;

    // status: 1 sin empezar, 2 en curso, 3 terminado
    const played = m.status === 3;
    const row = {
      id: m.id,
      t: id,
      a: sideA.player.id,
      b: sideB.player.id,
      at: m.start_game,
      sg: m.stage_id ?? null, // fase: grupos vs. definición (3er puesto / final)
      st: played ? 'f' : m.status === 2 ? 'l' : 's',
      sa: played ? m.results.score_one : null,
      sb: played ? m.results.score_two : null,
      w: played ? (m.results.score_one > m.results.score_two ? sideA.player.id : sideB.player.id) : null
    };
    state.matches[m.id] = row;
    totals.matches++;

    if (played) {
      if (resolvePick(row)) totals.resolved++;
      continue;
    }
    if (!makePicks || state.picks[m.id] || row.st !== 's') continue;

    try {
      const odds = findOdds(rushbet, state.players[row.a].n, state.players[row.b].n, row.at);
      const pick = generatePick(row, sideA, sideB, odds, model);
      state.picks[m.id] = pick;
      if (pick.pub) totals.newPicks++;
    } catch (e) {
      console.error(`Pick de ${m.id} falló: ${e.message}`);
    }
  }
}

// El cruce con Rushbet es "una oportunidad" al generar el pick: si la
// cuota aparece después, se completa acá (solo picks pendientes).
function backfillOdds(rushbet) {
  let n = 0;
  for (const p of Object.values(state.picks)) {
    if (p.res !== 'pending' || p.o) continue;
    const m = state.matches[p.id];
    if (!m) continue;
    const odds = findOdds(rushbet, state.players[m.a]?.n, state.players[m.b]?.n, m.at);
    if (!odds) continue;
    p.o = p.fav === m.a ? odds.oddsA : odds.oddsB;
    n++;
  }
  return n;
}

function prune() {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400e3).toISOString();
  for (const [id, m] of Object.entries(state.matches)) {
    if (m.at < cutoff && !state.picks[id]) delete state.matches[id];
  }
  const usedT = new Set(Object.values(state.matches).map((m) => m.t));
  for (const id of Object.keys(state.tournaments)) if (!usedT.has(Number(id))) delete state.tournaments[id];
  const usedP = new Set(Object.values(state.matches).flatMap((m) => [m.a, m.b]));
  for (const id of Object.keys(state.players)) if (!usedP.has(Number(id))) delete state.players[id];
}

// ---------------- salida para la página ----------------

// Recortes de fondo (scripts/cutouts.js → site/cutouts/{id}.webp).
const CUTOUT_DIR = path.join(ROOT, 'site', 'cutouts');
const cutouts = new Set(
  (fs.existsSync(CUTOUT_DIR) ? fs.readdirSync(CUTOUT_DIR) : []).filter((f) => f.endsWith('.webp')).map((f) => Number(f.slice(0, -5)))
);

function playerRef(id) {
  const p = state.players[id] || {};
  return { id, n: p.n || '?', av: p.av || null, r: p.r ?? null, cut: cutouts.has(Number(id)) ? `cutouts/${id}.webp` : null };
}

// Fase del partido: los que no son de la fase de grupos (la fase con más
// partidos del torneo) son la definición — el último es la final y el
// anterior el 3er puesto. Se calcula por torneo y se guarda en caché.
const phaseCache = new Map();
function phaseOf(m) {
  if (m.sg == null) return null;
  if (!phaseCache.has(m.t)) {
    const list = Object.values(state.matches).filter((x) => x.t === m.t && x.sg != null);
    const count = new Map();
    for (const x of list) count.set(x.sg, (count.get(x.sg) || 0) + 1);
    const group = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const playoff = list.filter((x) => x.sg !== group).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
    const labels = new Map();
    if (playoff.length === 1) labels.set(playoff[0].id, 'Final');
    else if (playoff.length === 2) {
      labels.set(playoff[0].id, '3er puesto');
      labels.set(playoff[1].id, 'Final');
    } else playoff.forEach((x) => labels.set(x.id, 'Eliminatoria'));
    phaseCache.set(m.t, labels);
  }
  return phaseCache.get(m.t).get(m.id) || null;
}

function matchView(m) {
  return {
    id: m.id,
    at: m.at,
    t: m.t,
    ph: phaseOf(m),
    tn: state.tournaments[m.t]?.n || 'Torneo',
    a: playerRef(m.a),
    b: playerRef(m.b),
    st: m.st,
    sa: m.sa,
    sb: m.sb,
    w: m.w
  };
}

// Últimos 10 resultados del jugador ANTES de este partido ('W'/'L', más
// nuevo primero) y el cruce directo — para la ficha del partido.
function formBefore(playerId, beforeIso) {
  return finishedMatchesOf(playerId)
    .filter((m) => m.at < beforeIso)
    .slice(0, 10)
    .map((m) => (m.w === playerId ? 'W' : 'L'))
    .join('');
}

function detailView(m) {
  const h2h = Object.values(state.matches)
    .filter((x) => x.st === 'f' && x.at < m.at && ((x.a === m.a && x.b === m.b) || (x.a === m.b && x.b === m.a)))
    .sort((x, y) => (x.at < y.at ? 1 : -1))
    .slice(0, 10);
  return {
    ...matchView(m),
    fa: formBefore(m.a, m.at),
    fb: formBefore(m.b, m.at),
    h2h: h2h.map((x) => (x.w === m.a ? 'A' : 'B')).join(''),
    // Lista de enfrentamientos (estilo Sofascore): fecha, torneo y sets
    // desde el punto de vista del jugador A de ESTE partido.
    h2hL: h2h.map((x) => ({
      at: x.at,
      tn: (state.tournaments[x.t]?.n || '').replace(/^Tournament\s*/i, ''),
      ph: phaseOf(x),
      sa: x.a === m.a ? x.sa : x.sb,
      sb: x.a === m.a ? x.sb : x.sa
    }))
  };
}

// "Análisis IA": argumentos reales a favor y en contra del favorito, a
// partir de los mismos datos con los que el modelo decidió (pick.x). Cada
// argumento lleva un peso aproximado (score del factor × su peso en
// lib/confidence.js) para ordenarlos de más a menos influyente.
function buildWhy(p, m) {
  const x = p.x;
  if (!x) return null;
  const favA = p.fav === m.a;
  const fav = state.players[p.fav]?.n || 'El favorito';
  const riv = state.players[favA ? m.b : m.a]?.n || 'su rival';
  const pro = [];
  const con = [];
  const add = (weight, text) => (weight >= 0 ? pro : con).push({ w: Math.abs(weight), t: text });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Rating (factor principal del modelo).
  const rF = favA ? x.rA : x.rB;
  const rR = favA ? x.rB : x.rA;
  if (rF != null && rR != null && rF !== rR) {
    const d = Math.round(rF - rR);
    const w = 0.55 * Math.min(1, Math.abs(d) / 200) * Math.sign(d);
    if (d > 0) add(w, `Tiene mejor rating: ${Math.round(rF)} contra ${Math.round(rR)} (+${d} puntos). Es el indicador que más pesa en el modelo: resume su nivel en los últimos torneos de la liga.`);
    else add(w, `${riv} tiene mejor rating (${Math.round(rR)} contra ${Math.round(rF)}, ${Math.abs(d)} puntos más), así que en el papel el rival es más fuerte.`);
  }

  // Mercado (cuota real de Rushbet sin margen).
  if (x.pA != null) {
    const pf = favA ? x.pA : 1 - x.pA;
    const pctF = Math.round(pf * 100);
    const w = 0.35 * (pf * 2 - 1);
    if (pf >= 0.5) add(w, `El mercado coincide: según la cuota de Rushbet tiene un ${pctF}% de probabilidad de ganar (calculado sin el margen de la casa).`);
    else add(w, `El mercado ve favorito a ${riv} (${100 - pctF}%). Por eso la cuota es alta: el modelo ve más chances de las que paga la casa, pero es un pick más arriesgado.`);
  }

  // Cruce directo.
  if (x.hT >= 2) {
    const wF = favA ? x.hA : x.hT - x.hA;
    const share = wF / x.hT;
    const w = 0.1 * (share * 2 - 1);
    if (share > 0.5) add(w, `Domina el cruce directo: ganó ${wF} de los últimos ${plural(x.hT, 'enfrentamiento', 'enfrentamientos')} contra ${riv}.`);
    else if (share < 0.5) add(w, `En el cruce directo ${riv} ganó ${x.hT - wF} de ${x.hT}.`);
  }

  // Patrón de rachas dentro del cruce (alternancia).
  if (x.hCur && x.hTyp) {
    const curIsFav = (x.hCur === 'a') === favA;
    const due = x.hLen >= x.hTyp;
    const towardFav = curIsFav ? !due : due;
    const holder = curIsFav ? fav : riv;
    const w = (x.hAlt ? 0.3 : 0.15) * Math.min(1, x.hLen / x.hTyp) * (towardFav ? 1 : -1);
    const pattern = x.hAlt
      ? 'en esta pareja el ganador se alterna partido a partido'
      : `en esta pareja las rachas suelen durar ${String(x.hTyp).replace('.', ',')} ${x.hTyp === 1 ? 'partido' : 'partidos'} antes de cortarse`;
    add(w, `Patrón del cruce: ${pattern}, y ${holder} lleva ${plural(x.hLen, 'victoria seguida', 'victorias seguidas')}. ${towardFav ? `Eso favorece a ${fav}.` : `Eso favorece a ${riv}.`}`);
  }

  // Forma del día en este mismo torneo.
  const fF = favA ? x.fA : x.fB;
  const fR = favA ? x.fB : x.fA;
  if (fF && fR && fF[0] + fF[1] + fR[0] + fR[1] > 0) {
    const net = fF[0] - fF[1] - (fR[0] - fR[1]);
    const w = 0.08 * Math.max(-1, Math.min(1, net / 4));
    if (net !== 0) add(w, `Forma hoy en este torneo: ${fav} va ${fF[0]}-${fF[1]} y ${riv} va ${fR[0]}-${fR[1]}.`);
  }

  // Racha reciente (peso bajo: medido con poca señal en esta liga).
  const sF = favA ? x.sA : x.sB;
  const sR = favA ? x.sB : x.sA;
  if (sF >= 3) add(0.02, `Viene de ${sF} victorias seguidas.`);
  if (sR >= 3) add(-0.02, `${riv} viene de ${sR} victorias seguidas.`);
  if (sF <= -3) add(-0.02, `Viene de ${-sF} derrotas seguidas.`);

  const order = (a, b) => b.w - a.w;
  return {
    pro: pro.sort(order).map((r) => r.t),
    con: con.sort(order).map((r) => r.t),
    src: p.src === 'ml' ? `Modelo de machine learning entrenado con ${x.n} picks resueltos` : 'Fórmula ponderada (el modelo ML se activa con 40 picks resueltos)'
  };
}

function pickView(p, detailed = false) {
  const m = state.matches[p.id];
  return { ...(detailed ? detailView(m) : matchView(m)), fav: p.fav, c: p.c, o: p.o, res: p.res, ft: Boolean(p.ft), why: buildWhy(p, m) };
}

function summarize(list) {
  const hit = list.filter((p) => p.res === 'hit').length;
  const miss = list.filter((p) => p.res === 'miss').length;
  const withOdds = list.filter((p) => p.o);
  // Rendimiento con apuesta fija de 1 unidad, solo picks con cuota real.
  const units = withOdds.reduce((s, p) => s + (p.res === 'hit' ? p.o - 1 : -1), 0);
  return {
    hit,
    miss,
    pct: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 10 : null,
    units: Math.round(units * 100) / 100,
    staked: withOdds.length,
    roi: withOdds.length ? Math.round((units / withOdds.length) * 1000) / 10 : null
  };
}

function writeSite(meta) {
  const now = Date.now();
  const published = Object.values(state.picks).filter((p) => p.pub && state.matches[p.id]);

  // Pick destacado: entre los pendientes que TODAVÍA NO EMPIEZAN, el de más
  // confianza con cuota > 1.60 (si no hay, el de más confianza). Queda
  // registrado en p.dst y se congela cuando arranca su partido: así
  // "destacado" = el que era destacado al empezar el partido, y sus
  // resultados se miden aparte (estadísticas de Inicio).
  const pending = published.filter((p) => p.res === 'pending');
  const notStarted = pending.filter((p) => state.matches[p.id].st === 's' && new Date(state.matches[p.id].at).getTime() > now);
  const withOdds = notStarted.filter((p) => p.o && p.o > FEATURED_MIN_ODDS);
  const pool = withOdds.length ? withOdds : notStarted;
  const featured = pool.slice().sort((a, b) => b.c - a.c || (state.matches[a.id].at < state.matches[b.id].at ? -1 : 1))[0];
  for (const p of notStarted) p.dst = p === featured;
  for (const p of published) p.ft = p === featured;

  const pendingView = pending
    .map((p) => pickView(p, true))
    .filter((p) => new Date(p.at).getTime() > now - 3 * 3600e3)
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const resolved = published
    .filter((p) => p.res !== 'pending')
    .sort((a, b) => (state.matches[a.id].at < state.matches[b.id].at ? 1 : -1));

  const d = (days) => new Date(now - days * 86400e3).toISOString();
  const today = bogotaDay(new Date().toISOString());
  const inRange = (from) => resolved.filter((p) => state.matches[p.id].at >= from);

  // Serie diaria de los últimos 30 días.
  const byDay = new Map();
  for (const p of inRange(d(30))) {
    const day = bogotaDay(state.matches[p.id].at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const series = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, list]) => ({ d: day, ...summarize(list) }));

  // Racha actual (aciertos o fallos seguidos).
  let streak = 0;
  for (const p of resolved) {
    const s = p.res === 'hit' ? 1 : -1;
    if (streak === 0 || Math.sign(streak) === s) streak += s;
    else break;
  }

  // Calendario: ayer, hoy y mañana (hora de Colombia).
  const days = [-1, 0, 1].map((k) => bogotaDay(new Date(now + k * 86400e3).toISOString()));
  const calendar = Object.values(state.matches)
    .filter((m) => days.includes(bogotaDay(m.at)))
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((m) => {
      const p = state.picks[m.id];
      return { ...detailView(m), pick: p && p.pub ? { fav: p.fav, c: p.c, o: p.o, res: p.res, why: buildWhy(p, m) } : null };
    });

  // Bankroll: banca simulada que apuesta a cada pick publicado CON cuota,
  // en orden cronológico. Apuesta según confianza (lib/staking.js:
  // $100.000-$250.000) y cobra con la cuota real de Rushbet.
  const bets = resolved
    .filter((p) => p.o)
    .slice()
    .reverse(); // resolved viene del más nuevo al más viejo
  let balance = BANK_START;
  let staked = 0;
  let peak = BANK_START;
  let maxDrawdown = 0;
  const ledger = bets.map((p) => {
    const stake = computeStake(p.c);
    const profit = Math.round(p.res === 'hit' ? stake * (p.o - 1) : -stake);
    balance += profit;
    staked += stake;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);
    return { ...pickView(p), stake, profit, bal: balance };
  });
  // Serie diaria (saldo al cierre de cada día).
  const balByDay = new Map();
  for (const b of ledger) balByDay.set(bogotaDay(b.at), b.bal);
  // El bankroll del sistema es SOLO para el admin: no se publica en
  // site/data, va completo a Firestore (ver pushPrivateLedger).
  systemBankroll = {
    start: BANK_START,
    balance,
    profit: balance - BANK_START,
    staked,
    roi: staked ? Math.round(((balance - BANK_START) / staked) * 1000) / 10 : null,
    bets: ledger.length,
    hits: ledger.filter((b) => b.res === 'hit').length,
    maxDrawdown,
    series: [...balByDay.entries()].map(([d, bal]) => ({ d, bal }))
  };
  privateLedger = ledger
    .slice(-1000)
    .reverse()
    .map((b) => ({
      id: b.id,
      at: b.at,
      ph: b.ph,
      a: b.a.n,
      b: b.b.n,
      fav: b.fav === b.a.id ? b.a.n : b.b.n,
      c: b.c,
      o: b.o,
      stake: b.stake,
      profit: b.profit,
      bal: b.bal,
      res: b.res
    }));

  writeJson(path.join(OUT_DIR, 'picks.json'), pendingView);
  writeJson(path.join(OUT_DIR, 'results.json'), resolved.slice(0, 300).map((p) => pickView(p)));
  writeJson(path.join(OUT_DIR, 'calendar.json'), { days, matches: calendar });
  writeJson(path.join(OUT_DIR, 'stats.json'), {
    updatedAt: new Date().toISOString(),
    today: summarize(resolved.filter((p) => bogotaDay(state.matches[p.id].at) === today)),
    d7: summarize(inRange(d(7))),
    d30: summarize(inRange(d(30))),
    all: summarize(resolved),
    streak,
    series,
    pendingCount: pendingView.length,
    model: meta.model,
    featured: featuredStats(resolved, d)
  });
}

// Estadísticas SOLO de los picks destacados (p.dst), para Inicio.
function featuredStats(resolved, d) {
  const list = resolved.filter((p) => p.dst); // más nuevo primero
  let streak = 0;
  for (const p of list) {
    const s = p.res === 'hit' ? 1 : -1;
    if (streak === 0 || Math.sign(streak) === s) streak += s;
    else break;
  }
  const withOdds = list.filter((p) => p.o);
  return {
    d7: summarize(list.filter((p) => state.matches[p.id].at >= d(7))),
    d30: summarize(list.filter((p) => state.matches[p.id].at >= d(30))),
    all: summarize(list),
    streak,
    avgOdds: withOdds.length ? Math.round((withOdds.reduce((s, p) => s + p.o, 0) / withOdds.length) * 100) / 100 : null,
    last: list.slice(0, 10).map((p) => {
      const m = state.matches[p.id];
      return { id: p.id, at: m.at, fav: state.players[p.fav]?.n || '?', c: p.c, o: p.o, res: p.res };
    })
  };
}

// ---------------- historial privado (solo admin) ----------------

// Se escribe en Firestore (admin/ledger) por la API REST. Las reglas de
// Firestore solo aceptan la escritura si trae la clave del bot
// (secret FIRESTORE_BOT_KEY) y solo dejan leerlo a la cuenta admin.
const FIREBASE_PROJECT = 'camilorey-1399c';
const FIREBASE_API_KEY = 'AIzaSyAjEK6Ca7_NEDiPMJv9iqwNLx1DY8WOog0';
let privateLedger = null;
let systemBankroll = null;

async function pushPrivateLedger() {
  const botKey = process.env.FIRESTORE_BOT_KEY;
  if (!botKey || !privateLedger) return;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/admin/ledger?key=${FIREBASE_API_KEY}`;
  const body = {
    fields: {
      botKey: { stringValue: botKey },
      updatedAt: { stringValue: new Date().toISOString() },
      data: { stringValue: JSON.stringify({ summary: systemBankroll, ledger: privateLedger }) }
    }
  };
  try {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`Historial privado: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    else console.log(`Historial privado actualizado (${privateLedger.length} apuestas)`);
  } catch (e) {
    console.error(`Historial privado: ${e.message}`);
  }
}

// ---------------- corrida ----------------

async function backfill(daysBack) {
  const totals = { matches: 0, resolved: 0, newPicks: 0 };
  for (let k = daysBack; k >= 1; k--) {
    const day = new Date(Date.now() - k * 86400e3).toISOString().slice(0, 10);
    const known = Object.values(state.tournaments).filter((t) => t.st === 'f' && (t.at || '').slice(0, 10) === day).length;
    if (known >= 20) {
      console.log(`${day}: ya cargado (${known} torneos)`);
      continue;
    }
    let list;
    try {
      list = await listTournaments(day, day);
    } catch (e) {
      console.error(`${day}: ${e.message}`);
      continue;
    }
    const todo = list.filter((t) => state.tournaments[t.id]?.st !== 'f');
    console.log(`${day}: ${list.length} torneos (${todo.length} nuevos)`);
    for (const t of todo) {
      try {
        await processTournament(t.id, { makePicks: false, rushbet: [], model: null, totals });
      } catch (e) {
        console.error(`Torneo ${t.id}: ${e.message}`);
      }
      await sleep(BACKFILL_PAUSE_MS);
    }
    saveState(); // guarda por día: si se corta, se retoma sin repetir
  }
  // Con historial nuevo cambian racha/H2H/forma: los picks de partidos que
  // todavía no empiezan se borran para que la próxima corrida los
  // recalcule con todo el historial. Nunca se tocan picks ya jugados.
  let reset = 0;
  for (const [id, p] of Object.entries(state.picks)) {
    const m = state.matches[id];
    if (p.res === 'pending' && m && m.st === 's' && new Date(m.at).getTime() > Date.now() + 5 * 60e3) {
      delete state.picks[id];
      reset++;
    }
  }
  saveState();
  if (reset) console.log(`Picks pendientes a recalcular: ${reset}`);
  console.log('Backfill listo:', totals, 'partidos en estado:', Object.keys(state.matches).length);
}

async function run() {
  const totals = { matches: 0, resolved: 0, newPicks: 0 };
  const now = Date.now();

  // Torneos en ventana (desde hace 6 h hasta dentro de 12 h) + los que
  // tenemos con partidos sin terminar (finales que arrancan tarde, etc.).
  const listed = await listTournaments(
    new Date(now - 86400e3).toISOString().slice(0, 10),
    new Date(now + 86400e3).toISOString().slice(0, 10)
  );
  const ids = new Set(
    listed
      .filter((t) => {
        const ms = new Date(t.start).getTime();
        return ms >= now - 6 * 3600e3 && ms <= now + 12 * 3600e3;
      })
      .map((t) => t.id)
  );
  const twoDaysAgo = new Date(now - 2 * 86400e3).toISOString();
  for (const m of Object.values(state.matches)) {
    if (m.st !== 'f' && m.at > twoDaysAgo) ids.add(m.t);
  }
  // Torneos sin campeón todavía: la final y el 3er puesto no existen como
  // partido hasta que termina la fase de grupos, así que el torneo se sigue
  // revisando aunque ya no le quede ningún partido guardado sin terminar.
  for (const [id, t] of Object.entries(state.tournaments)) {
    if (t.st !== 'f' && t.at > twoDaysAgo) ids.add(Number(id));
  }
  console.log(`Torneos a revisar: ${ids.size}`);

  let rushbet = [];
  try {
    rushbet = await fetchLigaProChecaOdds();
    console.log(`Cuotas Rushbet: ${rushbet.length} partidos`);
  } catch (e) {
    console.error(`Sin cuotas de Rushbet: ${e.message}`);
  }

  // Picks pendientes generados antes de guardar los datos del "Análisis IA"
  // (pick.x): si el partido todavía no empieza, se recalculan. Los que ya
  // empezaron se pasan de la escala vieja (70-92%) a la honesta (50-80%).
  for (const [id, p] of Object.entries(state.picks)) {
    const m = state.matches[id];
    if (!p.x && p.res === 'pending' && m && m.st === 's' && new Date(m.at).getTime() > now + 5 * 60e3) delete state.picks[id];
    else if (!p.x && !p.v2) {
      p.c = Math.round(Math.max(50, Math.min(80, 50 + ((p.c - 70) * 30) / 22)));
      p.v2 = true;
    }
  }

  const model = trainModel();
  const modelInfo = {
    active: Boolean(model.weights && model.trainingCount >= MIN_TRAINING_SAMPLES),
    trainingCount: model.trainingCount
  };
  console.log(`Modelo: ${modelInfo.active ? 'ML activo' : 'fórmula'} (${model.trainingCount} picks resueltos)`);

  for (const id of ids) {
    try {
      await processTournament(id, { makePicks: true, rushbet, model, totals });
    } catch (e) {
      console.error(`Torneo ${id}: ${e.message}`);
    }
    await sleep(150);
  }

  totals.oddsBackfilled = backfillOdds(rushbet);
  prune();
  saveState();
  writeSite({ model: modelInfo });
  await pushPrivateLedger();
  console.log('Resumen:', totals);
}

// --site-only: regenera site/data con el estado guardado, sin internet.
async function siteOnly() {
  const model = trainModel();
  writeSite({ model: { active: Boolean(model.weights && model.trainingCount >= MIN_TRAINING_SAMPLES), trainingCount: model.trainingCount } });
  console.log('site/data regenerado');
}

const bfIdx = process.argv.indexOf('--backfill');
const job = bfIdx > -1 ? backfill(Number(process.argv[bfIdx + 1]) || 30) : process.argv.includes('--site-only') ? siteOnly() : run();
job.catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
