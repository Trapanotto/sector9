// Cover points, generated once from the nav grid + box BVH (pure: Node tests and browser). A cover point is a nav
// node on a 1 m lattice with an opaque solid right next to it, at crouch height (low cover: pallets, cartons,
// tables) and/or standing height (high cover: racking uprights with load, walls, door frames, machines).
// Queries rank candidates cheaply and validate the best few with real line-of-sight rays. Owner: D.
import { F_OCC } from '../world/gen.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b);

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CELL = 4;

export function buildCover(nav, bvh, bounds) {
  const xs = [], ys = [], zs = [], bits = [], nodes = [];
  let hit = false;
  const onHit = () => { hit = true; };
  const q = (x0, y0, z0, x1, y1, z1) => { hit = false; bvh.query(x0, y0, z0, x1, y1, z1, F_OCC, onHit); return hit; };
  for (let k = 0; k < nav.n; k++) {
    const c = nav.nodeCol[k], i = c % nav.W, j = (c / nav.W) | 0;
    if ((i & 1) || (j & 1) || nav.nodeDoor[k] >= 0) continue;
    const x = nav.nodeX(k), z = nav.nodeZ(k), y = nav.nodeY[k];
    let b = 0;
    for (let d = 0; d < 4; d++) {
      const cx = x + DIRS[d][0] * 0.5, cz = z + DIRS[d][1] * 0.5;
      const low = q(cx - 0.1, y + 0.55, cz - 0.1, cx + 0.1, y + 0.95, cz + 0.1);
      if (!low) continue;
      b |= 1 << d;
      // high: something opaque at chest/head height too (a little wider: rack uprights are thin)
      if (q(cx - 0.18, y + 1.3, cz - 0.18, cx + 0.18, y + 1.65, cz + 0.18)) b |= 16 << d;
    }
    if (!b) continue;
    xs.push(x); ys.push(y); zs.push(z); bits.push(b); nodes.push(k);
  }
  const n = xs.length;
  const [bx0, bz0, bx1, bz1] = bounds;
  const W = Math.ceil((bx1 - bx0) / CELL), H = Math.ceil((bz1 - bz0) / CELL);
  const cellOf = (x, z) => Math.max(0, Math.min(H - 1, Math.floor((z - bz0) / CELL))) * W + Math.max(0, Math.min(W - 1, Math.floor((x - bx0) / CELL)));
  const counts = new Int32Array(W * H + 1);
  for (let p = 0; p < n; p++) counts[cellOf(xs[p], zs[p]) + 1]++;
  for (let c = 0; c < W * H; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(n), fill = counts.slice();
  for (let p = 0; p < n; p++) items[fill[cellOf(xs[p], zs[p])]++] = p;
  return {
    n, x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), bits: Uint8Array.from(bits),
    node: Int32Array.from(nodes), owner: new Int16Array(n).fill(-1),
    cellStart: counts, items, W, H, x0: bx0, z0: bz0, cell: CELL,
  };
}

/**
 * Rank cover points around (ex,ey,ez) against a threat at (tx,ty,tz). mode: 'cover' (near, protected),
 * 'retreat' (farther from the threat than now), 'flank' (off-axis from the current line of fire),
 * 'flee' (far away). Validates candidates with los(). Returns the cover index or -1. Allocation-free
 * (scratch arrays in `s`).
 */
export function findCover(C, s, los, e, ex, ey, ez, tx, ty, tz, mode, selfId, maxR = 12) {
  const cnt = rankCover(C, s, e, ex, ey, ez, tx, ty, tz, mode, selfId, maxR);
  // validate the best few: the threat must NOT see our hiding body, and we must be able to fire from it
  const A = s.a, B = s.b;
  for (let r = 0; r < cnt && r < 5; r++) {
    const p = s.best[r];
    const px = C.x[p], py = C.y[p], pz = C.z[p];
    const high = C.bits[p] >> 4;
    A.x = tx; A.y = ty; A.z = tz;
    B.x = px; B.y = py + (high ? 1.35 : 0.8); B.z = pz;
    if (los(A, B)) continue;          // exposed
    if (mode === 'flee') return p;
    // peek check: stand up over low cover, or step out sideways from high cover
    if (!high) { B.y = py + 1.55; if (los(A, B)) return p; continue; }
    const dx = tx - px, dz = tz - pz, l = hyp(dx, dz) || 1;
    for (let si = 0; si < 2; si++) {
      const sgn = si ? -1 : 1;
      B.x = px - dz / l * 0.7 * sgn; B.z = pz + dx / l * 0.7 * sgn; B.y = py + 1.5;
      if (los(A, B)) { s.side = sgn; return p; }
    }
  }
  return -1;
}

function rankCover(C, s, e, ex, ey, ez, tx, ty, tz, mode, selfId, maxR) {
  const best = s.best, score = s.score, K = best.length;
  let cnt = 0;
  const dT0 = hyp(ex - tx, ez - tz);
  const ci0 = Math.floor((ex - maxR - C.x0) / C.cell), ci1 = Math.floor((ex + maxR - C.x0) / C.cell);
  const cj0 = Math.floor((ez - maxR - C.z0) / C.cell), cj1 = Math.floor((ez + maxR - C.z0) / C.cell);
  for (let cj = Math.max(0, cj0); cj <= Math.min(C.H - 1, cj1); cj++) for (let ci = Math.max(0, ci0); ci <= Math.min(C.W - 1, ci1); ci++) {
    const c = cj * C.W + ci;
    for (let q = C.cellStart[c]; q < C.cellStart[c + 1]; q++) {
      const p = C.items[q];
      if (C.owner[p] >= 0 && C.owner[p] !== selfId) continue;
      const py = C.y[p];
      if (Math.abs(py - ey) > 1.0) continue;
      const px = C.x[p], pz = C.z[p];
      const dE = hyp(px - ex, pz - ez);
      if (dE > maxR) continue;
      const dx = tx - px, dz = tz - pz, dT = hyp(dx, dz);
      if (dT < 3.5) continue;
      // a blocking side must face the threat
      const ux = dx / dT, uz = dz / dT, b = C.bits[p];
      let face = 0;
      for (let d = 0; d < 4; d++) if (b & (1 << d)) { const f = DIRS[d][0] * ux + DIRS[d][1] * uz; if (f > face) face = f; }
      if (face < 0.55) continue;
      let sc;
      if (mode === 'cover') sc = dE * 1.2 + Math.abs(dT - 11) * 0.35 - face * 2;
      else if (mode === 'retreat') { if (dT < dT0 + 4) continue; sc = dE * 0.6 - face * 2 + Math.abs(dT - (dT0 + 8)) * 0.2; }
      else if (mode === 'flee') { if (dT < 16) continue; sc = -dT * 0.5 + dE * 0.2; }
      else { // flank: off-axis relative to the current line threat→self, still in range
        const ax = (ex - tx) / (dT0 || 1), az = (ez - tz) / (dT0 || 1);
        const cosA = -(ux * ax + uz * az);   // direction threat→point vs threat→self
        if (cosA > 0.55 || dT > 16) continue;
        sc = dE * 0.5 + Math.abs(dT - 8) * 0.4 + cosA * 6 - face;
      }
      if (b >> 4) sc -= 0.8;   // prefer high cover a little
      // insert into the K best (ascending score)
      let i = cnt < K ? cnt++ : K;
      if (i === K) { if (sc >= score[K - 1]) continue; i = K - 1; }
      while (i > 0 && score[i - 1] > sc) { score[i] = score[i - 1]; best[i] = best[i - 1]; i--; }
      score[i] = sc; best[i] = p;
    }
  }
  return cnt;
}

export function coverScratch() {
  return { best: new Int32Array(8), score: new Float32Array(8), a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, side: 1 };
}
