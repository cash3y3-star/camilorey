// ============================================================
// CamiloRey — recorte de fondo de las fotos de jugadores
// Igual que el sitio anterior: @imgly/background-removal-node (un modelo
// de IA que corre local en el runner de GitHub Actions, sin API externa
// ni costo). Cada jugador se procesa UNA sola vez; el resultado queda en
// site/cutouts/{id}.webp (rama "cutouts" del repo, solo crece cuando
// aparece un jugador nuevo).
//
// Prioridad: jugadores de los picks pendientes y del calendario, luego
// el resto de jugadores conocidos. Tope por corrida para no tardar.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'cutouts');
const MAX_PER_RUN = Number(process.env.CUTOUTS_MAX || 80);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const { removeBackground } = require('@imgly/background-removal-node');
  const sharp = require('sharp');
  fs.mkdirSync(OUT, { recursive: true });
  // El modelo viene dentro del paquete; por defecto lo busca en
  // ./node_modules del directorio actual, que acá no existe (se instala
  // aparte, con caché). Se le pasa la ruta real.
  // El archivo principal del paquete vive en dist/, junto a resources.json.
  const distDir = path.dirname(require.resolve('@imgly/background-removal-node'));
  console.log(`Modelo en: ${distDir}`);
  const config = { publicPath: `file://${distDir}/`, output: { format: 'image/png' } };
  fs.rmSync(path.join(OUT, 'failed.json'), { force: true });

  const players = readJson(path.join(ROOT, 'data', 'players.json'), {});
  const matches = readJson(path.join(ROOT, 'data', 'matches.json'), {});
  const picks = readJson(path.join(ROOT, 'data', 'picks.json'), {});

  // Orden: primero los que tienen pick pendiente, después los de partidos
  // recientes/próximos, al final el resto.
  const soon = Date.now() - 2 * 86400e3;
  const score = new Map();
  for (const [id, p] of Object.entries(picks)) {
    const m = matches[id];
    if (!m) continue;
    const w = p.res === 'pending' ? 3 : 1;
    for (const pid of [m.a, m.b]) score.set(pid, Math.max(score.get(pid) || 0, w));
  }
  for (const m of Object.values(matches)) {
    if (new Date(m.at).getTime() < soon) continue;
    for (const pid of [m.a, m.b]) score.set(pid, Math.max(score.get(pid) || 0, 2));
  }
  const todo = Object.entries(players)
    .filter(([id, p]) => p.av && !fs.existsSync(path.join(OUT, `${id}.webp`)))
    .sort((a, b) => (score.get(Number(b[0])) || 0) - (score.get(Number(a[0])) || 0))
    .slice(0, MAX_PER_RUN);

  console.log(`Jugadores sin recorte: ${todo.length} a procesar en esta corrida`);
  let ok = 0;
  let fails = 0;
  for (const [id, p] of todo) {
    try {
      const blob = await removeBackground(p.av, config);
      const png = Buffer.from(await blob.arrayBuffer());
      await sharp(png).trim({ threshold: 1 }).resize({ height: 420, withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(OUT, `${id}.webp`));
      ok++;
      console.log(`  ✓ ${p.n} (${id})`);
    } catch (e) {
      console.error(`  ✗ ${p.n} (${id}): ${e.message}`);
      // Si fallan los 3 primeros es un problema general (no de una foto): cortar.
      if (++fails >= 3 && ok === 0) throw new Error('El recortador no funciona, se detiene la corrida');
    }
  }
  console.log(`Recortes nuevos: ${ok}`);
  await makeThumbs(players, sharp);
  await makeMids(sharp);
}

// Recortes medianos (260 px de alto, ~8 KB) para las tarjetas chicas
// (campeones, seguidos): el recorte completo (420 px, ~25 KB) queda solo
// para el perfil del jugador. Salen del recorte ya hecho: rápido, sin IA.
async function makeMids(sharp) {
  const dir = path.join(OUT, 'mid');
  fs.mkdirSync(dir, { recursive: true });
  const todo = fs.readdirSync(OUT).filter((f) => f.endsWith('.webp') && !fs.existsSync(path.join(dir, f)));
  let ok = 0;
  for (const f of todo) {
    try {
      await sharp(path.join(OUT, f)).resize({ height: 260, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(dir, f));
      ok++;
    } catch (e) {
      console.error(`  mediano ${f}: ${e.message}`);
    }
  }
  console.log(`Recortes medianos nuevos: ${ok}`);
}

// Miniaturas livianas de la foto de cada jugador (160x160 WebP, ~6 KB) para
// los avatares chicos: la foto original de tt.league-pro.com pesa 150-300 KB
// y en pantalla se ve de 36-72 px. No usa IA, así que se hacen muchas por
// corrida.
async function makeThumbs(players, sharp) {
  const dir = path.join(OUT, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const todo = Object.entries(players)
    .filter(([id, p]) => p.av && !fs.existsSync(path.join(dir, `${id}.webp`)))
    .slice(0, Number(process.env.THUMBS_MAX || 600));
  let ok = 0;
  for (const [id, p] of todo) {
    try {
      const r = await fetch(p.av);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await sharp(buf).resize(160, 160, { fit: 'cover', position: 'top' }).webp({ quality: 74 }).toFile(path.join(dir, `${id}.webp`));
      ok++;
    } catch (e) {
      console.error(`  miniatura ${p.n} (${id}): ${e.message}`);
    }
  }
  console.log(`Miniaturas nuevas: ${ok} (pendientes: ${Math.max(0, todo.length - ok)})`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
