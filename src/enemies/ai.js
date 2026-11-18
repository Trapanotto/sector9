import * as THREE from 'three';
import { TUNING as T } from './tuning.js';
import { wrapAngle } from './animator.js';
import { randomReachableNear } from './nav.js';

// Per-enemy AI: perception (vision cone + detection meter, hearing), state machine
// idle / patrol / suspicious / combat / search, combat tactics (cover, peek, push, hold), shooting with
// time-dependent accuracy, and path-following movement. No DOM access.
//
// W (world services, built by enemies.js):
//   { ctx, nav, time, list, pinfo, pathBudget, coverBudget, pushers:Set, coverReserve:Map, combatCount,
//     los(a,b), ground(x,z,fallback), schedule(delay, fn), alertAllies(e), onEnemyShot(e) }

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1 - 1e-9));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3(), _t4 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------------------------
// movement helpers
// ---------------------------------------------------------------------------------------------
export function setMove(e, target, speed) {
  if (!e.moving || e.moveTarget.distanceToSquared(target) > 0.36) {
    e.moveTarget.copy(target);
    e.needPath = true;
    e.arrived = false;
    e.pathFailed = false;
    e.stuckCount = 0;
  }
  e.moving = true;
  e.moveSpeed = speed;
}

export function stopMove(e) {
  e.moving = false;
  e.path.length = 0;
  e.needPath = false;
}

function faceToward(e, p, fromY = 1.35) {
  e.wantYaw = yawTo(e.position, p);
  const h = dist2D(e.position, p);
  e.wantPitch = Math.atan2(p.y - (e.position.y + fromY * e.ch.scale), Math.max(h, 0.5));
}

export function updateMovement(e, dt, W) {
  let dx = 0, dz = 0;
  e.repathCooldown -= dt;
  if (e.moving && e.stagger <= 0) {
    if (e.needPath && W.pathBudget > 0 && e.repathCooldown <= 0) {
      W.pathBudget--;
      e.needPath = false;
      e.repathCooldown = T.move.repathInterval;
      const path = W.nav.findPath(e.position, e.moveTarget);
      if (!path) { e.path.length = 0; e.pathFailed = true; e.arrived = true; }
      else { e.path = path; e.pathIdx = 0; }
    }
    if (e.path.length && !e.arrived) {
      let tgt = e.path[e.pathIdx];
      while (e.pathIdx < e.path.length - 1 && dist2D(e.position, tgt) < 0.4) tgt = e.path[++e.pathIdx];
      const last = e.pathIdx === e.path.length - 1;
      const d = dist2D(e.position, tgt);
      if (last && d < 0.22) e.arrived = true;
      else {
        let sp = e.moveSpeed * (e.health < T.health ? T.move.woundedMul : 1);
        if (last) sp *= clamp(d / 0.9, 0.3, 1);
        dx = ((tgt.x - e.position.x) / d) * sp;
        dz = ((tgt.z - e.position.z) / d) * sp;
      }
    }
  }
  // separation from other enemies and from the player
  const sep = T.move.separation;
  for (const o of W.list) {
    if (o === e || !o.alive) continue;
    const ox = e.position.x - o.position.x, oz = e.position.z - o.position.z;
    const d2 = ox * ox + oz * oz;
    if (d2 < sep * sep && d2 > 1e-6) {
      const d = Math.sqrt(d2), push = ((sep - d) / sep) * 1.6;
      dx += (ox / d) * push; dz += (oz / d) * push;
    }
  }
  const P = W.pinfo;
  if (P.ok) {
    const ox = e.position.x - P.pos.x, oz = e.position.z - P.pos.z, d2 = ox * ox + oz * oz;
    if (d2 < 0.64 && d2 > 1e-6) { const d = Math.sqrt(d2); dx += (ox / d) * 1.5; dz += (oz / d) * 1.5; }
  }
  const k = 1 - Math.exp(-T.move.accel * dt);
  e.velocity.x += (dx - e.velocity.x) * k;
  e.velocity.z += (dz - e.velocity.z) * k;
  e.position.x += e.velocity.x * dt;
  e.position.z += e.velocity.z * dt;
  W.nav.resolveCircle(e.position, T.move.radius);
  e.position.y = W.ground(e.position.x, e.position.z, e.position.y);

  // stuck detection -> repath, eventually give up
  if (e.moving && !e.arrived && Math.hypot(dx, dz) > 0.3) {
    e.stuckT += dt;
    if (e.stuckT > 1.0) {
      if (dist2D(e.position, e.stuckRef) < 0.25) {
        e.needPath = true;
        if (++e.stuckCount > 3) { e.arrived = true; e.pathFailed = true; }
      } else e.stuckCount = 0;
      e.stuckRef.copy(e.position);
      e.stuckT = 0;
    }
  } else { e.stuckT = 0; e.stuckRef.copy(e.position); }
}

// ---------------------------------------------------------------------------------------------
// perception
// ---------------------------------------------------------------------------------------------
export function perceive(e, dt, W) {
  e.senseAcc += dt;
  e.senseTimer -= dt;
  if (e.senseTimer > 0) return;
  const acc = Math.min(e.senseAcc, 0.3);
  e.senseAcc = 0;
  e.senseTimer = rand(T.vision.tickMin, T.vision.tickMax);

  const P = W.pinfo;
  let vis = 0, dist = Infinity, angle = Math.PI;
  if (P.ok && P.alive) {
    dist = e.eye.distanceTo(P.chest);
    e.distToPlayer = dist;
    const combat = e.state === 'combat';
    if (dist < T.vision.range * (combat ? 1.4 : 1)) {
      const tx = P.chest.x - e.eye.x, tz = P.chest.z - e.eye.z;
      const th = Math.hypot(tx, tz) || 1e-6;
      const cosA = (Math.sin(e.lookYaw) * tx + Math.cos(e.lookYaw) * tz) / th;
      angle = Math.acos(clamp(cosA, -1, 1));
      const half = combat ? T.vision.combatHalfAngle : T.vision.halfAngle;
      if (angle < half || dist < T.vision.closeAwareness) {
        const lc = W.los(e.eye, P.chest), lh = W.los(e.eye, P.head);
        vis = (lc ? 0.5 : 0) + (lh ? 0.5 : 0);
      }
    }
  }
  e.canSee = vis > 0;
  e.visFrac = vis;
  if (e.canSee) {
    e.lastSeenTime = W.time;
    e.lastKnown.copy(P.pos);
    e.lastKnownVel.copy(P.vel);
    e.hasLastKnown = true;
  }

  if (e.state !== 'combat') {
    if (vis > 0) {
      const D = T.detection;
      let tDet = D.baseTime + dist * D.timePerMetre + (dist / T.vision.range) ** 2 * D.farTime;
      if (P.speed > 4.2) tDet *= D.sprintMul; else if (P.speed > 0.6) tDet *= D.movingMul;
      if (P.crouched) tDet *= D.crouchMul;
      if (angle > D.peripheralAngle && dist > T.vision.closeAwareness) tDet *= D.peripheralMul;
      if (vis < 1) tDet *= D.partialMul;
      if (e.state === 'suspicious' || e.state === 'search' || e.alert > 0.2) tDet *= D.alertMul;
      if (dist < T.vision.closeAwareness) tDet *= D.closeMul;
      e.meter += acc / tDet;
    } else {
      e.meter = Math.max(0, e.meter - T.detection.decayPerSec * acc);
    }
    if (e.meter >= 1) {
      enterCombat(e, W, 'spotted');
    } else if (vis > 0 && e.meter >= T.detection.suspiciousAt) {
      if (e.state === 'search') { e.search.target.copy(P.pos); e.search.phase = 'go'; }
      else becomeSuspicious(e, W, P.pos);
    }
  } else {
    e.meter = 1;
  }

  // hearing the player's footsteps
  if (P.ok && P.alive && P.noise > 0.02 && !e.canSee) {
    const r = P.noise * T.hearing.footstepRange;
    const d = dist2D(e.position, P.pos);
    if (d < r && (d < r * T.hearing.wallMul || W.los(e.eye, P.head))) {
      _t1.copy(P.pos);
      _t1.x += (Math.random() - 0.5) * d * 0.12; _t1.z += (Math.random() - 0.5) * d * 0.12;
      if (e.state === 'combat') e.lastKnown.copy(_t1);
      else if (e.state === 'search') { e.search.target.copy(_t1); if (e.search.phase === 'sweep') e.search.phase = 'go'; }
      else becomeSuspicious(e, W, _t1);
    }
  }
}

/** Noise event (alertNoise). */
export function hearNoise(e, W, pos, radius, d, direct = true) {
  const gun = radius >= T.hearing.gunshotRadius;
  _t2.copy(pos);
  const err = d * (gun ? 0.08 : 0.12);
  _t2.x += (Math.random() - 0.5) * err; _t2.z += (Math.random() - 0.5) * err;
  _t2.y = W.ground(_t2.x, _t2.z, pos.y - 1.5);
  if (e.state === 'combat') {
    if (!e.canSee) e.lastKnown.copy(_t2);
    return;
  }
  if (!gun) { becomeSuspicious(e, W, _t2); return; }
  e.alert = 1;
  if (e.state === 'search') { e.search.target.copy(_t2); e.search.phase = 'go'; return; }
  // close / in sight of the shot: treat as contact (cover, limited pushers); muffled far shots: investigate
  if (direct) enterCombat(e, W, 'ally', _t2);
  else becomeSuspicious(e, W, _t2);
}

// ---------------------------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------------------------
export function enterCombat(e, W, reason, knownPos) {
  if (!e.alive) return;
  if (knownPos) { e.lastKnown.copy(knownPos); e.hasLastKnown = true; }
  if (e.state === 'combat') return;
  leaveSearchEtc(e, W);
  e.state = 'combat';
  e.meter = 1;
  e.alert = 1;
  e.combatTime = 0;
  e.tactic = null;
  e.decisionTimer = rand(0.05, 0.3);
  e.lostTime = e.canSee ? 0 : 0.5;
  e.hadSight = e.canSee;
  e.nextShot = 0;
  e.burstLeft = 0;
  if (reason === 'spotted') e.reaction = rand(T.reaction.min, T.reaction.max);
  else if (reason === 'damage') e.reaction = rand(T.reaction.damagedMin, T.reaction.damagedMax);
  else e.reaction = rand(T.reaction.min, T.reaction.max);
  stopMove(e);
  if (reason !== 'ally') W.alertAllies?.(e);
}

function leaveSearchEtc(e, W) {
  e.search = null;
  e.sus = null;
}

export function becomeSuspicious(e, W, pos) {
  if (e.state === 'combat') return;
  if (e.state === 'search') { e.search.target.copy(pos); return; }
  if (e.state === 'suspicious' && e.sus) {
    e.sus.pos.copy(pos);
    if (e.sus.phase !== 'turn' && e.sus.phase !== 'go') { e.sus.phase = 'turn'; e.sus.t = 0.35; }
    return;
  }
  e.state = 'suspicious';
  e.sus = { pos: pos.clone(), phase: 'turn', t: rand(T.suspicious.turnMin, T.suspicious.turnMax), total: 0, scan: Math.random() * 6 };
  stopMove(e);
}

export function toSearch(e, W, pos) {
  endPush(e, W);
  releaseCover(e, W);
  e.state = 'search';
  e.sus = null;
  e.tactic = null;
  e.meter = Math.max(e.meter, 0.55);
  e.alert = 1;
  const target = pos.clone();
  if (e.type === 'guard' && dist2D(target, e.home) > T.combat.guardLeash) {
    // guards only sweep their own room: go to the leash edge toward the noise
    const d = dist2D(target, e.home);
    target.set(e.home.x + ((target.x - e.home.x) / d) * T.combat.guardLeash * 0.6, target.y, e.home.z + ((target.z - e.home.z) / d) * T.combat.guardLeash * 0.6);
    target.y = W.ground(target.x, target.z, e.home.y);
  }
  e.search = { phase: 'go', target, t: 0, sweepT: 0, lookT: 0, lookYaw: e.aimYaw, extra: T.search.extraPoints };
  stopMove(e);
}

export function returnToRoutine(e, W) {
  endPush(e, W);
  releaseCover(e, W);
  e.state = e.patrol.length ? 'patrol' : 'idle';
  e.search = null; e.sus = null; e.tactic = null;
  e.meter = 0;
  e.routine.waitT = 0; e.routine.shifting = false; e.routine.holdT = 0;
  if (e.patrol.length) {
    let best = 0, bd = Infinity;
    e.patrol.forEach((p, i) => { const d = dist2D(p, e.position); if (d < bd) { bd = d; best = i; } });
    e.wpIdx = best;
  }
  stopMove(e);
}

export function onDamaged(e, W, dir) {
  e.stagger = rand(T.staggerMin, T.staggerMax);
  e.suppressed = T.accuracy.suppressTime;
  e.sightTime = 0;
  e.burstLeft = 0;
  e.nextShot = Math.max(e.nextShot, 0.25);
  const P = W.pinfo;
  // a hit gives away the shooter's position
  if (P.ok) { e.lastKnown.copy(P.pos); e.hasLastKnown = true; }
  if (e.state !== 'combat') enterCombat(e, W, 'damage');
  else e.reaction = Math.max(e.reaction, rand(0.15, 0.3));
  // being shot in the open makes cover more attractive
  if (e.tactic === 'hold' || e.tactic === 'inCover') e.decisionTimer = Math.min(e.decisionTimer, 0.1);
}

function releaseCover(e, W) {
  if (e.cover) {
    if (W.coverReserve.get(e.cover.index) === e) W.coverReserve.delete(e.cover.index);
    e.cover = null;
  }
}
function endPush(e, W) {
  if (e.isPusher) { W.pushers.delete(e); e.isPusher = false; }
}
export function releaseAll(e, W) { endPush(e, W); releaseCover(e, W); }

// ---------------------------------------------------------------------------------------------
// cover
// ---------------------------------------------------------------------------------------------
export function findCover(e, W, excludeIndex = -1) {
  const cps = W.ctx.level?.coverPoints || [];
  if (!cps.length || !e.hasLastKnown) return null;
  const threat = e.lastKnown;
  const threatEye = _t1.set(threat.x, threat.y + 1.55, threat.z);
  const threatChest = _t2.set(threat.x, threat.y + 1.2, threat.z);
  const guard = e.type === 'guard';
  const cands = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (!cp || i === excludeIndex) continue;
    const owner = W.coverReserve.get(i);
    if (owner && owner !== e && owner.alive) continue;
    const de = dist2D(e.position, cp);
    if (de > T.combat.coverRadius) continue;
    if (guard && dist2D(e.home, cp) > T.combat.guardLeash) continue;
    if (Math.abs(cp.y - e.position.y) > 2.5) continue;
    const dtr = dist2D(cp, threat);
    if (dtr < T.combat.coverMinThreatDist) continue;
    let crowded = false;
    for (const o of W.list) if (o !== e && o.alive && dist2D(o.position, cp) < 1.3) { crowded = true; break; }
    if (crowded) continue;
    const myD = dist2D(e.position, threat);
    const score = de + Math.abs(dtr - 11) * 0.35 + (dtr < myD - 2 ? 2.5 : 0);
    cands.push({ i, cp, score });
  }
  cands.sort((a, b) => a.score - b.score);
  let fallback = null;
  for (let k = 0; k < Math.min(5, cands.length); k++) {
    const { i, cp } = cands[k];
    const low = _t3.set(cp.x, cp.y + 1.05, cp.z);
    if (W.los(low, threatEye)) continue;     // not hidden even when crouched
    const high = _t4.set(cp.x, cp.y + 1.6, cp.z);
    if (W.los(high, threatChest)) return { index: i, pos: cp.clone(), peek: 'stand' };
    // tall cover: look for a side step that opens the line
    let nx = threat.x - cp.x, nz = threat.z - cp.z;
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    for (const sgn of Math.random() < 0.5 ? [1, -1] : [-1, 1]) {
      const sp = new THREE.Vector3(cp.x - nz * 0.75 * sgn, cp.y, cp.z + nx * 0.75 * sgn);
      sp.y = W.ground(sp.x, sp.z, cp.y);
      if (!W.nav.clearWalk(cp, sp, 0.25)) continue;
      high.set(sp.x, sp.y + 1.6, sp.z);
      if (W.los(high, threatChest)) return { index: i, pos: cp.clone(), peek: 'side', peekPos: sp };
    }
    if (!fallback) fallback = { index: i, pos: cp.clone(), peek: 'none' };
  }
  return guard || Math.random() < 0.3 ? fallback : null;
}

function takeCover(e, W, c) {
  releaseCover(e, W);
  W.coverReserve.set(c.index, e);
  e.cover = c;
  e.tactic = 'toCover';
  e.coverPhase = 'hide';
  setMove(e, c.pos, T.move.run);
}

// ---------------------------------------------------------------------------------------------
// combat
// ---------------------------------------------------------------------------------------------
function decide(e, W) {
  const guard = e.type === 'guard';
  if (e.tactic === 'push') {
    if (e.canSee) { endPush(e, W); e.tactic = 'hold'; e.holdCrouch = false; stopMove(e); }
    return;
  }
  if (e.tactic === 'toCover' && !e.arrived && !e.pathFailed) return;
  if (e.tactic === 'toCover' && e.pathFailed) { releaseCover(e, W); e.tactic = null; }

  const maxPush = T.combat.maxPushers + (W.combatCount >= 6 ? 1 : 0);
  if (!guard && e.lostTime > T.combat.pushAfter && e.reloadT < 0 && W.pushers.size < maxPush && Math.random() < T.combat.pushChance) {
    releaseCover(e, W);
    W.pushers.add(e); e.isPusher = true;
    e.tactic = 'push';
    return;
  }
  if (e.tactic === 'inCover') {
    const compromised = e.coverPhase === 'hide' && e.canSee && e.visFrac >= 0.5;
    if ((compromised || Math.random() < T.combat.repositionChance) && W.coverBudget > 0) {
      W.coverBudget--;
      const c = findCover(e, W, e.cover?.index ?? -1);
      if (c) takeCover(e, W, c);
      else if (compromised) { releaseCover(e, W); e.tactic = 'hold'; e.holdCrouch = Math.random() < 0.5; }
    }
    return;
  }
  if (e.tactic === null || e.tactic === 'hold') {
    if (W.coverBudget > 0 && (e.tactic === null || Math.random() < 0.25)) {
      W.coverBudget--;
      const c = findCover(e, W);
      if (c) { takeCover(e, W, c); return; }
      if (e.tactic === null) { e.tactic = 'hold'; e.holdCrouch = Math.random() < T.combat.holdCrouchChance; }
    } else if (e.tactic === null) {
      e.decisionTimer = 0.05;   // wait for the cover budget next frame
    }
  }
}

function executeTactic(e, dt, W) {
  const sees = e.canSee;
  switch (e.tactic) {
    case 'toCover': {
      setMove(e, e.cover.pos, sees ? T.move.combat : T.move.run);
      e.wantCrouch = 0;
      if (e.arrived || dist2D(e.position, e.cover.pos) < 0.35) {
        e.tactic = 'inCover';
        e.coverPhase = sees && e.cover.peek === 'stand' ? 'peek' : 'hide';
        e.coverTimer = e.coverPhase === 'peek' ? rand(T.combat.peekMin, T.combat.peekMax) : rand(T.combat.hideMin, T.combat.hideMax) * 0.6;
      }
      break;
    }
    case 'inCover': {
      const c = e.cover;
      e.coverTimer -= dt;
      if (e.coverPhase === 'hide') {
        e.wantCrouch = c.peek === 'side' ? 0 : 1;
        if (dist2D(e.position, c.pos) > 0.3) setMove(e, c.pos, 1.8); else stopMove(e);
        if (e.reloadT >= 0) e.coverTimer = Math.max(e.coverTimer, 0.3);
        if (e.coverTimer <= 0 && c.peek !== 'none') { e.coverPhase = 'peek'; e.coverTimer = rand(T.combat.peekMin, T.combat.peekMax); }
      } else {
        e.wantCrouch = 0;
        if (c.peek === 'side') setMove(e, c.peekPos, 1.8); else stopMove(e);
        if (e.coverTimer <= 0 || e.reloadT >= 0) { e.coverPhase = 'hide'; e.coverTimer = rand(T.combat.hideMin, T.combat.hideMax); }
      }
      break;
    }
    case 'push': {
      setMove(e, e.lastKnown, T.move.combat * 0.75);
      e.wantCrouch = 0;
      break;
    }
    case 'hold': {
      e.wantCrouch = e.holdCrouch ? 1 : 0;
      if (e.type === 'guard' && dist2D(e.position, e.home) > T.combat.guardLeash) setMove(e, e.home, T.move.combat);
      else stopMove(e);
      break;
    }
    default:
      stopMove(e);
  }
}

function startReload(e, W) {
  if (e.reloadT >= 0) return;
  e.reloadT = 0;
  e.reloadDur = rand(T.fire.reloadMin, T.fire.reloadMax);
  e.reloadInPlayed = false;
  W.ctx.audio?.play?.('reload_out', { position: e.position.clone().setY(e.position.y + 1.1), volume: 0.6 });
}

function updateReload(e, dt, W) {
  if (e.reloadT < 0) return;
  e.reloadT += dt / e.reloadDur;
  if (e.reloadT > 0.76 && !e.reloadInPlayed) {
    e.reloadInPlayed = true;
    W.ctx.audio?.play?.('reload_in', { position: e.position.clone().setY(e.position.y + 1.1), volume: 0.6 });
  }
  if (e.reloadT >= 1) { e.reloadT = -1; e.mag = e.magSize; }
}

/** Aim error radius (m) at the target for the current situation. Exported for tests/tuning. */
export function aimError(dist, sightTime, opts = {}) {
  const A = T.accuracy;
  const settle = smooth01(sightTime / A.settleTime);
  let mul = lerp(A.initialMul, 1, settle);
  if (opts.selfMoving) mul *= A.selfMovingMul;
  mul *= 1 + A.targetSpeedMul * (opts.targetSpeed || 0);
  if (opts.suppressed) mul *= A.suppressedMul;
  return (A.baseError + A.errorPerMetre * dist) * mul;
}

function friendlyInLine(e, W, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const L2 = dx * dx + dy * dy + dz * dz || 1;
  for (const o of W.list) {
    if (o === e || !o.alive) continue;
    const c = o.hit.center;
    const t = ((c.x - from.x) * dx + (c.y - from.y) * dy + (c.z - from.z) * dz) / L2;
    if (t <= 0 || t >= 1) continue;
    const px = from.x + dx * t - c.x, py = from.y + dy * t - c.y, pz = from.z + dz * t - c.z;
    if (px * px + py * py + pz * pz < 0.5 * 0.5) return true;
  }
  return false;
}

function fireShot(e, W) {
  const P = W.pinfo, ctx = W.ctx;
  const muzzle = e.ch.getMuzzle(new THREE.Vector3());
  const target = new THREE.Vector3(P.pos.x, P.pos.y + P.height * rand(0.5, 0.8), P.pos.z);
  if (friendlyInLine(e, W, muzzle, target)) { e.nextShot = 0.35; return false; }
  const d = muzzle.distanceTo(target);
  const err = aimError(d, e.sightTime, { selfMoving: e.anim.speed > 0.5, targetSpeed: P.speed, suppressed: e.suppressed > 0 });
  const fwd = _t1.subVectors(target, muzzle).normalize();
  const right = _t2.crossVectors(fwd, _up).normalize();
  const up2 = _t3.crossVectors(right, fwd);
  const r = err * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
  target.addScaledVector(right, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r * T.accuracy.verticalScale);
  // shoot from the muzzle unless it is masked (weapon behind a corner while the eyes see): then from the eye line
  let origin = muzzle;
  if (!W.los(muzzle, P.chest)) origin = e.eye.clone().addScaledVector(fwd, 0.3);
  const dir = new THREE.Vector3().subVectors(target, origin).normalize();
  try {
    ctx.combat?.fire?.({ origin: origin.clone(), dir, from: 'enemy', damage: T.fire.damage, shooter: e, maxDist: T.fire.maxRange * 2 });
  } catch (err) {
    if (!fireShot.warned) { fireShot.warned = true; console.warn('[enemies] combat.fire threw', err); }
  }
  ctx.fx?.muzzleFlash?.(muzzle.clone(), dir.clone());
  ctx.fx?.shell?.(e.ch.getEject(new THREE.Vector3()), right.clone().add(_up).normalize());
  ctx.audio?.play?.('shot_enemy', { position: muzzle.clone() });
  e.anim.addRecoil(e.weaponType === 'rifle' ? 0.8 : 1.1);
  e.mag--;
  e.shotsFired++;
  W.onEnemyShot?.(e);
  return true;
}

function tryFire(e, dt, W) {
  e.nextShot -= dt;
  const P = W.pinfo;
  if (!P.ok || !P.alive || !e.canSee) return;
  if (e.reaction > 0 || e.reloadT >= 0 || e.stagger > 0) return;
  if (e.anim.raise < 0.85) return;
  if (e.wantYaw != null && Math.abs(wrapAngle(e.aimYaw - e.wantYaw)) > T.accuracy.aimTolerance) return;
  if (e.distToPlayer > T.fire.maxRange) return;
  if (e.tactic === 'inCover' && e.coverPhase === 'hide' && e.visFrac < 1) return;
  if (e.nextShot > 0) return;
  if (e.burstLeft <= 0) e.burstLeft = randInt(T.fire.burstMin, T.fire.burstMax);
  if (fireShot(e, W)) {
    e.burstLeft--;
    e.nextShot = e.burstLeft > 0 ? rand(T.fire.gapMin, T.fire.gapMax) : rand(T.fire.pauseMin, T.fire.pauseMax);
  }
  if (e.mag <= 0) startReload(e, W);
}

function combatUpdate(e, dt, W) {
  const P = W.pinfo;
  e.combatTime += dt;
  if (e.canSee) {
    if (e.lostTime > T.reaction.reacquireGap && e.hadSight) e.reaction = Math.max(e.reaction, rand(T.reaction.reacquireMin, T.reaction.reacquireMax));
    e.lostTime = 0;
    e.hadSight = true;
    if (e.reaction <= 0) e.sightTime += dt;   // aim only starts settling once they actually aim
  } else {
    e.lostTime += dt;
    e.sightTime = Math.max(0, e.sightTime - dt * T.accuracy.sightDecay);
  }
  if (e.reaction > 0) e.reaction -= dt;
  updateReload(e, dt, W);

  if (!P.ok || !P.alive) {
    e.wantRaise = 0.6;
    e.wantCrouch = 0;
    stopMove(e);
    if (e.hasLastKnown) faceToward(e, _t4.copy(e.lastKnown).setY(e.lastKnown.y + 1.2));
    return;
  }

  const tgt = e.canSee ? P.chest : _t4.set(e.lastKnown.x, e.lastKnown.y + 1.25, e.lastKnown.z);
  faceToward(e, tgt);
  e.wantRaise = e.canSee || e.lostTime < 2.5 ? 1 : 0.75;
  if (!e.canSee && e.moving && e.tactic !== 'push' && e.lostTime > 0.8) e.wantYaw = null;   // look where you run

  if (!e.canSee && e.lostTime > 1.5 && e.mag < e.magSize * 0.5) startReload(e, W);

  e.decisionTimer -= dt;
  if (e.decisionTimer <= 0) {
    e.decisionTimer = rand(T.combat.decisionMin, T.combat.decisionMax);
    decide(e, W);
  }
  executeTactic(e, dt, W);
  tryFire(e, dt, W);

  if (e.tactic === 'push' && (e.arrived || dist2D(e.position, e.lastKnown) < 1.2) && !e.canSee) { toSearch(e, W, e.lastKnown); return; }
  const giveUp = T.combat.loseSightToSearch * (e.type === 'guard' ? 1.5 : 1) * (0.8 + 0.4 * e.temper);
  if (e.lostTime > giveUp) toSearch(e, W, e.lastKnown);
}

// ---------------------------------------------------------------------------------------------
// non-combat states
// ---------------------------------------------------------------------------------------------
function lookAround(e, dt, baseYaw, wide = 1.1) {
  const r = e.routine;
  r.lookT -= dt;
  if (r.lookT <= 0) {
    r.lookT = rand(2, 5);
    r.lookOff = Math.random() < 0.3 ? 0 : rand(-wide, wide);
    r.bodyTurn = Math.abs(r.lookOff) > 0.7 && Math.random() < 0.5;
  }
  e.wantYaw = baseYaw + (r.bodyTurn ? r.lookOff * 0.7 : 0);
  e.lookOffset = r.bodyTurn ? r.lookOff * 0.3 : r.lookOff;
}

function idleUpdate(e, dt, W) {
  const r = e.routine;
  e.wantRaise = 0; e.wantCrouch = 0;
  if (r.shifting) {
    setMove(e, r.shiftTarget, T.move.walk * 0.7);
    if (e.arrived) { r.shifting = false; r.holdT = rand(3, 7); stopMove(e); }
    return;
  }
  if (r.holdT > 0) { r.holdT -= dt; lookAround(e, dt, e.homeYaw); return; }
  if (dist2D(e.position, e.home) > 0.6) {
    setMove(e, e.home, T.move.walk);
    if (e.arrived) stopMove(e);
    return;
  }
  stopMove(e);
  lookAround(e, dt, e.homeYaw);
  r.shiftT -= dt;
  if (r.shiftT <= 0) {
    r.shiftT = rand(9, 18);
    const p = randomReachableNear(W.nav, e.home, 1.5);
    if (p) { p.y = W.ground(p.x, p.z, e.home.y); r.shiftTarget.copy(p); r.shifting = true; }
  }
}

function patrolUpdate(e, dt, W) {
  const r = e.routine;
  e.wantRaise = 0; e.wantCrouch = 0;
  const wp = e.patrol[e.wpIdx % e.patrol.length];
  if (r.waitT > 0) {
    stopMove(e);
    r.waitT -= dt;
    lookAround(e, dt, r.waitYaw, 1.2);
    if (r.waitT <= 0) e.wpIdx = (e.wpIdx + 1) % e.patrol.length;
    return;
  }
  setMove(e, wp, T.move.walk);
  e.lookOffset = Math.sin(W.time * 0.4 + e.index) * 0.35;
  if (e.arrived) {
    r.waitT = rand(1.5, 4);
    r.lookT = 0;
    const next = e.patrol[(e.wpIdx + 1) % e.patrol.length];
    r.waitYaw = next && dist2D(next, wp) > 0.5 ? yawTo(wp, next) : e.aimYaw;
    if (e.pathFailed) e.wpIdx = (e.wpIdx + 1) % e.patrol.length;
  }
}

function suspiciousUpdate(e, dt, W) {
  const s = e.sus;
  s.total += dt;
  e.wantRaise = 0.45; e.wantCrouch = 0;
  if (s.phase === 'turn') {
    stopMove(e);
    faceToward(e, _t1.copy(s.pos).setY(s.pos.y + 1.4));
    s.t -= dt;
    if (s.t <= 0) {
      if (e.type === 'guard' && dist2D(s.pos, e.home) > T.suspicious.guardLeash) { s.phase = 'look'; s.t = rand(T.suspicious.lookMin, T.suspicious.lookMax); s.base = e.wantYaw; }
      else s.phase = 'go';
    }
  } else if (s.phase === 'go') {
    setMove(e, s.pos, T.move.cautious);
    e.lookOffset = Math.sin(W.time * 0.9 + s.scan) * 0.5;
    if (e.arrived || dist2D(e.position, s.pos) < 1.5) {
      s.phase = 'look'; s.t = rand(T.suspicious.lookMin, T.suspicious.lookMax); s.base = e.aimYaw;
      stopMove(e);
    }
  } else {
    stopMove(e);
    s.t -= dt;
    e.wantYaw = s.base + Math.sin(W.time * 0.7 + s.scan) * 1.1;
    e.lookOffset = Math.sin(W.time * 1.3 + s.scan) * 0.4;
    if (s.t <= 0) { returnToRoutine(e, W); return; }
  }
  if (s.total > T.suspicious.timeout) returnToRoutine(e, W);
}

function searchUpdate(e, dt, W) {
  const s = e.search;
  s.t += dt;
  e.wantRaise = 0.85; e.wantCrouch = 0;
  updateReload(e, dt, W);
  if (e.mag < e.magSize * 0.5) startReload(e, W);
  if (s.phase === 'go') {
    setMove(e, s.target, T.move.search);
    e.lookOffset = Math.sin(W.time * 1.1 + e.index) * 0.45;
    if (e.arrived || dist2D(e.position, s.target) < 1.2) {
      s.phase = 'sweep'; s.sweepT = rand(T.search.sweepMin, T.search.sweepMax); s.lookT = 0;
      stopMove(e);
    }
  } else {
    stopMove(e);
    s.sweepT -= dt; s.lookT -= dt;
    if (s.lookT <= 0) {
      s.lookT = rand(1.1, 2.0);
      // bias the sweep toward where the player was heading
      const v = e.lastKnownVel;
      s.lookYaw = Math.random() < 0.4 && v.lengthSq() > 0.5 ? Math.atan2(v.x, v.z) + rand(-0.5, 0.5) : e.aimYaw + rand(-2.2, 2.2);
    }
    e.wantYaw = s.lookYaw;
    e.lookOffset = Math.sin(W.time * 1.4 + e.index) * 0.3;
    if (s.sweepT <= 0) {
      if (s.extra > 0 && e.type !== 'guard' && W.nav.nodes.length) {
        s.extra--;
        const near = W.nav.nearestNodes(s.target, 6).filter((i) => dist2D(W.nav.nodes[i], s.target) > 2.5 && dist2D(W.nav.nodes[i], s.target) < 10);
        if (near.length) { s.target.copy(W.nav.nodes[near[(Math.random() * near.length) | 0]]); s.phase = 'go'; }
        else { returnToRoutine(e, W); return; }
      } else { returnToRoutine(e, W); return; }
    }
  }
  if (s.t > T.search.giveUp) returnToRoutine(e, W);
}

// ---------------------------------------------------------------------------------------------
// main per-frame update
// ---------------------------------------------------------------------------------------------
export function updateEnemyAI(e, dt, W) {
  e.wantYaw = null;
  e.wantPitch = 0;
  e.lookOffset = 0;
  if (e.stagger > 0) e.stagger -= dt;
  if (e.suppressed > 0) e.suppressed -= dt;
  if (e.alert > 0 && e.state !== 'combat') e.alert = Math.max(0, e.alert - dt / T.search.alertDecay);

  perceive(e, dt, W);

  switch (e.state) {
    case 'idle': idleUpdate(e, dt, W); break;
    case 'patrol': if (e.patrol.length) patrolUpdate(e, dt, W); else { e.state = 'idle'; idleUpdate(e, dt, W); } break;
    case 'suspicious': suspiciousUpdate(e, dt, W); break;
    case 'search': searchUpdate(e, dt, W); break;
    case 'combat': combatUpdate(e, dt, W); break;
  }

  updateMovement(e, dt, W);

  // orientation
  const sp = Math.hypot(e.velocity.x, e.velocity.z);
  const wantYaw = e.wantYaw != null ? e.wantYaw : sp > 0.3 ? Math.atan2(e.velocity.x, e.velocity.z) : e.aimYaw;
  const rate = (e.state === 'combat' ? 7 : e.state === 'search' ? 4.5 : 3.0) * (e.stagger > 0 ? 0.3 : 1);
  e.aimYaw = wrapAngle(e.aimYaw + clamp(wrapAngle(wantYaw - e.aimYaw), -rate * dt, rate * dt));
  e.aimPitch += clamp((e.wantPitch || 0) - e.aimPitch, -2.5 * dt, 2.5 * dt);
  e.lookOff += (e.lookOffset - e.lookOff) * (1 - Math.exp(-3 * dt));
  e.lookYaw = wrapAngle(e.aimYaw + e.lookOff);
  e.lookPitch = e.aimPitch * 0.8;
}
