// World module entry: builds the abandoned factory (geometry, materials, lights, sky, fog) and returns the
// level API described in CONTRACT.md. Pure layout data lives in layout.js / nav.js (importable in Node).
import * as THREE from 'three';
import {
  buildLayout, groundHeight, floorMatAt, GROUND, BOUNDS, PLAYER_SPAWN, ENEMY_SPAWNS, EXTRACTION,
} from './layout.js';
import { computeWorldData } from './nav.js';
import { loadMaterials, makeCanvas } from './materials.js';
import { Batcher, makeGrime, groundGrid, rng } from './geometry.js';
import { buildProps, buildInstanced } from './props.js';
import { buildDecals } from './decals.js';
import { setupLighting } from './lighting.js';

const NO_CAST = new Set(['floor', 'lino', 'asphalt']);

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
  const progress = (p, label) => { try { onProgress(Math.min(1, Math.max(0, p)), label); } catch { /* ui not ready */ } };
  progress(0.01, 'Lade Gelände');

  // ---------------------------------------------------------------- pure data
  const layout = buildLayout();
  const world = computeWorldData(layout);
  if (world.graph.components.count > 1) {
    console.warn(`[world] nav graph is disconnected: ${world.graph.components.count} components`);
  }

  // ---------------------------------------------------------------- materials
  const lib = await loadMaterials(renderer, (p) => progress(0.03 + p * 0.62, 'Lade Texturen'));
  if (lib.missing.length) console.warn('[world] procedural fallback for:', lib.missing.join(', '));
  lib.mats.screen = screenMaterial();
  lib.scales.screen = 0.5; lib.surfaces.screen = 'metal';
  progress(0.66, 'Baue Halle');

  // ---------------------------------------------------------------- floor AO (distance to things standing on the floor)
  const aoBoxes = layout.solids.filter((s) => s.min[1] < 0.3 && s.max[1] - s.min[1] > 0.3 && s.kind !== 'floor');
  const floorAO = (x, z, y) => {
    if (y > 0.06 && Math.abs(y - 3.3) > 0.05) return 1;
    let d = 9;
    for (const b of aoBoxes) {
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
      const dd = Math.hypot(dx, dz);
      if (dd < d) d = dd;
    }
    const t = Math.min(1, d / 1.1);
    return 0.42 + 0.58 * t * t * (3 - 2 * t);
  };
  const B = new Batcher(lib.scales, makeGrime({ floorAO }));

  // ---------------------------------------------------------------- static geometry
  for (const s of layout.solids) if (s.visual) B.box(s.min, s.max, s.mat, { base: groundHeight((s.min[0] + s.max[0]) / 2, (s.min[2] + s.max[2]) / 2) > 0.1 ? 3.3 : 0 });
  groundGrid(B, GROUND.min, GROUND.max, 0, floorMatAt, 1);
  const inst = buildProps(B, layout, 7);
  // distant silhouettes beyond the fences (no collision, no rays)
  B.box([-46, 0, 8], [-34, 13, 40], { px: 'brick', nx: 'brick', pz: 'brick', nz: 'brick', py: 'concreteOut', ny: 'brick' });
  B.box([30, 0, -24], [44, 9, 22], { px: 'corrugatedOut', nx: 'corrugatedOut', pz: 'corrugatedOut', nz: 'corrugatedOut', py: 'concreteOut', ny: 'concreteOut' });
  B.box([-28, 0, 38], [14, 7, 50], { px: 'brick', nx: 'brick', pz: 'brick', nz: 'brick', py: 'concreteOut', ny: 'brick' });
  B.box([-40, 0, -48], [10, 10, -36], { px: 'corrugatedOut', nx: 'corrugatedOut', pz: 'corrugatedOut', nz: 'corrugatedOut', py: 'concreteOut', ny: 'concreteOut' });
  B.cylinder('brick', [-32, 0, -30], 1.6, 32, { segs: 20 });
  B.cylinder('concreteOut', [22, 0, 30], 0.12, 6.5, { segs: 8 });     // dead yard lamp post
  B.box([21.4, 6.3, 29.9], [22.1, 6.45, 30.1], 'steel');

  const staticGroup = new THREE.Group(); staticGroup.name = 'static';
  for (const [key, geo] of B.build()) {
    const mat = lib.mats[key] || lib.mats.ceiling;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'static:' + key;
    mesh.castShadow = !NO_CAST.has(key);
    mesh.receiveShadow = true;
    mesh.userData.surface = lib.surfaces[key] || 'concrete';
    mesh.matrixAutoUpdate = false;
    staticGroup.add(mesh);
  }
  for (const m of buildInstanced(inst, lib.mats, lib.scales)) staticGroup.add(m);
  scene.add(staticGroup);
  progress(0.8, 'Details');

  // ---------------------------------------------------------------- decals
  const R = rng(31);
  const floorSpots = [];
  for (let i = 0; i < 80; i++) {
    const x = -23 + R() * 42, z = -17 + R() * 32;
    floorSpots.push([x, z, 0.8 + R() * 2.4, R() < 0.75 ? 0 : 3]);
  }
  for (const [x, z] of [[-7.0, 4.2], [-0.2, 4.5], [3.4, 14.2], [-8.1, -10.6], [-6.5, -9.0], [4.6, -0.6], [-12.0, 12.2]]) floorSpots.push([x, z, 1.0 + R() * 1.2, 1]);
  for (let i = 0; i < 18; i++) floorSpots.push([-22 + R() * 40, 17 + R() * 8, 1.5 + R() * 3, R() < 0.5 ? 0 : 1]);
  const puddles = [[-12.5, 5.5, 3.0], [-2.0, -2.0, 2.0], [-8.0, -12.0, 2.8], [8.6, -12.4, 2.2], [-2.0, 19.0, 3.2], [8.0, 23.8, 2.4],
    [-18.0, 23.0, 2.0], [11.5, 17.2, 1.6], [9.4, 4.2, 1.0], [12.6, 2.0, 1.1], [-20.5, -15.0, 1.8], [-15.5, 9.5, 1.4]];
  const wallSoot = [[[-8.0, 5.6, 15.58], '-z', 5.0, 3.0], [[4.2, 2.5, 15.58], '-z', 2.5, 2.2], [[-23.58, 3.0, -10.0], '+x', 4.0, 3.0], [[19.58, 1.6, 7.0], '-x', 3.0, 2.0]];
  buildDecals(scene, layout, { floorSpots, puddles, wallSoot, extraction: EXTRACTION });

  // ---------------------------------------------------------------- lights, sky, fog
  const lighting = await setupLighting(ctx, layout, (p) => progress(0.82 + p * 0.12, 'Licht'));
  progress(0.95, 'Kollision');

  // ---------------------------------------------------------------- collision + raycast proxies
  const colliders = world.colliders.map((c) => new THREE.Box3(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max)));
  const proxyRoot = new THREE.Group(); proxyRoot.name = 'raycast-proxies';   // not added to the scene: invisible, static
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const addProxy = (min, max, surface) => {
    const m = new THREE.Mesh(unit, proxyMat);
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.scale.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    m.userData.surface = surface;
    proxyRoot.add(m);
    return m;
  };
  for (const s of layout.solids) if (s.ray) addProxy(s.min, s.max, s.surface);
  addProxy([GROUND.min[0], -0.5, GROUND.min[1]], [GROUND.max[0], 0, GROUND.max[1]], 'concrete');
  proxyRoot.updateMatrixWorld(true);
  const raycastMeshes = [...proxyRoot.children];

  // ---------------------------------------------------------------- gameplay data
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const enemySpawns = ENEMY_SPAWNS.map((e) => ({
    position: v(e.position), yaw: e.yaw, type: e.type, name: e.name,
    ...(e.patrol ? { patrol: e.patrol.map(v) } : {}),
  }));
  const navGraph = { nodes: world.graph.nodes.map(v), edges: world.graph.edges.map((e) => [e[0], e[1]]) };
  const coverPoints = world.cover.map(v);
  const extraction = new THREE.Box3(v(EXTRACTION.min), v(EXTRACTION.max));
  const bounds = new THREE.Box3(v(BOUNDS.min), v(BOUNDS.max));

  function surfaceOf(obj) {
    let o = obj;
    while (o) { if (o.userData && o.userData.surface) return o.userData.surface; o = o.parent; }
    return 'concrete';
  }

  progress(1, 'Bereit');
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
    update(dt) { lighting.update(dt); },
    // extras (not in contract)
    sun: lighting.sun,
    layout,
  };
}
