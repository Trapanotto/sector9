// Character collision against the static box BVH (F_SOLID) plus dynamic AABB colliders (doors, intact glass,
// AGVs, …). Vertical capsule approximated by a cylinder (radius r, height h, feet at pos.y). Allocation-free.
// Owner: core. Used by the player (C) and optionally by enemies (D).
import { F_SOLID } from './gen.js';

export function createCollision(bvh) {
  const dyn = [];   // { min: Float32Array(3), max: Float32Array(3), enabled, owner }
  // scratch state in a Float64Array: closure-captured mutable doubles would box a HeapNumber on every write
  const S = new Float64Array(12);
  const { bmin, bmax } = bvh;
  let flag = false;
  const onFlag = () => { flag = true; };

  // S: 0 px, 1 pz, 2 radius, 3 lo, 4 hi, 5 pushX, 6 pushZ, 7 maxTop, 8 qx, 9 qz, 10 qr, 11 refTop
  // push the circle (px,pz,radius) out of a box rect if the box overlaps the body's vertical span [lo, hi]
  // (typed arrays + integer offset as arguments: passing six doubles to a non-inlined call boxes them)
  function pushOut(mn, mx, o) {
    const x0 = mn[o], y0 = mn[o + 1], z0 = mn[o + 2], x1 = mx[o], y1 = mx[o + 1], z1 = mx[o + 2];
    if (y1 <= S[3] || y0 >= S[4]) return;
    const cx = S[0] < x0 ? x0 : S[0] > x1 ? x1 : S[0], cz = S[1] < z0 ? z0 : S[1] > z1 ? z1 : S[1];
    let dx = S[0] - cx, dz = S[1] - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= S[2] * S[2]) return;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), k = (S[2] - d) / d;
      S[5] += dx * k; S[6] += dz * k; S[0] += dx * k; S[1] += dz * k;
    } else {
      // centre inside the rect: leave along the smallest penetration
      const l = S[0] - x0 + S[2], r = x1 - S[0] + S[2], b = S[1] - z0 + S[2], f = z1 - S[1] + S[2];
      const m = Math.min(l, r, b, f);
      if (m === l) dx = -l; else if (m === r) dx = r; else dx = 0;
      if (m === b) dz = -b; else if (m === f) dz = f; else dz = 0;
      S[0] += dx; S[1] += dz; S[5] += dx; S[6] += dz;
    }
  }
  const onStatic = (b) => { pushOut(bmin, bmax, b * 3); };
  const onGround = (b) => {
    const o = b * 3, top = bmax[o + 1];
    if (top > S[11] || top <= S[7]) return;
    // circle (qx,qz,qr) vs rect
    const cx = S[8] < bmin[o] ? bmin[o] : S[8] > bmax[o] ? bmax[o] : S[8], cz = S[9] < bmin[o + 2] ? bmin[o + 2] : S[9] > bmax[o + 2] ? bmax[o + 2] : S[9];
    if ((S[8] - cx) * (S[8] - cx) + (S[9] - cz) * (S[9] - cz) <= S[10] * S[10]) S[7] = top;
  };

  const api = {
    dynamic: dyn,
    /** add a dynamic AABB collider; returns the record (mutate min/max/enabled in place) */
    addDynamic(min, max, owner = null) {
      const c = { min: Float32Array.from(min), max: Float32Array.from(max), enabled: true, owner };
      dyn.push(c); return c;
    },
    removeDynamic(c) { const i = dyn.indexOf(c); if (i >= 0) dyn.splice(i, 1); },
    /** highest walkable top under (x,z) within radius r that is ≤ refY + 0.01 (-Infinity if none) */
    groundHeight(x, z, refY, r = 0) {
      S[8] = x; S[9] = z; S[10] = r; S[11] = refY + 0.01; S[7] = -Infinity;
      bvh.query(x - r, -1e3, z - r, x + r, S[11], z + r, F_SOLID, onGround);
      for (let i = 0; i < dyn.length; i++) {
        const c = dyn[i]; if (!c.enabled) continue;
        const top = c.max[1];
        if (top > S[11] || top <= S[7]) continue;
        const cx = Math.max(c.min[0], Math.min(c.max[0], x)), cz = Math.max(c.min[2], Math.min(c.max[2], z));
        if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) S[7] = top;
      }
      return S[7];
    },
    /**
     * Move a cylinder body. pos: {x,y,z} feet (mutated), d: {x,y,z} displacement, opts { radius, height, step }.
     * state (mutated): { grounded, vy, hitWall, groundY }. Gravity is the caller's job (pass d.y).
     */
    move(pos, d, opts, state) {
      const r = opts.radius, h = opts.height, step = opts.step ?? 0.45;
      const len = Math.hypot(d.x, d.z);
      const n = Math.max(1, Math.ceil(len / (r * 0.45)));
      S[0] = pos.x; S[1] = pos.z; S[2] = r;
      state.hitWall = false;
      for (let s = 0; s < n; s++) {
        S[0] += d.x / n; S[1] += d.z / n;
        for (let it = 0; it < 3; it++) {
          S[5] = 0; S[6] = 0;
          S[3] = pos.y + step; S[4] = pos.y + h;
          bvh.query(S[0] - r, S[3], S[1] - r, S[0] + r, S[4], S[1] + r, F_SOLID, onStatic);
          for (let i = 0; i < dyn.length; i++) {
            const c = dyn[i];
            if (c.enabled) pushOut(c.min, c.max, 0);
          }
          if (S[5] === 0 && S[6] === 0) break;
          state.hitWall = true;
        }
      }
      pos.x = S[0]; pos.z = S[1];
      // vertical: step up / snap down / fall
      const g = api.groundHeight(S[0], S[1], pos.y + step, r * 0.75);
      let y = pos.y + d.y;
      if (d.y <= 0 && g > -Infinity && y <= g + (state.grounded ? 0.3 : 0.0)) {
        y = g; state.grounded = true; state.vy = 0;
      } else state.grounded = false;
      // ceiling
      if (d.y > 0) {
        S[3] = y + h - 0.05; S[4] = y + h + 0.02; S[5] = 0; S[6] = 0;
        flag = false;
        bvh.query(S[0] - r * 0.5, S[3], S[1] - r * 0.5, S[0] + r * 0.5, S[4], S[1] + r * 0.5, F_SOLID, onFlag);
        if (flag) { y = pos.y; state.vy = 0; }
      }
      state.groundY = g;
      pos.y = y;
      return state;
    },
    /** true if a body (radius, height) at pos would overlap any solid (e.g. to test standing up from a crouch) */
    blocked(x, y, z, r, h, step = 0.45) {
      flag = false;
      bvh.query(x - r, y + step, z - r, x + r, y + h, z + r, F_SOLID, onFlag);
      let hit = flag;
      for (let i = 0; i < dyn.length && !hit; i++) {
        const c = dyn[i];
        if (c.enabled && c.max[0] > x - r && c.min[0] < x + r && c.max[2] > z - r && c.min[2] < z + r && c.max[1] > y + step && c.min[1] < y + h) hit = true;
      }
      return hit;
    },
  };
  return api;
}
