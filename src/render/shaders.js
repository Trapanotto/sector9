// GLSL sources for the bodycam post chain.
// All shaders are plain THREE.ShaderMaterial (three prepends "#version 300 es" plus the
// texture2D / gl_FragColor / varying compatibility defines), so we write GLSL ES 3.00 code
// using texture()/textureLod()/texelFetch() and gl_FragColor. Every helper is prefixed "bc"
// to avoid clashing with three's injected colorspace helpers.
//
// Pass order per frame (see pipeline.js):
//   scene (HDR + depth) -> GTAO (+denoise) -> meter (64x64) -> camera state (4x1: AE, AWB, AF, veil)
//   -> bloom prefilter + dual-filter pyramid -> flare (1/4 res) -> DOF prep + gather (1/2 res)
//   -> camera composite (lens, sensor, ISP, TNR; internal res) -> encoder/output (display res)

export const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Camera state texture (4x1, half float), written by stateFrag every frame:
//   texel 0: AE   r = adapted log luminance, g = AE velocity, b = metered target, a = -
//   texel 1: AWB  r = log(R/G) of the scene, g = log(B/G) (slowly adapted)
//   texel 2: AF   r = focus distance in dioptres, g = AF velocity, b = AF timer, a = target
//   texel 3: veil r = mean linear scene luminance (for veiling glare)
const stateGLSL = /* glsl */ `
#define BC_LUMA vec3(0.2126, 0.7152, 0.0722)
uniform highp sampler2D tState;
uniform float uKey;
uniform float uAdaptAmt;
uniform float uRefLum;
uniform float uExpMin;
uniform float uExpMax;
uniform float uFlash;
uniform float uFlashGain;
vec4 bcState(int i) { return texelFetch(tState, ivec2(i, 0), 0); }
float bcExposureOf(float lg) {
  float lgMix = lg * uAdaptAmt + log(uRefLum) * (1.0 - uAdaptAmt);
  return clamp(uKey / exp(lgMix), uExpMin, uExpMax);
}
float bcExposureBase() { return bcExposureOf(bcState(0).r); }
float bcExposure() { return bcExposureBase() * (1.0 + uFlash * uFlashGain); }
// sensor gain relative to the daylight reference (1 = bright yard, >1 = dim interiors)
float bcGain() { return clamp(bcExposureBase() * uRefLum / uKey, 0.25, 32.0); }
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
  uvec3 q = uvec3(ivec3(floor(p)) + 32768);
  uint h = bcHashU(q.x ^ bcHashU(q.y ^ bcHashU(q.z)));
  return float(h) * (1.0 / 4294967296.0);
}
float bcIGN(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// smooth value noise, 0..1
float bcVNoise(vec2 x, float seed) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = bcHash(vec3(i, seed));
  float b = bcHash(vec3(i + vec2(1.0, 0.0), seed));
  float c = bcHash(vec3(i + vec2(0.0, 1.0), seed));
  float d = bcHash(vec3(i + vec2(1.0, 1.0), seed));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const depthGLSL = /* glsl */ `
uniform highp sampler2D tDepth;
uniform float uNear;
uniform float uFar;
float bcLinDepth(vec2 uv) {
  float d = textureLod(tDepth, uv, 0.0).r;
  return (uNear * uFar) / max(uFar - d * (uFar - uNear), 1e-6);
}
`;

// ---------------------------------------------------------------------------------------------
// 1) Metering: center-weighted log luminance into a small mipmapped target (viewmodel ignored,
//    so the gun and hands burn out when a light gets close, as on a real chest camera).
export const lumFrag = /* glsl */ `
#define BC_LUMA vec3(0.2126, 0.7152, 0.0722)
uniform sampler2D tScene;
uniform float uLod;
uniform sampler2D tVM;      // first-person viewmodel mask (r > 0.5)
uniform float uCenterW;
uniform float uMeterCap;
varying vec2 vUv;
` + depthGLSL + /* glsl */ `
void main() {
  vec3 c = textureLod(tScene, vUv, uLod).rgb;
  float l = dot(c, BC_LUMA);
  if (isnan(l) || isinf(l)) l = 1.0;
  l = clamp(l, 1e-4, 2e4);
  vec2 d = (vUv - 0.5) * vec2(1.4, 1.0);
  float w = 0.25 + uCenterW * exp(-dot(d, d) * 6.0);
  w *= 1.0 - 0.55 * smoothstep(0.5, 1.0, vUv.y);        // sky in the top rows counts less
  l = min(l, uMeterCap);                                  // windows / sky saturate the meter cell
  if (textureLod(tVM, vUv, 0.0).r > 0.5) w *= 0.04;              // ignore the first-person viewmodel
  gl_FragColor = vec4(log(l) * w, w, 0.0, 1.0);
}`;

// 2) Camera state: AE (second-order, overshooting, separate up/down speeds, dead band, flash
//    pull-down kick), AWB (grey world on mid-tones, slow, incomplete), contrast-AF (dead time,
//    spring with overshoot, occasional wrong-direction hunt), veiling-glare level.
export const stateFrag = stateGLSL + hashGLSL + /* glsl */ `
uniform sampler2D tLum;
uniform sampler2D tScene;
uniform float uLumLod;
uniform float uSceneLod;
uniform float uDt;
uniform float uTime;
uniform float uTauUp;
uniform float uTauDown;
uniform float uDamp;
uniform float uDeadband;
uniform float uKick;
uniform float uReset;
uniform float uAwbTau;
uniform vec4 uAF;        // delay s, omega, damping, deadband dpt
uniform vec2 uAFHunt;    // probability, kick
uniform float uAFMin;    // closest focus distance (m)
uniform float uAFFixed;  // >0: fixed focus at this many dioptres (AF disabled)
uniform float uAFNear;   // 0..1 bias toward the nearest subject in the AF zone (ADS)
` + depthGLSL + /* glsl */ `
void main() {
  int ix = int(gl_FragCoord.x);
  vec4 prev = texelFetch(tState, ivec2(ix, 0), 0);
  bool bad = any(isnan(prev)) || any(isinf(prev));
  bool reset = uReset > 0.5 || bad;
  vec4 o = prev;
  if (ix == 0) {
    vec4 s = textureLod(tLum, vec2(0.5), uLumLod);
    float target = clamp(s.r / max(s.g, 1e-5), -9.0, 9.0);
    float x = prev.r;
    float v = prev.g;
    float err = target - x;
    float tau = err > 0.0 ? uTauUp : uTauDown;
    float w = 1.0 / max(tau, 1e-3);
    float e2 = sign(err) * max(abs(err) - uDeadband, 0.0);
    float a = w * w * e2 - 2.0 * uDamp * w * v;
    v = clamp(v + a * uDt, -10.0, 10.0);
    x += v * uDt + uKick;
    if (reset) { x = target; v = 0.0; }
    o = vec4(x, v, target, 0.0);
  } else if (ix == 1) {
    float e = bcExposureOf(texelFetch(tState, ivec2(0, 0), 0).r);
    vec2 acc = vec2(0.0);
    float ws = 0.0;
    float lod = max(uSceneLod - 2.0, 0.0);
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        vec3 c = max(textureLod(tScene, (vec2(float(i), float(j)) + 0.5) / 4.0, lod).rgb, vec3(1e-5));
        if (any(isnan(c)) || any(isinf(c))) continue;
        float l = dot(c, BC_LUMA) * e;
        float wt = smoothstep(0.008, 0.05, l) * (1.0 - smoothstep(0.7, 1.6, l));
        acc += vec2(log(c.r / c.g), log(c.b / c.g)) * wt;
        ws += wt;
      }
    }
    vec2 tgt = ws > 0.05 ? clamp(acc / ws, vec2(-1.2), vec2(1.2)) : prev.rg;
    float k = 1.0 - exp(-uDt / max(uAwbTau, 1e-3));
    o.rg = reset ? tgt : mix(prev.rg, tgt, k);
    o.ba = vec2(0.0);
  } else if (ix == 2) {
    float Dmax = 1.0 / uAFMin;
    // contrast AF locks onto one subject: median of five centre samples (not an average,
    // which would focus between the front sight and the background)
    float A[5];
    A[0] = 1.0 / max(bcLinDepth(vec2(0.5, 0.5)), uAFMin);
    A[1] = 1.0 / max(bcLinDepth(vec2(0.46, 0.5)), uAFMin);
    A[2] = 1.0 / max(bcLinDepth(vec2(0.54, 0.5)), uAFMin);
    A[3] = 1.0 / max(bcLinDepth(vec2(0.5, 0.45)), uAFMin);
    A[4] = 1.0 / max(bcLinDepth(vec2(0.5, 0.56)), uAFMin);
    float Dt = A[0];
    for (int i = 0; i < 5; i++) {
      int below = 0, equal = 0;
      for (int j = 0; j < 5; j++) { below += A[j] < A[i] ? 1 : 0; equal += A[j] == A[i] ? 1 : 0; }
      if (below <= 2 && below + equal > 2) Dt = A[i];
    }
    // aiming down sights: the front sight fills the AF zone and wins (closest subject priority)
    float Amax = max(max(max(A[0], A[1]), max(A[2], A[3])), A[4]);
    Dt = clamp(mix(Dt, Amax, uAFNear), 0.0, Dmax);
    if (uAFFixed > 0.0) Dt = uAFFixed;
    float D = prev.r;
    float v = prev.g;
    float timer = prev.b;
    float err = Dt - D;
    bool settled = abs(err) < uAF.w && abs(v) < 0.08;
    float nt = settled ? 0.0 : timer + uDt;
    if (nt > uAF.x) {
      // contrast-detect AF does not know the direction: sometimes it racks the wrong way first
      if (timer <= uAF.x && abs(err) > 0.35 && bcHash(vec3(uTime * 97.0, 3.0, 5.0)) < uAFHunt.x) {
        v = -sign(err) * uAFHunt.y * (0.6 + abs(err));
      }
      float a = uAF.y * uAF.y * err - 2.0 * uAF.z * uAF.y * v;
      v = clamp(v + a * uDt, -40.0, 40.0);
    } else {
      v *= exp(-uDt * 18.0);
    }
    D = clamp(D + v * uDt, 0.0, Dmax);
    if (reset) { D = Dt; v = 0.0; nt = 0.0; }
    o = vec4(D, v, nt, Dt);
  } else {
    vec3 m = textureLod(tScene, vec2(0.5), uSceneLod).rgb;
    float l = dot(m, BC_LUMA);
    if (isnan(l) || isinf(l)) l = 0.0;
    l = clamp(l, 0.0, 1e4);
    float k = 1.0 - exp(-uDt / 0.12);
    o = vec4(reset ? l : mix(prev.r, l, k), 0.0, 0.0, 0.0);
  }
  if (any(isnan(o)) || any(isinf(o))) o = vec4(ix == 2 ? 0.1 : (ix == 0 ? -1.7 : 0.0), 0.0, 0.0, 0.0);
  gl_FragColor = o;
}`;

// 3) Bloom prefilter: exposed, soft-knee (no hard cut), Karis-weighted 4-tap downsample (half res).
export const bloomPreFrag = stateGLSL + /* glsl */ `
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
  // Karis average only damps single-pixel fireflies (weights saturate for big bright areas)
  float wa = 1.0 / (1.0 + 0.25 * dot(a, BC_LUMA));
  float wb = 1.0 / (1.0 + 0.25 * dot(b, BC_LUMA));
  float wc = 1.0 / (1.0 + 0.25 * dot(c, BC_LUMA));
  float wd = 1.0 / (1.0 + 0.25 * dot(d, BC_LUMA));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  if (uThreshold > 0.0) {
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
    col *= contrib;
  }
  gl_FragColor = vec4(min(col, vec3(512.0)), 1.0);
}`;

// 4) Dual-filter (Kawase) down / up sampling. Up pass accumulates all levels (energy is
//    normalised in the composite by dividing by the summed level weights).
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
uniform float uAddW;
uniform float uSrcW;
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
  gl_FragColor = vec4(s / 12.0 * uSrcW + texture(tAdd, vUv).rgb * uAddW, 1.0);
}`;

// 5) Lens flare (quarter res, from an 1/8-res bloom level): ghosts mirrored through the optical
//    centre with coating tints, a faint halo ring, and a cover-glass streak / starburst.
export const flareFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;       // texel of tSrc
uniform float uAspect;
uniform float uThresh;
uniform float uGhostAmt;
uniform int uGhosts;
uniform float uHaloAmt;
uniform float uStreakAmt;
uniform int uStreakTaps;
uniform vec2 uStreakDir;
varying vec2 vUv;
vec3 bcBright(vec2 uv) {
  vec3 c = textureLod(tSrc, uv, 0.0).rgb;
  float l = max(c.r, max(c.g, c.b));
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), uv) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - uv);
  return c * (max(l - uThresh, 0.0) / max(l, 1e-4)) * e.x * e.y;
}
void main() {
  vec2 uv = vUv;
  vec2 cdir = uv - 0.5;
  vec3 acc = vec3(0.0);
  if (uGhostAmt > 0.0) {
    // scale (negative = mirrored through the centre), tint
    const vec4 G0 = vec4(-0.62, 0.85, 0.55, 1.00);
    const vec4 G1 = vec4(-1.35, 1.00, 0.80, 0.45);
    const vec4 G2 = vec4(-0.28, 0.45, 0.95, 0.85);
    const vec4 G3 = vec4( 0.42, 0.95, 0.60, 0.80);
    const vec4 G4 = vec4(-2.10, 0.55, 1.00, 0.60);
    for (int i = 0; i < 5; i++) {
      if (i >= uGhosts) break;
      vec4 g = i == 0 ? G0 : i == 1 ? G1 : i == 2 ? G2 : i == 3 ? G3 : G4;
      vec2 guv = 0.5 + cdir * g.x;
      float fall = 1.0 - smoothstep(0.15, 0.75, length((guv - 0.5) * vec2(uAspect, 1.0)));
      acc += bcBright(guv) * g.yzw * fall * (0.6 / (0.6 + abs(g.x)));
    }
    acc *= uGhostAmt;
    // halo ring: light from the opposite side of the frame, slightly chromatic
    if (uHaloAmt > 0.0) {
      vec2 hd = normalize(vec2(cdir.x * uAspect, cdir.y) + 1e-5);
      hd.x /= uAspect;
      vec3 h;
      h.r = bcBright(uv + hd * 0.40).r;
      h.g = bcBright(uv + hd * 0.42).g;
      h.b = bcBright(uv + hd * 0.44).b;
      float ring = smoothstep(0.25, 0.45, length(cdir * vec2(uAspect, 1.0)));
      acc += h * uHaloAmt * ring;
    }
  }
  if (uStreakAmt > 0.0) {
    vec3 s = vec3(0.0);
    vec2 d1 = uStreakDir * uTexel * 1.4;
    vec2 d2 = vec2(-uStreakDir.y, uStreakDir.x) * uTexel * 1.4;
    for (int i = 1; i <= 12; i++) {
      if (i > uStreakTaps) break;
      float fi = float(i);
      float w = exp(-fi * 0.22);
      s += (bcBright(uv + d1 * fi) + bcBright(uv - d1 * fi)) * w;
      s += (bcBright(uv + d2 * fi) + bcBright(uv - d2 * fi)) * w * 0.35;
    }
    acc += s * uStreakAmt * vec3(0.95, 0.97, 1.0);
  }
  gl_FragColor = vec4(min(acc, vec3(64.0)), 1.0);
}`;

// 6) DOF prep (half res): far-biased colour + signed circle of confusion (half-res px, near < 0).
export const dofPrepFrag = stateGLSL + /* glsl */ `
uniform highp sampler2D tScene;
uniform vec2 uFullTexel;
uniform float uCocK;      // half-res px per dioptre of defocus
uniform float uCocMax;
varying vec2 vUv;
` + depthGLSL + /* glsl */ `
void main() {
  vec2 o = uFullTexel * 0.5;
  vec2 uv0 = vUv + vec2(-o.x, -o.y);
  vec2 uv1 = vUv + vec2( o.x, -o.y);
  vec2 uv2 = vUv + vec2(-o.x,  o.y);
  vec2 uv3 = vUv + vec2( o.x,  o.y);
  float z0 = bcLinDepth(uv0), z1 = bcLinDepth(uv1), z2 = bcLinDepth(uv2), z3 = bcLinDepth(uv3);
  float zmax = max(max(z0, z1), max(z2, z3));
  vec4 w = vec4(z0, z1, z2, z3) / zmax;
  w = mix(vec4(0.08), vec4(1.0), step(vec4(0.8), w));
  vec3 c = textureLod(tScene, uv0, 0.0).rgb * w.x + textureLod(tScene, uv1, 0.0).rgb * w.y
         + textureLod(tScene, uv2, 0.0).rgb * w.z + textureLod(tScene, uv3, 0.0).rgb * w.w;
  c /= dot(w, vec4(1.0));
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  float zmin = min(min(z0, z1), min(z2, z3));
  float D = bcState(2).r;
  // near field uses the nearest depth (so blurry foreground edges extend), far uses the farthest
  float cocN = uCocK * (D - 1.0 / zmin);
  float cocF = uCocK * (D - 1.0 / zmax);
  float coc = cocN < -0.5 ? cocN : cocF;
  gl_FragColor = vec4(min(c, vec3(2e3)), clamp(coc, -uCocMax, uCocMax));
}`;

// 7) DOF gather (half res): scatter-as-gather disk with separate near / far layers.
//    Far taps are limited by the centre's own CoC (sharp foreground never bleeds into the
//    blurred background); near taps spread over everything behind them.
export const dofGatherFrag = /* glsl */ `
uniform sampler2D tPrep;
uniform vec2 uTexel;
uniform int uTaps;
uniform float uCocMax;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec4 ctr = textureLod(tPrep, vUv, 0.0);
  float cc = ctr.a;
  vec3 accF = vec3(0.0); float wF = 0.0;
  vec3 accN = vec3(0.0); float wN = 0.0;
  float cover = 0.0;
  if (cc >= 0.0) { accF = ctr.rgb; wF = 1.0; }
  else { accN = ctr.rgb; wN = 1.0; cover += 1.0 / max(cc * cc, 1.0); }
  float R = uCocMax;
  float rot = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  for (int i = 0; i < 48; i++) {
    if (i >= uTaps) break;
    float fi = float(i);
    float r = sqrt((fi + 0.5) / float(uTaps)) * R;
    float a = fi * 2.39996323 + rot;
    vec2 off = vec2(cos(a), sin(a)) * r;
    vec4 s = textureLod(tPrep, vUv + off * uTexel, 0.0);
    float ct = s.a;
    if (ct < 0.0) {
      float w = clamp(-ct - r + 1.0, 0.0, 1.0);
      accN += s.rgb * w;
      wN += w;
      cover += w / max(ct * ct, 1.0);
    } else {
      float w = clamp(min(ct, max(cc, 0.0)) - r + 1.0, 0.0, 1.0);
      accF += s.rgb * w;
      wF += w;
    }
  }
  float nearA = clamp(cover * R * R / float(uTaps + 1), 0.0, 1.0);
  if (cc < 0.0) nearA = max(nearA, smoothstep(0.5, 1.5, -cc));
  vec3 farC = wF > 0.0 ? accF / wF : ctr.rgb;
  vec3 nearC = wN > 0.0 ? accN / wN : farC;
  gl_FragColor = vec4(mix(farC, nearC, nearA), nearA);
}`;

// ---------------------------------------------------------------------------------------------
// 8) Camera composite (scene HDR -> display-encoded LDR at sensor resolution):
//    image shake + EIS warp, focus breathing, rolling shutter, ultra-wide lens remap (generalised
//    stereographic family + mustache residual), lateral CA in output space, astigmatism + corner
//    softness, per-pixel motion blur (depth reprojection, gain-dependent shutter), DOF mix,
//    defocus for menu/death, AO, natural + mechanical vignette, exposure, energy-conserving
//    bloom + sensor blooming + halation, veiling glare, flare, lens dirt, purple fringing,
//    sensor noise (shot/read/FPN/hot pixels, grain grows with gain), noise-reduction smearing,
//    raw clip before white balance, AWB, video curve with hard clip, highlight desaturation,
//    grade (cool-green flat profile with skin protection), damage/death/menu looks,
//    temporal noise reduction ghosting, face-mask alpha.
export const compositeFrag = stateGLSL + hashGLSL + /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tBloomWide;
uniform sampler2D tBloomTight;
uniform sampler2D tFlare;
uniform sampler2D tDof;
uniform sampler2D tAO;
uniform sampler2D tDirt;
uniform sampler2D tPrev;
uniform vec2 uRes;
uniform float uAspect;
uniform mat4 uReproj;
uniform float uInvDt;
uniform int uMBSamples;
uniform float uMBMax;
uniform float uMBAmt;
uniform vec2 uShutter;
uniform vec3 uShake;
uniform float uZoom;
uniform vec2 uRSVel;
uniform float uWobble;
uniform float uTime;
uniform float uFrame;
uniform vec4 uLens;        // t (1 = rectilinear, 0.5 = stereographic), C, 2tan(vfov/2), mustache
uniform float uHalfDiag;
uniform float uCA;
uniform float uFringe;
uniform float uEdgeSoft;
uniform float uAstig;
uniform float uVignette;
uniform float uMechVig;
uniform float uAOAmt;
uniform float uBloomAmt;
uniform float uBloomNorm;
uniform float uBloomWideNorm;
uniform float uBlooming;
uniform float uBloomClip;
uniform vec3 uBloomTint;
uniform float uHalation;
uniform vec3 uHalationTint;
uniform float uVeil;
uniform float uFlareAmt;
uniform float uDirtAmt;
uniform float uDof;
uniform float uCocK;
uniform float uBreath;
uniform sampler2D tVM;      // first-person viewmodel mask (r > 0.5)
uniform vec3 uNoiseP;      // shot, read, overall
uniform vec4 uNoiseQ;      // chroma, fpn, hot pixel density, hot pixel strength
uniform vec2 uGrain;       // grain size at gain 1, at gain 16
uniform float uNR;
uniform float uTNR;
uniform vec3 uWBBias;      // log-ratio bias of the camera's AWB (r/g, b/g) + strength in z
uniform float uRawClip;
uniform float uKnee;
uniform float uClip;
uniform float uToe;
uniform float uHLDesat;
uniform float uSat;
uniform float uSkinSat;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uBlack;
uniform float uWhite;
uniform float uDamage;
uniform float uDeadDesat;
uniform float uBlur;
uniform float uBlurLod;
uniform float uMenu;
uniform vec4 uHeads[8];    // src uv, view depth, radius (src uv y)
uniform int uHeadCount;
varying vec2 vUv;
` + depthGLSL + /* glsl */ `

// output (centred, aspect units) -> source rectilinear (centred, aspect units)
vec2 bcLens(vec2 p) {
  float ro = length(p);
  float t = uLens.x;
  if (ro < 1e-5) return p / (uLens.y * uLens.z);
  float u = ro / uHalfDiag;
  float u2 = u * u;
  float rom = ro * (1.0 + uLens.w * (u2 - u2 * u2));
  float th = atan(t * rom / uLens.y) / t;
  float rs = tan(min(th, 1.5)) / uLens.z;
  return p * (rs / ro);
}

vec3 bcCurve(vec3 x) {
  x = max(x, vec3(0.0));
  x = x * x / (x + uToe);                                  // toe: crush the deepest shadows
  vec3 k = vec3(uKnee);
  vec3 sh = k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k)));
  vec3 y = mix(x, sh, step(k, x));
  return clamp(y * uClip, 0.0, 1.0);
}

vec3 bcOETF(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec3 bcTapRGB(vec2 uv, vec2 dR, vec2 dB, float lod) {
  return vec3(textureLod(tScene, uv + dR, lod).r, textureLod(tScene, uv, lod).g, textureLod(tScene, uv + dB, lod).b);
}

void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 p = (vUv - 0.5) * asp;

  // image-space shake / EIS residual (rotation + offset); zoom keeps the border hidden
  float cs = cos(uShake.z);
  float sn = sin(uShake.z);
  p = mat2(cs, sn, -sn, cs) * p + uShake.xy;
  vec4 AF = bcState(2);
  float breath = 1.0 + uBreath * AF.r;                      // focus breathing: closer focus = tighter
  p *= uZoom / breath;

  // rolling shutter: rows are read top -> bottom, later rows see the image moved further
  float rowT = 0.5 - vUv.y;
  p -= uRSVel * asp * rowT;
  p.x += uWobble * (sin(vUv.y * 37.0 + uTime * 41.0) + 0.5 * sin(vUv.y * 11.0 - uTime * 23.0));

  // lens remap
  float u = length(p) / uHalfDiag;
  vec2 src = clamp(0.5 + bcLens(p) / asp, vec2(0.0), vec2(1.0));
  // lateral CA, wavelength-correct: red imaged larger, blue smaller (grows ~ r^2 at the sensor)
  float caS = uCA * u;
  vec2 dR = vec2(0.0), dB = vec2(0.0);
  if (uCA > 0.0) {
    dR = clamp(0.5 + bcLens(p * (1.0 + caS)) / asp, vec2(0.0), vec2(1.0)) - src;
    dB = clamp(0.5 + bcLens(p * (1.0 - caS * 0.8)) / asp, vec2(0.0), vec2(1.0)) - src;
  }
  float u4 = u * u * u * u;
  float lod = uEdgeSoft * u4;

  float expo = bcExposure();
  float gain = bcGain();
  float zc = bcLinDepth(src);
  bool vm = textureLod(tVM, src, 0.0).r > 0.5;

  // per-pixel motion blur from full camera reprojection (rotation + translation via depth)
  vec2 vel = vec2(0.0);
  if (uMBAmt > 0.0 && !vm) {
    float dz = textureLod(tDepth, src, 0.0).r;
    vec4 pp = uReproj * vec4(src * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
    if (pp.w > 1e-4) {
      vec2 prevUv = (pp.xy / pp.w) * 0.5 + 0.5;
      float shutter = clamp(uShutter.x * sqrt(gain), uShutter.x, uShutter.y);
      vel = (src - prevUv) * uInvDt * shutter * uMBAmt;
    }
    float vlen = length(vel);
    if (vlen > uMBMax) vel *= uMBMax / vlen;
  }
  float pxLen = length(vel * uRes);
  int n = int(clamp(pxLen * 0.6, 1.0, float(uMBSamples)));

  // DOF CoC of this full-res pixel (in half-res px)
  float cocF = uCocK * (AF.r - 1.0 / max(zc, 0.02));

  vec3 col;
  if (n <= 1) {
    if (uAstig > 0.0 && u > 0.35) {
      // astigmatism: tangential smear growing toward the corners
      vec2 tdir = vec2(-p.y, p.x) / max(length(p), 1e-4);
      float a = uAstig * u4 * u;
      vec2 s1 = clamp(0.5 + bcLens(p + tdir * a) / asp, vec2(0.0), vec2(1.0));
      vec2 s2 = clamp(0.5 + bcLens(p - tdir * a) / asp, vec2(0.0), vec2(1.0));
      col = 0.5 * (bcTapRGB(s1, dR, dB, lod) + bcTapRGB(s2, dR, dB, lod));
    } else {
      col = bcTapRGB(src, dR, dB, lod);
    }
    if (uDof > 0.0) {
      vec4 d = textureLod(tDof, src, 0.0);
      float a = max(smoothstep(0.6, 1.8, abs(cocF)), d.a);
      col = mix(col, d.rgb, a * uDof);
    }
  } else {
    float jit = bcHash(vec3(gl_FragCoord.xy, uFrame + 401.0)) - 0.5;
    // pre-filter each tap with the mip that matches the tap spacing -> smooth smear, no stepping
    float lodMB = max(lod, log2(max(pxLen / float(n), 1.0)) - 0.3);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 32; i++) {
      if (i >= n) break;
      float t = (float(i) + 0.5 + jit) / float(n) - 0.5;
      vec2 uvi = src + vel * t;
      float w = 1.0 - step(0.5, textureLod(tVM, uvi, 0.0).r);
      vec3 c = bcTapRGB(uvi, dR, dB, lodMB);
      if (uDof > 0.0) {
        vec4 d = textureLod(tDof, uvi, 0.0);
        c = mix(c, d.rgb, max(smoothstep(0.6, 1.8, abs(cocF)), d.a) * uDof);
      }
      acc += c * w;
      wsum += w;
    }
    col = wsum > 0.0 ? acc / wsum : bcTapRGB(src, dR, dB, lod);
  }

  // in-camera spatial noise reduction smears fine texture in the dark (before noise is added
  // the clean render stands in for the denoised signal)
  float nrAmt = uNR * smoothstep(1.8, 7.0, gain);
  if (nrAmt > 0.001 && n <= 1) {
    vec3 sm = textureLod(tScene, src, 1.4).rgb;
    float lumE = dot(col, BC_LUMA) * expo;
    col = mix(col, sm, nrAmt * (1.0 - smoothstep(0.15, 0.6, lumE)));
  }

  // defocus (menu standby / death)
  // (the bloom pyramid is a smooth multi-scale blur of the exposed frame: free to reuse)
  if (uBlur > 0.001) {
    vec3 b1 = texture(tBloom, src).rgb * uBloomNorm;
    vec3 b2 = texture(tBloomWide, src).rgb * uBloomWideNorm;
    vec3 bb = mix(b1, b2, clamp(uBlurLod - 3.5, 0.0, 1.0)) / max(expo, 1e-4);
    col = mix(col, bb, clamp(uBlur, 0.0, 1.0));
  }

  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  col = min(col, vec3(6e4));

  // ambient occlusion with a simple multi-bounce fit; the viewmodel is left alone
  if (uAOAmt > 0.0 && !vm) {
    float ao = texture(tAO, src).r;
    float alb = 0.45;
    float a = 2.0404 * alb - 0.3324;
    float b = -4.7951 * alb + 0.6417;
    float c = 2.7552 * alb + 0.6903;
    float aoM = max(ao, ((ao * a + b) * ao + c) * ao);
    col *= mix(1.0, aoM, uAOAmt);
  }

  // natural vignetting (cos^4 law, partly compensated) + mechanical corner cut of the housing
  float vig = 1.0 - 0.5 * u * u;
  vig = vig * vig;
  col *= mix(1.0, vig, uVignette);
  if (uMechVig > 0.0) {
    vec2 q = abs(vUv - 0.5) * 2.0;
    float corner = length(max(q - vec2(0.62, 0.48), 0.0) / vec2(0.38, 0.52));
    col *= 1.0 - uMechVig * smoothstep(0.55, 1.05, corner);
  }

  // exposure
  col *= expo;
  float lumLocal = dot(col, BC_LUMA);

  // energy-conserving scatter (all levels averaged) + sensor blooming around clipped areas
  vec3 bl = texture(tBloom, src).rgb * uBloomNorm;
  vec3 blW = texture(tBloomWide, src).rgb * uBloomWideNorm;
  col = mix(col, bl, uBloomAmt * (1.0 + uFlash * 2.0));
  float blL = dot(bl, BC_LUMA);
  col += bl * uBloomTint * uBlooming * max(blL - uBloomClip, 0.0) / max(blL, 1e-3);
  float blWL = dot(blW, BC_LUMA);
  col += blW * uHalationTint * uHalation * max(blWL - uBloomClip * 0.6, 0.0) / max(blWL, 1e-3);
  col += blW * uFlash * 0.6;

  // veiling glare: bright light anywhere in view scatters over the whole frame
  float veil = bcState(3).r * expo;
  col += vec3(0.97, 1.0, 1.02) * uVeil * max(veil - 0.12, 0.0);

  // lens flare ghosts / streak
  if (uFlareAmt > 0.0) col += texture(tFlare, src).rgb * uFlareAmt;

  // smudges on the cover glass light up against bright light
  float dirt = texture(tDirt, vUv).r;
  col += (blW * 0.85 + bl * 0.35 + vec3(max(veil - 0.2, 0.0) * 0.25)) * dirt * uDirtAmt;

  // purple fringing on the dark side of blown highlights (axial + lateral CA of a cheap lens)
  if (uFringe > 0.0) {
    vec3 tb = texture(tBloomTight, src).rgb;
    float hl = smoothstep(1.0, 3.0, dot(tb, BC_LUMA));
    float darkSide = 1.0 - smoothstep(0.35, 1.0, lumLocal);
    col += vec3(0.42, 0.10, 0.75) * hl * darkSide * uFringe * (0.5 + u);
  }

  // ---------------- sensor
  vec2 px = floor(vUv * uRes);
  float noiseOn = uNoiseP.z;
  if (noiseOn > 0.0) {
    float sLin = max(dot(col, BC_LUMA), 0.0);
    float sigma = sqrt(sLin * gain * uNoiseP.x * uNoiseP.x + (uNoiseP.y * gain) * (uNoiseP.y * gain)) * noiseOn;
    sigma *= 1.0 - 0.45 * nrAmt;
    float g = mix(uGrain.x, uGrain.y, smoothstep(1.5, 9.0, gain));
    float fr = uFrame;
    float w1 = bcHash(vec3(px, fr)) + bcHash(vec3(px + 911.0, fr + 17.0)) - 1.0;
    float grainN = (bcVNoise(gl_FragCoord.xy / g, fr + 31.0) - 0.5) * 2.6;
    float ln = mix(w1 * 2.0, grainN, smoothstep(1.0, 2.0, g));
    float cg = g * 2.0;
    float c1 = (bcVNoise(gl_FragCoord.xy / cg, fr + 101.0) - 0.5) * 2.6;
    float c2 = (bcVNoise(gl_FragCoord.xy / cg + 37.0, fr + 211.0) - 0.5) * 2.6;
    vec3 nz = vec3(ln) + vec3(c2, -0.5 * c1 - 0.4 * c2, c1) * uNoiseQ.x * (0.6 + 0.4 * smoothstep(2.0, 8.0, gain));
    // fixed pattern: column offsets (static on the sensor) grow with gain
    float fpn = (bcHash(vec3(px.x, 7.0, 1.0)) - 0.5) + 0.35 * (bcHash(vec3(px.y, 9.0, 2.0)) - 0.5);
    nz += vec3(fpn * uNoiseQ.y * 3.0);
    col += nz * sigma;
    // hot pixels: rare, coloured, only show at high gain
    float hp = bcHash(vec3(px, 77.0));
    if (hp < uNoiseQ.z) {
      float k = bcHash(vec3(px, 78.0));
      vec3 hc = k < 0.33 ? vec3(1.0, 0.25, 0.2) : k < 0.66 ? vec3(0.3, 1.0, 0.35) : vec3(0.35, 0.45, 1.0);
      col += hc * uNoiseQ.w * gain * gain * 0.0004 * (0.5 + bcHash(vec3(px, 79.0)));
    }
  }

  // ---------------- ISP: raw clip, white balance, curve
  vec4 WB = bcState(1);
  vec2 wbLog = clamp(-WB.rg * uWBBias.z + uWBBias.xy, vec2(-0.6), vec2(0.6));
  vec3 wbGain = exp(vec3(wbLog.x, 0.0, wbLog.y));
  wbGain /= dot(wbGain, BC_LUMA);
  col = min(max(col, vec3(0.0)), vec3(uRawClip)) * wbGain;      // sensor full-well clip happens before WB
  col = bcCurve(col);
  float mx = max(col.r, max(col.g, col.b));
  col = mix(col, vec3(mx), smoothstep(0.78, 1.0, mx) * uHLDesat);

  // grade: flat, slightly desaturated, cool-green; skin / brick / rust hues are protected
  float l = dot(col, BC_LUMA);
  vec2 cbcr = vec2(col.b - l, col.r - l);
  float skin = pow(max(dot(normalize(cbcr + 1e-5), normalize(vec2(-0.55, 0.85))), 0.0), 3.0);
  float sat = mix(uSat, uSkinSat, skin);
  col = max(vec3(l) + (col - vec3(l)) * sat, vec3(0.0));
  col *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.45, l));

  // hit pulse: red bleeding in from the edges, desaturated, slight exposure dip
  if (uDamage > 0.001) {
    float dmgMask = smoothstep(0.25, 1.1, u);
    vec3 dcol = vec3(l * 0.85 + 0.10, l * 0.18, l * 0.16);
    col = mix(col, dcol, clamp(uDamage * (0.12 + 0.88 * dmgMask), 0.0, 1.0));
    col *= 1.0 - 0.25 * uDamage * dmgMask;
  }

  // death / menu looks
  float l2 = dot(col, BC_LUMA);
  col = mix(col, vec3(l2), clamp(uDeadDesat, 0.0, 1.0));
  col = mix(col, vec3(l2) * vec3(0.95, 1.0, 1.03), uMenu * 0.45) * (1.0 - 0.3 * uMenu);

  col = bcOETF(clamp(col, 0.0, 1.0));
  col = uBlack + col * (uWhite - uBlack);

  // temporal noise reduction: low-contrast changes are averaged with the previous frame, which
  // leaves ghost trails on movement in low light
  if (uTNR > 0.0) {
    vec3 pv = textureLod(tPrev, vUv, 0.0).rgb;
    float diff = abs(dot(col - pv, vec3(0.299, 0.587, 0.114)));
    float k = uTNR * smoothstep(1.6, 6.0, gain) * (1.0 - smoothstep(0.03, 0.12, diff));
    col = mix(col, pv, k);
  }

  // face anonymisation mask (in alpha): head ellipse that is not hidden behind nearer geometry
  float mask = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uHeadCount) break;
    vec4 h = uHeads[i];
    vec2 d = (src - h.xy) * vec2(uAspect, 1.0) / (h.w * vec2(1.0, 1.3));
    if (dot(d, d) < 1.0 && zc > h.z - 0.45) mask = 1.0;
  }
  gl_FragColor = vec4(col, mask);
}`;

// ---------------------------------------------------------------------------------------------
// 9) Encoder / output pass (display res, renders to screen):
//    signal-loss corruption, tear line, FXAA, in-camera sharpening with halos, face pixelation,
//    burned-in OSD, H.264-style coding (4:2:0 + chroma bleed, 8x8 transform quantisation with
//    dead zone, deblocking vs. visible block edges, mosquito noise, DC banding), P-frame smear,
//    fade to dark.
export const finalFrag = hashGLSL + /* glsl */ `
uniform sampler2D tLDR;
uniform sampler2D tPrev;
uniform sampler2D tOSD;
uniform vec4 uOSDRect;
uniform float uOSDAlpha;
uniform vec2 uRes;
uniform float uFrame;
uniform float uTime;
uniform float uSharpen;
uniform float uSharpenWide;
uniform float uFXAA;
uniform float uCompress;
uniform float uMosquito;
uniform float uChromaBleed;
uniform float uBanding;
uniform float uSmear;
uniform float uGlitch;
uniform float uTear;
uniform float uFade;
uniform vec4 uFaces[8];      // output uv centre, radius (uv y), block size (uv y)
uniform int uFaceCount;
uniform vec3 uView;
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
float bcDeadzone(float x, float q) {
  float a = abs(x) / q;
  return sign(x) * max(floor(a + 0.5 - 0.22), 0.0) * q;
}

void main() {
  vec2 fUv = uView.xy + (vUv - 0.5) / uView.z;   // debug magnifier (1 = off)
  vec2 uv = fUv;
  float tq = floor(uTime * 14.0);
  vec2 rcp = 1.0 / uRes;

  // signal loss: displaced horizontal bands and vertical hops
  if (uGlitch > 0.001) {
    float band = floor(fUv.y * 30.0);
    if (bcHash(vec3(band, tq, 3.0)) < uGlitch * 0.5) {
      uv.x += (bcHash(vec3(band, tq, 7.0)) - 0.5) * 0.2 * uGlitch;
    }
    float big = floor(fUv.y * 6.0);
    if (bcHash(vec3(big, tq, 11.0)) < uGlitch * 0.22) {
      uv.y += (bcHash(vec3(big, tq, 13.0)) - 0.5) * 0.05;
    }
  }
  if (uTear > 0.001) {
    float ty = fract(uTime * 0.7 + bcHash(vec3(floor(uTime * 3.0), 1.0, 2.0)));
    float m = 1.0 - smoothstep(0.0, 0.03, abs(fUv.y - ty));
    uv.x += m * uTear * 0.012;
  }
  uv = clamp(uv, vec2(0.0), vec2(1.0));

  vec3 cNW = bcTap(uv + vec2(-1.0, -1.0) * rcp);
  vec3 cNE = bcTap(uv + vec2( 1.0, -1.0) * rcp);
  vec3 cSW = bcTap(uv + vec2(-1.0,  1.0) * rcp);
  vec3 cSE = bcTap(uv + vec2( 1.0,  1.0) * rcp);
  vec3 cM  = bcTap(uv);
  vec3 c = cM;

  if (uFXAA > 0.5) {
    float lNW = bcL(cNW);
    float lNE = bcL(cNE);
    float lSW = bcL(cSW);
    float lSE = bcL(cSE);
    float lM = bcL(cM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin > max(0.04, lMax * 0.12)) {
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 * (1.0 / 8.0)), 1.0 / 128.0);
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * rcp;
      vec3 rgbA = 0.5 * (bcTap(uv + dir * (1.0 / 3.0 - 0.5)) + bcTap(uv + dir * (2.0 / 3.0 - 0.5)));
      vec3 rgbB = rgbA * 0.5 + 0.25 * (bcTap(uv - dir * 0.5) + bcTap(uv + dir * 0.5));
      float lB = bcL(rgbB);
      c = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }
  }

  // in-camera sharpening: small + wide unsharp mask on luma -> bright/dark halos on edges,
  // bright overshoot clipped harder than dark (as camera detail circuits do)
  float yC = bcL(c);
  float yN = bcL((cNW + cNE + cSW + cSE) * 0.25);
  float yW = bcL(textureLod(tLDR, uv, 1.6).rgb);
  float det = (yC - yN) * uSharpen + (yC - yW) * uSharpenWide;
  det = clamp(det, -0.22, 0.14);
  c += det;

  // face anonymisation: coarse head-anchored blocks where the composite marked a visible head
  for (int i = 0; i < 8; i++) {
    if (i >= uFaceCount) break;
    vec4 f = uFaces[i];
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 d = (fUv - f.xy) * asp;
    if (dot(d, d) < f.z * f.z * 2.6) {
      vec2 bs = vec2(f.w / asp.x, f.w);
      vec2 bc = f.xy + (floor((fUv - f.xy) / bs) + 0.5) * bs;
      if (textureLod(tLDR, bc, 0.0).a > 0.5) {
        float lodB = log2(max(f.w * uRes.y, 1.0)) - 0.7;
        vec3 avg = textureLod(tLDR, bc, lodB).rgb;
        avg = mix(avg, textureLod(tLDR, bc + bs * vec2(0.25, 0.0), lodB).rgb, 0.5);
        c = avg;
      }
    }
  }

  // burned-in OSD: composited by the camera before the encoder, outside the lens
  vec2 ouv = (fUv - uOSDRect.xy) / uOSDRect.zw;
  float osdA = 0.0;
  vec3 osdC = vec3(0.0);
  if (uOSDAlpha > 0.0 && all(greaterThanEqual(ouv, vec2(0.0))) && all(lessThanEqual(ouv, vec2(1.0)))) {
    vec4 o = texture(tOSD, ouv);
    osdA = o.a * uOSDAlpha;
    osdC = o.rgb;
    c = mix(c, osdC, osdA);
  }

  // ---------------- encoder
  vec2 bpx = uv * uRes;
  ivec2 blk = ivec2(bpx / 8.0);
  ivec2 m3 = textureSize(tLDR, 3) - 1;
  vec3 dcBlock = texelFetch(tLDR, clamp(blk, ivec2(0), m3), 3).rgb;
  vec3 dcSmooth = textureLod(tLDR, uv, 3.0).rgb;
  // block edge energy: range of the 4 quarter-block means (mip 2)
  ivec2 b2 = clamp(blk * 2, ivec2(0), textureSize(tLDR, 2) - 2);
  float q0 = bcL(texelFetch(tLDR, b2, 2).rgb);
  float q1 = bcL(texelFetch(tLDR, b2 + ivec2(1, 0), 2).rgb);
  float q2 = bcL(texelFetch(tLDR, b2 + ivec2(0, 1), 2).rgb);
  float q3 = bcL(texelFetch(tLDR, b2 + ivec2(1, 1), 2).rgb);
  float range = max(max(q0, q1), max(q2, q3)) - min(min(q0, q1), min(q2, q3));
  float cplx = smoothstep(0.02, 0.22, range);
  float qv = clamp(uCompress * (0.55 + 0.9 * cplx), 0.0, 1.0);

  vec3 ycc = bcYCC(c);
  // 4:2:0 chroma, plus extra bleeding of saturated edges at low bitrate
  ivec2 m1 = textureSize(tLDR, 1) - 1;
  vec3 c1 = texelFetch(tLDR, clamp(ivec2(bpx / 2.0), ivec2(0), m1), 1).rgb;
  vec3 c2 = textureLod(tLDR, uv + vec2(rcp.x * 1.5, 0.0), 2.0).rgb;
  vec2 ch = mix(bcYCC(c1).yz, bcYCC(c2).yz, clamp(uChromaBleed * (0.3 + qv), 0.0, 1.0));
  ch = mix(ch, bcYCC(dcBlock).yz, qv * 0.55);
  ycc.yz = mix(ch, ycc.yz, osdA * 0.6);

  // luma: DC (deblocked at low q, blocky at high q) + dead-zone quantised AC
  vec3 dc = mix(dcSmooth, dcBlock, smoothstep(0.25, 0.75, qv));
  float yDC = bcL(dc);
  float stepDC = uBanding * mix(1.0, 3.5, qv) / 255.0;
  yDC = floor(yDC / stepDC + 0.5) * stepDC;
  float qs = mix(0.010, 0.13, qv);
  float ac = bcDeadzone(ycc.x - bcL(dc), qs);
  // high-frequency loss inside the block
  float lowY = bcL(textureLod(tLDR, uv, 1.0).rgb) - bcL(dc);
  ac = mix(ac, bcDeadzone(lowY, qs), smoothstep(0.3, 0.9, qv) * 0.6 * (1.0 - osdA));
  float yq = yDC + ac;
  ycc.x = mix(ycc.x, yq, smoothstep(0.0, 0.2, qv));
  // mosquito noise around edges, changes every other frame
  if (uMosquito > 0.0) {
    float mq = bcHash(vec3(floor(bpx / 2.0), floor(uFrame * 0.5))) - 0.5;
    float mq2 = sin(dot(fract(bpx / 8.0), vec2(9.4, 6.1)) + uFrame * 1.3);
    ycc.x += (mq * 0.7 + mq2 * 0.3) * smoothstep(0.08, 0.35, range) * qv * uMosquito * 0.09;
  }
  c = bcRGB(ycc);

  // P-frame smear: macroblocks keep the previous frame with a wrong motion vector
  // (clustered: the encoder skips runs of macroblocks inside a starved slice, which then show
  //  the previous frame's content for a frame or two)
  if (uSmear > 0.001) {
    vec2 mb = floor(bpx / 16.0);
    float fq = floor(uFrame * 0.5);
    vec2 region = floor(bpx / vec2(96.0, 48.0));
    float hr = bcHash(vec3(region, fq + 5.0));
    if (hr < uSmear) {
      vec2 mv = (vec2(bcHash(vec3(region, 41.0)), bcHash(vec3(region, 43.0))) - 0.5) * 8.0 * rcp;
      c = mix(c, texture(tPrev, uv + mv).rgb, 0.92);
    }
  }

  // signal loss: corrupt macroblocks (decoder green/magenta), garbage rows, rolling dark bar
  if (uGlitch > 0.001) {
    // a lost slice: from a random macroblock to the end of the row the decoder shows stale,
    // displaced content with broken chroma (the classic green / pink smear)
    vec2 mb = floor(bpx / 16.0);
    float mbRow = mb.y;
    float cols = ceil(uRes.x / 16.0);
    float hs = bcHash(vec3(mbRow, tq, 300.0));
    float start = floor(bcHash(vec3(mbRow, tq, 301.0)) * cols);
    if (hs < uGlitch * 0.22 && mb.x >= start) {
      float dx = (bcHash(vec3(mbRow, tq, 302.0)) - 0.5) * 0.15;
      vec3 y = bcYCC(texture(tPrev, vec2(uv.x + dx, (mbRow + 0.5) * 16.0 / uRes.y)).rgb);
      vec2 tint = bcHash(vec3(mbRow, tq, 303.0)) < 0.6 ? vec2(-0.09, -0.11) : vec2(0.07, 0.09);
      y.yz = mix(y.yz, tint, 0.75);
      c = mix(c, bcRGB(y), 0.85);
    }
    float row = floor(fUv.y * 40.0);
    float h = bcHash(vec3(row, tq, 21.0));
    if (h < uGlitch * 0.05) {
      float g = bcHash(vec3(floor(fUv.x * uRes.x / 8.0), row, tq));
      c = mix(c, vec3(0.2 + 0.5 * g) * vec3(0.8, 1.0, 0.85), 0.85);
    } else if (h < uGlitch * 0.15) {
      c = mix(c, texture(tPrev, vec2(uv.x, floor(uv.y * 40.0) / 40.0)).rgb, 0.8);   // row repeat
    }
    c *= 1.0 - 0.45 * uGlitch * step(0.93, fract(fUv.y + uTime * 0.6));
  }

  c *= 1.0 - uFade;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
