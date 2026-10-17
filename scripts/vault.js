// ============================================================
// CamiloRey — candado de los datos (el sitio es solo para miembros).
//
// El repositorio y GitHub Pages son públicos, así que los datos se cifran
// (AES-256-GCM) antes de publicarlos:
//
//   seal-site            cifra site/data/** con la LLAVE DEL SITIO. Esa llave
//                        está en Firestore (vault/key) y las reglas solo la
//                        dejan leer a cuentas con acceso vigente (members) y
//                        al admin. Se cambia sola cada día y cuando a alguien
//                        se le vence o se le quita el acceso: así un ex
//                        miembro deja de poder abrir los datos nuevos.
//   open-state <dir>     descifra el estado (rama "state") en <dir>.
//   seal-state <dir> <out>  cifra el estado de <dir> en <out> para guardarlo.
//                        El estado usa otra llave, derivada de un secreto de
//                        GitHub Actions (STATE_SECRET): nunca sale de Actions.
//
// Formato de cada archivo cifrado: "CRV1" | id de llave (8 letras) |
// iv (12 bytes) | datos gzip cifrados + etiqueta GCM (16 bytes).
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('CRV1');
const ROOT = path.join(__dirname, '..');
const SITE_DATA = path.join(ROOT, 'site', 'data');
const VAULT_STATE = path.join(ROOT, 'data', 'vault.json');

function seal(plain, keyId, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 9 })), c.final(), c.getAuthTag()]);
  return Buffer.concat([MAGIC, Buffer.from(keyId, 'ascii'), iv, body]);
}

function isSealed(buf) {
  return buf.length > 40 && buf.subarray(0, 4).equals(MAGIC);
}

function open(buf, key) {
  const iv = buf.subarray(12, 24);
  const body = buf.subarray(24);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(body.subarray(body.length - 16));
  return zlib.gunzipSync(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------------- estado (rama "state") ----------------

function stateKey() {
  const secret = process.env.STATE_SECRET;
  if (!secret) throw new Error('Falta STATE_SECRET: el estado no se puede cifrar ni descifrar');
  return crypto.createHash('sha256').update(`camilorey-state-v1|${secret}`).digest();
}

// Descifra <dir>/*.enc → <dir>/* (y borra los .enc). Un estado viejo sin
// cifrar (archivos .json sueltos) se deja como está.
function openState(dir) {
  const key = stateKey();
  let n = 0;
  for (const file of walk(dir)) {
    if (!file.endsWith('.enc')) continue;
    fs.writeFileSync(file.slice(0, -4), open(fs.readFileSync(file), key));
    fs.rmSync(file);
    n++;
  }
  console.log(`Estado: ${n} archivos descifrados`);
}

// Cifra <dir>/*.json en <out>/*.json.enc (deja <dir> intacto: el paso del
// historial sigue usándolo). Lo que sobre en <out> se borra.
function sealState(dir, out) {
  const key = stateKey();
  fs.mkdirSync(out, { recursive: true });
  const keep = new Set(['.git']);
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    if (rel.split(path.sep)[0] === '.git') continue;
    const dest = path.join(out, `${rel}.enc`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, seal(fs.readFileSync(file), 'STATE000', key));
    keep.add(`${rel}.enc`);
  }
  for (const file of walk(out)) {
    const rel = path.relative(out, file);
    if (!keep.has(rel) && rel.split(path.sep)[0] !== '.git') fs.rmSync(file);
  }
  console.log(`Estado: ${keep.size - 1} archivos cifrados en ${out}`);
}

// ---------------- datos del sitio ----------------

const bogotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const hashEmail = (e) => crypto.createHash('sha256').update(String(e).toLowerCase()).digest('hex').slice(0, 16);
const newKeyId = () => crypto.randomBytes(6).toString('base64url').slice(0, 8);

// Decide si hay que cambiar la llave: no hay, cambió el día (Bogotá), o
// alguien que tenía acceso ya no lo tiene (se venció o se le quitó).
function nextVault(prev, members, today) {
  const now = members.map(hashEmail).sort();
  const lost = (prev?.members || []).filter((h) => !now.includes(h));
  const reason = !prev?.cur ? 'primera llave' : prev.day !== today ? 'día nuevo' : lost.length ? `${lost.length} acceso(s) terminado(s)` : null;
  if (!reason) return { vault: { ...prev, members: now }, reason: null };
  const id = newKeyId();
  const keys = { [id]: crypto.randomBytes(32).toString('base64') };
  // La anterior se conserva un rato: quien tenga la página abierta con datos
  // viejos puede seguir leyéndolos hasta que lleguen los nuevos.
  if (prev?.cur && prev.keys?.[prev.cur]) keys[prev.cur] = prev.keys[prev.cur];
  return { vault: { cur: id, keys, day: today, members: now }, reason };
}

async function sealSite() {
  const notify = require('./notify');
  const token = await notify.botToken();
  const members = [...(await notify.activeMembers(token))];
  const prev = fs.existsSync(VAULT_STATE) ? JSON.parse(fs.readFileSync(VAULT_STATE, 'utf8')) : null;
  const { vault, reason } = nextVault(prev, members, bogotaDay());
  if (reason) console.log(`Llave del sitio nueva (${reason})`);

  // Primero la llave en Firestore: si eso falla, NO se publica nada cifrado
  // con una llave que nadie podría leer (el paso falla y no se publica).
  const doc = { cur: vault.cur, keys: vault.keys, at: new Date().toISOString() };
  const r = await fetch(`${notify.DOCS}/vault/key`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify(doc) } } })
  });
  if (!r.ok) throw new Error(`No se pudo guardar la llave en Firestore: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  fs.mkdirSync(path.dirname(VAULT_STATE), { recursive: true });
  fs.writeFileSync(VAULT_STATE, JSON.stringify(vault));

  const key = Buffer.from(vault.keys[vault.cur], 'base64');
  let n = 0;
  let bytes = 0;
  for (const file of walk(SITE_DATA)) {
    const buf = fs.readFileSync(file);
    if (isSealed(buf)) continue;
    const out = seal(buf, vault.cur, key);
    fs.writeFileSync(file, out);
    n++;
    bytes += out.length;
  }
  console.log(`Datos del sitio: ${n} archivos cifrados (${Math.round(bytes / 1024)} KB), ${members.length} miembros activos + admin`);
}

module.exports = { seal, open, isSealed, nextVault, hashEmail, sealSite };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const run = cmd === 'seal-site' ? sealSite() : cmd === 'open-state' ? openState(a) : cmd === 'seal-state' ? sealState(a, b) : Promise.reject(new Error(`Orden desconocida: ${cmd}`));
  Promise.resolve(run).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
