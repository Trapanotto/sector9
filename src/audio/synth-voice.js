// Formant voice synthesiser: glottal-pulse source (Rosenberg/LF-like flow derivative with jitter,
// shimmer, aspiration and roughness) into a cascade of Klatt resonators with interpolated formant
// targets, plus parallel frication and plosive bursts. Renders shouts, call-outs, grunts, death groans
// and garbled radio dispatch. Pure functions -> Float32Array.
import { TAU, rr, lerp, clamp, Biquad, filt, fadeEdges, normalize, dcBlock, valueNoise, sanitize } from './dsp.js';

// Male formant targets F1..F4 (Hz). Upper case = lax/open variants.
const VOW = {
  a: [740, 1180, 2450, 3300], A: [680, 1100, 2400, 3300], e: [450, 1950, 2550, 3400], E: [590, 1750, 2500, 3400],
  i: [290, 2250, 3000, 3600], I: [390, 1950, 2600, 3500], o: [460, 850, 2400, 3300], O: [590, 920, 2450, 3300],
  u: [320, 780, 2250, 3200], U: [420, 980, 2350, 3250], y: [300, 1650, 2200, 3300], '@': [540, 1450, 2450, 3350],
};
const BW = [85, 105, 150, 220];
// consonants: kind, frication centre / q, duration (s), voiced
const CONS = {
  h: { k: 'asp', d: 0.06 }, s: { k: 'fric', f: 6000, q: 1.5, d: 0.09 }, S: { k: 'fric', f: 3200, q: 1.3, d: 0.09 },
  f: { k: 'fric', f: 5000, q: 0.6, d: 0.07, a: 0.35 }, x: { k: 'fric', f: 1800, q: 1.4, d: 0.08 },
  t: { k: 'plos', f: 4200, d: 0.05 }, k: { k: 'plos', f: 1900, d: 0.055 }, p: { k: 'plos', f: 900, d: 0.05 },
  d: { k: 'plos', f: 3800, d: 0.03, v: true }, g: { k: 'plos', f: 1700, d: 0.035, v: true }, b: { k: 'plos', f: 800, d: 0.03, v: true },
  m: { k: 'nas', F: [260, 1000, 2200, 3200], d: 0.07 }, n: { k: 'nas', F: [260, 1500, 2500, 3300], d: 0.06 },
  N: { k: 'nas', F: [260, 1900, 2400, 3300], d: 0.07 }, l: { k: 'liq', F: [360, 1100, 2600, 3300], d: 0.06 },
  r: { k: 'liq', F: [450, 1300, 1800, 3200], d: 0.05 }, v: { k: 'fric', f: 4000, q: 0.6, d: 0.05, v: true, a: 0.2 },
  j: { k: 'liq', F: [300, 2100, 2900, 3500], d: 0.05 },
};

/** Speaker profile from a seed: pitch, vocal tract scale, breathiness, roughness. */
export function makeProfile(r, kind = 'male') {
  if (kind === 'dispatch') return { f0: rr(r, 185, 215), fs: rr(r, 1.12, 1.2), breath: rr(r, 0.15, 0.25), rough: 0.02, oq: 0.55 };
  if (kind === 'player') return { f0: rr(r, 110, 120), fs: 1.0, breath: 0.22, rough: 0.08, oq: 0.5 };
  return { f0: rr(r, 98, 142), fs: rr(r, 0.92, 1.07), breath: rr(r, 0.08, 0.3), rough: rr(r, 0.03, 0.2), oq: rr(r, 0.45, 0.58) };
}

/**
 * Parse a phoneme string into timed segments. Vowels may be followed by ':' (long).
 * opts: { rate (duration scale), stressLast, f0 contour fn (x 0..1 over utterance) }
 */
function plan(str, r, rate = 1) {
  const segs = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === ' ') { segs.push({ k: 'pause', d: rr(r, 0.05, 0.1) * rate }); continue; }
    if (c === ':') continue;
    const long = str[i + 1] === ':';
    if (VOW[c]) segs.push({ k: 'v', F: VOW[c], d: (long ? rr(r, 0.16, 0.24) : rr(r, 0.08, 0.12)) * rate });
    else if (CONS[c]) segs.push({ ...CONS[c], d: CONS[c].d * rate * rr(r, 0.85, 1.15) });
  }
  return segs;
}

/**
 * Core renderer.
 * o: { profile, segs, f0Fn(x)->multiplier, effort 0..1 (pressed/loud), fryEnd (s), gain, breathy extra }
 */
function render(sr, r, o) {
  const P = o.profile, segs = o.segs;
  const total = segs.reduce((s, g) => s + g.d, 0);
  const tail = 0.12 + (o.fryEnd || 0);
  const n = Math.floor((total + tail + 0.02) * sr), out = new Float32Array(n);
  // control tracks per sample (computed per 16-sample block)
  const effort = o.effort ?? 0.6;
  const oq = clamp(lerp(P.oq + 0.1, P.oq - 0.15, effort) + (o.breathy || 0) * 0.2, 0.3, 0.8);
  const bwK = 1 + effort * 0.35;
  const fsk = P.fs * (1 + effort * 0.06);
  // build target timeline
  const marks = []; let t = 0.01;
  for (const g of segs) { marks.push({ t0: t, t1: t + g.d, g }); t += g.d; }
  const tEnd = t;
  const res = [0, 1, 2, 3].map(() => ({ a: 0, b: 0, c: 0, y1: 0, y2: 0 }));
  const setRes = (R, F, B) => {
    F = Math.min(F, sr * 0.45);
    const C = -Math.exp(-2 * Math.PI * B / sr), Bc = 2 * Math.exp(-Math.PI * B / sr) * Math.cos(TAU * F / sr);
    R.a = 1 - Bc - C; R.b = Bc; R.c = C;
  };
  const fric = new Biquad(sr, 'bandpass', 4000, 1);
  const F = [500, 1500, 2500, 3300], Ft = [500, 1500, 2500, 3300];
  let av = 0, ah = 0, af = 0, avT = 0, ahT = 0, afT = 0;
  let phase = 0, period = sr / P.f0, pAmp = 1, sub = 1, gPrev = 0;
  const drift = valueNoise(r, 4, total + 1);
  let mi = 0, burst = 0, f0 = P.f0;
  const lastV = segs.slice().reverse().find((g) => g.k === 'v');
  for (let i = 0; i < n; i++) {
    const ts = i / sr;
    if ((i & 15) === 0) {
      while (mi < marks.length - 1 && ts > marks[mi].t1) mi++;
      const m = marks[mi], g = m.g;
      const inSeg = ts >= m.t0 && ts <= m.t1;
      const after = ts > tEnd;
      // targets
      avT = 0; ahT = 0; afT = 0;
      if (!after && inSeg) {
        if (g.k === 'v') { for (let k = 0; k < 4; k++) Ft[k] = g.F[k] * fsk; avT = 1; ahT = P.breath * 0.4 + (o.breathy || 0); }
        else if (g.k === 'nas' || g.k === 'liq') { for (let k = 0; k < 4; k++) Ft[k] = g.F[k] * fsk; avT = g.k === 'nas' ? 0.45 : 0.7; }
        else if (g.k === 'asp') { ahT = 0.9; }
        else if (g.k === 'fric') { afT = g.a ?? 0.6; avT = g.v ? 0.35 : 0; fric.set('bandpass', g.f * Math.sqrt(fsk), g.q); }
        else if (g.k === 'plos') {
          const x = (ts - m.t0) / g.d;
          avT = g.v ? 0.15 : 0;
          if (x > 0.7 && burst === 0) { burst = Math.floor(0.008 * sr); fric.set('bandpass', g.f * Math.sqrt(fsk), 0.9); }
          if (x > 0.7) ahT = g.v ? 0.2 : 0.7;
        }
      } else if (after && o.fryEnd && lastV && ts < tEnd + o.fryEnd) {
        avT = 0.35 * (1 - (ts - tEnd) / o.fryEnd); ahT = 0.2;
      }
      // smooth transitions (~12 ms for amplitudes, ~30 ms for formants)
      const ka = 1 - Math.exp(-16 / (0.012 * sr)), kf = 1 - Math.exp(-16 / (0.03 * sr));
      av += (avT - av) * ka; ah += (ahT - ah) * ka; af += (afT - af) * ka;
      for (let k = 0; k < 4; k++) { F[k] += (Ft[k] - F[k]) * kf; setRes(res[k], F[k], BW[k] * bwK * (k === 0 && ah > 0.5 ? 1.6 : 1)); }
      const x = clamp(ts / Math.max(tEnd, 0.01), 0, 1);
      f0 = P.f0 * (o.f0Fn ? o.f0Fn(x) : 1) * (1 + 0.012 * drift(ts));
      if (ts > tEnd && o.fryEnd) f0 *= lerp(0.7, 0.45, Math.min(1, (ts - tEnd) / o.fryEnd));
    }
    phase += 1 / period;
    if (phase >= 1) {
      phase -= 1;
      const jit = 1 + (r() * 2 - 1) * (0.012 + P.rough * 0.03 + (ts > tEnd ? 0.12 : 0));
      period = sr / (f0 * jit);
      pAmp = 1 + (r() * 2 - 1) * (0.06 + P.rough * 0.15);
      sub = P.rough * effort > 0.05 && r() < 0.5 ? (sub > 0 ? -1 : 1) : 1;
    }
    const Tn = oq * (0.32 - 0.16 * effort), Tp = oq - Tn;
    let g;
    if (phase < Tp) g = 0.5 - 0.5 * Math.cos(Math.PI * phase / Tp);
    else if (phase < oq) g = Math.cos(0.5 * Math.PI * (phase - Tp) / Tn);
    else g = 0;
    const dg = (g - gPrev) * period * 0.15; gPrev = g;
    const roughAmp = 1 + (sub < 0 ? -P.rough * effort * 0.6 : 0);
    const nz = r() * 2 - 1;
    let src = dg * av * pAmp * roughAmp + nz * ah * (0.25 + 0.75 * g) * 0.35;
    // cascade formants
    for (let k = 0; k < 4; k++) { const R = res[k]; const y = R.a * src + R.b * R.y1 + R.c * R.y2; R.y2 = R.y1; R.y1 = y; src = y; }
    // parallel frication / burst
    let fz = 0;
    if (af > 0.002) fz += fric.run(nz) * af * 0.5;
    if (burst > 0) { fz += fric.run(nz) * 0.9 * (burst / (0.008 * sr)); burst--; }
    out[i] = src + fz;
  }
  sanitize(out);
  dcBlock(out, sr, 60);
  // the cascade alone is too dark: restore the 2-5 kHz edge of a raised voice (more with effort)
  filt(out, sr, 'highshelf', 1500, 0.7, 5 + 8 * effort);
  filt(out, sr, 'peaking', 3000, 1.0, 3 + 6 * effort);
  filt(out, sr, 'lowpass', 8000, 0.7);
  fadeEdges(out, sr, 0.004, 0.03);
  return normalize(out, o.gain ?? 1);
}

const CALLS = [
  'he:', 'da:', 'hi:r', 'lo:s lo:s', 'kOntakt', 'dEkuN', 'halt', 'da: dry:bm', 'he: du:', 'a:larm', 'vo: i:st e:r', 'Sne:l',
];
/** Alarmed call-out / shout. */
export function genShout(sr, r, profile) {
  const str = CALLS[Math.floor(r() * CALLS.length)];
  const segs = plan(str, r, rr(r, 0.9, 1.15));
  const peak = rr(r, 1.7, 2.1), fall = rr(r, 0.7, 0.85);
  const f0Fn = (x) => x < 0.15 ? lerp(1.4, peak, x / 0.15) : lerp(peak, peak * fall, Math.pow((x - 0.15) / 0.85, 1.5));
  return render(sr, r, { profile, segs, f0Fn, effort: rr(r, 0.8, 1), gain: 1 });
}

/** Effort/pain grunt. pain: longer, more open, falling. */
export function genGrunt(sr, r, profile, pain = true) {
  const vow = pain ? (r() < 0.5 ? 'A' : 'E') : (r() < 0.5 ? '@' : 'U');
  const segs = [{ k: 'asp', d: rr(r, 0.015, 0.035) }, { k: 'v', F: VOW[vow], d: pain ? rr(r, 0.18, 0.32) : rr(r, 0.1, 0.16) }];
  if (r() < 0.4) segs.push({ k: 'v', F: VOW['@'], d: rr(r, 0.06, 0.12) });
  const hi = pain ? rr(r, 1.35, 1.7) : rr(r, 1.1, 1.3), lo = hi * rr(r, 0.62, 0.72);
  const f0Fn = (x) => lerp(hi, lo, Math.pow(x, 0.8));
  return render(sr, r, { profile, segs, f0Fn, effort: 0.95, fryEnd: rr(r, 0.06, 0.14), gain: 1 });
}

/** Death: sharp gasp, then a breathy falling groan into fry and exhale. */
export function genDeathVoice(sr, r, profile) {
  const segs = [
    { k: 'asp', d: rr(r, 0.12, 0.2) },
    { k: 'v', F: VOW[r() < 0.5 ? 'O' : 'A'], d: rr(r, 0.25, 0.4) },
    { k: 'v', F: VOW['@'], d: rr(r, 0.2, 0.35) },
    { k: 'asp', d: rr(r, 0.15, 0.25) },
  ];
  const f0Fn = (x) => lerp(1.3, 0.62, Math.pow(x, 0.7));
  return render(sr, r, { profile, segs, f0Fn, effort: 0.55, breathy: 0.35, fryEnd: rr(r, 0.15, 0.25), gain: 1 });
}

const SYL_C = ['d', 't', 'k', 'n', 'm', 'v', 'S', 's', 'f', 'b', 'g', 'l', 'r', 'h', ''];
const SYL_V = ['a', 'e', 'i', 'o', 'u', 'E', 'I', 'O', 'U', '@', '@', 'a', 'y'];
const SYL_E = ['', '', '', 'n', 't', 's', 'x', 'r', 'l', 'm', 'k'];
/** Garbled speech-like stream (dispatch). */
export function genSpeech(sr, r, profile, seconds) {
  let str = '';
  let t = 0;
  while (t < seconds) {
    const words = 1 + Math.floor(r() * 3);
    for (let w = 0; w < words; w++) {
      const syl = 1 + Math.floor(r() * 3);
      for (let s = 0; s < syl; s++) {
        str += SYL_C[Math.floor(r() * SYL_C.length)] + SYL_V[Math.floor(r() * SYL_V.length)] + (r() < 0.3 ? ':' : '') + SYL_E[Math.floor(r() * SYL_E.length)];
        t += 0.2;
      }
      str += ' ';
    }
    t += 0.05;
  }
  const segs = plan(str, r, 0.8);
  // declination with phrase accents
  const acc = valueNoise(r, 3, 4);
  const f0Fn = (x) => (1.12 - 0.25 * x) * (1 + 0.12 * acc(x * seconds));
  return render(sr, r, { profile, segs, f0Fn, effort: 0.45, gain: 1 });
}

/** Full police radio burst: squelch open, band-limited compressed chatter with fading, squelch tail. */
export function genRadio(sr, r, opts = {}) {
  const prof = makeProfile(r, r() < 0.5 ? 'dispatch' : 'male');
  if (prof.f0 < 150) { prof.f0 *= 1.1; }
  const speechLen = opts.seconds ?? rr(r, 1.2, 2.4);
  const sp = genSpeech(sr, r, prof, speechLen);
  const pre = 0.09, n = Math.floor((pre + sp.length / sr + 0.28) * sr), b = new Float32Array(n);
  const s0 = Math.floor(pre * sr);
  const fade = valueNoise(r, 6, n / sr + 1);
  for (let i = 0; i < sp.length && s0 + i < n; i++) b[s0 + i] = sp[i] * (0.8 + 0.2 * fade(i / sr));
  // radio band + AGC/compression + speaker overdrive
  filt(b, sr, 'highpass', 380, 0.7, 0, 4);
  filt(b, sr, 'lowpass', 2700, 0.7, 0, 4);
  filt(b, sr, 'peaking', 1700, 1.2, 5);
  normalize(b, 1);
  let env = 0;
  for (let i = 0; i < n; i++) {   // fast compressor
    const a = Math.abs(b[i]); env = a > env ? env + (a - env) * 0.02 : env * 0.9995;
    const g = 0.5 / Math.max(env, 0.08);
    b[i] = Math.tanh(b[i] * g * 2.2) * 0.8;
  }
  // carrier noise during transmission
  const hiss = new Biquad(sr, 'bandpass', 1800, 0.5);
  const tEnd = s0 + sp.length;
  for (let i = 0; i < tEnd && i < n; i++) b[i] += hiss.run(r() * 2 - 1) * 0.06 * Math.min(1, i / (0.005 * sr));
  // squelch open: click + short noise
  const sq = new Biquad(sr, 'bandpass', 2400, 0.4);
  for (let i = 0; i < Math.floor(0.07 * sr); i++) b[i] += sq.run(r() * 2 - 1) * 0.9 * Math.exp(-i / (0.02 * sr));
  // squelch tail: "kshh" with abrupt cut
  const tl = Math.floor(rr(r, 0.12, 0.2) * sr), sq2 = new Biquad(sr, 'bandpass', 2600, 0.35);
  for (let i = 0; i < tl && tEnd + i < n; i++) b[tEnd + i] += sq2.run(r() * 2 - 1) * 1.1 * (i < 40 ? i / 40 : 1);
  filt(b, sr, 'highpass', 300, 0.7);
  filt(b, sr, 'lowpass', 4500, 0.7);
  fadeEdges(b, sr, 0.0008, 0.004);
  return normalize(b, 1);
}
