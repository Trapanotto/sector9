// Deterministic shelf packer for the lightmap atlas. Each face gets an inner texel rect (x, y, w, h) with a
// 1-texel gutter around it (filled by dilation in the bake) so bilinear filtering never bleeds across faces.
// Face u (TAN[axis][0]) maps to texel x, face v to texel y; edges of the face lie on texel edges.
export const ATLAS_W = 2048, ATLAS_MAX_H = 2048, GUTTER = 1, RESERVED = 4;
/** uv of the reserved black texel */
export const BLACK_TEXEL = [1.5, 1.5];

export function packLightmap(faces, { density, width = ATLAS_W, maxH = ATLAS_MAX_H } = {}) {
  let scale = 1;
  for (let iter = 0; iter < 24; iter++) {
    const items = faces.map((f, i) => {
      const d = density(f) * scale;
      const w = Math.min(512, Math.max(2, Math.ceil((f.u1 - f.u0) * d)));
      const h = Math.min(512, Math.max(2, Math.ceil((f.v1 - f.v0) * d)));
      return { i, w, h, pw: w + 2 * GUTTER, ph: h + 2 * GUTTER };
    });
    // stable order: tallest first, then widest, then original index
    items.sort((a, b) => b.ph - a.ph || b.pw - a.pw || a.i - b.i);
    // texels (0..3, 0..3) are reserved and stay black: vertex-lit geometry points its lightmap uv there
    let x = RESERVED, y = 0, shelfH = RESERVED;
    for (const it of items) {
      if (x + it.pw > width) { y += shelfH; x = 0; shelfH = 0; }
      it.x = x + GUTTER; it.y = y + GUTTER;
      x += it.pw; shelfH = Math.max(shelfH, it.ph);
    }
    const used = y + shelfH;
    if (used <= maxH) {
      for (const it of items) faces[it.i].lmRect = [it.x, it.y, it.w, it.h];
      const height = Math.ceil(used / 16) * 16;
      return { width, height, scale, texels: items.reduce((s, it) => s + it.w * it.h, 0) };
    }
    scale *= Math.max(0.7, Math.sqrt(maxH / used) * 0.98);
  }
  throw new Error('lightmap atlas does not fit');
}
