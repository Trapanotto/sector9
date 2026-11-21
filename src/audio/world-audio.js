// The living building: ambience beds per acoustic class crossfading through portals, positional loops that
// follow moving machines with start/stop ramps (conveyor line + drive, sorter clacks, AGV drive + beeper, stacker
// crane, palletising robot servo moves synced to its swing), appliances (fridges, TVs, gas burner, forklift idling,
// fluorescent hum following the light circuits) and the unaware gang members (snoring sleepers, muffled argument
// / talk radio behind doors, coughs). Owner: E.
import { ACOUSTIC } from './acoustics.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** position of a machine record of whatever shape A uses (stub: group.position) */
function posOf(rec, out) {
  const p = rec?.pos ?? rec?.position ?? rec?.group?.position ?? rec?.object?.position ?? rec?.mesh?.position ?? rec?.root?.position;
  if (!p) return false;
  out.x = p.x ?? p[0]; out.y = (p.y ?? p[1] ?? 0); out.z = p.z ?? p[2];
  return true;
}
function running(rec) { const s = rec?.state; return s === 'running' || s === 'moving' || s === 'on' || s === 'active' || s === true; }

export function installWorld(K) {
  const { ctx, E, sched, V } = K;
  const W = { emitters: [], beds: [], duck: 1, duckT: 0, frame: 0 };
  const L = ctx.layout;

  // ---------------------------------------------------------------------------------------------------------
  // emitters: positional loops, realised only when audible (virtual otherwise)
  function emitter(name, o = {}) {
    const e = {
      name, gain: o.gain ?? 1, max: o.max ?? 40, ref: o.ref ?? 0, lp: o.lp ?? 20000, pitch: o.pitch ?? 1, prio: o.prio ?? 3,
      pos: { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0 }, spin: 0, target: 0, tau: o.tau ?? 1.0, tauDown: o.tauDown ?? 1.2,
      rateLo: o.rateLo ?? 1, cut: false, h: 0, level: 1, update: o.update ?? null, want: o.want ?? null, lastBase: -1, lastRate: -1,
      cat: o.cat ?? 'machine', tag: o.tag ?? '',
    };
    W.emitters.push(e);
    return e;
  }
  function tickEmitters(dt) {
    const Lp = K.L;
    for (let i = 0; i < W.emitters.length; i++) {
      const e = W.emitters[i];
      if (e.update) e.update(e, dt);
      const tgt = e.want ? e.want(e) : e.target;
      e.target = tgt;
      // spin-up / run-down (motors take time; voices and appliances use a short tau)
      const k = tgt > e.spin ? dt / e.tau : dt / e.tauDown;
      e.spin += (tgt - e.spin) * Math.min(1, k * 3);
      if (e.cut) { e.spin = 0; e.cut = false; }
      const d = Math.hypot(e.pos.x - Lp.x, e.pos.y - Lp.y, e.pos.z - Lp.z);
      const audible = e.spin > 0.015 && d < e.max + 4;
      if (audible && !e.h) {
        const o = E.opts();
        o.follow = e.pos; o.loop = true; o.gain = e.gain * e.spin * e.level; o.pitch = e.pitch * (e.rateLo + (1 - e.rateLo) * e.spin);
        o.pitchVar = 0; o.max = e.max; o.lp = e.lp; o.prio = e.prio; o.cat = e.cat; o.fadeIn = 0.4;
        if (e.ref) o.ref = e.ref;
        e.h = E.play(e.name, o);
        e.lastBase = o.gain; e.lastRate = o.pitch;
      } else if (!audible && e.h) {
        E.stop(e.h, e.spin < 0.02 ? 0.25 : 0.8); e.h = 0;
      } else if (e.h) {
        const base = e.gain * e.spin * e.level * K.bankGain(e.name);
        if (Math.abs(base - e.lastBase) > 0.01) { E.setBase(e.h, base); e.lastBase = base; }
        const rate = e.pitch * (e.rateLo + (1 - e.rateLo) * e.spin);
        if (Math.abs(rate - e.lastRate) > 0.01) { E.setRate(e.h, rate, 0.25); e.lastRate = rate; }
        if (!E.isPlaying(e.h)) e.h = 0;           // stolen / dropped: retry next tick
      }
    }
  }
  W.emitter = emitter;

  // ---- conveyors: one emitter per conveyor at the closest point of its path (a line source), drive motor
  const machines = () => ctx.machines;
  for (const c of L.conveyors ?? []) {
    const pts = c.points;
    const rec = () => machines()?.conveyor?.(c.id) ?? machines()?.conveyors?.find((x) => x.id === c.id);
    const onC = () => (running(rec()) ? 1 : 0);
    emitter('loop.conveyor.rollers', {
      gain: 1.0, max: 45, ref: 3, rateLo: 0.45, tau: 1.6, tauDown: 2.2, tag: c.id,
      want: onC,
      update(e) {
        const P = K.L; let best = 1e9;
        const n = c.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const ux = b[0] - a[0], uz = b[1] - a[1], l2 = ux * ux + uz * uz || 1;
          const t = clamp01(((P.x - a[0]) * ux + (P.z - a[1]) * uz) / l2);
          const x = a[0] + ux * t, z = a[1] + uz * t, y = a[2] + (b[2] - a[2]) * t;
          const d = (x - P.x) ** 2 + (z - P.z) ** 2;
          if (d < best) { best = d; e.pos.x = x; e.pos.y = y + 0.1; e.pos.z = z; }
        }
      },
    });
    const p0 = pts[0];
    emitter('loop.motor', { x: p0[0], y: p0[2] + 0.3, z: p0[1], gain: 0.7, max: 35, rateLo: 0.3, tau: 1.2, tauDown: 2.5, want: onC, tag: c.id });
  }
  // stereo "big conveyor hall" bed in the automation area while the loop runs (beds below)
  const loopRec = () => machines()?.conveyor?.('c_loop');

  // ---- sorter: clacks/thumps at the chutes while c_loop runs, occasional pneumatic hiss
  let sorterT = 0;
  const S = L.sorter;
  function tickSorter(dt) {
    if (!S || !running(loopRec())) return;
    sorterT -= dt;
    if (sorterT > 0) return;
    sorterT = 0.7 + Math.random() * 1.8;
    const ch = S.chutes[(Math.random() * S.chutes.length) | 0];
    const x = (ch.x0 + ch.x1) / 2, z = (ch.z0 + ch.z1) / 2;
    K.D.playAt(Math.random() < 0.85 ? 'machine.sorter.clack' : 'machine.pneumatic', x, ch.top + 0.4, z, 0.75, 1, 0, (o) => { o.dur = 1.6; o.max = 40; });
  }

  // ---- AGVs: drive hum + rolling + warning beeper (AMR)
  for (const a of L.agvs ?? []) {
    const rec = () => machines()?.agv?.(a.id) ?? machines()?.agvs?.find((x) => x.id === a.id);
    const upd = (e) => { posOf(rec(), e.pos); e.pos.y += 0.35; };
    emitter('loop.motor', { gain: 0.42, max: 28, pitch: a.kind === 'amr' ? 1.35 : 1.15, rateLo: 0.5, tau: 0.6, tauDown: 0.8, update: upd, want: () => (running(rec()) ? 1 : 0), tag: a.id });
    emitter('loop.palletjack', { gain: a.kind === 'tugger' ? 0.65 : 0.4, max: 26, rateLo: 0.4, tau: 0.5, tauDown: 0.5, update: upd, want: () => (running(rec()) ? 1 : 0), tag: a.id });
    if (a.kind === 'amr') emitter('loop.beeper', { gain: 0.55, max: 40, tau: 0.05, tauDown: 0.05, update: upd, want: () => (running(rec()) ? 1 : 0), tag: a.id });
  }

  // ---- stacker crane: travel whine scaled by its speed
  for (const c of L.cranes ?? []) {
    let lz = NaN, v = 0;
    const rec = () => machines()?.crane?.(c.id) ?? machines()?.cranes?.find((x) => x.id === c.id);
    emitter('loop.crane', {
      gain: 0.9, max: 45, rateLo: 0.6, tau: 0.4, tauDown: 0.4, tag: c.id,
      update(e, dt) {
        const r = rec();
        if (!posOf(r, e.pos)) { e.pos.x = c.x; e.pos.z = (c.z0 + c.z1) / 2; }
        e.pos.y = (r?.car?.position?.y ?? 3) + 0.5;
        if (!Number.isNaN(lz) && dt > 0) v += (Math.abs(e.pos.z - lz) / dt - v) * Math.min(1, dt * 4);
        lz = e.pos.z;
      },
      want: () => (running(rec()) ? clamp01(v / (c.speed || 2.5)) : 0),
    });
  }

  // ---- palletising robot: servo loop with |ω|, a servo move one-shot at every reversal, gripper hiss
  for (const r of L.robots ?? []) {
    let la = NaN, w = 0, lastSign = 0, lastEv = 0;
    const rec = () => machines()?.robot?.(r.id) ?? machines()?.robots?.find((x) => x.id === r.id);
    const bx = r.base[0], by = r.base[1] + 1.4, bz = r.base[2];
    emitter('loop.servo', {
      x: bx, y: by, z: bz, gain: 0.8, max: 35, rateLo: 0.7, tau: 0.25, tauDown: 0.35, tag: r.id,
      update(e, dt) {
        const R = rec();
        const ang = R?.arm?.rotation?.y ?? R?.angle ?? R?.joints?.[0] ?? NaN;
        if (!Number.isNaN(ang) && !Number.isNaN(la) && dt > 0) {
          const om = (ang - la) / dt;
          w += (Math.abs(om) - w) * Math.min(1, dt * 8);
          const sg = Math.sign(om);
          if (sg && lastSign && sg !== lastSign && K.now() - lastEv > 0.8) {
            lastEv = K.now();
            K.D.playAt('machine.servo', bx, by, bz, 0.9, 1, 0, (o) => { o.dur = 2.0; o.max = 40; });
            if (Math.random() < 0.45) K.D.playAt('machine.pneumatic', bx, r.base[1] + 0.6, bz, 0.5, 1.1, 0.25, (o) => { o.dur = 1.2; });
          }
          if (sg) lastSign = sg;
        }
        la = ang;
      },
      want: () => (running(rec()) ? clamp01(0.25 + w / 1.4) : 0),
    });
  }

  // ---- appliances and props
  const props = L.props ?? [];
  const fridges = props.filter((p) => p.type === 'fridge');
  for (const f of fridges) emitter('loop.fridge', { x: f.p[0], y: f.p[1] + 1, z: f.p[2], gain: 0.4, max: 14, want: () => 1, tau: 0.2 });
  emitter('loop.fridge', { x: 91, y: 2.8, z: 57, gain: 0.85, max: 30, pitch: 0.92, want: () => 1, tau: 0.2, tag: 'kuehl' });   // cold-store compressor
  const tvs = props.filter((p) => p.type === 'tv');
  tvs.forEach((t, i) => {
    emitter('loop.static', { x: t.p[0], y: t.p[1] + 0.9, z: t.p[2], gain: 0.1, max: 16, lp: 3500, want: () => 1, tau: 0.2, cat: 'machine' });
    if (i === 0) emitter('voice.muffled.laugh', { x: t.p[0], y: t.p[1] + 0.9, z: t.p[2], gain: 0.45, max: 22, lp: 2600, want: () => 1, tau: 0.2, cat: 'murmur', prio: 4 });
  });
  // talk radio on the packing table: stops dead at m03 ("silence as a warning")
  const radio = emitter('voice.muffled.talk', { x: 12, y: 1.0, z: 31, gain: 0.5, max: 30, lp: 3200, want: () => (W.radioOn ? 1 : 0), tau: 0.1, tauDown: 0.01, cat: 'murmur', prio: 4 });
  W.radioOn = true;
  W.killRadio = () => { W.radioOn = false; radio.cut = true; if (radio.h) { E.stop(radio.h, 0.015); radio.h = 0; } };
  // argument in the cash room until the scream (m08) or until the counter (e13) is alerted
  const e13 = () => ctx.enemies?.list?.find((e) => e.id === 'e13');
  W.argueOn = true;
  const argue = emitter('voice.muffled.argue', { x: 4.5, y: 5.6, z: 4.5, gain: 0.55, max: 28, want: () => (W.argueOn && !e13()?.alerted && !e13()?.dead ? 1 : 0), tau: 0.2, tauDown: 0.05, cat: 'murmur', prio: 4 });
  W.stopArgue = () => { W.argueOn = false; argue.cut = true; if (argue.h) { E.stop(argue.h, 0.03); argue.h = 0; } };
  // gas burner in the lab
  emitter('loop.hiss', { x: 5, y: 1.0, z: 3.5, gain: 0.16, max: 14, lp: 6000, pitch: 0.8, want: () => 1, tau: 0.2 });
  // forklift idling in the yard, mast moves now and then
  const fork = props.find((p) => p.id === 'stapler_hof');
  let forkT = 40;
  if (fork) emitter('loop.forklift.idle', { x: fork.p[0], y: 1, z: fork.p[2], gain: 0.5, max: 40, want: () => 1, tau: 0.5,
    update(e, dt) { forkT -= dt; if (forkT < 0) { forkT = 50 + Math.random() * 50; K.D.playAt('machine.forklift.lift', e.pos.x, 1.5, e.pos.z, 0.7, 1, 0, (o) => { o.dur = 9; o.max = 45; }); } } });
  // fluorescent hum: one emitter that sits on the nearest tube fixture of a lit circuit
  const tubes = (L.fixtures ?? []).filter((f) => f.type === 'tube');
  emitter('loop.fluorescent', {
    gain: 0.55, max: 9, tau: 0.08, tauDown: 0.05,
    update(e) {
      let best = 1e9, bf = null;
      for (const f of tubes) { const d = (f.pos[0] - K.L.x) ** 2 + (f.pos[1] - K.L.y) ** 2 + (f.pos[2] - K.L.z) ** 2; if (d < best) { best = d; bf = f; } }
      if (bf) { e.pos.x = bf.pos[0]; e.pos.y = bf.pos[1]; e.pos.z = bf.pos[2]; e.circuit = bf.circuit; }
    },
    want: (e) => (e.circuit ? clamp01(ctx.world?.lights?.level?.(e.circuit) ?? 1) : 0),
  });
  // sleepers snore until woken
  (L.enemies ?? []).forEach((def, i) => {
    if (def.role !== 'sleeper') return;
    const en = () => ctx.enemies?.list?.[i];
    emitter('voice.snore', { x: def.pos[0], y: def.pos[1] + 0.5, z: def.pos[2], gain: 0.55, max: 18, pitch: V.profiles[i]?.pitch ?? 1, tau: 0.1, tauDown: 0.02, cat: 'murmur', prio: 4,
      update(e) { const p = en()?.pos; if (p) { e.pos.x = p.x; e.pos.y = p.y + 0.5; e.pos.z = p.z; } },
      want: () => (en() && !en().alerted && !en().dead ? 1 : 0) });
  });
  // the yard forklift's driver switches it off when the officer arrives (m01): start/shut-off recording,
  // its shut-off half, then the idle loop is gone — the yard gets noticeably quieter
  W.forkOn = true;
  W.forkOff = () => {
    if (!fork || !W.forkOn) return;
    W.forkOn = false;
    const c = K.bank.sounds.get('machine.forklift.start'), clip = c ? K.bank.clips[c.enabled[0]] : null;
    K.D.playAt('machine.forklift.start', fork.p[0], 1, fork.p[2], 0.8, 1, 0, (o) => { o.offset = clip ? Math.max(0, clip.peakAt - 0.6) : 6.5; o.max = 50; });
    for (const e of W.emitters) if (e.name === 'loop.forklift.idle') { e.tauDown = 0.6; e.want = () => 0; }
  };
  // the office phone rings once, the first time the officer reaches the upper corridor
  const flur = [K.zoneIndex('flur_og'), K.zoneIndex('treppe_w')];
  W.phoneRang = false;
  function tickPhone() {
    if (W.phoneRang || !flur.includes(K.L.zone) || K.L.y < 4.4) return;
    W.phoneRang = true;
    K.D.playAt('machine.phone', 13.5, 5.4, 2.5, 0.75, 1, 1.5, (o) => { o.dur = 7.5; o.max = 60; o.skipLead = true; });
  }
  // unaware guards cough now and then (a tell for the player)
  const coughT = new Float32Array(64).map(() => 15 + Math.random() * 40);
  function tickCoughs(dt) {
    const list = ctx.enemies?.list; if (!list) return;
    for (let i = 0; i < list.length && i < 64; i++) {
      const en = list[i];
      if (en.dead || en.alerted || en.def?.role === 'sleeper') continue;
      coughT[i] -= dt;
      if (coughT[i] > 0) continue;
      coughT[i] = 25 + Math.random() * 45;
      if (Math.hypot(en.pos.x - K.L.x, en.pos.z - K.L.z) < 35) V.speak(i, 'cough', en.pos, 0.8);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // ambience beds (2D stereo loops), gains from the portal solver
  const zcls = K.zoneClasses;            // class per zone index
  const bedZones = new Map();            // bed name → zone indices
  zcls.forEach((cls, zi) => { for (const b of ACOUSTIC[cls]?.bed ?? []) { if (!bedZones.has(b)) bedZones.set(b, []); bedZones.get(b).push(zi); } });
  const BED_GAIN = { 'amb.outside': 0.85, 'amb.outside.birds': 0.7, 'amb.warehouse': 0.8, 'amb.factory': 0.55, 'amb.ventilation': 0.6, 'amb.freezer': 0.8, 'loop.conveyor': 0.9 };
  const autoZones = ['auto_n', 'auto_s', 'buehne', 'roboter', 'akl', 'versand'].map((id) => K.zoneIndex(id)).filter((z) => z >= 0);
  bedZones.set('loop.conveyor', autoZones);
  const fp = { x: 0, y: 0, z: 0 };
  for (const [name, zones] of bedZones) W.beds.push({ name, zones, h: 0, g: 0, lp: 20000, lastG: -1, lastLP: -1, idle: 0 });
  function tickBeds(dt) {
    const sol = E.solver, Lz = K.L.zone;
    if (W.duckT > 0) { W.duckT -= dt; if (W.duckT <= 0) W.duckTarget = 1; }
    W.duck += ((W.duckTarget ?? 1) - W.duck) * Math.min(1, dt * (W.duck > (W.duckTarget ?? 1) ? 6 : 0.5));
    for (const b of W.beds) {
      let g = 0, lp = 20000;
      if (b.name === 'loop.conveyor' && !running(loopRec())) g = 0;
      else if (sol && Lz >= 0) {
        for (const z of b.zones) {
          if (z === Lz) { g = 1; lp = 20000; break; }
          const loss = sol.loss[z];
          if (loss > 40) continue;
          let gz = Math.pow(10, -(loss + 7) / 20);
          const p = sol.firstPortal(z, fp);
          if (p) { const d = Math.hypot(p.x - K.L.x, p.z - K.L.z); gz *= Math.pow(4 / Math.max(4, d), 0.8); }
          if (gz > g) { g = gz; lp = sol.lp[z]; }
        }
      } else if (Lz < 0 && b.name.startsWith('amb.outside')) g = 1;
      g *= (BED_GAIN[b.name] ?? 0.7) * (b.name === 'loop.conveyor' ? 1 : W.duck);
      if (g > 0.015 && !b.h) {
        const o = E.opts(); o.loop = true; o.twoD = true; o.gain = g; o.cat = 'amb'; o.lp = lp; o.fadeIn = 1.5; o.pitchVar = 0;
        b.h = E.play(b.name, o); b.lastG = g; b.idle = 0;
      } else if (b.h) {
        if (g < 0.01) { b.idle += dt; if (b.idle > 2) { E.stop(b.h, 1.0); b.h = 0; } }
        else b.idle = 0;
        if (b.h && Math.abs(g - b.lastG) > 0.008) { E.setBase(b.h, g * K.bankGain(b.name)); b.lastG = g; }
        if (b.h && Math.abs(lp - b.lastLP) > 200) { E.setLP(b.h, lp); b.lastLP = lp; }
        if (b.h && !E.isPlaying(b.h)) b.h = 0;
      }
    }
  }
  /** sudden silence: beds drop to `level` for `dur` seconds, then swell back */
  W.silence = (level = 0.3, dur = 3) => { W.duckTarget = level; W.duckT = dur; };

  let acc = 0;
  W.update = (dt) => {
    W.frame++;
    acc += dt;
    tickSorter(dt);
    if (W.frame % 3) return;          // loops/beds at 20 Hz are plenty
    const d = acc; acc = 0;
    tickEmitters(d);
    tickBeds(d);
    tickCoughs(d);
    tickPhone();
  };
  W.reset = () => {
    W.radioOn = true; W.argueOn = true; W.phoneRang = false;
    if (!W.forkOn) { W.forkOn = true; for (const e of W.emitters) if (e.name === 'loop.forklift.idle') e.want = () => 1; } W.duck = 1; W.duckT = 0; W.duckTarget = 1;
    for (const e of W.emitters) { if (e.h) E.stop(e.h, 0.2); e.h = 0; e.spin = 0; }
    for (const b of W.beds) { if (b.h) E.stop(b.h, 0.3); b.h = 0; }
  };
  W.machineState = (e) => {
    // instant reaction to a state event (the emitters also poll); a stop makes the silence noticeable
    if (e?.kind === 'conveyor' && e.state !== 'running') W.silence(0.5, 2.5);
  };
  return W;
}
