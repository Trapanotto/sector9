// Builds ALL static world art (props, racking, high-bay store, conveyor frames, railings, pipes, decor) into one
// kit Builder, sorted into chunks (zone × 12 m cell) with two LOD index lists each. Pure JS: used by the runtime
// (static.js) and by the Node tests (test-a-art.mjs).
import { Builder, rotQ, M, rng, hash32 } from './kit.js';
import { MODELS, rawRack, rackExtras } from './models.js';
import { conveyorArt, railArt, pipeArt, craneRailArt } from './conveyors.js';
import { decorArt } from './decor.js';

export const CELL = 12;
// proxy groups whose greybox faces are replaced by this art (the proxies stay for collision / bake / bullets)
export const ART_GROUPS = ['rack', 'akl', 'pipe', 'conveyor', 'conveyor_post', 'chute', 'crane_rail', 'rail'];

/**
 * @param L LAYOUT; @param zoneOf (x, y, z) → zone index (gen zone lookup `nearest`)
 * @returns { b, chunks: [{ key, zone, bbox, lists: [lod0 key, lod1 key] }], stats }
 */
export function buildStaticArt(L, zoneOf, zoneIds, opts = {}) {
  const b = new Builder();
  const chunks = new Map();
  const perType = {};          // type → { tris0, tris1, n }
  const chunkOf = (x, y, z) => {
    const zi = zoneOf(x, y, z);
    const key = `${zi}:${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { key, zone: zi, bbox: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] }));
    return c;
  };
  const grow = (c, v0) => {
    const P = b.pos.a, bb = c.bbox;
    for (let i = v0 * 3; i < b.pos.n; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
      if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
    }
  };
  const mkX = (c, seed, id, zone) => {
    const X = { b, id, zone, lodNear: true, rnd: rng(seed), rackMid: 0 };
    X.lod = (mask) => b.target(mask === 1 ? [`${c.key}|0`] : mask === 2 ? [`${c.key}|1`] : [`${c.key}|0`, `${c.key}|1`]);
    return X;
  };
  const stat = (t, tris, lod) => { const s = perType[t] ?? (perType[t] = { tris0: 0, tris1: 0, n: 0 }); if (lod === 0) { s.tris0 += tris; s.n++; } else s.tris1 += tris; };

  // ---- typed prop instances: near pass (LOD0) + far pass (LOD1)
  L.props.forEach((pi, k) => {
    const model = MODELS[pi.type];
    if (!model) return;
    const T = L.propTypes[pi.type];
    const cy = pi.p[1] + Math.min(0.5, (T.boxes[0][4] - T.boxes[0][1]) / 2);
    const c = chunkOf(pi.p[0], cy, pi.p[2]);
    const zone = zoneIds[c.zone];
    const seed = hash32(`${pi.id ?? pi.type}#${k}`);
    b.groundY = pi.p[1];
    b.push(M.mul(M.T(pi.p[0], pi.p[1], pi.p[2]), rotQ(pi.r ?? 0)));
    for (const lod of [0, 1]) {
      const X = mkX(c, seed, pi.id ?? '', zone);
      X.lodNear = lod === 0;
      X.lod(lod === 0 ? 1 : 2);
      const v0 = b.vcount, t0 = b.tris;
      model(X);
      grow(c, v0);
      opts.trace?.(pi.type + '#' + k, v0, b.vcount);
      stat(pi.type, b.tris - t0, lod);
    }
    b.pop();
  });

  // ---- racking / high-bay store from the raw boxes
  const runs = new Map();
  for (const r of L.raw) {
    if (r.group !== 'rack' && r.group !== 'akl') continue;
    let run = runs.get(r.rack);
    if (!run) runs.set(r.rack, (run = { id: r.rack, group: r.group, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, boxes: [] }));
    run.x0 = Math.min(run.x0, r.min[0]); run.x1 = Math.max(run.x1, r.max[0]);
    run.z0 = Math.min(run.z0, r.min[2]); run.z1 = Math.max(run.z1, r.max[2]);
    run.boxes.push(r);
  }
  b.groundY = 0;
  // aisle sides of every run: a side faces an aisle unless another run sits directly against it; AKL blocks
  // face the crane aisle only
  for (const run of runs.values()) {
    run.aisle = [-1, 1].filter((side) => {
      if (run.group === 'akl') return side > 0 ? run.x1 < 89.7 : run.x0 > 89.7;
      const xEdge = side > 0 ? run.x1 : run.x0;
      return ![...runs.values()].some((o) => o !== run && o.group === 'rack' && Math.abs((side > 0 ? o.x0 : o.x1) - xEdge) < 0.05 && o.z0 < run.z1 && o.z1 > run.z0);
    });
  }
  for (const run of runs.values()) {
    const mid = (run.x0 + run.x1) / 2;
    for (const r of run.boxes) {
      const c = chunkOf((r.min[0] + r.max[0]) / 2, Math.min(r.min[1] + 0.5, (r.min[1] + r.max[1]) / 2), (r.min[2] + r.max[2]) / 2);
      const X = mkX(c, hash32(`${r.rack}:${r.min.join(',')}`), r.rack, zoneIds[c.zone]);
      X.rackMid = mid; X.aisle = run.aisle; X.run = run;
      const v0 = b.vcount, t0 = b.tris;
      b.target([`${c.key}|0`, `${c.key}|1`]);
      rawRack(X, r);
      grow(c, v0);
      stat(run.group, b.tris - t0, 0);
    }
    if (run.group !== 'rack') continue;
    // extras per run: frames (upright z), first-level beams (labels), end signs, protectors
    const frames = [...new Set(run.boxes.filter((r) => r.surf === 'rackBlue').map((r) => (r.min[2] + r.max[2]) / 2))].sort((p, q) => p - q);
    const beams = run.boxes.filter((r) => r.surf === 'rackOrange' && Math.abs(r.max[1] - 1.6) < 0.01)
      .map((r, k) => ({ x: (r.min[0] + r.max[0]) / 2 > mid ? r.max[0] : r.min[0], face: (r.min[0] + r.max[0]) / 2 > mid ? 1 : -1, y: r.max[1], zc: (r.min[2] + r.max[2]) / 2, k: k + hash32(run.id) }));
    const aisleSides = run.aisle;
    const ends = [];
    for (const side of aisleSides) for (const z of [frames[0], frames[frames.length - 1]]) ends.push({ x: side > 0 ? run.x1 : run.x0, face: side, z: z + (z === frames[0] ? 0.4 : -0.4) });
    const protect = [{ z0: frames[0] - 0.2, z1: frames[0] - 0.05 }, { z0: frames[frames.length - 1] + 0.05, z1: frames[frames.length - 1] + 0.2 }];
    const meta = { x0: run.x0, x1: run.x1, frames, beams: beams.filter((bm) => aisleSides.includes(bm.face)), ends, protect };
    // emit per frame group into the chunk of its position
    for (let i = 0; i < frames.length; i++) {
      const z = frames[i];
      const c = chunkOf(mid, 1, z);
      const X = mkX(c, hash32(`${run.id}:x${i}`), run.id, zoneIds[c.zone]);
      const sub = { ...meta, frames: [z], beams: meta.beams.filter((bm) => Math.abs(bm.zc - z - 1.35) < 1.0),
        ends: meta.ends.filter((e) => Math.abs(e.z - z) < 1.0), protect: meta.protect.filter((p) => Math.abs((p.z0 + p.z1) / 2 - z) < 0.5) };
      const v0 = b.vcount, t0 = b.tris;
      rackExtras(X, sub);
      grow(c, v0);
      stat('rack_extras', b.tris - t0, 0);
    }
  }

  // ---- conveyors, chutes, posts, railings, pipes, crane rail, decor (art emitted per piece via place())
  const place = (x, y, z, fn, id = '') => {
    const c = chunkOf(x, y, z);
    const X = mkX(c, hash32(`${id}:${x.toFixed(2)},${z.toFixed(2)}`), id, zoneIds[c.zone]);
    X.lod(3);
    const v0 = b.vcount, t0 = b.tris;
    fn(X);
    grow(c, v0);
    opts.trace?.(id, v0, b.vcount);
    return b.tris - t0;
  };
  const track = (t) => (x, y, z, fn, id) => { stat(t, place(x, y, z, fn, id), 0); };
  b.groundY = 0;
  conveyorArt(L, track('conveyor'));
  railArt(L, track('rail'));
  pipeArt(L, track('pipe'));
  craneRailArt(L, track('crane_rail'));
  if (opts.decor !== false) decorArt(L, track('decor'), b, opts.free);

  // ---- finalise chunk index lists
  const out = [];
  for (const c of chunks.values()) {
    if (!Number.isFinite(c.bbox[0])) continue;
    out.push({ key: c.key, zone: c.zone, bbox: c.bbox, lists: [`${c.key}|0`, `${c.key}|1`] });
  }
  return { b, chunks: out, perType };
}
