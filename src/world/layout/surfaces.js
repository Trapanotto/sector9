// Surface classes: greybox albedo (linear RGB), bullet/footstep material, lightmap density, shading.
// Owner: B (materials) may retune colours/density; A/C/E read `sound` / `impact`.
// `impact` is what worldHit() reports as `surface` (used for decals, impact FX and sounds).
//
// `color` is the AVERAGE linear albedo: the bake uses it as is, the runtime multiplies it with the material
// layer's texture normalised to mean 1 (materials.json `mean`), so baked bounce and on-screen brightness agree.
// `mat` = [layer, tile size in m, specular strength 0..1, roughness 0..1] (layers: public/assets/materials).
// Keep at most 32 surfaces (shader table size); unknown surfaces render with the 'flat' layer.

export const SURF = {
  concrete:  { color: [0.40, 0.39, 0.37], impact: 'concrete', mat: ['concrete', 2.5, 0.35, 0.85] },
  floor:     { color: [0.34, 0.33, 0.31], impact: 'concrete', mat: ['floor', 3.2, 1.0, 0.42] },     // sealed hall floor
  asphalt:   { color: [0.13, 0.13, 0.13], impact: 'concrete', mat: ['asphalt', 3.0, 0.25, 0.9] },
  grass:     { color: [0.10, 0.13, 0.06], impact: 'dirt', mat: ['flat', 2, 0, 1] },
  plaster:   { color: [0.62, 0.61, 0.58], impact: 'plaster', mat: ['block', 1.2, 0.3, 0.7] },     // painted blockwork
  tile:      { color: [0.52, 0.54, 0.53], impact: 'tile', mat: ['lino', 2.0, 0.6, 0.35] },
  cladding:  { color: [0.50, 0.52, 0.54], impact: 'metal', mat: ['trapez', 1.0, 0.6, 0.42] },  // trapezoidal sheet
  roof:      { color: [0.46, 0.46, 0.45], impact: 'metal', mat: ['trapez', 1.0, 0.35, 0.5] },
  steel:     { color: [0.30, 0.31, 0.33], impact: 'metal', mat: ['plate', 1.0, 0.7, 0.4] },
  grating:   { color: [0.30, 0.30, 0.29], impact: 'metal', mat: ['grating', 0.5, 0.4, 0.55] },
  yellow:    { color: [0.72, 0.52, 0.04], impact: 'metal', mat: ['paint', 1.0, 0.5, 0.45] },  // safety yellow
  rackBlue:  { color: [0.06, 0.14, 0.36], impact: 'metal', mat: ['paint', 1.0, 0.3, 0.45] },   // rack uprights
  rackOrange:{ color: [0.78, 0.27, 0.03], impact: 'metal', mat: ['paint', 1.0, 0.3, 0.45] },   // rack beams
  wood:      { color: [0.46, 0.35, 0.22], impact: 'wood', mat: ['wood', 1.2, 0.1, 0.85] },    // pallets
  cardboard: { color: [0.50, 0.37, 0.22], impact: 'cardboard', mat: ['cardboard', 0.8, 0.1, 0.9] },
  wrap:      { color: [0.70, 0.71, 0.72], impact: 'cardboard', mat: ['wrap', 1.0, 0.8, 0.22] }, // shrink-wrapped loads
  plastic:   { color: [0.18, 0.29, 0.42], impact: 'plastic', mat: ['flat', 0.5, 0.5, 0.35] },  // totes, bins
  machine:   { color: [0.34, 0.40, 0.36], impact: 'metal', mat: ['paint', 1.0, 0.5, 0.45] },   // machine green-grey
  rubber:    { color: [0.05, 0.05, 0.05], impact: 'rubber', mat: ['flat', 1, 0.2, 0.8] },
  fabric:    { color: [0.22, 0.19, 0.17], impact: 'fabric', mat: ['flat', 0.5, 0, 1] },        // sofa, mattress
  door:      { color: [0.42, 0.44, 0.47], impact: 'metal', mat: ['paint', 1.0, 0.5, 0.45] },
  white:     { color: [0.74, 0.74, 0.72], impact: 'metal', mat: ['sandwich', 1.0, 0.5, 0.38] },  // fridge, cold store panels
  red:       { color: [0.45, 0.06, 0.04], impact: 'metal', mat: ['paint', 1.0, 0.5, 0.4] },
  dark:      { color: [0.08, 0.08, 0.09], impact: 'metal', mat: ['paint', 1.0, 0.4, 0.5] },
  glass:     { color: [0.60, 0.66, 0.68], impact: 'glass', mat: ['flat', 1, 1, 0.05] },
  far:       { color: [0.28, 0.27, 0.25], impact: 'concrete', mat: ['concrete', 6, 0.1, 0.9] },   // backdrop ground/buildings
};

// Lightmap texels per metre for architecture faces, by surface (default 8). Floors (where sun patches and
// contact shadows are seen up close) get the most, high roof decks and facades less.
export const LM_DENSITY = { floor: 9, asphalt: 2, grass: 1.0, roof: 3, far: 0.25, cladding: 4.5 };
export const LM_DENSITY_DEFAULT = 8;
