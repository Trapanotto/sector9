import * as THREE from 'three';
import { SKEL, BONE_NAMES, buildBones, applyBindPose } from './rig.js';
import { generateBody, SLOT } from './bodygen.js';
import { getCharacterMaterial, CLOTH_SETS } from './charmat.js';
import { getWeaponGeometry } from './weapons.js';

// Procedural clothed human: ONE skinned mesh per character (bodygen.js builds the geometry from signed-distance
// anatomy and garments, bound to a THREE.Skeleton whose bones are exactly the joint hierarchy the animator
// and ragdoll drive), plus a weapon mesh and its magazine. Modelled at 1.80 m facing +Z, the root is scaled to
// the requested height. No DOM access (runs in Node for tests).

export { SKEL };

// ---------------------------------------------------------------------------------------------
// Looks: garment geometry choices + colours
// ---------------------------------------------------------------------------------------------
const pick = (a) => a[(Math.random() * a.length) | 0];
const SKIN = [0xc89e80, 0xb0846a, 0x94664a, 0x6c4a35, 0xd2ab90, 0x8a5e44];
const HAIR = [0x1a1512, 0x2a1f17, 0x3e2e20, 0x121110, 0x544536];

export const LOOKS = [
  () => ({ name: 'hoodie', top: 'hoodie', topColor: pick([0x34373b, 0x41443e, 0x262a31, 0x4d453b, 0x55302c, 0x5a5f63]),
    hood: pick(['down', 'down', 'up']), headwear: pick(['beanie', 'none', 'none']), headColor: pick([0x2b2b2b, 0x3d2f2a, 0x22303a, 0x5b4630]),
    face: 'bare', legsKind: 'denim', legs: pick([0x2e3644, 0x2b2d33, 0x3b424c, 0x283040]), boots: pick([0x3a2c20, 0x1c1b1a, 0x4a3e33]), gloves: false }),
  () => ({ name: 'workjacket', top: 'jacket', topColor: pick([0x5e4d36, 0x4c4f3a, 0x45413a, 0x37404a]),
    headwear: pick(['cap', 'beanie', 'none']), headColor: pick([0x2e3338, 0x3a3a30, 0x5a4630]), face: 'bare',
    legsKind: 'work', legs: pick([0x5f5848, 0x4a463c, 0x3a3d3c]), boots: 0x3a2a1c, gloves: Math.random() < 0.4 }),
  () => ({ name: 'balaclava', top: 'hoodie', topColor: pick([0x1f2023, 0x2c2d2b, 0x363830]), hood: 'up', headwear: 'none',
    face: 'balaclava', legsKind: 'cargo', legs: pick([0x26272b, 0x33352d, 0x3a372e]), boots: 0x181716, gloves: true }),
  () => ({ name: 'leather', top: 'leather', topColor: pick([0x1e1a17, 0x2f241b, 0x3b2a1f]), headwear: 'none', face: 'bare',
    legsKind: 'denim', legs: pick([0x46484c, 0x2a303c, 0x323a4a]), boots: 0x1d1814, gloves: false }),
  () => ({ name: 'vest', top: 'shirt', topColor: pick([0x4a3a36, 0x3e4446, 0x5b5544, 0x2c3238]), vest: pick([0x41463a, 0x2a2c2a, 0x504838]),
    headwear: pick(['cap', 'beanie']), headColor: pick([0x2a2c2e, 0x34352c]), face: pick(['balaclava', 'bare']),
    legsKind: 'cargo', legs: pick([0x3c3e35, 0x2c2e30, 0x4a4436]), boots: 0x221d18, gloves: true }),
];

export function randomLook(index) {
  const f = index != null ? LOOKS[index % LOOKS.length] : pick(LOOKS);
  const l = f();
  l.skin = pick(SKIN); l.hairColor = pick(HAIR);
  l.hair = Math.random() < 0.15 ? 'bald' : Math.random() < 0.3 ? 'buzz' : 'short';
  l.stubble = Math.random() < 0.45;
  return l;
}

// Geometry variety is limited to GEO_VARIANTS body meshes (each costs ~0.25 s of surface nets at load); colours,
// skin, hair colour, height and weapon stay random per enemy, so repeats do not read as clones.
export const GEO_VARIANTS = 12;
const GEO_KEYS = ['top', 'hood', 'headwear', 'face', 'hair', 'legsKind', 'vest', 'gloves', 'stubble'];
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Deterministic garment geometry for variant v (0..GEO_VARIANTS-1) with random colours; bulk bucket included. */
export function lookFor(v) {
  v = ((v % GEO_VARIANTS) + GEO_VARIANTS) % GEO_VARIANTS;
  const rnd = Math.random;
  let geo;
  try { Math.random = seeded(v * 7919 + 17); geo = randomLook(v); } finally { Math.random = rnd; }
  const look = randomLook(v);
  for (const k of GEO_KEYS) look[k] = geo[k];
  return { look, bulk: [0.95, 1.0, 1.06][v % 3] };
}
/** Build every body variant ahead of time in small steps (keeps the loading screen alive). */
export async function prewarmBodies(onStep) {
  for (let v = 0; v < GEO_VARIANTS; v++) {
    const { look, bulk } = lookFor(v);
    generateBody(look, bulk);
    onStep?.(v + 1, GEO_VARIANTS);
    await new Promise((r) => setTimeout(r, 0));
  }
}

// slot -> { color, set (cloth texture index or -1), rough, metal }
function palette(L) {
  const d = (hex, f) => { const c = new THREE.Color().setHex(hex); return c.multiplyScalar(f); };
  const C = (hex) => new THREE.Color().setHex(hex);
  const set = (n) => CLOTH_SETS.indexOf(n);
  const P = [];
  const topSet = L.top === 'hoodie' ? 'knit' : L.top === 'leather' ? 'leather' : L.top === 'jacket' ? 'denim' : 'cotton';
  const topRough = L.top === 'leather' ? 0.38 : 0.9;
  const legsSet = L.legsKind === 'denim' ? 'denim' : L.legsKind === 'work' ? 'denim' : 'cotton';
  const skin = C(L.skin);
  const hairC = L.hair === 'bald' ? skin.clone().multiplyScalar(0.92) : C(L.hairColor);
  P[SLOT.skin] = { c: skin, s: -1, r: 0.52, m: 0 };
  P[SLOT.top] = { c: C(L.topColor), s: set(topSet), r: topRough, m: 0 };
  P[SLOT.topTrim] = { c: d(L.topColor, L.top === 'leather' ? 0.85 : 0.8), s: set(L.top === 'hoodie' ? 'knit' : topSet), r: topRough, m: 0 };
  P[SLOT.legs] = { c: C(L.legs), s: set(legsSet), r: 0.88, m: 0 };
  P[SLOT.legsTrim] = { c: d(L.legs, 0.82), s: set(legsSet), r: 0.9, m: 0 };
  P[SLOT.boots] = { c: C(L.boots), s: set('leather'), r: 0.55, m: 0 };
  P[SLOT.sole] = { c: C(0x161514), s: -1, r: 0.92, m: 0 };
  P[SLOT.hair] = { c: hairC, s: -1, r: L.hair === 'bald' ? 0.45 : 0.62, m: 0 };
  P[SLOT.headwear] = { c: C(L.headColor || 0x2b2b2b), s: set(L.headwear === 'beanie' ? 'knit' : 'cotton'), r: 0.95, m: 0 };
  P[SLOT.balaclava] = { c: C(0x151515), s: set('knit'), r: 1.0, m: 0 };
  P[SLOT.belt] = { c: C(0x1f1814), s: set('leather'), r: 0.5, m: 0 };
  P[SLOT.metal] = { c: C(0x6b6a66), s: -1, r: 0.35, m: 0.85 };
  P[SLOT.vest] = { c: C(L.vest || 0x41463a), s: set('cotton'), r: 0.92, m: 0 };
  P[SLOT.vestTrim] = { c: d(L.vest || 0x41463a, 0.8), s: set('cotton'), r: 0.92, m: 0 };
  P[SLOT.gloves] = { c: C(0x1a1817), s: set('leather'), r: 0.6, m: 0 };
  P[SLOT.eyeWhite] = { c: C(0x8e857b), s: -1, r: 0.12, m: 0 };
  P[SLOT.iris] = { c: C(0x3a2616), s: -1, r: 0.08, m: 0 };
  P[SLOT.lips] = { c: skin.clone().multiply(new THREE.Color(0.97, 0.86, 0.84)), s: -1, r: 0.4, m: 0 };
  P[SLOT.cord] = { c: C(0xb2ad9f), s: set('cotton'), r: 0.9, m: 0 };
  return P;
}

const _box = new THREE.Box3();
function makeBodyGeometry(gen, L) {
  const P = palette(L);
  const n = gen.slot.length;
  const col = new Float32Array(n * 3), surf = new Float32Array(n * 4), pbr = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const p = P[gen.slot[v]] || P[SLOT.top];
    col[v * 3] = p.c.r * gen.shade[v * 3]; col[v * 3 + 1] = p.c.g * gen.shade[v * 3 + 1]; col[v * 3 + 2] = p.c.b * gen.shade[v * 3 + 2];
    if (p.s >= 0) surf[v * 4 + p.s] = 1;
    pbr[v * 2] = p.r; pbr[v * 2 + 1] = p.m;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(gen.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(gen.normal, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(gen.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(gen.skinWeight, 4));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4));
  g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 2));
  g.setIndex(new THREE.BufferAttribute(gen.index, 1));
  g.boundingBox = _box.set(new THREE.Vector3(-1, -0.2, -1), new THREE.Vector3(1, 2, 1)).clone();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.0);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------------------------
const _q = new THREE.Quaternion();
/**
 * @param {{weaponType?:'pistol'|'rifle', height?:number, look?:object, bulk?:number, renderer?:THREE.WebGLRenderer}} opts
 */
export function createCharacter(opts = {}) {
  const weaponType = opts.weaponType || 'pistol';
  const height = opts.height ?? 1.75 + Math.random() * 0.15;
  const look = opts.look || randomLook();
  const bulk = opts.bulk ?? 0.94 + Math.random() * 0.14;
  const scale = height / SKEL.baseHeight;
  const material = getCharacterMaterial(opts.renderer);

  const root = new THREE.Group();
  root.name = 'enemy';
  root.scale.setScalar(scale);
  const B = buildBones(root);

  // ---- skinned body: bind in the A-pose, then return to the identity rest the animator expects ----
  const gen = generateBody(look, bulk);
  const geometry = makeBodyGeometry(gen, look);
  const body = new THREE.SkinnedMesh(geometry, material);
  body.name = 'enemy_body';
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);
  applyBindPose(B);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(BONE_NAMES.map((n) => B[n]));
  body.bind(skeleton, body.matrixWorld.clone());
  for (const n of BONE_NAMES) B[n].rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  body.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.0);

  // ---- weapon in the right hand ----
  const wg = getWeaponGeometry(weaponType, weaponType === 'rifle' && Math.random() < 0.5);
  const group = new THREE.Group();
  group.name = 'enemy_weapon_' + weaponType;
  const wMesh = new THREE.Mesh(wg.body, material);
  wMesh.castShadow = true; wMesh.receiveShadow = true;
  group.add(wMesh);
  const magMesh = new THREE.Mesh(wg.mag, material);
  magMesh.position.copy(wg.magPos);
  magMesh.castShadow = true;
  group.add(magMesh);
  const info = wg.info;
  // weapon pose inside the hand = inverse of the hand pose in the weapon frame
  group.quaternion.copy(info.rightQuat).invert();
  group.position.copy(info.rightWrist).applyQuaternion(group.quaternion).negate();
  B.handR.add(group);
  const weapon = {
    group, magMesh, magGeom: wg.mag, type: weaponType,
    muzzle: info.muzzle, eject: info.eject, rightWrist: info.rightWrist, rightQuat: info.rightQuat,
    supportPos: info.supportPos, supportQuat: info.supportQuat, magwell: info.magwell, handMagPos: info.handMagPos,
  };
  const handMag = new THREE.Mesh(wg.mag, material);
  handMag.position.copy(info.handMagPos);
  handMag.rotation.set(Math.PI / 2, 0, 0);
  handMag.visible = false;
  handMag.castShadow = true;
  B.handL.add(handMag);

  const muzzleObj = new THREE.Object3D(); muzzleObj.position.copy(info.muzzle); group.add(muzzleObj);
  const ejectObj = new THREE.Object3D(); ejectObj.position.copy(info.eject); group.add(ejectObj);
  const meshes = [body, wMesh, magMesh, handMag];

  return {
    root, bones: B, skeleton, body, weapon, handMag, muzzleObj, ejectObj, meshes,
    look, weaponType, height, scale, bulk,
    getEye(out) { return B.head.localToWorld(out.copy(SKEL.eye)); },
    getHeadCenter(out) { return B.head.localToWorld(out.copy(SKEL.headCenter)); },
    getMuzzle(out) { return muzzleObj.getWorldPosition(out); },
    getEject(out) { return ejectObj.getWorldPosition(out); },
    getWeaponForward(out) { group.getWorldQuaternion(_q); return out.set(0, 0, 1).applyQuaternion(_q); },
    dispose() {
      root.removeFromParent();
      group.removeFromParent();
      geometry.dispose();   // per-character attributes; weapon geometry is shared and kept
      skeleton.dispose();
    },
  };
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
