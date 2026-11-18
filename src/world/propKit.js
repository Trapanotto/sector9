// Procedural detailing kit for props: chamfered boxes, lathe/torus parts, wheels, bolts, and a label atlas
// (warning signs, gauges, control panels, vents, stencils) drawn as one merged decal mesh.
// All geometry goes into the shared Batcher buckets (one draw call per material key).
//
// Z-fighting rule used throughout: two parts never share a face plane. Attached details are inset or
// proud by >= 8 mm, labels float 6 mm off their surface and use polygonOffset (near plane is 3 cm).
import * as THREE from 'three';

const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export class Kit {
  constructor(B, R) {
    this.B = B; this.R = R;
    this.labels = { pos: [], nor: [], uv: [], col: [], idx: [] };
    this.glass = { pos: [], nor: [], uv: [], col: [], idx: [] };   // transparent panes (vending machine, cabinets)
    this.bolts = [];      // [x,y,z, nx,ny,nz, scale]
  }
  rr(a, b) { return a + (b - a) * this.R(); }

  // Push one triangle list (flat or smooth) into a bucket. verts: array of {p:Vector3 local, n:Vector3 local}.
  _push(key, verts, tris, o = {}) {
    const B = this.B, b = B.bucket(key);
    const sc = (o.uvScale ?? 1) / (B.scales[key] ?? 2);
    const m = o.matrix || null;
    if (m) _nm.getNormalMatrix(m);
    const base = b.pos.length / 3;
    const tint = o.tint ?? 1;
    const uo = o.uvOffset || [0, 0];
    for (const v of verts) {
      _p.copy(v.p); _n.copy(v.n);
      // box-projected UVs from local coordinates (stable texel density, no stretching on chamfers)
      const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
      let u, w;
      if (v.uv) { u = v.uv[0]; w = v.uv[1]; }
      else if (ay >= ax && ay >= az) { u = _p.x; w = _p.z; }
      else if (ax >= az) { u = _p.z * Math.sign(_n.x || 1); w = _p.y; }
      else { u = -_p.x * Math.sign(_n.z || 1); w = _p.y; }
      if (m) { _p.applyMatrix4(m); _n.applyMatrix3(_nm).normalize(); }
      b.pos.push(_p.x, _p.y, _p.z); b.nor.push(_n.x, _n.y, _n.z);
      b.uv.push(u * sc + uo[0], w * sc + uo[1]);
      const c = o.color || B.grime(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, o.base ?? 0);
      const k = v.k ?? 1;
      b.col.push(c[0] * tint * k, c[1] * tint * k, c[2] * tint * k);
    }
    for (const i of tris) b.idx.push(base + i);
  }

  // Chamfered box (bevelled edges catch the light: the main cue that separates "object" from "box").
  // min/max are local coordinates; o.matrix transforms them; o.r is the bevel size.
  cbox(min, max, key, o = {}) {
    const h = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
    const c = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
    if (h[0] <= 0 || h[1] <= 0 || h[2] <= 0) return;
    const r = Math.min(o.r ?? 0.015, h[0] * 0.45, h[1] * 0.45, h[2] * 0.45);
    const V = (s, axis) => {
      const p = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = c[k] + s[k] * (k === axis ? h[k] : h[k] - r);
      return new THREE.Vector3(p[0], p[1], p[2]);
    };
    const verts = [], tris = [];
    const skip = o.skip || '';
    const poly = (pts, n, dark = 1) => {
      // fix winding against the intended normal
      _a.subVectors(pts[1], pts[0]); _b.subVectors(pts[2], pts[0]); _c.crossVectors(_a, _b);
      if (_c.dot(n) < 0) pts.reverse();
      const i0 = verts.length;
      for (const p of pts) verts.push({ p, n, k: dark });
      for (let i = 1; i < pts.length - 1; i++) tris.push(i0, i0 + i, i0 + i + 1);
    };
    const S = [-1, 1];
    for (let a = 0; a < 3; a++) for (const s of S) {
      const fname = (s > 0 ? 'p' : 'n') + 'xyz'[a];
      if (skip.includes(fname)) continue;
      const b1 = (a + 1) % 3, b2 = (a + 2) % 3;
      const pts = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const sg = [0, 0, 0]; sg[a] = s; sg[b1] = u; sg[b2] = v; pts.push(V(sg, a)); }
      const n = new THREE.Vector3(); n.setComponent(a, s);
      poly(pts, n);
    }
    if (r > 1e-4) {
      for (let a = 0; a < 3; a++) {
        const b1 = (a + 1) % 3, b2 = (a + 2) % 3;
        for (const s1 of S) for (const s2 of S) {
          // edge along axis a, between faces b1 (s1) and b2 (s2)
          const pts = [];
          for (const [sa, ax] of [[-1, b1], [1, b1], [1, b2], [-1, b2]]) { const sg = [0, 0, 0]; sg[a] = sa; sg[b1] = s1; sg[b2] = s2; pts.push(V(sg, ax)); }
          const n = new THREE.Vector3(); n.setComponent(b1, s1); n.setComponent(b2, s2); n.normalize();
          poly(pts, n, 1.08);   // edges a touch brighter: worn paint / dust on edges
        }
      }
      for (const sx of S) for (const sy of S) for (const sz of S) {
        const sg = [sx, sy, sz];
        poly([V(sg, 0), V(sg, 1), V(sg, 2)], new THREE.Vector3(sx, sy, sz).normalize(), 1.08);
      }
    }
    this._push(key, verts, tris, o);
  }

  // Flat polygon (3+ points, Vector3/arrays) whose normal is oriented toward `out` (a direction hint).
  poly(key, pts, out, o = {}) {
    const P = pts.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
    _a.subVectors(P[1], P[0]); _b.subVectors(P[P.length - 1], P[0]);
    const n = new THREE.Vector3().crossVectors(_a, _b).normalize();
    if (out && n.dot(_c.set(out[0], out[1], out[2])) < 0) { P.reverse(); n.negate(); }
    const verts = P.map((p) => ({ p, n }));
    const tris = [];
    for (let i = 1; i < P.length - 1; i++) tris.push(0, i, i + 1);
    this._push(key, verts, tris, o);
  }
  // Tapered box: bottom rect (y0) and top rect (y1), each [minX, minZ, maxX, maxZ]. Faces get flat normals.
  hull(key, y0, bot, y1, top, o = {}) {
    const b = [[bot[0], y0, bot[1]], [bot[2], y0, bot[1]], [bot[2], y0, bot[3]], [bot[0], y0, bot[3]]];
    const t = [[top[0], y1, top[1]], [top[2], y1, top[1]], [top[2], y1, top[3]], [top[0], y1, top[3]]];
    const cx = (bot[0] + bot[2] + top[0] + top[2]) / 4, cz = (bot[1] + bot[3] + top[1] + top[3]) / 4, cy = (y0 + y1) / 2;
    const face = (pts) => {
      const m = pts.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
      const P = o.matrix ? pts.map((p) => new THREE.Vector3(...p)) : pts;
      this.poly(key, P, [m[0] - cx, m[1] - cy, m[2] - cz], o);
    };
    const sk = o.skip || '';
    if (!sk.includes('ny')) face(b);
    if (!sk.includes('py')) face(t);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face([b[i], b[j], t[j], t[i]]); }
  }

  // Any THREE geometry (local coords) with a matrix. uvMode 'box' (default) or 'own' (keeps the geometry UVs * uvScale).
  geo(key, g, matrix, o = {}) {
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const verts = [];
    for (let i = 0; i < pos.count; i++) {
      verts.push({ p: new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)), n: new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i)),
        uv: o.uvMode === 'own' && uv ? [uv.getX(i) * (o.uvU ?? 1), uv.getY(i) * (o.uvV ?? 1)] : null });
    }
    const tris = [];
    if (g.index) for (let i = 0; i < g.index.count; i++) tris.push(g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) tris.push(i);
    this._push(key, verts, tris, { ...o, matrix });
    g.dispose();
  }

  // Cylinder between two points (open or capped), any radius; wraps Batcher.pipe.
  pipe(key, a, b, r, o = {}) { this.B.pipe(key, a, b, r, o); }

  // Lathe from a profile [[r, y], ...] around local Y, then matrix.
  lathe(key, profile, matrix, o = {}) {
    const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), o.segs ?? 16);
    this.geo(key, g, matrix, o);
  }

  // Wheel: tyre (rubber torus-ish lathe) + steel rim + hub + lug nuts. c = centre, axis 'x' or 'z', side = outward sign.
  wheel(c, r, width, axis = 'x', side = 1, o = {}) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis === 'x' ? new THREE.Vector3(side, 0, 0) : new THREE.Vector3(0, 0, side));
    m.compose(new THREE.Vector3(...c), q, new THREE.Vector3(1, 1, 1));
    const w = width / 2, ri = r * (o.rimRatio ?? 0.62);
    // tyre: rounded profile with sidewall bulge and a tread
    const prof = [[ri, -w * 0.9], [ri + 0.02, -w], [r - 0.05, -w * 0.98], [r - 0.012, -w * 0.8], [r, -w * 0.5], [r, w * 0.5], [r - 0.012, w * 0.8], [r - 0.05, w * 0.98], [ri + 0.02, w], [ri, w * 0.9]];
    this.lathe('rubber', prof, m, { segs: o.segs ?? 20, color: [0.9, 0.9, 0.9] });
    // rim dish (outer side recessed), hub
    const rim = o.rimKey || 'steel';
    this.lathe(rim, [[0.001, w * 0.35], [ri * 0.35, w * 0.35], [ri * 0.45, w * 0.55], [ri * 0.92, w * 0.62], [ri + 0.008, w * 0.85], [ri + 0.008, -w * 0.85], [ri * 0.92, -w * 0.5], [0.001, -w * 0.5]], m, { segs: o.segs ?? 20, tint: o.rimTint ?? 0.9 });
    const hub = new THREE.Vector3(0, w * 0.36, 0).applyMatrix4(m);
    const nrm = axis === 'x' ? [side, 0, 0] : [0, 0, side];
    const lugs = o.lugs ?? 5;
    for (let i = 0; i < lugs; i++) {
      const a = (i / lugs) * Math.PI * 2;
      const lp = new THREE.Vector3(Math.cos(a) * ri * 0.28, w * 0.36, Math.sin(a) * ri * 0.28).applyMatrix4(m);
      this.bolt([lp.x, lp.y, lp.z], nrm, 1.2);
    }
    return hub;
  }

  bolt(p, n, s = 1) { this.bolts.push([p[0], p[1], p[2], n[0], n[1], n[2], s]); }
  // a row of bolts between two points
  boltRow(a, b, n, count, s = 1) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      this.bolt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], n, s);
    }
  }

  // Label quad from the atlas. c = centre on the surface, n = outward normal (axis-aligned or any), w/h size,
  // tile = atlas cell index, o.up = up vector (default +Y; for horizontal faces default -Z), o.rot = in-plane rotation.
  label(c, n, w, h, tile, o = {}) {
    const N = new THREE.Vector3(...n).normalize();
    let up = o.up ? new THREE.Vector3(...o.up) : (Math.abs(N.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0));
    const right = new THREE.Vector3().crossVectors(up, N).normalize();
    up = new THREE.Vector3().crossVectors(N, right).normalize();
    if (o.rot) { right.applyAxisAngle(N, o.rot); up.applyAxisAngle(N, o.rot); }
    const off = o.offset ?? 0.006;
    const C = new THREE.Vector3(...c).addScaledVector(N, off);
    const cols = ATLAS.cols, tu = tile % cols, tv = Math.floor(tile / cols);
    const u0 = (tu + (o.u0 ?? 0)) / cols, u1 = (tu + (o.u1 ?? 1)) / cols, v0 = 1 - (tv + 1) / cols, v1 = 1 - tv / cols;
    const L = o.glass ? this.glass : this.labels, base = L.pos.length / 3;
    const k = o.k ?? (0.75 + this.R() * 0.3);
    const corners = [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]];
    for (const [sx, sy, u, v] of corners) {
      const P = C.clone().addScaledVector(right, sx * w / 2).addScaledVector(up, sy * h / 2);
      L.pos.push(P.x, P.y, P.z); L.nor.push(N.x, N.y, N.z); L.uv.push(u, v);
      const g = this.B.grime(P.x, P.y, P.z, N.x, N.y, N.z, 0)[0] * k;
      L.col.push(g, g * 0.98, g * 0.94);
    }
    L.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Hazard stripe band made of repeated stripe tiles.
  stripes(a, b, n, h, o = {}) {
    const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b), len = A.distanceTo(Bv);
    const cnt = Math.max(1, Math.round(len / (h * 2)));
    const dir = Bv.clone().sub(A).divideScalar(cnt);
    for (let i = 0; i < cnt; i++) {
      const c = A.clone().addScaledVector(dir, i + 0.5);
      this.label([c.x, c.y, c.z], n, len / cnt, h, TILE.stripes, { ...o, up: o.up, k: o.k ?? 0.8 });
    }
  }

  buildLabels(L = this.labels) {
    if (!L.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(L.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(L.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(L.col, 3));
    g.setIndex(L.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ label atlas (canvas, 4x4 tiles)
export const ATLAS = { cols: 4, size: 1024 };
export const TILE = {
  stripes: 0, warnCrush: 1, warnVolt: 2, plate: 3, estop: 4, stencil: 5, fire: 6, noSmoke: 7,
  exit: 8, maker: 9, gauge: 10, panel: 11, vent: 12, number: 13, rust: 14, notice: 15,
};

function canvas2d(S) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = S; c.height = S; return c; }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(S, S);
  return null;
}

// Prop-only materials (not part of the shared library): corrugated cardboard and worn yellow machine paint.
// Returned as { key: MeshStandardMaterial } or null outside the browser.
export function makePropMaterials() {
  const S = 512;
  const R = seeded(777);
  const tex = (draw, srgb = true) => {
    const c = canvas2d(S); if (!c) return null;
    const g = c.getContext('2d'); draw(g);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  const speckle = (g, n, col, rmax, amax) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = col.replace('A', (R() * amax).toFixed(3));
      g.beginPath(); g.arc(R() * S, R() * S, 0.5 + R() * rmax, 0, 7); g.fill();
    }
  };
  const card = tex((g) => {
    g.fillStyle = '#9c7a4e'; g.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 2) { g.fillStyle = `rgba(${R() < 0.5 ? '255,235,200' : '60,40,20'},${(R() * 0.05).toFixed(3)})`; g.fillRect(0, y, S, 2); }
    for (let x = 0; x < S; x += 6) { g.fillStyle = 'rgba(70,50,25,0.05)'; g.fillRect(x, 0, 2, S); }   // flute lines
    speckle(g, 2500, 'rgba(50,35,20,A)', 1.2, 0.25);
    speckle(g, 60, 'rgba(80,55,30,A)', 30, 0.12);                                                      // water stains
    for (let i = 0; i < 8; i++) { g.strokeStyle = `rgba(40,30,20,${(0.1 + R() * 0.2).toFixed(2)})`; g.lineWidth = 1 + R() * 2; g.beginPath(); const x = R() * S, y = R() * S; g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 120, y + (R() - 0.5) * 30); g.stroke(); }
    // faded printed blocks (no legible text: box projection mirrors some faces)
    for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(35,30,25,${(0.08 + R() * 0.12).toFixed(2)})`; g.fillRect(R() * S, R() * S, 30 + R() * 90, 6 + R() * 16); }
  });
  const yellow = tex((g) => {
    g.fillStyle = '#c49a22'; g.fillRect(0, 0, S, S);
    speckle(g, 80, 'rgba(120,90,30,A)', 40, 0.18);
    speckle(g, 3000, 'rgba(60,45,20,A)', 1.5, 0.3);
    for (let i = 0; i < 260; i++) {                                                                      // chips to bare/rusty metal
      const x = R() * S, y = R() * S, big = R() < 0.08, w = big ? 4 + R() * 8 : 0.8 + R() * 3, h = big ? 2 + R() * 4 : 0.5 + R() * 1.5;
      g.fillStyle = R() < 0.5 ? `rgba(70,66,60,${(0.5 + R() * 0.4).toFixed(2)})` : `rgba(110,55,22,${(0.4 + R() * 0.5).toFixed(2)})`;
      g.beginPath(); g.ellipse(x, y, w, h, R() * 3, 0, 7); g.fill();
    }
    for (let i = 0; i < 60; i++) { g.strokeStyle = `rgba(50,40,30,${(0.2 + R() * 0.4).toFixed(2)})`; g.lineWidth = 0.6 + R(); g.beginPath(); const x = R() * S, y = R() * S; g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 80, y + (R() - 0.5) * 20); g.stroke(); }
    for (let i = 0; i < 12; i++) {                                                                       // rust runs
      const x = R() * S, len = 40 + R() * 160, gr = g.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, 'rgba(100,50,20,0.5)'); gr.addColorStop(1, 'rgba(100,50,20,0)');
      g.save(); g.translate(x, R() * S); g.fillStyle = gr; g.fillRect(0, 0, 2 + R() * 5, len); g.restore();
    }
  });
  const white = tex((g) => {
    g.fillStyle = '#c4c1b6'; g.fillRect(0, 0, S, S);
    speckle(g, 60, 'rgba(110,105,90,A)', 50, 0.14);
    speckle(g, 2500, 'rgba(70,65,55,A)', 1.2, 0.25);
    for (let i = 0; i < 30; i++) {                                                                        // grime runs
      const x = R() * S, len = 60 + R() * 260, gr = g.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, 'rgba(60,55,45,0.28)'); gr.addColorStop(1, 'rgba(60,55,45,0)');
      g.save(); g.translate(x, R() * S * 0.6); g.fillStyle = gr; g.fillRect(0, 0, 2 + R() * 9, len); g.restore();
    }
    for (let i = 0; i < 90; i++) {
      const x = R() * S, y = R() * S, w = 0.8 + R() * 4, h = 0.5 + R() * 2;
      g.fillStyle = R() < 0.6 ? `rgba(120,62,28,${(0.4 + R() * 0.5).toFixed(2)})` : `rgba(80,78,72,${(0.4 + R() * 0.4).toFixed(2)})`;
      g.beginPath(); g.ellipse(x, y, w, h, R() * 3, 0, 7); g.fill();
    }
  });
  if (!card || !yellow || !white) return null;
  const mk = (map, o) => {
    const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: o.rough, metalness: o.metal ?? 0, envMapIntensity: 0.32 });
    m.name = o.name; return m;
  };
  return {
    cardboard: mk(card, { rough: 0.95, name: 'propCardboard' }),
    forkYellow: mk(yellow, { rough: 0.62, metal: 0.15, name: 'propYellowPaint' }),
    vanWhite: mk(white, { rough: 0.55, metal: 0.2, name: 'propWhitePaint' }),
  };
}
export const PROP_SCALES = { cardboard: 0.9, forkYellow: 0.8, vanWhite: 1.6 };
export const PROP_SURFACES = { cardboard: 'wood', forkYellow: 'metal', vanWhite: 'metal' };

function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function makeLabelTexture() {
  const S = ATLAS.size, T = S / ATLAS.cols;
  let c;
  if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = S; c.height = S; }
  else if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(S, S);
  else return null;
  const g = c.getContext('2d');
  const R = seeded(1234);
  g.clearRect(0, 0, S, S);
  const cell = (i, fn) => { const x = (i % 4) * T, y = Math.floor(i / 4) * T; g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, T, T); g.clip(); fn(g, T); g.restore(); };
  const dirt = (g2, T2, amt = 0.25, rust = false) => {
    for (let i = 0; i < 220; i++) {
      const x = R() * T2, y = R() * T2, r = 1 + R() * (rust ? 10 : 6);
      g2.fillStyle = rust ? `rgba(${90 + R() * 40},${45 + R() * 20},${20},${R() * amt})` : `rgba(40,34,28,${R() * amt})`;
      g2.beginPath(); g2.arc(x, y, r, 0, 7); g2.fill();
    }
    // chipped spots revealing grey metal
    for (let i = 0; i < 30; i++) { g2.fillStyle = `rgba(120,118,112,${0.3 + R() * 0.4})`; g2.fillRect(R() * T2, R() * T2, 1 + R() * 5, 1 + R() * 3); }
  };
  const text = (g2, s, x, y, size, color, weight = 'bold', font = 'Arial, Helvetica, sans-serif') => {
    g2.fillStyle = color; g2.font = `${weight} ${size}px ${font}`; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText(s, x, y);
  };
  // 0 hazard stripes
  cell(0, (g2, T2) => {
    g2.fillStyle = '#d8a812'; g2.fillRect(0, 0, T2, T2);
    g2.fillStyle = '#141414';
    for (let k = -4; k < 8; k++) { g2.beginPath(); g2.moveTo(k * T2 / 4, 0); g2.lineTo(k * T2 / 4 + T2 / 8, 0); g2.lineTo(k * T2 / 4 + T2 / 8 + T2, T2); g2.lineTo(k * T2 / 4 + T2, T2); g2.fill(); }
    dirt(g2, T2, 0.35);
  });
  const triangleSign = (g2, T2, glyph, caption) => {
    g2.fillStyle = '#f0f0ea'; g2.fillRect(T2 * 0.06, T2 * 0.06, T2 * 0.88, T2 * 0.88);
    g2.fillStyle = '#e2b414'; g2.strokeStyle = '#111'; g2.lineWidth = T2 * 0.04;
    g2.beginPath(); g2.moveTo(T2 / 2, T2 * 0.12); g2.lineTo(T2 * 0.86, T2 * 0.68); g2.lineTo(T2 * 0.14, T2 * 0.68); g2.closePath(); g2.fill(); g2.stroke();
    glyph(g2, T2);
    text(g2, caption, T2 / 2, T2 * 0.8, T2 * 0.1, '#111');
    dirt(g2, T2, 0.3);
  };
  cell(1, (g2, T2) => triangleSign(g2, T2, (q) => { q.fillStyle = '#111'; q.fillRect(T2 * 0.4, T2 * 0.36, T2 * 0.2, T2 * 0.07); q.fillRect(T2 * 0.4, T2 * 0.5, T2 * 0.2, T2 * 0.07); q.fillRect(T2 * 0.47, T2 * 0.28, T2 * 0.06, T2 * 0.06); }, 'QUETSCHGEFAHR'));
  cell(2, (g2, T2) => triangleSign(g2, T2, (q) => { q.fillStyle = '#111'; q.beginPath(); q.moveTo(T2 * 0.53, T2 * 0.27); q.lineTo(T2 * 0.42, T2 * 0.47); q.lineTo(T2 * 0.51, T2 * 0.47); q.lineTo(T2 * 0.45, T2 * 0.63); q.lineTo(T2 * 0.6, T2 * 0.42); q.lineTo(T2 * 0.51, T2 * 0.42); q.closePath(); q.fill(); }, 'HOCHSPANNUNG'));
  // 3 machine type plate (brushed metal)
  cell(3, (g2, T2) => {
    g2.fillStyle = '#9a9a94'; g2.fillRect(T2 * 0.04, T2 * 0.2, T2 * 0.92, T2 * 0.6);
    for (let i = 0; i < 60; i++) { g2.fillStyle = `rgba(255,255,255,${R() * 0.08})`; g2.fillRect(T2 * 0.04, T2 * 0.2 + R() * T2 * 0.6, T2 * 0.92, 1); }
    text(g2, 'KRAMER WERKE', T2 / 2, T2 * 0.32, T2 * 0.09, '#222');
    text(g2, 'Typ HP-250  Nr. 4471', T2 / 2, T2 * 0.47, T2 * 0.065, '#222', 'normal');
    text(g2, 'Baujahr 1974  250 t', T2 / 2, T2 * 0.59, T2 * 0.065, '#222', 'normal');
    text(g2, 'Gelsenkirchen', T2 / 2, T2 * 0.7, T2 * 0.055, '#333', 'normal');
    g2.fillStyle = '#333'; for (const [x, y] of [[0.08, 0.24], [0.92, 0.24], [0.08, 0.76], [0.92, 0.76]]) { g2.beginPath(); g2.arc(T2 * x, T2 * y, T2 * 0.015, 0, 7); g2.fill(); }
    dirt(g2, T2, 0.3);
  });
  // 4 emergency stop label (yellow round with red)
  cell(4, (g2, T2) => {
    g2.fillStyle = '#e0b818'; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.44, 0, 7); g2.fill();
    g2.fillStyle = '#b01a12'; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.22, 0, 7); g2.fill();
    text(g2, 'NOT-AUS', T2 / 2, T2 * 0.84, T2 * 0.09, '#111');
    dirt(g2, T2, 0.2);
  });
  // 5 container stencil
  cell(5, (g2, T2) => {
    text(g2, 'SKLU 418290 4', T2 / 2, T2 * 0.3, T2 * 0.11, 'rgba(235,235,225,0.9)', 'bold', 'Courier New, monospace');
    text(g2, '22G1', T2 * 0.3, T2 * 0.5, T2 * 0.1, 'rgba(235,235,225,0.9)', 'bold', 'Courier New, monospace');
    text(g2, 'MAX.GR. 30480 KG', T2 / 2, T2 * 0.68, T2 * 0.07, 'rgba(235,235,225,0.85)', 'bold', 'Courier New, monospace');
    text(g2, 'TARE   2230 KG', T2 / 2, T2 * 0.8, T2 * 0.07, 'rgba(235,235,225,0.85)', 'bold', 'Courier New, monospace');
    g2.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 300; i++) { g2.fillStyle = `rgba(0,0,0,${R() * 0.8})`; g2.fillRect(R() * T2, R() * T2, 1 + R() * 4, 1 + R() * 3); }
    g2.globalCompositeOperation = 'source-over';
  });
  // 6 fire extinguisher sign
  cell(6, (g2, T2) => {
    g2.fillStyle = '#b8261c'; g2.fillRect(T2 * 0.12, T2 * 0.12, T2 * 0.76, T2 * 0.76);
    g2.fillStyle = '#f2eee6'; g2.fillRect(T2 * 0.42, T2 * 0.3, T2 * 0.16, T2 * 0.44); g2.fillRect(T2 * 0.38, T2 * 0.24, T2 * 0.18, T2 * 0.06);
    g2.beginPath(); g2.moveTo(T2 * 0.56, T2 * 0.27); g2.lineTo(T2 * 0.7, T2 * 0.4); g2.lineTo(T2 * 0.66, T2 * 0.42); g2.closePath(); g2.fill();
    dirt(g2, T2, 0.25);
  });
  // 7 no smoking
  cell(7, (g2, T2) => {
    g2.fillStyle = '#f2eee6'; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.42, 0, 7); g2.fill();
    g2.fillStyle = '#222'; g2.fillRect(T2 * 0.22, T2 * 0.47, T2 * 0.46, T2 * 0.08); g2.fillStyle = '#c0571e'; g2.fillRect(T2 * 0.66, T2 * 0.47, T2 * 0.1, T2 * 0.08);
    g2.strokeStyle = '#c4201a'; g2.lineWidth = T2 * 0.07; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.38, 0, 7); g2.stroke();
    g2.beginPath(); g2.moveTo(T2 * 0.23, T2 * 0.23); g2.lineTo(T2 * 0.77, T2 * 0.77); g2.stroke();
    dirt(g2, T2, 0.25);
  });
  // 8 emergency exit
  cell(8, (g2, T2) => {
    g2.fillStyle = '#1d8a4a'; g2.fillRect(0, T2 * 0.3, T2, T2 * 0.4);
    g2.fillStyle = '#f2f2ea'; g2.fillRect(T2 * 0.08, T2 * 0.36, T2 * 0.2, T2 * 0.28);
    text(g2, 'NOTAUSGANG', T2 * 0.62, T2 / 2, T2 * 0.1, '#f2f2ea');
    dirt(g2, T2, 0.2);
  });
  // 9 maker logo plate
  cell(9, (g2, T2) => {
    g2.fillStyle = '#2b2b2a'; g2.fillRect(T2 * 0.05, T2 * 0.3, T2 * 0.9, T2 * 0.4);
    g2.strokeStyle = '#b8b2a0'; g2.lineWidth = 4; g2.strokeRect(T2 * 0.08, T2 * 0.33, T2 * 0.84, T2 * 0.34);
    text(g2, 'KW', T2 * 0.24, T2 / 2, T2 * 0.16, '#c8c0aa');
    text(g2, 'KRAMER', T2 * 0.62, T2 * 0.46, T2 * 0.1, '#c8c0aa');
    text(g2, 'MASCHINENBAU', T2 * 0.62, T2 * 0.58, T2 * 0.055, '#c8c0aa');
    dirt(g2, T2, 0.25);
  });
  // 10 gauge face
  cell(10, (g2, T2) => {
    g2.fillStyle = '#eae6da'; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.46, 0, 7); g2.fill();
    g2.strokeStyle = '#111'; g2.lineWidth = 3;
    for (let i = 0; i <= 20; i++) {
      const a = Math.PI * 0.75 + (i / 20) * Math.PI * 1.5, r0 = i % 5 ? 0.36 : 0.32;
      g2.beginPath(); g2.moveTo(T2 / 2 + Math.cos(a) * T2 * r0, T2 / 2 + Math.sin(a) * T2 * r0); g2.lineTo(T2 / 2 + Math.cos(a) * T2 * 0.42, T2 / 2 + Math.sin(a) * T2 * 0.42); g2.stroke();
    }
    g2.strokeStyle = '#c0201a'; g2.lineWidth = 8; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.39, Math.PI * 1.95, Math.PI * 2.25); g2.stroke();
    text(g2, 'bar', T2 / 2, T2 * 0.68, T2 * 0.08, '#222', 'normal');
    g2.strokeStyle = '#111'; g2.lineWidth = 5; g2.beginPath(); g2.moveTo(T2 / 2, T2 / 2); g2.lineTo(T2 / 2 + Math.cos(2.6) * T2 * 0.34, T2 / 2 + Math.sin(2.6) * T2 * 0.34); g2.stroke();
    // glass glare + grime
    const gr = g2.createRadialGradient(T2 * 0.38, T2 * 0.35, 2, T2 / 2, T2 / 2, T2 * 0.46); gr.addColorStop(0, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(60,50,40,0.35)');
    g2.fillStyle = gr; g2.beginPath(); g2.arc(T2 / 2, T2 / 2, T2 * 0.46, 0, 7); g2.fill();
  });
  // 11 control panel (buttons, lamps, labels)
  cell(11, (g2, T2) => {
    g2.fillStyle = '#7d817c'; g2.fillRect(0, 0, T2, T2);
    const cols = ['#1d6b2f', '#a01c14', '#d0a020', '#222', '#dcdcd0'];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) {
      const x = T2 * (0.16 + k * 0.23), y = T2 * (0.22 + r * 0.26);
      g2.fillStyle = '#2a2a2a'; g2.beginPath(); g2.arc(x, y, T2 * 0.075, 0, 7); g2.fill();
      g2.fillStyle = cols[(r * 4 + k * 3) % cols.length]; g2.beginPath(); g2.arc(x, y, T2 * 0.055, 0, 7); g2.fill();
      g2.fillStyle = 'rgba(255,255,255,0.25)'; g2.beginPath(); g2.arc(x - 3, y - 3, T2 * 0.02, 0, 7); g2.fill();
      g2.fillStyle = '#e8e4d8'; g2.fillRect(x - T2 * 0.07, y + T2 * 0.09, T2 * 0.14, T2 * 0.04);
    }
    dirt(g2, T2, 0.35);
  });
  // 12 vent louvres
  cell(12, (g2, T2) => {
    g2.fillStyle = '#4a4c4a'; g2.fillRect(0, 0, T2, T2);
    for (let i = 0; i < 9; i++) {
      const y = T2 * (0.08 + i * 0.1);
      g2.fillStyle = '#0c0c0c'; g2.fillRect(T2 * 0.08, y, T2 * 0.84, T2 * 0.05);
      g2.fillStyle = 'rgba(200,200,190,0.3)'; g2.fillRect(T2 * 0.08, y + T2 * 0.05, T2 * 0.84, 2);
    }
    dirt(g2, T2, 0.4, true);
  });
  // 13 four number plates side by side (use u0/u1 = k/4..(k+1)/4)
  cell(13, (g2, T2) => {
    for (let k = 0; k < 4; k++) {
      const x = k * T2 / 4;
      g2.fillStyle = '#e8e2d0'; g2.fillRect(x + T2 * 0.02, T2 * 0.3, T2 * 0.21, T2 * 0.4);
      text(g2, String(21 + k * 3 + (k > 1 ? 1 : 0)), x + T2 / 8, T2 / 2, T2 * 0.13, '#151515');
    }
    dirt(g2, T2, 0.3);
  });
  // 14 rust streaks (alpha)
  cell(14, (g2, T2) => {
    for (let i = 0; i < 26; i++) {
      const x = R() * T2, w = 2 + R() * 10, len = T2 * (0.3 + R() * 0.7);
      const gr = g2.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, `rgba(${110 + R() * 30},${55 + R() * 15},20,${0.5 + R() * 0.3})`); gr.addColorStop(1, 'rgba(90,45,20,0)');
      g2.fillStyle = gr; g2.fillRect(x, 0, w, len);
    }
  });
  // 15 paper notice
  cell(15, (g2, T2) => {
    g2.fillStyle = '#e4dfcf'; g2.fillRect(T2 * 0.18, T2 * 0.06, T2 * 0.64, T2 * 0.88);
    text(g2, 'WARTUNG', T2 / 2, T2 * 0.16, T2 * 0.08, '#202020');
    g2.fillStyle = 'rgba(30,30,30,0.6)';
    for (let i = 0; i < 12; i++) g2.fillRect(T2 * 0.24, T2 * (0.26 + i * 0.05), T2 * (0.3 + R() * 0.22), 3);
    g2.fillStyle = 'rgba(120,90,40,0.35)'; g2.beginPath(); g2.arc(T2 * 0.62, T2 * 0.7, T2 * 0.1, 0, 7); g2.fill();
    g2.fillStyle = '#888'; g2.beginPath(); g2.arc(T2 / 2, T2 * 0.09, 5, 0, 7); g2.fill();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
