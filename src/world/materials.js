// Texture loading (Poly Haven CC0 sets from public/assets, see scripts/fetch-assets.mjs) and the shared material library.
// Missing files fall back to procedural canvas textures so the game always starts.
import * as THREE from 'three';

function assetBase() {
  let base = '/';
  try { base = import.meta.env.BASE_URL || '/'; } catch { /* not under Vite */ }
  return base.replace(/\/?$/, '/') + 'assets/';
}
export const ASSET_BASE = assetBase();

// Texture sets. size: max decode resolution per map (2k diffuse only on large surfaces to keep VRAM sane).
const SETS = {
  floor:      { diff: 2048, nor: 2048, arm: 1024, fallback: [118, 116, 110] },
  wall:       { diff: 2048, nor: 1024, arm: 1024, fallback: [150, 146, 132] },
  brick:      { diff: 2048, nor: 1024, arm: 1024, fallback: [120, 72, 56] },
  rust:       { diff: 1024, nor: 1024, arm: 1024, fallback: [110, 70, 45] },
  corrugated: { diff: 2048, nor: 1024, arm: 1024, fallback: [105, 90, 78] },
  plate:      { diff: 1024, nor: 1024, arm: 1024, fallback: [96, 98, 100] },
  wood:       { diff: 1024, nor: 1024, arm: 1024, fallback: [112, 88, 62] },
  asphalt:    { diff: 2048, nor: 1024, arm: 1024, fallback: [70, 70, 72] },
  ceiling:    { diff: 2048, nor: 1024, arm: 1024, fallback: [128, 126, 122] },
  paint:      { diff: 1024, nor: 1024, arm: 1024, fallback: [70, 96, 80] },
  lino:       { diff: 1024, nor: 1024, arm: 1024, fallback: [120, 112, 96] },
};

// Material library. scale = metres per texture repeat (world-space UVs), env = envMapIntensity
// (interiors get little IBL so openings read bright and rooms dim — that contrast drives the bodycam auto-exposure).
export const MATS = {
  floor:        { set: 'floor', scale: 2.6, env: 0.32, surface: 'concrete', color: 0x7d7b78 },
  wall:         { set: 'wall', scale: 3.0, env: 0.30, surface: 'concrete' },
  wallOffice:   { set: 'wall', scale: 3.0, env: 0.30, surface: 'concrete', color: 0xe6dcc6 },
  brick:        { set: 'brick', scale: 2.2, env: 1.0, surface: 'concrete' },
  brickIn:      { set: 'brick', scale: 2.2, env: 0.30, surface: 'concrete', color: 0xb8b0a8 },
  rust:         { set: 'rust', scale: 2.0, env: 0.40, surface: 'metal' },
  corrugated:   { set: 'corrugated', scale: 2.0, env: 0.40, surface: 'metal' },
  corrugatedOut:{ set: 'corrugated', scale: 2.0, env: 1.0, surface: 'metal' },
  plate:        { set: 'plate', scale: 1.4, env: 0.45, surface: 'metal' },
  steel:        { set: 'plate', scale: 1.0, env: 0.45, surface: 'metal', color: 0x7a7c80 },
  wood:         { set: 'wood', scale: 1.6, env: 0.35, surface: 'wood' },
  woodDark:     { set: 'wood', scale: 1.6, env: 0.35, surface: 'wood', color: 0x8a7a6a },
  asphalt:      { set: 'asphalt', scale: 4.0, env: 1.0, surface: 'concrete' },
  ceiling:      { set: 'ceiling', scale: 3.0, env: 0.30, surface: 'concrete', color: 0xb4b2ae },
  concreteOut:  { set: 'ceiling', scale: 3.0, env: 1.0, surface: 'concrete' },
  paint:        { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal' },
  paintBlue:    { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0x9fb4d8 },
  paintRed:     { set: 'rust', scale: 1.2, env: 0.40, surface: 'metal', color: 0xd06050 },
  paintGrey:    { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0xc8c8c0 },
  yellow:       { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0xffd66a, noMap: true, base: 0xb89a2a, rough: 0.6 },
  lino:         { set: 'lino', scale: 2.2, env: 0.32, surface: 'concrete' },
  rubber:       { set: null, env: 0.2, surface: 'concrete', base: 0x161616, rough: 0.8 },
  paper:        { set: null, env: 0.3, surface: 'wood', base: 0xb8b2a2, rough: 0.95, side: THREE.DoubleSide },
  dark:         { set: 'plate', scale: 1.0, env: 0.3, surface: 'metal', color: 0x303236 },
  barrel:       { set: 'rust', scale: 1.0, env: 0.4, surface: 'metal' },
  cardboard:    { set: 'wood', scale: 0.8, env: 0.3, surface: 'wood', color: 0xc49a6c, rough: 0.95 },
  glassDark:    { set: null, env: 0.8, surface: 'metal', base: 0x151a1c, rough: 0.25 },
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// Procedural fallback texture: blotchy noise in the set's base colour.
function fallbackTexture(rgb, seed) {
  const N = 256;
  const c = makeCanvas(N, N);
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const coarse = new Float32Array(17 * 17).map(() => rnd());
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * 16, fy = (y / N) * 16, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const a = coarse[iy * 17 + ix], b = coarse[iy * 17 + ix + 1], cc = coarse[(iy + 1) * 17 + ix], d = coarse[(iy + 1) * 17 + ix + 1];
    const v = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
    const k = 0.75 + 0.35 * v + (rnd() - 0.5) * 0.12;
    const i = (y * N + x) * 4;
    img.data[i] = rgb[0] * k; img.data[i + 1] = rgb[1] * k; img.data[i + 2] = rgb[2] * k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function loadImage(url, size) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'flipY', resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
    } catch { /* options unsupported -> plain decode below */ }
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  img.__needsFlip = true;
  return img;
}

function toTexture(image, srgb, aniso) {
  const t = new THREE.Texture(image);
  t.flipY = !!image.__needsFlip;      // ImageBitmaps are flipped at decode time
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Loads all texture sets listed in the manifest and builds the material library.
 * @returns {Promise<{ mats: Record<string, THREE.MeshStandardMaterial>, scales: Record<string, number>, surfaces: Record<string,string>, missing: string[] }>}
 */
export async function loadMaterials(renderer, onProgress = () => {}) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
  let manifest = null;
  try {
    const r = await fetch(ASSET_BASE + 'manifest.json');
    if (r.ok) manifest = await r.json();
  } catch { /* offline / not fetched */ }
  if (!manifest) console.warn('[world] assets/manifest.json missing — using procedural textures. Run: npm run assets');

  const tex = {};
  const missing = [];
  const jobs = [];
  for (const [key, cfg] of Object.entries(SETS)) {
    tex[key] = {};
    const entry = manifest?.textures?.[key];
    for (const slot of ['diff', 'nor', 'arm']) {
      const rel = entry?.maps?.[slot];
      if (!rel) { if (slot === 'diff') missing.push(key); continue; }
      jobs.push({ key, slot, url: ASSET_BASE + rel, size: cfg[slot] || 1024 });
    }
    if (!entry?.maps?.arm && entry?.maps?.rough) jobs.push({ key, slot: 'arm', url: ASSET_BASE + entry.maps.rough, size: 1024 });
  }
  let done = 0;
  const total = jobs.length || 1;
  await Promise.all(jobs.map(async (j) => {
    try {
      const img = await loadImage(j.url, j.size);
      tex[j.key][j.slot] = toTexture(img, j.slot === 'diff', aniso);
    } catch (e) {
      console.warn('[world] texture failed', j.url, e.message);
      if (j.slot === 'diff') missing.push(j.key);
    }
    done++;
    onProgress(done / total, 'Texturen');
  }));

  let seed = 1;
  for (const [key, cfg] of Object.entries(SETS)) {
    if (!tex[key].diff) {
      tex[key].diff = fallbackTexture(cfg.fallback, seed++);
      tex[key].diff.wrapS = tex[key].diff.wrapT = THREE.RepeatWrapping;
      tex[key].diff.anisotropy = aniso;
    }
  }

  const mats = {}, scales = {}, surfaces = {};
  for (const [key, d] of Object.entries(MATS)) {
    const t = d.set ? tex[d.set] : null;
    const m = new THREE.MeshStandardMaterial({
      color: d.noMap ? (d.base ?? 0xffffff) : (d.color ?? (d.set ? 0xffffff : d.base)),
      map: d.noMap || !t ? null : t.diff,
      normalMap: t?.nor ?? null,
      roughness: 1, metalness: t?.arm ? 1 : 0,
      vertexColors: true,
      side: d.side ?? THREE.FrontSide,
    });
    if (t?.arm) {
      m.aoMap = t.arm; m.aoMapIntensity = 1.0;   // R
      m.roughnessMap = t.arm;                      // G
      m.metalnessMap = t.arm;                      // B
    } else {
      m.roughness = d.rough ?? 0.85; m.metalness = d.surface === 'metal' && d.set ? 0.3 : 0;
    }
    if (d.rough !== undefined && t?.arm) m.roughness = d.rough / 0.8;
    if (m.normalMap) m.normalScale.set(1, 1);
    m.envMapIntensity = d.env ?? 0.4;
    m.name = key;
    mats[key] = m;
    scales[key] = d.scale ?? 2;
    surfaces[key] = d.surface ?? 'concrete';
  }
  return { mats, scales, surfaces, missing: [...new Set(missing)], tex };
}

export { makeCanvas };
