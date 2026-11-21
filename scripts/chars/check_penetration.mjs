// Independent finger/glove vs pistol penetration check on the EXPORTED file.
// Loads fp_arms_pistol.glb with three r170 (meshopt + quantization decoded), plays every clip at 60 fps
// (between the 30 fps keys, so key interpolation is checked too), skins every glove vertex on the CPU
// (SkinnedMesh.getVertexPosition, i.e. exactly what the GPU draws) and measures it against the pistol's exact
// signed distance field (fppistol.mjs primitives) placed by the EXPORTED pistol joints (pistol, slide, trigger,
// magazine; a magazine scaled to 0 is out of play). Also checks the procedural poses the game applies (index
// finger off / on / pressing the trigger) on top of the aim hold.
// usage: node check_penetration.mjs <fp_arms_pistol.glb> [out.json] [fps=60]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadGLB, THREE } from './threeio.mjs';
import { sdPart, TRIGGER_TRAVEL } from './fppistol.mjs';

const [, , file, outPath, fpsArg = '60'] = process.argv;
const FPS = Number(fpsArg);
const g = await loadGLB(file);
const scene = g.scene;
scene.updateMatrixWorld(true);
let arms;
scene.traverse((o) => { if (o.isSkinnedMesh) arms = o; });
const bones = arms.skeleton.bones.map((b) => b.name);
const J = Object.fromEntries(['pistol', 'pistol_slide', 'pistol_trigger', 'pistol_magazine'].map((n) => [n, arms.skeleton.bones.find((b) => b.name === n)]));
const si = arms.geometry.attributes.skinIndex, sw = arms.geometry.attributes.skinWeight;
const glove = [];
for (let i = 0; i < arms.geometry.attributes.position.count; i++) {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
  if (/^(hand|thumb|index|middle|ring|pinky)/.test(bones[best])) glove.push([i, bones[best]]);
}
const PART_J = { frame: 'pistol', slide: 'pistol_slide', trigger: 'pistol_trigger', magazine: 'pistol_magazine' };
const inv = {}, s = new THREE.Vector3(), lp = new THREE.Vector3(), v = new THREE.Vector3();
let magOn = true;
function prep() {
  for (const [part, jn] of Object.entries(PART_J)) inv[part] = J[jn].matrixWorld.clone().invert();
  J.pistol_magazine.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  magOn = s.x > 0.5;
}
function sdf(p) {
  let d = Infinity;
  for (const part of Object.keys(PART_J)) {
    if (part === 'magazine' && !magOn) continue;
    lp.copy(p).applyMatrix4(inv[part]);
    d = Math.min(d, sdPart(part, lp));
  }
  return d;
}
function measure(acc) {
  arms.skeleton.update();
  prep();
  for (const [i, bn] of glove) {
    arms.getVertexPosition(i, v);
    arms.localToWorld(v);
    const d = sdf(v);
    if (d < 0) { acc.count++; const mm = -d * 1000; acc.byBone[bn] = Math.max(acc.byBone[bn] || 0, +mm.toFixed(2)); if (mm > acc.worst) { acc.worst = mm; acc.worstT = acc.t; } }
  }
}
const mixer = new THREE.AnimationMixer(scene);
const report = { method: `exported GLB, CPU skinning of every glove vertex, exact pistol SDF at the exported joints, ${FPS} fps`, file: file.split(/[\\/]/).pop(), sha1: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'), gloveVerts: glove.length, clips: {} };
const clips = g.animations.filter((c) => !c.name.startsWith('fp_pose'));
for (const clip of clips) {
  mixer.stopAllAction();
  const act = mixer.clipAction(clip); act.reset().play();
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const acc = { count: 0, worst: 0, worstT: 0, byBone: {}, t: 0 };
  for (let f = 0; f < n; f++) {
    acc.t = (f / (n - 1)) * clip.duration;
    // +10 µs: never sample exactly on a float32-rounded key time (STEP keys would read the previous key there)
    mixer.setTime(Math.min(acc.t + 1e-5, clip.duration - 1e-4));
    scene.updateMatrixWorld(true);
    measure(acc);
  }
  report.clips[clip.name] = { frames: n, penetratingVertexFrames: acc.count, maxDepth_mm: +acc.worst.toFixed(2), worstAt_s: +acc.worstT.toFixed(3), byBone_mm: acc.byBone };
  console.log(clip.name.padEnd(16), 'frames', n, 'inside vertex-frames', acc.count, 'max depth mm', +acc.worst.toFixed(2));
  act.stop();
}
// procedural trigger finger over the aim hold (what the game does every shot)
{
  const aim = g.animations.find((c) => c.name === 'fp_aim');
  const pose = {};
  for (const k of ['off', 'mid', 'trigger', 'press']) {
    const c = g.animations.find((a) => a.name === `fp_pose_index_${k}`);
    pose[k] = ['index_01_r', 'index_02_r', 'index_03_r'].map((bn) => new THREE.Quaternion().fromArray(c.tracks.find((t) => t.name === `${bn}.quaternion`).values, 0));
  }
  const ib = ['index_01_r', 'index_02_r', 'index_03_r'].map((n) => arms.skeleton.bones.find((b) => b.name === n));
  const trigRest = J.pistol_trigger.quaternion.clone();
  const acc = { count: 0, worst: 0, worstT: 0, byBone: {}, t: 0 };
  mixer.stopAllAction(); const act = mixer.clipAction(aim); act.reset().play(); mixer.setTime(0);
  const steps = 40;
  for (let f = 0; f <= steps; f++) {
    const u = f / steps; // 0..0.5 off->on, 0.5..1 press
    const on = Math.min(1, u * 2), pr = Math.max(0, u * 2 - 1);
    mixer.setTime(0);
    for (let k = 0; k < 3; k++) { if (on < 0.5) ib[k].quaternion.copy(pose.off[k]).slerp(pose.mid[k], on * 2); else ib[k].quaternion.copy(pose.mid[k]).slerp(pose.trigger[k], on * 2 - 1); if (pr > 0) ib[k].quaternion.slerp(pose.press[k], pr); }
    J.pistol_trigger.quaternion.copy(trigRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), TRIGGER_TRAVEL * pr));
    acc.t = u;
    scene.updateMatrixWorld(true);
    measure(acc);
  }
  report.clips.procedural_trigger = { frames: steps + 1, penetratingVertexFrames: acc.count, maxDepth_mm: +acc.worst.toFixed(2), worstAt_s: +acc.worstT.toFixed(3), byBone_mm: acc.byBone };
  console.log('procedural_trigger frames', steps + 1, 'max depth mm', +acc.worst.toFixed(2));
}
report.maxDepth_mm = Math.max(...Object.values(report.clips).map((c) => c.maxDepth_mm));
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
