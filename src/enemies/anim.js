// Enemy animation: two cross-faded layers (lower body / upper body, from the shared clips split by bone) driven
// by the brain's presentation fields, foot-speed matched locomotion, turn-in-place steps, one-shots (wake up,
// stand up, startle, reload, hit reactions), deaths that freeze into a static pose, and a procedural additive
// layer (aim yaw/pitch through the spine, peek lean, hit flinch, fire kick, writhing) applied before the single
// matrix update. Hit capsules are refreshed from the animated bones. Owner: D.
import * as THREE from 'three';

const LOWER = new Set(['root', 'pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']);
const FULL_ONESHOT = new Set(['lying_to_idle', 'sit_exit', 'startled_turn', 'hit_chest', 'hit_head', 'hit_knockback', 'hit_front', 'hit_back', 'hit_left', 'hit_right', 'pickup']);
const LOCO = ['walk', 'run', 'sprint', 'crouch_walk'];
const YAW_AIM = [0.2, 0.3, 0.3, 0.1, 0.1], YAW_LOOK = [0.1, 0.15, 0.15, 0.25, 0.35];

/** split every clip into lower/upper halves, measure locomotion speeds and pose footprints */
export function createAnimLib(clips, template, rootScale) {
  const L = new Map(), Uc = new Map(), dur = new Map();
  for (const c of clips) {
    const lo = [], up = [];
    for (const t of c.tracks) (LOWER.has(t.name.split('.')[0]) ? lo : up).push(t);
    L.set(c.name, new THREE.AnimationClip(c.name + '#L', c.duration, lo));
    Uc.set(c.name, new THREE.AnimationClip(c.name + '#U', c.duration, up));
    dur.set(c.name, c.duration);
  }
  const lib = { L, U: Uc, dur, has: (n) => L.has(n), speed: {}, pose: {} };
  // measurements on a throwaway clone at reference scale
  const actor = template;
  const mixer = new THREE.AnimationMixer(actor);
  const foot = [actor.getObjectByName('foot_l'), actor.getObjectByName('foot_r')];
  const head = actor.getObjectByName('Head'), pelvis = actor.getObjectByName('pelvis');
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  const byName = (n) => clips.find((c) => c.name === n);
  for (const name of LOCO) {
    const clip = byName(name); if (!clip) continue;
    const a = mixer.clipAction(clip); a.play();
    const N = 60, dt = clip.duration / N;
    let sum = 0, cnt = 0;
    const prev = [0, 0];
    for (let i = 0; i <= N; i++) {
      mixer.setTime(i * dt); actor.updateMatrixWorld(true);
      foot[0].getWorldPosition(p); foot[1].getWorldPosition(q);
      const st = p.y < q.y ? 0 : 1, z = st === 0 ? p.z : q.z;
      if (i > 0 && prev[1] === st) { const v = -(z - prev[0]) / dt; if (v > 0) { sum += v; cnt++; } }
      prev[0] = z; prev[1] = st;
    }
    lib.speed[name] = (cnt ? sum / cnt : 1.3) / rootScale;
    a.stop(); mixer.uncacheAction(clip);
  }
  // end poses: body axis (feet → head) and midpoint in model space, per lying / death clip
  for (const name of ['sleep_lying', 'death_forward', 'death_backward', 'death_slump', 'death_headshot', 'hit_knockback', 'kneel_hands_head', 'sit_idle']) {
    const clip = byName(name); if (!clip) continue;
    const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
    mixer.setTime(name === 'sleep_lying' || name === 'sit_idle' || name === 'kneel_hands_head' ? 0.5 : clip.duration);
    actor.updateMatrixWorld(true);
    head.getWorldPosition(p); foot[0].getWorldPosition(q);
    const f2 = foot[1].getWorldPosition(new THREE.Vector3());
    q.add(f2).multiplyScalar(0.5);
    const pv = pelvis.getWorldPosition(new THREE.Vector3());
    lib.pose[name] = {
      head: p.toArray().map((v) => v / rootScale), feet: q.toArray().map((v) => v / rootScale), pelvis: pv.toArray().map((v) => v / rootScale),
      axis: Math.atan2(p.x - q.x, p.z - q.z), len: Math.hypot(p.x - q.x, p.z - q.z) / rootScale,
      mid: [(p.x + q.x) / 2 / rootScale, (p.z + q.z) / 2 / rootScale],
    };
    a.stop(); mixer.uncacheAction(clip);
  }
  mixer.setTime(0);
  return lib;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _ax = new THREE.Vector3();

export function createAnimator(actor, lib, opts) {
  const mixer = new THREE.AnimationMixer(actor);
  const bone = (n) => actor.getObjectByName(n);
  const B = {
    pelvis: bone('pelvis'), s1: bone('spine_01'), s2: bone('spine_02'), s3: bone('spine_03'), neck: bone('neck_01'), head: bone('Head'),
    clR: bone('clavicle_r'), uaR: bone('upperarm_r'), thL: bone('thigh_l'), thR: bone('thigh_r'), hand: bone('hand_r'),
  };
  const slots = { L: { cur: null, name: '', once: false, t0: 0 }, U: { cur: null, name: '', once: false, t0: 0 } };
  const capBones = opts.capsules.map((c) => bone(c.bone));
  const capA = opts.capsules.map((c) => new THREE.Vector3(...c.a)), capB = opts.capsules.map((c) => new THREE.Vector3(...c.b));
  const capR = opts.capsules.map((c) => c.r * opts.rootScale);
  const capNames = opts.capsules.map((c) => c.part);
  const rs = opts.rootScale;
  const WA = opts.wanim ?? 'pistol', WN = { aim: WA + '_aim', idle: WA + '_idle', crouch: WA + '_aim_crouch', pistol: WA === 'pistol' };
  const st = {
    lastOne: 0, lastHit: 0, lastFire: 0, kick: 0, flinch: 0, flX: 0, flZ: 0, aYaw: 0, aPitch: 0, lean: 0, writhe: 0,
    oneShot: '', oneUntil: 0, frozen: false, deathPlayed: '', time: 0, fireKick: opts.fireKick ?? 0.06,
  };

  function action(slot, name) {
    const clip = (slot === 'L' ? lib.L : lib.U).get(name);
    return clip ? mixer.clipAction(clip) : null;
  }
  function play(slotName, name, fade, once, scale, sync) {
    const s = slots[slotName];
    if (s.name === name && s.once === once) { if (s.cur) s.cur.timeScale = scale; return; }
    const a = action(slotName, name);
    if (!a) return;
    a.reset();
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.timeScale = scale;
    if (sync && sync.cur && !once) a.time = sync.cur.time % a.getClip().duration;
    a.setEffectiveWeight(1);
    if (s.cur && fade > 0) { a.play(); s.cur.crossFadeTo(a, fade, false); }
    else { if (s.cur) s.cur.stop(); a.play(); }
    s.cur = a; s.name = name; s.once = once; s.t0 = st.time;
  }

  /** choose the base clips from the brain's presentation state (into the reused BS record) */
  const BS = { lo: '', up: '', once: false, scale: 1 };
  const set = (lo, up, once, scale) => { BS.lo = lo; BS.up = up; BS.once = once; BS.scale = scale; return BS; };
  function base(e) {
    if (e.dead) {
      const d = e.deathClip === 'sleep_death' ? 'sleep_lying' : e.deathClip === 'sit_death' ? 'sit_idle' : e.deathClip;
      return set(d, d, true, 1);
    }
    if (e.pose === 'lie') return set('sleep_lying', 'sleep_lying', false, 1);
    if (e.pose === 'sit') return set(e.clip, e.clip, false, 1);
    if (e.pose === 'hands') return set('surrender', 'surrender', false, 1);
    if (e.pose === 'kneel') return set('kneel_hands_head', 'kneel_hands_head', false, 1);
    const moving = e.wantMove && e.speed > 0.15;
    if (moving) {
      const lo = e.crouch ? 'crouch_walk' : e.speed > 3.6 ? 'sprint' : e.speed > 2.0 ? 'run' : 'walk';
      const sp = Math.max(0.55, Math.min(1.7, e.speed / (lib.speed[lo] * rs || 1.3))) * (e.moveSign || 1);
      const up = e.weaponOut ? (e.aiming && e.speed < 2.2 ? WN.aim : WN.pistol && e.speed > 2 ? lo : WN.idle) : lo;
      return set(lo, up, false, sp);
    }
    if (e.crouch) {
      const c = e.aiming && e.weaponOut ? WN.crouch : 'crouch_idle';
      return set(c, c, false, 1);
    }
    if (e.aiming && e.weaponOut) return set(e.turning ? 'walk' : WN.aim, WN.aim, false, e.turning ? 0.6 : 1);
    let c = e.clip === 'w_idle' ? (e.weaponOut ? WN.idle : 'idle') : e.clip;
    if (!lib.has(c)) c = 'idle';
    return set(e.turning ? 'walk' : c, c, false, e.turning ? 0.6 : 1);
  }

  return {
    mixer, B, st,
    get frozen() { return st.frozen; },
    /** advance the pose by dt (seconds since this actor's last animation update) */
    update(e, dt) {
      if (st.frozen) return false;
      st.time += dt;
      // one-shots requested by the brain
      if (e.oneShotSeq !== st.lastOne) {
        st.lastOne = e.oneShotSeq;
        const n = e.oneShot.endsWith('_reload') && !lib.has(e.oneShot) ? 'pistol_reload' : e.oneShot;
        if (lib.has(n) && !e.dead) {
          st.oneShot = n; st.oneUntil = st.time + lib.dur.get(n) - 0.12;
          if (FULL_ONESHOT.has(n)) play('L', n, 0.12, true, 1, null);
          play('U', n, 0.12, true, 1, null);
        }
      }
      if (st.oneShot && (st.time >= st.oneUntil || e.dead)) st.oneShot = '';
      const b = base(e), lo = b.lo, up = b.up, once = b.once, scale = b.scale;
      if (e.dead) {
        if (st.deathPlayed !== lo) { st.deathPlayed = lo; st.oneShot = ''; const o = !e.deathClip.endsWith('_death'); play('L', lo, 0.12, o, 1, null); play('U', up, 0.12, o, 1, null); }
      } else if (!st.oneShot) {
        play('L', lo, 0.25, once, scale, slots.L);
        if (lo === up) play('U', up, 0.25, once, scale, slots.L); else play('U', up, 0.25, once, 1, null);
      } else if (!FULL_ONESHOT.has(st.oneShot)) play('L', lo, 0.25, once, scale, slots.L);
      mixer.update(dt);
      procedural(e, dt);
      updateActorWorld(actor);
      // dead: freeze when the clip (and writhing) is over → no more skinning updates for this body
      if (e.dead && st.time - slots.L.t0 > (lib.dur.get(lo) ?? 1) + 0.2 && !(e.writheUntil > opts.now())) st.frozen = true;
      return true;
    },
    /** hit capsules → brain-local frame (actor yaw/pos from the brain) */
    capsules(e) {
      const s = Math.sin(e.yaw), c = Math.cos(e.yaw), caps = e.caps;
      for (let i = 0; i < capBones.length; i++) {
        const b = i * 7;
        for (let k = 0; k < 2; k++) {
          _v.copy(k ? capB[i] : capA[i]).applyMatrix4(capBones[i].matrixWorld);
          const dx = _v.x - e.pos.x, dz = _v.z - e.pos.z;
          caps[b + k * 3] = c * dx - s * dz; caps[b + k * 3 + 1] = _v.y - e.pos.y; caps[b + k * 3 + 2] = s * dx + c * dz;
        }
        caps[b + 6] = capR[i];
      }
      e.capN = capBones.length; e.capNames = capNames;
    },
    reset() {
      mixer.stopAllAction();
      slots.L.cur = slots.U.cur = null; slots.L.name = slots.U.name = '';
      st.frozen = false; st.deathPlayed = ''; st.oneShot = ''; st.kick = st.flinch = st.writhe = 0; st.aYaw = st.aPitch = st.lean = 0;
    },
    sync(e) { st.lastOne = e.oneShotSeq; st.lastHit = e.hitSeq; st.lastFire = e.fireSeq; },
  };

  // ---- additive procedural layer (bone local quaternions, before the matrix update)
  function rotAboutActorAxis(b, ax, ay, az, angle) {
    if (!b || Math.abs(angle) < 1e-4) return;
    // actor-space axis → the bone parent's local frame (parent world matrix of the previous update is close
    // enough: the axes used here are invariant or nearly so under the small rotations applied)
    const m = b.parent.matrixWorld.elements, a = actor.matrixWorld.elements;
    // axis to world (actor rotation)
    const wx = a[0] * ax + a[4] * ay + a[8] * az, wy = a[1] * ax + a[5] * ay + a[9] * az, wz = a[2] * ax + a[6] * ay + a[10] * az;
    // world → parent local: transpose of the parent's rotation (scale removed by normalising)
    _ax.set(m[0] * wx + m[1] * wy + m[2] * wz, m[4] * wx + m[5] * wy + m[6] * wz, m[8] * wx + m[9] * wy + m[10] * wz).normalize();
    _q.setFromAxisAngle(_ax, angle);
    b.quaternion.premultiply(_q);
  }

  function procedural(e, dt) {
    // aim / look offset (torso twist + pitch), smoothed
    let yawT = 0, pitchT = 0;
    if (!e.dead && (e.pose === 'stand' || e.pose === 'crouch') && st.oneShot !== 'startled_turn') {
      yawT = wrap(e.lookYaw - e.bodyYaw);
      yawT = Math.max(-1.05, Math.min(1.05, yawT));
      if (e.aiming) pitchT = e.aimPitch;
    }
    const k = 1 - Math.exp(-dt * 8);
    st.aYaw += (yawT - st.aYaw) * k; st.aPitch += (pitchT - st.aPitch) * k;
    st.lean += ((e.dead ? 0 : e.lean) - st.lean) * (1 - Math.exp(-dt * 6));
    const ys = e.aiming ? YAW_AIM : YAW_LOOK;
    // actor axes in model space: up +Y, character left +X, forward +Z
    rotAboutActorAxis(B.s1, 0, 1, 0, st.aYaw * ys[0]);
    rotAboutActorAxis(B.s2, 0, 1, 0, st.aYaw * ys[1]);
    rotAboutActorAxis(B.s3, 0, 1, 0, st.aYaw * ys[2]);
    rotAboutActorAxis(B.neck, 0, 1, 0, st.aYaw * ys[3]);
    rotAboutActorAxis(B.head, 0, 1, 0, st.aYaw * ys[4]);
    // pitch (positive = up) about the character's left axis; the body yaw part is already in the spine
    const sY = Math.sin(st.aYaw), cY = Math.cos(st.aYaw);
    rotAboutActorAxis(B.s2, cY, 0, -sY, -st.aPitch * 0.45);
    rotAboutActorAxis(B.s3, cY, 0, -sY, -st.aPitch * 0.4);
    rotAboutActorAxis(B.head, cY, 0, -sY, -st.aPitch * 0.15);
    // peek lean: roll about the forward axis
    rotAboutActorAxis(B.s1, 0, 0, 1, st.lean * 0.14);
    rotAboutActorAxis(B.s2, 0, 0, 1, st.lean * 0.16);
    rotAboutActorAxis(B.s3, 0, 0, 1, st.lean * 0.14);
    // hit flinch: spring impulse away from the bullet
    if (e.hitSeq !== st.lastHit) { st.lastHit = e.hitSeq; st.flinch = 0.18 + 0.3 * e.hitAmt; st.flX = e.hitDirX; st.flZ = e.hitDirZ; }
    if (st.flinch > 0.002) {
      // bullet dir in brain-local (forward -z) → model space (forward +z): negate x, z; rotate about up × dir
      const dx = -st.flX, dz = -st.flZ, l = Math.hypot(dx, dz) || 1;
      const ax = dz / l, az = -dx / l;
      rotAboutActorAxis(B.s2, ax, 0, az, st.flinch * 0.9);
      rotAboutActorAxis(B.s3, ax, 0, az, st.flinch * 0.7);
      rotAboutActorAxis(B.neck, ax, 0, az, st.flinch * 0.6);
      st.flinch *= Math.exp(-dt * 9);
    }
    // fire kick (muzzle climb through the upper body + strong arm)
    if (e.fireSeq !== st.lastFire) { st.lastFire = e.fireSeq; st.kick = 1; }
    if (st.kick > 0.01) {
      rotAboutActorAxis(B.s3, cY, 0, -sY, -st.kick * st.fireKick);
      rotAboutActorAxis(B.uaR, cY, 0, -sY, -st.kick * st.fireKick * 1.5);
      st.kick *= Math.exp(-dt * 16);
    }
    // dying: restrained, slowly fading writhing, then still
    if (e.dead && e.writheUntil > 0) {
      const left = e.writheUntil - opts.now();
      const amp = left > 0 ? Math.min(1, left / 2) * 0.12 : 0;
      if (amp > 0) {
        const t = st.time;
        rotAboutActorAxis(B.s1, 0, 0, 1, Math.sin(t * 2.3) * amp);
        rotAboutActorAxis(B.s2, 1, 0, 0, Math.sin(t * 1.7 + 1) * amp);
        rotAboutActorAxis(B.thL, 1, 0, 0, Math.sin(t * 1.3 + 2) * amp * 2);
        rotAboutActorAxis(B.neck, 0, 1, 0, Math.sin(t * 0.9) * amp * 2);
      }
    }
    if (e.dead && e.deathClip === 'sit_death') { rotAboutActorAxis(B.s2, 1, 0, 0, 0.45); rotAboutActorAxis(B.neck, 1, 0, 0, 0.5); }
  }
}

/** actor.matrixWorldAutoUpdate is false (the scene skips it): compute its world matrix and its subtree here */
export function updateActorWorld(a) {
  a.matrixWorld.copy(a.matrix);
  const ch = a.children;
  for (let i = 0; i < ch.length; i++) ch[i].updateMatrixWorld(true);
}

function wrap(a) { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; }
