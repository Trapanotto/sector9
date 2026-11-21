// Layout → greybox: boxes, faces, glass panes, doors. Pure and deterministic: the bake (Node) and the runtime
// (browser) both call generateWorld(LAYOUT) and must get the identical result (checked via `hash`).
// Owner: core.
import { SURF, LM_DENSITY, LM_DENSITY_DEFAULT } from './layout/surfaces.js';
import { packLightmap } from './lmpack.js';

export const GEN_VERSION = 3;

// side index s: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z ; bit = 1 << s
export const SIDE_BITS = [1, 2, 4, 8, 16, 32];
// tangent axes (u, v) per normal axis
export const TAN = [[2, 1], [0, 2], [0, 1]];

const CLS_FLAGS = {
  //          render     solid  occ    shoot  walk
  arch:     { render: 'lm', solid: true, occ: true, shoot: true, walk: true },
  prop:     { render: 'vl', solid: true, occ: true, shoot: true, walk: false },
  mesh:     { render: 'mesh', solid: true, occ: false, shoot: false, walk: false },
  far:      { render: 'vl', solid: false, occ: true, shoot: true, walk: false },
  collider: { render: null, solid: true, occ: false, shoot: false, walk: false },
};
// bit flags stored per box (typed arrays in bvh/collision)
export const F_SOLID = 1, F_OCC = 2, F_SHOOT = 4, F_WALK = 8;

/** Zone lookup: first zone whose part contains the point. Returns zone index or -1. */
export function makeZoneLookup(zones) {
  const parts = [];
  zones.forEach((z, i) => z.parts.forEach((p) => parts.push({ i, p })));
  const n = parts.length, P = new Float32Array(n * 6), Zi = new Int16Array(n);
  parts.forEach((e, k) => { P.set(e.p, k * 6); Zi[k] = e.i; });
  function at(x, y, z) {
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      if (x >= P[o] && x <= P[o + 3] && y >= P[o + 1] && y <= P[o + 4] && z >= P[o + 2] && z <= P[o + 5]) return Zi[k];
    }
    return -1;
  }
  function nearest(x, y, z) {
    const i = at(x, y, z);
    if (i >= 0) return i;
    let best = -1, bd = Infinity;
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      const dx = Math.max(P[o] - x, 0, x - P[o + 3]), dy = Math.max(P[o + 1] - y, 0, y - P[o + 4]), dz = Math.max(P[o + 2] - z, 0, z - P[o + 5]);
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = Zi[k]; }
    }
    return best;
  }
  return { at, nearest };
}

// ---------------------------------------------------------------------------------------------------------
function rectSplit(x0, z0, x1, z1, holes) {
  // rectangle minus axis-aligned holes → list of merged rectangles [x0,z0,x1,z1]
  const hs = holes.map((h) => [Math.max(h[0], x0), Math.max(h[1], z0), Math.min(h[2], x1), Math.min(h[3], z1)])
    .filter((h) => h[2] > h[0] && h[3] > h[1]);
  if (!hs.length) return [[x0, z0, x1, z1]];
  const xs = [...new Set([x0, x1, ...hs.flatMap((h) => [h[0], h[2]])])].sort((a, b) => a - b);
  const zs = [...new Set([z0, z1, ...hs.flatMap((h) => [h[1], h[3]])])].sort((a, b) => a - b);
  const solid = (i, j) => {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
    return !hs.some((h) => cx > h[0] && cx < h[2] && cz > h[1] && cz < h[3]);
  };
  // runs per row, then merge identical runs vertically
  let open = [];  // {i0,i1,j0}
  const out = [];
  for (let j = 0; j < zs.length - 1; j++) {
    const runs = [];
    for (let i = 0; i < xs.length - 1; i++) {
      if (!solid(i, j)) continue;
      if (runs.length && runs[runs.length - 1].i1 === i) runs[runs.length - 1].i1 = i + 1;
      else runs.push({ i0: i, i1: i + 1 });
    }
    const next = [];
    for (const r of runs) {
      const o = open.find((q) => q.i0 === r.i0 && q.i1 === r.i1);
      if (o) { next.push(o); open = open.filter((q) => q !== o); } else next.push({ i0: r.i0, i1: r.i1, j0: j });
    }
    for (const o of open) out.push([xs[o.i0], zs[o.j0], xs[o.i1], zs[j]]);
    open = next;
  }
  for (const o of open) out.push([xs[o.i0], zs[o.j0], xs[o.i1], zs[zs.length - 1]]);
  return out;
}

function subtractIntervals(a, b, cuts) {
  // [a,b] minus union of cuts → list of [s,e]
  const cs = cuts.map((c) => [Math.max(a, c[0]), Math.min(b, c[1])]).filter((c) => c[1] > c[0]).sort((p, q) => p[0] - q[0]);
  const out = [];
  let cur = a;
  for (const [s, e] of cs) { if (s > cur + 1e-6) out.push([cur, s]); cur = Math.max(cur, e); }
  if (b > cur + 1e-6) out.push([cur, b]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
export function generateWorld(L) {
  const boxes = [], glass = [], doors = [], openings = [];
  let gid = 0;
  const add = (min, max, o) => {
    if (!(max[0] > min[0] + 1e-6 && max[1] > min[1] + 1e-6 && max[2] > min[2] + 1e-6)) return;
    const cls = o.cls ?? 'arch';
    const surf = o.surf ?? 'concrete';
    const f = CLS_FLAGS[cls];
    boxes.push({
      min: min.map(r4), max: max.map(r4), cls, surf, color: o.color ?? SURF[surf]?.color ?? [0.5, 0.5, 0.5],
      hide: o.hide ?? 0, solid: o.solid ?? f.solid, occ: o.occ ?? f.occ, shoot: o.shoot ?? f.shoot,
      walk: o.walk ?? f.walk, render: f.render, group: o.group ?? null, tag: o.tag ?? null, emit: o.emit ?? 0,
      circuit: o.circuit ?? null, src: o.src ?? null,
    });
  };

  // ---- architecture
  L.arch.forEach((e, ei) => {
    const src = e.t + ei;
    if (e.t === 'box') { add(e.min, e.max, { ...e, src }); return; }
    if (e.t === 'slab') {
      const hideTB = (e.hide ?? 0) & (4 | 8), hideSides = (e.hide ?? 0) & ~(4 | 8);
      for (const r of rectSplit(e.x0, e.z0, e.x1, e.z1, e.holes ?? [])) {
        let h = hideTB | hideSides;
        if (e.hideOuter) {
          if (r[0] <= e.x0 + 1e-6) h |= 2; if (r[2] >= e.x1 - 1e-6) h |= 1;
          if (r[1] <= e.z0 + 1e-6) h |= 32; if (r[3] >= e.z1 - 1e-6) h |= 16;
        }
        add([r[0], e.y0, r[1]], [r[2], e.y1, r[3]], { ...e, hide: h, src, walk: e.walk ?? (e.cls ? undefined : true) });
      }
      if (e.skylights) for (const hl of e.holes ?? []) {
        const y = (e.y0 + e.y1) / 2;
        glass.push({ id: `g${gid++}`, min: [hl[0], y - 0.01, hl[1]], max: [hl[2], y + 0.01, hl[3]], axis: 1, breakable: false, skylight: true });
      }
      return;
    }
    if (e.t === 'wall') {
      const ax = e.axis === 'x' ? 0 : 2, ox = ax === 0 ? 2 : 0;   // along axis, thickness axis
      const t0 = e.at - e.th / 2, t1 = e.at + e.th / 2;
      const ops = e.openings ?? [];
      const pts = [...new Set([e.from, e.to, ...ops.flatMap((o) => [o.a, o.b])])].filter((p) => p >= e.from && p <= e.to).sort((a, b) => a - b);
      const cols = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const p = pts[k], q = pts[k + 1], mid = (p + q) / 2;
        const cuts = ops.filter((o) => o.a < mid && o.b > mid).map((o) => [o.y0, o.y1]);
        const ys = subtractIntervals(e.y0, e.y1, cuts);
        const key = ys.map((y) => y.join(',')).join(';');
        if (cols.length && cols[cols.length - 1].key === key) cols[cols.length - 1].q = q;
        else cols.push({ p, q, ys, key });
      }
      const sideHide = (e.hide ?? 0) & ~(4 | 8);
      for (const c of cols) for (const [ya, yb] of c.ys) {
        let h = sideHide;
        if (ya <= e.y0 + 1e-6) h |= ((e.hide ?? 0) & 8) | (e.showBottom ? 0 : 8);
        if (yb >= e.y1 - 1e-6) h |= (e.hide ?? 0) & 4;
        const min = [0, ya, 0], max = [0, yb, 0];
        min[ax] = c.p; max[ax] = c.q; min[ox] = t0; max[ox] = t1;
        add(min, max, { ...e, hide: h, src, walk: false });
      }
      for (const o of ops) {
        const min = [0, o.y0, 0], max = [0, o.y1, 0];
        min[ax] = o.a; max[ax] = o.b;
        const rec = { wall: src, axis: e.axis, at: e.at, th: e.th, a: o.a, b: o.b, y0: o.y0, y1: o.y1, cls: e.cls ?? 'arch' };
        if (o.glass) {
          min[ox] = e.at - 0.01; max[ox] = e.at + 0.01;
          glass.push({ id: o.glass.id ?? `g${gid++}`, min: min.map(r4), max: max.map(r4), axis: ox, breakable: o.glass.breakable !== false });
          rec.kind = 'window';
        } else if (o.door) {
          doors.push({ ...o.door, axis: e.axis, at: e.at, th: e.th, a: o.a, b: o.b, y0: o.y0, y1: o.y1, mesh: e.cls === 'mesh' });
          rec.kind = 'door'; rec.door = o.door.id;
        } else rec.kind = 'opening';
        openings.push(rec);
      }
      return;
    }
    if (e.t === 'stairs') {
      const n = e.steps, h = (e.y1 - e.y0) / n;
      const alongX = e.dir[1] === 'x', pos = e.dir[0] === '+';
      const a0 = alongX ? e.x0 : e.z0, a1 = alongX ? e.x1 : e.z1, t = (a1 - a0) / n;
      for (let i = 0; i < n; i++) {
        const s0 = pos ? a0 + i * t : a1 - (i + 1) * t, s1 = s0 + t;
        const top = e.y0 + (i + 1) * h;
        const min = alongX ? [s0, e.y0, e.z0] : [e.x0, e.y0, s0], max = alongX ? [s1, top, e.z1] : [e.x1, top, s1];
        add(min, max, { ...e, hide: 8, src, walk: true, group: 'stairs' });
      }
      return;
    }
    if (e.t === 'rail') {
      const ax = e.axis === 'x' ? 0 : 2, ox = ax === 0 ? 2 : 0;
      const mk = (a, b, ya, yb, hw, o) => {
        const min = [0, ya, 0], max = [0, yb, 0];
        min[ax] = a; max[ax] = b; min[ox] = e.at - hw; max[ox] = e.at + hw;
        add(min, max, o);
      };
      const len = e.to - e.from, nPost = Math.max(2, Math.ceil(len / 1.5) + 1);
      const ro = { cls: 'prop', surf: e.surf ?? 'yellow', group: 'rail', src, solid: false };
      for (let k = 0; k < nPost; k++) {
        const c = e.from + 0.03 + (len - 0.06) * (k / (nPost - 1));
        mk(c - 0.03, c + 0.03, e.y, e.y + 0.98, 0.03, ro);
      }
      mk(e.from + 0.01, e.to - 0.01, e.y + 0.98, e.y + 1.03, 0.025, ro);
      mk(e.from + 0.01, e.to - 0.01, e.y + 0.5, e.y + 0.54, 0.02, ro);
      mk(e.from, e.to, e.y, e.y + 1.1, 0.05, { cls: 'collider', src });
      return;
    }
    throw new Error(`unknown arch element ${e.t}`);
  });

  // ---- split big architecture boxes at zone boundaries so each face piece belongs to the zone it faces
  // (otherwise one floor slab spanning the whole hall would make one zone "visible from everywhere" in the PVS)
  splitArchByZones(boxes, L.zones);

  // ---- props (typed instances) and raw prop boxes
  const rot = (x, z, r) => (r === 0 ? [x, z] : r === 1 ? [z, -x] : r === 2 ? [-x, -z] : [-z, x]);
  const placeType = (type, p, r, extra) => {
    const T = L.propTypes[type];
    if (!T) throw new Error(`unknown prop type ${type}`);
    for (const b of T.boxes) {
      const [x0, y0, z0, x1, y1, z1, surf, f] = b;
      const a = rot(x0, z0, r), c = rot(x1, z1, r);
      add([p[0] + Math.min(a[0], c[0]), p[1] + y0, p[2] + Math.min(a[1], c[1])],
        [p[0] + Math.max(a[0], c[0]), p[1] + y1, p[2] + Math.max(a[1], c[1])],
        { cls: 'prop', surf, ...(T.noCollide ? { solid: false } : {}), ...f, ...extra });
    }
  };
  L.props.forEach((pi, k) => placeType(pi.type, pi.p, pi.r ?? 0, { group: pi.type, tag: pi.id ?? `${pi.type}#${k}`, src: `prop${k}` }));
  for (const b of L.raw) add(b.min, b.max, { cls: 'prop', ...b, tag: b.rack ?? b.tag });

  // ---- machines: conveyor frames + sorter chutes (static parts)
  for (const c of L.conveyors) {
    const hw = c.width / 2, pts = c.points, nseg = c.closed ? pts.length : pts.length - 1;
    for (let k = 0; k < nseg; k++) {
      const A = pts[k], B = pts[(k + 1) % pts.length];
      const alongX = Math.abs(B[0] - A[0]) > 1e-6, ax = alongX ? 0 : 1;   // index into [x,z]
      const sgn = Math.sign((alongX ? B[0] - A[0] : B[1] - A[1]));
      const len = Math.abs(alongX ? B[0] - A[0] : B[1] - A[1]);
      const incline = Math.abs(B[2] - A[2]) > 1e-6;
      const pieces = incline ? Math.ceil(len / 0.5) : 1;
      // start corner square included, end corner excluded (closed loops cover each corner once)
      const s0 = (alongX ? A[0] : A[1]) - sgn * hw, total = len;
      for (let i = 0; i < pieces; i++) {
        const u0 = s0 + sgn * (total * i / pieces), u1 = s0 + sgn * (total * (i + 1) / pieces);
        const top = incline ? A[2] + (B[2] - A[2]) * ((i + 0.5) / pieces) : A[2];
        const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
        const other = alongX ? A[1] : A[0];
        const mk = (ya, yb, o) => {
          const min = alongX ? [lo, ya, other - hw] : [other - hw, ya, lo];
          const max = alongX ? [hi, yb, other + hw] : [other + hw, yb, hi];
          add(min, max, { cls: 'prop', surf: 'machine', group: 'conveyor', tag: c.id, ...o });
        };
        const elevated = c.elevated || top > 1.6;
        if (!elevated) mk(0, top, {});
        else {
          mk(top - 0.3, top, {});
        }
      }
      // posts under elevated parts every ~2.5 m (both sides), placed inside the segment span
      const elevatedSeg = c.elevated || Math.min(A[2], B[2]) > 1.6 || (incline && Math.max(A[2], B[2]) > 1.6);
      if (elevatedSeg) {
        const nPost = Math.max(1, Math.floor(len / 2.5));
        for (let i = 0; i <= nPost; i++) {
          const f = (i + 0.5) / (nPost + 1);
          const u = (alongX ? A[0] : A[1]) + sgn * len * f;
          const top = A[2] + (B[2] - A[2]) * f;
          if (top <= 1.6 && !c.elevated) continue;
          const other = alongX ? A[1] : A[0];
          for (const side of [-1, 1]) {
            const o2 = other + side * (hw - 0.08);   // inset: no face coplanar with the belt
            const min = alongX ? [u - 0.05, 0, o2 - 0.05] : [o2 - 0.05, 0, u - 0.05];
            const max = alongX ? [u + 0.05, top - 0.3, o2 + 0.05] : [o2 + 0.05, top - 0.3, u + 0.05];
            if (c.avoid?.some((z) => u > z[0] && u < z[1])) continue;
            add(min, max, { cls: 'prop', surf: 'steel', group: 'conveyor_post', tag: c.id });
          }
        }
      }
    }
  }
  for (const ch of L.sorter.chutes) add([ch.x0, 0, ch.z0], [ch.x1, ch.top, ch.z1], { cls: 'prop', surf: 'steel', group: 'chute', tag: ch.id });
  for (const cr of L.cranes) add([cr.x - 0.1, 0, cr.z0 - 0.5], [cr.x + 0.1, 0.08, cr.z1 + 0.5], { cls: 'prop', surf: 'steel', group: 'crane_rail', tag: cr.id, solid: false });

  // ---- light fixtures (emissive housings, no collision, no occlusion)
  const LAMP = { highbay: 'lamp_highbay', tube: 'lamp_tube' };
  L.fixtures.forEach((fx, k) => {
    const extra = { circuit: fx.circuit, group: 'lamp', tag: `lamp${k}`, solid: false, occ: false, shoot: false };
    if (LAMP[fx.type]) placeType(LAMP[fx.type], fx.pos, 0, extra);
    else {
      const s = fx.type === 'flood' ? 0.25 : 0.08;
      add([fx.pos[0] - s, fx.pos[1], fx.pos[2] - s], [fx.pos[0] + s, fx.pos[1] + s * 1.2, fx.pos[2] + s],
        { cls: 'prop', surf: 'white', emit: 5, ...extra });
    }
  });

  // ---- zones
  const zl = makeZoneLookup(L.zones);
  for (const b of boxes) {
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    b.zone = zl.nearest(c[0], b.render === 'lm' ? c[1] : Math.min(c[1], b.min[1] + 1.0), c[2]);
  }
  for (const g of glass) {
    const c = [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2];
    g.zone = zl.nearest(c[0], c[1], c[2]);
  }

  // ---- faces with culling of faces covered by an adjacent / enclosing opaque box
  const faces = buildFaces(boxes, L.zones, zl);

  // ---- lightmap atlas for architecture faces
  const lm = packLightmap(faces.filter((f) => f.lm), { density: (f) => f.density });

  const zoneIndex = new Map(L.zones.map((z, i) => [z.id, i]));
  const hash = fnv(JSON.stringify([GEN_VERSION, boxes.map((b) => [b.min, b.max, b.cls, b.hide, b.color, b.emit, b.circuit]),
    glass.map((g) => [g.min, g.max]), L.sun, L.sky, L.fixtures, L.zones.map((z) => [z.id, z.circuit, z.parts]), lm.width, lm.height]));
  return { boxes, faces, glass, doors, openings, lm, zones: L.zones, zoneIndex, zoneLookup: zl, hash, layout: L };
}

function r4(v) { return Math.round(v * 10000) / 10000; }

function splitArchByZones(boxes, zones) {
  const zl = makeZoneLookup(zones);
  const parts = zones.flatMap((z) => z.parts);
  const out = [];
  const sig = (min, max) => {
    // zone in front of each of the 6 faces (vertical faces sampled near their bottom)
    const s = [];
    for (let a = 0; a < 3; a++) for (const pos of [true, false]) {
      const c = [(min[0] + max[0]) / 2, Math.min(max[1] - 0.05, min[1] + 1.0), (min[2] + max[2]) / 2];
      if (a === 1) c[1] = pos ? max[1] + 0.05 : min[1] - 0.05;
      else c[a] = pos ? max[a] + 0.05 : min[a] - 0.05;
      s.push(zl.at(c[0], c[1], c[2]));
    }
    return s.join(',');
  };
  // first split tall boxes (walls through several storeys) at zone floor/ceiling heights
  const layered = [];
  for (const b of boxes) {
    if (b.cls !== 'arch' || b.max[1] - b.min[1] < 3) { layered.push(b); continue; }
    const ys = new Set([b.min[1], b.max[1]]);
    for (const p of parts) {
      if (p[0] > b.max[0] || p[3] < b.min[0] || p[2] > b.max[2] || p[5] < b.min[2]) continue;
      for (const y of [p[1], p[4]]) if (y > b.min[1] + 0.25 && y < b.max[1] - 0.25) ys.add(y);
    }
    const Y = [...ys].sort((p, q) => p - q);
    for (let k = 0; k < Y.length - 1; k++) {
      let hide = b.hide;
      if (k > 0) hide &= ~8; if (k < Y.length - 2) hide &= ~4;   // inner cuts: faces touch → culled anyway
      layered.push({ ...b, hide, min: [b.min[0], Y[k], b.min[2]], max: [b.max[0], Y[k + 1], b.max[2]] });
    }
  }
  for (const b of layered) {
    if (b.cls !== 'arch' || Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) < 3) { out.push(b); continue; }
    const xs = new Set([b.min[0], b.max[0]]), zs = new Set([b.min[2], b.max[2]]);
    for (const p of parts) {
      if (p[1] > b.max[1] + 0.2 || p[4] < b.min[1] - 0.2) continue;
      if (p[2] < b.max[2] && p[5] > b.min[2]) for (const x of [p[0], p[3]]) if (x > b.min[0] + 0.05 && x < b.max[0] - 0.05) xs.add(x);
      if (p[0] < b.max[0] && p[3] > b.min[0]) for (const z of [p[2], p[5]]) if (z > b.min[2] + 0.05 && z < b.max[2] - 0.05) zs.add(z);
    }
    if (xs.size === 2 && zs.size === 2) { out.push(b); continue; }
    const X = [...xs].sort((p, q) => p - q), Zs = [...zs].sort((p, q) => p - q);
    // cells → signature; merge runs along x, then identical runs along z
    let open = [];
    const emit = (r, j1) => out.push({ ...b, min: [X[r.i0], b.min[1], Zs[r.j0]], max: [X[r.i1], b.max[1], Zs[j1]] });
    for (let j = 0; j < Zs.length - 1; j++) {
      const runs = [];
      for (let i = 0; i < X.length - 1; i++) {
        const s = sig([X[i], b.min[1], Zs[j]], [X[i + 1], b.max[1], Zs[j + 1]]);
        if (runs.length && runs[runs.length - 1].s === s) runs[runs.length - 1].i1 = i + 1;
        else runs.push({ i0: i, i1: i + 1, s });
      }
      const next = [];
      for (const r of runs) {
        const o = open.find((q) => q.i0 === r.i0 && q.i1 === r.i1 && q.s === r.s);
        if (o) { next.push(o); open = open.filter((q) => q !== o); } else next.push({ ...r, j0: j });
      }
      for (const o of open) emit(o, j);
      open = next;
    }
    for (const o of open) emit(o, Zs.length - 1);
  }
  boxes.length = 0;
  boxes.push(...out);
}

export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------------------
// Faces
function buildFaces(boxes, zones, zl) {
  const EPS = 2e-4;
  // spatial hash over occluding, rendered opaque boxes (those can hide faces)
  const cell = 4, grid = new Map();
  const key = (i, j) => i * 100003 + j;
  const hiders = [];
  boxes.forEach((b, i) => { if (b.render === 'lm' || b.render === 'vl') hiders.push(i); });
  for (const i of hiders) {
    const b = boxes[i];
    for (let gx = Math.floor(b.min[0] / cell); gx <= Math.floor(b.max[0] / cell); gx++)
      for (let gz = Math.floor(b.min[2] / cell); gz <= Math.floor(b.max[2] / cell); gz++) {
        const k = key(gx, gz); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
      }
  }
  const near = (min, max) => {
    const out = new Set();
    if ((max[0] - min[0]) / cell * (max[2] - min[2]) / cell > 4000) return hiders;   // huge (far ground)
    for (let gx = Math.floor(min[0] / cell); gx <= Math.floor(max[0] / cell); gx++)
      for (let gz = Math.floor(min[2] / cell); gz <= Math.floor(max[2] / cell); gz++) {
        const l = grid.get(key(gx, gz)); if (l) for (const i of l) out.add(i);
      }
    return out;
  };

  const faces = [];
  boxes.forEach((b, bi) => {
    if (!b.render) return;
    const cand = near(b.min, b.max);
    for (let s = 0; s < 6; s++) {
      if (b.hide & SIDE_BITS[s]) continue;
      const a = s >> 1, pos = (s & 1) === 0, [ua, va] = TAN[a];
      const p = pos ? b.max[a] : b.min[a];
      const u0 = b.min[ua], u1 = b.max[ua], v0 = b.min[va], v1 = b.max[va];
      if (u1 - u0 < 1e-5 || v1 - v0 < 1e-5) continue;
      let covered = false;
      if (b.render !== 'mesh') for (const oi of cand) {
        if (oi === bi) continue;
        const o = boxes[oi];
        if (o.render !== 'lm' && o.render !== 'vl') continue;
        // o must occupy the space directly in front of the face
        const inFront = pos ? (o.min[a] <= p + EPS && o.max[a] > p + EPS) : (o.max[a] >= p - EPS && o.min[a] < p - EPS);
        if (!inFront) continue;
        if (o.min[ua] <= u0 + EPS && o.max[ua] >= u1 - EPS && o.min[va] <= v0 + EPS && o.max[va] >= v1 - EPS) { covered = true; break; }
      }
      if (covered) continue;
      const n = [0, 0, 0]; n[a] = pos ? 1 : -1;
      const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      c[a] = p + n[a] * 0.05;
      let zone = b.zone;
      if (b.render === 'lm') {
        // architecture faces belong to the zone in front of them (inner wall face → room, outer → outside)
        zone = zl.nearest(c[0], c[1], c[2]);
        if (a !== 1) {   // vertical faces: test a point near the bottom (rooms are bounded in y)
          const yb = Math.min(b.max[1] - 0.05, b.min[1] + 1.0);
          const z2 = zl.at(c[0], yb, c[2]);
          if (z2 >= 0) zone = z2;
        }
      }
      const zr = zones[zone];
      faces.push({
        box: bi, side: s, axis: a, pos, plane: p, u0, u1, v0, v1, ua, va, zone,
        circuit: b.circuit ?? zr?.circuit ?? null,
        lm: b.render === 'lm', render: b.render,
        density: LM_DENSITY[b.surf] ?? LM_DENSITY_DEFAULT,
      });
    }
  });
  return faces;
}

/** Corner k (0..3) of a face: (u0,v0), (u1,v0), (u1,v1), (u0,v1). Writes xyz into out. Shared by bake + mesh. */
export function faceCorner(f, k, out) {
  out[f.axis] = f.plane;
  out[f.ua] = k === 0 || k === 3 ? f.u0 : f.u1;
  out[f.va] = k < 2 ? f.v0 : f.v1;
  return out;
}

/** Flags byte for a box (F_* bits). */
export function boxFlags(b) {
  return (b.solid ? F_SOLID : 0) | (b.occ ? F_OCC : 0) | (b.shoot ? F_SHOOT : 0) | (b.walk ? F_WALK : 0);
}
