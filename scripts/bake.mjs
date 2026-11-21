// Offline light bake + PVS: `npm run bake` (owner: B for quality, core for the data format).
//
//   1. generateWorld(LAYOUT)  (identical to the runtime)
//   2. DIRECT light per lightmap texel / prop vertex: sun with soft shadows (sub-texel positions × jittered sun
//      disc, glass transmission) into the DAY layer; every artificial fixture as a small area light (jittered
//      points on the luminaire, emission lobe, windowed inverse-square falloff) into the ART layer
//   3. INDIRECT: cosine-weighted gather passes (one per bounce) on HALF-RESOLUTION lightmap blocks (2×2 texels)
//      and on every prop vertex; miss → sky radiance (× glass transmission), hit → albedo × previous total.
//      After each bounce the indirect term is denoised in WORLD SPACE per plane: all coplanar lightmap faces
//      are splatted into one grid, filtered with a separable Gaussian that stops at walls (cells without a
//      valid sample) and is edge-guided by a short-range occlusion (AO) term, then read back. This removes the
//      Monte-Carlo noise AND the seams between neighbouring faces without blurring light through walls.
//   4. probe volume for dynamic objects (mean radiance L0, luminance-weighted direction, sun visibility, art L0)
//   5. per-zone environment cubes (16² per face, prefiltered, day + art) for cheap specular reflections
//   6. zone-to-zone PVS (random + targeted visibility rays from walkable eye points)
//   7. write public/bake/*: RGBM8 (range 16) data, zlib-deflated, + manifest.json (format: CONTRACT.md §8)
//
// Units: lightmaps store irradiance/π ("radiance factor"): outgoing radiance = albedo × value. Everything is
// deterministic (hash-seeded random numbers, fixed job order), parallel over worker_threads. Works unattended on
// any layout: new prop types / surfaces need nothing but their SURF colour (unknown surfaces bake as 50 % grey).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { LAYOUT } from '../src/world/layout/index.js';
import { generateWorld, faceCorner, boxFlags, F_OCC, F_WALK, TAN } from '../src/world/gen.js';
import { BoxBVH } from '../src/world/bvh.js';
import { skyRadiance, GLASS_T, ENV_SIZE, PROBE_GRID } from '../src/world/skymodel.js';

export const BAKE_VERSION = 3;
const ARGS = process.argv.slice(2);
const QUICK = ARGS.includes('--quick');
const P = {
  sunSamples: QUICK ? 2 : 9,          // sub-texel positions × sun-disc directions per texel
  sunRadius: 0.012,                   // sun disc radius (rad) incl. a little skylight diffusion
  artSamples: QUICK ? 1 : 4,          // points on each luminaire (soft fixture shadows)
  gatherRays: QUICK ? [40] : [128, 256],   // cosine rays per gather point, one entry per bounce (last = final)
  probeRays: QUICK ? 48 : 192,
  envRays: QUICK ? 6 : 24,
  filterRadius: 0.6,                  // m, world-space indirect denoise radius (Gaussian σ = radius / 2)
  aoRange: 1.2,                       // m, short-range occlusion used as the filter's edge guide
  rgbmRange: 16,
  probe: PROBE_GRID,
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
  W.boxes.forEach((b, i) => albedo.set((b.color ?? [0.5, 0.5, 0.5]).map((c) => Math.min(0.9, Math.max(0, c))), i * 3));
  // vertex-lit faces get 4 consecutive vertex samples
  const vbase = new Int32Array(nf).fill(-1);
  let nv = 0;
  W.faces.forEach((f, i) => { if (f.render === 'vl' || f.render === 'mesh') { vbase[i] = nv; nv += 4; } });
  // glass panes (sun / sky through windows and skylights is attenuated)
  const glass = new Float32Array(W.glass.length * 6);
  W.glass.forEach((g, i) => { glass.set(g.min, i * 6); glass.set(g.max, i * 6 + 3); });
  return { W, bvh, boxSideFace, albedo, vbase, nv, glass };
}

function rngFor(seed) {
  let s = (seed ^ 0x9E3779B9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0; s = (s ^ (s >>> 16)) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ------------------------------------------------------------------------------------------------------------
if (isMainThread) await main();
else worker();

async function main() {
  const t0 = performance.now();
  const S = setupScene();
  const { W, nv, bvh } = S;
  const AW = W.lm.width, AH = W.lm.height;
  console.log(`[bake] world ${W.hash}: ${W.boxes.length} boxes, ${W.faces.length} faces, atlas ${AW}x${AH} (${W.lm.texels} texels), ${nv} vertex samples${QUICK ? '  (QUICK)' : ''}`);

  // --- samples: lightmap texels, prop vertices, probes
  const lmFaces = W.faces.map((f, i) => [f, i]).filter(([f]) => f.lm);
  let nLm = 0; for (const [f] of lmFaces) nLm += f.lmRect[2] * f.lmRect[3];
  const pd = P.probe.dims, np = pd[0] * pd[1] * pd[2];
  const ns = nLm + nv + np;
  const SAB = (bytes) => new SharedArrayBuffer(bytes);
  const sPos = new Float32Array(SAB(ns * 12));
  const sNrm = new Int8Array(SAB(ns * 3));
  const sRef = new Int32Array(SAB(ns * 4));   // lm: atlas texel; vert: vertex idx; probe: probe idx
  const sFace = new Int32Array(SAB(ns * 4));  // owning face (-1 for probes)
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

  const sh = (n) => new Float32Array(SAB(n * 4));
  const nz = W.zones.length, ES = ENV_SIZE;
  const maxG = kV + nv;
  const buf = {
    sPos, sNrm, sRef, sFace,
    valid: new Uint8Array(SAB(ns)),
    lmDirD: sh(AW * AH * 3), lmDirA: sh(AW * AH * 3), lmTotD: sh(AW * AH * 3), lmTotA: sh(AW * AH * 3),
    vDirD: sh(nv * 3), vDirA: sh(nv * 3), vTotD: sh(nv * 3), vTotA: sh(nv * 3),
    // gather points (half-res lightmap blocks + prop vertices), filled after the direct pass
    gPos: sh(maxG * 3), gNrm: new Int8Array(SAB(maxG * 3)), gD: sh(maxG * 3), gA: sh(maxG * 3), gAO: sh(maxG),
    pL0D: sh(np * 3), pDir: sh(np * 3), pSun: sh(np), pL0A: sh(np * 3),
    envD: sh(nz * 6 * ES * ES * 3), envA: sh(nz * 6 * ES * ES * 3), envPos: sh(nz * 3),
    pvs: new Uint8Array(SAB(nz * nz)),
  };
  const nW = Math.max(1, Math.min(cpus().length - 1, 31));
  const workers = [];
  for (let i = 0; i < nW; i++) {
    workers.push(new Worker(fileURLToPath(import.meta.url), { workerData: { buf, P, ns, kV, kP, AW, AH } }));
  }
  await Promise.all(workers.map((w) => new Promise((res) => w.once('message', res))));   // ready
  const runJobs = async (type, total, chunk, extra = {}) => {
    let next = 0, done = 0;
    const t = performance.now();
    if (total > 0) await new Promise((resolve) => {
      const feed = (w) => {
        if (next >= total) return;
        const s = next, e = Math.min(total, next + chunk); next = e;
        w.once('message', (m) => { done += m.n; if (done >= total) resolve(); else feed(w); });
        w.postMessage({ type, s, e, ...extra });
      };
      workers.forEach(feed);
    });
    console.log(`[bake] ${type.padEnd(8)} ${String(total).padStart(8)} items  ${((performance.now() - t) / 1000).toFixed(1)} s`);
  };
  const tm = (label, fn) => { const t = performance.now(); const r = fn(); console.log(`[bake] ${label.padEnd(8)} ${((performance.now() - t) / 1000).toFixed(1)} s`); return r; };

  // ---- 1. direct light
  await runJobs('direct', kP, 2048);
  const lmMask = new Uint8Array(AW * AH);     // 1 = valid sample, 2 = inner but invalid (inside geometry)
  for (let i = 0; i < kV; i++) lmMask[sRef[i]] = buf.valid[i] ? 1 : 2;
  const lmRects = lmFaces.map(([f]) => f.lmRect);
  const fillAll = (A) => { const m = lmMask.slice(); for (const r of lmRects) fillInvalid(A, m, AW, r); };
  tm('fill', () => { fillAll(buf.lmDirD); fillAll(buf.lmDirA); fixVertices(buf.vDirD, buf.vDirA, buf.valid, sRef, kV, kP); });
  buf.lmTotD.set(buf.lmDirD); buf.lmTotA.set(buf.lmDirA); buf.vTotD.set(buf.vDirD); buf.vTotA.set(buf.vDirA);

  // ---- 2. gather points: one per 2×2 block of valid lightmap texels, then every prop vertex sample
  const texSample = new Int32Array(AW * AH).fill(-1);   // atlas texel → sample index
  for (let i = 0; i < kV; i++) texSample[sRef[i]] = i;
  const gTex = [];   // per lightmap gather point: atlas texels it covers
  let ng = 0;
  const setG = (x, y, z, n) => { buf.gPos[ng * 3] = x; buf.gPos[ng * 3 + 1] = y; buf.gPos[ng * 3 + 2] = z; buf.gNrm.set(n, ng * 3); ng++; };
  for (const [f] of lmFaces) {
    const [rx, ry, rw, rh] = f.lmRect;
    for (let bj = 0; bj < rh; bj += 2) for (let bi = 0; bi < rw; bi += 2) {
      const tex = []; let mx = 0, my = 0, mz = 0;
      for (let j = bj; j < Math.min(rh, bj + 2); j++) for (let i = bi; i < Math.min(rw, bi + 2); i++) {
        const t = (ry + j) * AW + rx + i;
        if (lmMask[t] !== 1) continue;
        const si = texSample[t];
        tex.push(t); mx += sPos[si * 3]; my += sPos[si * 3 + 1]; mz += sPos[si * 3 + 2];
      }
      if (!tex.length) continue;
      mx /= tex.length; my /= tex.length; mz /= tex.length;
      if (insidePoint(bvh, mx, my, mz)) { const si = texSample[tex[0]]; mx = sPos[si * 3]; my = sPos[si * 3 + 1]; mz = sPos[si * 3 + 2]; }
      const si = texSample[tex[0]];
      setG(mx, my, mz, [sNrm[si * 3], sNrm[si * 3 + 1], sNrm[si * 3 + 2]]);
      gTex.push(tex);
    }
  }
  const nGL = ng;
  for (let i = kV; i < kP; i++) setG(sPos[i * 3], sPos[i * 3 + 1], sPos[i * 3 + 2], [sNrm[i * 3], sNrm[i * 3 + 1], sNrm[i * 3 + 2]]);
  console.log(`[bake] gather points: ${nGL} lightmap blocks + ${ng - nGL} prop vertices`);

  // ---- 3. bounces
  AWG = AW;
  const planes = tm('planes', () => buildPlanes(lmFaces, AW));
  const indD = new Float32Array(AW * AH * 3), indA = new Float32Array(AW * AH * 3), aoT = new Float32Array(AW * AH);
  for (let b = 0; b < P.gatherRays.length; b++) {
    await runJobs('gather', ng, 1024, { rays: P.gatherRays[b] });
    tm('denoise', () => {
      for (let g = 0; g < nGL; g++) for (const t of gTex[g]) {
        for (let ch = 0; ch < 3; ch++) { indD[t * 3 + ch] = buf.gD[g * 3 + ch]; indA[t * 3 + ch] = buf.gA[g * 3 + ch]; }
        aoT[t] = buf.gAO[g];
      }
      for (const pl of planes) filterPlane(pl, indD, indA, aoT, lmMask, P);
      for (let i = 0; i < AW * AH * 3; i++) { buf.lmTotD[i] = buf.lmDirD[i] + indD[i]; buf.lmTotA[i] = buf.lmDirA[i] + indA[i]; }
      fillAll(buf.lmTotD); fillAll(buf.lmTotA);
      for (let i = kV; i < kP; i++) {
        const g = nGL + i - kV, r = sRef[i];
        for (let ch = 0; ch < 3; ch++) { buf.vTotD[r * 3 + ch] = buf.vDirD[r * 3 + ch] + buf.gD[g * 3 + ch]; buf.vTotA[r * 3 + ch] = buf.vDirA[r * 3 + ch] + buf.gA[g * 3 + ch]; }
      }
      fixVertices(buf.vTotD, buf.vTotA, buf.valid, sRef, kV, kP);
    });
  }
  await runJobs('probe', np, 2048);
  await runJobs('env', nz, 1);
  await runJobs('pvs', nz, 1);
  for (const w of workers) w.terminate();

  // --- post: gutters, probes
  for (const r of lmRects) { dilate(buf.lmTotD, AW, r); dilate(buf.lmTotA, AW, r); }
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
  put('env.bin', concat(rgbm(buf.envD, R), rgbm(buf.envA, R)));

  const pvs = {};
  for (let a = 0; a < nz; a++) {
    const vis = [];
    for (let b = 0; b < nz; b++) if (a === b || buf.pvs[a * nz + b]) vis.push(W.zones[b].id);
    pvs[W.zones[a].id] = vis;
  }
  // per-zone luminance statistics of the final lightmap (tests + tuning)
  const stats = zoneStats(W, lmFaces, buf.lmTotD, buf.lmTotA, lmMask, AW);
  const manifest = {
    format: 'sector9-bake', version: BAKE_VERSION, hash: W.hash, created: new Date().toISOString(),
    quick: QUICK, params: P,
    lightmap: { width: AW, height: AH, encoding: 'rgbm8', range: R, day: 'lm_day.bin', art: 'lm_art.bin' },
    vertexLight: { file: 'vlight.bin', vertices: nv, encoding: 'rgbm8', range: R, layout: 'day[nv*4] then art[nv*4]' },
    probes: { file: 'probes.bin', ...P.probe, encoding: 'rgbm8', range: R,
      layout: 'L0day rgbm[n*4], dir.xyz*0.5+0.5 + sunVis [n*4], L0art rgbm[n*4]; x fastest, then y, then z' },
    env: { file: 'env.bin', size: ES, zones: W.zones.map((z) => z.id), width: 6 * ES, height: nz * ES, encoding: 'rgbm8', range: R,
      layout: 'day rgbm[w*h*4] then art; texel (face*size + s, zone*size + t); face 0..5 = +x,-x,+y,-y,+z,-z; dir[axis]=±1, dir[TAN[axis]] = (s,t)*2-1',
      capture: Array.from({ length: nz }, (_, i) => Array.from(buf.envPos.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * 100) / 100)) },
    pvs, files, stats,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
  };
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
  const total = Object.values(files).reduce((s, f) => s + f.bytes, 0);
  console.log(`[bake] done in ${manifest.seconds} s →`, Object.entries(files).map(([n, f]) => `${n} ${(f.bytes / 1024).toFixed(0)} KB`).join(', '), `(total ${(total / 1048576).toFixed(2)} MB)`);
}

function insidePoint(bvh, x, y, z) {
  let inside = false;
  bvh.query(x, y, z, x, y, z, F_OCC, (b) => {
    const o = b * 3;
    if (x > bvh.bmin[o] + 1e-4 && x < bvh.bmax[o] - 1e-4 && y > bvh.bmin[o + 1] + 1e-4 && y < bvh.bmax[o + 1] - 1e-4 && z > bvh.bmin[o + 2] + 1e-4 && z < bvh.bmax[o + 2] - 1e-4) inside = true;
  });
  return inside;
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
function fixVertices(D, A, valid, sRef, kV, kP) {
  // invalid corners (inside geometry) take the mean of the valid corners of the same face
  for (let i = kV; i < kP; i += 4) {
    for (const X of [D, A]) {
      let n = 0; const m = [0, 0, 0];
      for (let q = 0; q < 4; q++) if (valid[i + q]) { n++; for (let ch = 0; ch < 3; ch++) m[ch] += X[sRef[i + q] * 3 + ch]; }
      if (n === 4) continue;
      for (let q = 0; q < 4; q++) if (!valid[i + q]) for (let ch = 0; ch < 3; ch++) X[sRef[i + q] * 3 + ch] = n ? m[ch] / n : 0.01;
    }
  }
}
function fillInvalid(A, mask, AW, [rx, ry, rw, rh]) {
  for (let it = 0; it < 8; it++) {
    let left = 0, any = false;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
      const t = (ry + j) * AW + rx + i;
      if (mask[t] !== 2) continue;
      any = true;
      let n = 0, r = 0, g = 0, b = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if ((!di && !dj) || ii < 0 || jj < 0 || ii >= rw || jj >= rh) continue;
        const u = (ry + jj) * AW + rx + ii;
        if (mask[u] !== 1) continue;
        n++; r += A[u * 3]; g += A[u * 3 + 1]; b += A[u * 3 + 2];
      }
      if (n) { A[t * 3] = r / n; A[t * 3 + 1] = g / n; A[t * 3 + 2] = b / n; mask[t] = 3; } else left++;
    }
    if (!any) return;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) { const t = (ry + j) * AW + rx + i; if (mask[t] === 3) mask[t] = 1; }
    if (!left) break;
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

// ---- world-space plane grids for the indirect denoiser ------------------------------------------------------
function buildPlanes(lmFaces, AW) {
  const groups = new Map();
  for (const [f] of lmFaces) {
    const key = `${f.axis}${f.pos ? '+' : '-'}${Math.round(f.plane * 1000)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { faces: [], U0: Infinity, V0: Infinity, U1: -Infinity, V1: -Infinity, cs: Infinity }));
    g.faces.push(f);
    g.U0 = Math.min(g.U0, f.u0); g.U1 = Math.max(g.U1, f.u1); g.V0 = Math.min(g.V0, f.v0); g.V1 = Math.max(g.V1, f.v1);
    g.cs = Math.min(g.cs, (f.u1 - f.u0) / f.lmRect[2], (f.v1 - f.v0) / f.lmRect[3]);
  }
  const planes = [];
  for (const g of groups.values()) {
    let cs = Math.max(0.05, g.cs);
    let GW = Math.ceil((g.U1 - g.U0) / cs - 1e-6), GH = Math.ceil((g.V1 - g.V0) / cs - 1e-6);
    if (GW * GH > 4e6) { cs *= Math.sqrt(GW * GH / 4e6); GW = Math.ceil((g.U1 - g.U0) / cs - 1e-6); GH = Math.ceil((g.V1 - g.V0) / cs - 1e-6); }
    GW = Math.max(1, GW); GH = Math.max(1, GH);
    // texel → cell span per face (precomputed; reused every bounce)
    const spans = [];
    for (const f of g.faces) {
      const [rx, ry, rw, rh] = f.lmRect, tu = (f.u1 - f.u0) / rw, tv = (f.v1 - f.v0) / rh;
      const ci0 = new Int32Array(rw), ci1 = new Int32Array(rw), cj0 = new Int32Array(rh), cj1 = new Int32Array(rh);
      for (let i = 0; i < rw; i++) {
        const a = (f.u0 + i * tu - g.U0) / cs, b = (f.u0 + (i + 1) * tu - g.U0) / cs;
        ci0[i] = Math.max(0, Math.min(GW - 1, Math.floor(a + 1e-4))); ci1[i] = Math.max(ci0[i], Math.min(GW - 1, Math.ceil(b - 1e-4) - 1));
      }
      for (let j = 0; j < rh; j++) {
        const a = (f.v0 + j * tv - g.V0) / cs, b = (f.v0 + (j + 1) * tv - g.V0) / cs;
        cj0[j] = Math.max(0, Math.min(GH - 1, Math.floor(a + 1e-4))); cj1[j] = Math.max(cj0[j], Math.min(GH - 1, Math.ceil(b - 1e-4) - 1));
      }
      spans.push({ rx, ry, rw, rh, ci0, ci1, cj0, cj1 });
    }
    planes.push({ GW, GH, cs, spans });
  }
  return planes;
}
var FBUF = null;
function filterPlane(pl, D, A, AO, mask, P) {
  const { GW, GH, cs, spans } = pl, n = GW * GH;
  if (!FBUF || FBUF.cap < n) FBUF = { cap: n, v: new Float32Array(n * 6), w: new Float32Array(n), ao: new Float32Array(n), t: new Float32Array(n * 6) };
  const v = FBUF.v, w = FBUF.w, ao = FBUF.ao, tmp = FBUF.t;
  v.fill(0, 0, n * 6); w.fill(0, 0, n); ao.fill(0, 0, n);
  // splat valid texels
  for (const s of spans) for (let j = 0; j < s.rh; j++) for (let i = 0; i < s.rw; i++) {
    const t = (s.ry + j) * AWG + s.rx + i;
    if (mask[t] !== 1) continue;
    for (let cj = s.cj0[j]; cj <= s.cj1[j]; cj++) for (let ci = s.ci0[i]; ci <= s.ci1[i]; ci++) {
      const c = cj * GW + ci;
      for (let ch = 0; ch < 3; ch++) { v[c * 6 + ch] += D[t * 3 + ch]; v[c * 6 + 3 + ch] += A[t * 3 + ch]; }
      ao[c] += AO[t]; w[c] += 1;
    }
  }
  for (let c = 0; c < n; c++) if (w[c] > 0) { const iw = 1 / w[c]; for (let ch = 0; ch < 6; ch++) v[c * 6 + ch] *= iw; ao[c] *= iw; w[c] = 1; }
  // separable Gaussian, stopping at empty cells (walls), AO-guided
  const R = Math.max(1, Math.round(P.filterRadius / cs)), sig = Math.max(0.5, R / 2);
  const gk = new Float32Array(R + 1); for (let d = 0; d <= R; d++) gk[d] = Math.exp(-0.5 * (d / sig) * (d / sig));
  const sAO = 1 / (2 * 0.07 * 0.07);
  const pass = (src, dst, stepI, len, lines, lineStep) => {
    for (let l = 0; l < lines; l++) for (let i = 0; i < len; i++) {
      const c = l * lineStep + i * stepI;
      if (!w[c]) { for (let ch = 0; ch < 6; ch++) dst[c * 6 + ch] = src[c * 6 + ch]; continue; }
      let ws = gk[0], a0 = src[c * 6], a1 = src[c * 6 + 1], a2 = src[c * 6 + 2], a3 = src[c * 6 + 3], a4 = src[c * 6 + 4], a5 = src[c * 6 + 5];
      const aoc = ao[c];
      for (let dir = -1; dir <= 1; dir += 2) for (let d = 1; d <= R; d++) {
        const ii = i + dir * d; if (ii < 0 || ii >= len) break;
        const q = l * lineStep + ii * stepI;
        if (!w[q]) break;
        const da = ao[q] - aoc, wt = gk[d] / (1 + da * da * sAO);
        const o = q * 6;
        ws += wt; a0 += src[o] * wt; a1 += src[o + 1] * wt; a2 += src[o + 2] * wt; a3 += src[o + 3] * wt; a4 += src[o + 4] * wt; a5 += src[o + 5] * wt;
      }
      const iw = 1 / ws;
      dst[c * 6] = a0 * iw; dst[c * 6 + 1] = a1 * iw; dst[c * 6 + 2] = a2 * iw; dst[c * 6 + 3] = a3 * iw; dst[c * 6 + 4] = a4 * iw; dst[c * 6 + 5] = a5 * iw;
    }
  };
  for (let it = 0; it < 2; it++) {
    pass(v, tmp, 1, GW, GH, GW);    // along u
    pass(tmp, v, GW, GH, GW, 1);    // along v
  }
  // read back: texel = mean of the filtered cells it covers
  for (const s of spans) for (let j = 0; j < s.rh; j++) for (let i = 0; i < s.rw; i++) {
    const t = (s.ry + j) * AWG + s.rx + i;
    if (mask[t] !== 1) continue;
    let k = 0; const acc = [0, 0, 0, 0, 0, 0];
    for (let cj = s.cj0[j]; cj <= s.cj1[j]; cj++) for (let ci = s.ci0[i]; ci <= s.ci1[i]; ci++) {
      const c = cj * GW + ci; if (!w[c]) continue;
      k++; for (let ch = 0; ch < 6; ch++) acc[ch] += v[c * 6 + ch];
    }
    if (!k) continue;
    for (let ch = 0; ch < 3; ch++) { D[t * 3 + ch] = acc[ch] / k; A[t * 3 + ch] = acc[3 + ch] / k; }
  }
}
var AWG = 2048;

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
      // prefer the darker side: a probe inside a wall is mostly interpolated by the room side's points, and
      // leaking dark into sunlit exterior faces of dynamic objects is far less visible than glowing interiors
      nb.sort((a, b) => lum3(buf.pL0D, a) - lum3(buf.pL0D, b));
      const use = nb.length > 2 ? nb.slice(0, Math.ceil(nb.length / 2)) : nb;
      for (const [A, w] of arrs) for (let ch = 0; ch < w; ch++) { let s = 0; for (const j of use) s += A[j * w + ch]; A[i * w + ch] = s / use.length; }
      add.push(i);
    }
    for (const i of add) ok[i] = 1;
    if (!add.length) break;
  }
}
function lum3(A, i) { return 0.2126 * A[i * 3] + 0.7152 * A[i * 3 + 1] + 0.0722 * A[i * 3 + 2]; }

function zoneStats(W, lmFaces, D, A, mask, AW) {
  const z = W.zones.map(() => ({ n: 0, sumD: 0, sumA: 0, maxD: 0, logD: 0 }));
  for (const [f] of lmFaces) {
    const s = z[f.zone]; if (!s) continue;
    const [rx, ry, rw, rh] = f.lmRect;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
      const t = (ry + j) * AW + rx + i;
      if (mask[t] !== 1) continue;
      const d = lum3(D, t), a = lum3(A, t);
      s.n++; s.sumD += d; s.sumA += a; s.maxD = Math.max(s.maxD, d); s.logD += Math.log(d + a + 1e-4);
    }
  }
  const out = {};
  W.zones.forEach((zz, i) => {
    const s = z[i];
    out[zz.id] = s.n ? { texels: s.n, meanDay: +(s.sumD / s.n).toFixed(4), meanArt: +(s.sumA / s.n).toFixed(4), maxDay: +s.maxD.toFixed(3), geoMean: +Math.exp(s.logD / s.n).toFixed(4) } : { texels: 0 };
  });
  return out;
}

// ------------------------------------------------------------------------------------------------------------
// Worker
function worker() {
  const { buf, P, kV, kP, AW } = workerData;
  const S = setupScene();
  const { W, bvh, boxSideFace, albedo, vbase, glass } = S;
  const L = W.layout, sun = L.sun, sky = L.sky;
  const sd = sun.dir, sunC = sun.color.map((c) => c * sun.intensity);
  // sun-disc basis
  const st1 = norm(Math.abs(sd[1]) < 0.9 ? cross(sd, [0, 1, 0]) : cross(sd, [1, 0, 0])), st2 = cross(sd, st1);
  // luminaires as small area lights: centre just below the housing, half extents along x / z
  const EXT = { highbay: [0.22, 0.22, 0.2], tube: [0.68, 0.05, 0.1], bulb: [0.03, 0.03, 0.06], flood: [0.2, 0.12, 0.05] };
  const fx = L.fixtures.map((f) => {
    const e = EXT[f.type] ?? [0.05, 0.05, 0.1];
    return { ...f, range: f.range ?? 8, aim: f.type === 'flood' ? norm([0, -0.6, 1]) : null, c: [f.pos[0], f.pos[1] - e[2], f.pos[2]], ex: e[0], ez: e[1] };
  });
  const faces = W.faces, boxes = W.boxes;
  const hit = { t: 0, side: 0 };
  const sk = [0, 0, 0];
  const MASK = F_OCC;
  const ng = glass.length / 6;

  function insideOcc(x, y, z) { return insidePoint(bvh, x, y, z); }
  /** transmission of the glass panes crossed by the segment o + d·t, t ∈ (0, tmax) */
  function glassT(x, y, z, dx, dy, dz, tmax) {
    let T = 1;
    tmax = Math.min(tmax, 400);
    const ex = x + dx * tmax, ey = y + dy * tmax, ez = z + dz * tmax;
    const x0 = Math.min(x, ex), x1 = Math.max(x, ex), y0 = Math.min(y, ey), y1 = Math.max(y, ey), z0 = Math.min(z, ez), z1 = Math.max(z, ez);
    for (let g = 0; g < ng; g++) {
      const o = g * 6;
      if (glass[o] > x1 || glass[o + 3] < x0 || glass[o + 1] > y1 || glass[o + 4] < y0 || glass[o + 2] > z1 || glass[o + 5] < z0) continue;
      let t0 = 1e-4, t1 = tmax, okk = true;
      for (let a = 0; a < 3 && okk; a++) {
        const oa = a === 0 ? x : a === 1 ? y : z, da = a === 0 ? dx : a === 1 ? dy : dz;
        if (Math.abs(da) < 1e-12) { if (oa < glass[o + a] || oa > glass[o + 3 + a]) okk = false; continue; }
        let n = (glass[o + a] - oa) / da, f = (glass[o + 3 + a] - oa) / da;
        if (n > f) { const s = n; n = f; f = s; }
        if (n > t0) t0 = n; if (f < t1) t1 = f;
        if (t0 > t1) okk = false;
      }
      if (okk) T *= GLASS_T;
    }
    return T;
  }
  function lobeOf(f, ux, uy, uz) {
    // emission lobe, u = direction from the sample to the light (uy > 0: sample below the light)
    if (f.type === 'highbay') return uy > 0 ? 0.04 + 0.96 * Math.pow(uy, 1.5) : 0;
    if (f.type === 'tube') return uy > -0.05 ? 0.08 + 0.92 * Math.max(0, uy) : 0;
    if (f.type === 'flood') return Math.pow(Math.max(0, -(ux * f.aim[0] + uy * f.aim[1] + uz * f.aim[2])), 4);
    return 1;
  }
  function artDirect(x, y, z, nx, ny, nz, out, omni, nsmp, rnd) {
    out[0] = out[1] = out[2] = 0;
    for (const f of fx) {
      const lx = f.c[0] - x, ly = f.c[1] - y, lz = f.c[2] - z;
      const d2 = lx * lx + ly * ly + lz * lz;
      if (d2 > f.range * f.range) continue;
      const d = Math.sqrt(d2), ux = lx / d, uy = ly / d, uz = lz / d;
      const cosS = omni ? 0.25 : ux * nx + uy * ny + uz * nz;
      if (cosS <= -0.05) continue;
      const lobe = lobeOf(f, ux, uy, uz);
      if (lobe <= 0) continue;
      const win = Math.pow(Math.max(0, 1 - Math.pow(d / f.range, 4)), 2);
      const e = f.intensity * lobe * Math.max(0, cosS + (omni ? 0 : 0.02)) * win / Math.max(d2, 0.3);
      if (e < 1e-4) continue;
      // visibility over points of the luminaire (stratified along its long axis)
      let vis = 0;
      for (let s = 0; s < nsmp; s++) {
        const a = nsmp > 1 ? ((s + rnd()) / nsmp) * 2 - 1 : 0, b = nsmp > 1 ? rnd() * 2 - 1 : 0;
        const px = f.c[0] + a * f.ex - x, py = f.c[1] - y, pz = f.c[2] + b * f.ez - z;
        if (!bvh.occluded(x, y, z, px, py, pz, 0.999, MASK)) vis++;
      }
      if (!vis) continue;
      const k = e * vis / nsmp;
      out[0] += k * f.color[0]; out[1] += k * f.color[1]; out[2] += k * f.color[2];
    }
  }
  // value (previous total) at a hit point of box b, side s; writes into o (day, art) = outgoing radiance
  const hp = [0, 0, 0];
  function hitValue(b, s, px, py, pz, oD, oA) {
    const fi = boxSideFace[b * 6 + s];
    if (fi < 0) { oD[0] = oD[1] = oD[2] = oA[0] = oA[1] = oA[2] = 0; return; }
    const f = faces[fi];
    hp[0] = px; hp[1] = py; hp[2] = pz;
    const fu = Math.max(0, Math.min(1, (hp[f.ua] - f.u0) / (f.u1 - f.u0))), fv = Math.max(0, Math.min(1, (hp[f.va] - f.v0) / (f.v1 - f.v0)));
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
    // emissive faces are not light sources in the bake (their light comes from FIXTURES)
    const a = b * 3;
    for (let c = 0; c < 3; c++) { oD[c] *= albedo[a + c]; oA[c] *= albedo[a + c]; }
  }
  /** radiance along a ray (day → oD, art → oA); returns hit distance (Infinity for sky) */
  function trace(x, y, z, dx, dy, dz, oD, oA) {
    const b = bvh.raycast(x, y, z, dx, dy, dz, 2000, MASK, hit);
    if (b < 0) {
      skyRadiance(sky, sun, dx, dy, dz, oD);
      const T = glassT(x, y, z, dx, dy, dz, 2000);
      oD[0] *= T; oD[1] *= T; oD[2] *= T; oA[0] = oA[1] = oA[2] = 0;
      return Infinity;
    }
    const t = hit.t;
    hitValue(b, hit.side, x + dx * t, y + dy * t, z + dz * t, oD, oA);
    if (ng && t > 0.05) { const T = glassT(x, y, z, dx, dy, dz, t); if (T < 1) for (let c = 0; c < 3; c++) { oD[c] *= T; oA[c] *= T; } }
    return t;
  }

  const hD = [0, 0, 0], hA = [0, 0, 0], art = [0, 0, 0], q = [0, 0, 0];
  const qc = [0, 0, 0];
  function direct(i) {
    let x = buf.sPos[i * 3], y = buf.sPos[i * 3 + 1], z = buf.sPos[i * 3 + 2];
    const valid = !insideOcc(x, y, z);
    buf.valid[i] = valid ? 1 : 0;
    const nx = buf.sNrm[i * 3], ny = buf.sNrm[i * 3 + 1], nz = buf.sNrm[i * 3 + 2];
    const f = faces[buf.sFace[i]];
    // jitter extent: inside the texel (lightmap); vertex corners integrate DIRECT light over their quarter of
    // the face (a sun spot on one corner of an 8 m rack upright must not smear a gradient over the whole face)
    let hu, hv;
    let NS = P.sunSamples;
    if (i < kV) { hu = (f.u1 - f.u0) / f.lmRect[2] * 0.5; hv = (f.v1 - f.v0) / f.lmRect[3] * 0.5; }
    else {
      const qd = (i - kV) & 3;   // corner order (u0,v0),(u1,v0),(u1,v1),(u0,v1)
      hu = (f.u1 - f.u0) * 0.25; hv = (f.v1 - f.v0) * 0.25;
      qc[f.axis] = f.plane + (f.pos ? 0.01 : -0.01);
      qc[f.ua] = qd === 0 || qd === 3 ? f.u0 + hu : f.u1 - hu; qc[f.va] = qd < 2 ? f.v0 + hv : f.v1 - hv;
      x = qc[0]; y = qc[1]; z = qc[2];
      if (Math.max(hu, hv) > 0.3) NS = Math.max(NS, 16);
    }
    const rnd = rngFor(i * 2654435761 + 11);
    const gx = Math.ceil(Math.sqrt(NS));
    const cs = nx * sd[0] + ny * sd[1] + nz * sd[2];
    let sunAcc = 0, sunN = 0;
    if (cs > 0) {
      for (let s = 0; s < NS; s++) {
        q[0] = x; q[1] = y; q[2] = z;
        q[f.ua] += ((((s % gx) + rnd()) / gx) * 2 - 1) * hu * 0.98;
        q[f.va] += (((Math.floor(s / gx) % gx + rnd()) / gx) * 2 - 1) * hv * 0.98;
        if (insideOcc(q[0], q[1], q[2])) continue;
        sunN++;
        const r = P.sunRadius * Math.sqrt(rnd()), ph = 2 * Math.PI * rnd();
        const a = r * Math.cos(ph), b = r * Math.sin(ph);
        const dx = sd[0] + st1[0] * a + st2[0] * b, dy = sd[1] + st1[1] * a + st2[1] * b, dz = sd[2] + st1[2] * a + st2[2] * b;
        if (!bvh.occluded(q[0], q[1], q[2], dx, dy, dz, 1000, MASK)) sunAcc += ng ? glassT(q[0], q[1], q[2], dx, dy, dz, 1000) : 1;
      }
    }
    const sv = sunN ? sunAcc / sunN : 0;
    if (valid) artDirect(x, y, z, nx, ny, nz, art, false, P.artSamples, rnd); else art[0] = art[1] = art[2] = 0;
    const r = buf.sRef[i];
    const [D, A] = i < kV ? [buf.lmDirD, buf.lmDirA] : [buf.vDirD, buf.vDirA];
    D[r * 3] = sunC[0] * cs * sv; D[r * 3 + 1] = sunC[1] * cs * sv; D[r * 3 + 2] = sunC[2] * cs * sv;
    if (cs <= 0) D[r * 3] = D[r * 3 + 1] = D[r * 3 + 2] = 0;
    A[r * 3] = art[0]; A[r * 3 + 1] = art[1]; A[r * 3 + 2] = art[2];
  }
  function gather(g, N) {
    const x = buf.gPos[g * 3], y = buf.gPos[g * 3 + 1], z = buf.gPos[g * 3 + 2];
    const nx = buf.gNrm[g * 3], ny = buf.gNrm[g * 3 + 1], nz = buf.gNrm[g * 3 + 2];
    // tangent frame for an axis-aligned normal
    let tx, ty, tz;
    if (Math.abs(ny) > 0.5) { tx = 1; ty = 0; tz = 0; } else { tx = 0; ty = 1; tz = 0; }
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const rnd = rngFor(g * 7919 + 17);
    let aD0 = 0, aD1 = 0, aD2 = 0, aA0 = 0, aA1 = 0, aA2 = 0, ao = 0;
    const sq = Math.max(1, Math.round(Math.sqrt(N))), NN = sq * sq;
    for (let k = 0; k < NN; k++) {
      // stratified (sq × sq) cosine-weighted hemisphere
      const u1 = ((k % sq) + rnd()) / sq, u2 = (Math.floor(k / sq) + rnd()) / sq;
      const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2;
      const a = rr * Math.cos(ph), bq = rr * Math.sin(ph), cz = Math.sqrt(Math.max(0, 1 - u1));
      const dx = a * tx + bq * bx + cz * nx, dy = a * ty + bq * by + cz * ny, dz = a * tz + bq * bz + cz * nz;
      const t = trace(x, y, z, dx, dy, dz, hD, hA);
      if (t < P.aoRange) ao += 1 - t / P.aoRange;
      aD0 += hD[0]; aD1 += hD[1]; aD2 += hD[2]; aA0 += hA[0]; aA1 += hA[1]; aA2 += hA[2];
    }
    buf.gD[g * 3] = aD0 / NN; buf.gD[g * 3 + 1] = aD1 / NN; buf.gD[g * 3 + 2] = aD2 / NN;
    buf.gA[g * 3] = aA0 / NN; buf.gA[g * 3 + 1] = aA1 / NN; buf.gA[g * 3 + 2] = aA2 / NN;
    buf.gAO[g] = ao / NN;
  }
  function probe(pi) {
    const i = kP + pi;
    const x = buf.sPos[i * 3], y = buf.sPos[i * 3 + 1], z = buf.sPos[i * 3 + 2];
    const r = buf.sRef[i];
    const valid = !insideOcc(x, y, z);
    buf.valid[i] = valid ? 1 : 0;
    if (!valid) return;
    const rnd = rngFor(r * 104729 + 3);
    const L0 = [0, 0, 0], LA = [0, 0, 0], d = [0, 0, 0];
    let lumSum = 0;
    const N = P.probeRays, sq = Math.round(Math.sqrt(N)), NN = sq * sq;
    for (let k = 0; k < NN; k++) {
      const u1 = ((k % sq) + rnd()) / sq, u2 = (Math.floor(k / sq) + rnd()) / sq;
      const dy = 1 - 2 * u1, rr = Math.sqrt(Math.max(0, 1 - dy * dy)), ph = 2 * Math.PI * u2;
      const dx = rr * Math.cos(ph), dz = rr * Math.sin(ph);
      trace(x, y, z, dx, dy, dz, hD, hA);
      for (let c = 0; c < 3; c++) { L0[c] += hD[c]; LA[c] += hA[c]; }
      const lum = 0.2126 * (hD[0] + hA[0]) + 0.7152 * (hD[1] + hA[1]) + 0.0722 * (hD[2] + hA[2]);
      d[0] += lum * dx; d[1] += lum * dy; d[2] += lum * dz; lumSum += lum;
    }
    // direct artificial light (point sources are not hit by rays): mean over normals of max(cos,0) = 1/4
    artDirect(x, y, z, 0, 0, 0, art, true, 1, rnd);
    for (let c = 0; c < 3; c++) { buf.pL0D[r * 3 + c] = L0[c] / NN; buf.pL0A[r * 3 + c] = LA[c] / NN + art[c]; }
    // directional term relative to L0 (L1 SH of luminance → irradiance: E(n) ≈ L0 (1 + v·n))
    const s = lumSum > 1e-6 ? 2 / lumSum : 0;   // (2/3) * (3 * mean(lum ω)) / mean(lum)
    for (let c = 0; c < 3; c++) buf.pDir[r * 3 + c] = Math.max(-1, Math.min(1, d[c] * s));
    // sun visibility: a few jittered points (soft over the probe spacing)
    let sv = 0;
    for (let k = 0; k < 4; k++) {
      const ox = (rnd() - 0.5) * 0.5, oy = (rnd() - 0.5) * 0.5, oz = (rnd() - 0.5) * 0.5;
      if (insideOcc(x + ox, y + oy, z + oz)) continue;
      if (!bvh.occluded(x + ox, y + oy, z + oz, sd[0], sd[1], sd[2], 1000, MASK)) sv += glassT(x + ox, y + oy, z + oz, sd[0], sd[1], sd[2], 1000);
    }
    buf.pSun[r] = sv / 4;
  }
  // environment cube per zone (16² per face): captured from a walkable point near the zone centre
  function env(zi) {
    const zone = W.zones[zi], rnd = rngFor(zi * 9973 + 1);
    let best = null, ba = -1;
    for (const p of zone.parts) { const a = (p[3] - p[0]) * (p[5] - p[2]); if (a > ba) { ba = a; best = p; } }
    let cx = (best[0] + best[3]) / 2, cz = (best[2] + best[5]) / 2, cy = best[1] + 1.6;
    const top = Math.min(best[4], best[1] + 6) - 0.05;
    const b = bvh.raycast(cx, top, cz, 0, -1, 0, top - best[1] + 0.6, F_WALK, hit);
    if (b >= 0) cy = top - hit.t + 1.6;
    if (insideOcc(cx, cy, cz)) { const E = eyes(zi, rnd, 4); if (E.length) [cx, cy, cz] = E[0]; }
    buf.envPos[zi * 3] = cx; buf.envPos[zi * 3 + 1] = cy; buf.envPos[zi * 3 + 2] = cz;
    const ES = ENV_SIZE, M = P.envRays, dir = [0, 0, 0];
    for (let fc = 0; fc < 6; fc++) {
      const a = fc >> 1, sg = fc & 1 ? -1 : 1, [ua, va] = TAN[a];
      for (let tj = 0; tj < ES; tj++) for (let ti = 0; ti < ES; ti++) {
        let rD = 0, gD = 0, bD = 0, rA = 0, gA = 0, bA = 0;
        for (let m = 0; m < M; m++) {
          // texel footprint + a ~0.12 rad blur (rough-concrete lobe)
          const s = ((ti + rnd()) / ES) * 2 - 1, t = ((tj + rnd()) / ES) * 2 - 1;
          dir[a] = sg; dir[ua] = s; dir[va] = t;
          const l = Math.hypot(dir[0], dir[1], dir[2]);
          let dx = dir[0] / l + (rnd() - 0.5) * 0.24, dy = dir[1] / l + (rnd() - 0.5) * 0.24, dz = dir[2] / l + (rnd() - 0.5) * 0.24;
          const l2 = Math.hypot(dx, dy, dz); dx /= l2; dy /= l2; dz /= l2;
          trace(cx, cy, cz, dx, dy, dz, hD, hA);
          rD += hD[0]; gD += hD[1]; bD += hD[2]; rA += hA[0]; gA += hA[1]; bA += hA[2];
        }
        const o = (((zi * ES + tj) * 6 * ES) + fc * ES + ti) * 3;
        buf.envD[o] = rD / M; buf.envD[o + 1] = gD / M; buf.envD[o + 2] = bD / M;
        buf.envA[o] = rA / M; buf.envA[o + 1] = gA / M; buf.envA[o + 2] = bA / M;
      }
    }
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
    else if (m.type === 'gather') for (let i = m.s; i < m.e; i++) gather(i, m.rays);
    else if (m.type === 'probe') for (let i = m.s; i < m.e; i++) probe(i);
    else if (m.type === 'env') for (let i = m.s; i < m.e; i++) env(i);
    else if (m.type === 'pvs') for (let i = m.s; i < m.e; i++) pvs(i);
    parentPort.postMessage({ n: m.e - m.s });
  });
  parentPort.postMessage({ ready: true });
}
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
