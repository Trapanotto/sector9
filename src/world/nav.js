// Pure (no DOM/WebGL) navigation, cover and visibility helpers built from layout.js data.
// Everything works on plain arrays: boxes are { min:[x,y,z], max:[x,y,z] }, points are [x,y,z].
import { REGIONS, EXTRA_NAV_NODES, groundHeight } from './layout.js';

export const NAV = { step: 2.5, margin: 0.6, nodeRadius: 0.4, edgeRadius: 0.3, maxEdge: 3.8, doorOffset: 0.9 };

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

// Straight walk a->b is clear: no expanded collider crossed and the floor height follows the segment.
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
    if (Math.abs(groundHeight(x, z) - y) > 0.3) return false;
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

function inRegion(x, z, reg) {
  if (x < reg.min[0] || x > reg.max[0] || z < reg.min[1] || z > reg.max[1]) return false;
  for (const [mn, mx] of reg.exclude || []) if (x >= mn[0] && x <= mx[0] && z >= mn[1] && z <= mx[1]) return false;
  return true;
}
const doorRects = [];
// Doorway rectangles count as walkable (they sit inside wall thickness, between regions).
export function registerDoors(doors) {
  doorRects.length = 0;
  for (const d of doors) {
    if (!d.nav) continue;
    const h = d.width / 2, t = 0.25;
    doorRects.push(d.normal === 'z'
      ? { min: [d.center[0] - h, d.center[1] - t], max: [d.center[0] + h, d.center[1] + t] }
      : { min: [d.center[0] - t, d.center[1] - h], max: [d.center[0] + t, d.center[1] + h] });
  }
}
export function inWalkable(x, z) {
  return REGIONS.some((r) => inRegion(x, z, r)) || doorRects.some((r) => inRegion(x, z, r));
}

function linspace(a, b, step, margin) {
  const w = b - a - 2 * margin;
  if (w <= 0.2) return [(a + b) / 2];
  const n = Math.max(1, Math.round(w / step)) + 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + margin + (w * i) / (n - 1));
  return out;
}

export function buildNavGraph(layout, colliders) {
  registerDoors(layout.doors);
  const nodes = [];
  const tryAdd = (x, z) => {
    const p = [x, groundHeight(x, z), z];
    if (!inWalkable(x, z) || pointBlocked(p, colliders)) return false;
    for (const q of nodes) if (Math.hypot(q[0] - x, q[2] - z) < 0.8 && Math.abs(q[1] - p[1]) < 0.5) return false;
    nodes.push(p);
    return true;
  };
  // Doorways first (center + both sides) so they are never deduplicated away.
  for (const d of layout.doors) {
    if (!d.nav) continue;
    const [cx, cz] = d.center;
    tryAdd(cx, cz);
    const o = NAV.doorOffset;
    if (d.normal === 'z') { tryAdd(cx, cz - o); tryAdd(cx, cz + o); }
    else { tryAdd(cx - o, cz); tryAdd(cx + o, cz); }
  }
  for (const [x, z] of EXTRA_NAV_NODES) tryAdd(x, z);
  for (const reg of REGIONS) {
    const step = reg.step ?? NAV.step;
    for (const x of linspace(reg.min[0], reg.max[0], step, NAV.margin)) {
      for (const z of linspace(reg.min[1], reg.max[1], step, NAV.margin)) {
        if (!tryAdd(x, z)) {
          // nudge around obstacles so cluttered areas stay covered
          for (const [ox, oz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7], [0.9, 0.9], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9]]) {
            if (tryAdd(x + ox, z + oz)) break;
          }
        }
      }
    }
  }
  const edges = [];
  let dropped = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a[0] - b[0], a[2] - b[2]);
      if (d > NAV.maxEdge) continue;
      if (walkClear(a, b, colliders)) edges.push([i, j]); else dropped++;
    }
  }
  return { nodes, edges, dropped, components: components(nodes.length, edges) };
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
  const { adj } = graph.components;
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const u = q.shift();
    if (u === to) return true;
    for (const v of adj[u]) if (!seen.has(v)) { seen.add(v); q.push(v); }
  }
  return false;
}

// Cover points: walkable spots 0.55 m beside solid props/pillars that are at least ~0.85 m tall.
export function buildCoverPoints(layout, colliders) {
  const out = [];
  const add = (x, z) => {
    const p = [x, groundHeight(x, z), z];
    if (!inWalkable(x, z) || pointBlocked(p, colliders, 0.32)) return;
    for (const q of out) if (Math.hypot(q[0] - x, q[2] - z) < 1.1) return;
    out.push(p);
  };
  for (const s of layout.solids) {
    if (!s.collide || !s.cover) continue;
    const off = 0.55;
    const sx = s.max[0] - s.min[0], sz = s.max[2] - s.min[2];
    const nx = Math.max(1, Math.round(sx / 1.6)), nz = Math.max(1, Math.round(sz / 1.6));
    for (let i = 0; i < nx; i++) {
      const x = s.min[0] + (sx * (i + 0.5)) / nx;
      add(x, s.min[2] - off); add(x, s.max[2] + off);
    }
    for (let i = 0; i < nz; i++) {
      const z = s.min[2] + (sz * (i + 0.5)) / nz;
      add(s.min[0] - off, z); add(s.max[0] + off, z);
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
