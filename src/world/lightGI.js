// Load-time irradiance volume: runs the bake (bakeGIKernel.js) in parallel Web Workers and uploads the result as
// three RGBA half-float 3D textures (one per colour channel: c0, c1.x, c1.y, c1.z of L1 SH irradiance).
import * as THREE from 'three';
import { VOX, PROBE, voxelize, createTracer, probeValidity, denoise, fillInvalid } from './bakeGIKernel.js';
import { buildBakeScene } from './bakeGIScene.js';

// Down-sample an equirect HDR texture into a small lat-long radiance table (linear RGB, three's equirect convention).
export function skyTable(tex, TW = 64, TH = 32) {
  const data = new Float32Array(TW * TH * 3);
  const img = tex?.image;
  if (!img?.data || !img.width) {
    for (let v = 0; v < TH; v++) for (let u = 0; u < TW; u++) {
      const y = Math.sin(((v + 0.5) / TH - 0.5) * Math.PI), L = y > 0 ? 0.55 + 0.45 * y : 0.25;
      data.set([L * 0.95, L, L * 1.05], (v * TW + u) * 3);
    }
    return { w: TW, h: TH, data };
  }
  const { width: W, height: H, data: src } = img;
  const half = src instanceof Uint16Array;
  const ch = src.length / (W * H);
  const get = (i) => (half ? THREE.DataUtils.fromHalfFloat(src[i]) : src[i]);
  const cnt = new Float32Array(TW * TH);
  // sample a sub-grid of source pixels (enough for a 64x32 table)
  const sx = Math.max(1, Math.floor(W / (TW * 4))), sy = Math.max(1, Math.floor(H / (TH * 4)));
  for (let r = 0; r < H; r += sy) {
    const vRow = tex.flipY ? 1 - (r + 0.5) / H : (r + 0.5) / H;
    const iv = Math.min(TH - 1, Math.floor(vRow * TH));
    for (let c = 0; c < W; c += sx) {
      const iu = Math.min(TW - 1, Math.floor(((c + 0.5) / W) * TW));
      const i = (r * W + c) * ch, o = iv * TW + iu;
      data[o * 3] += get(i); data[o * 3 + 1] += get(i + 1); data[o * 3 + 2] += get(i + 2); cnt[o]++;
    }
  }
  for (let o = 0; o < TW * TH; o++) if (cnt[o]) { data[o * 3] /= cnt[o]; data[o * 3 + 1] /= cnt[o]; data[o * 3 + 2] /= cnt[o]; }
  return { w: TW, h: TH, data };
}

function makeTextures(sh) {
  const { nx, ny, nz } = PROBE, n = nx * ny * nz;
  const toHalf = THREE.DataUtils.toHalfFloat;
  const tex = [];
  for (let c = 0; c < 3; c++) {
    const d = new Uint16Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      d[i * 4] = toHalf(sh[o + c]);
      d[i * 4 + 1] = toHalf(sh[o + 3 + c * 3]);
      d[i * 4 + 2] = toHalf(sh[o + 4 + c * 3]);
      d[i * 4 + 3] = toHalf(sh[o + 5 + c * 3]);
    }
    const t = new THREE.Data3DTexture(d, nx, ny, nz);
    t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1; t.generateMipmaps = false;
    t.needsUpdate = true;
    tex.push(t);
  }
  return tex;
}

/**
 * @param opts { layout, extra, sky (skyTable), sun: {dir: towards-sun Vector3-like, color: [r,g,b] linear * intensity},
 *               lamp: {pos, dir, angle, penumbra, range, color: [r,g,b] * intensity} | null, rays, bounces }
 * @returns Promise<{ textures: Data3DTexture[3], sh: Float32Array, ms: number, sample(x,y,z)->[r,g,b] c0 }>
 */
export async function bakeIrradianceVolume(opts) {
  const t0 = performance.now();
  const { boxes, albedo } = buildBakeScene(opts.layout, opts.extra || []);
  const sun = { dx: opts.sun.dir[0], dy: opts.sun.dir[1], dz: opts.sun.dir[2], r: opts.sun.color[0], g: opts.sun.color[1], b: opts.sun.color[2] };
  const L = opts.lamp;
  const lamp = L ? {
    x: L.pos[0], y: L.pos[1], z: L.pos[2], dx: L.dir[0], dy: L.dir[1], dz: L.dir[2],
    angle: L.angle, penumbra: L.penumbra, range: L.range, i: 1, r: L.color[0], g: L.color[1], b: L.color[2],
  } : null;
  const rays = opts.rays ?? 32, bounces = opts.bounces ?? 3, seed = 9137;
  const { nx, ny, nz } = PROBE, per = nx * ny * 12;
  const vox = voxelize(boxes);
  const valid = probeValidity(vox);

  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const W = Math.max(1, Math.min(8, hc - 1));
  let workers = [];
  try {
    if (typeof Worker === 'undefined') throw new Error('no workers');
    for (let w = 0; w < W; w++) workers.push(new Worker(new URL('./bakeGIWorker.js', import.meta.url), { type: 'module' }));
  } catch (e) {
    console.warn('[light] bake workers unavailable, baking on the main thread:', e.message);
    workers.forEach((w) => w.terminate()); workers = [];
  }

  let sh = null;
  const tm = [];
  const fillCache = {};
  if (workers.length) {
    const zsOf = workers.map((_, w) => [...Array(nz).keys()].filter((k) => k % workers.length === w));
    const call = (w, msg, transfer) => new Promise((res, rej) => {
      w.onmessage = (e) => (e.data.type === 'error' ? rej(new Error(e.data.message)) : res(e.data));
      w.onerror = (e) => rej(new Error(e.message || 'worker error'));
      w.postMessage(msg, transfer || []);
    });
    try {
      tm.push(['spawn', performance.now() - t0]);
      await Promise.all(workers.map((w, i) => call(w, { type: 'init', boxes, albedo, sky: opts.sky, sun, lamp, zs: zsOf[i], rays, seed })));
      tm.push(['trace', performance.now() - t0]);
      for (let b = 0; b < bounces; b++) {
        const prev = sh;
        const parts = await Promise.all(workers.map((w) => call(w, { type: 'gather', prev })));
        sh = new Float32Array(nx * ny * nz * 12);
        parts.forEach((p, i) => zsOf[i].forEach((k, si) => sh.set(p.out.subarray(si * per, (si + 1) * per), k * per)));
        tm.push(['gather' + b, performance.now() - t0]);
        if (b === bounces - 1) denoise(sh, valid, vox, 1);
        fillInvalid(sh, valid, vox, fillCache);
        tm.push(['post' + b, performance.now() - t0]);
      }
    } finally {
      workers.forEach((w) => w.terminate());
    }
  } else {
    const tracer = createTracer({ vox, albedo, sky: opts.sky, sun, lamp });
    tracer.traceSlices([...Array(nz).keys()], Math.min(rays, 32), seed);
    for (let b = 0; b < Math.min(bounces, 2); b++) {
      sh = tracer.gather(sh);
      denoise(sh, valid, vox, 1);
      fillInvalid(sh, valid, vox);
    }
  }

  const textures = makeTextures(sh);
  const ms = performance.now() - t0;
  // CPU-side trilinear sample of c0 (used for reflection-probe normalisation and debugging)
  const sample = (x, y, z) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - PROBE.x0) / PROBE.s)), fy = Math.min(ny - 1.001, Math.max(0, (y - PROBE.y0) / PROBE.s)), fz = Math.min(nz - 1.001, Math.max(0, (z - PROBE.z0) / PROBE.s));
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const out = [0, 0, 0];
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
      const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
      const o = ((i + di) + nx * ((j + dj) + ny * (k + dk))) * 12;
      out[0] += sh[o] * wt; out[1] += sh[o + 1] * wt; out[2] += sh[o + 2] * wt;
    }
    return out;
  };
  return { textures, sh, ms, timings: tm.map(([k, v]) => k + ' ' + v.toFixed(0)).join(', '), sample, workers: workers.length, grid: PROBE, vox: VOX };
}
