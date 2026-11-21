// Surface classes: greybox albedo (linear RGB), bullet/footstep material, lightmap density.
// Owner: B (materials) may retune colours/density; A/C/E read `sound` / `impact`.
// `impact` is what worldHit() reports as `surface` (used for decals, impact FX and sounds).

export const SURF = {
  concrete:  { color: [0.42, 0.41, 0.39], impact: 'concrete' },
  floor:     { color: [0.36, 0.35, 0.33], impact: 'concrete' },   // hall floor, slightly darker sealed concrete
  asphalt:   { color: [0.16, 0.16, 0.16], impact: 'concrete' },
  grass:     { color: [0.12, 0.16, 0.07], impact: 'dirt' },
  plaster:   { color: [0.70, 0.69, 0.66], impact: 'plaster' },    // painted interior walls
  tile:      { color: [0.62, 0.64, 0.63], impact: 'tile' },
  cladding:  { color: [0.50, 0.53, 0.56], impact: 'metal' },      // corrugated steel facade / partition
  roof:      { color: [0.46, 0.46, 0.45], impact: 'metal' },
  steel:     { color: [0.30, 0.31, 0.33], impact: 'metal' },
  grating:   { color: [0.33, 0.33, 0.32], impact: 'metal' },
  yellow:    { color: [0.80, 0.60, 0.05], impact: 'metal' },      // safety yellow (railings, bollards)
  rackBlue:  { color: [0.08, 0.17, 0.42], impact: 'metal' },      // rack uprights
  rackOrange:{ color: [0.85, 0.32, 0.04], impact: 'metal' },      // rack beams
  wood:      { color: [0.52, 0.40, 0.26], impact: 'wood' },       // pallets
  cardboard: { color: [0.55, 0.42, 0.27], impact: 'cardboard' },
  wrap:      { color: [0.75, 0.76, 0.76], impact: 'cardboard' },  // shrink-wrapped loads
  plastic:   { color: [0.20, 0.32, 0.45], impact: 'plastic' },    // totes, bins
  machine:   { color: [0.38, 0.44, 0.40], impact: 'metal' },      // machine green-grey
  rubber:    { color: [0.06, 0.06, 0.06], impact: 'rubber' },
  fabric:    { color: [0.25, 0.22, 0.20], impact: 'fabric' },     // sofa, mattress
  door:      { color: [0.45, 0.47, 0.50], impact: 'metal' },
  white:     { color: [0.80, 0.80, 0.78], impact: 'metal' },      // fridge, cold store panels
  red:       { color: [0.50, 0.07, 0.05], impact: 'metal' },
  dark:      { color: [0.10, 0.10, 0.11], impact: 'metal' },
  glass:     { color: [0.60, 0.66, 0.68], impact: 'glass' },
  far:       { color: [0.30, 0.29, 0.26], impact: 'concrete' },   // backdrop ground/buildings
};

// Lightmap texels per metre for architecture faces, by surface (default 5). Keep small for huge outdoor areas.
export const LM_DENSITY = { asphalt: 2, grass: 1.0, roof: 4, far: 0.25, cladding: 5 };
export const LM_DENSITY_DEFAULT = 8;
