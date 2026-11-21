// Static props: typed instances (PROPS) and procedurally generated rack/raw boxes (RAW).
// Owner: A (world art). Positions are the gameplay truth (cover, sight lines); art swaps the visuals in place.
// Instance: { type, p: [x, y, z], r: quarter turns (0..3), id? }.
import { HALL } from './site.js';

const KY = -3.7;   // basement floor
const I = (type, x, z, r = 0, y = 0, id) => ({ type, p: [x, y, z], r, ...(id ? { id } : {}) });

// deterministic PRNG (mulberry32) so layout + bake are reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Selective pallet rack run along z: x0..x1 (≈1.1 deep), starting at z0, `bays` bays of `bayLen`.
 *  levels: beam heights (0 = floor positions). empty: Set of bay indexes left empty on ALL levels (gaps to see /
 *  pass through). Returns raw boxes tagged { group:'rack', rack:id }. */
export function rackRun(id, x0, x1, z0, bays, o = {}) {
  const bayLen = o.bayLen ?? 2.7, levels = o.levels ?? [0, 1.6, 3.2, 4.8, 6.4], topY = o.topY ?? 8.0;
  const fill = o.fill ?? 0.82, rnd = rng(o.seed ?? 1), empty = o.empty ?? new Set();
  const out = [];
  const B = (min, max, surf, extra) => out.push({ min, max, surf, group: 'rack', rack: id, ...extra });
  for (let k = 0; k <= bays; k++) {
    const z = z0 + k * bayLen;
    B([x0, 0, z - 0.05], [x0 + 0.08, topY, z + 0.05], 'rackBlue');
    B([x1 - 0.08, 0, z - 0.05], [x1, topY, z + 0.05], 'rackBlue');
  }
  for (let k = 0; k < bays; k++) {
    const za = z0 + k * bayLen + 0.05, zb = z0 + (k + 1) * bayLen - 0.05;
    for (let li = 0; li < levels.length; li++) {
      const ly = levels[li];
      if (ly > 0 && !(empty.has(k) && li === 1)) {   // empty bays: no first beam -> walk-through gap
        B([x0, ly - 0.12, za], [x0 + 0.06, ly, zb], 'rackOrange');
        B([x1 - 0.06, ly - 0.12, za], [x1, ly, zb], 'rackOrange');
      }
      if (empty.has(k)) continue;
      const next = li + 1 < levels.length ? levels[li + 1] - 0.12 : topY + 0.9;
      for (let s = 0; s < 3; s++) {
        if (rnd() > (li === 0 ? Math.min(1, fill + 0.08) : fill)) continue;
        const pz0 = za + 0.06 + s * 0.85, pz1 = pz0 + 0.8;
        B([x0 + 0.05, ly, pz0], [x1 - 0.05, ly + 0.144, pz1], 'wood');
        const h = Math.min(next - ly - 0.144 - 0.08, 0.6 + rnd() * 0.75);
        const surf = rnd() < 0.55 ? 'wrap' : 'cardboard';
        B([x0 + 0.08, ly + 0.144, pz0 + 0.03], [x1 - 0.08, ly + 0.144 + h, pz1 - 0.03], surf);
      }
    }
  }
  return out;
}

/** High-bay store block: dense multi-level storage, one load box per bay and level spanning the depth. */
function aklBlock(id, x0, x1, z0, bays, bayLen, levels, seed) {
  const out = [], rnd = rng(seed);
  const B = (min, max, surf) => out.push({ min, max, surf, group: 'akl', rack: id });
  for (let k = 0; k <= bays; k++) {
    const z = z0 + k * bayLen;
    B([x0, 0, z - 0.06], [x0 + 0.12, 11.6, z + 0.06], 'steel');
    B([x1 - 0.12, 0, z - 0.06], [x1, 11.6, z + 0.06], 'steel');
  }
  for (let k = 0; k < bays; k++) {
    const za = z0 + k * bayLen + 0.06, zb = z0 + (k + 1) * bayLen - 0.06;
    for (let l = 0; l < levels; l++) {
      const y = 0.3 + l * 1.02;
      if (rnd() < 0.08) continue;
      B([x0 + 0.12, y, za + 0.04], [x1 - 0.12, y + 0.8, zb - 0.04], rnd() < 0.7 ? 'plastic' : 'cardboard');
    }
  }
  return out;
}

function hallRacks() {
  const out = [];
  HALL.racks.forEach(([x0, x1], i) => {
    // a few deliberate gaps for sight lines / flanking routes (bay indexes)
    const gapsN = { 5: [4], 8: [2], 11: [6] }[i] ?? [];
    const gapsS = { 1: [5], 5: [4], 6: [4], 9: [1], 12: [3] }[i] ?? [];
    out.push(...rackRun(`r${i}n`, x0, x1, HALL.segN[0], HALL.bays, { seed: 100 + i, empty: new Set(gapsN) }));
    out.push(...rackRun(`r${i}s`, x0, x1, HALL.segS[0], HALL.bays, { seed: 200 + i, empty: new Set(gapsS) }));
  });
  return out;
}

function pipes() {
  // ceiling pipes in the basement tunnel and technical room (visual + bullet sparks; not walkable)
  return [
    { min: [14.1, -0.75, 46.75], max: [28.6, -0.55, 46.95], surf: 'steel', group: 'pipe' },
    { min: [14.1, -0.75, 47.05], max: [28.6, -0.6, 47.2], surf: 'red', group: 'pipe' },
    { min: [0.3, -0.75, 40.3], max: [12.25, -0.55, 40.5], surf: 'steel', group: 'pipe' },
  ];
}

export const RAW = [
  ...hallRacks(),
  ...aklBlock('akl_w', 84.1, 88.9, 0.4, 12, 2.75, 11, 301),
  ...aklBlock('akl_o', 90.5, 95.9, 0.4, 12, 2.75, 11, 302),
  ...pipes(),
];

export const PROPS = [
  // ---- Hof (yard) ----
  I('trailer', 5, 71.3, 0, 0, 'trailer_tor1'),
  I('truck', 19, 69.5, 2, 0, 'lkw_tor3'),
  I('container20', 40, 82, 1), I('container20', 40, 82, 1, 2.59), I('container40', 62, 92, 1),
  I('container20', 88, 85, 0),
  I('booth', 54, 104.5, 0, 0, 'pfoertner'),
  I('skip', 28, 80, 0), I('forklift', 14, 76, 2, 0, 'stapler_hof'),
  I('pallet_load', 32, 70), I('pallet_load', 33.4, 70), I('pallet_stack', 24.5, 74),
  I('pallet_cartons', 70, 70, 1), I('pallet_cartons', 70, 71.4, 1),
  I('car', 66, 104, 0), I('car', 70, 104, 0), I('car', 90, 100, 1),
  I('bollard', 1.5, 64.8), I('bollard', 8.5, 64.8), I('bollard', 15.5, 64.8), I('bollard', 22.5, 64.8),
  I('bollard', 74.5, 64.8), I('bollard', 85, 64.8),
  I('skip', -8, 30, 0), I('pallet_drums', -4, 50, 0), I('container40', 104, 20, 0),
  I('van', 77, -9, 1, 0, 'einsatzwagen'),
  I('pallet_stack', 60, -4), I('pallet_stack', 61.4, -4),

  // ---- Wareneingang ----
  ...[2, 3.3, 4.6].flatMap((x) => [44, 45, 46].map((z) => I('pallet_load', x, z))),
  ...[20, 21.3, 22.6].flatMap((x) => [42, 43].map((z) => I('pallet_cartons', x, z))),
  I('forklift', 16, 57, 1, 0, 'stapler_we'), I('pallet_jack', 8, 58.5), I('hand_truck', 26.5, 48),
  I('roll_cage', 26.6, 40), I('roll_cage', 26.6, 40.9), I('pallet_stack', 1.0, 62.5), I('pallet_stack', 1.0, 61.1),
  I('shelf', 0.35, 38, 3), I('shelf', 0.35, 39.1, 3),

  // ---- Packerei (gang packing area) ----
  I('packing_table', 6, 28), I('packing_table', 6, 31), I('packing_table', 12, 28),
  I('packing_table', 12, 31), I('packing_table', 18, 28),
  I('pallet_cartons', 3, 34.8), I('pallet_cartons', 4.4, 34.8), I('pallet_cartons', 22, 33.2),
  I('pallet_cartons', 23.4, 33.2), I('pallet_cartons', 24.8, 33.2),
  I('carton_pile', 16, 33.4, 0, 0, 'deckung_pack'), I('carton_pile', 9, 34.9),
  I('table', 8, 18), I('table', 4, 20), I('pallet_drums', 2, 14.3), I('shelf', 20, 12.6),
  I('roll_cage', 26.8, 26), I('roll_cage', 26.8, 26.9),

  // ---- Labor ----
  I('lab_table', 3, 3), I('lab_table', 3, 6), I('lab_table', 7, 9.5, 1),
  I('drum', 8.6, 1.2), I('drum', 8.6, 2.0), I('gas_bottles', 1.0, 10.4, 1), I('sheeting', 5, 8), I('fridge', 9.4, 6),
  // ---- Sozialraum ----
  I('table', 14, 5), I('chair', 13.2, 5), I('chair', 14.8, 5, 2), I('fridge', 21.4, 0.5), I('sofa', 18, 10.8, 2),
  I('tv', 18, 7.5), I('lockers', 11.2, 0.4),
  // ---- Lagerraum ----
  I('shelf', 23, 0.4), I('shelf', 24.2, 0.4), I('shelf', 25.4, 0.4), I('carton_pile', 24.5, 8),
  I('carton_pile', 23.4, 10.5, 1, 0, 'waffenkisten'),

  // ---- Mezzanine (y 4.5) ----
  I('cash_table', 4.5, 4.5, 0, 4.5, 'geldtisch'), I('safe', 0.6, 0.6, 0, 4.5), I('carton_pile', 7.6, 1.0, 0, 4.5),
  I('chair', 4.5, 5.4, 2, 4.5),
  I('desk', 11, 2, 0, 4.5), I('desk', 15, 2, 0, 4.5), I('chair', 11, 3, 2, 4.5), I('shelf', 17.4, 5, 1, 4.5),
  I('control_desk', 26.9, 4.5, 1, 4.5, 'leitpult'), I('server_rack', 19, 1, 0, 4.5), I('chair', 25.9, 4.5, 3, 4.5),
  I('mattress', 2, 14.5, 1, 4.5), I('mattress', 2, 17.8, 1, 4.5), I('mattress', 5.5, 22.6, 0, 4.5),
  I('sofa', 10, 23.1, 2, 4.5), I('tv', 10, 19.8, 0, 4.5), I('table', 6.5, 16, 0, 4.5),
  I('lockers', 21.5, 15, 1, 4.5), I('lockers', 21.5, 17, 1, 4.5), I('lockers', 21.5, 19, 1, 4.5),

  // ---- Basement ----
  I('boiler', 2, 42, 0, KY), I('boiler', 2, 44.5, 0, KY), I('pump', 6, 42, 0, KY), I('pump', 6, 44.2, 0, KY),
  I('el_cabinet', 11.9, 42, 1, KY), I('el_cabinet', 11.9, 44, 1, KY), I('server_rack', 1, 50.5, 0, KY),
  I('pallet_drums', 6, 50.6, 0, KY), I('mattress', 9, 49.5, 1, KY),

  // ---- Hall staging / cross aisles ----
  ...[34, 35.4, 40, 41.4, 46, 47.4].map((x) => I('pallet_load', x, 55)),
  I('forklift', 40, 62.5, 1, 0, 'stapler_halle'), I('pallet_jack', 52, 62.6),
  I('pallet_load', 45, 29.5), I('carton_pile', 60, 29.2), I('pallet_stack', 36, 3.5), I('pallet_stack', 64, 3.5),
  I('roll_cage', 70.5, 9), I('roll_cage', 70.5, 9.9),

  // ---- Automation zone ----
  I('charger', 73.1, 49.45, 0, 0, 'ladestation1'), I('charger', 75.0, 49.45),
  I('robot_base', 90, 41, 0, 0, 'roboter1'), I('pallet_cartons', 86.6, 44.2), I('pallet_cartons', 93.4, 44.2),
  I('pallet_load', 74, 55), I('pallet_load', 75.4, 55), I('pallet_load', 76.8, 55),
  I('roll_cage', 80, 52), I('roll_cage', 80.9, 52), I('bins', 84.5, 52.5),
  // cold store
  I('shelf', 88, 50.5), I('shelf', 89.1, 50.5), I('shelf', 90.2, 50.5), I('pallet_cartons', 94.5, 62.8),
  I('pallet_cartons', 94.5, 61.4), I('carton_pile', 91, 58),
];
