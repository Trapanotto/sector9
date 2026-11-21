// Workstream B checks: bake format + size budget, lightmap / probe / env sanity, per-zone luminance plausibility,
// material table consistency. Node only, ~1 s.
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { SURF } from '../src/world/layout/surfaces.js';
import { ENV_SIZE, PROBE_GRID } from '../src/world/skymodel.js';

const MAX_BAKE_MB = 12;

export default async ({ W, ok, warn }) => {
  const dir = 'public/bake';
  if (!ok(existsSync(`${dir}/manifest.json`), 'bake manifest missing')) return;
  const m = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  ok(m.version >= 3, `bake version ${m.version} < 3 (re-bake with the current scripts/bake.mjs)`);
  // ---- files + size budget
  let total = 0;
  for (const f of ['lm_day.bin', 'lm_art.bin', 'vlight.bin', 'probes.bin', 'env.bin']) {
    if (!ok(existsSync(`${dir}/${f}`), `bake file ${f} missing`)) return;
    total += readFileSync(`${dir}/${f}`).length;
  }
  ok(total <= MAX_BAKE_MB * 1048576, `committed bake ${(total / 1048576).toFixed(2)} MB > ${MAX_BAKE_MB} MB`);
  const inf = (f) => inflateSync(readFileSync(`${dir}/${f}`));
  // ---- lightmaps: size, valid RGBM, no NaN-equivalents (alpha 0 with colour), luminance statistics
  const AW = m.lightmap.width, AH = m.lightmap.height;
  ok(AW === W.lm.width && AH === W.lm.height, 'lightmap size differs from the generated atlas');
  const R = m.lightmap.range;
  for (const layer of ['day', 'art']) {
    const d = inf(m.lightmap[layer]);
    if (!ok(d.length === AW * AH * 4, `lm_${layer}: ${d.length} bytes, expected ${AW * AH * 4}`)) continue;
    let bad = 0;
    for (let i = 0; i < AW * AH; i++) if (d[i * 4 + 3] === 0 && (d[i * 4] | d[i * 4 + 1] | d[i * 4 + 2])) bad++;
    ok(bad === 0, `lm_${layer}: ${bad} malformed RGBM texels`);
    if (layer === 'day') {
      // seams/noise proxy: mean absolute luminance step between horizontal neighbours inside face rects
      let steps = 0, n = 0;
      const lum = (i) => (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) * d[i * 4 + 3] / 65025 * R;
      for (const f of W.faces) {
        if (!f.lm) continue;
        const [rx, ry, rw, rh] = f.lmRect;
        for (let j = 0; j < rh; j += 3) for (let i = 0; i < rw - 1; i++) {
          const a = lum((ry + j) * AW + rx + i), b = lum((ry + j) * AW + rx + i + 1);
          if (a < 1.0 && b < 1.0) { steps += Math.abs(a - b) / (0.02 + (a + b) / 2); n++; }   // indirect-lit texels only
        }
      }
      const rough = steps / Math.max(1, n);
      ok(rough < 0.08, `lightmap indirect light too noisy: mean relative neighbour step ${rough.toFixed(3)} (≥ 0.08)`);
    }
  }
  // ---- vertex light + probes + env sizes
  const nv = m.vertexLight.vertices;
  ok(inf(m.vertexLight.file).length === nv * 8, 'vlight.bin size mismatch');
  const [px, py, pz] = m.probes.dims, np = px * py * pz;
  ok(JSON.stringify(m.probes.dims) === JSON.stringify(PROBE_GRID.dims) && m.probes.spacing === PROBE_GRID.spacing, 'probe grid differs from PROBE_GRID (runtime leak-free sampler)');
  const pb = inf(m.probes.file);
  ok(pb.length === np * 12, 'probes.bin size mismatch');
  ok(m.env && m.env.size === ENV_SIZE && m.env.width === 6 * ENV_SIZE && m.env.height === W.zones.length * ENV_SIZE, 'env cube atlas layout');
  const eb = inf(m.env.file);
  ok(eb.length === m.env.width * m.env.height * 8, 'env.bin size mismatch');
  // probes inside the building must not be black in the day+art sum (unfilled holes)
  let black = 0, inside = 0;
  for (let z = 16; z < 16 + 64; z += 2) for (let x = 16; x < 16 + 96; x += 2) {
    const y = 4 + 2;   // ~2 m above the ground floor
    const i = x + px * (y + py * z);
    inside++;
    if (pb[i * 4 + 3] === 0 && pb[np * 8 + i * 4 + 3] === 0) black++;
  }
  ok(black / inside < 0.15, `probes: ${(100 * black / inside).toFixed(0)} % of ground-floor probes are black`);
  // ---- per-zone luminance plausibility (manifest.stats from the bake)
  const st = m.stats ?? {};
  for (const z of W.zones) {
    const s = st[z.id];
    if (!s || !s.texels) { warn(false, `zone ${z.id}: no lightmap texels`); continue; }
    const lit = s.meanDay + s.meanArt;
    if (z.acoustic === 'outdoor') ok(s.meanDay > 0.8 && s.meanDay < 12, `outdoor zone ${z.id}: mean day light ${s.meanDay} out of 0.8..12`);
    else {
      ok(lit < 3, `zone ${z.id}: mean light ${lit.toFixed(3)} implausibly bright for an interior (light leak?)`);
      warn(lit > 0.002 || z.id === 'akl', `zone ${z.id}: almost black (${lit.toFixed(4)}) with all circuits on`);
    }
  }
  // ---- material table
  const keys = Object.keys(SURF);
  ok(keys.length <= 32, `${keys.length} surfaces > 32 (shader table)`);
  const mats = JSON.parse(readFileSync('public/assets/materials/materials.json', 'utf8'));
  const names = new Set(mats.layers.map((l) => l.name));
  ok(mats.layers.length <= 16, 'more than 16 material layers');
  for (const [k, s] of Object.entries(SURF)) ok(!s.mat || names.has(s.mat[0]), `SURF.${k}: unknown material layer ${s.mat?.[0]}`);
  for (const l of mats.layers) for (const k of ['a', 'n']) ok(existsSync(`public/assets/materials/${l.name}_${k}.webp`), `material ${l.name}_${k}.webp missing`);
  warn(!m.quick, 'committed bake is a --quick bake');
};
