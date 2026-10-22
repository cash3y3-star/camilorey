// ============================================================
// CamiloRey — diagnóstico del modelo (solo lectura del estado).
//
// Compara los últimos días: acierto real vs. esperado por la confianza,
// por franjas, mercado a favor/en contra, regla H2H, y qué habría pasado
// si el pick se hubiera recalculado justo al empezar el partido (forma del
// día y cuota final). Escribe diag-out/report.txt; el workflow lo cifra
// con una llave pública antes de guardarlo (el repo es público): por eso
// aquí NO se imprime nada del contenido en la consola.
// ============================================================

const fs = require('fs');
const path = require('path');
const { FEATURES, STAKES, featuresOf, train, fitMarket, predict, marketProb } = require('./lib/model-v2');
const { stakes, groupsOf } = require('./lib/standings');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'diag-out');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const matches = read('matches.json');
const picks = read('picks.json');
const players = read('players.json');
const tournaments = read('tournaments.json');

const day = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso));
const hour = (iso) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }).format(new Date(iso)));

const idx = new Map();
for (const m of Object.values(matches)) {
  if (m.st !== 'f') continue;
  for (const id of [m.a, m.b]) (idx.get(id) || idx.set(id, []).get(id)).push(m);
}
for (const l of idx.values()) l.sort((x, y) => (x.at < y.at ? 1 : -1));
const ctx = { finishedOf: (id) => idx.get(id) || [] };
// Lo que se juega cada uno en el grupo (señal stake), igual que update.js.
const groups = groupsOf(Object.values(matches));
const stakeCache = new Map();
const tS = Date.now();
ctx.stakeOf = (m) => {
  if (stakeCache.has(m.id)) return stakeCache.get(m.id);
  const g = groups.get(m.t);
  const k = g && g.length >= 6 && g.some((x) => x.id === m.id) ? stakes(g, m, null, { maxExact: 3, samples: 200 }) : null;
  stakeCache.set(m.id, k);
  return k;
};


const fin = Object.values(matches)
  .filter((m) => m.st === 'f' && m.w != null)
  .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id - y.id));
const model = train(fin, ctx);
fitMarket(model, fin.filter((m) => m.oa && m.ob), ctx);

const lines = [];
const out = (s = '') => lines.push(s);
const pct = (h, n) => (n ? `${((h / n) * 100).toFixed(1)}% (${h}/${n})` : '—');

const DAYS = [...new Set(Object.values(picks).filter((p) => matches[p.id]).map((p) => day(matches[p.id].at)))].sort().slice(-7);
out(`Modelo: ${model.trained} partidos · pesos ${JSON.stringify(model.weights)} · mercado ${JSON.stringify(model.market)}`);
out(`Generado: ${new Date().toISOString()} · días: ${DAYS.join(", ")}`);
out(`Holdout: ${JSON.stringify(model.holdout)}`);

const rows = [];
for (const p of Object.values(picks)) {
  const m = matches[p.id];
  if (!m || p.res === 'pending' || !p.pub || !DAYS.includes(day(m.at))) continue;
  const hit = p.res === 'hit';
  const favA = p.fav === m.a;
  const oA = p.x?.oA ?? null;
  const oB = p.x?.oB ?? null;
  const pm = marketProb(oA, oB);
  const mktFav = pm == null ? null : pm >= 0.5 ? m.a : m.b;
  const pmFav = pm == null ? null : favA ? pm : 1 - pm;
  // Recalculado al empezar: features con todo lo terminado antes de m.at y cuota final.
  const late = featuresOf(m, ctx);
  const pl = predict(model, late.f, m.oa ?? oA, m.ob ?? oB).p;
  const lateFav = pl >= 0.5 ? m.a : m.b;
  // Mismo modelo de hoy con los datos congelados del pick (para aislar el efecto "tarde").
  const frozenP = p.f ? predict(model, p.f, oA, oB).p : null;
  const frozenFav = frozenP == null ? null : frozenP >= 0.5 ? m.a : m.b;
  const todayChanged = p.f ? Math.abs((p.f.today ?? 0) - late.f.today) > 0 : null;
  // Partidos de cada jugador en el torneo terminados entre el congelado (5 min antes) y el inicio.
  const lastPrev = Math.max(
    ...[m.a, m.b].map((id) => {
      const prev = ctx.finishedOf(id).find((x) => x.at < m.at && x.t === m.t);
      return prev ? new Date(prev.at).getTime() : 0;
    })
  );
  const gapMin = lastPrev ? (new Date(m.at).getTime() - lastPrev) / 60e3 : null;
  rows.push({
    d: day(m.at), h: hour(m.at), hit, c: p.c, odds: !!(oA && oB), rule: p.x?.rule || null, hT: p.x?.hT ?? 0,
    withMkt: mktFav == null ? null : mktFav === p.fav, pmFav, mktHit: mktFav == null ? null : mktFav === m.w,
    lateFav, lateHit: lateFav === m.w, frozenFav, frozenHit: frozenFav == null ? null : frozenFav === m.w,
    todayChanged, gapMin, t: tournaments[m.t]?.n || String(m.t), o: p.o || null
  });
}

function block(title, list) {
  const n = list.length;
  const h = list.filter((r) => r.hit).length;
  const exp = list.reduce((s, r) => s + r.c / 100, 0);
  out(`\n== ${title} ==`);
  out(`acierto ${pct(h, n)} · esperado por confianza ${n ? ((exp / n) * 100).toFixed(1) : '—'}% · diferencia ${(h - exp).toFixed(1)} picks`);
  const sd = Math.sqrt(list.reduce((s, r) => s + (r.c / 100) * (1 - r.c / 100), 0));
  out(`desviación normal esperada ±${sd.toFixed(1)} picks (z = ${sd ? ((h - exp) / sd).toFixed(2) : '—'})`);
  for (const [lo, hi] of [[50, 54], [55, 59], [60, 64], [65, 100]]) {
    const l = list.filter((r) => r.c >= lo && r.c <= hi);
    out(`  conf ${lo}-${hi}: ${pct(l.filter((r) => r.hit).length, l.length)}`);
  }
  const wm = list.filter((r) => r.withMkt === true);
  const am = list.filter((r) => r.withMkt === false);
  const nm = list.filter((r) => r.withMkt === null);
  out(`  con el mercado: ${pct(wm.filter((r) => r.hit).length, wm.length)} · contra el mercado: ${pct(am.filter((r) => r.hit).length, am.length)} · sin cuota: ${pct(nm.filter((r) => r.hit).length, nm.length)}`);
  const mk = list.filter((r) => r.mktHit != null);
  out(`  solo mercado (favorito de la casa): ${pct(mk.filter((r) => r.mktHit).length, mk.length)}`);
  const fav = list.filter((r) => r.pmFav != null && r.pmFav >= 0.6);
  out(`  pick con cuota implícita ≥60%: ${pct(fav.filter((r) => r.hit).length, fav.length)}`);
  const ru = list.filter((r) => r.rule);
  out(`  regla H2H aplicada: ${pct(ru.filter((r) => r.hit).length, ru.length)}`);
  for (const [lo, hi, lab] of [[0, 3, 'H2H <4'], [4, 9, 'H2H 4-9'], [10, 1e9, 'H2H 10+']]) {
    const l = list.filter((r) => r.hT >= lo && r.hT <= hi);
    out(`  ${lab}: ${pct(l.filter((r) => r.hit).length, l.length)}`);
  }
  const fr = list.filter((r) => r.frozenHit != null);
  out(`  recalculado con el modelo de hoy y datos congelados: ${pct(fr.filter((r) => r.frozenHit).length, fr.length)}`);
  out(`  recalculado AL EMPEZAR (forma del día + cuota final): ${pct(list.filter((r) => r.lateHit).length, n)}`);
  const ch = fr.filter((r) => r.lateFav !== r.frozenFav);
  out(`  picks que cambiarían al recalcular al empezar: ${ch.length} · de esos el congelado acertó ${ch.filter((r) => r.frozenHit).length} y el nuevo ${ch.filter((r) => r.lateHit).length}`);
  const tc = list.filter((r) => r.todayChanged);
  out(`  forma del día distinta al empezar: ${tc.length} picks (${pct(tc.filter((r) => r.hit).length, tc.length)})`);
  const g = list.filter((r) => r.gapMin != null);
  const g10 = g.filter((r) => r.gapMin <= 10);
  out(`  jugador venía de un partido terminado ≤10 min antes: ${g10.length} de ${g.length}`);
}

for (const d of DAYS) block(`Día ${d}`, rows.filter((r) => r.d === d));
block('Todos los días juntos', rows);

out('\n== Por hora (todos los días) ==');
for (let h = 0; h < 24; h++) {
  const l = rows.filter((r) => r.h === h);
  if (l.length) out(`  ${String(h).padStart(2, '0')}h: ${DAYS.map((d) => { const x = l.filter((r) => r.d === d); return `${d.slice(5)} ${pct(x.filter((r) => r.hit).length, x.length)}`; }).join(' | ')}`);
}
out('\n== Por torneo (últimos 2 días, ≥8 picks) ==');
const tn = new Map();
for (const r of rows.filter((r) => DAYS.slice(-2).includes(r.d))) (tn.get(r.t) || tn.set(r.t, []).get(r.t)).push(r);
for (const [t, l] of [...tn.entries()].filter(([, l]) => l.length >= 8).sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
  out(`  ${t}: ${pct(l.filter((r) => r.hit).length, l.length)}`);
}

// Prueba de la regla "no ir contra la casa" en TODOS los partidos terminados
// con cuota (no solo los picks publicados).
out('\n== Regla "seguir a la casa cuando el modelo va en contra" (historial con cuota) ==');
const withOdds = fin.filter((m) => m.oa && m.ob);
const sim = { n: 0, base: 0, rule: 0, against: 0, againstHit: 0, noRuleBand: {}, ruleBand: {} };
const band = (c) => (c < 55 ? '50-54' : c < 60 ? '55-59' : c < 65 ? '60-64' : '65+');
for (const m of withOdds) {
  const { f } = featuresOf(m, ctx);
  const { p, pm } = predict(model, f, m.oa, m.ob);
  const favA = p >= 0.5;
  const mktA = pm >= 0.5;
  const hitBase = favA === (m.w === m.a);
  const hitRule = (favA === mktA ? favA : mktA) === (m.w === m.a);
  sim.n++;
  sim.base += hitBase;
  sim.rule += hitRule;
  if (favA !== mktA) {
    sim.against++;
    sim.againstHit += hitBase;
  }
  const b = band(Math.round(Math.max(p, 1 - p) * 100));
  (sim.noRuleBand[b] ||= [0, 0])[0] += hitBase;
  sim.noRuleBand[b][1]++;
}
out(`partidos con cuota: ${sim.n}`);
out(`  modelo actual: ${pct(sim.base, sim.n)} · con la regla: ${pct(sim.rule, sim.n)}`);
out(`  modelo contra la casa: ${pct(sim.againstHit, sim.against)} (con la regla esos pasan a ${pct(sim.against - sim.againstHit, sim.against)})`);
for (const [b, [h, n]] of Object.entries(sim.noRuleBand).sort()) out(`  franja ${b}: ${pct(h, n)}`);

// Tabla del grupo: ¿pesa lo que se juega cada uno? Se calcula para cada
// partido de grupo con lo terminado antes de él, y se compara el acierto
// real con lo que esperaba el modelo actual (sin cuota).
out('\n== Tabla del grupo: lo que se juega cada jugador ==');
const sb = {};
const bump = (key, won, exp) => { const b = (sb[key] ||= { h: 0, n: 0, e: 0 }); b.n++; b.e += exp; if (won) b.h++; };
let withK = 0;
for (const m of fin) {
  const k = ctx.stakeOf(m);
  if (!k) continue;
  withK++;
  const { f, raw } = featuresOf(m, ctx);
  if (raw.nA < 15 || raw.nB < 15) continue;
  const pA = predict(model, f, null, null).p;
  const side = (s) => ({ id: s === 'a' ? m.a : m.b, k: k[s], p: s === 'a' ? pA : 1 - pA });
  const A = side('a');
  const B = side('b');
  for (const [x, y] of [[A, B], [B, A]]) {
    // x = el que SÍ se juega algo
    if (!x.k.dead && y.k.dead) bump(`rival ${y.k.need?.k === 'safe' ? 'ya en la final' : 'ya sin nada (3er puesto o fuera)'}`, m.w === x.id, x.p);
    if (!x.k.dead && !y.k.dead && x.k.imp - y.k.imp >= 0.5) bump('le importa mucho más (dif. ≥ 0,5)', m.w === x.id, x.p);
    if (!x.k.dead && !y.k.dead && x.k.imp - y.k.imp >= 0.25 && x.k.imp - y.k.imp < 0.5) bump('le importa más (dif. 0,25-0,5)', m.w === x.id, x.p);
    if (x.k.need?.k === 'must' && !y.k.dead) bump('necesita ganar (rival también se juega algo)', m.w === x.id, x.p);
  }
  if (A.k.dead && B.k.dead) bump('a ninguno le importa (gana A)', m.w === m.a, pA);
}
out(`  partidos de grupo con cálculo: ${withK} de ${fin.length}`);
for (const [key, b] of Object.entries(sb)) out(`  gana el que se juega algo — ${key}: ${pct(b.h, b.n)} · el modelo esperaba ${((b.e / b.n) * 100).toFixed(1)}%`);
// Picks publicados (con su confianza real) cuando el rival no se jugaba nada.
const pk = { favDead: [0, 0], rivDead: [0, 0] };
for (const p of Object.values(picks)) {
  const m = matches[p.id];
  if (!m || p.res === 'pending' || !p.pub) continue;
  const k = ctx.stakeOf(m);
  if (!k) continue;
  const fk = p.fav === m.a ? k.a : k.b;
  const rk = p.fav === m.a ? k.b : k.a;
  if (fk.dead && !rk.dead) { pk.favDead[1]++; if (p.res === 'hit') pk.favDead[0]++; }
  if (rk.dead && !fk.dead) { pk.rivDead[1]++; if (p.res === 'hit') pk.rivDead[0]++; }
}
out(`  picks publicados con el elegido sin nada en juego (y el rival sí): ${pct(...pk.favDead)}`);
out(`  picks publicados con el rival sin nada en juego (y el elegido sí): ${pct(...pk.rivDead)}`);
const base = FEATURES.filter((k) => k !== 'stake');
const sVariants = [['sin stake', base], ['con stake (actual)', FEATURES], ['+ dead', [...FEATURES, 'dead']]];
for (const [lab, keys] of sVariants) {
  const mdl = train(fin, ctx, keys);
  const h = mdl.holdout;
  out(`  ${lab.padEnd(16)} acierto ${h.all.acc}% · ≥55%: ${h.c55?.acc}% (${h.c55?.share}%) · ≥60%: ${h.c60?.acc}% (${h.c60?.share}%) · logloss ${h.ll} · pesos ${JSON.stringify(mdl.weights)}`);
}

// Picks que el sistema cambió de jugador al revisarlos antes de empezar.
out('\n== Picks cambiados antes de empezar (desde que existe la revisión) ==');
const changed = Object.values(picks).filter((p) => p.chg);
const ch = changed.filter((p) => p.res !== 'pending');
out(`  cambiados: ${changed.length} (${changed.filter((p) => p.res === 'pending').length} pendientes) · de los jugados acertó ${pct(ch.filter((p) => p.res === 'hit').length, ch.length)}`);
const revised = Object.values(picks).filter((p) => p.upd && matches[p.id] && matches[p.id].st !== 's');
out(`  partidos empezados con revisión registrada: ${revised.length}`);
const lastRev = revised.filter((p) => matches[p.id]).map((p) => (new Date(matches[p.id].at) - new Date(p.upd)) / 60e3).filter((x) => x >= 0).sort((a, b) => a - b);
if (lastRev.length) out(`  minutos entre la última revisión y el inicio: mediana ${lastRev[Math.floor(lastRev.length / 2)].toFixed(1)} · 90% en menos de ${lastRev[Math.floor(lastRev.length * 0.9)].toFixed(1)}`);

// Ejemplo real: torneos de hoy con partidos pendientes (tabla + lo que se juega).
out('\n== Tablas de grupo de hoy (muestra) ==');
const { table } = require('./lib/standings');
const live = [...groups.entries()].filter(([, g]) => g.some((x) => x.st !== 'f')).sort((x, y) => y[1].filter((m) => m.st === 'f').length - x[1].filter((m) => m.st === 'f').length).slice(0, 3);
for (const [t, g] of live) {
  const gd = new Map(Object.entries(tournaments[t]?.gb || {}).map(([k, v]) => [Number(k), v[0] - v[1]]));
  out(`  ${tournaments[t]?.n || t} (diferencia de puntos guardada: ${gd.size ? 'sí' : 'no'})`);
  for (const r of table(g, gd)) out(`    ${r.pos}. ${players[r.p]?.n} ${r.w}-${r.l} sets ${r.sw}-${r.sl} pts ${r.pts} ${r.q || ''}`);
  const next = g.filter((x) => x.st !== 'f').sort((x, y) => (x.at < y.at ? -1 : 1))[0];
  const k = stakes(g, next, gd);
  out(`    próximo: ${players[next.a]?.n} vs ${players[next.b]?.n} → ${k.exact ? `${k.a.need.t} | ${k.b.need.t}` : 'todavía temprano'}`);
}

// Pick destacado: cómo le fue y qué habría pasado eligiendo por confianza.
out("\n== Pick destacado ==");
const res = Object.values(picks).filter((p) => p.pub && p.res !== "pending" && matches[p.id]);
const rate = (list) => pct(list.filter((p) => p.res === "hit").length, list.length);
const dst = res.filter((p) => p.dst);
out(`  destacados: ${rate(dst)} · confianza media ${(dst.reduce((a, p) => a + p.c, 0) / (dst.length || 1)).toFixed(1)} · cuota media ${(dst.filter((p) => p.o).reduce((a, p) => a + p.o, 0) / (dst.filter((p) => p.o).length || 1)).toFixed(2)}`);
for (const [lab, fn] of [["c ≥ 60", (p) => p.c >= 60], ["c ≥ 65", (p) => p.c >= 65], ["c ≥ 70", (p) => p.c >= 70], ["c ≥ 60 y cuota ≤ 1.60", (p) => p.c >= 60 && p.o && p.o <= 1.6], ["c ≥ 60 sin regla de la casa", (p) => p.c >= 60 && p.x?.rule !== "mkt"], ["c 55-59 y cuota 1.60-2.50 (regla actual)", (p) => p.c >= 55 && p.c < 60 && p.o > 1.6 && p.o <= 2.5]]) {
  const l = res.filter(fn);
  const r3 = l.filter((p) => DAYS.includes(day(matches[p.id].at)));
  out(`  ${lab}: todo ${rate(l)} · últimos días ${rate(r3)}`);
}
// El de más confianza de cada hora (simula "destacado = el más fijo").
const byHour = new Map();
for (const p of res) { const k = matches[p.id].at.slice(0, 13); const b = byHour.get(k); if (!b || p.c > b.c) byHour.set(k, p); }
const top = [...byHour.values()];
out(`  el de más confianza de cada hora: ${rate(top)} · últimos días ${rate(top.filter((p) => DAYS.includes(day(matches[p.id].at))))}`);

// Prueba de que la revisión de los picks usa la tabla del grupo (señal stake).
out('\n== Tabla del grupo en los picks revisados ==');
out(`  peso de la tabla en el modelo: ${model.weights.stake ?? 'no está'}`);
const rev = Object.values(picks).filter((p) => p.upd && p.upd >= '2026-10-19T00:00:00Z' && p.f);
const withS = rev.filter((p) => p.f.stake != null);
const nz = withS.filter((p) => Math.abs(p.f.stake) >= 0.05);
out(`  picks revisados desde el 19-oct: ${rev.length} · con la señal de la tabla calculada: ${withS.length} · donde la tabla pesa (|stake| ≥ 0,05): ${nz.length}`);
for (const p of nz.slice(-6)) {
  const m = matches[p.id];
  if (!m) continue;
  const fav = p.fav === m.a ? 'A' : 'B';
  const pTable = predict(model, p.f, null, null).p;
  const pNo = predict(model, { ...p.f, stake: 0 }, null, null).p;
  out(`  ${players[m.a]?.n} vs ${players[m.b]?.n} · stake ${p.f.stake.toFixed(2)} · P(${players[m.a]?.n}) con tabla ${(pTable * 100).toFixed(1)}% · sin tabla ${(pNo * 100).toFixed(1)}% · pick ${fav === 'A' ? players[m.a]?.n : players[m.b]?.n} ${p.c}% (${p.res})`);
}

// Detalle: cuántos partidos del grupo ya se habían jugado al revisar, y la señal guardada vs. la de ahora.
for (const p of withS.slice(-12)) {
  const m = matches[p.id];
  if (!m) continue;
  const g = groups.get(m.t) || [];
  const before = g.filter((x) => x.st === "f" && x.at < m.at).length;
  const now = stakes(g, m, null, { maxExact: 3, samples: 200 });
  out(`  ${m.at.slice(5, 16)} ${players[m.a]?.n} vs ${players[m.b]?.n} · grupo ${g.length} partidos, ${before} jugados antes · stake guardado ${p.f.stake.toFixed(3)} · recalculado ahora ${((now.a.imp - now.b.imp) / 2).toFixed(3)} · revisado ${p.upd.slice(11, 16)} · ${m.st}`);
}

// Cómo vamos hoy (hora de Colombia): picks publicados, por franja, destacado y tabla.
out('\n== Hoy ==');
{
  const today = day(new Date().toISOString());
  const list = Object.values(picks).filter((p) => p.pub && matches[p.id] && day(matches[p.id].at) === today);
  const done = list.filter((p) => p.res !== 'pending');
  const rate = (l) => pct(l.filter((p) => p.res === 'hit').length, l.length);
  out(`  ${today}: ${rate(done)} · pendientes ${list.length - done.length}`);
  for (const [lab, fn] of [['menos de 55%', (p) => p.c < 55], ['55-59%', (p) => p.c >= 55 && p.c < 60], ['60% o más', (p) => p.c >= 60]]) out(`    ${lab}: ${rate(done.filter(fn))}`);
  const dstNew = Object.values(picks).filter((p) => p.dst && p.res !== 'pending' && matches[p.id] && matches[p.id].at >= '2026-10-19T05:30:00Z');
  out(`  destacados desde el reinicio: ${rate(dstNew)} · ${dstNew.map((p) => `${players[p.fav]?.n} ${p.c}% @${p.o} ${p.res === 'hit' ? 'G' : 'P'}`).join(' | ')}`);
  const withStake = done.filter((p) => p.f && Math.abs(p.f.stake || 0) >= 0.05);
  out(`  picks de hoy donde pesó la tabla del grupo: ${rate(withStake)}`);
  const byT = new Map();
  for (const p of done) { const t = tournaments[matches[p.id].t]?.n || '?'; const b = byT.get(t) || []; b.push(p); byT.set(t, b); }
  for (const [t, l] of byT) out(`    ${t}: ${rate(l)}`);
}

// ¿La tabla del grupo empeoró los picks? Modelo igual pero SIN la señal
// stake, con los datos congelados de cada pick y la regla de la casa.
out('\n== Con tabla vs. sin tabla (picks publicados por día) ==');
{
  const noStake = train(fin, ctx, FEATURES.filter((k) => k !== 'stake'));
  fitMarket(noStake, fin.filter((m) => m.oa && m.ob), ctx);
  out(`  modelo sin tabla: pesos ${JSON.stringify(noStake.weights)} · mercado ${JSON.stringify(noStake.market)} · holdout ${JSON.stringify(noStake.holdout)}`);
  const pickOf = (mod, p, m) => {
    const oA = p.x?.oA ?? null;
    const oB = p.x?.oB ?? null;
    const r = predict(mod, p.f, oA, oB);
    let favA = r.p >= 0.5;
    if (r.pm != null && r.pm !== 0.5 && favA !== r.pm > 0.5) favA = r.pm > 0.5;
    return { fav: favA ? m.a : m.b, c: Math.round(Math.max(r.p, 1 - r.p) * 100) };
  };
  for (const d of DAYS) {
    const l = Object.values(picks).filter((p) => p.pub && p.f && p.res !== 'pending' && matches[p.id] && matches[p.id].w != null && day(matches[p.id].at) === d);
    if (!l.length) continue;
    let real = 0, withT = 0, without = 0, mkt = 0, nm = 0, diff = 0, diffReal = 0, diffNo = 0;
    const band = { a: [0, 0], b: [0, 0] };
    for (const p of l) {
      const m = matches[p.id];
      const a = pickOf(model, p, m);
      const b = pickOf(noStake, p, m);
      if (p.res === 'hit') real++;
      if (a.fav === m.w) withT++;
      if (b.fav === m.w) without++;
      const pm = marketProb(p.x?.oA, p.x?.oB);
      if (pm != null && pm !== 0.5) { nm++; if ((pm > 0.5 ? m.a : m.b) === m.w) mkt++; }
      if (a.fav !== b.fav) { diff++; if (a.fav === m.w) diffReal++; if (b.fav === m.w) diffNo++; }
      if (b.c >= 60) { band.b[1]++; if (b.fav === m.w) band.b[0]++; }
      if (a.c >= 60) { band.a[1]++; if (a.fav === m.w) band.a[0]++; }
    }
    out(`  ${d}: real ${pct(real, l.length)} · con tabla ${pct(withT, l.length)} · sin tabla ${pct(without, l.length)} · favorito de la casa ${pct(mkt, nm)}`);
    out(`     picks distintos por la tabla: ${diff} (con tabla acertó ${diffReal}, sin tabla ${diffNo}) · 60%+ con tabla ${pct(...band.a)} · 60%+ sin tabla ${pct(...band.b)}`);
  }
}

// Hoy por nivel de torneo y por hora: ¿es el modelo o son partidos más difíciles?
out('\n== Hoy vs. días anteriores por nivel de liga ==');
{
  const lvl = (n) => { const x = Number((n.match(/League (\d+)/) || [])[1]); return x < 400 ? '<400' : x < 700 ? '400-699' : '700+'; };
  for (const d of DAYS) {
    const l = Object.values(picks).filter((p) => p.pub && p.res !== 'pending' && matches[p.id] && day(matches[p.id].at) === d);
    if (!l.length) continue;
    const g = {};
    for (const p of l) { const k = lvl(tournaments[matches[p.id].t]?.n || ''); (g[k] = g[k] || []).push(p); }
    out(`  ${d}: ` + Object.entries(g).map(([k, v]) => `${k} ${pct(v.filter((p) => p.res === 'hit').length, v.length)}`).join(' · '));
  }
}

// Picks de hoy contra la casa (la regla 'mkt' debería evitarlos): por qué.
out('\n== Hoy: picks contra el favorito de la casa ==');
{
  const today = day(new Date().toISOString());
  for (const p of Object.values(picks)) {
    const m = matches[p.id];
    if (!m || !p.pub || p.res === 'pending' || day(m.at) !== today) continue;
    const pm = marketProb(p.x?.oA, p.x?.oB);
    const pmEnd = marketProb(m.oa, m.ob);
    if (pm == null || (pm > 0.5) === (p.fav === m.a)) continue;
    out(`  ${m.at.slice(11, 16)} ${players[p.fav]?.n} ${p.c}% · regla ${p.x?.rule || '-'} · casa al pick ${(pm * 100).toFixed(0)}% A · casa final ${pmEnd == null ? '-' : (pmEnd * 100).toFixed(0) + '% A'} · revisado ${p.upd?.slice(11, 16) || '-'} · ${p.res}`);
  }
}

// Calibración: confianza mostrada vs. acierto real (todos los picks v2 jugados)
// y por semana (antes / después del 19-oct).
out('\n== Calibración de la confianza ==');
{
  const v2 = Object.values(picks).filter((p) => p.pub && p.src === 'v2' && p.res !== 'pending' && matches[p.id]);
  for (const [lab, fn] of [['todo', () => true], ['hasta el 18-oct', (p) => day(matches[p.id].at) <= '2026-10-18'], ['desde el 19-oct', (p) => day(matches[p.id].at) >= '2026-10-19']]) {
    const l = v2.filter(fn);
    const parts = [];
    for (const [lo, hi] of [[50, 52], [53, 54], [55, 56], [57, 59], [60, 62], [63, 64], [65, 67], [68, 70], [71, 100]]) {
      const x = l.filter((p) => p.c >= lo && p.c <= hi);
      parts.push(`${lo}-${hi}: ${pct(x.filter((p) => p.res === 'hit').length, x.length)}`);
    }
    out(`  ${lab} (${l.length}): ${parts.join(' · ')}`);
  }
  const byDay = new Map();
  for (const p of v2) { const d = day(matches[p.id].at); (byDay.get(d) || byDay.set(d, []).get(d)).push(p); }
  for (const [d, l] of [...byDay.entries()].sort()) {
    const odds = l.filter((p) => p.x?.oA && p.x?.oB);
    const mk = odds.filter((p) => { const pm = marketProb(p.x.oA, p.x.oB); return pm != null && pm !== 0.5; });
    const mh = mk.filter((p) => (marketProb(p.x.oA, p.x.oB) > 0.5 ? matches[p.id].a : matches[p.id].b) === matches[p.id].w).length;
    const r = l.filter((p) => p.x?.rule === 'mkt');
    out(`  ${d}: picks ${pct(l.filter((p) => p.res === 'hit').length, l.length)} · conf media ${(l.reduce((a, p) => a + p.c, 0) / l.length).toFixed(1)} · con cuota ${odds.length} · casa ${pct(mh, mk.length)} · regla casa ${r.length} · cambiados ${l.filter((p) => p.chg).length}`);
  }
}

// Simulación de la calibración (misma fórmula que calibrationK en update.js).
out('\n== Simulación: confianza calibrada ==');
{
  const v2 = Object.values(picks).filter((p) => p.pub && p.src === 'v2' && p.res !== 'pending' && matches[p.id] && day(matches[p.id].at) >= '2026-10-17');
  const base = v2.filter((p) => p.x?.rule !== 'mkt');
  const hit = base.filter((p) => p.res === 'hit').length / base.length;
  const conf = base.reduce((s, p) => s + (p.cr ?? p.c), 0) / base.length / 100;
  const w = base.length / (base.length + 100);
  const K = Math.round(Math.max(0.5, Math.min(1, 1 + ((hit - 0.5) / (conf - 0.5) - 1) * w)) * 1000) / 1000;
  out(`  factor K = ${K} (acierto ${(hit * 100).toFixed(1)}% · confianza media ${(conf * 100).toFixed(1)}% · ${base.length} picks)`);
  const cal = (p) => (p.x?.rule === 'mkt' ? p.c : Math.round(50 + ((p.cr ?? p.c) - 50) * K));
  for (const [lab, fn] of [['antes', (p) => p.cr ?? p.c], ['calibrada', cal]]) {
    const exp = v2.reduce((s, p) => s + fn(p), 0) / v2.length;
    const real = (v2.filter((p) => p.res === 'hit').length / v2.length) * 100;
    const parts = [];
    for (const [lo, hi] of [[50, 54], [55, 59], [60, 64], [65, 100]]) {
      const x = v2.filter((p) => fn(p) >= lo && fn(p) <= hi);
      parts.push(`${lo}-${hi}: ${pct(x.filter((p) => p.res === 'hit').length, x.length)} (muestra ${x.length ? (x.reduce((s, p) => s + fn(p), 0) / x.length).toFixed(1) : '—'})`);
    }
    const prem = v2.filter((p) => fn(p) >= 60);
    out(`  ${lab}: promete ${exp.toFixed(1)}% · real ${real.toFixed(1)}% · Premium (60%+) ${prem.length} picks (${((prem.length / v2.length) * 100).toFixed(0)}%) acierta ${pct(prem.filter((p) => p.res === 'hit').length, prem.length)}`);
    out(`     ${parts.join(' · ')}`);
    const dst = v2.filter((p) => fn(p) >= 60 && p.o > 1.6 && p.o <= 2.5);
    out(`     candidatos a destacado (60%+, cuota 1.60-2.50): ${pct(dst.filter((p) => p.res === 'hit').length, dst.length)}`);
  }
}

// ¿Ya corre la calibración? Picks pendientes con confianza sin calibrar (cr).
out('\n== Picks pendientes con calibración ==');
{
  const pend = Object.values(picks).filter((p) => p.res === 'pending' && p.pub);
  const w = pend.filter((p) => p.cr != null);
  for (const p of Object.values(picks)) {
    const m = matches[p.id];
    if (!m || !/pavelka/i.test(`${players[m.a]?.n} ${players[m.b]?.n}`) || m.at < '2026-10-22') continue;
    out(`  BUSCAR ${p.id} ${m.at} ${players[m.a]?.n} vs ${players[m.b]?.n} · pick ${players[p.fav]?.n} ${p.c}% o=${p.o} dst=${p.dst} res=${p.res} upd=${p.upd} chg=${p.chg || 0} x.o=${p.x?.oA}/${p.x?.oB} d=${p.x?.dA}/${p.x?.dB}`);
  }
  const ft = pend.filter((p) => p.dst && matches[p.id]).sort((x, y) => (matches[x.id].at < matches[y.id].at ? -1 : 1));
  out(`  destacados ahora: ${ft.length} · ${ft.map((p) => `${matches[p.id].at.slice(11, 16)}Z ${players[p.fav]?.n} ${p.c}% @${p.o}`).join(' | ')}`);
  out(`  pendientes ${pend.length} · con cr ${w.length} · Premium (60%+) ${w.filter((p) => p.c >= 60).length} · ejemplos ${w.slice(0, 8).map((p) => `${p.cr}→${p.c}`).join(' ')}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n') + '\n');
console.log('Diagnóstico listo (cifrado aparte).');
