// Offline light bake + PVS: `npm run bake` (owner: B for quality, core for the data format).
//
//   1. generateWorld(LAYOUT)  (identical to the runtime)
//   2. direct light per sample: sun (shadow ray) into the DAY layer, all artificial fixtures (shadow rays) into
//      the ART layer
//   3. BOUNCES gather passes: cosine rays; miss → sky radiance (day), hit → albedo × previous total at the hit
//   4. probe volume for dynamic objects (mean radiance L0, directional term, sun visibility, art L0)
//   5. zone-to-zone PVS (random + targeted visibility rays from walkable eye points)
//   6. write public/bake/*: RGBM8 (range 16) data, zlib-deflated, + manifest.json (format: CONTRACT.md §B)
//
// Samples: lightmap texels of architecture faces, the 4 corners of every vertex-lit face, probe grid points.
// Everything is deterministic (hash-seeded random numbers), parallel over worker_threads.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { LAYOUT } from '../src/world/layout/index.js';
import { generateWorld, faceCorner, boxFlags, F_OCC, F_WALK, TAN } from '../src/world/gen.js';
import { BoxBVH } from '../src/world/bvh.js';
import { skyRadiance } from '../src/world/skymodel.js';

export const BAKE_VERSION = 2;
const ARGS = process.argv.slice(2);
const QUICK = ARGS.includes('--quick');
const P = {
  lmRays: QUICK ? 24 : 96,       // gather rays per lightmap texel / vertex
  probeRays: QUICK ? 24 : 64,
  bounces: QUICK ? 1 : 2,
  rgbmRange: 16,
  probe: { origin: [-16, -4, -16], spacing: 1, dims: [129, 19, 127] },
  pvsRandom: QUICK ? 600 : 3000,  // random rays per zone
  pvsTargeted: QUICK ? 60 : 240,  // targeted rays per (zone, zone) pair
  pvsEyes: QUICK ? 24 : 64,
};

// ------------------------------------------------------------------------------------------------------------
// Shared scene setup (main + workers)
function setupScene() {
  const W = generateWorld(LAYOUT);
  const occFlags = new Uint8Array(W.boxes.length);
  W.boxes.forEach((b, i) => { occFlags[i] = boxFlags(b); });
  const bvh = new BoxBVH(W.boxes, occFlags);
  // face lookup per (box, side)
  const nb = W.boxes.length, nf = W.faces.length;
  const boxSideFace = new Int32Array(nb * 6).fill(-1);
  W.faces.forEach((f, i) => { boxSideFace[f.box * 6 + f.side] = i; });
  const albedo = new Float32Array(nb * 3);
  W.boxes.forEach((b, i) => albedo.set(b.color, i * 3));
  // vertex-lit faces get 4 consecutive vertex samples
  const vbase = new Int32Array(nf).fill(-1);
  let nv = 0;
  W.faces.forEach((f, i) => { if (f.render === 'vl' || f.render === 'mesh') { vbase[i] = nv; nv += 4; } });
  return { W, bvh, boxSideFace, albedo, vbase, nv };
}

function rngFor(seed) {
  let s = (seed ^ 0x9E3779B9) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ------------------------------------------------------------------------------------------------------------
if (isMainThread) await main();
else worker();

async function main() {
  const t0 = performance.now();
  const S = setupScene();
  const { W, nv } = S;
  const AW = W.lm.width, AH = W.lm.height;
  console.log(`[bake] world ${W.hash}: ${W.boxes.length} boxes, ${W.faces.length} faces, atlas ${AW}x${AH} (${W.lm.texels} texels), ${nv} vertex samples`);

  // --- samples
  const samples = [];  // packed later
  const lmFaces = W.faces.map((f, i) => [f, i]).filter(([f]) => f.lm);
  let nLm = 0; for (const [f] of lmFaces) nLm += f.lmRect[2] * f.lmRect[3];
  const pd = P.probe.dims, np = pd[0] * pd[1] * pd[2];
  const ns = nLm + nv + np;
  const sPos = new Float32Array(new SharedArrayBuffer(ns * 12));
  const sNrm = new Int8Array(new SharedArrayBuffer(ns * 3));
  const sRef = new Int32Array(new SharedArrayBuffer(ns * 4));   // lm: atlas texel; vert: vertex idx; probe: probe idx
  const sFace = new Int32Array(new SharedArrayBuffer(ns * 4));  // owning face (-1 for probes)
  let k = 0;
  const c = [0, 0, 0];
  for (const [f, fi] of lmFaces) {
    const [rx, ry, rw, rh] = f.lmRect, n = f.pos ? 1 : -1;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
      c[f.axis] = f.plane + n * 0.01;
      c[f.ua] = f.u0 + (i + 0.5) / rw * (f.u1 - f.u0);
      c[f.va] = f.v0 + (j + 0.5) / rh * (f.v1 - f.v0);
      sPos.set(c, k * 3); sNrm[k * 3 + f.axis] = n; sRef[k] = (ry + j) * AW + rx + i; sFace[k] = fi; k++;
    }
  }
  const kV = k;
  W.faces.forEach((f, fi) => {
    const vb = S.vbase[fi]; if (vb < 0) return;
    const n = f.pos ? 1 : -1;
    const du = Math.min(0.04, (f.u1 - f.u0) * 0.25), dv = Math.min(0.04, (f.v1 - f.v0) * 0.25);
    for (let q = 0; q < 4; q++) {
      faceCorner(f, q, c);
      c[f.ua] += q === 0 || q === 3 ? du : -du; c[f.va] += q < 2 ? dv : -dv; c[f.axis] += n * 0.01;
      sPos.set(c, k * 3); sNrm[k * 3 + f.axis] = n; sRef[k] = vb + q; sFace[k] = fi; k++;
    }
  });
  const kP = k;
  for (let z = 0; z < pd[2]; z++) for (let y = 0; y < pd[1]; y++) for (let x = 0; x < pd[0]; x++) {
    sPos[k * 3] = P.probe.origin[0] + x * P.probe.spacing; sPos[k * 3 + 1] = P.probe.origin[1] + y * P.probe.spacing;
    sPos[k * 3 + 2] = P.probe.origin[2] + z * P.probe.spacing;
    sRef[k] = x + pd[0] * (y + pd[1] * z); sFace[k] = -1; k++;
  }

  const sh = (n) => new Float32Array(new SharedArrayBuffer(n * 4));
  const buf = {
    sPos, sNrm, sRef, sFace,
    valid: new Uint8Array(new SharedArrayBuffer(ns)),
    lmDirD: sh(AW * AH * 3), lmDirA: sh(AW * AH * 3), lmTotD: sh(AW * AH * 3), lmTotA: sh(AW * AH * 3),
    lmIndD: sh(AW * AH * 3), lmIndA: sh(AW * AH * 3),
    vDirD: sh(nv * 3), vDirA: sh(nv * 3), vTotD: sh(nv * 3), vTotA: sh(nv * 3), vIndD: sh(nv * 3), vIndA: sh(nv * 3),
    pL0D: sh(np * 3), pDir: sh(np * 3), pSun: sh(np), pL0A: sh(np * 3),
    pvs: new Uint8Array(new SharedArrayBuffer(W.zones.length * W.zones.length)),
  };
  const nW = Math.max(1, Math.min(cpus().length - 1, 23));
  const workers = [];
  for (let i = 0; i < nW; i++) {
    workers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { buf, P, ns, kV, kP, AW, AH } }));
  }
  await Promise.all(workers.map((w) => new Promise((res) => w.once('message', res))));   // ready
  const runJobs = async (type, total, chunk) => {
    let next = 0, done = 0;
    const t = performance.now();
    await new Promise((resolve) => {
      const feed = (w) => {
        if (next >= total) { if (done >= total) resolve(); return; }
        const s = next, e = Math.min(total, next + chunk); next = e;
        w.once('message', (m) => { done += m.n; feed(w); if (done >= total) resolve(); });
        w.postMessage({ type, s, e });
      };
      workers.forEach(feed);
    });
    console.log(`[bake] ${type.padEnd(8)} ${total} items  ${((performance.now() - t) / 1000).toFixed(1)} s`);
  };
  const nSurf = kP;
  await runJobs('direct', ns, 4096);
  // total = direct
  buf.lmTotD.set(buf.lmDirD); buf.lmTotA.set(buf.lmDirA); buf.vTotD.set(buf.vDirD); buf.vTotA.set(buf.vDirA);
  for (let b = 0; b < P.bounces; b++) {
    await runJobs('gather', nSurf, 1024);
    for (let i = 0; i < buf.lmTotD.length; i++) { buf.lmTotD[i] = buf.lmDirD[i] + buf.lmIndD[i]; buf.lmTotA[i] = buf.lmDirA[i] + buf.lmIndA[i]; }
    for (let i = 0; i < buf.vTotD.length; i++) { buf.vTotD[i] = buf.vDirD[i] + buf.vIndD[i]; buf.vTotA[i] = buf.vDirA[i] + buf.vIndA[i]; }
  }
  await runJobs('probe', np, 2048);
  await runJobs('pvs', W.zones.length, 1);
  for (const w of workers) w.terminate();

  // --- post: fill invalid texels, denoise, dilate gutters, encode
  const lmMask = new Uint8Array(AW * AH);     // 1 = valid sample, 2 = inner but invalid
  for (let i = 0; i < kV; i++) lmMask[sRef[i]] = buf.valid[i] ? 1 : 2;
  const lmRects = lmFaces.map(([f]) => f.lmRect);
  const postLm = (A) => {
    for (const r of lmRects) { fillInvalid(A, lmMask, AW, r); denoise(A, AW, r); dilate(A, AW, r); }
  };
  postLm(buf.lmTotD); postLm(buf.lmTotA);
  // vertex samples: invalid corners take the mean of the valid corners of the same face
  for (let i = kV; i < kP; i += 4) {
    for (const A of [buf.vTotD, buf.vTotA]) {
      let n = 0; const m = [0, 0, 0];
      for (let q = 0; q < 4; q++) if (buf.valid[i + q]) { n++; for (let ch = 0; ch < 3; ch++) m[ch] += A[sRef[i + q] * 3 + ch]; }
      for (let q = 0; q < 4; q++) if (!buf.valid[i + q]) for (let ch = 0; ch < 3; ch++) A[sRef[i + q] * 3 + ch] = n ? m[ch] / n : 0.02;
    }
  }
  // probes: invalid (inside geometry) → average of valid neighbours, iterated
  fillProbes(buf, pd, kP, ns);

  const R = P.rgbmRange;
  const out = 'public/bake';
  mkdirSync(out, { recursive: true });
  const files = {};
  const put = (name, bytes) => { const z = deflateSync(bytes, { level: 9 }); writeFileSync(`${out}/${name}`, z); files[name] = { bytes: z.length, raw: bytes.length }; };
  put('lm_day.bin', rgbm(buf.lmTotD, R)); put('lm_art.bin', rgbm(buf.lmTotA, R));
  put('vlight.bin', concat(rgbm(buf.vTotD, R), rgbm(buf.vTotA, R)));
  const pDirSun = new Uint8Array(np * 4);
  for (let i = 0; i < np; i++) {
    for (let ch = 0; ch < 3; ch++) pDirSun[i * 4 + ch] = Math.round((Math.max(-1, Math.min(1, buf.pDir[i * 3 + ch])) * 0.5 + 0.5) * 255);
    pDirSun[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, buf.pSun[i])) * 255);
  }
  put('probes.bin', concat(rgbm(buf.pL0D, R), pDirSun, rgbm(buf.pL0A, R)));

  const nz = W.zones.length, pvs = {};
  for (let a = 0; a < nz; a++) {
    const vis = [];
    for (let b = 0; b < nz; b++) if (a === b || buf.pvs[a * nz + b]) vis.push(W.zones[b].id);
    pvs[W.zones[a].id] = vis;
  }
  const manifest = {
    format: 'sector9-bake', version: BAKE_VERSION, hash: W.hash, created: new Date().toISOString(),
    quick: QUICK, params: P,
    lightmap: { width: AW, height: AH, encoding: 'rgbm8', range: R, day: 'lm_day.bin', art: 'lm_art.bin' },
    vertexLight: { file: 'vlight.bin', vertices: nv, encoding: 'rgbm8', range: R, layout: 'day[nv*4] then art[nv*4]' },
    probes: { file: 'probes.bin', ...P.probe, encoding: 'rgbm8', range: R,
      layout: 'L0day rgbm[n*4], dir.xyz*0.5+0.5 + sunVis [n*4], L0art rgbm[n*4]; x fastest, then y, then z' },
    pvs, files,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
  };
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
  console.log(`[bake] done in ${manifest.seconds} s →`, Object.entries(files).map(([n, f]) => `${n} ${(f.bytes / 1024).toFixed(0)} KB`).join(', '));
}

function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n);
  let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; }
  return o;
}
function rgbm(A, R) {
  const n = A.length / 3, o = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = Math.max(0, A[i * 3]), g = Math.max(0, A[i * 3 + 1]), b = Math.max(0, A[i * 3 + 2]);
    let m = Math.min(1, Math.max(r, g, b, 1e-6) / R);
    m = Math.ceil(m * 255) / 255;
    const s = 1 / (m * R);
    o[i * 4] = Math.min(255, Math.round(r * s * 255)); o[i * 4 + 1] = Math.min(255, Math.round(g * s * 255));
    o[i * 4 + 2] = Math.min(255, Math.round(b * s * 255)); o[i * 4 + 3] = Math.round(m * 255);
  }
  return o;
}
function fillInvalid(A, mask, AW, [rx, ry, rw, rh]) {
  for (let it = 0; it < 8; it++) {
    let left = 0;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
      const t = (ry + j) * AW + rx + i;
      if (mask[t] !== 2) continue;
      let n = 0, r = 0, g = 0, b = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= rw || jj >= rh) continue;
        const u = (ry + jj) * AW + rx + ii;
        if (mask[u] !== 1) continue;
        n++; r += A[u * 3]; g += A[u * 3 + 1]; b += A[u * 3 + 2];
      }
      if (n) { A[t * 3] = r / n; A[t * 3 + 1] = g / n; A[t * 3 + 2] = b / n; mask[t] = 3; } else left++;
    }
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) { const t = (ry + j) * AW + rx + i; if (mask[t] === 3) mask[t] = 1; }
    if (!left) break;
  }
}
function denoise(A, AW, [rx, ry, rw, rh]) {
  // 3x3 box filter within the rect (keeps sharp face borders: never mixes faces)
  if (rw < 3 && rh < 3) return;
  const tmp = new Float32Array(rw * rh * 3);
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= rw || jj >= rh) continue;
      const w = di === 0 && dj === 0 ? 2 : 1, u = ((ry + jj) * AW + rx + ii) * 3;
      n += w; r += A[u] * w; g += A[u + 1] * w; b += A[u + 2] * w;
    }
    tmp[(j * rw + i) * 3] = r / n; tmp[(j * rw + i) * 3 + 1] = g / n; tmp[(j * rw + i) * 3 + 2] = b / n;
  }
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const u = ((ry + j) * AW + rx + i) * 3, s = (j * rw + i) * 3;
    A[u] = tmp[s]; A[u + 1] = tmp[s + 1]; A[u + 2] = tmp[s + 2];
  }
}
function dilate(A, AW, [rx, ry, rw, rh]) {
  const cp = (dx, dy, sx, sy) => { const d = (dy * AW + dx) * 3, s = (sy * AW + sx) * 3; A[d] = A[s]; A[d + 1] = A[s + 1]; A[d + 2] = A[s + 2]; };
  for (let i = -1; i <= rw; i++) {
    const si = Math.max(0, Math.min(rw - 1, i));
    cp(rx + i, ry - 1, rx + si, ry); cp(rx + i, ry + rh, rx + si, ry + rh - 1);
  }
  for (let j = 0; j < rh; j++) { cp(rx - 1, ry + j, rx, ry + j); cp(rx + rw, ry + j, rx + rw - 1, ry + j); }
}
function fillProbes(buf, pd, kP, ns) {
  const np = pd[0] * pd[1] * pd[2];
  const ok = new Uint8Array(np);
  for (let i = kP; i < ns; i++) ok[buf.sRef[i]] = buf.valid[i];
  const arrs = [[buf.pL0D, 3], [buf.pDir, 3], [buf.pSun, 1], [buf.pL0A, 3]];
  for (let it = 0; it < 6; it++) {
    const add = [];
    for (let z = 0; z < pd[2]; z++) for (let y = 0; y < pd[1]; y++) for (let x = 0; x < pd[0]; x++) {
      const i = x + pd[0] * (y + pd[1] * z);
      if (ok[i]) continue;
      const nb = [];
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= pd[0] || Y >= pd[1] || Z >= pd[2]) continue;
        const j = X + pd[0] * (Y + pd[1] * Z);
        if (ok[j] === 1) nb.push(j);
      }
      if (!nb.length) continue;
      for (const [A, w] of arrs) for (let ch = 0; ch < w; ch++) { let s = 0; for (const j of nb) s += A[j * w + ch]; A[i * w + ch] = s / nb.length; }
      add.push(i);
    }
    for (const i of add) ok[i] = 1;
    if (!add.length) break;
  }
}

// ------------------------------------------------------------------------------------------------------------
// Worker
function worker() {
  const { buf, P, kV, kP, AW } = workerData;
  const S = setupScene();
  const { W, bvh, boxSideFace, albedo, vbase } = S;
  const L = W.layout, sun = L.sun, sky = L.sky;
  const sd = sun.dir, sunC = sun.color.map((c) => c * sun.intensity);
  const fx = L.fixtures.map((f) => ({ ...f, range: f.range ?? 8, aim: f.type === 'flood' ? norm([0, -0.6, 1]) : null }));
  const faces = W.faces, boxes = W.boxes;
  const hit = { t: 0, side: 0 };
  const sk = [0, 0, 0];
  const MASK = F_OCC;
  const tmpC = [0, 0, 0];
  const pd = P.probe.dims;

  function insideOcc(x, y, z) {
    let inside = false;
    bvh.query(x, y, z, x, y, z, MASK, (b) => {
      const o = b * 3;
      if (x > bvh.bmin[o] + 1e-4 && x < bvh.bmax[o] - 1e-4 && y > bvh.bmin[o + 1] + 1e-4 && y < bvh.bmax[o + 1] - 1e-4 && z > bvh.bmin[o + 2] + 1e-4 && z < bvh.bmax[o + 2] - 1e-4) inside = true;
    });
    return inside;
  }
  function artDirect(x, y, z, nx, ny, nz, out, omni) {
    out[0] = out[1] = out[2] = 0;
    for (const f of fx) {
      const lx = f.pos[0] - x, ly = f.pos[1] - 0.2 - y, lz = f.pos[2] - z;
      const d2 = lx * lx + ly * ly + lz * lz;
      if (d2 > f.range * f.range) continue;
      const d = Math.sqrt(d2), ux = lx / d, uy = ly / d, uz = lz / d;
      const cosS = omni ? 0.25 : ux * nx + uy * ny + uz * nz;
      if (cosS <= 0) continue;
      // emission lobe (direction from light to sample = -u)
      let lobe;
      // lobes: luminaires emit downwards (uy > 0 = sample below the light); a little spill sideways, none upwards
      if (f.type === 'highbay') lobe = uy > 0 ? 0.04 + 0.96 * Math.pow(uy, 1.5) : 0;
      else if (f.type === 'tube') lobe = uy > -0.05 ? 0.08 + 0.92 * Math.max(0, uy) : 0;
      else if (f.type === 'flood') lobe = Math.pow(Math.max(0, -(ux * f.aim[0] + uy * f.aim[1] + uz * f.aim[2])), 4);
      else lobe = 1;
      if (lobe <= 0) continue;
      const win = Math.pow(Math.max(0, 1 - Math.pow(d / f.range, 4)), 2);
      const e = f.intensity * lobe * cosS * win / Math.max(d2, 0.3);
      if (e < 1e-4) continue;
      if (bvh.occluded(x, y, z, lx, ly, lz, 0.999, MASK)) continue;
      out[0] += e * f.color[0]; out[1] += e * f.color[1]; out[2] += e * f.color[2];
    }
  }
  // value (previous total) at a hit point of box b, side s; writes into o (day, art)
  function hitValue(b, s, px, py, pz, oD, oA) {
    const fi = boxSideFace[b * 6 + s];
    if (fi < 0) { oD[0] = oD[1] = oD[2] = oA[0] = oA[1] = oA[2] = 0; return; }
    const f = faces[fi];
    const p = [px, py, pz];
    const fu = Math.max(0, Math.min(1, (p[f.ua] - f.u0) / (f.u1 - f.u0))), fv = Math.max(0, Math.min(1, (p[f.va] - f.v0) / (f.v1 - f.v0)));
    if (f.lm) {
      const [rx, ry, rw, rh] = f.lmRect;
      const i = Math.min(rw - 1, Math.floor(fu * rw)), j = Math.min(rh - 1, Math.floor(fv * rh));
      const t = ((ry + j) * AW + rx + i) * 3;
      for (let c = 0; c < 3; c++) { oD[c] = buf.lmTotD[t + c]; oA[c] = buf.lmTotA[t + c]; }
    } else {
      const vb = vbase[fi];
      if (vb < 0) { oD[0] = oD[1] = oD[2] = oA[0] = oA[1] = oA[2] = 0; return; }
      const w0 = (1 - fu) * (1 - fv), w1 = fu * (1 - fv), w2 = fu * fv, w3 = (1 - fu) * fv;
      for (let c = 0; c < 3; c++) {
        oD[c] = w0 * buf.vTotD[vb * 3 + c] + w1 * buf.vTotD[(vb + 1) * 3 + c] + w2 * buf.vTotD[(vb + 2) * 3 + c] + w3 * buf.vTotD[(vb + 3) * 3 + c];
        oA[c] = w0 * buf.vTotA[vb * 3 + c] + w1 * buf.vTotA[(vb + 1) * 3 + c] + w2 * buf.vTotA[(vb + 2) * 3 + c] + w3 * buf.vTotA[(vb + 3) * 3 + c];
      }
    }
    // also: emissive faces are not light sources in the bake (their light comes from FIXTURES)
    const a = b * 3;
    for (let c = 0; c < 3; c++) { oD[c] *= albedo[a + c]; oA[c] *= albedo[a + c]; }
  }

  const hD = [0, 0, 0], hA = [0, 0, 0], art = [0, 0, 0];
  function direct(i) {
    const x = buf.sPos[i * 3], y = buf.sPos[i * 3 + 1], z = buf.sPos[i * 3 + 2];
    const valid = !insideOcc(x, y, z);
    buf.valid[i] = valid ? 1 : 0;
    if (i >= kP) return;   // probes are done in the probe pass
    const nx = buf.sNrm[i * 3], ny = buf.sNrm[i * 3 + 1], nz = buf.sNrm[i * 3 + 2];
    let dD0 = 0, dD1 = 0, dD2 = 0;
    const cs = nx * sd[0] + ny * sd[1] + nz * sd[2];
    if (valid && cs > 0 && !bvh.occluded(x, y, z, sd[0], sd[1], sd[2], 1000, MASK)) { dD0 = sunC[0] * cs; dD1 = sunC[1] * cs; dD2 = sunC[2] * cs; }
    if (valid) artDirect(x, y, z, nx, ny, nz, art, false); else art[0] = art[1] = art[2] = 0;
    const r = buf.sRef[i];
    const [D, A] = i < kV ? [buf.lmDirD, buf.lmDirA] : [buf.vDirD, buf.vDirA];
    D[r * 3] = dD0; D[r * 3 + 1] = dD1; D[r * 3 + 2] = dD2;
    A[r * 3] = art[0]; A[r * 3 + 1] = art[1]; A[r * 3 + 2] = art[2];
  }
  function gather(i) {
    const r = buf.sRef[i];
    const [ID, IA] = i < kV ? [buf.lmIndD, buf.lmIndA] : [buf.vIndD, buf.vIndA];
    if (!buf.valid[i]) { for (let c = 0; c < 3; c++) { ID[r * 3 + c] = 0; IA[r * 3 + c] = 0; } return; }
    const x = buf.sPos[i * 3], y = buf.sPos[i * 3 + 1], z = buf.sPos[i * 3 + 2];
    const nx = buf.sNrm[i * 3], ny = buf.sNrm[i * 3 + 1], nz = buf.sNrm[i * 3 + 2];
    // tangent frame for an axis-aligned normal
    let tx, ty, tz;
    if (Math.abs(ny) > 0.5) { tx = 1; ty = 0; tz = 0; } else { tx = 0; ty = 1; tz = 0; }
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const rnd = rngFor(i * 7919 + 17);
    let aD0 = 0, aD1 = 0, aD2 = 0, aA0 = 0, aA1 = 0, aA2 = 0;
    const N = P.lmRays;
    for (let k = 0; k < N; k++) {
      // stratified cosine-weighted hemisphere
      const u1 = (k + rnd()) / N, u2 = rnd();
      const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2;
      const a = rr * Math.cos(ph), bq = rr * Math.sin(ph), cz = Math.sqrt(Math.max(0, 1 - u1));
      const dx = a * tx + bq * bx + cz * nx, dy = a * ty + bq * by + cz * ny, dz = a * tz + bq * bz + cz * nz;
      const b = bvh.raycast(x, y, z, dx, dy, dz, 2000, MASK, hit);
      if (b < 0) { skyRadiance(sky, sun, dx, dy, dz, sk); aD0 += sk[0]; aD1 += sk[1]; aD2 += sk[2]; continue; }
      hitValue(b, hit.side, x + dx * hit.t, y + dy * hit.t, z + dz * hit.t, hD, hA);
      aD0 += hD[0]; aD1 += hD[1]; aD2 += hD[2]; aA0 += hA[0]; aA1 += hA[1]; aA2 += hA[2];
    }
    ID[r * 3] = aD0 / N; ID[r * 3 + 1] = aD1 / N; ID[r * 3 + 2] = aD2 / N;
    IA[r * 3] = aA0 / N; IA[r * 3 + 1] = aA1 / N; IA[r * 3 + 2] = aA2 / N;
  }
  function probe(pi) {
    const i = kP + pi;
    const x = buf.sPos[i * 3], y = buf.sPos[i * 3 + 1], z = buf.sPos[i * 3 + 2];
    const r = buf.sRef[i];
    const valid = !insideOcc(x, y, z);
    buf.valid[i] = valid ? 1 : 0;
    if (!valid) return;
    const rnd = rngFor(r * 104729 + 3);
    let L0 = [0, 0, 0], LA = [0, 0, 0], d = [0, 0, 0], lumSum = 0;
    const N = P.probeRays;
    for (let k = 0; k < N; k++) {
      const u1 = (k + rnd()) / N, u2 = rnd();
      const dy = 1 - 2 * u1, rr = Math.sqrt(Math.max(0, 1 - dy * dy)), ph = 2 * Math.PI * u2;
      const dx = rr * Math.cos(ph), dz = rr * Math.sin(ph);
      const b = bvh.raycast(x, y, z, dx, dy, dz, 2000, MASK, hit);
      if (b < 0) { skyRadiance(sky, sun, dx, dy, dz, hD); hA[0] = hA[1] = hA[2] = 0; }
      else hitValue(b, hit.side, x + dx * hit.t, y + dy * hit.t, z + dz * hit.t, hD, hA);
      for (let c = 0; c < 3; c++) { L0[c] += hD[c]; LA[c] += hA[c]; }
      const lum = 0.3 * hD[0] + 0.59 * hD[1] + 0.11 * hD[2];
      d[0] += lum * dx; d[1] += lum * dy; d[2] += lum * dz; lumSum += lum;
    }
    // direct artificial light (point sources are not hit by rays): mean over normals of max(cos,0) = 1/4
    artDirect(x, y, z, 0, 0, 0, art, true);
    for (let c = 0; c < 3; c++) { buf.pL0D[r * 3 + c] = L0[c] / N; buf.pL0A[r * 3 + c] = LA[c] / N + art[c]; }
    // directional term relative to L0 (L1 SH of luminance → irradiance: E(n) ≈ L0 (1 + v·n))
    const s = lumSum > 1e-6 ? 2 * 3 / lumSum : 0;   // (2/3) * (3 * mean(lum ω)) / mean(lum)
    for (let c = 0; c < 3; c++) buf.pDir[r * 3 + c] = Math.max(-1, Math.min(1, d[c] * s / 3));
    buf.pSun[r] = bvh.occluded(x, y, z, sd[0], sd[1], sd[2], 1000, MASK) ? 0 : 1;
  }
  // PVS: zone a sees zone b
  const nz = W.zones.length;
  const faceZone = (b, s) => { const fi = boxSideFace[b * 6 + s]; return fi >= 0 ? faces[fi].zone : boxes[b].zone; };
  // target sample points per zone: centres of random faces in that zone, weighted by area
  const zoneFaces = Array.from({ length: nz }, () => []);
  faces.forEach((f, fi) => { if (f.render !== 'mesh') zoneFaces[f.zone].push(fi); });
  function eyes(a, rnd, n) {
    const out = [], parts = W.zones[a].parts;
    for (let tries = 0; tries < n * 40 && out.length < n; tries++) {
      const p = parts[Math.floor(rnd() * parts.length)];
      const x = p[0] + rnd() * (p[3] - p[0]), z = p[2] + rnd() * (p[5] - p[2]);
      // floor below the top of the part
      const top = Math.min(p[4], p[1] + 6) - 0.05;
      const b = bvh.raycast(x, top, z, 0, -1, 0, top - p[1] + 0.6, F_WALK, hit);
      if (b < 0) continue;
      const fy = top - hit.t;
      const ey = fy + 0.4 + rnd() * 1.5;
      if (ey > p[4] - 0.05 || insideOcc(x, ey, z)) continue;
      // needs headroom: nothing solid right above the floor at body height
      if (bvh.occluded(x, fy + 0.05, z, 0, 1, 0, 1.6, MASK)) continue;
      out.push([x, ey, z]);
    }
    return out;
  }
  function pvs(a) {
    const rnd = rngFor(a * 31337 + 5);
    const E = eyes(a, rnd, P.pvsEyes);
    if (!E.length) { console.warn(`[bake] zone ${W.zones[a].id}: no eye points`); return; }
    const vis = new Uint8Array(nz); vis[a] = 1;
    for (let k = 0; k < P.pvsRandom; k++) {
      const e = E[k % E.length];
      const dy = 1 - 2 * rnd(), rr = Math.sqrt(1 - dy * dy), ph = 2 * Math.PI * rnd();
      const b = bvh.raycast(e[0], e[1], e[2], rr * Math.cos(ph), dy, rr * Math.sin(ph), 1000, MASK, hit);
      if (b >= 0) vis[faceZone(b, hit.side)] = 1;
    }
    const q = [0, 0, 0];
    for (let z = 0; z < nz; z++) {
      if (vis[z]) continue;
      const fl = zoneFaces[z];
      if (!fl.length) continue;
      for (let k = 0; k < P.pvsTargeted && !vis[z]; k++) {
        const f = faces[fl[Math.floor(rnd() * fl.length)]];
        q[f.axis] = f.plane + (f.pos ? 0.02 : -0.02);
        q[f.ua] = f.u0 + rnd() * (f.u1 - f.u0); q[f.va] = f.v0 + rnd() * (f.v1 - f.v0);
        const e = E[Math.floor(rnd() * E.length)];
        const dx = q[0] - e[0], dy = q[1] - e[1], dz = q[2] - e[2];
        const b = bvh.raycast(e[0], e[1], e[2], dx, dy, dz, 1.0, MASK, hit);
        if (b < 0 || hit.t > 0.995) vis[z] = 1;
        else if (faceZone(b, hit.side) === z) vis[z] = 1;
        else vis[faceZone(b, hit.side)] = 1;
      }
    }
    for (let z = 0; z < nz; z++) buf.pvs[a * nz + z] = vis[z];
  }

  parentPort.on('message', (m) => {
    if (m.type === 'direct') for (let i = m.s; i < m.e; i++) direct(i);
    else if (m.type === 'gather') for (let i = m.s; i < m.e; i++) gather(i);
    else if (m.type === 'probe') for (let i = m.s; i < m.e; i++) probe(i);
    else if (m.type === 'pvs') for (let i = m.s; i < m.e; i++) pvs(i);
    parentPort.postMessage({ n: m.e - m.s });
  });
  parentPort.postMessage({ ready: true });
}
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
