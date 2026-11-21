// Atlas tile table for the world art (workstream A). Pure data + a deterministic shelf packer, so the Node tests
// and the browser agree on every UV rect. The pixels are painted at load time by atlas.js (browser only).
//
// kind 'rep' = tileable (uv in tile units may exceed 1), 'fit' = one picture per face (labels, signs, sides).
// alpha: the painter writes alpha; texels with alpha < 0.5 are discarded (cut-outs: pallets, wire decks, lacing).

export const ATLAS_W = 2048;
export const GUTTER = 8;

const T = (w, h, kind = 'rep', alpha = false) => ({ w, h, kind, alpha });
export const TILE_DEFS = {
  // generic surfaces (tinted by vertex colour)
  paint: T(256, 256), steel: T(256, 256), plastic: T(128, 128), rubber: T(128, 128), tread: T(128, 128),
  hazard: T(256, 64), wood: T(256, 128), woodboard: T(256, 256), laminate: T(128, 128),
  galv: T(128, 128), concrete: T(128, 128), glassdark: T(64, 64), light: T(64, 64),
  // packaging
  cardboard: T(256, 256), carton: T(256, 256, 'fit'), carton2: T(256, 256, 'fit'), cartonstack: T(256, 256, 'fit'),
  wrap: T(256, 256, 'fit'), wraptop: T(128, 128, 'fit'), brick: T(128, 64, 'fit'), money: T(128, 64, 'fit'),
  pallet_side: T(256, 48, 'fit', true), pallet_end: T(192, 48, 'fit', true), pallet_top: T(256, 192, 'fit', true),
  // racking
  upright: T(64, 256), beam: T(128, 32), lacing: T(128, 256, 'rep', true), wiredeck: T(128, 128, 'rep', true),
  mesh: T(128, 128, 'rep', true), labels: T(256, 128, 'fit'), loadsign: T(128, 96, 'fit'),
  // signage / screens / decals
  signs: T(512, 512, 'fit'), screen: T(256, 128, 'fit'), panel: T(256, 128, 'fit'), floorline: T(64, 64),
  stencil: T(512, 128, 'fit'), decals: T(256, 256, 'fit'), facade: T(1024, 80, 'fit'), slats: T(128, 128),
  // vehicles / machines
  container: T(256, 256), trailer: T(512, 128, 'fit'), tarp: T(256, 256), belt: T(128, 128), roller: T(64, 64),
  // furniture / gang
  fabric: T(128, 128), mattress: T(256, 256, 'fit'), cabinet: T(128, 256, 'fit'), locker: T(128, 256, 'fit'),
  drum: T(128, 128), trash: T(128, 128, 'fit'), totes: T(128, 128),
};

function pack() {
  const names = Object.keys(TILE_DEFS).sort((a, b) => (TILE_DEFS[b].h - TILE_DEFS[a].h) || (TILE_DEFS[b].w - TILE_DEFS[a].w) || (a < b ? -1 : 1));
  const out = {};
  let x = 0, y = 0, rowH = 0;
  for (const n of names) {
    const d = TILE_DEFS[n], w = d.w + GUTTER * 2, h = d.h + GUTTER * 2;
    if (x + w > ATLAS_W) { x = 0; y += rowH; rowH = 0; }
    out[n] = { ...d, x: x + GUTTER, y: y + GUTTER };
    x += w; rowH = Math.max(rowH, h);
  }
  const H = 1 << Math.ceil(Math.log2(y + rowH));
  for (const n of names) {
    const t = out[n];
    // normalised GL rect (v from the bottom: the canvas is uploaded with flipY)
    t.q = [Math.round(t.x / ATLAS_W * 65535), Math.round((H - t.y - t.h) / H * 65535), Math.round(t.w / ATLAS_W * 65535), Math.round(t.h / H * 65535)];
  }
  return { tiles: out, height: H };
}

const P = pack();
export const TILES = P.tiles;
export const ATLAS_H = P.height;

// sub-rects of sheet tiles (fit faces): [u0, v0, u1, v1] in 0..1 of the tile, v up
export const cell = (cols, rows, i) => { const c = i % cols, r = Math.floor(i / cols); return [c / cols, 1 - (r + 1) / rows, (c + 1) / cols, 1 - r / rows]; };
export const SIGN = {
  notausgang_l: 0, notausgang_r: 1, feuerloescher: 2, rauchen: 3, stapler: 4, gehoerschutz: 5, zutritt: 6,
  spannung: 7, tor1: 8, tor2: 9, tor3: 10, tor4: 11, tor5: 12, erstehilfe: 13, automatik: 14, sammel: 15,
};
export const signSub = (name) => cell(4, 4, SIGN[name]);
