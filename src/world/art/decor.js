// Art-only details without gameplay proxies (workstream A): floor markings, signage, fire extinguishers,
// light-fixture housings, sprinkler mains, cable trays, dock shelters + roller-door guides, facade lettering,
// AGV floor codes, gang clutter. Everything sits ≥ 1 cm off walls/floors (no z-fighting) and never blocks a path.
import { M, FX, NX, FY, NY, FZ, NZ, rng } from './kit.js';
import { MAT, C } from './models.js';
import { cell, signSub } from './tiles.js';
import { HALL } from '../layout/site.js';

const m = (t, c = null, s = 0, x = {}) => ({ t, ...(c ? { c } : {}), s, ...x });
const FL = 0.01;   // floor decal height

/** horizontal floor strip from (x0,z0) to (x1,z1) (axis aligned), width w */
function floorStrip(b, x0, z0, x1, z1, w, mat, y = FL) {
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const a = alongX ? Math.min(x0, x1) : Math.min(z0, z1), bb = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
  const o = alongX ? z0 : x0, L = bb - a;
  const q = alongX ? [[a, y, o + w / 2], [bb, y, o + w / 2], [bb, y, o - w / 2], [a, y, o - w / 2]]
    : [[o - w / 2, y, bb], [o + w / 2, y, bb], [o + w / 2, y, a], [o - w / 2, y, a]];
  b.quad(q, [[0, 0], [L / 0.5, 0], [L / 0.5, 1], [0, 1]], mat);
}
/** wall-mounted quad facing direction f ('+x','-x','+z','-z') centred at (x, y, z) */
function wallQuad(b, x, y, z, w, h, f, mat) {
  const hw = w / 2, hh = h / 2;
  let q;
  if (f === '+z') q = [[x - hw, y - hh, z], [x + hw, y - hh, z], [x + hw, y + hh, z], [x - hw, y + hh, z]];
  else if (f === '-z') q = [[x + hw, y - hh, z], [x - hw, y - hh, z], [x - hw, y + hh, z], [x + hw, y + hh, z]];
  else if (f === '+x') q = [[x, y - hh, z + hw], [x, y - hh, z - hw], [x, y + hh, z - hw], [x, y + hh, z + hw]];
  else q = [[x, y - hh, z - hw], [x, y - hh, z + hw], [x, y + hh, z + hw], [x, y + hh, z - hw]];
  b.quad(q, [[0, 0], [1, 0], [1, 1], [0, 1]], mat);
}
const signM = (name, e = 0) => m('signs', null, 0, { sub: signSub(name), e });
const OFF = { '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0] };

function extinguisher(b, x, z, f) {
  const o = OFF[f], px = x + o[0] * 0.12, pz = z + o[2] * 0.12;
  b.cyl(px, 0.35, pz, 0.085, 0.5, 10, MAT.paint(C.red, 0.4), 1, 0.085);
  b.cyl(px, 0.85, pz, 0.03, 0.08, 6, MAT.paint(C.black, 0.2), 1);
  b.tube([px, 0.9, pz], [px + o[2] * 0.08 + o[0] * 0.05, 0.6, pz + o[0] * 0.08 + o[2] * 0.05], 0.012, 4, MAT.paint(C.black, 0.2));
  wallQuad(b, x + o[0] * 0.012, 1.75, z + o[2] * 0.012, 0.3, 0.3, f, signM('feuerloescher'));
}

export function decorArt(L, place, B, free = () => true) {
  const yellowLine = m('floorline', null, [0.5, 0.5]);
  const whiteLine = m('floorline', [1.05, 1.15, 1.6], [0.5, 0.5]);

  // ---- hall: aisle edge lines in front of every rack run facing an aisle, cross-aisle walkway lines
  const runs = HALL.racks;
  const faces = [];
  runs.forEach(([x0, x1], i) => {
    const left = i === 0 || Math.abs(runs[i - 1][1] - x0) > 0.05, right = i === runs.length - 1 || Math.abs(runs[i + 1][0] - x1) > 0.05;
    if (left) faces.push(x0 - 0.15); if (right) faces.push(x1 + 0.15);
  });
  for (const x of faces) for (const [z0, z1] of [HALL.segN, HALL.segS]) {
    for (let z = z0; z < z1 - 0.01; z += 5.4) {
      const za = z, zb = Math.min(z1, z + 5.4);
      place(x, 0.5, (za + zb) / 2, (X) => floorStrip(X.b, x, za, x, zb, 0.08, yellowLine), 'line');
    }
  }
  // cross aisle walkway (pedestrian) lines along x
  for (const z of [HALL.segN[0] - 0.4, HALL.segN[1] + 0.4, HALL.segS[0] - 0.4, HALL.segS[1] + 0.4]) {
    for (let x = HALL.x0 + 0.5; x < HALL.x1 - 0.5; x += 5) {
      const xa = x, xb = Math.min(HALL.x1 - 0.5, x + 5);
      place((xa + xb) / 2, 0.5, z, (X) => floorStrip(X.b, xa, z, xb, z, 0.1, yellowLine), 'line');
    }
  }
  // AGV routes: dashed white lines + floor codes
  for (const r of L.agvRoutes) {
    const pts = r.points, n = r.loop ? pts.length : pts.length - 1;
    for (let s = 0; s < n; s++) {
      const A = pts[s], Bp = pts[(s + 1) % pts.length], len = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]);
      const dx = (Bp[0] - A[0]) / len, dz = (Bp[1] - A[1]) / len;
      for (let t = 0.5; t < len - 0.5; t += 2.0) {
        const xa = A[0] + dx * t, za = A[1] + dz * t, xb = A[0] + dx * (t + 1.0), zb = A[1] + dz * (t + 1.0);
        place((xa + xb) / 2, 0.5, (za + zb) / 2, (X) => {
          for (const off of [-0.5, 0.5]) floorStrip(X.b, xa + dz * off, za - dx * off, xb + dz * off, zb - dx * off, 0.06, whiteLine);
          X.b.quad([[xa - 0.05, FL, za + 0.05], [xa + 0.05, FL, za + 0.05], [xa + 0.05, FL, za - 0.05], [xa - 0.05, FL, za - 0.05]], [[0, 0], [1, 0], [1, 1], [0, 1]], m('decals', null, 0, { sub: cell(2, 2, 3) }));
        }, 'agv');
      }
    }
  }
  // stencil "ACHTUNG FTS" where AGV route 2 enters the hall
  place(66, 0.5, 59, (X) => X.b.quad([[64.5, FL, 59.6], [67.5, FL, 59.6], [67.5, FL, 58.4], [64.5, FL, 58.4]], [[0, 0], [1, 0], [1, 1], [0, 1]], m('stencil')), 'stencil');
  // hatched hazard areas inside the dock doors
  for (const [a, bb] of [[3.25, 6.75], [10.25, 13.75], [17.25, 20.75]]) {
    place((a + bb) / 2, 0.5, 63, (X) => {
      X.b.quad([[a, FL, 64 - 0.02], [bb, FL, 64 - 0.02], [bb, FL, 62.6], [a, FL, 62.6]], [[0, 0], [(bb - a) / 0.5, 0], [(bb - a) / 0.5, 1.4 / 0.5], [0, 1.4 / 0.5]], m('hazard', null, [0.5, 0.5]));
    }, 'dock');
  }
  for (const [a, bb] of [[75.5, 79], [80.5, 84]]) {
    place((a + bb) / 2, 0.5, 63, (X) => X.b.quad([[a, FL, 64 - 0.02], [bb, FL, 64 - 0.02], [bb, FL, 62.8], [a, FL, 62.8]], [[0, 0], [(bb - a) / 0.5, 0], [(bb - a) / 0.5, 1.2 / 0.5], [0, 1.2 / 0.5]], m('hazard', null, [0.5, 0.5])), 'dock');
  }
  // robot cell: hatched floor border inside the fence
  place(90, 0.5, 47.5, (X) => floorStrip(X.b, 84.3, 47.7, 95.7, 47.7, 0.3, m('hazard', null, [0.5, 0.3])), 'cell');
  // yard: parking bays (white) + lane line
  for (let x = 64; x <= 74; x += 2.5) place(x, 0.5, 104, (X) => floorStrip(X.b, x, 101.5, x, 106.5, 0.12, whiteLine), 'park');
  for (let x = 30; x < 60; x += 6) place(x + 1.5, 0.5, 95, (X) => floorStrip(X.b, x, 95, x + 3, 95, 0.12, whiteLine), 'lane');

  // ---- dock doors: shelters outside, guide rails + drum housing inside, Tor numbers
  const docks = [['tor1', 3.25, 6.75, 64.15], ['tor2', 10.25, 13.75, 64.15], ['tor3', 17.25, 20.75, 64.15], ['tor4', 75.5, 79, 64.15], ['tor5', 80.5, 84, 64.15]];
  for (const [name, a, bb] of docks) {
    const cx = (a + bb) / 2;
    place(cx, 1, 64.6, (X) => {
      const b = X.b, sh = m('tarp', [0.35, 0.36, 0.38], 1);
      b.box(a - 0.6, 0, 64.31, a, 4.6, 64.9, sh, NY); b.box(bb, 0, 64.31, bb + 0.6, 4.6, 64.9, sh, NY);
      b.box(a - 0.6, 4.2, 64.31, bb + 0.6, 4.9, 64.9, sh, NY);
      b.box(a - 0.45, 0, 64.9, a - 0.15, 0.6, 65.05, MAT.rubber(0.3), NY); b.box(bb + 0.15, 0, 64.9, bb + 0.45, 0.6, 65.05, MAT.rubber(0.3), NY);
      wallQuad(b, cx, 5.35, 64.911, 0.7, 0.7, '+z', signM(name));
    }, 'dock');
    place(cx, 1, 63.6, (X) => {
      const b = X.b, st = MAT.galv(0.5);
      b.box(a - 0.12, 0, 63.88, a, 4.3, 63.99, st, NY); b.box(bb, 0, 63.88, bb + 0.12, 4.3, 63.99, st, NY);
      b.box(a - 0.2, 4.25, 63.45, bb + 0.2, 4.85, 63.99, MAT.paint([0.55, 0.57, 0.6], 0.6));
      b.box(bb + 0.25, 1.1, 63.86, bb + 0.5, 1.45, 63.99, MAT.paint([0.85, 0.85, 0.82], 0.3), NY);   // door control box
      b.box(bb + 0.33, 1.2, 63.85, bb + 0.42, 1.29, 63.86, MAT.light(2, [0.2, 1, 0.3]), 0);
      wallQuad(b, cx, 5.25, 63.989, 0.6, 0.6, '-z', signM(name));
    }, 'dock');
  }

  // ---- exit signs (lit) above doors to the outside, inside face
  const exits = [[76.6, 0.011, '+z', 'notausgang_l'], [57.5, 0.011, '+x', 'notausgang_r'], [25, 63.989, '-z', 'notausgang_r']];
  // d_notausgang north wall (x 76..77.2), d_we_west west wall (z 57..58), d_we_sued south wall (x 24.5..25.5)
  for (const [u, w, f, nm] of exits) {
    const x = f === '+x' ? w : u, z = f === '+x' ? u : w;
    place(x + (f === '+x' ? 0.5 : 0), 2.5, z + (f === '+z' ? 0.5 : f === '-z' ? -0.5 : 0), (X) => {
      wallQuad(X.b, x, 2.45, z, 0.42, 0.42, f, signM(nm, 1.6));
    }, 'exit');
  }
  // escape route arrows in the hall
  for (const [x, z, f] of [[28.16, 20, '+x'], [28.16, 45, '+x'], [71.89, 20, '-x'], [71.89, 45, '-x'], [50, 0.011, '+z']]) {
    place(x + (f === '+x' ? 0.5 : f === '-x' ? -0.5 : 0), 2.5, z + (f === '+z' ? 0.5 : 0), (X) => wallQuad(X.b, x, 2.6, z, 0.4, 0.4, f, signM('sammel', 1.2)), 'exit');
  }

  // ---- fire extinguishers + safety signs on walls
  const ext = [[28.15, 14, '+x'], [28.15, 41, '+x'], [71.9, 33, '-x'], [40, 0, '+z'], [62, 0, '+z'], [27.85, 45, '-x'], [0, 46, '+x'],
    [0, 26, '+x'], [72.1, 25, '+x'], [84, 40, '+x'], [12.25, 44, '-x'], [27.85, 20, '-x']];
  for (const [x, z, f] of ext) {
    const o = OFF[f];
    place(x + o[0] * 0.5, 1, z + o[2] * 0.5, (X) => extinguisher(X.b, x + o[0] * 0.012, z + o[2] * 0.012, f), 'ext');
  }
  const safety = [['stapler', 28.16, 2.6, 58, '+x'], ['stapler', 27.84, 2.6, 58, '-x'], ['automatik', 84.07, 1.6, 44, '-x'], ['automatik', 72.11, 1.8, 30, '+x'],
    ['gehoerschutz', 72.11, 1.8, 31, '+x'], ['zutritt', 87.0, 2.4, 34.11, '+z'], ['spannung', 12.24, 2.0, 47.5, '-x'], ['rauchen', 0.012, 1.7, 52, '+x'],
    ['rauchen', 50, 1.8, 63.989, '-z'], ['erstehilfe', 71.89, 1.8, 58.5, '-x']];
  for (const [nm, x, y, z, f] of safety) {
    const o = OFF[f];
    place(x + o[0] * 0.5, Math.min(y, 1), z + o[2] * 0.5, (X) => wallQuad(X.b, x, y, z, 0.35, 0.35, f, signM(nm)), 'sign');
  }

  // ---- light fixture housings (the emissive greybox boxes stay: circuit-driven)
  L.fixtures.forEach((fx) => {
    const [x, y, z] = fx.pos;
    if (fx.type === 'highbay') {
      place(x, y - 1, z, (X) => {
        const b = X.b;
        b.cyl(x, y, z, 0.34, 0.22, 14, MAT.paint([0.75, 0.77, 0.78], 0.4), 1, 0.12);
        b.box(x - 0.08, y + 0.22, z - 0.06, x + 0.08, y + 0.34, z + 0.06, MAT.paint(C.dgrey, 0.2));
        b.box(x - 0.006, y + 0.34, z - 0.006, x + 0.006, y + 0.4, z + 0.006, MAT.steel(0.1));
      }, 'lamp');
    } else if (fx.type === 'tube') {
      place(x, y - 1, z, (X) => X.b.box(x - 0.78, y, z - 0.1, x + 0.78, y + 0.05, z + 0.1, MAT.paint([0.85, 0.85, 0.85], 0.4), FY), 'lamp');
    } else if (fx.type === 'bulb') {
      place(x, y - 1, z, (X) => { X.b.cyl(x, y + 0.13, z, 0.1, 0.06, 10, MAT.paint(C.dgrey, 0.2), 2, 0.06); X.b.box(x - 0.01, y + 0.19, z - 0.01, x + 0.01, -0.3, z + 0.01, MAT.paint(C.black, 0.1), NY); }, 'lamp');
    }
  });

  // ---- sprinkler mains (red) under the hall/automation roof + cable trays along the hall walls
  const red = MAT.paint(C.red, 0.4);
  for (let z = 5; z < 64; z += 6) {
    for (let x = 28.4; x < 95.6; x += 8) {
      const xa = x, xb = Math.min(95.6, x + 8);
      if (xa < 72.1 && xb > 71.9) continue;
      place((xa + xb) / 2, 11, z, (X) => {
        X.b.tube([xa, 11.35, z], [xb, 11.35, z], 0.04, 8, red);
        for (let h = xa + 1.5; h < xb; h += 3) X.b.cyl(h, 11.22, z, 0.012, 0.09, 5, MAT.steel(0.1), 2);
        X.b.box((xa + xb) / 2 - 0.01, 11.39, z - 0.01, (xa + xb) / 2 + 0.01, 12.0, z + 0.01, MAT.galv(0.2), NY);
      }, 'spr');
    }
  }
  for (const [x0, x1, z, f] of [[28.4, 71.6, 0.25, 1], [28.4, 71.6, 63.75, -1]]) {
    for (let x = x0; x < x1; x += 6) {
      const xa = x, xb = Math.min(x1, x + 6);
      place((xa + xb) / 2, 6, z, (X) => {
        const b = X.b, g = MAT.galv(0.5);
        b.box(xa, 6.0, z - 0.15, xb, 6.02, z + 0.15, g);
        b.box(xa, 6.02, z - 0.15, xb, 6.1, z - 0.14, g); b.box(xa, 6.02, z + 0.14, xb, 6.1, z + 0.15, g);
        for (let k = 0; k < 4; k++) b.tube([xa, 6.04, z - 0.1 + k * 0.06], [xb, 6.04, z - 0.1 + k * 0.06], 0.015, 5, MAT.paint(C.black, 0.2));
        for (let h = xa + 1; h < xb; h += 2) b.box(h - 0.02, 6.0, z - 0.15 * f - (f > 0 ? 0.1 : -0.0), h + 0.02, 6.4, z - 0.15 * f + (f > 0 ? 0 : 0.1), g, NY);
      }, 'tray');
    }
  }

  // ---- facade lettering over the yard + company sign at the gate
  place(40, 8.5, 64.5, (X) => {
    X.b.box(30, 8.6, 64.31, 50, 10.4, 64.45, MAT.paint([0.08, 0.17, 0.4], 0.6), NY);
    wallQuad(X.b, 40, 9.5, 64.452, 19, 1.4, '+z', m('facade'));
  }, 'facade');

  // ---- gang clutter (art only, flat or small): pizza boxes, cans, bottles, bags, clothes
  const R = rng(9001);
  const scatter = (zone, x0, z0, x1, z1, y, n) => {
    for (let i = 0; i < n; i++) {
      const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0), a = R() * 6.28, k = R();
      if (!free(x, y, z, 0.3)) continue;
      place(x, y + 0.3, z, (X) => {
        const b = X.b;
        b.push(M.mul(M.T(x, y, z), M.RY(a)));
        if (k < 0.3) b.box(-0.17, 0, -0.17, 0.17, 0.04, 0.17, MAT.kraft(), NY, { [FY]: m('trash', null, 0, { sub: cell(2, 2, 0) }) });
        else if (k < 0.55) b.with(M.mul(M.T(0, 0.033, 0), M.RZ(Math.PI / 2)), () => b.cyl(0, -0.06, 0, 0.033, 0.12, 7, m('trash', null, 0, { sub: [0, 0, 0.5, 0.5] }), 3, 0.033, MAT.steel(0.1)));
        else if (k < 0.7) b.bbox(-0.12, 0, -0.1, 0.12, 0.08, 0.1, 0.035, m('trash', null, 0, { sub: [0.5, 0.5, 1, 1] }), NY);
        else if (k < 0.85) b.bbox(-0.25, 0, -0.22, 0.25, 0.35, 0.22, 0.12, m('plastic', C.black, 0.3), NY);   // trash bag
        else b.bbox(-0.22, 0, -0.18, 0.22, 0.08, 0.18, 0.04, MAT.fabric([0.2 + R() * 0.3, 0.2, 0.25]), NY);   // clothes
        b.pop();
      }, zone);
    }
  };
  scatter('schlafen', 0.6, 12.6, 13.3, 23.3, 4.5, 26);
  scatter('sozial', 10.6, 1.0, 21.4, 11.4, 0, 12);
  scatter('packerei', 1.0, 24.5, 26, 35.4, 0, 14);
  scatter('labor', 0.5, 0.5, 9.4, 11.4, 0, 6);
  scatter('technik', 0.5, 46, 11.5, 51.5, -3.7, 5);
  void B; void NX; void FX; void NZ; void FZ;
}
