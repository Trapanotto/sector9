// Animation utilities: import UAL clips onto the shared skeleton, pose authoring helpers,
// and a gltf-transform writer for an animation-only GLB.
import fs from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { resample, dedup, prune, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { THREE } from './threeio.mjs';
import { ual1ToUal2 } from './names.mjs';

export const H_REF = 0.98; // must match mhbuild.H_REF
const UAL_PELVIS = new THREE.Vector3(0, 0.05, 0.917);
const K = H_REF / UAL_PELVIS.z;

/** Convert a UAL clip into our conventions (renamed, rotation only + rescaled pelvis translation). */
export function importUalClip(clip, bones, { ual1 = false, name = clip.name, keepRoot = false } = {}) {
  const set = new Set(bones);
  const tracks = [];
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    let node = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    if (ual1) node = ual1ToUal2(node);
    if (!node || !set.has(node)) continue;
    if (prop === 'scale') continue;
    if (node === 'root' && !keepRoot) continue;
    if (prop === 'position') {
      if (node !== 'pelvis') continue;
      const v = t.values.slice();
      for (let i = 0; i < v.length; i += 3) {
        v[i] = (v[i] - UAL_PELVIS.x) * K;
        v[i + 1] = (v[i + 1] - UAL_PELVIS.y) * K;
        v[i + 2] = H_REF + (v[i + 2] - UAL_PELVIS.z) * K;
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${node}.position`, t.times.slice(), v));
    } else if (prop === 'quaternion') {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, t.times.slice(), t.values.slice()));
    }
  }
  return new THREE.AnimationClip(name, -1, tracks);
}

/** Write skeleton nodes (rest TRS taken from `restBones`) + clips to an animation-only GLB. */
export async function writeAnimGLB(path, restRoot, clips, meta) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('anims');
  const nodes = new Map();
  const mk = (obj) => {
    const n = doc.createNode(obj.name)
      .setTranslation(obj.position.toArray())
      .setRotation(obj.quaternion.toArray())
      .setScale(obj.scale.toArray());
    nodes.set(obj.name, n);
    for (const c of obj.children) if (c.isBone) n.addChild(mk(c));
    return n;
  };
  scene.addChild(mk(restRoot));
  for (const clip of clips) {
    const anim = doc.createAnimation(clip.name);
    for (const t of clip.tracks) {
      const dot = t.name.lastIndexOf('.');
      const node = nodes.get(t.name.slice(0, dot));
      if (!node) continue;
      const prop = t.name.slice(dot + 1);
      const path_ = prop === 'quaternion' ? 'rotation' : prop === 'position' ? 'translation' : 'scale';
      const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(t.times)).setBuffer(buffer);
      const output = doc.createAccessor().setType(path_ === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(new Float32Array(t.values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      anim.addSampler(sampler);
      anim.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path_).setSampler(sampler));
    }
    if (meta?.[clip.name]) anim.setExtras(meta[clip.name]);
  }
  await MeshoptEncoder.ready;
  await doc.transform(resample({ tolerance: 2e-4 }), dedup(), prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(path, doc);
  return doc;
}

export function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
