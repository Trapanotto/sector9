// Greybox proxy definitions for prop types. Owner: A (world art) — art replaces the VISUAL of a type with an
// authored model of the same footprint (see CONTRACT.md §A). Proxy boxes stay the collision/bake truth.
//
// Local frame: origin at the bottom centre, +x = width, +z = depth ("front" faces -z), y up. Instances rotate by
// quarter turns (r = 0..3, counter-clockwise seen from above) so the proxies stay axis-aligned.
// Box: [x0, y0, z0, x1, y1, z1, surf, flags?]; flags: { cls:'mesh'|'collider'|'prop', emit, solid:false, ... }

// Groups (prop type names, or raw groups such as 'rack', 'akl', 'conveyor', 'rail', 'lamp') whose greybox proxy
// faces are NOT drawn because art (A) renders its own models in place. Collision, nav, bake and bullets still use
// the proxies. Example: export const HIDE_PROXY_GROUPS = ['pallet_load', 'rack'];
export const HIDE_PROXY_GROUPS = [];

const P = (x0, y0, z0, x1, y1, z1, surf, f) => [x0, y0, z0, x1, y1, z1, surf, f];
const pallet = P(-0.6, 0, -0.4, 0.6, 0.144, 0.4, 'wood');

export const PROP_TYPES = {
  pallet: { boxes: [pallet], tris: 12 },
  pallet_load: { boxes: [pallet, P(-0.57, 0.144, -0.37, 0.57, 1.3, 0.37, 'wrap')] },
  pallet_cartons: { boxes: [pallet, P(-0.58, 0.144, -0.38, 0.58, 1.0, 0.38, 'cardboard')] },
  pallet_stack: { boxes: [P(-0.6, 0, -0.4, 0.6, 0.86, 0.4, 'wood')] },
  pallet_drums: {
    boxes: [pallet, P(-0.55, 0.144, -0.35, -0.02, 1.04, 0.0, 'plastic'), P(0.02, 0.144, -0.35, 0.55, 1.04, 0.0, 'plastic'),
      P(-0.55, 0.144, 0.02, -0.02, 1.04, 0.37, 'plastic'), P(0.02, 0.144, 0.02, 0.55, 1.04, 0.37, 'plastic')],
  },
  carton: { boxes: [P(-0.3, 0, -0.2, 0.3, 0.4, 0.2, 'cardboard')] },
  carton_pile: { boxes: [P(-0.6, 0, -0.4, 0.6, 0.8, 0.4, 'cardboard'), P(-0.5, 0.8, -0.3, 0.3, 1.2, 0.3, 'cardboard')] },
  // packing table with cartons, scale and wrapped bricks (gang packing station)
  packing_table: {
    boxes: [P(-1, 0.82, -0.4, 1, 0.87, 0.4, 'steel'), P(-0.98, 0, -0.38, -0.9, 0.82, 0.38, 'steel'),
      P(0.9, 0, -0.38, 0.98, 0.82, 0.38, 'steel'), P(-0.7, 0.87, -0.2, -0.2, 1.17, 0.2, 'cardboard'),
      P(0.3, 0.87, -0.15, 0.6, 0.95, 0.15, 'dark'), P(-0.05, 0.87, -0.32, 0.2, 0.95, -0.17, 'wrap')],
  },
  forklift: {
    boxes: [P(-0.55, 0.15, -1.25, 0.55, 1.25, 0.9, 'yellow'), P(-0.45, 0.05, 0.9, 0.45, 2.3, 1.05, 'steel'),
      P(-0.4, 0.04, 1.05, -0.28, 0.1, 2.2, 'steel'), P(0.28, 0.04, 1.05, 0.4, 0.1, 2.2, 'steel'),
      P(-0.55, 2.1, -0.9, 0.55, 2.16, 0.7, 'steel'), P(-0.55, 1.25, -0.9, -0.48, 2.1, -0.83, 'steel'),
      P(0.48, 1.25, -0.9, 0.55, 2.1, -0.83, 'steel'), P(-0.6, 0, -1.0, 0.6, 0.15, 0.7, 'rubber')],
  },
  pallet_jack: {
    boxes: [P(-0.27, 0, -0.6, -0.1, 0.09, 0.6, 'red'), P(0.1, 0, -0.6, 0.27, 0.09, 0.6, 'red'),
      P(-0.3, 0, 0.6, 0.3, 0.35, 0.8, 'red'), P(-0.03, 0.35, 0.7, 0.03, 1.2, 0.76, 'steel')],
  },
  hand_truck: { boxes: [P(-0.25, 0.05, -0.05, 0.25, 1.2, 0.05, 'steel'), P(-0.2, 0, -0.25, 0.2, 0.05, 0.05, 'steel')] },
  roll_cage: { boxes: [P(-0.4, 0, -0.35, 0.4, 1.8, 0.35, 'steel', { cls: 'mesh' })] },
  shelf: { boxes: [P(-0.5, 0, -0.25, 0.5, 2.0, 0.25, 'steel')] },
  sofa: { boxes: [P(-1.0, 0, -0.45, 1.0, 0.45, 0.45, 'fabric'), P(-1.0, 0.45, 0.25, 1.0, 0.85, 0.45, 'fabric')] },
  mattress: { boxes: [P(-0.7, 0, -1.0, 0.7, 0.2, 1.0, 'fabric')] },
  table: { boxes: [P(-0.6, 0.72, -0.4, 0.6, 0.76, 0.4, 'wood'), P(-0.05, 0, -0.05, 0.05, 0.72, 0.05, 'steel')] },
  chair: {
    boxes: [P(-0.22, 0.43, -0.22, 0.22, 0.47, 0.22, 'plastic'), P(-0.22, 0.47, 0.18, 0.22, 0.9, 0.22, 'plastic'),
      P(-0.03, 0, -0.03, 0.03, 0.43, 0.03, 'steel')],
  },
  tv: { boxes: [P(-0.5, 0, -0.2, 0.5, 0.6, 0.2, 'wood'), P(-0.5, 0.6, -0.04, 0.5, 1.2, 0.04, 'dark')] },
  fridge: { boxes: [P(-0.3, 0, -0.3, 0.3, 1.8, 0.3, 'white')] },
  lockers: { boxes: [P(-0.8, 0, -0.25, 0.8, 1.9, 0.25, 'steel')] },
  desk: {
    boxes: [P(-0.8, 0.72, -0.4, 0.8, 0.75, 0.4, 'wood'), P(-0.8, 0, -0.4, -0.75, 0.72, 0.4, 'wood'),
      P(0.75, 0, -0.4, 0.8, 0.72, 0.4, 'wood'), P(-0.25, 0.75, 0.15, 0.25, 1.1, 0.2, 'dark')],
  },
  control_desk: {
    boxes: [P(-2.0, 0, -0.5, 2.0, 0.8, 0.5, 'machine'), P(-1.8, 0.8, 0.1, -0.7, 1.3, 0.15, 'dark'),
      P(-0.55, 0.8, 0.1, 0.55, 1.3, 0.15, 'dark'), P(0.7, 0.8, 0.1, 1.8, 1.3, 0.15, 'dark')],
  },
  server_rack: { boxes: [P(-0.3, 0, -0.5, 0.3, 2.0, 0.5, 'dark')] },
  el_cabinet: { boxes: [P(-0.6, 0, -0.25, 0.6, 2.0, 0.25, 'cladding')] },
  boiler: { boxes: [P(-0.6, 0, -0.6, 0.6, 2.2, 0.6, 'red')] },
  pump: { boxes: [P(-0.4, 0, -0.6, 0.4, 0.8, 0.6, 'machine')] },
  safe: { boxes: [P(-0.4, 0, -0.4, 0.4, 1.2, 0.4, 'dark')] },
  cash_table: {
    boxes: [P(-1.0, 0.72, -0.5, 1.0, 0.76, 0.5, 'wood'), P(-0.95, 0, -0.45, -0.88, 0.72, 0.45, 'steel'),
      P(0.88, 0, -0.45, 0.95, 0.72, 0.45, 'steel'), P(-0.6, 0.76, -0.2, -0.1, 0.9, 0.1, 'grass'),
      P(0.1, 0.76, -0.3, 0.5, 0.86, 0.0, 'grass'), P(0.6, 0.76, 0.0, 0.85, 0.95, 0.25, 'dark')],
  },
  lab_table: {
    boxes: [P(-1.0, 0, -0.4, 1.0, 0.9, 0.4, 'steel'), P(-0.7, 0.9, -0.2, -0.3, 1.2, 0.2, 'steel'),
      P(0.2, 0.9, -0.15, 0.45, 1.25, 0.05, 'plastic'), P(0.55, 0.9, -0.1, 0.75, 1.1, 0.1, 'white')],
  },
  drum: { boxes: [P(-0.3, 0, -0.3, 0.3, 0.9, 0.3, 'plastic')] },
  gas_bottles: { boxes: [P(-0.4, 0, -0.15, 0.4, 1.5, 0.15, 'machine')] },
  sheeting: { boxes: [P(-1.5, 0, -0.02, 1.5, 2.6, 0.02, 'wrap', { cls: 'mesh' })] },
  trailer: {
    boxes: [P(-1.25, 1.15, -6.8, 1.25, 4.0, 6.8, 'white'), P(-1.2, 0, 3.6, 1.2, 1.15, 6.0, 'rubber'),
      P(-1.0, 0, -4.8, 1.0, 1.15, -4.4, 'steel')],
  },
  truck: {
    boxes: [P(-1.25, 1.1, -1.6, 1.25, 3.8, 5.0, 'white'), P(-1.25, 0.4, -3.6, 1.25, 3.0, -1.7, 'red'),
      P(-1.1, 0, -3.6, 1.1, 0.4, 5.0, 'rubber'), P(-1.1, 0.4, -1.7, 1.1, 1.1, 5.0, 'dark')],
  },
  container20: { boxes: [P(-1.22, 0, -3.03, 1.22, 2.59, 3.03, 'red')] },
  container40: { boxes: [P(-1.22, 0, -6.1, 1.22, 2.59, 6.1, 'plastic')] },
  booth: { boxes: [P(-1.5, 0, -1.5, 1.5, 2.6, 1.5, 'white')] },
  skip: { boxes: [P(-1.0, 0, -1.8, 1.0, 1.4, 1.8, 'yellow')] },
  car: { boxes: [P(-0.9, 0, -2.2, 0.9, 0.75, 2.2, 'cladding'), P(-0.8, 0.75, -1.2, 0.8, 1.4, 0.9, 'dark')] },
  van: { boxes: [P(-1.0, 0, -2.6, 1.0, 1.0, 2.6, 'white'), P(-1.0, 1.0, -1.2, 1.0, 2.4, 2.6, 'white'),
    P(-0.95, 1.0, -2.0, 0.95, 1.8, -1.2, 'dark')] },
  bollard: { boxes: [P(-0.1, 0, -0.1, 0.1, 1.0, 0.1, 'yellow')] },
  charger: { boxes: [P(-0.4, 0, -0.15, 0.4, 1.4, 0.15, 'machine')] },
  robot_base: { boxes: [P(-0.6, 0, -0.6, 0.6, 0.8, 0.6, 'yellow')] },
  bins: { boxes: [P(-0.6, 0, -0.4, 0.6, 0.9, 0.4, 'plastic')] },
  // light fixtures: emissive housings, bound to a circuit at instance level (lights.js)
  lamp_highbay: { boxes: [P(-0.3, -0.15, -0.3, 0.3, 0, 0.3, 'dark', { emit: 6 })], noCollide: true },
  lamp_tube: { boxes: [P(-0.75, -0.06, -0.08, 0.75, 0, 0.08, 'white', { emit: 4 })], noCollide: true },
};
