import * as THREE from 'three';

// Fully procedural WebAudio for SECTOR 9. No audio files.
//
// Graph:
//   voice layers -> v.input -> [lowpass] -> v.out -> [PannerNode] -> dryBus ----------\
//                                              \-> send (distance scaled) -> reverb ---+-> micIn
//   ambience (loops + positional events) -> ambBus (ducked) ---------------------------/
//   micIn -> HP 150 x2 -> LP 7k x2 -> presence peak -> soft clip -> compressor -> makeup
//         -> AGC pump gain -> muffle LP -> master -> limiter -> destination
//   hiss -> compressor input;  ui sounds -> uiBus -> master (bypass mic colouring)

// ---- Tunables -------------------------------------------------------------------------------
export const AUDIO_TUNING = {
  maxVoices: 40,
  masterVolume: 0.8,          // default, overridden by setMasterVolume
  shotGain: 1.05,             // player pistol (peaks deliberately drive the clipper)
  enemyShotGain: 0.9,
  stepGain: 0.55,
  reverbReturn: 0.68,         // wet level of the hall
  reverbSeconds: 2.8,         // impulse response length (RT60-ish)
  bandLow: 85,                // mic band-limit (Hz)
  bandHigh: 7000,
  clipDrive: 1.7,             // pre-gain into the soft clipper
  compThreshold: -20, compRatio: 8, compAttack: 0.003, compRelease: 0.5,
  makeup: 1.5,
  duckDepth: 0.6,             // AGC pump depth on the whole mix after a close shot
  ambDuckDepth: 0.8,          // extra duck depth on the ambience bed
  duckRecover: 1.0,           // seconds to (mostly) recover
  hiss: 0.0035,
  ambience: 1.0,              // ambience bed level multiplier
  muffledHz: 420,
  refDistance: 2, rolloff: 1.1, maxDistance: 120,
  panningModel: 'HRTF',       // or 'equalpower' (cheaper)
};

const rnd = (a, b) => a + Math.random() * (b - a);
const vary = (x, amt) => x * (1 + (Math.random() * 2 - 1) * amt);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const VOWELS = {
  a: [800, 1200, 2600], o: [500, 850, 2450], e: [520, 1750, 2550], u: [360, 720, 2350], ae: [680, 1550, 2500],
};
const VOWEL_KEYS = Object.keys(VOWELS);

export function createAudio(ctx) {
  const T = AUDIO_TUNING;
  let ac = null;
  let masterVol = T.masterVolume;
  let muffled = false;
  let white = null, brown = null;
  let dryBus, ambBus, ambDuck, reverbIn, micIn, compIn, agc, muffleLP, muffleGain, master, uiBus;
  let softCurve, harshCurve, radioCurve;
  const voices = [];

  const camPos = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  const ambPos = new THREE.Vector3();
  const amb = { creak: rnd(4, 9), drip: rnd(2, 5), bang: rnd(25, 50), far: rnd(10, 20) };

  // ---- setup ------------------------------------------------------------------------------
  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC({ latencyHint: 'interactive' });
    const sr = ac.sampleRate;

    white = ac.createBuffer(1, Math.floor(sr * 3), sr);
    { const d = white.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    brown = ac.createBuffer(1, Math.floor(sr * 4), sr);
    { const d = brown.getChannelData(0); let b = 0;
      for (let i = 0; i < d.length; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; } }

    softCurve = makeSoftClip(T.clipDrive);
    harshCurve = makeTanh(3.5);
    radioCurve = makeTanh(5);

    // master chain
    master = ac.createGain(); master.gain.value = masterVol;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.08;
    master.connect(limiter); limiter.connect(ac.destination);

    muffleGain = ac.createGain(); muffleGain.gain.value = muffled ? 0.7 : 1;
    muffleLP = ac.createBiquadFilter(); muffleLP.type = 'lowpass'; muffleLP.Q.value = 0.7;
    muffleLP.frequency.value = muffled ? T.muffledHz : nyq(20000);
    muffleLP.connect(muffleGain); muffleGain.connect(master);

    agc = ac.createGain(); agc.gain.value = 1; agc.connect(muffleLP);
    const makeup = ac.createGain(); makeup.gain.value = T.makeup; makeup.connect(agc);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = T.compThreshold; comp.knee.value = 6; comp.ratio.value = T.compRatio;
    comp.attack.value = T.compAttack; comp.release.value = T.compRelease;
    comp.connect(makeup);
    compIn = ac.createGain(); compIn.connect(comp);
    const clip = ac.createWaveShaper(); clip.curve = softCurve; clip.oversample = '2x'; clip.connect(compIn);
    const drive = ac.createGain(); drive.gain.value = 1; drive.connect(clip);
    const presence = biq('peaking', 2800, 0.9, 3); presence.connect(drive);
    const lp2 = biq('lowpass', T.bandHigh, 0.6); lp2.connect(presence);
    const lp1 = biq('lowpass', T.bandHigh * 1.1, 0.7); lp1.connect(lp2);
    const hp2 = biq('highpass', T.bandLow, 0.6); hp2.connect(lp1);
    const hp1 = biq('highpass', T.bandLow * 0.9, 0.7); hp1.connect(hp2);
    micIn = ac.createGain(); micIn.connect(hp1);

    uiBus = ac.createGain(); uiBus.gain.value = 0.6; uiBus.connect(master);

    dryBus = ac.createGain(); dryBus.connect(micIn);

    // reverb: big concrete hall
    const conv = ac.createConvolver();
    conv.buffer = makeHallIR(T.reverbSeconds);
    const revPre = biq('lowpass', 6000, 0.7);
    const revHp = biq('highpass', 180, 0.7);
    reverbIn = ac.createGain();
    reverbIn.connect(revHp); revHp.connect(revPre); revPre.connect(conv);
    const revOut = ac.createGain(); revOut.gain.value = T.reverbReturn;
    conv.connect(revOut); revOut.connect(micIn);

    // ambience bus (ducked separately)
    ambDuck = ac.createGain(); ambDuck.gain.value = 1; ambDuck.connect(micIn);
    ambBus = ac.createGain(); ambBus.gain.value = T.ambience; ambBus.connect(ambDuck);
    const ambSend = ac.createGain(); ambSend.gain.value = 0.25; ambBus.connect(ambSend); ambSend.connect(reverbIn);

    // hiss (enters before the compressor so it breathes with the AGC)
    const hissSrc = loopSrc(white, 1);
    const hhp = biq('highpass', 2500, 0.7), hlp = biq('lowpass', 7500, 0.7);
    const hg = ac.createGain(); hg.gain.value = T.hiss;
    hissSrc.connect(hhp); hhp.connect(hlp); hlp.connect(hg); hg.connect(compIn);
    hissSrc.start();

    startAmbience();
  }

  function nyq(f) { return Math.min(f, ac.sampleRate * 0.5 - 50); }
  function clampF(f) { return clamp(f, 10, ac.sampleRate * 0.5 - 50); }
  function biq(type, f, q = 0.7, gain = 0) {
    const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = clampF(f); b.Q.value = q;
    if (gain) b.gain.value = gain; return b;
  }
  function loopSrc(buf, rate) {
    const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; return s;
  }
  function makeSoftClip(drive) {
    // linear up to the knee, then tanh shoulder; inputs beyond +-1 hard-clip at the curve ends
    const n = 2048, c = new Float32Array(n), knee = 0.55;
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * drive;
      const ax = Math.abs(x);
      const y = ax < knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
      c[i] = Math.sign(x) * Math.min(y, 0.98);
    }
    return c;
  }
  function makeTanh(k) {
    const n = 1024, c = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }
  function makeHallIR(sec) {
    const sr = ac.sampleRate, len = Math.floor(sr * sec);
    const buf = ac.createBuffer(2, len, sr);
    const rt60 = sec * 0.95;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const pre = Math.floor((0.012 + ch * 0.003) * sr);
      // early reflections off nearby concrete
      for (let i = 0; i < 16; i++) {
        const at = pre + Math.floor(rnd(0.002, 0.095) * sr);
        const a = rnd(0.25, 0.75) * (1 - i / 18) * (Math.random() < 0.5 ? -1 : 1);
        for (let k = 0; k < 24 && at + k < len; k++) d[at + k] += a * Math.exp(-k / 6) * (Math.random() * 0.6 + 0.4);
      }
      // diffuse tail, darkening over time (concrete absorbs highs slowly)
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const coef = Math.min(0.93, 0.12 + t * 0.4);
        lp += ((Math.random() * 2 - 1) - lp) * (1 - coef);
        const fadeIn = Math.min(1, t / 0.035);
        d[i] += lp * Math.exp((-6.9 * t) / rt60) * fadeIn * (0.5 + coef * 0.9);
      }
      // faint flutter between parallel walls
      const comb = Math.floor((ch ? 0.041 : 0.037) * sr);
      for (let i = comb; i < len; i++) d[i] += d[i - comb] * 0.22;
      // fade the very end
      const fo = Math.floor(sr * 0.2);
      for (let i = 0; i < fo; i++) d[len - 1 - i] *= i / fo;
    }
    return buf;
  }

  // ---- ambience bed -----------------------------------------------------------------------
  function lfo(freq, depth, target) {
    const o = ac.createOscillator(); o.frequency.value = freq;
    const g = ac.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(target); o.start();
  }
  function startAmbience() {
    // wind through the hall, two decorrelated layers left/right
    for (const side of [-0.65, 0.65]) {
      const src = loopSrc(white, rnd(0.97, 1.03));
      const bp = biq('bandpass', rnd(320, 460), 0.8);
      lfo(rnd(0.04, 0.09), rnd(140, 220), bp.frequency);
      const g = ac.createGain(); g.gain.value = 0.05;
      lfo(rnd(0.025, 0.06), 0.032, g.gain);
      const sp = ac.createStereoPanner(); sp.pan.value = side;
      src.connect(bp); bp.connect(g); g.connect(sp); sp.connect(ambBus);
      src.start(0, Math.random() * 2);
    }
    // high whistle through a gap
    {
      const src = loopSrc(white, 1);
      const bp = biq('bandpass', 880, 9);
      lfo(0.07, 110, bp.frequency);
      const g = ac.createGain(); g.gain.value = 0.006;
      lfo(0.045, 0.0055, g.gain);
      src.connect(bp); bp.connect(g); g.connect(ambBus); src.start(0, 1.1);
    }
    // rumble / distant traffic
    {
      const src = loopSrc(brown, 1);
      const lp = biq('lowpass', 420, 0.6);
      const g = ac.createGain(); g.gain.value = 0.2;
      lfo(0.018, 0.09, g.gain);
      const sp = ac.createStereoPanner(); sp.pan.value = 0;
      lfo(0.011, 0.5, sp.pan);
      src.connect(lp); lp.connect(g); g.connect(sp); sp.connect(ambBus); src.start();
    }
    // industrial mains hum from a distant substation (fundamental is cut by the mic HP)
    for (const [f, a] of [[100, 0.006], [150, 0.0045], [200, 0.003], [300, 0.0018], [450, 0.0008]]) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * rnd(0.998, 1.002);
      const g = ac.createGain(); g.gain.value = a;
      o.connect(g); g.connect(ambBus); o.start();
    }
    // room tone
    {
      const src = loopSrc(white, 0.5);
      const lp = biq('lowpass', 1200, 0.5);
      const g = ac.createGain(); g.gain.value = 0.005;
      src.connect(lp); lp.connect(g); g.connect(ambBus); src.start(0, 0.4);
    }
  }

  function randomAround(minD, maxD, yMin, yMax) {
    const a = Math.random() * Math.PI * 2, d = rnd(minD, maxD);
    ambPos.set(camPos.x + Math.cos(a) * d, camPos.y + rnd(yMin, yMax), camPos.z + Math.sin(a) * d);
    return ambPos;
  }

  function ambienceEvents(dt) {
    if ((amb.creak -= dt) <= 0) { amb.creak = rnd(5, 14); sndCreak(randomAround(6, 24, 1, 6)); }
    if ((amb.drip -= dt) <= 0) {
      amb.drip = rnd(1.5, 6);
      const p = randomAround(2, 14, -1.5, -1.2);
      const n = Math.random() < 0.4 ? 2 + (Math.random() * 3 | 0) : 1;
      sndDrip(p, n);
    }
    if ((amb.bang -= dt) <= 0) { amb.bang = rnd(30, 75); sndDistantBang(randomAround(25, 50, 0, 6)); }
    if ((amb.far -= dt) <= 0) { amb.far = rnd(12, 30); sndFarTraffic(randomAround(60, 90, 0, 2)); }
  }

  // ---- voices -----------------------------------------------------------------------------
  function distTo(p) {
    camera().getWorldPosition(camPos);
    return p ? camPos.distanceTo(p) : 0;
  }
  function camera() { return ctx.camera; }
  function validPos(p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }

  function stealIfNeeded() {
    let live = 0, oldest = null;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i]; if (v.stolen) continue;
      live++; if (!oldest || v.t < oldest.t) oldest = v;
    }
    if (live < T.maxVoices || !oldest) return;
    const now = ac.currentTime, g = oldest.out.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.03);
    oldest.stolen = true; oldest.end = now + 0.04;
  }

  /** o: { position, volume, send, bus, lowpass, ref, rolloff, dist } */
  function voice(o) {
    stealIfNeeded();
    const t = ac.currentTime + 0.01;
    const v = { t, end: t + 0.05, nodes: [], input: null, out: null, stolen: false };
    const input = node(v, ac.createGain());
    const out = node(v, ac.createGain());
    out.gain.value = Math.max(0, o.volume ?? 1);
    let last = input;
    if (o.lowpass) { const lp = node(v, biq('lowpass', o.lowpass, 0.6)); last.connect(lp); last = lp; }
    last.connect(out);
    const bus = o.bus || dryBus;
    const pos = validPos(o.position) ? o.position : null;
    const d = o.dist ?? (pos ? distTo(pos) : 0);
    if (pos) {
      const pan = node(v, ac.createPanner());
      pan.panningModel = T.panningModel; pan.distanceModel = 'inverse';
      pan.refDistance = o.ref ?? T.refDistance; pan.rolloffFactor = o.rolloff ?? T.rolloff;
      pan.maxDistance = T.maxDistance;
      if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; }
      else pan.setPosition(pos.x, pos.y, pos.z);
      out.connect(pan); pan.connect(bus);
    } else out.connect(bus);
    if (o.send > 0) {
      const s = node(v, ac.createGain());
      s.gain.value = o.send / (1 + d * 0.08);
      out.connect(s); s.connect(reverbIn);
    }
    v.input = input; v.out = out;
    voices.push(v);
    return v;
  }
  function node(v, n) { v.nodes.push(n); return n; }
  function bump(v, t) { if (t > v.end) v.end = t; }

  function cleanup() {
    const now = ac.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (now > v.end + 0.15) {
        for (let k = 0; k < v.nodes.length; k++) { try { v.nodes[k].disconnect(); } catch (e) { /* already */ } }
        v.nodes.length = 0;
        voices[i] = voices[voices.length - 1]; voices.pop();
      }
    }
  }

  // ---- layer helpers (all scheduled at t >= v.t, which is in the future) ---------------------
  function env(v, t, a, peak, d, hold = 0, dest) {
    const g = node(v, ac.createGain());
    const pk = Math.max(peak, 1e-4);
    a = Math.max(a, 0.0005); d = Math.max(d, 0.002);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + a);
    if (hold > 0) g.gain.setValueAtTime(pk, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
    g.connect(dest || v.input);
    bump(v, t + a + hold + d);
    return g;
  }
  function gainN(v, val) { const g = node(v, ac.createGain()); g.gain.value = val; return g; }
  function filt(v, type, f, q = 0.7, gain = 0) { return node(v, biq(type, f, q, gain)); }
  function noise(v, t, dur, rate = 1, buf = white) {
    const s = node(v, ac.createBufferSource());
    s.buffer = buf; s.playbackRate.value = rate;
    const need = dur * rate + 0.05;
    if (need >= buf.duration) { s.loop = true; s.start(t); }
    else s.start(t, Math.random() * (buf.duration - need));
    s.stop(t + dur + 0.02);
    bump(v, t + dur + 0.02);
    return s;
  }
  function osc(v, type, f, t, dur) {
    const o = node(v, ac.createOscillator());
    o.type = type; o.frequency.setValueAtTime(clampF(f), t);
    o.start(t); o.stop(t + dur + 0.02);
    bump(v, t + dur + 0.02);
    return o;
  }
  function glide(param, from, to, t, dur) {
    param.setValueAtTime(clampF(from), t);
    param.exponentialRampToValueAtTime(clampF(to), t + Math.max(dur, 0.002));
  }
  function chain(...ns) { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; }

  // filtered noise burst
  function nb(v, t, type, f, q, a, peak, d, hold = 0, rate = 1) {
    return chain(noise(v, t, a + hold + d, rate), filt(v, type, f, q), env(v, t, a, peak, d, hold));
  }
  // decaying tone
  function tn(v, t, type, f, a, peak, d, f2 = 0, glideDur = 0) {
    const o = osc(v, type, f, t, a + d);
    if (f2) glide(o.frequency, f, f2, t, glideDur || a + d);
    return chain(o, env(v, t, a, peak, d));
  }
  // mechanical click: filtered tick + short tuned resonance
  function click(v, t, f, amp, ring = 0.03) {
    nb(v, t, 'bandpass', f, 3, 0.0005, amp, 0.012);
    nb(v, t, 'highpass', 6000, 0.7, 0.0003, amp * 0.45, 0.006);
    tn(v, t, 'sine', f * rnd(0.55, 0.72), 0.0005, amp * 0.35, ring);
  }
  function metalRing(v, t, base, amp, decay, partials = [1, 2.76, 5.4]) {
    for (let i = 0; i < partials.length; i++) {
      tn(v, t, 'sine', base * partials[i] * rnd(0.97, 1.03), 0.001, amp / (i * 0.7 + 1), decay * rnd(0.7, 1.1) / (i * 0.35 + 1));
    }
  }
  function rattle(v, t, span, n, amp) {
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * span;
      nb(v, tt, 'bandpass', rnd(2500, 6000), 4, 0.0005, amp * rnd(0.4, 1), rnd(0.006, 0.02));
    }
  }
  function rustle(v, t, amp, dur) {
    nb(v, t, 'bandpass', rnd(2600, 4200), 0.9, dur * 0.3, amp, dur * 0.7);
  }

  // AGC pump / ambience duck after loud close sounds
  function duck(amount) {
    if (amount <= 0) return;
    const now = ac.currentTime, tc = T.duckRecover / 3;
    const g = agc.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1 - T.duckDepth * amount, now + 0.045);
    g.setTargetAtTime(1, now + 0.07, tc);
    const a = ambDuck.gain;
    a.cancelScheduledValues(now); a.setValueAtTime(a.value, now);
    a.linearRampToValueAtTime(Math.max(0.05, 1 - T.ambDuckDepth * amount), now + 0.03);
    a.setTargetAtTime(1, now + 0.12, tc);
  }

  // ---- gunshots ---------------------------------------------------------------------------
  function shotLayers(v, t, p, crackAmt, bodyAmt) {
    // supersonic crack / muzzle blast
    nb(v, t, 'highpass', vary(1400, 0.15), 0.7, 0.0004, 1.8 * crackAmt, vary(0.04, 0.2));
    nb(v, t, 'peaking', vary(3500, 0.15), 1, 0.0004, 0.9 * crackAmt, 0.025);
    // broadband blast
    nb(v, t, 'bandpass', vary(900, 0.2) * p, 0.8, 0.001, 1.3 * bodyAmt, vary(0.11, 0.15));
    // low thump
    tn(v, t, 'sine', vary(130, 0.08) * p, 0.002, 1.7 * bodyAmt, 0.2, 42, 0.14);
    nb(v, t, 'lowpass', 300, 0.7, 0.001, 1.2 * bodyAmt, 0.12, 0, 0.6);
    // pressure wave: full-band 1 ms spike, sub drop and a mid "knock" that survives small speakers
    nb(v, t, 'allpass', 1000, 0.7, 0.0002, 2.6 * crackAmt, 0.004);
    tn(v, t, 'sine', vary(190, 0.06) * p, 0.001, 2.4 * bodyAmt, 0.26, 48, 0.11);
    tn(v, t, 'triangle', vary(95, 0.06) * p, 0.004, 1.3 * bodyAmt, 0.3, 40, 0.2);
    nb(v, t, 'bandpass', vary(620, 0.12) * p, 1.6, 0.001, 1.5 * bodyAmt, vary(0.07, 0.15));
    nb(v, t + 0.012, 'lowpass', 1800, 0.7, 0.004, 0.8 * bodyAmt, vary(0.2, 0.15));   // muzzle gas roar
    // short body resonance
    nb(v, t, 'bandpass', vary(380, 0.1) * p, 5, 0.003, 0.9 * bodyAmt, vary(0.26, 0.15));
    tn(v, t, 'triangle', vary(240, 0.06) * p, 0.002, 0.22 * bodyAmt, 0.17);
  }

  function sndShot(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * T.shotGain, send: 0.95, position: o.position });
    const t = v.t;
    shotLayers(v, t, p, 1, 1);
    click(v, t + vary(0.035, 0.1), 3200 * p, 0.22, 0.02); // slide cycling
    // first reflections off nearby walls: two quick slaps make the shot feel big instead of dry
    for (const [dt, g, f] of [[vary(0.045, 0.2), 0.34, 2600], [vary(0.11, 0.2), 0.2, 1500]]) {
      const dl = node(v, ac.createDelay(0.3)); dl.delayTime.value = dt;
      const lp = filt(v, 'lowpass', f, 0.7), gg = gainN(v, g);
      v.input.connect(dl); dl.connect(lp); lp.connect(gg); gg.connect(v.out);
      bump(v, v.end + dt);
    }
    duck(1);
  }

  function sndShotEnemy(o, p) {
    const pos = validPos(o.position) ? o.position : null;
    const d = pos ? distTo(pos) : 8;
    const far = clamp(d / 30, 0, 1);
    const v = voice({
      position: pos, dist: d, volume: (o.volume ?? 1) * T.enemyShotGain,
      send: 0.9 + far * 0.8, ref: 3, rolloff: 1,
      lowpass: clamp(12000 / (1 + d / 7), 700, 12000),
    });
    const t = v.t;
    shotLayers(v, t, p * vary(0.95, 0.03), 1 - far * 0.6, 1);
    // slap-back off the far wall: grows with distance
    if (d > 5) {
      const dl = node(v, ac.createDelay(0.5));
      dl.delayTime.value = Math.min(0.4, 0.025 + d * 0.004);
      const lp = filt(v, 'lowpass', 2500, 0.7);
      const g = gainN(v, 0.22 + 0.3 * far);
      v.input.connect(dl); dl.connect(lp); lp.connect(g); g.connect(v.out);
      bump(v, v.end + dl.delayTime.value);
    }
    if (d < 20) duck(0.6 * (1 - d / 20));
  }

  // ---- weapon handling --------------------------------------------------------------------
  function sndDry(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.5, send: 0.15, position: o.position });
    click(v, v.t, vary(2600, 0.08) * p, 0.6, 0.02);
    tn(v, v.t, 'sine', 900 * p, 0.0005, 0.08, 0.015);
  }
  function sndReloadOut(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.55, send: 0.15, position: o.position });
    const t = v.t;
    click(v, t, vary(2200, 0.08) * p, 0.5, 0.02); // mag release
    const s = noise(v, t + 0.025, 0.2);
    const f = filt(v, 'bandpass', 2200, 2);
    glide(f.frequency, 2200 * p, 900 * p, t + 0.025, 0.17);
    chain(s, f, env(v, t + 0.025, 0.02, 0.28, 0.15));
    metalRing(v, t + 0.04, 1600 * p, 0.05, 0.12);
    rustle(v, t + 0.05, 0.05, 0.25);
  }
  function sndReloadIn(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.6, send: 0.15, position: o.position });
    const t = v.t;
    const s = noise(v, t, 0.12);
    const f = filt(v, 'bandpass', 900, 2.5);
    glide(f.frequency, 900 * p, 2000 * p, t, 0.1);
    chain(s, f, env(v, t, 0.03, 0.22, 0.07));
    const ts = t + vary(0.11, 0.1);
    click(v, ts, vary(1500, 0.06) * p, 0.95, 0.04);   // seat
    tn(v, ts, 'sine', 170 * p, 0.001, 0.35, 0.05);    // palm thunk
    metalRing(v, ts, 2700 * p, 0.06, 0.05, [1, 1.9]);
  }
  function sndSlide(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.6, send: 0.18, position: o.position });
    const t = v.t;
    click(v, t, vary(2400, 0.08) * p, 0.4, 0.02);
    const s = noise(v, t, 0.09);
    const f = filt(v, 'bandpass', 1800, 3);
    glide(f.frequency, 1800 * p, 3200 * p, t, 0.07);
    chain(s, f, env(v, t, 0.01, 0.2, 0.07));
    const tr = t + rnd(0.14, 0.18);
    click(v, tr, vary(3000, 0.06) * p, 1.0, 0.03);
    tn(v, tr, 'sine', 220 * p, 0.001, 0.4, 0.06);
    metalRing(v, tr, 1900 * p, 0.07, 0.08, [1, 2.3]);
  }
  function sndShell(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.35, send: 0.3, position: o.position, ref: 1 });
    let t = v.t, amp = 1;
    const bounces = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let b = 0; b < bounces; b++) {
      const k = p * rnd(0.97, 1.03);
      tn(v, t, 'sine', rnd(3800, 4400) * k, 0.0005, 0.25 * amp, rnd(0.07, 0.13));
      tn(v, t, 'sine', rnd(5900, 6600) * k, 0.0005, 0.16 * amp, rnd(0.05, 0.09));
      tn(v, t, 'sine', rnd(8000, 9000) * k, 0.0005, 0.08 * amp, rnd(0.03, 0.06));
      nb(v, t, 'highpass', 5000, 0.7, 0.0003, 0.15 * amp, 0.004);
      t += rnd(0.07, 0.12) * amp + 0.03; amp *= rnd(0.35, 0.5);
    }
  }

  // ---- movement ---------------------------------------------------------------------------
  function sndStep(o, p, metal) {
    const vol = (o.volume ?? 1) * T.stepGain * vary(1, 0.2);
    const v = voice({ volume: vol, send: 0.3, position: o.position, ref: 1.5 });
    const t = v.t, k = vary(1, 0.15);
    // heel
    nb(v, t, 'lowpass', 1600 * k * p, 0.8, 0.002, 0.55, 0.045);
    tn(v, t, 'sine', vary(85, 0.12), 0.003, 0.35, 0.06);
    // toe / scuff
    const t2 = t + rnd(0.03, 0.07);
    nb(v, t2, 'bandpass', vary(2500, 0.25) * p, 1.2, 0.004, 0.2 * k, 0.06);
    // grit
    nb(v, t, 'highpass', 5000, 0.7, 0.001, 0.07, 0.03);
    // cloth / gear
    rustle(v, t + rnd(0, 0.04), 0.06 * vary(1, 0.4), 0.22);
    if (Math.random() < 0.25) rattle(v, t + 0.02, 0.08, 2, 0.05);
    if (metal) {
      metalRing(v, t, rnd(380, 460) * p, 0.14, rnd(0.25, 0.45), [1, 2.7, 5.3, 8.1]);
      nb(v, t, 'bandpass', vary(1800, 0.2), 3, 0.001, 0.3, 0.05);
    }
  }
  function sndLand(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.8, send: 0.35, position: o.position, ref: 1.5 });
    const t = v.t;
    tn(v, t, 'sine', 75 * p, 0.003, 0.9, 0.2, 45, 0.15);
    nb(v, t, 'lowpass', 800, 0.7, 0.002, 0.8, 0.1);
    nb(v, t + 0.02, 'bandpass', 2200, 1, 0.004, 0.25, 0.06);
    rattle(v, t, 0.12, 5, 0.14);
    rustle(v, t, 0.12, 0.3);
  }

  // ---- impacts ----------------------------------------------------------------------------
  function sndImpactConcrete(o, p) {
    const v = voice({ volume: o.volume ?? 1, send: 0.6, position: o.position });
    const t = v.t;
    nb(v, t, 'highpass', vary(2500, 0.2), 0.7, 0.0003, 0.8, 0.02);
    nb(v, t, 'bandpass', vary(1100, 0.2) * p, 1, 0.0005, 0.6, 0.06);
    tn(v, t, 'sine', vary(140, 0.15), 0.001, 0.3, 0.05);
    const n = 3 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) nb(v, t + rnd(0.04, 0.32), 'bandpass', rnd(3000, 6000), 3, 0.0005, rnd(0.04, 0.12), 0.01);
  }
  function sndImpactGlass(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.9, send: 0.5, position: o.position });
    const t = v.t;
    nb(v, t, 'highpass', 2500, 0.7, 0.0004, 1.0, 0.03);                 // crack
    nb(v, t, 'bandpass', 5200, 1.2, 0.002, 0.6, 0.22);                  // shatter wash
    for (let i = 0; i < 14; i++) {                                      // shards ringing and landing
      const tt = t + 0.01 + Math.pow(Math.random(), 1.6) * 0.75;
      tn(v, tt, 'sine', rnd(2600, 7200) * p, 0.0006, rnd(0.05, 0.2), rnd(0.02, 0.09));
      if (i % 3 === 0) nb(v, tt, 'bandpass', rnd(3500, 6500), 6, 0.0005, 0.25, 0.015);
    }
  }

  function sndImpactMetal(o, p) {
    const v = voice({ volume: o.volume ?? 1, send: 0.6, position: o.position });
    const t = v.t;
    nb(v, t, 'highpass', 3000, 0.7, 0.0003, 0.8, 0.012);
    tn(v, t, 'sine', rnd(1900, 2300) * p, 0.001, 0.35, rnd(0.2, 0.3));
    tn(v, t, 'sine', rnd(3100, 3600) * p, 0.001, 0.25, rnd(0.14, 0.2));
    tn(v, t, 'sine', rnd(4700, 5300) * p, 0.001, 0.15, rnd(0.08, 0.13));
    nb(v, t, 'bandpass', 700, 2, 0.001, 0.3, 0.05);
    if (Math.random() < 0.25) {
      // ricochet whine
      const f0 = rnd(2800, 3600), f1 = rnd(1200, 1700);
      tn(v, t + 0.012, 'triangle', f0, 0.01, 0.1, 0.32, f1, 0.33);
    }
  }
  function sndImpactWood(o, p) {
    const v = voice({ volume: o.volume ?? 1, send: 0.5, position: o.position });
    const t = v.t;
    nb(v, t, 'bandpass', vary(520, 0.15) * p, 3, 0.0005, 0.85, 0.05);
    tn(v, t, 'sine', vary(260, 0.12) * p, 0.001, 0.4, 0.07);
    nb(v, t, 'highpass', 3000, 0.7, 0.0005, 0.25, 0.06);
    for (let i = 0; i < 3; i++) nb(v, t + rnd(0.01, 0.12), 'bandpass', rnd(2000, 4500), 4, 0.0005, rnd(0.05, 0.12), 0.012);
  }
  function sndImpactFlesh(o, p) {
    const v = voice({ volume: o.volume ?? 1, send: 0.3, position: o.position });
    const t = v.t;
    nb(v, t, 'lowpass', 500 * p, 0.7, 0.001, 0.9, 0.07);
    tn(v, t, 'sine', vary(95, 0.1) * p, 0.001, 0.6, 0.08, 60, 0.08);
    nb(v, t, 'bandpass', vary(1400, 0.2), 0.8, 0.0005, 0.35, 0.025);
    nb(v, t + 0.01, 'bandpass', vary(700, 0.2), 4, 0.004, 0.15, 0.1);
  }

  // ---- voices (human) ---------------------------------------------------------------------
  function formantBank(v, src, t, formants, amps, q, outEnv) {
    for (let i = 0; i < formants.length; i++) {
      const f = filt(v, 'bandpass', formants[i], q[i]);
      const g = gainN(v, amps[i]);
      src.connect(f); f.connect(g); g.connect(outEnv);
    }
  }
  function sndHurt(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.7, send: 0.3, position: o.position, ref: 1.5 });
    const t = v.t;
    const f0 = rnd(105, 135) * p, dur = rnd(0.16, 0.24);
    const mix = gainN(v, 1);
    const saw = osc(v, 'sawtooth', f0, t, dur + 0.2);
    saw.frequency.linearRampToValueAtTime(clampF(f0 * 0.78), t + dur + 0.15);
    const sg = gainN(v, 0.5); saw.connect(sg); sg.connect(mix);
    const nz = noise(v, t, dur + 0.2); const ng = gainN(v, 0.35); nz.connect(ng); ng.connect(mix);
    const e = env(v, t, 0.02, 0.6, 0.15, dur * 0.5);
    const vw = VOWELS[Math.random() < 0.5 ? 'u' : 'ae'];
    formantBank(v, mix, t, [vw[0] * p, vw[1] * p, vw[2] * p], [1, 0.5, 0.2], [7, 9, 10], e);
  }
  function sndDeath(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.6, send: 0.35, position: o.position, ref: 1.5 });
    const t = v.t;
    const nz = noise(v, t, 1.2);
    const e = env(v, t, 0.06, 0.45, 0.85, 0.1);
    formantBank(v, nz, t, [700 * p, 1150 * p, 2500 * p], [1, 0.6, 0.25], [5, 6, 8], e);
    const saw = osc(v, 'sawtooth', 100 * p, t, 0.5);
    glide(saw.frequency, 100 * p, 62 * p, t, 0.45);
    chain(saw, filt(v, 'lowpass', 900, 0.7), env(v, t, 0.03, 0.12, 0.35, 0.05));
  }
  function sndBodyFall(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.9, send: 0.45, position: o.position });
    const t = v.t;
    tn(v, t, 'sine', 70 * p, 0.004, 1.0, 0.25, 45, 0.2);
    nb(v, t, 'lowpass', 450, 0.7, 0.003, 0.8, 0.18);
    const t2 = t + rnd(0.12, 0.2);
    tn(v, t2, 'sine', 90 * p, 0.003, 0.5, 0.12);
    nb(v, t2, 'lowpass', 700, 0.7, 0.002, 0.4, 0.1);
    rattle(v, t, 0.3, 5, 0.16);
    rustle(v, t, 0.12, 0.35);
    if (Math.random() < 0.5) { const tw = t + rnd(0.2, 0.3); click(v, tw, 1800, 0.25, 0.05); metalRing(v, tw, 900, 0.06, 0.15); }
  }
  function sndShout(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.7, send: 0.6, position: o.position, ref: 2.5 });
    let tt = v.t;
    const syl = Math.random() < 0.5 ? 1 : 2;
    const base = rnd(150, 195) * p;
    for (let s = 0; s < syl; s++) {
      const dur = rnd(0.18, 0.3), f0 = base * rnd(0.95, 1.08);
      const mix = gainN(v, 1);
      for (const det of [1, 1.012]) {
        const o2 = osc(v, 'sawtooth', f0 * 0.9 * det, tt, dur + 0.05);
        o2.frequency.linearRampToValueAtTime(clampF(f0 * 1.15 * det), tt + dur * 0.3);
        o2.frequency.linearRampToValueAtTime(clampF(f0 * 0.82 * det), tt + dur);
        const g = gainN(v, 0.35); o2.connect(g); g.connect(mix);
      }
      const nz = noise(v, tt, dur + 0.05); const ng = gainN(v, 0.25); nz.connect(ng); ng.connect(mix);
      const ws = node(v, ac.createWaveShaper()); ws.curve = harshCurve;
      const drive = gainN(v, 1.6); mix.connect(drive); drive.connect(ws);
      const e = env(v, tt, 0.02, 0.5, dur * 0.4, dur * 0.6);
      const A = VOWELS[VOWEL_KEYS[(Math.random() * VOWEL_KEYS.length) | 0]];
      const B = VOWELS[VOWEL_KEYS[(Math.random() * VOWEL_KEYS.length) | 0]];
      const amps = [1, 0.7, 0.3], qs = [6, 8, 10];
      for (let i = 0; i < 3; i++) {
        const f = filt(v, 'bandpass', A[i], qs[i]);
        f.frequency.setValueAtTime(clampF(A[i]), tt);
        f.frequency.linearRampToValueAtTime(clampF(B[i]), tt + dur);
        const g = gainN(v, amps[i]);
        ws.connect(f); f.connect(g); g.connect(e);
      }
      tt += dur + rnd(0.05, 0.09);
    }
  }
  function sndRadio(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.55, send: 0.04, position: o.position });
    const t = v.t;
    // radio band + overdriven speaker
    const rIn = gainN(v, 1);
    const hp = filt(v, 'highpass', 450, 0.8), lp = filt(v, 'lowpass', 2800, 0.8);
    const ws = node(v, ac.createWaveShaper()); ws.curve = radioCurve;
    const pk = filt(v, 'peaking', 1800, 1.2, 6);
    chain(rIn, hp, lp, ws, pk); pk.connect(v.input);
    // squelch open
    chain(noise(v, t, 0.1), env(v, t, 0.002, 0.6, 0.04, 0.05, rIn));
    // garbled chatter
    const t0 = t + 0.09, len = rnd(0.9, 1.5);
    const src = osc(v, 'sawtooth', 140 * p, t0, len);
    const fA = filt(v, 'bandpass', 700, 4), fB = filt(v, 'bandpass', 1600, 5);
    const gate = gainN(v, 0); gate.gain.setValueAtTime(0, t0);
    src.connect(fA); src.connect(fB); fA.connect(gate); fB.connect(gate); gate.connect(rIn);
    let s = t0;
    while (s < t0 + len - 0.08) {
      const sl = rnd(0.06, 0.16);
      src.frequency.setValueAtTime(clampF(rnd(110, 190) * p), s);
      fA.frequency.setValueAtTime(clampF(rnd(450, 900)), s);
      fB.frequency.setValueAtTime(clampF(rnd(1100, 2300)), s);
      const pk2 = rnd(0.35, 0.8);
      gate.gain.setValueAtTime(0, s);
      gate.gain.linearRampToValueAtTime(pk2, s + 0.012);
      gate.gain.linearRampToValueAtTime(pk2 * 0.6, s + sl - 0.012);
      gate.gain.linearRampToValueAtTime(0, s + sl);
      s += sl + (Math.random() < 0.2 ? rnd(0.08, 0.18) : rnd(0.01, 0.04));
    }
    // carrier noise bed
    chain(noise(v, t0, len), env(v, t0, 0.01, 0.07, 0.05, len - 0.06, rIn));
    // squelch close
    const tc = t0 + len + 0.02;
    chain(noise(v, tc, 0.16), env(v, tc, 0.002, 0.5, 0.06, 0.08, rIn));
  }
  function sndUiClick(o, p) {
    const v = voice({ volume: (o.volume ?? 1) * 0.35, bus: uiBus });
    tn(v, v.t, 'sine', 1400 * p, 0.0005, 0.6, 0.025);
    nb(v, v.t, 'highpass', 4000, 0.7, 0.0003, 0.3, 0.006);
  }

  // ---- ambience events --------------------------------------------------------------------
  function sndCreak(pos) {
    const v = voice({ volume: rnd(0.12, 0.3), send: 0.8, position: pos, bus: ambBus, ref: 4 });
    const t = v.t, dur = rnd(0.6, 1.8);
    const fx0 = rnd(18, 40);
    const ex = osc(v, 'sawtooth', fx0, t, dur);
    glide(ex.frequency, fx0, fx0 * rnd(0.6, 1.5), t, dur);
    const e = env(v, t, dur * 0.3, 1, dur * 0.4, dur * 0.3);
    const base = rnd(500, 1100);
    for (const [m, q, a] of [[1, 18, 0.5], [1.73, 22, 0.3], [2.61, 25, 0.2]]) {
      const f = filt(v, 'bandpass', base * m, q);
      glide(f.frequency, base * m, base * m * rnd(0.94, 1.06), t, dur);
      const g = gainN(v, a); ex.connect(f); f.connect(g); g.connect(e);
    }
  }
  function sndDrip(pos, n) {
    const v = voice({ volume: rnd(0.08, 0.18), send: 0.9, position: pos, bus: ambBus, ref: 1.5 });
    let t = v.t;
    for (let i = 0; i < n; i++) {
      const f = rnd(1200, 1900);
      tn(v, t, 'sine', f, 0.001, 0.25, 0.04, f * 1.6, 0.025);
      t += rnd(0.35, 0.9);
    }
  }
  function sndDistantBang(pos) {
    const v = voice({ volume: rnd(0.2, 0.4), send: 1.6, position: pos, bus: ambBus, ref: 6, lowpass: 1200 });
    const t = v.t;
    tn(v, t, 'sine', 80, 0.003, 0.8, 0.3, 50, 0.25);
    metalRing(v, t, rnd(250, 400), 0.25, 0.8, [1, 2.4, 3.9]);
    nb(v, t, 'lowpass', 900, 0.7, 0.002, 0.5, 0.15);
  }
  function sndFarTraffic(pos) {
    const v = voice({ volume: rnd(0.15, 0.3), send: 0.3, position: pos, bus: ambBus, ref: 20, rolloff: 0.3 });
    const t = v.t, dur = rnd(3, 6);
    const s = noise(v, t, dur, 1, brown);
    const f = filt(v, 'bandpass', 300, 0.6);
    glide(f.frequency, 220, 520, t, dur * 0.5);
    f.frequency.exponentialRampToValueAtTime(200, t + dur);
    chain(s, f, env(v, t, dur * 0.45, 0.5, dur * 0.5, 0.05));
  }

  const SOUNDS = {
    shot: sndShot, shot_enemy: sndShotEnemy, dry: sndDry,
    reload_out: sndReloadOut, reload_in: sndReloadIn, slide: sndSlide,
    step_concrete: (o, p) => sndStep(o, p, false), step_metal: (o, p) => sndStep(o, p, true), land: sndLand,
    impact_concrete: sndImpactConcrete, impact_metal: sndImpactMetal, impact_glass: sndImpactGlass, impact_wood: sndImpactWood, impact_flesh: sndImpactFlesh,
    hurt: sndHurt, death: sndDeath, body_fall: sndBodyFall, shell: sndShell, shout: sndShout, radio: sndRadio,
    ui_click: sndUiClick,
  };

  // ---- public API -------------------------------------------------------------------------
  function resume() {
    if (!ac) {
      try { init(); } catch (e) { console.warn('[audio] init failed', e); ac = null; return; }
      if (!ac) return;
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  }

  function play(name, o) {
    if (!ac || ac.state !== 'running') return;
    const fn = SOUNDS[name];
    if (!fn) return;
    o = o || {};
    const pitch = (o.pitch ?? 1) * vary(1, 0.03);
    try { fn(o, pitch > 0 ? pitch : 1); } catch (e) { console.warn('[audio] ' + name, e); }
  }

  function updateListener() {
    const cam = camera(); if (!cam) return;
    cam.getWorldPosition(camPos);
    cam.getWorldDirection(camFwd);
    cam.getWorldQuaternion(camQ);
    camUp.set(0, 1, 0).applyQuaternion(camQ);
    const L = ac.listener;
    if (L.positionX) {
      L.positionX.value = camPos.x; L.positionY.value = camPos.y; L.positionZ.value = camPos.z;
      L.forwardX.value = camFwd.x; L.forwardY.value = camFwd.y; L.forwardZ.value = camFwd.z;
      L.upX.value = camUp.x; L.upY.value = camUp.y; L.upZ.value = camUp.z;
    } else {
      L.setPosition(camPos.x, camPos.y, camPos.z);
      L.setOrientation(camFwd.x, camFwd.y, camFwd.z, camUp.x, camUp.y, camUp.z);
    }
  }

  function update(dt) {
    if (!ac) return;
    updateListener();
    cleanup();
    if (ac.state === 'running') ambienceEvents(dt);
  }

  function setMuffled(b) {
    muffled = !!b;
    if (!ac) return;
    const now = ac.currentTime;
    muffleLP.frequency.cancelScheduledValues(now);
    muffleLP.frequency.setValueAtTime(muffleLP.frequency.value, now);
    muffleLP.frequency.setTargetAtTime(muffled ? T.muffledHz : nyq(20000), now, muffled ? 0.25 : 0.12);
    muffleGain.gain.cancelScheduledValues(now);
    muffleGain.gain.setValueAtTime(muffleGain.gain.value, now);
    muffleGain.gain.setTargetAtTime(muffled ? 0.7 : 1, now, 0.2);
  }

  function setMasterVolume(val) {
    masterVol = clamp(Number(val) || 0, 0, 1.5);
    if (!ac) return;
    const now = ac.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setTargetAtTime(masterVol, now, 0.03);
  }

  return {
    resume, play, update, setMuffled, setMasterVolume,
    get context() { return ac; },
    get voiceCount() { return voices.length; },
    tuning: T,
  };
}
