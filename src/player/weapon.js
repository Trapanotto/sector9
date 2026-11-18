import { MAG_SIZE, SPARE_MAGS, FIRE_INTERVAL, RELOAD_TACTICAL, RELOAD_EMPTY } from './tuning.js';
import { seg, lerp } from './springs.js';

// Pistol state machine: ammunition, slide cycling / lock-back, reload timeline (drives the support hand pose,
// finger curl and thumbs through vm.supportBase / vm.hand, the magazines and an additive gun pose). Shooting
// effects are triggered by the player, which owns the pose.

// Reload timeline (seconds)
const T_TILT = 0.28;          // gun rolled in toward the support hand
const T_OPEN0 = 0.03, T_OPEN1 = 0.17;      // support fingers open off the grip
const T_HAND_OFF0 = 0.10;     // support hand leaves the grip...
const T_MAGREL0 = 0.14, T_MAG_OUT = 0.25, T_MAGREL1 = 0.38;   // strong thumb on the magazine release
const T_HAND_OFF1 = 0.50;     // ...and is down at the pouch
const T_GRAB0 = 0.52, T_GRAB1 = 0.64;      // fingers close round the new magazine
const T_HAND_UP0 = 0.68;      // starts coming back with the new mag
const T_PREINSERT = 0.97;     // new mag lined up under the magwell
const T_SEAT = 1.15;          // seated ('reload_in')
const T_REGRIP0 = 1.17, T_REGRIP1 = 1.36;  // support hand re-wraps the strong hand
// empty reload only: slide release pressed down by the support thumb
const T_SS0 = 1.28, T_SS_REL = 1.37, T_SS1 = 1.52;

const SLIDE_TRAVEL = 0.030;
const SLIDE_LOCK = 0.027;
const CANCEL_BLEND = 0.22;    // s to return the support hand to the grip after a cancelled reload

// support hand key poses (gun-local position offsets + small rotation)
const AXIS_DOWN_Y = -Math.cos(0.31), AXIS_DOWN_Z = Math.sin(0.31);   // magwell axis (matches viewmodel GRIP_ANGLE)
const BELT = [-0.07, -0.34, 0.15], BELT_R = [0.6, 0, 0.3];
const PRE = [-0.004, AXIS_DOWN_Y * 0.10, AXIS_DOWN_Z * 0.10], PRE_R = [0.05, 0, 0.05];
const ZERO = [0, 0, 0];

export function createWeapon(ctx, vm, hooks) {
  const w = {
    magSize: MAG_SIZE,
    mag: MAG_SIZE,
    chambered: true,
    reserve: MAG_SIZE * SPARE_MAGS,
    get ammo() { return this.mag + (this.chambered ? 1 : 0); },
    cooldown: 0,
    reloading: false,
    reloadT: 0,
    reloadDur: 0,
    reloadEmpty: false,
    reloadCount: 0,          // increments when a reload completes (for HUD "ammo after reload")
    slideLocked: false,
    flashlight: false,
    // additive pose output while reloading (gun euler in gun-local, position in camera space)
    anim: { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 },
  };

  let slideT = 1;            // time since last shot (slide cycle)
  let dropT = -1;            // old magazine drop time (-1 = not dropping)
  let retT = -1;             // cancel blend time (-1 = none)
  const ret = { p: [0, 0, 0], r: [0, 0, 0], curl: 1, thumb: 1, magRel: 0, anim: { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 } };

  const play = (n, o) => ctx.audio?.play?.(n, o);
  const H = vm.hand;
  const SB = vm.supportBase;

  function setSupport(p, r) { SB.p.set(p[0], p[1], p[2]); SB.r.set(r[0], r[1], r[2]); }
  function lerpSupport(a, ar, b, br, t) {
    SB.p.set(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
    SB.r.set(lerp(ar[0], br[0], t), lerp(ar[1], br[1], t), lerp(ar[2], br[2], t));
  }
  function restHand() { H.supportCurl = 1; H.supportThumb = 1; H.magRelease = 0; H.slideStop = 0; H.busy = false; }

  w.reset = function () {
    w.mag = MAG_SIZE; w.chambered = true; w.reserve = MAG_SIZE * SPARE_MAGS;
    w.cooldown = 0; w.reloading = false; w.reloadT = 0; w.slideLocked = false;
    slideT = 1; dropT = -1; retT = -1;
    vm.mag.visible = true; vm.mag.position.set(0, 0, 0); vm.mag.rotation.set(0, 0, 0);
    vm.magNew.visible = false;
    setSupport(ZERO, ZERO);
    restHand();
    vm.slide.position.z = 0;
    const a = w.anim; a.rx = a.ry = a.rz = a.px = a.py = a.pz = 0;
  };

  w.canReload = () => !w.reloading && w.reserve > 0 && w.mag < MAG_SIZE;

  w.startReload = function () {
    if (!w.canReload()) return false;
    w.reloading = true;
    w.reloadT = 0;
    w.reloadEmpty = !w.chambered;
    w.reloadDur = w.reloadEmpty ? RELOAD_EMPTY : RELOAD_TACTICAL;
    retT = -1;
    H.busy = true;
    return true;
  };

  /** Abort a reload that has not released the magazine yet (sprint / aim). Returns true if cancelled. */
  w.cancelReload = function () {
    if (!w.reloading || w.reloadT >= T_MAG_OUT) return false;
    w.reloading = false;
    retT = 0;
    ret.p = [SB.p.x, SB.p.y, SB.p.z]; ret.r = [SB.r.x, SB.r.y, SB.r.z];
    ret.curl = H.supportCurl; ret.thumb = H.supportThumb; ret.magRel = H.magRelease;
    Object.assign(ret.anim, w.anim);
    return true;
  };

  /** Called by the player right after it fired the round. */
  w.onShot = function () {
    w.cooldown = FIRE_INTERVAL;
    slideT = 0;
    if (w.mag > 0) { w.mag--; w.chambered = true; }
    else { w.chambered = false; w.slideLocked = true; }
  };

  w.dryFire = function () {
    w.cooldown = 0.25;
    play('dry');
  };

  w.toggleFlashlight = function (intensity) {
    w.flashlight = !w.flashlight;
    vm.setFlashlight(w.flashlight, intensity);
    play('ui_click', { volume: 0.35 });
  };

  function finishSeat() {
    // ammo transfer: rounds left in the old mag go back into the pool (simplified mag management)
    w.reserve += w.mag;
    const take = Math.min(MAG_SIZE, w.reserve);
    w.reserve -= take;
    w.mag = take;
    vm.magNew.visible = false;
    dropT = -1;
    vm.mag.position.set(0, 0, 0); vm.mag.rotation.set(0, 0, 0);
    vm.mag.visible = true;
  }

  w.update = function (dt) {
    if (w.cooldown > 0) w.cooldown -= dt;
    slideT += dt;

    // ---- reload timeline
    const a = w.anim;
    if (w.reloading) {
      const t0 = w.reloadT, t = (w.reloadT += dt);
      const crossed = (k) => t0 < k && t >= k;

      if (crossed(T_MAG_OUT)) { play('reload_out'); dropT = 0; }
      if (crossed(T_GRAB1)) vm.magNew.visible = true;
      if (crossed(T_SEAT)) { play('reload_in'); finishSeat(); hooks?.jolt?.(0.35); }
      if (w.reloadEmpty && crossed(T_SS_REL)) {
        play('slide');
        if (w.mag > 0) { w.mag--; w.chambered = true; }
        w.slideLocked = false;
        slideT = 0.018;                      // slide runs forward from lock (reuses the cycle's return)
        hooks?.jolt?.(0.2);
      }

      // support hand path
      if (t < T_HAND_OFF0) setSupport(ZERO, ZERO);
      else if (t < T_HAND_OFF1) lerpSupport(ZERO, ZERO, BELT, BELT_R, seg(t, T_HAND_OFF0, T_HAND_OFF1));
      else if (t < T_HAND_UP0) setSupport(BELT, BELT_R);
      else if (t < T_PREINSERT) lerpSupport(BELT, BELT_R, PRE, PRE_R, seg(t, T_HAND_UP0, T_PREINSERT));
      else if (t < T_SEAT) { const s = (t - T_PREINSERT) / (T_SEAT - T_PREINSERT); lerpSupport(PRE, PRE_R, ZERO, ZERO, s * s); }
      else {
        // palm heel slap seats the magazine: a small push past the seat, then settle
        const k = Math.exp(-(t - T_SEAT) * 22) * Math.sin(Math.min(Math.PI, (t - T_SEAT) * 30));
        setSupport([0, -AXIS_DOWN_Y * 0.004 * k, -AXIS_DOWN_Z * 0.004 * k], [0.02 * k, 0, 0]);
      }

      // fingers: open off the grip, close round the new magazine, ease to the grip while sliding up, re-grip
      let curl = 1;
      if (t < T_GRAB0) curl = lerp(1, 0.3, seg(t, T_OPEN0, T_OPEN1));
      else if (t < T_PREINSERT + 0.05) curl = lerp(0.3, 1.32, seg(t, T_GRAB0, T_GRAB1));
      else if (t < T_REGRIP0) curl = lerp(1.32, 0.92, seg(t, T_PREINSERT + 0.05, T_SEAT));
      else curl = lerp(0.92, 1, seg(t, T_REGRIP0, T_REGRIP1)) - 0.12 * Math.sin(Math.PI * seg(t, T_REGRIP0, T_REGRIP1));
      H.supportCurl = curl;
      H.supportThumb = t < T_GRAB0 ? lerp(1, 0.45, seg(t, T_OPEN0, T_OPEN1))
        : t < T_SEAT ? lerp(0.45, 1.15, seg(t, T_GRAB0, T_GRAB1)) - 0.15 * seg(t, T_PREINSERT, T_SEAT)
          : 1;
      // strong thumb presses the magazine release
      H.magRelease = seg(t, T_MAGREL0, T_MAG_OUT - 0.03) * (1 - seg(t, T_MAG_OUT + 0.02, T_MAGREL1));
      // empty: support thumb pushes the slide stop down
      H.slideStop = w.reloadEmpty ? seg(t, T_SS0, T_SS_REL) * (1 - seg(t, T_SS_REL + 0.03, T_SS1)) : 0;
      H.busy = t < T_REGRIP1;

      // gun: tilt toward the support hand, brought in closer; shown left side up for the slide release
      const e = seg(t, 0, T_TILT) * (1 - seg(t, w.reloadDur - 0.38, w.reloadDur));
      const seat = Math.exp(-Math.max(0, t - T_SEAT) * 9) * (t > T_SEAT ? 1 : 0);
      const rel = w.reloadEmpty ? seg(t, T_SS0 - 0.08, T_SS0 + 0.04) * (1 - seg(t, T_SS_REL + 0.05, T_SS1 + 0.1)) : 0;
      a.rx = e * 0.24 + seat * 0.05 + rel * 0.03;
      a.ry = e * 0.22 - rel * 0.06;
      a.rz = -e * 0.52 + rel * 0.14;
      a.px = -e * 0.05;
      a.py = e * 0.035;
      a.pz = e * 0.07;

      if (w.reloadEmpty && t < T_SS_REL) vm.slide.position.z = SLIDE_LOCK;

      if (t >= w.reloadDur) {
        w.reloading = false;
        w.reloadCount++;
        setSupport(ZERO, ZERO);
        restHand();
        a.rx = a.ry = a.rz = a.px = a.py = a.pz = 0;
      }
    } else if (retT >= 0) {
      // cancelled: blend everything back to the two-handed grip
      retT += dt;
      const s = seg(retT, 0, CANCEL_BLEND);
      lerpSupport(ret.p, ret.r, ZERO, ZERO, s);
      H.supportCurl = lerp(ret.curl, 1, s); H.supportThumb = lerp(ret.thumb, 1, s); H.magRelease = lerp(ret.magRel, 0, s);
      for (const k of ['rx', 'ry', 'rz', 'px', 'py', 'pz']) a[k] = lerp(ret.anim[k], 0, s);
      H.busy = s < 0.6;
      if (retT >= CANCEL_BLEND) { retT = -1; setSupport(ZERO, ZERO); restHand(); }
    }

    // ---- old magazine falling out of the magwell (along the grip axis, gun-local)
    if (dropT >= 0) {
      dropT += dt;
      vm.mag.position.y = -(0.6 * dropT + 0.5 * 7.5 * dropT * dropT);
      vm.mag.rotation.x = dropT * 1.5;
      if (dropT > 0.5) { vm.mag.visible = false; }
    }

    // ---- slide cycling after a shot / release (not while held locked by the empty reload)
    if (!(w.reloading && w.reloadEmpty && w.reloadT < T_SS_REL)) {
      const lockZ = w.slideLocked ? SLIDE_LOCK : 0;
      if (slideT < 0.018) vm.slide.position.z = SLIDE_TRAVEL * (slideT / 0.018);
      else if (slideT < 0.075) vm.slide.position.z = lerp(SLIDE_TRAVEL, lockZ, (slideT - 0.018) / 0.057);
      else vm.slide.position.z = lockZ;
    }
  };

  return w;
}
