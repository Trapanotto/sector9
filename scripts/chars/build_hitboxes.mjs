// Per-bone hit capsules fitted to the reference character's skinned vertices (bind pose).
// Output coordinates are in the bone's local frame (same units as the skeleton, i.e. they
// scale with the variant's root scale automatically); radius likewise in bone-local units.
// usage: node build_hitboxes.mjs <reference_raw.glb> <out.json>
import fs from 'node:fs';
import { loadGLB, THREE } from './threeio.mjs';

const [, , refPath, outPath] = process.argv;
const g = await loadGLB(refPath);
let mesh;
g.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
g.scene.updateMatrixWorld(true);
const bones = mesh.skeleton.bones;
const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
const pos = mesh.geometry.attributes.position;
const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;

// dominant joint per vertex
const groups = new Map();
for (let i = 0; i < pos.count; i++) {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
  const n = bones[best].name;
  if (!groups.has(n)) groups.set(n, []);
  groups.get(n).push(new THREE.Vector3().fromBufferAttribute(pos, i));
}

// [part, bone(s) whose vertices are used, segment start bone, segment end bone|null, damage multiplier]
const SPEC = [
  ['head', ['Head'], 'Head', null, 4.0],
  ['neck', ['neck_01'], 'neck_01', 'Head', 2.0],
  ['chest', ['spine_03'], 'spine_03', 'neck_01', 1.0],
  ['stomach', ['spine_02', 'spine_01'], 'spine_01', 'spine_03', 1.0],
  ['pelvis', ['pelvis'], 'pelvis', 'spine_01', 1.0],
];
for (const s of ['l', 'r']) {
  SPEC.push([`upperarm_${s}`, [`upperarm_${s}`], `upperarm_${s}`, `lowerarm_${s}`, 0.75]);
  SPEC.push([`lowerarm_${s}`, [`lowerarm_${s}`], `lowerarm_${s}`, `hand_${s}`, 0.6]);
  SPEC.push([`hand_${s}`, [`hand_${s}`, `thumb_01_${s}`, `index_01_${s}`, `middle_01_${s}`], `hand_${s}`, null, 0.5]);
  SPEC.push([`thigh_${s}`, [`thigh_${s}`], `thigh_${s}`, `calf_${s}`, 0.75]);
  SPEC.push([`calf_${s}`, [`calf_${s}`], `calf_${s}`, `foot_${s}`, 0.6]);
  SPEC.push([`foot_${s}`, [`foot_${s}`, `ball_${s}`], `foot_${s}`, null, 0.5]);
}

const capsules = [];
for (const [part, vb, b0, b1, dmg] of SPEC) {
  const bone = byName[b0];
  const P0 = bone.getWorldPosition(new THREE.Vector3());
  const verts = vb.flatMap((n) => groups.get(n) || []);
  let dir;
  if (b1) dir = byName[b1].getWorldPosition(new THREE.Vector3()).sub(P0).normalize();
  else {
    // principal axis of the vertex cloud
    const c = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / verts.length);
    dir = c.clone().sub(P0).normalize();
  }
  const ts = verts.map((v) => v.clone().sub(P0).dot(dir));
  const dists = verts.map((v, i) => v.clone().sub(P0).sub(dir.clone().multiplyScalar(ts[i])).length()).sort((a, b) => a - b);
  const pct = ['chest', 'stomach', 'pelvis'].includes(part) ? 0.55 : part === 'head' ? 0.85 : 0.8;
  const r = dists[Math.floor(dists.length * pct)];
  const sorted = [...ts].sort((a, b) => a - b);
  const tmin = sorted[Math.floor(sorted.length * 0.02)], tmax = sorted[Math.floor(sorted.length * 0.98)];
  let ta = tmin + r, tb = tmax - r;
  if (tb < ta) ta = tb = (tmin + tmax) / 2;
  const A = P0.clone().add(dir.clone().multiplyScalar(ta));
  const B = P0.clone().add(dir.clone().multiplyScalar(tb));
  const s = new THREE.Vector3(); bone.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  const la = bone.worldToLocal(A.clone()), lb = bone.worldToLocal(B.clone());
  capsules.push({ part, bone: b0, a: la.toArray().map((v) => +v.toFixed(4)), b: lb.toArray().map((v) => +v.toFixed(4)),
    r: +(r / s.x).toFixed(4), damage: dmg });
}
// Head: the cloud fit above collapsed to a sphere at face height (top of the skull uncovered). Workstream D
// measured the Head-weighted vertices of all six variants in Head-bone space (y -0.08 chin … 0.15 skull/hair,
// z -0.09 … 0.12, x ±0.085) and uses a vertical capsule instead.
const head = capsules.find((c) => c.part === 'head');
Object.assign(head, { a: [0, 0, 0.015], b: [0, 0.068, 0.008], r: 0.088 });
const out = {
  note:'Capsule endpoints a/b and radius r are in the bone\'s local space (skeleton units). World = bone.localToWorld(a); world radius = r * rootScale. Fitted to thug_jacket bind pose (55th percentile radius for torso capsules, 80th for limbs, 85th head); shared by all variants.',
  capsules,
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log('hitboxes:', capsules.map((c) => `${c.part} r=${c.r}`).join(', '));
