// Character collision against the static box BVH (F_SOLID) plus dynamic AABB colliders (doors, intact glass,
// AGVs, …). Vertical capsule approximated by a cylinder (radius r, height h, feet at pos.y). Allocation-free.
// Owner: core. Used by the player (C) and optionally by enemies (D).
import { F_SOLID } from './gen.js';

export function createCollision(bvh) {
  const dyn = [];   // { min: Float32Array(3), max: Float32Array(3), enabled, owner }
  let px = 0, py = 0, pz = 0, pr = 0, lo = 0, hi = 0, pushX = 0, pushZ = 0, maxTop = -Infinity, qx = 0, qz = 0, qr = 0, refTop = 0;
  const { bmin, bmax } = bvh;
  let flag = false;
  const onFlag = () => { flag = true; };

  // push the circle (px,pz,pr) out of a box rect if the box overlaps the body's vertical span [lo, hi]
  function pushOut(x0, y0, z0, x1, y1, z1) {
    if (y1 <= lo || y0 >= hi) return;
    const cx = px < x0 ? x0 : px > x1 ? x1 : px, cz = pz < z0 ? z0 : pz > z1 ? z1 : pz;
    let dx = px - cx, dz = pz - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= pr * pr) return;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), k = (pr - d) / d;
      pushX += dx * k; pushZ += dz * k; px += dx * k; pz += dz * k;
    } else {
      // centre inside the rect: leave along the smallest penetration
      const l = px - x0 + pr, r = x1 - px + pr, b = pz - z0 + pr, f = z1 - pz + pr;
      const m = Math.min(l, r, b, f);
      if (m === l) dx = -l; else if (m === r) dx = r; else dx = 0;
      if (m === b) dz = -b; else if (m === f) dz = f; else dz = 0;
      px += dx; pz += dz; pushX += dx; pushZ += dz;
    }
  }
  const onStatic = (b) => { const o = b * 3; pushOut(bmin[o], bmin[o + 1], bmin[o + 2], bmax[o], bmax[o + 1], bmax[o + 2]); };
  const onGround = (b) => {
    const o = b * 3, top = bmax[o + 1];
    if (top > refTop || top <= maxTop) return;
    // circle (qx,qz,qr) vs rect
    const cx = qx < bmin[o] ? bmin[o] : qx > bmax[o] ? bmax[o] : qx, cz = qz < bmin[o + 2] ? bmin[o + 2] : qz > bmax[o + 2] ? bmax[o + 2] : qz;
    if ((qx - cx) * (qx - cx) + (qz - cz) * (qz - cz) <= qr * qr) maxTop = top;
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
      qx = x; qz = z; qr = r; refTop = refY + 0.01; maxTop = -Infinity;
      bvh.query(x - r, -1e3, z - r, x + r, refTop, z + r, F_SOLID, onGround);
      for (let i = 0; i < dyn.length; i++) {
        const c = dyn[i]; if (!c.enabled) continue;
        const top = c.max[1];
        if (top > refTop || top <= maxTop) continue;
        const cx = Math.max(c.min[0], Math.min(c.max[0], x)), cz = Math.max(c.min[2], Math.min(c.max[2], z));
        if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) maxTop = top;
      }
      return maxTop;
    },
    /**
     * Move a cylinder body. pos: {x,y,z} feet (mutated), d: {x,y,z} displacement, opts { radius, height, step }.
     * state (mutated): { grounded, vy, hitWall, groundY }. Gravity is the caller's job (pass d.y).
     */
    move(pos, d, opts, state) {
      const r = opts.radius, h = opts.height, step = opts.step ?? 0.45;
      const len = Math.hypot(d.x, d.z);
      const n = Math.max(1, Math.ceil(len / (r * 0.45)));
      px = pos.x; pz = pos.z; pr = r;
      state.hitWall = false;
      for (let s = 0; s < n; s++) {
        px += d.x / n; pz += d.z / n;
        for (let it = 0; it < 3; it++) {
          pushX = 0; pushZ = 0;
          lo = pos.y + step; hi = pos.y + h;
          bvh.query(px - r, lo, pz - r, px + r, hi, pz + r, F_SOLID, onStatic);
          for (let i = 0; i < dyn.length; i++) {
            const c = dyn[i];
            if (c.enabled) pushOut(c.min[0], c.min[1], c.min[2], c.max[0], c.max[1], c.max[2]);
          }
          if (pushX === 0 && pushZ === 0) break;
          state.hitWall = true;
        }
      }
      pos.x = px; pos.z = pz;
      // vertical: step up / snap down / fall
      const g = api.groundHeight(px, pz, pos.y + step, r * 0.75);
      let y = pos.y + d.y;
      if (d.y <= 0 && g > -Infinity && y <= g + (state.grounded ? 0.3 : 0.0)) {
        y = g; state.grounded = true; state.vy = 0;
      } else state.grounded = false;
      // ceiling
      if (d.y > 0) {
        lo = y + h - 0.05; hi = y + h + 0.02; pushX = 0; pushZ = 0;
        flag = false;
        bvh.query(px - r * 0.5, lo, pz - r * 0.5, px + r * 0.5, hi, pz + r * 0.5, F_SOLID, onFlag);
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
