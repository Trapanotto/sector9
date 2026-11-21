// Programmatically authored enemy clips (everything the CC0 libraries do not provide).
// All clips are in place (no root motion) on the shared skeleton; +Z is the character's forward,
// +X its left. Poses are built from sourced UAL frames + world-space bone rotations + 2-bone IK.
import { Rig, V, curve, impulse, smooth, lerp, deg } from './rig.mjs';
import { WEAPONS } from './weapondefs.mjs';
import { THREE } from './threeio.mjs';

const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);

/** Weapon-in-hand frame for the strong (right) hand: returns {pos, quat} of the weapon in hand space. */
export function gripOffset(rig, def, s = 'r') {
  const { f, n, side } = rig.handLocal[s];
  const sd = side.clone().sub(f.clone().multiplyScalar(side.dot(f))).normalize();
  const t = deg(def.gripTilt);
  // grip axis (index side up) leans back by gripTilt relative to the weapon's up axis
  const Yw = sd.clone().multiplyScalar(Math.cos(t)).sub(f.clone().multiplyScalar(Math.sin(t))).normalize();
  const Zw = f.clone().multiplyScalar(Math.cos(t)).add(sd.clone().multiplyScalar(Math.sin(t))).normalize();
  const Xw = Yw.clone().cross(Zw).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xw, Yw, Zw));
  // centre of the closed fist relative to the wrist joint (hand-local units)
  const pos = f.clone().multiplyScalar(0.078).add(n.clone().multiplyScalar(0.026)).add(sd.clone().multiplyScalar(-0.004));
  return { pos, quat };
}

export function authorClips({ lib, rootBone, bones }) {
  const R = new Rig(rootBone, bones);
  const out = [];
  const add = (clip, loop, note) => out.push({ clip, loop, note });
  const all = (clip, t) => R.sample(clip, t % clip.duration);
  const grip = Object.fromEntries(Object.keys(WEAPONS).map((k) => [k, gripOffset(R, WEAPONS[k])]));
  R.gripOffsets = grip;

  const UPPER = new Set(R.names.filter((n) => !/^(thigh|calf|foot|ball|pelvis|root)/.test(n)));
  const SPINE = ['spine_01', 'spine_02', 'spine_03'];
  const fist = { thumb: [10, 25, 20], index: [70, 80, 50], middle: [75, 85, 55] };
  const relaxed = { thumb: [5, 10, 8], index: [20, 25, 15], middle: [25, 30, 18] };

  /** Place a weapon (world pos/quat) and solve both arms onto it. */
  function holdWeapon(kind, wpos, wquat, { supportPole, strongPole, curlS = fist } = {}) {
    const def = WEAPONS[kind];
    const g = grip[kind];
    const handQ = wquat.clone().multiply(g.quat.clone().invert());
    const wrist = wpos.clone().sub(g.pos.clone().applyQuaternion(handQ));
    const sh = R.wpos('upperarm_r');
    R.placeHand('r', wrist, handQ, strongPole || sh.clone().add(V(-0.35, -0.45, -0.1)));
    R.curl('r', curlS);
    if (def.support) {
      // support hand under the handguard/pump: palm up, fingers wrapping across to the weapon's right
      const S = V(...def.support).applyQuaternion(wquat).add(wpos);
      const wx = X.clone().applyQuaternion(wquat), wy = Y.clone().applyQuaternion(wquat), wz = Z.clone().applyQuaternion(wquat);
      const fdir = wx.clone().multiplyScalar(-0.75).add(wz.clone().multiplyScalar(0.55)).add(wy.clone().multiplyScalar(0.3));
      const q = R.handQuat('l', fdir, wy);
      const { f, n } = R.handLocal.l;
      const gl = f.clone().multiplyScalar(0.07).add(n.clone().multiplyScalar(0.03)).applyQuaternion(q);
      const wristL = S.clone().sub(gl);
      const shl = R.wpos('upperarm_l');
      R.placeHand('l', wristL, q, supportPole || shl.clone().add(V(0.3, -0.5, -0.05)));
      R.curl('l', { thumb: [15, 20, 10], index: [55, 60, 40], middle: [60, 65, 45] });
    }
  }

  /** Rifle/SMG/shotgun shouldered aim from the current body pose. pitch<0 = muzzle down. */
  function shoulder(kind, { pitch = 0, yaw = 0, ready = 0 } = {}) {
    const def = WEAPONS[kind];
    // blade the torso a little (left shoulder forward), keep the head on target
    for (const s of SPINE) R.rot(s, Y, deg(-7));
    R.rot('neck_01', Y, deg(12));
    R.rot('Head', Y, deg(8));
    R.rot('Head', Z, deg(7)); // cheek weld: head tilts right toward the stock
    R.rot('Head', X, deg(5));
    const pocket = R.wpos('upperarm_r').add(V(0.05, -0.05, 0.04));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(-pitch), deg(yaw), 0, 'YXZ'));
    if (ready) q.premultiply(new THREE.Quaternion().setFromAxisAngle(Y, deg(ready * 0.35)));
    const stock = V(...def.stock).applyQuaternion(q);
    const wpos = pocket.clone().sub(stock).add(V(0, -0.06 * ready, 0));
    holdWeapon(kind, wpos, q);
    return { wpos, q };
  }

  /** Lower body from one clip/time, upper body from another; chest kept at its world orientation. */
  function layer(lowerClip, lt, upperClip, ut) {
    R.sample(upperClip, ut % upperClip.duration);
    const chestQ = R.wquat('spine_03');
    const up = R.snap();
    R.sample(lowerClip, lt % lowerClip.duration);
    R.apply(up, new Set(['spine_02', 'spine_03', ...UPPER]));
    R.setWorldQuat('spine_03', chestQ);
    R.update();
  }

  // ------------------------------------------------------------------ look around
  add(R.record('look_around', 6.0, (t) => {
    all(lib.idle, t);
    const yaw = curve([[0, 0], [0.6, 0], [1.4, 55], [2.4, 55], [3.1, 0], [3.8, -50], [4.9, -50], [5.6, 0], [6, 0]], t);
    const pitch = curve([[0, 0], [1.4, 6], [2.4, -4], [3.1, 0], [3.8, 5], [4.9, 0], [6, 0]], t);
    R.rot('spine_02', Y, deg(yaw * 0.12));
    R.rot('spine_03', Y, deg(yaw * 0.18));
    R.rot('neck_01', Y, deg(yaw * 0.35));
    R.rot('Head', Y, deg(yaw * 0.35));
    R.rot('Head', X, deg(pitch));
  }), true, 'made: UAL Idle_Loop + keyed spine/neck/head yaw');

  // ------------------------------------------------------------------ long guns
  for (const kind of ['smg', 'shotgun']) {
    const tag = kind === 'smg' ? 'smg' : 'shotgun';
    add(R.record(`${tag}_idle`, 2.5, (t) => {
      all(lib.idle, t);
      shoulder(kind, { pitch: -38, yaw: 18, ready: 1 });
    }), true, `made: UAL Idle_Loop + IK low-ready ${kind}`);
    add(R.record(`${tag}_aim`, 2.0, (t) => {
      R.sample(lib.pistol_aim, 0);
      const br = Math.sin((t / 2) * Math.PI * 2) * 0.6;
      shoulder(kind, { pitch: br * 0.5 });
    }), true, `made: UAL Pistol_Aim stance + IK shouldered ${kind}`);
    add(R.record(`${tag}_aim_crouch`, 2.0, (t) => {
      layer(lib.crouch_idle, t, lib.pistol_aim, 0);
      shoulder(kind, { pitch: Math.sin((t / 2) * Math.PI * 2) * 0.3 });
    }), true, `made: UAL Crouch_Idle legs + aim torso + IK ${kind}`);
    add(R.record(`${tag}_fire`, kind === 'smg' ? 0.12 : 0.55, (t) => {
      R.sample(lib.pistol_aim, 0);
      const k = impulse(t, 0.025, kind === 'smg' ? 0.05 : 0.18) * (kind === 'smg' ? 0.5 : 1.0);
      R.rot('spine_03', X, deg(-4 * k));
      R.rot('spine_02', X, deg(-2 * k));
      R.rot('Head', X, deg(-3 * k));
      shoulder(kind, { pitch: 7 * k });
    }), kind === 'smg', `made: recoil impulse on the shouldered ${kind} pose`);
    add(R.record(`${tag}_reload`, 2.2, (t) => {
      R.sample(lib.pistol_aim, 0);
      // weapon lowered and canted, support hand goes to the belt and back
      const low = curve([[0, 0], [0.3, 1], [1.9, 1], [2.2, 0]], t);
      const { wpos, q } = shoulder(kind, { pitch: -20 * low, yaw: 10 * low, ready: 0.4 * low });
      const reach = curve([[0, 0], [0.45, 0], [0.8, 1], [1.25, 1], [1.6, 0], [2.2, 0]], t);
      if (reach > 0) {
        const def = WEAPONS[kind];
        const S = V(...(def.mag || def.support)).applyQuaternion(q).add(wpos);
        const belt = R.wpos('pelvis').add(V(0.17, 0.05, 0.08));
        const target = S.lerp(belt, reach);
        const qh = R.handQuat('l', V(-0.3, -0.3, 1).normalize(), V(-1, 0.2, 0).normalize());
        R.placeHand('l', target.add(V(0.03, -0.05, -0.05)), qh, R.wpos('upperarm_l').add(V(0.4, -0.4, -0.3)));
        R.curl('l', { thumb: [10, 20, 10], index: [45, 50, 30], middle: [50, 55, 35] });
      }
      R.rot('Head', X, deg(10 * low));
    }), false, `made: keyed support-hand reload on the ${kind}`);
  }

  // ------------------------------------------------------------------ pistol crouch aim
  add(R.record('pistol_aim_crouch', 2.0, (t) => {
    layer(lib.crouch_idle, t, lib.pistol_aim, 0);
  }), true, 'made: UAL Crouch_Idle legs + UAL Pistol_Aim torso/arms (chest held upright)');

  // ------------------------------------------------------------------ flinches (hit reactions)
  const flinch = (name, fn, note) => add(R.record(name, 0.7, (t) => {
    all(lib.idle, 0.3 + t);
    fn(impulse(t, 0.06, 0.2), t);
  }), false, note);
  flinch('hit_back', (k) => {
    R.setPelvisWorld(R.wpos('pelvis').add(V(0, 0, 0.05 * k)));
    for (const s of SPINE) R.rot(s, X, deg(6 * k));
    R.rot('neck_01', X, deg(-14 * k));
    R.rot('Head', X, deg(-10 * k));
    R.rot('upperarm_l', Z, deg(-20 * k));
    R.rot('upperarm_r', Z, deg(20 * k));
  }, 'made: impulse curve, hit from behind (chest thrown forward, head whips back)');
  flinch('hit_left', (k) => {
    R.setPelvisWorld(R.wpos('pelvis').add(V(-0.05 * k, 0, 0)));
    for (const s of SPINE) R.rot(s, Z, deg(7 * k));
    for (const s of SPINE) R.rot(s, Y, deg(-5 * k));
    R.rot('Head', Z, deg(10 * k));
    R.rot('upperarm_l', Z, deg(-25 * k));
    R.rot('clavicle_l', Z, deg(-8 * k));
  }, 'made: impulse curve, hit on the left side (torso bends right)');
  flinch('hit_right', (k) => {
    R.setPelvisWorld(R.wpos('pelvis').add(V(0.05 * k, 0, 0)));
    for (const s of SPINE) R.rot(s, Z, deg(-7 * k));
    for (const s of SPINE) R.rot(s, Y, deg(5 * k));
    R.rot('Head', Z, deg(-10 * k));
    R.rot('upperarm_r', Z, deg(25 * k));
    R.rot('clavicle_r', Z, deg(8 * k));
  }, 'made: impulse curve, hit on the right side (torso bends left)');
  flinch('hit_front', (k) => {
    R.setPelvisWorld(R.wpos('pelvis').add(V(0, 0, -0.05 * k)));
    for (const s of SPINE) R.rot(s, X, deg(-7 * k));
    R.rot('Head', X, deg(12 * k));
    R.rot('upperarm_l', X, deg(-25 * k));
    R.rot('upperarm_r', X, deg(-25 * k));
  }, 'made: impulse curve, hit from the front (torso folds back)');

  // ------------------------------------------------------------------ lying poses (shared by deaths / sleep)
  R.sample(lib.lying_to_idle, 0);
  const supine = R.snap(); // on the back, head toward -Z (UAL LayToIdle frame 0)

  /** Prone pose: rest pose with arms down, rotated face-down onto the ground. */
  function prone(variant = 0) {
    R.reset();
    R.rot('upperarm_l', Z, deg(-70 - variant * 10));
    R.rot('upperarm_r', Z, deg(70 - variant * 25));
    R.rot('lowerarm_l', Y, deg(-30));
    R.rot('lowerarm_r', Y, deg(20 + variant * 40));
    R.rot('thigh_l', Z, deg(-6 - variant * 4));
    R.rot('thigh_r', Z, deg(4 + variant * 10));
    R.rot('calf_r', X, deg(variant * 35));
    R.curl('l', relaxed); R.curl('r', relaxed);
    // whole body pitched forward 90 deg about the feet, then lowered onto the ground
    R.rot('pelvis', X, deg(90));
    const p = R.wpos('pelvis');
    R.setPelvisWorld(V(p.x, 0.16, 0.9));
    R.rot('Head', Y, deg(70 - variant * 140));
    R.rot('neck_01', Y, deg(20 - variant * 40));
    R.rot('Head', X, deg(-25));
    return R.snap();
  }
  const prone0 = prone(0);
  const prone1 = prone(1);

  /** Fall: blend start pose -> end pose with an accelerating pitch of the whole body around the feet. */
  function fall(startFn, endSnap, t, t0, t1, axis, bounce = 0.04) {
    startFn();
    const a = R.snap();
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const w = u * u; // gravity-like acceleration
    R.blend(a, endSnap, w);
    if (u >= 1) {
      const tb = t - t1;
      const b = Math.exp(-tb * 9) * Math.abs(Math.sin(tb * 18)) * bounce;
      R.setPelvisWorld(R.wpos('pelvis').add(V(0, b, 0)));
    }
    void axis;
  }

  // death_forward: knees give, body pitches face-down
  add(R.record('death_forward', 1.8, (t) => {
    fall(() => {
      all(lib.hit_chest, Math.min(t, 0.3));
      const kneel = smooth(t / 0.45);
      R.setPelvisWorld(R.wpos('pelvis').add(V(0, -0.18 * kneel, 0.06 * kneel)));
      R.rot('thigh_l', X, deg(-25 * kneel)); R.rot('thigh_r', X, deg(-30 * kneel));
      R.rot('calf_l', X, deg(45 * kneel)); R.rot('calf_r', X, deg(50 * kneel));
      for (const s of SPINE) R.rot(s, X, deg(10 * kneel));
    }, prone0, t, 0.2, 0.95, X);
  }), false, 'made: Hit_Chest start, knee buckle, accelerated blend into a prone pose, impact bounce');

  // death_headshot: instant collapse straight down then topples sideways face-down
  add(R.record('death_headshot', 1.4, (t) => {
    fall(() => {
      all(lib.idle, 0.2);
      const snap = impulse(t, 0.03, 0.1);
      R.rot('Head', X, deg(-35 * Math.min(1, snap + t * 3)));
      const drop = smooth(t / 0.35);
      R.setPelvisWorld(R.wpos('pelvis').add(V(0, -0.45 * drop, 0)));
      R.rot('thigh_l', X, deg(-70 * drop)); R.rot('thigh_r', X, deg(-60 * drop));
      R.rot('calf_l', X, deg(120 * drop)); R.rot('calf_r', X, deg(110 * drop));
      R.rot('upperarm_l', Z, deg(-40 * drop)); R.rot('upperarm_r', Z, deg(40 * drop));
      for (const s of SPINE) R.rot(s, X, deg(14 * drop));
    }, prone1, t, 0.3, 0.8, Z, 0.03);
  }), false, 'made: limp collapse (knees fold in 0.35 s), then topple into a twisted prone pose');

  // death_slump: sags down onto the backside and slumps back/sideways
  R.sample(lib.sit_idle, 0.5);
  R.setPelvisWorld(V(R.wpos('pelvis').x, 0.14, R.wpos('pelvis').z + 0.1));
  for (const [s, sx, reach] of [['l', 1, 0.78], ['r', -1, 0.66]]) {
    const hip = R.wpos(`thigh_${s}`);
    const foot = V(hip.x + sx * 0.12, 0.09, hip.z + reach);
    R.ik(`thigh_${s}`, `calf_${s}`, `foot_${s}`, foot, hip.clone().add(V(sx * 0.3, 0.8, 0.4)));
    R.rot(`foot_${s}`, X, deg(-20));
  }
  for (const s of SPINE) R.rot(s, X, deg(-12));
  R.rot('spine_03', Z, deg(14));
  R.rot('neck_01', X, deg(30)); R.rot('Head', X, deg(25)); R.rot('Head', Z, deg(12));
  R.rot('upperarm_l', X, deg(30)); R.rot('upperarm_r', X, deg(25));
  R.rot('upperarm_l', Z, deg(-25)); R.rot('upperarm_r', Z, deg(25));
  R.curl('l', relaxed); R.curl('r', relaxed);
  const slumped = R.snap();
  add(R.record('death_slump', 2.0, (t) => {
    all(lib.hit_chest, Math.min(t, 0.25));
    const a = R.snap();
    const u = smooth((t - 0.15) / 1.1);
    R.blend(a, slumped, u);
    const sag = Math.max(0, t - 1.25);
    R.rot('Head', X, deg(10 * smooth(sag / 0.5)));
  }), false, 'made: Hit_Chest start, sag onto the backside (seated-on-floor end pose), head drops');

  // ------------------------------------------------------------------ sleep / lean / surrender / kneel
  add(R.record('sleep_lying', 4.0, (t) => {
    R.apply(supine);
    const br = Math.sin((t / 4) * Math.PI * 2);
    R.rot('spine_03', X, deg(1.5 * br));
    R.rot('Head', Y, deg(35));
    R.rot('upperarm_r', X, deg(15));
  }), true, 'made: UAL LayToIdle frame 0 (lying on back) + head turn + breathing');

  add(R.record('lean_wall', 4.0, (t) => {
    all(lib.idle_arms_folded, t * (lib.idle_arms_folded.duration / 4));
    const feetL = R.wpos('foot_l'), feetR = R.wpos('foot_r');
    const fq = R.wquat('foot_l');
    // whole body tilted back 9 deg: the back rests on a wall ~0.25 m behind the heels
    R.rot('pelvis', X, deg(-9));
    const p = R.wpos('pelvis');
    for (const s of SPINE) R.rot(s, X, deg(-1));
    R.rot('Head', X, deg(6));
    // left foot planted, right foot flat against the wall with the knee forward
    R.ik('thigh_l', 'calf_l', 'foot_l', feetL.clone().add(V(0, 0, 0.05)), R.wpos('calf_l').add(V(0, 0, 1)));
    const wallFoot = V(feetR.x + 0.03, 0.42, p.z - 0.22);
    R.ik('thigh_r', 'calf_r', 'foot_r', wallFoot, R.wpos('calf_r').add(V(-0.2, 0.3, 1)));
    R.setWorldQuat('foot_l', fq);
    R.rot('foot_r', X, deg(-50));
    R.rot('spine_03', X, deg(-0.8 * Math.sin((t / 4) * Math.PI * 2)));
  }), true, 'made: UAL Idle_FoldArms upper body, tilted against a wall behind, leg IK (one foot on the wall)');

  add(R.record('surrender', 3.0, (t) => {
    all(lib.idle, t);
    const sway = Math.sin((t / 3) * Math.PI * 2);
    const head = R.wpos('Head');
    for (const s of ['l', 'r']) {
      const sx = s === 'l' ? 1 : -1;
      const wrist = head.clone().add(V(sx * 0.3, 0.2 + 0.01 * sway, 0.02));
      const q = R.handQuat(s, V(sx * 0.15, 1, 0.05), V(0, 0, 1));
      R.placeHand(s, wrist, q, R.wpos(`upperarm_${s}`).add(V(sx * 0.6, -0.4, -0.2)));
      // open, slightly relaxed fingers
      for (const f of ['thumb', 'index', 'middle']) for (let i = 1; i <= 3; i++) {
        const bn = `${f}_0${i}_${s}`;
        if (R.b[bn]) R.b[bn].quaternion.copy(R.restQ[bn]);
      }
      R.update();
      R.curl(s, { thumb: [0, 5, 5], index: [5, 10, 5], middle: [8, 12, 6] });
    }
    R.rot('Head', X, deg(4));
  }), true, 'made: UAL Idle_Loop + IK hands raised, palms forward');

  add(R.record('kneel_hands_head', 3.0, (t) => {
    all(lib.idle, t);
    const br = Math.sin((t / 3) * Math.PI * 2);
    const thigh = R.wpos('thigh_l').distanceTo(R.wpos('calf_l'));
    const calf = R.wpos('calf_l').distanceTo(R.wpos('foot_l'));
    const p0 = R.wpos('pelvis');
    R.setPelvisWorld(V(p0.x, thigh + 0.1 + 0.004 * br, p0.z));
    for (const s of ['l', 'r']) {
      const hip = R.wpos(`thigh_${s}`);
      const foot = V(hip.x, 0.1, hip.z - calf + 0.02);
      R.ik(`thigh_${s}`, `calf_${s}`, `foot_${s}`, foot, hip.clone().add(V(0, -0.3, 1)));
      R.rot(`foot_${s}`, X, deg(55));
    }
    for (const s of SPINE) R.rot(s, X, deg(3));
    R.rot('Head', X, deg(18));
    const head = R.wpos('Head');
    for (const s of ['l', 'r']) {
      const sx = s === 'l' ? 1 : -1;
      const wrist = head.clone().add(V(sx * 0.12, 0.13, -0.06));
      const q = R.handQuat(s, V(-sx * 0.8, 0.2, -0.2), V(0, -1, -0.2));
      R.placeHand(s, wrist, q, R.wpos(`upperarm_${s}`).add(V(sx * 0.6, 0.0, 0.3)));
      R.curl(s, { thumb: [5, 10, 5], index: [30, 35, 20], middle: [35, 40, 25] });
    }
  }), true, 'made: kneeling on both knees (leg IK) + IK hands on the head');

  add(R.record('startled_turn', 0.9, (t) => {
    all(lib.idle, 0.4 + t);
    const head = curve([[0, 0], [0.18, 1]], t);
    const torso = curve([[0.05, 0], [0.35, 1]], t);
    const body = curve([[0.2, 0], [0.7, 1]], t);
    const hop = Math.sin(Math.min(1, Math.max(0, (t - 0.2) / 0.5)) * Math.PI);
    const p = R.wpos('pelvis');
    R.setPelvisWorld(p.add(V(0, 0.05 * hop - 0.06 * torso * (1 - body), 0)));
    R.rot('pelvis', Y, deg(180 * body));
    const rem = 180 * (1 - body);
    R.rot('spine_02', Y, deg(Math.min(rem, 50) * torso * 0.5));
    R.rot('spine_03', Y, deg(Math.min(rem, 50) * torso * 0.5));
    R.rot('neck_01', Y, deg(Math.min(rem, 120) * head * 0.4));
    R.rot('Head', Y, deg(Math.min(rem, 120) * head * 0.6));
    R.rot('upperarm_l', Z, deg(-12 * hop)); R.rot('upperarm_r', Z, deg(12 * hop));
    for (const s of ['l', 'r']) R.rot(`thigh_${s}`, X, deg(-12 * hop));
    for (const s of ['l', 'r']) R.rot(`calf_${s}`, X, deg(20 * hop));
  }), false, 'made: head-torso-pelvis staggered 180 deg pivot with a small hop; ends facing -Z (rotate the actor by PI)');

  add(R.record('shove', 0.8, (t) => {
    all(lib.idle, 0.2);
    const push = curve([[0, 0], [0.22, 0.3], [0.38, 1], [0.55, 1], [0.8, 0]], t);
    R.setPelvisWorld(R.wpos('pelvis').add(V(0, 0, 0.12 * push)));
    for (const s of SPINE) R.rot(s, X, deg(5 * push));
    const chest = R.wpos('spine_03');
    for (const s of ['l', 'r']) {
      const sx = s === 'l' ? 1 : -1;
      const wrist = chest.clone().add(V(sx * 0.2, 0.0, lerp(0.2, 0.62, push)));
      const q = R.handQuat(s, V(sx * -0.2, 1, 0.3), V(0, 0, 1));
      R.placeHand(s, wrist, q, R.wpos(`upperarm_${s}`).add(V(sx * 0.4, -0.6, -0.2)));
    }
  }), false, 'made: two-handed shove with IK');

  return out;
}
