import * as THREE from 'three';

// Navigation over level.navGraph: A* with a binary heap, entry/exit at the nearest node with a clear walk,
// string-pulling path smoothing, and circle-vs-AABB collision resolution against level.colliders.
// Pure math, no DOM: usable from Node for tests.

const BODY_LOW = 0.35;   // obstacles lower than this above the feet are stepped over (kerbs, cables)
const BODY_HIGH = 1.7;

export function createNav(level, bodyRadius = 0.3) {
  const nodes = level?.navGraph?.nodes || [];
  const N = nodes.length;
  const adj = Array.from({ length: N }, () => []);
  for (const e of level?.navGraph?.edges || []) {
    const a = e?.[0], b = e?.[1];
    if (a === b || !nodes[a] || !nodes[b]) continue;
    const c = nodes[a].distanceTo(nodes[b]);
    adj[a].push(b, c); adj[b].push(a, c);   // flat [to, cost, to, cost ...]
  }
  const colliders = level?.colliders || [];

  // ---- segment / collision tests ---------------------------------------------------------
  function boxInBand(box, yLow, yHigh) {
    return box.max.y > yLow && box.min.y < yHigh;
  }

  // 2D slab test of segment a->b (XZ) against box expanded by r. Returns true if blocked.
  function segHitsBox(ax, az, bx, bz, box, r) {
    const minX = box.min.x - r, maxX = box.max.x + r, minZ = box.min.z - r, maxZ = box.max.z + r;
    if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX || Math.max(az, bz) < minZ || Math.min(az, bz) > maxZ) return false;
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    if (Math.abs(dx) < 1e-9) { if (ax < minX || ax > maxX) return false; }
    else {
      let u0 = (minX - ax) / dx, u1 = (maxX - ax) / dx;
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
    if (Math.abs(dz) < 1e-9) { if (az < minZ || az > maxZ) return false; }
    else {
      let u0 = (minZ - az) / dz, u1 = (maxZ - az) / dz;
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
    return true;
  }

  function insideRect(x, z, box, r) {
    return x > box.min.x - r && x < box.max.x + r && z > box.min.z - r && z < box.max.z + r;
  }

  /** True if a body of radius r can walk the straight segment a->b without touching a collider. */
  function clearWalk(a, b, r = bodyRadius) {
    const yLow = Math.min(a.y, b.y) + BODY_LOW, yHigh = Math.max(a.y, b.y) + BODY_HIGH;
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (!boxInBand(box, yLow, yHigh)) continue;
      let rr = r;
      // An endpoint already hugging this box (cover spots, wall-side nodes): test it with a thin radius only.
      if (insideRect(a.x, a.z, box, r) || insideRect(b.x, b.z, box, r)) {
        rr = 0.02;
        if (insideRect(a.x, a.z, box, 0) || insideRect(b.x, b.z, box, 0)) continue;
      }
      if (segHitsBox(a.x, a.z, b.x, b.z, box, rr)) return false;
    }
    return true;
  }

  /** Push a circle (XZ) out of colliders. Mutates pos. Returns true if it collided. */
  function resolveCircle(pos, r = bodyRadius) {
    let hit = false;
    const yLow = pos.y + BODY_LOW, yHigh = pos.y + BODY_HIGH;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < colliders.length; i++) {
        const box = colliders[i];
        if (!boxInBand(box, yLow, yHigh)) continue;
        if (!insideRect(pos.x, pos.z, box, r)) continue;
        const cx = Math.min(Math.max(pos.x, box.min.x), box.max.x);
        const cz = Math.min(Math.max(pos.z, box.min.z), box.max.z);
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          if (d >= r) continue;
          pos.x = cx + (dx / d) * r; pos.z = cz + (dz / d) * r;
        } else {
          // centre inside the box: leave along the axis of least penetration
          const pl = pos.x - box.min.x, pr = box.max.x - pos.x, pb = pos.z - box.min.z, pf = box.max.z - pos.z;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) pos.x = box.min.x - r; else if (m === pr) pos.x = box.max.x + r;
          else if (m === pb) pos.z = box.min.z - r; else pos.z = box.max.z + r;
        }
        hit = true;
      }
    }
    return hit;
  }

  // ---- graph queries ---------------------------------------------------------------------
  const _cand = [];
  function nearestNodes(pos, k = 6) {
    _cand.length = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const dx = n.x - pos.x, dz = n.z - pos.z, dy = (n.y - pos.y) * 3;
      _cand.push({ i, d: dx * dx + dz * dz + dy * dy });
    }
    _cand.sort((a, b) => a.d - b.d);
    return _cand.slice(0, k).map((c) => c.i);
  }

  /** Nearest node that can be reached by a straight clear walk (falls back to the nearest one). */
  function nearestVisibleNode(pos, toNode = true) {
    const c = nearestNodes(pos, 8);
    for (const i of c) if (toNode ? clearWalk(pos, nodes[i]) : clearWalk(nodes[i], pos)) return i;
    return c.length ? c[0] : -1;
  }

  // A* state reused across queries (generation counters avoid clearing arrays)
  const g = new Float64Array(N), came = new Int32Array(N), seen = new Uint32Array(N), closed = new Uint32Array(N);
  let gen = 0;
  const heapId = [], heapF = [];
  function hpush(id, f) {
    let i = heapId.length; heapId.push(id); heapF.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapId[i] = heapId[p]; heapF[i] = heapF[p]; i = p;
    }
    heapId[i] = id; heapF[i] = f;
  }
  function hpop() {
    const top = heapId[0];
    const lastId = heapId.pop(), lastF = heapF.pop();
    const n = heapId.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lastF) break;
        heapId[i] = heapId[c]; heapF[i] = heapF[c]; i = c;
      }
      heapId[i] = lastId; heapF[i] = lastF;
    }
    return top;
  }

  function astar(s, e) {
    if (s < 0 || e < 0) return null;
    if (s === e) return [s];
    gen++;
    heapId.length = 0; heapF.length = 0;
    const goal = nodes[e];
    g[s] = 0; came[s] = -1; seen[s] = gen;
    hpush(s, nodes[s].distanceTo(goal));
    let iter = 0;
    while (heapId.length && iter++ < 20000) {
      const n = hpop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (n === e) {
        const out = [];
        for (let c = e; c !== -1; c = came[c]) out.push(c);
        return out.reverse();
      }
      const list = adj[n];
      for (let k = 0; k < list.length; k += 2) {
        const m = list[k];
        if (closed[m] === gen) continue;
        const ng = g[n] + list[k + 1];
        if (seen[m] !== gen || ng < g[m]) {
          seen[m] = gen; g[m] = ng; came[m] = n;
          hpush(m, ng + nodes[m].distanceTo(goal));
        }
      }
    }
    return null;
  }

  /** Greedy string pulling: from each point, jump to the farthest later point with a clear walk. */
  function smooth(pts) {
    const out = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 10);
      for (; j > i + 1; j--) {
        if (Math.abs(pts[j].y - pts[i].y) > 1.2) continue;
        if (clearWalk(pts[i], pts[j])) break;
      }
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /**
   * Path from 'from' to 'to'. Returns an array of waypoints (excluding 'from', ending at 'to'),
   * or null if the graph does not connect them.
   */
  function findPath(from, to) {
    if (Math.abs(from.y - to.y) < 0.6 && clearWalk(from, to)) return [to.clone()];
    if (N === 0) return [to.clone()];
    const s = nearestVisibleNode(from, true);
    const e = nearestVisibleNode(to, false);
    const route = astar(s, e);
    if (!route) return null;
    const pts = [from];
    for (const i of route) pts.push(nodes[i]);
    pts.push(to);
    return smooth(pts).map((p) => p.clone());
  }

  return {
    nodes, adj, colliders, bodyRadius,
    clearWalk, resolveCircle, nearestNodes, nearestVisibleNode, astar, findPath, smooth,
  };
}

/** Random point near 'center' (within radius) that has a clear walk from it, or null. */
export function randomReachableNear(nav, center, radius, tries = 6) {
  const p = new THREE.Vector3();
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2, r = radius * (0.4 + 0.6 * Math.random());
    p.set(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
    if (nav.clearWalk(center, p)) return p;
  }
  return null;
}
