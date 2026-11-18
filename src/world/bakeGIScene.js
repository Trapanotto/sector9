// Converts the layout's solid boxes into the occluder/albedo description used by the irradiance bake.
// Pure data (no three.js) so it also runs in Node (scripts/bake-bench.mjs).
import { BUILDINGS, HOLES, ZONES, GI_GRID, floorMatAt, H } from './layout.js';

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
  earth: rgb(70, 64, 58, 0.8),
};

const PROP_MAT = {
  crate: 'wood', pallets: 'wood', barrel: 'barrel', conveyor: 'paint', press: 'paint', mill: 'paint', tank: 'paintGrey',
  cabinets: 'paintGrey', workbench: 'wood', generator: 'paint', vending: 'paintRed', desk: 'wood', filing: 'paintGrey',
  shelf: 'steel', lockers: 'paintBlue', bench: 'wood', console: 'paintGrey', table: 'wood', rack: 'paintBlue',
  forklift: 'yellow', container: 'rust', trailer: 'paintGrey', dumpster: 'paint', van: 'paintGrey', barrier: 'concreteOut',
  counter: 'paintGrey', pump: 'paintBlue', boiler: 'paintRed', furnace: 'rust', ladle: 'rust', weldbooth: 'paintRed',
  firebarrel: 'rust', barrierarm: 'paintGrey', wagon: 'rust', flatcar: 'wood', floodlight: 'steel',
};
const FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];   // matches kernel face order (+x,-x,+y,-y,+z,-z)

// Ground, slab and earth as a set of boxes: the ground slab (y -0.4..0) everywhere except floor openings, earth
// below it except the basement rooms, casting pits open down to their floor.
function groundBoxes(layout) {
  const X0 = GI_GRID.x0 - 12, X1 = GI_GRID.x1 + 12, Z0 = GI_GRID.z0 - 12, Z1 = GI_GRID.z1 + 12, Y0 = GI_GRID.y0 - 1.2;
  const base = ZONES.filter((z) => ['tunnel', 'pump', 'boiler'].includes(z.name)).flatMap((z) => z.boxes.map((b) => [b.min[0], b.max[0], b.min[2], b.max[2]]));
  for (const d of layout.doors) {
    if ((d.y || 0) > -1) continue;
    const h = d.width / 2;
    base.push(d.normal === 'z' ? [d.center[0] - h, d.center[0] + h, d.t0, d.t1] : [d.t0, d.t1, d.center[1] - h, d.center[1] + h]);
  }
  const holes = HOLES.map((h) => [h.x0, h.x1, h.z0, h.z1]);
  const pits = HOLES.filter((h) => h.name.startsWith('pit')).map((h) => [h.x0, h.x1, h.z0, h.z1]);
  const xs = new Set([X0, X1]), zs = new Set([Z0, Z1]);
  for (const r of [...base, ...holes, ...BUILDINGS.map((b) => [b.min[0], b.max[0], b.min[1], b.max[1]])]) { xs.add(r[0]); xs.add(r[1]); zs.add(r[2]); zs.add(r[3]); }
  for (let v = Math.ceil(X0); v <= X1; v += 4) xs.add(v);       // material changes (lino rooms) resolve on a 4 m grid
  for (let v = Math.ceil(Z0); v <= Z1; v += 4) zs.add(v);
  const XS = [...xs].sort((a, b) => a - b), ZS = [...zs].sort((a, b) => a - b);
  const inR = (rs, x, z) => rs.some((r) => x > r[0] && x < r[1] && z > r[2] && z < r[3]);
  const out = [];
  for (let j = 0; j < ZS.length - 1; j++) {
    let run = null;
    const flush = () => { if (run) { out.push(run); run = null; } };
    for (let i = 0; i < XS.length - 1; i++) {
      const x = (XS[i] + XS[i + 1]) / 2, z = (ZS[j] + ZS[j + 1]) / 2;
      const hole = inR(holes, x, z), air = inR(base, x, z), pit = inR(pits, x, z);
      const slab = hole ? null : (floorMatAt(x, z) || 'floor');
      const sig = `${slab}|${air}|${pit}`;
      if (run && run.sig === sig && Math.abs(run.x1 - XS[i]) < 1e-9) { run.x1 = XS[i + 1]; continue; }
      flush();
      run = { sig, x0: XS[i], x1: XS[i + 1], z0: ZS[j], z1: ZS[j + 1], slab, air, pit };
    }
    flush();
  }
  const boxes = [];
  for (const r of out) {
    if (r.slab) boxes.push({ min: [r.x0, -0.4, r.z0], max: [r.x1, 0, r.z1], mat: { py: r.slab, ny: 'ceiling', px: 'ceiling', nx: 'ceiling', pz: 'ceiling', nz: 'ceiling' } });
    if (!r.air) boxes.push({ min: [r.x0, H.base, r.z0], max: [r.x1, r.pit ? -1.6 : -0.4, r.z1], mat: r.pit ? 'floor' : 'earth' });
    boxes.push({ min: [r.x0, Y0, r.z0], max: [r.x1, H.base, r.z1], mat: 'floor' });
  }
  return boxes;
}

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
  for (const b of groundBoxes(layout)) add(b.min, b.max, b.mat);

  const propType = new Map();
  for (const p of layout.props) if (p.min && p.max) propType.set(p.min, p.type);
  for (const s of layout.solids) {
    if (s.kind === 'rail' || s.kind === 'under') continue;   // invisible colliders do not block light
    let mat = s.mat;
    if (s.kind === 'prop') mat = PROP_MAT[propType.get(s.min)] ?? (s.surface === 'metal' ? 'steel' : 'wood');
    if (s.kind === 'leaf') { if (!s.ray) continue; mat = 'rust'; }   // animated doors start closed: not baked open
    add(s.min, s.max, mat);
  }
  for (const e of extra) add(e.min, e.max, e.mat);
  return { boxes, albedo: new Float32Array(alb) };
}
