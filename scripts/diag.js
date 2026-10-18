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
const { featuresOf, train, fitMarket, predict, marketProb } = require('./lib/model-v2');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'diag-out');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const matches = read('matches.json');
const picks = read('picks.json');
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

const fin = Object.values(matches)
  .filter((m) => m.st === 'f' && m.w != null)
  .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id - y.id));
const model = train(fin, ctx);
fitMarket(model, fin.filter((m) => m.oa && m.ob), ctx);

const lines = [];
const out = (s = '') => lines.push(s);
const pct = (h, n) => (n ? `${((h / n) * 100).toFixed(1)}% (${h}/${n})` : '—');

const DAYS = [...new Set(Object.values(picks).filter((p) => matches[p.id]).map((p) => day(matches[p.id].at)))].sort().slice(-4);
out(`Modelo: ${model.trained} partidos · pesos ${JSON.stringify(model.weights)} · mercado ${JSON.stringify(model.market)}`);
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

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n') + '\n');
console.log('Diagnóstico listo (cifrado aparte).');
