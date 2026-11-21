// Automated intralogistics: conveyors, sorter, AGV/AMR routes, stacker crane, robot cell.
// Owner: A (machines + their animation). Static frames are generated into the greybox by gen.js; moving parts
// (AGVs, crane carriage, robot arm, belt/roller motion) are runtime objects driven by src/world/machines.js.
//
// Conveyor: polyline of [x, z, topY] points, axis-aligned segments, `width`. Segments with a height change are
// built as short stepped pieces (inclines). Parts with topY > 1.6 are elevated (belt + posts) and can be walked /
// driven under (clearance = topY - 0.3).

export const CONVEYORS = [
  {
    id: 'c_loop', name: 'Förderschleife', width: 0.8, closed: true, speed: 0.6, state: 'stopped',
    points: [[74.5, 40, 0.8], [74.5, 8, 0.8], [74.5, 4, 2.6], [79.5, 4, 2.6], [79.5, 8, 0.8], [79.5, 40, 0.8],
      [79.5, 44, 2.6], [74.5, 44, 2.6]],
  },
  {
    id: 'c_akl', name: 'AKL-Auslagerung', width: 0.8, closed: false, speed: 0.5, state: 'stopped', elevated: true,
    points: [[89.75, 32.6, 0.8], [89.75, 38.2, 0.8]],
  },
];

// Sorter: tilt-tray section on the east leg of c_loop, discharging into 5 chutes (east side).
export const SORTER = {
  id: 's_sorter', conveyor: 'c_loop', z0: 18, z1: 30,
  chutes: [19, 21.5, 24, 26.5, 29].map((z, i) => ({ id: `chute${i + 1}`, x0: 79.9, x1: 80.8, z0: z - 0.6, z1: z + 0.6, top: 0.7 })),
};

// AGV / AMR routes: polylines on the floor (y 0), `loop` true = drive round. Vehicles start at `start` (0..1 of
// the route length). Width 0.9 m, length 1.4 m, height 0.45 m (+ load). Routes are kept clear of static props
// (test: npm test checks clearance against the collision boxes).
export const AGV_ROUTES = [
  { id: 'agv_route1', points: [[73.1, 47.0], [73.1, 2.5], [81.6, 2.5], [81.6, 47.0]], loop: true },
  { id: 'agv_route2', points: [[76.0, 60.5], [31.0, 60.5], [31.0, 57.5], [76.0, 57.5]], loop: true },
];
export const AGVS = [
  { id: 'agv1', route: 'agv_route1', start: 0.0, speed: 1.2, kind: 'tugger', state: 'running' },
  { id: 'agv2', route: 'agv_route2', start: 0.9, speed: 1.6, kind: 'amr', state: 'parked' },  // staged: m07
  { id: 'agv3', route: 'agv_route1', start: 0.5, speed: 1.2, kind: 'amr', state: 'running' },
];

// Stacker crane in the high-bay store aisle (x 88.9..90.5): carriage runs along z, mast 11.5 m.
export const CRANES = [{ id: 'rbg1', x: 89.7, z0: 1.0, z1: 31.5, mastH: 11.5, speed: 2.5, state: 'running' }];

// Palletising robot (6-axis arm proxy) and its pallet stations.
export const ROBOTS = [{ id: 'roboter1', base: [90, 0.8, 41], reach: 3.0, stations: [[87.5, 42.4], [92.5, 42.4]], state: 'idle' }];
