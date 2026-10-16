// ============================================================
// CZECH IA AGENTS — fórmula de confianza (transparente, no "caja negra")
// Esto NO es un modelo de machine learning entrenado; es un
// puntaje ponderado a partir de 5 factores reales. La idea es
// medir su acierto real con el tiempo (ver bankroll_log) y
// ajustar los pesos si hace falta.
// ============================================================

/**
 * @param {Object} p
 * @param {number} p.ratingDiff   rating jugador A - rating jugador B
 * @param {number} p.streakA      victorias consecutivas recientes de A (positivo) o derrotas (negativo)
 * @param {number} p.streakB      idem para B
 * @param {number} p.h2hWinsA     victorias de A en los últimos enfrentamientos directos
 * @param {number} p.h2hTotal     total de enfrentamientos directos considerados
 * @param {boolean|null} p.h2hCurrentStreakIsA  true si A tiene la racha activa dentro del H2H (ganó el/los últimos cruces), false si es de B, null si no hay historial
 * @param {number} p.h2hCurrentStreakLength     cuántos cruces seguidos lleva ganando quien tiene la racha activa
 * @param {number|null} p.h2hTypicalRunLength   cuánto duran EN PROMEDIO las rachas ya completadas de esta pareja antes de cortarse (null si no hay ninguna completada todavía)
 * @param {boolean} p.h2hIsPerfectAlternation   true si en NINGÚN cruce de la ventana observada (con al menos 3 cortes confirmados) el mismo jugador repitió victoria
 * @param {number|null} p.oddsImpliedProbA   probabilidad implícita de que gane A según la cuota real de Rushbet (ya sin margen de casa), o null si no cruzamos ese partido con su feed
 * @param {number} p.todayFormWinsA    partidos ganados por A hoy, en este mismo torneo, antes de este partido
 * @param {number} p.todayFormLossesA  partidos perdidos por A hoy, en este mismo torneo, antes de este partido
 * @param {number} p.todayFormWinsB    idem para B
 * @param {number} p.todayFormLossesB  idem para B
 */
function computeConfidence({
  ratingDiff,
  streakA,
  streakB,
  h2hWinsA,
  h2hTotal,
  h2hCurrentStreakIsA = null,
  h2hCurrentStreakLength = 0,
  h2hTypicalRunLength = null,
  h2hIsPerfectAlternation = false,
  oddsImpliedProbA = null,
  todayFormWinsA = 0,
  todayFormLossesA = 0,
  todayFormWinsB = 0,
  todayFormLossesB = 0
}) {
  // 1) Diferencia de rating normalizada (-1 a 1), 200 pts de diff = tope
  const ratingScore = Math.max(-1, Math.min(1, ratingDiff / 200));

  // 2) Racha: comparamos impulso reciente de cada jugador
  const streakScore = Math.max(-1, Math.min(1, (streakA - streakB) / 6));

  // 3) H2H directo, solo si hay historial suficiente (mínimo 2 duelos)
  const h2hScore = h2hTotal >= 2 ? (h2hWinsA / h2hTotal) * 2 - 1 : 0;

  // 4) Alternancia dentro del H2H — agregado el 2026-07-14 a partir de
  // capturas reales donde el resultado alterna, y refinado el mismo
  // día porque la alternancia NO es siempre partido a partido: hay
  // parejas donde un jugador gana 2 (o más) seguidos y RECIÉN ahí
  // corta el otro. El h2hScore de arriba promedia TODO el historial y
  // no ve ni una cosa ni la otra: con W,L,W,L el ratio da ~50/50 (sin
  // señal) aunque el orden sí sea predecible.
  //
  // En vez de "el último perdió, entonces gana el otro" a secas,
  // comparamos la racha ACTIVA de esta pareja (h2hCurrentStreakLength)
  // contra lo que h2hTypicalRunLength dice que dura normalmente antes
  // de cortarse:
  //   - si la racha activa ya alcanzó/superó lo típico -> "ya toca
  //     cortar", favorece al otro jugador.
  //   - si la racha activa todavía es corta para lo típico de esa
  //     pareja -> favorece que siga ganando el mismo.
  // La magnitud crece con qué tan cerca/lejos está la racha activa de
  // lo típico, así que una pareja de alternancia estricta (typical=1)
  // sigue comportándose como el modelo original (corta siempre),
  // mientras que una pareja que gana de a 2 (typical=2) predice
  // continuidad en el primer partido de la racha y corte recién en el
  // segundo.
  let altScore = 0;
  if (h2hCurrentStreakIsA !== null && h2hTypicalRunLength) {
    const dueForCut = h2hCurrentStreakLength >= h2hTypicalRunLength;
    const magnitude = Math.min(1, h2hCurrentStreakLength / h2hTypicalRunLength);
    const towardA = h2hCurrentStreakIsA ? 1 : -1; // signo si la racha activa la tiene A
    altScore = dueForCut ? -towardA * magnitude : towardA * magnitude;
  }

  // 5) Cuota real de Rushbet, agregado 2026-07-19: ya la pedíamos para
  // cada partido (sync.js la usa para el filtro de Exclusivo) pero
  // nunca entraba como señal de predicción, a pesar de ser en teoría
  // la más fuerte de todas — el mercado ya incorpora lesiones, forma,
  // todo lo que rating/racha/H2H no ven. La convertimos de cuota a
  // probabilidad implícita SIN el margen de la casa (devig de un
  // mercado a 2 vías: cada cuota da una probabilidad "cruda" que suma
  // más de 100% por el margen, normalizamos para que sume exactamente
  // 100%). No todos los partidos cruzan con el feed de Rushbet — ahí
  // oddsImpliedProbA llega null y este factor no aporta ni resta nada
  // (oddsScore en 0, su peso se devuelve a rating).
  const hasOdds = oddsImpliedProbA != null;
  const oddsScore = hasOdds ? oddsImpliedProbA * 2 - 1 : 0;

  // 6) Forma del día DENTRO del mismo torneo, agregado 2026-07-30 a
  // pedido explícito ("que tome en cuenta los primeros juegos de los
  // jugadores, no lanzar por lanzar, ahorita cayó en mala racha") — la
  // Liga Pro Checa juega varios partidos por jugador el mismo día
  // dentro de un mismo torneo, y esto mide cómo viene ESE jugador HOY,
  // en ESTE torneo, antes de este partido puntual.
  //
  // A propósito NO es lo mismo que streakScore de arriba: streakScore
  // sale de getRecentStreak, que mira los últimos 5 partidos
  // CRUZANDO torneos/semanas — y, según el ajuste de 2026-07-13 con
  // n=292, esa versión mostró CERO señal (0.171 en aciertos vs 0.168
  // en fallos, prácticamente idéntico), por eso su peso ya está casi
  // en el piso. La hipótesis acá es que mezclar partidos de días/
  // torneos distintos diluye cualquier efecto real de fatiga/racha
  // del día — un jugador que ya perdió 2 partidos HOY en este mismo
  // torneo puede cargar una señal que el promedio de "últimos 5, sea
  // cuando sea" no ve.
  //
  // Igual que streakA/streakB, se guarda como NETO (wins-losses), no
  // como ratio: 0 significa indistintamente "parejo hoy" o "todavía no
  // jugó nada hoy en este torneo" — mismo criterio ambiguo que ya
  // acepta streakScore, no hace falta resolverlo distinto acá.
  const todayFormNetA = todayFormWinsA - todayFormLossesA;
  const todayFormNetB = todayFormWinsB - todayFormLossesB;
  const hasTodayForm = todayFormWinsA + todayFormLossesA > 0 || todayFormWinsB + todayFormLossesB > 0;
  const todayFormScore = hasTodayForm ? Math.max(-1, Math.min(1, (todayFormNetA - todayFormNetB) / 4)) : 0;

  // Reajustado 2026-07-13 con n=292 picks resueltos (vía la pestaña
  // Modelo / /api/model-stats) — segunda medición desde el ajuste
  // anterior (n=108, 2026-07-12):
  //   - streakScore: en la primera medición ya no mostraba señal a
  //     favor; con el triple de datos SIGUE sin mostrarla (promedio en
  //     aciertos 0.171 vs fallos 0.168 — prácticamente idéntico). Dos
  //     mediciones independientes coincidiendo en "sin señal" ya no es
  //     ruido de muestra chica, es la racha reciente diciendo que no
  //     predice nada en esta liga — se le baja el peso casi a cero en
  //     vez de solo "bajarlo un poco".
  //   - h2hScore: antes salía en 0.000 SIEMPRE (casi nunca había
  //     h2hTotal >= 2). Con el backfill de historial de jugadores que
  //     se agregó esta sesión, ahora sí hay suficientes cruces
  //     repetidos para medirlo, y muestra señal (0.039 en aciertos vs
  //     0.004 en fallos) — se mantiene su peso, no se sube más todavía
  //     porque la muestra donde SÍ aplica (h2hTotal >= 2) sigue siendo
  //     chica.
  //   - ratingScore: sigue siendo el único factor con señal clara y
  //     consistente en las dos mediciones (aciertos > fallos) — se le
  //     sube el peso para compensar lo que se le quitó a streak.
  // Con todo esto, el acierto general (54.4%, IC 95% 48.7%-60.1%)
  // TODAVÍA no es distinguible de una moneda al aire — este ajuste no
  // promete que ahora sí lo sea, solo saca peso muerto de un factor
  // que dos mediciones seguidas confirman que no aporta.
  // alt se financia bajándole a rating (0.85 → 0.70) en vez de a
  // streak o h2h, que ya están en su piso por evidencia medida.
  //
  // Cuando la alternancia es PERFECTA y confirmada (h2hIsPerfectAlternation,
  // ver getH2H en sync.js) le damos bastante más peso — es la versión
  // más confiable del patrón, la mayoría no la sigue partido a partido
  // como para explotarla, y a nosotros sí nos favorece verla clara.
  const altWeight = h2hIsPerfectAlternation ? 0.3 : 0.15;
  let ratingWeight = h2hIsPerfectAlternation ? 0.55 : 0.7;
  // Cuando hay cuota real, le cedemos peso propio (0.35) sacado
  // enteramente de rating — es la señal más fuerte, así que le toca la
  // porción más grande, y rating es de donde más sobra (sigue siendo
  // el único otro factor con señal medida de forma consistente). Los
  // pesos siguen sumando 1 en las 4 combinaciones posibles (con/sin
  // cuota × con/sin alternancia perfecta).
  const oddsWeight = hasOdds ? 0.35 : 0;
  if (hasOdds) ratingWeight -= oddsWeight;
  // todayForm se financia de rating con el mismo mecanismo que odds —
  // agregado 2026-07-30, arranca en 0.08 (menor que el piso de h2h,
  // 0.10) porque a diferencia de alt/odds todavía no hay NINGUNA
  // medición real de si esta señal aporta (recién se empieza a guardar
  // con este cambio). Revisar factorAvg.todayFormScore en la pestaña
  // Modelo apenas haya muestra y subir/bajar como se hizo con
  // streak/h2h/rating en el ajuste de 2026-07-13.
  const todayFormWeight = hasTodayForm ? 0.08 : 0;
  if (hasTodayForm) ratingWeight -= todayFormWeight;
  const WEIGHTS = { rating: ratingWeight, streak: 0.05, h2h: 0.1, alt: altWeight, odds: oddsWeight, todayForm: todayFormWeight };

  const raw =
    ratingScore * WEIGHTS.rating +
    streakScore * WEIGHTS.streak +
    h2hScore * WEIGHTS.h2h +
    altScore * WEIGHTS.alt +
    oddsScore * WEIGHTS.odds +
    todayFormScore * WEIGHTS.todayForm; // rango aprox -1 a 1

  // Mapeamos a 50-90% (nunca prometemos 100%, nunca bajamos de 50%
  // porque por debajo de eso ya no es "nuestro pick")
  const confidence = Math.round(70 + raw * 20);

  return {
    confidence: Math.max(50, Math.min(92, confidence)),
    factors: { ratingScore, streakScore, h2hScore, altScore, oddsScore, todayFormScore, weights: WEIGHTS }
  };
}

module.exports = { computeConfidence };
