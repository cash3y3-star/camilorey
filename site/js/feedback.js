// ============================================================
// Respuesta táctil: vibración corta y un "tic" suave al tocar pestañas.
// El sonido se genera con Web Audio (sin archivos). Se puede apagar en
// Perfil → Sonido y vibración (localStorage cr_fx). En iPhone la web no
// puede vibrar: solo suena.
// ============================================================

let ctx = null;

export function fxEnabled() {
  try {
    return JSON.parse(localStorage.getItem('cr_fx') ?? 'true') !== false;
  } catch {
    return true;
  }
}

export function setFx(on) {
  try {
    localStorage.setItem('cr_fx', JSON.stringify(Boolean(on)));
  } catch {}
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Un tono corto con caída rápida (suena como un "tic" suave).
function blip(freq, start, dur = 0.05, vol = 0.07) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

// Tocar una pestaña.
export function tapFx() {
  if (!fxEnabled()) return;
  vibrate(10);
  blip(880, 0);
}

// Seguir un pick (dos notas hacia arriba).
export function followFx() {
  if (!fxEnabled()) return;
  vibrate([12, 40, 12]);
  blip(660, 0, 0.06);
  blip(990, 0.07, 0.08);
}
