// First-person arms (stage 2): pistol, contact-solved two-handed grip, authored clips, export.
// usage: node build_arms.mjs <cache_dir> <arms_raw.glb> <out_dir>
//
// Output fp_arms_pistol.glb:
//   fp_root (rotated 180 deg about Y; origin = right eye, looking down -Z like a three.js camera)
//     ├─ fp_arms (SkinnedMesh, MakeHuman arms + gloves + sleeves)
//     └─ root … hand_r ─ pistol ─ pistol_frame / pistol_slide / pistol_trigger / pistol_magazine
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
import { addGeometry, gunMaterial } from './glbexport.mjs';
import { PARTS, PART_REST, SLIDE_TRAVEL, MAG_AXIS, SIGHT_REAR, partGeometry, sdPart } from './fppistol.mjs';

const [, , cache, rawPath, outDir] = process.argv;
void cache;
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const boneNames = readJSON(path.join(here, 'skeleton.json')).arms.map((b) => b[0]);
const raw = await loadGLB(rawPath);
let mesh, rootBone;
raw.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; if (o.isBone && o.name === 'root') rootBone = o; });
const R = new Rig(rootBone, boneNames);

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
const _mm = new THREE.Matrix4(), _vv = new THREE.Vector3(), _acc = new THREE.Vector3();
function skinned(i, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const w = SW.getComponent(i, k);
    if (!w) continue;
    const bi = SI.getComponent(i, k);
    _mm.multiplyMatrices(R.b[skBones[bi]].matrixWorld, IBM[bi]);
    _vv.fromBufferAttribute(P0, i).applyMatrix4(_mm);
    out.addScaledVector(_vv, w);
  }
  return out;
}

// ----------------------------------------------------------------------------- gun state + SDF
const gun = { pos: V(), quat: new THREE.Quaternion(), slide: 0, trig: 0, mag: { p: V(), q: new THREE.Quaternion(), s: 1 } };
function partMatrix(part) {
  const rest = PART_REST[part];
  const m = new THREE.Matrix4();
  if (part === 'magazine') return m.compose(gun.mag.p, gun.mag.q, V(1, 1, 1));
  const p = V(...rest.p);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rest.r));
  if (part === 'slide') p.z -= gun.slide;
  if (part === 'trigger') q.multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -gun.trig));
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
function gunSDF(p, skipMag = false) {
  const inv = gunWorld().invert();
  const pl = p.clone().applyMatrix4(inv);
  let d = Infinity;
  for (const part of PARTNAMES) {
    if (part === 'magazine' && (skipMag || gun.mag.s === 0)) continue;
    const q = pl.clone().applyMatrix4(partMatrix(part).invert());
    d = Math.min(d, sdPart(part, q));
  }
  return d;
}

// ----------------------------------------------------------------------------- reference frames
R.reset();
const EYE = R.wpos('Head').add(V(0, 0.075, 0.085)); // right between the eyes, ~ at the brow line
const WEAPON = { gripTilt: 18 };
const GRIP_FINGER_LIFT = Number(process.env.GRIP_LIFT || 15);
// heuristic strong-hand grip (refined below by contact)
function heuristicGrip(s) {
  const { f, n, side } = R.handLocal[s];
  const sd = side.clone().sub(f.clone().multiplyScalar(side.dot(f))).normalize();
  const t = deg(WEAPON.gripTilt);
  const Yw = sd.clone().multiplyScalar(Math.cos(t)).sub(f.clone().multiplyScalar(Math.sin(t))).normalize();
  const Zw = f.clone().multiplyScalar(Math.cos(t)).add(sd.clone().multiplyScalar(Math.sin(t))).normalize();
  const Xw = Yw.clone().cross(Zw).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xw, Yw, Zw));
  const pos = f.clone().multiplyScalar(0.07).add(n.clone().multiplyScalar(0.024)).add(sd.clone().multiplyScalar(0.004));
  return { pos, quat }; // weapon in hand space
}

/** Pose weapon world transform from the eye frame: offsets in metres, angles in degrees. */
function setGun({ x = 0, y = 0, z = 0, pitch = 0, yaw = 0, roll = 0 }) {
  gun.quat.setFromEuler(new THREE.Euler(deg(-pitch), deg(yaw), deg(roll), 'YXZ'));
  gun.pos.copy(EYE).add(V(x, y, z));
}
/** ADS: rear sight 2.5 cm below the eye line, 0.35 m in front. */
function adsGun(extra = {}) {
  setGun({ pitch: 0, ...extra });
  const rs = SIGHT_REAR.clone().applyQuaternion(gun.quat);
  gun.pos.copy(EYE).add(V(0, -0.025, 0.35)).sub(rs).add(V(extra.x || 0, extra.y || 0, extra.z || 0));
}

// hand placement relative to the gun: H_world = G * T
const T = {
  r: null, // strong hand (from heuristic + contact)
  l: null, // support hand
};
function handFromGun(s, Tm) {
  const m = gunWorld().multiply(Tm);
  const p = V(), q = new THREE.Quaternion();
  m.decompose(p, q, V());
  return { p, q };
}
function placeFromGun(s, Tm, pole) {
  const { p, q } = handFromGun(s, Tm);
  R.placeHand(s, p, q, pole);
}
const strongPole = () => R.wpos('upperarm_r').add(V(-0.45, -0.55, -0.15));
const supportPole = () => R.wpos('upperarm_l').add(V(0.45, -0.55, -0.15));

// ----------------------------------------------------------------------------- grip solve
const MARGIN = 0.0025; // glove surface kept >= 2.5 mm from the gun
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const fingerVerts = {};
for (const s of ['l', 'r']) for (const f of FINGERS) for (let k = 1; k <= 3; k++) {
  fingerVerts[`${f}${k}${s}`] = vertsOf((b) => {
    const m = b.match(new RegExp(`^${f}_0(\\d)_${s}$`));
    return !!m && Number(m[1]) >= k;
  });
}
const palmVerts = { l: vertsOf((b) => b === 'hand_l'), r: vertsOf((b) => b === 'hand_r') };
let obstacles = []; // extra capsules [a, b, r] (strong-hand fingers for the support hand)
function capsuleSD(p, [a, b, r]) {
  const ab = b.clone().sub(a), ap = p.clone().sub(a);
  const h = Math.min(1, Math.max(0, ap.dot(ab) / ab.lengthSq()));
  return ap.sub(ab.multiplyScalar(h)).length() - r;
}
function minDist(verts, withObstacles = false, skipMag = false) {
  let d = Infinity, worst = null;
  const v = new THREE.Vector3();
  for (const i of verts) {
    skinned(i, v);
    let dd = gunSDF(v, skipMag);
    if (withObstacles) for (const c of obstacles) dd = Math.min(dd, capsuleSD(v, c));
    if (dd < d) { d = dd; worst = v.clone(); }
  }
  return { d, worst };
}
function curlUntilContact(s, finger, maxDeg = [95, 100, 80], step = 2, withObs = false, margin = MARGIN) {
  const res = [];
  for (let k = 1; k <= 3; k++) {
    const bn = `${finger}_0${k}_${s}`;
    const verts = fingerVerts[`${finger}${k}${s}`];
    let total = 0;
    let back = 0;
    while (minDist(verts, withObs).d < margin && back > -45) { // start inside: open the joint first
      R.curl(s, { [finger]: [k === 1 ? -step : 0, k === 2 ? -step : 0, k === 3 ? -step : 0] });
      back -= step;
    }
    if (back < 0) { res.push(back); continue; }
    while (total < maxDeg[k - 1]) {
      R.curl(s, { [finger]: [k === 1 ? step : 0, k === 2 ? step : 0, k === 3 ? step : 0] });
      total += step;
      if (minDist(verts, withObs).d < margin) {
        R.curl(s, { [finger]: [k === 1 ? -step : 0, k === 2 ? -step : 0, k === 3 ? -step : 0] });
        total -= step;
        break;
      }
    }
    res.push(total);
    void bn;
  }
  return res;
}
/** Push a hand away from the gun until its palm verts clear the margin (moves T along the gradient). */
function pushOut(s, Tm, verts, withObs = false) {
  for (let it = 0; it < 40; it++) {
    placeFromGun(s, Tm, s === 'r' ? strongPole() : supportPole());
    const { d, worst } = minDist(verts, withObs);
    if (d >= MARGIN) return d;
    // numerical gradient of the field at the worst vertex
    const e = 0.001, g = V();
    const f0 = (p) => { let dd = gunSDF(p); if (withObs) for (const c of obstacles) dd = Math.min(dd, capsuleSD(p, c)); return dd; };
    for (const [ax, vec] of [['x', V(e, 0, 0)], ['y', V(0, e, 0)], ['z', V(0, 0, e)]]) g[ax] = (f0(worst.clone().add(vec)) - f0(worst.clone().sub(vec))) / (2 * e);
    g.normalize();
    // gradient is in world; express in gun space and move the hand transform
    const gl = g.applyQuaternion(gun.quat.clone().invert()).multiplyScalar(MARGIN - d + 0.0005);
    Tm.premultiply(new THREE.Matrix4().makeTranslation(gl.x, gl.y, gl.z));
  }
  return minDist(verts, withObs).d;
}
const fingerSnap = (s) => Object.fromEntries(FINGERS.flatMap((f) => [1, 2, 3].map((k) => `${f}_0${k}_${s}`)).map((n) => [n, R.b[n].quaternion.clone()]));
const applyFingers = (snap) => { for (const [n, q] of Object.entries(snap)) R.b[n].quaternion.copy(q); R.update(); };

const report = { margin_m: MARGIN, grip: {} };
setGun({ x: 0, y: -0.27, z: 0.36, pitch: -8 }); // solve the grip in the (reachable) hold pose
shoulders(0.3);
// strong hand: heuristic orientation, then slide it in until the palm, web and heel touch the grip
function slideUntil(s, Tm, dirGun, verts, { maxD = 0.12, step = 0.001, withObs = false } = {}) {
  let moved = 0;
  const dv = dirGun.clone().normalize().multiplyScalar(step);
  const stepM = new THREE.Matrix4().makeTranslation(dv.x, dv.y, dv.z);
  while (moved < maxD) {
    const trial = Tm.clone().premultiply(stepM);
    placeFromGun(s, trial, s === 'r' ? strongPole() : supportPole());
    if (minDist(verts, withObs).d < MARGIN) break;
    Tm.copy(trial);
    moved += step;
  }
  placeFromGun(s, Tm, s === 'r' ? strongPole() : supportPole());
  return +moved.toFixed(4);
}
const webVerts = { l: vertsOf((b) => /^(thumb_01|index_01)_l$/.test(b)), r: vertsOf((b) => /^(thumb_01|index_01)_r$/.test(b)) };
{
  const g = heuristicGrip('r');
  // hand orientation in gun space; rotated so the fingers wrap level around the front strap
  const qH = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), deg(-GRIP_FINGER_LIFT)).multiply(g.quat.clone().invert());
  // web of the hand (between thumb and index bases), hand-local, from the rest skeleton
  const web = R.b.thumb_01_r.position.clone().add(R.b.index_01_r.position).multiplyScalar(0.5);
  const WEB_G = V(-0.045, Number(process.env.WEB_Y || 0.012), -0.022); // just under the beavertail, 4.5 cm right of centre (start clear)
  const pH = WEB_G.clone().sub(web.clone().applyQuaternion(qH));
  T.r = new THREE.Matrix4().compose(pH, qH, V(1, 1, 1));
  const moves = [];
  moves.push(slideUntil('r', T.r, V(1, 0, 0), palmVerts.r)); // palm onto the right grip panel
  moves.push(slideUntil('r', T.r, V(0, 0, 1), palmVerts.r, { maxD: 0.02 })); // heel forward against the backstrap
  moves.push(slideUntil('r', T.r, V(1, 0, 0), palmVerts.r)); // settle
  report.grip.strongSlides_m = moves;
  report.grip.strongPalmClearance = minDist(palmVerts.r).d;
}
function solveStrongFingers(trigger) {
  placeFromGun('r', T.r, strongPole());
  for (const f of FINGERS) for (let k = 1; k <= 3; k++) R.b[`${f}_0${k}_r`].quaternion.copy(R.restQ[`${f}_0${k}_r`]);
  R.update();
  const out = {};
  for (const f of ['middle', 'ring', 'pinky']) out[f] = curlUntilContact('r', f);
  if (trigger) {
    // index on the trigger: swing the finger down toward the middle finger (about the palm normal)
    // until its middle phalanx is level with the trigger blade, then flex until contact
    const n = R.handFrame('r').n;
    const trig = V(0, 0.012, 0.05).applyMatrix4(gunWorld()); // trigger blade face
    const tipOf = () => R.wpos('index_03_r');
    let best = null;
    for (const sgn of [1, -1]) {
      const q0 = R.b.index_01_r.quaternion.clone();
      let bestA = 0, bestD = tipOf().distanceTo(trig);
      for (let a = 2; a <= 30; a += 2) {
        R.b.index_01_r.quaternion.copy(q0); R.update();
        R.rot('index_01_r', n, deg(sgn * a));
        const d = tipOf().distanceTo(trig);
        if (d < bestD) { bestD = d; bestA = a; }
      }
      R.b.index_01_r.quaternion.copy(q0); R.update();
      if (!best || bestD < best.d) best = { sgn, a: bestA, d: bestD };
    }
    R.rot('index_01_r', n, deg(best.sgn * best.a));
    out.indexSwing = best.sgn * best.a;
    out.index = curlUntilContact('r', 'index', [60, 80, 40]);
  } else {
    // index straight along the frame above the trigger guard (finger off trigger)
    R.curl('r', { index: [8, 4, 0] });
    out.index = [8, 4, 0];
  }
  // thumb high along the left side of the frame
  R.curl('r', { thumb: [-8, 0, 0] });
  out.thumb = curlUntilContact('r', 'thumb', [60, 40, 30]);
  return { snap: fingerSnap('r'), curls: out };
}
const strongTrig = solveStrongFingers(true);
const strongOff = solveStrongFingers(false);
report.grip.strongCurls = { trigger: strongTrig.curls, indexed: strongOff.curls };

// support hand: palm on the left grip panel under the strong thumb, fingers wrapped over the strong fingers
function strongCapsules() {
  const caps = [];
  for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
    for (let k = 1; k <= 3; k++) {
      const a = R.wpos(`${f}_0${k}_r`);
      const b = k < 3 ? R.wpos(`${f}_0${k + 1}_r`) : a.clone().add(a.clone().sub(R.wpos(`${f}_0${k - 1}_r`)).normalize().multiplyScalar(0.024));
      caps.push([a, b, 0.0105]);
    }
  }
  caps.push([R.wpos('hand_r'), R.wpos('middle_01_r'), 0.022]);
  return caps;
}
{
  applyFingers(strongTrig.snap);
  obstacles = strongCapsules();
  // support hand frame in gun space: fingers forward-down, palm facing the gun's left panel
  const fl = V(0, -0.62, 0.78).normalize();
  const nl = V(-1, -0.05, 0.12).normalize();
  const qGun = new THREE.Quaternion();
  // handQuat works in world: build in gun space with the gun at identity, then express relative
  const savedQ = gun.quat.clone(), savedP = gun.pos.clone();
  const qh = R.handQuat('l', fl.clone().applyQuaternion(savedQ), nl.clone().applyQuaternion(savedQ));
  void qGun;
  const { f, n } = R.handLocal.l;
  // palm centre of the support hand placed on the left grip panel, outside the strong fingers
  const palmC = f.clone().multiplyScalar(0.055).add(n.clone().multiplyScalar(0.012));
  const PALM_G = V(0.07, -0.012, 0.004).applyQuaternion(savedQ).add(savedP);
  const wristW = PALM_G.sub(palmC.applyQuaternion(qh));
  const Hw = new THREE.Matrix4().compose(wristW, qh, V(1, 1, 1));
  T.l = gunWorld().invert().multiply(Hw);
  const moves = [];
  for (const fn of FINGERS) for (let k = 1; k <= 3; k++) R.b[`${fn}_0${k}_l`].quaternion.copy(R.restQ[`${fn}_0${k}_l`]);
  moves.push(slideUntil('l', T.l, V(-1, 0, 0), palmVerts.l, { withObs: true })); // palm onto the left panel / strong fingers
  report.grip.supportSlides_m = moves;
  report.grip.supportPalmClearance = minDist(palmVerts.l, true).d;
  for (const fn of FINGERS) for (let k = 1; k <= 3; k++) R.b[`${fn}_0${k}_l`].quaternion.copy(R.restQ[`${fn}_0${k}_l`]);
  R.update();
  const out = {};
  for (const fn of ['index', 'middle', 'ring', 'pinky']) out[fn] = curlUntilContact('l', fn, [95, 100, 80], 2, true);
  out.thumb = curlUntilContact('l', 'thumb', [40, 30, 20], 2, true);
  report.grip.supportCurls = out;
}
const supportSnap = fingerSnap('l');
const leftGlove = vertsOf((b) => /^(hand|thumb|index|middle|ring|pinky)(_0\d)?_l$/.test(b));

// ----------------------------------------------------------------------------- clip recording
const ANIM_BONES = boneNames.filter((n) => !['root', 'pelvis'].includes(n));
function poseGrip({ trigger = true, support = true } = {}) {
  applyFingers(trigger ? strongTrig.snap : strongOff.snap);
  placeFromGun('r', T.r, strongPole());
  if (support) {
    applyFingers(supportSnap);
    placeFromGun('l', T.l, supportPole());
  }
}
function shoulders(k) { // protract shoulders slightly when pushing the gun out
  R.rot('clavicle_l', V(0, 1, 0), deg(-16 * k));
  R.rot('clavicle_r', V(0, 1, 0), deg(16 * k));
}
const clips = [];
const clipInfo = [];
function record(name, dur, loop, fn, note) {
  const fps = 60;
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const times = new Float32Array(n);
  const qv = Object.fromEntries(ANIM_BONES.map((b) => [b, new Float32Array(n * 4)]));
  const slide = new Float32Array(n * 3), trig = new Float32Array(n * 4);
  const magP = new Float32Array(n * 3), magQ = new Float32Array(n * 4), magS = new Float32Array(n * 3);
  const prev = {};
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * dur;
    times[i] = t;
    R.reset();
    gun.slide = 0; gun.trig = 0; magRest();
    fn(t);
    R.update();
    for (const b of ANIM_BONES) {
      const q = R.b[b].quaternion.clone();
      if (prev[b] && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev[b] = q;
      q.toArray(qv[b], i * 4);
    }
    const sm = partMatrix('slide'), tm = partMatrix('trigger');
    const sp = V(), tq = new THREE.Quaternion();
    sm.decompose(sp, new THREE.Quaternion(), V());
    tm.decompose(V(), tq, V());
    sp.toArray(slide, i * 3);
    tq.toArray(trig, i * 4);
    gun.mag.p.toArray(magP, i * 3);
    gun.mag.q.toArray(magQ, i * 4);
    magS.set([gun.mag.s, gun.mag.s, gun.mag.s], i * 3);
    if (i % 3 === 0) frames.push(t);
  }
  const tracks = ANIM_BONES.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, qv[b]));
  tracks.push(new THREE.VectorKeyframeTrack('pistol_slide.position', times, slide));
  tracks.push(new THREE.QuaternionKeyframeTrack('pistol_trigger.quaternion', times, trig));
  tracks.push(new THREE.VectorKeyframeTrack('pistol_magazine.position', times, magP));
  tracks.push(new THREE.QuaternionKeyframeTrack('pistol_magazine.quaternion', times, magQ));
  tracks.push(new THREE.VectorKeyframeTrack('pistol_magazine.scale', times, magS));
  const clip = new THREE.AnimationClip(name, dur, tracks);
  clips.push({ clip, fn });
  clipInfo.push({ name, duration: dur, loop, made: true, source: note });
}
const sway = (t, per, a) => Math.sin((t / per) * Math.PI * 2) * a;

// hold: compressed two-handed ready at chest height, muzzle slightly down
const HOLD = { x: 0.0, y: -0.27, z: 0.36, pitch: -8 };
record('fp_idle', 4, true, (t) => {
  setGun({ ...HOLD, y: HOLD.y + sway(t, 4, 0.004), pitch: HOLD.pitch + sway(t, 2, 0.5), yaw: sway(t, 4, 0.4) });
  shoulders(0.3);
  poseGrip({ trigger: false });
}, 'made: contact-solved two-handed grip, breathing sway');
record('fp_aim', 4, true, (t) => {
  adsGun({ y: sway(t, 4, 0.002), pitch: sway(t, 2, 0.25), yaw: sway(t, 4, 0.3) });
  shoulders(1);
  poseGrip({ trigger: true });
}, 'made: sights on the eye line (rear sight 2.5 cm under the eye, 0.35 m out), finger on trigger');
record('fp_fire', 0.32, false, (t) => {
  const kick = t < 0.025 ? 0 : Math.exp(-(t - 0.025) / 0.07) * Math.min(1, (t - 0.025) / 0.012);
  adsGun({ pitch: 6.5 * kick, z: -0.028 * kick, y: 0.006 * kick });
  shoulders(1 - 0.3 * kick);
  poseGrip({ trigger: true });
  gun.trig = deg(14) * curve([[0, 0], [0.02, 1], [0.11, 1], [0.16, 0.35]], t);
  gun.slide = SLIDE_TRAVEL * curve([[0.025, 0], [0.045, 1], [0.09, 0]], t);
}, 'made: trigger press, slide cycle (32 mm), muzzle flip 6.5 deg + 28 mm push-back, recovery');
record('fp_dry_fire', 0.45, false, (t) => {
  adsGun({ pitch: -0.8 * curve([[0.1, 0], [0.13, 1], [0.3, 0]], t) });
  shoulders(1);
  poseGrip({ trigger: true });
  gun.trig = deg(14) * curve([[0, 0], [0.12, 1], [0.25, 1], [0.38, 0.35]], t);
}, 'made: slow trigger press with no slide movement (click), small dip, trigger reset');
record('fp_lowready', 3, true, (t) => {
  setGun({ x: 0.03, y: -0.42 + sway(t, 3, 0.003), z: 0.3, pitch: -55 + sway(t, 3, 0.6), yaw: 12 });
  poseGrip({ trigger: false });
}, 'made: muzzle depressed 55 deg, finger indexed');
record('fp_sprint', 0.66, true, (t) => {
  const ph = (t / 0.66) * Math.PI * 2;
  setGun({ x: 0.06 + 0.012 * Math.sin(ph), y: -0.43 + 0.022 * Math.abs(Math.sin(ph)), z: 0.24, pitch: -62 + 3 * Math.sin(ph), yaw: 20, roll: 8 * Math.sin(ph) });
  poseGrip({ trigger: false });
}, 'made: tucked low-ready with a two-step bob (one loop = left+right step)');
// reload with slide release (empty gun: slide locked back at the start)
record('fp_reload', 2.4, false, (t) => {
  const tilt = curve([[0, 0], [0.25, 1], [1.85, 1], [2.3, 0]], t);
  setGun({ x: 0.03 * tilt, y: -0.12 * tilt - 0.06, z: 0.42 - 0.08 * tilt, pitch: 10 * tilt, yaw: 12 * tilt, roll: 28 * tilt });
  shoulders(0.6);
  applyFingers(strongOff.snap);
  placeFromGun('r', T.r, strongPole());
  gun.slide = t < 1.82 ? SLIDE_TRAVEL : SLIDE_TRAVEL * (1 - smooth((t - 1.82) / 0.04));
  // magazine: drop out (0.3-0.7), new one from the belt (0.75-1.3), insert (1.3-1.5)
  const gw = gunWorld();
  const axisW = MAG_AXIS.clone().applyQuaternion(gun.quat);
  const restP = V(...PART_REST.magazine.p), restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...PART_REST.magazine.r));
  const pouch = EYE.clone().add(V(0.17, -0.6, 0.2));
  const below = (d) => restP.clone().applyMatrix4(gw).sub(axisW.clone().multiplyScalar(d));
  let magW = null, handW = null;
  if (t < 0.3) { /* seated */ } else if (t < 0.72) {
    const u = (t - 0.3) / 0.42;
    gun.mag.p.copy(restP).sub(MAG_AXIS.clone().multiplyScalar(0.05 * u + 0.9 * u * u));
    gun.mag.s = u > 0.85 ? 0 : 1;
  } else gun.mag.s = 0;
  if (t >= 0.75 && t < 1.5) {
    const u1 = smooth((t - 0.75) / 0.55); // pouch -> under the magwell
    const u2 = smooth((t - 1.3) / 0.2); // insert
    const start = pouch, mid = below(0.08);
    magW = t < 1.3 ? start.clone().lerp(mid, u1) : below(0.08 * (1 - u2));
    const qMag = gun.quat.clone().multiply(restQ);
    gun.mag.s = 1;
    const local = magW.clone().applyMatrix4(gw.clone().invert());
    gun.mag.p.copy(local);
    gun.mag.q.copy(restQ);
    // support hand holds the base plate: palm up under it, fingers along the front of the magazine
    const up = axisW.clone();
    const fwd = V(0, 0, 1).applyQuaternion(gun.quat);
    handW = { p: magW.clone().sub(up.clone().multiplyScalar(0.06)).sub(fwd.clone().multiplyScalar(0.03)), q: R.handQuat('l', up.clone().add(fwd.clone().multiplyScalar(0.6)), up.clone().multiplyScalar(-1).add(fwd)) };
    void qMag;
  } else if (t >= 1.5) gun.mag.s = 1;
  // support hand path
  const supportHome = handFromGun('l', T.l);
  let hp, hq;
  if (t < 0.3) { hp = supportHome.p; hq = supportHome.q; }
  else if (t < 0.75) {
    const u = smooth((t - 0.3) / 0.45);
    hp = supportHome.p.clone().lerp(pouch.clone().add(V(-0.02, -0.04, -0.03)), u);
    hq = supportHome.q.clone().slerp(R.handQuat('l', V(0, -1, 0.2), V(-1, 0, 0)), u);
  } else if (t < 1.5) { hp = handW.p; hq = handW.q; }
  else {
    // back onto the gun; the support thumb rides the slide stop down -> slide release at 1.82 s
    const u = smooth((t - 1.5) / 0.3);
    const from = handW || { p: below(0), q: supportHome.q };
    hp = from.p.clone().lerp(supportHome.p, u);
    hq = from.q.clone().slerp(supportHome.q, u);
  }
  R.placeHand('l', hp, hq, supportPole());
  R.curl('l', { thumb: [10, 15, 10], index: [45, 50, 30], middle: [50, 55, 35], ring: [50, 55, 35], pinky: [50, 55, 35] });
  if (t >= 1.5) {
    const u = smooth((t - 1.5) / 0.3);
    const a = fingerSnap('l');
    for (const [n, q] of Object.entries(supportSnap)) R.b[n].quaternion.copy(a[n]).slerp(q, u);
    R.update();
  }
  // while away from the grip keep the support hand outside the gun (lift along the gun's up/left axis)
  if (t >= 0.25 && t < 1.78) {
    const away = V(0.4, 1, 0).normalize().applyQuaternion(gun.quat).multiplyScalar(0.002);
    for (let i = 0; i < 40 && minDist(leftGlove).d < 0.001; i++) { hp.add(away); R.placeHand('l', hp, hq, supportPole()); }
  }
}, 'made: empty-gun reload: mag drop, new mag from the belt pouch, insert, support hand back on, slide-stop release');

// ----------------------------------------------------------------------------- penetration report
function penetration() {
  const glove = vertsOf((b) => /^(hand|thumb|index|middle|ring|pinky)_/.test(b));
  const out = {};
  for (const { clip, fn } of clips) {
    let worst = 0, count = 0, frames = 0, worstT = 0, ikErr = 0;
    const byBone = {};
    const n = Math.max(2, Math.round(clip.duration * 30) + 1);
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
  }
  return out;
}
report.clips = penetration();
console.log(JSON.stringify(report, null, 1));

// ----------------------------------------------------------------------------- export
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(rawPath);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];
const nodes = Object.fromEntries(root.listNodes().map((n) => [n.getName(), n]));
const scene = root.getDefaultScene() || root.listScenes()[0];
// fp_root: turn around (face -Z) and put the eye at the origin
const fp = doc.createNode('fp_root');
const flip = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI);
fp.setRotation(flip.toArray()).setTranslation(EYE.clone().applyQuaternion(flip).negate().toArray());
for (const c of scene.listChildren()) { scene.removeChild(c); fp.addChild(c); }
scene.addChild(fp);
fp.addChild(doc.createNode('eye').setTranslation(EYE.toArray()).setRotation(flip.toArray()));
fp.addChild(doc.createNode('camera_chest').setTranslation(EYE.clone().add(V(0, -0.25, 0)).toArray()).setRotation(flip.toArray()));
const gmat = gunMaterial(doc, 'pistol_mat');
// pistol under hand_r: weapon-in-hand = T_r^-1
const wih = T.r.clone().invert();
const wp = V(), wq = new THREE.Quaternion();
wih.decompose(wp, wq, V());
const pistol = doc.createNode('pistol').setTranslation(wp.toArray()).setRotation(wq.toArray());
nodes.hand_r.addChild(pistol);
let gunTris = 0;
for (const part of PARTNAMES) {
  const g = partGeometry(part);
  gunTris += g.attributes.position.count / 3;
  const rest = PART_REST[part];
  const node = doc.createNode(`pistol_${part}`).setMesh(addGeometry(doc, buffer, g, gmat, `pistol_${part}`))
    .setTranslation(rest.p).setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rest.r)).toArray());
  pistol.addChild(node);
  nodes[`pistol_${part}`] = node;
}
for (const { clip } of clips) {
  const anim = doc.createAnimation(clip.name);
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const node = nodes[tr.name.slice(0, dot)];
    const prop = tr.name.slice(dot + 1);
    const p = prop === 'quaternion' ? 'rotation' : prop === 'position' ? 'translation' : 'scale';
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(tr.times)).setBuffer(buffer);
    const output = doc.createAccessor().setType(p === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(tr.values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(clip.name === 'fp_reload' && prop === 'scale' ? 'STEP' : 'LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(p).setSampler(sampler));
  }
}
nodes.fp_arms.setName('fp_arms');
const armTris = root.listMeshes().filter((m) => m.getName() === 'fp_arms').reduce((a, m) => a + m.listPrimitives()[0].getIndices().getCount() / 3, 0);
root.listNodes()[0].setExtras({ armTris, gunTris, eye: EYE.toArray() });
await doc.transform(
  resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'fp_arms_pistol.glb');
await io.write(outFile, doc);
report.tris = { arms: armTris, pistol: gunTris, total: armTris + gunTris };
report.bytes = fs.statSync(outFile).size;
fs.writeFileSync(path.join(outDir, 'fp_arms_pistol.clips.json'), JSON.stringify(clipInfo, null, 1));
fs.writeFileSync(path.join(outDir, 'penetration_report.json'), JSON.stringify(report, null, 1));
console.log('written', outFile, report.tris, report.bytes, 'bytes');
