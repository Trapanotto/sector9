import * as THREE from 'three';
import * as T from './tuning.js';
import { Spring, Follower, clamp, lerp, smooth01, damp } from './springs.js';
import { createViewmodel } from './viewmodel.js';
import { createWeapon } from './weapon.js';
import { collideCircle, boxGround, rayBoxes, blocked } from './collision.js';

// Bodycam player.
//
// Conventions (three.js, camera.rotation.order = 'YXZ'):
//   yaw   = rotation.y, 0 looks toward -Z, positive turns LEFT  -> mouse dx > 0 decreases yaw (turn right)
//   pitch = rotation.x, positive looks UP                       -> mouse dy > 0 decreases pitch (look down)
//   roll  = rotation.z, positive rolls the top of the image to the LEFT
//   forward(yaw) = (-sin yaw, 0, -cos yaw), right(yaw) = (cos yaw, 0, -sin yaw)
//
// Aim model: the world aim direction (where the barrel points) = camera body + aim offset (aimX, aimY), and it
// moves EXACTLY with the mouse (1:1, no smoothing, no latency). Free aim only decides how each bit of mouse motion
// is split between the aim offset (gun moves inside the frame) and the camera body (view turns), using an
// elliptical soft zone: near the centre all motion moves the gun, toward the rim more and more turns the body,
// fast motion turns the body earlier. The rendered camera follows the body through a velocity-feed-forward
// follower (no lag at a constant turn rate, no overshoot); that is the only smoothing in the chain.

const EMPTY = [];
const DOWN = new THREE.Vector3(0, -1, 0);

// Key bindings: both sets are always active (WASD side and arrow-key side).
export const KEYS = {
  fwd: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft', 'ControlRight', 'Numpad0'],
  leanL: ['KeyQ', 'Delete'],
  leanR: ['KeyE', 'PageDown'],
  reload: ['KeyR', 'Enter', 'NumpadEnter', 'Numpad1'],
  light: ['KeyF', 'End', 'NumpadDecimal'],
};

export const DEFAULT_SETTINGS = {
  sens: T.SENS_DEFAULT,          // sensitivity (Source-style scale: 0.022 deg per count per unit)
  adsSens: T.ADS_SENS_DEFAULT,   // multiplier while aimed
  invertY: false,
  freeAim: 'standard',           // 'aus' | 'gering' | 'standard' | 'stark'
  shake: 1,                      // camera shake + head bob amount 0..1
  fov: T.FOV_HIP,                // hip field of view (vertical, degrees); ADS = fov - FOV_ADS_DELTA
  aimMode: 'hold',               // 'hold' | 'toggle'
  crouchMode: 'toggle',          // 'hold' | 'toggle'
};

export function createPlayer(ctx) {
  const camera = ctx.camera;
  const vm = createViewmodel();
  camera.add(vm.root);
  const settings = Object.assign({}, DEFAULT_SETTINGS);

  // ---------------------------------------------------------------- springs (fixed 600 Hz steps)
  const camYawF = new Follower(T.CAM_FOLLOW_W), camPitchF = new Follower(T.CAM_FOLLOW_W);
  const kickPitch = new Spring(22, 0.5), kickYaw = new Spring(22, 0.5), kickRoll = new Spring(18, 0.45);
  const jolt = new Spring(14, 0.45);                 // camera vertical jolt (steps, landing, hits)
  const joltX = new Spring(12, 0.5);                 // camera lateral jolt (hits)
  const recRx = new Spring(18, 0.42), recRy = new Spring(18, 0.5), recRz = new Spring(16, 0.45);
  const recBack = new Spring(20, 0.5), recUp = new Spring(20, 0.5);
  const inertX = new Spring(10, 0.6), inertY = new Spring(10, 0.6);  // visual gun lag (position only)
  const leanS = new Spring(T.LEAN_RATE, 1);
  const springs = [kickPitch, kickYaw, kickRoll, jolt, joltX, recRx, recRy, recRz, recBack, recUp, inertX, inertY, leanS];

  const weapon = createWeapon(ctx, vm, { jolt: (v) => { recUp.impulse(v); recRx.impulse(v * 2); } });

  // ---------------------------------------------------------------- state
  let bodyYaw = 0, bodyPitch = 0, aimX = 0, aimY = 0;
  let vy = 0, grounded = true, feetVis = 0;
  let crouchAmt = 0, crouchToggle = false, aimToggle = false;
  let adsLin = 0, ads = 0, lowerAmt = 0, sprintAmt = 0;
  let moveF = 0, stepPhase = 0, lastStep = 0, exertion = 0, breathPhase = 0, time = 0;
  let sprintBlock = 0, shotQueue = 0, shotBufferT = 0, reloadBuffer = 0;
  let sprinting = false;
  let fov = T.FOV_HIP;
  let lastMouseRad = 0, mouseSpeed = 0;
  // death
  let deathT = 0, deathReported = false, deathLanded = false, deathSide = 1;
  const deathStart = { y: 0, yaw: 0, pitch: 0, roll: 0, x: 0, z: 0, ground: 0 };
  // last rendered camera angles
  let camYawR = 0, camPitchR = 0, camRollR = 0;

  // scratch (no per-frame allocations)
  const eAim = new THREE.Euler(0, 0, 0, 'YXZ');
  const eExtra = new THREE.Euler(0, 0, 0, 'YXZ');
  const qAim = new THREE.Quaternion(), qRel = new THREE.Quaternion(), qExtra = new THREE.Quaternion();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const muzzleW = new THREE.Vector3(), dirW = new THREE.Vector3(), originW = new THREE.Vector3();
  const camFwd = new THREE.Vector3(), probe = new THREE.Vector3(), probeDir = new THREE.Vector3();
  const pivot = new THREE.Vector3(), off = new THREE.Vector3();
  const nrm = { x: 0, z: 0 };

  const player = {
    tuning: T,                  // dev access (pose arrays are mutable for live tuning)
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    height: T.HEIGHT_STAND,
    eye: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    alive: true,
    health: T.MAX_HEALTH,
    get ammo() { return weapon.ammo; },
    get reserve() { return weapon.reserve; },
    magSize: T.MAG_SIZE,
    isAiming: false,
    noise: 0,
    // extras
    aimDir: new THREE.Vector3(0, 0, -1),   // where the aim points (world, before weapon sway / recoil)
    get reloading() { return weapon.reloading; },
    get reloadCount() { return weapon.reloadCount; },
    get flashlight() { return weapon.flashlight; },
    get crouching() { return crouchAmt > 0.5; },
    get sprinting() { return sprinting; },
    viewmodel: vm,
    weapon,
    settings,
    keys: KEYS,
    /** debug / tests: free-aim state */
    debugAim() { return { bodyYaw, bodyPitch, aimX, aimY, camYaw: camYawF.x, camPitch: camPitchF.x, camYawR, camPitchR, ads }; },
    /** turn instantly (spawn, teleports, tests) */
    setLook(yaw, pitch = 0) { bodyYaw = yaw; bodyPitch = pitch; aimX = aimY = 0; mouseSpeed = 0; camYawF.reset(yaw); camPitchF.reset(pitch); for (const s of springs) s.reset(0); },
    update, takeDamage, reset,
  };

  const level = () => ctx.level;
  const colliders = () => ctx.level?.colliders || EMPTY;
  const levelGround = (x, z) => {
    const g = ctx.level?.groundHeight?.(x, z);
    return Number.isFinite(g) ? g : 0;
  };
  /** floor under (x, z) for feet at y: level floor or the top of low clutter we can step onto */
  const groundAt = (x, z, y) => {
    const g = levelGround(x, z);
    const b = boxGround(colliders(), x, z, 0.1, y - T.STEP_DOWN - 0.01, y + T.STEP_BOX + 0.01);
    return b > g ? b : g;
  };
  const anyDown = (codes) => { const i = ctx.input; for (const c of codes) if (i.down(c)) return true; return false; };
  const anyPressed = (codes) => { const i = ctx.input; for (const c of codes) if (i.pressed(c)) return true; return false; };

  // ================================================================ reset
  function reset() {
    const sp = level()?.playerSpawn;
    if (sp?.position) player.position.copy(sp.position); else player.position.set(0, 0, 0);
    player.position.y = levelGround(player.position.x, player.position.z);
    bodyYaw = sp?.yaw || 0; bodyPitch = 0; aimX = 0; aimY = 0;
    player.velocity.set(0, 0, 0); vy = 0; grounded = true; feetVis = player.position.y;
    crouchAmt = 0; crouchToggle = false; aimToggle = false; adsLin = ads = lowerAmt = sprintAmt = 0;
    moveF = 0; stepPhase = 0; lastStep = 0; exertion = 0; sprintBlock = 0; shotQueue = 0; shotBufferT = 0; reloadBuffer = 0;
    sprinting = false;
    for (const s of springs) s.reset(0);
    camYawF.reset(bodyYaw); camPitchF.reset(0);
    player.height = T.HEIGHT_STAND;
    player.health = T.MAX_HEALTH; player.alive = true; player.noise = 0; player.isAiming = false;
    deathT = 0; deathReported = false; deathLanded = false;
    weapon.reset();
    weapon.flashlight = false;
    vm.setFlashlight(false, 0);
    vm.root.visible = true;
    poseCamera(0);
    poseViewmodel(0);
    camera.updateMatrixWorld(true);
    ctx.pipeline?.setDead?.(false);
  }

  // ================================================================ look / free aim
  function zone() {
    const Z = T.FREE_AIM[settings.freeAim] || T.FREE_AIM.standard;
    return [lerp(Z.x, Z.xAds, ads), lerp(Z.y, Z.yAds, ads)];
  }

  /** Mouse motion (rad) -> world aim 1:1, split between aim offset and body. */
  function look(dYaw, dPitch, dt) {
    const [zx, zy] = zone();
    const mag = Math.hypot(dYaw, dPitch);
    lastMouseRad = mag;
    // visual weapon lag (translation only, so the barrel still points exactly at the aim)
    inertX.impulse(dYaw * T.INERTIA_POS);
    inertY.impulse(-dPitch * T.INERTIA_POS);
    if (zx < 1e-5 || zy < 1e-5) {
      bodyYaw += aimX + dYaw; aimX = 0;
      bodyPitch += aimY + dPitch; aimY = 0;
      return;
    }
    if (mag > 0) {
      const flick = T.FLICK_MAX * smooth01((mouseSpeed - T.FLICK_LO) / (T.FLICK_HI - T.FLICK_LO));
      // sub-steps of <= 0.1 deg so the split is the same whatever the frame rate
      const n = Math.min(96, Math.max(1, Math.ceil(mag / 0.0018)));
      const sx = dYaw / n, sy = dPitch / n;
      const ex = sx / zx, ey = sy / zy, el = Math.hypot(ex, ey);
      const rc = 1 - Math.exp(-T.RECENTER_MOUSE * mag / n);   // camera catches up while the mouse moves
      for (let i = 0; i < n; i++) {
        const qx = aimX / zx, qy = aimY / zy, r = Math.hypot(qx, qy);
        const ux = r > 1e-4 ? qx / r : ex / el, uy = r > 1e-4 ? qy / r : ey / el;
        const radial = ex * ux + ey * uy;
        let bx = 0, by = 0;
        if (radial > 0) {
          const b = Math.max(smooth01((r - T.ZONE_INNER) / (1 - T.ZONE_INNER)), flick);
          bx = radial * b * ux * zx; by = radial * b * uy * zy;
        }
        bodyYaw += bx; bodyPitch += by;
        aimX += sx - bx; aimY += sy - by;
        const tx = aimX * rc, ty = aimY * rc * 0.8;
        bodyYaw += tx; aimX -= tx; bodyPitch += ty; aimY -= ty;
      }
    }
  }

  /** Keeps the aim offset inside the zone, recentres the body, applies pitch limits. World aim is unchanged. */
  function settleAim(dt) {
    const [zx, zy] = zone();
    if (zx < 1e-5 || zy < 1e-5) { bodyYaw += aimX; bodyPitch += aimY; aimX = aimY = 0; }
    else {
      const r = Math.hypot(aimX / zx, aimY / zy);
      if (r > 1) {   // zone shrank (ADS) or recoil climbed past the rim: the overflow turns the body
        const k = 1 - 1 / r;
        bodyYaw += aimX * k; aimX -= aimX * k;
        bodyPitch += aimY * k; aimY -= aimY * k;
      }
      const hs = Math.hypot(player.velocity.x, player.velocity.z);
      const rate = (T.RECENTER_MOVE * hs + T.RECENTER_ADS * ads + T.RECENTER_SPRINT * sprintAmt) * dt;
      const f = 1 - Math.exp(-rate);
      const tx = aimX * f, ty = aimY * f * 0.8;
      bodyYaw += tx; aimX -= tx;
      bodyPitch += ty; aimY -= ty;
    }
    if (bodyPitch > T.PITCH_LIMIT) { aimY += bodyPitch - T.PITCH_LIMIT; bodyPitch = T.PITCH_LIMIT; }
    if (bodyPitch < -T.PITCH_LIMIT) { aimY += bodyPitch + T.PITCH_LIMIT; bodyPitch = -T.PITCH_LIMIT; }
    const wp = bodyPitch + aimY;
    if (wp > T.AIM_PITCH_LIMIT) aimY = T.AIM_PITCH_LIMIT - bodyPitch;
    if (wp < -T.AIM_PITCH_LIMIT) aimY = -T.AIM_PITCH_LIMIT - bodyPitch;
    // keep yaw bounded (long sessions spinning in one direction), shifting everything that holds a yaw
    if (Math.abs(bodyYaw) > 64 * Math.PI) {
      const s = -Math.round(bodyYaw / (2 * Math.PI)) * 2 * Math.PI;
      bodyYaw += s; camYawF.shift(s);
    }
  }

  // ================================================================ movement
  function move(dt, active) {
    const input = ctx.input;
    const pos = player.position, vel = player.velocity;
    const k = (codes) => active && anyDown(codes);
    const fwdIn = (k(KEYS.fwd) ? 1 : 0) - (k(KEYS.back) ? 1 : 0);
    const strIn = (k(KEYS.right) ? 1 : 0) - (k(KEYS.left) ? 1 : 0);

    // crouch: hold or toggle (setting), every crouch key behaves the same
    const crouchKey = k(KEYS.crouch);
    if (settings.crouchMode === 'hold') crouchToggle = false;
    else if (active && anyPressed(KEYS.crouch)) crouchToggle = !crouchToggle;
    const holdCrouch = settings.crouchMode === 'hold' && crouchKey;
    const shift = k(KEYS.sprint);
    const aimHeld = active && (settings.aimMode === 'toggle' ? aimToggle : input.mouse.right);
    const wantSprint = shift && fwdIn > 0 && sprintBlock <= 0 && !holdCrouch && !aimHeld;
    if (wantSprint && crouchToggle) crouchToggle = false;
    let wantCrouch = (crouchToggle || holdCrouch) ? 1 : 0;
    const boxes = colliders();
    if (!wantCrouch && crouchAmt > 0.01 &&
        blocked(boxes, pos.x, pos.z, T.RADIUS * 0.95, pos.y + T.HEIGHT_CROUCH + 0.02, pos.y + T.HEIGHT_STAND)) {
      wantCrouch = 1; // ceiling above: stay down
    }
    crouchAmt += (wantCrouch - crouchAmt) * damp(T.CROUCH_RATE, dt);
    player.height = lerp(T.HEIGHT_STAND, T.HEIGHT_CROUCH, crouchAmt);
    sprinting = wantSprint && crouchAmt < 0.5;
    sprintAmt += ((sprinting ? 1 : 0) - sprintAmt) * damp(5, dt);

    // wish velocity relative to the camera body heading (WASD + arrows combined never exceed 1)
    const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
    const sIn = strIn * (fwdIn === 0 ? T.STRAFE_MUL : 1);
    let wx = -sy * fwdIn + cy * sIn, wz = -cy * fwdIn - sy * sIn;
    const wl = Math.hypot(wx, wz);
    let speed = sprinting ? T.SPRINT_SPEED : crouchAmt > 0.5 ? T.CROUCH_SPEED : ads > 0.5 ? T.ADS_SPEED : T.WALK_SPEED;
    if (fwdIn < 0) speed *= T.BACK_MUL;
    if (wl > 0) { const s = speed * Math.min(1, wl) / wl; wx *= s; wz *= s; }
    let rate = T.FRICTION;
    if (wl > 0) rate = sprinting ? T.SPRINT_ACCEL : (wx * vel.x + wz * vel.z < 0 ? T.TURN_ACCEL : T.ACCEL);
    const a = damp(grounded ? rate : rate * 0.15, dt);
    vel.x += (wx - vel.x) * a;
    vel.z += (wz - vel.z) * a;
    if (wl === 0 && Math.hypot(vel.x, vel.z) < 0.02) { vel.x = 0; vel.z = 0; }

    // horizontal: circle against the colliders in sub-steps, sliding along contact normals. Low boxes (top within
    // STEP_BOX of the feet) are not walls but steps (see groundAt).
    const y0 = pos.y + T.STEP_BOX + 0.01, y1 = pos.y + player.height;
    collideCircle(pos, T.RADIUS, y0, y1, boxes, null);
    const travel = Math.hypot(vel.x, vel.z) * dt;
    const n = Math.min(8, Math.max(1, Math.ceil(travel / (T.RADIUS * 0.5))));
    for (let i = 0; i < n; i++) {
      const ox = pos.x, oz = pos.z;
      pos.x += vel.x * dt / n; pos.z += vel.z * dt / n;
      if (collideCircle(pos, T.RADIUS, y0, y1, boxes, nrm)) {
        const l = Math.hypot(nrm.x, nrm.z);
        if (l > 1e-6) {
          const nx = nrm.x / l, nz = nrm.z / l, vn = vel.x * nx + vel.z * nz;
          if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
        }
      }
      // a level floor rise higher than a step acts like a wall: keep the axis that still works
      if (levelGround(pos.x, pos.z) - pos.y > T.STEP_UP) {
        const nx = pos.x, nz = pos.z;
        pos.x = nx; pos.z = oz;
        if (levelGround(pos.x, pos.z) - pos.y > T.STEP_UP) {
          pos.x = ox; pos.z = nz; vel.x = 0;
          if (levelGround(pos.x, pos.z) - pos.y > T.STEP_UP) { pos.z = oz; vel.z = 0; }
        } else vel.z = 0;
      }
    }
    const bounds = level()?.bounds;
    if (bounds) {
      let o = pos.x;
      pos.x = clamp(pos.x, bounds.min.x + T.RADIUS, bounds.max.x - T.RADIUS);
      if (pos.x !== o) vel.x = 0;
      o = pos.z;
      pos.z = clamp(pos.z, bounds.min.z + T.RADIUS, bounds.max.z - T.RADIUS);
      if (pos.z !== o) vel.z = 0;
    }

    // vertical: floor (level + steppable clutter), smooth step-up via feetVis, gravity otherwise
    const g = groundAt(pos.x, pos.z, pos.y);
    if (pos.y > g + 1e-3) {
      if (grounded && pos.y - g <= T.STEP_DOWN) { pos.y = g; vy = 0; }
      else {
        grounded = false;
        vy -= T.GRAVITY * dt;
        pos.y += vy * dt;
        if (pos.y <= g) { land(-vy); pos.y = g; vy = 0; grounded = true; }
      }
    } else {
      if (!grounded) land(-vy);
      pos.y = g; vy = 0; grounded = true;
    }
    player.velocity.y = vy;
    if (Math.abs(pos.y - feetVis) > 1.0) feetVis = pos.y;
    else feetVis += (pos.y - feetVis) * damp(grounded ? 14 : 40, dt);

    // lean (Q/E or Delete/PageDown) limited by walls on each side; critically damped spring, always returns
    const leanIn = active && !sprinting ? (k(KEYS.leanR) ? 1 : 0) - (k(KEYS.leanL) ? 1 : 0) : 0;
    const camH = lerp(T.CAM_STAND, T.CAM_CROUCH, crouchAmt);
    probe.set(pos.x, feetVis + camH, pos.z);
    probeDir.set(cy, 0, -sy);
    const reach = T.LEAN_DIST + T.LEAN_MARGIN;
    const limR = clamp((rayBoxes(probe, probeDir, reach, 0, boxes) - T.LEAN_MARGIN) / T.LEAN_DIST, 0, 1);
    probeDir.negate();
    const limL = clamp((rayBoxes(probe, probeDir, reach, 0, boxes) - T.LEAN_MARGIN) / T.LEAN_DIST, 0, 1);
    leanS.target = leanIn > 0 ? leanIn * limR : leanIn * limL;
    leanS.update(dt);
    if (leanS.x > limR) { leanS.x = limR; leanS.v = Math.min(0, leanS.v); }
    if (leanS.x < -limL) { leanS.x = -limL; leanS.v = Math.max(0, leanS.v); }
  }

  function land(speed) {
    if (speed < T.LAND_MIN_SPEED) return;
    jolt.impulse(-speed * 0.28);
    kickPitch.impulse(-speed * 0.12);
    recUp.impulse(-speed * 0.12);
    ctx.audio?.play?.('land', { volume: clamp(speed / 6, 0.3, 1) });
    ctx.pipeline?.addTrauma?.(clamp(speed * 0.05, 0.05, 0.4) * settings.shake);
    player.noise = Math.max(player.noise, clamp(speed / 6, 0.3, 0.8));
  }

  // ================================================================ footsteps / bob state
  function stepCycle(dt) {
    const vel = player.velocity;
    const hs = Math.hypot(vel.x, vel.z);
    moveF += (clamp(hs / T.WALK_SPEED, 0, 2.1) - moveF) * damp(6, dt);
    const stepLen = lerp(T.STEP_LEN_WALK, T.STEP_LEN_SPRINT, sprintAmt) * lerp(1, 0.72, crouchAmt);
    if (grounded) stepPhase += hs / stepLen * Math.PI * dt;
    const idx = Math.floor(stepPhase / Math.PI);
    if (idx !== lastStep) {
      lastStep = idx;
      if (grounded && hs > 0.4) footstep(hs);
    }
    exertion = clamp(exertion + (sprinting ? dt * 0.22 : -dt * 0.07), 0, 1);
    breathPhase += dt * Math.PI * 2 * (T.BREATH_RATE + exertion * 0.35);
  }

  function footstep(hs) {
    let surface = 'concrete';
    const w = ctx.combat?.worldHit;
    if (w) {
      vA.set(player.position.x, player.position.y + 0.3, player.position.z);
      const h = w(vA, DOWN, 0.8);
      if (h?.object) surface = ctx.level?.surfaceOf?.(h.object) || 'concrete';
    }
    const vol = sprinting ? 0.85 : crouchAmt > 0.5 ? 0.25 : 0.5;
    ctx.audio?.play?.(surface === 'metal' ? 'step_metal' : 'step_concrete', { volume: vol, pitch: 0.92 + Math.random() * 0.16 });
    jolt.impulse(-lerp(T.STEP_JOLT_WALK, T.STEP_JOLT_SPRINT, sprintAmt) * (1 - 0.5 * crouchAmt));
    player.noise = Math.max(player.noise, sprinting ? 0.6 : crouchAmt > 0.5 ? 0.08 : 0.3 * Math.min(1, hs / T.WALK_SPEED));
  }

  // ================================================================ camera pose
  // bob values shared with the viewmodel
  let bobS = 0, bobAs = 0, bobA = 0, bobX = 0, bobY = 0, bobRoll = 0;

  function poseCamera(dt) {
    if (settings.freeAim === 'aus') { camYawF.reset(bodyYaw); camPitchF.reset(bodyPitch); }   // conventional
    else {
      const w = lerp(T.CAM_FOLLOW_W, T.CAM_FOLLOW_W_ADS, ads);
      camYawF.omega = w; camPitchF.omega = w;
      camYawF.target = bodyYaw; camPitchF.target = bodyPitch;
      camYawF.update(dt); camPitchF.update(dt);
      // never let the camera swing past the body (overshoot after a hard stop fights the player)
      for (const [F, tgt] of [[camYawF, bodyYaw], [camPitchF, bodyPitch]]) {
        const ahead = (F.x - tgt) * Math.sign(F.v);
        if (ahead > T.CAM_OVERSHOOT_MAX) { F.x = F._x = tgt + Math.sign(F.v) * T.CAM_OVERSHOOT_MAX; F.v *= 0.2; }
      }
      const lim = T.CAM_LAG_MAX;
      if (camYawF.x - bodyYaw > lim) { camYawF.x = camYawF._x = bodyYaw + lim; camYawF.v = 0; }
      if (camYawF.x - bodyYaw < -lim) { camYawF.x = camYawF._x = bodyYaw - lim; camYawF.v = 0; }
      if (camPitchF.x - bodyPitch > lim) { camPitchF.x = camPitchF._x = bodyPitch + lim; camPitchF.v = 0; }
      if (camPitchF.x - bodyPitch < -lim) { camPitchF.x = camPitchF._x = bodyPitch - lim; camPitchF.v = 0; }
    }
    kickPitch.update(dt); kickYaw.update(dt); kickRoll.update(dt); jolt.update(dt); joltX.update(dt);
    const sh = clamp(settings.shake, 0, 1.5);

    // step-synchronised bob (one step per PI of phase); |sin| gives the cusp of each footfall
    bobS = Math.sin(stepPhase);
    bobAs = Math.abs(bobS) - 0.637;
    bobA = Math.min(moveF, 1.6);
    const sp = sprintAmt, cr = 1 - 0.45 * crouchAmt, ad = 1 - 0.45 * ads;
    bobY = bobAs * lerp(T.BOB_V_WALK, T.BOB_V_SPRINT, sp) * bobA * cr * ad * sh;
    bobX = bobS * lerp(T.BOB_X_WALK, T.BOB_X_SPRINT, sp) * bobA * cr * ad * sh;
    bobRoll = bobS * lerp(T.BOB_ROLL_WALK, T.BOB_ROLL_SPRINT, sp) * bobA * ad * sh;
    const bobPitch = bobAs * lerp(T.BOB_PITCH_WALK, T.BOB_PITCH_SPRINT, sp) * bobA * ad * sh;
    const bobYaw = bobS * lerp(T.BOB_YAW_WALK, T.BOB_YAW_SPRINT, sp) * bobA * ad * sh;

    // breathing (idle stronger, faster after sprinting)
    const bAmp = lerp(1, 1.9, exertion) * (1 - 0.6 * Math.min(moveF, 1)) * sh;
    const br = Math.sin(breathPhase);
    const breathPitch = br * 0.0035 * bAmp;
    const breathY = br * 0.003 * bAmp;

    const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
    const vRight = player.velocity.x * cy - player.velocity.z * sy;
    const lean = leanS.x;

    camYawR = camYawF.x + (kickYaw.x + bobYaw) * sh;
    camPitchR = camPitchF.x + kickPitch.x * sh + bobPitch + breathPitch;
    camRollR = -lean * T.LEAN_ROLL + bobRoll + kickRoll.x * sh - vRight * T.STRAFE_ROLL * sh;
    camera.rotation.set(camPitchR, camYawR, camRollR);

    const camH = lerp(T.CAM_STAND, T.CAM_CROUCH, crouchAmt);
    const lat = lean * T.LEAN_DIST + bobX + joltX.x * sh;
    const p = player.position;
    camera.position.set(
      p.x + cy * lat,
      feetVis + camH + bobY + breathY + jolt.x * sh - Math.abs(lean) * 0.05,
      p.z - sy * lat);
    player.eye.copy(camera.position);
    player.yaw = bodyYaw;
    player.pitch = bodyPitch;

    const hipFov = clamp(Number(settings.fov) || T.FOV_HIP, 60, 120);
    const targetFov = lerp(hipFov, hipFov - T.FOV_ADS_DELTA, ads);
    if (Math.abs(targetFov - fov) > 0.01) {
      fov = targetFov;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  // ================================================================ viewmodel pose
  function poseViewmodel(dt) {
    recRx.update(dt); recRy.update(dt); recRz.update(dt); recBack.update(dt); recUp.update(dt);
    inertX.update(dt); inertY.update(dt);
    inertX.x = clamp(inertX.x, -0.022, 0.022);
    inertY.x = clamp(inertY.x, -0.018, 0.018);
    const lean = leanS.x;

    // aim orientation in world, relative to the rendered camera
    const gunRoll = -lean * T.LEAN_ROLL * 0.85 + bobRoll * 0.4;
    eAim.set(bodyPitch + aimY, bodyYaw + aimX, gunRoll, 'YXZ');
    qAim.setFromEuler(eAim);
    qRel.copy(camera.quaternion).invert().multiply(qAim);

    // hip <-> ADS placement. ADS: pivot at the camera origin, gun origin at (0, -sightY, -ADS_DIST) in aim
    // space, so the sight line (y = sightY, x = 0 in gun space) passes exactly through the camera.
    const hip = 1 - ads;
    pivot.set(T.PIVOT_HIP[0] * hip, T.PIVOT_HIP[1] * hip, T.PIVOT_HIP[2] * hip);
    off.set(lerp(T.OFF_HIP[0], 0, ads), lerp(T.OFF_HIP[1], -vm.sightY, ads), lerp(T.OFF_HIP[2], -T.ADS_DIST, ads));
    off.applyQuaternion(qRel).add(pivot);

    // camera-space additive motion: weapon bob (lags against the camera bob), inertia, low-ready, reload
    const ga = bobA * (1 - 0.7 * ads);
    const sp = sprintAmt;
    const an = weapon.anim;
    const ia = 1 - 0.6 * ads;
    off.x += (bobS * lerp(0.007, 0.016, sp) - bobX * 0.35) * ga + T.LOW_POS[0] * lowerAmt + an.px + inertX.x * ia;
    off.y += (bobAs * lerp(0.010, 0.022, sp) - bobY * 0.4) * ga + T.LOW_POS[1] * lowerAmt + an.py + inertY.x * ia;
    off.z += T.LOW_POS[2] * lowerAmt + an.pz;

    // gun-local additive rotation: hip cant, low-ready, reload, recoil, breathing/tremor, bob sway; the lag roll
    // of the inertia does not change where the barrel points
    const br = Math.sin(breathPhase), br2 = Math.sin(breathPhase * 0.5 + 1.3);
    const conv = settings.freeAim === 'aus' ? 0.5 : 1;
    const swayAmp = lerp(1, 2.0, exertion) * (1 - 0.6 * ads) * conv;
    const trem = (Math.sin(time * 7.3) + 0.6 * Math.sin(time * 11.1 + 2) + 0.8 * Math.sin(time * 3.1 + 0.5)) * 0.0011 * swayAmp;
    eExtra.set(
      T.HIP_ROT[0] * hip + T.LOW_ROT[0] * lowerAmt + an.rx + recRx.x + br * 0.009 * swayAmp + trem + bobAs * 0.02 * ga,
      T.HIP_ROT[1] * hip + T.LOW_ROT[1] * lowerAmt + an.ry + recRy.x + br2 * 0.006 * swayAmp + trem * 0.7 + bobS * lerp(0.01, 0.03, sp) * ga,
      T.HIP_ROT[2] * hip + T.LOW_ROT[2] * lowerAmt + an.rz + recRz.x + bobS * lerp(0.015, 0.05, sp) * ga - inertX.x * 2.2 * ia,
      'YXZ');
    qExtra.setFromEuler(eExtra);
    vm.root.quaternion.copy(qRel).multiply(qExtra);

    // recoil translation along the gun's own axes (back = +Z, up = +Y)
    vA.set(0, recUp.x, recBack.x).applyQuaternion(vm.root.quaternion);
    vm.root.position.copy(off).add(vA);

    // hand layer inputs (micro motion, lowered / sprint / lean / near-wall poses)
    vm.setPose?.({
      dt, time, breath: br, exertion, lower: lowerAmt, sprint: sprintAmt, ads, lean,
      move: Math.min(1, moveF), crouch: crouchAmt, recoil: recRx.x,
    });
  }

  // ================================================================ sky visibility (viewmodel lighting)
  // The sky environment map lights everything equally, indoors too; for the hands that reads as a grey glow under
  // a roof. A few upward rays per frame (round robin) estimate how much open sky is above / around the camera.
  const SKY_DIRS = [[0, 1, 0], [0.5, 0.8, 0], [-0.5, 0.8, 0], [0, 0.8, 0.5], [0, 0.8, -0.5], [0.6, 0.55, 0.55], [-0.6, 0.55, -0.55], [0.6, 0.55, -0.55], [-0.6, 0.55, 0.55]]
    .map((d) => new THREE.Vector3(...d).normalize());
  const skyHits = new Float32Array(SKY_DIRS.length).fill(1);
  let skyIdx = 0, skyVis = 1, skyInit = false;
  function updateSky(dt) {
    const w = ctx.combat?.worldHit;
    if (!w) return;
    const n = skyInit ? 2 : SKY_DIRS.length;
    for (let i = 0; i < n; i++) {
      skyIdx = (skyIdx + 1) % SKY_DIRS.length;
      skyHits[skyIdx] = w(player.eye, SKY_DIRS[skyIdx], 40) ? 0 : 1;
    }
    let s = 0;
    for (let i = 0; i < skyHits.length; i++) s += skyHits[i] * (i === 0 ? 2 : 1);
    const target = s / (skyHits.length + 1);
    skyVis = skyInit ? skyVis + (target - skyVis) * damp(2.5, dt) : target;
    skyInit = true;
    vm.setEnvironment(skyVis, ctx.scene?.environment);
    player.skyVisibility = skyVis;
  }

  // ================================================================ shooting
  function fire() {
    camera.updateMatrixWorld(true);
    vm.muzzle.getWorldPosition(muzzleW);
    const e = vm.muzzle.matrixWorld.elements;
    dirW.set(-e[8], -e[9], -e[10]).normalize();

    // muzzle inside a wall? pull the origin back onto the camera plane
    originW.copy(muzzleW);
    vA.subVectors(muzzleW, player.eye);
    const dm = vA.length();
    if (dm > 1e-4) {
      vB.copy(vA).multiplyScalar(1 / dm);
      if (ctx.combat?.worldHit?.(player.eye, vB, dm)) {
        const ce = camera.matrixWorld.elements;
        camFwd.set(-ce[8], -ce[9], -ce[10]).normalize();
        originW.addScaledVector(camFwd, -camFwd.dot(vA));
      }
    }

    const shotResult = ctx.combat?.fire?.({ origin: originW.clone(), dir: dirW.clone(), from: 'player', damage: T.DAMAGE });
    player.shotsFired = (player.shotsFired || 0) + 1;   // debrief statistics (game.js)
    if (shotResult?.type === 'enemy') player.shotsHit = (player.shotsHit || 0) + 1;
    ctx.enemies?.alertNoise?.(player.position.clone(), T.NOISE_RADIUS);
    ctx.fx?.muzzleFlash?.(muzzleW.clone(), dirW.clone());
    // casing out of the ejection port: right, up, slightly back (gun axes)
    const pos = vm.ejectPort.getWorldPosition(new THREE.Vector3());
    const re = vm.root.matrixWorld.elements;
    vC.set(re[0], re[1], re[2]).normalize().multiplyScalar(1.0)
      .addScaledVector(vB.set(re[4], re[5], re[6]).normalize(), 0.65)
      .addScaledVector(vA.set(re[8], re[9], re[10]).normalize(), 0.25).normalize();
    ctx.fx?.shell?.(pos, vC.clone());
    ctx.audio?.play?.('shot');
    ctx.pipeline?.addTrauma?.(0.3 * settings.shake);
    ctx.pipeline?.flash?.(0.75);
    player.noise = 1;

    weapon.onShot();
    vm.onShot?.();

    // recoil: gun kicks up and back on springs, camera gets a smaller sharp kick, aim walks up
    const k = lerp(1, 0.65, ads) * (1 - 0.15 * crouchAmt);
    const r = Math.random;
    recRx.impulse(T.RECOIL_ROT * k * (0.9 + 0.2 * r()));
    recRy.impulse((r() - 0.5) * 0.9 * k);
    recRz.impulse((r() - 0.5) * 1.4 * k);
    recBack.impulse(T.RECOIL_BACK * k);
    recUp.impulse(T.RECOIL_UP * k);
    kickPitch.impulse(T.CAM_KICK * (0.85 + 0.3 * r()));
    kickYaw.impulse((r() - 0.5) * 0.25);
    kickRoll.impulse((r() - 0.5) * 0.5);
    jolt.impulse(-0.05);
    aimY += T.AIM_CLIMB * (0.8 + 0.4 * r()) * k;
    aimX += (r() - 0.5) * T.AIM_CLIMB_X * k;
  }

  // ================================================================ update
  function update(dt) {
    if (!(dt > 0)) return;
    time += dt;
    const input = ctx.input;
    const md = input?.consumeMouse ? input.consumeMouse() : null;

    if (!player.alive) { updateDeath(dt); return; }
    const active = !!input?.locked;

    if (sprintBlock > 0) sprintBlock -= dt;
    if (shotBufferT > 0) shotBufferT -= dt; else shotQueue = 0;
    if (reloadBuffer > 0) reloadBuffer -= dt;

    // ---- discrete actions (buffered so a press slightly too early still happens)
    if (active) {
      if (anyPressed(KEYS.light)) { weapon.toggleFlashlight(T.FLASH_INTENSITY); vm.onLightToggle?.(); }
      if (anyPressed(KEYS.reload)) {
        reloadBuffer = T.RELOAD_BUFFER;
        if (sprinting && weapon.canReload()) sprintBlock = 0.45;   // reloading drops out of the sprint
      }
      const clicks = input.mouse.leftClicks || (input.mouse.leftPressed ? 1 : 0);
      if (clicks > 0) {
        shotQueue = Math.min(2, shotQueue + clicks);
        shotBufferT = T.FIRE_BUFFER;
        if (sprinting) sprintBlock = 0.45;
      }
      if (settings.aimMode === 'toggle' && input.mouse.rightPressed) aimToggle = !aimToggle;
      if (input.mouse.rightPressed && weapon.reloading) weapon.cancelReload();   // aim cancels an early reload
    } else aimToggle = false;
    if (settings.aimMode !== 'toggle') aimToggle = false;

    // ---- movement first (sprint state feeds ADS / lowering)
    move(dt, active);
    if (sprinting) {
      aimToggle = false;
      if (weapon.reloading) weapon.cancelReload();   // only possible before the magazine is released
    }
    if (reloadBuffer > 0 && !(sprinting && sprintBlock <= 0)) {
      if (weapon.startReload()) reloadBuffer = 0;
      else if (!weapon.reloading && !weapon.canReload()) reloadBuffer = 0;   // full or no reserve: nothing to buffer
    }

    // ---- ADS / lowering
    const aimHeld = settings.aimMode === 'toggle' ? aimToggle : input.mouse.right;
    const wantAds = active && aimHeld && !sprinting && !weapon.reloading;
    player.isAiming = wantAds;
    adsLin = clamp(adsLin + (wantAds ? 1 : -1) * dt / T.ADS_TIME, 0, 1);
    ads = smooth01(adsLin);

    // ---- look: mouse -> world aim 1:1 (after ADS so the zone and multiplier use the current ADS amount)
    lastMouseRad = 0;
    let dYaw = 0, dPitch = 0;
    if (active && md && (md.dx || md.dy)) {
      const sens = T.SENS_UNIT * clamp(Number(settings.sens) || T.SENS_DEFAULT, 0.05, 20) *
        lerp(1, clamp(Number(settings.adsSens) || 1, 0.1, 3), ads);
      dYaw = -md.dx * sens; dPitch = -md.dy * sens * (settings.invertY ? -1 : 1);
    }
    // mouse speed, low-passed with a fixed time constant (so the estimate barely depends on the frame rate)
    mouseSpeed += (Math.hypot(dYaw, dPitch) / dt - mouseSpeed) * damp(T.FLICK_FILTER, dt);
    if (dYaw || dPitch) look(dYaw, dPitch, dt);
    settleAim(dt);

    stepCycle(dt);
    weapon.update(dt);

    // aim direction (world) from body + aim offset; also used for the wall probe
    const ap = bodyPitch + aimY, ay = bodyYaw + aimX, cp = Math.cos(ap);
    player.aimDir.set(-Math.sin(ay) * cp, Math.sin(ap), -Math.cos(ay) * cp);

    poseCamera(dt);

    // low-ready: sprinting, or muzzle would clip a wall (short forward ray from the camera)
    let wallLower = 0;
    const hit = ctx.combat?.worldHit?.(player.eye, player.aimDir, T.WALL_CHECK);
    if (hit) wallLower = clamp((T.WALL_CHECK - hit.distance) / (T.WALL_CHECK - T.WALL_FULL), 0, 1);
    const lowerTarget = weapon.reloading ? 0 : Math.max(sprintAmt > 0.3 && sprinting ? 1 : 0, wallLower);
    const raiseRate = Math.log(1 / 0.3) / T.SPRINT_RAISE;
    lowerAmt += (lowerTarget - lowerAmt) * damp(lowerTarget > lowerAmt ? 7 : raiseRate, dt);

    poseViewmodel(dt);
    updateSky(dt);

    // ---- trigger: semi-auto, every click counts (queued up to 2, each kept for FIRE_BUFFER seconds)
    if (shotQueue > 0 && weapon.cooldown <= 0 && !weapon.reloading && lowerAmt < 0.3) {
      shotQueue--;
      if (weapon.chambered) fire(); else weapon.dryFire();
      if (shotQueue > 0) shotBufferT = Math.max(shotBufferT, T.FIRE_INTERVAL + 0.05);
    }

    player.noise = Math.max(0, player.noise - dt * 1.6);
  }

  // ================================================================ damage / death
  function takeDamage(amount, dir) {
    if (!player.alive) return;
    amount = Number(amount) || 0;
    player.health = Math.max(0, player.health - amount);
    ctx.pipeline?.damage?.(clamp(amount / 60, 0.25, 1));
    ctx.pipeline?.addTrauma?.(0.45 * Math.max(0.3, settings.shake));
    ctx.audio?.play?.('hurt');

    // flinch away from the shot: dir is the bullet travel direction (shooter -> player)
    const sy = Math.sin(camYawR), cy = Math.cos(camYawR);
    let side = Math.random() - 0.5, fwd = -0.5;
    if (dir) { side = dir.x * cy - dir.z * sy; fwd = -dir.x * sy - dir.z * cy; }
    kickYaw.impulse(-side * 2.6);     // pushed toward the bullet's travel (shooter on the left -> turn right)
    kickRoll.impulse(-side * 2.2);
    kickPitch.impulse(-fwd * 1.8);    // hit from the front -> head snaps back / up
    joltX.impulse(side * 0.6);
    jolt.impulse(-0.45);
    recRx.impulse(2.5 * (Math.random() - 0.3));
    recRz.impulse((Math.random() - 0.5) * 3);
    recBack.impulse(0.6);
    deathSide = side >= 0 ? 1 : -1;

    if (player.health <= 0) die();
  }

  function die() {
    player.alive = false;
    player.isAiming = false;
    deathT = 0; deathReported = false; deathLanded = false;
    deathStart.y = camera.position.y;
    deathStart.x = camera.position.x;
    deathStart.z = camera.position.z;
    deathStart.yaw = camYawR; deathStart.pitch = camPitchR; deathStart.roll = camRollR;
    deathStart.ground = levelGround(player.position.x, player.position.z);
    player.velocity.set(0, 0, 0);
    ctx.pipeline?.setDead?.(true);
    ctx.audio?.play?.('death');
  }

  // fallen-bodycam shot: drop to the floor, roll onto the side, small bounce; then report the death
  function updateDeath(dt) {
    deathT += dt;
    jolt.update(dt);
    const f = Math.min(1, deathT / 0.7);
    if (f >= 1 && !deathLanded) {
      deathLanded = true;
      ctx.audio?.play?.('body_fall');
      ctx.pipeline?.addTrauma?.(0.6);
      jolt.impulse(0.5);
    }
    const floorY = deathStart.ground + 0.16;
    const y = lerp(deathStart.y, floorY, f * f) + (deathLanded ? Math.max(-0.08, jolt.x * 0.4) : 0);
    const rs = smooth01((deathT - 0.12) / 0.95);
    // falling toward the side the hit pushed: pushed right -> top of image to the right (negative roll)
    const roll = lerp(deathStart.roll, -deathSide * 1.42, rs);
    const pitch = lerp(deathStart.pitch, -0.06, smooth01(deathT / 0.9));
    const yaw = deathStart.yaw - deathSide * 0.3 * rs;
    // slide a little toward the fall side, never into a wall
    const sy = Math.sin(deathStart.yaw), cy = Math.cos(deathStart.yaw);
    probe.set(deathStart.x, Math.max(y, floorY), deathStart.z);
    probeDir.set(cy * deathSide, 0, -sy * deathSide);
    const room = Math.max(0, rayBoxes(probe, probeDir, 0.6, 0, colliders()) - 0.2);
    const lat = Math.min(0.3, room) * smooth01(deathT / 0.8);
    camera.rotation.set(pitch, yaw, roll);
    camera.position.set(deathStart.x + probeDir.x * lat, y, deathStart.z + probeDir.z * lat);
    player.eye.copy(camera.position);

    // the arms and pistol drop out of frame (kept in the scene so the light count stays constant)
    const d = Math.min(1, deathT / 0.45);
    vm.root.position.y -= dt * (0.4 + 3 * d);
    vm.root.position.x += dt * 0.15 * deathSide;
    vm.root.rotation.x -= dt * 1.5;
    vm.root.rotation.z -= dt * deathSide * 1.2;
    if (vm.root.position.y < -2) vm.root.position.y = -2;

    if (deathT > 1.3 && !deathReported) {
      deathReported = true;
      ctx.game?.onPlayerDeath?.();
    }
  }

  reset();
  return player;
}
