// Director (workstream F): game-state flow, staged moments, pacing, mission flow and the German UI.
//   runtime.js  data-driven moment timelines (moments.js)      pacing.js  tension tracker, ambient events, masking
//   mission.js  objectives, evidence, ROE stats, checkpoint    ../ui/ui.js  DOM screens + OSD extras
// Debug (console):  __ctx.director.debug()  lists moment states · __ctx.director.fire('m05_halle_dunkel', 'laeufer')
//   __ctx.director.status() · __ctx.director.setSeed(42) (next mission start) · ?seed=42 in the URL
import * as DATA from '../world/layout/moments.js';
import { createRuntime } from './runtime.js';
import { createPacing } from './pacing.js';
import { createMission } from './mission.js';
import { hash32 } from './rng.js';
import { createUI } from '../ui/ui.js';

// defaults for the settings this UI adds (core's settings.js keeps quality/sensitivity/volume/bindings)
const SETTING_DEFAULTS = { freeAim: 'standard', crouchMode: 'toggle', aimMode: 'hold', sprintMode: 'hold', volumeSfx: 1, volumeVoice: 1, pixelateFaces: true };
const DEATH_LINES = ['Einsatz gescheitert.', 'Getroffen. Einsatz gescheitert.', 'Kein Funkkontakt mehr zu S9-17.'];

export function createDirector(ctx) {
  const s = ctx.settings.data;
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) if (s[k] === undefined) s[k] = v;

  const d = { id: 'director', order: ctx.ORDER.director };
  let baseSeed = (() => {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('seed') : null;
    return q !== null && q !== '' ? (+q >>> 0) : ((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
  })();
  let runIndex = 0, pendingSnap = null, toMenu = false, lockBusy = false;
  const settingEvt = { key: '', value: null };

  let mission = null;   // created right after the runtime (which needs these hooks first)
  const runtime = createRuntime(ctx, DATA, {
    evidenceCount: () => mission?.foundCount() ?? 0,
    breached: (id) => mission?.breached(id) ?? false,
    log: (id, what) => { if (d.verbose) console.info(`[director] ${ctx.time.mission.toFixed(1)}s ${id}: ${what}`); },
    alarm: (on) => ctx.events.emit('f:alarm', { on }),
  });
  mission = createMission(ctx, DATA, runtime);
  const pacing = createPacing(ctx, DATA, runtime);
  if (runtime.compileErrors.length) console.warn('[director] moment data problems:', runtime.compileErrors);

  // ------------------------------------------------------------------------------------------------ flow
  // per-run seed: a new run re-rolls every variant; a checkpoint retry re-rolls the moments still ahead
  const runSeed = () => hash32(`run${runIndex}:${pendingSnap ? pendingSnap.stats.retries + 1 : 0}`, baseSeed);
  function restart({ snapshot = null, menu = false } = {}) {
    pendingSnap = snapshot; toMenu = menu;
    if (!snapshot && !menu) runIndex++;
    ctx.restart();               // every module's reset() (mine first) → 'mission:restart' → onRestart()
  }
  async function play(fn) {
    if (lockBusy) return;
    ctx.audio?.unlock?.();
    lockBusy = true;
    try { await ctx.input.requestLock(); } catch { lockBusy = false; ui.pauseInfo(mission.objective, 'Zeiger konnte nicht gesperrt werden – bitte erneut klicken.'); return; }
    lockBusy = false;
    fn?.();
    ctx.setState('playing');
  }
  const actions = {
    start: () => play(() => restart()),
    again: () => play(() => restart()),
    resume: () => play(),
    retry: () => { const cp = mission.checkpoint; play(() => restart({ snapshot: cp })); },
    restart: () => play(() => restart()),
    menu: () => { ctx.input.exitLock(); if (ctx.state !== 'menu') { ctx.setState('menu'); } else ui.show('menu'); },
  };
  let back = 'menu';
  const ui = createUI(ctx, {
    click(a) {
      if (a === 'settings' || a === 'controls') { back = ctx.state === 'paused' ? 'pause' : 'menu'; ui.show(a); return; }
      if (a === 'back') { ui.show(back); return; }
      if (a === 'abort') { actions.menu(); return; }
      actions[a]?.();
    },
    setting(k, v) {
      const S = ctx.settings.data;
      if (k === 'quality') ctx.quality?.setMode(v);
      else if (k === 'volume') { if (ctx.audio?.setVolume) ctx.audio.setVolume(v); else S.volume = v; }
      else S[k] = v;
      if (k === 'volumeSfx') ctx.audio?.setBusVolume?.('sfx', v);
      if (k === 'volumeVoice') ctx.audio?.setBusVolume?.('voice', v);
      ctx.settings.save();
      settingEvt.key = k; settingEvt.value = v; ctx.events.emit('f:settings', settingEvt);
    },
  });

  // keyboard: Enter starts/resumes/retries, Esc pauses/closes, R = from scratch after death
  addEventListener('keydown', (e) => {
    if (e.repeat || ctx.state === 'playing' || ctx.state === 'loading' || ctx.state === 'boot') return;
    const scr = ui.current;
    if (e.code === 'Escape') {
      if (scr === 'settings' || scr === 'controls') { ui.show(back); e.preventDefault(); return; }
      if (ctx.state === 'paused' && window.__fakeLock) { actions.resume(); return; }
      if (ctx.state === 'dead' || ctx.state === 'done') { actions.menu(); return; }
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (scr === 'settings' || scr === 'controls') return;   // focused control handles Enter
      e.preventDefault();
      if (ctx.state === 'menu') actions.start();
      else if (ctx.state === 'paused') actions.resume();
      else if (ctx.state === 'dead') actions.retry();
      else if (ctx.state === 'done') actions.again();
      return;
    }
    if (e.code === 'KeyR' && ctx.state === 'dead') actions.restart();
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !window.__fakeLock && ctx.state === 'playing') ctx.setState('paused');
  });

  ctx.events.on('load:progress', ({ p }) => ui.setLoad(p));
  ctx.events.on('state', ({ from, to }) => {
    if (to === 'loading') ui.show('loading');
    else if (to === 'menu') {
      if (from === 'loading') ui.loadWord('Bereit');
      if (from !== 'loading') restart({ menu: true });   // clean live scene behind the start screen
      menuView();
      ui.show('menu');
    } else if (to === 'paused') { ui.pauseInfo(mission.objective); ui.show('pause'); }
    else if (to === 'dead') {
      ctx.input.exitLock();
      const cp = mission.checkpoint;
      ui.dead(DEATH_LINES[runIndex % DEATH_LINES.length], cp ? DATA.CHECKPOINT.name : '');
      ui.show('dead');
    } else if (to === 'done') {
      ctx.input.exitLock();
      ui.done(mission.debrief(true));
      ui.show('done');
    } else if (to === 'playing') { ui.show(null); ui.hudOn(true); pauseGuard = ctx.time.frame + 2; }   // the key that resumed must not re-pause
  });
  ctx.events.on('trigger:enter', (t) => { if (t.id === DATA.EXTRACTION.id && ctx.state === 'playing') ctx.setState('done'); });
  ctx.events.on('f:objective', (o) => ui.objective(o.text));
  ctx.events.on('radio', (r) => { ui.radio(r.speaker, r.text); radioT = Math.max(3.5, r.text.length * 0.065); });
  const ammo = (t, s) => { ui.ammo(t); ammoT = s; };
  ctx.events.on('weapon:reload', (w) => ammo(`MAG ${w.ammo} · ${w.reserve}`, 2.6));
  ctx.events.on('weapon:reloaded', (w) => ammo(`MAG ${w.ammo} · ${w.reserve}`, 1.6));
  ctx.events.on('weapon:empty', () => ammo('MAG LEER', 1.4));
  let radioT = 0, ammoT = 0, lastFlash = '';

  // menu: the player stands at the spawn, frozen, with a slow camera drift (the live scene behind the blur)
  function menuView() {
    const sp = ctx.layout.playerSpawn;
    ctx.player?.teleport?.(sp.pos, sp.yaw + 0.12, 0.04, true);
  }

  // door speeds: doors.set(id, state, {speed}) keeps the speed; restore the layout defaults on restart
  const doorSpeed = new Map();
  d.init = () => { for (const r of ctx.world.doors?.list ?? []) doorSpeed.set(r.id, r.speed); };

  d.reset = () => {
    const keep = !!pendingSnap;
    mission.reset(keep);
    runtime.reset(runSeed());
    pacing.reset(runtime.seed);
    radioT = 0; ammoT = 0; lastFlash = '';
    ui.objective(''); ui.ammo(''); ui.radio('', '');
  };
  ctx.events.on('mission:restart', () => {
    for (const r of ctx.world.doors?.list ?? []) if (doorSpeed.has(r.id)) r.speed = doorSpeed.get(r.id);
    if (toMenu) { toMenu = false; return; }
    const snap = pendingSnap; pendingSnap = null;
    if (snap) {
      runtime.restoreDone(snap.done, snap.variants);
      mission.restore(snap);
      for (const id of snap.dead) kill(id);
    }
    runtime.setup();
    if (snap) { ctx.player.teleport(snap.pos, snap.yaw, 0, false); ctx.time.mission = snap.time; }
  });
  function kill(id) {
    const E = ctx.enemies;
    if (typeof E?.despawn === 'function') { E.despawn(id); return; }
    const e = E?.list?.find((x) => x.id === id);   // stub fallback: lie where they fell
    if (e) { e.dead = true; e.health = 0; e.alerted = false; }
  }

  // ------------------------------------------------------------------------------------------------ frame
  let menuT = 0, pauseGuard = 0;
  d.update = (dt) => {
    const st = ctx.state;
    if (st === 'menu') {
      menuT += dt;
      const P = ctx.player, sp = ctx.layout.playerSpawn;
      if (P) { P.yaw = sp.yaw + 0.12 + Math.sin(menuT * 0.07) * 0.06; P.pitch = 0.04 + Math.sin(menuT * 0.05) * 0.012; }
      return;
    }
    if (st !== 'playing') return;
    if (ctx.input.hit('pause') && ctx.time.frame > pauseGuard) {
      if (document.pointerLockElement) ctx.input.exitLock(); else ctx.setState('paused');
      return;
    }
    runtime.update(dt);
    mission.update(dt);
    pacing.update(dt);
    // OSD extras
    const fl = mission.st.flash;
    if (fl !== lastFlash) { lastFlash = fl; ui.objective(fl || mission.objective); }
    if (ctx.input.hit('reload') && ammoT <= 0 && ctx.weapon) ammo(`MAG ${ctx.weapon.ammo} · ${ctx.weapon.reserve}`, 1.8);
    if (ammoT > 0 && (ammoT -= dt) <= 0) ui.ammo('');
    if (radioT > 0 && (radioT -= dt) <= 0) ui.radio('', '');
  };

  // ------------------------------------------------------------------------------------------------ debug API
  Object.defineProperties(d, {
    tension: { get: () => pacing.tension, enumerable: true },   // 0..1 (also → ctx.audio.setTension, 'f:tension')
    masking: { get: () => pacing.masking, enumerable: true },   // 0..1 loud machines near the player (D: hearing)
    seed: { get: () => runtime.seed, enumerable: true },
  });
  Object.assign(d, {
    runtime, mission, pacing, data: DATA, verbose: false,
    setSeed(n) { baseSeed = n >>> 0; runIndex = 0; return baseSeed; },
    debug() { const rows = runtime.states(); console.table?.(rows); return rows; },
    fire: (id, variant) => runtime.fire(id, variant),
    status() {
      return {
        state: ctx.state, seed: runtime.seed, run: runIndex, objective: mission.objective,
        evidence: `${mission.foundCount()}/${mission.evidence.length}`, stats: { ...mission.stats },
        tension: +pacing.tension.toFixed(2), masking: +pacing.masking.toFixed(2), ambient: pacing.st.lastAmbient,
        checkpoint: !!mission.checkpoint, log: runtime.log.slice(-12),
      };
    },
    play: actions,
  });
  ui.show('loading');
  return d;
}
