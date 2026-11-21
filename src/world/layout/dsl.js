// Tiny constructors for layout elements. Everything in the greybox is an AXIS-ALIGNED box (AABB) so that the
// offline bake, collision, nav and bullets can all share one cheap box BVH. Visual replacement meshes (art, A)
// may be arbitrary; the proxies stay the gameplay/bake truth.
//
// Coordinates: metres. +x east, +y up, +z south. Building interior x 0..96, z 0..64, ground floor top y = 0.
//
// Face bits (used by `hide`): +x 1, -x 2, +y 4, -y 8, +z 16, -z 32.
export const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32, ALL_SIDES = 1 | 2 | 16 | 32;

/** Raw box. `cls`: 'arch' (lightmapped architecture), 'prop' (static, vertex-baked light), 'mesh' (see-through
 *  fence/curtain, drawn transparent, not a light/sight occluder), 'far' (backdrop, vertex-baked), 'collider'
 *  (invisible blocker). */
export function box(min, max, o = {}) { return { t: 'box', min, max, ...o }; }

/** Floor/roof slab: rectangle x0..x1, z0..z1, thickness y0..y1, rectangular holes [[x0,z0,x1,z1],...].
 *  `hide` masks top/bottom faces (PY/NY); `hideOuter` hides side faces lying on the outer rectangle. */
export function slab(x0, z0, x1, z1, y0, y1, o = {}) { return { t: 'slab', x0, z0, x1, z1, y0, y1, holes: [], ...o }; }

/** Wall running along X at depth z (centre), from x0 to x1, height y0..y1, thickness th.
 *  openings: [{ a, b, y0, y1, glass?, door? }] with a..b absolute x. */
export function wallX(z, x0, x1, y0, y1, th, o = {}) {
  return { t: 'wall', axis: 'x', at: z, from: x0, to: x1, y0, y1, th, openings: [], ...o };
}
/** Wall running along Z at x (centre), from z0 to z1. openings a..b absolute z. */
export function wallZ(x, z0, z1, y0, y1, th, o = {}) {
  return { t: 'wall', axis: 'z', at: x, from: z0, to: z1, y0, y1, th, openings: [], ...o };
}
/** Opening in a wall. `door`: { id, kind: 'swing'|'roller'|'slide', state: 'closed'|'open'|'half'|'locked',
 *  hinge: 'a'|'b', zones: [zoneA, zoneB], name }. `glass`: { id?, breakable } for windows. */
export function hole(a, b, y0, y1, o = {}) { return { a, b, y0, y1, ...o }; }

/** Solid stair (each step a box from y0 up to its tread). `dir`: direction of ASCENT ('+x','-x','+z','-z'). */
export function stairs(x0, z0, x1, z1, y0, y1, dir, steps, o = {}) {
  return { t: 'stairs', x0, z0, x1, z1, y0, y1, dir, steps, ...o };
}
/** Railing along an axis at `at`, from..to, standing on y. Adds an invisible collider panel. */
export function rail(axis, at, from, to, y, o = {}) { return { t: 'rail', axis, at, from, to, y, ...o }; }
