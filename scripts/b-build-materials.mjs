// Builds the world material layers (public/assets/materials/*): 512² albedo (RGB) + 512² normal/roughness
// (R,G = tangent-space normal xy, B = roughness) per layer, plus materials.json (layer order, mean linear albedo
// used to normalise the texture so the bake's flat SURF colour stays the average). Owner: B.
//
//   node scripts/b-build-materials.mjs [--url http://localhost:5183/]     (needs a running dev server: `npx vite`)
//
// Photo layers are CC0 Poly Haven textures from v1 (git history 083b978, see CREDITS.md), extracted with
// `git show` into tmp/v1tex and down-sampled in a throwaway headless browser profile. All other layers
// (trapezoidal sheet metal, sandwich panel, painted blockwork, cardboard, stretch wrap, grating, painted
// steel, flat) are generated procedurally here — deterministic, no third-party data.
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const url = (argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:5183/').replace(/\/$/, '');
const SIZE = 512;
// photo sources (Poly Haven ids, v1 paths)
const PHOTO = {
  floor: 'floor/concrete_floor_worn_001', concrete: 'ceiling/concrete_wall_008', asphalt: 'asphalt/worn_asphalt',
  plate: 'plate/metal_plate', wood: 'wood/weathered_brown_planks', lino: 'lino/old_linoleum_flooring_01',
};
// layer order = texture array index (materials.json)
const LAYERS = ['floor', 'concrete', 'asphalt', 'plate', 'wood', 'lino', 'trapez', 'sandwich', 'block', 'cardboard', 'wrap', 'grating', 'paint', 'flat'];

mkdirSync('tmp/v1tex', { recursive: true });
for (const p of Object.values(PHOTO)) for (const s of ['diff', 'arm', 'nor']) {
  const leaf = p.split('/')[1], dst = `tmp/v1tex/${leaf}_${s}.webp`;
  if (!existsSync(dst)) writeFileSync(dst, execSync(`git show 083b978:public/assets/textures/${p}_${s}.webp`, { maxBuffer: 64 << 20 }));
}

const PAGE = /* js */`async (SIZE, LAYERS, PHOTO) => {
  const cv = (w = SIZE, h = SIZE) => { const c = new OffscreenCanvas(w, h); return [c, c.getContext('2d', { willReadFrequently: true })]; };
  const load = async (u) => createImageBitmap(await (await fetch(u)).blob(), { colorSpaceConversion: 'none' });
  // deterministic tileable value noise
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function noiseGrid(n) { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; }
  function vnoise(g, n, x, y) {  // x,y in cells, wraps
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (i, j) => g[((j % n + n) % n) * n + ((i % n + n) % n)];
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  }
  function fbm(oct, base, u, v) { const l0 = Math.round(Math.log2(base / 4)); let s = 0, a = 0.5, t = 0; for (let o = 0; o < oct; o++) { const n = base << o; s += a * vnoise(G[l0 + o], n, u * n, v * n); t += a; a *= 0.5; } return s / t; }
  const G = []; for (let o = 0; o < 8; o++) G.push(noiseGrid(4 << o));
  const G2 = []; for (let o = 0; o < 8; o++) G2.push(noiseGrid(4 << o));
  function fbm2(oct, base, u, v) { const l0 = Math.round(Math.log2(base / 4)); let s = 0, a = 0.5, t = 0; for (let o = 0; o < oct; o++) { const n = base << o; s += a * vnoise(G2[l0 + o], n, u * n, v * n); t += a; a *= 0.5; } return s / t; }
  // procedural layer: f(u, v) → [r, g, b (0..1 sRGB albedo), height (0..1), rough (0..1)]
  function proc(f, hScale) {
    const A = new Uint8ClampedArray(SIZE * SIZE * 4), H = new Float32Array(SIZE * SIZE), R = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const o = f((x + 0.5) / SIZE, (y + 0.5) / SIZE), i = y * SIZE + x;
      A[i * 4] = o[0] * 255; A[i * 4 + 1] = o[1] * 255; A[i * 4 + 2] = o[2] * 255; A[i * 4 + 3] = 255;
      H[i] = o[3]; R[i] = o[4];
    }
    // normal from height (wrapping central differences)
    const N = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, h = (xx, yy) => H[((yy + SIZE) % SIZE) * SIZE + (xx + SIZE) % SIZE];
      let nx = -(h(x + 1, y) - h(x - 1, y)) * hScale, ny = -(h(x, y + 1) - h(x, y - 1)) * hScale, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l;
      N[i * 4] = (nx * 0.5 + 0.5) * 255; N[i * 4 + 1] = (-ny * 0.5 + 0.5) * 255; N[i * 4 + 2] = R[i] * 255; N[i * 4 + 3] = 255;
    }
    return [new ImageData(A, SIZE, SIZE), new ImageData(N, SIZE, SIZE)];
  }
  const cl = (x) => Math.max(0, Math.min(1, x));
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const PROC = {
    // trapezoidal sheet (tile = 1 m across, 4 ribs of 250 mm; ribs run along v)
    trapez: () => proc((u, v) => {
      const p = (u * 4) % 1;   // one pitch
      // profile: crest 0.0-0.18, web 0.18-0.3, valley 0.3-0.88, web 0.88-1.0
      let h, shade;
      if (p < 0.18) { h = 1; shade = 1.06; } else if (p < 0.3) { h = 1 - (p - 0.18) / 0.12; shade = 0.80; }
      else if (p < 0.88) { h = 0; shade = 0.97 + 0.03 * Math.sin((p - 0.3) / 0.58 * 3.14 * 3); } else { h = (p - 0.88) / 0.12; shade = 1.12; }
      const streak = fbm(5, 4, u * 0.25, v) * 0.6 + fbm2(4, 4, u * 8, v * 0.5) * 0.4;   // vertical run-off streaks
      const dirt = cl((v - 0.55) * 1.2) * 0.12 + (streak - 0.5) * 0.16;
      const c = 0.72 * shade - dirt;
      return [c * 0.97, c, c * 1.02, h, cl(0.38 + streak * 0.25)];
    }, 4),
    // sandwich panel (cold store / office partition): 1 m panels, groove at the joint, faint micro-ribs
    sandwich: () => proc((u, v) => {
      const j = Math.min(u, 1 - u) * 1000;   // mm to the joint
      const groove = j < 6 ? 0.55 + j / 6 * 0.45 : 1;
      const micro = 0.985 + 0.015 * Math.sin(u * 3.14159 * 2 * 10);
      const smudge = (fbm(5, 4, u, v) - 0.5) * 0.08 + cl((0.25 - v) * 2) * 0.06;
      const c = 0.86 * groove * micro - smudge;
      return [c, c, c * 0.99, j < 6 ? j / 6 : 1 + 0.02 * Math.sin(u * 62.8), 0.45 + smudge];
    }, 4),
    // painted concrete blockwork 390×190 mm + 10 mm joints, running bond; tile = 1.2 × 1.2 m (3 × 6 blocks)
    block: () => proc((u, v) => {
      const bx = u * 3, by = v * 6, row = Math.floor(by), xx = (bx + (row % 2) * 0.5) % 1, yy = by % 1;
      const jx = Math.min(xx, 1 - xx) * 400, jy = Math.min(yy, 1 - yy) * 200;   // mm to a joint
      const joint = Math.min(jx, jy) < 5 ? 1 : 0;
      const pores = fbm2(3, 64, u, v);
      const paint = 0.80 + (fbm(5, 4, u, v) - 0.5) * 0.06 - (pores > 0.72 ? 0.06 : 0);
      const c = joint ? paint * 0.83 : paint;
      const scuff = cl((0.12 - v) * 6) * (fbm(4, 8, u * 2, v) > 0.5 ? 0.1 : 0.03);   // base scuffs
      return [c - scuff, c - scuff, (c - scuff) * 0.97, joint ? 0 : 0.6 + pores * 0.4, 0.7 + pores * 0.2];
    }, 5),
    // corrugated cardboard: brown, faint flute lines, brown tape band across the middle, scuffs
    cardboard: () => proc((u, v) => {
      const n = fbm(5, 4, u, v), fl = 0.985 + 0.015 * Math.sin(v * 3.14159 * 2 * 60);
      let c = [0.62, 0.47, 0.30].map((x) => x * (0.92 + (n - 0.5) * 0.25) * fl);
      const tape = Math.abs(v - 0.5) < 0.045;
      if (tape) c = mixc(c, [0.70, 0.52, 0.28], 0.8);
      const print = (Math.abs(u - 0.25) < 0.08 && Math.abs(v - 0.78) < 0.05 && fbm2(2, 32, u, v) > 0.35) ? 0.55 : 1;   // stencil print
      c = c.map((x) => x * print);
      const edge = cl((0.04 - Math.min(u, 1 - u, v, 1 - v)) * 20) * 0.15;
      return [c[0] - edge, c[1] - edge, c[2] - edge, tape ? 0.55 : 0.5 + (fl - 1) * 4, tape ? 0.35 : 0.85];
    }, 3),
    // stretch wrap over a load: milky, wrinkled bands, glossy
    wrap: () => proc((u, v) => {
      const band = Math.sin(v * 3.14159 * 2 * 7 + fbm(4, 4, u, v) * 6) * 0.5 + 0.5;
      const wr = fbm2(5, 8, u * 0.5, v * 2);
      const c = 0.80 + band * 0.08 + (wr - 0.5) * 0.12;
      return [c, c * 1.0, c * 1.02, band * 0.6 + wr * 0.4, 0.22 + wr * 0.15];
    }, 1.5),
    // floor / stair grating 33×33 mm mesh (tile 0.5 m)
    grating: () => proc((u, v) => {
      const gx = (u * 15) % 1, gy = (v * 15) % 1;
      const bar = gx < 0.12 || gy < 0.2;
      const n = fbm(4, 4, u, v);
      const c = bar ? 0.75 + (n - 0.5) * 0.2 : 0.12;
      return [c, c, c * 0.98, bar ? 1 : 0, bar ? 0.5 : 0.9];
    }, 10),
    // painted / powder-coated steel: subtle orange-peel, scratches and chips to bare metal, edge grime
    paint: () => proc((u, v) => {
      const n = fbm(6, 4, u, v), peel = fbm2(3, 32, u, v);
      let c = 0.80 + (n - 0.5) * 0.06;
      const scr = Math.abs(Math.sin((u * 0.8 + v * 0.3) * 90 + fbm2(2, 4, u, v) * 40)) > 0.995 && fbm(3, 8, u, v) > 0.55;
      const chip = fbm2(5, 8, u + 0.3, v) > 0.8;
      if (chip || scr) c = 0.55;
      const grime = cl((0.15 - v) * 4) * 0.12;
      return [c - grime, c - grime, c - grime, chip ? 0.3 : 0.5 + peel * 0.05, chip || scr ? 0.45 : 0.55 + n * 0.1];
    }, 3),
    flat: () => proc((u, v) => { const n = fbm(6, 4, u, v); const c = 0.8 + (n - 0.5) * 0.1; return [c, c, c, n, 0.7 + n * 0.2]; }, 1),
  };
  const out = [];
  for (const name of LAYERS) {
    let A, N;
    if (PHOTO[name]) {
      const leaf = PHOTO[name].split('/')[1];
      const [d, a, n] = await Promise.all(['diff', 'arm', 'nor'].map((s) => load('/tmp/v1tex/' + leaf + '_' + s + '.webp')));
      const [c1, x1] = cv(); x1.imageSmoothingQuality = 'high'; x1.drawImage(d, 0, 0, SIZE, SIZE); A = x1.getImageData(0, 0, SIZE, SIZE);
      const [c2, x2] = cv(); x2.imageSmoothingQuality = 'high'; x2.drawImage(n, 0, 0, SIZE, SIZE); const nd = x2.getImageData(0, 0, SIZE, SIZE);
      const [c3, x3] = cv(); x3.imageSmoothingQuality = 'high'; x3.drawImage(a, 0, 0, SIZE, SIZE); const ad = x3.getImageData(0, 0, SIZE, SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) nd.data[i * 4 + 2] = ad.data[i * 4 + 1];   // B = roughness (ARM green)
      N = nd;
    } else [A, N] = PROC[name]();
    let m = [0, 0, 0];
    const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) m[c] += lin(A.data[i * 4 + c]);
    m = m.map((x) => x / (SIZE * SIZE));
    const enc = async (img, q) => { const [c, x] = cv(); x.putImageData(img, 0, 0); const b = await c.convertToBlob({ type: 'image/webp', quality: q }); const r = new FileReader(); return await new Promise((res) => { r.onload = () => res(r.result); r.readAsDataURL(b); }); };
    out.push({ name, mean: m.map((x) => +x.toFixed(4)), a: await enc(A, 0.86), n: await enc(N, 0.92), A, N });
  }
  // contact sheet (albedo top, normal/rough below) for review → tmp/materials_sheet.png
  const T = 128, [sc, sx] = cv(T * out.length, T * 2);
  for (let i = 0; i < out.length; i++) for (const [k, row] of [['A', 0], ['N', 1]]) { const [c, x] = cv(); x.putImageData(out[i][k], 0, 0); sx.drawImage(c, i * T, row * T, T, T); }
  const sb = await sc.convertToBlob({ type: 'image/png' }); const fr = new FileReader(); const sheet = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(sb); });
  return { sheet, layers: out.map(({ A, N, ...r }) => r) };
}`;

// ---- throwaway headless browser (same policy as browser-check.mjs)
const prof = resolve('tmp/matbuild-profile');
rmSync(prof, { recursive: true, force: true });
const exe = process.env.BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const port = 9477;
const br = spawn(exe, ['--headless=new', exe.includes('msedge') ? '--inprivate' : '--incognito', '--disable-sync', '--disable-extensions', '--no-first-run',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 75; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* */ } await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Page.navigate', { url: `${url}/tmp/v1tex/` });
await sleep(1500);
const r = await send('Runtime.evaluate', { expression: `(${PAGE})(${SIZE}, ${JSON.stringify(LAYERS)}, ${JSON.stringify(PHOTO)})`, awaitPromise: true, returnByValue: true });
ws.close(); br.kill();
if (r.result?.exceptionDetails) { console.error(r.result.exceptionDetails); process.exit(1); }
const { layers, sheet } = r.result.result.value;
writeFileSync('tmp/materials_sheet.png', Buffer.from(sheet.split(',')[1], 'base64'));
const dir = 'public/assets/materials';
mkdirSync(dir, { recursive: true });
let bytes = 0;
for (const L of layers) {
  for (const k of ['a', 'n']) { const b = Buffer.from(L[k].split(',')[1], 'base64'); writeFileSync(`${dir}/${L.name}_${k}.webp`, b); bytes += b.length; }
}
writeFileSync(`${dir}/materials.json`, JSON.stringify({ size: SIZE, layers: layers.map((L) => ({ name: L.name, mean: L.mean, source: PHOTO[L.name] ? `polyhaven:${PHOTO[L.name].split('/')[1]}` : 'procedural' })) }, null, 1));
console.log(`[materials] ${layers.length} layers, ${(bytes / 1024).toFixed(0)} KB →`, dir);
await sleep(300);
process.exit(0);
