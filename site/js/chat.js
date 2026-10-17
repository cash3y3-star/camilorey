// ============================================================
// Soporte en vivo: botón flotante + chat.
//
// - Responde una IA (Google Gemini, plan gratis) con lo que sabe del sitio.
// - "Hablar con una persona": la conversación le llega al admin (Panel
//   admin y notificación al celular) y su respuesta aparece aquí en vivo.
// - Con sesión, la conversación se guarda en Firestore (chats/{uid});
//   sin sesión, solo en este navegador.
// ============================================================

import { icon } from './icons.js?v=__V__';
import { GEMINI_KEY, GEMINI_MODELS, SUPPORT_EMAIL } from './config.js?v=__V__';

const LOCAL_KEY = 'cr_chat';
const LIMIT_KEY = 'cr_chat_n';
const MAX_PER_DAY = 30; // mensajes a la IA por navegador y día (cuida el cupo gratis)
const MAX_LEN = 600;

let opts = null; // { FB, getUser, isPremium, isAdmin, context, openLogin, openAdmin, onTap }
let msgs = [];
let human = false;
let open = false;
let mini = false; // ventana minimizada (solo la barra del título)
let busy = false;
let unsub = null;
let unread = false;
let watchedUid = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const readLocal = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const writeLocal = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const aiReady = () => GEMINI_KEY && !GEMINI_KEY.startsWith('__');
const newId = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

// Texto de la IA → HTML seguro (negritas y saltos de línea).
export const fmt = (t) =>
  esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');

export function initChat(o) {
  opts = o;
  const fab = document.createElement('button');
  fab.id = 'chat-fab';
  fab.className = 'chat-fab';
  fab.type = 'button';
  fab.innerHTML = `<span class="live-dot"></span>${icon('chat')}<span>SOPORTE EN VIVO</span><i class="chat-dot" hidden></i>`;
  fab.addEventListener('click', () => {
    opts.onTap?.();
    if (opts.isAdmin()) return opts.openAdmin(); // el admin responde desde su panel
    toggle(true);
  });
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.className = 'chat-panel';
  panel.hidden = true;
  document.body.appendChild(panel);
  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.name === 'msg') {
      e.preventDefault();
      panel.querySelector('form')?.requestSubmit();
    }
  });
  syncUser();
}

// Llamar cuando cambia la sesión.
export function syncUser() {
  if (!opts) return;
  const u = opts.getUser();
  const uid = u?.uid || null;
  if (uid === watchedUid) return;
  watchedUid = uid;
  unsub?.();
  unsub = null;
  if (!uid) {
    const local = readLocal(LOCAL_KEY, { msgs: [], human: false });
    msgs = local.msgs || [];
    human = Boolean(local.human);
    setUnread(false);
    if (open) render();
    return;
  }
  opts.FB.watchMyChat((doc) => {
    msgs = doc?.msgs || [];
    human = Boolean(doc?.human);
    // Minimizada cuenta como "no vista": queda el punto hasta abrirla.
    setUnread(Boolean(doc?.unreadUser) && (!open || mini));
    if (open) {
      render();
      if (doc?.unreadUser && !mini) opts.FB.markMyChatRead();
    }
  }).then((fn) => (unsub = fn));
}

function setUnread(v) {
  unread = v;
  const dot = document.querySelector('#chat-fab .chat-dot');
  if (dot) dot.hidden = !v;
}

function setMini(v) {
  mini = v;
  document.getElementById('chat-panel').classList.toggle('min', v);
  render();
  if (!v) {
    setUnread(false);
    if (opts.getUser()) opts.FB.markMyChatRead();
    setTimeout(() => document.querySelector('#chat-panel textarea')?.focus(), 50);
  }
}

function toggle(v) {
  open = v;
  mini = false;
  const panel = document.getElementById('chat-panel');
  panel.classList.remove('min');
  panel.hidden = !v;
  document.getElementById('chat-fab').hidden = v;
  if (v) {
    render();
    setUnread(false);
    if (opts.getUser()) opts.FB.markMyChatRead();
    setTimeout(() => panel.querySelector('textarea')?.focus(), 50);
  }
}

function render() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  const u = opts.getUser();
  // El chat en vivo es solo para cuentas registradas.
  if (!u) {
    panel.innerHTML = `
    <div class="chat-head">
      <div class="chat-ava">${icon('chat')}</div>
      <div class="chat-title"><b>Soporte en vivo</b><small>Asistente con IA y atención personal</small></div>
      <button type="button" class="chat-x" data-chat-close aria-label="Cerrar">${icon('x')}</button>
    </div>
    <div class="chat-body chat-gate">
      <div class="chat-gate-ic">${icon('user')}</div>
      <b>Crea tu cuenta para usar el chat en vivo</b>
      <p>Es gratis y toma un minuto (con Google o con tu correo). Así guardamos tu conversación y Camilo puede responderte aquí mismo.</p>
      <a class="btn primary" href="#/registro" data-chat-go>Crear cuenta gratis</a>
      <a class="btn ghost" href="#/login" data-chat-go>Ya tengo cuenta: iniciar sesión</a>
    </div>`;
    return;
  }
  const name = (u?.displayName || '').split(' ')[0];
  const welcome = `Hola${name ? ` ${name}` : ''}. Soy el asistente de CamiloRey. Te ayudo con los picks, Premium, tu cuenta, el bankroll o las notificaciones. ¿En qué te ayudo?`;
  const list = [{ id: 'w', r: 'ai', t: welcome }, ...msgs];
  // Los mensajes del admin llevan su etiqueta de CEO (dorada, con corona).
  const who = {
    u: 'Tú',
    ai: `<span class="ceo-name">Asistente IA <span class="sup-badge">${icon('chat')}SOPORTE</span></span>`,
    admin: `<span class="ceo-name">Camilo Rey <span class="ceo-badge">${icon('crown')}CEO</span> <span class="ceo-role">Administrador</span></span>`
  };
  panel.innerHTML = `
    <div class="chat-head">
      <div class="chat-ava">${icon(human ? 'users' : 'bolt')}</div>
      <div class="chat-title"><b>Soporte en vivo</b><small>${human ? 'Te va a responder una persona' : aiReady() ? 'Asistente con IA · responde al instante' : 'Te responde una persona'}</small></div>
      <i class="chat-dot head-dot" ${unread ? '' : 'hidden'}></i>
      <button type="button" class="chat-x" data-chat-min aria-label="${mini ? 'Abrir' : 'Minimizar'}">${icon(mini ? 'up' : 'minus')}</button>
      <button type="button" class="chat-x" data-chat-close aria-label="Cerrar">${icon('x')}</button>
    </div>
    <div class="chat-body" id="chat-body">
      ${list.map((m) => `<div class="cmsg ${m.r === 'u' ? 'me' : m.r}"><small>${who[m.r] || ''}</small><div class="bub">${fmt(m.t)}</div></div>`).join('')}
      ${busy ? `<div class="cmsg ai"><small>${who.ai}</small><div class="bub typing"><i></i><i></i><i></i></div></div>` : ''}
      ${human ? `<div class="chat-note">${icon('info')} Le avisamos a Camilo. Te responde aquí mismo apenas pueda${u ? '' : ''}. También puedes escribir a <b>${esc(SUPPORT_EMAIL)}</b>.</div>` : ''}
    </div>
    <form class="chat-form" autocomplete="off">
      <textarea name="msg" rows="1" maxlength="${MAX_LEN}" placeholder="${human ? 'Escríbele a Camilo…' : 'Escribe tu pregunta…'}" ${busy ? 'disabled' : ''}></textarea>
      <button class="chat-send" type="submit" aria-label="Enviar" ${busy ? 'disabled' : ''}>${icon('send')}</button>
    </form>
    <div class="chat-actions">
      ${
        human
          ? aiReady()
            ? '<button type="button" class="textlink" data-chat-ai>Volver al asistente IA</button>'
            : ''
          : `<button type="button" class="textlink" data-chat-human>${icon('users')} Hablar con una persona</button>`
      }
    </div>`;
  const body = panel.querySelector('#chat-body');
  body.scrollTop = body.scrollHeight;
}

async function onPanelClick(e) {
  if (e.target.closest('[data-chat-go]')) return toggle(false); // va a registro / login
  const t = e.target.closest('button');
  // Minimizada: tocar la barra (fuera de la X) la vuelve a abrir.
  if (mini && !t?.hasAttribute('data-chat-close') && e.target.closest('.chat-head')) return setMini(false);
  if (!t) return;
  if (t.hasAttribute('data-chat-min')) return setMini(!mini);
  if (t.hasAttribute('data-chat-close')) return toggle(false);
  if (t.hasAttribute('data-chat-human')) return askHuman();
  if (t.hasAttribute('data-chat-ai')) {
    human = false;
    await save([], { human: false });
    render();
  }
}

async function askHuman() {
  if (!opts.getUser()) {
    // Para que el admin pueda responder, hace falta una cuenta.
    msgs = [...msgs, { id: newId(), r: 'ai', t: `Para hablar con una persona necesitas iniciar sesión (con Google o correo, es gratis): así Camilo puede responderte aquí mismo. También puedes escribir a ${SUPPORT_EMAIL}.`, at: new Date().toISOString() }];
    saveLocal();
    render();
    return setTimeout(() => {
      toggle(false);
      opts.openLogin();
    }, 1600);
  }
  human = true;
  const note = { id: newId(), r: 'ai', t: 'Listo, le aviso a Camilo. Cuéntale aquí qué necesitas y te responde en este mismo chat.', at: new Date().toISOString() };
  msgs = [...msgs, note];
  render();
  await save([note], { human: true, unreadAdmin: true });
}

async function onSubmit(e) {
  e.preventDefault();
  const ta = e.target.querySelector('textarea');
  const text = (ta?.value || '').trim().slice(0, MAX_LEN);
  if (!text || busy || !opts.getUser()) return;
  ta.value = '';
  const mine = { id: newId(), r: 'u', t: text, at: new Date().toISOString() };
  msgs = [...msgs, mine];
  if (human || !aiReady()) {
    if (!human && !opts.getUser()) {
      render();
      return askHuman();
    }
    human = true;
    render();
    return save([mine], { human: true, unreadAdmin: true });
  }
  // Límite diario por navegador (cupo gratis de la IA).
  const day = new Date().toISOString().slice(0, 10);
  const lim = readLocal(LIMIT_KEY, { d: day, n: 0 });
  if (lim.d !== day) Object.assign(lim, { d: day, n: 0 });
  if (lim.n >= MAX_PER_DAY) {
    const r = { id: newId(), r: 'ai', t: 'Llegaste al límite de preguntas al asistente por hoy. Si necesitas algo más, toca "Hablar con una persona".', at: new Date().toISOString() };
    msgs = [...msgs, r];
    render();
    return save([mine, r]);
  }
  lim.n++;
  writeLocal(LIMIT_KEY, lim);
  busy = true;
  render();
  let answer;
  try {
    answer = await askGemini(msgs);
  } catch (err) {
    answer = 'Ahora mismo el asistente no está disponible. Toca "Hablar con una persona" y Camilo te responde aquí.';
    console.warn('Chat IA:', err);
  }
  busy = false;
  const r = { id: newId(), r: 'ai', t: answer, at: new Date().toISOString() };
  msgs = [...msgs, r];
  render();
  await save([mine, r]);
}

function saveLocal() {
  writeLocal(LOCAL_KEY, { msgs: msgs.slice(-60), human });
}

async function save(newMsgs, patch = {}) {
  if (!opts.getUser()) return saveLocal();
  try {
    await opts.FB.pushMyChat(newMsgs, patch);
  } catch (e) {
    console.warn('Chat: no se pudo guardar', e);
    saveLocal();
  }
}

// ---------- IA ----------

async function askGemini(history) {
  const contents = history
    .filter((m) => m.r === 'u' || m.r === 'ai' || m.r === 'admin')
    .slice(-16)
    .map((m) => ({ role: m.r === 'u' ? 'user' : 'model', parts: [{ text: m.r === 'admin' ? `(Respuesta de Camilo, el administrador): ${m.t}` : m.t }] }));
  // Gemini exige que la conversación empiece por el usuario.
  while (contents.length && contents[0].role !== 'user') contents.shift();
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    // El tope incluye lo que el modelo "piensa" antes de responder (~400).
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  };
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(`${model}: HTTP ${r.status}`);
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (text) return text;
      throw new Error(`${model}: respuesta vacía`);
    } catch (e) {
      lastErr = e; // cupo agotado o modelo no disponible: prueba el siguiente
    }
  }
  throw lastErr;
}

function systemPrompt() {
  const c = opts.context();
  return `Eres el asistente de soporte de CamiloRey (https://cash3y3-star.github.io/camilorey/), un sitio de picks (pronósticos) de tenis de mesa de la Liga Pro Checa (Czech Liga Pro). Respondes en el idioma del usuario (normalmente español de Colombia), de forma breve, clara y amable, en texto simple: frases cortas, como mucho una lista corta con guiones. No uses emojis ni tablas.

DATOS DEL MOMENTO
- Fecha y hora (Colombia): ${c.now}
- Usuario: ${c.user}
- Premium: ${c.premium}
${c.extra}

CÓMO FUNCIONA EL SITIO
- Pestañas: Inicio (pick destacado, pick del tipster, partidos en vivo, campeones y jugadores en racha), Calendario (próximos y resultados de ayer, hoy y mañana), Picks (picks de partidos que aún no empiezan), En vivo (marcador en vivo de la Liga Pro Checa), Seguidos (picks que el usuario sigue con el corazón) y Mi Bankroll.
- Los datos salen de tt.league-pro.com (partidos y resultados oficiales) y las cuotas de Rushbet. Todo se actualiza solo cada ~10 minutos; el marcador en vivo, cada 2 segundos.
- Cada partido trae un pick del sistema: el jugador que el modelo ve más probable ganador, con su confianza (escala honesta de 50% a 80%). De 50% a 54% es un partido parejo (baja confianza). El modelo está entrenado con miles de partidos reales de 2026 y usa el cruce directo (H2H) del año, los últimos cruces, la forma del día en el torneo, el rating y la cuota de Rushbet. ${c.model}
- Al tocar un partido se abre su ficha: forma reciente L5/L10 (con rival, fecha y marcador), H2H completo de 2026, probabilidad de victoria y Análisis IA (este último es Premium).
- Pick destacado: el pick público de mayor confianza (cuota entre 1.60 y 2.50) que aún no empieza. Pick del tipster: un pick elegido a mano por Camilo.
- Seguir un pick: tocar el corazón. En Seguidos se ven sus resultados.
- Resultados: se verifican automáticamente al terminar cada partido.
- Perfil: editar nombre y foto, tema, formato de cuotas (decimal, americano, fraccional), idioma (español/inglés), sonido y vibración, notificaciones.

PREMIUM
- Incluye: picks de alta confianza (60% o más) antes del partido, Análisis IA de cada pick, Mi Bankroll con criterio de Kelly (Seguro, Equilibrado, Agresivo) y notificaciones en el celular (nuevo pick destacado y resultado de los picks seguidos).
- Cómo activarlo: 1) crear una cuenta gratis (Google o correo), 2) escribir a ${SUPPORT_EMAIL} con el correo de la cuenta, 3) Camilo lo activa y se desbloquea al instante (aparece una bienvenida). El precio y el pago se acuerdan por ese correo o con "Hablar con una persona": no inventes precios ni medios de pago.
- Notificaciones: Perfil > Notificaciones > activar (en iPhone primero hay que agregar el sitio a la pantalla de inicio).

COMBINADAS (parlays)
Si el usuario pide una combinada (doble, triple, parlay, "combinada de N", "con cuota X"), ármala SOLO con los picks del sistema de esta lista, que ya están calculados con exactitud:
${c.combos}
- Si pide algo que ya está arriba (doble, triple, cuota alta), copia esa combinada tal cual, con su cuota total y su probabilidad.
- Si pide una a medida (otro número de selecciones u otra cuota), elige de la lista de picks disponibles: de mayor confianza primero, sin repetir jugador ni partido, máximo 5 selecciones. La cuota total es la MULTIPLICACIÓN de las cuotas y la probabilidad estimada es la multiplicación de las confianzas (en decimal); redondea la cuota a 2 decimales y la probabilidad a entero. Revisa la cuenta antes de responder.
- Presenta cada selección en una línea: jugador que gana, partido, hora, confianza y cuota. Luego la cuota total y la probabilidad estimada de acertar todas.
- Sé honesto: en una combinada TODAS las selecciones tienen que acertar, así que la probabilidad baja mucho con cada selección (por eso paga más). Recomienda montos pequeños. Los picks se recalculan hasta 5 minutos antes de cada partido, así que conviene revisar la combinada en el sitio antes de apostar.
- Nunca uses partidos, jugadores o cuotas que no estén en la lista.${c.premiumLocked ? '\n- Este usuario no es Premium: hay picks de alta confianza (60% o más) bloqueados que no están en su lista. Si pregunta por combinadas más seguras, menciona que con Premium puede usar esos picks.' : ''}

REGLAS
- Nunca garantices ganancias ni digas que un pick es seguro. Las apuestas tienen riesgo: recomienda apostar solo lo que se pueda perder, con responsabilidad y siendo mayor de edad.
- No reveles picks Premium ni el Análisis IA a quien no es Premium; invítalo a Premium.
- Si no sabes algo, o el tema es de pagos, activación, reembolsos, errores de la cuenta o algo que necesite al dueño, dilo con honestidad y sugiere tocar el botón "Hablar con una persona" (o escribir a ${SUPPORT_EMAIL}).
- No inventes datos de partidos, resultados ni estadísticas que no estén aquí.`;
}
