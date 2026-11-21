// Minimal German UI (DOM): loading, start screen over the live blurred scene, settings, controls, pause, death,
// debrief, and the in-play bodycam OSD extras (faint objective line, ammo only while reloading/checking, radio
// subtitle). DOM writes only when text changes; no layout work per frame. Owner: F.
import { MODES } from '../render/quality.js';
import { BINDING_NAMES } from '../core/settings.js';
import { keyName } from './keys.js';

const CSS = `
#ui{--fg:#e7e7e3;--mut:#8d928e;--dim:#5d625f;--line:rgba(255,255,255,.16);--hi:rgba(255,255,255,.08);
  --ui:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,"DejaVu Sans Mono",Menlo,monospace;color:var(--fg);font:14px/1.45 var(--ui)}
#ui *{box-sizing:border-box}
#ui .s9-scr{position:fixed;inset:0;display:none;overflow:hidden;font-size:clamp(14px,1.95vh,19px)}
#ui .s9-scr.on{display:block}
#ui .s9-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(4,5,6,.84) 0,rgba(4,5,6,.7) min(46em,70vw),rgba(4,5,6,.4) 100%);
  -webkit-backdrop-filter:blur(5px) saturate(.7) brightness(.85);backdrop-filter:blur(5px) saturate(.7) brightness(.85)}
#ui .s9-dark .s9-shade{background:rgba(3,4,5,.8)}
#ui .s9-col{position:absolute;left:clamp(16px,9vw,10em);top:50%;transform:translateY(-50%);width:min(38.5em,calc(100vw - 32px))}
#ui h1{margin:0;font:600 clamp(40px,7.2vh,76px)/1 var(--ui);letter-spacing:.2em;margin-right:-.2em}
#ui h2{margin:0 0 .82em;font:500 1.57em/1.2 var(--ui);letter-spacing:.02em}
#ui .s9-brief{margin:1.15em 0 2.15em;color:#a3a8a4;max-width:33.5em;font-size:1em;line-height:1.55}
#ui button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
#ui .s9-btn{display:inline-flex;align-items:center;gap:.93em;height:2.8em;padding:0 1.33em;border:1px solid rgba(255,255,255,.55);font-size:1.07em;letter-spacing:.02em}
#ui .s9-btn:hover,#ui .s9-btn:focus-visible{background:var(--hi);border-color:#fff;outline:none}
#ui .s9-btn kbd{font:.73em var(--mono);color:var(--mut)}
#ui .s9-links{margin-top:1.33em;display:flex;gap:.45em 1.63em;flex-wrap:wrap;color:var(--mut);font-size:.96em}
#ui .s9-links button:hover,#ui .s9-links button:focus-visible{color:var(--fg);outline:none;text-decoration:underline;text-underline-offset:3px}
#ui .s9-foot{position:absolute;left:clamp(16px,9vw,10em);right:16px;bottom:1em;color:#6f746f;font-size:1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ui .s9-load{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center}
#ui .s9-load h1{font-size:clamp(30px,5vh,52px)}
#ui .s9-line{width:12.9em;height:1px;margin:1.57em auto .71em;background:var(--line)}
#ui .s9-line>i{display:block;height:1px;width:0;background:#d8dcd9;transition:width .15s linear}
#ui .s9-word{font:.79em var(--mono);letter-spacing:.24em;color:var(--mut);text-transform:uppercase;height:1.3em}
#ui .s9-rows{display:grid;grid-template-columns:minmax(8.6em,1fr) minmax(15.7em,19.4em);gap:0 1.3em;align-items:center}
#ui .s9-rows>label{color:#9a9f9b;height:2.5em;display:flex;align-items:center;font-size:.96em}
#ui .s9-rows>div{height:2.43em;display:flex;align-items:center;gap:.7em;min-width:0}
#ui .s9-seg{display:flex;border:1px solid var(--line);height:1.86em;width:100%}
#ui .s9-seg button{flex:1;font-size:.89em;color:#a3a8a4;min-width:0;padding:0 4px;white-space:nowrap}
#ui .s9-seg button+button{border-left:1px solid var(--line)}
#ui .s9-seg button.on{background:#e7e7e3;color:#0b0c0d}
#ui .s9-seg button:focus-visible{outline:1px solid #fff;outline-offset:-2px}
#ui select{width:100%;height:1.86em;background:rgba(10,11,12,.8);color:var(--fg);border:1px solid var(--line);font:.89em var(--ui);padding:0 6px}
#ui input[type=range]{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:1.3em;background:none;margin:0}
#ui input[type=range]::-webkit-slider-runnable-track{height:1px;background:rgba(255,255,255,.35)}
#ui input[type=range]::-moz-range-track{height:1px;background:rgba(255,255,255,.35)}
#ui input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-5px;border-radius:50%;background:#e7e7e3;border:0}
#ui input[type=range]::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:#e7e7e3;border:0}
#ui input[type=range]:focus-visible{outline:none}
#ui input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px rgba(255,255,255,.3)}
#ui .s9-val{font:.86em var(--mono);color:var(--mut);width:3.6em;text-align:right;flex:none}
#ui .s9-note{grid-column:1/-1;font:.79em var(--mono);color:#737873;height:1.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ui table{border-collapse:collapse;width:100%;font-size:.93em}
#ui td{height:1.77em;padding:0 .8em 0 0;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
#ui td:first-child{color:#9a9f9b;width:46%}
#ui td kbd{font:.92em var(--mono);color:var(--fg)}
#ui th{font:500 .85em var(--mono);color:#737873;text-align:left;letter-spacing:.12em;height:1.9em;text-transform:uppercase}
#ui .s9-back{margin-top:1.57em}
#ui .s9-big{font:500 1.86em/1.2 var(--ui);margin:0}
#ui .s9-hint{margin-top:1.15em;display:flex;flex-wrap:wrap;gap:.45em 1.7em;font-size:.93em;color:#9a9f9b}
#ui .s9-hint button:hover,#ui .s9-hint button:focus-visible{color:var(--fg);outline:none}
#ui .s9-hint kbd{font:.85em var(--mono);color:var(--fg);border:1px solid var(--line);padding:1px 5px;margin-right:.45em}
#ui .s9-fig{display:grid;grid-template-columns:10.7em 1fr;gap:0 1.15em;margin:.43em 0 .3em}
#ui .s9-fig>div{height:2.14em;display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap;overflow:hidden}
#ui .s9-fig>div:nth-child(odd){color:#9a9f9b;font-size:.93em}
#ui .s9-fig>div:nth-child(even){font-family:var(--mono);font-size:.93em}
#ui .s9-sub{color:#9a9f9b;margin:-.7em 0 1em;min-height:1.43em;font-size:.93em}
#ui .s9-obj-p{font:.86em var(--mono);color:#9a9f9b;letter-spacing:.06em;text-transform:uppercase;margin:-.55em 0 1.6em;height:1.2em}
#ui .hud{position:fixed;inset:0;pointer-events:none;display:none}
#ui .hud.on{display:block}
#ui .s9-osd{position:absolute;left:2.5vh;font:600 1.78vh/1 var(--mono);letter-spacing:.04em;color:#fff;text-transform:uppercase;
  text-shadow:0 0 2px #000,0 0 2px #000,1px 1px 0 #000;white-space:nowrap;transition:opacity .6s}
#ui #s9-obj{top:8.1vh;opacity:.5}
#ui #s9-ammo{top:10.9vh;opacity:0}
#ui #s9-radio{position:absolute;left:50%;bottom:8vh;transform:translateX(-50%);max-width:72vw;text-align:center;font:500 1.9vh/1.35 var(--mono);color:#f2f2ee;
  text-shadow:0 0 3px #000,0 0 3px #000;opacity:0;transition:opacity .35s;white-space:normal;text-wrap:balance}
#ui #s9-radio b{font-weight:600;color:#bfc6c2;margin-right:.6em}
`;

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const num = (v, d = 2) => v.toFixed(d).replace('.', ',');
const LOAD_WORDS = [[0.3, 'Gelände'], [0.6, 'Beleuchtung'], [0.92, 'Einsatzmittel'], [1.01, 'Kalibrierung']];

export function createUI(ctx, act) {
  const root = document.getElementById('ui');
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const screens = {};
  const scr = (id, html, cls = '') => {
    const el = h(`<div class="s9-scr ${cls}" id="s9-${id}"><div class="s9-shade"></div>${html}</div>`);
    root.appendChild(el); screens[id] = el; return el;
  };

  scr('loading', `<div class="s9-load"><h1>SECTOR 9</h1><div class="s9-line"><i id="s9-bar"></i></div><div class="s9-word" id="s9-word">Lade</div></div>`, 's9-dark');
  scr('menu', `<div class="s9-col">
      <h1>SECTOR 9</h1>
      <p class="s9-brief">Logistikzentrum Hafenstraße, 15:40. Der Objektschutz meldet sich nicht mehr, auf dem Gelände sollen Bewaffnete sein.
        Lage klären, Beweise sichern – Verstärkung frühestens in zwanzig Minuten.</p>
      <button class="s9-btn" data-a="start">Einsatz beginnen <kbd>Enter</kbd></button>
      <div class="s9-links"><button data-a="settings">Einstellungen</button><button data-a="controls">Steuerung</button></div>
    </div>
    <div class="s9-foot"><span style="font-size:.82em">Fiktives Szenario · enthält realistische Darstellung von Schusswaffengewalt · nicht für Kinder geeignet · Esc pausiert</span></div>`);
  scr('settings', `<div class="s9-col"><h2>Einstellungen</h2><div class="s9-rows" id="s9-set"></div>
      <div class="s9-links s9-back"><button data-a="back">Zurück <span style="font:11px var(--mono);color:var(--dim)">Esc</span></button></div></div>`);
  scr('controls', `<div class="s9-col"><h2>Steuerung</h2><table id="s9-keys"></table>
      <div class="s9-links s9-back"><button data-a="back">Zurück <span style="font:11px var(--mono);color:var(--dim)">Esc</span></button></div></div>`);
  scr('pause', `<div class="s9-col"><h2>Pausiert</h2><div class="s9-obj-p" id="s9-pobj"></div>
      <button class="s9-btn" data-a="resume">Weiter <kbd>Enter</kbd></button>
      <div class="s9-links"><button data-a="settings">Einstellungen</button><button data-a="controls">Steuerung</button><button data-a="abort">Einsatz abbrechen</button></div>
      <div class="s9-sub" id="s9-phint" style="margin-top:14px"></div></div>`);
  scr('dead', `<div class="s9-col"><p class="s9-big" id="s9-dline">Einsatz gescheitert.</p>
      <div class="s9-hint"><button data-a="retry"><kbd>Enter</kbd><span id="s9-rtxt">erneut</span></button><button data-a="restart" id="s9-rfull"><kbd>R</kbd>von vorn</button><button data-a="menu"><kbd>Esc</kbd>Hauptmenü</button></div></div>`, 's9-dark');
  scr('done', `<div class="s9-col"><h2 id="s9-dtitle">Einsatz beendet</h2><div class="s9-sub" id="s9-dsub"></div><div class="s9-fig" id="s9-fig"></div>
      <div class="s9-hint" style="margin-top:22px"><button data-a="again"><kbd>Enter</kbd>neuer Einsatz</button><button data-a="menu"><kbd>Esc</kbd>Hauptmenü</button></div></div>`, 's9-dark');
  const hud = h(`<div class="hud"><div class="s9-osd" id="s9-obj"></div><div class="s9-osd" id="s9-ammo"></div><div id="s9-radio"></div></div>`);
  root.appendChild(hud);
  const $ = (id) => root.querySelector(`#${id}`);
  const elObj = $('s9-obj'), elAmmo = $('s9-ammo'), elRadio = $('s9-radio');

  // ---------------------------------------------------------------------------------------------- settings
  const S = () => ctx.settings.data;
  const seg = (key, opts) => `<div class="s9-seg" data-seg="${key}">${opts.map(([v, n]) => `<button data-v="${v}">${n}</button>`).join('')}</div>`;
  const range = (key, min, max, step) => `<input type="range" data-r="${key}" min="${min}" max="${max}" step="${step}" aria-label="${key}"><span class="s9-val" data-rv="${key}"></span>`;
  const HOLD = [['hold', 'Halten'], ['toggle', 'Umschalten']];
  $('s9-set').innerHTML = `
    <label>Grafik</label><div><select data-sel="quality" aria-label="Grafik">${MODES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
    <div class="s9-note" id="s9-gpu"></div>
    <label>Maus-Empfindlichkeit</label><div>${range('sensitivity', 0.2, 3, 0.05)}</div>
    <label>Free-Aim</label><div>${seg('freeAim', [['off', 'aus'], ['low', 'gering'], ['standard', 'standard'], ['strong', 'stark']])}</div>
    <label>Ducken</label><div>${seg('crouchMode', HOLD)}</div>
    <label>Zielen</label><div>${seg('aimMode', HOLD)}</div>
    <label>Laufen</label><div>${seg('sprintMode', HOLD)}</div>
    <label>Lautstärke gesamt</label><div>${range('volume', 0, 1, 0.05)}</div>
    <label>Effekte</label><div>${range('volumeSfx', 0, 1, 0.05)}</div>
    <label>Stimmen</label><div>${range('volumeVoice', 0, 1, 0.05)}</div>
    <label>Gesichter verpixeln</label><div>${seg('pixelateFaces', [['true', 'an'], ['false', 'aus']])}</div>`;
  const fmtVal = (k, v) => (k === 'sensitivity' ? num(+v) : `${Math.round(v * 100)} %`);
  function fillSettings() {
    const s = S();
    root.querySelector('[data-sel=quality]').value = ctx.quality?.mode ?? s.quality ?? 'auto';
    for (const el of root.querySelectorAll('[data-r]')) { el.value = s[el.dataset.r]; root.querySelector(`[data-rv=${el.dataset.r}]`).textContent = fmtVal(el.dataset.r, s[el.dataset.r]); }
    for (const el of root.querySelectorAll('[data-seg]')) for (const b of el.children) b.classList.toggle('on', String(s[el.dataset.seg]) === b.dataset.v);
    const q = ctx.quality;
    $('s9-gpu').textContent = q ? `${q.mode === 'auto' ? 'Automatisch → ' : ''}${q.tier?.name ?? ''} · ${q.gpu?.renderer || 'GPU unbekannt'}` : '';
  }
  root.addEventListener('input', (e) => {
    const k = e.target.dataset?.r; if (!k) return;
    const v = +e.target.value;
    root.querySelector(`[data-rv=${k}]`).textContent = fmtVal(k, v);
    act.setting(k, v);
  });
  root.addEventListener('change', (e) => { if (e.target.dataset?.sel === 'quality') { act.setting('quality', e.target.value); fillSettings(); } });
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('button'); if (!b || !root.contains(b)) return;
    const sg = b.parentElement?.dataset?.seg;
    if (sg) { const v = b.dataset.v; act.setting(sg, v === 'true' ? true : v === 'false' ? false : v); fillSettings(); return; }
    const a = b.dataset.a; if (a) act.click(a);
  });

  function fillControls() {
    const rows = Object.entries(BINDING_NAMES).map(([k, n]) => {
      const ks = ctx.settings.keys(k);
      return `<tr><td>${n}</td><td><kbd>${keyName(ks[0])}</kbd></td><td><kbd>${keyName(ks[1])}</kbd></td></tr>`;
    }).join('');
    $('s9-keys').innerHTML = `<tr><th>Aktion</th><th>Tasten 1</th><th>Tasten 2</th></tr>${rows}
      <tr><td>Schießen</td><td><kbd>Linke Maustaste</kbd></td><td></td></tr><tr><td>Zielen</td><td><kbd>Rechte Maustaste</kbd></td><td></td></tr>`;
  }

  // ---------------------------------------------------------------------------------------------- screens
  let current = null;
  const ui = {
    get current() { return current; },
    show(id) {
      current = id;
      for (const [k, el] of Object.entries(screens)) el.classList.toggle('on', k === id);
      hud.classList.toggle('on', id === null && ctx.state === 'playing');
      if (id === 'settings') fillSettings();
      if (id === 'controls') fillControls();
      const first = id && screens[id].querySelector('.s9-btn, button');
      if (first && id !== 'loading') first.focus({ preventScroll: true });
    },
    setLoad(p) {
      $('s9-bar').style.width = `${Math.round(p * 100)}%`;
      const w = LOAD_WORDS.find(([t]) => p < t)?.[1] ?? 'Kalibrierung';
      const el = $('s9-word'); if (el.textContent !== w) el.textContent = w;
    },
    loadWord(w) { $('s9-word').textContent = w; },
    pauseInfo(obj, hint = '') { $('s9-pobj').textContent = obj ? `▸ ${obj}` : ''; $('s9-phint').textContent = hint; },
    dead(line, cpName) {
      $('s9-dline').textContent = line;
      $('s9-rtxt').textContent = cpName ? `erneut ab ${cpName}` : 'erneut';
      $('s9-rfull').style.display = cpName ? '' : 'none';
    },
    done(d) {
      $('s9-dtitle').textContent = d.title; $('s9-dsub').textContent = d.sub;
      $('s9-fig').innerHTML = d.rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('');
    },
    hudOn(on) { hud.classList.toggle('on', on); },
    // ---- OSD extras (call only on change)
    objective(text) { const t = text ? `▸ ${text}` : ''; if (elObj.textContent !== t) elObj.textContent = t; },
    ammo(text) { if (text) elAmmo.textContent = text; elAmmo.style.opacity = text ? '0.55' : '0'; },
    radio(speaker, text) {
      if (!text) { elRadio.style.opacity = '0'; return; }
      elRadio.innerHTML = ''; const b = document.createElement('b'); b.textContent = speaker.toUpperCase();
      elRadio.append(b, document.createTextNode(text)); elRadio.style.opacity = '1';
    },
    fillSettings,
  };
  return ui;
}
