// Scene materials. Owner: B (look). All scene shaders write EXPOSED linear HDR (× uExposure) into the scene
// target; the composite pass does tone mapping and the bodycam look. Every material shares ONE uniform set
// (`U`, below) so a frame updates flashlight/exposure/circuits once for all of them.
//
//   createStaticMaterial()            merged world geometry: lightmap + vertex-baked light, circuits, emissive,
//                                     world-planar PBR-ish surface layers (texture array per SURF `mat`),
//                                     anti-tiling macro variation, normal/roughness detail (mid/high tiers),
//                                     specular from the camera zone's baked environment cube
//   createTransparentMaterial()       glass panes + see-through mesh (fences, curtains) of the static world
//   createDynamicMaterial(opts)       moving objects (doors, AGVs, enemies, weapon, A's art): probe volume lighting,
//                                     supports skinning / instancing / an albedo map; opts.probe:
//                                       'volume'  (default) GPU 3D-texture probe lookup per vertex
//                                       'uniform' U.uProbeAmb/uProbeDirU/uProbeSunU (first-person view, C)
//                                       'object'  own uniforms per material, fed by setObjectLight(mat, sample)
//                                                 with a leak-free ctx.exposure.sampleLight(x, y, z) — use for
//                                                 characters standing near walls (D)
//                                     opts.roughness (0..1, default 0.6), opts.specular (0..1, default 0.4)
//   convertToDynamic(object3D, opts)  replace glTF materials (MeshStandard…) by dynamic materials (keeps map/color,
//                                     roughness)
//   loadMaterials(ctx, loader, manifest)  textures + baked environment (called once by the world while loading)
//   updateEnvironment(zone, artLevel, dt)  per frame (exposure module): blends the camera zone's env cube
import * as THREE from 'three';
import { SURF } from '../world/layout/surfaces.js';
import { url } from '../core/loader.js';

export const MAX_CIRCUITS = 8;
const MAX_SURF = 32, MAX_LAYERS = 16;
const ENV_W = 96, ENV_H = 16;   // current (blended) environment cube atlas: 6 faces × 16², RGBA16F

/** Shared uniforms (mutated in place each frame by pipeline / world / player). */
export const U = {
  uExposure: { value: 1 },
  uTime: { value: 0 },
  uLmDay: { value: null }, uLmArt: { value: null },
  uCirc: { value: new Float32Array(MAX_CIRCUITS).fill(1) },
  uFlashPos: { value: new THREE.Vector3() }, uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
  uFlashColor: { value: new THREE.Vector3(0, 0, 0) }, uFlashCone: { value: new THREE.Vector2(0.82, 0.97) },
  uFlashRange: { value: 28 },
  uMuzzlePos: { value: new THREE.Vector3() }, uMuzzleColor: { value: new THREE.Vector3() },
  uFogColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uFogDensity: { value: 0.004 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) },
  uProbeL0: { value: null }, uProbeDirSun: { value: null }, uProbeArt: { value: null },
  uProbeOrigin: { value: new THREE.Vector3() }, uProbeInvSize: { value: new THREE.Vector3(1, 1, 1) },
  uProbeArtLevel: { value: 1 },
  uProbeAmb: { value: new THREE.Vector3(0.3, 0.3, 0.3) }, uProbeDirU: { value: new THREE.Vector3() }, uProbeSunU: { value: 0 },
  uGrid: { value: 0 },   // greybox 1 m grid lines (off: surfaces are textured)
  // B material system
  uMatA: { value: null }, uMatN: { value: null },        // texture arrays: albedo (sRGB) / normal.xy + roughness
  uMatDetail: { value: 0 },                              // 1 = sample the normal/roughness layer (mid/high tiers)
  uSurf: { value: new Float32Array(MAX_SURF * 4) },      // per surface index: layer, 1/tile size, spec, roughness
  uLayerInv: { value: new Float32Array(MAX_LAYERS * 4) },// per layer: 1/mean rgb (texture → mean 1), 1/mean lum
  uEnvCur: { value: null }, uEnvAvg: { value: 0.3 },     // camera-zone environment (blended), its mean luminance
  uSpec: { value: 1 },                                   // global specular strength (tier)
  uMacro: { value: new THREE.Vector2(13, 1) },
  uFloorMask: { value: null }, uFloorXf: { value: new THREE.Vector4(-16, -16, 1 / 128, 1 / 126) },   // ground-floor paint/grime/tyre mask           // anti-tiling noise layer index, its 1/mean luminance
};

const COMMON = /* glsl */`
uniform float uExposure, uTime, uFlashRange, uFogDensity, uGrid, uEnvAvg, uSpec;
uniform vec3 uFlashPos, uFlashDir, uFlashColor, uMuzzlePos, uMuzzleColor, uFogColor, uSunDir, uSunColor;
uniform vec2 uFlashCone;
uniform sampler2D uEnvCur;
vec3 decodeRGBM(vec4 c) { return c.rgb * c.a * 16.0; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// flashlight (unshadowed spot) + muzzle flash (point), the only dynamic lights. spec: out highlight (× F0 later)
vec3 dynLight(vec3 P, vec3 N, vec3 V, float rough, out vec3 spec) {
  vec3 L = uFlashPos - P; float d2 = max(dot(L, L), 1e-4); float d = sqrt(d2); L /= d;
  float cd = dot(-L, uFlashDir);
  float spot = smoothstep(uFlashCone.x, uFlashCone.y, cd) * (0.55 + 0.45 * smoothstep(uFlashCone.y, 1.0, cd));
  float att = spot / (0.35 + d2 * 0.09) * clamp(1.0 - d / uFlashRange, 0.0, 1.0);
  float nl = max(dot(N, L), 0.0);
  vec3 c = uFlashColor * (att * nl);
  float a = max(rough * rough, 0.02), a2 = a * a;
  float nh = max(dot(N, normalize(L + V)), 0.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  spec = uFlashColor * (att * nl * min(a2 / (3.14159 * dd * dd), 40.0) * 0.25);
  vec3 M = uMuzzlePos - P; float m2 = max(dot(M, M), 1e-3);
  c += uMuzzleColor * (max(dot(N, M * inversesqrt(m2)), 0.0) / (0.2 + m2));
  return c;
}
vec3 dynLight(vec3 P, vec3 N) { vec3 s; return dynLight(P, N, N, 1.0, s); }
vec3 applyFog(vec3 c, float dist) { return mix(uFogColor, c, exp(-uFogDensity * dist)); }
float gridLines(vec3 wp, vec3 n) {
  vec3 a = abs(n);
  vec2 q = a.y > 0.5 ? wp.xz : (a.x > 0.5 ? wp.zy : wp.xy);
  vec2 g = abs(fract(q + 0.5) - 0.5) / max(fwidth(q), 1e-4);
  return 1.0 - 0.10 * uGrid * (1.0 - clamp(min(g.x, g.y), 0.0, 1.0));
}
// baked environment cube of the camera's zone (6 faces side by side, 16² each, RGBA16F, already circuit-mixed)
vec3 envSample(vec3 R) {
  vec3 a = abs(R);
  float face; vec2 st;
  if (a.x >= a.y && a.x >= a.z) { face = R.x > 0.0 ? 0.0 : 1.0; st = R.zy / a.x; }
  else if (a.y >= a.z) { face = R.y > 0.0 ? 2.0 : 3.0; st = R.xz / a.y; }
  else { face = R.z > 0.0 ? 4.0 : 5.0; st = R.xy / a.z; }
  st = clamp(st * 0.5 + 0.5, 0.5 / 16.0, 15.5 / 16.0);
  return texture(uEnvCur, vec2((face + st.x) / 6.0, st.y)).rgb;
}
// GGX-ish environment specular weight (Karis' analytic DFG approximation), F0 = 0.04 dielectric
float envBRDF(float nv, float rough) {
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return 0.04 * ab.x + ab.y;
}
`;

// ------------------------------------------------------------------------------------------------------------
// surface table (index = position in SURF, as world.js writes aMisc.z)
let LAYERS = ['floor', 'concrete', 'asphalt', 'plate', 'wood', 'lino', 'trapez', 'sandwich', 'block', 'cardboard', 'wrap', 'grating', 'paint', 'flat'];
function fillSurfTable(layers) {
  const s = U.uSurf.value;
  Object.values(SURF).forEach((sf, i) => {
    if (i >= MAX_SURF) return;
    const m = sf.mat ?? ['flat', 1, 0.3, 0.7];
    const li = Math.max(0, layers.indexOf(m[0]));
    s[i * 4] = li >= 0 ? li : layers.indexOf('flat'); s[i * 4 + 1] = 1 / m[1]; s[i * 4 + 2] = m[2]; s[i * 4 + 3] = m[3];
  });
}
fillSurfTable(LAYERS);
for (let i = 0; i < MAX_LAYERS; i++) U.uLayerInv.value.set([1, 1, 1, 1], i * 4);

export function createStaticMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9Static',
    uniforms: { ...U, uCirc: U.uCirc },
    vertexShader: /* glsl */`
      uniform float uCirc[${MAX_CIRCUITS}];
      uniform vec4 uSurf[${MAX_SURF}];
      uniform vec4 uLayerInv[${MAX_LAYERS}];
      attribute vec4 aColor; attribute vec2 aLmUv; attribute vec4 aVlDay; attribute vec4 aVlArt; attribute vec4 aMisc;
      varying vec3 vAlbedo; varying vec2 vLmUv; varying vec3 vVl; varying float vCirc; varying vec3 vEmit;
      varying vec3 vWorld; varying vec3 vN; varying float vDist;
      flat varying vec4 vSurf; flat varying float vLumInv;
      vec3 dec(vec4 c) { return c.rgb * c.a * 16.0; }
      void main() {
        vSurf = uSurf[int(aMisc.z + 0.5)];
        vec4 li = uLayerInv[int(vSurf.x + 0.5)];
        vAlbedo = aColor.rgb * li.rgb;
        vLumInv = li.a;
        vLmUv = aLmUv;
        vCirc = uCirc[int(aMisc.x + 0.5)];
        vVl = dec(aVlDay) + dec(aVlArt) * vCirc;
        vEmit = aColor.rgb * (aMisc.y / 16.0 * vCirc * 4.0);
        vec4 wp = modelMatrix * vec4(position, 1.0);   // merged zone meshes: translation only
        vWorld = wp.xyz; vN = normal;
        vec4 mv = viewMatrix * wp;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp sampler2DArray;
      ${COMMON}
      uniform sampler2D uLmDay, uLmArt;
      uniform sampler2DArray uMatA, uMatN;
      uniform float uMatDetail;
      uniform vec2 uMacro;
      uniform sampler2D uFloorMask;
      uniform vec4 uFloorXf;
      varying vec3 vAlbedo; varying vec2 vLmUv; varying vec3 vVl; varying float vCirc; varying vec3 vEmit;
      varying vec3 vWorld; varying vec3 vN; varying float vDist;
      flat varying vec4 vSurf; flat varying float vLumInv;
      void main() {
        vec3 n = normalize(vN);
        vec3 an = abs(n);
        bool up = an.y > 0.5, sx = an.x > 0.5;
        vec2 p = up ? vWorld.xz : (sx ? vWorld.zy : vWorld.xy);
        vec2 uv = p * vSurf.y;
        float layer = vSurf.x;
        vec3 tex = texture(uMatA, vec3(uv, layer)).rgb;
        // anti-tiling: broad (~15 m) brightness/dirt variation from the noise layer, independent of the tile size
        float macro = clamp(1.0 + (luma(texture(uMatA, vec3(mat2(0.8, -0.6, 0.6, 0.8) * p * 0.07 + 0.37, uMacro.x)).rgb) * uMacro.y - 1.0) * 3.5, 0.6, 1.3);
        vec3 albedo = vAlbedo * tex * macro;
        vec3 light = decodeRGBM(texture(uLmDay, vLmUv)) + decodeRGBM(texture(uLmArt, vLmUv)) * vCirc + vVl;
        vec3 N = n;
        float rough = vSurf.w;
        if (uMatDetail > 0.5) {
          vec3 nm = texture(uMatN, vec3(uv, layer)).rgb;
          vec2 t = nm.xy * 2.0 - 1.0;
          vec3 T = up || !sx ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
          vec3 B = up ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
          N = normalize(T * t.x + B * t.y + n * 1.2);
          rough = clamp(vSurf.w + (nm.b - 0.6) * 0.6, 0.05, 1.0);
        } else {
          rough = clamp(vSurf.w + (1.0 - macro) * 0.8, 0.05, 1.0);   // dirtier patches are rougher
        }
        // ground floor: painted lines / dock hatching (worn), contact grime, tyre marks (generated floor mask)
        vec4 fm = texture(uFloorMask, (vWorld.xz - uFloorXf.xy) * uFloorXf.zw) * ((n.y > 0.5 && abs(vWorld.y) < 0.25) ? 1.0 : 0.0);
        float paint = fm.r * clamp(macro * 1.6 - 0.45 + (tex.g * vLumInv - 1.0), 0.0, 1.0);
        vec3 paintC = mix(vec3(0.60, 0.40, 0.025), vec3(0.62, 0.62, 0.60), fm.b);
        albedo = mix(albedo * (1.0 - fm.g * 0.42) * (1.0 - fm.a * 0.55), paintC * (1.0 - fm.g * 0.3), paint);
        rough = clamp(mix(rough, 0.95, fm.g * 0.5) - fm.a * 0.2 + paint * 0.05, 0.05, 1.0);
        vec3 V = normalize(cameraPosition - vWorld);
        float nv = max(dot(N, V), 1e-3);
        // specular: camera-zone env cube × analytic BRDF, occluded where the baked light is darker than the env
        float occ = clamp(luma(light) / uEnvAvg, 0.0, 1.0);
        float gloss = (1.0 - rough) * (1.0 - rough) * 1.6;
        vec3 spec = envSample(reflect(-V, N)) * (envBRDF(nv, rough) * vSurf.z * uSpec * occ * gloss);
        vec3 fs;
        vec3 dl = dynLight(vWorld, N, V, rough, fs);
        vec3 c = albedo * (light + dl) + spec + fs * vSurf.z + vEmit;
        c = applyFog(c, vDist);
        gl_FragColor = vec4(c * uExposure, 1.0);
      }`,
  });
}

export function createTransparentMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9Glass',
    uniforms: { ...U },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec4 aColor;
      varying vec4 vColor; varying vec3 vWorld; varying vec3 vN; varying float vDist;
      void main() {
        vColor = aColor; vN = normal;
        vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp; vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      ${COMMON}
      varying vec4 vColor; varying vec3 vWorld; varying vec3 vN; varying float vDist;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 N = normalize(vN); N *= sign(dot(N, V) + 1e-4);
        float nv = abs(dot(V, N));
        float fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
        bool mesh = vColor.a > 0.3;
        // glass: env reflection (zone cube) with fresnel, faint grime tint; mesh: dark wire lit by the fog colour
        vec3 refl = envSample(reflect(-V, N));
        vec3 c = mesh ? vColor.rgb * uFogColor * 1.2 : refl * fres + vColor.rgb * uFogColor * 0.15;
        float a = mesh ? vColor.a : clamp(vColor.a + fres * 0.6, 0.0, 0.9);
        if (!mesh) c /= max(a, 0.05);   // premultiplied-equivalent: reflection is additive light
        c += dynLight(vWorld, N) * vColor.rgb;
        gl_FragColor = vec4(applyFog(c, vDist) * uExposure, a);
      }`,
  });
}

/** opts: { color, map, skinning (auto), probe: 'volume'|'uniform'|'object', emissive: [r,g,b], roughness, specular } */
export function createDynamicMaterial(opts = {}) {
  const defines = {};
  if (opts.map) defines.USE_S9MAP = '';
  if (opts.probe === 'uniform' || opts.probe === 'object') defines.PROBE_UNIFORM = '';
  const own = opts.probe === 'object'
    ? { uProbeAmb: { value: new THREE.Vector3(0.3, 0.3, 0.3) }, uProbeDirU: { value: new THREE.Vector3() }, uProbeSunU: { value: 0 } } : {};
  const m = new THREE.ShaderMaterial({
    name: 'S9Dynamic',
    defines,
    uniforms: {
      ...U, ...own,
      uColor: { value: new THREE.Color(...(opts.color ?? [0.6, 0.6, 0.6])) },
      uMap: { value: opts.map ?? null },
      uEmissive: { value: new THREE.Vector3(...(opts.emissive ?? [0, 0, 0])) },
      uRough: { value: opts.roughness ?? 0.6 }, uSpecK: { value: opts.specular ?? 0.4 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform sampler3D uProbeL0, uProbeDirSun, uProbeArt;
      uniform vec3 uProbeOrigin, uProbeInvSize, uSunDir, uSunColor, uProbeAmb, uProbeDirU;
      uniform float uProbeArtLevel, uProbeSunU;
      varying vec3 vIrr; varying vec3 vWorld; varying vec3 vN; varying float vDist; varying vec2 vUv;
      vec3 dec(vec4 c) { return c.rgb * c.a * 16.0; }
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          objectNormal = mat3(instanceMatrix) * objectNormal;
        #endif
        wp = modelMatrix * wp;
        vec3 N = normalize(mat3(modelMatrix) * objectNormal);
        #ifdef PROBE_UNIFORM
          vec3 l0 = uProbeAmb; vec3 pd = uProbeDirU; float sv = uProbeSunU; vec3 art = vec3(0.0);
        #else
          // sample slightly off the surface along the normal: less light from behind thin walls
          vec3 uvw = (wp.xyz + N * 0.15 - uProbeOrigin) * uProbeInvSize;
          vec3 l0 = dec(texture(uProbeL0, uvw));
          vec4 ds = texture(uProbeDirSun, uvw);
          vec3 pd = ds.xyz * 2.0 - 1.0; float sv = ds.w;
          vec3 art = dec(texture(uProbeArt, uvw)) * uProbeArtLevel;
        #endif
        // L0 + L1 (dominant direction) with a soft floor so the unlit side never goes black
        vIrr = l0 * max(0.2, 1.0 + dot(pd, N)) + art + uSunColor * (sv * max(dot(N, uSunDir), 0.0));
        vWorld = wp.xyz; vN = N; vUv = uv;
        vec4 mv = viewMatrix * wp; vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      ${COMMON}
      uniform vec3 uColor, uEmissive;
      uniform float uRough, uSpecK;
      #ifdef USE_S9MAP
        uniform sampler2D uMap;
      #endif
      varying vec3 vIrr; varying vec3 vWorld; varying vec3 vN; varying float vDist; varying vec2 vUv;
      void main() {
        vec3 albedo = uColor;
        #ifdef USE_S9MAP
          albedo *= texture(uMap, vUv).rgb;
        #endif
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        float nv = max(dot(N, V), 1e-3);
        float occ = clamp(luma(vIrr) / uEnvAvg, 0.0, 1.0);
        vec3 spec = envSample(reflect(-V, N)) * (envBRDF(nv, uRough) * uSpecK * uSpec * occ);
        vec3 fs;
        vec3 c = albedo * (vIrr + dynLight(vWorld, N, V, uRough, fs)) + spec + fs * uSpecK + uEmissive;
        gl_FragColor = vec4(applyFog(c, vDist) * uExposure, 1.0);
      }`,
  });
  return m;
}

/** feed a probe: 'object' material from a light sample { r,g,b, ar,ag,ab, dx,dy,dz, sun } (artLevel: circuit) */
export function setObjectLight(material, s, artLevel = 1) {
  const u = material.uniforms;
  u.uProbeAmb.value.set(s.r + s.ar * artLevel, s.g + s.ag * artLevel, s.b + s.ab * artLevel);
  u.uProbeDirU.value.set(s.dx, s.dy, s.dz);
  u.uProbeSunU.value = s.sun;
}

/** Replace the materials of a loaded model (glTF) by dynamic materials, keeping colour + base colour map. */
export function convertToDynamic(root, opts = {}) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const conv = (src) => {
      if (cache.has(src)) return cache.get(src);
      const map = src.map ?? null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const c = src.color ? [src.color.r, src.color.g, src.color.b] : [0.6, 0.6, 0.6];
      const m = createDynamicMaterial({ roughness: src.roughness ?? 0.6, specular: src.metalness > 0.5 ? 0.8 : 0.4, ...opts, map, color: c });
      cache.set(src, m);
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
  return root;
}

// ------------------------------------------------------------------------------------------------------------
// Loading: material layers (texture arrays) + baked environment cubes.
const envState = { zones: null, nz: 0, cur: new Float32Array(ENV_W * ENV_H * 4), half: new Uint16Array(ENV_W * ENV_H * 4), tex: null, zone: -1, ready: false };
{
  // neutral placeholders so every shader compiles and renders before/without data
  const t = new THREE.DataTexture(envState.half, ENV_W, ENV_H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; t.name = 'envCur';
  envState.tex = t; U.uEnvCur.value = t;
  const h = THREE.DataUtils.toHalfFloat(0.3);
  for (let i = 0; i < envState.half.length; i++) envState.half[i] = i % 4 === 3 ? THREE.DataUtils.toHalfFloat(1) : h;
  const mk = (srgb) => {
    const a = new THREE.DataArrayTexture(new Uint8Array([200, 200, 200, 255, 128, 128, 160, 255]).subarray(srgb ? 0 : 4, srgb ? 4 : 8), 1, 1, 1);
    a.needsUpdate = true; if (srgb) a.colorSpace = THREE.SRGBColorSpace; return a;
  };
  U.uMatA.value = mk(true); U.uMatN.value = mk(false);
}

async function decodeLayer(path, size) {
  const blob = await (await fetch(url(path))).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, size, size);
  bmp.close?.();
  return g.getImageData(0, 0, size, size).data;
}

/** Load the world material layers and the env cubes. tier decides the normal/roughness layer + anisotropy. */
export async function loadMaterials(ctx, loader, manifest) {
  const tier = ctx.quality?.tier ?? { id: 'low' };
  const detail = tier.id === 'mid' || tier.id === 'high';
  const done = loader.step('Materialien', 0.6);
  try {
    const meta = await loader.json('assets/materials/materials.json', 0.05);
    const S = meta.size, n = meta.layers.length;
    LAYERS = meta.layers.map((l) => l.name);
    fillSurfTable(LAYERS);
    const lin = new Float32Array(MAX_LAYERS * 4);
    meta.layers.forEach((l, i) => {
      const m = l.mean, lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
      lin.set([1 / Math.max(m[0], 1e-3), 1 / Math.max(m[1], 1e-3), 1 / Math.max(m[2], 1e-3), 1 / Math.max(lum, 1e-3)], i * 4);
    });
    U.uLayerInv.value.set(lin);
    const fl = Math.max(0, LAYERS.indexOf('flat'));
    U.uMacro.value.set(fl, lin[fl * 4 + 3]);
    const kinds = detail ? ['a', 'n'] : ['a'];
    const arrays = {};
    for (const k of kinds) {
      const data = new Uint8Array(S * S * 4 * n);
      await Promise.all(meta.layers.map(async (l, i) => data.set(await decodeLayer(`assets/materials/${l.name}_${k}.webp`, S), i * S * S * 4)));
      const t = new THREE.DataArrayTexture(data, S, S, n);
      t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
      t.anisotropy = Math.min(detail ? 8 : tier.id === 'vlow' ? 2 : 4, ctx.render.renderer.capabilities.getMaxAnisotropy());
      if (k === 'a') t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true; t.name = `mat_${k}`;
      arrays[k] = t;
      ctx.render.trackTexture(`materials_${k}`, S * S * 4 * n * 1.34);
    }
    U.uMatA.value = arrays.a;
    if (arrays.n) U.uMatN.value = arrays.n;
    U.uMatDetail.value = detail ? 1 : 0;
  } catch (e) { console.warn('[materials] layers not loaded:', e.message); }
  try {
    if (ctx.world?.gen) { U.uFloorMask.value = buildFloorMask(ctx.world.gen); ctx.render.trackTexture('floorMask', FM.w * FM.h * 4 * 1.34); }
    U.uFloorXf.value.set(FM.x0, FM.z0, 1 / (FM.w * FM.res), 1 / (FM.h * FM.res));
  } catch (e) { console.warn('[materials] layers not loaded:', e.message); }
  // baked environment cubes (per zone, day + art)
  try {
    const E = manifest?.env;
    if (E) {
      const bytes = await loader.bin('bake/' + E.file, { inflate: true, weight: 0.2 });
      const w = E.width, h = E.height, nz = E.zones.length, ES = E.size, R = E.range;
      const dec = (o) => { const out = new Float32Array(w * h * 3); for (let i = 0; i < w * h; i++) { const m = bytes[o + i * 4 + 3] / 255 * R / 255; out[i * 3] = bytes[o + i * 4] * m; out[i * 3 + 1] = bytes[o + i * 4 + 1] * m; out[i * 3 + 2] = bytes[o + i * 4 + 2] * m; } return out; };
      const day = dec(0), art = dec(w * h * 4);
      envState.zones = { day, art, w, ES }; envState.nz = nz; envState.ready = ES === 16 && w === ENV_W;
      envState.zone = -1;
    }
  } catch (e) { console.warn('[materials] env not loaded:', e.message); }
  done();
}

// ------------------------------------------------------------------------------------------------------------
// Ground-floor "floor mask" generated from the level at load: R = paint coverage, G = grime (contact dirt along
// walls/racks + patchy wear), B = paint colour (0 yellow, 1 white), A = tyre marks. 0.125 m over the whole site.
const FM = { x0: -16, z0: -16, res: 0.125, w: 1024, h: 1008 };
function buildFloorMask(gen) {
  const { w, h, res, x0, z0 } = FM, n = w * h;
  const R = new Float32Array(n), Gd = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n), occ = new Float32Array(n);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cx = (x) => Math.floor((x - x0) / res), cz = (z) => Math.floor((z - z0) / res);
  const fill = (arr, xa, za, xb, zb, v, mode = 0) => {
    const i0 = Math.max(0, cx(xa)), i1 = Math.min(w - 1, cx(xb)), j0 = Math.max(0, cz(za)), j1 = Math.min(h - 1, cz(zb));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * w + i; arr[k] = mode ? Math.max(arr[k], v) : v; }
  };
  // occupancy of everything standing on the ground floor
  const racks = new Map();
  for (const b of gen.boxes) {
    if (!b.render || b.min[1] > 0.3 || b.max[1] < 0.05 || b.min[1] < -0.5) continue;
    if (b.cls === 'arch' && b.max[1] - b.min[1] < 0.4) continue;   // slabs themselves
    fill(occ, b.min[0], b.min[2], b.max[0], b.max[2], 1);
    if (b.group === 'rack' && b.tag) {
      const r = racks.get(b.tag) ?? [Infinity, Infinity, -Infinity, -Infinity];
      r[0] = Math.min(r[0], b.min[0]); r[1] = Math.min(r[1], b.min[2]); r[2] = Math.max(r[2], b.max[0]); r[3] = Math.max(r[3], b.max[2]);
      racks.set(b.tag, r);
    }
  }
  // contact grime: blurred occupancy (separable box blur, 2 passes ≈ Gaussian ~0.5 m)
  const blur = (src, dst, rad) => {
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      const s = pass ? dst : src;
      for (let j = 0; j < h; j++) { let acc = 0; for (let i = -rad; i < w + rad; i++) { if (i + rad < w) acc += s[j * w + i + rad] ?? 0; if (i - rad - 1 >= 0) acc -= s[j * w + i - rad - 1]; if (i >= 0 && i < w) tmp[j * w + i] = acc / (2 * rad + 1); } }
      for (let i = 0; i < w; i++) { let acc = 0; for (let j = -rad; j < h + rad; j++) { if (j + rad < h) acc += tmp[(j + rad) * w + i]; if (j - rad - 1 >= 0) acc -= tmp[(j - rad - 1) * w + i]; if (j >= 0 && j < h) dst[j * w + i] = acc / (2 * rad + 1); } }
    }
  };
  blur(occ, Gd, 3);
  // aisle lines: yellow, 0.1 m wide, 0.2 m in front of the long sides of each rack run
  for (const r of racks.values()) {
    const alongZ = r[3] - r[1] > r[2] - r[0];
    if (alongZ) { fill(R, r[0] - 0.3, r[1], r[0] - 0.2, r[3], 1); fill(R, r[2] + 0.2, r[1], r[2] + 0.3, r[3], 1); }
    else { fill(R, r[0], r[1] - 0.3, r[2], r[1] - 0.2, 1); fill(R, r[0], r[3] + 0.2, r[2], r[3] + 0.3, 1); }
  }
  // dock bays: yellow/black hatching 3.5 m deep inside every roller door at ground level; white edge lines
  for (const d of gen.doors ?? []) {
    if (d.kind !== 'roller' || d.y0 > 0.3) continue;
    const ax = d.axis === 'x' ? 0 : 2;
    for (const side of [-1, 1]) {
      const p = [0, 0.5, 0], q = [0, 0.5, 0];
      p[ax] = (d.a + d.b) / 2; p[2 - ax] = d.at + side * 2;
      if (gen.zoneLookup.at(p[0], p[1], p[2]) < 0 || gen.zones[gen.zoneLookup.at(p[0], p[1], p[2])].acoustic === 'outdoor') continue;
      const a0 = d.a - 0.3, a1 = d.b + 0.3, t0 = d.at + side * (d.th / 2 + 0.05), t1 = d.at + side * (d.th / 2 + 3.5);
      const tl = Math.min(t0, t1), th = Math.max(t0, t1);
      const i0 = cx(ax === 0 ? a0 : tl), i1 = cx(ax === 0 ? a1 : th), j0 = cz(ax === 0 ? tl : a0), j1 = cz(ax === 0 ? th : a1);
      for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i++) {
        const edge = i - i0 < 1 || i1 - i < 1 || j - j0 < 1 || j1 - j < 1;
        const diag = ((i + j) * res) % 1.0 < 0.5;
        if (edge || diag) { R[j * w + i] = 1; B[j * w + i] = edge ? 1 : 0; }
      }
      void q;
    }
  }
  // tyre marks: forklift track pairs along the main directions in the halls, curving near the ends
  for (let k = 0; k < 160; k++) {
    let x = 30 + rnd() * 64, z = 2 + rnd() * 60;
    if (k < 40) { x = 2 + rnd() * 25; z = 38 + rnd() * 25; }   // goods-in
    const alongZ = rnd() < 0.65, len = 6 + rnd() * 18, curve = (rnd() - 0.5) * 0.12, str = 0.25 + rnd() * 0.5;
    let ang = alongZ ? (rnd() < 0.5 ? 0 : Math.PI) : (rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    for (let s = 0; s < len; s += res * 0.7) {
      ang += curve * res * 0.7 * (s > len * 0.7 ? 4 : 0.3);
      const dx = Math.sin(ang), dz = Math.cos(ang);
      x += dx * res * 0.7; z += dz * res * 0.7;
      for (const off of [-0.55, 0.55]) {
        const px = x + dz * off, pz = z - dx * off, i = cx(px), j = cz(pz);
        if (i < 1 || j < 1 || i >= w - 1 || j >= h - 1 || occ[j * w + i] > 0) continue;
        const fade = Math.min(1, s / 2, (len - s) / 2) * str;
        A[j * w + i] = Math.max(A[j * w + i], fade); A[j * w + i + 1] = Math.max(A[j * w + i + 1], fade * 0.6);
      }
    }
  }
  // pack (+ patchy wear noise into G)
  const out = new Uint8Array(n * 4);
  const grid = new Float32Array(66 * 66); for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    const u = i / w * 64, v = j / h * 64, iu = u | 0, iv = v | 0, fu = u - iu, fv = v - iv;
    const nz = (grid[iv * 66 + iu] * (1 - fu) + grid[iv * 66 + iu + 1] * fu) * (1 - fv) + (grid[(iv + 1) * 66 + iu] * (1 - fu) + grid[(iv + 1) * 66 + iu + 1] * fu) * fv;
    const grime = occ[k] > 0 ? 0 : Math.min(1, Gd[k] * 1.6) * (0.6 + 0.6 * nz) + Math.max(0, nz - 0.6) * 0.5;
    out[k * 4] = Math.round(R[k] * 255); out[k * 4 + 1] = Math.round(Math.min(1, grime) * 255);
    out[k * 4 + 2] = Math.round(B[k] * 255); out[k * 4 + 3] = Math.round(Math.min(1, A[k]) * 255);
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.needsUpdate = true; t.name = 'floorMask';
  return t;
}

/** per frame: blend the current env cube towards the camera zone's (day + art × circuit level) */
export function updateEnvironment(zone, artLevel, dt) {
  if (!envState.ready || zone < 0 || zone >= envState.nz) return;
  const { day, art, w } = envState.zones, cur = envState.cur, half = envState.half;
  const first = envState.zone < 0;
  const k = first ? 1 : 1 - Math.exp(-dt / 0.35);
  envState.zone = zone;
  let sum = 0, change = 0;
  const row0 = zone * ENV_H;
  for (let j = 0; j < ENV_H; j++) for (let i = 0; i < ENV_W; i++) {
    const s = ((row0 + j) * w + i) * 3, d = (j * ENV_W + i) * 4;
    for (let c = 0; c < 3; c++) {
      const t = day[s + c] + art[s + c] * artLevel, v = cur[d + c] + (t - cur[d + c]) * k;
      change += Math.abs(v - cur[d + c]); cur[d + c] = v;
    }
    sum += 0.2126 * cur[d] + 0.7152 * cur[d + 1] + 0.0722 * cur[d + 2];
  }
  U.uEnvAvg.value = Math.max(0.01, sum / (ENV_W * ENV_H));
  if (!first && change < 1e-3 * ENV_W * ENV_H) return;
  const toH = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < ENV_W * ENV_H; i++) { const d = i * 4; half[d] = toH(cur[d]); half[d + 1] = toH(cur[d + 1]); half[d + 2] = toH(cur[d + 2]); half[d + 3] = 15360; }
  envState.tex.needsUpdate = true;
}
