// LOD + animation-throttling helpers for dynamic actors (enemies, machines). Owner: core; used by A and D.
// Deterministic frame skipping: an actor far away updates its skeleton every Nth frame, staggered by index so
// the cost is spread evenly. Invisible (PVS-culled) actors update rarely, never zero (AI still runs).
export function createLod(ctx) {
  const cam = () => ctx.render.camera.position;
  return {
    /** distance from camera */
    dist(x, y, z) { const c = cam(); return Math.hypot(x - c.x, y - c.y, z - c.z); },
    /** 0 = full detail (< 15 m), 1 = reduced (< 40 m), 2 = far, 3 = not visible (zone culled) */
    level(x, y, z) {
      if (!ctx.world.isPointVisible(x, y, z)) return 3;
      const d = this.dist(x, y, z);
      return d < 15 ? 0 : d < 40 ? 1 : 2;
    },
    /** should actor #index update its animation this frame? rate scales with tier (quality.tier.anim) */
    animStep(index, level) {
      const f = ctx.time.frame, k = ctx.quality.tier.anim < 0.8 ? 2 : 1;
      const every = level === 0 ? 1 : level === 1 ? 2 * k : level === 2 ? 4 * k : 8;
      return (f + index) % every === 0;
    },
    /** delta time to feed an animation mixer that is updated every `every` frames */
    animEvery(level) { const k = ctx.quality.tier.anim < 0.8 ? 2 : 1; return level === 0 ? 1 : level === 1 ? 2 * k : level === 2 ? 4 * k : 8; },
  };
}
