// In-browser audio harness (served by Vite: http://localhost:5186/scripts/audio/harness.html, driven by
// `node scripts/audio/run-harness.mjs`). Renders scripted scenes through the REAL engine graph (slots, panners,
// reverbs, bodycam mic worklet) with OfflineAudioContext and measures what nobody can listen to:
// clipping / NaN at the output, loudness per scene, the AGC duck/recovery curve, gunshot tails per space,
// occlusion through a locked door, loop seams, every contract event audible in the real graph, decoded memory,
// offline render speed per tier (audio-thread cost proxy) and the main-thread ms per frame of a firefight with
// 8 enemies on a realtime AudioContext. Spectrogram PNGs go back to the runner.
import { LAYOUT } from '/src/world/layout/index.js';
import { generateWorld, boxFlags, F_OCC } from '/src/world/gen.js';
import { BoxBVH } from '/src/world/bvh.js';
import { createEvents } from '/src/core/events.js';
import { createAudio } from '/src/audio/audio.js';

const SR = 48000;
const out = { scenes: {}, checks: [], pngs: {} };
const log = (m) => { const el = document.getElementById('log'); if (el) el.textContent += m + '\n'; console.log(m); };
const check = (ok, msg) => { out.checks.push({ ok: !!ok, msg }); log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// ------------------------------------------------------------------------------------------------------------
const W = generateWorld(LAYOUT);
const bvh = new BoxBVH(W.boxes, Uint8Array.from(W.boxes, boxFlags));
const clear = (a, b) => !bvh.occluded(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, 1, F_OCC);
const manifest = await (await fetch('/assets/audio/manifest.json')).json();
const encCache = new Map();
const fetchFile = async (p) => { if (!encCache.has(p)) encCache.set(p, fetch('/assets/audio/' + p).then((r) => r.arrayBuffer())); return encCache.get(p); };

const V3 = (x, y, z) => ({ x, y, z });
function mockCtx(tier) {
  const events = createEvents();
  const zl = W.zoneLookup;
  const doorsList = W.doors.map((d, i) => ({ ...d, index: i, t: d.state === 'open' ? 1 : d.state === 'half' ? 0.3 : 0, target: d.state === 'open' ? 1 : 0, speed: d.kind === 'roller' ? 0.8 : 1.6 }));
  const hit = { surf: 'concrete' };
  const world = {
    gen: W, zones: W.zones, zoneAt: (x, y, z) => zl.at(x, y, z), lineOfSight: clear,
    worldHit: (o, d, max, r) => { r.hit = true; r.t = 0.4; r.surface = hit.surf; return true; },
    doors: { list: doorsList, get: (id) => doorsList.find((d) => d.id === id) },
    glass: { list: W.glass.map((g) => ({ pane: g, alive: true })) }, lights: { level: () => 1 },
  };
  const player = { pos: V3(45, 0, 100), eye: V3(45, 1.5, 100), forward: V3(0, 0, -1), yaw: 0, moving: 0, crouched: false, health: 100 };
  const enemies = { list: LAYOUT.enemies.map((def) => ({ id: def.id, def, pos: V3(...def.pos), health: 100, dead: false, alerted: false })) };
  const machines = { agvs: [], conveyors: LAYOUT.conveyors.map((c) => ({ ...c })), robots: [], cranes: [] };
  machines.agv = () => null; machines.conveyor = (id) => machines.conveyors.find((c) => c.id === id); machines.robot = () => null; machines.crane = () => null;
  return {
    layout: LAYOUT, events, ORDER: { audio: 80 }, time: { now: 0, dt: 0, frame: 0 }, state: 'playing',
    settings: { data: { volume: 0.8 }, save() {} }, quality: { tier: { id: tier } },
    world, player, enemies, machines, weapon: { ammo: 10, reloading: 1.8 }, render: null, _hit: hit, _doors: doorsList,
  };
}
const place = (ctx, x, y, z, fx = 0, fz = -1) => { const p = ctx.player; p.eye.x = x; p.eye.y = y; p.eye.z = z; p.pos.x = x; p.pos.y = y - 1.5; p.pos.z = z; p.forward.x = fx; p.forward.z = fz; };
const shotRes = (shooter, o, d, extra = {}) => ({ hit: true, t: 10, point: V3(o.x + d.x * 10, o.y + d.y * 10, o.z + d.z * 10), normal: V3(0, 0, 1), surface: 'concrete', kind: 'static', id: '', target: null, part: '', damage: 9, shooter, origin: o, dir: d, glassBroken: false, ...extra });

/** build an audio module on an OfflineAudioContext and wait for its graph + the sounds it needs */
async function offlineAudio(dur, tier = 'high', names = [], ch = 2) {
  const ac = new OfflineAudioContext({ numberOfChannels: ch, length: Math.ceil(dur * SR), sampleRate: SR });
  const ctx = mockCtx(tier);
  const audio = createAudio(ctx, { manifest, ac, fetchFile, nullOutput: false });
  await audio.load(null);
  audio.init();
  audio.engine.setTier(tier);
  await audio.engine.whenReady();
  const E = audio.engine, bank = audio.bank;
  const want = new Set(names);
  await Promise.all([...want].map((n) => E.decodeSound(n, 0)));
  // tier-1 combat essentials are decoding in the background — wait for them too
  await Promise.all(bank.clips.filter((c) => c.decoding).map((c) => c.decoding));
  return { ac, ctx, audio, E, bank };
}
/** render with a frame callback every `step` s (game loop stand-in) */
async function render(S, dur, onFrame) {
  const { ac, ctx, audio } = S;
  const step = 1280 / SR;          // 37.5 fps, quantum-aligned
  let t = 0, frameMs = 0, frames = 0, maxMs = 0;
  const tick = () => {
    const t0 = performance.now();
    ctx.time.now = t; ctx.time.frame++;
    onFrame?.(t, ctx, audio);
    audio.update(step);
    const ms = performance.now() - t0; frameMs += ms; frames++; if (ms > maxMs) maxMs = ms;
    t += step;
    if (t < dur - step) ac.suspend(t).then(tick).then(() => ac.resume());
  };
  ac.suspend(0).then(tick).then(() => ac.resume());
  const w0 = performance.now();
  const buf = await ac.startRendering();
  return { buf, wallMs: performance.now() - w0, frameMs: frameMs / frames, maxFrameMs: maxMs };
}

// ------------------------------------------------------------------------------------------------------------
// measurements
function stats(buf, t0 = 0, t1 = buf.duration) {
  let peak = 0, nan = 0, over = 0, e = 0, n = 0;
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const d = buf.getChannelData(c);
    for (let i = Math.floor(t0 * buf.sampleRate); i < Math.min(d.length, t1 * buf.sampleRate); i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { nan++; continue; }
      const a = Math.abs(v); if (a > peak) peak = a; if (a > 0.999) over++;
      e += v * v; n++;
    }
  }
  return { peakDb: 20 * Math.log10(peak + 1e-12), rmsDb: 10 * Math.log10(e / Math.max(1, n) + 1e-20), nan, over, peak };
}
// BS.1770 integrated loudness (K-weighting, 400 ms blocks, absolute + relative gates)
function lufs(buf, t0 = 0, t1 = buf.duration) {
  const sr = buf.sampleRate;
  const biq = (b0, b1, b2, a1, a2) => { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; };
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const d = buf.getChannelData(c), f1 = biq(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585), f2 = biq(1, -2, 1, -1.99004745483398, 0.99007225036621);
    const y = new Float32Array(d.length); for (let i = 0; i < d.length; i++) y[i] = f2(f1(Number.isFinite(d[i]) ? d[i] : 0)); chans.push(y);
  }
  const blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), z = [];
  for (let s = Math.floor(t0 * sr); s + blk <= Math.min(chans[0].length, t1 * sr); s += hop) {
    let e = 0; for (const y of chans) for (let i = s; i < s + blk; i++) e += y[i] * y[i];
    z.push(e / blk);
  }
  const L = (m) => -0.691 + 10 * Math.log10(m + 1e-20);
  let g = z.filter((m) => L(m) > -70); if (!g.length) return -99;
  const rel = L(g.reduce((a, b) => a + b, 0) / g.length) - 10;
  g = g.filter((m) => L(m) > rel);
  return g.length ? L(g.reduce((a, b) => a + b, 0) / g.length) : -99;
}
function envelope(buf, step = 0.02) {
  const d = buf.getChannelData(0), n = Math.round(step * buf.sampleRate), o = [];
  for (let i = 0; i + n <= d.length; i += n) { let e = 0; for (let j = i; j < i + n; j++) e += d[j] * d[j]; o.push(10 * Math.log10(e / n + 1e-20)); }
  return o;
}
/** time (s) for the RMS envelope to fall `drop` dB below its maximum after t0 */
function decayTime(buf, t0, drop = 30) {
  const env = envelope(buf, 0.01); const i0 = Math.round(t0 / 0.01);
  let mx = -200, im = i0; for (let i = i0; i < Math.min(env.length, i0 + 30); i++) if (env[i] > mx) { mx = env[i]; im = i; }
  for (let i = im; i < env.length; i++) if (env[i] < mx - drop) return (i - im) * 0.01;
  return (env.length - im) * 0.01;
}
function centroid(buf, t0, t1) {
  // spectral centroid via a coarse DFT over 2048-sample frames (enough for a muffled/bright comparison)
  const d = buf.getChannelData(0), N = 2048, sr = buf.sampleRate; let num = 0, den = 0;
  for (let s = Math.floor(t0 * sr); s + N < Math.min(d.length, t1 * sr); s += N) {
    for (let k = 1; k < N / 2; k += 4) {
      let re = 0, im = 0; const w = 2 * Math.PI * k / N;
      for (let i = 0; i < N; i += 2) { const v = d[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
      const m = Math.hypot(re, im); num += m * k * sr / N; den += m;
    }
  }
  return den ? num / den : 0;
}
function spectrogram(buf, name, maxHz = 12000) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, N = 1024, hop = 512;
  const cols = Math.min(900, Math.floor((d.length - N) / hop)), stride = (d.length - N) / cols / hop;
  const rows = 256, cv = document.createElement('canvas'); cv.width = cols; cv.height = rows + 14;
  const g = cv.getContext('2d'), img = g.createImageData(cols, rows);
  const re = new Float32Array(N), im = new Float32Array(N);
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), xr = re[i + k + len / 2] * c - im[i + k + len / 2] * s, xi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } }
  };
  const binMax = Math.floor(maxHz / (sr / N));
  for (let x = 0; x < cols; x++) {
    const s = Math.floor(x * stride) * hop;
    for (let i = 0; i < N; i++) { re[i] = (d[s + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let y = 0; y < rows; y++) {
      const b = Math.max(1, Math.floor((1 - y / rows) * binMax));
      const db = 20 * Math.log10(Math.hypot(re[b], im[b]) / N + 1e-9);
      const v = Math.max(0, Math.min(1, (db + 100) / 80));
      const o = (y * cols + x) * 4;
      img.data[o] = 255 * Math.min(1, v * 1.6); img.data[o + 1] = 255 * Math.max(0, v * 1.6 - 0.6); img.data[o + 2] = 255 * Math.max(0, 0.5 - v) + 60 * v; img.data[o + 3] = 255;
    }
  }
  g.fillStyle = '#000'; g.fillRect(0, 0, cols, rows + 14); g.putImageData(img, 0, 0);
  g.fillStyle = '#fff'; g.font = '10px monospace'; g.fillText(`${name}  ${buf.duration.toFixed(1)} s  0-${maxHz / 1000} kHz`, 2, rows + 11);
  out.pngs[name] = cv.toDataURL('image/png');
}

// ------------------------------------------------------------------------------------------------------------
const COMBAT = ['weapon.pistol.shot', 'weapon.rifle.shot', 'weapon.shotgun.shot', 'weapon.rifle.burst', 'weapon.smg.burst', 'weapon.distant.indoor', 'weapon.distant.outdoor', 'impact.concrete', 'debris.concrete', 'impact.metal', 'impact.sheetmetal', 'impact.flesh', 'bullet.whizz', 'bullet.ricochet', 'weapon.casing', 'voice.alert', 'voice.command', 'voice.pain', 'voice.death', 'voice.scream', 'voice.taunt', 'voice.reload', 'foley.bodyfall', 'foley.gear', 'amb.warehouse', 'step.concrete'];

async function sceneYard() {
  const S = await offlineAudio(8, 'high', ['amb.outside', 'amb.outside.birds', 'loop.forklift.idle', 'step.asphalt']);
  place(S.ctx, 45, 1.5, 100);
  S.ctx.player.moving = 2.3;
  const r = await render(S, 8, (t, ctx) => { ctx.player.pos.z -= 2.3 * 1280 / SR; ctx.player.eye.z = ctx.player.pos.z; });
  const st = stats(r.buf, 2, 8), L = lufs(r.buf, 2, 8);
  out.scenes.yard = { ...st, lufs: +L.toFixed(1), decodedMB: S.audio.stats().decodedMB, wallMs: Math.round(r.wallMs) };
  check(st.nan === 0 && st.over === 0, `yard: no NaN / no samples ≥ 0.999 (peak ${st.peakDb.toFixed(1)} dBFS)`);
  check(L > -42 && L < -20, `yard ambience loudness ${L.toFixed(1)} LUFS within -42..-20`);
  spectrogram(r.buf, 'yard_walk');
}

async function sceneAgc() {
  // quiet hall, one own pistol shot at 2.0 s; AGC gain trace captured from the worklet's second output
  const S = await offlineAudio(6, 'high', ['amb.warehouse', 'weapon.pistol.shot', 'weapon.distant.indoor'], 3);
  const { ac, E } = S;
  check(E.mic.usingWorklet, 'AGC AudioWorklet active in OfflineAudioContext');
  E.mic.master.disconnect();
  const split = ac.createChannelSplitter(2), merge = ac.createChannelMerger(3);
  E.mic.master.connect(split); split.connect(merge, 0, 0); split.connect(merge, 1, 1);
  if (E.mic.agc) E.mic.agc.connect(merge, 1, 2);
  ac.destination.channelInterpretation = 'discrete'; merge.connect(ac.destination);
  place(S.ctx, 50, 1.5, 30);
  let fired = false;
  const r = await render(S, 6, (t, ctx) => { if (!fired && t >= 2) { fired = true; ctx.events.emit('weapon:fire', { ammo: 5 }); } });
  const g = r.buf.getChannelData(2), at = (t) => 20 * Math.log10(g[Math.round(t * SR)] + 1e-9);
  const curve = [1.9, 2.01, 2.05, 2.25, 2.5, 3.0, 3.5, 4.0, 5.0].map((t) => [t, +at(t).toFixed(1)]);
  let minG = 0; for (let i = 2 * SR; i < 2.6 * SR; i++) minG = Math.min(minG, 20 * Math.log10(g[i] + 1e-9));
  out.scenes.agc = { curve, minDb: +minG.toFixed(1), ...stats(r.buf) };
  check(minG < at(1.9) - 10, `AGC ducks on the shot: ${at(1.9).toFixed(1)} → ${minG.toFixed(1)} dB`);
  check(at(2.5) < at(1.9) - 2, `AGC still pumping 0.5 s after (${at(2.5).toFixed(1)} dB)`);
  check(at(4.0) > at(1.9) - 2, `AGC recovered within ~2 s (${at(4.0).toFixed(1)} dB at +2 s)`);
  const st = stats(r.buf);
  check(st.nan === 0 && st.peak < 1, `agc scene: output bounded (peak ${st.peakDb.toFixed(1)} dBFS)`);
  spectrogram(r.buf, 'agc_shot_hall');
}

async function sceneSpaces() {
  // the same enemy pistol shot (AGC neutralised) in four spaces: tail length must follow the room
  const res = {};
  for (const [name, L, src] of [['hall', [50, 1.5, 30], [50, 1.5, 22]], ['small_room', [15, 1.5, 6], [12, 1.5, 4]], ['basement', [6, -2.2, 46], [4, -2.2, 44]], ['outdoor', [45, 1.5, 100], [45, 1.5, 92]]]) {
    const S = await offlineAudio(4, 'high', COMBAT);
    S.E.mic.agc?.port.postMessage({ set: { ratio: 0, boost: 0, clip: 0.999, floor: 0 } });
    place(S.ctx, ...L);
    const en = S.ctx.enemies.list[2]; en.pos.x = src[0]; en.pos.y = src[1] - 1.4; en.pos.z = src[2];
    let fired = false;
    const r = await render(S, 4, (t, ctx) => { if (!fired && t > 0.5) { fired = true; ctx.events.emit('enemy:fire', { id: en.id, enemy: en }); } });
    res[name] = { t30: +decayTime(r.buf, 0.5, 30).toFixed(2), peakDb: +stats(r.buf).peakDb.toFixed(1) };
    if (name === 'hall' || name === 'basement') spectrogram(r.buf, `shot_${name}`);
  }
  out.scenes.spaces = res;
  log(`  tails (-30 dB): ${Object.entries(res).map(([k, v]) => `${k} ${v.t30}s`).join(', ')}`);
  check(res.hall.t30 > res.small_room.t30 + 0.2, `hall tail longer than small room (${res.hall.t30} vs ${res.small_room.t30} s)`);
  check(res.basement.t30 > res.small_room.t30, `basement tail longer than small room (${res.basement.t30} vs ${res.small_room.t30} s)`);
}

async function sceneOcclusion() {
  // scream in the cash room, listener in the corridor outside: door locked vs open
  const res = {};
  for (const state of ['locked', 'open']) {
    const S = await offlineAudio(3.5, 'high', ['voice.scream']);
    S.E.mic.agc?.port.postMessage({ set: { ratio: 0, boost: 0, clip: 0.999, floor: 0 } });
    const d = S.ctx._doors.find((x) => x.id === 'd_geld'); d.state = state; d.t = state === 'open' ? 1 : 0; d.target = d.t;
    place(S.ctx, 11, 6.0, 10.5, -1, 0);
    let fired = false;
    const r = await render(S, 3.5, (t, ctx, audio) => { if (!fired && t > 0.3) { fired = true; S.E.resolve(); audio.playAt('voice.scream', { x: 4.5, y: 5.9, z: 6 }, { volume: 1 }); } });
    res[state] = { rmsDb: +stats(r.buf, 0.3, 3.4).rmsDb.toFixed(1), centroidHz: Math.round(centroid(r.buf, 0.35, 2.5)) };
    spectrogram(r.buf, `scream_door_${state}`);
  }
  out.scenes.occlusion = res;
  check(res.open.rmsDb - res.locked.rmsDb > 10, `locked door attenuates the scream by ${(res.open.rmsDb - res.locked.rmsDb).toFixed(1)} dB (> 10)`);
  check(res.locked.centroidHz < res.open.centroidHz * 0.7, `locked door muffles: centroid ${res.locked.centroidHz} vs ${res.open.centroidHz} Hz`);
}

async function sceneFirefight(tier) {
  // 8 enemies around the listener in the hall, ~14 rounds/s, own fire, impacts, near misses, voices, deaths
  const S = await offlineAudio(12, tier, COMBAT);
  const { ctx } = S;
  place(ctx, 50, 1.5, 30);
  const F = ctx.enemies.list.slice(0, 8);
  F.forEach((e, k) => { const a = k / 8 * Math.PI * 2; e.pos.x = 50 + Math.cos(a) * (8 + k * 2); e.pos.y = 0; e.pos.z = 30 + Math.sin(a) * (8 + k * 2); e.alerted = true; });
  let f = 0;
  const r = await render(S, 12, (t, c) => {
    f++;
    if (t < 1) return;
    const e = F[f % 8];
    if (f % 3 === 0 && !e.dead) {
      c.events.emit('enemy:fire', { id: e.id, enemy: e });
      const dx = 50 - e.pos.x + (Math.random() - 0.5) * 2, dz = 30 - e.pos.z + (Math.random() - 0.5) * 2, l = Math.hypot(dx, dz);
      c.events.emit('shot', shotRes(e, V3(e.pos.x, 1.4, e.pos.z), V3(dx / l, 0, dz / l), { t: l + 3, point: V3(e.pos.x + dx / l * (l + 3), 1.2, e.pos.z + dz / l * (l + 3)) }));
    }
    if (f % 7 === 0) { c.events.emit('weapon:fire', { ammo: 5 }); c.events.emit('shot', shotRes(c.player, V3(50, 1.5, 30), V3(0, 0, -1), { surface: f % 14 ? 'concrete' : 'metal' })); }
    if (f % 41 === 0) c.events.emit('enemy:damage', { id: e.id, enemy: e, amount: 30, part: 'torso' });
    if (f === 300) { F[3].dead = true; c.events.emit('enemy:death', { id: F[3].id, enemy: F[3], part: 'torso' }); }
  });
  const st = stats(r.buf), L = lufs(r.buf, 1, 12);
  const rt = r.wallMs / 12000;
  out.scenes[`firefight_${tier}`] = { ...st, lufs: +L.toFixed(1), renderFactor: +rt.toFixed(3), frameMs: +r.frameMs.toFixed(3), maxFrameMs: +r.maxFrameMs.toFixed(2), stats: S.audio.stats() };
  check(st.nan === 0 && st.over === 0, `firefight (${tier}): no NaN, no clipping (peak ${st.peakDb.toFixed(1)} dBFS)`);
  check(L > -24 && L < -8, `firefight (${tier}) loudness ${L.toFixed(1)} LUFS within -24..-8`);
  log(`  firefight ${tier}: offline render ${(rt * 100).toFixed(1)} % of real time, peak voices ${S.audio.stats().peakActive}, steals ${S.audio.stats().steals}, drops ${S.audio.stats().drops}`);
  check(S.audio.stats().peakActive <= 24, `firefight (${tier}): ≤ 24 voices (peak ${S.audio.stats().peakActive})`);
  if (tier === 'high') spectrogram(r.buf, 'firefight_hall');
}

async function sceneEvents() {
  // every sound-producing contract event, 1.4 s apart, in the real graph: each window must be audible
  const EV = ['weapon:fire', 'weapon:reload', 'weapon:reloaded', 'weapon:empty', 'enemy:fire', 'shot', 'hit', 'enemy:alert', 'enemy:damage', 'enemy:death', 'player:damage', 'player:flashlight', 'door:state', 'door:locked', 'glass:break', 'lights:circuit', 'radio', 'moment', 'player:death'];
  const dur = EV.length * 1.4 + 1;
  const S = await offlineAudio(dur, 'high', [...COMBAT, 'door.open', 'door.close', 'foley.lightswitch', 'weapon.pistol.mag', 'weapon.pistol.magin', 'weapon.pistol.slide', 'weapon.dryfire', 'glass.shatter', 'glass.debris', 'foley.switch', 'machine.light.flicker', 'voice.radio', 'loop.static', 'voice.player.pain', 'voice.surprise']);
  const { ctx } = S;
  S.E.mic.agc?.port.postMessage({ set: { boost: 0 } });
  // silence the beds for this scene so each window measures its event
  for (const b of S.audio.K.W.beds) b.zones = [];
  place(ctx, 20, 1.5, 50);
  const en = ctx.enemies.list[3]; en.pos.x = 20; en.pos.z = 44;
  const door = ctx._doors.find((d) => d.id === 'd_pack_we');
  const pay = {
    'weapon:fire': { ammo: 3 }, 'weapon:reload': ctx.weapon, 'weapon:reloaded': ctx.weapon, 'weapon:empty': ctx.weapon,
    'enemy:fire': { id: en.id, enemy: en }, shot: shotRes(en, V3(20, 1.4, 44), V3(0.08, 0, 0.997)), hit: shotRes(ctx.player, V3(20, 1.5, 50), V3(0, 0, -1), { target: en, point: V3(20, 1.3, 44.3) }),
    'enemy:alert': { id: en.id, enemy: en }, 'enemy:damage': { id: en.id, enemy: en, amount: 20, part: 'torso' }, 'enemy:death': { id: en.id, enemy: en, part: 'torso' },
    'player:damage': { amount: 10, part: 'torso', health: 90 }, 'player:flashlight': { on: true }, 'door:state': { id: door.id, state: 'open', door },
    'door:locked': { id: door.id, door }, 'glass:break': { id: 'g4', point: V3(0.2, 2, 50) }, 'lights:circuit': { id: 'west_eg', level: 0, fade: 0.5 },
    radio: { speaker: 'Zentrale', text: 'Verstanden.' }, moment: { id: 'm02_tor_faellt' }, 'player:death': {},
  };
  let i = 0;
  const r = await render(S, dur, (t, c) => {
    if (i < EV.length && t >= 0.5 + i * 1.4) {
      const n = EV[i++];
      if (n === 'enemy:death') en.dead = true;
      if (n === 'door:state') { door.state = 'open'; door.target = 1; }
      c.events.emit(n, pay[n]);
    }
  });
  const res = {};
  EV.forEach((n, k) => { res[n] = +stats(r.buf, 0.5 + k * 1.4, 0.5 + k * 1.4 + 1.3).rmsDb.toFixed(1); });
  out.scenes.events = res;
  const quiet = EV.filter((n) => res[n] < -62);
  check(!quiet.length, `every contract event audible in the real graph (quietest ${Math.min(...Object.values(res)).toFixed(1)} dBFS rms)${quiet.length ? ': silent ' + quiet.join(', ') : ''}`);
  spectrogram(r.buf, 'contract_events');
}

async function sceneLoops() {
  // loop seams: render each loop across its loop point at the buffer's own rate, compare the seam with the music
  const bank = (await offlineAudio(0.1, 'low')).bank;
  const res = {};
  for (const s of bank.sounds.values()) {
    for (const ci of s.enabled) {
      const c = bank.clips[ci]; if (!c.loop) continue;
      const rate = s.rate || SR;
      const dc = new OfflineAudioContext(1, 1, rate);
      const buf = await dc.decodeAudioData((await fetchFile(c.file)).slice(0));
      const ac = new OfflineAudioContext(1, Math.round(rate * 1.0), rate);
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true; src.loopStart = c.loopStart; src.loopEnd = Math.min(buf.duration, c.loopEnd);
      src.connect(ac.destination); src.start(0, src.loopEnd - 0.5);
      const o = await ac.startRendering(), d = o.getChannelData(0);
      const seam = Math.round(0.5 * rate), w = Math.round(0.005 * rate);
      // largest first difference at the seam vs. the 95th percentile of first differences around it
      let jump = 0; for (let i = seam - 2; i < seam + 3; i++) jump = Math.max(jump, Math.abs(d[i] - d[i - 1]));
      const diffs = []; for (let i = seam - 40 * w; i < seam + 40 * w; i++) if (Math.abs(i - seam) > 4) diffs.push(Math.abs(d[i] - d[i - 1]));
      diffs.sort((a, b) => a - b);
      const p99 = diffs[Math.floor(diffs.length * 0.995)] + 1e-6;
      res[c.file] = +(20 * Math.log10(jump / p99 + 1e-9)).toFixed(1);
    }
  }
  out.scenes.loops = res;
  const bad = Object.entries(res).filter(([, v]) => v > 6);
  check(!bad.length, `loop seams: ${Object.keys(res).length} loops, worst seam ${Math.max(...Object.values(res)).toFixed(1)} dB over the local 99.5th-percentile step${bad.length ? ' — clicks: ' + bad.map(([k, v]) => `${k} ${v}`).join(', ') : ''}`);
}

async function sceneMemory() {
  // decoded MB after load (tier 0) and once the tier-1 background decode has finished
  const ac = new OfflineAudioContext(2, SR, SR);
  const ctx = mockCtx('low');
  const audio = createAudio(ctx, { manifest, ac, fetchFile, nullOutput: false });
  const t0 = performance.now();
  await audio.load(null);
  const afterLoad = audio.engine.decodedMB(), loadMs = performance.now() - t0;
  audio.init();
  await audio.engine.whenReady();
  for (let k = 0; k < 50 && audio.bank.clips.some((c) => c.decoding); k++) await Promise.all(audio.bank.clips.filter((c) => c.decoding).map((c) => c.decoding));
  const settled = audio.engine.decodedMB(), bgMs = performance.now() - t0;
  out.scenes.memory = { afterLoadMB: +afterLoad.toFixed(1), loadMs: Math.round(loadMs), afterBackgroundMB: +settled.toFixed(1), backgroundMs: Math.round(bgMs), peakMB: audio.stats().peakDecodedMB };
  check(settled <= 60, `decoded PCM after background decode ${settled.toFixed(1)} MB ≤ 60 MB (after load ${afterLoad.toFixed(1)} MB in ${Math.round(loadMs)} ms)`);
}

async function realtimeFirefight() {
  // main-thread cost on a realtime AudioContext: 8 enemies firing, voices, impacts — per-frame ms of the audio
  // module (update + event handlers), measured over 8 s of requestAnimationFrame frames
  const ac = new AudioContext({ latencyHint: 'interactive' });
  await ac.resume().catch(() => {});
  const ctx = mockCtx('low');
  const audio = createAudio(ctx, { manifest, ac, fetchFile, nullOutput: false });
  await audio.load(null); audio.init(); audio.engine.setTier('low'); await audio.engine.whenReady();
  await Promise.all(COMBAT.map((n) => audio.engine.decodeSound(n, 0)));
  place(ctx, 50, 1.5, 30);
  const F = ctx.enemies.list.slice(0, 8);
  F.forEach((e, k) => { e.pos.x = 44 + k * 1.6; e.pos.y = 0; e.pos.z = 18; e.alerted = true; });
  const res = {};
  for (const tier of ['low', 'high']) {
    audio.engine.setTier(tier);
    const ms = [];
    let f = 0;
    await new Promise((done) => {
      const t0 = performance.now(); let last = t0;
      const frame = (now) => {
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        ctx.time.now += dt;
        const a = performance.now();
        const e = F[f % 8]; f++;
        if (f % 4 === 0) { ctx.events.emit('enemy:fire', { id: e.id, enemy: e }); ctx.events.emit('shot', shotRes(e, V3(e.pos.x, 1.4, e.pos.z), V3(0.1, 0, 0.995))); }
        if (f % 9 === 0) { ctx.events.emit('weapon:fire', { ammo: 4 }); ctx.events.emit('shot', shotRes(ctx.player, V3(50, 1.5, 30), V3(0, 0, -1))); }
        if (f % 45 === 0) ctx.events.emit('enemy:damage', { id: e.id, enemy: e, amount: 15, part: 'torso' });
        e.pos.x += 0.01;
        audio.update(dt);
        ms.push(performance.now() - a);
        if (now - t0 < 8000) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    ms.sort((x, y) => x - y);
    res[tier] = { frames: ms.length, avgMs: +(ms.reduce((s, v) => s + v, 0) / ms.length).toFixed(3), p95Ms: +ms[Math.floor(ms.length * 0.95)].toFixed(3), maxMs: +ms[ms.length - 1].toFixed(2), active: audio.stats().active, peakActive: audio.stats().peakActive };
  }
  out.scenes.realtime = { ...res, state: ac.state, baseLatency: ac.baseLatency, sampleRate: ac.sampleRate };
  check(res.low.avgMs < 0.5, `main thread, firefight with 8 enemies (low tier): ${res.low.avgMs} ms/frame avg, p95 ${res.low.p95Ms} ms`);
  ac.close();
}

const which = new URLSearchParams(location.search).get('scenes')?.split(',') ?? ['memory', 'yard', 'agc', 'spaces', 'occlusion', 'firefight', 'events', 'loops', 'realtime'];
const T0 = performance.now();
for (const s of which) {
  try {
    log(`# ${s}`);
    if (s === 'memory') await sceneMemory();
    if (s === 'yard') await sceneYard();
    if (s === 'agc') await sceneAgc();
    if (s === 'spaces') await sceneSpaces();
    if (s === 'occlusion') await sceneOcclusion();
    if (s === 'firefight') { await sceneFirefight('high'); await sceneFirefight('low'); }
    if (s === 'events') await sceneEvents();
    if (s === 'loops') await sceneLoops();
    if (s === 'realtime') await realtimeFirefight();
  } catch (e) { check(false, `scene ${s} threw: ${e?.stack ?? e}`); }
}
out.ms = Math.round(performance.now() - T0);
out.ua = navigator.userAgent;
window.__harness = out;
log(`done in ${out.ms} ms: ${out.checks.filter((c) => !c.ok).length} failures`);
