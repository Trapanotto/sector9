// World and Foley renderers: footsteps per surface, gear/cloth, landing, bullet impacts per surface,
// glass, flesh, body falls, breathing, heartbeat and ambience one-shots/loops.
// Pure functions: (sr, rng, params) -> Float32Array.
import {
  TAU, rr, lerp, clamp, addMode, addModes, addBurst, addGrain, filt, onePoleLP, dcBlock, fadeEdges, normalize, valueNoise,
  Biquad, sanitize,
} from './dsp.js';

const PLATE = [1, 1.59, 2.14, 2.65, 3.16, 3.5, 4.1, 5.0];

// ------------------------------------------------------------------------------------ footsteps
export const SURFACES = ['concrete', 'metal', 'lino', 'asphalt', 'gravel', 'debris'];
const STEP_LOUD = { concrete: 1, metal: 1.3, lino: 0.8, asphalt: 0.95, gravel: 1.1, debris: 1.1 };

function grainCloud(b, sr, r, t, span, count, fLo, fHi, amp, tau = 0.002) {
  for (let i = 0; i < count; i++) {
    const x = Math.pow(r(), 1.6);   // denser at the start of the contact
    addGrain(b, sr, r, t + x * span, rr(r, fLo, fHi), amp * rr(r, 0.3, 1) * (1 - 0.6 * x), tau * rr(r, 0.6, 1.5));
  }
}

/**
 * One footstep: heel strike + toe roll/push-off. inten: 0 = crouch-walk, 0.5 = walk, 1 = sprint.
 */
export function genStep(sr, r, surface, inten) {
  const n = Math.floor(0.55 * sr), b = new Float32Array(n);
  const gap = lerp(0.15, 0.045, inten) * rr(r, 0.85, 1.15);
  const tH = 0.002, tT = tH + gap;
  const hA = lerp(0.3, 1, inten), tA = hA * lerp(0.55, 0.7, inten) * rr(r, 0.8, 1.1);
  const soft = 1 - inten;   // crouch: slower heel attack, rolled foot
  const atk = lerp(0.0004, 0.004, soft * soft);
  // weight: low body thump of shoe + floor coupling (heel), smaller on the toe
  addMode(b, sr, tH, rr(r, 70, 105), lerp(0.01, 0.02, inten), 0.24 * hA, atk * 2);
  addMode(b, sr, tT, rr(r, 90, 130), 0.01, 0.1 * tA, atk * 2);
  switch (surface) {
    case 'metal': {
      const f0 = rr(r, 135, 185), tk = lerp(0.6, 1.2, inten);
      for (const [t, a] of [[tH, hA], [tT, tA * 0.8]]) {
        addBurst(b, sr, r, { t, atk: atk * 0.5, tau: 0.0018, amp: 0.5 * a, type: 'highpass', f: 1400 });
        addModes(b, sr, t, f0, PLATE, [1, 0.8, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18],
          [0.25 * tk, 0.18 * tk, 0.14 * tk, 0.1 * tk, 0.08 * tk, 0.06 * tk, 0.045 * tk, 0.035 * tk], 0.32 * a, r, 0.03);
        // plate chattering on its frame
        for (let k = 0; k < 2 + Math.floor(inten * 2); k++) {
          addModes(b, sr, t + rr(r, 0.006, 0.03), rr(r, 600, 950), [1, 2.3, 3.7], [1, 0.5, 0.3], [0.02, 0.012, 0.008], 0.12 * a * rr(r, 0.4, 1), r);
        }
      }
      grainCloud(b, sr, r, tH, 0.03, 3, 3000, 8000, 0.08 * hA);
      break;
    }
    case 'lino': {
      addBurst(b, sr, r, { t: tH, atk, tau: 0.004, amp: 0.75 * hA, type: 'lowpass', f: 1300, q: 0.7 });
      addBurst(b, sr, r, { t: tH, atk, tau: 0.002, amp: 0.2 * hA, type: 'bandpass', f: 2600, q: 1 });
      addBurst(b, sr, r, { t: tT, atk: atk * 1.5, tau: 0.004, amp: 0.55 * tA, type: 'lowpass', f: 1600 });
      // sole peeling off the tacky floor
      addBurst(b, sr, r, { t: tT + rr(r, 0.04, 0.08), atk: 0.002, tau: 0.006, amp: 0.13 * tA, type: 'highpass', f: 2200 });
      if (r() < 0.22) {   // rubber squeak
        const t0 = tT + rr(r, 0.01, 0.05), dur = rr(r, 0.025, 0.06), f0 = rr(r, 1300, 2300), f1 = f0 * rr(r, 1.1, 1.4);
        const s0 = Math.floor(t0 * sr), ns = Math.floor(dur * sr); let ph = 0;
        for (let i = 0; i < ns && s0 + i < n; i++) {
          const x = i / ns; ph += TAU * (f0 + (f1 - f0) * x) / sr;
          b[s0 + i] += (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) * Math.sin(Math.PI * x) * 0.12 * tA;
        }
      }
      break;
    }
    case 'asphalt': case 'gravel': {
      const g = surface === 'gravel';
      addBurst(b, sr, r, { t: tH, atk, tau: 0.003, amp: 0.45 * hA, type: 'lowpass', f: 2400 });
      addBurst(b, sr, r, { t: tT, atk, tau: 0.003, amp: 0.3 * tA, type: 'lowpass', f: 2800 });
      grainCloud(b, sr, r, tH, g ? 0.1 : 0.05, Math.round((g ? 45 : 12) * lerp(0.6, 1.3, inten)), 1800, 7500, (g ? 0.22 : 0.16) * hA, g ? 0.003 : 0.002);
      grainCloud(b, sr, r, tT, g ? 0.08 : 0.04, Math.round((g ? 30 : 8) * lerp(0.6, 1.3, inten)), 2200, 8000, (g ? 0.18 : 0.12) * tA);
      if (g) addBurst(b, sr, r, { t: tH, atk: 0.004, tau: 0.03, amp: 0.16 * hA, type: 'bandpass', f: 1400, q: 0.9 });
      addBurst(b, sr, r, { t: tT + 0.01, atk: 0.006, tau: 0.02 + 0.02 * inten, amp: (0.06 + 0.12 * inten) * tA, type: 'bandpass', f: 3200, q: 1 });
      break;
    }
    case 'debris': {
      addBurst(b, sr, r, { t: tH, atk, tau: 0.003, amp: 0.45 * hA, type: 'bandpass', f: 1500, q: 0.7 });
      addBurst(b, sr, r, { t: tT, atk, tau: 0.003, amp: 0.3 * tA, type: 'bandpass', f: 2000, q: 0.7 });
      grainCloud(b, sr, r, tH, 0.08, 30, 1500, 6000, 0.2 * hA, 0.003);
      grainCloud(b, sr, r, tT, 0.07, 22, 2000, 7000, 0.16 * tA);
      for (let k = 0; k < 2 + Math.floor(r() * 4); k++) {   // glass crumbs tinkling
        addModes(b, sr, tH + rr(r, 0, 0.12), rr(r, 4500, 9000), [1, 1.43, 2.2], [1, 0.6, 0.3], [0.015, 0.01, 0.006], rr(r, 0.04, 0.1) * hA, r);
      }
      addBurst(b, sr, r, { t: tH + 0.005, atk: 0.005, tau: 0.03, amp: 0.15 * hA, type: 'bandpass', f: 2200, q: 0.8 });
      break;
    }
    default: {   // concrete
      addBurst(b, sr, r, { t: tH, atk, tau: 0.0028, amp: 0.6 * hA, type: 'bandpass', f: rr(r, 1500, 2100), q: 0.7 });
      addBurst(b, sr, r, { t: tH, atk, tau: 0.004, amp: 0.3 * hA, type: 'lowpass', f: 700 });
      addBurst(b, sr, r, { t: tT, atk, tau: 0.0025, amp: 0.45 * tA, type: 'bandpass', f: rr(r, 1900, 2600), q: 0.8 });
      grainCloud(b, sr, r, tH, 0.03, Math.round(lerp(3, 10, inten)), 3000, 8500, 0.09 * hA);
      // grit scuff on push-off (longer when sprinting)
      addBurst(b, sr, r, { t: tT + 0.005, atk: 0.005, tau: 0.012 + 0.03 * inten, amp: (0.05 + 0.18 * inten) * tA, type: 'bandpass', f: 2600, f2: 3800, q: 1.2 });
    }
  }
  filt(b, sr, 'highpass', 45, 0.7);
  fadeEdges(b, sr, 0.0003, 0.03);
  sanitize(b);
  return normalize(b, lerp(0.35, 1, inten) * (STEP_LOUD[surface] || 1));
}

/** Gear moving with a step: cloth swish, pouch/holster creak, buckle and equipment rattle. */
export function genGear(sr, r, inten) {
  const n = Math.floor(0.4 * sr), b = new Float32Array(n);
  addBurst(b, sr, r, { t: 0.002, atk: rr(r, 0.03, 0.07), tau: rr(r, 0.05, 0.09), amp: 0.3, type: 'bandpass', f: rr(r, 1400, 3200), q: 0.7 });
  addBurst(b, sr, r, { t: 0.01, atk: 0.04, tau: 0.05, amp: 0.12, type: 'lowpass', f: 700 });
  const clicks = Math.round(lerp(1, 6, inten) * rr(r, 0.6, 1.3));
  for (let i = 0; i < clicks; i++) {
    addModes(b, sr, rr(r, 0.01, 0.12), rr(r, 1800, 5200), [1, 1.7, 2.6], [1, 0.5, 0.3], [0.006, 0.004, 0.003], rr(r, 0.1, 0.35), r, 0.05);
  }
  if (r() < 0.25 + 0.5 * inten) {   // holster / pouch polymer creak
    const t0 = rr(r, 0.01, 0.06), dur = rr(r, 0.04, 0.09), s0 = Math.floor(t0 * sr), ns = Math.floor(dur * sr);
    const bq = new Biquad(sr, 'bandpass', rr(r, 600, 1100), 6);
    for (let i = 0; i < ns && s0 + i < n; i++) {
      const x = i / ns, pulse = (i % Math.floor(sr / rr(r, 70, 110))) === 0 ? 1 : 0;
      b[s0 + i] += bq.run(pulse + (r() - 0.5) * 0.05) * Math.sin(Math.PI * x) * 1.6;
    }
  }
  if (r() < 0.3 * inten + 0.1) addModes(b, sr, rr(r, 0.02, 0.1), rr(r, 3000, 4200), [1, 1.6, 2.5], [1, 0.6, 0.4], [0.03, 0.02, 0.01], 0.12, r);
  fadeEdges(b, sr, 0.001, 0.04);
  return normalize(b, lerp(0.3, 1, inten));
}

/** Short cloth rub / swish (turning, crouching). */
export function genCloth(sr, r, dur = 0.25) {
  const b = new Float32Array(Math.floor((dur + 0.05) * sr));
  const vn = valueNoise(r, 40, dur + 0.1);
  const s0 = Math.floor(0.002 * sr), ns = Math.floor(dur * sr);
  const bp = new Biquad(sr, 'bandpass', rr(r, 1200, 2600), 0.6), lp = new Biquad(sr, 'lowpass', 5000, 0.7);
  for (let i = 0; i < ns; i++) {
    const x = i / ns, e = Math.pow(Math.sin(Math.PI * x), 1.3) * (0.6 + 0.4 * Math.abs(vn(i / sr)));
    b[s0 + i] = lp.run(bp.run((r() * 2 - 1) * e));
  }
  fadeEdges(b, sr, 0.002, 0.02);
  return normalize(b, 1);
}

/** Landing from a drop: heavy thump, knees, all the gear clattering. */
export function genLand(sr, r, surface) {
  const b = new Float32Array(Math.floor(0.6 * sr));
  addMode(b, sr, 0.002, rr(r, 55, 70), 0.045, 1, 0.003);
  addBurst(b, sr, r, { t: 0.002, atk: 0.002, tau: 0.02, amp: 0.8, type: 'lowpass', f: 800 });
  const step = genStep(sr, r, surface, 1);
  for (let i = 0; i < step.length && i < b.length; i++) b[i] += step[i] * 0.6;
  for (let i = 0; i < 7; i++) addModes(b, sr, rr(r, 0.01, 0.16), rr(r, 1600, 5200), [1, 1.7, 2.6], [1, 0.5, 0.3], [0.008, 0.005, 0.003], rr(r, 0.1, 0.3), r);
  addBurst(b, sr, r, { t: 0.01, atk: 0.03, tau: 0.08, amp: 0.2, type: 'bandpass', f: 2200, q: 0.7 });
  fadeEdges(b, sr, 0.0005, 0.04);
  return normalize(b, 1);
}

// ------------------------------------------------------------------------------------ impacts
function debrisFall(b, sr, r, count, hMin, hMax, fLo, fHi, amp) {
  for (let i = 0; i < count; i++) {
    const h = rr(r, hMin, hMax), t = 0.02 + Math.sqrt(2 * h / 9.81);
    const a = amp * rr(r, 0.3, 1);
    addGrain(b, sr, r, t, rr(r, fLo, fHi), a, rr(r, 0.0015, 0.004));
    if (r() < 0.6) addGrain(b, sr, r, t + rr(r, 0.025, 0.07), rr(r, fLo, fHi), a * 0.35, 0.002);
  }
}

export function genImpactConcrete(sr, r) {
  const b = new Float32Array(Math.floor(0.9 * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0001, tau: 0.0012, amp: 1, type: 'highpass', f: 1600 });
  addBurst(b, sr, r, { t: 0.001, atk: 0.0002, tau: 0.01, amp: 0.65, type: 'bandpass', f: rr(r, 800, 1200), q: 0.8 });
  addMode(b, sr, 0.001, rr(r, 120, 180), 0.012, 0.12);
  addBurst(b, sr, r, { t: 0.004, atk: 0.006, tau: 0.08, amp: 0.05, type: 'highpass', f: 3500 });   // dust hiss
  grainCloud(b, sr, r, 0.002, 0.03, 8, 2500, 7000, 0.18);   // spall burst
  debrisFall(b, sr, r, 4 + Math.floor(r() * 8), 0.2, 1.4, 2500, 7000, 0.14);
  dcBlock(b, sr, 40);
  fadeEdges(b, sr, 0.0003, 0.05);
  return normalize(b, 1);
}

/** Bullet on metal. size: characteristic object size in metres (pitch and decay), thin: sheet metal. */
export function genImpactMetal(sr, r, size = 1, thin = false) {
  const tau = clamp(0.22 * Math.sqrt(size), 0.12, 1.1) * (thin ? 0.6 : 1);
  const len = Math.min(2.2, tau * 5 + 0.1);
  const b = new Float32Array(Math.floor(len * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0001, tau: 0.0009, amp: 1, type: 'highpass', f: 2500 });
  // local panel "spang"
  addModes(b, sr, 0.001, rr(r, 1900, 3200), [1, 1.37, 1.81, 2.43], [1, 0.8, 0.6, 0.4],
    [0.09 * (thin ? 0.6 : 1), 0.06, 0.04, 0.025], 0.55, r, 0.03);
  // whole object
  const f0 = clamp(260 / Math.pow(size, 0.75), 90, 1500) * rr(r, 0.92, 1.08);
  addModes(b, sr, 0.001, f0, PLATE, [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3, 0.22],
    [tau, tau * 0.8, tau * 0.65, tau * 0.55, tau * 0.45, tau * 0.38, tau * 0.3, tau * 0.25], 0.38, r, 0.02);
  addBurst(b, sr, r, { t: 0.001, atk: 0.0003, tau: 0.008, amp: 0.3, type: 'bandpass', f: 900, q: 1 });
  if (thin) for (let k = 0; k < 5; k++) addModes(b, sr, rr(r, 0.01, 0.12), rr(r, 400, 900), [1, 2.2], [1, 0.4], [0.02, 0.01], rr(r, 0.05, 0.15), r);
  debrisFall(b, sr, r, 2, 0.3, 1.0, 3000, 6000, 0.05);
  dcBlock(b, sr, 40);
  fadeEdges(b, sr, 0.0003, 0.05);
  return normalize(b, 1);
}

/** Bullet into wood. hollow: crate/box (low box resonance), otherwise solid furniture. */
export function genImpactWood(sr, r, hollow = true) {
  const b = new Float32Array(Math.floor(0.6 * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0001, tau: 0.0012, amp: 0.6, type: 'highpass', f: 1800 });
  addBurst(b, sr, r, { t: 0.001, atk: 0.0002, tau: 0.007, amp: 1, type: 'bandpass', f: rr(r, 500, 800), q: 1 });
  const f0 = hollow ? rr(r, 150, 240) : rr(r, 320, 460);
  addModes(b, sr, 0.001, f0, [1, 1.52, 2.3, 3.1], [1, 0.7, 0.45, 0.3], [0.045, 0.035, 0.025, 0.015], 0.5, r, 0.04);
  grainCloud(b, sr, r, 0.002, 0.025, 12, 1800, 6000, 0.22, 0.0025);   // splintering
  debrisFall(b, sr, r, 2 + Math.floor(r() * 3), 0.1, 0.9, 1400, 3200, 0.08);
  dcBlock(b, sr, 40);
  fadeEdges(b, sr, 0.0003, 0.04);
  return normalize(b, 1);
}

/** Window pane shattering: crack, burst of shards, shards landing and tinkling over ~1 s. */
export function genGlass(sr, r, big = true) {
  const b = new Float32Array(Math.floor(1.5 * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0001, tau: 0.0015, amp: 1, type: 'highpass', f: 2000 });
  addBurst(b, sr, r, { t: 0.002, atk: 0.001, tau: 0.04, amp: 0.3, type: 'highpass', f: 2500 });
  addBurst(b, sr, r, { t: 0.004, atk: 0.01, tau: 0.15, amp: 0.07, type: 'bandpass', f: 6000, q: 0.8 });
  const nBurst = big ? 70 : 35;
  for (let i = 0; i < nBurst; i++) {
    const t = 0.002 - Math.log(1 - r() * 0.98) * 0.025;
    addModes(b, sr, t, rr(r, 2500, 11000), [1, 1.41, 2.13], [1, 0.6, 0.35], [rr(r, 0.004, 0.03), 0.01, 0.006],
      rr(r, 0.05, 0.3) * Math.exp(-t / 0.05), r, 0.05);
  }
  const nFall = big ? 55 : 25;
  for (let i = 0; i < nFall; i++) {
    const h = rr(r, 0.05, 1.8), t = 0.06 + Math.sqrt(2 * h / 9.81) * rr(r, 0.9, 1.3);
    const a = rr(r, 0.04, 0.2), f = rr(r, 3000, 10000);
    addModes(b, sr, t, f, [1, 1.47, 2.3], [1, 0.6, 0.3], [rr(r, 0.006, 0.025), 0.008, 0.005], a, r, 0.05);
    if (r() < 0.5) grainCloud(b, sr, r, t, 0.02, 3, 4000, 10000, a * 0.6);   // shard breaks again
    if (r() < 0.4) addModes(b, sr, t + rr(r, 0.03, 0.08), f * rr(r, 0.97, 1.03), [1, 1.47], [1, 0.5], [0.01, 0.006], a * 0.3, r);
  }
  filt(b, sr, 'highpass', 400, 0.7);
  fadeEdges(b, sr, 0.0003, 0.08);
  return normalize(b, 1);
}

/** Bullet hitting a body: dull, restrained. */
export function genFlesh(sr, r) {
  const b = new Float32Array(Math.floor(0.28 * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0005, tau: 0.016, amp: 1, type: 'lowpass', f: rr(r, 380, 520), q: 0.7 });
  addMode(b, sr, 0.001, rr(r, 85, 110), 0.028, 0.6, 0.001);
  addMode(b, sr, 0.001, rr(r, 160, 210), 0.015, 0.25, 0.001);
  addBurst(b, sr, r, { t: 0.002, atk: 0.0004, tau: 0.004, amp: 0.25, type: 'bandpass', f: rr(r, 900, 1400), q: 1.5 });
  addBurst(b, sr, r, { t: 0.001, atk: 0.0001, tau: 0.0012, amp: 0.12, type: 'highpass', f: 3000 });   // cloth snap
  dcBlock(b, sr, 30);
  fadeEdges(b, sr, 0.0005, 0.04);
  return normalize(b, 1);
}

/** Body collapsing with gear: knees, torso, arm/head, weapon clatter, cloth. */
export function genBodyFall(sr, r, surface = 'concrete') {
  const b = new Float32Array(Math.floor(1.0 * sr));
  const metal = surface === 'metal';
  const hits = [[0.002, 0.45, rr(r, 80, 100)], [rr(r, 0.09, 0.15), 1, rr(r, 55, 72)], [rr(r, 0.22, 0.32), 0.35, rr(r, 90, 130)]];
  for (const [t, a, f] of hits) {
    addMode(b, sr, t, f, 0.055, a, 0.004);
    addBurst(b, sr, r, { t, atk: 0.003, tau: 0.035, amp: 0.7 * a, type: 'lowpass', f: 380, q: 0.7 });
    addBurst(b, sr, r, { t, atk: 0.002, tau: 0.008, amp: 0.15 * a, type: 'bandpass', f: 1500, q: 0.8 });
    if (metal) addModes(b, sr, t, rr(r, 120, 170), PLATE, [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15],
      [0.3, 0.22, 0.17, 0.12, 0.1, 0.08, 0.06, 0.05], 0.25 * a, r);
  }
  // weapon / magazines clattering
  const tw = rr(r, 0.12, 0.3);
  addModes(b, sr, tw, rr(r, 1100, 1600), [1, 2.1, 3.4, 4.9], [1, 0.6, 0.4, 0.25], [0.05, 0.03, 0.02, 0.012], 0.25, r);
  addModes(b, sr, tw + rr(r, 0.05, 0.1), rr(r, 1300, 1900), [1, 2.1, 3.4], [1, 0.5, 0.3], [0.03, 0.02, 0.01], 0.1, r);
  for (let i = 0; i < 8; i++) addModes(b, sr, rr(r, 0.05, 0.4), rr(r, 1500, 5000), [1, 1.7], [1, 0.4], [0.006, 0.004], rr(r, 0.05, 0.18), r);
  addBurst(b, sr, r, { t: 0.01, atk: 0.04, tau: 0.15, amp: 0.12, type: 'bandpass', f: 2000, q: 0.7 });
  // final settle / exhale of gear
  addBurst(b, sr, r, { t: rr(r, 0.45, 0.6), atk: 0.03, tau: 0.08, amp: 0.05, type: 'bandpass', f: 1500, q: 0.8 });
  dcBlock(b, sr, 25);
  fadeEdges(b, sr, 0.0005, 0.06);
  return normalize(b, 1);
}

/** The camera itself hitting the floor: near-field housing thump, plastic clack, scrape. */
export function genCamDrop(sr, r) {
  const b = new Float32Array(Math.floor(0.7 * sr));
  addMode(b, sr, 0.002, rr(r, 45, 58), 0.05, 1, 0.002);
  addBurst(b, sr, r, { t: 0.002, atk: 0.0005, tau: 0.03, amp: 1, type: 'lowpass', f: 650, q: 0.8 });
  addModes(b, sr, 0.003, rr(r, 850, 1000), [1, 1.93, 3.3], [1, 0.6, 0.35], [0.012, 0.008, 0.005], 0.5, r);
  addBurst(b, sr, r, { t: 0.02, atk: 0.02, tau: 0.08, dur: 0.3, amp: 0.2, type: 'bandpass', f: 1600, f2: 600, q: 1.2 });
  const tb = rr(r, 0.11, 0.15);
  addMode(b, sr, tb, rr(r, 60, 75), 0.03, 0.4, 0.002);
  addModes(b, sr, tb, rr(r, 900, 1100), [1, 1.93], [1, 0.5], [0.01, 0.006], 0.2, r);
  dcBlock(b, sr, 20);
  fadeEdges(b, sr, 0.0005, 0.05);
  return normalize(b, 1);
}

// ------------------------------------------------------------------------------------ body
/** A breath. inhale/exhale, effort 0..1 (resting .. after sprint). */
export function genBreath(sr, r, inhale, effort) {
  const dur = (inhale ? lerp(0.9, 0.32, effort) : lerp(1.2, 0.4, effort)) * rr(r, 0.85, 1.15);
  const n = Math.floor((dur + 0.06) * sr), b = new Float32Array(n);
  const vn = valueNoise(r, 25, dur + 0.1);
  const f1 = inhale ? rr(r, 1500, 2100) : rr(r, 550, 800), f2 = inhale ? rr(r, 2600, 3300) : rr(r, 1300, 1700);
  const bp1 = new Biquad(sr, 'bandpass', f1, inhale ? 1.4 : 1.1), bp2 = new Biquad(sr, 'bandpass', f2, 2);
  const hp = new Biquad(sr, 'highpass', inhale ? 500 : 180, 0.7);
  const s0 = Math.floor(0.003 * sr), ns = Math.floor(dur * sr);
  const voiced = !inhale && effort > 0.55 ? (effort - 0.55) * 0.5 : 0, f0 = rr(r, 100, 120);
  let ph = 0;
  for (let i = 0; i < ns; i++) {
    const x = i / ns;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(x, inhale ? 0.8 : 0.6)), 1.4) * (0.75 + 0.25 * vn(i / sr));
    const nz = r() * 2 - 1;
    let y = bp1.run(nz) * 0.9 + bp2.run(nz) * 0.5;
    if (voiced) { ph += TAU * f0 * (1 - 0.15 * x) / sr; y += Math.pow(Math.max(0, Math.sin(ph)), 6) * voiced * Math.sin(Math.PI * x); }
    b[s0 + i] = hp.run(y) * env;
  }
  filt(b, sr, 'lowpass', 7000, 0.7);
  fadeEdges(b, sr, 0.005, 0.03);
  return normalize(b, lerp(0.35, 1, effort));
}

/** Heartbeat lub-dub, felt more than heard. */
export function genHeart(sr, r) {
  const b = new Float32Array(Math.floor(0.55 * sr));
  addMode(b, sr, 0.004, rr(r, 42, 50), 0.045, 1, 0.006);
  addMode(b, sr, 0.004, rr(r, 70, 80), 0.025, 0.4, 0.004);
  const t2 = rr(r, 0.15, 0.19);
  addMode(b, sr, t2, rr(r, 52, 60), 0.035, 0.65, 0.005);
  addMode(b, sr, t2, rr(r, 85, 95), 0.02, 0.25, 0.004);
  filt(b, sr, 'lowpass', 180, 0.7);
  fadeEdges(b, sr, 0.002, 0.05);
  return normalize(b, 1);
}

// ------------------------------------------------------------------------------------ ambience
/** Water drop into a puddle (Minnaert bubble: pitch rises). */
export function genDrip(sr, r) {
  const b = new Float32Array(Math.floor(0.12 * sr));
  addBurst(b, sr, r, { t: 0.001, atk: 0.0002, tau: 0.0008, amp: 0.25, type: 'highpass', f: 2500 });
  const f0 = rr(r, 900, 2400), tau = rr(r, 0.01, 0.022), s0 = Math.floor(0.002 * sr), ns = Math.floor(tau * 6 * sr);
  let ph = 0;
  for (let i = 0; i < ns && s0 + i < b.length; i++) {
    const t = i / sr; ph += TAU * f0 * (1 + 0.6 * (1 - Math.exp(-t / 0.012))) / sr;
    b[s0 + i] += Math.sin(ph) * Math.exp(-t / tau) * Math.min(1, t / 0.0005);
  }
  fadeEdges(b, sr, 0.0005, 0.01);
  return normalize(b, 1);
}

/** Stick-slip creak: irregular pulse train through resonances (metal or wood structure). */
export function genCreak(sr, r, metal = true) {
  const dur = rr(r, 0.5, 1.6), n = Math.floor((dur + 0.3) * sr), b = new Float32Array(n);
  const vn = valueNoise(r, 6, dur + 0.5), an = valueNoise(r, 3, dur + 0.5);
  const base = metal ? rr(r, 380, 900) : rr(r, 220, 520);
  const ratios = metal ? [1, 1.73, 2.61, 3.9] : [1, 1.5, 2.2];
  const res = ratios.map((k) => new Biquad(sr, 'bandpass', base * k, metal ? rr(r, 25, 45) : rr(r, 10, 18)));
  let next = 0;
  for (let i = 0; i < Math.floor(dur * sr); i++) {
    const t = i / sr;
    let x = 0;
    if (i >= next) { x = 1; next = i + Math.floor(sr / (rr(r, 18, 30) + 22 * vn(t))); }
    const env = Math.sin(Math.PI * t / dur) * (0.6 + 0.4 * an(t));
    let y = 0; for (let k = 0; k < res.length; k++) y += res[k].run(x * env) / (k + 1);
    b[i] = y;
  }
  fadeEdges(b, sr, 0.01, 0.1);
  return normalize(b, 1);
}

/** Loose corrugated sheet slamming in a gust: a few hits, rattle chatter, long low ring. */
export function genSheetBang(sr, r) {
  const b = new Float32Array(Math.floor(2.2 * sr));
  const hits = 1 + Math.floor(r() * 3);
  let t = 0.002;
  for (let h = 0; h < hits; h++) {
    const a = h === 0 ? 1 : rr(r, 0.3, 0.7);
    addBurst(b, sr, r, { t, atk: 0.0005, tau: 0.006, amp: 0.5 * a, type: 'bandpass', f: 1200, q: 0.7 });
    addModes(b, sr, t, rr(r, 65, 110), PLATE, [1, 0.9, 0.8, 0.7, 0.55, 0.45, 0.35, 0.3],
      [0.5, 0.42, 0.35, 0.3, 0.25, 0.2, 0.16, 0.12], 0.5 * a, r, 0.03);
    for (let k = 0; k < 6; k++) addModes(b, sr, t + 0.02 + k * rr(r, 0.02, 0.04), rr(r, 300, 700), [1, 2.3], [1, 0.4], [0.02, 0.01], 0.15 * a * (1 - k / 6), r);
    t += rr(r, 0.15, 0.5);
  }
  fadeEdges(b, sr, 0.0005, 0.2);
  return normalize(b, 1);
}

/** Small songbird phrase (sparse, overcast) or a distant crow. */
export function genBird(sr, r, crow = false) {
  if (crow) {
    const caws = 1 + Math.floor(r() * 3), b = new Float32Array(Math.floor((caws * 0.55 + 0.2) * sr));
    let t = 0.01;
    for (let c = 0; c < caws; c++) {
      const dur = rr(r, 0.22, 0.35), f0 = rr(r, 420, 560), s0 = Math.floor(t * sr), ns = Math.floor(dur * sr);
      const fA = new Biquad(sr, 'bandpass', rr(r, 1100, 1400), 4), fB = new Biquad(sr, 'bandpass', rr(r, 1900, 2400), 5);
      let ph = 0;
      for (let i = 0; i < ns; i++) {
        const x = i / ns; ph += f0 * (1 + 0.15 * Math.sin(Math.PI * x)) * (1 + 0.04 * (r() - 0.5)) / sr;
        const src = (ph % 1) * 2 - 1 + (r() - 0.5) * 0.6;
        b[s0 + i] += (fA.run(src) + 0.6 * fB.run(src)) * Math.pow(Math.sin(Math.PI * x), 0.5);
      }
      t += dur + rr(r, 0.12, 0.25);
    }
    fadeEdges(b, sr, 0.002, 0.03);
    return normalize(b, 1);
  }
  const notes = 2 + Math.floor(r() * 5), b = new Float32Array(Math.floor((notes * 0.16 + 0.1) * sr));
  const kind = Math.floor(r() * 3);
  let t = 0.005;
  const fBase = rr(r, 3200, 5200);
  for (let k = 0; k < notes; k++) {
    const dur = kind === 0 ? rr(r, 0.03, 0.06) : rr(r, 0.06, 0.12);
    const fa = fBase * (kind === 1 ? (k % 2 ? 0.75 : 1) : rr(r, 0.9, 1.15)), fb = fa * (kind === 2 ? rr(r, 0.6, 0.8) : rr(r, 1.1, 1.4));
    const s0 = Math.floor(t * sr), ns = Math.floor(dur * sr); let ph = 0;
    for (let i = 0; i < ns; i++) {
      const x = i / ns; ph += TAU * (fa + (fb - fa) * x) * (1 + 0.03 * Math.sin(TAU * 60 * i / sr)) / sr;
      b[s0 + i] += (Math.sin(ph) + 0.15 * Math.sin(2 * ph)) * Math.pow(Math.sin(Math.PI * x), 0.7);
    }
    t += dur + rr(r, 0.03, 0.09);
  }
  fadeEdges(b, sr, 0.002, 0.02);
  return normalize(b, 1);
}

/** Pigeons taking off: wing claps then flaps tailing away. */
export function genPigeons(sr, r) {
  const birds = 1 + Math.floor(r() * 3), dur = rr(r, 1.2, 2.2);
  const b = new Float32Array(Math.floor((dur + 0.3) * sr));
  for (let p = 0; p < birds; p++) {
    let t = rr(r, 0, 0.25); const rate = rr(r, 7, 11);
    addBurst(b, sr, r, { t, atk: 0.0005, tau: 0.006, amp: 0.8, type: 'highpass', f: 1500 });   // wing clap
    let a = 1;
    while (t < dur) {
      addBurst(b, sr, r, { t, atk: 0.006, tau: 0.02, amp: 0.55 * a, type: 'bandpass', f: rr(r, 700, 1800), q: 0.8 });
      addBurst(b, sr, r, { t: t + 0.01, atk: 0.003, tau: 0.01, amp: 0.2 * a, type: 'highpass', f: 2500 });
      t += 1 / rate * rr(r, 0.9, 1.1); a *= rr(r, 0.88, 0.95);
    }
  }
  fadeEdges(b, sr, 0.001, 0.1);
  return normalize(b, 1);
}

/** Pigeon coo (low, breathy). */
export function genCoo(sr, r) {
  const dur = rr(r, 0.7, 1.1), b = new Float32Array(Math.floor((dur + 0.1) * sr));
  const f0 = rr(r, 260, 340), ns = Math.floor(dur * sr), bp = new Biquad(sr, 'bandpass', f0 * 2, 3);
  let ph = 0;
  for (let i = 0; i < ns; i++) {
    const x = i / ns; ph += TAU * f0 * (1 + 0.12 * Math.sin(Math.PI * x * 1.5)) / sr;
    const env = Math.pow(Math.sin(Math.PI * x), 0.8) * (0.6 + 0.4 * Math.sin(Math.PI * x * 3) ** 2);
    b[i] = (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.6 * bp.run(r() - 0.5)) * env;
  }
  fadeEdges(b, sr, 0.005, 0.05);
  return normalize(b, 1);
}

/** Distant car passing on a road beyond the fence. */
export function genCarPass(sr, r) {
  const dur = rr(r, 5, 8), n = Math.floor(dur * sr), b = new Float32Array(n);
  const lp = new Biquad(sr, 'bandpass', 300, 0.7), hp = new Biquad(sr, 'bandpass', 1500, 0.8);
  const f0 = rr(r, 28, 40); let ph = 0, br = 0;
  const tc = rr(r, 0.4, 0.6) * dur;
  for (let i = 0; i < n; i++) {
    const t = i / sr, x = (t - tc) / (dur * 0.22);
    const env = 1 / (1 + x * x);
    if ((i & 63) === 0) { const dop = 1 + 0.06 * Math.tanh(-x * 1.5); lp.set('bandpass', 300 * dop, 0.7); hp.set('bandpass', 1500 * dop, 0.8); }
    br = (br + 0.02 * (r() * 2 - 1)) / 1.02;
    ph += TAU * f0 * (1 + 0.05 * Math.tanh(-x * 1.5)) / sr;
    const eng = Math.sin(ph) * 0.3 + Math.sin(2 * ph) * 0.2 + Math.sin(3 * ph + 1) * 0.1;
    b[i] = (lp.run(br * 8) + hp.run(r() * 2 - 1) * 0.12 + eng * 0.15) * env;
  }
  fadeEdges(b, sr, 0.3, 0.5);
  return normalize(b, 1);
}

/** Far freight train: rumble, wheel clacks, sometimes a two-tone horn. */
export function genTrain(sr, r) {
  const dur = rr(r, 8, 11), n = Math.floor(dur * sr), b = new Float32Array(n);
  const lp = new Biquad(sr, 'lowpass', 220, 0.7);
  const clackRate = rr(r, 1.8, 3);
  let br = 0, env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0) env = Math.sin(Math.PI * i / sr / dur) ** 1.5;
    br = (br + 0.02 * (r() * 2 - 1)) / 1.02;
    b[i] = lp.run(br * 10) * env;
  }
  for (let t = 0.5; t < dur - 0.5; t += 1 / clackRate) {
    const env = Math.sin(Math.PI * t / dur) ** 1.5;
    addMode(b, sr, t, rr(r, 90, 130), 0.03, 0.25 * env, 0.003);
    addMode(b, sr, t + 0.12, rr(r, 90, 130), 0.03, 0.2 * env, 0.003);
  }
  if (r() < 0.6) {
    const th = rr(r, 1.5, dur * 0.4), hd = rr(r, 1.2, 2.5), s0 = Math.floor(th * sr), ns = Math.floor(hd * sr);
    const fs = [rr(r, 300, 320), rr(r, 370, 385), rr(r, 440, 455)];
    const ph = [0, 0, 0];
    for (let i = 0; i < ns && s0 + i < n; i++) {
      const x = i / ns, env = Math.min(1, x * 12) * Math.min(1, (1 - x) * 6);
      let y = 0; for (let k = 0; k < 3; k++) { ph[k] += fs[k] / sr; y += ((ph[k] % 1) * 2 - 1) * 0.3; }
      b[s0 + i] += y * env * 0.5;
    }
  }
  filt(b, sr, 'lowpass', 900, 0.7);
  fadeEdges(b, sr, 0.5, 1);
  return normalize(b, 1);
}

/** Very distant emergency siren (European two-tone), smeared by the city. */
export function genSiren(sr, r) {
  const dur = rr(r, 6, 9), n = Math.floor(dur * sr), b = new Float32Array(n);
  const fA = rr(r, 430, 450), fB = fA * 1.335, period = rr(r, 1.2, 1.5);
  let ph = 0, env = 0, inc = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0) {
      const t = i / sr, hi = (t % period) < period / 2;
      inc = (hi ? fB : fA) * (1 + 0.004 * Math.sin(t * 2)) / sr; env = Math.sin(Math.PI * t / dur) ** 0.7;
    }
    ph += inc; if (ph > 1) ph -= 1;
    // band-limited-ish square: three odd harmonics
    const w = TAU * ph;
    b[i] = (Math.sin(w) + Math.sin(3 * w) / 3 + Math.sin(5 * w) / 5) * env;
  }
  filt(b, sr, 'lowpass', 1400, 0.7, 0, 2);
  // diffuse urban smear: a few long feedback echoes
  const d1 = Math.floor(0.137 * sr), d2 = Math.floor(0.211 * sr);
  for (let i = d2; i < n; i++) b[i] += 0.35 * b[i - d1] + 0.25 * b[i - d2];
  fadeEdges(b, sr, 0.5, 1);
  return normalize(b, 1);
}

/** Fluorescent fixture hum: exact 1 s loop of 100 Hz (50 Hz mains) harmonics plus ballast buzz. */
export function genHumLoop(sr, r) {
  const n = sr, b = new Float32Array(n);   // 100 whole cycles of 100 Hz -> seamless loop
  const amps = [1, 0.5, 0.45, 0.25, 0.3, 0.15, 0.18, 0.1, 0.12, 0.06, 0.08, 0.05, 0.05, 0.03, 0.04, 0.02];
  const ph = amps.map(() => r() * TAU);
  for (let i = 0; i < n; i++) {
    const t = i / sr; let y = 0;
    for (let k = 0; k < amps.length; k++) y += amps[k] * Math.sin(TAU * 100 * (k + 1) * t + ph[k]);
    b[i] = y;
  }
  return normalize(b, 1);
}

/** Dying tube: irregular arcing buzz and ticks. */
export function genFlickerBuzz(sr, r) {
  const dur = rr(r, 0.25, 0.9), n = Math.floor((dur + 0.05) * sr), b = new Float32Array(n);
  let on = true, next = 0;
  const hp = new Biquad(sr, 'highpass', 300, 0.7);
  for (let i = 0; i < Math.floor(dur * sr); i++) {
    if (i >= next) { on = !on; next = i + Math.floor(sr * (on ? rr(r, 0.01, 0.08) : rr(r, 0.01, 0.1))); if (on) addBurst(b, sr, r, { t: i / sr, atk: 0.0001, tau: 0.001, amp: 0.6, type: 'highpass', f: 2000 }); }
    const t = i / sr;
    const buzz = on ? Math.sign(Math.sin(TAU * 100 * t)) * 0.3 + (r() - 0.5) * 0.25 : 0;
    b[i] += hp.run(buzz);
  }
  filt(b, sr, 'lowpass', 6000, 0.7);
  fadeEdges(b, sr, 0.002, 0.02);
  return normalize(b, 1);
}

export { onePoleLP };
