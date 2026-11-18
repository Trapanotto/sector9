import * as THREE from 'three';

// Skeleton layout shared by the character builder, the animator and the ragdoll.
// Modelled at 1.80 m facing +Z (left = +X); the root is scaled uniformly to the requested height.
export const SKEL = {
  baseHeight: 1.8,
  pelvisY: 0.985,
  hipX: 0.095, hipY: -0.03,
  thigh: 0.44, shin: 0.43, ankleH: 0.085,
  spineY: 0.11, chestY: 0.2, neckY: 0.215, headY: 0.085, headZ: 0.012,
  shoulderX: 0.175, shoulderY: 0.165, shoulderZ: -0.01,
  upperArm: 0.29, foreArm: 0.26,
  headCenter: new THREE.Vector3(0, 0.085, 0.015),
  eye: new THREE.Vector3(0, 0.095, 0.085),
  handGrip: new THREE.Vector3(0, -0.08, 0.012),
};

export const BONE_NAMES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];
export const BONE_INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

// Bind ("modelling") pose: arms in an A-pose and legs slightly apart so limbs and torso are separated
// in the mesh; skinning is relative to this pose, the animator still works from identity rest rotations.
export const BIND_POSE = { upperArmL: 0.75, upperArmR: -0.75, thighL: 0.06, thighR: -0.06 };

/** Builds the bone hierarchy under parent. Returns { name: THREE.Bone }. */
export function buildBones(parent) {
  const S = SKEL, B = {};
  const bone = (p, name, x, y, z, order = 'XYZ') => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    b.rotation.order = order;
    p.add(b);
    B[name] = b;
    return b;
  };
  bone(parent, 'pelvis', 0, S.pelvisY, 0, 'YXZ');
  bone(B.pelvis, 'spine', 0, S.spineY, 0, 'YXZ');
  bone(B.spine, 'chest', 0, S.chestY, 0, 'YXZ');
  bone(B.chest, 'neck', 0, S.neckY, 0, 'YXZ');
  bone(B.neck, 'head', 0, S.headY, S.headZ, 'YXZ');
  bone(B.chest, 'upperArmL', S.shoulderX, S.shoulderY, S.shoulderZ);
  bone(B.chest, 'upperArmR', -S.shoulderX, S.shoulderY, S.shoulderZ);
  bone(B.upperArmL, 'foreArmL', 0, -S.upperArm, 0);
  bone(B.upperArmR, 'foreArmR', 0, -S.upperArm, 0);
  bone(B.foreArmL, 'handL', 0, -S.foreArm, 0);
  bone(B.foreArmR, 'handR', 0, -S.foreArm, 0);
  bone(B.pelvis, 'thighL', S.hipX, S.hipY, 0);
  bone(B.pelvis, 'thighR', -S.hipX, S.hipY, 0);
  bone(B.thighL, 'shinL', 0, -S.thigh, 0);
  bone(B.thighR, 'shinR', 0, -S.thigh, 0);
  bone(B.shinL, 'footL', 0, -S.shin, 0);
  bone(B.shinR, 'footR', 0, -S.shin, 0);
  return B;
}

export function applyBindPose(B) {
  for (const n of BONE_NAMES) B[n].rotation.set(0, 0, 0);
  for (const [n, z] of Object.entries(BIND_POSE)) B[n].rotation.z = z;
}

let bindMats = null;
/** Bone -> model-space matrices (Float64Array(16) column-major) of the bind pose, by bone name. */
export function getBindMatrices() {
  if (bindMats) return bindMats;
  const root = new THREE.Object3D();
  const B = buildBones(root);
  applyBindPose(B);
  root.updateMatrixWorld(true);
  bindMats = {};
  for (const n of BONE_NAMES) bindMats[n] = Float64Array.from(B[n].matrixWorld.elements);
  return bindMats;
}
