// three BufferGeometry -> gltf-transform helpers.
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, quantize, meshopt, dedup, prune } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

export function addGeometry(doc, buffer, geom, material, name) {
  const prim = doc.createPrimitive().setMaterial(material);
  const attr = (sem, a, type) => prim.setAttribute(sem,
    doc.createAccessor().setType(type).setArray(new Float32Array(a.array)).setBuffer(buffer));
  attr('POSITION', geom.attributes.position, 'VEC3');
  if (geom.attributes.normal) attr('NORMAL', geom.attributes.normal, 'VEC3');
  if (geom.attributes.uv) attr('TEXCOORD_0', geom.attributes.uv, 'VEC2');
  if (geom.attributes.color) attr('COLOR_0', geom.attributes.color, 'VEC3');
  const n = geom.attributes.position.count;
  const idx = geom.index ? geom.index.array : Uint32Array.from({ length: n }, (_, i) => i);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(n < 65536 ? new Uint16Array(idx) : new Uint32Array(idx)).setBuffer(buffer));
  return doc.createMesh(name).addPrimitive(prim);
}

export function gunMaterial(doc, name = 'gun') {
  return doc.createMaterial(name).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0.35).setRoughnessFactor(0.55);
}

/** Static weapon: one mesh, one vertex-coloured material. */
export async function writeStatic(path, name, geom, extras = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mat = gunMaterial(doc, name + '_mat');
  const mesh = addGeometry(doc, buffer, geom, mat, name);
  const node = doc.createNode(name).setMesh(mesh).setExtras(extras);
  doc.createScene(name).addChild(node);
  await finish(doc, path);
}

export async function finish(doc, path, { compress = true } = {}) {
  await MeshoptEncoder.ready;
  await doc.transform(weld(), dedup(), prune({ keepLeaves: true }));
  if (compress) await doc.transform(quantize({ quantizeNormal: 10 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(path, doc);
}
