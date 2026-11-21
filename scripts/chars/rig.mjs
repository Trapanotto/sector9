// Pose-authoring rig on top of three.js bones (headless): sampling clips, world-space rotations,
// two-bone IK, hand orientation, finger curls, and recording keyframed AnimationClips.
import { THREE } from './threeio.mjs';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

export const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const deg = (d) => (d * Math.PI) / 180;
/** Piecewise smooth keyframe curve: keys = [[t, v], ...]. */
export function curve(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return lerp(v0, v1, smooth((t - t0) / (t1 - t0)));
    }
  }
  return keys[keys.length - 1][1];
}
/** Hit-reaction envelope: fast rise, damped decay. */
export function impulse(t, rise = 0.07, decay = 0.22) {
  if (t < 0) return 0;
  if (t < rise) return smooth(t / rise);
  const u = (t - rise) / decay;
  return Math.exp(-u * 1.6) * Math.cos(u * 1.3);
}

export class Rig {
  constructor(rootBone, boneNames) {
    this.group = new THREE.Group();
    this.root = rootBone.clone();
    this.root.scale.set(1, 1, 1);
    this.group.add(this.root);
    this.b = {};
    this.root.traverse((o) => { if (o.isBone) this.b[o.name] = o; });
    this.names = boneNames.filter((n) => this.b[n]);
    this.restQ = {};
    for (const n of this.names) this.restQ[n] = this.b[n].quaternion.clone();
    this.restP = this.b.pelvis.position.clone();
    this.interp = new Map();
    this.update();
    // hand frames (local): finger direction and palm normal, derived from the rest skeleton
    this.handLocal = {};
    for (const s of ['l', 'r']) {
      const h = this.b[`hand_${s}`];
      const f = this.b[`middle_01_${s}`].position.clone().normalize();
      const sIdx = this.b[`index_01_${s}`].position.clone();
      // thumb-side vector across the knuckles: pinky->index (full hand) or middle->index (trimmed hand).
      // (The thumb base itself sits on the palm side, so it must not be used here.)
      const sPk = (this.b[`pinky_01_${s}`] || this.b[`middle_01_${s}`]).position.clone();
      const side = sIdx.clone().sub(sPk);
      side.sub(f.clone().multiplyScalar(side.dot(f))).normalize();
      const n = s === 'l' ? f.clone().cross(side) : side.clone().cross(f);
      this.handLocal[s] = { f, n: n.normalize(), side };
      void h;
    }
  }

  update() { this.group.updateMatrixWorld(true); }

  reset() {
    for (const n of this.names) this.b[n].quaternion.copy(this.restQ[n]);
    this.b.pelvis.position.copy(this.restP);
    this.update();
  }

  /** Apply a clip at time t (optionally only some bones). */
  sample(clip, t, only = null) {
    for (const tr of clip.tracks) {
      const dot = tr.name.lastIndexOf('.');
      const bn = tr.name.slice(0, dot);
      if (only && !only.has(bn)) continue;
      const bone = this.b[bn];
      if (!bone) continue;
      let it = this.interp.get(tr);
      if (!it) { it = tr.createInterpolant(); this.interp.set(tr, it); }
      const tt = Math.min(Math.max(t, 0), clip.duration);
      const r = it.evaluate(tt);
      if (tr.name.endsWith('quaternion')) bone.quaternion.fromArray(r).normalize();
      else if (tr.name.endsWith('position')) bone.position.fromArray(r);
    }
    this.update();
  }

  snap() {
    const q = {};
    for (const n of this.names) q[n] = this.b[n].quaternion.clone();
    return { q, p: this.b.pelvis.position.clone() };
  }

  apply(s, only = null) {
    for (const n of this.names) if (!only || only.has(n)) this.b[n].quaternion.copy(s.q[n]);
    if (!only || only.has('pelvis')) this.b.pelvis.position.copy(s.p);
    this.update();
  }

  /** this = lerp(a, b, w) */
  blend(a, b, w, only = null) {
    for (const n of this.names) {
      if (only && !only.has(n)) continue;
      this.b[n].quaternion.copy(a.q[n]).slerp(b.q[n], w);
    }
    if (!only || only.has('pelvis')) this.b.pelvis.position.copy(a.p).lerp(b.p, w);
    this.update();
  }

  wpos(n) { return this.b[n].getWorldPosition(V()); }
  wquat(n) { return this.b[n].getWorldQuaternion(new THREE.Quaternion()); }

  setWorldQuat(n, q) {
    const bone = this.b[n];
    bone.parent.getWorldQuaternion(_q);
    bone.quaternion.copy(_q.invert().multiply(q));
    bone.updateMatrixWorld(true);
  }

  /** Rotate a bone about a world axis (keeps children attached). */
  rot(n, axis, angle) {
    if (!angle) return;
    const wq = this.wquat(n);
    _q2.setFromAxisAngle(_v.copy(axis).normalize(), angle);
    this.setWorldQuat(n, _q2.multiply(wq));
  }

  /** Rotate bone so that the direction (child - bone) points along dir (world). */
  aim(n, child, dir) {
    const a = this.wpos(n);
    const c = this.wpos(child);
    const cur = c.sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    this.setWorldQuat(n, q.multiply(this.wquat(n)));
  }

  /** Move the pelvis to a world position (pelvis parent is the root). */
  setPelvisWorld(p) {
    const parent = this.b.pelvis.parent;
    this.b.pelvis.position.copy(parent.worldToLocal(p.clone()));
    this.update();
  }

  /** Two-bone IK: a -> b -> c reaches target; pole is a world point the middle joint bends toward. */
  ik(a, b, c, target, pole) {
    const A = this.wpos(a), B = this.wpos(b), C = this.wpos(c);
    const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
    const T = target.clone();
    let d = T.clone().sub(A);
    const dist = Math.min(Math.max(d.length(), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
    d.normalize();
    // middle joint position in the plane (A, T, pole)
    const toPole = pole.clone().sub(A);
    const perp = toPole.sub(d.clone().multiplyScalar(toPole.dot(d))).normalize();
    const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const Bn = A.clone().add(d.clone().multiplyScalar(l1 * cosA)).add(perp.clone().multiplyScalar(l1 * sinA));
    this.aim(a, b, Bn.clone().sub(A));
    const Tn = A.clone().add(d.multiplyScalar(dist));
    this.aim(b, c, Tn.sub(this.wpos(b)));
  }

  /** World rotation that maps the hand's local (finger dir, palm normal) onto the given world vectors. */
  handQuat(s, fingerDir, palmNormal) {
    const { f, n } = this.handLocal[s];
    const fw = fingerDir.clone().normalize();
    const nw = palmNormal.clone().sub(fw.clone().multiplyScalar(palmNormal.dot(fw))).normalize();
    const nl = n.clone().sub(f.clone().multiplyScalar(n.dot(f))).normalize();
    const mW = new THREE.Matrix4().makeBasis(fw, nw, fw.clone().cross(nw));
    const mL = new THREE.Matrix4().makeBasis(f, nl, f.clone().cross(nl));
    return new THREE.Quaternion().setFromRotationMatrix(mW.multiply(mL.transpose()));
  }

  /** Current world finger direction / palm normal of a hand. */
  handFrame(s) {
    const q = this.wquat(`hand_${s}`);
    return { f: this.handLocal[s].f.clone().applyQuaternion(q), n: this.handLocal[s].n.clone().applyQuaternion(q) };
  }

  /** Place a hand: wrist IK to reach `wrist` world position, then set its world orientation. */
  placeHand(s, wrist, q, pole) {
    this.ik(`upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`, wrist, pole);
    this.setWorldQuat(`hand_${s}`, q);
  }

  /** Curl fingers toward the palm. amounts: {thumb:[a1,a2,a3], index:[...], ...} in degrees. */
  curl(s, amounts) {
    const n = this.handFrame(s).n;
    for (const [finger, arr] of Object.entries(amounts)) {
      for (let i = 0; i < 3; i++) {
        const bn = `${finger}_0${i + 1}_${s}`;
        if (!this.b[bn] || !arr[i]) continue;
        const child = this.b[`${finger}_0${i + 2}_${s}`];
        const p = this.wpos(bn);
        const dir = child ? this.wpos(child.name).sub(p).normalize()
          : V(0, 1, 0).applyQuaternion(this.wquat(bn));
        const axis = dir.clone().cross(n).normalize();
        this.rot(bn, axis, deg(arr[i]));
      }
    }
  }

  /** Record a clip by evaluating fn(t) (which must pose the rig) at fps. */
  record(name, duration, fn, { fps = 30, bones = null } = {}) {
    const names = bones || this.names;
    const nFrames = Math.max(2, Math.round(duration * fps) + 1);
    const times = new Float32Array(nFrames);
    const qv = Object.fromEntries(names.map((n) => [n, new Float32Array(nFrames * 4)]));
    const pv = new Float32Array(nFrames * 3);
    const prev = {};
    for (let i = 0; i < nFrames; i++) {
      const t = (i / (nFrames - 1)) * duration;
      times[i] = t;
      this.reset();
      fn(t);
      this.update();
      for (const n of names) {
        const q = this.b[n].quaternion.clone().normalize();
        if (prev[n] && prev[n].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prev[n] = q;
        q.toArray(qv[n], i * 4);
      }
      this.b.pelvis.position.toArray(pv, i * 3);
    }
    const tracks = names.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, qv[n]));
    tracks.push(new THREE.VectorKeyframeTrack('pelvis.position', times, pv));
    return new THREE.AnimationClip(name, duration, tracks);
  }
}

export { V };
