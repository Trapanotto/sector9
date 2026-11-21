// Debug: weapon frame implied by hand_r + attach offset for some clips.
import { loadGLB, THREE } from './threeio.mjs';
import { Rig } from './rig.mjs';
import fs from 'node:fs';

const [, , refPath, animPath, wjson] = process.argv;
const ref = await loadGLB(refPath);
const anims = await loadGLB(animPath);
const W = JSON.parse(fs.readFileSync(wjson, 'utf8'));
let rootBone;
ref.scene.traverse((o) => { if (o.isBone && o.name === 'root') rootBone = o; });
const bones = JSON.parse(fs.readFileSync(new URL('./skeleton.json', import.meta.url))).enemy.map((b) => b[0]);
const R = new Rig(rootBone, bones);
for (const [clip, kind] of [['pistol_aim', 'pistol'], ['smg_aim', 'smg'], ['shotgun_aim', 'shotgun'], ['smg_idle', 'smg']]) {
  const c = anims.animations.find((a) => a.name === clip);
  R.reset();
  R.sample(c, 0.05);
  const hq = R.wquat('hand_r');
  const hp = R.wpos('hand_r');
  const off = W[kind].offset;
  const oq = new THREE.Quaternion().fromArray(off.quaternion);
  const wq = hq.clone().multiply(oq);
  const wp = new THREE.Vector3().fromArray(off.position).applyQuaternion(hq).add(hp);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(wq);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(wq);
  const sup = W[kind].support ? new THREE.Vector3(...W[kind].support).applyQuaternion(wq).add(wp) : null;
  const lh = R.wpos('hand_l');
  console.log(clip, kind, 'gripPos', wp.toArray().map((v) => v.toFixed(3)), 'fwd', fwd.toArray().map((v) => v.toFixed(2)),
    'up', up.toArray().map((v) => v.toFixed(2)), 'support', sup?.toArray().map((v) => v.toFixed(3)), 'handL', lh.toArray().map((v) => v.toFixed(3)));
}
console.log('handLocal r', JSON.stringify(R.handLocal.r));
{
  const c = anims.animations.find((a) => a.name === 'smg_aim');
  R.reset(); R.sample(c, 0.05);
  const fr = R.handFrame('l');
  console.log('smg_aim left hand f', fr.f.toArray().map((v) => v.toFixed(2)), 'n', fr.n.toArray().map((v) => v.toFixed(2)));
  const fr2 = R.handFrame('r');
  console.log('smg_aim right hand f', fr2.f.toArray().map((v) => v.toFixed(2)), 'n', fr2.n.toArray().map((v) => v.toFixed(2)));
}
