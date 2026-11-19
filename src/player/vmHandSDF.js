import * as THREE from 'three';
import { sdRoundCone, sdRoundBox, smin, smax, surfaceNets } from './vmGeom.js';

// One gloved hand as a single smooth implicit surface (surface nets over a signed distance field), built once
// at load from the joint positions of the grip pose (vmHands.js specs):
//   palm   = smooth union of a knuckle bar, a wrist bar and a flat rounded slab between them
//   thenar = a thick tapered mass from the wrist to the thumb's base joint, fused with the palm
//   digits = chains of round cones (proximal / middle / distal phalanx + rounded tip), fused with the palm at
//            their base only, so neighbouring fingers stay separate
//   contact: the field is clipped against the pistol, so fingers flatten on the grip instead of floating or
//            sinking into it.
// The earlier version lofted every finger and the thumb as separate tubes; under the wide bodycam lens that read
// as a bundle of sausages with no palm, back of hand or knuckle line.
//
// Output: indexed BufferGeometry with position, normal, aGlove (leather, rubber, strap, cuff), aLen, skinIndex,
// skinWeight (16 bones, same layout as the rig in vmHands.js: 0 root, 1..12 fingers, 13..15 thumb).

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ortho = (v, axis) => norm(sub(v, mul(axis, dot(v, axis))));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** distance from p to segment ab and the parameter t along it */
function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a);
  const t = clamp01(dot(ap, ab) / (dot(ab, ab) || 1));
  return { d: len(sub(ap, mul(ab, t))), t };
}

export function buildHandSDF(spec, dims, gunSDF, opts = {}) {
  const { FINGER, THUMB, NAMES } = dims;
  const W = spec.wrist;
  const mcps = NAMES.map((n) => spec.fingers[n].joints[0].p);
  const midMcp = lerp3(mcps[1], mcps[2], 0.5);
  const F = norm(sub(midMcp, W));                       // wrist -> knuckles
  const Sk = ortho(sub(mcps[3], mcps[0]), F);            // across the knuckles, index -> pinky
  const D = ortho(spec.dorsal, F);                       // back of the hand
  const handLen = len(sub(midMcp, W));

  // ---- primitives: { kind, a, b, ra, rb, bone, part, up }  (round cones) and the palm slab
  const prims = [];
  const cone = (a, b, ra, rb, bone, part, up, extra = {}) => prims.push(Object.assign({ a, b, ra, rb, bone, part, up }, extra));
  // palm: knuckle bar, wrist bar (narrower, thicker), slab
  const kA = add(mcps[0], mul(Sk, -0.002)), kB = add(mcps[3], mul(Sk, 0.001));
  cone(add(kA, mul(D, -0.002)), add(kB, mul(D, -0.002)), 0.0098, 0.0090, 0, 'knuckle', D);
  const wristHalf = 0.011;          // must stay inside the gauntlet cuff (5.6 x 4.2 cm at the wrist)
  const wA = add(W, mul(Sk, -wristHalf)), wB = add(W, mul(Sk, wristHalf));
  cone(wA, wB, 0.0145, 0.0145, 0, 'wrist', D);
  const slab = {
    c: add(lerp3(W, midMcp, 0.52), mul(D, -0.0015)),
    ax: [F, Sk, D],
    h: [handLen * 0.5, len(sub(kB, kA)) * 0.5 + 0.004, 0.0125],
    r: 0.0105,
  };
  // thenar: from the wrist on the thumb side to the thumb's base joint
  const T = spec.thumb;
  const thenarA = add(add(W, mul(Sk, -0.006)), mul(D, -0.006));
  cone(thenarA, T[1], 0.0175, 0.0118, 13, 'thenar', spec.thumbDorsal);
  // thumb: base -> IP -> tip (+ rounded tip)
  const tw = (k) => (THUMB.w[k] + THUMB.h[k]) * 0.5;
  const tTip = add(T[3], mul(norm(sub(T[3], T[2])), tw(3) * 0.55));
  cone(T[1], T[2], tw(1) * 0.97, tw(2) * 0.95, 14, 'thumb', spec.thumbDorsal);
  cone(T[2], tTip, tw(2) * 0.95, tw(3) * 0.88, 15, 'thumb', spec.thumbDorsal);
  // fingers
  NAMES.forEach((n, i) => {
    const J = spec.fingers[n].joints.map((j) => j.p), U = spec.fingers[n].joints.map((j) => j.n), d = FINGER[n];
    const r = (k) => (d.w[k] * 0.55 + d.h[k] * 0.45) * 0.97;
    const tip = add(J[3], mul(norm(sub(J[3], J[2])), r(3) * 0.6));
    const bones = [1 + i * 3, 2 + i * 3, 3 + i * 3];
    // the proximal phalanx starts a little inside the knuckle bar so the base fuses
    const base = add(J[0], mul(norm(sub(J[0], J[1])), 0.004));
    cone(base, J[1], r(0), r(1), bones[0], 'f0', U[0], { finger: i });
    cone(J[1], J[2], r(1), r(2), bones[1], 'f1', U[1], { finger: i });
    cone(J[2], tip, r(2), r(3) * 0.92, bones[2], 'f2', U[2], { finger: i });
  });
  for (const p of prims) { p.c = lerp3(p.a, p.b, 0.5); p.R = len(sub(p.b, p.a)) / 2 + Math.max(p.ra, p.rb); }
  const slabR = len(slab.h) + 0.002;

  const cd = (p, x, y, z) => {
    const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
    const bd = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
    return bd > 0.02 ? bd : sdRoundCone(x, y, z, p.a, p.b, p.ra, p.rb);
  };
  const palmPrims = prims.filter((p) => p.part === 'knuckle' || p.part === 'wrist');
  const thenar = prims.find((p) => p.part === 'thenar');
  const thumbP = prims.filter((p) => p.part === 'thumb');
  const fingerP = prims.filter((p) => p.finger !== undefined);
  const gunClip = opts.gunClip ?? 0.0012;
  const avoid = opts.avoid || null;           // SDF of the other hand (support hand stays outside the strong one)

  function sdf(x, y, z) {
    // palm
    let dp = sdRoundBox(x, y, z, slab.c, slab.ax, slab.h, slab.r);
    for (const p of palmPrims) dp = smin(dp, cd(p, x, y, z), 0.012);
    dp = smin(dp, cd(thenar, x, y, z), 0.011);
    // thumb fused to the thenar
    let dt = 1e9;
    for (const p of thumbP) dt = Math.min(dt, cd(p, x, y, z));
    let d = smin(dp, dt, 0.007);
    // fingers: each chain is a plain union; only its base segment blends into the palm
    for (let i = 0; i < 4; i++) {
      const f0 = fingerP[i * 3], f1 = fingerP[i * 3 + 1], f2 = fingerP[i * 3 + 2];
      const d0 = cd(f0, x, y, z);
      const chain = Math.min(smin(d0, cd(f1, x, y, z), 0.003), cd(f2, x, y, z));
      d = Math.min(d, smin(dp, d0, 0.0075), chain);
    }
    // hard contact with the pistol and the other hand: the surface stops a small gap short of them (no smooth
    // blend, so hand and gun stay two objects with a visible contact line, never one melted mass)
    if (d < 0.012) {
      if (gunSDF) { const g = gunSDF(x, y, z); if (g < 0.012) d = smax(d, gunClip - g, 0.0008); }
      if (avoid) { const o = avoid(x, y, z); if (o < 0.012) d = smax(d, 0.0011 - o, 0.0016); }
    }
    return d;
  }

  // ---- polygonize
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const grow = (p, r) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k] - r); hi[k] = Math.max(hi[k], p[k] + r); } };
  for (const p of prims) { grow(p.a, p.ra + 0.004); grow(p.b, p.rb + 0.004); }
  grow(slab.c, slabR);
  const h = opts.h ?? 0.0023;
  const geom = surfaceNets(sdf, lo, hi, h, { project: 2 });

  // ---- per-vertex attributes: regions, stitch length, skin weights
  const pos = geom.attributes.position.array, nor = geom.attributes.normal.array;
  const n = pos.length / 3;
  const gl = new Float32Array(n * 4), ln = new Float32Array(n);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const boneOf = (p) => p.bone;
  const slabPrim = { bone: 0, part: 'palm', up: D };
  for (let v = 0; v < n; v++) {
    const P = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const N = [nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]];
    // nearest primitives by surface distance
    const ds = prims.map((p) => ({ p, d: cd(p, P[0], P[1], P[2]) }));
    ds.push({ p: slabPrim, d: sdRoundBox(P[0], P[1], P[2], slab.c, slab.ax, slab.h, slab.r) });
    ds.sort((a, b) => a.d - b.d);
    const near = ds[0].p;
    // skin weights: soft-min over the closest primitives' bones
    const acc = new Map();
    const sigma = 0.0028;
    for (let k = 0; k < Math.min(6, ds.length); k++) {
      const w = Math.exp(-(ds[k].d - ds[0].d) / sigma);
      if (w < 0.02) break;
      const b = boneOf(ds[k].p);
      acc.set(b, (acc.get(b) || 0) + w);
    }
    // the thenar's wrist end stays with the palm
    if (near.part === 'thenar') {
      const t = segDist(P, near.a, near.b).t;
      const w13 = acc.get(13) || 0;
      acc.set(13, w13 * t); acc.set(0, (acc.get(0) || 0) + w13 * (1 - t));
    }
    const ws = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ws.reduce((s, x) => s + x[1], 0) || 1;
    ws.forEach(([b, w], k) => { si[v * 4 + k] = b; sw[v * 4 + k] = w / sum; });
    // regions: leather on the palm side of everything and on the fingertips; rubber on the knuckle bar and the
    // back of the proximal phalanges (moulded guard); black stretch fabric elsewhere
    const up = near.up || D;
    const dorsalness = dot(N, up);
    let leather = 1 - clamp01((dorsalness + 0.25) / 0.3);
    let rubber = 0;
    if (near.part === 'f2') { const t = segDist(P, near.a, near.b).t; leather = Math.max(leather, clamp01((t - 0.55) / 0.2)); }
    if (near.part === 'thumb' && near.bone === 15) { const t = segDist(P, near.a, near.b).t; leather = Math.max(leather, clamp01((t - 0.5) / 0.25)); }
    if (near.part === 'knuckle' && dorsalness > 0.35) rubber = 1;
    if (near.part === 'f0' && dorsalness > 0.55) { const t = segDist(P, near.a, near.b).t; rubber = t > 0.25 && t < 0.8 ? 1 : 0; }
    gl[v * 4] = leather; gl[v * 4 + 1] = rubber;
    const sd = segDist(P, near.a || slab.c, near.b || slab.c);
    ln[v] = sd.t * len(sub(near.b || slab.c, near.a || slab.c));
  }
  geom.setAttribute('aGlove', new THREE.BufferAttribute(gl, 4));
  geom.setAttribute('aLen', new THREE.BufferAttribute(ln, 1));
  geom.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geom.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));

  // bones (same layout as the lofted hand)
  const bonesInfo = [];
  NAMES.forEach((nm, i) => {
    const J = spec.fingers[nm].joints;
    for (let k = 0; k < 3; k++) bonesInfo[1 + i * 3 + k] = { joint: J[k].p, parent: k === 0 ? 0 : i * 3 + k };
  });
  for (let k = 0; k < 3; k++) bonesInfo[13 + k] = { joint: T[k], parent: k === 0 ? 0 : 12 + k };
  return { geom, bonesInfo, body: { F, Sk, DD: D }, sdf };
}
