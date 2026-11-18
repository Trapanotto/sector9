// Node self-test for the enemies module (no DOM, no renderer).
// Run from the project root:  node src/enemies/selftest.mjs
import * as THREE from 'three';
import { createCombat } from '../core/combat.js';
import { createEnemies } from './enemies.js';
import { createNav } from './nav.js';
import { aimError } from './ai.js';
import { TUNING } from './tuning.js';

let failures = 0;
const check = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg); } };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const DT = 1 / 60;

// ---- mock level: 30x30 hall split by a wall at x=0 (z -15..4), doorway z 4..6, crates -----------
function makeLevel(scene, spawns) {
  const colliders = [
    new THREE.Box3(V(-0.2, 0, -15), V(0.2, 3.2, 4)),     // dividing wall, gap z 4..6
    new THREE.Box3(V(-0.2, 0, 6), V(0.2, 3.2, 15)),
    new THREE.Box3(V(5, 0, -3), V(6, 1.1, -2)),          // low crate (crouch cover)
    new THREE.Box3(V(8, 0, 3), V(9.2, 2.4, 4.2)),        // tall machine
    new THREE.Box3(V(-15.2, 0, -15), V(-15, 3.2, 15)),   // outer walls
    new THREE.Box3(V(15, 0, -15), V(15.2, 3.2, 15)),
    new THREE.Box3(V(-15, 0, -15.2), V(15, 3.2, -15)),
    new THREE.Box3(V(-15, 0, 15), V(15, 3.2, 15.2)),
  ];
  const raycastMeshes = [];
  const mat = new THREE.MeshBasicMaterial();
  for (const b of colliders) {
    const s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), mat);
    m.position.copy(c); m.updateMatrixWorld(true);
    scene.add(m); raycastMeshes.push(m);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat);
  floor.rotation.x = -Math.PI / 2; floor.updateMatrixWorld(true);
  scene.add(floor); raycastMeshes.push(floor);
  const nodes = [V(-8, 0, -8), V(-8, 0, 5), V(-2, 0, 5), V(2, 0, 5), V(8, 0, 5), V(8, 0, -8), V(3, 0, -8), V(-3, 0, -2), V(11, 0, 0)];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [0, 7], [7, 2], [4, 8], [8, 5], [6, 3]];
  return {
    colliders, raycastMeshes,
    surfaceOf: () => 'concrete',
    groundHeight: () => 0,
    playerSpawn: { position: V(-10, 0, 0), yaw: 0 },
    enemySpawns: spawns,
    navGraph: { nodes, edges },
    coverPoints: [V(5.5, 0, -1.6), V(5.5, 0, -3.4), V(8.6, 0, 2.6), V(9.6, 0, 3.6), V(4.6, 0, -2.5)],
    extraction: new THREE.Box3(V(-14, 0, -14), V(-12, 3, -12)),
    bounds: new THREE.Box3(V(-15, 0, -15), V(15, 4, 15)),
    update() {},
  };
}

function makeCtx(spawns) {
  const scene = new THREE.Scene();
  const calls = { fire: 0, flash: 0, audio: {}, deaths: 0, pools: 0, playerHits: [] };
  const ctx = { scene };
  ctx.level = makeLevel(scene, spawns);
  ctx.game = { state: 'playing', onEnemyDeath() { calls.deaths++; }, onPlayerDeath() {} };
  ctx.audio = { play(name) { calls.audio[name] = (calls.audio[name] || 0) + 1; } };
  ctx.fx = {
    impact() {}, blood() {}, bloodPool() { calls.pools++; }, muzzleFlash() { calls.flash++; }, tracer() {}, shell() {}, update() {}, reset() {},
  };
  ctx.combat = createCombat(ctx);
  const realFire = ctx.combat.fire;
  ctx.combat.fire = (o) => { calls.fire++; return realFire(o); };
  ctx.player = {
    position: V(-10, 0, 0), velocity: V(0, 0, 0), height: 1.8, eye: V(-10, 1.68, 0), yaw: 0, pitch: 0,
    alive: true, health: 100, noise: 0, godMode: true, t: 0,
    takeDamage(a) {
      calls.playerHits.push(this.t);
      if (!this.godMode) { this.health -= a; if (this.health <= 0) this.alive = false; }
    },
  };
  return { ctx, calls };
}
function setPlayer(ctx, x, z, h = 1.8) {
  const p = ctx.player;
  p.position.set(x, 0, z); p.height = h; p.eye.set(x, h * 0.93, z);
}
function run(ctx, enemies, seconds, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (ctx.player) ctx.player.t += DT;
    enemies.update(DT);
    if (each && each(i * DT) === true) return i * DT;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
console.log('\n[nav]');
{
  const { ctx } = makeCtx([]);
  const nav = createNav(ctx.level, 0.3);
  check(!nav.clearWalk(V(-5, 0, 0), V(5, 0, 0)), 'wall blocks straight walk');
  check(nav.clearWalk(V(-5, 0, 5), V(5, 0, 5)), 'doorway is walkable');
  const path = nav.findPath(V(-5, 0, -5), V(5, 0, -5));
  check(Array.isArray(path) && path.length >= 2, `A* finds path around wall (${path?.length} pts)`);
  let ok = true, prev = V(-5, 0, -5);
  for (const p of path || []) { if (!nav.clearWalk(prev, p)) ok = false; prev = p; }
  check(ok, 'every smoothed segment is a clear walk');
  check(path && path.some((p) => p.z > 3.5 && p.z < 6.5 && Math.abs(p.x) < 3), 'path goes through the doorway');
  const p2 = nav.findPath(V(2, 0, 0), V(12, 0, 0));
  check(p2 && p2.length === 1, 'open-field path is a single straight segment');
  const pos = V(0.1, 0, 0); nav.resolveCircle(pos, 0.3);
  check(Math.abs(pos.x) >= 0.49, `resolveCircle pushes out of wall (x=${pos.x.toFixed(2)})`);
}

console.log('\n[spawn / idle]');
const spawns = [
  { position: V(10, 0, -6), yaw: 0, type: 'guard' },
  { position: V(6, 0, 8), yaw: Math.PI / 2, patrol: [V(6, 0, 8), V(12, 0, 8), V(12, 0, 12)], type: 'patrol' },
  { position: V(-8, 0, -10), yaw: Math.PI, type: 'guard' },
];
{
  const { ctx, calls } = makeCtx(spawns);
  setPlayer(ctx, -13, -14);
  const en = createEnemies(ctx);
  check(en.list.length === 3 && en.aliveCount === 3, 'three enemies spawned');
  check(en.list.every((e) => e.ch.root.parent === ctx.scene), 'characters added to scene');
  run(ctx, en, 6);
  check(en.list.every((e) => e.state === 'idle' || e.state === 'patrol'), 'unaware enemies stay idle/patrol: ' + en.list.map((e) => e.state).join(','));
  check(en.list[1].position.distanceTo(V(6, 0, 8)) > 0.5, 'patroller moved along its route');
  check(calls.fire === 0, 'no shots while unaware');
  // feet near ground, head at plausible height
  const e0 = en.list[0];
  const head = e0.ch.getHeadCenter(V(0, 0, 0));
  check(head.y > 1.5 && head.y < 1.85, `head height ${head.y.toFixed(2)} m`);
  const foot = new THREE.Vector3().setFromMatrixPosition(e0.ch.bones.footL.matrixWorld);
  check(Math.abs(foot.y - 0.085 * e0.ch.scale) < 0.04, `standing ankle height ${foot.y.toFixed(3)}`);

  console.log('\n[raycast]');
  const h = e0.hit;
  const shoot = (target) => {
    const o = target.clone().add(V(0, 0, -6));
    o.x -= 0.0;
    const d = target.clone().sub(o).normalize();
    return en.raycast(o, d, 50);
  };
  const r1 = shoot(h.head.c.clone());
  check(r1?.part === 'head' && r1.enemy === e0, 'ray at head -> head (' + r1?.part + ')');
  const tc = h.torso.a.clone().lerp(h.torso.b, 0.5);
  const r2 = shoot(tc);
  check(r2?.part === 'torso', 'ray at torso -> torso (' + r2?.part + ')');
  const thigh = h.limbs[4].a.clone().lerp(h.limbs[4].b, 0.6);
  const r3 = en.raycast(thigh.clone().add(V(4, 0, 0)), V(-1, 0, 0), 50);
  check(r3?.part === 'limb' || r3?.part === 'torso', 'ray at thigh from side -> ' + r3?.part);
  const r4 = en.raycast(V(10, 3.5, -12), V(0, 0, 1), 50);
  check(r4 === null, 'ray above heads misses');
  const r5 = en.raycast(h.head.c.clone().add(V(0, 0, -20)), V(0, 0, 1), 5);
  check(r5 === null, 'maxDist respected');
  check(r1 && Math.abs(r1.point.distanceTo(h.head.c) - h.head.r) < 0.02, 'hit point lies on head surface');

  console.log('\n[death / ragdoll / reset]');
  e0.takeDamage(50, 'head', V(0, 0, 1), r1.point);
  check(!e0.alive && en.aliveCount === 2 && calls.deaths === 1, 'head shot kills instantly, game notified');
  check(en.raycast(h.head.c.clone().add(V(0, 0, -6)), V(0, 0, 1), 50)?.enemy !== e0, 'dead enemy no longer hit by raycast');
  run(ctx, en, 7);
  check(e0.ragdoll.settled, 'ragdoll settled');
  check(calls.pools === 1, 'blood pool spawned once after settling');
  check((calls.audio.body_fall || 0) >= 1 && (calls.audio.death || 0) >= 1, 'death + body_fall sounds');
  let maxY = -1, minY = 9;
  for (let i = 0; i < e0.ragdoll.n; i++) { const y = e0.ragdoll.pos[i * 3 + 1]; maxY = Math.max(maxY, y); minY = Math.min(minY, y); }
  check(maxY < 0.55 && minY > -0.01, `body lies on the floor (particle y ${minY.toFixed(2)}..${maxY.toFixed(2)})`);
  const pelvisY = new THREE.Vector3().setFromMatrixPosition(e0.ch.bones.pelvis.matrixWorld).y;
  check(pelvisY < 0.4, `pelvis bone on floor (${pelvisY.toFixed(2)})`);
  const w = e0.ragdoll.weapon?.obj;
  check(!w || w.position.y < 0.15, 'dropped weapon on floor');
  // torso hits / limb hits
  const e1 = en.list[1];
  e1.takeDamage(50, 'limb', V(1, 0, 0), e1.hit.center.clone());
  check(e1.alive && e1.health === 75 && e1.state === 'combat' && e1.stagger > 0, 'limb hit: 25 dmg, staggered, combat');
  en.reset();
  check(en.list.length === 3 && en.aliveCount === 3 && en.list.every((e) => e.alive && e.ch.root.parent === ctx.scene), 'reset respawns everyone');
  check(ctx.scene.children.filter((c) => c.name === 'enemy').length === 3, 'old bodies removed from scene');
  check(!ctx.scene.children.some((c) => c.name?.startsWith('enemy_weapon')), 'dropped weapons removed');
}

console.log('\n[detection -> combat -> search]');
{
  const { ctx, calls } = makeCtx([{ position: V(10, 0, -6), yaw: Math.PI / 2, type: 'patrol' }]);  // looks toward -X
  setPlayer(ctx, -10, -6);   // behind the wall
  const en = createEnemies(ctx);
  const e = en.list[0];
  run(ctx, en, 1);
  check(e.state === 'idle', 'unseen behind wall');
  setPlayer(ctx, 1.5, -6);   // in the open, 8.5 m in front of it
  const tDetect = run(ctx, en, 5, () => e.state === 'combat');
  check(tDetect !== null && tDetect > 0.3 && tDetect < 2.0, `detected at 8.5 m after ${tDetect?.toFixed(2)} s`);
  run(ctx, en, 4);
  check(calls.fire > 0 && calls.flash > 0 && calls.audio.shot_enemy > 0, `fires (${calls.fire} shots, ${calls.playerHits.length} hits)`);
  check((calls.audio.shout || 0) >= 1, 'shouted on entering combat');
  setPlayer(ctx, -10, -6);   // back behind the wall
  const tSearch = run(ctx, en, 30, () => e.state === 'search');
  check(tSearch !== null, `lost sight -> search after ${tSearch?.toFixed(1)} s (tactic before: pusher/hold)`);
  const back = run(ctx, en, 40, () => e.state === 'idle' || e.state === 'patrol' || e.state === 'combat');
  check(back !== null, 'search ends (returned to routine or re-engaged): ' + e.state);
}

console.log('\n[sneak: crouched far player detected slowly]');
{
  const { ctx } = makeCtx([{ position: V(12, 0, -12), yaw: Math.PI * 0.75, type: 'guard' }]);
  setPlayer(ctx, -10, 10, 1.2);
  const en = createEnemies(ctx);
  setPlayer(ctx, -12 + 25, -12 + 22, 1.2);
  const e = en.list[0];
  // place crouched player 20 m away in the cone
  const dir = new THREE.Vector3(Math.sin(e.aimYaw), 0, Math.cos(e.aimYaw));
  const pp = e.position.clone().addScaledVector(dir, 20);
  setPlayer(ctx, pp.x, pp.z, 1.2);
  const t = run(ctx, en, 10, () => e.state === 'combat');
  const tSus = e.state;
  check(t === null || t > 2.0, `crouched at 20 m: combat after ${t?.toFixed(2) ?? '>10'} s (state ${tSus})`);
}

console.log('\n[accuracy: standing in the open at 10 m, alerted enemy]');
function firstHitTrial(opts) {
  const { ctx, calls } = makeCtx([{ position: V(11, 0, -6), yaw: Math.PI / 2, type: 'guard' }]);
  setPlayer(ctx, -10, -6);
  const en = createEnemies(ctx);
  const e = en.list[0];
  ctx.level.coverPoints = [];   // keep it in the open for the measurement
  run(ctx, en, 0.3);
  setPlayer(ctx, 1, -6);        // 10 m
  ctx.player.t = 0; calls.playerHits.length = 0;
  if (opts.alerted) enterCombatNow(en, e);
  if (opts.peek) {
    run(ctx, en, opts.peek);
    setPlayer(ctx, -10, -6);
    run(ctx, en, 1.0);
    return calls.playerHits.length;
  }
  const t = run(ctx, en, 8, () => calls.playerHits.length > 0);
  return t ?? 8;
}
function enterCombatNow(en, e) {
  e.meter = 0.99;   // next sight tick completes detection -> includes reaction delay
}
{
  const N = 60, times = [];
  for (let i = 0; i < N; i++) times.push(firstHitTrial({ alerted: true }));
  times.sort((a, b) => a - b);
  const med = times[N >> 1], p20 = times[Math.floor(N * 0.2)], p80 = times[Math.floor(N * 0.8)];
  console.log(`  first hit (s): p20 ${p20.toFixed(2)}  median ${med.toFixed(2)}  p80 ${p80.toFixed(2)}  min ${times[0].toFixed(2)}`);
  check(med >= 1.3 && med <= 2.7, 'median first hit within ~1.5-2.5 s');
  check(times[0] > 0.35, 'never hit before the reaction delay');

  const peeks = [];
  for (let i = 0; i < N; i++) peeks.push(firstHitTrialPeek());
  const survive = peeks.filter((h) => h < 2).length / N, unhurt = peeks.filter((h) => h === 0).length / N;
  console.log(`  0.8 s peek vs. combat-ready enemy: survived ${(survive * 100).toFixed(0)} %, unhurt ${(unhurt * 100).toFixed(0)} %`);
  check(survive >= 0.8, 'a brief peek is usually survived');
  for (const d of [5, 10, 20, 30]) {
    console.log(`  aim error radius at ${d} m: first ${aimError(d, 0).toFixed(2)} m, settled ${aimError(d, 9).toFixed(2)} m`);
  }
}
function firstHitTrialPeek() {
  const { ctx, calls } = makeCtx([{ position: V(11, 0, -6), yaw: Math.PI / 2, type: 'guard' }]);
  ctx.level.coverPoints = [];
  setPlayer(ctx, 1, -6);
  const en = createEnemies(ctx);
  const e = en.list[0];
  run(ctx, en, 6, () => e.state === 'combat');     // gets alerted
  setPlayer(ctx, -10, -6);                           // hide
  run(ctx, en, 2.5);
  calls.playerHits.length = 0;
  setPlayer(ctx, 1, -6);                             // peek 0.8 s
  run(ctx, en, 0.8);
  setPlayer(ctx, -10, -6);
  run(ctx, en, 0.4);
  return calls.playerHits.length;
}

console.log('\n[squad: alerting, cover, no mass rush]');
{
  const sq = [
    { position: V(10, 0, -6), yaw: Math.PI / 2, type: 'patrol' },
    { position: V(11, 0, -2), yaw: Math.PI / 2, type: 'patrol' },
    { position: V(12, 0, 6), yaw: Math.PI / 2, type: 'guard' },
    { position: V(-8, 0, 10), yaw: 0, type: 'guard' },     // other side of the wall, far
  ];
  const { ctx, calls } = makeCtx(sq);
  setPlayer(ctx, -10, -6);
  const en = createEnemies(ctx);
  run(ctx, en, 0.5);
  setPlayer(ctx, 1.5, -6);
  run(ctx, en, 4);
  const states = en.list.map((e) => e.state);
  check(states[0] === 'combat' && states[1] === 'combat', 'spotter and nearby ally in combat: ' + states.join(','));
  check(en.list.some((e) => e.cover), 'someone took cover: ' + en.list.map((e) => e.tactic).join(','));
  setPlayer(ctx, -10, -6);
  let maxPush = 0;
  run(ctx, en, 12, () => { maxPush = Math.max(maxPush, en._world.pushers.size); });
  check(maxPush <= 1, `at most one pusher at a time (${maxPush})`);
  check(calls.fire > 0, 'squad fired');
}

console.log('\n[hearing]');
{
  const { ctx } = makeCtx([
    { position: V(10, 0, -6), yaw: 0, type: 'guard' },     // faces -Z, player not in view
    { position: V(-8, 0, -10), yaw: Math.PI, type: 'guard' },
  ]);
  setPlayer(ctx, 12, 12);
  ctx.player.alive = false;   // invisible for the noise-only part
  const en = createEnemies(ctx);
  run(ctx, en, 0.5);
  en.alertNoise(V(7, 1, -6), 6);           // small noise near enemy 0
  run(ctx, en, 0.2);
  check(en.list[0].state === 'suspicious', 'small noise -> suspicious: ' + en.list[0].state);
  let far = 0;
  run(ctx, en, 8, () => { far = Math.max(far, en.list[0].position.distanceTo(V(10, 0, -6))); });
  check(far > 1, 'walked to investigate (' + far.toFixed(1) + ' m)');
  const before1 = en.list[1].state;
  en.alertNoise(V(5, 1.6, -8), 40);        // gunshot
  run(ctx, en, 0.2);
  check(en.list[0].state === 'combat', 'gunshot in the same room -> combat/alert: ' + en.list[0].state);
  check(en.list[1].state === 'suspicious' || en.list[1].state === 'idle', 'gunshot behind a wall, far -> investigate or unheard: ' + before1 + ' -> ' + en.list[1].state);
  ctx.player.alive = true; ctx.player.noise = 1; setPlayer(ctx, -5, -12);   // sprinting behind enemy 1 (it faces +Z)
  run(ctx, en, 0.5);
  check(en.list[1].state !== 'idle', 'sprint footsteps heard: ' + en.list[1].state);
}

console.log('\n[perf: 10 enemies]');
{
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ position: V(3 + (i % 5) * 2.2, 0, -10 + Math.floor(i / 5) * 12), yaw: Math.PI / 2, type: i % 3 ? 'patrol' : 'guard', patrol: i % 3 ? [V(3 + (i % 5) * 2.2, 0, -10 + Math.floor(i / 5) * 12), V(12, 0, 0)] : undefined });
  const { ctx } = makeCtx(many);
  setPlayer(ctx, 1.5, 0);
  const en = createEnemies(ctx);
  const t0 = performance.now();
  run(ctx, en, 10);
  const ms = (performance.now() - t0) / 600;
  console.log(`  avg update: ${ms.toFixed(3)} ms/frame; states: ${en.list.map((e) => e.state[0]).join('')}`);
  check(ms < 4, 'update cost acceptable in Node');
  let nan = false;
  for (const e of en.list) if (!Number.isFinite(e.position.x + e.position.z + e.aimYaw)) nan = true;
  check(!nan, 'no NaN positions/angles');
  // all enemies die
  for (const e of en.list) if (e.alive) e.takeDamage(200, 'torso', V(1, 0, 0), e.hit.center);
  run(ctx, en, 7);
  check(en.aliveCount === 0 && en.list.every((e) => e.ragdoll?.settled), 'everyone dead and settled');
}

console.log('\n[robustness]');
{
  const { ctx } = makeCtx(spawns);
  const en = createEnemies(ctx);
  const saved = ctx.player;
  ctx.player = undefined;
  let threw = false;
  try { run(ctx, en, 1); en.alertNoise(V(0, 1, 0), 30); en.raycast(V(0, 1, 0), V(1, 0, 0), 10); } catch (err) { threw = err; }
  check(!threw, 'tolerates missing ctx.player ' + (threw ? threw.stack : ''));
  ctx.player = saved;
  const saveFx = ctx.fx, saveAudio = ctx.audio;
  ctx.fx = undefined; ctx.audio = undefined; threw = false;
  try { setPlayer(ctx, 1.5, -6); run(ctx, en, 5); en.list[0].takeDamage(100, 'head', V(0, 0, 1)); run(ctx, en, 1); } catch (err) { threw = err; }
  check(!threw, 'tolerates missing fx/audio ' + (threw ? threw.stack : ''));
  ctx.fx = saveFx; ctx.audio = saveAudio;
  // empty level
  threw = false;
  try { const c2 = { scene: new THREE.Scene() }; const e2 = createEnemies(c2); e2.update(DT); e2.reset(); e2.raycast(V(0, 0, 0), V(0, 0, 1), 5); } catch (err) { threw = err; }
  check(!threw, 'tolerates missing level ' + (threw ? threw.stack : ''));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exitCode = failures ? 1 : 0;
void TUNING;
