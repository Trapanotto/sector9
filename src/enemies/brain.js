// Enemy AI: perception, state machine, squad shouts, cover, flanking, firing model, damage and deaths.
// PURE (no three.js, no DOM, no Math.random): runs in the browser through an env adapter (enemies.js) and
// headless in Node (scripts/test-d-enemies.mjs through simenv.js) with a seeded RNG → deterministic.
// Hot path is allocation-free: scratch objects, typed arrays, string constants. Owner: D.
//
// States: idle (unaware: activity/patrol/sleep) · hidden (ambusher waiting for its trigger) · ambush (armed
// ambusher: waits silently, fires when the player passes) · suspicious · alert (knows a threat, no contact) ·
// combat (contact, or lost < 2 s) · search · surrender · flee · dead
//
// env (see simenv.js / enemies.js): { nav, collision, cover, los(a,b), fire(e, o, d, range, dmg) → res,
//   emit(name, payload), player { pos, eye, forward, crouched, moving, dead, flashlight, ref }, lightAt(x,y,z),
//   maskAt(x,y,z), doorOpen(i) → 0..1, doorState(i), openDoor(i), fallClear(x,y,z,dx,dz,len) }
import { createRng } from './rng.js';
import { findCover, coverScratch } from './cover.js';

export const WEAPONS = {
  pistol: { dmg: 26, range: 55, rof: [0.34, 0.6], burst: [2, 4], mag: 15, reload: 1.7, acc: 0.55, pellets: 1, spread: 0, anim: 'pistol', model: 'pistol' },
  smg: { dmg: 15, range: 40, rof: [0.085, 0.11], burst: [3, 7], mag: 30, reload: 2.2, acc: 0.34, pellets: 1, spread: 0, anim: 'smg', model: 'smg' },
  shotgun: { dmg: 11, range: 26, rof: [0.95, 1.25], burst: [1, 2], mag: 6, reload: 2.2, acc: 0.7, pellets: 7, spread: 0.04, anim: 'shotgun', model: 'shotgun' },
  // no rifle model in the CC0 set: a long gun with the shotgun's visuals and stances, rifle ballistics
  rifle: { dmg: 34, range: 85, rof: [0.5, 0.8], burst: [1, 3], mag: 20, reload: 2.2, acc: 0.66, pellets: 1, spread: 0, anim: 'shotgun', model: 'shotgun' },
};

// damage multiplier per hit capsule (player pistol 34 dmg vs HEALTH 65: head 1, torso 2, limbs 3–4 hits)
export const HEALTH = 65;
export const PART_MUL = { head: 3, neck: 2, chest: 1.15, stomach: 1, pelvis: 0.9, upperarm_l: 0.6, upperarm_r: 0.6, lowerarm_l: 0.5, lowerarm_r: 0.5, hand_l: 0.4, hand_r: 0.4, thigh_l: 0.7, thigh_r: 0.7, calf_l: 0.55, calf_r: 0.55, foot_l: 0.45, foot_r: 0.45 };
export const PART_GROUP = { head: 'head', neck: 'torso', chest: 'torso', stomach: 'torso', pelvis: 'torso', upperarm_l: 'arms', upperarm_r: 'arms', lowerarm_l: 'arms', lowerarm_r: 'arms', hand_l: 'arms', hand_r: 'arms', thigh_l: 'legs', thigh_r: 'legs', calf_l: 'legs', calf_r: 'legs', foot_l: 'legs', foot_r: 'legs' };

// activities: clip cycle, pose, weapon drawn while doing it
export const ACTIVITIES = {
  guard: { clips: ['@idle', '@idle', 'look_around'], pose: 'stand', weapon: true },
  patrol: { clips: ['@idle', 'look_around'], pose: 'stand', weapon: true },
  pack: { clips: ['interact', 'pickup', 'interact', 'idle'], pose: 'stand', weapon: false },
  lab: { clips: ['interact', 'idle', 'interact', 'pickup'], pose: 'stand', weapon: false },
  console: { clips: ['interact', 'idle_arms_folded', 'interact'], pose: 'stand', weapon: false },
  cash: { clips: ['interact', 'idle_talk', 'interact', 'pickup'], pose: 'stand', weapon: false },
  sit: { clips: ['sit_idle', 'sit_talk'], pose: 'sit', weapon: false },
  sleep: { clips: ['sleep_lying'], pose: 'lie', weapon: false },
  smoke: { clips: ['idle_phone', 'idle', 'idle_phone'], pose: 'stand', weapon: false },
  phone: { clips: ['idle_phone', 'idle_talk'], pose: 'stand', weapon: false },
  talk: { clips: ['idle_talk', 'idle', 'idle_talk'], pose: 'stand', weapon: false },
  tv: { clips: ['idle_arms_folded', 'idle', 'idle_arms_folded'], pose: 'stand', weapon: false },
  lean: { clips: ['lean_wall'], pose: 'stand', weapon: false },
  fix: { clips: ['kneel_fix'], pose: 'stand', weapon: false },
  hide: { clips: ['@crouch'], pose: 'crouch', weapon: true },
};

const ROLE_DEFAULT_ACT = { guard: 'guard', patrol: 'patrol', sleeper: 'sleep', ambusher: 'hide' };
const ST = ['idle', 'hidden', 'ambush', 'suspicious', 'alert', 'combat', 'search', 'surrender', 'flee', 'dead'];

const PERCEIVE_EVERY = 4;   // frames (staggered by index)
const THINK_EVERY = 8;
const PATHS_PER_FRAME = 2;
const MAX_PATH = 320;
// body radius below the nav clearance (NAV_RADIUS 0.22) so every nav node is reachable by the collider
const MOVE_OPTS = { radius: 0.2, height: 1.7, step: 0.45 };

export function createBrain(env, defs, opts = {}) {
  const rng = createRng(opts.seed ?? 9);
  const nav = env.nav, C = env.cover;
  const list = [];
  const tmpPath = new Int32Array(4096);
  const cs = coverScratch();
  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 }, D = { x: 0, y: 0, z: 0 }, O = { x: 0, y: 0, z: 0 };
  const mv = { x: 0, y: 0, z: 0 };
  // event payloads (reused: listeners must copy what they keep — CONTRACT §7)
  const evE = { id: '', enemy: null, amount: 0, part: '' };
  const evFire = { id: '', enemy: null, origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 }, weapon: '' };
  const evVoice = { id: '', enemy: null, kind: '', pos: { x: 0, y: 0, z: 0 }, zone: -1 };
  const evMiss = { id: '', enemy: null, point: { x: 0, y: 0, z: 0 }, dist: 0 };
  const evState = { id: '', enemy: null, from: '', to: '' };
  const evStep = { id: '', enemy: null, pos: { x: 0, y: 0, z: 0 }, run: false };
  const noises = [];         // ring of recent noises { x,y,z, r, kind, t, seq, src }
  for (let i = 0; i < 16; i++) noises.push({ x: 0, y: 0, z: 0, r: 0, kind: '', t: -99, seq: 0, src: null });
  let noiseSeq = 0, noiseHead = 0;
  let now = 0, frame = 0, pathsThisFrame = 0;
  const stats = { pathMsMax: 0, thinkMsMax: 0, perceiveMsMax: 0, shots: 0, hits: 0, nearMisses: 0, kills: 0, surrendered: 0, executed: 0, fled: 0, shotsBlockedFF: 0, unsafeShots: 0, stuckMax: 0, stuckId: '' };
  const lastShout = { alert: -99, command: -99, taunt: -99 };

  defs.forEach((def, i) => {
    const w = WEAPONS[def.weapon] ?? WEAPONS.pistol;
    const e = {
      id: def.id, def, index: i, kind: 'enemy', team: 'gang', w,
      pos: opts.vec3 ? opts.vec3() : { x: 0, y: 0, z: 0 }, yaw: 0, health: HEALTH, dead: false, alerted: false, lod: 0, active: true,
      state: 'idle', stateT: 0, act: def.act ?? ROLE_DEFAULT_ACT[def.role] ?? 'guard',
      // perception
      aware: 0, canSee: false, seenT: -99, firstSeenT: -99, lastKnown: { x: 0, y: 0, z: 0 }, interest: { x: 0, y: 0, z: 0 },
      noiseSeen: 0, losFlip: 0, heardT: -99,
      // motion
      path: new Int32Array(MAX_PATH), pathLen: 0, pathI: 0, carrot: 0, goalNode: -1, goal: { x: 0, y: 0, z: 0 },
      wantMove: false, speedWant: 0, speed: 0, run: false, crouch: false, faceYaw: 0, moveYaw: 0, cstate: { grounded: true, vy: 0, hitWall: false, groundY: 0 },
      stuckT: 0, lastProg: { x: 0, y: 0, z: 0 }, progT: 0, repaths: 0, pathPending: false, waitDoor: -1, stepDist: 0,
      // combat
      ammo: w.mag, burstLeft: 0, fireCd: 0, reactAt: -1, reloadUntil: -1, shotsThisContact: 0, onTargetT: 0,
      coverIdx: -1, coverSide: 1, peekUntil: 0, hideUntil: 0, peeking: false, flankAt: -1, isFlanker: false,
      ffBlockT: -99, strafeUntil: -1,
      // presentation (read by the animation layer)
      pose: 'stand', clip: 'idle', clipT: 0, actI: 0, weaponOut: false, aiming: false, aimYaw: 0, aimPitch: 0, lookYaw: 0,
      lean: 0, oneShot: '', oneShotSeq: 0, busyUntil: 0, fireSeq: 0, hitSeq: 0, hitDirX: 0, hitDirZ: 0, hitAmt: 0,
      deathClip: '', deathT: -1, writheUntil: -1, bodyYaw: 0, armed: true, weaponDropped: false, limp: false,
      startleUntil: -1, moveSign: 1,
      // hit capsules in actor-local space (x right = +x, forward = -z after yaw); animation layer overwrites
      caps: new Float32Array(17 * 7), capN: 0, capNames: null,
      // director
      hold: false, scripted: null,
      surrendered: false, executed: false, fled: false,
    };
    list.push(e);
  });

  const api = {
    list, stats, rng,
    get now() { return now; },
    reset, update, alert, ambush, wake, spawn, setHold, moveTo, say, trigger, noise, raycast, applyHit,
    /** for tests: enemy by id */
    get(id) { return list.find((e) => e.id === id); },
  };

  // ----------------------------------------------------------------------------------------------------
  function reset(seed) {
    if (seed !== undefined) rng.seed(seed); else rng.seed(opts.seed ?? 9);
    now = 0; frame = 0; noiseSeq = 0;
    for (const n of noises) { n.t = -99; n.seq = 0; }
    lastShout.alert = lastShout.command = lastShout.taunt = -99;
    for (const k in stats) stats[k] = typeof stats[k] === 'string' ? '' : 0;
    if (C) C.owner.fill(-1);
    for (const e of list) {
      const d = e.def;
      e.pos.x = d.pos[0]; e.pos.y = d.pos[1]; e.pos.z = d.pos[2];
      e.yaw = e.faceYaw = e.bodyYaw = e.aimYaw = e.lookYaw = d.yaw;
      e.health = HEALTH; e.dead = false; e.alerted = false; e.active = !d.dormant;
      e.act = d.act ?? ROLE_DEFAULT_ACT[d.role] ?? 'guard';
      e.aware = 0; e.canSee = false; e.seenT = e.firstSeenT = e.heardT = -99; e.noiseSeen = 0;
      e.pathLen = e.pathI = 0; e.goalNode = -1; e.wantMove = false; e.speed = 0; e.run = false; e.crouch = false;
      e.stuckT = 0; e.progT = 0; e.repaths = 0; e.pathPending = false; e.waitDoor = -1; e.stepDist = 0;
      e.ammo = e.w.mag; e.burstLeft = 0; e.fireCd = 0; e.reactAt = -1; e.reloadUntil = -1; e.shotsThisContact = 0; e.onTargetT = 0;
      e.coverIdx = -1; e.peekUntil = e.hideUntil = 0; e.peeking = false; e.flankAt = -1; e.isFlanker = false; e.ffBlockT = -99; e.strafeUntil = -1;
      e.lean = 0; e.oneShot = ''; e.busyUntil = 0; e.deathClip = ''; e.deathT = -1; e.writheUntil = -1;
      e.armed = true; e.weaponDropped = false; e.limp = false; e.startleUntil = -1; e.hold = false; e.scripted = null;
      e.surrendered = e.executed = e.fled = false; e.wp = 0; e.wpWait = 0; e.actI = 0; e.clipT = 0; e.moveSign = 1;
      e.cstate.grounded = true;
      // anchored activities (sit / lie): the visual root sits on the seat / bed
      const anchor = d.seat ?? d.bed;
      if (anchor && (e.act === 'sleep' || e.act === 'sit')) {
        e.pos.x = anchor[0]; e.pos.y = anchor[1]; e.pos.z = anchor[2]; e.yaw = e.faceYaw = e.bodyYaw = anchor[3] ?? d.yaw;
      }
      e.stateT = 0;
      setState(e, d.role === 'ambusher' ? (d.trigger ? 'hidden' : 'ambush') : 'idle');
      applyActivity(e, 0);
      if (e.act === 'hide') e.crouch = true;
      fillProxyCaps(e);
    }
  }

  function setState(e, s) {
    if (e.state === s) return;
    evState.id = e.id; evState.enemy = e; evState.from = e.state; evState.to = s;
    e.state = s; e.stateT = now;
    if (s !== 'combat' && s !== 'alert' && e.coverIdx >= 0) { if (C) C.owner[e.coverIdx] = -1; e.coverIdx = -1; }
    env.emit('d:state', evState);
  }

  function applyActivity(e, k) {
    const a = ACTIVITIES[e.act] ?? ACTIVITIES.guard;
    e.actI = k % a.clips.length;
    const c = a.clips[e.actI];
    e.clip = c === '@idle' ? 'w_idle' : c === '@crouch' ? 'crouch_idle' : c;
    e.clipT = now + rng.range(5, 10);
    e.pose = a.pose;
    e.weaponOut = a.weapon && e.armed;
    e.aiming = false;
  }

  // ----------------------------------------------------------------------------------------------------
  // noises (player shots, glass, doors, footsteps are sampled per perception tick)
  function noise(x, y, z, r, kind, src = null) {
    const n = noises[noiseHead]; noiseHead = (noiseHead + 1) % noises.length;
    n.x = x; n.y = y; n.z = z; n.r = r; n.kind = kind; n.t = now; n.seq = ++noiseSeq; n.src = src;
  }

  function voice(e, kind) {
    evVoice.id = e.id; evVoice.enemy = e; evVoice.kind = kind;
    evVoice.pos.x = e.pos.x; evVoice.pos.y = e.pos.y + (e.pose === 'lie' || e.dead ? 0.3 : e.crouch ? 1.1 : 1.6); evVoice.pos.z = e.pos.z;
    env.emit('d:voice', evVoice);
  }

  /** squad communication: a shout alerts allies in earshot (fewer through walls / floors) */
  function shoutAlert(e, kind) {
    voice(e, kind);
    const P = env.player;
    for (const o of list) {
      if (o === e || o.dead || !o.active || o.state === 'surrender' || o.state === 'flee') continue;
      const dy = Math.abs(o.pos.y - e.pos.y), d = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) + dy * 3;
      let r = 26;
      A.x = e.pos.x; A.y = e.pos.y + 1.6; A.z = e.pos.z; B.x = o.pos.x; B.y = o.pos.y + 1.6; B.z = o.pos.z;
      if (d > r) continue;
      if (d > 12 && !env.los(A, B)) r *= 0.6;
      if (d > r) continue;
      // they learn roughly where the threat is
      if (o.state === 'combat') continue;
      o.lastKnown.x = P.pos.x + rng.gauss() * 2; o.lastKnown.y = P.pos.y; o.lastKnown.z = P.pos.z + rng.gauss() * 2;
      becomeAlert(o, rng.range(0.3, 0.9));
    }
  }

  function becomeAlert(e, delay = 0) {
    if (e.dead || e.state === 'surrender' || e.state === 'flee') return;
    if (e.state === 'combat' || e.state === 'alert' || e.state === 'search') { e.heardT = now; return; }
    wakeUp(e, delay);
    if (!e.alerted) { e.alerted = true; evE.id = e.id; evE.enemy = e; evE.amount = 0; evE.part = ''; env.emit('enemy:alert', evE); }
    setState(e, 'alert');
    e.heardT = now;
  }

  /** get up from sleep / seat; draw the weapon */
  function wakeUp(e, delay = 0) {
    if (e.pose === 'lie' && !e.dead) { oneShot(e, 'lying_to_idle'); e.yaw = e.bodyYaw = e.faceYaw = e.lookYaw = wrap(e.yaw + Math.PI); e.busyUntil = now + 1.6 + delay + rng.range(0.2, 0.8); }
    else if (e.pose === 'sit') { oneShot(e, 'sit_exit'); e.busyUntil = now + 1.05 + delay; }
    else if (!e.weaponOut) e.busyUntil = Math.max(e.busyUntil, now + 0.45 + delay);   // draw
    else e.busyUntil = Math.max(e.busyUntil, now + delay);
    e.pose = 'stand'; e.weaponOut = e.armed; e.clip = 'w_idle';
  }

  function oneShot(e, clip) { e.oneShot = clip; e.oneShotSeq++; }

  // ----------------------------------------------------------------------------------------------------
  // perception
  function perceive(e, dt) {
    const P = env.player;
    if (P.dead) { e.canSee = false; return; }
    const sleeping = e.pose === 'lie' && e.state === 'idle';
    const hidden = e.state === 'hidden';
    // ---- hearing
    for (let k = 0; k < noises.length; k++) {
      const n = noises[k];
      if (n.seq <= e.noiseSeen || n.src === e) continue;
      const dy = Math.abs(n.y - e.pos.y);
      let r = n.r * (dy > 2.5 ? 0.5 : 1);
      if (sleeping) r *= 0.45;
      const d = Math.hypot(n.x - e.pos.x, n.z - e.pos.z) + dy;
      if (d > r) continue;
      A.x = e.pos.x; A.y = e.pos.y + 1.6; A.z = e.pos.z; B.x = n.x; B.y = n.y + 0.5; B.z = n.z;
      if (d > r * 0.5 && !env.los(A, B)) continue;   // occluded: only the nearer half of the radius carries
      onHeard(e, n, d / r);
    }
    e.noiseSeen = noiseSeq;
    // footsteps (continuous, masked by machines)
    if (P.moving > 0.6 && !sleeping) {
      let r = P.crouched ? 1.6 : P.moving > 3.5 ? 11 : P.moving > 1.6 ? 5.5 : 2.5;
      r *= 1 - 0.75 * env.maskAt(e.pos.x, e.pos.y, e.pos.z);
      const d = Math.hypot(P.pos.x - e.pos.x, P.pos.z - e.pos.z) + Math.abs(P.pos.y - e.pos.y) * 2;
      if (d < r) onHeardPlayer(e, d / r);
    }
    // ---- vision
    e.canSee = false;
    if (sleeping || e.pose === 'sit' && e.busyUntil > now) return;
    const ex = e.pos.x, ey = e.pos.y + (e.crouch ? 1.05 : e.pose === 'sit' ? 1.15 : 1.62), ez = e.pos.z;
    const dx = P.eye.x - ex, dy = P.eye.y - ey, dz = P.eye.z - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 55) { decay(e, dt); return; }
    const fy = e.lookYaw;
    const cosA = (-Math.sin(fy) * dx - Math.cos(fy) * dz) / Math.max(Math.hypot(dx, dz), 1e-3);
    const engaged = e.state === 'combat' || e.state === 'alert' || e.state === 'search' || e.state === 'ambush';
    const fovCos = engaged ? -0.1 : 0.42;
    let periph = 1;
    if (cosA < fovCos) {
      if (!(dist < 7 && cosA > -0.35)) { decay(e, dt); return; }
      periph = 2.8;
    }
    if (hidden && dist > 6) { decay(e, dt); return; }
    // line of sight: alternate head / chest rays; keep the result when one of them sees
    A.x = ex; A.y = ey; A.z = ez;
    B.x = P.eye.x; B.y = P.eye.y - 0.05; B.z = P.eye.z;
    let vis = env.los(A, B);
    if (!vis) { B.x = P.pos.x; B.y = P.pos.y + (P.crouched ? 0.6 : 1.0); B.z = P.pos.z; vis = env.los(A, B); }
    if (!vis) { decay(e, dt); return; }
    // detection time: distance, light, posture, state
    let light = env.lightAt(P.pos.x, P.pos.y + 1, P.pos.z);
    if (P.flashlight) {
      const f = -(P.forward.x * dx + P.forward.z * dz) / Math.max(Math.hypot(dx, dz), 1e-3);
      light = Math.max(light, f > 0.5 ? 1 : 0.6);
    }
    light = Math.max(0.18, Math.min(1, light));
    let tDet = (0.2 + dist * 0.055) / light * periph;
    tDet *= P.crouched ? 1.5 : 1;
    tDet *= P.moving > 3.5 ? 0.7 : P.moving < 0.3 ? 1.25 : 1;
    tDet *= e.state === 'combat' ? 0.15 : e.state === 'idle' ? 1.5 : e.state === 'suspicious' ? 1.0 : 0.55;
    e.aware += dt / tDet;
    if (e.aware >= 1) {
      e.aware = 1.2; e.canSee = true;
      if (e.seenT < now - 2.5) e.firstSeenT = now;
      e.seenT = now;
      e.lastKnown.x = P.pos.x; e.lastKnown.y = P.pos.y; e.lastKnown.z = P.pos.z;
      onSeen(e, dist);
    } else if (e.aware > 0.3 && (e.state === 'idle' || e.state === 'hidden')) {
      e.interest.x = P.pos.x; e.interest.y = P.pos.y; e.interest.z = P.pos.z;
      becomeSuspicious(e);
    }
  }
  function decay(e, dt) { if (e.state === 'idle' || e.state === 'suspicious') e.aware = Math.max(0, e.aware - dt * 0.08); }

  function onHeard(e, n, rel) {
    const loud = n.kind === 'shot' || n.kind === 'glass' || n.kind === 'scream';
    e.interest.x = n.x; e.interest.y = n.y; e.interest.z = n.z;
    if (loud && (rel < 0.75 || e.state !== 'idle')) {
      e.lastKnown.x = n.x + rng.gauss() * 1.5; e.lastKnown.y = n.y; e.lastKnown.z = n.z + rng.gauss() * 1.5;
      if (e.state === 'hidden') { if (rel < 0.5) armAmbush(e); return; }
      if (e.state === 'ambush') return;     // stay put, wait for the target
      becomeAlert(e, rng.range(0.15, 0.5));
    } else if (e.state === 'idle' || e.state === 'hidden') becomeSuspicious(e);
  }
  function onHeardPlayer(e, rel) {
    const P = env.player;
    e.interest.x = P.pos.x; e.interest.y = P.pos.y; e.interest.z = P.pos.z;
    if (e.state === 'idle') becomeSuspicious(e);
    else if (e.state === 'suspicious' && rel < 0.4) { e.lastKnown.x = P.pos.x; e.lastKnown.y = P.pos.y; e.lastKnown.z = P.pos.z; becomeAlert(e, 0.2); }
    else if (e.state === 'alert' || e.state === 'search') { e.lastKnown.x = P.pos.x; e.lastKnown.y = P.pos.y; e.lastKnown.z = P.pos.z; e.heardT = now; }
    else if (e.state === 'hidden' && rel < 0.6) armAmbush(e);
  }
  function becomeSuspicious(e) {
    if (e.state !== 'idle' && e.state !== 'hidden') return;
    if (e.state === 'hidden') { armAmbush(e); return; }
    setState(e, 'suspicious');
    e.wantMove = false; e.pathLen = 0;
    const dx = e.interest.x - e.pos.x, dz = e.interest.z - e.pos.z;
    const want = Math.atan2(-dx, -dz), off = Math.abs(wrap(want - e.bodyYaw));
    if (e.pose === 'stand' && off > 2.2 && e.weaponOut === false && rng.chance(0.6)) {
      // startled 180° turn (the clip ends rotated by π; the body yaw flips when it finishes)
      oneShot(e, 'startled_turn'); e.startleUntil = now + 0.9; e.busyUntil = now + 0.95;
    } else if (e.pose !== 'stand') wakeUp(e, 0.3);
    if (rng.chance(0.5)) voice(e, 'surprise');
  }
  function onSeen(e, dist) {
    if (e.state === 'combat') return;
    if (e.state === 'surrender' || e.state === 'flee') return;
    if (e.state === 'hidden') { armAmbush(e); return; }
    if (e.state === 'ambush') return;   // the ambush logic decides when to open fire
    enterCombat(e, dist);
  }
  function enterCombat(e, dist) {
    const wasUnaware = e.state === 'idle' || e.state === 'suspicious';
    if (wasUnaware) wakeUp(e, 0);
    if (!e.alerted) { e.alerted = true; evE.id = e.id; evE.enemy = e; evE.amount = 0; evE.part = ''; env.emit('enemy:alert', evE); }
    setState(e, 'combat');
    // reaction time: startled unaware enemies are slower; the very first shot is often rushed (see fire())
    const react = (wasUnaware ? rng.range(0.55, 1.0) : rng.range(0.3, 0.6)) + dist * 0.008;
    e.reactAt = Math.max(e.busyUntil, now + react);
    e.shotsThisContact = 0; e.onTargetT = 0;
    if (now - lastShout.alert > 2.5) { lastShout.alert = now; shoutAlert(e, 'alert'); }
  }
  function armAmbush(e) {
    if (e.state !== 'hidden') return;
    setState(e, 'ambush');
    e.weaponOut = e.armed; e.aware = Math.max(e.aware, 0.5);
  }

  // ----------------------------------------------------------------------------------------------------
  // think (decisions, staggered)
  function think(e) {
    const P = env.player;
    if (e.hold || e.busyUntil > now) return;
    if (e.scripted) { thinkScripted(e); return; }
    switch (e.state) {
      case 'idle': thinkIdle(e); break;
      case 'hidden': break;
      case 'ambush': thinkAmbush(e, P); break;
      case 'suspicious': thinkSuspicious(e); break;
      case 'alert': thinkAlert(e, P); break;
      case 'combat': thinkCombat(e, P); break;
      case 'search': thinkSearch(e); break;
      case 'flee': thinkFlee(e, P); break;
      case 'surrender': thinkSurrender(e, P); break;
      default: break;
    }
  }

  function thinkScripted(e) {
    const s = e.scripted;
    if (!e.wantMove && e.goalNode < 0) { goTo(e, s.x, s.y, s.z, s.run ? 3.4 : 1.4); }
    if (arrived(e)) { e.scripted = null; e.wantMove = false; }
  }

  function thinkIdle(e) {
    const d = e.def;
    if (now > e.clipT && !e.wantMove) applyActivity(e, e.actI + 1);
    if (d.role === 'patrol' && d.patrol?.length) {
      e.pose = 'stand'; e.weaponOut = e.armed;
      if (e.wantMove) { if (arrived(e)) { e.wantMove = false; e.wpWait = now + rng.range(1.5, 4); e.clip = rng.chance(0.5) ? 'look_around' : 'w_idle'; } return; }
      if (now < e.wpWait) return;
      e.wp = (e.wp + 1) % d.patrol.length;
      const w = d.patrol[e.wp];
      goTo(e, w[0], d.pos[1], w[1], 1.25);
    } else if (e.pose === 'stand' && Math.hypot(e.pos.x - d.pos[0], e.pos.z - d.pos[2]) > 1.0 && !(d.seat || d.bed)) {
      // back to the post (after a search)
      if (!e.wantMove) goTo(e, d.pos[0], d.pos[1], d.pos[2], 1.2);
      else if (arrived(e)) { e.wantMove = false; e.faceYaw = d.yaw; applyActivity(e, 0); }
    } else if (!e.wantMove) e.faceYaw = e.lookYaw = e.bodyYaw;
  }

  function thinkSuspicious(e) {
    // look toward the interest point, then go and check it (sleepers/sitters just look)
    const dx = e.interest.x - e.pos.x, dz = e.interest.z - e.pos.z, d = Math.hypot(dx, dz);
    e.lookYaw = Math.atan2(-dx, -dz);
    if (e.startleUntil < 0) e.faceYaw = e.lookYaw;
    e.weaponOut = e.armed; e.pose = 'stand';
    const t = now - e.stateT;
    if (t > 1.6 && d > 2.5 && !e.wantMove && e.def.role !== 'ambusher' && t < 12) goTo(e, e.interest.x, e.interest.y, e.interest.z, 1.0);
    if (e.wantMove && (arrived(e) || d < 2)) { e.wantMove = false; e.clip = 'look_around'; }
    if (t > 14 && e.aware < 0.25) { setState(e, 'idle'); e.wantMove = false; applyActivity(e, 0); }
  }

  function thinkAmbush(e, P) {
    e.pose = 'crouch'; e.crouch = true; e.weaponOut = e.armed; e.wantMove = false;
    const dx = P.pos.x - e.pos.x, dz = P.pos.z - e.pos.z, d = Math.hypot(dx, dz);
    if (!e.canSee) {
      if (now - e.stateT > 90 && e.heardT > 0) { setState(e, 'alert'); }
      return;
    }
    e.lookYaw = e.faceYaw = Math.atan2(-dx, -dz);
    // fire when the target is close, or passing (looking away), or has spotted us
    const look = -(P.forward.x * dx + P.forward.z * dz) / Math.max(d, 1e-3);
    if (d < 7 || (d < 16 && look < 0.6) || now - e.seenT > 0 && e.seenT - e.firstSeenT > 2.5) {
      setState(e, 'combat');
      e.reactAt = now + rng.range(0.15, 0.35); e.shotsThisContact = 0; e.onTargetT = 0.6;
      if (!e.alerted) { e.alerted = true; evE.id = e.id; evE.enemy = e; evE.amount = 0; evE.part = ''; env.emit('enemy:alert', evE); }
    }
  }

  function thinkAlert(e, P) {
    e.weaponOut = e.armed; e.aiming = true;
    if (e.pose === 'sit' || e.pose === 'lie') { wakeUp(e); return; }
    const lk = e.lastKnown;
    e.lookYaw = Math.atan2(-(lk.x - e.pos.x), -(lk.z - e.pos.z));
    if (!e.armed) { startFlee(e); return; }
    // take cover facing the threat first
    if (e.coverIdx < 0 && !e.wantMove && C) {
      const p = findCover(C, cs, env.los, e, e.pos.x, e.pos.y, e.pos.z, lk.x, lk.y + 1.4, lk.z, 'cover', e.index, 10);
      if (p >= 0) { claimCover(e, p); goTo(e, C.x[p], C.y[p], C.z[p], 3.0); }
    }
    if (e.wantMove && arrived(e)) e.wantMove = false;
    if (!e.wantMove) e.faceYaw = e.lookYaw;
    e.crouch = e.coverIdx >= 0 && !e.wantMove && !(C.bits[e.coverIdx] >> 4);
    // after a while, go looking (not all of them: the first one in a group holds)
    const t = now - Math.max(e.stateT, e.heardT);
    if (t > (e.index % 3 === 0 ? 14 : 6) && !e.wantMove) { setState(e, 'search'); e.searchN = 0; e.pathLen = 0; }
  }

  function thinkSearch(e) {
    e.weaponOut = e.armed; e.aiming = true; e.crouch = false;
    if (!e.armed) { startFlee(e); return; }
    const lk = e.lastKnown;
    if (!e.wantMove) {
      if ((e.searchN ?? 0) === 0) { goTo(e, lk.x, lk.y, lk.z, 1.1); e.searchN = 1; }
      else if (e.searchN < 4) {
        // sweep: a random reachable spot around the last known position
        const k = nav.nearest(lk.x + rng.range(-7, 7), lk.y + 0.2, lk.z + rng.range(-7, 7), 2);
        if (k >= 0) goTo(e, nav.nodeX(k), nav.nodeY[k], nav.nodeZ(k), 1.1);
        e.searchN++; e.clip = 'look_around';
      } else if (now - e.stateT > 40) {
        // give up: back to the post, still wary (a new noise brings them back fast)
        setState(e, 'idle'); e.aware = 0.25; e.act = e.def.role === 'patrol' ? 'patrol' : 'guard';
        applyActivity(e, 0);
      }
    } else if (arrived(e)) { e.wantMove = false; e.faceYaw = e.lookYaw = e.bodyYaw + rng.range(-2, 2); }
    else e.lookYaw = e.moveYaw;
    if (now - e.stateT > 6 && rng.chance(0.06) && now - lastShout.taunt > 9) { lastShout.taunt = now; voice(e, 'taunt'); }
  }

  function thinkCombat(e, P) {
    e.weaponOut = e.armed; e.aiming = true;
    if (e.pose === 'sit' || e.pose === 'lie') { wakeUp(e); return; }
    if (!e.armed) { startFlee(e); return; }
    const lk = e.lastKnown;
    const dx = lk.x - e.pos.x, dz = lk.z - e.pos.z, dist = Math.hypot(dx, dz);
    e.lookYaw = Math.atan2(-dx, -dz);
    const lost = now - e.seenT;
    // surrender / flee when cornered and outgunned
    if (checkBreak(e, P, dist)) return;
    // lost contact → alert (hold / suppress) → search
    if (lost > 2.2) {
      if (lost < 5 && e.ammo > 3 && rng.chance(0.35) && e.coverIdx >= 0) { e.suppress = now + rng.range(0.8, 1.6); }
      if (lost > 4.5) { setState(e, 'alert'); e.heardT = now; return; }
    }
    // reposition: cover, retreat when hurt / squad thinned, flank when the squad is engaged
    if (!e.wantMove) {
      const hurt = e.health < HEALTH * 0.45;
      if (C && (e.coverIdx < 0 || hurt && !e.retreated)) {
        const p = findCover(C, cs, env.los, e, e.pos.x, e.pos.y, e.pos.z, lk.x, lk.y + 1.4, lk.z, hurt ? 'retreat' : 'cover', e.index, hurt ? 16 : 9);
        if (p >= 0) { claimCover(e, p); e.coverSide = cs.side; goTo(e, C.x[p], C.y[p], C.z[p], 3.4); if (hurt) e.retreated = true; }
        else if (dist > 4 && e.canSee && now > e.strafeUntil && rng.chance(0.3)) strafe(e);
      } else if (e.isFlanker && now > e.flankAt && e.flankAt > 0 && C) {
        const p = findCover(C, cs, env.los, e, e.pos.x, e.pos.y, e.pos.z, lk.x, lk.y + 1.4, lk.z, 'flank', e.index, 22);
        e.flankAt = -1;
        if (p >= 0) { claimCover(e, p); goTo(e, C.x[p], C.y[p], C.z[p], 3.6); }
      } else if (e.coverIdx >= 0) {
        // peek / hide cycle at cover
        if (e.peeking && now > e.peekUntil) { e.peeking = false; e.hideUntil = now + rng.range(0.8, 2.2); if (e.ammo < e.w.mag * 0.5) startReload(e); }
        else if (!e.peeking && now > e.hideUntil) { e.peeking = true; e.peekUntil = now + rng.range(1.4, 3.2); }
      }
      // pick a flanker (one per engagement) and announce it
      if (!e.isFlanker && e.flankAt < 0 && rng.chance(0.15)) {
        let engaged = 0, flankers = 0;
        for (const o of list) if (!o.dead && o.state === 'combat') { engaged++; if (o.isFlanker) flankers++; }
        if (engaged >= 2 && flankers === 0 && dist > 6) {
          e.isFlanker = true; e.flankAt = now + rng.range(1.5, 4);
          if (now - lastShout.command > 6) { lastShout.command = now; voice(e, 'command'); }
        }
      }
    } else if (arrived(e)) e.wantMove = false;
    if (!e.wantMove) e.faceYaw = e.lookYaw;
    const atCover = e.coverIdx >= 0 && !e.wantMove && Math.hypot(e.pos.x - C.x[e.coverIdx], e.pos.z - C.z[e.coverIdx]) < 0.6;
    const high = atCover && (C.bits[e.coverIdx] >> 4);
    e.crouch = atCover && !high && !e.peeking;
    e.lean = atCover && high && e.peeking ? e.coverSide : 0;
    if (e.canSee && now - lastShout.taunt > 12 && rng.chance(0.03)) { lastShout.taunt = now; voice(e, 'taunt'); }
  }

  function checkBreak(e, P, dist) {
    if (e.def.brave || e.def.role === 'ambusher') return false;
    let allies = 0;
    for (const o of list) if (o !== e && !o.dead && o.state !== 'surrender' && o.state !== 'flee' && Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) < 14) allies++;
    const aimed = -(P.forward.x * (P.pos.x - e.pos.x) + P.forward.z * (P.pos.z - e.pos.z)) / Math.max(dist, 1e-3) > 0.94;
    const weak = e.health < HEALTH * 0.5 || !e.armed || e.ammo === 0 && e.reloadUntil < now;
    if (allies === 0 && dist < 7 && e.canSee && aimed && weak) {
      if (e.def.surrenders !== false && rng.chance(0.65)) { surrender(e); return true; }
      startFlee(e); return true;
    }
    if (allies === 0 && weak && dist < 12 && rng.chance(0.05)) { startFlee(e); return true; }
    return false;
  }

  function surrender(e) {
    setState(e, 'surrender');
    e.surrendered = true; stats.surrendered++;
    e.wantMove = false; e.aiming = false; e.weaponOut = false; e.crouch = false; e.lean = 0;
    if (e.armed) dropWeapon(e);
    e.pose = 'hands'; e.clip = 'surrender'; e.clipT = now + rng.range(2.5, 4);
    voice(e, 'plead'); e.pleadT = now;
    env.emit('d:surrender', stateEvt(e));
  }
  function thinkSurrender(e, P) {
    if (e.pose === 'hands' && now > e.clipT) { e.pose = 'kneel'; e.clip = 'kneel_hands_head'; }
    const d = Math.hypot(P.pos.x - e.pos.x, P.pos.z - e.pos.z);
    e.lookYaw = Math.atan2(-(P.pos.x - e.pos.x), -(P.pos.z - e.pos.z));
    if (d < 9 && now - e.pleadT > rng.range(6, 11)) { e.pleadT = now; voice(e, 'plead'); }
  }
  function startFlee(e) {
    if (e.state === 'flee') return;
    setState(e, 'flee'); e.fled = true; stats.fled++;
    e.aiming = false; e.crouch = false; e.lean = 0; e.pathLen = 0; e.wantMove = false;
    voice(e, 'pain');
  }
  function thinkFlee(e, P) {
    if (!e.wantMove) {
      const p = C ? findCover(C, cs, env.los, e, e.pos.x, e.pos.y, e.pos.z, P.pos.x, P.pos.y + 1.4, P.pos.z, 'flee', e.index, 30) : -1;
      if (p >= 0 && Math.hypot(C.x[p] - e.pos.x, C.z[p] - e.pos.z) > 3) { claimCover(e, p); goTo(e, C.x[p], C.y[p], C.z[p], 4.0); }
      else if (e.canSee && Math.hypot(P.pos.x - e.pos.x, P.pos.z - e.pos.z) < 8) { surrender(e); return; }
      else if (now - e.stateT > 20 && e.armed) { setState(e, 'alert'); return; }
    } else if (arrived(e)) { e.wantMove = false; e.crouch = true; if (e.armed && now - e.stateT > 6) setState(e, 'alert'); }
    if (e.canSee && Math.hypot(P.pos.x - e.pos.x, P.pos.z - e.pos.z) < 5) surrender(e);
  }

  function strafe(e) {
    // a short sidestep perpendicular to the threat (also clears a blocked line of fire)
    const lk = e.lastKnown, dx = lk.x - e.pos.x, dz = lk.z - e.pos.z, l = Math.hypot(dx, dz) || 1;
    const s = rng.chance(0.5) ? 1 : -1, r = rng.range(1.5, 3);
    const k = nav.nearest(e.pos.x - dz / l * r * s, e.pos.y + 0.2, e.pos.z + dx / l * r * s, 1);
    if (k >= 0) { goTo(e, nav.nodeX(k), nav.nodeY[k], nav.nodeZ(k), 1.6); e.strafeUntil = now + rng.range(2, 4); }
  }

  function claimCover(e, p) {
    if (e.coverIdx >= 0) C.owner[e.coverIdx] = -1;
    e.coverIdx = p; C.owner[p] = e.index; e.peeking = true; e.peekUntil = now + rng.range(1.5, 3); e.hideUntil = 0;
  }

  // ----------------------------------------------------------------------------------------------------
  // firing
  function startReload(e) {
    if (e.reloadUntil > now || e.ammo === e.w.mag) return;
    e.reloadUntil = now + e.w.reload; e.burstLeft = 0;
    oneShot(e, e.w.anim + '_reload');
    if (rng.chance(0.55)) voice(e, 'reload');
  }

  function combatAct(e, dt) {
    const P = env.player;
    if (e.reloadUntil > 0 && now >= e.reloadUntil) { e.reloadUntil = -1; e.ammo = e.w.mag; }
    if (e.state !== 'combat' || !e.armed || P.dead) { e.onTargetT = 0; return; }
    e.fireCd -= dt;
    const yawErr = Math.abs(wrap(e.lookYaw - e.bodyYaw));
    if (e.canSee) e.onTargetT += dt; else e.onTargetT = Math.max(0, e.onTargetT - dt * 2);
    const suppressing = !e.canSee && e.suppress > now;
    if (!e.canSee && !suppressing) return;
    if (now < e.reactAt || e.busyUntil > now || e.reloadUntil > now || yawErr > 1.2) return;
    if (e.crouch && !e.peeking) return;           // hidden behind low cover
    if (e.wantMove && e.speed > 2.2) return;       // no firing at a run
    if (e.ammo <= 0) { startReload(e); return; }
    if (e.fireCd > 0) return;
    if (e.burstLeft <= 0) { e.burstLeft = Math.round(rng.range(e.w.burst[0], e.w.burst[1] + 0.49)); }
    fireShot(e, P, suppressing);
    e.burstLeft--;
    e.fireCd = e.burstLeft > 0 ? rng.range(e.w.rof[0], e.w.rof[1]) : rng.range(0.6, 1.4) + (e.w.pellets > 1 ? 0.4 : 0);
  }

  function muzzle(e) {
    const s = Math.sin(e.bodyYaw), c = Math.cos(e.bodyYaw);
    O.x = e.pos.x - s * 0.35 + c * 0.12 + c * e.lean * 0.45;
    O.y = e.pos.y + (e.crouch ? 1.0 : 1.42);
    O.z = e.pos.z - c * 0.35 - s * 0.12 - s * e.lean * 0.45;
    // muzzle inside geometry (hugging a wall): fire from the eye instead
    A.x = e.pos.x; A.y = O.y + 0.15; A.z = e.pos.z;
    if (!env.los(A, O)) { O.x = A.x; O.y = A.y; O.z = A.z; }
    return O;
  }

  function fireShot(e, P, suppress) {
    const o = muzzle(e);
    // aim point: player body when the shot is meant to hit, otherwise a near miss around it
    const tx = suppress ? e.lastKnown.x : P.pos.x, tz = suppress ? e.lastKnown.z : P.pos.z;
    const ty = (suppress ? e.lastKnown.y : P.pos.y) + (P.crouched ? 0.8 : 1.2);
    let dx = tx - o.x, dy = ty - o.y, dz = tz - o.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > e.w.range && !suppress) return;
    // the aimed line must be clear (no shooting through walls / closed doors); suppression only at the spot
    B.x = tx; B.y = ty; B.z = tz;
    if (!env.los(o, B)) {
      if (suppress) { e.suppress = 0; return; }
      B.y = suppress ? ty : P.eye.y - 0.05;   // only the head shows above cover
      if (!env.los(o, B)) { return; }
      dy = B.y - o.y;
    }
    // friendly fire: an ally in the line of fire → hold and sidestep
    for (const a of list) {
      if (a === e || a.dead || !a.active) continue;
      const ax = a.pos.x - o.x, ay = a.pos.y + 1.1 - o.y, az = a.pos.z - o.z;
      const t = (ax * dx + ay * dy + az * dz) / (dist * dist);
      if (t <= 0 || t >= 1) continue;
      const px = ax - dx * t, py = ay - dy * t, pz = az - dz * t;
      if (px * px + pz * pz < 0.36 && Math.abs(py) < 1.0) { stats.shotsBlockedFF++; e.ffBlockT = now; if (!e.wantMove) strafe(e); return; }
    }
    // hit probability
    let p = e.w.acc * Math.max(0.25, Math.min(1.1, 1.15 - dist / 35));
    p *= Math.min(1, 0.45 + e.onTargetT / 2.2);
    p *= P.moving > 3.5 ? 0.6 : P.moving > 1.6 ? 0.8 : 1;
    if (P.crouched) p *= 0.85;
    if (e.limp || e.health < HEALTH * 0.5) p *= 0.75;
    if (e.wantMove) p *= 0.6;
    const first = e.shotsThisContact === 0;
    // first shots at close range are rushed: they mostly miss (fair warning), never at an ambush's point blank
    let hit = rng.next() < p && !suppress;
    if (first && dist < 12 && rng.chance(0.65)) hit = false;
    e.shotsThisContact++;
    let ox = 0, oy = 0, oz = 0;
    const l = dist || 1;
    // perpendicular basis (right r, up u) to the line of fire
    const rx = -dz / Math.hypot(dx, dz), rz = dx / Math.hypot(dx, dz);
    if (hit) { const g = 0.11; ox = rx * rng.gauss() * g; oz = rz * rng.gauss() * g; oy = rng.gauss() * g * 1.4; }
    else {
      const r = suppress ? rng.range(0.2, 1.6) : rng.range(0.45, 1.3), a = rng.range(0, Math.PI * 2);
      ox = rx * Math.cos(a) * r; oz = rz * Math.cos(a) * r; oy = Math.abs(Math.sin(a)) * r * (rng.chance(0.75) ? 1 : -0.6);
    }
    dx += ox; dy += oy; dz += oz;
    const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n;
    e.ammo--; e.fireSeq++;
    evFire.id = e.id; evFire.enemy = e; evFire.weapon = e.def.weapon;
    evFire.origin.x = o.x; evFire.origin.y = o.y; evFire.origin.z = o.z; evFire.dir.x = dx; evFire.dir.y = dy; evFire.dir.z = dz;
    env.emit('enemy:fire', evFire);
    noise(o.x, o.y, o.z, 45, 'shot', e);
    const pel = e.w.pellets;
    let anyHit = false, closest = 99, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < pel; k++) {
      D.x = dx; D.y = dy; D.z = dz;
      if (pel > 1) {
        D.x += rng.gauss() * e.w.spread; D.y += rng.gauss() * e.w.spread * 0.7; D.z += rng.gauss() * e.w.spread;
        const m = Math.hypot(D.x, D.y, D.z); D.x /= m; D.y /= m; D.z /= m;
      }
      stats.shots++;
      if (!suppress && opts.audit) opts.audit(e, o, D, P);
      const res = env.fire(e, o, D, e.w.range, e.w.dmg);
      if (res.hit && res.target === P.ref) { anyHit = true; stats.hits++; continue; }
      // near miss: closest approach of the bullet segment to the player's head
      const ex = P.eye.x - o.x, ey = P.eye.y - o.y, ez = P.eye.z - o.z;
      const t = Math.max(0, Math.min(res.t, ex * D.x + ey * D.y + ez * D.z));
      const qx = o.x + D.x * t - P.eye.x, qy = o.y + D.y * t - P.eye.y, qz = o.z + D.z * t - P.eye.z;
      const cd = Math.hypot(qx, qy, qz);
      if (cd < closest) { closest = cd; cx = qx + P.eye.x; cy = qy + P.eye.y; cz = qz + P.eye.z; }
    }
    if (!anyHit && closest < 1.4) {
      stats.nearMisses++;
      evMiss.id = e.id; evMiss.enemy = e; evMiss.point.x = cx; evMiss.point.y = cy; evMiss.point.z = cz; evMiss.dist = closest;
      env.emit('d:nearmiss', evMiss);
    }
  }

  // ----------------------------------------------------------------------------------------------------
  // movement along nav paths
  function goTo(e, x, y, z, speed) {
    e.goal.x = x; e.goal.y = y; e.goal.z = z; e.speedWant = speed;
    e.goalNode = nav.nearest(x, y + 0.2, z, 2);
    e.wantMove = e.goalNode >= 0; e.pathLen = 0; e.pathI = 0; e.pathPending = e.wantMove; e.repaths = 0;
    e.progT = now; e.lastProg.x = e.pos.x; e.lastProg.z = e.pos.z; e.stuckT = 0;
  }
  function arrived(e) { return !e.wantMove || (e.pathLen > 0 && e.pathI >= e.pathLen) || Math.hypot(e.goal.x - e.pos.x, e.goal.z - e.pos.z) < 0.4 && Math.abs(e.goal.y - e.pos.y) < 1; }

  function computePath(e) {
    if (pathsThisFrame >= PATHS_PER_FRAME) return false;
    pathsThisFrame++;
    e.pathPending = false;
    const a = nav.nearest(e.pos.x, e.pos.y + 0.3, e.pos.z, 2);
    const tp = performance.now();
    const n = a >= 0 ? nav.findPath(a, e.goalNode, tmpPath, 30000) : 0;
    const tq = performance.now() - tp; if (tq > stats.pathMsMax) stats.pathMsMax = tq;
    if (!n) { e.wantMove = false; e.goalNode = -1; e.noPath = (e.noPath ?? 0) + 1; return true; }
    const m = Math.min(n, MAX_PATH);
    for (let k = 0; k < m; k++) e.path[k] = tmpPath[n - 1 - k];
    e.pathLen = m; e.pathI = 0; e.carrot = 0;
    return true;
  }

  /** node in the nav column at (x,z) within 0.5 m of y, or -1 */
  function navAt(x, y, z) {
    const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((z - nav.z0) / nav.cell);
    if (i < 0 || j < 0 || i >= nav.W || j >= nav.H) return -1;
    const c = j * nav.W + i;
    for (let k = nav.colStart[c]; k < nav.colStart[c + 1]; k++) if (Math.abs(nav.nodeY[k] - y) < 0.5) return k;
    return -1;
  }
  function straightWalkable(ax, ay, az, k) {
    const bx = nav.nodeX(k), by = nav.nodeY[k], bz = nav.nodeZ(k);
    const l = Math.hypot(bx - ax, bz - az), n = Math.ceil(l / 0.25);
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const m = navAt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      if (m < 0 || nav.nodeDoor[m] >= 0 && env.doorOpen(nav.nodeDoor[m]) < 0.9) return false;
    }
    return true;
  }

  function moveAct(e, dt) {
    if (!e.wantMove || e.busyUntil > now || e.hold && !e.scripted) { e.speed = Math.max(0, e.speed - dt * 6); return; }
    if (e.pathPending || (e.pathLen === 0 && e.goalNode >= 0)) { if (!computePath(e)) return; if (!e.wantMove) return; }
    if (e.pathI >= e.pathLen) {
      // path truncated (long route) → continue
      if (Math.hypot(e.goal.x - e.pos.x, e.goal.z - e.pos.z) > 0.6) { e.pathPending = true; }
      else e.wantMove = false;
      e.speed = Math.max(0, e.speed - dt * 6);
      return;
    }
    // advance past reached nodes
    while (e.pathI < e.pathLen) {
      const k = e.path[e.pathI];
      if (Math.hypot(nav.nodeX(k) - e.pos.x, nav.nodeZ(k) - e.pos.z) < 0.35 && Math.abs(nav.nodeY[k] - e.pos.y) < 0.6) e.pathI++;
      else break;
    }
    if (e.pathI >= e.pathLen) return;
    // carrot: farthest node ahead (≤ 6) reachable in a straight line (checked when the index changes)
    if (e.carrot < e.pathI) {
      let c = e.pathI;
      for (let k = Math.min(e.pathLen - 1, e.pathI + 6); k > e.pathI; k--) if (straightWalkable(e.pos.x, e.pos.y, e.pos.z, e.path[k])) { c = k; break; }
      e.carrot = c;
    }
    const k = e.path[Math.max(e.carrot, e.pathI)];
    // doors on the way: open, wait
    const door = nav.nodeDoor[e.path[e.pathI]];
    if (door >= 0 && env.doorOpen(door) < 0.4) {
      if (env.doorState(door) === 'locked') { e.wantMove = false; e.goalNode = -1; return; }
      if (e.waitDoor !== door) { env.openDoor(door, e); e.waitDoor = door; }
      e.speed = 0; return;
    }
    e.waitDoor = -1;
    const tx = nav.nodeX(k), tz = nav.nodeZ(k);
    let dx = tx - e.pos.x, dz = tz - e.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    // separation from other enemies
    for (const o of list) {
      if (o === e || o.dead || !o.active) continue;
      const ox = e.pos.x - o.pos.x, oz = e.pos.z - o.pos.z, od = ox * ox + oz * oz;
      if (od < 0.5 && od > 1e-4 && Math.abs(o.pos.y - e.pos.y) < 1) { const s = (0.5 - od) * 1.5; dx += ox * s; dz += oz * s; }
    }
    const want = e.limp ? Math.min(e.speedWant, 1.0) : e.crouch && e.speedWant < 2 ? 0.9 : e.speedWant;
    e.speed += Math.max(-dt * 6, Math.min(dt * 4, want - e.speed));
    e.moveYaw = Math.atan2(-dx, -dz);
    // turn before walking off when facing far away (turn in place)
    const turn = Math.abs(wrap(e.moveYaw - e.bodyYaw));
    const sp = turn > 1.6 && e.speed < 1.5 ? e.speed * 0.3 : e.speed;
    mv.x = dx * sp * dt; mv.z = dz * sp * dt; mv.y = -0.05;
    env.collision.move(e.pos, mv, MOVE_OPTS, e.cstate);
    // stairs / ramps: y follows the ground (collision snaps), never sink below the nav layer
    const ny = nav.nodeY[k];
    if (e.pos.y < ny - 0.5) e.pos.y = ny;
    // footsteps (for audio): one per stride when near the player
    e.stepDist += sp * dt;
    const stride = e.speed > 2.5 ? 1.25 : 0.75;
    if (e.stepDist > stride) {
      e.stepDist = 0;
      const P = env.player;
      if (Math.abs(P.pos.x - e.pos.x) + Math.abs(P.pos.z - e.pos.z) < 35) {
        evStep.id = e.id; evStep.enemy = e; evStep.pos.x = e.pos.x; evStep.pos.y = e.pos.y; evStep.pos.z = e.pos.z; evStep.run = e.speed > 2.5;
        env.emit('d:step', evStep);
      }
    }
    // progress / stuck detection
    if (Math.hypot(e.pos.x - e.lastProg.x, e.pos.z - e.lastProg.z) > 0.4) { e.lastProg.x = e.pos.x; e.lastProg.z = e.pos.z; e.progT = now; e.stuckT = 0; }
    else {
      e.stuckT = now - e.progT;
      if (e.stuckT > stats.stuckMax) { stats.stuckMax = e.stuckT; stats.stuckId = e.id; }
      if (e.stuckT > 1.5 && e.repaths < 3) { e.repaths++; e.progT = now; e.pathPending = true; e.stuckT = 0; }
      else if (e.stuckT > 1.5) { e.wantMove = false; e.goalNode = -1; e.stuckT = 0; }
    }
  }

  function turnAct(e, dt) {
    if (e.dead) return;
    if (e.startleUntil > 0 && now >= e.startleUntil) { e.bodyYaw = wrap(e.bodyYaw + Math.PI); e.faceYaw = e.lookYaw; e.startleUntil = -1; }
    if (e.startleUntil > 0 || e.pose === 'sit' || e.pose === 'lie' || e.busyUntil > now && e.oneShot === 'lying_to_idle') return;
    let target = e.faceYaw;
    const moving = e.wantMove && e.speed > 0.2;
    if (moving) {
      // walking while aiming: face the target, legs walk forward/back; running: face where we go
      const aimMove = e.aiming && e.speed < 2.2 && e.state === 'combat' && e.canSee;
      target = aimMove ? e.lookYaw : e.moveYaw;
      e.moveSign = aimMove && Math.cos(e.moveYaw - e.lookYaw) < -0.2 ? -1 : 1;
    } else e.moveSign = 1;
    // torso can twist ±60° toward the look direction; the body follows beyond that
    if (!moving && e.aiming) { const off = wrap(e.lookYaw - e.bodyYaw); if (Math.abs(off) > 0.35) target = e.lookYaw; else target = e.bodyYaw; }
    const diff = wrap(target - e.bodyYaw);
    const rate = moving ? 6 : 4;
    e.bodyYaw = wrap(e.bodyYaw + Math.sign(diff) * Math.min(Math.abs(diff), rate * dt));
    e.turning = Math.abs(diff) > 0.05 && !moving ? Math.sign(diff) : 0;
    e.yaw = e.bodyYaw;
  }

  // ----------------------------------------------------------------------------------------------------
  // damage
  /** ray vs the enemy's hit capsules (actor-local). Writes part name into `part`. Returns t or -1. */
  function raycast(e, o, d, maxT, part) {
    if (e.dead || !e.active) return -1;
    // cheap bound: vertical cylinder r 1.1 around the actor
    const ox = o.x - e.pos.x, oy = o.y - e.pos.y, oz = o.z - e.pos.z;
    const a2 = d.x * d.x + d.z * d.z;
    if (a2 > 1e-8) {
      const tc = -(ox * d.x + oz * d.z) / a2;
      const cx = ox + d.x * tc, cz = oz + d.z * tc;
      if (cx * cx + cz * cz > 1.21) return -1;
    } else if (ox * ox + oz * oz > 1.21) return -1;
    // to actor-local (rotate by -yaw)
    const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
    const lox = c * ox - s * oz, loz = s * ox + c * oz, ldx = c * d.x - s * d.z, ldz = s * d.x + c * d.z;
    const caps = e.caps, names = e.capNames;
    let best = maxT, bi = -1;
    for (let i = 0; i < e.capN; i++) {
      const b = i * 7;
      const t = rayCapsule(lox, oy, loz, ldx, d.y, ldz, caps[b], caps[b + 1], caps[b + 2], caps[b + 3], caps[b + 4], caps[b + 5], caps[b + 6]);
      if (t >= 0 && t < best) { best = t; bi = i; }
    }
    if (bi < 0) return -1;
    part.name = PART_GROUP[names[bi]] ?? 'torso'; part.capsule = names[bi]; e.lastCapsule = names[bi];
    return best;
  }

  /**
   * Damage from a bullet. part: capsule name (head, chest, thigh_l …). dir: bullet direction. byPlayer: bool.
   */
  function applyHit(e, capsule, damage, dir, byPlayer = true) {
    if (e.dead || !e.active) return 0;
    const mul = PART_MUL[capsule] ?? 1;
    const dmg = damage * mul;
    if (e.state === 'surrender' && byPlayer) { e.executed = true; stats.executed++; env.emit('d:executed', stateEvt(e)); }
    e.health -= dmg;
    // hit reaction (presentation): direction in actor space
    e.hitSeq++; e.hitAmt = Math.min(1, dmg / 40);
    const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
    e.hitDirX = c * dir.x - s * dir.z; e.hitDirZ = s * dir.x + c * dir.z;
    evE.id = e.id; evE.enemy = e; evE.amount = dmg; evE.part = PART_GROUP[capsule] ?? 'torso';
    env.emit('enemy:damage', evE);
    const P = env.player;
    if (e.health <= 0) { kill(e, capsule, dir); return dmg; }
    // wounded: now they know where the shot came from
    if (byPlayer) {
      e.lastKnown.x = P.pos.x; e.lastKnown.y = P.pos.y; e.lastKnown.z = P.pos.z;
      if (e.state !== 'surrender' && e.state !== 'flee') {
        if (e.state !== 'combat') { e.aware = 1.2; e.seenT = now; enterCombat(e, Math.hypot(P.pos.x - e.pos.x, P.pos.z - e.pos.z)); }
        e.reactAt = Math.max(e.reactAt, now + 0.35);   // flinch delays the next shot
      }
    }
    voice(e, 'pain');
    if (capsule.startsWith('thigh') || capsule.startsWith('calf') || capsule.startsWith('foot')) { e.limp = true; e.busyUntil = Math.max(e.busyUntil, now + 0.5); oneShot(e, 'hit_' + (e.hitDirZ > 0 ? 'back' : 'front')); }
    else if ((capsule === 'hand_r' || capsule === 'lowerarm_r') && e.armed && rng.chance(0.6)) { dropWeapon(e); }
    else if (capsule === 'head' || capsule === 'neck') oneShot(e, 'hit_head');
    else if (dmg > 25 && e.speed < 1) oneShot(e, 'hit_chest');
    e.onTargetT *= 0.3;
    return dmg;
  }

  function dropWeapon(e) {
    e.armed = false; e.weaponDropped = true; e.weaponOut = false; e.aiming = false;
    e.dropX = e.pos.x; e.dropY = e.pos.y; e.dropZ = e.pos.z; e.dropYaw = e.bodyYaw + rng.range(-1, 1);
  }

  function kill(e, capsule, dir) {
    e.dead = true; e.health = 0; stats.kills++;
    e.wantMove = false; e.speed = 0; e.aiming = false; e.lean = 0; e.crouch = false;
    if (e.coverIdx >= 0) { C.owner[e.coverIdx] = -1; e.coverIdx = -1; }
    if (e.armed) dropWeapon(e);
    // death clip: matched to the hit (head → limp collapse; shot from the front → falls back …), then the fall
    // footprint must be clear floor at the same height (no clipping into props, no hanging off edges)
    const fwdHit = -(dir.x * -Math.sin(e.yaw) + dir.z * -Math.cos(e.yaw));   // >0: bullet came from the front
    let order;
    if (e.pose === 'lie' || e.pose === 'sit' || e.pose === 'kneel') order = DEATH_COMPACT;
    else if (capsule === 'head') order = fwdHit > 0 ? DEATH_HEAD_F : DEATH_HEAD_B;
    else order = fwdHit > 0 ? DEATH_FRONT : DEATH_BACK;
    let pick = 'death_slump', yawAdj = 0;
    outer: for (const clip of order) {
      const f = DEATH_FALL[clip];
      for (const adj of YAW_TRIES) {
        if (f.len === 0) { pick = clip; yawAdj = 0; break outer; }
        const y = e.bodyYaw + adj + f.dir;
        if (env.fallClear(e.pos.x, e.pos.y, e.pos.z, -Math.sin(y), -Math.cos(y), f.len)) { pick = clip; yawAdj = adj; break outer; }
      }
    }
    if (e.pose === 'lie') pick = 'sleep_death';
    else if (e.pose === 'sit') pick = 'sit_death';
    e.bodyYaw = e.yaw = wrap(e.bodyYaw + yawAdj);
    e.deathClip = pick; e.deathT = now;
    // restrained wound reaction: some go down and writhe for a few seconds before going still (no gore)
    e.writheUntil = capsule !== 'head' && capsule !== 'neck' && pick !== 'sleep_death' && rng.chance(0.3) ? now + rng.range(3.5, 7) : -1;
    setState(e, 'dead');
    evE.id = e.id; evE.enemy = e; evE.amount = 0; evE.part = PART_GROUP[capsule] ?? 'torso';
    env.emit('enemy:death', evE);
    if (capsule !== 'head') voice(e, e.writheUntil > 0 ? 'dying' : 'death');
    // allies hear the scream/shot: a death nearby makes the survivors re-evaluate (retreat / break)
    noise(e.pos.x, e.pos.y + 1, e.pos.z, 18, 'scream', e);
  }

  function stateEvt(e) { evE.id = e.id; evE.enemy = e; evE.amount = 0; evE.part = ''; return evE; }

  // ----------------------------------------------------------------------------------------------------
  // director hooks
  function sel(ids) { return ids == null ? list : list.filter((e) => ids.includes(e.id) || ids.includes(e.def.group)); }
  function alert(ids, pos) {
    for (const e of sel(ids)) {
      if (e.dead || !e.active) continue;
      const P = env.player, p = pos ?? P.pos;
      e.lastKnown.x = p.x; e.lastKnown.y = p.y; e.lastKnown.z = p.z;
      if (e.state === 'hidden') armAmbush(e); else becomeAlert(e, rng.range(0, 0.4));
    }
  }
  function ambush(ids) { for (const e of sel(ids)) if (!e.dead) { e.active = true; if (e.state === 'hidden' || e.state === 'idle') { setState(e, 'hidden'); armAmbush(e); } } }
  function wake(ids) { for (const e of sel(ids)) if (!e.dead && e.state === 'idle') { e.interest.x = env.player.pos.x; e.interest.y = env.player.pos.y; e.interest.z = env.player.pos.z; becomeSuspicious(e); } }
  function spawn(ids) { for (const e of sel(ids)) e.active = true; }
  function setHold(ids, on = true) { for (const e of sel(ids)) e.hold = on; }
  function moveTo(id, x, y, z, run = false) { const e = list.find((q) => q.id === id); if (e && !e.dead) { e.scripted = { x, y, z, run }; goTo(e, x, y, z, run ? 3.4 : 1.4); } }
  function say(id, kind) { const e = list.find((q) => q.id === id); if (e && !e.dead) voice(e, kind); }
  /** a staged moment fired: arm its ambushers, alert enemies bound to it */
  function trigger(momentId) {
    for (const e of list) {
      if (e.def.trigger !== momentId || e.dead) continue;
      e.active = true;
      if (e.def.role === 'ambusher') ambush([e.id]); else alert([e.id]);
    }
  }

  // ----------------------------------------------------------------------------------------------------
  function update(dt) {
    now += dt; frame++; pathsThisFrame = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.dead) continue;
      if ((frame + i) % PERCEIVE_EVERY === 0) { const t0 = performance.now(); perceive(e, dt * PERCEIVE_EVERY); const t1 = performance.now() - t0; if (t1 > stats.perceiveMsMax) stats.perceiveMsMax = t1; }
      if ((frame + i) % THINK_EVERY === 0) { const st0 = e.state, t0 = performance.now(); think(e); const t1 = performance.now() - t0; if (t1 > stats.thinkMsMax) { stats.thinkMsMax = t1; stats.thinkSlow = st0 + '>' + e.state + ':' + e.id; } if (opts.proxyCaps) fillProxyCaps(e); }
      combatAct(e, dt);
      moveAct(e, dt);
      turnAct(e, dt);
    }
  }

  return api;
}

// death clip fall footprints (body axis relative to the facing yaw, length in metres; 0 = compact)
const DEATH_FALL = {
  death_backward: { dir: Math.PI, len: 1.75 },
  death_forward: { dir: 0, len: 1.7 },
  death_headshot: { dir: 0, len: 1.6 },
  hit_knockback: { dir: Math.PI, len: 1.8 },
  death_slump: { dir: Math.PI, len: 0.6 },
};
const DEATH_FRONT = ['death_backward', 'death_slump', 'death_forward'];
const DEATH_BACK = ['death_forward', 'death_slump', 'death_backward'];
const DEATH_HEAD_F = ['death_headshot', 'death_backward', 'death_slump'];
const DEATH_HEAD_B = ['death_forward', 'death_headshot', 'death_slump'];
const DEATH_COMPACT = ['death_slump'];
const YAW_TRIES = [0, 0.5, -0.5, 1.0, -1.0];

export function wrap(a) { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; }

/** ray (o + t d) vs capsule segment a-b radius r. t or -1 (d need not be normalised; t in |d| units). */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  // closest points between the ray and the segment, then sphere test at the closest segment point
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = ox - ax, wy = oy - ay, wz = oz - az;
  const a = dx * dx + dy * dy + dz * dz, b = dx * ux + dy * uy + dz * uz, c = ux * ux + uy * uy + uz * uz;
  const d = dx * wx + dy * wy + dz * wz, e = ux * wx + uy * wy + uz * wz;
  const den = a * c - b * b;
  let s = c > 1e-9 ? (den > 1e-9 ? (a * e - b * d) / den : e / c) : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  // sphere at the segment point
  const cx = ax + ux * s, cy = ay + uy * s, cz = az + uz * s;
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const bb = mx * dx + my * dy + mz * dz, cc = mx * mx + my * my + mz * mz - r * r;
  const disc = bb * bb - a * cc;
  if (disc < 0) return -1;
  const t = (-bb - Math.sqrt(disc)) / a;
  return t >= 0 ? t : (cc < 0 ? 0 : -1);
}

export const STATES = ST;

// proxy hit capsules (brain-local frame: forward -z, y up from the feet) for headless runs; in the browser the
// animation layer replaces them every skeleton update with the 17 bone capsules of hitboxes.json
export const CAP_NAMES = ['head', 'neck', 'chest', 'stomach', 'pelvis', 'upperarm_l', 'lowerarm_l', 'hand_l', 'thigh_l', 'calf_l', 'foot_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_r', 'calf_r', 'foot_r'];
const PROXY = [
  [0, 1.6, 0, 0, 1.72, 0, 0.1], [0, 1.47, 0, 0, 1.52, 0, 0.07], [0, 1.28, 0, 0, 1.38, 0, 0.17], [0, 1.08, 0, 0, 1.15, 0, 0.16], [0, 0.92, 0, 0, 0.96, 0, 0.16],
  [0.22, 1.2, 0, 0.24, 1.42, 0, 0.06], [0.25, 0.95, -0.05, 0.24, 1.18, 0, 0.05], [0.26, 0.85, -0.08, 0.26, 0.92, -0.06, 0.04],
  [0.1, 0.55, 0, 0.1, 0.88, 0, 0.09], [0.1, 0.12, 0, 0.1, 0.5, 0, 0.065], [0.1, 0.04, -0.05, 0.1, 0.06, -0.12, 0.05],
  [-0.22, 1.2, 0, -0.24, 1.42, 0, 0.06], [-0.25, 0.95, -0.05, -0.24, 1.18, 0, 0.05], [-0.26, 0.85, -0.08, -0.26, 0.92, -0.06, 0.04],
  [-0.1, 0.55, 0, -0.1, 0.88, 0, 0.09], [-0.1, 0.12, 0, -0.1, 0.5, 0, 0.065], [-0.1, 0.04, -0.05, -0.1, 0.06, -0.12, 0.05],
];
export function fillProxyCaps(e) {
  const k = e.crouch ? 0.66 : e.pose === 'kneel' ? 0.72 : e.pose === 'sit' ? 0.75 : 1;
  const lie = e.pose === 'lie';
  for (let i = 0; i < 17; i++) {
    const p = PROXY[i], b = i * 7;
    if (lie) { e.caps[b] = p[0]; e.caps[b + 1] = 0.2 + p[2]; e.caps[b + 2] = -p[1]; e.caps[b + 3] = p[3]; e.caps[b + 4] = 0.2 + p[5]; e.caps[b + 5] = -p[4]; }
    else { e.caps[b] = p[0]; e.caps[b + 1] = p[1] * k; e.caps[b + 2] = p[2]; e.caps[b + 3] = p[3]; e.caps[b + 4] = p[4] * k; e.caps[b + 5] = p[5]; }
    e.caps[b + 6] = p[6];
  }
  e.capN = 17; e.capNames = CAP_NAMES;
}
