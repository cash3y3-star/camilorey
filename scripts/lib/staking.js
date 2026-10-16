// ============================================================
// CZECH IA AGENTS — apuesta en pesos colombianos (staking)
// El banco arranca en $2.000.000 (ver migración del banco en pesos).
// El sitio no trae cuotas reales para el tamaño de la apuesta en sí,
// así que esto es una convención nuestra, no una cuota de mercado.
// Entre más confianza tiene un pick, más arriesga — en línea recta
// entre un mínimo y un máximo, igual de transparente que
// lib/confidence.js.
// ============================================================

const MIN_CONFIDENCE = 50; // cota mínima que devuelve computeConfidence
const MAX_CONFIDENCE = 92; // cota máxima que devuelve computeConfidence
const MIN_STAKE = 100000;
const MAX_STAKE = 250000;

function computeStake(confidence) {
  const clamped = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, confidence));
  const t = (clamped - MIN_CONFIDENCE) / (MAX_CONFIDENCE - MIN_CONFIDENCE);
  const stake = MIN_STAKE + t * (MAX_STAKE - MIN_STAKE);
  return Math.round(stake / 1000) * 1000;
}

module.exports = { computeStake };
