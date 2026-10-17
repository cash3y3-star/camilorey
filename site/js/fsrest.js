// ============================================================
// Firestore por REST (sin la librería de Firebase, que pesa ~170 KB):
// lo poco que necesita un visitante sin cuenta. Las mismas reglas de
// seguridad aplican (pedido sin sesión).
//   - contar la visita del día (stats/visits y stats/visits-AAAA-MM-DD)
//   - leer los picks del tipster (colección pública "tipster")
// ============================================================

import { FIREBASE_CONFIG } from './config.js?v=__V__';

const P = FIREBASE_CONFIG?.projectId;
const KEY = FIREBASE_CONFIG?.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;

function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}

// Suma 1 visita por navegador por día (igual que antes con la librería).
export async function countVisit() {
  if (!P || !KEY) return;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  try {
    if (localStorage.getItem('cr_visit') === day) return;
  } catch {}
  const inc = (doc) => ({ transform: { document: `projects/${P}/databases/(default)/documents/stats/${doc}`, fieldTransforms: [{ fieldPath: 'count', increment: { integerValue: '1' } }] } });
  // Un pedido por documento: las reglas revisan cada uno por separado.
  const results = await Promise.all(
    ['visits', `visits-${day}`].map((doc) =>
      fetch(`${BASE}:commit?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [inc(doc)] }) })
        .then((r) => r.ok)
        .catch(() => false)
    )
  );
  if (results.every(Boolean)) {
    try {
      localStorage.setItem('cr_visit', day);
    } catch {}
  }
}

// Picks del tipster (lectura pública).
export async function listTipster() {
  if (!P || !KEY) return [];
  const r = await fetch(`${BASE}/tipster?pageSize=300&key=${KEY}`);
  if (!r.ok) throw new Error(`tipster: HTTP ${r.status}`);
  const j = await r.json();
  return (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromFs(v)])) }));
}
