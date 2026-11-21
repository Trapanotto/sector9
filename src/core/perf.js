// Perf HUD (toggle: F9 or ^/Backquote; settings key "perf") + benchmark runner over LAYOUT.benchViews.
// Shows fps, frame ms median/p95, draw calls, triangles, textures, est. texture MB, internal resolution, tier,
// zone, visible zones. window.__bench.run({ tiers: ['vlow','high'] }) → Promise<results> (also console.table).
// Owner: core.
import { BUDGETS } from './budgets.js';

export function createPerf(ctx) {
  const N = 240;
  const ring = new Float32Array(N), sorted = new Float32Array(N), cring = new Float32Array(N), sring = new Float32Array(N);
  let n = 0, last = 0;
  const el = document.createElement('div');
  el.id = 'perf';
  el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:50;font:12px/1.35 Consolas,monospace;color:#cfe;background:rgba(0,0,0,.62);padding:6px 8px;white-space:pre;pointer-events:none;display:none;border-radius:3px';
  document.body.appendChild(el);
  let visible = !!ctx.settings.data.showPerf;
  el.style.display = visible ? 'block' : 'none';

  const perf = {
    el,
    get visible() { return visible; },
    toggle(v = !visible) { visible = v; el.style.display = v ? 'block' : 'none'; ctx.settings.data.showPerf = v; ctx.settings.save(); },
    /** frame interval (ms) of the last frame */
    lastMs: 16.7,
    cpu(ms) { cring[(n - 1 + N) % N] = ms; },
    sync(ms) { sring[(n - 1 + N) % N] = ms; },
    frame(ms) {
      perf.lastMs = ms;
      ring[n++ % N] = ms;
    },
    stats() {
      const m = Math.min(n, N);
      if (!m) return { med: 0, p95: 0, fps: 0 };
      sorted.set(ring);
      const s = sorted.subarray(0, m); s.sort();
      const med = s[Math.floor(m * 0.5)], p95 = s[Math.min(m - 1, Math.floor(m * 0.95))];
      sorted.set(cring); const c = sorted.subarray(0, m); c.sort();
      const cpu = c[Math.floor(m * 0.5)], cpu95 = c[Math.min(m - 1, Math.floor(m * 0.95))];
      sorted.set(sring); const g = sorted.subarray(0, m); g.sort();
      return { med, p95, fps: 1000 / med, cpu, cpu95, sync: g[Math.floor(m * 0.5)], sync95: g[Math.min(m - 1, Math.floor(m * 0.95))] };
    },
    reset() { n = 0; },
    update() {
      if (ctx.input.hit('perf')) perf.toggle();
      if (!visible || ctx.time.frame - last < 15) return;
      last = ctx.time.frame;
      const s = perf.stats(), r = ctx.render, st = r.stats, res = r.resolution, q = ctx.quality, w = ctx.world;
      const B = BUDGETS.frame;
      const flag = (v, b) => (v > b ? ' !' : '');
      const z = w?.gen?.zones[w.cameraZone];
      const p = r.camera.position;
      el.textContent =
        `${s.fps.toFixed(0)} fps  ${s.med.toFixed(1)} ms med  ${s.p95.toFixed(1)} p95\n` +
        `draw ${st.calls}${flag(st.calls, B.drawCalls)}  tris ${(st.triangles / 1000).toFixed(1)}k${flag(st.triangles, B.triangles)}  passes ${st.passes}\n` +
        `tex ${st.textures}  ~${st.textureMB.toFixed(1)} MB${flag(st.textureMB, B.textureMB)}  geo ${(w?.geometryMB ?? 0).toFixed(1)} MB\n` +
        `res ${res.internal.w}x${res.internal.h} → ${res.out.w}x${res.out.h} (${(q.scale * 100).toFixed(0)}%)\n` +
        `tier ${q.tier.name}${q.mode === 'auto' ? ' (auto)' : ''}  ${r.hdr ? 'HDR' : 'LDR'}\n` +
        `zone ${z?.name ?? '-'}  sichtbar ${w?.visibleZoneCount ?? 0}/${w?.gen?.zones.length ?? 0}\n` +
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  exp ${ctx.exposure.value.toFixed(2)}\n` +
        `gpu ${q.gpu.renderer.slice(0, 46)}` + (w?.bakeWarning ? `\n${w.bakeWarning}` : '');
    },
  };

  // ---- benchmark over the layout's heaviest views
  const wait = (frames) => new Promise((res) => { const f0 = ctx.time.frame; const tick = () => (ctx.time.frame - f0 >= frames ? res() : requestAnimationFrame(tick)); tick(); });
  window.__bench = {
    /** sync: wait for the GPU every frame (frame cost incl. GPU, independent of vsync) */
    async run({ tiers = [ctx.quality.tier.id], frames = 120, settle = 45, views = ctx.layout.benchViews, sync = true } = {}) {
      ctx.benchSync = sync;
      const results = [];
      const prevMode = ctx.quality.mode;
      ctx.bench = true;
      for (const tier of tiers) {
        ctx.quality.setMode(tier);
        for (const v of views) {
          ctx.player.teleport(v.pos, v.yaw, v.pitch ?? 0, true);
          await wait(settle);
          perf.reset();
          let calls = 0, tris = 0, maxCalls = 0, maxTris = 0;
          const f0 = ctx.time.frame;
          await new Promise((res) => {
            const tick = () => {
              calls += ctx.render.stats.calls; tris += ctx.render.stats.triangles;
              maxCalls = Math.max(maxCalls, ctx.render.stats.calls); maxTris = Math.max(maxTris, ctx.render.stats.triangles);
              if (ctx.time.frame - f0 >= frames) res(); else requestAnimationFrame(tick);
            };
            tick();
          });
          const s = perf.stats(), k = ctx.time.frame - f0;
          const res = ctx.render.resolution.internal;
          results.push({
            tier, view: v.id, med: +s.med.toFixed(2), p95: +s.p95.toFixed(2), cpu: +s.cpu.toFixed(2), cpu95: +s.cpu95.toFixed(2), sync: +s.sync.toFixed(2), sync95: +s.sync95.toFixed(2), calls: maxCalls, tris: maxTris,
            avgCalls: Math.round(calls / k), avgTris: Math.round(tris / k), res: `${res.w}x${res.h}`, zones: ctx.world.visibleZoneCount,
          });
        }
      }
      ctx.bench = false; ctx.benchSync = false;
      ctx.quality.setMode(prevMode);
      console.table(results);
      window.__benchResults = results;
      return results;
    },
  };
  return perf;
}
