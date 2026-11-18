import * as THREE from 'three';
import { SKEL } from './character.js';

// Procedural animation for a character from character.js.
// - Feet are placed by two-bone IK on a gait cycle whose phase advances with distance travelled
//   (stance foot moves backwards at exactly ground speed -> no sliding), pelvis height follows leg reach.
// - Weapon pose is defined in an aim frame (chest position, aim yaw/pitch); hands reach it by arm IK,
//   so the upper body turns toward the target and the weapon really points there.
// Inputs per frame (all optional except aimYaw):
//   { aimYaw, aimPitch, lookYaw, lookPitch, raise 0..1 (0 relaxed, .5 low ready, 1 aiming), crouch 0..1,
//     reload -1 | 0..1 (phase), strafe bool, ground(x,z) -> y }
// Yaw convention: forward = (sin yaw, 0, cos yaw).

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const sstep = (a, b, x) => smooth01((x - a) / (b - a));
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const approach = (cur, target, rate) => cur + (target - cur) * (1 - Math.exp(-rate));

// temporaries
const _v = new THREE.Vector3(), _S = new THREE.Vector3(), _T = new THREE.Vector3(), _M = new THREE.Vector3(), _E = new THREE.Vector3();
const _pole = new THREE.Vector3(), _ref = new THREE.Vector3(), _ax = new THREE.Vector3(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
const _d = new THREE.Vector3(), _b = new THREE.Vector3(), _wp = new THREE.Vector3(), _cp = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _qU = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qH = new THREE.Quaternion();
const _wq = new THREE.Quaternion(), _yawQ = new THREE.Quaternion(), _lq = new THREE.Quaternion(), _hq = new THREE.Quaternion();
const _fk1 = new THREE.Quaternion(), _fk2 = new THREE.Quaternion(), _fk3 = new THREE.Quaternion(), _rootQ = new THREE.Quaternion();
const _ik1 = new THREE.Quaternion(), _ik2 = new THREE.Quaternion(), _ik3 = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ'), _eulX = new THREE.Euler(), _mat = new THREE.Matrix4();
const _foot = [new THREE.Vector3(), new THREE.Vector3()], _footPitch = [0, 0], _stance = [false, false];

/** Quaternion whose local +Y equals yAxis (unit) and local +Z is as close as possible to zRef. */
export function basisQuatY(out, yAxis, zRef) {
  _z.copy(zRef).addScaledVector(yAxis, -zRef.dot(yAxis));
  if (_z.lengthSq() < 1e-8) {
    _z.set(0, 0, 1).addScaledVector(yAxis, -yAxis.z);
    if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0).addScaledVector(yAxis, -yAxis.x);
  }
  _z.normalize();
  _x.crossVectors(yAxis, _z);
  _mat.makeBasis(_x, yAxis, _z);
  return out.setFromRotationMatrix(_mat);
}

/** Quaternion whose local +Z equals zAxis (unit) and local +Y is as close as possible to yRef. */
export function basisQuatZ(out, zAxis, yRef) {
  _x.crossVectors(yRef, zAxis);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _ax.crossVectors(zAxis, _x);
  _mat.makeBasis(_x, _ax, zAxis);
  return out.setFromRotationMatrix(_mat);
}

/** Two-bone IK: root S, target T, bend toward pole. Writes joint (mid) and reached end. */
export function solveTwoBone(S, T, pole, l1, l2, outMid, outEnd) {
  _d.subVectors(T, S);
  let d = _d.length();
  const maxR = (l1 + l2) * 0.999, minR = Math.abs(l1 - l2) + 1e-3;
  if (d < 1e-6) { _d.set(0, -1, 0); d = minR; } else _d.divideScalar(d);
  d = clamp(d, minR, maxR);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _b.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_b.lengthSq() < 1e-8) { _b.set(0, 0, 1).addScaledVector(_d, -_d.z); }
  _b.normalize();
  outMid.copy(S).addScaledVector(_d, a).addScaledVector(_b, h);
  outEnd.copy(S).addScaledVector(_d, d);
}

// Weapon pose keyframes in the aim frame (offset from chest joint, yaw-only frame; pitch/yaw/roll extra).
const POSES = {
  rifle: {
    relaxed: { o: [-0.07, -0.03, 0.2], p: -0.95, y: 0.55, r: 0.35 },
    low: { o: [-0.09, 0.09, 0.24], p: -0.6, y: 0.3, r: 0.12 },
    aim: { o: [-0.1, 0.235, 0.19], p: 0, y: 0, r: 0 },
    reload: { o: [-0.06, 0.08, 0.27], p: -0.35, y: 0.5, r: 0.6 },
  },
  pistol: {
    relaxed: { o: [-0.06, 0.0, 0.25], p: -0.95, y: 0.15, r: 0.1 },
    low: { o: [-0.05, 0.05, 0.3], p: -0.8, y: 0.1, r: 0.0 },
    aim: { o: [-0.035, 0.255, 0.46], p: 0, y: 0, r: 0 },
    reload: { o: [-0.04, 0.1, 0.3], p: -0.3, y: 0.35, r: 0.5 },
  },
};
const _pose = { o: [0, 0, 0], p: 0, y: 0, r: 0 };
function blendPose(out, a, b, t) {
  out.o[0] = lerp(a.o[0], b.o[0], t); out.o[1] = lerp(a.o[1], b.o[1], t); out.o[2] = lerp(a.o[2], b.o[2], t);
  out.p = lerp(a.p, b.p, t); out.y = lerp(a.y, b.y, t); out.r = lerp(a.r, b.r, t);
  return out;
}

export class Animator {
  constructor(ch) {
    this.ch = ch;
    this.prevPos = ch.root.position.clone();
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.lowerYaw = ch.root.rotation.y;
    this.phase = Math.random();
    this.gaitW = 0; this.runW = 0;
    this.pelvisY = SKEL.pelvisY - 0.012;
    this.raise = 0; this.crouch = 0; this.reloadW = 0;
    this.flinch = { x: 0, z: 0, vx: 0, vz: 0, hx: 0, hvx: 0 };
    this.recoil = 0;
    this.time = Math.random() * 100;
    this.seed = Math.random() * 10;
    this.dirL = new THREE.Vector2(0, 1);
  }

  teleport(pos, yaw) {
    this.ch.root.position.copy(pos);
    this.prevPos.copy(pos);
    this.vel.set(0, 0, 0);
    this.lowerYaw = yaw;
    this.ch.root.rotation.set(0, yaw, 0);
  }

  /** Hit reaction: dir = bullet direction (world). */
  addFlinch(dir, strength = 1) {
    const y = this.lowerYaw, c = Math.cos(y), s = Math.sin(y);
    const lx = dir.x * c - dir.z * s, lz = dir.x * s + dir.z * c;
    const f = this.flinch;
    f.vx += lz * 7 * strength; f.vz += -lx * 7 * strength;
    f.hvx += lz * 10 * strength;
  }

  addRecoil(a = 1) { this.recoil = Math.min(this.recoil + 0.09 * a, 0.25); }

  update(dt, a) {
    const ch = this.ch, B = ch.bones, s = ch.scale, root = ch.root, S = SKEL;
    this.time += dt;
    const t = this.time;

    // ---- velocity from actual displacement (guarantees speed-matched feet) ----
    if (dt > 1e-5) {
      _v.subVectors(root.position, this.prevPos).divideScalar(dt); _v.y = 0;
      if (_v.lengthSq() > 144) _v.set(0, 0, 0);
      this.vel.lerp(_v, 1 - Math.exp(-14 * dt));
    }
    this.prevPos.copy(root.position);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.speed = speed;
    const sp = speed / s;   // body-relative speed

    this.raise = approach(this.raise, a.raise ?? 0, dt * 5);
    this.crouch = approach(this.crouch, a.crouch ?? 0, dt * 4.5);
    const reloading = (a.reload ?? -1) >= 0;
    this.reloadW = approach(this.reloadW, reloading ? 1 : 0, dt * 7);
    const crouch = this.crouch, raise = this.raise;
    const aimYaw = a.aimYaw ?? this.lowerYaw, aimPitch = clamp(a.aimPitch ?? 0, -1.0, 1.0);

    // ---- lower body heading ----
    let desired = this.lowerYaw;
    if (speed > 0.25) {
      const moveYaw = Math.atan2(this.vel.x, this.vel.z);
      const diff = wrapAngle(aimYaw - moveYaw);
      desired = (a.strafe && Math.abs(diff) > 1.7) ? moveYaw + Math.PI : moveYaw;
      if (a.strafe && Math.abs(diff) > 1.0 && Math.abs(diff) <= 1.7) desired = moveYaw + Math.sign(diff) * (Math.abs(diff) - 1.0);
    } else {
      const diff = wrapAngle(aimYaw - this.lowerYaw);
      if (Math.abs(diff) > (raise > 0.6 ? 0.45 : 0.85) || this.turning) {
        desired = aimYaw;
        this.turning = Math.abs(diff) > 0.08;
      }
    }
    const turnRate = speed > 0.25 ? 6 : 4.5;
    const dy = clamp(wrapAngle(desired - this.lowerYaw), -turnRate * dt, turnRate * dt);
    this.lowerYaw = wrapAngle(this.lowerYaw + dy);
    const yawRate = dt > 0 ? dy / dt : 0;
    root.rotation.set(0, this.lowerYaw, 0);

    // ---- gait ----
    const cy = Math.cos(this.lowerYaw), sy = Math.sin(this.lowerYaw);
    // turning on the spot produces small shuffling steps
    const turnStep = speed < 0.25 ? Math.min(Math.abs(yawRate) * 0.25, 0.5) : 0;
    const gaitSpeed = Math.max(sp, turnStep);
    this.gaitW = approach(this.gaitW, clamp(gaitSpeed / 0.45, 0, 1), dt * 8);
    this.runW = approach(this.runW, clamp((sp - 1.9) / 1.5, 0, 1), dt * 5);
    const gw = this.gaitW, rw = this.runW, walkW = gw * (1 - rw);
    const stride = clamp(0.55 + 0.45 * gaitSpeed, 0.7, 2.4) * (1 - 0.25 * crouch);
    const D = lerp(0.6, 0.36, rw);
    this.phase = (this.phase + (gaitSpeed / stride) * dt) % 1;
    const stepHalf = (stride * D) / 2 * gw;
    if (speed > 0.2) {
      const lx = this.vel.x * cy - this.vel.z * sy, lz = this.vel.x * sy + this.vel.z * cy;
      const l = Math.hypot(lx, lz) || 1;
      this.dirL.set(lx / l, lz / l);
    } else if (turnStep > 0) this.dirL.set(Math.sign(yawRate) || 1, 0);
    const ground = a.ground;
    const liftH = lerp(0.09, 0.2, rw) * (1 - 0.4 * crouch);
    const reach = (S.thigh + S.shin) * 0.995;
    let pelvisLimit = S.pelvisY - 0.012;
    const sway = 0.022 * walkW * Math.cos(TAU * (this.phase - D / 2)) + 0.02 * Math.sin(t * 0.45 + this.seed) * (1 - gw);

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const p = (this.phase + i * 0.5) % 1;
      const f = _foot[i];
      // base stance (crouch: one foot forward, one back)
      let bxp = side * (0.1 + 0.03 * crouch), bzp = 0.02 + (i === 0 ? 0.17 : -0.13) * crouch;
      let off, lift = 0, heel = 0, pitch;
      if (p < D) {
        const u = p / D;
        off = stepHalf * (1 - 2 * u);
        heel = sstep(0.62, 1, u) * 0.09 * gw;
        pitch = u < 0.15 ? -0.25 * (1 - u / 0.15) * gw : Math.asin(clamp(heel / 0.15, 0, 0.9));
        _stance[i] = true;
      } else {
        const u = (p - D) / (1 - D);
        off = -stepHalf + 2 * stepHalf * smooth01(u);
        lift = liftH * Math.sin(Math.PI * u) * gw;
        pitch = lerp(0.55, -0.2, u) * gw;
        _stance[i] = false;
      }
      if (crouch > 0.5 && i === 1) pitch += 0.6 * (crouch - 0.5) * 2;   // back foot on its toes when crouched
      f.set(bxp + this.dirL.x * off, 0, bzp + this.dirL.y * off);
      // ground under the foot (supports ramps/stairs)
      let gy = 0;
      if (ground) {
        const wx = root.position.x + (f.x * cy + f.z * sy) * s, wz = root.position.z + (-f.x * sy + f.z * cy) * s;
        const g = ground(wx, wz);
        if (Number.isFinite(g)) gy = clamp((g - root.position.y) / s, -0.45, 0.45);
      }
      f.y = gy + S.ankleH + lift + heel;
      _footPitch[i] = pitch;
      if (_stance[i]) {
        const hx = f.x - side * S.hipX - sway, hz = f.z;
        const h2 = hx * hx + hz * hz;
        const maxHip = f.y - heel * 0.5 + Math.sqrt(Math.max(0, reach * reach - h2));
        pelvisLimit = Math.min(pelvisLimit, maxHip - S.hipY);
      }
    }
    let pelvisTarget = Math.min(S.pelvisY - 0.012, pelvisLimit + 0.012) - crouch * 0.42 - rw * 0.035;
    pelvisTarget += 0.012 * Math.sin(t * 1.6 + this.seed) * (1 - gw) * 0.3;
    this.pelvisY = approach(this.pelvisY, pelvisTarget, dt * 18);

    // ---- flinch spring & recoil ----
    const fl = this.flinch;
    fl.vx += (-140 * fl.x - 13 * fl.vx) * dt; fl.x += fl.vx * dt;
    fl.vz += (-140 * fl.z - 13 * fl.vz) * dt; fl.z += fl.vz * dt;
    fl.hvx += (-160 * fl.hx - 12 * fl.hvx) * dt; fl.hx += fl.hvx * dt;
    this.recoil *= Math.exp(-13 * dt);

    // ---- pelvis & spine ----
    const cyc = Math.cos(TAU * this.phase);
    const pelvisYaw = -0.11 * gw * cyc * (1 - 0.5 * raise);
    B.pelvis.position.set(sway, this.pelvisY, -0.02 * rw);
    B.pelvis.rotation.set(0.05 * rw + 0.12 * crouch, pelvisYaw, 0.035 * walkW * Math.cos(TAU * (this.phase - D / 2)) + 0.025 * Math.sin(t * 0.45 + this.seed) * (1 - gw));

    const twist = clamp(wrapAngle(aimYaw - this.lowerYaw), -1.35, 1.35);
    const breathe = Math.sin(t * 1.7 + this.seed) * (0.012 + 0.01 * rw);
    const lean = 0.04 + rw * 0.16 + crouch * 0.24 + fl.x * 0.6 - aimPitch * 0.18 * raise - this.recoil * 0.15;
    B.spine.rotation.set(lean, twist * 0.42 - pelvisYaw * 0.5, fl.z * 0.6 - B.pelvis.rotation.z * 0.6);
    B.chest.rotation.set(-breathe + fl.x * 0.4 - aimPitch * 0.22 * raise - crouch * 0.06 - this.recoil * 0.2,
      twist * 0.58 - pelvisYaw * 0.5, fl.z * 0.4 - B.pelvis.rotation.z * 0.4);

    // ---- head ----
    const chestYaw = this.lowerYaw + pelvisYaw + B.spine.rotation.y + B.chest.rotation.y;
    const lookYaw = a.lookYaw ?? aimYaw;
    const rel = clamp(wrapAngle(lookYaw - chestYaw), -1.3, 1.3);
    const totalLean = B.pelvis.rotation.x + B.spine.rotation.x + B.chest.rotation.x;
    const aimW = raise > 0.8 ? (raise - 0.8) / 0.2 : 0;
    const rifleAim = ch.weaponType === 'rifle' ? aimW : 0;
    const headPitch = clamp(-(a.lookPitch ?? aimPitch) - totalLean + 0.1 * rifleAim, -0.8, 0.9);
    B.neck.rotation.set(headPitch * 0.4 + fl.hx * 0.3, rel * 0.4, 0);
    B.head.rotation.set(headPitch * 0.6 + fl.hx * 0.5, rel * 0.6, 0.14 * rifleAim);

    root.updateMatrixWorld(true);

    // ---- legs (IK) ----
    _rootQ.copy(root.quaternion);
    B.pelvis.getWorldQuaternion(_pq);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const th = i === 0 ? B.thighL : B.thighR, sh = i === 0 ? B.shinL : B.shinR, ft = i === 0 ? B.footL : B.footR;
      _S.setFromMatrixPosition(th.matrixWorld);
      _T.copy(_foot[i]).applyMatrix4(root.matrixWorld);
      _pole.set(side * 0.12, 0, 1).applyQuaternion(_rootQ);
      solveTwoBone(_S, _T, _pole, S.thigh * s, S.shin * s, _M, _E);
      basisQuatY(_qU, _ax.subVectors(_S, _M).normalize(), _pole);
      th.quaternion.copy(_pq).invert().multiply(_qU);
      basisQuatY(_qL, _ax.subVectors(_M, _E).normalize(), _pole);
      sh.quaternion.copy(_qU).invert().multiply(_qL);
      _eulX.set(_footPitch[i], 0, 0);
      _hq.setFromEuler(_eulX).premultiply(_rootQ);
      ft.quaternion.copy(_qL).invert().multiply(_hq);
    }

    // ---- arms ----
    const W = ch.weapon;
    const poses = POSES[ch.weaponType] || POSES.pistol;
    if (raise < 0.5) blendPose(_pose, poses.relaxed, poses.low, raise / 0.5);
    else blendPose(_pose, poses.low, poses.aim, (raise - 0.5) / 0.5);
    if (this.reloadW > 0.001) blendPose(_pose, _pose, poses.reload, this.reloadW);
    B.chest.updateMatrixWorld(false);
    _cp.setFromMatrixPosition(B.chest.matrixWorld);
    _yawQ.setFromAxisAngle(_tmp.set(0, 1, 0), aimYaw);
    _eul.set(-(aimPitch * smooth01(raise * 2 - 0.6) + _pose.p) - this.recoil, aimYaw + _pose.y, _pose.r);
    _wq.setFromEuler(_eul);
    _wp.set(_pose.o[0], _pose.o[1], _pose.o[2]).multiplyScalar(s).applyQuaternion(_yawQ).add(_cp);
    _wp.addScaledVector(_tmp.set(0, 0, -1).applyQuaternion(_wq), this.recoil * 0.12 * s);

    B.chest.getWorldQuaternion(_pq);
    const chestFwd = _ref.set(0, 0, 1).applyQuaternion(_pq);
    const isPistol = ch.weaponType !== 'rifle';
    const relaxedArms = isPistol ? 1 - sstep(0.25, 0.45, raise) : 0;
    const wR = Math.max(1 - relaxedArms, this.reloadW);
    const ikL = Math.max(isPistol ? sstep(0.3, 0.5, raise) : 1, this.reloadW);

    // FK swing values
    const amp = gw * lerp(0.3, 0.65, rw) * (1 - crouch * 0.5);
    const swing = amp * cyc;
    const elbowRun = 0.2 + rw * 1.05;

    // reload: left hand path support -> magwell -> pouch -> magwell -> support
    let leftTarget = null;
    const rp = reloading ? a.reload : -1;
    if (rp >= 0) {
      const magwell = _T.copy(W.magwell).multiplyScalar(s).applyQuaternion(_wq).add(_wp);
      const pouch = _M.set(0.13, -0.28, 0.12).multiplyScalar(s).applyQuaternion(_yawQ).add(_cp);
      const support = _E.copy(W.supportPos).multiplyScalar(s).applyQuaternion(_wq).add(_wp);
      leftTarget = _S;
      if (rp < 0.15) leftTarget.lerpVectors(support, magwell, smooth01(rp / 0.15));
      else if (rp < 0.25) leftTarget.copy(magwell);
      else if (rp < 0.45) leftTarget.lerpVectors(magwell, pouch, smooth01((rp - 0.25) / 0.2));
      else if (rp < 0.55) leftTarget.copy(pouch);
      else if (rp < 0.75) leftTarget.lerpVectors(pouch, magwell, smooth01((rp - 0.55) / 0.2));
      else if (rp < 0.85) leftTarget.copy(magwell);
      else leftTarget.lerpVectors(magwell, support, smooth01((rp - 0.85) / 0.15));
      W.magMesh.visible = !(rp > 0.2 && rp < 0.8);
      ch.handMag.visible = rp > 0.2 && rp < 0.8;
    } else {
      W.magMesh.visible = true;
      ch.handMag.visible = false;
    }

    for (let i = 0; i < 2; i++) {
      const left = i === 0, side = left ? 1 : -1;
      const ua = left ? B.upperArmL : B.upperArmR, fa = left ? B.foreArmL : B.foreArmR, hd = left ? B.handL : B.handR;
      const w = left ? ikL : wR;
      // FK
      const sw = left ? swing : -swing;
      const holdingPistol = !left && isPistol;
      _eulX.set(0.06 + sw * (holdingPistol ? 0.6 : 1), 0, side * (0.09 + 0.015 * Math.sin(t * 1.7 + this.seed)), 'XYZ');
      _fk1.setFromEuler(_eulX);
      _eulX.set(-(elbowRun + Math.max(0, -sw) * 0.5 + (holdingPistol ? 0.25 : 0)), 0, 0, 'XYZ');
      _fk2.setFromEuler(_eulX);
      _eulX.set(holdingPistol ? 1.0 : 0.1, 0, 0, 'XYZ');
      _fk3.setFromEuler(_eulX);
      if (w > 0.001) {
        // IK target (wrist position + hand orientation) from the weapon frame
        if (left) {
          _T.copy(W.supportPos).multiplyScalar(s).applyQuaternion(_wq).add(_wp);
          if (leftTarget) _T.copy(leftTarget);
          _hq.copy(_wq).multiply(W.supportQuat);
        } else {
          _T.copy(W.rightWrist).multiplyScalar(s).applyQuaternion(_wq).add(_wp);
          _hq.copy(_wq);
        }
        _S.setFromMatrixPosition(ua.matrixWorld);
        const out = side * lerp(0.75, 1.05, raise * (left ? 0.4 : 1));
        _pole.set(out, -1, -0.35).normalize().applyQuaternion(_yawQ);
        solveTwoBone(_S, _T, _pole, S.upperArm * s, S.foreArm * s, _M, _E);
        basisQuatY(_qU, _ax.subVectors(_S, _M).normalize(), chestFwd);
        basisQuatY(_qL, _ax.subVectors(_M, _E).normalize(), chestFwd);
        _ik1.copy(_pq).invert().multiply(_qU);
        _ik2.copy(_qU).invert().multiply(_qL);
        _ik3.copy(_qL).invert().multiply(_hq);
        ua.quaternion.slerpQuaternions(_fk1, _ik1, w);
        fa.quaternion.slerpQuaternions(_fk2, _ik2, w);
        hd.quaternion.slerpQuaternions(_fk3, _ik3, w);
      } else {
        ua.quaternion.copy(_fk1); fa.quaternion.copy(_fk2); hd.quaternion.copy(_fk3);
      }
    }

    root.updateMatrixWorld(true);
  }
}
