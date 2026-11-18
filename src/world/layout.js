// Pure layout data for the factory level. No DOM / WebGL here so it can be imported by Node self-tests.
// Coordinates: metres, Y up. Building footprint x -24..20, z -18..16; yard south of it (z 16..26).
// yaw 0 looks toward -Z (north, deeper into the building).
//
//  z=-18 ┌──────────────── LOADING BAY (h 7) ──────────[dock door x-19..-16 → trailer]─┐
//        │  racks, forklift, container,   EXTRACTION x-19.5..-15.5 z-17.6..-15          │
//  z=-6  ├──[door]────[big opening]──────────────┬─[door]──┬───────[door]──────────────┤
//        │ DECK(y3.3)│                            │CORRIDOR │ R4 CONTROL                │
//        │  x<-17    │     MAIN HALL (h 8)        │ x8.2-   │ R3 STORAGE                │
//        │ stair↓    │  press, mill, tank,        │  10.6   │ R2 LOCKERS                │
//        │           │  pillars, conveyor         │         │ R1 OFFICE                 │
//  z=16  └──[door]─────[LOADING DOOR x-10..-6]────┴─[door]──┴──[door]───────────────────┘
//                YARD (asphalt, fenced)  container   PLAYER SPAWN (-9, 24)
//  x=-24                                 x=8                                         x=20

export const WALL_T = 0.4;
export const H = { hall: 8.0, bay: 7.0, room: 3.2, slab: 0.3 };
export const DECK = { min: [-23.6, -5.8], max: [-17.0, 2.0], y: 3.3, rail: 4.4 };
export const STAIR = { x0: -23.6, x1: -22.4, zTop: 2.0, zBottom: 9.2 };
export const BOUNDS = { min: [-30, -2, -32], max: [26, 12, 32] };
export const GROUND = { min: [-30, -26], max: [26, 32] };   // visual ground grid
export const FOOTPRINT = { min: [-24, -18], max: [20, 16] };

export const PLAYER_SPAWN = { position: [-9, 0, 24.0], yaw: 0 };
export const EXTRACTION = { min: [-19.5, 0, -17.6], max: [-15.5, 3, -15.0] };

// Floor y at (x,z): deck platform and its stair; 0 everywhere else.
export function groundHeight(x, z) {
  if (x >= STAIR.x0 - 0.05 && x <= STAIR.x1 + 0.2 && z >= STAIR.zTop && z <= STAIR.zBottom) {
    return DECK.y * (STAIR.zBottom - z) / (STAIR.zBottom - STAIR.zTop);
  }
  if (x >= DECK.min[0] - 0.05 && x <= DECK.max[0] && z >= DECK.min[1] && z <= DECK.max[1]) return DECK.y;
  return 0;
}

// Walkable areas used for nav-graph sampling (xz rects). exclude: rects inside that are not walkable.
export const REGIONS = [
  { name: 'yard', min: [-23.8, 16.0], max: [19.8, 25.8] },
  { name: 'hall', min: [-23.6, -5.8], max: [7.8, 15.6],
    exclude: [[[-23.6, -5.8], [-16.6, 2.4]], [[-23.6, 2.0], [-22.0, 9.6]]] },
  { name: 'corridor', min: [8.2, -5.8], max: [10.6, 15.6] },
  { name: 'office', min: [11.0, 10.2], max: [19.6, 15.6] },
  { name: 'locker', min: [11.0, 4.6], max: [19.6, 9.8] },
  { name: 'storage', min: [11.0, -1.0], max: [19.6, 4.2] },
  { name: 'control', min: [11.0, -5.8], max: [19.6, -1.4] },
  { name: 'bay', min: [-23.6, -17.6], max: [19.6, -6.2] },
  { name: 'deck', min: [-23.6, -5.8], max: [-17.2, 1.8] },
  { name: 'stair', min: [-23.6, 2.0], max: [-22.4, 9.2], step: 2.0 },
];
export const EXTRA_NAV_NODES = [[-23.0, 10.0], [-23.0, 1.2], [-21.0, 1.0]];

// Floor material per position (visual only).
export function floorMatAt(x, z) {
  const inside = x > FOOTPRINT.min[0] && x < FOOTPRINT.max[0] && z > FOOTPRINT.min[1] && z < FOOTPRINT.max[1];
  if (!inside) return 'asphalt';
  if (x > 11.0 && x < 19.6 && ((z > 10.2 && z < 15.6) || (z > 4.6 && z < 9.8) || (z > -5.8 && z < -1.4))) return 'lino';
  return 'floor';
}

// ---------------------------------------------------------------- enemies
// type 'guard' holds position (may turn), 'patrol' walks the patrol loop.
export const ENEMY_SPAWNS = [
  { name: 'deck', position: [-20.0, DECK.y, -2.5], yaw: -2.356, type: 'guard' },
  { name: 'hall-patrol', position: [-4.2, 0, 6.8], yaw: Math.PI / 2, type: 'patrol',
    patrol: [[-4.2, 0, 6.8], [-12.8, 0, 6.8], [-12.8, 0, -1.4], [-4.2, 0, -1.4]] },
  { name: 'hall-tank', position: [1.8, 0, -4.6], yaw: Math.PI, type: 'guard' },
  { name: 'corridor-patrol', position: [9.4, 0, -3.5], yaw: Math.PI, type: 'patrol',
    patrol: [[9.4, 0, -4.8], [9.4, 0, 13.0]] },
  { name: 'office', position: [15.6, 0, 12.6], yaw: Math.PI / 2, type: 'guard' },
  { name: 'lockers', position: [17.2, 0, 7.4], yaw: Math.PI / 2, type: 'guard' },
  { name: 'control-patrol', position: [13.2, 0, -3.6], yaw: -Math.PI / 2, type: 'patrol',
    patrol: [[13.2, 0, -3.6], [17.7, 0, -3.6], [17.7, 0, -0.3], [12.4, 0, -0.3], [12.2, 0, 1.7], [9.4, 0, 1.7], [9.4, 0, -3.3], [12.4, 0, -3.3]] },
  { name: 'bay-patrol', position: [-8.0, 0, -13.6], yaw: -Math.PI / 2, type: 'patrol',
    patrol: [[-15.0, 0, -13.6], [0.5, 0, -13.6], [0.5, 0, -7.0], [-15.0, 0, -7.0]] },
  { name: 'bay-racks', position: [15.0, 0, -9.0], yaw: Math.PI / 2, type: 'guard' },
  { name: 'bay-dock', position: [-21.8, 0, -14.6], yaw: -Math.PI / 2, type: 'guard' },
];

// ---------------------------------------------------------------- lights
// state: 'on' steady, 'flicker' dying tube, 'dead' (dark, broken), point: adds a cheap non-shadow light.
export const FIXTURES = [
  { pos: [0.0, 5.2, 10.5], len: 1.5, state: 'on', point: true, hang: true },
  { pos: [-16.0, 5.2, 10.5], len: 1.5, state: 'flicker', point: true, hang: true },
  { pos: [-9.0, 5.2, -0.5], len: 1.5, state: 'dead', hang: true },
  { pos: [-1.0, 5.2, -0.5], len: 1.5, state: 'on', hang: true },
  { pos: [9.4, 3.12, 1.5], len: 1.2, state: 'flicker', point: true },
  { pos: [9.4, 3.12, 10.0], len: 1.2, state: 'on' },
  { pos: [9.4, 3.12, -3.8], len: 1.2, state: 'dead' },
  { pos: [15.0, 3.12, 12.8], len: 1.2, state: 'on', point: true },
  { pos: [15.5, 3.12, 7.2], len: 1.2, state: 'flicker', point: true },
  { pos: [15.0, 3.12, 1.6], len: 1.2, state: 'dead' },
  { pos: [15.0, 3.12, -3.6], len: 1.2, state: 'on', point: true, tint: 0xcfe8ff },
  { pos: [-2.0, 6.2, -12.0], len: 1.5, state: 'on', hang: true },
  { pos: [10.0, 6.2, -12.0], len: 1.5, state: 'flicker', hang: true },
];
// Shadow-casting work lamp (the only spot light).
export const WORK_LAMP = { pos: [-12.6, 2.3, -8.0], target: [-7.0, 0, -13.2] };
// Cheap fill lights faking daylight bounce near big openings.
export const BOUNCE_LIGHTS = [
  { pos: [-8.0, 2.0, 12.5], color: 0xb8c0c8, intensity: 6, distance: 15 },
  { pos: [-12.5, 1.0, 5.0], color: 0xc0c6cc, intensity: 3.5, distance: 10 },
];

// ---------------------------------------------------------------- build solids
/**
 * Solid record: { min:[x,y,z], max:[x,y,z], mat: key|faceMap, collide, ray, surface, kind, visual }
 * collide: becomes a THREE.Box3 collider. ray: gets an invisible raycast proxy box.
 * visual: drawn as a textured box by the level builder (false = a custom prop mesh draws it).
 */
export function buildLayout() {
  const solids = [];
  const doors = [];     // walkable openings { center:[x,z], normal:'x'|'z', width, name, nav }
  const windows = [];   // { min, max, normal:'x'|'z', glass }
  const props = [];     // visual prop descriptors (drawn by props.js)

  const solid = (min, max, o = {}) => {
    if (max[0] - min[0] < 1e-3 || max[1] - min[1] < 1e-3 || max[2] - min[2] < 1e-3) return null;
    const s = {
      min, max, mat: o.mat ?? 'ceiling', collide: o.collide ?? true, ray: o.ray ?? true,
      surface: o.surface ?? 'concrete', kind: o.kind ?? 'wall', visual: o.visual ?? true, cover: o.cover ?? false,
    };
    solids.push(s);
    return s;
  };

  // Wall along axis ('x' = runs along x, thickness in z; 'z' = runs along z, thickness in x).
  // mats: { pos, neg, edge } = face material on +thickness side, -thickness side, ends/top/reveals.
  function wall(axis, a0, a1, t0, t1, y0, y1, openings, mats) {
    const faces = axis === 'x'
      ? { pz: mats.pos, nz: mats.neg, px: mats.edge, nx: mats.edge, py: mats.edge, ny: mats.edge }
      : { px: mats.pos, nx: mats.neg, pz: mats.edge, nz: mats.edge, py: mats.edge, ny: mats.edge };
    const box = (s, e, b, t, collide) => {
      if (axis === 'x') return solid([s, b, t0], [e, t, t1], { mat: faces, collide });
      return solid([t0, b, s], [t1, t, e], { mat: faces, collide });
    };
    const ops = [...(openings || [])].sort((p, q) => p.a[0] - q.a[0]);
    let cur = a0;
    const tm = (t0 + t1) / 2;
    for (const op of ops) {
      if (op.a[0] > cur) box(cur, op.a[0], y0, y1, true);
      const b = Math.max(op.y[0], y0), t = Math.min(op.y[1], y1);
      if (b > y0 + 1e-3) box(op.a[0], op.a[1], y0, b, true);           // sill / below opening
      if (t < y1 - 1e-3) box(op.a[0], op.a[1], t, y1, false);          // header: never blocks movement
      const am = (op.a[0] + op.a[1]) / 2;
      if (b <= y0 + 1e-3) {
        doors.push({
          name: op.name || '', width: op.a[1] - op.a[0], height: t - y0,
          center: axis === 'x' ? [am, tm] : [tm, am], normal: axis === 'x' ? 'z' : 'x', nav: op.nav !== false,
          a: op.a, axis, t0, t1, leaf: op.leaf, swing: op.swing, shutter: op.shutter,
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

  const EXT = { pos: 'brick', neg: 'brickIn', edge: 'ceiling' };       // outer side +, inner side -
  const PART = { pos: 'wall', neg: 'wall', edge: 'ceiling' };
  const door = (s, w = 1.4, h = 2.2, extra = {}) => ({ a: [s, s + w], y: [0, h], ...extra });
  const win = (s, e, b, t, glass = 'broken') => ({ a: [s, e], y: [b, t], glass });

  // ---- exterior walls
  // South (z 15.6..16), outer face +z. Hall part tall, room part low.
  wall('x', -24, 8.2, 15.6, 16, 0, H.hall + 0.4, [
    door(-20, 1.4, 2.2, { name: 'hall-south-door', leaf: 'left', swing: -1 }),
    { a: [-10, -6], y: [0, 4.2], name: 'loading-door', shutter: true },
    win(-23, -21, 5, 7), win(-16.5, -13.5, 5, 7, 'cracked'), win(-4.5, -1.5, 5, 7), win(2, 5, 5, 7, 'empty'),
  ], { pos: 'brick', neg: 'brickIn', edge: 'ceiling' });
  wall('x', 8.2, 20, 15.6, 16, 0, H.room + H.slab, [
    door(8.6, 1.6, 2.2, { name: 'corridor-south-door' }),
    win(12, 14.5, 1.0, 2.3, 'cracked'),
    door(16, 1.4, 2.2, { name: 'office-south-door', leaf: 'right', swing: -1 }),
  ], { pos: 'brick', neg: 'wallOffice', edge: 'ceiling' });
  // North (z -18..-17.6), outer face -z.
  wall('x', -24, 20, -18, -17.6, 0, H.bay + 0.4, [
    { a: [-18.9, -16.1], y: [0, 4.0], name: 'dock-door', nav: false },
    win(-10, -6, 4.5, 6), win(0, 4, 4.5, 6, 'cracked'), win(10, 14, 4.5, 6),
  ], { pos: 'brickIn', neg: 'brick', edge: 'ceiling' });
  // West (x -24..-23.6), outer face -x.
  wall('z', -17.6, -6.2, -24, -23.6, 0, H.bay + 0.4, [win(-15, -12, 4.5, 6), win(-10, -7.5, 4.5, 6, 'empty')],
    { pos: 'brickIn', neg: 'brick', edge: 'ceiling' });
  wall('z', -6.2, 15.6, -24, -23.6, 0, H.hall + 0.4, [win(-4.5, -1.5, 5, 7), win(4, 7, 5, 7, 'cracked'), win(10, 13, 5, 7)],
    { pos: 'brickIn', neg: 'brick', edge: 'ceiling' });
  // East (x 19.6..20), outer face +x.
  wall('z', -17.6, -6.2, 19.6, 20, 0, H.bay + 0.4, [win(-15, -12, 4.5, 6)], { pos: 'brick', neg: 'brickIn', edge: 'ceiling' });
  wall('z', -6.2, 15.6, 19.6, 20, 0, H.room + H.slab, [win(-5.0, -2.6, 1.0, 2.3), win(12, 14.5, 1.0, 2.3, 'empty')],
    { pos: 'brick', neg: 'wallOffice', edge: 'ceiling' });

  // ---- interior walls
  // Hall / bay separator (z -6.2..-5.8), +z side = hall.
  wall('x', -23.6, 7.8, -6.2, -5.8, 0, H.hall + 0.1, [
    door(-13, 1.4, 2.3, { name: 'hall-bay-door', leaf: 'right', swing: 1 }),
    { a: [-6, -2], y: [0, 4.5], name: 'hall-bay-opening' },
  ], { pos: 'brickIn', neg: 'brickIn', edge: 'ceiling' });
  // Rooms / bay separator: lower part with doors, upper part (above the slab) solid.
  wall('x', 7.8, 19.6, -6.2, -5.8, 0, H.room, [
    door(8.6, 1.6, 2.2, { name: 'corridor-bay-door' }),
    door(15, 1.4, 2.2, { name: 'control-bay-door', leaf: 'left', swing: 1 }),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  solid([7.8, H.room, -6.2], [19.6, H.bay + 0.1, -5.8], { mat: { pz: 'ceiling', nz: 'brickIn', px: 'ceiling', nx: 'ceiling', py: 'ceiling', ny: 'ceiling' }, collide: false });
  // Hall / corridor (x 7.8..8.2), +x side = corridor.
  wall('z', -5.8, 15.6, 7.8, 8.2, 0, H.room, [
    door(12, 1.4, 2.2, { name: 'hall-corridor-n' }),
    door(3, 1.4, 2.2, { name: 'hall-corridor-m', leaf: 'left', swing: -1 }),
    door(-4, 1.4, 2.2, { name: 'hall-corridor-s' }),
    win(6, 9, 1.1, 2.3, 'broken'), win(-1, 1.5, 1.1, 2.3, 'cracked'),
  ], { pos: 'wall', neg: 'brickIn', edge: 'ceiling' });
  solid([7.8, H.room, -5.8], [8.2, H.hall + 0.1, 15.6], { mat: { px: 'brick', nx: 'brickIn', pz: 'ceiling', nz: 'ceiling', py: 'ceiling', ny: 'ceiling' }, collide: false });
  // Corridor / rooms (x 10.6..11).
  wall('z', -5.8, 15.6, 10.6, 11.0, 0, H.room, [
    door(12.5, 1.4, 2.2, { name: 'office-door', leaf: 'right', swing: 1 }),
    door(7.0, 1.4, 2.2, { name: 'locker-door' }),
    door(1.0, 1.4, 2.2, { name: 'storage-door', leaf: 'right', swing: 1 }),
    door(-4.0, 1.4, 2.2, { name: 'control-door' }),
  ], { pos: 'wallOffice', neg: 'wall', edge: 'ceiling' });
  // Room separators (x 11..19.6).
  wall('x', 11.0, 19.6, 9.8, 10.2, 0, H.room, [door(17, 1.4, 2.2, { name: 'office-locker' })], { pos: 'wallOffice', neg: 'wallOffice', edge: 'ceiling' });
  wall('x', 11.0, 19.6, 4.2, 4.6, 0, H.room, [door(13, 1.4, 2.2, { name: 'locker-storage', leaf: 'right', swing: -1 })], { pos: 'wallOffice', neg: 'wall', edge: 'ceiling' });
  wall('x', 11.0, 19.6, -1.4, -1.0, 0, H.room, [door(17, 1.4, 2.2, { name: 'storage-control' })], { pos: 'wall', neg: 'wallOffice', edge: 'ceiling' });

  // ---- mezzanine deck (hall NW corner) with stair along the west wall
  // Edge walls enclose the space under the deck; their colliders extend up to rail height.
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
  const HALL_HOLES = [[-14, -11, 4, 7], [-3, -1, -3, -1]];
  const BAY_HOLES = [[-10, -6, -14, -10], [6, 10, -13, -10]];
  for (const r of rectMinusHoles(-23.6, 7.8, -5.8, 15.6, HALL_HOLES)) {
    solid([r[0], H.hall, r[2]], [r[1], H.hall + 0.1, r[3]], { mat: { ny: 'corrugated', py: 'corrugatedOut', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' }, collide: false, surface: 'metal', kind: 'roof' });
  }
  for (const r of rectMinusHoles(-23.6, 19.6, -17.6, -6.2, BAY_HOLES)) {
    solid([r[0], H.bay, r[2]], [r[1], H.bay + 0.1, r[3]], { mat: { ny: 'corrugated', py: 'corrugatedOut', px: 'steel', nx: 'steel', pz: 'steel', nz: 'steel' }, collide: false, surface: 'metal', kind: 'roof' });
  }
  solid([8.2, H.room, -5.8], [19.6, H.room + H.slab, 15.6], { mat: 'ceiling', collide: false, kind: 'roof' });
  const roofHoles = [
    ...HALL_HOLES.map((h) => ({ min: [h[0], H.hall, h[2]], max: [h[1], H.hall + 0.1, h[3]] })),
    ...BAY_HOLES.map((h) => ({ min: [h[0], H.bay, h[2]], max: [h[1], H.bay + 0.1, h[3]] })),
  ];

  // ---- props with colliders
  const P = (type, min, max, o = {}) => {
    const s = solid(min, max, { mat: o.mat ?? 'wood', collide: true, ray: o.ray ?? true, surface: o.surface ?? 'wood', kind: 'prop', visual: o.visual ?? false, cover: (max[1] - min[1]) >= 0.85 });
    props.push({ type, min, max, ...o });
    return s;
  };
  const crate = (x, z, s = 1.0, h = s, y = 0, rot = 0) => P('crate', [x - s / 2, y, z - s / 2], [x + s / 2, y + h, z + s / 2], { rot });
  const pallets = (x, z, n) => P('pallets', [x - 0.6, 0, z - 0.4], [x + 0.6, n * 0.144, z + 0.4], { n });
  const barrel = (x, z) => P('barrel', [x - 0.3, 0, z - 0.3], [x + 0.3, 0.9, z + 0.3], { surface: 'metal' });

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
  P('generator', [3.0, 0, 13.2], [5.4, 1.6, 14.8], { surface: 'metal' });
  crate(-17.2, 6.0, 1.2); crate(-16.0, 6.1, 1.0); crate(-17.0, 6.0, 0.9, 0.9, 1.2); crate(-17.0, 7.3, 1.0);
  crate(2.8, 8.8, 1.2); crate(3.9, 9.4, 0.8); crate(2.9, 8.8, 0.8, 0.8, 1.2);
  crate(-4.2, -3.6, 1.0); crate(-5.3, -3.4, 1.2);
  crate(6.6, 14.4, 1.0); crate(6.8, 13.2, 0.8);
  crate(-21.8, 14.6, 1.2); crate(-20.6, 14.7, 0.9);
  pallets(-9.5, -3.4, 5); pallets(6.6, 5.5, 3); pallets(-15.6, 14.4, 7); pallets(-20.5, 5.0, 2);
  barrel(-1.6, 9.0); barrel(-1.0, 9.6); barrel(-2.2, 9.6); barrel(6.9, -4.9); barrel(6.2, -5.0);
  barrel(-15.9, -4.8); barrel(-16.0, -4.1); barrel(-20.8, 12.6);
  // Corridor
  P('vending', [8.25, 0, 9.4], [8.95, 1.9, 10.4], { surface: 'metal' });
  // Office
  P('desk', [13.2, 0, 11.2], [14.8, 0.76, 12.0], { surface: 'wood' });
  P('desk', [13.2, 0, 14.2], [14.8, 0.76, 15.0], { surface: 'wood' });
  P('filing', [18.9, 0, 10.6], [19.5, 1.3, 12.2], { surface: 'metal' });
  P('shelf', [17.6, 0, 15.0], [19.4, 2.0, 15.5], { surface: 'wood' });
  // Lockers
  P('lockers', [19.0, 0, 5.0], [19.55, 1.95, 9.4], { surface: 'metal', facing: -1 });
  P('lockers', [13.8, 0, 6.0], [14.35, 1.95, 9.2], { surface: 'metal', facing: 1 });
  P('bench', [15.4, 0, 6.6], [17.4, 0.45, 7.0], { surface: 'wood' });
  // Storage
  P('shelf', [18.85, 0, -0.6], [19.5, 2.4, 3.8], { surface: 'metal', metal: true });
  P('shelf', [14.5, 0, 0.6], [16.5, 2.2, 1.2], { surface: 'metal', metal: true });
  crate(12.0, 3.4, 0.8); crate(16.0, 3.5, 0.9); crate(17.0, 3.6, 0.6);
  // Control room
  P('console', [11.4, 0, -5.6], [14.6, 1.1, -4.9], { surface: 'metal' });
  P('console', [16.8, 0, -5.6], [19.4, 1.1, -4.9], { surface: 'metal' });
  P('table', [14.2, 0, -3.2], [16.0, 0.76, -2.4], { surface: 'wood' });
  // Bay
  P('rack', [-2.0, 0, -16.8], [8.0, 4.2, -15.7], { surface: 'metal' });
  P('rack', [10.0, 0, -12.2], [18.0, 4.2, -11.1], { surface: 'metal' });
  P('forklift', [-9.2, 0, -12.0], [-7.0, 2.2, -9.4], { surface: 'metal' });
  P('container', [2.0, 0, -10.5], [8.1, 2.6, -8.1], { surface: 'metal' });
  crate(-13.0, -9.0, 1.2); crate(-11.8, -9.2, 1.0); crate(-12.9, -9.0, 0.9, 0.9, 1.2);
  crate(-21.5, -8.4, 1.2); crate(-21.3, -9.7, 1.0);
  crate(14.0, -15.8, 1.2); crate(15.3, -15.9, 1.0); crate(-2.0, -12.5, 1.0); crate(-1.0, -12.3, 0.8);
  pallets(-20.8, -11.4, 4); pallets(12.0, -15.9, 6); pallets(-4.0, -8.0, 3);
  barrel(18.6, -7.2); barrel(18.6, -7.9); barrel(-14.5, -16.6); barrel(-13.9, -16.9);
  // Trailer outside dock door (closes the opening) and the yard
  P('trailer', [-18.95, 0, -30.0], [-16.05, 4.0, -18.05], { surface: 'metal' });
  P('container', [-12.5, 0, 19.6], [-5.5, 2.6, 22.0], { surface: 'metal' });
  P('dumpster', [2.0, 0, 17.2], [4.0, 1.3, 18.4], { surface: 'metal' });
  P('van', [13.0, 0, 18.4], [15.0, 2.2, 23.2], { surface: 'metal' });
  P('barrier', [-3.0, 0, 23.0], [-1.0, 0.85, 23.6], { surface: 'concrete' });
  P('barrier', [6.0, 0, 21.0], [8.0, 0.85, 21.6], { surface: 'concrete' });
  pallets(-19.0, 18.2, 3); crate(-17.6, 18.0, 1.0); barrel(17.5, 17.0); barrel(18.2, 17.3);

  // ---- yard fence (corrugated, 2.6 m)
  const F = { mat: { pz: 'corrugatedOut', nz: 'corrugatedOut', px: 'corrugatedOut', nx: 'corrugatedOut', py: 'steel', ny: 'steel' }, surface: 'metal', kind: 'wall' };
  solid([-24.0, 0, 25.8], [20.0, 2.6, 26.0], F);
  solid([-24.0, 0, 16.0], [-23.8, 2.6, 25.8], F);
  solid([19.8, 0, 16.0], [20.0, 2.6, 25.8], F);

  // Doors: shutters / open leaves (visual) — leaves get thin colliders beside the opening.
  for (const d of doors) {
    if (!d.leaf) continue;
    const hinge = d.leaf === 'left' ? d.a[0] : d.a[1];
    const sign = d.leaf === 'left' ? -1 : 1;  // leaf sits just outside the opening edge
    const w = Math.min(1.0, d.width - 0.1);
    const ins = d.swing ?? -1; // which side of the wall the open leaf rests on (+1 = +thickness side)
    if (d.axis === 'x') {
      const x0 = sign < 0 ? hinge - 0.06 : hinge, x1 = sign < 0 ? hinge : hinge + 0.06;
      const z0 = ins < 0 ? d.t0 - w : d.t1, z1 = ins < 0 ? d.t0 : d.t1 + w;
      d.leafBox = { min: [x0, 0, z0], max: [x1, 2.1, z1] };
    } else {
      const z0 = sign < 0 ? hinge - 0.06 : hinge, z1 = sign < 0 ? hinge : hinge + 0.06;
      const x0 = ins < 0 ? d.t0 - w : d.t1, x1 = ins < 0 ? d.t0 : d.t1 + w;
      d.leafBox = { min: [x0, 0, z0], max: [x1, 2.1, z1] };
    }
    solid(d.leafBox.min, d.leafBox.max, { mat: 'rust', surface: 'metal', kind: 'leaf', visual: false });
  }

  return { solids, doors, windows, props, roofHoles };
}
