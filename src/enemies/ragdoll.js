import * as THREE from 'three';
import { SKEL } from './character.js';
import { basisQuatY, basisQuatZ } from './animator.js';

// Verlet particle ragdoll: particles at the joints, distance constraints (rigid torso, limbs), range
// constraints (head, knees/elbows folding), a knee hinge rule, ground + collider contacts with friction.
// The character's bones are re-oriented from the particles every step. Freezes once the body is at rest.

const DEFS = [
  // name, bone, local offset, radius, inverse mass
  ['head', 'head', [0, 0.085, 0.015], 0.1, 0.9],
  ['neck', 'neck', [0, 0, 0], 0.06, 0.6],
  ['shL', 'upperArmL', [0, 0, 0], 0.075, 0.5],
  ['shR', 'upperArmR', [0, 0, 0], 0.075, 0.5],
  ['elL', 'foreArmL', [0, 0, 0], 0.05, 1],
  ['elR', 'foreArmR', [0, 0, 0], 0.05, 1],
  ['wrL', 'handL', [0, 0, 0], 0.045, 1],
  ['wrR', 'handR', [0, 0, 0], 0.045, 1],
  ['hipL', 'thighL', [0, 0, 0], 0.09, 0.5],
  ['hipR', 'thighR', [0, 0, 0], 0.09, 0.5],
  ['knL', 'shinL', [0, 0, 0], 0.065, 0.9],
  ['knR', 'shinR', [0, 0, 0], 0.065, 0.9],
  ['anL', 'footL', [0, 0, 0], 0.07, 1],
  ['anR', 'footR', [0, 0, 0], 0.07, 1],
  ['toL', 'footL', [0, -0.03, 0.15], 0.04, 1],
  ['toR', 'footR', [0, -0.03, 0.15], 0.04, 1],
  ['spine', 'chest', [0, 0, 0], 0.125, 0.4],
];
const IDX = Object.fromEntries(DEFS.map((d, i) => [d[0], i]));
const TOE_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.atan2(0.03, 0.15));

const RIGID = [
  'hipL-hipR', 'shL-shR', 'hipL-shL', 'hipR-shR', 'hipL-shR', 'hipR-shL',
  'neck-shL', 'neck-shR', 'neck-hipL', 'neck-hipR',
  'spine-hipL', 'spine-hipR', 'spine-shL', 'spine-shR', 'spine-neck',
  'neck-head',
  'shL-elL', 'elL-wrL', 'shR-elR', 'elR-wrR',
  'hipL-knL', 'knL-anL', 'hipR-knR', 'knR-anR',
  'anL-toL', 'knL-toL', 'anR-toR', 'knR-toR',
];
const RANGE = [
  ['head-shL', 0.8, 1.15], ['head-shR', 0.8, 1.15], ['head-spine', 0.85, 1.08],
  ['shL-wrL', 0.3, 1.0], ['shR-wrR', 0.3, 1.0],
  ['hipL-anL', 0.5, 1.0], ['hipR-anR', 0.5, 1.0],
  ['spine-knL', 0.62, 1.6], ['spine-knR', 0.62, 1.6],
  ['knL-knR', 0.25, 4], ['anL-anR', 0.25, 6],
];
const TORSO = [IDX.spine, IDX.shL, IDX.shR, IDX.hipL, IDX.hipR, IDX.neck, IDX.head];

const H = 1 / 60;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
const _pq = new THREE.Quaternion(), _sq = new THREE.Quaternion(), _cq = new THREE.Quaternion(), _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _fwd = new THREE.Vector3(), _pf = new THREE.Vector3();

function basisXY(out, xAxis, yRef) {
  _x.copy(xAxis).normalize();
  _z.crossVectors(_x, yRef);
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
  _z.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

export class Ragdoll {
  /**
   * @param ch character
   * @param env { ground(x,z)->y, colliders: Box3[] }
   */
  constructor(ch, env) {
    this.ch = ch;
    this.env = env;
    const n = DEFS.length;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.rad = new Float32Array(n);
    this.inv = new Float32Array(n);
    this.gy = new Float32Array(n);
    this.onGround = new Uint8Array(n);
    this.sticks = [];
    this.time = 0;
    this.acc = 0;
    this.still = 0;
    this.settled = false;
    this.fell = false;
    this.tone = 0; this.toneTime = 0;
    this.onImpact = null;
    this.onSettle = null;
    this.weapon = null;
  }

  p(i, out) { return out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]); }

  /**
   * @param {{dir:THREE.Vector3, part:string, point?:THREE.Vector3, bodyVel?:THREE.Vector3, forward?:THREE.Vector3, scene?:THREE.Object3D}} o
   */
  start(o) {
    const ch = this.ch, B = ch.bones, s = ch.scale;
    ch.root.updateMatrixWorld(true);
    const v = o.bodyVel || _d.set(0, 0, 0);
    for (let i = 0; i < this.n; i++) {
      const [, boneName, off, r, inv] = DEFS[i];
      B[boneName].localToWorld(_a.set(off[0], off[1], off[2]));
      this.pos[i * 3] = _a.x; this.pos[i * 3 + 1] = _a.y; this.pos[i * 3 + 2] = _a.z;
      this.prev[i * 3] = _a.x - v.x * H; this.prev[i * 3 + 1] = _a.y - v.y * H; this.prev[i * 3 + 2] = _a.z - v.z * H;
      this.rad[i] = r * s; this.inv[i] = inv;
    }
    const rest = (i, j) => this.p(i, _a).distanceTo(this.p(j, _b));
    for (const k of RIGID) {
      const [a, b] = k.split('-').map((x) => IDX[x]);
      this.sticks.push({ a, b, min: rest(a, b), max: rest(a, b), stiff: 1 });
    }
    for (const [k, mn, mx] of RANGE) {
      const [a, b] = k.split('-').map((x) => IDX[x]);
      const r = rest(a, b);
      this.sticks.push({ a, b, min: r * mn, max: r * mx, stiff: 0.6 });
    }
    this.legRest = [rest(IDX.hipL, IDX.anL), rest(IDX.hipR, IDX.anR)];

    // impulses
    const dir = _c.copy(o.dir || _c.set(0, 0, 1)); dir.y = Math.max(dir.y, -0.2); dir.normalize();
    const kick = (i, m) => { this.prev[i * 3] -= dir.x * m * H; this.prev[i * 3 + 1] -= dir.y * m * H; this.prev[i * 3 + 2] -= dir.z * m * H; };
    const part = o.part || 'torso';
    let nearest = IDX.spine;
    if (o.point) {
      let best = Infinity;
      for (let i = 0; i < this.n; i++) {
        const d = this.p(i, _a).distanceToSquared(o.point);
        if (d < best) { best = d; nearest = i; }
      }
    }
    if (part === 'head') { kick(IDX.head, 3.4); kick(IDX.neck, 1.6); }
    else if (part === 'limb') { kick(nearest, 3.0); for (const i of TORSO) kick(i, 0.7); }
    else { kick(nearest, 2.4); for (const i of TORSO) kick(i, 1.3); }
    // knees buckle forward, a little randomness so no two falls look the same
    const fwd = o.forward || _fwd.set(0, 0, 1);
    for (const i of [IDX.knL, IDX.knR]) {
      const m = 0.6 + Math.random() * 0.6;
      this.prev[i * 3] -= fwd.x * m * H; this.prev[i * 3 + 2] -= fwd.z * m * H;
    }
    const side = (Math.random() - 0.5) * 0.8;
    this.prev[IDX.spine * 3] -= -fwd.z * side * H; this.prev[IDX.spine * 3 + 2] -= fwd.x * side * H;
    // muscle tone: head shots crumple, torso hits sometimes topple stiffly for a moment
    this.tone = part === 'head' ? 0.03 : Math.random() < 0.5 ? 0.3 : 0.08;
    this.toneTime = 0.25 + Math.random() * 0.35;

    // local collider list
    const cols = this.env?.colliders || [];
    const cx = this.pos[IDX.spine * 3], cz = this.pos[IDX.spine * 3 + 2];
    this.cols = cols.filter((b) => b.max.x > cx - 3 && b.min.x < cx + 3 && b.max.z > cz - 3 && b.min.z < cz + 3);

    // drop the weapon
    if (o.scene && ch.weapon?.group) {
      const g = ch.weapon.group;
      o.scene.attach(g);
      this.weapon = {
        obj: g,
        vel: new THREE.Vector3().copy(v).addScaledVector(dir, 0.8).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.8, (Math.random() - 0.5) * 1.2)),
        ang: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8),
        resting: false, flat: new THREE.Quaternion(), restY: 0,
      };
    }
    ch.handMag.visible = false;
    ch.weapon.magMesh.visible = true;
  }

  update(dt) {
    if (this.settled) { this.stepWeapon(dt); return; }
    this.acc = Math.min(this.acc + dt, H * 4);
    while (this.acc >= H) {
      this.acc -= H;
      this.step();
      if (this.settled) break;
    }
    this.apply();
    this.stepWeapon(dt);
  }

  step() {
    const P = this.pos, Q = this.prev, n = this.n, g = 9.81 * H * H;
    this.time += H;
    const ground = this.env?.ground;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const vx = (P[k] - Q[k]) * 0.996, vy = (P[k + 1] - Q[k + 1]) * 0.996, vz = (P[k + 2] - Q[k + 2]) * 0.996;
      Q[k] = P[k]; Q[k + 1] = P[k + 1]; Q[k + 2] = P[k + 2];
      P[k] += vx; P[k + 1] += vy - g; P[k + 2] += vz;
      let gy = ground ? ground(P[k], P[k + 2]) : 0;
      if (!Number.isFinite(gy)) gy = 0;
      this.gy[i] = gy + this.rad[i];
    }
    const toneOn = this.time < this.toneTime ? this.tone : 0;
    for (let it = 0; it < 10; it++) {
      for (const s of this.sticks) this.solveStick(s.a, s.b, s.min, s.max, s.stiff);
      if (toneOn > 0) {
        this.solveStick(IDX.hipL, IDX.anL, this.legRest[0] * 0.97, this.legRest[0], toneOn);
        this.solveStick(IDX.hipR, IDX.anR, this.legRest[1] * 0.97, this.legRest[1], toneOn);
      }
      this.hinge(IDX.hipL, IDX.knL, IDX.anL);
      this.hinge(IDX.hipR, IDX.knR, IDX.anR);
      this.contacts(it === 9);
    }
    // friction & settling
    let maxMove = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (this.onGround[i]) {
        Q[k] += (P[k] - Q[k]) * 0.4;
        Q[k + 2] += (P[k + 2] - Q[k + 2]) * 0.4;
      }
      maxMove = Math.max(maxMove, Math.abs(P[k] - Q[k]), Math.abs(P[k + 1] - Q[k + 1]), Math.abs(P[k + 2] - Q[k + 2]));
    }
    if (maxMove < 0.0012 && this.time > 0.7) this.still++; else this.still = 0;
    if (this.still > 30 || this.time > 6) {
      this.settled = true;
      this.apply();
      if (!this.fell) { this.fell = true; this.onImpact?.(1); }
      this.onSettle?.(this.groundPoint(new THREE.Vector3()));
    }
  }

  solveStick(a, b, min, max, stiff) {
    const P = this.pos, ka = a * 3, kb = b * 3;
    const dx = P[kb] - P[ka], dy = P[kb + 1] - P[ka + 1], dz = P[kb + 2] - P[ka + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    let target;
    if (d < min) target = min; else if (d > max) target = max; else return;
    const wa = this.inv[a], wb = this.inv[b], w = wa + wb;
    if (w <= 0) return;
    const f = ((d - target) / (d * w)) * stiff;
    P[ka] += dx * f * wa; P[ka + 1] += dy * f * wa; P[ka + 2] += dz * f * wa;
    P[kb] -= dx * f * wb; P[kb + 1] -= dy * f * wb; P[kb + 2] -= dz * f * wb;
  }

  // Knees only bend forward: keep the knee in front of the hip-ankle line (relative to the pelvis).
  hinge(h, k, an) {
    const P = this.pos;
    this.p(IDX.hipL, _a).sub(this.p(IDX.hipR, _b));      // pelvis left axis
    this.p(IDX.shL, _c).add(this.p(IDX.shR, _d)).multiplyScalar(0.5);
    this.p(IDX.hipL, _d).add(_b).multiplyScalar(0.5);   // _b still hipR
    _c.sub(_d);                                          // up
    _pf.crossVectors(_a, _c).normalize();                // forward
    this.p(h, _a); this.p(an, _b);
    _c.addVectors(_a, _b).multiplyScalar(0.5);
    this.p(k, _d).sub(_c);
    const along = _d.dot(_pf);
    const minFwd = 0.015 * this.ch.scale;
    if (along < minFwd) {
      const push = (minFwd - along) * 0.5;
      const kk = k * 3;
      P[kk] += _pf.x * push; P[kk + 1] += _pf.y * push; P[kk + 2] += _pf.z * push;
    }
  }

  contacts(last) {
    const P = this.pos, Q = this.prev;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3, r = this.rad[i];
      let grounded = false;
      if (P[k + 1] < this.gy[i]) {
        const impact = (Q[k + 1] - P[k + 1]) / H;
        P[k + 1] = this.gy[i];
        if (Q[k + 1] < P[k + 1]) Q[k + 1] = P[k + 1];
        grounded = true;
        if (!this.fell && impact > 1.0 && (i === IDX.spine || i === IDX.shL || i === IDX.shR || i === IDX.hipL || i === IDX.hipR || i === IDX.head)) {
          this.fell = true;
          this.onImpact?.(Math.min(1, impact / 4));
        }
      } else if (P[k + 1] < this.gy[i] + 0.01) grounded = true;
      for (const b of this.cols) {
        if (P[k] < b.min.x - r || P[k] > b.max.x + r || P[k + 1] < b.min.y - r || P[k + 1] > b.max.y + r || P[k + 2] < b.min.z - r || P[k + 2] > b.max.z + r) continue;
        const cx = Math.min(Math.max(P[k], b.min.x), b.max.x);
        const cy = Math.min(Math.max(P[k + 1], b.min.y), b.max.y);
        const cz = Math.min(Math.max(P[k + 2], b.min.z), b.max.z);
        let dx = P[k] - cx, dy = P[k + 1] - cy, dz = P[k + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          if (d >= r) continue;
          const f = (r - d) / d;
          P[k] += dx * f; P[k + 1] += dy * f; P[k + 2] += dz * f;
          if (dy > 0.7 * d) grounded = true;
        } else {
          const pen = [P[k] - b.min.x, b.max.x - P[k], P[k + 1] - b.min.y, b.max.y - P[k + 1], P[k + 2] - b.min.z, b.max.z - P[k + 2]];
          let m = 0;
          for (let j = 1; j < 6; j++) if (pen[j] < pen[m]) m = j;
          if (m === 0) P[k] = b.min.x - r; else if (m === 1) P[k] = b.max.x + r;
          else if (m === 2) P[k + 1] = b.min.y - r; else if (m === 3) { P[k + 1] = b.max.y + r; grounded = true; }
          else if (m === 4) P[k + 2] = b.min.z - r; else P[k + 2] = b.max.z + r;
        }
      }
      if (last) this.onGround[i] = grounded ? 1 : 0;
    }
  }

  groundPoint(out) {
    this.p(IDX.spine, _a).lerp(this.p(IDX.hipL, _b).add(this.p(IDX.hipR, _c)).multiplyScalar(0.5), 0.35);
    out.copy(_a);
    const g = this.env?.ground?.(out.x, out.z);
    out.y = Number.isFinite(g) ? g : out.y - 0.12;
    return out;
  }

  /** Drive the character's bones from the particles. */
  apply() {
    const ch = this.ch, B = ch.bones, s = ch.scale, root = ch.root;
    const v = (name, out) => this.p(IDX[name], out);
    const hipL = v('hipL', new THREE.Vector3()), hipR = v('hipR', new THREE.Vector3());
    const shL = v('shL', new THREE.Vector3()), shR = v('shR', new THREE.Vector3());
    const midHip = hipL.clone().add(hipR).multiplyScalar(0.5), midSh = shL.clone().add(shR).multiplyScalar(0.5);
    const spine = v('spine', new THREE.Vector3()), neck = v('neck', new THREE.Vector3()), head = v('head', new THREE.Vector3());

    _rq.copy(root.quaternion);
    const rqInv = _q2.copy(_rq).invert();
    // pelvis
    basisXY(_pq, _a.subVectors(hipL, hipR), _b.subVectors(midSh, midHip));
    const pUp = _c.set(0, 1, 0).applyQuaternion(_pq);
    const pelvisPos = _d.copy(midHip).addScaledVector(pUp, -SKEL.hipY * s);
    B.pelvis.position.copy(pelvisPos).sub(root.position).applyQuaternion(rqInv).divideScalar(s);
    B.pelvis.quaternion.copy(rqInv).multiply(_pq);
    // chest / spine
    basisXY(_cq, _a.subVectors(shL, shR), _b.subVectors(midSh, spine).add(_c.subVectors(midSh, midHip)));
    _sq.slerpQuaternions(_pq, _cq, 0.5);
    B.spine.quaternion.copy(_pq).invert().multiply(_sq);
    B.chest.quaternion.copy(_sq).invert().multiply(_cq);
    const chestFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_cq);
    const pelvisFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_pq);
    // neck & head
    basisQuatY(_q1, _a.subVectors(head, neck).normalize(), chestFwd);
    B.neck.quaternion.copy(_cq).invert().multiply(_q1);
    B.head.quaternion.identity();
    // arms
    for (const side of ['L', 'R']) {
      const sh = side === 'L' ? shL : shR;
      const el = v('el' + side, new THREE.Vector3()), wr = v('wr' + side, new THREE.Vector3());
      const qU = basisQuatY(new THREE.Quaternion(), _a.subVectors(sh, el).normalize(), chestFwd);
      B['upperArm' + side].quaternion.copy(_cq).invert().multiply(qU);
      const qL = basisQuatY(new THREE.Quaternion(), _a.subVectors(el, wr).normalize(), chestFwd);
      B['foreArm' + side].quaternion.copy(qU).invert().multiply(qL);
    }
    // legs
    for (const side of ['L', 'R']) {
      const hip = side === 'L' ? hipL : hipR;
      const kn = v('kn' + side, new THREE.Vector3()), an = v('an' + side, new THREE.Vector3()), to = v('to' + side, new THREE.Vector3());
      const qT = basisQuatY(new THREE.Quaternion(), _a.subVectors(hip, kn).normalize(), pelvisFwd);
      B['thigh' + side].quaternion.copy(_pq).invert().multiply(qT);
      const qS = basisQuatY(new THREE.Quaternion(), _a.subVectors(kn, an).normalize(), pelvisFwd);
      B['shin' + side].quaternion.copy(qT).invert().multiply(qS);
      const qF = basisQuatZ(new THREE.Quaternion(), _a.subVectors(to, an).normalize(), _b.subVectors(kn, an).normalize()).multiply(TOE_FIX);
      B['foot' + side].quaternion.copy(qS).invert().multiply(qF);
    }
    root.updateMatrixWorld(true);
  }

  stepWeapon(dt) {
    const w = this.weapon;
    if (!w) return;
    const o = w.obj;
    if (w.resting) {
      if (!w.done) {
        o.quaternion.slerp(w.flat, 1 - Math.exp(-14 * dt));
        o.position.y += (w.restY - o.position.y) * (1 - Math.exp(-14 * dt));
        if (o.quaternion.angleTo(w.flat) < 0.01) { o.quaternion.copy(w.flat); o.position.y = w.restY; w.done = true; }
      }
      return;
    }
    w.vel.y -= 9.81 * dt;
    o.position.addScaledVector(w.vel, dt);
    _q1.setFromEuler(new THREE.Euler(w.ang.x * dt, w.ang.y * dt, w.ang.z * dt));
    o.quaternion.multiply(_q1);
    let g = this.env?.ground?.(o.position.x, o.position.z);
    if (!Number.isFinite(g)) g = 0;
    if (o.position.y < g + 0.06) {
      w.resting = true;
      const f = _a.set(0, 0, 1).applyQuaternion(o.quaternion);
      const yaw = Math.atan2(f.x, f.z);
      w.flat.setFromEuler(new THREE.Euler(0, yaw, (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2, 'YXZ'));
      w.restY = g + 0.026 * this.ch.scale;
    }
  }
}
