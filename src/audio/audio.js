// Workstream E — audio: CC0 recordings heard through a chest-mounted bodycam microphone. Owner: E.
//
// ctx.audio API (CONTRACT §4):
//   play(id, opts)            non-positional (UI, own gear, radio). opts { volume, pitch, delay, loop }
//   playAt(id, pos, opts)     positional at {x,y,z}; opts { volume, pitch, delay, loop, follow (object with x,y,z /
//                             .pos to track), zone } — zone reverb, portal occlusion and distance are applied here
//   unlock()                  create/resume the AudioContext (call from a user gesture; also done on the first
//                             pointer/key gesture automatically)
//   setVolume(v)              master volume 0..1 (settings.data.volume)
// Extras (E): setCategoryVolume('weapons'|'voices'|'effects'|'ambience', v) (settings.data.audioVolumes),
//   moment(id, phase='start') staged-moment hooks (also driven by the 'moment' event), stop(handle, fade),
//   loop(id, pos, opts) → handle, stats(), engine, log (last requests, ring of 200).
// Ids: manifest sound names ('voice.scream', 'door.roller.slam', …), cues ('cue.scream_room', 'cue.radio',
//   'cue.player_shot', …) and the legacy aliases in bank.js (ALIASES: 'scream_male', 'pistol_shot', …).
import { createBank, ALIASES } from './bank.js';
import { createEngine } from './engine.js';
import { buildAcousticGraph } from './acoustics.js';
import { createVoices } from './voices.js';
import { createScheduler } from './sched.js';
import { installDesign } from './design.js';
import { installWorld } from './world-audio.js';
import { installTension } from './tension.js';

const MANIFEST = 'assets/audio/manifest.json';

export function createAudio(ctx, opt = {}) {
  const a = {
    id: 'audio', order: ctx.ORDER.audio, volume: ctx.settings.data.volume ?? 0.8, unlocked: false,
    log: [], engine: null, bank: null, ready: false, loadMs: 0, _f: 0,
  };
  const base = opt.base ?? ((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './');
  const fetchFile = opt.fetchFile ?? (async (p) => { const r = await fetch(base + 'assets/audio/' + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
  const logReq = (name, o) => { if (a.log.length >= 200) a.log.shift(); a.log.push(o?.pos || o?.follow ? ['playAt', name] : ['play', name]); opt.onPlay?.(name, o); };
  let E = null, bank = null, K = null, D = null, Wd = null, T = null, sched = null;

  // ---------------------------------------------------------------------------------------------------------
  // loading: manifest + tier-0 clips before the menu; the rest streams in by priority afterwards
  a.load = async (loader) => {
    const t0 = performance.now();
    const man = opt.manifest ?? (loader ? await loader.json(MANIFEST, 0.1) : null);
    if (!man) return;
    bank = createBank(man);
    a.bank = bank;
    const nullOutput = opt.nullOutput ?? (typeof AudioContext === 'undefined' && typeof globalThis.webkitAudioContext === 'undefined');
    E = createEngine({ bank, fetchFile, tier: ctx.quality?.tier?.id ?? 'low', nullOutput, log: (m) => console.warn(m), onPlay: logReq, ac: opt.ac ?? null });
    a.engine = E;
    if (!nullOutput) {
      // fetch everything (11.5 MB encoded, kept as ArrayBuffers), decode tiers 0/1 now, the rest on demand
      const byTier = [[], [], []];
      for (const s of bank.sounds.values()) for (const i of s.enabled) byTier[s.tier].push(bank.clips[i]);
      const done = loader?.step('Audio', 0.3);
      // (beds are decoded but not pinned: the LRU may drop them once nobody hears them)
      await Promise.all(byTier[0].map((c) => { c.pinned = !c.loop; return c.sound.rate ? E.decode(c, 0) : fetchFile(c.file).then((b) => { c.enc = b; }); }));
      done?.();
      // background: tier 1 decoded (pinned while short), tier 2 only fetched
      (async () => {
        for (const c of byTier[1]) { if (c.dur < 3.2) c.pinned = true; E.decode(c, 2); }
        for (const c of byTier[2]) E.prefetch(c.sound.name, 9);
      })();
    }
    a.loadMs = performance.now() - t0;
  };

  // ---------------------------------------------------------------------------------------------------------
  a.init = () => {
    if (!bank) return;
    const W = ctx.world;
    const gen = W?.gen;
    // acoustics: portal graph from the generated world (sight-line tests with closed doors ignored)
    let acoustics = null;
    if (gen) {
      const t0 = performance.now();
      const clear = (p, q) => W.lineOfSight(p, q);
      const graph = buildAcousticGraph(gen, clear);
      acoustics = {
        graph, clear,
        zoneAt: (x, y, z) => W.zoneAt(x, y, z),
        doorState: (i) => { const d = W.doors?.list?.[i]; return d ? (typeof d.t === 'number' ? Math.max(d.t, d.target ?? d.t) : d.state) : 'closed'; },
        glassBroken: (id) => { const g = W.glass?.list?.find((r) => r.pane?.id === id); return g ? !g.alive : false; },
      };
      a.graphMs = performance.now() - t0;
    }
    E.attachAcoustics(acoustics);
    sched = createScheduler(200);
    const ids = (ctx.layout.enemies ?? []).map((e) => e.id);
    const V = createVoices(bank, ids, {
      now: () => K.now(), opts: () => E.opts(), play: (n, o) => E.play(n, o),
      ownerBusy: (owner) => E.ownerBusy(owner, 'voice'), stopOwner: (owner) => E.stopOwner(owner, 0.05, 'voice'),
      talkers: () => E.catCount.voice ?? 0,
    });
    const zoneIndex = (id) => gen?.zoneIndex?.get(id) ?? -1;
    const zoneClasses = (gen?.zones ?? ctx.layout.zones).map((z) => z.acoustic ?? 'room_small');
    const hitOut = { hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '', box: -1, zone: -1, owner: null };
    const o3 = { x: 0, y: 0, z: 0 }, down = { x: 0, y: -1, z: 0 };
    // circuits: centroid (breaker sound) and fixtures (flicker at the nearest one)
    const circ = new Map();
    for (const f of ctx.layout.fixtures ?? []) { if (!circ.has(f.circuit)) circ.set(f.circuit, []); circ.get(f.circuit).push(f); }
    const centre = new Map([...circ].map(([id, fs]) => [id, { x: fs.reduce((s, f) => s + f.pos[0], 0) / fs.length, y: 3, z: fs.reduce((s, f) => s + f.pos[2], 0) / fs.length }]));
    const fx = { x: 0, y: 0, z: 0 };
    const enemyIdx = new Map((ctx.layout.enemies ?? []).map((e, i) => [e.id, i]));
    const findClip = (file) => bank.clips.find((c) => c.file === file)?.index ?? -1;
    const heavy = findClip('foley/switch_02.mp3');
    const thumps = bank.sounds.get('foley.bodyfall')?.enabled.filter((i) => bank.clips[i].dur < 0.45) ?? [];
    K = {
      ctx, E, bank, sched, V, L: E.listener, zoneClasses, zoneIndex, radioSeen: false,
      now: () => (E.ac ? E.ac.currentTime : ctx.time.now),
      bankGain: (name) => bank.sounds.get(name)?.gain ?? 1,
      classAt: (x, y, z) => { const zi = W?.zoneAt?.(x, y + 0.3, z) ?? -1; return zi >= 0 ? zoneClasses[zi] : 'outdoor'; },
      listenerClass: () => (E.listener.zone >= 0 ? zoneClasses[E.listener.zone] : 'outdoor'),
      circuitOfZone: (zi) => ctx.layout.zones[zi]?.circuit,
      enemyIndex: (en) => enemyIdx.get(en?.id) ?? -1,
      surfaceBelow: (x, y, z) => {
        if (!W?.worldHit) return 'concrete';
        o3.x = x; o3.y = y + 0.4; o3.z = z;
        const hit = W.worldHit(o3, down, 1.2, hitOut);
        const s = hit ? hitOut.surface : 'concrete';
        const cls = K.classAt(x, y, z);
        if (s === 'metal') return 'metal';
        if (s === 'wood' || s === 'cardboard' || s === 'plastic') return 'wood';
        if (s === 'dirt') return 'gravel';
        if (cls === 'outdoor') return 'asphalt';
        return 'concrete';
      },
      circuitCentre: (id) => centre.get(id) ?? null,
      nearestFixture: (id) => {
        const fs = circ.get(id); if (!fs) return null;
        let best = 1e9, bf = null;
        for (const f of fs) { const d = (f.pos[0] - E.listener.x) ** 2 + (f.pos[2] - E.listener.z) ** 2; if (d < best) { best = d; bf = f; } }
        fx.x = bf.pos[0]; fx.y = bf.pos[1]; fx.z = bf.pos[2]; return fx;
      },
      heavySwitch: () => heavy,
      // the real director (F) stages moment sounds itself (it exposes `tension`); the stub does not
      directorStages: () => !!ctx.director && 'tension' in ctx.director,
      // the real enemies (D) decide when they speak (d:voice), report steps (d:step) and near misses (d:nearmiss);
      // the real player/weapon (C) reports footsteps (c:footstep), casing bounces (c:casing) and reload stages
      // (c:reload). With the stubs E falls back to polling and its own timing.
      dEnemies: () => typeof ctx.enemies?.ambush === 'function',
      cPlayer: () => typeof ctx.weapon?.snapshot === 'function',
      shortThump: () => (thumps.length ? thumps[(Math.random() * thumps.length) | 0] : -1),
      reserved: (file) => findClip(file),
    };
    K.T = T = installTension(K);
    K.D = D = installDesign(K);
    K.W = Wd = installWorld(K);
    K.cue = cue; K.radio = radio;
    a.K = K;
    wire();
    // first user gesture anywhere unlocks audio (the menu can already breathe)
    if (typeof window !== 'undefined') {
      const g = () => { a.unlock(); };
      window.addEventListener('pointerdown', g, { capture: true });
      window.addEventListener('keydown', g, { capture: true });
      document.addEventListener('visibilitychange', () => {
        if (!E.ac) return;
        if (document.hidden) E.ac.suspend().catch(() => {});
        else if (a.unlocked) E.ac.resume().catch(() => {});
      });
    }
    applySettings();
    a.ready = true;
  };

  function applySettings() {
    const s = ctx.settings.data;
    const v = s.audioVolumes ?? {};
    E?.setVolumes({ master: s.volume ?? 0.8, weapons: v.weapons ?? 1, voices: v.voices ?? 1, effects: v.effects ?? 1, ambience: v.ambience ?? 1 });
  }

  // ---------------------------------------------------------------------------------------------------------
  // cues: multi-layer sounds callable by id
  function cue(id, pos, opts) {
    const at = pos ?? null;
    switch (id) {
      case 'cue.player_shot': ctx.events.emit('weapon:fire', { ammo: ctx.weapon?.ammo ?? 0 }); return 1;
      case 'cue.enemy_shot': return D.playAt('weapon.pistol.shot', at?.x ?? 0, at?.y ?? 1.5, at?.z ?? 0, 1);
      case 'cue.glass': return D.playAt('glass.shatter', at?.x ?? 0, at?.y ?? 1.5, at?.z ?? 0, 1);
      case 'cue.player_reload': ctx.events.emit('weapon:reload', ctx.weapon ?? {}); return 1;
      case 'cue.radio': radio(opts?.text ?? '', opts?.sound ?? null); return 1;
      case 'cue.scream_room': {
        // m08: a man is beaten behind the locked cash-room door — scream, blows, the beaten man's own
        // recorded take (reserved oldedgar lines), a body falls, silence
        const p = at ?? { x: 4.5, y: 5.4, z: 5 };
        const x = p.x, y = p.y, z = p.z;
        const o = E.opts(); o.pos = p; o.gain = 1; o.cat = 'voice'; o.prio = 9; o.max = 120;
        E.play('voice.scream', o);
        const hits = [0.7, 1.15, 1.5, 2.4, 2.75];
        for (const t of hits) D.later(t, 'impact.flesh', x, y - 0.3, z, 0.9, 0.85);
        const beaten = ['voice/pain_23.mp3', 'voice/pain_24.mp3', 'voice/pain_25.mp3', 'voice/pain_26.mp3', 'voice/dying_08.mp3'];
        [1.3, 2.0, 2.9, 3.4, 4.6].forEach((t, i) => {
          const ci = K.reserved(beaten[i]);
          sched.at(K.now() + t, (it) => { const q = E.opts(); at3.x = it.x; at3.y = it.y; at3.z = it.z; q.pos = at3; q.gain = 0.95; q.clip = it.b; q.cat = 'voice'; q.prio = 9; E.play(it.s, q); }, i < 4 ? 'voice.pain' : 'voice.dying', x, y, z, null, ci);
        });
        D.later(3.9, 'foley.bodyfall', x, y - 1, z, 1);
        D.later(4.3, 'door.kick', 8.9, 5.4, 7.5, 0.6, 0.9);   // someone slams into the door
        return 1;
      }
      default: return 0;
    }
  }
  const at3 = { x: 0, y: 0, z: 0 };

  // shoulder radio: squelch, the line, squelch tail. Sparse: only on director 'radio' events / mission beats.
  const RADIO_MATCH = [
    [/best[aä]tig|verstanden|roger|okay|ok\b|copy/i, "Roger that."], [/warte|stand ?by|moment/i, 'Stand by.'],
    [/bewegung|movement/i, 'Movement right there.'], [/verwund|verletzt|wounded/i, "He's wounded."],
    [/gesichert|clear|nichts|keine/i, 'Not seeing any.'], [/waffe|weapon/i, 'Drop the weapon.'],
  ];
  let lastRadio = -10;
  function radio(text, sound) {
    const now = K.now();
    if (now - lastRadio < 1.2) return 0;
    lastRadio = now;
    const sRadio = bank.sounds.get('voice.radio');
    let ci = -1;
    if (sound && sound !== 'voice.radio' && bank.has(sound)) { const o = E.opts(); o.twoD = true; o.cat = 'radio'; E.play(sound, o); }
    else {
      const m = RADIO_MATCH.find(([re]) => re.test(text ?? ''));
      if (m) ci = sRadio?.enabled.find((i) => bank.clips[i].text === m[1]) ?? -1;
      if (ci < 0) {
        const acks = ["Roger that.", 'Stand by.', 'Wait for movement.', 'Not seeing any.'];
        const pool = sRadio?.enabled.filter((i) => acks.includes(bank.clips[i].text)) ?? [];
        ci = pool.length ? pool[(Math.random() * pool.length) | 0] : -1;
      }
    }
    const len = ci >= 0 ? bank.clips[ci].dur : 1.0;
    const sq = (delay, g) => { const o = E.opts(); o.twoD = true; o.cat = 'radio'; o.gain = g; o.delay = delay; o.dur = 0.11; o.offset = Math.random() * 8; o.pitchVar = 0; E.play('loop.static', o); };
    sq(0, 0.3);
    if (ci >= 0) { const o = E.opts(); o.twoD = true; o.cat = 'radio'; o.clip = ci; o.delay = 0.12; o.gain = 0.9; E.play('voice.radio', o); }
    sq(0.14 + len, 0.22);
    return 1;
  }

  // ---------------------------------------------------------------------------------------------------------
  // event wiring (design.js wires the combat/world events itself)
  function wire() {
    const ev = ctx.events;
    ev.on('state', ({ to }) => {
      if (!E.mic) return;
      if (to === 'paused') { E.mic.muffle(650); E.setVolumes({ master: (ctx.settings.data.volume ?? 0.8) * 0.5 }); }
      else if (to === 'dead') { E.mic.muffle(500); }
      else if (to === 'done') { E.mic.muffle(1200); E.setVolumes({ master: (ctx.settings.data.volume ?? 0.8) * 0.6 }); }
      else { E.mic.muffle(20000); applySettings(); }
    });
    ev.on('quality:change', (t) => E.setTier(t?.id ?? 'low'));
    ev.on('mission:restart', () => a.reset());
    ev.on('radio', (r) => { K.radioSeen = true; radio(r?.text ?? '', r?.sound ?? null); });
    const fired = new Set();
    ev.on('moment', (m) => { if (!m?.id || fired.has(m.id)) return; fired.add(m.id); T.moment(m.id, 'start', false, m.variant); });
    ev.on('f:tension', (e) => a.setTension(e?.level ?? 0));
    ev.on('f:alarm', (e) => { if (e?.on) T.swell(0.8, 10); });
    ev.on('f:breach', () => { T.swell(0.7, 6); T.danger(0.2); });
    // fallback when no director stages the moment: the trigger itself starts the audio part
    ev.on('trigger:enter', (t) => {
      if (!t?.id || !t.first) return;
      const id = t.id;
      sched.at(K.now() + 0.05, () => { if (!fired.has(id)) { fired.add(id); T.moment(id, 'start', true); } });
    });
    ev.on('machine:state', (e) => Wd.machineState(e));
    a._fired = fired;
  }

  // ---------------------------------------------------------------------------------------------------------
  a.unlock = () => {
    if (!E) return;
    if (!E.ac) E.start();
    if (E.ac && E.ac.state !== 'running' && !(typeof document !== 'undefined' && document.hidden)) E.ac.resume().catch(() => {});
    a.unlocked = !!E.ac;
    if (E.ac) E.setTier(ctx.quality?.tier?.id ?? 'low');
    applySettings();
  };
  a.setVolume = (v) => { a.volume = v; ctx.settings.data.volume = v; ctx.settings.save(); applySettings(); };
  a.setCategoryVolume = (cat, v) => { const s = ctx.settings.data; s.audioVolumes = { ...(s.audioVolumes ?? {}), [cat]: v }; ctx.settings.save(); applySettings(); };
  // virtual ids the director asks for (no dedicated recording): rendered from library sounds
  // loop.radio: NO CC0 music sourced — a talk-radio programme (muffled talk) through a small-speaker band
  // loop.tv:    TV show (muffled talk + laughter) through a small-speaker band
  const VIRTUAL = {
    'loop.radio': { name: 'voice.muffled.talk', lp: 3000, gain: 0.85, cat: 'murmur' },
    'loop.tv': { name: 'voice.muffled.laugh', lp: 2600, gain: 0.8, cat: 'murmur' },
  };
  const resolveId = (id) => ALIASES[id] ?? id;
  a.has = (id) => { const n = resolveId(id); return !!(VIRTUAL[n] || n.startsWith('cue.') || bank?.resolve(n)); };
  function mapOpts(o, opts) {
    if (!opts) return o;
    if (opts.volume !== undefined) o.gain = opts.volume;
    if (opts.pitch !== undefined) o.pitch = opts.pitch;
    if (opts.delay !== undefined) o.delay = opts.delay;
    if (opts.loop !== undefined) o.loop = !!opts.loop;
    if (opts.follow) o.follow = opts.follow;
    if (opts.dur !== undefined) o.dur = opts.dur;
    if (opts.lp !== undefined) o.lp = opts.lp;
    if (opts.muffled) { o.lp = Math.min(o.lp, 900); o.gain *= 0.8; }
    if (opts.cat) o.cat = opts.cat;
    return o;
  }
  // handles for callers: { h, stop(fade) }. Loops get their own object (kept for long); one-shots share a ring.
  const ring = Array.from({ length: 32 }, () => mkHandle());
  let ringI = 0;
  function mkHandle() { const hd = { h: 0, stop(f = 0.1) { if (hd.h) E?.stop(hd.h, f); hd.h = 0; }, get playing() { return !!E?.isPlaying(hd.h); } }; return hd; }
  function wrap(h, loop) { if (!h) return null; const hd = loop ? mkHandle() : ring[(ringI = (ringI + 1) % ring.length)]; hd.h = h; return hd; }
  function playVirtual(n, pos, opts) {
    const v = VIRTUAL[n] ?? null;
    const o = mapOpts(E.opts(), opts);
    if (v) { o.lp = Math.min(o.lp, v.lp); o.gain *= v.gain; o.cat = v.cat; }
    if (pos) o.pos = pos; else { o.twoD = true; if (!opts?.cat) o.cat = v ? v.cat : 'ui'; }
    return wrap(E.play(v ? v.name : n, o), o.loop);
  }
  a.play = (id, opts) => {
    if (!E) return null;
    const n = resolveId(id);
    if (n.startsWith('cue.')) return cue(n, null, opts);
    return playVirtual(n, null, opts);
  };
  a.playAt = (id, pos, opts) => {
    if (!E) return null;
    const n = resolveId(id);
    if (n.startsWith('cue.')) return cue(n, pos, opts);
    return playVirtual(n, pos, opts);
  };
  /** director pacing: 0..1 (also the 'f:tension' event) */
  a.setTension = (v) => { if (T) T.external = Math.max(0, Math.min(1, +v || 0)); };
  /** settings panel: 'sfx' (Effekte) | 'voice' (Stimmen) | or a group name of setCategoryVolume */
  a.setBusVolume = (bus, v) => {
    if (bus === 'sfx') { const s = ctx.settings.data; s.audioVolumes = { ...(s.audioVolumes ?? {}), weapons: v, effects: v, ambience: v }; ctx.settings.save(); applySettings(); }
    else if (bus === 'voice' || bus === 'voices') a.setCategoryVolume('voices', v);
    else a.setCategoryVolume(bus, v);
  };
  a.loop = (id, pos, opts) => a.playAt(id, pos, { ...opts, loop: true });
  a.stop = (h, fade = 0.1) => { if (h && typeof h === 'object') h.stop(fade); else E?.stop(h, fade); };
  a.moment = (id, phase = 'start', full = false) => { if (phase === 'start') a._fired?.add(id); return T?.moment(id, phase, full) ?? false; };
  a.cue = (id, pos, opts) => cue(id, pos, opts);
  a.stats = () => {
    const s = E?.stats ?? {};
    return { active: E?.activeCount?.() ?? 0, peakActive: s.peakActive, plays: s.plays, drops: s.drops, steals: s.steals, late: s.late,
      decodedMB: +(E?.decodedMB?.() ?? 0).toFixed(1), peakDecodedMB: +((s.peakDecodedBytes ?? 0) / 1048576).toFixed(1), decodes: s.decodes,
      evictions: s.evictions, updateMs: +(s.updateMs ?? 0).toFixed(3), updateMsMax: +(s.updateMsMax ?? 0).toFixed(3), rays: s.rays,
      tier: E?.tier, reverb: E?.reverbs?.mode, convolvers: E?.reverbs?.convolverCount?.(), agcWorklet: !!E?.mic?.usingWorklet,
      state: E?.ac?.state ?? "none", sampleRate: E?.ac?.sampleRate, frameMs: +(a.frameMs ?? 0).toFixed(3),
      topDrops: [...(s.dropBy ?? [])].sort((x, y) => y[1] - x[1]).slice(0, 8) };
  };

  // ---------------------------------------------------------------------------------------------------------
  let frameAvg = 0;
  a.update = (dt) => {
    if (!E || !K) return;
    const t0 = performance.now();
    const p = ctx.player, cam = ctx.render?.camera;
    if (p?.eye && p.forward) {
      const zi = ctx.world?.zoneAt?.(p.eye.x, p.eye.y, p.eye.z) ?? -1;
      E.setListener(p.eye.x, p.eye.y, p.eye.z, p.forward.x, p.forward.y, p.forward.z, zi);
    } else if (cam) E.setListener(cam.position.x, cam.position.y, cam.position.z, 0, 0, -1, -1);
    sched.run(K.now());
    if (++a._f % 20 === 0) E.resolve();      // doors in motion / broken glass: portal losses glide
    D.update(dt);
    Wd.update(dt);
    T.update(dt);
    E.update();
    const ms = performance.now() - t0;
    frameAvg = frameAvg * 0.97 + ms * 0.03;
    a.frameMs = frameAvg;
    if (ms > (a.frameMsMax ?? 0)) a.frameMsMax = ms;
  };
  a.reset = () => {
    if (!E) return;
    E.stopAll(0.15);
    sched?.clear();
    K?.V?.reset(); D?.reset(); Wd?.reset(); T?.reset();
    a._fired?.clear();
    if (K) K.radioSeen = false;
  };
  return a;
}
