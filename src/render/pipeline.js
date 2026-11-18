import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import * as SH from './shaders.js';
import { createOSD } from './osd.js';

// =============================================================================================
// Tunables. Everything that shapes the "chest-mounted action camera" look lives here.
// =============================================================================================
export const TUNING = {
  // lens
  distortK1: 0.30,           // barrel/fisheye strength ("slider"): 0 = rectilinear, ~0.45 = very fisheye
  distortK2: 0.06,           // higher-order barrel term
  chromaticAberration: 0.010,// lateral CA at the corners (relative radial scale between R and B)
  edgeSoftness: 1.1,         // mip LOD added at the corners (lens softness)
  vignette: 0.75,            // optical vignetting amount 0..1
  overscan: 0.985,           // constant zoom-in so shake/rolling shutter never shows the border

  // exposure / sensor
  exposureKey: 0.12,         // middle grey target
  adaptAmount: 0.72,         // 1 = fully normalise every scene, <1 keeps dark rooms darker
  refLum: 0.30,              // scene luminance treated as "daylight reference" (noise gain 1)
  exposureMin: 0.08,
  exposureMax: 9.0,
  adaptTauUp: 0.55,          // seconds, adapting to a brighter scene (doorway blow-out settles)
  adaptTauDown: 1.25,        // seconds, adapting to a darker scene
  sensorGain: 1.05,          // pre tone-map gain
  highlightClip: 1.10,       // post tone-map gain + hard clip (>1 = harsher highlight clipping)
  meterMip: 64,              // metering target size (power of two)
  viewmodelDepth: 0.85,      // metres; closer pixels are treated as the first-person viewmodel

  // bloom / halation / dirt
  bloomThreshold: 0.85,      // in exposed linear units
  bloomKnee: 0.45,
  bloomStrength: 0.30,
  bloomTint: [1.0, 0.94, 0.88],
  dirtStrength: 0.55,

  // grading
  saturation: 0.80,
  shadowTint: [0.93, 1.02, 1.01],  // faint green/teal in the shadows
  highTint: [1.0, 1.01, 0.985],
  blackLift: 0.018,

  // motion blur (camera rotation)
  shutterMin: 1 / 60,        // seconds at reference light
  shutterMax: 1 / 24,        // longest shutter in the dark
  motionBlurMax: 0.06,       // max blur length in uv units

  // rolling shutter / shake
  rsReadout: 0.022,          // sensor readout time, seconds (skew while panning)
  wobble: 0.0035,            // jello amplitude at full trauma
  shakeOffset: 0.020,        // image-space offset at full trauma (aspect-corrected uv)
  shakeRotation: 0.022,      // radians at full trauma
  shakeFreq: 19,             // Hz-ish
  traumaDecay: 1.15,         // per second

  // encoder / sensor
  noise: 0.020,              // luminance noise sigma at gain 1 (display-encoded units)
  chromaNoise: 0.55,         // chroma noise relative to luma noise
  sharpen: 0.38,             // in-camera sharpening halo
  compressBase: 0.08,        // always-on compression strength
  compressMotion: 0.075,     // per rad/s of camera rotation
  compressTrauma: 0.55,

  // effects
  flashGain: 2.6,            // exposure multiplier added at flash(1)
  flashDecay: 16,            // per second (exponential)
  damageDecay: 2.4,          // per second (exponential)
  menuBlurLod: 4.6,
  deadBlurLod: 4.2,
  deadFadeStart: 1.6,        // seconds after death
  deadFadeEnd: 6.5,
  deadFadeMax: 0.94,

  // auto quality fallback
  slowFrameMs: 25,
  slowFrameSeconds: 4,
};

export const QUALITY = {
  low: {
    scale: 0.7, maxHeight: 720, ao: false, aoScale: 0.5, aoSamples: 8, pdSamples: 8,
    bloomLevels: 3, mbSamples: 6, fxaa: true,
  },
  medium: {
    scale: 0.85, maxHeight: 900, ao: true, aoScale: 0.5, aoSamples: 8, pdSamples: 8,
    bloomLevels: 4, mbSamples: 8, fxaa: true,
  },
  high: {
    scale: 1.0, maxHeight: 1080, ao: true, aoScale: 0.5, aoSamples: 16, pdSamples: 12,
    bloomLevels: 5, mbSamples: 12, fxaa: true,
  },
};
const QUALITY_ORDER = ['low', 'medium', 'high'];

const GTAO_PARAMS = { radius: 0.55, distanceExponent: 1.4, thickness: 0.9, distanceFallOff: 1.0, scale: 1.1 };
const PD_PARAMS = { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2 };

// =============================================================================================

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function makeRT(w, h, { type = THREE.HalfFloatType, mips = false, depthTexture = null } = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: mips,
    depthBuffer: !!depthTexture,
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
    for (let i = 0; i < 10; i++) {                 // wipe streaks
      g.strokeStyle = `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
      g.lineWidth = 4 + rnd() * 14;
      const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI, l = 60 + rnd() * 180;
      g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (rnd() - 0.5) * 40, y + Math.sin(a) * l * 0.5,
        x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    for (let i = 0; i < 260; i++) {                // specks
      g.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.2})`;
      g.beginPath(); g.arc(rnd() * W, rnd() * H, 0.6 + rnd() * 2.2, 0, Math.PI * 2); g.fill();
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
  const dirtTex = makeDirtTexture();

  // ---------------------------------------------------------------- render targets
  const sceneDepth = new THREE.DepthTexture(4, 4, THREE.FloatType);
  const sceneRT = makeRT(4, 4, { mips: true, depthTexture: sceneDepth });
  const lumRT = makeRT(T.meterMip, T.meterMip, { mips: true });
  const adaptRT = [makeRT(1, 1), makeRT(1, 1)];
  const ldrRT = [makeRT(4, 4, { type: THREE.UnsignedByteType, mips: true }),
    makeRT(4, 4, { type: THREE.UnsignedByteType, mips: true })];
  const MAX_BLOOM = 5;
  const bloomDown = [], bloomUp = [];
  for (let i = 0; i < MAX_BLOOM; i++) {
    bloomDown.push(makeRT(4, 4));
    bloomUp.push(makeRT(4, 4));
  }

  // ---------------------------------------------------------------- shared uniforms
  const EXPU = {
    tAdapt: { value: adaptRT[0].texture },
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
  const uVMDepth = { value: T.viewmodelDepth };
  const uTime = { value: 0 };

  const mk = (frag, uniforms) => new THREE.ShaderMaterial({
    uniforms, vertexShader: SH.vert, fragmentShader: frag,
    depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
  });

  const lumMat = mk(SH.lumFrag, {
    tScene: { value: sceneRT.texture }, tDepth: { value: sceneDepth },
    uLod: { value: 0 }, uNear, uFar, uVMDepth,
  });
  const adaptMat = mk(SH.adaptFrag, {
    tLum: { value: lumRT.texture }, tPrev: { value: adaptRT[1].texture },
    uLumLod: { value: Math.log2(T.meterMip) }, uDt: { value: 0.016 },
    uTauUp: { value: T.adaptTauUp }, uTauDown: { value: T.adaptTauDown }, uReset: { value: 1 },
  });
  const bloomPreMat = mk(SH.bloomPreFrag, Object.assign({}, EXPU, {
    tScene: { value: sceneRT.texture }, uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: T.bloomThreshold }, uKnee: { value: T.bloomKnee },
  }));
  const bloomDownMat = mk(SH.bloomDownFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const bloomUpMat = mk(SH.bloomUpFrag, {
    tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() },
  });

  const compU = Object.assign({}, EXPU, {
    tScene: { value: sceneRT.texture }, tDepth: { value: sceneDepth },
    tBloom: { value: white }, tBloomWide: { value: white }, tAO: { value: white }, tDirt: { value: dirtTex },
    uRes: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 },
    uReproj: { value: new THREE.Matrix4() }, uInvDt: { value: 60 },
    uMBSamples: { value: 12 }, uMBMax: { value: T.motionBlurMax },
    uShutter: { value: new THREE.Vector2(T.shutterMin, T.shutterMax) },
    uShake: { value: new THREE.Vector3() }, uZoom: { value: T.overscan },
    uRSVel: { value: new THREE.Vector2() }, uWobble: { value: 0 }, uTime,
    uDistort: { value: new THREE.Vector2(T.distortK1, T.distortK2) },
    uCA: { value: T.chromaticAberration }, uEdgeSoft: { value: T.edgeSoftness }, uVignette: { value: T.vignette },
    uAOAmt: { value: 0 }, uBloomAmt: { value: T.bloomStrength },
    uBloomTint: { value: new THREE.Vector3(...T.bloomTint) }, uDirtAmt: { value: T.dirtStrength },
    uNear, uFar, uVMDepth,
    uSensorGain: { value: T.sensorGain }, uClip: { value: T.highlightClip }, uSat: { value: T.saturation },
    uShadowTint: { value: new THREE.Vector3(...T.shadowTint) },
    uHighTint: { value: new THREE.Vector3(...T.highTint) },
    uBlack: { value: T.blackLift },
    uDamage: { value: 0 }, uDeadDesat: { value: 0 }, uBlur: { value: 0 }, uBlurLod: { value: T.menuBlurLod },
    uMenu: { value: 0 },
  });
  const compMat = mk(SH.compositeFrag, compU);

  const finU = Object.assign({}, EXPU, {
    tLDR: { value: ldrRT[0].texture }, tPrev: { value: ldrRT[1].texture },
    uRes: { value: new THREE.Vector2(1, 1) }, uFrame: { value: 0 }, uTime,
    uNoise: { value: T.noise }, uChromaNoise: { value: T.chromaNoise }, uSharpen: { value: T.sharpen },
    uFXAA: { value: 1 }, uCompress: { value: T.compressBase }, uSmear: { value: 0 },
    uGlitch: { value: 0 }, uTear: { value: 0 }, uFade: { value: 0 },
  });
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

  let trauma = 0, flashV = 0, damageV = 0;
  let menuFlag = null, deadFlag = null; // null = not set explicitly -> derived from game.state
  let menuAmt = 0, deadT = 0, wasDead = false;
  let frame = 0, time = 0, adaptIdx = 0, ldrIdx = 0, needReset = true;
  let motion = 0;                  // smoothed camera angular speed, rad/s
  let glitchChunk = -1, glitchBurst = 0;

  const prevQ = new THREE.Quaternion(), curQ = new THREE.Quaternion();
  const prevRot = new THREE.Matrix4(), curRot = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const v4 = new THREE.Vector4();
  let havePrev = false;

  // quality monitor
  let lastNow = performance.now(), slowTime = 0, grace = 3;

  const osd = createOSD(document.getElementById('overlay'));

  // ---------------------------------------------------------------- sizing
  function applySize() {
    renderer.getDrawingBufferSize(dbSize);
    lastDbW = dbSize.x; lastDbH = dbSize.y;
    let h = Math.max(2, Math.round(dbSize.y * Q.scale));
    if (h > Q.maxHeight) h = Q.maxHeight;
    const aspect = dbSize.x / Math.max(1, dbSize.y);
    ih = h;
    iw = Math.max(2, Math.round(h * aspect));

    sceneRT.setSize(iw, ih);
    ldrRT[0].setSize(iw, ih);
    ldrRT[1].setSize(iw, ih);
    let bw = iw, bh = ih;
    for (let i = 0; i < MAX_BLOOM; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      bloomDown[i].setSize(bw, bh);
      bloomUp[i].setSize(bw, bh);
    }
    if (gtao) gtao.setSize(Math.max(2, Math.round(iw * Q.aoScale)), Math.max(2, Math.round(ih * Q.aoScale)));

    compU.uRes.value.set(iw, ih);
    compU.uAspect.value = iw / ih;
    finU.uRes.value.set(iw, ih);
    bloomPreMat.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    lumMat.uniforms.uLod.value = Math.max(0, Math.log2(Math.max(iw, ih) / T.meterMip));
    grace = Math.max(grace, 2);
  }

  function setSize(/* w, h */) {
    // The drawing buffer size (CSS size x pixel ratio) is what matters; main.js already resized it.
    applySize();
  }

  function setQuality(q) {
    if (!QUALITY[q]) return;
    qualityName = q;
    Q = QUALITY[q];
    bloomLevels = Math.min(MAX_BLOOM, Q.bloomLevels);
    ensureAO(Q);
    compU.uMBSamples.value = Q.mbSamples;
    compU.uAOAmt.value = Q.ao ? 1 : 0;
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

  function shakeNoise(t, a, b) {
    return Math.sin(t * a) * 0.55 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * (a + b) * 0.73 + 4.1) * 0.15;
  }

  function monitor() {
    const now = performance.now();
    const ms = now - lastNow;
    lastNow = now;
    if (ms > 250 || document.hidden) { slowTime = 0; return; }
    const dtS = ms / 1000;
    if (grace > 0) { grace -= dtS; return; }
    const playing = !ctx.game || ctx.game.state === 'playing';
    if (!playing) { slowTime = Math.max(0, slowTime - dtS); return; }
    if (ms > T.slowFrameMs) slowTime += dtS;
    else slowTime = Math.max(0, slowTime - dtS * 0.5);
    if (slowTime > T.slowFrameSeconds) {
      const i = QUALITY_ORDER.indexOf(qualityName);
      if (i > 0) {
        console.info(`[pipeline] frame time high, quality ${qualityName} -> ${QUALITY_ORDER[i - 1]}`);
        setQuality(QUALITY_ORDER[i - 1]);
      }
      slowTime = 0;
    }
  }

  // ---------------------------------------------------------------- frame
  function render(dt) {
    dt = Math.max(1e-3, Math.min(dt || 0.016, 0.1));
    renderer.getDrawingBufferSize(dbSize);
    if (dbSize.x !== lastDbW || dbSize.y !== lastDbH) applySize();
    monitor();
    time += dt;
    frame = (frame + 1) % 100000;

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
    menuAmt += ((menuOn ? 1 : 0) - menuAmt) * (1 - Math.exp(-dt * 5));

    // ---- scene (linear HDR)
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    uNear.value = camera.near; uFar.value = camera.far;

    // ---- camera rotation reprojection (for motion blur / rolling shutter)
    camera.getWorldQuaternion(curQ);
    curRot.makeRotationFromQuaternion(curQ);
    let angle = havePrev ? prevQ.angleTo(curQ) : 0;
    if (!havePrev || angle > 0.6) { prevQ.copy(curQ); prevRot.copy(curRot); angle = 0; }
    motion += (angle / dt - motion) * (1 - Math.exp(-dt * 10));
    tmpM.copy(prevRot).transpose();
    const reproj = compU.uReproj.value;
    reproj.multiplyMatrices(camera.projectionMatrix, tmpM).multiply(curRot).multiply(camera.projectionMatrixInverse);
    compU.uInvDt.value = 1 / dt;
    v4.set(0, 0, 1, 1).applyMatrix4(reproj);
    if (v4.w > 1e-4) {
      const pu = (v4.x / v4.w) * 0.5 + 0.5, pv = (v4.y / v4.w) * 0.5 + 0.5;
      const vx = (0.5 - pu) / dt, vy = (0.5 - pv) / dt;
      const k = T.rsReadout;
      compU.uRSVel.value.set(Math.max(-0.08, Math.min(0.08, vx * k)), Math.max(-0.08, Math.min(0.08, vy * k)));
    } else compU.uRSVel.value.set(0, 0);
    prevQ.copy(curQ); prevRot.copy(curRot); havePrev = true;

    // ---- AO
    if (Q.ao && gtao) {
      gtao.render(renderer, null, null);
      compU.tAO.value = gtao.pdRenderTarget.texture;
    }

    // ---- metering + adaptation
    draw(lumMat, lumRT);
    const prevIdx = adaptIdx; adaptIdx ^= 1;
    adaptMat.uniforms.tPrev.value = adaptRT[prevIdx].texture;
    adaptMat.uniforms.uDt.value = dt;
    adaptMat.uniforms.uReset.value = needReset ? 1 : 0;
    needReset = false;
    draw(adaptMat, adaptRT[adaptIdx]);
    EXPU.tAdapt.value = adaptRT[adaptIdx].texture;
    EXPU.uFlash.value = flashV;

    // ---- bloom
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
    const wideIdx = Math.min(2, bloomLevels - 2);
    compU.tBloomWide.value = wideIdx >= 0 ? bloomUp[wideIdx].texture : src.texture;
    compU.uBloomAmt.value = T.bloomStrength / bloomLevels * (1 + flashV * 0.8);

    // ---- shake / wobble (image space only; the camera transform is never touched)
    const s = trauma * trauma;
    const st = time * T.shakeFreq;
    const ox = s * T.shakeOffset * shakeNoise(st, 1.0, 1.37);
    const oy = s * T.shakeOffset * shakeNoise(st + 13.1, 1.13, 0.91);
    const rot = s * T.shakeRotation * shakeNoise(st + 31.7, 0.83, 1.21);
    compU.uShake.value.set(ox, oy, rot);
    compU.uZoom.value = T.overscan * (1 - Math.min(0.06, (Math.abs(ox) + Math.abs(oy)) * 1.1 + Math.abs(rot) * 0.9));
    const wob = Math.max(0, trauma - 0.35) / 0.65;
    compU.uWobble.value = wob * wob * T.wobble;
    uTime.value = time;

    // ---- death timeline
    let deadDesat = 0, deadBlur = 0, glitch = 0, fade = 0;
    if (deadOn) {
      deadDesat = smoothstep(0, 1.2, deadT) * 0.88;
      deadBlur = smoothstep(0.3, 3.0, deadT) * 0.9;
      const chunk = Math.floor(deadT / 0.35);
      if (chunk !== glitchChunk) { glitchChunk = chunk; glitchBurst = Math.random() < 0.3 ? 0.35 + Math.random() * 0.4 : 0; }
      glitch = Math.max(deadT < 1.4 ? 0.95 * (1 - deadT / 1.4) + 0.2 : 0.1, glitchBurst);
      fade = smoothstep(T.deadFadeStart, T.deadFadeEnd, deadT) * T.deadFadeMax;
    } else glitchChunk = -1;

    compU.uDamage.value = Math.min(1, damageV);
    compU.uDeadDesat.value = deadDesat;
    const menuBlur = menuAmt * 0.9;
    compU.uBlur.value = Math.max(menuBlur, deadBlur);
    compU.uBlurLod.value = deadBlur > menuBlur ? T.deadBlurLod : T.menuBlurLod;
    compU.uMenu.value = menuAmt;

    // ---- composite -> LDR
    const prevLdr = ldrIdx; ldrIdx ^= 1;
    draw(compMat, ldrRT[ldrIdx]);

    // ---- encoder / sensor -> screen
    finU.tLDR.value = ldrRT[ldrIdx].texture;
    finU.tPrev.value = ldrRT[prevLdr].texture;
    finU.uFrame.value = frame;
    finU.uCompress.value = Math.min(1, T.compressBase + Math.min(0.5, motion * T.compressMotion) +
      trauma * T.compressTrauma + glitch * 0.6 + menuAmt * 0.15);
    finU.uSmear.value = Math.min(0.35, Math.max(0, motion - 3.5) * 0.006 + s * 0.05 + glitch * 0.12);
    finU.uGlitch.value = glitch;
    finU.uTear.value = Math.max(0, trauma - 0.5) * 2;
    finU.uFade.value = fade;
    finU.uNoise.value = T.noise * (1 + menuAmt * 0.3);
    draw(finMat, null);

    osd.update({ standby: menuAmt > 0.5 && !deadOn, glitch });
  }

  // ---------------------------------------------------------------- API
  const api = {
    render,
    setSize,
    addTrauma(a) { trauma = Math.min(1, trauma + Math.max(0, +a || 0)); },
    flash(a) { flashV = Math.min(1.5, flashV + Math.max(0, +a || 0)); },
    damage(a) { damageV = Math.min(1, damageV + Math.max(0, +a || 0)); trauma = Math.min(1, trauma + (+a || 0) * 0.3); },
    setDead(b) { deadFlag = !!b; if (!b) { deadT = 0; wasDead = false; } },
    setMenu(b) { menuFlag = !!b; },
    get quality() { return qualityName; },
    set quality(q) { setQuality(q); },
    setQuality,
    tuning: TUNING,
    /** Snap exposure to the current scene (e.g. after respawn/teleport). */
    resetExposure() { needReset = true; havePrev = false; },
  };

  setQuality('high');
  return api;
}
