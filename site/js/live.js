// ============================================================
// Marcador en vivo, directo desde el feed público de Rushbet (Kambi).
// El navegador de cada visitante lo consulta cada 2 s — Kambi permite
// la lectura desde cualquier sitio (Access-Control-Allow-Origin: *),
// así que no pasa por ningún servidor nuestro ni cuesta nada.
// ============================================================

const URL_INPLAY =
  'https://us.offering-api.kambicdn.com/offering/v2018/rsico/listView/table_tennis/all/all/all/in-play.json?lang=es_ES&market=CO&client_id=200&channel_id=1&useCombined=true';
const INTERVAL_MS = 2000;

const listeners = new Set();
let timer = null;
let last = { all: [], liga: [], at: 0, error: null };

function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Nuestros nombres: "Apellido InicialNombre" (ej. "Levicky M").
export function ourSig(name) {
  const p = stripAccents(name).toLowerCase().trim().split(/\s+/).filter(Boolean);
  return p.length ? `${p[0]}|${(p[1] || '')[0] || ''}` : '';
}
// Kambi: "Nombre Apellido".
function kambiSig(name) {
  const p = stripAccents(name).toLowerCase().trim().split(/\s+/).filter(Boolean);
  return p.length ? `${p[p.length - 1]}|${p[0][0] || ''}` : '';
}

function parse(e) {
  const sets = e.liveData?.statistics?.sets;
  const home = sets?.home || [];
  const away = sets?.away || [];
  const list = home.map((h, i) => ({ h, a: away[i] })).filter((s) => s.h !== -1 || s.a !== -1);
  const done = (s) => (s.h >= 11 || s.a >= 11) && Math.abs(s.h - s.a) >= 2;
  return {
    id: e.event.id,
    home: e.event.homeName,
    away: e.event.awayName,
    homeSig: kambiSig(e.event.homeName),
    awaySig: kambiSig(e.event.awayName),
    group: e.event.group || '',
    liga: /liga pro/i.test(e.event.group || '') || (e.event.path || []).some((p) => /liga pro/i.test(p.englishName || p.name || '')),
    sets: list,
    setsHome: list.filter((s) => done(s) && s.h > s.a).length,
    setsAway: list.filter((s) => done(s) && s.a > s.h).length,
    ptsHome: e.liveData?.score?.home ?? '-',
    ptsAway: e.liveData?.score?.away ?? '-',
    homeServe: sets?.homeServe ?? null,
    state: e.event.state
  };
}

async function tick() {
  if (document.visibilityState === 'hidden') return;
  try {
    const r = await fetch(URL_INPLAY, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const all = (d.events || []).filter((e) => e.event?.sport === 'TABLE_TENNIS' || e.liveData).map(parse);
    last = { all, liga: all.filter((e) => e.liga), at: Date.now(), error: null };
  } catch (e) {
    last = { ...last, error: e.message };
  }
  listeners.forEach((fn) => fn(last));
}

export function onLive(fn) {
  listeners.add(fn);
  if (last.at) fn(last);
  if (!timer) {
    tick();
    timer = setInterval(tick, INTERVAL_MS);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function currentLive() {
  return last;
}

// Busca un partido nuestro en el feed en vivo. Devuelve el evento
// orientado a NUESTRO jugador A (swap si Kambi los trae al revés).
export function findLive(liveList, nameA, nameB) {
  const a = ourSig(nameA);
  const b = ourSig(nameB);
  for (const e of liveList) {
    if (e.homeSig === a && e.awaySig === b) return e;
    if (e.homeSig === b && e.awaySig === a) {
      return {
        ...e,
        home: e.away,
        away: e.home,
        sets: e.sets.map((s) => ({ h: s.a, a: s.h })),
        setsHome: e.setsAway,
        setsAway: e.setsHome,
        ptsHome: e.ptsAway,
        ptsAway: e.ptsHome,
        homeServe: e.homeServe == null ? null : !e.homeServe
      };
    }
  }
  return null;
}
