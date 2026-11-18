import * as THREE from 'three';
import { TUNING as T } from './tuning.js';
import { createCharacter, randomLook, createHitShapes, updateHitShapes, raySphere, rayCapsule } from './character.js';
import { Animator } from './animator.js';
import { Ragdoll } from './ragdoll.js';
import { createNav } from './nav.js';
import { updateEnemyAI, enterCombat, hearNoise, onDamaged, releaseAll, returnToRoutine } from './ai.js';

// Hostiles module (contract: createEnemies(ctx) -> { list, aliveCount, update, reset, raycast, alertNoise }).
// Reads sibling modules from ctx lazily; every cross-module call is optional-chained.

const rand = (a, b) => a + Math.random() * (b - a);

/** Spawn yaw uses the player/camera convention (yaw 0 looks toward -Z); our heading uses forward = (sin h, 0, cos h). */
const spawnYawToHeading = (yaw) => (yaw ?? 0) + Math.PI;

export function createEnemies(ctx) {
  const list = [];
  let nav = null;
  let navLevel = null;

  const pinfo = {
    ok: false, alive: false, pos: new THREE.Vector3(), chest: new THREE.Vector3(), head: new THREE.Vector3(),
    vel: new THREE.Vector3(), speed: 0, height: 1.8, crouched: false, noise: 0, look: new THREE.Vector3(0, 0, -1),
  };

  const timers = [];
  const W = {
    ctx, nav: null, time: 0, frame: 0, list, pinfo,
    pathBudget: 0, coverBudget: 0, pushers: new Set(), coverReserve: new Map(), combatCount: 0,
    los(a, b) {
      const c = ctx.combat;
      if (!c?.lineOfSight) return false;
      try { return c.lineOfSight(a, b); } catch { return false; }
    },
    ground(x, z, fallback = 0) {
      const g = ctx.level?.groundHeight?.(x, z);
      return Number.isFinite(g) ? g : fallback;
    },
    schedule(delay, fn) { timers.push({ t: W.time + delay, fn }); },
    alertAllies(src) {
      W.schedule(rand(T.ally.shoutDelayMin, T.ally.shoutDelayMax), () => {
        if (src.alive) ctx.audio?.play?.('shout', { position: src.eye.clone() });
      });
      for (const o of list) {
        if (o === src || !o.alive || o.state === 'combat') continue;
        const d = o.position.distanceTo(src.position);
        if (d > T.ally.radius && !(d < 40 && W.los(o.eye, src.eye))) continue;
        W.schedule(rand(T.ally.delayMin, T.ally.delayMax) + d * 0.02, () => {
          if (!o.alive || o.state === 'combat') return;
          const p = src.lastKnown.clone();
          p.x += (Math.random() - 0.5) * 2 * T.ally.reportError; p.z += (Math.random() - 0.5) * 2 * T.ally.reportError;
          p.y = W.ground(p.x, p.z, src.lastKnown.y);
          enterCombat(o, W, 'ally', p);
        });
      }
    },
    // gunfire is loud: idle colleagues within earshot join the fight (no shout chain)
    onEnemyShot(src) {
      for (const o of list) {
        if (o === src || !o.alive || o.state === 'combat' || o.pendingJoin) continue;
        const d = o.position.distanceTo(src.position);
        if (d > 22) continue;
        o.pendingJoin = true;
        W.schedule(rand(0.4, 1.0) + d * 0.03, () => {
          o.pendingJoin = false;
          if (!o.alive || o.state === 'combat') return;
          enterCombat(o, W, 'ally', src.lastKnown.clone());
        });
      }
    },
    groundFn: null,
  };
  W.groundFn = (x, z) => W.ground(x, z, NaN);

  function getNav() {
    const lvl = ctx.level;
    if (!nav || navLevel !== lvl) { nav = createNav(lvl, T.move.radius); navLevel = lvl; W.nav = nav; }
    return nav;
  }

  function makeEnemy(spawn, index) {
    const weaponType = Math.random() < (spawn.type === 'guard' ? 0.5 : 0.35) ? 'rifle' : 'pistol';
    const ch = createCharacter({ weaponType, renderer: ctx.renderer, look: randomLook(index + ((Math.random() * 5) | 0)) });
    const anim = new Animator(ch);
    const heading = spawnYawToHeading(spawn.yaw);
    const home = (spawn.position || new THREE.Vector3()).clone();
    home.y = W.ground(home.x, home.z, home.y);
    const patrol = (spawn.patrol || []).filter(Boolean).map((p) => { const q = p.clone(); q.y = W.ground(q.x, q.z, q.y); return q; });
    const type = spawn.type || (patrol.length ? 'patrol' : 'guard');
    const magSize = weaponType === 'rifle' ? T.fire.magRifle : T.fire.magPistol;
    const e = {
      index, spawn, type, weaponType, ch, anim,
      position: home.clone(), velocity: new THREE.Vector3(),
      alive: true, state: patrol.length && type !== 'guard' ? 'patrol' : 'idle', health: T.health,
      home, homeYaw: heading, patrol: type === 'guard' ? [] : patrol, wpIdx: 0,
      temper: Math.random(),
      // orientation
      aimYaw: heading, aimPitch: 0, lookYaw: heading, lookPitch: 0, lookOff: 0, lookOffset: 0,
      wantYaw: null, wantPitch: 0, wantRaise: 0, wantCrouch: 0,
      // perception
      eye: new THREE.Vector3(), meter: 0, canSee: false, visFrac: 0, senseTimer: rand(0, T.vision.tickMax), senseAcc: 0,
      lastSeenTime: -1e9, lastKnown: home.clone(), lastKnownVel: new THREE.Vector3(), hasLastKnown: false, distToPlayer: Infinity,
      alert: 0, pendingJoin: false,
      // combat
      reaction: 0, sightTime: 0, lostTime: 0, hadSight: false, combatTime: 0,
      burstLeft: 0, nextShot: 0, mag: magSize, magSize, reloadT: -1, reloadDur: 2.5, reloadInPlayed: false,
      suppressed: 0, stagger: 0, shotsFired: 0,
      tactic: null, cover: null, coverPhase: 'hide', coverTimer: 0, decisionTimer: 0, holdCrouch: false, isPusher: false,
      // sub states
      sus: null, search: null,
      routine: { lookT: 0, lookOff: 0, bodyTurn: false, shiftT: rand(6, 14), shifting: false, shiftTarget: new THREE.Vector3(), holdT: 0, waitT: 0, waitYaw: heading },
      // navigation
      moving: false, moveTarget: new THREE.Vector3(), moveSpeed: 0, path: [], pathIdx: 0, needPath: false, arrived: true, pathFailed: false,
      repathCooldown: 0, stuckT: 0, stuckRef: home.clone(), stuckCount: 0,
      // body
      hit: createHitShapes(), ragdoll: null,
      takeDamage(amount, part, dir, point) { damage(e, amount, part, dir, point); },
    };
    anim.teleport(e.position, heading);
    ctx.scene?.add(ch.root);
    animate(e, 1 / 60);
    return e;
  }

  function animate(e, dt) {
    e.ch.root.position.copy(e.position);
    e.anim.update(dt, {
      aimYaw: e.aimYaw, aimPitch: e.aimPitch, lookYaw: e.lookYaw, lookPitch: e.lookPitch,
      raise: e.wantRaise, crouch: e.wantCrouch, reload: e.reloadT,
      strafe: e.state === 'combat' || e.state === 'search', ground: W.groundFn,
    });
    e.ch.getEye(e.eye);
    updateHitShapes(e.ch, e.hit);
  }

  function damage(e, amount, part, dir, point) {
    if (!e.alive) return;
    const d = dir && dir.lengthSq?.() > 1e-8 ? dir.clone().normalize() : new THREE.Vector3(0, 0, -1);
    let dmg = Number.isFinite(amount) ? amount : 50;
    if (part === 'head') dmg = Math.max(dmg, e.health);
    else if (part === 'limb') dmg *= T.limbMultiplier;
    else { dmg *= T.torsoMultiplier; if (Math.random() < T.torsoVitalChance) dmg *= 2; }
    e.health -= dmg;
    if (e.health <= 0) { die(e, part || 'torso', d, point); return; }
    e.anim.addFlinch(d, part === 'limb' ? 0.6 : 1.0);
    onDamaged(e, W, d);
  }

  function die(e, part, dir, point) {
    e.alive = false;
    e.health = 0;
    e.state = 'dead';
    releaseAll(e, W);
    e.moving = false;
    api.aliveCount = list.filter((x) => x.alive).length;
    const fwd = new THREE.Vector3(Math.sin(e.anim.lowerYaw), 0, Math.cos(e.anim.lowerYaw));
    const rd = new Ragdoll(e.ch, { ground: W.groundFn, colliders: ctx.level?.colliders || [] });
    rd.onImpact = (k) => ctx.audio?.play?.('body_fall', { position: e.position.clone(), volume: 0.5 + 0.5 * k });
    rd.onSettle = (p) => { e.position.copy(p); ctx.fx?.bloodPool?.(p.clone()); };
    rd.start({ dir, part, point, bodyVel: e.anim.vel, forward: fwd, scene: ctx.scene });
    e.ragdoll = rd;
    ctx.audio?.play?.('death', { position: e.eye.clone() });
    ctx.game?.onEnemyDeath?.(e);
  }

  function clear() {
    for (const e of list) {
      releaseAll(e, W);
      e.ch.dispose();
    }
    list.length = 0;
    timers.length = 0;
    W.pushers.clear();
    W.coverReserve.clear();
  }

  function spawnAll() {
    getNav();
    const spawns = ctx.level?.enemySpawns || [];
    spawns.forEach((s, i) => { if (s?.position) list.push(makeEnemy(s, i)); });
    api.aliveCount = list.length;
  }

  function update(dt) {
    if (!(dt > 0)) return;
    getNav();
    W.time += dt;
    W.frame++;
    W.pathBudget = T.budget.pathsPerFrame;
    W.coverBudget = T.budget.coverPerFrame;

    // player snapshot (tolerates a missing / half-initialised player)
    const p = ctx.player;
    pinfo.ok = !!(p && p.position);
    if (pinfo.ok) {
      pinfo.alive = p.alive !== false;
      pinfo.pos.copy(p.position);
      pinfo.height = Number.isFinite(p.height) ? p.height : 1.8;
      pinfo.chest.set(p.position.x, p.position.y + pinfo.height * 0.72, p.position.z);
      if (p.eye) pinfo.head.copy(p.eye); else pinfo.head.set(p.position.x, p.position.y + pinfo.height * 0.93, p.position.z);
      if (p.velocity) pinfo.vel.copy(p.velocity); else pinfo.vel.set(0, 0, 0);
      pinfo.speed = Math.hypot(pinfo.vel.x, pinfo.vel.z);
      pinfo.crouched = pinfo.height < 1.5;
      pinfo.noise = Number.isFinite(p.noise) ? p.noise : 0;
      const yaw = p.yaw ?? 0, pitch = p.pitch ?? 0;
      pinfo.look.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    } else pinfo.alive = false;

    // scheduled events
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].t <= W.time) { const t = timers[i]; timers.splice(i, 1); t.fn(); }
    }

    let c = 0;
    for (const e of list) if (e.alive && e.state === 'combat') c++;
    W.combatCount = c;

    const n = list.length;
    const start = n ? W.frame % n : 0;   // rotate who gets the path/cover budget first
    for (let k = 0; k < n; k++) {
      const e = list[(start + k) % n];
      if (e.alive) {
        updateEnemyAI(e, dt, W);
        animate(e, dt);
      } else if (e.ragdoll) {
        e.ragdoll.update(dt);
      }
    }
  }

  const _o = new THREE.Vector3(), _d = new THREE.Vector3();
  function raycast(origin, dir, maxDist = 200) {
    if (!origin || !dir) return null;
    _o.copy(origin);
    _d.copy(dir);
    if (_d.lengthSq() < 1e-12) return null;
    _d.normalize();
    let best = null, bestT = maxDist;
    for (const e of list) {
      if (!e.alive) continue;
      const h = e.hit;
      if (raySphere(_o, _d, h.center, h.radius, bestT) < 0) continue;
      let t = raySphere(_o, _d, h.head.c, h.head.r, bestT);
      if (t >= 0 && t <= bestT) { bestT = t; best = { enemy: e, part: 'head', distance: t }; }
      t = rayCapsule(_o, _d, h.torso.a, h.torso.b, h.torso.r, bestT);
      if (t >= 0 && t < bestT) { bestT = t; best = { enemy: e, part: 'torso', distance: t }; }
      for (const l of h.limbs) {
        t = rayCapsule(_o, _d, l.a, l.b, l.r, bestT);
        if (t >= 0 && t < bestT) { bestT = t; best = { enemy: e, part: 'limb', distance: t }; }
      }
    }
    if (best) best.point = _o.clone().addScaledVector(_d, best.distance);
    return best;
  }

  function alertNoise(position, radius) {
    if (!position || !(radius > 0)) return;
    const P = pinfo;
    const gun = radius >= T.hearing.gunshotRadius;
    for (const e of list) {
      if (!e.alive) continue;
      const d = e.eye.distanceTo(position);
      if (d > radius) continue;
      const close = d <= Math.min(radius * 0.35, 10);
      const los = close || W.los(position, e.eye);
      if (!los && d > radius * T.hearing.wallMul) continue;
      if (gun && P.ok) {
        // shot at / near: if the player's aim passes close to this enemy, it is suppressed for a moment
        _d.subVectors(e.hit.center, P.head);
        const dd = _d.length();
        if (dd > 0.1 && dd < 60) {
          const off = _d.cross(P.look).length();   // perpendicular miss distance (P.look is unit)
          if (off < 1.2 && e.hit.center.clone().sub(P.head).dot(P.look) > 0) e.suppressed = T.accuracy.suppressTime;
        }
      }
      hearNoise(e, W, position, radius, d, los);
    }
  }

  function reset() {
    clear();
    W.time = 0;
    spawnAll();
  }

  const api = {
    list,
    aliveCount: 0,
    update,
    reset,
    raycast,
    alertNoise,
    tuning: T,
    // debugging helpers
    _world: W,
    _returnAll() { for (const e of list) if (e.alive) returnToRoutine(e, W); },
  };

  spawnAll();
  return api;
}
