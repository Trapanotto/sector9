import * as THREE from 'three';
import { FLASH_DISTANCE, FLASH_ANGLE, FLASH_PENUMBRA } from './tuning.js';
import { createVmMaterials } from './vmMaterials.js';
import {
  buildPistol, buildMag, GRIP_ANGLE as GA, BORE_Y, SLIDE_TOP, SLIDE_HALF_W, SIGHT_H, REAR_Z, FRONT_Z, MAG_ORIGIN, LIGHT_Y,
} from './vmPistol.js';
import { buildHands } from './vmHands.js';

// First-person viewmodel: procedural striker-fired pistol + gloved two-handed grip + sleeves.
// Geometry lives in vmPistol.js / vmHands.js (built once at load), materials in vmMaterials.js.
//
// Gun-local frame (the `root` group, posed every frame by the player):
//   origin = top of the grip, just under the slide; -Z = muzzle direction, +Y = up, +X = right.
//
// Important exported measurements:
//   sightY  — height of the sight line (top of front post == top of rear posts), at x = 0.
//   The player places the gun at (0, -sightY, -ADS_DIST) in aim space for ADS, which puts the sight line
//   exactly through the camera origin, so front post and rear notch line up on screen.

export const GRIP_ANGLE = GA;

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

  // ---------------------------------------------------------------- trigger finger
  // The player/weapon only pose root, slide, mag and support, so the trigger finger reads its cues from them:
  // aiming (gun near the sight line), a shot (slide starts moving back) -> finger on the trigger; reloading,
  // lowered or idle at the hip -> indexed along the frame. Runs during the renderer's matrix update.
  let fingerT = 0, shotT = 0, lastSlideZ = 0, lastTime = performance.now();
  const trigger = gun.trigger;
  const trigRest = trigger.position.z;
  const baseUpdate = root.updateMatrixWorld.bind(root);
  root.updateMatrixWorld = function (force) {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const sz = slide.position.z;
    if (sz > lastSlideZ + 1e-4 && lastSlideZ < 0.004) shotT = 0.45;
    lastSlideZ = sz;
    shotT = Math.max(0, shotT - dt);
    const r = Math.hypot(root.position.x, root.position.y);
    const aim = Math.min(1, Math.max(0, (0.125 - r) / 0.05));
    const busy = support.position.lengthSq() > 1e-6 || !root.visible;
    const target = busy ? 0 : Math.max(aim, shotT > 0 ? 1 : 0);
    const rate = target > fingerT ? 14 : 6;
    fingerT += (target - fingerT) * (1 - Math.exp(-rate * dt));
    hands.setTrigger(fingerT);
    trigger.position.z = trigRest + (shotT > 0.40 ? 0.0022 : 0);
    baseUpdate(force);
  };

  return {
    root, slide, mag, magGroup, magNew, support, strong, muzzle, ejectPort, light, lens,
    sightY, slideTop: SLIDE_TOP, rearSightZ: REAR_Z, frontSightZ: FRONT_Z, setFlashlight, materials: mats,
  };
}
