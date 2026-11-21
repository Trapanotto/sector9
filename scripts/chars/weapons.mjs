// Procedural (self-made, CC0) weapon models built from extruded side profiles, boxes and cylinders.
// Weapon space: origin = strong-hand grip centre, +Z muzzle, +Y up, +X weapon-left. Metres.
import { THREE } from './threeio.mjs';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const C = {
  polymer: [0.075, 0.075, 0.08],
  steel: [0.045, 0.045, 0.05],
  steelLight: [0.16, 0.16, 0.17],
  brass: [0.55, 0.42, 0.2],
  rubber: [0.04, 0.04, 0.04],
  grey: [0.2, 0.2, 0.21],
};

function colorize(g, col) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/** Side profile (points as [z, y]) extruded symmetrically along X with a small chamfer. */
export function profile(pts, width, col, { bevel = 0.0015, x = 0 } = {}) {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(1e-4, width - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 1, curveSegments: 4,
  });
  // shape (x=z_w, y=y_w), extrusion along +Z -> weapon X
  const m = new THREE.Matrix4().set(0, 0, 1, x - (width - 2 * bevel) / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  return colorize(g, col);
}

export function box(sx, sy, sz, [x, y, z], col, rot = null) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  g.translate(x, y, z);
  return colorize(g, col);
}

/** Cylinder along Z from z0 to z1. */
export function cyl(r, z0, z1, [x, y], col, seg = 10, r1 = r) {
  const g = new THREE.CylinderGeometry(r1, r, z1 - z0, seg, 1, false);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return colorize(g, col);
}

function tube(r, path, col, seg = 8) {
  const curve = new THREE.CatmullRomCurve3(path.map((p) => new THREE.Vector3(...p)));
  return colorize(new THREE.TubeGeometry(curve, path.length * 3, r, seg, false), col);
}

const merge = (arr) => mergeGeometries(arr.map((g) => (g.index ? g.toNonIndexed() : g)), false);

// --------------------------------------------------------------------------- enemy weapons (<=1.5k tris)
export function enemyPistol() {
  return merge([
    // slide with chamfered top
    profile([[-0.045, 0.044], [0.15, 0.044], [0.15, 0.074], [0.145, 0.081], [-0.04, 0.081], [-0.045, 0.074]], 0.026, C.steel),
    // frame / dust cover
    profile([[-0.04, 0.03], [0.13, 0.03], [0.13, 0.045], [-0.04, 0.045]], 0.023, C.polymer, { bevel: 0.001 }),
    // grip (18 deg)
    profile([[-0.045, 0.036], [0.022, 0.036], [0.012, 0.0], [-0.006, -0.075], [-0.056, -0.072], [-0.046, -0.01]], 0.029, C.polymer),
    // trigger guard + trigger
    box(0.02, 0.006, 0.055, [0, 0.003, 0.045], C.polymer),
    box(0.02, 0.03, 0.007, [0, 0.018, 0.071], C.polymer),
    box(0.006, 0.02, 0.006, [0, 0.022, 0.032], C.steel, [0.3, 0, 0]),
    // sights + muzzle
    box(0.004, 0.006, 0.006, [0, 0.084, 0.14], C.steel),
    box(0.018, 0.007, 0.008, [0, 0.084, -0.035], C.steel),
    cyl(0.0055, 0.149, 0.152, [0, 0.062], C.rubber, 8),
  ]);
}

export function enemySMG() {
  return merge([
    box(0.046, 0.055, 0.34, [0, 0.058, 0.02], C.steel),
    cyl(0.013, 0.19, 0.33, [0, 0.058], C.steel, 10),
    cyl(0.025, 0.12, 0.29, [0, 0.035], C.polymer, 10), // handguard
    profile([[-0.04, 0.034], [0.02, 0.034], [0.012, 0.0], [-0.004, -0.085], [-0.05, -0.08], [-0.042, -0.01]], 0.03, C.polymer),
    // curved magazine
    profile([[0.052, 0.032], [0.098, 0.032], [0.118, -0.06], [0.14, -0.17], [0.098, -0.18], [0.078, -0.07]], 0.024, C.steel),
    box(0.02, 0.006, 0.05, [0, 0.004, 0.035], C.polymer),
    box(0.006, 0.018, 0.006, [0, 0.018, 0.02], C.steel),
    // retractable stock (two rods + butt plate)
    cyl(0.005, -0.38, -0.15, [0.018, 0.06], C.steel, 6),
    cyl(0.005, -0.38, -0.15, [-0.018, 0.06], C.steel, 6),
    box(0.05, 0.11, 0.02, [0, 0.03, -0.385], C.rubber),
    // sights / cocking tube
    cyl(0.009, -0.12, 0.25, [0, 0.093], C.steel, 8),
    box(0.03, 0.025, 0.02, [0, 0.105, -0.1], C.steel),
    box(0.006, 0.02, 0.01, [0, 0.105, 0.24], C.steel),
  ]);
}

export function enemyShotgun() {
  return merge([
    box(0.044, 0.06, 0.24, [0, 0.05, 0.05], C.steel),
    cyl(0.0115, 0.17, 0.68, [0, 0.062], C.steel, 10),
    cyl(0.0125, 0.17, 0.6, [0, 0.033], C.steel, 10),
    cyl(0.021, 0.28, 0.45, [0, 0.036], C.polymer, 12), // pump
    // stock incl. pistol-grip wrist (25 deg)
    profile([[-0.07, 0.078], [-0.37, 0.064], [-0.39, 0.06], [-0.39, -0.085], [-0.36, -0.09], [-0.2, -0.045],
      [-0.03, -0.075], [0.0, -0.07], [0.02, 0.022], [-0.07, 0.022]], 0.038, C.polymer),
    box(0.04, 0.155, 0.025, [0, -0.012, -0.392], C.rubber),
    box(0.02, 0.006, 0.06, [0, 0.004, 0.04], C.polymer),
    box(0.006, 0.02, 0.006, [0, 0.016, 0.03], C.steel),
    cyl(0.003, 0.66, 0.672, [0, 0.077], C.brass, 6), // bead sight
  ]);
}

export function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }

export const COLORS = C;
export { merge, colorize, tube };
