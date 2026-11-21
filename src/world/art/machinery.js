// Geometry of the moving machines (workstream A), authored in each part's BONE-LOCAL frame for one rigid-skinned
// mesh (machines.js): AGVs/AMRs, stacker crane, palletising robot, cartons, sorter paddles, plus door leaves.
import { FX, NX, FY, NY, FZ, NZ, M } from './kit.js';
import { MAT, C, pallet, load } from './models.js';
import { cell } from './tiles.js';

const m = (t, c = null, s = 0, x = {}) => ({ t, ...(c ? { c } : {}), s, ...x });
const PI = Math.PI;

/** AGV / AMR body, front = -z, 0.9 × 1.4, deck at 0.38. kind 'tugger' carries a pallet load (≤ 1.35 m) */
export function agvBody(b, kind) {
  const body = MAT.paint(kind === 'tugger' ? [0.95, 0.55, 0.03] : [0.85, 0.85, 0.82], 0.5);
  b.bbox(-0.45, 0.06, -0.7, 0.45, 0.36, 0.7, 0.04, body, NY);
  b.box(-0.46, 0.04, -0.71, 0.46, 0.12, 0.71, m('rubber', null, 0.3), NY | FY);                       // bumper strip
  b.box(-0.4, 0.36, -0.62, 0.4, 0.38, 0.62, MAT.tread(0.4), NY);                                      // deck
  b.box(-0.451, 0.2, -0.5, -0.45, 0.24, 0.5, MAT.light(2.5, [0.1, 0.9, 1.0]), 0);                     // status LED strips
  b.box(0.45, 0.2, -0.5, 0.451, 0.24, 0.5, MAT.light(2.5, [0.1, 0.9, 1.0]), 0);
  b.box(-0.3, 0.14, -0.712, 0.3, 0.32, -0.7, m('hazard', null, [0.3, 0.09]), NY);                     // front hazard plate
  b.cyl(-0.33, 0.36, -0.58, 0.05, 0.08, 10, m('plastic', C.black, 0.2), 1);                           // lidar
  b.cyl(0.33, 0.36, 0.58, 0.05, 0.08, 10, m('plastic', C.black, 0.2), 1);
  for (const [x, z] of [[-0.42, -0.67], [0.42, 0.67]]) b.cyl(x, 0.36, z, 0.025, 0.03, 8, MAT.paint(C.red, 0.1), 1);   // e-stops
  b.quad([[0.452, 0.14, 0.15], [0.452, 0.14, -0.15], [0.452, 0.3, -0.15], [0.452, 0.3, 0.15]], [[0, 0], [1, 0], [1, 1], [0, 1]], m('decals', null, 0, { sub: cell(2, 2, 1) }));
  b.cyl(-0.36, 0.38, 0.6, 0.012, 0.18, 6, MAT.steel(0.1), 0);                                         // beacon mast
  b.cyl(-0.36, 0.56, 0.6, 0.045, 0.07, 10, m('plastic', [0.55, 0.3, 0.05], 0.2), 1);                  // beacon (off)
  if (kind === 'tugger') {
    // lift deck with a euro pallet of cartons (0.8 × 1.2 long along z)
    b.box(-0.42, 0.38, -0.65, 0.42, 0.42, 0.65, MAT.galv(0.4));
    b.with(M.RY(PI / 2), () => { pallet(b, -0.6, 0.42, -0.4, 0.6, 0.4, true); load(b, -0.57, 0.564, -0.37, 0.57, 1.32, 0.37, 'cartons', NY); });
  }
}
/** lit beacon (scaled to 0 when off) */
export function agvBeacon(b) { b.cyl(0, 0, 0, 0.048, 0.072, 10, m('light', [1, 0.55, 0.08], 1, { e: 6 }), 1); }

/** stacker crane parts (local frames: mast bone at rail level; carriage bone at platform bottom; fork bone) */
export function craneMast(b, H) {
  const grey = MAT.paint([0.72, 0.74, 0.76], 0.8), dk = MAT.paint(C.dgrey, 0.5);
  b.box(-0.45, 0.08, -1.3, 0.45, 0.62, 1.3, grey, NY);                                                // bottom travel carriage
  for (const z of [-1.0, 1.0]) b.with(M.mul(M.T(0, 0.18, z), M.RZ(PI / 2)), () => b.cyl(0, -0.1, 0, 0.14, 0.2, 12, MAT.steel(0.2), 3));
  b.box(-0.42, 0.62, 0.65, 0.42, 1.8, 1.25, MAT.paint([0.85, 0.85, 0.82], 0.5), NY);                  // control cabinet
  b.box(-0.43, 1.0, 1.251, 0.43, 1.6, 1.252, m('cabinet', null, [0.86, 0.6]), 0);
  b.box(-0.25, 0.62, -0.25, 0.25, H, 0.25, grey, NY);                                                 // mast
  b.box(-0.251, 0.62, -0.18, -0.25, H, 0.18, m('upright', [0.85, 0.85, 0.9], [0.36, 0.4]), 0);       // perforated sides
  b.box(0.25, 0.62, -0.18, 0.251, H, 0.18, m('upright', [0.85, 0.85, 0.9], [0.36, 0.4]), 0);
  b.box(-0.45, H, -0.6, 0.45, H + 0.15, 0.6, grey);                                                   // top guide carriage
  b.box(-0.08, H + 0.15, -0.2, 0.08, H + 0.2, 0.2, dk, NY);
  for (let y = 1.2; y < H - 0.3; y += 0.3) b.box(0.25, y, 0.26, 0.29, y + 0.025, 0.4, MAT.steel(0.3));   // ladder rungs
  b.box(0.25, 0.62, 0.38, 0.29, H, 0.41, MAT.steel(0.3), NY | FY); b.box(0.25, 0.62, 0.25, 0.29, H, 0.27, MAT.steel(0.3), NY | FY);
  b.cyl(0, H + 0.2, 0, 0.05, 0.08, 10, m('plastic', [0.55, 0.3, 0.05], 0.2), 1);
}
export function craneCarriage(b) {
  const grey = MAT.paint([0.72, 0.74, 0.76], 0.8);
  b.box(-0.72, 0, -0.75, 0.72, 0.14, 0.75, grey);
  b.box(-0.72, 0.14, -0.75, -0.66, 1.1, 0.75, grey, NY); b.box(0.66, 0.14, -0.75, 0.72, 1.1, 0.75, grey, NY);
  b.box(-0.3, 0.14, 0.55, 0.3, 1.1, 0.75, grey, NY);                                                  // mast clamp
  b.box(-0.6, 0.14, -0.6, 0.6, 0.18, 0.6, MAT.tread(0.4), NY);
  b.box(-0.66, 0.9, -0.755, 0.66, 1.0, -0.75, m('hazard', null, [0.4, 0.1]), 0);
}
export function craneFork(b) {
  const st = MAT.steel(0.5);
  for (const z of [-0.32, 0.22]) { b.box(-0.6, 0.18, z, 0.6, 0.26, z + 0.1, st); b.box(-0.55, 0.26, z + 0.02, 0.55, 0.28, z + 0.08, MAT.paint(C.dgrey, 0.3), NY); }
}
/** crane load: pallet + wrapped goods 1.2 (x) × 0.8 (z) × 0.8 */
export function craneLoad(b) { pallet(b, -0.6, 0, -0.4, 0.6, 0.4, true); load(b, -0.57, 0.144, -0.37, 0.57, 0.8, 0.37, 'wrap', NY); }

/** palletising robot links (orange); local +y along each link */
const ROB = [0.9, 0.36, 0.02];
export function robotTurret(b) {
  const o = MAT.paint(ROB, 0.5), dk = MAT.paint(C.dgrey, 0.4);
  b.cyl(0, 0, 0, 0.42, 0.12, 18, dk, 1);
  b.cyl(0, 0.12, 0, 0.36, 0.3, 18, o, 1);
  b.bbox(-0.3, 0.3, -0.25, 0.3, 0.75, 0.45, 0.05, o, NY);
  b.with(M.mul(M.T(-0.32, 0.65, 0.2), M.RZ(PI / 2)), () => b.cyl(0, -0.02, 0, 0.2, 0.06, 14, dk, 3));
  b.with(M.mul(M.T(0.32, 0.65, 0.2), M.RZ(-PI / 2)), () => b.cyl(0, -0.02, 0, 0.2, 0.06, 14, dk, 3));
  b.cyl(0.0, 0.4, -0.32, 0.12, 0.3, 10, MAT.paint([0.25, 0.25, 0.27], 0.3), 1);                       // motor
}
export function robotUpper(b, L) {
  const o = MAT.paint(ROB, 0.5);
  b.bbox(-0.2, -0.15, -0.16, 0.2, L + 0.1, 0.16, 0.05, o, 0);
}
export function robotFore(b, L) {
  const o = MAT.paint(ROB, 0.5), dk = MAT.paint(C.dgrey, 0.4);
  b.bbox(-0.17, -0.2, -0.14, 0.17, 0.25, 0.14, 0.04, o, 0);
  b.bbox(-0.12, 0.25, -0.1, 0.12, L - 0.05, 0.1, 0.03, o, 0);
  b.with(M.mul(M.T(-0.18, 0, 0), M.RZ(PI / 2)), () => b.cyl(0, -0.02, 0, 0.16, 0.04, 12, dk, 3));
  b.cyl(0, -0.45, 0.0, 0.1, 0.3, 10, MAT.paint([0.25, 0.25, 0.27], 0.3), 1);                         // counterweight motor
}
export function robotWrist(b) {
  const o = MAT.paint(ROB, 0.5);
  b.bbox(-0.11, -0.12, -0.11, 0.11, 0.1, 0.11, 0.03, o, 0);
  b.cyl(0, -0.25, 0, 0.08, 0.13, 10, MAT.paint(C.dgrey, 0.3), 3);
}
/** vacuum gripper hanging below the wrist (tool point at y = -toolLen) */
export function robotGripper(b, toolLen) {
  const al = MAT.steel(0.4), dk = MAT.paint(C.dgrey, 0.3);
  b.box(-0.32, -toolLen + 0.05, -0.22, 0.32, -toolLen + 0.12, 0.22, al);
  b.box(-0.05, -toolLen + 0.12, -0.05, 0.05, -0.25, 0.05, dk);
  for (const x of [-0.22, 0, 0.22]) for (const z of [-0.12, 0.12]) b.cyl(x, -toolLen, z, 0.035, 0.05, 8, m('rubber', null, 0.2), 2);
}

/** carton on a conveyor / robot (0.5 × 0.3 × 0.35 default), origin bottom centre */
export function cartonPart(b, w = 0.5, h = 0.3, d = 0.35, variant = 0) {
  b.box(-w / 2, 0, -d / 2, w / 2, h, d / 2, m(variant ? 'carton2' : 'carton'), NY, { [FY]: m('cardboard', null, 0.6), [FX]: m('carton2'), [NX]: m('carton2') });
  b.box(-w / 2 - 0.002, h, -0.025, w / 2 + 0.002, h + 0.002, 0.025, m('plastic', [0.8, 0.62, 0.36], 0.3), NY | FZ | NZ);
}
/** sorter paddle (swing arm): local origin at the pivot, arm along +z (0.7 m), 0.18 high */
export function paddlePart(b) {
  b.box(-0.02, 0.0, 0.0, 0.02, 0.16, 0.7, MAT.galv(0.3));
  b.box(-0.03, 0.02, 0.62, 0.03, 0.16, 0.7, m('rubber', null, 0.2), 0);
  b.cyl(0, -0.02, 0, 0.05, 0.22, 10, MAT.paint(C.dgrey, 0.3), 1);
}

/** door leaf geometry centred like the core's BoxGeometry(w, h, th) (x = along the wall for axis 'x') */
export function doorLeaf(b, d) {
  const w = d.b - d.a, h = d.y1 - d.y0, ax = d.axis === 'x';
  const th = d.kind === 'roller' ? 0.08 : Math.min(0.06, d.th * 0.5);
  // author along x, then rotate for z walls
  b.push(ax ? M.ident() : M.RY(PI / 2));
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2, z0 = -th / 2, z1 = th / 2;
  if (d.kind === 'roller') {
    b.box(x0, y0, z0, x1, y1, z1, m('slats', [0.85, 0.87, 0.9], [1.0, 0.8]), 0);
    b.box(x0, y0, z0 - 0.01, x1, y0 + 0.08, z1 + 0.01, m('rubber', null, 0.3), 0);
    b.box(x0 + 0.3, y0 + 0.3, z0 - 0.02, x0 + 0.45, y0 + 0.38, z0, MAT.steel(0.2), 0);
  } else if (d.kind === 'slide' && d.mesh) {
    const g = MAT.galv(0.4), mesh = m('mesh', [0.95, 0.95, 0.95], 0.2);
    b.box(x0, y0, -0.02, x0 + 0.04, y1, 0.02, g); b.box(x1 - 0.04, y0, -0.02, x1, y1, 0.02, g);
    b.box(x0, y1 - 0.04, -0.02, x1, y1, 0.02, g); b.box(x0, y0 + 0.05, -0.02, x1, y0 + 0.09, 0.02, g);
    b.quad([[x0 + 0.04, y0 + 0.09, 0], [x1 - 0.04, y0 + 0.09, 0], [x1 - 0.04, y1 - 0.04, 0], [x0 + 0.04, y1 - 0.04, 0]], [[0, 0], [(w - 0.08) / 0.2, 0], [(w - 0.08) / 0.2, (h - 0.13) / 0.2], [0, (h - 0.13) / 0.2]], mesh, true);
  } else if (d.kind === 'slide') {
    // insulated cold-store sliding door
    b.bbox(x0, y0, z0, x1, y1, z1, 0.02, MAT.paint([0.88, 0.89, 0.88], 0.8), 0);
    for (const z of [z0 - 0.02, z1]) b.box(x0 + 0.1, y0 + 1.0, z, x0 + 0.14, y0 + 1.4, z + 0.02, MAT.steel(0.2), 0);
  } else {
    // steel swing door: frame panel, kick plate, lever handles both sides
    b.box(x0, y0, z0, x1, y1, z1, MAT.paint([0.5, 0.53, 0.57], 0.8), 0);
    for (const [z, s] of [[z0, -1], [z1, 1]]) {
      b.box(x0 + 0.03, y0 + 0.02, s < 0 ? z - 0.003 : z, x1 - 0.03, y0 + 0.25, s < 0 ? z : z + 0.003, MAT.steel(0.3), 0);
      const hx = x1 - 0.1;
      b.box(hx - 0.02, y0 + 0.98, s < 0 ? z - 0.012 : z, hx + 0.02, y0 + 1.2, s < 0 ? z : z + 0.012, MAT.steel(0.2), 0);
      b.box(hx - 0.14, y0 + 1.05, s < 0 ? z - 0.06 : z + 0.04, hx + 0.01, y0 + 1.08, s < 0 ? z - 0.04 : z + 0.06, MAT.steel(0.2), 0);
    }
  }
  b.pop();
  void FX; void NX; void FZ; void NZ; void FY;
}
