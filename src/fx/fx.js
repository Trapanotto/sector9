// STUB (workstream C): pooled bullet-hole and blood decals (2 instanced draws), API for impacts/blood/muzzle.
// Replace with real decals, sparks, dust, blood spray and glass shards; keep ctx.fx's interface.
import * as THREE from 'three';
import { createDynamicMaterial } from '../render/materials.js';

export function createFx(ctx) {
  const POOL = 96;
  const fx = { id: 'fx', order: ctx.ORDER.fx };
  let holes, blood, nh = 0, nb = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1);
  const mk = (color, size) => {
    const g = new THREE.PlaneGeometry(size, size);
    const im = new THREE.InstancedMesh(g, createDynamicMaterial({ color }), POOL);
    im.count = 0; im.frustumCulled = false; im.renderOrder = 5;
    im.material.polygonOffset = true; im.material.polygonOffsetFactor = -2; im.material.polygonOffsetUnits = -2;
    ctx.render.scene.add(im);
    return im;
  };
  const place = (im, i, point, normal, size) => {
    n.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(z, n);
    p.set(point.x, point.y, point.z).addScaledVector(n, 0.004);
    s.set(size, size, 1);
    m4.compose(p, q, s);
    im.setMatrixAt(i, m4);
    im.instanceMatrix.needsUpdate = true;
    im.count = Math.max(im.count, i + 1);
  };
  fx.init = () => {
    holes = mk([0.03, 0.03, 0.03], 0.06);
    blood = mk([0.18, 0.01, 0.01], 0.5);
    ctx.events.on('shot', (r) => { if (r.hit && r.kind !== 'enemy' && r.kind !== 'player' && r.kind !== 'glass') fx.impact(r); });
    ctx.events.on('hit', (r) => { if (r.kind === 'enemy') fx.blood(r.point, r.dir, 1); });
  };
  /** bullet impact on a surface: res { point, normal, surface } */
  fx.impact = (res) => { place(holes, nh++ % POOL, res.point, res.normal, 1 + Math.random() * 0.4); };
  /** blood: splatter on the floor below the hit point */
  fx.blood = (point, dir, amount = 1) => {
    const g = ctx.world.groundHeight(point.x + dir.x * 0.6, point.z + dir.z * 0.6, point.y, 0);
    if (g > -Infinity) place(blood, nb++ % POOL, { x: point.x + dir.x * 0.6, y: g, z: point.z + dir.z * 0.6 }, { x: 0, y: 1, z: 0 }, amount * (0.6 + Math.random() * 0.6));
  };
  fx.muzzle = () => {};
  fx.reset = () => { if (holes) { holes.count = 0; blood.count = 0; nh = nb = 0; } };
  return fx;
}
