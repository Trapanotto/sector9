// SECTOR 9 — site, zones and architecture of the warehouse ("Logistikzentrum Hafenstraße", fictional).
// Owner: core (layout skeleton). Changing walls/floors requires `npm run bake` + `npm test`.
//
// Plan (top view, +x east, +z south; numbers in metres):
//
//  z=-16 ┌──────────────────────────── Nordseite (outdoor, extraction van) ───────────────────────────┐
//  z=0   │ Labor │Sozial│Lager│ Halle Nord (cross aisle, catwalk above at y 4.5) │Bühne/AutoN│  AKL     │
//        │ x0-10 │10-22 │22-28│ x28-72                                           │ x72-84    │ x84-96   │
//  z=12  ├───────┴──────┴─────┤ 9 aisle columns × 2 segments of pallet racking    │ conveyor  │ (high-bay│
//        │ Packerei (gang)    │ (racks 8 m high, aisles 3.2 m)                    │ loop      │  store,  │
//        │ under mezz z12-24  │                                                   │ + sorter  │  crane)  │
//  z=24  │ double height z24-36│ Halle Mitte (cross aisle z 27.6-31.4)            │ (Sorter)  ├──────────┤
//  z=36  ├────────────────────┤                                                   │           │ Roboter- │
//        │ Wareneingang       │                                                   │           │ zelle    │
//        │ (3 dock doors S,   │ Halle Süd (staging, z 53-64)                      ├───────────┴─┬────────┤
//        │  basement stair)   │                                                   │ Warenausgang│ Kühl-  │
//  z=64  └────────────────────┴───────────────────────────────────────────────────┴─────────────┴────────┘
//        Hof (yard, z 64-110): trailers at docks, containers, guard booth, gate at x 40-50 (player start)
//
//  Mezzanine (floor y 4.5) over x 0-28, z 0-24: Geldzählraum, Büro, Leitstand (window + door onto the catwalk),
//  Flur OG, Schlafecke, Umkleide. Basement (floor y -3.7): Technikraum, Versorgungsgang linking a stair in the
//  Wareneingang with a stair up into Halle Süd (x 28.6-30.6).
import { SURF } from './surfaces.js';
import { box, slab, wallX, wallZ, hole, stairs, rail, PX, NX, PY, NY, PZ, NZ, ALL_SIDES } from './dsl.js';

export const SITE = {
  name: 'Logistikzentrum Hafenstraße',
  bounds: [-16, -16, 112, 110],      // x0, z0, x1, z1 of the playable fenced site
  building: [0, 0, 96, 64],
  latitude: 51, timeOfDay: '15:40',   // informative; the sun direction lives in lights.js
};

// --------------------------------------------------------------------------------------------------------
// ZONES — gameplay/visibility/acoustic cells. `parts` are AABBs [x0,y0,z0,x1,y1,z1]; the FIRST zone in this
// list whose part contains a point owns it (so small rooms come before big halls, outdoor last).
// acoustic: 'outdoor' | 'hall_large' | 'hall_medium' | 'room_large' | 'room_small' | 'corridor' | 'stairwell'
//           | 'basement' | 'cold_store'. circuit: artificial-light circuit (lights.js) that lights the zone.
// --------------------------------------------------------------------------------------------------------
const Z = (id, name, acoustic, circuit, parts, o = {}) => ({ id, name, acoustic, circuit, parts, ...o });

// Hall racking geometry (shared with props.js): rows run along z, aisle columns between row centre lines.
export const HALL = {
  x0: 28.15, x1: 71.9, z0: 0, z1: 64, roofY: 12,
  segN: [6.0, 27.6], segS: [31.4, 53.0], bayLen: 2.7, bays: 8,
  // racks: [x0, x1] of each single rack run (1.1 deep); doubles are two singles back to back
  racks: [[31.2, 32.3], [35.5, 36.6], [36.6, 37.7], [40.9, 42.0], [42.0, 43.1], [46.3, 47.4], [47.4, 48.5],
    [51.7, 52.8], [52.8, 53.9], [57.1, 58.2], [58.2, 59.3], [62.5, 63.6], [63.6, 64.7], [67.9, 69.0]],
  // aisle zone columns (x cuts at rack-row centre lines)
  cols: [28.15, 31.75, 36.6, 42.0, 47.4, 52.8, 58.2, 63.6, 68.45, 71.9],
};

function hallZones() {
  const out = [];
  const names = ['Wandgang West', 'Regalgang 1', 'Regalgang 2', 'Regalgang 3', 'Regalgang 4', 'Regalgang 5',
    'Regalgang 6', 'Regalgang 7', 'Wandgang Ost'];
  for (let i = 0; i < HALL.cols.length - 1; i++) {
    const x0 = HALL.cols[i], x1 = HALL.cols[i + 1];
    out.push(Z(`gang${i}_n`, `${names[i]} Nord`, 'hall_large', 'halle', [[x0, 0, HALL.segN[0], x1, 12, HALL.segN[1]]]));
    out.push(Z(`gang${i}_s`, `${names[i]} Süd`, 'hall_large', 'halle', [[x0, 0, HALL.segS[0], x1, 12, HALL.segS[1]]]));
  }
  return out;
}

export const ZONES = [
  // basement
  Z('keller_treppe', 'Kellertreppe', 'stairwell', 'keller', [[12.55, -3.7, 41.0, 14.1, 0, 48.6]]),
  Z('keller_treppe_h', 'Kellertreppe Halle', 'stairwell', 'keller', [[28.6, -3.7, 46.6, 30.6, 0, 54.2]]),
  Z('technik', 'Technikraum', 'basement', 'keller', [[0, -3.7, 40, 12.25, -0.3, 52]]),
  Z('tunnel', 'Versorgungsgang', 'corridor', 'keller', [[14.1, -3.7, 46.6, 28.6, -0.3, 48.6]]),
  // mezzanine (floor y 4.5)
  Z('geld', 'Geldzählraum', 'room_small', 'og', [[0, 4.2, 0, 8.9, 8, 8.9]]),
  Z('buero', 'Büro', 'room_small', 'og', [[9.1, 4.2, 0, 17.9, 8, 8.9]]),
  Z('leitstand', 'Leitstand', 'room_small', 'og', [[18.1, 4.2, 0, 27.85, 8, 8.9]]),
  Z('flur_og', 'Flur OG', 'corridor', 'og', [[0, 4.2, 9.1, 27.85, 8, 11.9], [22.1, 4.2, 11.9, 27.85, 8, 17.06]]),
  Z('schlafen', 'Schlafecke', 'room_small', 'og', [[0, 4.2, 12.1, 13.9, 8, 23.8]]),
  Z('umkleide', 'Umkleide', 'room_small', 'og', [[14.1, 4.2, 12.1, 21.9, 8, 23.8]]),
  // west wing ground floor
  Z('labor', 'Labor', 'room_small', 'west_eg', [[0, 0, 0, 9.9, 4.2, 11.9]]),
  Z('sozial', 'Sozialraum', 'room_small', 'west_eg', [[10.1, 0, 0, 21.9, 4.2, 11.9]]),
  Z('lager_w', 'Lagerraum', 'room_small', 'west_eg', [[22.1, 0, 0, 27.85, 4.2, 11.9]]),
  Z('treppe_w', 'Treppenhaus', 'stairwell', 'west_eg', [[22.1, 0, 12.1, 27.85, 4.2, 24], [22.1, 4.2, 17.06, 27.85, 8, 24]]),
  Z('packerei', 'Packerei', 'room_large', 'west_eg', [[0, 0, 12.1, 22.1, 4.2, 24], [0, 0, 24, 27.85, 8, 35.9]]),
  Z('wareneingang', 'Wareneingang', 'hall_medium', 'west_eg', [[0, 0, 36.1, 27.85, 8, 64]]),
  // racking hall
  Z('steg', 'Laufsteg', 'hall_large', 'halle', [[28.15, 4.2, 0, 71.9, 12, 2.4]]),
  Z('halle_n', 'Halle Nord', 'hall_large', 'halle', [[28.15, 0, 0, 71.9, 12, 6.0]]),
  Z('halle_m', 'Halle Mitte', 'hall_large', 'halle', [[28.15, 0, 27.6, 71.9, 12, 31.4]]),
  Z('halle_s', 'Halle Süd', 'hall_large', 'halle', [[28.15, 0, 53.0, 71.9, 12, 64]]),
  ...hallZones(),
  // automated zone
  Z('buehne', 'Bühne', 'hall_large', 'auto', [[72.1, 4.2, 0, 83.9, 12, 6]]),
  Z('auto_n', 'Fördertechnik Nord', 'hall_large', 'auto', [[72.1, 0, 0, 83.9, 12, 22]]),
  Z('auto_s', 'Sorter', 'hall_large', 'auto', [[72.1, 0, 22, 83.9, 12, 48]]),
  Z('akl', 'Hochregallager', 'hall_large', 'auto', [[84.1, 0, 0, 96, 12, 33.9]]),
  Z('kuehl', 'Kühlraum', 'cold_store', 'kuehl', [[86.1, 0, 50.1, 96, 3.5, 64]]),
  Z('roboter', 'Roboterzelle', 'hall_large', 'auto', [[84.1, 0, 34.1, 96, 12, 48]]),
  Z('versand', 'Warenausgang', 'hall_large', 'auto', [[72.1, 0, 48, 86, 12, 64], [86, 0, 48, 96, 12, 50], [86, 3.7, 50, 96, 12, 64]]),
  // outdoor
  Z('hof', 'Hof', 'outdoor', 'aussen', [[-16, -1, 64.3, 112, 30, 110]], { outdoor: true }),
  Z('west', 'Westseite', 'outdoor', 'aussen', [[-16, -1, -16, -0.3, 30, 64.3]], { outdoor: true }),
  Z('nord', 'Nordseite', 'outdoor', 'aussen', [[-0.3, -1, -16, 96.3, 30, -0.3]], { outdoor: true }),
  Z('ost', 'Ostseite', 'outdoor', 'aussen', [[96.3, -1, -16, 112, 30, 64.3]], { outdoor: true }),
];

// --------------------------------------------------------------------------------------------------------
// ARCHITECTURE
// --------------------------------------------------------------------------------------------------------
const C = (s) => ({ surf: s });
const EXT = 0.3;    // exterior wall thickness (outside the 0..96 × 0..64 footprint)
const DOOR_H = 2.1;
const door = (id, name, zones, o = {}) => ({ id, name, zones, kind: 'swing', state: 'closed', hinge: 'a', ...o });
const win = (o = {}) => ({ breakable: true, ...o });

export const ARCH = [
  // ---- ground ---------------------------------------------------------------------------------------
  // site ground strips around the building (top y 0); only the top faces are ever visible
  slab(-16, 64.3, 112, 110, -0.3, 0, { ...C('asphalt'), hide: NY, hideOuter: true, zoneHint: 'hof' }),
  slab(-16, -16, 112, -0.3, -0.3, 0, { ...C('asphalt'), hide: NY, hideOuter: true }),
  slab(-16, -0.3, -0.3, 64.3, -0.3, 0, { ...C('asphalt'), hide: NY, hideOuter: true }),
  slab(96.3, -0.3, 112, 64.3, -0.3, 0, { ...C('asphalt'), hide: NY, hideOuter: true }),
  // wall footings: the 0.3 m strip under the exterior walls
  // building floor slab, part over the basement (its underside is the basement ceiling)
  slab(0, 40, 31, 55, -0.3, 0, { ...C('concrete'), hideOuter: true, holes: [[12.55, 41.0, 14.1, 46.6], [28.6, 48.6, 30.6, 54.2]] }),
  // rest of the building slab (underside never visible)
  slab(-0.3, -0.3, 96.3, 64.3, -0.3, 0, { ...C('floor'), hide: NY, hideOuter: true, holes: [[0, 40, 31, 55]] }),

  // ---- exterior walls ------------------------------------------------------------------------------------
  // west (x -0.3..0), full length incl. corners, west wing height
  wallZ(-0.15, -0.3, 64.3, 0, 8.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [
      hole(3, 7, 1.4, 2.6, { glass: win() }),                         // Labor
      hole(14, 20, 1.5, 3.0, { glass: win() }), hole(26, 34, 2.0, 4.0, { glass: win() }),  // Packerei
      hole(15, 21, 5.5, 7.0, { glass: win() }),                       // Schlafecke (OG)
      hole(40, 54, 5.0, 7.0, { glass: win({ breakable: false }) }),   // Wareneingang high windows
      hole(57, 58, 0, DOOR_H, { door: door('d_we_west', 'Seitentür Wareneingang', ['west', 'wareneingang']) }),
    ],
  }),
  // east (x 96..96.3)
  wallZ(96.15, -0.3, 64.3, 0, 12.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [hole(38, 46, 2.0, 4.0, { glass: win() })],
  }),
  // north, west wing part
  wallX(-0.15, 0, 28, 0, 8.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [
      hole(3, 7, 1.4, 2.6, { glass: win() }), hole(13, 19, 1.4, 2.6, { glass: win() }),
      hole(11, 16, 5.5, 7.0, { glass: win() }), hole(20, 26, 5.5, 7.0, { glass: win() }),
    ],
  }),
  // north, hall + automation part
  wallX(-0.15, 28, 96, 0, 12.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [
      hole(31, 37, 8, 10.5, { glass: win({ breakable: false }) }), hole(39, 45, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(47, 53, 8, 10.5, { glass: win({ breakable: false }) }), hole(55, 61, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(63, 69, 8, 10.5, { glass: win({ breakable: false }) }), hole(74, 82, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(76, 77.2, 0, DOOR_H, { door: door('d_notausgang', 'Notausgang Nord', ['auto_n', 'nord']) }),
    ],
  }),
  // south, west wing part: three dock doors + personnel door
  wallX(64.15, 0, 28, 0, 8.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [
      hole(3.25, 6.75, 0, 4.2, { door: door('d_dock1', 'Tor 1', ['hof', 'wareneingang'], { kind: 'roller' }) }),
      hole(10.25, 13.75, 0, 4.2, { door: door('d_dock2', 'Tor 2', ['hof', 'wareneingang'], { kind: 'roller', state: 'open' }) }),
      hole(17.25, 20.75, 0, 4.2, { door: door('d_dock3', 'Tor 3', ['hof', 'wareneingang'], { kind: 'roller' }) }),
      hole(24.5, 25.5, 0, DOOR_H, { door: door('d_we_sued', 'Tür Wareneingang', ['hof', 'wareneingang']) }),
    ],
  }),
  // south, hall + automation part
  wallX(64.15, 28, 96, 0, 12.3, EXT, {
    ...C('cladding'), hide: PY | NY, openings: [
      hole(31, 37, 8, 10.5, { glass: win({ breakable: false }) }), hole(39, 45, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(47, 53, 8, 10.5, { glass: win({ breakable: false }) }), hole(55, 61, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(63, 69, 8, 10.5, { glass: win({ breakable: false }) }), hole(74, 81, 8, 10.5, { glass: win({ breakable: false }) }),
      hole(75.5, 79, 0, 4.2, { door: door('d_dock4', 'Tor 4', ['hof', 'versand'], { kind: 'roller' }) }),
      hole(80.5, 84, 0, 4.2, { door: door('d_dock5', 'Tor 5', ['hof', 'versand'], { kind: 'roller', state: 'half' }) }),
    ],
  }),

  // ---- roofs (top faces never visible) -----------------------------------------------------------------
  slab(0, 0, 27.85, 64, 8.0, 8.3, {
    ...C('roof'), hide: PY, hideOuter: true, walk: false,
    holes: [[6, 44, 12, 52], [16, 44, 22, 52], [8, 28, 20, 31]],
    skylights: true,
  }),
  slab(28.15, 0, 96, 64, 12.0, 12.3, {
    ...C('roof'), hide: PY, hideOuter: true, walk: false,
    holes: [[32, 11, 40, 13.4], [44, 11, 52, 13.4], [56, 11, 64, 13.4],
      [32, 31, 40, 33.4], [44, 31, 52, 33.4], [56, 31, 64, 33.4],
      [32, 51, 40, 53.4], [44, 51, 52, 53.4], [56, 51, 64, 53.4],
      [74, 10, 80, 12.4], [74, 30, 80, 32.4], [88, 52, 94, 54.4]],
    skylights: true,
  }),

  // ---- west wing / hall dividing wall (x 27.85..28.15) -------------------------------------------------
  wallZ(28, 0, 64, 0, 8.0, 0.3, {
    ...C('plaster'), openings: [
      hole(3, 4.2, 0, DOOR_H, { door: door('d_lager_halle', 'Tür Lager/Halle', ['lager_w', 'halle_n']) }),
      hole(0.5, 1.5, 4.5, 6.6, { door: door('d_leitstand_steg', 'Tür Leitstand/Steg', ['leitstand', 'steg']) }),
      hole(2.5, 7.5, 5.3, 7.3, { glass: win() }),                       // Leitstand overlooks the hall
      hole(29, 30.2, 0, DOOR_H, { door: door('d_pack_halle', 'Tür Packerei/Halle', ['packerei', 'halle_m']) }),
      hole(55, 61, 0, 5.0),                                            // forklift passage Wareneingang/Halle
    ],
  }),
  wallZ(28, 0, 64, 8.0, 12.3, 0.3, { ...C('cladding'), hide: NX | PY }),  // above the west roof

  // ---- west wing ground floor (y 0..4.2, under the mezzanine slab) ------------------------------------------
  wallX(12, 0, 27.85, 0, 4.2, 0.2, {
    ...C('plaster'), openings: [
      hole(4, 5, 0, DOOR_H, { door: door('d_labor', 'Tür Labor', ['labor', 'packerei']) }),
      hole(15, 16, 0, DOOR_H, { door: door('d_sozial', 'Tür Sozialraum', ['sozial', 'packerei'], { state: 'open' }) }),
      hole(24.5, 25.5, 0, DOOR_H, { door: door('d_lager', 'Tür Lagerraum', ['lager_w', 'treppe_w']) }),
    ],
  }),
  wallZ(10, 0, 11.9, 0, 4.2, 0.2, C('plaster')),
  wallZ(22, 0, 11.9, 0, 4.2, 0.2, C('plaster')),
  // Packerei / Wareneingang
  wallX(36, 0, 27.85, 0, 8.0, 0.2, {
    ...C('plaster'), openings: [
      hole(8, 14, 0, 4.5),
      hole(20, 21.2, 0, DOOR_H, { door: door('d_pack_we', 'Tür Packerei/Wareneingang', ['packerei', 'wareneingang']) }),
    ],
  }),
  // columns in the Wareneingang
  box([9.13, 0, 49.8], [9.53, 8.0, 50.2], { ...C('concrete'), cls: 'arch' }),
  box([18.46, 0, 49.8], [18.86, 8.0, 50.2], { ...C('concrete'), cls: 'arch' }),

  // ---- mezzanine (slab top y 4.5) ---------------------------------------------------------------------------
  slab(0, 0, 27.85, 24, 4.2, 4.5, { ...C('concrete'), holes: [[22.1, 17.06, 27.85, 24]] }),
  stairs(24.5, 17.06, 26.0, 23.5, 0, 4.5, '-z', 24, C('concrete')),
  rail('x', 17.0, 22.1, 24.5, 4.5), rail('x', 17.0, 26.0, 27.85, 4.5),
  wallX(9, 0, 27.85, 4.5, 8.0, 0.2, {
    ...C('plaster'), openings: [
      hole(7, 8, 4.5, 4.5 + DOOR_H, { door: door('d_geld', 'Tür Geldzählraum', ['geld', 'flur_og'], { state: 'locked' }) }),
      hole(12, 13, 4.5, 4.5 + DOOR_H, { door: door('d_buero', 'Tür Büro', ['buero', 'flur_og']) }),
      hole(14, 17, 5.5, 6.8, { glass: win() }),
      hole(22, 23, 4.5, 4.5 + DOOR_H, { door: door('d_leitstand', 'Tür Leitstand', ['leitstand', 'flur_og']) }),
    ],
  }),
  wallZ(9, 0, 8.9, 4.5, 8.0, 0.2, C('plaster')),
  wallZ(18, 0, 8.9, 4.5, 8.0, 0.2, C('plaster')),
  wallX(12, 0, 22.1, 4.5, 8.0, 0.2, {
    ...C('plaster'), openings: [
      hole(6, 7, 4.5, 4.5 + DOOR_H, { door: door('d_schlafen', 'Tür Schlafecke', ['schlafen', 'flur_og'], { state: 'open' }) }),
      hole(17, 18, 4.5, 4.5 + DOOR_H, { door: door('d_umkleide', 'Tür Umkleide', ['umkleide', 'flur_og']) }),
    ],
  }),
  wallZ(14, 12.1, 23.8, 4.5, 8.0, 0.2, C('plaster')),
  wallZ(22, 12.1, 23.8, 4.5, 8.0, 0.2, C('plaster')),
  wallX(23.9, 0, 22.1, 4.5, 8.0, 0.2, {
    ...C('plaster'), openings: [hole(3, 6, 5.5, 6.8, { glass: win() }), hole(16, 19, 5.5, 6.8, { glass: win() })],
  }),

  // ---- basement (floor y -3.7, ceiling = building slab underside at -0.3) ------------------------------------
  slab(0, 40, 12.25, 52, -4.0, -3.7, { ...C('concrete'), hide: NY, hideOuter: true }),
  slab(12.25, 41.0, 14.1, 48.6, -4.0, -3.7, { ...C('concrete'), hide: NY, hideOuter: true }),
  slab(14.1, 46.6, 28.6, 48.6, -4.0, -3.7, { ...C('concrete'), hide: NY, hideOuter: true }),
  slab(28.6, 46.6, 30.6, 54.2, -4.0, -3.7, { ...C('concrete'), hide: NY, hideOuter: true }),
  // goodsin → basement stair (ascends towards -z, top at z 41)
  stairs(12.55, 41.0, 14.1, 46.6, -3.7, 0, '-z', 20, C('concrete')),
  // basement → hall stair (ascends towards +z, top at z 54.2)
  stairs(28.6, 48.6, 30.6, 54.2, -3.7, 0, '+z', 20, C('concrete')),
  // basement walls (outer faces are in the ground: hidden)
  wallZ(-0.15, 39.7, 52.3, -3.7, -0.3, 0.3, { ...C('concrete'), hide: NX | PY | NY }),
  wallX(39.85, 0, 12.25, -3.7, -0.3, 0.3, { ...C('concrete'), hide: NZ | PY | NY }),
  wallX(52.15, 0, 12.25, -3.7, -0.3, 0.3, { ...C('concrete'), hide: PZ | PY | NY }),
  wallZ(12.4, 39.7, 52.3, -3.7, -0.3, 0.3, {
    ...C('concrete'), hide: PY | NY, openings: [
      hole(47.0, 48.0, -3.7, -3.7 + DOOR_H, { door: door('d_technik', 'Tür Technikraum', ['technik', 'keller_treppe']) }),
    ],
  }),
  wallX(40.85, 12.55, 14.4, -3.7, -0.3, 0.3, { ...C('concrete'), hide: NZ | PY | NY }),
  wallZ(14.25, 41.0, 46.6, -3.7, -0.3, 0.3, { ...C('concrete'), hide: PX | PY | NY }),
  wallX(46.45, 14.4, 30.9, -3.7, -0.3, 0.3, { ...C('concrete'), hide: NZ | PY | NY }),
  wallX(48.75, 12.55, 28.6, -3.7, -0.3, 0.3, { ...C('concrete'), hide: PZ | PY | NY }),
  wallZ(28.45, 48.9, 54.2, -3.7, -0.3, 0.3, { ...C('concrete'), hide: NX | PY | NY }),
  wallZ(30.75, 46.6, 54.2, -3.7, -0.3, 0.3, { ...C('concrete'), hide: PX | PY | NY }),
  wallX(54.35, 28.3, 30.9, -3.7, -0.3, 0.3, { ...C('concrete'), hide: PZ | PY | NY }),
  // railings around the two stair holes
  rail('z', 12.5, 41.0, 46.7, 0), rail('z', 14.15, 41.0, 46.7, 0), rail('x', 46.65, 12.54, 14.11, 0),
  rail('z', 28.55, 48.5, 54.2, 0), rail('z', 30.65, 48.5, 54.2, 0), rail('x', 48.55, 28.59, 30.61, 0),

  // ---- racking hall --------------------------------------------------------------------------------------------
  // catwalk along the north wall at y 4.5 (thin grating), continues through the partition onto the Bühne
  slab(28.15, 0, 72.1, 1.6, 4.4, 4.5, C('grating')),
  rail('x', 1.55, 28.15, 71.9, 4.5),

  // ---- partition hall / automation (x 71.9..72.1) --------------------------------------------------------------
  wallZ(72, 0, 64, 0, 12, 0.2, {
    ...C('cladding'), openings: [
      hole(0, 1.6, 4.4, 7.0),
      hole(18, 19.2, 0, DOOR_H, { door: door('d_halle_auto', 'Tür Halle/Fördertechnik', ['gang8_n', 'auto_n']) }),
      hole(54, 62, 0, 5.0),
    ],
  }),
  // Bühne (platform) + stair down
  slab(72.1, 0, 83.9, 6, 4.2, 4.5, C('grating')),
  rail('x', 5.95, 72.1, 82.3, 4.5),
  stairs(82.3, 6.0, 83.8, 12.7, 0, 4.5, '-z', 24, C('steel')),
  box([82.2, 0, 6.0], [82.3, 5.5, 12.7], { cls: 'collider' }),
  // high-bay store enclosure
  wallZ(84, 0, 34.1, 0, 12, 0.2, { ...C('cladding'), openings: [hole(10, 14, 1.5, 2.5, { glass: win() })] }),
  wallX(34, 84.1, 96, 0, 12, 0.2, {
    ...C('cladding'), openings: [
      hole(86.5, 87.5, 0, DOOR_H, { door: door('d_akl', 'Wartungstür AKL', ['akl', 'roboter']) }),
      hole(89.0, 90.5, 0.5, 1.6),          // I/O conveyor through the wall
    ],
  }),
  // robot cell safety fence (see-through mesh)
  wallZ(84, 34.1, 48, 0, 2.2, 0.06, { surf: 'steel', cls: 'mesh' }),
  wallX(48, 84.03, 96, 0, 2.2, 0.06, {
    surf: 'steel', cls: 'mesh', openings: [
      hole(90, 91.5, 0, 2.2, { door: door('d_roboter', 'Tor Roboterzelle', ['roboter', 'versand'], { kind: 'slide' }) }),
    ],
  }),
  // cold store box
  wallZ(86, 50.1, 64, 0, 3.7, 0.2, {
    ...C('white'), openings: [
      hole(56, 57.4, 0, 2.3, { door: door('d_kuehl', 'Kühlraumtür', ['kuehl', 'versand'], { kind: 'slide' }) }),
    ],
  }),
  wallX(50, 85.9, 96, 0, 3.7, 0.2, C('white')),
  slab(86.1, 50.1, 96, 64, 3.5, 3.7, { ...C('white'), hide: PY, walk: false }),

  // ---- backdrop (outside the fence; vertex-lit, very cheap) -------------------------------------------------
  slab(-300, -300, 300, -16, -0.3, 0, { surf: 'far', cls: 'far', hide: NY | ALL_SIDES }),
  slab(-300, 110, 300, 300, -0.3, 0, { surf: 'far', cls: 'far', hide: NY | ALL_SIDES }),
  slab(-300, -16, -16, 110, -0.3, 0, { surf: 'far', cls: 'far', hide: NY | ALL_SIDES }),
  slab(112, -16, 300, 110, -0.3, 0, { surf: 'far', cls: 'far', hide: NY | ALL_SIDES }),
  box([-62, 0, -40], [-28, 14, 70], { surf: 'cladding', cls: 'far', hide: NY }),
  box([124, 0, -30], [170, 10, 50], { surf: 'concrete', cls: 'far', hide: NY }),
  box([0, 0, -70], [90, 12, -34], { surf: 'cladding', cls: 'far', hide: NY }),
  box([-20, 0, 128], [60, 9, 160], { surf: 'plaster', cls: 'far', hide: NY }),
  box([75, 0, 124], [140, 16, 170], { surf: 'cladding', cls: 'far', hide: NY }),

  // ---- perimeter fence (see-through) with the gate gap at x 40..50 ----------------------------------------------
  wallX(110, -16, 40, 0, 2.4, 0.06, { surf: 'steel', cls: 'mesh' }),
  wallX(110, 50, 112, 0, 2.4, 0.06, { surf: 'steel', cls: 'mesh' }),
  wallX(-16, -16, 112, 0, 2.4, 0.06, { surf: 'steel', cls: 'mesh' }),
  wallZ(-16, -15.97, 109.97, 0, 2.4, 0.06, { surf: 'steel', cls: 'mesh' }),
  wallZ(112, -15.97, 109.97, 0, 2.4, 0.06, { surf: 'steel', cls: 'mesh' }),
];
