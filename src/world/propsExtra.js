// Prop builders and set dressing for the expanded site (foundry, basement, warehouse, rail siding, gatehouse,
// upper storey). Same kit and rules as props.js: procedural parts go into the shared batches, small repeated
// items are model placements / instances. Z-fighting rule: parts never share a face plane where they overlap.
import * as THREE from 'three';
import { TILE } from './propKit.js';
import { RAMPS, H } from './layout.js';

const PI = Math.PI;
const ONE = new THREE.Vector3(1, 1, 1);
const M = (x, y, z, ry = 0, rx = 0, rz = 0, s = ONE) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), s);

export function extraBuilders(c) {
  const { K, B, R, rr, cb, box, lbl, model, hose, carton, palletAt, boxLoad, corrugated, cargoDoors, gauge, estop, handwheel, inst } = c;

  return {
    // ------------------------------------------------------------ steel stair stringers (side plates) + nosings
    stringer(p) {
      const r = RAMPS.find((q) => q.name === p.ramp);
      if (!r) return;
      const run = r.a1 - r.a0, rise = r.y1 - r.y0, L = Math.hypot(run, rise);
      const am = (r.a0 + r.a1) / 2, ym = (r.y0 + r.y1) / 2;
      for (const cc of [r.c0 + 0.03, r.c1 - 0.03]) {
        const m = r.axis === 'x' ? M(am, ym - 0.06, cc, 0, 0, Math.atan2(rise, run)) : M(cc, ym - 0.06, am, 0, -Math.atan2(rise, run), 0);
        const lb = r.axis === 'x' ? [-L / 2, -0.13, -0.007] : [-0.007, -0.13, -L / 2];
        const ub = r.axis === 'x' ? [L / 2, 0.08, 0.007] : [0.007, 0.08, L / 2];
        cb(lb, ub, 'yellow', { matrix: m, r: 0.003, tint: 0.75 });
      }
      // step nosings (yellow anti-slip edge) on every tread
      const n = Math.max(4, Math.round(Math.abs(rise) / 0.175));
      for (let i = 0; i < n; i++) {
        const s0 = r.a0 + run * i / n, s1 = r.a0 + run * (i + 1) / n;
        const top = r.y0 + rise * (i + 0.5) / n;
        const edge = rise * run > 0 ? Math.min(s0, s1) : Math.max(s0, s1);   // the leading edge faces downhill
        const e0 = edge - 0.02, e1 = edge + 0.02;
        if (r.axis === 'x') box([Math.min(e0, e1), top + 0.002, r.c0 + 0.08], [Math.max(e0, e1), top + 0.008, r.c1 - 0.08], 'yellow', { tint: 0.7 });
        else box([r.c0 + 0.08, top + 0.002, Math.min(e0, e1)], [r.c1 - 0.08, top + 0.008, Math.max(e0, e1)], 'yellow', { tint: 0.7 });
      }
    },

    // ------------------------------------------------------------ canteen counter along the east wall (front faces -x)
    counter(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, fx = x0;
      cb([x0 + 0.02, 0, z0], [x1, 0.08, z1], 'dark', { r: 0.005 });
      const n = Math.max(2, Math.round((z1 - z0) / 0.6)), w = (z1 - z0) / n;
      for (let i = 0; i < n; i++) {
        const a = z0 + i * w;
        cb([x0 + 0.03, 0.08, a + 0.005], [x1, y1 - 0.04, a + w - 0.005], 'paintGrey', { r: 0.01, tint: rr(0.8, 1.0) });
        cb([fx - 0.012, 0.12, a + 0.03], [fx + 0.035, y1 - 0.09, a + w - 0.03], 'paintGrey', { r: 0.006, tint: rr(0.75, 0.95) });
        K.pipe('steel', [fx - 0.03, y1 - 0.18, a + 0.15], [fx - 0.03, y1 - 0.18, a + w - 0.15], 0.007, { segs: 5 });
      }
      cb([x0 - 0.02, y1 - 0.04, z0], [x1, y1, z1], 'steel', { r: 0.006, tint: 0.9 });          // worktop
      cb([x0 + 0.12, y1 - 0.06, z0 + 1.0], [x1 - 0.08, y1 - 0.012, z0 + 1.6], 'dark', { r: 0.01 });   // sink (recessed)
      K.pipe('steel', [x1 - 0.12, y1, z0 + 1.3], [x1 - 0.12, y1 + 0.3, z0 + 1.3], 0.012, { segs: 8 });
      K.pipe('steel', [x1 - 0.12, y1 + 0.3, z0 + 1.3], [x1 - 0.32, y1 + 0.28, z0 + 1.3], 0.01, { segs: 8 });
      cb([x0 + 0.08, y1, z0 + 2.4], [x1 - 0.05, y1 + 0.3, z0 + 2.95], 'paintGrey', { r: 0.02, tint: 1.15 });   // microwave
      cb([x0 + 0.064, y1 + 0.06, z0 + 2.45], [x0 + 0.072, y1 + 0.24, z0 + 2.8], 'glassDark', { r: 0.002 });
      K.lathe('paintGrey', [[0.001, 0], [0.08, 0], [0.085, 0.16], [0.06, 0.2], [0.001, 0.2]], M((x0 + x1) / 2, y1, z0 + 3.6), { segs: 14, tint: 1.3 });   // kettle
      for (let i = 0; i < 5; i++) K.lathe('paintGrey', [[0.001, 0], [0.04, 0], [0.042, 0.095], [0.036, 0.095], [0.034, 0.008], [0.001, 0.008]], M(rr(x0 + 0.15, x1 - 0.15), y1, z0 + 3.9 + i * 0.12), { segs: 12, tint: rr(0.6, 1.4) });
      // wall cupboards
      for (let i = 0; i < n; i++) {
        const a = z0 + i * w;
        cb([x1 - 0.36, y1 + 0.6, a + 0.01], [x1 - 0.005, y1 + 1.3, a + w - 0.01], 'paintGrey', { r: 0.01, tint: rr(0.85, 1.05) });
      }
      lbl([fx - 0.015, 0.6, z0 + 0.5], [-1, 0, 0], 0.2, 0.28, TILE.notice, { k: 0.9, rot: 0.06 });
    },

    // ------------------------------------------------------------ centrifugal pump set on a skid (axis along x)
    pump(p) {
      const [x0, , z0] = p.min, [x1, , z1] = p.max, cz = (z0 + z1) / 2;
      cb([x0, 0, z0 + 0.1], [x1, 0.12, z1 - 0.1], 'steel', { r: 0.008, tint: 0.6 });
      const mm = M(x0 + 0.5, 0.48, cz, 0, 0, PI / 2);
      K.lathe('paintBlue', [[0.001, -0.35], [0.2, -0.35], [0.22, -0.3], [0.22, 0.3], [0.2, 0.35], [0.001, 0.35]], mm, { segs: 18, tint: 0.85 });
      for (let k = -0.25; k < 0.26; k += 0.07) K.lathe('paintBlue', [[0.21, k], [0.245, k + 0.01], [0.245, k + 0.025], [0.21, k + 0.035]], mm, { segs: 18, tint: 0.75 });
      cb([x0 + 0.2, 0.12, cz - 0.18], [x0 + 0.8, 0.27, cz + 0.18], 'paintBlue', { r: 0.01, tint: 0.7 });
      K.lathe('paintRed', [[0.001, -0.12], [0.32, -0.12], [0.34, -0.08], [0.34, 0.08], [0.32, 0.12], [0.001, 0.12]], M(x1 - 0.45, 0.5, cz, 0, 0, PI / 2), { segs: 20, tint: 0.8 });
      K.pipe('steel', [x0 + 0.86, 0.48, cz], [x1 - 0.57, 0.5, cz], 0.04, { segs: 10, tint: 0.6 });
      K.pipe('rust', [x1 - 0.45, 0.85, cz], [x1 - 0.45, 3.5, cz], 0.09, { segs: 12 });
      K.pipe('rust', [x1 - 0.2, 0.5, cz], [x1 + 0.6, 0.5, cz], 0.1, { segs: 12 });
      handwheel([x1 - 0.45, 1.6, cz + 0.12], [0, 0, 1], 0.12);
      gauge([x1 - 0.45, 1.25, cz + 0.1], [0, 0, 1], 0.05);
      lbl([x0 + 0.5, 0.5, cz + 0.23], [0, 0, 1], 0.25, 0.25, TILE.maker, { k: 0.8 });
      lbl([x0 + 0.5, 0.55, cz - 0.24], [0, 0, -1], 0.2, 0.2, TILE.warnVolt, { k: 0.9 });
    },

    // ------------------------------------------------------------ horizontal fire-tube boiler (axis along x)
    boiler(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2, r = (z1 - z0) / 2 - 0.08, yc = y1 - r - 0.05;
      for (const x of [x0 + 0.7, x1 - 0.7]) {
        cb([x - 0.2, 0, cz - r * 0.8], [x + 0.2, yc - r * 0.55, cz + r * 0.8], 'ceiling', { r: 0.02, tint: 0.8 });   // saddles
        K.hull('steel', yc - r * 0.62, [x - 0.18, cz - r * 0.75, x + 0.18, cz + r * 0.75], yc - r * 0.3, [x - 0.12, cz - r * 0.9, x + 0.12, cz + r * 0.9], { tint: 0.6 });
      }
      const mAx = (x) => M(x, yc, cz, 0, 0, PI / 2);
      K.lathe('paintRed', [[r, -(x1 - x0) / 2 + 0.25], [r, (x1 - x0) / 2 - 0.25]], M((x0 + x1) / 2, yc, cz, 0, 0, PI / 2), { segs: 28, tint: 0.55 });
      for (let x = x0 + 0.6; x < x1 - 0.5; x += 0.9) K.lathe('steel', [[r + 0.008, -0.03], [r + 0.02, -0.02], [r + 0.02, 0.02], [r + 0.008, 0.03]], mAx(x), { segs: 28, tint: 0.5 });
      // dished heads, burner front with door and gauges
      K.lathe('paintRed', [[0.001, 0], [r * 0.5, 0.02], [r * 0.85, 0.08], [r, 0.25]].map(([a, b]) => [a, -b]), mAx(x0 + 0.25 + 0.25), { segs: 28, tint: 0.5 });
      K.lathe('steel', [[0.001, 0], [r * 1.02, 0], [r * 1.02, 0.12], [0.001, 0.12]], mAx(x1 - 0.25), { segs: 28, tint: 0.55 });
      cb([x1 - 0.15, yc - 0.45, cz - 0.42], [x1 + 0.02, yc + 0.35, cz + 0.42], 'dark', { r: 0.03 });
      K.lathe('paintGrey', [[0.001, 0], [0.22, 0], [0.24, 0.05], [0.22, 0.35], [0.001, 0.35]], M(x1 + 0.02, yc - 0.05, cz, 0, 0, -PI / 2), { segs: 16, tint: 0.85 });
      cb([x1 + 0.3, yc - 0.3, cz - 0.2], [x1 + 0.62, yc + 0.25, cz + 0.2], 'paintGrey', { r: 0.02 });
      gauge([x1 + 0.62, yc + 0.08, cz - 0.08], [1, 0, 0], 0.05); gauge([x1 + 0.62, yc + 0.08, cz + 0.08], [1, 0, 0], 0.05);
      estop([x1 + 0.62, yc - 0.15, cz], [1, 0, 0]);
      // flue + steam outlet up to the ceiling, safety valves
      K.pipe('rust', [x0 + 0.6, yc + r - 0.05, cz], [x0 + 0.6, 3.6, cz], 0.28, { segs: 16 });
      K.pipe('steel', [x0 + 0.6, yc + r + 0.25, cz], [x0 + 0.6, yc + r + 0.32, cz], 0.33, { segs: 16, tint: 0.6 });
      K.pipe('steel', [(x0 + x1) / 2, yc + r - 0.05, cz], [(x0 + x1) / 2, yc + r + 0.35, cz], 0.07, { segs: 10 });
      K.pipe('rust', [(x0 + x1) / 2, yc + r + 0.35, cz], [(x0 + x1) / 2, yc + r + 0.35, z1 + 0.4], 0.07, { segs: 10 });
      handwheel([(x0 + x1) / 2, yc + r + 0.45, cz + 0.3], [0, 1, 0], 0.14);
      K.pipe('steel', [x0 + 1.6, yc + r - 0.05, cz + 0.4], [x0 + 1.6, yc + r + 0.25, cz + 0.4], 0.05, { segs: 8, tint: 0.7 });
      // sight glass, plate, rust streaks
      K.pipe('glassDark', [x1 - 0.5, yc - 0.3, cz + r + 0.12], [x1 - 0.5, yc + 0.3, cz + r + 0.12], 0.02, { segs: 8 });
      lbl([(x0 + x1) / 2, yc + 0.1, cz + r + 0.012], [0, 0, 1], 0.5, 0.5, TILE.plate, { k: 0.85 });
      lbl([(x0 + x1) / 2 - 1, yc - 0.2, cz + r + 0.012], [0, 0, 1], 0.4, 1.0, TILE.rust, { k: 0.8 });
      lbl([x1 - 0.06, yc + 0.2, cz + 0.43], [0, 0, 1], 0.2, 0.2, TILE.warnVolt, { k: 0.9 });
    },

    // ------------------------------------------------------------ cupola furnace on legs with charging door and spout
    furnace(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.min(x1 - x0, z1 - z0) / 2 - 0.4;
      const yb = 1.5, yt = y1 - 1.0;
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const x = cx + dx * r * 0.75, z = cz + dz * r * 0.75;
        cb([x - 0.14, 0, z - 0.14], [x + 0.14, yb + 0.2, z + 0.14], 'steel', { r: 0.015, tint: 0.6 });
        cb([x - 0.25, 0, z - 0.25], [x + 0.25, 0.03, z + 0.25], 'steel', { r: 0.005, tint: 0.5 });
      }
      cb([cx - r - 0.05, yb - 0.1, cz - r - 0.05], [cx + r + 0.05, yb + 0.12, cz + r + 0.05], 'rust', { r: 0.02, tint: 0.7 });   // bottom plate
      B.cylinder('rust', [cx, yb, cz], r, yt - yb, { segs: 32, rows: 8, caps: false, tint: 0.8 });
      for (let y = yb + 0.8; y < yt; y += 1.4) B.cylinder('steel', [cx, y, cz], r + 0.04, 0.12, { segs: 32, caps: false, tint: 0.55 });
      K.lathe('rust', [[r, 0], [r * 0.9, 0.35], [r * 0.6, 0.6], [0.001, 0.62]], M(cx, yt, cz), { segs: 32, tint: 0.7 });
      B.cylinder('rust', [cx, yt + 0.4, cz], 0.55, 11.6 - yt - 0.4, { segs: 18, caps: false, tint: 0.65 });   // stack through the roof
      // tuyere ring (wind box) with feed pipes
      const ty = yb + 1.0;
      K.lathe('steel', [[r + 0.02, -0.18], [r + 0.3, -0.18], [r + 0.3, 0.18], [r + 0.02, 0.18]], M(cx, ty, cz), { segs: 32, tint: 0.6 });
      for (let i = 0; i < 8; i++) { const a = i / 8 * PI * 2; K.pipe('steel', [cx + Math.cos(a) * (r + 0.28), ty + 0.15, cz + Math.sin(a) * (r + 0.28)], [cx + Math.cos(a) * (r + 0.1), ty - 0.35, cz + Math.sin(a) * (r + 0.1)], 0.04, { segs: 6, tint: 0.5 }); }
      K.pipe('rust', [cx + r + 0.3, ty, cz], [x1 + 0.8, ty, cz], 0.22, { segs: 14 });
      // tapping spout + trough toward +z, charging door high up
      cb([cx - 0.18, yb + 0.15, cz + r - 0.1], [cx + 0.18, yb + 0.45, cz + r + 0.9], 'rust', { r: 0.03, tint: 0.6 });
      cb([cx - 0.1, yb + 0.4, cz + r + 0.1], [cx + 0.1, yb + 0.47, cz + r + 0.85], 'dark', { r: 0.01 });
      cb([cx - 0.6, yt - 1.6, cz + r - 0.05], [cx + 0.6, yt - 0.6, cz + r + 0.06], 'dark', { r: 0.02 });
      for (const s of [-1, 1]) cb([cx + s * 0.62 - 0.05, yt - 1.7, cz + r], [cx + s * 0.62 + 0.05, yt - 0.5, cz + r + 0.1], 'steel', { r: 0.008, tint: 0.5 });
      lbl([cx, yb + 2.4, cz + r + 0.015], [0, 0, 1], 0.6, 0.6, TILE.warnCrush, { k: 0.9 });
      lbl([cx + 0.9, yb + 3.0, cz + r * 0.92], [0.4, 0, 0.92], 0.5, 1.2, TILE.rust, { k: 0.75 });
      for (let i = 0; i < 18; i++) inst.debris.push([cx + rr(-1.2, 1.2), cz + r + rr(0.6, 2.2), rr(0.03, 0.09), R()]);   // spilled slag
    },

    // ------------------------------------------------------------ ladle on a transfer cart
    ladle(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      cb([x0, 0.28, z0 + 0.1], [x1, 0.42, z1 - 0.1], 'steel', { r: 0.012, tint: 0.6 });
      for (const zz of [z0 + 0.25, z1 - 0.25]) for (const s of [-1, 1]) K.wheel([s < 0 ? x0 + 0.1 : x1 - 0.1, 0.24, zz], 0.24, 0.12, 'x', s, { rimKey: 'steel', lugs: 6 });
      const r = Math.min(x1 - x0, z1 - z0) / 2 - 0.2;
      K.lathe('rust', [[0.001, 0.45], [r * 0.82, 0.45], [r, 0.65], [r * 1.05, y1 - 0.12], [r * 1.12, y1], [r * 1.0, y1], [r * 0.92, y1 - 0.1], [r * 0.7, 0.62], [0.001, 0.62]], M(cx, 0, cz), { segs: 24, tint: 0.7 });
      cb([cx - 0.12, y1 - 0.18, cz + r * 1.05], [cx + 0.12, y1 - 0.05, cz + r * 1.4], 'rust', { r: 0.02, tint: 0.6 });   // lip
      for (const s of [-1, 1]) K.pipe('steel', [cx + s * r * 1.05, y1 - 0.5, cz], [cx + s * (r * 1.05 + 0.18), y1 - 0.5, cz], 0.08, { segs: 12, tint: 0.5 });
      K.geo('steel', new THREE.TorusGeometry(r * 1.25, 0.04, 6, 24, PI), M(cx, y1 - 0.5, cz, 0, 0, 0), { tint: 0.55 });
      lbl([cx, 1.0, cz + r * 1.03], [0, 0, 1], 0.4, 0.4, TILE.warnCrush, { k: 0.8 });
    },

    // ------------------------------------------------------------ welding booth with PVC curtains and a bench
    weldbooth(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      for (const [x, z] of [[x0, z0], [x1 - 0.05, z0], [x0, z1 - 0.05], [x1 - 0.05, z1 - 0.05]]) cb([x, 0, z], [x + 0.05, y1, z + 0.05], 'steel', { r: 0.005, tint: 0.6 });
      K.pipe('steel', [x0, y1 - 0.03, z0 + 0.025], [x1, y1 - 0.03, z0 + 0.025], 0.02, { segs: 6 });
      K.pipe('steel', [x0 + 0.025, y1 - 0.03, z0], [x0 + 0.025, y1 - 0.03, z1], 0.02, { segs: 6 });
      K.pipe('steel', [x1 - 0.025, y1 - 0.03, z0], [x1 - 0.025, y1 - 0.03, z1], 0.02, { segs: 6 });
      const curtain = (a, b, axis, t) => {
        for (let s = a; s < b - 0.05; s += 0.3) {
          const g = new THREE.PlaneGeometry(0.28, y1 - 0.25, 1, 4);
          const pa = g.attributes.position;
          for (let k = 0; k < pa.count; k++) pa.setZ(k, Math.sin(pa.getY(k) * 3 + s * 7) * 0.02);
          g.computeVertexNormals();
          const m = axis === 'x' ? M(s + 0.15, (y1 - 0.25) / 2 + 0.12, t, rr(-0.05, 0.05)) : M(t, (y1 - 0.25) / 2 + 0.12, s + 0.15, PI / 2 + rr(-0.05, 0.05));
          K.geo('paper', g, m, { color: [0.45, 0.12, 0.08] });
        }
      };
      curtain(x0 + 0.05, x1 - 0.05, 'x', z0 + 0.03); curtain(z0 + 0.05, z1 - 0.8, 'z', x0 + 0.03); curtain(z0 + 0.05, z1 - 0.05, 'z', x1 - 0.03);
      cb([x0 + 0.3, 0.8, z0 + 0.3], [x1 - 0.3, 0.86, z0 + 1.1], 'steel', { r: 0.006, tint: 0.5 });
      for (const [a, b] of [[x0 + 0.35, z0 + 0.35], [x1 - 0.4, z0 + 0.35], [x0 + 0.35, z0 + 1.0], [x1 - 0.4, z0 + 1.0]]) cb([a, 0, b], [a + 0.05, 0.8, b + 0.05], 'steel', { r: 0.004 });
      cb([x0 + 0.6, 0.86, z0 + 0.5], [x0 + 1.2, 0.98, z0 + 0.8], 'rust', { r: 0.01 });
      model('propane_tank', x1 - 0.35, 0, z1 - 0.35, { s: 1.0 });
      cb([x0 + 0.2, 0, z1 - 0.5], [x0 + 0.85, 0.75, z1 - 0.12], 'paintRed', { r: 0.02, tint: 0.8 });
      hose([[x1 - 0.35, 0.55, z1 - 0.35], [x1 - 0.6, 0.02, z1 - 0.6], [x0 + 0.9, 0.02, z0 + 1.4], [x0 + 0.9, 0.86, z0 + 0.65]], 0.01, 'paintRed');
      lbl([x0 + 1.0, 1.7, z0 + 0.02], [0, 0, -1], 0.35, 0.35, TILE.warnVolt, { k: 0.9 });
    },

    // ------------------------------------------------------------ oil drum used as a fire barrel
    firebarrel(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
      model('Barrel_01', cx, 0, cz, { variant: 'oxide_grey', tint: 0.45, s: 1.0 });
      for (let i = 0; i < 5; i++) {
        const a = R() * PI * 2;
        cb([-0.02, 0, -0.025], [0.02, 0.5, 0.025], 'woodDark', { matrix: M(cx + Math.cos(a) * 0.1, 0.62, cz + Math.sin(a) * 0.1, a, rr(-0.4, 0.4), rr(-0.4, 0.4)), r: 0.004, tint: 0.25 });
      }
      for (let i = 0; i < 10; i++) inst.debris.push([cx + rr(-0.7, 0.7), cz + rr(-0.7, 0.7), rr(0.02, 0.05), R()]);
      cb([-0.3, 0, -0.06], [0.3, 0.02, 0.06], 'wood', { matrix: M(cx + 0.55, 0, cz + 0.2, 0.8), r: 0.003, tint: 0.5 });
    },

    // ------------------------------------------------------------ gate barrier arm (raised)
    barrierarm(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      cb([x0, 0, z0], [x1, y1, z1], 'paintGrey', { r: 0.02, tint: 1.1 });
      lbl([cx, 0.6, z1 + 0.001], [0, 0, 1], 0.3, 0.3, TILE.number, { u0: 0.25, u1: 0.5 });
      const L = p.len ?? 4, a = 1.15;
      const m = M(cx, y1 - 0.08, cz, 0, 0, a);
      cb([0, -0.05, -0.04], [L, 0.05, 0.04], 'paintGrey', { matrix: m, r: 0.01, tint: 1.4 });
      for (let i = 0; i < 6; i++) cb([0.2 + i * 0.62, -0.052, -0.042], [0.5 + i * 0.62, 0.052, 0.042], 'paintRed', { matrix: m, r: 0.008, tint: 1.2 });
    },

    // ------------------------------------------------------------ freight boxcar on two bogies (long axis x)
    wagon(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2, tint = p.tint ?? 1.0;
      const yf = 1.05, key = tint < 0.9 ? 'paintRed' : 'rust';
      for (const xb of [x0 + 2.2, x1 - 2.2]) {
        cb([xb - 1.2, 0.35, cz - 0.95], [xb + 1.2, 0.7, cz + 0.95], 'dark', { r: 0.02 });
        for (const dx of [-0.85, 0.85]) for (const s of [-1, 1]) K.wheel([xb + dx, 0.45, cz + s * 0.72], 0.45, 0.13, 'z', s, { rimKey: 'dark', lugs: 0, rimRatio: 0.85 });
        for (const s of [-1, 1]) cb([xb - 0.25, 0.25, cz + s * 0.9 - 0.06], [xb + 0.25, 0.65, cz + s * 0.9 + 0.06], 'dark', { r: 0.02, tint: 1.3 });
      }
      cb([x0 + 0.2, 0.75, z0 + 0.15], [x1 - 0.2, yf, z1 - 0.15], 'dark', { r: 0.02 });   // underframe
      for (const [xe, s] of [[x0, -1], [x1, 1]]) {
        cb([s < 0 ? xe : xe - 0.25, 0.8, cz - 0.25], [s < 0 ? xe + 0.25 : xe, 1.0, cz + 0.25], 'dark', { r: 0.01, tint: 1.2 });
        for (const dz of [-0.8, 0.8]) K.lathe('steel', [[0.001, 0], [0.18, 0], [0.18, 0.04], [0.06, 0.06], [0.06, 0.4], [0.001, 0.4]], M(xe + (s < 0 ? 0.2 : -0.2), 0.9, cz + dz, 0, 0, s < 0 ? PI / 2 : -PI / 2), { segs: 14, tint: 0.6 });
      }
      // body: corrugated side walls with ribs, roof, ends
      corrugated(key, 'x', z0 + 0.06, -1, x0 + 0.25, x1 - 0.25, yf, y1 - 0.15, { tint: tint * 0.85, pitch: 0.4 });
      corrugated(key, 'x', z1 - 0.06, 1, x0 + 0.25, x1 - 0.25, yf, y1 - 0.15, { tint: tint * 0.85, pitch: 0.4 });
      box([x0 + 0.3, yf + 0.02, z0 + 0.12], [x1 - 0.3, y1 - 0.2, z1 - 0.12], 'dark', { seg: 3 });
      for (const [xa, xb] of [[x0 + 0.2, x0 + 0.3], [x1 - 0.3, x1 - 0.2]]) cb([xa, yf, z0 + 0.05], [xb, y1 - 0.1, z1 - 0.05], key, { r: 0.01, tint: tint * 0.8 });
      K.hull(key, y1 - 0.16, [x0 + 0.2, z0 + 0.04, x1 - 0.2, z1 - 0.04], y1, [x0 + 0.25, cz - 0.6, x1 - 0.25, cz + 0.6], { tint: tint * 0.7 });
      for (let x = x0 + 1.2; x < x1 - 0.9; x += 1.4) for (const s of [-1, 1]) {
        const zz = s < 0 ? z0 + 0.04 : z1 - 0.04;
        cb([x - 0.04, yf + 0.05, s < 0 ? zz - 0.03 : zz - 0.01], [x + 0.04, y1 - 0.18, s < 0 ? zz + 0.01 : zz + 0.03], key, { r: 0.008, tint: tint * 0.75 });
      }
      // sliding door: on the open side pushed aside, revealing the dark interior
      const dw = 2.2, xm = (x0 + x1) / 2, side = p.open ?? 1, zd = side > 0 ? z1 + 0.02 : z0 - 0.02;
      const off = side ? 1.9 : 0;
      cb([xm - dw / 2 + off, yf + 0.05, side > 0 ? zd : zd - 0.06], [xm + dw / 2 + off, y1 - 0.25, side > 0 ? zd + 0.06 : zd], key, { r: 0.012, tint: tint * 0.9 });
      K.pipe('steel', [xm - 2.0, y1 - 0.22, zd + side * 0.05], [xm + 3.2, y1 - 0.22, zd + side * 0.05], 0.025, { segs: 8, tint: 0.6 });
      if (side) {
        box([xm - dw / 2 + 0.05, yf + 0.06, side > 0 ? z1 - 0.12 : z0 + 0.06], [xm + dw / 2 - 0.05, y1 - 0.3, side > 0 ? z1 - 0.06 : z0 + 0.12], 'dark', { tint: 0.4 });
        carton(xm - 0.4, yf + 0.02, cz + side * 0.6, 0.6, 0.5, 0.5, 0.2, 0.6);
        carton(xm + 0.5, yf + 0.02, cz + side * 0.3, 0.5, 0.4, 0.5, -0.4, 0.55);
      }
      lbl([x0 + 2.6, y1 - 0.9, z1 + 0.003], [0, 0, 1], 1.4, 0.7, TILE.stencil, { k: 0.85 });
      lbl([x1 - 2.6, y1 - 0.9, z0 - 0.003], [0, 0, -1], 1.4, 0.7, TILE.stencil, { k: 0.85 });
      lbl([x0 + 1.2, 1.4, z1 + 0.003], [0, 0, 1], 0.4, 0.4, TILE.plate, { k: 0.7 });
      for (let x = x0 + 0.8; x < x1 - 0.5; x += rr(0.8, 1.8)) lbl([x, y1 - 0.8, z1 + 0.004], [0, 0, 1], rr(0.3, 0.6), 1.2, TILE.rust, { k: 0.8 });
      // ladder on one end
      for (const s of [-0.25, 0.25]) K.pipe('steel', [x1 + 0.03, yf, cz + s + 0.6], [x1 + 0.03, y1 - 0.1, cz + s + 0.6], 0.012, { segs: 5, tint: 0.6 });
      for (let y = yf + 0.3; y < y1 - 0.2; y += 0.35) K.pipe('steel', [x1 + 0.03, y, cz + 0.35], [x1 + 0.03, y, cz + 0.85], 0.01, { segs: 5, tint: 0.6 });
    },
    flatcar(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cz = (z0 + z1) / 2;
      for (const xb of [x0 + 1.6, x1 - 1.6]) {
        cb([xb - 1.0, 0.35, cz - 0.9], [xb + 1.0, 0.68, cz + 0.9], 'dark', { r: 0.02 });
        for (const dx of [-0.7, 0.7]) for (const s of [-1, 1]) K.wheel([xb + dx, 0.42, cz + s * 0.72], 0.42, 0.13, 'z', s, { rimKey: 'dark', lugs: 0, rimRatio: 0.85 });
      }
      cb([x0 + 0.1, 0.72, z0 + 0.1], [x1 - 0.1, y1 - 0.12, z1 - 0.1], 'dark', { r: 0.02 });
      const n = Math.round((x1 - x0) / 0.32);
      for (let i = 0; i < n; i++) {
        const a = x0 + i * (x1 - x0) / n;
        box([a + 0.006, y1 - 0.12, z0], [a + (x1 - x0) / n - 0.006, y1, z1], 'woodDark', { tint: rr(0.55, 0.9), seg: 2 });
      }
      for (let x = x0 + 0.6; x < x1; x += 1.4) for (const s of [-1, 1]) cb([x - 0.05, y1 - 0.25, s < 0 ? z0 - 0.04 : z1 - 0.02], [x + 0.05, y1 + 0.02, s < 0 ? z0 + 0.02 : z1 + 0.04], 'dark', { r: 0.006 });
      K.geo('rubber', new THREE.TorusGeometry(0.42, 0.13, 8, 18), M(x0 + 1.1, y1 + 0.55, cz, 0, 0, 0), { color: [1.2, 1.2, 1.2] });
      lbl([x0 + 1.0, 0.9, z1 + 0.003], [0, 0, 1], 0.4, 0.4, TILE.number, { u0: 0.75, u1: 1 });
    },

    // ------------------------------------------------------------ flood light pole over the extraction point
    floodlight(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2, h = p.max[1];
      B.cylinder('steel', [cx, 0, cz], 0.09, h - 0.2, { segs: 10, tint: 0.7 });
      cb([cx - 0.2, 0, cz - 0.2], [cx + 0.2, 0.06, cz + 0.2], 'steel', { r: 0.005, tint: 0.5 });
      cb([cx - 0.12, 1.1, cz + 0.09], [cx + 0.12, 1.5, cz + 0.22], 'paintGrey', { r: 0.01 });
      lbl([cx, 1.3, cz + 0.22], [0, 0, 1], 0.12, 0.12, TILE.warnVolt, { k: 1 });
      K.pipe('steel', [cx, h - 0.25, cz], [cx + 0.5, h - 0.1, cz + 0.4], 0.04, { segs: 8 });
      cb([-0.28, -0.12, -0.08], [0.28, 0.12, 0.08], 'dark', { matrix: M(cx + 0.55, h - 0.15, cz + 0.45, -2.4, -0.6), r: 0.02 });
      K.poly('glassDark', [[-0.24, -0.09, 0.081], [0.24, -0.09, 0.081], [0.24, 0.09, 0.081], [-0.24, 0.09, 0.081]].map((q) => new THREE.Vector3(...q).applyMatrix4(M(cx + 0.55, h - 0.15, cz + 0.45, -2.4, -0.6))), null, { color: [3, 2.6, 1.8] });
      hose([[cx + 0.1, 1.2, cz + 0.15], [cx + 0.3, 0.6, cz + 0.4], [cx + 0.6, 0.02, cz + 0.8], [cx + 1.6, 0.02, cz + 1.4]], 0.015);
    },

    // ------------------------------------------------------------ casting pit lining (visual)
    pit(p) {
      const [x0, y0, z0] = p.min, [x1, , z1] = p.max, d = -y0, t = 0.15;
      const wallMat = { tint: 0.7 };
      box([x0, y0, z0], [x0 + t, 0, z1], 'ceiling', { ...wallMat, skip: ['py'] });
      box([x1 - t, y0, z0], [x1, 0, z1], 'ceiling', { ...wallMat, skip: ['py'] });
      box([x0 + t, y0, z0], [x1 - t, 0, z0 + t], 'ceiling', { ...wallMat, skip: ['py'] });
      box([x0 + t, y0, z1 - t], [x1 - t, 0, z1], 'ceiling', { ...wallMat, skip: ['py'] });
      box([x0 + t, y0 - 0.1, z0 + t], [x1 - t, y0, z1 - t], 'floor', { tint: 0.5 });
      // steel edge angles and slag / sand in the bottom
      for (const [a, b] of [[[x0, -0.004, z0], [x1, 0.014, z0 + 0.06]], [[x0, -0.004, z1 - 0.06], [x1, 0.014, z1]], [[x0, -0.004, z0 + 0.06], [x0 + 0.06, 0.014, z1 - 0.06]], [[x1 - 0.06, -0.004, z0 + 0.06], [x1, 0.014, z1 - 0.06]]]) cb(a, b, 'yellow', { r: 0.003, tint: 0.6 });
      for (let i = 0; i < 26; i++) inst.debris.push([rr(x0 + 0.3, x1 - 0.3), rr(z0 + 0.3, z1 - 0.3), rr(0.04, 0.14), R(), y0]);
      cb([x0 + 0.6, y0, z0 + 0.6], [x0 + 1.8, y0 + 0.5, z0 + 1.4], 'rust', { r: 0.04, tint: 0.5 });       // cast block
      model('Barrel_01', x1 - 0.7, y0, z1 - 0.8, { rz: PI / 2 - 0.2, rx: 0.1, variant: 'oxide_grey', tint: 0.5 });
      lbl([(x0 + x1) / 2, -d / 2, z0 + t + 0.003], [0, 0, 1], 0.8, 0.8, TILE.rust, { k: 0.7 });
    },

    // ------------------------------------------------------------ overhead travelling crane (visual, above head height)
    crane(p) {
      const { x0, x1, z, y } = p, [za, zb] = p.zRails;
      for (const x of [x0 + 0.3, x1 - 0.3]) {
        box([x - 0.15, y - 0.75, za], [x + 0.15, y - 0.45, zb], 'steel', { tint: 0.55 });    // runway beams
        for (let zz = za + 2; zz < zb; zz += 4) cb([x - 0.12, y - 1.6, zz - 0.08], [x + 0.12, y - 0.75, zz + 0.08], 'steel', { r: 0.008, tint: 0.5 });
      }
      for (const s of [-0.6, 0.6]) {
        cb([x0 + 0.2, y - 0.45, z + s - 0.25], [x1 - 0.2, y + 0.55, z + s + 0.25], 'yellow', { r: 0.02, tint: 0.85 });
        K.stripes([x0 + 0.5, y + 0.05, z + s + (s > 0 ? 0.25 : -0.25)], [x0 + 3, y + 0.05, z + s + (s > 0 ? 0.25 : -0.25)], [0, 0, s > 0 ? 1 : -1], 0.3);
      }
      for (const x of [x0 + 0.32, x1 - 1.52]) cb([x, y - 0.55, z - 1.0], [x + 1.2, y + 0.1, z + 1.0], 'yellow', { r: 0.03, tint: 0.7 });   // end trucks
      const tx = x0 + (x1 - x0) * 0.42;
      cb([tx - 1.0, y + 0.55, z - 0.95], [tx + 1.0, y + 1.1, z + 0.95], 'yellow', { r: 0.03, tint: 0.8 });       // trolley
      K.pipe('dark', [tx - 0.6, y + 0.85, z], [tx + 0.6, y + 0.85, z], 0.28, { segs: 16 });                     // hoist drum
      const hookY = 4.6;
      for (const dz of [-0.12, 0.12]) K.pipe('steel', [tx, y + 0.55, z + dz], [tx, hookY + 0.45, z + dz], 0.012, { segs: 5, tint: 0.5 });
      cb([tx - 0.22, hookY + 0.1, z - 0.18], [tx + 0.22, hookY + 0.5, z + 0.18], 'yellow', { r: 0.03 });
      K.geo('steel', new THREE.TorusGeometry(0.16, 0.05, 8, 14, PI * 1.4), M(tx, hookY - 0.08, z, 0, 0, PI * 0.8), { tint: 0.5 });
      lbl([tx, y + 0.8, z + 0.96], [0, 0, 1], 0.6, 0.6, TILE.plate, { k: 0.9 });
      hose([[x1 - 0.6, y + 0.4, z], [x1 - 0.4, y - 1.5, z + 0.2], [x1 - 0.5, 2.0, z + 0.4]], 0.016);   // pendant cable
      cb([x1 - 0.62, 1.7, z + 0.32], [x1 - 0.42, 2.0, z + 0.48], 'yellow', { r: 0.02 });
    },

    // ------------------------------------------------------------ closed roller shutter / closed doors / gates
    shutterclosed(p) {
      const [a0, a1] = p.a, t = p.t, s = p.s, h = p.h;
      for (let y = 0.02; y < h; y += 0.1) box([a0 + 0.05, y, s > 0 ? t : t - 0.04], [a1 - 0.05, y + 0.09, s > 0 ? t + 0.04 : t], 'corrugated', { tint: 0.7 + 0.15 * Math.sin(y * 9) });
      B.pipe('rust', [a0, h + 0.3, t + s * 0.2], [a1, h + 0.3, t + s * 0.2], 0.3, { segs: 14 });
      box([a0 - 0.15, 0, s > 0 ? t : t - 0.1], [a0, h + 0.6, s > 0 ? t + 0.1 : t], 'steel');
      box([a1, 0, s > 0 ? t : t - 0.1], [a1 + 0.15, h + 0.6, s > 0 ? t + 0.1 : t], 'steel');
      K.stripes([a0 + 0.1, 0.35, t + s * 0.05], [a1 - 0.1, 0.35, t + s * 0.05], [0, 0, s], 0.25, { k: 0.8 });
      cb([a1 + 0.2, 1.2, s > 0 ? t : t - 0.12], [a1 + 0.45, 1.6, s > 0 ? t + 0.12 : t], 'paintGrey', { r: 0.01 });
      lbl([(a0 + a1) / 2, 1.6, t + s * 0.05], [0, 0, s], 0.6, 0.6, TILE.noSmoke, { k: 0.85 });
    },
    doorclosed(p) {
      const [a0, a1] = p.a, t = p.t, s = p.s;
      cb([a0, 0.01, s > 0 ? t : t - 0.05], [a1, 2.15, s > 0 ? t + 0.05 : t], 'rust', { r: 0.01, tint: 0.8 });
      for (const [a, b] of [[a0 - 0.06, a0], [a1, a1 + 0.06]]) box([a, 0, s > 0 ? t : t - 0.03], [b, 2.25, s > 0 ? t + 0.03 : t], 'paintGrey', { tint: 0.5 });
      box([a0, 2.15, s > 0 ? t : t - 0.03], [a1, 2.25, s > 0 ? t + 0.03 : t], 'paintGrey', { tint: 0.5 });
      K.pipe('steel', [a1 - 0.12, 1.0, t + s * 0.09], [a1 - 0.25, 1.0, t + s * 0.09], 0.012, { segs: 6 });
      K.pipe('dark', [a0 + 0.1, 1.05, t + s * 0.07], [a1 - 0.1, 1.05, t + s * 0.07], 0.012, { segs: 6 });   // chain across
      cb([a1 - 0.5, 0.95, s > 0 ? t + 0.06 : t - 0.1], [a1 - 0.42, 1.05, s > 0 ? t + 0.1 : t - 0.06], 'steel', { r: 0.008, tint: 0.7 });   // padlock
      lbl([(a0 + a1) / 2, 1.55, t + s * 0.055], [0, 0, s], 0.3, 0.4, TILE.notice, { k: 0.9 });
    },
    gateleaf(p) {
      const [hx, hz] = p.hinge, L = p.len, m = M(hx, 0, hz, p.ry);
      cb([0, 0.05, -0.03], [L, 2.4, 0.03], 'corrugatedOut', { matrix: m, r: 0.004, tint: 0.85 });
      for (const y of [0.1, 1.2, 2.35]) cb([0, y, -0.05], [L, y + 0.06, 0.05], 'steel', { matrix: m, r: 0.006, tint: 0.6 });
      cb([-0.08, 0, -0.08], [0.08, 2.6, 0.08], 'steel', { matrix: M(hx, 0, hz), r: 0.01, tint: 0.6 });
    },
    gateclosed(p) {
      const [a0, a1] = p.a, t = p.t;
      for (let x = a0 + 0.1; x < a1; x += 0.14) box([x, 0.05, t - 0.012], [x + 0.025, 2.4, t + 0.012], 'steel', { tint: 0.55 });
      for (const y of [0.05, 1.2, 2.35]) box([a0, y, t - 0.035], [a1, y + 0.06, t + 0.035], 'steel', { tint: 0.6 });
      for (const x of [a0 - 0.1, a1]) box([x, 0, t - 0.06], [x + 0.1, 2.7, t + 0.06], 'steel', { tint: 0.5 });
      K.pipe('dark', [(a0 + a1) / 2 - 0.1, 1.1, t + 0.05], [(a0 + a1) / 2 + 0.1, 1.15, t + 0.05], 0.015, { segs: 6 });
      lbl([(a0 + a1) / 2, 1.6, t + 0.04], [0, 0, 1], 0.4, 0.5, TILE.notice, { k: 0.9 });
      lbl([(a0 + a1) / 2, 1.6, t - 0.04], [0, 0, -1], 0.4, 0.5, TILE.notice, { k: 0.9 });
    },

    // ------------------------------------------------------------ railway track along x (rails, sleepers, ballast, buffer stop)
    track(p) {
      const { x0, x1, z } = p, g = 0.7175;
      box([x0, 0.0, z - 1.6], [x1, 0.04, z + 1.6], 'ceiling', { tint: 0.45, seg: 4, skip: ['ny'] });
      for (let x = x0 + 0.3; x < x1 - 0.2; x += 0.65) {
        if (R() < 0.04) continue;
        box([x - 0.12 + rr(-0.02, 0.02), 0.04, z - 1.3], [x + 0.12, 0.17, z + 1.3], 'woodDark', { tint: rr(0.35, 0.6), seg: 3 });
      }
      for (const s of [-1, 1]) {
        box([x0, 0.17, z + s * g - 0.07], [x1, 0.19, z + s * g + 0.07], 'steel', { tint: 0.35, seg: 6 });
        box([x0, 0.19, z + s * g - 0.012], [x1, 0.3, z + s * g + 0.012], 'rust', { tint: 0.55, seg: 6 });
        box([x0, 0.3, z + s * g - 0.035], [x1, 0.34, z + s * g + 0.035], 'steel', { tint: 0.85, seg: 6 });
      }
      // buffer stop at the west end
      cb([x0 - 0.4, 0, z - 1.0], [x0 + 0.1, 1.1, z + 1.0], 'paintRed', { r: 0.03, tint: 0.6 });
      cb([x0 + 0.1, 0.75, z - 1.1], [x0 + 0.35, 1.05, z + 1.1], 'yellow', { r: 0.02, tint: 0.8 });
      K.stripes([x0 + 0.36, 0.9, z - 1.0], [x0 + 0.36, 0.9, z + 1.0], [1, 0, 0], 0.25, { up: [0, 1, 0] });
      for (let i = 0; i < 40; i++) inst.debris.push([rr(x0, x1), z + rr(-1.5, 1.5), rr(0.02, 0.06), R()]);
    },

    // ------------------------------------------------------------ covered walkway canopy (posts are layout solids)
    walkway(p) {
      const { x0, x1, z0, z1, y } = p;
      for (let z = z0; z < z1 - 0.01; z += 1.0) box([x0 - 0.15, y + 0.12, z], [x1 + 0.15, y + 0.15, Math.min(z1, z + 1.0) - 0.004], 'corrugatedOut', { tint: rr(0.7, 0.9), seg: 2 });
      for (const x of [x0 + 0.1, x1 - 0.1]) box([x - 0.07, y, z0], [x + 0.07, y + 0.12, z1], 'steel', { tint: 0.55 });
      for (let z = z0 + 0.4; z < z1; z += 1.9) box([x0, y - 0.1, z - 0.05], [x1, y, z + 0.05], 'steel', { tint: 0.5 });
      B.pipe('rust', [x1 + 0.12, y + 0.05, z0], [x1 + 0.12, y + 0.05, z1], 0.06);
      lbl([(x0 + x1) / 2, y - 0.15, z1 - 0.3], [0, -1, 0], 1.2, 0.3, TILE.exit, { k: 0.9, up: [0, 0, -1] });
    },

    // ------------------------------------------------------------ basement pipe runs and cable trays
    pipes() {
      const Y = H.base;
      // tunnel: two large pipes and a cable tray along the ceiling, brackets every 2.5 m
      B.pipe('rust', [21.95, -0.85, -17.4], [21.95, -0.85, 5.4], 0.16);
      B.pipe('paintGrey', [21.6, -0.65, -17.4], [21.6, -0.65, 5.4], 0.08);
      B.pipe('paint', [19.55, -0.9, -16.0], [19.55, -0.9, 5.4], 0.06);
      box([19.25, -0.7, -16.0], [19.75, -0.66, 5.4], 'steel', { tint: 0.5 });
      for (let z = -16.5; z < 5.4; z += 2.5) {
        cb([21.75, -0.62, z - 0.03], [22.38, -0.56, z + 0.03], 'steel', { r: 0.004, tint: 0.5 });
        K.pipe('steel', [21.95, -0.85, z], [21.95, -0.85, z + 0.05], 0.2, { segs: 14, tint: 0.5 });
      }
      for (let z = -15.0; z < 5; z += 3.3) {
        for (let i = 0; i < 3; i++) K.pipe('dark', [19.4 + i * 0.12, -0.66, z], [19.4 + i * 0.12, -0.66, z + 3.2], 0.015, { segs: 5 });
      }
      handwheel([21.95, -1.2, -8.0], [0, -1, 0], 0.14); handwheel([21.95, -1.2, 1.5], [0, -1, 0], 0.14);
      // boiler room: header pipe over the boilers, drops into the walls
      B.pipe('rust', [20.2, -0.9, 10.6], [35.2, -0.9, 10.6], 0.14);
      B.pipe('paintRed', [20.2, -0.7, 15.0], [35.2, -0.7, 15.0], 0.08);
      for (const x of [26.4, 30.2, 34.6]) {
        B.pipe('rust', [x, -0.9, 10.6], [x, -0.9, 14.85], 0.1);           // branches run to the south wall, then down
        B.pipe('rust', [x, -0.9, 14.85], [x, Y + 0.3, 14.85], 0.1);
      }
      for (const x of [26.4, 30.2]) { handwheel([x + 0.2, Y + 1.5, 14.85], [1, 0, 0], 0.13); gauge([x, Y + 1.9, 14.7], [0, 0, -1], 0.06); }
      // pump room: suction / discharge lines into the wall
      B.pipe('rust', [23.4, Y + 0.5, -5.4], [29.6, Y + 0.5, -5.4], 0.12);
      B.pipe('rust', [29.6, Y + 0.5, -5.4], [29.6, -0.8, -5.4], 0.12);
      B.pipe('paintBlue', [23.2, -0.8, -5.2], [29.8, -0.8, -5.2], 0.07);
      // B1 shaft: conduit down the wall
      B.pipe('dark', [12.8, -0.2, -17.45], [19.0, -3.8, -17.45], 0.03);
    },
  };
}

// ------------------------------------------------------------------ set dressing for the new areas
// Roof structure, wall pipes, clutter, debris and signage labels. Everything here is visual (no colliders) and kept
// low / against walls / out of doorways, like scatterClutter() in props.js.
export function dressAreas(c) {
  const { K, B, R, rr, cb, box, lbl, model, hose, carton, palletAt, inst, nearDoor, lift, catenary, floorCable } = c;
  const ok = (x, z) => !nearDoor(x, z, 1.25);

  // ---- foundry roof trusses, purlins, wall pipes, cables
  for (let z = -14.5; z < 15.6; z += 4.5) {
    box([20.0, 10.55, z - 0.1], [43.6, 10.95, z + 0.1], 'steel');
    for (let x = 22; x < 43.6; x += 3) {
      const m = new THREE.Matrix4().makeRotationZ(((Math.round(x) % 2) ? 1 : -1) * 0.5).setPosition(x, 10.0, z);
      B.boxXf([-0.04, 0, -0.04], [0.04, 0.9, 0.04], 'steel', m);
    }
    box([20.0, 9.95, z - 0.08], [43.6, 10.05, z + 0.08], 'steel');
  }
  for (let x = 21.5; x < 43.6; x += 3.5) box([x - 0.05, 10.95, -17.6], [x + 0.05, 11.0, 15.6], 'steel');
  B.pipe('rust', [43.3, 7.6, -17.3], [43.3, 7.6, 15.3], 0.18);
  B.pipe('paintGrey', [43.25, 7.1, -17.3], [43.25, 7.1, 15.3], 0.08);
  B.pipe('rust', [20.3, 8.2, -17.3], [43.3, 8.2, -17.3], 0.14);
  for (let z = -15; z < 15; z += 3) K.pipe('steel', [43.3, 7.6, z], [43.3, 7.6, z + 0.05], 0.23, { segs: 14, tint: 0.6 });
  for (let i = 0; i < 7; i++) {
    const x0 = rr(22, 42), z0 = rr(-16, 14), x1 = Math.max(20.5, Math.min(43.2, x0 + rr(-6, 6))), z1 = Math.max(-17, Math.min(15, z0 + rr(-5, 5)));
    catenary(B, [x0, 10.4, z0], [x1, 10.4, z1], rr(0.8, 2.6));
  }
  for (const [a, b] of [[[34.4, -12.6], [31.0, -9.8]], [[41.8, -10.4], [39.0, -6.8]], [[26.0, 12.0], [30.6, 13.6]]]) floorCable(B, a, b, R);
  // molds, flasks and castings along the molding line
  for (let x = 24.6; x < 35.6; x += 1.5) {
    if (R() < 0.3) continue;
    cb([x - 0.35, 0.95, 0.15], [x + 0.35, 1.25, 0.85], 'rust', { r: 0.02, tint: rr(0.4, 0.7) });
    if (R() < 0.5) cb([x - 0.3, 1.25, 0.2], [x + 0.3, 1.45, 0.8], 'rust', { r: 0.02, tint: rr(0.4, 0.6) });
  }
  for (const [x, z] of [[24.8, 2.4], [26.4, 2.6], [34.8, 2.4], [30.2, -0.8]]) cb([x - 0.4, 0, z - 0.3], [x + 0.4, 0.28, z + 0.3], 'rust', { r: 0.03, tint: rr(0.35, 0.6) });
  // sand heap by the north wall
  for (let i = 0; i < 70; i++) inst.debris.push([rr(26, 29.5), rr(-17.2, -15.6), rr(0.05, 0.16), R()]);
  for (const [x, z] of [[23.0, -16.9], [24.4, -12.9], [41.6, 14.8], [43.1, 2.0], [31.6, 3.4], [36.4, -5.4], [28.8, 14.9], [20.6, -15.0]]) {
    if (!ok(x, z)) continue;
    if (R() < 0.5) model('can_rusted', x, 0, z, { s: rr(1, 1.5) }); else model('plastic_jerrycan', x, 0, z, { ry: rr(0, 6) });
  }
  model('Barrel_02', 43.0, 0, 6.0, {}); model('Barrel_01', 43.1, 0, 6.7, { variant: 'oxide_green' }); model('old_tyre', 41.6, 0.0825, 12.4, { rx: PI / 2 });
  model('trashbag', 20.5, 0, 15.1, { s: 0.9 }); model('trashbag', 43.1, 0, -17.1, { s: 0.85 });
  // catwalk: toe boards and a few items on the deck (lifted to the deck height)
  lift(H.catwalk, () => {
    for (const [x, z] of [[20.3, -10.5], [20.4, 12.5], [42.8, 6.8], [41.0, -1.4]]) model('can_rusted', x, 0, z, { s: 1.3 });
    cb([20.1, 0, 6.7], [20.5, 0.45, 7.4], 'paintRed', { r: 0.02, tint: 0.8 });
    carton(20.5, 0, -15.6, 0.4, 0.3, 0.4, 0.3);
  });

  // ---- basement: water stains, debris, a crate stack, cables
  for (const [x, z, r] of [[20.8, -12, 1.4], [26, -2, 2.0], [28, 12, 1.6], [21.4, 2.0, 1.0]]) {
    for (let i = 0; i < r * 8; i++) { const a = R() * PI * 2, d = Math.sqrt(R()) * r; inst.debris.push([x + Math.cos(a) * d, z + Math.sin(a) * d, rr(0.03, 0.1), R(), H.base]); }
    for (let i = 0; i < r * 2; i++) inst.papers.push([x + rr(-r, r), H.base + 0.004 + R() * 0.004, z + rr(-r, r), R() * 6]);
  }
  lift(H.base, () => {
    for (const [x, z] of [[19.5, -14.0], [22.2, -7.0], [19.6, 4.6], [35.2, 9.4], [29.6, 6.4], [23.2, 0.2]]) { if (ok(x, z)) model('can_rusted', x, 0, z, { s: rr(1.1, 1.6), rx: R() < 0.5 ? PI / 2 : 0 }); }
    model('trashbag', 19.6, 0, -11.0, { s: 0.85 }); model('plastic_jerrycan', 34.9, 0, 12.4, { ry: 1.2 });
    carton(33.6, 0, 6.6, 0.5, 0.35, 0.4, 0.4); carton(19.9, 0, 0.8, 0.45, 0.3, 0.4, -0.3);
    palletAt(29.0, 0, 7.0, { broken: true, tint: 0.5 });
  });

  // ---- warehouse: roof trusses, sodium lamp cables, clutter along the walls, floor wear
  for (let z = -50; z < -34.4; z += 4.0) {
    box([0.4, 9.55, z - 0.1], [43.6, 9.95, z + 0.1], 'steel');
    for (let x = 2; x < 43.6; x += 3) {
      const m = new THREE.Matrix4().makeRotationZ(((Math.round(x) % 2) ? 1 : -1) * 0.5).setPosition(x, 9.0, z);
      B.boxXf([-0.04, 0, -0.04], [0.04, 0.9, 0.04], 'steel', m);
    }
    box([0.4, 8.95, z - 0.08], [43.6, 9.05, z + 0.08], 'steel');
  }
  for (let x = 1.5; x < 43.6; x += 3.5) box([x - 0.05, 9.95, -51.6], [x + 0.05, 10.0, -34.4], 'steel');
  B.pipe('rust', [0.7, 8.4, -51.3], [43.3, 8.4, -51.3], 0.14);
  B.pipe('paint', [0.7, 7.8, -51.25], [43.3, 7.8, -51.25], 0.07);
  for (let i = 0; i < 6; i++) { const x0 = rr(2, 42), z0 = rr(-50, -36); catenary(B, [x0, 9.4, z0], [Math.max(1, Math.min(43, x0 + rr(-6, 6))), 9.4, Math.max(-51, Math.min(-35, z0 + rr(-4, 4)))], rr(0.8, 2.0)); }
  for (const [x, z] of [[1.0, -51.0], [12.0, -51.2], [43.0, -36.0], [24.0, -34.9], [6.8, -34.9], [43.1, -44.0], [0.9, -43.0], [33.6, -51.2]]) {
    if (!ok(x, z)) continue;
    if (R() < 0.4) model('can_rusted', x, 0, z, { s: rr(1.1, 1.5) }); else if (R() < 0.7) model('trashbag', x, 0, z, { s: rr(0.8, 1) }); else model('plastic_jerrycan', x, 0, z, { ry: rr(0, 6) });
  }
  for (const [x, z, ry] of [[21.6, -38.4, 0.3], [14.6, -42.2, 1.1], [30.4, -46.6, 2.0], [6.2, -46.0, 0.6], [27.5, -42.0, 2.6]]) {
    cb([-0.35, 0, -0.25], [0.35, 0.012, 0.25], 'cardboard', { matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1)), r: 0.002, tint: rr(0.55, 0.85) });
  }
  for (const [x, z, ry] of [[19.4, -35.2, 0.4], [9.4, -38.8, 1.2], [36.2, -43.4, 2.1]]) carton(x, 0, z, 0.5, 0.35, 0.4, ry, 0.7);
  palletAt(13.2, 0, -50.8, { broken: true, tint: 0.6 }); palletAt(38.8, 0, -35.2, { tint: 0.7 });
  for (const [cx, cz, r] of [[22, -42, 2.0], [8, -37, 1.6], [36, -50, 1.4], [28, -36, 1.4]]) {
    for (let i = 0; i < r * 8; i++) { const a = R() * PI * 2, d = Math.sqrt(R()) * r; inst.debris.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d, rr(0.03, 0.1), R()]); }
    for (let i = 0; i < r * 2; i++) inst.papers.push([cx + rr(-r, r), 0.004 + R() * 0.004, cz + rr(-r, r), R() * 6]);
  }

  // ---- siding / rear lot / yard extension: scrap, tyres, weeds of debris, rubbish
  for (const [cx, cz, r] of [[-14, -22, 2.4], [20, -31, 2.0], [40, -26, 1.8], [-18, -40, 2.4], [-6, -47, 2.0], [24, 27, 2.4], [40, 19, 1.6]]) {
    for (let i = 0; i < r * 9; i++) { const a = R() * PI * 2, d = Math.sqrt(R()) * r; inst.debris.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d, rr(0.03, 0.12), R()]); }
    for (let i = 0; i < r * 2; i++) inst.papers.push([cx + rr(-r, r), 0.004 + R() * 0.004, cz + rr(-r, r), R() * 6]);
  }
  for (const [x, z, ry] of [[-22.0, -32.6, 1.0], [-23.0, -50.4, 0.5], [43.0, 29.2, 0.1]]) {
    model('old_tyre', x, 0.0825, z, { rx: PI / 2, ry });
    if (R() < 0.5) model('old_tyre', x + rr(-0.05, 0.05), 0.2475, z + rr(-0.05, 0.05), { rx: PI / 2, ry: ry + 0.5 });
  }
  for (const [x, z] of [[43.2, -18.6], [-1.2, -51.6], [30.6, 29.6]]) model('trashbag', x, 0, z, { s: rr(0.8, 1.0) });
  for (const [x, z] of [[-11.2, -19.0], [16.0, -19.2], [36.8, -19.0], [-15.6, -38.4], [-4.4, -36.2], [27.6, 21.6], [36.2, 21.6], [22.0, 29.4]]) model('can_rusted', x, 0, z, { s: rr(1.1, 1.6), rx: R() < 0.4 ? PI / 2 : 0 });
  for (const [x, z, ry] of [[-14.5, -35.0, 0.2], [10.0, -32.8, 1.5], [21.0, 29.0, 0.4]]) palletAt(x, 0, z, { broken: true, tint: 0.55, ...{ ry } });
  hose([[-21.4, 0.05, -47.2], [-19.8, 0.02, -46.6], [-18.8, 0.02, -45.2], [-17.6, 0.02, -45.0]], 0.02);   // floodlight cable

  // ---- signage labels at the entrances (atlas tiles); text signs are in decals.js
  const sign = (cpos, n, s, tile, o) => lbl(cpos, n, s, s, tile, { k: 0.9, ...o });
  sign([24.7, 2.6, -17.6], [0, 0, 1], 0.45, TILE.exit);
  sign([20.0, 2.6, -11.5], [1, 0, 0], 0.4, TILE.warnCrush);
  sign([43.6, 1.6, -6.0], [-1, 0, 0], 0.4, TILE.warnVolt);
  sign([36.0, 2.2, -13.0], [0, 0, 1], 0.32, TILE.fire, { k: 1 });
  sign([3.8, 2.7, -34.4], [0, 0, 1], 0.45, TILE.exit);
  sign([0.4, 2.6, -40.0], [1, 0, 0], 0.4, TILE.noSmoke);
  sign([19.2, -1.6, -2.0], [1, 0, 0], 0.4, TILE.warnVolt);
  sign([22.4, -1.5, -0.8], [-1, 0, 0], 0.35, TILE.notice, { rot: 0.1 });
  sign([30.0, -1.5, 9.0], [0, 0, 1], 0.4, TILE.fire);
  sign([10.6, 5.2, 4.0], [-1, 0, 0], 0.32, TILE.notice, { rot: -0.05 });
  sign([19.6, 5.2, 0.4], [-1, 0, 0], 0.4, TILE.exit);
}
