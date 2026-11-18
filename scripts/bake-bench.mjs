// Benchmarks / sanity-checks the irradiance bake kernel in Node (single thread).
// Usage: node scripts/bake-bench.mjs [rays]
import { buildLayout } from '../src/world/layout.js';
import { buildBakeScene } from '../src/world/bakeGIScene.js';
import { voxelize, createTracer, PROBE, probeValidity, denoise, fillInvalid } from '../src/world/bakeGIKernel.js';

const rays = +(process.argv[2] || 64);
const layout = buildLayout();
let t = performance.now();
const { boxes, albedo } = buildBakeScene(layout);
const vox = voxelize(boxes);
console.log('boxes', boxes.length, 'voxelize ms', (performance.now() - t).toFixed(1));

// synthetic overcast sky: zenith 1.0, horizon 0.6
const sky = { w: 64, h: 32, data: new Float32Array(64 * 32 * 3) };
for (let v = 0; v < 32; v++) for (let u = 0; u < 64; u++) {
  const y = Math.sin(((v + 0.5) / 32 - 0.5) * Math.PI);
  const L = y > 0 ? 0.6 + 0.4 * y : 0.3;
  const o = (v * 64 + u) * 3; sky.data[o] = L * 0.95; sky.data[o + 1] = L; sky.data[o + 2] = L * 1.05;
}
const sd = [-0.42, 0.72, 0.55]; const n = Math.hypot(...sd);
const sun = { dx: sd[0] / n, dy: sd[1] / n, dz: sd[2] / n, r: 1.8, g: 1.9, b: 2.1 };
const tracer = createTracer({ vox, albedo, sky, sun, lamp: null });
const zs = [...Array(PROBE.nz).keys()];
const per = PROBE.nx * PROBE.ny * 12;
let prev = null;
t = performance.now();
tracer.traceSlices(zs, rays, 1234);
console.log('trace ms', (performance.now() - t).toFixed(0));
const valid = probeValidity(vox);
for (let it = 0; it < 4; it++) {
  t = performance.now();
  const sh = tracer.gather(prev);
  denoise(sh, valid, vox, 1);
  const f = fillInvalid(sh, valid, vox);
  console.log('bounce', it, 'ms', (performance.now() - t).toFixed(0), 'filled', f);
  prev = sh;
}
const at = (x, y, z) => {
  const i = Math.round((x - PROBE.x0) / PROBE.s), j = Math.round((y - PROBE.y0) / PROBE.s), k = Math.round((z - PROBE.z0) / PROBE.s);
  const o = (i + PROBE.nx * (j + PROBE.ny * k)) * 12;
  return [...prev.slice(o, o + 3)].map((v) => v.toFixed(3)).join(' ') + '  up ' + (prev[o + 1] + prev[o + 7]).toFixed(3);
};
for (const [name, p] of [['yard', [-9, 1.5, 22]], ['hall door', [-8, 1.5, 13]], ['hall mid', [-6, 1.5, 4]], ['hall corner', [-22, 1.5, 14]],
  ['under deck', [-20, 1.5, -2]], ['corridor', [9.4, 1.5, 5]], ['office', [15, 1.5, 12.5]], ['storage', [15, 1.5, 2]], ['bay', [-4, 1.5, -11]], ['under hole', [-12.5, 0.5, 5.5]]]) {
  console.log(name.padEnd(12), at(...p));
}
