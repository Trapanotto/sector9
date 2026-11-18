// Downloads CC0 textures + one HDRI from Poly Haven (https://polyhaven.com, CC0) into public/assets/.
// Node 24, no dependencies (global fetch). Usage: node scripts/fetch-assets.mjs
// - skips files already on disk (size > 0)
// - fails soft per asset/map; runtime falls back to procedural textures for anything missing
// - writes public/assets/manifest.json describing what is available

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const API = 'https://api.polyhaven.com/files/';
const RES = '2k';

// key = name used by the game (src/world/materials.js), id = Poly Haven asset id
export const TEXTURES = [
  { key: 'floor',      id: 'concrete_floor_worn_001', use: 'main hall concrete floor' },
  { key: 'wall',       id: 'peeling_painted_wall',    use: 'interior painted/peeling walls' },
  { key: 'brick',      id: 'factory_brick',           use: 'exterior brick facade' },
  { key: 'rust',       id: 'rusty_metal_sheet',       use: 'machinery, doors, tanks' },
  { key: 'corrugated', id: 'rusty_corrugated_iron',   use: 'roof sheets, fences, shed walls' },
  { key: 'plate',      id: 'metal_plate',             use: 'catwalk, floor plates' },
  { key: 'wood',       id: 'weathered_brown_planks',  use: 'crates, pallets, boards' },
  { key: 'asphalt',    id: 'worn_asphalt',            use: 'outdoor yard' },
  { key: 'ceiling',    id: 'concrete_wall_008',       use: 'ceilings, pillars, raw concrete' },
  { key: 'paint',      id: 'green_metal_rust',        use: 'painted machine housings, lockers' },
  { key: 'lino',       id: 'old_linoleum_flooring_01', use: 'office / locker room floors' },
];
export const HDRI = { key: 'sky', id: 'hanger_exterior_cloudy', use: 'overcast IBL + visible sky' };

const MAPS = [
  { slot: 'diff', keys: ['Diffuse'] },
  { slot: 'nor', keys: ['nor_gl'] },
  { slot: 'arm', keys: ['arm'] },          // R=AO, G=roughness, B=metalness
  { slot: 'rough', keys: ['Rough'], onlyIfMissing: 'arm' },
];

async function exists(p) {
  try { return (await stat(p)).size > 0; } catch { return false; }
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'asset-fetch-script' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function download(url, dest) {
  if (await exists(dest)) return { skipped: true, size: (await stat(dest)).size };
  const r = await fetch(url, { headers: { 'User-Agent': 'asset-fetch-script' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { skipped: false, size: buf.length };
}

function pick(files, keys, res, fmt) {
  for (const k of keys) {
    const f = files?.[k]?.[res]?.[fmt];
    if (f?.url) return f;
  }
  return null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8')); } catch {}
  const manifest = {
    source: 'Poly Haven (polyhaven.com), all assets CC0',
    generated: new Date().toISOString(),
    resolution: RES,
    textures: {},
    hdri: null,
  };
  let total = 0, failures = 0;

  for (const t of TEXTURES) {
    const entry = { id: t.id, use: t.use, maps: {} };
    try {
      const files = await getJson(API + t.id);
      for (const m of MAPS) {
        if (m.onlyIfMissing && entry.maps[m.onlyIfMissing]) continue;
        const f = pick(files, m.keys, RES, 'jpg');
        if (!f) { console.warn(`  [${t.id}] no ${m.slot} map`); continue; }
        const rel = `textures/${t.key}/${t.id}_${m.slot}_${RES}.jpg`;
        try {
          const r = await download(f.url, join(OUT, rel));
          entry.maps[m.slot] = rel; total += r.size;
          console.log(`  ${r.skipped ? 'have' : 'got '} ${rel} (${(r.size / 1e6).toFixed(2)} MB)`);
        } catch (e) { failures++; console.warn(`  [${t.id}] ${m.slot} failed: ${e.message}`); }
      }
    } catch (e) {
      failures++;
      console.warn(`[${t.id}] lookup failed: ${e.message}`);
      // keep whatever an earlier run recorded if the files are still there
      const old = prev.textures?.[t.key];
      if (old) for (const [slot, rel] of Object.entries(old.maps || {})) if (await exists(join(OUT, rel))) entry.maps[slot] = rel;
    }
    if (Object.keys(entry.maps).length) manifest.textures[t.key] = entry;
  }

  try {
    const files = await getJson(API + HDRI.id);
    const f = files?.hdri?.[RES]?.hdr;
    if (!f) throw new Error('no 2k hdr');
    const rel = `hdri/${HDRI.id}_${RES}.hdr`;
    const r = await download(f.url, join(OUT, rel));
    total += r.size;
    manifest.hdri = { id: HDRI.id, use: HDRI.use, file: rel };
    console.log(`  ${r.skipped ? 'have' : 'got '} ${rel} (${(r.size / 1e6).toFixed(2)} MB)`);
  } catch (e) {
    failures++;
    console.warn(`[${HDRI.id}] hdri failed: ${e.message}`);
    if (prev.hdri && await exists(join(OUT, prev.hdri.file))) manifest.hdri = prev.hdri;
  }

  manifest.totalBytes = total;
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone: ${Object.keys(manifest.textures).length}/${TEXTURES.length} texture sets, hdri ${manifest.hdri ? 'ok' : 'missing'}, ` +
    `${(total / 1e6).toFixed(1)} MB on disk, ${failures} failure(s).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
