// Pure helpers shared by the browser env (enemies.js) and the headless sim env (simenv.js). Owner: D.
import { F_SOLID } from '../world/gen.js';

/**
 * fallClear(x, y, z, dx, dz, len): would a body falling from (x,y,z) along (dx,dz) for `len` metres lie on flat
 * floor at the same height (not off an edge / down stairs, not on or into props)? Allocation-free.
 */
export function makeFallClear(bvh, collision) {
  let hit = false;
  const onHit = () => { hit = true; };
  return (x, y, z, dx, dz, len) => {
    for (let s = 0.35; s <= len + 0.01; s += 0.3) {
      const px = x + dx * s, pz = z + dz * s;
      const g = collision.groundHeight(px, pz, y + 0.35, 0.12);
      if (!(Math.abs(g - y) < 0.12)) return false;
      hit = false;
      bvh.query(px - 0.17, y + 0.1, pz - 0.17, px + 0.17, y + 0.55, pz + 0.17, F_SOLID, onHit);
      if (hit) return false;
      // dynamic colliders (doors, AGVs)
      const dyn = collision.dynamic;
      for (let i = 0; i < dyn.length; i++) {
        const c = dyn[i];
        if (c.enabled && c.max[0] > px - 0.17 && c.min[0] < px + 0.17 && c.max[2] > pz - 0.17 && c.min[2] < pz + 0.17 && c.max[1] > y + 0.1 && c.min[1] < y + 0.55) return false;
      }
    }
    return true;
  };
}

/** Machine noise masking per zone (0..1), driven by machine:state events. zoneIds → mask level when running. */
export function makeMasking(zoneIndex, zoneAt) {
  const level = new Float32Array(Math.max(1, zoneIndex.size));
  const running = new Map();   // machine id → zone indexes
  const MACHINE_ZONES = { conveyor: ['auto_n', 'auto_s', 'versand'], robot: ['roboter', 'versand'], crane: ['akl'], agv: [] };
  const recompute = () => {
    level.fill(0);
    for (const zs of running.values()) for (const z of zs) level[z] = 0.8;
  };
  return {
    level,
    onMachine(ev) {
      const on = ev.state === 'running' || ev.state === 'on' || ev.state === 'moving' || ev.state === 'start' || ev.state === true;
      if (on) running.set(ev.id, (MACHINE_ZONES[ev.kind] ?? []).map((z) => zoneIndex.get(z)).filter((z) => z !== undefined));
      else running.delete(ev.id);
      recompute();
    },
    reset() { running.clear(); level.fill(0); },
    at(x, y, z) { const i = zoneAt(x, y + 1, z); return i >= 0 ? level[i] : 0; },
  };
}
