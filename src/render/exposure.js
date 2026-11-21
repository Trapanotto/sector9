// Bodycam auto-exposure without any GPU read-back or extra pass: 24 CPU rays in the view cone against the box
// BVH, radiance at each hit estimated from the baked probe volume (+ sun visibility, + flashlight), sky for
// misses. Log-average → target exposure, asymmetric adaptation (bright → fast, dark → slow) like a small sensor.
// Also sets the fog colour/density from the camera's surroundings. Owner: B.
import { F_OCC } from '../world/gen.js';
import { U } from './materials.js';
import { skyRadiance } from '../world/skymodel.js';

const FOG = { outdoor: 0.0011, hall_large: 0.0045, hall_medium: 0.005, room_large: 0.004, room_small: 0.003, corridor: 0.004, stairwell: 0.004, basement: 0.009, cold_store: 0.03 };

export function createExposure(ctx) {
  const N = 24;
  const dirs = new Float32Array(N * 3), wts = new Float32Array(N);
  // fixed pattern in camera space (spiral over a ~70° cone, centre weighted)
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt((i + 0.5) / N) * 0.75, a = i * 2.39996;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.6;
    const l = Math.hypot(x, y, 1);
    dirs[i * 3] = x / l; dirs[i * 3 + 1] = y / l; dirs[i * 3 + 2] = -1 / l;
    wts[i] = 1.4 - r;
  }
  const P3 = new Float64Array(3);
  const hit = { t: 0.5, side: 0 }, ps = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 }, sk = [0, 0, 0];
  const NORM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const e = { value: 1, target: 1, avgLum: 0.3, gain: 1, key: 0.42, min: 0.12, max: 10, frozen: false };
  const L = ctx.layout;
  let fogTarget = 0.004;

  e.update = (dt) => {
    const w = ctx.world; if (!w?.ready) return;
    const cam = ctx.render.camera, m = cam.matrixWorld.elements, bvh = w.bvh, boxes = w.gen.boxes;
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    let sumW = 0, sumL = 0;
    const fl = U.uFlashColor.value, flOn = fl.x + fl.y + fl.z > 0;
    const circ = U.uCirc.value, sd = L.sun.dir, sc = U.uSunColor.value;
    for (let i = 0; i < N; i++) {
      const lx = dirs[i * 3], ly = dirs[i * 3 + 1], lz = dirs[i * 3 + 2];
      const dx = m[0] * lx + m[4] * ly + m[8] * lz, dy = m[1] * lx + m[5] * ly + m[9] * lz, dz = m[2] * lx + m[6] * ly + m[10] * lz;
      const R = bvh.ray; R[0] = ox; R[1] = oy; R[2] = oz; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = 150;
      const b = bvh.raycastR(F_OCC, hit);
      let lum;
      if (b < 0) {
        skyRadiance(L.sky, L.sun, dx, dy, dz, sk);
        lum = 0.2126 * sk[0] + 0.7152 * sk[1] + 0.0722 * sk[2];
      } else {
        const n = NORM[hit.side], t = hit.t;
        P3[0] = ox + dx * t + n[0] * 0.35; P3[1] = oy + dy * t + n[1] * 0.35; P3[2] = oz + dz * t + n[2] * 0.35;
        w.probes.sampleV(P3, 0, ps);
        const bx = boxes[b], al = 0.2126 * bx.color[0] + 0.7152 * bx.color[1] + 0.0722 * bx.color[2];
        const zc = w.gen.zones[bx.zone]?.circuit, cl = circ[w.lights.ids.indexOf(zc)] ?? 1;
        let E = 0.2126 * (ps.r + ps.ar * cl) + 0.7152 * (ps.g + ps.ag * cl) + 0.0722 * (ps.b + ps.ab * cl);
        const ns = n[0] * sd[0] + n[1] * sd[1] + n[2] * sd[2];
        if (ns > 0 && ps.sun > 0.01) E += ps.sun * ns * (0.3 * sc.x + 0.6 * sc.y + 0.1 * sc.z);
        if (flOn && t < 25) E += (0.3 * fl.x + 0.6 * fl.y + 0.1 * fl.z) / (0.35 + t * t * 0.09) * (1 - t / 25) * Math.max(0, -(n[0] * dx + n[1] * dy + n[2] * dz)) * 0.6;
        lum = al * E;
      }
      sumL += wts[i] * Math.log2(Math.max(lum, 1e-4)); sumW += wts[i];
    }
    e.avgLum = Math.pow(2, sumL / sumW);
    e.target = Math.min(e.max, Math.max(e.min, e.key / Math.max(e.avgLum, 1e-4)));
    if (!e.frozen) {
      const up = e.target > e.value;      // getting darker scene → exposure rises slowly
      const tau = up ? 1.6 : 0.45;
      e.value += (e.target - e.value) * (1 - Math.exp(-dt / tau));
    }
    U.uExposure.value = e.value;
    e.gain = Math.max(0, Math.log2(e.value / 1.2));   // noise gain: grows when the sensor gains up
    ctx.render.composite.uniforms.uGain.value = e.gain;
    // fog: colour from the probe at the camera, density from the zone's acoustic class
    P3[0] = ox; P3[1] = oy; P3[2] = oz;
    w.probes.sampleV(P3, 0, ps);
    const cz = w.gen.zones[w.cameraZone];
    const cl = circ[w.lights.ids.indexOf(cz?.circuit)] ?? 1;
    U.uFogColor.value.set((ps.r + ps.ar * cl) * 0.9, (ps.g + ps.ag * cl) * 0.9, (ps.b + ps.ab * cl) * 0.92);
    fogTarget = FOG[cz?.acoustic] ?? 0.004;
    U.uFogDensity.value += (fogTarget - U.uFogDensity.value) * Math.min(1, dt * 2);
  };
  return e;
}
