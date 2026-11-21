// Bodycam microphone AGC + preamp overload, as one DSP class that runs inside an AudioWorklet (the source of
// the class is shipped to the worklet as a Blob, so it needs no bundling) and in Node tests unchanged.
//
// Model of a chest-mounted bodycam mic:
//  1. preamp overload: the capsule/preamp saturates hard above `clip` (a close gunshot comes out as a flat-topped,
//     harsh transient — the signature of real bodycam footage);
//  2. AGC: feed-forward peak detector; the gain drops within ~2 ms when the input gets loud ("ducks everything
//     after a shot") and recovers slowly in the dB domain (τ ≈ 0.45 s → ~1.3 s back to normal once the room has stopped ringing, audible pumping of the
//     room tone); in quiet passages the gain rises up to +`boost` dB so the room tone and hiss come up;
//  3. output safety: smooth limiter at 0.97 so the output can never clip / exceed ±1.
// Output 0 = processed stereo, output 1 = the gain trace (linear) for test harnesses.
export class AgcCore {
  constructor(sampleRate, p = {}) {
    this.sr = sampleRate;
    this.clip = p.clip ?? 0.6;          // preamp knee (linear)
    this.target = p.target ?? -22;      // dBFS the AGC aims at for loud material
    this.ratio = p.ratio ?? 0.62;       // fraction of the excess above target that is removed (≈ 2.6:1)
    this.quiet = p.quiet ?? -46;        // below this the gain rises ...
    this.boost = p.boost ?? 8;          // ... up to +boost dB
    this.floor = p.floor ?? -26;        // deepest duck (dB)
    this.atk = Math.exp(-1 / (0.0005 * sampleRate));   // detector attack 0.5 ms
    this.rel = Math.exp(-1 / (0.09 * sampleRate));     // detector release 90 ms
    this.gAtk = Math.exp(-1 / (0.002 * sampleRate));   // gain falls in ~2 ms
    this.gRel = Math.exp(-1 / ((p.recover ?? 0.45) * sampleRate)); // gain recovers with τ (dB domain)
    this.hold = Math.round((p.hold ?? 0.12) * sampleRate);
    this.env = 0; this.gdb = 0; this.holdN = 0; this.minGdb = 0;
  }
  // smooth saturation: linear up to k, then tanh into [k, 1)
  static sat(x, k) {
    const a = x < 0 ? -x : x;
    if (a <= k) return x;
    const y = k + (1 - k) * Math.tanh((a - k) / (1 - k));
    return x < 0 ? -y : y;
  }
  process(inL, inR, outL, outR, gOut, n) {
    const k = this.clip;
    let env = this.env, gdb = this.gdb, holdN = this.holdN;
    const atk = this.atk, rel = this.rel, gAtk = this.gAtk, gRel = this.gRel;
    for (let i = 0; i < n; i++) {
      // preamp overload (on the raw mic signal)
      const l = AgcCore.sat(inL[i], k), r = AgcCore.sat(inR ? inR[i] : inL[i], k);
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
      const lev = 20 * Math.log10(env + 1e-7);
      let want;
      if (lev > this.target) want = -(lev - this.target) * this.ratio;
      else if (lev < this.quiet) want = Math.min(this.boost, (this.quiet - lev) * 0.5);
      else want = 0;
      if (want < this.floor) want = this.floor;
      if (want < gdb) { gdb = gAtk * gdb + (1 - gAtk) * want; holdN = this.hold; }
      else if (holdN > 0) holdN--;
      else gdb = gRel * gdb + (1 - gRel) * want;
      if (gdb < this.minGdb) this.minGdb = gdb;
      const g = Math.pow(10, gdb / 20);
      outL[i] = AgcCore.sat(l * g, 0.85) * 0.97;
      if (outR) outR[i] = AgcCore.sat(r * g, 0.85) * 0.97;
      if (gOut) gOut[i] = g;
    }
    this.env = env; this.gdb = gdb; this.holdN = holdN;
  }
}

/** source of the AudioWorklet module (registered as 'bodycam-agc') */
export function agcWorkletSource() {
  return `${AgcCore.toString()}
class BodycamAgc extends AudioWorkletProcessor {
  constructor(o) { super(); this.core = new AgcCore(sampleRate, (o && o.processorOptions) || {}); this.n = 0;
    this.zero = new Float32Array(128);
    this.port.onmessage = (e) => { const d = e.data || {}; if (d.set) Object.assign(this.core, d.set); }; }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0], g = outputs[1] && outputs[1][0];
    const n = o[0].length;
    let inL = i && i[0];
    if (!inL) { if (this.zero.length !== n) this.zero = new Float32Array(n); inL = this.zero; }
    this.core.process(inL, (i && i[1]) || inL, o[0], o[1] || null, g || null, n);
    return true;
  }
}
registerProcessor('bodycam-agc', BodycamAgc);`;
}
