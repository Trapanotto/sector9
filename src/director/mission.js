// Mission flow: objectives (bodycam OSD line), optional evidence spots (stand near + look for a moment), silent
// rules-of-engagement statistics for the debrief, the breachable cash-room door and the single checkpoint.
// Pure logic + ctx hooks (Node-testable). Owner: F.
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createMission(ctx, data, runtime) {
  const space = runtime.space, env = runtime.env;
  const objectives = data.OBJECTIVES.map((o) => ({ ...o, cond: o.done ? space.cond(o.done) : null, done: false }));
  const evidence = data.EVIDENCE.map((e) => ({ ...e, found: false, dwell: 0, look: space.cond(['look', e.pos, 0.72, e.r + 1.5]), r2: e.r * e.r }));
  const breach = new Map(Object.entries(data.BREACH).map(([id, b]) => [id, { ...b, id, tries: 0, last: -99, shots: 0, done: false }]));
  const cp = data.CHECKPOINT;
  const cpCond = space.cond(['zone', cp.zones]);
  const nE = env.enemyIds.length;
  const surr = new Uint8Array(nE);
  const stats = { shots: 0, hits: 0, kills: 0, surrenderedShot: 0, hitsTaken: 0, damage: 0, retries: 0, breaches: 0 };
  const st = { current: -1, objT: 0, snapshot: null, flash: '', flashT: 0, cpTaken: false };
  const objEvt = { id: '', text: '' }, evEvt = { id: '', name: '', found: 0, total: evidence.length }, brEvt = { id: '' };
  const sndPos = { x: 0, y: 0, z: 0 };

  // ---- statistics (events; payloads are reused by the emitters — read, don't keep)
  ctx.events.on('weapon:fire', () => { if (ctx.state === 'playing') stats.shots++; });
  ctx.events.on('hit', (r) => {
    if (r.shooter !== ctx.player || !r.target || r.target.kind === 'player') return;
    stats.hits++;
    const k = space.enemyIndex.get(r.target.id);
    if (k !== undefined && surr[k]) stats.surrenderedShot++;
  });
  ctx.events.on('enemy:death', () => { stats.kills++; });
  ctx.events.on('player:damage', (d) => { stats.hitsTaken++; stats.damage += d.amount ?? 0; });
  // ---- breach (locked door: try twice within the window, or shoot the lock)
  const doBreach = (b) => {
    b.done = true; stats.breaches++;
    const d = ctx.world.doors?.get(b.id);
    if (d) { sndPos.x = d.axis === 'x' ? (d.a + d.b) / 2 : d.at; sndPos.y = d.y0 + 1; sndPos.z = d.axis === 'x' ? d.at : (d.a + d.b) / 2; ctx.audio?.playAt?.('door.kick', sndPos, { volume: 1 }); }
    ctx.world.doors?.set(b.id, 'open', { speed: 3.2 });
    brEvt.id = b.id; ctx.events.emit('f:breach', brEvt);
  };
  ctx.events.on('door:locked', (e) => {
    const b = breach.get(e.id); if (!b || b.done || ctx.state !== 'playing') return;
    const now = ctx.time.mission;
    b.tries = now - b.last <= b.window ? b.tries + 1 : 1; b.last = now;
    if (b.tries >= b.kicks) doBreach(b);
    else { const d = e.door; sndPos.x = d.axis === 'x' ? (d.a + d.b) / 2 : d.at; sndPos.y = d.y0 + 1; sndPos.z = d.axis === 'x' ? d.at : (d.a + d.b) / 2; ctx.audio?.playAt?.(b.rattle, sndPos, { volume: 0.7 }); }
  });
  ctx.events.on('shot', (r) => {
    if (r.kind !== 'door' || r.shooter !== ctx.player) return;
    const b = breach.get(r.id); if (!b || b.done) return;
    if (++b.shots >= b.lockShots) doBreach(b);
  });

  function objectiveText(i) {
    const o = objectives[i]; if (!o) return '';
    if (o.count === 'evidence') return `${o.text} ${foundCount()}/${evidence.length}`;
    return o.text;
  }
  function foundCount() { let n = 0; for (let i = 0; i < evidence.length; i++) if (evidence[i].found) n++; return n; }
  function updateObjectives(dt) {
    st.objT -= dt;
    if (st.objT > 0) return;
    st.objT = 0.5;
    let cur = -1;
    for (let i = 0; i < objectives.length; i++) {
      const o = objectives[i];
      if (!o.done && o.cond && space.evaluate(o.cond)) o.done = true;
      if (!o.done && cur < 0) cur = i;
    }
    if (cur < 0) cur = objectives.length - 1;
    if (cur !== st.current) { st.current = cur; objEvt.id = objectives[cur].id; objEvt.text = objectiveText(cur); ctx.events.emit('f:objective', objEvt); }
  }
  function updateEvidence(dt) {
    const P = ctx.player.pos;
    for (let i = 0; i < evidence.length; i++) {
      const e = evidence[i];
      if (e.found) continue;
      const dx = e.pos[0] - P.x, dy = e.pos[1] - (P.y + 1), dz = e.pos[2] - P.z;
      if (dx * dx + dy * dy * 2 + dz * dz > e.r2 || !space.evaluate(e.look)) { e.dwell = Math.max(0, e.dwell - dt * 2); continue; }
      e.dwell += dt;
      if (e.dwell >= e.dwellTime) {
        e.found = true;
        st.flash = `DOKUMENTIERT · ${e.name}`; st.flashT = 3.2;
        evEvt.id = e.id; evEvt.name = e.name; evEvt.found = foundCount(); ctx.events.emit('f:evidence', evEvt);
        if (objectives[st.current]?.count === 'evidence') { objEvt.id = objectives[st.current].id; objEvt.text = objectiveText(st.current); ctx.events.emit('f:objective', objEvt); }
      }
    }
  }
  function updateCheckpoint() {
    if (st.cpTaken || ctx.player.dead) return;
    if (!env.momentDone(cp.after) || !space.evaluate(cpCond)) return;
    st.cpTaken = true;
    const P = ctx.player;
    st.snapshot = {
      pos: [P.pos.x, P.pos.y, P.pos.z], yaw: P.yaw, time: ctx.time.mission,
      dead: (ctx.enemies?.list ?? []).filter((e) => e.dead).map((e) => e.id),
      done: runtime.moments.filter((m) => m.state === 2 || m.state === 3).map((m) => m.id),
      variants: runtime.moments.filter((m) => m.state === 2 || m.state === 3).map((m) => m.v),
      evidence: evidence.filter((e) => e.found).map((e) => e.id),
      objectives: objectives.filter((o) => o.done).map((o) => o.id),
      breach: [...breach.values()].filter((b) => b.done).map((b) => b.id),
      stats: { ...stats },
    };
    ctx.events.emit('f:checkpoint', { name: cp.name });
  }

  return {
    objectives, evidence, stats, st, breach,
    get objective() { return objectiveText(st.current); },
    get checkpoint() { return st.snapshot; },
    foundCount,
    breached: (id) => breach.get(id)?.done ?? false,
    reset(keepCheckpoint = false) {
      for (const o of objectives) o.done = false;
      for (const e of evidence) { e.found = false; e.dwell = 0; }
      for (const b of breach.values()) { b.tries = 0; b.last = -99; b.shots = 0; b.done = false; }
      for (const k in stats) stats[k] = 0;
      surr.fill(0);
      st.current = -1; st.objT = 0; st.flash = ''; st.flashT = 0;
      if (!keepCheckpoint) { st.snapshot = null; st.cpTaken = false; }
    },
    /** apply a checkpoint snapshot after a full reset (enemies/moments are restored by the director) */
    restore(s) {
      for (const o of objectives) o.done = s.objectives.includes(o.id);
      for (const e of evidence) e.found = s.evidence.includes(e.id);
      for (const b of breach.values()) if (s.breach.includes(b.id)) { b.done = true; ctx.world.doors?.set(b.id, 'open', { instant: true }); }
      Object.assign(stats, s.stats); stats.retries = s.stats.retries + 1; s.stats.retries = stats.retries;
      st.cpTaken = true; st.snapshot = s;
    },
    update(dt) {
      for (let k = 0; k < nE; k++) { const e = env.enemy(k); surr[k] = e && !e.dead && e.surrendered ? 1 : 0; }
      updateObjectives(dt);
      updateEvidence(dt);
      updateCheckpoint();
      if (st.flashT > 0) { st.flashT -= dt; if (st.flashT <= 0) st.flash = ''; }
    },
    /** sober debrief: title + 6 figures */
    debrief(reachedVan) {
      const list = ctx.enemies?.list ?? [];
      let down = 0, arrested = 0;
      for (const e of list) { if (e.dead) down++; else if (e.surrendered || e.arrested) arrested++; }
      const acc = stats.shots ? Math.round(100 * stats.hits / stats.shots) : 0;
      const early = reachedVan && !objectives.find((o) => o.id === data.EARLY_EXIT_UNLESS)?.done;
      return {
        title: !reachedVan ? 'Einsatz abgebrochen' : early ? 'Einsatz abgebrochen' : 'Einsatz beendet',
        sub: early ? 'Objekt verlassen, bevor die Lage geklärt war.' : '',
        rows: [
          ['Einsatzzeit', fmtTime(ctx.time.mission)],
          ['Tatverdächtige', `${down} von ${list.length} ausgeschaltet${arrested ? ` · ${arrested} gestellt` : ''}`],
          ['Schussabgabe', stats.shots ? `${stats.shots} Schuss · ${acc} % Treffer` : 'keine'],
          ['Beweise', `${foundCount()} von ${evidence.length} dokumentiert`],
          ['Einsatzregeln', stats.surrenderedShot ? `${stats.surrenderedShot}× auf Aufgebende geschossen` : 'eingehalten'],
          ['Neustarts', stats.retries ? `${stats.retries} ab ${cp.name}` : 'keine'],
        ],
      };
    },
  };
}
