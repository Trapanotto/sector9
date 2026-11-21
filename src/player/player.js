// STUB (workstream C replaces this file, keeping the factory name and the ctx.player interface in CONTRACT.md).
// Simple walking controller: cylinder collision, stairs/steps, crouch, mouse look, chest-mounted bodycam
// camera with a little bob/lag, flashlight, door use, hittable with health.
import * as THREE from 'three';
import { U } from '../render/materials.js';

export function createPlayer(ctx) {
  const T = { walk: 2.3, sprint: 4.3, crouch: 1.2, slow: 1.1, accel: 10, radius: 0.3, height: 1.78, crouchHeight: 1.15, camStand: 1.48, camCrouch: 0.98 };
  const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  const st = { grounded: true, vy: 0, hitWall: false, groundY: 0 };
  const mouse = { dx: 0, dy: 0 };
  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  let camY = T.camStand, bob = 0, crouched = false, frozen = false;
  const hitInfo = { name: '' };

  const p = {
    id: 'player', order: ctx.ORDER.player,
    pos, vel, yaw: 0, pitch: 0, roll: 0,
    health: 100, dead: false, flashlight: !!ctx.settings.data.flashlightDefault, crouched: false, moving: 0,
    eye: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1),
    /** place the player (feet position), optionally freeze input (benchmarks) */
    teleport(xyz, yaw = p.yaw, pitch = 0, freeze = false) {
      pos.x = xyz[0]; pos.z = xyz[2];
      // xyz[1] may be an eye height (bench views): find the floor below it
      const g = ctx.world.groundHeight(pos.x, pos.z, xyz[1] + 0.1, 0.2);
      pos.y = g > -Infinity ? g : xyz[1];
      if (xyz[1] - pos.y > 0.5) camY = xyz[1] - pos.y;
      p.yaw = yaw; p.pitch = pitch; vel.x = vel.y = vel.z = 0; frozen = freeze;
      placeCamera(0);
    },
    // hittable (for enemy fire)
    kind: 'player', team: 'police',
    raycast(o, dir, maxT, part) {
      // vertical cylinder, radius 0.3, from feet to head
      const h = crouched ? T.crouchHeight : T.height;
      const ox = o.x - pos.x, oz = o.z - pos.z, a = dir.x * dir.x + dir.z * dir.z;
      if (a < 1e-8) return -1;
      const b = 2 * (ox * dir.x + oz * dir.z), c = ox * ox + oz * oz - T.radius * T.radius, disc = b * b - 4 * a * c;
      if (disc < 0) return -1;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < 0 || t > maxT) return -1;
      const y = o.y + dir.y * t - pos.y;
      if (y < 0 || y > h) return -1;
      part.name = y > h - 0.25 ? 'head' : y > h * 0.5 ? 'torso' : 'legs';
      return t;
    },
    onHit(res) {
      if (p.dead || ctx.bench || ctx.debug.god) return;
      p.health -= res.damage * (res.part === 'head' ? 2 : 1);
      ctx.events.emit('player:damage', { amount: res.damage, part: res.part, health: p.health, from: res.origin });
      if (p.health <= 0) { p.dead = true; p.health = 0; ctx.events.emit('player:death', {}); ctx.setState('dead'); }
    },
    init() {
      ctx.combat.register(p);
      p.reset();
    },
    reset() {
      const s = ctx.layout.playerSpawn;
      p.health = 100; p.dead = false; crouched = false; camY = T.camStand;
      p.teleport(s.pos, s.yaw, 0, false);
    },
    update(dt) {
      const input = ctx.input;
      const playing = ctx.state === 'playing' && !frozen;
      input.takeMouse(mouse);
      if (playing && input.locked) {
        const k = 0.0021 * (ctx.settings.data.sensitivity ?? 1);
        p.yaw -= mouse.dx * k;
        p.pitch -= mouse.dy * k * (ctx.settings.data.invertY ? -1 : 1);
        p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch));
      }
      // movement intent
      let mx = 0, mz = 0;
      if (playing) {
        if (input.held('forward')) mz -= 1; if (input.held('back')) mz += 1;
        if (input.held('left')) mx -= 1; if (input.held('right')) mx += 1;
        if (input.hit('crouch')) {
          if (crouched && !ctx.world.collision.blocked(pos.x, pos.y, pos.z, T.radius, T.height)) crouched = false;
          else crouched = true;
        }
        if (input.hit('flashlight')) { p.flashlight = !p.flashlight; ctx.events.emit('player:flashlight', { on: p.flashlight }); }
        if (input.hit('use')) ctx.world.doors.use(pos.x, pos.y, pos.z, -Math.sin(p.yaw), -Math.cos(p.yaw));
      }
      p.crouched = crouched;
      const len = Math.hypot(mx, mz);
      const speed = crouched ? T.crouch : input.held('walk') ? T.slow : input.held('sprint') && mz < 0 ? T.sprint : T.walk;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      let tx = 0, tz = 0;
      if (len > 0) { const ix = mx / len, iz = mz / len; tx = (ix * cy + iz * sy) * speed; tz = (-ix * sy + iz * cy) * speed; }
      const a = Math.min(1, T.accel * dt * (st.grounded ? 1 : 0.15));
      vel.x += (tx - vel.x) * a; vel.z += (tz - vel.z) * a;
      vel.y = st.grounded ? 0 : vel.y - 9.81 * dt;
      if (!frozen) {
        d.x = vel.x * dt; d.z = vel.z * dt; d.y = st.grounded ? -0.05 : vel.y * dt;
        ctx.world.collision.move(pos, d, { radius: T.radius, height: crouched ? T.crouchHeight : T.height, step: 0.45 }, st);
        if (pos.y < -40) p.reset();
      }
      p.moving = Math.hypot(vel.x, vel.z);
      placeCamera(dt);
      // flashlight (slightly right of the chest camera, follows the view)
      U.uFlashPos.value.copy(p.eye).addScaledVector(right, 0.12).y -= 0.05;
      U.uFlashDir.value.copy(p.forward);
      if (p.flashlight) U.uFlashColor.value.set(7.5, 7.0, 6.2); else U.uFlashColor.value.set(0, 0, 0);
    },
  };

  function placeCamera(dt) {
    const target = crouched ? T.camCrouch : T.camStand;
    camY += (target - camY) * Math.min(1, dt * 8);
    bob += dt * p.moving * 1.9;
    const amp = Math.min(1, p.moving / 2.5);
    const by = Math.abs(Math.sin(bob * Math.PI)) * 0.035 * amp, bx = Math.sin(bob * Math.PI) * 0.025 * amp;
    const cam = ctx.render.camera;
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    cam.position.set(pos.x + cy * bx, pos.y + camY + by, pos.z - sy * bx);
    p.roll += ((-(vel.x * cy - vel.z * sy) * 0.006) - p.roll) * Math.min(1, dt * 5);
    cam.rotation.set(p.pitch + by * 0.4, p.yaw, p.roll);
    cam.updateMatrixWorld();
    p.eye.copy(cam.position);
    p.forward.set(0, 0, -1).applyQuaternion(cam.quaternion);
    right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    fwd.copy(p.forward);
  }
  return p;
}
