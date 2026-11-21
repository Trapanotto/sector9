// Layered navigation grid (0.5 m cells, multiple floor layers per column) built from the greybox boxes.
// Used by enemies (D) for pathing and by tests for connectivity. Pure (Node + browser), allocation-free queries.
// Owner: core.
import { F_SOLID, F_WALK } from './gen.js';

export const NAV_CELL = 0.5, NAV_STEP = 0.45, NAV_HEIGHT = 1.75, NAV_RADIUS = 0.22;

export function buildNav(world, bvh, opts = {}) {
  const cell = opts.cell ?? NAV_CELL;
  const [bx0, bz0, bx1, bz1] = world.layout.site.bounds;
  const W = Math.ceil((bx1 - bx0) / cell), H = Math.ceil((bz1 - bz0) / cell);
  const colStart = new Int32Array(W * H + 1);
  const ny = [], nzone = [], ncol = [];
  const tops = [];
  let cand = 0;
  const collect = (b) => { tops.push(bvh.bmax[b * 3 + 1]); };
  let blocked = false;
  const block = () => { blocked = true; };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    colStart[c] = ny.length;
    const x = bx0 + (i + 0.5) * cell, z = bz0 + (j + 0.5) * cell;
    tops.length = 0;
    bvh.query(x, -50, z, x, 50, z, F_WALK, collect);
    if (!tops.length) continue;
    tops.sort((a, b) => a - b);
    let last = -1e9;
    for (const h of tops) {
      if (h - last < 0.05) continue;
      last = h;
      blocked = false;
      const r = NAV_RADIUS;
      bvh.query(x - r, h + NAV_STEP, z - r, x + r, h + NAV_HEIGHT, z + r, F_SOLID, block);
      if (blocked) continue;
      // the surface itself must be the top-most at this point within the body height (not inside a thicker box)
      blocked = false;
      bvh.query(x, h + 0.02, z, x, h + 0.3, z, F_SOLID, block);
      if (blocked) continue;
      ny.push(h); ncol.push(c);
      nzone.push(world.zoneLookup.at(x, h + 0.9, z));
      cand++;
    }
  }
  colStart[W * H] = ny.length;
  const n = ny.length;
  const nodeY = Float32Array.from(ny), nodeCol = Int32Array.from(ncol), nodeZone = Int16Array.from(nzone);
  const nodeDoor = new Int16Array(n).fill(-1);
  // doors: nodes inside an opening rect (expanded across the wall)
  world.doors.forEach((d, di) => {
    const ax = d.axis === 'x';
    for (let k = 0; k < n; k++) {
      const c = nodeCol[k], x = bx0 + ((c % W) + 0.5) * cell, z = bz0 + (Math.floor(c / W) + 0.5) * cell;
      const along = ax ? x : z, across = ax ? z : x;
      if (along > d.a && along < d.b && Math.abs(across - d.at) < d.th / 2 + 0.45 && nodeY[k] > d.y0 - 0.5 && nodeY[k] < d.y0 + 0.5) nodeDoor[k] = di;
    }
  });
  // adjacency (8-connected, step limit, diagonals need both orthogonals)
  const findIn = (c, y) => {
    let best = -1, bd = NAV_STEP + 0.06;
    for (let k = colStart[c]; k < colStart[c + 1]; k++) { const d = Math.abs(nodeY[k] - y); if (d < bd) { bd = d; best = k; } }
    return best;
  };
  const adjStart = new Int32Array(n + 1), adj = [], cost = [];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let k = 0; k < n; k++) {
    adjStart[k] = adj.length;
    const c = nodeCol[k], i = c % W, j = Math.floor(c / W), y = nodeY[k];
    for (const [di, dj] of DIRS) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const m = findIn(jj * W + ii, y);
      if (m < 0) continue;
      if (di && dj) {
        const a = findIn(j * W + ii, y), b = findIn(jj * W + i, y);
        if (a < 0 || b < 0) continue;
      }
      adj.push(m); cost.push((di && dj ? Math.SQRT2 : 1) * cell + Math.abs(nodeY[m] - y));
    }
  }
  adjStart[n] = adj.length;
  const nav = {
    cell, W, H, x0: bx0, z0: bz0, n, colStart, nodeY, nodeCol, nodeZone, nodeDoor,
    adjStart, adj: Int32Array.from(adj), adjCost: Float32Array.from(cost),
  };
  return attachNavQueries(nav, world.doors.length);
}

function attachNavQueries(nav, nDoors) {
  const { n, W, cell, x0, z0, colStart, nodeY, nodeCol, adjStart, adj, adjCost, nodeDoor } = nav;
  nav.nodeX = (k) => x0 + ((nodeCol[k] % W) + 0.5) * cell;
  nav.nodeZ = (k) => z0 + (Math.floor(nodeCol[k] / W) + 0.5) * cell;
  /** nearest node to a point (searches a small neighbourhood, prefers the layer just below y). -1 if none. */
  nav.nearest = (x, y, z, radius = 2) => {
    const ci = Math.floor((x - x0) / cell), cj = Math.floor((z - z0) / cell), R = Math.ceil(radius / cell);
    let best = -1, bd = Infinity;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= W || j >= nav.H) continue;
      const c = j * W + i;
      for (let k = colStart[c]; k < colStart[c + 1]; k++) {
        const dy = y - nodeY[k];
        if (dy < -0.6 || dy > 2.5) continue;
        const d = di * di + dj * dj + dy * dy * 4;
        if (d < bd) { bd = d; best = k; }
      }
    }
    return best;
  };
  // A* with preallocated state
  const g = new Float32Array(n), came = new Int32Array(n), stamp = new Uint32Array(n), closed = new Uint32Array(n);
  const heap = new Int32Array(n), hf = new Float32Array(n);
  let gen = 0;
  nav.doorBlocked = new Uint8Array(nDoors);   // set by the world runtime: 1 = locked (impassable)
  /** Path from node a to node b into out (Int32Array of node ids, reversed order b..a). Returns length or 0. */
  nav.findPath = (a, b, out, maxIter = 20000) => {
    if (a < 0 || b < 0) return 0;
    gen++;
    const bx = nav.nodeX(b), bz = nav.nodeZ(b), by = nodeY[b];
    const h = (k) => Math.hypot(nav.nodeX(k) - bx, nav.nodeZ(k) - bz) + Math.abs(nodeY[k] - by);
    let hs = 0;
    const push = (k, f) => { let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; heap[i] = heap[p]; hf[i] = hf[p]; i = p; } heap[i] = k; hf[i] = f; };
    const pop = () => {
      const top = heap[0], lk = heap[--hs], lf = hf[hs];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && hf[c + 1] < hf[c]) c++; if (hf[c] >= lf) break; heap[i] = heap[c]; hf[i] = hf[c]; i = c; }
      heap[i] = lk; hf[i] = lf;
      return top;
    };
    stamp[a] = gen; g[a] = 0; came[a] = -1; push(a, h(a));
    let it = 0;
    while (hs > 0 && it++ < maxIter) {
      const k = pop();
      if (closed[k] === gen) continue;
      closed[k] = gen;
      if (k === b) {
        let len = 0;
        for (let c = b; c >= 0 && len < out.length; c = came[c]) out[len++] = c;
        return len;
      }
      for (let e = adjStart[k]; e < adjStart[k + 1]; e++) {
        const m = adj[e];
        if (closed[m] === gen) continue;
        const d = nodeDoor[m];
        if (d >= 0 && nav.doorBlocked[d]) continue;
        const ng = g[k] + adjCost[e];
        if (stamp[m] !== gen || ng < g[m]) { stamp[m] = gen; g[m] = ng; came[m] = k; push(m, ng + h(m)); }
      }
    }
    return 0;
  };
  /** BFS reachability from node a (ignores locked doors if ignoreLocks). Returns Uint8Array visited. */
  nav.reachable = (a, ignoreLocks = true) => {
    const vis = new Uint8Array(n), q = new Int32Array(n);
    let qh = 0, qt = 0;
    if (a < 0) return vis;
    vis[a] = 1; q[qt++] = a;
    while (qh < qt) {
      const k = q[qh++];
      for (let e = adjStart[k]; e < adjStart[k + 1]; e++) {
        const m = adj[e];
        if (vis[m]) continue;
        if (!ignoreLocks && nodeDoor[m] >= 0 && nav.doorBlocked[nodeDoor[m]]) continue;
        vis[m] = 1; q[qt++] = m;
      }
    }
    return vis;
  };
  return nav;
}
