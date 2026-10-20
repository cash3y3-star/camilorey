// ============================================================
// Respuesta táctil: vibración corta y un "tic" al tocar botones y enlaces.
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

// El navegador arranca el audio "dormido" hasta el primer toque: se
// despierta en el primer pointerdown para que el primer tic ya suene.
addEventListener('pointerdown', () => fxEnabled() && audio(), { capture: true, passive: true });

// Un tono corto con caída rápida (suena como un "tic").
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

// Tocar un botón o enlace: un clic seco y audible en el parlante del celular
// (antes 0.07 de volumen, casi no se oía). Si dos llamadas llegan juntas en
// el mismo toque, suena una sola vez.
let lastTap = 0;
export function tapFx() {
  if (!fxEnabled() || performance.now() - lastTap < 90) return;
  lastTap = performance.now();
  vibrate(12);
  blip(1200, 0, 0.035, 0.22);
  blip(700, 0.004, 0.05, 0.16);
}

// Chat: enviar un mensaje ("swoosh" corto hacia arriba).
export function sendFx() {
  if (!fxEnabled()) return;
  vibrate(8);
  blip(520, 0, 0.04, 0.05);
  blip(780, 0.04, 0.05, 0.05);
}

// Chat: llega un mensaje nuevo (campanita de dos notas, como una notificación).
export function messageFx() {
  if (!fxEnabled()) return;
  vibrate([25, 60, 25]);
  blip(1046, 0, 0.12, 0.08);
  blip(1318, 0.13, 0.18, 0.08);
}

// Chat: se cerró la conversación (dos notas hacia abajo).
export function endFx() {
  if (!fxEnabled()) return;
  vibrate([15, 50, 30]);
  blip(784, 0, 0.09, 0.06);
  blip(523, 0.1, 0.16, 0.06);
}

// Seguir un pick (dos notas hacia arriba).
export function followFx() {
  if (!fxEnabled()) return;
  vibrate([12, 40, 12]);
  blip(660, 0, 0.06);
  blip(990, 0.07, 0.08);
}
