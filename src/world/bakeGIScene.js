// Converts the layout's solid boxes into the occluder/albedo description used by the irradiance bake.
// Pure data (no three.js) so it also runs in Node (scripts/bake-bench.mjs).
import { FOOTPRINT } from './layout.js';

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (r, g, b, k = 1) => [lin(r) * k, lin(g) * k, lin(b) * k];

// Approximate diffuse albedo (linear) per material key: texture average x tint x baked grime.
export const ALBEDO = {
  floor: rgb(122, 118, 110, 0.8),
  lino: rgb(118, 110, 96, 0.85),
  asphalt: rgb(78, 77, 76, 0.9),
  wall: rgb(150, 146, 132, 0.8),
  wallOffice: rgb(170, 160, 138, 0.8),
  brick: rgb(132, 74, 54, 0.85),
  brickIn: rgb(112, 80, 66, 0.8),
  ceiling: rgb(128, 126, 122, 0.8),
  concreteOut: rgb(130, 128, 124, 0.85),
  rust: rgb(106, 66, 42, 0.85),
  corrugated: rgb(96, 84, 74, 0.8),
  corrugatedOut: rgb(110, 98, 88, 0.85),
  plate: rgb(92, 94, 96, 0.7),
  steel: rgb(86, 88, 92, 0.7),
  wood: rgb(124, 96, 66, 0.8),
  paint: rgb(64, 98, 74, 0.85),          // faded machine green
  paintGrey: rgb(150, 150, 142, 0.8),
  paintBlue: rgb(88, 110, 150, 0.8),
  paintRed: rgb(150, 66, 52, 0.8),
  yellow: rgb(190, 150, 50, 0.8),
  barrel: rgb(110, 76, 56, 0.8),
};

const PROP_MAT = {
  crate: 'wood', pallets: 'wood', barrel: 'barrel', conveyor: 'paint', press: 'paint', mill: 'paint', tank: 'paintGrey',
  cabinets: 'paintGrey', workbench: 'wood', generator: 'paint', vending: 'paintRed', desk: 'wood', filing: 'paintGrey',
  shelf: 'steel', lockers: 'paintBlue', bench: 'wood', console: 'paintGrey', table: 'wood', rack: 'paintBlue',
  forklift: 'yellow', container: 'rust', trailer: 'paintGrey', dumpster: 'paint', van: 'paintGrey', barrier: 'concreteOut',
};
const FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];   // matches kernel face order (+x,-x,+y,-y,+z,-z)

/**
 * @param layout buildLayout() result
 * @param extra  [{ min, max, mat }] additional occluders (e.g. distant silhouettes)
 * @returns { boxes: [{min,max,id}], albedo: Float32Array(n*18) }
 */
export function buildBakeScene(layout, extra = []) {
  const boxes = [];
  const alb = [];
  const add = (min, max, mat) => {
    const id = boxes.length + 1;
    boxes.push({ min, max, id });
    for (const f of FACE_KEYS) {
      const key = typeof mat === 'string' ? mat : (mat?.[f] ?? 'ceiling');
      const a = ALBEDO[key] ?? ALBEDO.ceiling;
      alb.push(a[0], a[1], a[2]);
    }
  };
  // ground (later boxes overwrite earlier voxels)
  add([-40, -0.6, -40], [40, 0, 40], 'asphalt');
  add([FOOTPRINT.min[0], -0.6, FOOTPRINT.min[1]], [FOOTPRINT.max[0], 0, FOOTPRINT.max[1]], 'floor');
  for (const [z0, z1] of [[10.2, 15.6], [4.6, 9.8], [-5.8, -1.4]]) add([11.0, -0.6, z0], [19.6, 0, z1], 'lino');

  const propType = new Map();
  for (const p of layout.props) if (p.min && p.max) propType.set(p.min, p.type);
  for (const s of layout.solids) {
    if (s.kind === 'rail') continue;               // invisible railing colliders do not block light
    let mat = s.mat;
    if (s.kind === 'prop') mat = PROP_MAT[propType.get(s.min)] ?? (s.surface === 'metal' ? 'steel' : 'wood');
    if (s.kind === 'leaf') mat = 'rust';
    add(s.min, s.max, mat);
  }
  for (const e of extra) add(e.min, e.max, e.mat);
  return { boxes, albedo: new Float32Array(alb) };
}
