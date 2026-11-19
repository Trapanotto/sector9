import * as THREE from 'three';
import { createInput } from './core/input.js';
import { createCombat } from './core/combat.js';
import { createPipeline } from './render/pipeline.js';
import { createLevel } from './world/level.js';
import { createAudio, AUDIO_TUNING } from './audio/audio.js';
import { createEffects } from './fx/effects.js';
import { createPlayer } from './player/player.js';
import { createEnemies } from './enemies/enemies.js';
import { createGame } from './game/game.js';
import { prewarmBodies } from './enemies/character.js';
import { gpuInfo, detectTier, TIERS } from './render/quality.js';
import { setTextureBudget, setSurfaceQuality } from './world/materials.js';

const ui = document.getElementById('ui');
// favicon (inline: no extra request, and no 404 for /favicon.ico on the public site)
{
  const l = document.createElement('link');
  l.rel = 'icon';
  l.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#0b0c0d"/><circle cx="8" cy="8" r="3.2" fill="#c0392b"/></svg>');
  document.head.appendChild(l);
}
function fatal(title, text, reload = true) {
  ui.innerHTML = `<div style="position:absolute;inset:0;background:#050506;color:#d9dbd5;display:flex;align-items:center;justify-content:center;
    font:13px 'Segoe UI',Arial,sans-serif;text-align:left"><div style="max-width:440px;padding:24px">
    <div style="font-weight:600;font-size:12px;letter-spacing:.5em;margin-bottom:18px">SECTOR 9</div>
    <div style="font-size:15px;margin-bottom:8px">${title}</div><div style="color:#8b8f88;line-height:1.55">${text}</div>
    ${reload ? '<button onclick="location.reload()" style="margin-top:20px;background:#d9dbd5;color:#0b0c0d;border:0;padding:10px 22px;font:12px monospace;letter-spacing:.2em;cursor:pointer">NEU LADEN</button>' : ''}
    </div></div>`;
}

// ---- hardware: decide the starting tier before anything large (textures, render targets) is allocated
const info = gpuInfo();
if (!info.webgl2) {
  fatal('WebGL 2 ist nicht verfügbar.', 'Dieser Browser oder Grafiktreiber unterstützt kein WebGL 2. Bitte einen aktuellen Chrome, Edge oder Firefox verwenden und die Hardwarebeschleunigung in den Browsereinstellungen aktivieren.', false);
  throw new Error('no WebGL2');
}
const hw = detectTier(info);
let saved = null;
try { saved = localStorage.getItem('s9.quality'); } catch { /* storage blocked */ }
const forced = new URLSearchParams(location.search).get('q');                       // test hook: ?q=minimal
const start = TIERS.includes(forced) ? forced : TIERS.includes(saved) ? saved : hw.tier;
hw.tier = start;
hw.ceiling = /Software/.test(hw.why) ? 'low' : 'high';
const low = TIERS.indexOf(start) <= 1;
setTextureBudget(start === 'minimal' ? 512 : start === 'low' ? 1024 : 0, low ? 4 : 16);
setSurfaceQuality(low);
if (low) { AUDIO_TUNING.panningModel = 'equalpower'; AUDIO_TUNING.maxVoices = 40; }
console.info(`[quality] start tier ${start} (${hw.why}; GPU "${hw.gpu}", ${hw.cores} threads, ${hw.mem} GB)`);

const app = document.getElementById('app');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  fatal('Grafik konnte nicht gestartet werden.', 'WebGL 2 wurde vom Browser abgelehnt (' + (e.message || e) + '). Bitte Hardwarebeschleunigung aktivieren oder den Browser neu starten.');
  throw e;
}
// weak GPUs render at device pixel ratio 1 (the pipeline also scales its internal resolution per tier)
renderer.setPixelRatio(Math.min(devicePixelRatio, low ? 1 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  try { ctx.audio?.setMuffled?.(true); } catch { /* ignore */ }
  fatal('Die Grafikkarte hat die Verbindung verloren.', 'Das passiert auf schwächeren Geräten, wenn der Grafikspeicher knapp wird. Neu laden; falls es wieder passiert, unter Einstellungen die Grafik auf „Sehr niedrig“ stellen.');
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(95, innerWidth / innerHeight, 0.03, 300);
camera.rotation.order = 'YXZ';
scene.add(camera); // viewmodel is parented to the camera

// Shared context: every module receives this and reads siblings lazily (at call time, not at creation).
const ctx = { renderer, scene, camera, input: createInput(renderer.domElement), hardware: hw };
window.__ctx = ctx; // debugging

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

async function boot() {
  ctx.game = createGame(ctx);                 // shows loading screen immediately
  ctx.audio = createAudio(ctx);
  // level: textures 0..0.6, build + light bake up to ~0.9 (labels come from the level)
  ctx.level = await createLevel(ctx, (p, label) => ctx.game.setLoading(p * 0.62, label));
  ctx.game.setLoading(0.63, 'Kamera'); await yieldFrame();
  ctx.pipeline = createPipeline(ctx);
  ctx.fx = createEffects(ctx);
  ctx.combat = createCombat(ctx);
  ctx.game.setLoading(0.65, 'Ausrüstung'); await yieldFrame();
  let t = performance.now();
  ctx.player = createPlayer(ctx);
  const tPlayer = performance.now() - t;
  t = performance.now();
  await prewarmBodies((i, n) => ctx.game.setLoading(0.67 + 0.32 * (i / n), 'Personen'));
  ctx.enemies = createEnemies(ctx);
  window.__boot = { player: Math.round(tPlayer), enemies: Math.round(performance.now() - t), total: Math.round(performance.now()) };
  console.info("[boot]", JSON.stringify(window.__boot));
  ctx.game.setLoading(1, 'Bereit'); await yieldFrame();
  ctx.game.ready();                           // loading done -> main menu

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    ctx.pipeline.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  // ctx.step(dt): one frame with a given dt (tests drive this directly while the tab is hidden and rAF is paused)
  const step = ctx.step = (dt) => {
    const playing = ctx.game.state === 'playing';
    if (playing) {
      ctx.player.update(dt);
      ctx.enemies.update(dt);
    }
    ctx.level.update(dt);
    ctx.fx.update(dt);
    ctx.audio.update(dt);
    ctx.game.update(dt);
    ctx.pipeline.render(dt);
    ctx.input.endFrame();
  };
  renderer.setAnimationLoop(() => step(Math.min(clock.getDelta(), 0.05)));
}

boot().catch((err) => {
  console.error(err);
  fatal('Startfehler', `<pre style="white-space:pre-wrap;font:11px monospace;color:#c98">${String(err.stack || err).replace(/</g, '&lt;')}</pre>`);
});
