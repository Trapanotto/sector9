// STUB (workstream C replaces this with the authored arms + pistol). Hitscan pistol from the camera centre,
// 15-round magazine, reload, recoil, muzzle flash via the shared cheap point light (U.uMuzzle*), a box proxy in
// the first-person scene lit by a CPU probe sample (PROBE_UNIFORM).
import * as THREE from 'three';
import { U, createDynamicMaterial } from '../render/materials.js';

export function createWeapon(ctx) {
  const mag = 15;
  const w = {
    id: 'weapon', order: ctx.ORDER.weapon,
    ammo: mag, reserve: 60, reloading: 0, cooldown: 0, flash: 0, kick: 0,
    damage: 34, range: 120,
  };
  const dir = { x: 0, y: 0, z: -1 }, org = { x: 0, y: 0, z: 0 };
  const evt = { ammo: 0 };
  let gun = null;
  const ps = {};

  w.init = () => {
    // first-person proxy: slide + grip, in camera space
    const mat = createDynamicMaterial({ color: [0.07, 0.07, 0.08], probe: 'uniform' });
    const g = new THREE.Group();
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.19), mat); slide.position.set(0, 0, -0.06);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.045), mat); grip.position.set(0, -0.055, 0.0); grip.rotation.x = 0.25;
    g.add(slide, grip);
    g.position.set(0.11, -0.13, -0.32);
    ctx.render.vmScene.add(g);
    gun = g;
  };
  w.reset = () => { w.ammo = mag; w.reserve = 60; w.reloading = 0; };

  w.update = (dt) => {
    const P = ctx.player, input = ctx.input;
    w.cooldown -= dt; w.flash -= dt;
    if (w.reloading > 0) { w.reloading -= dt; if (w.reloading <= 0) { const n = Math.min(mag - w.ammo, w.reserve); w.ammo += n; w.reserve -= n; ctx.events.emit('weapon:reloaded', w); } }
    if (ctx.state === 'playing' && input.locked && !P.dead) {
      if (input.hit('reload') && w.ammo < mag && w.reserve > 0 && w.reloading <= 0) { w.reloading = 1.8; ctx.events.emit('weapon:reload', w); }
      if (input.mouse.leftClicks > 0 && w.cooldown <= 0 && w.reloading <= 0) {
        if (w.ammo <= 0) ctx.events.emit('weapon:empty', w);
        else {
          w.ammo--; w.cooldown = 0.12; w.flash = 0.05; w.kick = 1;
          const cam = ctx.render.camera;
          org.x = cam.position.x; org.y = cam.position.y; org.z = cam.position.z;
          const s = 0.004 + P.moving * 0.004;
          dir.x = P.forward.x + (Math.random() - 0.5) * s; dir.y = P.forward.y + (Math.random() - 0.5) * s; dir.z = P.forward.z + (Math.random() - 0.5) * s;
          const l = Math.hypot(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l;
          ctx.combat.fire({ origin: org, dir, range: w.range, damage: w.damage, shooter: P, team: 'police' });
          evt.ammo = w.ammo;
          ctx.events.emit('weapon:fire', evt);
          P.pitch += 0.018; P.yaw += (Math.random() - 0.5) * 0.006;
        }
      }
    }
    // muzzle flash light (cheap point light term in every scene shader)
    if (w.flash > 0) {
      U.uMuzzlePos.value.copy(P.eye).addScaledVector(P.forward, 0.6);
      U.uMuzzleColor.value.set(9, 6.5, 3.5);
    } else U.uMuzzleColor.value.set(0, 0, 0);
    ctx.render.composite.uniforms.uFlashWhite.value = w.flash > 0 ? 0.04 : 0;
    // view model: recoil + bob + CPU probe light at the camera
    w.kick = Math.max(0, w.kick - dt * 9);
    if (gun) {
      gun.position.z = -0.32 + w.kick * 0.045;
      gun.rotation.x = w.kick * 0.18 + (w.reloading > 0 ? 0.9 : 0);
      gun.visible = !P.dead;
      ctx.render.vmCamera.position.set(0, 0, 0);
      const cam = ctx.render.camera;
      ctx.world.probes.sample(cam.position.x, cam.position.y, cam.position.z, ps);
      const cl = U.uProbeArtLevel.value;
      U.uProbeAmb.value.set(ps.r + ps.ar * cl, ps.g + ps.ag * cl, ps.b + ps.ab * cl);
      // directional term: probe dir is world space; the view model shades in camera space → rotate
      U.uProbeDirU.value.set(ps.dx, ps.dy, ps.dz).applyQuaternion(_q.copy(cam.quaternion).invert());
      U.uProbeSunU.value = ps.sun * 0.5;
    }
  };
  const _q = new THREE.Quaternion();
  return w;
}
