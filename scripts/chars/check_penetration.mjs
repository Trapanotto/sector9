// Independent finger/glove vs pistol penetration check on the EXPORTED file.
// Loads fp_arms_pistol.glb with three r170 (meshopt + quantization decoded), plays every clip at
// 30 fps, skins every glove vertex on the CPU (SkinnedMesh.getVertexPosition) and tests it against
// the exported pistol meshes (closed parts) with a ray-parity inside test; depth = distance to the
// nearest pistol triangle for inside points.
// usage: node check_penetration.mjs <fp_arms_pistol.glb> [out.json]
import fs from 'node:fs';
import { loadGLB, THREE } from './threeio.mjs';

const [, , file, outPath] = process.argv;
const g = await loadGLB(file);
const scene = g.scene;
scene.updateMatrixWorld(true);
let arms;
const parts = [];
scene.traverse((o) => {
  if (o.isSkinnedMesh) arms = o;
  else if (o.isMesh && o.name.startsWith('pistol_')) { o.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); parts.push(o); }
});
const bones = arms.skeleton.bones.map((b) => b.name);
const si = arms.geometry.attributes.skinIndex, sw = arms.geometry.attributes.skinWeight;
const glove = [];
for (let i = 0; i < arms.geometry.attributes.position.count; i++) {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
  if (/^(hand|thumb|index|middle|ring|pinky)/.test(bones[best])) glove.push([i, bones[best]]);
}
const mixer = new THREE.AnimationMixer(scene);
const ray = new THREE.Raycaster();
const dirs = [new THREE.Vector3(1, 0.013, 0.007).normalize(), new THREE.Vector3(-0.011, 1, 0.017).normalize()];
const tri = new THREE.Triangle(), cp = new THREE.Vector3();
function partTris(m) {
  const pos = m.geometry.attributes.position, idx = m.geometry.index;
  const out = [];
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    out.push([a, b, c].map((k) => new THREE.Vector3().fromBufferAttribute(pos, k)));
  }
  return out;
}
const local = parts.map((p) => ({ mesh: p, tris: partTris(p) }));
function inside(p) {
  for (const { mesh, tris } of local) {
    mesh.geometry.computeBoundingBox();
    const lp = mesh.worldToLocal(p.clone());
    if (!mesh.geometry.boundingBox.containsPoint(lp)) continue;
    let votes = 0;
    for (const d of dirs) {
      ray.set(p, d.clone().transformDirection(mesh.matrixWorld).normalize());
      ray.far = 10;
      if (ray.intersectObject(mesh, false).length % 2 === 1) votes++;
    }
    if (votes === dirs.length) {
      let best = Infinity;
      for (const t of tris) { tri.set(...t); tri.closestPointToPoint(lp, cp); best = Math.min(best, cp.distanceTo(lp)); }
      const s = new THREE.Vector3(); mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      return { part: mesh.name, depth: best * s.x };
    }
  }
  return null;
}
const report = { method: 'exported GLB, CPU skinning, ray-parity inside test vs exported pistol meshes, 30 fps', gloveVerts: glove.length, clips: {} };
const v = new THREE.Vector3();
for (const clip of g.animations) {
  mixer.stopAllAction();
  const act = mixer.clipAction(clip); act.play();
  const n = Math.max(2, Math.round(clip.duration * 30) + 1);
  let count = 0, worst = 0, worstT = 0;
  const byBone = {}, byPart = {};
  for (let f = 0; f < n; f++) {
    const t = (f / (n - 1)) * clip.duration;
    mixer.setTime(Math.min(t, clip.duration - 1e-4));
    scene.updateMatrixWorld(true);
    arms.skeleton.update();
    for (const [i, bn] of glove) {
      arms.getVertexPosition(i, v);
      arms.localToWorld(v);
      const hit = inside(v);
      if (hit) {
        count++;
        const mm = +(hit.depth * 1000).toFixed(2);
        byBone[bn] = Math.max(byBone[bn] || 0, mm);
        byPart[hit.part] = Math.max(byPart[hit.part] || 0, mm);
        if (mm > worst) { worst = mm; worstT = t; }
      }
    }
  }
  report.clips[clip.name] = { frames: n, penetratingVertexFrames: count, maxDepth_mm: worst, worstAt_s: +worstT.toFixed(3), byBone_mm: byBone, byPart_mm: byPart };
  console.log(clip.name.padEnd(12), 'frames', n, 'inside vertex-frames', count, 'max depth mm', worst);
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
