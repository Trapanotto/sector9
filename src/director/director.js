// STUB (workstream F replaces this with the real director, mission flow and the final German UI; keep the
// factory name). Minimal: loading bar, start screen (Einsatz beginnen / Einstellungen / Steuerung), pause,
// death / restart, extraction → "Einsatz beendet", and a first cut of the staged moments using the world API.
import { MODES } from '../render/quality.js';
import { BINDING_NAMES } from '../core/settings.js';

const CSS = `
#ui .s9-screen{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#e8e8e8;font:15px/1.5 system-ui,sans-serif}
#ui .s9-card{min-width:320px;max-width:560px;padding:28px 34px;background:rgba(8,10,12,.88);border:1px solid #333}
#ui h1{margin:0;font:700 44px/1 "Arial Narrow",Arial,sans-serif;letter-spacing:.12em}
#ui h2{margin:0 0 12px;font-size:20px}
#ui .sub{margin:6px 0 22px;color:#9aa;font-size:13px;letter-spacing:.08em}
#ui button{display:block;width:100%;margin:8px 0;padding:10px 14px;font:inherit;text-align:left;background:#15181b;color:#fff;border:1px solid #3a3f44;cursor:pointer}
#ui button:hover{background:#22272c}
#ui label{display:flex;justify-content:space-between;gap:16px;margin:8px 0;align-items:center}
#ui table{border-collapse:collapse;width:100%;font-size:13px} #ui td{padding:3px 6px;border-bottom:1px solid #222}
#ui .bar{height:4px;background:#222;margin-top:14px} #ui .bar>div{height:100%;width:0;background:#c9d2d6}
#ui .hud{position:fixed;left:18px;bottom:14px;font:600 14px Consolas,monospace;color:#ddd;text-shadow:0 0 3px #000;pointer-events:none;display:none}
`;

export function createDirector(ctx) {
  const ui = document.getElementById('ui');
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const screens = {};
  const screen = (id, html) => { const d = document.createElement('div'); d.className = 's9-screen'; d.id = `s9-${id}`; d.innerHTML = `<div class="s9-card">${html}</div>`; ui.appendChild(d); screens[id] = d; return d; };
  const show = (id) => { for (const [k, d] of Object.entries(screens)) d.style.display = k === id ? 'flex' : 'none'; };

  screen('loading', `<h1>SECTOR 9</h1><div class="sub">BODYCAM · EINSATZ LOGISTIKZENTRUM</div><div id="s9-load-label">Lade …</div><div class="bar"><div id="s9-load-bar"></div></div>`);
  screen('menu', `<h1>SECTOR 9</h1><div class="sub">BODYCAM · EINSATZ LOGISTIKZENTRUM HAFENSTRASSE</div>
    <button data-a="start">Einsatz beginnen</button><button data-a="settings">Einstellungen</button><button data-a="controls">Steuerung</button>`);
  screen('settings', `<h2>Einstellungen</h2>
    <label>Grafikqualität <select id="s9-q">${MODES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
    <label>Mausempfindlichkeit <input id="s9-sens" type="range" min="0.2" max="3" step="0.05"></label>
    <label>Maus Y invertieren <input id="s9-inv" type="checkbox"></label>
    <label>Sichtfeld (°) <input id="s9-fov" type="range" min="95" max="125" step="1"></label>
    <label>Lautstärke <input id="s9-vol" type="range" min="0" max="1" step="0.05"></label>
    <div class="sub" id="s9-gpu"></div><button data-a="back">Zurück</button>`);
  screen('controls', `<h2>Steuerung</h2><table id="s9-keys"></table><button data-a="back">Zurück</button>`);
  screen('pause', `<h2>Pausiert</h2><button data-a="resume">Weiter</button><button data-a="settings">Einstellungen</button><button data-a="controls">Steuerung</button><button data-a="menu">Einsatz abbrechen</button>`);
  screen('dead', `<h2>Einsatz gescheitert</h2><p>Du wurdest getroffen.</p><button data-a="retry">Neu starten</button><button data-a="menu">Hauptmenü</button>`);
  screen('done', `<h2>Einsatz beendet</h2><p id="s9-done-text"></p><button data-a="menu">Hauptmenü</button>`);
  const hud = document.createElement('div'); hud.className = 'hud'; ui.appendChild(hud);

  let back = 'menu';
  const fmt = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', 'Pfeil ').replace('Left', ' links').replace('Right', ' rechts').replace('Backquote', '^');
  function fillSettings() {
    const s = ctx.settings.data;
    ui.querySelector('#s9-q').value = ctx.quality.mode;
    ui.querySelector('#s9-sens').value = s.sensitivity; ui.querySelector('#s9-inv').checked = !!s.invertY;
    ui.querySelector('#s9-fov').value = s.fov; ui.querySelector('#s9-vol').value = s.volume;
    ui.querySelector('#s9-gpu').textContent = `GPU: ${ctx.quality.gpu.renderer || 'unbekannt'} → ${ctx.quality.tier.name}`;
    ui.querySelector('#s9-keys').innerHTML = Object.entries(BINDING_NAMES).map(([k, n]) => `<tr><td>${n}</td><td>${ctx.settings.keys(k).map(fmt).join(' / ')}</td></tr>`).join('')
      + '<tr><td>Schießen</td><td>Linke Maustaste</td></tr>';
  }
  ui.addEventListener('change', (e) => {
    const s = ctx.settings.data, t = e.target;
    if (t.id === 's9-q') ctx.quality.setMode(t.value);
    if (t.id === 's9-inv') s.invertY = t.checked;
    ctx.settings.save();
  });
  ui.addEventListener('input', (e) => {
    const s = ctx.settings.data, t = e.target;
    if (t.id === 's9-sens') s.sensitivity = +t.value;
    if (t.id === 's9-fov') s.fov = +t.value;
    if (t.id === 's9-vol') ctx.audio.setVolume(+t.value);
    ctx.settings.save();
  });
  const startPlay = async () => {
    ctx.audio.unlock();
    try { await ctx.input.requestLock(); } catch { /* lock refused: stay in menu */ return; }
    ctx.setState('playing');
  };
  ui.addEventListener('click', (e) => {
    const a = e.target?.dataset?.a; if (!a) return;
    if (a === 'start') { ctx.restart(); startPlay(); }
    if (a === 'resume') startPlay();
    if (a === 'retry') { ctx.restart(); startPlay(); }
    if (a === 'settings') { back = ctx.state === 'paused' ? 'pause' : 'menu'; fillSettings(); show('settings'); }
    if (a === 'controls') { back = ctx.state === 'paused' ? 'pause' : 'menu'; fillSettings(); show('controls'); }
    if (a === 'back') show(back);
    if (a === 'menu') { ctx.input.exitLock(); ctx.setState('menu'); }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !window.__fakeLock && ctx.state === 'playing') ctx.setState('paused');
  });

  const d = { id: 'director', order: ctx.ORDER.director, moments: new Map() };
  ctx.events.on('load:progress', ({ p, label }) => {
    const bar = ui.querySelector('#s9-load-bar'); if (bar) bar.style.width = `${(p * 100).toFixed(0)}%`;
    const l = ui.querySelector('#s9-load-label'); if (l) l.textContent = `Lade … ${(p * 100).toFixed(0)} %`;
  });
  ctx.events.on('state', ({ to }) => {
    hud.style.display = to === 'playing' ? 'block' : 'none';
    if (to === 'loading') show('loading');
    else if (to === 'menu') show('menu');
    else if (to === 'paused') show('pause');
    else if (to === 'dead') { ctx.input.exitLock(); show('dead'); }
    else if (to === 'done') {
      ctx.input.exitLock();
      const killed = ctx.enemies.list.filter((e) => e.dead).length;
      ui.querySelector('#s9-done-text').textContent = `Zeit ${Math.floor(ctx.time.mission / 60)}:${String(Math.floor(ctx.time.mission % 60)).padStart(2, '0')} · Tatverdächtige ausgeschaltet: ${killed}/${ctx.enemies.list.length}`;
      show('done');
    } else show(null);
  });
  show('loading');

  // ---- staged moments: first cut so the hooks are exercised; F owns timing, audio and acting
  const beats = {
    m02_tor_faellt: () => ctx.world.doors.set('d_dock2', 'closed', { speed: 0.9 }),
    m03_packerei: () => ctx.enemies.alert(['e06', 'e07', 'e08']),
    m04_keller_licht: () => ctx.world.lights.setCircuit('keller', 0, 0.6, 1),
    m05_halle_dunkel: () => ctx.world.lights.setCircuit('halle', 0.0, 1.5, 1),
    m06_foerderband: () => ctx.machines.conveyor('c_loop')?.start(),
    m07_agv: () => ctx.machines.agv('agv2')?.dispatch(),
    m08_schrei: () => { ctx.world.doors.set('d_geld', 'locked'); ctx.audio.playAt('scream_male', { x: 4.5, y: 5.5, z: 5 }); },
    m09_roboter: () => ctx.machines.robot('roboter1')?.start(),
    m10_kuehl: () => ctx.world.doors.set('d_kuehl', 'open'),
  };
  ctx.events.on('trigger:enter', (t) => {
    if (t.id === 'extract') { ctx.setState('done'); return; }
    if (!t.first) return;
    console.info(`[director] Moment ${t.id}: ${t.def.title}`);
    beats[t.id]?.();
    ctx.events.emit('moment', { id: t.id, def: t.def });
  });

  d.update = () => {
    if (ctx.state === 'playing') {
      if (ctx.input.hit('pause') && window.__fakeLock) ctx.setState('paused');
      const a = ctx.weapon.ammo, r = ctx.weapon.reserve, h = Math.max(0, Math.round(ctx.player.health));
      if (a !== last.a || r !== last.r || h !== last.h) { last.a = a; last.r = r; last.h = h; hud.textContent = `${a} | ${r}   ${h} HP`; }
    }
  };
  const last = { a: -1, r: -1, h: -1 };
  d.reset = () => {};
  return d;
}
