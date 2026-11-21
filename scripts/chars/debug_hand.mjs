import { loadGLB } from './threeio.mjs';
import { Rig } from './rig.mjs';
import fs from 'node:fs';

const ref = await loadGLB(process.argv[2]);
let rootBone;
ref.scene.traverse((o) => { if (o.isBone && o.name === 'root') rootBone = o; });
const bones = JSON.parse(fs.readFileSync(new URL('./skeleton.json', import.meta.url))).enemy.map((b) => b[0]);
const R = new Rig(rootBone, bones);
R.reset();
const f = (v) => v.toArray().map((x) => x.toFixed(3)).join(',');
for (const s of ['l', 'r']) {
  console.log(s, 'hand', f(R.wpos(`hand_${s}`)), 'middle', f(R.wpos(`middle_01_${s}`)), 'index', f(R.wpos(`index_01_${s}`)),
    'thumb3', f(R.wpos(`thumb_03_${s}`)), 'frame f', f(R.handFrame(s).f), 'n', f(R.handFrame(s).n), 'local side', f(R.handLocal[s].side));
}
// mesh-based palm normal: average normal of skin vertices weighted to the hand
let mesh;
ref.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
const g = mesh.geometry;
const names = mesh.skeleton.bones.map((b) => b.name);
for (const s of ['l', 'r']) {
  const hi = names.indexOf(`hand_${s}`);
  const hp = R.wpos(`hand_${s}`);
  let up = 0, down = 0, nu = 0, nd = 0;
  for (let i = 0; i < g.attributes.position.count; i++) {
    if (g.attributes.skinIndex.getComponent(i, 0) !== hi || g.attributes.skinWeight.getComponent(i, 0) < 0.9) continue;
    const y = g.attributes.position.getY(i), ny = g.attributes.normal.getY(i);
    if (ny > 0.5) { up += y; nu++; } else if (ny < -0.5) { down += y; nd++; }
  }
  console.log(s, 'hand verts facing up', nu, 'facing down', nd, 'hand y', hp.y.toFixed(3));
}
