// ============================================================
// CZECH IA AGENTS — cuotas reales de Rushbet (Liga Pro checa)
// Rushbet corre sobre Kambi, que expone su tablero de cuotas en un
// JSON público sin login (lo confirmamos inspeccionando el tráfico
// real del sitio con Playwright). Este archivo solo lee ese feed y
// cruza por nombre+hora contra nuestros propios partidos — no hay
// scraping de sesión ni de cuenta de usuario.
// ============================================================

const KAMBI_URL =
  'https://us.offering-api.kambicdn.com/offering/v2018/rsico/listView/table_tennis.json?lang=es_ES&market=CO&client_id=200&channel_id=1&useCombined=true';

// Feed de partidos EN VIVO — trae reloj y marcador set por set en
// tiempo real (lo usa el propio sitio para las cuotas en vivo, así
// que se actualiza mucho más rápido y con más detalle que
// tt.league-pro.com).
const KAMBI_LIVE_URL =
  'https://us.offering-api.kambicdn.com/offering/v2018/rsico/event/live/open.json?lang=es_ES&market=CO&client_id=200&channel_id=1';

const MATCH_TOLERANCE_MS = 45 * 60 * 1000;

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Nuestros jugadores vienen como "Apellido InicialNombre" (short_name_en
// de tt.league-pro.com, ej. "Levicky M").
function ourNameSignature(name) {
  const parts = stripAccents(name || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const surname = parts[0];
  const initial = (parts[1] || '')[0] || '';
  return `${surname}|${initial}`;
}

// Kambi trae "Nombre Apellido" — tomamos la última palabra como
// apellido (best effort; apellidos compuestos pueden fallar).
function kambiNameSignature(name) {
  const parts = stripAccents(name || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const initial = parts[0][0] || '';
  const surname = parts[parts.length - 1];
  return `${surname}|${initial}`;
}

async function fetchLigaProChecaOdds() {
  const res = await fetch(KAMBI_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (CZECH IA AGENTS sync bot)' } });
  if (!res.ok) throw new Error(`Fetch failed rushbet odds: ${res.status}`);
  const data = await res.json();
  const events = (data.events || []).filter((e) => e.event?.group === 'Liga Pro checa');

  return events
    .map((e) => {
      const offer = (e.betOffers || []).find((b) => b.betOfferType?.id === 2) || e.betOffers?.[0];
      const outcomes = offer?.outcomes || [];
      const home = outcomes.find((o) => o.type === 'OT_ONE');
      const away = outcomes.find((o) => o.type === 'OT_TWO');
      return {
        homeName: e.event.homeName,
        awayName: e.event.awayName,
        start: e.event.start,
        oddsHome: home ? home.odds / 1000 : null,
        oddsAway: away ? away.odds / 1000 : null
      };
    })
    .filter((e) => e.oddsHome && e.oddsAway);
}

// Devuelve { oddsA, oddsB } (cuota de cada uno de nuestros dos
// jugadores) o null si no encontramos el partido en el feed.
function findOdds(events, playerAName, playerBName, scheduledAtIso) {
  const sigA = ourNameSignature(playerAName);
  const sigB = ourNameSignature(playerBName);
  const targetTime = new Date(scheduledAtIso).getTime();

  for (const e of events) {
    if (Math.abs(new Date(e.start).getTime() - targetTime) > MATCH_TOLERANCE_MS) continue;
    const homeSig = kambiNameSignature(e.homeName);
    const awaySig = kambiNameSignature(e.awayName);
    if (homeSig === sigA && awaySig === sigB) return { oddsA: e.oddsHome, oddsB: e.oddsAway };
    if (homeSig === sigB && awaySig === sigA) return { oddsA: e.oddsAway, oddsB: e.oddsHome };
  }
  return null;
}

async function fetchLiveTableTennis() {
  const res = await fetch(KAMBI_LIVE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (CZECH IA AGENTS sync bot)' } });
  if (!res.ok) throw new Error(`Fetch failed rushbet live: ${res.status}`);
  const data = await res.json();
  return (data.liveEvents || []).filter((e) => e.event?.sport === 'TABLE_TENNIS');
}

// Busca el partido en el feed en vivo por nombre (sin depender de
// hora, porque un partido en vivo ya empezó). Devuelve el evento tal
// cual junto con si A/B quedaron invertidos respecto al home/away de
// Kambi, para que quien llame pueda reordenar el marcador.
function findLiveEvent(liveEvents, playerAName, playerBName) {
  const sigA = ourNameSignature(playerAName);
  const sigB = ourNameSignature(playerBName);

  for (const e of liveEvents) {
    const homeSig = kambiNameSignature(e.event?.homeName);
    const awaySig = kambiNameSignature(e.event?.awayName);
    if (homeSig === sigA && awaySig === sigB) return { event: e, swapped: false };
    if (homeSig === sigB && awaySig === sigA) return { event: e, swapped: true };
  }
  return null;
}

module.exports = { fetchLigaProChecaOdds, findOdds, fetchLiveTableTennis, findLiveEvent };
