import * as THREE from 'three';
import * as T from './tuning.js';
import { Spring, clamp, lerp, smooth01, damp } from './springs.js';
import { createViewmodel } from './viewmodel.js';
import { createWeapon } from './weapon.js';
import { depenetrate, moveAxis, rayBoxes, blocked } from './collision.js';

// Bodycam player.
//
// Conventions (three.js, camera.rotation.order = 'YXZ'):
//   yaw   = rotation.y, 0 looks toward -Z, positive turns LEFT  -> mouse dx > 0 decreases yaw (turn right)
//   pitch = rotation.x, positive looks UP                       -> mouse dy > 0 decreases pitch (look down)
//   roll  = rotation.z, positive rolls the top of the image to the LEFT
//   forward(yaw) = (-sin yaw, 0, -cos yaw), right(yaw) = (cos yaw, 0, -sin yaw)
//
// Free aim: the mouse moves an aim offset (aimX, aimY) relative to the camera body (bodyYaw, bodyPitch).
// Only the part that leaves the dead zone turns the body; the body also slowly recentres on the aim.
// The rendered camera follows the body through an under-damped spring (lag + overshoot), while the
// weapon points at the aim direction immediately -> the gun leads, the camera trails.

const EMPTY = [];
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export function createPlayer(ctx) {
  const camera = ctx.camera;
  const vm = createViewmodel();
  camera.add(vm.root);

  // ---------------------------------------------------------------- springs
  const camYawS = new Spring(T.CAM_FOLLOW_W, T.CAM_FOLLOW_Z);
  const camPitchS = new Spring(T.CAM_FOLLOW_W, T.CAM_FOLLOW_Z);
  const kickPitch = new Spring(22, 0.5), kickYaw = new Spring(22, 0.5), kickRoll = new Spring(18, 0.45);
  const jolt = new Spring(14, 0.45);                 // camera vertical jolt (steps, landing, hits)
  const joltX = new Spring(12, 0.5);                 // camera lateral jolt (hits)
  const recRx = new Spring(18, 0.42), recRy = new Spring(18, 0.5), recRz = new Spring(16, 0.45);
  const recBack = new Spring(20, 0.5), recUp = new Spring(20, 0.5);
  const inertX = new Spring(9, 0.5), inertY = new Spring(9, 0.5);  // weapon rotational inertia on mouse moves
  const springs = [camYawS, camPitchS, kickPitch, kickYaw, kickRoll, jolt, joltX, recRx, recRy, recRz, recBack, recUp, inertX, inertY];

  const weapon = createWeapon(ctx, vm, { jolt: (v) => { recUp.impulse(v); recRx.impulse(v * 2); } });

  // ---------------------------------------------------------------- state
  let bodyYaw = 0, bodyPitch = 0, aimX = 0, aimY = 0;
  let vy = 0, grounded = true, feetVis = 0;
  let crouchAmt = 0, crouchToggle = false;
  let lean = 0;
  let adsLin = 0, ads = 0, lowerAmt = 0, sprintAmt = 0;
  let moveF = 0, stepPhase = 0, lastStep = 0, exertion = 0, breathPhase = 0, time = 0;
  let sprintBlock = 0, fireBuffer = 0;
  let sprinting = false;
  let fov = T.FOV_HIP;
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

  const player = {
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
    aimDir: new THREE.Vector3(0, 0, -1),   // where the barrel points (world)
    get reloading() { return weapon.reloading; },
    get reloadCount() { return weapon.reloadCount; },
    get flashlight() { return weapon.flashlight; },
    get crouching() { return crouchAmt > 0.5; },
    get sprinting() { return sprinting; },
    viewmodel: vm,
    update, takeDamage, reset,
  };

  const level = () => ctx.level;
  const colliders = () => ctx.level?.colliders || EMPTY;
  const groundAt = (x, z) => {
    const g = ctx.level?.groundHeight?.(x, z);
    return Number.isFinite(g) ? g : 0;
  };

  // ================================================================ reset
  function reset() {
    const sp = level()?.playerSpawn;
    if (sp?.position) player.position.copy(sp.position); else player.position.set(0, 0, 0);
    player.position.y = groundAt(player.position.x, player.position.z);
    bodyYaw = sp?.yaw || 0; bodyPitch = 0; aimX = 0; aimY = 0;
    player.velocity.set(0, 0, 0); vy = 0; grounded = true; feetVis = player.position.y;
    crouchAmt = 0; crouchToggle = false; lean = 0; adsLin = ads = lowerAmt = sprintAmt = 0;
    moveF = 0; stepPhase = 0; lastStep = 0; exertion = 0; sprintBlock = 0; fireBuffer = 0; sprinting = false;
    for (const s of springs) s.reset(0);
    camYawS.reset(bodyYaw); camPitchS.reset(0);
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
  function look(dx, dy, dt) {
    const sens = T.SENS * lerp(1, T.ADS_SENS_MUL, ads);
    aimX -= dx * sens;
    aimY -= dy * sens;
    // weapon inertia: the gun lags behind the motion (turn right -> barrel trails left = +yaw)
    inertX.impulse(dx * 0.004);
    inertY.impulse(dy * 0.004);
    applyDeadZone(dt);
  }

  function applyDeadZone(dt) {
    const dX = lerp(T.DEAD_X, T.DEAD_X_ADS, ads);
    const dY = lerp(T.DEAD_Y, T.DEAD_Y_ADS, ads);
    if (aimX > dX) { bodyYaw += aimX - dX; aimX = dX; }
    else if (aimX < -dX) { bodyYaw += aimX + dX; aimX = -dX; }
    if (aimY > dY) { bodyPitch += aimY - dY; aimY = dY; }
    else if (aimY < -dY) { bodyPitch += aimY + dY; aimY = -dY; }
    // slow recentre of the camera body onto the aim (world aim direction unchanged)
    const rate = lerp(T.RECENTER_HIP, T.RECENTER_ADS, ads) + sprintAmt * T.RECENTER_SPRINT;
    const k = damp(rate, dt);
    const tx = aimX * k, ty = aimY * k * 0.8;
    bodyYaw += tx; aimX -= tx;
    bodyPitch += ty; aimY -= ty;
    // limits
    if (bodyPitch > T.PITCH_LIMIT) { aimY += bodyPitch - T.PITCH_LIMIT; bodyPitch = T.PITCH_LIMIT; }
    if (bodyPitch < -T.PITCH_LIMIT) { aimY += bodyPitch + T.PITCH_LIMIT; bodyPitch = -T.PITCH_LIMIT; }
    const wp = bodyPitch + aimY;
    if (wp > T.AIM_PITCH_LIMIT) aimY = T.AIM_PITCH_LIMIT - bodyPitch;
    if (wp < -T.AIM_PITCH_LIMIT) aimY = -T.AIM_PITCH_LIMIT - bodyPitch;
  }

  // ================================================================ movement
  function move(dt, active) {
    const input = ctx.input;
    const pos = player.position, vel = player.velocity;
    const k = (c) => active && input.down(c);
    const fwdIn = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    const strIn = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);

    // crouch: C toggles, Ctrl holds
    if (active && input.pressed('KeyC')) crouchToggle = !crouchToggle;
    const holdCrouch = k('ControlLeft') || k('ControlRight');
    const shift = k('ShiftLeft') || k('ShiftRight');
    const wantSprint = shift && fwdIn > 0 && sprintBlock <= 0 && !holdCrouch && !(active && input.mouse.right);
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

    // wish velocity relative to the camera body heading
    const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
    let wx = -sy * fwdIn + cy * strIn, wz = -cy * fwdIn - sy * strIn;
    const wl = Math.hypot(wx, wz);
    let speed = sprinting ? T.SPRINT_SPEED : crouchAmt > 0.5 ? T.CROUCH_SPEED : ads > 0.5 ? T.ADS_SPEED : T.WALK_SPEED;
    if (fwdIn < 0) speed *= T.BACK_MUL;
    if (wl > 0) { wx = wx / wl * speed; wz = wz / wl * speed; }
    const rate = wl > 0 ? (sprinting ? T.SPRINT_ACCEL : T.ACCEL) : T.FRICTION;
    const a = damp(grounded ? rate : rate * 0.15, dt);
    vel.x += (wx - vel.x) * a;
    vel.z += (wz - vel.z) * a;

    // horizontal collision, per axis with sliding; ground rises above STEP_UP act as walls
    const y0 = pos.y + 0.05, y1 = pos.y + player.height;
    depenetrate(pos, T.RADIUS, y0, y1, boxes);
    let ox = pos.x;
    if (moveAxis(pos, 0, vel.x * dt, T.RADIUS, y0, y1, boxes)) vel.x = 0;
    if (groundAt(pos.x, pos.z) - pos.y > T.STEP_UP) { pos.x = ox; vel.x = 0; }
    const oz = pos.z;
    if (moveAxis(pos, 2, vel.z * dt, T.RADIUS, y0, y1, boxes)) vel.z = 0;
    if (groundAt(pos.x, pos.z) - pos.y > T.STEP_UP) { pos.z = oz; vel.z = 0; }
    const bounds = level()?.bounds;
    if (bounds) {
      ox = pos.x;
      pos.x = clamp(pos.x, bounds.min.x + T.RADIUS, bounds.max.x - T.RADIUS);
      if (pos.x !== ox) vel.x = 0;
      const z0 = pos.z;
      pos.z = clamp(pos.z, bounds.min.z + T.RADIUS, bounds.max.z - T.RADIUS);
      if (pos.z !== z0) vel.z = 0;
    }

    // vertical: floor from level.groundHeight, smooth step-up via feetVis, gravity otherwise
    const g = groundAt(pos.x, pos.z);
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

    // lean (Q/E) limited by walls on each side
    const leanIn = active && !sprinting ? (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0) : 0;
    const camH = lerp(T.CAM_STAND, T.CAM_CROUCH, crouchAmt);
    probe.set(pos.x, feetVis + camH, pos.z);
    probeDir.set(cy, 0, -sy);
    const reach = T.LEAN_DIST + T.LEAN_MARGIN;
    const limR = clamp((rayBoxes(probe, probeDir, reach, 0, boxes) - T.LEAN_MARGIN) / T.LEAN_DIST, 0, 1);
    probeDir.negate();
    const limL = clamp((rayBoxes(probe, probeDir, reach, 0, boxes) - T.LEAN_MARGIN) / T.LEAN_DIST, 0, 1);
    const leanTarget = leanIn > 0 ? leanIn * limR : leanIn * limL;
    lean += (leanTarget - lean) * damp(T.LEAN_RATE, dt);
    lean = clamp(lean, -limL, limR);
  }

  function land(speed) {
    if (speed < T.LAND_MIN_SPEED) return;
    jolt.impulse(-speed * 0.28);
    kickPitch.impulse(-speed * 0.12);
    recUp.impulse(-speed * 0.12);
    ctx.audio?.play?.('land', { volume: clamp(speed / 6, 0.3, 1) });
    ctx.pipeline?.addTrauma?.(clamp(speed * 0.05, 0.05, 0.4));
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
    camYawS.target = bodyYaw; camPitchS.target = bodyPitch;
    camYawS.update(dt); camPitchS.update(dt);
    if (camYawS.x - bodyYaw > T.CAM_LAG_MAX) camYawS.x = bodyYaw + T.CAM_LAG_MAX;
    if (camYawS.x - bodyYaw < -T.CAM_LAG_MAX) camYawS.x = bodyYaw - T.CAM_LAG_MAX;
    if (camPitchS.x - bodyPitch > T.CAM_LAG_MAX) camPitchS.x = bodyPitch + T.CAM_LAG_MAX;
    if (camPitchS.x - bodyPitch < -T.CAM_LAG_MAX) camPitchS.x = bodyPitch - T.CAM_LAG_MAX;
    kickPitch.update(dt); kickYaw.update(dt); kickRoll.update(dt); jolt.update(dt); joltX.update(dt);

    // step-synchronised bob (one step per PI of phase); |sin| gives the cusp of each footfall
    bobS = Math.sin(stepPhase);
    bobAs = Math.abs(bobS) - 0.637;
    bobA = Math.min(moveF, 1.6);
    const sp = sprintAmt, cr = 1 - 0.45 * crouchAmt, ad = 1 - 0.45 * ads;
    bobY = bobAs * lerp(T.BOB_V_WALK, T.BOB_V_SPRINT, sp) * bobA * cr * ad;
    bobX = bobS * lerp(T.BOB_X_WALK, T.BOB_X_SPRINT, sp) * bobA * cr * ad;
    bobRoll = bobS * lerp(T.BOB_ROLL_WALK, T.BOB_ROLL_SPRINT, sp) * bobA * ad;
    const bobPitch = bobAs * lerp(T.BOB_PITCH_WALK, T.BOB_PITCH_SPRINT, sp) * bobA * ad;
    const bobYaw = bobS * lerp(T.BOB_YAW_WALK, T.BOB_YAW_SPRINT, sp) * bobA * ad;

    // breathing (idle stronger, faster after sprinting)
    const bAmp = lerp(1, 1.9, exertion) * (1 - 0.6 * Math.min(moveF, 1));
    const br = Math.sin(breathPhase);
    const breathPitch = br * 0.0035 * bAmp;
    const breathY = br * 0.003 * bAmp;

    const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
    const vRight = player.velocity.x * cy - player.velocity.z * sy;

    camYawR = camYawS.x + kickYaw.x + bobYaw;
    camPitchR = camPitchS.x + kickPitch.x + bobPitch + breathPitch;
    camRollR = -lean * T.LEAN_ROLL + bobRoll + kickRoll.x - vRight * T.STRAFE_ROLL;
    camera.rotation.set(camPitchR, camYawR, camRollR);

    const camH = lerp(T.CAM_STAND, T.CAM_CROUCH, crouchAmt);
    const lat = lean * T.LEAN_DIST + bobX + joltX.x;
    const p = player.position;
    camera.position.set(
      p.x + cy * lat,
      feetVis + camH + bobY + breathY + jolt.x - Math.abs(lean) * 0.05,
      p.z - sy * lat);
    player.eye.copy(camera.position);
    player.yaw = bodyYaw;
    player.pitch = bodyPitch;

    const targetFov = lerp(T.FOV_HIP, T.FOV_ADS, ads);
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
    inertX.x = clamp(inertX.x, -0.12, 0.12);
    inertY.x = clamp(inertY.x, -0.10, 0.10);

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

    // camera-space additive motion: weapon bob (lags against the camera bob), low-ready, reload
    const ga = bobA * (1 - 0.7 * ads);
    const sp = sprintAmt;
    const an = weapon.anim;
    off.x += (bobS * lerp(0.007, 0.016, sp) - bobX * 0.35) * ga + T.LOW_POS[0] * lowerAmt + an.px;
    off.y += (bobAs * lerp(0.010, 0.022, sp) - bobY * 0.4) * ga + T.LOW_POS[1] * lowerAmt + an.py;
    off.z += T.LOW_POS[2] * lowerAmt + an.pz;

    // gun-local additive rotation: hip cant, low-ready, reload, recoil, inertia, breathing/tremor, bob sway
    const br = Math.sin(breathPhase), br2 = Math.sin(breathPhase * 0.5 + 1.3);
    const swayAmp = lerp(1, 2.0, exertion) * (1 - 0.6 * ads);
    const trem = (Math.sin(time * 7.3) + 0.6 * Math.sin(time * 11.1 + 2) + 0.8 * Math.sin(time * 3.1 + 0.5)) * 0.0011 * swayAmp;
    eExtra.set(
      T.HIP_ROT[0] * hip + T.LOW_ROT[0] * lowerAmt + an.rx + recRx.x + inertY.x + br * 0.009 * swayAmp + trem + bobAs * 0.02 * ga,
      T.HIP_ROT[1] * hip + T.LOW_ROT[1] * lowerAmt + an.ry + recRy.x + inertX.x + br2 * 0.006 * swayAmp + trem * 0.7 + bobS * lerp(0.01, 0.03, sp) * ga,
      T.HIP_ROT[2] * hip + T.LOW_ROT[2] * lowerAmt + an.rz + recRz.x + bobS * lerp(0.015, 0.05, sp) * ga,
      'YXZ');
    qExtra.setFromEuler(eExtra);
    vm.root.quaternion.copy(qRel).multiply(qExtra);

    // recoil translation along the gun's own axes (back = +Z, up = +Y)
    vA.set(0, recUp.x, recBack.x).applyQuaternion(vm.root.quaternion);
    vm.root.position.copy(off).add(vA);
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
    ctx.pipeline?.addTrauma?.(0.3);
    ctx.pipeline?.flash?.(0.75);
    player.noise = 1;

    weapon.onShot();

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
    if (fireBuffer > 0) fireBuffer -= dt;

    // ---- discrete actions
    if (active) {
      if (input.pressed('KeyF')) weapon.toggleFlashlight(T.FLASH_INTENSITY);
      if (input.pressed('KeyR') && weapon.startReload()) { /* reload started */ }
      if (input.mouse.leftPressed) { fireBuffer = 0.22; if (sprinting) sprintBlock = 0.45; }
    }

    // ---- movement first (sprint state feeds ADS / lowering)
    move(dt, active);

    // ---- ADS / lowering
    const wantAds = active && input.mouse.right && !sprinting && !weapon.reloading;
    player.isAiming = wantAds;
    adsLin = clamp(adsLin + (wantAds ? 1 : -1) * dt / T.ADS_TIME, 0, 1);
    ads = smooth01(adsLin);

    // ---- look (after ADS so the dead zone uses the current ADS amount)
    if (active && md) look(md.dx, md.dy, dt); else applyDeadZone(dt);

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
    lowerAmt += (lowerTarget - lowerAmt) * damp(lowerTarget > lowerAmt ? 7 : 9, dt);

    poseViewmodel(dt);

    // ---- trigger (semi-auto, buffered briefly so a click during sprint/raise still fires)
    if (fireBuffer > 0 && weapon.cooldown <= 0 && !weapon.reloading && lowerAmt < 0.3) {
      fireBuffer = 0;
      if (weapon.chambered) fire(); else weapon.dryFire();
    }

    player.noise = Math.max(0, player.noise - dt * 1.6);
  }

  // ================================================================ damage / death
  function takeDamage(amount, dir) {
    if (!player.alive) return;
    amount = Number(amount) || 0;
    player.health = Math.max(0, player.health - amount);
    ctx.pipeline?.damage?.(clamp(amount / 60, 0.25, 1));
    ctx.pipeline?.addTrauma?.(0.45);
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
    deathStart.ground = groundAt(player.position.x, player.position.z);
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
