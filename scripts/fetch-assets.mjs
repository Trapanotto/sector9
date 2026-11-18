// Downloads CC0 texture sets + one HDRI from Poly Haven (https://polyhaven.com, CC0).
// Node 18+, no dependencies (global fetch). Usage:
//     node scripts/fetch-assets.mjs          (download 2k source JPGs into node_modules/.cache/polyhaven)
//     python -I scripts/optimize-assets.py   (convert them to the WebP files the game ships + write manifest.json)
// - the raw 2k sources are cached outside public/ (git-ignored), so the shipped folder only holds optimized WebP
// - skips files already on disk (size > 0), fails soft per asset/map
// - writes node_modules/.cache/polyhaven/sources.json, which optimize-assets.py turns into public/assets/manifest.json
//   (runtime falls back to procedural textures for anything missing)

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const CACHE = join(ROOT, 'node_modules', '.cache', 'polyhaven');
const API = 'https://api.polyhaven.com/files/';
const RES = '2k';

// key = name used by the game (src/world/materials.js SETS), id = Poly Haven asset id.
// The per-map output sizes live in scripts/optimize-assets.py (SIZES) and must match SETS in materials.js.
export const TEXTURES = [
  { key: 'floor',      id: 'concrete_floor_worn_001',   use: 'main hall concrete floor' },
  { key: 'floor2',     id: 'concrete_floor_damaged_01', use: 'cracked/patched floor layer blended into the hall floor' },
  { key: 'debris',     id: 'concrete_debris',           use: 'rubble and grit drifts at wall bases, yard edges' },
  { key: 'wall',       id: 'peeling_painted_wall',      use: 'interior painted/peeling walls' },
  { key: 'brick',      id: 'factory_brick',             use: 'brick facade, brick revealed under broken plaster' },
  { key: 'rust',       id: 'rusty_metal_sheet',         use: 'machinery, doors, tanks' },
  { key: 'corrugated', id: 'rusty_corrugated_iron',     use: 'roof sheets, fences, shed walls' },
  { key: 'plate',      id: 'metal_plate',               use: 'catwalk, floor plates' },
  { key: 'wood',       id: 'weathered_brown_planks',    use: 'crates, pallets, boards' },
  { key: 'asphalt',    id: 'worn_asphalt',              use: 'outdoor yard' },
  { key: 'ceiling',    id: 'concrete_wall_008',         use: 'ceilings, pillars, raw concrete' },
  { key: 'paint',      id: 'green_metal_rust',          use: 'painted machine housings, lockers' },
  { key: 'lino',       id: 'old_linoleum_flooring_01',  use: 'office / locker room floors' },
];
export const HDRI = { key: 'sky', id: 'hanger_exterior_cloudy', use: 'overcast IBL + visible sky', res: '1k' };

const MAPS = [
  { slot: 'diff', keys: ['Diffuse'] },
  { slot: 'nor', keys: ['nor_gl'] },        // OpenGL convention (+Y up), matches three.js normalScale (1, 1)
  { slot: 'arm', keys: ['arm'] },           // R=AO, G=roughness, B=metalness
  { slot: 'disp', keys: ['Displacement'] }, // height, packed into the ARM alpha channel by optimize-assets.py
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
  await mkdir(CACHE, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(await readFile(join(CACHE, 'sources.json'), 'utf8')); } catch {}
  const sources = { source: 'Poly Haven (polyhaven.com), all assets CC0', resolution: RES, textures: {}, hdri: null };
  let total = 0, failures = 0;

  for (const t of TEXTURES) {
    const entry = { id: t.id, use: t.use, maps: {} };
    try {
      const files = await getJson(API + t.id);
      for (const m of MAPS) {
        const f = pick(files, m.keys, RES, 'jpg') || pick(files, m.keys, RES, 'png');
        if (!f) { console.warn(`  [${t.id}] no ${m.slot} map`); continue; }
        const ext = f.url.split('.').pop();
        const rel = `${t.key}/${t.id}_${m.slot}_${RES}.${ext}`;
        try {
          const r = await download(f.url, join(CACHE, rel));
          entry.maps[m.slot] = rel; total += r.size;
          console.log(`  ${r.skipped ? 'have' : 'got '} ${rel} (${(r.size / 1e6).toFixed(2)} MB)`);
        } catch (e) { failures++; console.warn(`  [${t.id}] ${m.slot} failed: ${e.message}`); }
      }
    } catch (e) {
      failures++;
      console.warn(`[${t.id}] lookup failed: ${e.message}`);
      const old = prev.textures?.[t.key];
      if (old) for (const [slot, rel] of Object.entries(old.maps || {})) if (await exists(join(CACHE, rel))) entry.maps[slot] = rel;
    }
    if (Object.keys(entry.maps).length) sources.textures[t.key] = entry;
  }

  // HDRI goes straight to public/ (already small at 1k).
  try {
    const files = await getJson(API + HDRI.id);
    const f = files?.hdri?.[HDRI.res]?.hdr;
    if (!f) throw new Error(`no ${HDRI.res} hdr`);
    const rel = `hdri/${HDRI.id}_${HDRI.res}.hdr`;
    const r = await download(f.url, join(OUT, rel));
    sources.hdri = { id: HDRI.id, use: HDRI.use, file: rel };
    console.log(`  ${r.skipped ? 'have' : 'got '} ${rel} (${(r.size / 1e6).toFixed(2)} MB)`);
  } catch (e) {
    failures++;
    console.warn(`[${HDRI.id}] hdri failed: ${e.message}`);
    if (prev.hdri) sources.hdri = prev.hdri;
  }

  await writeFile(join(CACHE, 'sources.json'), JSON.stringify(sources, null, 2));
  console.log(`\nDone: ${Object.keys(sources.textures).length}/${TEXTURES.length} texture sets, hdri ${sources.hdri ? 'ok' : 'missing'}, ` +
    `${(total / 1e6).toFixed(1)} MB of sources, ${failures} failure(s).\nNext: python -I scripts/optimize-assets.py`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
