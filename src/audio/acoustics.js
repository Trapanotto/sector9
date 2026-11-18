// Acoustic model of the level: zones (with reverb type, floor surface, box geometry), portals between
// them (doors, openings, broken windows, roof holes), generated impulse responses per reverb type, and an
// image-source early-reflection renderer for gunshots. Pure data/DSP (no WebAudio).
import * as LAYOUT from '../world/layout.js';
import { makeRng, rr, Biquad, addMode, TAU, clamp } from './dsp.js';

// ------------------------------------------------------------------------------------ zones
export const ZONE_DEFS = {
  yard:     { ir: 'yard', floor: 'asphalt', outdoor: true },
  hall:     { ir: 'hall', floor: 'concrete' },
  under:    { ir: 'under', floor: 'concrete' },
  corridor: { ir: 'corridor', floor: 'concrete' },
  office:   { ir: 'room', floor: 'lino' },
  locker:   { ir: 'room', floor: 'lino' },
  storage:  { ir: 'room', floor: 'concrete' },
  control:  { ir: 'room', floor: 'lino' },
  bay:      { ir: 'bay', floor: 'concrete' },
};
// Reflection coefficients (pressure) of the main boundaries
const R_WALL = 0.82, R_FLOOR = 0.86, R_ROOF_METAL = 0.78, R_SLAB = 0.84, R_ROOM_WALL = 0.7;

/** Builds zones (boxes + reflectors) and portals from the level layout. Falls back gracefully. */
export function buildAcoustics(layout) {
  const regions = LAYOUT.REGIONS || [];
  const H = LAYOUT.H || { hall: 8, bay: 7, room: 3.2 };
  const DECK = LAYOUT.DECK || { min: [-23.6, -5.8], max: [-17, 2], y: 3.3 };
  const FOOT = LAYOUT.FOOTPRINT || { min: [-24, -18], max: [20, 16] };
  const zones = {};
  const heightOf = { hall: H.hall, bay: H.bay, corridor: H.room, office: H.room, locker: H.room, storage: H.room, control: H.room };
  for (const reg of regions) {
    if (!ZONE_DEFS[reg.name] || zones[reg.name]) continue;
    const h = reg.name === 'yard' ? 30 : heightOf[reg.name] ?? H.room;
    zones[reg.name] = { id: reg.name, ...ZONE_DEFS[reg.name], box: { x0: reg.min[0], x1: reg.max[0], z0: reg.min[1], z1: reg.max[1], y0: 0, y1: h } };
  }
  zones.under = { id: 'under', ...ZONE_DEFS.under, box: { x0: DECK.min[0], x1: DECK.max[0], z0: DECK.min[1], z1: DECK.max[1], y0: 0, y1: DECK.y - 0.12 } };
  if (!zones.yard) zones.yard = { id: 'yard', ...ZONE_DEFS.yard, box: { x0: -24, x1: 20, z0: 16, z1: 26, y0: 0, y1: 30 } };
  if (!zones.hall) zones.hall = { id: 'hall', ...ZONE_DEFS.hall, box: { x0: -23.6, x1: 7.8, z0: -5.8, z1: 15.6, y0: 0, y1: 8 } };
  const order = ['under', 'office', 'locker', 'storage', 'control', 'corridor', 'hall', 'bay'].filter((k) => zones[k]);

  // reflectors per zone: { axis 0|1|2, c, R, lp: 1|2|3 }
  for (const z of Object.values(zones)) {
    const b = z.box, refl = [];
    if (z.id === 'yard') {
      refl.push({ axis: 1, c: 0, R: 0.88, lp: 1 });                  // asphalt
      refl.push({ axis: 2, c: b.z0, R: 0.85, lp: 1 });               // factory facade
      refl.push({ axis: 2, c: b.z1, R: 0.45, lp: 2 });               // corrugated fence (low)
      refl.push({ axis: 0, c: b.x0, R: 0.35, lp: 2 }, { axis: 0, c: b.x1, R: 0.35, lp: 2 });
      // buildings across the street / neighbouring warehouses: long slap echoes
      refl.push({ axis: 2, c: b.z1 + 38, R: 0.6, lp: 3, far: true });
      refl.push({ axis: 0, c: b.x0 - 46, R: 0.45, lp: 3, far: true });
      refl.push({ axis: 0, c: b.x1 + 64, R: 0.35, lp: 3, far: true });
    } else {
      const small = z.ir === 'room' || z.ir === 'corridor' || z.ir === 'under';
      const wR = z.ir === 'room' && z.floor === 'lino' ? R_ROOM_WALL : R_WALL;
      refl.push({ axis: 1, c: b.y0, R: z.floor === 'lino' ? 0.8 : R_FLOOR, lp: 1 });
      refl.push({ axis: 1, c: b.y1, R: z.ir === 'hall' || z.ir === 'bay' ? R_ROOF_METAL : z.ir === 'under' ? 0.9 : R_SLAB, lp: 1 });
      refl.push({ axis: 0, c: b.x0, R: wR, lp: 1 }, { axis: 0, c: b.x1, R: wR, lp: 1 });
      refl.push({ axis: 2, c: b.z0, R: wR, lp: 1 }, { axis: 2, c: b.z1, R: wR, lp: 1 });
      z.secondOrder = small;
    }
    z.refl = refl;
  }

  function inBox(b, x, z, m = 0) { return x >= b.x0 - m && x <= b.x1 + m && z >= b.z0 - m && z <= b.z1 + m; }
  function zoneAt(x, y, z) {
    const u = zones.under.box;
    if (inBox(u, x, z, 0.05)) return y < DECK.y - 0.25 ? zones.under : zones.hall;
    for (const k of order) if (k !== 'under' && inBox(zones[k].box, x, z, 0.02)) return zones[k];
    const inside = x > FOOT.min[0] && x < FOOT.max[0] && z > FOOT.min[1] && z < FOOT.max[1];
    if (!inside) return zones.yard;
    // in a wall/doorway: nearest zone box
    let best = zones.hall, bd = Infinity;
    for (const k of order) {
      if (k === 'under') continue;
      const b = zones[k].box;
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1), d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = zones[k]; }
    }
    return best;
  }

  // portals
  const portals = [];
  const addPortal = (pos, za, zb, w, h, kind) => {
    if (!za || !zb || za === zb) return;
    portals.push({ x: pos[0], y: pos[1], z: pos[2], a: za.id, b: zb.id, area: w * h, kind });
  };
  const doors = layout?.doors || [];
  for (const d of doors) {
    if (d.nav === false && /dock/.test(d.name || '')) continue;   // closed by the trailer
    const [cx, cz] = d.center, off = 0.7, hy = Math.min(d.height || 2.2, 3) * 0.5;
    const pa = d.normal === 'z' ? [cx, cz - off] : [cx - off, cz], pb = d.normal === 'z' ? [cx, cz + off] : [cx + off, cz];
    addPortal([cx, hy, cz], zoneAt(pa[0], 1, pa[1]), zoneAt(pb[0], 1, pb[1]), d.width || 1.4, d.height || 2.2, 'door');
  }
  const windows = layout?.windows || [];
  for (const w of windows) {
    if (w.glass !== 'broken' && w.glass !== 'empty') continue;
    const cx = (w.min[0] + w.max[0]) / 2, cy = (w.min[1] + w.max[1]) / 2, cz = (w.min[2] + w.max[2]) / 2;
    const off = 0.7;
    const pa = w.normal === 'z' ? [cx, cz - off] : [cx - off, cz], pb = w.normal === 'z' ? [cx, cz + off] : [cx + off, cz];
    const wa = w.normal === 'z' ? w.max[0] - w.min[0] : w.max[2] - w.min[2];
    addPortal([cx, cy, cz], zoneAt(pa[0], 1, pa[1]), zoneAt(pb[0], 1, pb[1]), wa * 0.6, (w.max[1] - w.min[1]) * 0.6, 'window');
  }
  for (const h of layout?.roofHoles || []) {
    const cx = (h.min[0] + h.max[0]) / 2, cz = (h.min[2] + h.max[2]) / 2;
    addPortal([cx, h.min[1], cz], zoneAt(cx, 1, cz), zones.yard, h.max[0] - h.min[0], h.max[2] - h.min[2], 'roof');
  }
  const windowList = windows.filter((w) => w.glass === 'broken' || w.glass === 'empty').map((w) => ({
    x: (w.min[0] + w.max[0]) / 2, y: (w.min[1] + w.max[1]) / 2, z: (w.min[2] + w.max[2]) / 2, glass: w.glass,
  }));
  const adj = {};
  for (const id of Object.keys(zones)) adj[id] = [];
  for (const p of portals) { adj[p.a].push(p); adj[p.b].push(p); }
  // hop distance between zones (BFS)
  const hops = {};
  for (const s of Object.keys(zones)) {
    const dist = { [s]: 0 }, q = [s];
    while (q.length) { const c = q.shift(); for (const p of adj[c]) { const o = p.a === c ? p.b : p.a; if (dist[o] === undefined) { dist[o] = dist[c] + 1; q.push(o); } } }
    hops[s] = dist;
  }
  return { zones, zoneAt, portals, adj, hops, windows: windowList };
}

/** Floor surface at a position: zone floor plus metal deck/stair and debris patches. */
export function surfaceAt(ac, x, y, z, debrisSpots) {
  const zone = ac.zoneAt(x, y, z);
  if (zone.id === 'yard') {
    // gravel strips along the fences and around the container, asphalt elsewhere
    if (z > 24.6 || x < -22.5 || x > 18.5 || (x > -13.5 && x < -4.5 && z > 18.6 && z < 23)) return 'gravel';
    return 'asphalt';
  }
  for (const s of debrisSpots) { const dx = x - s[0], dz = z - s[1]; if (dx * dx + dz * dz < s[2] * s[2]) return 'debris'; }
  return zone.floor;
}

// ------------------------------------------------------------------------------------ impulse responses
export const IR_TYPES = {
  hall:     { len: 3.4, pre: 0.022, rt: [2.6, 2.8, 2.2, 1.3], erN: 16, erSpan: 0.09, mix: 0.07, rc: 3.6 },
  bay:      { len: 3.0, pre: 0.02, rt: [2.4, 2.5, 2.0, 1.25], erN: 16, erSpan: 0.08, mix: 0.06, rc: 3.6 },
  corridor: { len: 1.5, pre: 0.006, rt: [0.95, 0.95, 0.8, 0.5], erN: 18, erSpan: 0.03, mix: 0.025, rc: 1.7,
    flutter: { period: 0.0141, g: 0.62, n: 30 } },
  room:     { len: 0.95, pre: 0.003, rt: [0.5, 0.5, 0.42, 0.3], erN: 22, erSpan: 0.02, mix: 0.014, rc: 1.35,
    modes: [[38, 0.5], [49, 0.4], [76, 0.3], [98, 0.25], [119, 0.2]] },
  under:    { len: 1.3, pre: 0.004, rt: [0.8, 0.75, 0.6, 0.38], erN: 18, erSpan: 0.025, mix: 0.02, rc: 1.6,
    modes: [[52, 0.4], [104, 0.25]], ring: [[182, 0.2], [341, 0.16], [527, 0.12], [771, 0.08]] },
  yard:     { len: 2.0, pre: 0.012, rt: [0.55, 0.5, 0.4, 0.28], erN: 6, erSpan: 0.06, mix: 0.05, rc: 7,
    diffuse: 0.35, distant: [[0.16, 0.5], [0.27, 0.35], [0.41, 0.3], [0.62, 0.18], [0.95, 0.1], [1.3, 0.06]] },
};

// white excitation = flat response; slight warmth and wall/air absorption at the top
const BAND_W = [0.85, 1.0, 1, 0.7];
/** Generates a stereo IR {L, R} with energy normalised to 1 (per channel average). */
export function genIR(sr, type, seed = 1) {
  const it = genIRSteps(sr, type, seed);
  let s = it.next(); while (!s.done) s = it.next();
  return s.value;
}
/** Same as genIR, as a generator that yields between work chunks (~5-10 ms each) for idle-time rendering. */
export function* genIRSteps(sr, type, seed = 1) {
  const S = IR_TYPES[type]; const r = makeRng(seed * 7919 + type.length * 131);
  const n = Math.floor(S.len * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  const pre = Math.floor(S.pre * sr), mixS = S.mix;
  const edges = [250, 1000, 4000];
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch];
    // sparse-to-dense excitation (echo density grows ~t^2 until the mixing time)
    const ex = new Float32Array(n);
    const nMix = pre + Math.floor(mixS * sr);
    for (let i = pre; i < n; i++) {
      if (i < nMix) {
        const t = (i - pre) / sr, p = Math.max(0.02, (t / mixS) ** 2);
        if (r() < p) ex[i] = (r() * 2 - 1) / Math.sqrt(p);
      } else ex[i] = r() * 2 - 1;
    }
    yield;
    // 4 bands with their own decay (crossovers: 2nd-order HP/LP pairs)
    const band = new Float32Array(n);
    for (let bnd = 0; bnd < 4; bnd++) {
      const hp = bnd > 0 ? new Biquad(sr, 'highpass', edges[bnd - 1], 0.6) : null;
      const lp = bnd < 3 ? new Biquad(sr, 'lowpass', edges[bnd], 0.6) : null;
      for (let i = 0; i < n; i++) { let x = ex[i]; if (hp) x = hp.run(x); if (lp) x = lp.run(x); band[i] = x; }
      // band weights turn the white excitation into a pinkish spectrum with some high-frequency absorption
      const dec = Math.exp(-6.91 / S.rt[bnd] / sr), amp0 = (S.diffuse ?? 1) * BAND_W[bnd];
      let g = amp0;
      for (let i = pre; i < n; i++) { d[i] += band[i] * g; g *= dec; }
      yield;
    }
    // discrete early reflections
    for (let e = 0; e < S.erN; e++) {
      const t = S.pre + Math.pow(r(), 1.3) * S.erSpan, i0 = Math.floor(t * sr);
      const a = (1 - e / (S.erN + 2)) * rr(r, 0.4, 1) * (r() < 0.5 ? -1 : 1) * 2.2;
      for (let k = 0; k < 6 && i0 + k < n; k++) d[i0 + k] += a * [0.5, 1, 0.7, 0.35, 0.15, 0.05][k];
    }
    if (S.flutter) {
      const P = S.flutter; let g = 1;
      for (let k = 1; k <= P.n; k++) {
        g *= P.g; const i0 = pre + Math.floor((k * P.period + ch * 0.0004) * sr);
        for (let j = 0; j < 8 && i0 + j < n; j++) d[i0 + j] += g * 1.6 * Math.exp(-j / (1.5 + k * 0.4)) * (j % 2 ? -0.4 : 1);
      }
    }
    if (S.distant) {
      for (const [t, a] of S.distant) {
        const i0 = Math.floor((t + rr(r, -0.01, 0.01) + ch * 0.003) * sr), len = Math.floor((0.02 + t * 0.05) * sr);
        const lp = new Biquad(sr, 'lowpass', 1800 / (1 + t), 0.7);
        for (let j = 0; j < len && i0 + j < n; j++) d[i0 + j] += lp.run((r() * 2 - 1) * Math.exp(-j / (len * 0.25))) * a * 6;
      }
    }
    for (const [f, a] of S.modes || []) addMode(d, sr, S.pre, f * rr(r, 0.97, 1.03), S.rt[0] / 6.91 * 0.8, a * 0.05, 0.005, r() * TAU);
    for (const [f, a] of S.ring || []) addMode(d, sr, S.pre, f * rr(r, 0.98, 1.02), 0.35, a * 0.05, 0.002, r() * TAU);
    // fade the end
    const fo = Math.floor(0.15 * sr);
    for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
  }
  // normalise energy
  let e = 0; for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) e += out[ch][i] * out[ch][i];
  const g = 1 / Math.sqrt(e / 2 || 1);
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) out[ch][i] *= g;
  return { L: out[0], R: out[1], rc: S.rc };
}

// ------------------------------------------------------------------------------------ early reflections
const C = 343;
/**
 * Renders image-source early reflections of a shot into a stereo pair (absolute gains, 1 m reference),
 * time-aligned so that t=0 is the arrival of the direct sound.
 * fam: {full, lp1, lp2, lp3} blast family, src/lis: {x,y,z}, right/fwd: listener unit vectors, zone: acoustic zone.
 * trans: multiplier (cross-zone), maxLen seconds.
 */
export function renderER(sr, fam, src, lis, right, fwd, zone, trans = 1, maxLen = 1.1) {
  const d0 = Math.max(0.3, Math.hypot(src.x - lis.x, src.y - lis.y, src.z - lis.z));
  const taps = [];
  const S = [src.x, src.y, src.z];
  const imgs = [];
  for (let i = 0; i < zone.refl.length; i++) {
    const p = zone.refl[i];
    const I = S.slice(); I[p.axis] = 2 * p.c - S[p.axis];
    imgs.push({ I, R: p.R, lp: p.lp, far: p.far, i });
  }
  if (zone.secondOrder) {
    const first = imgs.slice();
    for (const a of first) for (let j = 0; j < zone.refl.length; j++) {
      if (j === a.i) continue;
      const p = zone.refl[j];
      const I = a.I.slice(); I[p.axis] = 2 * p.c - I[p.axis];
      imgs.push({ I, R: a.R * p.R, lp: 2, i: -1 });
    }
  }
  let maxDelay = 0;
  for (const im of imgs) {
    const dx = im.I[0] - lis.x, dy = im.I[1] - lis.y, dz = im.I[2] - lis.z;
    const d = Math.hypot(dx, dy, dz);
    const delay = (d - d0) / C;
    if (delay < 0.0005 || delay > maxLen - 0.2) continue;
    const g = im.R * trans / Math.max(d, 1);
    if (g < 0.004) continue;
    const pan = clamp((dx * right.x + dy * right.y + dz * right.z) / d, -1, 1);
    const front = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
    const th = (pan + 1) * Math.PI / 4;
    const shadow = front < 0 ? 1 + 0.3 * front : 1;   // the wearer's body shadows reflections from behind
    taps.push({ delay, gL: Math.cos(th) * g * shadow, gR: Math.sin(th) * g * shadow, buf: im.far ? fam.lp3 : im.lp >= 2 ? fam.lp2 : fam.lp1 });
    if (delay > maxDelay) maxDelay = delay;
  }
  if (!taps.length) return null;
  const n = Math.min(Math.floor(maxLen * sr), Math.floor((maxDelay + fam.full.length / sr) * sr) + 1);
  const L = new Float32Array(n), Rr = new Float32Array(n);
  for (const t of taps) {
    const off = Math.floor(t.delay * sr), b = t.buf, m = Math.min(b.length, n - off);
    for (let i = 0; i < m; i++) { const v = b[i]; L[off + i] += v * t.gL; Rr[off + i] += v * t.gR; }
  }
  const fo = Math.min(n, Math.floor(0.03 * sr));
  for (let i = 0; i < fo; i++) { const k = i / fo; L[n - 1 - i] *= k; Rr[n - 1 - i] *= k; }
  return { L, R: Rr, taps: taps.length };
}
