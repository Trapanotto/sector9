# SECTOR 9 — module contract

Original single-player bodycam-style tactical FPS for the browser. Setting: abandoned factory, overcast daylight.
One mission: clear the building of armed hostiles, then reach extraction. One or two hits kill (both sides), die-and-retry.
It is an ORIGINAL game: do not use the name, logo, characters, levels or story of any existing game.

Stack: Vite + `three@0.170` (npm, ES modules, `three/addons/...` for examples). WebGL2 `WebGLRenderer`. No other dependencies.
Units: metres, Y up, right-handed. Player eye height 1.68 standing. UI text in German, code/comments in English.

Already written, do not edit (read them first): `index.html`, `src/main.js`, `src/core/input.js`, `src/core/combat.js`.
`main.js` builds a shared `ctx` and calls every module's factory with it. Read sibling modules from `ctx` lazily
(inside functions, at call time), never at creation time: creation order is
game → audio → level → pipeline → fx → combat → player → enemies.

`ctx = { renderer, scene, camera, input, game, audio, level, pipeline, fx, combat, player, enemies }`

Per frame (main.js): `player.update, enemies.update` (only while `game.state === 'playing'`), then
`level.update, fx.update, audio.update, game.update, pipeline.render`, then `input.endFrame()`.

Each owner writes ONLY inside its own folder. Exact exports and shapes below are binding; extra fields are fine.

## src/render/pipeline.js — `createPipeline(ctx)` (owner: render)
Owns all post-processing and the bodycam OSD inside `#overlay`. `renderer.toneMapping` etc. are yours to set.
```
{ render(dt), setSize(w, h),
  addTrauma(amount 0..1),        // camera-shake/glitch energy, decays by itself (shots, hits, landing)
  flash(amount 0..1),            // sensor over-exposure burst (muzzle flash), decays fast
  damage(amount 0..1),           // red/desaturated hit vignette pulse
  setDead(bool),                 // death look: camera on the floor look is done by player; here desaturate/blur/signal loss
  setMenu(bool),                 // true: softer/blurred "standby" look behind menus
  quality: 'low'|'medium'|'high', setQuality(q) }
```
The pipeline must NOT move the camera; the player owns the camera transform. Shake that is purely image-space is fine.

## src/world/ — `createLevel(ctx, onProgress(p 0..1, label))` async (owner: world)
Builds geometry, materials, lights, sky/environment, fog and adds them to `ctx.scene`. Also owns `scripts/fetch-assets.mjs`
and everything under `public/assets/`.
```
{ colliders: THREE.Box3[],            // static, axis-aligned solids (walls, crates, machines). Floors are NOT colliders.
  raycastMeshes: THREE.Object3D[],    // everything bullets and line-of-sight should hit (incl. floors/ceilings); keep it lean
  surfaceOf(object3D) -> 'concrete'|'metal'|'wood',   // reads object.userData.surface up the parent chain, default 'concrete'
  groundHeight(x, z) -> number,       // floor y at this position (0 on the main floor; supports ramps/stairs/platforms if any)
  playerSpawn: { position: Vector3 (feet), yaw: number },   // yaw 0 looks toward -Z
  enemySpawns: [{ position: Vector3 (feet), yaw, patrol?: Vector3[], type?: 'guard'|'patrol' }],   // 8–10 spawns
  navGraph: { nodes: Vector3[], edges: [number, number][] },   // walkable waypoint graph covering all rooms/doorways
  coverPoints: Vector3[],             // spots next to solid cover
  extraction: THREE.Box3,             // reach this after all hostiles are down
  bounds: THREE.Box3,
  update(dt) }                        // flickering lights, dust, swaying cables
```
All walls must be axis-aligned boxes so AABB collision works. Doorways ≥ 1.1 m wide, ceilings ≥ 3 m. Tag meshes with `userData.surface`.

## src/audio/audio.js — `createAudio(ctx)` (owner: fxaudio)
Fully procedural WebAudio (no audio files). Positional via PannerNode, listener follows `ctx.camera`.
```
{ resume(),                                   // call on first user gesture
  play(name, { position?: Vector3, volume?: number, pitch?: number }),
  update(dt), setMuffled(bool), setMasterVolume(v) }
```
Names: `shot`, `shot_enemy`, `dry`, `reload_out`, `reload_in`, `slide`, `step_concrete`, `step_metal`, `land`,
`impact_concrete`, `impact_metal`, `impact_wood`, `impact_flesh`, `hurt`, `death`, `body_fall`, `shell`, `shout`, `radio`, `ui_click`.
Unknown names must be a silent no-op. Also runs a looping ambience bed (wind, distant hum, room tone) once resumed.
Everything should sound like it was recorded by a cheap bodycam mic: compressed, clipped loud transients, slight band-limit.

## src/fx/effects.js — `createEffects(ctx)` (owner: fxaudio)
Pooled, allocation-free in steady state.
```
{ impact(point, normal, surface),     // dust puff, sparks on metal, bullet-hole decal, debris
  blood(point, dir),                  // spray particles + wall/floor splatter decals behind the hit along dir
  bloodPool(position),                // slowly growing pool decal under a body
  muzzleFlash(position, dir),         // short point-light flash + sprite + smoke wisp
  tracer(from, to),                   // very subtle, 1–2 frames
  shell(position, dir),               // ejected casing with simple bounce, plays 'shell'
  update(dt), reset() }
```

## src/player/player.js — `createPlayer(ctx)` (owner: player)
Owns the camera transform, movement, AABB collision against `level.colliders`, the weapon and the first-person viewmodel
(arms + pistol, parented to `ctx.camera`).
```
{ position: Vector3 (feet), velocity: Vector3, height: number (current, 1.8 standing / 1.2 crouched),
  eye: Vector3 (world camera position), yaw, pitch,
  alive: boolean, health: number (100),
  ammo: number, reserve: number, magSize: number,
  isAiming: boolean, noise: number (0..1 current loudness, for AI hearing),
  update(dt), takeDamage(amount, dirVector3), reset() }
```
Shooting: `ctx.combat.fire({ origin, dir, from: 'player', damage })`; then `ctx.enemies.alertNoise(position, radius)`,
`ctx.fx.muzzleFlash/shell`, `ctx.audio.play('shot')`, `ctx.pipeline.addTrauma/flash`.
On death call `ctx.game.onPlayerDeath()`. Use `ctx.input` (see input.js) — only act while `ctx.input.locked`.
Keys: WASD move, Shift sprint, C or Ctrl crouch, Q/E lean, mouse look, LMB fire, RMB aim, R reload, F flashlight.

## src/enemies/enemies.js — `createEnemies(ctx)` (owner: enemies)
```
{ list: Enemy[], aliveCount: number,
  update(dt), reset(),                              // reset respawns everyone at level.enemySpawns
  raycast(origin, dir, maxDist) -> { enemy, point: Vector3, distance, part: 'head'|'torso'|'limb' } | null,   // alive enemies only
  alertNoise(position, radius) }
Enemy: { position: Vector3 (feet), alive, state, takeDamage(amount, part, dir, point) }
```
Enemy shooting: `ctx.combat.fire({ origin, dir, from: 'enemy', damage })`, plus `fx.muzzleFlash`, `audio.play('shot_enemy', {position})`.
Sight checks: `ctx.combat.lineOfSight(a, b)`. On each death call `ctx.game.onEnemyDeath(enemy)` and `ctx.fx.bloodPool(pos)`.

## src/game/game.js — `createGame(ctx)` (owner: fxaudio)
Created FIRST (before level exists). Owns everything inside `#ui`: loading screen, main menu, pause, death, mission-complete, minimal HUD.
```
{ state: 'loading'|'menu'|'playing'|'paused'|'dead'|'complete',
  setLoading(p, label), ready(),
  update(dt), onPlayerDeath(), onEnemyDeath(enemy) }
```
Start/resume: `ctx.audio.resume()`, `ctx.input.requestLock()`. Losing pointer lock while playing → paused.
Restart: `ctx.player.reset(); ctx.enemies.reset(); ctx.fx.reset()`. Mission complete when `enemies.aliveCount === 0`
and the player stands inside `level.extraction`. HUD is deliberately minimal (bodycam footage has no HUD): ammo only
briefly after reload/when checking, objective text fading in/out, hostiles-remaining only on the pause screen.

## Working rules for all owners
- Other modules are being written in parallel by other agents; they may not exist yet. Do not create or edit files outside your folder(s).
- Do not start the dev server and do not run `npm install`. Verify with `node --check <file>` on each of your files, and re-read your code against this contract.
- Keep it fast: target 60 fps at 1080p on a mid-range GPU. Share geometries/materials, use InstancedMesh for repeated props.
- Guard every cross-module call that could run before the other module exists (`ctx.fx?.blood(...)`).
