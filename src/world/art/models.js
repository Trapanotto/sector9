// Procedural models of every prop type (workstream A). Pure JS (kit.js Builder), shared by the runtime and the
// Node tests. Each model draws in the prop's LOCAL frame (origin bottom centre, +x width, +z depth, "front" -z,
// same as proptypes.js) and must stay inside the union of its proxy boxes (test-a-art.mjs checks this).
//
// X = { b (Builder), rnd() (instance PRNG), id, zone (zone id), lod(mask) (1 = near only, 2 = far only, 3 = both) }
import { FX, NX, FY, NY, FZ, NZ, M } from './kit.js';
import { cell, signSub } from './tiles.js';

// ---- palette (linear tints; the tiles carry the texture detail) ---------------------------------------------
export const C = {
  white: [0.92, 0.92, 0.9], lgrey: [0.75, 0.76, 0.72], mgrey: [0.45, 0.46, 0.46], dgrey: [0.2, 0.2, 0.21], black: [0.07, 0.07, 0.075],
  yellow: [0.98, 0.6, 0.02], orange: [0.95, 0.32, 0.03], red: [0.6, 0.05, 0.035], dred: [0.35, 0.03, 0.02], blue: [0.05, 0.16, 0.5],
  green: [0.12, 0.3, 0.12], machine: [0.5, 0.58, 0.52], beige: [0.78, 0.7, 0.55], brown: [0.35, 0.22, 0.12],
  rubber: [1, 1, 1], wood: [1, 1, 1], kraft: [1, 1, 1], teal: [0.1, 0.35, 0.4],
};
const m = (t, c = null, s = 0, x = {}) => ({ t, ...(c ? { c } : {}), s, ...x });
export const MAT = {
  paint: (c, s = 0.6) => m('paint', c, s), steel: (s = 0.7) => m('steel', null, s), galv: (s = 0.5) => m('galv', null, s),
  plastic: (c, s = 0.5) => m('plastic', c, s), rubber: (s = 0.3) => m('rubber', null, s), wood: (s = [1.2, 0.15]) => m('wood', null, s),
  board: (s = 1.2) => m('woodboard', null, s), kraft: (s = 0.6) => m('cardboard', null, s), tread: (s = 0.4) => m('tread', null, s),
  hazard: (s = [0.5, 0.125]) => m('hazard', null, s), glass: () => m('glassdark', null, 1), lam: (c = null) => m('laminate', c, 0.8),
  fabric: (c) => m('fabric', c, 0.5), light: (e = 3, c = null) => m('light', c, 1, { e }), concrete: () => m('concrete', null, 1),
};

// ---- helpers --------------------------------------------------------------------------------------------------
const PI = Math.PI;
/** euro pallet (1.2 × 0.8 × 0.144) in the box x0..x1 / z0..z1 at y0; long side along the longer axis.
 *  covered: top hidden by a load. lodFar: emit the cheap version (sides only) */
export function pallet(b, x0, y0, z0, x1, z1, covered = false, faces = 0) {
  const h = 0.144, alongX = x1 - x0 >= z1 - z0;
  const side = m('pallet_side'), end = m('pallet_end');
  const mf = alongX ? { [FZ]: side, [NZ]: side, [FX]: end, [NX]: end } : { [FX]: side, [NX]: side, [FZ]: end, [NZ]: end };
  b.box(x0, y0, z0, x1, y0 + h, z1, side, NY | FY | faces, mf);
  // top deck (alpha boards) and the dark core between the blocks (seen through the fork openings)
  if (!covered) {
    const top = m('pallet_top');
    if (alongX) b.quad([[x0, y0 + h, z1], [x1, y0 + h, z1], [x1, y0 + h, z0], [x0, y0 + h, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], top);
    else b.quad([[x1, y0 + h, z1], [x1, y0 + h, z0], [x0, y0 + h, z0], [x0, y0 + h, z1]], [[0, 0], [1, 0], [1, 1], [0, 1]], top);
    b.box(x0 + 0.02, y0 + 0.1, z0 + 0.02, x1 - 0.02, y0 + 0.1, z1 - 0.02, m('wood', [0.35, 0.3, 0.25], [1.2, 0.15]), ~FY & 63);
  }
  const ix = (x1 - x0) * 0.36, iz = (z1 - z0) * 0.3, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.box(cx - ix, y0 + 0.022, cz - iz, cx + ix, y0 + 0.122, cz + iz, m('wood', [0.4, 0.34, 0.28], [1.2, 0.15]), FY | NY);
}

/** wrapped / carton load box with optional chamfer */
export function load(b, x0, y0, z0, x1, y1, z1, kind, skip = NY, bevel = 0) {
  const longX = x1 - x0 >= z1 - z0;
  let side, top;
  if (kind === 'wrap') { side = m('wrap'); top = m('wraptop'); }
  else if (kind === 'cartons') { side = m('cartonstack'); top = m('cardboard', null, 0.6); }
  else if (kind === 'totes') { side = m('totes', null, [0.62, 0.33]); top = m('plastic', [0.1, 0.25, 0.6], 0.6); }
  else { side = m(kind === 'carton2' ? 'carton2' : 'carton'); top = m('cardboard', null, 0.6); }
  const mf = { [FY]: top };
  if (bevel > 0) b.bbox(x0, y0, z0, x1, y1, z1, bevel, side, skip, mf);
  else b.box(x0, y0, z0, x1, y1, z1, side, skip, mf);
  void longX;
}

/** single carton with tape stripe on top (open: no lid, flaps + contents) */
export function carton(b, x0, y0, z0, x1, y1, z1, X, o = {}) {
  const v = o.variant ?? (X.rnd() < 0.5 ? 'carton' : 'carton2');
  if (!o.open) {
    b.box(x0, y0, z0, x1, y1, z1, m(v), NY | (o.skip ?? 0), { [FY]: m('cardboard', null, 0.6) });
    const cz = (z0 + z1) / 2;
    if (X.lodNear) b.box(x0 - 0.002, y1, cz - 0.025, x1 + 0.002, y1 + 0.002, cz + 0.025, m('plastic', [0.8, 0.62, 0.36], 0.3), NY | FZ | NZ);
    return;
  }
  // open carton: walls (outside + inside), flaps leaning out, bricks inside
  const t = 0.006, kr = m('cardboard', null, 0.6), ki = m('cardboard', [0.75, 0.75, 0.75], 0.6);
  b.box(x0, y0, z0, x1, y1, z1, m(v), NY | FY);
  b.box(x0 + t, y0, z0 + t, x1 - t, y0 + 0.02, z1 - t, ki, ~FY & 63);   // inner floor
  {
    // inverted inner walls (visible from inside the open carton)
    const ix0 = x0 + t, ix1 = x1 - t, iz0 = z0 + t, iz1 = z1 - t, iy0 = y0 + 0.02;
    b.quad([[ix0, iy0, iz0], [ix1, iy0, iz0], [ix1, y1, iz0], [ix0, y1, iz0]], [[0, 0], [1, 0], [1, 1], [0, 1]], ki);
    b.quad([[ix1, iy0, iz1], [ix0, iy0, iz1], [ix0, y1, iz1], [ix1, y1, iz1]], [[0, 0], [1, 0], [1, 1], [0, 1]], ki);
    b.quad([[ix0, iy0, iz1], [ix0, iy0, iz0], [ix0, y1, iz0], [ix0, y1, iz1]], [[0, 0], [1, 0], [1, 1], [0, 1]], ki);
    b.quad([[ix1, iy0, iz0], [ix1, iy0, iz1], [ix1, y1, iz1], [ix1, y1, iz0]], [[0, 0], [1, 0], [1, 1], [0, 1]], ki);
  }
  // flaps (two long flaps folded out and down a bit)
  const fh = Math.min(0.1, (z1 - z0) / 2);
  b.quad([[x0, y1, z0], [x1, y1, z0], [x1, y1 + fh * 0.5, z0 - fh * 0.85], [x0, y1 + fh * 0.5, z0 - fh * 0.85]], [[0, 0], [1, 0], [1, 1], [0, 1]], kr, true);
  b.quad([[x1, y1, z1], [x0, y1, z1], [x0, y1 + fh * 0.5, z1 + fh * 0.85], [x1, y1 + fh * 0.5, z1 + fh * 0.85]], [[0, 0], [1, 0], [1, 1], [0, 1]], kr, true);
  if (o.bricks) {
    const n = o.bricks, bw = 0.11, bl = 0.2, bh = 0.05;
    let k = 0;
    for (let ly = 0; k < n && ly < 4; ly++) for (let ix = 0; k < n && x0 + 0.02 + (ix + 1) * (bl + 0.01) < x1; ix++) for (let iz = 0; k < n && z0 + 0.02 + (iz + 1) * (bw + 0.01) < z1; iz++) {
      const bx = x0 + 0.02 + ix * (bl + 0.01), bz = z0 + 0.02 + iz * (bw + 0.01), by = y0 + 0.02 + ly * bh;
      if (by + bh > y1 - 0.02) continue;
      b.box(bx, by, bz, bx + bl, by + bh, bz + bw, m('brick'), NY, { [FY]: m('brick'), [FX]: m('brick', [0.85, 0.85, 0.85]), [NX]: m('brick', [0.85, 0.85, 0.85]) });
      k++;
    }
  }
}

/** a wrapped brick lying around (packing tables, cash room) */
function brick(b, x, y, z, rotY = 0) {
  b.with(M.mul(M.T(x, y, z), M.RY(rotY)), () => b.box(-0.1, 0, -0.055, 0.1, 0.05, 0.055, m('brick'), NY));
}
/** money bundle */
function bundle(b, x, y, z, rotY = 0, h = 0.012) {
  b.with(M.mul(M.T(x, y, z), M.RY(rotY)), () => b.box(-0.078, 0, -0.035, 0.078, h, 0.035, m('money'), NY, { [FY]: m('money') }));
}
function wheel(b, x, y, z, r, w, seg = 12, hub = C.mgrey, axis = 'x') {
  // tyre (cylinder along x), rubber side walls, rim disc slightly proud of the side wall
  b.with(M.mul(M.T(x, y, z), axis === 'x' ? M.RZ(PI / 2) : M.RX(PI / 2)), () => {
    b.cyl(0, -w / 2, 0, r, w, seg, MAT.rubber(0.3), 3, r, m('rubber', [0.7, 0.7, 0.7], 0.3));
    b.cyl(0, -w / 2 - 0.004, 0, r * 0.55, w + 0.008, Math.max(6, seg - 4), m('paint', hub, 0.3), 3, r * 0.55);
  });
}
function screen(b, x0, y0, z, x1, y1, emissive = 0.9, tile = 'screen') {
  // a display facing -z (quad slightly in front of z)
  b.quad([[x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z]], [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [u, v]), m(tile, null, 0, { e: emissive }));
}
function sign(b, name, x0, y0, z, x1, y1, e = 0) {
  b.quad([[x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z]], [[0, 0], [1, 0], [1, 1], [0, 1]], m('signs', null, 0, { sub: signSub(name), e }));
}
function legs4(b, x0, z0, x1, z1, y0, y1, s, mat) {
  for (const [x, z] of [[x0, z0], [x1 - s, z0], [x0, z1 - s], [x1 - s, z1 - s]]) b.box(x, y0, z, x + s, y1, z + s, mat, NY | FY);
}
/** subdivided-free cylinder lying along z (drums on side, pipes) */
function cylZ(b, x, y, z0, z1, r, seg, mat, caps = 3) { b.with(M.mul(M.T(x, y, z0), M.RX(PI / 2)), () => b.cyl(0, 0, 0, r, z1 - z0, seg, mat, caps)); }
function cylX(b, x0, x1, y, z, r, seg, mat, caps = 3) { b.with(M.mul(M.T(x0, y, z), M.RZ(-PI / 2)), () => b.cyl(0, 0, 0, r, x1 - x0, seg, mat, caps)); }

// ---- prop models --------------------------------------------------------------------------------------------------
export const MODELS = {
  pallet(X) { pallet(X.b, -0.6, 0, -0.4, 0.6, 0.4); },

  pallet_load(X) {
    const { b } = X;
    pallet(b, -0.6, 0, -0.4, 0.6, 0.4, true);
    const kind = X.rnd() < 0.7 ? 'wrap' : 'cartons';
    load(b, -0.57, 0.144, -0.37, 0.57, 1.3, 0.37, kind, NY, X.lodNear ? 0.02 : 0);
  },

  pallet_cartons(X) {
    const { b } = X;
    pallet(b, -0.6, 0, -0.4, 0.6, 0.4, true);
    load(b, -0.58, 0.144, -0.38, 0.58, 0.86, 0.38, 'cartons', NY);
    if (X.lodNear) {   // loose top layer
      const n = 1 + Math.floor(X.rnd() * 3);
      for (let i = 0; i < n; i++) {
        const x = -0.55 + i * 0.38;
        X.b.with(M.mul(M.T(x + 0.17, 0.86, -0.12 + X.rnd() * 0.18), M.RY((X.rnd() - 0.5) * 0.12)), () => carton(b, -0.16, 0, -0.12, 0.16, 0.135, 0.12, X));
      }
    }
  },

  pallet_stack(X) {
    const { b } = X;
    for (let i = 0; i < 6; i++) {
      const dx = (X.rnd() - 0.5) * 0.016, dz = (X.rnd() - 0.5) * 0.016;
      if (!X.lodNear && i < 5) { b.box(-0.6 + dx, i * 0.143, -0.4 + dz, 0.6 + dx, i * 0.143 + 0.143, 0.4 + dz, m('pallet_side'), NY | FY, { [FX]: m('pallet_end'), [NX]: m('pallet_end') }); continue; }
      pallet(b, -0.6 + dx, i * 0.143, -0.4 + dz, 0.6 + dx, 0.4 + dz, i < 5);
    }
  },

  pallet_drums(X) {
    const { b } = X;
    pallet(b, -0.6, 0, -0.4, 0.6, 0.4, true);
    if (X.zone === 'labor' || X.zone === 'technik' || X.rnd() < 0.4) {
      // four narrow plastic drums
      const cols = [C.blue, [0.15, 0.35, 0.65], C.blue, [0.75, 0.72, 0.6]];
      [[-0.285, -0.175], [0.285, -0.175], [-0.285, 0.185], [0.285, 0.185]].forEach(([x, z], i) => {
        b.cyl(x, 0.144, z, 0.17, 0.86, X.lodNear ? 14 : 8, m('drum', cols[i], [0.5, 0.9]), 1, 0.165, m('plastic', cols[i], 0.3));
        if (X.lodNear) b.cyl(x + 0.07, 1.004, z, 0.025, 0.02, 6, m('plastic', C.dgrey, 0.2), 1);
      });
    } else {
      // IBC: white translucent tank in a galvanised cage on the pallet
      const tank = m('plastic', [0.85, 0.85, 0.8], 0.6);
      b.bbox(-0.52, 0.17, -0.33, 0.52, 0.98, 0.33, 0.06, tank, NY);
      if (X.lodNear) {
        const cage = m('mesh', [0.9, 0.9, 0.9], 0.2);
        b.box(-0.55, 0.15, -0.36, 0.55, 1.03, 0.36, cage, NY);
        b.box(-0.55, 0.15, -0.36, 0.55, 1.03, 0.36, cage, NY | FY | FX | NX | FZ | NZ);
        // inverted cage faces (see the far side through the mesh)
        const ins = [[[-0.55, 0.15, 0.36], [0.55, 0.15, 0.36], [0.55, 1.03, 0.36], [-0.55, 1.03, 0.36]]];
        for (const q of ins) b.quad(q.slice().reverse(), [[0, 0], [5, 0], [5, 4], [0, 4]], cage);
        b.cyl(0, 0.98, 0, 0.08, 0.06, 10, m('plastic', C.dgrey, 0.2), 1);   // lid
        b.with(M.mul(M.T(0, 0.26, -0.36), M.RX(-PI / 2)), () => b.cyl(0, 0, 0, 0.05, 0.05, 10, m('plastic', C.dgrey, 0.2), 1));   // tap
      }
    }
  },

  carton(X) { carton(X.b, -0.3, 0, -0.2, 0.3, 0.4, 0.2, X); },

  carton_pile(X) {
    const { b } = X;
    if (X.id === 'waffenkisten') {
      // wooden crates with stencil
      const crate = (x0, y0, z0, x1, y1, z1) => {
        b.box(x0, y0, z0, x1, y1, z1, MAT.board(0.8), NY);
        if (X.lodNear) {
          const bat = m('wood', [0.85, 0.8, 0.75], [1, 0.12]);
          for (const zz of [z0 - 0.012, z1]) for (const [ya, yb] of [[y0 + 0.02, y0 + 0.08], [y1 - 0.08, y1 - 0.02]]) b.box(x0 + 0.02, ya, zz, x1 - 0.02, yb, zz + 0.012, bat, NY);
        }
      };
      crate(-0.6, 0, -0.4, 0.6, 0.4, 0.4); crate(-0.58, 0.4, -0.38, 0.58, 0.8, 0.38); crate(-0.5, 0.8, -0.3, 0.3, 1.18, 0.3);
      return;
    }
    // two layers of 2×2 cartons + two on top; some opened with bricks in the gang areas
    const gang = ['packerei', 'lager_w', 'geld'].includes(X.zone);
    for (let ly = 0; ly < 2; ly++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const x0 = -0.6 + i * 0.6, z0 = -0.4 + j * 0.4, y0 = ly * 0.4;
      const jx = (X.rnd() - 0.5) * 0.02, jz = (X.rnd() - 0.5) * 0.02;
      b.with(M.mul(M.T(x0 + 0.3 + jx, y0, z0 + 0.2 + jz), M.RY((X.rnd() - 0.5) * 0.04)), () =>
        carton(b, -0.29, 0, -0.19, 0.29, 0.395, 0.19, X, { skip: ly === 0 ? FY : 0 }));
    }
    const open = gang && X.lodNear;
    b.with(M.T(-0.3, 0.8, 0), () => carton(b, -0.19, 0, -0.29, 0.19, 0.39, 0.29, X, { open, bricks: open ? 8 : 0 }));
    b.with(M.mul(M.T(0.1, 0.8, 0.02), M.RY(0.05)), () => carton(b, -0.18, 0, -0.27, 0.18, 0.38, 0.27, X));
  },

  packing_table(X) {
    const { b } = X;
    const st = MAT.steel(0.6), top = m('steel', [0.9, 0.9, 0.92], 0.8);
    b.box(-1, 0.82, -0.4, 1, 0.87, 0.4, top);
    for (const sx of [-1, 1]) {
      const x = sx < 0 ? -0.97 : 0.91;
      b.box(x, 0, -0.38, x + 0.06, 0.82, -0.33, st, NY | FY); b.box(x, 0, 0.33, x + 0.06, 0.82, 0.38, st, NY | FY);
      b.box(x, 0.12, -0.33, x + 0.06, 0.16, 0.33, st);
    }
    b.box(-0.91, 0.18, -0.33, 0.91, 0.2, 0.33, m('steel', [0.75, 0.75, 0.78], 0.8));   // lower shelf
    // flat-packed cartons + foil roll on the shelf
    if (X.lodNear) {
      b.box(-0.8, 0.2, -0.3, 0.1, 0.26, 0.3, MAT.kraft(), NY);
      cylX(b, 0.3, 0.8, 0.29, 0, 0.09, 10, m('plastic', [0.85, 0.88, 0.9], 0.3));
    }
    // open carton with bricks (proxy: -0.7..-0.2 × 0.87..1.17)
    carton(b, -0.7, 0.87, -0.2, -0.2, 1.17, 0.2, X, { open: X.lodNear, bricks: 10 });
    // scale (proxy 0.3..0.6 × -0.15..0.15)
    b.box(0.3, 0.87, -0.15, 0.6, 0.9, 0.15, m('paint', C.dgrey, 0.3));
    b.box(0.32, 0.9, -0.13, 0.58, 0.915, 0.13, m('steel', [1, 1, 1], 0.3));
    if (X.lodNear) {
      b.box(0.36, 0.875, -0.17, 0.54, 0.95, -0.15, m('paint', C.dgrey, 0.3), NY);
      screen(b, 0.38, 0.89, -0.171, 0.52, 0.93, 1.2, 'panel');
      brick(b, 0.45, 0.915, 0.0, 0.2);
      // vacuum sealer + foil (proxy -0.05..0.2 × -0.32..-0.17)
      b.bbox(-0.05, 0.87, -0.32, 0.2, 0.95, -0.17, 0.01, m('plastic', C.dgrey, 0.3), NY);
      b.box(-0.03, 0.95, -0.3, 0.18, 0.955, -0.19, m('plastic', C.black, 0.3), NY);
      // tape dispenser + bricks + scissors-ish
      b.box(0.65, 0.87, 0.1, 0.85, 0.94, 0.18, m('paint', C.red, 0.3), NY);
      b.with(M.mul(M.T(0.72, 0.94, 0.14), M.RX(PI / 2)), () => b.cyl(0, -0.03, 0, 0.05, 0.06, 10, m('plastic', [0.8, 0.62, 0.36], 0.2), 3));
      brick(b, -0.05, 0.87, 0.2, 0.4); brick(b, 0.2, 0.87, 0.25, -0.2); brick(b, 0.05, 0.92, 0.22, 0.1);
      bundle(b, 0.8, 0.87, -0.25, 0.3);
    }
  },

  forklift(X) {
    const { b } = X;
    const reach = X.id === 'stapler_halle';
    const body = MAT.paint(reach ? [0.85, 0.42, 0.03] : C.yellow, 0.5), dk = MAT.paint(C.dgrey, 0.4), blk = MAT.paint(C.black, 0.5);
    if (!reach) {
      // counterbalance truck, forks towards +z
      b.bbox(-0.55, 0.15, -0.6, 0.55, 1.05, 0.75, 0.04, body, NY);                                   // chassis
      b.bbox(-0.55, 0.15, -1.25, 0.55, 1.2, -0.6, 0.08, MAT.paint(C.dgrey, 0.5), NY);                // counterweight
      if (X.lodNear) b.box(-0.5, 0.5, -1.27, 0.5, 0.62, -1.25, MAT.hazard([0.5, 0.12]), NY | FY);
      b.box(-0.35, 1.05, -0.55, 0.35, 1.12, 0.2, MAT.tread(0.4));                                    // floor plate / hood
      b.bbox(-0.28, 1.12, -0.55, 0.28, 1.22, -0.15, 0.03, m('plastic', C.black, 0.3), NY);           // seat
      b.bbox(-0.28, 1.22, -0.62, 0.28, 1.65, -0.5, 0.03, m('plastic', C.black, 0.3), NY);            // backrest
      b.box(-0.2, 1.12, 0.3, 0.2, 1.4, 0.6, dk);                                                      // dashboard
      if (X.lodNear) b.with(M.mul(M.T(0, 1.45, 0.4), M.RX(-0.5)), () => b.cyl(0, 0, 0, 0.16, 0.025, 12, blk, 3));   // steering wheel
      // overhead guard: 4 posts + roof grid
      for (const [x, z0] of [[-0.55, -0.9], [0.48, -0.9], [-0.55, 0.62], [0.48, 0.62]]) b.box(x, z0 > 0 ? 1.05 : 1.2, z0, x + 0.07, 2.1, z0 + 0.07, dk);
      b.box(-0.55, 2.1, -0.9, 0.55, 2.16, 0.7, dk, 0, { [FY]: m('mesh', C.dgrey, 0.25), [NY]: m('mesh', C.dgrey, 0.25) });
      if (X.lodNear) b.cyl(0.4, 2.16, -0.8, 0.05, 0.1, 8, m('plastic', C.orange, 0.2, { e: 0.6 }), 1);   // beacon
      // mast + carriage + forks
      for (const x of [-0.42, 0.32]) b.box(x, 0.06, 0.82, x + 0.1, 2.3, 0.95, dk);
      b.box(-0.32, 1.9, 0.86, 0.32, 1.96, 0.92, dk);
      b.box(-0.45, 0.1, 0.95, 0.45, 0.62, 1.05, MAT.paint(C.dgrey, 0.4));                             // carriage plate
      if (X.lodNear) for (let i = 0; i < 6; i++) b.box(-0.42 + i * 0.16, 0.62, 0.97, -0.39 + i * 0.16, 1.15, 1.0, dk);   // load backrest bars
      for (const x of [-0.4, 0.28]) { b.box(x, 0.04, 1.05, x + 0.12, 0.1, 2.2, m('steel', [0.55, 0.55, 0.58], 0.5)); b.box(x, 0.1, 1.0, x + 0.12, 0.6, 1.05, dk); }
      // wheels
      wheel(b, -0.49, 0.3, 0.55, 0.3, 0.2); wheel(b, 0.49, 0.3, 0.55, 0.3, 0.2);
      wheel(b, -0.47, 0.23, -0.85, 0.23, 0.16); wheel(b, 0.47, 0.23, -0.85, 0.23, 0.16);
      if (X.lodNear) {
        b.box(-0.56, 0.7, 0.05, -0.55, 0.95, 0.35, m('decals', null, 0, { sub: cell(2, 2, 0) }), 0, null);
        b.cyl(-0.45, 2.16, 0.6, 0.04, 0.05, 8, MAT.light(2), 1); b.cyl(0.45, 2.16, 0.6, 0.04, 0.05, 8, MAT.light(2), 1);
      }
    } else {
      // reach truck: compact body at the rear, standing driver sideways, outrigger legs forward
      b.bbox(-0.55, 0.15, -1.25, 0.55, 1.2, -0.1, 0.05, body, NY);
      if (X.lodNear) b.box(-0.5, 0.55, -1.27, 0.5, 0.65, -1.25, MAT.hazard(), NY | FY);
      b.box(-0.45, 0.15, -0.1, 0.45, 0.35, 0.9, dk);                                                  // base under the mast
      for (const x of [-0.4, 0.28]) b.box(x, 0.04, 0.9, x + 0.12, 0.25, 2.2, MAT.paint(C.dgrey, 0.5));   // outrigger legs
      wheel(b, -0.34, 0.12, 2.0, 0.11, 0.1, 10); wheel(b, 0.34, 0.12, 2.0, 0.11, 0.1, 10);
      wheel(b, 0.35, 0.18, -0.8, 0.18, 0.16);
      for (const [x, z0] of [[-0.55, -0.9], [0.48, -0.9], [-0.55, 0.5], [0.48, 0.5]]) b.box(x, 1.2, z0, x + 0.07, 2.1, z0 + 0.07, dk);
      b.box(-0.55, 2.1, -0.9, 0.55, 2.16, 0.7, dk, 0, { [FY]: m('mesh', C.dgrey, 0.25), [NY]: m('mesh', C.dgrey, 0.25) });
      b.bbox(-0.3, 1.2, -0.45, 0.3, 1.32, 0.1, 0.02, MAT.tread(0.4), NY);
      b.bbox(0.2, 1.2, -0.3, 0.45, 1.55, 0.0, 0.02, m('plastic', C.black, 0.3), NY);                  // armrest / controls
      for (const x of [-0.42, 0.32]) b.box(x, 0.15, 0.82, x + 0.1, 2.3, 0.95, dk);
      b.box(-0.45, 0.4, 0.95, 0.45, 0.9, 1.05, MAT.paint(C.dgrey, 0.4));
      for (const x of [-0.36, 0.24]) b.box(x, 0.4, 1.05, x + 0.12, 0.45, 1.95, m('steel', [0.55, 0.55, 0.58], 0.5));
      if (X.lodNear) b.cyl(0.4, 2.16, -0.8, 0.05, 0.1, 8, m('plastic', C.orange, 0.2, { e: 0.6 }), 1);
    }
  },

  pallet_jack(X) {
    const { b } = X;
    const red = MAT.paint([0.55, 0.06, 0.04], 0.4), dk = MAT.paint(C.dgrey, 0.3);
    for (const x of [-0.27, 0.1]) {
      b.box(x, 0.02, -0.6, x + 0.17, 0.085, 0.6, red, NY);
      if (X.lodNear) { wheel(b, x + 0.085, 0.04, -0.5, 0.04, 0.07, 8); b.box(x + 0.02, 0.0, -0.6, x + 0.15, 0.02, -0.58, red, NY); }
    }
    b.box(-0.3, 0.02, 0.6, 0.3, 0.12, 0.7, red);
    b.bbox(-0.12, 0.12, 0.6, 0.12, 0.35, 0.78, 0.02, red, NY);                                       // pump unit
    wheel(b, -0.08, 0.09, 0.72, 0.09, 0.05, 10); wheel(b, 0.08, 0.09, 0.72, 0.09, 0.05, 10);
    b.tube([0, 0.35, 0.73], [0, 1.08, 0.735], 0.017, 6, dk);                                           // handle shaft
    if (X.lodNear) {
      b.tube([-0.13, 1.1, 0.735], [0.13, 1.1, 0.735], 0.015, 6, dk); b.tube([-0.13, 1.1, 0.735], [-0.03, 1.2, 0.735], 0.015, 6, dk);
      b.tube([0.13, 1.1, 0.735], [0.03, 1.2, 0.735], 0.015, 6, dk); b.tube([-0.03, 1.2, 0.735], [0.03, 1.2, 0.735], 0.018, 6, m('rubber', null, 0.2));
    }
  },

  hand_truck(X) {
    const { b } = X;
    const st = MAT.paint([0.1, 0.25, 0.45], 0.4);
    for (const x of [-0.22, 0.22]) b.tube([x, 0.05, 0.0], [x * 0.85, 1.18, 0.0], 0.016, 6, st);
    for (const y of [0.35, 0.65, 0.95]) b.tube([-0.22, y, 0], [0.22, y, 0], 0.012, 5, st);
    b.tube([-0.19, 1.18, 0], [0.19, 1.18, 0], 0.016, 6, m('rubber', null, 0.2));
    b.box(-0.2, 0, -0.25, 0.2, 0.012, 0.03, MAT.steel(0.4));                                          // toe plate
    wheel(b, -0.2, 0.1, 0.0, 0.1, 0.05, 10); wheel(b, 0.2, 0.1, 0.0, 0.1, 0.05, 10);
  },

  roll_cage(X) {
    const { b } = X;
    const g = MAT.galv(0.4), mesh = m('mesh', [0.95, 0.95, 0.95], 0.2);
    b.box(-0.4, 0.1, -0.35, 0.4, 0.14, 0.35, g);                                                        // base
    for (const [x, z] of [[-0.36, -0.31], [0.32, -0.31], [-0.36, 0.27], [0.32, 0.27]]) { b.box(x, 0, z, x + 0.04, 0.1, z + 0.04, MAT.paint(C.dgrey), NY); }
    for (const [x, z] of [[-0.4, -0.35], [0.38, -0.35], [-0.4, 0.33], [0.38, 0.33]]) b.box(x, 0.14, z, x + 0.02, 1.8, z + 0.02, g, NY);
    // three mesh sides (two-sided), open front (-z)
    const side = (p) => b.quad(p, [[0, 0], [p === p ? 3.5 : 3, 0], [3.5, 8], [0, 8]], mesh, true);
    side([[-0.39, 0.14, 0.34], [0.39, 0.14, 0.34], [0.39, 1.8, 0.34], [-0.39, 1.8, 0.34]]);
    side([[-0.39, 0.14, -0.34], [-0.39, 0.14, 0.34], [-0.39, 1.8, 0.34], [-0.39, 1.8, -0.34]]);
    side([[0.39, 0.14, 0.34], [0.39, 0.14, -0.34], [0.39, 1.8, -0.34], [0.39, 1.8, 0.34]]);
    b.box(-0.39, 0.9, -0.34, 0.39, 0.92, 0.34, MAT.galv(0.4));                                         // shelf
    if (X.lodNear) { const n = Math.floor(X.rnd() * 3); for (let i = 0; i < n; i++) carton(b, -0.33, 0.14 + i * 0.3, -0.25, 0.25, 0.42 + i * 0.3, 0.2, X); }
  },

  shelf(X) {
    const { b } = X;
    const g = MAT.galv(0.5), up = MAT.paint([0.25, 0.35, 0.5], 0.5);
    for (const [x, z] of [[-0.5, -0.25], [0.46, -0.25], [-0.5, 0.21], [0.46, 0.21]]) {
      b.box(x, 0, z, x + 0.04, 2.0, z + 0.04, up, NY);
    }
    const levels = [0.08, 0.5, 0.95, 1.4, 1.9];
    levels.forEach((y, i) => {
      b.box(-0.49, y, -0.24, 0.49, y + 0.025, 0.24, g);
      if (!X.lodNear || i === levels.length - 1) return;
      // stock: cartons, totes, paint tins
      const k = X.rnd();
      if (k < 0.35) { carton(b, -0.45, y + 0.025, -0.2, -0.05, y + 0.3, 0.18, X); carton(b, 0.0, y + 0.025, -0.18, 0.42, y + 0.25, 0.2, X); }
      else if (k < 0.6) { for (let j = 0; j < 2; j++) b.bbox(-0.45 + j * 0.46, y + 0.025, -0.2, -0.05 + j * 0.46, y + 0.21, 0.2, 0.01, MAT.plastic(j ? C.blue : [0.7, 0.2, 0.05], 0.3), NY); }
      else if (k < 0.8) { for (let j = 0; j < 4; j++) b.cyl(-0.36 + j * 0.24, y + 0.025, -0.05, 0.085, 0.19, 10, m('steel', [0.9, 0.9, 0.95], 0.3), 1); }
      else { b.box(-0.45, y + 0.025, -0.2, 0.3, y + 0.1, 0.2, MAT.kraft(), NY); }
    });
  },

  sofa(X) {
    const { b } = X;
    const f = MAT.fabric([0.32, 0.25, 0.2]), f2 = MAT.fabric([0.28, 0.22, 0.18]);
    b.bbox(-1.0, 0.08, -0.45, 1.0, 0.3, 0.45, 0.04, f, NY);
    for (let i = 0; i < 3; i++) b.bbox(-0.84 + i * 0.56, 0.3, -0.43, -0.29 + i * 0.56, 0.45, 0.24, 0.05, i === 1 ? f2 : f, NY);
    b.bbox(-1.0, 0.3, 0.24, 1.0, 0.85, 0.45, 0.06, f, NY);
    for (const x of [-1.0, 0.84]) b.bbox(x, 0.3, -0.45, x + 0.16, 0.62, 0.24, 0.05, f2, NY);
    for (const [x, z] of [[-0.95, -0.4], [0.9, -0.4], [-0.95, 0.38], [0.9, 0.38]]) b.box(x, 0, z, x + 0.05, 0.08, z + 0.05, MAT.paint(C.black), NY | FY);
    if (X.lodNear) b.bbox(0.3, 0.45, -0.35, 0.75, 0.53, 0.05, 0.03, MAT.fabric([0.2, 0.25, 0.35]), NY);   // blanket
  },

  mattress(X) {
    const { b } = X;
    b.bbox(-0.7, 0, -1.0, 0.7, 0.18, 1.0, 0.05, m('mattress', null, 0), NY, { [FX]: MAT.fabric([0.6, 0.6, 0.62]), [NX]: MAT.fabric([0.6, 0.6, 0.62]), [FZ]: MAT.fabric([0.6, 0.6, 0.62]), [NZ]: MAT.fabric([0.6, 0.6, 0.62]) });
    if (X.lodNear) {
      const col = [[0.25, 0.3, 0.2], [0.4, 0.12, 0.1], [0.15, 0.2, 0.35]][Math.floor(X.rnd() * 3)];
      b.with(M.mul(M.T(0.05, 0.18, 0.1), M.RY((X.rnd() - 0.5) * 0.4)), () => b.bbox(-0.55, 0, -0.5, 0.55, 0.045, 0.55, 0.02, MAT.fabric(col), NY));   // sleeping bag / blanket
      b.bbox(-0.35, 0.18, -0.95, 0.35, 0.25, -0.65, 0.03, MAT.fabric([0.75, 0.75, 0.72]), NY);                                                       // pillow
    }
  },

  table(X) {
    const { b } = X;
    b.box(-0.6, 0.72, -0.4, 0.6, 0.76, 0.4, MAT.lam(X.zone === 'packerei' ? null : [0.85, 0.8, 0.7]));
    legs4(b, -0.57, -0.37, 0.57, 0.37, 0, 0.72, 0.035, MAT.paint(C.dgrey, 0.3));
    if (X.lodNear) {
      // takeaway clutter: pizza box, cans, ashtray, cards
      b.with(M.mul(M.T(-0.25, 0.76, 0.05), M.RY(X.rnd() * 0.6)), () => b.box(-0.16, 0, -0.16, 0.16, 0.04, 0.16, MAT.kraft(), NY, { [FY]: m('trash', null, 0, { sub: cell(2, 2, 0) }) }));
      for (let i = 0; i < 3; i++) {
        const x = 0.1 + X.rnd() * 0.4, z = -0.3 + X.rnd() * 0.5;
        if (X.rnd() < 0.5) b.cyl(x, 0.76, z, 0.033, 0.115, 8, m('trash', null, 0, { sub: [0, 0, 0.5, 0.5] }), 1, 0.033, MAT.steel(0.1));
        else b.with(M.mul(M.T(x, 0.793, z), M.RZ(PI / 2)), () => b.cyl(0, -0.057, 0, 0.033, 0.115, 8, m('trash', null, 0, { sub: [0, 0, 0.5, 0.5] }), 3, 0.033, MAT.steel(0.1)));
      }
      b.cyl(0.45, 0.76, 0.25, 0.06, 0.025, 10, m('glassdark', null, 1), 1);
      b.box(-0.05, 0.76, -0.3, 0.12, 0.765, -0.2, m('trash', null, 0, { sub: [0.5, 0.5, 1, 1] }), NY);
    }
  },

  chair(X) {
    const { b } = X;
    const office = ['buero', 'leitstand'].includes(X.zone);
    if (office) {
      const blk = m('plastic', C.black, 0.3);
      for (let i = 0; i < 5; i++) { const a = i * 2 * PI / 5; b.tube([0, 0.08, 0], [Math.cos(a) * 0.23, 0.05, Math.sin(a) * 0.23], 0.02, 5, blk); }
      b.cyl(0, 0.07, 0, 0.025, 0.36, 8, MAT.steel(0.2), 0);
      b.bbox(-0.22, 0.43, -0.22, 0.22, 0.5, 0.2, 0.03, MAT.fabric([0.12, 0.12, 0.14]), NY);
      b.bbox(-0.2, 0.55, 0.16, 0.2, 0.9, 0.22, 0.03, MAT.fabric([0.12, 0.12, 0.14]), NY);
      b.box(-0.02, 0.48, 0.18, 0.02, 0.58, 0.2, blk);
    } else {
      // folding camping chair / garden chair
      const fr = MAT.paint(C.dgrey, 0.3), cloth = MAT.fabric(X.rnd() < 0.5 ? [0.08, 0.15, 0.3] : [0.3, 0.08, 0.06]);
      b.tube([-0.2, 0, -0.2], [0.2, 0.45, 0.18], 0.012, 5, fr); b.tube([0.2, 0, -0.2], [-0.2, 0.45, 0.18], 0.012, 5, fr);
      b.tube([-0.2, 0, 0.2], [0.2, 0.45, -0.18], 0.012, 5, fr); b.tube([0.2, 0, 0.2], [-0.2, 0.45, -0.18], 0.012, 5, fr);
      b.box(-0.21, 0.43, -0.2, 0.21, 0.46, 0.18, cloth);
      b.with(M.mul(M.T(0, 0.45, 0.19), M.RX(-0.18)), () => b.box(-0.21, 0, -0.02, 0.21, 0.45, 0.01, cloth));
    }
  },

  tv(X) {
    const { b } = X;
    b.bbox(-0.5, 0, -0.2, 0.5, 0.55, 0.2, 0.01, MAT.board(0.6), NY, { [NZ]: MAT.lam([0.35, 0.28, 0.2]) });
    b.box(-0.5, 0.55, -0.2, 0.5, 0.58, 0.2, MAT.lam([0.3, 0.24, 0.18]));
    b.box(-0.12, 0.58, -0.08, 0.12, 0.6, 0.06, MAT.paint(C.black, 0.2));
    b.box(-0.03, 0.6, 0.0, 0.03, 0.72, 0.03, MAT.paint(C.black, 0.2));
    b.box(-0.5, 0.64, -0.03, 0.5, 1.2, 0.03, MAT.paint(C.black, 0.2));
    const on = X.zone === 'schlafen';
    b.quad([[0.47, 0.67, -0.031], [-0.47, 0.67, -0.031], [-0.47, 1.17, -0.031], [0.47, 1.17, -0.031]], [[0, 0], [1, 0], [1, 1], [0, 1]], on ? m('screen', [0.6, 0.7, 0.9], 0, { e: 0.8 }) : m('glassdark', null, 1));
    if (X.lodNear) { b.box(-0.4, 0.58, -0.15, -0.2, 0.66, 0.0, m('plastic', C.black, 0.2), NY); b.box(0.15, 0.58, -0.16, 0.35, 0.6, -0.08, m('trash', null, 0, { sub: [0.5, 0.5, 1, 1] }), NY); }
  },

  fridge(X) {
    const { b } = X;
    b.bbox(-0.3, 0.02, -0.3, 0.3, 1.8, 0.3, 0.025, MAT.paint([0.9, 0.9, 0.88], 0.5), NY);
    b.box(-0.29, 1.25, -0.302, 0.29, 1.255, -0.3, MAT.paint(C.dgrey, 0.3), NY);
    b.box(0.2, 0.8, -0.33, 0.23, 1.2, -0.3, MAT.paint(C.lgrey, 0.2)); b.box(0.2, 1.35, -0.33, 0.23, 1.6, -0.3, MAT.paint(C.lgrey, 0.2));
    if (X.lodNear) b.box(-0.2, 1.4, -0.302, -0.08, 1.52, -0.301, m('trash', null, 0, { sub: [0, 0.5, 0.5, 1] }), NY);
  },

  lockers(X) {
    const { b } = X;
    const body = MAT.paint([0.62, 0.66, 0.7], 0.5);
    b.box(-0.8, 0.08, -0.25, 0.8, 1.9, 0.25, body, NY, { [NZ]: m('locker', [0.95, 0.98, 1], [0.8, 1.82]) });
    b.box(-0.8, 0, -0.23, 0.8, 0.08, 0.23, MAT.paint(C.dgrey, 0.3), NY | FY);
    if (X.lodNear && X.rnd() < 0.6) {
      // one door ajar
      b.with(M.mul(M.T(-0.4, 0.1, -0.25), M.RY(-0.9)), () => b.box(0, 0, -0.012, 0.395, 1.78, 0, m('locker', [0.95, 0.98, 1], [0.8, 1.82], {}), 0));
      b.box(-0.39, 0.12, -0.24, -0.01, 1.86, -0.23, MAT.paint(C.black, 0.4), NY);
    }
  },

  desk(X) {
    const { b } = X;
    b.box(-0.8, 0.72, -0.4, 0.8, 0.75, 0.4, MAT.lam([0.85, 0.83, 0.78]));
    b.box(-0.8, 0, -0.4, -0.76, 0.72, 0.4, MAT.paint(C.lgrey, 0.5)); b.box(0.76, 0, -0.4, 0.8, 0.72, 0.4, MAT.paint(C.lgrey, 0.5));
    b.box(-0.76, 0.3, 0.36, 0.76, 0.72, 0.38, MAT.paint(C.lgrey, 0.5));
    b.box(-0.25, 0.75, 0.15, 0.25, 1.1, 0.2, MAT.paint(C.black, 0.2));
    b.box(-0.04, 0.75, 0.2, 0.04, 0.85, 0.3, MAT.paint(C.black, 0.2));
    screen(b, -0.23, 0.78, 0.149, 0.23, 1.08, X.zone === 'leitstand' ? 1.0 : 0.0, X.zone === 'leitstand' ? 'screen' : 'glassdark');
    if (X.lodNear) {
      b.box(-0.22, 0.75, -0.2, 0.22, 0.77, -0.05, MAT.paint(C.dgrey, 0.2));
      b.box(0.4, 0.75, -0.25, 0.7, 0.755, 0.05, m('trash', null, 0, { sub: [0.5, 0.5, 1, 1] }));
      b.cyl(-0.5, 0.75, -0.2, 0.04, 0.1, 10, MAT.plastic([0.9, 0.9, 0.9], 0.2), 1);
      for (let i = 0; i < 4; i++) b.box(-0.75 + i * 0.065, 0.75, 0.05, -0.69 + i * 0.065, 1.05, 0.33, MAT.plastic([[0.1, 0.25, 0.5], [0.5, 0.1, 0.1], [0.1, 0.1, 0.1], [0.2, 0.4, 0.2]][i], 0.3), NY);
    }
  },

  control_desk(X) {
    const { b } = X;
    const body = MAT.paint([0.62, 0.64, 0.62], 0.6);
    b.box(-2.0, 0.05, -0.5, 2.0, 0.72, 0.5, body, NY);
    b.box(-2.0, 0, -0.45, 2.0, 0.05, 0.45, MAT.paint(C.dgrey), NY | FY);
    // sloped control panel at the front edge
    b.quad([[2.0, 0.72, -0.5], [-2.0, 0.72, -0.5], [-2.0, 0.8, -0.15], [2.0, 0.8, -0.15]], [[0, 0], [4, 0], [4, 1], [0, 1]], m('panel', null, [1.0, 1]));
    b.box(-2.0, 0.72, -0.15, 2.0, 0.8, 0.5, body, NY | NZ);
    for (const [x0, x1] of [[-1.8, -0.7], [-0.55, 0.55], [0.7, 1.8]]) {
      b.box(x0, 0.8, 0.1, x1, 1.3, 0.15, MAT.paint(C.black, 0.2));
      screen(b, x0 + 0.03, 0.83, 0.099, x1 - 0.03, 1.27, 1.1, 'screen');
      b.box((x0 + x1) / 2 - 0.05, 0.8, 0.15, (x0 + x1) / 2 + 0.05, 0.95, 0.25, MAT.paint(C.black, 0.2));
    }
    if (X.lodNear) {
      b.box(-0.3, 0.8, -0.05, 0.3, 0.82, 0.08, MAT.paint(C.dgrey, 0.2));
      b.cyl(1.2, 0.8, -0.0, 0.04, 0.1, 10, MAT.plastic([0.9, 0.9, 0.9], 0.2), 1);
      b.box(-1.5, 0.8, -0.1, -1.2, 0.81, 0.1, m('trash', null, 0, { sub: [0.5, 0.5, 1, 1] }));
    }
  },

  server_rack(X) {
    const { b } = X;
    b.bbox(-0.3, 0, -0.5, 0.3, 2.0, 0.5, 0.01, MAT.paint(C.black, 0.4), NY, { [NZ]: m('mesh', [0.3, 0.3, 0.32], 0.12) });
    b.box(-0.27, 0.1, -0.48, 0.27, 1.9, -0.47, MAT.paint([0.05, 0.05, 0.06], 0.3), NY);
    if (X.lodNear) for (let i = 0; i < 10; i++) b.box(-0.2 + (i % 3) * 0.05, 0.4 + i * 0.13, -0.475, -0.19 + (i % 3) * 0.05, 0.41 + i * 0.13, -0.474, MAT.light(i % 4 === 0 ? 2.5 : 1.5, i % 4 === 0 ? [1, 0.4, 0.1] : [0.3, 1, 0.4]), NY);
  },

  el_cabinet(X) {
    const { b } = X;
    b.box(-0.6, 0.1, -0.25, 0.6, 2.0, 0.25, MAT.paint([0.82, 0.82, 0.78], 0.5), NY, { [NZ]: m('cabinet', [1, 1, 1], [1.2, 1.9]) });
    b.box(-0.6, 0, -0.23, 0.6, 0.1, 0.23, MAT.paint(C.dgrey), NY | FY);
    if (X.lodNear) sign(b, 'spannung', -0.12, 1.65, -0.252, 0.12, 1.89);
  },

  boiler(X) {
    const { b } = X;
    b.box(-0.6, 0, -0.6, 0.6, 0.15, 0.6, MAT.paint(C.dgrey, 0.4), NY);
    b.cyl(0, 0.15, 0, 0.55, 1.85, 18, MAT.paint([0.6, 0.08, 0.05], 0.6), 1, 0.55, MAT.paint([0.5, 0.06, 0.04], 0.6));
    b.box(-0.3, 0.6, -0.58, 0.3, 1.2, -0.5, MAT.paint(C.lgrey, 0.3), NY);
    if (X.lodNear) {
      screen(b, -0.15, 0.95, -0.581, 0.15, 1.1, 0.9, 'panel');
      b.tube([0.2, 2.0, 0.2], [0.2, 2.2, 0.2], 0.06, 10, MAT.steel(0.3)); b.tube([-0.25, 2.0, -0.1], [-0.25, 2.2, -0.1], 0.05, 10, MAT.steel(0.3));
      b.tube([0.45, 0.4, 0.3], [0.58, 0.4, 0.3], 0.04, 8, MAT.steel(0.3), 1);
    }
  },

  pump(X) {
    const { b } = X;
    b.box(-0.4, 0, -0.6, 0.4, 0.12, 0.6, MAT.paint([0.35, 0.38, 0.36], 0.4), NY);
    cylZ(b, 0, 0.4, -0.55, 0.1, 0.22, 14, MAT.paint([0.15, 0.3, 0.55], 0.5));
    if (X.lodNear) for (let i = 0; i < 6; i++) cylZ(b, 0, 0.4, -0.5 + i * 0.1, -0.47 + i * 0.1, 0.235, 14, MAT.paint([0.13, 0.27, 0.5], 0.5), 0);
    b.cyl(0, 0.12, 0.35, 0.22, 0.45, 14, MAT.paint([0.15, 0.3, 0.55], 0.5), 1);
    b.tube([0, 0.4, 0.35], [0, 0.78, 0.35], 0.08, 10, MAT.steel(0.3));
    b.tube([0.2, 0.35, 0.35], [0.4, 0.35, 0.35], 0.08, 10, MAT.steel(0.3));
  },

  safe(X) {
    const { b } = X;
    b.bbox(-0.4, 0, -0.4, 0.4, 1.2, 0.4, 0.03, MAT.paint([0.16, 0.18, 0.17], 0.4), NY);
    b.box(-0.33, 0.07, -0.41, 0.33, 1.13, -0.4, MAT.paint([0.13, 0.15, 0.14], 0.3), NY);
    b.with(M.mul(M.T(0.1, 0.75, -0.41), M.RX(-PI / 2)), () => b.cyl(0, 0, 0, 0.06, 0.03, 14, MAT.steel(0.2), 1));
    b.with(M.mul(M.T(0.1, 0.5, -0.41), M.RX(-PI / 2)), () => b.cyl(0, 0, 0, 0.025, 0.035, 8, MAT.steel(0.2), 1));
    for (let i = 0; i < 3; i++) { const a = i * 2 * PI / 3; b.tube([0.1, 0.5, -0.43], [0.1 + Math.cos(a) * 0.1, 0.5 + Math.sin(a) * 0.1, -0.43], 0.01, 5, MAT.steel(0.2)); }
  },

  cash_table(X) {
    const { b } = X;
    b.box(-1.0, 0.72, -0.5, 1.0, 0.76, 0.5, MAT.lam([0.75, 0.73, 0.68]));
    for (const x of [-0.95, 0.88]) { b.box(x, 0, -0.45, x + 0.07, 0.72, -0.4, MAT.steel(0.4), NY | FY); b.box(x, 0, 0.4, x + 0.07, 0.72, 0.45, MAT.steel(0.4), NY | FY); b.box(x, 0.1, -0.4, x + 0.07, 0.14, 0.4, MAT.steel(0.4)); }
    // money stacks (proxy -0.6..-0.1 × -0.2..0.1 × 0.76..0.9 and 0.1..0.5 × -0.3..0 × 0.76..0.86)
    const stacks = (x0, z0, nx, nz, maxH) => {
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const h = 0.03 + Math.floor(X.rnd() * (maxH / 0.013)) * 0.013;
        const cx = x0 + 0.08 + i * 0.165, cz = z0 + 0.04 + j * 0.075;
        if (X.lodNear) for (let k = 0; k * 0.024 < h; k++) bundle(b, cx + (X.rnd() - 0.5) * 0.01, 0.76 + k * 0.024, cz + (X.rnd() - 0.5) * 0.01, (X.rnd() - 0.5) * 0.08, 0.022);
        else b.box(cx - 0.078, 0.76, cz - 0.035, cx + 0.078, 0.76 + h, cz + 0.035, m('money'), NY);
      }
    };
    stacks(-0.6, -0.2, 3, 4, 0.12); stacks(0.1, -0.3, 2, 4, 0.09);
    // money counter (proxy 0.6..0.85 × 0..0.25 × 0.76..0.95)
    b.bbox(0.6, 0.76, 0.0, 0.85, 0.9, 0.25, 0.02, MAT.paint([0.22, 0.22, 0.24], 0.3), NY);
    b.quad([[0.85, 0.9, 0.0], [0.6, 0.9, 0.0], [0.6, 0.95, 0.12], [0.85, 0.95, 0.12]], [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.paint([0.22, 0.22, 0.24], 0.3));
    if (X.lodNear) {
      screen(b, 0.64, 0.84, -0.001, 0.81, 0.88, 1.3, 'panel');
      bundle(b, 0.72, 0.95, 0.15, 0.0, 0.015);
      for (let i = 0; i < 6; i++) bundle(b, -0.85 + X.rnd() * 0.5, 0.76, 0.2 + X.rnd() * 0.25, X.rnd() * 3, 0.012);
      b.box(-0.3, 0.76, 0.25, -0.1, 0.78, 0.4, MAT.paint(C.dgrey, 0.2));   // calculator
      for (let i = 0; i < 2; i++) b.with(M.mul(M.T(0.3 + i * 0.2, 0.76, 0.3), M.RY(X.rnd())), () => b.bbox(-0.08, 0, -0.06, 0.08, 0.06, 0.06, 0.02, m('plastic', [0.8, 0.82, 0.85], 0.2), NY));
    }
  },

  lab_table(X) {
    const { b } = X;
    b.box(-1.0, 0.86, -0.4, 1.0, 0.9, 0.4, MAT.steel(0.6));
    legs4(b, -0.98, -0.38, 0.98, 0.38, 0, 0.86, 0.04, MAT.steel(0.4));
    b.box(-0.95, 0.15, -0.35, 0.95, 0.17, 0.35, MAT.steel(0.6));
    // cooking pot on a gas burner (proxy -0.7..-0.3 × 0.9..1.2)
    b.cyl(-0.5, 0.9, 0, 0.2, 0.05, 14, MAT.paint(C.black, 0.2), 1);
    b.cyl(-0.5, 0.95, 0, 0.18, 0.24, 16, MAT.steel(0.4), 2, 0.18);
    if (X.lodNear) b.cyl(-0.5, 1.15, 0, 0.165, 0.005, 14, m('plastic', [0.85, 0.85, 0.8], 0.2), 1);
    // canister (proxy 0.2..0.45 × -0.15..0.05 × 0.9..1.25)
    b.bbox(0.22, 0.9, -0.14, 0.44, 1.2, 0.04, 0.02, MAT.plastic([0.85, 0.85, 0.78], 0.3), NY);
    b.cyl(0.4, 1.2, -0.05, 0.025, 0.04, 8, MAT.plastic([0.8, 0.1, 0.05], 0.2), 1);
    // bucket (proxy 0.55..0.75 × -0.1..0.1)
    b.cyl(0.65, 0.9, 0, 0.1, 0.2, 12, MAT.plastic([0.95, 0.95, 0.95], 0.3), 2, 0.09);
    if (X.lodNear) {
      // glassware, scale, gloves, bags of powder
      for (let i = 0; i < 4; i++) b.cyl(-0.1 + i * 0.08, 0.9, 0.25, 0.03, 0.12 + (i % 2) * 0.06, 8, m('glassdark', [1.4, 1.5, 1.6], 1), 1, 0.012);
      b.box(-0.9, 0.9, 0.1, -0.75, 0.93, 0.3, m('paint', C.dgrey, 0.2));
      b.with(M.mul(M.T(0.0, 0.9, -0.25), M.RY(0.3)), () => b.bbox(-0.1, 0, -0.07, 0.1, 0.05, 0.07, 0.02, m('plastic', [0.95, 0.95, 0.93], 0.2), NY));
      b.with(M.mul(M.T(-0.15, 0.9, -0.2), M.RY(-0.5)), () => b.bbox(-0.08, 0, -0.06, 0.08, 0.04, 0.06, 0.02, m('plastic', [0.95, 0.95, 0.93], 0.2), NY));
      b.box(0.82, 0.9, -0.3, 0.95, 0.91, -0.15, MAT.plastic([0.1, 0.3, 0.7], 0.2));
      // canisters under the table
      for (let i = 0; i < 3; i++) b.bbox(-0.8 + i * 0.3, 0.17, -0.25, -0.58 + i * 0.3, 0.52, -0.05, 0.02, MAT.plastic(i === 1 ? [0.1, 0.25, 0.6] : [0.85, 0.85, 0.78], 0.3), NY);
    }
  },

  drum(X) {
    const { b } = X;
    const steel = X.rnd() < 0.5, col = steel ? [0.15, 0.3, 0.12] : C.blue;
    b.cyl(0, 0, 0, 0.29, 0.88, X.lodNear ? 16 : 8, m('drum', col, [0.6, 0.88]), 1, 0.29, m('plastic', col, 0.4));
    if (X.lodNear) { b.cyl(0.15, 0.88, 0, 0.03, 0.015, 8, MAT.steel(0.1), 1); b.cyl(-0.15, 0.88, 0.05, 0.02, 0.015, 8, MAT.steel(0.1), 1); }
  },

  gas_bottles(X) {
    const { b } = X;
    const cols = [[0.35, 0.35, 0.35], [0.12, 0.3, 0.12], [0.55, 0.05, 0.04]];
    for (let i = 0; i < 3; i++) {
      const x = -0.26 + i * 0.26;
      b.cyl(x, 0, 0, 0.12, 1.2, 12, MAT.paint(cols[i], 0.5), 0);
      b.cyl(x, 1.2, 0, 0.12, 0.12, 12, MAT.paint(cols[(i + 1) % 3], 0.5), 1, 0.05);
      b.cyl(x, 1.32, 0, 0.03, 0.12, 8, MAT.steel(0.2), 1);
      if (X.lodNear) b.tube([x, 1.42, 0], [x + 0.06, 1.42, -0.05], 0.015, 5, MAT.steel(0.2));
    }
    b.box(-0.4, 0.9, 0.12, 0.4, 0.95, 0.15, MAT.paint(C.dgrey, 0.3));   // wall chain bracket
  },

  sheeting(X) {
    const { b } = X;
    // PVC strip curtain hung from a rail (cut-out gaps between strips)
    b.box(-1.5, 2.55, -0.02, 1.5, 2.6, 0.02, MAT.galv(0.5));
    const sm = m('plastic', [0.82, 0.88, 0.86], [0.3, 2.6]);
    for (let i = 0; i < 14; i++) {
      const x0 = -1.48 + i * 0.212, sw = 0.2, sway = Math.sin(i * 1.7) * 0.012;
      b.quad([[x0, 0.02, sway], [x0 + sw, 0.02, sway], [x0 + sw, 2.55, 0], [x0, 2.55, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], sm, true);
    }
  },

  trailer(X) {
    const { b } = X;
    const near = X.lodNear;
    // curtain-side trailer: box body z -6.8..6.8, axles at +z, landing legs at -z
    const side = m('trailer', null, 0), roof = m('tarp', [1.3, 1.3, 1.3], 2);
    b.box(-1.25, 1.2, -6.8, 1.25, 4.0, 6.8, side, NY, { [FY]: roof, [FZ]: MAT.paint([0.75, 0.75, 0.75], 1), [NZ]: MAT.paint([0.75, 0.75, 0.75], 1) });
    b.box(-1.25, 1.15, -6.8, 1.25, 1.2, 6.8, MAT.paint(C.dgrey, 1), FY);                               // floor edge
    b.box(-1.25, 3.92, -6.8, 1.25, 4.0, 6.8, MAT.paint([0.7, 0.7, 0.72], 1), NY | FY);                // top rail
    // rear doors (+z) with locking bars
    if (near) for (const x of [-0.9, -0.35, 0.35, 0.9]) b.box(x - 0.025, 1.3, 6.8, x + 0.025, 3.9, 6.84, MAT.steel(0.5), NY);
    b.box(-1.2, 1.15, 6.8, 1.2, 1.2, 6.8, MAT.paint(C.dgrey), 0);
    // chassis rails + under-run bumper
    b.box(-0.55, 0.95, -6.6, -0.4, 1.15, 6.6, MAT.paint(C.black), 0); b.box(0.4, 0.95, -6.6, 0.55, 1.15, 6.6, MAT.paint(C.black), 0);
    b.box(-1.1, 0.45, 6.6, 1.1, 0.6, 6.75, MAT.paint(C.dgrey), 0);
    // three axles with twin wheels
    for (const z of [4.0, 4.8, 5.6]) {
      cylX(b, -1.1, 1.1, 0.5, z, 0.06, 6, MAT.paint(C.black));
      for (const x of [-1.2, 0.86]) wheel(b, x + 0.17, 0.5, z, 0.5, 0.34, near ? 16 : 8, C.lgrey);
    }
    if (near) b.box(-1.25, 1.0, 3.6, 1.25, 1.12, 6.0, MAT.paint(C.black), NY);                          // mudguards
    // landing legs (proxy z -4.8..-4.4)
    for (const x of [-0.95, 0.85]) { b.box(x, 0.05, -4.7, x + 0.1, 1.15, -4.5, MAT.paint(C.dgrey)); b.box(x - 0.05, 0, -4.8, x + 0.15, 0.05, -4.4, MAT.paint(C.dgrey)); }
    if (near) { b.box(-0.95, 0.6, -4.62, 0.95, 0.66, -4.58, MAT.paint(C.dgrey)); b.box(-1.15, 0.55, 6.75, -0.8, 0.7, 6.76, MAT.light(1.2, [1, 0.15, 0.08])); b.box(0.8, 0.55, 6.75, 1.15, 0.7, 6.76, MAT.light(1.2, [1, 0.15, 0.08])); }
  },

  truck(X) {
    const { b } = X;
    const near = X.lodNear;
    // 7.5 t box truck: cab at -z (proxy z -3.6..-1.7, y 0.4..3.0), box body z -1.6..5.0 y 1.1..3.8
    b.box(-1.25, 1.1, -1.6, 1.25, 3.8, 5.0, m('trailer', null, 0), NY, { [FY]: MAT.paint([0.8, 0.8, 0.8], 2), [FZ]: MAT.paint([0.85, 0.85, 0.85], 1), [NZ]: MAT.paint([0.85, 0.85, 0.85], 1) });
    const cab = MAT.paint([0.62, 0.05, 0.04], 0.8);
    b.bbox(-1.2, 0.55, -3.6, 1.2, 2.2, -1.7, 0.06, cab, NY);
    b.bbox(-1.15, 2.2, -3.35, 1.15, 2.95, -1.7, 0.08, cab, NY);
    // windscreen + side windows
    b.quad([[1.05, 1.75, -3.61], [-1.05, 1.75, -3.61], [-1.05, 2.15, -3.61], [1.05, 2.15, -3.61]], [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    b.quad([[-1.05, 2.2, -3.36], [1.05, 2.2, -3.36], [1.05, 2.85, -3.36], [-1.05, 2.85, -3.36]].reverse(), [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    for (const sx of [-1, 1]) {
      const x = sx * 1.201;
      const q = sx > 0 ? [[x, 1.75, -2.4], [x, 1.75, -3.2], [x, 2.8, -3.2], [x, 2.8, -2.4]] : [[x, 1.75, -3.2], [x, 1.75, -2.4], [x, 2.8, -2.4], [x, 2.8, -3.2]];
      b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
      if (near) b.box(sx * 1.25 - 0.03, 2.0, -3.3, sx * 1.25 + 0.03 * sx, 2.4, -3.2, MAT.paint(C.black), NY);
    }
    b.box(-0.9, 0.7, -3.62, 0.9, 1.4, -3.6, MAT.paint(C.dgrey, 0.3), NY);                              // grille
    if (near) { b.box(-1.1, 0.75, -3.62, -0.8, 0.95, -3.6, MAT.light(1.0), NY); b.box(0.8, 0.75, -3.62, 1.1, 0.95, -3.6, MAT.light(1.0), NY); }
    b.box(-1.15, 0.4, -3.65, 1.15, 0.6, -3.5, MAT.paint(C.dgrey), 0);
    b.box(-0.5, 0.6, -1.7, 0.5, 1.1, 5.0, MAT.paint(C.black), 0);                                     // chassis
    for (const z of [-2.7, 3.5]) for (const sx of [-1, 1]) wheel(b, sx * 0.95, 0.48, z, 0.48, 0.3, near ? 16 : 8, C.lgrey);
    if (near) b.box(-1.2, 0.6, 4.0, 1.2, 0.9, 4.9, MAT.paint(C.dgrey), 0);
  },

  container20(X) { container(X, 3.03); },
  container40(X) { container(X, 6.1); },

  booth(X) {
    const { b } = X;
    const wall = MAT.paint([0.85, 0.85, 0.82], 0.8);
    b.box(-1.5, 0, -1.5, 1.5, 0.25, 1.5, MAT.concrete(), NY);
    b.box(-1.45, 0.25, -1.45, 1.45, 2.45, 1.45, wall, NY | FY);
    // windows: band on three sides, door on the east
    const win = (q) => b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    win([[1.2, 1.1, -1.451], [-1.2, 1.1, -1.451], [-1.2, 2.1, -1.451], [1.2, 2.1, -1.451]]);
    win([[-1.451, 1.1, -1.2], [-1.451, 1.1, 1.2], [-1.451, 2.1, 1.2], [-1.451, 2.1, -1.2]]);
    win([[-1.2, 1.1, 1.451], [1.2, 1.1, 1.451], [1.2, 2.1, 1.451], [-1.2, 2.1, 1.451]]);
    b.box(1.45, 0.25, -0.5, 1.47, 2.3, 0.5, MAT.paint([0.4, 0.42, 0.45], 0.6), NY);                  // door
    b.box(-1.5, 2.45, -1.5, 1.5, 2.6, 1.5, MAT.paint(C.dgrey, 1));                                     // roof
    if (X.lodNear) {
      b.box(-0.8, 2.6 - 0.001, -0.3, 0.8, 2.6, 0.3, MAT.paint(C.dgrey, 1), NY);
      b.box(-1.0, 1.9, 1.47, 1.0, 2.25, 1.5, MAT.paint([0.9, 0.9, 0.9], 0.5), NY);
      b.quad([[1.0, 1.92, 1.501], [-1.0, 1.92, 1.501], [-1.0, 2.23, 1.501], [1.0, 2.23, 1.501]].reverse(), [[0, 0], [1, 0], [1, 1], [0, 1]], m('stencil', [0.2, 0.3, 0.6], 0));
    }
  },

  skip(X) {
    const { b } = X;
    const y = MAT.paint(C.yellow, 0.8);
    // tapered open-top skip: bottom 2.0 × 2.4, top 2.0 × 3.6
    const bt = 1.2, tp = 1.8, h = 1.4;
    b.quad([[1.0, 0.05, bt], [-1.0, 0.05, bt], [-1.0, h, tp], [1.0, h, tp]].reverse(), [[0, 0], [2, 0], [2, 1.4], [0, 1.4]], y);
    b.quad([[-1.0, 0.05, -bt], [1.0, 0.05, -bt], [1.0, h, -tp], [-1.0, h, -tp]].reverse(), [[0, 0], [2, 0], [2, 1.4], [0, 1.4]], y);
    b.quad([[1.0, 0.05, -bt], [1.0, 0.05, bt], [1.0, h, tp], [1.0, h, -tp]], [[0, 0], [2.4, 0], [3.6, 1.4], [0, 1.4]], y, true);
    b.quad([[-1.0, 0.05, bt], [-1.0, 0.05, -bt], [-1.0, h, -tp], [-1.0, h, tp]], [[0, 0], [2.4, 0], [3.6, 1.4], [0, 1.4]], y, true);
    b.quad([[1.0, 0.05, bt], [-1.0, 0.05, bt], [-1.0, h, tp], [1.0, h, tp]], [[0, 0], [2, 0], [2, 1.4], [0, 1.4]], y);
    b.quad([[-1.0, 0.05, -bt], [1.0, 0.05, -bt], [1.0, h, -tp], [-1.0, h, -tp]], [[0, 0], [2, 0], [2, 1.4], [0, 1.4]], y);
    b.box(-0.95, 0, -1.15, 0.95, 0.05, 1.15, MAT.paint(C.dgrey), NY);
    b.box(-1.0, h - 0.08, -1.8, 1.0, h, 1.8, y, FY | NY | FX | NX);
    // junk inside: rubble floor + bags + broken pallet
    b.box(-0.95, 0.05, -1.4, 0.95, 0.55, 1.4, MAT.concrete(), NY | FX | NX | FZ | NZ);
    if (X.lodNear) {
      for (let i = 0; i < 3; i++) b.with(M.mul(M.T(-0.5 + i * 0.5, 0.55, -0.6 + i * 0.5), M.RY(i)), () => b.bbox(-0.3, 0, -0.25, 0.3, 0.45, 0.25, 0.1, m('plastic', C.black, 0.3), NY));
      b.with(M.mul(M.T(0.2, 0.75, 0.9), M.mul(M.RY(0.5), M.RX(0.5))), () => pallet(b, -0.6, 0, -0.4, 0.6, 0.4));
    }
  },

  car(X) {
    const { b } = X;
    const cols = [[0.55, 0.56, 0.58], [0.05, 0.05, 0.06], [0.85, 0.85, 0.83], [0.08, 0.15, 0.35], [0.3, 0.04, 0.03]];
    const body = MAT.paint(cols[Math.floor(X.rnd() * cols.length)], 1.5);
    b.bbox(-0.9, 0.3, -2.2, 0.9, 0.78, 2.2, 0.08, body, NY);
    b.bbox(-0.82, 0.78, -1.1, 0.82, 1.38, 0.85, 0.12, MAT.glass(), NY, { [FY]: body });
    b.quad([[0.82, 0.78, -1.11], [-0.82, 0.78, -1.11], [-0.7, 1.3, -0.6], [0.7, 1.3, -0.6]], [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    for (const z of [-1.35, 1.35]) for (const x of [-0.78, 0.78]) wheel(b, x, 0.31, z, 0.31, 0.2, X.lodNear ? 14 : 8);
    if (X.lodNear) {
      b.box(-0.8, 0.55, -2.21, -0.5, 0.68, -2.2, MAT.light(0.6)); b.box(0.5, 0.55, -2.21, 0.8, 0.68, -2.2, MAT.light(0.6));
      b.box(-0.8, 0.6, 2.2, -0.5, 0.7, 2.21, MAT.light(0.4, [1, 0.1, 0.05])); b.box(0.5, 0.6, 2.2, 0.8, 0.7, 2.21, MAT.light(0.4, [1, 0.1, 0.05]));
      b.box(-0.35, 0.35, -2.22, 0.35, 0.45, -2.2, MAT.paint([0.9, 0.9, 0.85], 0.3));
    }
  },

  van(X) {
    const { b } = X;
    // police transporter (extraction vehicle): white with blue/neon livery
    const white = MAT.paint([0.92, 0.92, 0.9], 1.5);
    b.bbox(-1.0, 0.35, -2.6, 1.0, 1.0, 2.6, 0.08, white, NY);
    b.bbox(-1.0, 1.0, -1.2, 1.0, 2.4, 2.6, 0.1, white, NY);
    b.bbox(-0.97, 1.0, -2.0, 0.97, 1.75, -1.2, 0.12, white, NY);
    b.quad([[0.9, 1.05, -2.01], [-0.9, 1.05, -2.01], [-0.85, 1.7, -1.5], [0.85, 1.7, -1.5]], [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    for (const sx of [-1, 1]) {
      const x = sx * 1.004;
      const band = (y0, y1, col) => b.quad(sx > 0 ? [[x, y0, 2.5], [x, y0, -2.5], [x, y1, -2.5], [x, y1, 2.5]] : [[x, y0, -2.5], [x, y0, 2.5], [x, y1, 2.5], [x, y1, -2.5]], [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.paint(col, 2));
      band(0.62, 0.82, [0.05, 0.15, 0.55]); band(0.82, 0.9, [0.55, 0.8, 0.05]);
      const w = sx > 0 ? [[x, 1.25, -0.4], [x, 1.25, -1.15], [x, 1.85, -1.15], [x, 1.85, -0.4]] : [[x, 1.25, -1.15], [x, 1.25, -0.4], [x, 1.85, -0.4], [x, 1.85, -1.15]];
      b.quad(w, [[0, 0], [1, 0], [1, 1], [0, 1]], MAT.glass());
    }
    b.box(-0.5, 2.4, -1.0, 0.5, 2.45, -0.75, MAT.light(2.0, [0.15, 0.3, 1.0]));
    for (const z of [-1.6, 1.7]) for (const x of [-0.85, 0.85]) wheel(b, x, 0.35, z, 0.35, 0.22, X.lodNear ? 14 : 8);
  },

  bollard(X) {
    const { b } = X;
    b.cyl(0, 0, 0, 0.08, 1.0, 10, MAT.paint(C.yellow, 0.5), 1);
    b.cyl(0, 0.62, 0, 0.082, 0.1, 10, m('paint', C.black, 0.5), 0); b.cyl(0, 0.82, 0, 0.082, 0.1, 10, m('paint', C.black, 0.5), 0);
  },

  charger(X) {
    const { b } = X;
    b.bbox(-0.4, 0, -0.15, 0.4, 1.4, 0.15, 0.02, MAT.paint([0.85, 0.85, 0.82], 0.5), NY);
    screen(b, -0.15, 1.0, -0.151, 0.15, 1.18, 1.0, 'panel');
    b.box(-0.3, 0.05, -0.15 - 0.002, 0.3, 0.2, -0.15, MAT.paint(C.dgrey, 0.3), NY);
    b.box(-0.25, 0.08, -0.17, -0.15, 0.17, -0.15, MAT.steel(0.1), NY); b.box(0.15, 0.08, -0.17, 0.25, 0.17, -0.15, MAT.steel(0.1), NY);
    b.box(-0.35, 1.3, -0.152, 0.35, 1.36, -0.15, MAT.light(1.5, [0.2, 1, 0.3]), NY);
  },

  robot_base(X) {
    const { b } = X;
    b.box(-0.6, 0, -0.6, 0.6, 0.06, 0.6, MAT.steel(0.6), NY);
    b.bbox(-0.45, 0.06, -0.45, 0.45, 0.74, 0.45, 0.04, MAT.paint([0.3, 0.32, 0.33], 0.5), NY);
    b.box(-0.55, 0.74, -0.55, 0.55, 0.8, 0.55, MAT.steel(0.6));
    if (X.lodNear) for (const [x, z] of [[-0.52, -0.52], [0.48, -0.52], [-0.52, 0.48], [0.48, 0.48]]) b.cyl(x + 0.02, 0.06, z + 0.02, 0.02, 0.03, 6, MAT.steel(0.1), 1);
  },

  bins(X) {
    const { b } = X;
    const cols = [C.blue, [0.6, 0.08, 0.05], [0.12, 0.3, 0.15], [0.5, 0.5, 0.52]];
    b.box(-0.6, 0, -0.4, 0.6, 0.1, 0.4, MAT.paint(C.dgrey), NY);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 3; k++) {
      const x0 = -0.59 + i * 0.6, z0 = -0.39 + j * 0.4, y0 = 0.1 + k * 0.265;
      const col = cols[(i + j * 2 + (X.rnd() < 0.3 ? 1 : 0)) % 4];
      b.box(x0, y0, z0, x0 + 0.58, y0 + 0.26, z0 + 0.38, MAT.plastic(col, [0.3, 0.13]), NY);
    }
  },

  lamp_highbay() {}, lamp_tube() {},   // greybox emissive boxes stay (circuit-driven); housings in decor
};

function container(X, hl) {
  const { b } = X;
  const pal = [[0.5, 0.07, 0.04], [0.06, 0.2, 0.45], [0.12, 0.3, 0.16], [0.55, 0.55, 0.55], [0.6, 0.32, 0.05]];
  const col = pal[(X.rnd() * pal.length) | 0];
  const wall = m('container', col, [1.12, 2.6]);
  b.box(-1.22, 0.1, -hl, 1.22, 2.49, hl, wall, NY, { [FY]: m('container', col, [1.2, 1.2]), [FZ]: m('container', col, [0.6, 2.4]) });
  // frame: bottom + top rails, corner posts and castings
  const fr = MAT.paint(col.map((v) => v * 0.8), 1);
  b.box(-1.22, 0, -hl, 1.22, 0.1, hl, fr, NY);
  b.box(-1.22, 2.49, -hl, 1.22, 2.59, hl, fr, 0);
  if (X.lodNear) {
    for (const x of [-1.22, 1.06]) for (const z of [-hl, hl - 0.16]) { b.box(x, 0.1, z, x + 0.16, 2.49, z + 0.16, fr, NY | FY); }
    // door locking bars on the +z end
    for (const x of [-0.85, -0.35, 0.35, 0.85]) { b.box(x - 0.02, 0.15, hl, x + 0.02, 2.45, hl + 0.03, MAT.steel(0.5), NY); b.box(x - 0.05, 1.1, hl, x + 0.05, 1.25, hl + 0.05, MAT.steel(0.3), NY); }
    b.box(-0.01, 0.12, hl, 0.01, 2.47, hl + 0.01, MAT.paint(C.black), NY);
  }
}

// ---- racking (raw boxes from props.js) --------------------------------------------------------------------------
/** art for one raw rack/akl box (group 'rack' | 'akl'); bx = { min, max, surf, rack } in world coords */
export function rawRack(X, bx) {
  const { b } = X;
  const [x0, y0, z0] = bx.min, [x1, y1, z1] = bx.max;
  const sy = y1 - y0;
  const s = bx.surf;
  const aisle = X.aisle ?? [-1, 1];
  const posA = aisle.includes(1), negA = aisle.includes(-1);
  // faces never seen: x faces towards a back-to-back neighbour
  const hideX = (posA ? 0 : FX) | (negA ? 0 : NX);
  const onlyX = ~((posA ? FX : 0) | (negA ? NX : 0)) & 63;   // mask keeping only the aisle faces
  if (bx.group === 'akl') {
    if (s === 'steel') {
      X.lod(3); b.box(x0, y0, z0, x1, y1, z1, m('upright', [0.42, 0.44, 0.48], [0.12, 0.4]), onlyX);
      X.lod(1); b.box(x0, y0, z0, x1, y1, z1, m('paint', [0.36, 0.37, 0.4], 0.4), NY | FY | FX | NX);
      return;
    }
    // bay-level load: only the aisle face is ever seen (crane aisle / window)
    const k = (Math.floor(x0 * 7 + y0 * 13 + z0 * 3) >>> 0) % 5;
    X.lod(3);
    b.box(x0, y0, z0, x1, y0 + 0.12, z1, m('pallet_side'), onlyX, { [FX]: m('pallet_end', null, [0.8, 0.12]), [NX]: m('pallet_end', null, [0.8, 0.12]) });
    load(b, x0 + 0.02, y0 + 0.12, z0 + 0.03, x1 - 0.02, y1, z1 - 0.03, s === 'plastic' ? (k < 2 ? 'wrap' : 'totes') : 'cartons', onlyX);
    X.lod(1);
    const ax = posA ? x1 - 0.7 : x0, bx2 = posA ? x1 : x0 + 0.7;
    b.box(ax, y0 - 0.06, z0 - 0.04, bx2, y0, z0 + 0.02, MAT.galv(0.6), FY);
    b.box(ax, y0 - 0.06, z1 - 0.02, bx2, y0, z1 + 0.04, MAT.galv(0.6), FY);
    return;
  }
  if (s === 'rackBlue') {   // upright: aisle face perforated, 8 m
    const outer = (x0 + x1) / 2 > X.rackMid ? FX : NX;   // the face pointing out of the run
    const isAisle = (outer === FX && posA) || (outer === NX && negA);
    const up = m('upright', null, [0.1, 0.4]), side = m('paint', [0.05, 0.13, 0.36], [0.1, 0.4]);
    if (isAisle) { X.lod(3); b.box(x0, y0, z0, x1, y1, z1, up, ~outer & 63); }
    X.lod(1);
    b.box(x0, y0, z0, x1, y1, z1, side, NY | FX | NX);
    if (isAisle) b.box(x0 - 0.01, 0, z0 - 0.06, x1 + 0.01, 0.012, z1 + 0.06, MAT.galv(0.3), NY);   // base plate
    return;
  }
  if (s === 'rackOrange') {   // beam (box section 0.06 × 0.12); the aisle face catches the light
    const outer = (x0 + x1) / 2 > X.rackMid ? FX : NX, inner = outer === FX ? NX : FX;
    const isAisle = (outer === FX && posA) || (outer === NX && negA);
    const bm = m('beam', null, [0.6, 0.12]);
    if (isAisle) { X.lod(3); b.box(x0, y0, z0, x1, y1, z1, bm, ~outer & 63); }
    X.lod(1);
    b.box(x0, y0, z0, x1, y1, z1, bm, (isAisle ? outer : 0) | FZ | NZ | (isAisle ? 0 : outer), { [FY]: m('beam', [0.8, 0.8, 0.8], 0.6), [NY]: m('beam', [0.6, 0.6, 0.6], 0.6), [inner]: m('beam', [0.7, 0.7, 0.7], [0.6, 0.12]) });
    return;
  }
  if (s === 'wood' && sy < 0.16) {   // pallet on the beams: end faces to the aisles
    const end = m('pallet_end');
    X.lod(3); b.box(x0, y0, z0, x1, y1, z1, end, onlyX);
    X.lod(1);
    b.box(x0, y0, z0, x1, y1, z1, m('pallet_side'), NY | FY | FX | NX);
    const cx0 = x0 + 0.12, cx1 = x1 - 0.12, cz0 = z0 + 0.14, cz1 = z1 - 0.14;
    b.box(cx0, y0 + 0.022, cz0, cx1, y0 + 0.122, cz1, m('wood', [0.4, 0.34, 0.28], [1.2, 0.15]), onlyX | FY | NY | FZ | NZ);
    return;
  }
  // loads: aisle faces (both LODs), sides + top near; far top only for the upper levels (seen from the catwalk)
  const kind = s === 'wrap' ? 'wrap' : 'cartons';
  X.lod(3); load(b, x0, y0, z0, x1, y1, z1, kind, onlyX);
  X.lod(y1 > 4.0 ? 3 : 1); load(b, x0, y0, z0, x1, y1, z1, kind, ~FY & 63);
  X.lod(1); load(b, x0, y0, z0, x1, y1, z1, kind, NY | FY | FX | NX | hideX);
}

/** per rack run: frame lacing (between front and back uprights), labels and load signs */
export function rackExtras(X, run) {
  const { b } = X;
  const { x0, x1, frames, beams } = run;
  const lac = m('lacing', null, [x1 - x0 - 0.16, 1.0]);
  X.lod(3);
  for (const z of frames) {
    const p = [[x0 + 0.08, 0.15, z], [x1 - 0.08, 0.15, z], [x1 - 0.08, 7.8, z], [x0 + 0.08, 7.8, z]];
    b.quad(p, [[0, 0], [1, 0], [1, 7.65], [0, 7.65]], lac, true);
  }
  // location labels on the first beam level + load signs on the run ends (LOD0)
  X.lod(1);
  for (const bm of beams) {
    const face = bm.face, xf = face > 0 ? bm.x + 0.001 : bm.x - 0.001;
    const lab = cell(2, 4, bm.k % 8);
    const za = bm.zc - 0.12, zb = bm.zc + 0.12;
    b.quad(face > 0 ? [[xf, bm.y - 0.1, zb], [xf, bm.y - 0.1, za], [xf, bm.y - 0.02, za], [xf, bm.y - 0.02, zb]]
      : [[xf, bm.y - 0.1, za], [xf, bm.y - 0.1, zb], [xf, bm.y - 0.02, zb], [xf, bm.y - 0.02, za]], [[0, 0], [1, 0], [1, 1], [0, 1]], m('labels', null, 0, { sub: lab }));
  }
  for (const e of run.ends) {
    const xf = e.face > 0 ? e.x + 0.002 : e.x - 0.002;
    const q = e.face > 0 ? [[xf, 1.35, e.z + 0.18], [xf, 1.35, e.z - 0.18], [xf, 1.62, e.z - 0.18], [xf, 1.62, e.z + 0.18]]
      : [[xf, 1.35, e.z - 0.18], [xf, 1.35, e.z + 0.18], [xf, 1.62, e.z + 0.18], [xf, 1.62, e.z - 0.18]];
    b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], m('loadsign'));
  }
  // end-of-aisle protectors (yellow/black angle) at the frames that face cross aisles
  for (const ez of run.protect) {
    for (const xx of [x0, x1 - 0.12]) b.box(xx, 0, ez.z0, xx + 0.12, 0.4, ez.z1, m('hazard', null, [0.4, 0.1]), NY);
  }
}
