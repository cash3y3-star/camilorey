// ============================================================
// Firestore por REST (sin la librería de Firebase, que pesa ~170 KB):
// lo poco que necesita un visitante sin cuenta. Las mismas reglas de
// seguridad aplican (pedido sin sesión).
//   - contar la visita del día (stats/visits y stats/visits-AAAA-MM-DD)
// ============================================================

import { FIREBASE_CONFIG } from './config.js?v=__V__';

const P = FIREBASE_CONFIG?.projectId;
const KEY = FIREBASE_CONFIG?.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;

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
