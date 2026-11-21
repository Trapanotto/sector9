// Daylight + artificial light fixtures for the offline bake. Owner: B (lighting/bake quality).
// Units: lightmaps store irradiance/π ("radiance factor"); a white surface lit by the sun at normal incidence
// shows sun.intensity. Exposure is automatic at runtime (bodycam auto-exposure).
//
// Artificial light is baked into a SEPARATE lightmap/probe layer per circuit group so staged moments can cut it
// at runtime: ctx.world.lights.setCircuit(id, level). Each lightmapped face/vertex carries the circuit of the zone
// it belongs to (see zones' `circuit` in site.js).

const deg = Math.PI / 180;
const az = 35 * deg, el = 36 * deg;   // sun azimuth measured from south towards west, elevation

export const SUN = {
  dir: [-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)],   // towards the sun
  color: [1.0, 0.93, 0.82], intensity: 3.2,
};
// Sky radiance model (also mirrored in the sky shader, src/render/sky.js): horizon → zenith gradient + sun glow.
export const SKY = {
  zenith: [0.32, 0.50, 0.95], horizon: [1.05, 1.08, 1.12], ground: [0.22, 0.21, 0.19], glow: 0.9, scale: 0.85,
};

export const CIRCUITS = {
  // id: default level (0..1). 'aussen' = yard floodlights, off by day.
  halle: 1, auto: 1, west_eg: 1, og: 1, keller: 1, kuehl: 1, aussen: 0,
};
export const CIRCUIT_IDS = Object.keys(CIRCUITS);

const L = (type, x, y, z, circuit, intensity, color, o = {}) => ({ type, pos: [x, y, z], circuit, intensity, color, ...o });
const LED = [1.0, 0.97, 0.92], TUBE = [0.92, 1.0, 0.94], SODIUM = [1.0, 0.78, 0.48];

function hallLamps() {
  const out = [];
  const xs = [33.9, 39.3, 44.7, 50.1, 55.5, 60.9, 66.3], zs = [3, 10, 17, 24, 29.5, 36, 43, 50, 58];
  for (const x of xs) for (const z of zs) out.push(L('highbay', x, 11.6, z, 'halle', 16, LED, { range: 18 }));
  for (const x of [76.5, 81.5]) for (let z = 8; z < 64; z += 8) out.push(L('highbay', x, 11.6, z, 'auto', 16, LED, { range: 18 }));
  for (const z of [6, 16, 26]) out.push(L('highbay', 89.7, 11.6, z, 'auto', 10, LED, { range: 14 }));
  for (const x of [6, 14, 22]) for (const z of [40, 48, 56]) out.push(L('highbay', x, 7.7, z, 'west_eg', 9, LED, { range: 14 }));
  for (const x of [6, 14, 22]) out.push(L('highbay', x, 7.7, 30, 'west_eg', 8, LED, { range: 14 }));
  return out;
}

export const FIXTURES = [
  ...hallLamps(),
  // under-mezzanine tubes (y just below the slab at 4.2)
  L('tube', 6, 4.14, 15.5, 'west_eg', 2.2, TUBE), L('tube', 14, 4.14, 15.5, 'west_eg', 2.2, TUBE),
  L('tube', 6, 4.14, 20.5, 'west_eg', 2.2, TUBE), L('tube', 14, 4.14, 20.5, 'west_eg', 2.2, TUBE),
  L('tube', 3, 4.14, 4, 'west_eg', 2.0, TUBE), L('tube', 6.5, 4.14, 8.5, 'west_eg', 2.0, TUBE),       // Labor
  L('tube', 14, 4.14, 4, 'west_eg', 2.0, TUBE), L('tube', 18, 4.14, 8, 'west_eg', 2.0, TUBE),        // Sozialraum
  L('tube', 25, 4.14, 6, 'west_eg', 1.6, TUBE), L('tube', 25, 4.14, 14.5, 'west_eg', 1.6, TUBE),     // Lager, Treppe
  // mezzanine rooms (ceiling = roof underside at 8.0)
  L('tube', 4.5, 7.94, 4.5, 'og', 2.4, TUBE), L('tube', 13.5, 7.94, 4.5, 'og', 2.0, TUBE),
  L('tube', 23, 7.94, 4.5, 'og', 2.0, TUBE), L('tube', 6, 7.94, 10.5, 'og', 1.6, TUBE),
  L('tube', 18, 7.94, 10.5, 'og', 1.6, TUBE), L('tube', 25, 7.94, 14.5, 'og', 1.6, TUBE),
  L('tube', 7, 7.94, 18, 'og', 1.8, TUBE), L('tube', 18, 7.94, 18, 'og', 1.8, TUBE),
  // basement (warm, dim)
  L('bulb', 3, -0.4, 44, 'keller', 1.6, SODIUM, { range: 9 }), L('bulb', 9, -0.4, 48, 'keller', 1.6, SODIUM, { range: 9 }),
  L('bulb', 18, -0.4, 47.6, 'keller', 1.2, SODIUM, { range: 8 }), L('bulb', 24.5, -0.4, 47.6, 'keller', 1.2, SODIUM, { range: 8 }),
  L('bulb', 13.3, -0.4, 47.6, 'keller', 1.0, SODIUM, { range: 7 }), L('bulb', 29.6, -0.4, 47.6, 'keller', 1.0, SODIUM, { range: 7 }),
  // cold store
  L('tube', 89, 3.44, 55, 'kuehl', 2.0, [0.85, 0.95, 1.0]), L('tube', 93, 3.44, 60, 'kuehl', 2.0, [0.85, 0.95, 1.0]),
  // yard floodlights on the facade (off by day; circuit 'aussen')
  L('flood', 12, 7.5, 64.6, 'aussen', 30, SODIUM, { range: 30 }), L('flood', 50, 11, 64.6, 'aussen', 30, SODIUM, { range: 30 }),
  L('flood', 82, 11, 64.6, 'aussen', 30, SODIUM, { range: 30 }),
];
