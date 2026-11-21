// Shared reverb units per IR family (see acoustics.js IR_FAMILIES). Owner: E.
//  mid/high tiers: ConvolverNodes with the recorded impulse responses (trimmed, faded, decorrelated to stereo):
//    hall ← ir.hall #1 (car park, 3.2 s), room ← ir.hall #2 (1.5 s), small ← ir.small, stair ← ir.stairwell,
//    basement ← ir.basement (first of its three impulses, low-shelf boost = "boom")
//  low/vlow tiers: two cheap algorithmic units (4 feedback combs each: "big" and "small"), no convolution.
//  outdoor (all tiers): facade slap-back + long distant echo (delay lines), no reverb tail.
// Family inputs are persistent nodes, so voice sends never need rewiring on a tier switch.
import { IR_FAMILIES } from './acoustics.js';

const IR_SPEC = {
  hall: { sound: 'ir.hall', vi: 0, len: 2.9, gain: 2.4 },
  room: { sound: 'ir.hall', vi: 1, len: 1.0, gain: 2.0 },
  small: { sound: 'ir.small', vi: 0, len: 0.5, gain: 1.3 },
  stair: { sound: 'ir.stairwell', vi: 0, len: 1.7, gain: 1.9 },
  basement: { sound: 'ir.basement', vi: 0, len: 1.45, gain: 2.6 },
};
const ALGO = { hall: 'big', basement: 'big', stair: 'big', room: 'small', small: 'small' };

/** trim/fade an IR and make it 2-channel (decorrelated copy for mono IRs) */
export function prepareIR(ac, buf, onset, len) {
  const sr = buf.sampleRate, start = Math.max(0, Math.floor((onset - 0.002) * sr));
  const n = Math.min(buf.length - start, Math.floor(len * sr));
  const out = ac.createBuffer(2, n, sr);
  const fadeFrom = Math.floor(n * 0.6);
  for (let ch = 0; ch < 2; ch++) {
    const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)), dst = out.getChannelData(ch);
    // mono IR: right channel = time-shifted (7 ms) late field, same direct sound → wide, still focussed
    const shift = buf.numberOfChannels === 1 && ch === 1 ? Math.floor(0.007 * sr) : 0;
    const direct = Math.floor(0.004 * sr);
    for (let i = 0; i < n; i++) {
      const j = start + (i > direct ? i + shift : i);
      let v = j < buf.length ? src[j] : 0;
      if (i >= fadeFrom) { const k = 1 - (i - fadeFrom) / (n - fadeFrom); v *= k * k; }
      dst[i] = v;
    }
  }
  return out;
}

export function createReverbs(ac, { tier = 'low', bank, out, log = null }) {
  const R = { mode: '', ready: null };
  const inputs = {}, units = {};
  for (const f of IR_FAMILIES) { inputs[f] = ac.createGain(); }
  // basement boom: low shelf on its input
  const boom = ac.createBiquadFilter(); boom.type = 'lowshelf'; boom.frequency.value = 160; boom.gain.value = 5;
  inputs.basement.connect(boom);
  const famOut = (f) => (f === 'basement' ? boom : inputs[f]);

  // ---- outdoor: slap + distant echo
  {
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const d1 = ac.createDelay(1), g1 = ac.createGain(); d1.delayTime.value = 0.13; g1.gain.value = 0.32;
    const d2 = ac.createDelay(2), g2 = ac.createGain(), fb = ac.createGain(), lp2 = ac.createBiquadFilter();
    d2.delayTime.value = 0.68; g2.gain.value = 0.2; fb.gain.value = 0.28; lp2.type = 'lowpass'; lp2.frequency.value = 1300;
    const pan1 = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain(); if (pan1.pan) pan1.pan.value = -0.35;
    const pan2 = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain(); if (pan2.pan) pan2.pan.value = 0.4;
    inputs.outdoor.connect(lp); lp.connect(d1); d1.connect(g1); g1.connect(pan1); pan1.connect(out);
    lp.connect(d2); d2.connect(lp2); lp2.connect(g2); g2.connect(pan2); pan2.connect(out); lp2.connect(fb); fb.connect(d2);
  }

  // ---- algorithmic units (low tiers)
  function algo(rt, sizes, damp) {
    // plain feedback combs (no filter inside the loop: a resonant biquad in a feedback cycle blew up in tests),
    // damping and stereo spread after the combs, then a short all-pass-like smear by a second delay pair
    const inp = ac.createGain(), merge = ac.createChannelMerger(2), ret = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = damp; lp.Q.value = 0.5;
    inp.gain.value = 0.25;
    ret.gain.value = rt > 1 ? 4.0 : 3.0;   // ≈ convolver loudness (harness diag3: same burst, rms within a few dB)
    sizes.forEach((d, k) => {
      const dl = ac.createDelay(0.2), fb = ac.createGain();
      dl.delayTime.value = d; fb.gain.value = Math.min(0.9, Math.pow(10, -3 * d / rt));
      inp.connect(dl); dl.connect(fb); fb.connect(dl);
      dl.connect(merge, 0, k % 2);
    });
    merge.connect(lp); lp.connect(ret);
    return { input: inp, output: ret };
  }
  units.big = algo(2.2, [0.0437, 0.0507, 0.0571, 0.0631], 3200);
  units.small = algo(0.55, [0.0213, 0.0251, 0.0289, 0.0317], 4200);
  units.big.output.connect(out); units.small.output.connect(out);

  // ---- convolvers (mid/high): created now, IR buffers set once decoded
  const conv = {};
  for (const f of Object.keys(IR_SPEC)) {
    const c = ac.createConvolver(); c.normalize = true;
    const g = ac.createGain(); g.gain.value = IR_SPEC[f].gain;
    c.connect(g); g.connect(out);
    conv[f] = { node: c, ret: g, loaded: false };
  }

  R.loadIRs = (decode, drop) => {
    R.ready = Promise.all(Object.entries(IR_SPEC).map(async ([f, sp]) => {
      const s = bank.sounds.get(sp.sound);
      const ci = s?.clips[Math.min(sp.vi, s.clips.length - 1)];
      if (ci === undefined) return;
      const c = bank.clips[ci];
      const buf = await decode(c, 0);
      if (!buf) return;
      try { conv[f].node.buffer = prepareIR(ac, buf, c.onset, sp.len); conv[f].loaded = true; }
      catch (e) { log?.(`[audio] IR ${f}: ${e?.message ?? e}`); }
    })).then(() => {
      // the trimmed copies live in the convolvers; the raw decoded IRs can go
      for (const sp of Object.values(IR_SPEC)) for (const ci of bank.sounds.get(sp.sound)?.clips ?? []) drop?.(bank.clips[ci]);
      R.setTier(R.tier ?? tier, true);
    });
    return R.ready;
  };

  R.setTier = (t, force = false) => {
    const mode = t === 'high' || t === 'mid' ? 'conv' : 'algo';
    R.tier = t;
    if (mode === R.mode && !force) return;
    R.mode = mode;
    for (const f of Object.keys(IR_SPEC)) {
      const src = famOut(f);
      src.disconnect();
      if (mode === 'conv' && conv[f].loaded) src.connect(conv[f].node);
      else src.connect(units[ALGO[f]].input);
    }
  };
  R.input = (fam) => inputs[fam] ?? null;
  R.convolverCount = () => Object.values(conv).filter((c) => c.loaded).length;
  R.setTier(tier);
  return R;
}
