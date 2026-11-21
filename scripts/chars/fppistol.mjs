// First-person service pistol (self-made, CC0): striker-fired, polymer frame, separate slide,
// trigger and magazine. Built from analytic primitives so the same definition gives both the
// render mesh and an exact signed distance field (used for finger contact + penetration checks).
// Weapon space: origin = grip centre (middle-finger height), +Z muzzle, +Y up, +X weapon-left.
import { THREE } from './threeio.mjs';
import { profile, box, cyl, merge } from './weapons.mjs';

const T18 = Math.tan((18 * Math.PI) / 180);
export const COL = {
  slide: [0.022, 0.023, 0.026],
  frame: [0.04, 0.041, 0.043],
  steel: [0.16, 0.16, 0.17],
  sight: [0.9, 0.9, 0.85],
  bore: [0.0, 0.0, 0.0],
  mag: [0.035, 0.035, 0.038],
  serr: [0.012, 0.012, 0.014],
  dot: [0.75, 0.95, 0.55],
};
// slide serrations (rear, both sides) — visible from the bodycam behind the gun
const SERR = [];
for (let i = 0; i < 7; i++) for (const sx of [1, -1]) SERR.push({ t: 'box', s: [0.0012, 0.022, 0.0022], p: [sx * 0.01275, 0.063, -0.038 + i * 0.0048], c: COL.serr, nosdf: true });

// part -> primitives. prism: side polygon [z,y] extruded over x in [-w/2, w/2] (+x0)
export const PARTS = {
  frame: [
    { t: 'prism', pts: [[0.040, 0.030], [0.003, -0.074], [-0.053, -0.074], [-0.017, 0.028], [-0.046, 0.038], [-0.047, 0.046], [0.040, 0.046]], w: 0.031, c: COL.frame },
    { t: 'prism', pts: [[0.040, 0.028], [0.132, 0.028], [0.132, 0.046], [0.040, 0.046]], w: 0.024, c: COL.frame }, // dust cover
    { t: 'box', s: [0.016, 0.007, 0.056], p: [0, -0.0035, 0.063], c: COL.frame }, // trigger guard bottom (gloved-finger size)
    { t: 'box', s: [0.016, 0.034, 0.008], p: [0, 0.013, 0.089], c: COL.frame }, // trigger guard front
    { t: 'box', s: [0.004, 0.006, 0.014], p: [0.0135, 0.04, 0.01], c: COL.steel }, // slide stop (left)
    { t: 'box', s: [0.004, 0.009, 0.007], p: [0.0145, 0.022, 0.032], c: COL.steel }, // mag release (left)
    { t: 'cyl', r: 0.0068, z0: 0.0, z1: 0.152, x: 0, y: 0.062, c: COL.steel }, // barrel (inside slide)
  ],
  slide: [
    { t: 'prism', pts: [[-0.047, 0.046], [0.151, 0.046], [0.151, 0.075], [0.146, 0.082], [-0.042, 0.082], [-0.047, 0.076]], w: 0.0255, c: COL.slide },
    { t: 'box', s: [0.0035, 0.0065, 0.006], p: [0, 0.0857, 0.142], c: COL.slide }, // front sight post
    { t: 'box', s: [0.0075, 0.007, 0.008], p: [0.00575, 0.0855, -0.036], c: COL.slide }, // rear sight, left of the notch
    { t: 'box', s: [0.0075, 0.007, 0.008], p: [-0.00575, 0.0855, -0.036], c: COL.slide }, // rear sight, right of the notch
    { t: 'box', s: [0.004, 0.0035, 0.006], p: [0, 0.0838, -0.036], c: COL.slide, nosdf: true }, // notch floor
    { t: 'box', s: [0.0022, 0.0022, 0.0006], p: [0.0058, 0.0862, -0.0402], c: COL.sight, nosdf: true }, // rear dots
    { t: 'box', s: [0.0022, 0.0022, 0.0006], p: [-0.0058, 0.0862, -0.0402], c: COL.sight, nosdf: true },
    { t: 'box', s: [0.0024, 0.0024, 0.0008], p: [0, 0.0872, 0.1388], c: COL.dot, nosdf: true }, // front dot
    { t: 'box', s: [0.014, 0.0025, 0.034], p: [0.0, 0.0815, 0.058], c: COL.steel, nosdf: true }, // ejection port / barrel hood
    { t: 'cyl', r: 0.0048, z0: 0.1505, z1: 0.1515, x: 0, y: 0.062, c: COL.bore, nosdf: true }, // bore
    ...SERR,
  ],
  trigger: [
    { t: 'prism', pts: [[0.0, 0.0], [0.006, 0.0], [0.004, -0.018], [-0.002, -0.026], [-0.005, -0.024], [-0.001, -0.016]], w: 0.007, c: COL.steel },
  ],
  magazine: [
    { t: 'box', s: [0.033, 0.009, 0.058], p: [0, -0.0045, -0.003], c: COL.mag }, // base plate (part origin at grip bottom)
    { t: 'box', s: [0.022, 0.1, 0.032], p: [0, 0.05, 0.0], c: COL.mag }, // body (inside the grip when seated)
    { t: 'box', s: [0.012, 0.004, 0.024], p: [0, 0.101, 0.002], c: COL.steel, nosdf: true }, // follower / top round
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
export const MUZZLE = new THREE.Vector3(0, 0.062, 0.152);   // bore axis exit (slide-space at rest)
export const BORE_Y = 0.062;
export const PORT = new THREE.Vector3(-0.008, 0.08, 0.058); // ejection port (right side, slide space)
// trigger: positive rotation about +X swings the blade rearward (press)
export const TRIGGER_TRAVEL = (16 * Math.PI) / 180;

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
