// Node self-test for the pure world layout (no DOM / WebGL). Run: node scripts/selftest-world.mjs
import {
  buildLayout, groundHeight, PLAYER_SPAWN, ENEMY_SPAWNS, EXTRACTION, REGIONS, RAMPS, FLOORS, ZONES, zoneIndexAt, H,
} from '../src/world/layout.js';
import {
  computeWorldData, pointBlocked, walkClear, nearestNode, pathExists, shortestPath, lineOfSight, inWalkable, regionAt, regionY,
} from '../src/world/nav.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } };
const fmt = (p) => `(${p.map((v) => v.toFixed(2)).join(', ')})`;
const t0 = performance.now();

const layout = buildLayout();
const { colliders, rayBoxes, graph, cover } = computeWorldData(layout);
console.log(`solids ${layout.solids.length}, colliders ${colliders.length}, ray boxes ${rayBoxes.length}, doors ${layout.doors.length}, windows ${layout.windows.length}`);
console.log(`nav nodes ${graph.nodes.length}, edges ${graph.edges.length} (dropped ${graph.dropped}), components ${graph.components.count}, cover ${cover.length}  [${(performance.now() - t0).toFixed(0)} ms]`);

// ---- groundHeight: two-argument form stays on the ground floor, stacked floors resolve by height
ok(groundHeight(9.4, 5) === 0 && groundHeight(9.4, 5, 3.5) === H.up, 'corridor / gallery stacking');
ok(groundHeight(25, -2) === 0 && groundHeight(25, -2, H.base) === H.base, 'foundry / pump room stacking');
ok(groundHeight(20.8, 0, 3.5) === H.catwalk && groundHeight(20.8, 0, 0) === 0, 'catwalk over the foundry floor');
ok(Math.abs(groundHeight(15.9, -16.8, 0) - rampY(15.9)) < 1e-6, 'B1 ramp from the bay');
function rampY(x) { const r = RAMPS.find((q) => q.name === 'b1-stair'); return r.y0 + (r.y1 - r.y0) * (x - r.a0) / (r.a1 - r.a0); }
for (const r of RAMPS) {   // walking down / up a stair: height continuous along the centre line
  const c = (r.c0 + r.c1) / 2;
  let prev = null, maxJump = 0;
  for (let i = 0; i <= 60; i++) {
    const a = r.a0 + (r.a1 - r.a0) * (i / 60);
    const x = r.axis === 'x' ? a : c, z = r.axis === 'x' ? c : a;
    const y = groundHeight(x, z, prev ?? r.y0);
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(y - prev));
    prev = y;
  }
  ok(maxJump < 0.2, `stair ${r.name}: height jumps ${maxJump.toFixed(2)} m along the flight`);
  ok(Math.abs(prev - r.y1) < 0.05, `stair ${r.name}: ends at ${prev.toFixed(2)} instead of ${r.y1}`);
  ok(r.c1 - r.c0 >= 1.2 - 1e-6, `stair ${r.name} too narrow (${(r.c1 - r.c0).toFixed(2)} m)`);
  // clear width between the rail colliders / walls on the flight
  const mid = (r.a0 + r.a1) / 2, ym = (r.y0 + r.y1) / 2;
  let lo = r.c0 - 1, hi = r.c1 + 1;
  for (const b of colliders) {
    if (!(b.max[1] > ym + 0.35 && b.min[1] < ym + 1.7)) continue;
    const aMin = r.axis === 'x' ? b.min[0] : b.min[2], aMax = r.axis === 'x' ? b.max[0] : b.max[2];
    if (mid < aMin || mid > aMax) continue;
    const cMin = r.axis === 'x' ? b.min[2] : b.min[0], cMax = r.axis === 'x' ? b.max[2] : b.max[0];
    const cc = (r.c0 + r.c1) / 2;
    if (cMax <= cc) lo = Math.max(lo, cMax); else if (cMin >= cc) hi = Math.min(hi, cMin);
    else ok(false, `collider ${fmt(b.min)}-${fmt(b.max)} blocks stair ${r.name}`);
  }
  ok(hi - lo >= 1.0, `stair ${r.name}: clear width ${(hi - lo).toFixed(2)} m between rails`);
}

// Colliders are valid boxes.
for (const c of colliders) ok(c.min.every((v, k) => v < c.max[k]), `degenerate collider ${fmt(c.min)}-${fmt(c.max)}`);

// Doorways: width / height and nothing solid inside them.
for (const d of layout.doors) {
  ok(d.width >= 1.1 - 1e-6, `door ${d.name} too narrow (${d.width})`);
  ok(d.height >= 2.1 - 1e-6, `door ${d.name} too low (${d.height})`);
  if (!d.nav) continue;
  const p = [d.center[0], d.y || 0, d.center[1]];
  ok(!pointBlocked(p, colliders, 0.3), `door ${d.name} blocked at ${fmt(p)}`);
  ok(Math.abs(groundHeight(d.center[0], d.center[1], p[1]) - p[1]) < 0.05, `door ${d.name}: no floor in the doorway`);
}

// Spawns.
const ps = PLAYER_SPAWN.position;
ok(!pointBlocked(ps, colliders, 0.4), `player spawn inside collider ${fmt(ps)}`);
ok(inWalkable(ps[0], ps[2], ps[1]), 'player spawn outside walkable regions');
ok(ENEMY_SPAWNS.length >= 22 && ENEMY_SPAWNS.length <= 28, `enemy spawn count ${ENEMY_SPAWNS.length}`);
const eyeP = [ps[0], ps[1] + 1.6, ps[2]];
const names = new Set();
for (const e of ENEMY_SPAWNS) {
  ok(!names.has(e.name), `duplicate spawn name ${e.name}`); names.add(e.name);
  const p = e.position;
  ok(!pointBlocked(p, colliders, 0.4), `enemy ${e.name} inside collider ${fmt(p)}`);
  ok(Math.abs(groundHeight(p[0], p[2], p[1]) - p[1]) < 0.01, `enemy ${e.name} not on a floor (${groundHeight(p[0], p[2], p[1])})`);
  ok(inWalkable(p[0], p[2], p[1]), `enemy ${e.name} outside walkable regions`);
  const pts = [p, ...(e.patrol || [])];
  for (const q of pts) {
    ok(lineOfSight([q[0], q[1] + 1.6, q[2]], eyeP, rayBoxes) === false, `enemy ${e.name} point ${fmt(q)} sees player spawn`);
    ok(!pointBlocked(q, colliders, 0.4), `patrol point of ${e.name} blocked ${fmt(q)}`);
    ok(Math.abs(groundHeight(q[0], q[2], q[1]) - q[1]) < 0.01, `patrol point of ${e.name} not on a floor ${fmt(q)}`);
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
// No fight should pull in more than ~5 hostiles: count spawns that would join a fight around each spawn
// (within the gunfire radius, 10 m, or with a clear line of sight within 25 m: see src/enemies/tuning.js).
let crowd = 0, crowdName = '';
const eye = (p) => [p[0], p[1] + 1.6, p[2]];
for (const e of ENEMY_SPAWNS) {
  const n = ENEMY_SPAWNS.filter((o) => {
    const d = Math.hypot(o.position[0] - e.position[0], o.position[1] - e.position[1], o.position[2] - e.position[2]);
    return d < 10 || (d < 25 && lineOfSight(eye(o.position), eye(e.position), rayBoxes));
  }).length;
  if (n > crowd) { crowd = n; crowdName = e.name; }
}
console.log(`largest fight group (gunfire radius / line of sight): ${crowd} (around ${crowdName})`);
ok(crowd <= 5, `too many hostiles (${crowd}) clustered around ${crowdName}`);

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
// Every region and doorway has a node; every region is reachable from the player spawn.
const s = nearestNode(graph.nodes, ps, colliders);
ok(s >= 0, 'no node near the player spawn');
const nodeIn = (r) => graph.nodes.findIndex((n) => n[0] >= r.min[0] && n[0] <= r.max[0] && n[2] >= r.min[1] && n[2] <= r.max[1] &&
  Math.abs(n[1] - regionY(r, n[0], n[2])) < 0.4);
for (const r of REGIONS) {
  const i = nodeIn(r);
  ok(i >= 0, `region ${r.name} has no nav node`);
  if (i >= 0 && s >= 0) ok(pathExists(graph, s, i), `region ${r.name} not reachable from the player spawn`);
}
for (const d of layout.doors.filter((d) => d.nav)) {
  const near = graph.nodes.some((n) => Math.hypot(n[0] - d.center[0], n[2] - d.center[1]) < 0.6 && Math.abs(n[1] - (d.y || 0)) < 0.3);
  ok(near, `door ${d.name} has no nav node`);
}
// Coverage: no walkable sample further than 3.5 m from a node on the same floor.
let worst = 0, worstP = null;
for (const r of REGIONS) {
  for (let x = r.min[0] + 0.3; x <= r.max[0] - 0.3; x += 1) for (let z = r.min[1] + 0.3; z <= r.max[1] - 0.3; z += 1) {
    const yr = regionY(r, x, z);
    const p = [x, groundHeight(x, z, yr + 0.3), z];
    if (!inWalkable(x, z, p[1]) || pointBlocked(p, colliders, 0.4)) continue;
    let best = Infinity;
    for (const n of graph.nodes) best = Math.min(best, Math.hypot(n[0] - x, n[2] - z) + Math.abs(n[1] - p[1]) * 3);
    if (best > worst) { worst = best; worstP = p; }
  }
}
console.log(`worst walkable sample -> nearest node: ${worst.toFixed(2)} m at ${worstP && fmt(worstP)}`);
ok(worst < 3.5, 'nav coverage gap');

// Floors are connected through stairs: one node per level reachable from the others.
const levels = { basement: H.base, ground: 0, landing: H.up / 2, deck: 3.3, upper: H.up, wareDeck: H.wareDeck };
for (const [name, y] of Object.entries(levels)) {
  const i = graph.nodes.findIndex((n) => Math.abs(n[1] - y) < 0.05);
  ok(i >= 0 && pathExists(graph, s, i), `level ${name} (y ${y}) not reachable`);
}

// Extraction: reachable, and only through the warehouse (the rear lot is fenced off from the siding).
const ex = [(EXTRACTION.min[0] + EXTRACTION.max[0]) / 2, 0, (EXTRACTION.min[2] + EXTRACTION.max[2]) / 2];
const t = nearestNode(graph.nodes, ex, colliders);
ok(t >= 0 && s >= 0 && pathExists(graph, s, t), 'no path from player spawn to extraction');
const inWare = (i) => { const n = graph.nodes[i]; return n[0] > 0.0 && n[0] < 44 && n[2] > -52 && n[2] < -34; };
ok(shortestPath(graph, s, t, inWare) === null, 'extraction reachable without passing the warehouse');
const route = shortestPath(graph, s, t);
if (route) {
  let len = 0;
  for (let i = 1; i < route.length; i++) { const a = graph.nodes[route[i - 1]], b = graph.nodes[route[i]]; len += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  console.log(`shortest spawn -> extraction route: ${len.toFixed(0)} m over ${route.length} nodes`);
}
// Total walkable area (all floors), for comparison with the old level (~1900 m²).
let area = 0;
for (const r of REGIONS) {
  for (let x = r.min[0] + 0.25; x < r.max[0]; x += 0.5) for (let z = r.min[1] + 0.25; z < r.max[1]; z += 0.5) {
    const y = regionY(r, x, z);
    if (regionAt(x, z, y) !== r) continue;
    if (!pointBlocked([x, y, z], colliders, 0.0)) area += 0.25;
  }
}
console.log(`walkable area (all floors): ${area.toFixed(0)} m²`);

// Zones: every region's centre resolves to a zone; zone boxes do not overlap between different zones.
for (const r of REGIONS) {
  const x = (r.min[0] + r.max[0]) / 2, z = (r.min[1] + r.max[1]) / 2, y = regionY(r, x, z) + 1.2;
  void zoneIndexAt(x, y, z);
}
for (let i = 1; i < ZONES.length; i++) for (let j = i + 1; j < ZONES.length; j++) {
  for (const a of ZONES[i].boxes) for (const b of ZONES[j].boxes) {
    const ov = [0, 1, 2].every((k) => a.min[k] < b.max[k] - 0.01 && b.min[k] < a.max[k] - 0.01);
    ok(!ov, `zones ${ZONES[i].name} and ${ZONES[j].name} overlap`);
  }
}
void FLOORS;

// Cover points.
ok(cover.length >= 20, `only ${cover.length} cover points`);
for (const c of cover) ok(!pointBlocked(c, colliders, 0.3), `cover inside collider ${fmt(c)}`);

// Doorways: no collider (below head height) overlaps the clear opening.
for (const d of layout.doors.filter((d) => d.nav)) {
  const h = d.width / 2 - 0.08, y = d.y || 0;
  const r = d.normal === 'z'
    ? { min: [d.center[0] - h, y, d.t0], max: [d.center[0] + h, y + 2.1, d.t1] }
    : { min: [d.t0, y, d.center[1] - h], max: [d.t1, y + 2.1, d.center[1] + h] };
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
  const { PROP_SCALES } = await import('../src/world/propKit.js');
  const { GROUND, floorMatAt } = await import('../src/world/layout.js');
  const scales = Object.fromEntries(Object.entries(MATS).map(([k, d]) => [k, d.scale ?? 2]));
  const B = new Batcher(scales, makeGrime({ floorAO: () => 1 }));
  for (const s of layout.solids) if (s.visual) B.box(s.min, s.max, s.mat, { skip: s.skip });
  groundGrid(B, GROUND.min, GROUND.max, 0, floorMatAt, 1);
  const inst = buildProps(B, layout, 7);
  const geos = B.build();
  let tris = 0, verts = 0;
  for (const [key, g] of geos) {
    ok(MATS[key] || key === 'screen' || PROP_SCALES[key], `unknown material key ${key}`);
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { ok(false, `NaN in ${key}`); break; }
    tris += g.index.count / 3; verts += g.attributes.position.count;
  }
  const fakeMats = Object.fromEntries(Object.keys(MATS).map((k) => [k, {}]));
  const im = buildInstanced(inst, fakeMats, scales);
  console.log(`static: ${geos.size} merged meshes, ${tris} tris, ${verts} verts; instanced/extra meshes: ${im.length} (` +
    `rollers ${inst.rollers.length}, debris ${inst.debris.length}, papers ${inst.papers.length}, bolts ${inst.bolts.length}, ` +
    `label tris ${inst.labelGeo ? inst.labelGeo.index.count / 3 : 0})`);
  // Model placements: known ids, finite transforms.
  const { MODEL_INFO } = await import('../src/world/props.js');
  const perModel = {};
  for (const m of inst.models) {
    ok(!!MODEL_INFO[m.id], `unknown model id ${m.id}`);
    ok([m.x, m.y, m.z, m.ry, m.rx, m.rz].every(Number.isFinite), `bad model placement ${m.id}`);
    perModel[m.id] = (perModel[m.id] || 0) + 1;
  }
  console.log(`model placements: ${inst.models.length} (${Object.entries(perModel).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  // Every prop type in the layout has a builder.
  const known = new Set(inst.builderTypes || []);
  for (const p of layout.props) ok(known.has(p.type), `no prop builder for type ${p.type}`);
  // Decorative clutter without colliders must stay out of doorways.
  for (const m of inst.models) {
    for (const d of layout.doors.filter((d) => d.nav)) {
      const near = Math.hypot(m.x - d.center[0], m.z - d.center[1]) < 0.7 && Math.abs(m.y - (d.y || 0)) < 1.5;
      ok(!near, `model ${m.id} at ${fmt([m.x, m.y, m.z])} sits in doorway ${d.name}`);
    }
  }
  for (const [key, g] of geos) {
    const p = g.attributes.position.array, c = g.attributes.color.array;
    ok(p.length === c.length, `attribute length mismatch in ${key}`);
  }

  // Z-fighting guard: no two axis-aligned prop parts may have coplanar, same-facing, overlapping faces
  // (within 6 mm: with a 3 cm near plane that still flickers a few metres away). Down-facing faces resting
  // on the floor are ignored (never visible).
  const { Kit } = await import('../src/world/propKit.js');
  const parts = [];
  const origC = Kit.prototype.cbox, origB = Batcher.prototype.box;
  Kit.prototype.cbox = function (min, max, key, o = {}) { if (!o.matrix) parts.push({ min, max, key, dy: this.B._dy || 0 }); return origC.call(this, min, max, key, o); };
  Batcher.prototype.box = function (min, max, mats, o = {}) { if (!o.matrix && typeof mats === 'string') parts.push({ min, max, key: mats, dy: this._dy || 0 }); return origB.call(this, min, max, mats, o); };
  buildProps(new Batcher(scales, makeGrime({ floorAO: () => 1 })), layout, 7);
  Kit.prototype.cbox = origC; Batcher.prototype.box = origB;
  // parts built for upper floors are shifted afterwards: apply the recorded shift
  for (const p of parts) if (p.dy) { p.min = [p.min[0], p.min[1] + p.dy, p.min[2]]; p.max = [p.max[0], p.max[1] + p.dy, p.max[2]]; }
  const EPS = 0.006;
  let zf = 0;
  const cellOf = new Map();
  parts.forEach((p, i) => {
    const k = Math.floor(p.min[0] / 4) + ':' + Math.floor(p.min[2] / 4);
    for (let dx = 0; dx <= Math.floor(p.max[0] / 4) - Math.floor(p.min[0] / 4); dx++) for (let dz = 0; dz <= Math.floor(p.max[2] / 4) - Math.floor(p.min[2] / 4); dz++) {
      const kk = (Math.floor(p.min[0] / 4) + dx) + ':' + (Math.floor(p.min[2] / 4) + dz);
      if (!cellOf.has(kk)) cellOf.set(kk, []);
      cellOf.get(kk).push(i);
    }
    void k;
  });
  const seen = new Set();
  for (const list of cellOf.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const i = list[x], j = list[y], pk = i < j ? i * 1e6 + j : j * 1e6 + i;
    if (seen.has(pk)) continue;
    seen.add(pk);
    const a = parts[i], b = parts[j];
    if ([0, 1, 2].some((k) => a.max[k] < b.min[k] - EPS || b.max[k] < a.min[k] - EPS)) continue;
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3, v = (k + 2) % 3;
      if (Math.min(a.max[u], b.max[u]) - Math.max(a.min[u], b.min[u]) <= 0.002) continue;
      if (Math.min(a.max[v], b.max[v]) - Math.max(a.min[v], b.min[v]) <= 0.002) continue;
      for (const side of ['min', 'max']) {
        if (k === 1 && side === 'min') continue;
        if (Math.abs(a[side][k] - b[side][k]) < EPS) {
          zf++;
          if (zf <= 10) console.error(`  coplanar ${'xyz'[k]}${side === 'max' ? '+' : '-'} faces: ${a.key} ${fmt(a.min)}-${fmt(a.max)} / ${b.key} ${fmt(b.min)}-${fmt(b.max)}`);
        }
      }
    }
  }
  console.log(`z-fight check: ${parts.length} axis-aligned prop parts, ${zf} coplanar overlaps`);
  ok(zf === 0, `${zf} coplanar overlapping prop faces (z-fighting)`);
}

console.log(`total ${(performance.now() - t0).toFixed(0)} ms`);
if (failures) { console.error(`\n${failures} failure(s)`); process.exitCode = 1; }
else console.log('\nALL WORLD SELF-TESTS PASSED');
