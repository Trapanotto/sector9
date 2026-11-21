// Analytic sky radiance used by the bake (JS) — mirrored in GLSL by src/render/sky.js (skyRadiance()).
// Keep both in sync (owner: B). dir must be normalised. Writes linear RGB into out[0..2].
export function skyRadiance(sky, sun, dx, dy, dz, out) {
  if (dy < 0) {
    const g = sky.scale;
    out[0] = sky.ground[0] * g; out[1] = sky.ground[1] * g; out[2] = sky.ground[2] * g;
    return out;
  }
  const t = Math.sqrt(Math.min(1, dy));
  const cs = Math.max(0, dx * sun.dir[0] + dy * sun.dir[1] + dz * sun.dir[2]);
  const glow = sky.glow * Math.pow(cs, 8);
  for (let c = 0; c < 3; c++) out[c] = (sky.horizon[c] + (sky.zenith[c] - sky.horizon[c]) * t + glow * sun.color[c]) * sky.scale;
  return out;
}
