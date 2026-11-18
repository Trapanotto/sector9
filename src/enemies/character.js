import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural articulated humanoid built from primitives. Modelled at 1.80 m facing +Z, then the root is scaled
// uniformly to the requested height. Bones are plain Object3Ds (no skinning); the meshes attached to each bone
// are merged per material to keep draw calls low. No DOM access (runs in Node for tests).

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
  handGrip: new THREE.Vector3(0, -0.08, 0.012),   // weapon origin inside the right hand
};

// ---------------------------------------------------------------------------------------------
// Materials (shared across all characters)
// ---------------------------------------------------------------------------------------------
let fabricTex = null;
function getFabricTexture() {
  if (fabricTex) return fabricTex;
  const S = 64, data = new Uint8Array(S * S * 4);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const weave = ((x + y) & 3) < 2 ? 7 : -7;
      const row = (y % 8 === 0) ? -6 : 0;
      const v = Math.max(0, Math.min(255, 222 + weave + row + (rnd() - 0.5) * 40));
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  fabricTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  fabricTex.wrapS = fabricTex.wrapT = THREE.RepeatWrapping;
  fabricTex.repeat.set(3, 3);
  fabricTex.magFilter = THREE.LinearFilter;
  fabricTex.minFilter = THREE.LinearMipmapLinearFilter;
  fabricTex.generateMipmaps = true;
  fabricTex.colorSpace = THREE.SRGBColorSpace;
  fabricTex.needsUpdate = true;
  return fabricTex;
}

const MATS = new Map();
const KINDS = {
  fabric: { roughness: 0.94, metalness: 0, tex: true },
  knit: { roughness: 1.0, metalness: 0, tex: true },
  denim: { roughness: 0.9, metalness: 0, tex: true },
  hood: { roughness: 0.95, metalness: 0, tex: true, side: THREE.DoubleSide },
  leather: { roughness: 0.5, metalness: 0.0 },
  skin: { roughness: 0.62, metalness: 0 },
  hair: { roughness: 0.85, metalness: 0 },
  rubber: { roughness: 0.92, metalness: 0 },
  eye: { roughness: 0.25, metalness: 0 },
  metal: { roughness: 0.38, metalness: 0.65 },
  polymer: { roughness: 0.62, metalness: 0.05 },
  wood: { roughness: 0.55, metalness: 0 },
};
export function getMaterial(kind, color) {
  const key = kind + ':' + color;
  let m = MATS.get(key);
  if (m) return m;
  const k = KINDS[kind] || KINDS.fabric;
  m = new THREE.MeshStandardMaterial({
    color, roughness: k.roughness, metalness: k.metalness,
    map: k.tex ? getFabricTexture() : null,
    side: k.side ?? THREE.FrontSide,
  });
  m.name = 'enemy_' + key;
  MATS.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------------------------
const pick = (a) => a[(Math.random() * a.length) | 0];
const SKIN = [0xd4ab8c, 0xbb8b6b, 0x9c6c4d, 0x704b34, 0xc99d7f];
const HAIR = [0x1c1714, 0x2e2219, 0x4a3726, 0x141210, 0x5e4e3e];

export const LOOKS = [
  () => ({ name: 'hoodie', top: 'hoodie', topColor: pick([0x2f3134, 0x3c3f3a, 0x23262d, 0x4a4239, 0x4b2f2c]),
    hood: pick(['down', 'down', 'up']), head: pick(['beanie', 'none', 'none']), headColor: pick([0x2b2b2b, 0x3d2f2a, 0x22303a]),
    face: 'bare', legs: pick([0x2c3443, 0x2a2b2e, 0x3b3a35]), legsKind: 'denim', boots: pick([0x2a231d, 0x1a1a1a, 0x3a3631]), gloves: false }),
  () => ({ name: 'workjacket', top: 'jacket', topColor: pick([0x5b4b35, 0x4b5038, 0x3d3a33, 0x2f3a44]),
    head: pick(['cap', 'beanie', 'none']), headColor: pick([0x2e3338, 0x3a3a30, 0x4b3b2b]), face: 'bare',
    legs: pick([0x6a604c, 0x4e4a3f, 0x3c3d38]), legsKind: 'work', boots: 0x2b231b, gloves: Math.random() < 0.4 }),
  () => ({ name: 'balaclava', top: 'hoodie', topColor: pick([0x1e1f22, 0x2b2c2a, 0x34362f]), hood: 'up', head: 'none',
    face: 'balaclava', legs: pick([0x232428, 0x2e3029, 0x30302c]), legsKind: 'cargo', boots: 0x161616, gloves: true }),
  () => ({ name: 'leather', top: 'jacket', leather: true, topColor: pick([0x1d1a18, 0x2e231b, 0x3a2c22]), head: 'none', face: 'bare',
    legs: pick([0x47494c, 0x2b3240]), legsKind: 'denim', boots: 0x1b1714, gloves: false }),
  () => ({ name: 'vest', top: 'shirt', topColor: pick([0x4a3a36, 0x3e4446, 0x55503f]), vest: pick([0x3b3f30, 0x2a2c2a, 0x4a4433]),
    head: pick(['cap', 'beanie']), headColor: pick([0x2a2c2e, 0x34352c]), face: pick(['balaclava', 'bare']),
    legs: pick([0x3a3c33, 0x2c2e30]), legsKind: 'cargo', boots: 0x1e1a16, gloves: true }),
];

export function randomLook(index) {
  const f = index != null ? LOOKS[index % LOOKS.length] : pick(LOOKS);
  const l = f();
  l.skin = pick(SKIN); l.hair = pick(HAIR);
  l.bald = Math.random() < 0.15;
  return l;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function bake(geom, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
  _eu.set(rot[0], rot[1], rot[2]);
  _q.setFromEuler(_eu);
  _m4.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(scl[0], scl[1], scl[2]));
  geom.applyMatrix4(_m4);
  return geom;
}
const capsule = (r, len, rs = 10) => new THREE.CapsuleGeometry(r, len, 3, rs);
const sphere = (r, w = 14, h = 10, ps, pl, ts, tl) => new THREE.SphereGeometry(r, w, h, ps, pl, ts, tl);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt, rb, h, seg = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

class PartSet {
  constructor() { this.map = new Map(); }
  add(target, material, geom, pos, rot, scl) {
    bake(geom, pos, rot, scl);
    let byMat = this.map.get(target);
    if (!byMat) this.map.set(target, (byMat = new Map()));
    let list = byMat.get(material);
    if (!list) byMat.set(material, (list = []));
    list.push(geom);
  }
  build(meshes) {
    for (const [target, byMat] of this.map) {
      for (const [material, list] of byMat) {
        const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
        if (list.length > 1) for (const g of list) g.dispose();
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = merged.boundingSphere.radius > 0.05;   // tiny details (eyes, brows) skip the shadow pass
        mesh.receiveShadow = true;
        target.add(mesh);
        meshes.push(mesh);
      }
    }
    this.map.clear();
  }
}

function bone(parent, name, x, y, z, order = 'XYZ') {
  const b = new THREE.Object3D();
  b.name = name;
  b.position.set(x, y, z);
  b.rotation.order = order;
  parent.add(b);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Weapons (local +Z = barrel, origin = top of the pistol grip where the right hand holds it)
// ---------------------------------------------------------------------------------------------
function buildWeapon(type, meshes) {
  const group = new THREE.Group();
  group.name = 'enemy_weapon_' + type;
  const parts = new PartSet();
  const metal = getMaterial('metal', 0x1c1d1f);
  const poly = getMaterial('polymer', 0x18191a);
  let magGeom, muzzle, eject, rightWrist, supportPos, supportQuat, magwell, handMagPos;

  if (type === 'rifle') {
    const furniture = Math.random() < 0.5 ? getMaterial('wood', 0x5b3b22) : poly;
    parts.add(group, metal, box(0.05, 0.075, 0.3), [0, 0.04, 0.09]);           // receiver
    parts.add(group, metal, box(0.044, 0.022, 0.25), [0, 0.086, 0.075]);       // dust cover
    parts.add(group, furniture, box(0.056, 0.058, 0.17), [0, 0.035, 0.325]);   // handguard
    parts.add(group, metal, cyl(0.012, 0.012, 0.17, 8), [0, 0.077, 0.325], [Math.PI / 2, 0, 0]);   // gas tube
    parts.add(group, metal, cyl(0.0105, 0.0105, 0.2, 8), [0, 0.045, 0.49], [Math.PI / 2, 0, 0]);   // barrel
    parts.add(group, metal, box(0.012, 0.04, 0.015), [0, 0.07, 0.555]);        // front sight
    parts.add(group, metal, cyl(0.016, 0.016, 0.05, 8), [0, 0.045, 0.6], [Math.PI / 2, 0, 0]);     // muzzle device
    parts.add(group, poly, box(0.032, 0.095, 0.042), [0, -0.042, -0.008], [0.3, 0, 0]);             // pistol grip
    parts.add(group, furniture, box(0.04, 0.055, 0.21), [0, 0.03, -0.16], [-0.06, 0, 0]);           // stock
    parts.add(group, furniture, box(0.043, 0.115, 0.03), [0, 0.0, -0.265]);                          // butt
    parts.add(group, metal, box(0.006, 0.02, 0.05), [0, -0.006, 0.04]);                              // trigger guard
    magGeom = mergeGeometries([
      bake(box(0.03, 0.09, 0.062), [0, -0.045, 0.0], [0.15, 0, 0]),
      bake(box(0.03, 0.09, 0.062), [0, -0.125, 0.03], [0.45, 0, 0]),
    ], false);
    magGeom.computeBoundingSphere();
    const magMesh = new THREE.Mesh(magGeom, metal);
    magMesh.position.set(0, 0.0, 0.15);
    magMesh.castShadow = true;
    group.add(magMesh);
    meshes.push(magMesh);
    muzzle = new THREE.Vector3(0, 0.045, 0.63);
    eject = new THREE.Vector3(-0.03, 0.07, 0.1);
    rightWrist = new THREE.Vector3(0, 0.08, -0.012);
    supportPos = new THREE.Vector3(0.042, -0.035, 0.295);
    supportQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -2.55));
    magwell = new THREE.Vector3(0.045, -0.08, 0.16);
    handMagPos = new THREE.Vector3(-0.01, -0.06, 0.03);
    parts.build(meshes);
    return { group, magMesh, magGeom, muzzle, eject, rightWrist, supportPos, supportQuat, magwell, handMagPos, type };
  }

  // pistol
  parts.add(group, metal, box(0.03, 0.034, 0.19), [0, 0.03, 0.055]);           // slide
  parts.add(group, poly, box(0.028, 0.024, 0.14), [0, 0.004, 0.05]);           // frame
  parts.add(group, poly, box(0.03, 0.105, 0.048), [0, -0.045, -0.012], [0.28, 0, 0]);   // grip
  parts.add(group, poly, box(0.006, 0.022, 0.045), [0, -0.016, 0.035]);        // trigger guard
  parts.add(group, metal, box(0.01, 0.01, 0.01), [0, 0.052, 0.14]);            // front sight
  magGeom = bake(box(0.024, 0.1, 0.034), [0, 0, 0]);
  magGeom.computeBoundingSphere();
  const magMesh = new THREE.Mesh(magGeom, metal);
  magMesh.position.set(0, -0.1, -0.027);
  magMesh.rotation.x = 0.28;
  magMesh.castShadow = true;
  group.add(magMesh);
  meshes.push(magMesh);
  muzzle = new THREE.Vector3(0, 0.03, 0.155);
  eject = new THREE.Vector3(-0.02, 0.05, 0.06);
  rightWrist = new THREE.Vector3(0, 0.08, -0.012);
  supportPos = new THREE.Vector3(0.05, 0.035, 0.012);
  supportQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.25, -0.55));
  magwell = new THREE.Vector3(0.04, -0.15, -0.01);
  handMagPos = new THREE.Vector3(-0.01, -0.07, 0.03);
  parts.build(meshes);
  return { group, magMesh, magGeom, muzzle, eject, rightWrist, supportPos, supportQuat, magwell, handMagPos, type };
}

// ---------------------------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------------------------
/**
 * @param {{weaponType?:'pistol'|'rifle', height?:number, look?:object, bulk?:number}} opts
 */
export function createCharacter(opts = {}) {
  const weaponType = opts.weaponType || 'pistol';
  const height = opts.height ?? 1.75 + Math.random() * 0.15;
  const look = opts.look || randomLook();
  const bulk = opts.bulk ?? 0.94 + Math.random() * 0.14;
  const scale = height / SKEL.baseHeight;
  const meshes = [];

  const root = new THREE.Group();
  root.name = 'enemy';
  root.scale.setScalar(scale);

  const S = SKEL;
  const B = {};
  B.pelvis = bone(root, 'pelvis', 0, S.pelvisY, 0, 'YXZ');
  B.spine = bone(B.pelvis, 'spine', 0, S.spineY, 0, 'YXZ');
  B.chest = bone(B.spine, 'chest', 0, S.chestY, 0, 'YXZ');
  B.neck = bone(B.chest, 'neck', 0, S.neckY, 0, 'YXZ');
  B.head = bone(B.neck, 'head', 0, S.headY, S.headZ, 'YXZ');
  B.upperArmL = bone(B.chest, 'upperArmL', S.shoulderX, S.shoulderY, S.shoulderZ);
  B.upperArmR = bone(B.chest, 'upperArmR', -S.shoulderX, S.shoulderY, S.shoulderZ);
  B.foreArmL = bone(B.upperArmL, 'foreArmL', 0, -S.upperArm, 0);
  B.foreArmR = bone(B.upperArmR, 'foreArmR', 0, -S.upperArm, 0);
  B.handL = bone(B.foreArmL, 'handL', 0, -S.foreArm, 0);
  B.handR = bone(B.foreArmR, 'handR', 0, -S.foreArm, 0);
  B.thighL = bone(B.pelvis, 'thighL', S.hipX, S.hipY, 0);
  B.thighR = bone(B.pelvis, 'thighR', -S.hipX, S.hipY, 0);
  B.shinL = bone(B.thighL, 'shinL', 0, -S.thigh, 0);
  B.shinR = bone(B.thighR, 'shinR', 0, -S.thigh, 0);
  B.footL = bone(B.shinL, 'footL', 0, -S.shin, 0);
  B.footR = bone(B.shinR, 'footR', 0, -S.shin, 0);

  // ---- materials for this look ----
  const L = look;
  const topKind = L.leather ? 'leather' : 'fabric';
  const top = getMaterial(topKind, L.topColor);
  const topDark = getMaterial(topKind, darken(L.topColor, 0.78));
  const legs = getMaterial(L.legsKind === 'denim' ? 'denim' : 'fabric', L.legs);
  const legsDark = getMaterial('fabric', darken(L.legs, 0.8));
  const boots = getMaterial('leather', L.boots);
  const sole = getMaterial('rubber', 0x141312);
  const skin = getMaterial('skin', L.skin);
  const balaclava = getMaterial('knit', 0x141414);
  const faceMat = L.face === 'balaclava' ? balaclava : skin;
  const hands = L.gloves ? getMaterial('leather', 0x161514) : skin;
  const hair = getMaterial('hair', L.hair);
  const eyeMat = getMaterial('eye', 0x16110d);
  const belt = getMaterial('leather', 0x1c1814);
  const P = new PartSet();
  const bx = bulk, bz = 0.92 + (bulk - 1) * 0.8;

  // ---- pelvis / hips ----
  P.add(B.pelvis, legs, capsule(0.112, 0.15), [0, -0.025, -0.005], [0, 0, Math.PI / 2], [1, 1, 0.82 * bz]);
  P.add(B.pelvis, legs, sphere(0.085, 10, 8), [0.06, -0.06, -0.04], [0, 0, 0], [1, 1, 0.9]);
  P.add(B.pelvis, legs, sphere(0.085, 10, 8), [-0.06, -0.06, -0.04], [0, 0, 0], [1, 1, 0.9]);
  P.add(B.pelvis, belt, cyl(0.127 * bx, 0.127 * bx, 0.04, 14, true), [0, 0.055, 0], [0, 0, 0], [1, 1, 0.8 * bz]);

  // ---- torso ----
  P.add(B.spine, top, capsule(0.12, 0.1), [0, 0.085, 0], [0, 0, 0], [1.12 * bx, 1, 0.8 * bz]);
  P.add(B.chest, top, capsule(0.14, 0.15), [0, 0.105, -0.005], [0, 0, 0], [1.22 * bx, 1, 0.75 * bz]);
  P.add(B.chest, top, sphere(0.068, 10, 8), [S.shoulderX * bx - 0.005, S.shoulderY - 0.005, S.shoulderZ]);
  P.add(B.chest, top, sphere(0.068, 10, 8), [-S.shoulderX * bx + 0.005, S.shoulderY - 0.005, S.shoulderZ]);
  P.add(B.chest, top, capsule(0.058, 0.17), [0, 0.195, -0.025], [0, 0, Math.PI / 2], [1, 1, 0.8]);   // trapezius

  if (L.top === 'hoodie') {
    P.add(B.spine, topDark, box(0.2 * bx, 0.1, 0.03), [0, 0.05, 0.088 * bz]);     // kangaroo pocket
    P.add(B.spine, topDark, cyl(0.13 * bx, 0.135 * bx, 0.05, 14, true), [0, -0.02, 0], [0, 0, 0], [1, 1, 0.8 * bz]);   // hem
    if (L.hood === 'down') {
      P.add(B.chest, top, new THREE.TorusGeometry(0.085, 0.04, 6, 14, Math.PI * 1.25), [0, 0.22, -0.045],
        [Math.PI / 2 - 0.3, 0, -Math.PI * 1.125], [1.1, 1, 1]);
    }
    P.add(B.chest, getMaterial('fabric', 0xb8b2a6), cyl(0.004, 0.004, 0.12, 4), [0.035, 0.19, 0.112]);   // drawstrings
    P.add(B.chest, getMaterial('fabric', 0xb8b2a6), cyl(0.004, 0.004, 0.12, 4), [-0.035, 0.19, 0.112]);
  } else if (L.top === 'jacket') {
    P.add(B.chest, topDark, new THREE.TorusGeometry(0.075, 0.026, 6, 14), [0, 0.225, -0.005], [Math.PI / 2 - 0.2, 0, 0], [1.05, 1.1, 1]);  // collar
    P.add(B.chest, getMaterial('metal', 0x2a2a2a), box(0.012, 0.26, 0.012), [0, 0.07, 0.106 * bz]);   // zipper
    P.add(B.spine, topDark, cyl(0.132 * bx, 0.137 * bx, 0.06, 14, true), [0, 0.0, 0], [0, 0, 0], [1, 1, 0.82 * bz]);   // hem
    P.add(B.spine, topDark, box(0.07, 0.07, 0.02), [0.085, 0.06, 0.088 * bz]);     // pockets
    P.add(B.spine, topDark, box(0.07, 0.07, 0.02), [-0.085, 0.06, 0.088 * bz]);
  } else {
    P.add(B.chest, topDark, new THREE.TorusGeometry(0.066, 0.016, 6, 14), [0, 0.225, 0.0], [Math.PI / 2 - 0.15, 0, 0]);
  }
  if (L.vest) {
    const vest = getMaterial('fabric', L.vest), vestDark = getMaterial('fabric', darken(L.vest, 0.75));
    P.add(B.chest, vest, capsule(0.152, 0.1), [0, 0.08, -0.004], [0, 0, 0], [1.2 * bx, 1, 0.8 * bz]);
    for (const x of [-0.075, 0, 0.075]) P.add(B.chest, vestDark, box(0.06, 0.095, 0.035), [x, 0.03, 0.125 * bz]);
    P.add(B.chest, vestDark, box(0.05, 0.04, 0.24), [0.15 * bx, 0.2, -0.01]);   // shoulder straps
    P.add(B.chest, vestDark, box(0.05, 0.04, 0.24), [-0.15 * bx, 0.2, -0.01]);
  }

  // ---- neck & head ----
  P.add(B.neck, faceMat, capsule(0.051, 0.07), [0, 0.04, 0.004]);
  P.add(B.head, faceMat, sphere(0.1, 16, 12), [0, 0.085, 0.015], [0, 0, 0], [0.79, 1.13, 0.97]);
  P.add(B.head, faceMat, sphere(0.06, 12, 8), [0, 0.035, 0.05], [0, 0, 0], [1.0, 0.75, 0.95]);   // jaw
  P.add(B.head, faceMat, box(0.022, 0.042, 0.03), [0, 0.083, 0.106], [-0.25, 0, 0]);              // nose
  if (L.face === 'balaclava') {
    P.add(B.head, skin, box(0.074, 0.026, 0.02), [0, 0.104, 0.088]);                               // eye slit
  } else if (L.hood !== 'up') {
    P.add(B.head, skin, sphere(0.022, 8, 6), [0.078, 0.08, 0.0], [0, 0, 0], [0.45, 1, 0.8]);    // ears
    P.add(B.head, skin, sphere(0.022, 8, 6), [-0.078, 0.08, 0.0], [0, 0, 0], [0.45, 1, 0.8]);
  }
  P.add(B.head, eyeMat, sphere(0.0095, 6, 5), [0.03, 0.104, 0.093]);
  P.add(B.head, eyeMat, sphere(0.0095, 6, 5), [-0.03, 0.104, 0.093]);
  if (L.face !== 'balaclava') {
    P.add(B.head, hair, box(0.032, 0.007, 0.012), [0.031, 0.122, 0.095], [0, 0, -0.1]);    // brows
    P.add(B.head, hair, box(0.032, 0.007, 0.012), [-0.031, 0.122, 0.095], [0, 0, 0.1]);
  }
  const showHair = L.face !== 'balaclava' && L.hood !== 'up' && L.head !== 'beanie' && !L.bald;
  if (showHair) {
    P.add(B.head, hair, sphere(0.104, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), [0, 0.09, 0.004], [-0.28, 0, 0], [0.81, 1.12, 1.0]);
  }
  if (L.head === 'beanie' && L.hood !== 'up') {
    const knit = getMaterial('knit', L.headColor || 0x2b2b2b);
    P.add(B.head, knit, sphere(0.107, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), [0, 0.1, 0.006], [-0.12, 0, 0], [0.83, 1.2, 1.0]);
    P.add(B.head, knit, cyl(0.087, 0.087, 0.04, 16, true), [0, 0.1, 0.006], [-0.12, 0, 0], [1, 1, 1.2]);
  } else if (L.head === 'cap' && L.hood !== 'up') {
    const capM = getMaterial('fabric', L.headColor || 0x2e3338);
    P.add(B.head, capM, sphere(0.106, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), [0, 0.105, 0.008], [-0.05, 0, 0], [0.82, 0.92, 1.0]);
    P.add(B.head, capM, cyl(0.068, 0.068, 0.008, 14), [0, 0.112, 0.1], [0.12, 0, 0], [1, 1, 0.95]);
  }
  if (L.hood === 'up') {
    const hood = getMaterial('hood', L.topColor);
    P.add(B.head, hood, sphere(0.124, 16, 10, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.8),
      [0, 0.088, -0.006], [-0.1, 0, 0], [0.86, 1.1, 1.06]);
    P.add(B.neck, top, capsule(0.075, 0.07), [0, 0.04, -0.045], [0.3, 0, 0], [1.2, 1, 1]);
  }

  // ---- arms ----
  for (const side of ['L', 'R']) {
    const ua = B['upperArm' + side], fa = B['foreArm' + side], hd = B['hand' + side];
    const sx = side === 'L' ? 1 : -1;
    P.add(ua, top, capsule(0.052, 0.2), [0, -0.135, 0], [0, 0, 0], [bx, 1, bx]);
    P.add(fa, top, capsule(0.044, 0.17), [0, -0.115, 0], [0, 0, 0], [bx, 1, bx]);
    P.add(fa, topDark, cyl(0.046 * bx, 0.046 * bx, 0.03, 10, true), [0, -0.235, 0]);   // cuff
    P.add(hd, hands, capsule(0.03, 0.05), [0, -0.06, 0.004], [0, 0, 0], [1.25, 1, 0.65]);      // palm
    P.add(hd, hands, capsule(0.022, 0.05), [0, -0.1, 0.014], [0, 0, Math.PI / 2], [1, 1, 0.9]); // fingers (fist)
    P.add(hd, hands, capsule(0.012, 0.03), [-sx * 0.026, -0.05, 0.022], [0.5, 0, -sx * 0.4]);  // thumb
  }

  // ---- legs ----
  for (const side of ['L', 'R']) {
    const th = B['thigh' + side], sh = B['shin' + side], ft = B['foot' + side];
    const sx = side === 'L' ? 1 : -1;
    P.add(th, legs, capsule(0.079, 0.3), [0, -0.21, 0], [0, 0, 0], [bx, 1, 1.05 * bx]);
    P.add(sh, legs, capsule(0.058, 0.28), [0, -0.19, 0], [0, 0, 0], [1, 1, 1.05]);
    if (L.legsKind === 'cargo' || L.legsKind === 'work') {
      P.add(th, legsDark, box(0.03, 0.12, 0.11), [sx * 0.08 * bx, -0.25, 0.0]);
    }
    if (L.legsKind === 'work') P.add(sh, legsDark, box(0.11, 0.09, 0.03), [0, -0.0, 0.055]);   // knee pads
    P.add(sh, boots, cyl(0.057, 0.06, 0.13, 10), [0, -0.36, 0]);
    P.add(ft, boots, capsule(0.05, 0.17), [0, -0.035, 0.055], [Math.PI / 2, 0, 0], [1.05, 1, 0.82]);
    P.add(ft, sole, box(0.1, 0.026, 0.28), [0, -0.072, 0.05]);
  }

  P.build(meshes);

  // ---- weapon in the right hand ----
  const weapon = buildWeapon(weaponType, meshes);
  weapon.group.position.copy(SKEL.handGrip);
  B.handR.add(weapon.group);
  const handMag = new THREE.Mesh(weapon.magGeom, weapon.magMesh.material);
  handMag.position.copy(weapon.handMagPos);
  handMag.visible = false;
  handMag.castShadow = true;
  B.handL.add(handMag);

  const muzzleObj = new THREE.Object3D(); muzzleObj.position.copy(weapon.muzzle); weapon.group.add(muzzleObj);
  const ejectObj = new THREE.Object3D(); ejectObj.position.copy(weapon.eject); weapon.group.add(ejectObj);

  const ch = {
    root, bones: B, weapon, handMag, muzzleObj, ejectObj, meshes,
    look, weaponType, height, scale, bulk,
    getEye(out) { return B.head.localToWorld(out.copy(SKEL.eye)); },
    getHeadCenter(out) { return B.head.localToWorld(out.copy(SKEL.headCenter)); },
    getMuzzle(out) { return muzzleObj.getWorldPosition(out); },
    getEject(out) { return ejectObj.getWorldPosition(out); },
    getWeaponForward(out) { weapon.group.getWorldQuaternion(_q); return out.set(0, 0, 1).applyQuaternion(_q); },
    dispose() {
      root.removeFromParent();
      weapon.group.removeFromParent();
      const done = new Set();
      for (const m of meshes) if (!done.has(m.geometry)) { done.add(m.geometry); m.geometry.dispose(); }
    },
  };
  return ch;
}

function darken(hex, f) {
  const r = ((hex >> 16) & 255) * f, g = ((hex >> 8) & 255) * f, b = (hex & 255) * f;
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
}

// ---------------------------------------------------------------------------------------------
// Hit shapes (analytic, follow the animated bones)
// ---------------------------------------------------------------------------------------------
export function createHitShapes() {
  const cap = () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 });
  return {
    center: new THREE.Vector3(), radius: 1.2,
    head: { c: new THREE.Vector3(), r: 0.115 },
    torso: cap(),
    limbs: Array.from({ length: 8 }, cap),
  };
}

const _hp = new THREE.Vector3();
export function updateHitShapes(ch, hs) {
  const B = ch.bones, s = ch.scale;
  const pos = (bone, out) => out.setFromMatrixPosition(bone.matrixWorld);
  ch.getHeadCenter(hs.head.c); hs.head.r = 0.118 * s;
  pos(B.pelvis, hs.torso.a);
  pos(B.neck, _hp);
  // torso capsule from slightly below the pelvis joint to just under the neck
  hs.torso.b.lerpVectors(hs.torso.a, _hp, 0.9);
  hs.torso.a.lerp(_hp, -0.05);
  hs.torso.r = 0.165 * s;
  const L = hs.limbs;
  pos(B.upperArmL, L[0].a); pos(B.foreArmL, L[0].b); L[0].r = 0.065 * s;
  pos(B.upperArmR, L[1].a); pos(B.foreArmR, L[1].b); L[1].r = 0.065 * s;
  pos(B.foreArmL, L[2].a); B.handL.localToWorld(L[2].b.set(0, -0.08, 0)); L[2].r = 0.055 * s;
  pos(B.foreArmR, L[3].a); B.handR.localToWorld(L[3].b.set(0, -0.08, 0)); L[3].r = 0.055 * s;
  pos(B.thighL, L[4].a); pos(B.shinL, L[4].b); L[4].r = 0.09 * s;
  pos(B.thighR, L[5].a); pos(B.shinR, L[5].b); L[5].r = 0.09 * s;
  pos(B.shinL, L[6].a); pos(B.footL, L[6].b); L[6].r = 0.07 * s;
  pos(B.shinR, L[7].a); pos(B.footR, L[7].b); L[7].r = 0.07 * s;
  hs.center.copy(hs.torso.a).lerp(hs.torso.b, 0.3);
  hs.radius = 1.25 * s;
}

/** Ray (unit dir) vs sphere: distance or -1. */
export function raySphere(o, d, c, r, maxT) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxT ? t : -1;
}

/** Ray (unit dir) vs capsule a-b radius r: distance or -1. */
export function rayCapsule(o, d, a, b, r, maxT) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const Bq = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = Bq * Bq - A * C;
  if (A > 1e-9 && h >= 0) {
    const t = (-Bq - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0 && t <= maxT) return t;
  }
  // caps
  let best = -1;
  const t1 = raySphere(o, d, a, r, maxT);
  if (t1 >= 0) best = t1;
  const t2 = raySphere(o, d, b, r, maxT);
  if (t2 >= 0 && (best < 0 || t2 < best)) best = t2;
  return best;
}
