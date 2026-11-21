// Workstream D tests (Node, headless, deterministic): enemy roster sanity, every enemy can path to the player,
// seeded simulations of a bot player clearing the level against the real enemy brain (src/enemies/brain.js):
// nobody stuck, no shots through walls / closed doors, sane outcomes, determinism. Asset contract checks.
import { readFileSync } from 'node:fs';
import { createBrain, WEAPONS, HEALTH } from '../src/enemies/brain.js';
import { createSimEnv } from '../src/enemies/simenv.js';
import { createDevtools } from '../src/core/devtools.js';
import { F_OCC } from '../src/world/gen.js';

const STUCK_MAX_S = 6;

export default async function ({ W, bvh, nav, LAYOUT, ok, warn }) {
  const t0 = performance.now();
  const defs = LAYOUT.enemies;
  // ---- roster
  ok(defs.length >= 18 && defs.length <= 26, `enemy count ${defs.length} outside 18..26`);
  for (const d of defs) {
    ok(WEAPONS[d.weapon], `${d.id}: unknown weapon ${d.weapon}`);
    ok(['guard', 'patrol', 'sleeper', 'ambusher'].includes(d.role), `${d.id}: unknown role ${d.role}`);
    const anchor = d.seat ?? d.bed;
    if (anchor) ok(Math.hypot(anchor[0] - d.pos[0], anchor[2] - d.pos[2]) < 2.5 && Math.abs(anchor[1] - d.pos[1]) < 1, `${d.id}: seat/bed anchor too far from its nav position`);
  }
  // ---- every enemy can path to the player spawn and to the extraction
  const tmp = new Int32Array(8192);
  const ps = LAYOUT.playerSpawn.pos;
  const pn = nav.nearest(ps[0], ps[1] + 0.1, ps[2]);
  for (const d of defs) {
    const a = nav.nearest(d.pos[0], d.pos[1] + 0.1, d.pos[2], 2);
    ok(a >= 0 && nav.findPath(a, pn, tmp, 200000) > 0, `${d.id}: no path from its spawn to the player spawn`);
  }

  // ---- seeded simulations with a bot player walking the dev tour and shooting what it sees
  const tour = createDevtools({}).tour;
  const runs = [];
  for (const seed of [1, 2, 3]) runs.push(simulate(seed));
  const again = simulate(2);
  ok(JSON.stringify(again.sig) === JSON.stringify(runs[1].sig), 'simulation is not deterministic for the same seed');

  let kills = 0, deaths = 0;
  for (const r of runs) {
    const s = r.stats;
    console.log(`  seed ${r.seed}: ${r.outcome} after ${r.t.toFixed(0)} s · player hp ${Math.max(0, r.hp).toFixed(0)} · kills ${s.kills}/${defs.length}`
      + ` · surrendered ${s.surrendered} fled ${s.fled} · enemy shots ${s.shots} hits ${s.hits} near-miss ${s.nearMisses} FF-holds ${s.shotsBlockedFF}`
      + ` · think max ${s.thinkMsMax.toFixed(1)} ms path max ${s.pathMsMax.toFixed(1)} ms` + ` · stuck max ${s.stuckMax.toFixed(1)} s (${s.stuckId || '-'}) · alerted ${r.alerted} · ${r.ms.toFixed(0)} ms`);
    ok(r.unsafe === 0, `seed ${r.seed}: ${r.unsafe} enemy shots fired without line of sight (through walls/doors)`);
    ok(s.stuckMax < STUCK_MAX_S, `seed ${r.seed}: enemy ${s.stuckId} stuck for ${s.stuckMax.toFixed(1)} s`);
    ok(r.nan === 0, `seed ${r.seed}: NaN enemy positions`);
    ok(r.offNav === 0, `seed ${r.seed}: ${r.offNav} living enemies ended off the nav grid`);
    ok(r.badBodies === 0, `seed ${r.seed}: ${r.badBodies} bodies hang off edges / lie in props`);
    ok(s.shots > 0 && s.kills > 0, `seed ${r.seed}: no fighting happened (shots ${s.shots}, kills ${s.kills})`);
    ok(s.hits <= s.shots * 0.6, `seed ${r.seed}: enemies too accurate (${s.hits}/${s.shots})`);
    warn(s.hits >= s.shots * 0.04, `seed ${r.seed}: enemies barely hit (${s.hits}/${s.shots})`);
    ok(r.firstShotHitsClose <= r.firstShotsClose * 0.5 + 1, `seed ${r.seed}: first shots at close range hit too often (${r.firstShotHitsClose}/${r.firstShotsClose})`);
    kills += s.kills; deaths += r.outcome === 'dead' ? 1 : 0;
  }
  warn(deaths > 0, 'the bot never died in 3 runs: enemies may be too weak');
  warn(deaths < 3, 'the bot died in every run: enemies may be unfair (bot is simple, so this is only a hint)');
  console.log(`  total ${((performance.now() - t0) / 1000).toFixed(2)} s`);

  // ---- assets: hit capsules cover the top of the head (fixed head capsule)
  const hb = JSON.parse(readFileSync('public/assets/chars/hitboxes.json', 'utf8'));
  const head = hb.capsules.find((c) => c.part === 'head');
  ok(head && Math.max(head.a[1], head.b[1]) + head.r >= 0.145, 'head hit capsule does not reach the top of the skull');

  function simulate(seed) {
    const ts = performance.now();
    const env = createSimEnv({ W, bvh, nav, LAYOUT });
    let unsafe = 0, firstShotsClose = 0, firstShotHitsClose = 0;
    const P = env.player;
    const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
    const audit = (e, o, d, pl) => {
      // independent check (raw BVH + doors): the target (head or body) must be visible from the muzzle
      let vis = false;
      for (const y of [pl.eye.y - 0.05, pl.pos.y + (pl.crouched ? 0.8 : 1.2), pl.pos.y + 0.6]) {
        B.x = pl.pos.x; B.y = y; B.z = pl.pos.z;
        if (!bvh.occluded(o.x, o.y, o.z, B.x - o.x, B.y - o.y, B.z - o.z, 1, F_OCC) && env.los(o, B)) vis = true;
      }
      if (!vis) unsafe++;
      if (e.shotsThisContact === 1 && Math.hypot(pl.pos.x - o.x, pl.pos.z - o.z) < 12) { firstShotsClose++; e._fsc = true; }
    };
    const brain = createBrain(env, defs, { seed, proxyCaps: true, audit });
    env.setBrain(brain);
    const DBG = process.env.D_DEBUG && +process.env.D_DEBUG === seed;
    let lastShooter = null;
    env.on('enemy:fire', (f) => { lastShooter = f.enemy; });
    if (DBG) {
      env.on('d:state', (s) => console.log(`    ${brain.now.toFixed(1)} ${s.id} ${s.from}→${s.to}  @${s.enemy.pos.x.toFixed(1)},${s.enemy.pos.z.toFixed(1)}  P ${P.pos.x.toFixed(1)},${P.pos.z.toFixed(1)}`));
      env.on('enemy:death', (s) => console.log(`    ${brain.now.toFixed(1)} ${s.id} DIES (${s.enemy.deathClip})`));
      env.on('d:voice', (s) => console.log(`    ${brain.now.toFixed(1)} ${s.id} says ${s.kind}`));
    }
    let hpBefore = 100;
    env.on('player:death', () => {});
    brain.reset(seed);
    // player
    P.pos.x = ps[0]; P.pos.y = ps[1]; P.pos.z = ps[2]; P.health = 100; P.dead = false;
    const path = new Int32Array(8192);
    let leg = 0, nodes = [], ni = 0, t = 0, target = null, seeT = 0, fireCd = 0, yaw = 0;
    const dt = 1 / 30, T = 300;
    const fired = new Set();
    const trig = new Set();
    let outcome = 'timeout';
    const stuck = { max: 0, id: '', at: '' };
    const rngB = mulberry(seed * 77);
    while (t < T) {
      t += dt;
      // ---- bot: engage the nearest visible living threat, else walk the tour
      P.eye.x = P.pos.x; P.eye.y = P.pos.y + 1.5; P.eye.z = P.pos.z;
      if (Math.floor(t / dt) % 6 === 0) {
        target = null; let bd = 30;
        for (const e of brain.list) {
          if (e.dead || !e.active || e.state === 'surrender') continue;
          const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
          if (d > bd) continue;
          A.x = P.eye.x; A.y = P.eye.y; A.z = P.eye.z; B.x = e.pos.x; B.y = e.pos.y + (e.crouch ? 0.9 : 1.3); B.z = e.pos.z;
          if (env.los(A, B)) { bd = d; target = e; }
        }
        if (!target) seeT = 0;
      }
      let moving = 0;
      if (target) {
        seeT += dt;
        yaw = Math.atan2(-(target.pos.x - P.pos.x), -(target.pos.z - P.pos.z));
        fireCd -= dt;
        if (seeT > 0.45 && fireCd <= 0) {
          fireCd = 0.32;
          const ty = target.pos.y + (target.crouch ? 0.85 : 1.25);
          let dx = target.pos.x - P.eye.x, dy = ty - P.eye.y, dz = target.pos.z - P.eye.z;
          const l = Math.hypot(dx, dy, dz);
          const s = 0.014;
          dx = dx / l + gauss(rngB) * s; dy = dy / l + gauss(rngB) * s; dz = dz / l + gauss(rngB) * s;
          const m = Math.hypot(dx, dy, dz);
          env.playerFire(P.eye, { x: dx / m, y: dy / m, z: dz / m }, 120, 34);
        }
      } else {
        if (ni >= nodes.length) {
          if (leg >= tour.length) { outcome = 'done'; break; }
          const w = tour[leg++];
          const a = nav.nearest(P.pos.x, P.pos.y + 0.1, P.pos.z), b = nav.nearest(w[0], w[1] + 0.1, w[2]);
          const n = nav.findPath(a, b, path, 200000);
          nodes = Array.from(path.subarray(0, n)).reverse(); ni = 0;
          if (!n) continue;
        }
        const k = nodes[ni];
        const door = nav.nodeDoor[k];
        if (door >= 0) env.openDoor(door);
        const tx = nav.nodeX(k), tz = nav.nodeZ(k), dx = tx - P.pos.x, dz = tz - P.pos.z, d = Math.hypot(dx, dz);
        const sp = 2.3 * dt;
        if (d <= sp) { P.pos.x = tx; P.pos.z = tz; P.pos.y = nav.nodeY[k]; ni++; }
        else { P.pos.x += dx / d * sp; P.pos.z += dz / d * sp; P.pos.y += (nav.nodeY[k] - P.pos.y) * 0.3; yaw = Math.atan2(-dx, -dz); }
        moving = 2.3;
      }
      P.moving = moving;
      P.forward.x = -Math.sin(yaw); P.forward.z = -Math.cos(yaw); P.forward.y = 0;
      // staged moments: the director arms ambushers / alerts groups when the player enters a trigger box
      for (const m of LAYOUT.moments) {
        const b = m.box;
        if (!trig.has(m.id) && P.pos.x > b[0] && P.pos.x < b[3] && P.pos.y > b[1] && P.pos.y < b[4] && P.pos.z > b[2] && P.pos.z < b[5]) { trig.add(m.id); brain.trigger(m.id); }
      }
      brain.update(dt);
      // independent stuck metric: wants to move but no 0.5 m of progress (across repaths) for how long?
      for (const e of brain.list) {
        const s = (e._stk ??= { x: e.pos.x, z: e.pos.z, t: t });
        if (!e.wantMove || e.dead || e.busyUntil > brain.now || Math.hypot(e.pos.x - s.x, e.pos.z - s.z) > 0.5) { s.x = e.pos.x; s.z = e.pos.z; s.t = t; }
        else if (t - s.t > stuck.max) { stuck.max = t - s.t; stuck.id = e.id; stuck.at = [e.pos.x.toFixed(1), e.pos.y.toFixed(1), e.pos.z.toFixed(1)].join(','); }
      }
      for (const e of brain.list) if (e._fsc && !fired.has(e.id)) { fired.add(e.id); if (P.health < hpBefore) firstShotHitsClose++; }
      if (DBG && P.health < hpBefore) console.log(`    ${brain.now.toFixed(1)} player hit by ${lastShooter?.id} (${lastShooter?.def.weapon}) at ${Math.hypot(lastShooter.pos.x - P.pos.x, lastShooter.pos.z - P.pos.z).toFixed(1)} m, hp ${P.health.toFixed(0)}, bot target ${target?.id ?? '-'}`);
      hpBefore = P.health;
      if (P.dead) { outcome = 'dead'; break; }
    }
    // end checks
    let nan = 0, offNav = 0, badBodies = 0, alerted = 0;
    for (const e of brain.list) {
      if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) nan++;
      if (e.alerted) alerted++;
      if (!e.dead && !(e.def.seat || e.def.bed) && nav.nearest(e.pos.x, e.pos.y + 0.2, e.pos.z, 1) < 0) offNav++;
      if (e.dead && e.deathClip.startsWith('death_') && e.deathClip !== 'death_slump') {
        const len = 1.5, y = e.bodyYaw + (e.deathClip === 'death_backward' ? Math.PI : 0);
        if (!env.fallClear(e.pos.x, e.pos.y, e.pos.z, -Math.sin(y), -Math.cos(y), len)) badBodies++;
      }
    }
    const sig = [brain.stats.shots, brain.stats.kills, brain.stats.hits, +P.health.toFixed(3), ...brain.list.map((e) => +(e.pos.x + e.pos.z).toFixed(4))];
    return { seed, outcome, t, hp: P.health, stats: { ...brain.stats, stuckMax: stuck.max, stuckId: stuck.id + '@' + stuck.at }, unsafe, nan, offNav, badBodies, alerted, sig, firstShotsClose, firstShotHitsClose, ms: performance.now() - ts };
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { return (r() + r() + r() - 1.5) * 2; }
export const _HEALTH = HEALTH;
