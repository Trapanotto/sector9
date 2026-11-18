// Pure layout data for the factory level. No DOM / WebGL here so it can be imported by Node self-tests.
// Coordinates: metres, Y up. yaw 0 looks toward -Z (north, deeper into the site).
//
// SITE "KESSLER STAHLGUSS" (x -24..44, z -52..37), three walkable levels + catwalks:
//
//  z=-52 ┌── REAR LOT (extraction) ──┬──────────── WAREHOUSE "LAGER 3" (h 10) ─────────────────────┐
//        │ trailer, containers,       │ racking rows (E-W aisles), sodium lamps,                    │
//        │ EXTRACTION x-23.4..-19.6   │ office platform y3.2 (NE) + stair                            │
//        │ rear gate (west)    [dock gate x0 z-46..-42] [door x0 z-38]                                │
//  z=-34 └─ fence (locked gate) ──────┴──[door x3]──────[gate x16..20]────────────[door x36 closed]──┘
//          RAIL SIDING (outdoor): track z-27.5, boxcars, flatcar, containers, covered walkway x2..5.6
//  z=-18 ┌──[dock+trailer]────[door x3]── MAIN BUILDING "WERK 1" ─────┬──[door]──[gate x30..34]── FOUNDRY ┐
//        │ BAY (h7): racks, forklift, B1 stair DOWN (NE corner)     ╞ gate z-13..-10    "WERK 2" (h11)   │
//        │ HALL (h8) + deck(y3.3) │ corridor │ control  / ARCHIVE  ╞ door y3.5 → west catwalk y3.5      │
//        │ steel stair (SE) up to │ GALLERY  │ stairwell (2 flights)│ bridge z4..5.4 → east platform     │
//        │ the GALLERY y3.5 that  │  (y3.5,  │ lockers  / OFFICE 2  │ pits, furnace, crane, molding line │
//        │ overlooks the hall     │  glass)  │ office   / CANTEEN   │ B2 stair DOWN (SE corner)          │
//  z=16  └──[door]──[loading door x-10..-6]─[door]────────[door]────┴── closed shutter + door ──────────┘
//          YARD (asphalt): container, van, parked trailer, gatehouse (x37..42, z23..28)
//  z=30  ═══ fence ═════════════════════════════════════════════[GATE x34..38]═══════
//          street: PLAYER SPAWN (36, 34)
//  BASEMENT y-4 (under the foundry): B1 shaft → long dark TUNNEL (x19.2..22.4) → flooded PUMP room →
//  passage → lit BOILER room → B2 shaft up into the foundry.
//
// groundHeight(x, z, refY): floors can be stacked. With refY it returns the highest floor at or below
// refY + STEP_TOL (stairs, landings, catwalks, basement); without it refY = 0, i.e. the ground floor.

export const WALL_T = 0.4;
export const H = {
  hall: 8.0, bay: 7.0, room: 3.2, slab: 0.3, up: 3.5, upTop: 7.0, foundry: 11.0, ware: 10.0,
  base: -4.0, baseTop: -0.4, catwalk: 3.5, wareDeck: 3.2,
};
export const STEP_TOL = 0.55;
export const DECK = { min: [-23.6, -5.8], max: [-17.0, 2.0], y: 3.3, rail: 4.4 };
export const STAIR = { x0: -23.6, x1: -22.4, zTop: 2.0, zBottom: 9.2 };
export const BOUNDS = { min: [-28, -6, -56], max: [48, 14, 37] };
export const GROUND = { min: [-28, -56], max: [48, 37] };   // visual ground grid
export const FOOTPRINT = { min: [-24, -18], max: [20, 16] }; // main building (kept for older consumers)
export const BUILDINGS = [
  { name: 'werk1', min: [-24, -18], max: [20, 16], roof: 7.0 },
  { name: 'werk2', min: [20, -18], max: [44, 16], roof: 11.0 },
  { name: 'lager', min: [0, -52], max: [44, -34], roof: 10.0 },
  { name: 'pforte', min: [37, 23], max: [42, 28], roof: 3.2 },
];
export const insideBuilding = (x, z) => BUILDINGS.some((b) => x > b.min[0] && x < b.max[0] && z > b.min[1] && z < b.max[1]);
// Irradiance-volume grid (bake): voxel size, extents (probes every 2 voxels). See bakeGIKernel.js.
export const GI_GRID = { x0: -27, x1: 46.6, y0: -4.9, y1: 11.9, z0: -54.6, z1: 36.6, s: 0.35, skyY: 11.5 };

export const PLAYER_SPAWN = { position: [36, 0, 34.0], yaw: 0 };
export const EXTRACTION = { min: [-23.4, 0, -45.6], max: [-19.6, 3, -40.4] };

// ---------------------------------------------------------------- floors (all levels)
// FLOORS: flat walkable rects above / below the ground floor. RAMPS: stairs (linear along an axis).
// HOLES: rects where the ground floor (y 0) does not exist (stair openings, casting pits).
export const FLOORS = [
  { name: 'deck', x0: -23.65, x1: -17.0, z0: -5.8, z1: 2.0, y: DECK.y },
  { name: 'upper-a', x0: 8.2, x1: 19.6, z0: -5.8, z1: -1.0, y: H.up },
  { name: 'upper-b', x0: 7.8, x1: 12.4, z0: -1.0, z1: 4.2, y: H.up },
  { name: 'upper-c', x0: 8.2, x1: 19.6, z0: 4.2, z1: 15.6, y: H.up },
  { name: 'hall-landing', x0: 6.6, x1: 8.2, z0: 13.1, z1: 15.5, y: H.up },
  { name: 'stair-landing', x0: 15.6, x1: 17.4, z0: -0.9, z1: 4.1, y: H.up / 2 },
  { name: 'archive-door', x0: 19.6, x1: 20.0, z0: -4.8, z1: -3.1, y: H.up },
  { name: 'catwalk-w', x0: 20.0, x1: 21.6, z0: -17.6, z1: 15.6, y: H.catwalk },
  { name: 'f1-landing', x0: 21.6, x1: 23.05, z0: -13.4, z1: -12.0, y: H.catwalk },
  { name: 'bridge', x0: 21.6, x1: 40.0, z0: 4.0, z1: 5.4, y: H.catwalk },
  { name: 'platform-e', x0: 40.0, x1: 43.6, z0: -2.0, z1: 8.0, y: H.catwalk },
  { name: 'ware-deck', x0: 35.4, x1: 43.6, z0: -51.6, z1: -45.0, y: H.wareDeck },
  { name: 'basement', x0: 12.6, x1: 42.2, z0: -17.6, z1: 15.6, y: H.base },
  { name: 'pit-1', x0: 25.0, x1: 29.0, z0: -12.0, z1: -8.0, y: -1.6 },
  { name: 'pit-2', x0: 33.0, x1: 37.0, z0: -12.0, z1: -8.0, y: -1.6 },
];
// axis: 'x' or 'z'; the ramp height runs linearly from y0 at a0 to y1 at a1 along the axis.
export const RAMPS = [
  { name: 'deck-stair', axis: 'z', a0: STAIR.zTop, a1: STAIR.zBottom, c0: STAIR.x0 - 0.05, c1: STAIR.x1 + 0.2, y0: DECK.y, y1: 0 },
  { name: 'hall-stair', axis: 'x', a0: 1.0, a1: 6.6, c0: 14.1, c1: 15.5, y0: 0, y1: H.up },
  { name: 'stair-a', axis: 'x', a0: 12.4, a1: 15.6, c0: -0.9, c1: 0.5, y0: 0, y1: H.up / 2 },
  { name: 'stair-b', axis: 'x', a0: 15.6, a1: 12.4, c0: 2.7, c1: 4.1, y0: H.up / 2, y1: H.up },
  { name: 'f1-stair', axis: 'z', a0: -12.0, a1: -6.4, c0: 21.65, c1: 23.05, y0: H.catwalk, y1: 0 },
  { name: 'f2-stair', axis: 'z', a0: -2.0, a1: -7.6, c0: 42.0, c1: 43.4, y0: H.catwalk, y1: 0 },
  { name: 'b1-stair', axis: 'x', a0: 12.6, a1: 19.2, c0: -17.5, c1: -16.1, y0: 0, y1: H.base },
  { name: 'b2-stair', axis: 'x', a0: 42.2, a1: 36.0, c0: 13.5, c1: 14.9, y0: 0, y1: H.base },
  { name: 'w1-stair', axis: 'z', a0: -40.0, a1: -45.0, c0: 35.4, c1: 36.8, y0: 0, y1: H.wareDeck },
];
export const HOLES = [
  { name: 'b1', x0: 12.6, x1: 19.6, z0: -17.6, z1: -16.0 },
  { name: 'b2', x0: 35.6, x1: 42.2, z0: 13.5, z1: 14.9 },
  { name: 'pit-1', x0: 25.0, x1: 29.0, z0: -12.0, z1: -8.0 },
  { name: 'pit-2', x0: 33.0, x1: 37.0, z0: -12.0, z1: -8.0 },
];
export const rampY = (r, x, z) => {
  const a = r.axis === 'x' ? x : z;
  const t = Math.min(1, Math.max(0, (a - r.a0) / (r.a1 - r.a0)));
  return r.y0 + (r.y1 - r.y0) * t;
};
const inRamp = (r, x, z, e = 0.02) => {
  const a = r.axis === 'x' ? x : z, c = r.axis === 'x' ? z : x;
  const lo = Math.min(r.a0, r.a1), hi = Math.max(r.a0, r.a1);
  return a >= lo - e && a <= hi + e && c >= r.c0 - e && c <= r.c1 + e;
};
const inRect = (f, x, z, e = 0.0) => x >= f.x0 - e && x <= f.x1 + e && z >= f.z0 - e && z <= f.z1 + e;
export const inHole = (x, z) => HOLES.some((h) => x > h.x0 + 0.001 && x < h.x1 - 0.001 && z > h.z0 + 0.001 && z < h.z1 - 0.001);

/**
 * Floor y at (x, z). refY (optional): the caller's current feet height. Returns the highest floor at or below
 * refY + STEP_TOL; if none, the lowest floor there. Without refY the ground floor (refY = 0) is assumed.
 */
export function groundHeight(x, z, refY = 0) {
  const lim = (Number.isFinite(refY) ? refY : 0) + STEP_TOL;
  let best = -Infinity, lowest = Infinity;
  const consider = (h) => { if (h <= lim && h > best) best = h; if (h < lowest) lowest = h; };
  if (!inHole(x, z)) consider(0);
  for (let i = 0; i < FLOORS.length; i++) { const f = FLOORS[i]; if (inRect(f, x, z, 0.001)) consider(f.y); }
  for (let i = 0; i < RAMPS.length; i++) { const r = RAMPS[i]; if (inRamp(r, x, z)) consider(rampY(r, x, z)); }
  if (best > -Infinity) return best;
  return lowest < Infinity ? lowest : 0;
}

// ---------------------------------------------------------------- nav regions
// Walkable areas used for nav-graph sampling: xz rect at floor level y (or a ramp). exclude: non-walkable rects.
// zone: render / acoustic zone the region belongs to (see ZONES).
export const REGIONS = [
  // outdoor (ground)
  { name: 'yard', min: [-23.8, 16.0], max: [43.8, 30.0], y: 0 },
  { name: 'street', min: [30.0, 30.2], max: [43.0, 36.5], y: 0 },
  { name: 'siding', min: [-23.8, -34.0], max: [43.8, -18.0], y: 0 },
  { name: 'rearlot', min: [-23.8, -52.0], max: [-0.0, -34.2], y: 0 },
  // main building, ground floor
  { name: 'hall', min: [-23.6, -5.8], max: [7.8, 15.6], y: 0,
    exclude: [[[-23.6, -5.8], [-16.6, 2.4]], [[-23.6, 2.0], [-22.0, 9.6]], [[0.9, 14.0], [6.6, 15.6]]] },
  { name: 'corridor', min: [8.2, -5.8], max: [10.6, 15.6], y: 0 },
  { name: 'office', min: [11.0, 10.2], max: [19.6, 15.6], y: 0 },
  { name: 'locker', min: [11.0, 4.6], max: [19.6, 9.8], y: 0 },
  { name: 'stairs', min: [11.0, -1.0], max: [12.4, 4.2], y: 0 },
  { name: 'stairs-gap', min: [12.4, 0.62], max: [15.5, 2.58], y: 0 },
  { name: 'stairs-east', min: [17.4, -1.0], max: [19.6, 4.2], y: 0 },
  { name: 'control', min: [11.0, -5.8], max: [19.6, -1.4], y: 0 },
  { name: 'bay', min: [-23.6, -17.6], max: [19.6, -6.2], y: 0, exclude: [[[12.5, -17.6], [19.6, -15.85]]] },
  { name: 'deck', min: [-23.6, -5.8], max: [-17.2, 1.8], y: DECK.y },
  { name: 'gatehouse', min: [37.3, 23.3], max: [41.7, 27.7], y: 0 },
  // upper storey
  { name: 'gallery', min: [8.2, -5.8], max: [10.6, 15.6], y: H.up },
  { name: 'hall-landing', min: [6.6, 13.1], max: [7.8, 15.5], y: H.up },
  { name: 'archive', min: [11.0, -5.8], max: [19.6, -1.4], y: H.up },
  { name: 'stairs-up', min: [11.0, -1.0], max: [12.4, 4.2], y: H.up },
  { name: 'stair-landing', min: [15.6, -0.9], max: [17.4, 4.1], y: H.up / 2 },
  { name: 'office2', min: [11.0, 4.6], max: [19.6, 9.8], y: H.up },
  { name: 'canteen', min: [11.0, 10.2], max: [19.6, 15.6], y: H.up },
  // foundry
  { name: 'foundry', min: [20.0, -17.6], max: [43.6, 15.6], y: 0,
    exclude: [[[24.7, -12.3], [29.3, -7.7]], [[32.7, -12.3], [37.3, -7.7]], [[35.4, 13.3], [42.2, 15.6]],
      [[21.55, -12.0], [23.1, -6.4]], [[41.9, -7.6], [43.6, -2.0]]] },
  { name: 'catwalk-w', min: [20.0, -17.6], max: [21.6, 15.6], y: H.catwalk },
  { name: 'f1-landing', min: [21.6, -13.4], max: [23.05, -12.0], y: H.catwalk },
  { name: 'bridge', min: [21.6, 4.0], max: [40.0, 5.4], y: H.catwalk },
  { name: 'platform-e', min: [40.0, -2.0], max: [43.6, 8.0], y: H.catwalk },
  // basement
  { name: 'tunnel', min: [19.2, -17.6], max: [22.4, 5.6], y: H.base },
  { name: 'pump', min: [22.8, -5.6], max: [30.0, 0.6], y: H.base },
  { name: 'passage', min: [27.0, 1.0], max: [28.4, 5.6], y: H.base },
  { name: 'boiler', min: [19.6, 6.0], max: [35.6, 15.2], y: H.base },
  // warehouse
  { name: 'warehouse', min: [0.4, -51.6], max: [43.6, -34.4], y: 0, exclude: [[[35.3, -45.0], [36.9, -40.0]]] },
  { name: 'ware-deck', min: [35.4, -51.6], max: [43.6, -45.0], y: H.wareDeck },
  // stairs (ramps): sampled along their centre line
  ...RAMPS.map((r, i) => ({ name: r.name, ramp: i, min: r.axis === 'x' ? [Math.min(r.a0, r.a1), r.c0] : [r.c0, Math.min(r.a0, r.a1)],
    max: r.axis === 'x' ? [Math.max(r.a0, r.a1), r.c1] : [r.c1, Math.max(r.a0, r.a1)], y: 'ramp' })),
];
export const EXTRA_NAV_NODES = [[-23.0, 0, 10.0], [-23.0, DECK.y, 1.2], [-21.0, DECK.y, 1.0]];

// ---------------------------------------------------------------- render / light / acoustic zones
// boxes: 3D boxes (min/max xyz). probe: reflection-probe capture point. fog: haze density multiplier.
// acoustic: reverb class for the audio module (yard|hall|bay|corridor|room|under).
export const ZONES = [
  { name: 'out', boxes: [{ min: [-60, -1, -80], max: [80, 60, 70] }], probe: [-4, 1.7, 22], fog: 0.75, acoustic: 'yard' },
  { name: 'hall', boxes: [{ min: [-23.6, 0, -5.8], max: [7.8, 8.0, 15.6] }], probe: [-5.0, 2.0, 6.5], fog: 1.5, acoustic: 'hall' },
  { name: 'bay', boxes: [{ min: [-23.6, 0, -17.6], max: [19.6, 7.0, -6.2] }], probe: [-4.0, 2.2, -11.6], fog: 1.4, acoustic: 'bay' },
  { name: 'corridor', boxes: [{ min: [8.2, 0, -5.8], max: [10.6, 3.2, 15.6] }], probe: [9.4, 1.6, 5.0], fog: 0.75, acoustic: 'corridor' },
  { name: 'office', boxes: [{ min: [11.0, 0, 10.2], max: [19.6, 3.2, 15.6] }], probe: [16.2, 1.6, 12.9], fog: 0.75, acoustic: 'room' },
  { name: 'locker', boxes: [{ min: [11.0, 0, 4.6], max: [19.6, 3.2, 9.8] }], probe: [16.6, 1.6, 8.2], fog: 0.75, acoustic: 'room' },
  { name: 'stairs', boxes: [{ min: [11.0, 0, -1.0], max: [19.6, 7.0, 4.2] }], probe: [14.0, 3.0, 1.6], fog: 0.9, acoustic: 'corridor' },
  { name: 'control', boxes: [{ min: [11.0, 0, -5.8], max: [19.6, 3.2, -1.4] }], probe: [15.0, 1.6, -3.6], fog: 0.75, acoustic: 'room' },
  { name: 'gallery', boxes: [{ min: [8.2, 3.5, -5.8], max: [10.6, 7.0, 15.6] }], probe: [9.4, 5.1, 5.0], fog: 0.8, acoustic: 'corridor' },
  { name: 'canteen', boxes: [{ min: [11.0, 3.5, 10.2], max: [19.6, 7.0, 15.6] }], probe: [15.3, 5.1, 12.9], fog: 0.75, acoustic: 'room' },
  { name: 'office2', boxes: [{ min: [11.0, 3.5, 4.6], max: [19.6, 7.0, 9.8] }], probe: [15.3, 5.1, 7.2], fog: 0.75, acoustic: 'room' },
  { name: 'archive', boxes: [{ min: [11.0, 3.5, -5.8], max: [19.6, 7.0, -1.4] }], probe: [15.3, 5.1, -3.6], fog: 0.8, acoustic: 'room' },
  { name: 'foundry', boxes: [{ min: [20.0, 0, -17.6], max: [43.6, 11.0, 15.6] }, { min: [25, -1.6, -12], max: [29, 0, -8] }, { min: [33, -1.6, -12], max: [37, 0, -8] }], probe: [31.0, 3.0, -1.0], fog: 1.6, acoustic: 'hall' },
  { name: 'tunnel', boxes: [{ min: [12.6, -4.0, -17.6], max: [19.2, 0.0, -16.0] }, { min: [19.2, -4.0, -17.6], max: [22.4, -0.4, 5.6] }],
    probe: [20.8, -2.4, -6.0], fog: 1.2, acoustic: 'corridor' },
  { name: 'pump', boxes: [{ min: [22.8, -4.0, -5.6], max: [30.0, -0.4, 0.6] }, { min: [27.0, -4.0, 0.6], max: [28.4, -0.4, 6.0] }],
    probe: [26.4, -2.4, -2.5], fog: 1.3, acoustic: 'under' },
  { name: 'boiler', boxes: [{ min: [19.6, -4.0, 6.0], max: [35.6, -0.4, 15.2] }, { min: [35.6, -4.0, 13.5], max: [42.2, 0.0, 14.9] }],
    probe: [27.6, -2.2, 10.6], fog: 1.3, acoustic: 'under' },
  { name: 'warehouse', boxes: [{ min: [0.4, 0, -51.6], max: [43.6, 10.0, -34.4] }], probe: [21.5, 3.0, -42.0], fog: 1.5, acoustic: 'bay' },
  { name: 'gatehouse', boxes: [{ min: [37.3, 0, 23.3], max: [41.7, 3.2, 27.7] }], probe: [39.5, 1.6, 25.5], fog: 0.75, acoustic: 'room' },
];
export function zoneIndexAt(x, y, z, margin = 0) {
  for (let i = ZONES.length - 1; i >= 1; i--) {
    for (const b of ZONES[i].boxes) {
      if (x >= b.min[0] - margin && x <= b.max[0] + margin && y >= b.min[1] - margin && y <= b.max[1] + margin &&
        z >= b.min[2] - margin && z <= b.max[2] + margin) return i;
    }
  }
  return 0;
}

// Floor material per position (visual only, ground level).
const LINO = [[11.0, 19.6, 10.2, 15.6], [11.0, 19.6, 4.6, 9.8], [11.0, 19.6, -5.8, -1.4], [37.3, 41.7, 23.3, 27.7]];
export function floorMatAt(x, z) {
  if (inHole(x, z)) return null;
  if (!insideBuilding(x, z)) return 'asphalt';
  if (LINO.some(([a, b, c, d]) => x > a && x < b && z > c && z < d)) return 'lino';
  return 'floor';
}

// ---------------------------------------------------------------- enemies
// type 'guard' holds position (may turn), 'patrol' walks the patrol loop. role: what the set-up is about
// (guard | patrol | overwatch | roamer | sleeper | talker | ambush | defender). asleep: does not look until
// woken (noise, damage, the player close by). startDelay: a patrol that only starts walking after n seconds.
const PI = Math.PI;
export const ENEMY_SPAWNS = [
  // -- yard (approach)
  { name: 'gate-sleeper', position: [40.9, 0, 25.0], yaw: 0.0, type: 'guard', role: 'sleeper', asleep: true },
  { name: 'yard-fire-a', position: [-2.4, 0, 18.4], yaw: -PI / 2, type: 'guard', role: 'talker' },
  { name: 'yard-fire-b', position: [-0.2, 0, 18.4], yaw: PI / 2, type: 'guard', role: 'talker' },
  { name: 'yard-crossing', position: [6.0, 0, 18.0], yaw: -PI / 2, type: 'patrol', role: 'patrol', startDelay: 25,
    patrol: [[6.0, 0, 18.0], [27.0, 0, 18.0], [27.0, 0, 16.8], [6.0, 0, 16.8]] },
  // -- production hall + gallery above it
  { name: 'deck', position: [-20.0, DECK.y, -2.5], yaw: -2.356, type: 'guard', role: 'overwatch' },
  { name: 'hall-patrol', position: [-4.2, 0, 6.8], yaw: PI / 2, type: 'patrol', role: 'patrol',
    patrol: [[-4.2, 0, 6.8], [-12.8, 0, 6.8], [-12.8, 0, -1.4], [-4.2, 0, -1.4]] },
  { name: 'hall-tank', position: [1.8, 0, -4.6], yaw: PI, type: 'guard', role: 'guard' },
  { name: 'gallery-overwatch', position: [9.0, H.up, 3.0], yaw: PI / 2, type: 'guard', role: 'overwatch' },
  // -- ground rooms
  { name: 'control-radio', position: [16.6, 0, -3.8], yaw: -PI / 2, type: 'guard', role: 'guard' },
  // -- upper storey
  { name: 'canteen-a', position: [13.8, H.up, 13.0], yaw: -PI / 2, type: 'guard', role: 'talker' },
  { name: 'canteen-b', position: [15.1, H.up, 13.0], yaw: PI / 2, type: 'guard', role: 'talker' },
  { name: 'archive-ambush', position: [18.0, H.up, -4.1], yaw: PI / 2, type: 'guard', role: 'ambush' },
  // -- bay
  { name: 'bay-patrol', position: [-8.0, 0, -13.6], yaw: -PI / 2, type: 'patrol', role: 'patrol',
    patrol: [[-15.0, 0, -13.6], [0.5, 0, -13.6], [0.5, 0, -7.0], [-15.0, 0, -7.0]] },
  { name: 'bay-racks', position: [15.0, 0, -9.0], yaw: PI / 2, type: 'guard', role: 'guard' },
  // -- basement
  { name: 'tunnel-roamer', position: [20.8, H.base, -12.0], yaw: PI, type: 'patrol', role: 'roamer',
    patrol: [[20.8, H.base, -14.5], [20.8, H.base, 10.6], [27.6, H.base, 10.6], [20.8, H.base, 10.6]] },
  { name: 'pump-ambush', position: [24.2, H.base, -3.6], yaw: PI / 2, type: 'guard', role: 'ambush' },
  { name: 'boiler-defender', position: [31.6, H.base, 8.0], yaw: -PI / 2, type: 'guard', role: 'defender' },
  // -- foundry
  { name: 'catwalk-overwatch', position: [20.8, H.catwalk, 9.0], yaw: -PI / 2, type: 'guard', role: 'overwatch' },
  { name: 'foundry-patrol', position: [23.6, 0, 12.8], yaw: -PI / 2, type: 'patrol', role: 'patrol',
    patrol: [[23.6, 0, 12.8], [37.6, 0, 12.8], [37.6, 0, -5.6], [23.6, 0, -5.6]] },
  { name: 'furnace-guard', position: [30.0, 0, -14.0], yaw: PI, type: 'guard', role: 'guard' },
  { name: 'platform-guard', position: [42.0, H.catwalk, 2.0], yaw: -PI / 2, type: 'guard', role: 'overwatch' },
  // -- rail siding
  { name: 'siding-roamer-a', position: [-4.0, 0, -23.6], yaw: -PI / 2, type: 'patrol', role: 'roamer',
    patrol: [[-4.0, 0, -23.6], [40.0, 0, -23.6], [40.0, 0, -31.6], [3.8, 0, -31.6], [3.8, 0, -23.6]] },
  { name: 'siding-roamer-b', position: [-5.4, 0, -24.4], yaw: -PI / 2, type: 'patrol', role: 'roamer',
    patrol: [[-5.4, 0, -24.4], [38.8, 0, -24.4], [38.8, 0, -32.0], [4.4, 0, -32.0], [4.4, 0, -24.4]] },
  // -- warehouse
  { name: 'ware-overwatch', position: [38.6, H.wareDeck, -46.2], yaw: PI / 2, type: 'guard', role: 'overwatch' },
  { name: 'ware-aisle', position: [8.0, 0, -45.9], yaw: -PI / 2, type: 'patrol', role: 'patrol',
    patrol: [[3.6, 0, -45.9], [33.8, 0, -45.9], [33.8, 0, -41.9], [3.6, 0, -41.9]] },
  // -- rear lot: defenders around the extraction
  { name: 'lot-defender-a', position: [-10.4, 0, -40.6], yaw: PI / 2, type: 'guard', role: 'defender' },
  { name: 'lot-defender-b', position: [-17.0, 0, -48.6], yaw: PI / 4, type: 'guard', role: 'defender' },
  { name: 'lot-defender-c', position: [-4.6, 0, -50.4], yaw: PI / 2, type: 'patrol', role: 'defender',
    patrol: [[-4.6, 0, -50.4], [-4.6, 0, -37.0]] },
];

// ---------------------------------------------------------------- lights
// state: 'on' steady, 'flicker' dying tube, 'dead' (dark, broken), 'weld' arc-welding bursts, 'emerg' dim red.
// hang: chain-hung (top = ceiling y the chains go up to). axis: tube direction. power / range override defaults.
const SODIUM = 0xffa24a, RED = 0xff2a12, WARM = 0xffe0b4, COOL = 0xcfe8ff;
export const FIXTURES = [
  // hall
  { pos: [0.0, 5.2, 10.5], len: 1.5, state: 'on', hang: true, top: H.hall },
  { pos: [-16.0, 5.2, 10.5], len: 1.5, state: 'flicker', hang: true, top: H.hall },
  { pos: [-9.0, 5.2, -0.5], len: 1.5, state: 'dead', hang: true, top: H.hall },
  { pos: [-1.0, 5.2, -0.5], len: 1.5, state: 'on', hang: true, top: H.hall },
  // corridor + ground rooms
  { pos: [9.4, 3.12, 1.5], len: 1.2, state: 'flicker', axis: 'z' },
  { pos: [9.4, 3.12, 10.0], len: 1.2, state: 'on', axis: 'z' },
  { pos: [9.4, 3.12, -3.8], len: 1.2, state: 'dead', axis: 'z' },
  { pos: [15.0, 3.12, 12.8], len: 1.2, state: 'on' },
  { pos: [15.5, 3.12, 7.2], len: 1.2, state: 'flicker' },
  { pos: [15.0, 3.12, -3.6], len: 1.2, state: 'on', tint: COOL },
  // stairwell (shaft up to the roof) + upper storey
  { pos: [18.4, 6.92, 1.6], len: 1.2, state: 'on', axis: 'z' },
  { pos: [9.4, 6.92, 11.6], len: 1.2, state: 'on', axis: 'z' },
  { pos: [9.4, 6.92, 3.0], len: 1.2, state: 'flicker', axis: 'z' },
  { pos: [9.4, 6.92, -3.0], len: 1.2, state: 'dead', axis: 'z' },
  { pos: [15.2, 6.92, 12.9], len: 1.2, state: 'on' },
  { pos: [15.2, 6.92, 7.2], len: 1.2, state: 'on', tint: WARM },
  { pos: [15.2, 6.92, -3.6], len: 1.2, state: 'flicker' },
  { pos: [12.6, 6.92, -3.6], len: 1.2, state: 'dead' },
  // bay
  { pos: [-2.0, 6.2, -12.0], len: 1.5, state: 'on', hang: true, top: H.bay },
  { pos: [10.0, 6.2, -12.0], len: 1.5, state: 'flicker', hang: true, top: H.bay },
  // foundry (high bay, chain-hung)
  { pos: [26.0, 7.6, -3.0], len: 1.5, state: 'on', hang: true, top: H.foundry, power: 46, range: 18 },
  { pos: [34.6, 2.6, -13.4], len: 0.6, state: 'weld', tint: COOL, power: 60, range: 12 },
  { pos: [31.0, 7.6, 10.0], len: 1.5, state: 'on', hang: true, top: H.foundry, power: 46, range: 18 },
  { pos: [38.0, 7.6, 10.0], len: 1.5, state: 'dead', hang: true, top: H.foundry },
  { pos: [24.0, 7.6, -14.0], len: 1.5, state: 'flicker', hang: true, top: H.foundry, power: 40, range: 16 },
  { pos: [40.0, 7.6, -4.0], len: 1.5, state: 'on', hang: true, top: H.foundry, power: 40, range: 16 },
  // basement: red emergency lights, one working light in the boiler room at the end of the tunnel
  { pos: [20.8, -0.5, -15.0], len: 0.6, state: 'emerg', axis: 'z', tint: RED, power: 4, range: 6 },
  { pos: [20.8, -0.5, -6.0], len: 0.6, state: 'emerg', axis: 'z', tint: RED, power: 3.5, range: 6 },
  { pos: [20.8, -0.5, 2.0], len: 0.6, state: 'dead', axis: 'z' },
  { pos: [26.4, -0.5, -2.5], len: 0.6, state: 'emerg', tint: RED, power: 3.5, range: 6 },
  { pos: [24.2, -0.52, 10.6], len: 1.2, state: 'on', tint: WARM, power: 16, range: 10 },
  { pos: [31.0, -0.52, 10.6], len: 1.2, state: 'flicker', tint: WARM, power: 14, range: 10 },
  { pos: [16.0, -0.5, -16.8], len: 0.6, state: 'emerg', tint: RED, power: 5, range: 6 },
  // warehouse: sodium high-bay lamps over the aisles
  { pos: [13.0, 7.4, -46.0], len: 1.5, state: 'on', hang: true, top: H.ware, tint: SODIUM, power: 48, range: 18 },
  { pos: [28.0, 7.4, -46.0], len: 1.5, state: 'flicker', hang: true, top: H.ware, tint: SODIUM, power: 48, range: 18 },
  { pos: [13.0, 7.4, -37.0], len: 1.5, state: 'on', hang: true, top: H.ware, tint: SODIUM, power: 48, range: 18 },
  { pos: [28.0, 7.4, -37.0], len: 1.5, state: 'dead', hang: true, top: H.ware },
  { pos: [40.0, 7.4, -40.0], len: 1.5, state: 'on', hang: true, top: H.ware, tint: SODIUM, power: 40, range: 16 },
  // gatehouse
  { pos: [39.5, 3.12, 25.5], len: 0.9, state: 'flicker' },
  // fire barrels (flickering glow, no fixture body)
  { pos: [-1.3, 1.15, 19.5], len: 0.3, state: 'fire', tint: 0xff7a2a, power: 9, range: 6 },
  { pos: [15.9, 1.15, -30.4], len: 0.3, state: 'fire', tint: 0xff7a2a, power: 9, range: 6 },
  { pos: [-16.1, 1.15, -44.1], len: 0.3, state: 'fire', tint: 0xff7a2a, power: 9, range: 6 },
];
// Shadow-casting work lamp (the only spot light).
export const WORK_LAMP = { pos: [-12.6, 2.3, -8.0], target: [-7.0, 0, -13.2] };
// Cheap fill lights faking daylight bounce near big openings.
export const BOUNCE_LIGHTS = [
  { pos: [-8.0, 2.0, 12.5], color: 0xb8c0c8, intensity: 6, distance: 15 },
  { pos: [-12.5, 1.0, 5.0], color: 0xc0c6cc, intensity: 3.5, distance: 10 },
];
// Set pieces handled by level.js at run time.
export const EVENTS = [
  { kind: 'radio', pos: [15.4, 1.0, -2.8], every: [7, 13], range: 20 },
  { kind: 'radio', pos: [38.4, 1.0, 26.6], every: [9, 16], range: 16 },
  { kind: 'phone', pos: [13.8, H.up + 0.9, 8.6], every: [5, 6], range: 22, burst: 9 },
];
// Water surfaces (visual): flooded basement sections.
export const WATER = [
  { min: [22.8, -5.6], max: [30.0, 0.6], y: H.base + 0.22 },
  { min: [19.2, -9.0], max: [22.4, -3.0], y: H.base + 0.08 },
];

// ---------------------------------------------------------------- build solids
/**
 * Solid record: { min:[x,y,z], max:[x,y,z], mat: key|faceMap, collide, ray, surface, kind, visual, skip }
 * collide: becomes a THREE.Box3 collider. ray: gets an invisible raycast proxy box.
 * visual: drawn as a textured box by the level builder (false = a custom prop mesh draws it).
 * Door record: { name, width, height, y (floor), center:[x,z], normal, nav, a, axis, t0, t1, leaf, swing, state }
 *   state: 'open' (static leaf), 'closed' / 'ajar' (opens when someone comes close or shoots it), 'wind' (swinging).
 */
export function buildLayout() {
  const solids = [];
  const doors = [];
  const windows = [];
  const props = [];
  const portals = [];   // explicit horizontal openings between zones { min, max } (stair shafts)

  const solid = (min, max, o = {}) => {
    if (max[0] - min[0] < 1e-3 || max[1] - min[1] < 1e-3 || max[2] - min[2] < 1e-3) return null;
    const s = {
      min, max, mat: o.mat ?? 'ceiling', collide: o.collide ?? true, ray: o.ray ?? true,
      surface: o.surface ?? 'concrete', kind: o.kind ?? 'wall', visual: o.visual ?? true, cover: o.cover ?? false,
    };
    if (o.skip) s.skip = o.skip;
    solids.push(s);
    return s;
  };

  // Wall along axis ('x' = runs along x, thickness in z; 'z' = runs along z, thickness in x).
  // mats: { pos, neg, edge } = face material on +thickness side, -thickness side, ends/top/reveals.
  // Openings: { a:[s,e], y:[b,t], name, nav, leaf, swing, state, shutter, glass, door } — an opening whose bottom
  // is at the wall base (or flagged door:true) is a doorway with its floor at y[0], anything else a window.
  function wall(axis, a0, a1, t0, t1, y0, y1, openings, mats, wo = {}) {
    const faces = axis === 'x'
      ? { pz: mats.pos, nz: mats.neg, px: mats.edge, nx: mats.edge, py: mats.edge, ny: mats.edge }
      : { px: mats.pos, nx: mats.neg, pz: mats.edge, nz: mats.edge, py: mats.edge, ny: mats.edge };
    const box = (s, e, b, t, collide) => {
      if (axis === 'x') return solid([s, b, t0], [e, t, t1], { mat: faces, collide, surface: wo.surface, kind: wo.kind });
      return solid([t0, b, s], [t1, t, e], { mat: faces, collide, surface: wo.surface, kind: wo.kind });
    };
    const ops = [...(openings || [])].sort((p, q) => p.a[0] - q.a[0]);
    let cur = a0;
    const tm = (t0 + t1) / 2;
    for (const op of ops) {
      if (op.a[0] > cur) box(cur, op.a[0], y0, y1, true);
      const oy = op.h !== undefined ? [y0, y0 + op.h] : op.y;   // door(): height above the wall base
      const b = Math.max(oy[0], y0), t = Math.min(oy[1], y1);
      if (b > y0 + 1e-3) box(op.a[0], op.a[1], y0, b, true);           // sill / below opening
      if (t < y1 - 1e-3) box(op.a[0], op.a[1], t, y1, false);          // header: never blocks movement
      const am = (op.a[0] + op.a[1]) / 2;
      if (b <= y0 + 1e-3 || op.door) {
        doors.push({
          name: op.name || '', width: op.a[1] - op.a[0], height: t - b, y: b,
          center: axis === 'x' ? [am, tm] : [tm, am], normal: axis === 'x' ? 'z' : 'x', nav: op.nav !== false,
          a: op.a, axis, t0, t1, leaf: op.leaf, swing: op.swing, shutter: op.shutter, state: op.state || (op.leaf ? 'open' : null),
        });
      } else {
        windows.push({
          min: axis === 'x' ? [op.a[0], b, t0] : [t0, b, op.a[0]],
          max: axis === 'x' ? [op.a[1], t, t1] : [t1, t, op.a[1]],
          normal: axis === 'x' ? 'z' : 'x', glass: op.glass || 'broken',
        });
      }
      cur = Math.max(cur, op.a[1]);
    }
    if (cur < a1) box(cur, a1, y0, y1, true);
  }

  const EXT_S = { pos: 'brick', neg: 'brickIn', edge: 'ceiling' };       // outer side +, inner side -
  const EXT_N = { pos: 'brickIn', neg: 'brick', edge: 'ceiling' };       // outer side -, inner side +
  const CONC = { pos: 'ceiling', neg: 'ceiling', edge: 'ceiling' };
  const door = (s, w = 1.4, h = 2.2, extra = {}) => ({ a: [s, s + w], h, ...extra });
  const doorUp = (s, floor, w = 1.3, h = 2.2, extra = {}) => ({ a: [s, s + w], y: [floor, floor + h], door: true, ...extra });
  const win = (s, e, b, t, glass = 'broken') => ({ a: [s, e], y: [b, t], glass });

  // rail(): thin collider along an axis-aligned line (+ visual railing unless visual === false).
  const rail = (from, to, y, yLo = y, o = {}) => {
    const [ax, az] = from, [bx, bz] = to, th = 0.05;
    const top = Math.max(y, o.slope ? Math.max(o.slope[0], o.slope[1]) : y) + 1.1;
    if (Math.abs(ax - bx) < 1e-6) solid([ax - th, yLo, Math.min(az, bz)], [ax + th, top, Math.max(az, bz)], { collide: true, ray: false, visual: false, kind: 'rail' });
    else solid([Math.min(ax, bx), yLo, az - th], [Math.max(ax, bx), top, az + th], { collide: true, ray: false, visual: false, kind: 'rail' });
    if (o.visual !== false) props.push({ type: 'railing', from, to, y, ...(o.slope ? { slope: o.slope } : {}), key: o.key });
  };

  // flight(): stair geometry for RAMPS[name] — treads (steel: open grating treads; concrete: solid steps),
  // colliders under the flight where it is too low to walk under, and the side rails.
  function flight(name, o = {}) {
    const r = RAMPS.find((q) => q.name === name);
    const n = Math.max(4, Math.round(Math.abs(r.y1 - r.y0) / 0.175));
    const base = Math.min(r.y0, r.y1);
    const steel = o.kind !== 'concrete';
    const T = steel ? { py: 'plate', ny: 'steel', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' }
      : { py: 'floor', ny: 'ceiling', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' };
    const box3 = (a0, a1, y0, y1, c0, c1, opt) => (r.axis === 'x' ? solid([a0, y0, c0], [a1, y1, c1], opt) : solid([c0, y0, a0], [c1, y1, a1], opt));
    for (let i = 0; i < n; i++) {
      const s0 = r.a0 + (r.a1 - r.a0) * i / n, s1 = r.a0 + (r.a1 - r.a0) * (i + 1) / n;
      const top = r.y0 + (r.y1 - r.y0) * (i + 0.5) / n;
      const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      const bottom = steel ? top - 0.045 : (o.solidTo ?? base);
      box3(lo, hi, Math.max(bottom, base - 0.4), top, r.c0 + (steel ? 0.06 : 0), r.c1 - (steel ? 0.06 : 0),
        { mat: T, collide: false, ray: i % 2 === 0, surface: steel ? 'metal' : 'concrete', kind: 'floor' });
    }
    if (steel) props.push({ type: 'stringer', ramp: name });
    // blocked space under the flight (the treads themselves are not colliders: the ramp carries the feet)
    if (o.under !== false) {
      const L = Math.abs(r.a1 - r.a0), m = Math.max(2, Math.ceil(L / 0.8));
      for (let i = 0; i < m; i++) {
        const s0 = r.a0 + (r.a1 - r.a0) * i / m, s1 = r.a0 + (r.a1 - r.a0) * (i + 1) / m;
        const low = Math.min(rampY(r, r.axis === 'x' ? s0 : r.c0, r.axis === 'x' ? r.c0 : s0), rampY(r, r.axis === 'x' ? s1 : r.c0, r.axis === 'x' ? r.c0 : s1));
        // capped at 0.9 m above the floor below: enough to stop walkers underneath, never in the band of a
        // walker on the flight itself (nav and player test colliders from feet + 0.35 m)
        const top = Math.min(low - 0.35, base + 0.9);
        if (low - 0.35 < base + 0.25) continue;
        box3(Math.min(s0, s1), Math.max(s0, s1), base, top, r.c0 + 0.02, r.c1 - 0.02, { collide: true, ray: false, visual: false, kind: 'under' });
      }
    }
    const yTop = Math.max(r.y0, r.y1);
    const aLo = Math.min(r.a0, r.a1), aHi = Math.max(r.a0, r.a1);
    const yAt = (a) => r.y0 + (r.y1 - r.y0) * (a - r.a0) / (r.a1 - r.a0);
    for (const side of o.rails || []) {
      const c = side === 'lo' ? r.c0 - 0.05 : r.c1 + 0.05;
      const A = r.axis === 'x' ? [aLo, c] : [c, aLo], B = r.axis === 'x' ? [aHi, c] : [c, aHi];
      rail(A, B, yAt(aLo), o.railBase ?? base, { slope: [yAt(aLo), yAt(aHi)] });
      void yTop;
    }
  }

  // ================================================================ MAIN BUILDING (Werk 1)
  // South wall (z 15.6..16), outer face +z. Hall part tall, room block part two storeys.
  wall('x', -24, 8.2, 15.6, 16, 0, H.hall + 0.4, [
    door(-20, 1.4, 2.2, { name: 'hall-south-door', leaf: 'left', swing: -1 }),
    { a: [-10, -6], y: [0, 4.2], name: 'loading-door', shutter: true },
    win(-23, -21, 5, 7), win(-16.5, -13.5, 5, 7, 'cracked'), win(-4.5, -1.5, 5, 7), win(2, 5, 5, 7, 'empty'),
  ], EXT_S);
  wall('x', 8.2, 20, 15.6, 16, 0, H.up, [
    door(8.6, 1.6, 2.2, { name: 'corridor-south-door' }),
    win(12, 14.5, 1.0, 2.3, 'cracked'),
    door(16, 1.4, 2.2, { name: 'office-south-door', leaf: 'right', swing: -1 }),
  ], { pos: 'brick', neg: 'wallOffice', edge: 'ceiling' });
  wall('x', 8.2, 20, 15.6, 16, H.up, H.upTop + 0.4, [
    win(8.6, 10.2, 4.4, 6.0, 'cracked'), win(12, 14.5, 4.4, 5.9, 'broken'), win(16.2, 18.6, 4.4, 5.9, 'cracked'),
  ], { pos: 'brick', neg: 'wallOffice', edge: 'ceiling' });
  // North wall (z -18..-17.6), outer face -z.
  wall('x', -24, 20, -18, -17.6, 0, H.bay + 0.4, [
    { a: [-18.9, -16.1], y: [0, 4.0], name: 'dock-door', nav: false },
    door(3.0, 1.6, 2.4, { name: 'bay-north-door' }),
    win(-10, -6, 4.5, 6), win(-1, 2, 4.5, 6, 'cracked'), win(8, 11, 4.5, 6),
  ], EXT_N);
  // West (x -24..-23.6), outer face -x.
  wall('z', -17.6, -6.2, -24, -23.6, 0, H.bay + 0.4, [win(-15, -12, 4.5, 6), win(-10, -7.5, 4.5, 6, 'empty')], EXT_N);
  wall('z', -6.2, 15.6, -24, -23.6, 0, H.hall + 0.4, [win(-4.5, -1.5, 5, 7), win(4, 7, 5, 7, 'cracked'), win(10, 13, 5, 7)], EXT_N);
  // East: shared with the foundry (x 19.6..20). Bay part with the drive-through, room block two storeys.
  wall('z', -17.6, -6.2, 19.6, 20, 0, H.bay + 0.4, [
    { a: [-13, -10], y: [0, 4.2], name: 'bay-foundry-gate' }, win(-16.2, -14.2, 4.5, 6),
  ], { pos: 'brickIn', neg: 'brickIn', edge: 'ceiling' });
  wall('z', -6.2, 15.6, 19.6, 20, 0, H.up, [
    win(-5.0, -2.6, 1.0, 2.3, 'broken'), door(1.0, 1.4, 2.2, { name: 'stairs-foundry-door', leaf: 'left', swing: 1 }), win(12, 14.5, 1.0, 2.3, 'empty'),
  ], { pos: 'brickIn', neg: 'wallOffice', edge: 'ceiling' });
  wall('z', -6.2, 15.6, 19.6, 20, H.up, H.upTop + 0.4, [
    doorUp(-4.6, H.up, 1.3, 2.2, { name: 'archive-catwalk-door', leaf: 'right', swing: -1, state: 'closed' }),
    win(5.5, 8.5, 4.4, 5.8, 'broken'), win(11, 14, 4.4, 5.8, 'cracked'),
  ], { pos: 'brickIn', neg: 'wallOffice', edge: 'ceiling' });
  solid([19.6, H.bay + 0.4, -18], [20, H.foundry + 0.4, -6.2], { mat: { px: 'brickIn', nx: 'brick', pz: 'ceiling', nz: 'ceiling', py: 'ceiling', ny: 'ceiling' }, collide: false });
  solid([19.6, H.upTop + 0.4, -6.2], [20, H.foundry + 0.4, 16], { mat: { px: 'brickIn', nx: 'brick', pz: 'ceiling', nz: 'ceiling', py: 'ceiling', ny: 'ceiling' }, collide: false });

  // ---- interior walls
  // Hall / bay separator (z -6.2..-5.8), +z side = hall.
  wall('x', -23.6, 7.8, -6.2, -5.8, 0, H.hall + 0.1, [
    door(-13, 1.4, 2.3, { name: 'hall-bay-door', leaf: 'right', swing: 1 }),
    { a: [-6, -2], y: [0, 4.5], name: 'hall-bay-opening' },
  ], { pos: 'brickIn', neg: 'brickIn', edge: 'ceiling' });
  // Room block / bay: ground floor with doors, upper floor with windows overlooking the bay.
  wall('x', 7.8, 19.6, -6.2, -5.8, 0, H.room, [
    door(8.6, 1.6, 2.2, { name: 'corridor-bay-door' }),
    door(15, 1.4, 2.2, { name: 'control-bay-door', leaf: 'left', swing: 1 }),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  wall('x', 7.8, 19.6, -6.2, -5.8, H.room, H.bay + 0.1, [
    win(8.6, 10.2, 4.4, 5.9, 'cracked'), win(12.0, 14.6, 4.4, 5.9, 'intact'), win(15.6, 18.2, 4.4, 5.9, 'cracked'),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  // Hall / corridor (x 7.8..8.2), +x side = corridor. Upper part: the glass gallery overlooking the hall.
  wall('z', -5.8, 15.6, 7.8, 8.2, 0, H.room, [
    door(12, 1.4, 2.2, { name: 'hall-corridor-n' }),
    door(3, 1.4, 2.2, { name: 'hall-corridor-m', leaf: 'left', swing: -1 }),
    door(-4, 1.4, 2.2, { name: 'hall-corridor-s' }),
    win(6, 9, 1.1, 2.3, 'broken'), win(-1, 1.5, 1.1, 2.3, 'cracked'),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  wall('z', -5.8, 15.6, 7.8, 8.2, H.room, H.hall + 0.1, [
    win(-5.2, -2.0, 4.3, 6.4, 'intact'), win(-1.2, 2.0, 4.3, 6.4, 'cracked'), win(2.8, 6.0, 4.3, 6.4, 'intact'),
    win(6.8, 10.0, 4.3, 6.4, 'intact'), win(10.8, 13.0, 4.3, 6.4, 'broken'),
    doorUp(13.7, H.up, 1.4, 2.2, { name: 'gallery-hall-door' }),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  // Corridor / rooms (x 10.6..11), ground floor.
  wall('z', -5.8, 15.6, 10.6, 11.0, 0, H.room, [
    door(12.5, 1.4, 2.2, { name: 'office-door', leaf: 'right', swing: 1, state: 'closed' }),
    door(7.0, 1.4, 2.2, { name: 'locker-door' }),
    door(1.0, 1.4, 2.2, { name: 'stairs-door', leaf: 'right', swing: 1 }),
    door(-4.0, 1.4, 2.2, { name: 'control-door' }),
  ], { pos: 'wallOffice', neg: 'wall', edge: 'ceiling' });
  // Gallery / upper rooms (x 10.6..11), upper floor: doors + supervisor windows.
  wall('z', -5.8, 15.6, 10.6, 11.0, H.up, H.upTop, [
    doorUp(-3.6, H.up, 1.3, 2.2, { name: 'archive-door', leaf: 'left', swing: 1, state: 'closed' }),
    doorUp(0.2, H.up, 1.3, 2.2, { name: 'stairs-up-door' }),
    win(4.9, 6.3, 4.4, 5.8, 'intact'), doorUp(6.6, H.up, 1.3, 2.2, { name: 'office2-door', leaf: 'right', swing: 1, state: 'ajar' }), win(8.2, 9.5, 4.4, 5.8, 'intact'),
    doorUp(12.0, H.up, 1.3, 2.2, { name: 'canteen-door', leaf: 'right', swing: 1, state: 'closed' }), win(13.8, 15.2, 4.4, 5.8, 'cracked'),
  ], { pos: 'wallOffice', neg: 'wall', edge: 'ceiling' });
  // Room separators (x 11..19.6), ground floor + upper floor.
  wall('x', 11.0, 19.6, 9.8, 10.2, 0, H.room, [door(17, 1.4, 2.2, { name: 'office-locker' })], { pos: 'wallOffice', neg: 'wallOffice', edge: 'ceiling' });
  wall('x', 11.0, 19.6, 4.2, 4.6, 0, H.room, [], { pos: 'wallOffice', neg: 'ceiling', edge: 'ceiling' });
  wall('x', 11.0, 19.6, -1.4, -1.0, 0, H.room, [door(17.9, 1.3, 2.2, { name: 'stairs-control' })], { pos: 'ceiling', neg: 'wallOffice', edge: 'ceiling' });
  wall('x', 11.0, 19.6, 9.8, 10.2, H.up, H.upTop, [doorUp(16.8, H.up, 1.3, 2.2, { name: 'canteen-office2' })], { pos: 'wallOffice', neg: 'wallOffice', edge: 'ceiling' });
  wall('x', 11.0, 19.6, 4.2, 4.6, H.room, H.upTop, [doorUp(11.05, H.up, 1.25, 2.2, { name: 'stairs-office2' })], { pos: 'wallOffice', neg: 'ceiling', edge: 'ceiling' });
  wall('x', 11.0, 19.6, -1.4, -1.0, H.room, H.upTop, [doorUp(11.05, H.up, 1.25, 2.2, { name: 'stairs-archive' })], { pos: 'ceiling', neg: 'wallOffice', edge: 'ceiling' });

  // ---- mezzanine deck (hall NW corner) with stair along the west wall
  solid([-17.2, 0, -5.8], [-17.0, DECK.y - 0.05, 2.0], { mat: 'ceiling', collide: false });
  solid([-22.2, 0, 1.8], [-17.2, DECK.y - 0.05, 2.0], { mat: 'ceiling', collide: false });
  solid([-22.4, 0, 1.8], [-22.2, DECK.y - 0.05, STAIR.zBottom], { mat: 'ceiling', collide: false });
  solid([-17.2, 0, -5.8], [-17.0, DECK.rail, 2.0], { collide: true, ray: false, visual: false, kind: 'rail' });
  solid([-22.4, 0, 1.8], [-17.0, DECK.rail, 2.0], { collide: true, ray: false, visual: false, kind: 'rail' });
  solid([-22.4, 0, 1.8], [-22.2, DECK.rail, STAIR.zBottom], { collide: true, ray: false, visual: false, kind: 'rail' });
  solid([-23.6, DECK.y - 0.12, -5.8], [-17.0, DECK.y, 2.0],
    { mat: { py: 'plate', ny: 'steel', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' }, collide: false, surface: 'metal', kind: 'floor' });
  {
    const n = 16, run = STAIR.zBottom - STAIR.zTop;
    for (let i = 0; i < n; i++) {
      const z0 = STAIR.zTop + (run * i) / n, z1 = STAIR.zTop + (run * (i + 1)) / n;
      const top = DECK.y * (1 - (i + 0.5) / n);
      solid([STAIR.x0, 0, z0], [STAIR.x1, top, z1],
        { mat: { py: 'plate', pz: 'steel', nz: 'steel', px: 'steel', nx: 'steel', ny: 'steel' }, collide: false, ray: i % 2 === 0, surface: 'metal', kind: 'floor' });
    }
  }
  props.push({ type: 'railing', from: [-17.1, -5.8], to: [-17.1, 2.0], y: DECK.y });
  props.push({ type: 'railing', from: [-22.3, 1.9], to: [-17.1, 1.9], y: DECK.y });
  props.push({ type: 'railing', from: [-22.3, 1.9], to: [-22.3, STAIR.zBottom], y: 0, slope: [DECK.y, 0] });

  // ---- steel stair in the hall (SE corner) up to the gallery door, landing at y 3.5
  flight('hall-stair', { rails: ['lo'] });
  solid([6.6, H.up - 0.12, 13.1], [7.8, H.up, 15.5], { mat: { py: 'plate', ny: 'steel', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' }, collide: false, surface: 'metal', kind: 'floor' });
  rail([6.6, 13.05], [7.8, 13.05], H.up);
  rail([6.55, 13.05], [6.55, 14.05], H.up);
  for (const [x, z] of [[6.7, 13.2], [7.65, 13.2]]) solid([x - 0.06, 0, z - 0.06], [x + 0.06, H.up - 0.12, z + 0.06], { mat: 'steel', surface: 'metal', kind: 'post' });

  // ---- room block: upper floor slab (gallery concrete, rooms lino) with the stairwell void
  const SLAB = (top) => ({ py: top, ny: 'ceiling', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' });
  solid([8.2, H.room, -5.8], [10.8, H.up, 15.6], { mat: SLAB('floor'), collide: false, kind: 'floor' });
  solid([10.8, H.room, -5.8], [19.6, H.up, -1.0], { mat: SLAB('lino'), collide: false, kind: 'floor' });
  solid([10.8, H.room, -1.0], [12.4, H.up, 4.2], { mat: SLAB('floor'), collide: false, kind: 'floor' });
  solid([10.8, H.room, 4.2], [19.6, H.up, 15.6], { mat: SLAB('lino'), collide: false, kind: 'floor' });
  solid([7.8, H.room, 13.7], [8.2, H.up, 15.1], { mat: SLAB('plate'), collide: false, kind: 'floor', surface: 'metal' });
  solid([19.6, H.room, -4.6], [20.0, H.up, -3.3], { mat: SLAB('plate'), collide: false, kind: 'floor', surface: 'metal' });
  // roof over the two-storey block
  solid([7.8, H.upTop, -6.2], [19.6, H.upTop + 0.3, 16], { mat: { ny: 'ceiling', py: 'concreteOut', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' }, collide: false, kind: 'roof' });
  // ---- stairwell (former storage): two concrete flights with a half landing; void up to the roof
  flight('stair-a', { kind: 'concrete', solidTo: 0, under: false, rails: ['hi'] });
  flight('stair-b', { kind: 'concrete', solidTo: 0, rails: ['lo'], railBase: 0 });
  solid([15.6, 0, -0.9], [17.4, H.up / 2, 4.1], { mat: { py: 'floor', ny: 'ceiling', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' }, collide: false, kind: 'floor' });
  solid([15.6, 0, -0.9], [17.4, H.up / 2 - 0.3, 4.1], { collide: true, ray: false, visual: false, kind: 'under', cover: true });
  rail([15.55, 0.5], [15.55, 2.7], H.up / 2, 0);
  rail([12.45, -1.0], [12.45, 2.7], H.up);

  // ---- roofs / ceilings (ray only)
  const rectMinusHoles = (x0, x1, z0, z1, holes) => {
    const xs = [x0, x1, ...holes.flatMap((h) => [h[0], h[1]])].filter((v) => v >= x0 && v <= x1).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i], b = xs[i + 1];
      if (b - a < 1e-3) continue;
      const cut = holes.filter((h) => h[0] <= a + 1e-6 && h[1] >= b - 1e-6).map((h) => [h[2], h[3]]).sort((p, q) => p[0] - q[0]);
      let c = z0;
      for (const [s, e] of cut) { if (s > c) out.push([a, b, c, s]); c = Math.max(c, e); }
      if (c < z1) out.push([a, b, c, z1]);
    }
    return out;
  };
  const ROOF = { ny: 'corrugated', py: 'corrugatedOut', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' };
  const HALL_HOLES = [[-14, -11, 4, 7], [-3, -1, -3, -1]];
  const BAY_HOLES = [[-10, -6, -14, -10], [6, 10, -13, -10]];
  const FOUNDRY_HOLES = [[27, 31, -6, -3], [33, 37, 6, 9]];
  const WARE_HOLES = [[10, 13, -46, -43], [28, 31, -42, -39]];
  for (const r of rectMinusHoles(-23.6, 7.8, -5.8, 15.6, HALL_HOLES)) solid([r[0], H.hall, r[2]], [r[1], H.hall + 0.1, r[3]], { mat: ROOF, collide: false, surface: 'metal', kind: 'roof' });
  for (const r of rectMinusHoles(-23.6, 19.6, -17.6, -6.2, BAY_HOLES)) solid([r[0], H.bay, r[2]], [r[1], H.bay + 0.1, r[3]], { mat: ROOF, collide: false, surface: 'metal', kind: 'roof' });
  for (const r of rectMinusHoles(20.0, 43.6, -17.6, 15.6, FOUNDRY_HOLES)) solid([r[0], H.foundry, r[2]], [r[1], H.foundry + 0.1, r[3]], { mat: ROOF, collide: false, surface: 'metal', kind: 'roof' });
  for (const r of rectMinusHoles(0.4, 43.6, -51.6, -34.4, WARE_HOLES)) solid([r[0], H.ware, r[2]], [r[1], H.ware + 0.1, r[3]], { mat: ROOF, collide: false, surface: 'metal', kind: 'roof' });
  const roofHoles = [
    ...HALL_HOLES.map((h) => ({ min: [h[0], H.hall, h[2]], max: [h[1], H.hall + 0.1, h[3]] })),
    ...BAY_HOLES.map((h) => ({ min: [h[0], H.bay, h[2]], max: [h[1], H.bay + 0.1, h[3]] })),
    ...FOUNDRY_HOLES.map((h) => ({ min: [h[0], H.foundry, h[2]], max: [h[1], H.foundry + 0.1, h[3]] })),
    ...WARE_HOLES.map((h) => ({ min: [h[0], H.ware, h[2]], max: [h[1], H.ware + 0.1, h[3]] })),
  ];

  // ---- props with colliders
  const P = (type, min, max, o = {}) => {
    const s = solid(min, max, { mat: o.mat ?? 'wood', collide: true, ray: o.ray ?? true, surface: o.surface ?? 'wood', kind: 'prop', visual: o.visual ?? false, cover: (max[1] - min[1]) >= 0.85 });
    props.push({ type, min, max, ...o });
    return s;
  };
  const crate = (x, z, s = 1.0, h = s, y = 0, rot = 0) => P('crate', [x - s / 2, y, z - s / 2], [x + s / 2, y + h, z + s / 2], { rot });
  const LOAD_H = { cement: 0.54, boxes: 0.9 };
  const pallets = (x, z, n, load, y = 0) => P('pallets', [x - 0.6, y, z - 0.4], [x + 0.6, y + n * 0.144 + (LOAD_H[load] || 0), z + 0.4], { n, load });
  const barrel = (x, z, y = 0) => P('barrel', [x - 0.3, y, z - 0.3], [x + 0.3, y + 0.9, z + 0.3], { surface: 'metal' });
  const group = (type, min, max, o = {}) => P(type, min, max, { surface: 'metal', ...o });

  // Hall
  for (const x of [-14.5, -6.5, 1.5]) for (const z of [0.5, 8.0]) {
    solid([x - 0.3, 0, z - 0.3], [x + 0.3, H.hall, z + 0.3], { mat: 'ceiling', kind: 'pillar', cover: true });
  }
  P('conveyor', [-13, 0, 11.6], [0, 0.95, 12.6], { surface: 'metal' });
  P('press', [-11, 0, 2], [-7.5, 3.6, 5.5], { surface: 'metal' });
  P('mill', [-3.0, 0, 3.0], [-0.5, 1.9, 5.0], { surface: 'metal' });
  P('tank', [3.1, 0, -3.9], [5.9, 5.0, -1.1], { surface: 'metal' });
  P('cabinets', [-21.0, 0, 11.0], [-18.5, 2.0, 11.8], { surface: 'metal' });
  P('workbench', [-5.8, 0, 14.5], [-3.4, 0.95, 15.4], { surface: 'wood' });
  P('generator', [2.6, 0, 10.4], [5.0, 1.6, 12.0], { surface: 'metal' });
  crate(-17.2, 6.0, 1.2); crate(-16.0, 6.1, 1.0); crate(-17.0, 6.0, 0.9, 0.9, 1.2); crate(-17.0, 7.3, 1.0);
  crate(2.8, 8.8, 1.2); crate(3.9, 9.4, 0.8); crate(2.9, 8.8, 0.8, 0.8, 1.2);
  crate(-4.2, -3.6, 1.0); crate(-5.3, -3.4, 1.2);
  crate(7.0, 14.6, 1.0); crate(7.2, 13.6, 0.8);
  crate(-21.8, 14.6, 1.2); crate(-20.6, 14.7, 0.9);
  pallets(-9.5, -3.4, 5); pallets(6.6, 5.5, 3); pallets(-15.6, 14.4, 7); pallets(-20.5, 5.0, 2, 'cement');
  group('gasbottles', [5.5, 0, 14.95], [6.05, 0.6, 15.5]);
  barrel(-1.6, 9.0); barrel(-1.0, 9.6); barrel(-2.2, 9.6); barrel(6.9, -4.9); barrel(6.2, -5.0);
  barrel(-15.9, -4.8); barrel(-16.0, -4.1); barrel(-20.8, 12.6);
  // Corridor
  P('vending', [8.25, 0, 9.4], [8.95, 1.9, 10.4], { surface: 'metal' });
  group('wetsign', [10.12, 0, 4.85], [10.48, 0.65, 5.2], { surface: 'wood' });
  // Office
  P('desk', [13.2, 0, 11.2], [14.8, 0.76, 12.0], { surface: 'wood' });
  P('desk', [13.2, 0, 14.2], [14.8, 0.76, 15.0], { surface: 'wood' });
  P('filing', [18.9, 0, 10.6], [19.5, 1.3, 12.2], { surface: 'metal' });
  P('shelf', [17.6, 0, 15.0], [19.4, 2.0, 15.5], { surface: 'metal', facing: -1 });
  group('chair', [13.75, 0, 10.45], [14.3, 0.95, 10.95], { facing: 1 });
  group('chair', [13.75, 0, 15.05], [14.3, 0.95, 15.55], { facing: -1 });
  // Lockers
  P('lockers', [19.0, 0, 5.0], [19.55, 1.95, 9.4], { surface: 'metal', facing: -1 });
  P('lockers', [13.8, 0, 6.0], [14.35, 1.95, 9.2], { surface: 'metal', facing: 1 });
  P('bench', [15.4, 0, 6.6], [17.4, 0.45, 7.0], { surface: 'wood' });
  // Stairwell: junk in the alcove between the flights, east strip towards the foundry
  group('plasticcrates', [14.6, 0, 0.75], [15.15, 0.78, 1.25], { surface: 'wood' });
  crate(13.2, 2.2, 0.7); pallets(18.6, 3.4, 4);
  // Control room
  P('console', [11.4, 0, -5.6], [14.6, 1.1, -4.9], { surface: 'metal' });
  P('console', [16.8, 0, -5.6], [19.4, 1.1, -4.9], { surface: 'metal' });
  P('table', [14.2, 0, -3.2], [16.0, 0.76, -2.4], { surface: 'wood' });
  // Upper storey: canteen, office 2, archive, gallery
  const U = H.up;
  P('table', [13.2, U, 11.2], [15.6, U + 0.76, 12.2], { surface: 'wood', canteen: true });
  P('table', [13.2, U, 13.8], [15.6, U + 0.76, 14.8], { surface: 'wood', canteen: true });
  P('table', [16.6, U, 12.4], [18.4, U + 0.76, 13.4], { surface: 'wood', canteen: true });
  P('counter', [18.7, U, 10.4], [19.55, U + 0.95, 15.4], { surface: 'metal' });
  P('vending', [11.05, U, 10.4], [11.75, U + 1.9, 11.4], { surface: 'metal', facing: 1 });
  P('desk', [13.0, U, 5.4], [14.6, U + 0.76, 6.2], { surface: 'wood' });
  P('desk', [16.2, U, 8.4], [17.8, U + 0.76, 9.2], { surface: 'wood' });
  P('filing', [18.9, U, 5.0], [19.5, U + 1.3, 6.6], { surface: 'metal' });
  P('shelf', [11.2, U, 9.25], [13.0, U + 2.0, 9.75], { surface: 'metal', facing: -1 });
  group('chair', [13.55, U, 6.25], [14.1, U + 0.95, 6.75], { facing: 1 });
  P('shelf', [11.4, U, -5.6], [17.0, U + 2.4, -5.0], { surface: 'metal', metal: true, archive: true });
  P('shelf', [13.0, U, -3.4], [18.4, U + 2.4, -2.8], { surface: 'metal', metal: true, archive: true });
  P('filing', [18.9, U, -2.8], [19.5, U + 1.3, -1.6], { surface: 'metal' });
  group('plasticcrates', [17.6, U, -1.95], [18.15, U + 0.78, -1.45], { surface: 'wood' });
  barrel(9.0, 15.1, U); crate(10.2, -5.35, 0.6, 0.6, U);
  // Bay
  P('rack', [-2.0, 0, -16.8], [2.4, 4.2, -15.7], { surface: 'metal' });
  P('rack', [5.0, 0, -16.8], [10.4, 4.2, -15.7], { surface: 'metal' });
  P('rack', [10.0, 0, -12.2], [18.0, 4.2, -11.1], { surface: 'metal' });
  P('forklift', [-8.75, 0, -12.0], [-7.45, 2.2, -9.4], { surface: 'metal' });
  P('container', [2.0, 0, -10.5], [8.1, 2.6, -8.1], { surface: 'metal', key: 'paintBlue' });
  crate(-13.0, -9.0, 1.2); crate(-11.8, -9.2, 1.0); crate(-12.9, -9.0, 0.9, 0.9, 1.2);
  crate(-21.5, -8.4, 1.2); crate(-21.3, -9.7, 1.0);
  crate(-2.0, -12.5, 1.0); crate(-1.0, -12.3, 0.8);
  pallets(-20.8, -11.4, 4); pallets(-4.0, -8.0, 3, 'boxes');
  barrel(18.6, -7.2); barrel(18.6, -7.9); barrel(-14.5, -16.6); barrel(-13.9, -16.9);
  group('handtruck', [19.0, 0, -15.4], [19.55, 1.4, -14.8]);
  group('drumlying', [18.7, 0, -8.6], [19.55, 0.6, -8.0]);
  group('utility', [4.8, 0, -17.55], [5.9, 1.15, -17.1]);
  // B1: stair down to the basement in the bay's NE corner (opening railed off on the south side)
  flight('b1-stair', { kind: 'concrete', solidTo: H.base - 0.4, under: false });
  rail([12.6, -15.95], [19.6, -15.95], 0);
  // Dock door: trailer parked outside (closes the opening)
  P('trailer', [-18.95, 0, -30.0], [-16.05, 4.0, -18.05], { surface: 'metal' });

  // ================================================================ FOUNDRY (Werk 2), x 20..44
  wall('x', 20, 44, -18, -17.6, 0, H.foundry + 0.4, [
    door(24.0, 1.4, 2.2, { name: 'foundry-north-door', leaf: 'left', swing: -1, state: 'closed' }),
    { a: [30, 34], y: [0, 4.5], name: 'foundry-north-gate', shutter: true },
    win(26, 29, 6, 8.5), win(36, 40, 6, 8.5, 'cracked'),
  ], EXT_N);
  wall('x', 20, 44, 15.6, 16, 0, H.foundry + 0.4, [win(21, 24.6, 6, 8.5), win(31, 35, 6, 8.5, 'cracked'), win(38, 42, 6, 8.5)], EXT_S);
  wall('z', -17.6, 15.6, 43.6, 44, 0, H.foundry + 0.4, [win(-12, -8, 6, 8.5), win(0, 4, 6, 8.5), win(10, 13, 6, 8.5, 'empty')],
    { pos: 'brick', neg: 'brickIn', edge: 'ceiling' });
  props.push({ type: 'shutterclosed', axis: 'x', a: [26, 30], t: 16.0, s: 1, h: 4.4 });
  props.push({ type: 'doorclosed', axis: 'x', a: [35.6, 36.8], t: 16.0, s: 1 });
  // west catwalk (y 3.5) from the archive door, F1 stair down at the north end, bridge to the east platform, F2 down
  const GR = { py: 'plate', ny: 'steel', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' };
  const deck = (x0, x1, z0, z1, y) => solid([x0, y - 0.1, z0], [x1, y, z1], { mat: GR, collide: false, surface: 'metal', kind: 'floor' });
  const C = H.catwalk;
  deck(20.0, 21.6, -17.6, 15.6, C); deck(21.6, 23.05, -13.4, -12.0, C);
  deck(21.6, 40.0, 4.0, 5.4, C); deck(40.0, 43.6, -2.0, 8.0, C);
  rail([21.62, -17.6], [21.62, -13.4], C); rail([21.62, -6.4], [21.62, 4.0], C); rail([21.62, 5.4], [21.62, 15.6], C);
  rail([21.6, -13.45], [23.05, -13.45], C); rail([23.1, -13.4], [23.1, -12.0], C);
  rail([21.6, 3.95], [40.0, 3.95], C); rail([21.6, 5.45], [40.0, 5.45], C);
  rail([39.95, -2.0], [39.95, 3.95], C); rail([39.95, 5.45], [39.95, 8.0], C); rail([40.0, 8.05], [43.6, 8.05], C);
  rail([40.0, -2.05], [41.95, -2.05], C);
  flight('f1-stair', { rails: ['hi', 'lo'], railBase: 0 });
  flight('f2-stair', { rails: ['lo'], railBase: 0 });
  for (let z = -15.6; z < 15.6; z += 4.0) solid([21.42, 0, z - 0.07], [21.56, C - 0.1, z + 0.07], { mat: 'steel', surface: 'metal', kind: 'post' });
  for (let x = 25.0; x < 40; x += 5.0) for (const z of [4.1, 5.3]) solid([x - 0.07, 0, z - 0.07], [x + 0.07, C - 0.1, z + 0.07], { mat: 'steel', surface: 'metal', kind: 'post' });
  for (const [x, z] of [[40.15, -1.85], [43.45, -1.85], [40.15, 7.85], [43.45, 7.85], [40.15, 3.0]]) solid([x - 0.07, 0, z - 0.07], [x + 0.07, C - 0.1, z + 0.07], { mat: 'steel', surface: 'metal', kind: 'post' });
  // casting pits (railed), furnace, molding line, machines, crane (visual)
  for (const [x0, z0] of [[25, -12], [33, -12]]) {
    const x1 = x0 + 4, z1 = z0 + 4;
    rail([x0 - 0.15, z0 - 0.15], [x1 + 0.15, z0 - 0.15], 0); rail([x0 - 0.15, z1 + 0.15], [x1 + 0.15, z1 + 0.15], 0);
    rail([x0 - 0.15, z0 - 0.15], [x0 - 0.15, z1 + 0.15], 0); rail([x1 + 0.15, z0 - 0.15], [x1 + 0.15, z1 + 0.15], 0);
    props.push({ type: 'pit', min: [x0, -1.6, z0], max: [x1, 0, z1] });
  }
  P('furnace', [36.4, 0, -16.8], [40.6, 9.0, -12.6], { surface: 'metal' });
  P('ladle', [31.2, 0, -16.6], [33.4, 1.9, -14.4], { surface: 'metal' });
  P('conveyor', [24.0, 0, 0.0], [36.0, 0.95, 1.0], { surface: 'metal' });
  P('press', [24.4, 0, 8.4], [27.9, 3.6, 11.9], { surface: 'metal' });
  P('mill', [31.0, 0, 7.6], [33.5, 1.9, 9.6], { surface: 'metal' });
  P('tank', [38.6, 0, 8.6], [41.4, 5.0, 11.4], { surface: 'metal', pipeTo: [43.6, 15.6] });
  P('generator', [40.4, 0, -11.6], [42.8, 1.6, -10.0], { surface: 'metal' });
  P('workbench', [28.0, 0, 14.5], [30.4, 0.95, 15.4], { surface: 'wood' });
  P('cabinets', [33.0, 0, 14.8], [35.4, 2.0, 15.55], { surface: 'metal' });
  P('weldbooth', [33.6, 0, -14.6], [35.6, 2.2, -12.4], { surface: 'metal' });
  pallets(24.0, -16.4, 3, 'cement'); pallets(25.6, -16.4, 5); crate(28.4, -16.6, 1.2); crate(29.6, -16.7, 1.0);
  crate(42.6, -16.4, 1.2); crate(42.7, -15.0, 1.0); crate(42.7, -15.1, 0.8, 0.8, 1.0);
  barrel(36.0, -6.9); barrel(36.7, -7.2); barrel(30.6, -7.0); pallets(31.8, 15.0, 2, 'boxes');
  crate(22.4, 2.6, 1.0); crate(22.3, 1.5, 0.8); barrel(38.6, 1.6); barrel(39.2, 2.2);
  group('gasbottles', [42.9, 0, -4.6], [43.45, 0.6, -4.0]);
  P('container', [24.6, 0, -4.4], [30.6, 2.6, -2.0], { surface: 'metal', key: 'paintRed' });
  props.push({ type: 'crane', x0: 20.0, x1: 43.6, z: -1.0, y: 9.4, zRails: [-17.6, 15.6] });
  // B2: stair down to the boiler room (SE corner), railed opening
  flight('b2-stair', { kind: 'concrete', solidTo: H.base - 0.4, under: false });
  rail([35.6, 13.42], [42.2, 13.42], 0); rail([35.52, 13.42], [35.52, 15.6], 0);

  // ================================================================ BASEMENT (y -4.0 .. -0.4)
  const BY0 = H.base, BY1 = H.baseTop;
  const BW = { pos: 'ceiling', neg: 'ceiling', edge: 'ceiling' };
  // B1 shaft walls
  wall('x', 12.2, 19.2, -16.0, -15.6, BY0, 0, [], BW);
  wall('z', -18.0, -16.0, 12.2, 12.6, BY0, -1.0, [], BW);
  wall('x', 12.2, 22.8, -18.0, -17.6, BY0, 0, [], BW);
  // tunnel
  wall('z', -16.0, 6.0, 18.8, 19.2, BY0, BY1, [], BW);
  wall('z', -17.6, 5.6, 22.4, 22.8, BY0, BY1, [door(-3.0, 1.4, 2.2, { name: 'pump-door', leaf: 'left', swing: 1, state: 'closed' })], BW);
  // pump room
  wall('x', 22.8, 30.4, -6.0, -5.6, BY0, BY1, [], BW);
  wall('z', -6.0, 1.0, 30.0, 30.4, BY0, BY1, [], BW);
  wall('x', 22.8, 30.4, 0.6, 1.0, BY0, BY1, [door(27.0, 1.4, 2.2, { name: 'pump-passage' })], BW);
  wall('z', 1.0, 5.6, 26.6, 27.0, BY0, BY1, [], BW);
  wall('z', 1.0, 5.6, 28.4, 28.8, BY0, BY1, [], BW);
  // boiler room
  wall('x', 19.2, 36.0, 5.6, 6.0, BY0, BY1, [door(20.0, 1.6, 2.4, { name: 'tunnel-boiler' }), door(27.0, 1.4, 2.2, { name: 'passage-boiler' })], BW);
  wall('z', 6.0, 15.6, 19.2, 19.6, BY0, BY1, [], BW);
  wall('x', 19.2, 36.0, 15.2, 15.6, BY0, BY1, [], BW);
  wall('z', 6.0, 15.2, 35.6, 36.0, BY0, BY1, [door(13.5, 1.4, 2.4, { name: 'boiler-b2' })], BW);
  // B2 shaft
  wall('x', 36.0, 42.6, 13.1, 13.5, BY0, 0, [], BW);
  wall('x', 36.0, 42.6, 14.9, 15.3, BY0, 0, [], BW);
  wall('z', 13.1, 15.3, 42.2, 42.6, BY0, -1.0, [], BW);
  // floors and ceilings (the ceiling is the underside of the ground slab: top faces skipped, the ground grid draws them)
  const BF = { py: 'floor', ny: 'ceiling', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' };
  const BASE_ROOMS = [[19.2, 22.4, -17.6, 5.6], [22.8, 30.0, -5.6, 0.6], [27.0, 28.4, 0.6, 6.0], [19.6, 35.6, 6.0, 15.2], [19.2, 19.6, -17.6, -16.0]];
  for (const [x0, x1, z0, z1] of BASE_ROOMS) {
    solid([x0, BY0 - 0.4, z0], [x1, BY0, z1], { mat: BF, collide: false, kind: 'floor' });
    solid([x0, BY1, z0], [x1, 0, z1], { mat: 'ceiling', collide: false, kind: 'roof', skip: ['py'] });
  }
  // door thresholds through the basement walls
  for (const [x0, x1, z0, z1] of [[22.4, 22.8, -3.0, -1.6], [27.0, 28.4, 0.6, 1.0], [20.0, 21.6, 5.6, 6.0], [27.0, 28.4, 5.6, 6.0], [35.6, 36.0, 13.5, 14.9]]) {
    solid([x0, BY0 - 0.4, z0], [x1, BY0, z1], { mat: BF, collide: false, kind: 'floor' });
  }
  // basement equipment
  P('boiler', [21.2, BY0, 7.0], [25.6, BY0 + 2.6, 9.6], { surface: 'metal' });
  P('boiler', [21.2, BY0, 11.6], [25.6, BY0 + 2.6, 14.2], { surface: 'metal' });
  P('generator', [29.6, BY0, 12.8], [32.0, BY0 + 1.6, 14.4], { surface: 'metal' });
  P('console', [31.4, BY0, 6.2], [34.4, BY0 + 1.1, 6.9], { surface: 'metal', facing: 1 });
  P('pump', [25.0, BY0, -5.4], [26.6, BY0 + 1.2, -4.4], { surface: 'metal' });
  P('pump', [27.6, BY0, -5.4], [29.2, BY0 + 1.2, -4.4], { surface: 'metal' });
  barrel(34.8, 7.0, BY0); barrel(34.6, 7.8, BY0); crate(33.0, 14.5, 1.0, 1.0, BY0); pallets(29.4, -0.1, 2, null, BY0);
  crate(21.8, -16.8, 0.9, 0.9, BY0); barrel(21.9, -10.2, BY0);
  props.push({ type: 'pipes', kind: 'tunnel' });

  // ================================================================ WAREHOUSE (Lager 3), x 0..44, z -52..-34
  wall('x', 0, 44, -34.4, -34, 0, H.ware + 0.4, [
    door(3.0, 1.6, 2.4, { name: 'ware-south-door', leaf: 'right', swing: 1, state: 'ajar' }),
    { a: [16, 20], y: [0, 4.2], name: 'ware-south-gate', shutter: true },
    door(36.0, 1.4, 2.2, { name: 'ware-se-door', leaf: 'left', swing: 1, state: 'closed' }),
    win(8, 12, 6, 8), win(24, 28, 6, 8, 'cracked'), win(30, 34, 6, 8),
  ], EXT_S);
  wall('x', 0, 44, -52, -51.6, 0, H.ware + 0.4, [win(6, 10, 6, 8), win(18, 22, 6, 8), win(30, 34, 6, 8, 'empty')], EXT_N);
  wall('z', -51.6, -34.4, 0, 0.4, 0, H.ware + 0.4, [
    { a: [-46, -42], y: [0, 4.5], name: 'ware-dock-gate', shutter: true },
    door(-38.2, 1.4, 2.2, { name: 'ware-west-door' }), win(-50, -47.5, 6, 8),
  ], EXT_N);
  wall('z', -51.6, -34.4, 43.6, 44, 0, H.ware + 0.4, [win(-48, -44, 6, 8), win(-40, -37, 6, 8)], { pos: 'brick', neg: 'brickIn', edge: 'ceiling' });
  for (const x of [11.0, 22.0, 33.0]) solid([x - 0.25, 0, -43.75], [x + 0.25, H.ware, -43.25], { mat: 'ceiling', kind: 'pillar', cover: true });
  // racking rows (east-west aisles)
  const RH = 6.4;
  for (const [z0, z1] of [[-48.6, -47.5], [-44.6, -43.5], [-40.6, -39.5]]) {
    if (z0 > -44.7 && z0 < -43.4) { P('rack', [5.0, 0, z0], [10.6, RH, z1], { surface: 'metal' }); P('rack', [11.4, 0, z0], [21.6, RH, z1], { surface: 'metal' }); P('rack', [22.4, 0, z0], [32.6, RH, z1], { surface: 'metal' }); }
    else { P('rack', [5.0, 0, z0], [19.6, RH, z1], { surface: 'metal' }); P('rack', [23.2, 0, z0], [33.0, RH, z1], { surface: 'metal' }); }
  }
  // office platform (y 3.2) with stair W1, railings, posts
  deck(35.4, 43.6, -51.6, -45.0, H.wareDeck);
  rail([36.85, -45.05], [43.6, -45.05], H.wareDeck); rail([35.35, -51.6], [35.35, -45.0], H.wareDeck);
  flight('w1-stair', { rails: ['lo', 'hi'], railBase: 0 });
  for (const [x, z] of [[35.55, -51.4], [39.5, -51.4], [43.4, -51.4], [37.0, -45.2], [40.5, -45.2], [43.4, -45.2]]) solid([x - 0.08, 0, z - 0.08], [x + 0.08, H.wareDeck - 0.1, z + 0.08], { mat: 'steel', surface: 'metal', kind: 'post' });
  const WD = H.wareDeck;
  P('desk', [39.2, WD, -49.8], [40.8, WD + 0.76, -49.0], { surface: 'wood' });
  P('filing', [43.0, WD, -50.8], [43.55, WD + 1.3, -49.2], { surface: 'metal' });
  P('shelf', [37.4, WD, -51.55], [39.2, WD + 2.0, -51.05], { surface: 'metal', facing: 1 });
  crate(42.6, -46.4, 1.0, 1.0, WD); group('chair', [39.75, WD, -48.9], [40.3, WD + 0.95, -48.4], { facing: -1 });
  // floor clutter
  P('forklift', [26.0, 0, -38.2], [27.3, 2.2, -35.6], { surface: 'metal' });
  P('forklift', [2.4, 0, -49.6], [3.7, 2.2, -47.0], { surface: 'metal' });
  P('container', [36.6, 0, -38.8], [42.6, 2.6, -36.4], { surface: 'metal', key: 'paintRed' });
  pallets(2.0, -36.6, 6); pallets(2.0, -40.2, 4, 'boxes'); pallets(20.8, -37.0, 3, 'cement'); pallets(31.0, -36.0, 2, 'boxes');
  crate(9.0, -36.0, 1.2); crate(10.3, -36.1, 1.0); crate(9.1, -36.0, 0.9, 0.9, 1.2);
  crate(42.4, -43.0, 1.2); crate(42.6, -41.6, 1.0); barrel(14.0, -50.8); barrel(14.7, -51.0); barrel(25.0, -50.9);
  pallets(30.0, -50.9, 3, 'boxes'); crate(21.0, -50.9, 1.0);

  // ================================================================ GATEHOUSE (Pforte), x 37..42, z 23..28
  const GH = 3.0;
  wall('x', 37, 42, 23, 23.3, 0, GH + 0.2, [win(38.4, 40.6, 1.0, 2.1, 'cracked')], EXT_N);
  wall('x', 37, 42, 27.7, 28, 0, GH + 0.2, [], EXT_S);
  wall('z', 23.3, 27.7, 37, 37.3, 0, GH + 0.2, [door(24.0, 1.2, 2.2, { name: 'gate-door', leaf: 'left', swing: -1, state: 'wind' }), win(25.8, 27.3, 1.0, 2.1, 'broken')], EXT_N);
  wall('z', 23.3, 27.7, 41.7, 42, 0, GH + 0.2, [win(24.2, 26.6, 1.0, 2.1)], { pos: 'brick', neg: 'brickIn', edge: 'ceiling' });
  solid([37, GH + 0.2, 23], [42, GH + 0.4, 28], { mat: { ny: 'ceiling', py: 'concreteOut', px: 'concreteOut', nx: 'concreteOut', pz: 'concreteOut', nz: 'concreteOut' }, collide: false, kind: 'roof' });
  solid([37.3, GH, 23.3], [41.7, GH + 0.2, 27.7], { mat: 'ceiling', collide: false, kind: 'roof' });
  P('desk', [39.0, 0, 23.45], [40.6, 0.76, 24.25], { surface: 'wood' });
  group('chair', [39.6, 0, 24.5], [40.15, 0.95, 25.0], { facing: -1 });
  P('filing', [41.1, 0, 26.2], [41.65, 1.3, 27.6], { surface: 'metal' });
  P('table', [37.8, 0, 26.6], [39.0, 0.76, 27.6], { surface: 'wood' });
  P('barrierarm', [34.0, 0, 30.4], [34.4, 1.1, 30.8], { surface: 'metal', len: 4.0 });

  // ================================================================ OUTSIDE: yard, street, siding, rear lot
  const F = { mat: { pz: 'corrugatedOut', nz: 'corrugatedOut', px: 'corrugatedOut', nx: 'corrugatedOut', py: 'steel', ny: 'steel' }, surface: 'metal', kind: 'wall' };
  // yard fence with the main gate (x 34..38)
  solid([-24.0, 0, 30.0], [34.0, 2.6, 30.2], F);
  solid([38.0, 0, 30.0], [44.0, 2.6, 30.2], F);
  solid([-24.0, 0, 16.0], [-23.8, 2.6, 30.0], F);
  solid([43.8, 0, 16.0], [44.0, 2.6, 30.0], F);
  props.push({ type: 'gateleaf', hinge: [38.0, 30.1], len: 2.0, ry: -1.2 });
  props.push({ type: 'gateleaf', hinge: [34.0, 30.1], len: 2.0, ry: Math.PI + 1.0 });
  // street strip in front of the gate (spawn): kerb blocks keep it small
  solid([29.6, 0, 30.2], [30.0, 0.9, 36.6], { mat: 'concreteOut', kind: 'wall' });
  solid([43.0, 0, 30.2], [43.4, 0.9, 36.6], { mat: 'concreteOut', kind: 'wall' });
  P('van', [31.0, 0, 31.6], [33.0, 2.2, 36.4], { surface: 'metal', tint: 0.6 });
  // yard props
  P('container', [-12.5, 0, 19.6], [-5.5, 2.6, 22.0], { surface: 'metal', key: 'paintRed' });
  P('dumpster', [2.0, 0, 21.2], [4.0, 1.3, 22.4], { surface: 'metal' });
  P('van', [13.0, 0, 18.4], [15.0, 2.2, 23.2], { surface: 'metal' });
  P('van', [22.6, 0, 22.4], [24.6, 2.2, 27.2], { surface: 'metal', tint: 0.75 });
  P('trailer', [29.4, 0, 17.2], [32.3, 4.0, 29.2], { surface: 'metal' });
  P('barrier', [-3.0, 0, 23.0], [-1.0, 0.85, 23.6], { surface: 'concrete' });
  P('barrier', [6.0, 0, 21.0], [8.0, 0.85, 21.6], { surface: 'concrete' });
  P('barrier', [18.0, 0, 26.0], [20.0, 0.85, 26.6], { surface: 'concrete' });
  group('firebarrel', [-1.6, 0, 19.2], [-1.0, 0.9, 19.8]);
  pallets(-19.0, 18.2, 3, 'cement'); crate(-17.6, 18.0, 1.0); barrel(16.6, 21.0); barrel(17.2, 21.4);
  pallets(25.6, 28.8, 2, 'boxes'); crate(27.0, 28.9, 1.0); barrel(35.2, 17.2); barrel(35.8, 17.6); crate(42.8, 17.2, 1.2);
  group('tyres', [-22.65, 0, 23.55], [-21.85, 0.68, 24.35], { surface: 'concrete' });
  group('tyres', [-21.6, 0, 24.75], [-20.8, 0.34, 25.55], { surface: 'concrete', n: 2 });
  group('trashbags', [4.1, 0, 21.2], [4.9, 0.55, 21.9], { surface: 'wood' });
  group('utility', [10.5, 0, 16.02], [11.6, 1.15, 16.48]);
  group('chair', [18.3, 0, 24.0], [18.95, 0.9, 24.65], { facing: -1, kind: 'mono' });
  // rail siding
  solid([-24.0, 0, -34.0], [-23.8, 2.6, -18.0], F);
  solid([43.8, 0, -34.0], [44.0, 2.6, -18.0], F);
  solid([-24.0, 0, -34.2], [0.0, 2.6, -34.0], F);
  props.push({ type: 'gateclosed', axis: 'x', a: [-14, -10], t: -34.1 });
  props.push({ type: 'track', x0: -12.0, x1: 44.0, z: -27.5 });
  P('wagon', [7.0, 0, -28.95], [20.0, 4.0, -26.05], { surface: 'metal', open: 1 });
  P('wagon', [24.0, 0, -28.95], [37.0, 4.0, -26.05], { surface: 'metal', open: -1, tint: 0.8 });
  P('flatcar', [-10.0, 0, -28.7], [-1.0, 1.25, -26.3], { surface: 'metal' });
  crate(-8.0, -27.5, 1.2, 1.2, 1.25); crate(-6.6, -27.4, 1.0, 1.0, 1.25); crate(-3.4, -27.6, 1.2, 1.2, 1.25);
  P('container', [30.0, 0, -22.4], [36.0, 2.6, -20.0], { surface: 'metal', key: 'paintBlue' });
  P('container', [30.0, 2.6, -22.4], [36.0, 5.2, -20.0], { surface: 'metal', key: 'paintRed' });
  P('container', [-6.0, 0, -21.8], [0.0, 2.6, -19.4], { surface: 'metal', key: 'paintBlue' });
  pallets(12.0, -21.0, 4); pallets(13.4, -21.0, 2, 'cement'); crate(24.0, -20.8, 1.2); crate(25.2, -20.9, 1.0);
  barrel(40.6, -21.0); barrel(41.2, -21.4); barrel(-12.0, -20.4); group('firebarrel', [15.6, 0, -30.7], [16.2, 0.9, -30.1]);
  pallets(26.0, -33.4, 3, 'boxes'); crate(42.2, -32.6, 1.2); crate(-20.6, -32.4, 1.0); crate(-21.8, -32.6, 1.2);
  // covered walkway: bay north door -> warehouse south door
  props.push({ type: 'walkway', x0: 2.0, x1: 5.6, z0: -34.0, z1: -18.0, y: 3.2 });
  for (let z = -33.6; z <= -18.3; z += 3.8) for (const x of [2.1, 5.5]) {
    if (z > -29 && z < -26) continue;   // the track crosses here
    solid([x - 0.07, 0, z - 0.07], [x + 0.07, 3.2, z + 0.07], { mat: 'steel', surface: 'metal', kind: 'post' });
  }
  // rear lot (extraction)
  solid([-24.0, 0, -52.2], [0.0, 2.6, -52.0], F);
  solid([-24.2, 0, -52.0], [-24.0, 2.6, -45.6], F);
  solid([-24.2, 0, -40.4], [-24.0, 2.6, -34.0], F);
  P('van', [-27.4, 0, -46.0], [-25.4, 2.2, -41.2], { surface: 'metal', tint: 0.5 });
  P('trailer', [-9.0, 0, -51.4], [-6.1, 4.0, -39.4], { surface: 'metal' });
  P('container', [-22.4, 0, -51.6], [-16.4, 2.6, -49.2], { surface: 'metal', key: 'paintBlue' });
  P('dumpster', [-14.0, 0, -51.4], [-12.0, 1.3, -50.2], { surface: 'metal' });
  pallets(-12.0, -36.0, 3, 'boxes'); crate(-15.0, -36.0, 1.2); crate(-16.2, -36.2, 1.0);
  crate(-3.0, -47.0, 1.2); crate(-3.2, -45.6, 1.0); barrel(-2.4, -38.0); barrel(-2.9, -38.6);
  barrel(-18.6, -46.6); group('firebarrel', [-16.4, 0, -44.4], [-15.8, 0.9, -43.8]);
  P('floodlight', [-21.8, 0, -47.4], [-21.4, 6.0, -47.0], { surface: 'metal' });

  // Doors: static open leaves get thin colliders beside the opening; closed / ajar doors (state) are animated by
  // level.js (they open when someone comes close or shoots them) and keep their collider at the open position.
  for (const d of doors) {
    if (!d.leaf) continue;
    const hinge = d.leaf === 'left' ? d.a[0] : d.a[1];
    const sign = d.leaf === 'left' ? -1 : 1;  // leaf sits just outside the opening edge
    const dyn = d.state === 'closed' || d.state === 'ajar' || d.state === 'wind';
    const w = dyn ? d.width - 0.04 : Math.min(1.0, d.width - 0.1);
    d.leafW = w;
    const ins = d.swing ?? -1; // which side of the wall the open leaf rests on (+1 = +thickness side)
    const y0 = d.y || 0, y1 = y0 + 2.1;
    if (d.axis === 'x') {
      const x0 = sign < 0 ? hinge - 0.06 : hinge, x1 = sign < 0 ? hinge : hinge + 0.06;
      const z0 = ins < 0 ? d.t0 - w : d.t1, z1 = ins < 0 ? d.t0 : d.t1 + w;
      d.leafBox = { min: [x0, y0, z0], max: [x1, y1, z1] };
    } else {
      const z0 = sign < 0 ? hinge - 0.06 : hinge, z1 = sign < 0 ? hinge : hinge + 0.06;
      const x0 = ins < 0 ? d.t0 - w : d.t1, x1 = ins < 0 ? d.t0 : d.t1 + w;
      d.leafBox = { min: [x0, y0, z0], max: [x1, y1, z1] };
    }
    d.dyn = dyn;
    if (d.state === 'wind') continue;   // the swinging gatehouse door has no collider
    solid(d.leafBox.min, d.leafBox.max, { mat: 'rust', surface: 'metal', kind: 'leaf', visual: false, ray: !dyn });
  }

  // explicit openings between zones that are not doors/windows (stair shafts through the ground slab)
  portals.push({ min: [12.6, -0.2, -17.6], max: [19.6, -0.2, -16.0], a: 'bay', b: 'tunnel' });
  portals.push({ min: [35.6, -0.2, 13.5], max: [42.2, -0.2, 14.9], a: 'foundry', b: 'boiler' });

  return { solids, doors, windows, props, roofHoles, portals };
}
