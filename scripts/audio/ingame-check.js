// Body for `node scripts/browser-check.mjs script --url http://localhost:5196/ --jsfile scripts/audio/ingame-check.js
//   --flags "--autoplay-policy=no-user-gesture-required"` — the real game with the real audio module: unlock,
// play, walk the yard, a staged firefight with 8 enemies through the real events, then report audio stats and the
// audio module's main-thread ms per frame (moving average and max) measured inside ctx.audio.update.
// `c` = window.__ctx (provided by browser-check).
const A = c.audio;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.__fakeLock = true;
A.unlock();
c.setState('playing');
await wait(1500);
const s0 = A.stats();
// staged firefight: 8 enemies near the player fire through the contract events (real combat → 'shot' too)
const P = c.player;
const F = c.enemies.list.slice(0, 8);
F.forEach((e, k) => { e.alerted = true; e.pos.set(P.pos.x - 6 + k * 1.7, P.pos.y, P.pos.z - 14); });
let n = 0;
A.frameMsMax = 0;
const f0 = c.time.frame;
const iv = setInterval(() => {
  const e = F[n++ % 8];
  const o = { x: e.pos.x, y: e.pos.y + 1.4, z: e.pos.z };
  const dx = P.eye.x - o.x + (Math.random() - 0.5) * 2, dy = P.eye.y - o.y, dz = P.eye.z - o.z, l = Math.hypot(dx, dy, dz);
  c.combat.fire({ origin: o, dir: { x: dx / l, y: dy / l, z: dz / l }, range: 60, damage: 0, shooter: e, team: 'gang' });
  c.events.emit('enemy:fire', { id: e.id, enemy: e });
}, 70);
await wait(6000);
clearInterval(iv);
const frames = c.time.frame - f0;
await wait(500);
return { before: s0, after: A.stats(), frames, audioFrameMsAvg: +A.frameMs.toFixed(3), audioFrameMsMax: +A.frameMsMax.toFixed(2), ctxState: A.engine?.ac?.state, log: A.log.slice(-12) };
