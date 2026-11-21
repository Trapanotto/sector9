// Automation helpers (window.__ctx.dev). Owner: core. Used by agents/tests to walk the level through the REAL
// player controller (virtual key presses + yaw steering along nav paths), since pointer lock and real input are
// unavailable to automation. Set window.__fakeLock = true first.
//   await __ctx.dev.autopilot([[x,y,z], ...], { timeout: 120 }) → { ok, reached, legs: [...], stuck }
//   __ctx.dev.tour  — a waypoint list through every area of the level (spawn → extraction)
export function createDevtools(ctx) {
  const path = new Int32Array(4096);
  const dev = {
    tour: [
      [12, 0, 66], [12, 0, 60], [13.3, 0, 40.3], [6, -3.7, 48], [20, -3.7, 47.6], [29.6, 0, 55.5], [47, 0, 28.5],
      [27, 0, 29.6], [12, 0, 25], [25.2, 0, 14], [25.2, 4.5, 14.5], [23.5, 4.5, 4], [40, 4.5, 0.8], [78, 4.5, 3],
      [83, 0, 14], [73, 0, 30], [80, 0, 58], [76.6, 0, 3], [77, 0, -8],
    ],
    /** walk through waypoints with the real controller; opens closed doors on the way like a player would */
    async autopilot(points, { timeout = 180, speedKey = null } = {}) {
      const nav = ctx.world.nav, P = ctx.player, inp = ctx.input;
      const legs = [];
      const t0 = ctx.time.now;
      for (const w of points) {
        const a = nav.nearest(P.pos.x, P.pos.y + 0.1, P.pos.z), b = nav.nearest(w[0], w[1] + 0.1, w[2]);
        const n = nav.findPath(a, b, path, 200000);
        if (!n) { legs.push({ to: w, ok: false, reason: 'no path' }); return { ok: false, legs, stuck: [P.pos.x, P.pos.y, P.pos.z] }; }
        const nodes = Array.from(path.subarray(0, n)).reverse();
        let i = 0, lastProgress = ctx.time.now, best = -1;
        inp.inject('KeyW', true); if (speedKey) inp.inject(speedKey, true);
        const ok = await new Promise((res) => {
          const tick = () => {
            if (ctx.time.now - t0 > timeout) return res(false);
            if (ctx.state === 'done') return res(true);   // reached the extraction trigger
            // look ahead: skip nodes we're already close to
            while (i < nodes.length - 1 && Math.hypot(nav.nodeX(nodes[i]) - P.pos.x, nav.nodeZ(nodes[i]) - P.pos.z) < 0.35 && Math.abs(nav.nodeY[nodes[i]] - P.pos.y) < 0.3) i++;
            const k = nodes[i];
            const tx = nav.nodeX(k), tz = nav.nodeZ(k);
            const d = Math.hypot(tx - P.pos.x, tz - P.pos.z);
            const door = nav.nodeDoor[k];
            if (door >= 0) { const dr = ctx.world.doors.list[door]; if (dr.target < 0.5 && dr.state !== 'locked') ctx.world.doors.set(dr.id, 'open'); }
            P.yaw = Math.atan2(-(tx - P.pos.x), -(tz - P.pos.z)); P.pitch = 0;
            const dg = Math.hypot(w[0] - P.pos.x, w[2] - P.pos.z);
            // progress = advancing along the path (paths may lead away from the goal first)
            if (i > best || d < 0.2) { best = Math.max(best, i); lastProgress = ctx.time.now; }
            if (dg < 0.7 && Math.abs(P.pos.y - w[1]) < 0.8) return res(true);
            if (ctx.time.now - lastProgress > 6) return res(false);
            requestAnimationFrame(tick);
          };
          tick();
        });
        legs.push({ to: w, ok, at: [+P.pos.x.toFixed(2), +P.pos.y.toFixed(2), +P.pos.z.toFixed(2)], t: +(ctx.time.now - t0).toFixed(1) });
        if (!ok) { inp.inject('KeyW', false); if (speedKey) inp.inject(speedKey, false); return { ok: false, legs, stuck: legs.at(-1).at }; }
      }
      inp.inject('KeyW', false); if (speedKey) inp.inject(speedKey, false);
      return { ok: true, legs, seconds: ctx.time.now - t0 };
    },
  };
  return dev;
}
