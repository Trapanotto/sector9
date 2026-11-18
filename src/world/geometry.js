// Geometry batching with world-scale UVs and baked grime/AO vertex colours.
// All static geometry is accumulated per material key and turned into one BufferGeometry per key.
import * as THREE from 'three';

// ---- small deterministic noise helpers
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
export function fbm(x, y, z) {
  return vnoise(x, y, z) * 0.55 + vnoise(x * 2.1, y * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3, z * 4.3) * 0.15;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Default grime: dirt band at wall bases, blotchy variation, vertical water streaks; floorAO for floors.
export function makeGrime(opts = {}) {
  const floorAO = opts.floorAO || null;
  return (x, y, z, nx, ny, nz, base = 0) => {
    let g = 0.8 + 0.32 * fbm(x * 0.35 + 11, y * 0.35, z * 0.35 - 7);
    if (Math.abs(ny) < 0.5) {
      const hy = y - base;
      g *= 0.5 + 0.5 * smooth(0.0, 1.3, hy);                     // wet dirt band at the base
      const streak = vnoise((nx !== 0 ? z : x) * 2.7, y * 0.12, 3.3);
      g *= 1 - 0.22 * smooth(0.55, 0.9, streak) * smooth(0.5, 3.0, hy); // rain/leak streaks
    } else if (ny > 0.5) {
      if (floorAO) g *= floorAO(x, z, y);
      g *= 0.85 + 0.2 * vnoise(x * 1.3, 0, z * 1.3);
    } else {
      g *= 0.7;  // undersides are darker (soot, no bounce)
    }
    g = Math.max(0.18, Math.min(1.12, g));
    return [g, g * 0.97, g * 0.92];
  };
}

const FACES = {
  px: { n: [1, 0, 0], r: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], r: [0, 0, 1], v: [0, 1, 0] },
  pz: { n: [0, 0, 1], r: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], r: [-1, 0, 0], v: [0, 1, 0] },
  py: { n: [0, 1, 0], r: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], r: [1, 0, 0], v: [0, 0, 1] },
};
const axisOf = (vec) => (vec[0] !== 0 ? 0 : vec[1] !== 0 ? 1 : 2);

export class Batcher {
  constructor(scales, grime) {
    this.scales = scales;         // material key -> metres per texture repeat
    this.grime = grime || makeGrime();
    this.buckets = new Map();
  }
  bucket(key) {
    let b = this.buckets.get(key);
    if (!b) { b = { pos: [], nor: [], uv: [], col: [], idx: [] }; this.buckets.set(key, b); }
    return b;
  }

  // Axis-aligned box with per-face material keys, subdivided for vertex grime. skip: set of face names.
  box(min, max, mats, o = {}) {
    const seg = o.seg ?? 1.6;
    for (const name of Object.keys(FACES)) {
      if (o.skip && o.skip.includes(name)) continue;
      const key = typeof mats === 'string' ? mats : mats[name];
      if (!key) continue;
      const f = FACES[name];
      const ra = axisOf(f.r), va = axisOf(f.v), na = axisOf(f.n);
      const origin = [0, 0, 0];
      origin[na] = f.n[na] > 0 ? max[na] : min[na];
      origin[ra] = f.r[ra] > 0 ? min[ra] : max[ra];
      origin[va] = f.v[va] > 0 ? min[va] : max[va];
      const W = max[ra] - min[ra], Hh = max[va] - min[va];
      if (W < 1e-4 || Hh < 1e-4) continue;
      const vertical = f.n[1] === 0;
      const ss = splits(W, seg);
      let ts = splits(Hh, seg);
      if (vertical) {
        const extra = [0.15, 0.5, 1.1].map((y) => y - min[1]).filter((t) => t > 0.02 && t < Hh - 0.02);
        ts = [...new Set([...ts, ...extra])].sort((a, b) => a - b);
      }
      this._grid(key, origin, f, ss, ts, o);
    }
  }

  _grid(key, origin, f, ss, ts, o) {
    const b = this.bucket(key);
    const sc = (o.uvScale ?? 1) / (this.scales[key] ?? 2);
    const uo = o.uvOffset || [0, 0];
    const base = b.pos.length / 3;
    const ou = origin[0] * f.r[0] + origin[1] * f.r[1] + origin[2] * f.r[2];
    const ov = origin[0] * f.v[0] + origin[1] * f.v[1] + origin[2] * f.v[2];
    const m = o.matrix;
    const nm = o.normalMatrix;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const t of ts) for (const s of ss) {
      p.set(origin[0] + f.r[0] * s + f.v[0] * t, origin[1] + f.r[1] * s + f.v[1] * t, origin[2] + f.r[2] * s + f.v[2] * t);
      n.set(f.n[0], f.n[1], f.n[2]);
      const lx = p.x, ly = p.y, lz = p.z;
      if (m) { p.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
      b.pos.push(p.x, p.y, p.z);
      b.nor.push(n.x, n.y, n.z);
      // UVs from local (pre-transform) coordinates: stable texel density for instanced/rotated props too.
      b.uv.push((ou + s) * sc + uo[0], (ov + t) * sc + uo[1]);
      const c = o.color ? o.color : this.grime(p.x, p.y, p.z, n.x, n.y, n.z, o.base ?? 0, lx, ly, lz);
      const tint = o.tint || 1;
      b.col.push(c[0] * tint, c[1] * tint, c[2] * tint);
    }
    const cols = ss.length;
    for (let j = 0; j < ts.length - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = base + j * cols + i, b1 = a + 1, c = a + cols + 1, d = a + cols;
      b.idx.push(a, b1, c, a, c, d);
    }
  }

  // Rotated/translated box (local box min/max, then matrix). Used for tilted crates, planks, beams.
  boxXf(min, max, mats, matrix, o = {}) {
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    this.box(min, max, mats, { ...o, matrix, normalMatrix: nm });
  }

  // Cylinder along Y (centre bottom at c), with world-scaled UVs. caps: true/false.
  cylinder(key, c, r, h, o = {}) {
    const segs = o.segs ?? 16;
    const b = this.bucket(key);
    const sc = 1 / (this.scales[key] ?? 2);
    const m = o.matrix, nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const rows = o.rows ?? Math.max(2, Math.ceil(h / 1.2) + 1);
    const base = b.pos.length / 3;
    const push = (px, py, pz, nx, ny, nz, u, v) => {
      p.set(px, py, pz); n.set(nx, ny, nz);
      if (m) { p.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
      b.pos.push(p.x, p.y, p.z); b.nor.push(n.x, n.y, n.z); b.uv.push(u * sc, v * sc);
      const col = o.color || this.grime(p.x, p.y, p.z, n.x, n.y, n.z, o.base ?? 0);
      const tint = o.tint || 1;
      b.col.push(col[0] * tint, col[1] * tint, col[2] * tint);
    };
    for (let j = 0; j < rows; j++) {
      const y = (h * j) / (rows - 1);
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const cx = Math.cos(a), sz = Math.sin(a);
        push(c[0] + cx * r, c[1] + y, c[2] + sz * r, cx, 0, sz, a * r, y);
      }
    }
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < segs; i++) {
      const a = base + j * (segs + 1) + i, b1 = a + 1, cc = a + segs + 2, d = a + segs + 1;
      b.idx.push(a, cc, b1, a, d, cc);
    }
    if (o.caps !== false) {
      for (const top of [0, 1]) {
        const y = top ? h : 0, ny = top ? 1 : -1;
        const ci = b.pos.length / 3;
        push(c[0], c[1] + y, c[2], 0, ny, 0, c[0], c[2]);
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          push(c[0] + Math.cos(a) * r, c[1] + y, c[2] + Math.sin(a) * r, 0, ny, 0, c[0] + Math.cos(a) * r, c[2] + Math.sin(a) * r);
        }
        for (let i = 0; i < segs; i++) {
          if (top) b.idx.push(ci, ci + 2 + i, ci + 1 + i); else b.idx.push(ci, ci + 1 + i, ci + 2 + i);
        }
      }
    }
  }

  // Cylinder between two points (pipes, rails).
  pipe(key, a, bpt, r, o = {}) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...bpt);
    const dir = B.clone().sub(A); const len = dir.length();
    if (len < 1e-3) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(A, q, new THREE.Vector3(1, 1, 1));
    this.cylinder(key, [0, 0, 0], r, len, { ...o, matrix: m, rows: o.rows ?? Math.max(2, Math.ceil(len / 2) + 1) });
  }

  // Arbitrary pre-built geometry (positions in world space) appended to a bucket.
  geometry(key, geo, o = {}) {
    const b = this.bucket(key);
    const g = geo.index ? geo : geo;
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const base = b.pos.length / 3;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      b.pos.push(x, y, z);
      const nx = nor ? nor.getX(i) : 0, ny = nor ? nor.getY(i) : 1, nz = nor ? nor.getZ(i) : 0;
      b.nor.push(nx, ny, nz);
      b.uv.push(uv ? uv.getX(i) * (o.uvScale ?? 1) : 0, uv ? uv.getY(i) * (o.uvScale ?? 1) : 0);
      const c = o.color || this.grime(x, y, z, nx, ny, nz, 0);
      b.col.push(c[0], c[1], c[2]);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) b.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) b.idx.push(base + i);
  }

  // Build one BufferGeometry per bucket.
  build() {
    const out = new Map();
    for (const [key, b] of this.buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      const n = b.pos.length / 3;
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      out.set(key, g);
    }
    this.buckets.clear();
    return out;
  }
}

function splits(len, seg) {
  const n = Math.max(1, Math.ceil(len / seg - 1e-6));
  const out = [];
  for (let i = 0; i <= n; i++) out.push((len * i) / n);
  return out;
}

// Ground grid (1 m cells) with per-cell material choice and floor AO.
export function groundGrid(batcher, min, max, y, matAt, cell = 1) {
  const nx = Math.round((max[0] - min[0]) / cell), nz = Math.round((max[1] - min[1]) / cell);
  // One quad per cell is too many vertices to share across materials, so emit per-material rows.
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = min[0] + i * cell, z0 = min[1] + j * cell;
      const key = matAt(x0 + cell / 2, z0 + cell / 2);
      let i1 = i;
      while (i1 + 1 < nx && matAt(min[0] + (i1 + 1) * cell + cell / 2, z0 + cell / 2) === key) i1++;
      const x1 = min[0] + (i1 + 1) * cell;
      const ss = []; for (let k = 0; k <= i1 - i + 1; k++) ss.push(k * cell);
      // py face: origin at (x0, y, z1) with r=+x, v=-z
      batcher._grid(key, [x0, y, z0 + cell], FACES.py, ss, [0, cell], {});
      i = i1;
    }
  }
}
