// Workstream E tests (Node, run by `npm test`): library integrity, bank picking, decoded-memory budget, voice
// consistency, AGC curve, portal acoustics, and the full sound design driven through a mock ctx in null-output
// mode: every contract event produces sound, every manifest entry is reachable, the main-thread logic cost of a
// firefight with 8 enemies. The real Web Audio graph is rendered by the browser harness
// (scripts/audio/harness.html via `node scripts/audio/run-harness.mjs`).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createBank, decodeRate } from '../src/audio/bank.js';
import { AgcCore } from '../src/audio/agc.js';
import { buildAcousticGraph, createSolver } from '../src/audio/acoustics.js';
import { buildProfiles, RESERVED } from '../src/audio/voices.js';
import { createAudio } from '../src/audio/audio.js';
import { createEvents } from '../src/core/events.js';
import { F_OCC } from '../src/world/gen.js';

export default async function ({ W, bvh, LAYOUT, ok, warn }) {
  const t0 = performance.now();
  const man = JSON.parse(readFileSync('public/assets/audio/manifest.json', 'utf8'));
  const credits = readFileSync('CREDITS-AUDIO.md', 'utf8');

  // ---- library
  let bytes = 0, files = 0, disabled = 0;
  for (const [name, s] of Object.entries(man.sounds)) {
    for (const v of s.variations) {
      files++;
      const p = `public/assets/audio/${v.file}`;
      if (!ok(existsSync(p), `audio file missing: ${p}`)) continue;
      bytes += statSync(p).size;
      ok(man._credits[v.source?.split('#')[0]], `${v.file}: source ${v.source} not in manifest credits`);
      ok(credits.includes(v.file), `${v.file} not listed in CREDITS-AUDIO.md`);
      if (v.disabled) disabled++;
      if (v.loop) ok(v.loopStart >= 0.2 && v.loopEnd > v.loopStart + 1 && v.loopEnd <= v.duration + 0.3, `${v.file}: bad loop points ${v.loopStart}..${v.loopEnd}`);
      ok(typeof v.onset === 'number' && typeof v.peakAt === 'number', `${v.file}: no QC markers (run node scripts/audio/qc.mjs)`);
    }
    ok(s.variations.some((v) => !v.disabled), `${name}: every variation disabled`);
  }
  ok(bytes <= 20 * 1048576, `audio library ${(bytes / 1048576).toFixed(1)} MB > 20 MB hard cap`);
  for (const lic of Object.values(man._credits)) ok(/CC0|Public Domain|publicdomain/i.test(lic.licence ?? ''), `non-CC0 source in credits: ${lic.url}`);
  console.log(`  library: ${files} files, ${(bytes / 1048576).toFixed(2)} MB, ${disabled} disabled`);

  // ---- bank: no back-to-back repeats, disabled never picked
  const bank = createBank(man);
  let seq = 1;
  const rnd = () => { seq = (seq * 16807) % 2147483647; return seq / 2147483647; };
  for (const s of bank.sounds.values()) {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      const c = bank.pick(s.name, rnd);
      if (s.enabled.length > 1) ok(c !== last, `${s.name}: variation repeated back-to-back`);
      ok(!bank.clips[c]?.disabled, `${s.name}: picked a disabled variation`);
      last = c;
    }
  }
  // ---- decoded memory: everything vs. what stays resident
  const all = bank.totalDecodedBytes(48000) / 1048576;
  let pinned = 0;
  for (const s of bank.sounds.values()) for (const i of s.enabled) { const c = bank.clips[i]; if (s.name.startsWith('ir.')) continue; if ((s.tier === 0 && !c.loop) || (s.tier === 1 && c.dur < 3.2)) pinned += bank.decodedBytes(c, 48000); }
  pinned /= 1048576;
  const at48 = bank.clips.reduce((b, c) => b + (c.loop ? c.loopEnd + 0.25 : c.dur) * 48000 * c.ch * 4, 0) / 1048576;
  console.log(`  decoded PCM: all clips ${all.toFixed(0)} MB at the per-category rates (${at48.toFixed(0)} MB at 48 kHz), resident (tiers 0/1 short) ${pinned.toFixed(1)} MB, LRU budget 52 MB`);
  ok(pinned < 40, `resident decoded set ${pinned.toFixed(1)} MB leaves too little room under 60 MB`);
  ok(decodeRate('ir.hall') === 0 && decodeRate('voice.pain') <= 24000, 'decode rates');

  // ---- voices: one author per category per enemy, neighbours differ, reserved lines excluded
  const ids = LAYOUT.enemies.map((e) => e.id);
  const prof = buildProfiles(bank, ids);
  for (const p of prof) {
    ok(Math.abs(p.pitch - 1) <= 0.041, `${p.id}: pitch offset ${p.pitch}`);
    for (const [cat, pool] of Object.entries(p.pools)) {
      const authors = new Set(pool.map((i) => bank.clips[i].author));
      ok(authors.size <= 1, `${p.id} ${cat}: ${authors.size} speakers in one voice`);
      ok(!pool.some((i) => RESERVED.has(bank.clips[i].file)), `${p.id} ${cat}: reserved staged line in the pool`);
    }
  }
  let same = 0;
  for (let i = 1; i < prof.length; i++) if (prof[i].authors.pain === prof[i - 1].authors.pain) same++;
  ok(same <= 3, `${same} neighbouring enemies share a pain voice`);
  console.log(`  voices: ${prof.length} profiles, pain authors ${new Set(prof.map((p) => p.authors.pain)).size}, death authors ${new Set(prof.map((p) => p.authors.death)).size}, neighbours sharing pain voice ${same}`);

  // ---- AGC: room tone, a close shot at 1.0 s; duck depth, recovery, output bounds
  {
    const sr = 48000, n = sr * 4, x = new Float32Array(n);
    let s = 7;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 * 2 - 1; };
    for (let i = 0; i < n; i++) x[i] = r() * 0.012;            // ≈ -41 dBFS room tone
    for (let i = 0; i < sr * 0.3; i++) x[sr + i] += r() * 1.8 * Math.exp(-i / (sr * 0.05));   // shot, +5 dBFS peak
    const agc = new AgcCore(sr), out = new Float32Array(n), g = new Float32Array(n);
    for (let i = 0; i < n; i += 128) agc.process(x.subarray(i, i + 128), null, out.subarray(i, i + 128), null, g.subarray(i, i + 128), 128);
    const db = (v) => 20 * Math.log10(v);
    const pre = db(g[sr - 10]), duck = db(Math.min(...g.subarray(sr, sr + 0.01 * sr)));
    const at = (t) => db(g[Math.round((1 + t) * sr)]);
    let maxOut = 0, nan = 0; for (const v of out) { if (!Number.isFinite(v)) nan++; maxOut = Math.max(maxOut, Math.abs(v)); }
    const curve = [0.05, 0.25, 0.5, 1.0, 1.5, 2.0, 2.5].map((t) => `${t}s ${at(t).toFixed(1)}`).join(', ');
    console.log(`  AGC: before ${pre.toFixed(1)} dB, duck within 10 ms ${duck.toFixed(1)} dB, recovery ${curve}; out max ${maxOut.toFixed(3)}`);
    ok(duck < pre - 12, `AGC does not duck hard on a shot (${duck.toFixed(1)} dB)`);
    ok(at(0.5) < pre - 3, 'AGC recovers too fast (should pump over ~1-2 s)');
    ok(at(2.5) > pre - 1.5, `AGC has not recovered 2.5 s after the shot (${at(2.5).toFixed(1)} dB)`);
    ok(maxOut <= 0.97 && nan === 0, `AGC output out of bounds (${maxOut}, NaN ${nan})`);
  }

  // ---- acoustic portal graph
  const clear = (a, b) => !bvh.occluded(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, 1, F_OCC);
  const G = buildAcousticGraph(W, clear);
  const zi = (id) => W.zoneIndex.get(id);
  for (const [i, d] of W.doors.entries()) if ((d.zones ?? []).length === 2) ok(G.edges.some((e) => e.door === i), `door ${d.id} is not an acoustic portal`);
  const S = createSolver(G);
  const doorStates = W.doors.map((d) => d.state);
  S.solve(zi('hof'), 45, 1.5, 100, (i) => doorStates[i], () => false);
  const lossWE = S.loss[zi('wareneingang')], lossTech = S.loss[zi('technik')];
  ok(lossWE < 6, `goods-in should be open to the yard through Tor 2 (loss ${lossWE.toFixed(1)} dB)`);
  ok(lossTech > 18, `technical room behind a closed door should be muffled (loss ${lossTech.toFixed(1)} dB)`);
  W.doors.forEach((d, i) => { if (d.kind === 'roller') doorStates[i] = 'closed'; });
  S.solve(zi('hof'), 45, 1.5, 100, (i) => doorStates[i], () => false);
  ok(S.loss[zi('wareneingang')] > lossWE + 8, 'closing the dock doors does not muffle goods-in');
  S.solve(zi('geld'), 4.5, 5.5, 4.5, (i) => (W.doors[i].id === 'd_geld' ? 'locked' : 'open'), () => false);
  ok(S.loss[zi('flur_og')] > 15 && S.lp[zi('flur_og')] < 1000, 'locked cash-room door must muffle the scream');
  console.log(`  acoustics: ${G.edges.length} portals; yard→goods-in ${lossWE.toFixed(1)} dB, yard→technik ${lossTech.toFixed(1)} dB`);

  // ---- full design in null-output mode through a mock ctx
  const events = createEvents();
  const played = new Map();
  let playCount = 0;
  const onPlay = (name) => { playCount++; played.set(name, (played.get(name) ?? 0) + 1); };
  const zl = W.zoneLookup;
  const doorsList = W.doors.map((d, i) => ({ ...d, index: i, t: d.state === 'open' ? 1 : d.state === 'half' ? 0.3 : 0, target: d.state === 'open' ? 1 : 0, speed: d.kind === 'roller' ? 0.8 : 1.6 }));
  const glassList = W.glass.map((g) => ({ pane: g, alive: true }));
  const hitP = { x: 0, y: 0, z: 0 };
  let groundSurf = 'concrete';
  const world = {
    gen: W, zones: W.zones,
    zoneAt: (x, y, z) => zl.at(x, y, z),
    lineOfSight: (a, b) => clear(a, b),
    worldHit: (o, d, max, out) => { out.hit = true; out.t = 0.4; out.surface = groundSurf; out.point = hitP; return true; },
    doors: { list: doorsList, get: (id) => doorsList.find((d) => d.id === id) },
    glass: { list: glassList },
    lights: { level: () => 1 },
  };
  const V3 = (x, y, z) => ({ x, y, z });
  const player = { pos: V3(45, 0, 100), eye: V3(45, 1.5, 100), forward: V3(0, 0, -1), yaw: 0, moving: 0, crouched: false, health: 100 };
  const enemies = { list: LAYOUT.enemies.map((def) => ({ id: def.id, def, pos: V3(...def.pos), health: 100, dead: false, alerted: false })) };
  const mk = (list, kind) => list.map((x) => ({ ...x, kind, group: { position: V3(x.base?.[0] ?? x.x ?? 0, 0, x.base?.[2] ?? x.z0 ?? 0) }, arm: { rotation: { y: 0 } }, car: { position: { y: 3 } } }));
  const machines = { agvs: mk(LAYOUT.agvs, 'agv'), conveyors: LAYOUT.conveyors.map((c) => ({ ...c })), robots: mk(LAYOUT.robots, 'robot'), cranes: mk(LAYOUT.cranes, 'crane') };
  machines.agv = (id) => machines.agvs.find((a) => a.id === id); machines.conveyor = (id) => machines.conveyors.find((a) => a.id === id);
  machines.robot = (id) => machines.robots.find((a) => a.id === id); machines.crane = (id) => machines.cranes.find((a) => a.id === id);
  const ctx = {
    layout: LAYOUT, events, ORDER: { audio: 80 }, time: { now: 0, dt: 1 / 60, frame: 0 }, state: 'playing',
    settings: { data: { volume: 0.8 }, save() {} }, quality: { tier: { id: 'low' } },
    world, player, enemies, machines, weapon: { ammo: 10, reloading: 1.8 }, render: null,
  };
  const audio = createAudio(ctx, { manifest: man, nullOutput: true, onPlay });
  await audio.load(null);
  audio.init();
  const step = (sec, fn) => { for (let t = 0; t < sec; t += 1 / 60) { ctx.time.now += 1 / 60; fn?.(t); audio.update(1 / 60); } };
  step(0.5);
  const fire = (shooter, origin, dir, extra = {}) => ({ hit: true, t: 12, point: V3(origin.x + dir.x * 12, origin.y, origin.z + dir.z * 12), normal: V3(0, 0, 1), surface: 'concrete', kind: 'static', id: '', target: null, part: '', damage: 9, shooter, origin, dir, glassBroken: false, ...extra });
  const en0 = enemies.list[1];
  const door = doorsList.find((d) => d.id === 'd_pack_halle'), rdoor = doorsList.find((d) => d.id === 'd_dock2');
  // event → payload (contract §7). Non-sound events are listed with a reason.
  const SOUND_EVENTS = {
    'weapon:fire': () => ({ ammo: 9 }),
    'weapon:reload': () => ctx.weapon, 'weapon:reloaded': () => ctx.weapon, 'weapon:empty': () => ctx.weapon,
    'enemy:fire': () => ({ id: en0.id, enemy: en0 }),
    shot: () => fire(en0, V3(45, 1.5, 104), V3(0, 0, -1)),
    hit: () => fire(player, V3(45, 1.5, 100), V3(0, 0, -1), { target: en0, part: 'torso', surface: 'flesh' }),
    'enemy:alert': () => ({ id: enemies.list[2].id, enemy: enemies.list[2] }),
    'enemy:damage': () => ({ id: en0.id, enemy: en0, amount: 30, part: 'torso' }),
    'enemy:death': () => { const e = enemies.list[3]; e.dead = true; return { id: e.id, enemy: e, part: 'torso' }; },
    'player:damage': () => ({ amount: 12, part: 'torso', health: 80, from: V3(45, 1.5, 90) }),
    'player:death': () => ({}),
    'player:flashlight': () => ({ on: true }),
    'door:state': () => { door.state = 'open'; door.target = 1; return { id: door.id, state: 'open', door }; },
    'door:locked': () => ({ id: 'd_geld', door: doorsList.find((d) => d.id === 'd_geld') }),
    'glass:break': () => ({ id: 'g16', point: V3(40, 2, 64), pane: W.glass[16] }),
    'lights:circuit': () => ({ id: 'halle', level: 0, fade: 1.5 }),
    'machine:state': () => { machines.conveyor('c_loop').state = 'running'; return { id: 'c_loop', kind: 'conveyor', state: 'running' }; },
    radio: () => ({ speaker: 'Zentrale', text: 'Zentrale bestätigt, Verstärkung in 20 Minuten.' }),
    moment: () => ({ id: 'm08_schrei', def: LAYOUT.moments.find((m) => m.id === 'm08_schrei') }),
    'trigger:enter': () => ({ id: 'm03_packerei', def: LAYOUT.moments.find((m) => m.id === 'm03_packerei'), first: true }),
  };
  const NON_SOUND = { state: 'mix state only (muffle/volume)', 'load:progress': 'loading UI', 'quality:change': 'panning/reverb mode', 'mission:restart': 'resets the mix', 'trigger:exit': 'no sound by design' };
  const silent = [];
  for (const [evName, payload] of Object.entries(SOUND_EVENTS)) {
    const before = playCount;
    if (evName === 'machine:state') { player.eye.x = 77; player.eye.y = 1.5; player.eye.z = 30; }
    events.emit(evName, payload());
    step(evName === 'machine:state' || evName === 'enemy:death' || evName === 'moment' ? 6 : 0.6);
    if (evName === 'machine:state') { player.eye.x = 45; player.eye.y = 1.5; player.eye.z = 100; }
    if (playCount === before) silent.push(evName);
  }
  ok(!silent.length, `contract events without sound: ${silent.join(', ')}`);
  for (const k of Object.keys(NON_SOUND)) events.emit(k, k === 'state' ? { from: 'playing', to: 'paused' } : k === 'quality:change' ? { id: 'high' } : {});
  ctx.state = 'playing';
  // scripted tour to reach the long tail of the library: every staged moment, machines running near the
  // listener, sleepers, unaware guards, slide/roller/metal doors, all impact surfaces, all weapons, bursts
  audio.reset();
  for (const m of [...LAYOUT.moments.map((x) => x.id), 'extract']) { audio.moment(m); step(0.4); }
  const visit = (x, y, z, sec = 2) => { player.eye.x = x; player.eye.y = y; player.eye.z = z; player.pos.x = x; player.pos.y = y - 1.5; player.pos.z = z; step(sec); };
  machines.agvs.forEach((a) => { a.state = 'running'; }); machines.robots.forEach((r) => { r.state = 'running'; }); machines.cranes.forEach((c) => { c.state = 'running'; });
  machines.conveyors.forEach((c) => { c.state = 'running'; });
  const agv = machines.agvs[1]; agv.group.position.x = 60; agv.group.position.z = 58;
  visit(60, 1.5, 58.5, 1);
  const rob = machines.robots[0];
  for (let t = 0; t < 4; t += 1 / 60) { rob.arm.rotation.y = Math.sin(t * 2.5) * 1.6; ctx.time.now += 1 / 60; player.eye.x = 89; player.eye.z = 44; audio.update(1 / 60); }
  const cr = machines.cranes[0];
  for (let t = 0; t < 2; t += 1 / 60) { cr.group.position.x = 89.7; cr.group.position.z = 10 + t * 2.5; player.eye.x = 89; player.eye.z = 12; ctx.time.now += 1 / 60; audio.update(1 / 60); }
  for (const id of ['d_notausgang', 'd_kuehl', 'd_dock2', 'd_dock5']) {
    const d = doorsList.find((x) => x.id === id); doorsList.forEach(() => {});
    visit(d.axis === 'x' ? (d.a + d.b) / 2 : d.at + 1, 1.5, d.axis === 'x' ? d.at + 1 : (d.a + d.b) / 2, 0.1);
    for (const st of id === 'd_dock5' ? ['half', 'open', 'closed'] : ['open', 'closed']) { d.state = st; d.target = st === 'open' ? 1 : st === 'half' ? 0.3 : 0; events.emit('door:state', { id, state: st, door: d }); step(0.3); }
  }
  { const d = doorsList.find((x) => x.id === 'd_geld'); visit(10, 6, 7.5, 0.1); d.state = 'open'; events.emit('door:state', { id: 'd_geld', state: 'open', door: d }); step(0.3); d.speed = 4; d.state = 'closed'; events.emit('door:state', { id: 'd_geld', state: 'closed', door: d }); step(0.3); }
  visit(12, 1.5, 32, 2);                 // packing area (radio stopped by m03 → reset re-enables)
  audio.reset(); visit(12, 1.5, 32, 3); visit(18, 1.5, 8, 4); visit(6, 1.5, 5, 3); visit(4, 6, 12, 4); visit(4.5, 6, 9.5, 3);
  visit(10, -2.2, 46, 4); visit(14, 1.5, 76, 4); visit(90, 1.5, 57, 3); visit(14, 1.5, 59, 4);
  for (const [i, f] of LAYOUT.fixtures.entries()) if (f.type === 'tube' && i % 4 === 0) { visit(f.pos[0], f.pos[1] - 0.5, f.pos[2], 0.3); break; }
  // unaware guards cough eventually; sleepers snore
  visit(18, 1.5, 9, 2);
  for (let i = 0; i < 4; i++) visit(enemies.list[i * 3].pos.x, 1.5, enemies.list[i * 3].pos.z + 3, 15);
  // weapons (all), bursts, impacts on every surface, whizz
  visit(45, 1.5, 100, 0.2);
  const shooters = ['pistol', 'smg', 'rifle', 'shotgun'].map((w) => enemies.list.find((e) => e.def.weapon === w));
  for (const [k, e] of shooters.entries()) {
    e.dead = false; e.pos.x = 45 + k; e.pos.y = 0; e.pos.z = 92;
    for (let r = 0; r < 40; r++) { events.emit('enemy:fire', { id: e.id, enemy: e }); step(e.def.weapon === 'smg' || e.def.weapon === 'rifle' ? (r % 10 < 7 ? 0.1 : 0.5) : 0.35); }
    e.pos.z = 30; events.emit('enemy:fire', { id: e.id, enemy: e }); step(0.2);           // far → distant recordings
  }
  for (const surf of ['concrete', 'metal', 'wood', 'cardboard', 'plastic', 'glass', 'dirt', 'tile', 'rubber', 'flesh', 'plaster', 'fabric']) {
    for (let r = 0; r < 6; r++) { events.emit('shot', fire(player, V3(45, 1.5, 100), V3(0, 0, -1), { surface: surf, kind: r % 2 ? 'door' : 'static' })); step(0.15); }
  }
  for (let r = 0; r < 4; r++) { events.emit('shot', fire(en0, V3(45.5, 1.5, 110), V3(0, 0, -1), { hit: false, t: 60 })); step(0.3); }
  // damage on enemies (legs, big hits, low health), deaths, dying, plead
  for (const [k, e] of enemies.list.slice(4, 14).entries()) {
    e.dead = false; e.pos.x = 45 + k; e.pos.z = 95; e.health = 30;
    events.emit('enemy:damage', { id: e.id, enemy: e, amount: k % 2 ? 60 : 20, part: k % 3 === 0 ? 'legs' : 'torso' });
    step(0.8);
    if (k % 2) { e.dead = true; events.emit('enemy:death', { id: e.id, enemy: e, part: k % 4 === 1 ? 'head' : 'torso' }); }
    step(1.5);
  }
  step(18);
  // player exertion + danger → breathing, heartbeat, recovery breath; landing; crouch steps
  player.moving = 4.2;
  for (let t = 0; t < 12; t += 1 / 60) { player.pos.z -= 4.2 / 60; player.eye.z = player.pos.z; ctx.time.now += 1 / 60; audio.update(1 / 60); }
  player.moving = 0;
  for (let i = 0; i < 6; i++) { events.emit('player:damage', { amount: 15, part: 'torso', health: 30, from: V3(0, 0, 0) }); step(0.5); }
  player.health = 30; step(4); player.health = 100; step(35);
  player.pos.y = 3; step(0.1); player.pos.y = 0; step(0.3);
  // footsteps on every surface (walk), a slow roller close, wounded-but-standing enemies, a far death
  for (const g of ['metal', 'wood', 'dirt', 'concrete']) { groundSurf = g; player.moving = 2.3; for (let t = 0; t < 2; t += 1 / 60) { player.pos.x += 2.3 / 60; ctx.time.now += 1 / 60; audio.update(1 / 60); } }
  player.moving = 0; groundSurf = 'concrete';
  { const d = doorsList.find((x) => x.id === 'd_dock3'); d.t = 1; d.target = 0; d.speed = 0.25; d.state = 'closed'; events.emit('door:state', { id: d.id, state: 'closed', door: d }); step(0.5); }
  for (const e of enemies.list.slice(14, 20)) { e.dead = false; e.health = 80; e.pos.x = 45; e.pos.z = 96; events.emit('enemy:damage', { id: e.id, enemy: e, amount: 15, part: 'torso' }); step(2.5); }
  { const e = enemies.list[20]; e.dead = true; e.pos.x = 45; e.pos.z = 30; events.emit('enemy:death', { id: e.id, enemy: e, part: 'torso' }); step(1); }
  visit(15, 6, 10, 3);
  // glass, lights back on
  events.emit('lights:circuit', { id: 'halle', level: 1, fade: 0.5 }); step(0.5);
  const missing = [...bank.sounds.keys()].filter((n) => !n.startsWith('ir.') && !played.has(n));
  ok(!missing.length, `manifest sounds never requested by the design: ${missing.join(', ')}`);
  console.log(`  design (null output): ${playCount} requests, ${played.size}/${[...bank.sounds.keys()].filter((n) => !n.startsWith("ir.")).length} playable sounds reached; ${Object.keys(SOUND_EVENTS).length} sound events ok; non-sound: ${Object.keys(NON_SOUND).join(', ')}`);

  // ---- logic cost of a firefight (8 enemies firing, voices, impacts, whizz) — JS only, Web Audio excluded
  {
    const fighters = enemies.list.slice(0, 8);
    fighters.forEach((e, k) => { e.dead = false; e.alerted = true; e.pos.x = 40 + k * 1.5; e.pos.y = 0; e.pos.z = 85; e.health = 100; });
    player.eye.x = 45; player.eye.z = 100;
    const frames = 600; let tot = 0, max = 0;
    for (let f = 0; f < frames; f++) {
      ctx.time.now += 1 / 60;
      const e = fighters[f % 8];
      const t1 = performance.now();
      if (f % 4 === 0) { events.emit('enemy:fire', { id: e.id, enemy: e }); events.emit('shot', fire(e, V3(e.pos.x, 1.4, 85), V3(0, 0, 1))); }
      if (f % 9 === 0) { events.emit('weapon:fire', { ammo: 5 }); events.emit('shot', fire(player, V3(45, 1.5, 100), V3(0, 0, -1))); }
      if (f % 37 === 0) events.emit('enemy:damage', { id: e.id, enemy: e, amount: 10, part: 'torso' });
      e.pos.x += 0.02;
      audio.update(1 / 60);
      const ms = performance.now() - t1; tot += ms; if (ms > max) max = ms;
    }
    console.log(`  firefight logic (8 enemies, 15 shots/s): ${(tot / frames).toFixed(3)} ms/frame avg, ${max.toFixed(2)} ms max (Node, without Web Audio calls)`);
    warn(tot / frames < 0.25, `audio logic ${(tot / frames).toFixed(3)} ms/frame in a firefight`);
  }
  console.log(`  (${(performance.now() - t0).toFixed(0)} ms)`);
}
