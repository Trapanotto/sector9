// Weapon sound renderers: gunshot blast layers, mechanical action, bullet flyby/crack, ricochets,
// reload components and shell casings. Pure functions: (sr, rng, params) -> Float32Array.
// Amplitudes are physically motivated relative levels; the caller applies absolute calibration.
import {
  TAU, rr, addMode, addModes, addBurst, addGrain, filt, onePoleLP, dcBlock, fadeEdges, normalize, sanitize, clamp,
} from './dsp.js';

// ------------------------------------------------------------------------------------ gunshots
// Muzzle blast model: a Friedlander (N-wave-like) shock with a band-limited rise, a propellant-gas noise
// jet, a mid "crack" band, a low body resonance that sweeps down (gas expansion + mic/housing response)
// and, for the camera's own weapon, preamp blocking (a slow asymmetric sag after the overload).
export const SHOT_KINDS = {
  // player 9 mm pistol, recorded ~0.5 m behind/below the muzzle on the chest
  player: { Tp: 0.00042, b: 1.7, gas: 0.9, gasTau: 0.010, gasLP: 7500, crackF: 1900, crackQ: 0.9, crackAmp: 1.7, crackTau: 0.022,
    midF: 750, midAmp: 1.4, midTau: 0.034,
    bodyF0: 210, bodyF1: 105, bodyTau: 0.03, bodyAmp: 0.2, rumbleAmp: 0.1, rumbleTau: 0.03, rumbleLP: 300, block: 0.08, len: 0.34 },
  // enemy pistol (slightly bigger calibre, no camera blocking)
  pistol: { Tp: 0.00050, b: 1.6, gas: 0.9, gasTau: 0.011, gasLP: 7000, crackF: 1650, crackQ: 0.9, crackAmp: 1.6, crackTau: 0.024,
    midF: 680, midAmp: 1.4, midTau: 0.036,
    bodyF0: 190, bodyF1: 92, bodyTau: 0.034, bodyAmp: 0.22, rumbleAmp: 0.12, rumbleTau: 0.035, rumbleLP: 280, block: 0, len: 0.36 },
  // enemy rifle (intermediate cartridge): longer positive phase, more gas, deeper and longer body
  rifle: { Tp: 0.00062, b: 1.45, gas: 1.1, gasTau: 0.014, gasLP: 8500, crackF: 2500, crackQ: 0.8, crackAmp: 1.9, crackTau: 0.022,
    midF: 600, midAmp: 1.5, midTau: 0.032,
    bodyF0: 160, bodyF1: 70, bodyTau: 0.045, bodyAmp: 0.32, rumbleAmp: 0.18, rumbleTau: 0.05, rumbleLP: 240, block: 0, len: 0.46 },
};

/** Direct muzzle blast at the reference distance, peak-normalised to 1. */
export function genBlast(sr, r, kindName) {
  const K = SHOT_KINDS[kindName] || SHOT_KINDS.pistol;
  const v = (x, a = 0.08) => x * (1 + (r() * 2 - 1) * a);
  const n = Math.floor(K.len * sr);
  const b = new Float32Array(n);
  const t0 = 0.001; const s0 = Math.floor(t0 * sr);
  // 1) Friedlander shock with a 3-sample rise (microphone limited)
  const Tp = v(K.Tp, 0.1), bb = v(K.b, 0.1);
  const nShock = Math.floor(Tp * 14 * sr), rise = 3;
  for (let i = 0; i < nShock && s0 + i < n; i++) {
    const t = i / sr;
    const p = (1 - t / Tp) * Math.exp(-bb * t / Tp);
    const a = i < rise ? (i + 1) / (rise + 1) : 1;
    b[s0 + i] += p * a * 1.8;
  }
  // 2) propellant gas jet: broadband noise, very fast decay
  addBurst(b, sr, r, { t: t0, atk: 0.00015, tau: v(K.gasTau, 0.15), amp: K.gas, type: 'lowpass', f: v(K.gasLP, 0.1), q: 0.6 });
  // 3) mid crack band
  addBurst(b, sr, r, { t: t0, atk: 0.0002, tau: v(K.crackTau, 0.15), amp: K.crackAmp, type: 'bandpass', f: v(K.crackF, 0.12), q: K.crackQ });
  // mid body: the hollow "bang" band of the expanding gas
  addBurst(b, sr, r, { t: t0, atk: 0.0006, tau: v(K.midTau, 0.15), amp: K.midAmp, type: 'bandpass', f: v(K.midF, 0.12), q: 0.7 });
  // 4) low body: damped oscillation sweeping down
  {
    const f0 = v(K.bodyF0, 0.07), f1 = v(K.bodyF1, 0.07), tau = v(K.bodyTau, 0.12), amp = K.bodyAmp;
    const nb = Math.min(n - s0, Math.floor(tau * 8 * sr));
    let ph = 0;
    for (let i = 0; i < nb; i++) {
      const t = i / sr;
      const f = f1 + (f0 - f1) * Math.exp(-t / 0.022);
      ph += TAU * f / sr;
      const e = t < 0.0009 ? 0.5 - 0.5 * Math.cos(Math.PI * t / 0.0009) : Math.exp(-(t - 0.0009) / tau);
      b[s0 + i] += Math.sin(ph) * e * amp;
    }
  }
  // 5) low rumble noise (turbulent gas, nearby reflections smeared by the mic)
  addBurst(b, sr, r, { t: t0, atk: 0.0015, tau: v(K.rumbleTau, 0.15), amp: K.rumbleAmp * 2.2, type: 'lowpass', f: K.rumbleLP, q: 0.7, order: 4 });
  // 6) preamp blocking sag (camera's own gun only)
  if (K.block > 0) {
    const nbk = Math.min(n - s0, Math.floor(0.3 * sr)), a = v(K.block, 0.15);
    for (let i = 0; i < nbk; i++) { const t = i / sr; b[s0 + i] -= a * (Math.exp(-t / 0.045) - Math.exp(-t / 0.004)); }
  }
  dcBlock(b, sr, 18);
  sanitize(b);
  fadeEdges(b, sr, 0, 0.03);
  return normalize(b, 1);
}

/** Pre-filtered copies used for reflection taps (surfaces absorb highs; higher orders are darker). */
export function blastFamily(sr, blast) {
  const lp1 = onePoleLP(Float32Array.from(blast), sr, 5500);
  filt(lp1, sr, 'lowpass', 7000, 0.6);
  const lp2 = filt(Float32Array.from(blast), sr, 'lowpass', 2400, 0.6, 0, 4);
  const lp3 = filt(Float32Array.from(blast), sr, 'lowpass', 900, 0.6, 0, 4);
  return { full: blast, lp1, lp2, lp3 };
}

/** Slide/frame mechanics of the player's pistol, peak 1. locked: last round, slide stays back. */
export function genMech(sr, r, locked = false) {
  const n = Math.floor(0.2 * sr), b = new Float32Array(n);
  const j = (x) => x * rr(r, 0.9, 1.1);
  // unlock + rearward travel scrape
  addBurst(b, sr, r, { t: j(0.0025), atk: 0.0008, tau: 0.004, amp: 0.25, type: 'bandpass', f: rr(r, 3300, 4200), q: 1.5 });
  // casing flicked out of the port
  addModes(b, sr, j(0.007), rr(r, 4300, 4800), [1, 1.58, 2.31], [1, 0.6, 0.35], [0.012, 0.008, 0.005], 0.14, r);
  // slide hits the rear stop
  const tr = j(0.011);
  addBurst(b, sr, r, { t: tr, atk: 0.0002, tau: 0.0015, amp: 0.55, type: 'highpass', f: 1500 });
  addModes(b, sr, tr, rr(r, 1250, 1420), [1, 2.21, 3.67, 5.4], [1, 0.7, 0.45, 0.25], [0.02, 0.014, 0.01, 0.006], locked ? 0.9 : 0.45, r);
  if (!locked) {
    const tf = tr + rr(r, 0.011, 0.015);   // forward into battery, strips the next round
    addBurst(b, sr, r, { t: tf - 0.004, atk: 0.001, tau: 0.002, amp: 0.15, type: 'bandpass', f: 2600, q: 2 });
    addBurst(b, sr, r, { t: tf, atk: 0.0002, tau: 0.002, amp: 0.8, type: 'bandpass', f: 3000, q: 0.8 });
    addModes(b, sr, tf, rr(r, 1800, 2050), [1, 1.87, 3.1, 4.6], [1, 0.6, 0.5, 0.3], [0.03, 0.02, 0.012, 0.008], 0.7, r);
    addMode(b, sr, tf, rr(r, 360, 420), 0.025, 0.35);
    addMode(b, sr, tf, rr(r, 900, 1010), 0.045, 0.06);
  } else {
    addMode(b, sr, tr, rr(r, 330, 380), 0.03, 0.4);
    addBurst(b, sr, r, { t: tr + 0.003, atk: 0.0003, tau: 0.003, amp: 0.3, type: 'bandpass', f: 2200, q: 1.2 });
  }
  dcBlock(b, sr, 40);
  fadeEdges(b, sr, 0.0005, 0.02);
  return normalize(b, 1);
}

/** Supersonic crack (rifle) or transonic snap + zip (pistol) of a bullet passing close by. */
export function genFlyby(sr, r, kind = 'rifle') {
  const n = Math.floor(0.4 * sr), b = new Float32Array(n);
  const t0 = 0.002, s0 = Math.floor(t0 * sr);
  const rifle = kind === 'rifle';
  // N-wave: linear ramp from +A to -A with near-instant shocks at both ends
  const T = rifle ? rr(r, 0.00018, 0.00028) : rr(r, 0.00012, 0.00018);
  const A = rifle ? 1 : 0.55, nT = Math.max(4, Math.floor(T * sr));
  for (let i = 0; i <= nT; i++) b[s0 + i] += A * (1 - 2 * i / nT) * (i === 0 ? 0.6 : 1);
  b[s0 + nT + 1] += -A * 0.4;
  // snap: short HF burst
  addBurst(b, sr, r, { t: t0, atk: 0.0001, tau: rifle ? 0.0025 : 0.0018, amp: rifle ? 0.45 : 0.3, type: 'highpass', f: 1800 });
  // zip / whizz: Doppler-swept turbulent wake
  addBurst(b, sr, r, { t: t0 + 0.001, atk: rifle ? 0.002 : 0.006, tau: rifle ? 0.02 : 0.045, amp: rifle ? 0.1 : 0.32,
    type: 'bandpass', f: rifle ? 6000 : 4800, f2: rifle ? 2200 : 1100, q: 1.6 });
  if (!rifle) addBurst(b, sr, r, { t: t0 + 0.002, atk: 0.008, tau: 0.035, amp: 0.12, type: 'bandpass', f: 900, f2: 600, q: 3 });
  dcBlock(b, sr, 60);
  fadeEdges(b, sr, 0.001, 0.05);
  return normalize(b, 1);
}

/** Ricochet: impact tick + tumbling-bullet whine. variant 0 whine, 1 buzz, 2 short zip. */
export function genRicochet(sr, r, variant = 0) {
  const dur = variant === 0 ? rr(r, 0.35, 0.6) : variant === 1 ? rr(r, 0.25, 0.4) : rr(r, 0.12, 0.2);
  const n = Math.floor((dur + 0.05) * sr), b = new Float32Array(n);
  addBurst(b, sr, r, { t: 0.001, atk: 0.0002, tau: 0.002, amp: 0.7, type: 'highpass', f: 2500 });
  const f0 = variant === 1 ? rr(r, 700, 1000) : rr(r, 2600, 4200);
  const f1 = f0 * (variant === 2 ? rr(r, 0.55, 0.7) : rr(r, 0.35, 0.55));
  const tumble = variant === 1 ? rr(r, 60, 110) : rr(r, 15, 40), amDepth = variant === 1 ? 0.8 : 0.35;
  const s0 = Math.floor(0.004 * sr), ns = Math.floor(dur * sr);
  let ph = 0, tph = 0;
  for (let i = 0; i < ns && s0 + i < n; i++) {
    const x = i / ns, t = i / sr;
    const f = f0 * Math.pow(f1 / f0, Math.pow(x, 0.7)) * (1 + 0.004 * Math.sin(t * 37));
    ph += TAU * f / sr; tph += TAU * tumble / sr;
    const env = Math.min(1, t / 0.006) * Math.pow(1 - x, 1.6);
    const am = 1 - amDepth * (0.5 + 0.5 * Math.sin(tph));
    const s = Math.sin(ph) + 0.3 * Math.sin(2 * ph + 0.7) + (variant === 1 ? 0.35 * Math.sign(Math.sin(ph)) : 0);
    b[s0 + i] += s * env * am * 0.35;
  }
  // airy whistle noise following the tone
  addBurst(b, sr, r, { t: 0.004, atk: 0.01, tau: dur * 0.35, amp: 0.15, type: 'bandpass', f: f0, f2: f1, q: 6 });
  filt(b, sr, 'highpass', 300, 0.7);
  fadeEdges(b, sr, 0.0005, 0.03);
  return normalize(b, 1);
}

// ------------------------------------------------------------------------------------ handling
/** Small metal/polymer click (button, catch, trigger). */
function clickAt(b, sr, r, t, f, amp, ring = 0.012) {
  addBurst(b, sr, r, { t, atk: 0.0001, tau: 0.0009, amp: amp * 0.8, type: 'highpass', f: 2200 });
  addModes(b, sr, t, f, [1, 1.73, 2.6, 3.9], [1, 0.6, 0.4, 0.2], [ring, ring * 0.7, ring * 0.5, ring * 0.3], amp, r, 0.02);
}

export function genDry(sr, r) {
  const b = new Float32Array(Math.floor(0.14 * sr));
  // trigger take-up creak, striker fall (dull, no primer), trigger reset
  addBurst(b, sr, r, { t: 0.001, atk: 0.01, tau: 0.008, amp: 0.05, type: 'bandpass', f: 1400, q: 3 });
  clickAt(b, sr, r, 0.022, rr(r, 2300, 2700), 0.8, 0.01);
  addMode(b, sr, 0.022, rr(r, 520, 600), 0.012, 0.25);
  clickAt(b, sr, r, rr(r, 0.075, 0.09), rr(r, 3200, 3600), 0.22, 0.006);
  fadeEdges(b, sr, 0.0005, 0.01);
  return normalize(b, 1);
}

/** Magazine release + mag sliding out of the well. */
export function genMagOut(sr, r) {
  const b = new Float32Array(Math.floor(0.32 * sr));
  clickAt(b, sr, r, 0.002, rr(r, 2600, 3000), 0.9, 0.01);               // release button
  addMode(b, sr, 0.002, rr(r, 700, 780), 0.015, 0.2);
  addBurst(b, sr, r, { t: 0.012, atk: 0.01, tau: 0.03, dur: 0.11, amp: 0.35, type: 'bandpass', f: 2600, f2: 1100, q: 1.8 });   // slide out
  for (let i = 0; i < 3; i++) addGrain(b, sr, r, rr(r, 0.02, 0.1), rr(r, 3000, 5500), rr(r, 0.05, 0.12), 0.004);        // spring/rounds rattle
  addModes(b, sr, rr(r, 0.1, 0.12), rr(r, 1500, 1700), [1, 2.4, 3.8], [1, 0.5, 0.3], [0.03, 0.02, 0.01], 0.12, r);   // mag lips leave the well
  fadeEdges(b, sr, 0.0005, 0.02);
  return normalize(b, 1);
}

/** Dropped polymer/steel magazine hitting the floor (surface dependent), two bounces. */
export function genMagDrop(sr, r, surface = 'concrete') {
  const b = new Float32Array(Math.floor(0.45 * sr));
  const metal = surface === 'metal', soft = surface === 'lino', grit = surface === 'asphalt' || surface === 'gravel' || surface === 'debris';
  let t = 0.002, a = 1;
  for (let k = 0; k < 3; k++) {
    addBurst(b, sr, r, { t, atk: 0.0003, tau: soft ? 0.004 : 0.0025, amp: 0.6 * a, type: 'bandpass', f: soft ? 1200 : 2400, q: 0.8 });
    addModes(b, sr, t, rr(r, 650, 800), [1, 2.3, 3.9, 6.1], [1, 0.7, 0.5, 0.3], [0.025, 0.018, 0.012, 0.007], 0.45 * a, r, 0.04);
    addMode(b, sr, t, rr(r, 150, 200), 0.02, 0.35 * a);
    if (metal) addModes(b, sr, t, rr(r, 260, 330), [1, 2.7, 4.2, 6.6], [1, 0.6, 0.4, 0.25], [0.18, 0.12, 0.08, 0.05], 0.3 * a, r);
    if (grit) for (let g = 0; g < 8; g++) addGrain(b, sr, r, t + rr(r, 0, 0.04), rr(r, 2500, 7000), rr(r, 0.02, 0.07) * a);
    t += rr(r, 0.06, 0.11) * a + 0.02; a *= rr(r, 0.3, 0.45);
  }
  fadeEdges(b, sr, 0.0005, 0.03);
  return normalize(b, 1);
}

/** Fresh magazine insertion: friction into the well, seat click, palm slap. */
export function genMagIn(sr, r) {
  const b = new Float32Array(Math.floor(0.3 * sr));
  addBurst(b, sr, r, { t: 0.002, atk: 0.02, tau: 0.02, dur: 0.075, amp: 0.25, type: 'bandpass', f: 900, f2: 2400, q: 1.6 });
  const ts = rr(r, 0.07, 0.085);
  clickAt(b, sr, r, ts, rr(r, 1450, 1650), 1.0, 0.022);                 // catch engages
  addBurst(b, sr, r, { t: ts, atk: 0.0006, tau: 0.007, amp: 0.7, type: 'lowpass', f: 1300, q: 0.7 });   // palm slap
  addMode(b, sr, ts, rr(r, 140, 170), 0.03, 0.55);
  addModes(b, sr, ts + 0.001, rr(r, 2600, 2900), [1, 1.9], [1, 0.5], [0.04, 0.025], 0.12, r);
  fadeEdges(b, sr, 0.0005, 0.02);
  return normalize(b, 1);
}

/** Slide racked from lock-back and released: serration rasp, pull, slam into battery. */
export function genSlideRelease(sr, r) {
  const b = new Float32Array(Math.floor(0.42 * sr));
  addBurst(b, sr, r, { t: 0.002, atk: 0.004, tau: 0.01, amp: 0.25, type: 'bandpass', f: 3500, q: 1.2 });   // grip on serrations
  clickAt(b, sr, r, 0.03, rr(r, 2300, 2600), 0.45, 0.01);               // slide stop disengages
  addBurst(b, sr, r, { t: 0.035, atk: 0.02, tau: 0.03, dur: 0.08, amp: 0.3, type: 'bandpass', f: 1800, f2: 3200, q: 2.5 });
  addMode(b, sr, 0.035, rr(r, 700, 800), 0.05, 0.04);                     // spring compressing
  const tr = rr(r, 0.12, 0.15);
  addBurst(b, sr, r, { t: tr, atk: 0.0002, tau: 0.0025, amp: 0.9, type: 'bandpass', f: 3200, q: 0.8 });
  addModes(b, sr, tr, rr(r, 1850, 2050), [1, 1.87, 3.1, 4.6, 6.3], [1, 0.65, 0.5, 0.3, 0.15], [0.035, 0.025, 0.015, 0.01, 0.006], 0.9, r);
  addMode(b, sr, tr, rr(r, 280, 340), 0.03, 0.5);
  addMode(b, sr, tr, rr(r, 950, 1050), 0.05, 0.07);
  fadeEdges(b, sr, 0.0005, 0.03);
  return normalize(b, 1);
}

/** Press-check: slide eased back a few mm and let go. Quiet. */
export function genPressCheck(sr, r) {
  const b = new Float32Array(Math.floor(0.35 * sr));
  addBurst(b, sr, r, { t: 0.002, atk: 0.03, tau: 0.03, dur: 0.09, amp: 0.25, type: 'bandpass', f: 2400, f2: 3100, q: 3 });
  const tr = rr(r, 0.2, 0.26);
  clickAt(b, sr, r, tr, rr(r, 1900, 2100), 0.6, 0.02);
  addMode(b, sr, tr, rr(r, 300, 360), 0.02, 0.2);
  fadeEdges(b, sr, 0.0005, 0.02);
  return normalize(b, 1);
}

/** Brass casing landing: ringing bounces then a short roll. */
export function genShell(sr, r, surface = 'concrete', rifle = false) {
  const n = Math.floor(0.9 * sr), b = new Float32Array(n);
  const metal = surface === 'metal', soft = surface === 'lino';
  const grit = surface === 'asphalt' || surface === 'gravel' || surface === 'debris';
  const f0 = (rifle ? rr(r, 3600, 4300) : rr(r, 5200, 6300)) * (soft ? 0.95 : 1);
  const tauK = soft ? 0.45 : grit ? 0.55 : metal ? 1.1 : 1;
  const bounces = grit ? 1 + (r() < 0.5 ? 1 : 0) : 2 + Math.floor(r() * 3);
  let t = 0.002, a = 1, gap = rr(r, 0.07, 0.13);
  for (let k = 0; k < bounces; k++) {
    addBurst(b, sr, r, { t, atk: 0.0001, tau: 0.0008, amp: 0.5 * a, type: 'highpass', f: 3000 });
    addModes(b, sr, t, f0 * rr(r, 0.98, 1.02), [1, 1.53, 2.37, 2.95], [1, 0.7, 0.45, 0.3],
      [0.07 * tauK, 0.045 * tauK, 0.028 * tauK, 0.016 * tauK], 0.8 * a, r, 0.01);
    if (metal) addModes(b, sr, t, rr(r, 420, 520), [1, 2.4, 3.9], [1, 0.6, 0.4], [0.12, 0.08, 0.05], 0.25 * a, r);
    if (grit) for (let g = 0; g < 6; g++) addGrain(b, sr, r, t + rr(r, 0, 0.02), rr(r, 2500, 7000), rr(r, 0.05, 0.15) * a);
    t += gap; gap *= rr(r, 0.45, 0.65); a *= rr(r, 0.35, 0.55);
  }
  // roll: irregular micro-contacts plus faint rolling rasp
  if (!grit) {
    const rollDur = soft ? rr(r, 0.1, 0.2) : rr(r, 0.2, 0.5);
    const rate = rr(r, 35, 70);
    for (let x = 0; x < rollDur; x += 1 / rate * rr(r, 0.5, 1.5)) {
      const e = (1 - x / rollDur);
      addModes(b, sr, t + x, f0 * rr(r, 0.99, 1.01), [1, 1.53], [1, 0.5], [0.012 * tauK, 0.008 * tauK], 0.09 * e * a * 3, r);
    }
    addBurst(b, sr, r, { t, atk: 0.02, tau: rollDur * 0.4, dur: rollDur, amp: 0.03, type: 'bandpass', f: 4000, q: 1.5 });
  }
  if (soft) filt(b, sr, 'lowpass', 6000, 0.7);
  fadeEdges(b, sr, 0.0005, 0.04);
  return normalize(b, 1);
}

export const _internal = { clickAt, clamp };
