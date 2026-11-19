// Dev / test only (not imported by the game): an automated player that walks the nav graph, hunts the hostiles
// with human-like aim error and reaction delay, then goes to extraction, logging anomalies on the way.
//   const bot = await import('/src/player/bot.js'); const r = await bot.run({ minutes: 8, invulnerable: true });
// Anomalies: stuck (> 3 s without progress while walking), fell (feet > 1 m below the floor), NaN position,
// enemy stuck (alive, not idle, no movement for 15 s), slow frames (> 50 ms), console errors.

const ctx = () => window.__ctx;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));

function astar(nodes, adj, s, g) {
  const n = nodes.length, gs = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  gs[s] = 0;
  const open = [s];
  const h = (i) => nodes[i].distanceTo(nodes[g]);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (gs[open[i]] + h(open[i]) < gs[open[bi]] + h(open[bi])) bi = i;
    const c = open.splice(bi, 1)[0];
    if (c === g) break;
    if (done[c]) continue;
    done[c] = 1;
    for (const o of adj[c]) {
      const d = gs[c] + nodes[c].distanceTo(nodes[o]);
      if (d < gs[o]) { gs[o] = d; prev[o] = c; open.push(o); }
    }
  }
  if (prev[g] < 0 && s !== g) return null;
  const path = [];
  for (let c = g; c >= 0; c = prev[c]) path.unshift(c);
  return path;
}

export async function run(opts = {}) {
  const c = ctx();
  const minutes = opts.minutes ?? 8;
  const log = [], events = { stuck: 0, fell: 0, nan: 0, enemyStuck: 0, slow: 0, shots: 0, hitsTaken: 0, kills: 0 };
  const note = (type, data) => { log.push({ t: +(performance.now() / 1000).toFixed(1), type, ...data }); };
  const origErr = console.error;
  console.error = (...a) => { note('console.error', { msg: String(a[0]).slice(0, 160) }); origErr.apply(console, a); };
  window.__fakeLock = true;
  if (c.game.state === 'menu') [...document.querySelectorAll('button')].find((b) => /einsatz beginnen/i.test(b.textContent))?.click();
  await sleep(500);
  if (opts.invulnerable) { const td = c.player.takeDamage; c.player.takeDamage = (...a) => { events.hitsTaken++; }; c.player.__td = td; }
  else { const td = c.player.takeDamage.bind(c.player); c.player.takeDamage = (...a) => { events.hitsTaken++; return td(...a); }; }
  const { nodes, edges } = c.level.navGraph;
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const nearestNode = (p) => { let bi = 0, bd = Infinity; for (let i = 0; i < nodes.length; i++) { const d = nodes[i].distanceToSquared(p) + (Math.abs(nodes[i].y - p.y) > 1.5 ? 100 : 0); if (d < bd) { bd = d; bi = i; } } return bi; };
  const P = c.player, m = c.input.mouse;
  const ex = c.level.extraction, exC = ex.getCenter(new P.position.constructor());
  let path = null, pi = 0, goal = null, goalKind = '';
  let lastProg = P.position.clone(), progT = performance.now();
  let target = null, reactAt = 0, aimErr = [0, 0];
  const enemyLast = new Map();
  const t0 = performance.now();
  let lastFrame = performance.now();
  let frames = 0;
  const rafSpy = () => { const t = performance.now(); const d = t - lastFrame; lastFrame = t; frames++; if (d > 50 && !document.hidden && frames > 30) { events.slow++; if (events.slow < 30) note('slowFrame', { ms: +d.toFixed(0), pos: P.position.toArray().map((v) => +v.toFixed(1)) }); } if (running) requestAnimationFrame(rafSpy); };
  let running = true;
  requestAnimationFrame(rafSpy);
  const yawTo = (p) => Math.atan2(-(p.x - P.eye.x), -(p.z - P.eye.z));
  const pitchTo = (p) => Math.atan2(p.y - P.eye.y, Math.hypot(p.x - P.eye.x, p.z - P.eye.z));
  try {
    while (performance.now() - t0 < minutes * 60000) {
      await sleep(50);
      if (c.game.state === 'complete') { note('complete', { time: +((performance.now() - t0) / 1000).toFixed(0) }); break; }
      if (c.game.state === 'dead') { note('died', { pos: P.position.toArray().map((v) => +v.toFixed(1)) }); break; }
      if (c.game.state !== 'playing') continue;
      const pos = P.position;
      if (![pos.x, pos.y, pos.z].every(Number.isFinite)) { events.nan++; note('nan', {}); break; }
      const floor = c.level.groundHeight(pos.x, pos.z, pos.y + 0.5);
      if (pos.y < floor - 1) { events.fell++; note('fell', { pos: pos.toArray().map((v) => +v.toFixed(1)), floor }); P.position.y = floor; }
      // enemies: stuck check
      for (const e of c.enemies.list) {
        if (!e.alive) continue;
        const r = enemyLast.get(e) || { p: e.position.clone(), t: performance.now() };
        if (e.position.distanceTo(r.p) > 0.4 || e.state === 'idle' || e.asleep) { r.p.copy(e.position); r.t = performance.now(); }
        else if (performance.now() - r.t > 15000 && !r.reported) { r.reported = true; events.enemyStuck++; note('enemyStuck', { state: e.state, pos: e.position.toArray().map((v) => +v.toFixed(1)) }); }
        enemyLast.set(e, r);
      }
      // combat: nearest visible enemy within 45 m
      let vis = null, vd = Infinity;
      for (const e of c.enemies.list) {
        if (!e.alive) continue;
        const d = e.position.distanceTo(pos);
        if (d > 45 || d > vd) continue;
        const aimP = e.hit?.torso ? e.hit.torso.a.clone().lerp(e.hit.torso.b, 0.6) : e.eye;
        if (c.combat.lineOfSight(P.eye, aimP)) { vis = e; vd = d; }
      }
      if (vis !== target) { target = vis; reactAt = performance.now() + 250 + Math.random() * 250; aimErr = [(Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04]; }
      if (target && performance.now() > reactAt) {
        key('KeyW', false);
        const aimP = (target.hit?.torso ? target.hit.torso.a.clone().lerp(target.hit.torso.b, 0.6) : target.eye).clone();
        aimErr[0] *= 0.85; aimErr[1] *= 0.85;
        P.setLook(yawTo(aimP) + aimErr[0], pitchTo(aimP) + aimErr[1]);
        m.right = true;
        if (Math.random() < 0.35) { m.leftPressed = true; m.leftClicks = 1; m.left = true; events.shots++; setTimeout(() => { m.left = false; }, 30); }
        if (P.ammo === 0 || (P.ammo < 4 && Math.random() < 0.02)) { key('KeyR', true); setTimeout(() => key('KeyR', false), 60); }
        progT = performance.now();
        continue;
      }
      m.right = false;
      // navigation goal: nearest alive enemy, then extraction
      const alive = c.enemies.list.filter((e) => e.alive);
      let want, kind;
      if (alive.length) { want = alive.reduce((a, e) => (e.position.distanceTo(pos) < a.position.distanceTo(pos) ? e : a)).position; kind = 'enemy'; }
      else { want = exC; kind = 'extraction'; }
      if (!goal || goal.distanceTo(want) > 2 || !path || pi >= path.length) {
        goal = want.clone(); goalKind = kind;
        path = astar(nodes, adj, nearestNode(pos), nearestNode(goal));
        pi = 0;
        if (!path) { note('noPath', { from: pos.toArray().map((v) => +v.toFixed(1)), to: goal.toArray().map((v) => +v.toFixed(1)), kind }); if (kind === 'extraction') break; await sleep(500); continue; }
      }
      let wp = path[pi] !== undefined ? nodes[path[pi]] : goal;
      while (pi < path.length - 1 && Math.hypot(wp.x - pos.x, wp.z - pos.z) < 0.7) { pi++; wp = nodes[path[pi]]; }
      if (pi >= path.length - 1 && Math.hypot(goal.x - pos.x, goal.z - pos.z) < 1.2 && kind === 'extraction') { key('KeyW', true); }
      P.setLook(Math.atan2(-(wp.x - pos.x), -(wp.z - pos.z)), 0);
      key('KeyW', true);
      if (pos.distanceTo(lastProg) > 0.6) { lastProg.copy(pos); progT = performance.now(); }
      else if (performance.now() - progT > 3000) {
        events.stuck++; note('stuck', { pos: pos.toArray().map((v) => +v.toFixed(2)), wp: wp.toArray().map((v) => +v.toFixed(1)), kind: goalKind });
        // unstick: back off, sidestep, re-plan
        key('KeyW', false); key('KeyS', true); await sleep(400); key('KeyS', false); key('KeyA', true); await sleep(300); key('KeyA', false);
        path = null; progT = performance.now();
        if (events.stuck > 25) break;
      }
    }
  } finally {
    running = false;
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) key(k, false);
    m.right = false;
    console.error = origErr;
  }
  events.kills = c.enemies.list.filter((e) => !e.alive).length;
  events.alive = c.enemies.aliveCount;
  events.state = c.game.state;
  events.seconds = +((performance.now() - t0) / 1000).toFixed(0);
  return { events, log: log.slice(0, 80) };
}
