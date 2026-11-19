import * as THREE from 'three';

// Dev / test: penetration check between the hands and the actual pistol geometry (not the SDF proxy).
// For every hand vertex (skinned, in the current pose) near the gun, find the closest pistol triangle; the vertex
// is inside when it lies behind that triangle (against its normal). Used by devtools.penetration() and the node
// self-test (scripts/selftest-hands.mjs). Not imported by the game.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Triangle();

/** Collect pistol triangles in `space` (an Object3D, normally the viewmodel root) into a uniform grid. */
export function pistolTriangles(meshes, space, cell = 0.006) {
  space.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const tris = [];
  for (const m of meshes) {
    if (!m.isMesh || !m.visible) continue;
    const g = m.geometry, pos = g.attributes.position, idx = g.index;
    const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      const a = new THREE.Vector3().fromBufferAttribute(pos, ia).applyMatrix4(M);
      const b = new THREE.Vector3().fromBufferAttribute(pos, ib).applyMatrix4(M);
      const c = new THREE.Vector3().fromBufferAttribute(pos, ic).applyMatrix4(M);
      const nn = new THREE.Vector3().subVectors(b, a).cross(_q.subVectors(c, a));
      if (nn.lengthSq() < 1e-16) continue;
      tris.push({ a, b, c, n: nn.normalize(), part: m.userData.part || m.name || '' });
    }
  }
  const grid = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  tris.forEach((t, ti) => {
    const lo = [Math.min(t.a.x, t.b.x, t.c.x), Math.min(t.a.y, t.b.y, t.c.y), Math.min(t.a.z, t.b.z, t.c.z)];
    const hi = [Math.max(t.a.x, t.b.x, t.c.x), Math.max(t.a.y, t.b.y, t.c.y), Math.max(t.a.z, t.b.z, t.c.z)];
    for (let i = Math.floor(lo[0] / cell); i <= Math.floor(hi[0] / cell); i++)
      for (let j = Math.floor(lo[1] / cell); j <= Math.floor(hi[1] / cell); j++)
        for (let k = Math.floor(lo[2] / cell); k <= Math.floor(hi[2] / cell); k++) {
          const kk = key(i, j, k);
          if (!grid.has(kk)) grid.set(kk, []);
          grid.get(kk).push(ti);
        }
  });
  return { tris, grid, cell, key };
}

/** Points (Vector3 in the same space) -> { inside, worst, byPart } with depth in metres (tolerance tol). */
export function penetration(points, T, tol = 0.0004) {
  let inside = 0, worst = 0;
  const byPart = {};
  for (const p of points) {
    const i0 = Math.floor(p.x / T.cell), j0 = Math.floor(p.y / T.cell), k0 = Math.floor(p.z / T.cell);
    let best = 1e9, bt = null;
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (let k = k0 - 1; k <= k0 + 1; k++) {
      const list = T.grid.get(T.key(i, j, k));
      if (!list) continue;
      for (const ti of list) {
        const t = T.tris[ti];
        _t.set(t.a, t.b, t.c);
        _t.closestPointToPoint(p, _q);
        const d = _q.distanceToSquared(p);
        if (d < best) { best = d; bt = t; _p.copy(_q); }
      }
    }
    if (!bt) continue;
    const depth = -_n.subVectors(p, _p).dot(bt.n);
    if (depth > tol && Math.sqrt(best) < 0.01) {
      inside++;
      worst = Math.max(worst, depth);
      byPart[bt.part] = (byPart[bt.part] || 0) + 1;
    }
  }
  return { inside, worst: +(worst * 1000).toFixed(2) + ' mm', byPart };
}

/** Skinned vertex positions of a SkinnedMesh, expressed in `space`. */
export function skinnedPoints(mesh, space, step = 1) {
  mesh.updateMatrixWorld(true);
  mesh.skeleton?.update();
  space.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const M = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
  const pos = mesh.geometry.attributes.position, out = [];
  for (let i = 0; i < pos.count; i += step) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    if (mesh.isSkinnedMesh) mesh.applyBoneTransform(i, v);
    // applyBoneTransform returns bind-space (mesh local) position
    out.push(v.applyMatrix4(M));
  }
  return out;
}
