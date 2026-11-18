import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FLASH_DISTANCE, FLASH_ANGLE, FLASH_PENUMBRA } from './tuning.js';

// Procedural first-person viewmodel: compact polymer-frame 9 mm pistol + gloved two-handed grip + sleeves.
//
// Gun-local frame (the `root` group, posed every frame by the player):
//   origin = top of the grip, just under the slide; -Z = muzzle direction, +Y = up, +X = right.
//   Side profiles are drawn in (u, v) = (forward, up) and extruded across X.
//
// Important exported measurements:
//   sightY  — height of the sight line (top of front post == top of rear posts), at x = 0.
//   The player places the gun at (0, -sightY, -ADS_DIST) in aim space for ADS, which puts the sight line
//   exactly through the camera origin, so front post and rear notch line up on screen.

export const GRIP_ANGLE = 0.31;   // grip rake: top of the grip leans forward by ~18 deg
const BORE_Y = 0.028;

function profileGeometry(points, holes, width, bevel) {
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p[0], p[1])));
  if (holes) for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 2, curveSegments: 4,
  });
  g.rotateY(Math.PI / 2);           // shape x (forward) -> -Z, extrusion z -> +X
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function mesh(parent, geom, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

const rbox = (w, h, d, r, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);

export function createViewmodel() {
  const mats = {
    slide: new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.82, roughness: 0.36 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.05, roughness: 0.6 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x45433f, metalness: 0.95, roughness: 0.26 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x040404, metalness: 0.2, roughness: 0.85 }),
    dot: new THREE.MeshStandardMaterial({ color: 0xe6efd2, emissive: 0x7d9a40, emissiveIntensity: 0.7, roughness: 0.4 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 0.9, roughness: 0.35 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x19191b, metalness: 0.0, roughness: 0.8 }),
    gloveGrip: new THREE.MeshStandardMaterial({ color: 0x232325, metalness: 0.0, roughness: 0.92 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x1d222a, metalness: 0.0, roughness: 0.95 }),
    lens: new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.3, roughness: 0.12, emissive: 0xfff2d8, emissiveIntensity: 0 }),
  };
  // Mostly indoors: keep the bright sky environment from washing out the dark gear.
  for (const m of Object.values(mats)) m.envMapIntensity = 0.35;

  const root = new THREE.Group();
  root.name = 'viewmodel';

  // ---------------------------------------------------------------- slide (moves on Z when cycling)
  const slide = new THREE.Group();
  root.add(slide);
  const slideGeom = profileGeometry(
    [[-0.036, 0.012], [0.154, 0.012], [0.154, 0.037], [0.148, 0.043], [-0.028, 0.043], [-0.036, 0.036]],
    null, 0.026, 0.0022);
  mesh(slide, slideGeom, mats.slide);
  const sb = slideGeom.boundingBox;
  const slideTop = sb.max.y;
  const slideHalfW = sb.max.x;

  // rear cocking serrations (both sides)
  const serrGeom = new THREE.BoxGeometry(slideHalfW * 2 + 0.0012, 0.022, 0.0013);
  for (let i = 0; i < 7; i++) mesh(slide, serrGeom, mats.dark, 0, 0.028, 0.008 + i * 0.0036);
  // front serrations (shorter)
  const serrGeom2 = new THREE.BoxGeometry(slideHalfW * 2 + 0.0012, 0.016, 0.0012);
  for (let i = 0; i < 4; i++) mesh(slide, serrGeom2, mats.dark, 0, 0.030, -0.118 - i * 0.0036);
  // ejection port: dark opening on the right flank
  mesh(slide, new THREE.BoxGeometry(0.002, 0.011, 0.040), mats.dark, slideHalfW - 0.0004, slideTop - 0.008, -0.045);

  // sights (on the slide). Rear: two posts forming a notch; front: single post with a dot.
  const SIGHT_H = 0.0075;
  const sightY = slideTop + SIGHT_H;
  const REAR_Z = 0.024, FRONT_Z = -0.141;
  mesh(slide, new THREE.BoxGeometry(0.021, 0.0035, 0.007), mats.slide, 0, slideTop + 0.00175, REAR_Z);
  const postGeom = new THREE.BoxGeometry(0.0050, SIGHT_H, 0.007);
  mesh(slide, postGeom, mats.slide, -0.0042, slideTop + SIGHT_H / 2, REAR_Z);
  mesh(slide, postGeom, mats.slide, 0.0042, slideTop + SIGHT_H / 2, REAR_Z);
  mesh(slide, new THREE.BoxGeometry(0.0034, SIGHT_H, 0.006), mats.slide, 0, slideTop + SIGHT_H / 2, FRONT_Z);
  const dotGeom = new THREE.CylinderGeometry(0.0011, 0.0011, 0.0006, 10);
  mesh(slide, dotGeom, mats.dot, 0, sightY - 0.0026, FRONT_Z + 0.0033, Math.PI / 2);
  mesh(slide, dotGeom, mats.dot, -0.0042, sightY - 0.0029, REAR_Z + 0.0038, Math.PI / 2);
  mesh(slide, dotGeom, mats.dot, 0.0042, sightY - 0.0029, REAR_Z + 0.0038, Math.PI / 2);

  // ---------------------------------------------------------------- barrel (static)
  // hood visible through the ejection port / on top, muzzle crown at the front
  mesh(root, new THREE.BoxGeometry(0.012, 0.006, 0.040), mats.steel, 0.002, slideTop - 0.0025, -0.045);
  mesh(root, new THREE.CylinderGeometry(0.0068, 0.0068, 0.006, 16), mats.steel, 0, BORE_Y, -0.156, Math.PI / 2);
  mesh(root, new THREE.CylinderGeometry(0.0043, 0.0043, 0.0025, 12), mats.dark, 0, BORE_Y, -0.1585, Math.PI / 2);

  // ---------------------------------------------------------------- frame: dust cover, trigger guard, raked grip
  const frameGeom = profileGeometry(
    [[-0.028, 0.012], [0.147, 0.012], [0.150, 0.006], [0.150, -0.003], [0.146, -0.006], [0.074, -0.006],
     [0.068, -0.012], [0.066, -0.030], [0.060, -0.039], [0.048, -0.043], [0.026, -0.043], [0.012, -0.040],
     [-0.017, -0.128], [-0.022, -0.134], [-0.058, -0.134], [-0.062, -0.128], [-0.025, -0.020],
     [-0.032, -0.012], [-0.046, -0.002], [-0.044, 0.006], [-0.036, 0.010]],
    [[[0.024, -0.009], [0.062, -0.009], [0.061, -0.029], [0.055, -0.037], [0.042, -0.039], [0.020, -0.036]]],
    0.024, 0.0025);
  mesh(root, frameGeom, mats.frame);
  // trigger
  mesh(root, new THREE.BoxGeometry(0.0055, 0.019, 0.0045), mats.frame, 0, -0.020, -0.039, -0.18);
  // slide stop / takedown details on the left
  mesh(root, new THREE.BoxGeometry(0.003, 0.004, 0.016), mats.dark, -0.0135, 0.010, -0.010);
  // weapon light under the dust cover
  mesh(root, rbox(0.028, 0.022, 0.058, 0.006), mats.frame, 0, -0.017, -0.12);
  const lens = mesh(root, new THREE.CylinderGeometry(0.0088, 0.0088, 0.003, 18), mats.lens, 0, -0.017, -0.1495, Math.PI / 2);

  // ---------------------------------------------------------------- magazine (separate part, drops on reload)
  function buildMag() {
    const g = new THREE.Group();
    mesh(g, new THREE.BoxGeometry(0.019, 0.105, 0.030), mats.slide, 0, -0.058, 0.0);
    mesh(g, new THREE.CapsuleGeometry(0.0045, 0.012, 3, 8), mats.brass, 0, -0.006, -0.004, Math.PI / 2);
    mesh(g, rbox(0.027, 0.0095, 0.046, 0.003), mats.frame, 0, -0.117, 0.001);
    return g;
  }
  const magGroup = new THREE.Group();          // aligned with the grip axis; local -Y = down the magwell
  magGroup.position.set(0, -0.020, 0.003);
  magGroup.rotation.x = -GRIP_ANGLE;
  root.add(magGroup);
  const mag = buildMag();
  magGroup.add(mag);

  // ---------------------------------------------------------------- hands
  const strong = new THREE.Group();   // right hand, fixed to the gun
  root.add(strong);
  const support = new THREE.Group();  // left hand, animated during reload (rest = identity)
  root.add(support);

  // right fist wrapped around the grip
  mesh(strong, rbox(0.040, 0.072, 0.062, 0.013), mats.glove, 0.003, -0.078, 0.020, -GRIP_ANGLE);
  // back of the hand / web under the beavertail
  mesh(strong, rbox(0.044, 0.074, 0.042, 0.014), mats.glove, 0.007, -0.052, 0.050, -GRIP_ANGLE - 0.1);
  // index finger indexed along the right side of the frame
  mesh(strong, new THREE.CapsuleGeometry(0.0082, 0.042, 4, 10), mats.glove, 0.0172, -0.003, -0.034, Math.PI / 2 - 0.05);
  // strong thumb forward along the left side, above the support thumb
  mesh(strong, new THREE.CapsuleGeometry(0.0085, 0.032, 4, 10), mats.glove, -0.0185, 0.003, -0.004, Math.PI / 2 + 0.08, 0.10);
  // knuckle ridge (silhouette)
  mesh(strong, new THREE.CapsuleGeometry(0.0095, 0.03, 4, 10), mats.gloveGrip, 0.018, -0.060, 0.010, -GRIP_ANGLE);

  // left palm on the left grip panel
  mesh(support, rbox(0.024, 0.070, 0.060, 0.010), mats.glove, -0.025, -0.072, 0.014, -GRIP_ANGLE);
  // left fingers wrapped over the front of the strong hand
  const fingers = new THREE.Group();
  fingers.position.set(-0.004, -0.050, -0.014);
  fingers.rotation.x = -GRIP_ANGLE;
  support.add(fingers);
  const fingerGeom = new THREE.CapsuleGeometry(0.0088, 0.033, 4, 10);
  for (let i = 0; i < 4; i++) mesh(fingers, fingerGeom, mats.glove, 0.002 - i * 0.001, -i * 0.0172, -0.008 + i * 0.0012, 0, 0, Math.PI / 2);
  // left thumb forward under the slide
  mesh(support, new THREE.CapsuleGeometry(0.0088, 0.040, 4, 10), mats.glove, -0.0195, -0.010, -0.030, Math.PI / 2 + 0.06, 0.05);
  // back of the left hand
  mesh(support, rbox(0.032, 0.064, 0.058, 0.013), mats.glove, -0.034, -0.068, 0.046, -GRIP_ANGLE, 0, 0.22);

  // replacement magazine carried by the support hand during reload; seated pose when support is at rest
  const magNewHolder = new THREE.Group();
  magNewHolder.position.copy(magGroup.position);
  magNewHolder.rotation.copy(magGroup.rotation);
  support.add(magNewHolder);
  const magNew = buildMag();
  magNew.visible = false;
  magNewHolder.add(magNew);

  // ---------------------------------------------------------------- forearms (gloved wrist + dark sleeve)
  const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  function forearm(parent, wrist, dir) {
    const d = dir.clone().normalize();
    const qUp = new THREE.Quaternion().setFromUnitVectors(Y, d.clone().negate()); // cylinder top (+Y) toward the wrist
    const glove = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.035, 0.07, 14), mats.glove);
    glove.position.copy(wrist).addScaledVector(d, 0.022);
    glove.quaternion.copy(qUp);
    const sleeveLen = 0.40;
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.053, sleeveLen, 16), mats.sleeve);
    sleeve.position.copy(wrist).addScaledVector(d, 0.045 + sleeveLen / 2);
    sleeve.quaternion.copy(qUp);
    const hem = new THREE.Mesh(new THREE.TorusGeometry(0.040, 0.0065, 6, 18), mats.sleeve);
    hem.position.copy(wrist).addScaledVector(d, 0.047);
    hem.quaternion.setFromUnitVectors(Z, d);
    for (const m of [glove, sleeve, hem]) { m.receiveShadow = true; m.castShadow = false; parent.add(m); }
  }
  forearm(strong, new THREE.Vector3(0.010, -0.072, 0.080), new THREE.Vector3(0.40, -0.18, 1));
  forearm(support, new THREE.Vector3(-0.036, -0.080, 0.070), new THREE.Vector3(-0.50, -0.18, 1));

  // ---------------------------------------------------------------- attachment points
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, BORE_Y, -0.160);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(slideHalfW, slideTop - 0.006, -0.045);
  slide.add(ejectPort);

  // ---------------------------------------------------------------- flashlight
  // Always present (intensity 0 when off) so toggling never changes the light count / recompiles shaders.
  const light = new THREE.SpotLight(0xfff1dc, 0, FLASH_DISTANCE, FLASH_ANGLE, FLASH_PENUMBRA, 2);
  light.castShadow = false;
  light.position.set(0, -0.017, -0.152);
  const lightTarget = new THREE.Object3D();
  lightTarget.position.set(0, -0.017, -4);
  root.add(light, lightTarget);
  light.target = lightTarget;

  function setFlashlight(on, intensity) {
    light.intensity = on ? intensity : 0;
    mats.lens.emissiveIntensity = on ? 3.0 : 0;
  }

  return {
    root, slide, mag, magGroup, magNew, support, strong, muzzle, ejectPort, light, lens,
    sightY, slideTop, rearSightZ: REAR_Z, frontSightZ: FRONT_Z, setFlashlight, materials: mats,
  };
}
