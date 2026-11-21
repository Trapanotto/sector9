// STUB (workstream D replaces this with authored rigged CC0 characters, animation and real AI; keep the ctx.enemies
// interface from CONTRACT.md). Proxies: one low-poly capsule-ish mesh per enemy (probe lit), PVS/LOD culling via
// ctx.lod, hittable with head/torso/legs, minimal behaviour: guards/patrols turn to and shoot at a visible player,
// patrols walk their waypoints along nav paths, sleepers lie down until alerted.
import * as THREE from 'three';
import { createDynamicMaterial } from '../render/materials.js';

const ROLE_COLOR = { guard: [0.25, 0.22, 0.2], patrol: [0.18, 0.22, 0.28], sleeper: [0.3, 0.26, 0.2], ambusher: [0.22, 0.18, 0.16] };

export function createEnemies(ctx) {
  const api = { id: 'enemies', order: ctx.ORDER.enemies, list: [] };
  const geo = new THREE.CylinderGeometry(0.24, 0.2, 1.75, 8, 1);
  geo.translate(0, 0.875, 0);
  const headGeo = new THREE.BoxGeometry(0.2, 0.24, 0.22); headGeo.translate(0, 1.62, 0.02);
  const merged = mergeTwo(geo, headGeo);
  const path = new Int32Array(512);
  const eye = { x: 0, y: 0, z: 0 }, tgt = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };

  api.init = () => {
    const mats = {};
    for (const [r, c] of Object.entries(ROLE_COLOR)) mats[r] = createDynamicMaterial({ color: c });
    ctx.layout.enemies.forEach((def, i) => {
      const mesh = new THREE.Mesh(merged, mats[def.role] ?? mats.guard);
      mesh.name = `enemy:${def.id}`;
      ctx.render.scene.add(mesh);
      const e = {
        def, id: def.id, index: i, kind: 'enemy', team: 'gang', mesh,
        pos: new THREE.Vector3(), yaw: 0, health: 100, dead: false, alerted: false, cool: 0, wp: 0, path: [], pathI: 0, repath: 0, lod: 0,
        raycast(o, d, maxT, part) {
          // vertical cylinder r 0.28, height 1.8 (lying: low box)
          const lying = e.dead || (def.role === 'sleeper' && !e.alerted);
          const h = lying ? 0.45 : 1.8;
          const ox = o.x - e.pos.x, oz = o.z - e.pos.z, a = d.x * d.x + d.z * d.z;
          if (a < 1e-8) return -1;
          const R = lying ? 0.9 : 0.28;
          const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - R * R, disc = b * b - 4 * a * c;
          if (disc < 0) return -1;
          const t = (-b - Math.sqrt(disc)) / (2 * a);
          if (t < 0 || t > maxT) return -1;
          const y = o.y + d.y * t - e.pos.y;
          if (y < 0 || y > h) return -1;
          part.name = !lying && y > 1.5 ? 'head' : y > 0.9 ? 'torso' : 'legs';
          return t;
        },
        onHit(res) {
          if (e.dead) return;
          const dmg = res.damage * (res.part === 'head' ? 4 : res.part === 'legs' ? 0.6 : 1);
          e.health -= dmg; e.alerted = true;
          ctx.events.emit('enemy:damage', { id: e.id, enemy: e, amount: dmg, part: res.part });
          if (e.health <= 0) { e.dead = true; ctx.events.emit('enemy:death', { id: e.id, enemy: e, part: res.part }); }
        },
      };
      api.list.push(e);
      ctx.combat.register(e);
    });
    api.reset();
    ctx.events.on('shot', (r) => {
      // gunfire alerts everyone within 30 m (stub: no occlusion)
      for (const e of api.list) if (!e.dead && e.pos.distanceTo(_v.set(r.origin.x, r.origin.y, r.origin.z)) < 30) e.alerted = true;
    });
    ctx.events.on('trigger:enter', (t) => { for (const e of api.list) if (e.def.trigger === t.id) e.alerted = true; });
  };
  const _v = new THREE.Vector3();

  api.reset = () => {
    for (const e of api.list) {
      e.pos.set(...e.def.pos); e.yaw = e.def.yaw; e.health = 100; e.dead = false; e.alerted = false; e.cool = 1 + Math.random(); e.wp = 0; e.path.length = 0;
      e.mesh.visible = true;
    }
  };
  /** alert enemies (ids array or null = all) — used by the director for staged moments */
  api.alert = (ids, pos) => { for (const e of api.list) if (!ids || ids.includes(e.id)) e.alerted = true; };
  api.alive = () => api.list.filter((e) => !e.dead).length;

  api.update = (dt) => {
    const P = ctx.player, nav = ctx.world.nav, playing = ctx.state === 'playing';
    for (let i = 0; i < api.list.length; i++) {
      const e = api.list[i], d = e.def;
      const lodLevel = ctx.lod.level(e.pos.x, e.pos.y, e.pos.z);
      e.lod = lodLevel;
      e.mesh.visible = lodLevel < 3;
      if (playing && !e.dead) {
        eye.x = e.pos.x; eye.y = e.pos.y + 1.6; eye.z = e.pos.z;
        tgt.x = P.eye.x; tgt.y = P.eye.y - 0.2; tgt.z = P.eye.z;
        const dx = tgt.x - eye.x, dz = tgt.z - eye.z, dist = Math.hypot(dx, dz);
        const awake = !(d.role === 'sleeper' && !e.alerted) && !(d.role === 'ambusher' && !e.alerted);
        let sees = false;
        if (awake && dist < 28 && !P.dead) {
          const fwdDot = (-Math.sin(e.yaw) * dx - Math.cos(e.yaw) * dz) / Math.max(dist, 1e-3);
          if ((e.alerted || fwdDot > 0.35) && (ctx.time.frame + i) % 6 === 0) e._los = ctx.world.lineOfSight(eye, tgt);
          sees = !!e._los && (e.alerted || fwdDot > 0.35);
        } else e._los = false;
        if (sees) {
          e.alerted = true;
          const want = Math.atan2(-dx, -dz);
          let dy = want - e.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          e.yaw += Math.sign(dy) * Math.min(Math.abs(dy), dt * 3);
          e.cool -= dt;
          if (e.cool <= 0 && Math.abs(dy) < 0.3) {
            e.cool = 0.9 + Math.random() * 0.9;
            const l = Math.hypot(dx, tgt.y - eye.y, dz), sp = 0.05 + dist * 0.004;
            dir.x = dx / l + (Math.random() - 0.5) * sp; dir.y = (tgt.y - eye.y) / l + (Math.random() - 0.5) * sp; dir.z = dz / l + (Math.random() - 0.5) * sp;
            const k = Math.hypot(dir.x, dir.y, dir.z); dir.x /= k; dir.y /= k; dir.z /= k;
            ctx.combat.fire({ origin: eye, dir, range: 60, damage: 9, shooter: e, team: 'gang' });
            ctx.events.emit('enemy:fire', { id: e.id, enemy: e });
          }
        } else if (d.role === 'patrol' && d.patrol && nav) {
          // walk waypoints along a nav path (repath when the path is used up)
          if (e.pathI >= e.path.length) {
            e.wp = (e.wp + 1) % d.patrol.length;
            const w = d.patrol[e.wp];
            const a = nav.nearest(e.pos.x, e.pos.y + 0.1, e.pos.z), b = nav.nearest(w[0], e.pos.y + 0.1, w[1]);
            const n = nav.findPath(a, b, path);
            e.path.length = 0; for (let k = n - 1; k >= 0; k -= 2) e.path.push(path[k]); e.pathI = 0;
            if (!n) e.path.push(b);
          }
          const k = e.path[e.pathI];
          if (k >= 0) {
            const tx = nav.nodeX(k), tz = nav.nodeZ(k), ddx = tx - e.pos.x, ddz = tz - e.pos.z, dd = Math.hypot(ddx, ddz);
            if (dd < 0.3) e.pathI++;
            else {
              const sp = 1.2 * dt;
              e.pos.x += ddx / dd * sp; e.pos.z += ddz / dd * sp; e.pos.y += (nav.nodeY[k] - e.pos.y) * Math.min(1, dt * 6);
              e.yaw = Math.atan2(-ddx, -ddz);
            }
          } else e.pathI++;
        }
      }
      // pose (stub "animation" = transform), throttled by LOD for the real skeletons later
      if (ctx.lod.animStep(i, lodLevel) || e.dead) {
        const lying = e.dead || (d.role === 'sleeper' && !e.alerted);
        e.mesh.position.copy(e.pos);
        e.mesh.rotation.set(lying ? -Math.PI / 2 : 0, e.yaw, 0, 'YXZ');
        if (lying) e.mesh.position.y += 0.25;
      }
    }
  };
  return api;
}

function mergeTwo(a, b) {
  const g = new THREE.BufferGeometry();
  const A = a.toNonIndexed(), B = b.toNonIndexed();
  for (const name of ['position', 'normal']) {
    const x = A.attributes[name].array, y = B.attributes[name].array, o = new Float32Array(x.length + y.length);
    o.set(x); o.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(o, 3));
  }
  return g;
}
