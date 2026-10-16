// ============================================================
// CZECH IA AGENTS — lectura del JSON de tt.league-pro.com
// Compartido entre scripts/sync.js (corre cada 30 min) y
// pages/api/live-match.js (lo consulta el navegador cada pocos
// segundos mientras hay un partido en vivo en pantalla).
//
// tt.league-pro.com es una app Nuxt con SSR: cada página trae
// embebido un <script id="__NUXT_DATA__"> con toda la data ya
// estructurada en JSON. Nuxt la serializa como un array plano donde
// cada objeto/array referencia a otros valores por su índice (para
// no repetir valores iguales) — unflattenNuxtPayload la desenrolla a
// un árbol normal.
// ============================================================

const BASE = 'https://tt.league-pro.com';

const REVIVE_TAGS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef']);

function unflattenNuxtPayload(raw) {
  const cache = new Map();

  function resolve(i) {
    if (cache.has(i)) return cache.get(i);
    const v = raw[i];

    if (v === null || typeof v !== 'object') return v;

    if (Array.isArray(v) && typeof v[0] === 'string' && REVIVE_TAGS.has(v[0])) {
      const result = v.length > 1 ? resolve(v[1]) : undefined;
      cache.set(i, result);
      return result;
    }

    if (Array.isArray(v)) {
      const arr = [];
      cache.set(i, arr);
      for (const idx of v) arr.push(resolve(idx));
      return arr;
    }

    const obj = {};
    cache.set(i, obj);
    for (const key of Object.keys(v)) obj[key] = resolve(v[key]);
    return obj;
  }

  return resolve(0);
}

async function fetchNuxtData(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (CZECH IA AGENTS sync bot)' }
  });
  if (!res.ok) throw new Error(`Fetch failed ${path}: ${res.status}`);
  const html = await res.text();
  // Con demasiadas consultas seguidas el sitio responde 200 pero con una
  // página de error "Too Many Requests" — se trata como error para que
  // quien llama reintente en vez de leerlo como "0 torneos".
  if (/Too Many Requests/i.test(html)) {
    const err = new Error(`Límite de consultas de tt.league-pro.com (${path})`);
    err.rateLimited = true;
    throw err;
  }
  const match = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`No se encontró __NUXT_DATA__ en ${path}`);
  const payload = unflattenNuxtPayload(JSON.parse(match[1]));
  return payload.data;
}

module.exports = { BASE, fetchNuxtData, unflattenNuxtPayload };
