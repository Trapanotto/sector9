// Prints a summary of a glTF/GLB: nodes/skeleton, meshes, triangle counts, animations.
// usage: node inspect.mjs file.glb [--bones] [--anims]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const [, , file, ...flags] = process.argv;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();
let tris = 0;
for (const m of root.listMeshes()) {
  let t = 0;
  for (const p of m.listPrimitives()) {
    const idx = p.getIndices();
    t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  tris += t;
  console.log('mesh', m.getName(), 'prims', m.listPrimitives().length, 'tris', t,
    'attrs', m.listPrimitives()[0].listSemantics().join(','));
}
console.log('total tris', tris, 'materials', root.listMaterials().map((m) => m.getName()).join(','),
  'textures', root.listTextures().map((t) => `${t.getName()}:${t.getImageSize()}`).join(' '));
for (const s of root.listSkins()) {
  console.log('skin', s.getName(), 'joints', s.listJoints().length);
  if (flags.includes('--bones')) {
    for (const j of s.listJoints()) {
      const p = j.getParentNode();
      console.log('  ', j.getName(), '<-', p ? p.getName() : '-', 'T', j.getTranslation().map((v) => v.toFixed(3)).join(','),
        'R', j.getRotation().map((v) => v.toFixed(3)).join(','), 'S', j.getScale().map((v) => v.toFixed(2)).join(','));
    }
  }
}
const scene = root.getDefaultScene() || root.listScenes()[0];
function walk(n, d) {
  if (d > 3) return;
  console.log(' '.repeat(d * 2) + 'node', n.getName(), n.getMesh() ? '[mesh]' : '', n.getSkin() ? '[skin]' : '',
    'T', n.getTranslation().map((v) => v.toFixed(3)).join(','), 'R', n.getRotation().map((v) => v.toFixed(3)).join(','), 'S', n.getScale().map((v) => v.toFixed(3)).join(','));
  for (const c of n.listChildren()) walk(c, d + 1);
}
if (scene) for (const n of scene.listChildren()) walk(n, 0);
const anims = root.listAnimations();
console.log('animations', anims.length);
if (flags.includes('--anims')) {
  for (const a of anims) {
    let dur = 0;
    for (const s of a.listSamplers()) { const arr = s.getInput().getArray(); dur = Math.max(dur, arr[arr.length - 1]); }
    console.log('  ', a.getName(), dur.toFixed(2) + 's', 'channels', a.listChannels().length);
  }
}
