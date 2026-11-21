// Stage 2: raw character GLB -> shipped GLB with LOD0 + LOD1 meshes (shared skeleton/material),
// WebP atlas, quantized + meshopt-compressed geometry.
// usage: node optimize.mjs <in_raw.glb> <out.glb> [lod0Tris=8000] [lod1Tris=2500] [texSize=1024]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, compactPrimitive, prune, dedup, textureCompress, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const [, , inPath, outPath, t0 = '8000', t1 = '2500', tex = '1024'] = process.argv;
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(inPath);
const root = doc.getRoot();

await doc.transform(weld());

const tris = (p) => p.getIndices().getCount() / 3;

/** Simplify a primitive to at most `target` triangles (meshopt, normal-aware), then compact it. */
function simplifyTo(prim, target) {
  const base = tris(prim);
  if (base > target) {
    MeshoptSimplifier.useExperimentalFeatures = true;
    const idx = new Uint32Array(prim.getIndices().getArray());
    const pos = new Float32Array(prim.getAttribute('POSITION').getArray());
    const nrm = new Float32Array(prim.getAttribute('NORMAL').getArray());
    const [out] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, nrm, 3, [0.25, 0.25, 0.25], null,
      Math.floor(target) * 3, 1.0, []);
    prim.getIndices().setArray(out);
  }
  compactPrimitive(prim);
  return tris(prim);
}

const meshNode = root.listNodes().find((n) => n.getMesh() && n.getSkin());
const mesh0 = meshNode.getMesh();
const prim0 = mesh0.listPrimitives()[0];
// LOD1: deep copy of the primitive (own accessors), then simplify both
const prim1 = prim0.clone();
for (const s of prim0.listSemantics()) prim1.setAttribute(s, prim0.getAttribute(s).clone());
prim1.setIndices(prim0.getIndices().clone());
const name = mesh0.getName();
const mesh1 = doc.createMesh(name + '_LOD1').addPrimitive(prim1);
mesh0.setName(name + '_LOD0');
meshNode.setName(name + '_LOD0');
const n1 = doc.createNode(name + '_LOD1').setMesh(mesh1).setSkin(meshNode.getSkin());
meshNode.getParentNode().addChild(n1);

const raw = tris(prim0);
const a = simplifyTo(prim0, Number(t0));
const b = simplifyTo(prim1, Number(t1));

await doc.transform(
  prune(),
  dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [Number(tex), Number(tex)], quality: 82 }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
const extras = root.listNodes()[0].getExtras();
root.listNodes()[0].setExtras({ ...extras, lod0Tris: a, lod1Tris: b });
await io.write(outPath, doc);
console.log(JSON.stringify({ out: outPath, rawTris: raw, lod0Tris: a, lod1Tris: b,
  verts0: prim0.getAttribute('POSITION').getCount(), verts1: prim1.getAttribute('POSITION').getCount() }));
