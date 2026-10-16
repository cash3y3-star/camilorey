// ============================================================
// CZECH IA AGENTS — modelo de machine learning (regresión logística) que
// decide el pick completo (favorito + confianza) una vez que tiene
// muestra suficiente.
//
// A diferencia de lib/confidence.js (pesos fijos, que solo se ajustan
// a mano cuando alguien revisa las estadísticas), este modelo se
// reentrena SOLO, en cada corrida de sync.js, a partir de los picks ya
// resueltos (hit/miss) que hay en ese momento en la base — sin
// intervención manual. Usa las mismas señales que ya calcula
// computeConfidence (rating, racha, H2H, alternancia, cuota de
// mercado, forma del día) como features, y aprende el peso óptimo de
// cada una por descenso de gradiente sobre una regresión logística
// simple, con regularización L2 para no sobreajustar con las pocas
// centenas de muestras que hay.
//
// Hasta 2026-07-30 este modelo SOLO decidía la sección Exclusivo — el
// resto de los picks (favorito, confianza publicada) seguía la fórmula
// de pesos fijos de lib/confidence.js sin importar cuánto se
// reentrenara. Eso hacía que reentrenar el modelo nunca pudiera mover
// el % de acierto general (pedido del dueño del sitio: "el
// reentrenamiento no sube nada de % de acierto"). Ahora, una vez que
// hay >= MIN_TRAINING_SAMPLES picks resueltos (ver
// scripts/sync.js:generatePick), este modelo decide directamente
// predicted_winner_id y confidence de TODOS los picks nuevos; por
// debajo de esa muestra, sync.js sigue cayendo a lib/confidence.js
// exactamente como antes.
// ============================================================

const FEATURE_KEYS = ['ratingScore', 'streakScore', 'h2hScore', 'altScore', 'oddsScore', 'todayFormScore'];

// Con menos muestras que esto, no hay señal suficiente para confiar en
// los pesos aprendidos — el llamador debe caer al criterio viejo
// (fórmula de lib/confidence.js) mientras tanto.
const MIN_TRAINING_SAMPLES = 40;

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// rows: [{ ratingScore, streakScore, h2hScore, altScore, oddsScore,
// todayFormScore, hit }] — los scores A-relativos tal cual los guarda
// picks.factors (positivo = a favor del jugador A del partido), label
// hit = jugador A ganó de verdad. Ver trainPredictionModel en
// scripts/sync.js.
//
// OJO: weights/grad se arman recorriendo FEATURE_KEYS en vez de un
// objeto literal a mano — un literal viejo se quedó sin "oddsScore"
// cuando se agregó esa feature, dejando weights.oddsScore en
// `undefined`. Como z se arma sumando weights[k]*row[k] para las 5-6
// features de una, ese único `undefined * número = NaN` contaminaba la
// suma COMPLETA de esa fila, y como grad.bias/grad[k] se acumulan con
// += sobre TODAS las filas, un NaN en cualquier fila dejaba el
// gradiente entero en NaN — el modelo entrenaba a "todo NaN" en
// silencio desde la época 0, sin error visible en ningún lado, y
// predictProbability devolvía NaN para cualquier pick (NaN >= umbral
// es siempre false, así que el filtro de Exclusivo por ML venía
// rechazando todo desde que la muestra pasó de MIN_TRAINING_SAMPLES).
// Recorrer FEATURE_KEYS asegura que agregar una feature nueva nunca
// vuelva a dejar una clave sin inicializar.
function trainLogisticRegression(rows, { epochs = 400, learningRate = 0.2, l2 = 0.02 } = {}) {
  const weights = { bias: 0 };
  for (const k of FEATURE_KEYS) weights[k] = 0;
  const n = rows.length;
  if (n === 0) return weights;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = { bias: 0 };
    for (const k of FEATURE_KEYS) grad[k] = 0;
    for (const row of rows) {
      const z = weights.bias + FEATURE_KEYS.reduce((sum, k) => sum + weights[k] * (row[k] || 0), 0);
      const err = sigmoid(z) - (row.hit ? 1 : 0);
      grad.bias += err;
      for (const k of FEATURE_KEYS) grad[k] += err * (row[k] || 0);
    }
    weights.bias -= learningRate * (grad.bias / n);
    for (const k of FEATURE_KEYS) {
      weights[k] -= learningRate * (grad[k] / n + l2 * weights[k]);
    }
  }
  return weights;
}

function predictProbability(weights, features) {
  const z = weights.bias + FEATURE_KEYS.reduce((sum, k) => sum + (weights[k] || 0) * (features[k] || 0), 0);
  return sigmoid(z);
}

// El umbral de Exclusivo NO puede ser un número fijo tipo "75% de
// probabilidad": el sistema históricamente acierta ~54% con señal
// débil (ver comentarios de lib/confidence.js), así que una regresión
// logística bien calibrada casi nunca va a estimar 75% para nadie —
// un umbral fijo alto deja Exclusivo sin picks para siempre, no
// porque el modelo esté "roto" sino porque está siendo honesto sobre
// cuánta certeza hay de verdad.
//
// En vez de eso, el umbral se calcula RELATIVO a lo que el propio
// modelo predijo en su set de entrenamiento: el percentil 85 de esas
// probabilidades (o sea, "el modelo está más seguro de este pick que
// del 85% de los picks históricos"). Así Exclusivo sigue siendo
// selecto (top ~15%) sin depender de que la señal alcance un número
// absoluto arbitrario. minFloor evita marcar como "exclusivo" algo
// que ni siquiera al modelo le gusta más que un volado.
//
// rows son A-relativas sin firmar (predictProbability(weights, r) da
// P(gana el jugador A de ESE partido histórico), no "P(gana quien
// haya sido favorito en su momento") — por eso el percentil se calcula
// sobre max(p, 1-p): "qué tan seguro estaría el modelo de HOY de su
// propio pick para ese partido", que es exactamente la cantidad que
// se compara contra el umbral en generatePick (mlProbability, ya
// orientada al favorito recién decidido).
function computeExclusiveThreshold(weights, rows, { percentile = 0.85, minFloor = 0.55 } = {}) {
  if (!rows.length) return minFloor;
  const selfConfidence = rows
    .map((r) => {
      const p = predictProbability(weights, r);
      return Math.max(p, 1 - p);
    })
    .sort((a, b) => a - b);
  const idx = Math.min(selfConfidence.length - 1, Math.floor(selfConfidence.length * percentile));
  return Math.max(minFloor, selfConfidence[idx]);
}

module.exports = {
  trainLogisticRegression,
  predictProbability,
  computeExclusiveThreshold,
  MIN_TRAINING_SAMPLES,
  FEATURE_KEYS
};
