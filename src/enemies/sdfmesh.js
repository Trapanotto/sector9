// Signed-distance modelling + surface-nets polygonisation for the procedural characters.
// Pure JS (no DOM, no three.js) so it runs in Node for the self-test.
//
// A "component" is { sdf(x,y,z) in its own frame, frame: Float64Array(16) local->patch (column-major) or null,
// bbox:[minx,miny,minz,maxx,maxy,maxz] in its own frame, k: smooth-union radius, op: 'add'|'sub', ...user data }.
// A patch evaluates its components on a regular grid in the patch frame (smooth union / subtraction in list order),
// clips with half-spaces and extracts a smooth quad mesh (naive surface nets + Newton projection onto the surface).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mix = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

// ---------------------------------------------------------------------------------------------
// Primitives (all return a signed distance; approximations are fine as long as they are smooth near the surface)
// ---------------------------------------------------------------------------------------------
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const ax = x / rx, ay = y / ry, az = z / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx, by = ay / ry, bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

/** Capsule from a to b with radius ra at a and rb at b (linear taper, approximate). */
export function sdCone(x, y, z, a, b, ra, rb) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const pax = x - a[0], pay = y - a[1], paz = z - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  let h = l2 > 0 ? (pax * bax + pay * bay + paz * baz) / l2 : 0;
  h = clamp(h, 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}

export function sdRoundBox(x, y, z, hx, hy, hz, r) {
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Torus in the XZ plane (around Y). */
export function sdTorus(x, y, z, R, r) {
  const q = Math.sqrt(x * x + z * z) - R;
  return Math.sqrt(q * q + y * y) - r;
}

/**
 * Lofted generalised cylinder along the local Y axis (t = sign * y). keys: [t, rx, rzFront, rzBack, cx, cz] sorted by t.
 * Cross-sections are (asymmetric) ellipses, parameters Catmull-Rom interpolated through a lookup table.
 * mod(t, ex, ez, out) may add a radial offset (folds, muscles).
 */
export function makeProfile(keys, sign = 1, mod = null, N = 96) {
  const t0 = keys[0][0], t1 = keys[keys.length - 1][0];
  const tab = new Float64Array(N * 5);
  const cr = (p0, p1, p2, p3, u) => {
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  };
  for (let i = 0; i < N; i++) {
    const t = t0 + ((t1 - t0) * i) / (N - 1);
    let s = 0;
    while (s < keys.length - 2 && keys[s + 1][0] < t) s++;
    const k1 = keys[s], k2 = keys[s + 1];
    const k0 = keys[Math.max(0, s - 1)], k3 = keys[Math.min(keys.length - 1, s + 2)];
    const u = clamp((t - k1[0]) / Math.max(1e-9, k2[0] - k1[0]), 0, 1);
    for (let c = 0; c < 5; c++) {
      let v = cr(k0[c + 1], k1[c + 1], k2[c + 1], k3[c + 1], u);
      const lo = Math.min(k1[c + 1], k2[c + 1]), hi = Math.max(k1[c + 1], k2[c + 1]);
      if (c < 3) v = clamp(v, lo - (hi - lo) * 0.15, hi + (hi - lo) * 0.15);   // limit overshoot
      tab[i * 5 + c] = v;
    }
  }
  let maxR = 0, minCx = 0, maxCx = 0, minCz = 0, maxCz = 0;
  for (let i = 0; i < N; i++) {
    maxR = Math.max(maxR, tab[i * 5], tab[i * 5 + 1], tab[i * 5 + 2]);
    minCx = Math.min(minCx, tab[i * 5 + 3]); maxCx = Math.max(maxCx, tab[i * 5 + 3]);
    minCz = Math.min(minCz, tab[i * 5 + 4]); maxCz = Math.max(maxCz, tab[i * 5 + 4]);
  }
  const sec = new Float64Array(5);
  function sdf(x, y, z) {
    const t = sign * y;
    const f = clamp((t - t0) / (t1 - t0), 0, 1) * (N - 1);
    const i = Math.min(N - 2, f | 0), u = f - i;
    for (let c = 0; c < 5; c++) sec[c] = tab[i * 5 + c] + (tab[i * 5 + 5 + c] - tab[i * 5 + c]) * u;
    const ex = x - sec[3], ez = z - sec[4];
    let rx = sec[0], rz = ez > 0 ? sec[1] : sec[2];
    if (mod) {
      const m = mod(t, ex, ez);
      rx += m; rz += m;
    }
    rx = Math.max(rx, 0.002); rz = Math.max(rz, 0.002);
    const ax = ex / rx, az = ez / rz;
    const k0 = Math.sqrt(ax * ax + az * az);
    const bx = ax / rx, bz = az / rz;
    const k1 = Math.sqrt(bx * bx + bz * bz);
    const dr = k1 < 1e-9 ? -Math.min(rx, rz) : (k0 * (k0 - 1)) / k1;
    const da = Math.max(t0 - t, t - t1);
    if (da > 0 && dr > 0) return Math.sqrt(da * da + dr * dr);
    return Math.max(dr, da);
  }
  const pad = maxR + 0.03;
  const ylo = sign > 0 ? t0 : -t1, yhi = sign > 0 ? t1 : -t0;
  sdf.bbox = [minCx - pad, ylo - 0.01, minCz - pad, maxCx + pad, yhi + 0.01, maxCz + pad];
  return sdf;
}

// ---------------------------------------------------------------------------------------------
// Matrix helpers (column-major 4x4 like THREE.Matrix4.elements)
// ---------------------------------------------------------------------------------------------
export function mulPoint(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
export function mulDir(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[4] * y + m[8] * z;
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z;
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}
export function invertRigid(m) {
  // inverse of a rotation+translation matrix
  const r = new Float64Array(16);
  r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
  r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
  r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
  r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
  r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
  r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  r[15] = 1;
  return r;
}
export function mulMat(a, b) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Patch: field evaluation + surface nets
// ---------------------------------------------------------------------------------------------
const _p = new Float64Array(3);

/**
 * @param patch { comps: Component[], toLocal(comp): Float64Array patch->component, clips: [{m: patch->frame, n:[3], d}],
 *               box:[minx..maxz] in patch frame, h: cell size }
 */
export function preparePatch(patch) {
  const h = patch.h;
  const margin = (c) => Math.max(c.k || 0, 0) + 2.5 * h + (c.margin || 0);
  for (const c of patch.comps) {
    // patch->component transform and component AABB in the patch frame
    c._m = c.toLocal;
    const bb = c.bbox, mInv = c.toPatch;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < 8; i++) {
      mulPoint(mInv, i & 1 ? bb[3] : bb[0], i & 2 ? bb[4] : bb[1], i & 4 ? bb[5] : bb[2], _p);
      mnx = Math.min(mnx, _p[0]); mny = Math.min(mny, _p[1]); mnz = Math.min(mnz, _p[2]);
      mxx = Math.max(mxx, _p[0]); mxy = Math.max(mxy, _p[1]); mxz = Math.max(mxz, _p[2]);
    }
    const g = margin(c);
    c._bb = [mnx - g, mny - g, mnz - g, mxx + g, mxy + g, mxz + g];
  }
  return patch;
}

function inBB(bb, x, y, z) {
  return x >= bb[0] && x <= bb[3] && y >= bb[1] && y <= bb[4] && z >= bb[2] && z <= bb[5];
}

/** Distance of one component at a patch-frame point (Infinity outside its influence box). */
export function compDist(c, x, y, z) {
  if (!inBB(c._bb, x, y, z)) return Infinity;
  const m = c._m;
  return c.sdf(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
}

function clipDist(patch, x, y, z) {
  let d = -Infinity;
  for (const cl of patch.clips || []) {
    const m = cl.m;
    const lx = m[0] * x + m[4] * y + m[8] * z + m[12], ly = m[1] * x + m[5] * y + m[9] * z + m[13], lz = m[2] * x + m[6] * y + m[10] * z + m[14];
    d = Math.max(d, cl.n[0] * lx + cl.n[1] * ly + cl.n[2] * lz - cl.d);
  }
  return d;
}

const FAR = 1e3;
export function fieldAt(patch, x, y, z) {
  let f = FAR;
  for (const c of patch.comps) {
    const d = compDist(c, x, y, z);
    if (d === Infinity) continue;
    if (c.op === 'sub') f = smax(f, -d, c.k || 0);
    else if (c.op === 'int') f = smax(f, d, c.k || 0);
    else f = smin(f, d, c.k || 0);
  }
  return Math.max(f, clipDist(patch, x, y, z));
}

export function gradAt(patch, x, y, z, e, out) {
  out[0] = fieldAt(patch, x + e, y, z) - fieldAt(patch, x - e, y, z);
  out[1] = fieldAt(patch, x, y + e, z) - fieldAt(patch, x, y - e, z);
  out[2] = fieldAt(patch, x, y, z + e) - fieldAt(patch, x, y, z - e);
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return l / (2 * e);
}

/**
 * Quadric-error mesh simplification by half-edge collapse (a vertex merges into a neighbour, so per-vertex
 * attributes stay exact). Vertices with different `group` never merge; a vertex on a group border only slides
 * along that border. Returns { idx: Uint32Array, keep: Int32Array old->new (-1 removed), count }.
 */
export function decimate(pos, idx, group, targetTris, maxError = 1e-3) {
  const nv = pos.length / 3, nf = idx.length / 3;
  const F = Int32Array.from(idx);
  const alive = new Uint8Array(nf).fill(1);
  const Q = new Float64Array(nv * 10);
  // vertex -> faces (CSR start + growable lists)
  const vf = new Array(nv);
  for (let v = 0; v < nv; v++) vf[v] = [];
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    vf[a].push(f); vf[b].push(f); vf[c].push(f);
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-14) continue;
    const area = l * 0.5;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * ax + ny * ay + nz * az);
    for (let k = 0; k < 3; k++) {
      const o = F[f * 3 + k] * 10;
      Q[o] += nx * nx * area; Q[o + 1] += nx * ny * area; Q[o + 2] += nx * nz * area; Q[o + 3] += nx * d * area;
      Q[o + 4] += ny * ny * area; Q[o + 5] += ny * nz * area; Q[o + 6] += ny * d * area;
      Q[o + 7] += nz * nz * area; Q[o + 8] += nz * d * area; Q[o + 9] += d * d * area;
    }
  }
  const border = new Uint8Array(nv);
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    if (group[a] !== group[b] || group[a] !== group[c]) { border[a] = 1; border[b] = 1; border[c] = 1; }
  }
  const err = (u, v) => {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const o = u * 10, p = v * 10;
    const q0 = Q[o] + Q[p], q1 = Q[o + 1] + Q[p + 1], q2 = Q[o + 2] + Q[p + 2], q3 = Q[o + 3] + Q[p + 3], q4 = Q[o + 4] + Q[p + 4];
    const q5 = Q[o + 5] + Q[p + 5], q6 = Q[o + 6] + Q[p + 6], q7 = Q[o + 7] + Q[p + 7], q8 = Q[o + 8] + Q[p + 8], q9 = Q[o + 9] + Q[p + 9];
    return q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9;
  };
  const allowed = (u, v) => group[u] === group[v] && (!border[u] || border[v]);

  // min-heap in typed arrays; entries are invalidated by per-vertex stamps
  let cap = nf * 4, size = 0;
  let hc = new Float64Array(cap), hu = new Int32Array(cap), hv = new Int32Array(cap), hsu = new Int32Array(cap), hsv = new Int32Array(cap);
  const stamp = new Int32Array(nv);
  const grow = () => {
    cap *= 2;
    const r = (A, T) => { const B = new T(cap); B.set(A); return B; };
    hc = r(hc, Float64Array); hu = r(hu, Int32Array); hv = r(hv, Int32Array); hsu = r(hsu, Int32Array); hsv = r(hsv, Int32Array);
  };
  const swap = (i, j) => {
    let t = hc[i]; hc[i] = hc[j]; hc[j] = t;
    t = hu[i]; hu[i] = hu[j]; hu[j] = t; t = hv[i]; hv[i] = hv[j]; hv[j] = t;
    t = hsu[i]; hsu[i] = hsu[j]; hsu[j] = t; t = hsv[i]; hsv[i] = hsv[j]; hsv[j] = t;
  };
  const push = (u, v) => {
    if (!allowed(u, v)) return;
    if (size >= cap) grow();
    let i = size++;
    hc[i] = err(u, v); hu[i] = u; hv[i] = v; hsu[i] = stamp[u]; hsv[i] = stamp[v];
    while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= hc[i]) break; swap(p, i); i = p; }
  };
  const popTop = () => {
    size--;
    if (size > 0) {
      swap(0, size);
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < size && hc[l] < hc[m]) m = l;
        if (r < size && hc[r] < hc[m]) m = r;
        if (m === i) break;
        swap(m, i); i = m;
      }
    }
  };
  const nbA = [], nbB = [];
  const neighbours = (u, out) => {
    out.length = 0;
    const L = vf[u];
    for (let i = 0; i < L.length; i++) {
      const f = L[i];
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== u && out.indexOf(w) < 0) out.push(w); }
    }
    return out;
  };
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = F[f * 3 + k], b = F[f * 3 + (k + 1) % 3];
      push(a, b); push(b, a);
    }
  }

  let tris = nf;
  const removed = new Uint8Array(nv);
  while (tris > targetTris && size > 0) {
    const c = hc[0], u = hu[0], v = hv[0], su = hsu[0], sv = hsv[0];
    popTop();
    if (c > maxError) break;
    if (removed[u] || removed[v] || su !== stamp[u] || sv !== stamp[v]) continue;
    neighbours(u, nbA);
    if (nbA.indexOf(v) < 0) continue;
    neighbours(v, nbB);
    let shared = 0;
    for (let i = 0; i < nbA.length; i++) if (nbB.indexOf(nbA[i]) >= 0) shared++;
    if (shared !== 2) continue;
    // reject flips / slivers
    const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
    let ok = true;
    const L = vf[u];
    for (let i = 0; i < L.length && ok; i++) {
      const f = L[i];
      if (!alive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], cc = F[f * 3 + 2];
      if (a === v || b === v || cc === v) continue;
      // corners in face winding order, starting at u
      const o1 = a === u ? b : b === u ? cc : a, o2 = a === u ? cc : b === u ? a : b;
      const x1 = pos[o1 * 3], y1 = pos[o1 * 3 + 1], z1 = pos[o1 * 3 + 2];
      const x2 = pos[o2 * 3], y2 = pos[o2 * 3 + 1], z2 = pos[o2 * 3 + 2];
      const x0 = pos[u * 3], y0 = pos[u * 3 + 1], z0 = pos[u * 3 + 2];
      const n0x = (y1 - y0) * (z2 - z0) - (z1 - z0) * (y2 - y0), n0y = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0), n0z = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      const n1x = (y1 - py) * (z2 - pz) - (z1 - pz) * (y2 - py), n1y = (z1 - pz) * (x2 - px) - (x1 - px) * (z2 - pz), n1z = (x1 - px) * (y2 - py) - (y1 - py) * (x2 - px);
      const l0 = Math.sqrt(n0x * n0x + n0y * n0y + n0z * n0z), l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
      if (l1 < 1e-12 || (n0x * n1x + n0y * n1y + n0z * n1z) < 0.3 * l0 * l1) ok = false;
    }
    if (!ok) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L[i];
      if (!alive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], cc = F[f * 3 + 2];
      if (a === v || b === v || cc === v) { alive[f] = 0; tris--; continue; }
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === u) F[f * 3 + k] = v;
      vf[v].push(f);
    }
    removed[u] = 1;
    for (let i = 0; i < 10; i++) Q[v * 10 + i] += Q[u * 10 + i];
    stamp[v]++;
    neighbours(v, nbA);
    for (let i = 0; i < nbA.length; i++) { push(v, nbA[i]); push(nbA[i], v); }
  }
  const keep = new Int32Array(nv).fill(-1);
  let count = 0;
  const out = [];
  for (let f = 0; f < nf; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const w = F[f * 3 + k];
      if (keep[w] < 0) keep[w] = count++;
      out.push(keep[w]);
    }
  }
  return { idx: new Uint32Array(out), keep, count };
}

/**
 * Move vertices onto the zero set (Newton steps along the field gradient) and write gradient normals.
 * Forward differences keep it at ~5 field evaluations per vertex per step.
 */
export function projectVertices(patch, pos, nrm, iters = 2) {
  const h = patch.h, e = h * 0.3;
  const nv = pos.length / 3;
  for (let v = 0; v < nv; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let gx = 0, gy = 1, gz = 0;
    for (let it = 0; it < iters; it++) {
      const f = fieldAt(patch, x, y, z);
      gx = fieldAt(patch, x + e, y, z) - f; gy = fieldAt(patch, x, y + e, z) - f; gz = fieldAt(patch, x, y, z + e) - f;
      const gl = Math.hypot(gx, gy, gz) / e;
      if (!(gl > 0.2)) break;
      gx /= gl * e; gy /= gl * e; gz /= gl * e;
      const step = clamp(f / gl, -h * 0.45, h * 0.45);
      x -= gx * step; y -= gy * step; z -= gz * step;
      if (Math.abs(f) < h * 0.01) break;
    }
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    const l = Math.hypot(gx, gy, gz) || 1;
    nrm[v * 3] = gx / l; nrm[v * 3 + 1] = gy / l; nrm[v * 3 + 2] = gz / l;
  }
}

/** Polygonise a prepared patch. Returns { pos: Float32Array (cell-averaged, not yet projected), idx: Uint32Array } in the patch frame. */
export function meshPatch(patch) {
  preparePatch(patch);
  const h = patch.h, B = patch.box;
  const nx = Math.ceil((B[3] - B[0]) / h) + 1, ny = Math.ceil((B[4] - B[1]) / h) + 1, nz = Math.ceil((B[5] - B[2]) / h) + 1;
  const ox = B[0], oy = B[1], oz = B[2];
  const sx = 1, sy = nx, sz = nx * ny;
  const F = new Float32Array(nx * ny * nz).fill(FAR);
  // splat components in order
  for (const c of patch.comps) {
    const bb = c._bb;
    const i0 = Math.max(0, Math.floor((bb[0] - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((bb[3] - ox) / h));
    const j0 = Math.max(0, Math.floor((bb[1] - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((bb[4] - oy) / h));
    const k0 = Math.max(0, Math.floor((bb[2] - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((bb[5] - oz) / h));
    const m = c._m, k = c.k || 0, op = c.op;
    for (let kk = k0; kk <= k1; kk++) {
      const z = oz + kk * h;
      for (let jj = j0; jj <= j1; jj++) {
        const y = oy + jj * h;
        let idx = kk * sz + jj * sy + i0;
        for (let ii = i0; ii <= i1; ii++, idx++) {
          const x = ox + ii * h;
          if (!inBB(bb, x, y, z)) continue;
          const d = c.sdf(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
          const f = F[idx];
          F[idx] = op === 'sub' ? smax(f, -d, k) : op === 'int' ? smax(f, d, k) : smin(f, d, k);
        }
      }
    }
  }
  if (patch.clips?.length) {
    for (let kk = 0; kk < nz; kk++) for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
      const idx = kk * sz + jj * sy + ii;
      F[idx] = Math.max(F[idx], clipDist(patch, ox + ii * h, oy + jj * h, oz + kk * h));
    }
  }
  // grid border is always outside
  for (let kk = 0; kk < nz; kk++) for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
    if (ii === 0 || jj === 0 || kk === 0 || ii === nx - 1 || jj === ny - 1 || kk === nz - 1) F[kk * sz + jj * sy + ii] = Math.max(F[kk * sz + jj * sy + ii], h);
  }

  // vertices: one per cell with a sign change
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const csy = nx - 1, csz = (nx - 1) * (ny - 1);
  const verts = [];
  const cornerOff = [];
  for (let c = 0; c < 8; c++) cornerOff.push([(c & 1), (c >> 1) & 1, (c >> 2) & 1]);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let kk = 0; kk < nz - 1; kk++) for (let jj = 0; jj < ny - 1; jj++) for (let ii = 0; ii < nx - 1; ii++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const o = cornerOff[c];
      const v = F[(kk + o[2]) * sz + (jj + o[1]) * sy + ii + o[0]];
      cv[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, n = 0;
    for (const [a, b] of EDGES) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      const oa = cornerOff[a], ob = cornerOff[b];
      ax += oa[0] + (ob[0] - oa[0]) * t; ay += oa[1] + (ob[1] - oa[1]) * t; az += oa[2] + (ob[2] - oa[2]) * t;
      n++;
    }
    cellV[kk * csz + jj * csy + ii] = verts.length / 3;
    verts.push(ox + (ii + ax / n) * h, oy + (jj + ay / n) * h, oz + (kk + az / n) * h);
  }
  const nv = verts.length / 3;
  const pos = new Float32Array(verts);
  // faces: for every grid edge with a sign change, connect the 4 cells around it
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // split along the shorter diagonal
    const dac = (pos[a * 3] - pos[c * 3]) ** 2 + (pos[a * 3 + 1] - pos[c * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[c * 3 + 2]) ** 2;
    const dbd = (pos[b * 3] - pos[d * 3]) ** 2 + (pos[b * 3 + 1] - pos[d * 3 + 1]) ** 2 + (pos[b * 3 + 2] - pos[d * 3 + 2]) ** 2;
    let t1, t2;
    if (dac <= dbd) { t1 = [a, b, c]; t2 = [a, c, d]; } else { t1 = [a, b, d]; t2 = [b, c, d]; }
    if (flip) { t1.reverse(); t2.reverse(); }
    idx.push(...t1, ...t2);
  };
  const cell = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1 ? -1 : cellV[k * csz + j * csy + i]);
  for (let kk = 0; kk < nz; kk++) for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
    const f0 = F[kk * sz + jj * sy + ii] < 0;
    if (ii < nx - 1 && f0 !== (F[kk * sz + jj * sy + ii + 1] < 0)) {
      quad(cell(ii, jj - 1, kk - 1), cell(ii, jj, kk - 1), cell(ii, jj, kk), cell(ii, jj - 1, kk), !f0);
    }
    if (jj < ny - 1 && f0 !== (F[kk * sz + (jj + 1) * sy + ii] < 0)) {
      quad(cell(ii - 1, jj, kk - 1), cell(ii - 1, jj, kk), cell(ii, jj, kk), cell(ii, jj, kk - 1), !f0);
    }
    if (kk < nz - 1 && f0 !== (F[(kk + 1) * sz + jj * sy + ii] < 0)) {
      quad(cell(ii - 1, jj - 1, kk), cell(ii, jj - 1, kk), cell(ii, jj, kk), cell(ii - 1, jj, kk), !f0);
    }
  }
  const I = new Uint32Array(idx);
  return { pos, idx: I };
}
