// Runtime of the static world art (workstream A): ONE mesh, ONE draw call for every prop, rack, conveyor frame
// and decor item. The vertex buffer holds everything; the index buffer is rebuilt (only when the set changes)
// from per-chunk index ranges of the chunks that are PVS-visible (ctx.world.zoneVisible) and inside the camera
// frustum, picking LOD0 or LOD1 per chunk by distance. Chunks = zone × 12 m cell (build.js).
import * as THREE from 'three';
import { buildStaticArt } from './build.js';
import { geometryFromBuilder } from './material.js';
import { F_SOLID } from '../gen.js';

const LOD_DIST = { vlow: 16, low: 20, mid: 26, high: 34 };

export function createStaticArt(ctx, material) {
  const L = ctx.layout, W = ctx.world.gen, bvh = ctx.world.bvh;
  const zoneIds = L.zones.map((z) => z.id);
  const free = (x, y, z, r) => { let hit = false; bvh.query(x - r, y + 0.02, z - r, x + r, y + 0.5, z + r, F_SOLID, () => { hit = true; }); return !hit; };
  const t0 = performance.now();
  const res = buildStaticArt(L, (x, y, z) => W.zoneLookup.nearest(x, y, z), zoneIds, { free });
  const b = res.b;
  const geo = geometryFromBuilder(b);

  // source index ranges per chunk / LOD in one array
  const chunks = res.chunks;
  let total = 0;
  for (const c of chunks) for (const k of c.lists) total += b.targets.get(k)?.n ?? 0;
  const src = new Uint32Array(total);
  let o = 0;
  const N = chunks.length;
  const start = new Int32Array(N * 2), count = new Int32Array(N * 2);
  const zone = new Int16Array(N), bb = new Float32Array(N * 6);
  chunks.forEach((c, i) => {
    for (let l = 0; l < 2; l++) {
      const g = b.targets.get(c.lists[l]);
      start[i * 2 + l] = o; count[i * 2 + l] = g ? g.n : 0;
      if (g) { src.set(g.view(), o); o += g.n; }
    }
    zone[i] = c.zone; bb.set(c.bbox, i * 6);
  });
  const dyn = new Uint32Array(Math.max(3, total));
  const index = new THREE.BufferAttribute(dyn, 1);
  index.setUsage(THREE.DynamicDrawUsage);
  geo.setIndex(index);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(48, 0, 48), 400);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'art:static';
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  ctx.render.scene.add(mesh);

  // ---- per-frame selection (inside onBeforeRender: after world.update has set the PVS for this frame)
  const state = new Int8Array(N).fill(-2);
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let drawn = 0, tris = 0;
  function select(camera) {
    const vis = ctx.world.zoneVisible, all = ctx.debug?.allZones;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const cp = camera.position, lodD = LOD_DIST[ctx.quality?.tier?.id] ?? 20, lod2 = lodD * lodD;
    let changed = false;
    for (let i = 0; i < N; i++) {
      let s = -1;
      if (all || !vis || vis[zone[i]] === 1) {
        const k = i * 6;
        box.min.set(bb[k] - 0.5, bb[k + 1] - 0.5, bb[k + 2] - 0.5); box.max.set(bb[k + 3] + 0.5, bb[k + 4] + 0.5, bb[k + 5] + 0.5);
        if (frustum.intersectsBox(box)) {
          const dx = Math.max(bb[k] - cp.x, 0, cp.x - bb[k + 3]), dy = Math.max(bb[k + 1] - cp.y, 0, cp.y - bb[k + 4]), dz = Math.max(bb[k + 2] - cp.z, 0, cp.z - bb[k + 5]);
          s = dx * dx + dy * dy + dz * dz > lod2 ? 1 : 0;
        }
      }
      if (state[i] !== s) { state[i] = s; changed = true; }
    }
    if (!changed) return;
    let n = 0;
    for (let i = 0; i < N; i++) {
      const s = state[i]; if (s < 0) continue;
      const c = count[i * 2 + s]; if (!c) continue;
      const st = start[i * 2 + s];
      dyn.set(src.subarray(st, st + c), n); n += c;
    }
    index.clearUpdateRanges(); index.addUpdateRange(0, Math.max(n, 3)); index.needsUpdate = true;
    geo.setDrawRange(0, n);
    drawn = n; tris = n / 3;
  }
  mesh.onBeforeRender = (renderer, scene, camera) => select(camera);

  const stats = {
    buildMs: performance.now() - t0, vertices: b.vcount, triangles: b.tris, chunks: N,
    gpuMB: (geo.attributes.position.array.byteLength + geo.attributes.normal.array.byteLength + geo.attributes.uv.array.byteLength
      + geo.attributes.aTile.array.byteLength + geo.attributes.aArt.array.byteLength + dyn.byteLength) / 1048576,
    get drawnTriangles() { return tris; }, get drawnIndices() { return drawn; },
  };
  return { mesh, stats, perType: res.perType, forceAll() { state.fill(-2); } };
}
