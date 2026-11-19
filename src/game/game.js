import * as THREE from 'three';
import { resetGlass } from '../world/decals.js';

// Game flow + everything inside #ui (loading, menu, pause, death, debrief, minimal HUD).
// Created first: only touches the DOM at creation; sibling modules are read lazily from ctx.

// ---- Tunables -------------------------------------------------------------------------------
export const GAME_TUNING = {
  deathDelay: 1.5,          // seconds of fallen-camera footage before "SIGNAL VERLOREN"
  retryGuard: 0.45,         // ignore retry input this long after the death screen appears
  ammoShowSeconds: 2.2,     // ammo readout after reload / R
  objectiveSeconds: 4.5,    // objective line hold time
  cameraId: 'BWC-S9-0417',
  caseId: 'AKTE 09-4471',
};

const CSS = `
#ui { --s9-fg: #d9dbd5; --s9-mut: #8b8f88; --s9-dim: #5d615c; --s9-line: rgba(217,219,213,.16);
  --s9-mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Courier New", monospace;
  --s9-sans: "Helvetica Neue", "Segoe UI", Arial, sans-serif; }
#ui .s9-hidden { display: none !important; }
#ui > .s9-passive { pointer-events: none; }
#ui .s9-screen { position: absolute; inset: 0; color: var(--s9-fg); font-family: var(--s9-sans); font-size: 13px;
  -webkit-font-smoothing: antialiased; user-select: none; }
#ui .s9-screen button { font: inherit; color: inherit; }
#ui button:focus-visible, #ui input:focus-visible { outline: 1px solid var(--s9-fg); outline-offset: 3px; }
#ui .s9-title { font-weight: 600; font-size: 12px; letter-spacing: .55em; color: var(--s9-fg); }
#ui .s9-line { font-family: var(--s9-mono); font-size: 11px; letter-spacing: .06em; color: var(--s9-mut); line-height: 1.6; }

/* loading: title, thin progress line, one status word */
#ui .s9-loading { background: #050506; display: flex; align-items: center; justify-content: center; }
#ui .s9-load-box { width: min(300px, 70vw); }
#ui .s9-bar { height: 1px; background: var(--s9-line); margin: 22px 0 12px; overflow: hidden; }
#ui .s9-bar > div { height: 100%; width: 0%; background: var(--s9-fg); transition: width .3s ease-out; }

/* menu: over the live blurred scene, bottom-left, nothing else */
#ui .s9-menu { background: linear-gradient(90deg, rgba(5,6,7,.62) 0%, rgba(5,6,7,.3) 45%, rgba(5,6,7,0) 75%); }
#ui .s9-home { position: absolute; left: clamp(28px, 7vw, 120px); bottom: clamp(36px, 12vh, 140px); }
#ui .s9-home .s9-title { margin-bottom: 30px; }
#ui .s9-go { display: block; background: var(--s9-fg); color: #0b0c0d !important; border: 0; padding: 12px 26px; font-family: var(--s9-mono);
  font-size: 12px; letter-spacing: .2em; text-transform: uppercase; cursor: pointer; }
#ui .s9-go:hover { background: #fff; }
#ui .s9-links { margin-top: 18px; display: flex; gap: 22px; }
#ui .s9-link { background: none; border: 0; padding: 2px 0; cursor: pointer; font-family: var(--s9-mono); font-size: 11px;
  letter-spacing: .14em; text-transform: uppercase; color: var(--s9-mut) !important; }
#ui .s9-link:hover, #ui .s9-link.on { color: var(--s9-fg) !important; }
#ui .s9-foot { position: absolute; left: clamp(28px, 7vw, 120px); bottom: 18px; right: 28px; font-size: 10.5px; color: var(--s9-dim); }
#ui .s9-note { min-height: 15px; margin-top: 12px; font-family: var(--s9-mono); font-size: 11px; color: #c4ad84; }

/* panels: compact, on demand, right of the menu column */
#ui .s9-panel { position: absolute; right: clamp(16px, 5vw, 80px); top: 50%; transform: translateY(-50%);
  width: min(400px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow-y: auto; box-sizing: border-box;
  padding: 22px 24px; background: rgba(7,8,9,.82); }
#ui .s9-panel h2 { margin: 0 0 14px; font-weight: 600; font-size: 11px; letter-spacing: .4em; text-transform: uppercase; }
#ui .s9-panel h3 { margin: 16px 0 6px; font-family: var(--s9-mono); font-weight: 400; font-size: 10px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--s9-dim); }
#ui .s9-row { display: flex; align-items: center; gap: 12px; margin: 7px 0; color: #c3c5bf; font-size: 12.5px; flex-wrap: wrap; row-gap: 4px; }
#ui .s9-row > span:first-child { width: 140px; flex: none; }
#ui .s9-hint { margin: -2px 0 6px 152px; font-size: 10.5px; color: var(--s9-dim); line-height: 1.45; }
#ui .s9-seg { display: inline-flex; flex-wrap: wrap; gap: 2px 12px; }
#ui .s9-seg button { background: none; border: 0; padding: 2px 0; cursor: pointer; font-family: var(--s9-mono); font-size: 11px;
  color: var(--s9-dim); border-bottom: 1px solid transparent; }
#ui .s9-seg button.on { color: var(--s9-fg); border-bottom-color: var(--s9-fg); }
#ui .s9-seg button:not(.on):hover { color: var(--s9-mut); }
#ui input[type=range].s9-range { -webkit-appearance: none; appearance: none; width: 130px; height: 1px; background: var(--s9-mut); outline: none; }
#ui input[type=range].s9-range::-webkit-slider-thumb { -webkit-appearance: none; width: 9px; height: 13px; background: var(--s9-fg); border: 0; cursor: pointer; }
#ui input[type=range].s9-range::-moz-range-thumb { width: 9px; height: 13px; background: var(--s9-fg); border: 0; border-radius: 0; cursor: pointer; }
#ui .s9-val { font-family: var(--s9-mono); font-size: 11px; color: var(--s9-mut); min-width: 44px; }
#ui .s9-keys { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 12.5px; color: #c3c5bf; }
#ui .s9-keys > span:nth-child(odd) { font-family: var(--s9-mono); font-size: 11px; color: var(--s9-fg); white-space: nowrap; }
#ui .s9-keys i { font-style: normal; color: var(--s9-dim); }
#ui .s9-close { position: absolute; right: 14px; top: 12px; }
#ui .s9-reset { margin-top: 14px; }

/* pause / death / debrief: dim scene, left column, no boxes */
#ui .s9-dim { background: rgba(4,5,6,.62); }
#ui .s9-col { position: absolute; left: clamp(28px, 7vw, 120px); top: 50%; transform: translateY(-50%); }
#ui .s9-col .s9-title { margin-bottom: 10px; }
#ui .s9-col .s9-line { margin-bottom: 26px; }
#ui .s9-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
#ui .s9-figs { display: grid; grid-template-columns: max-content max-content; gap: 6px 28px; margin: 6px 0 28px;
  font-family: var(--s9-mono); font-size: 12px; color: var(--s9-mut); }
#ui .s9-figs b { font-weight: 400; color: var(--s9-fg); text-align: right; }
#ui .s9-dead { background: radial-gradient(ellipse at center, rgba(0,0,0,.5) 0%, rgba(0,0,0,.88) 100%); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; animation: s9-in .4s steps(4) both; }
#ui .s9-dead .s9-title { letter-spacing: .6em; padding-left: .6em; }
#ui .s9-dead .s9-line { margin-top: 14px; }
@keyframes s9-in { from { opacity: 0; } to { opacity: 1; } }

/* HUD: nothing persistent; ammo after reload / when low, objective line fades out */
#ui .s9-ammo { position: absolute; right: 34px; bottom: 30px; font-family: var(--s9-mono); font-size: 12px; letter-spacing: .14em;
  color: rgba(222,223,218,.8); text-shadow: 0 0 2px rgba(0,0,0,.8); opacity: 0; transition: opacity .35s ease; }
#ui .s9-ammo.on { opacity: 1; transition-duration: .08s; }
#ui .s9-ammo.low { color: rgba(214,170,150,.9); }
#ui .s9-ammo .s9-res { color: rgba(170,172,166,.55); }
#ui .s9-obj { position: absolute; left: 34px; bottom: 34px; font-family: var(--s9-mono); font-size: 11.5px; letter-spacing: .14em;
  text-transform: uppercase; color: rgba(222,223,218,.85); text-shadow: 0 0 3px rgba(0,0,0,.9); opacity: 0; transition: opacity 1.1s ease; }
#ui .s9-obj.on { opacity: 1; transition-duration: .4s; }
#ui .s9-obj .s9-ts { color: rgba(160,163,157,.65); margin-right: 14px; }
@media (max-height: 560px) { #ui .s9-home { bottom: 40px; } #ui .s9-home .s9-title { margin-bottom: 18px; } }
`;

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};
const fmtClock = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  return `${String(h).padStart(2, '0')}:${fmtTime(s % 3600)}`;
};

function store(key, val) { try { localStorage.setItem(key, String(val)); } catch (e) { /* ignore */ } }
function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

export function createGame(ctx) {
  const G = GAME_TUNING;
  const ui = document.getElementById('ui');

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const n = t.content.firstElementChild;
    ui.appendChild(n);
    return n;
  };
  const $ = (root, sel) => root.querySelector(sel);

  // ---- screens ------------------------------------------------------------------------------
  // Minimal on purpose: one action per screen, everything else on demand (Einstellungen / Steuerung panels).
  const scrLoading = el(`
    <div class="s9-screen s9-loading">
      <div class="s9-load-box">
        <div class="s9-title">SECTOR 9</div>
        <div class="s9-bar"><div data-k="bar"></div></div>
        <div class="s9-line" data-k="label">Lade</div>
      </div>
    </div>`);

  const scrMenu = el(`
    <div class="s9-screen s9-menu s9-hidden">
      <div class="s9-home">
        <div class="s9-title">SECTOR 9</div>
        <button type="button" class="s9-go" data-act="start">Einsatz beginnen</button>
        <div class="s9-links">
          <button type="button" class="s9-link" data-panel="settings">Einstellungen</button>
          <button type="button" class="s9-link" data-panel="controls">Steuerung</button>
        </div>
        <div class="s9-note" data-k="note"></div>
      </div>
      <div class="s9-foot">Stillgelegtes Werk, bewaffnete Personen, keine Unterstützung · Enthält realistische Waffengewalt.</div>
      <div data-k="settings-slot"></div>
    </div>`);

  const scrPause = el(`
    <div class="s9-screen s9-dim s9-hidden">
      <div class="s9-col">
        <div class="s9-title">PAUSE</div>
        <div class="s9-line" data-k="left">–</div>
        <div class="s9-actions">
          <button type="button" class="s9-go" data-act="resume">Weiter</button>
          <button type="button" class="s9-link" data-act="restart">Neu starten</button>
          <button type="button" class="s9-link" data-panel="settings">Einstellungen</button>
          <button type="button" class="s9-link" data-panel="controls">Steuerung</button>
        </div>
        <div class="s9-note" data-k="note"></div>
      </div>
      <div data-k="settings-slot"></div>
    </div>`);

  // settings + controls panels: one element, moved into whichever screen (menu / pause) is shown
  const settingsEl = (() => {
    const t = document.createElement('template');
    t.innerHTML = `
      <div>
        <div class="s9-panel s9-hidden" data-p="settings">
          <h2>Einstellungen</h2>
          <button type="button" class="s9-link s9-close" data-panel="close">Esc</button>
          <div class="s9-row"><span>Grafik</span>
            <span class="s9-seg" data-k="quality">
              <button type="button" data-q="auto">Automatisch</button><button type="button" data-q="minimal">Sehr niedrig</button><button type="button" data-q="low">Niedrig</button><button type="button" data-q="medium">Mittel</button><button type="button" data-q="high">Hoch</button>
            </span></div>
          <div class="s9-hint" data-k="qinfo"></div>
          <div class="s9-row"><span>Sichtfeld</span>
            <input class="s9-range" type="range" min="80" max="110" step="1" data-k="fov"><span class="s9-val" data-k="fovv"></span></div>
          <div class="s9-row"><span>Kamerawackeln</span>
            <input class="s9-range" type="range" min="0" max="100" step="5" data-k="shake"><span class="s9-val" data-k="shakev"></span></div>
          <div class="s9-row"><span>Gesichter verpixeln</span>
            <span class="s9-seg" data-k="faces"><button type="button" data-v="1">An</button><button type="button" data-v="0">Aus</button></span></div>
          <div class="s9-row"><span>Lautstärke</span>
            <input class="s9-range" type="range" min="0" max="100" step="1" value="80" data-k="vol"><span class="s9-val" data-k="volv">80 %</span></div>
        </div>
        <div class="s9-panel s9-hidden" data-p="controls">
          <h2>Steuerung</h2>
          <button type="button" class="s9-link s9-close" data-panel="close">Esc</button>
          <div class="s9-keys">
            <span>W A S D <i>/</i> Pfeile</span><span>Bewegen</span>
            <span>Maus</span><span>Umsehen, Waffe führen</span>
            <span>Linke Maustaste</span><span>Schießen</span>
            <span>Rechte Maustaste</span><span>Zielen</span>
            <span>R <i>/</i> Enter <i>/</i> Num 1</span><span>Nachladen</span>
            <span>F <i>/</i> Ende <i>/</i> Num ,</span><span>Waffenlicht</span>
            <span>Shift <i>(links / rechts)</i></span><span>Sprinten</span>
            <span>C <i>/</i> Strg <i>/</i> Num 0</span><span>Ducken</span>
            <span>Q E <i>/</i> Entf Bild↓</span><span>Lehnen</span>
            <span>Esc</span><span>Pause</span>
          </div>
          <h3>Maus und Zielen</h3>
          <div class="s9-row"><span>Empfindlichkeit</span>
            <input class="s9-range" type="range" min="0" max="1000" step="1" data-k="sens"><span class="s9-val" data-k="sensv"></span></div>
          <div class="s9-hint">Gleiche Skala wie Source/CS (0,022° pro Zählschritt).</div>
          <div class="s9-row"><span>Beim Zielen</span>
            <input class="s9-range" type="range" min="30" max="150" step="1" data-k="adssens"><span class="s9-val" data-k="adssensv"></span></div>
          <div class="s9-row"><span>Y-Achse umkehren</span>
            <span class="s9-seg" data-k="invert"><button type="button" data-v="0">Aus</button><button type="button" data-v="1">An</button></span></div>
          <div class="s9-row"><span>Freies Zielen</span>
            <span class="s9-seg" data-k="freeaim"><button type="button" data-v="aus">Aus</button><button type="button" data-v="gering">Gering</button><button type="button" data-v="standard">Standard</button><button type="button" data-v="stark">Stark</button></span></div>
          <div class="s9-hint">Die Waffe bewegt sich etwas im Bild, bevor die Kamera mitdreht.</div>
          <div class="s9-row"><span>Zielen</span>
            <span class="s9-seg" data-k="aimmode"><button type="button" data-v="hold">Halten</button><button type="button" data-v="toggle">Umschalten</button></span></div>
          <div class="s9-row"><span>Ducken</span>
            <span class="s9-seg" data-k="crouchmode"><button type="button" data-v="toggle">Umschalten</button><button type="button" data-v="hold">Halten</button></span></div>
          <button type="button" class="s9-link s9-reset" data-k="reset">Zurücksetzen</button>
        </div>
      </div>`.trim();
    return t.content.firstElementChild;
  })();

  const scrDead = el(`
    <div class="s9-screen s9-dead s9-hidden">
      <div class="s9-title">SIGNAL VERLOREN</div>
      <div class="s9-line">Klick oder Enter: erneut versuchen</div>
      <div class="s9-note" data-k="note"></div>
    </div>`);

  const scrDone = el(`
    <div class="s9-screen s9-dim s9-hidden">
      <div class="s9-col">
        <div class="s9-title">GESICHERT</div>
        <div class="s9-figs">
          <span>Zeit</span><b data-k="time">–</b>
          <span>Ausgeschaltet</span><b data-k="kills">–</b>
          <span>Schüsse</span><b data-k="shots">–</b>
          <span>Treffer</span><b data-k="acc">–</b>
        </div>
        <button type="button" class="s9-go" data-act="again">Neuer Einsatz</button>
        <div class="s9-note" data-k="note"></div>
      </div>
    </div>`);

  const hudAmmo = el(`<div class="s9-ammo s9-passive s9-hidden"><span data-k="mag">--</span> <span class="s9-res">/ <span data-k="res">--</span></span></div>`);
  const hudObj = el(`<div class="s9-obj s9-passive s9-hidden"><span class="s9-ts" data-k="ts"></span><span data-k="txt"></span></div>`);

  const screens = [scrLoading, scrMenu, scrPause, scrDead, scrDone];
  function showScreen(s) {
    openPanel(null);
    for (const x of screens) x.classList.toggle('s9-hidden', x !== s);
    const slot = s && $(s, '[data-k=settings-slot]');
    if (slot && settingsEl.parentNode !== slot) slot.appendChild(settingsEl);
    for (const x of screens) { const n = $(x, '[data-k=note]'); if (n) n.textContent = ''; }
    const hud = s === null;
    hudAmmo.classList.toggle('s9-hidden', !hud);
    hudObj.classList.toggle('s9-hidden', !hud);
  }
  const panels = settingsEl.querySelectorAll('[data-p]');
  let panelOpen = null;
  function openPanel(name) {
    panelOpen = name && name !== 'close' && panelOpen !== name ? name : null;
    panels.forEach((p) => p.classList.toggle('s9-hidden', p.dataset.p !== panelOpen));
    ui.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === panelOpen));
    if (panelOpen) { syncQualityInfo(); setTimeout(() => settingsEl.querySelector(`[data-p=${panelOpen}] button, [data-p=${panelOpen}] input`)?.focus?.({ preventScroll: true }), 0); }
  }
  function activeScreen() { return screens.find((x) => !x.classList.contains('s9-hidden')) || null; }
  function note(text) {
    const s = activeScreen(); const n = s && $(s, '[data-k=note]');
    if (n) n.textContent = text;
  }

  // ---- state --------------------------------------------------------------------------------
  const game = {
    state: 'loading',
    setLoading, ready, update, onPlayerDeath, onEnemyDeath,
    tuning: G,
  };

  let pending = null;            // { restart?, first? } waiting for pointer lock
  let deathPending = false, deathTimer = 0, deadShownAt = 0;
  let missionTime = 0, clock = 0, kills = 0, secured = false;
  let shotsBase = 0, hitsBase = 0;
  let objTimer = 0;
  let ammoShowT = 0, lastAmmo = -1, lastReloading = false, lastAmmoText = '', lastResText = '', ammoOn = false, ammoLow = false;
  let quality = 'auto';
  let volume = 0.8;
  const tmpV = new THREE.Vector3();

  const canvas = () => ctx.renderer?.domElement;
  const lockSupported = () => !!canvas()?.requestPointerLock;
  // window.__fakeLock: automated-test hook (no real pointer lock available there)
  const isLocked = () => { if (window.__fakeLock) return true; const c = canvas(); return !!c && document.pointerLockElement === c; };

  function lockFailed() {
    if (!pending) return;
    note('Zeigersperre vom Browser abgelehnt – bitte in einem Moment erneut klicken.');
  }
  function requestLock() {
    // raw (unaccelerated) mouse where the browser supports it, plain pointer lock otherwise (input.js)
    try {
      const r = ctx.input?.requestLock?.();
      if (r && typeof r.then === 'function') r.catch(lockFailed);
    } catch (e) { lockFailed(); }
  }

  document.addEventListener('pointerlockchange', () => {
    if (isLocked()) { if (pending) commit(); }
    else if (game.state === 'playing' && !deathPending) pause();
  });
  document.addEventListener('pointerlockerror', lockFailed);

  function beginPlay(opts) {
    ctx.audio?.resume?.();
    pending = opts || {};
    if (isLocked() || !lockSupported()) { commit(); return; }
    note('');
    requestLock();
  }

  function commit() {
    const p = pending || {}; pending = null;
    if (p.restart) {
      ctx.player?.reset?.(); ctx.enemies?.reset?.(); ctx.fx?.reset?.();
      try { resetGlass(); } catch (e) { /* no glass */ }   // restore shot-out windows
      ctx.audio?.setMuffled?.(false); ctx.pipeline?.setDead?.(false);
    }
    if (p.restart || p.first) {
      missionTime = 0; kills = 0; secured = false; deathPending = false;
      shotsBase = Number(ctx.player?.shotsFired) || 0;
      hitsBase = Number(ctx.player?.shotsHit ?? ctx.player?.hits) || 0;
      lastAmmo = -1; ammoShowT = 0;
      objective('Gebäude sichern');
    }
    game.state = 'playing';
    ctx.pipeline?.setMenu?.(false);
    showScreen(null);
  }

  let pausedAt = 0;
  function pause() {
    game.state = 'paused';
    pausedAt = clock;
    ctx.pipeline?.setMenu?.(true);
    const n = ctx.enemies?.aliveCount;
    $(scrPause, '[data-k=left]').textContent = typeof n === 'number'
      ? (n === 0 ? `Alle ausgeschaltet · ${fmtTime(missionTime)}` : `Noch ${n} Bewaffnete · ${fmtTime(missionTime)}`) : fmtTime(missionTime);
    showScreen(scrPause);
  }

  function showDead() {
    deathPending = false;
    game.state = 'dead';
    deadShownAt = clock;
    showScreen(scrDead);
  }

  function complete() {
    game.state = 'complete';
    ctx.input?.exitLock?.();
    ctx.pipeline?.setMenu?.(true);
    const p = ctx.player;
    const fired = p && Number.isFinite(p.shotsFired) ? Math.max(0, p.shotsFired - shotsBase) : null;
    const hitsRaw = p ? (p.shotsHit ?? p.hits) : undefined;
    const hits = Number.isFinite(hitsRaw) ? Math.max(0, hitsRaw - hitsBase) : null;
    $(scrDone, '[data-k=time]').textContent = fmtTime(missionTime);
    $(scrDone, '[data-k=kills]').textContent = String(kills);
    $(scrDone, '[data-k=shots]').textContent = fired === null ? '–' : String(fired);
    $(scrDone, '[data-k=acc]').textContent = fired && hits !== null ? `${Math.round((100 * Math.min(hits, fired)) / fired)} %` : '–';
    showScreen(scrDone);
  }

  function objective(text) {
    $(hudObj, '[data-k=ts]').textContent = fmtClock(missionTime);
    $(hudObj, '[data-k=txt]').textContent = text;
    hudObj.classList.add('on');
    objTimer = G.objectiveSeconds;
  }

  // ---- UI wiring ----------------------------------------------------------------------------
  ui.addEventListener('click', (e) => {
    const b = e.target.closest?.('button');
    if (!b || !ui.contains(b)) return;
    ctx.audio?.play?.('ui_click');
    if (b.dataset.panel) { openPanel(b.dataset.panel); return; }
    const act = b.dataset.act;
    if (act === 'start' && game.state === 'menu') beginPlay({ first: true });
    else if (act === 'resume' && game.state === 'paused') beginPlay({});
    else if (act === 'restart' && game.state === 'paused') beginPlay({ restart: true });
    else if (act === 'again' && game.state === 'complete') beginPlay({ restart: true });
    else if (b.dataset.q) setQuality(b.dataset.q);
    // 'retry' is handled by the global mousedown below (works with and without pointer lock)
  });

  const qBtns = settingsEl.querySelectorAll('[data-q]');
  const QUALITIES = ['auto', 'minimal', 'low', 'medium', 'high'];
  const Q_NAMES = { minimal: 'Sehr niedrig', low: 'Niedrig', medium: 'Mittel', high: 'Hoch' };
  function setQuality(q) {
    if (!QUALITIES.includes(q)) return;
    quality = q;
    qBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === q));
    store('s9.quality', q);
    if (ctx.pipeline?.setQualityMode) ctx.pipeline.setQualityMode(q);
    else if (q !== 'auto') ctx.pipeline?.setQuality?.(q);
    syncQualityInfo();
  }
  function syncQualityInfo() {
    const n = $(settingsEl, '[data-k=qinfo]');
    if (!n) return;
    const cur = ctx.pipeline?.quality, sc = ctx.pipeline?.renderScale;
    n.textContent = quality === 'auto' && cur
      ? `Passt sich der Leistung an · aktuell ${Q_NAMES[cur] || cur}${sc && sc < 0.99 ? `, ${Math.round(sc * 100)} % Auflösung` : ''}` : '';
  }
  const volInput = $(settingsEl, '[data-k=vol]'), volVal = $(settingsEl, '[data-k=volv]');
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    volInput.value = String(Math.round(volume * 100));
    volVal.textContent = `${Math.round(volume * 100)} %`;
    store('s9.volume', volume);
    ctx.audio?.setMasterVolume?.(volume);
  }
  volInput.addEventListener('input', () => setVolume(Number(volInput.value) / 100));

  // ---- control / view settings (persisted as JSON, applied live to player + pipeline) ---------
  const CTRL_DEFAULTS = {
    sens: 3.0, adsSens: 0.85, invertY: false, freeAim: 'standard', aimMode: 'hold', crouchMode: 'toggle',
    fov: 97, shake: 1, faceBlur: true,
  };
  const ctrl = Object.assign({}, CTRL_DEFAULTS);
  try { Object.assign(ctrl, JSON.parse(load('s9.controls') || '{}')); } catch (e) { /* ignore */ }
  const SENS_MIN = 0.2, SENS_MAX = 10;
  const sensToSlider = (s) => Math.round(1000 * Math.log(s / SENS_MIN) / Math.log(SENS_MAX / SENS_MIN));
  const sliderToSens = (x) => SENS_MIN * Math.pow(SENS_MAX / SENS_MIN, x / 1000);
  let shakeBase = null;   // pipeline shake constants at full strength
  function applyControls() {
    const p = ctx.player;
    if (p?.settings) {
      Object.assign(p.settings, {
        sens: ctrl.sens, adsSens: ctrl.adsSens, invertY: !!ctrl.invertY, freeAim: ctrl.freeAim,
        aimMode: ctrl.aimMode, crouchMode: ctrl.crouchMode, fov: ctrl.fov, shake: ctrl.shake,
      });
    }
    const T = ctx.pipeline?.tuning;
    if (T) {
      if (!shakeBase) shakeBase = { shakeOffset: T.shakeOffset, shakeRotation: T.shakeRotation, wobble: T.wobble, eis: T.eis };
      for (const k of Object.keys(shakeBase)) T[k] = shakeBase[k] * Math.max(0, ctrl.shake);
    }
    ctx.pipeline?.setFaceBlur?.(!!ctrl.faceBlur);
  }
  const segSel = (key, val) => settingsEl.querySelectorAll(`[data-k=${key}] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
  function syncControlsUI() {
    $(settingsEl, '[data-k=sens]').value = String(sensToSlider(ctrl.sens));
    $(settingsEl, '[data-k=sensv]').textContent = ctrl.sens.toFixed(2).replace('.', ',');
    $(settingsEl, '[data-k=adssens]').value = String(Math.round(ctrl.adsSens * 100));
    $(settingsEl, '[data-k=adssensv]').textContent = `${Math.round(ctrl.adsSens * 100)} %`;
    $(settingsEl, '[data-k=fov]').value = String(ctrl.fov);
    $(settingsEl, '[data-k=fovv]').textContent = `${ctrl.fov}°`;
    $(settingsEl, '[data-k=shake]').value = String(Math.round(ctrl.shake * 100));
    $(settingsEl, '[data-k=shakev]').textContent = `${Math.round(ctrl.shake * 100)} %`;
    segSel('invert', ctrl.invertY ? 1 : 0);
    segSel('freeaim', ctrl.freeAim);
    segSel('aimmode', ctrl.aimMode);
    segSel('crouchmode', ctrl.crouchMode);
    segSel('faces', ctrl.faceBlur ? 1 : 0);
  }
  function setCtrl(patch) {
    Object.assign(ctrl, patch);
    store('s9.controls', JSON.stringify(ctrl));
    syncControlsUI();
    applyControls();
  }
  const onRange = (k, f) => $(settingsEl, `[data-k=${k}]`).addEventListener('input', (e) => setCtrl(f(Number(e.target.value))));
  onRange('sens', (x) => ({ sens: Math.round(sliderToSens(x) * 100) / 100 }));
  onRange('adssens', (x) => ({ adsSens: x / 100 }));
  onRange('fov', (x) => ({ fov: x }));
  onRange('shake', (x) => ({ shake: x / 100 }));
  settingsEl.addEventListener('click', (e) => {
    const b = e.target.closest?.('button');
    if (!b) return;
    const seg = b.parentElement?.dataset?.k, v = b.dataset.v;
    if (b.dataset.k === 'reset') { const keep = { faceBlur: ctrl.faceBlur }; setCtrl(Object.assign({}, CTRL_DEFAULTS, keep)); return; }
    if (v === undefined) return;
    if (seg === 'invert') setCtrl({ invertY: v === '1' });
    else if (seg === 'freeaim') setCtrl({ freeAim: v });
    else if (seg === 'aimmode') setCtrl({ aimMode: v });
    else if (seg === 'crouchmode') setCtrl({ crouchMode: v });
    else if (seg === 'faces') setCtrl({ faceBlur: v === '1' });
  });
  // keyboard focus stays on the canvas side: sliders / buttons must not eat game keys after a click
  settingsEl.addEventListener('pointerup', () => { setTimeout(() => document.activeElement?.blur?.(), 0); });
  syncControlsUI();

  function canRetry() { return game.state === 'dead' && clock - deadShownAt > G.retryGuard; }
  addEventListener('mousedown', () => { if (canRetry()) beginPlay({ restart: true }); });
  // keyboard: Enter = the screen's primary action, Esc closes an open panel (or resumes from pause)
  addEventListener('keydown', (e) => {
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    if (canRetry()) {
      if (e.code === 'KeyR' || enter) { e.preventDefault(); beginPlay({ restart: true }); }
      return;
    }
    if (e.code === 'Escape' && panelOpen) { e.preventDefault(); openPanel(null); return; }
    const focusInPanel = settingsEl.contains(document.activeElement) && document.activeElement !== document.body;
    if (enter && !focusInPanel && !e.repeat) {
      if (game.state === 'menu') { e.preventDefault(); beginPlay({ first: true }); }
      else if (game.state === 'paused') { e.preventDefault(); beginPlay({}); }
      else if (game.state === 'complete') { e.preventDefault(); beginPlay({ restart: true }); }
    } else if (e.code === 'Escape' && game.state === 'paused' && !e.repeat && clock - pausedAt > 0.3) {
      e.preventDefault(); beginPlay({});
    }
  });

  // ---- contract API -------------------------------------------------------------------------
  function setLoading(p, label) {
    (window.__loadLog ||= []).push([Math.round(performance.now()), label || '', +(+p || 0).toFixed(2)]);   // load profile (tests)
    const v = Math.min(1, Math.max(0, Number(p) || 0));
    $(scrLoading, '[data-k=bar]').style.width = `${(v * 100).toFixed(1)}%`;
    if (label) $(scrLoading, '[data-k=label]').textContent = String(label);
  }

  function ready() {
    setLoading(1, 'Bereit');
    const savedQ = load('s9.quality');
    setQuality(QUALITIES.includes(savedQ) ? savedQ : 'auto');
    const savedV = Number(load('s9.volume'));
    setVolume(load('s9.volume') !== null && Number.isFinite(savedV) ? savedV : volume);
    applyControls();
    game.state = 'menu';
    ctx.pipeline?.setMenu?.(true);
    showScreen(scrMenu);
  }

  function onPlayerDeath() {
    if (deathPending || game.state === 'dead') return;
    deathPending = true;
    deathTimer = G.deathDelay;
    ammoShowT = 0;
    ctx.audio?.setMuffled?.(true);
    ctx.pipeline?.setDead?.(true);
  }

  function onEnemyDeath() { kills++; }

  function inExtraction() {
    const box = ctx.level?.extraction, p = ctx.player?.position;
    if (!box || !p || typeof box.containsPoint !== 'function') return false;
    tmpV.copy(p); tmpV.y += 0.4;
    if (box.containsPoint(tmpV)) return true;
    tmpV.y += 0.6;
    return box.containsPoint(tmpV);
  }

  function updateHud(dt) {
    const p = ctx.player;
    if (!p || typeof p.ammo !== 'number') return;
    if (lastAmmo >= 0 && p.ammo > lastAmmo) ammoShowT = G.ammoShowSeconds;      // reload finished
    const reloading = !!p.reloading;
    if (reloading && !lastReloading) ammoShowT = G.ammoShowSeconds;
    if (ctx.input?.pressed?.('KeyR')) ammoShowT = G.ammoShowSeconds;           // reload / check
    lastReloading = reloading;
    lastAmmo = p.ammo;
    ammoShowT = Math.max(0, ammoShowT - dt);
    const mag = Number(p.magSize) || 0;
    const low = p.ammo <= (mag ? Math.max(2, Math.ceil(mag * 0.25)) : 2);
    const on = game.state === 'playing' && !deathPending && p.alive !== false && (ammoShowT > 0 || low);
    if (on !== ammoOn) { hudAmmo.classList.toggle('on', on); ammoOn = on; }
    if (low !== ammoLow) { hudAmmo.classList.toggle('low', low); ammoLow = low; }
    const mt = String(p.ammo).padStart(2, '0');
    const rt = typeof p.reserve === 'number' ? String(p.reserve).padStart(2, '0') : '--';
    if (mt !== lastAmmoText) { $(hudAmmo, '[data-k=mag]').textContent = mt; lastAmmoText = mt; }
    if (rt !== lastResText) { $(hudAmmo, '[data-k=res]').textContent = rt; lastResText = rt; }
  }

  function update(dt) {
    clock += dt;
    // the standby (menu) view is the camera alone: no arms in front of the title
    const vmRoot = ctx.player?.viewmodel?.root;
    if (vmRoot) vmRoot.visible = game.state !== 'menu' && game.state !== 'loading';
    if (game.state === 'playing') {
      missionTime += dt;
      if (deathPending) {
        deathTimer -= dt;
        if (deathTimer <= 0) showDead();
      } else {
        const en = ctx.enemies;
        if (!secured && en && typeof en.aliveCount === 'number' && en.aliveCount === 0 && (en.list?.length ?? 1) > 0) {
          secured = true;
          objective('Gesichert — zum Sammelpunkt, hinterer Hof');
        }
        if (secured && inExtraction()) complete();
      }
    }
    if (objTimer > 0 && (objTimer -= dt) <= 0) hudObj.classList.remove('on');
    if (game.state === 'playing' || game.state === 'paused') updateHud(dt);
  }

  return game;
}
