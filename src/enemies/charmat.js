// Shared PBR material for all enemy bodies and weapons (one shader program for everything).
// Per vertex: color (albedo incl. baked AO), aSurf (one-hot cloth set: cotton, denim, leather, knit), aPbr (roughness, metalness).
// Cloth sets are Poly Haven CC0 textures packed by scripts/characters-assets.py (normal xy, roughness, albedo detail),
// mapped triplanar in bind-pose model space so they tile at real-world scale and stick to the skinned body.
// No DOM access at import time (Node self-test); textures load lazily in the browser.
import * as THREE from 'three';

function assetBase() {
  let base = '/';
  try { base = import.meta.env.BASE_URL || '/'; } catch { /* not under Vite */ }
  return base.replace(/\/?$/, '/') + 'assets/characters/';
}

export const CLOTH_SETS = ['cotton', 'denim', 'leather', 'knit'];
// metres per texture repeat (Poly Haven real-world sizes, slightly enlarged so the weave survives the bodycam blur)
const TILE = [0.3, 0.3, 0.42, 0.3];
const NORMAL_STRENGTH = [1.0, 1.1, 0.8, 1.2];
const DETAIL = [0.55, 0.8, 0.6, 0.55];

function neutralTexture() {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

const U = {
  tCloth0: { value: null }, tCloth1: { value: null }, tCloth2: { value: null }, tCloth3: { value: null },
  uTile: { value: new THREE.Vector4(...TILE) },
  uNormStr: { value: new THREE.Vector4(...NORMAL_STRENGTH) },
  uDetail: { value: new THREE.Vector4(...DETAIL) },
};

let loading = false;
function loadTextures(renderer) {
  if (loading || typeof document === 'undefined' || typeof Image === 'undefined') return;
  loading = true;
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  CLOTH_SETS.forEach((name, i) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const W = img.naturalWidth, q = W >> 1;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = W;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const src = g.getImageData(0, 0, W, W).data;
        const data = new Uint8Array(q * q * 4);
        for (let y = 0; y < q; y++) {
          for (let x = 0; x < q; x++) {
            const o = (y * q + x) * 4;
            data[o] = src[(y * W + x) * 4];                    // normal x
            data[o + 1] = src[(y * W + x + q) * 4];            // normal y
            data[o + 2] = src[((y + q) * W + x) * 4];          // roughness
            data[o + 3] = src[((y + q) * W + x + q) * 4];      // albedo detail
          }
        }
        const t = new THREE.DataTexture(data, q, q, THREE.RGBAFormat);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = aniso;
        t.flipY = false;
        t.needsUpdate = true;
        U['tCloth' + i].value = t;
      } catch (e) { console.warn('[enemies] cloth texture', name, e); }
    };
    img.onerror = () => console.warn('[enemies] missing cloth texture', name);
    img.src = assetBase() + name + '.webp';
  });
}

const VERT_PARS = /* glsl */`
attribute vec4 aSurf;
attribute vec2 aPbr;
varying vec4 vSurf;
varying vec2 vPbr;
varying vec3 vRest;
varying vec3 vRestN;
`;
const VERT_MAIN = /* glsl */`
vSurf = aSurf; vPbr = aPbr; vRest = position; vRestN = normal;
`;
const FRAG_PARS = /* glsl */`
uniform sampler2D tCloth0, tCloth1, tCloth2, tCloth3;
uniform vec4 uTile, uNormStr, uDetail;
varying vec4 vSurf;
varying vec2 vPbr;
varying vec3 vRest;
varying vec3 vRestN;
float chash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(chash(i), chash(i + vec3(1,0,0)), f.x), mix(chash(i + vec3(0,1,0)), chash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(chash(i + vec3(0,0,1)), chash(i + vec3(1,0,1)), f.x), mix(chash(i + vec3(0,1,1)), chash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec4 clothSample(int id, vec2 uv, vec2 dx, vec2 dy) {
  if (id == 0) return textureGrad(tCloth0, uv, dx, dy);
  if (id == 1) return textureGrad(tCloth1, uv, dx, dy);
  if (id == 2) return textureGrad(tCloth2, uv, dx, dy);
  return textureGrad(tCloth3, uv, dx, dy);
}
vec3 clothPerturb(vec3 N, vec3 q0, vec3 q1, vec2 st0, vec2 st1, vec2 m) {
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return normalize(T * (m.x * sc) + B * (m.y * sc) + N);
}
`;
const FRAG_ROUGH = /* glsl */`
float roughnessFactor = vPbr.x;
int clothId = -1; float clothW = 0.3;
if (vSurf.x > clothW) { clothId = 0; clothW = vSurf.x; }
if (vSurf.y > clothW) { clothId = 1; clothW = vSurf.y; }
if (vSurf.z > clothW) { clothId = 2; clothW = vSurf.z; }
if (vSurf.w > clothW) { clothId = 3; clothW = vSurf.w; }
vec3 cbw = pow(abs(normalize(vRestN)), vec3(4.0)); cbw /= (cbw.x + cbw.y + cbw.z);
vec2 cuvX = vRest.zy, cuvY = vRest.xz, cuvZ = vRest.xy;
vec2 cdxX = dFdx(cuvX), cdyX = dFdy(cuvX), cdxY = dFdx(cuvY), cdyY = dFdy(cuvY), cdxZ = dFdx(cuvZ), cdyZ = dFdy(cuvZ);
vec3 cq0 = dFdx(-vViewPosition), cq1 = dFdy(-vViewPosition);
vec4 csX = vec4(0.5), csY = vec4(0.5), csZ = vec4(0.5);
float cStr = 0.0;
if (clothId >= 0) {
  float it = 1.0 / uTile[clothId];
  csX = clothSample(clothId, cuvX * it, cdxX * it, cdyX * it);
  csY = clothSample(clothId, cuvY * it, cdxY * it, cdyY * it);
  csZ = clothSample(clothId, cuvZ * it, cdxZ * it, cdyZ * it);
  vec4 cs = csX * cbw.x + csY * cbw.y + csZ * cbw.z;
  diffuseColor.rgb *= mix(1.0, cs.a * 2.0, uDetail[clothId]);
  roughnessFactor = clamp(roughnessFactor + (cs.b - 0.5) * 0.45, 0.04, 1.0);
  cStr = uNormStr[clothId] * smoothstep(0.3, 0.6, clothW);
} else {
  // skin / hard surfaces: fine roughness breakup
  float n = cnoise(vRest * 140.0) * 0.6 + cnoise(vRest * 23.0) * 0.4;
  roughnessFactor = clamp(roughnessFactor + (n - 0.5) * 0.16, 0.04, 1.0);
}
`;
const FRAG_NORMAL = /* glsl */`
if (cStr > 0.0) {
  vec3 nX = clothPerturb(normal, cq0, cq1, cdxX, cdyX, (csX.rg * 2.0 - 1.0) * cStr);
  vec3 nY = clothPerturb(normal, cq0, cq1, cdxY, cdyY, (csY.rg * 2.0 - 1.0) * cStr);
  vec3 nZ = clothPerturb(normal, cq0, cq1, cdxZ, cdyZ, (csZ.rg * 2.0 - 1.0) * cStr);
  normal = normalize(nX * cbw.x + nY * cbw.y + nZ * cbw.z);
}
`;

let shared = null;
/** The one material used by every enemy mesh. */
export function getCharacterMaterial(renderer) {
  loadTextures(renderer);
  if (shared) return shared;
  for (let i = 0; i < 4; i++) if (!U['tCloth' + i].value) U['tCloth' + i].value = neutralTexture();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
  m.name = 'enemy_character';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL);
  };
  m.customProgramCacheKey = () => 'enemy_character_v1';
  shared = m;
  return m;
}
