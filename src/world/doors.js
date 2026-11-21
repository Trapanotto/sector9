// Doors: swing / roller / slide, animated, with collider, nav blocking for locked doors, PVS-aware visibility.
// Owner: core (logic) / A (door models + sounds via events). Events: 'door:state' { id, state, door },
// 'door:locked' { id }.
import * as THREE from 'three';
import { createDynamicMaterial } from '../render/materials.js';

const STATE_T = { closed: 0, locked: 0, open: 1 };

export function createDoors(ctx, W, collision, nav) {
  const mat = createDynamicMaterial({ color: [0.42, 0.44, 0.47] });
  const rollerMat = createDynamicMaterial({ color: [0.55, 0.57, 0.6] });
  const list = [];
  const byId = new Map();
  const zi = W.zoneIndex;
  W.doors.forEach((d, i) => {
    const w = d.b - d.a, h = d.y1 - d.y0, ax = d.axis === 'x';
    const th = d.kind === 'roller' ? 0.08 : Math.min(0.06, d.th * 0.5);
    const geo = new THREE.BoxGeometry(ax ? w : th, h, ax ? th : w);
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(geo, d.kind === 'roller' ? rollerMat : mat);
    mesh.name = `door:${d.id}`;
    pivot.add(mesh);
    // pivot at the hinge edge (swing) or at the opening centre (roller/slide)
    const mid = (d.a + d.b) / 2;
    if (d.kind === 'swing') {
      const hingeAlong = d.hinge === 'b' ? d.b : d.a, sign = d.hinge === 'b' ? -1 : 1;
      pivot.position.set(ax ? hingeAlong : d.at, d.y0 + h / 2, ax ? d.at : hingeAlong);
      mesh.position.set(ax ? sign * w / 2 : 0, 0, ax ? 0 : sign * w / 2);
    } else pivot.position.set(ax ? mid : d.at, d.y0 + h / 2, ax ? d.at : mid);
    pivot.visible = false;
    ctx.render.scene.add(pivot);
    const min = ax ? [d.a, d.y0, d.at - 0.08] : [d.at - 0.08, d.y0, d.a];
    const max = ax ? [d.b, d.y1, d.at + 0.08] : [d.at + 0.08, d.y1, d.b];
    const col = collision.addDynamic(min, max, { kind: 'door', id: d.id, surface: d.kind === 'roller' ? 'metal' : 'metal', shoot: true });
    const rec = {
      ...d, index: i, pivot, mesh, col, base: { min, max }, w, h,
      zonesIdx: (d.zones ?? []).map((z) => zi.get(z)).filter((z) => z !== undefined),
      t: 0, target: 0, speed: d.kind === 'roller' ? 0.8 : 1.6,
    };
    rec.speed0 = rec.speed;   // reset() restores it after a staged doors.set(…, {speed})
    rec.target = rec.t = targetFor(rec, d.state);
    list.push(rec); byId.set(d.id, rec);
    if (d.state === 'locked') nav.doorBlocked[i] = 1;
    apply(rec);
  });

  function targetFor(r, state) {
    if (state === 'half') return Math.min(1, 1.25 / r.h);
    return STATE_T[state] ?? 0;
  }
  function apply(r) {
    const t = r.t, ax = r.axis === 'x';
    const c = r.col, b = r.base;
    if (r.kind === 'swing') {
      const sign = r.hinge === 'b' ? -1 : 1;
      r.pivot.rotation.y = sign * t * Math.PI / 2 * (ax ? 1 : -1);
      c.enabled = t < 0.35;
    } else if (r.kind === 'roller') {
      const lift = r.h * t * 0.97;          // bottom edge rises, the curtain rolls into the drum at the top
      r.mesh.scale.y = Math.max(0.03, 1 - lift / r.h);
      r.mesh.position.y = lift / 2;
      c.min[1] = b.min[1] + lift;
      c.enabled = t < 0.999;
    } else {
      const off = r.w * t * 0.95;
      if (ax) r.mesh.position.x = off; else r.mesh.position.z = off;
      const k = ax ? 0 : 2;
      c.min[k] = b.min[k] + off; c.max[k] = b.max[k] + off;
      c.enabled = t < 0.999;
    }
  }

  const evt = { id: '', state: '', door: null };
  const api = {
    list, get: (id) => byId.get(id),
    /** set state: 'open' | 'closed' | 'half' | 'locked'. opts.speed (1/s), opts.instant */
    set(id, state, opts = {}) {
      const r = byId.get(id); if (!r) return false;
      r.state = state;
      r.target = targetFor(r, state);
      if (opts.speed) r.speed = opts.speed;
      if (opts.instant) { r.t = r.target; apply(r); }
      nav.doorBlocked[r.index] = state === 'locked' ? 1 : 0;
      evt.id = id; evt.state = state; evt.door = r;
      ctx.events.emit('door:state', evt);
      return true;
    },
    /** player/enemy interaction: toggle the nearest door in front of (x,y,z) facing (fx,fz) within maxD */
    use(x, y, z, fx, fz, maxD = 2.0) {
      let best = null, bd = maxD;
      for (const r of list) {
        const ax = r.axis === 'x', cx = ax ? (r.a + r.b) / 2 : r.at, cz = ax ? r.at : (r.a + r.b) / 2;
        const dx = cx - x, dz = cz - z, d = Math.hypot(dx, dz);
        if (d > bd || Math.abs(y - r.y0) > 1.2) continue;
        if ((dx * fx + dz * fz) / Math.max(d, 1e-3) < 0.3 && d > 0.8) continue;
        best = r; bd = d;
      }
      if (!best) return null;
      if (best.state === 'locked') { ctx.events.emit('door:locked', { id: best.id, door: best }); return best; }
      api.set(best.id, best.target > 0.5 ? 'closed' : 'open');
      return best;
    },
    update(dt, zoneVisible) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.t !== r.target) {
          const s = r.speed * dt;
          r.t = r.t < r.target ? Math.min(r.target, r.t + s) : Math.max(r.target, r.t - s);
          apply(r);
        }
        let vis = false;
        for (let k = 0; k < r.zonesIdx.length; k++) if (zoneVisible[r.zonesIdx[k]]) vis = true;
        r.pivot.visible = vis;
      }
    },
    reset() { for (const r of list) { r.state = W.doors[r.index].state; r.speed = r.speed0; r.target = r.t = targetFor(r, r.state); nav.doorBlocked[r.index] = r.state === 'locked' ? 1 : 0; apply(r); } },
  };
  return api;
}
