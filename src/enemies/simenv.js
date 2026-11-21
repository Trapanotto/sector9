// Headless simulation environment for the enemy brain (Node tests; no three.js / DOM): box BVH line of sight,
// bullets, doors as colliders (instant), a scripted bot player. Mirrors the browser env in enemies.js. Owner: D.
import { F_OCC, F_SHOOT } from '../world/gen.js';
import { createCollision } from '../world/collision.js';
import { buildCover } from './cover.js';
import { makeFallClear } from './envkit.js';

export function createSimEnv({ W, bvh, nav, LAYOUT }) {
  const collision = createCollision(bvh);
  // doors (same collider footprint as src/world/doors.js; instant open)
  const doors = W.doors.map((d, i) => {
    const ax = d.axis === 'x';
    const min = ax ? [d.a, d.y0, d.at - 0.08] : [d.at - 0.08, d.y0, d.a];
    const max = ax ? [d.b, d.y1, d.at + 0.08] : [d.at + 0.08, d.y1, d.b];
    const col = collision.addDynamic(min, max, { kind: 'door', id: d.id, shoot: true });
    const r = { def: d, col, state: d.state, open: d.state === 'open' ? 1 : 0, index: i };
    col.enabled = r.open < 0.5;
    if (d.state === 'locked') nav.doorBlocked[i] = 1;
    return r;
  });
  const cover = buildCover(nav, bvh, LAYOUT.site.bounds);
  const hitTmp = { t: 0, side: 0 };
  const events = [];
  const counts = {};
  const listeners = {};
  const player = {
    pos: { x: 0, y: 0, z: 0 }, eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 },
    crouched: false, moving: 0, dead: false, flashlight: false, health: 100, ref: null,
  };
  player.ref = player;
  const res = { hit: false, t: 0, target: null, point: { x: 0, y: 0, z: 0 } };
  let brain = null;

  const los = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (bvh.occluded(a.x, a.y, a.z, dx, dy, dz, 1, F_OCC)) return false;
    for (const r of doors) if (r.col.enabled && rayAabb(a, dx, dy, dz, r.col.min, r.col.max, 1) >= 0) return false;
    return true;
  };
  const part = { name: '', capsule: '' };

  const env = {
    nav, collision, cover, doors, player, events, counts,
    los,
    lightAt: () => 0.8,
    maskAt: () => 0,
    doorOpen: (i) => doors[i].open,
    doorState: (i) => doors[i].state,
    openDoor: (i) => { const r = doors[i]; if (r.state === 'locked') return; r.state = 'open'; r.open = 1; r.col.enabled = false; },
    fallClear: makeFallClear(bvh, collision),
    on(name, fn) { (listeners[name] ??= []).push(fn); },
    emit(name, p) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (events.length < 20000) events.push([name, p.id ?? '', p.kind ?? '']);
      const l = listeners[name]; if (l) for (const f of l) f(p);
    },
    /** bullet: static (F_SHOOT) + closed doors, then the player cylinder and other enemies (no team filter here) */
    fire(shooter, o, d, range, dmg) {
      let t = range;
      const b = bvh.raycast(o.x, o.y, o.z, d.x, d.y, d.z, range, F_SHOOT, hitTmp);
      if (b >= 0) t = hitTmp.t;
      for (const r of doors) if (r.col.enabled) { const td = rayAabb(o, d.x, d.y, d.z, r.col.min, r.col.max, t); if (td >= 0 && td < t) t = td; }
      res.hit = false; res.target = null;
      const tp = rayPlayer(player, o, d, t);
      if (tp >= 0) { t = tp; res.hit = true; res.target = player; }
      res.t = t; res.point.x = o.x + d.x * t; res.point.y = o.y + d.y * t; res.point.z = o.z + d.z * t;
      if (res.target === player && !player.dead) {
        player.health -= dmg;
        if (player.health <= 0) { player.dead = true; env.emit('player:death', {}); }
      }
      return res;
    },
    /** player shot: bullets vs world + enemy capsules (through the brain), like core combat */
    playerFire(o, d, range, dmg) {
      let t = range;
      const b = bvh.raycast(o.x, o.y, o.z, d.x, d.y, d.z, range, F_SHOOT, hitTmp);
      if (b >= 0) t = hitTmp.t;
      for (const r of doors) if (r.col.enabled) { const td = rayAabb(o, d.x, d.y, d.z, r.col.min, r.col.max, t); if (td >= 0 && td < t) t = td; }
      let best = null, bestPart = '';
      for (const e of brain.list) {
        const te = brain.raycast(e, o, d, t, part);
        if (te >= 0 && te < t) { t = te; best = e; bestPart = part.capsule; }
      }
      brain.noise(o.x, o.y, o.z, 60, 'shot', null);
      if (best) brain.applyHit(best, bestPart, dmg, d, true);
      return best;
    },
    setBrain(b) { brain = b; },
  };
  return env;
}

function rayPlayer(p, o, d, maxT) {
  const h = p.crouched ? 1.15 : 1.78, R = 0.3;
  const ox = o.x - p.pos.x, oz = o.z - p.pos.z, a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) return -1;
  const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - R * R, disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  const y = o.y + d.y * t - p.pos.y;
  return y < 0 || y > h ? -1 : t;
}

export function rayAabb(o, dx, dy, dz, mn, mx, tmax) {
  let t0 = 0, t1 = tmax;
  const oo = [o.x, o.y, o.z], dd = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dd[a]) < 1e-12) { if (oo[a] < mn[a] || oo[a] > mx[a]) return -1; continue; }
    let n = (mn[a] - oo[a]) / dd[a], f = (mx[a] - oo[a]) / dd[a];
    if (n > f) { const s = n; n = f; f = s; }
    if (n > t0) t0 = n; if (f < t1) t1 = f;
    if (t0 > t1) return -1;
  }
  return t0;
}
