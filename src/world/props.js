// Visual prop construction.
// - Procedural machinery / furniture is merged into the level Batcher (one draw call per material key), built with
//   the detailing kit in propKit.js (chamfered parts, wheels, bolts, labels).
// - Small repeated items are InstancedMeshes (rollers, debris, bricks, papers, bolt heads).
// - Scanned/modelled CC0 props from Poly Haven (public/assets/models, scripts/models-assets.py) are placed as
//   InstancedMeshes once they have loaded (modelLoader.js); until then (or if loading fails) a simple fallback
//   stands in. Placements match the layout footprints so colliders, cover and nav data stay valid.
//
// Z-fighting rule: no two parts share a face plane where they overlap. Attached parts penetrate their parent by
// >= 1 cm or float >= 8 mm proud of it; adjacent parts that share a plane must not overlap (edge to edge only).
import * as THREE from 'three';
import { Batcher, rng } from './geometry.js';
import { Kit, TILE, makeLabelTexture, makePropMaterials, PROP_SCALES, PROP_SURFACES } from './propKit.js';
import { extraBuilders, dressAreas } from './propsExtra.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const ONE = new THREE.Vector3(1, 1, 1);
const M = (x, y, z, ry = 0, rx = 0, rz = 0, s = ONE) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), s);
const PI = Math.PI;

// Poly Haven models used as props. size = nominal size (for the fallback box if loading fails), key = fallback material.
// center: model origin at its bounding-box centre (freely rotated items), otherwise bottom centre.
// small: no shadow casting (tiny or very numerous items).
export const MODEL_INFO = {
  Barrel_01: { surface: 'metal', size: [0.56, 0.88, 0.56], key: 'barrel' },
  Barrel_02: { surface: 'metal', size: [0.48, 0.88, 0.48], key: 'paintBlue' },
  metal_office_desk: { surface: 'metal', size: [2.0, 0.79, 0.95], key: 'paintGrey' },
  SchoolChair_01: { surface: 'wood', size: [0.56, 1.0, 0.68], key: 'woodDark' },
  plastic_monobloc_chair_01: { surface: 'wood', size: [0.64, 0.88, 0.63], key: 'paintGrey' },
  steel_frame_shelves_01: { surface: 'metal', size: [1.1, 2.14, 0.5], key: 'steel' },
  worn_metal_rack: { surface: 'metal', size: [0.92, 1.9, 0.6], key: 'steel' },
  metal_tool_chest: { surface: 'metal', size: [0.69, 0.5, 0.31], key: 'paintRed' },
  old_tyre: { surface: 'concrete', size: [0.6, 0.6, 0.165], key: 'rubber', center: true },
  cement_bag: { surface: 'wood', size: [0.46, 0.18, 0.7], key: 'cardboard', small: true },
  WetFloorSign_01: { surface: 'wood', size: [0.3, 0.63, 0.36], key: 'yellow' },
  Television_01: { surface: 'metal', size: [0.6, 0.46, 0.47], key: 'dark' },
  plastic_crate_02: { surface: 'wood', size: [0.5, 0.25, 0.4], key: 'paintBlue', small: true },
  propane_tank: { surface: 'metal', size: [0.34, 0.55, 0.34], key: 'paintRed' },
  trashbag: { surface: 'wood', size: [0.53, 0.57, 0.46], key: 'rubber' },
  can_rusted: { surface: 'metal', size: [0.12, 0.15, 0.12], key: 'rust', small: true },
  bench_vice_01: { surface: 'metal', size: [0.2, 0.29, 0.4], key: 'steel', small: true },
  sledgehammer_01: { surface: 'metal', size: [0.2, 1.0, 0.09], key: 'steel', center: true },
  Drill_01: { surface: 'metal', size: [0.18, 0.18, 0.05], key: 'dark', small: true },
  plastic_jerrycan: { surface: 'wood', size: [0.27, 0.32, 0.34], key: 'paintRed' },
  hand_truck: { surface: 'metal', size: [0.6, 1.4, 0.7], key: 'dark' },
  utility_box_01: { surface: 'metal', size: [0.52, 1.12, 0.43], key: 'paintGrey' },
};

export function buildProps(B, layout, seed = 7) {
  const R = rng(seed);
  const rr = (a, b) => a + (b - a) * R();
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const K = new Kit(B, R);
  // second batcher for prop-only materials (cardboard, worn yellow paint); shares labels/bolts with K
  const PB = new Batcher({ ...B.scales, ...PROP_SCALES }, B.grime);
  const K2 = new Kit(PB, R);
  K2.labels = K.labels; K2.bolts = K.bolts; K2.glass = K.glass;
  const box = (min, max, mat, o) => B.box(min, max, mat, o);
  const cb = (min, max, key, o) => (PROP_SCALES[key] ? K2 : K).cbox(min, max, key, o);
  const lbl = (c, n, w, h, tile, o) => K.label(c, n, w, h, tile, o);
  const inst = { rollers: [], debris: [], papers: [], bricks: [], models: [] };
  // model placement: s = uniform scale or [sx, sy, sz]
  const model = (id, x, y, z, o = {}) => {
    inst.models.push({ id, x, y, z, ry: o.ry ?? R() * PI * 2, rx: o.rx ?? 0, rz: o.rz ?? 0, s: o.s ?? 1, variant: o.variant ?? null, tint: o.tint ?? 1 });
  };
  const postSeen = [];
  const doorCenters = layout.doors.map((d) => d.center);
  const nearDoor = (x, z, r = 1.3) => doorCenters.some(([dx, dz]) => Math.hypot(dx - x, dz - z) < r);

  // ---------------------------------------------------------------- shared part builders
  // Handle bar on standoffs. a,b = ends on the surface, n = outward normal.
  const handle = (a, b, n, r = 0.009, key = 'steel') => {
    const off = 0.035;
    const A = [a[0] + n[0] * off, a[1] + n[1] * off, a[2] + n[2] * off], Bp = [b[0] + n[0] * off, b[1] + n[1] * off, b[2] + n[2] * off];
    K.pipe(key, [a[0] - n[0] * 0.01, a[1] - n[1] * 0.01, a[2] - n[2] * 0.01], A, r * 0.9, { segs: 6 });
    K.pipe(key, [b[0] - n[0] * 0.01, b[1] - n[1] * 0.01, b[2] - n[2] * 0.01], Bp, r * 0.9, { segs: 6 });
    K.pipe(key, A, Bp, r, { segs: 8 });
  };
  // Round gauge with steel bezel. c on the surface, n outward axis-aligned normal.
  const gauge = (c, n, r = 0.06) => {
    const e = [c[0] + n[0] * 0.035, c[1] + n[1] * 0.035, c[2] + n[2] * 0.035];
    K.pipe('steel', [c[0] - n[0] * 0.01, c[1] - n[1] * 0.01, c[2] - n[2] * 0.01], e, r, { segs: 14 });
    lbl(e, n, r * 1.85, r * 1.85, TILE.gauge, { k: 1, offset: 0.004 });
  };
  // Mushroom emergency stop on a yellow collar.
  const estop = (c, n) => {
    const p = (d) => [c[0] + n[0] * d, c[1] + n[1] * d, c[2] + n[2] * d];
    lbl(c, n, 0.12, 0.12, TILE.estop, { k: 1 });
    K.pipe('dark', p(-0.01), p(0.03), 0.018, { segs: 8 });
    K.pipe('paintRed', p(0.03), p(0.055), 0.032, { segs: 12, tint: 1.3 });
  };
  // Hand wheel (torus + spokes + knob) facing along axis n at c.
  const handwheel = (c, n, r = 0.09) => {
    const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), v3(...n));
    const m = new THREE.Matrix4().compose(v3(...c), q, ONE);
    K.geo('steel', new THREE.TorusGeometry(r, 0.011, 6, 18), m);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * PI * 2;
      const e = v3(Math.cos(a) * r, Math.sin(a) * r, 0).applyMatrix4(m);
      K.pipe('steel', c, [e.x, e.y, e.z], 0.006, { segs: 5 });
    }
    const k0 = v3(r, 0, 0).applyMatrix4(m), k1 = v3(r, 0, 0.07).applyMatrix4(m);
    K.pipe('dark', [k0.x, k0.y, k0.z], [k1.x, k1.y, k1.z], 0.012, { segs: 6 });
    K.pipe('steel', [c[0] - n[0] * 0.08, c[1] - n[1] * 0.08, c[2] - n[2] * 0.08], c, 0.018, { segs: 8 });
  };
  // Flexible hose / cable through a list of points (smoothed polyline of pipes).
  const hose = (pts, r, key = 'rubber') => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => v3(...p)));
    const n = Math.max(4, Math.round(curve.getLength() / 0.15));
    const sp = curve.getPoints(n);
    for (let i = 0; i < sp.length - 1; i++) K.pipe(key, sp[i].toArray(), sp[i + 1].toArray(), r, { segs: 6, caps: false, rows: 2 });
  };
  // Cardboard carton with tape. (x,z) centre, y bottom.
  const carton = (x, y, z, w, h, d, ry = 0, tint = rr(0.65, 1.05), o = {}) => {
    const m = M(x, y, z, ry, o.rx ?? 0, o.rz ?? 0);
    cb([-w / 2, 0, -d / 2], [w / 2, h, d / 2], 'cardboard', { matrix: m, r: 0.008, tint });
    if (o.tape !== false) {
      cb([-0.028, h - 0.01, -d / 2 - 0.009], [0.028, h + 0.009, d / 2 + 0.009], 'cardboard', { matrix: m, r: 0.002, tint: tint * 1.4 });
    }
    if (R() < 0.45 && w > 0.25) {
      const p = v3(w * 0.15, h * 0.55, d / 2).applyMatrix4(m), nn = v3(0, 0, 1).transformDirection(m);
      lbl(p.toArray(), nn.toArray(), 0.1, 0.13, TILE.notice, { k: 0.8 });
    }
  };
  // Euro pallet with its lower-left corner at (x0, y, z0), 1.2 along x, 0.8 along z.
  const palletAt = (x0, y, z0, o = {}) => {
    const tint = o.tint ?? rr(0.62, 1.05), broken = o.broken ?? R() < 0.22;
    for (const k of [0, 0.35, 0.7]) box([x0, y, z0 + k], [x0 + 1.2, y + 0.022, z0 + k + 0.1], 'wood', { tint: tint * rr(0.8, 1.05), seg: 2 });
    for (const a of [0, 0.5275, 1.055]) for (const k of [0, 0.3275, 0.655]) {
      box([x0 + a, y + 0.022, z0 + k], [x0 + a + 0.145, y + 0.1, z0 + k + 0.145], 'woodDark', { tint: tint * 0.9, seg: 1 });
    }
    for (const a of [0, 0.5275, 1.055]) box([x0 + a, y + 0.1, z0], [x0 + a + 0.145, y + 0.122, z0 + 0.8], 'wood', { tint: tint * 0.85, seg: 2 });
    const tops = [[0, 0.145], [0.1825, 0.1], [0.3275, 0.145], [0.5175, 0.1], [0.655, 0.145]];
    const miss = broken ? 1 + Math.floor(R() * 3) : -1;
    tops.forEach(([k, w], i) => {
      if (i === miss) {
        // snapped board: one half still nailed, sagging
        const m = M(x0 + 0.3, y + 0.133, z0 + k + w / 2, 0, 0, -0.12);
        cb([-0.3, -0.011, -w / 2], [0.3, 0.011, w / 2], 'wood', { matrix: m, r: 0.003, tint: tint * 0.8 });
        return;
      }
      box([x0, y + 0.122, z0 + k], [x0 + 1.2, y + 0.144, z0 + k + w], 'wood', { tint: tint * rr(0.85, 1.12), seg: 2 });
    });
  };
  // Cement sack load on a pallet top (y = pallet top), 3 layers.
  const cementLoad = (cx, y, cz, layers = 3) => {
    for (let l = 0; l < layers; l++) {
      const yy = y + l * 0.175;
      if (l % 2 === 0) for (const dx of [-0.4, 0, 0.4]) model('cement_bag', cx + dx + rr(-0.02, 0.02), yy, cz + rr(-0.03, 0.03), { ry: rr(-0.06, 0.06), s: [0.9, 1, 1.05], tint: rr(0.8, 1.05) });
      else for (const dx of [-0.31, 0.31]) for (const dz of [-0.2, 0.2]) model('cement_bag', cx + dx, yy, cz + dz + rr(-0.02, 0.02), { ry: PI / 2 + rr(-0.06, 0.06), s: [0.9, 1, 0.88], tint: rr(0.8, 1.05) });
    }
  };
  const boxLoad = (cx, y, cz) => {
    for (let l = 0; l < 3; l++) for (const dx of [-0.3, 0.3]) for (const dz of [-0.2, 0.2]) {
      if (l === 2 && R() < 0.3) continue;
      carton(cx + dx, y + l * 0.3, cz + dz, 0.57, 0.295, 0.38, rr(-0.02, 0.02), rr(0.7, 0.95), { tape: R() < 0.5 });
    }
    // strapping bands
    for (const dx of [-0.32, 0.32]) {
      box([cx + dx - 0.012, y + 0.895, cz - 0.4], [cx + dx + 0.012, y + 0.905, cz + 0.4], 'dark');
    }
  };
  // Shrink-wrapped carton block (one part: used for high rack levels where the detail cannot be seen anyway).
  const blockLoad = (cx, y, cz) => {
    const h = rr(0.55, 1.0), t = rr(0.6, 0.95);
    cb([cx - 0.56, y, cz - 0.38], [cx + 0.56, y + h, cz + 0.38], 'cardboard', { r: 0.03, tint: t });
    for (const dx of [-0.3, 0.3]) box([cx + dx - 0.012, y + h - 0.004, cz - 0.39], [cx + dx + 0.012, y + h + 0.012, cz + 0.39], 'dark');
    if (R() < 0.5) lbl([cx + rr(-0.3, 0.3), y + h * 0.5, cz + 0.381], [0, 0, 1], 0.16, 0.2, TILE.notice, { k: 0.8 });
  };
  // Cheap stand-ins for rack and shelf loads (hundreds of them: models would cost thousands of triangles each).
  const sackLoad = (cx, y, cz, layers = 2) => {
    for (let l = 0; l < layers; l++) for (let i = 0; i < 3; i++) {
      const yy = y + l * 0.17, t = rr(0.75, 1.0);
      if (l % 2 === 0) cb([cx - 0.58 + i * 0.39, yy, cz - 0.34], [cx - 0.21 + i * 0.39, yy + 0.16, cz + 0.34], 'paper', { r: 0.05, color: [0.62 * t, 0.58 * t, 0.5 * t] });
      else if (i < 2) cb([cx - 0.56, yy, cz - 0.36 + i * 0.37], [cx + 0.56, yy + 0.16, cz - 0.02 + i * 0.37], 'paper', { r: 0.05, color: [0.6 * t, 0.56 * t, 0.48 * t] });
    }
  };
  const crateCheap = (x, y, z, ry = 0) => {
    const m = M(x, y, z, ry);
    cb([-0.25, 0, -0.2], [0.25, 0.24, 0.2], 'paintBlue', { matrix: m, r: 0.012, tint: rr(0.6, 0.9) });
  };
  const drumCheap = (x, y, z, key = 'paintBlue') => {
    B.cylinder(key, [x, y, z], 0.28, 0.86, { segs: 14, rows: 2, tint: rr(0.6, 0.9) });
    for (const h of [0.28, 0.58]) B.cylinder(key, [x, y + h, z], 0.29, 0.03, { segs: 14, rows: 2, caps: false, tint: 0.7 });
  };
  // Corrugated sheet (trapezoidal profile) on a vertical plane. axis 'x': runs along x at z=t, faces sz; 'z': along z at x=t.
  const corrugated = (key, axis, t, s, a0, a1, y0, y1, o = {}) => {
    const p = o.pitch ?? 0.28, d = o.depth ?? 0.036;
    const prof = [];
    for (let u = a0; u < a1 - 1e-6; u += p) {
      const q = Math.min(p, a1 - u);
      for (const [f, dd] of [[0, 0], [0.22, 0], [0.32, 1], [0.68, 1], [0.78, 0]]) if (f * p <= q) prof.push([u + f * p, dd]);
    }
    prof.push([a1, 0]);
    const rows = o.rows ?? 3;
    for (let i = 0; i < prof.length - 1; i++) {
      const [u0, d0] = prof[i], [u1, d1] = prof[i + 1];
      if (u1 - u0 < 1e-5) continue;
      for (let r = 0; r < rows; r++) {
        const ya = y0 + (y1 - y0) * r / rows, yb = y0 + (y1 - y0) * (r + 1) / rows;
        const P = (u, dd, y) => (axis === 'x' ? [u, y, t - s * dd * d] : [t - s * dd * d, y, u]);
        K.poly(key, [P(u0, d0, ya), P(u1, d1, ya), P(u1, d1, yb), P(u0, d0, yb)], axis === 'x' ? [0, 0, s] : [s, 0, 0], { tint: o.tint });
      }
    }
  };
  // Cargo-style double doors with locking bars, on the plane x = t facing sx (axis 'z' spans z0..z1).
  const cargoDoors = (key, t, sx, z0, z1, y0, y1, o = {}) => {
    const zm = (z0 + z1) / 2, tint = o.tint ?? 1;
    const inner = t - sx * 0.05;
    for (const [a, b] of [[z0, zm - 0.008], [zm + 0.008, z1]]) {
      cb(sx > 0 ? [inner, y0, a] : [t, y0, a], sx > 0 ? [t, y1, b] : [inner, y1, b], key, { r: 0.012, tint });
      // horizontal stiffening ribs
      for (let k = 1; k <= 3; k++) {
        const y = y0 + (y1 - y0) * k / 4;
        cb(sx > 0 ? [t - 0.01, y - 0.04, a + 0.05] : [t - 0.02, y - 0.04, a + 0.05], sx > 0 ? [t + 0.02, y + 0.04, b - 0.05] : [t + 0.01, y + 0.04, b - 0.05], key, { r: 0.01, tint: tint * 0.95 });
      }
      // two locking bars per leaf
      for (const f of [0.22, 0.7]) {
        const z = a + (b - a) * f, x = t + sx * 0.045;
        K.pipe('steel', [x, y0 + 0.08, z], [x, y1 - 0.08, z], 0.017, { segs: 8, tint: 0.7 });
        for (const y of [y0 + 0.15, y1 - 0.15, y0 + (y1 - y0) * 0.45]) cb(sx > 0 ? [t - 0.01, y - 0.03, z - 0.04] : [t - 0.045, y - 0.03, z - 0.04], sx > 0 ? [t + 0.045, y + 0.03, z + 0.04] : [t + 0.01, y + 0.03, z + 0.04], 'steel', { r: 0.006, tint: 0.6 });
        // handle
        const yh = y0 + (y1 - y0) * 0.42;
        K.pipe('steel', [x, yh, z], [x + sx * 0.03, yh, z + (f < 0.5 ? 0.22 : -0.22)], 0.012, { segs: 6, tint: 0.7 });
      }
      // hinges on the outer edges
      const he = a === z0 ? z0 + 0.04 : z1 - 0.04;
      for (let k = 0; k < 4; k++) {
        const y = y0 + 0.25 + k * (y1 - y0 - 0.5) / 3;
        cb([t - (sx > 0 ? 0.01 : 0.04), y - 0.05, he - 0.025], [t + (sx > 0 ? 0.04 : 0.01), y + 0.05, he + 0.025], 'steel', { r: 0.008, tint: 0.55 });
      }
    }
  };

  const builders = {
    // ------------------------------------------------------------ crates: planked sides, frame, diagonal braces
    crate(p) {
      const [x0, y0, z0] = p.min, [x1, y1, z1] = p.max, tint = rr(0.7, 1.05);
      const f = 0.022, pl = 0.018, inset = f + pl;
      box([x0 + inset + 0.004, y0 + 0.003, z0 + inset + 0.004], [x1 - inset - 0.004, y1 - pl - 0.004, z1 - inset - 0.004], 'woodDark', { tint: 0.32 });
      // corner posts
      for (const [a, b] of [[x0, z0], [x1 - inset, z0], [x0, z1 - inset], [x1 - inset, z1 - inset]]) cb([a, y0, b], [a + inset, y1, b + inset], 'woodDark', { r: 0.005, tint: tint * 0.9 });
      const H = y1 - y0, nP = Math.max(3, Math.round(H / 0.15)), ph = H / nP;
      // side planks (in the slab between frame and core), 1.2 cm gaps
      for (let i = 0; i < nP; i++) {
        const ya = y0 + i * ph + 0.006, yb = y0 + (i + 1) * ph - 0.006, t = tint * rr(0.82, 1.1);
        box([x0 + inset, ya, z0 + f], [x1 - inset, yb, z0 + inset], 'wood', { tint: t, seg: 2 });
        box([x0 + inset, ya, z1 - inset], [x1 - inset, yb, z1 - f], 'wood', { tint: t * rr(0.9, 1.1), seg: 2 });
        box([x0 + f, ya, z0 + inset], [x0 + inset, yb, z1 - inset], 'wood', { tint: t * rr(0.9, 1.1), seg: 2 });
        box([x1 - inset, ya, z0 + inset], [x1 - f, yb, z1 - inset], 'wood', { tint: t * rr(0.9, 1.1), seg: 2 });
      }
      // lid planks
      const nL = Math.max(3, Math.round((x1 - x0 - 2 * inset) / 0.16));
      const lw = (x1 - x0 - 2 * inset) / nL;
      for (let i = 0; i < nL; i++) box([x0 + inset + i * lw + 0.005, y1 - pl, z0 + inset], [x0 + inset + (i + 1) * lw - 0.005, y1, z1 - inset], 'wood', { tint: tint * rr(0.85, 1.1), seg: 2 });
      // frame bands + diagonal brace per side (proud of the planks)
      const bandH = Math.min(0.1, H * 0.12);
      const sides = [
        { n: [0, 0, -1], A: (u, y) => [u, y, z0], span: [x0 + inset, x1 - inset] },
        { n: [0, 0, 1], A: (u, y) => [u, y, z1], span: [x0 + inset, x1 - inset] },
        { n: [-1, 0, 0], A: (u, y) => [x0, y, u], span: [z0 + inset, z1 - inset] },
        { n: [1, 0, 0], A: (u, y) => [x1, y, u], span: [z0 + inset, z1 - inset] },
      ];
      for (const s of sides) {
        const [u0, u1] = s.span;
        // outermost layer (thickness f) of this side, spanning ua..ub along the side
        const slab = (ua, ub, ya, yb) => {
          const isZ = s.n[2] !== 0;
          const t0 = isZ ? (s.n[2] > 0 ? z1 - f : z0) : (s.n[0] > 0 ? x1 - f : x0);
          const mn = isZ ? [ua, ya, t0] : [t0, ya, ua], mx = isZ ? [ub, yb, t0 + f] : [t0 + f, yb, ub];
          cb(mn, mx, 'woodDark', { r: 0.004, tint: tint * rr(0.8, 0.95) });
        };
        slab(u0, u1, y0, y0 + bandH); slab(u0, u1, y1 - bandH, y1 - 0.002);
        // diagonal brace (rotated board between the bands)
        const L = Math.hypot(u1 - u0, H - 2 * bandH), ang = Math.atan2(H - 2 * bandH, u1 - u0);
        const c = s.A((u0 + u1) / 2, (y0 + y1) / 2);
        const yaw = s.n[0] !== 0 ? (s.n[0] > 0 ? -PI / 2 : PI / 2) : (s.n[2] > 0 ? 0 : PI);
        const m = M(c[0] - s.n[0] * f / 2, c[1], c[2] - s.n[2] * f / 2, yaw, 0, (s.n[0] > 0 || s.n[2] < 0 ? -1 : 1) * ang);
        cb([-L / 2 + 0.03, -0.045, -f / 2 + 0.002], [L / 2 - 0.03, 0.045, f / 2 - 0.002], 'woodDark', { matrix: m, r: 0.004, tint: tint * 0.85 });
      }
      if (R() < 0.35) lbl([(x0 + x1) / 2, y0 + H * 0.55, z1 + 0.001], [0, 0, 1], Math.min(0.5, (x1 - x0) * 0.5), Math.min(0.5, (x1 - x0) * 0.5), TILE.stencil, { k: 0.45 });
    },
    pallets(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      for (let i = 0; i < p.n; i++) {
        const dx = rr(-0.035, 0.035), dz = rr(-0.035, 0.035);
        palletAt(cx - 0.6 + dx, i * 0.144, cz - 0.4 + dz);
      }
      const top = p.n * 0.144;
      if (p.load === 'cement') cementLoad(cx, top, cz);
      if (p.load === 'boxes') boxLoad(cx, top, cz);
    },
    barrel(p) {
      const c = [(p.min[0] + p.max[0]) / 2, 0, (p.min[2] + p.max[2]) / 2];
      const r = R();
      if (r < 0.22) model('Barrel_02', c[0], 0, c[2], { s: rr(0.97, 1.03), tint: rr(0.75, 1.0) });
      else model('Barrel_01', c[0], 0, c[2], { s: rr(0.97, 1.03), variant: r < 0.4 ? null : r < 0.72 ? 'oxide_green' : 'oxide_grey', tint: rr(0.8, 1.05) });
      if (R() < 0.3) model('can_rusted', c[0] + rr(-0.1, 0.1), 0.88, c[2] + rr(-0.1, 0.1), { s: rr(0.9, 1.2) });
    },

    // ------------------------------------------------------------ conveyor
    conveyor(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, zc = (z0 + z1) / 2;
      // C-channel side frames
      for (const [za, zb, s] of [[z0, z0 + 0.09, -1], [z1 - 0.09, z1, 1]]) {
        cb([x0, y1 - 0.21, za], [x1, y1 - 0.04, zb], 'paint', { r: 0.012 });
        K.stripes([x0 + 0.01, y1 - 0.125, s > 0 ? zb : za], [x0 + 0.6, y1 - 0.125, s > 0 ? zb : za], [0, 0, s], 0.13, { k: 0.75 });
        K.stripes([x1 - 0.6, y1 - 0.125, s > 0 ? zb : za], [x1 - 0.01, y1 - 0.125, s > 0 ? zb : za], [0, 0, s], 0.13, { k: 0.75 });
        K.boltRow([x0 + 0.2, y1 - 0.08, s > 0 ? zb : za], [x1 - 0.2, y1 - 0.08, s > 0 ? zb : za], [0, 0, s], 26, 0.8);
      }
      // legs, feet, cross ties and diagonal braces
      for (let x = x0 + 0.15; x < x1 - 0.05; x += 1.6) {
        for (const [za, zb] of [[z0 + 0.01, z0 + 0.08], [z1 - 0.08, z1 - 0.01]]) {
          cb([x, 0.012, za], [x + 0.07, y1 - 0.2, zb], 'steel', { r: 0.008 });
          cb([x - 0.04, 0, za - 0.005], [x + 0.11, 0.014, zb + 0.005], 'steel', { r: 0.003, tint: 0.7 });
          K.bolt([x - 0.02, 0.014, (za + zb) / 2], [0, 1, 0], 1.1); K.bolt([x + 0.09, 0.014, (za + zb) / 2], [0, 1, 0], 1.1);
        }
        cb([x + 0.005, 0.26, z0 + 0.08], [x + 0.065, 0.32, z1 - 0.08], 'steel', { r: 0.006 });
        const L = Math.hypot(z1 - z0 - 0.2, y1 - 0.62), a = Math.atan2(y1 - 0.62, z1 - z0 - 0.2);
        const m = M(x + 0.035, 0.32 + (y1 - 0.62) / 2, zc, 0, a, 0);
        cb([-0.012, -0.02, -L / 2], [0.012, 0.02, L / 2], 'steel', { matrix: m, r: 0.004, tint: 0.85 });
      }
      for (let x = x0 + 0.15; x < x1 - 0.1; x += 0.26) inst.rollers.push([x, y1 - 0.12, zc, z1 - z0 - 0.19]);
      // remaining belt section (worn rubber) over the rollers
      box([x0 + 4, y1 - 0.069, z0 + 0.1], [x0 + 8.5, y1 - 0.05, z1 - 0.1], 'rubber', { seg: 2 });
      // drive: motor + gearbox + chain guard hung under the frame at the east end
      const dx = x1 - 0.95;
      const mm = M(dx, 0.52, zc, 0, 0, PI / 2);
      K.lathe('paint', [[0.001, -0.26], [0.13, -0.26], [0.14, -0.22], [0.14, 0.18], [0.12, 0.22], [0.001, 0.22]], mm, { segs: 16, tint: 0.8 });
      for (let k = -0.2; k < 0.17; k += 0.045) K.lathe('paint', [[0.13, k], [0.155, k + 0.008], [0.155, k + 0.018], [0.13, k + 0.026]], mm, { segs: 16, tint: 0.75 });
      cb([dx + 0.2, 0.33, zc - 0.17], [dx + 0.55, 0.7, zc + 0.17], 'paint', { r: 0.025, tint: 0.9 });
      cb([dx + 0.3, 0.68, zc - 0.12], [dx + 0.48, y1 - 0.2, zc + 0.12], 'yellow', { r: 0.02 });
      lbl([dx + 0.375, 0.6, zc + 0.17], [0, 0, 1], 0.2, 0.2, TILE.warnCrush, { k: 0.9 });
      cb([dx - 0.25, 0.28, zc - 0.2], [dx + 0.6, 0.33, zc + 0.2], 'steel', { r: 0.01 });
      hose([[dx - 0.2, 0.6, zc + 0.1], [dx - 0.5, 0.35, zc + 0.3], [dx - 0.9, 0.04, zc + 0.35], [dx - 2.5, 0.025, zc + 0.6]], 0.012);
      // pull-cord stop line on stanchions along the south side
      for (let x = x0 + 0.5; x < x1; x += 2.4) {
        cb([x - 0.012, y1 - 0.06, z1 - 0.06], [x + 0.012, y1 + 0.22, z1 - 0.036], 'yellow', { r: 0.004 });
      }
      K.pipe('yellow', [x0 + 0.5, y1 + 0.18, z1 - 0.048], [x1 - 0.3, y1 + 0.18, z1 - 0.048], 0.005, { segs: 5 });
      // control box with e-stop on the west legs
      cb([x0 + 0.24, 0.55, z1 - 0.01], [x0 + 0.56, 0.86, z1 + 0.11], 'paintGrey', { r: 0.015 });
      estop([x0 + 0.32, 0.7, z1 + 0.11], [0, 0, 1]);
      lbl([x0 + 0.48, 0.73, z1 + 0.11], [0, 0, 1], 0.1, 0.1, TILE.panel, { k: 1 });
      hose([[x0 + 0.4, 0.55, z1 + 0.05], [x0 + 0.42, 0.2, z1 + 0.02], [x0 + 0.8, 0.02, z1 - 0.2], [x0 + 2.0, 0.02, z1 - 0.3]], 0.01);
      // abandoned cartons on the line
      carton(x0 + 1.3, y1 - 0.075, zc - 0.1, 0.5, 0.36, 0.42, 0.15);
      carton(x0 + 9.9, y1 - 0.075, zc + 0.05, 0.62, 0.42, 0.5, -0.1);
      carton(x0 + 10.0, y1 + 0.345, zc + 0.02, 0.4, 0.3, 0.36, 0.5, rr(0.6, 0.8));
      carton(x0 + 5.6, y1 - 0.05, zc, 0.44, 0.3, 0.4, 1.0);
      lbl([x0 + 0.05, y1 - 0.125, zc], [-1, 0, 0], 0.3, 0.3, TILE.number, { u0: 0, u1: 0.25 });
    },

    // ------------------------------------------------------------ hydraulic straight-side press
    press(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      cb([x0, 0, z0], [x1, 0.14, z1], 'ceiling', { r: 0.03, tint: 0.85 });                // concrete plinth
      for (const [a, b] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.05, z0 + 0.05], [x0 + 0.05, z1 - 0.05], [x1 - 0.05, z1 - 0.05]]) K.bolt([a, 0.14, b], [0, 1, 0], 2);
      cb([x0 + 0.09, 0.13, z0 + 0.09], [x1 - 0.09, 0.95, z1 - 0.09], 'paint', { r: 0.05 }); // bed
      cb([x0 + 0.05, 0.8, z0 + 0.05], [x1 - 0.05, 0.92, z1 - 0.05], 'paint', { r: 0.02, tint: 0.85 });   // bed flange
      cb([x0 + 0.55, 0.94, z0 + 0.5], [x1 - 0.55, 1.08, z1 - 0.5], 'steel', { r: 0.015, tint: 0.85 });    // bolster
      for (let x = x0 + 0.8; x < x1 - 0.7; x += 0.38) cb([x, 1.07, z0 + 0.52], [x + 0.04, 1.09, z1 - 0.52], 'dark', { r: 0.004 });
      cb([x0 + 0.88, 1.07, z0 + 0.72], [x1 - 0.88, 1.32, z1 - 0.72], 'steel', { r: 0.02, tint: 0.7 });    // lower die
      // uprights (front/back pairs) with outer ribs
      for (const [xa, xb, s] of [[x0 + 0.12, x0 + 0.62, -1], [x1 - 0.62, x1 - 0.12, 1]]) {
        for (const [za, zb] of [[z0 + 0.32, z0 + 0.92], [z1 - 0.92, z1 - 0.32]]) {
          cb([xa, 0.9, za], [xb, y1 - 0.78, zb], 'paint', { r: 0.04 });
          const xr = s < 0 ? xa : xb;
          cb(s < 0 ? [xr - 0.07, 1.0, (za + zb) / 2 - 0.04] : [xr - 0.01, 1.0, (za + zb) / 2 - 0.04], s < 0 ? [xr + 0.01, y1 - 0.9, (za + zb) / 2 + 0.04] : [xr + 0.07, y1 - 0.9, (za + zb) / 2 + 0.04], 'paint', { r: 0.012, tint: 0.92 });
          lbl([(xa + xb) / 2, 2.6, zb], [0, 0, 1], 0.3, 0.9, TILE.rust, { k: 0.8 });
        }
        // gibs / guide plates on the inner face
        cb(s < 0 ? [xb - 0.01, 1.4, cz - 0.3] : [xa - 0.05, 1.4, cz - 0.3], s < 0 ? [xb + 0.05, y1 - 0.9, cz + 0.3] : [xa + 0.01, y1 - 0.9, cz + 0.3], 'steel', { r: 0.008, tint: 0.6 });
      }
      // crown with ribs and the main cylinder
      cb([x0 + 0.05, y1 - 0.86, z0 + 0.2], [x1 - 0.05, y1, z1 - 0.2], 'paint', { r: 0.06 });
      for (const xr of [x0 + 0.5, cx, x1 - 0.5]) for (const [s, zz] of [[1, z1 - 0.2], [-1, z0 + 0.2]]) {
        cb([xr - 0.04, y1 - 0.83, s > 0 ? zz - 0.01 : zz - 0.09], [xr + 0.04, y1 - 0.05, s > 0 ? zz + 0.09 : zz + 0.01], 'paint', { r: 0.012, tint: 0.92 });
      }
      K.boltRow([x0 + 0.2, y1 - 0.12, z1 - 0.2], [x1 - 0.2, y1 - 0.12, z1 - 0.2], [0, 0, 1], 12, 1.3);
      K.boltRow([x0 + 0.2, y1 - 0.74, z1 - 0.2], [x1 - 0.2, y1 - 0.74, z1 - 0.2], [0, 0, 1], 12, 1.3);
      lbl([cx - 0.75, y1 - 0.43, z1 - 0.2], [0, 0, 1], 0.6, 0.6, TILE.plate, { k: 0.95 });
      lbl([cx + 0.75, y1 - 0.43, z1 - 0.2], [0, 0, 1], 0.6, 0.6, TILE.maker, { k: 0.95 });
      const cm = M(cx, y1 - 0.02, cz);
      K.lathe('steel', [[0.001, 0], [0.44, 0], [0.44, 0.07], [0.37, 0.09], [0.37, 0.52], [0.41, 0.54], [0.41, 0.61], [0.2, 0.63], [0.001, 0.63]], cm, { segs: 24, tint: 0.75 });
      for (let i = 0; i < 12; i++) { const a = i / 12 * PI * 2; K.bolt([cx + Math.cos(a) * 0.4, y1 + 0.05, cz + Math.sin(a) * 0.4], [0, 1, 0], 1.6); }
      // slide (ram), upper die, piston rods
      cb([x0 + 0.68, 1.95, z0 + 0.5], [x1 - 0.68, 2.65, z1 - 0.5], 'paint', { r: 0.03, tint: 0.88 });
      cb([x0 + 0.82, 1.75, z0 + 0.68], [x1 - 0.82, 1.96, z1 - 0.68], 'steel', { r: 0.02, tint: 0.7 });
      K.stripes([x0 + 0.72, 2.3, z1 - 0.5], [x1 - 0.72, 2.3, z1 - 0.5], [0, 0, 1], 0.32, { k: 0.85 });
      K.stripes([x0 + 0.15, 0.5, z1 - 0.09], [x1 - 0.15, 0.5, z1 - 0.09], [0, 0, 1], 0.22, { k: 0.7 });
      for (const dx of [-0.5, 0.5]) B.cylinder('steel', [cx + dx, 2.64, cz], 0.13, y1 - 3.48, { caps: false, segs: 16 });
      // light-curtain posts at the front corners
      for (const x of [x0 + 0.62, x1 - 0.66]) {
        cb([x, 0.94, z1 - 0.3], [x + 0.045, 2.25, z1 - 0.255], 'yellow', { r: 0.008 });
        cb([x + 0.008, 1.2, z1 - 0.256], [x + 0.037, 2.1, z1 - 0.244], 'dark', { r: 0.003 });
      }
      lbl([x0 + 0.37, 1.65, z1 - 0.32], [0, 0, 1], 0.32, 0.32, TILE.warnCrush, { k: 0.95 });
      // control cabinet on the east upright + hoses up to the crown
      const zc = z1 - 0.62;
      cb([x1 - 0.115, 1.15, zc - 0.35], [x1 - 0.01, 1.95, zc + 0.35], 'paintGrey', { r: 0.015 });
      lbl([x1 - 0.01, 1.62, zc + 0.1], [1, 0, 0], 0.32, 0.32, TILE.panel, { k: 1 });
      estop([x1 - 0.01, 1.33, zc - 0.15], [1, 0, 0]);
      gauge([x1 - 0.01, 1.8, zc - 0.18], [1, 0, 0], 0.055);
      lbl([x1 - 0.01, 1.78, zc + 0.15], [1, 0, 0], 0.16, 0.16, TILE.warnVolt, { k: 1 });
      hose([[x1 - 0.06, 1.95, zc], [x1 - 0.04, 2.5, zc + 0.05], [x1 - 0.08, y1 - 0.6, zc + 0.1], [x1 - 0.3, y1 - 0.4, z1 - 0.18]], 0.022);
      hose([[x1 - 0.1, 1.95, zc - 0.2], [x1 - 0.02, 2.7, zc - 0.25], [x1 - 0.1, y1 - 0.5, zc - 0.3]], 0.016);
      K.pipe('steel', [x0 + 0.3, y1 + 0.03, z0 + 0.3], [x1 - 0.3, y1 + 0.03, z0 + 0.3], 0.03, { segs: 8 });
      K.pipe('steel', [x1 - 0.3, y1 + 0.03, z0 + 0.3], [x1 - 0.3, y1 + 0.03, cz], 0.03, { segs: 8 });
      lbl([x0 + 0.3, 0.45, z1 - 0.09], [0, 0, 1], 0.5, 0.7, 14, { k: 0.7 });
    },

    // ------------------------------------------------------------ milling machine
    mill(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      cb([x0 + 0.06, 0, z0 + 0.06], [x1 - 0.06, 0.82, z1 - 0.06], 'paint', { r: 0.04 });          // base cabinet
      box([x0 + 0.1, 0, z0 + 0.1], [x1 - 0.1, 0.055, z1 - 0.1], 'dark', { seg: 2 });               // shadow plinth
      cb([x0 + 0.02, 0.78, z1 - 0.09], [x1 - 0.02, 0.95, z1 - 0.02], 'steel', { r: 0.01, tint: 0.75 }); // chip tray rails
      cb([x0 + 0.02, 0.78, z0 + 0.02], [x1 - 0.02, 0.95, z0 + 0.09], 'steel', { r: 0.01, tint: 0.75 });
      cb([x0 + 0.02, 0.78, z0 + 0.09], [x0 + 0.09, 0.95, z1 - 0.09], 'steel', { r: 0.01, tint: 0.75 });
      cb([x1 - 0.09, 0.78, z0 + 0.09], [x1 - 0.02, 0.95, z1 - 0.09], 'steel', { r: 0.01, tint: 0.75 });
      lbl([x0 + 0.5, 0.45, z1 - 0.06], [0, 0, 1], 0.5, 0.5, TILE.maker, { k: 0.9 });
      lbl([x1 - 0.5, 0.45, z1 - 0.06], [0, 0, 1], 0.32, 0.32, TILE.warnCrush, { k: 0.9 });
      cb([x1 - 0.9, 0.1, z1 - 0.07], [x1 - 0.2, 0.7, z1 - 0.05], 'paint', { r: 0.008, tint: 0.85 });   // access door
      handle([x1 - 0.3, 0.32, z1 - 0.05], [x1 - 0.3, 0.48, z1 - 0.05], [0, 0, 1]);
      // column + head + motor
      const cx = x0 + 0.6, czc = z0 + 0.5;
      cb([x0 + 0.2, 0.8, z0 + 0.12], [x0 + 1.0, y1 - 0.25, z0 + 0.88], 'paint', { r: 0.05 });
      cb([x0 + 0.24, 1.15, z0 + 0.86], [x0 + 0.96, 1.62, z0 + 1.32], 'paint', { r: 0.04, tint: 0.92 });
      K.lathe('steel', [[0.001, 0], [0.07, 0], [0.07, 0.04], [0.055, 0.06], [0.055, 0.24], [0.001, 0.24]], M(cx, 0.94, z0 + 1.12), { segs: 14, tint: 0.8 });
      K.lathe('dark', [[0.001, -0.07], [0.04, -0.07], [0.04, 0.01], [0.001, 0.01]], M(cx, 0.94, z0 + 1.12), { segs: 10 });
      const mt = M(cx, y1 - 0.26, czc);
      K.lathe('paintGrey', [[0.001, 0], [0.18, 0], [0.18, 0.04], [0.16, 0.05], [0.16, 0.38], [0.12, 0.42], [0.001, 0.42]], mt, { segs: 18, tint: 0.85 });
      for (let k = 0.08; k < 0.35; k += 0.04) K.lathe('paintGrey', [[0.16, k], [0.178, k + 0.008], [0.178, k + 0.016], [0.16, k + 0.024]], mt, { segs: 18, tint: 0.8 });
      cb([x0 + 0.68, y1 - 0.06, czc - 0.1], [x0 + 0.86, y1 + 0.08, czc + 0.1], 'paintGrey', { r: 0.01 });
      lbl([x0 + 1.0, 1.35, czc], [1, 0, 0], 0.24, 0.24, TILE.warnVolt, { k: 1 });
      // knee, saddle, table with T-slots, handwheels
      cb([x0 + 0.3, 0.8, z0 + 0.88], [x0 + 0.9, 0.9, z0 + 1.6], 'paint', { r: 0.02, tint: 0.88 });
      cb([x0 + 0.28, 0.89, z0 + 0.92], [x0 + 1.05, 0.95, z0 + 1.55], 'paint', { r: 0.015, tint: 0.95 });
      cb([x0 + 0.12, 0.945, z0 + 1.02], [x1 - 0.18, 1.04, z0 + 1.48], 'steel', { r: 0.01, tint: 0.85 });
      for (let z = z0 + 1.1; z < z0 + 1.45; z += 0.11) cb([x0 + 0.14, 1.03, z], [x1 - 0.2, 1.05, z + 0.02], 'dark', { r: 0.003 });
      handwheel([x0 + 0.07, 0.99, z0 + 1.25], [-1, 0, 0], 0.085);
      handwheel([x1 - 0.12, 0.99, z0 + 1.25], [1, 0, 0], 0.085);
      handwheel([x0 + 0.6, 0.85, z0 + 1.68], [0, 0, 1], 0.07);
      // workpiece in a machine vice
      cb([x0 + 1.0, 1.04, z0 + 1.15], [x0 + 1.32, 1.12, z0 + 1.38], 'steel', { r: 0.008, tint: 0.55 });
      cb([x0 + 1.05, 1.11, z0 + 1.19], [x0 + 1.27, 1.22, z0 + 1.34], 'rust', { r: 0.006 });
      // coolant hose and work lamp
      hose([[x0 + 0.95, 1.5, z0 + 1.0], [x0 + 1.05, 1.45, z0 + 1.2], [x0 + 0.9, 1.25, z0 + 1.3], [x0 + 0.75, 1.12, z0 + 1.22]], 0.012, 'paintBlue');
      hose([[x0 + 0.25, 1.4, z0 + 0.86], [x0 + 0.1, 1.7, z0 + 1.0], [x0 + 0.25, 1.85, z0 + 1.25], [x0 + 0.45, 1.75, z0 + 1.35]], 0.012, 'dark');
      K.lathe('paintGrey', [[0.02, 0], [0.06, -0.08], [0.065, -0.1], [0.001, -0.1]], M(x0 + 0.47, 1.76, z0 + 1.36, 0, 0.5), { segs: 10 });
      // pendant control box on the column side
      cb([x0 + 0.12, 1.2, z0 + 0.35], [x0 + 0.21, 1.5, z0 + 0.6], 'paintGrey', { r: 0.01 });
      lbl([x0 + 0.12, 1.36, z0 + 0.475], [-1, 0, 0], 0.18, 0.18, TILE.panel, { k: 1 });
      estop([x0 + 0.12, 1.25, z0 + 0.42], [-1, 0, 0]);
      hose([[x0 + 0.16, 1.2, z0 + 0.48], [x0 + 0.1, 0.7, z0 + 0.4], [x0 - 0.1, 0.02, z0 + 0.3], [x0 - 0.6, 0.02, z0 + 0.9]], 0.011);
    },

    // ------------------------------------------------------------ vertical tank on legs
    tank(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2, r = (p.max[0] - p.min[0]) / 2 - 0.06;
      const yb = 0.85, yt = p.max[1] - 0.55;
      for (const [dx, dz] of [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]]) {
        const x = cx + dx, z = cz + dz;
        cb([x - 0.09, 0.015, z - 0.09], [x + 0.09, yb + 0.2, z + 0.09], 'steel', { r: 0.01, tint: 0.8 });
        cb([x - 0.17, 0, z - 0.17], [x + 0.17, 0.025, z + 0.17], 'steel', { r: 0.004, tint: 0.6 });
        for (const [a, b] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]]) K.bolt([x + a, 0.025, z + b], [0, 1, 0], 1.6);
      }
      for (const [ax, az, bx, bz] of [[-0.75, -0.75, 0.75, -0.75], [-0.75, 0.75, 0.75, 0.75], [-0.75, -0.75, -0.75, 0.75], [0.75, -0.75, 0.75, 0.75]]) {
        K.pipe('steel', [cx + ax, 0.3, cz + az], [cx + bx, 0.3, cz + bz], 0.025, { segs: 6, tint: 0.7 });
      }
      B.cylinder('paintGrey', [cx, yb, cz], r, yt - yb, { segs: 32, rows: 7, caps: false });
      const head = (y, s) => K.lathe('paintGrey', [[r, 0], [r * 0.97, s * 0.12], [r * 0.85, s * 0.27], [r * 0.6, s * 0.4], [r * 0.3, s * 0.46], [0.001, s * 0.48]].map(([a, b]) => [a, b]), M(cx, y, cz), { segs: 32 });
      head(yt, 1);
      K.lathe('paintGrey', [[0.001, -0.48], [r * 0.3, -0.46], [r * 0.6, -0.4], [r * 0.85, -0.27], [r * 0.97, -0.12], [r, 0]], M(cx, yb, cz), { segs: 32, tint: 0.8 });
      // weld seams and stiffener bands
      for (const y of [yb + 1.2, yb + 2.4]) B.cylinder('paintGrey', [cx, y - 0.012, cz], r + 0.009, 0.024, { segs: 32, caps: false, tint: 0.85 });
      for (const y of [1.6, 3.3]) B.cylinder('steel', [cx, y, cz], r + 0.035, 0.09, { segs: 32, caps: false, tint: 0.75 });
      // manway (west) with bolted cover
      K.pipe('paintGrey', [cx - r + 0.1, 1.55, cz + 0.2], [cx - r - 0.14, 1.55, cz + 0.2], 0.3, { segs: 20 });
      K.pipe('steel', [cx - r - 0.135, 1.55, cz + 0.2], [cx - r - 0.18, 1.55, cz + 0.2], 0.34, { segs: 20, tint: 0.7 });
      for (let i = 0; i < 16; i++) { const a = i / 16 * PI * 2; K.bolt([cx - r - 0.18, 1.55 + Math.sin(a) * 0.3, cz + 0.2 + Math.cos(a) * 0.3], [-1, 0, 0], 1.4); }
      K.pipe('steel', [cx - r - 0.18, 1.55, cz + 0.05], [cx - r - 0.28, 1.55, cz + 0.05], 0.012, { segs: 6 });
      K.pipe('steel', [cx - r - 0.18, 1.55, cz + 0.35], [cx - r - 0.28, 1.55, cz + 0.35], 0.012, { segs: 6 });
      K.pipe('steel', [cx - r - 0.28, 1.55, cz + 0.05], [cx - r - 0.28, 1.55, cz + 0.35], 0.012, { segs: 6 });
      // nozzles with flanges + piping (existing runs to the wall and the corridor)
      const flange = (a, b, rr0) => { K.pipe('steel', a, b, rr0, { segs: 16, tint: 0.65 }); };
      const pX = p.pipeTo ? p.pipeTo[0] : 7.8, pZ = p.pipeTo ? p.pipeTo[1] : -5.8, pd = pZ < cz ? -1 : 1;
      flange([cx, 4.38, cz + pd * (r - 0.05)], [cx, 4.38, cz + pd * (r + 0.1)], 0.2);
      B.pipe('rust', [cx, 4.38, cz + pd * (r + 0.1)], [cx, 4.38, pZ], 0.12);
      flange([cx + r - 0.05, 1.2, cz], [cx + r + 0.1, 1.2, cz], 0.18);
      B.pipe('rust', [cx + r + 0.1, 1.2, cz], [pX, 1.2, cz], 0.1);
      flange([cx + r + 0.6, 1.2, cz], [cx + r + 0.7, 1.2, cz], 0.17);
      cb([cx + r + 0.35, 1.08, cz - 0.11], [cx + r + 0.55, 1.32, cz + 0.11], 'paintRed', { r: 0.02, tint: 0.8 });   // valve body
      K.pipe('steel', [cx + r + 0.45, 1.32, cz], [cx + r + 0.45, 1.55, cz], 0.02, { segs: 8 });
      handwheel([cx + r + 0.45, 1.56, cz], [0, 1, 0], 0.13);
      // ladder with safety cage on the south side
      const lz = cz + r + 0.16;
      for (const dx of [-0.22, 0.22]) cb([cx + dx - 0.025, 0.05, lz - 0.02], [cx + dx + 0.025, p.max[1] + 0.2, lz + 0.02], 'steel', { r: 0.006 });
      for (let y = 0.4; y < p.max[1]; y += 0.3) K.pipe('steel', [cx - 0.2, y, lz], [cx + 0.2, y, lz], 0.014, { segs: 6 });
      for (const y of [1.2, 2.4]) cb([cx - 0.04, y - 0.04, cz + r - 0.02], [cx + 0.04, y + 0.04, lz - 0.015], 'steel', { r: 0.005 });
      for (let y = 2.3; y < p.max[1] + 0.1; y += 0.7) {
        const g = new THREE.TorusGeometry(0.38, 0.016, 5, 14, PI);
        K.geo('steel', g, M(cx, y, lz + 0.05, 0, PI / 2, 0));
      }
      for (const a of [0.3, PI / 2, PI - 0.3]) K.pipe('steel', [cx + Math.cos(a) * 0.38, 2.3, lz + 0.05 + Math.sin(a) * 0.38], [cx + Math.cos(a) * 0.38, p.max[1] + 0.1, lz + 0.05 + Math.sin(a) * 0.38], 0.014, { segs: 5 });
      // gauge, sight glass, plate, rust streaks
      const gz = cz + r + 0.02;
      K.pipe('steel', [cx + 0.55, 1.5, cz + r - 0.1], [cx + 0.55, 1.5, gz + 0.06], 0.015, { segs: 6 });
      gauge([cx + 0.55, 1.5, gz + 0.06], [0, 0, 1], 0.075);
      const sx = cx - r * 0.7, sz = cz + r * 0.72;
      K.pipe('glassDark', [sx, 1.1, sz], [sx, 3.6, sz], 0.022, { segs: 8 });
      for (const y of [1.05, 3.65]) K.pipe('steel', [sx, y, sz], [cx - r * 0.66, y, cz + r * 0.68], 0.025, { segs: 6 });
      lbl([cx + r * 0.5 + 0.01, 2.1, cz + r * 0.866 + 0.01], [0.5, 0, 0.866], 0.45, 0.45, TILE.plate, { k: 0.9 });
      for (const a of [0.4, 1.3, 2.2, 3.4, 4.6]) {
        lbl([cx + Math.cos(a) * (r + 0.004), yt - 0.5, cz + Math.sin(a) * (r + 0.004)], [Math.cos(a), 0, Math.sin(a)], 0.4, 1.0, 14, { k: 0.75 });
      }
      lbl([cx - 0.72, 1.9, cz - r * 0.7 - 0.02], [-0.72, 0, -0.69], 0.35, 0.35, TILE.warnVolt, { k: 0.9 });
    },

    // ------------------------------------------------------------ tall steel cupboards (hall west)
    cabinets(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, n = 4, w = (x1 - x0) / n;
      cb([x0 + 0.03, 0, z0 + 0.035], [x1 - 0.03, 0.07, z1 - 0.075], 'dark', { r: 0.005 });
      for (let i = 0; i < n; i++) {
        const a = x0 + i * w, t = rr(0.75, 1.0), open = i === 2;
        const fz = z1 - 0.035;
        if (!open) {
          cb([a + 0.008, 0.06, z0], [a + w - 0.008, y1, fz], 'paintGrey', { r: 0.012, tint: t });
          for (const [da, db] of [[0.018, w / 2 - 0.004], [w / 2 + 0.004, w - 0.018]]) {
            cb([a + da, 0.1, fz - 0.01], [a + db, y1 - 0.04, z1 - 0.012], 'paintGrey', { r: 0.008, tint: t * 0.95 });
            lbl([a + (da + db) / 2, y1 - 0.25, z1 - 0.012], [0, 0, 1], (db - da) * 0.75, 0.2, TILE.vent, { k: 0.8 });
            lbl([a + (da + db) / 2, 0.3, z1 - 0.012], [0, 0, 1], (db - da) * 0.75, 0.2, TILE.vent, { k: 0.7 });
          }
          handle([a + w / 2 - 0.03, 0.9, z1 - 0.012], [a + w / 2 - 0.03, 1.15, z1 - 0.012], [0, 0, 1], 0.008);
          lbl([a + w / 2, 1.5, z1 - 0.012], [0, 0, 1], 0.32, 0.32, TILE.number, { u0: (i % 4) * 0.25, u1: (i % 4) * 0.25 + 0.25 });
        } else {
          // open cupboard: hollow carcass with shelves and junk, doors swung out
          // panels meet edge-to-edge (no overlapping coplanar faces)
          const th = 0.02, xl = a + 0.008 + th, xr = a + w - 0.008 - th;
          cb([a + 0.008, 0.06, z0], [a + w - 0.008, y1, z0 + th], 'paintGrey', { r: 0.004, tint: t * 0.7 });
          cb([a + 0.008, 0.06, z0 + th], [xl, y1, fz], 'paintGrey', { r: 0.004, tint: t });
          cb([xr, 0.06, z0 + th], [a + w - 0.008, y1, fz], 'paintGrey', { r: 0.004, tint: t });
          cb([xl, y1 - th, z0 + th], [xr, y1 - 0.004, fz - 0.01], 'paintGrey', { r: 0.004, tint: t });
          for (const y of [0.06, 0.55, 1.05, 1.5]) {
            cb([xl, y, z0 + th], [xr, y + 0.02, fz - 0.02], 'paintGrey', { r: 0.003, tint: t * 0.85 });
          }
          carton(a + w * 0.4, 0.58, (z0 + z1) / 2, 0.3, 0.22, 0.35, 0.1);
          model('can_rusted', a + w * 0.7, 1.07, (z0 + z1) / 2 + 0.1, { s: 1.3 });
          model('can_rusted', a + w * 0.3, 1.07, (z0 + z1) / 2 - 0.05, { s: 1.3 });
          model('plastic_jerrycan', a + w * 0.5, 0.08, (z0 + z1) / 2, { ry: PI / 2 + 0.2, s: 0.9 });
          for (const [s, hx] of [[-1, a + 0.012], [1, a + w - 0.012]]) {
            const m = M(hx, 0.1, z1 - 0.03, s * 1.9);
            cb(s < 0 ? [0, 0, 0] : [-w / 2 + 0.016, 0, 0], s < 0 ? [w / 2 - 0.016, y1 - 0.14, 0.02] : [0, y1 - 0.14, 0.02], 'paintGrey', { matrix: m, r: 0.006, tint: t * 0.9 });
          }
        }
        if (R() < 0.6) carton(a + w / 2 + rr(-0.05, 0.05), y1, (z0 + z1) / 2, rr(0.3, 0.5), rr(0.2, 0.35), rr(0.4, 0.6), rr(-0.2, 0.2));
      }
      lbl([x0 + 0.3, 1.0, z1 - 0.011], [0, 0, 1], 0.2, 0.3, TILE.notice, { k: 0.85, rot: 0.08 });
    },

    // ------------------------------------------------------------ workbench with pegboard, vice, tools
    workbench(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      cb([x0, y1 - 0.065, z0], [x1, y1, z1], 'woodDark', { r: 0.008, tint: 0.85 });
      for (const [a, b] of [[x0 + 0.03, z0 + 0.03], [x1 - 0.09, z0 + 0.03], [x0 + 0.03, z1 - 0.09], [x1 - 0.09, z1 - 0.09]]) {
        cb([a, 0.012, b], [a + 0.06, y1 - 0.06, b + 0.06], 'steel', { r: 0.006 });
        cb([a - 0.02, 0, b - 0.02], [a + 0.08, 0.014, b + 0.08], 'steel', { r: 0.003, tint: 0.6 });
      }
      for (const z of [z0 + 0.04, z1 - 0.08]) cb([x0 + 0.09, y1 - 0.13, z], [x1 - 0.09, y1 - 0.065, z + 0.04], 'steel', { r: 0.005, tint: 0.85 });
      cb([x0 + 0.08, 0.2, z0 + 0.08], [x1 - 0.08, 0.235, z1 - 0.08], 'woodDark', { r: 0.004, tint: 0.7 });
      // pegboard on the wall with tools
      const wz = z1 + 0.2 - 0.045;   // wall face at z1 + 0.2 (= 15.6)
      cb([x0 + 0.1, 1.05, wz], [x1 - 0.1, 1.9, wz + 0.035], 'woodDark', { r: 0.004, tint: 0.7 });
      K.pipe('steel', [x0 + 0.3, 1.82, wz - 0.03], [x1 - 0.3, 1.82, wz - 0.03], 0.012, { segs: 6 });
      for (let i = 0; i < 9; i++) {
        const x = x0 + 0.3 + i * 0.22, y = rr(1.2, 1.6), kind = i % 3;
        if (kind === 0) cb([x - 0.012, y - 0.15, wz - 0.022], [x + 0.012, y + 0.12, wz - 0.008], 'steel', { r: 0.004, tint: 0.7 });        // wrench/screwdriver
        else if (kind === 1) { cb([x - 0.015, y - 0.2, wz - 0.03], [x + 0.015, y + 0.08, wz - 0.008], 'woodDark', { r: 0.006 }); cb([x - 0.06, y + 0.05, wz - 0.042], [x + 0.06, y + 0.1, wz - 0.018], 'steel', { r: 0.008, tint: 0.5 }); }
        else K.geo('dark', new THREE.TorusGeometry(0.09, 0.018, 6, 14), M(x, y, wz - 0.03));      // coiled cable
      }
      lbl([x1 - 0.35, 1.7, wz - 0.002], [0, 0, -1], 0.18, 0.26, TILE.notice, { k: 0.9, rot: -0.05 });
      // bench-top things
      model('bench_vice_01', x0 + 0.35, y1, z0 + 0.12, { ry: PI, s: 1.2 });
      model('Drill_01', x0 + 1.0, y1 + 0.03, z0 + 0.35, { ry: 1.1, rx: PI / 2, s: 1.2 });
      model('metal_tool_chest', x1 - 0.5, y1, z0 + 0.5, { ry: PI + 0.08, s: 0.95 });
      model('can_rusted', x0 + 1.5, y1, z0 + 0.6, { s: 1.1 });
      model('can_rusted', x0 + 1.62, y1, z0 + 0.48, { s: 1.4 });
      model('metal_tool_chest', x0 + 0.6, 0.235, z0 + 0.45, { ry: PI + 0.1, s: 0.85 });
      model('can_rusted', x1 - 0.4, 0.235, z0 + 0.3, { s: 1.6 });
      model('sledgehammer_01', x1 - 0.16, 0.47, z0 - 0.08, { ry: PI / 2, rx: -0.32, s: 0.95 });
      for (let i = 0; i < 12; i++) K.bolt([rr(x0 + 0.7, x1 - 0.9), y1, rr(z0 + 0.1, z1 - 0.15)], [0, 1, 0], rr(0.8, 1.4));
      inst.papers.push([x0 + 1.25, y1 + 0.002, z0 + 0.25, 0.4]);
    },

    // ------------------------------------------------------------ diesel generator set on a skid
    generator(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2;
      for (const [za, zb] of [[z0 + 0.04, z0 + 0.16], [z1 - 0.16, z1 - 0.04]]) {
        cb([x0, 0, za], [x1, 0.16, zb], 'steel', { r: 0.01, tint: 0.65 });
        K.stripes([x0, 0.08, za], [x0 + 0.5, 0.08, za], [0, 0, -1], 0.12);
      }
      for (const x of [x0 + 0.1, (x0 + x1) / 2, x1 - 0.2]) cb([x, 0.02, z0 + 0.16], [x + 0.1, 0.14, z1 - 0.16], 'steel', { r: 0.008, tint: 0.6 });
      cb([x0 + 0.5, 0.01, z0 + 0.2], [x1 - 0.4, 0.15, z1 - 0.2], 'dark', { r: 0.02 });       // base fuel tank
      // radiator (west end) with grille and filler
      cb([x0 + 0.08, 0.15, z0 + 0.2], [x0 + 0.45, y1 - 0.08, z1 - 0.2], 'paint', { r: 0.03 });
      lbl([x0 + 0.08, 0.8, cz], [-1, 0, 0], z1 - z0 - 0.55, y1 - 0.45, TILE.vent, { k: 0.9 });
      K.pipe('steel', [x0 + 0.26, y1 - 0.1, cz + 0.3], [x0 + 0.26, y1 + 0.02, cz + 0.3], 0.04, { segs: 10 });
      K.lathe('steel', [[0.47, -0.05], [0.5, 0], [0.47, 0.05]], M(x0 + 0.5, 0.8, cz, 0, 0, PI / 2), { segs: 20, tint: 0.6 });
      // engine block, valve covers, manifolds
      cb([x0 + 0.55, 0.15, z0 + 0.38], [x1 - 0.8, 0.95, z1 - 0.38], 'paint', { r: 0.04, tint: 0.9 });
      cb([x0 + 0.65, 0.93, z0 + 0.48], [x1 - 0.9, 1.1, z1 - 0.48], 'paintRed', { r: 0.025, tint: 0.75 });
      for (let x = x0 + 0.75; x < x1 - 0.95; x += 0.18) K.bolt([x, 1.1, cz], [0, 1, 0], 1.4);
      for (let x = x0 + 0.72; x < x1 - 0.9; x += 0.2) K.pipe('steel', [x, 1.0, z0 + 0.48], [x, 0.85, z0 + 0.3], 0.008, { segs: 5 });
      for (let x = x0 + 0.72; x < x1 - 0.9; x += 0.2) K.pipe('rust', [x, 0.75, z1 - 0.39], [x, 0.75, z1 - 0.28], 0.035, { segs: 8 });
      K.pipe('rust', [x0 + 0.65, 0.75, z1 - 0.28], [x1 - 0.95, 0.75, z1 - 0.28], 0.06, { segs: 10 });
      K.pipe('rust', [x1 - 0.95, 0.75, z1 - 0.28], [x1 - 0.95, 1.2, z1 - 0.3], 0.07, { segs: 10 });
      K.pipe('rust', [x1 - 0.95, 1.2, z1 - 0.3], [x1 - 0.95, 1.3, z1 - 0.3], 0.13, { segs: 14 });            // muffler
      K.pipe('rust', [x1 - 0.95, 1.3, z1 - 0.3], [x1 - 0.95, 1.6, z1 - 0.3], 0.13, { segs: 14 });
      B.pipe('rust', [x1 - 0.95, 1.6, z1 - 0.3], [x1 - 0.95, y1 + 1.0, z1 - 0.3], 0.07);
      K.lathe('rust', [[0.001, 0.06], [0.1, 0.0], [0.11, -0.02]], M(x1 - 0.95, y1 + 1.0, z1 - 0.3, 0, 0.4), { segs: 12 });   // rain cap
      K.pipe('paintGrey', [x0 + 1.0, 1.05, z0 + 0.3], [x0 + 1.0, 1.35, z0 + 0.3], 0.13, { segs: 16 });   // air filter
      // alternator (east end) with fins + junction box
      const am = M(x1 - 0.45, 0.62, cz, 0, 0, PI / 2);
      K.lathe('paint', [[0.001, -0.33], [0.38, -0.33], [0.42, -0.28], [0.42, 0.26], [0.36, 0.32], [0.001, 0.32]], am, { segs: 22, tint: 0.85 });
      for (let k = -0.24; k < 0.24; k += 0.06) K.lathe('paint', [[0.41, k], [0.44, k + 0.01], [0.44, k + 0.025], [0.41, k + 0.035]], am, { segs: 22, tint: 0.8 });
      cb([x1 - 0.7, 1.0, cz - 0.25], [x1 - 0.2, 1.52, cz + 0.25], 'paintGrey', { r: 0.02 });
      gauge([x1 - 0.6, 1.36, cz - 0.25], [0, 0, -1], 0.055); gauge([x1 - 0.45, 1.36, cz - 0.25], [0, 0, -1], 0.055);
      gauge([x1 - 0.3, 1.36, cz - 0.25], [0, 0, -1], 0.055);
      estop([x1 - 0.32, 1.13, cz - 0.25], [0, 0, -1]);
      lbl([x1 - 0.55, 1.15, cz - 0.25], [0, 0, -1], 0.14, 0.14, TILE.panel, { k: 1 });
      lbl([x1 - 0.2, 1.3, cz], [1, 0, 0], 0.3, 0.3, TILE.warnVolt, { k: 1 });
      lbl([x1 - 0.45, 0.62, cz - 0.42], [0, 0, -1], 0.36, 0.36, TILE.maker, { k: 0.9 });
      // battery box + cables
      cb([x1 - 0.75, 0.15, z0 + 0.2], [x1 - 0.42, 0.42, z0 + 0.42], 'dark', { r: 0.015 });
      hose([[x1 - 0.5, 0.42, z0 + 0.3], [x1 - 0.5, 0.6, z0 + 0.2], [x1 - 0.6, 0.9, z0 + 0.35]], 0.012, 'paintRed');
      hose([[x1 - 0.2, 1.1, cz + 0.2], [x1 - 0.05, 0.6, cz + 0.4], [x1 + 0.2, 0.02, cz + 0.3], [x1 + 1.5, 0.02, cz - 0.6], [x1 + 2.4, 0.02, cz - 2.0]], 0.02);
      hose([[x1 - 0.2, 1.0, cz + 0.1], [x1 + 0.02, 0.5, cz + 0.2], [x1 + 0.25, 0.02, cz], [x1 + 1.2, 0.02, cz - 1.0]], 0.016);
      lbl([x0 + 1.2, 0.5, z0 + 0.38], [0, 0, -1], 0.4, 0.8, 14, { k: 0.7 });
    },

    // ------------------------------------------------------------ corridor vending machine (front faces +x)
    vending(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, fx = x1 - 0.03;
      const yA = 0.78, yB = 1.74, zA = z0 + 0.09, zB = z1 - 0.34;
      cb([x0 + 0.02, 0.06, z0 + 0.01], [x1 - 0.24, y1, z1 - 0.01], 'paintRed', { r: 0.02 });           // carcass back
      // front pieces are inset 8 mm from the carcass sides/top so no faces coincide
      cb([x1 - 0.25, 0.07, z0 + 0.018], [fx, yA, z1 - 0.018], 'paintRed', { r: 0.015 });                    // lower front
      cb([x1 - 0.25, yB, z0 + 0.018], [fx, y1 - 0.01, z1 - 0.018], 'paintRed', { r: 0.015, tint: 0.9 });   // header
      cb([x1 - 0.25, yA, z0 + 0.018], [fx, yB, zA], 'paintRed', { r: 0.008 });                           // left jamb
      cb([x1 - 0.25, yA, zB], [fx, yB, z1 - 0.018], 'paintRed', { r: 0.008, tint: 0.95 });                // control column
      for (const [a, b] of [[x0 + 0.05, z0 + 0.05], [x0 + 0.05, z1 - 0.1], [x1 - 0.1, z0 + 0.05], [x1 - 0.1, z1 - 0.1]]) cb([a, 0, b], [a + 0.05, 0.07, b + 0.05], 'dark', { r: 0.005 });
      // shelves with cans behind glass
      const cols = ['paintRed', 'paintBlue', 'yellow', 'paintGrey', 'paint'];
      for (let r = 0; r < 5; r++) {
        const y = yA + 0.02 + r * 0.19;
        cb([x1 - 0.236, y - 0.012, zA - 0.01], [fx - 0.03, y + 0.004, zB + 0.01], 'steel', { r: 0.002, tint: 0.6 });
        for (let c = 0; c < 6; c++) {
          if (R() < 0.3) continue;
          const z = zA + 0.05 + c * ((zB - zA - 0.1) / 5);
          const key = cols[(r * 2 + c) % cols.length];
          B.cylinder(key, [fx - 0.09, y + 0.004, z], 0.032, 0.12, { segs: 8, tint: 1.1 });
          if (R() < 0.5) B.cylinder(key, [fx - 0.17, y + 0.004, z], 0.032, 0.12, { segs: 8, tint: 1.0 });
        }
      }
      lbl([fx - 0.012, (yA + yB) / 2, (zA + zB) / 2], [1, 0, 0], zB - zA, yB - yA, 0, { glass: true, offset: 0 });
      lbl([fx, 1.25, zB + 0.17], [1, 0, 0], 0.22, 0.22, TILE.panel, { k: 1.05 });
      cb([fx - 0.01, 1.0, zB + 0.1], [fx + 0.012, 1.08, zB + 0.24], 'steel', { r: 0.004, tint: 0.7 });  // coin slot plate
      cb([fx - 0.05, 0.18, zA + 0.05], [fx + 0.01, 0.4, zB - 0.05], 'dark', { r: 0.008 });              // delivery flap
      lbl([fx, 1.83, (z0 + z1) / 2], [1, 0, 0], z1 - z0 - 0.2, 0.25, TILE.maker, { k: 0.9 });
    },

    desk(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const face = p.min[2] < 13 ? -1 : 1;    // sitter side (toward the nearest wall)
      model('metal_office_desk', cx, 0, cz, { ry: face < 0 ? PI : 0, s: [(x1 - x0) / 2.0, y1 / 0.79, (z1 - z0) / 0.95] });
      model('Television_01', cx + rr(-0.35, -0.2), y1, cz - face * 0.08, { ry: (face < 0 ? PI : 0) + rr(-0.25, 0.25), s: 0.78 });
      // keyboard + mug + paper stacks
      const kz = cz + face * 0.22;
      cb([cx - 0.45, y1, kz - 0.08], [cx - 0.0, y1 + 0.028, kz + 0.08], 'rubber', { r: 0.006, color: [5.5, 5.3, 4.8] });   // beige keyboard
      lbl([cx - 0.225, y1 + 0.028, kz], [0, 1, 0], 0.4, 0.13, TILE.vent, { k: 0.9, up: [0, 0, -face] });
      K.lathe('paintGrey', [[0.001, 0], [0.04, 0], [0.042, 0.095], [0.036, 0.095], [0.034, 0.008], [0.001, 0.008]], M(cx + 0.35, y1, kz), { segs: 12, tint: 1.1 });
      for (let i = 0; i < 6; i++) inst.papers.push([rr(x0 + 0.3, x1 - 0.2), y1 + 0.002 + i * 0.0012, rr(z0 + 0.1, z1 - 0.1), R() * 3]);
      for (let i = 0; i < 3; i++) cb([0, i * 0.022, 0], [0.3, 0.02 + i * 0.022, 0.24], i % 2 ? 'paintBlue' : 'cardboard', { r: 0.004, matrix: M(cx + 0.3, y1, cz - face * 0.05, i * 0.08 - 0.1), tint: 0.9 });
      lbl([cx + 0.15, 0.01 + 0.001, cz + face * 0.75], [0, 1, 0], 0.3, 0.42, TILE.notice, { k: 0.75, rot: rr(0, 3) });
    },
    filing(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, n = 2, w = (z1 - z0) / n;
      for (let c = 0; c < n; c++) {
        const a = z0 + c * w;
        cb([x0 + 0.02, 0, a + 0.006], [x1, y1, a + w - 0.006], 'paintGrey', { r: 0.012, tint: c ? 0.82 : 0.95 });
        for (let d = 0; d < 4; d++) {
          const ya = 0.05 + d * 0.31, yb = ya + 0.28;
          const out = c === 1 && d === 1 ? 0.32 : 0;
          if (out) {
            cb([x0 - out + 0.02, ya + 0.03, a + 0.03], [x0 + 0.1, yb - 0.04, a + w - 0.03], 'paintGrey', { r: 0.004, tint: 0.7 });
            for (let i = 0; i < 4; i++) cb([x0 - out + 0.06 + i * 0.07, ya + 0.04, a + 0.05], [x0 - out + 0.065 + i * 0.07, yb - 0.02, a + w - 0.05], 'paper', { r: 0.001, color: [0.75, 0.72, 0.62] });
          }
          cb([x0 - 0.008 - out, ya, a + 0.02], [x0 + 0.03 - out, yb, a + w - 0.02], 'paintGrey', { r: 0.006, tint: 0.88 });
          handle([x0 - 0.008 - out, ya + 0.17, a + w / 2 - 0.08], [x0 - 0.008 - out, ya + 0.17, a + w / 2 + 0.08], [-1, 0, 0], 0.007);
          lbl([x0 - 0.008 - out, ya + 0.22, a + w / 2], [-1, 0, 0], 0.08, 0.05, TILE.notice, { k: 0.9, u0: 0.2, u1: 0.8 });
        }
      }
      carton(x0 + 0.3, y1, z0 + 0.4, 0.35, 0.25, 0.45, 0.2);
    },
    shelf(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      if (!p.metal) {
        // office: two worn steel racks against the south wall
        const cz = (z0 + z1) / 2, n = 2, w = (x1 - x0) / n;
        for (let i = 0; i < n; i++) {
          const cx = x0 + w * (i + 0.5);
          model('worn_metal_rack', cx, 0, cz, { ry: PI, s: [w / 0.92 - 0.01, 1.0, (z1 - z0) / 0.6] });
          for (const y of [0.42, 0.925, 1.4, 1.875]) {
            for (let s = -w / 2 + 0.08; s < w / 2 - 0.15; s += rr(0.18, 0.38)) {
              const k = R();
              if (k < 0.2) continue;
              if (k < 0.55) for (let b = 0; b < 4; b++) cb([cx + s + b * 0.055, y, cz - 0.12], [cx + s + b * 0.055 + 0.05, y + 0.31, cz + 0.12], pick(['paintBlue', 'paintRed', 'dark', 'paintGrey']), { r: 0.004, tint: rr(0.7, 1.0) });
              else if (k < 0.85) carton(cx + s + 0.13, y, cz, 0.26, rr(0.12, 0.3), 0.32, rr(-0.15, 0.15));
              else model('can_rusted', cx + s + 0.06, y, cz + rr(-0.1, 0.1), { s: 1.2 });
            }
          }
        }
        return;
      }
      // storage: steel frame shelves, long side against the wall
      const along = (x1 - x0) > (z1 - z0), L = along ? x1 - x0 : z1 - z0, n = Math.max(1, Math.round(L / 1.1)), w = L / n;
      const cx0 = (x0 + x1) / 2, cz0 = (z0 + z1) / 2;
      for (let i = 0; i < n; i++) {
        const t = along ? x0 + w * (i + 0.5) : z0 + w * (i + 0.5);
        const cx = along ? t : cx0, cz = along ? cz0 : t;
        model('steel_frame_shelves_01', cx, 0, cz, { ry: along ? 0 : PI / 2, s: [w / 1.1 - 0.005, 1.0, 1.0] });
        for (const y of [0.125, 0.632, 1.138, 1.645, 2.11]) {
          for (let s = -w / 2 + 0.06; s < w / 2 - 0.2; s += rr(0.25, 0.45)) {
            const k = R();
            const px = along ? cx + s + 0.12 : cx + rr(-0.05, 0.05), pz = along ? cz + rr(-0.05, 0.05) : cz + s + 0.12;
            if (k < 0.18) continue;
            if (y > 2 && k < 0.6) continue;
            if (p.archive && k < 0.75) {
              // archive: rows of lever-arch files
              const n = 4 + Math.floor(R() * 6), key = pick(['paintBlue', 'paintRed', 'dark', 'paintGrey', 'yellow']);
              for (let b = 0; b < n; b++) {
                const o = -0.12 + b * 0.065;
                const lean = b === n - 1 && R() < 0.4 ? 0.25 : 0;
                const mm = M(along ? px + o : px, y, along ? pz : pz + o, (along ? 0 : PI / 2), 0, lean);
                box([-0.028, 0, -0.14], [0.028, 0.31, 0.14], key, { matrix: mm, normalMatrix: new THREE.Matrix3().getNormalMatrix(mm), tint: rr(0.6, 1.0), seg: 2 });
              }
              continue;
            }
            if (k < 0.62) carton(px, y, pz, rr(0.25, 0.4), rr(0.16, 0.36), rr(0.28, 0.4), rr(-0.2, 0.2) + (along ? 0 : PI / 2));
            else if (k < 0.72 && y < 2) crateCheap(px, y, pz, (along ? 0 : PI / 2) + rr(-0.1, 0.1));
            else if (k < 0.78 && y < 2) model('plastic_jerrycan', px, y, pz, { ry: rr(0, 6), s: 0.95 });
            else model('can_rusted', px, y, pz, { s: 1.4 });
          }
        }
      }
    },
    lockers(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const n = Math.round((z1 - z0) / 0.4), w = (z1 - z0) / n;
      const s = p.facing < 0 ? -1 : 1, fx = s > 0 ? x1 : x0;
      cb([x0 + 0.03, 0, z0 + 0.034], [x1 - 0.03, 0.09, z1 - 0.034], 'dark', { r: 0.005 });
      for (let i = 0; i < n; i++) {
        const a = z0 + i * w, t = rr(0.72, 1.0);
        const open = R() < 0.2;
        if (!open) {
          cb([x0, 0.08, a + 0.006], [x1, y1, a + w - 0.006], 'paintBlue', { r: 0.01, tint: t });
          const dmin = s > 0 ? [x1 - 0.012, 0.12, a + 0.02] : [x0 - 0.012, 0.12, a + 0.02];
          const dmax = s > 0 ? [x1 + 0.012, y1 - 0.05, a + w - 0.02] : [x0 + 0.012, y1 - 0.05, a + w - 0.02];
          cb(dmin, dmax, 'paintBlue', { r: 0.006, tint: t * 0.9 });
          const df = fx + s * 0.012;
          lbl([df, y1 - 0.3, a + w / 2], [s, 0, 0], w - 0.12, 0.16, TILE.vent, { k: 0.75 });
          lbl([df, 0.32, a + w / 2], [s, 0, 0], w - 0.12, 0.16, TILE.vent, { k: 0.65 });
          lbl([df, y1 - 0.48, a + w / 2], [s, 0, 0], 0.18, 0.18, TILE.number, { u0: (i % 4) * 0.25, u1: (i % 4) * 0.25 + 0.25, k: 0.9 });
          handle([df, 1.0, a + w - 0.08], [df, 1.12, a + w - 0.08], [s, 0, 0], 0.007);
          if (R() < 0.4) { const hx = df + s * 0.02; cb([Math.min(df - s * 0.01, hx), 0.9, a + w - 0.1], [Math.max(df - s * 0.01, hx), 0.95, a + w - 0.06], 'steel', { r: 0.005, tint: 0.5 }); }
        } else {
          // hollow carcass with a door hanging open (panels meet edge to edge)
          const th = 0.018, back = s > 0 ? x0 : x1, za = a + 0.006 + th, zb = a + w - 0.006 - th;
          const bx0 = s > 0 ? x0 : x1 - th, bx1 = s > 0 ? x0 + th : x1;
          cb([x0, 0.08, a + 0.006], [x1, y1, za], 'paintBlue', { r: 0.004, tint: t });
          cb([x0, 0.08, zb], [x1, y1, a + w - 0.006], 'paintBlue', { r: 0.004, tint: t });
          cb([bx0, 0.08 + th, za], [bx1, y1 - th, zb], 'paintBlue', { r: 0.004, tint: t * 0.6 });
          cb([x0, y1 - th, za], [x1, y1 - 0.003, zb], 'paintBlue', { r: 0.004, tint: t });
          cb([x0, 0.08, za], [x1, 0.08 + th, zb], 'paintBlue', { r: 0.004, tint: t * 0.7 });
          cb([x0 + 0.02, 1.55, za], [x1 - 0.02, 1.57, zb], 'paintBlue', { r: 0.003, tint: t * 0.8 });
          K.pipe('steel', [back + s * 0.25, 1.45, a + 0.03], [back + s * 0.25, 1.45, a + w - 0.03], 0.008, { segs: 6 });
          if (R() < 0.7) {
            const g = new THREE.PlaneGeometry(0.3, 0.6, 3, 4);
            const pa = g.attributes.position;
            for (let k = 0; k < pa.count; k++) pa.setZ(k, Math.sin(pa.getX(k) * 9 + pa.getY(k) * 5) * 0.03);
            g.computeVertexNormals();
            K.geo('paper', g, M(back + s * 0.25, 1.15, a + w / 2, PI / 2 + 0.2), { color: [0.18, 0.2, 0.22] });
          }
          const m = M(fx + s * 0.01, 0.12, a + 0.02, s > 0 ? -0.35 : -2.79);
          cb([0, 0, -0.006], [w - 0.04, y1 - 0.17, 0.006], 'paintBlue', { matrix: m, r: 0.004, tint: t * 0.9 });
        }
        if (R() < 0.3) carton((x0 + x1) / 2, y1, a + w / 2, 0.38, rr(0.15, 0.3), 0.32, rr(-0.3, 0.3));
      }
    },
    bench(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      for (let k = 0; k < 3; k++) {
        const za = z0 + 0.01 + k * ((z1 - z0) / 3), zb = za + (z1 - z0) / 3 - 0.02;
        cb([x0, y1 - 0.035, za], [x1, y1, zb], 'wood', { r: 0.006, tint: rr(0.75, 1.0) });
      }
      for (const a of [x0 + 0.12, x1 - 0.17]) {
        cb([a, 0, z0 + 0.04], [a + 0.05, y1 - 0.034, z0 + 0.09], 'steel', { r: 0.005 });
        cb([a, 0, z1 - 0.09], [a + 0.05, y1 - 0.034, z1 - 0.04], 'steel', { r: 0.005 });
        cb([a + 0.01, y1 - 0.075, z0 + 0.03], [a + 0.04, y1 - 0.042, z1 - 0.03], 'steel', { r: 0.004 });
      }
      const g = new THREE.PlaneGeometry(0.45, 0.32, 4, 3), pa = g.attributes.position;
      for (let k = 0; k < pa.count; k++) pa.setZ(k, Math.abs(Math.sin(pa.getX(k) * 12)) * 0.03);
      g.computeVertexNormals();
      K.geo('paper', g, M(x0 + 0.6, y1 + 0.004, (z0 + z1) / 2, 0.3, -PI / 2), { color: [0.3, 0.32, 0.36] });
    },
    console(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const yd = 0.82;
      cb([x0 + 0.04, 0, z0 + 0.04], [x1 - 0.04, 0.08, z1 - 0.06], 'dark', { r: 0.005 });
      cb([x0, 0.07, z0], [x1, yd, z1 - 0.04], 'paintGrey', { r: 0.02 });
      // sloped desk
      K.hull('paintGrey', yd - 0.01, [x0 + 0.012, z0 + 0.25, x1 - 0.012, z1], yd + 0.22, [x0 + 0.012, z0 + 0.25, x1 - 0.012, z0 + 0.3], { tint: 0.9 });
      const run = z1 - z0 - 0.3, slope = Math.atan2(0.22, run);
      const nY = Math.cos(slope), nZ = Math.sin(slope);
      const onSlope = (f) => [yd - 0.01 + 0.22 * f, z1 - run * f];     // f = 0 front edge .. 1 back edge
      for (let x = x0 + 0.25; x < x1 - 0.2; x += 0.42) {
        const [yy, zz] = onSlope(0.55);
        lbl([x + 0.15, yy, zz], [0, nY, nZ], 0.3, 0.25, TILE.panel, { up: [0, nZ, -nY], k: 1.0 });
      }
      for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.8) { const [yy, zz] = onSlope(0.25); estop([x, yy, zz], [0, nY, nZ]); }
      // monitor bridge + CRT monitors
      cb([x0 + 0.012, yd - 0.02, z0 + 0.012], [x1 - 0.012, yd + 0.28, z0 + 0.26], 'paintGrey', { r: 0.015, tint: 0.85 });
      for (let x = x0 + 0.2; x < x1 - 0.5; x += 0.8) {
        const t = rr(0.8, 1.0);
        cb([x, yd + 0.28, z0 + 0.02], [x + 0.5, yd + 0.66, z0 + 0.4], 'dark', { r: 0.03, tint: t });
        K.hull('dark', yd + 0.3, [x + 0.08, z0 - 0.02, x + 0.42, z0 + 0.05], yd + 0.62, [x + 0.12, z0 + 0.0, x + 0.38, z0 + 0.05], { tint: t * 0.9 });
        // screen UVs mapped 0..1 across the glass (the screen canvas texture is not repeat-wrapped)
        const sw = 0.4, sx0 = x + 0.05, sy0 = yd + 0.33, uvo = rr(0, 0.25);
        box([sx0, sy0, z0 + 0.39], [sx0 + sw, yd + 0.62, z0 + 0.412], 'screen', { uvScale: (B.scales.screen ?? 0.5) / sw, uvOffset: [-sx0 / sw, -sy0 / sw + uvo], color: [1, 1, 1] });
        if (R() < 0.4) lbl([x + 0.38, yd + 0.6, z0 + 0.4], [0, 0, 1], 0.08, 0.1, TILE.notice, { k: 0.95, rot: 0.2 });
      }
      for (let i = 0; i < 3; i++) inst.papers.push([rr(x0 + 0.2, x1 - 0.2), yd + 0.29 + i * 0.001, z0 + 0.13, R() * 3]);
    },
    table(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      cb([x0, y1 - 0.035, z0], [x1, y1, z1], 'woodDark', { r: 0.006 });
      cb([x0 + 0.04, y1 - 0.11, z0 + 0.04], [x1 - 0.04, y1 - 0.034, z1 - 0.04], 'steel', { r: 0.006, tint: 0.7 });
      for (const [a, b] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.1, z0 + 0.05], [x0 + 0.05, z1 - 0.1], [x1 - 0.1, z1 - 0.1]]) cb([a, 0, b], [a + 0.05, y1 - 0.1, b + 0.05], 'steel', { r: 0.006 });
      for (let i = 0; i < 6; i++) inst.papers.push([rr(x0 + 0.2, x1 - 0.2), y1 + 0.002 + i * 0.001, rr(z0 + 0.1, z1 - 0.2), R() * 3]);
      if (p.canteen) {
        // canteen: trays, plates, mugs, a thermos; chairs on both sides
        for (let i = 0; i < 4; i++) {
          const x = x0 + 0.35 + i * (x1 - x0 - 0.7) / 3, zz = i % 2 ? z1 - 0.25 : z0 + 0.25;
          if (R() < 0.25) continue;
          cb([x - 0.18, y1, zz - 0.13], [x + 0.18, y1 + 0.015, zz + 0.13], i % 2 ? 'paintRed' : 'paintBlue', { r: 0.004, tint: 0.7 });
          K.lathe('paintGrey', [[0.001, 0.016], [0.1, 0.016], [0.11, 0.03], [0.001, 0.022]], M(x + 0.04, y1, zz), { segs: 14, tint: 1.3 });
          if (R() < 0.6) K.lathe('paintGrey', [[0.001, 0], [0.04, 0], [0.042, 0.095], [0.036, 0.095], [0.034, 0.008], [0.001, 0.008]], M(x - 0.1, y1 + 0.016, zz - 0.06), { segs: 12, tint: rr(0.8, 1.4) });
        }
        K.lathe('dark', [[0.001, 0], [0.06, 0], [0.06, 0.26], [0.035, 0.3], [0.001, 0.3]], M((x0 + x1) / 2, y1, (z0 + z1) / 2), { segs: 12 });
        for (const [cx2, cz2, ry] of [[x0 + 0.5, z0 - 0.35, 0.1], [x1 - 0.6, z0 - 0.3, -0.2], [x0 + 0.7, z1 + 0.35, PI + 0.2], [x1 - 0.5, z1 + 0.32, PI - 0.15]]) {
          if (R() < 0.2) continue;
          model('SchoolChair_01', cx2, 0, cz2, { ry: ry + rr(-0.3, 0.3) });
        }
        return;
      }
      // old radio + ashtray + mug
      cb([x0 + 0.2, y1, z0 + 0.15], [x0 + 0.55, y1 + 0.17, z0 + 0.32], 'dark', { r: 0.015 });
      lbl([x0 + 0.3, y1 + 0.09, z0 + 0.32], [0, 0, 1], 0.12, 0.08, TILE.vent, { k: 1 });
      gauge([x0 + 0.47, y1 + 0.09, z0 + 0.32], [0, 0, 1], 0.03);
      K.lathe('steel', [[0.001, 0], [0.06, 0], [0.065, 0.025], [0.05, 0.025], [0.045, 0.008], [0.001, 0.008]], M(x1 - 0.4, y1, z0 + 0.5), { segs: 12, tint: 0.6 });
      K.lathe('paintGrey', [[0.001, 0], [0.04, 0], [0.042, 0.095], [0.036, 0.095], [0.034, 0.008], [0.001, 0.008]], M(x1 - 0.25, y1, z1 - 0.2), { segs: 12 });
      model('SchoolChair_01', x1 - 0.5, 0, z1 + 0.32, { ry: PI + 0.4 });
      model('SchoolChair_01', x0 + 0.1, 0, z0 - 0.45, { ry: PI / 2 + 0.3, rz: 0, rx: 0 });
    },

    // ------------------------------------------------------------ bay pallet racking
    rack(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2;
      const bays = Math.round((x1 - x0) / 2.5), bw = (x1 - x0) / bays;
      for (let i = 0; i <= bays; i++) {
        const x = Math.min(x0 + i * bw, x1 - 0.08);
        for (const [za, zb] of [[z0, z0 + 0.08], [z1 - 0.08, z1]]) {
          cb([x, 0.01, za], [x + 0.08, y1, zb], 'paintBlue', { r: 0.008 });
          cb([x - 0.03, 0, za - 0.02], [x + 0.11, 0.012, zb + 0.02], 'steel', { r: 0.003, tint: 0.6 });
          K.bolt([x - 0.015, 0.012, (za + zb) / 2], [0, 1, 0], 1.2); K.bolt([x + 0.095, 0.012, (za + zb) / 2], [0, 1, 0], 1.2);
        }
        // frame bracing (horizontals + diagonals) between front and back upright
        for (let y = 0.15; y < y1 - 0.2; y += 0.9) {
          cb([x + 0.025, y, z0 + 0.07], [x + 0.055, y + 0.03, z1 - 0.07], 'paintBlue', { r: 0.003 });
          const L = Math.hypot(z1 - z0 - 0.14, 0.9), a = Math.atan2(0.9, z1 - z0 - 0.14);
          cb([-0.015, -0.012, -L / 2], [0.015, 0.012, L / 2], 'paintBlue', { matrix: M(x + 0.04, y + 0.45, cz, 0, ((y * 10) | 0) % 2 ? a : -a, 0), r: 0.003 });
        }
        // column guard
        if (z1 < -15) {
          cb([x - 0.04, 0, z1 + 0.01], [x + 0.12, 0.4, z1 + 0.06], 'yellow', { r: 0.01 });
          K.stripes([x - 0.04, 0.2, z1 + 0.06], [x + 0.12, 0.2, z1 + 0.06], [0, 0, 1], 0.16);
        }
      }
      for (const yb of y1 > 5 ? [1.5, 3.0, 4.6] : [1.5, 3.0]) {
        for (const [za, zb] of [[z0 - 0.012, z0 + 0.06], [z1 - 0.06, z1 + 0.012]]) cb([x0 + 0.08, yb, za], [x1 - 0.08, yb + 0.12, zb], 'paintRed', { r: 0.01, tint: 0.9 });
        for (let i = 0; i < bays; i++) {
          const bx0 = x0 + i * bw + 0.08;
          lbl([bx0 + bw / 2, yb + 0.06, z1 + 0.006], [0, 0, 1], 0.3, 0.3, TILE.number, { u0: (i % 4) * 0.25, u1: (i % 4) * 0.25 + 0.25, k: 0.9 });
          // wire deck support bars
          for (const f of [0.3, 0.7]) cb([bx0 + (bw - 0.08) * f, yb + 0.085, z0 + 0.06], [bx0 + (bw - 0.08) * f + 0.04, yb + 0.115, z1 - 0.06], 'steel', { r: 0.003 });
          const two = bw / 2 - 0.02 >= 1.215;   // narrow bays hold one centred pallet
          for (let k = 0; k < (two ? 2 : 1); k++) {
            if (R() < 0.18) continue;
            const px = two ? bx0 + 0.06 + k * (bw / 2 - 0.02) : bx0 + (bw - 0.08 - 1.2) / 2;
            // pallet across the beams (0.8 deep is less than the rack depth: sits on beams)
            const y = yb + 0.12;
            palletAt(px, y, cz - 0.4, { broken: false });
            const c = R();
            if (y1 > 5 && yb > 2) { if (c < 0.85) blockLoad(px + 0.6, y + 0.144, cz); continue; }
            if (c < 0.25) sackLoad(px + 0.6, y + 0.144, cz, 2);
            else if (c < 0.7) boxLoad(px + 0.6, y + 0.144, cz);
            else if (c < 0.9) for (const dx of [0.3, 0.9]) drumCheap(px + dx, y + 0.144, cz + rr(-0.05, 0.05), R() < 0.5 ? 'paintBlue' : 'barrel');
            else for (const dx of [0.33, 0.87]) for (const dz of [-0.2, 0.2]) if (R() < 0.75) crateCheap(px + dx, y + 0.144, cz + dz, rr(-0.05, 0.05));
          }
        }
      }
      // ground level loads
      for (let i = 0; i < bays; i++) {
        if (R() < 0.35) continue;
        const px = x0 + i * bw + 0.3;
        palletAt(px, 0, cz - 0.4);
        if (R() < 0.6) boxLoad(px + 0.6, 0.144, cz); else sackLoad(px + 0.6, 0.144, cz, 3);
      }
    },

    // ------------------------------------------------------------ LPG forklift (forks toward -z)
    forklift(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2;
      const Y = 'forkYellow';
      // wheels
      K.wheel([cx - 0.54, 0.3, z0 + 1.38], 0.3, 0.22, 'x', -1, { rimKey: 'paintRed', rimTint: 0.6 });
      K.wheel([cx + 0.54, 0.3, z0 + 1.38], 0.3, 0.22, 'x', 1, { rimKey: 'paintRed', rimTint: 0.6 });
      K.wheel([cx - 0.55, 0.23, z1 - 0.5], 0.23, 0.18, 'x', -1, { rimKey: 'paintRed', rimTint: 0.6 });
      K.wheel([cx + 0.55, 0.23, z1 - 0.5], 0.23, 0.18, 'x', 1, { rimKey: 'paintRed', rimTint: 0.6 });
      // chassis + body + counterweight
      cb([cx - 0.42, 0.12, z0 + 1.12], [cx + 0.42, 0.63, z1 - 0.18], Y, { r: 0.03, tint: 0.8 });
      cb([cx - 0.62, 0.62, z0 + 1.15], [cx + 0.62, 0.96, z1 - 0.52], Y, { r: 0.05 });
      cb([cx - 0.6, 0.5, z1 - 0.56], [cx + 0.6, 1.16, z1 - 0.02], Y, { r: 0.1 });
      cb([cx - 0.3, 0.14, z1 - 0.32], [cx + 0.3, 0.52, z1 - 0.04], Y, { r: 0.04, tint: 0.85 });
      K.stripes([cx - 0.55, 0.72, z1 - 0.02], [cx + 0.55, 0.72, z1 - 0.02], [0, 0, 1], 0.2, { k: 0.8 });
      for (const s of [-1, 1]) {
        cb([cx + s * 0.48 - 0.06, 1.0, z1 - 0.1], [cx + s * 0.48 + 0.06, 1.08, z1 + 0.0], 'paintRed', { r: 0.01, tint: 1.2 });   // tail lamps
        lbl([cx + s * 0.62, 0.8, z0 + 1.6], [s, 0, 0], 0.3, 0.3, TILE.maker, { k: 0.8 });
      }
      lbl([cx - 0.62, 0.85, z1 - 0.9], [-1, 0, 0], 0.2, 0.2, TILE.warnCrush, { k: 0.95 });
      // fender steps
      for (const s of [-1, 1]) cb([cx + s * 0.62 - 0.12, 0.42, z0 + 1.7], [cx + s * 0.62 + 0.12, 0.45, z0 + 1.95], 'dark', { r: 0.005 });
      // seat
      cb([cx - 0.25, 0.95, z1 - 0.98], [cx + 0.25, 1.04, z1 - 0.5], 'dark', { r: 0.01 });
      cb([cx - 0.23, 1.03, z1 - 0.95], [cx + 0.23, 1.13, z1 - 0.55], 'rubber', { r: 0.04, color: [1.4, 1.4, 1.4] });
      cb([-0.23, 0, -0.04], [0.23, 0.45, 0.04], 'rubber', { matrix: M(cx, 1.12, z1 - 0.53, 0, -0.18), r: 0.04, color: [1.4, 1.4, 1.4] });
      // dash cowl, steering column, wheel, levers
      cb([cx - 0.45, 0.95, z0 + 1.18], [cx + 0.45, 1.22, z0 + 1.48], Y, { r: 0.04, tint: 0.95 });
      lbl([cx, 1.12, z0 + 1.48], [0, 0, 1], 0.24, 0.18, TILE.panel, { k: 0.9 });
      K.pipe('dark', [cx - 0.1, 1.2, z0 + 1.42], [cx - 0.1, 1.5, z0 + 1.6], 0.025, { segs: 8 });
      K.geo('dark', new THREE.TorusGeometry(0.17, 0.016, 6, 20), M(cx - 0.1, 1.52, z0 + 1.62, 0, -PI / 2 + 0.6));
      K.pipe('dark', [cx - 0.1, 1.52, z0 + 1.62], [cx + 0.05, 1.53, z0 + 1.66], 0.01, { segs: 5 });
      for (let i = 0; i < 3; i++) {
        const x = cx + 0.12 + i * 0.07;
        K.pipe('dark', [x, 1.2, z0 + 1.35], [x, 1.42, z0 + 1.45 - i * 0.03], 0.008, { segs: 5 });
        K.pipe(i === 0 ? 'paintRed' : 'dark', [x, 1.42, z0 + 1.45 - i * 0.03], [x, 1.46, z0 + 1.46 - i * 0.03], 0.018, { segs: 8 });
      }
      // overhead guard
      const posts = [[cx - 0.56, z0 + 1.3, 0.95], [cx + 0.56, z0 + 1.3, 0.95], [cx - 0.56, z1 - 0.48, 1.15], [cx + 0.56, z1 - 0.48, 1.15]];
      const BLK = { color: [1.9, 1.9, 1.85] };   // black powder-coat (rubber material is untextured near-black)
      for (const [x, z, yb] of posts) cb([x - 0.03, yb - 0.02, z - 0.03], [x + 0.03, 2.12, z + 0.03], 'rubber', { r: 0.008, ...BLK });
      for (const s of [-1, 1]) cb([cx + s * 0.56 - 0.042, 2.11, z0 + 1.25], [cx + s * 0.56 + 0.042, 2.17, z1 - 0.43], 'rubber', { r: 0.01, ...BLK });
      for (let z = z0 + 1.3; z < z1 - 0.45; z += 0.11) cb([cx - 0.53, 2.125, z], [cx + 0.53, 2.155, z + 0.035], 'rubber', { r: 0.004, ...BLK });
      cb([cx + 0.3, 2.04, z0 + 1.27], [cx + 0.45, 2.11, z0 + 1.35], 'paintGrey', { r: 0.01 });           // work lamp
      // mast: outer + inner channels, cross members, lift cylinder, chains
      for (const s of [-1, 1]) {
        cb([cx + s * 0.36 - 0.04, 0.06, z0 + 1.0], [cx + s * 0.36 + 0.04, 2.2, z0 + 1.12], 'dark', { r: 0.008 });
        cb([cx + s * 0.28 - 0.03, 0.06, z0 + 0.97], [cx + s * 0.28 + 0.03, 2.05, z0 + 1.05], 'dark', { r: 0.006, tint: 0.85 });
        cb([cx + s * 0.18 - 0.012, 0.6, z0 + 1.06], [cx + s * 0.18 + 0.012, 2.0, z0 + 1.08], 'steel', { r: 0.002, tint: 0.4 });   // chain
        lbl([cx + s * 0.36, 1.3, z0 + 1.12 + 0.0], [0, 0, 1], 0.05, 0.6, 14, { k: 0.6 });
      }
      cb([cx - 0.385, 2.1, z0 + 1.02], [cx + 0.385, 2.18, z0 + 1.1], 'dark', { r: 0.008 });
      cb([cx - 0.385, 0.62, z0 + 1.02], [cx + 0.385, 0.7, z0 + 1.1], 'dark', { r: 0.008 });
      K.pipe('steel', [cx, 0.1, z0 + 1.15], [cx, 1.6, z0 + 1.15], 0.055, { segs: 12, tint: 0.5 });
      K.pipe('steel', [cx, 1.6, z0 + 1.15], [cx, 2.08, z0 + 1.15], 0.032, { segs: 10 });
      hose([[cx + 0.1, 0.62, z0 + 1.1], [cx + 0.2, 0.9, z0 + 1.16], [cx + 0.12, 1.3, z0 + 1.13]], 0.012);
      // carriage + load backrest
      cb([cx - 0.56, 0.08, z0 + 0.9], [cx + 0.56, 0.52, z0 + 0.97], 'dark', { r: 0.008 });
      for (let x = cx - 0.5; x <= cx + 0.51; x += 0.125) K.pipe('dark', [x, 0.5, z0 + 0.935], [x, 1.25, z0 + 0.935], 0.012, { segs: 5 });
      cb([cx - 0.56, 1.22, z0 + 0.9], [cx + 0.56, 1.28, z0 + 0.97], 'dark', { r: 0.008 });
      // forks (inside the pallet openings)
      for (const fxp of [cx - 0.35, cx + 0.25]) {
        cb([fxp + 0.01, 0.05, z0 + 0.84], [fxp + 0.09, 0.6, z0 + 0.905], 'steel', { r: 0.008, tint: 0.45 });
        cb([fxp, 0.03, z0 + 0.03], [fxp + 0.1, 0.075, z0 + 0.89], 'steel', { r: 0.008, tint: 0.5 });
      }
      // pallet with sacks on the forks
      palletAt(cx - 0.6, 0, z0 + 0.04, { broken: false, tint: 0.9 });
      cementLoad(cx, 0.144, z0 + 0.44);
      // LPG bottle on the counterweight with strap
      model('propane_tank', cx + 0.3, 1.16 + 0.17, z1 - 0.3, { ry: 0, rz: PI / 2, s: 1.05 });
      for (const dx of [-0.2, 0.2]) cb([cx + dx - 0.02, 1.15, z1 - 0.5], [cx + dx + 0.02, 1.5, z1 - 0.48], 'dark', { r: 0.004 });
    },

    // ------------------------------------------------------------ shipping container (doors at +x end)
    container(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const key = p.key ?? (p.min[2] > 0 ? 'paintRed' : 'paintBlue'), tint = key === 'paintRed' ? 0.85 : 0.95;
      const cp = 0.16;
      // inner dark volume (seen through gaps)
      box([x0 + 0.12, 0.17, z0 + 0.12], [x1 - 0.12, y1 - 0.13, z1 - 0.12], 'dark', { seg: 3 });
      // corner posts and castings
      for (const [a, b] of [[x0, z0], [x1 - cp, z0], [x0, z1 - cp], [x1 - cp, z1 - cp]]) {
        cb([a + 0.01, 0.13, b + 0.01], [a + cp - 0.01, y1 - 0.12, b + cp - 0.01], key, { r: 0.01, tint: tint * 0.8 });
        cb([a, 0, b], [a + cp, 0.14, b + cp], 'dark', { r: 0.008, tint: 1.3 });
        cb([a, y1 - 0.13, b], [a + cp, y1, b + cp], 'dark', { r: 0.008, tint: 1.3 });
      }
      // rails between posts
      for (const [za, zb] of [[z0 + 0.005, z0 + 0.1], [z1 - 0.1, z1 - 0.005]]) {
        cb([x0 + cp, 0.01, za], [x1 - cp, 0.17, zb], key, { r: 0.012, tint: tint * 0.75 });
        cb([x0 + cp, y1 - 0.12, za], [x1 - cp, y1 - 0.005, zb], key, { r: 0.012, tint: tint * 0.85 });
      }
      for (const [xa, xb] of [[x0 + 0.005, x0 + 0.1]]) {
        cb([xa, 0.01, z0 + cp], [xb, 0.17, z1 - cp], key, { r: 0.012, tint: tint * 0.75 });
        cb([xa, y1 - 0.12, z0 + cp], [xb, y1 - 0.005, z1 - cp], key, { r: 0.012, tint: tint * 0.85 });
      }
      // corrugated side walls and end wall
      corrugated(key, 'x', z0 + 0.06, -1, x0 + cp, x1 - cp, 0.17, y1 - 0.12, { tint });
      corrugated(key, 'x', z1 - 0.06, 1, x0 + cp, x1 - cp, 0.17, y1 - 0.12, { tint });
      corrugated(key, 'z', x0 + 0.06, -1, z0 + cp, z1 - cp, 0.17, y1 - 0.12, { tint, pitch: 0.3 });
      box([x0 + cp, y1 - 0.1, z0 + 0.1], [x1 - cp, y1 - 0.03, z1 - 0.1], key, { tint: tint * 0.7, skip: ['ny'] });     // roof
      // doors
      box([x1 - 0.1, 0.01, z0 + cp], [x1 - 0.005, 0.17, z1 - cp], key, { tint: tint * 0.7 });
      box([x1 - 0.1, y1 - 0.2, z0 + cp], [x1 - 0.005, y1 - 0.005, z1 - cp], key, { tint: tint * 0.8 });
      cargoDoors(key, x1 - 0.02, 1, z0 + cp + 0.01, z1 - cp - 0.01, 0.17, y1 - 0.2, { tint: tint * 0.9 });
      lbl([x1 + 0.025, y1 - 0.65, z0 + 0.75], [1, 0, 0], 0.9, 0.9, TILE.stencil, { k: 0.9 });
      lbl([x1 + 0.025, 1.0, z1 - 0.6], [1, 0, 0], 0.35, 0.35, TILE.plate, { k: 0.7 });
      lbl([x0 + 1.2, y1 - 0.7, z1 + 0.001], [0, 0, 1], 1.0, 1.0, TILE.stencil, { k: 0.8 });
      // rust streaks running down from the top rail
      for (let x = x0 + 0.6; x < x1 - 0.4; x += rr(0.5, 1.3)) {
        lbl([x, y1 - 0.75, z1 + 0.001], [0, 0, 1], rr(0.3, 0.6), 1.1, 14, { k: 0.8 });
        lbl([x + 0.3, y1 - 0.75, z0 - 0.001], [0, 0, -1], rr(0.3, 0.6), 1.1, 14, { k: 0.8 });
      }
    },
    trailer(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2;
      const zb = z1 - 0.1;
      cb([x0 + 0.04, 1.22, z0], [x1 - 0.04, y1 - 0.02, zb - 0.06], 'vanWhite', { r: 0.03, tint: 0.85 });
      // side posts and rails
      for (let z = z0 + 0.4; z < zb - 0.3; z += 0.62) for (const s of [-1, 1]) {
        const xs = s < 0 ? x0 + 0.04 : x1 - 0.04;
        cb([xs - (s < 0 ? 0.025 : 0.01), 1.24, z], [xs + (s < 0 ? 0.01 : 0.025), y1 - 0.06, z + 0.06], 'vanWhite', { r: 0.008, tint: 0.75 });
      }
      for (const s of [-1, 1]) {
        const xs = s < 0 ? x0 : x1 - 0.06;
        cb([xs, 1.12, z0 + 0.012], [xs + 0.06, 1.3, zb - 0.08], 'dark', { r: 0.01, tint: 1.2 });
        cb([xs, y1 - 0.1, z0 + 0.012], [xs + 0.06, y1 - 0.012, zb - 0.08], 'vanWhite', { r: 0.01, tint: 0.7 });
      }
      // rear frame, doors
      for (const s of [-1, 1]) cb([s < 0 ? x0 : x1 - 0.14, 1.1, zb - 0.07], [s < 0 ? x0 + 0.14 : x1, y1, zb + 0.02], 'dark', { r: 0.012, tint: 1.4 });
      cb([x0 + 0.14, y1 - 0.18, zb - 0.07], [x1 - 0.14, y1, zb + 0.02], 'dark', { r: 0.012, tint: 1.4 });
      cb([x0 + 0.14, 1.1, zb - 0.07], [x1 - 0.14, 1.3, zb + 0.02], 'dark', { r: 0.012, tint: 1.3 });
      // doors on the plane z = zb (rotated helper works in x: build manually)
      for (const [a, b] of [[x0 + 0.15, cx - 0.008], [cx + 0.008, x1 - 0.15]]) {
        cb([a, 1.31, zb - 0.06], [b, y1 - 0.19, zb + 0.0], 'vanWhite', { r: 0.012, tint: 0.8 });
        for (const f of [0.25, 0.72]) {
          const x = a + (b - a) * f;
          K.pipe('steel', [x, 1.35, zb + 0.04], [x, y1 - 0.22, zb + 0.04], 0.017, { segs: 8, tint: 0.7 });
          for (const y of [1.45, y1 - 0.32]) cb([x - 0.04, y - 0.03, zb - 0.01], [x + 0.04, y + 0.03, zb + 0.045], 'steel', { r: 0.006, tint: 0.6 });
          K.pipe('steel', [x, 2.3, zb + 0.04], [x + (f < 0.5 ? 0.2 : -0.2), 2.3, zb + 0.07], 0.012, { segs: 6 });
        }
        for (let k = 0; k < 4; k++) {
          const y = 1.5 + k * 0.7, he = a < cx ? a + 0.02 : b - 0.02;
          cb([he - 0.03, y - 0.05, zb - 0.01], [he + 0.03, y + 0.05, zb + 0.035], 'steel', { r: 0.006, tint: 0.5 });
        }
      }
      lbl([cx - 0.7, 3.2, zb + 0.004], [0, 0, 1], 0.6, 0.6, TILE.stencil, { k: 0.7 });
      lbl([cx + 0.7, 2.6, zb + 0.004], [0, 0, 1], 0.5, 1.0, 14, { k: 0.75 });
      // chassis beams, landing gear, axles, bumper, lights
      for (const s of [-1, 1]) cb([cx + s * 0.5 - 0.06, 0.85, z0 + 0.2], [cx + s * 0.5 + 0.06, 1.13, zb - 0.1], 'dark', { r: 0.01 });
      for (const s of [-1, 1]) {
        cb([cx + s * 0.85 - 0.05, 0.1, z0 + 2.2], [cx + s * 0.85 + 0.05, 1.0, z0 + 2.3], 'dark', { r: 0.008 });
        cb([cx + s * 0.85 - 0.15, 0, z0 + 2.1], [cx + s * 0.85 + 0.15, 0.1, z0 + 2.4], 'dark', { r: 0.01 });
      }
      for (const za of [zb - 1.6, zb - 2.9]) {
        K.pipe('dark', [x0 + 0.2, 0.5, za], [x1 - 0.2, 0.5, za], 0.06, { segs: 10 });
        for (const s of [-1, 1]) {
          K.wheel([s < 0 ? x0 + 0.17 : x1 - 0.17, 0.5, za], 0.5, 0.26, 'x', s, { lugs: 10 });
          K.wheel([s < 0 ? x0 + 0.45 : x1 - 0.45, 0.5, za], 0.5, 0.26, 'x', -s, { lugs: 10, rimTint: 0.6 });
        }
      }
      for (const s of [-1, 1]) cb([s < 0 ? x0 + 0.05 : x1 - 0.6, 0.15, zb - 0.65], [s < 0 ? x0 + 0.6 : x1 - 0.05, 0.75, zb - 0.62], 'rubber', { r: 0.005, color: [1.3, 1.3, 1.3] });  // mud flaps
      cb([x0 + 0.2, 0.42, zb - 0.06], [x1 - 0.2, 0.58, zb + 0.02], 'dark', { r: 0.02 });
      K.stripes([x0 + 0.25, 0.5, zb + 0.02], [x1 - 0.25, 0.5, zb + 0.02], [0, 0, 1], 0.14, { k: 0.9 });
      for (const s of [-1, 1]) {
        cb([cx + s * 0.95 - 0.04, 0.55, zb - 0.045], [cx + s * 0.95 + 0.04, 1.1, zb - 0.0], 'dark', { r: 0.008 });
        cb([cx + s * 1.1 - 0.12, 1.12, zb - 0.0], [cx + s * 1.1 + 0.12, 1.2, zb + 0.03], 'paintRed', { r: 0.01, tint: 1.3 });
      }
      cb([cx - 0.26, 0.98, zb], [cx + 0.26, 1.09, zb + 0.015], 'vanWhite', { r: 0.004, tint: 1.3 });
    },
    dumpster(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2;
      K.hull('paint', 0.16, [x0 + 0.12, z0 + 0.16, x1 - 0.12, z1 - 0.16], y1 - 0.12, [x0 + 0.03, z0 + 0.03, x1 - 0.03, z1 - 0.03], { tint: 0.8 });
      // rim
      for (const [a, b] of [[[x0, y1 - 0.17, z0], [x1, y1 - 0.08, z0 + 0.06]], [[x0, y1 - 0.17, z1 - 0.06], [x1, y1 - 0.08, z1]], [[x0, y1 - 0.17, z0 + 0.06], [x0 + 0.06, y1 - 0.08, z1 - 0.06]], [[x1 - 0.06, y1 - 0.17, z0 + 0.06], [x1, y1 - 0.08, z1 - 0.06]]]) cb(a, b, 'paint', { r: 0.01, tint: 0.7 });
      // vertical ribs + side lift pockets
      for (const x of [x0 + 0.35, cx, x1 - 0.35]) for (const s of [-1, 1]) {
        const z = s < 0 ? z0 + 0.1 : z1 - 0.1;
        const m = M(x, 0.16, z, 0, s * 0.07, 0);
        cb([-0.04, 0, -0.04], [0.04, y1 - 0.34, 0.04], 'paint', { matrix: m, r: 0.008, tint: 0.7 });
      }
      for (const s of [-1, 1]) cb([x0 + 0.2, 0.5, s < 0 ? z0 + 0.02 : z1 - 0.14], [x1 - 0.2, 0.62, s < 0 ? z0 + 0.14 : z1 - 0.02], 'steel', { r: 0.01, tint: 0.55 });
      // casters
      for (const [a, b] of [[x0 + 0.25, z0 + 0.3], [x1 - 0.25, z0 + 0.3], [x0 + 0.25, z1 - 0.3], [x1 - 0.25, z1 - 0.3]]) {
        cb([a - 0.06, 0.15, b - 0.05], [a + 0.06, 0.17, b + 0.05], 'steel', { r: 0.004, tint: 0.5 });
        K.wheel([a - 0.035, 0.075, b], 0.075, 0.05, 'x', 1, { segs: 12, lugs: 0 });
      }
      // lids: one closed, one thrown open
      cb([x0, y1 - 0.08, z0], [cx - 0.01, y1 - 0.04, z1], 'dark', { r: 0.012, tint: 1.2 });
      cb([0, 0, -(z1 - z0)], [x1 - cx - 0.01, 0.04, 0], 'dark', { matrix: M(cx + 0.01, y1 - 0.06, z0 + 0.01, 0, 1.9, 0), r: 0.012, tint: 1.1 });
      model('trashbag', cx + 0.45, y1 - 0.42, (z0 + z1) / 2, { s: 0.95 });
      model('trashbag', cx + 0.2, y1 - 0.35, (z0 + z1) / 2 + 0.15, { s: 0.9 });
      lbl([x0 + 0.5, 0.75, z1 - 0.09], [0, 0.07, 1], 0.3, 0.3, TILE.number, { u0: 0.5, u1: 0.75 });
      lbl([x1 - 0.5, 0.8, z1 - 0.09], [0, 0.07, 1], 0.5, 0.8, 14, { k: 0.8 });
    },

    // ------------------------------------------------------------ panel van (front toward +z)
    van(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2;
      const key = 'vanWhite', t = p.tint ?? 1.0;
      const wf = z1 - 1.0, wr = z0 + 0.95, wr2 = 0.36;
      // lower body around wheel arches
      const segs = [[z0 + 0.03, wr - 0.44], [wr + 0.44, wf - 0.44], [wf + 0.44, z1 - 0.06]];
      for (const [a, b] of segs) cb([x0 + 0.03, 0.34, a], [x1 - 0.03, 0.8, b], key, { r: 0.05, tint: t });
      for (const zw of [wr, wf]) {
        cb([x0 + 0.018, 0.74, zw - 0.45], [x1 - 0.018, 0.84, zw + 0.45], key, { r: 0.03, tint: t * 0.95 });   // wheel-arch lip, 12 mm proud
        cb([x0 + 0.26, 0.3, zw - 0.43], [x1 - 0.26, 0.76, zw + 0.43], 'dark', { r: 0.02 });                       // arch liners
        K.wheel([x0 + 0.15, wr2, zw], wr2, 0.21, 'x', -1, { rimKey: 'steel', rimTint: 0.55 });
        K.wheel([x1 - 0.15, wr2, zw], wr2, 0.21, 'x', 1, { rimKey: 'steel', rimTint: 0.55 });
      }
      // upper cargo box + cab
      cb([x0 + 0.04, 0.79, z0 + 0.04], [x1 - 0.04, 1.25, z1 - 0.07], key, { r: 0.04, tint: t });
      cb([x0 + 0.05, 1.24, z0 + 0.03], [x1 - 0.05, y1, z1 - 1.35], key, { r: 0.1, tint: t });
      K2.hull(key, 1.24, [x0 + 0.05, z1 - 1.35, x1 - 0.05, z1 - 0.62], y1 - 0.18, [x0 + 0.09, z1 - 1.35, x1 - 0.09, z1 - 1.05], { tint: t });
      // windscreen + side windows (dark glass, 9 mm proud)
      // windscreen: dark glass quad 1 cm proud of the sloped cab front
      const wsN = v3(0, (z1 - 0.62) - (z1 - 1.05), (y1 - 0.18) - 1.24).normalize();
      const wsUp = v3(0, (y1 - 0.18) - 1.24, (z1 - 1.05) - (z1 - 0.62)).normalize();
      const wsC = v3(cx, (1.24 + y1 - 0.18) / 2, (z1 - 0.62 + z1 - 1.05) / 2).addScaledVector(wsN, 0.01);
      const hw = (x1 - x0 - 0.34) / 2, hh = 0.34;
      K.poly('glassDark', [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => wsC.clone().add(v3(a * hw, 0, 0)).addScaledVector(wsUp, b * hh)), wsN.toArray());
      for (const s of [-1, 1]) {
        // side window on the (slightly inward-leaning) cab side, 1 cm proud
        const sideX = (y) => (s < 0 ? x0 + 0.05 + 0.04 * (y - 1.24) / (y1 - 1.42) : x1 - 0.05 - 0.04 * (y - 1.24) / (y1 - 1.42)) + s * 0.01;
        const ya = 1.3, yb = y1 - 0.27;
        K.poly('glassDark', [[sideX(ya), ya, z1 - 1.3], [sideX(ya), ya, z1 - 0.75], [sideX(yb), yb, z1 - 1.08], [sideX(yb), yb, z1 - 1.3]], [s, 0, 0]);
        const xs = s < 0 ? x0 + 0.045 : x1 - 0.045;
        // door seam strip (1 cm proud of the lower body), handles, mirror
        for (const [ya, yb] of [[0.4, 0.72], [0.86, 1.22]]) cb([s < 0 ? x0 + 0.02 : x1 - 0.04, ya, z1 - 1.37], [s < 0 ? x0 + 0.04 : x1 - 0.02, yb, z1 - 1.355], 'dark', { r: 0.002 });
        const hx = s < 0 ? x0 + 0.02 : x1 - 0.02;
        cb([Math.min(hx, hx + s * 0.03), 1.05, z1 - 1.25], [Math.max(hx, hx + s * 0.03), 1.08, z1 - 1.12], 'dark', { r: 0.006 });
        cb([Math.min(hx, hx + s * 0.03), 1.05, wr + 0.6], [Math.max(hx, hx + s * 0.03), 1.08, wr + 0.75], 'dark', { r: 0.006 });
        K.pipe('dark', [xs, 1.3, z1 - 0.75], [xs + s * 0.16, 1.4, z1 - 0.78], 0.012, { segs: 5 });
        cb([xs + s * 0.13 - 0.04, 1.32, z1 - 0.82], [xs + s * 0.13 + 0.06, 1.55, z1 - 0.76], 'dark', { r: 0.015 });
        lbl([s < 0 ? x0 + 0.03 : x1 - 0.03, 0.6, wr + 0.6], [s, 0, 0], 0.5, 0.5, 14, { k: 0.75, rot: PI });
        lbl([s < 0 ? x0 + 0.03 : x1 - 0.03, 0.62, wf - 0.6], [s, 0, 0], 0.4, 0.4, 14, { k: 0.75, rot: PI });
      }
      // front: bumper, grille, lamps, plate
      cb([x0 + 0.01, 0.3, z1 - 0.13], [x1 - 0.01, 0.5, z1], 'dark', { r: 0.05 });
      lbl([cx, 0.68, z1 - 0.06], [0, 0, 1], 0.9, 0.24, TILE.vent, { k: 0.9 });
      for (const s of [-1, 1]) cb([cx + s * 0.68 - 0.13, 0.6, z1 - 0.07], [cx + s * 0.68 + 0.13, 0.76, z1 - 0.045], 'paintGrey', { r: 0.02, tint: 1.6 });
      cb([cx - 0.26, 0.36, z1], [cx + 0.26, 0.47, z1 + 0.012], 'paintGrey', { r: 0.004, tint: 1.4 });
      // rear: bumper, doors seam, handle, lamps
      cb([x0 + 0.01, 0.3, z0], [x1 - 0.01, 0.48, z0 + 0.12], 'dark', { r: 0.05 });
      cb([cx - 0.006, 0.55, z0 + 0.02], [cx + 0.006, y1 - 0.1, z0 + 0.04], 'dark', { r: 0.002 });
      cb([cx + 0.05, 1.05, z0 + 0.01], [cx + 0.18, 1.08, z0 + 0.04], 'dark', { r: 0.006 });
      for (const s of [-1, 1]) cb([cx + s * 0.88 - 0.06, 0.6, z0 + 0.0], [cx + s * 0.88 + 0.06, 0.95, z0 + 0.04], 'paintRed', { r: 0.01, tint: 1.3 });
      lbl([cx - 0.5, 1.4, z0 + 0.025], [0, 0, -1], 0.7, 1.0, 14, { k: 0.75 });
    },

    // ------------------------------------------------------------ jersey barrier (extruded profile)
    barrier(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2, hw = (z1 - z0) / 2;
      const prof = [[-hw, 0], [-hw, 0.08], [-hw * 0.65, 0.26], [-hw * 0.32, y1], [hw * 0.32, y1], [hw * 0.65, 0.26], [hw, 0.08], [hw, 0]];
      const tint = rr(0.8, 1.0);
      for (let i = 0; i < prof.length - 1; i++) {
        const [za, ya] = prof[i], [zb, yb] = prof[i + 1];
        const nz = (yb - ya), ny = -(zb - za);
        const steps = 3;
        for (let s = 0; s < steps; s++) {
          const xa = x0 + (x1 - x0) * s / steps, xb = x0 + (x1 - x0) * (s + 1) / steps;
          K.poly('concreteOut', [[xa, ya, cz + za], [xb, ya, cz + za], [xb, yb, cz + zb], [xa, yb, cz + zb]], [0, -ny, -nz], { tint });
        }
      }
      for (const [x, s] of [[x0, -1], [x1, 1]]) K.poly('concreteOut', prof.map(([z, y]) => [x, y, cz + z]), [s, 0, 0], { tint: tint * 0.9 });
      {
        // stripes on the +z upper slope face (from (0.65hw, 0.26) to (0.32hw, y1))
        const dz = -0.33 * hw, dy = y1 - 0.26, L = Math.hypot(dz, dy);
        const n = [0, -dz / L, dy / L];
        const zc = cz + hw * 0.485, yc = (0.26 + y1) / 2;
        K.stripes([x0 + 0.1, yc, zc], [x1 - 0.1, yc, zc], n, 0.2, { k: 0.6, up: [0, dy / L, dz / L] });
      }
      for (const x of [x0 + 0.4, x1 - 0.4]) K.geo('steel', new THREE.TorusGeometry(0.05, 0.01, 5, 10, PI), M(x, y1 - 0.005, cz), { tint: 0.5 });
    },
    railing(p) {
      const [ax, az] = p.from, [bx, bz] = p.to;
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 1.4));
      const yA = p.slope ? p.slope[0] : p.y, yB = p.slope ? p.slope[1] : p.y;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = yA + (yB - yA) * t;
        // railings sharing a corner must not draw (nearly) the same post twice
        if (postSeen.some(([px, py, pz]) => Math.hypot(px - x, pz - z) < 0.2 && Math.abs(py - y) < 0.2)) continue;
        postSeen.push([x, y, z]);
        cb([x - 0.03, y + 0.004, z - 0.03], [x + 0.03, y + 1.05, z + 0.03], 'yellow', { r: 0.006 });
        cb([x - 0.06, y, z - 0.06], [x + 0.06, y + 0.012, z + 0.06], 'steel', { r: 0.003, tint: 0.6 });
      }
      for (const h of [0.5, 1.05]) B.pipe('yellow', [ax, yA + h, az], [bx, yB + h, bz], 0.025, { segs: 8 });
    },

    // ------------------------------------------------------------ collider-backed clutter groups
    gasbottles(p) {
      const [x0, , z0] = p.min, [x1, , z1] = p.max;
      model('propane_tank', x0 + 0.17, 0, z1 - 0.17, { s: 1.0 });
      model('propane_tank', x1 - 0.17, 0, z1 - 0.18, { s: 0.95 });
      model('propane_tank', (x0 + x1) / 2, 0, z0 + 0.17, { s: 1.0, rz: 0.05 });
      K.pipe('dark', [x0, 0.4, z1 + 0.03], [x1, 0.4, z1 + 0.03], 0.008, { segs: 5 });
    },
    wetsign(p) {
      model('WetFloorSign_01', (p.min[0] + p.max[0]) / 2, 0, (p.min[2] + p.max[2]) / 2, { ry: -PI / 2 + 0.3 });
    },
    chair(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      if (p.kind === 'mono') model('plastic_monobloc_chair_01', cx, 0, cz, { ry: rr(2.4, 3.2), tint: 0.75 });
      else model('SchoolChair_01', cx, 0, cz, { ry: (p.facing > 0 ? 0 : PI) + rr(-0.5, 0.5) });
    },
    plasticcrates(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      for (let l = 0; l < 3; l++) model('plastic_crate_02', cx + rr(-0.02, 0.02), l * 0.245, cz + rr(-0.02, 0.02), { ry: PI / 2 + rr(-0.08, 0.08) });
      model('plastic_crate_02', cx + 0.02, 0.735, cz, { ry: PI / 2 + 0.3, rz: 0.0 });
    },
    reel(p) {
      const [x0, , z0] = p.min, [x1, , z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = 0.5;
      for (const z of [z0 + 0.02, z1 - 0.06]) K.pipe('woodDark', [cx, r, z], [cx, r, z + 0.04], r, { segs: 20, tint: 0.85 });
      K.pipe('rubber', [cx, r, z0 + 0.06], [cx, r, z1 - 0.06], 0.38, { segs: 18, color: [1.2, 1.2, 1.2] });
      for (let i = 0; i < 6; i++) { const a = i / 6 * PI * 2; K.bolt([cx + Math.cos(a) * 0.15, r + Math.sin(a) * 0.15, z1 - 0.02], [0, 0, 1], 1.6); }
      lbl([cx, r, z1 - 0.02 + 0.001], [0, 0, 1], 0.3, 0.3, TILE.warnVolt, { k: 0.8 });
      hose([[cx + 0.38, 0.5, cz], [cx + 0.6, 0.15, cz + 0.1], [cx + 0.9, 0.02, cz + 0.6], [cx + 0.6, 0.02, cz + 1.4], [cx - 0.4, 0.02, cz + 1.7]], 0.02);
    },
    handtruck(p) {
      model('hand_truck', (p.min[0] + p.max[0]) / 2 - 0.02, 0, (p.min[2] + p.max[2]) / 2, { ry: -PI / 2, rx: 0 });
    },
    drumlying(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      model('Barrel_01', cx - 0.42, 0.28, cz, { ry: 0, rz: -PI / 2, variant: 'oxide_grey', s: [1, 0.95, 1] });
    },
    utility(p) {
      const [x0, , z0] = p.min, [x1, , z1] = p.max;
      const zc = (z0 + z1) / 2;
      for (let i = 0; i < 2; i++) {
        const x = x0 + 0.27 + i * 0.56;
        model('utility_box_01', x, 0, zc, { ry: 0, s: [1, 1 - i * 0.12, 1] });
      }
      K.pipe('steel', [x0 + 0.27, 1.1, zc - 0.05], [x0 + 0.27, 2.6, zc - 0.05], 0.03, { segs: 8, tint: 0.6 });
      K.pipe('steel', [x0 + 0.83, 0.95, zc - 0.05], [x0 + 0.83, 2.6, zc - 0.05], 0.025, { segs: 8, tint: 0.6 });
    },
    tyres(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      const n = p.n ?? 4;
      for (let i = 0; i < n; i++) model('old_tyre', cx + rr(-0.04, 0.04), 0.0825 + i * 0.165, cz + rr(-0.04, 0.04), { rx: PI / 2, ry: rr(0, 6), rz: rr(-0.04, 0.04) });
    },
    trashbags(p) {
      const [x0, , z0] = p.min, [x1, , z1] = p.max;
      model('trashbag', x0 + 0.25, 0, z0 + 0.25, { s: rr(0.85, 1.0) });
      model('trashbag', x1 - 0.25, 0, z1 - 0.25, { s: rr(0.8, 1.0) });
      model('trashbag', x0 + 0.3, 0, z1 - 0.2, { s: 0.75, rz: 0.4 });
    },
  };

  Object.assign(builders, extraBuilders({ K, K2, B, PB, R, rr, pick, cb, box, lbl, model, hose, carton, palletAt, cementLoad, boxLoad, corrugated, cargoDoors, handle, gauge, estop, handwheel, inst, layout }));
  // Props standing on another floor (upper storey, basement, stacked containers) are built at y = 0 and lifted.
  const lift = (dy, fn) => {
    if (!dy) { fn(); return; }
    const mark = (bat) => new Map([...bat.buckets].map(([k, b]) => [k, b.pos.length]));
    const mB = mark(B), mPB = mark(PB);
    const nL = K.labels.pos.length, nG = K.glass.pos.length, nBo = K.bolts.length, nM = inst.models.length;
    const nPa = inst.papers.length, nRo = inst.rollers.length, nDe = inst.debris.length;
    B._dy = PB._dy = dy;
    try { fn(); } finally { B._dy = PB._dy = 0; }
    for (const [bat, m] of [[B, mB], [PB, mPB]]) for (const [k, b] of bat.buckets) for (let i = (m.get(k) || 0) + 1; i < b.pos.length; i += 3) b.pos[i] += dy;
    for (let i = nL + 1; i < K.labels.pos.length; i += 3) K.labels.pos[i] += dy;
    for (let i = nG + 1; i < K.glass.pos.length; i += 3) K.glass.pos[i] += dy;
    for (let i = nBo; i < K.bolts.length; i++) K.bolts[i][1] += dy;
    for (let i = nM; i < inst.models.length; i++) inst.models[i].y += dy;
    for (let i = nPa; i < inst.papers.length; i++) inst.papers[i][1] += dy;
    for (let i = nRo; i < inst.rollers.length; i++) inst.rollers[i][1] += dy;
    for (let i = nDe; i < inst.debris.length; i++) inst.debris[i][4] = (inst.debris[i][4] || 0) + dy;
  };
  for (const p of layout.props) {
    const fn = builders[p.type];
    if (!fn) continue;
    const dy = p.min ? p.min[1] : 0;
    if (!dy) fn(p);
    else lift(dy, () => fn({ ...p, min: [p.min[0], 0, p.min[2]], max: [p.max[0], p.max[1] - dy, p.max[2]] }));
  }
  inst.builderTypes = Object.keys(builders);

  // ---- doors: frames, open leaves, the loading door roller shutter
  for (const d of layout.doors) {
    const y0 = d.y || 0, h = y0 + d.height, [a0, a1] = d.a, t0 = d.t0 - 0.02, t1 = d.t1 + 0.02, f = 0.06;
    if (d.axis === 'x') {
      box([a0, y0, t0], [a0 + f, h, t1], 'steel'); box([a1 - f, y0, t0], [a1, h, t1], 'steel'); box([a0 + f, h - f, t0], [a1 - f, h, t1], 'steel');
    } else {
      box([t0, y0, a0], [t1, h, a0 + f], 'steel'); box([t0, y0, a1 - f], [t1, h, a1], 'steel'); box([t0, h - f, a0 + f], [t1, h, a1 - f], 'steel');
    }
    if (d.leafBox && !d.dyn) {
      const lb = d.leafBox;
      cb(lb.min, lb.max, 'rust', { r: 0.008 });
      // handle on both faces of the leaf
      const thin = lb.max[0] - lb.min[0] < 0.1 ? 0 : 2;
      const hy = y0 + 1.0, c = [(lb.min[0] + lb.max[0]) / 2, hy, (lb.min[2] + lb.max[2]) / 2];
      if (thin === 0) { for (const s of [-1, 1]) handle([s < 0 ? lb.min[0] : lb.max[0], hy, c[2] - 0.06], [s < 0 ? lb.min[0] : lb.max[0], hy, c[2] + 0.06], [s, 0, 0], 0.008); }
      else { for (const s of [-1, 1]) handle([c[0] - 0.06, hy, s < 0 ? lb.min[2] : lb.max[2]], [c[0] + 0.06, hy, s < 0 ? lb.min[2] : lb.max[2]], [0, 0, s], 0.008); }
    }
    if (d.shutter) {
      const z = d.t0 - 0.12;
      for (let y = h - 1.2; y < h; y += 0.1) box([a0 + 0.05, y, z - 0.04], [a1 - 0.05, y + 0.09, z], 'corrugated', { tint: 0.85 + 0.1 * Math.sin(y * 7) });
      B.pipe('rust', [a0, h + 0.3, z - 0.2], [a1, h + 0.3, z - 0.2], 0.3, { segs: 14 });
      box([a0 - 0.15, 0, z - 0.1], [a0, h + 0.6, z], 'steel'); box([a1, 0, z - 0.1], [a1 + 0.15, h + 0.6, z], 'steel');
      K.stripes([a0 - 0.15, 1.0, z], [a0, 1.0, z], [0, 0, 1], 0.6, { k: 0.8 });
    }
  }
  // ---- window frames (mullions)
  for (const w of layout.windows) {
    const [x0, y0, z0] = w.min, [x1, y1, z1] = w.max, f = 0.05;
    if (w.normal === 'z') {
      const zc = (z0 + z1) / 2;
      // sill/head rails 6 cm deep, mullions 4.4 cm (recessed 8 mm each side), transom between the end mullions
      box([x0, y0, zc - 0.03], [x1, y0 + f, zc + 0.03], 'steel'); box([x0, y1 - f, zc - 0.03], [x1, y1, zc + 0.03], 'steel');
      for (let x = x0; x <= x1 + 1e-3; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 0.75))) box([Math.min(x, x1 - f), y0 + f, zc - 0.022], [Math.min(x + f, x1), y1 - f, zc + 0.022], 'steel');
      if (y1 - y0 > 1.4) box([x0 + f, (y0 + y1) / 2, zc - 0.03], [x1 - f, (y0 + y1) / 2 + f, zc + 0.03], 'steel');
    } else {
      const xc = (x0 + x1) / 2;
      box([xc - 0.03, y0, z0], [xc + 0.03, y0 + f, z1], 'steel'); box([xc - 0.03, y1 - f, z0], [xc + 0.03, y1, z1], 'steel');
      for (let z = z0; z <= z1 + 1e-3; z += (z1 - z0) / Math.max(1, Math.round((z1 - z0) / 0.75))) box([xc - 0.022, y0 + f, Math.min(z, z1 - f)], [xc + 0.022, y1 - f, Math.min(z + f, z1)], 'steel');
      if (y1 - y0 > 1.4) box([xc - 0.03, (y0 + y1) / 2, z0 + f], [xc + 0.03, (y0 + y1) / 2 + f, z1 - f], 'steel');
    }
  }

  // ---- roof trusses, purlins, pipes, cable trays
  for (let z = -4.5; z < 15.6; z += 4) {
    box([-23.6, 7.55, z - 0.1], [7.8, 7.95, z + 0.1], 'steel');
    for (let x = -21; x < 7.8; x += 3) {
      const m = new THREE.Matrix4().makeRotationZ(((Math.round(x) % 2) ? 1 : -1) * 0.55).setPosition(x, 7.0, z);
      B.boxXf([-0.04, 0, -0.04], [0.04, 0.9, 0.04], 'steel', m);
    }
    box([-23.6, 6.95, z - 0.08], [7.8, 7.05, z + 0.08], 'steel');
  }
  for (let x = -22; x < 7.8; x += 3.5) box([x - 0.05, 7.95, -5.8], [x + 0.05, 8.0, 15.6], 'steel');
  for (let z = -16; z < -6.2; z += 3.5) box([-23.6, 6.6, z - 0.1], [19.6, 6.95, z + 0.1], 'steel');
  B.pipe('rust', [-23.3, 6.2, -5.8], [-23.3, 6.2, 15.3], 0.14);
  B.pipe('paint', [-23.1, 5.8, -5.8], [-23.1, 5.8, 15.3], 0.08);
  B.pipe('rust', [-23.3, 6.2, 15.3], [7.5, 6.2, 15.3], 0.14);
  B.pipe('rust', [7.5, 6.2, 15.3], [7.5, 0.4, 15.3], 0.14);
  B.pipe('paint', [-23.1, 5.8, 15.1], [-23.1, 0.3, 15.1], 0.08);
  B.pipe('rust', [-23.3, 5.6, -17.3], [19.3, 5.6, -17.3], 0.16);
  B.pipe('paintGrey', [-23.3, 5.2, -17.2], [19.3, 5.2, -17.2], 0.07);
  for (const x of [-12, 0, 10.2]) B.pipe('rust', [x, 5.6, -17.3], [x, 0.3, -17.3], 0.12);
  // pipe flanges + wall brackets
  for (let z = -4; z < 15; z += 3) { K.pipe('steel', [-23.3, 6.2, z], [-23.3, 6.2, z + 0.05], 0.19, { segs: 14, tint: 0.6 }); cb([-23.6, 6.0, z + 0.4], [-23.12, 6.05, z + 0.48], 'steel', { r: 0.004, tint: 0.6 }); }
  for (let x = -20; x < 18; x += 3) { K.pipe('steel', [x, 5.6, -17.3], [x + 0.05, 5.6, -17.3], 0.21, { segs: 14, tint: 0.6 }); cb([x + 0.4, 5.38, -17.6], [x + 0.48, 5.43, -17.1], 'steel', { r: 0.004, tint: 0.6 }); }
  box([10.0, 2.85, -5.8], [10.45, 2.9, 15.6], 'steel');
  B.pipe('paintGrey', [8.45, 2.95, -5.8], [8.45, 2.95, 15.6], 0.06);
  B.pipe('rust', [8.65, 3.0, -5.8], [8.65, 3.0, 15.6], 0.05);
  for (let i = 0; i < 9; i++) {
    const x0 = rr(-22, 6), z0 = rr(-5, 15), x1 = x0 + rr(-6, 6), z1 = z0 + rr(-4, 4);
    catenary(B, [x0, 7.5, z0], [Math.max(-23, Math.min(7.4, x1)), 7.5, Math.max(-5.5, Math.min(15.2, z1))], rr(0.6, 2.2));
  }
  for (let i = 0; i < 4; i++) {
    const x = rr(-20, 5), z = rr(-4, 14);
    B.pipe('rubber', [x, 7.5, z], [x + rr(-0.2, 0.2), rr(3.8, 5.5), z + rr(-0.2, 0.2)], 0.012, { segs: 5 });
  }
  for (const [a, b] of [[[-13, 12.7], [-18, 13.5]], [[3.2, 13.2], [0.5, 14.8]], [[-8, -9.4], [-11.5, -7.5]]]) floorCable(B, a, b, R);

  scatterClutter({ K, B, R, rr, model, cb, lbl, inst, nearDoor, carton, palletAt, hose });
  dressAreas({ K, K2, B, PB, R, rr, pick, cb, box, lbl, model, hose, carton, palletAt, cementLoad, boxLoad, corrugated, handle, gauge, estop, handwheel, inst, layout, nearDoor, lift, catenary, floorCable });

  // ---- debris: concrete chunks, bricks, papers (instanced)
  const debrisSpots = [[-12.5, 5.5, 2.2], [-2, -2, 1.5], [-8, -12, 2], [8, -12, 2.5], [15, 2, 2], [-20, 9, 2], [9.4, 6, 1.0], [-5, 13.5, 2.0], [15, -10, 2], [-2, 19, 3], [10, 23, 4]];
  for (const [cx, cz, r] of debrisSpots) {
    const n = Math.round(r * 9);
    for (let i = 0; i < n; i++) {
      const a = R() * PI * 2, d = Math.sqrt(R()) * r;
      inst.debris.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d, rr(0.03, 0.14), R()]);
    }
    for (let i = 0; i < r * 2; i++) inst.papers.push([cx + rr(-r, r), 0.004 + R() * 0.004, cz + rr(-r, r), R() * 6]);
  }
  for (let i = 0; i < 40; i++) inst.bricks.push([rr(-15, -10), rr(3.5, 7.5), R()]);

  inst.bolts = K.bolts;
  inst.ownGeo = PB.build();
  inst.labelGeo = K.buildLabels();
  inst.glassGeo = K.buildLabels(K.glass);
  if (typeof window !== 'undefined') prefetchModels(inst.models);
  return inst;
}

// ------------------------------------------------------------------ small clutter that makes spaces feel used
// No colliders: everything here is low (< 0.3 m) or sits against walls / props where the player cannot reach.
function scatterClutter({ K, B, R, rr, model, cb, lbl, inst, nearDoor, carton, palletAt, hose }) {
  const ok = (x, z) => !nearDoor(x, z, 1.25);
  // rusty cans, some knocked over
  const cans = [[-3.2, 15.25], [-3.05, 15.38], [-6.1, 15.3], [-11.2, 5.75], [-11.35, 5.62], [-7.3, 2.2], [2.75, 13.5], [5.6, 13.4],
    [-20.2, 11.95], [-18.3, 11.95], [10.4, -5.5], [10.45, 15.35], [12.2, 15.3], [19.3, 9.9], [11.3, 4.4], [19.3, 0.0], [11.2, -5.5],
    [-1.8, -15.4], [-10.6, -12.3], [-6.8, -9.2], [18.3, -6.6], [-22.9, -6.8], [2.3, 18.6], [-16.8, 17.0], [-11.8, 22.5], [16.0, 17.2], [12.6, 23.6]];
  for (const [x, z] of cans) {
    if (!ok(x, z)) continue;
    if (R() < 0.4) { const s = rr(1.0, 1.5); model('can_rusted', x, 0.062 * s, z, { rx: PI / 2, ry: rr(0, 6), s }); }
    else model('can_rusted', x, 0, z, { s: rr(1.0, 1.6) });
  }
  // jerry cans
  for (const [x, z, ry] of [[2.75, 14.45, 0.3], [-7.0, -9.5, 1.4], [-6.75, -9.75, 1.9], [-21.2, -10.6, 0.2], [17.3, 17.0, 2.0], [-17.9, 14.95, -0.2]]) model('plastic_jerrycan', x, 0, z, { ry, tint: rr(0.75, 1) });
  // lone tyres and a tyre against the fence
  model('old_tyre', -10.6, 0.0825, 9.2, { rx: PI / 2, ry: 0.4 });
  model('old_tyre', 15.6, 0.0825, -16.6, { rx: PI / 2, ry: 1.0 });
  model('old_tyre', 1.2, 0.3, 25.62, { rx: -0.25, ry: 0 });
  model('old_tyre', -5.0, 0.0825, 25.2, { rx: PI / 2 });
  // rubbish bags in dead corners
  for (const [x, z, s] of [[-23.05, 15.05, 1.0], [-22.6, 15.2, 0.8], [10.25, -5.35, 0.85], [19.1, 15.15, 0.8], [-23.2, -17.15, 0.9], [7.4, 15.15, 0.9]]) model('trashbag', x, 0, z, { s });
  // fire extinguishers on a pillar and walls (protrude less than the player radius)
  // procedural 6 kg extinguishers on wall brackets (wall point, outward normal)
  const ext = [[-6.5, 8.3, 0, 1], [8.2, 4.5, 1, 0], [2.0, -17.6, 0, 1], [10.6, 11.6, -1, 0]];
  for (const [wx, wz, nx, nz] of ext) {
    const x = wx + nx * 0.11, z = wz + nz * 0.11, y0 = 0.62;
    K.lathe('paintRed', [[0.001, 0], [0.072, 0], [0.078, 0.012], [0.078, 0.4], [0.07, 0.45], [0.045, 0.48], [0.022, 0.49], [0.001, 0.49]], M(x, y0, z), { segs: 16, tint: 1.25 });
    K.lathe('dark', [[0.001, 0.48], [0.024, 0.48], [0.024, 0.53], [0.016, 0.55], [0.001, 0.55]], M(x, y0, z), { segs: 10 });
    cb([-0.012, 0, -0.075], [0.012, 0.017, 0.035], 'dark', { matrix: M(x, y0 + 0.535, z, Math.atan2(nx, nz)), r: 0.004 });
    hose([[x + nz * 0.02, y0 + 0.52, z - nx * 0.02], [x + nz * 0.09 + nx * 0.03, y0 + 0.4, z - nx * 0.09 + nz * 0.03], [x + nz * 0.085 + nx * 0.05, y0 + 0.18, z - nx * 0.085 + nz * 0.05]], 0.008, 'dark');
    lbl([x + nx * 0.079, y0 + 0.22, z + nz * 0.079], [nx, 0, nz], 0.1, 0.13, TILE.notice, { k: 1, offset: 0.004 });
    cb([wx - 0.05 + Math.min(0, nx) * 0.0, y0 + 0.36, wz - 0.05], [wx + 0.05, y0 + 0.4, wz + 0.05], 'steel', { r: 0.004, tint: 0.5 });
    lbl([wx, 1.78, wz], [nx, 0, nz], 0.3, 0.3, TILE.fire, { k: 1 });
  }
  // wall signage
  const sign = (c, n, s, tile, o) => lbl(c, n, s, s, tile, { k: 0.9, ...o });
  sign([-19.3, 2.55, 15.6], [0, 0, -1], 0.7, TILE.exit);
  sign([8.85, 2.5, 15.6], [0, 0, -1], 0.6, TILE.exit);
  sign([9.4, 2.55, -5.8], [0, 0, 1], 0.6, TILE.exit);
  sign([-5, 1.9, -17.6], [0, 0, 1], 0.45, TILE.noSmoke);
  sign([8, 1.9, -17.6], [0, 0, 1], 0.45, TILE.warnCrush);
  sign([-14.2, 1.7, -6.2], [0, 0, -1], 0.4, TILE.noSmoke);
  sign([-9, 1.8, 15.6], [0, 0, -1], 0.45, TILE.warnCrush);
  sign([-23.6, 1.7, 13.0], [1, 0, 0], 0.4, TILE.warnVolt);
  sign([19.6, 1.6, -3.0], [-1, 0, 0], 0.32, TILE.warnVolt);
  sign([8.2, 1.5, 0.0], [1, 0, 0], 0.3, TILE.notice, { rot: 0.06 });
  sign([10.6, 1.45, 10.0], [-1, 0, 0], 0.32, TILE.notice, { rot: -0.1 });
  sign([10.6, 1.55, 4.3], [-1, 0, 0], 0.3, TILE.notice, { rot: 0.04 });
  sign([11.0, 1.5, 14.6], [1, 0, 0], 0.3, TILE.notice, { rot: 0.1 });
  sign([16.0, 1.6, -5.8], [0, 0, 1], 0.3, TILE.notice, { rot: -0.03 });
  sign([-7.6, 1.6, 16.0], [0, 0, 1], 0.5, TILE.warnCrush);
  sign([-15.0, 1.55, 16.0], [0, 0, 1], 0.42, TILE.noSmoke);
  sign([12.4, 1.5, 16.0], [0, 0, 1], 0.32, TILE.notice, { rot: 0.08 });
  // rags, bottles, buckets, loose planks, flattened cardboard
  const rag = (x, z, ry, col) => {
    const g = new THREE.PlaneGeometry(rr(0.3, 0.45), rr(0.22, 0.35), 4, 3);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) pa.setZ(k, Math.abs(Math.sin(pa.getX(k) * 13 + k) * 0.02) + R() * 0.012);
    g.computeVertexNormals();
    K.geo('paper', g, M(x, 0.004, z, ry, -PI / 2), { color: col });
  };
  for (const [x, z] of [[-4.8, 14.1], [-8.0, 5.8], [3.6, 12.9], [-7.6, -9.0], [15.8, 6.4], [12.1, -2.0], [-12.2, 11.2], [-1.0, 2.8]]) rag(x, z, rr(0, 6), R() < 0.5 ? [0.22, 0.2, 0.18] : [0.4, 0.35, 0.28]);
  const bottle = (x, z, lying) => {
    const prof = [[0.001, 0], [0.034, 0], [0.036, 0.01], [0.036, 0.17], [0.022, 0.21], [0.013, 0.235], [0.013, 0.26], [0.001, 0.26]];
    const m = lying ? M(x, 0.036, z, rr(0, 6), 0, PI / 2) : M(x, 0, z, 0);
    K.lathe('glassDark', prof, m, { segs: 10, color: R() < 0.5 ? [0.5, 1.4, 0.6] : [1.6, 0.9, 0.4] });
  };
  for (const [x, z] of [[-20.6, 12.0], [-20.3, 11.95], [-4.0, -4.3], [-13.4, -8.2], [9.0, 16.4], [-2.4, 24.6], [-2.6, 24.8], [16.6, 16.6], [18.9, 7.8], [12.2, -4.6], [-16.5, 16.8], [5.2, 24.9]]) bottle(x, z, R() < 0.6);
  const bucket = (x, z, key, tint, tipped) => {
    const prof = [[0.001, 0.005], [0.12, 0.005], [0.125, 0.0], [0.15, 0.3], [0.158, 0.31], [0.152, 0.315], [0.143, 0.302], [0.118, 0.02], [0.001, 0.02]];
    const m = tipped ? M(x, 0.15, z, rr(0, 6), 0, PI / 2 - 0.08) : M(x, 0, z, rr(0, 6));
    K.lathe(key, prof, m, { segs: 16, tint });
    K.geo('steel', new THREE.TorusGeometry(0.15, 0.005, 4, 12, PI), new THREE.Matrix4().multiplyMatrices(m, M(0, 0.3, 0, 0, 0, 0)), { tint: 0.5 });
  };
  bucket(-6.4, 15.15, 'paintGrey', 1.0, false); bucket(-11.5, 5.35, 'paintBlue', 0.9, true); bucket(5.75, 14.3, 'paintRed', 0.8, false);
  bucket(-21.0, 10.75, 'yellow', 0.7, false); bucket(12.0, -0.3, 'paintGrey', 0.9, true); bucket(-0.8, -15.3, 'paintBlue', 0.8, false);
  bucket(-22.9, 17.0, 'paintGrey', 0.7, true); bucket(16.9, 10.5, 'paintGrey', 1.0, false);
  // loose planks
  const plank = (x, z, ry, len, y = 0, rz = 0) => cb([-len / 2, 0, -0.06], [len / 2, 0.022, 0.06], 'wood', { matrix: M(x, y, z, ry, 0, rz), r: 0.003, tint: rr(0.6, 0.95) });
  for (const [x, z, ry, len] of [[-16.0, 13.4, 0.2, 1.4], [-15.7, 13.3, 0.35, 1.1], [-18.4, 5.6, 1.3, 1.6], [-3.2, -12.0, 0.8, 1.2], [-20.0, -10.2, 2.0, 1.5], [-18.3, 19.4, 0.4, 1.8], [-18.1, 19.55, 0.5, 1.3], [-12.0, -10.4, 1.6, 0.8]]) plank(x, z, ry, len);
  plank(-14.9, 14.1, PI / 2, 1.3, 0.55, 0.5);
  // broken pallet leaning on the hall-bay wall and one lying in the yard
  {
    const m = M(-17.4, 0, -5.55, 0, -1.35, 0);
    for (const k of [0, 0.33, 0.65]) cb([0, 0, k], [1.2, 0.022, k + 0.145], 'wood', { matrix: m, r: 0.003, tint: rr(0.6, 0.85) });
    for (const a of [0, 0.53, 1.055]) cb([a, -0.1, 0], [a + 0.145, 0, 0.8], 'woodDark', { matrix: m, r: 0.004, tint: 0.7 });
  }
  palletAt(-14.6, 0, 22.6, { broken: true, tint: 0.6 });
  // flattened / crushed cardboard
  for (const [x, z, ry] of [[-2.8, -3.0, 0.4], [-8.5, -3.6, 1.1], [14.8, 2.4, 0.2], [-13.6, -10.2, 2.2], [11.8, 3.9, 0.9], [-12.0, 12.0, 0.6], [17.8, -1.0, 1.4]]) {
    cb([-0.35, 0, -0.25], [0.35, 0.012, 0.25], 'cardboard', { matrix: M(x, 0, z, ry), r: 0.002, tint: rr(0.55, 0.85) });
  }
  carton(-6.1, 0, 13.25, 0.42, 0.18, 0.36, 0.6, 0.6, { rz: 0.0 });
  carton(14.7, 0, 3.0, 0.4, 0.14, 0.32, 2.1, 0.7);
  carton(-1.2, 0, -12.9, 0.5, 0.22, 0.4, 0.3, 0.65);
  // a rusty bolt/nut scatter near machines
  for (const [cx, cz] of [[-9.2, 5.9], [-1.7, 5.3], [-4.6, 14.2], [3.9, 12.9], [-8.0, -9.0]]) {
    for (let i = 0; i < 10; i++) K.bolt([cx + rr(-0.6, 0.6), 0.002, cz + rr(-0.4, 0.4)], [0, 1, 0], rr(0.8, 1.6));
  }
  // dead cable along the corridor floor
  hose([[8.35, 0.02, -2.0], [8.5, 0.02, 2.0], [8.4, 0.02, 6.5], [8.6, 0.02, 9.0]], 0.012);
}

function catenary(B, a, b, sag) {
  const n = 10;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    if (prev) B.pipe('rubber', prev, p, 0.015, { segs: 5, caps: false, rows: 2 });
    prev = p;
  }
}
function floorCable(B, a, b, R) {
  const n = 8;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = [a[0] + (b[0] - a[0]) * t + Math.sin(t * 9 + R()) * 0.25, 0.02, a[1] + (b[1] - a[1]) * t + Math.cos(t * 7) * 0.2];
    if (prev) B.pipe('rubber', prev, p, 0.02, { segs: 6, caps: false, rows: 2 });
    prev = p;
  }
}

// ------------------------------------------------------------------ model loading (browser only)
let modelModule = null;
function prefetchModels(list) {
  const ids = [...new Set(list.map((m) => m.id))];
  modelModule = import('./modelLoader.js').then((mod) => {
    for (const id of ids) mod.loadModel(id, { center: !!MODEL_INFO[id]?.center }).catch(() => {});
    return mod;
  });
}

// Instanced meshes for repeated props + the async model layer.
export function buildInstanced(inst, mats, scales) {
  const out = [];
  const local = (fn) => { const b = new Batcher(scales, () => [1, 1, 1]); fn(b); return b.build(); };
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  if (inst.rollers.length) {
    const g = local((b) => { b.pipe('steel', [0, 0, -0.5], [0, 0, 0.5], 0.045, { segs: 10 }); b.pipe('steel', [0, 0, -0.54], [0, 0, 0.54], 0.012, { segs: 6 }); }).get('steel');
    const m = new THREE.InstancedMesh(g, mats.steel, inst.rollers.length);
    const R = rng(3);
    inst.rollers.forEach(([x, y, z, len], i) => {
      dummy.position.set(x, y, z); dummy.rotation.set(0, 0, R() * 3); dummy.scale.set(1, 1, len); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.5 + R() * 0.5; m.setColorAt(i, col.setRGB(k, k * 0.9, k * 0.8));
    });
    out.push(tag(m, 'metal'));
  }
  if (inst.debris.length) {
    const g = local((b) => b.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 'ceiling', { seg: 2 })).get('ceiling');
    const m = new THREE.InstancedMesh(g, mats.ceiling, inst.debris.length);
    const R = rng(99);
    inst.debris.forEach(([x, z, s, r], i) => {
      dummy.position.set(x, s * 0.3 + (inst.debris[i][4] || 0), z); dummy.rotation.set(R() * 3, r * 6, R() * 3);
      dummy.scale.set(s * (0.8 + R()), s * (0.5 + R() * 0.6), s * (0.8 + R())); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.6 + R() * 0.5; m.setColorAt(i, col.setRGB(k, k * 0.98, k * 0.95));
    });
    m.castShadow = false;
    out.push(tag(m, 'concrete', false));
  }
  if (inst.bricks.length) {
    const g = local((b) => b.box([-0.11, -0.035, -0.055], [0.11, 0.035, 0.055], 'brick', { seg: 1 })).get('brick');
    const m = new THREE.InstancedMesh(g, mats.brickIn, inst.bricks.length);
    const R = rng(12);
    inst.bricks.forEach(([x, z, r], i) => {
      const tilt = R() < 0.3;
      dummy.position.set(x, tilt ? 0.05 : 0.035, z); dummy.rotation.set(tilt ? 0.6 : 0, r * 6, 0);
      const sc = R() < 0.3 ? 0.55 : 1; dummy.scale.set(sc, 1, 1); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    out.push(tag(m, 'concrete', false));
  }
  if (inst.papers.length) {
    const g = new THREE.PlaneGeometry(0.21, 0.297, 2, 2).rotateX(-PI / 2);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) pa.setY(k, (Math.abs(pa.getX(k)) > 0.1 ? 0.004 : 0) + (Math.abs(pa.getZ(k)) > 0.14 ? 0.003 : 0));
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count * 3).fill(1), 3));
    const m = new THREE.InstancedMesh(g, mats.paper, inst.papers.length);
    const R = rng(5);
    inst.papers.forEach(([x, y, z, r], i) => {
      dummy.position.set(x, y, z); dummy.rotation.set((R() - 0.5) * 0.08, r, (R() - 0.5) * 0.08); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.45 + R() * 0.55; m.setColorAt(i, col.setRGB(k, k * 0.97, k * 0.88));
    });
    m.castShadow = false;
    out.push(tag(m, 'wood', false));
  }
  if (inst.bolts?.length) {
    // hex bolt head + washer, instanced along surface normals
    // hex head (no hidden bottom cap) on a low washer cone: 20 triangles
    const g = new THREE.CylinderGeometry(0.011, 0.011, 0.008, 6, 1, true).translate(0, 0.006, 0);
    const top = new THREE.CircleGeometry(0.011, 6).rotateX(-PI / 2).translate(0, 0.01, 0);
    const w = new THREE.ConeGeometry(0.017, 0.004, 8, 1, true).translate(0, 0.002, 0);
    const merged = mergeSimple([g, top, w]);
    const m = new THREE.InstancedMesh(merged, mats.steel, inst.bolts.length);
    const R = rng(21), up = v3(0, 1, 0), q = new THREE.Quaternion(), nrm = new THREE.Vector3();
    inst.bolts.forEach(([x, y, z, nx, ny, nz, s], i) => {
      nrm.set(nx, ny, nz).normalize(); q.setFromUnitVectors(up, nrm);
      dummy.position.set(x - nx * 0.001, y - ny * 0.001, z - nz * 0.001); dummy.quaternion.copy(q); dummy.rotateY(R() * 3);
      dummy.scale.setScalar(s); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.35 + R() * 0.4; m.setColorAt(i, col.setRGB(k * 1.1, k * 0.85, k * 0.65));
    });
    m.castShadow = false;
    out.push(tag(m, 'metal', false));
  }
  // prop-only materials (cardboard, yellow machine paint)
  if (inst.ownGeo?.size) {
    const own = makePropMaterials();
    for (const [key, geo] of inst.ownGeo) {
      const mat = own?.[key] || mats[key === 'forkYellow' ? 'yellow' : key] || mats.steel;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'props:' + key; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.surface = PROP_SURFACES[key] || 'metal';
      mesh.matrixAutoUpdate = false;
      out.push(mesh);
    }
  }
  // decals / labels atlas mesh
  if (inst.labelGeo) {
    const tex = makeLabelTexture();
    let mat = mats.paper;
    if (tex && typeof THREE.MeshStandardMaterial === 'function') {
      mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.75, metalness: 0.0, alphaTest: 0.35, transparent: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.3 });
      mat.name = 'propLabels';
    }
    const mesh = new THREE.Mesh(inst.labelGeo, mat);
    mesh.name = 'props:labels'; mesh.receiveShadow = true; mesh.castShadow = false; mesh.userData.surface = 'metal';
    out.push(mesh);
  }
  if (inst.glassGeo) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa8ac, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.28, envMapIntensity: 0.6, depthWrite: false });
    mat.name = 'propGlass';
    const mesh = new THREE.Mesh(inst.glassGeo, mat);
    mesh.name = 'props:glass'; mesh.renderOrder = 2; mesh.userData.surface = 'metal';
    out.push(mesh);
  }

  // Poly Haven models (async): a group that fills in when the GLTFs arrive.
  const root = new THREE.Group(); root.name = 'props:models';
  out.push(root);
  if (typeof window !== 'undefined' && inst.models.length) populateModels(root, inst.models, mats);
  return out;
}

function mergeSimple(geos) {
  const pos = [], nor = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

function placementMatrix(pl) {
  const s = Array.isArray(pl.s) ? new THREE.Vector3(...pl.s) : new THREE.Vector3(pl.s, pl.s, pl.s);
  return M(pl.x, pl.y, pl.z, pl.ry, pl.rx, pl.rz, s);
}

async function populateModels(root, placements, mats) {
  if (!modelModule) prefetchModels(placements);
  let mod;
  try { mod = await modelModule; } catch { mod = null; }
  const groups = new Map();   // id|variant -> placements
  for (const pl of placements) {
    const k = pl.id + '|' + (pl.variant || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pl);
  }
  const col = new THREE.Color();
  await Promise.all([...groups].map(async ([k, list]) => {
    const [id, variant] = k.split('|');
    const info = MODEL_INFO[id] || { surface: 'metal', size: [0.5, 0.5, 0.5], key: 'steel' };
    let parts;
    try {
      const mdl = await mod.loadModel(id, { center: !!info.center });
      parts = await Promise.all(mdl.parts.map(async (p) => ({ geometry: p.geometry, material: variant ? await mod.variantMaterial(id, variant, p.material) : p.material })));
    } catch (e) {
      console.warn('[props] model fallback for', id, e?.message || e);
      const [w, h, d] = info.size;
      const g = new THREE.BoxGeometry(w, h, d).translate(0, info.center ? 0 : h / 2, 0);
      parts = [{ geometry: g, material: mats[info.key] || mats.steel }];
    }
    for (const part of parts) {
      const m = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((pl, i) => {
        m.setMatrixAt(i, placementMatrix(pl));
        const t = pl.tint ?? 1; m.setColorAt(i, col.setRGB(t, t, t));
      });
      m.name = 'model:' + id + (variant ? ':' + variant : '');
      m.userData.surface = info.surface;
      m.castShadow = !info.small; m.receiveShadow = true;
      m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere(); m.computeBoundingBox?.();
      m.matrixAutoUpdate = false; m.updateMatrix();
      root.add(m);
    }
  }));
}

function tag(m, surface, cast = true) {
  m.userData.surface = surface;
  m.castShadow = cast; m.receiveShadow = true;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere?.();
  return m;
}

export { v3 };
