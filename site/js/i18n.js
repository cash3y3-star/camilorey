// ============================================================
// Traducción de la interfaz (español → inglés).
// La app se escribe en español; si el idioma elegido es inglés, este
// módulo traduce los textos visibles al vuelo (también los que aparecen
// después, con un MutationObserver). Frases exactas en DICT y frases con
// números en RULES. Los textos largos generados por el sistema (Análisis
// IA, términos) quedan en español.
// ============================================================

const DICT = {
  // navegación y encabezados
  Inicio: 'Home', Calendario: 'Schedule', Picks: 'Picks', 'En vivo': 'Live', Seguidos: 'Following', 'Mi Bankroll': 'My Bankroll',
  Entrar: 'Sign in', Predicciones: 'Predictions', Perfil: 'Profile', 'Atrás': 'Back', Notificaciones: 'Notifications',
  'Bankroll del sistema': 'System bankroll', Resultados: 'Results', 'Próximos': 'Upcoming', Todos: 'All', 'Con pick': 'With pick',
  'Alta confianza': 'High confidence', 'Cuota +1.60': 'Odds 1.60+', Hoy: 'Today', Ayer: 'Yesterday', 'Mañana': 'Tomorrow',
  // inicio
  'Picks de hoy 🏓': "Today's picks 🏓", '⭐ Picks destacados': '⭐ Featured picks', Efectividad: 'Win rate', Racha: 'Streak',
  'Cuota prom.': 'Avg. odds', 'destacados seguidos': 'featured in a row', 'de los destacados': 'of featured picks',
  'sin resueltos aún': 'none settled yet', 'Últimos destacados': 'Latest featured', 'Pick destacado': 'Featured pick',
  'En vivo ahora': 'Live now', 'Ver todo': 'See all', 'Sin picks por ahora': 'No picks yet',
  'Los picks se generan unas horas antes de cada torneo. Vuelve en un rato.': 'Picks are generated a few hours before each tournament. Check back soon.',
  'No hay partidos de la Liga Pro Checa en vivo en este momento.': 'No Czech Liga Pro matches are live right now.',
  // tarjetas
  'EN VIVO': 'LIVE', Terminado: 'Finished', Final: 'Final', '3er puesto': '3rd place', 'Nuestro pick:': 'Our pick:', 'Pick:': 'Pick:',
  '✓ Acierto': '✓ Won', '✗ Fallo': '✗ Lost', 'sin historial': 'no history', PICK: 'PICK', gana: 'wins',
  'Nuestro pick': 'Our pick', 'últimos 7 días': 'last 7 days', 'Kelly sobre los picks que sigues': 'Kelly on the picks you follow',
  'Banca simulada de CamiloRey · solo admin': 'CamiloRey simulated bankroll · admin only',
  'Se actualiza solo cada ~10 min · última:': 'Auto-updates every ~10 min · last:',
  // ficha
  Torneo: 'Tournament', Cuota: 'Odds', Estado: 'Status', PROGRAMADO: 'SCHEDULED', FINAL: 'FINAL',
  'Seguir este pick': 'Follow this pick', 'Dejar de seguir': 'Unfollow', 'Forma reciente': 'Recent form',
  'Probabilidad de victoria': 'Win probability', 'según el modelo': 'according to the model', 'Marcador en vivo': 'Live score',
  'cada 2 s': 'every 2 s', 'Análisis IA': 'AI analysis', 'A tener en cuenta': 'Keep in mind',
  'Sin enfrentamientos directos registrados.': 'No head-to-head matches on record.',
  // listas y filtros
  'Últimos 7 días': 'Last 7 days', 'Últimos 30 días': 'Last 30 days', Todo: 'All time', activos: 'active', activo: 'active',
  'Aún no sigues ningún pick': "You're not following any picks yet", 'Sin seguimientos en este rango': 'Nothing followed in this range',
  'Nada en vivo ahora': 'Nothing live right now', 'Sin resultados todavía': 'No results yet', 'Sin partidos por jugar': 'No matches left to play',
  'Sin picks en este filtro': 'No picks for this filter',
  // bankroll
  'Banca inicial (COP)': 'Starting bankroll (COP)', 'Nivel de riesgo': 'Risk level', Seguro: 'Safe', Equilibrado: 'Balanced', Agresivo: 'Aggressive',
  '¼ Kelly': '¼ Kelly', '½ Kelly': '½ Kelly', 'Kelly completo': 'Full Kelly', 'Mi banca actual': 'My current bankroll',
  Apuestas: 'Bets', 'Máx. caída': 'Max drawdown', 'Evolución de mi banca': 'My bankroll over time', 'Por apostar': 'To bet',
  'Mi historial': 'My history', 'No apostar': "Don't bet", 'la cuota no paga el riesgo': "odds don't pay the risk", 'sin cuota': 'no odds',
  'Mi bankroll': 'My bankroll', '🔒 Sistema': '🔒 System', 'Banca del sistema': 'System bankroll', Apostado: 'Staked',
  'Evolución de la banca': 'Bankroll over time', '🔒 Historial de apuestas': '🔒 Bet history', 'Solo admin': 'Admin only',
  Partido: 'Match', Apuesta: 'Stake', Resultado: 'Result', Banca: 'Bankroll',
  // perfil y ajustes
  Ajustes: 'Settings', Tema: 'Theme', Oscuro: 'Dark', Claro: 'Light', Sistema: 'System', Idioma: 'Language', 'Formato de cuotas': 'Odds format',
  'Ayuda y FAQ': 'Help & FAQ', Privacidad: 'Privacy', 'Términos de servicio': 'Terms of service', 'Cerrar sesión': 'Sign out',
  'Info de cuenta': 'Account info', Invitado: 'Guest', 'Iniciar sesión o crear cuenta': 'Sign in or create account',
  'Nombre completo': 'Full name', Correo: 'Email', 'Miembro desde': 'Member since', 'ID de usuario': 'User ID', Editar: 'Edit', Guardar: 'Save',
  'Cambiar foto': 'Change photo', 'Quitar foto': 'Remove photo', 'Eliminar cuenta': 'Delete account', 'Seleccionar tema': 'Choose theme',
  'Negro con rojo (recomendado)': 'Black and red (recommended)', 'Fondo claro con rojo': 'Light background with red',
  'Sigue el ajuste del dispositivo': 'Follows your device setting', Decimal: 'Decimal', Americano: 'American', Fraccional: 'Fractional',
  'Preguntas frecuentes, contacto': 'FAQ, contact', 'Datos y seguridad de cuenta': 'Data and account security',
  'Uso informativo, no es casa de apuestas': 'Informational use, not a bookmaker',
  'Inicia sesión para guardar tus picks seguidos': 'Sign in to save the picks you follow',
  'Inicia sesión para guardar tus seguidos en todos tus dispositivos': 'Sign in to keep your followed picks on all your devices',
  'Inicia sesión para guardar tu banca y tus seguidos en todos tus dispositivos': 'Sign in to keep your bankroll and followed picks on all your devices',
  'Idioma original': 'Original language', 'Interface in English': 'Interface in English',
  'El análisis de cada pick y las páginas legales se muestran en español.': 'Each pick’s analysis and the legal pages are shown in Spanish.',
  'Nota:': 'Note:', 'el modo sistema cambia solo entre claro y oscuro según la apariencia de tu celular o PC.': 'system mode switches between light and dark following your phone or PC.',
  Jugador: 'Player', 'Últimos 30 días': 'Last 30 days', 'Títulos': 'Titles', 'torneos ganados': 'tournaments won', actual: 'current',
  'Próximos partidos': 'Upcoming matches', 'Últimos partidos': 'Latest matches', 'Rivales frecuentes': 'Frequent opponents',
  '🏆 Torneos ganados': '🏆 Tournaments won', 'Sin ficha': 'No profile',
  'Sonido y vibración': 'Sound and vibration', 'Un toque suave al cambiar de pestaña': 'A soft tap when switching tabs',
  // login
  'Iniciar sesión': 'Sign in', 'Crear cuenta': 'Create account', 'Continuar con Google': 'Continue with Google', 'o con tu correo': 'or with your email',
  Nombre: 'Name', 'Contraseña': 'Password', 'Crear cuenta nueva': 'Create a new account', 'Olvidé mi contraseña': 'Forgot my password',
  'Ya tengo cuenta': 'I already have an account',
  // pie
  'CamiloRey · Predicciones informativas, no es casa de apuestas · +18': 'CamiloRey · Informational predictions, not a bookmaker · 18+'
};

// Frases con partes variables (números, nombres).
const RULES = [
  [/^Hola, (.+) 👋$/, 'Hi, $1 👋'],
  [/^(\d+) próximos picks · (.+)$/, '$1 upcoming picks · $2'],
  [/(\d+) picks activos · Liga Pro Checa/, '$1 active picks · Czech Liga Pro'],
  [/^Americano · /, 'American · '],
  [/^Fraccional · /, 'Fractional · '],
  [/^Ej: /, 'e.g. '],
  [/ \(el de Rushbet\)$/, " (Rushbet's)"],
  [/^Se aplica a todas las cuotas de la página\. La de 1\.57 se ve así:$/, 'Applies to every odd on the site. 1.57 looks like this:'],
  [/^Miembro desde (.+)$/, 'Member since $1'],
  [/^🏆 CAMPEÓN$/, '🏆 CHAMPION'],
  [/^SUSCRIPCIÓN ACTIVA$/, 'ACTIVE SUBSCRIPTION'],
  [/^Bienvenido a CamiloRey Premium$/, 'Welcome to CamiloRey Premium'],
  [/^Tu suscripción está activa hasta (.+)\.$/, 'Your subscription is active until $1.'],
  [/^ACCESO COMPLETO$/, 'FULL ACCESS'],
  [/^Para quien sigue los picks en serio$/, 'For those who take picks seriously'],
  [/^Comenzar a Explorar$/, 'Start exploring'],
  [/^Picks de alta confianza \(60% o más\)$/, 'High-confidence picks (60%+)'],
  [/^Análisis con IA por partido$/, 'AI analysis for every match'],
  [/^Bankroll con criterio de Kelly$/, 'Bankroll with Kelly criterion'],
  [/^Alertas de picks en tu celular$/, 'Pick alerts on your phone'],
  [/^🔥 Jugadores en racha$/, '🔥 Players on fire'],
  [/^🔥 (\d+) victorias seguidas$/, '🔥 $1 wins in a row'],
  [/^(\d+) derrotas seguidas$/, '$1 losses in a row'],
  [/^(\d+)-(\d+) en 7 días$/, '$1-$2 in 7 days'],
  [/^Liga Pro Checa · Rating$/, 'Czech Liga Pro · Rating'],
  [/^(\d+)G · (\d+)P$/, '$1W · $2L'],
  [/^Último (\d+-\d+)$/, 'Last $1'],
  [/^Ganó (\d+) de (\d+)$/, 'Won $1 of $2'],
  [/^👑 Campeones$/, '👑 Champions'],
  [/^(\d+) seguidos · (\d+) resueltos$/, '$1 following · $2 settled'],
  [/^(\d+) de (\d+)$/, '$1 of $2'],
  [/^(\d+) partidos · (.+)$/, '$1 matches · $2'],
  [/^(\d+) activos · (\d+) total$/, '$1 active · $2 total'],
  [/^Liga Pro Checa · (\d+) partidos? en juego · se actualiza cada 2 s$/, 'Czech Liga Pro · $1 live · updates every 2 s'],
  [/^(.+) gana$/, '$1 wins'],
  [/^(.+) GANA$/, '$1 WINS'],
  [/^GANA · (\d+)%$/, 'WINS · $1%'],
  [/^Se jugó (.+) · (.+)$/, 'Played $1 · $2'],
  [/^Últimos (\d+) enfrentamientos$/, 'Last $1 meetings'],
  [/^(\d+) ganadas$/, '$1 won'],
  [/^Inició con (.+)$/, 'Started with $1'],
  [/^(\d+) visitas hoy · (.+) en total · (.+) usuarios$/, '$1 visits today · $2 total · $3 users'],
  [/a\. m\./g, 'AM'],
  [/p\. m\./g, 'PM']
];

// ---------- Emojis → íconos de línea ----------
// El sitio usa íconos de trazo (como la barra de abajo). Cualquier emoji que
// aparezca en pantalla se reemplaza por su ícono equivalente.
import { icon } from './icons.js?v=__V__';

const EMOJI = {
  '🏆': ['trophy', 'gold'], '👑': ['crown', 'gold'], '⭐': ['star', 'gold'], '🔒': ['lock', ''], '🔥': ['flame', 'hot'],
  '🔔': ['bell', ''], '🔕': ['bellOff', ''], '✅': ['checkc', 'win'], '❌': ['xc', 'loss'], '⏳': ['clock', ''], '⌛': ['clock', ''],
  '📊': ['chart', ''], '📅': ['calendar', ''], '👥': ['users', ''], '💬': ['chat', ''], '🏓': ['paddle', 'hot'], '🧠': ['bolt', ''], '💰': ['wallet', ''], '👋': [null, '']
};
const EMOJI_RE = /(🏆|👑|⭐|🔒|🔥|🔔|🔕|✅|❌|⏳|⌛|📊|📅|👥|💬|🏓|🧠|💰|👋)️?/u;
const EMOJI_RE_G = new RegExp(EMOJI_RE.source, 'gu');

function iconizeText(n) {
  if (!n.parentNode || !EMOJI_RE.test(n.nodeValue)) return;
  const frag = document.createDocumentFragment();
  let last = 0;
  const s = n.nodeValue;
  for (const m of s.matchAll(EMOJI_RE_G)) {
    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
    const [name, cls] = EMOJI[m[1]];
    if (name) {
      const span = document.createElement('span');
      span.className = `ei ${cls}`;
      span.innerHTML = icon(name, 'ei-svg');
      frag.appendChild(span);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last).replace(/^\s+$/, ' ')));
  n.parentNode.replaceChild(frag, n);
}

function iconizeTree(root) {
  if (!root) return;
  if (root.nodeType === 3) return iconizeText(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (EMOJI_RE.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  nodes.forEach(iconizeText);
}

export function lang() {
  try {
    return JSON.parse(localStorage.getItem('cr_lang')) || 'es';
  } catch {
    return 'es';
  }
}

function tr(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (DICT[trimmed]) return text.replace(trimmed, DICT[trimmed]);
  let out = trimmed;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out === trimmed ? text : text.replace(trimmed, out);
}

export function translateTree(root) {
  if (lang() !== 'en' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const t = tr(n.nodeValue);
    if (t !== n.nodeValue) n.nodeValue = t;
  }
  root.querySelectorAll?.('[placeholder]').forEach((el) => {
    const t = tr(el.getAttribute('placeholder'));
    if (t) el.setAttribute('placeholder', t);
  });
}

// Traduce todo lo que se agrega o cambia en la página.
export function startI18n() {
  document.documentElement.lang = lang();
  const en = lang() === 'en';
  // Primero traduce (las reglas incluyen emojis) y después cambia emojis por íconos.
  if (en) translateTree(document.body);
  iconizeTree(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') {
        if (en) {
          const t = tr(m.target.nodeValue);
          if (t !== m.target.nodeValue) m.target.nodeValue = t;
        }
        iconizeText(m.target);
      } else
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 3) {
            if (en) n.nodeValue = tr(n.nodeValue);
            iconizeText(n);
          } else {
            if (en) translateTree(n);
            iconizeTree(n);
          }
        });
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
