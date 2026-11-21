// Workstream F tests (director, staged moments, mission flow). Node only, run by `npm test`.
//  1. every timeline references existing doors / circuits / machines / enemies+groups / zones / sounds
//  2. every moment volume and evidence spot lies in reachable nav space
//  3. no moment can block the only route: every door a moment closes or locks is closed (alone and all together)
//     and the extraction must stay reachable from every moment's volume and from the spawn
//  4. seeded playthrough simulation along the dev tour with the real runtime/mission/pacing code and a fake ctx:
//     moments fire in a sane order, every timeline ends, deterministic per seed, variants differ between seeds;
//     every variant of every moment forced once; checkpoint snapshot; breach of the cash-room door
import { readFileSync, existsSync } from 'node:fs';
import * as DATA from '../src/world/layout/moments.js';
import { createRuntime } from '../src/director/runtime.js';
import { createMission } from '../src/director/mission.js';
import { createPacing } from '../src/director/pacing.js';
import { createEvents } from '../src/core/events.js';
import { createDevtools } from '../src/core/devtools.js';
import { F_OCC } from '../src/world/gen.js';

const DOOR_STATES = new Set(['open', 'closed', 'half', 'locked']);
const MACHINE_ACTIONS = { conveyor: ['start', 'stop'], agv: ['dispatch', 'stop'], robot: ['start', 'stop'], crane: ['start', 'stop'], sorter: ['divert'] };

export default async ({ W, bvh, nav, LAYOUT, ok, warn }) => {
  const t0 = performance.now();
  const doorIds = new Set(W.doors.map((d) => d.id));
  const manifest = existsSync('public/assets/audio/manifest.json') ? JSON.parse(readFileSync('public/assets/audio/manifest.json', 'utf8')) : null;
  const sounds = new Set(Object.keys(manifest?.sounds ?? {}));
  const machineIds = { conveyor: LAYOUT.conveyors.map((c) => c.id), agv: LAYOUT.agvs.map((a) => a.id), robot: LAYOUT.robots.map((r) => r.id), crane: LAYOUT.cranes.map((c) => c.id), sorter: [LAYOUT.sorter.id] };
  const requested = new Set();

  // ------------------------------------------------------------------------------------------ 1 references
  const allSteps = [];   // [momentId, raw step]
  for (const m of DATA.MOMENTS) {
    ok(m.variants?.length >= 1, `${m.id}: no variants`);
    warn(m.variants.length >= 2, `${m.id}: only one variant (retries identical)`);
    for (const list of [m.common, m.persist]) for (const s of list ?? []) allSteps.push([m.id, s]);
    for (const v of m.variants) for (const list of [v.tl, v.setup, v.persist]) for (const s of list ?? []) allSteps.push([`${m.id}/${v.id}`, s]);
  }
  for (const s of DATA.MISSION_START) allSteps.push(['mission_start', s]);
  const closing = new Map();   // door id → [moment ids] that close/lock it
  for (const [who, s] of allSteps) {
    const [, op, ...a] = s;
    if (op === 'door') {
      ok(doorIds.has(a[0]), `${who}: unknown door ${a[0]}`);
      ok(DOOR_STATES.has(a[1]), `${who}: bad door state ${a[1]}`);
      if (a[1] === 'closed' || a[1] === 'locked') { const k = closing.get(a[0]) ?? []; k.push(who.split('/')[0]); closing.set(a[0], k); }
    }
    if (op === 'light' || op === 'strobe') {
      ok(LAYOUT.circuitIds.includes(a[0]), `${who}: unknown circuit ${a[0]}`);
      if (op === 'light') ok(a[1] >= 0 && a[1] <= 1, `${who}: circuit level ${a[1]} outside 0..1`);
    }
    if (op === 'machine') {
      ok(machineIds[a[0]]?.includes(a[1]), `${who}: unknown machine ${a[0]} ${a[1]}`);
      ok(MACHINE_ACTIONS[a[0]]?.includes(a[2]), `${who}: bad machine action ${a[0]}.${a[2]}`);
    }
    if (op === 'sound' || op === 'steps') {
      const cands = String(op === 'sound' ? a[1] : a[0]).split('|');
      if (manifest) {
        ok(sounds.has(cands[cands.length - 1]), `${who}: sound ${cands.at(-1)} (last fallback) not in the audio manifest`);
        for (const c of cands.slice(0, -1)) if (!sounds.has(c)) requested.add(c);
      }
    }
    if (op === 'until') ok((a[1] ?? 30) <= 90, `${who}: until without a sane timeout (${a[1]})`);
  }
  for (const set of Object.values(DATA.AMBIENT.cues)) for (const c of set) if (manifest) ok(sounds.has(c), `ambient cue ${c} not in the audio manifest`);
  if (manifest) for (const b of Object.values(DATA.BREACH)) ok(sounds.has(b.rattle), `breach rattle ${b.rattle} not in the audio manifest`);
  if (requested.size) console.log(`  sounds requested from E (fallbacks in use): ${[...requested].join(', ')}`);
  for (const [g, ids] of Object.entries(DATA.GROUPS)) for (const id of ids) ok(LAYOUT.enemies.some((e) => e.id === id), `group ${g}: unknown enemy ${id}`);

  // ------------------------------------------------------------------------------------------ fake ctx (also compiles everything)
  const defaultLocked = W.doors.map((d, i) => (d.state === 'locked' ? i : -1)).filter((i) => i >= 0);
  const resetBlocked = () => { nav.doorBlocked.fill(0); for (const i of defaultLocked) nav.doorBlocked[i] = 1; };
  function fakeCtx() {
    const events = createEvents();
    const doorList = W.doors.map((d, i) => ({ ...d, index: i, t: d.state === 'open' ? 1 : d.state === 'half' ? 0.6 : 0, speed: 1 }));
    const doorMap = new Map(doorList.map((r) => [r.id, r]));
    const evt = { id: '', state: '', door: null };
    const doors = {
      list: doorList, get: (id) => doorMap.get(id),
      set(id, state) { const r = doorMap.get(id); if (!r) return false; r.state = state; r.t = state === 'open' ? 1 : state === 'half' ? 0.6 : 0; nav.doorBlocked[r.index] = state === 'locked' ? 1 : 0; evt.id = id; evt.state = state; evt.door = r; events.emit('door:state', evt); return true; },
      reset() { for (const r of doorList) { r.state = W.doors[r.index].state; r.t = r.state === 'open' ? 1 : r.state === 'half' ? 0.6 : 0; } resetBlocked(); },
    };
    const circ = {}; for (const id of LAYOUT.circuitIds) circ[id] = LAYOUT.circuits[id];
    const mk = (list, start, stop) => list.map((x) => ({ id: x.id, state: x.state, [start]() { this.state = 'running'; }, [stop]() { this.state = start === 'dispatch' ? 'parked' : 'stopped'; }, pos: { x: 0, y: 0, z: 0 } }));
    const machines = { conveyors: mk(LAYOUT.conveyors, 'start', 'stop'), agvs: mk(LAYOUT.agvs, 'dispatch', 'stop'), robots: mk(LAYOUT.robots, 'start', 'stop'), cranes: LAYOUT.cranes.map((c) => ({ id: c.id, state: c.state })) };
    machines.conveyor = (id) => machines.conveyors.find((x) => x.id === id);
    machines.agv = (id) => machines.agvs.find((x) => x.id === id);
    machines.robot = (id) => machines.robots.find((x) => x.id === id);
    machines.crane = (id) => machines.cranes.find((x) => x.id === id);
    const log = { sound: [], alert: [], radio: [], ambient: 0 };
    const enemies = {
      list: LAYOUT.enemies.map((e) => ({ id: e.id, def: e, pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] }, dead: false, alerted: false, surrendered: false, dieAt: -1 })),
      alert(ids) { for (const id of ids) { const e = enemies.list.find((x) => x.id === id); if (e && !e.dead && !e.alerted) { e.alerted = true; e.dieAt = ctx.time.mission + 4; log.alert.push(id); } } },
      ambush(ids) { enemies.alert(ids); },
      stage(id, b) { const e = enemies.list.find((x) => x.id === id); if (b === 'surrender' && e) e.surrendered = true; else enemies.alert([id]); },
    };
    const player = { pos: { x: 0, y: 0, z: 0 }, eye: { x: 0, y: 1.5, z: 0 }, forward: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0, health: 100, dead: false };
    const ctx = {
      layout: LAYOUT, events, state: 'playing', time: { now: 0, dt: 0.1, frame: 0, mission: 0 }, player, enemies, machines,
      world: {
        doors, lights: { setCircuit(id, l) { if (!(id in circ)) throw new Error(`circuit ${id}`); circ[id] = l; return true; }, level: (id) => circ[id] },
        zoneAt: (x, y, z) => W.zoneLookup.at(x, y, z), isPointVisible: () => false,
        lineOfSight: (a, b) => !bvh.occluded(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, 1, F_OCC),
      },
      audio: { playAt(id, p, o) { log.sound.push(id); return { stop() {} }; }, play() { return null; } },
      log, circ,
    };
    events.on('radio', (r) => log.radio.push(r.text));
    return ctx;
  }
  function build(ctx) {
    let mission = null;
    const rt = createRuntime(ctx, DATA, { evidenceCount: () => mission?.foundCount() ?? 0, breached: (id) => mission?.breached(id) ?? false });
    mission = createMission(ctx, DATA, rt);
    const pacing = createPacing(ctx, DATA, rt);
    return { rt, mission, pacing };
  }
  {
    const { rt } = build(fakeCtx());
    ok(rt.compileErrors.length === 0, `moment data: ${rt.compileErrors.join('; ')}`);
  }

  // ------------------------------------------------------------------------------------------ 2 reachable volumes
  resetBlocked();
  const spawn = nav.nearest(...LAYOUT.playerSpawn.pos.map((v, i) => (i === 1 ? v + 0.1 : v)));
  const nodeIn = (b) => { for (let k = 0; k < nav.n; k++) { const x = nav.nodeX(k), z = nav.nodeZ(k), y = nav.nodeY[k]; if (x > b[0] && x < b[3] && z > b[2] && z < b[5] && y >= b[1] && y <= b[4]) return k; } return -1; };
  const reachLocked = nav.reachable(spawn, false), reachAll = nav.reachable(spawn, true);
  const ex = DATA.EXTRACTION.box, exNode = nodeIn(ex);
  ok(exNode >= 0 && reachLocked[exNode], 'extraction not reachable from the spawn');
  const momentNodes = new Map();
  for (const m of DATA.MOMENTS) {
    const vols = m.vols === null ? [m.box] : (m.vols ?? [m.box]);
    vols.forEach((b, i) => {
      const k = nodeIn(b);
      if (!ok(k >= 0, `${m.id}: volume ${i} has no walkable cell`)) return;
      if (m.vols === null) ok(reachAll[k], `${m.id}: trigger area unreachable even with locks open`);
      else ok(reachLocked[k], `${m.id}: volume ${i} not reachable from the spawn (locked doors respected)`);
      if (i === 0) momentNodes.set(m.id, k);
    });
  }
  for (const e of DATA.EVIDENCE) {
    let best = -1;
    for (let k = 0; k < nav.n; k++) {
      const dx = nav.nodeX(k) - e.pos[0], dz = nav.nodeZ(k) - e.pos[2], dy = nav.nodeY[k] + 1 - e.pos[1];
      if (dx * dx + dz * dz + dy * dy * 2 < e.r * e.r * 0.8 && reachAll[k]) { best = k; break; }
    }
    ok(best >= 0, `evidence ${e.id}: no reachable standing spot within ${e.r} m`);
  }

  // ------------------------------------------------------------------------------------------ 3 door blocking
  const doorIndex = new Map(W.doors.map((d, i) => [d.id, i]));
  const checkBlocked = (ids, label) => {
    resetBlocked();
    for (const id of ids) nav.doorBlocked[doorIndex.get(id)] = 1;
    const fromSpawn = nav.reachable(spawn, false);
    ok(fromSpawn[exNode], `${label}: extraction unreachable from the spawn`);
    for (const [mid, k] of momentNodes) {
      if (DATA.MOMENTS.find((m) => m.id === mid).vols === null) continue;
      const r = nav.reachable(k, false);
      ok(r[exNode], `${label}: extraction unreachable from ${mid}`);
      for (const [mid2, k2] of momentNodes) if (mid2 !== mid && DATA.MOMENTS.find((m) => m.id === mid2).vols !== null) warn(r[k2], `${label}: ${mid2} unreachable from ${mid}`);
    }
  };
  for (const [id, who] of closing) checkBlocked([id], `door ${id} closed by ${[...new Set(who)].join(',')}`);
  checkBlocked([...closing.keys()], `all director-closed doors (${[...closing.keys()].join(', ')})`);
  // stricter (informative): every closable door closed alone, from every moment volume. The player can reopen
  // closed doors, so this only warns — but a director-closed door must never be such a door (checked above).
  let critical = 0;
  for (const d of W.doors) {
    if (d.state === 'locked') continue;
    resetBlocked(); nav.doorBlocked[doorIndex.get(d.id)] = 1;
    const cut = [...momentNodes].filter(([mid, k]) => DATA.MOMENTS.find((m) => m.id === mid).vols !== null && !nav.reachable(k, false)[exNode]).map(([mid]) => mid);
    if (cut.length) { critical++; ok(!closing.has(d.id), `director closes door ${d.id}, the only way out from ${cut.join(', ')}`); console.log(`  note: door ${d.id} alone would cut ${cut.join(', ')} from the extraction (player can open it)`); }
  }
  console.log(`  ${W.doors.length} doors closed one at a time: ${critical} are a single route out of some moment area`);
  resetBlocked();

  // ------------------------------------------------------------------------------------------ 4 simulation
  const tour = createDevtools({}).tour;
  const path = new Int32Array(8192);
  function simulate(seed, { extraIdle = 120 } = {}) {
    resetBlocked();
    const ctx = fakeCtx(), { rt, mission, pacing } = build(ctx);
    const P = ctx.player, T = ctx.time;
    const sp = LAYOUT.playerSpawn.pos;
    P.pos.x = sp[0]; P.pos.y = sp[1]; P.pos.z = sp[2];
    rt.reset(seed); pacing.reset(seed); mission.reset(); rt.setup();
    const starts = [];
    ctx.events.on('moment', (e) => starts.push(`${e.id}:${e.variant}`));
    const tick = (dt) => {
      T.mission += dt; T.now += dt; T.frame++;
      P.eye.x = P.pos.x; P.eye.y = P.pos.y + 1.5; P.eye.z = P.pos.z;
      P.forward.x = -Math.sin(P.yaw); P.forward.y = 0; P.forward.z = -Math.cos(P.yaw);
      rt.update(dt); mission.update(dt); pacing.update(dt);
      // a competent player: alerted enemies go down after a few seconds; anyone within 5 m too
      for (const e of ctx.enemies.list) {
        if (e.dead || e.surrendered) continue;
        if ((e.dieAt >= 0 && T.mission >= e.dieAt) || Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z) < 5 && Math.abs(e.pos.y - P.pos.y) < 2) { e.dead = true; ctx.events.emit('enemy:death', { id: e.id, enemy: e }); }
      }
    };
    let reached = false, stuck = '';
    outer: for (const w of tour) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const a = nav.nearest(P.pos.x, P.pos.y + 0.1, P.pos.z), b = nav.nearest(w[0], w[1] + 0.1, w[2]);
        const n = nav.findPath(a, b, path, 200000);
        if (!n) { stuck = `no path to ${w}`; break outer; }
        const nodes = Array.from(path.subarray(0, n)).reverse();
        let replan = false;
        for (const k of nodes) {
          if (nav.nodeDoor[k] >= 0 && nav.doorBlocked[nav.nodeDoor[k]]) { replan = true; break; }
          const tx = nav.nodeX(k), tz = nav.nodeZ(k), ty = nav.nodeY[k];
          for (let g = 0; g < 50; g++) {
            const dx = tx - P.pos.x, dz = tz - P.pos.z, dd = Math.hypot(dx, dz);
            if (dd < 0.05) break;
            if (dd > 1e-3) P.yaw = Math.atan2(-dx, -dz);
            const st = Math.min(dd, 3.2 * 0.1);
            P.pos.x += dx / dd * st; P.pos.z += dz / dd * st; P.pos.y += (ty - P.pos.y) * 0.5;
            tick(0.1);
            if (P.pos.x >= ex[0] && P.pos.x <= ex[3] && P.pos.z >= ex[2] && P.pos.z <= ex[5]) { reached = true; break outer; }
          }
        }
        if (!replan) break;
      }
    }
    const tourTime = T.mission;
    for (let i = 0; i < extraIdle * 10; i++) tick(0.1);
    return { ctx, rt, mission, pacing, starts, reached, stuck, tourTime };
  }

  const A = simulate(1234), B = simulate(1234), Cs = [simulate(99), simulate(7), simulate(31337)];
  ok(A.reached, `simulated tour did not reach the extraction (${A.stuck})`);
  ok(JSON.stringify(A.starts) === JSON.stringify(B.starts), 'same seed produced a different moment sequence');
  const variantSets = new Set([A, ...Cs].map((r) => r.starts.join(',')));
  ok(variantSets.size >= 3, `seeds produce too little variation (${variantSets.size} distinct runs of 4)`);
  for (const r of [A, ...Cs]) {
    const ids = r.starts.map((s) => s.split(':')[0]);
    ok(ids[0] === 'm01_ankunft', `run starts with ${ids[0]}, not m01_ankunft`);
    ok(ids.indexOf('m02_tor_faellt') < ids.indexOf('m03_packerei'), 'm02 must come before m03 on the tour');
    const late = ids.indexOf('m14_verladung');
    if (late >= 0) ok(['m06_foerderband', 'm09_roboter', 'm10_kuehl'].some((x) => ids.indexOf(x) >= 0 && ids.indexOf(x) < late), 'm14 before any automation moment');
    ok(new Set(ids).size === ids.length, 'a moment fired twice');
    const handled = r.rt.states().filter((s) => s.state === 'done' || s.state === 'skipped').map((s) => s.id);
    ok(ids.length >= 8 && handled.length >= 9, `only ${ids.length} moments fired / ${handled.length} handled on the tour (${handled.join(', ')})`);
    const running = r.rt.states().filter((s) => s.state === 'running');
    ok(running.length === 0, `timelines still running ${r.tourTime.toFixed(0)}+120 s after the tour: ${running.map((s) => `${s.id}@${s.step}`).join(', ')}`);
    ok(r.mission.objectives.find((o) => o.id === 'o_leit').done, 'objective Leitstand not completed on the tour');
    ok(r.mission.objective.startsWith('Zum Fahrzeug'), `final objective is "${r.mission.objective}"`);
    ok(!!r.mission.checkpoint, 'checkpoint not captured on the tour');
  }
  console.log(`  tour sim (seed 1234): ${A.tourTime.toFixed(0)} s, ${A.starts.length} moments: ${A.starts.join(' → ')}`);
  console.log(`  ambient events ${A.pacing.st.ambientCount}, radio lines ${A.ctx.log.radio.length}, sounds ${A.ctx.log.sound.length}, alerts ${A.ctx.log.alert.length}`);
  warn(A.pacing.st.ambientCount > 0 || Cs.some((r) => r.pacing.st.ambientCount > 0), 'no ambient event fired in any simulated run');

  // every variant forced once: must run to the end without throwing (player standing in the moment's first volume)
  let forced = 0;
  for (const m of DATA.MOMENTS) {
    m.variants.forEach((v, vi) => {
      resetBlocked();
      const ctx = fakeCtx(), { rt, mission, pacing } = build(ctx);
      const b = m.box;
      ctx.player.pos.x = (b[0] + b[3]) / 2; ctx.player.pos.y = Math.max(b[1], 0) + (b[1] > 3 ? 0.3 : 0); ctx.player.pos.z = (b[2] + b[5]) / 2;
      rt.reset(5); mission.reset(); pacing.reset(5); rt.setup();
      try {
        rt.fire(m.id, vi);
        for (let i = 0; i < 1800; i++) { ctx.time.mission += 0.1; ctx.time.frame++; rt.update(0.1); mission.update(0.1); pacing.update(0.1); }
        const s = rt.states().find((x) => x.id === m.id);
        ok(s.state === 'done', `${m.id}/${v.id} forced: ended in state ${s.state} at step ${s.step}`);
        forced++;
      } catch (e) { ok(false, `${m.id}/${v.id} threw: ${e.stack}`); }
    });
  }
  // breach: two uses of the locked cash-room door within the window → door opens → m12 fires
  {
    resetBlocked();
    const ctx = fakeCtx(), { rt, mission, pacing } = build(ctx);
    rt.reset(3); mission.reset(); pacing.reset(3); rt.setup();
    Object.assign(ctx.player.pos, { x: 7.5, y: 4.5, z: 10.2 });
    const door = ctx.world.doors.get('d_geld');
    ctx.events.emit('door:locked', { id: 'd_geld', door }); ctx.time.mission += 1; ctx.events.emit('door:locked', { id: 'd_geld', door });
    for (let i = 0; i < 10; i++) { ctx.time.mission += 0.1; rt.update(0.1); mission.update(0.1); }
    ok(door.state === 'open', 'cash-room door not breached after two kicks');
    ok(rt.states().find((x) => x.id === 'm12_geldraum').state !== 'idle', 'm12_geldraum did not start after the breach');
  }
  // checkpoint restore keeps done moments done and re-applies their world state
  {
    const r = simulate(4242, { extraIdle: 0 });
    const snap = r.mission.checkpoint;
    const ctx = fakeCtx(), { rt, mission } = build(ctx);
    rt.reset(77); mission.reset(true);
    rt.restoreDone(snap.done, snap.variants); mission.restore(snap);
    ok(snap.done.every((id) => rt.states().find((x) => x.id === id).state === 'done'), 'checkpoint restore lost a done moment');
    if (snap.done.includes('m02_tor_faellt') && ['tor', 'spaet'].includes(rt.moments.find((m) => m.id === 'm02_tor_faellt').variants[snap.variants[snap.done.indexOf('m02_tor_faellt')]].id)) ok(ctx.world.doors.get('d_dock2').state === 'locked', 'checkpoint restore: Tor 2 not locked again');
    ok(mission.stats.retries === 1, 'checkpoint restore: retry not counted');
  }
  resetBlocked();
  console.log(`  ${DATA.MOMENTS.length} moments, ${DATA.MOMENTS.reduce((n, m) => n + m.variants.length, 0)} variants (${forced} forced runs ok), ${allSteps.length} steps, ${(performance.now() - t0).toFixed(0)} ms`);
};
