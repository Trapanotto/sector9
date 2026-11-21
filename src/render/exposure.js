// Bodycam auto-exposure without any GPU read-back or extra pass: 32 CPU rays in the view cone against the box
// BVH, radiance at each hit estimated from the baked probe volume (+ sun visibility, + flashlight), sky for
// misses. Centre-weighted log-average → target exposure; asymmetric adaptation like a small sensor (bright →
// fast, dark → slower, with a little overshoot), so crossing a dock door visibly blows out / crushes first.
// Also: fog colour/density from the camera's surroundings, the camera zone's environment cube (specular), a
// leak-free light sampler for dynamic objects and the first-person view. Owner: B.
//
// ctx.exposure = { value, target, avgLum, gain, frozen, sampleLight(x, y, z, out), lightViewModel }
//   sampleLight: like world.probes.sample but each of the 8 surrounding probes only counts if it is visible
//   from the point (no light through walls). ~8 BVH rays; call per object per frame or less.
//   lightViewModel (default true): after the player/weapon update, feeds U.uProbeAmb / uProbeDirU / uProbeSunU
//   (the 'uniform' first-person materials) from sampleLight at the camera; set false to drive them yourself.
import * as THREE from 'three';
import { F_OCC } from '../world/gen.js';
import { U, updateEnvironment } from './materials.js';
import { skyRadiance, PROBE_GRID } from '../world/skymodel.js';

const FOG = { outdoor: 0.0011, hall_large: 0.0040, hall_medium: 0.0045, room_large: 0.0035, room_small: 0.0025, corridor: 0.0035, stairwell: 0.0035, basement: 0.008, cold_store: 0.03 };

export function createExposure(ctx) {
  const N = 32;
  const dirs = new Float32Array(N * 3), wts = new Float32Array(N);
  // fixed pattern in camera space (golden-angle spiral over the fisheye's ~110° view, centre weighted)
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt((i + 0.5) / N) * 1.25, a = i * 2.39996;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.62;
    const l = Math.hypot(x, y, 1);
    dirs[i * 3] = x / l; dirs[i * 3 + 1] = y / l; dirs[i * 3 + 2] = -1 / l;
    wts[i] = 1.6 - r;
  }
  const P3 = new Float64Array(3);
  const hit = { t: 0.5, side: 0 }, ps = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 }, sk = [0, 0, 0];
  const NORM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // key = exposed log-average target (mid grey). min/max cover yard in full sun ↔ basement lit by one bulb.
  // maxBoost: how many stops the sensor may gain up over the exposure the same view would get with every light
  // circuit on — a blackout stays dark (noisy), the flashlight matters. Circuit levels are low-passed for metering
  // so strobes / flicker read as strobes instead of being compensated.
  const e = { value: 1, target: 1, avgLum: 0.3, gain: 1, key: 0.19, min: 0.04, max: 48, maxBoost: 0.35, frozen: false, lightViewModel: true, vel: 0, under: 0 };
  const circSlow = new Float32Array(16).fill(1); let circInit = false;
  const L = ctx.layout;
  let fogTarget = 0.004;

  // ---- leak-free probe sampling
  const G = PROBE_GRID, cs = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 };
  e.sampleLight = (x, y, z, out) => {
    const w = ctx.world, pr = w.probes, bvh = w.bvh;
    const sp = G.spacing;
    let fx = (x - G.origin[0]) / sp, fy = (y - G.origin[1]) / sp, fz = (z - G.origin[2]) / sp;
    fx = Math.max(0, Math.min(G.dims[0] - 1.001, fx)); fy = Math.max(0, Math.min(G.dims[1] - 1.001, fy)); fz = Math.max(0, Math.min(G.dims[2] - 1.001, fz));
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    out.r = out.g = out.b = out.ar = out.ag = out.ab = out.dx = out.dy = out.dz = out.sun = 0;
    let wsum = 0;
    for (let c = 0; c < 8; c++) {
      const cx = c & 1, cy = (c >> 1) & 1, cz = c >> 2;
      const wt = (cx ? tx : 1 - tx) * (cy ? ty : 1 - ty) * (cz ? tz : 1 - tz);
      if (wt < 1e-4) continue;
      const px = G.origin[0] + (ix + cx) * sp, py = G.origin[1] + (iy + cy) * sp, pz = G.origin[2] + (iz + cz) * sp;
      if (bvh.occluded(x, y, z, px - x, py - y, pz - z, 1, F_OCC)) continue;
      pr.sample(px, py, pz, cs);
      out.r += cs.r * wt; out.g += cs.g * wt; out.b += cs.b * wt; out.ar += cs.ar * wt; out.ag += cs.ag * wt; out.ab += cs.ab * wt;
      out.dx += cs.dx * wt; out.dy += cs.dy * wt; out.dz += cs.dz * wt; out.sun += cs.sun * wt; wsum += wt;
    }
    if (wsum < 1e-3) return pr.sample(x, y, z, out);   // fully enclosed (inside a prop): plain trilinear
    const k = 1 / wsum;
    out.r *= k; out.g *= k; out.b *= k; out.ar *= k; out.ag *= k; out.ab *= k; out.dx *= k; out.dy *= k; out.dz *= k; out.sun *= k;
    // direct sun at the exact point (probe sun visibility is 1 m coarse)
    out.sun = out.sun > 0.01 && !bvh.occluded(x, y, z, L.sun.dir[0], L.sun.dir[1], L.sun.dir[2], 300, F_OCC) ? Math.max(out.sun, 0.8) : out.sun * 0.3;
    return out;
  };

  const vm = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 }, _q = new THREE.Quaternion();
  e.update = (dt) => {
    const w = ctx.world; if (!w?.ready) return;
    const cam = ctx.render.camera, m = cam.matrixWorld.elements, bvh = w.bvh, boxes = w.gen.boxes;
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    let sumW = 0, sumL = 0, sumN = 0;
    const fl = U.uFlashColor.value, flOn = fl.x + fl.y + fl.z > 0;
    const circ = U.uCirc.value, sd = L.sun.dir, sc = U.uSunColor.value;
    const ks = circInit ? 1 - Math.exp(-dt / 1.2) : 1; circInit = true;
    for (let c = 0; c < circ.length; c++) circSlow[c] += (circ[c] - circSlow[c]) * ks;
    for (let i = 0; i < N; i++) {
      const lx = dirs[i * 3], ly = dirs[i * 3 + 1], lz = dirs[i * 3 + 2];
      const dx = m[0] * lx + m[4] * ly + m[8] * lz, dy = m[1] * lx + m[5] * ly + m[9] * lz, dz = m[2] * lx + m[6] * ly + m[10] * lz;
      const R = bvh.ray; R[0] = ox; R[1] = oy; R[2] = oz; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = 150;
      const b = bvh.raycastR(F_OCC, hit);
      let lum, lumN;
      if (b < 0) {
        skyRadiance(L.sky, L.sun, dx, dy, dz, sk);
        lum = lumN = 0.2126 * sk[0] + 0.7152 * sk[1] + 0.0722 * sk[2];
      } else {
        const n = NORM[hit.side], t = hit.t;
        const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
        P3[0] = hx + n[0] * 0.35; P3[1] = hy + n[1] * 0.35; P3[2] = hz + n[2] * 0.35;
        w.probes.sampleV(P3, 0, ps);
        const bx = boxes[b], al = 0.2126 * bx.color[0] + 0.7152 * bx.color[1] + 0.0722 * bx.color[2];
        const zc = w.gen.zones[bx.zone]?.circuit, ci = w.lights.ids.indexOf(zc), cl = ci >= 0 ? circSlow[ci] : 1;
        // probe L0 is the mean radiance around the point; irradiance/π on the face ≈ L0 (1 + d·n)
        const dn = 1 + Math.max(-0.8, ps.dx * n[0] + ps.dy * n[1] + ps.dz * n[2]);
        const Ed = (0.2126 * ps.r + 0.7152 * ps.g + 0.0722 * ps.b) * dn, Ea = 0.2126 * ps.ar + 0.7152 * ps.ag + 0.0722 * ps.ab;
        let E = Ed + Ea * cl, EN = Ed + Ea;
        const ns = n[0] * sd[0] + n[1] * sd[1] + n[2] * sd[2];
        // sun: exact shadow ray at the hit (sun patches on the floor drive the exposure like on a real sensor)
        if (ns > 0 && ps.sun > 0.02 && !bvh.occluded(hx + n[0] * 0.02, hy + n[1] * 0.02, hz + n[2] * 0.02, sd[0], sd[1], sd[2], 300, F_OCC)) {
          const es = ns * (0.2126 * sc.x + 0.7152 * sc.y + 0.0722 * sc.z); E += es; EN += es;
        }
        if (flOn && t < 25) E += (0.3 * fl.x + 0.6 * fl.y + 0.1 * fl.z) / (0.35 + t * t * 0.09) * (1 - t / 25) * Math.max(0, -(n[0] * dx + n[1] * dy + n[2] * dz)) * 0.6;
        lum = al * E; lumN = al * EN;
      }
      // chest camera metering: rays above the horizon (sky, high windows) count less than the ground ahead
      const wi = wts[i] * (1 - 0.55 * Math.max(0, dy));
      sumL += wi * Math.log2(Math.max(lum, 1e-4)); sumN += wi * Math.log2(Math.max(lumN, 1e-4)); sumW += wi;
    }
    e.avgLum = Math.pow(2, sumL / sumW);
    // slight compensation: very bright scenes are kept a little brighter than mid grey, dark ones a little darker
    const ev = Math.log2(Math.max(e.avgLum, 1e-4));
    const key = e.key * Math.pow(2, Math.max(-0.7, Math.min(0.5, (ev + 1.5) * 0.18)));
    const free = key / Math.max(e.avgLum, 1e-4);
    // the same view with every circuit on (+ flashlight / sun as they are): cap the gain-up over it
    const nominal = key / Math.max(Math.pow(2, sumN / sumW), 1e-4);
    e.target = Math.min(e.max, Math.max(e.min, Math.min(free, nominal * Math.pow(2, e.maxBoost))));
    e.under = Math.max(0, Math.log2(free / e.target));   // stops the picture stays underexposed
    if (!e.frozen) {
      // adapt in log space: getting brighter (target below value) is fast, opening up into the dark slower;
      // a critically-damped-ish spring gives a small visible overshoot ("hunting") like a cheap sensor
      const lv = Math.log2(e.value), lt = Math.log2(e.target);
      const down = lt < lv, k = down ? 9.0 : 3.2, d = down ? 5.0 : 3.0;
      e.vel += ((lt - lv) * k - e.vel * d) * Math.min(dt, 0.05);
      e.value = Math.pow(2, Math.max(Math.log2(e.min), Math.min(Math.log2(e.max), lv + e.vel * dt)));
    }
    U.uExposure.value = e.value;
    // noise: stops of sensor gain above a normally lit interior + the underexposure the gain cap leaves
    e.gain = Math.max(0, Math.log2(e.value / 1.0)) + Math.min(3, e.under) * 0.8;
    ctx.render.composite.uniforms.uGain.value = e.gain;
    // fog: colour from the probe at the camera, density from the zone's acoustic class
    P3[0] = ox; P3[1] = oy; P3[2] = oz;
    w.probes.sampleV(P3, 0, ps);
    const cz = w.gen.zones[w.cameraZone];
    const cl = circ[w.lights.ids.indexOf(cz?.circuit)] ?? 1;
    U.uFogColor.value.set((ps.r + ps.ar * cl) * 0.9, (ps.g + ps.ag * cl) * 0.9, (ps.b + ps.ab * cl) * 0.9);
    fogTarget = FOG[cz?.acoustic] ?? 0.004;
    U.uFogDensity.value += (fogTarget - U.uFogDensity.value) * Math.min(1, dt * 2);
    // specular environment of the camera's zone
    updateEnvironment(w.cameraZone, U.uProbeArtLevel.value, dt);
    // first-person view model: leak-free light at the camera (world dir → camera space; sun folded into amb
    // because the view model shades in camera space while uSunDir is world space)
    if (e.lightViewModel && ctx.state !== 'menu') {
      e.sampleLight(ox, oy - 0.25, oz, vm);
      const a = U.uProbeArtLevel.value, sv = vm.sun * 0.35;
      U.uProbeAmb.value.set(vm.r + vm.ar * a + sc.x * sv, vm.g + vm.ag * a + sc.y * sv, vm.b + vm.ab * a + sc.z * sv);
      U.uProbeDirU.value.set(vm.dx, vm.dy, vm.dz).applyQuaternion(_q.copy(cam.quaternion).invert());
      U.uProbeSunU.value = 0;
    }
  };
  return e;
}
