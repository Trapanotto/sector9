// Node self-test for the pure world layout (no DOM / WebGL). Run: node scripts/selftest-world.mjs
import {
  buildLayout, groundHeight, PLAYER_SPAWN, ENEMY_SPAWNS, EXTRACTION, REGIONS,
} from '../src/world/layout.js';
import {
  computeWorldData, pointBlocked, walkClear, nearestNode, pathExists, lineOfSight, inWalkable,
} from '../src/world/nav.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } };
const fmt = (p) => `(${p.map((v) => v.toFixed(2)).join(', ')})`;

const layout = buildLayout();
const { colliders, rayBoxes, graph, cover } = computeWorldData(layout);
console.log(`solids ${layout.solids.length}, colliders ${colliders.length}, ray boxes ${rayBoxes.length}, doors ${layout.doors.length}, windows ${layout.windows.length}`);
console.log(`nav nodes ${graph.nodes.length}, edges ${graph.edges.length} (dropped ${graph.dropped}), components ${graph.components.count}, cover ${cover.length}`);

// Colliders are valid boxes.
for (const c of colliders) ok(c.min.every((v, k) => v < c.max[k]), `degenerate collider ${fmt(c.min)}-${fmt(c.max)}`);

// Doorways: width / height and nothing solid inside them.
for (const d of layout.doors) {
  ok(d.width >= 1.1 - 1e-6, `door ${d.name} too narrow (${d.width})`);
  ok(d.height >= 2.1 - 1e-6, `door ${d.name} too low (${d.height})`);
  if (!d.nav) continue;
  const p = [d.center[0], 0, d.center[1]];
  ok(!pointBlocked(p, colliders, 0.3), `door ${d.name} blocked at ${fmt(p)}`);
}

// Spawns.
const ps = PLAYER_SPAWN.position;
ok(!pointBlocked(ps, colliders, 0.4), `player spawn inside collider ${fmt(ps)}`);
ok(inWalkable(ps[0], ps[2]), 'player spawn outside walkable regions');
ok(ENEMY_SPAWNS.length >= 8 && ENEMY_SPAWNS.length <= 10, 'enemy spawn count');
const eyeP = [ps[0], ps[1] + 1.6, ps[2]];
for (const e of ENEMY_SPAWNS) {
  const p = e.position;
  ok(!pointBlocked(p, colliders, 0.4), `enemy ${e.name} inside collider ${fmt(p)}`);
  ok(Math.abs(groundHeight(p[0], p[2]) - p[1]) < 0.01, `enemy ${e.name} not on floor`);
  ok(inWalkable(p[0], p[2]), `enemy ${e.name} outside walkable regions`);
  const pts = [p, ...(e.patrol || [])];
  for (const q of pts) {
    ok(lineOfSight([q[0], q[1] + 1.6, q[2]], eyeP, rayBoxes) === false, `enemy ${e.name} point ${fmt(q)} sees player spawn`);
    ok(!pointBlocked(q, colliders, 0.4), `patrol point of ${e.name} blocked ${fmt(q)}`);
  }
  if (e.patrol) {
    for (let i = 0; i < e.patrol.length; i++) {
      const a = e.patrol[i], b = e.patrol[(i + 1) % e.patrol.length];
      if (e.patrol.length === 2 && i === 1) break;
      ok(walkClear(a, b, colliders), `patrol leg of ${e.name} blocked ${fmt(a)} -> ${fmt(b)}`);
    }
    ok(walkClear(p, e.patrol[0], colliders), `spawn->patrol start of ${e.name} blocked`);
  }
  if (Math.hypot(p[0] - ps[0], p[2] - ps[2]) < 15) console.warn('  note: enemy', e.name, 'closer than 15 m to player spawn');
}

// Nav graph.
for (const n of graph.nodes) ok(!pointBlocked(n, colliders, 0.35), `nav node inside collider ${fmt(n)}`);
for (const [a, b] of graph.edges) {
  const A = graph.nodes[a], B = graph.nodes[b];
  ok(Math.hypot(A[0] - B[0], A[2] - B[2]) <= 5.0, 'edge longer than 5 m');
}
ok(graph.components.count === 1, `nav graph has ${graph.components.count} components`);
if (graph.components.count > 1) {
  const sizes = {};
  graph.components.of.forEach((c, i) => { (sizes[c] ||= []).push(graph.nodes[i]); });
  for (const [c, list] of Object.entries(sizes)) if (list.length < graph.nodes.length / 2) console.error(`  component ${c}: ${list.length} nodes, e.g. ${list.slice(0, 4).map(fmt).join(' ')}`);
}
// Every region and doorway has a node.
for (const r of REGIONS) {
  const has = graph.nodes.some((n) => n[0] >= r.min[0] && n[0] <= r.max[0] && n[2] >= r.min[1] && n[2] <= r.max[1]);
  ok(has, `region ${r.name} has no nav node`);
}
for (const d of layout.doors.filter((d) => d.nav)) {
  const near = graph.nodes.some((n) => Math.hypot(n[0] - d.center[0], n[2] - d.center[1]) < 0.6);
  ok(near, `door ${d.name} has no nav node`);
}
// Coverage: no walkable sample further than 3.2 m from a node.
let worst = 0, worstP = null;
for (let x = -23; x <= 19; x += 1) for (let z = -17; z <= 25; z += 1) {
  const p = [x, groundHeight(x, z), z];
  if (!inWalkable(x, z) || pointBlocked(p, colliders, 0.4)) continue;
  let best = Infinity;
  for (const n of graph.nodes) best = Math.min(best, Math.hypot(n[0] - x, n[2] - z) + Math.abs(n[1] - p[1]));
  if (best > worst) { worst = best; worstP = p; }
}
console.log(`worst walkable sample -> nearest node: ${worst.toFixed(2)} m at ${worstP && fmt(worstP)}`);
ok(worst < 3.5, 'nav coverage gap');

// Player spawn reaches extraction via graph.
const ex = [(EXTRACTION.min[0] + EXTRACTION.max[0]) / 2, 0, (EXTRACTION.min[2] + EXTRACTION.max[2]) / 2];
const s = nearestNode(graph.nodes, ps, colliders), t = nearestNode(graph.nodes, ex, colliders);
ok(s >= 0 && t >= 0, 'no node near spawn / extraction');
ok(s >= 0 && t >= 0 && pathExists(graph, s, t), 'no path from player spawn to extraction');
// Deck reachable.
const deckNode = nearestNode(graph.nodes, ENEMY_SPAWNS[0].position, colliders);
ok(deckNode >= 0 && pathExists(graph, s, deckNode), 'deck not reachable');

// Cover points.
ok(cover.length >= 20, `only ${cover.length} cover points`);
for (const c of cover) ok(!pointBlocked(c, colliders, 0.3), `cover inside collider ${fmt(c)}`);

// Doorways: no collider (below head height) overlaps the clear opening.
for (const d of layout.doors.filter((d) => d.nav)) {
  const h = d.width / 2 - 0.08;
  const r = d.normal === 'z'
    ? { min: [d.center[0] - h, 0, d.t0], max: [d.center[0] + h, 2.1, d.t1] }
    : { min: [d.t0, 0, d.center[1] - h], max: [d.t1, 2.1, d.center[1] + h] };
  for (const c of colliders) {
    const hit = [0, 1, 2].every((k) => c.min[k] < r.max[k] - 1e-6 && c.max[k] > r.min[k] + 1e-6);
    ok(!hit, `collider ${fmt(c.min)}-${fmt(c.max)} intersects doorway ${d.name}`);
  }
}

// Geometry build smoke test (THREE only, no DOM): props + batcher, check for NaNs and count.
{
  const { Batcher, makeGrime, groundGrid } = await import('../src/world/geometry.js');
  const { buildProps, buildInstanced } = await import('../src/world/props.js');
  const { MATS } = await import('../src/world/materials.js');
  const { GROUND, floorMatAt } = await import('../src/world/layout.js');
  const scales = Object.fromEntries(Object.entries(MATS).map(([k, d]) => [k, d.scale ?? 2]));
  const B = new Batcher(scales, makeGrime({ floorAO: () => 1 }));
  for (const s of layout.solids) if (s.visual) B.box(s.min, s.max, s.mat);
  groundGrid(B, GROUND.min, GROUND.max, 0, floorMatAt, 1);
  const inst = buildProps(B, layout, 7);
  const geos = B.build();
  let tris = 0, verts = 0;
  for (const [key, g] of geos) {
    ok(MATS[key] || key === 'screen', `unknown material key ${key}`);
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { ok(false, `NaN in ${key}`); break; }
    tris += g.index.count / 3; verts += g.attributes.position.count;
  }
  const fakeMats = Object.fromEntries(Object.keys(MATS).map((k) => [k, {}]));
  const im = buildInstanced(inst, fakeMats, scales);
  console.log(`static: ${geos.size} merged meshes, ${tris} tris, ${verts} verts; instanced meshes: ${im.length} (` +
    `barrels ${inst.barrels.length}, rollers ${inst.rollers.length}, debris ${inst.debris.length}, papers ${inst.papers.length})`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exitCode = 1; }
else console.log('\nALL WORLD SELF-TESTS PASSED');
