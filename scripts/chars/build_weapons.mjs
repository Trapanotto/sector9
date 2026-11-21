// Enemy weapons (self-made) + their hand attach offsets.
// usage: node build_weapons.mjs <cache_dir> <reference_raw_variant.glb> <out_dir>
// The pistol offset is calibrated on UAL Pistol_Aim_Neutral so the sourced pistol clips aim level.
import fs from 'node:fs';
import path from 'node:path';
import { loadGLB, THREE } from './threeio.mjs';
import { importUalClip } from './animlib.mjs';
import { Rig } from './rig.mjs';
import { gripOffset } from './author.mjs';
import { WEAPONS } from './weapondefs.mjs';
import { enemyPistol, enemySMG, enemyShotgun, triCount } from './weapons.mjs';
import { writeStatic } from './glbexport.mjs';
import { readJSON } from './animlib.mjs';

const [, , cache, refPath, outDir] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const bones = readJSON(path.join(here, 'skeleton.json')).enemy.map((b) => b[0]);
const ref = await loadGLB(refPath);
let rootBone;
ref.scene.traverse((o) => { if (o.isBone && o.name === 'root') rootBone = o; });
const rig = new Rig(rootBone, bones);
fs.mkdirSync(path.join(outDir, 'weapons'), { recursive: true });
const builders = { pistol: enemyPistol, smg: enemySMG, shotgun: enemyShotgun };
const out = {};
for (const [k, fn] of Object.entries(builders)) {
  const g = fn();
  const off = gripOffset(rig, WEAPONS[k]);
  if (k === 'pistol') {
    const ual1 = await loadGLB(path.join(cache, 'universal_animation_librarystandard', 'Animation Library[Standard]', 'Godot', 'AnimationLibrary_Godot_Standard.glb'));
    const aim = importUalClip(ual1.animations.find((a) => a.name === 'Pistol_Aim_Neutral'), bones, { ual1: true });
    rig.reset();
    rig.sample(aim, 0.05);
    const hq = rig.wquat('hand_r');
    const gp = off.pos.clone().applyQuaternion(hq).add(rig.wpos('hand_r'));
    const target = new THREE.Vector3(gp.x, rig.wpos('Head').y, 10);
    const fwd = target.sub(gp).normalize();
    const left = new THREE.Vector3(0, 1, 0).cross(fwd).normalize();
    const up = fwd.clone().cross(left);
    const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd));
    off.quat = hq.clone().invert().multiply(want);
    rig.reset();
  }
  const file = `weapons/${k}.glb`;
  await writeStatic(path.join(outDir, file), k, g, { attachBone: 'hand_r' });
  out[k] = {
    file, tris: triCount(g), bone: 'hand_r',
    offset: { position: off.pos.toArray().map((v) => +v.toFixed(5)), quaternion: off.quat.toArray().map((v) => +v.toFixed(5)) },
    muzzle: WEAPONS[k].muzzle, support: WEAPONS[k].support,
  };
  console.log(k, 'tris', out[k].tris, 'bytes', fs.statSync(path.join(outDir, file)).size);
}
fs.writeFileSync(path.join(outDir, 'weapons', 'weapons.json'), JSON.stringify(out, null, 1));
