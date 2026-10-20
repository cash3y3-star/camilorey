// ============================================================
// CamiloRey — actualización de partidos, picks y resultados
//
// Corre en GitHub Actions cada ~5 min (.github/workflows/update.yml).
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
const { featuresOf, train: trainV2, fitMarket, predict, marketProb } = require('./lib/model-v2');
const { computeStake } = require('./lib/staking');
const { table: groupTable, stakes, groupsOf } = require('./lib/standings');
const BANK_START = 2000000; // banca inicial en COP, misma convención del sitio anterior

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'site', 'data');
const MEDIA_BASE = 'https://api.league-pro.com';
const TZ = 'America/Bogota';

// El modelo publica pick en TODOS los partidos. Por debajo de 55% (escala
// 50-80%) el partido es parejo y la página lo dice así, sin inflar nada.
const PAREJO_BELOW = 55;
const MAX_CONFIDENCE = 80;
const FEATURED_MIN_ODDS = 1.6;
const FEATURED_MIN_CONF = 60;
// El resumen de destacados de Inicio cuenta desde aquí (el usuario lo
// reinició el 19-oct al cambiar la regla del destacado).
const FEATURED_FROM = '2026-10-19T05:30:00Z';
const HISTORY_FROM = '2026-01-01'; // historial completo del año (H2H, forma, rachas)
const HISTORY_BUDGET_MS = 4 * 60e3; // tiempo por corrida para cargar días viejos que falten
// El pick pendiente se recalcula en cada corrida (cada ~5 min) hasta 1 min
// antes del inicio: así la última revisión cae en los 5 min previos al
// partido, con la forma del día y la cuota más recientes. Antes se
// congelaba 5 min antes y la última revisión podía quedar a 10 min.
const FREEZE_BEFORE_MS = 60e3;

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
  picks: readJson(path.join(STATE_DIR, 'picks.json'), {}),
  notified: readJson(path.join(STATE_DIR, 'notified.json'), {}), // avisos push ya enviados (scripts/notify.js)
  history: readJson(path.join(STATE_DIR, 'history.json'), {}) // días viejos ya cargados completos { 'YYYY-MM-DD': true }
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

// Índice jugador -> partidos terminados (más nuevo primero). Con el año
// completo hay decenas de miles de partidos: recorrerlos todos por cada
// consulta sería lento. Se rehace cuando cambian los partidos.
let finishedIdx = null;
function finishedMatchesOf(playerId) {
  if (!finishedIdx) {
    finishedIdx = new Map();
    const add = (id, m) => (finishedIdx.get(id) || finishedIdx.set(id, []).get(id)).push(m);
    for (const m of Object.values(state.matches)) {
      if (m.st !== 'f') continue;
      add(m.a, m);
      add(m.b, m);
    }
    for (const list of finishedIdx.values()) list.sort((x, y) => (x.at < y.at ? 1 : -1));
  }
  return finishedIdx.get(playerId) || [];
}

// Todos los cruces directos terminados (más nuevo primero), opcionalmente
// solo los anteriores a una fecha.
function h2hMatches(aId, bId, beforeIso = null) {
  return finishedMatchesOf(aId).filter((m) => (m.a === bId || m.b === bId) && (!beforeIso || m.at < beforeIso));
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
  const data = h2hMatches(aId, bId).slice(0, 10);
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

// Lo que se publica del modelo en stats.json (sin pesos internos).
const modelSummary = (model) => ({ active: true, version: 2, trainingCount: model.trained, holdout: model.holdout, market: model.market.fitted });

// Modelo v2: se reentrena en cada corrida con TODOS los partidos
// terminados del historial (ver lib/model-v2.js).
const modelCtx = { finishedOf: (id) => finishedMatchesOf(id) };
function trainModel() {
  const t0 = Date.now();
  const fin = Object.values(state.matches)
    .filter((m) => m.st === 'f' && m.w != null)
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id - y.id));
  const model = trainV2(fin, modelCtx);
  if (!model) throw new Error(`Muy pocos partidos para entrenar (${fin.length})`);
  currentModel = model;
  fitMarket(model, fin.filter((m) => m.oa && m.ob), modelCtx);
  console.log(
    `Modelo v2: ${model.trained} partidos en ${((Date.now() - t0) / 1000).toFixed(1)}s · pesos ${JSON.stringify(model.weights)} · mercado ${JSON.stringify(model.market)} · acierto en partidos no vistos ${JSON.stringify(model.holdout)}`
  );
  return model;
}

// Pick con el modelo v2 (lib/model-v2.js): historial completo + cuota de
// Rushbet si la hay + regla de lógica del H2H. Se recalcula en cada
// corrida hasta 1 min antes del inicio (cambian la forma del día y la cuota).
function generatePick(match, odds, model, prev = null) {
  const { f, raw } = featuresOf(match, modelCtx);
  const oa = odds?.oddsA ?? prev?.x?.oA ?? null;
  const ob = odds?.oddsB ?? prev?.x?.oB ?? null;
  const { p, ph, pm } = predict(model, f, oa, ob);
  let favA = p >= 0.5;
  let pFav = favA ? p : 1 - p;

  // Regla de lógica: no elegir a quien pierde claramente el cruce directo
  // (4+ enfrentamientos y 25% o menos de victorias, ej. 0-6), salvo que el
  // mercado también lo vea favorito. Si el modelo lo eligió igual, se pasa
  // al dominador del H2H y se marca como parejo.
  // Con cuota no aplica: manda la regla de la casa (abajo).
  let rule = null;
  if (raw.hT >= 4 && pm == null) {
    const favShare = (favA ? raw.hA : raw.hT - raw.hA) / raw.hT;
    if (favShare <= 0.25) {
      favA = !favA;
      pFav = Math.max(0.5, 1 - pFav);
      rule = 'h2h';
    }
  }
  // Regla de la casa: no ir contra el favorito de Rushbet. Medido el 18-oct:
  // los picks publicados contra la casa acertaron 42.9% (21/49) y en el
  // historial con cuota 45% (9/20); siguiendo a la casa esos pasan a ~55%.
  // Se marca como parejo (54%): la ventaja que queda es poca.
  if (pm != null && pm !== 0.5 && favA !== pm > 0.5) {
    favA = pm > 0.5;
    pFav = 0.54;
    rule = 'mkt';
  }
  const confidence = Math.round(Math.max(0.5, Math.min(MAX_CONFIDENCE / 100, pFav)) * 100);
  const formA = tournamentForm(match.a, match.t, match.at);
  const formB = tournamentForm(match.b, match.t, match.at);

  return {
    id: match.id,
    fav: favA ? match.a : match.b,
    c: confidence,
    o: oa && ob ? (favA ? oa : ob) : prev?.o && prev.fav === (favA ? match.a : match.b) ? prev.o : null,
    f,
    // Datos crudos con los que se decidió — base del "Análisis IA".
    x: {
      rA: match.ra ?? null,
      rB: match.rb ?? null,
      hA: raw.hA,
      hT: raw.hT,
      h5A: raw.h5A,
      h5T: raw.h5T,
      fA: [formA.wins, formA.losses],
      fB: [formB.wins, formB.losses],
      pH: Math.round(ph * 1000) / 1000, // probabilidad de A según el historial
      pA: pm != null ? Math.round(pm * 1000) / 1000 : null, // según el mercado
      oA: oa, // cuotas de Rushbet de cada jugador; se van actualizando
      oB: ob, // hasta que empieza el partido (= cuota prepartido final)
      rule,
      n: model.trained,
      acc: model.holdout
    },
    pub: true,
    src: 'v2',
    res: 'pending',
    created: prev?.created || new Date().toISOString()
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
// Mientras se carga historial viejo no se espera: se deja para la próxima.
let fetchNoWait = false;
async function fetchTT(pathname) {
  const waits = [20e3, 60e3, 180e3];
  for (let i = 0; ; i++) {
    try {
      return await fetchNuxtData(pathname);
    } catch (e) {
      if (!e.rateLimited || fetchNoWait || i >= waits.length) throw e;
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
  // Bolas (puntos de juego) ganadas y perdidas en la tabla oficial del
  // grupo: se muestran en la tabla y su diferencia es el último desempate
  // (los partidos no traen las bolas). Ver lib/standings.js.
  const gb = {};
  for (const g of pageData.widgets.group_sides || []) {
    const pid = sides.find((s) => s.id === g.side_id)?.player?.id;
    if (pid && g.goals_won_count != null) gb[pid] = [g.goals_won_count, g.goals_lost_count || 0];
  }
  state.tournaments[id] = {
    n: pageData.tournament.name_en,
    at: pageData.tournament.start_date,
    st: finished ? 'f' : 's',
    w: winnerSide?.player?.id || null,
    gb
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
      w: played ? (m.results.score_one > m.results.score_two ? sideA.player.id : sideB.player.id) : null,
      // Rating oficial antes del torneo y cuotas de Rushbet (las guarda
      // backfillOdds): el modelo v2 aprende de ellos.
      ra: sideA.rating_before_tournament ?? null,
      rb: sideB.rating_before_tournament ?? null,
      oa: state.matches[m.id]?.oa ?? null,
      ob: state.matches[m.id]?.ob ?? null
    };
    const prevSt = state.matches[m.id]?.st;
    if (!prevSt) tIndex = null; // partido nuevo: índice por torneo desactualizado
    state.matches[m.id] = row;
    if (played && prevSt !== 'f') finishedIdx = null; // índice de terminados desactualizado
    totals.matches++;

    if (played) {
      if (resolvePick(row)) totals.resolved++;
      continue;
    }
    if (!makePicks || row.st !== 's') continue;
    // Pick nuevo, o recálculo del pendiente hasta 1 min antes del inicio
    // (mientras tanto cambian la forma del día y la cuota).
    const prev = state.picks[m.id];
    if (prev && (prev.res !== 'pending' || new Date(row.at).getTime() <= Date.now() + FREEZE_BEFORE_MS)) continue;

    try {
      const odds = findOdds(rushbet, state.players[row.a].n, state.players[row.b].n, row.at);
      const pick = generatePick(row, odds, model, prev);
      if (prev?.dst != null) pick.dst = prev.dst;
      // upd: última revisión; chg: veces que el pick cambió de jugador
      // (notify.js avisa a quien sigue el partido).
      pick.upd = new Date().toISOString();
      pick.chg = (prev?.chg || 0) + (prev && prev.fav !== pick.fav ? 1 : 0);
      state.picks[m.id] = pick;
      if (!prev) totals.newPicks++;
      else if (prev.fav !== pick.fav) totals.flipped = (totals.flipped || 0) + 1;
    } catch (e) {
      console.error(`Pick de ${m.id} falló: ${e.message}`);
    }
  }
}

// El cruce con Rushbet es "una oportunidad" al generar el pick: si la
// cuota aparece después, se completa acá (solo picks pendientes).
//
// Si el partido todavía no empieza y la casa tiene de favorito al otro
// jugador (la cuota llegó tarde o cambió después de la última revisión), el
// pick se recalcula: generatePick sigue a la casa. Medido el 19-oct: los
// picks que quedaron contra el favorito final de la casa acertaron 39%
// (22/56 en 4 días); con la cuota final se habrían acertado 12 picks más.
function backfillOdds(rushbet, model) {
  let n = 0;
  for (const p of Object.values(state.picks)) {
    if (p.res !== 'pending') continue;
    const m = state.matches[p.id];
    if (!m) continue;
    const odds = findOdds(rushbet, state.players[m.a]?.n, state.players[m.b]?.n, m.at);
    if (!odds) continue;
    // Cuotas de ambos jugadores mientras el partido no empieza: la última
    // que se guarda es la cuota prepartido (sirve para los picks del admin).
    if (p.x && m.st === 's') {
      p.x.oA = odds.oddsA;
      p.x.oB = odds.oddsB;
      m.oa = odds.oddsA; // en el partido: el modelo aprende el peso del mercado
      m.ob = odds.oddsB;
      const pm = marketProb(odds.oddsA, odds.oddsB);
      if (model && p.pub && pm != null && pm !== 0.5 && (p.fav === m.a) !== pm > 0.5 && new Date(m.at).getTime() > Date.now()) {
        try {
          const pick = generatePick(m, odds, model, p);
          if (p.dst != null) pick.dst = p.dst;
          pick.upd = new Date().toISOString();
          pick.chg = (p.chg || 0) + (p.fav !== pick.fav ? 1 : 0);
          pick.late = true; // recalculado por la cuota de los últimos minutos
          state.picks[p.id] = pick;
          continue;
        } catch (e) {
          console.error(`Pick de ${p.id} (cuota tardía) falló: ${e.message}`);
        }
      }
    }
    if (!p.o) {
      p.o = p.fav === m.a ? odds.oddsA : odds.oddsB;
      n++;
    }
  }
  return n;
}

function prune() {
  for (const [id, m] of Object.entries(state.matches)) {
    if (m.at < HISTORY_FROM && !state.picks[id]) delete state.matches[id];
  }
  const usedT = new Set(Object.values(state.matches).map((m) => m.t));
  for (const id of Object.keys(state.tournaments)) if (!usedT.has(Number(id))) delete state.tournaments[id];
  const old = new Date(Date.now() - 3 * 86400e3).toISOString();
  for (const t of Object.values(state.tournaments)) {
    if (t.at >= old) continue;
    delete t.gb;
    delete t.gd; // formato anterior (solo la diferencia)
  }
  const usedP = new Set(Object.values(state.matches).flatMap((m) => [m.a, m.b]));
  for (const id of Object.keys(state.players)) if (!usedP.has(Number(id))) delete state.players[id];
}

// ---------------- salida para la página ----------------

// Recortes de fondo (scripts/cutouts.js → site/cutouts/{id}.webp).
const CUTOUT_DIR = path.join(ROOT, 'site', 'cutouts');
const listWebp = (dir) => new Set((fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.webp')).map((f) => Number(f.slice(0, -5))));
const cutouts = listWebp(CUTOUT_DIR);
const thumbs = listWebp(path.join(CUTOUT_DIR, 'thumbs')); // miniaturas 160px (scripts/cutouts.js)
const mids = listWebp(path.join(CUTOUT_DIR, 'mid')); // recortes medianos 260px (tarjetas chicas)

// Referencia de un jugador en los JSON de la página. Solo lo que se usa:
// la foto original de tt.league-pro (150-300 KB) solo si no hay miniatura.
function playerRef(id) {
  const p = state.players[id] || {};
  const th = thumbs.has(Number(id)) ? `cutouts/thumbs/${id}.webp` : null;
  return {
    id,
    n: p.n || '?',
    av: th ? null : p.av || null,
    th,
    r: p.r ?? null,
    cut: cutouts.has(Number(id)) ? `cutouts/${id}.webp` : null,
    md: mids.has(Number(id)) ? `cutouts/mid/${id}.webp` : null
  };
}

// Fase del partido: los que no son de la fase de grupos (la fase con más
// partidos del torneo) son la definición — el último es la final y el
// anterior el 3er puesto. Se calcula por torneo y se guarda en caché.
const phaseCache = new Map();
let byTournament = null; // se arma una vez, en writeSite (después de cargar todo)
function phaseOf(m) {
  if (m.sg == null) return null;
  if (!phaseCache.has(m.t)) {
    if (!byTournament) {
      byTournament = new Map();
      for (const x of Object.values(state.matches)) (byTournament.get(x.t) || byTournament.set(x.t, []).get(x.t)).push(x);
    }
    const list = (byTournament.get(m.t) || []).filter((x) => x.sg != null);
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

// Tabla del grupo del torneo (va una vez por torneo en calendar.json) y lo
// que se juega cada jugador en el partido (lib/standings.js). Solo grupos
// completos: n jugadores → n(n−1)/2 partidos.
const stakeCache = new Map();
let tIndex = null; // torneo → ids de sus partidos (se rehace si entra un partido nuevo)
function groupOf(t) {
  if (!tIndex) {
    tIndex = new Map();
    for (const x of Object.values(state.matches)) (tIndex.get(x.t) || tIndex.set(x.t, []).get(x.t)).push(x.id);
  }
  const rows = (tIndex.get(t) || []).map((id) => state.matches[id]).filter(Boolean);
  const g = groupsOf(rows).get(t);
  if (!g) return null;
  const n = new Set(g.flatMap((x) => [x.a, x.b])).size;
  return n >= 4 && g.length === (n * (n - 1)) / 2 ? g : null;
}

// Señal "stake" del modelo: lo que se juega cada uno (lib/standings.js),
// con el mismo cálculo rápido con el que se midió en el diagnóstico.
// Medido el 18-oct en 37 mil partidos de grupo: si al rival ya no le
// importa el partido, el que se juega algo ganó 59-64% (el modelo sin esta
// señal esperaba 47-53%).
const STAKE_OPTS = { maxExact: 3, samples: 200 };
const stakeFeat = new Map(); // solo partidos terminados: no cambian
modelCtx.stakeOf = (m) => {
  if (stakeFeat.has(m.id)) return stakeFeat.get(m.id);
  const g = groupOf(m.t);
  const k = g && g.some((x) => x.id === m.id) ? stakes(g, m, null, STAKE_OPTS) : null;
  if (m.st === 'f') stakeFeat.set(m.id, k);
  return k;
};
const gdOf = (t) => new Map(Object.entries(state.tournaments[t]?.gb || {}).map(([k, v]) => [Number(k), v[0] - v[1]]));
function groupView(t) {
  const g = groupOf(t);
  if (!g) return null;
  const gb = state.tournaments[t]?.gb || {};
  return groupTable(g, gdOf(t)).map((r) => ({ ...r, n: state.players[r.p]?.n || '?', bw: gb[r.p]?.[0] ?? null, bl: gb[r.p]?.[1] ?? null }));
}
// gk: { a, b } frase de cada jugador (k: tipo, t: texto) o { early: true }
// si todavía faltan muchos partidos del grupo para saberlo con certeza.
function stakeView(m) {
  if (stakeCache.has(m.id)) return stakeCache.get(m.id);
  const g = groupOf(m.t);
  let v = null;
  if (g && g.some((x) => x.id === m.id)) {
    const k = stakes(g, m, gdOf(m.t));
    v = k.exact ? { a: k.a.need, b: k.b.need } : { early: true };
  }
  stakeCache.set(m.id, v);
  return v;
}

function detailView(m) {
  const all = h2hMatches(m.a, m.b, m.at);
  const h2h = all.slice(0, 10);
  h2hPairs.add(`${Math.min(m.a, m.b)}-${Math.max(m.a, m.b)}`); // H2H completo en data/h2h/
  return {
    ...matchView(m),
    fa: formBefore(m.a, m.at),
    fb: formBefore(m.b, m.at),
    h2h: h2h.map((x) => (x.w === m.a ? 'A' : 'B')).join(''),
    hN: all.length, // cruces directos en todo el historial (desde HISTORY_FROM)
    gk: stakeView(m)
    // La lista completa del H2H (fecha, torneo, sets) va aparte, en
    // data/h2h/{a}-{b}.json: la ficha la pide al abrir la pestaña H2H. Antes
    // iba aquí y era la mitad del peso de calendar.json.
  };
}

// "Análisis IA": argumentos reales a favor y en contra del favorito, a
// partir de los mismos datos con los que el modelo decidió (pick.x). Cada
// argumento lleva un peso aproximado (score del factor × su peso en
// lib/confidence.js) para ordenarlos de más a menos influyente.
function buildWhy(p, m) {
  if (p.src === 'v2') return buildWhyV2(p, m);
  return buildWhyV1(p, m);
}

// Análisis del modelo v2: cada argumento con su peso real en el modelo
// (peso aprendido × valor del dato), del más al menos influyente.
let currentModel = null;
function buildWhyV2(p, m) {
  const x = p.x;
  if (!x) return null;
  const favA = p.fav === m.a;
  const fav = state.players[p.fav]?.n || 'El favorito';
  const riv = state.players[favA ? m.b : m.a]?.n || 'su rival';
  const W = currentModel?.weights || { h2h: 1.4, h2h5: -0.2, today: 0.07 };
  const sgn = favA ? 1 : -1;
  const pro = [];
  const con = [];
  const add = (weight, text) => (weight >= 0 ? pro : con).push({ w: Math.abs(weight), t: text });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  if (x.rule === 'h2h') add(1, `Regla de lógica: ${riv} gana muy poco el cruce directo contra ${fav}, así que el sistema no lo elige aunque otros datos lo favorezcan.`);
  if (x.rule === 'mkt') add(1, `Regla de la casa: el historial favorecía a ${riv}, pero Rushbet tiene de favorito a ${fav}. Ir contra la casa salió mal (menos de 45% de acierto), así que el sistema sigue a la casa y lo marca como parejo.`);

  // Cruce directo completo (la señal más fuerte medida en esta liga).
  if (x.hT > 0) {
    const wF = favA ? x.hA : x.hT - x.hA;
    const w = (W.h2h || 0) * sgn * (p.f?.h2h ?? 0);
    if (wF * 2 > x.hT) add(w, `Domina el cruce directo en 2026: ganó ${wF} de ${plural(x.hT, 'enfrentamiento', 'enfrentamientos')} contra ${riv}. Es el dato que más pesa en el modelo.`);
    else if (wF * 2 < x.hT) add(w, `En el cruce directo de 2026 ${riv} ganó ${x.hT - wF} de ${x.hT}.`);
    else con.push({ w: 0, t: `Cruce directo parejo en 2026: ${wF}-${x.hT - wF}.` });
  } else con.push({ w: 0, t: 'No se han enfrentado en 2026: el modelo se apoya en la forma del día y el mercado.' });

  // Últimos 5 cruces (el modelo los usa con peso propio).
  if (x.h5T >= 3) {
    const w5 = favA ? x.h5A : x.h5T - x.h5A;
    const w = (W.h2h5 || 0) * sgn * (p.f?.h2h5 ?? 0);
    // El peso de este dato salió NEGATIVO en el entrenamiento: después de
    // una racha en el cruce, el que viene perdiendo suele recortar.
    if (Math.abs(w) >= 0.01) {
      if (w >= 0) add(w, `Últimos ${x.h5T} cruces: ${fav} ganó solo ${w5}, y en esta liga el que viene perdiendo el cruce suele recortar.`);
      else add(w, `Últimos ${x.h5T} cruces: ${fav} ganó ${w5}. En esta liga, tras una racha así, el rival suele recortar algo.`);
    }
  }

  // Forma del día en este mismo torneo.
  const fF = favA ? x.fA : x.fB;
  const fR = favA ? x.fB : x.fA;
  if (fF && fR && fF[0] + fF[1] + fR[0] + fR[1] > 0) {
    const w = (W.today || 0) * sgn * (p.f?.today ?? 0);
    if (w !== 0) add(w, `Forma hoy en este torneo: ${fav} va ${fF[0]}-${fF[1]} y ${riv} va ${fR[0]}-${fR[1]}.`);
  }

  // Tabla del grupo: lo que se juega cada uno (frases exactas de lib/standings.js).
  const gk = stakeView(m);
  if (gk && !gk.early && gk.a && gk.b) {
    const w = (W.stake || 0) * sgn * (p.f?.stake ?? 0);
    const nF = favA ? gk.a : gk.b;
    const nR = favA ? gk.b : gk.a;
    const both = `${fav}: ${nF.t} ${riv}: ${nR.t}`;
    // Solo se dice "le importa más" si las situaciones son distintas.
    const differ = nF.t !== nR.t;
    if (differ && w >= 0.1) add(w, `Tabla del grupo: a ${fav} el partido le importa más. ${both}`);
    else if (differ && w <= -0.1) add(w, `Tabla del grupo: a ${riv} el partido le importa más, y en esta liga el que se juega algo gana más de lo normal. ${both}`);
    else if (differ || nF.k !== 'open') con.push({ w: 0, t: `Tabla del grupo: ${both}` }); // los dos "pelean por la final": no aporta
  }

  // Rating oficial (entra al modelo cuando hay suficiente historial con él).
  const rF = favA ? x.rA : x.rB;
  const rR = favA ? x.rB : x.rA;
  if (rF != null && rR != null && rF !== rR) {
    const d = Math.round(rF - rR);
    const w = (W.rating || 0.05) * (d / 100);
    if (d > 0) add(w, `Mejor rating oficial: ${Math.round(rF)} contra ${Math.round(rR)}.`);
    else add(w, `${riv} tiene mejor rating oficial (${Math.round(rR)} contra ${Math.round(rF)}).`);
  }

  // Mercado (cuota real de Rushbet sin margen).
  if (x.pA != null) {
    const pf = favA ? x.pA : 1 - x.pA;
    const w = (currentModel?.market?.m ?? 0.7) * (pf - 0.5) * 2;
    if (pf >= 0.5) add(w, `El mercado coincide: según la cuota de Rushbet tiene ${Math.round(pf * 100)}% de probabilidad de ganar (sin el margen de la casa).`);
    else add(w, `El mercado ve favorito a ${riv} (${Math.round((1 - pf) * 100)}%): es un pick contra la casa, más arriesgado.`);
  } else con.push({ w: 0, t: 'Todavía no hay cuota de Rushbet para este partido: el pick se recalcula cuando aparezca, hasta 5 minutos antes del inicio.' });

  const order = (a, b) => b.w - a.w;
  const acc = x.acc?.all?.acc;
  return {
    pro: pro.sort(order).map((r) => r.t),
    con: con.sort(order).map((r) => r.t),
    src: `Modelo entrenado con ${(x.n || 0).toLocaleString('es-CO')} partidos reales de 2026${acc ? ` (acierto medido en partidos que no vio: ${String(acc).replace('.', ',')}%)` : ''}`
  };
}

function buildWhyV1(p, m) {
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

// Premium: los picks de alta confianza PENDIENTES y el Análisis IA de todos
// los picks no van en los archivos públicos; van a Firestore (premium/content),
// que solo pueden leer las cuentas con membresía activa. Ya jugados, los
// picks se muestran completos a todos (efectividad transparente).
// Modelo v2: con 60% o más de confianza acertó ~67% en partidos que no vio.
const PREMIUM_MIN = 60;
const FEATURED_MAX_ODDS = 2.5; // cuotas más altas = el mercado lo ve perdedor: ahí se perdía casi todo
const isLocked = (p) => p.res === 'pending' && p.c >= PREMIUM_MIN;
let premiumContent = null;

function pickView(p, detailed = false) {
  const m = state.matches[p.id];
  const base = detailed ? detailView(m) : matchView(m);
  if (isLocked(p)) return { ...base, fav: null, c: null, o: null, res: p.res, ft: Boolean(p.ft), locked: true };
  return { ...base, fav: p.fav, c: p.c, o: p.o, res: p.res, ft: Boolean(p.ft), chg: p.chg || 0 };
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
  byTournament = null;
  phaseCache.clear();
  stakeCache.clear();
  h2hPairs.clear();
  const published = Object.values(state.picks).filter((p) => p.pub && state.matches[p.id]);

  // Pick destacado: entre los pendientes que TODAVÍA NO EMPIEZAN, el de más
  // confianza con 60% o más y cuota entre 1.60 y 2.50 (si no hay, no hay
  // destacado: el usuario no quiere cuotas bajas). Medido el 19-oct: la
  // regla anterior (solo picks de 55-59%, porque el destacado era público)
  // acertaba 49%; con 60%+ y cuota > 1.60, 61%. El sitio ya es solo para
  // miembros, así que el destacado puede ser un pick Premium. Queda
  // registrado en p.dst y se congela cuando arranca su partido: así
  // "destacado" = el que era destacado al empezar el partido, y sus
  // resultados se miden aparte (estadísticas de Inicio).
  const pending = published.filter((p) => p.res === 'pending');
  const notStarted = pending.filter((p) => state.matches[p.id].st === 's' && new Date(state.matches[p.id].at).getTime() > now);
  const pool = notStarted.filter((p) => p.c >= FEATURED_MIN_CONF && p.o && p.o > FEATURED_MIN_ODDS && p.o <= FEATURED_MAX_ODDS);
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
      if (!p || !p.pub) return { ...detailView(m), pick: null };
      return { ...detailView(m), pick: isLocked(p) ? { fav: null, c: null, o: null, res: p.res, locked: true } : { fav: p.fav, c: p.c, o: p.o, res: p.res } };
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
  // Historial del admin: TODOS los picks, no solo los apostados. Los que
  // no mueven la banca (pendientes, en juego, sin cuota, o de antes cuando
  // no se publicaban los de menos de 55%) van sin ganancia ni saldo.
  const betRow = new Map(ledger.map((b) => [b.id, b]));
  const name = (id) => state.players[id]?.n || '?';
  privateLedger = Object.values(state.picks)
    .filter((p) => state.matches[p.id])
    .map((p) => {
      const m = state.matches[p.id];
      const b = betRow.get(p.id);
      const row = { id: p.id, at: m.at, ph: phaseOf(m), a: name(m.a), b: name(m.b), fav: name(p.fav), c: p.c, o: p.o ?? null, res: p.res };
      if (b) return { ...row, stake: b.stake, profit: b.profit, bal: b.bal };
      const st = p.res === 'pending' ? (m.st === 'f' ? 'wait' : m.st === 'l' ? 'live' : 'pre') : !p.pub ? 'np' : 'nodds';
      return { ...row, stake: p.res === 'pending' && p.o ? computeStake(p.c) : null, profit: null, bal: null, st };
    })
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : y.id - x.id))
    .slice(0, 2500); // ~12 días; el documento de Firestore tiene tope de 1 MB

  // Partidos SIN pick publicado (confianza < 55%): para que el admin elija
  // uno, se prepara el Análisis IA de AMBOS lados y las cuotas prepartido.
  // Va a la parte privada del admin (admin/ledger), no a site/data.
  adminNoPick = {};
  for (const p of Object.values(state.picks)) {
    const m = state.matches[p.id];
    if (p.pub || p.res !== 'pending' || !p.x || !m || m.st === 'f') continue;
    if (new Date(m.at).getTime() < now - 4 * 3600e3) continue;
    adminNoPick[p.id] = {
      c: p.c,
      fav: p.fav,
      oA: p.x.oA ?? null,
      oB: p.x.oB ?? null,
      whyA: buildWhy({ ...p, fav: m.a }, m),
      whyB: buildWhy({ ...p, fav: m.b }, m)
    };
  }

  // Contenido Premium (va a Firestore, no a site/data): pick completo de los
  // pendientes bloqueados y Análisis IA de todos los pendientes.
  premiumContent = {};
  for (const p of pending) {
    const m = state.matches[p.id];
    premiumContent[p.id] = { fav: p.fav, c: p.c, o: p.o ?? null, why: buildWhy(p, m) };
  }

  const byPlayer = finishedByPlayer();
  const champs = champions(now);
  const hot = hotPlayers(byPlayer, now);

  writeJson(path.join(OUT_DIR, 'picks.json'), pendingView);
  writeJson(path.join(OUT_DIR, 'results.json'), resolved.slice(0, 300).map((p) => pickView(p)));
  const groups = {};
  for (const t of new Set([...calendar, ...pendingView].map((m) => m.t))) {
    const g = groupView(t);
    if (g) groups[t] = g;
  }
  writeJson(path.join(OUT_DIR, 'calendar.json'), { days, matches: calendar, groups });
  // Acierto REAL por franja de confianza (picks v2 ya jugados, suavizado
  // hacia la confianza de la franja): Mi Bankroll calcula Kelly con esto.
  // Medido el 19-oct: los de 60%+ aciertan ~68% (el modelo es prudente).
  const calib = {};
  for (const band of [50, 55, 60, 65, 70]) {
    const list = resolved.filter((p) => p.src === 'v2' && Math.min(70, Math.floor(p.c / 5) * 5) === band);
    const hit = list.filter((p) => p.res === 'hit').length;
    const prior = (band + 2.5) / 100;
    calib[band] = Math.round(((hit + prior * 30) / (list.length + 30)) * 1000) / 1000;
  }
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
    featured: featuredStats(resolved, d),
    champions: champs,
    hot,
    calib,
    tipster: meta.tipster || null
  });
  registeredUsers = meta.users ?? null; // va a la parte privada del admin, no a stats.json
  writePlayers(new Set([...calendar.flatMap((m) => [m.a.id, m.b.id]), ...pendingView.flatMap((p) => [p.a.id, p.b.id]), ...champs.flatMap((c) => [c.champ.id, c.rival.id]), ...hot.map((h) => h.p.id)]), byPlayer);
  writeH2H();
}

// H2H completo del año de cada pareja que aparece en la página:
// site/data/h2h/{idMenor}-{idMayor}.json (la ficha lo pide al abrir H2H).
const h2hPairs = new Set();
function writeH2H() {
  const dir = path.join(OUT_DIR, 'h2h');
  fs.rmSync(dir, { recursive: true, force: true });
  // Desde qué día el historial está completo sin huecos (mientras se carga
  // el año, la ficha lo dice en vez de afirmar "en 2026").
  let from = null;
  for (let k = 2; ; k++) {
    const day = new Date(Date.now() - k * 86400e3).toISOString().slice(0, 10);
    if (day < HISTORY_FROM) {
      from = HISTORY_FROM;
      break;
    }
    if (!state.history[day]) break;
    from = day;
  }
  for (const key of h2hPairs) {
    const [lo, hi] = key.split('-').map(Number);
    const l = h2hMatches(lo, hi).map((x) => ({
      at: x.at,
      tn: (state.tournaments[x.t]?.n || '').replace(/^Tournament\s*/i, ''),
      ph: phaseOf(x),
      w: x.w,
      s: x.a === lo ? [x.sa, x.sb] : [x.sb, x.sa] // sets: [del id menor, del id mayor]
    }));
    writeJson(path.join(dir, `${key}.json`), { from: from || HISTORY_FROM, full: from === HISTORY_FROM, l });
  }
}

// Índice: partidos terminados de cada jugador, del más nuevo al más viejo.
function finishedByPlayer() {
  const idx = new Map();
  for (const m of Object.values(state.matches)) {
    if (m.st !== 'f') continue;
    for (const pid of [m.a, m.b]) {
      if (!idx.has(pid)) idx.set(pid, []);
      idx.get(pid).push(m);
    }
  }
  for (const list of idx.values()) list.sort((x, y) => (x.at < y.at ? 1 : -1));
  return idx;
}

function streakOf(list, pid) {
  let s = 0;
  for (const m of list) {
    const won = m.w === pid;
    if (s === 0) s = won ? 1 : -1;
    else if (s > 0 === won) s += won ? 1 : -1;
    else break;
  }
  return s;
}

// "Jugadores en racha": racha de victorias actual de 4 o más, jugando en
// las últimas 24 h. Desempata el % de victorias de los últimos 7 días.
function hotPlayers(byPlayer, now) {
  const dayAgo = new Date(now - 24 * 3600e3).toISOString();
  const weekAgo = new Date(now - 7 * 86400e3).toISOString();
  const out = [];
  for (const [pid, list] of byPlayer) {
    if (!list.length || list[0].at < dayAgo) continue;
    const s = streakOf(list, pid);
    if (s < 4) continue;
    const week = list.filter((m) => m.at >= weekAgo);
    const w = week.filter((m) => m.w === pid).length;
    out.push({ p: playerRef(pid), streak: s, w7: w, l7: week.length - w });
  }
  return out.sort((a, b) => b.streak - a.streak || b.w7 / (b.w7 + b.l7) - a.w7 / (a.w7 + a.l7)).slice(0, 10);
}

// Ficha de cada jugador: site/data/players/{id}.json
function writePlayers(ids, byPlayer) {
  const dir = path.join(OUT_DIR, 'players');
  fs.rmSync(dir, { recursive: true, force: true });
  const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();
  for (const pid of ids) {
    const list = byPlayer.get(pid) || [];
    const month = list.filter((m) => m.at >= monthAgo);
    const wM = month.filter((m) => m.w === pid).length;
    const titles = Object.entries(state.tournaments)
      .filter(([, t]) => t.st === 'f' && t.w === pid)
      .map(([tid, t]) => ({ t: Number(tid), tn: (t.n || '').replace(/^Tournament\s*/i, ''), at: t.at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    // Rivales más frecuentes con su historial.
    const vs = new Map();
    for (const m of list) {
      const op = m.a === pid ? m.b : m.a;
      if (!vs.has(op)) vs.set(op, { w: 0, l: 0 });
      vs.get(op)[m.w === pid ? 'w' : 'l']++;
    }
    const rivals = [...vs.entries()]
      .sort((a, b) => b[1].w + b[1].l - (a[1].w + a[1].l))
      .slice(0, 8)
      .map(([op, r]) => ({ p: playerRef(op), ...r }));
    writeJson(path.join(dir, `${pid}.json`), {
      p: playerRef(pid),
      streak: streakOf(list, pid),
      month: { w: wM, l: month.length - wM },
      all: { w: list.filter((m) => m.w === pid).length, l: list.filter((m) => m.w !== pid).length },
      titles: { count: titles.length, recent: titles.slice(0, 6) },
      rivals,
      last: list.slice(0, 30).map((m) => { // 30: alcanza para L10 de partidos de ayer
        const isA = m.a === pid;
        return {
          id: m.id,
          at: m.at,
          tn: (state.tournaments[m.t]?.n || '').replace(/^Tournament\s*/i, ''),
          ph: phaseOf(m),
          op: playerRef(isA ? m.b : m.a),
          s: isA ? `${m.sa}-${m.sb}` : `${m.sb}-${m.sa}`,
          w: m.w === pid
        };
      })
    });
  }
}

// Campeones de los torneos terminados en las últimas 30 horas: el ganador,
// su rival en la final, el marcador y la hora (para Inicio).
function champions(now) {
  const since = new Date(now - 30 * 3600e3).toISOString();
  const out = [];
  for (const [id, t] of Object.entries(state.tournaments)) {
    if (t.st !== 'f' || !t.w) continue;
    const ms = Object.values(state.matches)
      .filter((m) => m.t === Number(id) && m.st === 'f')
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    if (!ms.length) continue;
    const final = ms.find((m) => phaseOf(m) === 'Final') || [...ms].reverse().find((m) => m.a === t.w || m.b === t.w);
    if (!final || final.at < since) continue;
    const wonFinal = final.w === t.w;
    const rival = final.a === t.w ? final.b : final.a;
    out.push({
      t: Number(id),
      tn: (t.n || '').replace(/^Tournament\s*/i, ''),
      at: final.at,
      champ: playerRef(t.w),
      rival: playerRef(rival),
      score: final.a === t.w ? `${final.sa}-${final.sb}` : `${final.sb}-${final.sa}`,
      isFinal: phaseOf(final) === 'Final' && wonFinal,
      wins: ms.filter((m) => m.w === t.w).length,
      played: ms.filter((m) => m.a === t.w || m.b === t.w).length
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);
}

// Estadísticas SOLO de los picks destacados (p.dst), para Inicio.
function featuredStats(resolved, d) {
  const list = resolved.filter((p) => p.dst && state.matches[p.id].at >= FEATURED_FROM); // más nuevo primero
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
let registeredUsers = null; // número real de cuentas (solo admin)
let adminNoPick = null; // partidos sin pick: análisis de ambos lados y cuotas (solo admin)

// Picks del tipster (colección "tipster" de Firestore, la escribe el admin
// desde el panel; solo la leen miembros y el bot): se resuelven con los
// resultados oficiales.
async function tipsterStats() {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/tipster?pageSize=500&key=${FIREBASE_API_KEY}`;
    const headers = process.env.BOT_EMAIL ? { Authorization: `Bearer ${await require('./notify').botToken()}` } : {};
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const docs = (await r.json()).documents || [];
    let hit = 0;
    let miss = 0;
    const last = [];
    for (const d of docs) {
      const f = d.fields || {};
      const mid = Number(f.mid?.integerValue ?? f.mid?.doubleValue);
      const fav = Number(f.fav?.integerValue ?? f.fav?.doubleValue);
      const m = state.matches[mid];
      if (!m || m.st !== 'f') continue;
      const won = m.w === fav;
      won ? hit++ : miss++;
      last.push({ at: m.at, res: won ? 'hit' : 'miss' });
    }
    last.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { hit, miss, pct: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 10 : null, last: last.slice(0, 10).map((x) => x.res) };
  } catch {
    return null;
  }
}

// Contenido Premium → Firestore premium/content (lo escribe el bot; lo leen
// solo cuentas con membresía activa, por reglas).
async function pushPremiumContent() {
  if (!premiumContent || !process.env.BOT_EMAIL) return;
  try {
    const token = await require('./notify').botToken();
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/premium/content?key=${FIREBASE_API_KEY}`;
    const body = { fields: { updatedAt: { stringValue: new Date().toISOString() }, data: { stringValue: JSON.stringify(premiumContent) } } };
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`Contenido Premium: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
    else console.log(`Contenido Premium actualizado (${Object.keys(premiumContent).length} picks)`);
  } catch (e) {
    console.error(`Contenido Premium: ${e.message}`);
  }
}

async function pushPrivateLedger() {
  // Escribe la cuenta bot (reglas: solo el bot escribe admin/). La clave
  // vieja (botKey) se sigue mandando mientras convivan ambas reglas.
  const botKey = process.env.FIRESTORE_BOT_KEY || '';
  if (!privateLedger || (!botKey && !process.env.BOT_EMAIL)) return;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/admin/ledger?key=${FIREBASE_API_KEY}`;
  const body = {
    fields: {
      botKey: { stringValue: botKey },
      updatedAt: { stringValue: new Date().toISOString() },
      data: { stringValue: JSON.stringify({ summary: systemBankroll, ledger: privateLedger, users: registeredUsers, nopick: adminNoPick }) }
    }
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.BOT_EMAIL) headers.Authorization = `Bearer ${await require('./notify').botToken()}`;
    const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!r.ok) console.error(`Historial privado: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    else console.log(`Historial privado actualizado (${privateLedger.length} apuestas, ${Object.keys(adminNoPick || {}).length} partidos sin pick para el admin)`);
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

// Historial del año (desde HISTORY_FROM): en cada corrida normal se usan
// hasta HISTORY_BUDGET_MS para cargar días viejos que falten, del más
// reciente hacia atrás. Así se completa solo, sin una corrida de horas que
// frene las actualizaciones. Si tt.league-pro limita las consultas, se
// para y sigue en la próxima corrida. Devuelve true si cargó días nuevos.
async function historyStep(budgetMs) {
  const deadline = Date.now() + budgetMs;
  const totals = { matches: 0, resolved: 0, newPicks: 0 };
  let loaded = 0;
  fetchNoWait = true;
  try {
    for (let k = 2; ; k++) {
      const day = new Date(Date.now() - k * 86400e3).toISOString().slice(0, 10);
      if (day < HISTORY_FROM) break;
      if (state.history[day]) continue;
      if (Date.now() > deadline) break;
      const list = await listTournaments(day, day);
      const todo = list.filter((t) => state.tournaments[t.id]?.st !== 'f');
      let ok = true;
      for (const t of todo) {
        if (Date.now() > deadline) {
          ok = false;
          break;
        }
        try {
          await processTournament(t.id, { makePicks: false, rushbet: [], model: null, totals });
        } catch (e) {
          if (e.rateLimited) throw e;
          console.error(`Historial, torneo ${t.id}: ${e.message}`);
          ok = false;
        }
        await sleep(BACKFILL_PAUSE_MS);
      }
      if (ok) {
        state.history[day] = true;
        loaded++;
      }
    }
  } catch (e) {
    console.log(`Historial: pausa (${e.rateLimited ? 'límite de consultas' : e.message})`);
  } finally {
    fetchNoWait = false;
  }
  const missing = [];
  for (let k = 2; ; k++) {
    const day = new Date(Date.now() - k * 86400e3).toISOString().slice(0, 10);
    if (day < HISTORY_FROM) break;
    if (!state.history[day]) missing.push(day);
  }
  console.log(`Historial: ${loaded} días cargados en esta corrida (${totals.matches} partidos); faltan ${missing.length}${missing.length ? ` (el más reciente: ${missing[0]})` : ' — año completo'}`);
  return loaded > 0;
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
    // Antes no se publicaban los picks de menos de 55%: ahora el modelo
    // publica en todos los partidos (los que no se han jugado).
    if (!p.pub && p.res === 'pending' && m && m.st !== 'f') p.pub = true;
    // Cuotas que solo estaban en el pick: al partido (el modelo aprende de ellas).
    if (m && p.x?.oA && p.x?.oB && !m.oa) {
      m.oa = p.x.oA;
      m.ob = p.x.oB;
    }
  }

  const model = trainModel();
  const modelInfo = modelSummary(model);

  for (const id of ids) {
    try {
      await processTournament(id, { makePicks: true, rushbet, model, totals });
    } catch (e) {
      console.error(`Torneo ${id}: ${e.message}`);
    }
    await sleep(150);
  }

  totals.oddsBackfilled = backfillOdds(rushbet, model);
  // El historial viejo se carga DESPUÉS de publicar (paso aparte del
  // workflow: --history), para no demorar resultados ni picks nuevos.
  prune();
  writeSite({ model: modelInfo, tipster: await tipsterStats(), users: await require('./notify').countUsers() });
  try {
    const featured = Object.values(state.picks).find((p) => p.ft);
    await require('./notify').runNotifications(state, { name: (id) => state.players[id]?.n || '?', featuredId: featured?.id || null });
  } catch (e) {
    console.error(`Push: ${e.message}`);
  }
  // Después de writeSite: ahí se marca el pick destacado (p.dst), que
  // tiene que quedar guardado en el estado.
  saveState();
  await pushPrivateLedger();
  await pushPremiumContent();
  console.log('Resumen:', totals);
}

// --site-only: regenera site/data con el estado guardado, sin internet.
async function siteOnly() {
  writeSite({ model: modelSummary(trainModel()) });
  console.log('site/data regenerado');
}

const bfIdx = process.argv.indexOf('--backfill');
// --history: solo carga días viejos que falten y guarda el estado.
async function historyOnly() {
  await historyStep(HISTORY_BUDGET_MS);
  saveState();
}

const job =
  bfIdx > -1
    ? backfill(Number(process.argv[bfIdx + 1]) || 30)
    : process.argv.includes('--site-only')
    ? siteOnly()
    : process.argv.includes('--history')
    ? historyOnly()
    : run();
job.catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
