import * as THREE from 'three';

// Game flow + everything inside #ui (loading, menu, pause, death, debrief, minimal HUD).
// Created first: only touches the DOM at creation; sibling modules are read lazily from ctx.

// ---- Tunables -------------------------------------------------------------------------------
export const GAME_TUNING = {
  deathDelay: 1.5,          // seconds of fallen-camera footage before "SIGNAL VERLOREN"
  retryGuard: 0.45,         // ignore retry input this long after the death screen appears
  ammoShowSeconds: 2.2,     // ammo readout after reload / R
  objectiveSeconds: 4.5,    // objective line hold time
  startRadioDelay: 0.7,
  cameraId: 'BWC-S9-0417',
  caseId: 'AKTE 09-4471',
};

const CSS = `
#ui { --s9-bg: rgba(9,10,11,0.88); --s9-fg: #d3d5cf; --s9-mut: #81867f; --s9-line: #2b2f2d;
  --s9-acc: #c9c3b1; --s9-red: #9b3b31;
  --s9-mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Courier New", monospace;
  --s9-sans: "Helvetica Neue", "Segoe UI", Arial, sans-serif; }
#ui > .s9-hidden { display: none !important; }
#ui > .s9-passive { pointer-events: none; }
#ui .s9-screen { position: absolute; inset: 0; color: var(--s9-fg); font-family: var(--s9-sans);
  -webkit-font-smoothing: antialiased; user-select: none; }
#ui .s9-screen button { font: inherit; }

/* loading */
#ui .s9-loading { background: #050506; display: flex; align-items: center; justify-content: center; }
#ui .s9-load-box { width: min(420px, 80vw); font-family: var(--s9-mono); font-size: 11px; letter-spacing: .12em; color: var(--s9-mut); }
#ui .s9-load-title { color: var(--s9-fg); font-family: var(--s9-sans); font-weight: 600; font-size: 13px; letter-spacing: .5em; margin-bottom: 18px; }
#ui .s9-bar { height: 2px; background: var(--s9-line); margin: 10px 0 8px; overflow: hidden; }
#ui .s9-bar > div { height: 100%; width: 0%; background: var(--s9-acc); transition: width .25s ease-out; }
#ui .s9-load-row { display: flex; justify-content: space-between; }

/* menu */
#ui .s9-menu { background: linear-gradient(90deg, rgba(6,7,8,.94) 0%, rgba(6,7,8,.86) 38%, rgba(6,7,8,.25) 70%, rgba(6,7,8,.1) 100%);
  overflow-y: auto; }
#ui .s9-panel { width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 40px 48px 32px; }
#ui .s9-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-family: var(--s9-mono); font-size: 10.5px;
  letter-spacing: .14em; color: var(--s9-mut); border-bottom: 1px solid var(--s9-line); padding-bottom: 10px; text-transform: uppercase; }
#ui .s9-title { font-family: var(--s9-sans); font-weight: 600; font-size: 54px; letter-spacing: .32em; margin: 34px 0 4px; color: #e2e3de; }
#ui .s9-sub { font-family: var(--s9-mono); font-size: 11px; letter-spacing: .1em; color: var(--s9-mut); margin-bottom: 26px; }
#ui .s9-sec { border-top: 1px solid var(--s9-line); padding: 14px 0 12px; }
#ui .s9-sec h2 { font-family: var(--s9-mono); font-weight: 400; font-size: 10.5px; letter-spacing: .2em; color: var(--s9-mut);
  margin: 0 0 9px; text-transform: uppercase; }
#ui .s9-sec p { margin: 0 0 7px; font-size: 13.5px; line-height: 1.55; color: #c4c6c0; max-width: 60ch; }
#ui .s9-keys { display: grid; grid-template-columns: max-content 1fr max-content 1fr; gap: 5px 14px; font-size: 12.5px; color: #bfc1bb; }
#ui .s9-keys kbd { font-family: var(--s9-mono); font-size: 11px; color: var(--s9-fg); border: 1px solid var(--s9-line);
  padding: 1px 6px; border-radius: 2px; background: rgba(255,255,255,.02); white-space: nowrap; justify-self: start; }
#ui .s9-row { display: flex; align-items: center; gap: 14px; margin: 6px 0; font-size: 12.5px; color: #bfc1bb; }
#ui .s9-row > span:first-child { width: 110px; }
#ui .s9-seg { display: inline-flex; border: 1px solid var(--s9-line); }
#ui .s9-seg button { background: transparent; color: var(--s9-mut); border: 0; border-right: 1px solid var(--s9-line);
  padding: 5px 12px; font-family: var(--s9-mono); font-size: 11px; letter-spacing: .08em; cursor: pointer; }
#ui .s9-seg button:last-child { border-right: 0; }
#ui .s9-seg button.on { background: #d3d5cf; color: #0b0c0d; }
#ui .s9-seg button:not(.on):hover { color: var(--s9-fg); }
#ui input[type=range].s9-range { -webkit-appearance: none; appearance: none; width: 180px; height: 2px; background: var(--s9-line); outline: none; }
#ui input[type=range].s9-range::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 14px; background: var(--s9-fg); border: 0; border-radius: 1px; cursor: pointer; }
#ui input[type=range].s9-range::-moz-range-thumb { width: 10px; height: 14px; background: var(--s9-fg); border: 0; border-radius: 1px; cursor: pointer; }
#ui .s9-val { font-family: var(--s9-mono); font-size: 11px; color: var(--s9-mut); width: 40px; }
#ui .s9-btn { display: inline-block; margin-top: 18px; padding: 11px 22px; background: transparent; color: var(--s9-fg);
  border: 1px solid #5b605b; font-family: var(--s9-mono); font-size: 12px; letter-spacing: .22em; text-transform: uppercase; cursor: pointer; }
#ui .s9-btn:hover { background: rgba(211,213,207,.08); border-color: var(--s9-fg); }
#ui .s9-btn.s9-primary { background: #d3d5cf; color: #0b0c0d; border-color: #d3d5cf; }
#ui .s9-btn.s9-primary:hover { background: #e9eae6; }
#ui .s9-btn + .s9-btn { margin-left: 10px; }
#ui .s9-note { min-height: 16px; margin-top: 10px; font-family: var(--s9-mono); font-size: 11px; color: #b9a37a; letter-spacing: .05em; }
#ui .s9-warn { margin-top: 18px; font-family: var(--s9-mono); font-size: 10.5px; line-height: 1.5; color: var(--s9-mut); letter-spacing: .04em;
  border-left: 2px solid var(--s9-red); padding-left: 10px; }

/* pause / debrief */
#ui .s9-dim { background: rgba(5,6,7,.72); display: flex; align-items: center; }
#ui .s9-card { margin-left: max(32px, 8vw); width: min(460px, calc(100vw - 32px)); box-sizing: border-box; background: var(--s9-bg);
  border: 1px solid var(--s9-line); padding: 26px 30px 26px; }
#ui .s9-card h3 { font-family: var(--s9-sans); font-weight: 600; font-size: 22px; letter-spacing: .22em; margin: 18px 0 16px; text-transform: uppercase; }
#ui .s9-table { width: 100%; border-collapse: collapse; font-family: var(--s9-mono); font-size: 12px; }
#ui .s9-table td { padding: 7px 0; border-bottom: 1px solid var(--s9-line); color: var(--s9-mut); letter-spacing: .06em; }
#ui .s9-table td:last-child { text-align: right; color: var(--s9-fg); }

/* death */
#ui .s9-dead { background:
    repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, rgba(0,0,0,.55) 0%, rgba(0,0,0,.9) 100%);
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; cursor: pointer;
  animation: s9-in .35s steps(4) both; }
#ui .s9-dead .s9-sig { font-family: var(--s9-mono); font-size: clamp(28px, 5vw, 56px); letter-spacing: .4em; color: #e4e4e0;
  padding-left: .4em; animation: s9-flick 2.4s steps(1) infinite; }
#ui .s9-dead .s9-meta { margin-top: 14px; font-family: var(--s9-mono); font-size: 11px; letter-spacing: .18em; color: var(--s9-mut); }
#ui .s9-dead .s9-rec { display: inline-block; width: 8px; height: 8px; background: var(--s9-red); margin-right: 10px; vertical-align: 1px; }
#ui .s9-dead .s9-hint { margin-top: 10px; font-family: var(--s9-mono); font-size: 10.5px; color: var(--s9-mut); letter-spacing: .14em; }
@keyframes s9-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes s9-flick { 0%, 100% { opacity: 1; } 47% { opacity: .82; } 48% { opacity: 1; } 83% { opacity: .9; } }

/* HUD */
#ui .s9-ammo { position: absolute; right: 34px; bottom: 30px; font-family: var(--s9-mono); font-size: 13px; letter-spacing: .14em;
  color: rgba(222,223,218,.82); text-shadow: 0 0 2px rgba(0,0,0,.8); opacity: 0; transition: opacity .35s ease; }
#ui .s9-ammo.on { opacity: 1; transition-duration: .08s; }
#ui .s9-ammo.low { color: rgba(214,170,150,.9); }
#ui .s9-ammo .s9-res { color: rgba(170,172,166,.6); }
#ui .s9-obj { position: absolute; left: 34px; bottom: 34px; font-family: var(--s9-mono); font-size: 12px; letter-spacing: .14em;
  text-transform: uppercase; color: rgba(222,223,218,.85); text-shadow: 0 0 3px rgba(0,0,0,.9); opacity: 0; transition: opacity 1.1s ease; }
#ui .s9-obj.on { opacity: 1; transition-duration: .4s; }
#ui .s9-obj .s9-ts { color: rgba(160,163,157,.7); margin-right: 14px; }
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
  const scrLoading = el(`
    <div class="s9-screen s9-loading">
      <div class="s9-load-box">
        <div class="s9-load-title">SECTOR 9</div>
        <div class="s9-load-row"><span data-k="label">Initialisiere Aufzeichnung</span><span data-k="pct">0 %</span></div>
        <div class="s9-bar"><div data-k="bar"></div></div>
        <div class="s9-load-row"><span>${G.cameraId}</span><span>${G.caseId}</span></div>
      </div>
    </div>`);

  const scrMenu = el(`
    <div class="s9-screen s9-menu s9-hidden">
      <div class="s9-panel">
        <div class="s9-head"><span>Beweismittel-Verwaltung</span><span>${G.caseId} · ${G.cameraId}</span></div>
        <div class="s9-title">SECTOR 9</div>
        <div class="s9-sub">Einsatzaufzeichnung · stillgelegtes Werk, Halle 9</div>
        <div class="s9-sec">
          <h2>Lage</h2>
          <p>Anonymer Hinweis, 05:40 Uhr: In einem seit Jahren stillgelegten Werk halten sich mehrere bewaffnete Personen auf.
             Unterstützung ist nicht verfügbar.</p>
          <p>Auftrag: Gebäude betreten und sichern. Bewaffnete Personen ausschalten, anschließend zur Laderampe.</p>
        </div>
        <div class="s9-sec">
          <h2>Steuerung</h2>
          <div class="s9-keys">
            <kbd>W A S D</kbd><span>Bewegen</span>          <kbd>Maus</kbd><span>Umsehen</span>
            <kbd>Linke Maustaste</kbd><span>Schießen</span>  <kbd>Rechte Maustaste</kbd><span>Zielen</span>
            <kbd>R</kbd><span>Nachladen</span>              <kbd>F</kbd><span>Taschenlampe</span>
            <kbd>Shift</kbd><span>Sprinten</span>           <kbd>C</kbd><span>Ducken</span>
            <kbd>Q / E</kbd><span>Lehnen</span>             <kbd>Esc</kbd><span>Pause</span>
          </div>
        </div>
        <div class="s9-sec">
          <h2>Einstellungen</h2>
          <div class="s9-row"><span>Grafikqualität</span>
            <span class="s9-seg" data-k="quality">
              <button type="button" data-q="low">Niedrig</button><button type="button" data-q="medium">Mittel</button><button type="button" data-q="high">Hoch</button>
            </span></div>
          <div class="s9-row"><span>Lautstärke</span>
            <input class="s9-range" type="range" min="0" max="100" step="1" value="80" data-k="vol"><span class="s9-val" data-k="volv">80 %</span></div>
        </div>
        <button type="button" class="s9-btn s9-primary" data-act="start">Einsatz beginnen</button>
        <div class="s9-note" data-k="note"></div>
        <p class="s9-warn">Inhaltshinweis: Dieses Spiel zeigt realistisch dargestellte Waffengewalt und Blut.</p>
      </div>
    </div>`);

  const scrPause = el(`
    <div class="s9-screen s9-dim s9-hidden">
      <div class="s9-card">
        <div class="s9-head"><span>Aufnahme pausiert</span><span>${G.cameraId}</span></div>
        <h3>Pause</h3>
        <table class="s9-table">
          <tr><td>Verbleibende Zielpersonen</td><td data-k="left">–</td></tr>
          <tr><td>Einsatzzeit</td><td data-k="time">00:00</td></tr>
        </table>
        <button type="button" class="s9-btn s9-primary" data-act="resume">Fortsetzen</button><button type="button" class="s9-btn" data-act="restart">Neu starten</button>
        <div class="s9-note" data-k="note"></div>
      </div>
    </div>`);

  const scrDead = el(`
    <div class="s9-screen s9-dead s9-hidden">
      <div class="s9-sig">SIGNAL VERLOREN</div>
      <div class="s9-meta"><span class="s9-rec"></span>${G.cameraId} · VERBINDUNG UNTERBROCHEN · <span data-k="ts">00:00:00</span></div>
      <button type="button" class="s9-btn" data-act="retry">Erneut versuchen</button>
      <div class="s9-hint">[R] · [ENTER] · KLICK</div>
      <div class="s9-note" data-k="note"></div>
    </div>`);

  const scrDone = el(`
    <div class="s9-screen s9-dim s9-hidden">
      <div class="s9-card">
        <div class="s9-head"><span>Einsatzbericht</span><span>${G.caseId}</span></div>
        <h3>Gebäude gesichert</h3>
        <table class="s9-table">
          <tr><td>Einsatzzeit</td><td data-k="time">–</td></tr>
          <tr><td>Neutralisierte Personen</td><td data-k="kills">–</td></tr>
          <tr><td>Abgegebene Schüsse</td><td data-k="shots">–</td></tr>
          <tr><td>Trefferquote</td><td data-k="acc">–</td></tr>
        </table>
        <button type="button" class="s9-btn s9-primary" data-act="again">Neuer Einsatz</button>
        <div class="s9-note" data-k="note"></div>
      </div>
    </div>`);

  const hudAmmo = el(`<div class="s9-ammo s9-passive s9-hidden"><span data-k="mag">--</span> <span class="s9-res">/ <span data-k="res">--</span></span></div>`);
  const hudObj = el(`<div class="s9-obj s9-passive s9-hidden"><span class="s9-ts" data-k="ts"></span><span data-k="txt"></span></div>`);

  const screens = [scrLoading, scrMenu, scrPause, scrDead, scrDone];
  function showScreen(s) {
    for (const x of screens) x.classList.toggle('s9-hidden', x !== s);
    for (const x of screens) { const n = $(x, '[data-k=note]'); if (n) n.textContent = ''; }
    const hud = s === null;
    hudAmmo.classList.toggle('s9-hidden', !hud);
    hudObj.classList.toggle('s9-hidden', !hud);
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
  let objTimer = 0, radioTimer = -1;
  let ammoShowT = 0, lastAmmo = -1, lastReloading = false, lastAmmoText = '', lastResText = '', ammoOn = false, ammoLow = false;
  let quality = 'medium';
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
    const c = canvas();
    if (!c?.requestPointerLock) { ctx.input?.requestLock?.(); return; }
    try {
      const r = c.requestPointerLock();
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
      import('../world/decals.js').then((m) => m.resetGlass?.()).catch(() => {});   // restore shot-out windows
      ctx.audio?.setMuffled?.(false); ctx.pipeline?.setDead?.(false);
    }
    if (p.restart || p.first) {
      missionTime = 0; kills = 0; secured = false; deathPending = false;
      shotsBase = Number(ctx.player?.shotsFired) || 0;
      hitsBase = Number(ctx.player?.shotsHit ?? ctx.player?.hits) || 0;
      lastAmmo = -1; ammoShowT = 0;
      objective('Gebäude sichern');
      radioTimer = G.startRadioDelay;
    }
    game.state = 'playing';
    ctx.pipeline?.setMenu?.(false);
    showScreen(null);
  }

  function pause() {
    game.state = 'paused';
    ctx.pipeline?.setMenu?.(true);
    const n = ctx.enemies?.aliveCount;
    $(scrPause, '[data-k=left]').textContent = typeof n === 'number' ? String(n) : '–';
    $(scrPause, '[data-k=time]').textContent = fmtTime(missionTime);
    showScreen(scrPause);
  }

  function showDead() {
    deathPending = false;
    game.state = 'dead';
    deadShownAt = clock;
    $(scrDead, '[data-k=ts]').textContent = fmtClock(missionTime);
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
    ctx.audio?.play?.('radio', { volume: 0.8 });
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
    const act = b.dataset.act;
    if (act === 'start' && game.state === 'menu') beginPlay({ first: true });
    else if (act === 'resume' && game.state === 'paused') beginPlay({});
    else if (act === 'restart' && game.state === 'paused') beginPlay({ restart: true });
    else if (act === 'again' && game.state === 'complete') beginPlay({ restart: true });
    else if (b.dataset.q) setQuality(b.dataset.q);
    // 'retry' is handled by the global mousedown below (works with and without pointer lock)
  });

  const qBtns = scrMenu.querySelectorAll('[data-q]');
  function setQuality(q) {
    if (q !== 'low' && q !== 'medium' && q !== 'high') return;
    quality = q;
    qBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === q));
    store('s9.quality', q);
    ctx.pipeline?.setQuality?.(q);
  }
  const volInput = $(scrMenu, '[data-k=vol]'), volVal = $(scrMenu, '[data-k=volv]');
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    volInput.value = String(Math.round(volume * 100));
    volVal.textContent = `${Math.round(volume * 100)} %`;
    store('s9.volume', volume);
    ctx.audio?.setMasterVolume?.(volume);
  }
  volInput.addEventListener('input', () => setVolume(Number(volInput.value) / 100));

  function canRetry() { return game.state === 'dead' && clock - deadShownAt > G.retryGuard; }
  addEventListener('mousedown', () => { if (canRetry()) beginPlay({ restart: true }); });
  addEventListener('keydown', (e) => {
    if (!canRetry()) return;
    if (e.code === 'KeyR' || e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); beginPlay({ restart: true }); }
  });

  // ---- contract API -------------------------------------------------------------------------
  function setLoading(p, label) {
    const v = Math.min(1, Math.max(0, Number(p) || 0));
    $(scrLoading, '[data-k=bar]').style.width = `${(v * 100).toFixed(1)}%`;
    $(scrLoading, '[data-k=pct]').textContent = `${Math.round(v * 100)} %`;
    if (label) $(scrLoading, '[data-k=label]').textContent = String(label);
  }

  function ready() {
    setLoading(1, 'Bereit');
    const savedQ = load('s9.quality');
    const valid = (x) => x === 'low' || x === 'medium' || x === 'high';
    const q = valid(savedQ) ? savedQ : valid(ctx.pipeline?.quality) ? ctx.pipeline.quality : 'medium';
    quality = q;
    qBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === q));
    if (ctx.pipeline && ctx.pipeline.quality !== q) ctx.pipeline.setQuality?.(q);
    const savedV = Number(load('s9.volume'));
    setVolume(load('s9.volume') !== null && Number.isFinite(savedV) ? savedV : volume);
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
    if (game.state === 'playing') {
      missionTime += dt;
      if (deathPending) {
        deathTimer -= dt;
        if (deathTimer <= 0) showDead();
      } else {
        const en = ctx.enemies;
        if (!secured && en && typeof en.aliveCount === 'number' && en.aliveCount === 0 && (en.list?.length ?? 1) > 0) {
          secured = true;
          objective('Gebäude gesichert — zur Laderampe');
          ctx.audio?.play?.('radio');
        }
        if (secured && inExtraction()) complete();
      }
      if (radioTimer > 0 && (radioTimer -= dt) <= 0) ctx.audio?.play?.('radio', { volume: 0.7 });
    }
    if (objTimer > 0 && (objTimer -= dt) <= 0) hudObj.classList.remove('on');
    if (game.state === 'playing' || game.state === 'paused') updateHud(dt);
  }

  return game;
}
