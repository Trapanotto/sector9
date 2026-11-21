// Hitscan resolution shared by player and enemies. Owner: core.
// Hittables (enemies, player) register { id, kind, team, raycast(o, d, maxT, part) → t or -1, onHit(info) }.
// fire() tests the world (static, doors, glass, dynamic colliders) and all hittables, breaks breakable glass on
// the way (bullet continues), and emits 'shot' and, on a hittable, 'hit' events. One reused result object.
export function createCombat(ctx) {
  const hittables = [];
  const wh = { hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '', box: -1, zone: -1, owner: null };
  const res = {
    hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '',
    target: null, part: '', damage: 0, shooter: null, origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 }, glassBroken: '',
  };
  const part = { name: '' };
  const o2 = { x: 0, y: 0, z: 0 };
  return {
    hittables,
    register(h) { hittables.push(h); return () => this.unregister(h); },
    unregister(h) { const i = hittables.indexOf(h); if (i >= 0) hittables.splice(i, 1); },
    /** opts: { origin{x,y,z}, dir{x,y,z} normalised, range, damage, shooter (hittable or null), team } */
    fire(opts) {
      const o = opts.origin, d = opts.dir, range = opts.range ?? 200;
      res.origin.x = o.x; res.origin.y = o.y; res.origin.z = o.z; res.dir.x = d.x; res.dir.y = d.y; res.dir.z = d.z;
      res.glassBroken = ''; res.shooter = opts.shooter ?? null; res.damage = opts.damage ?? 30;
      let start = 0;
      o2.x = o.x; o2.y = o.y; o2.z = o.z;
      // world, with glass penetration (max 2 panes)
      for (let k = 0; k < 3; k++) {
        ctx.world.worldHit(o2, d, range - start, wh);
        if (wh.hit && wh.kind === 'glass' && ctx.world.glass.break(wh.id, wh.point)) {
          res.glassBroken = wh.id;
          start += wh.t + 0.02; o2.x = o.x + d.x * start; o2.y = o.y + d.y * start; o2.z = o.z + d.z * start;
          continue;
        }
        break;
      }
      let bestT = wh.hit ? start + wh.t : range, best = null;
      for (let i = 0; i < hittables.length; i++) {
        const h = hittables[i];
        if (h === opts.shooter || h.dead) continue;
        if (opts.team && h.team === opts.team) continue;
        const t = h.raycast(o, d, bestT, part);
        if (t >= 0 && t < bestT) { bestT = t; best = h; res.part = part.name; }
      }
      res.t = bestT; res.target = best;
      res.point.x = o.x + d.x * bestT; res.point.y = o.y + d.y * bestT; res.point.z = o.z + d.z * bestT;
      if (best) {
        res.hit = true; res.kind = best.kind; res.id = best.id; res.surface = 'flesh';
        res.normal.x = -d.x; res.normal.y = -d.y; res.normal.z = -d.z;
        best.onHit?.(res);
        ctx.events.emit('hit', res);
      } else {
        res.hit = wh.hit; res.kind = wh.kind; res.id = wh.id; res.surface = wh.surface; res.part = '';
        res.normal.x = wh.normal.x; res.normal.y = wh.normal.y; res.normal.z = wh.normal.z;
      }
      ctx.events.emit('shot', res);
      return res;
    },
  };
}
