// Boot, shared ctx, module registry and the main loop. Owner: core.
//
// Module factory contract (every workstream):  export function createX(ctx) → {
//   id, order,                      // update order (ORDER below)
//   load?(loader): Promise          // fetch/build assets; runs during the loading screen
//   init?(): void                   // after every module loaded (cross-module wiring), before shader warm-up
//   update?(dt): void               // every frame (check ctx.state yourself)
//   reset?(): void                  // mission restart (die-and-retry)
// }
import { LAYOUT } from '../world/layout/index.js';
import { createEvents } from './events.js';
import { createSettings } from './settings.js';
import { createInput } from './input.js';
import { createLoader } from './loader.js';
import { createPerf } from './perf.js';
import { createCombat } from './combat.js';
import { createLod } from './lod.js';
import { createDevtools } from './devtools.js';
import { webgl2Available, showMessage, hideMessage, MSG } from './errors.js';
import { createPipeline } from '../render/pipeline.js';
import { createQuality } from '../render/quality.js';
import { createExposure } from '../render/exposure.js';
import { createWorld } from '../world/world.js';
// workstream modules (stubs until the owners replace them — same factory names and files)
import { createMachines } from '../world/machines.js';   // A
import { createPlayer } from '../player/player.js';       // C
import { createWeapon } from '../player/weapon.js';       // C
import { createFx } from '../fx/fx.js';                   // C
import { createEnemies } from '../enemies/enemies.js';    // D
import { createAudio } from '../audio/audio.js';          // E
import { createDirector } from '../director/director.js'; // F

export const ORDER = { director: 10, player: 20, weapon: 30, enemies: 40, machines: 50, world: 60, fx: 70, audio: 80, exposure: 90 };
// game states: 'boot' → 'loading' → 'menu' ⇄ 'playing' ⇄ 'paused'; 'playing' → 'dead' | 'done' → 'menu' / restart
export const STATES = ['boot', 'loading', 'menu', 'playing', 'paused', 'dead', 'done'];

export async function boot() {
  const t0 = performance.now();
  const app = document.getElementById('app');
  const canvas = document.createElement('canvas');
  canvas.id = 'view';
  app.appendChild(canvas);
  if (!webgl2Available()) { showMessage(...MSG.noWebgl2); return null; }

  const events = createEvents();
  const settings = createSettings();
  const ctx = {
    layout: LAYOUT, events, settings, ORDER,
    time: { now: 0, dt: 0, frame: 0, mission: 0 },
    state: 'boot', debug: { allZones: false }, bench: false,
    timings: {},
  };
  ctx.setState = (to) => {
    const from = ctx.state;
    if (from === to) return;
    ctx.state = to;
    events.emit('state', { from, to });
  };
  window.__ctx = ctx;

  ctx.input = createInput(canvas, settings);
  try { ctx.render = createPipeline(ctx, canvas); } catch (e) { showMessage(...MSG.noWebgl2); console.error(e); return null; }
  ctx.quality = createQuality(ctx, ctx.render.gl);
  ctx.perf = createPerf(ctx);
  ctx.combat = createCombat(ctx);
  ctx.lod = createLod(ctx);
  ctx.exposure = createExposure(ctx);
  ctx.dev = createDevtools(ctx);

  const modules = [];
  const add = (m) => { modules.push(m); return m; };
  ctx.world = add(createWorld(ctx));
  ctx.director = add(createDirector(ctx));     // first: shows the loading screen
  ctx.machines = add(createMachines(ctx));
  ctx.player = add(createPlayer(ctx));
  ctx.weapon = add(createWeapon(ctx));
  ctx.fx = add(createFx(ctx));
  ctx.enemies = add(createEnemies(ctx));
  ctx.audio = add(createAudio(ctx));
  modules.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  ctx.modules = modules;

  // ---- loading
  ctx.setState('loading');
  const loader = createLoader(events);
  try {
    // world first (others need ctx.world), then the rest in parallel
    await ctx.world.load(loader);
    ctx.timings.world = performance.now() - t0;
    await Promise.all(modules.filter((m) => m !== ctx.world && m.load).map((m) => m.load(loader)));
    for (const m of modules) m.init?.();
    ctx.timings.modules = performance.now() - t0;
    ctx.timings.warmup = await ctx.render.warmup();
  } catch (e) {
    console.error(e);
    showMessage(MSG.loadFailed[0], MSG.loadFailed[1] + (e.message ?? e), { button: 'Neu laden' });
    return ctx;
  }
  ctx.timings.toMenu = performance.now() - t0;
  console.info(`[boot] menu after ${ctx.timings.toMenu.toFixed(0)} ms (world ${ctx.timings.world.toFixed(0)}, modules ${ctx.timings.modules.toFixed(0)}, warm-up ${ctx.timings.warmup.toFixed(0)})`);
  ctx.setState('menu');

  // ---- context loss
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); lost = true;
    showMessage(...MSG.contextLost);
    setTimeout(() => { if (lost) showMessage(...MSG.contextGone, { button: 'Neu laden' }); }, 6000);
  });
  canvas.addEventListener('webglcontextrestored', async () => {
    lost = false;
    try { await ctx.render.warmup(); hideMessage(); } catch { showMessage(...MSG.contextGone, { button: 'Neu laden' }); }
  });

  // ---- main loop
  let last = performance.now();
  const syncPx = new Uint8Array(4);
  const frame = (tms) => {
    requestAnimationFrame(frame);
    if (lost) return;
    const ms = Math.max(0.1, tms - last); last = tms;
    const dt = Math.min(0.1, ms / 1000);
    const T = ctx.time;
    T.dt = dt; T.now += dt; T.frame++;
    if (ctx.state === 'playing') T.mission += dt;
    ctx.perf.frame(ms);
    if (ctx.state === 'playing') ctx.quality.update(ms);
    ctx.perf.update();
    const c0 = performance.now();
    for (let i = 0; i < modules.length; i++) modules[i].update?.(dt);
    ctx.exposure.update(dt);
    ctx.render.render();
    ctx.input.endFrame();
    ctx.perf.cpu(performance.now() - c0);   // main-thread time for update + render submission
    if (ctx.benchSync) {
      // benchmark only: wait for the GPU (1-pixel read-back) → full frame cost incl. GPU, not vsync-limited
      const gl = ctx.render.gl;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPx);
      ctx.perf.sync(performance.now() - c0);
    }
  };
  requestAnimationFrame(frame);

  /** full mission restart (die-and-retry) */
  ctx.restart = () => {
    ctx.time.mission = 0;
    for (const m of modules) m.reset?.();
    events.emit('mission:restart', {});
  };
  return ctx;
}
