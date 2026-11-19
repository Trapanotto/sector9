// Self-test: the gloved hands must not pass through the pistol (rest grip pose, actual pistol triangles).
//   node scripts/selftest-hands.mjs
// Pose-dependent checks (firing, reload, ADS, lean) run in the browser: (await import('/src/player/devtools.js')).penetration()
import * as THREE from 'three';
import { buildPistol, buildMag, MAG_ORIGIN, GRIP_ANGLE } from '../src/player/vmPistol.js';
import { buildHands } from '../src/player/vmHands.js';
import { pistolTriangles, penetration, skinnedPoints } from '../src/player/vmCheck.js';

const m = new THREE.MeshStandardMaterial();
const mats = new Proxy({}, { get: (t, k) => (k === '_env' ? { baseEnv: new Map(), rim: { value: 0 } } : m) });
const root = new THREE.Group();
const gun = buildPistol(mats);
root.add(gun.slide, gun.frame, gun.barrel, gun.light);
const magGroup = new THREE.Group();
magGroup.position.set(...MAG_ORIGIN); magGroup.rotation.x = -GRIP_ANGLE;
magGroup.add(buildMag(mats));
root.add(magGroup);
const strong = new THREE.Group(), support = new THREE.Group();
root.add(strong, support);
const t0 = performance.now();
const hands = buildHands(mats, strong, support);
const buildMs = performance.now() - t0;
root.updateMatrixWorld(true);

const gunMeshes = [];
for (const [nm, o] of Object.entries({ slide: gun.slide, frame: gun.frame, barrel: gun.barrel, light: gun.light, mag: magGroup })) o.traverse((x) => { if (x.isMesh) { x.userData.part = nm; gunMeshes.push(x); } });
const T = pistolTriangles(gunMeshes, root);
let fail = false;
for (const [name, mesh] of [['strong', hands.strongMesh], ['support', hands.supportMesh]]) {
  const r = penetration(skinnedPoints(mesh, root), T, 0.0006);
  const n = mesh.geometry.attributes.position.count;
  const frac = r.inside / n;
  console.log(`${name}: ${r.inside}/${n} vertices inside the pistol (${(frac * 100).toFixed(2)} %), worst ${r.worst}`, r.byPart);
  if (frac > 0.002) fail = true;
}
// trigger finger: frame -> trigger sweep, with and without the press
const sweep = [];
for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) for (const press of [0, 1]) {
  hands.setTrigger(t, press);
  const r = penetration(skinnedPoints(hands.strongMesh, root, 2), T, 0.0006);
  sweep.push(`${t}/${press}:${r.inside}`);
  if (r.inside > 8) fail = true;
}
hands.setTrigger(0, 0);
// strong thumb on the magazine release
for (const a of [0.5, 1]) {
  hands.strong.setFinger('thumb', 1); hands.strong.addReach('magRelease', a);
  const r = penetration(skinnedPoints(hands.strongMesh, root, 2), T, 0.0006);
  sweep.push(`magRel${a}:${r.inside}`);
  if (r.inside > 8) fail = true;
}
hands.strong.setFinger('thumb', 1);
console.log('poses (vertices inside, every 2nd vertex):', sweep.join(' '));
console.log(`hands build ${buildMs.toFixed(0)} ms, ${hands.triangles} triangles`);
if (fail) { console.error('FAIL: hand geometry penetrates the pistol'); process.exit(1); }
console.log('ok');
