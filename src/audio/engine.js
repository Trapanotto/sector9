// Web Audio engine: decoding with priorities + LRU (decoded-PCM budget), a fixed pool of voice slots with
// priorities / per-category limits / stealing, 3D positioning (HRTF or equal-power by quality tier), per-category
// distance models, zone acoustics (occlusion, portal panning, reverb sends), the bodycam mic chain on the
// master. Owner: E.
//
// Main-thread cost is bounded: all nodes of a slot are created once; a play() creates one AudioBufferSourceNode;
// update() touches only active slots, ≤ RAYS_PER_FRAME sight rays, AudioParams only when a value changed.
// Without Web Audio (Node tests) the engine runs in "null" mode and only records requests.
import { decodeRate } from './bank.js';
import { ACOUSTIC, createSolver } from './acoustics.js';
import { createMic } from './mic.js';
import { createReverbs } from './reverb.js';

export const MAX_VOICES = 24;          // CONTRACT §9 (beds and loops included)
export const DECODED_BUDGET = 52 * 1048576;   // LRU target; CONTRACT cap 60 MB
const RAYS_PER_FRAME = 3;

// per category: voice limit, priority, distance model (ref m, max m, rolloff), reverb send, bus, 2D
export const CATS = {
  weapon:   { limit: 8, prio: 9, ref: 7, max: 220, roll: 1.0, send: 1.0, bus: 'weapons' },
  impact:   { limit: 6, prio: 5, ref: 2, max: 55, roll: 1.15, send: 0.7, bus: 'weapons' },
  handling: { limit: 3, prio: 6, ref: 1, max: 18, roll: 1.3, send: 0.35, bus: 'weapons' },
  voice:    { limit: 6, prio: 7, ref: 2.5, max: 90, roll: 0.95, send: 0.85, bus: 'voices' },
  murmur:   { limit: 3, prio: 4, ref: 2, max: 30, roll: 1.1, send: 0.6, bus: 'voices' },
  player:   { limit: 2, prio: 8, ref: 1, max: 10, roll: 1, send: 0.15, bus: 'voices', twoD: true },
  radio:    { limit: 1, prio: 8, ref: 1, max: 10, roll: 1, send: 0, bus: 'radio', twoD: true },
  step:     { limit: 5, prio: 2, ref: 1.2, max: 32, roll: 1.25, send: 0.45, bus: 'effects' },
  foley:    { limit: 4, prio: 3, ref: 1.5, max: 30, roll: 1.2, send: 0.4, bus: 'effects' },
  door:     { limit: 3, prio: 5, ref: 3, max: 65, roll: 1.0, send: 0.7, bus: 'effects' },
  machine:  { limit: 8, prio: 3, ref: 4, max: 55, roll: 1.05, send: 0.6, bus: 'ambience' },
  amb:      { limit: 4, prio: 6, ref: 1, max: 10, roll: 1, send: 0, bus: 'ambience', twoD: true },
  tension:  { limit: 2, prio: 6, ref: 1, max: 10, roll: 1, send: 0.3, bus: 'ambience', twoD: true },
  ui:       { limit: 2, prio: 8, ref: 1, max: 10, roll: 1, send: 0, bus: 'ui', twoD: true },
};
export const VOLUME_GROUPS = ['weapons', 'voices', 'effects', 'ambience'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createEngine({ bank, fetchFile, acoustics = null, tier = "low", ac = null, nullOutput = false, log = null, onPlay = null }) {
  const E = {
    ac, bank, tier, ready: false, unlocked: !!ac, nullOutput,
    stats: { plays: 0, drops: 0, steals: 0, late: 0, decodedBytes: 0, peakDecodedBytes: 0, decodes: 0, evictions: 0,
      updateMs: 0, updateMsMax: 0, rays: 0, active: 0, peakActive: 0, byName: new Map() },
    listener: { x: 0, y: 1.5, z: 0, fx: 0, fy: 0, fz: -1, zone: -1 },
    acoustics, solver: acoustics ? createSolver(acoustics.graph) : null,
    volumes: { master: 0.8, weapons: 1, voices: 1, effects: 1, ambience: 1, radio: 1, ui: 1 },
  };
  const slots = [];
  const handleGen = new Uint32Array(MAX_VOICES);
  const catCount = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]));
  let buses = null, mic = null, reverbs = null, decoders = new Map(), rayCursor = 0, frame = 0;

  // ---------------------------------------------------------------------------------------------------------
  // decoding (priorities, LRU)
  const queue = [];           // clip objects waiting for decode, kept sorted by priority
  let running = 0;
  const MAX_DECODES = 3;
  function decoderFor(rate) {
    if (!rate) return E.ac;
    let d = decoders.get(rate);
    if (!d && typeof OfflineAudioContext !== 'undefined') {
      try { d = new OfflineAudioContext(1, 1, rate); } catch { d = E.ac ?? null; }
      decoders.set(rate, d);
    }
    return d ?? E.ac;
  }
  async function ensureBytes(c) {
    if (c.enc) return c.enc;
    if (!c.fetching) c.fetching = fetchFile(c.file).then((b) => { c.enc = b; return b; });
    return c.fetching;
  }
  /** request a decoded buffer; resolves to the AudioBuffer or null. prio: lower = sooner */
  function decode(c, prio = 5) {
    if (c.buf) { c.used = performance.now(); return Promise.resolve(c.buf); }
    if (c.failed || nullOutput) return Promise.resolve(null);
    if (c.decoding) { if (prio < c.qprio) { c.qprio = prio; sortQueue(); } return c.decoding; }
    c.qprio = prio;
    c.decoding = new Promise((res) => { c._res = res; });
    queue.push(c); sortQueue(); pump();
    return c.decoding;
  }
  function sortQueue() { queue.sort((a, b) => a.qprio - b.qprio); }
  function pump() {
    while (running < MAX_DECODES && queue.length) {
      const c = queue.shift();
      running++;
      (async () => {
        let buf = null;
        try {
          const bytes = await ensureBytes(c);
          const rate = c.sound.rate;
          const dc = decoderFor(rate);
          if (!dc) throw new Error('no decoder yet');
          buf = await dc.decodeAudioData(bytes.slice(0));
          E.stats.decodes++;
        } catch (e) {
          if (String(e?.message).includes('no decoder')) { c.decoding = null; running--; c._res(null); return; }
          c.failed = true; log?.(`[audio] decode failed ${c.file}: ${e?.message ?? e}`);
        }
        if (buf) {
          c.buf = buf; c.used = performance.now();
          const b = buf.length * buf.numberOfChannels * 4;
          c.decBytes = b; E.stats.decodedBytes += b;
          if (E.stats.decodedBytes > E.stats.peakDecodedBytes) E.stats.peakDecodedBytes = E.stats.decodedBytes;
          evict();
        }
        c.decoding = null; running--;
        c._res(buf); c._res = null;
        pump();
      })();
    }
  }
  function evict() {
    if (E.stats.decodedBytes <= DECODED_BUDGET) return;
    const cand = bank.clips.filter((c) => c.buf && !c.pinned && !c.playing).sort((a, b) => a.used - b.used);
    for (const c of cand) {
      if (E.stats.decodedBytes <= DECODED_BUDGET * 0.9) break;
      E.stats.decodedBytes -= c.decBytes; c.buf = null; c.decBytes = 0; E.stats.evictions++;
    }
  }
  E.decode = decode;
  E.decodeSound = (name, prio = 5, pin = false) => {
    const s = bank.sounds.get(name); if (!s) return Promise.resolve([]);
    return Promise.all(s.enabled.map((i) => { const c = bank.clips[i]; if (pin) c.pinned = true; return decode(c, prio); }));
  };
  E.prefetch = (name, prio = 8) => { const s = bank.sounds.get(name); if (s) for (const i of s.enabled) ensureBytes(bank.clips[i]).catch(() => {}); };
  E.decodedMB = () => E.stats.decodedBytes / 1048576;

  // ---------------------------------------------------------------------------------------------------------
  // graph
  function build() {
    const a = E.ac;
    mic = createMic(a, { tier: E.tier, log });
    buses = {};
    const world = a.createGain();             // everything the mic hears acoustically
    world.connect(mic.input);
    for (const g of [...VOLUME_GROUPS]) { const n = a.createGain(); n.connect(world); buses[g] = n; }
    // shoulder radio: small speaker band (the lines are already radio-processed), dry onto the mic
    buses.radio = a.createGain();
    const rhp = a.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 320; rhp.Q.value = 0.7;
    const rlp = a.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 3300; rlp.Q.value = 0.9;
    buses.radio.connect(rhp); rhp.connect(rlp); rlp.connect(mic.input);
    buses.ui = a.createGain(); buses.ui.connect(mic.output);               // UI: after the mic chain
    buses.world = world;
    reverbs = createReverbs(a, { tier: E.tier, bank, out: world, log });
    reverbs.loadIRs((c, p) => { c.pinned = true; return decode(c, p); },
      (c) => { if (c.buf) { E.stats.decodedBytes -= c.decBytes; c.buf = null; c.decBytes = 0; c.pinned = false; } });
    E.mic = mic; E.buses = buses; E.reverbs = reverbs;
    for (let i = 0; i < MAX_VOICES; i++) slots.push(makeSlot(i));
    applyVolumes();
    applyTier();
    E.ready = true;
  }
  function makeSlot(i) {
    const a = E.ac;
    const s = {
      i, busy: false, src: null, clip: null, cat: 'foley', prio: 0, t0: 0, tEnd: 0, loop: false, twoD: false,
      follow: null, x: 0, y: 0, z: 0, base: 1, ref: 1, max: 30, roll: 1, sendK: 0, lpExtra: 20000, occlude: true,
      env: a.createGain(), gain: a.createGain(), filter: a.createBiquadFilter(), panner: a.createPanner(),
      sendA: a.createGain(), sendB: a.createGain(), famA: '', famB: '', outBus: null, outPanned: null,
      loss: 0, lossT: 0, lpOcc: 20000, obst: 0, obstT: 0, losTick: -1, zone: -1, solverV: -1,
      lastG: -1, lastLP: -1, lastWA: -1, lastWB: -1, lastX: 1e9, lastY: 1e9, lastZ: 1e9,
      owner: -1, stopping: false, rate: 1, aud: 0, pending: false,
    };
    s.filter.type = 'lowpass'; s.filter.Q.value = 0.5; s.filter.frequency.value = 20000;
    const p = s.panner;
    p.panningModel = 'equalpower'; p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 0;
    p.coneInnerAngle = 360; p.coneOuterAngle = 360;
    s.env.connect(s.gain); s.gain.connect(s.filter);
    s.sendA.gain.value = 0; s.sendB.gain.value = 0;
    s.onEnded = () => { if (s.src && s.srcEnded === s.src) release(s); };
    return s;
  }
  function route(s, twoD, bus) {
    // filter → panner|bus, filter → sendA/sendB (reconnected only when the routing changes)
    const out = twoD ? null : s.panner;
    if (s.outPanned === out && s.outBus === bus) return;
    s.filter.disconnect(); s.panner.disconnect();
    if (out) { s.filter.connect(out); out.connect(bus); } else s.filter.connect(bus);
    s.filter.connect(s.sendA); s.filter.connect(s.sendB);
    s.outPanned = out; s.outBus = bus;
  }
  function setSend(s, which, fam) {
    const key = which === 'A' ? 'famA' : 'famB', node = which === 'A' ? s.sendA : s.sendB;
    if (s[key] === fam) return;
    node.disconnect();
    const r = fam && reverbs.input(fam);
    if (r) node.connect(r);
    s[key] = fam;
  }
  function applyVolumes() {
    if (!buses) return;
    const v = E.volumes;
    for (const g of VOLUME_GROUPS) buses[g].gain.value = v[g];
    buses.radio.gain.value = v.voices * v.radio; buses.ui.gain.value = v.ui;
    mic.setMaster(v.master);
  }
  function applyTier() {
    if (!slots.length) return;
    const hrtf = E.tier === 'high' || E.tier === 'mid';
    for (const s of slots) s.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    reverbs?.setTier(E.tier); mic?.setTier(E.tier);
  }
  E.setTier = (t) => { E.tier = t; applyTier(); };
  E.setVolumes = (v) => { Object.assign(E.volumes, v); applyVolumes(); };

  /** create the AudioContext (call from a user gesture) */
  E.start = (context) => {
    if (E.ac || nullOutput) return E.ac;
    try {
      E.ac = context ?? new (globalThis.AudioContext || globalThis.webkitAudioContext)({ latencyHint: 'interactive' });
    } catch (e) { log?.(`[audio] no AudioContext: ${e}`); nullOutput = true; E.nullOutput = true; return null; }
    build();
    E.unlocked = true;
    return E.ac;
  };
  if (E.ac) build();
  E.whenReady = async () => { if (mic?.ready) await mic.ready; if (reverbs?.ready) await reverbs.ready; };

  // ---------------------------------------------------------------------------------------------------------
  // play
  const OPTS = {};
  const DEF = { pos: null, follow: null, gain: 1, pitch: 1, pitchVar: 0.02, delay: 0, offset: -1, skipLead: true, loop: false,
    prio: -1, cat: '', ref: 0, max: 0, roll: 0, send: -1, occlude: true, lp: 20000, fadeIn: 0, dur: 0, clip: -1,
    pool: null, lastRef: null, twoD: false, maxLatency: 0.15, owner: -1, rnd: null, zone: -1, fy: 0 };
  /** shared options object (reset to defaults) — fill and pass to play(); avoids per-call allocations */
  E.opts = () => Object.assign(OPTS, DEF);

  function audibility(s) { return s.base * (s.twoD ? 1 : s.ref / Math.max(s.ref, dist(s))); }
  function dist(s) { const L = E.listener; return Math.hypot(s.x - L.x, s.y - L.y, s.z - L.z); }
  function findSlot(cat, prio, aud) {
    const lim = CATS[cat]?.limit ?? 4;
    let free = null, worst = null, worstScore = 1e9, worstCat = null, worstCatScore = 1e9;
    for (const s of slots) {
      if (!s.busy) { if (!free) free = s; continue; }
      const score = s.prio * 10 + Math.min(9.99, audibility(s) * 10) - (s.stopping ? 100 : 0);
      if (score < worstScore) { worstScore = score; worst = s; }
      if (s.cat === cat && score < worstCatScore) { worstCatScore = score; worstCat = s; }
    }
    const mine = prio * 10 + Math.min(9.99, aud * 10);
    if (catCount[cat] >= lim) {
      if (worstCat && worstCatScore < mine) { E.stats.steals++; stop(worstCat, 0.02, true); return worstCat; }
      return null;
    }
    if (free) return free;
    if (worst && worstScore < mine) { E.stats.steals++; stop(worst, 0.02, true); return worst; }
    return null;
  }

  /**
   * play a sound (manifest name). Returns a handle (number > 0) or 0 if dropped. o = E.opts() filled in.
   * Positional when o.pos/o.follow is given (and the category is not 2D).
   */
  E.play = (name, o = DEF) => {
    E.stats.plays++;
    const bs = E.stats.byName; bs.set(name, (bs.get(name) ?? 0) + 1);
    onPlay?.(name, o);
    const snd = bank.resolve(name);
    if (!snd) { E.stats.drops++; return 0; }
    if (nullOutput || !E.ac || !E.ready) return nullOutput ? E._nullHandle() : 0;
    const ci = o.clip >= 0 ? o.clip : bank.pick(snd.name, o.rnd ?? Math.random, o.pool, o.lastRef);
    if (ci < 0) { E.stats.drops++; return 0; }
    const c = bank.clips[ci];
    const cat = o.cat || snd.cat, C = CATS[cat] ?? CATS.foley;
    const twoD = o.twoD || C.twoD || (!o.pos && !o.follow);
    const prio = o.prio >= 0 ? o.prio : C.prio;
    const p = o.follow ? (o.follow.pos ?? o.follow) : o.pos;
    const x = p ? p.x : E.listener.x, y = p ? p.y + o.fy : E.listener.y, z = p ? p.z : E.listener.z;
    const ref = o.ref || C.ref, max = o.max || C.max;
    const d = twoD ? 0 : Math.hypot(x - E.listener.x, y - E.listener.y, z - E.listener.z);
    if (!twoD && d > max) { E.stats.drops++; return 0; }
    const base = snd.gain * o.gain;
    const aud = base * (twoD ? 1 : ref / Math.max(ref, d));
    const s = findSlot(cat, prio, aud);
    if (!s) { E.stats.drops++; return 0; }
    // reserve the slot now; start when the buffer is ready
    claim(s, c, cat, C, prio, twoD, o, x, y, z, ref, max, base);
    const h = handleOf(s);
    if (c.buf) startSlot(s, c.buf, o.delay, o.offset, o.fadeIn, o.dur);
    else {
      const t = E.ac.currentTime, lat = o.loop ? 30 : o.maxLatency, delay = o.delay, off = o.offset, fi = o.fadeIn, du = o.dur;
      s.pending = true;
      decode(c, 1).then((buf) => {
        if (!s.busy || handleOf(s) !== h) return;
        const late = E.ac.currentTime - t;
        if (!buf || late > lat + delay) { E.stats.late++; release(s); return; }
        startSlot(s, buf, Math.max(0, delay - late), off, fi, du);
      });
    }
    return h;
  };
  let nullH = 0;
  E._nullHandle = () => (++nullH % 1e9) + 1;
  function handleOf(s) { return s.i + 1 + handleGen[s.i] * 64; }
  function slotOf(h) { if (!h) return null; const i = (h - 1) % 64, s = slots[i]; return s && s.busy && handleOf(s) === h ? s : null; }

  function claim(s, c, cat, C, prio, twoD, o, x, y, z, ref, max, base) {
    handleGen[s.i]++;
    s.busy = true; s.stopping = false; s.pending = false; s.clip = c; c.playing++;
    s.cat = cat; catCount[cat]++; s.prio = prio; s.twoD = twoD; s.loop = !!o.loop;
    s.follow = o.follow ?? null; s.fy = o.fy; s.x = x; s.y = y; s.z = z;
    s.base = base; s.ref = ref; s.max = max; s.roll = o.roll || C.roll; s.sendK = o.send >= 0 ? o.send : C.send;
    s.lpExtra = o.lp; s.occlude = o.occlude && !twoD; s.owner = o.owner;
    const r = o.pitch * (1 + (Math.random() * 2 - 1) * o.pitchVar);
    s.rate = r;
    s.zone = o.zone; s.solverV = -1; s.losTick = -1; s.obst = 0; s.obstT = 0;
    s.lastG = s.lastLP = s.lastWA = s.lastWB = -1; s.lastX = s.lastY = s.lastZ = 1e9;
    s.skipLead = o.skipLead && !o.loop && c.onset > 0.02 ? c.onset - 0.01 : 0;
    route(s, twoD, buses[C.bus] ?? buses.effects);
    // initial spatial state immediately (no glide from the previous owner of the slot)
    spatial(s, true);
    E.stats.active++; if (E.stats.active > E.stats.peakActive) E.stats.peakActive = E.stats.active;
  }
  function startSlot(s, buf, delay, offset, fadeIn, dur) {
    const a = E.ac, t = a.currentTime + (delay > 0 ? delay : 0);
    s.pending = false;
    const src = a.createBufferSource();
    src.buffer = buf; src.playbackRate.value = s.rate;
    const c = s.clip;
    if (s.loop) {
      src.loop = true; src.loopStart = c.loopStart; src.loopEnd = Math.min(buf.duration, c.loopEnd);
    }
    src.connect(s.env);
    const env = s.env.gain;
    env.cancelScheduledValues(0);
    if (fadeIn > 0) { env.setValueAtTime(0, t); env.linearRampToValueAtTime(1, t + fadeIn); } else env.setValueAtTime(1, t);
    let off = offset >= 0 ? offset : s.loop ? c.loopStart + Math.random() * (c.loopEnd - c.loopStart) : s.skipLead;
    if (off >= buf.duration) off = 0;
    src.start(t, off);
    s.t0 = t;
    s.tEnd = s.loop ? Infinity : t + (buf.duration - off) / s.rate;
    if (dur > 0) { const te = t + dur; env.setTargetAtTime(0, te, 0.05); src.stop(te + 0.3); s.tEnd = Math.min(s.tEnd, te + 0.3); }
    s.srcEnded = src;
    src.onended = s.onEnded;
    s.src = src;
  }
  function release(s) {
    if (!s.busy) return;
    s.busy = false; s.pending = false;
    catCount[s.cat]--; E.stats.active--;
    if (s.clip) s.clip.playing--;
    s.clip = null; s.follow = null;
    if (s.src) { try { s.src.onended = null; s.src.disconnect(); } catch { /* ignore */ } }
    s.src = null; s.srcEnded = null;
    s.sendA.gain.value = 0; s.sendB.gain.value = 0;
  }
  function stop(s, fade = 0.08, immediate = false) {
    if (!s.busy) return;
    const a = E.ac;
    if (!s.src || immediate && fade <= 0.03) {
      if (s.src) { try { s.env.gain.cancelScheduledValues(0); s.env.gain.setTargetAtTime(0, a.currentTime, 0.008); s.src.stop(a.currentTime + 0.05); } catch { /* not started */ } }
      release(s); return;
    }
    if (s.stopping) return;
    s.stopping = true;
    const t = a.currentTime;
    s.env.gain.cancelScheduledValues(t); s.env.gain.setValueAtTime(s.env.gain.value, t);
    s.env.gain.setTargetAtTime(0, t, fade / 3);
    try { s.src.stop(t + fade * 1.5 + 0.02); } catch { /* ignore */ }
  }
  E.stop = (h, fade = 0.08) => { const s = slotOf(h); if (s) stop(s, fade); };
  E.stopOwner = (owner, fade = 0.06, cat = '') => { for (const s of slots) if (s.busy && s.owner === owner && (!cat || s.cat === cat)) stop(s, fade); };
  E.stopAll = (fade = 0.1, keepCat = '') => { for (const s of slots) if (s.busy && s.cat !== keepCat) stop(s, fade); };
  E.isPlaying = (h) => !!slotOf(h);
  E.ownerBusy = (owner, cat) => { for (const s of slots) if (s.busy && !s.stopping && s.owner === owner && s.cat === cat) return true; return false; };
  /** gain multiplier of a running voice (for loops: machine run-up, beds), glide τ seconds */
  E.setGain = (h, g, tau = 0.3) => {
    const s = slotOf(h); if (!s || s.stopping) return;
    const t = E.ac.currentTime;
    s.env.gain.cancelScheduledValues(t); s.env.gain.setTargetAtTime(g, t, tau);
  };
  E.setRate = (h, r, tau = 0.3) => {
    const s = slotOf(h); if (!s || !s.src) return;
    s.rate = r; s.src.playbackRate.setTargetAtTime(r, E.ac.currentTime, tau);
  };
  E.setPos = (h, x, y, z) => { const s = slotOf(h); if (s) { s.x = x; s.y = y; s.z = z; } };
  E.setLP = (h, hz) => { const s = slotOf(h); if (s) s.lpExtra = hz; };
  E.setBase = (h, b) => { const s = slotOf(h); if (s) s.base = b; };

  // ---------------------------------------------------------------------------------------------------------
  // spatialisation (per active slot)
  const tmp = { x: 0, y: 0, z: 0 };
  function spatial(s, force) {
    const L = E.listener, a = E.ac, t = a.currentTime;
    if (s.follow) { const p = s.follow.pos ?? s.follow; s.x = p.x; s.y = p.y + s.fy; s.z = p.z; }
    let g = s.base, lp = s.lpExtra, wa = 0, wb = 0;
    let px = s.x, py = s.y, pz = s.z;
    const famL = L.zone >= 0 && acoustics ? ACOUSTIC[acoustics.graph.zoneClass[L.zone]] : null;
    if (s.twoD) {
      if (famL && s.sendK > 0) { wb = famL.wet * s.sendK * 0.5; setSend(s, 'B', famL.ir); }
    } else {
      const dx = s.x - L.x, dy = s.y - L.y, dz = s.z - L.z;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let loss = 0, lpOcc = 20000, fam = famL;
      if (acoustics && E.solver && s.occlude) {
        if (force || s.solverV !== E.solver.version || (frame + s.i) % 8 === 0) {
          s.zone = acoustics.zoneAt(s.x, s.y + 0.3, s.z);
          s.solverV = E.solver.version;
        }
        const zs = s.zone;
        if (zs >= 0) {
          loss = E.solver.loss[zs]; lpOcc = E.solver.lp[zs];
          fam = ACOUSTIC[acoustics.graph.zoneClass[zs]] ?? famL;
          if (loss > 2.5) {
            // through portals: louder path is the portal path; the sound appears to come from the first portal
            const pd = E.solver.dist[zs];
            const vp = E.solver.portal(zs, tmp);
            const pathD = vp ? pd + Math.hypot(s.x - vp.x, s.y - vp.y, s.z - vp.z) : d;
            if (pathD > d) d = Math.min(pathD, d * 2.5 + 4);
            const fp = E.solver.firstPortal(zs, tmp);
            if (fp && loss < 30) {
              const w = clamp((loss - 2.5) / 14, 0, 0.85);
              px = s.x + (fp.x - s.x) * w; py = s.y + (fp.y - s.y) * w; pz = s.z + (fp.z - s.z) * w;
            }
          }
        }
        s.lossT = loss;
        s.obstT = s.obst;
      }
      // smooth occlusion changes (a door opening should glide, not click)
      s.loss = force ? s.lossT : s.loss + (s.lossT - s.loss) * 0.25;
      const ob = s.obstT;
      const dg = s.ref / Math.max(s.ref, d);
      const distG = s.roll === 1 ? dg : Math.pow(dg, s.roll);
      const edge = clamp((s.max - d) / (0.2 * s.max), 0, 1);
      g *= distG * edge * Math.pow(10, -(s.loss + ob * 5) / 20);
      const air = 20000 * Math.exp(-d / 70);
      lp = Math.min(lp, lpOcc, air, ob > 0 ? 20000 - ob * 15500 : 20000);
      if (fam && s.sendK > 0) {
        // wet: falls slower than dry with distance; leaks through portals more than the dry path
        const wetD = Math.pow(dg, 0.4) * edge;
        wa = fam.wet * s.sendK * wetD * Math.pow(10, -(s.loss * 0.75) / 20);
        setSend(s, 'A', fam.ir);
        if (famL && famL.ir !== fam.ir) { wb = famL.wet * s.sendK * 0.4 * wetD * Math.pow(10, -s.loss / 20); setSend(s, 'B', famL.ir); }
        else setSend(s, 'B', '');
      }
      if (force || Math.abs(px - s.lastX) + Math.abs(py - s.lastY) + Math.abs(pz - s.lastZ) > 0.03) {
        const p = s.panner;
        if (p.positionX) {
          if (force) { p.positionX.value = px; p.positionY.value = py; p.positionZ.value = pz; }
          else { p.positionX.setTargetAtTime(px, t, 0.02); p.positionY.setTargetAtTime(py, t, 0.02); p.positionZ.setTargetAtTime(pz, t, 0.02); }
        } else p.setPosition(px, py, pz);
        s.lastX = px; s.lastY = py; s.lastZ = pz;
      }
    }
    s.aud = g;
    if (force || Math.abs(g - s.lastG) > 0.01 * Math.max(0.05, s.lastG)) {
      if (force) s.gain.gain.value = g; else s.gain.gain.setTargetAtTime(g, t, 0.04);
      s.lastG = g;
    }
    lp = clamp(lp, 200, 20000);
    if (force || Math.abs(lp - s.lastLP) > s.lastLP * 0.04) {
      if (force) s.filter.frequency.value = lp; else s.filter.frequency.setTargetAtTime(lp, t, 0.05);
      s.lastLP = lp;
    }
    if (force || Math.abs(wa - s.lastWA) > 0.005) { if (force) s.sendA.gain.value = wa; else s.sendA.gain.setTargetAtTime(wa, t, 0.05); s.lastWA = wa; }
    if (force || Math.abs(wb - s.lastWB) > 0.005) { if (force) s.sendB.gain.value = wb; else s.sendB.gain.setTargetAtTime(wb, t, 0.05); s.lastWB = wb; }
  }

  /** one obstruction ray for the slot (same-space sources hidden behind racks/props) */
  function ray(s) {
    if (!acoustics?.clear || s.twoD || !s.occlude) return;
    E.stats.rays++;
    const L = E.listener;
    tmp.x = s.x; tmp.y = s.y + 0.2; tmp.z = s.z;
    const clear = acoustics.clear(L, tmp);
    s.obst = clear ? 0 : 1;
  }

  E.setListener = (x, y, z, fx, fy, fz, zone) => {
    const L = E.listener;
    L.x = x; L.y = y; L.z = z; L.fx = fx; L.fy = fy; L.fz = fz;
    if (zone !== undefined && zone !== L.zone) { L.zone = zone; E.resolve(); }
    if (!E.ac || !E.ready) return;
    const l = E.ac.listener, t = E.ac.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.015); l.positionY.setTargetAtTime(y, t, 0.015); l.positionZ.setTargetAtTime(z, t, 0.015);
      l.forwardX.setTargetAtTime(fx, t, 0.015); l.forwardY.setTargetAtTime(fy, t, 0.015); l.forwardZ.setTargetAtTime(fz, t, 0.015);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(x, y, z); l.setOrientation(fx, fy, fz, 0, 1, 0); }
  };
  E.attachAcoustics = (acs) => {
    acoustics = acs; E.acoustics = acs;
    E.solver = acs ? createSolver(acs.graph) : null;
    E.resolve();
  };
  /** re-run the portal solver (listener zone change, door state change, glass break) */
  E.resolve = () => {
    if (!E.solver || !acoustics) return;
    const L = E.listener;
    E.solver.solve(L.zone, L.x, L.y, L.z, acoustics.doorState, acoustics.glassBroken);
  };

  E.update = () => {
    if (!E.ac || !E.ready) return;
    const t0 = performance.now();
    frame++;
    const now = E.ac.currentTime;
    let n = 0;
    // sight rays: round-robin over positional slots in the listener's space
    let rays = 0;
    for (let k = 0; k < MAX_VOICES && rays < RAYS_PER_FRAME; k++) {
      const s = slots[(rayCursor + k) % MAX_VOICES];
      if (s.busy && !s.twoD && s.occlude && s.loss < 6) { ray(s); rays++; }
      if (k === MAX_VOICES - 1 || rays === RAYS_PER_FRAME) rayCursor = (rayCursor + k + 1) % MAX_VOICES;
    }
    for (let i = 0; i < MAX_VOICES; i++) {
      const s = slots[i];
      if (!s.busy) continue;
      n++;
      if (s.pending) continue;
      if (now > s.tEnd + 0.25) { release(s); continue; }   // onended can be late in background tabs
      if (!s.twoD || s.sendK > 0) spatial(s, false);
    }
    E.stats.active = n;
    const ms = performance.now() - t0;
    E.stats.updateMs = E.stats.updateMs * 0.95 + ms * 0.05;
    if (ms > E.stats.updateMsMax) E.stats.updateMsMax = ms;
  };
  E.slots = slots;
  E.activeCount = () => { let n = 0; for (const s of slots) if (s.busy) n++; return n; };
  E.catCount = catCount;
  return E;
}
