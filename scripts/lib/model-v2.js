// ============================================================
// CamiloRey — modelo v2: regresión logística entrenada con TODO el
// historial de partidos (no solo con los picks resueltos).
//
// Por qué: el modelo anterior aprendía de ~130 picks y llegó a pesos al
// revés (elegía al que perdía el H2H 0-6). Medido sobre ~28.000 partidos
// de 2026, prediciendo cada uno SOLO con lo ocurrido antes de él:
//   - H2H completo: 57% por sí solo (la señal más fuerte de la liga)
//   - forma del día en el mismo torneo: 56%
//   - rachas viejas, Elo propio, forma de 30 partidos: ~50-52% (ruido)
// Por eso el modelo usa pocas señales y bien medidas. Las features se
// calculan desde el punto de vista del jugador A (positivo = a favor de
// A) y el modelo es simétrico (sin intercepto): invertir A/B da 1 - p.
// ============================================================

const FEATURES = ['h2h', 'h2h5', 'today', 'rating'];
const MIN_PRIOR_MATCHES = 15; // para entrenar: ambos jugadores con historial
const MIN_RATING_ROWS = 2000; // el rating oficial entra cuando hay muestra
const L2 = 1; // regularización (como C=1 en sklearn)

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));

// Resuelve A·x = b (Gauss con pivoteo), A de d×d.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => (row[i] ? row[n] / row[i] : 0));
}

// Regresión logística sin intercepto, por Newton (IRLS), con cada fila
// también invertida (x → -x, y → 1-y) para que A/B no importe.
function fitLogistic(X, y, iters = 12) {
  const d = X[0]?.length || 0;
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = w.map((wi) => L2 * wi);
    const H = w.map((_, i) => w.map((__, j) => (i === j ? L2 : 0)));
    for (let r = 0; r < X.length; r++) {
      for (const sgn of [1, -1]) {
        const x = X[r];
        const yy = sgn === 1 ? y[r] : 1 - y[r];
        let z = 0;
        for (let i = 0; i < d; i++) z += w[i] * x[i] * sgn;
        const p = sigmoid(z);
        const s = p * (1 - p);
        for (let i = 0; i < d; i++) {
          g[i] += (p - yy) * x[i] * sgn;
          for (let j = 0; j < d; j++) H[i][j] += s * x[i] * x[j];
        }
      }
    }
    const step = solve(H, g);
    w = w.map((wi, i) => wi - step[i]);
  }
  return w;
}

// Features del partido m (punto de vista de A) con lo ocurrido ANTES de m.at.
// ctx.finishedOf(id) → partidos terminados del jugador, más nuevo primero.
function featuresOf(m, ctx) {
  const before = (list) => list.filter((x) => x.at < m.at);
  const listA = before(ctx.finishedOf(m.a));
  const h2h = listA.filter((x) => x.a === m.b || x.b === m.b); // más nuevo primero
  const wA = h2h.filter((x) => x.w === m.a).length;
  const last5 = h2h.slice(0, 5);
  const w5 = last5.filter((x) => x.w === m.a).length;
  const net = (list, pid) => list.reduce((s, x) => s + (x.t === m.t ? (x.w === pid ? 1 : -1) : 0), 0);
  const listB = before(ctx.finishedOf(m.b));
  const today = net(listA, m.a) - net(listB, m.b);
  const rating = m.ra != null && m.rb != null ? (m.ra - m.rb) / 100 : 0;
  return {
    f: {
      h2h: (wA + 1) / (h2h.length + 2) - 0.5,
      h2h5: last5.length ? (w5 + 0.5) / (last5.length + 1) - 0.5 : 0,
      today,
      rating
    },
    // datos crudos (para el Análisis IA y la regla de lógica)
    raw: { hA: wA, hT: h2h.length, h5A: w5, h5T: last5.length, nA: listA.length, nB: listB.length, hasRating: m.ra != null && m.rb != null }
  };
}

const vec = (f, keys) => keys.map((k) => f[k]);

// Entrena con todos los partidos terminados. Devuelve el modelo y su
// acierto medido en el 20% más reciente (entrenando solo con el 80% viejo).
function train(finishedSorted, ctx) {
  const rows = [];
  for (const m of finishedSorted) {
    if (m.w == null) continue;
    const { f, raw } = featuresOf(m, ctx);
    if (raw.nA < MIN_PRIOR_MATCHES || raw.nB < MIN_PRIOR_MATCHES) continue;
    rows.push({ f, y: m.w === m.a ? 1 : 0, hasRating: raw.hasRating });
  }
  const ratingRows = rows.filter((r) => r.hasRating).length;
  const keys = FEATURES.filter((k) => k !== 'rating' || ratingRows >= MIN_RATING_ROWS);
  if (rows.length < 500) return null;

  const cut = Math.floor(rows.length * 0.8);
  const wHold = fitLogistic(rows.slice(0, cut).map((r) => vec(r.f, keys)), rows.slice(0, cut).map((r) => r.y));
  const test = rows.slice(cut);
  const evalAt = (th) => {
    let ok = 0;
    let n = 0;
    for (const r of test) {
      const p = sigmoid(vec(r.f, keys).reduce((s, v, i) => s + v * wHold[i], 0));
      if (Math.max(p, 1 - p) < th) continue;
      n++;
      if (p >= 0.5 === (r.y === 1)) ok++;
    }
    return n ? { acc: Math.round((ok / n) * 1000) / 10, share: Math.round((n / test.length) * 100), n } : null;
  };
  const w = fitLogistic(rows.map((r) => vec(r.f, keys)), rows.map((r) => r.y));
  return {
    keys,
    weights: Object.fromEntries(keys.map((k, i) => [k, Math.round(w[i] * 10000) / 10000])),
    trained: rows.length,
    ratingRows,
    holdout: { all: evalAt(0), c55: evalAt(0.55), c60: evalAt(0.6) },
    market: { h: 1, m: 0.7, fitted: 0 } // se ajusta en fitMarket cuando hay muestra
  };
}

// Peso del mercado (cuota de Rushbet) frente al historial. Arranca en
// 0.7 y se aprende solo cuando hay >= 300 partidos terminados con cuota.
function fitMarket(model, finishedWithOdds, ctx) {
  const X = [];
  const y = [];
  for (const m of finishedWithOdds) {
    const pm = marketProb(m.oa, m.ob);
    if (pm == null) continue;
    const ph = historyProb(model, featuresOf(m, ctx).f);
    X.push([logit(clampP(ph)), logit(clampP(pm))]);
    y.push(m.w === m.a ? 1 : 0);
  }
  if (X.length >= 300) {
    const [h, mk] = fitLogistic(X, y);
    if (h > 0 && mk > 0) model.market = { h: Math.round(h * 1000) / 1000, m: Math.round(mk * 1000) / 1000, fitted: X.length };
  }
  return model;
}

const clampP = (p) => Math.min(0.97, Math.max(0.03, p));
function marketProb(oa, ob) {
  if (!oa || !ob || oa <= 1 || ob <= 1) return null;
  return 1 / oa / (1 / oa + 1 / ob); // sin el margen de la casa
}
function historyProb(model, f) {
  return sigmoid(model.keys.reduce((s, k) => s + f[k] * model.weights[k], 0));
}

// Probabilidad final de que gane A: historial + mercado (si hay cuota).
function predict(model, f, oa, ob) {
  const ph = historyProb(model, f);
  const pm = marketProb(oa, ob);
  const p = pm == null ? ph : sigmoid(model.market.h * logit(clampP(ph)) + model.market.m * logit(clampP(pm)));
  return { p, ph, pm };
}

module.exports = { FEATURES, featuresOf, train, fitMarket, predict, marketProb };
