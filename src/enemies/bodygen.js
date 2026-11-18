// Procedural clothed-human mesh generator.
// Every body part, garment, head and hand is a signed-distance component attached to a bone of the bind pose
// (rig.js, A-pose). Components are polygonised per "patch" (top garment, trousers, boots, head, hands) at a
// resolution that suits the detail there; patches overlap only where a garment edge hides the junction
// (hem over waistband, trouser hem over boot shaft, cuff over wrist, collar over neck).
// Output: one skinned geometry (bind pose, model space at 1.80 m) with blended weights for up to 4 bones,
// a material slot and an RGB shade (AO + painted detail) per vertex. Pure JS, runs in Node.

import {
  clamp, mix, sstep, sdEllipsoid, sdCone, sdRoundBox, sdTorus, makeProfile, meshPatch, fieldAt, compDist,
  invertRigid, mulMat, mulPoint, mulDir, smax, smin, decimate, projectVertices,
} from './sdfmesh.js';
import { getBindMatrices, BONE_INDEX, BONE_NAMES, SKEL } from './rig.js';

// Material slots (colours / surface types are chosen per look in character.js)
export const SLOT = {
  skin: 0, top: 1, topTrim: 2, legs: 3, legsTrim: 4, boots: 5, sole: 6, hair: 7, headwear: 8, balaclava: 9,
  belt: 10, metal: 11, vest: 12, vestTrim: 13, gloves: 14, eyeWhite: 15, iris: 16, lips: 17, cord: 18,
};

const ID16 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
let BM = null, BMI = null;
function mats() {
  if (BM) return;
  BM = { model: ID16 };
  BMI = { model: ID16 };
  const bm = getBindMatrices();
  for (const n of BONE_NAMES) { BM[n] = bm[n]; BMI[n] = invertRigid(bm[n]); }
}

// ---------------------------------------------------------------------------------------------
// Skin weights along chains (bind pose, model space)
// ---------------------------------------------------------------------------------------------
function chainBlend(s, joints, bones, w, scale) {
  let prev = 1;
  for (let i = 0; i < joints.length; i++) {
    const a = sstep(joints[i][0] - joints[i][1], joints[i][0] + joints[i][1], s);
    w[BONE_INDEX[bones[i]]] += (prev - a) * scale;
    prev = a;
  }
  w[BONE_INDEX[bones[bones.length - 1]]] += prev * scale;
}
const TORSO_J = [[1.085, 0.06], [1.3, 0.06], [1.5, 0.035], [1.6, 0.03]];
const TORSO_B = ['pelvis', 'spine', 'chest', 'neck', 'head'];
const _v = new Float64Array(3), _d = new Float64Array(3);
function chainWeights(chain, x, y, z, w, scale) {
  if (chain === 'torso') return chainBlend(y, TORSO_J, TORSO_B, w, scale);
  if (chain === 'head') { w[BONE_INDEX.head] += scale; return; }
  const side = chain[chain.length - 1];
  if (chain.startsWith('arm')) {
    const m = BM['upperArm' + side];
    mulDir(m, 0, -1, 0, _d);
    const s = (x - m[12]) * _d[0] + (y - m[13]) * _d[1] + (z - m[14]) * _d[2];
    return chainBlend(s, [[0.01, 0.05], [0.29, 0.045], [0.548, 0.022]], ['chest', 'upperArm' + side, 'foreArm' + side, 'hand' + side], w, scale);
  }
  if (chain.startsWith('leg')) {
    const m = BM['thigh' + side];
    mulDir(m, 0, -1, 0, _d);
    const s = (x - m[12]) * _d[0] + (y - m[13]) * _d[1] + (z - m[14]) * _d[2];
    return chainBlend(s, [[-0.03, 0.07], [0.44, 0.045], [0.865, 0.03]], ['pelvis', 'thigh' + side, 'shin' + side, 'foot' + side], w, scale);
  }
  w[BONE_INDEX[chain]] += scale;   // rigid to a named bone
}

// ---------------------------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------------------------
function C(frame, sdf, o = {}) {
  return { frame, sdf, bbox: o.bbox || sdf.bbox, k: o.k ?? 0, op: o.op || 'add', slot: o.slot ?? SLOT.top, chain: o.chain || 'torso', paint: o.paint || null, margin: o.margin || 0 };
}
function ellipsoid(cx, cy, cz, rx, ry, rz, inflate = 0) {
  const f = (x, y, z) => sdEllipsoid(x - cx, y - cy, z - cz, rx, ry, rz) - inflate;
  f.bbox = [cx - rx - inflate, cy - ry - inflate, cz - rz - inflate, cx + rx + inflate, cy + ry + inflate, cz + rz + inflate];
  return f;
}
function cone(a, b, ra, rb, inflate = 0) {
  const f = (x, y, z) => sdCone(x, y, z, a, b, ra, rb) - inflate;
  const r = Math.max(ra, rb) + inflate;
  f.bbox = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r];
  return f;
}
function rbox(cx, cy, cz, hx, hy, hz, r, rotX = 0, rotY = 0) {
  const cX = Math.cos(rotX), sX = Math.sin(rotX), cY = Math.cos(rotY), sY = Math.sin(rotY);
  const f = (x, y, z) => {
    let px = x - cx, py = y - cy, pz = z - cz;
    if (rotY) { const t = cY * px - sY * pz; pz = sY * px + cY * pz; px = t; }
    if (rotX) { const t = cX * py + sX * pz; pz = -sX * py + cX * pz; py = t; }
    return sdRoundBox(px, py, pz, hx, hy, hz, r);
  };
  const R = Math.hypot(hx, hy, hz);
  f.bbox = [cx - R, cy - R, cz - R, cx + R, cy + R, cz + R];
  return f;
}
function torus(cx, cy, cz, R, r, rotX = 0, sy = 1) {
  const c = Math.cos(rotX), s = Math.sin(rotX);
  const f = (x, y, z) => {
    const px = x - cx; let py = y - cy, pz = z - cz;
    const t = c * py + s * pz; pz = -s * py + c * pz; py = t / sy;
    return sdTorus(px, py, pz, R, r) * Math.min(1, sy);
  };
  const E = R + r + 0.01;
  f.bbox = [cx - E, cy - E, cz - E, cx + E, cy + E, cz + E];
  return f;
}
function inflate(f, d) { const g = (x, y, z) => f(x, y, z) - d; g.bbox = f.bbox.map((v, i) => v + (i < 3 ? -d : d)); return g; }
function mirrorX(f) { const g = (x, y, z) => f(-x, y, z); g.bbox = [-f.bbox[3], f.bbox[1], f.bbox[2], -f.bbox[0], f.bbox[4], f.bbox[5]]; return g; }
/** keep only the part of f where n·p <= d (smooth) */
function cut(f, n, d, k = 0.004) {
  const g = (x, y, z) => smax(f(x, y, z), n[0] * x + n[1] * y + n[2] * z - d, k);
  g.bbox = f.bbox;
  return g;
}

// ---------------------------------------------------------------------------------------------
// Anatomy tables (base body at 1.80 m; half-widths rx, front depth rzF, back depth rzB, centre cz)
// ---------------------------------------------------------------------------------------------
const TORSO = [
  [0.84, 0.148, 0.085, 0.100, 0],
  [0.92, 0.166, 0.094, 0.114, -0.004],
  [0.98, 0.163, 0.097, 0.104, -0.004],
  [1.05, 0.150, 0.098, 0.090, 0],
  [1.12, 0.143, 0.100, 0.085, 0],
  [1.20, 0.149, 0.106, 0.088, 0],
  [1.28, 0.159, 0.114, 0.093, 0],
  [1.36, 0.167, 0.118, 0.098, 0],
  [1.42, 0.165, 0.11, 0.099, -0.004],
  [1.45, 0.152, 0.098, 0.096, -0.006],
  [1.48, 0.122, 0.08, 0.09, -0.009],
  [1.505, 0.088, 0.066, 0.078, -0.012],
  [1.53, 0.064, 0.056, 0.060, -0.012],
];
function torsoAt(y) {
  const T = TORSO;
  if (y <= T[0][0]) return T[0];
  for (let i = 0; i < T.length - 1; i++) {
    if (y <= T[i + 1][0]) {
      const u = (y - T[i][0]) / (T[i + 1][0] - T[i][0]);
      return T[i].map((v, c) => v + (T[i + 1][c] - v) * u);
    }
  }
  return T[T.length - 1];
}
const ARM = [   // t along the arm from the shoulder joint: rx, rzF, rzB
  [-0.03, 0.032, 0.032, 0.032], [0.01, 0.048, 0.045, 0.048], [0.06, 0.05, 0.046, 0.049], [0.14, 0.042, 0.045, 0.041],
  [0.23, 0.038, 0.04, 0.037], [0.29, 0.036, 0.035, 0.039], [0.34, 0.039, 0.038, 0.036], [0.44, 0.033, 0.031, 0.03],
  [0.53, 0.029, 0.022, 0.023],
];
const LEG = [   // t along the leg from the hip joint
  [-0.09, 0.10, 0.10, 0.11], [0.0, 0.092, 0.086, 0.096], [0.08, 0.086, 0.081, 0.086], [0.2, 0.076, 0.073, 0.074],
  [0.32, 0.064, 0.062, 0.062], [0.42, 0.053, 0.057, 0.05], [0.5, 0.05, 0.045, 0.058], [0.58, 0.05, 0.043, 0.06],
  [0.7, 0.04, 0.035, 0.045], [0.8, 0.032, 0.03, 0.034], [0.87, 0.03, 0.03, 0.03],
];
function tableAt(T, t) {
  if (t <= T[0][0]) return T[0];
  for (let i = 0; i < T.length - 1; i++) if (t <= T[i + 1][0]) {
    const u = (t - T[i][0]) / (T[i + 1][0] - T[i][0]);
    return T[i].map((v, c) => v + (T[i + 1][c] - v) * u);
  }
  return T[T.length - 1];
}

/** Garment profile around the torso: samples ys, offset(y) -> [dx, dzF, dzB]. */
function torsoGarment(ys, off, bulk) {
  const keys = ys.map((y) => {
    const b = torsoAt(y), o = off(y);
    return [y, b[1] * bulk + o[0], b[2] * bulk + o[1], b[3] * bulk + o[2], 0, b[4]];
  });
  return makeProfile(keys, 1);
}
function limbGarment(T, ts, off, bulk, mod) {
  const keys = ts.map((t) => {
    const b = tableAt(T, t), o = off(t);
    return [t, b[1] * bulk + o[0], b[2] * bulk + o[1], b[3] * bulk + o[2], 0, 0];
  });
  return makeProfile(keys, -1, mod);
}
// front surface depth of a torso garment at height y (for placing pockets / zips)
function frontZ(y, bulk, dz) { const b = torsoAt(y); return b[4] + b[2] * bulk + dz; }

// ---------------------------------------------------------------------------------------------
// Garments per look
// ---------------------------------------------------------------------------------------------
const ripple = (t, a, b, lambda, amp) => (t > a && t < b ? Math.sin(((t - a) / lambda) * Math.PI * 2) * amp * Math.sin(((t - a) / (b - a)) * Math.PI) : 0);

function buildTop(L, comps, extras, bulk) {
  const S = SLOT;
  const top = L.top;
  let hem, dx, dzF, dzB, sleeve, cuffT;
  if (top === 'hoodie') { hem = 0.9; dx = 0.024; dzF = 0.026; dzB = 0.024; sleeve = 0.019; cuffT = 0.5; }
  else if (top === 'jacket') { hem = 0.915; dx = 0.03; dzF = 0.03; dzB = 0.026; sleeve = 0.02; cuffT = 0.535; }
  else if (top === 'leather') { hem = 0.985; dx = 0.016; dzF = 0.02; dzB = 0.016; sleeve = 0.014; cuffT = 0.535; }
  else { hem = 0.925; dx = 0.012; dzF = 0.012; dzB = 0.012; sleeve = 0.011; cuffT = 0.54; }

  // ---- torso shell ----
  const ys = [hem, hem + 0.04, hem + 0.08, 1.05, 1.12, 1.2, 1.28, 1.36, 1.42, 1.45, 1.48, 1.505, 1.53];
  const off = (y) => {
    let a = 1;
    if (top === 'hoodie') {
      if (y < hem + 0.05) a = 0.85;                       // ribbed hem band, blousing above it
      else if (y < hem + 0.13) a = 1.3;
    } else if (top === 'jacket') {
      if (y < 1.0) a = 1.15;                               // boxy, flares at the hem
    } else if (top === 'leather' && y < hem + 0.045) a = 0.75; // waistband
    const neck = sstep(1.46, 1.52, y);
    return [dx * a * (1 - neck * 0.5), dzF * a * (1 - neck * 0.4), dzB * a * (1 - neck * 0.4)];
  };
  comps.push(C('model', torsoGarment(ys, off, bulk), { slot: S.top, chain: 'torso' }));
  // hem band colour
  if (top === 'hoodie') comps.push(C('model', torsoGarment([hem, hem + 0.05], () => [dx * 0.85 + 0.001, dzF * 0.85 + 0.001, dzB * 0.85 + 0.001], bulk), { slot: S.topTrim, chain: 'torso', k: 0.004 }));
  if (top === 'leather') comps.push(C('model', torsoGarment([hem, hem + 0.045], () => [dx * 0.75 + 0.002, dzF * 0.75 + 0.002, dzB * 0.75 + 0.002], bulk), { slot: S.topTrim, chain: 'torso', k: 0.004 }));

  // ---- neck (bare skin between collar and head patch) ----
  comps.push(C('model', cone([0, 1.44, -0.014], [0, 1.6, -0.004], 0.058, 0.054), { slot: S.skin, chain: 'torso', k: 0.045 }));

  // ---- sleeves ----
  for (const side of ['L', 'R']) {
    const bone = 'upperArm' + side;
    const ts = [-0.03, 0.01, 0.06, 0.14, 0.23, 0.29, 0.34, 0.44, cuffT - 0.06, cuffT, 0.555];
    const soff = (t) => {
      let a = 1;
      if (top === 'hoodie') { if (t > cuffT) a = 0.35; else if (t > cuffT - 0.09) a = 1.45; }
      if (top === 'jacket' && t > 0.3) a = 1.25;   // wide straight sleeve
      if (top === 'shirt' && t > cuffT) a = 0.6;
      return [sleeve * a, sleeve * a, sleeve * a];
    };
    const mod = (t, ex, ez) => {
      // soft folds at the inside of the elbow and where the sleeve gathers above the cuff
      let m = 0;
      if (ez > 0) m += ripple(t, 0.24, 0.36, 0.045, 0.0035) * (ez / Math.hypot(ex, ez));
      m += ripple(t, cuffT - 0.13, cuffT - 0.01, 0.05, top === 'hoodie' ? 0.004 : 0.0025);
      return m;
    };
    comps.push(C(bone, limbGarment(ARM, ts, soff, bulk, mod), { slot: S.top, chain: 'arm' + side, k: 0.045 }));
    if (top === 'hoodie') comps.push(C(bone, limbGarment(ARM, [cuffT + 0.004, 0.555], () => [sleeve * 0.35 + 0.0015, sleeve * 0.35 + 0.0015, sleeve * 0.35 + 0.0015], bulk), { slot: S.topTrim, chain: 'arm' + side, k: 0.003 }));
    if (top === 'jacket' || top === 'leather') comps.push(C(bone, limbGarment(ARM, [cuffT - 0.008, cuffT + 0.014], () => [sleeve * 1.25 + 0.003, sleeve * 1.25 + 0.003, sleeve * 1.25 + 0.003], bulk), { slot: S.topTrim, chain: 'arm' + side, k: 0.006 }));
  }

  // ---- collar / hood ----
  const fz = (y, d = dzF) => frontZ(y, bulk, d);
  if (top === 'hoodie') {
    if (L.hood !== 'up') {
      // hood down: bunched fabric lying round the back of the neck and on the upper back
      comps.push(C('model', torus(0, 1.505, -0.03, 0.085, 0.03, -0.45, 0.8), { slot: S.top, chain: 'torso', k: 0.03 }));
      comps.push(C('model', torus(0, 1.515, -0.006, 0.07, 0.016, -0.3, 1), { slot: S.top, chain: 'torso', k: 0.02 }));   // crossover neckline
      comps.push(C('model', ellipsoid(0, 1.42, -0.125, 0.105, 0.085, 0.04), { slot: S.top, chain: 'torso', k: 0.04 }));
    } else {
      comps.push(C('model', torus(0, 1.49, -0.01, 0.085, 0.03, -0.2, 0.9), { slot: S.top, chain: 'torso', k: 0.03 }));
    }
    // kangaroo pocket
    const py = hem + 0.1;
    comps.push(C('model', rbox(0, py, fz(py) - 0.016, 0.11 * bulk, 0.055, 0.02, 0.014, -0.1), { slot: S.top, chain: 'torso', k: 0.012 }));
    // drawstrings (explicit cords)
    for (const sx of [1, -1]) extras.push({ kind: 'cord', a: [sx * 0.035, 1.47, fz(1.47) + 0.012], b: [sx * 0.04, 1.33, fz(1.33) + 0.006], r: 0.0035, slot: S.cord, chain: 'torso' });
  } else if (top === 'jacket') {
    comps.push(C('model', makeProfile([[1.47, 0.088, 0.084, 0.088, 0, -0.012], [1.52, 0.078, 0.074, 0.08, 0, -0.016], [1.565, 0.074, 0.07, 0.077, 0, -0.018]], 1), { slot: S.topTrim, chain: 'torso', k: 0.02 }));
    for (const sx of [1, -1]) {   // chest pockets with flaps
      comps.push(C('model', rbox(sx * 0.085 * bulk, 1.3, fz(1.3) - 0.01, 0.05, 0.06, 0.016, 0.008, -0.12), { slot: S.top, chain: 'torso', k: 0.006 }));
      comps.push(C('model', rbox(sx * 0.085 * bulk, 1.345, fz(1.345) - 0.004, 0.054, 0.016, 0.014, 0.006, -0.12), { slot: S.topTrim, chain: 'torso', k: 0.004 }));
      comps.push(C('model', rbox(sx * 0.1 * bulk, hem + 0.1, fz(hem + 0.1, dzF * 1.15) - 0.012, 0.06, 0.055, 0.016, 0.01, 0.05), { slot: S.top, chain: 'torso', k: 0.006 }));
    }
    extras.push({ kind: 'zip', ys: [hem + 0.005, 1.5], x: 0, dz: dzF, dzTop: 0.08, slot: S.metal, chain: 'torso' });
  } else if (top === 'leather') {
    // fold-down collar roll and asymmetric moto zip
    comps.push(C('model', torus(0, 1.488, -0.008, 0.088, 0.022, -0.32, 0.75), { slot: S.top, chain: 'torso', k: 0.02 }));
    comps.push(C('model', ellipsoid(-0.05, 1.395, fz(1.395) - 0.02, 0.06, 0.08, 0.022), { slot: S.top, chain: 'torso', k: 0.03 }));   // lapel
    extras.push({ kind: 'zip', ys: [hem + 0.004, 1.43], x: -0.03, xTop: 0.035, dz: dzF, dzTop: 0.012, slot: S.metal, chain: 'torso' });
  } else {
    comps.push(C('model', torus(0, 1.505, -0.008, 0.068, 0.013, -0.2, 1), { slot: S.topTrim, chain: 'torso', k: 0.012 }));
    extras.push({ kind: 'zip', ys: [hem + 0.01, 1.47], x: 0, dz: dzF, dzTop: 0.03, slot: S.topTrim, chain: 'torso', w: 0.01 });
  }

  // ---- plate carrier ----
  if (L.vest) {
    const vz = (y) => frontZ(y, bulk, dzF);
    comps.push(C('model', rbox(0, 1.27, vz(1.3) - 0.005, 0.145 * bulk, 0.15, 0.03, 0.022, -0.06), { slot: S.vest, chain: 'torso', k: 0.02 }));
    comps.push(C('model', rbox(0, 1.27, -(torsoAt(1.3)[3] * bulk + dzB) + 0.008, 0.145 * bulk, 0.15, 0.02, 0.016), { slot: S.vest, chain: 'torso', k: 0.02 }));
    comps.push(C('model', torsoGarment([1.1, 1.15, 1.2], () => [dx + 0.022, dzF + 0.02, dzB + 0.022], bulk), { slot: S.vest, chain: 'torso', k: 0.01 }));
    for (const sx of [1, -1]) comps.push(C('model', cone([sx * 0.1, 1.41, 0.075], [sx * 0.12, 1.47, -0.03], 0.024, 0.024), { slot: S.vestTrim, chain: 'torso', k: 0.02 }));
    for (const x of [-0.075, 0, 0.075]) comps.push(C('model', rbox(x, 1.19, vz(1.2) + 0.03, 0.033, 0.05, 0.022, 0.008), { slot: S.vestTrim, chain: 'torso', k: 0.006 }));
    comps.push(C('model', rbox(0.06, 1.34, vz(1.34) + 0.026, 0.04, 0.032, 0.016, 0.006), { slot: S.vestTrim, chain: 'torso', k: 0.005 }));
  }
}

function buildLegs(L, comps, bulk) {
  const S = SLOT, kind = L.legsKind;
  const dx = kind === 'denim' ? 0.012 : kind === 'cargo' ? 0.026 : 0.02;
  // trouser seat / waist
  comps.push(C('model', torsoGarment([0.8, 0.86, 0.92, 0.98, 1.04, 1.08], (y) => { const w = mix(1, 0.4, sstep(0.95, 1.01, y)); return [dx * w, dx * w, dx * 1.1 * w]; }, bulk), { slot: S.legs, chain: 'torso' }));
  // belt + buckle
  comps.push(C('model', torsoGarment([1.02, 1.055], () => [dx * 0.4 + 0.007, dx * 0.4 + 0.007, dx * 0.44 + 0.007], bulk), { slot: S.belt, chain: 'torso', k: 0.004 }));
  comps.push(C('model', rbox(0, 1.038, frontZ(1.038, bulk, dx * 0.4 + 0.008), 0.024, 0.018, 0.006, 0.003), { slot: S.metal, chain: 'torso', k: 0.004 }));
  for (const side of ['L', 'R']) {
    const bone = 'thigh' + side, sx = side === 'L' ? 1 : -1;
    const hem = 0.84;
    const ts = [-0.09, 0.0, 0.08, 0.2, 0.32, 0.42, 0.5, 0.58, 0.7, 0.78, hem];
    const loff = (t) => {
      if (kind === 'denim') { const straight = sstep(0.36, 0.5, t); return [dx + straight * Math.max(0, 0.056 - tableAt(LEG, t)[1] * bulk), dx + straight * Math.max(0, 0.058 - tableAt(LEG, t)[2] * bulk), dx + straight * Math.max(0, 0.06 - tableAt(LEG, t)[3] * bulk)]; }
      if (kind === 'cargo') { const g = t > 0.74 ? 1.25 - 0.9 * sstep(0.8, hem, t) : 1; return [dx * g + 0.008 * sstep(0.4, 0.7, t), dx * g, dx * g + 0.01 * sstep(0.3, 0.6, t)]; }
      const st = sstep(0.4, 0.55, t);
      return [dx + st * Math.max(0, 0.062 - tableAt(LEG, t)[1] * bulk), dx + st * Math.max(0, 0.064 - tableAt(LEG, t)[2] * bulk), dx + st * Math.max(0, 0.066 - tableAt(LEG, t)[3] * bulk)];
    };
    const mod = (t, ex, ez) => {
      let m = ripple(t, 0.66, 0.84, 0.055, 0.0045);                          // bunching at the ankle
      m += ripple(t, 0.36, 0.5, 0.04, 0.003) * (ez > 0 ? 1 : 0.4);            // knee creases
      if (t < 0.12 && ez > 0) m += ripple(t, -0.04, 0.12, 0.05, 0.003);       // crotch fold
      return m;
    };
    comps.push(C(bone, limbGarment(LEG, ts, loff, bulk, mod), { slot: S.legs, chain: 'leg' + side, k: 0.04 }));
    // hem band
    comps.push(C(bone, limbGarment(LEG, [hem - 0.018, hem], (t) => loff(t).map((v) => v + 0.002), bulk), { slot: S.legsTrim, chain: 'leg' + side, k: 0.003 }));
    if (kind === 'cargo' || kind === 'work') {
      // thigh cargo pocket on the outside of the leg
      const p = tableAt(LEG, 0.3);
      comps.push(C(bone, rbox(sx * (p[1] * bulk + dx + 0.006), -0.31, 0.0, 0.016, 0.075, 0.058, 0.01, 0, 0), { slot: S.legsTrim, chain: 'leg' + side, k: 0.008 }));
    }
    if (kind === 'work') {
      const p = tableAt(LEG, 0.44);
      comps.push(C(bone, rbox(0, -0.445, p[2] * bulk + 0.055, 0.05, 0.065, 0.016, 0.012, 0.0), { slot: S.legsTrim, chain: 'leg' + side, k: 0.01 }));
    }
    if (kind === 'denim' && L.top === 'leather') {
      // back pockets + front pocket edge
      comps.push(C('model', rbox(sx * 0.075 * bulk, 0.97, -(torsoAt(0.97)[3] * bulk + dx) + 0.001, 0.055, 0.06, 0.008, 0.006), { slot: S.legsTrim, chain: 'torso', k: 0.006 }));
    }
  }
}

function buildBoots(L, comps) {
  const S = SLOT;
  for (const side of ['L', 'R']) {
    const bone = 'foot' + side, chain = 'leg' + side;
    // sole: slab clipped to a foot outline (wider forefoot), rounded toe
    const sole = (x, y, z) => {
      const rx = 0.044 + 0.012 * sstep(-0.04, 0.11, z) - 0.006 * sstep(0.15, 0.21, z);
      const ex = x / rx, ez = (z - 0.068) / 0.142;
      const d2 = (Math.sqrt(ex * ex + ez * ez) - 1) * Math.min(rx, 0.142);
      return smax(d2, Math.abs(y + 0.073) - 0.0135, 0.008);
    };
    sole.bbox = [-0.06, -0.09, -0.08, 0.06, -0.055, 0.215];
    comps.push(C(bone, sole, { slot: S.sole, chain }));
    comps.push(C(bone, ellipsoid(0, -0.03, -0.03, 0.044, 0.05, 0.05), { slot: S.boots, chain, k: 0.02 }));
    comps.push(C(bone, ellipsoid(0, -0.035, 0.06, 0.051, 0.042, 0.095), { slot: S.boots, chain, k: 0.03 }));
    comps.push(C(bone, ellipsoid(0, -0.047, 0.142, 0.047, 0.03, 0.065), { slot: S.boots, chain, k: 0.02 }));
    comps.push(C(bone, cone([0, -0.02, -0.006], [0, 0.13, -0.012], 0.05, 0.046), { slot: S.boots, chain, k: 0.03 }));
    comps.push(C(bone, cone([0, 0.0, 0.05], [0, 0.07, 0.03], 0.018, 0.016), { slot: S.boots, chain, k: 0.03 }));   // tongue / laces
    comps.push(C(bone, ellipsoid(0, -0.072, -0.02, 0.05, 0.016, 0.06), { slot: S.sole, chain, k: 0.0 }));       // heel block
  }
}

// ---------------------------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------------------------
function skinPaint(x, y, z, out, look) {
  // brows, mouth line, beard shadow, flushed cheeks (multipliers on the skin colour)
  let r = 1, g = 1, b = 1;
  const ax = Math.abs(x);
  const brow = Math.exp(-(((ax - 0.034) / 0.02) ** 2) - (((y - 0.118 + (ax - 0.034) * 0.12) / 0.0055) ** 2)) * (z > 0.06 ? 1 : 0);
  const k = 1 - 0.68 * brow;
  r *= k; g *= k; b *= k;
  const mouth = Math.exp(-((x / 0.022) ** 2) - (((y - 0.0255) / 0.0028) ** 2)) * (z > 0.08 ? 1 : 0);
  r *= 1 - 0.3 * mouth; g *= 1 - 0.33 * mouth; b *= 1 - 0.33 * mouth;
  if (look.stubble && z > 0.0) {
    const jaw = sstep(0.05, 0.025, y) * sstep(-0.03, -0.0, y) * (1 - Math.exp(-((x / 0.012) ** 2) - (((y - 0.03) / 0.02) ** 2)) * 0.6);
    const s = 1 - 0.1 * jaw;
    r *= s; g *= s; b *= s * 0.98;
  }
  const cheek = Math.exp(-(((ax - 0.042) / 0.02) ** 2) - (((y - 0.062) / 0.02) ** 2)) * (z > 0.04 ? 1 : 0);
  g *= 1 - 0.05 * cheek; b *= 1 - 0.06 * cheek;
  out[0] = r; out[1] = g; out[2] = b;
}

function buildHead(L, comps, extras) {
  const S = SLOT, H = 'head';
  const skin = { slot: S.skin, chain: 'head', paint: skinPaint };
  comps.push(C(H, ellipsoid(0, 0.112, -0.012, 0.076, 0.093, 0.098), skin));
  comps.push(C(H, ellipsoid(0, 0.058, 0.016, 0.064, 0.07, 0.07), { ...skin, k: 0.035 }));
  for (const sx of [1, -1]) comps.push(C(H, cone([sx * 0.056, 0.048, -0.01], [sx * 0.03, 0.002, 0.055], 0.02, 0.018), { ...skin, k: 0.03 }));
  comps.push(C(H, ellipsoid(0, -0.002, 0.066, 0.027, 0.021, 0.02), { ...skin, k: 0.022 }));
  for (const sx of [1, -1]) comps.push(C(H, ellipsoid(sx * 0.047, 0.08, 0.05, 0.028, 0.018, 0.024), { ...skin, k: 0.032 }));
  comps.push(C(H, cone([-0.042, 0.116, 0.077], [0.042, 0.116, 0.077], 0.012, 0.012), { ...skin, k: 0.02 }));
  // nose
  comps.push(C(H, cone([0, 0.104, 0.086], [0, 0.066, 0.1], 0.007, 0.0095), { ...skin, k: 0.012 }));
  comps.push(C(H, ellipsoid(0, 0.063, 0.099, 0.0105, 0.0095, 0.0095), { ...skin, k: 0.008 }));
  for (const sx of [1, -1]) comps.push(C(H, ellipsoid(sx * 0.0125, 0.061, 0.09, 0.0085, 0.0075, 0.008), { ...skin, k: 0.008 }));
  // eye sockets
  for (const sx of [1, -1]) comps.push(C(H, ellipsoid(sx * 0.033, 0.097, 0.092, 0.018, 0.0095, 0.012), { ...skin, op: 'sub', k: 0.012 }));
  // lips
  comps.push(C(H, ellipsoid(0, 0.031, 0.083, 0.022, 0.006, 0.008), { slot: S.lips, chain: 'head', k: 0.008 }));
  comps.push(C(H, ellipsoid(0, 0.02, 0.081, 0.02, 0.007, 0.008), { slot: S.lips, chain: 'head', k: 0.008 }));
  // ears
  for (const sx of [1, -1]) {
    comps.push(C(H, ellipsoid(sx * 0.074, 0.092, -0.01, 0.012, 0.03, 0.019), { ...skin, k: 0.008 }));
    comps.push(C(H, ellipsoid(sx * 0.086, 0.088, -0.006, 0.006, 0.014, 0.01), { ...skin, op: 'sub', k: 0.004 }));
  }
  // neck (2 mm thicker than the one in the top patch so it encloses that cap)
  comps.push(C('model', cone([0, 1.44, -0.014], [0, 1.6, -0.004], 0.06, 0.056), { slot: S.skin, chain: 'torso', k: 0.03 }));
  // eyes (explicit)

  const cranium = (d) => ellipsoid(0, 0.112, -0.012, 0.076 + d, 0.093 + d, 0.098 + d);
  const headParts = comps.filter((c) => c.frame === H);
  const headField = (x, y, z) => {
    let f = 1e3;
    for (const c of headParts) {
      const d = c.sdf(x, y, z);
      f = c.op === 'sub' ? smax(f, -d, c.k) : smin(f, d, c.k);
    }
    return f;
  };
  // eyes: almond-shaped caps sitting on the actual skin surface (found by marching the head field)
  for (const sx of [1, -1]) {
    const x = sx * 0.032, y = 0.096;
    let z = 0.13;
    while (z > 0.03 && headField(x, y, z) > 0) z -= 0.0005;
    extras.push({ kind: 'eye', c: [x, y, z], side: sx, chain: 'head', frame: H });
  }
  if (L.face === 'balaclava') {
    // knitted shell over head and neck with an eye opening
    const opening = rbox(0, 0.097, 0.1, 0.05, 0.015, 0.05, 0.012);
    const f = (x, y, z) => smax(headField(x, y, z) - 0.0045, -opening(x, y, z), 0.006);
    f.bbox = [-0.09, -0.06, -0.12, 0.09, 0.215, 0.12];
    comps.push(C(H, f, { slot: S.balaclava, chain: 'head', k: 0.012 }));
    comps.push(C('model', cone([0, 1.45, -0.014], [0, 1.6, 0.0], 0.068, 0.062), { slot: S.balaclava, chain: 'torso', k: 0.03 }));
  } else if (L.hair !== 'bald' && L.hair !== 'buzz' && L.headwear !== 'beanie' && L.hood !== 'up') {
    // short hair: thin shell over the cranium above a hairline
    const shell = cranium(0.005);
    const f = (x, y, z) => {
      const line = 0.135 - 0.1 * sstep(0.03, -0.1, z) - 0.02 * sstep(0.05, 0.075, Math.abs(x)) * sstep(0.0, 0.06, z);
      const top = 0.004 * sstep(0.12, 0.2, y);
      return smax(shell(x, y, z) - top, line - y, 0.018);
    };
    f.bbox = shell.bbox;
    comps.push(C(H, f, { slot: S.hair, chain: 'head', k: 0.006 }));
  }
  if (L.headwear === 'beanie' && L.hood !== 'up') {
    const shell = cranium(0.012);
    const f = (x, y, z) => smax(shell(x, y, z) - 0.006 * sstep(0.17, 0.215, y), 0.112 - y + 0.03 * sstep(0.0, -0.1, z), 0.008);
    f.bbox = shell.bbox;
    comps.push(C(H, f, { slot: S.headwear, chain: 'head', k: 0.008 }));
    const band = (x, y, z) => smax(sdEllipsoid(x, y - 0.12, z + 0.012, 0.09, 0.07, 0.113) , Math.abs(y - 0.125 + 0.03 * sstep(0.0, -0.1, z)) - 0.017, 0.006);
    band.bbox = [-0.1, 0.05, -0.13, 0.1, 0.16, 0.11];
    comps.push(C(H, band, { slot: S.headwear, chain: 'head', k: 0.006 }));
  } else if (L.headwear === 'cap' && L.hood !== 'up') {
    const shell = cranium(0.008);
    const f = (x, y, z) => smax(shell(x, y, z), 0.128 - y - 0.03 * sstep(0.02, -0.1, z), 0.006);
    f.bbox = shell.bbox;
    comps.push(C(H, f, { slot: S.headwear, chain: 'head', k: 0.006 }));
    extras.push({ kind: 'brim', frame: H, slot: S.headwear, chain: 'head' });
  }
  if (L.hood === 'up') {
    const outer = (x, y, z) => Math.min(sdEllipsoid(x, y - 0.1, z + 0.02, 0.112, 0.128, 0.132), sdCone(x, y, z, [0, -0.02, -0.05], [0, -0.12, -0.06], 0.1, 0.12));
    const f = (x, y, z) => {
      const inner = sdEllipsoid(x, y - 0.1, z + 0.012, 0.094, 0.11, 0.112);
      const opening = sdEllipsoid(x, y - 0.075, z - 0.1, 0.068, 0.105, 0.09);
      return smax(smax(outer(x, y, z), -inner, 0.006), -opening, 0.012);
    };
    f.bbox = [-0.14, -0.15, -0.2, 0.14, 0.24, 0.15];
    comps.push(C(H, f, { slot: S.top, chain: 'torso', k: 0.0 }));
  }
}

// ---------------------------------------------------------------------------------------------
// Hands (canonical right hand: palm +X, fingers -Y, thumb +Z; mirrored for the left)
// ---------------------------------------------------------------------------------------------
export const HAND_GRIP = [0.03, -0.072];   // grip-cylinder centre (x, y) in the canonical hand frame, axis = Z
function buildHand(side, L, comps) {
  const S = SLOT, bone = 'hand' + side, chain = 'arm' + side;
  const slot = L.gloves ? S.gloves : S.skin;
  const inf = L.gloves ? 0.0018 : 0;
  const mir = side === 'L';
  const add = (f, o = {}) => { f = inflate(f, inf); comps.push(C(bone, mir ? mirrorX(f) : f, { slot, chain, ...o })); };
  // wrist
  add(makeProfile([[-0.05, 0.02, 0.027, 0.027, 0, 0], [0.0, 0.018, 0.027, 0.027, 0.002, 0], [0.02, 0.017, 0.029, 0.029, 0.003, 0]], -1));
  add(rbox(0.003, -0.052, 0.0, 0.0145, 0.04, 0.037, 0.0125), { k: 0.02 });
  add(ellipsoid(0.012, -0.036, 0.024, 0.014, 0.022, 0.016), { k: 0.014 });
  const G = HAND_GRIP;
  const fingers = [[0.025, 1.0, 0.0094, -0.092], [0.007, 1.06, 0.0098, -0.095], [-0.011, 1.0, 0.0093, -0.093], [-0.027, 0.84, 0.0082, -0.088]];
  for (const [z, len, r, ky] of fingers) {
    const K = [0.005, ky];
    const a0 = Math.atan2(K[1] - G[1], K[0] - G[0]);
    const R0 = Math.hypot(K[0] - G[0], K[1] - G[1]);
    const pts = [[K[0], K[1]]];
    const steps = [1.15, 2.15, 3.15 * len];
    const radii = [0.0285, 0.027, 0.0262];
    for (let i = 0; i < 3; i++) {
      const a = a0 + steps[i] * (i === 2 ? 1 : len), rr = mix(R0, radii[i], 1);
      pts.push([G[0] + Math.cos(a) * rr, G[1] + Math.sin(a) * rr]);
    }
    const rs = [r, r * 0.95, r * 0.88, r * 0.8];
    for (let i = 0; i < 3; i++) add(cone([pts[i][0], pts[i][1], z], [pts[i + 1][0], pts[i + 1][1], z], rs[i], rs[i + 1]), { k: 0.007 });
  }
  add(cone([0.004, -0.02, 0.028], [0.022, -0.043, 0.044], 0.0125, 0.011), { k: 0.012 });
  add(cone([0.022, -0.043, 0.044], [0.042, -0.053, 0.04], 0.011, 0.0102), { k: 0.006 });
  add(cone([0.042, -0.053, 0.04], [0.057, -0.059, 0.027], 0.0102, 0.0092), { k: 0.006 });
}

// ---------------------------------------------------------------------------------------------
// Explicit (non-SDF) detail geometry
// ---------------------------------------------------------------------------------------------
function explicitGeometry(L, extras, bulk, out) {
  for (const e of extras) {
    if (e.kind === 'eye') {
      // almond-shaped patch of an R = 2 cm sphere: corners dip under the skin, centre sits 1.5 mm proud
      const W = 16, Hh = 8, P = [], N = [], I = [], cols = [], shades = [];
      const R = 0.02, a = 0.0145, z0 = e.c[2] + 0.0032, cz = z0 - R;
      for (let j = 0; j <= Hh; j++) for (let i = 0; i <= W; i++) {
        const u = (i / W) * 2 - 1, v = (j / Hh) * 2 - 1;
        const b = 0.0062 * Math.pow(Math.max(0, 1 - u * u), 0.6) + 0.0006;
        const dx = u * a, dy = v * b + 0.0016 * u * e.side + 0.0004;
        const dz = Math.sqrt(Math.max(0, R * R - dx * dx - dy * dy));
        P.push(e.c[0] + dx, e.c[1] + dy, cz + dz);
        N.push(dx / R, dy / R, dz / R);
        const rr = Math.hypot(dx - 0.0004 * e.side, dy);
        cols.push(rr < 0.0064 ? SLOT.iris : SLOT.eyeWhite);
        let s = rr < 0.0024 ? 0.1 : 1;
        s *= (0.62 + 0.38 * (1 - Math.abs(u) ** 2)) * (v > 0.3 ? 0.72 : 1);
        shades.push(s);
      }
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const q = j * (W + 1) + i, b = q + 1, c = q + W + 1, d = c + 1;
        I.push(q, b, c, b, d, c);
      }
      out.push({ frame: e.frame, pos: P, nrm: N, idx: I, slots: cols, chain: e.chain, shade: (k) => shades[k] });
    } else if (e.kind === 'cord') {
      const P = [], N = [], I = [], seg = 6, rings = 6;
      const ax = e.b[0] - e.a[0], ay = e.b[1] - e.a[1], az = e.b[2] - e.a[2];
      const len = Math.hypot(ax, ay, az);
      const dx = ax / len, dy = ay / len, dz = az / len;
      let ux = 1, uy = 0, uz = 0;
      const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
      ux = vy * dz - vz * dy; uy = vz * dx - vx * dz; uz = vx * dy - vy * dx;
      for (let j = 0; j <= rings; j++) for (let i = 0; i <= seg; i++) {
        const t = j / rings, a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
        const r = e.r * (j === rings ? 1.5 : 1);
        P.push(e.a[0] + ax * t + nx * r, e.a[1] + ay * t + ny * r, e.a[2] + az * t + nz * r);
        N.push(nx, ny, nz);
      }
      for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
        I.push(a, b, c, b, d, c);
      }
      out.push({ frame: 'model', pos: P, nrm: N, idx: I, slots: P.map(() => e.slot), chain: e.chain });
    } else if (e.kind === 'zip') {
      // narrow raised strip following the garment front
      const P = [], N = [], I = [], n = 14, w = (e.w || 0.006) / 2;
      for (let i = 0; i <= n; i++) {
        const u = i / n, y = mix(e.ys[0], e.ys[1], u);
        const x = mix(e.x, e.xTop ?? e.x, u);
        const b = torsoAt(y);
        const z = b[4] + b[2] * bulk * Math.sqrt(Math.max(0, 1 - (x / (b[1] * bulk)) ** 2)) + mix(e.dz, e.dzTop ?? e.dz, sstep(0.75, 1, u) * (e.ys[1] > 1.45 ? 1 : 0)) + 0.0025;
        P.push(x - w, y, z, x + w, y, z);
        N.push(-0.3, 0, 0.95, 0.3, 0, 0.95);
      }
      for (let i = 0; i < n; i++) { const a = i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      out.push({ frame: 'model', pos: P, nrm: N, idx: I, slots: P.map(() => e.slot), chain: e.chain });
    } else if (e.kind === 'brim') {
      // curved cap brim (thin double-sided shell)
      const P = [], N = [], I = [], nu = 9, nv = 4;
      for (const top of [1, -1]) {
        const base = P.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
          const u = (i / nu - 0.5) * 2.0, v = j / nv;
          const ang = u * 1.05;
          const R = 0.085 + v * 0.07;
          const x = Math.sin(ang) * R * 0.92, z = 0.0 + Math.cos(ang) * R;
          const y = 0.128 - v * 0.022 - (u * u) * 0.012 * v + (top > 0 ? 0.004 : -0.002);
          P.push(x, y, z);
          N.push(0, top, 0.12 * top);
        }
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
          if (top > 0) I.push(a, c, b, b, c, d); else I.push(a, b, c, b, d, c);
        }
      }
      out.push({ frame: e.frame, pos: P, nrm: N, idx: I, slots: P.map(() => e.slot), chain: e.chain, clipInside: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------
const KEEP = { top: 0.5, legs: 0.42, boots: 0.4, head: 0.5, handL: 0.45, handR: 0.45 };
const MAXTRIS = { head: 3200 };
function makePatch(name, frame, box, h, comps, clips = []) {
  const pm = BM[frame], pmi = BMI[frame];
  for (const c of comps) {
    c.toLocal = mulMat(BMI[c.frame], pm);   // patch -> component
    c.toPatch = mulMat(pmi, BM[c.frame]);
  }
  return { name, frame, box, h, comps, keep: KEEP[name] ?? 0.5, clips: clips.map((cl) => ({ m: mulMat(BMI[cl.frame], pm), n: cl.n, d: cl.d })) };
}

const cache = new Map();
/** look: { top, hood, headwear, face, hair, legsKind, vest, gloves, stubble }, bulk ~0.94..1.08, detail 0..1 */
export function generateBody(look, bulk = 1) {
  mats();
  const bq = bulk < 0.98 ? 0.96 : bulk > 1.03 ? 1.05 : 1.0;
  const geoLook = {
    top: look.top, hood: look.hood || 'none', headwear: look.headwear || 'none', face: look.face || 'bare', hair: look.hair || 'short',
    legsKind: look.legsKind || 'denim', vest: !!look.vest, gloves: !!look.gloves, stubble: !!look.stubble,
  };
  const key = JSON.stringify(geoLook) + bq;
  const hit = cache.get(key);
  if (hit) return hit;

  const L = geoLook;
  const extras = [];
  const top = [], legs = [], boots = [], head = [], hands = { L: [], R: [] };
  buildTop(L, top, extras, bq);
  buildLegs(L, legs, bq);
  buildBoots(L, boots);
  buildHead(L, head, extras);
  buildHand('L', L, hands.L);
  buildHand('R', L, hands.R);

  const patches = [
    makePatch('top', 'model', [-0.72, 0.86, -0.26, 0.72, 1.62, 0.26], 0.026, top,
      [{ frame: 'model', n: [0, 1, 0], d: 1.565 }, { frame: 'upperArmL', n: [0, -1, 0], d: 0.556 }, { frame: 'upperArmR', n: [0, -1, 0], d: 0.556 }]),
    makePatch('legs', 'model', [-0.32, 0.06, -0.22, 0.32, 1.1, 0.22], 0.03, legs, [{ frame: 'model', n: [0, 1, 0], d: 1.078 }]),
    makePatch('boots', 'model', [-0.24, -0.04, -0.14, 0.24, 0.3, 0.32], 0.017, boots,
      [{ frame: 'footL', n: [0, 1, 0], d: 0.125 }, { frame: 'footR', n: [0, 1, 0], d: 0.125 }]),
    makePatch('head', 'head', [-0.15, -0.165, -0.2, 0.15, 0.25, 0.17], 0.0105, head, [{ frame: 'model', n: [0, -1, 0], d: -1.455 }]),
    makePatch('handL', 'handL', [-0.08, -0.14, -0.07, 0.08, 0.06, 0.08], 0.0085, hands.L, [{ frame: 'handL', n: [0, 1, 0], d: 0.045 }]),
    makePatch('handR', 'handR', [-0.08, -0.14, -0.07, 0.08, 0.06, 0.08], 0.0085, hands.R, [{ frame: 'handR', n: [0, 1, 0], d: 0.045 }]),
  ];

  const P = [], Nn = [], SI = [], SW = [], SL = [], SH = [], IDX = [];
  const nb = BONE_NAMES.length;
  const wTmp = new Float64Array(nb);
  const paintOut = new Float64Array(3);
  const loc = new Float64Array(3), mp = new Float64Array(3), mn = new Float64Array(3);

  for (const patch of patches) {
    const raw = meshPatch(patch);
    const addComps = patch.comps.filter((c) => c.op === 'add');
    // material slot per raw vertex -> simplify without merging across slot borders
    const nRaw = raw.pos.length / 3;
    const grp = new Int32Array(nRaw);
    for (let v = 0; v < nRaw; v++) {
      let dmin = Infinity, best = 0;
      for (let i = 0; i < addComps.length; i++) {
        const d = compDist(addComps[i], raw.pos[v * 3], raw.pos[v * 3 + 1], raw.pos[v * 3 + 2]);
        if (d < dmin) { dmin = d; best = i; }
      }
      grp[v] = addComps[best].slot;
    }
    const dec = decimate(raw.pos, raw.idx, grp, Math.round(Math.min((raw.idx.length / 3) * patch.keep, MAXTRIS[patch.name] ?? Infinity)), 1e-3);
    const nv = dec.count;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    for (let v = 0; v < nRaw; v++) {
      const k = dec.keep[v];
      if (k < 0) continue;
      for (let j = 0; j < 3; j++) pos[k * 3 + j] = raw.pos[v * 3 + j];
    }
    projectVertices(patch, pos, nrm, 2);
    const idx = dec.idx;
    const base = P.length / 3;
    const W = new Float32Array(nv * nb);
    const sigma = patch.h * 0.6;
    const dist = new Float64Array(addComps.length);
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let dmin = Infinity, best = 0;
      for (let i = 0; i < addComps.length; i++) {
        dist[i] = compDist(addComps[i], x, y, z);
        if (dist[i] < dmin) { dmin = dist[i]; best = i; }
      }
      mulPoint(BM[patch.frame], x, y, z, mp);
      wTmp.fill(0);
      let tot = 0;
      for (let i = 0; i < addComps.length; i++) {
        const dd = dist[i] - dmin;
        if (dd > sigma * 5) continue;
        const o = Math.exp(-dd / sigma);
        tot += o;
        chainWeights(addComps[i].chain, mp[0], mp[1], mp[2], wTmp, o);
      }
      for (let b = 0; b < nb; b++) W[v * nb + b] = wTmp[b] / tot;
      // slot + shade
      const c = addComps[best];
      let sr = 1, sg = 1, sb = 1;
      if (c.paint) {
        const m = c.toLocal;
        mulPoint(m, x, y, z, loc);
        c.paint(loc[0], loc[1], loc[2], paintOut, L);
        sr = paintOut[0]; sg = paintOut[1]; sb = paintOut[2];
      }
      // ambient occlusion from the patch field
      let occ = 0, wsum = 0;
      const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      const step = Math.max(0.006, patch.h * 0.55);
      for (let i = 1; i <= 4; i++) {
        const dd = i * step, wgt = 1 / i;
        const f = fieldAt(patch, x + nx * dd, y + ny * dd, z + nz * dd);
        occ += wgt * clamp((dd - f) / dd, 0, 1);
        wsum += wgt;
      }
      const ao = clamp(1 - (patch.name === 'head' ? 0.7 : 1.35) * (occ / wsum), patch.name === 'head' ? 0.55 : 0.3, 1);
      SL.push(c.slot);
      SH.push(sr * ao, sg * ao, sb * ao);
      mulDir(BM[patch.frame], nx, ny, nz, mn);
      P.push(mp[0], mp[1], mp[2]);
      Nn.push(mn[0], mn[1], mn[2]);
    }
    // smooth weights over the mesh (removes ownership steps between components)
    const nbr = Array.from({ length: nv }, () => []);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
    }
    const W2 = new Float32Array(W.length);
    for (let it = 0; it < 2; it++) {
      for (let v = 0; v < nv; v++) {
        const ns = nbr[v];
        for (let b = 0; b < nb; b++) {
          let s = 0;
          for (const n of ns) s += W[n * nb + b];
          W2[v * nb + b] = ns.length ? W[v * nb + b] * 0.5 + (s / ns.length) * 0.5 : W[v * nb + b];
        }
      }
      W.set(W2);
    }
    for (let v = 0; v < nv; v++) pushTop4(W, v, nb, SI, SW);
    for (let i = 0; i < idx.length; i++) IDX.push(idx[i] + base);
  }

  // explicit geometry
  const ex = [];
  explicitGeometry(L, extras, bq, ex);
  for (const g of ex) {
    const base = P.length / 3, m = BM[g.frame];
    const nv = g.pos.length / 3;
    for (let v = 0; v < nv; v++) {
      mulPoint(m, g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2], mp);
      mulDir(m, g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2], mn);
      const l = Math.hypot(mn[0], mn[1], mn[2]) || 1;
      P.push(mp[0], mp[1], mp[2]); Nn.push(mn[0] / l, mn[1] / l, mn[2] / l);
      wTmp.fill(0);
      chainWeights(g.chain, mp[0], mp[1], mp[2], wTmp, 1);
      const Wv = Float32Array.from(wTmp);
      pushTop4(Wv, 0, nb, SI, SW);
      SL.push(g.slots[v]);
      const s = g.shade ? g.shade(v) : 1;
      SH.push(s, s, s);
    }
    for (const i of g.idx) IDX.push(i + base);
  }

  const res = {
    key,
    position: new Float32Array(P), normal: new Float32Array(Nn),
    skinIndex: new Uint16Array(SI), skinWeight: new Float32Array(SW),
    slot: new Uint8Array(SL), shade: new Float32Array(SH),
    index: P.length / 3 > 65535 ? new Uint32Array(IDX) : new Uint16Array(IDX),
    look: L, bulk: bq,
  };
  // normalise normals
  const N = res.normal;
  for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
  if (cache.size > 48) cache.delete(cache.keys().next().value);
  cache.set(key, res);
  return res;
}

function pushTop4(W, v, nb, SI, SW) {
  const best = [[0, -1], [0, -1], [0, -1], [0, -1]];
  for (let b = 0; b < nb; b++) {
    const w = W[v * nb + b];
    if (w <= best[3][1]) continue;
    best[3] = [b, w];
    best.sort((a, c) => c[1] - a[1]);
  }
  let s = 0;
  for (const [, w] of best) if (w > 0.01) s += w;
  for (const [b, w] of best) {
    const ok = w > 0.01;
    SI.push(ok ? b : 0);
    SW.push(ok ? w / s : 0);
  }
}

void SKEL;
