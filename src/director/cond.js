// Positions and conditions for staged-moment timelines (data → compiled objects → allocation-free evaluation).
// Pure logic (runs in Node for scripts/test-f-director.mjs with a fake ctx). Owner: F.
//
// Position specs:  [x,y,z] | 'player' | 'e08' (enemy, head height) | { door: 'd_geld' } (door centre)
//                  | { rel: [right, up, back] } (relative to the player's view) | { catwalk: dx } (catwalk above /
//                  hall floor below the player, dx along x) | { agv: 'agv2' } (vehicle position)
// Condition specs: ['near', pos, r] ['far', pos, r] ['look', pos, cos, maxDist] ['away', pos, cos]
//                  ['zone', [zoneIds]] ['inBox', [x0,y0,z0,x1,y1,z1]] ['doorOpen', id] ['dead', ids] ['alive', ids]
//                  ['breach', doorId] ['time', missionSeconds] ['evidence', n] ['done', momentId]
//                  ['any', c1, c2, ...] ['all', c1, c2, ...] ['not', c]
// ids: array of enemy ids and/or '@group' names (GROUPS in moments.js).

export const P = { LIT: 0, PLAYER: 1, ENEMY: 2, DOOR: 3, REL: 4, CATWALK: 5, AGV: 6 };
export const C = {
  NEAR: 1, FAR: 2, LOOK: 3, AWAY: 4, ZONE: 5, BOX: 6, DOOR_OPEN: 7, DEAD: 8, ALIVE: 9, BREACH: 10, TIME: 11,
  EVIDENCE: 12, DONE: 13, ANY: 14, ALL: 15, NOT: 16,
};
const NAMES = { near: C.NEAR, far: C.FAR, look: C.LOOK, away: C.AWAY, zone: C.ZONE, inBox: C.BOX, doorOpen: C.DOOR_OPEN,
  dead: C.DEAD, alive: C.ALIVE, breach: C.BREACH, time: C.TIME, evidence: C.EVIDENCE, done: C.DONE, any: C.ANY, all: C.ALL, not: C.NOT };

/**
 * env: { ctx, enemyIds (layout order), groups, zoneIndex (Map id → index), zoneCount,
 *        enemy(k) → bound enemy record or null, momentDone(id), evidenceCount(), breached(id), playerZone }
 */
export function createSpace(env) {
  const ctx = env.ctx;
  const eIndex = new Map(env.enemyIds.map((id, i) => [id, i]));
  const errors = [];   // compile problems (unknown ids) — the test reads these

  function ids(spec) {
    const out = [];
    const add = (id) => {
      if (typeof id !== 'string') { errors.push(`bad enemy ref ${id}`); return; }
      if (id[0] === '@') { const g = env.groups[id.slice(1)]; if (!g) errors.push(`unknown group ${id}`); else g.forEach(add); return; }
      const k = eIndex.get(id);
      if (k === undefined) errors.push(`unknown enemy ${id}`); else if (!out.includes(k)) out.push(k);
    };
    (Array.isArray(spec) ? spec : [spec]).forEach(add);
    return Int16Array.from(out);
  }

  function pos(spec) {
    const p = { k: P.LIT, x: 0, y: 0, z: 0, e: -1, id: '' };
    if (spec == null) { p.k = P.PLAYER; return p; }
    if (Array.isArray(spec)) { p.x = spec[0]; p.y = spec[1]; p.z = spec[2]; return p; }
    if (spec === 'player') { p.k = P.PLAYER; return p; }
    if (typeof spec === 'string') {
      const k = eIndex.get(spec);
      if (k === undefined) errors.push(`unknown enemy position ${spec}`);
      p.k = P.ENEMY; p.e = k ?? -1; p.id = spec; return p;
    }
    if (spec.door) { p.k = P.DOOR; p.id = spec.door; return p; }
    if (spec.rel) { p.k = P.REL; [p.x, p.y, p.z] = spec.rel; return p; }
    if (spec.catwalk !== undefined) { p.k = P.CATWALK; p.x = spec.catwalk; return p; }
    if (spec.agv) { p.k = P.AGV; p.id = spec.agv; return p; }
    errors.push(`bad position ${JSON.stringify(spec)}`);
    return p;
  }

  /** resolve into out {x,y,z}; false if the referenced actor is gone */
  function resolve(p, out) {
    const pl = ctx.player;
    switch (p.k) {
      case P.LIT: out.x = p.x; out.y = p.y; out.z = p.z; return true;
      case P.PLAYER: out.x = pl.eye.x; out.y = pl.eye.y; out.z = pl.eye.z; return true;
      case P.ENEMY: {
        const e = env.enemy(p.e);
        if (!e || e.dead) return false;
        out.x = e.pos.x; out.y = e.pos.y + 1.5; out.z = e.pos.z; return true;
      }
      case P.DOOR: {
        const d = ctx.world.doors?.get(p.id);
        if (!d) return false;
        const m = (d.a + d.b) / 2, ax = d.axis === 'x';
        out.x = ax ? m : d.at; out.y = d.y0 + 1.2; out.z = ax ? d.at : m; return true;
      }
      case P.REL: {
        const sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw);
        out.x = pl.pos.x + cy * p.x + sy * p.z; out.y = pl.pos.y + 1.5 + p.y; out.z = pl.pos.z - sy * p.x + cy * p.z; return true;
      }
      case P.CATWALK: {
        const low = pl.pos.y < 2.5;
        out.x = Math.max(29, Math.min(71, pl.pos.x + p.x)); out.y = low ? 4.7 : 0.4; out.z = low ? 0.8 : 3.2; return true;
      }
      case P.AGV: {
        const a = ctx.machines?.agv?.(p.id);
        const q = a?.pos ?? a?.group?.position;
        if (!q) return false;
        out.x = q.x; out.y = (q.y ?? 0) + 0.6; out.z = q.z; return true;
      }
    }
    return false;
  }

  function cond(spec) {
    if (!Array.isArray(spec)) { errors.push(`bad condition ${JSON.stringify(spec)}`); return { t: C.TIME, n: 0 }; }
    const t = NAMES[spec[0]];
    if (!t) { errors.push(`unknown condition ${spec[0]}`); return { t: C.TIME, n: 0 }; }
    const c = { t, p: null, n: 0, n2: 0, s: '', ids: null, box: null, mask: null, kids: null, los: false, losFrame: -999, spec };
    switch (t) {
      case C.NEAR: case C.FAR: c.p = pos(spec[1]); c.n = spec[2] * spec[2]; break;
      case C.LOOK: c.p = pos(spec[1]); c.n = spec[2] ?? 0.9; c.n2 = spec[3] ?? 30; break;
      case C.AWAY: c.p = pos(spec[1]); c.n = spec[2] ?? 0; break;
      case C.ZONE: {
        c.mask = new Uint8Array(env.zoneCount);
        for (const z of spec[1]) { const i = env.zoneIndex.get(z); if (i === undefined) errors.push(`unknown zone ${z}`); else c.mask[i] = 1; }
        break;
      }
      case C.BOX: c.box = Float32Array.from(spec[1]); break;
      case C.DOOR_OPEN: case C.BREACH: c.s = spec[1]; break;
      case C.DEAD: case C.ALIVE: c.ids = ids(spec[1]); break;
      case C.TIME: case C.EVIDENCE: c.n = spec[1]; break;
      case C.DONE: c.s = spec[1]; break;
      case C.ANY: case C.ALL: c.kids = spec.slice(1).map(cond); break;
      case C.NOT: c.kids = [cond(spec[1])]; break;
    }
    return c;
  }

  const tmp = { x: 0, y: 0, z: 0 };
  function evaluate(c) {
    const pl = ctx.player;
    switch (c.t) {
      case C.NEAR: case C.FAR: {
        if (!resolve(c.p, tmp)) return c.t === C.FAR;
        const dx = tmp.x - pl.pos.x, dy = tmp.y - (pl.pos.y + 1.5), dz = tmp.z - pl.pos.z;
        const d2 = dx * dx + dy * dy * 0.5 + dz * dz;   // vertical distance counts less (floors are 4.5 m apart)
        return c.t === C.NEAR ? d2 <= c.n : d2 > c.n;
      }
      case C.LOOK: {
        if (!resolve(c.p, tmp)) return false;
        const e = pl.eye, f = pl.forward;
        const dx = tmp.x - e.x, dy = tmp.y - e.y, dz = tmp.z - e.z, d = Math.hypot(dx, dy, dz);
        if (d > c.n2 || d < 1e-3) return d < 1e-3;
        if ((dx * f.x + dy * f.y + dz * f.z) / d < c.n) return false;
        const fr = ctx.time.frame;
        if (fr - c.losFrame >= 4) {   // line of sight throttled to every 4th frame
          c.losFrame = fr;
          // stop 0.4 m short of the target so the target's own prop doesn't occlude it
          const k = Math.max(0, (d - 0.4) / d);
          tmp.x = e.x + dx * k; tmp.y = e.y + dy * k; tmp.z = e.z + dz * k;
          c.los = ctx.world.lineOfSight(e, tmp);
        }
        return c.los;
      }
      case C.AWAY: {
        if (!resolve(c.p, tmp)) return true;
        const dx = tmp.x - pl.pos.x, dz = tmp.z - pl.pos.z, d = Math.hypot(dx, dz) || 1;
        const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
        return (dx * fx + dz * fz) / d < c.n;
      }
      case C.ZONE: return env.playerZone >= 0 && c.mask[env.playerZone] === 1;
      case C.BOX: {
        const b = c.box, p = pl.pos;
        return p.x >= b[0] && p.x <= b[3] && p.y >= b[1] && p.y <= b[4] && p.z >= b[2] && p.z <= b[5];
      }
      case C.DOOR_OPEN: { const d = ctx.world.doors?.get(c.s); return !!d && d.t > 0.5; }
      case C.DEAD: { for (let i = 0; i < c.ids.length; i++) { const e = env.enemy(c.ids[i]); if (e && !e.dead) return false; } return true; }
      case C.ALIVE: { for (let i = 0; i < c.ids.length; i++) { const e = env.enemy(c.ids[i]); if (e && !e.dead) return true; } return false; }
      case C.BREACH: return env.breached(c.s);
      case C.TIME: return ctx.time.mission >= c.n;
      case C.EVIDENCE: return env.evidenceCount() >= c.n;
      case C.DONE: return env.momentDone(c.s);
      case C.ANY: { for (let i = 0; i < c.kids.length; i++) if (evaluate(c.kids[i])) return true; return false; }
      case C.ALL: { for (let i = 0; i < c.kids.length; i++) if (!evaluate(c.kids[i])) return false; return true; }
      case C.NOT: return !evaluate(c.kids[0]);
    }
    return false;
  }

  return { ids, pos, resolve, cond, evaluate, errors, enemyIndex: eIndex };
}
