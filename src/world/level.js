// World module entry: builds the factory site (geometry, materials, lights, sky, fog) and returns the level API
// described in CONTRACT.md. Pure layout data lives in layout.js / nav.js (importable in Node).
import * as THREE from 'three';
import {
  buildLayout, groundHeight as groundAt, floorMatAt, GROUND, BOUNDS, PLAYER_SPAWN, ENEMY_SPAWNS, EXTRACTION, WORK_LAMP,
  FLOORS, HOLES, H, EVENTS, WATER, ZONES, insideBuilding,
} from './layout.js';
import { computeWorldData } from './nav.js';
import { loadMaterials, makeCanvas } from './materials.js';
import { Batcher, makeGrime, groundGrid, rng } from './geometry.js';
import { buildProps, buildInstanced } from './props.js';
import { buildDecals, resetGlass } from './decals.js';
import { setupLighting, loadSky, linColor, SUN, SUN_DIR, LAMP, SKY_GAIN } from './lighting.js';
import { installLightPatch, adoptScene, setVolume, LP } from './lightShader.js';
import { bakeIrradianceVolume, skyTable } from './lightGI.js';
import { createReflectionProbes } from './lightProbes.js';
import { createStaticSun, excludeFromSunCascade, excludeFromShadowCamera, isStatic } from './lightSun.js';
import { createZoneCuller, clusterProxies } from './zoneCull.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const NO_CAST = new Set(['floor', 'lino', 'asphalt']);
// Distant silhouettes beyond the fences (drawn below, also occluders for the light bake).
const SILHOUETTES = [
  { min: [-48, 0, 6], max: [-34, 13, 42], mat: 'brick' },
  { min: [54, 0, -40], max: [68, 9, 20], mat: 'corrugatedOut' },
  { min: [-26, 0, 44], max: [30, 7, 56], mat: 'brick' },
  { min: [-40, 0, -76], max: [30, 10, -64], mat: 'corrugatedOut' },
  { min: [-33.6, 0, -31.6], max: [-30.4, 32, -28.4], mat: 'brick' },
];
const LEVEL_YS = [0, H.base, ...FLOORS.map((f) => f.y)];

function screenMaterial() {
  const c = makeCanvas(256, 128), g = c.getContext('2d');
  g.fillStyle = '#020604'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#6fe0a0'; g.font = '12px monospace';
  const R = rng(77);
  for (let y = 12; y < 128; y += 14) {
    let s = '';
    for (let i = 0; i < 30; i++) s += R() < 0.18 ? ' ' : String.fromCharCode(48 + Math.floor(R() * 42));
    g.globalAlpha = 0.4 + R() * 0.6; g.fillText(s, 6, y);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ color: 0x050805, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 1.4, roughness: 0.25, vertexColors: true });
}

export async function createLevel(ctx, onProgress = () => {}) {
  const { scene, renderer } = ctx;
  const tLoad = performance.now();
  const progress = (p, label) => { try { onProgress(Math.min(1, Math.max(0, p)), label); } catch { /* ui not ready */ } };
  // let the loading screen paint between the long synchronous build steps (it must never look frozen)
  const tick = () => new Promise((r) => setTimeout(r, 0));
  progress(0.01, 'Gelände');

  // ---------------------------------------------------------------- pure data
  const layout = buildLayout();
  const tNav = performance.now();
  const world = computeWorldData(layout);
  const navMs = performance.now() - tNav;
  if (world.graph.components.count > 1) {
    console.warn(`[world] nav graph is disconnected: ${world.graph.components.count} components`);
  }

  // ---------------------------------------------------------------- sky + light bake (runs in workers while textures load)
  installLightPatch();
  const matsP = loadMaterials(renderer, (p) => progress(0.03 + p * 0.55, 'Texturen'));
  const sky = await loadSky(renderer, scene);
  const lampDir = new THREE.Vector3(...WORK_LAMP.target).sub(new THREE.Vector3(...WORK_LAMP.pos)).normalize();
  const giP = bakeIrradianceVolume({
    layout, extra: SILHOUETTES, sky: skyTable(sky.bg, SKY_GAIN), rays: 20,
    sun: { dir: SUN_DIR.clone().negate().toArray(), color: linColor(SUN.color, SUN.intensity) },
    lamp: { pos: WORK_LAMP.pos, dir: lampDir.toArray(), angle: LAMP.angle, penumbra: LAMP.penumbra, range: LAMP.range, color: linColor(LAMP.color, LAMP.intensity) },
  }).catch((e) => { console.warn('[light] irradiance bake failed:', e); return null; });

  // ---------------------------------------------------------------- materials
  const lib = await matsP;
  const tMats = performance.now();
  if (lib.missing.length) console.warn('[world] procedural fallback for:', lib.missing.join(', '));
  lib.mats.screen = screenMaterial();
  lib.scales.screen = 0.5; lib.surfaces.screen = 'metal';
  progress(0.6, 'Gebäude'); await tick();

  // ---------------------------------------------------------------- floor AO (distance to things standing on a floor)
  const aoBoxes = layout.solids.filter((s) => s.max[1] - s.min[1] > 0.3 && s.kind !== 'floor' && s.kind !== 'roof' && LEVEL_YS.some((l) => Math.abs(s.min[1] - l) < 0.3));
  const floorAO = (x, z, y) => {
    if (!LEVEL_YS.some((l) => Math.abs(y - l) < 0.06)) return 1;
    let d = 9;
    for (const b of aoBoxes) {
      if (Math.abs(b.min[1] - y) > 0.3) continue;
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
      const dd = Math.hypot(dx, dz);
      if (dd < d) d = dd;
    }
    const t = Math.min(1, d / 1.1);
    return 0.42 + 0.58 * t * t * (3 - 2 * t);
  };
  const B = new Batcher(lib.scales, makeGrime({ floorAO }));

  // ---------------------------------------------------------------- static geometry
  for (const s of layout.solids) if (s.visual) B.box(s.min, s.max, s.mat, { base: s.min[1], skip: s.skip });
  groundGrid(B, GROUND.min, GROUND.max, 0, floorMatAt, 1);
  const inst = buildProps(B, layout, 7);
  for (const b of SILHOUETTES.slice(0, 4)) {
    const k = b.mat;
    B.box(b.min, b.max, { px: k, nx: k, pz: k, nz: k, py: 'concreteOut', ny: k === 'brick' ? 'brick' : 'concreteOut' });
  }
  B.cylinder('brick', [-32, 0, -30], 1.6, 32, { segs: 20 });   // chimney (bake occluder: SILHOUETTES[4])
  B.cylinder('concreteOut', [42.4, 0, 35.8], 0.12, 6.5, { segs: 8 });     // dead street lamp by the gate
  B.box([41.8, 6.3, 35.7], [42.5, 6.45, 35.9], 'steel');

  const culler = createZoneCuller(layout);
  const staticGroup = new THREE.Group(); staticGroup.name = 'static'; staticGroup.userData.static = true;
  for (const g of culler.groups) staticGroup.add(g);
  const tSplit = performance.now();
  let nParts = 0;
  for (const [key, geo] of B.build()) {
    const mat = lib.mats[key] || lib.mats.ceiling;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'static:' + key;
    mesh.castShadow = !NO_CAST.has(key);
    mesh.receiveShadow = true;
    mesh.userData.surface = lib.surfaces[key] || 'concrete';
    mesh.matrixAutoUpdate = false;
    nParts += culler.addSplit(mesh);
  }
  const lateRoots = [];
  for (const m of buildInstanced(inst, lib.mats, lib.scales)) {
    if (m.isGroup) { lateRoots.push(m); continue; }   // the async Poly Haven model layer, split when it arrives
    nParts += culler.addSplit(m);
  }
  scene.add(staticGroup);
  const splitMs = performance.now() - tSplit;
  progress(0.78, 'Details'); await tick();

  // ---------------------------------------------------------------- decals
  const R = rng(31);
  const floorSpots = [];
  const SPOT_AREAS = [[-23, 19, -17, 15, 80], [20.5, 43, -17, 15, 50], [1, 43, -51, -35, 50], [-23, 43, -33, -19, 40], [-23, -1, -51, -35, 20], [-23, 43, 16.5, 29.5, 40]];
  for (const [x0, x1, z0, z1, n] of SPOT_AREAS) for (let i = 0; i < n; i++) floorSpots.push([x0 + R() * (x1 - x0), z0 + R() * (z1 - z0), 0.8 + R() * 2.4, R() < 0.75 ? 0 : (insideBuilding(x0, z0) ? 3 : 1)]);
  for (const [x, z] of [[-7.0, 4.2], [-0.2, 4.5], [3.4, 12.4], [-8.1, -10.6], [-6.5, -9.0], [4.6, -0.6], [-12.0, 12.2], [26.0, 9.2], [33.0, -14.0], [26.6, -36.8], [-7.4, -38.0], [31.0, 0.6]]) floorSpots.push([x, z, 1.0 + R() * 1.2, 1]);
  const puddles = [[-12.5, 5.5, 3.0], [-2.0, -2.0, 2.0], [-8.0, -12.0, 2.8], [8.6, -12.4, 2.2], [-2.0, 19.0, 3.2], [8.0, 23.8, 2.4],
    [-18.0, 23.0, 2.0], [11.5, 17.2, 1.6], [9.4, 4.2, 1.0], [12.6, 2.0, 1.1], [-20.5, -15.0, 1.8], [-15.5, 9.5, 1.4],
    [28.6, -4.8, 2.0], [35.0, 7.6, 2.4], [24.0, 26.0, 2.6], [38.0, 20.0, 2.0], [10.0, -24.0, 3.0], [30.0, -30.0, 2.6], [-10.0, -30.0, 2.4],
    [-16.0, -42.0, 3.0], [-4.0, -48.0, 2.0], [11.6, -44.6, 1.6], [29.6, -40.4, 1.4]];
  const wallSoot = [[[-8.0, 5.6, 15.58], '-z', 5.0, 3.0], [[4.2, 2.5, 15.58], '-z', 2.5, 2.2], [[-23.58, 3.0, -10.0], '+x', 4.0, 3.0],
    [[38.5, 5.0, -12.6], '+z', 3.0, 5.0], [[43.58, 3.0, 4.0], '-x', 4.0, 3.0], [[20.02, 2.0, 8.0], '+x', 3.0, 2.4]];
  const decals = buildDecals(scene, layout, { floorSpots, puddles, wallSoot, extraction: EXTRACTION });
  for (const m of decals.meshes) {
    if (m.name === 'glass') continue;   // per-pane vertex attribute updates: kept as one mesh
    scene.remove(m);
    culler.addSplit(m);
  }

  // ---------------------------------------------------------------- water (flooded basement sections)
  {
    const wmat = new THREE.MeshStandardMaterial({ color: 0x0b0d0c, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.86, depthWrite: false, envMapIntensity: 1.0 });
    wmat.name = 'water';
    for (const w of WATER) {
      const g = new THREE.PlaneGeometry(w.max[0] - w.min[0], w.max[1] - w.min[1], 8, 8).rotateX(-Math.PI / 2);
      const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) pa.setY(i, Math.sin(pa.getX(i) * 2.1) * Math.cos(pa.getZ(i) * 1.7) * 0.004);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, wmat);
      m.position.set((w.min[0] + w.max[0]) / 2, w.y, (w.min[1] + w.max[1]) / 2);
      m.name = 'water'; m.renderOrder = 2; m.receiveShadow = true; m.userData.surface = 'concrete';
      m.updateMatrix(); m.matrixAutoUpdate = false;
      culler.addAt(m, m.position);
    }
  }

  // ---------------------------------------------------------------- lights, sky, fog
  progress(0.82, 'Licht'); await tick();
  const lighting = await setupLighting(ctx, layout, { sky, culler });
  const staticSun = createStaticSun(renderer, {
    dirTravel: SUN_DIR, center: new THREE.Vector3(10, 0, -10), halfX: 56, halfY: 56,
    size: (renderer.capabilities.maxTextureSize || 4096) >= 8192 ? 4096 : 2048,
  });
  const probes = createReflectionProbes(renderer);
  progress(0.86, 'Indirektes Licht');
  const gi = await giP;
  if (gi) {
    setVolume(gi);
    scene.environment = null;
    console.info(`[light] irradiance volume baked in ${gi.ms.toFixed(0)} ms on ${gi.workers} workers; waited ${(performance.now() - tMats).toFixed(0)} ms after textures (${gi.timings})`);
  }
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let staticSig = '';
  // Re-renders everything that depends on static geometry: static sun shadow, lamp shadow, reflection probes.
  function refreshStaticLighting() {
    const t0 = performance.now();
    culler.showAll();
    adoptScene(scene);
    const hide = [];
    let nStatic = 0;
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (isStatic(o, ctx.camera) && !o.userData.dynamic) {
        nStatic++;
        if (o.isMesh && o.castShadow) {
          excludeFromSunCascade(o, lighting.sun.shadow.camera);
          // the work lamp's shadow only needs the static geometry of its own room
          let p = o, z = -1;
          while (p) { if (p.userData?.zone !== undefined) { z = p.userData.zone; break; } p = p.parent; }
          if (z !== lighting.lampZone) excludeFromShadowCamera(o, lighting.spot.shadow.camera);
        }
      } else if (o.visible) hide.push(o);
    });
    staticSig = signature();
    const casters = staticSun.render(scene, ctx.camera);
    const ms = probes.capture(scene, { hide, normAt: gi ? (x, y, z) => lum(gi.sample(x, y, z)) : null, culler });
    culler.showAll();
    console.info(`[light] static lighting refreshed: ${casters} sun casters, ${nStatic} static objects, probes ${ms.toFixed(0)} ms, total ${(performance.now() - t0).toFixed(0)} ms`);
  }
  function signature() {
    let n = 0, v = 0;
    scene.traverse((o) => { if (o.isMesh && isStatic(o, ctx.camera)) { n++; v += o.geometry?.id || 0; } });
    return n + ':' + v;
  }

  // ---------------------------------------------------------------- collision + raycast proxies
  progress(0.9, 'Kollision'); await tick();
  const colliders = world.colliders.map((c) => new THREE.Box3(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max)));
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const proxies = [];
  const addProxy = (min, max, surface) => {
    const m = new THREE.Mesh(unit, proxyMat);
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.scale.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    m.userData.surface = surface;
    m.updateMatrixWorld(true);
    proxies.push(m);
    return m;
  };
  for (const s of layout.solids) if (s.ray) addProxy(s.min, s.max, s.surface);
  // ground: one slab per strip between the floor openings (stair shafts and pits)
  {
    const xs = [...new Set([GROUND.min[0], GROUND.max[0], ...HOLES.flatMap((h) => [h.x0, h.x1])])].sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i], b = xs[i + 1];
      const cut = HOLES.filter((h) => h.x0 <= a + 1e-6 && h.x1 >= b - 1e-6).map((h) => [h.z0, h.z1]).sort((p, q) => p[0] - q[0]);
      let c = GROUND.min[1];
      for (const [s, e] of cut) { if (s > c) addProxy([a, -0.4, c], [b, 0, s], 'concrete'); c = Math.max(c, e); }
      if (c < GROUND.max[1]) addProxy([a, -0.4, c], [b, 0, GROUND.max[1]], 'concrete');
    }
    for (const f of FLOORS) if (f.y < -0.5) addProxy([f.x0, f.y - 0.4, f.z0], [f.x1, f.y, f.z1], 'concrete');
  }
  const doorRoot = new THREE.Group(); doorRoot.name = 'door-proxies';
  const raycastMeshes = [...clusterProxies(proxies), doorRoot];

  // ---------------------------------------------------------------- animated doors (closed / ajar / swinging in the wind)
  const doors = [];
  {
    const leafMat = lib.mats.rust;
    const frameMat = lib.mats.steel;
    for (const d of layout.doors) {
      if (!d.dyn) continue;
      const w = d.leafW, y0 = d.y || 0, hgt = 2.08, th = 0.05;
      const hingeA = d.leaf === 'left' ? d.a[0] : d.a[1];
      const ins = d.swing ?? -1;
      const tFace = ins > 0 ? d.t1 - 0.03 : d.t0 + 0.03;    // closed leaf sits in the reveal on its swing side
      const pivot = new THREE.Group();
      if (d.axis === 'x') pivot.position.set(hingeA, y0, tFace); else pivot.position.set(tFace, y0, hingeA);
      // local +x points from the hinge to the far jamb when closed
      const closedDir = d.axis === 'x' ? new THREE.Vector3(d.leaf === 'left' ? 1 : -1, 0, 0) : new THREE.Vector3(0, 0, d.leaf === 'left' ? 1 : -1);
      const openDir = d.axis === 'x' ? new THREE.Vector3(0, 0, ins) : new THREE.Vector3(ins, 0, 0);
      const ang = (v) => Math.atan2(-v.z, v.x);
      let aC = ang(closedDir), aO = ang(openDir);
      if (aO - aC > Math.PI) aO -= Math.PI * 2; if (aC - aO > Math.PI) aO += Math.PI * 2;
      // leaf, kick plate and handles in one geometry (one draw call per door)
      const parts = [new THREE.BoxGeometry(w, hgt, th).translate(w / 2, hgt / 2 + 0.02, 0),
        new THREE.BoxGeometry(w * 0.7, 0.2, th + 0.012).translate(w / 2, 0.14, 0),
        new THREE.BoxGeometry(0.14, 0.025, th + 0.1).translate(w - 0.12, 1.0, 0),
        new THREE.BoxGeometry(0.025, 0.06, th + 0.03).translate(w - 0.06, 1.0, 0)];
      const leafGeo = mergeGeometries(parts);
      leafGeo.computeBoundingSphere();
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.castShadow = true; leaf.receiveShadow = true; leaf.userData.surface = 'metal';
      void frameMat;
      pivot.add(leaf);
      pivot.userData.dynamic = true;
      const proxy = new THREE.Mesh(unit, proxyMat);
      proxy.scale.set(w, hgt, th + 0.02); proxy.position.set(w / 2, hgt / 2 + 0.02, 0);
      proxy.userData.surface = 'metal';
      const proxyPivot = new THREE.Group(); proxyPivot.position.copy(pivot.position); proxyPivot.add(proxy);
      doorRoot.add(proxyPivot);
      const start = d.state === 'ajar' ? 0.32 : d.state === 'wind' ? 0.45 : 0;
      const door = { d, pivot, proxyPivot, aC, aO, t: start, t0: start, target: start, wind: d.state === 'wind', phase: Math.random() * 10, lastV: 0,
        center: new THREE.Vector3(d.center[0], y0 + 1.0, d.center[1]) };
      proxy.userData.door = door;
      leaf.userData.door = door;
      doors.push(door);
      culler.addAt(pivot, door.center);
    }
  }
  const setDoor = (door) => {
    const a = door.aC + (door.aO - door.aC) * door.t;
    door.pivot.rotation.y = a; door.proxyPivot.rotation.y = a;
    door.proxyPivot.updateMatrixWorld(true);
  };
  doors.forEach(setDoor);
  const openDoor = (door, fast = false) => { if (!door.wind && door.target < 1) { door.target = 1; door.fast = fast; } };

  progress(0.93, 'Reflexionen'); await tick();
  refreshStaticLighting();

  // ---------------------------------------------------------------- gameplay data
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const enemySpawns = ENEMY_SPAWNS.map((e) => ({
    position: v(e.position), yaw: e.yaw, type: e.type, name: e.name, role: e.role,
    asleep: !!e.asleep, startDelay: e.startDelay || 0,
    ...(e.patrol ? { patrol: e.patrol.map(v) } : {}),
  }));
  const navGraph = { nodes: world.graph.nodes.map(v), edges: world.graph.edges.map((e) => [e[0], e[1]]) };
  const coverPoints = world.cover.map(v);
  const extraction = new THREE.Box3(v(EXTRACTION.min), v(EXTRACTION.max));
  const bounds = new THREE.Box3(v(BOUNDS.min), v(BOUNDS.max));

  function surfaceOf(obj) {
    let o = obj;
    while (o) {
      if (o.userData?.door) openDoor(o.userData.door, true);   // a shot (or anything) hitting a door bangs it open
      if (o.userData && o.userData.surface) return o.userData.surface;
      o = o.parent;
    }
    return 'concrete';
  }
  // Stacked floors: refY is the caller's current feet height. Two-argument callers get the floor at the player's
  // height (the player is the main unqualified caller), or the ground floor before the player exists.
  function groundHeight(x, z, refY) {
    if (refY === undefined) refY = ctx.player?.position ? ctx.player.position.y : 0;
    return groundAt(x, z, refY);
  }

  // ---------------------------------------------------------------- set pieces: radios, phone, door triggers
  const events = EVENTS.map((e) => ({ ...e, t: e.every[0] * Math.random(), left: 0 }));
  const vEv = new THREE.Vector3();
  let scanT = 0, sinceLoad = 0, pendingSig = '', autoRefreshes = 0, lastFirst = null, time = 0;
  const cullDynamic = true;
  function resetWorldState() {
    for (const d of doors) { d.t = d.target = d.t0; setDoor(d); }
    try { resetGlass(); } catch { /* optional */ }
    for (const e of events) { e.t = e.every[0] * Math.random(); e.left = 0; }
  }
  function updateDoors(dt) {
    const P = ctx.player?.position;
    const list = ctx.enemies?.list || [];
    for (const d of doors) {
      if (d.wind) {
        const gust = 0.5 + 0.5 * Math.sin(time * 0.37 + d.phase) * Math.sin(time * 0.11 + 1.3);
        const tt = 0.42 + 0.3 * gust * Math.sin(time * 1.3 + Math.sin(time * 0.7) * 2.0);
        const vel = (tt - d.t) / Math.max(dt, 1e-3);
        if (d.lastV < -0.05 && vel >= 0 && d.t < 0.25 && time > 2 && P && P.distanceTo(d.center) < 30) {
          ctx.audio?.play?.('impact_wood', { position: d.center.clone(), volume: 0.25 + 0.2 * gust });
        }
        d.lastV = vel; d.t = tt; setDoor(d);
        continue;
      }
      if (d.target < 1) {
        let near = P && Math.abs(P.y - d.center.y + 1) < 1.6 && Math.hypot(P.x - d.center.x, P.z - d.center.z) < 1.75;
        for (const e of list) if (!near && e.alive && Math.abs(e.position.y - d.center.y + 1) < 1.6 && Math.hypot(e.position.x - d.center.x, e.position.z - d.center.z) < 1.5) near = true;
        if (near) openDoor(d);
      }
      if (d.t !== d.target) {
        const k = d.fast ? 5.5 : 2.6;
        d.t = Math.min(d.target, d.t + dt * k * (0.35 + 0.65 * (1 - d.t)));
        if (d.t > 0.999) d.t = d.target;
        setDoor(d);
      }
    }
  }
  function updateEvents(dt) {
    const P = ctx.player?.position;
    if (!P) return;
    for (const e of events) {
      vEv.set(e.pos[0], e.pos[1], e.pos[2]);
      if (P.distanceTo(vEv) > e.range) continue;
      e.t -= dt;
      if (e.t > 0) continue;
      if (e.kind === 'phone') {
        // a desk phone rings in bursts until the player has been close once
        if (e.left <= 0 && !e.done) e.left = e.burst ?? 8;
        if (e.left > 0) {
          ctx.audio?.play?.('phone_ring', { position: vEv.clone(), volume: 0.7 });
          e.left--; e.t = 4.0;
          if (P.distanceTo(vEv) < 3) e.done = true;
          if (e.left <= 0) e.t = 25 + Math.random() * 20;
        }
      } else {
        ctx.audio?.play?.('radio', { position: vEv.clone(), volume: 0.55 });
        e.t = e.every[0] + Math.random() * (e.every[1] - e.every[0]);
      }
    }
  }
  function cullEnemies() {
    if (!cullDynamic) return;
    for (const e of ctx.enemies?.list || []) {
      const root = e.ch?.root;
      if (!root) continue;
      const p = e.position;
      root.visible = culler.isVisible(p.x, p.y, p.z);
    }
  }

  progress(1, 'Bereit');
  console.info(`[world] level built in ${(performance.now() - tLoad).toFixed(0)} ms (nav ${navMs.toFixed(0)} ms, ${world.graph.nodes.length} nodes; zone split ${splitMs.toFixed(0)} ms into ${nParts} meshes over ${ZONES.length} zones)`);
  return {
    colliders,
    raycastMeshes,
    surfaceOf,
    groundHeight,
    playerSpawn: { position: v(PLAYER_SPAWN.position), yaw: PLAYER_SPAWN.yaw },
    enemySpawns,
    navGraph,
    coverPoints,
    extraction,
    bounds,
    update(dt) {
      time += dt;
      // mission restart (enemies respawned): close the doors again, restore the glass
      const first = ctx.enemies?.list?.[0] || null;
      if (first !== lastFirst) {
        if (lastFirst) resetWorldState();
        lastFirst = first;
      }
      updateDoors(dt);
      if (ctx.game?.state === 'playing') updateEvents(dt);
      if (ctx.camera) culler.update(ctx.camera);
      cullEnemies();
      lighting.update(dt);
      // pick up materials created later with their own onBeforeCompile, and late static props
      scanT += dt;
      if (scanT > 1.0) {
        scanT = 0;
        for (const root of lateRoots) {
          if (!root.children.length) continue;
          for (const m of [...root.children]) { root.remove(m); culler.addSplit(m); }
        }
        const nAdopt = adoptScene(scene);
        if (nAdopt) console.info(`[light] patched ${nAdopt} late material(s)`);
        if (sinceLoad < 60 && autoRefreshes < 3) {
          const sig = signature();
          if (sig !== staticSig) {
            if (sig === pendingSig) { console.info('[light] static geometry changed (' + staticSig + ' -> ' + sig + ')'); autoRefreshes++; refreshStaticLighting(); }
            pendingSig = sig;
          } else pendingSig = '';
        }
      }
      sinceLoad += dt;
    },
    refreshStaticLighting,
    // extras (not in contract)
    sun: lighting.sun,
    lighting, gi, probes, staticSun, lightUniforms: LP, culler, doors,
    layout,
    zoneAt: (p) => culler.zoneOf(p.x, p.y + 0.5, p.z),
    isVisible: (p) => culler.isVisible(p.x, p.y, p.z),
  };
}
