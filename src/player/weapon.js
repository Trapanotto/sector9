import { MAG_SIZE, SPARE_MAGS, FIRE_INTERVAL, RELOAD_TACTICAL, RELOAD_EMPTY } from './tuning.js';
import { seg, lerp } from './springs.js';

// Pistol state machine: ammunition, slide cycling / lock-back, reload timeline (drives the support hand,
// the magazines and an additive gun pose). Shooting effects are triggered by the player, which owns the pose.

// Reload timeline (seconds)
const T_TILT = 0.28;          // gun rolled in toward the support hand
const T_HAND_OFF0 = 0.16;     // support hand leaves the grip...
const T_MAG_OUT = 0.28;       // mag release ('reload_out'), old mag drops
const T_HAND_OFF1 = 0.52;     // ...and is down at the belt
const T_HAND_UP0 = 0.72;      // starts coming back with the new mag
const T_PREINSERT = 1.00;     // new mag lined up under the magwell
const T_SEAT = 1.18;          // seated ('reload_in')
// empty reload only: slide release by racking
const T_RACK0 = 1.24, T_RACK_GRAB = 1.46, T_RACK_REL = 1.60, T_RACK_END = 1.88;

const SLIDE_TRAVEL = 0.030;
const SLIDE_LOCK = 0.027;

// support hand key poses (gun-local position offsets + small rotation)
const AXIS_DOWN_Y = -Math.cos(0.31), AXIS_DOWN_Z = Math.sin(0.31);   // magwell axis (matches viewmodel GRIP_ANGLE)
const BELT = [-0.07, -0.34, 0.15], BELT_R = [0.6, 0, 0.3];
const PRE = [-0.004, AXIS_DOWN_Y * 0.10, AXIS_DOWN_Z * 0.10], PRE_R = [0.05, 0, 0.05];
const GRAB = [0.010, 0.078, 0.040], GRAB_R = [0.1, 0, -0.35];
const PULL = [0.010, 0.080, 0.095];

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
    lowerBlock: 0,           // reload keeps the gun up even when sprinting
  };

  let slideT = 1;            // time since last shot (slide cycle)
  let dropT = -1;            // old magazine drop time (-1 = not dropping)

  const play = (n, o) => ctx.audio?.play?.(n, o);

  w.reset = function () {
    w.mag = MAG_SIZE; w.chambered = true; w.reserve = MAG_SIZE * SPARE_MAGS;
    w.cooldown = 0; w.reloading = false; w.reloadT = 0; w.slideLocked = false;
    slideT = 1; dropT = -1;
    vm.mag.visible = true; vm.mag.position.set(0, 0, 0); vm.mag.rotation.set(0, 0, 0);
    vm.magNew.visible = false;
    vm.support.position.set(0, 0, 0); vm.support.rotation.set(0, 0, 0);
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

  function setSupport(p, r) {
    vm.support.position.set(p[0], p[1], p[2]);
    vm.support.rotation.set(r[0], r[1], r[2]);
  }
  function lerpSupport(a, ar, b, br, t) {
    vm.support.position.set(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
    vm.support.rotation.set(lerp(ar[0], br[0], t), lerp(ar[1], br[1], t), lerp(ar[2], br[2], t));
  }
  const ZERO = [0, 0, 0];

  w.update = function (dt) {
    if (w.cooldown > 0) w.cooldown -= dt;
    slideT += dt;

    // ---- reload timeline
    const a = w.anim;
    if (w.reloading) {
      const t0 = w.reloadT, t = (w.reloadT += dt);
      const crossed = (k) => t0 < k && t >= k;

      if (crossed(T_MAG_OUT)) { play('reload_out'); dropT = 0; }
      if (crossed(T_HAND_UP0)) vm.magNew.visible = true;
      if (crossed(T_SEAT)) { play('reload_in'); finishSeat(); hooks?.jolt?.(0.35); }
      if (w.reloadEmpty && crossed(T_RACK_REL)) {
        play('slide');
        if (w.mag > 0) { w.mag--; w.chambered = true; }
        w.slideLocked = false;
        hooks?.jolt?.(0.2);
      }

      // support hand
      if (t < T_HAND_OFF0) setSupport(ZERO, ZERO);
      else if (t < T_HAND_OFF1) lerpSupport(ZERO, ZERO, BELT, BELT_R, seg(t, T_HAND_OFF0, T_HAND_OFF1));
      else if (t < T_HAND_UP0) setSupport(BELT, BELT_R);
      else if (t < T_PREINSERT) lerpSupport(BELT, BELT_R, PRE, PRE_R, seg(t, T_HAND_UP0, T_PREINSERT));
      else if (t < T_SEAT) { const s = (t - T_PREINSERT) / (T_SEAT - T_PREINSERT); lerpSupport(PRE, PRE_R, ZERO, ZERO, s * s); }
      else if (!w.reloadEmpty || t < T_RACK0) setSupport(ZERO, ZERO);
      else if (t < T_RACK_GRAB) lerpSupport(ZERO, ZERO, GRAB, GRAB_R, seg(t, T_RACK0, T_RACK_GRAB));
      else if (t < T_RACK_REL) lerpSupport(GRAB, GRAB_R, PULL, GRAB_R, seg(t, T_RACK_GRAB, T_RACK_REL));
      else if (t < T_RACK_END) lerpSupport(PULL, GRAB_R, ZERO, ZERO, seg(t, T_RACK_REL, T_RACK_END));
      else setSupport(ZERO, ZERO);

      // gun: tilt toward the support hand, brought in closer; extra twist while racking
      const e = seg(t, 0, T_TILT) * (1 - seg(t, w.reloadDur - 0.38, w.reloadDur));
      const seat = Math.exp(-Math.max(0, t - T_SEAT) * 9) * (t > T_SEAT ? 1 : 0);
      const rack = w.reloadEmpty ? seg(t, T_RACK0, T_RACK_GRAB) * (1 - seg(t, T_RACK_REL, T_RACK_END)) : 0;
      a.rx = e * 0.24 + seat * 0.05 + rack * 0.05;
      a.ry = e * 0.22 - rack * 0.12;
      a.rz = -e * 0.52 + rack * 0.30;
      a.px = -e * 0.05;
      a.py = e * 0.035;
      a.pz = e * 0.07;

      // slide while racking: pulled slightly past lock, then snaps forward
      if (w.reloadEmpty) {
        if (t < T_RACK_GRAB) vm.slide.position.z = SLIDE_LOCK;
        else if (t < T_RACK_REL) vm.slide.position.z = lerp(SLIDE_LOCK, SLIDE_TRAVEL + 0.002, seg(t, T_RACK_GRAB, T_RACK_REL));
        else vm.slide.position.z = Math.max(0, (SLIDE_TRAVEL + 0.002) * (1 - (t - T_RACK_REL) / 0.045));
      }

      if (t >= w.reloadDur) {
        w.reloading = false;
        w.reloadCount++;
        setSupport(ZERO, ZERO);
        a.rx = a.ry = a.rz = a.px = a.py = a.pz = 0;
      }
    }

    // ---- old magazine falling out of the magwell (along the grip axis, gun-local)
    if (dropT >= 0) {
      dropT += dt;
      vm.mag.position.y = -(0.6 * dropT + 0.5 * 7.5 * dropT * dropT);
      vm.mag.rotation.x = dropT * 1.5;
      if (dropT > 0.5) { vm.mag.visible = false; }
    }

    // ---- slide cycling after a shot (when not driven by the rack animation)
    if (!(w.reloading && w.reloadEmpty)) {
      const lockZ = w.slideLocked ? SLIDE_LOCK : 0;
      if (slideT < 0.018) vm.slide.position.z = SLIDE_TRAVEL * (slideT / 0.018);
      else if (slideT < 0.075) vm.slide.position.z = lerp(SLIDE_TRAVEL, lockZ, (slideT - 0.018) / 0.057);
      else vm.slide.position.z = lockZ;
    }
  };

  return w;
}
