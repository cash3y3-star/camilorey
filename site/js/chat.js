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
import { sendFx, messageFx, endFx } from './feedback.js?v=__V__';

const LOCAL_KEY = 'cr_chat';
const LIMIT_KEY = 'cr_chat_n';
const MAX_PER_DAY = 30; // mensajes a la IA por navegador y día (cuida el cupo gratis)
const MAX_LEN = 600;

let opts = null; // { FB, getUser, isPremium, isAdmin, context, openLogin, openAdmin, onTap }
let msgs = [];
let human = false;
let open = false;
let mini = false; // ventana minimizada (solo la barra del título)
let confirmEnd = false; // mostrando "¿Se resolvió tu problema?"
// Sonido al llegar mensajes: ids ya vistos (null = primera carga, sin sonido)
// y los creados en este navegador (ya sonaron al crearse).
let seenIds = null;
let adminPhoto = null; // foto de perfil del admin (la guarda al responder)
const localIds = new Set();
const mark = (list) => list.forEach((m) => localIds.add(m.id));
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

// ---------- Fin de la conversación ----------
// Un chat se "finaliza" agregando un mensaje de sistema { r: 'sys', end: true,
// by: 'u'|'admin'|'ai'|'auto', res: 'yes'|'no'|null } y, si corresponde, un
// mensaje automático. Lo que se escriba después es una conversación nueva.
export const IDLE_MIN = 10; // minutos sin respuesta del usuario para cerrar solo

const isEnd = (m) => m && m.r === 'sys' && m.end;
export const isClosed = (list) => isEnd((list || []).slice(-1)[0]);

// Mensajes de la conversación actual (o de la última, si ya se cerró).
export function currentSegment(list) {
  const l = list || [];
  const ends = l.map((m, i) => (isEnd(m) ? i : -1)).filter((i) => i >= 0);
  if (!ends.length) return l;
  const last = ends[ends.length - 1];
  if (last === l.length - 1) return l.slice(ends.length > 1 ? ends[ends.length - 2] + 1 : 0);
  return l.slice(last + 1);
}

// ¿Hay que cerrarlo por inactividad? Solo si el usuario escribió en esta
// conversación y la última palabra la tiene soporte (IA o admin) hace más
// de IDLE_MIN minutos (si el último en escribir es el usuario, se le debe
// una respuesta: no se cierra).
export function idleDue(list) {
  if (isClosed(list)) return null;
  const seg = currentSegment(list);
  const last = seg[seg.length - 1];
  if (!last || last.r === 'u' || !seg.some((m) => m.r === 'u') || !last.at) return null;
  const due = new Date(last.at).getTime() + IDLE_MIN * 60e3;
  return Date.now() >= due ? new Date(due).toISOString() : null;
}

export function closingMsgs(by, res, at = new Date().toISOString()) {
  const R = res === 'yes' ? ' · Problema resuelto' : res === 'no' ? ' · Sin resolver' : '';
  const reason = {
    u: `Chat finalizado por el usuario${R}`,
    admin: `Camilo Rey (CEO) finalizó el chat${R}`,
    ai: `El asistente finalizó el chat${R}`,
    auto: `Chat cerrado automáticamente: ${IDLE_MIN} minutos sin respuesta del usuario`
  }[by];
  const auto = {
    'u:yes': '¡Qué bueno que se resolvió! Gracias por escribirnos. Si necesitas algo más, aquí estamos.',
    'u:no': `Lamentamos no haber resuelto tu problema. Puedes escribir de nuevo cuando quieras, tocar "Hablar con una persona" o escribir a ${SUPPORT_EMAIL}.`,
    'admin:yes': 'Tu caso quedó resuelto. ¡Gracias por confiar en CamiloRey! Si necesitas algo más, escríbenos de nuevo.',
    'admin:no': `Cerramos este chat sin una solución definitiva. Si el problema sigue, escríbenos de nuevo o a ${SUPPORT_EMAIL} y lo revisamos.`,
    'auto:null': 'Cerramos este chat porque no recibimos respuesta. Si todavía necesitas ayuda, escribe de nuevo y te atendemos.'
  }[`${by}:${res}`];
  const t0 = new Date(at).getTime();
  const out = [{ id: newId(), r: 'sys', end: true, by, res: res || null, t: reason, at }];
  if (auto) out.push({ id: newId(), r: 'ai', auto: true, t: auto, at: new Date(t0 + 1).toISOString() });
  // El mensaje automático va ANTES del cierre en el tiempo de lectura: primero se explica, luego la línea de cierre.
  return auto ? [out[1], { ...out[0], at: new Date(t0 + 2).toISOString() }] : out;
}

// Foto de perfil al lado de cada mensaje: imagen, o iniciales si no tiene;
// la IA lleva el ícono del asistente.
export function chatAvatar(kind, photo, name) {
  if (kind === 'ai') return `<span class="cav ai">${icon('bolt')}</span>`;
  const ini = esc((name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?');
  const ring = kind === 'admin' ? ' admin' : '';
  return photo ? `<span class="cav${ring}"><img src="${esc(photo)}" alt="" referrerpolicy="no-referrer"></span>` : `<span class="cav${ring}">${ini}</span>`;
}

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
  seenIds = null;
  opts.FB.watchMyChat((doc) => {
    msgs = doc?.msgs || [];
    adminPhoto = doc?.adminPhoto || null;
    // Mensajes nuevos que llegaron de afuera: respuesta del admin o cierre.
    if (seenIds) {
      const fresh = msgs.filter((m) => !seenIds.has(m.id) && !localIds.has(m.id));
      if (fresh.some((m) => m.r === 'admin')) messageFx();
      else if (fresh.some((m) => m.r === 'sys')) endFx();
    }
    seenIds = new Set(msgs.map((m) => m.id));
    human = Boolean(doc?.human);
    // Minimizada cuenta como "no vista": queda el punto hasta abrirla.
    setUnread(Boolean(doc?.unreadUser) && (!open || mini));
    if (open) {
      render();
      if (doc?.unreadUser && !mini) opts.FB.markMyChatRead();
    }
    checkIdle();
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
  // Solo la conversación actual (o la última, si ya se cerró).
  const closed = isClosed(msgs);
  const seg = currentSegment(msgs);
  const list = [{ id: 'w', r: 'ai', t: welcome }, ...seg];
  const canEnd = !closed && seg.some((m) => m.r === 'u');
  const pf = opts.getProfile?.() || {};
  const av = { u: chatAvatar('u', pf.photo, pf.name), ai: chatAvatar('ai'), admin: chatAvatar('admin', adminPhoto, 'Camilo Rey') };
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
      ${list
        .map((m) =>
          m.r === 'sys'
            ? `<div class="chat-sys ${m.res === 'yes' ? 'ok' : m.res === 'no' ? 'ko' : ''}">${icon(m.res === 'yes' ? 'checkc' : m.by === 'auto' ? 'clock' : 'info')}<span>${esc(m.t)}</span></div>`
            : `<div class="cline ${m.r === 'u' ? 'me' : ''}">${av[m.r] || ''}<div class="cmsg ${m.r === 'u' ? 'me' : m.r}"><small>${who[m.r] || ''}</small><div class="bub">${fmt(m.t)}</div></div></div>`
        )
        .join('')}
      ${busy ? `<div class="cline">${av.ai}<div class="cmsg ai"><small>${who.ai}</small><div class="bub typing"><i></i><i></i><i></i></div></div></div>` : ''}
      ${human && !closed ? `<div class="chat-note">${icon('info')} Le avisamos a Camilo. Te responde aquí mismo apenas pueda. También puedes escribir a <b>${esc(SUPPORT_EMAIL)}</b>.</div>` : ''}
      ${!closed && canEnd ? `<div class="chat-idle">Si no respondes en ${IDLE_MIN} minutos, el chat se cierra solo.</div>` : ''}
    </div>
    <form class="chat-form" autocomplete="off">
      <textarea name="msg" rows="1" maxlength="${MAX_LEN}" placeholder="${closed ? 'Escribe para iniciar una nueva conversación…' : human ? 'Escríbele a Camilo…' : 'Escribe tu pregunta…'}" ${busy ? 'disabled' : ''}></textarea>
      <button class="chat-send" type="submit" aria-label="Enviar" ${busy ? 'disabled' : ''}>${icon('send')}</button>
    </form>
    <div class="chat-actions">
      ${
        confirmEnd
          ? `<span class="end-q">¿Se resolvió tu problema?</span>
             <button type="button" class="mini-btn ok" data-chat-end="yes">Sí, resuelto</button>
             <button type="button" class="mini-btn" data-chat-end="no">No</button>
             <button type="button" class="textlink" data-chat-end="">Cancelar</button>`
          : `${
              closed
                ? ''
                : human
                ? aiReady()
                  ? '<button type="button" class="textlink" data-chat-ai>Volver al asistente IA</button>'
                  : ''
                : `<button type="button" class="textlink" data-chat-human>${icon('users')} Hablar con una persona</button>`
            }${canEnd ? `<button type="button" class="textlink end-link" data-chat-endask>${icon('x')} Finalizar chat</button>` : ''}`
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
  if (t.hasAttribute('data-chat-endask')) {
    confirmEnd = true;
    return render();
  }
  if (t.hasAttribute('data-chat-end')) {
    confirmEnd = false;
    const res = t.getAttribute('data-chat-end');
    if (!res) return render();
    return endChat('u', res);
  }
  if (t.hasAttribute('data-chat-human')) return askHuman();
  if (t.hasAttribute('data-chat-ai')) {
    human = false;
    await save([], { human: false });
    render();
  }
}

// Finaliza la conversación actual (usuario, IA o por inactividad).
async function endChat(by, res, at) {
  if (isClosed(msgs)) return;
  const add = closingMsgs(by, res, at);
  mark(add);
  endFx();
  msgs = [...msgs, ...add];
  human = false;
  confirmEnd = false;
  render();
  await save(add, { human: false, unreadAdmin: false }, (cur) => !isClosed(cur));
}

// Cierre por inactividad: se revisa al recibir cambios y cada 30 s.
function checkIdle() {
  if (!opts?.getUser() || busy) return;
  const due = idleDue(msgs);
  if (due) endChat('auto', null, due);
}
setInterval(checkIdle, 30e3);

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
  confirmEnd = false;
  // Escribir después de un cierre empieza una conversación nueva (con la IA).
  if (isClosed(msgs)) human = false;
  const mine = { id: newId(), r: 'u', t: text, at: new Date().toISOString() };
  mark([mine]);
  sendFx();
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
  // La IA marca [[FIN]] cuando el usuario confirma que se resolvió o se despide.
  const fin = /\[\[FIN\]\]/.test(answer);
  answer = answer.replace(/\s*\[\[FIN\]\]\s*/g, ' ').trim();
  const r = { id: newId(), r: 'ai', t: answer, at: new Date().toISOString() };
  mark([r]);
  messageFx();
  msgs = [...msgs, r];
  render();
  await save([mine, r], { human: false });
  if (fin) await endChat('ai', 'yes');
}

function saveLocal() {
  writeLocal(LOCAL_KEY, { msgs: msgs.slice(-60), human });
}

async function save(newMsgs, patch = {}, onlyIf = null) {
  if (!opts.getUser()) return saveLocal();
  // Nombre y foto del perfil: el admin los ve en su lista y en la conversación.
  const pf = opts.getProfile?.() || {};
  try {
    await opts.FB.pushMyChat(newMsgs, { name: pf.name || '', photo: pf.photo || null, ...patch }, onlyIf);
  } catch (e) {
    console.warn('Chat: no se pudo guardar', e);
    saveLocal();
  }
}

// ---------- IA ----------

async function askGemini(history) {
  // Solo la conversación actual (no las que ya se cerraron).
  const contents = currentSegment(history)
    .filter((m) => (m.r === 'u' || m.r === 'ai' || m.r === 'admin') && !m.auto)
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
- Los datos salen de tt.league-pro.com (partidos y resultados oficiales) y las cuotas de Rushbet. Todo se actualiza solo cada ~5 minutos; el marcador en vivo, cada 2 segundos.
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

FIN DEL CHAT
- Si el usuario confirma claramente que su problema quedó resuelto o se despide (por ejemplo "gracias, ya quedó", "listo, eso era todo", "chao"), despídete en una frase y escribe al final, exactamente, [[FIN]]. Eso cierra el chat. No lo uses si todavía tiene dudas.
- El usuario también puede tocar "Finalizar chat". Si no responde en ${IDLE_MIN} minutos, el chat se cierra solo.

REGLAS
- Nunca garantices ganancias ni digas que un pick es seguro. Las apuestas tienen riesgo: recomienda apostar solo lo que se pueda perder, con responsabilidad y siendo mayor de edad.
- No reveles picks Premium ni el Análisis IA a quien no es Premium; invítalo a Premium.
- Si no sabes algo, o el tema es de pagos, activación, reembolsos, errores de la cuenta o algo que necesite al dueño, dilo con honestidad y sugiere tocar el botón "Hablar con una persona" (o escribir a ${SUPPORT_EMAIL}).
- No inventes datos de partidos, resultados ni estadísticas que no estén aquí.`;
}
