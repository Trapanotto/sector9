// Pure (no DOM/WebGL) navigation, cover and visibility helpers built from layout.js data.
// Everything works on plain arrays: boxes are { min:[x,y,z], max:[x,y,z] }, points are [x,y,z].
// Floors can be stacked (basement, ground floor, upper storey, catwalks): every query carries a height.
import { REGIONS, RAMPS, EXTRA_NAV_NODES, groundHeight, rampY } from './layout.js';

export const NAV = { step: 2.5, margin: 0.6, nodeRadius: 0.4, edgeRadius: 0.3, maxEdge: 3.8, doorOffset: 0.9, rampStep: 1.1 };

// Boxes that matter for walking at feet height y (ignores things under the feet / far overhead).
function relevant(b, yLo, yHi) {
  return b.max[1] > yLo + 0.35 && b.min[1] < yHi + 1.7;
}

export function pointBlocked(p, boxes, r = NAV.nodeRadius) {
  for (const b of boxes) {
    if (!relevant(b, p[1], p[1])) continue;
    if (p[0] > b.min[0] - r && p[0] < b.max[0] + r && p[2] > b.min[2] - r && p[2] < b.max[2] + r) return true;
  }
  return false;
}

// 2D segment vs AABB expanded by r (slab test in xz).
export function segHitsBox2D(ax, az, bx, bz, b, r) {
  const minX = b.min[0] - r, maxX = b.max[0] + r, minZ = b.min[2] - r, maxZ = b.max[2] + r;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [o, d, lo, hi] of [[ax, dx, minX, maxX], [az, dz, minZ, maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (o <= lo || o >= hi) return false; continue; }
    let u0 = (lo - o) / d, u1 = (hi - o) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 >= t1) return false;
  }
  return true;
}

// Straight walk a->b is clear: no expanded collider crossed and the floor (at the walker's height) follows the segment.
export function walkClear(a, b, boxes, r = NAV.edgeRadius) {
  const yLo = Math.min(a[1], b[1]), yHi = Math.max(a[1], b[1]);
  for (const box of boxes) {
    if (!relevant(box, yLo, yHi)) continue;
    if (segHitsBox2D(a[0], a[2], b[0], b[2], box, r)) return false;
  }
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.max(2, Math.ceil(len / 0.25));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    if (Math.abs(groundHeight(x, z, y + 0.3) - y) > 0.3) return false;
  }
  return true;
}

// 3D segment vs AABB (for line-of-sight against ray-blocking solids).
export function segHitsBox3D(a, b, box) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const o = a[k], d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (o < box.min[k] || o > box.max[k]) return false; continue; }
    let u0 = (box.min[k] - o) / d, u1 = (box.max[k] - o) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}
export function lineOfSight(a, b, rayBoxes) {
  for (const box of rayBoxes) if (segHitsBox3D(a, b, box)) return false;
  return true;
}

// Region containment at a height: flat regions match their floor level, ramps their local slope height.
export function regionY(reg, x, z) {
  return reg.y === 'ramp' ? rampY(RAMPS[reg.ramp], x, z) : reg.y;
}
function inRegion(x, z, reg, y) {
  if (x < reg.min[0] || x > reg.max[0] || z < reg.min[1] || z > reg.max[1]) return false;
  for (const [mn, mx] of reg.exclude || []) if (x >= mn[0] && x <= mx[0] && z >= mn[1] && z <= mx[1]) return false;
  if (y !== undefined && Math.abs(regionY(reg, x, z) - y) > 0.35) return false;
  return true;
}
const doorRects = [];
// Doorway rectangles count as walkable (they sit inside wall thickness, between regions).
export function registerDoors(doors) {
  doorRects.length = 0;
  for (const d of doors) {
    if (!d.nav) continue;
    const h = d.width / 2, t = 0.25, y = d.y || 0;
    doorRects.push(d.normal === 'z'
      ? { min: [d.center[0] - h, d.center[1] - t], max: [d.center[0] + h, d.center[1] + t], y }
      : { min: [d.center[0] - t, d.center[1] - h], max: [d.center[0] + t, d.center[1] + h], y });
  }
}
/** Walkable at (x, z) on the floor at height y (default: ground floor). */
export function inWalkable(x, z, y = 0) {
  return REGIONS.some((r) => inRegion(x, z, r, y)) || doorRects.some((r) => inRegion(x, z, r, y));
}
export function regionAt(x, z, y = 0) {
  return REGIONS.find((r) => inRegion(x, z, r, y)) || null;
}

function linspace(a, b, step, margin) {
  const w = b - a - 2 * margin;
  if (w <= 0.2) return [(a + b) / 2];
  const n = Math.max(1, Math.round(w / step)) + 1;
  if (n < 2) return [(a + b) / 2];
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + margin + (w * i) / (n - 1));
  return out;
}

export function buildNavGraph(layout, colliders) {
  registerDoors(layout.doors);
  const nodes = [];
  const tryAdd = (x, z, yRef) => {
    const p = [x, groundHeight(x, z, yRef + 0.3), z];
    if (Math.abs(p[1] - yRef) > 0.4) return false;
    if (!inWalkable(x, z, p[1]) || pointBlocked(p, colliders)) return false;
    for (const q of nodes) if (Math.hypot(q[0] - x, q[2] - z) < 0.8 && Math.abs(q[1] - p[1]) < 0.5) return false;
    nodes.push(p);
    return true;
  };
  // Doorways first (center + both sides) so they are never deduplicated away.
  for (const d of layout.doors) {
    if (!d.nav) continue;
    const [cx, cz] = d.center, y = d.y || 0;
    tryAdd(cx, cz, y);
    const o = NAV.doorOffset;
    if (d.normal === 'z') { tryAdd(cx, cz - o, y); tryAdd(cx, cz + o, y); }
    else { tryAdd(cx - o, cz, y); tryAdd(cx + o, cz, y); }
  }
  for (const [x, y, z] of EXTRA_NAV_NODES) tryAdd(x, z, y);
  // Stairs: a row of nodes along the centre line plus both ends (ends land on the floors above / below).
  for (const r of RAMPS) {
    const c = (r.c0 + r.c1) / 2, L = Math.abs(r.a1 - r.a0), n = Math.max(2, Math.ceil(L / NAV.rampStep));
    for (let i = -1; i <= n + 1; i++) {
      const t = i / n, a = r.a0 + (r.a1 - r.a0) * t;
      const x = r.axis === 'x' ? a : c, z = r.axis === 'x' ? c : a;
      const y = r.y0 + (r.y1 - r.y0) * Math.min(1, Math.max(0, t));
      tryAdd(x, z, y);
    }
  }
  for (const reg of REGIONS) {
    if (reg.y === 'ramp') continue;
    const step = reg.step ?? NAV.step;
    for (const x of linspace(reg.min[0], reg.max[0], step, NAV.margin)) {
      for (const z of linspace(reg.min[1], reg.max[1], step, NAV.margin)) {
        if (!tryAdd(x, z, reg.y)) {
          // nudge around obstacles so cluttered areas stay covered
          for (const [ox, oz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7], [0.9, 0.9], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9]]) {
            if (tryAdd(x + ox, z + oz, reg.y)) break;
          }
        }
      }
    }
  }
  // Edges: candidate pairs from a spatial hash (xz cells of maxEdge).
  const edges = [];
  let dropped = 0;
  const cell = NAV.maxEdge, grid = new Map();
  const key = (i, k) => i * 100003 + k;
  nodes.forEach((p, i) => {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[2] / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], ci = Math.floor(a[0] / cell), ck = Math.floor(a[2] / cell);
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      for (const j of grid.get(key(ci + di, ck + dk)) || []) {
        if (j <= i) continue;
        const b = nodes[j];
        const d = Math.hypot(a[0] - b[0], a[2] - b[2]);
        if (d > NAV.maxEdge) continue;
        if (Math.abs(a[1] - b[1]) > d * 0.9 + 0.3) { dropped++; continue; }   // steeper than any stair
        if (walkClear(a, b, colliders)) edges.push([i, j]); else dropped++;
      }
    }
  }
  // Drop tiny unreachable pockets (1-2 nodes boxed in by furniture or an open door leaf).
  let comp = components(nodes.length, edges);
  const size = new Map();
  comp.of.forEach((c) => size.set(c, (size.get(c) || 0) + 1));
  const keep = nodes.map((_, i) => size.get(comp.of[i]) > 2);
  const pruned = keep.filter((k) => !k).length;
  if (pruned) {
    const remap = new Map();
    const n2 = [];
    nodes.forEach((p, i) => { if (keep[i]) { remap.set(i, n2.length); n2.push(p); } });
    const e2 = edges.filter(([a, b]) => keep[a] && keep[b]).map(([a, b]) => [remap.get(a), remap.get(b)]);
    nodes.length = 0; nodes.push(...n2);
    edges.length = 0; edges.push(...e2);
    comp = components(nodes.length, edges);
  }
  return { nodes, edges, dropped, pruned, components: comp };
}

export function components(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const comp = new Array(n).fill(-1);
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj[u]) if (comp[v] < 0) { comp[v] = c; stack.push(v); }
    }
    c++;
  }
  return { count: c, of: comp, adj };
}

export function nearestNode(nodes, p, colliders) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const q = nodes[i];
    const d = Math.hypot(q[0] - p[0], q[2] - p[2]) + Math.abs(q[1] - p[1]) * 2;
    if (d < bd && (!colliders || walkClear(p, q, colliders, 0.2))) { bd = d; best = i; }
  }
  return best;
}

export function pathExists(graph, from, to) {
  return shortestPath(graph, from, to) !== null;
}
// BFS path (node indices) or null.
export function shortestPath(graph, from, to, blocked = null) {
  const { adj } = graph.components;
  const prev = new Map([[from, -1]]);
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    if (u === to) {
      const out = [];
      for (let c = to; c !== -1; c = prev.get(c)) out.push(c);
      return out.reverse();
    }
    for (const v of adj[u]) if (!prev.has(v) && !(blocked && blocked(v))) { prev.set(v, u); q.push(v); }
  }
  return null;
}

// Cover points: walkable spots 0.55 m beside solid props/pillars that are at least ~0.85 m tall.
export function buildCoverPoints(layout, colliders) {
  const out = [];
  const add = (x, z, yRef) => {
    const p = [x, groundHeight(x, z, yRef + 0.3), z];
    if (Math.abs(p[1] - yRef) > 0.4) return;
    if (!inWalkable(x, z, p[1]) || pointBlocked(p, colliders, 0.32)) return;
    for (const q of out) if (Math.hypot(q[0] - x, q[2] - z) < 1.1 && Math.abs(q[1] - p[1]) < 1) return;
    out.push(p);
  };
  for (const s of layout.solids) {
    if (!s.collide || !s.cover) continue;
    const off = 0.55, yRef = s.min[1];
    const sx = s.max[0] - s.min[0], sz = s.max[2] - s.min[2];
    const nx = Math.max(1, Math.round(sx / 1.6)), nz = Math.max(1, Math.round(sz / 1.6));
    for (let i = 0; i < nx; i++) {
      const x = s.min[0] + (sx * (i + 0.5)) / nx;
      add(x, s.min[2] - off, yRef); add(x, s.max[2] + off, yRef);
    }
    for (let i = 0; i < nz; i++) {
      const z = s.min[2] + (sz * (i + 0.5)) / nz;
      add(s.min[0] - off, z, yRef); add(s.max[0] + off, z, yRef);
    }
  }
  return out;
}

// Convenience: derive collider / ray-blocker lists and everything pure from the layout.
export function computeWorldData(layout) {
  const colliders = layout.solids.filter((s) => s.collide).map((s) => ({ min: s.min, max: s.max, kind: s.kind }));
  const rayBoxes = layout.solids.filter((s) => s.ray).map((s) => ({ min: s.min, max: s.max, kind: s.kind }));
  const graph = buildNavGraph(layout, colliders);
  const cover = buildCoverPoints(layout, colliders);
  return { colliders, rayBoxes, graph, cover };
}
