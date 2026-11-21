// Geometry kit for the world art (workstream A). Pure JS (no three.js): runs in the browser and in Node tests.
//
// A Builder accumulates flat-shaded / smooth primitives into growable typed arrays with the art vertex format:
//   position f32×3 · normal i8×4 · uv f32×2 (in TILE units: may exceed 1 → repeats inside the atlas tile)
//   tile u16×4 (atlas rect x, y, w, h normalised) · art u8×4 (rgb = tint × ambient occlusion, a = flags)
//   [skin u8×4 bone index] (machines only)
// art.a: 0..199 = emissive × 16, 200..207 = conveyor belt index (uv.v scrolls with uBelt[i]).
// Indices are routed into "targets" (chunk × LOD) so one vertex buffer serves several index lists.
//
// Material descriptor m = { t: tile name, c: [r,g,b] linear tint (default white), s: metres per texture repeat
//   (number or [su, sv]; 0 / undefined = 'fit': the face spans the tile once), e: emissive, ao: extra AO factor,
//   belt: belt index, sub: [u0, v0, u1, v1] sub-rect of the tile for fit faces }
import { TILES } from './tiles.js';

export const FX = 1, NX = 2, FY = 4, NY = 8, FZ = 16, NZ = 32;   // face bits (+x,-x,+y,-y,+z,-z)

// 3×4 affine matrix helpers (row-major: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz])
export const M = {
  ident: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  mul(a, b) {
    const o = new Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      o[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
    }
    return o;
  },
  T: (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z],
  RY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; },
  RX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; },
  RZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; },
  S: (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0],
};

/** quarter-turn rotation as used by the layout (r = 0..3, counter-clockwise seen from above): (x,z) → rot */
export const rotQ = (r) => M.RY(r * Math.PI / 2);

class Grow {
  constructor(T, n) { this.T = T; this.a = new T(n); this.n = 0; }
  need(k) { if (this.n + k > this.a.length) { const b = new this.T(Math.max(this.a.length * 2, this.n + k)); b.set(this.a); this.a = b; } }
  view() { return this.a.subarray(0, this.n); }
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Builder {
  constructor({ skin = false } = {}) {
    this.pos = new Grow(Float32Array, 3 << 14); this.nrm = new Grow(Int8Array, 4 << 14);
    this.uv = new Grow(Float32Array, 2 << 14); this.tile = new Grow(Uint16Array, 4 << 14);
    this.art = new Grow(Uint8Array, 4 << 14);
    this.skin = skin ? new Grow(Uint8Array, 4 << 14) : null;
    this.targets = new Map();          // key → Grow(Uint32Array)
    this.cur = [];                     // index targets for the next primitives
    this.stack = []; this.m = M.ident();
    this.groundY = -1e9;               // instance floor height (contact AO), world space
    this.bone = 0; this.lodMask = 3; this.tris = 0;
    this.aoFn = null;                  // optional (x, y, z) → factor
  }
  get vcount() { return this.pos.n / 3; }
  /** route following primitives to targets (array of keys) */
  target(keys) { this.cur = keys.map((k) => { let g = this.targets.get(k); if (!g) this.targets.set(k, (g = new Grow(Uint32Array, 1 << 12))); return g; }); }
  push(m) { this.stack.push(this.m); this.m = M.mul(this.m, m); return this; }
  pop() { this.m = this.stack.pop(); return this; }
  with(m, fn) { this.push(m); try { fn(); } finally { this.pop(); } }

  // ---- low level
  _v(x, y, z, nx, ny, nz, u, v, tile, m, aoExtra) {
    const A = this.m;
    const wx = A[0] * x + A[1] * y + A[2] * z + A[3], wy = A[4] * x + A[5] * y + A[6] * z + A[7], wz = A[8] * x + A[9] * y + A[10] * z + A[11];
    let tx = A[0] * nx + A[1] * ny + A[2] * nz, ty = A[4] * nx + A[5] * ny + A[6] * nz, tz = A[8] * nx + A[9] * ny + A[10] * nz;
    const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
    const P = this.pos; P.need(3); P.a[P.n++] = wx; P.a[P.n++] = wy; P.a[P.n++] = wz;
    const N = this.nrm; N.need(4); N.a[N.n++] = Math.round(tx * 127); N.a[N.n++] = Math.round(ty * 127); N.a[N.n++] = Math.round(tz * 127); N.a[N.n++] = 0;
    const UV = this.uv; UV.need(2); UV.a[UV.n++] = u; UV.a[UV.n++] = v;
    const T = this.tile; T.need(4); T.a[T.n++] = tile[0]; T.a[T.n++] = tile[1]; T.a[T.n++] = tile[2]; T.a[T.n++] = tile[3];
    // contact AO near the instance floor + downward faces darker
    let ao = (m.ao ?? 1) * aoExtra;
    const h = wy - this.groundY;
    if (h < 0.5) ao *= 0.62 + 0.38 * smooth(0, 0.45, h);
    if (ty < -0.5) ao *= 0.7;
    if (this.aoFn) ao *= this.aoFn(wx, wy, wz);
    const c = m.c ?? WHITE;
    const R = this.art; R.need(4);
    R.a[R.n++] = Math.min(255, Math.round(c[0] * ao * 255)); R.a[R.n++] = Math.min(255, Math.round(c[1] * ao * 255));
    R.a[R.n++] = Math.min(255, Math.round(c[2] * ao * 255));
    R.a[R.n++] = m.belt !== undefined ? 200 + m.belt : Math.min(199, Math.round((m.e ?? 0) * 16));
    if (this.skin) { const S = this.skin; S.need(4); S.a[S.n++] = this.bone; S.a[S.n++] = 0; S.a[S.n++] = 0; S.a[S.n++] = 0; }
  }
  _tri(a, b, c) {
    for (const g of this.cur) { g.need(3); g.a[g.n++] = a; g.a[g.n++] = b; g.a[g.n++] = c; }
    this.tris++;
  }
  _tile(m) {
    const t = TILES[m.t];
    if (!t) throw new Error(`art: unknown tile ${m.t}`);
    return t.q;
  }

  /** quad from 4 corners (counter-clockwise seen from the front), uv per corner, flat normal */
  quad(p, uvs, m, two = false) {
    const [a, b, c] = p;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const tile = this._tile(m), v0 = this.vcount;
    for (let k = 0; k < 4; k++) this._v(p[k][0], p[k][1], p[k][2], nx, ny, nz, uvs[k][0], uvs[k][1], tile, m, 1);
    this._tri(v0, v0 + 1, v0 + 2); this._tri(v0, v0 + 2, v0 + 3);
    if (two) {
      const v1 = this.vcount;
      for (let k = 0; k < 4; k++) this._v(p[k][0], p[k][1], p[k][2], -nx, -ny, -nz, uvs[k][0], uvs[k][1], tile, m, 1);
      this._tri(v1, v1 + 2, v1 + 1); this._tri(v1, v1 + 3, v1 + 2);
    }
  }

  /** face uv: fit (0..1 inset) or metres/scale, with optional sub-rect */
  _faceUV(m, u0, u1, v0, v1) {
    const s = m.s;
    if (!s) {
      const sub = m.sub ?? FULL, e = 0.002;
      const a = sub[0] + (sub[2] - sub[0]) * e, b = sub[2] - (sub[2] - sub[0]) * e, c = sub[1] + (sub[3] - sub[1]) * e, d = sub[3] - (sub[3] - sub[1]) * e;
      return [[a, c], [b, c], [b, d], [a, d]];
    }
    const su = Array.isArray(s) ? s[0] : s, sv = Array.isArray(s) ? s[1] : s;
    const o = m.o ?? ZERO2;
    return [[u0 / su + o[0], v0 / sv + o[1]], [u1 / su + o[0], v0 / sv + o[1]], [u1 / su + o[0], v1 / sv + o[1]], [u0 / su + o[0], v1 / sv + o[1]]];
  }

  /** axis-aligned box in the current frame. skip: face bits not emitted. mf: per-face material overrides
   *  { [bit]: m }. Planar uv: u along the face's right (seen from outside), v up (+y; top/bottom: -z / +z). */
  box(x0, y0, z0, x1, y1, z1, m, skip = 0, mf = null) {
    const F = (bit) => (mf && mf[bit]) || m;
    if (!(skip & FX)) { const q = F(FX); this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], this._faceUV(q, -z1, -z0, y0, y1), q); }
    if (!(skip & NX)) { const q = F(NX); this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], this._faceUV(q, z0, z1, y0, y1), q); }
    if (!(skip & FZ)) { const q = F(FZ); this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], this._faceUV(q, x0, x1, y0, y1), q); }
    if (!(skip & NZ)) { const q = F(NZ); this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], this._faceUV(q, -x1, -x0, y0, y1), q); }
    if (!(skip & FY)) { const q = F(FY); this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], this._faceUV(q, x0, x1, -z1, -z0), q); }
    if (!(skip & NY)) { const q = F(NY); this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], this._faceUV(q, x0, x1, z0, z1), q); }
  }
  /** box by centre + size */
  boxC(cx, cy, cz, sx, sy, sz, m, skip = 0, mf = null) { this.box(cx - sx / 2, cy, cz - sz / 2, cx + sx / 2, cy + sy, cz + sz / 2, m, skip, mf); }

  /** chamfered box (edges bevelled by b): catches light on edges; 44 tris. skip only affects the 6 main faces */
  bbox(x0, y0, z0, x1, y1, z1, b, m, skip = 0, mf = null) {
    if (b <= 0) { this.box(x0, y0, z0, x1, y1, z1, m, skip, mf); return; }
    const F = (bit) => (mf && mf[bit]) || m;
    const X0 = x0 + b, X1 = x1 - b, Y0 = y0 + b, Y1 = y1 - b, Z0 = z0 + b, Z1 = z1 - b;
    // main faces (inset)
    if (!(skip & FX)) { const q = F(FX); this.quad([[x1, Y0, Z1], [x1, Y0, Z0], [x1, Y1, Z0], [x1, Y1, Z1]], this._faceUV(q, -Z1, -Z0, Y0, Y1), q); }
    if (!(skip & NX)) { const q = F(NX); this.quad([[x0, Y0, Z0], [x0, Y0, Z1], [x0, Y1, Z1], [x0, Y1, Z0]], this._faceUV(q, Z0, Z1, Y0, Y1), q); }
    if (!(skip & FZ)) { const q = F(FZ); this.quad([[X0, Y0, z1], [X1, Y0, z1], [X1, Y1, z1], [X0, Y1, z1]], this._faceUV(q, X0, X1, Y0, Y1), q); }
    if (!(skip & NZ)) { const q = F(NZ); this.quad([[X1, Y0, z0], [X0, Y0, z0], [X0, Y1, z0], [X1, Y1, z0]], this._faceUV(q, -X1, -X0, Y0, Y1), q); }
    if (!(skip & FY)) { const q = F(FY); this.quad([[X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [X0, y1, Z0]], this._faceUV(q, X0, X1, -Z1, -Z0), q); }
    if (!(skip & NY)) { const q = F(NY); this.quad([[X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1]], this._faceUV(q, X0, X1, Z0, Z1), q); }
    const mm = { ...m, s: m.s || 0.5 };
    const uvq = (l) => [[0, 0], [l / (mm.s || 1), 0], [l / (mm.s || 1), b / (mm.s || 1)], [0, b / (mm.s || 1)]];
    // 12 edge chamfers
    const E = (p) => this.quad(p, uvq(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])), mm);
    // vertical edges
    E([[X1, Y0, z1], [x1, Y0, Z1], [x1, Y1, Z1], [X1, Y1, z1]]);
    E([[x1, Y0, Z0], [X1, Y0, z0], [X1, Y1, z0], [x1, Y1, Z0]]);
    E([[X0, Y0, z0], [x0, Y0, Z0], [x0, Y1, Z0], [X0, Y1, z0]]);
    E([[x0, Y0, Z1], [X0, Y0, z1], [X0, Y1, z1], [x0, Y1, Z1]]);
    // top edges
    E([[X0, Y1, z1], [X1, Y1, z1], [X1, y1, Z1], [X0, y1, Z1]]);
    E([[X1, Y1, z0], [X0, Y1, z0], [X0, y1, Z0], [X1, y1, Z0]]);
    E([[x1, Y1, Z1], [x1, Y1, Z0], [X1, y1, Z0], [X1, y1, Z1]]);
    E([[x0, Y1, Z0], [x0, Y1, Z1], [X0, y1, Z1], [X0, y1, Z0]]);
    // bottom edges
    E([[X1, Y0, z1], [X0, Y0, z1], [X0, y0, Z1], [X1, y0, Z1]]);
    E([[X0, Y0, z0], [X1, Y0, z0], [X1, y0, Z0], [X0, y0, Z0]]);
    E([[x1, Y0, Z0], [x1, Y0, Z1], [X1, y0, Z1], [X1, y0, Z0]]);
    E([[x0, Y0, Z1], [x0, Y0, Z0], [X0, y0, Z0], [X0, y0, Z1]]);
    // 8 corner triangles
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const C = (a, b2, c) => { const tile = this._tile(mm), v0 = this.vcount;
      const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const out = nx * (a[0] - cx) + ny * (a[1] - cy) + nz * (a[2] - cz) > 0;
      if (!out) { nx = -nx; ny = -ny; nz = -nz; }
      this._v(...a, nx, ny, nz, 0, 0, tile, mm, 1); this._v(...b2, nx, ny, nz, 0.1, 0, tile, mm, 1); this._v(...c, nx, ny, nz, 0, 0.1, tile, mm, 1);
      if (out) this._tri(v0, v0 + 1, v0 + 2); else this._tri(v0, v0 + 2, v0 + 1); };
    C([x1, Y1, Z1], [X1, Y1, z1], [X1, y1, Z1]); C([X1, Y1, z0], [x1, Y1, Z0], [X1, y1, Z0]);
    C([x0, Y1, Z0], [X0, Y1, z0], [X0, y1, Z0]); C([X0, Y1, z1], [x0, Y1, Z1], [X0, y1, Z1]);
    C([X1, Y0, z1], [x1, Y0, Z1], [X1, y0, Z1]); C([x1, Y0, Z0], [X1, Y0, z0], [X1, y0, Z0]);
    C([X0, Y0, z0], [x0, Y0, Z0], [X0, y0, Z0]); C([x0, Y0, Z1], [X0, Y0, z1], [X0, y0, Z1]);
  }

  /** cylinder along +y from (cx, y0, cz), radius r, height h, seg sides; caps: 1 top, 2 bottom. uv: u around
   *  (one tile repeat per `us` metres of circumference or fit), v up. smooth normals. */
  cyl(cx, y0, cz, r, h, seg, m, caps = 1, r1 = r, capM = null) {
    const tile = this._tile(m), v0 = this.vcount;
    const circ = 2 * Math.PI * r;
    const su = m.s ? (Array.isArray(m.s) ? m.s[0] : m.s) : circ, sv = m.s ? (Array.isArray(m.s) ? m.s[1] : m.s) : h;
    const sub = m.s ? null : (m.sub ?? FULL);
    const slope = (r - r1) / h;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nl = Math.hypot(1, slope);
      const U = sub ? sub[0] + (sub[2] - sub[0]) * (i / seg) : (i / seg) * circ / su;
      const V0 = sub ? sub[1] : 0, V1 = sub ? sub[3] : h / sv;
      this._v(cx + c * r, y0, cz - s * r, c / nl, slope / nl, -s / nl, U, V0, tile, m, 1);
      this._v(cx + c * r1, y0 + h, cz - s * r1, c / nl, slope / nl, -s / nl, U, V1, tile, m, 1);
    }
    for (let i = 0; i < seg; i++) { const a = v0 + i * 2; this._tri(a, a + 2, a + 3); this._tri(a, a + 3, a + 1); }
    const cm = capM ?? m;
    if (caps & 1) this._disc(cx, y0 + h, cz, r1, seg, cm, 1);
    if (caps & 2) this._disc(cx, y0, cz, r, seg, cm, -1);
  }
  _disc(cx, y, cz, r, seg, m, dir) {
    const tile = this._tile(m), v0 = this.vcount;
    const sub = m.s ? null : (m.sub ?? FULL), s = m.s ? (Array.isArray(m.s) ? m.s[0] : m.s) : 1;
    const UV = (x, z) => (sub ? [sub[0] + (sub[2] - sub[0]) * (0.5 + x / (2 * r)), sub[1] + (sub[3] - sub[1]) * (0.5 - z / (2 * r))] : [x / s, -z / s]);
    let q = UV(0, 0); this._v(cx, y, cz, 0, dir, 0, q[0], q[1], tile, m, 1);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, x = Math.cos(a) * r, z = -Math.sin(a) * r;
      q = UV(x, z); this._v(cx + x, y, cz + z, 0, dir, 0, q[0], q[1], tile, m, 1);
    }
    for (let i = 0; i < seg; i++) { if (dir > 0) this._tri(v0, v0 + 1 + i, v0 + 2 + i); else this._tri(v0, v0 + 2 + i, v0 + 1 + i); }
  }
  /** cylinder between two points (pipes, rails, tubes) */
  tube(a, b, r, seg, m, caps = 0) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const y = [dx / len, dy / len, dz / len];
    let x = Math.abs(y[1]) < 0.9 ? [y[2], 0, -y[0]] : [1, 0, 0];   // perpendicular
    const xl = Math.hypot(...x); x = x.map((v) => v / xl);
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    this.push([x[0], y[0], z[0], a[0], x[1], y[1], z[1], a[1], x[2], y[2], z[2], a[2]]);
    this.cyl(0, 0, 0, r, len, seg, m, caps);
    this.pop();
  }
}

const WHITE = [1, 1, 1], FULL = [0, 0, 1, 1], ZERO2 = [0, 0];

/** deterministic PRNG (mulberry32) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** hash of a string/number → uint32 */
export function hash32(s) { s = String(s); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
