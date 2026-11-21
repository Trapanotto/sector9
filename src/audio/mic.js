// The bodycam microphone chain on the master bus. Owner: E.
//
//   world + radio ─► input ─► HP 110 Hz ─► presence +3 dB @ 2.8 kHz ─► LP 8.5 kHz ─► AGC/overload (worklet)
//                    ▲                                                                      │
//   self-noise hiss ─┤  (the AGC lifts it in quiet passages → audible pumping)              ▼
//   wind / handling ─┘  (low rumble when the wearer moves fast)                    ear LP ─► master ─► out
//                                                                    ring tone ─┘ (brief, after very close shots)
// Fallback without AudioWorklet: soft-clip WaveShaper + DynamicsCompressor (no quiet boost).
import { agcWorkletSource, AgcCore } from './agc.js';

let workletUrl = null;

export function createMic(ac, { tier = 'low', log = null } = {}) {
  const m = { ac, ready: null, agc: null, usingWorklet: false };
  const input = ac.createGain();
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110; hp.Q.value = 0.7;
  const pres = ac.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 2800; pres.Q.value = 0.9; pres.gain.value = 3;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8500; lp.Q.value = 0.6;
  const ear = ac.createBiquadFilter(); ear.type = 'lowpass'; ear.frequency.value = 20000; ear.Q.value = 0.5;
  const post = ac.createGain();          // after the mic (UI bus joins here)
  const master = ac.createGain();
  input.connect(hp); hp.connect(pres); pres.connect(lp);
  ear.connect(post); post.connect(master); master.connect(ac.destination);

  // fallback dynamics (active until the worklet is up, or for good if worklets are unavailable)
  const shaper = ac.createWaveShaper();
  const N = 2048, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = AgcCore.sat(x * 1.6, 0.6) * 0.97; }
  shaper.curve = curve;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.9;
  const makeup = ac.createGain(); makeup.gain.value = 1.6;
  lp.connect(shaper); shaper.connect(comp); comp.connect(makeup); makeup.connect(ear);

  if (ac.audioWorklet && typeof Blob !== 'undefined') {
    m.ready = (async () => {
      try {
        if (!workletUrl) workletUrl =URL.createObjectURL(new Blob([agcWorkletSource()], { type: 'application/javascript' }));
        await ac.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ac, 'bodycam-agc', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 1], processorOptions: {} });
        lp.disconnect(); makeup.disconnect();
        lp.connect(node); node.connect(ear, 0);
        m.agc = node; m.usingWorklet = true;
      } catch (e) { log?.(`[audio] AGC worklet unavailable, compressor fallback: ${e?.message ?? e}`); }
    })();
  }

  // ---- self-noise and wind (one shared noise buffer, pinkish)
  const nb = ac.createBuffer(1, Math.round(ac.sampleRate * 2.5), ac.sampleRate), nd = nb.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < nd.length; i++) {
    const w = rnd();
    b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
    nd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
  }
  // crossfade the loop seam
  const xf = Math.round(ac.sampleRate * 0.05);
  for (let i = 0; i < xf; i++) { const k = i / xf; nd[i] = nd[i] * k + nd[nd.length - xf + i] * (1 - k); }
  const hiss = ac.createBufferSource(); hiss.buffer = nb; hiss.loop = true; hiss.loopEnd = nb.duration - 0.05;
  const hissG = ac.createGain(); hissG.gain.value = 0.0012;      // ≈ -64 dBFS rms before the AGC boost
  const hissHp = ac.createBiquadFilter(); hissHp.type = 'highpass'; hissHp.frequency.value = 900;
  hiss.connect(hissHp); hissHp.connect(hissG); hissG.connect(input);
  const wind = ac.createBufferSource(); wind.buffer = nb; wind.loop = true; wind.loopEnd = nb.duration - 0.05; wind.playbackRate.value = 0.5;
  const windLp = ac.createBiquadFilter(); windLp.type = 'lowpass'; windLp.frequency.value = 220; windLp.Q.value = 0.9;
  const windG = ac.createGain(); windG.gain.value = 0;
  wind.connect(windLp); windLp.connect(windG); windG.connect(input);
  hiss.start(); wind.start(ac.currentTime, 1.1);

  m.input = input; m.output = post; m.ear = ear; m.master = master; m.lp = lp;
  m.setMaster = (v) => { master.gain.setTargetAtTime(v, ac.currentTime, 0.05); };
  m.setTier = (t) => { lp.frequency.value = t === 'vlow' ? 7800 : 8500; };
  /** wind/handling rumble level 0..1 (fast movement, turning) */
  let windLevel = 0;
  m.setWind = (v) => {
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(v - windLevel) < 0.02) return;
    windLevel = v;
    const t = ac.currentTime;
    windG.gain.setTargetAtTime(v * v * 0.09, t, 0.15);
    windLp.frequency.setTargetAtTime(160 + v * 260, t, 0.2);
  };
  /** muffle what reaches the ear (pause / death / after a very close shot): cutoff Hz, recover τ (0 = hold) */
  m.muffle = (hz, recover = 0, hold = 0) => {
    const t = ac.currentTime, f = ear.frequency;
    f.cancelScheduledValues(t); f.setValueAtTime(f.value, t);
    f.setTargetAtTime(hz, t, 0.015);
    if (recover > 0) f.setTargetAtTime(20000, t + 0.05 + hold, recover);
  };
  /** brief high ear-ring (subtle; level 0..1) */
  m.ring = (level = 0.5, dur = 2.2) => {
    const t = ac.currentTime;
    const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 3700 + Math.random() * 500; o2.frequency.value = o.frequency.value * 1.013;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.012 * level, t + 0.04);
    g.gain.setTargetAtTime(0, t + 0.3, dur / 4);
    o.connect(g); o2.connect(g); g.connect(post);
    o.start(t); o2.start(t); o.stop(t + dur * 1.6); o2.stop(t + dur * 1.6);
    o.onended = () => { g.disconnect(); };
    m.muffle(1700 + (1 - level) * 3000, dur / 5, 0.15);
  };
  m.hissGain = hissG;
  return m;
}
