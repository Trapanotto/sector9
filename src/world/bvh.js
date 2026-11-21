// Flat AABB BVH over axis-aligned boxes. Shared by the offline bake (Node workers) and the runtime raycasts
// (bullets, line of sight, auto-exposure probes). No allocations per query.
// Owner: core.

export class BoxBVH {
  /** boxes: array of { min:[3], max:[3] }; flags: Uint8Array per box (bit mask filtered per query). */
  constructor(boxes, flags) {
    const n = boxes.length;
    this.n = n;
    this.bmin = new Float32Array(n * 3); this.bmax = new Float32Array(n * 3);
    this.flags = flags ?? new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) { this.bmin.set(boxes[i].min, i * 3); this.bmax.set(boxes[i].max, i * 3); }
    const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    const cap = Math.max(1, 2 * n);
    this.nmin = new Float32Array(cap * 3); this.nmax = new Float32Array(cap * 3);
    this.nleft = new Int32Array(cap);   // leaf: first index into `items`; inner: left child
    this.ncount = new Int32Array(cap);  // leaf: count (>0); inner: 0, right child = left + 1? (stored in nright)
    this.nright = new Int32Array(cap);
    this.items = idx;
    this.nodes = 0;
    const cen = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) cen[i] = (this.bmin[i] + this.bmax[i]) * 0.5;
    this._build(0, n, cen);
    this.stack = new Int32Array(128);
    this.ray = new Float64Array(7);
  }

  _build(start, end, cen) {
    const node = this.nodes++;
    const { bmin, bmax, items } = this;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let k = start; k < end; k++) {
      const i = items[k] * 3;
      if (bmin[i] < x0) x0 = bmin[i]; if (bmin[i + 1] < y0) y0 = bmin[i + 1]; if (bmin[i + 2] < z0) z0 = bmin[i + 2];
      if (bmax[i] > x1) x1 = bmax[i]; if (bmax[i + 1] > y1) y1 = bmax[i + 1]; if (bmax[i + 2] > z1) z1 = bmax[i + 2];
      const a = cen[i], b = cen[i + 1], c = cen[i + 2];
      if (a < cx0) cx0 = a; if (a > cx1) cx1 = a; if (b < cy0) cy0 = b; if (b > cy1) cy1 = b; if (c < cz0) cz0 = c; if (c > cz1) cz1 = c;
    }
    const o = node * 3;
    this.nmin[o] = x0; this.nmin[o + 1] = y0; this.nmin[o + 2] = z0;
    this.nmax[o] = x1; this.nmax[o + 1] = y1; this.nmax[o + 2] = z1;
    const count = end - start;
    if (count <= 4) { this.nleft[node] = start; this.ncount[node] = count; return node; }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    // median split (nth_element via sort of the range: build is offline-ish, fine)
    const sub = Array.from(items.subarray(start, end));
    sub.sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
    items.set(sub, start);
    const mid = (start + end) >> 1;
    this.ncount[node] = 0;
    this.nleft[node] = this._build(start, mid, cen);
    this.nright[node] = this._build(mid, end, cen);
    return node;
  }

  /** Closest hit along the ray (dir need not be normalised; t is in units of |dir|). Returns box index or -1.
   *  out.t, out.side (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z = face that was hit). Boxes containing the origin are
   *  ignored. mask: only boxes with (flags & mask) != 0. skip: box index to ignore (-1 none). */
  raycast(ox, oy, oz, dx, dy, dz, tmax, mask, out, skip = -1) {
    const r = this.ray;
    r[0] = ox; r[1] = oy; r[2] = oz; r[3] = dx; r[4] = dy; r[5] = dz; r[6] = tmax;
    return this.raycastR(mask, out, skip);
  }

  /** Same as raycast(), reading the ray from this.ray (Float64Array: ox,oy,oz,dx,dy,dz,tmax). Hot-path callers
   *  fill this.ray and call raycastR so no doubles are passed (and boxed) as call arguments. */
  raycastR(mask, out, skip = -1) {
    const r = this.ray;
    const ox = r[0], oy = r[1], oz = r[2], dx = r[3], dy = r[4], dz = r[5], tmax = r[6];
    const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
    const { nmin, nmax, nleft, nright, ncount, items, bmin, bmax, flags, stack } = this;
    let sp = 0, best = -1, bestT = tmax, bestSide = 0;
    if (this.n === 0) return -1;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp], o = node * 3;
      // node slab test
      let t0 = (nmin[o] - ox) * ix, t1 = (nmax[o] - ox) * ix;
      let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
      t0 = (nmin[o + 1] - oy) * iy; t1 = (nmax[o + 1] - oy) * iy;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      t0 = (nmin[o + 2] - oz) * iz; t1 = (nmax[o + 2] - oz) * iz;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      if (tf < 0 || tn > tf || tn > bestT) continue;
      const cnt = ncount[node];
      if (cnt > 0) {
        const s = nleft[node];
        for (let k = s; k < s + cnt; k++) {
          const b = items[k];
          if ((flags[b] & mask) === 0 || b === skip) continue;
          const j = b * 3;
          let a0 = (bmin[j] - ox) * ix, a1 = (bmax[j] - ox) * ix;
          let n0 = a0 < a1 ? a0 : a1, f0 = a0 < a1 ? a1 : a0, side = dx > 0 ? 1 : 0;
          a0 = (bmin[j + 1] - oy) * iy; a1 = (bmax[j + 1] - oy) * iy;
          let m = a0 < a1 ? a0 : a1;
          if (m > n0) { n0 = m; side = dy > 0 ? 3 : 2; }
          f0 = Math.min(f0, a0 < a1 ? a1 : a0);
          a0 = (bmin[j + 2] - oz) * iz; a1 = (bmax[j + 2] - oz) * iz;
          m = a0 < a1 ? a0 : a1;
          if (m > n0) { n0 = m; side = dz > 0 ? 5 : 4; }
          f0 = Math.min(f0, a0 < a1 ? a1 : a0);
          if (n0 <= f0 && n0 > 1e-5 && n0 < bestT) { bestT = n0; best = b; bestSide = side; }
        }
      } else {
        // push far child first so the near one is processed first
        const l = nleft[node], r = nright[node];
        const lo = l * 3, ro = r * 3;
        const dl = (nmin[lo] + nmax[lo] - 2 * ox) * dx + (nmin[lo + 1] + nmax[lo + 1] - 2 * oy) * dy + (nmin[lo + 2] + nmax[lo + 2] - 2 * oz) * dz;
        const dr = (nmin[ro] + nmax[ro] - 2 * ox) * dx + (nmin[ro + 1] + nmax[ro + 1] - 2 * oy) * dy + (nmin[ro + 2] + nmax[ro + 2] - 2 * oz) * dz;
        if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
      }
    }
    if (best >= 0) { out.t = bestT; out.side = bestSide; }
    return best;
  }

  /** true if any box (mask) intersects the segment origin → origin + dir * tmax. */
  occluded(ox, oy, oz, dx, dy, dz, tmax, mask) {
    const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
    const { nmin, nmax, nleft, nright, ncount, items, bmin, bmax, flags, stack } = this;
    if (this.n === 0) return false;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp], o = node * 3;
      let t0 = (nmin[o] - ox) * ix, t1 = (nmax[o] - ox) * ix;
      let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
      t0 = (nmin[o + 1] - oy) * iy; t1 = (nmax[o + 1] - oy) * iy;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      t0 = (nmin[o + 2] - oz) * iz; t1 = (nmax[o + 2] - oz) * iz;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      if (tf < 0 || tn > tf || tn > tmax) continue;
      const cnt = ncount[node];
      if (cnt > 0) {
        const s = nleft[node];
        for (let k = s; k < s + cnt; k++) {
          const b = items[k];
          if ((flags[b] & mask) === 0) continue;
          const j = b * 3;
          let a0 = (bmin[j] - ox) * ix, a1 = (bmax[j] - ox) * ix;
          let n0 = a0 < a1 ? a0 : a1, f0 = a0 < a1 ? a1 : a0;
          a0 = (bmin[j + 1] - oy) * iy; a1 = (bmax[j + 1] - oy) * iy;
          n0 = Math.max(n0, a0 < a1 ? a0 : a1); f0 = Math.min(f0, a0 < a1 ? a1 : a0);
          a0 = (bmin[j + 2] - oz) * iz; a1 = (bmax[j + 2] - oz) * iz;
          n0 = Math.max(n0, a0 < a1 ? a0 : a1); f0 = Math.min(f0, a0 < a1 ? a1 : a0);
          if (n0 <= f0 && n0 > 1e-5 && n0 < tmax) return true;
        }
      } else { stack[sp++] = nleft[node]; stack[sp++] = nright[node]; }
    }
    return false;
  }

  /** Visit every box (mask) overlapping the AABB; cb(boxIndex). Allocation-free. */
  query(x0, y0, z0, x1, y1, z1, mask, cb) {
    const { nmin, nmax, nleft, nright, ncount, items, bmin, bmax, flags, stack } = this;
    if (this.n === 0) return;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp], o = node * 3;
      if (nmin[o] > x1 || nmax[o] < x0 || nmin[o + 1] > y1 || nmax[o + 1] < y0 || nmin[o + 2] > z1 || nmax[o + 2] < z0) continue;
      const cnt = ncount[node];
      if (cnt > 0) {
        const s = nleft[node];
        for (let k = s; k < s + cnt; k++) {
          const b = items[k], j = b * 3;
          if ((flags[b] & mask) === 0) continue;
          if (bmin[j] > x1 || bmax[j] < x0 || bmin[j + 1] > y1 || bmax[j + 1] < y0 || bmin[j + 2] > z1 || bmax[j + 2] < z0) continue;
          cb(b);
        }
      } else { stack[sp++] = nleft[node]; stack[sp++] = nright[node]; }
    }
  }
}
