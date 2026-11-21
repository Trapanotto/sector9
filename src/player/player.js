// Player controller (workstream C): grounded capsule movement on the core collision API (mover.js), chest-mounted
// bodycam camera (bob, roll lag, step smoothing, lean, crouch), raw 1:1 mouse on the 0.022°/count scale with
// bodycam free aim (aim.js), flashlight, footstep events, damage reactions and death camera.
// Keeps the ctx.player interface of CONTRACT.md §4.
import * as THREE from 'three';
import { U } from '../render/materials.js';
import { MOVE, createBody, moveBody } from './mover.js';
import { FREE_AIM_DEG, freeAimStep, freeAimClamp } from './aim.js';

const DEG = Math.PI / 180;
// settings (persisted through ctx.settings; defaults only fill missing keys)
export const C_SETTINGS = { freeAim: 'standard', aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'hold', leanMode: 'hold', headBob: 1 };

export function createPlayer(ctx) {
  const T = { chest: 1.44, chestCrouch: 0.93, lean: 0.28, leanRoll: 9 * DEG, stride: 0.74, strideSprint: 0.95 };
  const body = createBody();
  const pos = body.pos, vel = body.vel;
  const mouse = { dx: 0, dy: 0 };
  const camDelta = { yaw: 0, pitch: 0 };
  const right = new THREE.Vector3(), up = new THREE.Vector3();
  const hit = { hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '', box: -1, zone: -1, owner: null };
  const o3 = { x: 0, y: 0, z: 0 }, d3 = { x: 0, y: 0, z: 0 };
  const stepEvt = { surface: 'concrete', x: 0, y: 0, z: 0, speed: 0, crouched: false, sprint: false, foot: 0 };
  const dmgEvt = { amount: 0, part: '', health: 0, from: null };
  const st = {
    camY: T.chest, smY: 0, bob: 0, bobAmp: 0, lastStep: 0, foot: 0, leanV: 0, leanT: 0, leanToggle: 0, crouchHeld: false,
    sprintToggle: false, rollV: 0, turnRate: 0, lastYaw: 0, lastPitch: 0, frozen: false,
    flinchY: 0, flinchP: 0, flinchR: 0, flinchV: 0, hurt: 0, deathT: 0, deathRoll: 1, deathSide: 1, zone: -1,
  };

  const p = {
    id: 'player', order: ctx.ORDER.player,
    pos, vel, yaw: 0, pitch: 0, roll: 0,
    health: 100, dead: false, flashlight: !!ctx.settings.data.flashlightDefault, crouched: false, moving: 0,
    eye: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1),
    // C extras (read by weapon / fx / audio)
    aimOff: { yaw: 0, pitch: 0 }, ads: false, sprinting: false, lean: 0, bobPhase: 0, bobAmp: 0, turnRate: 0,
    surface: 'concrete', mouseDX: 0, mouseDY: 0, freeAimRad: 0,
    teleport(xyz, yaw = p.yaw, pitch = 0, freeze = false) {
      pos.x = xyz[0]; pos.z = xyz[2];
      const g = ctx.world.groundHeight(pos.x, pos.z, xyz[1] + 0.1, 0.2);
      pos.y = g > -Infinity ? g : xyz[1];
      st.camY = xyz[1] - pos.y > 0.5 ? xyz[1] - pos.y : (p.crouched ? T.chestCrouch : T.chest);
      st.smY = pos.y;
      p.yaw = yaw; p.pitch = pitch; vel.x = vel.y = vel.z = 0; st.frozen = freeze;
      p.aimOff.yaw = p.aimOff.pitch = 0;
      st.lastYaw = p.yaw; st.lastPitch = p.pitch;
      body.st.grounded = true;
      placeCamera(0);
    },
    kind: 'player', team: 'police',
    raycast(o, dir, maxT, part) {
      const h = p.crouched ? MOVE.crouchHeight : MOVE.height;
      const ox = o.x - pos.x, oz = o.z - pos.z, a = dir.x * dir.x + dir.z * dir.z;
      if (a < 1e-8) return -1;
      const b = 2 * (ox * dir.x + oz * dir.z), c = ox * ox + oz * oz - MOVE.radius * MOVE.radius, disc = b * b - 4 * a * c;
      if (disc < 0) return -1;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < 0 || t > maxT) return -1;
      const y = o.y + dir.y * t - pos.y;
      if (y < 0 || y > h) return -1;
      part.name = y > h - 0.25 ? 'head' : y > h * 0.5 ? 'torso' : 'legs';
      return t;
    },
    onHit(res) {
      if (p.dead || ctx.bench || ctx.debug.god) return;
      // duty vest: torso hits reduced; head doubled
      const k = res.part === 'head' ? 2 : res.part === 'torso' ? 0.65 : 0.85;
      const dmg = res.damage * k;
      p.health -= dmg;
      // flinch: camera kicked away from the shot, brief desaturation / vignette (composite hooks)
      const sx = res.dir ? res.dir.x : 0, sz = res.dir ? res.dir.z : 0;
      const side = Math.sign((sx * Math.cos(p.yaw) - sz * Math.sin(p.yaw)) || 1);
      st.flinchV += 1;
      st.flinchY += side * (0.025 + Math.random() * 0.025);
      st.flinchP += 0.02 + Math.random() * 0.03;
      st.flinchR += side * 0.05;
      st.hurt = Math.min(1.2, st.hurt + 0.35 + dmg / 60);
      dmgEvt.amount = dmg; dmgEvt.part = res.part; dmgEvt.health = Math.max(0, p.health); dmgEvt.from = res.origin;
      ctx.events.emit('player:damage', dmgEvt);
      if (p.health <= 0) die();
    },
    load() {
      const s = ctx.settings.data;
      for (const [k, v] of Object.entries(C_SETTINGS)) if (s[k] === undefined) s[k] = v;
    },
    init() {
      ctx.combat.register(p);
      p.reset();
    },
    reset() {
      const s = ctx.layout.playerSpawn;
      p.health = 100; p.dead = false; p.crouched = false; body.height = MOVE.height;
      st.deathT = 0; st.hurt = 0; st.flinchY = st.flinchP = st.flinchR = 0; st.leanV = st.leanT = 0; st.leanToggle = 0;
      p.teleport(s.pos, s.yaw, 0, false);
    },
    update(dt) {
      const input = ctx.input, set = ctx.settings.data;
      const playing = ctx.state === 'playing' && !st.frozen && !p.dead;
      // external yaw/pitch writes (autopilot, teleport, director): snap the free-aim state
      if (p.yaw !== st.lastYaw || p.pitch !== st.lastPitch) { p.aimOff.yaw = p.aimOff.pitch = 0; }
      input.takeMouse(mouse);
      p.mouseDX = 0; p.mouseDY = 0;
      // free-aim zone (gun leads inside it); smaller in ADS, none while sprinting
      const zoneT = (FREE_AIM_DEG[set.freeAim] ?? FREE_AIM_DEG.standard) * DEG * (p.ads ? 0.45 : 1) * (p.sprinting ? 0.3 : 1);
      // the zone eases to its new size (entering ADS pulls the view onto the gun smoothly, no snap)
      st.zone = st.zone < 0 ? zoneT : st.zone + (zoneT - st.zone) * Math.min(1, dt * 8);
      const zone = zoneT < 1e-6 && st.zone < 2e-4 ? 0 : st.zone;
      p.freeAimRad = zone;
      let dYaw = 0, dPitch = 0;
      if (playing && input.locked) {
        // raw counts × sensitivity × 0.022° (the common "Source" scale): sensitivity 2 ≈ 26 cm/360° at 800 dpi
        const k = (set.sensitivity ?? 1) * 0.022 * DEG;
        dYaw = -mouse.dx * k;
        dPitch = -mouse.dy * k * (set.invertY ? -1 : 1);
        p.mouseDX = dYaw; p.mouseDY = dPitch;
      }
      freeAimStep(p.aimOff, dYaw, dPitch, zone, dt, camDelta);
      p.yaw += camDelta.yaw;
      p.pitch += camDelta.pitch;
      const pl = 1.42;
      if (p.pitch > pl) { p.pitch = pl; } else if (p.pitch < -pl) { p.pitch = -pl; }
      // keep the gun's absolute pitch inside the limits too
      if (p.pitch + p.aimOff.pitch > 1.5) p.aimOff.pitch = 1.5 - p.pitch;
      if (p.pitch + p.aimOff.pitch < -1.5) p.aimOff.pitch = -1.5 - p.pitch;
      // ---- actions
      let mx = 0, mz = 0;
      if (playing) {
        if (input.held('forward')) mz -= 1; if (input.held('back')) mz += 1;
        if (input.held('left')) mx -= 1; if (input.held('right')) mx += 1;
        // crouch (toggle | hold); standing up only where there is head room
        let wantCrouch = p.crouched;
        if (set.crouchMode === 'hold') wantCrouch = input.held('crouch');
        else if (input.hit('crouch')) wantCrouch = !p.crouched;
        if (wantCrouch !== p.crouched) {
          if (wantCrouch) { p.crouched = true; body.height = MOVE.crouchHeight; }
          else if (!ctx.world.collision.blocked(pos.x, pos.y, pos.z, MOVE.radius * 0.95, MOVE.height)) { p.crouched = false; body.height = MOVE.height; }
        }
        if (input.hit('flashlight')) { p.flashlight = !p.flashlight; ctx.events.emit('player:flashlight', { on: p.flashlight }); }
        if (input.hit('use')) ctx.world.doors.use(pos.x, pos.y, pos.z, -Math.sin(p.yaw), -Math.cos(p.yaw));
        // lean (hold | toggle)
        let lt = 0;
        if (set.leanMode === 'toggle') {
          if (input.hit('leanLeft')) st.leanToggle = st.leanToggle === -1 ? 0 : -1;
          if (input.hit('leanRight')) st.leanToggle = st.leanToggle === 1 ? 0 : 1;
          lt = st.leanToggle;
        } else lt = (input.held('leanRight') ? 1 : 0) - (input.held('leanLeft') ? 1 : 0);
        st.leanT = lt;
        // sprint (hold | toggle): forward only, not crouched / aiming
        if (set.sprintMode === 'toggle') { if (input.hit('sprint')) st.sprintToggle = !st.sprintToggle; if (mz >= 0) st.sprintToggle = false; }
        const wantSprint = (set.sprintMode === 'toggle' ? st.sprintToggle : input.held('sprint')) && mz < 0 && !p.crouched && !p.ads;
        p.sprinting = wantSprint;
      } else { p.sprinting = false; st.leanT = 0; }
      if (p.sprinting) st.leanT = 0;
      // ---- movement
      const len = Math.hypot(mx, mz);
      let speed = p.crouched ? MOVE.crouch : input.held('walk') ? MOVE.slow : p.sprinting ? MOVE.sprint : MOVE.walk;
      if (p.ads) speed = Math.min(speed, MOVE.ads);
      if (mz > 0) speed *= MOVE.back + (1 - MOVE.back) * (Math.abs(mx) / (len || 1)) * 0.5;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      let wx = 0, wz = 0;
      if (len > 0) { const ix = mx / len, iz = mz / len; wx = (ix * cy + iz * sy) * speed; wz = (-ix * sy + iz * cy) * speed; }
      const py = pos.y;
      moveBody(body, ctx.world.collision, wx, wz, dt, st.frozen);
      if (pos.y < -40) p.reset();
      p.moving = Math.hypot(vel.x, vel.z);
      // smoothed vertical (stairs / steps): up quickly but not instantly, down a little faster
      const dy = pos.y - py;
      if (Math.abs(dy) > 0.6) st.smY = pos.y; // teleport / fall
      st.smY += (pos.y - st.smY) * Math.min(1, dt * (pos.y > st.smY ? 14 : 20));
      // ---- head bob phase (distance based) + footsteps
      if (body.st.grounded && p.moving > 0.15) {
        const stride = p.sprinting ? T.strideSprint : T.stride * (p.crouched ? 0.75 : 1);
        st.bob += (p.moving * dt) / stride;
        const stepIdx = Math.floor(st.bob);
        if (stepIdx !== st.lastStep) { st.lastStep = stepIdx; footstep(); }
      }
      const ampT = body.st.grounded ? Math.min(1.3, p.moving / MOVE.walk) : 0;
      st.bobAmp += (ampT - st.bobAmp) * Math.min(1, dt * 6);
      p.bobPhase = st.bob; p.bobAmp = st.bobAmp;
      // lean (collision-limited) and crouch camera
      st.leanV += (st.leanT - st.leanV) * Math.min(1, dt * 7);
      p.lean = st.leanV;
      // hurt / flinch decay
      st.hurt = Math.max(0, st.hurt - dt * 0.9);
      const fd = Math.exp(-dt * 9);
      st.flinchY *= fd; st.flinchP *= fd; st.flinchR *= fd;
      placeCamera(dt);
      postEffects(dt);
      // flashlight (chest/shoulder mounted, follows the body/camera)
      U.uFlashPos.value.copy(p.eye).addScaledVector(right, 0.13).addScaledVector(up, 0.05);
      U.uFlashDir.value.copy(p.forward);
      if (p.flashlight) U.uFlashColor.value.set(7.5, 7.0, 6.2); else U.uFlashColor.value.set(0, 0, 0);
      st.lastYaw = p.yaw; st.lastPitch = p.pitch;
    },
  };
  void freeAimClamp;

  function footstep() {
    o3.x = pos.x; o3.y = pos.y + 0.3; o3.z = pos.z; d3.x = 0; d3.y = -1; d3.z = 0;
    ctx.world.worldHit(o3, d3, 0.8, hit);
    p.surface = hit.hit && hit.surface ? hit.surface : 'concrete';
    st.foot ^= 1;
    stepEvt.surface = p.surface; stepEvt.x = pos.x; stepEvt.y = pos.y; stepEvt.z = pos.z;
    stepEvt.speed = p.moving; stepEvt.crouched = p.crouched; stepEvt.sprint = p.sprinting; stepEvt.foot = st.foot;
    ctx.events.emit('c:footstep', stepEvt);
  }

  function die() {
    p.dead = true; p.health = 0; st.deathT = 0;
    st.deathSide = Math.random() < 0.5 ? -1 : 1;
    ctx.events.emit('player:death', {});
    ctx.setState('dead');
  }

  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  function placeCamera(dt) {
    const cam = ctx.render.camera;
    const target = p.crouched ? T.chestCrouch : T.chest;
    st.camY += (target - st.camY) * Math.min(1, dt * 9);
    const bobK = (ctx.settings.data.headBob ?? 1);
    const a = st.bobAmp * bobK, ph = st.bob * Math.PI;
    const spr = p.sprinting ? 1.5 : 1;
    // chest camera motion: two vertical dips per stride, one lateral sway, roll + pitch nod lagging the step
    const by = -Math.abs(Math.sin(ph)) * 0.024 * a * spr + 0.012 * a;
    const bx = Math.sin(ph) * 0.016 * a * spr;
    const bRoll = Math.sin(ph - 0.5) * 1.1 * DEG * a * spr;
    const bPitch = Math.cos(2 * ph - 0.7) * 0.45 * DEG * a * spr;
    const bYaw = Math.sin(ph - 0.3) * 0.5 * DEG * a * spr;
    // turning: torso roll lags the yaw rate (bodycam sways into turns)
    const yr = dt > 0 ? (p.yaw - st.lastYaw) / dt : 0;
    st.turnRate += (Math.max(-4, Math.min(4, yr)) - st.turnRate) * Math.min(1, dt * 5);
    p.turnRate = st.turnRate;
    const turnRoll = -st.turnRate * 0.012;
    // strafing roll
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    const side = vel.x * cy - vel.z * sy;
    st.rollV += ((-side * 0.007) - st.rollV) * Math.min(1, dt * 4);
    // lean: sideways shift (limited by walls) + roll
    let lean = st.leanV;
    if (Math.abs(lean) > 0.01) {
      o3.x = pos.x; o3.y = st.smY + st.camY; o3.z = pos.z;
      const s = Math.sign(lean);
      d3.x = cy * s; d3.y = 0; d3.z = -sy * s;
      const maxL = T.lean + 0.18;
      if (ctx.world.worldHit(o3, d3, maxL, hit)) lean = s * Math.min(Math.abs(lean), Math.max(0, hit.t - 0.18) / T.lean);
    }
    const lx = lean * T.lean;
    // death: drop to the floor and tilt over
    let dyDeath = 0, dRoll = 0, dPitch = 0;
    if (p.dead) {
      st.deathT += dt;
      const k = Math.min(1, st.deathT / 0.9), ease = k * k * (3 - 2 * k);
      dyDeath = -(st.camY - 0.16) * ease;
      dRoll = st.deathSide * 1.25 * ease;
      dPitch = -0.35 * ease + 0.25 * Math.sin(Math.min(1, st.deathT / 0.5) * Math.PI) * (1 - k);
    }
    const ox = cy * (bx + lx), oz = -sy * (bx + lx);
    cam.position.set(pos.x + ox, st.smY + st.camY + by + dyDeath, pos.z + oz);
    p.roll = st.rollV + turnRoll + bRoll + lean * T.leanRoll + st.flinchR + dRoll;
    e.set(p.pitch + bPitch + st.flinchP + dPitch, p.yaw + bYaw + st.flinchY, p.roll);
    cam.quaternion.setFromEuler(e);
    cam.rotation.copy(e);
    cam.updateMatrixWorld();
    p.eye.copy(cam.position);
    p.forward.set(0, 0, -1).applyQuaternion(cam.quaternion);
    right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    up.set(0, 1, 0).applyQuaternion(cam.quaternion);
  }

  // damage look via the composite's own hooks: vignette strength (+ desaturation if B exposes uDesat); no red
  function postEffects() {
    const cu = ctx.render.composite?.uniforms;
    if (!cu) return;
    const h = Math.min(1, st.hurt), low = p.dead ? 1 : Math.max(0, (40 - p.health) / 40) * 0.5;
    const k = Math.max(h, low);
    cu.uVignette.value = 1 + k * 1.1;
    if (cu.uDesat) cu.uDesat.value = Math.min(1, k * 0.85);
    else cu.uTint.value.set(-0.02 * k, -0.02 * k, -0.02 * k);
  }
  return p;
}
