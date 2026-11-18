import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  sdRoundCone, sdEllipsoid, sdRoundBox, smin, smax, surfaceNets, compact, merge, tag,
} from './vmGeom.js';
import { GRIP_ANGLE, MAG_ORIGIN } from './vmPistol.js';

// Gloved hands built as signed distance fields (bones = tapered round cones, palm = blended metacarpals,
// thenar/hypothenar masses, knuckle armour) and polygonised once at load with surface nets: each hand is one
// continuous smooth mesh with gradient normals. Where a hand presses against the pistol (or the other hand)
// the field is clipped by the gun's own volume, so contact areas are flattened like flesh in a glove.
// The strong hand is a SkinnedMesh: its index finger (3 bones) moves between the frame and the trigger.

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

// ---------------------------------------------------------------- grip frame (matches the magwell)
const cg = Math.cos(GRIP_ANGLE), sgA = Math.sin(GRIP_ANGLE);
const GA = [0, -cg, sgA];          // down the grip
const GF = [0, -sgA, -cg];         // toward the front strap
const GX = [1, 0, 0];
const G = (s, f, x) => [x, MAG_ORIGIN[1] + s * GA[1] + f * GF[1], MAG_ORIGIN[2] + s * GA[2] + f * GF[2]];
const GRIP = { fB: -0.0235, fF: 0.0195, hx: 0.0148, rc: 0.0060 };

// ---------------------------------------------------------------- gun volume used to clip the hands
// Slightly inside the visible pistol, so the clipped hand surface always hides under the gun's skin.
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const GAX = [GA, GF, GX];
const gunBoxes = [
  { c: G(0.059, -0.002, 0), ax: GAX, h: [0.0545, 0.0212, 0.0143], r: 0.0050 },        // grip
  { c: [0, 0.0015, -0.050], ax: AX, h: [0.0102, 0.0098, 0.100], r: 0.0010 },          // upper frame
  { c: [0, 0.0030, 0.0390], ax: AX, h: [0.0102, 0.0060, 0.0090], r: 0.0030 },         // beavertail
  { c: [0, 0.0275, -0.045], ax: AX, h: [0.0126, 0.0170, 0.1120], r: 0.0015 },         // slide + its travel
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
// right side going forward. Mirror (-x) for the support hand. Returns samples {f, x, nf, nx, arc}.
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
  for (let i = 0; i < path.length / 4; i++) {           // first quarter = the start side
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

// ---------------------------------------------------------------- SDF primitive set
function primSet() {
  const prims = [];
  return {
    prims,
    cone(a, b, ra, rb, k, info = {}) {
      const c = lerp3(a, b, 0.5);
      prims.push({ type: 0, a, b, ra, rb, k, c, R: len(sub(b, a)) / 2 + Math.max(ra, rb), ...info });
    },
    ellipsoid(c, ax, r, k, info = {}) {
      prims.push({ type: 1, c, ax, r, k, R: Math.max(...r), ...info });
    },
  };
}
function primDist(p, x, y, z) {
  return p.type === 0 ? sdRoundCone(x, y, z, p.a, p.b, p.ra, p.rb) : sdEllipsoid(x, y, z, p.c, p.ax, p.r);
}
function fieldOf(prims) {
  return (x, y, z) => {
    let d = 1e9;
    for (const p of prims) {
      const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
      const lb = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
      if (lb > d + p.k) continue;
      d = smin(d, primDist(p, x, y, z), p.k);
    }
    return d;
  };
}
function boundsOf(prims, margin) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of prims) {
    const pts = p.type === 0 ? [[p.a, p.ra], [p.b, p.rb]] : [[p.c, p.R]];
    for (const [q, r] of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k] - r - margin); mx[k] = Math.max(mx[k], q[k] + r + margin); }
  }
  return [mn, mx];
}
const frameFrom = (fwd, upHint) => {
  const f = norm(fwd);
  const s = norm(cross(f, upHint));
  const u = cross(s, f);
  return [s, u, f];
};

// ---------------------------------------------------------------- hand description
// Gloved adult hand, sizes in metres (glove adds ~1.5 mm everywhere).
const FINGER = {
  index: { L: [0.0440, 0.0260, 0.0215], r: [0.0094, 0.0087, 0.0080, 0.0073] },
  middle: { L: [0.0480, 0.0295, 0.0235], r: [0.0098, 0.0091, 0.0084, 0.0076] },
  ring: { L: [0.0450, 0.0280, 0.0230], r: [0.0094, 0.0087, 0.0081, 0.0074] },
  pinky: { L: [0.0360, 0.0220, 0.0200], r: [0.0086, 0.0079, 0.0074, 0.0068] },
};

/**
 * Adds one hand's primitives. spec:
 *  wrist, armDir, dorsal (back-of-hand direction), thumb [cmc, mcp, ip, tip], thumbDorsal,
 *  fingers: { index|middle|ring|pinky: { joints: [{p, n}] x4 } } (n = dorsal direction at the joint)
 * Bone ids: 0 = hand, 1..3 = index phalanges (only used for the strong hand).
 */
function handPrims(spec) {
  const S = primSet();
  const { wrist, armDir, dorsal } = spec;
  const F = spec.fingers;
  const mcp = (n) => F[n].joints[0].p;
  const across = norm(sub(mcp('pinky'), mcp('index')));
  const midMcp = lerp3(mcp('middle'), mcp('ring'), 0.5);
  const fwd = norm(sub(midMcp, wrist));
  const D = dorsal;
  const palm = { bone: 0, dorsal: D };

  // forearm / glove gauntlet
  S.cone(add(wrist, mul(fwd, 0.006)), add(wrist, mul(armDir, 0.052)), 0.0235, 0.0270, 0.020, { ...palm, cuff: 1 });
  // metacarpals fanning from the carpus to the knuckles
  const names = ['index', 'middle', 'ring', 'pinky'];
  const spread = [-0.0125, -0.0042, 0.0042, 0.0118];
  names.forEach((n, i) => {
    const base = madd([wrist, 1], [fwd, 0.016], [across, spread[i]], [D, 0.001]);
    S.cone(base, sub(mcp(n), mul(D, 0.0008)), 0.0128, FINGER[n].r[0] + 0.0014, 0.017, palm);
  });
  // hypothenar (pinky-side heel) and the carpal mass
  S.cone(madd([wrist, 1], [across, 0.0135], [fwd, 0.010], [D, -0.004]), madd([mcp('pinky'), 1], [fwd, -0.024], [D, -0.003]), 0.0145, 0.0115, 0.016, palm);
  S.cone(madd([wrist, 1], [across, -0.010], [fwd, 0.004]), madd([wrist, 1], [across, 0.012], [fwd, 0.004]), 0.0190, 0.0190, 0.016, palm);
  // thumb: thenar mass along the metacarpal, web to the index metacarpal, two phalanges
  const [cmc, tm, ip, tip] = spec.thumb;
  const TD = spec.thumbDorsal;
  const thumbI = { bone: 0, dorsal: TD, thumb: 1 };
  S.cone(cmc, tm, 0.0152, 0.0120, 0.014, thumbI);
  S.cone(lerp3(cmc, tm, 0.25), lerp3(madd([wrist, 1], [fwd, 0.016], [across, -0.0125]), mcp('index'), 0.72), 0.0072, 0.0068, 0.009, palm);
  S.cone(tm, ip, 0.0114, 0.0104, 0.006, thumbI);
  S.cone(ip, tip, 0.0102, 0.0088, 0.004, thumbI);
  S.ellipsoid(add(ip, mul(TD, 0.0105 * 0.42)), frameFrom(sub(tip, tm), TD), [0.0052, 0.0045, 0.0052], 0.004, thumbI);
  // fingers
  names.forEach((n) => {
    const J = F[n].joints, r = FINGER[n].r;
    for (let k = 0; k < 3; k++) {
      const bone = spec.skinIndex && n === 'index' ? k + 1 : 0;
      const dors = norm(add(J[k].n, J[k + 1].n));
      S.cone(J[k].p, J[k + 1].p, r[k], r[k + 1], k === 0 ? 0.008 : 0.0035, { bone, dorsal: dors });
      // knuckle bulge over each finger joint
      if (k > 0) S.ellipsoid(add(J[k].p, mul(J[k].n, r[k] * 0.30)), frameFrom(sub(J[k + 1].p, J[k - 1].p), J[k].n), [0.0062, 0.0040, 0.0055], 0.004, { bone, dorsal: dors });
      // moulded armour pad on the proximal phalanx
      if (k === 0) {
        const mid = lerp3(J[0].p, J[1].p, 0.55);
        const nn = norm(add(J[0].n, J[1].n));
        const ax = frameFrom(sub(J[1].p, J[0].p), nn);
        S.ellipsoid(add(mid, mul(nn, r[0] * 0.80)), ax, [0.0068, 0.0026, 0.0110], 0.0012, { bone, dorsal: nn, pad: 1 });
      }
    }
  });
  // extra soft-tissue masses (palm pad on the backstrap, thenar wrapped round the grip)
  for (const e of spec.extra || []) S.ellipsoid(e.c, e.ax, e.r, e.k ?? 0.014, palm);
  // knuckle heads + moulded armour: one low bridge with a raised dome over every knuckle
  names.forEach((n) => {
    const J = F[n].joints;
    const kd = norm(add(mul(D, 0.6), mul(J[0].n, 0.4)));
    const ax = frameFrom(sub(J[1].p, J[0].p), kd);
    S.ellipsoid(add(J[0].p, mul(kd, 0.0035)), ax, [0.0072, 0.0052, 0.0066], 0.008, palm);
    S.ellipsoid(add(J[0].p, mul(kd, 0.0104)), ax, [0.0070, 0.0024, 0.0076], 0.0018, { ...palm, pad: 1 });
  });
  const k0 = madd([mcp('index'), 1], [D, 0.0080], [fwd, -0.005]);
  const k1 = madd([mcp('pinky'), 1], [D, 0.0074], [fwd, -0.005]);
  S.cone(k0, k1, 0.0048, 0.0042, 0.0020, { ...palm, pad: 1 });
  return { prims: S.prims, fwd, across, midMcp };
}

// ---------------------------------------------------------------- per-hand pose data (gun space)
function strongSpec(skinned) {
  const path = wrapPath(0.0082, false);
  const fingers = {
    middle: { joints: wrapFinger(path, -0.0100, 0.0235, 0.10, FINGER.middle.L) },
    ring: { joints: wrapFinger(path, -0.0125, 0.0425, 0.10, FINGER.ring.L) },
    pinky: { joints: wrapFinger(path, -0.0160, 0.0605, 0.10, FINGER.pinky.L) },
  };
  // index finger along the right side of the frame (bind pose); the trigger pose is a rotation of these bones
  const side = [1, 0.15, 0.1];
  fingers.index = {
    joints: [
      { p: [0.0250, -0.0195, 0.0112], n: norm(side) },
      { p: [0.0205, -0.0050, -0.0300], n: norm([1, 0.1, 0]) },
      { p: [0.0193, -0.0006, -0.0555], n: norm([1, 0.12, 0]) },
      { p: [0.0186, 0.0010, -0.0768], n: norm([1, 0.15, 0]) },
    ],
    trigger: [[0.0250, -0.0195, 0.0112], [0.0168, -0.0222, -0.0318], [0.0012, -0.0268, -0.0515], [-0.0120, -0.0300, -0.0500]],
  };
  return {
    wrist: [0.0030, -0.0800, 0.0900],
    armDir: norm([0.40, -0.18, 1]),
    dorsal: norm([0.62, 0.30, 0.72]),
    extra: [
      { c: G(0.052, -0.0335, 0.0030), ax: GAX, r: [0.034, 0.0125, 0.0175] },   // palm on the backstrap
      { c: G(0.032, -0.0285, -0.0135), ax: GAX, r: [0.022, 0.0105, 0.0095] },  // thenar, left rear of the grip
    ],
    thumb: [[-0.0040, -0.0230, 0.0420], [-0.0222, -0.0030, 0.0205], [-0.0272, 0.0062, -0.0100], [-0.0288, 0.0082, -0.0348]],
    thumbDorsal: norm([-0.55, 0.8, 0.15]),
    fingers,
    skinIndex: skinned,
  };
}
function supportSpec() {
  const path = wrapPath(0.0255, true);
  return {
    wrist: [-0.0330, -0.0950, 0.0850],
    armDir: norm([-0.50, -0.18, 1]),
    dorsal: norm([-0.85, 0.25, 0.35]),
    thumb: [[-0.0360, -0.0460, 0.0260], [-0.0248, -0.0200, 0.0000], [-0.0205, -0.0098, -0.0330], [-0.0195, -0.0062, -0.0585]],
    thumbDorsal: norm([-0.6, 0.8, 0.0]),
    fingers: {
      index: { joints: wrapFinger(path, -0.0020, 0.0230, 0.06, FINGER.index.L) },
      middle: { joints: wrapFinger(path, -0.0030, 0.0420, 0.06, FINGER.middle.L) },
      ring: { joints: wrapFinger(path, -0.0045, 0.0605, 0.06, FINGER.ring.L) },
      pinky: { joints: wrapFinger(path, -0.0065, 0.0780, 0.06, FINGER.pinky.L) },
    },
  };
}

// ---------------------------------------------------------------- polygonise one hand
function polygonize(field, prims, opts) {
  const body = prims.filter((p) => !p.pad);
  const pads = prims.filter((p) => p.pad);
  const [mn, mx] = boundsOf(prims, 0.004);
  const { wrist, armDir } = opts;
  const underSleeve = (pos, i) => (pos[i * 3] - wrist[0]) * armDir[0] + (pos[i * 3 + 1] - wrist[1]) * armDir[1] + (pos[i * 3 + 2] - wrist[2]) * armDir[2] > 0.041;
  const filterTri = (a, b, c, pos) => {
    if (underSleeve(pos, a) && underSleeve(pos, b) && underSleeve(pos, c)) return false;
    return opts.filterTri ? opts.filterTri(a, b, c, pos) : true;
  };
  let g = surfaceNets(field, mn, mx, opts.h, { project: 1, filterTri });
  g = compact(g);
  const pos = g.attributes.position.array, nor = g.attributes.normal.array;
  const n = pos.length / 3;
  const region = new Float32Array(n * 4);
  const aoA = new Float32Array(n);
  const seamA = new Float32Array(n);
  const skinI = opts.skinned ? new Float32Array(n * 4) : null;
  const skinW = opts.skinned ? new Float32Array(n * 4) : null;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let best = 1e9, bp = null, dT = 1e9, dO = 1e9;
    const boneD = [1e9, 1e9, 1e9, 1e9];
    const dists = body.map((p) => primDist(p, x, y, z));
    body.forEach((p, i) => {
      const d = dists[i];
      if (p.thumb) { if (d < dT) dT = d; } else if (!p.cuff && d < dO) dO = d;
      if (d < best) { best = d; bp = p; }
      if (d < boneD[p.bone]) boneD[p.bone] = d;
    });
    // smooth blend of the nearby primitives' back-of-hand directions (no patchy region borders)
    let sx = 0, sy = 0, sz = 0;
    body.forEach((p, i) => {
      const w = Math.exp(-(dists[i] - best) / 0.0035);
      sx += p.dorsal[0] * w; sy += p.dorsal[1] * w; sz += p.dorsal[2] * w;
    });
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    const dorsalV = [sx / sl, sy / sl, sz / sl];
    let dp = 1e9;
    for (const p of pads) {
      const d = primDist(p, x, y, z);
      if (d < dp) dp = d;
      if (d < boneD[p.bone]) boneD[p.bone] = d;
    }
    const nx = nor[v * 3], ny = nor[v * 3 + 1], nz = nor[v * 3 + 2];
    const padM = 1 - Math.min(1, Math.max(0, (dp - best + 0.0012) / 0.0018));
    region[v * 4] = padM;
    region[v * 4 + 1] = nx * dorsalV[0] + ny * dorsalV[1] + nz * dorsalV[2];
    region[v * 4 + 2] = 0;
    region[v * 4 + 3] = bp && bp.cuff ? 1 : 0;   // gauntlet (under the strap/sleeve)
    seamA[v] = Math.max(-1, Math.min(1, (dT - dO) / 0.008));   // thumb panel seam at 0
    if (opts.occluder) {
      // SDF ambient occlusion against this hand, the pistol and the other hand
      let occ = 0, w = 0.5;
      for (let i = 1; i <= 4; i++) {
        const d = 0.0034 * i;
        const q = opts.occluder(x + nx * d, y + ny * d, z + nz * d);
        occ += w * Math.max(0, d - q) / d;
        w *= 0.6;
      }
      aoA[v] = Math.min(1, occ * 1.15);
    }
    if (opts.skinned) {
      const dmin = Math.min(...boneD);
      let sum = 0;
      const w = boneD.map((d) => { const e = Math.exp(-(d - dmin) / 0.0022); sum += e; return e; });
      for (let k = 0; k < 4; k++) { skinI[v * 4 + k] = k; skinW[v * 4 + k] = w[k] / sum; }
    }
  }
  g.setAttribute('aRegion', new THREE.BufferAttribute(region, 4));
  g.setAttribute('aAo', new THREE.BufferAttribute(aoA, 1));
  g.setAttribute('aSeam', new THREE.BufferAttribute(seamA, 1));
  if (opts.skinned) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinI, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  }
  return g;
}

// ---------------------------------------------------------------- wrist strap with hook-and-loop tab
function wristStrap(field, wrist, armDir, dorsal, at) {
  const c0 = add(wrist, mul(armDir, at));
  const [s, u, f] = frameFrom(armDir, dorsal);   // u ~ dorsal
  const N = 56;
  const W = 0.0105;
  const prof = [[-W, 0.0000], [-W + 0.0008, 0.0011], [W - 0.0008, 0.0011], [W, 0.0000]];
  const rows = [];
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const dir = add(mul(u, Math.cos(th)), mul(s, Math.sin(th)));
    const tab = Math.cos(th) > 0.55 ? 1 : 0;                  // closure tab on the back of the wrist
    const row = [];
    for (const [a, h] of prof) {
      const c = add(c0, mul(f, a));
      let t = 0.005;
      while (t < 0.06 && field(...add(c, mul(dir, t))) < 0) t += 0.0016;
      let lo = Math.max(0.005, t - 0.0016), hi = t;
      for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (field(...add(c, mul(dir, m))) < 0) lo = m; else hi = m; }
      t = hi;
      row.push({ p: add(c, mul(dir, t - 0.0004 + h * (1 + tab * 0.9) + (h > 0 ? 0.0003 : 0))), tab });
    }
    rows.push(row);
  }
  const pos = [], reg = [];
  const push = (q) => { pos.push(...q.p); reg.push(0, 0, 1, q.tab); };
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < prof.length - 1; k++) {
      const a = rows[i][k], b = rows[i + 1][k], c = rows[i + 1][k + 1], d = rows[i][k + 1];
      push(a); push(b); push(c); push(a); push(c); push(d);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aRegion', new THREE.Float32BufferAttribute(reg, 4));
  const r2 = g.attributes.aRegion;
  g = toCreasedNormals(g, 0.7);
  g.setAttribute('aRegion', r2);
  // outward winding
  const p = g.attributes.position.array, nn = g.attributes.normal.array;
  let vote = 0;
  for (let i = 0; i < p.length; i += 9) {
    const m = [(p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3];
    const rel = sub(m, c0);
    const radial = sub(rel, mul(f, dot(rel, f)));
    vote += Math.sign(dot([nn[i], nn[i + 1], nn[i + 2]], radial));
  }
  if (vote < 0) {
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) {
      let t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t;
      t = nn[i + 3 + k]; nn[i + 3 + k] = nn[i + 6 + k]; nn[i + 6 + k] = t;
    }
    for (let i = 0; i < nn.length; i++) nn[i] = -nn[i];
  }
  return g;
}

// ---------------------------------------------------------------- sleeve (long-sleeved top) with folds
function sleeve(wrist, armDir, upHint, seed) {
  const [s, u, f] = frameFrom(armDir, upHint);
  const NR = 28, start = 0.034, L = 0.46;
  const tSamples = [];
  for (let i = 0; i <= 30; i++) { const a = i / 30; tSamples.push(start + L * a * a * 0.55 + L * a * 0.45); }
  const radius = (t) => 0.0345 + 0.020 * Math.min(1, (t - start) / 0.22) + 0.004 * Math.max(0, (t - 0.3) / 0.2);
  const rows = [];
  const ringAt = (t, rScale, inward = 0) => {
    const row = [];
    for (let j = 0; j <= NR; j++) {
      const th = (j / NR) * Math.PI * 2;
      const tt = t - start;
      let r = radius(t) * rScale;
      // compression rings bunched behind the cuff + long diagonal folds + one big sag fold
      const bunch = 0.0032 * Math.exp(-tt / 0.07) * Math.sin(tt / 0.017 * Math.PI * 2 + 1.4 * Math.sin(th * 2 + seed) + 0.7 * Math.sin(th * 3 + seed * 2.1));
      const longF = 0.0016 * Math.sin(th * 4 + tt * 16 + seed) * Math.min(1, tt / 0.06);
      const sag = 0.0035 * Math.max(0, -Math.cos(th)) * Math.min(1, tt / 0.1);
      const cuffBand = tt < 0.03 ? 0.25 : 1;
      if (!inward) r += (bunch + longF) * cuffBand + sag - (tt > 0.028 && tt < 0.034 ? 0.0012 : 0);
      else r -= inward;
      const dir = add(mul(u, Math.cos(th) * 0.92), mul(s, Math.sin(th)));
      row.push({ p: add(add(wrist, mul(f, t)), mul(dir, r)), uv: [th / (Math.PI * 2) * 2.6, t / 0.11] });
    }
    return row;
  };
  // cuff lip: inner surface -> rolled edge -> outside
  rows.push(ringAt(start + 0.018, 1, 0.0028));
  rows.push(ringAt(start, 1, 0.0028));
  rows.push(ringAt(start - 0.0012, 1, 0.0014));
  rows.push(ringAt(start, 1, 0.0));
  for (const t of tSamples.slice(1)) rows.push(ringAt(t, 1));
  const pos = [], uvs = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < NR; j++) {
      const a = rows[i][j], b = rows[i + 1][j], c = rows[i + 1][j + 1], d = rows[i][j + 1];
      for (const q of [a, b, c, a, c, d]) { pos.push(...q.p); uvs.push(...q.uv); }
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const uvA = g.attributes.uv;
  g = toCreasedNormals(g, 1.2);
  g.setAttribute('uv', uvA);
  // orient outward (inner cuff rows face inward, which is what we want there: they get flipped with the rest)
  const p = g.attributes.position.array, nn = g.attributes.normal.array;
  let vote = 0;
  for (let i = 0; i < p.length; i += 9) {
    const m = [(p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3];
    const rel = sub(m, wrist);
    vote += Math.sign(dot([nn[i], nn[i + 1], nn[i + 2]], sub(rel, mul(f, dot(rel, f)))));
  }
  if (vote < 0) {
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) {
      let t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t;
      t = nn[i + 3 + k]; nn[i + 3 + k] = nn[i + 6 + k]; nn[i + 6 + k] = t;
    }
    for (let i = 0; i < nn.length; i++) nn[i] = -nn[i];
    const uv = g.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 6) for (let k = 0; k < 2; k++) { const t = uv[i + 2 + k]; uv[i + 2 + k] = uv[i + 4 + k]; uv[i + 4 + k] = t; }
  }
  return g;
}

// ---------------------------------------------------------------- public: build both hands
export function buildHands(mats, strongGroup, supportGroup) {
  const H = 0.0041;

  const pSpec = supportSpec();
  const pHand = handPrims(pSpec);
  const pRaw = fieldOf(pHand.prims);

  // ---- strong (right) hand, skinned index finger
  const sSpec = strongSpec(true);
  const sHand = handPrims(sSpec);
  const sRaw = fieldOf(sHand.prims);
  const sField = (x, y, z) => smax(sRaw(x, y, z), -(gunSDF(x, y, z) + 0.0006), 0.0015);
  // index-finger primitives only (to keep its underside when stripping hidden contact patches)
  const idxPrims = sHand.prims.filter((p) => p.bone > 0);
  const idxField = fieldOf(idxPrims);
  let sGeom = polygonize(sField, sHand.prims, {
    h: H, skinned: true, wrist: sSpec.wrist, armDir: sSpec.armDir,
    occluder: (x, y, z) => Math.min(sRaw(x, y, z), gunSDF(x, y, z), pRaw(x, y, z)),
    filterTri: (a, b, c, pos) => {
      for (const i of [a, b, c]) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (gunSDF(x, y, z) > -0.0002) return true;
        if (idxField(x, y, z) < 0.004) return true;
      }
      return false;
    },
  });
  const sStrap = tag(tag(wristStrap(sRaw, sSpec.wrist, sSpec.armDir, sSpec.dorsal, 0.018), 'skinIndex', [0, 1, 2, 3]), 'skinWeight', [1, 0, 0, 0]);
  const strongGeom = merge([sGeom, sStrap], ['position', 'normal', 'aRegion', 'aAo', 'aSeam', 'skinIndex', 'skinWeight']);

  const rootBone = new THREE.Bone();
  const J = sSpec.fingers.index.joints.map((j) => new THREE.Vector3(...j.p));
  const b1 = new THREE.Bone(), b2 = new THREE.Bone(), b3 = new THREE.Bone();
  b1.position.copy(J[0]);
  b2.position.copy(J[1]).sub(J[0]);
  b3.position.copy(J[2]).sub(J[1]);
  rootBone.add(b1); b1.add(b2); b2.add(b3);
  const strongMesh = new THREE.SkinnedMesh(strongGeom, mats.glove);
  strongMesh.add(rootBone);
  strongGroup.add(strongMesh);
  strongMesh.updateMatrixWorld(true);
  strongMesh.bind(new THREE.Skeleton([rootBone, b1, b2, b3]));
  strongMesh.frustumCulled = false;

  // trigger pose: world (gun-space) rotations of each phalanx, converted to bone-local quaternions
  const T = sSpec.fingers.index.trigger.map((p) => new THREE.Vector3(...p));
  const dir = (a, b) => new THREE.Vector3().subVectors(b, a).normalize();
  const W0 = new THREE.Quaternion().setFromUnitVectors(dir(J[0], J[1]), dir(T[0], T[1]));
  const W1 = new THREE.Quaternion().setFromUnitVectors(dir(J[1], J[2]).applyQuaternion(W0), dir(T[1], T[2])).multiply(W0);
  const W2 = new THREE.Quaternion().setFromUnitVectors(dir(J[2], J[3]).applyQuaternion(W1), dir(T[2], T[3])).multiply(W1);
  const triggerPose = [W0.clone(), W0.clone().invert().multiply(W1), W1.clone().invert().multiply(W2)];
  const indexBones = [b1, b2, b3];
  const qI = new THREE.Quaternion();
  function setTrigger(t) {
    for (let k = 0; k < 3; k++) indexBones[k].quaternion.slerpQuaternions(qI, triggerPose[k], t);
  }

  // ---- support (left) hand, clipped by the gun and by the strong hand
  const pField = (x, y, z) => {
    let d = pRaw(x, y, z);
    if (d > 0.01) return d;
    return smax(d, -(gunSDF(x, y, z) + 0.0006), 0.0015);
  };
  const pGeom = polygonize(pField, pHand.prims, {
    h: H, wrist: pSpec.wrist, armDir: pSpec.armDir,
    occluder: (x, y, z) => Math.min(pRaw(x, y, z), gunSDF(x, y, z), sRaw(x, y, z)),
  });
  const pStrap = wristStrap(pRaw, pSpec.wrist, pSpec.armDir, pSpec.dorsal, 0.016);
  const supportGeom = merge([pGeom, pStrap], ['position', 'normal', 'aRegion', 'aAo', 'aSeam']);
  const supportMesh = new THREE.Mesh(supportGeom, mats.glove);
  supportMesh.frustumCulled = false;
  supportGroup.add(supportMesh);

  // ---- sleeves
  const sl1 = new THREE.Mesh(sleeve(sSpec.wrist, sSpec.armDir, [0, 1, 0], 0.7), mats.sleeve);
  const sl2 = new THREE.Mesh(sleeve(pSpec.wrist, pSpec.armDir, [0, 1, 0], 2.3), mats.sleeve);
  for (const m of [sl1, sl2]) m.frustumCulled = false;
  strongGroup.add(sl1);
  supportGroup.add(sl2);

  for (const m of [strongMesh, supportMesh, sl1, sl2]) { m.castShadow = false; m.receiveShadow = true; }
  return { setTrigger, strongMesh, supportMesh };
}
