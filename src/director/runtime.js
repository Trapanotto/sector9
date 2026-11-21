// Staged-moment runtime: data-driven timelines (moments.js) compiled once, then executed allocation-free.
// Pure logic + ctx hooks (runs in Node for the director test with a fake ctx). Owner: F.
//
// Moment lifecycle: idle → running → done   (or idle → skipped when all its actors are already dead)
// A moment starts when its preconditions hold and the player is inside one of its volumes (`vols`, default
// [box]; none = global) and all `when` conditions hold (or `whenTimeout` seconds passed inside the volume).
// Timeline steps run on a local clock; an 'until' step pauses the clock until its condition holds or its timeout
// passes (then the clock restarts at 0 — times after an 'until' are relative to it).
//
// Step ops ([t | [t, jitter], op, ...args]):
//   door id state [speed]          light circuit level fade [flicker]     strobe circuit seconds hz after
//   machine kind id action         sound slot soundIds pos [opts]         stop slot [fade]
//   steps soundId fromPos toPos n interval  (moving footsteps — expanded into n sounds)
//   radio speaker text             alert ids [pos]     alertNear pos radius max     ambush ids
//   stage ids behaviour [opts]     until cond timeout ['skip']      tension amount     fx kind pos     emit name
// Slots are global names ('-' = fire and forget) so one moment can stop another's loop.
// soundIds may list fallbacks 'loop.radio|voice.muffled.laugh' (first one the audio module has).
import { createSpace } from './cond.js';
import { createRng, hash32 } from './rng.js';

const OP = { door: 1, light: 2, strobe: 3, machine: 4, sound: 5, stop: 6, radio: 7, alert: 8, alertNear: 9, ambush: 10,
  stage: 11, until: 12, tension: 13, fx: 14, emit: 15 };
export const OPS = Object.keys(OP);
export const ST = { IDLE: 0, RUNNING: 1, DONE: 2, SKIPPED: 3 };
const ST_NAME = ['idle', 'running', 'done', 'skipped'];

export function createRuntime(ctx, data, hooks = {}) {
  const env = {
    ctx, enemyIds: ctx.layout.enemies.map((e) => e.id), groups: data.GROUPS,
    zoneIndex: new Map(ctx.layout.zones.map((z, i) => [z.id, i])), zoneCount: ctx.layout.zones.length,
    playerZone: -1,
    enemy: (k) => bound[k] ?? null,
    momentDone: (id) => { const m = byId.get(id); return !!m && (m.state === ST.DONE || m.state === ST.SKIPPED); },
    evidenceCount: () => hooks.evidenceCount?.() ?? 0,
    breached: (id) => hooks.breached?.(id) ?? false,
  };
  const space = createSpace(env);
  const bound = new Array(env.enemyIds.length).fill(null);
  const slotIndex = new Map();
  const slotOf = (name) => {
    if (name == null || name === '-') return -1;
    if (!slotIndex.has(name)) slotIndex.set(name, slotIndex.size);
    return slotIndex.get(name);
  };
  const log = [];   // { t, id, what } (debug; bounded)
  const note = (id, what) => { if (log.length > 400) log.shift(); log.push({ t: +ctx.time.mission.toFixed(1), id, what }); hooks.log?.(id, what); };

  // ---------------------------------------------------------------------------------------------------- compile
  function step(raw, errors) {
    const [tt, name, ...a] = raw;
    const op = OP[name];
    if (!op) { errors.push(`unknown op ${name}`); return null; }
    const s = { t: Array.isArray(tt) ? tt[0] : tt, j: Array.isArray(tt) ? tt[1] : 0, op, name, a, s1: '', s2: '', n1: 0, n2: 0, n3: 0,
      p: null, p2: null, f: 0, ids: null, cond: null, opts: null, cands: null, snd: '', slot: -1, raw };
    switch (op) {
      case OP.door: s.s1 = a[0]; s.s2 = a[1]; s.n1 = a[2] ?? 0; break;
      case OP.light: s.s1 = a[0]; s.n1 = a[1]; s.n2 = a[2] ?? 0; s.n3 = a[3] ?? 0; break;
      case OP.strobe: s.s1 = a[0]; s.n1 = a[1]; s.n2 = a[2] ?? 2; s.n3 = a[3] ?? 0.1; break;
      case OP.machine: s.s1 = a[0]; s.s2 = a[1]; s.snd = a[2]; break;
      case OP.sound: s.slot = slotOf(a[0]); s.cands = String(a[1]).split('|'); s.p = space.pos(a[2]); s.opts = { volume: a[3]?.vol ?? 1, loop: !!a[3]?.loop, muffled: !!a[3]?.muffled }; break;
      case OP.stop: s.slot = slotOf(a[0]); s.n1 = a[1] ?? 0.3; break;
      case OP.radio: s.s1 = a[0]; s.s2 = a[1]; break;
      case OP.alert: s.ids = space.ids(a[0]); s.p = space.pos(a[1] ?? 'player'); break;
      case OP.alertNear: s.p = space.pos(a[0]); s.n1 = a[1]; s.n2 = a[2] ?? 4; break;
      case OP.ambush: s.ids = space.ids(a[0]); break;
      case OP.stage: {
        s.ids = space.ids(a[0]); s.s1 = a[1];
        const o = a[2] ?? {};
        s.opts = { ...o };   // passed to D; positions inside are plain arrays
        if (o.pos === 'player') s.p = space.pos('player');
        break;
      }
      case OP.until: s.cond = space.cond(a[0]); s.n1 = a[1] ?? 30; s.n2 = a[2] === 'skip' ? 1 : 0; break;
      case OP.tension: s.n1 = a[0]; break;
      case OP.fx: s.s1 = a[0]; s.p = space.pos(a[1]); break;
      case OP.emit: s.s1 = a[0]; break;
    }
    return s;
  }
  /** expands 'steps' into n positional sounds; sorts each segment (split at 'until') by time */
  function timeline(list, errors) {
    const out = [];
    let seg = [];
    const flush = () => { seg.sort((x, y) => x.t - y.t); out.push(...seg); seg = []; };
    for (const raw of list ?? []) {
      if (raw[1] === 'steps') {
        const [tt, , snd, from, to, n, iv] = raw;
        const t0 = Array.isArray(tt) ? tt[0] : tt;
        for (let i = 0; i < n; i++) {
          const s = step([t0 + i * iv, 'sound', '-', snd, from, { vol: 0.8 }], errors);
          s.p2 = space.pos(to); s.f = n > 1 ? i / (n - 1) : 0;
          seg.push(s);
        }
        continue;
      }
      const s = step(raw, errors);
      if (!s) continue;
      if (s.op === OP.until) { const last = seg.length ? Math.max(...seg.map((x) => x.t)) : 0; s.t = Math.max(s.t, last); seg.push(s); flush(); }
      else seg.push(s);
    }
    flush();
    return out;
  }

  const moments = data.MOMENTS.map((def) => {
    const errors = [];
    const m = {
      def, id: def.id, order: def.order ?? 99, phase: def.phase ?? '',
      vols: (def.vols === null ? [] : (def.vols ?? [def.box])).map((b) => Float32Array.from(b)),
      when: (def.when ?? []).map(space.cond), whenTimeout: def.whenTimeout ?? 0,
      pre: {
        after: def.pre?.after ?? [], afterAny: def.pre?.afterAny ?? [], orTime: def.pre?.orTime ?? Infinity,
        minTime: def.pre?.minTime ?? 0,
      },
      actors: space.ids(def.actors ?? []),
      variants: def.variants.map((v) => {
        const steps = timeline([...(def.common ?? []), ...(v.tl ?? [])], errors);
        return { id: v.id, w: v.w ?? 1, note: v.note ?? '', steps, jit: new Float32Array(steps.length),
          setup: timeline(v.setup ?? [], errors), persist: timeline([...(def.persist ?? []), ...(v.persist ?? [])], errors) };
      }),
      errors,
      state: ST.IDLE, v: 0, pc: 0, t: 0, waiting: false, wait: 0, inside: 0, startedAt: -1, endedAt: -1, forced: false,
    };
    return m;
  });
  const byId = new Map(moments.map((m) => [m.id, m]));
  const compileErrors = [...space.errors];
  for (const m of moments) for (const e of m.errors) compileErrors.push(`${m.id}: ${e}`);
  const startSteps = timeline(data.MISSION_START ?? [], compileErrors);
  const startMoment = { id: 'mission_start' };
  const slots = new Array(slotIndex.size).fill(null);

  // ---------------------------------------------------------------------------------------------------- state
  const rng = createRng(1);
  let seed = 1;
  const tension = { boost: 0 };
  const strobe = { on: false, circuit: '', until: 0, hz: 2, after: 0, phase: -1, t: 0 };

  function bind() {
    const list = ctx.enemies?.list ?? [];
    for (let k = 0; k < env.enemyIds.length; k++) bound[k] = list.find((e) => e.id === env.enemyIds[k]) ?? null;
  }
  function pickVariants() {
    for (const m of moments) {
      rng.seed(hash32(m.id, seed));
      let total = 0; for (const v of m.variants) total += v.w;
      let r = rng.next() * total, vi = 0;
      for (; vi < m.variants.length - 1; vi++) { r -= m.variants[vi].w; if (r < 0) break; }
      m.v = vi;
      const v = m.variants[vi];
      for (let i = 0; i < v.steps.length; i++) v.jit[i] = rng.jit(v.steps[i].j);
    }
  }

  // ---------------------------------------------------------------------------------------------------- exec
  const vecs = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0 }));
  let vi8 = 0;
  const vec = () => vecs[(vi8 = (vi8 + 1) & 7)];
  const tmpB = { x: 0, y: 0, z: 0 };
  const alive = [];        // reused id list handed to D (D must not keep it)
  const doorOpts = { speed: 0, instant: false };
  const radioEvt = { speaker: '', text: '', sound: 'voice.radio' };
  const momentEvt = { id: '', def: null, variant: '' };
  const emitEvt = { id: '', moment: '' };
  const stageOpts = { pos: null };

  function aliveIds(ids) {
    alive.length = 0;
    for (let i = 0; i < ids.length; i++) { const e = bound[ids[i]]; if (e && !e.dead) alive.push(e.id); }
    return alive;
  }
  function pickSound(s) {
    if (s.snd) return s.snd;
    const has = ctx.audio?.has;
    let id = s.cands[s.cands.length - 1];
    if (typeof has === 'function') for (const c of s.cands) if (has.call(ctx.audio, c)) { id = c; break; }
    s.snd = id;
    return id;
  }
  function posOf(s, out) {
    if (!space.resolve(s.p, out)) return false;
    if (s.p2 && space.resolve(s.p2, tmpB)) { out.x += (tmpB.x - out.x) * s.f; out.y += (tmpB.y - out.y) * s.f; out.z += (tmpB.z - out.z) * s.f; }
    return true;
  }
  function machine(kind, id, action, instant) {
    const M = ctx.machines;
    if (!M) return;
    if (kind === 'sorter') { M.sorter?.divert?.(action, { burst: 'powder' }); return; }
    const rec = M[kind]?.(id);
    if (!rec) return;
    if (typeof rec[action] === 'function') rec[action]();
    else if (kind === 'crane' && 'state' in rec) rec.state = action === 'start' ? 'running' : 'stopped';   // stub crane has no API
    if (instant && kind === 'agv' && action === 'dispatch') { /* persist: keep running, position is A's */ }
  }

  function exec(m, s, instant = false) {
    const E = ctx.enemies, W = ctx.world;
    switch (s.op) {
      case OP.door: {
        doorOpts.speed = instant ? 0 : s.n1; doorOpts.instant = instant;
        W.doors?.set(s.s1, s.s2, doorOpts); break;
      }
      case OP.light: W.lights?.setCircuit(s.s1, s.n1, instant ? 0 : s.n2, instant ? 0 : s.n3); break;
      case OP.strobe:
        if (instant) { W.lights?.setCircuit(s.s1, s.n3, 0); break; }
        strobe.on = true; strobe.circuit = s.s1; strobe.t = 0; strobe.until = s.n1; strobe.hz = s.n2; strobe.after = s.n3; strobe.phase = -1;
        hooks.alarm?.(true);
        break;
      case OP.machine: machine(s.s1, s.s2, s.snd, instant); break;
      case OP.sound: {
        if (instant) break;
        const p = vec();
        if (!posOf(s, p)) break;
        const id = pickSound(s);
        if (s.slot >= 0) { slots[s.slot]?.stop?.(0.05); slots[s.slot] = null; }
        const h = ctx.audio?.playAt?.(id, p, s.opts) ?? null;
        if (s.slot >= 0) slots[s.slot] = h;
        break;
      }
      case OP.stop: if (s.slot >= 0 && slots[s.slot]) { slots[s.slot].stop?.(s.n1); slots[s.slot] = null; } hooks.stopped?.(s.slot); break;
      case OP.radio: if (!instant) { radioEvt.speaker = s.s1; radioEvt.text = s.s2; ctx.events.emit('radio', radioEvt); } break;
      case OP.alert: {
        if (instant) break;
        const ids = aliveIds(s.ids); if (!ids.length) break;
        const p = vec(); space.resolve(s.p, p);
        E?.alert?.(ids, p); break;
      }
      case OP.alertNear: {
        if (instant || !E?.list) break;
        const p = vec(); space.resolve(s.p, p);
        alive.length = 0;
        const r2 = s.n1 * s.n1;
        for (let i = 0; i < E.list.length && alive.length < s.n2; i++) {
          const e = E.list[i];
          if (e.dead || e.surrendered) continue;
          const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
          if (dx * dx + dz * dz <= r2) alive.push(e.id);
        }
        if (alive.length) { if (E.stage) for (const id of alive) E.stage(id, 'assault', stageAssault(p)); E.alert?.(alive, p); }
        break;
      }
      case OP.ambush: {
        if (instant) break;
        const ids = aliveIds(s.ids); if (!ids.length) break;
        if (typeof E?.ambush === 'function') E.ambush(ids, ctx.player.pos);
        else E?.alert?.(ids, ctx.player.pos);
        break;
      }
      case OP.stage: {
        if (instant) break;
        const ids = aliveIds(s.ids); if (!ids.length) break;
        if (s.p) { const p = vec(); space.resolve(s.p, p); s.opts.pos = [p.x, p.y, p.z]; }
        if (typeof E?.stage === 'function') { for (const id of ids) E.stage(id, s.s1, s.opts); }
        else if (s.s1 === 'investigate' || s.s1 === 'assault') {
          const q = s.opts.pos; const p = vec();
          if (q) { p.x = q[0]; p.y = q[1]; p.z = q[2]; } else { p.x = ctx.player.pos.x; p.y = ctx.player.pos.y; p.z = ctx.player.pos.z; }
          E?.alert?.(ids, p);
        }
        hooks.staged?.(ids, s.s1, s.opts);
        break;
      }
      case OP.tension: if (!instant) tension.boost += s.n1; break;
      case OP.fx: {
        if (instant) break;
        const p = vec(); if (!posOf(s, p)) break;
        if (s.s1 === 'powder') {
          if (ctx.machines?.sorter?.divert) ctx.machines.sorter.divert('chute3', { burst: 'powder', pos: p });
          else ctx.fx?.powder?.(p);
        } else if (s.s1 === 'fog') ctx.fx?.fog?.(p, 10);
        hooks.fx?.(s.s1, p);
        break;
      }
      case OP.emit: if (!instant) { emitEvt.id = s.s1; emitEvt.moment = m.id; ctx.events.emit(s.s1, emitEvt); } break;
    }
  }
  const assaultOpts = { pos: [0, 0, 0] };
  function stageAssault(p) { assaultOpts.pos[0] = p.x; assaultOpts.pos[1] = p.y; assaultOpts.pos[2] = p.z; return assaultOpts; }

  function start(m, forced = false) {
    m.forced = forced;
    if (!forced && m.actors.length) {
      let any = false;
      for (let i = 0; i < m.actors.length; i++) { const e = bound[m.actors[i]]; if (e && !e.dead) { any = true; break; } }
      if (!any) { m.state = ST.SKIPPED; m.startedAt = m.endedAt = ctx.time.mission; note(m.id, 'skipped (actors down)'); return; }
    }
    m.state = ST.RUNNING; m.pc = 0; m.t = 0; m.waiting = false; m.wait = 0; m.startedAt = ctx.time.mission;
    tension.boost += m.def.tension ?? 0.15;
    momentEvt.id = m.id; momentEvt.def = m.def; momentEvt.variant = m.variants[m.v].id;
    ctx.events.emit('moment', momentEvt);
    note(m.id, `start variant ${m.variants[m.v].id}${forced ? ' (forced)' : ''}`);
  }
  function advance(m, dt) {
    const v = m.variants[m.v], steps = v.steps;
    if (m.waiting) m.wait += dt; else m.t += dt;
    while (m.pc < steps.length) {
      const s = steps[m.pc];
      const at = Math.max(0, s.t + v.jit[m.pc]);
      if (s.op === OP.until) {
        if (!m.waiting) { if (m.t < at) break; m.waiting = true; m.wait = 0; }
        if (space.evaluate(s.cond)) { m.waiting = false; m.pc++; m.t = 0; continue; }
        if (m.wait >= s.n1) {
          m.waiting = false; m.t = 0;
          if (s.n2) { note(m.id, 'until timed out → end'); m.pc = steps.length; break; }
          m.pc++; continue;
        }
        break;
      }
      if (m.t < at) break;
      exec(m, s);
      m.pc++;
    }
    if (m.pc >= steps.length) { m.state = ST.DONE; m.endedAt = ctx.time.mission; note(m.id, 'done'); }
  }
  function preOk(m) {
    const p = m.pre;
    if (ctx.time.mission < p.minTime) return false;
    if (ctx.time.mission >= p.orTime) return true;
    for (let i = 0; i < p.after.length; i++) if (!env.momentDone(p.after[i])) return false;
    if (p.afterAny.length) { let any = false; for (let i = 0; i < p.afterAny.length; i++) if (env.momentDone(p.afterAny[i])) { any = true; break; } if (!any) return false; }
    return true;
  }
  function inVols(m) {
    if (!m.vols.length) return true;
    const p = ctx.player.pos;
    for (let i = 0; i < m.vols.length; i++) {
      const b = m.vols[i];
      if (p.x >= b[0] && p.x <= b[3] && p.y >= b[1] && p.y <= b[4] && p.z >= b[2] && p.z <= b[5]) return true;
    }
    return false;
  }
  function updateStrobe(dt) {
    if (!strobe.on) return;
    strobe.t += dt;
    if (strobe.t >= strobe.until) {
      strobe.on = false; ctx.world.lights?.setCircuit(strobe.circuit, strobe.after, 0.4); hooks.alarm?.(false); return;
    }
    const ph = Math.floor(strobe.t * strobe.hz * 2) & 1;
    if (ph !== strobe.phase) { strobe.phase = ph; ctx.world.lights?.setCircuit(strobe.circuit, ph ? 0.04 : 1.0, 0); }
  }

  // ---------------------------------------------------------------------------------------------------- api
  const rt = {
    moments, byId, log, compileErrors, slotNames: [...slotIndex.keys()], tension, strobe, env, space,
    get seed() { return seed; },
    /** mission start: new seed → variants + jitter; setup steps (ambient loops placed before the moment) */
    reset(newSeed) {
      seed = newSeed >>> 0;
      for (let i = 0; i < slots.length; i++) { slots[i]?.stop?.(0); slots[i] = null; }
      strobe.on = false; tension.boost = 0; log.length = 0;
      for (const m of moments) { m.state = ST.IDLE; m.pc = 0; m.t = 0; m.waiting = false; m.wait = 0; m.inside = 0; m.startedAt = m.endedAt = -1; m.forced = false; }
      bind();
      pickVariants();
    },
    /** after the world/machines reset: run every moment's setup (e.g. the packing radio starts playing) */
    setup() {
      bind();
      for (const s of startSteps) exec(startMoment, s);
      for (const m of moments) { if (m.state !== ST.IDLE) continue; const v = m.variants[m.v]; for (const s of v.setup) exec(m, s); }
    },
    update(dt) {
      if (bound.length && !bound[0] && ctx.enemies?.list?.length) bind();
      env.playerZone = ctx.world.zoneAt ? ctx.world.zoneAt(ctx.player.pos.x, ctx.player.pos.y + 1, ctx.player.pos.z) : -1;
      for (let i = 0; i < moments.length; i++) {
        const m = moments[i];
        if (m.state === ST.IDLE) {
          if (!preOk(m) || !inVols(m)) { m.inside = 0; continue; }
          m.inside += dt;
          let ok = true;
          for (let k = 0; k < m.when.length; k++) if (!space.evaluate(m.when[k])) { ok = false; break; }
          if (ok || (m.whenTimeout > 0 && m.inside >= m.whenTimeout)) start(m);
        }
        if (m.state === ST.RUNNING) advance(m, dt);
      }
      updateStrobe(dt);
    },
    /** debug/test: force a moment now (ignores volumes, preconditions and dead actors); variant index or id */
    fire(id, variant) {
      const m = byId.get(id); if (!m) return false;
      if (variant !== undefined) {
        const vi = typeof variant === 'number' ? variant : m.variants.findIndex((v) => v.id === variant);
        if (vi >= 0 && vi < m.variants.length) m.v = vi;
      }
      bind();
      start(m, true);
      return true;
    },
    /** checkpoint restore: mark moments done and re-apply their persistent world state instantly */
    restoreDone(ids, variants) {
      for (const m of moments) {
        const k = ids.indexOf(m.id);
        if (k < 0) continue;
        if (variants && variants[k] >= 0) m.v = variants[k];
        m.state = ST.DONE; m.pc = m.variants[m.v].steps.length; m.startedAt = m.endedAt = 0;
        for (const s of m.variants[m.v].persist) exec(m, s, true);
      }
    },
    stopAll() { for (let i = 0; i < slots.length; i++) { slots[i]?.stop?.(0.2); slots[i] = null; } strobe.on = false; },
    states() {
      return moments.map((m) => ({ id: m.id, order: m.order, phase: m.phase, state: ST_NAME[m.state], variant: m.variants[m.v].id,
        note: m.variants[m.v].note, step: `${m.pc}/${m.variants[m.v].steps.length}`, waiting: m.waiting,
        started: m.startedAt >= 0 ? +m.startedAt.toFixed(1) : null }));
    },
    running() { let n = 0; for (const m of moments) if (m.state === ST.RUNNING) n++; return n; },
  };
  slots.length = slotIndex.size;
  return rt;
}
