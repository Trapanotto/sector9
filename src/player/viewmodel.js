import * as THREE from 'three';
import { FLASH_DISTANCE, FLASH_ANGLE, FLASH_PENUMBRA, SHOULDER, ELBOW_POLE } from './tuning.js';
import { createVmMaterials } from './vmMaterials.js';
import {
  buildPistol, buildMag, GRIP_ANGLE as GA, BORE_Y, SLIDE_TOP, SLIDE_HALF_W, SIGHT_H, REAR_Z, FRONT_Z, MAG_ORIGIN, LIGHT_Y,
} from './vmPistol.js';
import { buildHands, FOREARM_L, UPPER_ARM_L } from './vmHands.js';

// First-person viewmodel: procedural striker-fired pistol + gloved two-handed grip + sleeves + watch.
// Geometry lives in vmPistol.js / vmHands.js (built once at load), materials in vmMaterials.js.
//
// Gun-local frame (the `root` group, posed every frame by the player):
//   origin = top of the grip, just under the slide; -Z = muzzle direction, +Y = up, +X = right.
//
// Important exported measurements:
//   sightY  — height of the sight line (top of front post == top of rear posts), at x = 0.
//   The player places the gun at (0, -sightY, -ADS_DIST) in aim space for ADS, which puts the sight line
//   exactly through the camera origin, so front post and rear notch line up on screen.
//
// Hand animation layer (animate(), driven by player.setPose each frame):
//   - trigger finger: indexed on the frame at the hip, on the trigger when aiming or firing; every shot is a
//     visible press (trigger moves back) and a forward reset;
//   - support hand: re-grips after each shot (fingers loosen and squeeze again), breathes (curl / wrist micro
//     motion), occasionally shuffles its fingers when idle; finger curl / thumb tasks come from the weapon
//     (reload: open, take the magazine, close round it, seat, re-grip; slide release and light switch with the
//     support thumb; magazine release with the strong thumb).

export const GRIP_ANGLE = GA;

// Viewmodel IBL under a roof (fraction of the open-sky strength) and the sky rim strength indoors / outdoors.
const ENV_INDOOR = 0.4;
const RIM_INDOOR = 0.03, RIM_SKY = 0.14;

export function createViewmodel() {
  const mats = createVmMaterials();

  const root = new THREE.Group();
  root.name = 'viewmodel';

  // ---------------------------------------------------------------- pistol
  const gun = buildPistol(mats);
  const slide = gun.slide;                 // moves on Z when cycling / locked back
  root.add(slide, gun.frame, gun.barrel, gun.light);
  const lens = gun.lens;
  const sightY = SLIDE_TOP + SIGHT_H;

  // ---------------------------------------------------------------- magazine (separate part, drops on reload)
  const magGroup = new THREE.Group();      // aligned with the grip axis; local -Y = down the magwell
  magGroup.position.set(MAG_ORIGIN[0], MAG_ORIGIN[1], MAG_ORIGIN[2]);
  magGroup.rotation.x = -GRIP_ANGLE;
  root.add(magGroup);
  const mag = buildMag(mats);
  magGroup.add(mag);

  // ---------------------------------------------------------------- hands
  const strong = new THREE.Group();   // right hand, fixed to the gun
  root.add(strong);
  const support = new THREE.Group();  // left hand, animated during reload (rest = identity)
  root.add(support);
  const hands = buildHands(mats, strong, support);

  // replacement magazine carried by the support hand during reload; seated pose when support is at rest
  const magNewHolder = new THREE.Group();
  magNewHolder.position.copy(magGroup.position);
  magNewHolder.rotation.copy(magGroup.rotation);
  support.add(magNewHolder);
  const magNew = buildMag(mats);
  magNew.visible = false;
  magNewHolder.add(magNew);

  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; o.frustumCulled = false; }
  });

  // ---------------------------------------------------------------- arms (two-bone IK from chest-fixed shoulders)
  // The root's local matrix is camera space (the root is a child of the camera). Shoulders sit just below and
  // behind the chest camera; each forearm runs from the hand's wrist to the IK elbow, the upper arm on to the
  // shoulder. Solved after the root and hand groups have their final pose for the frame (updateMatrixWorld hook),
  // so recoil, reload, lean, ADS and dev inspection poses all get matching arms.
  const arms = hands.arms;
  for (const a of [arms.strong, arms.support]) root.add(a.forearm, a.upper);
  const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _b = new THREE.Matrix4();
  const vW = new THREE.Vector3(), vD = new THREE.Vector3(), vS = new THREE.Vector3(), vE = new THREE.Vector3();
  const vP = new THREE.Vector3(), vX = new THREE.Vector3(), vY = new THREE.Vector3(), vZ = new THREE.Vector3();
  function placeFrame(obj, origin, z, yHint) {
    vY.copy(yHint).addScaledVector(z, -yHint.dot(z)).normalize();
    vX.crossVectors(vY, z);
    _b.makeBasis(vX, vY, z).setPosition(origin);
    obj.matrix.multiplyMatrices(_mi, _b);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrixWorld(true);
  }
  const UP = new THREE.Vector3(0, 1, 0);
  function solveArm(a, group, side) {
    _m.multiplyMatrices(root.matrix, group.matrix);
    vW.copy(a.wrist).applyMatrix4(_m);
    vD.copy(a.dorsal).transformDirection(_m);
    vS.set(SHOULDER[0] * side, SHOULDER[1], SHOULDER[2]);
    vZ.subVectors(vW, vS);
    const L1 = UPPER_ARM_L, L2 = FOREARM_L;
    const D = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-3, vZ.length()));
    vZ.normalize();
    const along = (L1 * L1 - L2 * L2 + D * D) / (2 * D), h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    vP.set(ELBOW_POLE[0] * side, ELBOW_POLE[1], ELBOW_POLE[2]);
    vP.addScaledVector(vZ, -vP.dot(vZ)).normalize();
    vE.copy(vS).addScaledVector(vZ, along).addScaledVector(vP, h);
    // forearm: wrist -> elbow, back of the wrist toward the back of the hand (a little toward camera-up)
    vZ.subVectors(vE, vW).normalize();
    vD.multiplyScalar(0.7).addScaledVector(UP, 0.3);
    placeFrame(a.forearm, vW, vZ, vD);
    // upper arm: elbow -> shoulder
    vZ.subVectors(vS, vE).normalize();
    placeFrame(a.upper, vE, vZ, UP);
    a.elbow = a.elbow || new THREE.Vector3();
    a.elbow.copy(vE);
  }
  const baseUMW = root.updateMatrixWorld.bind(root);
  root.updateMatrixWorld = function (force) {
    baseUMW(force);
    _mi.copy(root.matrix).invert();
    solveArm(arms.strong, strong, 1);
    solveArm(arms.support, support, -1);
  };

  // ---------------------------------------------------------------- attachment points
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, BORE_Y, -0.160);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(SLIDE_HALF_W, SLIDE_TOP - 0.006, -0.045);
  slide.add(ejectPort);

  // ---------------------------------------------------------------- flashlight
  // Always present (intensity 0 when off) so toggling never changes the light count / recompiles shaders.
  const light = new THREE.SpotLight(0xfff1dc, 0, FLASH_DISTANCE, FLASH_ANGLE, FLASH_PENUMBRA, 2);
  light.castShadow = false;
  light.position.set(0, LIGHT_Y, -0.152);
  const lightTarget = new THREE.Object3D();
  lightTarget.position.set(0, LIGHT_Y, -4);
  root.add(light, lightTarget);
  light.target = lightTarget;

  function setFlashlight(on, intensity) {
    light.intensity = on ? intensity : 0;
    mats.lens.emissiveIntensity = on ? 3.0 : 0;
    mats.reflector.emissiveIntensity = on ? 1.5 : 0;
  }

  // ---------------------------------------------------------------- environment (sky visibility)
  const env = mats._env;
  /** sky 0..1: how much open sky the camera sees; scales IBL on the viewmodel and the rim light */
  // Note: three only applies material.envMapIntensity when material.envMap is set explicitly (with scene.environment
  // it is ignored), so the scene's environment texture is assigned to every viewmodel material here.
  let envTexSet = null;
  function setEnvironment(sky, envTex) {
    if (envTex && envTex !== envTexSet) {
      envTexSet = envTex;
      for (const m of env.baseEnv.keys()) { m.envMap = envTex; m.needsUpdate = true; }
    }
    const k = ENV_INDOOR + (1 - ENV_INDOOR) * sky;
    for (const [m, base] of env.baseEnv) m.envMapIntensity = base * k;
    env.rim.value = RIM_INDOOR + (RIM_SKY - RIM_INDOOR) * sky;
  }
  setEnvironment(1);

  // ---------------------------------------------------------------- hand animation layer
  // Written by the weapon (reload timeline); read every frame by animate().
  const hand = {
    supportCurl: 1,      // support fingers: 1 grip, 0 straight, >1 tighter (round a magazine)
    supportThumb: 1,     // support thumb curl
    magRelease: 0,       // strong thumb reach to the magazine release 0..1
    slideStop: 0,        // support thumb pushes the slide stop up 0..1
    busy: false,         // reload in progress (no idle fidgets, finger off the trigger)
  };
  const trigger = gun.trigger;
  const trigRest = trigger.position.z;
  let fingerT = 0, shotHold = 0, pressT = 1, regripT = 1, lightT = 1, fidgetT = 0, fidgetNext = 6, time = 0;
  const pose = { dt: 0, time: 0, breath: 0, exertion: 0, lower: 0, sprint: 0, ads: 0, lean: 0, move: 0, crouch: 0, recoil: 0 };
  const supportBase = { p: new THREE.Vector3(), r: new THREE.Euler() };
  let lastApplied = false;

  function onShot() {
    shotHold = 0.7; pressT = 0; regripT = 0;
    fingerT = Math.max(fingerT, 0.75);     // the finger is on the trigger when the shot breaks
  }
  function onLightToggle() { if (!hand.busy) lightT = 0; }

  const bump = (t, a, b, c) => (t <= a || t >= c ? 0 : t < b ? (t - a) / (b - a) : 1 - (t - b) / (c - b));
  const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

  function animate(dt) {
    time += dt;
    shotHold = Math.max(0, shotHold - dt);
    pressT += dt; regripT += dt; lightT += dt;

    // ---- trigger finger
    const busy = hand.busy || !root.visible;
    const onTrig = !busy && pose.lower < 0.5 && (pose.ads > 0.4 || shotHold > 0) ? 1 : 0;
    const rate = onTrig > fingerT ? 16 : 7;
    fingerT += (onTrig - fingerT) * (1 - Math.exp(-rate * dt));
    // press: pulled through the break at the shot, then released forward past the reset and back to rest
    let press = 0;
    if (pressT < 0.045) press = 1;
    else if (pressT < 0.16) press = 1 - sm((pressT - 0.045) / 0.07) * 1.18;
    else if (pressT < 0.3) press = -0.18 * (1 - sm((pressT - 0.16) / 0.14));
    hands.setTrigger(fingerT, press);
    trigger.position.z = trigRest + Math.max(0, press) * 0.0024 * fingerT;

    // ---- strong hand: grip pressure with breathing, recoil squeeze, thumb on the magazine release
    const br = pose.breath;
    const squeeze = bump(regripT, 0, 0.05, 0.3) * 0.05;
    // (curl never above the sculpted grip: tighter would push the fingers into the grip)
    for (const n of ['middle', 'ring', 'pinky']) hands.strong.setFinger(n, 1 - 0.008 * (1 + Math.sin(time * 1.3 + n.length)) - squeeze);
    hands.strong.setFinger('thumb', 1 - 0.02 * (1 + br) - bump(regripT, 0.02, 0.08, 0.3) * 0.12);
    hands.strong.addReach('magRelease', hand.magRelease);

    // ---- support hand
    // idle fidget: every few seconds at rest the fingers loosen and re-grip one after another
    fidgetT += dt;
    const idle = !busy && pose.move < 0.2 && pose.ads < 0.2 && pose.lower < 0.2;
    if (fidgetT > fidgetNext) { if (idle) { fidgetT = 0; fidgetNext = 5 + Math.random() * 5; } else fidgetT = fidgetNext - 1; }
    const regrip = bump(regripT, 0.02, 0.09, 0.32) * 0.16;      // fingers loosen in the recoil, squeeze again
    const names = ['index', 'middle', 'ring', 'pinky'];
    for (let i = 0; i < 4; i++) {
      const fid = idle ? bump(fidgetT, 0.1 + i * 0.07, 0.25 + i * 0.07, 0.5 + i * 0.07) * 0.22 : 0;
      const c = hand.supportCurl + 0.02 * Math.sin(time * 1.1 + i * 0.9) * (hand.busy ? 0 : 1) + 0.015 * br - regrip - fid;
      hands.support.setFinger(names[i], c, 0, 0, 0);
    }
    const light = bump(lightT, 0, 0.12, 0.34);
    hands.support.setFinger('thumb', hand.supportThumb + 0.04 * br - regrip * 0.5);
    hands.support.addReach('light', light);
    hands.support.addReach('slideStop', hand.slideStop);

    // wrist micro motion (support group offsets on top of the weapon's reload pose, only while gripping)
    const grip = hand.busy ? 0 : 1;
    const slip = bump(regripT, 0.0, 0.04, 0.3);
    support.position.set(
      supportBase.p.x + grip * (0.0006 * br),
      supportBase.p.y + grip * (0.0008 * Math.sin(time * 0.9) - slip * 0.0012),
      supportBase.p.z + grip * (slip * 0.0025));
    support.rotation.set(
      supportBase.r.x + grip * (0.004 * br + slip * 0.02),
      supportBase.r.y + grip * 0.003 * Math.sin(time * 0.7 + 1),
      supportBase.r.z + grip * (0.003 * Math.sin(time * 0.6) - slip * 0.015));

    // contact AO fades as the support hand leaves the gun
    env.contactSupport.value = Math.max(0, 1 - supportBase.p.length() / 0.012);
    lastApplied = true;
  }

  return {
    root, slide, mag, magGroup, magNew, support, strong, muzzle, ejectPort, light, lens,
    frame: gun.frame, barrel: gun.barrel, lightBody: gun.light,
    sightY, slideTop: SLIDE_TOP, rearSightZ: REAR_Z, frontSightZ: FRONT_Z, setFlashlight, materials: mats,
    hands, hand,
    /** weapon writes the support hand's reload pose here (gun-local offsets); the animation layer adds to it */
    supportBase,
    setEnvironment,
    onShot, onLightToggle,
    setPose(p) { Object.assign(pose, p); animate(Math.min(0.1, Math.max(0, p.dt || 0))); },
    get animated() { return lastApplied; },
  };
}
