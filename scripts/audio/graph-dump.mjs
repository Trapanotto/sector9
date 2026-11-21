// Dump the acoustic portal graph (debug aid): node scripts/audio/graph-dump.mjs [listenerZoneId]
import { LAYOUT } from '../../src/world/layout/index.js';
import { generateWorld, boxFlags, F_OCC } from '../../src/world/gen.js';
import { BoxBVH } from '../../src/world/bvh.js';
import { buildAcousticGraph, createSolver } from '../../src/audio/acoustics.js';

const W = generateWorld(LAYOUT);
const bvh = new BoxBVH(W.boxes, Uint8Array.from(W.boxes, boxFlags));
const t0 = performance.now();
const G = buildAcousticGraph(W, (a, b) => !bvh.occluded(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, 1, F_OCC));
console.log(`graph: ${G.edges.length} portals in ${(performance.now() - t0).toFixed(0)} ms`);
for (const e of G.edges) console.log(`${W.zones[e.a].id} <-> ${W.zones[e.b].id}  ${e.kind}${e.door >= 0 ? ' ' + W.doors[e.door].id : ''}${e.glass ? ' ' + e.glass : ''}  area ${e.area.toFixed(1)}`);
const L = W.zoneIndex.get(process.argv[2] ?? 'hof');
const S = createSolver(G);
S.solve(L, 45, 1.5, 100, (i) => W.doors[i].state, () => false);
console.log(`\nfrom ${W.zones[L].id}:`);
W.zones.forEach((z, i) => console.log(`  ${z.id.padEnd(16)} loss ${S.loss[i].toFixed(1).padStart(5)} dB  lp ${String(Math.round(S.lp[i])).padStart(5)}  dist ${S.dist[i].toFixed(0)}`));
