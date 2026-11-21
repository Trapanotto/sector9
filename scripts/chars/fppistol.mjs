// First-person service pistol (self-made, CC0): striker-fired, polymer frame, separate slide,
// trigger and magazine. Built from analytic primitives so the same definition gives both the
// render mesh and an exact signed distance field (used for finger contact + penetration checks).
// Weapon space: origin = grip centre (middle-finger height), +Z muzzle, +Y up, +X weapon-left.
import { THREE } from './threeio.mjs';
import { profile, box, cyl, merge } from './weapons.mjs';

const T18 = Math.tan((18 * Math.PI) / 180);
const COL = {
  slide: [0.035, 0.036, 0.04],
  frame: [0.075, 0.076, 0.08],
  steel: [0.12, 0.12, 0.13],
  sight: [0.9, 0.9, 0.85],
  bore: [0.0, 0.0, 0.0],
  mag: [0.05, 0.05, 0.055],
};

// part -> primitives. prism: side polygon [z,y] extruded over x in [-w/2, w/2] (+x0)
export const PARTS = {
  frame: [
    { t: 'prism', pts: [[0.040, 0.030], [0.003, -0.074], [-0.053, -0.074], [-0.017, 0.028], [-0.046, 0.038], [-0.047, 0.046], [0.040, 0.046]], w: 0.031, c: COL.frame },
    { t: 'prism', pts: [[0.040, 0.028], [0.132, 0.028], [0.132, 0.046], [0.040, 0.046]], w: 0.024, c: COL.frame }, // dust cover
    { t: 'box', s: [0.016, 0.007, 0.05], p: [0, 0.0005, 0.06], c: COL.frame }, // trigger guard bottom
    { t: 'box', s: [0.016, 0.03, 0.008], p: [0, 0.015, 0.083], c: COL.frame }, // trigger guard front
    { t: 'box', s: [0.004, 0.006, 0.014], p: [0.0135, 0.04, 0.01], c: COL.steel }, // slide stop (left)
    { t: 'box', s: [0.004, 0.009, 0.007], p: [0.0145, 0.022, 0.032], c: COL.steel }, // mag release (left)
    { t: 'cyl', r: 0.0068, z0: 0.0, z1: 0.152, x: 0, y: 0.062, c: COL.steel }, // barrel (inside slide)
  ],
  slide: [
    { t: 'prism', pts: [[-0.047, 0.046], [0.151, 0.046], [0.151, 0.075], [0.146, 0.082], [-0.042, 0.082], [-0.047, 0.076]], w: 0.0255, c: COL.slide },
    { t: 'box', s: [0.004, 0.006, 0.005], p: [0, 0.0855, 0.142], c: COL.slide }, // front sight
    { t: 'box', s: [0.02, 0.007, 0.008], p: [0, 0.0855, -0.036], c: COL.slide }, // rear sight
    { t: 'box', s: [0.0012, 0.0015, 0.0015], p: [0, 0.088, 0.1435], c: COL.sight, nosdf: true }, // front dot
    { t: 'box', s: [0.014, 0.0025, 0.034], p: [0.0, 0.0815, 0.058], c: COL.steel, nosdf: true }, // ejection port / barrel hood
    { t: 'cyl', r: 0.0048, z0: 0.1505, z1: 0.1515, x: 0, y: 0.062, c: COL.bore, nosdf: true }, // bore
  ],
  trigger: [
    { t: 'prism', pts: [[0.0, 0.0], [0.006, 0.0], [0.004, -0.018], [-0.002, -0.026], [-0.005, -0.024], [-0.001, -0.016]], w: 0.007, c: COL.frame },
  ],
  magazine: [
    { t: 'box', s: [0.033, 0.009, 0.058], p: [0, -0.0045, -0.003], c: COL.mag }, // base plate (part origin at grip bottom)
    { t: 'box', s: [0.022, 0.1, 0.032], p: [0, 0.05, 0.0], c: COL.mag, nosdf: true }, // body (inside grip)
  ],
};
// rest transforms of the moving parts relative to the pistol root
export const PART_REST = {
  frame: { p: [0, 0, 0], r: [0, 0, 0] },
  slide: { p: [0, 0, 0], r: [0, 0, 0] },
  trigger: { p: [0, 0.03, 0.053], r: [0, 0, 0] }, // pivot at the top of the trigger blade
  magazine: { p: [0, -0.074, -0.026], r: [0.314, 0, 0] }, // grip bottom, tilted with the grip (18 deg)
};
export const SLIDE_TRAVEL = 0.032; // full recoil stroke (m)
export const MAG_AXIS = new THREE.Vector3(0, 1, T18).normalize(); // insertion direction (up the grip)
export const SIGHT_REAR = new THREE.Vector3(0, 0.089, -0.036);
export const SIGHT_FRONT = new THREE.Vector3(0, 0.089, 0.142);

function primGeom(q) {
  if (q.t === 'prism') return profile(q.pts, q.w, q.c, { bevel: 0.0012 });
  if (q.t === 'box') return box(...q.s, q.p, q.c, q.rot || null);
  return cyl(q.r, q.z0, q.z1, [q.x, q.y], q.c, 16);
}
export function partGeometry(part) { return merge(PARTS[part].map(primGeom)); }

// ----------------------------------------------------------------------------- SDF
function sdPoly(p, pts) {
  let d = Infinity, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const ex = bx - ax, ey = by - ay, wx = p[0] - ax, wy = p[1] - ay;
    const h = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const dx = wx - ex * h, dy = wy - ey * h;
    d = Math.min(d, dx * dx + dy * dy);
    const c1 = p[1] >= ay, c2 = p[1] < by, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
const ext = (a, b) => Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
function sdPrim(q, x, y, z) {
  if (q.t === 'prism') return ext(sdPoly([z, y], q.pts), Math.abs(x) - q.w / 2);
  if (q.t === 'box') {
    _v.set(x - q.p[0], y - q.p[1], z - q.p[2]);
    if (q.rot) _v.applyMatrix4(_m.makeRotationFromEuler(_e.set(...q.rot)).invert());
    const dx = Math.abs(_v.x) - q.s[0] / 2, dy = Math.abs(_v.y) - q.s[1] / 2, dz = Math.abs(_v.z) - q.s[2] / 2;
    return Math.min(Math.max(dx, dy, dz), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
  }
  const r = Math.hypot(x - q.x, y - q.y) - q.r;
  return ext(r, Math.abs(z - (q.z0 + q.z1) / 2) - (q.z1 - q.z0) / 2);
}
/** Signed distance of a point given in a part's local frame. */
export function sdPart(part, p) {
  let d = Infinity;
  for (const q of PARTS[part]) if (!q.nosdf) d = Math.min(d, sdPrim(q, p.x, p.y, p.z));
  return d;
}
