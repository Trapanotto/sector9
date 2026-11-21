// Workstream D: enemies. Rigged CC0 characters (MakeHuman on the UAL skeleton, public/assets/chars), shared
// clips, probe-lit dynamic material with a head privacy mosaic, contact-shadow blobs, instanced weapons,
// distance/visibility LOD under a triangle budget, throttled skinning, frozen bodies; AI in brain.js (pure,
// deterministic), animation in anim.js. Keeps the ctx.enemies interface of CONTRACT.md §4 and adds director hooks.
//
// ctx.enemies: list[] (id, def, pos Vector3, yaw, health, dead, alerted, lod, state, …), alert(ids|null, pos),
//   alive(), and for the director (F): ambush(ids), wake(ids), spawn(ids), hold(ids, on), moveTo(id, [x,y,z], run),
//   say(id, kind), trigger(momentId), group(name) → ids, stats (kills, surrendered, executed, …), budget (last frame).
//   ids may name enemies or groups (actors.js `group`).
// Events (D): enemy:damage/death/fire/alert (contract) and d:voice {id, enemy, kind: alert|command|reload|pain|
//   death|dying|taunt|plead|surprise, pos, zone}, d:nearmiss {id, enemy, point, dist}, d:step {id, enemy, pos, run},
//   d:surrender {id, enemy}, d:executed {id, enemy} (shot while surrendered → debrief), d:state {id, enemy, from, to}.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { url } from '../core/loader.js';
import { BUDGETS } from '../core/budgets.js';
import { createBrain, WEAPONS } from './brain.js';
import { buildCover } from './cover.js';
import { makeFallClear, makeMasking } from './envkit.js';
import { createAnimLib, createAnimator, updateActorWorld } from './anim.js';
import { createCharacterMaterial, createWeaponMaterial, createBlobMaterial, createTorchMaterial } from './look.js';

const BASE = 'assets/chars/';
const ATLAS = 512;          // character atlases are downscaled to fit D's texture budget (6 × 1.4 MB)
const KICK = { pistol: 0.05, smg: 0.03, shotgun: 0.12 };

export function createEnemies(ctx) {
  const api = { id: 'enemies', order: ctx.ORDER.enemies, list: [] };
  const A = {};             // loaded assets
  let brain = null, lib = null, blobs = null, masking = null, torches = null;
  const weaponMeshes = {};  // model → InstancedMesh
  const wmList = [];
  const actors = [];        // per enemy: { actor, lod0, lod1, anim, mat, skel, dirty, adt, … }
  const budget = { visible: 0, lod0: 0, draws: 0, tris: 0, animated: 0, cpuMs: 0, aiMs: 0 };
  api.budget = budget;
  api._actors = actors;   // debugging / tests

  // ---------------------------------------------------------------------------------------------------
  api.load = async (loader) => {
    // dynamic like core's loader.gltf (one lazily loaded chunk, no build warning)
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/libs/meshopt_decoder.module.js')]);
    const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const parse = (bytes) => new Promise((res, rej) => gl.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), url(BASE), res, rej));
    const [manifest, hit, weapons] = await Promise.all([
      loader.json(BASE + 'manifest.json', 0.05), loader.json(BASE + 'hitboxes.json', 0.05), loader.json(BASE + 'weapons/weapons.json', 0.05),
    ]);
    A.manifest = manifest; A.hit = hit; A.weapons = weapons;
    const files = [manifest.anims, ...manifest.variants.map((v) => v.file), ...['pistol', 'smg', 'shotgun'].map((w) => weapons[w].file)];
    const bins = await Promise.all(files.map((f) => loader.bin(BASE + f, { weight: 0.4 })));
    const gltfs = await Promise.all(bins.map(parse));
    A.clips = gltfs[0].animations;
    A.variants = {};
    manifest.variants.forEach((v, i) => { A.variants[v.name] = { def: v, scene: gltfs[1 + i].scene }; });
    A.weaponScenes = { pistol: gltfs[7].scene, smg: gltfs[8].scene, shotgun: gltfs[9].scene };
  };

  // ---------------------------------------------------------------------------------------------------
  api.init = () => {
    const scene = ctx.render.scene, W = ctx.world;
    const defs = ctx.layout.enemies;
    const t0 = performance.now();
    // shared resources per variant: downscaled atlas, LOD tri counts, head bone index
    const vinfo = {};
    let texBytes = 0;
    for (const [name, v] of Object.entries(A.variants)) {
      const lod0 = v.scene.getObjectByName(v.def.lod0), lod1 = v.scene.getObjectByName(v.def.lod1);
      const map = downscale(lod0.material.map, ATLAS);
      texBytes += ATLAS * ATLAS * 4 * 1.34;
      const headBone = lod0.skeleton.bones.findIndex((b) => b.name === 'Head');
      const headInv = lod0.skeleton.boneInverses[headBone].clone();
      vinfo[name] = { map, headBone, headInv, rs: v.def.rootScale, tris0: tri(lod0.geometry), tris1: tri(lod1.geometry), tris2: tri(v.scene.getObjectByName(v.def.lod2 ?? name + '_LOD2').geometry) };
      lod0.material.map?.dispose(); lod0.material.dispose();
    }
    ctx.render.trackTexture?.('enemies', texBytes);
    // animation library (clips split by body half, speeds and end poses measured on a reference clone)
    const ref = A.variants.thug_jacket ?? Object.values(A.variants)[0];
    lib = createAnimLib(A.clips, SkeletonUtils.clone(ref.scene), ref.def.rootScale);
    api.animLib = lib;

    // weapons: one instanced draw per model for every enemy (and dropped weapons)
    const wmat = createWeaponMaterial();
    for (const [model, s] of Object.entries(A.weaponScenes)) {
      const geo = mergeScene(s);
      const m = new THREE.InstancedMesh(geo, wmat, 32);
      m.name = `enemyWeapons:${model}`; m.frustumCulled = false; m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.userData.tris = tri(geo);
      scene.add(m); weaponMeshes[model] = m; wmList.push(m);
    }
    // contact-shadow blobs
    const bgeo = new THREE.PlaneGeometry(1, 1); bgeo.rotateX(-Math.PI / 2);
    blobs = new THREE.InstancedMesh(bgeo, createBlobMaterial(), 32);
    blobs.name = 'enemyBlobs'; blobs.frustumCulled = false; blobs.count = 0; blobs.renderOrder = 1;
    blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(blobs);

    // torch beams (director 'flashlight' stage): one instanced additive draw
    const tgeo = new THREE.ConeGeometry(1.5, 7, 16, 1, true); tgeo.translate(0, -3.5, 0); tgeo.rotateX(-Math.PI / 2);
    torches = new THREE.InstancedMesh(tgeo, createTorchMaterial(), 8);
    torches.name = 'enemyTorches'; torches.frustumCulled = false; torches.count = 0; torches.renderOrder = 2;
    torches.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(torches);

    // brain + env adapter
    masking = makeMasking(W.gen.zoneIndex, W.zoneAt);
    const cover = buildCover(W.nav, W.bvh, ctx.layout.site.bounds);
    api.cover = cover;
    const P = ctx.player;
    const ps = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 };
    const zones = ctx.layout.zones;
    let doorByEnemy = false;
    const fireOpts = { origin: null, dir: null, range: 0, damage: 0, shooter: null, team: 'gang' };
    const player = { pos: P.pos, eye: P.eye, forward: P.forward, crouched: false, moving: 0, dead: false, flashlight: false, ref: P };
    const env = {
      nav: W.nav, collision: W.collision, cover, player,
      los: (a, b) => W.lineOfSight(a, b),
      fire(e, o, d, range, dmg) { fireOpts.origin = o; fireOpts.dir = d; fireOpts.range = range; fireOpts.damage = dmg; fireOpts.shooter = e; return ctx.combat.fire(fireOpts); },
      emit: (n, p) => ctx.events.emit(n, p),
      lightAt(x, y, z) {
        W.probes.sample(x, y, z, ps);
        const zi = W.zoneAt(x, y, z), circ = zi >= 0 ? zones[zi]?.circuit : null;
        const lv = circ ? W.lights.level(circ) : 1;
        const lum = 0.2126 * (ps.r + ps.ar * lv) + 0.7152 * (ps.g + ps.ag * lv) + 0.0722 * (ps.b + ps.ab * lv);
        return Math.min(1, lum / LIGHT_REF);
      },
      maskAt: (x, y, z) => masking.at(x, y, z),
      playerMask: () => ctx.director?.masking ?? 0,   // F: loud machines near the player (0..1)
      doorOpen: (i) => { const r = W.doors.list[i]; return r.kind === 'swing' ? (r.t > 0.35 ? 1 : r.t) : r.t; },
      doorState: (i) => W.doors.list[i].state,
      openDoor: (i) => { const r = W.doors.list[i]; if (r.state === 'locked' || r.target > 0.5) return; doorByEnemy = true; W.doors.set(r.id, 'open'); doorByEnemy = false; },
      fallClear: makeFallClear(W.bvh, W.collision),
    };
    api.env = env;
    brain = createBrain(env, defs, { seed: 9, vec3: () => new THREE.Vector3() });
    api.brain = brain;
    api.list = brain.list;
    api.stats = brain.stats;

    // characters
    brain.list.forEach((e, i) => {
      const vname = e.def.look && A.variants[e.def.look] ? e.def.look : Object.keys(A.variants)[i % 6];
      const v = A.variants[vname], vi = vinfo[vname];
      const actor = SkeletonUtils.clone(v.scene);
      actor.name = `enemy:${e.id}`;
      const lod0 = actor.getObjectByName(v.def.lod0), lod1 = actor.getObjectByName(v.def.lod1), lod2 = actor.getObjectByName(v.def.lod2 ?? vname + '_LOD2');
      lod1.bind(lod0.skeleton, lod1.bindMatrix); lod2.bind(lod0.skeleton, lod2.bindMatrix);
      const tint = e.def.tint ?? [1, 1, 1];
      const mat = createCharacterMaterial(vi.map, vi.headInv, tint);
      for (const m of [lod0, lod1, lod2]) { m.material = mat; m.frustumCulled = false; m.matrixAutoUpdate = false; }
      lod1.visible = false; lod2.visible = false;
      actor.matrixWorldAutoUpdate = false;
      actor.traverse((o) => { if (o !== actor && !o.isBone && !o.isMesh) o.matrixAutoUpdate = false; });
      // skinning texture uploads only when the pose changed (throttled / frozen actors cost nothing)
      const skel = lod0.skeleton, upd = skel.update.bind(skel);
      const rec = { e, actor, lod0, lod1, lod2, mat, vi, skel, dirty: true, adt: 0, vis: false, lodSel: 1, frozenOnce: false, blob: null, everVisible: false };
      skel.update = () => { if (rec.dirty) { upd(); rec.dirty = false; } };
      const model = WEAPONS[e.def.weapon]?.model ?? 'pistol';
      const wd = A.weapons[model];
      rec.wModel = model;
      rec.tOff = new THREE.Matrix4().makeTranslation(...wd.muzzle);
      rec.wOff = new THREE.Matrix4().compose(new THREE.Vector3(...wd.offset.position), new THREE.Quaternion(...wd.offset.quaternion), new THREE.Vector3(1, 1, 1).multiplyScalar(1 / vi.rs));
      rec.hand = actor.getObjectByName('hand_r');
      rec.anim = createAnimator(actor, lib, { capsules: A.hit.capsules, rootScale: vi.rs, wanim: WEAPONS[e.def.weapon]?.anim ?? 'pistol', now: () => brain.now, fireKick: KICK[WEAPONS[e.def.weapon]?.anim] ?? 0.05 });
      scene.add(actor);
      actors.push(rec);
      // hittable (core combat): capsules against the animated pose
      e.raycast = (o, d, maxT, part) => brain.raycast(e, o, d, maxT, part);
      e.onHit = (res) => brain.applyHit(e, e.lastCapsule || 'chest', res.damage, res.dir, res.shooter === ctx.player);
      ctx.combat.register(e);
    });

    // events → hearing, triggers, machines
    ctx.events.on('shot', (r) => {
      if (r.shooter !== ctx.player) return;
      brain.noise(r.origin.x, r.origin.y, r.origin.z, 60, 'shot', null);
      // bullet impacts / whizz near an enemy reveal the shooter's direction
      brain.noise(r.point.x, r.point.y, r.point.z, 7, 'shot', null);
    });
    ctx.events.on('glass:break', (g) => { const p = g.point; if (p) brain.noise(p.x, p.y, p.z, 25, 'glass', null); });
    ctx.events.on('door:state', (d) => {
      if (doorByEnemy) return;
      const r = d.door, m = (r.a + r.b) / 2, ax = r.axis === 'x';
      const x = ax ? m : r.at, z = ax ? r.at : m;
      if (Math.hypot(ctx.player.pos.x - x, ctx.player.pos.z - z) < 4) brain.noise(x, r.y0 + 1, z, r.kind === 'roller' ? 22 : 9, 'door', null);
    });
    ctx.events.on('machine:state', (m) => masking.onMachine(m));
    // staged moments: the director (F) drives timing through ambush()/alert()/stage(); trigger boxes alone wake nobody
    api.reset();
    // place everything once (and visible) so the shader warm-up compiles skinned + instanced programs
    for (const r of actors) { r.dirty = true; poseActor(r, 0.016, true); r.actor.visible = true; }
    weaponMeshes.pistol.count = 1; blobs.count = 1; torches.count = 1;
    budget.initMs = performance.now() - t0;
  };

  function downscale(tex, size) {
    const img = tex?.image;
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 2;
    return t;
  }
  function tri(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }
  function mergeScene(s) {
    s.updateMatrixWorld(true);
    const parts = [];
    s.traverse((o) => {
      if (!o.isMesh) return;
      const g = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'color']) {
        const a = o.geometry.attributes[name]; if (!a) continue;
        const n = name === 'color' ? 3 : a.itemSize, arr = new Float32Array(a.count * n);
        for (let i = 0; i < a.count; i++) { arr[i * n] = a.getX(i); arr[i * n + 1] = a.getY(i); arr[i * n + 2] = a.getZ(i); }
        g.setAttribute(name, new THREE.BufferAttribute(arr, n));
      }
      if (!g.attributes.color) { const c = new Float32Array(g.attributes.position.count * 3).fill(0.25); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
      if (o.geometry.index) g.setIndex(Array.from(o.geometry.index.array));
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    });
    return mergeGeometries(parts, false);
  }

  // ---------------------------------------------------------------------------------------------------
  api.reset = () => {
    if (!brain) return;
    brain.reset();
    masking?.reset();
    for (const r of actors) {
      r.anim.reset(); r.anim.sync(r.e); r.dirty = true; r.adt = 0.5; r.frozenOnce = false; r.blob = null; r.dropM = null;
      r.actor.visible = false; r.lod0.visible = true; r.lod1.visible = false; r.lod2.visible = false; r.lodSel = 0;
    }
  };
  api.alert = (ids, pos) => brain?.alert(ids, pos);
  api.alive = () => api.list.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
  api.ambush = (ids, playerPos) => brain.ambush(ids, playerPos);
  api.stage = (id, behaviour, opts) => brain.stage(id, behaviour, opts ?? {});
  api.despawn = (id) => { brain.despawn(id); const r = actors.find((q) => q.e.id === id); if (r) r.actor.visible = false; };
  api.wake = (ids) => brain.wake(ids);
  api.spawn = (ids) => brain.spawn(ids);
  api.hold = (ids, on = true) => brain.setHold(ids, on);
  api.moveTo = (id, p, run = false) => brain.moveTo(id, p[0], p[1], p[2], run);
  api.say = (id, kind) => brain.say(id, kind);
  api.trigger = (momentId) => brain.trigger(momentId);
  api.group = (name) => api.list.filter((e) => e.def.group === name).map((e) => e.id);

  // ---------------------------------------------------------------------------------------------------
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _fr = new THREE.Frustum(), _sph = new THREE.Sphere();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  const order = new Int32Array(64), dist = new Float32Array(64);
  let pixState = 1;

  /** place the actor root from the brain and (optionally) advance the animation */
  function poseActor(r, dt, animate) {
    const e = r.e, a = r.actor;
    // lying on a bed / sofa: rotate + offset the root so the body's midpoint lies on the anchor
    let x = e.pos.x, y = e.pos.y, z = e.pos.z, ry = e.yaw + Math.PI;
    if (e.pose === 'lie' || e.dead && e.deathClip === 'sleep_death') {
      const lp = lib.pose.sleep_lying;
      if (lp) {
        ry = e.yaw + Math.PI - lp.axis;
        const mx = lp.mid[0] * r.vi.rs, mz = lp.mid[1] * r.vi.rs, c = Math.cos(ry), s = Math.sin(ry);
        x -= mx * c + mz * s; z -= -mx * s + mz * c;
      }
    }
    a.position.set(x, y, z); a.rotation.set(0, ry, 0);
    a.updateMatrix();
    if (animate && r.anim.update(e, dt)) { r.dirty = true; }
    else { updateActorWorld(a); r.dirty = true; }
  }

  api.update = (dt) => {
    if (!brain) return;
    const t0 = performance.now();
    const P = ctx.player, pl = api.env.player;
    const pix = ctx.settings.data.pixelateFaces === false ? 0 : 1;
    if (pix !== pixState) { pixState = pix; for (const r of actors) r.mat.uniforms.uPixelate.value = pix; }
    pl.crouched = P.crouched; pl.moving = P.moving; pl.dead = P.dead; pl.flashlight = P.flashlight;
    if (ctx.state === 'playing') brain.update(dt);
    const t1 = performance.now();
    // ---- visibility, distance, LOD under the triangle budget
    const cam = ctx.render.camera;
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_m);
    let nv = 0;
    for (let i = 0; i < actors.length; i++) {
      const r = actors[i], e = r.e;
      const lvl = e.active && !e.despawned ? ctx.lod.level(e.pos.x, e.pos.y, e.pos.z) : 3;
      e.lod = lvl;
      let vis = lvl < 3;
      if (vis) { _sph.center.set(e.pos.x, e.pos.y + 0.9, e.pos.z); _sph.radius = e.dead || e.pose === 'lie' ? 1.6 : 1.1; vis = _fr.intersectsSphere(_sph); }
      r.vis = vis;
      r.adt += dt;
      if (vis) {
        const d = ctx.lod.dist(e.pos.x, e.pos.y + 1, e.pos.z);
        let k = nv++;
        while (k > 0 && dist[k - 1] > d) { dist[k] = dist[k - 1]; order[k] = order[k - 1]; k--; }
        dist[k] = d; order[k] = i;
      }
    }
    // weapons + blobs + everyone at LOD2 first, then upgrades nearest-first while D's triangle budget allows
    // (LOD0 < 15 m, at most 3; LOD1 < 32 m; hysteresis against popping)
    let tris = 0;
    for (let k = 0; k < nv; k++) { const r = actors[order[k]]; tris += r.vi.tris2 + 2; if (r.e.weaponOut && r.e.armed && !r.e.dead) tris += weaponMeshes[r.wModel].userData.tris; }
    for (let i = 0; i < actors.length; i++) { const e = actors[i].e; if (e.weaponDropped && e.lod < 3) tris += weaponMeshes[actors[i].wModel].userData.tris; }
    const triBudget = BUDGETS.D.triangles;
    let lod0n = 0;
    for (let k = 0; k < nv; k++) {
      const r = actors[order[k]], d = dist[k];
      let want = d < (r.lodSel === 0 ? 16.5 : 15) && lod0n < 3 ? 0 : d < (r.lodSel <= 1 ? 34 : 32) ? 1 : 2;
      if (want === 0 && tris + r.vi.tris0 - r.vi.tris2 > triBudget) want = 1;
      if (want === 1 && tris + r.vi.tris1 - r.vi.tris2 > triBudget) want = 2;
      if (want === 0) { tris += r.vi.tris0 - r.vi.tris2; lod0n++; } else if (want === 1) tris += r.vi.tris1 - r.vi.tris2;
      if (want !== r.lodSel) { r.lodSel = want; r.lod0.visible = want === 0; r.lod1.visible = want === 1; r.lod2.visible = want === 2; }
    }    // ---- animation (visible only, throttled by distance; frozen bodies never) + placement
    let animated = 0;
    for (let i = 0; i < actors.length; i++) {
      const r = actors[i], e = r.e;
      r.actor.visible = r.vis;
      if (!r.vis) continue;
      if (!r.everVisible) { r.everVisible = true; r.adt = Math.max(r.adt, 0.05); }
      const frozen = r.anim.frozen;
      if (frozen) { if (!r.frozenOnce) finalizeBody(r); continue; }
      const step = ctx.lod.animStep(i, e.lod) || e.dead && r.adt > 0.25;
      if (!step) continue;
      // aim pitch toward the player's chest while aiming
      if (e.aiming) {
        const dx = P.pos.x - e.pos.x, dz = P.pos.z - e.pos.z;
        e.aimPitch = Math.max(-0.7, Math.min(0.7, Math.atan2(P.pos.y + 1.2 - (e.pos.y + (e.crouch ? 1.0 : 1.42)), Math.sqrt(dx * dx + dz * dz))));
      } else e.aimPitch = 0;
      const adt = e.dead ? r.adt : Math.min(r.adt, 0.25);
      r.adt = 0;
      poseActor(r, adt, true);
      if (!e.dead) r.anim.capsules(e);
      animated++;
    }
    // ---- privacy mosaic: the nearest visible heads with a clear line of sight → composite ellipses (source uv)
    nvLast = nv; faceMosaic(pix);
    // ---- instanced weapons and blobs for the visible set
    for (const m of wmList) m.count = 0;
    let nb = 0, nt = 0;
    for (let k = 0; k < nv; k++) {
      const r = actors[order[k]], e = r.e;
      if (e.weaponOut && e.armed && !e.dead) {
        const wm = weaponMeshes[r.wModel];
        _m2.multiplyMatrices(r.hand.matrixWorld, r.wOff);
        wm.setMatrixAt(wm.count++, _m2);
        if (e.flashlight && nt < 8) { _m2.multiply(r.tOff); torches.setMatrixAt(nt++, _m2); }
      }
      // blob
      if (r.blob) { _m2.compose(_p.set(r.blob.x, r.blob.y, r.blob.z), _q.setFromEuler(_e.set(0, r.blob.yaw, 0)), _s.set(r.blob.w, 1, r.blob.l)); }
      else {
        const lie = e.pose === 'lie' || e.pose === 'sit';
        const w = lie ? 0.9 : e.crouch || e.pose === 'kneel' ? 1.0 : 0.85;
        _m2.compose(_p.set(r.actor.position.x, e.pos.y + 0.012, r.actor.position.z), _q.setFromEuler(_e.set(0, e.yaw, 0)), _s.set(w, 1, lie ? 1.9 : w));
        if (e.pose === 'lie') _m2.compose(_p.set(e.pos.x, e.pos.y + 0.012, e.pos.z), _q.setFromEuler(_e.set(0, e.yaw, 0)), _s.set(0.8, 1, 2.0));
      }
      blobs.setMatrixAt(nb++, _m2);
    }
    // dropped weapons (visible anywhere in the PVS; static matrices)
    for (let i = 0; i < actors.length; i++) {
      const r = actors[i], e = r.e;
      if (!e.weaponDropped || e.lod === 3) continue;
      if (!r.dropM) {
        const g = ctx.world.groundHeight(e.dropX, e.dropZ, e.pos.y + 0.6, 0.1);
        r.dropM = new THREE.Matrix4().compose(_p.set(e.dropX - Math.sin(e.dropYaw) * 0.45, (g > -Infinity ? g : e.pos.y) + 0.035, e.dropZ - Math.cos(e.dropYaw) * 0.45),
          _q.setFromEuler(_e.set(0, e.dropYaw, Math.PI / 2, 'YXZ')), _s.set(1, 1, 1));
      }
      const wm = weaponMeshes[r.wModel];
      if (wm.count < 32) wm.setMatrixAt(wm.count++, r.dropM);
    }
    let draws = 0, wt = 0;
    for (const m of wmList) { m.visible = m.count > 0; m.instanceMatrix.needsUpdate = m.count > 0; if (m.count) { draws++; wt += m.count * m.userData.tris; } }
    blobs.count = nb; blobs.visible = nb > 0; blobs.instanceMatrix.needsUpdate = nb > 0;
    torches.count = nt; torches.visible = nt > 0; torches.instanceMatrix.needsUpdate = nt > 0;
    if (nt) draws++;
    if (nb) draws++;
    let ct = 0; for (let k = 0; k < nv; k++) { const r = actors[order[k]]; ct += r.lodSel === 0 ? r.vi.tris0 : r.lodSel === 1 ? r.vi.tris1 : r.vi.tris2; }
    budget.visible = nv; budget.lod0 = lod0n; budget.lod2 = 0; for (let k = 0; k < nv; k++) if (actors[order[k]].lodSel === 2) budget.lod2++; budget.draws = draws + nv; budget.tris = ct + wt + nb * 2; budget.animated = animated;
    budget.aiMs = t1 - t0; budget.cpuMs = performance.now() - t0;
  };

  // head (bone origin at the skull base) → face centre ≈ 9 cm above; ellipse radius 0.2 m (whole head + hair)
  const _eye = new THREE.Vector3(), _hp = new THREE.Vector3();
  const _losA = { x: 0, y: 0, z: 0 }, _losB = { x: 0, y: 0, z: 0 };
  const FACE_R = 0.2, FACE_MAX_D = 40;
  function faceMosaic(pix) {
    const cu = ctx.render.composite?.uniforms;
    if (!cu?.uFaces) return;
    let n = 0;
    if (pix && ctx.state !== 'loading') {
      const cam = ctx.render.camera;
      cam.updateMatrixWorld();
      _eye.setFromMatrixPosition(cam.matrixWorld);
      const tanV = Math.tan(cam.fov * Math.PI / 360);
      for (let k = 0; k < nvLast && n < cu.uFaces.value.length; k++) {
        const r = actors[order[k]];
        const hm = r.anim.B?.head?.matrixWorld; if (!hm) continue;
        _hp.set(hm.elements[12], hm.elements[13] + 0.09, hm.elements[14]);
        const d = _hp.distanceTo(_eye);
        if (d > FACE_MAX_D) break;
        _losA.x = _eye.x; _losA.y = _eye.y; _losA.z = _eye.z; _losB.x = _hp.x; _losB.y = _hp.y; _losB.z = _hp.z;
        if (!ctx.world.lineOfSight(_losA, _losB)) continue;    // behind a wall / closed door: nothing to hide
        _hp.project(cam);
        if (_hp.z > 1 || Math.abs(_hp.x) > 1.3 || Math.abs(_hp.y) > 1.3) continue;
        // radius in source uv (0..1 of the frame height); generous for motion between pose updates
        const ry = Math.min(0.25, (FACE_R / Math.max(0.3, d)) / tanV * 0.5 * 1.15);
        cu.uFaces.value[n++].set(_hp.x * 0.5 + 0.5, _hp.y * 0.5 + 0.5, ry / cam.aspect, ry);
      }
    }
    cu.uFaceN.value = n;
  }
  let nvLast = 0;

  /** last pose of a body: blob along the body, no more skinning */
  function finalizeBody(r) {
    r.frozenOnce = true;
    const B = r.anim.B, h = B.head.getWorldPosition(_p).clone(), pv = B.pelvis.getWorldPosition(_s).clone();
    const fx = (h.x + pv.x) / 2 * 0.6 + pv.x * 0.4, fz = (h.z + pv.z) / 2 * 0.6 + pv.z * 0.4;
    const len = Math.hypot(h.x - pv.x, h.z - pv.z);
    r.blob = { x: fx, y: r.e.pos.y + 0.012, z: fz, yaw: Math.atan2(h.x - pv.x, h.z - pv.z), w: 0.85, l: Math.max(1.0, len * 2.4) };
  }

  return api;
}

// probe luminance that counts as "fully lit" for the vision model (calibrated in the lit level)
const LIGHT_REF = 0.16;   // packing area ≈ 0.33, lit hall ≈ 0.4–0.6, dark aisles ≈ 0.04, lights out ≈ 0
