// Stage 2b (workstream D): add a far LOD to a shipped enemy GLB: `<name>_LOD2` (~800 triangles, simplified from
// LOD1, same skin/material). Lets the runtime keep many distant/dead enemies inside D's triangle budget.
// usage: node add_lod2.mjs <in.glb> <out.glb> [lod2Tris=800]   (in == out is fine)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, quantize, meshopt, prune, compactPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [, , inPath, outPath, t2 = '800'] = process.argv;
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(inPath);
const root = doc.getRoot();
await doc.transform(dequantize());
const nodes = root.listNodes();
const n1 = nodes.find((n) => n.getName().endsWith('_LOD1'));
if (!n1) throw new Error('no _LOD1 node in ' + inPath);
const base = n1.getName().replace(/_LOD1$/, '');
const old = nodes.find((n) => n.getName() === base + '_LOD2');
if (old) { old.getMesh()?.dispose(); old.dispose(); }
const p1 = n1.getMesh().listPrimitives()[0];
const p2 = p1.clone();
for (const s of p1.listSemantics()) p2.setAttribute(s, p1.getAttribute(s).clone());
p2.setIndices(p1.getIndices().clone());
// weld positions across UV seams for the simplifier, keep borders of the UV islands via attribute weights
const idx = new Uint32Array(p2.getIndices().getArray());
const pos = new Float32Array(p2.getAttribute('POSITION').getArray());
const nrm = new Float32Array(p2.getAttribute('NORMAL').getArray());
MeshoptSimplifier.useExperimentalFeatures = true;
const [out] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, nrm, 3, [0.15, 0.15, 0.15], null, Math.floor(+t2) * 3, 1.0, []);
let res = out;
if (res.length / 3 > +t2 * 1.15) {
  // locked seams prevent reaching the target: sloppy fallback
  res = MeshoptSimplifier.simplifySloppy(idx, pos, 3, Math.floor(+t2) * 3, 1.0)[0];
}
p2.getIndices().setArray(res);
compactPrimitive(p2);
const m2 = doc.createMesh(base + '_LOD2').addPrimitive(p2);
const node2 = doc.createNode(base + '_LOD2').setMesh(m2).setSkin(n1.getSkin());
n1.getParentNode().addChild(node2);
await doc.transform(
  prune(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(outPath, doc);
console.log(`${base}: LOD1 ${p1.getIndices().getCount() / 3} → LOD2 ${p2.getIndices().getCount() / 3} triangles`);
