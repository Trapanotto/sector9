// Self-tests (Node): `npm test`. Layout validity, nav connectivity, z-fighting, budgets, bake freshness.
// Workstreams add their own tests as scripts/test-<area>.mjs and register them in TESTS below (CONTRACT.md §tests).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { LAYOUT } from '../src/world/layout/index.js';
import { generateWorld, boxFlags, F_SOLID } from '../src/world/gen.js';
import { BoxBVH } from '../src/world/bvh.js';
import { buildNav } from '../src/world/nav.js';
import { BUDGETS } from '../src/core/budgets.js';

let fails = 0, warns = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log(`  FAIL ${msg}`); } return c; };
const warn = (c, msg) => { if (!c) { warns++; console.log(`  warn ${msg}`); } return c; };
const section = (s) => console.log(`\n## ${s}`);

const t0 = performance.now();
const W = generateWorld(LAYOUT);
const flags = Uint8Array.from(W.boxes, boxFlags);
const bvh = new BoxBVH(W.boxes, flags);
const nav = buildNav(W, bvh);
console.log(`world ${W.hash}: ${W.boxes.length} boxes, ${W.faces.length} faces, ${W.glass.length} panes, ${W.doors.length} doors, nav ${nav.n} nodes (${(performance.now() - t0).toFixed(0)} ms)`);

// ------------------------------------------------------------------------------------------------------
section('ids');
const uniq = (arr, what) => { const s = new Set(); for (const id of arr) { ok(!s.has(id), `duplicate ${what} id ${id}`); s.add(id); } return s; };
const zoneIds = uniq(LAYOUT.zones.map((z) => z.id), 'zone');
const doorIds = uniq(W.doors.map((d) => d.id), 'door');
uniq(W.glass.map((g) => g.id), 'glass');
const momentIds = uniq(LAYOUT.moments.map((m) => m.id), 'moment');
uniq(LAYOUT.enemies.map((e) => e.id), 'enemy');
for (const d of W.doors) for (const z of d.zones ?? []) ok(zoneIds.has(z), `door ${d.id} references unknown zone ${z}`);
for (const e of LAYOUT.enemies) if (e.trigger) ok(momentIds.has(e.trigger), `enemy ${e.id} references unknown moment ${e.trigger}`);
for (const z of LAYOUT.zones) ok(z.circuit in LAYOUT.circuits, `zone ${z.id} has unknown circuit ${z.circuit}`);

// ------------------------------------------------------------------------------------------------------
section('placement (everything inside a zone, on the nav grid)');
const zl = W.zoneLookup;
const onNav = (p, what, maxD = 0.9) => {
  const k = nav.nearest(p[0], p[1] + 0.1, p[2], 1.5);
  if (!ok(k >= 0, `${what} at ${p.map((v) => v.toFixed(1))} has no nav node nearby`)) return -1;
  const d = Math.hypot(nav.nodeX(k) - p[0], nav.nodeZ(k) - p[2]);
  ok(d <= maxD && Math.abs(nav.nodeY[k] - p[1]) < 0.6, `${what}: nearest nav node ${d.toFixed(2)} m away / dy ${(nav.nodeY[k] - p[1]).toFixed(2)}`);
  return k;
};
const ps = LAYOUT.playerSpawn;
ok(zl.at(ps.pos[0], ps.pos[1] + 1, ps.pos[2]) === W.zoneIndex.get(ps.zone), `player spawn not in zone ${ps.zone}`);
const startNode = onNav(ps.pos, 'player spawn');
const targets = [];
for (const e of LAYOUT.enemies) {
  ok(zl.at(e.pos[0], e.pos[1] + 1, e.pos[2]) >= 0, `enemy ${e.id} outside every zone`);
  targets.push([`enemy ${e.id}`, onNav(e.pos, `enemy ${e.id} (${e.role})`, e.role === 'sleeper' ? 1.4 : 0.9)]);
  (e.patrol ?? []).forEach((w, i) => targets.push([`enemy ${e.id} waypoint ${i}`, onNav([w[0], e.pos[1], w[1]], `enemy ${e.id} waypoint ${i}`)]));
}
for (const m of [...LAYOUT.moments, LAYOUT.extraction]) {
  const b = m.box, c = [(b[0] + b[3]) / 2, b[1] + 1.2, (b[2] + b[5]) / 2];
  ok(zl.at(c[0], c[1], c[2]) >= 0, `trigger ${m.id} centre outside every zone`);
  // reachable: some nav node inside the box
  let found = -1;
  for (let k = 0; k < nav.n && found < 0; k++) {
    const x = nav.nodeX(k), z = nav.nodeZ(k), y = nav.nodeY[k];
    if (x > b[0] && x < b[3] && z > b[2] && z < b[5] && y >= b[1] && y <= b[4]) found = k;
  }
  ok(found >= 0, `trigger ${m.id}: no walkable cell inside its box`);
  targets.push([`trigger ${m.id}`, found]);
}
const zonesWithNav = new Set(Array.from(nav.nodeZone));
for (const z of LAYOUT.zones) warn(zonesWithNav.has(W.zoneIndex.get(z.id)), `zone ${z.id} has no walkable cell`);
let navOut = 0; for (let k = 0; k < nav.n; k++) if (nav.nodeZone[k] < 0) navOut++;
warn(navOut < 50, `${navOut} nav nodes are outside every zone`);

// ------------------------------------------------------------------------------------------------------
section('nav connectivity (doors open)');
const reach = nav.reachable(startNode);
for (const [what, k] of targets) if (k >= 0) ok(reach[k], `${what} not reachable from the player spawn`);
// every door must connect its two sides
for (const [di, d] of W.doors.entries()) {
  let n = 0; for (let k = 0; k < nav.n; k++) if (nav.nodeDoor[k] === di) n++;
  ok(n > 0 || d.y0 < -10, `door ${d.id} has no nav cells (blocked opening?)`);
}
let reachable = 0; for (let k = 0; k < nav.n; k++) reachable += reach[k];
console.log(`  ${reachable}/${nav.n} nav nodes reachable from the spawn`);

// ------------------------------------------------------------------------------------------------------
section('geometry: coplanar overlapping faces (z-fighting), overlapping solids');
{
  const key = (f) => `${f.side}|${f.plane.toFixed(3)}`;
  const groups = new Map();
  for (const [i, f] of W.faces.entries()) { const k = key(f); let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(i); }
  let zf = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => W.faces[a].u0 - W.faces[b].u0);
    for (let x = 0; x < g.length; x++) {
      const A = W.faces[g[x]];
      for (let y = x + 1; y < g.length; y++) {
        const B = W.faces[g[y]];
        if (B.u0 >= A.u1 - 1e-4) break;
        const ou = Math.min(A.u1, B.u1) - Math.max(A.u0, B.u0), ov = Math.min(A.v1, B.v1) - Math.max(A.v0, B.v0);
        if (ou > 1e-3 && ov > 1e-3) {
          zf++;
          if (zf <= 12) console.log(`  FAIL z-fight: box ${A.box} (${W.boxes[A.box].src}/${W.boxes[A.box].group ?? W.boxes[A.box].cls}) side ${A.side} vs box ${B.box} (${W.boxes[B.box].src}/${W.boxes[B.box].group ?? W.boxes[B.box].cls}) at ${A.plane.toFixed(2)}, overlap ${ou.toFixed(2)}x${ov.toFixed(2)}`);
        }
      }
    }
  }
  if (zf) fails++;
  console.log(`  ${zf} coplanar overlapping face pairs`);
  // overlapping solid architecture volumes (cause hidden z-fighting and bake leaks)
  let ov = 0;
  const arch = W.boxes.map((b, i) => [b, i]).filter(([b]) => b.cls === 'arch');
  for (let x = 0; x < arch.length; x++) for (let y = x + 1; y < arch.length; y++) {
    const [a] = arch[x], [b] = arch[y];
    const d = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
    if (d[0] > 1e-3 && d[1] > 1e-3 && d[2] > 1e-3) { ov++; if (ov <= 8) console.log(`  warn overlap ${a.src} / ${b.src} ${d.map((v) => v.toFixed(2))}`); }
  }
  warn(ov === 0, `${ov} overlapping architecture box pairs`);
}

// ------------------------------------------------------------------------------------------------------
section('machines: AGV routes clear of static solids');
for (const r of LAYOUT.agvRoutes) {
  const pts = r.points, n = r.loop ? pts.length : pts.length - 1;
  let hits = 0;
  for (let s = 0; s < n; s++) {
    const A = pts[s], B = pts[(s + 1) % pts.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    for (let t = 0; t <= len; t += 0.25) {
      const x = A[0] + (B[0] - A[0]) * t / len, z = A[1] + (B[1] - A[1]) * t / len;
      let hit = false;
      bvh.query(x - 0.5, 0.05, z - 0.5, x + 0.5, 1.8, z + 0.5, F_SOLID, () => { hit = true; });
      if (hit) hits++;
    }
  }
  ok(hits === 0, `AGV route ${r.id}: ${hits} samples blocked by static geometry`);
}

// ------------------------------------------------------------------------------------------------------
section('bake freshness');
const manPath = 'public/bake/manifest.json';
let man = null;
if (ok(existsSync(manPath), 'no bake found: run `npm run bake`')) {
  man = JSON.parse(readFileSync(manPath, 'utf8'));
  ok(man.hash === W.hash, `bake is stale (bake ${man.hash}, layout ${W.hash}): run \`npm run bake\``);
  warn(!man.quick, 'committed bake is a --quick bake');
}

// ------------------------------------------------------------------------------------------------------
section('budgets (greybox static world, PVS worst case)');
{
  const nz = W.zones.length;
  const triZ = new Float64Array(nz), drawZ = Array.from({ length: nz }, () => new Set());
  // runtime merges per zone: one opaque draw (lightmapped + vertex-lit), one transparent draw (mesh + glass)
  for (const f of W.faces) { triZ[f.zone] += 2; drawZ[f.zone].add(f.render === 'mesh' ? 'trans' : 'opaque'); }
  for (const g of W.glass) { triZ[g.zone] += 4; drawZ[g.zone].add('trans'); }
  let worst = { tris: 0, draws: 0, zone: '' };
  if (man) for (const [zid, vis] of Object.entries(man.pvs)) {
    let tris = 0, draws = 0;
    for (const v of vis) { const i = W.zoneIndex.get(v); tris += triZ[i]; draws += drawZ[i].size; }
    if (tris > worst.tris) worst = { tris, draws, zone: zid };
    ok(tris <= BUDGETS.static.triangles, `zone ${zid}: PVS static triangles ${tris} > ${BUDGETS.static.triangles}`);
    ok(draws <= BUDGETS.static.drawCalls, `zone ${zid}: PVS static draw calls ${draws} > ${BUDGETS.static.drawCalls}`);
  }
  console.log(`  worst PVS zone ${worst.zone}: ${worst.tris} static triangles, ${worst.draws} static draw calls (before frustum culling)`);
  console.log(`  total static triangles ${W.faces.length * 2}, lightmap ${W.lm.width}x${W.lm.height} (${(W.lm.width * W.lm.height * 8 / 1048576).toFixed(1)} MB day+art)`);
}

// ------------------------------------------------------------------------------------------------------
// workstream tests (scripts/test-*.mjs) run after the core suite
const extra = existsSync('scripts') ? readdirSync('scripts').filter((f) => /^test-.*\.mjs$/.test(f)).sort() : [];
for (const f of extra) {
  section(f);
  try { const m = await import(`./${f}`); const r = await m.default?.({ W, bvh, nav, LAYOUT, ok, warn }); if (r === false) fails++; }
  catch (e) { ok(false, `${f} threw: ${e.stack}`); }
}

console.log(`\n${fails ? 'FAILED' : 'OK'}: ${fails} failures, ${warns} warnings (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fails ? 1 : 0);
