// ============================================================
// Datos cifrados del sitio (los cifra scripts/vault.js en GitHub Actions).
// Se abren con la llave de Firestore vault/key, que las reglas solo dejan
// leer a cuentas con acceso vigente: sin acceso, los archivos de data/ son
// ilegibles aunque se descarguen a mano.
// Formato: "CRV1" | id de llave (8) | iv (12) | gzip cifrado AES-GCM.
// ============================================================

const keys = new Map(); // id de llave → CryptoKey
let loader = null; // () => { cur, keys: { id: base64 } } (lo pone app.js)
let pending = null;

export class NoAccess extends Error {}

export const supported = () => Boolean(globalThis.crypto?.subtle) && 'DecompressionStream' in globalThis;

export function setLoader(fn) {
  loader = fn;
}

// Al cerrar sesión o perder el acceso: olvidar las llaves.
export function forget() {
  keys.clear();
}

// Lee la llave de Firestore una sola vez aunque se pidan varios archivos a la vez.
function refreshKeys() {
  pending ||= (async () => {
    try {
      const doc = loader ? await loader() : null;
      keys.clear();
      for (const [id, b64] of Object.entries(doc?.keys || {})) {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        keys.set(id, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
      }
    } catch {
      keys.clear(); // sin permiso (acceso vencido) o sin conexión
    } finally {
      pending = null;
    }
  })();
  return pending;
}

const text = (u8) => new TextDecoder().decode(u8);

export async function open(buf) {
  const u8 = new Uint8Array(buf);
  if (text(u8.subarray(0, 4)) !== 'CRV1') throw new Error('archivo de datos inválido');
  const id = text(u8.subarray(4, 12));
  if (!keys.has(id)) await refreshKeys();
  const key = keys.get(id);
  if (!key) throw new NoAccess('sin acceso a los datos');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(12, 24) }, key, u8.subarray(24));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
