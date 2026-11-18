// Bodycam microphone processor (AudioWorklet), shipped as a source string and loaded from a Blob URL so it
// needs no separate file on the (sub-path) server. Stereo-linked automatic gain control with fast attack,
// hold and slow dB-linear release (pumping, noise-floor rise), overload dropout on the hardest transients,
// asymmetric soft clipping into an ADC ceiling, and a mild lossy-codec top end (masked high band dropped
// in ~10 ms blocks). Posts the current AGC gain about 20 times per second.

export const MIC_PROCESSOR = 'bodycam-mic';

export const MIC_WORKLET_SRC = `
class BodycamMic extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.p = Object.assign({
      target: 0.3, maxGain: 26, minGain: 0.03, attack: 0.002, hold: 0.16, releaseDb: 14,
      detRelease: 0.05, dropThresh: 2.6, dropMin: 0.008, dropMax: 0.022, dropDepth: 0.12, dropCooldown: 0.35,
      codec: 0.55, codecHz: 7000, ceiling: 0.97, enabled: 1,
    }, o);
    this.env = 0; this.g = this.p.maxGain * 0.5; this.holdN = 0;
    this.dropN = 0; this.dropG = 1; this.dropCool = 0;
    this.hx = 0; this.hy = 0;
    this.lpL = 0; this.lpR = 0; this.hbG = 1; this.hbT = 1; this.blk = 0; this.eHb = 0; this.eAll = 0;
    this.seed = 12345; this.rep = 0; this.minSeen = 99;
    this.port.onmessage = (e) => { if (e.data && typeof e.data === 'object') Object.assign(this.p, e.data); };
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  process(inputs, outputs) {
    const out = outputs[0]; if (!out || !out.length) return true;
    const inp = inputs[0] || [];
    const L = inp[0], R = inp[1] || inp[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length, sr = sampleRate, p = this.p;
    const kAtk = 1 - Math.exp(-1 / (p.attack * sr));
    const kDetA = 1 - Math.exp(-1 / (0.0002 * sr)), kDetR = Math.exp(-1 / (p.detRelease * sr));
    const relMul = Math.pow(10, p.releaseDb / 20 / sr);
    const holdS = Math.floor(p.hold * sr);
    const hpA = Math.exp(-2 * Math.PI * 160 / sr);
    const lpA = Math.exp(-2 * Math.PI * p.codecHz / sr);
    const kDrop = 1 - Math.exp(-1 / (0.0008 * sr)), kHb = 1 - Math.exp(-1 / (0.003 * sr));
    for (let i = 0; i < n; i++) {
      const xl = L ? L[i] : 0, xr = R ? R[i] : 0;
      // detector: high-passed mono sum peak + raw stereo peak (so low rumble pumps less)
      const m = 0.5 * (xl + xr);
      const hy = m - this.hx + hpA * this.hy; this.hx = m; this.hy = hy;
      const lvl = Math.max(Math.abs(hy) * 1.2, Math.max(Math.abs(xl), Math.abs(xr)) * 0.6);
      this.env = lvl > this.env ? this.env + (lvl - this.env) * kDetA : this.env * kDetR;
      if (p.enabled) {
        const want = Math.min(p.maxGain, Math.max(p.minGain, p.target / Math.max(this.env, 1e-7)));
        if (want < this.g) { this.g += (want - this.g) * kAtk; this.holdN = holdS; }
        else if (this.holdN > 0) this.holdN--;
        else this.g = Math.min(want, this.g * relMul);
      } else this.g = 1;
      let yl = xl * this.g, yr = xr * this.g;
      // overload dropout: the converter/AGC briefly collapses on the hardest hits
      const pk = Math.max(Math.abs(yl), Math.abs(yr));
      if (this.dropCool > 0) this.dropCool--;
      if (pk > p.dropThresh && this.dropCool === 0 && this.dropN === 0) {
        this.dropN = Math.floor((p.dropMin + this.rnd() * (p.dropMax - p.dropMin)) * sr);
        this.dropCool = Math.floor(p.dropCooldown * sr);
      }
      const dT = this.dropN > 0 ? p.dropDepth : 1; if (this.dropN > 0) this.dropN--;
      this.dropG += (dT - this.dropG) * kDrop;
      yl *= this.dropG; yr *= this.dropG;
      // asymmetric soft clip (positive side has more headroom), then hard ADC ceiling
      yl = this.clip(yl); yr = this.clip(yr);
      // codec: split off the high band; in blocks where it is small relative to the full band, attenuate it
      this.lpL = yl + lpA * (this.lpL - yl); this.lpR = yr + lpA * (this.lpR - yr);
      const hl = yl - this.lpL, hr = yr - this.lpR;
      this.eHb += hl * hl + hr * hr; this.eAll += yl * yl + yr * yr;
      if (++this.blk >= 480) {
        const ratio = this.eHb / (this.eAll + 1e-12);
        const masked = ratio < 0.02 ? 1 : ratio < 0.08 ? 0.5 : 0;
        this.hbT = 1 - p.codec * masked * (0.4 + 0.6 * this.rnd());
        this.blk = 0; this.eHb = 0; this.eAll = 0;
      }
      this.hbG += (this.hbT - this.hbG) * kHb;
      oL[i] = this.lpL + hl * this.hbG;
      if (oR !== oL) oR[i] = this.lpR + hr * this.hbG;
    }
    if (this.g < this.minSeen) this.minSeen = this.g;
    if ((this.rep += n) >= 2400) { this.rep = 0; this.port.postMessage({ g: this.g, min: this.minSeen }); this.minSeen = 99; }
    return true;
  }
  clip(x) {
    const c = this.p.ceiling;
    if (x >= 0) { const k = 0.62; if (x > k) x = k + (c - k) * Math.tanh((x - k) / (c - k)); }
    else { const k = 0.55, cc = c * 0.94; if (-x > k) x = -(k + (cc - k) * Math.tanh((-x - k) / (cc - k))); }
    return x;
  }
}
registerProcessor('bodycam-mic', BodycamMic);
`;
