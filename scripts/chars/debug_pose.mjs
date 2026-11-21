// Debug: world positions of key joints at a clip time. usage: node debug_pose.mjs ref.glb anims.glb clip t
import { loadGLB } from './threeio.mjs';
import { Rig } from './rig.mjs';
import fs from 'node:fs';

const [, , refPath, animPath, clipName, tArg] = process.argv;
const ref = await loadGLB(refPath);
const anims = await loadGLB(animPath);
let rootBone;
ref.scene.traverse((o) => { if (o.isBone && o.name === 'root') rootBone = o; });
const bones = JSON.parse(fs.readFileSync(new URL('./skeleton.json', import.meta.url))).enemy.map((b) => b[0]);
const R = new Rig(rootBone, bones);
const c = anims.animations.find((a) => a.name === clipName);
R.sample(c, Number(tArg));
for (const n of ['pelvis', 'spine_03', 'Head', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'ball_l']) {
  console.log(n.padEnd(9), R.wpos(n).toArray().map((v) => v.toFixed(3)).join(' '));
}
