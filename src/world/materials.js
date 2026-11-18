// Texture loading (Poly Haven CC0 sets from public/assets, see scripts/fetch-assets.mjs + optimize-assets.py) and the
// shared material library. Missing files fall back to procedural canvas textures so the game always starts.
//
// The big architectural surfaces (floors, walls, brick, raw concrete, asphalt) get a shader extension injected through
// onBeforeCompile (see SURFACE_GLSL below). It only replaces the texture-sampling chunks of MeshStandardMaterial, so
// vertex colours, envMap, aoMap, fog, shadows and all lights keep working:
//  - anti-tiling: a second, rotated and rescaled sample blended in by world-space noise (height-aware transition)
//  - macro variation: low-frequency world-space tint / roughness noise
//  - detail normals at close range (the set's own normal map at ~5x frequency)
//  - parallax occlusion mapping from the height packed in the ARM alpha channel (cheap step count, distance fade)
//  - wear masks: dirt and rising damp at wall bases, leak streaks, plaster broken away to reveal brick, painted dado,
//    moss / salt on exterior brick, slab expansion joints, and a world-space ground mask (puddles, damp, dirt drifts,
//    oil, worn traffic paths) painted by decals.js into SURF_UNIFORMS.sGround.
import * as THREE from 'three';

function assetBase() {
  let base = '/';
  try { base = import.meta.env.BASE_URL || '/'; } catch { /* not under Vite */ }
  return base.replace(/\/?$/, '/') + 'assets/';
}
export const ASSET_BASE = assetBase();

// Texture sets: decode size per map (must match SIZES in scripts/optimize-assets.py). arm alpha = height where present.
const SETS = {
  floor:      { diff: 2048, nor: 2048, arm: 1024, fallback: [118, 116, 110] },
  floor2:     { diff: 1024, nor: 1024, arm: 1024, fallback: [112, 110, 104] },
  debris:     { diff: 1024, nor: 1024, arm: 512, fallback: [100, 96, 90] },
  wall:       { diff: 2048, nor: 2048, arm: 1024, fallback: [150, 146, 132] },
  brick:      { diff: 2048, nor: 2048, arm: 1024, fallback: [120, 72, 56] },
  rust:       { diff: 1024, nor: 1024, arm: 512, fallback: [110, 70, 45] },
  corrugated: { diff: 1024, nor: 1024, arm: 512, fallback: [105, 90, 78] },
  plate:      { diff: 1024, nor: 1024, arm: 512, fallback: [96, 98, 100] },
  wood:       { diff: 1024, nor: 1024, arm: 512, fallback: [112, 88, 62] },
  asphalt:    { diff: 1024, nor: 1024, arm: 512, fallback: [70, 70, 72] },
  ceiling:    { diff: 1024, nor: 1024, arm: 1024, fallback: [128, 126, 122] },
  paint:      { diff: 1024, nor: 512, arm: 512, fallback: [70, 96, 80] },
  lino:       { diff: 1024, nor: 1024, arm: 512, fallback: [120, 112, 96] },
};

// Material library. scale = metres per texture repeat (world-space UVs), env = envMapIntensity
// (interiors get little IBL so openings read bright and rooms dim — that contrast drives the bodycam auto-exposure).
// surf = surface-shader features (see SURFACE_GLSL): pom = parallax depth in metres.
export const MATS = {
  floor:        { set: 'floor', scale: 2.6, env: 0.32, surface: 'concrete', color: 0x9a9893,
                  surf: { pom: 0.007, ground: true, layer2: 'floor2', debris: true, joints: true } },
  wall:         { set: 'wall', scale: 3.0, env: 0.30, surface: 'concrete', color: 0xd2cfc6,
                  surf: { pom: 0.004, wall: true, plaster: true, dado: [0x4c5452, 1.15] } },
  wallOffice:   { set: 'wall', scale: 3.0, env: 0.30, surface: 'concrete', color: 0xe6dcc6,
                  surf: { pom: 0.004, wall: true, plaster: true, dado: [0x5e6e5a, 1.3] } },
  brick:        { set: 'brick', scale: 2.2, env: 1.0, surface: 'concrete', surf: { pom: 0.02, wall: true, ext: true, shift: true } },
  brickIn:      { set: 'brick', scale: 2.2, env: 0.30, surface: 'concrete', color: 0xb8b0a8, surf: { pom: 0.02, wall: true, shift: true } },
  rust:         { set: 'rust', scale: 2.0, env: 0.40, surface: 'metal' },
  corrugated:   { set: 'corrugated', scale: 2.0, env: 0.40, surface: 'metal' },
  corrugatedOut:{ set: 'corrugated', scale: 2.0, env: 1.0, surface: 'metal' },
  plate:        { set: 'plate', scale: 1.4, env: 0.45, surface: 'metal' },
  steel:        { set: 'plate', scale: 1.0, env: 0.45, surface: 'metal', color: 0x7a7c80 },
  wood:         { set: 'wood', scale: 1.6, env: 0.35, surface: 'wood' },
  woodDark:     { set: 'wood', scale: 1.6, env: 0.35, surface: 'wood', color: 0x8a7a6a },
  asphalt:      { set: 'asphalt', scale: 4.0, env: 1.0, surface: 'concrete', surf: { ground: true, debris: true, out: true } },
  ceiling:      { set: 'ceiling', scale: 3.0, env: 0.30, surface: 'concrete', color: 0xb4b2ae, surf: { pom: 0.008, wall: true } },
  concreteOut:  { set: 'ceiling', scale: 3.0, env: 1.0, surface: 'concrete', surf: { pom: 0.008, wall: true, ext: true } },
  paint:        { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal' },
  paintBlue:    { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0x9fb4d8 },
  paintRed:     { set: 'rust', scale: 1.2, env: 0.40, surface: 'metal', color: 0xd06050 },
  paintGrey:    { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0xc8c8c0 },
  yellow:       { set: 'paint', scale: 2.0, env: 0.40, surface: 'metal', color: 0xffd66a, noMap: true, base: 0xb89a2a, rough: 0.6 },
  lino:         { set: 'lino', scale: 2.2, env: 0.32, surface: 'concrete', surf: { ground: true, shift: true } },
  rubber:       { set: null, env: 0.2, surface: 'concrete', base: 0x161616, rough: 0.8 },
  paper:        { set: null, env: 0.3, surface: 'wood', base: 0xb8b2a2, rough: 0.95, side: THREE.DoubleSide },
  dark:         { set: 'plate', scale: 1.0, env: 0.3, surface: 'metal', color: 0x303236 },
  barrel:       { set: 'rust', scale: 1.0, env: 0.4, surface: 'metal' },
  cardboard:    { set: 'wood', scale: 0.8, env: 0.3, surface: 'wood', color: 0xc49a6c, rough: 0.95 },
  glassDark:    { set: null, env: 0.8, surface: 'metal', base: 0x151a1c, rough: 0.25 },
};

// Uniforms shared by every surface material. decals.js paints the ground mask and assigns it here.
export const SURF_UNIFORMS = {
  sNoise: { value: null },
  sGround: { value: null },
  sGroundRect: { value: new THREE.Vector4(-28, -56, 76, 93) },   // minX, minZ, sizeX, sizeZ (layout GROUND)
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// Procedural fallback texture: blotchy noise in the set's base colour.
function fallbackTexture(rgb, seed) {
  const N = 256;
  const c = makeCanvas(N, N);
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const coarse = new Float32Array(17 * 17).map(() => rnd());
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * 16, fy = (y / N) * 16, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const a = coarse[iy * 17 + ix], b = coarse[iy * 17 + ix + 1], cc = coarse[(iy + 1) * 17 + ix], d = coarse[(iy + 1) * 17 + ix + 1];
    const v = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
    const k = 0.75 + 0.35 * v + (rnd() - 0.5) * 0.12;
    const i = (y * N + x) * 4;
    img.data[i] = rgb[0] * k; img.data[i + 1] = rgb[1] * k; img.data[i + 2] = rgb[2] * k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function solidTexture(r, g, b, a = 255) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}

// Tileable 256² value-noise texture, four independent fbm channels:
// R low (periods 3/6/12), G mid (8/16/32), B patchy (5/10/20, contrasty), A high (32/64/128).
function noiseTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let s = 1337;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const lattice = (P) => { const a = new Float32Array(P * P); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const octave = (P) => {
    const L = lattice(P), out = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * P, fy = (y / N) * P, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x1 = (ix + 1) % P, y1 = (iy + 1) % P;
      const a = L[iy * P + ix], b = L[iy * P + x1], c = L[y1 * P + ix], d = L[y1 * P + x1];
      out[y * N + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
    return out;
  };
  const chans = [[3, 6, 12], [8, 16, 32], [5, 10, 20], [32, 64, 128]];
  chans.forEach((ps, ch) => {
    const o = ps.map(octave);
    for (let i = 0; i < N * N; i++) {
      let v = o[0][i] * 0.55 + o[1][i] * 0.3 + o[2][i] * 0.15;
      v = (v - 0.5) * (ch === 2 ? 2.2 : 1.7) + 0.5;
      data[i * 4 + ch] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  });
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

async function loadImage(url, size) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    const o = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    try {
      const bmp = await createImageBitmap(blob, o);
      if (!size || (bmp.width <= size && bmp.height <= size)) return bmp;
      bmp.close?.();
      return await createImageBitmap(blob, { ...o, resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
    } catch { /* options unsupported -> plain decode below */ }
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  img.__needsFlip = true;
  return img;
}

function toTexture(image, srgb, aniso) {
  const t = new THREE.Texture(image);
  t.flipY = !!image.__needsFlip;      // ImageBitmaps are flipped at decode time
  t.premultiplyAlpha = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------------------------------------ surface shader
const SURFACE_VERT_DECL = /* glsl */`
varying vec3 vSWorld;
varying vec3 vSWNormal;
`;
const SURFACE_VERT_MAIN = /* glsl */`
{
  vec4 sWp = vec4( transformed, 1.0 );
  vec3 sWn = objectNormal;
  #ifdef USE_INSTANCING
    sWp = instanceMatrix * sWp;
    sWn = mat3( instanceMatrix ) * sWn;
  #endif
  sWp = modelMatrix * sWp;
  vSWorld = sWp.xyz;
  vSWNormal = normalize( mat3( modelMatrix ) * sWn );
}
`;

const SURFACE_FRAG_DECL = /* glsl */`
varying vec3 vSWorld;
varying vec3 vSWNormal;
uniform sampler2D sNoise;
uniform float sScale;
uniform float sPom;
uniform vec3 sDadoCol;
uniform float sDadoTop;
#ifdef SURF_GROUND
  uniform sampler2D sGround;
  uniform vec4 sGroundRect;
#endif
#ifdef SURF_LAYER2
  uniform sampler2D sL2Diff; uniform sampler2D sL2Nor; uniform sampler2D sL2Arm; uniform float sL2Scale;
#endif
#ifdef SURF_DEBRIS
  uniform sampler2D sDebDiff; uniform sampler2D sDebNor; uniform float sDebScale;
#endif
#ifdef SURF_PLASTER
  uniform sampler2D sBrDiff; uniform sampler2D sBrNor; uniform sampler2D sBrArm; uniform float sBrScale;
#endif

uniform mat2 sROT;    // anti-tiling layer B: rotation (identity for directional sets like brick)
uniform float sK;     // layer B frequency ratio
uniform vec2 sOFF;    // layer B offset

vec3 sDecodeN( vec3 c ) { return c * 2.0 - 1.0; }
float sLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Parallax occlusion mapping: returns the uv offset. Height = aoMap (ARM) alpha, white = top surface.
vec2 sPOM( vec2 uv, vec2 gx, vec2 gy, vec2 vxy, float vz, float depthUV, float steps ) {
  vec2 P = vxy / max( vz, 0.25 ) * depthUV;
  float ls = 1.0 / steps;
  vec2 d = P * ls;
  vec2 u = uv;
  float cur = 0.0;
  float h = 1.0 - textureGrad( aoMap, u, gx, gy ).a;
  for ( int i = 0; i < 20; i ++ ) {
    if ( float( i ) >= steps || cur >= h ) break;
    u -= d; cur += ls;
    h = 1.0 - textureGrad( aoMap, u, gx, gy ).a;
  }
  vec2 pu = u + d;
  float a = h - cur;
  float b = ( 1.0 - textureGrad( aoMap, pu, gx, gy ).a ) - cur + ls;
  float t = clamp( a / ( a - b + 1e-5 ), 0.0, 1.0 );
  return mix( u, pu, t ) - uv;
}
`;

const SURFACE_FRAG_MAIN = /* glsl */`
vec3 sAlb = vec3( 1.0 );
float sRough = 1.0;
float sAO = 1.0;
float sSpec = 1.0;
vec3 sNT = vec3( 0.0, 0.0, 1.0 );
{
  vec3 sWP = vSWorld;
  vec3 sWN = normalize( vSWNormal );
  bool sVert = abs( sWN.y ) < 0.5;
  vec2 sUV0 = vMapUv;
  vec2 sGX = dFdx( sUV0 ), sGY = dFdy( sUV0 );
  float sDist = length( vViewPosition );
  vec2 sP2 = sVert ? ( abs( sWN.x ) > 0.5 ? sWP.zy : sWP.xy ) : sWP.xz;
  vec4 sN1 = texture2D( sNoise, sP2 / 23.0 + 0.13 );
  vec4 sN2 = texture2D( sNoise, sP2 / 4.7 + 0.37 );

  // tangent frame for parallax (same construction three uses for the normal map)
  vec3 sNv = normalize( vNormal );
  mat3 sTBN = getTangentFrame( - vViewPosition, sNv, sUV0 );
  vec3 sV = normalize( vViewPosition );
  vec3 sVT = vec3( dot( sV, normalize( sTBN[ 0 ] ) ), dot( sV, normalize( sTBN[ 1 ] ) ), dot( sV, sNv ) );

  // anti-tiling: layer A = base uv, layer B = rotated / rescaled / offset; world-noise blend
  float sW = smoothstep( 0.4, 0.6, sN1.g * 0.65 + sN2.b * 0.35 );
  vec2 uvA = sUV0;
  vec2 uvB = sROT * sUV0 * sK + sOFF;
  vec2 gxB = sROT * sGX * sK, gyB = sROT * sGY * sK;

  vec2 offA = vec2( 0.0 );
  float sFade = 1.0 - smoothstep( 5.0, 13.0, sDist );
  if ( sPom > 0.0 && sFade > 0.02 ) {
    float steps = floor( mix( 14.0, 5.0, clamp( sVT.z, 0.0, 1.0 ) ) * sFade + 2.0 );
    float dUV = sPom / sScale * sFade;
    if ( sW < 0.5 ) {
      offA = sPOM( uvA, sGX, sGY, sVT.xy, sVT.z, dUV, steps );
    } else {
      vec2 oB = sPOM( uvB, gxB, gyB, sROT * sVT.xy, sVT.z, dUV * sK, steps );
      offA = ( transpose( sROT ) * oB ) / sK;
    }
  }
  vec2 offB = sROT * offA * sK;

  vec4 dA = vec4( 0.0 ), aA = vec4( 0.0 ), dB = vec4( 0.0 ), aB = vec4( 0.0 );
  vec3 nA = vec3( 0.0, 0.0, 1.0 ), nB = vec3( 0.0, 0.0, 1.0 );
  if ( sW < 0.999 ) {
    dA = textureGrad( map, uvA + offA, sGX, sGY );
    aA = textureGrad( aoMap, uvA + offA, sGX, sGY );
    nA = sDecodeN( textureGrad( normalMap, uvA + offA, sGX, sGY ).xyz );
  }
  if ( sW > 0.001 ) {
    dB = textureGrad( map, uvB + offB, gxB, gyB );
    aB = textureGrad( aoMap, uvB + offB, gxB, gyB );
    nB = sDecodeN( textureGrad( normalMap, uvB + offB, gxB, gyB ).xyz );
    nB.xy = transpose( sROT ) * nB.xy;
  }
  if ( sW > 0.001 && sW < 0.999 ) sW = clamp( sW + ( aB.a - aA.a ) * 0.6 * sW * ( 1.0 - sW ) * 4.0, 0.0, 1.0 );
  vec4 sD = mix( dA, dB, sW );
  vec4 sA = mix( aA, aB, sW );
  sNT = normalize( mix( nA, nB, sW ) );
  float sH = sPom > 0.0 ? sA.a : clamp( sLum( sD.rgb ) * 3.0, 0.0, 1.0 );   // no height map: albedo as a proxy
  sAlb = sD.rgb;
  sAO = sA.r;
  sRough = sA.g;

  // close-range detail normal (same map, ~5x frequency, rotated)
  float sDet = ( 1.0 - smoothstep( 1.5, 6.0, sDist ) ) * 0.45;
  if ( sDet > 0.01 ) {
    vec2 uvD = mat2( 0.8, 0.6, -0.6, 0.8 ) * ( uvA + offA ) * 5.3;
    vec3 nD = sDecodeN( texture2D( normalMap, uvD ).xyz );
    nD.xy = transpose( mat2( 0.8, 0.6, -0.6, 0.8 ) ) * nD.xy;
    sNT = normalize( vec3( sNT.xy + nD.xy * sDet, sNT.z ) );
  }

  // macro variation (world space, low frequency)
  float sMac = sVert ? 0.45 : 1.35;
  sAlb *= mix( vec3( 1.0 ), mix( vec3( 0.80, 0.79, 0.77 ), vec3( 1.10, 1.08, 1.05 ), sN1.r ) * ( 0.92 + 0.16 * sN2.g ), sMac );
  sRough *= 0.84 + 0.32 * sN2.r;

  #ifdef SURF_LAYER2
  {
    // second concrete (cracked / patched slab) in large patches
    float m2 = sN1.b * 0.75 + sN2.a * 0.25;
    if ( m2 > 0.4 ) {
      vec2 uv2 = sUV0 * sL2Scale + offA * sL2Scale + vec2( 0.21, 0.57 );
      vec2 g2x = sGX * sL2Scale, g2y = sGY * sL2Scale;
      vec4 d2 = textureGrad( sL2Diff, uv2, g2x, g2y );
      vec4 a2 = textureGrad( sL2Arm, uv2, g2x, g2y );
      vec3 n2 = sDecodeN( textureGrad( sL2Nor, uv2, g2x, g2y ).xyz );
      // overlay its stains / chipped top layer onto the base slab instead of replacing it
      float w2 = smoothstep( 0.0, 0.25, m2 - 0.4 ) * 0.9;
      float r2 = clamp( sLum( d2.rgb ) / 0.06, 0.35, 1.7 );
      sAlb *= mix( vec3( 1.0 ), vec3( r2 ) * vec3( 1.04, 1.0, 0.93 ), w2 );
      sRough = mix( sRough, a2.g, w2 * 0.6 );
      sNT = normalize( mix( sNT, n2, w2 * 0.6 ) );
      sH = mix( sH, a2.a, w2 * 0.5 );
    }
  }
  #endif

  #ifdef SURF_JOINTS
  if ( ! sVert ) {
    // saw-cut expansion joints in the slab (6 m grid), sealant gone, edges spalled
    vec2 q = sWP.xz / 6.0 + vec2( 0.5 );
    vec2 fq = fract( q ) - 0.5;
    vec2 dd = ( 0.5 - abs( fq ) ) * 6.0;
    float chip = max( 0.0, sN2.a - 0.55 ) * 0.05 + ( texture2D( sNoise, sWP.xz * 1.7 ).a - 0.5 ) * 0.004;
    float jw = 0.0055 + chip;
    float fw = max( fwidth( sWP.x ), fwidth( sWP.z ) );
    float d = min( dd.x, dd.y );
    float groove = 1.0 - smoothstep( jw - fw, jw + fw, d );
    float bevel = ( 1.0 - smoothstep( jw, jw + 0.012 + fw, d ) ) * ( 1.0 - groove );
    vec2 tilt = dd.x < dd.y ? vec2( sign( fq.x ), 0.0 ) : vec2( 0.0, - sign( fq.y ) );
    float near = 1.0 - smoothstep( 4.0, 12.0, sDist );
    sNT = normalize( sNT + vec3( tilt * bevel * 0.9 * near, 0.0 ) );
    sAlb *= mix( 1.0, 0.28, groove ) * mix( 1.0, 0.82, bevel );
    sAO *= mix( 1.0, 0.35, groove );
    sRough = mix( sRough, 1.0, groove );
    sH = mix( sH, 0.0, groove );
  }
  #endif

  #ifdef SURF_GROUND
  {
    // two bands: ground floor (left half), all other levels (right half)
    vec2 gUV = clamp( ( sWP.xz - sGroundRect.xy ) / sGroundRect.zw, vec2( 0.001 ), vec2( 0.999 ) );
    gUV.x = gUV.x * 0.5 + ( abs( sWP.y ) > 1.8 ? 0.5 : 0.0 );
    vec4 gm = texture2D( sGround, gUV );
    float nz = sN2.a - 0.5;
    // worn traffic paths: lighter, polished, dirt swept away
    float wear = gm.a * ( 0.7 + 0.6 * sN2.r );
    sAlb *= 1.0 + 0.12 * wear;
    sRough *= mix( 1.0, 0.62, wear );
    // dirt / grit drifts (strongest at wall bases and corners)
    float dirt = clamp( gm.g * ( 1.0 - 0.6 * wear ) + nz * 0.35 * gm.g, 0.0, 1.0 );
    vec3 dirtCol = vec3( 0.21, 0.19, 0.16 ) * ( 0.8 + 0.5 * sN2.g );
    sAlb = mix( sAlb, dirtCol, dirt * 0.9 );
    sRough = mix( sRough, 0.97, dirt );
    #ifdef SURF_DEBRIS
    float wd = smoothstep( 0.45, 0.7, gm.g + nz * 0.5 );
    if ( wd > 0.001 ) {
      vec2 uvd = sUV0 * sDebScale + offA * sDebScale;
      vec4 dd = texture2D( sDebDiff, uvd );
      vec3 nd = sDecodeN( texture2D( sDebNor, uvd ).xyz );
      float wdh = smoothstep( 0.0, 0.5, wd + ( sLum( dd.rgb ) - 0.4 ) * 0.8 * wd * ( 1.0 - wd ) * 4.0 );
      sAlb = mix( sAlb, dd.rgb * vec3( 0.62, 0.58, 0.52 ), wdh );
      sNT = normalize( mix( sNT, nd, wdh ) );
      sRough = mix( sRough, 0.95, wdh );
      sH = mix( sH, 0.6, wdh );
    }
    #endif
    // oil: dark, glossy
    float oil = gm.b * smoothstep( 0.2, 0.5, gm.b + nz * 0.4 );
    sAlb *= mix( 1.0, 0.3, oil );
    sRough = mix( sRough, 0.22, oil * 0.85 );
    // water: damp halo, puddles collect in the low spots of the height map
    float wet = gm.r;
    float damp = smoothstep( 0.08, 0.45, wet + nz * 0.25 );
    float pud = smoothstep( 0.56, 0.64, wet + nz * 0.3 + ( 0.5 - sH ) * 0.45 );
    sAlb *= mix( 1.0, 0.62, damp );
    sRough = mix( sRough, sRough * 0.45, damp );
    sAlb *= mix( 1.0, 0.7, pud );
    sRough = mix( sRough, 0.035, pud );
    sNT = normalize( mix( sNT, vec3( 0.0, 0.0, 1.0 ), max( pud * 0.94, damp * 0.35 ) ) );
    sAO = mix( sAO, 1.0, pud * 0.5 );
    #ifdef SURF_OUT
    sSpec = 1.0 + damp * 0.4 + pud * 0.4;   // open sky: the IBL is roughly what a puddle reflects outdoors
    #endif
  }
  #endif

  #ifdef SURF_WALL
  if ( sVert ) {
    float hy = sWP.y;
    float along = abs( sWN.x ) > 0.5 ? sWP.z : sWP.x;
    // grime band at the base, ragged top edge
    float baseD = 1.0 - smoothstep( 0.0, 0.2 + 0.9 * sN2.r * sN1.g + 0.25 * sN2.a, hy );
    baseD *= baseD;
    // rising damp with a salt tide line, patchy
    float dampTop = 0.3 + 0.8 * sN1.r;
    float dampOn = smoothstep( 0.55, 0.75, sN1.b );
    float damp = ( 1.0 - smoothstep( dampTop - 0.15, dampTop + 0.05 * sN2.a, hy ) ) * dampOn;
    float tide = smoothstep( dampTop - 0.12, dampTop - 0.03, hy ) * ( 1.0 - smoothstep( dampTop - 0.01, dampTop + 0.06, hy ) ) * dampOn;
    // leak streaks running down from above
    float st = texture2D( sNoise, vec2( along * 0.85, hy * 0.03 ) ).a;
    float stPatch = smoothstep( 0.5, 0.72, texture2D( sNoise, vec2( along * 0.07, 0.31 ) ).g );
    float streak = smoothstep( 0.45, 0.85, st ) * stPatch * smoothstep( 0.2, 2.0, hy );

    #ifdef SURF_PLASTER
    {
      // painted dado band (Sockelanstrich) with worn patches
      float fwY = fwidth( hy );
      float dado = 1.0 - smoothstep( sDadoTop - fwY, sDadoTop + fwY, hy );
      float line = ( 1.0 - smoothstep( sDadoTop - fwY, sDadoTop + fwY, hy ) ) * smoothstep( sDadoTop - 0.025 - fwY, sDadoTop - 0.025 + fwY, hy );
      float worn = smoothstep( 0.66, 0.74, sN2.a * 0.45 + texture2D( sNoise, sP2 * 2.3 ).a * 0.4 + ( 1.0 - smoothstep( 0.0, 0.4, hy ) ) * 0.25 + ( 1.0 - smoothstep( 0.0, 0.06, sDadoTop - hy ) ) * 0.12 );
      vec3 dCol = sDadoCol * ( 0.55 + 0.75 * sLum( sAlb ) );
      sAlb = mix( sAlb, dCol * mix( 1.0, 0.7, line ), dado * ( 1.0 - worn ) );
      sRough = mix( sRough, sRough * 0.72, dado * ( 1.0 - worn ) );

      // plaster broken away, exposing the brick behind it (mostly low on the wall)
      float m = sN1.b * 0.5 + texture2D( sNoise, sP2 / 1.6 + 0.77 ).g * 0.38 + texture2D( sNoise, sP2 * 1.3 ).a * 0.12
              + ( 1.0 - smoothstep( 0.0, 1.8, hy ) ) * 0.14;
      float th = 0.72;
      if ( m > th - 0.03 ) {
        vec2 uvb = sUV0 * sBrScale;
        vec4 bd = texture2D( sBrDiff, uvb );
        vec4 ba = texture2D( sBrArm, uvb );
        vec3 bn = sDecodeN( texture2D( sBrNor, uvb ).xyz );
        float fwm = fwidth( m ) + 0.002;
        float hole = smoothstep( th - fwm, th + fwm, m );
        float rim = smoothstep( th - 0.025, th - 0.004, m ) * ( 1.0 - hole );       // fresh broken plaster edge
        float shade = ( 1.0 - smoothstep( th, th + 0.035, m ) ) * hole;          // plaster thickness shadow
        sAlb = mix( sAlb, vec3( 0.62, 0.60, 0.56 ), rim * 0.8 );
        sAlb = mix( sAlb, bd.rgb * 0.82, hole );
        sAlb *= 1.0 - shade * 0.55;
        sAO = mix( sAO, ba.r * ( 1.0 - shade * 0.5 ), hole );
        sRough = mix( sRough, ba.g, hole );
        sNT = normalize( mix( sNT, bn, hole ) );
      }
    }
    #endif

    vec3 grime = vec3( 0.42, 0.39, 0.35 );
    sAlb = mix( sAlb, sAlb * grime, baseD );
    sRough = mix( sRough, 1.0, baseD * 0.5 );
    sAlb *= mix( 1.0, 0.66, damp );
    sRough *= mix( 1.0, 0.7, damp );
    sAlb = mix( sAlb, vec3( 0.74, 0.72, 0.66 ), tide * 0.45 );
    sAlb *= mix( vec3( 1.0 ), vec3( 0.78, 0.70, 0.62 ), streak );
    sRough *= mix( 1.0, 0.8, streak );

    #ifdef SURF_EXT
    {
      // moss / algae in the mortar near the ground, salt bloom
      float mortar = smoothstep( 0.35, 0.7, 1.0 - sH );
      float moss = ( 1.0 - smoothstep( 0.0, 0.6 + 1.2 * sN1.r, hy ) ) * smoothstep( 0.35, 0.6, sN2.b );
      sAlb = mix( sAlb, vec3( 0.05, 0.075, 0.03 ), moss * ( 0.35 + 0.55 * mortar ) );
      float salt = smoothstep( 0.62, 0.8, sN2.g ) * ( 1.0 - smoothstep( 0.2, 1.4, hy ) );
      sAlb = mix( sAlb, vec3( 0.7, 0.69, 0.64 ), salt * 0.4 );
      // soot / weathering darkening up high
      sAlb *= mix( 1.0, 0.8, smoothstep( 4.0, 8.0, hy ) * sN1.g );
    }
    #endif
  } else if ( sWN.y < -0.5 ) {
    sAlb *= 0.9 + 0.2 * sN2.r;   // soffits: soot variation
  }
  #endif

  diffuseColor.rgb *= sAlb;
}
`;

function surfaceDefines(s) {
  const d = {};
  if (s.ground) d.SURF_GROUND = '';
  if (s.layer2) d.SURF_LAYER2 = '';
  if (s.debris) d.SURF_DEBRIS = '';
  if (s.joints) d.SURF_JOINTS = '';
  if (s.wall) d.SURF_WALL = '';
  if (s.plaster) d.SURF_PLASTER = '';
  if (s.ext) d.SURF_EXT = '';
  if (s.out) d.SURF_OUT = '';
  return d;
}

function applySurfaceShader(m, d, tex, neutral) {
  const s = d.surf;
  const key = 'surf:' + Object.keys(surfaceDefines(s)).sort().join(',');
  m.defines = { ...(m.defines || {}), ...surfaceDefines(s) };
  const dado = s.dado || [0x555555, -10];
  const u = {
    sNoise: SURF_UNIFORMS.sNoise,
    sGround: SURF_UNIFORMS.sGround,
    sGroundRect: SURF_UNIFORMS.sGroundRect,
    sScale: { value: d.scale ?? 2 },
    sPom: { value: s.pom ?? 0 },
    sDadoCol: { value: new THREE.Color(dado[0]) },
    sDadoTop: { value: dado[1] },
    // anti-tiling layer B: rotated + rescaled for isotropic sets, half-tile shift for directional ones (brick, lino)
    sROT: { value: s.shift ? new THREE.Matrix2().identity() : new THREE.Matrix2().set(-0.5048, -0.8632, 0.8632, -0.5048) },
    sK: { value: s.shift ? 1.0 : 0.79 },
    sOFF: { value: s.shift ? new THREE.Vector2(0.5, 0.0) : new THREE.Vector2(0.371, 0.613) },
  };
  const set = (name, k, scale) => {
    const t = tex[name] || {};
    u[k + 'Diff'] = { value: t.diff || neutral.diff };
    u[k + 'Nor'] = { value: t.nor || neutral.nor };
    u[k + 'Arm'] = { value: t.arm || neutral.arm };
    u[k + 'Scale'] = { value: (d.scale ?? 2) / scale };
  };
  if (s.layer2) set(s.layer2, 'sL2', 2.4);
  if (s.debris) set('debris', 'sDeb', 1.5);
  if (s.plaster) set('brick', 'sBr', MATS.brick.scale);
  m.userData.surfUniforms = u;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_VERT_DECL)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + SURFACE_VERT_MAIN);
    const ao = THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'sAO');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', SURFACE_FRAG_DECL + '\nvoid main() {')
      .replace('#include <map_fragment>', SURFACE_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp( roughness * sRough, 0.03, 1.0 );')
      .replace('#include <normal_fragment_maps>', '#ifdef USE_NORMALMAP_TANGENTSPACE\n vec3 mapN = sNT; mapN.xy *= normalScale; normal = normalize( tbn * mapN );\n#endif')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectSpecular *= sSpec;\n' + ao);
  };
}

/**
 * Loads all texture sets listed in the manifest and builds the material library.
 * @returns {Promise<{ mats: Record<string, THREE.MeshStandardMaterial>, scales: Record<string, number>, surfaces: Record<string,string>, missing: string[] }>}
 */
export async function loadMaterials(renderer, onProgress = () => {}) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
  let manifest = null;
  try {
    const r = await fetch(ASSET_BASE + 'manifest.json');
    if (r.ok) manifest = await r.json();
  } catch { /* offline / not fetched */ }
  if (!manifest) console.warn('[world] assets/manifest.json missing — using procedural textures. Run: npm run assets');

  if (!SURF_UNIFORMS.sNoise.value) SURF_UNIFORMS.sNoise.value = noiseTexture();
  if (!SURF_UNIFORMS.sGround.value) SURF_UNIFORMS.sGround.value = solidTexture(0, 0, 0, 0);
  const neutral = { diff: solidTexture(128, 128, 128), nor: solidTexture(128, 128, 255), arm: solidTexture(255, 230, 0, 128) };

  const tex = {};
  const missing = [];
  const jobs = [];
  for (const [key, cfg] of Object.entries(SETS)) {
    tex[key] = {};
    const entry = manifest?.textures?.[key];
    for (const slot of ['diff', 'nor', 'arm']) {
      const rel = entry?.maps?.[slot];
      if (!rel) { if (slot === 'diff') missing.push(key); continue; }
      jobs.push({ key, slot, url: ASSET_BASE + rel, size: cfg[slot] || 1024 });
    }
    if (!entry?.maps?.arm && entry?.maps?.rough) jobs.push({ key, slot: 'arm', url: ASSET_BASE + entry.maps.rough, size: 1024 });
    tex[key].hasHeight = entry?.maps?.height === 'arm.a';
  }
  let done = 0;
  const total = jobs.length || 1;
  await Promise.all(jobs.map(async (j) => {
    try {
      const img = await loadImage(j.url, j.size);
      tex[j.key][j.slot] = toTexture(img, j.slot === 'diff', aniso);
    } catch (e) {
      console.warn('[world] texture failed', j.url, e.message);
      if (j.slot === 'diff') missing.push(j.key);
    }
    done++;
    onProgress(done / total, 'Texturen');
  }));

  let seed = 1;
  for (const [key, cfg] of Object.entries(SETS)) {
    if (!tex[key].diff) {
      tex[key].diff = fallbackTexture(cfg.fallback, seed++);
      tex[key].diff.wrapS = tex[key].diff.wrapT = THREE.RepeatWrapping;
      tex[key].diff.anisotropy = aniso;
    }
  }

  const mats = {}, scales = {}, surfaces = {};
  for (const [key, d] of Object.entries(MATS)) {
    const t = d.set ? tex[d.set] : null;
    const surf = d.surf && t?.nor && t?.arm && !d.noMap;
    const m = new THREE.MeshStandardMaterial({
      color: d.noMap ? (d.base ?? 0xffffff) : (d.color ?? (d.set ? 0xffffff : d.base)),
      map: d.noMap || !t ? null : t.diff,
      normalMap: t?.nor ?? null,
      roughness: 1, metalness: t?.arm ? 1 : 0,
      vertexColors: true,
      side: d.side ?? THREE.FrontSide,
    });
    if (t?.arm) {
      m.aoMap = t.arm; m.aoMapIntensity = 1.0;   // R
      m.roughnessMap = t.arm;                      // G
      m.metalnessMap = t.arm;                      // B
    } else {
      m.roughness = d.rough ?? 0.85; m.metalness = d.surface === 'metal' && d.set ? 0.3 : 0;
    }
    if (d.rough !== undefined && t?.arm) m.roughness = d.rough / 0.8;
    if (m.normalMap) m.normalScale.set(1, 1);
    m.envMapIntensity = d.env ?? 0.4;
    m.name = key;
    if (surf) {
      // non-metallic architectural surface: ARM.b is unused, alpha carries height
      m.metalnessMap = null; m.metalness = 0; m.roughnessMap = null;   // read from aoMap (same ARM texture) in the shader
      if (!t.hasHeight) d.surf = { ...d.surf, pom: 0 };
      applySurfaceShader(m, d, tex, neutral);
    }
    mats[key] = m;
    scales[key] = d.scale ?? 2;
    surfaces[key] = d.surface ?? 'concrete';
  }
  return { mats, scales, surfaces, missing: [...new Set(missing)], tex };
}

export { makeCanvas };
