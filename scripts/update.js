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
const { trainLogisticRegression, predictProbability, MIN_TRAINING_SAMPLES } = require('./lib/ml-model');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'site', 'data');
const MEDIA_BASE = 'https://api.league-pro.com';
const TZ = 'America/Bogota';

const MIN_CONFIDENCE_TO_PUBLISH = 60;
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

  const { confidence: raw, factors } = computeConfidence({
    ratingDiff: (sideA.rating_before_tournament || 0) - (sideB.rating_before_tournament || 0),
    streakA: recentStreak(match.a),
    streakB: recentStreak(match.b),
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

  // Con muestra suficiente decide el modelo entrenado; si no, la fórmula.
  const useModel = model.weights && model.trainingCount >= MIN_TRAINING_SAMPLES;
  let favA, confidence;
  if (useModel) {
    const pA = predictProbability(model.weights, factors);
    favA = pA >= 0.5;
    const pFav = favA ? pA : 1 - pA;
    confidence = Math.max(50, Math.min(92, Math.round(70 + (2 * pFav - 1) * 20)));
  } else {
    favA = raw >= 70;
    confidence = favA ? raw : 140 - raw;
  }

  return {
    id: match.id,
    fav: favA ? match.a : match.b,
    c: confidence,
    o: odds ? (favA ? odds.oddsA : odds.oddsB) : null,
    f: factors,
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

function playerRef(id) {
  const p = state.players[id] || {};
  return { id, n: p.n || '?', av: p.av || null, r: p.r ?? null };
}

function matchView(m) {
  return {
    id: m.id,
    at: m.at,
    t: m.t,
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
    h2h: h2h.map((x) => (x.w === m.a ? 'A' : 'B')).join('')
  };
}

function pickView(p, detailed = false) {
  const m = state.matches[p.id];
  return { ...(detailed ? detailView(m) : matchView(m)), fav: p.fav, c: p.c, o: p.o, res: p.res, ft: Boolean(p.ft) };
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

  // Destacado: entre los pendientes, el de más confianza con cuota > 1.60.
  const pending = published.filter((p) => p.res === 'pending');
  for (const p of published) delete p.ft;
  const withOdds = pending.filter((p) => p.o && p.o > FEATURED_MIN_ODDS);
  const pool = withOdds.length ? withOdds : pending;
  const featured = pool.slice().sort((a, b) => b.c - a.c)[0];
  if (featured) featured.ft = true;

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
      return { ...detailView(m), pick: p && p.pub ? { fav: p.fav, c: p.c, o: p.o, res: p.res } : null };
    });

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
    model: meta.model
  });
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
  console.log(`Torneos a revisar: ${ids.size}`);

  let rushbet = [];
  try {
    rushbet = await fetchLigaProChecaOdds();
    console.log(`Cuotas Rushbet: ${rushbet.length} partidos`);
  } catch (e) {
    console.error(`Sin cuotas de Rushbet: ${e.message}`);
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
