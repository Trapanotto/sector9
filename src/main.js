import * as THREE from 'three';
import { createInput } from './core/input.js';
import { createCombat } from './core/combat.js';
import { createPipeline } from './render/pipeline.js';
import { createLevel } from './world/level.js';
import { createAudio } from './audio/audio.js';
import { createEffects } from './fx/effects.js';
import { createPlayer } from './player/player.js';
import { createEnemies } from './enemies/enemies.js';
import { createGame } from './game/game.js';

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(95, innerWidth / innerHeight, 0.03, 300);
camera.rotation.order = 'YXZ';
scene.add(camera); // viewmodel is parented to the camera

// Shared context: every module receives this and reads siblings lazily (at call time, not at creation).
const ctx = { renderer, scene, camera, input: createInput(renderer.domElement) };
window.__ctx = ctx; // debugging

async function boot() {
  ctx.game = createGame(ctx);                 // shows loading screen immediately
  ctx.audio = createAudio(ctx);
  ctx.level = await createLevel(ctx, (p, label) => ctx.game.setLoading(p, label));
  ctx.pipeline = createPipeline(ctx);
  ctx.fx = createEffects(ctx);
  ctx.combat = createCombat(ctx);
  ctx.player = createPlayer(ctx);
  ctx.enemies = createEnemies(ctx);
  ctx.game.ready();                           // loading done -> main menu

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    ctx.pipeline.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
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
  });
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('ui').innerHTML =
    `<pre style="color:#f66;padding:24px;font:14px monospace;white-space:pre-wrap">Startfehler:\n${err.stack || err}</pre>`;
});
