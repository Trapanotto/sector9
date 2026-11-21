// Analytic sky radiance used by the bake (JS) — mirrored in GLSL by src/render/sky.js (SKY_GLSL below is the
// single source for the shader side). Keep both in sync (owner: B). dir must be normalised. Writes linear RGB.
//
// Clear, slightly hazy afternoon: bright milky horizon, moderately blue zenith, a broad forward-scattering
// glow around the sun. The sun disc itself is NOT part of skyRadiance (the bake treats the sun as a separate
// directional light with soft shadows); the sky shader adds the disc on top.

/** transmission of one glass pane (windows, skylights) for sun and sky light in the bake */
export const GLASS_T = 0.78;
/** environment cube face resolution in the bake (per zone) */
export const ENV_SIZE = 16;
/** probe volume grid (bake + runtime leak-free sampler) */
export const PROBE_GRID = { origin: [-16, -4, -16], spacing: 1, dims: [129, 19, 127] };

export function skyRadiance(sky, sun, dx, dy, dz, out) {
  const g = sky.scale;
  if (dy < 0) {
    // below the horizon: ground, fading in from the horizon haze within a few degrees
    const f = Math.min(1, -dy / 0.08), h = 1 - f;
    for (let c = 0; c < 3; c++) out[c] = (sky.horizon[c] * 0.85 * h + sky.ground[c] * f) * g;
    return out;
  }
  const t = Math.pow(Math.min(1, dy), 0.45);
  const cs = Math.max(0, dx * sun.dir[0] + dy * sun.dir[1] + dz * sun.dir[2]);
  const glow = sky.glow * (Math.pow(cs, 6) * 0.6 + Math.pow(cs, 64) * 1.6);
  for (let c = 0; c < 3; c++) out[c] = (sky.horizon[c] + (sky.zenith[c] - sky.horizon[c]) * t + glow * sun.color[c]) * g;
  return out;
}

/** GLSL twin of skyRadiance (uniforms uZenith, uHorizon, uGround, uGlow, uScale, uSunDir, uSunColor) */
export const SKY_GLSL = /* glsl */`
vec3 skyRadiance(vec3 d) {
  if (d.y < 0.0) {
    float f = min(1.0, -d.y / 0.08);
    return mix(uHorizon * 0.85, uGround, f) * uScale;
  }
  float t = pow(min(1.0, d.y), 0.45);
  float cs = max(0.0, dot(d, uSunDir));
  float c2 = cs * cs, c4 = c2 * c2, c8 = c4 * c4, c16 = c8 * c8, c64 = c16 * c16 * c16 * c16;
  float glow = uGlow * (c4 * c2 * 0.6 + c64 * 1.6);
  return (uHorizon + (uZenith - uHorizon) * t + glow * uSunColor) * uScale;
}
`;
