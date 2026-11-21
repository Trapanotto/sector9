// Conveyor / sorter frames, chutes, posts, railings, pipes and the crane floor rail (static art, workstream A).
// Also the shared conveyor path math used by the machines runtime (cartons travel along the same polyline).
import { M, FX, NX, FY, NY, FZ, NZ } from './kit.js';
import { MAT, C } from './models.js';

const m = (t, c = null, s = 0, x = {}) => ({ t, ...(c ? { c } : {}), s, ...x });
export const BELT_TILE_M = 0.5;   // metres of belt per texture repeat (machines scroll uBelt by -distance / this)

/** conveyor path: segments with 3D endpoints (belt top), cumulative distance. Turn points get corner squares. */
export function conveyorPath(c) {
  const pts = c.points, n = c.closed ? pts.length : pts.length - 1, hw = c.width / 2;
  const segs = [];
  let s = 0;
  const dir = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [dx / l, dz / l]; };
  for (let i = 0; i < n; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    const d = dir(A, B);
    const prev = c.closed || i > 0 ? pts[(i - 1 + pts.length) % pts.length] : null;
    const next = c.closed || i < n - 1 ? pts[(i + 2) % pts.length] : null;
    const turnA = prev ? (() => { const p = dir(prev, A); return Math.abs(p[0] * d[0] + p[1] * d[1]) < 0.5; })() : false;
    const turnB = next && (c.closed || i < n - 1) ? (() => { const q = dir(B, next); return Math.abs(q[0] * d[0] + q[1] * d[1]) < 0.5; })() : false;
    const lenH = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const a0 = turnA ? hw : 0, a1 = turnB ? lenH - hw : lenH;
    const hAt = (t) => A[2] + (B[2] - A[2]) * (t / lenH);
    const P0 = [A[0] + d[0] * a0, hAt(a0), A[1] + d[1] * a0], P1 = [A[0] + d[0] * a1, hAt(a1), A[1] + d[1] * a1];
    const len3 = Math.hypot(P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]);
    segs.push({ A, B, d, P0, P1, len3, lenH, turnA, turnB, s0: s });
    s += len3 + (turnB ? hw * 2 : 0);   // corner square: carton crosses it (approx. one width)
  }
  return { segs, total: s, hw };
}

/** world point at distance s along the path (belt top) → out [x, y, z, yaw] */
export function pathPoint(path, s, out) {
  s = ((s % path.total) + path.total) % path.total;
  const segs = path.segs;
  let k = 0;
  while (k < segs.length - 1 && s >= segs[k + 1].s0) k++;
  const g = segs[k];
  const u = s - g.s0;
  if (u <= g.len3) {
    const f = g.len3 > 0 ? u / g.len3 : 0;
    out[0] = g.P0[0] + (g.P1[0] - g.P0[0]) * f; out[1] = g.P0[1] + (g.P1[1] - g.P0[1]) * f; out[2] = g.P0[2] + (g.P1[2] - g.P0[2]) * f;
    out[3] = Math.atan2(g.d[0], g.d[1]);
  } else {
    // crossing the corner square towards the next segment's start
    const nx = segs[(k + 1) % segs.length], f = (u - g.len3) / (path.hw * 2);
    out[0] = g.P1[0] + (nx.P0[0] - g.P1[0]) * f; out[1] = g.P1[1] + (nx.P0[1] - g.P1[1]) * f; out[2] = g.P1[2] + (nx.P0[2] - g.P1[2]) * f;
    const y0 = Math.atan2(g.d[0], g.d[1]), y1 = Math.atan2(nx.d[0], nx.d[1]);
    let dy = y1 - y0; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    out[3] = y0 + dy * f;
  }
  return out;
}

/** transform for a segment-aligned local frame: origin P0, +z along the belt (sloped), +y belt normal */
function segFrame(g) {
  const yaw = Math.atan2(g.d[0], g.d[1]);
  const pitch = -Math.atan2(g.P1[1] - g.P0[1], Math.hypot(g.P1[0] - g.P0[0], g.P1[2] - g.P0[2]));
  return M.mul(M.mul(M.T(g.P0[0], g.P0[1], g.P0[2]), M.RY(yaw)), M.RX(pitch));
}

export function conveyorArt(L, place) {
  const frameM = MAT.paint(C.machine, 0.8), dark = MAT.paint(C.dgrey, 0.5), galv = MAT.galv(0.5);
  L.conveyors.forEach((c, ci) => {
    const path = conveyorPath(c), hw = path.hw, rollers = c.id === 'c_akl';
    for (const g of path.segs) {
      const F = segFrame(g);
      // piece every ~2 m so each lands in the right zone/chunk
      const nP = Math.max(1, Math.ceil(g.len3 / 2));
      for (let p = 0; p < nP; p++) {
        const za = g.len3 * p / nP, zb = g.len3 * (p + 1) / nP;
        const f = (za + zb) / 2 / g.len3;
        const wx = g.P0[0] + (g.P1[0] - g.P0[0]) * f, wy = g.P0[1] + (g.P1[1] - g.P0[1]) * f, wz = g.P0[2] + (g.P1[2] - g.P0[2]) * f;
        place(wx, Math.min(wy, 1), wz, (X) => {
          const b = X.b;
          b.push(F);
          // belt (scrolling) or rollers
          const beltW = hw - 0.06;
          if (!rollers) {
            b.quad([[-beltW, 0, za], [beltW, 0, za], [beltW, 0, zb], [-beltW, 0, zb]].reverse(), [[0, (g.s0 + za) / 0.5], [1, (g.s0 + za) / 0.5], [1, (g.s0 + zb) / 0.5], [0, (g.s0 + zb) / 0.5]].reverse(), m('belt', null, 0, { belt: ci }));
          } else {
            b.box(-beltW, -0.06, za, beltW, -0.05, zb, dark, NY);
            for (let z = za + 0.05; z < zb; z += 0.1) roller(b, -beltW, beltW, -0.03, z, 0.025, ci);
          }
          // side frame rails (C-profile, lip 4 cm above the belt) + underside frame
          for (const sx of [-1, 1]) {
            const x0 = sx < 0 ? -hw : hw - 0.06, x1 = x0 + 0.06;
            b.box(x0, -0.12, za, x1, 0.04, zb, frameM, 0, { [sx < 0 ? FX : NX]: frameM });
          }
          b.box(-hw + 0.06, -0.14, za, hw - 0.06, -0.06, zb, dark, FY);
          b.pop();
          // floor-standing parts: side cover panels + feet (proxy is solid down to the floor)
          if (!c.elevated) {
            const at = (t) => [g.P0[0] + (g.P1[0] - g.P0[0]) * t / g.len3, g.P0[1] + (g.P1[1] - g.P0[1]) * t / g.len3, g.P0[2] + (g.P1[2] - g.P0[2]) * t / g.len3];
            let A = at(za), B = at(zb);
            if (A[1] > 1.6 && B[1] > 1.6) { /* elevated: posts only */ } else {
              if (A[1] > 1.6) A = at(za + (zb - za) * (A[1] - 1.6) / (A[1] - B[1]));
              if (B[1] > 1.6) B = at(za + (zb - za) * (1.6 - A[1]) / (B[1] - A[1]));
              const nx = -g.d[1], nz = g.d[0];   // side normal (left)
              const pm = m('paint', C.machine, [0.8, 0.6]), ft = MAT.paint(C.dgrey, 0.3);
              const L2 = Math.hypot(B[0] - A[0], B[2] - A[2]);
              for (const sd of [-1, 1]) {
                const o = (hw - 0.02) * sd;
                const a0 = [A[0] + nx * o, 0.1, A[2] + nz * o], b0 = [B[0] + nx * o, 0.1, B[2] + nz * o];
                const a1 = [a0[0], A[1] - 0.12, a0[2]], b1 = [b0[0], B[1] - 0.12, b0[2]];
                const q = sd < 0 ? [b0, a0, a1, b1] : [a0, b0, b1, a1];
                b.quad(q, [[0, 0.12], [L2 / 0.8, 0.12], [L2 / 0.8, (q[2][1]) / 0.6], [0, q[3][1] / 0.6]], pm);
                const f0 = [A[0] + nx * (o - sd * 0.03), 0, A[2] + nz * (o - sd * 0.03)], f1 = [B[0] + nx * (o - sd * 0.03), 0, B[2] + nz * (o - sd * 0.03)];
                const fq = sd < 0 ? [f1, f0, [f0[0], 0.1, f0[2]], [f1[0], 0.1, f1[2]]] : [f0, f1, [f1[0], 0.1, f1[2]], [f0[0], 0.1, f0[2]]];
                b.quad(fq, [[0, 0], [L2 / 0.3, 0], [L2 / 0.3, 0.3], [0, 0.3]], ft);
              }
            }
          }
        }, c.id);
      }
    }
    // corner squares (transfer plates) at turn points
    for (const g of path.segs) if (g.turnB) {
      const [x, z, y] = g.B;
      place(x, Math.min(y, 1), z, (X) => {
        const b = X.b;
        b.box(x - hw + 0.02, y - 0.004, z - hw + 0.02, x + hw - 0.02, y, z + hw - 0.02, m('roller', null, [0.1, 0.1]), NY);
        b.box(x - hw, y - 0.14, z - hw, x + hw, y - 0.004, z + hw, frameM, FY);
        if (y <= 1.6 && !c.elevated) b.box(x - hw + 0.02, 0.1, z - hw + 0.02, x + hw - 0.02, y - 0.14, z + hw - 0.02, m('paint', C.machine, [0.8, 0.6]), FY | NY);
        // motor drive on the corner
        b.cyl(x, y - 0.5, z, 0.11, 0.36, 10, MAT.paint([0.2, 0.3, 0.45], 0.3), 3);
      }, c.id);
    }
    // posts under elevated parts (mirrors gen.js so the art matches the proxies)
    const pts = c.points, nseg = c.closed ? pts.length : pts.length - 1, hwc = c.width / 2;
    for (let k = 0; k < nseg; k++) {
      const A = pts[k], B = pts[(k + 1) % pts.length];
      const alongX = Math.abs(B[0] - A[0]) > 1e-6, sgn = Math.sign(alongX ? B[0] - A[0] : B[1] - A[1]);
      const len = Math.abs(alongX ? B[0] - A[0] : B[1] - A[1]), incline = Math.abs(B[2] - A[2]) > 1e-6;
      const elevatedSeg = c.elevated || Math.min(A[2], B[2]) > 1.6 || (incline && Math.max(A[2], B[2]) > 1.6);
      if (!elevatedSeg) continue;
      const nPost = Math.max(1, Math.floor(len / 2.5));
      for (let i = 0; i <= nPost; i++) {
        const f = (i + 0.5) / (nPost + 1), u = (alongX ? A[0] : A[1]) + sgn * len * f, top = A[2] + (B[2] - A[2]) * f;
        if (top <= 1.6 && !c.elevated) continue;
        if (c.avoid?.some((z) => u > z[0] && u < z[1])) continue;
        const other = alongX ? A[1] : A[0];
        const x = alongX ? u : other, z = alongX ? other : u;
        place(x, 0.5, z, (X) => {
          const b = X.b;
          for (const side of [-1, 1]) {
            const o2 = other + side * (hwc - 0.08);
            const px = alongX ? u : o2, pz = alongX ? o2 : u;
            b.box(px - 0.05, 0, pz - 0.05, px + 0.05, top - 0.3, pz + 0.05, galv, NY | FY);
            b.box(px - 0.1, 0, pz - 0.1, px + 0.1, 0.012, pz + 0.1, galv, NY);
          }
          // cross beam under the belt
          if (alongX) b.box(u - 0.04, top - 0.38, other - hwc + 0.03, u + 0.04, top - 0.3, other + hwc - 0.03, galv);
          else b.box(other - hwc + 0.03, top - 0.38, u - 0.04, other + hwc - 0.03, top - 0.3, u + 0.04, galv);
        }, c.id);
      }
    }
  });
  // sorter: chutes + diverter housings + photo eyes
  const S = L.sorter;
  for (const ch of S.chutes) {
    const zc = (ch.z0 + ch.z1) / 2;
    place((ch.x0 + ch.x1) / 2, 0.4, zc, (X) => {
      const b = X.b;
      const st = MAT.steel(0.5), panel = m('paint', C.machine, [0.8, 0.6]);
      b.box(ch.x0, 0.1, ch.z0, ch.x1, 0.45, ch.z1, panel, FY | NY);
      b.box(ch.x0 + 0.03, 0, ch.z0 + 0.03, ch.x1 - 0.03, 0.1, ch.z1 - 0.03, MAT.paint(C.dgrey, 0.3), FY | NY);
      // sloped slide 0.72 → 0.48 with side walls and an end stop
      b.quad([[ch.x0, 0.72, ch.z1], [ch.x1, 0.48, ch.z1], [ch.x1, 0.48, ch.z0], [ch.x0, 0.72, ch.z0]], [[0, 0], [1, 0], [1, 1.2], [0, 1.2]], m('galv', null, 1));
      b.quad([[ch.x0, 0.72, ch.z0], [ch.x1, 0.48, ch.z0], [ch.x1, 0.45, ch.z0], [ch.x0, 0.45, ch.z0]], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]], panel);
      b.quad([[ch.x0, 0.72, ch.z1], [ch.x1, 0.48, ch.z1], [ch.x1, 0.45, ch.z1], [ch.x0, 0.45, ch.z1]].reverse(), [[0, 0], [1, 0], [1, 0.2], [0, 0.2]], panel);
      for (const zz of [ch.z0, ch.z1 - 0.012]) {
        b.quad([[ch.x0, 0.72, zz], [ch.x1, 0.48, zz], [ch.x1, 0.66, zz], [ch.x0, 0.88, zz]], [[0, 0], [1, 0], [1, 0.3], [0, 0.3]], st, true);
      }
      b.box(ch.x1 - 0.03, 0.45, ch.z0, ch.x1, 0.66, ch.z1, st, NY);
      // diverter housing on the inner (west) side of the belt + photo eye upstream
      b.box(78.9, 0.7, zc - 0.42, 79.1, 0.92, zc - 0.22, MAT.paint([0.2, 0.32, 0.55], 0.3), NY);
      b.box(78.95, 0, zc - 0.36, 79.05, 0.7, zc - 0.28, galv, NY | FY);
      b.box(79.0, 0.84, ch.z0 - 0.42, 79.06, 0.94, ch.z0 - 0.36, MAT.paint(C.black, 0.2), NY);
      b.box(79.061, 0.88, ch.z0 - 0.4, 79.062, 0.9, ch.z0 - 0.38, MAT.light(3, [1, 0.25, 0.1]), 0);
    }, ch.id);
  }

}

function roller(b, x0, x1, y, z, r, belt) {
  // hexagonal roller along x; v runs around the circumference (scrolls → the stripe turns)
  const n = 6, mt = m('roller', null, 0, { belt });
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    b.quad([[x0, y + p0[1], z + p0[0]], [x0, y + p1[1], z + p1[0]], [x1, y + p1[1], z + p1[0]], [x1, y + p0[1], z + p0[0]]],
      [[0, i / n], [0, (i + 1) / n], [4, (i + 1) / n], [4, i / n]], mt);
  }
}

/** railings (arch 'rail' elements): square posts, round handrail + knee rail, toe board */
export function railArt(L, place) {
  const yel = MAT.paint(C.yellow, 0.5);
  for (const e of L.arch) {
    if (e.t !== 'rail') continue;
    const ax = e.axis === 'x';
    const len = e.to - e.from, nPost = Math.max(2, Math.ceil(len / 1.5) + 1);
    const P = (u, y) => (ax ? [u, y, e.at] : [e.at, y, u]);
    // pieces of ≤ 6 m so they fall into the right chunks
    const nPiece = Math.max(1, Math.ceil(len / 6));
    for (let p = 0; p < nPiece; p++) {
      const a = e.from + len * p / nPiece, bb = e.from + len * (p + 1) / nPiece;
      const mid = P((a + bb) / 2, e.y + 0.5);
      place(mid[0], mid[1], mid[2], (X) => {
        const b = X.b;
        b.tube(P(a + 0.01, e.y + 1.0), P(bb - 0.01, e.y + 1.0), 0.022, 8, yel);
        b.tube(P(a + 0.01, e.y + 0.52), P(bb - 0.01, e.y + 0.52), 0.016, 6, yel);
        const t0 = ax ? [a, e.y, e.at - 0.01] : [e.at - 0.01, e.y, a], t1 = ax ? [bb, e.y + 0.1, e.at + 0.01] : [e.at + 0.01, e.y + 0.1, bb];
        b.box(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], yel, NY);
        for (let k = 0; k < nPost; k++) {
          const c = e.from + 0.03 + (len - 0.06) * (k / (nPost - 1));
          if (c < a - 1e-6 || c >= bb - 1e-6) continue;
          const q = P(c, e.y);
          b.box(q[0] - 0.025, e.y, q[2] - 0.025, q[0] + 0.025, e.y + 1.0, q[2] + 0.025, yel, NY);
        }
      }, `rail`);
    }
  }
}

/** basement pipes (raw group 'pipe'): round pipes with hangers to the ceiling */
export function pipeArt(L, place) {
  for (const r of L.raw) {
    if (r.group !== 'pipe') continue;
    const sx = r.max[0] - r.min[0], sz = r.max[2] - r.min[2], alongX = sx > sz;
    const rad = Math.min(r.max[1] - r.min[1], alongX ? sz : sx) / 2;
    const cy = (r.min[1] + r.max[1]) / 2, cz = (r.min[2] + r.max[2]) / 2, cx = (r.min[0] + r.max[0]) / 2;
    const len = alongX ? sx : sz, n = Math.max(1, Math.ceil(len / 4));
    const col = r.surf === 'red' ? MAT.paint(C.red, 0.5) : MAT.paint([0.55, 0.57, 0.58], 0.5);
    for (let p = 0; p < n; p++) {
      const a = (alongX ? r.min[0] : r.min[2]) + len * p / n, bb = (alongX ? r.min[0] : r.min[2]) + len * (p + 1) / n;
      const A = alongX ? [a, cy, cz] : [cx, cy, a], B = alongX ? [bb, cy, cz] : [cx, cy, bb];
      place((A[0] + B[0]) / 2, cy, (A[2] + B[2]) / 2, (X) => {
        X.b.tube(A, B, rad, 10, col);
        const h = alongX ? [(a + bb) / 2, cy, cz] : [cx, cy, (a + bb) / 2];
        X.b.box(h[0] - 0.015, cy + rad * 0.6, h[2] - 0.015, h[0] + 0.015, -0.3, h[2] + 0.015, MAT.galv(0.3), NY);
        X.b.tube(alongX ? [h[0] - 0.02, cy + rad, cz - rad - 0.01] : [cx - rad - 0.01, cy + rad, h[2] - 0.02], alongX ? [h[0] - 0.02, cy + rad, cz + rad + 0.01] : [cx + rad + 0.01, cy + rad, h[2] - 0.02], 0.008, 4, MAT.galv(0.3));
      }, 'pipe');
    }
  }
}

/** stacker crane floor rail + ceiling guide rail */
export function craneRailArt(L, place) {
  for (const cr of L.cranes) {
    const z0 = cr.z0 - 0.5, z1 = cr.z1 + 0.5, n = Math.ceil((z1 - z0) / 4);
    for (let p = 0; p < n; p++) {
      const a = z0 + (z1 - z0) * p / n, bb = z0 + (z1 - z0) * (p + 1) / n;
      place(cr.x, 0.5, (a + bb) / 2, (X) => {
        const b = X.b;
        b.box(cr.x - 0.1, 0, a, cr.x + 0.1, 0.012, bb, MAT.steel(0.6), NY);
        b.box(cr.x - 0.025, 0.012, a, cr.x + 0.025, 0.07, bb, MAT.steel(0.6), NY);
        b.box(cr.x - 0.05, 0.07, a, cr.x + 0.05, 0.08, bb, m('steel', [1.2, 1.2, 1.2], 0.6), NY);
        b.box(cr.x - 0.08, 11.62, a, cr.x + 0.08, 11.7, bb, MAT.paint(C.dgrey, 0.5), 0);
      }, 'crane');
    }
  }
}
