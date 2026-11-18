// GLSL sources for the bodycam post chain.
// All shaders are plain THREE.ShaderMaterial (three prepends "#version 300 es" plus the
// texture2D / gl_FragColor / varying compatibility defines), so we write GLSL ES 3.00 code
// using texture()/textureLod()/texelFetch() and gl_FragColor. Every helper is prefixed "bc"
// to avoid clashing with three's injected colorspace helpers.

export const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Shared: auto exposure (reads the 1x1 adapted log-luminance target).
// exposure = key / (adaptedLum^adapt * refLum^(1-adapt)), clamped, plus muzzle flash burst.
const exposureGLSL = /* glsl */ `
#define BC_LUMA vec3(0.2126, 0.7152, 0.0722)
uniform sampler2D tAdapt;
uniform float uKey;
uniform float uAdaptAmt;
uniform float uRefLum;
uniform float uExpMin;
uniform float uExpMax;
uniform float uFlash;
uniform float uFlashGain;
float bcExposure() {
  float lg = texture(tAdapt, vec2(0.5)).r;
  float lgMix = lg * uAdaptAmt + log(uRefLum) * (1.0 - uAdaptAmt);
  float e = clamp(uKey / exp(lgMix), uExpMin, uExpMax);
  return e * (1.0 + uFlash * uFlashGain);
}
`;

const hashGLSL = /* glsl */ `
uint bcHashU(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float bcHash(vec3 p) {
  uvec3 q = uvec3(abs(p));
  uint h = bcHashU(q.x ^ bcHashU(q.y ^ bcHashU(q.z)));
  return float(h) * (1.0 / 4294967296.0);
}
float bcIGN(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

// ---------------------------------------------------------------------------------------------
// 1) Metering: center-weighted log luminance into a small mipmapped target.
export const lumFrag = /* glsl */ `
#define BC_LUMA vec3(0.2126, 0.7152, 0.0722)
uniform sampler2D tScene;
uniform highp sampler2D tDepth;
uniform float uLod;
uniform float uNear;
uniform float uFar;
uniform float uVMDepth;
varying vec2 vUv;
void main() {
  vec3 c = textureLod(tScene, vUv, uLod).rgb;
  float l = dot(c, BC_LUMA);
  if (isnan(l) || isinf(l)) l = 1.0;
  l = clamp(l, 1e-4, 2e4);
  vec2 d = (vUv - 0.5) * vec2(1.4, 1.0);
  float w = 0.3 + exp(-dot(d, d) * 7.0);
  float dz = textureLod(tDepth, vUv, 0.0).r;
  float z = (uNear * uFar) / max(uFar - dz * (uFar - uNear), 1e-6);
  if (z < uVMDepth) w *= 0.05; // ignore the first-person viewmodel
  gl_FragColor = vec4(log(l) * w, w, 0.0, 1.0);
}`;

// 2) Temporal adaptation into a 1x1 target (stores log luminance).
export const adaptFrag = /* glsl */ `
uniform sampler2D tLum;
uniform sampler2D tPrev;
uniform float uLumLod;
uniform float uDt;
uniform float uTauUp;
uniform float uTauDown;
uniform float uReset;
varying vec2 vUv;
void main() {
  vec4 s = textureLod(tLum, vec2(0.5), uLumLod);
  float target = clamp(s.r / max(s.g, 1e-5), -9.0, 9.0);
  float prev = texture(tPrev, vec2(0.5)).r;
  float tau = target > prev ? uTauUp : uTauDown;
  float k = 1.0 - exp(-uDt / max(tau, 1e-3));
  float v = mix(prev, target, k);
  if (uReset > 0.5 || isnan(v) || isinf(v)) v = target;
  if (isnan(v) || isinf(v)) v = -1.7;
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

// 3) Bloom prefilter: exposed, soft-thresholded, Karis-weighted 4x4 downsample (half res).
export const bloomPreFrag = exposureGLSL + /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 bcSafe(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return min(c, vec3(6e4));
}
void main() {
  float e = bcExposure();
  vec3 a = bcSafe(textureLod(tScene, vUv + uTexel * vec2(-1.0, -1.0), 0.0).rgb) * e;
  vec3 b = bcSafe(textureLod(tScene, vUv + uTexel * vec2( 1.0, -1.0), 0.0).rgb) * e;
  vec3 c = bcSafe(textureLod(tScene, vUv + uTexel * vec2(-1.0,  1.0), 0.0).rgb) * e;
  vec3 d = bcSafe(textureLod(tScene, vUv + uTexel * vec2( 1.0,  1.0), 0.0).rgb) * e;
  float wa = 1.0 / (1.0 + dot(a, BC_LUMA));
  float wb = 1.0 / (1.0 + dot(b, BC_LUMA));
  float wc = 1.0 / (1.0 + dot(c, BC_LUMA));
  float wd = 1.0 / (1.0 + dot(d, BC_LUMA));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  gl_FragColor = vec4(min(col * contrib, vec3(256.0)), 1.0);
}`;

// 4) Dual-filter (Kawase) down / up sampling.
export const bloomDownFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(tSrc, vUv).rgb * 4.0;
  s += texture(tSrc, vUv - h).rgb;
  s += texture(tSrc, vUv + h).rgb;
  s += texture(tSrc, vUv + vec2(h.x, -h.y)).rgb;
  s += texture(tSrc, vUv - vec2(h.x, -h.y)).rgb;
  gl_FragColor = vec4(s * 0.125, 1.0);
}`;

export const bloomUpFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tAdd;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(tSrc, vUv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  gl_FragColor = vec4(s / 12.0 + texture(tAdd, vUv).rgb, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// 5) Camera composite (HDR -> display-encoded LDR):
//    image shake, rolling shutter, barrel lens, lateral CA, edge softness, rotation motion blur,
//    defocus (menu/death), AO, optical vignette, exposure, bloom + lens dirt, ACES + hard clip,
//    grading (desat, teal cast), damage pulse, sRGB encode, black lift.
export const compositeFrag = exposureGLSL + hashGLSL + /* glsl */ `
uniform sampler2D tScene;
uniform highp sampler2D tDepth;
uniform sampler2D tBloom;
uniform sampler2D tBloomWide;
uniform sampler2D tAO;
uniform sampler2D tDirt;
uniform vec2 uRes;
uniform float uAspect;
uniform mat4 uReproj;
uniform float uInvDt;
uniform int uMBSamples;
uniform float uMBMax;
uniform vec2 uShutter;
uniform vec3 uShake;
uniform float uZoom;
uniform vec2 uRSVel;
uniform float uWobble;
uniform float uTime;
uniform vec2 uDistort;
uniform float uCA;
uniform float uEdgeSoft;
uniform float uVignette;
uniform float uAOAmt;
uniform float uBloomAmt;
uniform vec3 uBloomTint;
uniform float uDirtAmt;
uniform float uNear;
uniform float uFar;
uniform float uVMDepth;
uniform float uSensorGain;
uniform float uClip;
uniform float uSat;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uBlack;
uniform float uDamage;
uniform float uDeadDesat;
uniform float uBlur;
uniform float uBlurLod;
uniform float uMenu;
varying vec2 vUv;

float bcLinDepth(vec2 uv) {
  float d = textureLod(tDepth, uv, 0.0).r;
  return (uNear * uFar) / max(uFar - d * (uFar - uNear), 1e-6);
}

vec3 bcTapCA(vec2 uv, float caS, float lod) {
  vec2 c = uv - 0.5;
  float r = textureLod(tScene, 0.5 + c * (1.0 + caS), lod).r;
  float g = textureLod(tScene, uv, lod).g;
  float b = textureLod(tScene, 0.5 + c * (1.0 - caS), lod).b;
  return vec3(r, g, b);
}

vec3 bcRRTODT(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 bcAces(vec3 color) {
  const mat3 inM = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= 1.0 / 0.6;
  color = inM * color;
  color = bcRRTODT(color);
  color = outM * color;
  return clamp(color, 0.0, 1.0);
}

vec3 bcOETF(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 p = (vUv - 0.5) * asp;

  // image-space shake (rotation + offset), with zoom-in so edges never run out of image
  float cs = cos(uShake.z);
  float sn = sin(uShake.z);
  p = mat2(cs, sn, -sn, cs) * p + uShake.xy;
  p *= uZoom;

  // rolling shutter: rows are read top -> bottom, later rows see the image moved further
  float rowT = 0.5 - vUv.y;
  p -= uRSVel * asp * rowT;
  p.x += uWobble * (sin(vUv.y * 37.0 + uTime * 41.0) + 0.5 * sin(vUv.y * 11.0 - uTime * 23.0));

  // barrel distortion normalised so that the corners stay put (center gets magnified)
  float diag = length(asp) * 0.5;
  vec2 q = p / diag;
  float r2 = dot(q, q);
  float f = (1.0 + uDistort.x * r2 + uDistort.y * r2 * r2) / (1.0 + uDistort.x + uDistort.y);
  vec2 src = 0.5 + (q * f * diag) / asp;

  float edge = clamp(r2, 0.0, 1.5);
  float lod = uEdgeSoft * edge * edge;
  float caS = uCA * edge;

  float expo = bcExposure();

  // motion blur from camera rotation (exact rotational reprojection)
  vec2 vel = vec2(0.0);
  vec4 pp = uReproj * vec4(src * 2.0 - 1.0, 1.0, 1.0);
  if (pp.w > 1e-4) {
    vec2 prevUv = (pp.xy / pp.w) * 0.5 + 0.5;
    float gainS = sqrt(max(expo * uRefLum / uKey, 0.0));
    float shutter = clamp(uShutter.x * gainS, uShutter.x, uShutter.y);
    vel = (src - prevUv) * uInvDt * shutter;
  }
  float vlen = length(vel);
  if (vlen > uMBMax) vel *= uMBMax / vlen;
  if (bcLinDepth(src) < uVMDepth) vel = vec2(0.0); // keep the viewmodel sharp
  float pxLen = length(vel * uRes);
  int n = int(clamp(pxLen * 0.5, 1.0, float(uMBSamples)));

  vec3 col;
  if (n <= 1) {
    col = bcTapCA(src, caS, lod);
  } else {
    float jit = bcIGN(gl_FragCoord.xy + vec2(uTime * 61.0, 0.0)) - 0.5;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 32; i++) {
      if (i >= n) break;
      float t = (float(i) + 0.5 + jit) / float(n) - 0.5;
      vec2 uvi = src + vel * t;
      float w = bcLinDepth(uvi) < uVMDepth ? 0.0 : 1.0;
      acc += bcTapCA(uvi, caS, lod) * w;
      wsum += w;
    }
    col = wsum > 0.0 ? acc / wsum : bcTapCA(src, caS, lod);
  }

  // defocus (menu standby / death)
  if (uBlur > 0.001) {
    vec3 acc = vec3(0.0);
    float rad = exp2(uBlurLod);
    vec2 texel = 1.0 / uRes;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 2.39996 + 0.7;
      float rr = sqrt((float(i) + 0.5) / 8.0);
      vec2 o = vec2(cos(a), sin(a)) * rr * rad * texel;
      acc += textureLod(tScene, src + o, max(uBlurLod - 1.0, 0.0)).rgb;
    }
    col = mix(col, acc * 0.125, clamp(uBlur, 0.0, 1.0));
  }

  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  col = min(col, vec3(6e4));

  // ambient occlusion (contact shadows)
  float ao = texture(tAO, src).r;
  col *= mix(1.0, ao, uAOAmt);

  // optical vignetting (cos^4-ish falloff), before exposure
  float vig = max(1.0 - 0.42 * r2, 0.0);
  col *= mix(1.0, vig * vig, uVignette);

  // exposure, bloom, lens dirt
  col *= expo;
  col += texture(tBloom, src).rgb * uBloomTint * uBloomAmt;
  float dirt = texture(tDirt, vUv).r;
  col += texture(tBloomWide, src).rgb * dirt * uDirtAmt;

  // sensor response: ACES then a hard clip of the top end (cheap sensor)
  col = bcAces(col * uSensorGain);
  col = clamp(col * uClip, 0.0, 1.0);

  // grading
  float l = dot(col, BC_LUMA);
  col = mix(vec3(l), col, uSat);
  col *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.55, l));

  // hit pulse: red, desaturated edges
  float dmgMask = smoothstep(0.15, 1.0, r2);
  vec3 dcol = vec3(l * 0.9 + 0.12, l * 0.22, l * 0.2);
  col = mix(col, dcol, clamp(uDamage * (0.15 + 0.85 * dmgMask), 0.0, 1.0));

  // death / menu looks
  float l2 = dot(col, BC_LUMA);
  col = mix(col, vec3(l2), clamp(uDeadDesat, 0.0, 1.0));
  col = mix(col, vec3(l2) * vec3(0.95, 1.0, 1.02), uMenu * 0.35) * (1.0 - 0.25 * uMenu);

  col = bcOETF(clamp(col, 0.0, 1.0));
  col = uBlack + col * (1.0 - uBlack);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// 6) Encoder / sensor pass (display-encoded, renders to screen):
//    signal-loss glitch, tear line, FXAA, sharpening halo, sensor noise (gain-driven),
//    4:2:0 chroma + 8x8 block quantisation, P-frame smear, fade to dark.
export const finalFrag = exposureGLSL + hashGLSL + /* glsl */ `
uniform sampler2D tLDR;
uniform sampler2D tPrev;
uniform vec2 uRes;
uniform float uFrame;
uniform float uTime;
uniform float uNoise;
uniform float uChromaNoise;
uniform float uSharpen;
uniform float uFXAA;
uniform float uCompress;
uniform float uSmear;
uniform float uGlitch;
uniform float uTear;
uniform float uFade;
varying vec2 vUv;

float bcL(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 bcYCC(vec3 c) {
  float y = bcL(c);
  return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713);
}
vec3 bcRGB(vec3 ycc) {
  float r = ycc.x + 1.403 * ycc.z;
  float b = ycc.x + 1.773 * ycc.y;
  float g = (ycc.x - 0.299 * r - 0.114 * b) / 0.587;
  return vec3(r, g, b);
}

vec3 bcTap(vec2 uv) { return textureLod(tLDR, uv, 0.0).rgb; }

void main() {
  vec2 uv = vUv;
  float tq = floor(uTime * 14.0);

  // signal loss: displaced horizontal bands and vertical hops
  if (uGlitch > 0.001) {
    float band = floor(vUv.y * 30.0);
    if (bcHash(vec3(band, tq, 3.0)) < uGlitch * 0.55) {
      uv.x += (bcHash(vec3(band, tq, 7.0)) - 0.5) * 0.2 * uGlitch;
    }
    float big = floor(vUv.y * 6.0);
    if (bcHash(vec3(big, tq, 11.0)) < uGlitch * 0.25) {
      uv.y += (bcHash(vec3(big, tq, 13.0)) - 0.5) * 0.05;
    }
  }
  // tear line under heavy trauma
  if (uTear > 0.001) {
    float ty = fract(uTime * 0.7 + bcHash(vec3(floor(uTime * 3.0), 1.0, 2.0)));
    float m = 1.0 - smoothstep(0.0, 0.03, abs(vUv.y - ty));
    uv.x += m * uTear * 0.012;
  }
  uv = clamp(uv, vec2(0.0), vec2(1.0));

  vec2 rcp = 1.0 / uRes;
  vec3 cNW = bcTap(uv + vec2(-1.0, -1.0) * rcp);
  vec3 cNE = bcTap(uv + vec2( 1.0, -1.0) * rcp);
  vec3 cSW = bcTap(uv + vec2(-1.0,  1.0) * rcp);
  vec3 cSE = bcTap(uv + vec2( 1.0,  1.0) * rcp);
  vec3 cM  = bcTap(uv);
  vec3 c = cM;

  // FXAA (3.x console-style)
  if (uFXAA > 0.5) {
    float lNW = bcL(cNW);
    float lNE = bcL(cNE);
    float lSW = bcL(cSW);
    float lSE = bcL(cSE);
    float lM = bcL(cM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 * (1.0 / 8.0)), 1.0 / 128.0);
    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * rcp;
    vec3 rgbA = 0.5 * (bcTap(uv + dir * (1.0 / 3.0 - 0.5)) + bcTap(uv + dir * (2.0 / 3.0 - 0.5)));
    vec3 rgbB = rgbA * 0.5 + 0.25 * (bcTap(uv - dir * 0.5) + bcTap(uv + dir * 0.5));
    float lB = bcL(rgbB);
    c = (lB < lMin || lB > lMax) ? rgbA : rgbB;
  }

  // in-camera sharpening (gives the typical light/dark halo on edges)
  vec3 blurN = (cNW + cNE + cSW + cSE) * 0.25;
  c = clamp(c + (c - blurN) * uSharpen, 0.0, 1.0);

  // sensor noise: scales with sensor gain (dark scene -> higher gain), stronger in shadows
  vec2 px = floor(uv * uRes);
  float expo = bcExposure() / (1.0 + uFlash * uFlashGain);
  float gainN = clamp(expo * uRefLum / uKey, 0.25, 16.0);
  float sigma = uNoise * sqrt(gainN);
  float lc = bcL(c);
  float shadowW = mix(1.25, 0.35, smoothstep(0.0, 0.85, lc));
  float n1 = bcHash(vec3(px, uFrame)) + bcHash(vec3(px + 911.0, uFrame + 17.0)) - 1.0;
  vec2 cpx = floor(px * 0.5);
  float cn1 = bcHash(vec3(cpx, uFrame + 101.0)) - 0.5;
  float cn2 = bcHash(vec3(cpx, uFrame + 211.0)) - 0.5;
  c += vec3(n1) * sigma * shadowW;
  c += vec3(cn2, -0.5 * cn1 - 0.5 * cn2, cn1) * sigma * uChromaNoise * shadowW;

  // compression: 4:2:0 chroma, 8x8 block DC + quantised luma detail
  vec2 bpx = uv * uRes;
  ivec2 blk = ivec2(bpx / 8.0);
  ivec2 m3 = textureSize(tLDR, 3) - 1;
  vec3 avg = texelFetch(tLDR, clamp(blk, ivec2(0), m3), 3).rgb;
  ivec2 m1 = textureSize(tLDR, 1) - 1;
  vec3 c1 = texelFetch(tLDR, clamp(ivec2(bpx / 2.0), ivec2(0), m1), 1).rgb;
  vec3 ycc = bcYCC(c);
  vec3 yA = bcYCC(avg);
  vec3 y1 = bcYCC(c1);
  ycc.yz = mix(y1.yz, yA.yz, uCompress * 0.8);
  float qs = mix(0.015, 0.16, uCompress);
  float dy = ycc.x - yA.x;
  float dq = floor(dy / qs + 0.5) * qs;
  ycc.x = mix(ycc.x, yA.x + dq, smoothstep(0.0, 0.25, uCompress));
  c = bcRGB(ycc);

  // P-frame smear: a few macroblocks keep the previous frame
  if (uSmear > 0.001) {
    vec2 mb = floor(bpx / 16.0);
    if (bcHash(vec3(mb, floor(uFrame * 0.5) + 5.0)) < uSmear) {
      c = mix(c, texture(tPrev, uv).rgb, 0.85);
    }
  }

  // signal loss garbage rows + rolling dark bar
  if (uGlitch > 0.001) {
    float row = floor(vUv.y * 40.0);
    float h = bcHash(vec3(row, tq, 21.0));
    if (h < uGlitch * 0.16) {
      float g = bcHash(vec3(floor(vUv.x * uRes.x / 8.0), row, tq));
      c = mix(c, vec3(0.2 + 0.5 * g) * vec3(0.8, 1.0, 0.85), 0.85);
    } else if (h < uGlitch * 0.28) {
      c = mix(c, c.gbr * 1.2, 0.6);
    }
    c *= 1.0 - 0.45 * uGlitch * step(0.93, fract(vUv.y + uTime * 0.6));
  }

  c *= 1.0 - uFade;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
