import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { sdRoundCone, sdRoundBox } from './vmGeom.js';
import { GRIP_ANGLE, MAG_ORIGIN } from './vmPistol.js';

// Gloved hands as explicit sculpted geometry (built once at load, ~8k triangles per hand):
//   - every finger and the thumb is ONE lofted tube along a smooth centreline through its joints, with a
//     super-elliptic cross-section (flatter dorsal side, fleshier palm side), palm-side flexion creases and
//     bony knuckle bumps at the joints, a moulded rubber pad on the proximal phalanx and a rounded fingertip;
//   - the back of the hand is a loft from the wrist (narrow, thick) to the knuckle line (wide, flat) that fits
//     through the actual knuckle positions of the grip, with tendons running from each knuckle to the wrist and
//     a closing web lip between the fingers;
//   - a rubber knuckle guard (bar with a dome per knuckle), a thumb web, and a neoprene gauntlet with a raised
//     hook-and-loop strap and tab.
// Separate tubes give crisp creases and real gaps between fingers instead of a blended blob.
// Each hand is ONE SkinnedMesh (16 bones: root, 3 per finger, 3 for the thumb), so fingers can open, close
// round a magazine, press the trigger, and thumbs can work the slide stop / light switch / magazine release.
// Ambient occlusion is baked per vertex in two parts: self (own fingers/palm) and contact (pistol + other hand),
// so the contact shadow can fade out when the support hand leaves the gun.

// ---------------------------------------------------------------- tiny vec3 helpers (arrays)
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const madd = (...terms) => terms.reduce((acc, [v, s]) => add(acc, mul(v, s)), [0, 0, 0]);
const ortho = (v, axis) => norm(sub(v, mul(axis, dot(v, axis))));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- grip frame (matches the magwell)
const cg = Math.cos(GRIP_ANGLE), sgA = Math.sin(GRIP_ANGLE);
const GA = [0, -cg, sgA];          // down the grip
const GF = [0, -sgA, -cg];         // toward the front strap
const GX = [1, 0, 0];
const G = (s, f, x) => [x, MAG_ORIGIN[1] + s * GA[1] + f * GF[1], MAG_ORIGIN[2] + s * GA[2] + f * GF[2]];
const GRIP = { fB: -0.0235, fF: 0.0195, hx: 0.0148, rc: 0.0060 };

// ---------------------------------------------------------------- gun volume (contact AO, sanity checks)
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const GAX = [GA, GF, GX];
const gunBoxes = [
  { c: G(0.059, -0.002, 0), ax: GAX, h: [0.0545, 0.0212, 0.0143], r: 0.0050 },        // grip
  { c: [0, 0.0015, -0.050], ax: AX, h: [0.0102, 0.0098, 0.100], r: 0.0010 },          // upper frame
  { c: [0, 0.0030, 0.0390], ax: AX, h: [0.0102, 0.0060, 0.0090], r: 0.0030 },         // beavertail
  { c: [0, 0.0275, -0.045], ax: AX, h: [0.0126, 0.0170, 0.1120], r: 0.0015 },         // slide
  { c: [0, -0.0265, -0.0445], ax: AX, h: [0.0055, 0.0190, 0.0290], r: 0.0030 },       // trigger guard
  { c: [0, -0.0170, -0.1220], ax: AX, h: [0.0136, 0.0092, 0.0285], r: 0.0040 },       // light
];
export function gunSDF(x, y, z) {
  let d = 1e9;
  for (const b of gunBoxes) d = Math.min(d, sdRoundBox(x, y, z, b.c, b.ax, b.h, b.r));
  return d;
}

// ---------------------------------------------------------------- finger wrap around the grip
// Closed path around the grip cross-section at distance `offset` from the grip surface, starting on the
// right side going forward. Mirror (-x) for the support hand.
function wrapPath(offset, mirror) {
  const { fB, fF, hx, rc } = GRIP;
  const R = rc + offset, xi = hx - rc;
  const pts = [];
  const line = (f0, x0, f1, x1, nf, nx) => {
    const L = Math.hypot(f1 - f0, x1 - x0), n = Math.max(2, Math.ceil(L / 0.0005));
    for (let i = 0; i < n; i++) { const t = i / n; pts.push({ f: f0 + (f1 - f0) * t, x: x0 + (x1 - x0) * t, nf, nx }); }
  };
  const arc = (cf, cx, a0, a1) => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * R / 0.0005));
    for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push({ f: cf + Math.cos(a) * R, x: cx + Math.sin(a) * R, nf: Math.cos(a), nx: Math.sin(a) }); }
  };
  line(fB + rc, xi + R, fF - rc, xi + R, 0, 1);
  arc(fF - rc, xi, Math.PI / 2, 0);
  line(fF - rc + R, xi, fF - rc + R, -xi, 1, 0);
  arc(fF - rc, -xi, 0, -Math.PI / 2);
  line(fF - rc, -xi - R, fB + rc, -xi - R, 0, -1);
  arc(fB + rc, -xi, -Math.PI / 2, -Math.PI);
  line(fB + rc - R, -xi, fB + rc - R, xi, -1, 0);
  arc(fB + rc, xi, Math.PI, Math.PI / 2);
  if (mirror) for (const p of pts) { p.x = -p.x; p.nx = -p.nx; }
  return pts;
}

/** Joints of a finger wrapped round the grip: start on the side at fStart, wrap forward. */
function wrapFinger(path, fStart, s0, slope, lens) {
  let i0 = 0, best = 1e9;
  for (let i = 0; i < path.length / 4; i++) {
    const d = Math.abs(path[i].f - fStart);
    if (d < best) { best = d; i0 = i; }
  }
  const at = (i, arcLen) => {
    const p = path[(i0 + i) % path.length];
    return { p: G(s0 + slope * arcLen, p.f, p.x), n: norm(add(mul(GF, p.nf), mul(GX, p.nx))) };
  };
  const joints = [at(0, 0)];
  let i = 0, arcLen = 0;
  for (const L of lens) {
    const prev = joints[joints.length - 1].p;
    for (;;) {
      i++;
      const a = path[(i0 + i - 1) % path.length], b = path[(i0 + i) % path.length];
      arcLen += Math.hypot(b.f - a.f, b.x - a.x);
      const q = at(i, arcLen);
      if (len(sub(q.p, prev)) >= L || i > path.length) { joints.push(q); break; }
    }
  }
  return joints;
}

// ---------------------------------------------------------------- hand description (gloved adult hand, metres)
// w = half width (side to side), h = half thickness (dorsal-palmar) at MCP, PIP, DIP, tip joint.
const FINGER = {
  index: { L: [0.0440, 0.0260, 0.0215], w: [0.0088, 0.0080, 0.0073, 0.0066], h: [0.0079, 0.0072, 0.0066, 0.0058] },
  middle: { L: [0.0480, 0.0295, 0.0235], w: [0.0090, 0.0083, 0.0075, 0.0068], h: [0.0081, 0.0074, 0.0068, 0.0060] },
  ring: { L: [0.0450, 0.0280, 0.0230], w: [0.0085, 0.0078, 0.0072, 0.0065], h: [0.0077, 0.0071, 0.0065, 0.0058] },
  pinky: { L: [0.0360, 0.0220, 0.0200], w: [0.0074, 0.0069, 0.0064, 0.0058], h: [0.0068, 0.0064, 0.0059, 0.0053] },
};
// thumb base is the thenar mass (fuses with the palm instead of reading as a separate tube from behind)
const THUMB = { w: [0.0165, 0.0112, 0.0099, 0.0090], h: [0.0150, 0.0096, 0.0086, 0.0078] };
const NAMES = ['index', 'middle', 'ring', 'pinky'];

function strongSpec() {
  const path = wrapPath(0.0080, false);
  const fingers = {
    middle: { joints: wrapFinger(path, -0.0100, 0.0235, 0.10, FINGER.middle.L) },
    ring: { joints: wrapFinger(path, -0.0125, 0.0425, 0.10, FINGER.ring.L) },
    pinky: { joints: wrapFinger(path, -0.0160, 0.0605, 0.10, FINGER.pinky.L) },
  };
  // index finger along the right side of the frame (bind pose); the trigger pose is a rotation of these bones
  fingers.index = {
    joints: [
      { p: [0.0250, -0.0195, 0.0112], n: norm([1, 0.15, 0.1]) },
      { p: [0.0200, -0.0050, -0.0300], n: norm([1, 0.1, 0]) },
      { p: [0.0189, -0.0008, -0.0555], n: norm([1, 0.12, 0]) },
      { p: [0.0183, 0.0008, -0.0768], n: norm([1, 0.15, 0]) },
    ],
    trigger: [[0.0250, -0.0195, 0.0112], [0.0168, -0.0222, -0.0318], [0.0012, -0.0268, -0.0515], [-0.0120, -0.0300, -0.0500]],
  };
  return {
    wrist: [0.0040, -0.0790, 0.0905],
    armDir: norm([0.40, -0.18, 1]),
    dorsal: norm([0.62, 0.30, 0.72]),
    // metacarpal runs forward-down from the web along the left of the frame (not splayed out sideways, which read
    // as a thumb sticking up out of the hand from the camera); distal part lies on the support thumb, along the bore
    thumb: [[-0.0110, -0.0240, 0.0400], [-0.0205, -0.0075, 0.0170], [-0.0240, -0.0012, -0.0110], [-0.0248, -0.0016, -0.0355]],
    thumbDorsal: norm([-0.55, 0.8, 0.15]),
    fingers,
    palmBulge: 0.004,           // thick palm pad on the backstrap
  };
}
function supportSpec() {
  const path = wrapPath(0.0245, true);
  return {
    wrist: [-0.0330, -0.0950, 0.0850],
    armDir: norm([-0.50, -0.18, 1]),
    dorsal: norm([-0.85, 0.25, 0.35]),
    // along the frame below the strong thumb, parallel to the bore (pointing at the target, not upward)
    thumb: [[-0.0360, -0.0460, 0.0260], [-0.0252, -0.0218, 0.0000], [-0.0220, -0.0178, -0.0315], [-0.0210, -0.0170, -0.0560]],
    thumbDorsal: norm([-0.6, 0.8, 0.0]),
    fingers: {
      index: { joints: wrapFinger(path, -0.0020, 0.0232, 0.06, FINGER.index.L) },
      middle: { joints: wrapFinger(path, -0.0030, 0.0424, 0.06, FINGER.middle.L) },
      ring: { joints: wrapFinger(path, -0.0045, 0.0610, 0.06, FINGER.ring.L) },
      pinky: { joints: wrapFinger(path, -0.0065, 0.0782, 0.06, FINGER.pinky.L) },
    },
    palmBulge: 0.0,
  };
}

// ---------------------------------------------------------------- mesh builder
// Vertex attributes: position, aGlove (leather, rubber, strap 0/1/2=velcro, cuff), aLen (metres along the part,
// for stitches), aOcc (self AO, contact AO; filled later), skinIndex/skinWeight.
class Builder {
  constructor() { this.P = []; this.Gl = []; this.Ln = []; this.SI = []; this.SW = []; this.I = []; this.parts = []; }
  get n() { return this.P.length / 3; }
  v(p, g, l, si, sw) {
    this.P.push(p[0], p[1], p[2]); this.Gl.push(g[0], g[1], g[2], g[3]); this.Ln.push(l);
    this.SI.push(si[0], si[1], si[2], si[3]); this.SW.push(sw[0], sw[1], sw[2], sw[3]);
    return this.n - 1;
  }
  /** rings: arrays of vertex indices, each a closed loop with the same count; caps: [start centre idx|-1, end centre idx|-1] */
  loft(rings, caps, axisPts) {
    const t0 = this.I.length;
    const m = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      for (let i = 0; i < m; i++) {
        const i2 = (i + 1) % m;
        this.I.push(A[i], B[i], B[i2], A[i], B[i2], A[i2]);
      }
    }
    // cap winding consistent with the ring quads (the whole part is flipped afterwards if it faces inward)
    if (caps[0] >= 0) { const A = rings[0]; for (let i = 0; i < m; i++) this.I.push(caps[0], A[i], A[(i + 1) % m]); }
    if (caps[1] >= 0) { const A = rings[rings.length - 1]; for (let i = 0; i < m; i++) this.I.push(caps[1], A[(i + 1) % m], A[i]); }
    this.parts.push({ t0, t1: this.I.length, axisPts });
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('aGlove', new THREE.Float32BufferAttribute(this.Gl, 4));
    g.setAttribute('aLen', new THREE.Float32BufferAttribute(this.Ln, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.SW, 4));
    // orient every part outward: majority vote of face normal vs. (centroid - nearest axis point)
    const P = this.P, I = this.I;
    for (const part of this.parts) {
      let vote = 0;
      for (let t = part.t0; t < part.t1; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
        const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        const fn = cross(e1, e2);
        const m = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
        let bd = 1e9, bp = null;
        for (const q of part.axisPts) { const d = len(sub(m, q)); if (d < bd) { bd = d; bp = q; } }
        vote += Math.sign(dot(fn, sub(m, bp)));
      }
      if (vote < 0) for (let t = part.t0; t < part.t1; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
    }
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------- centreline through control points
/** Catmull-Rom through pts; returns dense samples {p, t (unit tangent), s (arc length), k (segment), f (fraction)}. */
function centreline(pts, perSeg = 24) {
  const n = pts.length;
  const P = (i) => pts[Math.max(0, Math.min(n - 1, i))];
  const out = [];
  let s = 0, prev = null;
  for (let k = 0; k < n - 1; k++) {
    const p0 = k === 0 ? sub(mul(P(0), 2), P(1)) : P(k - 1), p1 = P(k), p2 = P(k + 1);
    const p3 = k + 2 >= n ? sub(mul(P(n - 1), 2), P(n - 2)) : P(k + 2);
    for (let j = 0; j < perSeg + (k === n - 2 ? 1 : 0); j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      const q = [0, 1, 2].map((c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
      if (prev) s += len(sub(q, prev));
      out.push({ p: q, s, k, f: t });
      prev = q;
    }
  }
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)].p, b = out[Math.min(out.length - 1, i + 1)].p;
    out[i].t = norm(sub(b, a));
  }
  return out;
}
function sampleAt(cl, s) {
  let i = 1;
  while (i < cl.length - 1 && cl[i].s < s) i++;
  const a = cl[i - 1], b = cl[i];
  const f = b.s > a.s ? clamp01((s - a.s) / (b.s - a.s)) : 0;
  return { p: lerp3(a.p, b.p, f), t: norm(lerp3(a.t, b.t, f)), k: f < 0.5 ? a.k : b.k, kf: lerp(a.k + a.f, b.k + (b.f || (b.k > a.k ? 0 : 1)), f) };
}

const EXP = 2.5;                 // super-ellipse exponent of finger / hand cross-sections
const se = (c) => Math.sign(c) * Math.pow(Math.abs(c), 2 / EXP);
const seB = (c) => Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.15);   // rounder back-of-hand section
const skinOf = (bones) => {      // [[bone, w]...] -> [si, sw]
  const b = bones.filter((x) => x[1] > 1e-4).sort((p, q) => q[1] - p[1]).slice(0, 4);
  const sum = b.reduce((a, x) => a + x[1], 0) || 1;
  const si = [0, 0, 0, 0], sw = [0, 0, 0, 0];
  b.forEach((x, i) => { si[i] = x[0]; sw[i] = x[1] / sum; });
  if (!b.length) sw[0] = 1;
  return [si, sw];
};

/**
 * Digit tube (finger or thumb). joints: 4 points (base joint ... tip joint), ups: 4 dorsal vectors,
 * dims: { w[4], h[4] }, bones: [b0, b1, b2] (bone ids of the 3 phalanges), opts.pad: rubber pad on segment 0.
 */
function digit(B, joints, ups, dims, bones, opts = {}) {
  const AR = opts.around ?? 14;
  const d0 = norm(sub(joints[1], joints[0])), d3 = norm(sub(joints[3], joints[2]));
  const baseLen = opts.baseLen ?? dims.w[0] * 1.1;
  const tipLen = dims.h[3] * 1.05;
  const ctrl = [sub(joints[0], mul(d0, baseLen)), ...joints, add(joints[3], mul(d3, tipLen))];
  const cl = centreline(ctrl, 20);
  // arc length of each control point
  const sk = ctrl.map((_, i) => cl[Math.min(cl.length - 1, i * 20)].s);
  const sEnd = cl[cl.length - 1].s;
  const upAt = (kf) => {
    const i = Math.max(0, Math.min(ctrl.length - 2, Math.floor(kf)));
    const f = kf - i;
    const U = (j) => ups[Math.max(0, Math.min(3, j - 1))];
    return norm(lerp3(U(i), U(i + 1), f));
  };
  const dimAt = (arr, s) => {
    if (s <= sk[1]) return arr[0];
    for (let j = 1; j < 4; j++) if (s <= sk[j + 1]) return lerp(arr[j - 1], arr[j], (s - sk[j]) / (sk[j + 1] - sk[j]));
    return arr[3];
  };
  const L0 = sk[2] - sk[1];
  const rings = [];
  const axis = [];
  const step = opts.step ?? 0.0029;
  const svals = [];
  for (let s = 0; s < sk[4]; s += step) svals.push(s);
  // tip cap: denser rings on a quarter circle
  for (let i = 0; i <= 6; i++) svals.push(sk[4] + (sEnd - sk[4]) * Math.sin((i / 6) * Math.PI / 2) * 0.97);
  for (const s of svals) {
    const c = sampleAt(cl, s);
    const U = ortho(upAt(c.kf), c.t);
    const S = cross(c.t, U);
    let w = dimAt(dims.w, s), h = dimAt(dims.h, s);
    let cap = 1;
    if (s > sk[4]) { const u = (s - sk[4]) / (sEnd - sk[4]); cap = Math.sqrt(Math.max(0, 1 - u * u)); }
    if (s < sk[1]) w *= 0.92;
    let hd = h * 0.9, hp = h * 1.1;
    // joints: palm-side flexion crease, bony knuckle bump on the back
    let crease = 0, knuckle = 0;
    for (const j of [2, 3]) {
      const x = (s - sk[j]) / 0.0022;
      crease += Math.exp(-x * x);
      const y = (s - sk[j] + 0.0012) / 0.0034;
      knuckle += Math.exp(-y * y);
    }
    // the fingertip pad is fuller than the nail side
    const tipPad = sstep(sk[3] + 0.004, sk[4], s);
    hp *= 1 + 0.08 * tipPad;
    hd *= 1 - 0.1 * tipPad;
    const pad = opts.pad ? sstep(sk[1] + 0.18 * L0, sk[1] + 0.26 * L0, s) * (1 - sstep(sk[1] + 0.74 * L0, sk[1] + 0.82 * L0, s)) : 0;
    const ring = [];
    const bw = boneWeights(s);
    const [si, sw] = skinOf(bw);
    for (let i = 0; i < AR; i++) {
      const th = (i / AR) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const x = se(ct), y = se(st);
      let up = y > 0 ? hd * y * (1 + 0.16 * knuckle * Math.pow(Math.max(0, st), 3)) : hp * y * (1 - 0.13 * crease * Math.pow(Math.max(0, -st), 2));
      const padM = pad * sstep(0.35, 0.65, st);
      if (y > 0) up += padM * 0.0015;
      let side = w * x;
      const p = madd([c.p, 1], [S, side * cap], [U, up * cap]);
      const leather = Math.max(1 - sstep(-0.32, -0.12, st), sstep(sk[4] + 0.15 * (sEnd - sk[4]), sk[4] + 0.4 * (sEnd - sk[4]), s) * (1 - sstep(0.25, 0.6, st)));
      ring.push(B.v(p, [leather, padM, 0, 0], s, si, sw));
    }
    rings.push(ring);
    axis.push(c.p);
  }
  const startC = B.v(cl[0].p, [0, 0, 0, 0], 0, ...skinOf(boneWeights(0)));
  const endC = B.v(cl[cl.length - 1].p, [1, 0, 0, 0], sEnd, ...skinOf(boneWeights(sEnd)));
  // shrink the first ring a little so the buried base closes neatly
  B.loft(rings, [startC, endC], axis);

  function boneWeights(s) {
    // rigid phalanges, short linear blends around PIP and DIP
    const bl = 0.0026;
    const w1 = sstep(sk[2] - bl, sk[2] + bl, s), w2 = sstep(sk[3] - bl, sk[3] + bl, s);
    return [[bones[0], 1 - w1], [bones[1], w1 - w2], [bones[2], w2]];
  }
  return { sk, ctrl };
}

/** Back of the hand + palm: loft from the wrist to the knuckle line, fitted through the MCP joints. */
function handBody(B, spec, mcps, mcpUps, fingerDirs) {
  const W = spec.wrist, D = spec.dorsal;
  const midMcp = lerp3(mcps[1], mcps[2], 0.5);
  const F = norm(sub(midMcp, W));
  const Sk = ortho(sub(mcps[3], mcps[0]), F);              // across, index -> pinky
  const DD = ortho(D, F);
  const Sw = ortho(cross(DD, F), F);                       // across at the wrist (sign fixed below)
  const sgn = Math.sign(dot(Sw, Sk)) || 1;
  // knuckle spline through the MCPs, extended to the outer edges of index / pinky
  const kn = [add(mcps[0], mul(Sk, -FINGER.index.w[0] * 1.05)), ...mcps, add(mcps[3], mul(Sk, FINGER.pinky.w[0] * 1.05))];
  const kcl = centreline(kn, 16);
  const kTot = kcl[kcl.length - 1].s;
  const cM = [1, 2, 3, 4].map((i) => (kcl[i * 16].s / kTot) * 2 - 1);
  const K = (c) => sampleAt(kcl, (c + 1) / 2 * kTot).p;
  const upK = (c) => {   // dorsal at the knuckle line, blended from the fingers' own
    const cc = Math.max(cM[0], Math.min(cM[3], c));
    let j = 0; while (j < 2 && cc > cM[j + 1]) j++;
    const f = (cc - cM[j]) / (cM[j + 1] - cM[j]);
    return norm(add(mul(lerp3(mcpUps[j], mcpUps[j + 1], f), 0.55), mul(D, 0.45)));
  };
  const dirK = (c) => {
    const cc = Math.max(cM[0], Math.min(cM[3], c));
    let j = 0; while (j < 2 && cc > cM[j + 1]) j++;
    const f = (cc - cM[j]) / (cM[j + 1] - cM[j]);
    return norm(lerp3(fingerDirs[j], fingerDirs[j + 1], f));
  };
  const wristHalf = 0.0285;
  const AR = 32;
  const aVals = [0, 0.07, 0.14, 0.22, 0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.77, 0.84, 0.90, 0.95, 1.0];
  const lip = [[0.05, 0.82], [0.11, 0.58], [0.16, 0.30], [0.19, 0.0]];   // web lip: forward offset (x finger len), thickness
  const rings = [], axis = [];
  const tendon = (a, c) => {
    let r = 0;
    for (let k = 0; k < 4; k++) {
      const ck = lerp(cM[k] * 0.3, cM[k], a);
      const x = (c - ck) / 0.075;
      r += Math.exp(-x * x);
    }
    return r * sstep(0.12, 0.45, a) * (1 - sstep(0.82, 0.98, a));
  };
  const ringAt = (a, lipOff, lipH) => {
    const ring = [];
    for (let i = 0; i < AR; i++) {
      const th = (i / AR) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const c = seB(ct), y = seB(st);
      const ae = 1 - (1 - a) * (1 - a);                       // widens quickly after the wrist
      const wristP = madd([W, 1], [Sw, sgn * c * wristHalf], [F, 0.004]);
      let mid = lerp3(wristP, K(c), a < 1 ? ae : 1);
      let U = norm(lerp3(DD, upK(c), a * 0.7));
      if (lipOff > 0) mid = add(mid, mul(dirK(c), lipOff));
      // half thickness: thick wrist, back of the hand arched across, tendons fanning to the knuckles, a bony
      // bump at every knuckle head; fleshy palm (thenar / hypothenar heels)
      let kb = 0;
      for (let k = 0; k < 4; k++) { const x = (c - cM[k]) / 0.12; kb += Math.exp(-x * x); }
      let hd = lerp(0.0150, 0.0092, sstep(0, 0.55, a)) + 0.0011 * tendon(a, c) +
        0.0016 * Math.exp(-Math.pow((a - 0.96) / 0.07, 2)) * Math.min(1, kb);
      let hp = lerp(0.0185, 0.0105, sstep(0.15, 1.0, a)) + spec.palmBulge * (1 - a) * (1 - Math.abs(c));
      hp += 0.0035 * sstep(0.1, 0.6, c) * (1 - sstep(0.4, 0.95, a));   // hypothenar (pinky-side heel)
      hd *= lipH; hp *= lipH;
      const up = y > 0 ? hd * y : hp * y;
      const p = add(mid, mul(U, up));
      const leather = 1 - sstep(-0.35, -0.12, st);
      ring.push(B.v(p, [leather, 0, 0, 0], a * 0.08 + lipOff, [0, 0, 0, 0], [1, 0, 0, 0]));
    }
    return ring;
  };
  for (const a of aVals) { rings.push(ringAt(a, 0, 1)); axis.push(lerp3(add(W, mul(F, 0.004)), midMcp, a)); }
  for (const [o, hscale] of lip) {
    rings.push(ringAt(1, o * 0.06, Math.max(0.02, hscale)));
    axis.push(add(midMcp, mul(F, o * 0.06)));
  }
  const startC = B.v(add(W, mul(F, 0.004)), [0, 0, 0, 0], 0, [0, 0, 0, 0], [1, 0, 0, 0]);
  B.loft(rings, [startC, -1], axis);

  // ---- rubber knuckle guard: a bar over the knuckle line with one dome per knuckle
  const gRings = [], gAxis = [];
  const GN = 26, GAround = 12;
  for (let i = 0; i <= GN; i++) {
    const c = -0.94 + (i / GN) * 1.88;
    const U = upK(c), Fd = ortho(dirK(c), U), Sd = cross(Fd, U);
    // one moulded dome per knuckle on a thin flexible band (the band dips between the knuckles)
    let dome = 0;
    for (let k = 0; k < 4; k++) { const x = (c - cM[k]) / 0.095; dome += Math.exp(-x * x * x * x); }
    dome = Math.min(1, dome);
    const base = madd([K(c), 1], [U, 0.0088 + 0.0006 * dome], [Fd, -0.0032]);
    const halfL = 0.0052 + 0.0018 * dome, halfT = 0.0009 + 0.0019 * dome;
    const endTaper = Math.sqrt(Math.max(0, 1 - Math.pow((Math.abs(c) - 0.8) / 0.14, 2) * (Math.abs(c) > 0.8 ? 1 : 0)));
    const ring = [];
    for (let j = 0; j < GAround; j++) {
      const th = (j / GAround) * Math.PI * 2;
      const x = Math.sign(Math.cos(th)) * Math.pow(Math.abs(Math.cos(th)), 0.5);
      const y = Math.sign(Math.sin(th)) * Math.pow(Math.abs(Math.sin(th)), 0.5);
      const p = madd([base, 1], [Fd, x * halfL * endTaper], [U, (y * halfT) * endTaper + halfT * 0.2]);
      ring.push(B.v(p, [0, 1, 0, 0], c * 0.04, [0, 0, 0, 0], [1, 0, 0, 0]));
      void Sd;
    }
    gRings.push(ring); gAxis.push(base);
  }
  B.loft(gRings, [B.v(gAxis[0], [0, 1, 0, 0], 0, [0, 0, 0, 0], [1, 0, 0, 0]), B.v(gAxis[GN], [0, 1, 0, 0], 0, [0, 0, 0, 0], [1, 0, 0, 0])], gAxis);
  return { F, Sk, DD, K, cM };
}

/** Neoprene gauntlet round the wrist with a raised strap and a hook-and-loop tab on the back. */
function gauntlet(B, spec, F) {
  const W = spec.wrist, A = spec.armDir, D = spec.dorsal;
  const U = ortho(D, A), S = cross(A, U);
  const AR = 30;
  const ts = [-0.014, -0.004, 0.004, 0.0105, 0.0112, 0.016, 0.022, 0.0288, 0.0295, 0.036, 0.046, 0.058];
  const rings = [], axis = [];
  for (const t of ts) {
    const c = add(W, mul(A, t));
    const f = sstep(-0.014, 0.004, t);
    const rw = lerp(0.0255, 0.0305, f) + 0.004 * sstep(0.03, 0.058, t);
    const ru = lerp(0.0185, 0.0228, f) + 0.003 * sstep(0.03, 0.058, t);
    const strap = t >= 0.0108 && t <= 0.0292 ? 1 : 0;
    const ring = [];
    for (let i = 0; i < AR; i++) {
      const th = (i / AR) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);    // st > 0 = dorsal
      const tab = strap * sstep(0.15, 0.35, st) * (ct > -0.55 ? 1 : 0);
      const lift = strap * (0.0013 + 0.0009 * tab);
      const p = madd([c, 1], [S, ct * (rw + lift)], [U, st * (ru + lift)]);
      ring.push(B.v(p, [0, 0, strap ? (tab > 0.5 ? 2 : 1) : 0, strap ? 0 : 1], t, [0, 0, 0, 0], [1, 0, 0, 0]));
    }
    rings.push(ring); axis.push(c);
  }
  B.loft(rings, [-1, -1], axis);
  void F;
}

function thumbWeb(B, spec, body, mcps) {
  const W = spec.wrist, [cmc, tm, ip] = spec.thumb;
  const a = lerp3(madd([W, 1], [body.F, 0.02], [body.Sk, -0.012]), mcps[0], 0.62);
  const b = lerp3(tm, ip, 0.22);
  const up = norm(add(spec.dorsal, spec.thumbDorsal));
  const ctrl = [lerp3(a, b, -0.15), a, b, lerp3(a, b, 1.1)];
  const cl = centreline(ctrl, 10);
  const rings = [], axis = [];
  const tot = cl[cl.length - 1].s;
  for (let i = 0; i <= 12; i++) {
    const s = (i / 12) * tot;
    const c = sampleAt(cl, s);
    const U = ortho(up, c.t), S = cross(c.t, U);
    const u = s / tot;
    // a full first-dorsal-interosseous mass, not a thin strap: from behind it fuses the thumb with the back of
    // the hand (with a thin web the thumb read as a separate stick lying across the backstrap)
    const w = 0.0150 * (1 - 0.15 * Math.sin(u * Math.PI)), h = 0.0105 * (1 - 0.3 * u);
    const ring = [];
    const wb = sstep(0.3, 0.9, u);
    const [si, sw] = skinOf([[0, 1 - wb], [13, wb]]);
    for (let j = 0; j < 12; j++) {
      const th = (j / 12) * Math.PI * 2;
      const p = madd([c.p, 1], [S, se(Math.cos(th)) * w], [U, se(Math.sin(th)) * h]);
      ring.push(B.v(p, [1 - sstep(-0.3, -0.1, Math.sin(th)), 0, 0, 0], s, si, sw));
    }
    rings.push(ring); axis.push(c.p);
    void cmc;
  }
  B.loft(rings, [-1, -1], axis);
}

// ---------------------------------------------------------------- sleeve (long-sleeved top) with folds + watch slot
// cuff radius and growth toward the elbow (a loose duty shirt over a forearm, not a tight tube)
const SLEEVE_R0 = 0.0395, SLEEVE_RG = 0.024;
function sleeve(wrist, armDir, upHint, seed, pinch, L = 0.46) {
  const f = norm(armDir);
  const u = ortho(upHint, f), s = cross(f, u);
  const NR = 26, start = 0.034;
  const tSamples = [];
  for (let i = 0; i <= 26; i++) { const a = i / 26; tSamples.push(start + L * a * a * 0.55 + L * a * 0.45); }
  const radius = (t) => SLEEVE_R0 + SLEEVE_RG * Math.min(1, (t - start) / 0.22) + 0.004 * Math.max(0, (t - 0.3) / 0.2);
  const rows = [];
  const ringAt = (t, inward = 0) => {
    const row = [];
    for (let j = 0; j <= NR; j++) {
      const th = (j / NR) * Math.PI * 2;
      const tt = t - start;
      let r = radius(t);
      // compression rings bunched behind the cuff, long diagonal folds, one sag fold, pinched under a watch strap
      const bunch = 0.0036 * Math.exp(-tt / 0.08) * Math.sin(tt / 0.016 * Math.PI * 2 + 1.4 * Math.sin(th * 2 + seed) + 0.7 * Math.sin(th * 3 + seed * 2.1));
      const longF = 0.0019 * Math.sin(th * 4 + tt * 16 + seed) * Math.min(1, tt / 0.06) + 0.0011 * Math.sin(th * 7 - tt * 31 + seed * 3.3) * Math.min(1, tt / 0.1);
      const sag = 0.0042 * Math.max(0, -Math.cos(th)) * Math.min(1, tt / 0.1);
      const cuffBand = tt < 0.026 ? 0.2 : 1;
      let pin = 0;
      if (pinch) { const x = (t - pinch.t) / pinch.w; pin = Math.exp(-x * x * x * x); }
      if (!inward) r += ((bunch + longF) * cuffBand + sag) * (1 - pin) - (tt > 0.024 && tt < 0.030 ? 0.0012 : 0) - pin * 0.0022;
      else r -= inward;
      const dir = add(mul(u, Math.cos(th) * 0.92), mul(s, Math.sin(th)));
      row.push({ p: add(add(wrist, mul(f, t)), mul(dir, r)), uv: [th / (Math.PI * 2) * 2.6, t / 0.11] });
    }
    return row;
  };
  rows.push(ringAt(start + 0.018, 0.0028));
  rows.push(ringAt(start, 0.0028));
  rows.push(ringAt(start - 0.0013, 0.0014));
  rows.push(ringAt(start, 0.0));
  // rib-knit cuff band then the sleeve body
  for (const t of [start + 0.004, start + 0.012, start + 0.020, start + 0.026]) rows.push(ringAt(t));
  for (const t of tSamples.slice(1)) if (t > start + 0.028) rows.push(ringAt(t));
  const pos = [], uvs = [], idx = [];
  for (const r of rows) for (const q of r) { pos.push(...q.p); uvs.push(...q.uv); }
  const m = NR + 1;
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < NR; j++) {
    const a = i * m + j, b = (i + 1) * m + j, c = (i + 1) * m + j + 1, d = i * m + j + 1;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // outward winding
  let vote = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const A = pos.slice(idx[t] * 3, idx[t] * 3 + 3), Bv = pos.slice(idx[t + 1] * 3, idx[t + 1] * 3 + 3), C = pos.slice(idx[t + 2] * 3, idx[t + 2] * 3 + 3);
    const fn = cross(sub(Bv, A), sub(C, A));
    const rel = sub(A, wrist);
    vote += Math.sign(dot(fn, sub(rel, mul(f, dot(rel, f)))));
  }
  if (vote < 0) for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; }
  g.setIndex(idx);
  return toCreasedNormals(g, 1.1);    // the rolled cuff lip folds back on itself: keep it creased
}

/** Field watch worn over the left sleeve (case, bezel, crystal, strap round the pinched sleeve). */
function watch(wrist, armDir, upHint, dorsal, t, mats) {
  const f = norm(armDir);
  const u = ortho(upHint, f), s = cross(f, u);
  const grp = new THREE.Group();
  // on the back of the wrist, turned a little toward the camera (up)
  const face = norm(add(mul(ortho(dorsal, f), 0.55), mul(u, 0.45)));
  const side = cross(f, face);
  const centre = add(wrist, mul(f, t));
  const rSleeve = SLEEVE_R0 + SLEEVE_RG * Math.min(1, (t - 0.034) / 0.22) - 0.0022;
  const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(...side), new THREE.Vector3(...face), new THREE.Vector3(...f));
  // strap: elliptical band around the sleeve (matches the sleeve's 0.92 squash on u)
  const band = new THREE.BufferGeometry();
  {
    const P = [], I = [], N = 48, prof = [[-0.0105, 0], [-0.0105, 0.0022], [0.0105, 0.0022], [0.0105, 0]];
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      for (const [a, h] of prof) {
        const r = rSleeve + 0.0004 + h;
        const p = madd([centre, 1], [f, a], [u, Math.cos(th) * 0.92 * r], [s, Math.sin(th) * r]);
        P.push(...p);
      }
    }
    const m = prof.length;
    for (let i = 0; i < N; i++) for (let k = 0; k < m - 1; k++) {
      const a = i * m + k, b = (i + 1) * m + k, c = (i + 1) * m + k + 1, d = i * m + k + 1;
      I.push(a, b, c, a, c, d);
    }
    band.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    band.setIndex(I);
    band.computeVertexNormals();
    // outward
    const nn = band.attributes.normal.array;
    let vote = 0;
    for (let i = 0; i < P.length; i += 3) { const rel = sub(P.slice(i, i + 3), centre); vote += Math.sign(dot([nn[i], nn[i + 1], nn[i + 2]], sub(rel, mul(f, dot(rel, f))))); }
    if (vote < 0) { for (let t2 = 0; t2 < I.length; t2 += 3) { const x = I[t2 + 1]; I[t2 + 1] = I[t2 + 2]; I[t2 + 2] = x; } band.setIndex(I); band.computeVertexNormals(); }
  }
  const strapMesh = new THREE.Mesh(band, mats.polymer);
  grp.add(strapMesh);
  // case: on the face of the band
  const rFace = rSleeve + 0.0026;
  const caseC = madd([centre, 1], [face, rFace * 0.96]);
  const body = new THREE.CylinderGeometry(0.0185, 0.0195, 0.0085, 40, 1);
  const bezel = new THREE.TorusGeometry(0.0172, 0.0021, 8, 48);
  const glass = new THREE.CylinderGeometry(0.0150, 0.0150, 0.0012, 40, 1);
  const crown = new THREE.CylinderGeometry(0.0025, 0.0025, 0.004, 12, 1);
  const place = (g, off, rot) => {
    const mesh = g;
    const mm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(rot || [0, 0, 0])));
    mesh.applyMatrix4(mm);
    mesh.applyMatrix4(m4);
    mesh.translate(...add(caseC, madd([face, off[1]], [side, off[0]], [f, off[2]])));
    return mesh;
  };
  grp.add(new THREE.Mesh(place(body, [0, 0.0042, 0]), mats.polymer));
  grp.add(new THREE.Mesh(place(bezel, [0, 0.0088, 0], [Math.PI / 2, 0, 0]), mats.steel));
  grp.add(new THREE.Mesh(place(glass, [0, 0.0090, 0]), mats.watchGlass));
  grp.add(new THREE.Mesh(place(crown, [0.0205, 0.0042, 0], [0, 0, Math.PI / 2]), mats.steel));
  // dial markers (tiny lume dots)
  const dots = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const d = new THREE.CylinderGeometry(i % 3 === 0 ? 0.0011 : 0.0007, i % 3 === 0 ? 0.0011 : 0.0007, 0.0004, 8, 1);
    dots.push(place(d, [Math.cos(a) * 0.0122, 0.0086, Math.sin(a) * 0.0122]));
  }
  for (const d of dots) grp.add(new THREE.Mesh(d, mats.dot));
  grp.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
  return grp;
}

// ---------------------------------------------------------------- AO primitives (occluder fields)
function occPrims(spec, extra) {
  const prims = [];
  const cone = (a, b, ra, rb) => prims.push({ a, b, ra, rb });
  for (const n of NAMES) {
    const J = spec.fingers[n].joints.map((j) => j.p), d = FINGER[n];
    for (let k = 0; k < 3; k++) cone(J[k], J[k + 1], (d.w[k] + d.h[k]) / 2, (d.w[k + 1] + d.h[k + 1]) / 2);
  }
  const T = spec.thumb;
  for (let k = 0; k < 3; k++) cone(T[k], T[k + 1], (THUMB.w[k] + THUMB.h[k]) / 2, (THUMB.w[k + 1] + THUMB.h[k + 1]) / 2);
  const W = spec.wrist;
  for (const n of NAMES) cone(lerp3(W, spec.fingers[n].joints[0].p, 0.15), spec.fingers[n].joints[0].p, 0.012, 0.0085);
  cone(W, add(W, mul(spec.armDir, 0.05)), 0.024, 0.028);
  for (const e of extra || []) prims.push(e);
  for (const p of prims) { p.c = lerp3(p.a, p.b, 0.5); p.R = len(sub(p.b, p.a)) / 2 + Math.max(p.ra, p.rb); }
  return (x, y, z) => {
    let d = 1e9;
    for (const p of prims) {
      const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R > d) continue;
      const q = sdRoundCone(x, y, z, p.a, p.b, p.ra, p.rb);
      if (q < d) d = q;
    }
    return d;
  };
}

function bakeAO(g, selfField, contactField) {
  const pos = g.attributes.position.array, nor = g.attributes.normal.array;
  const n = pos.length / 3;
  const occ = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const nx = nor[v * 3], ny = nor[v * 3 + 1], nz = nor[v * 3 + 2];
    let os = 0, oc = 0, w = 0.5;
    for (let i = 1; i <= 4; i++) {
      const d = 0.0032 * i;
      const px = x + nx * d, py = y + ny * d, pz = z + nz * d;
      const qs = selfField(px, py, pz), qc = contactField(px, py, pz);
      os += w * Math.max(0, d - Math.max(qs, 0)) / d;
      oc += w * Math.max(0, d - Math.max(qc, 0)) / d;
      w *= 0.6;
    }
    occ[v * 2] = Math.min(1, os * 1.1);
    occ[v * 2 + 1] = Math.min(1, oc * 1.25);
  }
  g.setAttribute('aOcc', new THREE.BufferAttribute(occ, 2));
}

// ---------------------------------------------------------------- one hand: geometry + skeleton
function buildHand(spec, opts) {
  const B = new Builder();
  const bonesInfo = [];   // per bone: { joint, parent }
  const mcps = NAMES.map((n) => spec.fingers[n].joints[0].p);
  const mcpUps = NAMES.map((n) => spec.fingers[n].joints[0].n);
  const fDirs = NAMES.map((n) => norm(sub(spec.fingers[n].joints[1].p, spec.fingers[n].joints[0].p)));
  const body = handBody(B, spec, mcps, mcpUps, fDirs);
  // fingers: bones 1..12
  NAMES.forEach((n, i) => {
    const J = spec.fingers[n].joints;
    const b = [1 + i * 3, 2 + i * 3, 3 + i * 3];
    digit(B, J.map((j) => j.p), J.map((j) => j.n), FINGER[n], b, { pad: true, around: opts.fingerAround });
    for (let k = 0; k < 3; k++) bonesInfo[b[k]] = { joint: J[k].p, parent: k === 0 ? 0 : b[k - 1] };
  });
  // thumb: bones 13..15 (cmc, mcp, ip)
  const T = spec.thumb, TD = spec.thumbDorsal;
  const tUps = T.map(() => TD);
  digit(B, T, tUps, THUMB, [13, 14, 15], { around: 16, baseLen: 0.010, step: 0.0028 });
  for (let k = 0; k < 3; k++) bonesInfo[13 + k] = { joint: T[k], parent: k === 0 ? 0 : 12 + k };
  thumbWeb(B, spec, body, mcps);
  // the gauntlet belongs to the forearm (it follows the IK-driven forearm, see buildArm)
  const geom = B.geometry();
  return { geom, bonesInfo, body };
}

/** Bones (identity bind rotations) + pose helpers for one hand. */
function makeRig(mesh, spec, info, extraPose) {
  const root = new THREE.Bone();
  const bones = [root];
  for (let i = 1; i < 16; i++) {
    const b = new THREE.Bone();
    const { joint, parent } = info.bonesInfo[i];
    const pj = parent === 0 ? [0, 0, 0] : info.bonesInfo[parent].joint;
    b.position.set(joint[0] - pj[0], joint[1] - pj[1], joint[2] - pj[2]);
    bones[parent].add(b);
    bones.push(b);
  }
  mesh.add(root);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));

  // flexion axis + bind flex angle at every joint (bind-space; valid as bone-local because bind rotations are identity)
  const F = info.body.F;
  const joints = {};
  const chainOf = (pts, ups) => {
    const out = [];
    for (let k = 0; k < 3; k++) {
      const din = k === 0 ? F : norm(sub(pts[k], pts[k - 1]));
      const dout = norm(sub(pts[k + 1], pts[k]));
      const up = ups[k];
      let ax = cross(up, dout);                   // rotation about this axis curls toward the palm
      ax = norm(ax);
      // signed bind flex angle about ax between din and dout
      const c = Math.max(-1, Math.min(1, dot(din, dout)));
      let ang = Math.acos(c);
      if (dot(cross(din, dout), ax) < 0) ang = -ang;
      out.push({ axis: new THREE.Vector3(...ax), angle: ang });
    }
    return out;
  };
  NAMES.forEach((n) => { const J = spec.fingers[n].joints; joints[n] = chainOf(J.map((j) => j.p), J.map((j) => j.n)); });
  joints.thumb = chainOf(spec.thumb, spec.thumb.map(() => spec.thumbDorsal));
  // thumb t0 bind angle is relative to the hand axis, which is meaningless for a thumb: only use deltas
  joints.thumb[0].angle = 0.6;

  // thumb reach targets -> rotation of the whole thumb about its base joint
  const reach = {};
  const tip = spec.thumb[3], base = spec.thumb[0];
  for (const [k, target] of Object.entries(extraPose || {})) {
    const r = sub(tip, base), d = sub(target, tip);
    const ax = norm(cross(r, d));
    const ang = len(d) / Math.max(1e-4, len(sub(r, mul(ax, dot(r, ax)))));
    reach[k] = { axis: new THREE.Vector3(...ax), angle: ang };
  }

  const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const fingerBones = (n) => { const i = NAMES.indexOf(n); return [bones[1 + i * 3], bones[2 + i * 3], bones[3 + i * 3]]; };
  return {
    bones, joints, reach,
    fingerBones,
    thumbBones: [bones[13], bones[14], bones[15]],
    /** curl: 1 = bind (grip), 0 = straight, >1 tighter; extra: per-joint added radians */
    setFinger(n, curl, e0 = 0, e1 = 0, e2 = 0) {
      const js = joints[n], bs = n === 'thumb' ? [bones[13], bones[14], bones[15]] : fingerBones(n);
      const ex = [e0, e1, e2];
      for (let k = 0; k < 3; k++) bs[k].quaternion.setFromAxisAngle(js[k].axis, (curl - 1) * js[k].angle + ex[k]);
    },
    /** additional rotation of the thumb base toward a named reach target, amount 0..1 */
    addReach(name, amt) {
      const r = reach[name];
      if (!r || amt <= 0) return;
      q.setFromAxisAngle(r.axis, r.angle * amt);
      q2.copy(bones[13].quaternion);
      bones[13].quaternion.copy(q).multiply(q2);
    },
  };
}

// ---------------------------------------------------------------- public: build both hands
export function buildHands(mats, strongGroup, supportGroup) {
  const sSpec = strongSpec(), pSpec = supportSpec();
  // the support fingers are the most visible from the chest camera: they get the rounder sections
  const sInfo = buildHand(sSpec, { fingerAround: 12 });
  const pInfo = buildHand(pSpec, { fingerAround: 14 });

  // AO: self (own hand) and contact (gun + other hand)
  const sSelf = occPrims(sSpec), pSelf = occPrims(pSpec);
  bakeAO(sInfo.geom, sSelf, (x, y, z) => Math.min(gunSDF(x, y, z), pSelf(x, y, z)));
  bakeAO(pInfo.geom, pSelf, (x, y, z) => Math.min(gunSDF(x, y, z), sSelf(x, y, z)));

  const strongMesh = new THREE.SkinnedMesh(sInfo.geom, mats.glove);
  const supportMesh = new THREE.SkinnedMesh(pInfo.geom, mats.gloveSupport || mats.glove);
  strongGroup.add(strongMesh);
  supportGroup.add(supportMesh);
  for (const m of [strongMesh, supportMesh]) { m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; }

  // thumb reach targets (gun space): support thumb -> light switch / slide stop, strong thumb -> magazine release
  const sRig = makeRig(strongMesh, sSpec, sInfo, { magRelease: [-0.0205, -0.0105, -0.0150] });
  const pRig = makeRig(supportMesh, pSpec, pInfo, {
    light: [-0.0215, -0.0150, -0.0890],
    slideStop: [-0.0200, 0.0035, -0.0520],
  });

  // strong index: trigger pose as bone rotations (world -> local), from the frame index to the trigger
  const J = sSpec.fingers.index.joints.map((j) => new THREE.Vector3(...j.p));
  const TT = sSpec.fingers.index.trigger.map((p) => new THREE.Vector3(...p));
  const dir = (a, b) => new THREE.Vector3().subVectors(b, a).normalize();
  const W0 = new THREE.Quaternion().setFromUnitVectors(dir(J[0], J[1]), dir(TT[0], TT[1]));
  const W1 = new THREE.Quaternion().setFromUnitVectors(dir(J[1], J[2]).applyQuaternion(W0), dir(TT[1], TT[2])).multiply(W0);
  const W2 = new THREE.Quaternion().setFromUnitVectors(dir(J[2], J[3]).applyQuaternion(W1), dir(TT[2], TT[3])).multiply(W1);
  const triggerPose = [W0.clone(), W0.clone().invert().multiply(W1), W1.clone().invert().multiply(W2)];
  // pressing: extra curl of the two outer joints about the trigger-pose flexion axis
  // (world-space axis at the trigger pose, expressed in each bone's local frame)
  const pressAxis = new THREE.Vector3().crossVectors(dir(TT[0], TT[1]), dir(TT[1], TT[2])).normalize();
  const pa0 = pressAxis.clone().applyQuaternion(W0.clone().invert());
  const pa1 = pressAxis.clone().applyQuaternion(W1.clone().invert());
  const idxBones = sRig.fingerBones('index');
  const qI = new THREE.Quaternion(), qP = new THREE.Quaternion();
  function setTrigger(t, press = 0) {
    for (let k = 0; k < 3; k++) idxBones[k].quaternion.slerpQuaternions(qI, triggerPose[k], t);
    if (press !== 0) {
      qP.setFromAxisAngle(pa1, 0.20 * press * t);
      idxBones[1].quaternion.multiply(qP);
      qP.setFromAxisAngle(pa0, 0.09 * press * t);
      idxBones[0].quaternion.multiply(qP);
    }
  }

  // ---- arms: gauntlet + forearm sleeve (+ watch on the left) and upper arm, posed every frame by two-bone IK
  // from a shoulder fixed to the chest camera (viewmodel.solveArms), so the forearms always run toward a
  // plausible elbow and enter the frame from the lower corners instead of hanging straight down from the gun.
  const strongArm = buildArm(sSpec, mats, mats.glove, 0.7, null);
  const supportArm = buildArm(pSpec, mats, mats.gloveSupport || mats.glove, 2.3, { t: WATCH_T, w: 0.012 });

  return {
    setTrigger, strongMesh, supportMesh, strong: sRig, support: pRig,
    arms: { strong: strongArm, support: supportArm },
    triangles: (sInfo.geom.index.count + pInfo.geom.index.count) / 3,
  };
}

const WATCH_T = 0.072;
export const FOREARM_L = 0.255;     // wrist -> elbow
export const UPPER_ARM_L = 0.30;    // elbow -> shoulder

// Canonical arm frame: wrist at the origin, forearm along +Z (toward the elbow), +Y = back of the wrist.
function buildArm(spec, mats, gloveMat, seed, pinch) {
  const forearm = new THREE.Group();
  forearm.name = 'forearm';
  const sl = new THREE.Mesh(sleeve([0, 0, 0], [0, 0, 1], [0, 1, 0], seed, pinch, FOREARM_L + 0.012), mats.sleeve);
  forearm.add(sl);
  const gb = new Builder();
  gauntlet(gb, { wrist: [0, 0, 0], armDir: [0, 0, 1], dorsal: [0, 1, 0] }, null);
  const gg = gb.geometry();
  gg.setAttribute('aOcc', new THREE.BufferAttribute(new Float32Array(gg.attributes.position.count * 2).fill(0.08), 2));
  gg.deleteAttribute('skinIndex'); gg.deleteAttribute('skinWeight');
  forearm.add(new THREE.Mesh(gg, gloveMat));
  if (pinch) forearm.add(watch([0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 0], WATCH_T, mats));

  // upper arm: origin at the elbow, +Z toward the shoulder; a rounded elbow cap closes the joint
  const upper = new THREE.Group();
  upper.name = 'upperArm';
  const R0 = 0.062, R1 = 0.068, L = UPPER_ARM_L + 0.02;
  const tube = new THREE.CylinderGeometry(R1, R0, L, 26, 8, true);
  tube.rotateX(Math.PI / 2);          // axis along Z, the R0 end at -L/2
  tube.translate(0, 0, L / 2 - 0.012);
  const cap = new THREE.SphereGeometry(R0 * 1.01, 26, 12);
  for (const g of [tube, cap]) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.6, 1.2 + uv.getY(i) * (g === tube ? L / 0.11 : 0.6));
  }
  upper.add(new THREE.Mesh(tube, mats.sleeve), new THREE.Mesh(cap, mats.sleeve));
  for (const g of [forearm, upper]) g.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
  return {
    forearm, upper,
    wrist: new THREE.Vector3(...spec.wrist),       // hand-group local
    dorsal: new THREE.Vector3(...spec.dorsal),     // hand-group local
    armDir: new THREE.Vector3(...spec.armDir),     // hand-group local: forearm direction the hand was sculpted for
  };
}
