// Pure DSP helpers used to render sounds into Float32Arrays. No WebAudio here, so everything can run
// at startup, in idle time, in an OfflineAudioContext harness or in Node.

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const dbToGain = (db) => Math.pow(10, db / 20);

/** Small fast seeded PRNG (mulberry32). Returns () => [0,1). */
export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rr = (r, a, b) => a + r() * (b - a);
export const rsign = (r) => (r() < 0.5 ? -1 : 1);
/** Approximately gaussian (sum of 3 uniforms), unit-ish variance. */
export const gauss = (r) => (r() + r() + r() - 1.5) * 2;

// ---------------------------------------------------------------------------------- filters
/** RBJ cookbook biquad, direct form I. set() may be called per block for sweeps. */
export class Biquad {
  constructor(sr, type = 'lowpass', f = 1000, q = 0.707, gainDb = 0) {
    this.sr = sr; this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type, f, q, gainDb);
  }
  set(type, f, q = 0.707, gainDb = 0) {
    const sr = this.sr;
    f = clamp(f, 5, sr * 0.49);
    const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * Math.max(q, 1e-3));
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break; // 0 dB peak
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; // lowpass
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  process(buf, s = 0, e = buf.length) { for (let i = s; i < e; i++) buf[i] = this.run(buf[i]); return buf; }
}

/** In-place static filter; order 2 or 4 (cascaded). */
export function filt(buf, sr, type, f, q = 0.707, gainDb = 0, order = 2) {
  new Biquad(sr, type, f, q, gainDb).process(buf);
  if (order >= 4) new Biquad(sr, type, f, q, gainDb).process(buf);
  return buf;
}
/** One-pole lowpass in place (6 dB/oct, gentle damping). */
export function onePoleLP(buf, sr, f, s = 0, e = buf.length) {
  const a = Math.exp(-TAU * f / sr); let y = 0;
  for (let i = s; i < e; i++) { y = buf[i] + a * (y - buf[i]); buf[i] = y; }
  return buf;
}
/** Remove DC / sub-sonic drift (one-pole highpass at fc). */
export function dcBlock(buf, sr, fc = 12) {
  const R = Math.exp(-TAU * fc / sr); let x1 = 0, y1 = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; const y = x - x1 + R * y1; x1 = x; y1 = y; buf[i] = y; }
  return buf;
}

// ---------------------------------------------------------------------------------- generators
export function noise(n, r) { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = r() * 2 - 1; return b; }

/** Add a damped sinusoid (one vibrational mode). Short raised-cosine attack avoids clicks. */
export function addMode(buf, sr, t0, f, tau, amp, atk = 0.0004, phase = 0) {
  const s0 = Math.floor(t0 * sr); if (s0 >= buf.length || f >= sr * 0.48 || amp === 0) return;
  const n = Math.min(buf.length - s0, Math.ceil(tau * 7 * sr));
  const w = TAU * f / sr, dec = Math.exp(-1 / (tau * sr));
  const na = Math.max(1, Math.floor(atk * sr));
  // recursive oscillator: s[n] = 2cos(w)s[n-1] - s[n-2]
  const c2 = 2 * Math.cos(w);
  let s1 = Math.sin(phase - w), s2 = Math.sin(phase - 2 * w), g = amp;
  for (let i = 0; i < n; i++) {
    const s = c2 * s1 - s2; s2 = s1; s1 = s;
    const a = i < na ? 0.5 - 0.5 * Math.cos(Math.PI * i / na) : 1;
    buf[s0 + i] += s * g * a;
    g *= dec;
  }
}
/** Add a set of modes: ratios, relative amps, decay scale per mode. */
export function addModes(buf, sr, t0, f0, ratios, amps, taus, amp, r, detune = 0.01) {
  for (let k = 0; k < ratios.length; k++) {
    const f = f0 * ratios[k] * (1 + (r ? (r() * 2 - 1) * detune : 0));
    addMode(buf, sr, t0, f, taus[k] ?? taus[taus.length - 1], amp * (amps[k] ?? 0.3), 0.0003, r ? r() * TAU : 0);
  }
}
/**
 * Add a filtered noise burst with an attack/exponential-decay envelope.
 * o: { t, atk, tau, dur, amp, type, f, q, f2 (end freq for sweep), order }
 */
export function addBurst(buf, sr, r, o) {
  const s0 = Math.floor((o.t || 0) * sr); if (s0 >= buf.length) return;
  const tau = o.tau ?? 0.01, atk = Math.max(o.atk ?? 0.0005, 1 / sr);
  const dur = o.dur ?? (atk + tau * 7);
  const n = Math.min(buf.length - s0, Math.ceil(dur * sr));
  if (n <= 0) return;
  const tmp = new Float32Array(n);
  const hold = o.hold ?? 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = t < atk ? (0.5 - 0.5 * Math.cos(Math.PI * t / atk)) : t < atk + hold ? 1 : Math.exp(-(t - atk - hold) / tau);
    tmp[i] = (r() * 2 - 1) * e;
  }
  if (o.type) {
    const bq = new Biquad(sr, o.type, o.f, o.q ?? 0.707, o.gain ?? 0);
    const bq2 = o.order >= 4 ? new Biquad(sr, o.type, o.f, o.q ?? 0.707, o.gain ?? 0) : null;
    const sweep = o.f2 && o.f2 !== o.f;
    for (let i = 0; i < n; i++) {
      if (sweep && (i & 31) === 0) {
        const f = o.f * Math.pow(o.f2 / o.f, Math.min(1, i / n / (o.sweepFrac ?? 1)));
        bq.set(o.type, f, o.q ?? 0.707, o.gain ?? 0); if (bq2) bq2.set(o.type, f, o.q ?? 0.707, o.gain ?? 0);
      }
      let y = bq.run(tmp[i]); if (bq2) y = bq2.run(y);
      tmp[i] = y;
    }
  }
  // tail fade over the last 3 ms so truncation never clicks
  const fo = Math.min(n, Math.floor(0.003 * sr));
  for (let i = 0; i < fo; i++) tmp[n - 1 - i] *= i / fo;
  const amp = o.amp ?? 1;
  for (let i = 0; i < n; i++) buf[s0 + i] += tmp[i] * amp;
}
/** Tiny granular impact (pebble, grit, glass crumb): a couple of high damped modes plus a click. */
export function addGrain(buf, sr, r, t, f, amp, tau = 0.002) {
  addMode(buf, sr, t, f, tau, amp, 0.00015, r() * TAU);
  addMode(buf, sr, t, f * rr(r, 1.4, 2.3), tau * 0.6, amp * 0.5, 0.00015, r() * TAU);
}

// ---------------------------------------------------------------------------------- utilities
export function mixInto(dst, src, offsetS = 0, gain = 1) {
  const n = Math.min(src.length, dst.length - offsetS);
  for (let i = Math.max(0, -offsetS); i < n; i++) dst[offsetS + i] += src[i] * gain;
}
export function peakOf(buf) { let p = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; } return p; }
export function scale(buf, g) { for (let i = 0; i < buf.length; i++) buf[i] *= g; return buf; }
export function normalize(buf, peak = 1) { const p = peakOf(buf); if (p > 0) scale(buf, peak / p); return buf; }
/** Raised-cosine fades at both ends (in seconds). */
export function fadeEdges(buf, sr, inS = 0.0005, outS = 0.01) {
  const ni = Math.min(buf.length, Math.floor(inS * sr)), no = Math.min(buf.length, Math.floor(outS * sr));
  for (let i = 0; i < ni; i++) buf[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / ni);
  for (let i = 0; i < no; i++) buf[buf.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / no);
  return buf;
}
/** Trim trailing near-silence (keeps at least minS seconds) and fade the new end. */
export function trimTail(buf, sr, thresh = 1e-5, minS = 0.02) {
  let e = buf.length;
  while (e > minS * sr && Math.abs(buf[e - 1]) < thresh) e--;
  const out = e < buf.length ? buf.slice(0, Math.min(buf.length, e + Math.floor(0.005 * sr))) : buf;
  return fadeEdges(out, sr, 0, 0.004);
}
export function softClip(x, k = 1) { return Math.tanh(x * k) / Math.tanh(k); }
export function sanitize(buf) { for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) buf[i] = 0; return buf; }
/** Envelope helpers: attack-decay value at time t. */
export function adEnv(t, atk, tau) { return t < 0 ? 0 : t < atk ? 0.5 - 0.5 * Math.cos(Math.PI * t / atk) : Math.exp(-(t - atk) / tau); }
/** Smooth random control curve (value noise), n points per second, returns sampler f(t)->[-1,1]. */
export function valueNoise(r, rate, seconds) {
  const n = Math.ceil(rate * seconds) + 3, pts = new Float32Array(n);
  for (let i = 0; i < n; i++) pts[i] = r() * 2 - 1;
  return (t) => {
    const x = t * rate, i = Math.floor(x), f = x - i;
    const a = pts[Math.max(0, Math.min(n - 1, i))], b = pts[Math.max(0, Math.min(n - 1, i + 1))];
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}
