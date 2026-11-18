import * as THREE from 'three';
import { toCreasedNormals, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry toolkit for the procedural viewmodel (build time only, nothing here runs per frame).
//
// Conventions: side profiles are drawn in (u, v) = (forward, up) and map to gun space as (x, y, z) = (x, v, -u).
// Cross-section profiles (slide, light, rail) are drawn in (x, y) and lofted along z.

// ------------------------------------------------------------------ 2D outlines with real fillets
/**
 * Rounds every corner of a closed polygon with a circular fillet.
 * Returns { pts: [[u,v]...], nrm: [[nu,nv]...] } with analytic outward normals (outward from the solid; works for
 * CCW outlines and CW holes alike), plus a "support" point just outside each arc so flat faces stay flat.
 */
export function roundOutline(poly, radii = 0.001, segs = 4, support = 0.00025) {
  const n = poly.length;
  const pts = [], nrm = [];
  const edgeN = (d) => [d[1], -d[0]];
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n], p = poly[i], b = poly[(i + 1) % n];
    const r = Array.isArray(radii) ? radii[i] : radii;
    let d1 = [p[0] - a[0], p[1] - a[1]], d2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    d1 = [d1[0] / l1, d1[1] / l1]; d2 = [d2[0] / l2, d2[1] / l2];
    const cosA = -(d1[0] * d2[0] + d1[1] * d2[1]);
    const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));     // interior angle at p
    if (!(r > 0) || alpha > Math.PI - 1e-3) {
      // sharp (or straight) corner: duplicate the point with both edge normals
      pts.push(p, p); nrm.push(edgeN(d1), edgeN(d2));
      continue;
    }
    let t = r / Math.tan(alpha / 2);
    const tMax = 0.48 * Math.min(l1, l2);
    let rr = r;
    if (t > tMax) { t = tMax; rr = t * Math.tan(alpha / 2); }
    const S = [p[0] - d1[0] * t, p[1] - d1[1] * t];
    const E = [p[0] + d2[0] * t, p[1] + d2[1] * t];
    let bis = [d2[0] - d1[0], d2[1] - d1[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    bis = [bis[0] / bl, bis[1] / bl];
    const cd = Math.hypot(t, rr);
    const C = [p[0] + bis[0] * cd, p[1] + bis[1] * cd];
    let aS = Math.atan2(S[1] - C[1], S[0] - C[0]);
    let aE = Math.atan2(E[1] - C[1], E[0] - C[0]);
    let da = aE - aS;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const nS = edgeN(d1);
    const sgn = Math.sign((S[0] - C[0]) * nS[0] + (S[1] - C[1]) * nS[1]) || 1;
    const sup = Math.min(support, (Math.min(l1, l2) - 2 * t) * 0.25);
    if (sup > 1e-6) { pts.push([S[0] - d1[0] * sup, S[1] - d1[1] * sup]); nrm.push(nS); }
    for (let k = 0; k <= segs; k++) {
      const ang = aS + da * (k / segs);
      const c = Math.cos(ang), s = Math.sin(ang);
      pts.push([C[0] + c * rr, C[1] + s * rr]);
      nrm.push([c * sgn, s * sgn]);
    }
    if (sup > 1e-6) { pts.push([E[0] + d2[0] * sup, E[1] + d2[1] * sup]); nrm.push(edgeN(d2)); }
  }
  return { pts, nrm };
}

/**
 * Fillet with a FIXED point count per corner (segs + 1), so differently shaped variants of one profile can be
 * lofted together. Sharp or collapsed corners repeat the point.
 */
export function filletFixed(poly, radii, segs = 3) {
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n], p = poly[i], b = poly[(i + 1) % n];
    const r = Array.isArray(radii) ? radii[i] : radii;
    let d1 = [p[0] - a[0], p[1] - a[1]], d2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    const copies = () => { for (let k = 0; k <= segs; k++) out.push([p[0], p[1]]); };
    if (!(r > 0) || l1 < 1e-9 || l2 < 1e-9) { copies(); continue; }
    d1 = [d1[0] / l1, d1[1] / l1]; d2 = [d2[0] / l2, d2[1] / l2];
    const alpha = Math.acos(Math.max(-1, Math.min(1, -(d1[0] * d2[0] + d1[1] * d2[1]))));
    if (alpha > Math.PI - 1e-3) { copies(); continue; }
    let t = r / Math.tan(alpha / 2), rr = r;
    const tMax = 0.49 * Math.min(l1, l2);
    if (t > tMax) { t = tMax; rr = t * Math.tan(alpha / 2); }
    const S = [p[0] - d1[0] * t, p[1] - d1[1] * t];
    let bis = [d2[0] - d1[0], d2[1] - d1[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    bis = [bis[0] / bl, bis[1] / bl];
    const cd = Math.hypot(t, rr);
    const C = [p[0] + bis[0] * cd, p[1] + bis[1] * cd];
    const E = [p[0] + d2[0] * t, p[1] + d2[1] * t];
    const aS = Math.atan2(S[1] - C[1], S[0] - C[0]);
    let da = Math.atan2(E[1] - C[1], E[0] - C[0]) - aS;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= segs; k++) {
      const ang = aS + da * (k / segs);
      out.push([C[0] + Math.cos(ang) * rr, C[1] + Math.sin(ang) * rr]);
    }
  }
  return out;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
export const ccw = (poly) => (signedArea(poly) < 0 ? poly.slice().reverse() : poly);
export const cw = (poly) => (signedArea(poly) > 0 ? poly.slice().reverse() : poly);

// ------------------------------------------------------------------ side-profile extrusion with rounded edges
/**
 * Extrudes a filleted side profile (u,v) across x with a quarter-round edge of radius `re` on both faces.
 * outer: CCW polygon, holes: CW polygons. Analytic normals (perfectly flat faces, smooth round edges).
 */
export function extrudeRounded(outerPoly, holePolys, halfW, re, opts = {}) {
  const segs = opts.edgeSegs ?? 3;
  const fr = opts.fillet ?? Math.max(re * 1.15, 0.0012);
  const fsegs = opts.filletSegs ?? 4;
  const loops = [roundOutline(ccw(outerPoly), opts.radii ?? fr, fsegs)];
  for (const h of holePolys || []) loops.push(roundOutline(cw(h), opts.holeRadii ?? fr, fsegs));
  const pos = [], nor = [], idx = [];
  const thetas = [];
  for (let k = -segs; k <= segs; k++) {
    if (k === 0) { thetas.push(-1e-9, 1e-9); continue; }
    thetas.push((k / segs) * Math.PI / 2);
  }
  for (const L of loops) {
    const m = L.pts.length;
    const base = pos.length / 3;
    for (const th of thetas) {
      const side = th < 0 ? -1 : 1;
      const at = Math.abs(th);
      const x = side * (halfW - re + re * Math.sin(at));
      const ins = re * (1 - Math.cos(at));
      for (let i = 0; i < m; i++) {
        const [u, v] = L.pts[i], [nu, nv] = L.nrm[i];
        pos.push(x, v - nv * ins, -(u - nu * ins));
        const c = Math.cos(at), s = Math.sin(at) * side;
        nor.push(s, nv * c, -nu * c);
      }
    }
    for (let r = 0; r < thetas.length - 1; r++) {
      for (let i = 0; i < m; i++) {
        const i2 = (i + 1) % m;
        const a = base + r * m + i, b = base + r * m + i2, c = base + (r + 1) * m + i2, d = base + (r + 1) * m + i;
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  // caps
  for (const side of [-1, 1]) {
    const contour = loops[0].pts.map((p, i) => new THREE.Vector2(p[0] - loops[0].nrm[i][0] * re, p[1] - loops[0].nrm[i][1] * re));
    const holes = loops.slice(1).map((L) => L.pts.map((p, i) => new THREE.Vector2(p[0] - L.nrm[i][0] * re, p[1] - L.nrm[i][1] * re)));
    const all = contour.concat(...holes);
    const faces = THREE.ShapeUtils.triangulateShape(dedupe2(contour), holes.map(dedupe2));
    const flat = dedupe2(contour).concat(...holes.map(dedupe2));
    const base = pos.length / 3;
    for (const p of flat) { pos.push(side * halfW, p.y, -p.x); nor.push(side, 0, 0); }
    for (const f of faces) idx.push(base + f[0], base + f[1], base + f[2]);
    void all;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  fixWinding(g);
  return g;
}

function dedupe2(arr) {
  const out = [];
  for (const p of arr) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > 1e-7 || Math.abs(q.y - p.y) > 1e-7) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) < 1e-7 && Math.abs(out[0].y - out[out.length - 1].y) < 1e-7) out.pop();
  return out;
}

// ------------------------------------------------------------------ cross-section loft along z (hard-surface)
/**
 * rings: [{ z, pts: [[x,y]...] }] — every ring has the same point count (points may coincide to collapse features).
 * caps: { start: holes|true|false, end: holes|true|false } where holes = [[[x,y]...]...] (any orientation).
 * Normals are creased (smooth below `crease` radians), so bevels shade round and grooves stay sharp.
 */
export function loftZ(rings, opts = {}) {
  const m = rings[0].pts.length;
  const pos = [], idx = [];
  for (const r of rings) for (const p of r.pts) pos.push(p[0], p[1], r.z);
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < m; i++) {
      const i2 = (i + 1) % m;
      const a = r * m + i, b = r * m + i2, c = (r + 1) * m + i2, d = (r + 1) * m + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  const capGeoms = [];
  const caps = opts.caps || {};
  for (const [which, ring] of [['start', rings[0]], ['end', rings[rings.length - 1]]]) {
    const holes = caps[which];
    if (!holes) continue;
    const contour = dedupe2(ring.pts.map((p) => new THREE.Vector2(p[0], p[1])));
    const hs = (Array.isArray(holes) ? holes : []).map((h) => dedupe2(h.map((p) => new THREE.Vector2(p[0], p[1]))));
    const faces = THREE.ShapeUtils.triangulateShape(contour, hs);
    const flat = contour.concat(...hs);
    const cp = [];
    for (const f of faces) for (const k of f) cp.push(flat[k].x, flat[k].y, ring.z);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    const nz = which === 'start' ? -1 : 1;   // rings run in +z; start cap faces -z
    const nn = new Float32Array(cp.length);
    for (let i = 0; i < nn.length; i += 3) nn[i + 2] = nz * (rings[rings.length - 1].z > rings[0].z ? 1 : -1);
    cg.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    fixWinding(cg);
    capGeoms.push(cg);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g = dropDegenerate(g.toNonIndexed());
  g = toCreasedNormals(g, opts.crease ?? 0.6);
  orientOutward(g, opts.center);
  if (capGeoms.length) g = mergeGeometries([g, ...capGeoms]);
  return g;
}

function dropDegenerate(g) {
  const p = g.attributes.position.array;
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    a.set(p[i], p[i + 1], p[i + 2]); b.set(p[i + 3], p[i + 4], p[i + 5]); c.set(p[i + 6], p[i + 7], p[i + 8]);
    b.sub(a); c.sub(a);
    if (b.cross(c).lengthSq() < 1e-16) continue;
    for (let k = 0; k < 9; k++) out.push(p[i + k]);
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return ng;
}

/** Loft winding is arbitrary: make every face point away from the loft axis-ish by testing against a center line. */
function orientOutward(g, center) {
  // For closed lofts the majority vote of (face normal . (centroid - center)) tells us if all faces are inside-out.
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  const cx = center ? center[0] : 0, cy = center ? center[1] : 0;
  let vote = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    a.set(p[i], p[i + 1], p[i + 2]); b.set(p[i + 3], p[i + 4], p[i + 5]); c.set(p[i + 6], p[i + 7], p[i + 8]);
    const mx = (a.x + b.x + c.x) / 3 - cx, my = (a.y + b.y + c.y) / 3 - cy;
    b.sub(a); c.sub(a); b.cross(c);
    vote += Math.sign(b.x * mx + b.y * my);
  }
  if (vote < 0) {
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t;
        const u = n[i + 3 + k]; n[i + 3 + k] = n[i + 6 + k]; n[i + 6 + k] = u;
      }
    }
    for (let i = 0; i < n.length; i++) n[i] = -n[i];
  }
}

/** Flip triangles whose geometric normal disagrees with their vertex normals. */
export function fixWinding(g) {
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const tri = (i0, i1, i2) => {
    A.fromArray(p, i0 * 3); B.fromArray(p, i1 * 3).sub(A); C.fromArray(p, i2 * 3).sub(A);
    B.cross(C);
    const s = (n[i0 * 3] + n[i1 * 3] + n[i2 * 3]) * B.x + (n[i0 * 3 + 1] + n[i1 * 3 + 1] + n[i2 * 3 + 1]) * B.y +
      (n[i0 * 3 + 2] + n[i1 * 3 + 2] + n[i2 * 3 + 2]) * B.z;
    return s;
  };
  if (g.index) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) if (tri(ix[i], ix[i + 1], ix[i + 2]) < 0) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  } else {
    for (let i = 0; i < p.length / 3; i += 3) {
      if (tri(i, i + 1, i + 2) < 0) {
        for (let k = 0; k < 3; k++) {
          let t = p[(i + 1) * 3 + k]; p[(i + 1) * 3 + k] = p[(i + 2) * 3 + k]; p[(i + 2) * 3 + k] = t;
          t = n[(i + 1) * 3 + k]; n[(i + 1) * 3 + k] = n[(i + 2) * 3 + k]; n[(i + 2) * 3 + k] = t;
        }
      }
    }
  }
  return g;
}

// ------------------------------------------------------------------ lathe along z (barrel, muzzle, pins, bezels)
/** profile: [[r, z]...] from one end to the other; normals creased. */
export function latheZ(profile, segs = 24, opts = {}) {
  const rings = profile.map(([r, z]) => ({ z, pts: circlePts(r, segs, opts.phase || 0, opts.lobes, opts.twist ? opts.twist * z : 0) }));
  return loftZ(rings, { crease: opts.crease ?? 0.7, caps: opts.caps });
}
export function circlePts(r, segs, phase = 0, lobes = null, twist = 0) {
  const out = [];
  for (let i = 0; i < segs; i++) {
    const a = phase + twist + (i / segs) * Math.PI * 2;
    let rr = r;
    if (lobes) rr = r * (1 + lobes.amp * (Math.cos(a * lobes.n - twist * lobes.n) > 0 ? 1 : -1));
    out.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return out;
}

/** Rounded rectangle cross-section with fixed point count (for lofts). */
export function roundRectPts(cx, cy, hw, hh, r, segs = 4) {
  const poly = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
  return roundOutline(poly, r, segs, 0).pts;
}

// ------------------------------------------------------------------ geometry helpers
export function transformed(g, { pos, rot, scale } = {}) {
  const m = new THREE.Matrix4();
  m.compose(
    pos ? new THREE.Vector3(...pos) : new THREE.Vector3(),
    rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)) : new THREE.Quaternion(),
    scale ? new THREE.Vector3(...scale) : new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Merge geometries of mixed indexed/non-indexed kind, keeping only position + normal (+ optional attributes). */
export function merge(list, keep = ['position', 'normal']) {
  const sizes = {};
  for (const g of list) if (g) for (const k of keep) if (g.attributes[k] && !sizes[k]) sizes[k] = g.attributes[k].itemSize;
  const prepared = list.filter(Boolean).map((g) => {
    let h = g.index ? g.toNonIndexed() : g;
    if (!h.attributes.normal) h.computeVertexNormals();
    const o = new THREE.BufferGeometry();
    for (const k of keep) {
      if (h.attributes[k]) o.setAttribute(k, h.attributes[k]);
      else {
        const size = sizes[k] || 4;
        o.setAttribute(k, new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count * size), size));
      }
    }
    return o;
  });
  const g = mergeGeometries(prepared);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Fill a constant vec4 attribute (used to tag parts for the shader, e.g. masks). */
export function tag(g, name, v) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) a.set(v, i * 4);
  g.setAttribute(name, new THREE.BufferAttribute(a, 4));
  return g;
}

// ------------------------------------------------------------------ SDF + surface nets (organic parts: hands)
export const smin = (a, b, k) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
export const smax = (a, b, k) => -smin(-a, -b, k);

/** Round cone between a and b (Inigo Quilez), radii ra / rb. a, b: [x,y,z] */
export function sdRoundCone(px, py, pz, a, b, ra, rb) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

/** Oriented ellipsoid (approximate distance). c center, axes: 3 unit vectors, r radii. */
export function sdEllipsoid(px, py, pz, c, ax, r) {
  const dx = px - c[0], dy = py - c[1], dz = pz - c[2];
  const lx = (dx * ax[0][0] + dy * ax[0][1] + dz * ax[0][2]);
  const ly = (dx * ax[1][0] + dy * ax[1][1] + dz * ax[1][2]);
  const lz = (dx * ax[2][0] + dy * ax[2][1] + dz * ax[2][2]);
  const ax0 = lx / r[0], ay0 = ly / r[1], az0 = lz / r[2];
  const ax1 = ax0 / r[0], ay1 = ay0 / r[1], az1 = az0 / r[2];
  const k0 = Math.sqrt(ax0 * ax0 + ay0 * ay0 + az0 * az0);
  const k1 = Math.sqrt(ax1 * ax1 + ay1 * ay1 + az1 * az1);
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(r[0], r[1], r[2]);
}

/** Oriented rounded box. c center, ax: 3 unit axes, h half extents (incl. rounding), r rounding radius. */
export function sdRoundBox(px, py, pz, c, ax, h, r) {
  const dx = px - c[0], dy = py - c[1], dz = pz - c[2];
  const qx = Math.abs(dx * ax[0][0] + dy * ax[0][1] + dz * ax[0][2]) - h[0] + r;
  const qy = Math.abs(dx * ax[1][0] + dy * ax[1][1] + dz * ax[1][2]) - h[1] + r;
  const qz = Math.abs(dx * ax[2][0] + dy * ax[2][1] + dz * ax[2][2]) - h[2] + r;
  const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
  const inner = qx > qy ? (qx > qz ? qx : qz) : (qy > qz ? qy : qz);
  return Math.sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0) - r;
}

/**
 * Surface nets polygonizer. sdf(x,y,z) -> distance. Returns indexed BufferGeometry with gradient normals,
 * vertices projected onto the surface. filterTri(a,b,c positions) -> false drops a triangle.
 */
export function surfaceNets(sdf, min, max, h, opts = {}) {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const vals = new Float32Array(nx * ny * nz);
  const I = (i, j, k) => i + nx * (j + ny * k);
  // narrow band: sample a 2h lattice first; fine samples far from the surface inherit the coarse value
  // (only the sign matters there — the field is 1-Lipschitz, so no crossing can be missed)
  const far = 2.2 * h;
  for (let k = 0; k < nz; k += 2) for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
    vals[I(i, j, k)] = sdf(min[0] + i * h, min[1] + j * h, min[2] + k * h);
  }
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * h, kc = Math.min(nz - 1, (k + 1) & ~1);
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * h, jc = Math.min(ny - 1, (j + 1) & ~1);
      for (let i = 0; i < nx; i++) {
        if (!(i & 1) && !(j & 1) && !(k & 1)) continue;
        const ic = Math.min(nx - 1, (i + 1) & ~1);
        const kk = kc & 1 ? kc - 1 : kc, jj = jc & 1 ? jc - 1 : jc, ii = ic & 1 ? ic - 1 : ic;
        const dc = vals[I(ii, jj, kk)];
        vals[I(i, j, k)] = Math.abs(dc) > far ? dc : sdf(min[0] + i * h, y, z);
      }
    }
  }
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellV = new Int32Array(cx * cy * cz).fill(-1);
  const C = (i, j, k) => i + cx * (j + cy * k);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v8 = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = vals[I(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
      v8[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = v8[a], vb = v8[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
      sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
      sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
      cnt++;
    }
    cellV[C(i, j, k)] = pos.length / 3;
    pos.push(min[0] + (i + sx / cnt) * h, min[1] + (j + sy / cnt) * h, min[2] + (k + sz / cnt) * h);
  }
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, d, c, a, c, b); else idx.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = vals[I(i, j, k)] < 0;
    if (i < cx && j > 0 && k > 0 && j < cy && k < cz && v0 !== (vals[I(i + 1, j, k)] < 0)) {
      quad(cellV[C(i, j - 1, k - 1)], cellV[C(i, j, k - 1)], cellV[C(i, j, k)], cellV[C(i, j - 1, k)], v0);
    }
    if (j < cy && i > 0 && k > 0 && i < cx && k < cz && v0 !== (vals[I(i, j + 1, k)] < 0)) {
      quad(cellV[C(i - 1, j, k - 1)], cellV[C(i - 1, j, k)], cellV[C(i, j, k)], cellV[C(i, j, k - 1)], v0);
    }
    if (k < cz && i > 0 && j > 0 && i < cx && j < cy && v0 !== (vals[I(i, j, k + 1)] < 0)) {
      quad(cellV[C(i - 1, j - 1, k)], cellV[C(i, j - 1, k)], cellV[C(i, j, k)], cellV[C(i - 1, j, k)], v0);
    }
  }
  // project onto the surface + gradient normals
  const nor = new Float32Array(pos.length);
  const e = h * 0.3;
  for (let v = 0; v < pos.length; v += 3) {
    let x = pos[v], y = pos[v + 1], z = pos[v + 2];
    let gx = 0, gy = 0, gz = 0;
    for (let it = 0; it < (opts.project ?? 2) + 1; it++) {
      // tetrahedral central difference (4 evaluations); their mean is the value at the centre
      const a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c = sdf(x - e, y + e, z - e), d4 = sdf(x + e, y + e, z + e);
      gx = a - b - c + d4; gy = -a - b + c + d4; gz = -a + b - c + d4;
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it === (opts.project ?? 2)) break;
      const d = (a + b + c + d4) * 0.25;
      const step = Math.max(-h * 0.5, Math.min(h * 0.5, d));
      x -= gx * step; y -= gy * step; z -= gz * step;
    }
    pos[v] = x; pos[v + 1] = y; pos[v + 2] = z;
    nor[v] = gx; nor[v + 1] = gy; nor[v + 2] = gz;
  }
  let finalIdx = idx;
  if (opts.filterTri) {
    finalIdx = [];
    for (let t = 0; t < idx.length; t += 3) if (opts.filterTri(idx[t], idx[t + 1], idx[t + 2], pos)) finalIdx.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(finalIdx);
  fixWinding(g);
  return g;
}

/** Compact an indexed geometry: drop unreferenced vertices (after triangle filtering). */
export function compact(g) {
  const ix = g.index.array;
  const n = g.attributes.position.count;
  const remap = new Int32Array(n).fill(-1);
  let c = 0;
  for (let i = 0; i < ix.length; i++) if (remap[ix[i]] < 0) remap[ix[i]] = c++;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const s = attr.itemSize;
    const a = new (attr.array.constructor)(c * s);
    for (let v = 0; v < n; v++) if (remap[v] >= 0) for (let k = 0; k < s; k++) a[remap[v] * s + k] = attr.array[v * s + k];
    out.setAttribute(name, new THREE.BufferAttribute(a, s, attr.normalized));
  }
  const ni = new Uint32Array(ix.length);
  for (let i = 0; i < ix.length; i++) ni[i] = remap[ix[i]];
  out.setIndex(new THREE.BufferAttribute(ni, 1));
  return out;
}
