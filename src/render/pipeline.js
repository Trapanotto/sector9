import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import * as SH from './shaders.js';
import { createOSD } from './osd.js';
import { createAutoQuality } from './quality.js';
import { applySurfaceQuality } from '../world/materials.js';

// =============================================================================================
// Tunables. Everything that shapes the "chest-mounted action camera" look lives here.
// Live object: edits take effect on the next frame. A strength of 0 disables an effect and,
// where it has its own pass or taps, skips that cost.
// =============================================================================================
export const TUNING = {
  // ---- lens (ultra-wide action-camera optics)
  fisheye: 0.80,             // 0 = rectilinear render, 1 = stereographic, >1 toward equidistant
  mustache: 0.05,            // residual wave of the distortion profile (+ = slight pincushion mid-field)
  overscan: 0.985,           // constant zoom-in so shake / RS / EIS never show the border
  chromaticAberration: 0.0035, // lateral CA: relative R/B image-size difference at the corners
  purpleFringe: 0.55,        // purple fringing on the dark side of blown highlights
  edgeSoftness: 1.3,         // mip LOD added at the very corners (lens softness)
  astigmatism: 0.0035,       // tangential smear at the corners (aspect units), high preset only
  vignette: 0.55,            // natural cos^4 falloff (partly compensated like a real ISP)
  mechVignette: 0.0,         // hard dark corners from the housing (0 = none)

  // ---- exposure (auto-exposure behaviour)
  exposureKey: 0.12,         // middle grey target
  adaptAmount: 0.85,         // 1 = fully normalise every scene, <1 keeps dark rooms darker
  refLum: 0.30,              // scene luminance treated as "daylight reference" (gain 1)
  exposureMin: 0.08,
  exposureMax: 12.0,
  adaptTauUp: 0.30,          // s, AE time constant when the scene gets brighter (fast clamp-down)
  adaptTauDown: 0.85,        // s, when the scene gets darker (slow open-up)
  aeDamping: 0.55,           // <1 = AE overshoots and settles (visible hunting)
  aeDeadband: 0.06,          // log units the AE tolerates before reacting (settles slightly off)
  meterCenter: 1.0,          // centre weighting of the meter
  meterCap: 0.9,             // scene luminance where a meter cell saturates (sky/windows burn out)
  meterMip: 64,

  // ---- sensor response / ISP
  rawClip: 1.9,              // sensor full-well clip in exposed units (before white balance)
  knee: 0.62,                // start of the highlight shoulder (linear display)
  highlightClip: 1.08,       // post-curve gain + hard clip (>1 = harder clipping)
  toe: 0.0035,               // shadow crush
  highlightDesat: 0.75,      // clipped colours run toward white
  awbStrength: 0.42,         // 0 = fixed WB, 1 = full grey-world correction (never fully neutral)
  awbTau: 3.5,               // s
  wbBias: [-0.035, 0.03],    // camera's own cast (log R/G, log B/G): slightly cool-green

  // ---- bloom / glare / flare / dirt
  bloomStrength: 0.045,      // energy-conserving scatter (fraction of light spread over all scales)
  bloomThreshold: 0.0,       // soft-knee threshold in exposed units (0 = none, physically based)
  bloomKnee: 0.5,
  blooming: 0.9,            // sensor blooming that eats into frames around clipped areas
  bloomClip: 1.0,            // exposed level where blooming starts
  bloomTint: [1.0, 0.97, 0.93],
  halation: 0.10,            // wide warm halo around very bright areas
  halationTint: [1.0, 0.82, 0.68],
  veilingGlare: 0.030,       // whole-frame contrast loss from bright light in view
  flare: 1.0,                // master for ghosts + streak (0 skips the pass)
  flareThreshold: 3.4,           // (audit: ghosts were smearing purple/cyan blobs over every hall view)
  flareGhosts: 0.018,
  flareHalo: 0.015,
  flareStreak: 0.035,
  flareStreakAngle: 0.18,    // radians, the cover-glass wipe direction
  dirtStrength: 0.45,

  // ---- focus
  dof: 1.0,                  // 0 disables depth of field (skips both half-res passes)
  dofCoc: 0.8,              // CoC in px (at 1080p) per dioptre of defocus
  dofMaxCoc: 5,             // px at 1080p
  afDelay: 0.14,             // s before AF reacts
  afSpeed: 7.5,              // AF spring omega
  afDamping: 0.42,           // < 1 overshoots
  afDeadband: 0.12,          // dioptres
  afHuntChance: 0.35,        // chance that a refocus starts in the wrong direction
  afHuntKick: 1.4,
  afMinDist: 0.35,           // closest focus (m)
  afAimNear: 1.0,            // when aiming, AF prefers the nearest subject (front sight)
  focusBreathing: 0.006,     // image scale per dioptre of focus

  // ---- first-person viewmodel (arms + pistol, masked by the viewmodel pass)
  vmFov: 72,                 // vertical FOV the arms + pistol are drawn with (0 = scene FOV)
  vmCocHip: 0.6,            // max defocus of the viewmodel at the hip (half-res px): slightly soft, never a ghost
  vmCocAds: 0.3,             // ... when aiming (front sight / gun sharp)
  vmTnr: 0.12,               // temporal-NR strength on the viewmodel relative to the scene (no smeared hands)

  // ---- ambient occlusion (GTAO at half res, depth-reconstructed normals)
  aoStrength: 1.25,

  // ---- motion
  motionBlur: 1.0,
  shutterMin: 1 / 100,       // s at reference light (bright yard stays crisp)
  shutterMax: 1 / 30,        // longest shutter in the dark
  motionBlurMax: 0.07,       // max blur length in uv units
  rsReadout: 0.024,          // sensor readout time, s (skew while panning)
  wobble: 0.0035,            // jello amplitude at full trauma
  shakeOffset: 0.020,
  shakeRotation: 0.022,
  shakeFreq: 19,
  traumaDecay: 1.15,
  eis: 1.0,                  // residual electronic-stabilisation jitter

  // ---- noise / NR
  noise: 1.0,                // master
  noiseShot: 0.013,          // photon noise
  noiseRead: 0.0010,         // read noise (grows linearly with gain)
  chromaNoise: 0.60,
  fixedPattern: 0.25,
  hotPixels: 0.00012,        // density
  hotPixelStrength: 1.0,
  grainSize: [1.0, 2.2],     // grain size in px at gain 1 / gain 16 (NR makes it blotchy)
  noiseReduction: 0.55,      // spatial NR smearing in the dark
  tnr: 0.55,                 // temporal NR ghosting in low light

  // ---- grading
  saturation: 0.80,
  skinSaturation: 0.93,
  shadowTint: [0.94, 1.02, 1.0],
  highTint: [1.01, 1.0, 0.975],
  blackLift: 0.026,
  whitePoint: 0.975,

  // ---- encoder
  sharpen: 0.55,             // in-camera detail (small radius)
  sharpenWide: 0.22,         // wide halo
  compressBase: 0.10,
  compressMotion: 0.07,      // per rad/s of camera rotation
  compressMove: 0.03,        // per m/s of camera translation
  compressTrauma: 0.5,
  gopSeconds: 1.0,
  gopPump: 0.30,             // quality drift over a GOP (keyframe pumping)
  mosquito: 1.0,
  chromaBleed: 0.6,
  banding: 1.0,              // DC quantisation step in 8-bit codes (0 = off)

  // ---- face anonymisation
  faceBlur: true,
  faceBlocks: 6,             // blocks across a head

  // ---- state looks
  flashGain: 2.2,            // exposure multiplier added at flash(1)
  flashDecay: 24,            // per second (exponential): 1-2 frames
  flashPull: 0.45,           // log-exposure kick after a flash (AE pulled down, recovers)
  damageDecay: 2.4,
  menuBlurLod: 4.6,
  deadBlurLod: 4.2,
  deadFadeStart: 1.6,
  deadFadeEnd: 6.5,
  deadFadeMax: 0.94,

  debugView: null,           // dev only: [u, v, scale] magnifies the final output

  // auto quality fallback
  slowFrameMs: 25,
  slowFrameSeconds: 4,
};

export const QUALITY = {
  // integrated / software GPUs: ~60 % resolution, no AO / DOF / flare / temporal NR, 3-level bloom, 1 motion-blur
  // tap, no per-frame shadow maps (static baked sun shadow only), cheap surface shader, 512 px textures
  minimal: {
    scale: 0.6, maxHeight: 600, ao: false, aoScale: 0.5, aoSamples: 8, pdSamples: 8,
    bloomLevels: 3, mbSamples: 1, fxaa: true, dofTaps: 0, ghosts: 0, streakTaps: 0, astig: false,
    flare: false, tnr: false, shadows: 'off', surfCheap: true,
  },
  low: {
    scale: 0.7, maxHeight: 720, ao: false, aoScale: 0.5, aoSamples: 8, pdSamples: 8,
    bloomLevels: 4, mbSamples: 6, fxaa: true, dofTaps: 0, ghosts: 2, streakTaps: 4, astig: false,
    flare: false, tnr: true, shadows: 'small', surfCheap: true,
  },
  medium: {
    scale: 0.85, maxHeight: 900, ao: true, aoScale: 0.5, aoSamples: 8, pdSamples: 8,
    bloomLevels: 5, mbSamples: 8, fxaa: true, dofTaps: 14, ghosts: 3, streakTaps: 6, astig: false,
    flare: true, tnr: true, shadows: 'full', surfCheap: false,
  },
  high: {
    scale: 1.0, maxHeight: 1080, ao: true, aoScale: 0.5, aoSamples: 16, pdSamples: 12,
    bloomLevels: 6, mbSamples: 12, fxaa: true, dofTaps: 28, ghosts: 5, streakTaps: 8, astig: true,
    flare: true, tnr: true, shadows: 'full', surfCheap: false,
  },
};

const GTAO_PARAMS = { radius: 0.45, distanceExponent: 1.6, thickness: 0.6, distanceFallOff: 0.7, scale: 1.0 };
const PD_PARAMS = { lumaPhi: 10, depthPhi: 2.5, normalPhi: 4, radius: 5, radiusExponent: 1.5, rings: 2.6 };

// =============================================================================================

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function makeRT(w, h, { type = THREE.HalfFloatType, mips = false, depthTexture = null, nearest = false, depth = false } = {}) {
  const f = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : f,
    magFilter: f,
    generateMipmaps: mips,
    depthBuffer: !!depthTexture || depth,
    stencilBuffer: false,
    depthTexture,
  });
}

function makeDirtTexture() {
  const W = 512, H = 288;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let tex;
  try {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    // greasy smear (thumb wipe) across a lower corner and a hazy film toward the edges
    const haze = g.createRadialGradient(W * 0.5, H * 0.5, H * 0.2, W * 0.5, H * 0.5, W * 0.62);
    haze.addColorStop(0, 'rgba(255,255,255,0)');
    haze.addColorStop(1, 'rgba(255,255,255,0.10)');
    g.fillStyle = haze; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 70; i++) {                 // soft smudges
      const x = rnd() * W, y = rnd() * H, r = 6 + rnd() * rnd() * 70;
      const a = 0.04 + rnd() * 0.12;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.lineCap = 'round';
    for (let i = 0; i < 14; i++) {                 // wipe streaks
      g.strokeStyle = `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
      g.lineWidth = 4 + rnd() * 14;
      const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI, l = 60 + rnd() * 180;
      g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (rnd() - 0.5) * 40, y + Math.sin(a) * l * 0.5,
        x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    for (let k = 0; k < 2; k++) {                  // fingerprint arcs
      const cx = W * (0.15 + 0.7 * rnd()), cy = H * (0.6 + 0.35 * rnd());
      for (let i = 0; i < 16; i++) {
        g.strokeStyle = `rgba(255,255,255,${0.025 + rnd() * 0.02})`;
        g.lineWidth = 1.2;
        g.beginPath();
        g.ellipse(cx, cy, 6 + i * 2.6, 4 + i * 2.0, 0.4, Math.PI * (0.1 + rnd() * 0.2), Math.PI * (1.6 + rnd() * 0.3));
        g.stroke();
      }
    }
    for (let i = 0; i < 110; i++) {                // specks
      g.fillStyle = `rgba(255,255,255,${0.03 + rnd() * 0.1})`;
      g.beginPath(); g.arc(rnd() * W, rnd() * H, 0.6 + rnd() * 2.2, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 9; i++) {                  // dried droplets: ring-shaped
      const x = rnd() * W, y = rnd() * H, r = 3 + rnd() * 8;
      g.strokeStyle = `rgba(255,255,255,${0.035 + rnd() * 0.04})`;
      g.lineWidth = 1 + rnd();
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    }
    tex = new THREE.CanvasTexture(cv);
  } catch {
    tex = new THREE.DataTexture(new Uint8Array([24, 24, 24, 255]), 1, 1);
    tex.needsUpdate = true;
  }
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function createPipeline(ctx) {
  const { renderer, scene, camera } = ctx;
  const T = TUNING;

  renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the composite pass
  renderer.autoClear = true;

  const quad = new FullScreenQuad(null);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  black.needsUpdate = true;
  const dirtTex = makeDirtTexture();

  // ---------------------------------------------------------------- render targets
  const sceneDepth = new THREE.DepthTexture(4, 4, THREE.FloatType);
  const sceneRT = makeRT(4, 4, { mips: true, depthTexture: sceneDepth });
  const lumRT = makeRT(T.meterMip, T.meterMip, { mips: true });
  const stateRT = [makeRT(4, 1, { nearest: true }), makeRT(4, 1, { nearest: true })];
  const ldrRT = [makeRT(4, 4, { type: THREE.UnsignedByteType, mips: true }),
    makeRT(4, 4, { type: THREE.UnsignedByteType, mips: true })];
  const MAX_BLOOM = 6;
  const bloomDown = [], bloomUp = [];
  for (let i = 0; i < MAX_BLOOM; i++) {
    bloomDown.push(makeRT(4, 4));
    bloomUp.push(makeRT(4, 4));
  }
  const flareRT = makeRT(4, 4);
  const vmRT = makeRT(4, 4, { type: THREE.UnsignedByteType, depth: true });
  const dofPrepRT = makeRT(4, 4);
  const dofRT = makeRT(4, 4);

  // ---------------------------------------------------------------- shared uniforms
  const EXPU = {
    tState: { value: stateRT[0].texture },
    uKey: { value: T.exposureKey },
    uAdaptAmt: { value: T.adaptAmount },
    uRefLum: { value: T.refLum },
    uExpMin: { value: T.exposureMin },
    uExpMax: { value: T.exposureMax },
    uFlash: { value: 0 },
    uFlashGain: { value: T.flashGain },
  };
  const uNear = { value: camera.near };
  const uFar = { value: camera.far };
  const uTime = { value: 0 };
  const uFrame = { value: 0 };
  const DEPTHU = { tDepth: { value: sceneDepth }, uNear, uFar };

  const mk = (frag, uniforms) => new THREE.ShaderMaterial({
    uniforms, vertexShader: SH.vert, fragmentShader: frag,
    depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
  });

  const lumMat = mk(SH.lumFrag, Object.assign({}, DEPTHU, {
    tScene: { value: sceneRT.texture }, uLod: { value: 0 }, tVM: { value: vmRT.texture }, uCenterW: { value: T.meterCenter }, uMeterCap: { value: T.meterCap },
  }));
  const stateU = Object.assign({}, EXPU, DEPTHU, {
    tState: { value: stateRT[1].texture },      // previous state (own uniform, not shared)
    tLum: { value: lumRT.texture }, tScene: { value: sceneRT.texture },
    uLumLod: { value: Math.log2(T.meterMip) }, uSceneLod: { value: 0 },
    uDt: { value: 0.016 }, uTime,
    uTauUp: { value: T.adaptTauUp }, uTauDown: { value: T.adaptTauDown },
    uDamp: { value: T.aeDamping }, uDeadband: { value: T.aeDeadband },
    uKick: { value: 0 }, uReset: { value: 1 }, uAwbTau: { value: T.awbTau },
    uAF: { value: new THREE.Vector4() }, uAFHunt: { value: new THREE.Vector2() },
    uAFMin: { value: T.afMinDist }, uAFFixed: { value: 0 }, uAFNear: { value: 0 },
  });
  const stateMat = mk(SH.stateFrag, stateU);
  const bloomPreMat = mk(SH.bloomPreFrag, Object.assign({}, EXPU, {
    tScene: { value: sceneRT.texture }, uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: T.bloomThreshold }, uKnee: { value: T.bloomKnee },
  }));
  const bloomDownMat = mk(SH.bloomDownFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const bloomUpMat = mk(SH.bloomUpFrag, {
    tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() },
    uAddW: { value: 1 }, uSrcW: { value: 1 },
  });
  const flareMat = mk(SH.flareFrag, {
    tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uAspect: { value: 1 },
    uThresh: { value: T.flareThreshold }, uGhostAmt: { value: 0 }, uGhosts: { value: 4 },
    uHaloAmt: { value: 0 }, uStreakAmt: { value: 0 }, uStreakTaps: { value: 8 },
    uStreakDir: { value: new THREE.Vector2(1, 0) },
  });
  // ---- viewmodel treatment (patched into the shared shader sources here, so shaders.js stays untouched):
  // DOF: the viewmodel's circle of confusion is clamped (uVMCoc) in the prep pass and in the composite, so the
  //   near-field gather can no longer spread the arms over the background (halo / see-through ghost) and the
  //   hands stay readable; TNR: much weaker on viewmodel pixels so moving hands do not smear in the dark.
  const uVMCoc = { value: T.vmCocHip };
  const uVMTnr = { value: T.vmTnr };
  const vmPatch = (src, find, repl, what) => {
    if (!src.includes(find)) { console.warn('[pipeline] viewmodel patch skipped:', what); return src; }
    return src.replace(find, repl);
  };
  let dofPrepSrc = vmPatch(SH.dofPrepFrag, 'uniform float uCocMax;', 'uniform float uCocMax;\nuniform sampler2D tVM;\nuniform float uVMCoc;', 'dof prep uniforms');
  dofPrepSrc = vmPatch(dofPrepSrc, '  gl_FragColor = vec4(min(c, vec3(2e3)), clamp(coc, -uCocMax, uCocMax));',
    `  float vmM = max(max(textureLod(tVM, uv0, 0.0).r, textureLod(tVM, uv1, 0.0).r), max(textureLod(tVM, uv2, 0.0).r, textureLod(tVM, uv3, 0.0).r));
  if (vmM > 0.5) coc = clamp(coc, -uVMCoc, uVMCoc);
  gl_FragColor = vec4(min(c, vec3(2e3)), clamp(coc, -uCocMax, uCocMax));`, 'dof prep clamp');
  let compSrc = vmPatch(SH.compositeFrag, 'uniform float uTNR;', 'uniform float uTNR;\nuniform float uVMCoc;\nuniform float uVMTnr;', 'composite uniforms');
  compSrc = vmPatch(compSrc, '  float cocF = uCocK * (AF.r - 1.0 / max(zc, 0.02));',
    '  float cocF = uCocK * (AF.r - 1.0 / max(zc, 0.02));\n  if (vm) cocF = clamp(cocF, -uVMCoc, uVMCoc);', 'composite coc clamp');
  // on the viewmodel itself the half-res gather (minimum radius ~1 half-res px) would always win through its
  // coverage alpha; there the blend follows the clamped CoC only, so full-resolution detail survives
  compSrc = vmPatch(compSrc, '      float a = max(smoothstep(0.6, 1.8, abs(cocF)), d.a);',
    '      float a = vm ? smoothstep(0.6, 1.8, abs(cocF)) : max(smoothstep(0.6, 1.8, abs(cocF)), d.a);', 'composite vm dof blend');
  compSrc = vmPatch(compSrc, '    float k = uTNR * smoothstep(1.6, 6.0, gain) * (1.0 - smoothstep(0.03, 0.12, diff));',
    '    float k = uTNR * smoothstep(1.6, 6.0, gain) * (1.0 - smoothstep(0.03, 0.12, diff));\n    if (vm) k *= uVMTnr;', 'composite tnr');

  const dofPrepMat = mk(dofPrepSrc, Object.assign({}, EXPU, DEPTHU, {
    tScene: { value: sceneRT.texture }, uFullTexel: { value: new THREE.Vector2() },
    uCocK: { value: 1 }, uCocMax: { value: 4 }, tVM: { value: vmRT.texture }, uVMCoc,
  }));
  const dofGatherMat = mk(SH.dofGatherFrag, {
    tPrep: { value: dofPrepRT.texture }, uTexel: { value: new THREE.Vector2() },
    uTaps: { value: 24 }, uCocMax: { value: 4 }, uTime,
  });

  const heads = [];
  for (let i = 0; i < 8; i++) heads.push(new THREE.Vector4());
  const faces = [];
  for (let i = 0; i < 8; i++) faces.push(new THREE.Vector4());

  const compU = Object.assign({}, EXPU, DEPTHU, {
    tScene: { value: sceneRT.texture },
    tBloom: { value: black }, tBloomWide: { value: black }, tBloomTight: { value: black },
    tFlare: { value: black }, tDof: { value: black }, tAO: { value: white }, tDirt: { value: dirtTex },
    tPrev: { value: ldrRT[1].texture },
    uRes: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 },
    uReproj: { value: new THREE.Matrix4() }, uInvDt: { value: 60 },
    uMBSamples: { value: 12 }, uMBMax: { value: T.motionBlurMax }, uMBAmt: { value: 1 },
    uShutter: { value: new THREE.Vector2(T.shutterMin, T.shutterMax) },
    uShake: { value: new THREE.Vector3() }, uZoom: { value: T.overscan },
    uRSVel: { value: new THREE.Vector2() }, uWobble: { value: 0 }, uTime, uFrame,
    uLens: { value: new THREE.Vector4(1, 1, 1, 0) }, uHalfDiag: { value: 1 },
    uCA: { value: T.chromaticAberration }, uFringe: { value: T.purpleFringe },
    uEdgeSoft: { value: T.edgeSoftness }, uAstig: { value: 0 },
    uVignette: { value: T.vignette }, uMechVig: { value: T.mechVignette },
    uAOAmt: { value: 0 },
    uBloomAmt: { value: T.bloomStrength }, uBloomNorm: { value: 1 }, uBloomWideNorm: { value: 1 },
    uBlooming: { value: T.blooming }, uBloomClip: { value: T.bloomClip },
    uBloomTint: { value: new THREE.Vector3(...T.bloomTint) },
    uHalation: { value: T.halation }, uHalationTint: { value: new THREE.Vector3(...T.halationTint) },
    uVeil: { value: T.veilingGlare }, uFlareAmt: { value: 1 }, uDirtAmt: { value: T.dirtStrength },
    uDof: { value: 0 }, uCocK: { value: 1 }, uBreath: { value: T.focusBreathing },
    tVM: { value: vmRT.texture },
    uNoiseP: { value: new THREE.Vector3() }, uNoiseQ: { value: new THREE.Vector4() },
    uGrain: { value: new THREE.Vector2(1, 2) }, uNR: { value: T.noiseReduction }, uTNR: { value: T.tnr },
    uWBBias: { value: new THREE.Vector3() },
    uRawClip: { value: T.rawClip }, uKnee: { value: T.knee }, uClip: { value: T.highlightClip }, uToe: { value: T.toe },
    uHLDesat: { value: T.highlightDesat },
    uSat: { value: T.saturation }, uSkinSat: { value: T.skinSaturation },
    uShadowTint: { value: new THREE.Vector3(...T.shadowTint) },
    uHighTint: { value: new THREE.Vector3(...T.highTint) },
    uBlack: { value: T.blackLift }, uWhite: { value: T.whitePoint },
    uDamage: { value: 0 }, uDeadDesat: { value: 0 }, uBlur: { value: 0 }, uBlurLod: { value: T.menuBlurLod },
    uMenu: { value: 0 },
    uHeads: { value: heads }, uHeadCount: { value: 0 },
    uVMCoc, uVMTnr,
  });
  const compMat = mk(compSrc, compU);

  const osd = createOSD(document.getElementById('overlay'));

  const finU = {
    tLDR: { value: ldrRT[0].texture }, tPrev: { value: ldrRT[1].texture },
    tOSD: { value: osd.texture || black }, uOSDRect: { value: osd.rect || new THREE.Vector4() },
    uOSDAlpha: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) }, uFrame, uTime,
    uSharpen: { value: T.sharpen }, uSharpenWide: { value: T.sharpenWide },
    uFXAA: { value: 1 }, uCompress: { value: T.compressBase },
    uMosquito: { value: T.mosquito }, uChromaBleed: { value: T.chromaBleed }, uBanding: { value: T.banding },
    uSmear: { value: 0 }, uGlitch: { value: 0 }, uTear: { value: 0 }, uFade: { value: 0 },
    uFaces: { value: faces }, uFaceCount: { value: 0 },
    uView: { value: new THREE.Vector3(0.5, 0.5, 1) },
  };
  const finMat = mk(SH.finalFrag, finU);

  // ---------------------------------------------------------------- AO (lazy)
  let gtao = null;
  function ensureAO(q) {
    if (!q.ao) return;
    if (!gtao) {
      gtao = new GTAOPass(scene, camera, 4, 4);
      gtao.output = GTAOPass.OUTPUT.Off;          // we only want gtao + denoise, applied in composite
      gtao.setGBuffer(sceneDepth, undefined);     // reuse our depth; normals reconstructed from depth
      gtao.blendIntensity = 1;
    }
    gtao.updateGtaoMaterial(Object.assign({ samples: q.aoSamples }, GTAO_PARAMS));
    gtao.updatePdMaterial(Object.assign({ samples: q.pdSamples }, PD_PARAMS));
  }

  // ---------------------------------------------------------------- state
  let qualityName = 'high';
  let Q = QUALITY.high;
  let iw = 4, ih = 4;              // internal (sensor) resolution
  const dbSize = new THREE.Vector2();
  let lastDbW = -1, lastDbH = -1;
  let bloomLevels = Q.bloomLevels;

  let trauma = 0, flashV = 0, damageV = 0, pendingKick = 0, smearV = 0;
  let menuFlag = null, deadFlag = null; // null = not set explicitly -> derived from game.state
  let menuAmt = 0, deadT = 0, wasDead = false;
  let frame = 0, time = 0, stateIdx = 0, ldrIdx = 0, needReset = true;
  let aimAmt = 0;
  let motion = 0, moveSpeed = 0;  // smoothed camera angular speed (rad/s) and translation (m/s)
  let codecQ = T.compressBase, codecKick = 0;
  let glitchChunk = -1, glitchBurst = 0;
  let eisJumpT = 0;
  const eisJump = new THREE.Vector2();

  const prevQ = new THREE.Quaternion(), curQ = new THREE.Quaternion();
  const prevRot = new THREE.Matrix4(), curRot = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4(), invVP = new THREE.Matrix4();
  const prevPos = new THREE.Vector3(), curPos = new THREE.Vector3();
  const v4 = new THREE.Vector4();
  const v3 = new THREE.Vector3();
  let havePrev = false;

  // lens model (mirrors bcLens in the composite shader)
  const lens = { t: 1, C: 1, z: 1, m: 0, hd: 1, asp: 1 };

  // quality monitor
  let lastNow = performance.now(), slowTime = 0, grace = 3;

  // ---------------------------------------------------------------- sizing
  function applySize() {
    renderer.getDrawingBufferSize(dbSize);
    lastDbW = dbSize.x; lastDbH = dbSize.y;
    let h = Math.max(2, Math.round(dbSize.y * Q.scale));
    if (h > Q.maxHeight) h = Q.maxHeight;
    h = Math.max(2, Math.round(h * renderScale));
    const aspect = dbSize.x / Math.max(1, dbSize.y);
    ih = h;
    iw = Math.max(2, Math.round(h * aspect));

    sceneRT.setSize(iw, ih);
    ldrRT[0].setSize(iw, ih);
    ldrRT[1].setSize(iw, ih);
    vmRT.setSize(iw, ih);
    let bw = iw, bh = ih;
    for (let i = 0; i < MAX_BLOOM; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      bloomDown[i].setSize(bw, bh);
      bloomUp[i].setSize(bw, bh);
    }
    flareRT.setSize(bloomDown[1].width, bloomDown[1].height);
    const hw = Math.max(1, iw >> 1), hh = Math.max(1, ih >> 1);
    dofPrepRT.setSize(hw, hh);
    dofRT.setSize(hw, hh);
    if (gtao) gtao.setSize(Math.max(2, Math.round(iw * Q.aoScale)), Math.max(2, Math.round(ih * Q.aoScale)));

    compU.uRes.value.set(iw, ih);
    compU.uAspect.value = iw / ih;
    finU.uRes.value.set(iw, ih);
    bloomPreMat.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    dofPrepMat.uniforms.uFullTexel.value.set(1 / iw, 1 / ih);
    dofGatherMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    lumMat.uniforms.uLod.value = Math.max(0, Math.log2(Math.max(iw, ih) / T.meterMip));
    stateU.uSceneLod.value = Math.floor(Math.log2(Math.max(iw, ih)));
    grace = Math.max(grace, 2);
  }

  function setSize(/* w, h */) {
    // The drawing buffer size (CSS size x pixel ratio) is what matters; main.js already resized it.
    applySize();
  }

  // per-frame shadow maps by tier: 'full' as authored, 'small' halves the maps, 'off' disables them (the static
  // baked sun shadow of the lighting module still applies). Changing castShadow recompiles lit materials once.
  const shadowOrig = new Map();
  function applyShadows(mode) {
    scene.traverse((o) => {
      if (!o.isLight || !o.shadow) return;
      if (!shadowOrig.has(o)) shadowOrig.set(o, { cast: o.castShadow, size: o.shadow.mapSize.clone() });
      const or = shadowOrig.get(o);
      const cast = mode !== 'off' && or.cast;
      const size = mode === 'small' ? Math.max(256, or.size.x / 2) : or.size.x;
      if (o.castShadow !== cast) o.castShadow = cast;
      if (o.shadow.mapSize.x !== size) { o.shadow.mapSize.set(size, size); o.shadow.map?.dispose(); o.shadow.map = null; }
    });
  }
  let renderScale = 1;
  function setQuality(q, scale = renderScale) {
    if (!QUALITY[q]) return;
    renderScale = Math.min(1, Math.max(0.4, scale));
    const tierChanged = q !== qualityName;
    qualityName = q;
    Q = QUALITY[q];
    if (tierChanged || !shadowOrig.size) {
      applyShadows(Q.shadows);
      applySurfaceQuality(scene, Q.surfCheap);
    }
    bloomLevels = Math.min(MAX_BLOOM, Q.bloomLevels);
    ensureAO(Q);
    compU.uMBSamples.value = Q.mbSamples;
    if (!Q.ao) compU.tAO.value = white;
    finU.uFXAA.value = Q.fxaa ? 1 : 0;
    slowTime = 0; grace = 3;
    applySize();
  }

  // ---------------------------------------------------------------- helpers
  function draw(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }

  // Viewmodel mask: the camera's children (arms + pistol) drawn flat white into their own target,
  // so metering, motion blur and AO can tell the gun from a wall that is equally close.
  const vmMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const swapped = [];
  const clearCol = new THREE.Color();
  function renderViewmodelMask() {
    swapped.length = 0;
    camera.traverse((o) => {
      if (o === camera) return;
      if (o.isMesh) { swapped.push(o, o.material); o.material = vmMat; }
      else if ((o.isSprite || o.isPoints || o.isLine) && o.visible) { swapped.push(o, null); o.visible = false; }
    });
    renderer.getClearColor(clearCol);
    const clearA = renderer.getClearAlpha();
    const shadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(vmRT);
    try {
      renderer.clear();
      if (swapped.length) renderer.render(camera, camera);
    } finally {
      for (let i = 0; i < swapped.length; i += 2) {
        if (swapped[i + 1]) swapped[i].material = swapped[i + 1];
        else swapped[i].visible = true;
      }
      renderer.shadowMap.enabled = shadows;
      renderer.setClearColor(clearCol, clearA);
    }
  }

  // ---- viewmodel projection
  // First-person arms are drawn with their own, narrower vertical FOV (T.vmFov, 0 = same as the scene), as
  // first-person games do: at the scene's ~97 deg bodycam FOV, forearms 15-30 cm from the lens balloon toward
  // the frame edge. The arms live on layer VM_LAYER; every light is enabled on both layers.
  const VM_LAYER = 1;
  let vmTagCount = -1, lightScan = 0, vmFovSaved = 0;
  function tagViewmodelLayers() {
    let n = 0;
    camera.traverse(() => { n++; });
    if (n !== vmTagCount) {
      vmTagCount = n;
      camera.traverse((o) => {
        if (o === camera) return;
        if (o.isLight) o.layers.enable(VM_LAYER); else o.layers.set(VM_LAYER);
      });
    }
    if (lightScan-- <= 0) {
      lightScan = 120;
      scene.traverse((o) => { if (o.isLight) o.layers.enable(VM_LAYER); });
    }
  }
  function vmProjectionBegin() {
    const f = T.vmFov;
    if (!f || f >= camera.fov) return false;
    vmFovSaved = camera.fov;
    camera.fov = f;
    camera.updateProjectionMatrix();
    return true;
  }
  function vmProjectionEnd(changed) {
    if (!changed) return;
    camera.fov = vmFovSaved;
    camera.updateProjectionMatrix();
  }

  function shakeNoise(t, a, b) {
    return Math.sin(t * a) * 0.55 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * (a + b) * 0.73 + 4.1) * 0.15;
  }

  function updateLens() {
    const asp = iw / ih;
    const t = Math.max(0.05, 1 - 0.5 * Math.max(0, T.fisheye));
    const z = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const hd = 0.5 * Math.sqrt(asp * asp + 1);
    const thD = Math.atan(hd * z);
    const C = hd / (Math.tan(t * thD) / t);
    Object.assign(lens, { t, C, z, m: T.mustache, hd, asp });
    compU.uLens.value.set(t, C, z, T.mustache);
    compU.uHalfDiag.value = hd;
  }

  // source radius (centred aspect units) -> output radius (before zoom)
  function lensForward(rs) {
    const th = Math.atan(rs * lens.z);
    const rom = lens.C * Math.tan(lens.t * th) / lens.t;
    let ro = rom;
    for (let i = 0; i < 4; i++) {
      const u2 = (ro / lens.hd) ** 2;
      ro = rom / (1 + lens.m * (u2 - u2 * u2));
    }
    return ro;
  }

  function headOf(e) {
    if (e.headPosition?.isVector3) return e.headPosition;
    if (e.head?.isVector3) return e.head;
    if (e.hit?.head?.c?.isVector3) return e.hit.head.c;
    if (!e.position) return null;
    return v3.set(e.position.x, e.position.y + 1.62, e.position.z);
  }

  function updateFaces(zoom) {
    let n = 0;
    const list = T.faceBlur ? ctx.enemies?.list : null;
    if (list) {
      for (let i = 0; i < list.length && n < 8; i++) {
        const e = list[i];
        if (!e || e.alive === false) continue;
        const hp = headOf(e);
        if (!hp) continue;
        v4.set(hp.x, hp.y, hp.z, 1).applyMatrix4(camera.matrixWorldInverse);
        const viewZ = -v4.z;
        if (viewZ < 0.25) continue;
        v4.applyMatrix4(camera.projectionMatrix);
        const nx = v4.x / v4.w, ny = v4.y / v4.w;
        if (Math.abs(nx) > 1.15 || Math.abs(ny) > 1.15) continue;
        const su = nx * 0.5 + 0.5, sv = ny * 0.5 + 0.5;
        const rSrc = Math.max(0.17 / (viewZ * lens.z), 5 / ih);
        heads[n].set(su, sv, viewZ, rSrc);
        // output-space position for the encoder pass
        const px = (su - 0.5) * lens.asp, py = sv - 0.5;
        const rs = Math.hypot(px, py);
        const ratio = rs > 1e-5 ? lensForward(rs) / rs : lens.C * lens.z;
        const k = ratio / zoom;
        const ou = 0.5 + (px * k) / lens.asp, ov = 0.5 + py * k;
        const rOut = rSrc * k * 1.3;
        const bs = Math.max(5 / ih, (2 * rOut) / Math.max(2, T.faceBlocks));
        faces[n].set(ou, ov, rOut, bs);
        n++;
      }
    }
    compU.uHeadCount.value = n;
    finU.uFaceCount.value = n;
  }

  // automatic quality: real frame times while the game or the live menu scene renders in a visible tab
  const auto = createAutoQuality({
    start: ctx.hardware?.tier || 'high',
    ceiling: ctx.hardware?.ceiling || 'high',
    apply: (tier, scale) => {
      console.info(`[quality] ${qualityName} @${Math.round(renderScale * 100)}% -> ${tier} @${Math.round(scale * 100)}%`);
      setQuality(tier, scale);
    },
  });
  function monitor() {
    const now = performance.now();
    const ms = now - lastNow;
    lastNow = now;
    if (ms > 250 || document.hidden) return;
    const dtS = ms / 1000;
    if (grace > 0) { grace -= dtS; return; }
    const st = ctx.game?.state;
    if (st !== 'playing' && st !== 'menu') return;
    auto.sample(ms);
  }

  function syncTuning() {
    EXPU.uKey.value = T.exposureKey;
    EXPU.uAdaptAmt.value = T.adaptAmount;
    EXPU.uRefLum.value = T.refLum;
    EXPU.uExpMin.value = T.exposureMin;
    EXPU.uExpMax.value = T.exposureMax;
    EXPU.uFlashGain.value = T.flashGain;
    lumMat.uniforms.uCenterW.value = T.meterCenter;
    lumMat.uniforms.uMeterCap.value = T.meterCap;
    stateU.uTauUp.value = T.adaptTauUp;
    stateU.uTauDown.value = T.adaptTauDown;
    stateU.uDamp.value = T.aeDamping;
    stateU.uDeadband.value = T.aeDeadband;
    stateU.uAwbTau.value = T.awbTau;
    stateU.uAF.value.set(T.afDelay, T.afSpeed, T.afDamping, T.afDeadband);
    stateU.uAFHunt.value.set(T.afHuntChance, T.afHuntKick);
    stateU.uAFMin.value = T.afMinDist;
    bloomPreMat.uniforms.uThreshold.value = T.bloomThreshold;
    bloomPreMat.uniforms.uKnee.value = Math.max(1e-3, T.bloomKnee);
    compU.uMBMax.value = T.motionBlurMax;
    compU.uMBAmt.value = T.motionBlur;
    compU.uShutter.value.set(T.shutterMin, T.shutterMax);
    compU.uFringe.value = T.purpleFringe;
    compU.uEdgeSoft.value = T.edgeSoftness;
    compU.uAstig.value = Q.astig ? T.astigmatism : 0;
    compU.uVignette.value = T.vignette;
    compU.uMechVig.value = T.mechVignette;
    compU.uBlooming.value = T.blooming;
    compU.uBloomClip.value = T.bloomClip;
    compU.uBloomTint.value.set(...T.bloomTint);
    compU.uHalation.value = T.halation;
    compU.uHalationTint.value.set(...T.halationTint);
    compU.uVeil.value = T.veilingGlare;
    compU.uDirtAmt.value = T.dirtStrength;
    compU.uBreath.value = T.focusBreathing;
    compU.uNoiseP.value.set(T.noiseShot, T.noiseRead, T.noise);
    compU.uNoiseQ.value.set(T.chromaNoise, T.fixedPattern, T.hotPixels, T.hotPixelStrength);
    compU.uGrain.value.set(T.grainSize[0], T.grainSize[1]);
    compU.uNR.value = T.noiseReduction;
    compU.uTNR.value = T.tnr;
    compU.uWBBias.value.set(T.wbBias[0], T.wbBias[1], T.awbStrength);
    compU.uKnee.value = T.knee;
    compU.uClip.value = T.highlightClip;
    compU.uToe.value = Math.max(1e-6, T.toe);
    compU.uHLDesat.value = T.highlightDesat;
    compU.uSat.value = T.saturation;
    compU.uSkinSat.value = T.skinSaturation;
    compU.uShadowTint.value.set(...T.shadowTint);
    compU.uHighTint.value.set(...T.highTint);
    compU.uBlack.value = T.blackLift;
    compU.uWhite.value = T.whitePoint;
    compU.uAOAmt.value = Q.ao ? T.aoStrength : 0;
    finU.uSharpen.value = T.sharpen;
    finU.uSharpenWide.value = T.sharpenWide;
    finU.uMosquito.value = T.mosquito;
    finU.uChromaBleed.value = T.chromaBleed;
    finU.uBanding.value = T.banding;
    compU.uRawClip.value = T.rawClip;
    const dv = T.debugView;   // dev magnifier for inspecting the output: [centreU, centreV, scale]
    if (dv && dv.length === 3) finU.uView.value.set(dv[0], dv[1], Math.max(1, dv[2]));
    else finU.uView.value.set(0.5, 0.5, 1);
  }

  // ---------------------------------------------------------------- frame
  function render(dt) {
    dt = Math.max(1e-3, Math.min(dt || 0.016, 0.1));
    renderer.getDrawingBufferSize(dbSize);
    if (dbSize.x !== lastDbW || dbSize.y !== lastDbH) applySize();
    monitor();
    syncTuning();
    time += dt;
    frame = (frame + 1) % 100000;
    uFrame.value = frame;

    // ---- effect state
    const state = ctx.game?.state;
    const menuOn = menuFlag !== null ? menuFlag : (state === 'menu' || state === 'paused' || state === 'loading');
    const deadOn = deadFlag !== null ? deadFlag : (state === 'dead');
    if (deadOn && !wasDead) deadT = 0;
    wasDead = deadOn;
    if (deadOn) deadT += dt;

    trauma = Math.max(0, trauma - dt * T.traumaDecay);
    flashV *= Math.exp(-dt * T.flashDecay);
    damageV *= Math.exp(-dt * T.damageDecay);
    smearV *= Math.exp(-dt * 5);
    menuAmt += ((menuOn ? 1 : 0) - menuAmt) * (1 - Math.exp(-dt * 5));

    // ---- scene (linear HDR), then the viewmodel with its own narrower projection on top (depth cleared)
    renderer.setRenderTarget(sceneRT);
    tagViewmodelLayers();
    camera.layers.set(0);
    renderer.render(scene, camera);
    camera.layers.set(VM_LAYER);
    const vmProj = vmProjectionBegin();
    const bg = scene.background, autoClear = renderer.autoClear, shadowAuto = renderer.shadowMap.autoUpdate;
    scene.background = null; renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
    try {
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderViewmodelMask();
    } finally {
      scene.background = bg; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAuto;
      vmProjectionEnd(vmProj);
      camera.layers.set(0);
    }
    uNear.value = camera.near; uFar.value = camera.far;
    updateLens();

    // ---- camera reprojection (motion blur with translation, rolling shutter from rotation)
    camera.getWorldQuaternion(curQ);
    camera.getWorldPosition(curPos);
    curRot.makeRotationFromQuaternion(curQ);
    curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let angle = havePrev ? prevQ.angleTo(curQ) : 0;
    let move = havePrev ? prevPos.distanceTo(curPos) : 0;
    if (!havePrev || angle > 0.6 || move > 1.5) {
      prevQ.copy(curQ); prevRot.copy(curRot); prevVP.copy(curVP); prevPos.copy(curPos);
      angle = 0; move = 0;
    }
    motion += (angle / dt - motion) * (1 - Math.exp(-dt * 10));
    moveSpeed += (move / dt - moveSpeed) * (1 - Math.exp(-dt * 6));
    invVP.copy(curVP).invert();
    compU.uReproj.value.multiplyMatrices(prevVP, invVP);
    compU.uInvDt.value = 1 / dt;
    tmpM.copy(prevRot).transpose();
    const rotRe = tmpM.premultiply(camera.projectionMatrix).multiply(curRot).multiply(camera.projectionMatrixInverse);
    v4.set(0, 0, 1, 1).applyMatrix4(rotRe);
    if (v4.w > 1e-4) {
      const pu = (v4.x / v4.w) * 0.5 + 0.5, pv = (v4.y / v4.w) * 0.5 + 0.5;
      const vx = (0.5 - pu) / dt, vy = (0.5 - pv) / dt;
      const k = T.rsReadout;
      compU.uRSVel.value.set(Math.max(-0.08, Math.min(0.08, vx * k)), Math.max(-0.08, Math.min(0.08, vy * k)));
    } else compU.uRSVel.value.set(0, 0);
    prevQ.copy(curQ); prevRot.copy(curRot); prevVP.copy(curVP); prevPos.copy(curPos); havePrev = true;

    // ---- AO
    if (Q.ao && gtao) {
      gtao.render(renderer, null, null);
      compU.tAO.value = gtao.pdRenderTarget.texture;
    }

    // ---- metering + camera state (AE / AWB / AF / veil)
    draw(lumMat, lumRT);
    const prevIdx = stateIdx; stateIdx ^= 1;
    stateU.tState.value = stateRT[prevIdx].texture;
    stateU.uDt.value = dt;
    stateU.uReset.value = needReset ? 1 : 0;
    stateU.uKick.value = pendingKick;
    stateU.uAFFixed.value = T.dof > 0 ? 0 : 0.1;
    aimAmt += ((ctx.player?.isAiming ? 1 : 0) - aimAmt) * (1 - Math.exp(-dt * 4));
    stateU.uAFNear.value = aimAmt * T.afAimNear;
    uVMCoc.value = T.vmCocHip + (T.vmCocAds - T.vmCocHip) * aimAmt;
    uVMTnr.value = T.vmTnr;
    pendingKick = 0;
    needReset = false;
    draw(stateMat, stateRT[stateIdx]);
    EXPU.tState.value = stateRT[stateIdx].texture;
    EXPU.uFlash.value = flashV;

    // ---- bloom pyramid (exposed, soft knee)
    draw(bloomPreMat, bloomDown[0]);
    for (let i = 1; i < bloomLevels; i++) {
      bloomDownMat.uniforms.tSrc.value = bloomDown[i - 1].texture;
      bloomDownMat.uniforms.uTexel.value.set(1 / bloomDown[i - 1].width, 1 / bloomDown[i - 1].height);
      draw(bloomDownMat, bloomDown[i]);
    }
    let src = bloomDown[bloomLevels - 1];
    for (let i = bloomLevels - 2; i >= 0; i--) {
      bloomUpMat.uniforms.tSrc.value = src.texture;
      bloomUpMat.uniforms.tAdd.value = bloomDown[i].texture;
      bloomUpMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      draw(bloomUpMat, bloomUp[i]);
      src = bloomUp[i];
    }
    compU.tBloom.value = src.texture;
    compU.uBloomNorm.value = 1 / bloomLevels;
    const wideIdx = Math.min(2, bloomLevels - 2);
    compU.tBloomWide.value = wideIdx >= 0 ? bloomUp[wideIdx].texture : src.texture;
    compU.uBloomWideNorm.value = 1 / Math.max(1, bloomLevels - Math.max(0, wideIdx));
    compU.tBloomTight.value = bloomDown[1].texture;
    compU.uBloomAmt.value = T.bloomStrength;

    // ---- lens flare (quarter res)
    if (T.flare > 0 && Q.flare && bloomLevels >= 3) {
      const fs = bloomDown[Math.min(3, bloomLevels - 1)];
      const fu = flareMat.uniforms;
      fu.tSrc.value = fs.texture;
      fu.uTexel.value.set(1 / fs.width, 1 / fs.height);
      fu.uAspect.value = iw / ih;
      fu.uThresh.value = T.flareThreshold;
      fu.uGhostAmt.value = T.flareGhosts;
      fu.uGhosts.value = Q.ghosts;
      fu.uHaloAmt.value = T.flareHalo;
      fu.uStreakAmt.value = T.flareStreak;
      fu.uStreakTaps.value = Q.streakTaps;
      fu.uStreakDir.value.set(Math.cos(T.flareStreakAngle), Math.sin(T.flareStreakAngle) * (iw / ih));
      fu.uStreakDir.value.normalize();
      draw(flareMat, flareRT);
      compU.tFlare.value = flareRT.texture;
      compU.uFlareAmt.value = T.flare;
    } else compU.uFlareAmt.value = 0;

    // ---- depth of field (half res)
    const s1080 = ih / 1080;
    const cocK = T.dofCoc * s1080 * 0.5;
    const cocMax = Math.max(1, T.dofMaxCoc * s1080 * 0.5);
    compU.uCocK.value = cocK;
    if (T.dof > 0 && Q.dofTaps > 0) {
      dofPrepMat.uniforms.uCocK.value = cocK;
      dofPrepMat.uniforms.uCocMax.value = cocMax;
      draw(dofPrepMat, dofPrepRT);
      dofGatherMat.uniforms.uTaps.value = Q.dofTaps;
      dofGatherMat.uniforms.uCocMax.value = cocMax;
      draw(dofGatherMat, dofRT);
      compU.tDof.value = dofRT.texture;
      compU.uDof.value = Math.min(1, T.dof);
    } else compU.uDof.value = 0;

    // ---- shake / wobble / EIS (image space only; the camera transform is never touched)
    const s = trauma * trauma;
    const st = time * T.shakeFreq;
    let ox = s * T.shakeOffset * shakeNoise(st, 1.0, 1.37);
    let oy = s * T.shakeOffset * shakeNoise(st + 13.1, 1.13, 0.91);
    let rot = s * T.shakeRotation * shakeNoise(st + 31.7, 0.83, 1.21);
    if (T.eis > 0) {
      // residual of electronic stabilisation: fine jitter while walking/turning, and the
      // occasional small crop re-centre jump that eases back
      const act = Math.min(1, moveSpeed / 4 + motion / 6);
      const ea = T.eis * act;
      ox += ea * 0.0016 * shakeNoise(time * 23.0, 1.0, 1.9);
      oy += ea * 0.0014 * shakeNoise(time * 21.0 + 5.0, 1.1, 1.7);
      rot += ea * 0.0012 * shakeNoise(time * 17.0 + 9.0, 0.9, 1.4);
      eisJumpT -= dt;
      if (eisJumpT <= 0) {
        eisJumpT = 0.6 + Math.random() * 2.2;
        if (act > 0.25) eisJump.set((Math.random() - 0.5) * 0.004, (Math.random() - 0.5) * 0.003).multiplyScalar(T.eis);
      }
      eisJump.multiplyScalar(Math.exp(-dt * 6));
      ox += eisJump.x; oy += eisJump.y;
    }
    compU.uShake.value.set(ox, oy, rot);
    const zoom = T.overscan * (1 - Math.min(0.06, (Math.abs(ox) + Math.abs(oy)) * 1.1 + Math.abs(rot) * 0.9));
    compU.uZoom.value = zoom;
    const wob = Math.max(0, trauma - 0.3) / 0.7;
    compU.uWobble.value = wob * wob * T.wobble;
    uTime.value = time;
    compU.uCA.value = T.chromaticAberration * (1 + damageV * 2.5);

    // ---- death timeline
    let deadDesat = 0, deadBlur = 0, glitch = 0, fade = 0;
    if (deadOn) {
      deadDesat = smoothstep(0, 1.2, deadT) * 0.88;
      deadBlur = smoothstep(0.3, 3.0, deadT);
      const chunk = Math.floor(deadT / 0.35);
      if (chunk !== glitchChunk) { glitchChunk = chunk; glitchBurst = Math.random() < 0.3 ? 0.35 + Math.random() * 0.4 : 0; }
      glitch = Math.max(deadT < 1.4 ? 0.95 * (1 - deadT / 1.4) + 0.2 : 0.1, glitchBurst);
      fade = smoothstep(T.deadFadeStart, T.deadFadeEnd, deadT) * T.deadFadeMax;
    } else glitchChunk = -1;

    compU.uDamage.value = Math.min(1, damageV);
    compU.uDeadDesat.value = deadDesat;
    const menuBlur = menuAmt;
    compU.uBlur.value = Math.max(menuBlur, deadBlur);
    compU.uBlurLod.value = deadBlur > menuBlur ? T.deadBlurLod : T.menuBlurLod;
    compU.uMenu.value = menuAmt;

    // ---- faces
    updateFaces(zoom);

    // ---- composite -> LDR
    const prevLdr = ldrIdx; ldrIdx ^= 1;
    compU.tPrev.value = ldrRT[prevLdr].texture;
    compU.uTNR.value = menuAmt > 0.5 || !Q.tnr ? 0 : T.tnr;
    draw(compMat, ldrRT[ldrIdx]);

    // ---- encoder -> screen. Rate control: quantiser rises fast with motion/complexity,
    // relaxes slowly when the camera holds still; drifts over each GOP.
    const qTarget = T.compressBase + Math.min(0.5, motion * T.compressMotion) + Math.min(0.2, moveSpeed * T.compressMove) +
      trauma * T.compressTrauma + glitch * 0.6 + menuAmt * 0.12;
    codecQ += (qTarget - codecQ) * (1 - Math.exp(-dt * (qTarget > codecQ ? 9 : 1.4)));
    codecQ = Math.min(1, codecQ + codecKick); codecKick = 0;
    const gop = Math.max(0.1, T.gopSeconds);
    const phase = (time % gop) / gop;
    finU.tLDR.value = ldrRT[ldrIdx].texture;
    finU.tPrev.value = ldrRT[prevLdr].texture;
    finU.uCompress.value = Math.min(1, codecQ * (1 + T.gopPump * (phase - 0.35)));
    finU.uSmear.value = Math.min(0.2, Math.max(0, motion - 4) * 0.004 + s * 0.05 + smearV + glitch * 0.12);
    finU.uGlitch.value = glitch;
    finU.uTear.value = Math.max(0, trauma - 0.5) * 2;
    finU.uFade.value = fade;
    const osdA = osd.update({ standby: menuAmt > 0.5 && !deadOn, glitch, width: dbSize.x, height: dbSize.y });
    finU.uOSDAlpha.value = osd.texture ? (osdA ?? 1) : 0;
    draw(finMat, null);
  }

  // ---------------------------------------------------------------- API
  const api = {
    render,
    setSize,
    addTrauma(a) {
      a = Math.max(0, +a || 0);
      trauma = Math.min(1, trauma + a);
      smearV = Math.min(0.05, smearV + a * 0.03);
      codecKick = Math.min(0.6, codecKick + a * 0.35);
    },
    flash(a) {
      a = Math.max(0, +a || 0);
      flashV = Math.min(1.5, flashV + a);
      pendingKick = Math.min(1.2, pendingKick + a * T.flashPull);
      smearV = Math.min(0.05, smearV + a * 0.01);
      codecKick = Math.min(0.6, codecKick + a * 0.3);
    },
    damage(a) { damageV = Math.min(1, damageV + Math.max(0, +a || 0)); trauma = Math.min(1, trauma + (+a || 0) * 0.3); },
    setDead(b) { deadFlag = !!b; if (!b) { deadT = 0; wasDead = false; } },
    setMenu(b) { menuFlag = !!b; },
    setFaceBlur(b) { T.faceBlur = !!b; },
    get quality() { return qualityName; },
    set quality(q) { setQuality(q); },
    setQuality,
    /** 'auto' | 'minimal' | 'low' | 'medium' | 'high' (manual tiers still drop the render scale if the frame rate collapses) */
    setQualityMode(mode) { auto.setMode(mode); },
    get renderScale() { return renderScale; },
    get qualityMode() { return auto.state.mode; },
    get internalSize() { return [iw, ih]; },
    tuning: TUNING,
    /** Snap exposure / white balance / focus to the current scene (e.g. after respawn/teleport). */
    resetExposure() { needReset = true; havePrev = false; },
    /** World point on the viewmodel -> world point that appears on the same pixel with the scene projection
     *  (muzzle flash, tracer start and casings line up with the gun drawn at T.vmFov). Modifies v. */
    viewmodelPoint(v) {
      const k = api.viewmodelScale();
      if (k === 1) return v;
      camera.updateMatrixWorld();
      v.applyMatrix4(camera.matrixWorldInverse);
      v.x *= k; v.y *= k;
      return v.applyMatrix4(camera.matrixWorld);
    },
    /** Same for a world direction drawn on the viewmodel (where the drawn barrel points on screen). Modifies d. */
    viewmodelDir(d) {
      const k = api.viewmodelScale();
      if (k === 1) return d;
      camera.updateMatrixWorld();
      d.transformDirection(camera.matrixWorldInverse);
      d.x *= k; d.y *= k;
      return d.transformDirection(camera.matrixWorld);
    },
    /** tan(scene FOV / 2) / tan(viewmodel FOV / 2): screen magnification of the viewmodel (1 = same projection) */
    viewmodelScale() {
      const f = T.vmFov;
      if (!f || f >= camera.fov) return 1;
      return Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(f) / 2);
    },
    /** Debug: read back the camera state (AE / AWB / AF / veil). Stalls the GPU; dev use only. */
    debugState() {
      const buf = new Uint16Array(16);
      renderer.readRenderTargetPixels(stateRT[stateIdx], 0, 0, 4, 1, buf);
      const f = Array.from(buf, (h) => THREE.DataUtils.fromHalfFloat(h));
      const lg = f[0] * T.adaptAmount + Math.log(T.refLum) * (1 - T.adaptAmount);
      const expo = Math.min(T.exposureMax, Math.max(T.exposureMin, T.exposureKey / Math.exp(lg)));
      return {
        logLum: f[0], aeVel: f[1], target: f[2], exposure: expo, gain: expo * T.refLum / T.exposureKey,
        awb: [f[4], f[5]], focusDpt: f[8], focusM: 1 / Math.max(f[8], 1e-3), afTarget: f[11], veil: f[12],
        codecQ, motion, moveSpeed,
        heads: heads.slice(0, compU.uHeadCount.value).map((h) => h.toArray().map((x) => +x.toFixed(4))),
        faces: faces.slice(0, finU.uFaceCount.value).map((h) => h.toArray().map((x) => +x.toFixed(4))),
      };
    },
  };

  setQuality(ctx.hardware?.tier || 'high');
  return api;
}
