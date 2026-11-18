// DEV-ONLY measurement harness (not imported by the game). Renders sounds through the real engine into an
// OfflineAudioContext and reports objective metrics. Usage from the page console (dev server):
//   const h = await import('/src/audio/harness.js'); const rows = await h.runAll(); console.table(rows);
// Uses window.__ctx.level / combat (if present) for real geometry and line of sight.
import * as THREE from 'three';
import { createEngine } from './audio.js';
export { AUDIO_TUNING } from './audio.js';

const SR = 48000;

// ---------------------------------------------------------------- analysis
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -200);

/** chs: Float32Array[] (any channel count), from: analysis start sample. */
export function analyze(chs, sr = SR, from = 0) {
  const n = chs[0].length;
  const mono = new Float32Array(n - from);
  let nan = 0, clipped = 0, sum = 0, peak = 0;
  for (let i = from; i < n; i++) {
    let m = 0;
    for (const c of chs) { const x = c[i]; if (!Number.isFinite(x)) { nan++; continue; } if (Math.abs(x) >= 0.999) clipped++; if (Math.abs(x) > peak) peak = Math.abs(x); m += x; }
    m /= chs.length; mono[i - from] = m; sum += m;
  }
  const dc = sum / mono.length;
  let mp = 0; for (let i = 0; i < mono.length; i++) mp = Math.max(mp, Math.abs(mono[i]));
  // onset: first sample above 1% of peak
  let on = 0; while (on < mono.length && Math.abs(mono[on]) < mp * 0.01) on++;
  // attack: 10% -> 90% of the (mono) peak
  let a10 = on, a90 = on; while (a10 < mono.length && Math.abs(mono[a10]) < mp * 0.1) a10++; a90 = a10;
  while (a90 < mono.length && Math.abs(mono[a90]) < mp * 0.9) a90++;
  // duration: last 5 ms window above -60 dB re peak
  const win = Math.floor(0.005 * sr); let last = on;
  for (let i = on; i < mono.length; i += win) { let e = 0; for (let k = i; k < Math.min(i + win, mono.length); k++) e = Math.max(e, Math.abs(mono[k])); if (e > peak * 0.001) last = i + win; }
  const seg = mono.subarray(on, Math.max(on + 1, last));
  let e2 = 0; for (let i = 0; i < seg.length; i++) e2 += seg[i] * seg[i];
  const rms = Math.sqrt(e2 / Math.max(1, seg.length));
  // body: time for the 20 ms RMS envelope to fall 20 dB below its maximum
  const w20 = Math.floor(0.02 * sr); let envMax = 0, bodyMs = 0;
  const envs = [];
  for (let i = 0; i + w20 <= seg.length; i += w20 / 2) { let e = 0; for (let k = i; k < i + w20; k++) e += seg[k] * seg[k]; envs.push(Math.sqrt(e / w20)); }
  for (const e of envs) envMax = Math.max(envMax, e);
  for (let i = 0; i < envs.length; i++) if (envs[i] > envMax * 0.1) bodyMs = (i + 1) * 10;
  // spectrum: averaged Hann STFT (4096) over the active segment
  const N = 4096, bins = new Float64Array(N / 2);
  const hop = N / 2; let frames = 0;
  for (let s = 0; s + N <= Math.max(seg.length, N); s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (seg[s + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) bins[k] += re[k] * re[k] + im[k] * im[k];
    frames++; if (frames > 200) break;
  }
  let tot = 0, cen = 0; const bands = { sub: 0, low: 0, mid: 0, pres: 0, air: 0 };
  for (let k = 1; k < N / 2; k++) {
    const f = k * sr / N, p = bins[k]; tot += p; cen += f * p;
    if (f < 80) bands.sub += p; else if (f < 250) bands.low += p; else if (f < 2000) bands.mid += p; else if (f < 6000) bands.pres += p; else bands.air += p;
  }
  for (const k in bands) bands[k] = Math.round(1000 * bands[k] / (tot || 1)) / 10;
  const endW = Math.floor(0.002 * sr); let endE = 0;
  for (let i = n - endW; i < n; i++) for (const c of chs) endE = Math.max(endE, Math.abs(c[i] || 0));
  return {
    peakDb: +db(peak).toFixed(1), rmsDb: +db(rms).toFixed(1), crestDb: +(db(peak) - db(rms)).toFixed(1),
    attackMs: +((a90 - a10) / sr * 1000).toFixed(2), bodyMs, durMs: Math.round((last - on) / sr * 1000),
    centroidHz: Math.round(cen / (tot || 1)), ...bands,
    nan, dcDb: +db(Math.abs(dc)).toFixed(0), clipped,
    startClick: +(Math.abs(mono[0]) / (peak || 1)).toFixed(3), endDb: +db(endE / (peak || 1)).toFixed(0),
  };
}

// ---------------------------------------------------------------- rendering
const PLACES = {
  yard: { pos: [-9, 1.68, 24], yaw: 0 },
  hall: { pos: [-5, 1.68, 8], yaw: 0 },
  office: { pos: [15.5, 1.68, 13.2], yaw: Math.PI / 2 },
  corridor: { pos: [9.4, 1.68, 6], yaw: 0 },
  bay: { pos: [-4, 1.68, -12], yaw: 0 },
  under: { pos: [-20, 1.68, -2], yaw: 0 },
};

/**
 * spec: { name, opts, place, src: [dx,dy,dz] relative to listener (world axes) or abs: [x,y,z], enemy: 'pistol'|'rifle',
 *         mode: 'raw'|'mic', dur, preroll, ambience, before(eng) }
 */
export async function render(spec) {
  const dur = spec.dur ?? 2, pre = spec.preroll ?? (spec.mode === 'mic' ? 1.5 : 0.05);
  const oac = new OfflineAudioContext(2, Math.floor(SR * (dur + pre)), SR);
  const place = PLACES[spec.place || 'hall'];
  const cam = new THREE.PerspectiveCamera(80, 1, 0.05, 100);
  cam.rotation.order = 'YXZ'; cam.position.set(...place.pos); cam.rotation.y = place.yaw ?? 0; cam.updateMatrixWorld(true);
  const live = typeof window !== 'undefined' ? window.__ctx : null;
  let srcPos = null;
  if (spec.abs) srcPos = new THREE.Vector3(...spec.abs);
  else if (spec.src) srcPos = new THREE.Vector3(...spec.src).add(cam.position);
  const enemies = { list: [] };
  if (spec.enemy && srcPos) enemies.list.push({ position: srcPos.clone().setY(srcPos.y - 1.4), alive: true, weaponType: spec.enemy });
  const player = { position: cam.position.clone().setY(0), velocity: new THREE.Vector3(), alive: true, health: spec.health ?? 100, ammo: spec.ammo ?? 10, sprinting: !!spec.sprint, crouching: !!spec.crouch };
  const fake = { camera: cam, game: { state: 'playing' }, player, enemies, level: live?.level, combat: spec.los === false ? null : live?.combat };
  const eng = createEngine(oac, fake, { offline: true, seed: spec.seed ?? 1234, ambience: !!spec.ambience });
  await eng.ready;
  if (spec.mode !== 'mic') { eng.nodes.master.gain.value = 0; eng.nodes.worldSum.connect(oac.destination); }
  eng.update(0.016);
  if (spec.ambience) for (let i = 0; i < 12; i++) eng.update(0.1);   // let the zone-dependent bed settle
  const opts = Object.assign({}, spec.opts || {});
  if (srcPos && !opts.position) opts.position = srcPos;
  const t0 = performance.now();
  oac.suspend(pre).then(() => {
    if (spec.before) spec.before(eng);
    eng.update(0.016);
    if (spec.name) eng.play(spec.name, opts);
    if (spec.after) spec.after(eng);
    oac.resume();
  });
  if (spec.tick) {   // emulate the game's frame loop (needed for the fallback AGC and live monitors)
    for (let t = pre + spec.tick; t < dur + pre - 0.01; t += spec.tick) oac.suspend(Math.round(t * 1000) / 1000).then(() => { eng.update(spec.tick); oac.resume(); });
    for (let t = spec.tick; t < pre - 0.01; t += spec.tick) oac.suspend(Math.round(t * 1000) / 1000).then(() => { eng.update(spec.tick); oac.resume(); });
  }
  const out = await oac.startRendering();
  const chs = [out.getChannelData(0), out.getChannelData(1)];
  const m = analyze(chs, SR, Math.floor(pre * SR));
  m.renderMs = Math.round(performance.now() - t0);
  m.stats = eng.stats();
  return { m, chs, eng };
}

const row = (label, m) => ({ label, ...m, stats: undefined });

export const SCENARIOS = [
  // player pistol in different spaces (mic chain = what the player hears)
  ...['yard', 'hall', 'office', 'corridor', 'under'].map((p) => ({ label: `shot player ${p} [raw]`, name: 'shot', place: p, mode: 'raw', dur: 2.5 })),
  ...['yard', 'hall', 'office'].map((p) => ({ label: `shot player ${p} [mic]`, name: 'shot', place: p, mode: 'mic', dur: 2.5 })),
  { label: 'shot pistol 3m hall [raw]', name: 'shot_enemy', place: 'hall', src: [0, 0, -3], enemy: 'pistol', mode: 'raw', dur: 3 },
  { label: 'shot pistol 12m hall [raw]', name: 'shot_enemy', place: 'hall', src: [0, 0, -12], enemy: 'pistol', mode: 'raw', dur: 3 },
  { label: 'shot rifle 10m hall [raw]', name: 'shot_enemy', place: 'hall', src: [0, 0, -10], enemy: 'rifle', mode: 'raw', dur: 3 },
  { label: 'shot pistol 30m bay->hall [raw]', name: 'shot_enemy', place: 'hall', abs: [5, 1.4, -14], enemy: 'pistol', mode: 'raw', dur: 3 },
  { label: 'shot pistol corridor->office [raw]', name: 'shot_enemy', place: 'office', abs: [9.4, 1.4, 2], enemy: 'pistol', mode: 'raw', dur: 3 },
  { label: 'shot pistol 3m hall [mic]', name: 'shot_enemy', place: 'hall', src: [0, 0, -3], enemy: 'pistol', mode: 'mic', dur: 3 },
  { label: 'shot rifle 30m bay->hall [mic]', name: 'shot_enemy', place: 'hall', abs: [5, 1.4, -14], enemy: 'rifle', mode: 'mic', dur: 3 },
  { label: 'flyby rifle 0.8m [raw]', name: 'bullet_flyby', place: 'hall', src: [0.8, 0, -1], opts: { missDistance: 0.8, along: 15, weapon: 'rifle' }, mode: 'raw', dur: 0.8 },
  { label: 'flyby pistol 0.6m [raw]', name: 'bullet_flyby', place: 'hall', src: [0.6, 0, -1], opts: { missDistance: 0.6, along: 8, weapon: 'pistol' }, mode: 'raw', dur: 0.8 },
  { label: 'ricochet 5m [raw]', name: 'ricochet', place: 'hall', src: [3, -1, -4], mode: 'raw', dur: 1 },
  // impacts at 5 m
  ...['concrete', 'metal', 'wood', 'glass', 'flesh'].map((k) => ({ label: `impact ${k} 5m [raw]`, name: 'impact_' + k, place: 'hall', src: [0, -0.5, -5], opts: { volume: 0.6 }, mode: 'raw', dur: 2 })),
  // player foley
  { label: 'step concrete walk [raw]', name: 'step_concrete', place: 'hall', opts: { volume: 0.5 }, mode: 'raw', dur: 1 },
  { label: 'step concrete sprint [raw]', name: 'step_concrete', place: 'hall', sprint: true, opts: { volume: 0.85 }, mode: 'raw', dur: 1 },
  { label: 'step concrete crouch [raw]', name: 'step_concrete', place: 'hall', crouch: true, opts: { volume: 0.25 }, mode: 'raw', dur: 1 },
  { label: 'step metal walk [raw]', name: 'step_metal', place: 'hall', opts: { volume: 0.5 }, mode: 'raw', dur: 1.2 },
  { label: 'step asphalt walk [raw]', name: 'step_concrete', place: 'yard', opts: { volume: 0.5 }, mode: 'raw', dur: 1 },
  { label: 'step lino walk [raw]', name: 'step_concrete', place: 'office', opts: { volume: 0.5 }, mode: 'raw', dur: 1 },
  { label: 'step concrete walk [mic]', name: 'step_concrete', place: 'hall', opts: { volume: 0.5 }, mode: 'mic', dur: 1 },
  { label: 'land [raw]', name: 'land', place: 'hall', opts: { volume: 1 }, mode: 'raw', dur: 1 },
  // weapon handling (player)
  ...['dry', 'reload_out', 'reload_in', 'slide'].map((n) => ({ label: `${n} [raw]`, name: n, place: 'hall', mode: 'raw', dur: 1.2, ammo: n === 'reload_out' ? 0 : 5 })),
  { label: 'shell concrete 1.2m [raw]', name: 'shell', place: 'hall', src: [0.5, -1.6, -0.8], opts: { volume: 0.6 }, mode: 'raw', dur: 1.2 },
  { label: 'shell lino 1.2m [raw]', name: 'shell', place: 'office', src: [0.5, -1.6, -0.8], opts: { volume: 0.6 }, mode: 'raw', dur: 1.2 },
  // voices
  { label: 'shout 8m [raw]', name: 'shout', place: 'hall', src: [0, 0, -8], enemy: 'pistol', mode: 'raw', dur: 2 },
  { label: 'enemy death 6m [raw]', name: 'death', place: 'hall', src: [2, 0, -6], enemy: 'pistol', mode: 'raw', dur: 2.5 },
  { label: 'player hurt [raw]', name: 'hurt', place: 'hall', mode: 'raw', dur: 1.5 },
  { label: 'radio [raw]', name: 'radio', place: 'hall', mode: 'raw', dur: 3.5 },
  { label: 'body fall 4m [raw]', name: 'body_fall', place: 'hall', src: [0, -1.5, -4], mode: 'raw', dur: 1.5 },
];

export async function runAll(filter) {
  const rows = [];
  for (const s of SCENARIOS) {
    if (filter && !s.label.includes(filter)) continue;
    try { const { m } = await render(s); rows.push(row(s.label, m)); }
    catch (e) { rows.push({ label: s.label, error: String(e && e.stack || e) }); }
  }
  return rows;
}

/** Bed level in a place (mic chain, AGC settled), and level recovery after a close shot. */
export async function ambienceTest(place = 'hall', seconds = 8) {
  const { chs } = await render({ place, mode: 'mic', ambience: true, dur: seconds, preroll: 0.05 });
  const env = [];
  const w = Math.floor(0.5 * SR);
  for (let i = 0; i + w <= chs[0].length; i += w) { let e = 0; for (let k = i; k < i + w; k++) e += chs[0][k] * chs[0][k]; env.push(+db(Math.sqrt(e / w)).toFixed(1)); }
  return env;
}
export async function pumpTest(place = 'hall', tick = 0) {
  // quiet bed for 3 s, shot at 3 s, measure 250 ms RMS windows (AGC pumping and recovery)
  const { chs, m } = await render({ place, mode: 'mic', ambience: true, dur: 7, preroll: 3, name: 'shot', tick });
  const env = []; const w = Math.floor(0.25 * SR);
  for (let i = 0; i + w <= chs[0].length; i += w) { let e = 0; for (let k = i; k < i + w; k++) e += chs[0][k] * chs[0][k]; env.push(+db(Math.sqrt(e / w)).toFixed(1)); }
  return { env, agcMin: m.stats.agcMin, peak: m.peakDb, clipped: m.clipped };
}
