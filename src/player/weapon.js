// Service pistol (workstream C): authored arms + pistol (viewmodel.js), hip / low-ready / ADS holds, bodycam free
// aim, procedural sway / bob / breathing / recoil layered on the clips, slide cycle + lock on empty, dry fire,
// magazine reloads with retained rounds (ammo.js), wall retraction, muzzle flash light, casings, tracers.
// Shots leave along the visible sight line (aim.js lens mapping), so they land where the gun points on screen.
// Keeps ctx.weapon { ammo, reserve, reloading } and the weapon:* events of CONTRACT.md.
import * as THREE from 'three';
import { U } from '../render/materials.js';
import { createViewmodel } from './viewmodel.js';
import { createAmmo, resetAmmo, pull, canReload, reloadKind, swapMag, releaseSlide, inGun, reserve } from './ammo.js';
import { shotDirView } from './aim.js';

const DEG = Math.PI / 180;
// reload timelines (seconds into the clips, from scripts/chars/build_arms.mjs)
const RL = { magOut: 0.3, pouch: 0.75, magIn: 1.45, slide: 2.03 };

export function createWeapon(ctx) {
  const vm = createViewmodel(ctx);
  const A = createAmmo();
  const w = {
    id: 'weapon', order: ctx.ORDER.weapon,
    ammo: inGun(A), reserve: reserve(A), reloading: 0, mags: A, vm,
    damage: 34, range: 150, ads: 0, state: 'ready', shots: 0,
    lastShot: { origin: new THREE.Vector3(), dir: new THREE.Vector3(), sightDir: new THREE.Vector3(), muzzle: new THREE.Vector3() },
    // view-model framing offsets (m / rad, camera space; tuned at 1280×720, 1920×1080 and 760×630)
    frame: { hipX: 0, hipY: 0.045, hipZ: 0, hipPitch: 0, adsY: 0.065, adsZ: 0, adsPitch: -0.05 },
  };
  const s = {
    adsW: 0, adsToggle: false, lowT: 0, lowW: 0, sprintW: 0, retract: 0, cooldown: 0, onTrig: 0, lastFire: -9,
    press: 0, pressT: -1, slideT: -1, flash: 0,
    rp: 0, rpv: 0, ry: 0, ryv: 0, rz: 0, rzv: 0, rr: 0, rrv: 0,          // recoil springs (pitch, yaw, back, roll)
    sy: 0, syv: 0, sp: 0, spv: 0,                                         // mouse sway springs
    rName: '', rTime: 0, rDur: 0, rW: 0, rStage: 0, dryT: -1, deadT: 0, breath: 0,
  };
  const evFire = { ammo: 0 }, evEmpty = { ammo: 0, locked: false }, evStage = { stage: '', kind: '', ammo: 0 };
  const org = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };
  const rsV = new THREE.Vector3(), dV = new THREE.Vector3(), outV = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const qA = new THREE.Quaternion(), eA = new THREE.Euler(0, 0, 0, 'YXZ');
  const hitR = { hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '', box: -1, zone: -1, owner: null };

  w.load = (loader) => vm.load(loader);
  w.init = () => { vm.init(); };
  w.reset = () => {
    resetAmmo(A);
    s.rName = ''; s.rTime = 0; s.rW = 0; s.adsW = 0; s.adsToggle = false; s.lowT = 0; s.lowW = 0; s.sprintW = 0;
    s.slideT = -1; s.pressT = -1; s.deadT = 0; s.flash = 0;
    w.state = 'ready';
    sync();
  };
  /** checkpoint helpers for the director: ammo state as plain data, restore after reset() */
  w.snapshot = () => ({ chamber: A.chamber, mag: A.mag, spares: A.spares.slice(), slideLocked: A.slideLocked });
  w.restore = (sn) => { if (!sn) return; A.chamber = sn.chamber; A.mag = sn.mag; A.spares.length = 0; for (const n of sn.spares) A.spares.push(n); A.slideLocked = sn.slideLocked; sync(); };
  function sync() { w.ammo = inGun(A); w.reserve = reserve(A); w.reloading = s.rName ? Math.max(0.001, s.rDur - s.rTime) : 0; }

  function startReload() {
    if (!canReload(A) || s.rName) return false;
    const kind = reloadKind(A);
    s.rName = kind === 'empty' ? 'fp_reload' : 'fp_reload_tac';
    s.rDur = vm.reloadDur?.[s.rName] ?? (kind === 'empty' ? 2.5 : 2.2);
    s.rTime = 0; s.rStage = 0; s.adsToggle = false;
    w.state = 'reload';
    sync();
    ctx.events.emit('weapon:reload', w);
    stage('start', kind);
    return true;
  }
  function stage(name, kind) { evStage.stage = name; evStage.kind = kind ?? (s.rName === 'fp_reload' ? 'empty' : 'tactical'); evStage.ammo = inGun(A); ctx.events.emit('c:reload', evStage); }

  function shoot(cam, P) {
    const r = pull(A);
    if (r !== 'fired') {
      // dry: finger presses, nothing happens (slide locked back -> no click)
      s.dryT = 0; s.pressT = 0;
      evEmpty.ammo = inGun(A); evEmpty.locked = r === 'locked';
      ctx.events.emit('weapon:empty', evEmpty);
      s.cooldown = 0.25;
      return;
    }
    w.shots++;
    s.cooldown = 0.085; s.lastFire = ctx.time.now; s.onTrig = 1;
    s.pressT = 0; s.slideT = 0; s.flash = 0.05;
    // direction: the sight line as seen through the world lens (zeroed at 15 m), plus a small cone
    vm.toView(vm.rearSight, cam, rsV);
    vm.dirToView(vm.barrel, cam, dV);
    shotDirView(rsV, dV, vm.zoom, outV);
    const cone = (s.adsW > 0.5 ? 0.12 : 0.45) * DEG + Math.min(2, P.moving) * 0.25 * DEG + (P.sprinting ? 1 : 0) * DEG;
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * cone;
    outV.x += Math.cos(a) * rr; outV.y += Math.sin(a) * rr; outV.normalize();
    w.lastShot.sightDir.copy(outV).applyQuaternion(cam.quaternion);
    tmp.copy(outV).applyQuaternion(cam.quaternion);
    org.x = cam.position.x; org.y = cam.position.y; org.z = cam.position.z;
    dir.x = tmp.x; dir.y = tmp.y; dir.z = tmp.z;
    w.lastShot.origin.copy(cam.position); w.lastShot.dir.copy(tmp);
    const res = ctx.combat.fire({ origin: org, dir, range: w.range, damage: w.damage, shooter: P, team: 'police' });
    // recoil: the gun flips and pushes back inside the free-aim zone; the camera only shivers
    const adsK = s.adsW > 0.5 ? 0.8 : 1;
    s.rpv += (2.3 + Math.random() * 0.6) * adsK; s.ryv += (Math.random() - 0.45) * 0.9; s.rzv += 0.55; s.rrv += (Math.random() - 0.3) * 1.4;
    P.pitch += (0.18 + Math.random() * 0.12) * DEG;
    // muzzle flash (view model sprite + world point light at the muzzle as seen through the world lens)
    vm.toWorldLens(vm.muzzle, cam, w.lastShot.muzzle);
    ctx.fx?.muzzle?.(vm.muzzle, vm.barrel, w.lastShot.muzzle);
    // casing from the ejection port (world-lens position), thrown right/up/back
    vm.toWorldLens(vm.port, cam, tmp2);
    ctx.fx?.casing?.(tmp2, vm.portRight, cam);
    if (w.shots % 4 === 1 && res.hit) ctx.fx?.tracer?.(w.lastShot.muzzle, res.point);
    evFire.ammo = inGun(A);
    ctx.events.emit('weapon:fire', evFire);
    if (A.slideLocked) ctx.events.emit('c:slidelock', evFire);
  }

  // damped springs on s[x] / s[v] (no allocations)
  const spring = (x, v, k, d, dt) => { s[v] += (-k * s[x] - d * s[v]) * dt; s[x] += s[v] * dt; };

  w.update = (dt) => {
    const P = ctx.player, input = ctx.input, set = ctx.settings.data, cam = ctx.render.camera;
    const playing = ctx.state === 'playing' && input.locked && !P.dead;
    s.cooldown -= dt;
    // ---- inputs
    let fireReq = 0, adsHeld = false;
    if (playing) {
      fireReq = input.mouse.leftClicks;
      if ((set.aimMode ?? set.adsMode) === 'toggle') { if (input.mouse.rightPressed) s.adsToggle = !s.adsToggle; adsHeld = s.adsToggle; }
      else adsHeld = input.mouse.right;
      if (input.mouse.wheel > 0) s.lowT = 1; else if (input.mouse.wheel < 0) s.lowT = 0;
      if (input.hit('reload')) startReload();
    }
    const reloading = !!s.rName;
    const sprint = P.sprinting && !reloading;
    if (adsHeld || fireReq) s.lowT = 0;
    const adsT = adsHeld && !sprint && !reloading ? 1 : 0;
    s.adsW += (adsT - s.adsW) * Math.min(1, dt * (adsT ? 9 : 7));
    P.ads = s.adsW > 0.5;
    w.ads = s.adsW;
    s.sprintW += ((sprint ? 1 : 0) - s.sprintW) * Math.min(1, dt * (sprint ? 6 : 8));
    // wall retraction: something within ~0.8 m along the gun's line -> pull the gun in / down
    let retractT = 0;
    if (!P.dead) {
      eA.set(P.pitch + P.aimOff.pitch, P.yaw + P.aimOff.yaw, 0); qA.setFromEuler(eA);
      tmp.set(0, 0, -1).applyQuaternion(qA);
      org.x = cam.position.x; org.y = cam.position.y; org.z = cam.position.z; dir.x = tmp.x; dir.y = tmp.y; dir.z = tmp.z;
      if (ctx.world.worldHit(org, dir, 0.85, hitR, { ignoreGlass: false })) retractT = Math.min(1, Math.max(0, (0.85 - hitR.t) / 0.5));
    }
    s.retract += (retractT - s.retract) * Math.min(1, dt * (retractT > s.retract ? 12 : 5));
    s.lowW += ((Math.max(s.lowT, s.retract > 0.7 ? 1 : 0)) - s.lowW) * Math.min(1, dt * 6);
    // ---- firing
    const canFire = playing && !reloading && s.sprintW < 0.35 && s.retract < 0.75 && s.lowW < 0.5;
    while (fireReq > 0 && canFire && s.cooldown <= 0) { shoot(cam, P); fireReq--; }
    if (fireReq > 0 && playing && (s.sprintW >= 0.35 || s.lowW >= 0.5)) s.lowT = 0;
    // finger on the trigger while aiming / shooting, indexed otherwise (trigger discipline)
    const trigT = (s.adsW > 0.3 || ctx.time.now - s.lastFire < 1.6 || input.mouse.left) && !reloading && s.sprintW < 0.3 && s.lowW < 0.5 ? 1 : 0;
    s.onTrig += (trigT - s.onTrig) * Math.min(1, dt * (trigT ? 20 : 6));
    // trigger press / slide cycle (procedural)
    if (s.pressT >= 0) { s.pressT += dt; const t = s.pressT; s.press = t < 0.03 ? t / 0.03 : t < 0.07 ? 1 : Math.max(0, 1 - (t - 0.07) / 0.1); if (t > 0.2) s.pressT = -1; } else s.press = 0;
    let slide = 0;
    if (A.slideLocked && !reloading) slide = s.slideT >= 0 && s.slideT < 0.016 ? s.slideT / 0.016 : 1;
    if (s.slideT >= 0) { s.slideT += dt; const t = s.slideT; if (!A.slideLocked) slide = t < 0.016 ? t / 0.016 : Math.max(0, 1 - (t - 0.016) / 0.05); if (t > 0.1) s.slideT = -1; }
    // ---- reload progress (stages drive the ammo logic + audio)
    if (reloading) {
      s.rTime += dt;
      const t = s.rTime;
      const kind = s.rName === 'fp_reload' ? 'empty' : 'tactical';
      if (s.rStage === 0 && t >= RL.magOut) { s.rStage = 1; stage('mag_out'); }
      if (s.rStage === 1 && t >= RL.pouch) { s.rStage = 2; stage('mag_pouch'); }
      if (s.rStage === 2 && t >= RL.magIn) { s.rStage = 3; swapMag(A); stage('mag_in'); sync(); }
      if (s.rStage === 3 && kind === 'empty' && t >= RL.slide) { s.rStage = 4; releaseSlide(A); stage('slide_release'); sync(); }
      if (t >= s.rDur) {
        s.rName = ''; s.rTime = 0; w.state = 'ready';
        if (A.slideLocked) releaseSlide(A);
        sync();
        ctx.events.emit('weapon:reloaded', w);
      }
      s.rW = Math.min(1, s.rW + dt / 0.12);
      if (s.rDur - s.rTime < 0.2) s.rW = Math.max(0, (s.rDur - s.rTime) / 0.2);
    } else s.rW = Math.max(0, s.rW - dt / 0.12);
    // ---- procedural layers (camera-space gun offset)
    const sdt = Math.min(dt, 1 / 30);
    spring('rp', 'rpv', 160, 16, sdt); spring('ry', 'ryv', 160, 18, sdt);
    spring('rz', 'rzv', 260, 24, sdt); spring('rr', 'rrv', 140, 16, sdt);
    // mouse sway: the gun lags the turn a little (spring driven by the input velocity)
    const mvy = dt > 0 ? P.mouseDX / dt : 0, mvp = dt > 0 ? P.mouseDY / dt : 0;
    s.syv += (-Math.max(-6, Math.min(6, mvy)) * 0.9 - 60 * s.sy - 11 * s.syv) * sdt; s.sy += s.syv * sdt;
    s.spv += (-Math.max(-6, Math.min(6, mvp)) * 0.7 - 60 * s.sp - 11 * s.spv) * sdt; s.sp += s.spv * sdt;
    // breathing (slow, smaller when aiming) + walking bob synced to the footsteps
    s.breath += dt;
    const bk = 1 - 0.6 * s.adsW;
    const brP = Math.sin(s.breath * 2 * Math.PI * 0.24) * 0.22 * DEG * bk, brY = Math.sin(s.breath * 2 * Math.PI * 0.13 + 1) * 0.14 * DEG * bk;
    const ph = P.bobPhase * Math.PI, ba = P.bobAmp * (1 - 0.5 * s.adsW) * (ctx.settings.data.headBob ?? 1);
    const bobY = (Math.abs(Math.cos(ph)) - 0.5) * 0.008 * ba, bobX = Math.sin(ph) * 0.006 * ba, bobR = Math.sin(ph) * 1.6 * DEG * ba, bobP = Math.cos(2 * ph) * 0.5 * DEG * ba;
    // death: the gun drops out of the picture
    if (P.dead) s.deadT += dt; else s.deadT = 0;
    const drop = Math.min(1, s.deadT / 0.5);
    const o = vm.off;
    const fa = 1 - s.sprintW * 0.8;                     // free-aim offset fades while sprinting (gun tucked)
    o.yaw = P.aimOff.yaw * fa + s.sy * 0.04 + s.ry * DEG + brY;
    o.pitch = P.aimOff.pitch * fa + s.sp * 0.04 + s.rp * DEG + brP + bobP - s.retract * 0.25 - drop * 0.9;
    o.roll = bobR + s.rr * DEG - s.sy * 0.02;
    o.x = bobX; o.y = bobY - s.retract * 0.03 - drop * 0.25; o.z = s.rz * 0.012 + s.retract * 0.07;
    // holds: hip ⇄ ADS, low-ready, sprint (weights sum to 1)
    const lw = s.lowW * (1 - s.sprintW), hw = (1 - s.lowW) * (1 - s.sprintW);
    // framing on top of the authored holds (camera space): hip raised so both hands stay in the picture,
    // ADS pulled in and tipped down a little so the sight picture reads (top of the slide visible)
    const F = w.frame, kh = hw * (1 - s.adsW) + lw * 0.5, ka = hw * s.adsW;
    o.x += F.hipX * kh; o.y += F.hipY * kh + F.adsY * ka; o.z += F.hipZ * kh + F.adsZ * ka;
    o.pitch += F.hipPitch * kh + F.adsPitch * ka;
    vm.w.hip = hw * (1 - s.adsW); vm.w.aim = hw * s.adsW; vm.w.low = lw; vm.w.sprint = s.sprintW;
    vm.reload.name = s.rName || vm.reload.name; vm.reload.time = s.rTime; vm.reload.weight = s.rW;
    if (!s.rName && s.rW <= 0) vm.reload.name = '';
    vm.supportGrip = 1 - s.rW;
    vm.onTrig = s.onTrig; vm.press = s.press;
    vm.slide = slide; vm.slideOverride = !reloading || s.rW < 0.5;
    vm.visible = !(P.dead && s.deadT > 0.6) && ctx.state !== 'menu' && ctx.state !== 'loading';
    vm.update(dt, cam);
    // world muzzle light (cheap shared point light term)
    s.flash -= dt;
    if (s.flash > 0) { U.uMuzzlePos.value.copy(w.lastShot.muzzle).addScaledVector(w.lastShot.dir, 0.05); U.uMuzzleColor.value.set(9, 6.5, 3.5).multiplyScalar(s.flash / 0.05 * 0.6 + 0.4); }
    else U.uMuzzleColor.value.set(0, 0, 0);
    const cu = ctx.render.composite?.uniforms;
    if (cu) cu.uFlashWhite.value = s.flash > 0.03 ? 0.025 : 0;
    sync();
  };
  return w;
}
