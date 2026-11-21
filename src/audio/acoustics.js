// Zone acoustics: acoustic classes → reverb parameters, and the zone/portal graph used for occlusion,
// portal panning and ambience bleed. Pure JS (no Web Audio): built once from the generated world and tested in
// Node. Owner: E.
//
// Graph: nodes = LAYOUT zones; edges = portals between two zones:
//   'open'   zones of one space without a wall between them (hall aisles, under/over the mezzanine edge) — found by
//            sampling sight lines across the touching faces of the zone boxes,
//   'door'   a door of ctx.world.doors (transmission follows its live state: open / half / closed / locked),
//   'window' an opening with a glass pane (intact: muffled, broken: open), 'opening' a plain hole in a wall.
// Per listener zone a Dijkstra over portal losses gives, for every zone: loss (dB), low-pass cutoff (Hz), path
// length via the portal points (m) and the first portal seen from the listener (where an occluded sound appears
// to come from).

// Reverb per acoustic class: ir = impulse-response family (engine), wet = send level for a source in that class,
// tail = gunshot tail recipe, bed = ambience bed(s)
export const ACOUSTIC = {
  outdoor:     { ir: 'outdoor', wet: 0.16, tail: 'outdoor', bed: ['amb.outside', 'amb.outside.birds'], absorb: 1.0 },
  hall_large:  { ir: 'hall', wet: 0.62, tail: 'hall', bed: ['amb.warehouse'], absorb: 0.4 },
  hall_medium: { ir: 'hall', wet: 0.5, tail: 'hall', bed: ['amb.warehouse'], absorb: 0.5 },
  room_large:  { ir: 'room', wet: 0.4, tail: 'room', bed: ['amb.factory'], absorb: 0.6 },
  room_small:  { ir: 'small', wet: 0.32, tail: 'small', bed: ['amb.ventilation'], absorb: 0.8 },
  corridor:    { ir: 'small', wet: 0.4, tail: 'small', bed: ['amb.ventilation'], absorb: 0.7 },
  stairwell:   { ir: 'stair', wet: 0.5, tail: 'stair', bed: ['amb.ventilation'], absorb: 0.6 },
  basement:    { ir: 'basement', wet: 0.6, tail: 'basement', bed: ['amb.ventilation'], absorb: 0.4 },
  cold_store:  { ir: 'small', wet: 0.28, tail: 'small', bed: ['amb.freezer'], absorb: 0.9 },
};
export const IR_FAMILIES = ['hall', 'room', 'small', 'stair', 'basement', 'outdoor'];

// transmission of a portal kind/state: loss dB, low-pass Hz
export const PORTAL = {
  open: [0, 20000], opening: [1, 16000], window_broken: [2, 14000], window: [16, 1100],
  door_open: [1, 15000], door_half: [5, 4500], door_closed: [19, 480], door_locked: [20, 450],
  roller_open: [0.5, 18000], roller_half: [5, 5000], roller_closed: [18, 450], wall: [34, 280],
};
const WALL_LOSS = 34, WALL_LP = 280;

function partsOf(z) { return z.parts.map((p) => ({ min: [p[0], p[1], p[2]], max: [p[3], p[4], p[5]] })); }

/**
 * Build the portal graph.
 * @param {object} W  generateWorld() result (zones, zoneIndex, zoneLookup, doors, openings, glass)
 * @param {(a,b)=>boolean} clear  true if nothing opaque lies between points a and b (ignoring doors)
 */
export function buildAcousticGraph(W, clear) {
  const zones = W.zones, nz = zones.length, zl = W.zoneLookup;
  const edges = [];   // { a, b, kind, door (index|-1), glass (id|null), x, y, z, area }
  const adj = Array.from({ length: nz }, () => []);
  const add = (e) => { e.i = edges.length; edges.push(e); adj[e.a].push(e.i); adj[e.b].push(e.i); return e; };
  const zIdx = (id) => W.zoneIndex.get(id);
  const doorRects = [];
  // doors
  W.doors.forEach((d, di) => {
    const zs = (d.zones ?? []).map(zIdx).filter((z) => z !== undefined);
    if (zs.length < 2) return;
    const m = (d.a + d.b) / 2, ax = d.axis === 'x';
    doorRects.push(d);
    add({ a: zs[0], b: zs[1], kind: 'door', door: di, roller: d.kind === 'roller', glass: null, x: ax ? m : d.at, y: (d.y0 + Math.min(d.y1, d.y0 + 2.2)) / 2, z: ax ? d.at : m, area: (d.b - d.a) * (d.y1 - d.y0) });
  });
  // openings + windows (non-door wall holes): zone on each side of the wall
  const seen = new Set();
  for (const o of W.openings ?? []) {
    if (o.kind === 'door') continue;
    const m = (o.a + o.b) / 2, ax = o.axis === 'x', y = (o.y0 + o.y1) / 2, off = (o.th ?? 0.3) / 2 + 0.35;
    const p1 = ax ? [m, y, o.at - off] : [o.at - off, y, m], p2 = ax ? [m, y, o.at + off] : [o.at + off, y, m];
    const z1 = zl.at(p1[0], p1[1], p1[2]), z2 = zl.at(p2[0], p2[1], p2[2]);
    if (z1 < 0 || z2 < 0 || z1 === z2) continue;
    let glass = null;
    if (o.kind === 'window') {
      const g = (W.glass ?? []).find((g) => g.min[1] >= o.y0 - 0.05 && g.max[1] <= o.y1 + 0.05
        && (ax ? g.min[0] >= o.a - 0.05 && g.max[0] <= o.b + 0.05 && Math.abs(g.min[2] - o.at) < 0.2
          : g.min[2] >= o.a - 0.05 && g.max[2] <= o.b + 0.05 && Math.abs(g.min[0] - o.at) < 0.2));
      glass = g ? g.id : null;
    }
    const key = `${Math.min(z1, z2)}-${Math.max(z1, z2)}-${o.kind}-${glass ? 'g' : ''}`;
    const area = (o.b - o.a) * (o.y1 - o.y0);
    if (seen.has(key)) { const e = edges.find((e) => e.key === key); if (e) e.area += area; continue; }
    seen.add(key);
    add({ a: z1, b: z2, kind: glass ? 'window' : 'opening', door: -1, glass, x: p1[0] / 2 + p2[0] / 2, y, z: p1[2] / 2 + p2[2] / 2, area, key });
  }
  // open adjacency between zones of the same space: touching parts, sight lines across the shared face
  const P = zones.map(partsOf);
  // samples inside door / window / opening rects are excluded: those holes are portals of their own (and glass
  // does not block sight rays, so windows would otherwise look like open space)
  const holes = [...doorRects, ...(W.openings ?? [])];
  const inDoor = (x, y, z) => holes.some((d) => {
    const ax = d.axis === 'x', u = ax ? x : z, w = ax ? z : x;
    return Math.abs(w - d.at) < 0.7 && u > d.a - 0.3 && u < d.b + 0.3 && y > d.y0 - 0.2 && y < d.y1 + 0.2;
  });
  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < nz; i++) for (let j = i + 1; j < nz; j++) {
    let best = null;
    for (const p of P[i]) for (const q of P[j]) {
      for (let k = 0; k < 3; k++) {
        // shared plane on axis k
        let plane = null;
        if (Math.abs(p.max[k] - q.min[k]) < 0.45) plane = (p.max[k] + q.min[k]) / 2;
        else if (Math.abs(q.max[k] - p.min[k]) < 0.45) plane = (q.max[k] + p.min[k]) / 2;
        if (plane === null) continue;
        const u = (k + 1) % 3, v = (k + 2) % 3;
        const u0 = Math.max(p.min[u], q.min[u]), u1 = Math.min(p.max[u], q.max[u]);
        const v0 = Math.max(p.min[v], q.min[v]), v1 = Math.min(p.max[v], q.max[v]);
        if (u1 - u0 < 0.5 || v1 - v0 < 0.5) continue;
        // sample a grid on the face; vertical axis samples at walkable heights first
        let open = 0, n = 0;
        const NU = 7, NV = 4;
        for (let a = 0; a < NU; a++) for (let b = 0; b < NV; b++) {
          const pu = u0 + (u1 - u0) * (a + 0.5) / NU, pv = v0 + (v1 - v0) * (b + 0.5) / NV;
          const c = [0, 0, 0]; c[k] = plane; c[u] = pu; c[v] = pv;
          if (inDoor(c[0], c[1], c[2])) continue;
          n++;
          A.x = c[0]; A.y = c[1]; A.z = c[2]; B.x = c[0]; B.y = c[1]; B.z = c[2];
          const ka = k === 0 ? 'x' : k === 1 ? 'y' : 'z';
          A[ka] = plane - 0.6; B[ka] = plane + 0.6;
          if (clear(A, B)) open++;
        }
        if (!n || open / n < 0.2) continue;
        const area = (u1 - u0) * (v1 - v0) * open / n;
        if (!best || area > best.area) {
          const c = [0, 0, 0]; c[k] = plane; c[u] = (u0 + u1) / 2; c[v] = (v0 + v1) / 2;
          if (k !== 1) c[1] = Math.min(c[1], Math.max(p.min[1], q.min[1]) + 1.5);
          best = { a: i, b: j, kind: 'open', door: -1, glass: null, x: c[0], y: c[1], z: c[2], area };
        }
      }
    }
    if (best) add(best);
  }
  return { zones, nz, edges, adj, zoneClass: zones.map((z) => z.acoustic ?? 'room_small') };
}

/** portal transmission [lossDb, lpHz] for an edge given door states / broken glass */
export function edgeTransmission(e, doorState, glassBroken) {
  if (e.kind === 'open') return PORTAL.open;
  if (e.kind === 'opening') return PORTAL.opening;
  if (e.kind === 'window') return glassBroken(e.glass) ? PORTAL.window_broken : PORTAL.window;
  const st = doorState(e.door);   // 'open' | 'half' | 'closed' | 'locked' | number t (0..1 open)
  const pre = e.roller ? 'roller_' : 'door_';
  if (typeof st === 'number') {
    if (st > 0.6) return PORTAL[pre + 'open'];
    if (st > 0.08) return PORTAL[pre + 'half'];
    return PORTAL[pre + 'closed'];
  }
  return PORTAL[pre + (st === 'locked' ? (e.roller ? 'closed' : 'locked') : st)] ?? PORTAL[pre + 'closed'];
}

/**
 * Solver state per listener zone (allocation-free after creation).
 * solve(listenerZone, lx,ly,lz, doorState, glassBroken) fills: loss[z], lp[z], dist[z] (m along portals),
 * first[z] (edge index of the first portal from the listener, -1 same zone), via[z] (last portal before z).
 */
export function createSolver(G) {
  const n = G.nz;
  const loss = new Float32Array(n), lp = new Float32Array(n), dist = new Float32Array(n);
  const first = new Int32Array(n), via = new Int32Array(n), done = new Uint8Array(n);
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
  const edgeLoss = new Float32Array(G.edges.length), edgeLp = new Float32Array(G.edges.length);
  const s = {
    loss, lp, dist, first, via, zone: -1, version: 0,
    edgeLoss, edgeLp,
    solve(L, lx, ly, lz, doorState, glassBroken) {
      for (let i = 0; i < G.edges.length; i++) { const t = edgeTransmission(G.edges[i], doorState, glassBroken); edgeLoss[i] = t[0]; edgeLp[i] = t[1]; }
      loss.fill(1e9); lp.fill(20000); dist.fill(0); first.fill(-1); via.fill(-1); done.fill(0);
      s.zone = L; s.version++;
      if (L < 0) { loss.fill(0); return s; }
      loss[L] = 0; px[L] = lx; py[L] = ly; pz[L] = lz;
      for (;;) {
        let u = -1, best = 1e9;
        for (let i = 0; i < n; i++) if (!done[i] && loss[i] < best) { best = loss[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        const list = G.adj[u];
        for (let k = 0; k < list.length; k++) {
          const ei = list[k], e = G.edges[ei], v = e.a === u ? e.b : e.a;
          if (done[v]) continue;
          const seg = Math.hypot(e.x - px[u], e.y - py[u], e.z - pz[u]);
          // portal loss + a little per metre of detour (sound leaking round corners loses energy)
          const nl = loss[u] + edgeLoss[ei] + (e.kind === 'open' ? 0 : 0.5) + seg * 0.04;
          if (nl < loss[v]) {
            loss[v] = nl; lp[v] = Math.min(lp[u], edgeLp[ei]); dist[v] = dist[u] + seg;
            first[v] = u === L ? ei : first[u]; via[v] = ei; px[v] = e.x; py[v] = e.y; pz[v] = e.z;
          }
        }
      }
      // zones without any portal path: through the walls
      for (let i = 0; i < n; i++) if (loss[i] >= 1e9) { loss[i] = WALL_LOSS + 6; lp[i] = WALL_LP; }
      return s;
    },
    /** how the sound of zone z leaves via its last portal: position of that portal (or null) */
    portal(z, out) {
      const ei = via[z];
      if (ei < 0) return null;
      const e = G.edges[ei]; out.x = e.x; out.y = e.y; out.z = e.z; return out;
    },
    firstPortal(z, out) {
      const ei = first[z];
      if (ei < 0) return null;
      const e = G.edges[ei]; out.x = e.x; out.y = e.y; out.z = e.z; return out;
    },
  };
  return s;
}

export { WALL_LOSS, WALL_LP };
