// First-person arms (stage 2): pistol, contact-solved two-handed grip, authored clips, export.
// usage: node build_arms.mjs <cache_dir> <arms_raw.glb> <out_dir>
//
// Output fp_arms_pistol.glb (ONE skinned mesh, ONE material: arms + gloves + sleeves + pistol):
//   fp_root (rotated 180 deg about Y; origin = CHEST CAMERA (bodycam), looking down -Z like a three.js camera)
//     ├─ fp_arms (SkinnedMesh)
//     └─ root … hand_r ─ pistol (joint) ─ pistol_slide / pistol_trigger / pistol_magazine (joints)
//                                        └ pistol_muzzle, pistol_port, pistol_sight_rear (markers)
// v2 rework (C): camera-referenced hold poses (gun 30-35 cm in front of the chest camera, slightly below the
// centre, top/rear of the slide visible), elbows down (forearms enter from the lower corners), wrapping finger
// solver (support fingers close around the strong hand), CCD-placed thumbs (both forward along the frame),
// trigger finger that follows the trigger, re-authored tactical + empty reloads with per-frame contact solving.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, quantize, meshopt, prune, dedup, resample } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { loadGLB, THREE } from './threeio.mjs';
import { Rig, V, curve, smooth, deg } from './rig.mjs';
import { readJSON } from './animlib.mjs';
import {
  PARTS, PART_REST, SLIDE_TRAVEL, MAG_AXIS, SIGHT_REAR, SIGHT_FRONT, MUZZLE, PORT, TRIGGER_TRAVEL, COL,
  partGeometry, sdPart,
} from './fppistol.mjs';

const [, , cache, rawPath, outDir] = process.argv;
void cache;
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const boneNames = readJSON(path.join(here, 'skeleton.json')).arms.map((b) => b[0]);
const raw = await loadGLB(rawPath);
let mesh, rootBone;
raw.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; if (o.isBone && o.name === 'root') rootBone = o; });
const R = new Rig(rootBone, boneNames);
const DEBUG = process.env.ARMS_DEBUG === '1';

// ----------------------------------------------------------------------------- CPU skinning
const geo = mesh.geometry;
const P0 = geo.attributes.position, SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight;
const skBones = mesh.skeleton.bones.map((b) => b.name);
const IBM = mesh.skeleton.boneInverses;
const NV = P0.count;
const dom = new Array(NV);
for (let i = 0; i < NV; i++) {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > bw) { bw = w; best = SI.getComponent(i, k); } }
  dom[i] = skBones[best];
}
const vertsOf = (pred) => { const a = []; for (let i = 0; i < NV; i++) if (pred(dom[i])) a.push(i); return a; };
const _mm = new THREE.Matrix4(), _vv = new THREE.Vector3();
const boneIdx = skBones.map((n) => R.b[n]);
function skinned(i, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const w = SW.getComponent(i, k);
    if (!w) continue;
    const bi = SI.getComponent(i, k);
    _mm.multiplyMatrices(boneIdx[bi].matrixWorld, IBM[bi]);
    _vv.fromBufferAttribute(P0, i).applyMatrix4(_mm);
    out.addScaledVector(_vv, w);
  }
  return out;
}

// ----------------------------------------------------------------------------- gun state + SDF (cached)
const gun = { pos: V(), quat: new THREE.Quaternion(), slide: 0, trig: 0, mag: { p: V(), q: new THREE.Quaternion(), s: 1 } };
function partMatrix(part) {
  const rest = PART_REST[part];
  const m = new THREE.Matrix4();
  if (part === 'magazine') return m.compose(gun.mag.p, gun.mag.q, V(1, 1, 1));
  const p = V(...rest.p);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rest.r));
  if (part === 'slide') p.z -= gun.slide;
  if (part === 'trigger') q.multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), gun.trig));
  return m.compose(p, q, V(1, 1, 1));
}
function magRest() {
  gun.mag.p.fromArray(PART_REST.magazine.p);
  gun.mag.q.setFromEuler(new THREE.Euler(...PART_REST.magazine.r));
  gun.mag.s = 1;
}
magRest();
const gunWorld = () => new THREE.Matrix4().compose(gun.pos, gun.quat, V(1, 1, 1));
const PARTNAMES = ['frame', 'slide', 'trigger', 'magazine'];
const sdfCache = { key: NaN, inv: {} };
function gunKey() {
  const { pos: p, quat: q, mag: m } = gun;
  return p.x * 1.3 + p.y * 2.7 + p.z * 4.1 + q.x * 5.3 + q.y * 6.7 + q.z * 7.1 + q.w * 8.3 + gun.slide * 9.7 + gun.trig * 10.1 +
    m.p.x * 11.3 + m.p.y * 12.7 + m.p.z * 13.1 + m.q.x * 14.3 + m.q.y * 15.7 + m.q.z * 16.9 + m.q.w * 17.3 + m.s * 19.1;
}
function prepSDF() {
  const k = gunKey();
  if (k === sdfCache.key) return;
  sdfCache.key = k;
  const gi = gunWorld().invert();
  for (const part of PARTNAMES) sdfCache.inv[part] = partMatrix(part).invert().multiply(gi);
}
const _sp = new THREE.Vector3();
/** signed distance to the pistol (all parts); opts.only = one part; magazine skipped when hidden */
function gunSDF(p, only = null) {
  prepSDF();
  let d = Infinity;
  for (const part of PARTNAMES) {
    if (only && part !== only) continue;
    if (part === 'magazine' && gun.mag.s === 0) continue;
    _sp.copy(p).applyMatrix4(sdfCache.inv[part]);
    d = Math.min(d, sdPart(part, _sp));
  }
  return d;
}

// ----------------------------------------------------------------------------- reference frames
R.reset();
const EYE = R.wpos('Head').add(V(0, 0.075, 0.085));
// chest camera (bodycam on the sternum): 30 cm under the eyes, on the chest surface 13 cm in front of the
// shoulder joints (env CAM_DZ to tune)
const CAM = V(0, EYE.y - 0.3, R.wpos('upperarm_r').z + Number(process.env.CAM_DZ || 0.13));
const STRONG_THUMB = (process.env.STRONG_THUMB || '0.027,0.026,0.015').split(',').map(Number);
const STRONG_THUMB_MCP = (process.env.STRONG_THUMB_MCP || '0.012,0.016,-0.036').split(',').map(Number);
const WEAPON = { gripTilt: 18 };
const GRIP_FINGER_LIFT = Number(process.env.GRIP_LIFT || 15);
function heuristicGrip(s) {
  const { f, n, side } = R.handLocal[s];
  const sd = side.clone().sub(f.clone().multiplyScalar(side.dot(f))).normalize();
  const t = deg(WEAPON.gripTilt);
  const Yw = sd.clone().multiplyScalar(Math.cos(t)).sub(f.clone().multiplyScalar(Math.sin(t))).normalize();
  const Zw = f.clone().multiplyScalar(Math.cos(t)).add(sd.clone().multiplyScalar(Math.sin(t))).normalize();
  const Xw = Yw.clone().cross(Zw).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xw, Yw, Zw));
  return { quat };
}

/**
 * Pose the pistol from the chest camera: rear sight at (x left, y up, z forward) metres from the camera,
 * angles in degrees (pitch up +, yaw left +). conv > 0: sight line converges with the camera axis at conv metres.
 */
function poseGun({ x = 0, y = -0.1, z = 0.33, pitch = 0, yaw = 0, roll = 0, conv = 0 }) {
  let p = pitch, yw = yaw;
  if (conv) { p += (Math.atan2(-y, conv - z) * 180) / Math.PI; yw += (Math.atan2(-x, conv - z) * 180) / Math.PI; }
  gun.quat.setFromEuler(new THREE.Euler(deg(-p), deg(yw), deg(roll), 'YXZ'));
  gun.pos.copy(CAM).add(V(x, y, z)).sub(SIGHT_REAR.clone().applyQuaternion(gun.quat));
}
// hold poses (camera frame). ADS: sights 3.5 cm under the lens axis, 33 cm out, zeroed to the image centre at 15 m.
const HOLD = {
  aim: { x: 0, y: -0.045, z: 0.33, conv: 15 },
  hip: { x: -0.025, y: -0.09, z: 0.3, conv: 12 },
  low: { x: -0.03, y: -0.2, z: 0.28, pitch: -32, yaw: 8 },
  sprint: { x: -0.06, y: -0.29, z: 0.2, pitch: -55, yaw: 18, roll: 12 },
};

const T = { r: null, l: null };
let STRONG_THUMB_SNAP = null;
function handFromGun(Tm) {
  const m = gunWorld().multiply(Tm);
  const p = V(), q = new THREE.Quaternion();
  m.decompose(p, q, V());
  return { p, q };
}
const strongPole = () => R.wpos('upperarm_r').add(V(-0.3, -0.65, 0.05));
const supportPole = () => R.wpos('upperarm_l').add(V(0.3, -0.65, 0.05));
function placeFromGun(s, Tm) {
  const { p, q } = handFromGun(Tm);
  R.placeHand(s, p, q, s === 'r' ? strongPole() : supportPole());
}
function shoulders(k) { // protract shoulders slightly when pushing the gun out
  R.rot('clavicle_l', V(0, 1, 0), deg(-16 * k));
  R.rot('clavicle_r', V(0, 1, 0), deg(16 * k));
}

// ----------------------------------------------------------------------------- contact solving helpers
const MARGIN = 0.0025; // glove surface kept >= 2.5 mm from the gun
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const fingerVerts = {}; // phalanx k and everything distal
const phalanxVerts = {}; // exactly phalanx k
for (const s of ['l', 'r']) for (const f of FINGERS) for (let k = 1; k <= 3; k++) {
  fingerVerts[`${f}${k}${s}`] = vertsOf((b) => { const m = b.match(new RegExp(`^${f}_0(\\d)_${s}$`)); return !!m && Number(m[1]) >= k; });
  phalanxVerts[`${f}${k}${s}`] = vertsOf((b) => b === `${f}_0${k}_${s}`);
}
const palmVerts = { l: vertsOf((b) => b === 'hand_l'), r: vertsOf((b) => b === 'hand_r') };
const gloveVerts = { l: vertsOf((b) => /^(hand|thumb|index|middle|ring|pinky)(_0\d)?_l$/.test(b)), r: vertsOf((b) => /^(hand|thumb|index|middle|ring|pinky)(_0\d)?_r$/.test(b)) };
let obstacles = []; // capsules [a, b, r] (strong hand, for the support hand)
function capsuleSD(p, [a, b, r]) {
  const ab = b.clone().sub(a), ap = p.clone().sub(a);
  const h = Math.min(1, Math.max(0, ap.dot(ab) / ab.lengthSq()));
  return ap.sub(ab.multiplyScalar(h)).length() - r;
}
const field = (p, withObs) => { let d = gunSDF(p); if (withObs) for (const c of obstacles) d = Math.min(d, capsuleSD(p, c)); return d; };
function minDist(verts, withObs = false) {
  let d = Infinity, worst = null;
  const v = new THREE.Vector3();
  for (const i of verts) {
    skinned(i, v);
    const dd = field(v, withObs);
    if (dd < d) { d = dd; worst = v.clone(); }
  }
  return { d, worst };
}
/**
 * Wrapping curl: all free joints flex together (ratio); when a phalanx touches, that joint and every joint
 * proximal to it freeze and the distal joints keep closing -> fingers wrap around the object.
 */
function wrapCurl(s, finger, { max = [95, 100, 85], step = 1.5, withObs = false, margin = MARGIN, ratio = [1, 1.2, 0.9] } = {}) {
  const tot = [0, 0, 0];
  // start inside? open joint 1 first
  let guard = 0;
  while (minDist(fingerVerts[`${finger}1${s}`], withObs).d < margin && guard++ < 40) { R.curl(s, { [finger]: [-step, -step * 0.5, 0] }); tot[0] -= step; tot[1] -= step * 0.5; }
  let frozen = 0;
  while (frozen < 3) {
    const inc = [0, 0, 0];
    let any = false;
    for (let j = frozen; j < 3; j++) if (tot[j] + step * ratio[j] <= max[j]) { inc[j] = step * ratio[j]; any = true; }
    if (!any) break;
    R.curl(s, { [finger]: inc });
    for (let j = 0; j < 3; j++) tot[j] += inc[j];
    let hit = 0;
    for (let k = 3; k >= 1 && !hit; k--) if (minDist(phalanxVerts[`${finger}${k}${s}`], withObs).d < margin) hit = k;
    if (hit) {
      R.curl(s, { [finger]: inc.map((v) => -v) });
      for (let j = 0; j < 3; j++) tot[j] -= inc[j];
      frozen = Math.max(frozen + 1, hit);
    }
  }
  return tot.map((v) => +v.toFixed(1));
}
/** world fingertip (distal joint + ext along the last phalanx) */
function tipOf(s, finger, ext) {
  const a = R.wpos(`${finger}_02_${s}`), b = R.wpos(`${finger}_03_${s}`);
  return b.clone().add(b.clone().sub(a).normalize().multiplyScalar(ext));
}
/** CCD: bring a fingertip point (ext beyond the distal joint) onto a world target */
function ccd(s, finger, target, { ext = 0.012, iters = 16, damp = 0.5 } = {}) {
  const chain = [1, 2, 3].map((k) => `${finger}_0${k}_${s}`);
  for (let it = 0; it < iters; it++) {
    for (let j = 2; j >= 0; j--) {
      const jp = R.wpos(chain[j]);
      const a = tipOf(s, finger, ext).sub(jp).normalize(), b = target.clone().sub(jp).normalize();
      const q = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a, b), damp);
      R.setWorldQuat(chain[j], q.multiply(R.wquat(chain[j])));
      R.update();
    }
  }
  return tipOf(s, finger, ext).distanceTo(target);
}
/**
 * Thumb placement by search: swing thumb_01 about the palm normal and the finger axis, flex 02/03; keep the
 * candidate whose tip is closest to the target while the whole thumb stays clear of the gun (+ obstacles).
 */
function searchThumb(s, targetW, { withObs = false, ext = 0.012, margin = MARGIN, mcpW = null } = {}) {
  const b1 = `thumb_01_${s}`, b2 = `thumb_02_${s}`, b3 = `thumb_03_${s}`;
  const q0 = [b1, b2, b3].map((b) => R.b[b].quaternion.clone());
  const reset = () => { [b1, b2, b3].forEach((b, i) => R.b[b].quaternion.copy(q0[i])); R.update(); };
  const fr = R.handFrame(s);
  const verts = fingerVerts[`thumb1${s}`];
  let best = null;
  const cost = () => tipOf(s, 'thumb', ext).distanceTo(targetW) + (mcpW ? R.wpos(b2).distanceTo(mcpW) * 0.7 : 0);
  const tryPose = (a, b, c2, c3, sp2) => {
    reset();
    R.rot(b1, fr.n, deg(a)); R.rot(b1, fr.f, deg(b));
    if (sp2) R.rot(b2, fr.n, deg(sp2));
    R.curl(s, { thumb: [0, c2, c3] });
    const d = cost();
    if (best && d >= best.d) return;
    if (minDist(verts, withObs).d < margin) return;
    best = { a, b, c2, c3, sp2, d };
  };
  for (let a = -90; a <= 90; a += 10) for (let b = -90; b <= 90; b += 10) for (const c2 of [-20, 0, 20, 40]) tryPose(a, b, c2, c2 * 0.6, 0);
  if (best) {
    const b0 = { ...best };
    for (let a = b0.a - 8; a <= b0.a + 8; a += 2) for (let b = b0.b - 8; b <= b0.b + 8; b += 2) for (let c2 = b0.c2 - 10; c2 <= b0.c2 + 10; c2 += 5) for (const sp2 of [-20, -10, 0, 10, 20]) tryPose(a, b, c2, c2 * 0.6, sp2);
  }
  reset();
  if (!best) return { miss: Infinity };
  R.rot(b1, fr.n, deg(best.a)); R.rot(b1, fr.f, deg(best.b)); if (best.sp2) R.rot(b2, fr.n, deg(best.sp2)); R.curl(s, { thumb: [0, best.c2, best.c3] });
  return { cost: +best.d.toFixed(4), tipMiss: +tipOf(s, 'thumb', ext).distanceTo(targetW).toFixed(4), mcpMiss: mcpW ? +R.wpos(b2).distanceTo(mcpW).toFixed(4) : null, swing: [best.a, best.b, best.sp2], flex: [best.c2, +best.c3.toFixed(1)] };
}
/** trigger finger by search: distal pad onto the blade's front face, nothing inside the gun */
function searchIndexTrigger() {
  const s = 'r';
  const bs = ['index_01_r', 'index_02_r', 'index_03_r'];
  const q0 = bs.map((b) => R.b[b].quaternion.clone());
  const reset = () => { bs.forEach((b, i) => R.b[b].quaternion.copy(q0[i])); R.update(); };
  const n = R.handFrame(s).n;
  const all = fingerVerts.index1r, dist = phalanxVerts.index3r;
  const face = TRIG_FACE(); // gun local
  const gi = gunWorld().invert();
  let best = null;
  const v = V();
  const tryPose = (sp, f1, f2, f3) => {
    reset();
    R.rot('index_01_r', n, deg(sp));
    R.curl(s, { index: [f1, f2, f3] });
    let pen = Infinity;
    for (const i of all) { skinned(i, v); pen = Math.min(pen, gunSDF(v)); if (pen < MARGIN * 0.6) return; }
    let gap = Infinity, cp = null;
    for (const i of dist) { skinned(i, v); const d = gunSDF(v, 'trigger'); if (d < gap) { gap = d; cp = v.clone(); } }
    const lp = cp.applyMatrix4(gi);
    const score = Math.abs(gap - MARGIN) * 4 + Math.abs(lp.y - face.y) + Math.abs(lp.x) * 0.5;
    if (!best || score < best.score) best = { sp, f1, f2, f3, score, gap };
  };
  for (let sp = -25; sp <= 10; sp += 5) for (let f1 = 0; f1 <= 70; f1 += 5) for (let f2 = 0; f2 <= 90; f2 += 6) for (const k of [0.3, 0.7]) tryPose(sp, f1, f2, f2 * k);
  if (best) {
    const b0 = { ...best };
    for (let sp = b0.sp - 4; sp <= b0.sp + 4; sp += 2) for (let f1 = b0.f1 - 4; f1 <= b0.f1 + 4; f1 += 2) for (let f2 = b0.f2 - 6; f2 <= b0.f2 + 6; f2 += 2) for (const k of [0.4, 0.6, 0.8]) tryPose(sp, f1, f2, f2 * k);
  }
  reset();
  if (!best) return { fail: true };
  R.rot('index_01_r', n, deg(best.sp));
  R.curl(s, { index: [best.f1, best.f2, best.f3] });
  return { spread: best.sp, flex: [best.f1, best.f2, +best.f3.toFixed(1)], gapToBlade_m: +best.gap.toFixed(4) };
}
/** open a finger (distal first) until clear of the field */
function openUntilClear(s, finger, withObs = false, margin = MARGIN) {
  let n = 0;
  while (minDist(fingerVerts[`${finger}1${s}`], withObs).d < margin && n++ < 60) R.curl(s, { [finger]: [-0.5, -1, -1] });
  return n;
}
/** push a hand (rigidly, in gun space) out of the field along the gradient */
function pushOut(s, Tm, verts, withObs = false) {
  for (let it = 0; it < 40; it++) {
    placeFromGun(s, Tm);
    const { d, worst } = minDist(verts, withObs);
    if (d >= MARGIN) return d;
    const e = 0.001, g = V();
    for (const [ax, vec] of [['x', V(e, 0, 0)], ['y', V(0, e, 0)], ['z', V(0, 0, e)]]) g[ax] = (field(worst.clone().add(vec), withObs) - field(worst.clone().sub(vec), withObs)) / (2 * e);
    g.normalize();
    const gl = g.applyQuaternion(gun.quat.clone().invert()).multiplyScalar(MARGIN - d + 0.0005);
    Tm.premultiply(new THREE.Matrix4().makeTranslation(gl.x, gl.y, gl.z));
  }
  return minDist(verts, withObs).d;
}
function slideUntil(s, Tm, dirGun, verts, { maxD = 0.12, step = 0.001, withObs = false } = {}) {
  let moved = 0;
  const dv = dirGun.clone().normalize().multiplyScalar(step);
  const stepM = new THREE.Matrix4().makeTranslation(dv.x, dv.y, dv.z);
  while (moved < maxD) {
    const trial = Tm.clone().premultiply(stepM);
    placeFromGun(s, trial);
    if (minDist(verts, withObs).d < MARGIN) break;
    Tm.copy(trial);
    moved += step;
  }
  placeFromGun(s, Tm);
  return +moved.toFixed(4);
}
const fingerSnap = (s, only = FINGERS) => Object.fromEntries(only.flatMap((f) => [1, 2, 3].map((k) => `${f}_0${k}_${s}`)).map((n) => [n, R.b[n].quaternion.clone()]));
const applyFingers = (snap) => { for (const [n, q] of Object.entries(snap)) R.b[n].quaternion.copy(q); R.update(); };
const blendFingers = (a, b, w) => { for (const n of Object.keys(a)) R.b[n].quaternion.copy(a[n]).slerp(b[n], w); R.update(); };
const restFingers = (s, only = FINGERS) => { for (const f of only) for (let k = 1; k <= 3; k++) R.b[`${f}_0${k}_${s}`].quaternion.copy(R.restQ[`${f}_0${k}_${s}`]); R.update(); };
const G = (x, y, z) => V(x, y, z).applyMatrix4(gunWorld()); // gun-local point -> world

const report = { margin_m: MARGIN, camera: { eye: EYE.toArray(), cam: CAM.toArray() }, grip: {} };

// ----------------------------------------------------------------------------- grip solve (in the ADS pose)
R.reset();
poseGun(HOLD.aim);
shoulders(1);
{
  // anatomical placement: index knuckle high on the right side at the top of the front strap, little-finger
  // knuckle lower on the right side, wrist behind/right of the grip (web of the hand high in the beavertail);
  // rigid fit of the three hand points (hand-local, rest) onto these gun-local targets
  const env3 = (k, d) => V(...(process.env[k] || d).split(',').map(Number)).multiplyScalar(0.01);
  // (third point: the thumb's CMC joint behind the backstrap -> the web wraps the backstrap, thumb comes round)
  const tgt = { index: env3('G_INDEX', '-2.9,0.8,1.2'), pinky: env3('G_PINKY', '-2.6,-4.0,-0.6'), wrist: env3('G_CMC', '-1.2,0.6,-6.0') };
  const loc = { index: R.b.index_01_r.position.clone(), pinky: R.b.pinky_01_r.position.clone(), wrist: R.b.thumb_01_r.position.clone() };
  const frame = (a, b, c) => {
    const e1 = a.clone().sub(b).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5).sub(c);
    const e2 = mid.sub(e1.clone().multiplyScalar(mid.dot(e1))).normalize();
    return new THREE.Matrix4().makeBasis(e1, e2, e1.clone().cross(e2));
  };
  const Fl = frame(loc.index, loc.pinky, loc.wrist), Fg = frame(tgt.index, tgt.pinky, tgt.wrist);
  const qH = new THREE.Quaternion().setFromRotationMatrix(Fg.multiply(Fl.transpose()));
  const cl = loc.index.clone().add(loc.pinky).add(loc.wrist).multiplyScalar(1 / 3).applyQuaternion(qH);
  const cg = tgt.index.clone().add(tgt.pinky).add(tgt.wrist).multiplyScalar(1 / 3);
  T.r = new THREE.Matrix4().compose(cg.sub(cl), qH, V(1, 1, 1));
  void heuristicGrip;
  const moves = [];
  // joint optimisation (coordinate descent) of the hand placement + thumb: palm in contact, index knuckle at
  // its target, thumb MCP behind the backstrap and the thumb tip forward on the left side, nothing inside the gun
  const T0 = T.r.clone();
  const tTip = G(...STRONG_THUMB), tMcp = G(...STRONG_THUMB_MCP), tIdx = G(...tgt.index.toArray());
  const thumbB = ['thumb_01_r', 'thumb_02_r', 'thumb_03_r'];
  const tq0 = thumbB.map((b) => R.b[b].quaternion.clone());
  const pv = palmVerts.r.filter((_, i) => i % 2 === 0), tv = fingerVerts.thumb1r.filter((_, i) => i % 2 === 0);
  const apply = (x) => {
    const m = new THREE.Matrix4().compose(V(x[0], x[1], x[2]).multiplyScalar(0.01), new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(x[3]), deg(x[4]), deg(x[5]))), V(1, 1, 1));
    T.r = m.multiply(T0.clone());
    thumbB.forEach((b, i) => R.b[b].quaternion.copy(tq0[i])); R.update();
    placeFromGun('r', T.r);
    const fr = R.handFrame('r');
    R.rot('thumb_01_r', fr.n, deg(x[6])); R.rot('thumb_01_r', fr.f, deg(x[7])); R.rot('thumb_02_r', fr.n, deg(x[8]));
    R.curl('r', { thumb: [0, x[9], x[10]] });
  };
  const v = V();
  const cost = (x) => {
    apply(x);
    let pen = 0; const near = [];
    for (const i of pv) { skinned(i, v); const d = gunSDF(v); if (d < MARGIN) pen += MARGIN - d; near.push(d); }
    for (const i of tv) { skinned(i, v); const d = gunSDF(v); if (d < MARGIN) pen += MARGIN - d; }
    near.sort((a, b) => a - b);
    let contact = 0; for (let k = 0; k < 25; k++) contact += Math.max(0, near[k] - MARGIN); contact /= 25;
    return pen * 300 + R.wpos('index_01_r').distanceTo(tIdx) + tipOf('r', 'thumb', 0.012).distanceTo(tTip) * 1.2 + R.wpos('thumb_02_r').distanceTo(tMcp) * 0.6 + contact * 2;
  };
  placeFromGun('r', T0);
  const s0 = searchThumb('r', tTip, { mcpW: tMcp });
  thumbB.forEach((b, i) => R.b[b].quaternion.copy(tq0[i])); R.update();
  const x = [0, 0, 0, 0, 0, 0, s0.swing?.[0] || 0, s0.swing?.[1] || 0, s0.swing?.[2] || 0, s0.flex?.[0] || 0, s0.flex?.[1] || 0];
  report.grip.strongThumbSearch = s0;
  const step = [0.6, 0.6, 0.6, 6, 6, 6, 12, 12, 8, 10, 10];
  let c = cost(x);
  for (let round = 0; round < (process.env.OPT === '1' ? 7 : 0); round++) {
    for (let it = 0; it < 4; it++) {
      let improved = false;
      for (let k = 0; k < x.length; k++) for (const sg of [1, -1]) {
        x[k] += sg * step[k];
        const c2 = cost(x);
        if (c2 < c) { c = c2; improved = true; } else x[k] -= sg * step[k];
      }
      if (!improved) break;
    }
    for (let k = 0; k < step.length; k++) step[k] *= 0.55;
  }
  apply(x);
  report.grip.strongOpt = { x: x.map((q) => +q.toFixed(2)), cost: +c.toFixed(4), thumbTipMiss: +tipOf('r', 'thumb', 0.012).distanceTo(tTip).toFixed(4), thumbMcpMiss: +R.wpos('thumb_02_r').distanceTo(tMcp).toFixed(4), indexKnuckleMiss: +R.wpos('index_01_r').distanceTo(tIdx).toFixed(4) };
  STRONG_THUMB_SNAP = fingerSnap('r', ['thumb']);
  moves.push(+pushOut('r', T.r, palmVerts.r).toFixed(4));
  report.grip.strongSlides_m = moves;
  report.grip.strongPalmClearance = +minDist(palmVerts.r).d.toFixed(4);
}
// trigger blade front face (gun space) and the indexed (off-trigger) finger line on the right side of the frame
const TRIG_FACE = () => V(0, 0.03, 0.053).add(V(0, -0.014, 0.0055).applyAxisAngle(V(1, 0, 0), gun.trig)); // pivot + blade face
function solveIndexOnTrigger() {
  restFingers('r', ['index']);
  const res = searchIndexTrigger();
  res.gapAny_m = +minDist(fingerVerts.index1r).d.toFixed(4);
  return res;
}
function solveIndexOff() {
  restFingers('r', ['index']);
  const target = G(-0.019, 0.04, 0.09); // straight along the frame above the trigger guard
  const miss = ccd('r', 'index', target, { ext: 0.012 });
  const opened = openUntilClear('r', 'index');
  return { miss: +miss.toFixed(4), opened };
}
function solveStrongFingers() {
  placeFromGun('r', T.r);
  restFingers('r');
  const out = {};
  for (const f of ['middle', 'ring', 'pinky']) out[f] = wrapCurl('r', f);
  // strong thumb: from the joint hand/thumb optimisation (forward on the left side), kept clear
  applyFingers(STRONG_THUMB_SNAP);
  out.thumbOpened = openUntilClear('r', 'thumb');
  return out;
}
const LOC = (w) => w.clone().applyMatrix4(gunWorld().invert()).toArray().map((v) => +(v * 100).toFixed(1)); // gun-local cm
const CAMF = (w) => { const v = w.clone().sub(CAM); return [+(v.x * 100).toFixed(1), +(v.y * 100).toFixed(1), +(v.z * 100).toFixed(1)]; };
function dumpHand(s, tag) {
  if (!DEBUG) return;
  const o = { tag };
  for (const b of [`hand_${s}`, `thumb_01_${s}`, `thumb_02_${s}`, `thumb_03_${s}`, `index_01_${s}`, `index_03_${s}`]) o[b] = LOC(R.wpos(b));
  o.thumbTip = LOC(tipOf(s, 'thumb', 0.012)); o.indexTip = LOC(tipOf(s, 'index', 0.012));
  o.cam_elbow = CAMF(R.wpos(`lowerarm_${s}`)); o.cam_wrist = CAMF(R.wpos(`hand_${s}`)); o.cam_shoulder = CAMF(R.wpos(`upperarm_${s}`));
  console.log(JSON.stringify(o));
}
placeFromGun('r', T.r); restFingers('r'); dumpHand('r', 'strong rest fingers');
const strongBase = solveStrongFingers();
dumpHand('r', 'strong solved');
const strongCore = fingerSnap('r', ['thumb', 'middle', 'ring', 'pinky']);
gun.trig = 0;
const idxTrig = solveIndexOnTrigger();
const poseIdxTrig = fingerSnap('r', ['index']);
/** follow the trigger blade: flex the index until the distal pad touches the (rotated) blade again */
function followTrigger() {
  const v = V();
  const blade = () => { let g = Infinity; for (const i of phalanxVerts.index3r) { skinned(i, v); g = Math.min(g, gunSDF(v, 'trigger')); } return g; };
  const inside = () => { for (const i of fingerVerts.index1r) { skinned(i, v); if (gunSDF(v) < 0.0008) return true; } return false; };
  const tot = [0, 0, 0];
  for (let k = 0; k < 120 && blade() > MARGIN; k++) {
    const inc = [0.12, 0.3, 0.18];
    R.curl('r', { index: inc });
    if (inside()) { R.curl('r', { index: inc.map((q) => -q) }); break; }
    for (let j = 0; j < 3; j++) tot[j] += inc[j];
  }
  return tot.map((q) => +q.toFixed(2));
}
gun.trig = TRIGGER_TRAVEL;
applyFingers(poseIdxTrig);
const pressExtra = followTrigger();
const poseIdxPress = fingerSnap('r', ['index']);
let pressGap = Infinity; { const v = V(); for (const i of phalanxVerts.index3r) { skinned(i, v); pressGap = Math.min(pressGap, gunSDF(v, 'trigger')); } }
gun.trig = 0;
const idxOff = solveIndexOff();
const poseIdxOff = fingerSnap('r', ['index']);
report.grip.strong = { ...strongBase, indexOnTrigger: idxTrig, indexPressExtraCurl: pressExtra, indexPressGapToBlade_m: +pressGap.toFixed(4), indexOff: idxOff };
const strongTrigSnap = { ...strongCore, ...poseIdxTrig };
const strongOffSnap = { ...strongCore, ...poseIdxOff };

// support hand: palm heel on the left grip panel, fingers wrapped around the strong fingers under the trigger
// guard, thumb forward along the frame under the strong thumb
function strongCapsules() {
  const caps = [];
  for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
    for (let k = 1; k <= 3; k++) {
      const a = R.wpos(`${f}_0${k}_r`);
      const b = k < 3 ? R.wpos(`${f}_0${k + 1}_r`) : a.clone().add(a.clone().sub(R.wpos(`${f}_0${k - 1}_r`)).normalize().multiplyScalar(0.022));
      caps.push([a, b, f === 'thumb' ? 0.0105 : 0.0095]);
    }
  }
  caps.push([R.wpos('hand_r'), R.wpos('middle_01_r'), 0.022]);
  caps.push([R.wpos('hand_r'), R.wpos('index_01_r'), 0.02]);
  caps.push([R.wpos('hand_r'), R.wpos('pinky_01_r'), 0.02]);
  return caps;
}
const SUP = {
  fl: (process.env.SUP_FL || '0,-0.62,0.78').split(',').map(Number), // finger direction (gun space)
  nl: (process.env.SUP_NL || '-1,-0.12,0.05').split(',').map(Number), // palm normal (gun space)
  palm: (process.env.SUP_PALM || '0.068,-0.006,0.012').split(',').map(Number), // palm centre (gun space) before sliding in
  thumb: (process.env.SUP_THUMB || '0.024,0.027,0.105').split(',').map(Number), // thumb tip target (gun space)
};
let supportSnap;
{
  applyFingers(strongTrigSnap);
  placeFromGun('r', T.r);
  obstacles = strongCapsules();
  const qh = R.handQuat('l', V(...SUP.fl).applyQuaternion(gun.quat), V(...SUP.nl).applyQuaternion(gun.quat));
  const { f, n } = R.handLocal.l;
  const palmC = f.clone().multiplyScalar(0.055).add(n.clone().multiplyScalar(0.012));
  const PALM_W = G(...SUP.palm);
  const wristW = PALM_W.sub(palmC.applyQuaternion(qh));
  T.l = gunWorld().invert().multiply(new THREE.Matrix4().compose(wristW, qh, V(1, 1, 1)));
  restFingers('l');
  const moves = [slideUntil('l', T.l, V(-1, 0, 0), palmVerts.l, { withObs: true })];
  moves.push(slideUntil('l', T.l, V(0, 1, 0), palmVerts.l, { withObs: true, maxD: 0.03 })); // up under the trigger guard
  moves.push(slideUntil('l', T.l, V(-1, 0, 0), palmVerts.l, { withObs: true, maxD: 0.02 }));
  report.grip.supportSlides_m = moves;
  report.grip.supportPalmClearance = +minDist(palmVerts.l, true).d.toFixed(4);
  restFingers('l');
  const out = {};
  for (const fn of ['index', 'middle', 'ring', 'pinky']) out[fn] = wrapCurl('l', fn, { withObs: true, max: [100, 105, 90] });
  out.thumb = searchThumb('l', G(...SUP.thumb), { withObs: true });
  // gaps per phalanx (how closely the fingers wrap)
  out.gaps_mm = Object.fromEntries(['index', 'middle', 'ring', 'pinky', 'thumb'].map((fn) => [fn, [1, 2, 3].map((k) => +(minDist(phalanxVerts[`${fn}${k}l`], true).d * 1000).toFixed(1))]));
  report.grip.support = out;
  supportSnap = fingerSnap('l');
  dumpHand('l', 'support solved');
}
obstacles = [];
const supportHome = () => handFromGun(T.l);

// ----------------------------------------------------------------------------- clip recording
const ANIM_BONES = boneNames.filter((n) => !['root', 'pelvis'].includes(n));
function poseGrip({ trigger = true, support = true } = {}) {
  applyFingers(trigger ? strongTrigSnap : strongOffSnap);
  placeFromGun('r', T.r);
  if (support) { applyFingers(supportSnap); placeFromGun('l', T.l); }
}
const clips = [];
const clipInfo = [];
function record(name, dur, loop, fn, note, { fps = 30, bones = ANIM_BONES, gunTracks = true } = {}) {
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const times = new Float32Array(n);
  const qv = Object.fromEntries(bones.map((b) => [b, new Float32Array(n * 4)]));
  const slide = new Float32Array(n * 3), trig = new Float32Array(n * 4);
  const magP = new Float32Array(n * 3), magQ = new Float32Array(n * 4), magS = new Float32Array(n * 3);
  const prev = {};
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * dur;
    times[i] = t;
    R.reset();
    gun.slide = 0; gun.trig = 0; magRest();
    fn(t);
    R.update();
    for (const b of bones) {
      const q = R.b[b].quaternion.clone();
      if (prev[b] && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev[b] = q;
      q.toArray(qv[b], i * 4);
    }
    const sp = V(), tq = new THREE.Quaternion();
    partMatrix('slide').decompose(sp, new THREE.Quaternion(), V());
    partMatrix('trigger').decompose(V(), tq, V());
    sp.toArray(slide, i * 3);
    tq.toArray(trig, i * 4);
    gun.mag.p.toArray(magP, i * 3);
    gun.mag.q.toArray(magQ, i * 4);
    magS.set([gun.mag.s, gun.mag.s, gun.mag.s], i * 3);
  }
  const tracks = bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, qv[b]));
  if (gunTracks) {
    tracks.push(new THREE.VectorKeyframeTrack('pistol_slide.position', times, slide));
    tracks.push(new THREE.QuaternionKeyframeTrack('pistol_trigger.quaternion', times, trig));
    tracks.push(new THREE.VectorKeyframeTrack('pistol_magazine.position', times, magP));
    tracks.push(new THREE.QuaternionKeyframeTrack('pistol_magazine.quaternion', times, magQ));
    tracks.push(new THREE.VectorKeyframeTrack('pistol_magazine.scale', times, magS));
  }
  const clip = new THREE.AnimationClip(name, dur, tracks);
  clips.push({ clip, fn, gunTracks });
  clipInfo.push({ name, duration: dur, loop, made: true, source: note });
}

// holds (static: breathing/sway/bob are procedural in the game, layered on top)
record('fp_idle', 1, true, () => { poseGun(HOLD.hip); shoulders(0.6); poseGrip({ trigger: false }); },
  'made: hip/ready hold, gun 30 cm in front of the chest camera and 11 cm low, finger indexed, thumbs forward', { fps: 2 });
record('fp_aim', 1, true, () => { poseGun(HOLD.aim); shoulders(1); poseGrip({ trigger: true }); },
  'made: ADS from the chest camera: sights 3.5 cm under the lens axis 33 cm out, zeroed at 15 m, finger on the trigger', { fps: 2 });
record('fp_lowready', 1, true, () => { poseGun(HOLD.low); shoulders(0.2); poseGrip({ trigger: false }); },
  'made: muzzle depressed 38 deg, finger indexed', { fps: 2 });
record('fp_sprint', 0.66, true, (t) => {
  const ph = (t / 0.66) * Math.PI * 2;
  poseGun({ ...HOLD.sprint, x: HOLD.sprint.x + 0.012 * Math.sin(ph), y: HOLD.sprint.y + 0.02 * Math.abs(Math.sin(ph)), roll: HOLD.sprint.roll + 6 * Math.sin(ph), pitch: HOLD.sprint.pitch + 3 * Math.sin(ph) });
  poseGrip({ trigger: false });
}, 'made: tucked low with a two-step bob (one loop = left+right step)');
// trigger press: the index pad follows the blade (solved per frame against the rotated trigger)
function pressFinger(k) {
  gun.trig = TRIGGER_TRAVEL * k;
  applyFingers(poseIdxTrig);
  if (k > 0.001) followTrigger();
}
record('fp_fire', 0.3, false, (t) => {
  const kick = t < 0.03 ? 0 : Math.exp(-(t - 0.03) / 0.06) * Math.min(1, (t - 0.03) / 0.012);
  poseGun({ ...HOLD.aim, pitch: 5 * kick, z: HOLD.aim.z - 0.02 * kick, y: HOLD.aim.y + 0.004 * kick });
  shoulders(1 - 0.3 * kick);
  poseGrip({ trigger: true });
  pressFinger(curve([[0, 0], [0.03, 1], [0.1, 1], [0.2, 0.3], [0.3, 0]], t));
  gun.slide = SLIDE_TRAVEL * curve([[0.03, 0], [0.05, 1], [0.095, 0]], t);
}, 'made: trigger press with the finger on the blade, slide cycle (32 mm), muzzle flip 5 deg, recovery');
record('fp_dry_fire', 0.45, false, (t) => {
  poseGun({ ...HOLD.aim, pitch: -0.8 * curve([[0.12, 0], [0.15, 1], [0.3, 0]], t) });
  shoulders(1);
  poseGrip({ trigger: true });
  pressFinger(curve([[0, 0], [0.13, 1], [0.25, 1], [0.4, 0]], t));
}, 'made: full trigger press, no slide movement (click), small dip, reset');
// single-frame index-finger poses (game drives off-trigger -> on-trigger -> pressed procedurally)
const IDX = ['index_01_r', 'index_02_r', 'index_03_r'];
record('fp_pose_index_off', 0.1, true, () => { poseGun(HOLD.aim); poseGrip({ trigger: false }); }, 'pose: index straight along the frame', { fps: 10, bones: IDX, gunTracks: false });
record('fp_pose_index_trigger', 0.1, true, () => { poseGun(HOLD.aim); poseGrip({ trigger: true }); }, 'pose: index pad on the trigger', { fps: 10, bones: IDX, gunTracks: false });
// half-way pose between indexed and on-trigger, lifted clear of the frame (the game blends off -> mid -> trigger)
record('fp_pose_index_mid', 0.1, true, () => { poseGun(HOLD.aim); poseGrip({ trigger: true }); blendFingers(poseIdxOff, poseIdxTrig, 0.5); openUntilClear('r', 'index'); R.curl('r', { index: [-4, -6, -4] }); }, 'pose: index lifted between frame and trigger', { fps: 10, bones: IDX, gunTracks: false });
record('fp_pose_index_press', 0.1, true, () => { poseGun(HOLD.aim); poseGrip({ trigger: true }); pressFinger(1); }, 'pose: trigger fully pressed', { fps: 10, bones: IDX, gunTracks: false });

// ---- reloads (support hand: belt pouch -> magazine -> magwell; fingers solved per frame against the gun,
//      the magazine and nothing else; strong ring/little finger open while the magazine passes)
const POUCH = CAM.clone().add(V(0.1, -0.4, 0.1)); // left front of the duty belt (out of the camera view)
// magazine held in the support hand: solved once (palm under the base plate, fingers on the lower body)
let MAG_IN_HAND = null, magHoldSnap = null;
{
  R.reset();
  poseGun(HOLD.aim);
  // magazine 12 cm below the seat, on its axis
  gun.mag.p.fromArray(PART_REST.magazine.p).sub(MAG_AXIS.clone().multiplyScalar(0.12));
  const magW = new THREE.Matrix4().compose(gun.mag.p.clone(), gun.mag.q, V(1, 1, 1)).premultiply(gunWorld());
  const magPos = V(), magQ = new THREE.Quaternion(); magW.decompose(magPos, magQ, V());
  // hand from the left side: fingers up the magazine (tilted forward), palm facing the magazine
  const up = V(0, 1, 0).applyQuaternion(magQ), fwd = V(0, 0, 1).applyQuaternion(magQ), left = V(1, 0, 0).applyQuaternion(magQ);
  const qh = R.handQuat('l', up.clone().multiplyScalar(0.55).add(fwd.clone().multiplyScalar(0.75)), left.clone().negate().add(up.clone().multiplyScalar(-0.35)));
  const { f, n } = R.handLocal.l;
  const palmC = f.clone().multiplyScalar(0.05).add(n.clone().multiplyScalar(0.012));
  const target = magPos.clone().add(left.clone().multiplyScalar(0.03)).add(up.clone().multiplyScalar(0.0)).add(fwd.clone().multiplyScalar(-0.005));
  let Hm = new THREE.Matrix4().compose(target.sub(palmC.applyQuaternion(qh)), qh, V(1, 1, 1));
  // slide towards the magazine until the palm touches (magazine only: hide the rest by testing 'magazine')
  const step = left.clone().negate().multiplyScalar(0.001);
  restFingers('l');
  const magDist = (verts) => { let d = Infinity; const v = V(); for (const i of verts) { skinned(i, v); d = Math.min(d, gunSDF(v, 'magazine')); } return d; };
  const place = () => { const p = V(), q = new THREE.Quaternion(); Hm.decompose(p, q, V()); R.placeHand('l', p, q, supportPole()); };
  place();
  for (let i = 0; i < 80; i++) {
    const trial = Hm.clone().premultiply(new THREE.Matrix4().makeTranslation(step.x, step.y, step.z));
    const p = V(), q = new THREE.Quaternion(); trial.decompose(p, q, V()); R.placeHand('l', p, q, supportPole());
    if (magDist(palmVerts.l) < MARGIN) { place(); break; }
    Hm = trial;
  }
  place();
  // fingers around the magazine body
  const curls = {};
  for (const fn of ['index', 'middle', 'ring', 'pinky']) curls[fn] = wrapCurl('l', fn, { max: [90, 100, 80] });
  curls.thumb = wrapCurl('l', 'thumb', { max: [40, 40, 30] });
  magHoldSnap = fingerSnap('l');
  // magazine relative to the support hand
  MAG_IN_HAND = R.b.hand_l.matrixWorld.clone().invert().multiply(magW);
  report.grip.magHold = { curls, palmGap_m: +magDist(palmVerts.l).toFixed(4) };
}
const _hp = V(), _hq = new THREE.Quaternion();
/** set the magazine (gun-local) so that it sits in the support hand */
function magFromHand() {
  const w = R.b.hand_l.matrixWorld.clone().multiply(MAG_IN_HAND);
  const local = gunWorld().invert().multiply(w);
  const s = V(); local.decompose(gun.mag.p, gun.mag.q, s);
}
/** hand pose that puts the held magazine at gun-local magazine pose (p,q) */
function handForMag(p, q) {
  const magW = new THREE.Matrix4().compose(p, q, V(1, 1, 1)).premultiply(gunWorld());
  const h = magW.multiply(MAG_IN_HAND.clone().invert());
  const hp = V(), hq = new THREE.Quaternion(); h.decompose(hp, hq, V());
  return { p: hp, q: hq };
}
const magRestQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...PART_REST.magazine.r));
/** support hand flat under the magazine base plate (palm up the magazine axis, fingers forward) */
function pushPose(magLocal) {
  const axisW = MAG_AXIS.clone().applyQuaternion(gun.quat);
  const fwdW = V(0, 0, 1).applyQuaternion(gun.quat); fwdW.sub(axisW.clone().multiplyScalar(fwdW.dot(axisW))).normalize();
  const q = R.handQuat('l', fwdW.clone().add(V(1, 0, 0).applyQuaternion(gun.quat).multiplyScalar(0.35)), axisW);
  const { f, n } = R.handLocal.l;
  const palmC = f.clone().multiplyScalar(0.05).add(n.clone().multiplyScalar(0.012)).applyQuaternion(q);
  const baseW = magLocal.clone().applyMatrix4(gunWorld()).sub(axisW.clone().multiplyScalar(0.009 + 0.006));
  return { p: baseW.sub(palmC), q };
}
let magOpenSnap;
{ R.reset(); restFingers('l'); R.curl('l', { index: [12, 10, 5], middle: [12, 10, 5], ring: [12, 10, 5], pinky: [12, 10, 5], thumb: [5, 5, 5] }); magOpenSnap = fingerSnap('l'); }
const magOnAxis = (d) => V(...PART_REST.magazine.p).sub(MAG_AXIS.clone().multiplyScalar(d)); // d below the seat
/** strong hand ring/little finger: relax and re-close against the current gun (incl. the moving magazine) */
function strongLowerFingers(open) {
  for (const f of ['ring', 'pinky']) {
    if (open <= 0) continue;
    for (let k = 1; k <= 3; k++) R.b[`${f}_0${k}_r`].quaternion.copy(strongOffSnap[`${f}_0${k}_r`]);
    R.update();
    R.curl('r', { [f]: [-35 * open, -40 * open, -20 * open] });
    wrapCurl('r', f, { max: [35 * open + 2, 40 * open + 2, 20 * open + 2], step: 1 });
  }
}
/** support hand re-solve: fingers from open against the gun (+ magazine) */
function supportFingersSolve(base, open) {
  applyFingers(base);
  if (open > 0) { R.curl('l', { index: [-30 * open, -30 * open, -10 * open], middle: [-30 * open, -30 * open, -10 * open], ring: [-30 * open, -30 * open, -10 * open], pinky: [-30 * open, -30 * open, -10 * open] }); }
  for (const fn of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
    openUntilClear('l', fn);
    if (open > 0) wrapCurl('l', fn, { max: fn === 'thumb' ? [10, 10, 10] : [30 * open + 2, 30 * open + 2, 10 * open + 2], step: 1 });
  }
}
/** keep the whole support glove clear of the gun by lifting the hand along a direction (last resort) */
function clearSupport(hp, hq, dirW) {
  for (let i = 0; i < 60 && minDist(gloveVerts.l).d < 0.0015; i++) { hp.addScaledVector(dirW, 0.001); R.placeHand('l', hp, hq, supportPole()); }
}
function reloadClip(name, empty) {
  const D = empty ? 2.5 : 2.2;
  const tEnd = D - 0.35;
  record(name, D, false, (t) => {
    // gun: tilt in towards the body (roll right, muzzle up a bit) for the mag change, back to ADS at the end
    const tilt = curve([[0, 0], [0.25, 1], [tEnd - 0.1, 1], [D - 0.05, 0]], t);
    poseGun({ ...HOLD.aim, x: 0.02 * tilt, y: HOLD.aim.y - 0.06 * tilt, z: HOLD.aim.z - 0.06 * tilt, pitch: 12 * tilt, yaw: 10 * tilt, roll: 25 * tilt });
    shoulders(1 - 0.5 * tilt);
    applyFingers(strongOffSnap);
    placeFromGun('r', T.r);
    // slide: locked back on the empty gun until the release
    const rel = tEnd - 0.12;
    gun.slide = empty ? (t < rel ? SLIDE_TRAVEL : SLIDE_TRAVEL * (1 - smooth((t - rel) / 0.035))) : 0;
    // timeline (the support hand is off the gun and clear of the magazine path before the release)
    const tOff = 0.04, tDrop = 0.3, tGrab = 0.75, tUnder = 1.25, tSeat = 1.45, tBack = 1.75;
    let mode = 'grip';
    if (t >= tOff && t < tGrab) mode = 'toPouch';
    else if (t >= tGrab && t < tSeat) mode = 'carry';
    else if (t >= tSeat && t < tBack) mode = 'return';
    // old magazine: released at tDrop, falls along its axis (out of the grip), hidden once clear of view
    if (t >= tDrop && t < tGrab) {
      const u = t - tDrop;
      gun.mag.p.copy(magOnAxis(0.6 * u + 4.9 * u * u));
      gun.mag.q.copy(magRestQ);
      gun.mag.s = u > 0.12 ? 0 : 1; // out of sight below the gun by then
    } else if (t >= tGrab) gun.mag.s = 1;
    // strong ring/little finger relax while a magazine passes the bottom of the grip
    const relax = Math.max(curve([[tDrop - 0.05, 0], [tDrop + 0.03, 1], [tDrop + 0.3, 1], [tDrop + 0.4, 0]], t), curve([[tUnder - 0.1, 0], [tUnder, 1], [tSeat + 0.05, 1], [tSeat + 0.2, 0]], t));
    strongLowerFingers(relax);
    // support hand
    const home = supportHome();
    let hp, hq;
    if (mode === 'grip') { hp = home.p; hq = home.q; applyFingers(supportSnap); }
    else if (mode === 'toPouch') {
      // first straight off to the left (away from the grip and the magazine path), then down to the pouch
      const off = home.p.clone().addScaledVector(V(1, 0.15, -0.2).normalize().applyQuaternion(gun.quat), 0.07);
      const pouchQ = R.handQuat('l', V(0, -1, 0.15), V(-1, 0, 0.2));
      const u0 = smooth((t - tOff) / 0.2), u = smooth((t - tOff - 0.15) / (tGrab - tOff - 0.15));
      hp = home.p.clone().lerp(off, u0).lerp(POUCH, u);
      hq = home.q.clone().slerp(pouchQ, u);
      blendFingers(supportSnap, magHoldSnap, smooth(u * 1.4));
    } else if (mode === 'carry') {
      // from the pouch up to under the magwell (on the axis, 7 cm low), then insert (seat)
      const under = handForMag(magOnAxis(0.07), magRestQ);
      const pouchQ = R.handQuat('l', V(0, -1, 0.15), V(-1, 0, 0.2));
      if (t < tUnder) {
        const u = smooth((t - tGrab) / (tUnder - tGrab));
        hp = POUCH.clone().lerp(under.p, u); hp.x += Math.sin(u * Math.PI) * 0.03;
        hq = pouchQ.clone().slerp(under.q, u);
      } else {
        // insert: the fingers let go of the body and the palm drives the base plate home from below
        const u = smooth((t - tUnder) / (tSeat - tUnder));
        const m = handForMag(magOnAxis(0.07 * (1 - u)), magRestQ);
        const push = pushPose(magOnAxis(0.07 * (1 - u)));
        const w = smooth(u * 1.6);
        hp = m.p.clone().lerp(push.p, w); hq = m.q.clone().slerp(push.q, w);
      }
      applyFingers(magHoldSnap);
      if (t >= tUnder) blendFingers(magHoldSnap, magOpenSnap, smooth((t - tUnder) / (tSeat - tUnder) * 1.6));
    } else {
      const u = smooth((t - tSeat) / (tBack - tSeat));
      const from = pushPose(magOnAxis(0));
      hp = from.p.clone().lerp(home.p, u); hp.addScaledVector(V(1, -0.4, 0).normalize().applyQuaternion(gun.quat), Math.sin(u * Math.PI) * 0.04);
      hq = from.q.clone().slerp(home.q, u);
      blendFingers(magOpenSnap, supportSnap, u);
    }
    R.placeHand('l', hp, hq, supportPole());
    if (mode === 'carry') magFromHand();
    if (mode === 'carry' && t >= tUnder) { gun.mag.p.copy(magOnAxis(0.07 * (1 - smooth((t - tUnder) / (tSeat - tUnder))))); gun.mag.q.copy(magRestQ); }
    // contact: fingers never inside the gun/magazine; hand moved away as a last resort (left, off the gun)
    if (mode !== 'grip') {
      supportFingersSolve(fingerSnap('l'), 0);
      clearSupport(hp, hq, (mode === 'toPouch' ? V(1, 0.1, -0.2) : V(0.3, -1, 0)).normalize().applyQuaternion(gun.quat));
    }
    // empty: strong thumb rides down on the slide stop for the release
    if (empty) { const k = curve([[rel - 0.15, 0], [rel, 1], [rel + 0.15, 0]], t); if (k > 0) { R.curl('r', { thumb: [0, 8 * k, 10 * k] }); openUntilClear('r', 'thumb'); } }
    // the trigger finger stays indexed; everything clear of the gun
    openUntilClear('r', 'index');
  }, empty ? 'made: empty reload: slide locked, mag drop, new mag from the belt, insert, slide-stop release'
    : 'made: tactical reload (round chambered): mag drop, new mag from the belt, insert', { fps: 60 });
}
if (process.env.ARMS_FAST !== '1') {
  reloadClip('fp_reload', true);
  reloadClip('fp_reload_tac', false);
}

// ----------------------------------------------------------------------------- penetration report (authoring SDF)
function penetration() {
  const glove = vertsOf((b) => /^(hand|thumb|index|middle|ring|pinky)_/.test(b));
  const out = {};
  for (const { clip, fn, gunTracks } of clips) {
    if (!gunTracks) continue;
    let worst = 0, count = 0, frames = 0, worstT = 0, ikErr = 0;
    const byBone = {};
    const n = Math.max(2, Math.round(clip.duration * 60) + 1); // 60 fps (finer than the 30 fps keys)
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * clip.duration;
      R.reset(); gun.slide = 0; gun.trig = 0; magRest();
      R.ikError = {};
      fn(t); R.update();
      ikErr = Math.max(ikErr, ...Object.values(R.ikError), 0);
      frames++;
      const v = V();
      for (const k of glove) {
        skinned(k, v);
        const d = gunSDF(v);
        if (d < 0) { count++; byBone[dom[k]] = Math.max(byBone[dom[k]] || 0, +(-d * 1000).toFixed(2)); if (-d > worst) { worst = -d; worstT = t; } }
      }
    }
    out[clip.name] = { frames, gloveVerts: glove.length, penetratingVertexFrames: count, maxDepth_mm: +(worst * 1000).toFixed(2), worstAt_s: +worstT.toFixed(3), maxWristReachError_mm: +(ikErr * 1000).toFixed(1), maxDepthByBone_mm: byBone };
    console.log(clip.name.padEnd(22), 'max depth mm', out[clip.name].maxDepth_mm, 'ik err mm', out[clip.name].maxWristReachError_mm);
  }
  return out;
}
report.clips = penetration();
console.log(JSON.stringify(report.grip, null, 1));

// ----------------------------------------------------------------------------- export
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(rawPath);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];
const nodes = Object.fromEntries(root.listNodes().map((n) => [n.getName(), n]));
const scene = root.getDefaultScene() || root.listScenes()[0];
const fp = doc.createNode('fp_root');
const flip = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI);
fp.setRotation(flip.toArray()).setTranslation(CAM.clone().applyQuaternion(flip).negate().toArray());
for (const c of scene.listChildren()) { scene.removeChild(c); fp.addChild(c); }
scene.addChild(fp);
fp.addChild(doc.createNode('eye').setTranslation(EYE.toArray()).setRotation(flip.toArray()));
fp.addChild(doc.createNode('camera_chest').setTranslation(CAM.toArray()).setRotation(flip.toArray()));

// pistol = 4 extra joints of the arms skin; its vertices join the arms primitive (one draw call, one material)
R.reset();
const wih = T.r.clone().invert(); // pistol in hand_r space
const wp = V(), wq = new THREE.Quaternion();
wih.decompose(wp, wq, V());
const pistol = doc.createNode('pistol').setTranslation(wp.toArray()).setRotation(wq.toArray());
nodes.hand_r.addChild(pistol);
const pistolRestW = R.b.hand_r.matrixWorld.clone().multiply(wih);
const jointRest = { pistol: pistolRestW };
for (const part of ['slide', 'trigger', 'magazine']) {
  const rest = PART_REST[part];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rest.r));
  const node = doc.createNode(`pistol_${part}`).setTranslation(rest.p).setRotation(q.toArray());
  pistol.addChild(node);
  nodes[`pistol_${part}`] = node;
  jointRest[`pistol_${part}`] = pistolRestW.clone().multiply(new THREE.Matrix4().compose(V(...rest.p), q, V(1, 1, 1)));
}
nodes.pistol = pistol;
// markers (plain nodes, follow the pistol/slide)
pistol.addChild(doc.createNode('pistol_muzzle').setTranslation(MUZZLE.toArray()));
pistol.addChild(doc.createNode('pistol_sight_rear').setTranslation(SIGHT_REAR.toArray()));
pistol.addChild(doc.createNode('pistol_sight_front').setTranslation(SIGHT_FRONT.toArray()));
nodes.pistol_slide.addChild(doc.createNode('pistol_port').setTranslation(PORT.toArray()));
// atlas: pistol colour palette (16x16 cells at (256..512, 640..))
const PAL0 = [256, 640], CELL = 16, ATLAS = 1024;
const palette = Object.values(COL);
const palUV = (c) => {
  let bi = 0, bd = Infinity;
  palette.forEach((p, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
  return [(PAL0[0] + (bi % 16) * CELL + CELL / 2) / ATLAS, (PAL0[1] + Math.floor(bi / 16) * CELL + CELL / 2) / ATLAS];
};
const armsMesh = root.listMeshes().find((m) => m.getName() === 'fp_arms') || nodes.fp_arms.getMesh();
const prim = armsMesh.listPrimitives()[0];
const skin = root.listSkins()[0];
const jointNames = skin.listJoints().map((j) => j.getName());
const ibmAcc = skin.getInverseBindMatrices();
const ibm = Array.from(ibmAcc.getArray());
// sanity: the authoring rig matches the file's bind pose
{
  const k = jointNames.indexOf('hand_r');
  const m = new THREE.Matrix4().fromArray(ibm.slice(k * 16, k * 16 + 16)).premultiply(R.b.hand_r.matrixWorld);
  const e = m.elements.reduce((a, v, i) => a + Math.abs(v - (i % 5 === 0 ? 1 : 0)), 0);
  if (e > 1e-3) throw new Error(`bind pose mismatch ${e}`);
}
const newJoint = {};
for (const jn of ['pistol', 'pistol_slide', 'pistol_trigger', 'pistol_magazine']) {
  newJoint[jn] = jointNames.length;
  jointNames.push(jn);
  skin.addJoint(nodes[jn]);
  ibm.push(...jointRest[jn].clone().invert().elements);
}
ibmAcc.setArray(new Float32Array(ibm));
const A = (sem) => prim.getAttribute(sem);
const pos0 = Array.from(A('POSITION').getArray()), nrm0 = Array.from(A('NORMAL').getArray()), uv0 = Array.from(A('TEXCOORD_0').getArray());
const jt0 = Array.from(A('JOINTS_0').getArray()), wt0 = Array.from(A('WEIGHTS_0').getArray());
const idx0 = Array.from(prim.getIndices().getArray());
let base = pos0.length / 3, gunTris = 0;
const nm = new THREE.Matrix3();
for (const part of PARTNAMES) {
  const g = partGeometry(part);
  const J = part === 'frame' ? 'pistol' : `pistol_${part}`;
  const M = jointRest[J];
  nm.getNormalMatrix(M);
  const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color;
  for (let i = 0; i < P.count; i++) {
    const v = V().fromBufferAttribute(P, i).applyMatrix4(M);
    const n = V().fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
    pos0.push(v.x, v.y, v.z); nrm0.push(n.x, n.y, n.z);
    uv0.push(...palUV([C.getX(i), C.getY(i), C.getZ(i)]));
    jt0.push(newJoint[J], 0, 0, 0); wt0.push(1, 0, 0, 0);
  }
  for (let i = 0; i < P.count; i++) idx0.push(base + i);
  base += P.count;
  gunTris += P.count / 3;
}
const JT = A('JOINTS_0').getArray().constructor;
A('POSITION').setArray(new Float32Array(pos0));
A('NORMAL').setArray(new Float32Array(nrm0));
A('TEXCOORD_0').setArray(new Float32Array(uv0));
A('JOINTS_0').setArray(new (JT === Uint8Array && jointNames.length > 255 ? Uint16Array : JT)(jt0));
A('WEIGHTS_0').setArray(new Float32Array(wt0));
prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx0)).setBuffer(buffer));
// palette into the atlas
{
  const tex = prim.getMaterial().getBaseColorTexture();
  const img = sharp(Buffer.from(tex.getImage()));
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const toS = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
  palette.forEach((c, i) => {
    const x0 = PAL0[0] + (i % 16) * CELL, y0 = PAL0[1] + Math.floor(i / 16) * CELL;
    for (let y = y0; y < y0 + CELL; y++) for (let x = x0; x < x0 + CELL; x++) {
      const o = (y * info.width + x) * 4;
      data[o] = toS(c[0]); data[o + 1] = toS(c[1]); data[o + 2] = toS(c[2]); data[o + 3] = 255;
    }
  });
  tex.setImage(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()).setMimeType('image/png');
}
prim.getMaterial().setName('fp_arms_mat').setMetallicFactor(0).setRoughnessFactor(0.8);
for (const { clip } of clips) {
  const anim = doc.createAnimation(clip.name);
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const node = nodes[tr.name.slice(0, dot)];
    const prop = tr.name.slice(dot + 1);
    const p = prop === 'quaternion' ? 'rotation' : prop === 'position' ? 'translation' : 'scale';
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(tr.times)).setBuffer(buffer);
    const output = doc.createAccessor().setType(p === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(tr.values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(clip.name.startsWith('fp_reload') && prop === 'scale' ? 'STEP' : 'LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(p).setSampler(sampler));
  }
}
nodes.fp_arms.setName('fp_arms');
const totalTris = idx0.length / 3;
// game-side data: support hand in pistol space (runtime IK), pistol in hand_r space, hold definitions
const supportInPistol = T.l.clone(); // gun space == pistol joint space
fp.setExtras({
  tris: totalTris, gunTris, cam: CAM.toArray(), eye: EYE.toArray(),
  supportInPistol: supportInPistol.elements, pistolInHand: wih.elements,
  trigger: { axis: [1, 0, 0], travel: TRIGGER_TRAVEL }, slideTravel: SLIDE_TRAVEL,
  muzzle: MUZZLE.toArray(), sightRear: SIGHT_REAR.toArray(), sightFront: SIGHT_FRONT.toArray(), port: PORT.toArray(),
  magAxis: MAG_AXIS.toArray(), hold: HOLD,
});
await doc.transform(
  resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 88 }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'fp_arms_pistol.glb');
await io.write(outFile, doc);
report.tris = { arms: totalTris - gunTris, pistol: gunTris, total: totalTris };
report.bytes = fs.statSync(outFile).size;
fs.writeFileSync(path.join(outDir, 'fp_arms_pistol.clips.json'), JSON.stringify(clipInfo, null, 1));
fs.writeFileSync(path.join(outDir, 'penetration_report.json'), JSON.stringify(report, null, 1));
console.log('written', outFile, report.tris, report.bytes, 'bytes');
if (DEBUG) console.log(JSON.stringify(report.clips, null, 1));
