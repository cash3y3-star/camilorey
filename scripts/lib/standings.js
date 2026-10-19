// ============================================================
// CamiloRey — tabla del grupo y "qué se juega" cada jugador.
//
// Formato de la liga (tt.league-pro): grupo todos contra todos de 4-5
// jugadores, 2 puntos por victoria y 1 por derrota. 1.º y 2.º juegan la
// final, 3.º y 4.º el 3er puesto y el 5.º queda fuera.
//
// Desempate de la página (verificado: 150 de 150 torneos del 9 al 17-oct
// iguales a group_place): puntos, más sets ganados, menos sets perdidos y
// diferencia de puntos de juego. El cruce directo NO cuenta. Los partidos
// no traen los puntos de juego: se usa la diferencia de la tabla oficial
// del momento (gd: Map jugador → diferencia).
//
// Para un partido pendiente se recorren los resultados posibles de lo que
// falta del grupo (3-0, 3-1, 3-2 para cada lado) y se mira en qué "nivel"
// termina cada jugador: 0 final, 1 tercer puesto, 2 fuera.
// ============================================================

const SCORES = [[3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3]];
const tierOf = (place) => (place <= 2 ? 0 : place <= 4 ? 1 : 2);

// Motor: índices locales 0..n-1 y arreglos chicos (se evalúan miles de tablas).
function engine(players, done, gd) {
  const n = players.length;
  const ix = new Map(players.map((id, i) => [id, i]));
  const base = { pts: new Array(n).fill(0), sw: new Array(n).fill(0), sl: new Array(n).fill(0) };
  const g = players.map((id) => gd?.get(id) || 0);
  const apply = (T, a, b, sa, sb) => {
    T.pts[a] += sa > sb ? 2 : 1;
    T.pts[b] += sa > sb ? 1 : 2;
    T.sw[a] += sa; T.sl[a] += sb; T.sw[b] += sb; T.sl[b] += sa;
  };
  for (const x of done) if (ix.has(x.a) && ix.has(x.b)) apply(base, ix.get(x.a), ix.get(x.b), x.sa, x.sb);
  // y va delante de x
  const better = (T, y, x) => {
    if (T.pts[y] !== T.pts[x]) return T.pts[y] > T.pts[x];
    if (T.sw[y] !== T.sw[x]) return T.sw[y] > T.sw[x];
    if (T.sl[y] !== T.sl[x]) return T.sl[y] < T.sl[x];
    if (g[y] !== g[x]) return g[y] > g[x];
    return players[y] < players[x]; // empate total: orden fijo
  };
  const place = (T, x) => {
    let p = 1;
    for (let y = 0; y < n; y++) if (y !== x && better(T, y, x)) p++;
    return p;
  };
  const copy = () => ({ pts: base.pts.slice(), sw: base.sw.slice(), sl: base.sl.slice() });
  return { n, ix, base, apply, place, copy };
}

// Recorre los resultados de "left" (exacto si son pocos; si no, muestreo fijo).
function* combos(k, maxExact, samples) {
  const idx = new Array(k).fill(0);
  if (k <= maxExact) {
    while (true) {
      yield idx;
      let j = 0;
      while (j < k && ++idx[j] === SCORES.length) idx[j++] = 0;
      if (j === k) return;
    }
  }
  let seed = 12345;
  for (let s = 0; s < samples; s++) {
    for (let j = 0; j < k; j++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      idx[j] = (seed >> 8) % SCORES.length;
    }
    yield idx;
  }
}

const playersOf = (group) => [...new Set(group.flatMap((x) => [x.a, x.b]))];
const isDone = (x) => x.st === 'f' && x.sa != null;

// Orden de una lista de jugadores con partidos terminados (para la tabla).
function rank(players, games, gd = null) {
  const E = engine(players, games, gd);
  const order = players.slice().sort((x, y) => E.place(E.base, E.ix.get(x)) - E.place(E.base, E.ix.get(y)));
  return { order, base: E.base, ix: E.ix };
}

// Tabla actual del grupo. group: [{id, a, b, sa, sb, st, at}] (todos sus partidos).
// q: 'F' final asegurada, 'T' 3er puesto seguro, 'X' fuera, 'N' ya sin
// opción de final, null todavía en juego (al terminar el grupo: según el puesto).
function table(group, gd = null) {
  const players = playersOf(group);
  const done = group.filter(isDone);
  const left = group.filter((x) => !isDone(x));
  const { order, base, ix } = rank(players, done, gd);
  const E = engine(players, done, gd);
  const exact = left.length <= 6;
  const lo = new Array(players.length).fill(9);
  const hi = new Array(players.length).fill(-1);
  if (left.length) {
    for (const idx of combos(left.length, 6, 3000)) {
      const T = E.copy();
      left.forEach((x, j) => E.apply(T, E.ix.get(x.a), E.ix.get(x.b), SCORES[idx[j]][0], SCORES[idx[j]][1]));
      for (let i = 0; i < players.length; i++) {
        const t = tierOf(E.place(T, i));
        if (t < lo[i]) lo[i] = t;
        if (t > hi[i]) hi[i] = t;
      }
    }
  }
  const wl = new Map(players.map((id) => [id, [0, 0]]));
  for (const x of done) {
    wl.get(x.a)[x.sa > x.sb ? 0 : 1]++;
    wl.get(x.b)[x.sa > x.sb ? 1 : 0]++;
  }
  return order.map((id, k) => {
    const i = ix.get(id);
    const q = !left.length ? 'FTX'[tierOf(k + 1)] : !exact ? null : lo[i] === hi[i] ? 'FTX'[lo[i]] : hi[i] === 0 ? 'F' : lo[i] >= 1 ? 'N' : null;
    return { p: id, pos: k + 1, w: wl.get(id)[0], l: wl.get(id)[1], sw: base.sw[i], sl: base.sl[i], pts: base.pts[i], q };
  });
}

// Qué se juega cada jugador en el partido m (de group), con lo terminado
// ANTES de m.at. Para cada lado:
//   rows: [min, max] nivel según el resultado de m, de peor a mejor para él
//         (0-3, 1-3, 2-3, 3-2, 3-1, 3-0)
//   imp:  importancia = nivel medio si pierde menos si gana (0..2, uniforme
//         sobre lo que falta); 0 = no se juega nada
//   dead: su nivel ya no puede cambiar (solo con cálculo exacto)
//   need: frase en español (solo con cálculo exacto)
// opts: maxExact (partidos restantes para recorrer todo), samples.
function stakes(group, m, gd = null, opts = {}) {
  const maxExact = opts.maxExact ?? 5;
  const players = playersOf(group);
  const done = group.filter((x) => isDone(x) && x.at < m.at && x.id !== m.id);
  const left = group.filter((x) => x.id !== m.id && !done.includes(x));
  const exact = left.length <= maxExact;
  const E = engine(players, done, gd);
  const a = E.ix.get(m.a);
  const b = E.ix.get(m.b);
  const acc = [a, b].map(() => SCORES.map(() => ({ min: 9, max: -1, sum: 0, n: 0 })));
  for (const idx of combos(left.length, maxExact, opts.samples ?? 1500)) {
    const R = E.copy();
    left.forEach((x, j) => E.apply(R, E.ix.get(x.a), E.ix.get(x.b), SCORES[idx[j]][0], SCORES[idx[j]][1]));
    SCORES.forEach(([sa, sb], o) => {
      const T = { pts: R.pts.slice(), sw: R.sw.slice(), sl: R.sl.slice() };
      E.apply(T, a, b, sa, sb);
      [a, b].forEach((x, s) => {
        const t = tierOf(E.place(T, x));
        const r = acc[s][o];
        if (t < r.min) r.min = t;
        if (t > r.max) r.max = t;
        r.sum += t;
        r.n++;
      });
    });
  }
  const view = (s) => {
    // SCORES va de 3-0 a 0-3 para A: para A se invierte, para B ya va de peor a mejor
    const rows = s === 0 ? acc[0].slice().reverse() : acc[1];
    const mean = (list) => list.reduce((t, r) => t + r.sum, 0) / list.reduce((t, r) => t + r.n, 0);
    const imp = Math.round((mean(rows.slice(0, 3)) - mean(rows.slice(3))) * 100) / 100;
    const min = Math.min(...rows.map((r) => r.min));
    const max = Math.max(...rows.map((r) => r.max));
    return { imp, dead: exact && min === max, need: exact ? needText(rows, min, max, players.length) : null, rows: rows.map((r) => [r.min, r.max]) };
  };
  return { a: view(0), b: view(1), exact };
}

const WIN = ['', '', '', '', '3-1 o 3-0', '3-0'];
function needText(rows, min, max, size) {
  if (min === max) {
    if (min === 0) return { k: 'safe', t: 'Ya está en la final pase lo que pase: no se juega nada en este partido.' };
    if (min === 1) return { k: 'dead', t: 'Ya no puede llegar a la final y juega el 3er puesto pase lo que pase: no se juega nada en este partido.' };
    return { k: 'dead', t: 'Ya quedó fuera de la definición pase lo que pase: no se juega nada en este partido.' };
  }
  const secure = (tier) => rows.findIndex((r) => r.max <= tier); // primer resultado que lo asegura
  const chance = (tier) => rows.findIndex((r) => r.min <= tier); // primer resultado que le deja opción
  const phrase = (i, goal) =>
    i === 0 ? `Asegura ${goal} aunque pierda`
    : i <= 2 ? `Le basta ganar ${i} set${i > 1 ? 's' : ''} para asegurar ${goal}`
    : i === 3 ? `Si gana, asegura ${goal}`
    : `Necesita ganar ${WIN[i]} para asegurar ${goal}`;
  if (min === 0) {
    const s = secure(0);
    const c = chance(0);
    if (s >= 0) return { k: s >= 3 ? 'must' : 'final', t: `${phrase(s, 'la final')}${c < s ? '; con menos, depende de otros resultados' : ''}.` };
    if (c >= 3) return { k: 'must', t: `Necesita ganar${c > 3 ? ` ${WIN[c]}` : ''} para seguir con opción a la final, y además depende de otros resultados.` };
    return { k: 'open', t: 'Pelea por la final: el resultado le importa, pero depende también de otros partidos.' };
  }
  // Ya sin opción de final: pelea por no quedar 5.º (grupos de 5).
  const goal = size >= 5 ? 'el 3er puesto (el 5.º queda fuera)' : 'el 3er puesto';
  const s = secure(1);
  if (s >= 0) return { k: 'third', t: `Ya no llega a la final. ${phrase(s, goal)}.` };
  if (chance(1) >= 3) return { k: 'third', t: `Ya no llega a la final. Necesita ganar para seguir con opción a ${goal}.` };
  return { k: 'third', t: `Ya no llega a la final; pelea por ${goal} y depende de otros resultados.` };
}

// Partidos de la fase de grupos por torneo (la fase con más partidos).
// list: filas de state.matches ({id, t, sg, a, b, sa, sb, st, at}).
function groupsOf(list) {
  const byT = new Map();
  for (const m of list) if (m.sg != null) (byT.get(m.t) || byT.set(m.t, []).get(m.t)).push(m);
  const out = new Map();
  for (const [t, ms] of byT) {
    const count = new Map();
    for (const m of ms) count.set(m.sg, (count.get(m.sg) || 0) + 1);
    const sg = [...count.entries()].sort((x, y) => y[1] - x[1])[0][0];
    out.set(t, ms.filter((m) => m.sg === sg));
  }
  return out;
}

module.exports = { SCORES, rank, table, stakes, tierOf, groupsOf };
