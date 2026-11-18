import * as THREE from 'three';
import { makeRng, clamp, lerp, smooth } from './dsp.js';
import * as SW from './synth-weapons.js';
import * as SF from './synth-world.js';
import * as SV from './synth-voice.js';
import { buildAcoustics, surfaceAt, genIR, genIRSteps, IR_TYPES, renderER } from './acoustics.js';
import { MIC_WORKLET_SRC, MIC_PROCESSOR } from './mic-worklet.js';
import * as LAYOUT from '../world/layout.js';

// Fully procedural WebAudio for SECTOR 9 (no audio files).
//
// Sounds are rendered into buffers by pure DSP code (synth-*.js) at startup / in idle time, with several
// random variants each, and played back with per-event variation. The live graph only does what has to
// be live: spatialisation, occlusion, zone reverbs and the bodycam microphone.
//
//  voice: buffer(s) -> in -> [tone shelf] -> occlusion/air LP -> gain -> HRTF panner -> class bus
//                       \-> send -> reverb of the SOURCE's zone  (+ smaller send into the listener's zone)
//  shot early reflections (image sources, rendered per shot, pre-panned stereo) -> weapons bus
//  buses: weapons, impacts, foley, voices, ambience (level-ducked), reverb returns (per zone type, gain and
//         low-pass follow the listener through portals) -> world
//  world -> hearing LP (low health) -> muffle (death) -> mic: HP, plastic-housing resonance, presence, LP
//        -> + self-noise -> AGC/limiter/clip/codec worklet (fallback: compressor + shaper) -> master -> limiter
//  perceptual bus (tinnitus, heartbeat) and UI bus bypass the microphone.

// ---- Tunables -------------------------------------------------------------------------------
export const AUDIO_TUNING = {
  masterVolume: 0.8,          // default, overridden by setMasterVolume
  maxVoices: 72,              // shots are never dropped; lower priorities are stolen first
  panningModel: 'HRTF',       // or 'equalpower' (cheaper)
  idleBudgetMs: 3,            // per-frame budget for background buffer rendering
  // bodycam microphone / AGC
  agcTarget: 0.3, agcMaxGain: 24, agcMinGain: 0.03, agcAttack: 0.002, agcHold: 0.16, agcReleaseDb: 13,
  dropThresh: 2.6, codec: 0.55,
  micHP: 95, micLP: 11500, boxyHz: 540, boxyDb: 2.5, boxyQ: 1.3, presenceHz: 3200, presenceDb: 2,
  hiss: 0.00009,              // self-noise before the AGC (rises when the AGC opens up)
  forceFallback: false,       // true: skip the AudioWorklet (compressor+shaper approximation)
  reverb: 1.0,                // global wet scale
  ambience: 1.0,              // ambience bed scale
  muffledHz: 380,
  // raw peak amplitude at 1 m (the AGC brings quiet scenes up by up to agcMaxGain)
  cal: {
    shotPlayer: 2.0, mech: 0.13, shotPistol: 1.0, shotRifle: 1.6, crackRifle: 0.55, crackPistol: 0.22, ricochet: 0.08,
    impConcrete: 0.16, impMetal: 0.2, impWood: 0.14, impGlass: 0.16, impFlesh: 0.05,
    step: 0.012, playerStep: 0.011, gear: 0.005, cloth: 0.0035, land: 0.035, breath: 0.007, heart: 0.09, handling: 0.0022,
    playerHit: 0.14, playerVoice: 0.07, shout: 0.06, grunt: 0.04, deathVoice: 0.035, radio: 0.04,
    bodyFall: 0.06, camDrop: 0.4, shell: 0.009, magOut: 0.014, magIn: 0.022, slide: 0.028, dry: 0.014, pressCheck: 0.008,
    magDrop: 0.03, switch: 0.012, ui: 0.22, tinnitus: 0.018,
    wind: 0.0025, buffet: 0.03, whistle: 0.0012, traffic: 0.0012, roomTone: 0.0005, hum: 0.0035, flicker: 0.008,
    drip: 0.005, creak: 0.006, bang: 0.09, bird: 0.03, crow: 0.04, pigeons: 0.025, coo: 0.01, car: 0.004, train: 0.005, siren: 0.0028,
  },
};

const UP = new THREE.Vector3(0, 1, 0);
const validPos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

export function createAudio(ctx) {
  const T = AUDIO_TUNING;
  let ac = null, eng = null, masterVol = T.masterVolume, muffled = false;

  function resume() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        ac = new AC({ latencyHint: 'interactive' });
        eng = createEngine(ac, ctx, { masterVolume: masterVol });
        if (muffled) eng.setMuffled(true, true);
      } catch (e) { console.warn('[audio] init failed', e); ac = null; eng = null; return; }
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  }
  function play(name, o) {
    if (!eng || ac.state !== 'running') return;
    eng.play(name, o);
  }
  function update(dt) { if (eng) eng.update(dt, ac.state === 'running'); }
  function setMuffled(b) { muffled = !!b; if (eng) eng.setMuffled(muffled); }
  function setMasterVolume(v) { masterVol = clamp(Number(v) || 0, 0, 1.5); if (eng) eng.setMasterVolume(masterVol); }

  return {
    resume, play, update, setMuffled, setMasterVolume,
    get context() { return ac; },
    get engine() { return eng; },
    get voiceCount() { return eng ? eng.voiceCount : 0; },
    tuning: T,
  };
}

/**
 * Builds the complete audio engine on any BaseAudioContext (live or offline).
 * opts: { masterVolume, destination, offline, seed, ambience (bool, default true) }
 */
export function createEngine(ac, ctx, opts = {}) {
  const T = AUDIO_TUNING, CAL = T.cal;
  const sr = ac.sampleRate;
  const offline = !!opts.offline;
  const R = makeRng(opts.seed ?? ((Math.random() * 4294967296) >>> 0));
  const rnd = (a, b) => a + R() * (b - a);
  const vary = (x, amt) => x * (1 + (R() * 2 - 1) * amt);
  const now = () => ac.currentTime;
  const nyq = sr * 0.5 - 100;
  const fq = (f) => clamp(f, 10, nyq);

  // ============================================================== acoustics (lazy: needs the layout)
  let AC = null, layoutSolids = [], debrisSpots = [], leaks = [];
  function acoustics() {
    if (AC) return AC;
    let layout = ctx?.level?.layout;
    if (!layout && typeof LAYOUT.buildLayout === 'function') { try { layout = LAYOUT.buildLayout(); } catch (e) { layout = null; } }
    AC = buildAcoustics(layout || {});
    layoutSolids = layout?.solids || [];
    for (const w of AC.windows) debrisSpots.push([w.x, w.z, 1.6]);
    for (const h of layout?.roofHoles || []) {
      const cx = (h.min[0] + h.max[0]) / 2, cz = (h.min[2] + h.max[2]) / 2;
      debrisSpots.push([cx, cz, 1.4]);
      leaks.push(new THREE.Vector3(cx + rnd(-0.6, 0.6), 0.02, cz + rnd(-0.6, 0.6)));
    }
    leaks.push(new THREE.Vector3(-20.6, 0.02, 12.9), new THREE.Vector3(15.2, 0.02, 2.6), new THREE.Vector3(9.5, 0.02, 6.2), new THREE.Vector3(-21.5, 0.02, -3.5));
    return AC;
  }

  // ============================================================== buffer banks (rendered lazily / in idle time)
  const jobs = [];
  const banks = new Map();
  function toAB(data) {
    if (data instanceof Float32Array) { const b = ac.createBuffer(1, Math.max(1, data.length), sr); b.copyToChannel(data, 0); return b; }
    const b = ac.createBuffer(2, Math.max(1, data.L.length), sr); b.copyToChannel(data.L, 0); b.copyToChannel(data.R, 1); return b;
  }
  function fill(b) {
    const res = b.gen(makeRng((R() * 4294967296) >>> 0));
    b.list.push(res && res.ab ? res : { ab: toAB(res) });
  }
  /** Random variant from bank `key` (count variants, gen(rng) -> Float32Array | {L,R} | {ab,...}). */
  function pick(key, count, gen) {
    let b = banks.get(key);
    if (!b) { b = { list: [], count, gen, queued: 0, last: -1 }; banks.set(key, b); }
    if (!b.list.length) fill(b);
    while (b.queued + b.list.length < b.count) {
      b.queued++;
      jobs.push(() => { b.queued--; if (b.list.length < b.count) fill(b); });
    }
    let i = Math.floor(R() * b.list.length);
    if (b.list.length > 1 && i === b.last) i = (i + 1) % b.list.length;
    b.last = i;
    return b.list[i];
  }
  /** Runs queued jobs within a time budget. A job is a function or an iterator (resumed until done). */
  function pump(budgetMs) {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < budgetMs) {
      const j = jobs[0];
      try {
        if (typeof j === 'function') { jobs.shift(); j(); }
        else if (j.next().done) jobs.shift();
      } catch (e) { jobs.shift(); console.warn('[audio] job', e); }
    }
  }
  function prewarm(key, count, gen) { jobs.push(() => pick(key, count, gen)); }
  // live: render in browser idle periods (falls back to a small per-frame budget in update())
  const ric = !offline && typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
  let idleOn = false;
  function idleLoop(deadline) {
    idleOn = false;
    while (jobs.length && deadline.timeRemaining() > 4) pump(Math.min(8, deadline.timeRemaining() - 2));
    if (jobs.length) { idleOn = true; ric(idleLoop, { timeout: 500 }); }
  }
  function kickIdle() { if (ric && !idleOn && jobs.length) { idleOn = true; ric(idleLoop, { timeout: 500 }); } }
  const G = {
    blast: (kind) => (r) => { const f = SW.genBlast(sr, r, kind); return { ab: toAB(f), fam: SW.blastFamily(sr, f) }; },
    mech: (locked) => (r) => SW.genMech(sr, r, locked),
    flyby: (k) => (r) => SW.genFlyby(sr, r, k),
    ric: (r) => SW.genRicochet(sr, r, Math.floor(r() * 3)),
    dry: (r) => SW.genDry(sr, r), magOut: (r) => SW.genMagOut(sr, r), magIn: (r) => SW.genMagIn(sr, r),
    slide: (r) => SW.genSlideRelease(sr, r), press: (r) => SW.genPressCheck(sr, r),
    magDrop: (s) => (r) => SW.genMagDrop(sr, r, s), shell: (s, rifle) => (r) => SW.genShell(sr, r, s, rifle),
    step: (s, inten) => (r) => SF.genStep(sr, r, s, inten), gear: (i) => (r) => SF.genGear(sr, r, i),
    cloth: (d) => (r) => SF.genCloth(sr, r, d), land: (s) => (r) => SF.genLand(sr, r, s),
    imp: { concrete: (r) => SF.genImpactConcrete(sr, r), glass: (r) => SF.genGlass(sr, r, true), flesh: (r) => SF.genFlesh(sr, r) },
    metal: (size, thin) => (r) => SF.genImpactMetal(sr, r, size, thin), wood: (h) => (r) => SF.genImpactWood(sr, r, h),
    bodyFall: (s) => (r) => SF.genBodyFall(sr, r, s), camDrop: (r) => SF.genCamDrop(sr, r),
    breath: (inh, e) => (r) => SF.genBreath(sr, r, inh, e), heart: (r) => SF.genHeart(sr, r),
    radio: (r) => SV.genRadio(sr, r),
    drip: (r) => SF.genDrip(sr, r), creak: (m) => (r) => SF.genCreak(sr, r, m), bang: (r) => SF.genSheetBang(sr, r),
    bird: (c) => (r) => SF.genBird(sr, r, c), pigeons: (r) => SF.genPigeons(sr, r), coo: (r) => SF.genCoo(sr, r),
    car: (r) => SF.genCarPass(sr, r), train: (r) => SF.genTrain(sr, r), siren: (r) => SF.genSiren(sr, r),
    flicker: (r) => SF.genFlickerBuzz(sr, r),
    switch: (r) => { const b = new Float32Array(Math.floor(0.06 * sr)); SW._internal.clickAt(b, sr, r, 0.002, 2900, 1, 0.006); return b; },
    ui: (r) => { const b = new Float32Array(Math.floor(0.05 * sr)); SW._internal.clickAt(b, sr, r, 0.001, 1700, 0.6, 0.012); return b; },
  };

  // ============================================================== graph
  const gain = (v = 1) => { const g = ac.createGain(); g.gain.value = v; return g; };
  const biq = (type, f, q = 0.707, g = 0) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = fq(f); b.Q.value = q; if (g) b.gain.value = g; return b; };
  const chain = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; };

  const master = gain(opts.masterVolume ?? T.masterVolume);
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.12;
  chain(master, limiter, opts.destination || ac.destination);
  const uiBus = gain(1); uiBus.connect(master);
  const percBus = gain(1); percBus.connect(master);

  // ---- microphone + AGC
  const agcIn = gain(1);
  // Fallback (no AudioWorklet): frame-rate AGC gain driven by a level meter on the mic input, followed by a
  // fast compressor (catches what the frame-rate gain misses) and a soft clipper.
  const fbAgc = gain(T.agcMaxGain * 0.5), fbComp = ac.createDynamicsCompressor();
  fbComp.threshold.value = -14; fbComp.knee.value = 6; fbComp.ratio.value = 12; fbComp.attack.value = 0.001; fbComp.release.value = 0.25;
  const fbMake = gain(0.32), fbClip = ac.createWaveShaper();
  { const n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.6) / Math.tanh(1.6) * 0.97; } fbClip.curve = c; fbClip.oversample = '2x'; }
  chain(agcIn, fbAgc, fbComp, fbMake, fbClip, master);
  const micMeter = ac.createAnalyser(); micMeter.fftSize = 1024; agcIn.connect(micMeter);
  const micBuf = new Float32Array(micMeter.fftSize);
  const fb = { env: 0, g: T.agcMaxGain * 0.5, hold: 0 };
  function fallbackAgc(dt) {
    micMeter.getFloatTimeDomainData(micBuf);
    let pk = 0; for (let i = 0; i < micBuf.length; i++) { const a = Math.abs(micBuf[i]); if (a > pk) pk = a; }
    fb.env = Math.max(pk, fb.env * Math.exp(-dt / 0.05));
    const want = clamp(T.agcTarget / Math.max(fb.env, 1e-7), T.agcMinGain, T.agcMaxGain);
    if (want < fb.g) { fb.g = want; fb.hold = T.agcHold; setParam(fbAgc.gain, fb.g, 0.003); }
    else if ((fb.hold -= dt) <= 0) { fb.g = Math.min(want, fb.g * Math.pow(10, T.agcReleaseDb * dt / 20)); setParam(fbAgc.gain, fb.g, 0.05); }
    agcGain = fb.g; agcMin = Math.min(agcMin, fb.g);
  }
  let agcNode = null, agcGain = 1, agcMin = 1;
  const ready = (async () => {
    if (T.forceFallback || !ac.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([MIC_WORKLET_SRC], { type: 'application/javascript' }));
      await ac.audioWorklet.addModule(url);
      agcNode = new AudioWorkletNode(ac, MIC_PROCESSOR, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { target: T.agcTarget, maxGain: T.agcMaxGain, minGain: T.agcMinGain, attack: T.agcAttack, hold: T.agcHold, releaseDb: T.agcReleaseDb, dropThresh: T.dropThresh, codec: T.codec },
      });
      agcNode.port.onmessage = (e) => { if (e.data) { agcGain = e.data.g; agcMin = Math.min(agcMin, e.data.min); } };
      agcIn.disconnect(); agcIn.connect(agcNode); agcNode.connect(master);
      try { fbAgc.disconnect(); micMeter.disconnect(); } catch (e) { /* ignore */ }
      return true;
    } catch (e) {
      console.warn('[audio] AudioWorklet unavailable, using compressor fallback', e);
      return false;
    } finally { if (url) URL.revokeObjectURL(url); }
  })();

  const micSum = gain(1); micSum.connect(agcIn);
  const worldSum = gain(1);
  const hearLP = biq('lowpass', nyq, 0.5), hearGain = gain(1);
  const muffleLP = biq('lowpass', nyq, 0.6), muffleGain = gain(1);
  const micHP1 = biq('highpass', T.micHP, 0.6), micHP2 = biq('highpass', T.micHP * 0.8, 0.55);
  const boxy = biq('peaking', T.boxyHz, T.boxyQ, T.boxyDb), boxy2 = biq('peaking', T.boxyHz * 2.3, 2.2, 1.2);
  const presence = biq('peaking', T.presenceHz, 0.8, T.presenceDb);
  const micLP1 = biq('lowpass', T.micLP, 0.6), micLP2 = biq('lowpass', T.micLP * 1.15, 0.9);
  chain(worldSum, hearLP, hearGain, muffleLP, muffleGain, micHP1, micHP2, boxy, boxy2, presence, micLP1, micLP2, micSum);

  // noise buffers (also used by live layers)
  const white = ac.createBuffer(1, sr * 4, sr), brown = ac.createBuffer(1, sr * 6, sr);
  { const r = makeRng(99), d = white.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
  { const r = makeRng(77), d = brown.getChannelData(0); let b = 0; for (let i = 0; i < d.length; i++) { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = b * 3.5; }
    const fo = Math.floor(sr * 0.05); for (let i = 0; i < fo; i++) { const k = i / fo; d[i] *= k; d[d.length - 1 - i] *= k; } }
  const loop = (buf, rate = 1, offset = 0) => { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, offset); return s; };

  // self-noise of the cheap capsule/preamp (enters before the AGC)
  chain(loop(white, 1, 0.3), biq('highpass', 250, 0.6), biq('lowpass', 9500, 0.6), gain(T.hiss), micSum);

  // buses
  const weapons = gain(1), impacts = gain(1), foley = gain(1), voicesBus = gain(1), revBus = gain(1);
  const ambBus = gain(T.ambience), ambDuck = gain(1);
  for (const b of [weapons, impacts, foley, voicesBus, revBus]) b.connect(worldSum);
  chain(ambBus, ambDuck, worldSum);
  // level detector on the loud buses (drives the ambience duck)
  const loudSum = gain(1), analyser = ac.createAnalyser();
  analyser.fftSize = 512; weapons.connect(loudSum); impacts.connect(loudSum); loudSum.connect(analyser);
  const anaBuf = new Float32Array(analyser.fftSize);

  // zone reverbs
  const IRT = Object.keys(IR_TYPES);
  const sendIn = {}, conv = {}, retGain = {}, retLP = {};
  for (const t of IRT) {
    sendIn[t] = gain(1);
    conv[t] = ac.createConvolver(); conv[t].normalize = false;
    retGain[t] = gain(0); retLP[t] = biq('lowpass', nyq, 0.6);
    chain(sendIn[t], biq('highpass', 70, 0.6), conv[t], retGain[t], retLP[t], revBus);
  }
  const irRc = {};
  function setIR(t, ir) { irRc[t] = ir.rc; conv[t].buffer = toAB({ L: ir.L, R: ir.R }); }
  if (offline) IRT.forEach((t, i) => setIR(t, genIR(sr, t, i + 1)));
  else {
    // the listener's likely first zones first; each IR renders in ~10 idle-time chunks
    ['yard', 'hall', 'room', 'corridor', 'bay', 'under'].filter((t) => IRT.includes(t)).forEach((t, i) => {
      jobs.push((function* () { const it = genIRSteps(sr, t, i + 1); let s = it.next(); while (!s.done) { yield; s = it.next(); } setIR(t, s.value); })());
    });
  }

  // perceptual: tinnitus
  const tinG = gain(0);
  { const o1 = ac.createOscillator(), o2 = ac.createOscillator(); o1.frequency.value = 4120; o2.frequency.value = 4147;
    const g1 = gain(0.5), g2 = gain(0.35); chain(o1, g1, tinG); chain(o2, g2, tinG);
    chain(loop(white, 1, 1.7), biq('bandpass', 4130, 18), gain(2.5), tinG); o1.start(); o2.start(); }
  tinG.connect(percBus);

  // ============================================================== listener
  const lis = new THREE.Vector3(0, 1.6, 0), lisFwd = new THREE.Vector3(0, 0, -1), lisRight = new THREE.Vector3(1, 0, 0), lisUp = new THREE.Vector3(0, 1, 0);
  const rawFwd = new THREE.Vector3(0, 0, -1), prevFwd = new THREE.Vector3(0, 0, -1);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  let lisZone = null, turnRate = 0, yardTrans = 0;
  function setParam(p, v, tc) { if (tc > 0 && !offline) p.setTargetAtTime(v, now(), tc); else p.value = v; }
  function updateListener(dt) {
    const cam = ctx?.camera;
    if (cam) {
      cam.getWorldPosition(lis);
      cam.getWorldDirection(rawFwd);
      const ang = prevFwd.angleTo(rawFwd);
      turnRate += ((dt > 0 ? ang / dt : 0) - turnRate) * (1 - Math.exp(-(dt || 0.016) / 0.08));
      prevFwd.copy(rawFwd);
      // stabilised orientation: low-passed direction (recoil/shake), roll ignored (world up)
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.03) : 1;
      lisFwd.lerp(rawFwd, k).normalize();
      vA.crossVectors(lisFwd, UP);
      if (vA.lengthSq() > 1e-6) lisRight.copy(vA.normalize());
      lisUp.crossVectors(lisRight, lisFwd).normalize();
    }
    const L = ac.listener, tc = 0.015;
    if (L.positionX) {
      setParam(L.positionX, lis.x, tc); setParam(L.positionY, lis.y, tc); setParam(L.positionZ, lis.z, tc);
      setParam(L.forwardX, lisFwd.x, tc); setParam(L.forwardY, lisFwd.y, tc); setParam(L.forwardZ, lisFwd.z, tc);
      setParam(L.upX, lisUp.x, tc); setParam(L.upY, lisUp.y, tc); setParam(L.upZ, lisUp.z, tc);
    } else {
      L.setPosition(lis.x, lis.y, lis.z);
      L.setOrientation(lisFwd.x, lisFwd.y, lisFwd.z, lisUp.x, lisUp.y, lisUp.z);
    }
  }

  // listener-centric transmission into a zone (for reverb returns)
  function zoneTrans(zl, z) {
    if (zl === z) return { g: 1, lp: nyq };
    const h = AC.hops[zl.id]?.[z.id];
    if (h === 1) {
      let f = 0;
      for (const p of AC.adj[zl.id]) {
        if (p.a !== z.id && p.b !== z.id) continue;
        const d = Math.hypot(p.x - lis.x, p.y - lis.y, p.z - lis.z);
        f += (p.area / (p.area + 3)) * clamp(2.5 / Math.max(d, 0.5), 0.12, 1.2);
      }
      f = clamp(f, 0.04, 0.75);
      return { g: f, lp: 1200 + 9000 * f };
    }
    if (h === 2) return { g: 0.045, lp: 900 };
    return { g: 0.02, lp: 600 };
  }
  function updateZones(tc) {
    acoustics();
    lisZone = AC.zoneAt(lis.x, lis.y, lis.z);
    for (const t of IRT) {
      let best = { g: 0, lp: 600 };
      for (const z of Object.values(AC.zones)) {
        if (z.ir !== t) continue;
        const tr = zoneTrans(lisZone, z);
        if (tr.g > best.g) best = tr;
      }
      const rc = irRc[t] || IR_TYPES[t].rc;
      setParam(retGain[t].gain, best.g / rc * T.reverb, tc);
      setParam(retLP[t].frequency, fq(best.lp), tc);
      if (t === 'yard') yardTrans = best.g;
    }
  }

  // ============================================================== occlusion
  const losCache = new Map();
  let losBudget = 12;
  function los(a, b) {
    const f = ctx?.combat?.lineOfSight;
    if (!f) return true;
    if (losBudget <= 0) return null;
    losBudget--;
    try { return !!f(a, b); } catch (e) { return true; }
  }
  /** -> { lp, gain, occ } for a source at pos in zone zS heard by the listener. Cached ~0.3 s. */
  function occlusion(pos, zS) {
    const key = `${Math.round(pos.x * 2)},${Math.round(pos.y * 2)},${Math.round(pos.z * 2)}|${Math.round(lis.x * 2)},${Math.round(lis.y * 2)},${Math.round(lis.z * 2)}`;
    const c = losCache.get(key), t = now();
    if (c && t - c.t < 0.3) return c.v;
    let v;
    vA.copy(lis); vB.set(pos.x, pos.y, pos.z);
    const clear = los(vA, vB);
    if (clear === null) v = zS === lisZone ? { lp: nyq, gain: 1, occ: 0 } : { lp: 900, gain: 0.2, occ: 0.75 };
    else if (clear) v = { lp: nyq, gain: 1, occ: 0 };
    else if (zS === lisZone) v = { lp: 2600, gain: 0.55, occ: 0.35 };
    else {
      const d = vA.distanceTo(vB);
      let best = null;
      const cands = (AC.adj[zS.id] || []).filter((p) => p.a === lisZone.id || p.b === lisZone.id)
        .sort((p, q) => (p.x - lis.x) ** 2 + (p.z - lis.z) ** 2 - (q.x - lis.x) ** 2 - (q.z - lis.z) ** 2).slice(0, 2);
      for (const p of cands) {
        vC.set(p.x, p.y, p.z);
        if (los(vA, vC) !== true) continue;
        const path = vA.distanceTo(vC) + vC.distanceTo(vB);
        const af = p.area / (p.area + 2.5);
        const g = clamp((d / path) * af * 0.9, 0.05, 0.7);
        if (!best || g > best.gain) best = { lp: 1200 + 2200 * af, gain: g, occ: 0.55 };
      }
      if (best) v = best;
      else {
        const h = AC.hops[zS.id]?.[lisZone.id] ?? 9;
        v = h <= 1 ? { lp: 850, gain: 0.18, occ: 0.75 } : h === 2 ? { lp: 600, gain: 0.1, occ: 0.85 } : { lp: 420, gain: 0.06, occ: 1 };
      }
    }
    if (losCache.size > 400) losCache.clear();
    losCache.set(key, { t, v });
    return v;
  }

  // ============================================================== voices
  const CLASS = {
    weapon: { prio: 10, bus: weapons, roll: 1, air: 0.012 },
    flyby: { prio: 9, bus: weapons, roll: 1, air: 0 },
    voice: { prio: 7, bus: voicesBus, roll: 1, air: 0.02 },
    impact: { prio: 6, bus: impacts, roll: 1, air: 0.02 },
    foley: { prio: 5, bus: foley, roll: 1, air: 0.03 },
    step: { prio: 4, bus: foley, roll: 1, air: 0.03 },
    shell: { prio: 3, bus: impacts, roll: 1.1, air: 0.04 },
    amb: { prio: 1, bus: ambBus, roll: 1, air: 0.015 },
    ambFar: { prio: 1, bus: ambBus, roll: 0, air: 0 },
    ui: { prio: 8, bus: uiBus, noSend: true },
    perc: { prio: 8, bus: percBus, noSend: true },
  };
  // Chrome's HRTF kernels tilt the spectrum (measured: about +2 dB at 125-250 Hz, -3 dB at 1-4 kHz, -7 dB at
  // 8 kHz for a frontal source). One compensation EQ per bus restores the balance; rear sources stay darker.
  const spatialIn = new Map();
  function spatialBus(bus) {
    if (T.panningModel !== 'HRTF') return bus;
    let s = spatialIn.get(bus);
    if (!s) {
      s = gain(1);
      chain(s, biq('lowshelf', 220, 0.7, -2), biq('highshelf', 1600, 0.7, 3.5), biq('peaking', 8000, 0.9, 3.5), bus);
      spatialIn.set(bus, s);
    }
    return s;
  }
  const voices = [];
  let nodeCount = 0, dropped = 0;
  function node(v, n) { v.nodes.push(n); nodeCount++; return n; }
  function steal(prio) {
    let victim = null;
    for (const v of voices) {
      if (v.stolen || v.prio > prio) continue;
      if (v.prio === prio && prio < 10) continue;   // equal priority: only shots may steal each other
      if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.born < victim.born)) victim = v;
    }
    if (!victim) return false;
    const t = now();
    try { victim.input.gain.cancelScheduledValues(t); victim.input.gain.setValueAtTime(victim.input.gain.value, t); victim.input.gain.linearRampToValueAtTime(0, t + 0.025); } catch (e) { /* ignore */ }
    for (const s of victim.srcs) { try { s.stop(t + 0.03); } catch (e) { /* not started */ } }
    victim.stolen = true; victim.end = t + 0.04;
    return true;
  }
  /**
   * o: { position, send, nearDist (non-positional send scale), tone (dB lowshelf), startDelay, noDelay, bus, zone }
   */
  function voice(cls, o = {}) {
    const C = CLASS[cls];
    let live = 0; for (const v of voices) if (!v.stolen) live++;
    if (live >= T.maxVoices && !steal(C.prio)) { dropped++; return null; }
    const A = acoustics();
    if (!lisZone) lisZone = A.zoneAt(lis.x, lis.y, lis.z);
    const v = { cls, prio: C.prio, nodes: [], srcs: [], born: now(), t: 0, end: 0, stolen: false, pos: null, zone: lisZone, occ: null, nextOcc: 0, lp: null, og: null, air: C.air, s2: null };
    const input = node(v, gain(1));
    v.input = input;
    let tail = input;
    if (o.tone) { const sh = node(v, biq('lowshelf', 220, 0.7, o.tone)); tail.connect(sh); tail = sh; }
    const pos = validPos(o.position) ? o.position : null;
    let delay = 0;
    if (pos && !o.flat) {
      v.pos = new THREE.Vector3(pos.x, pos.y, pos.z);
      v.d = v.pos.distanceTo(lis);
      v.zone = o.zone || A.zoneAt(v.pos.x, v.pos.y, v.pos.z);
      delay = o.noDelay ? 0 : Math.min(v.d / 343, 0.35);
      v.lp = node(v, biq('lowpass', nyq, 0.5)); v.og = node(v, gain(1));
      const pan = node(v, ac.createPanner());
      pan.panningModel = T.panningModel; pan.distanceModel = 'inverse';
      pan.refDistance = 1; pan.rolloffFactor = C.roll; pan.maxDistance = 400;
      if (pan.positionX) { pan.positionX.value = v.pos.x; pan.positionY.value = v.pos.y; pan.positionZ.value = v.pos.z; }
      else pan.setPosition(v.pos.x, v.pos.y, v.pos.z);
      chain(tail, v.lp, v.og, pan, spatialBus(o.bus || C.bus));
      applyOcclusion(v, 0);
    } else tail.connect(o.bus || C.bus);
    if (!C.noSend) {
      const send = (o.send ?? 1) * T.reverb * (v.pos ? 1 : (o.nearDist ?? 0.4));
      if (send > 0) {
        const s = node(v, gain(send)); input.connect(s); s.connect(sendIn[v.zone.ir]);
        if (v.pos && v.zone !== lisZone && v.zone.ir !== lisZone.ir) {
          v.s2 = node(v, gain(send * 0.35 * (v.occ ? v.occ.gain : 0.2))); input.connect(v.s2); v.s2.connect(sendIn[lisZone.ir]);
        }
      }
    }
    v.t = now() + (offline ? 0 : 0.006) + delay + (o.startDelay || 0);
    v.end = v.t + 0.05;
    voices.push(v);
    return v;
  }
  function applyOcclusion(v, tc) {
    const oc = occlusion(v.pos, v.zone);
    v.occ = oc;
    const air = v.air > 0 ? 20000 / (1 + v.d * v.air) : nyq;
    setParam(v.lp.frequency, fq(Math.min(air, oc.lp)), tc);
    setParam(v.og.gain, oc.gain, tc);
    if (v.s2) setParam(v.s2.gain, 0.35 * oc.gain * T.reverb, tc);
  }
  /** Schedule a buffer on a voice. o: { at, rate, gain, dest } */
  function buf(v, ab, o = {}) {
    if (!v || !ab) return null;
    const s = node(v, ac.createBufferSource());
    s.buffer = ab;
    const rate = o.rate ?? 1; s.playbackRate.value = rate;
    const g = node(v, gain(o.gain ?? 1));
    s.connect(g); g.connect(o.dest || v.input);
    const t = v.t + (o.at || 0);
    s.start(t); v.srcs.push(s);
    const e = t + ab.duration / rate + 0.02;
    if (e > v.end) v.end = e;
    return s;
  }
  function cleanup() {
    const t = now();
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (t > v.end + 0.2) {
        for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* already */ } }
        nodeCount -= v.nodes.length;
        v.nodes.length = 0; v.srcs.length = 0;
        voices[i] = voices[voices.length - 1]; voices.pop();
      }
    }
  }
  let occIdx = 0;
  function refreshOcclusion() {
    if (!voices.length) return;
    const t = now();
    for (let k = 0; k < Math.min(voices.length, 6); k++) {
      occIdx = (occIdx + 1) % voices.length;
      const v = voices[occIdx];
      if (!v.pos || v.stolen || v.end - t < 0.3 || t < v.nextOcc) continue;
      v.nextOcc = t + 0.2;
      v.d = v.pos.distanceTo(lis);
      applyOcclusion(v, 0.06);
    }
  }

  // ============================================================== helpers for sound handlers
  function nearestEnemy(p, maxD = 2.5) {
    const list = ctx?.enemies?.list; if (!list || !p) return null;
    let best = null, bd = maxD * maxD;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]; const q = e?.position; if (!q) continue;
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bd) { bd = d; best = { e, i }; }
    }
    return best;
  }
  const profiles = new Map(), voiceCache = new Map();
  const playerProfile = SV.makeProfile(makeRng(4242), 'player');
  function profileOf(ne) {
    const key = ne ? ne.i : -1;
    if (!profiles.has(key)) profiles.set(key, SV.makeProfile(makeRng(key * 977 + 31)));
    return profiles.get(key);
  }
  /** Per-speaker cache of rendered utterances (keeps CPU bounded, still varied). */
  function utter(key, kind, max, render) {
    const k = key + ':' + kind;
    let c = voiceCache.get(k); if (!c) { c = []; voiceCache.set(k, c); }
    if (c.length < max && (c.length === 0 || R() < 0.6)) { c.push(toAB(render(makeRng((R() * 4294967296) >>> 0)))); return c[c.length - 1]; }
    return c[Math.floor(R() * c.length)];
  }
  const surf = (p) => surfaceAt(acoustics(), p.x, p.y, p.z, debrisSpots);
  const playerFeet = () => ctx?.player?.position || vC.set(lis.x, lis.y - 1.6, lis.z);
  const SMALL = { room: 1, corridor: 1, under: 1 };
  let ring = 0, ringHold = 0;
  let lastShotT = -10, pigeonCool = 0;
  const pendingPigeons = [];
  function pigeonTrigger(zone) {
    if (!zone || (zone.ir !== 'hall' && zone.ir !== 'bay') || pigeonCool > 0) return;
    pigeonCool = rnd(25, 50);
    const b = zone.box;
    pendingPigeons.push({ t: rnd(0.25, 0.9), pos: new THREE.Vector3(rnd(b.x0 + 2, b.x1 - 2), b.y1 - rnd(0.6, 1.2), rnd(b.z0 + 2, b.z1 - 2)) });
  }

  // ============================================================== weapons
  function shotPlayer(o) {
    const z = lisZone || acoustics().zoneAt(lis.x, lis.y, lis.z);
    const v = voice('weapon', { send: 1, nearDist: 0.5 }); if (!v) return;
    const b = pick('blast_player', 6, G.blast('player'));
    const vol = (o.volume ?? 1);
    buf(v, b.ab, { gain: vol * CAL.shotPlayer * vary(1, 0.08), rate: vary(1, 0.02) * (o.pitch ?? 1) });
    const locked = ctx?.player?.ammo === 1;
    const m = locked ? pick('mech_locked', 2, G.mech(true)) : pick('mech', 4, G.mech(false));
    buf(v, m.ab, { gain: vol * CAL.mech * vary(1, 0.15), rate: vary(1, 0.03) });
    // early reflections from the actual room geometry around the camera
    vA.copy(lis).addScaledVector(lisFwd, 0.45).addScaledVector(UP, -0.12);
    const er = renderER(sr, b.fam, vA, lis, lisRight, lisFwd, z, 1);
    if (er) buf(v, toAB(er), { gain: vol * CAL.shotPlayer * 0.5 });
    if (SMALL[z.ir]) ring += 0.2;
    pigeonTrigger(z);
    lastShotT = now();
  }
  function shotEnemy(o) {
    const pos = validPos(o.position) ? o.position : null;
    if (!pos) { shotPlayer({ volume: (o.volume ?? 1) * 0.5 }); return; }
    const A = acoustics();
    const ne = nearestEnemy(pos, 3);
    const rifle = ne?.e?.weaponType === 'rifle';
    const kind = rifle ? 'rifle' : 'pistol';
    const b = pick('blast_' + kind, 5, G.blast(kind));
    const d = lis.distanceTo(pos);
    const zS = A.zoneAt(pos.x, pos.y, pos.z);
    // near-field low boost, mid-distance thinning; far shots lose the top through air and walls
    const shelf = d < 2 ? 3 : d < 6 ? lerp(3, 0, (d - 2) / 4) : d < 18 ? lerp(0, -6, (d - 6) / 12) : d < 35 ? lerp(-6, -1, (d - 18) / 17) : -1;
    const v = voice('weapon', { position: pos, send: 1, tone: shelf, zone: zS }); if (!v) return;
    const gunVar = ne ? 0.92 + 0.16 * ((ne.i * 0.618) % 1) : 1;
    const level = (o.volume ?? 1) * (rifle ? CAL.shotRifle : CAL.shotPistol) * vary(1, 0.1);
    buf(v, b.ab, { gain: level, rate: vary(1, 0.02) * gunVar * (o.pitch ?? 1) });
    // early reflections of the source's room (attenuated + darker when heard from another zone)
    const same = zS === lisZone;
    const trans = same ? 1 : clamp(v.occ.gain * 1.6, 0.03, 0.6);
    const er = renderER(sr, b.fam, pos, lis, lisRight, lisFwd, zS, trans);
    if (er) {
      const eg = node(v, gain(level));
      if (!same) { const lp = node(v, biq('lowpass', Math.max(500, v.occ.lp * 1.3), 0.6)); eg.connect(lp); lp.connect(weapons); } else eg.connect(weapons);
      const s = node(v, ac.createBufferSource()); s.buffer = toAB(er); s.playbackRate.value = gunVar; s.connect(eg); s.start(v.t); v.srcs.push(s);
      v.end = Math.max(v.end, v.t + s.buffer.duration + 0.02);
    }
    if (same && SMALL[zS.ir] && d < 6) ring += 0.1;
    pigeonTrigger(zS);
  }
  function flyby(o) {
    if (!validPos(o.position)) return;
    const rifle = o.weapon === 'rifle';
    const miss = Math.max(0.2, o.missDistance ?? lis.distanceTo(o.position));
    const along = o.along ?? 10;
    const v = voice('flyby', { position: o.position, noDelay: true, send: 0.6, startDelay: Math.min(0.3, along / (rifle ? 850 : 380)) });
    if (!v) return;
    const b = pick(rifle ? 'flyby_rifle' : 'flyby_pistol', 3, G.flyby(rifle ? 'rifle' : 'pistol'));
    // N-wave amplitude falls ~ miss^-3/4; the panner already applies 1/max(miss, 1)
    const g = (o.volume ?? 1) * (rifle ? CAL.crackRifle : CAL.crackPistol) / Math.pow(miss, 0.75) * Math.max(miss, 1);
    buf(v, b.ab, { gain: g, rate: vary(1, 0.05) });
    ring += rifle ? 0.1 : 0.04;
  }
  function ricochet(pos, delay = 0.004) {
    const v = voice('impact', { position: pos, send: 0.8, startDelay: delay }); if (!v) return;
    buf(v, pick('ric', 6, G.ric).ab, { gain: CAL.ricochet * vary(1, 0.3), rate: vary(1, 0.08) });
  }

  // ============================================================== handling / reload
  const handPos = () => vB.copy(lis).addScaledVector(lisFwd, 0.4).addScaledVector(UP, -0.25);
  function handVoice(o, cls = 'foley') {
    // the player's own hands: non-positional (right at the mic); enemies: positional
    return validPos(o.position) ? voice(cls, { position: o.position, send: 1 }) : voice(cls, { send: 1, nearDist: 0.4 });
  }
  function handling(o, what) {
    const v = handVoice(o); if (!v) return;
    const enemy = validPos(o.position);
    const g = (o.volume ?? 1) * (enemy ? 1 : 2.5);   // own hands are ~0.4 m from the mic
    if (what === 'dry') buf(v, pick('dry', 3, G.dry).ab, { gain: g * CAL.dry, rate: vary(1, 0.03) });
    else buf(v, pick('slide', 3, G.slide).ab, { gain: g * CAL.slide, rate: vary(1, 0.03) });
  }
  function reloadOut(o) {
    const enemy = validPos(o.position);
    const v = handVoice(o); if (!v) return;
    const g = (o.volume ?? 1) * (enemy ? 1 : 2.5);
    buf(v, pick('magout', 3, G.magOut).ab, { gain: g * CAL.magOut, rate: vary(1, 0.04) });
    const p = ctx?.player;
    const emptyReload = enemy ? R() < 0.5 : (p ? p.ammo <= 1 : true);
    if (emptyReload) {
      // magazine falls ~1.1 m and clatters on the floor
      const feet = playerFeet(), fy = feet.y;
      const at = enemy ? vC.copy(o.position).setY(o.position.y - 1.05) : vC.copy(feet).addScaledVector(lisFwd, 0.25).setY(fy + 0.03);
      const s = surf(at);
      const dv = voice('foley', { position: at, send: 1, startDelay: rnd(0.42, 0.5) });
      if (dv) buf(dv, pick('magdrop_' + s, 2, G.magDrop(s)).ab, { gain: (o.volume ?? 1) * CAL.magDrop, rate: vary(1, 0.05) });
    } else if (!enemy) {
      buf(v, pick('cloth_s', 3, G.cloth(0.18)).ab, { at: rnd(0.25, 0.35), gain: CAL.cloth * 2 });
      buf(v, pick('gear_1', 4, G.gear(0.5)).ab, { at: rnd(0.3, 0.4), gain: CAL.gear * 1.2 });
    }
  }
  function reloadIn(o) {
    const enemy = validPos(o.position);
    const v = handVoice(o); if (!v) return;
    const g = (o.volume ?? 1) * (enemy ? 1 : 2.5);
    buf(v, pick('magin', 3, G.magIn).ab, { gain: g * CAL.magIn, rate: vary(1, 0.04) });
    const p = ctx?.player;
    if (!enemy && p && p.ammo > 0 && R() < 0.35) buf(v, pick('press', 2, G.press).ab, { at: rnd(0.45, 0.6), gain: g * CAL.pressCheck });
  }

  // ============================================================== Foley
  const STEP_LV = [0.15, 0.5, 1];
  function stepBuf(s, lv) { return pick(`step_${s}_${lv}`, 4, G.step(s, STEP_LV[lv])); }
  function step(o, forced) {
    const p = ctx?.player;
    const feet = playerFeet();
    const s = forced || (() => { const x = surf(feet); return x === 'metal' ? 'concrete' : x; })();
    const lv = p?.sprinting ? 2 : p?.crouching ? 0 : (o.volume ?? 0.5) > 0.7 ? 2 : (o.volume ?? 0.5) < 0.35 ? 0 : 1;
    const v = voice('step', { send: 1, nearDist: 1.2 }); if (!v) return;
    const rate = Math.sqrt(o.pitch ?? 1);
    buf(v, stepBuf(s, lv).ab, { gain: CAL.playerStep * vary(1, 0.12), rate });
    buf(v, pick('gear_' + lv, 4, G.gear(STEP_LV[lv])).ab, { at: rnd(0, 0.03), gain: CAL.gear * vary(1, 0.3) });
    if (lv === 2 || R() < 0.3) buf(v, pick('cloth', 4, G.cloth(0.22)).ab, { at: rnd(0, 0.05), gain: CAL.cloth * (lv === 2 ? 1.4 : 0.7) });
  }
  function enemyStep(e, inten) {
    const pos = vC.set(e.position.x, e.position.y + 0.05, e.position.z);
    const s = surf(pos);
    const lv = inten > 0.75 ? 2 : inten < 0.3 ? 0 : 1;
    const v = voice('step', { position: pos, send: 1 }); if (!v) return;
    buf(v, stepBuf(s, lv).ab, { gain: CAL.step * vary(1, 0.15), rate: vary(1, 0.04) });
    if (R() < 0.6) buf(v, pick('gear_' + lv, 4, G.gear(STEP_LV[lv])).ab, { at: rnd(0, 0.04), gain: CAL.gear * 1.2 });
  }
  function land(o) {
    const s = (() => { const x = surf(playerFeet()); return x; })();
    const v = voice('foley', { send: 1, nearDist: 1.2 }); if (!v) return;
    buf(v, pick('land_' + s, 2, G.land(s)).ab, { gain: (o.volume ?? 1) * CAL.land });
  }
  function shell(o) {
    if (!validPos(o.position)) return;
    const pos = new THREE.Vector3(o.position.x, o.position.y, o.position.z);
    const s = surf(pos);
    const ne = nearestEnemy(pos, 2.5);
    const rifle = ne?.e?.weaponType === 'rifle';
    const key = `shell_${s}${rifle ? '_r' : ''}`;
    const v = voice('shell', { position: pos, send: 1 }); if (!v) return;
    const b = pick(key, 3, G.shell(s, rifle));
    const g = (o.volume ?? 0.5) * CAL.shell * 1.6;
    buf(v, b.ab, { gain: g, rate: vary(1, 0.04) });
    // count-dependent: lands among earlier casings -> clinks against them
    const t = now();
    let near = 0;
    for (const sh of recentShells) if (t - sh.t < 6 && (sh.x - pos.x) ** 2 + (sh.z - pos.z) ** 2 < 1.6) near++;
    if (near >= 1 && R() < Math.min(0.75, 0.25 * near)) buf(v, b.ab, { at: rnd(0.04, 0.15), gain: g * rnd(0.15, 0.35), rate: vary(1.08, 0.05) });
    recentShells.push({ x: pos.x, z: pos.z, t }); if (recentShells.length > 24) recentShells.shift();
  }
  const recentShells = [];

  // ============================================================== impacts
  function objectAt(p) {
    let best = null, bv = Infinity;
    for (const s of layoutSolids) {
      const m = 0.08;
      if (p.x < s.min[0] - m || p.x > s.max[0] + m || p.y < s.min[1] - m || p.y > s.max[1] + m || p.z < s.min[2] - m || p.z > s.max[2] + m) continue;
      const vol = (s.max[0] - s.min[0]) * (s.max[1] - s.min[1]) * (s.max[2] - s.min[2]);
      if (vol < bv) { bv = vol; best = s; }
    }
    return best ? { s: best, size: Math.cbrt(bv) } : null;
  }
  function impact(kind, o) {
    if (!validPos(o.position)) return;
    acoustics();
    const v = voice('impact', { position: o.position, send: 1 }); if (!v) return;
    const vol = (o.volume ?? 1);
    const rate = vary(1, 0.05);
    if (kind === 'metal') {
      const ob = objectAt(o.position);
      const thin = !ob || ob.s.kind === 'leaf' || ob.s.kind === 'roof' || ob.s.kind === 'wall';
      const size = ob ? (ob.s.kind === 'roof' ? 6 : ob.size) : 1.5;
      const cls = size < 0.5 ? 's' : size < 1.4 ? 'm' : size < 3 ? 'l' : 'xl';
      const rep = { s: 0.35, m: 0.9, l: 2.2, xl: 5 }[cls];
      buf(v, pick(`imp_metal_${cls}${thin ? 't' : ''}`, 3, G.metal(rep, thin)).ab, { gain: vol * CAL.impMetal * vary(1, 0.15), rate });
    } else if (kind === 'wood') {
      const ob = objectAt(o.position);
      const hollow = !ob || ob.size < 1.2;
      buf(v, pick(`imp_wood_${hollow ? 'h' : 's'}`, 3, G.wood(hollow)).ab, { gain: vol * CAL.impWood * vary(1, 0.15), rate });
    } else if (kind === 'glass') {
      buf(v, pick('imp_glass', 3, G.imp.glass).ab, { gain: vol * CAL.impGlass * vary(1, 0.15), rate });
    } else if (kind === 'flesh') {
      buf(v, pick('imp_flesh', 5, G.imp.flesh).ab, { gain: vol * CAL.impFlesh * vary(1, 0.15), rate });
      // a surviving enemy grunts
      const ne = nearestEnemy(o.position, 1.5);
      if (ne && ne.e.alive && R() < 0.65) enemyVoice(ne, 'grunt', vC.copy(o.position), rnd(0.06, 0.2));
    } else {
      buf(v, pick('imp_concrete', 6, G.imp.concrete).ab, { gain: vol * CAL.impConcrete * vary(1, 0.15), rate });
    }
    if (kind === 'concrete' || kind === 'metal') {
      const near = lis.distanceTo(o.position) < 10;
      const p = (o.from === 'enemy' && near ? 0.3 : 0.08) * (kind === 'metal' ? 1.7 : 1);
      if (R() < p) ricochet(o.position);
    }
  }

  // ============================================================== voices / bodies
  function enemyVoice(ne, kind, pos, delay = 0) {
    const prof = profileOf(ne);
    const ab = kind === 'shout' ? utter(ne.i, 'shout', 4, (r) => SV.genShout(sr, r, prof))
      : kind === 'death' ? utter(ne.i, 'death', 2, (r) => SV.genDeathVoice(sr, r, prof))
        : utter(ne.i, 'grunt', 3, (r) => SV.genGrunt(sr, r, prof, true));
    const v = voice('voice', { position: pos, send: 1, startDelay: delay }); if (!v) return;
    const cal = kind === 'shout' ? CAL.shout : kind === 'death' ? CAL.deathVoice : CAL.grunt;
    buf(v, ab, { gain: cal * vary(1, 0.15) });
  }
  function shout(o) {
    const pos = validPos(o.position) ? o.position : null; if (!pos) return;
    enemyVoice(nearestEnemy(pos, 3) || { i: 0, e: null }, 'shout', pos);
  }
  function hurt(o) {
    if (validPos(o.position)) { enemyVoice(nearestEnemy(o.position, 3) || { i: 0, e: null }, 'grunt', o.position); return; }
    const v = voice('voice', { send: 1, nearDist: 0.3 }); if (!v) return;
    buf(v, pick('imp_flesh', 5, G.imp.flesh).ab, { gain: CAL.playerHit * (o.volume ?? 1), rate: 0.8 });
    buf(v, utter(-1, 'grunt', 4, (r) => SV.genGrunt(sr, r, playerProfile, true)), { at: rnd(0.03, 0.08), gain: CAL.playerVoice * (o.volume ?? 1) });
    ring += 0.55;
  }
  function death(o) {
    if (validPos(o.position)) { enemyVoice(nearestEnemy(o.position, 3) || { i: 0, e: null }, 'death', o.position); return; }
    const v = voice('voice', { send: 1, nearDist: 0.3 }); if (!v) return;
    buf(v, utter(-1, 'death', 2, (r) => SV.genDeathVoice(sr, r, playerProfile)), { gain: CAL.playerVoice * 0.8 });
    ring += 0.3;
  }
  const recentFalls = [];
  function bodyFall(o) {
    if (validPos(o.position)) {
      const t = now(), p = o.position;
      let sub = false;
      for (const f of recentFalls) if (t - f.t < 0.7 && (f.x - p.x) ** 2 + (f.z - p.z) ** 2 < 3.2) sub = true;
      recentFalls.push({ x: p.x, z: p.z, t }); if (recentFalls.length > 12) recentFalls.shift();
      const s = surf(p) === 'metal' ? 'metal' : 'concrete';
      const v = voice('foley', { position: p, send: 1 }); if (!v) return;
      if (sub) buf(v, pick('imp_flesh', 5, G.imp.flesh).ab, { gain: CAL.bodyFall * 0.6 * (o.volume ?? 1), rate: 0.6 });   // secondary ragdoll contact
      else buf(v, pick('bodyfall_' + s, 3, G.bodyFall(s)).ab, { gain: CAL.bodyFall * (o.volume ?? 1), rate: vary(1, 0.05) });
      return;
    }
    // the player's camera hits the floor
    const v = voice('foley', { send: 1, nearDist: 0.3 }); if (!v) return;
    buf(v, pick('camdrop', 2, G.camDrop).ab, { gain: CAL.camDrop * (o.volume ?? 1) });
    buf(v, pick('bodyfall_concrete', 3, G.bodyFall('concrete')).ab, { at: 0.01, gain: CAL.bodyFall * 2 });
    if (ctx?.player && !ctx.player.alive) setMuffleStage(1);
  }
  function radio(o) {
    const v = voice('voice', { send: 0.5, nearDist: 0.2 }); if (!v) return;
    buf(v, pick('radio', 3, G.radio).ab, { gain: CAL.radio * (o.volume ?? 1) });
  }
  function uiClick(o) {
    if (ctx?.game?.state === 'playing') {   // flashlight switch on the vest
      const v = voice('foley', { send: 1, nearDist: 0.3 }); if (!v) return;
      buf(v, pick('switch', 2, G.switch).ab, { gain: CAL.switch * 3 * (o.volume ?? 1) / 0.35 });
      return;
    }
    const v = voice('ui', {}); if (!v) return;
    buf(v, pick('ui', 2, G.ui).ab, { gain: CAL.ui * (o.volume ?? 1) });
  }

  const HANDLERS = {
    shot: shotPlayer, shot_enemy: shotEnemy, bullet_flyby: flyby, ricochet: (o) => validPos(o.position) && ricochet(o.position, 0),
    dry: (o) => handling(o, 'dry'), slide: (o) => handling(o, 'slide'), reload_out: reloadOut, reload_in: reloadIn,
    step_concrete: (o) => step(o, null), step_metal: (o) => step(o, 'metal'), land,
    // optional: footsteps of someone else at a position (enemy steps are otherwise derived from their motion)
    step_other: (o) => validPos(o.position) && enemyStep({ position: o.position }, o.intensity ?? 0.5),
    impact_concrete: (o) => impact('concrete', o), impact_metal: (o) => impact('metal', o), impact_wood: (o) => impact('wood', o),
    impact_glass: (o) => impact('glass', o), impact_flesh: (o) => impact('flesh', o),
    hurt, death, body_fall: bodyFall, shell, shout, radio, ui_click: uiClick,
  };

  // ============================================================== ambience bed
  const ambOn = opts.ambience !== false;
  const amb = {
    t: 0, gust: 0.5, gustA: null, gustB: null, timers: { drip: rnd(1, 4), creak: rnd(4, 10), bird: rnd(2, 6), car: rnd(6, 20), train: rnd(90, 180), siren: rnd(120, 260), pigeons: rnd(40, 90), coo: rnd(20, 60), bang: 0, flicker: rnd(2, 6), buffet: 0 },
    layers: null, emit: { hum: [], whistle: [] }, outdoor: 1,
  };
  {
    const r = makeRng(555); const nA = 2400, nB = 2400; const a = new Float32Array(nA), b = new Float32Array(nB);
    for (let i = 0; i < nA; i++) a[i] = r(); for (let i = 0; i < nB; i++) b[i] = r();
    const sample = (arr, x) => { const i = Math.floor(x) % arr.length, f = x - Math.floor(x), j = (i + 1) % arr.length; const s = f * f * (3 - 2 * f); return arr[i] + (arr[j] - arr[i]) * s; };
    amb.gustA = (t) => sample(a, t * 0.12); amb.gustB = (t) => sample(b, t * 0.9);
  }
  function startAmbience() {
    const L = {};
    const mk = (src, ...ns) => { chain(src, ...ns); return ns; };
    // outdoor wind: two decorrelated low layers + debris rustle
    L.wind = [-0.7, 0.7].map((pan, i) => {
      const lp = biq('lowpass', 500, 0.5), g = gain(0), sp = ac.createStereoPanner(); sp.pan.value = pan;
      mk(loop(brown, 0.9 + i * 0.13, i * 1.7), lp, g, sp, ambBus); return { lp, g };
    });
    L.rustle = (() => { const bp = biq('bandpass', 2400, 0.6), g = gain(0); mk(loop(white, 0.7, 0.9), bp, g, ambBus); return { bp, g }; })();
    L.traffic = (() => { const lp = biq('lowpass', 190, 0.6), g = gain(0); mk(loop(brown, 0.55, 2.2), lp, g, ambBus); return { lp, g }; })();
    L.room = (() => { const lp = biq('lowpass', 320, 0.5), lp2 = biq('lowpass', 320, 0.5), g = gain(0); mk(loop(white, 0.6, 3.1), lp, lp2, g, ambBus); return { g }; })();
    // wind buffeting on the microphone itself (outdoors) and clothing/handling noise (pre-mic)
    L.buffet = (() => { const lp = biq('lowpass', 170, 0.7), g = gain(0); mk(loop(brown, 1.6, 0.4), lp, g, foley); return { g }; })();
    L.handling = (() => { const bp = biq('bandpass', 1500, 0.6), lp = biq('lowpass', 4500, 0.7), g = gain(0); mk(loop(white, 0.8, 2.6), bp, lp, g, foley); return { g }; })();
    // positional emitters: whistle through broken windows, fixture hum
    for (let i = 0; i < 2; i++) {
      const bp = biq('bandpass', 900, 9), bp2 = biq('bandpass', 1350, 12), g = gain(0), pan = ac.createPanner();
      pan.panningModel = T.panningModel; pan.distanceModel = 'inverse'; pan.refDistance = 1.5; pan.rolloffFactor = 1.2; pan.maxDistance = 60;
      const src = loop(white, 1, i * 2.1); src.connect(bp); src.connect(bp2); bp.connect(g); bp2.connect(g); g.connect(pan); pan.connect(spatialBus(ambBus));
      amb.emit.whistle.push({ bp, bp2, g, pan, at: null, base: 0.7 + 0.3 * i });
    }
    for (let i = 0; i < 3; i++) {
      const g = gain(0), lp = biq('lowpass', 3000, 0.6), pan = ac.createPanner();
      pan.panningModel = T.panningModel; pan.distanceModel = 'inverse'; pan.refDistance = 1; pan.rolloffFactor = 1.5; pan.maxDistance = 40;
      chain(g, lp, pan, spatialBus(ambBus));
      amb.emit.hum.push({ g, pan, src: null, at: null, flick: false });
    }
    amb.layers = L;
    jobs.push(() => {
      const hb = toAB(SF.genHumLoop(sr, makeRng(808)));
      for (const e of amb.emit.hum) { const s = ac.createBufferSource(); s.buffer = hb; s.loop = true; s.playbackRate.value = 1 + rnd(-0.003, 0.003); s.connect(e.g); s.start(now() + 0.05, R()); e.src = s; }
    });
  }
  const fixtures = Array.isArray(LAYOUT.FIXTURES) ? LAYOUT.FIXTURES.filter((f) => f.state !== 'dead').map((f) => ({ p: new THREE.Vector3(f.pos[0], f.pos[1], f.pos[2]), flick: f.state === 'flicker' })) : [];
  function setPanPos(pan, p) { if (pan.positionX) { setParam(pan.positionX, p.x, 0.05); setParam(pan.positionY, p.y, 0.05); setParam(pan.positionZ, p.z, 0.05); } else pan.setPosition(p.x, p.y, p.z); }
  function randomOutside(dMin, dMax, yMin, yMax) {
    const F = LAYOUT.FOOTPRINT || { min: [-24, -18], max: [20, 16] };
    for (let k = 0; k < 8; k++) {
      const a = R() * Math.PI * 2, d = rnd(dMin, dMax);
      const x = lis.x + Math.cos(a) * d, z = lis.z + Math.sin(a) * d;
      if (x > F.min[0] - 1 && x < F.max[0] + 1 && z > F.min[1] - 1 && z < F.max[1] + 1) continue;
      return new THREE.Vector3(x, rnd(yMin, yMax), z);
    }
    return new THREE.Vector3(lis.x + rnd(-10, 10), rnd(yMin, yMax), 40);
  }
  function ambEvent(key, cls, pos, gainV, opt = {}) {
    const v = voice(cls, { position: pos, send: opt.send ?? 1, bus: ambBus });
    if (v) buf(v, pick(key, opt.count ?? 3, opt.gen).ab, { gain: gainV * T.ambience, rate: opt.rate ?? vary(1, 0.05) });
  }
  function updateAmbience(dt) {
    if (!amb.layers) return;
    const A = acoustics(), L = amb.layers, t = (amb.t += dt), tc = 0.25;
    // gust model: slow swell plus faster turbulence, occasional strong gusts
    const slow = amb.gustA(t), fast = amb.gustB(t);
    amb.gust = clamp(0.25 + 0.55 * slow + 0.35 * (fast - 0.5) * slow, 0, 1);
    const g = amb.gust;
    const out = lisZone?.outdoor ? 1 : clamp(yardTrans * 1.4, 0.06, 0.5);
    amb.outdoor += (out - amb.outdoor) * (1 - Math.exp(-dt / 0.6));
    const o = amb.outdoor;
    for (const w of L.wind) { setParam(w.g.gain, CAL.wind * (0.3 + 0.9 * g) * lerp(0.15, 1, o), tc); setParam(w.lp.frequency, lerp(220, 420, o) + 700 * g * o, tc); }
    setParam(L.rustle.g.gain, CAL.wind * 0.12 * smooth(0.45, 0.9, g) * o, tc);
    setParam(L.traffic.g.gain, CAL.traffic * lerp(0.35, 1, o), 0.5);
    setParam(L.room.g.gain, CAL.roomTone * (lisZone?.outdoor ? 0.2 : lisZone?.ir === 'hall' || lisZone?.ir === 'bay' ? 1.3 : 0.7), 0.5);
    // buffeting: chaotic bursts on the capsule when outdoors in gusts
    if ((amb.timers.buffet -= dt) <= 0) {
      amb.timers.buffet = rnd(0.05, 0.18);
      const b = lisZone?.outdoor ? smooth(0.45, 0.85, g) * (R() < 0.6 ? rnd(0.3, 1) : 0.05) : 0;
      setParam(L.buffet.g.gain, CAL.buffet * b, 0.04);
    }
    // whistle emitters at the nearest broken windows
    const wins = A.windows.slice().sort((a, b) => (a.x - lis.x) ** 2 + (a.z - lis.z) ** 2 - (b.x - lis.x) ** 2 - (b.z - lis.z) ** 2);
    amb.emit.whistle.forEach((e, i) => {
      const w = wins[i]; if (!w) return;
      if (e.at !== w) { e.at = w; setPanPos(e.pan, vA.set(w.x, w.y, w.z)); }
      const k = smooth(0.35, 0.95, g) * (w.glass === 'broken' ? 1 : 0.6);
      setParam(e.g.gain, CAL.whistle * k * (lisZone?.outdoor ? 0.4 : 1), 0.3);
      setParam(e.bp.frequency, (650 + 450 * g) * e.base, 0.3); setParam(e.bp2.frequency, (980 + 600 * g) * e.base, 0.3);
    });
    // fixture hum: three nearest running tubes
    if (fixtures.length) {
      const fs = fixtures.slice().sort((a, b) => a.p.distanceToSquared(lis) - b.p.distanceToSquared(lis));
      amb.emit.hum.forEach((e, i) => {
        const f = fs[i]; if (!f) return;
        if (e.at !== f) { e.at = f; e.flick = f.flick; setPanPos(e.pan, f.p); }
        const occ = occlusionFast(f.p);
        const base = CAL.hum * occ * (e.flick ? (R() < 0.15 ? rnd(0, 0.4) : rnd(0.7, 1.2)) : 1);
        setParam(e.g.gain, base, e.flick ? 0.02 : 0.2);
      });
    }
    // events
    const tm = amb.timers;
    if ((tm.drip -= dt) <= 0) {
      tm.drip = rnd(0.8, 4.5);
      let best = null, bd = 18 * 18;
      for (const l of leaks) { const d = l.distanceToSquared(lis); if (d < bd) { bd = d; best = l; } }
      if (best) {
        const n = R() < 0.3 ? 2 : 1;
        for (let k = 0; k < n; k++) ambEvent('drip', 'amb', best, CAL.drip * rnd(0.5, 1.2), { gen: G.drip, count: 6, rate: vary(1, 0.1) });
      }
    }
    if ((tm.creak -= dt) <= 0) {
      tm.creak = rnd(6, 16);
      const z = lisZone && !lisZone.outdoor ? lisZone : A.zones.hall; const b = z.box;
      const metal = z.ir !== 'room' || R() < 0.4;
      ambEvent(metal ? 'creak_m' : 'creak_w', 'amb', vA.set(rnd(b.x0, b.x1), b.y1 - 0.4, rnd(b.z0, b.z1)), CAL.creak * rnd(0.4, 1), { gen: G.creak(metal) });
    }
    if ((tm.bang -= dt) <= 0 && g > 0.78) {
      tm.bang = rnd(30, 70);
      const hole = A.portals.filter((p) => p.kind === 'roof');
      const h = hole.length ? hole[Math.floor(R() * hole.length)] : null;
      if (h) ambEvent('bang', 'amb', vA.set(h.x + rnd(-1, 1), h.y, h.z + rnd(-1, 1)), CAL.bang * rnd(0.5, 1), { gen: G.bang, count: 2 });
    }
    if ((tm.bird -= dt) <= 0) {
      tm.bird = rnd(4, 13) * (t - lastShotT < 20 ? 2.5 : 1);
      const crow = R() < 0.15;
      ambEvent(crow ? 'crow' : 'bird', 'amb', randomOutside(14, 40, 3, 12), crow ? CAL.crow : CAL.bird * rnd(0.4, 1), { gen: G.bird(crow), count: crow ? 2 : 6, send: 0.5 });
    }
    if ((tm.car -= dt) <= 0) { tm.car = rnd(14, 38); ambEvent('car', 'ambFar', vA.set(lis.x + rnd(-40, 40), 1, 46), CAL.car * rnd(0.5, 1), { gen: G.car, count: 2, send: 0 }); }
    if ((tm.train -= dt) <= 0) { tm.train = rnd(150, 300); ambEvent('train', 'ambFar', vA.set(rnd(-150, 150), 2, -140), CAL.train, { gen: G.train, count: 1, send: 0 }); }
    if ((tm.siren -= dt) <= 0) { tm.siren = rnd(180, 400); ambEvent('siren', 'ambFar', randomOutside(150, 250, 5, 10), CAL.siren, { gen: G.siren, count: 1, send: 0 }); }
    if ((tm.pigeons -= dt) <= 0) { tm.pigeons = rnd(50, 120); pigeonCool = 0; pigeonTrigger(R() < 0.6 ? A.zones.hall : A.zones.bay || A.zones.hall); }
    if ((tm.coo -= dt) <= 0) {
      tm.coo = rnd(25, 70);
      const z = A.zones.hall, b = z.box;
      if (t - lastShotT > 30) ambEvent('coo', 'amb', vA.set(rnd(b.x0, b.x1), b.y1 - 0.5, rnd(b.z0, b.z1)), CAL.coo, { gen: G.coo, count: 2 });
    }
    if ((tm.flicker -= dt) <= 0) {
      tm.flicker = rnd(1.5, 6);
      const f = amb.emit.hum.find((e) => e.flick && e.at);
      if (f && f.at.p.distanceTo(lis) < 14) ambEvent('flicker', 'amb', f.at.p, CAL.flicker * rnd(0.4, 1), { gen: G.flicker, count: 4, send: 0.6 });
    }
    if (pigeonCool > 0) pigeonCool -= dt;
    for (let i = pendingPigeons.length - 1; i >= 0; i--) {
      const p = pendingPigeons[i];
      if ((p.t -= dt) <= 0) { pendingPigeons.splice(i, 1); ambEvent('pigeons', 'amb', p.pos, CAL.pigeons, { gen: G.pigeons, count: 3 }); }
    }
  }
  /** Cheap occlusion estimate for continuous emitters (uses the shared cache). */
  function occlusionFast(p) {
    const z = acoustics().zoneAt(p.x, p.y, p.z);
    const o = occlusion(p, z);
    return o.gain;
  }

  // ============================================================== player state monitors
  const ps = { exert: 0, nextBreath: 2, inhale: true, nextHeart: 0, crouch: false, aim: false, rattleCool: 0, wasAlive: true };
  const enemyTrack = new Map();
  function updatePlayer(dt, playing) {
    const p = ctx?.player;
    if (!p || !playing) {
      if (amb.layers) setParam(amb.layers.handling.g.gain, 0, 0.1);
      return;
    }
    const alive = p.alive !== false;
    const speed = p.velocity ? Math.hypot(p.velocity.x, p.velocity.z) : 0;
    // clothing / handling noise from turning and moving
    if (amb.layers) {
      const k = alive ? smooth(1.2, 7, turnRate) * 0.9 + clamp(speed / 6, 0, 1) * 0.35 : 0;
      setParam(amb.layers.handling.g.gain, CAL.handling * k, 0.06);
    }
    if (alive && (ps.rattleCool -= dt) <= 0 && turnRate > 5.5) {
      ps.rattleCool = rnd(0.35, 0.7);
      const v = voice('foley', { send: 0.6, nearDist: 0.4 });
      if (v) buf(v, pick('gear_1', 4, G.gear(0.5)).ab, { gain: CAL.gear * rnd(0.4, 0.9) });
    }
    if (alive && (!!p.crouching !== ps.crouch || !!p.isAiming !== ps.aim)) {
      const big = !!p.crouching !== ps.crouch;
      ps.crouch = !!p.crouching; ps.aim = !!p.isAiming;
      const v = voice('foley', { send: 0.6, nearDist: 0.4 });
      if (v) {
        buf(v, pick('cloth', 4, G.cloth(0.22)).ab, { gain: CAL.cloth * (big ? 1.6 : 0.6) });
        if (big) buf(v, pick('gear_0', 4, G.gear(0.15)).ab, { at: 0.05, gain: CAL.gear });
      }
    }
    // exertion and breathing
    ps.exert = clamp(ps.exert + (p.sprinting ? dt * 0.16 : -dt * 0.045), 0, 1);
    if (alive && (ps.nextBreath -= dt) <= 0) {
      const e = ps.exert, lv = e < 0.33 ? 0 : e < 0.66 ? 1 : 2, eff = [0.1, 0.5, 0.95][lv];
      const key = (ps.inhale ? 'bi_' : 'be_') + lv;
      const b = pick(key, 3, G.breath(ps.inhale, eff));
      const v = voice('foley', { send: 0.3, nearDist: 0.3 });
      if (v) buf(v, b.ab, { gain: CAL.breath * lerp(0.12, 1, e) * vary(1, 0.12) });
      const period = lerp(4.2, 1.05, e);
      ps.nextBreath = ps.inhale ? b.ab.duration * 0.95 + rnd(0.02, 0.12) : Math.max(0.15, period - b.ab.duration * 1.9) * rnd(0.85, 1.2);
      ps.inhale = !ps.inhale;
    }
    // low health: heartbeat, narrowed hearing
    const hp = Number.isFinite(p.health) ? p.health : 100;
    const h = alive ? clamp(1 - hp / 45, 0, 1) : 0;
    setParam(hearLP.frequency, fq(lerp(nyq, 1700, h * h * 0.6 + h * 0.4)), 0.3);
    setParam(hearGain.gain, 1 - 0.3 * h, 0.3);
    if (h > 0 && (ps.nextHeart -= dt) <= 0) {
      ps.nextHeart = 60 / (72 + 55 * h + 25 * ps.exert);
      const v = voice('perc', {});
      if (v) buf(v, pick('heart', 2, G.heart).ab, { gain: CAL.heart * lerp(0.35, 1, h) });
    }
    // enemy footsteps (derived from their motion)
    const list = ctx?.enemies?.list;
    if (list && dt > 0) {
      for (const e of list) {
        if (!e?.position) continue;
        let st = enemyTrack.get(e);
        if (!st) { st = { x: e.position.x, z: e.position.z, acc: rnd(0, 0.5) }; enemyTrack.set(e, st); continue; }
        const dx = e.position.x - st.x, dz = e.position.z - st.z, dd = Math.hypot(dx, dz);
        st.x = e.position.x; st.z = e.position.z;
        if (!e.alive || dd > 1.5) { st.acc = 0; continue; }
        const sp = dd / dt;
        if (sp < 0.35) continue;
        st.acc += dd;
        const stride = sp > 3 ? 0.9 : 0.7;
        if (st.acc >= stride) {
          st.acc -= stride;
          if (e.position.distanceToSquared(lis) < 35 * 35) enemyStep(e, clamp((sp - 0.6) / 3.5, 0.1, 1));
        }
      }
    }
  }

  // ============================================================== death / muffle
  let muffleStage = 0;
  function setMuffleStage(s) {
    muffleStage = s;
    const f = s === 0 ? nyq : s === 1 ? 1300 : T.muffledHz;
    const g = s === 0 ? 1 : s === 1 ? 0.85 : 0.62;
    const tc = s === 0 ? 0.12 : s === 1 ? 0.03 : 0.5;
    setParam(muffleLP.frequency, fq(f), tc);
    setParam(muffleGain.gain, g, tc);
  }
  function setMuffled(b, instant) {
    if (b) { setMuffleStage(2); ringHold = 0.45; ring = Math.max(ring, 0.6); }
    else { setMuffleStage(0); ringHold = 0; ring = 0; setParam(tinG.gain, 0, instant ? 0 : 0.1); ps.exert = 0; }
  }
  function setMasterVolume(v) { setParam(master.gain, v, 0.03); }

  // ============================================================== frame update
  let zoneT = 0;
  if (ambOn) startAmbience();
  function update(dt, running = true) {
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    losBudget = 12;
    updateListener(dt);
    if ((zoneT -= dt) <= 0) { zoneT = 0.1; updateZones(offline ? 0 : 0.25); }
    cleanup();
    if (!running) return;
    refreshOcclusion();
    if (!agcNode) fallbackAgc(dt);
    // ambience duck follows the measured level of the weapon/impact buses
    analyser.getFloatTimeDomainData(anaBuf);
    let pk = 0; for (let i = 0; i < anaBuf.length; i++) { const a = Math.abs(anaBuf[i]); if (a > pk) pk = a; }
    const duckT = Math.max(0.15, 1 / (1 + pk * 6));
    if (duckT < ambDuck.gain.value - 0.02) setParam(ambDuck.gain, duckT, 0.015);
    else setParam(ambDuck.gain, duckT, 1.4);
    const playing = ctx?.game ? ctx.game.state === 'playing' : true;
    if (ambOn) updateAmbience(dt);
    updatePlayer(dt, playing);
    // tinnitus
    ring = Math.min(1, ring);
    ring = Math.max(ringHold, ring * Math.exp(-dt / 3.2));
    setParam(tinG.gain, CAL.tinnitus * Math.pow(ring, 1.3), 0.08);
    if (!offline) { if (ric) kickIdle(); else pump(T.idleBudgetMs); }
  }

  function play(name, o) {
    const fn = HANDLERS[name];
    if (!fn) return;
    try { fn(o || {}); } catch (e) { console.warn('[audio] ' + name, e); }
  }

  // pre-render what the first seconds need (synchronously: ~20 ms), the rest in idle time
  pick('blast_player', 6, G.blast('player')); pick('blast_pistol', 5, G.blast('pistol')); pick('blast_rifle', 5, G.blast('rifle'));
  pick('mech', 4, G.mech(false));
  if (!offline) {
    jobs.unshift(() => pick('radio', 3, G.radio));
    for (const s of ['asphalt', 'concrete', 'gravel']) for (const lv of [1, 2, 0]) prewarm(`step_${s}_${lv}`, 4, G.step(s, STEP_LV[lv]));
    for (const lv of [0, 1, 2]) prewarm('gear_' + lv, 4, G.gear(STEP_LV[lv]));
    prewarm('cloth', 4, G.cloth(0.22));
    prewarm('imp_concrete', 6, G.imp.concrete); prewarm('imp_flesh', 5, G.imp.flesh);
    prewarm('magout', 3, G.magOut); prewarm('magin', 3, G.magIn); prewarm('dry', 3, G.dry); prewarm('slide', 3, G.slide);
    prewarm('shell_asphalt', 3, G.shell('asphalt', false)); prewarm('shell_concrete', 3, G.shell('concrete', false));
    prewarm('bi_0', 3, G.breath(true, 0.1)); prewarm('be_0', 3, G.breath(false, 0.1));
    for (let i = 0; i < 10; i++) {
      jobs.push(() => {
        const prof = profileOf({ i });
        for (const [kind, fn] of [['shout', (r) => SV.genShout(sr, r, prof)], ['grunt', (r) => SV.genGrunt(sr, r, prof, true)]]) {
          const k = i + ':' + kind; const c = voiceCache.get(k) || []; voiceCache.set(k, c);
          if (c.length < 2) c.push(toAB(fn(makeRng((R() * 4294967296) >>> 0))));
        }
      });
    }
    for (const s of ['metal', 'lino']) for (const lv of [1, 2, 0]) prewarm(`step_${s}_${lv}`, 4, G.step(s, STEP_LV[lv]));
    prewarm('imp_metal_m', 3, G.metal(0.9, false)); prewarm('imp_wood_h', 3, G.wood(true)); prewarm('imp_glass', 3, G.imp.glass);
    prewarm('bodyfall_concrete', 3, G.bodyFall('concrete'));
    prewarm('drip', 6, G.drip); prewarm('bird', 6, G.bird(false)); prewarm('creak_m', 3, G.creak(true));
    prewarm('car', 2, G.car); prewarm('pigeons', 3, G.pigeons);
  }

  return {
    play, update, setMuffled, setMasterVolume, ready,
    get voiceCount() { return voices.length; },
    /** Render every queued variant now (harness / tests). */
    warm() { while (jobs.length) pump(1000); },
    stats() {
      return { voices: voices.length, nodes: nodeCount, jobs: jobs.length, banks: banks.size, dropped, agc: agcGain, agcMin, worklet: !!agcNode,
        zone: lisZone?.id, ring, outdoor: amb.outdoor, gust: amb.gust, exert: ps.exert };
    },
    resetAgcMin() { agcMin = 99; },
    get listener() { return { pos: lis, fwd: lisFwd, zone: lisZone }; },
    nodes: { master, worldSum, micSum, agcIn, weapons, impacts, foley, voicesBus, ambBus, revBus, percBus, uiBus, sendIn, retGain },
    get agcNode() { return agcNode; },
    debug: { pick, G, toAB, acoustics, renderER, CAL },
  };
}
