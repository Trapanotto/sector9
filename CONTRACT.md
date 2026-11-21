# SECTOR 9 v2 — binding contract for the parallel workstreams

Original bodycam-style tactical FPS (German UI). A lone police officer clears a drug gang's logistics depot by day.
This document is **binding**: interfaces, file ownership, update order, events and budgets. If you need something
that is not here, add it in *your own* files behind the interfaces below, or ask the integration lead to amend
this contract. Never edit another workstream's files.

- Run: `npm install`, `npm run dev` (port 5173; agents use their own port, e.g. `npx vite --port 5181`).
- Bake (after ANY change to architecture, props, machines' static frames, lights, surfaces): `npm run bake` (~45 s,
  all cores) — commit `public/bake/*`. `npm run bake:quick` for iteration (≈7 s, noisier; never commit it — the test warns).
- Test: `npm test` (Node, < 2 s). Must pass before every commit. `npx vite build` must stay warning-free.
- Browser checks (throwaway InPrivate headless profile): `node scripts/browser-check.mjs bench|shots|tour|walk|script`.
- Automation: `window.__ctx` is the shared context; set `window.__fakeLock = true` to play without pointer lock;
  `await __ctx.dev.autopilot(__ctx.dev.tour)` walks the whole level with the real controller; `__bench.run()`.

---------------------------------------------------------------------------------------------------------------------

## 1. Workstreams and file ownership

| WS | Scope | Owns (create/edit freely) | Entry factory (keep name + file) |
|----|-------|---------------------------|----------------------------------|
| core | engine, loop, ctx, input, settings, loader, perf HUD, combat, collision, nav, raycasts, PVS/visibility, doors, glass, triggers, light-circuit runtime, layout skeleton, tests | `src/main.js`, `src/core/**`, `src/render/pipeline.js`, `src/world/{gen,bvh,nav,collision,world,doors,probes,lmpack}.js`, `src/world/layout/{index,dsl,site}.js`, `scripts/test.mjs`, `scripts/browser-check.mjs`, `index.html`, `vite.config.js`, `package.json`, `CONTRACT.md` | — |
| **A** | world art, props, machines & their animation | `src/world/layout/{props,proptypes,machines}.js`, `src/world/machines.js`, `src/world/art/**` (new), `public/assets/world/**`, `scripts/test-a-*.mjs` | `createMachines(ctx)` in `src/world/machines.js` |
| **B** | bake quality, materials, post look, sky, exposure, quality tiers tuning | `scripts/bake.mjs`, `src/render/{materials,composite,sky,osd,exposure,quality}.js`, `src/world/skymodel.js`, `src/world/layout/{lights,surfaces}.js`, `public/bake/**` (generated), `public/assets/materials/**`, `scripts/test-b-*.mjs` | (modules are imported by core; keep exported names) |
| **C** | player controller, first-person arms/hands + weapon (authored models), weapon FX, impacts/decals | `src/player/**`, `src/fx/**`, `public/assets/viewmodel/**`, `public/assets/fx/**`, `scripts/test-c-*.mjs` | `createPlayer`, `createWeapon` (`src/player/player.js`, `weapon.js`), `createFx` (`src/fx/fx.js`) |
| **D** | enemies: rigged CC0 characters, animation, AI, enemy roster | `src/enemies/**`, `src/world/layout/actors.js`, `public/assets/characters/**`, `scripts/test-d-*.mjs` | `createEnemies(ctx)` in `src/enemies/enemies.js` |
| **E** | audio from CC0 recordings, voices/screams, zone acoustics | `src/audio/**`, `public/assets/audio/**`, `scripts/test-e-*.mjs` | `createAudio(ctx)` in `src/audio/audio.js` |
| **F** | director (staged moments), mission flow, German UI | `src/director/**`, `src/ui/**` (new), `src/world/layout/moments.js`, `scripts/test-f-*.mjs` | `createDirector(ctx)` in `src/director/director.js` |

Shared rules
- `CREDITS.md`: everyone appends (append-only, one section per workstream). **Only CC0 third-party assets**; record
  source URL, author, licence, local path. Never put personal data (names, e-mails) into requests to outside services.
- Layout geometry in `site.js` (walls, floors, openings, zones) is core-owned. A/F/D request changes; core applies
  them, re-bakes and re-tests. A may add/move props and machine frames in its own layout files, then must run
  `npm run bake && npm test` and commit the bake.
- `public/bake/*` is generated. On merge conflicts never merge the binaries: take either side and **re-bake**.
- Stubs in A, C, D, E, F are placeholders: replace their *contents*, keep the factory name, the ctx properties and
  the events listed below.

## 2. Coordinates and conventions

- Metres. `+x` east, `+y` up, `+z` south. Building interior `x 0..96, z 0..64`, ground floor top `y = 0`,
  mezzanine floor `y 4.5`, basement floor `y -3.7`. Yaw: `0` faces north (`-z`), `+π/2` west, `π` south, `-π/2` east
  (three.js `rotation.y`, camera order `YXZ`).
- Greybox and gameplay truth are **axis-aligned boxes** (AABB). Collision, nav, bullets, PVS and the bake all use
  them. Visual art may be anything (A swaps visuals in place), but must keep the proxy footprint.
- Prop instances rotate in quarter turns `r = 0..3`. Proxy box lists live in `proptypes.js`.
- Zones: `LAYOUT.zones[i]` `{ id, name (German), acoustic, circuit, parts[[x0,y0,z0,x1,y1,z1]] }`; the first zone
  containing a point owns it. Acoustic classes: `outdoor, hall_large, hall_medium, room_large, room_small,
  corridor, stairwell, basement, cold_store`.
- Surfaces (`surfaces.js`): `SURF[name] = { color, impact }`. `impact` is what raycasts report as `surface`
  (`concrete, metal, wood, cardboard, plastic, glass, plaster, tile, dirt, rubber, fabric, flesh`).

## 3. The level (`src/world/layout/*`)

Fictional "Logistikzentrum Hafenstraße", fenced site `x -16..112, z -16..110` (128 × 126 m), building 96 × 64 m.

| Area | Zone ids | Size / notes |
|---|---|---|
| Yard (start at the gate, trailers at docks, containers, guard booth) | `hof`, `west`, `nord`, `ost` | player spawn `(45, 0, 107.5)` facing north; extraction van north side `x 72..82, z -13..-4` |
| Goods-in, 3 dock roller doors (Tor 2 open), stair to basement | `wareneingang` | 28 × 28 m, 8 m high, skylights |
| Gang packing area (packing tables, bricks), under-mezz + double height | `packerei` | 28 × 24 m |
| Lab (cutting/"kitchen"), social room, gang storage | `labor`, `sozial`, `lager_w` | under the mezzanine, 4.2 m high |
| Mezzanine: cash room, office, control room (window + door onto the catwalk), corridor, sleeping corner, lockers | `geld`, `buero`, `leitstand`, `flur_og`, `schlafen`, `umkleide`, `treppe_w` | floor y 4.5 |
| Racking hall: 14 single runs (7 double rows), 8 m racks, 3.2 m aisles, 3 cross aisles, catwalk at y 4.5 | `halle_n/m/s`, `gang0..8_n/s`, `steg` | 44 × 64 m, 12 m high, 9 skylights + high windows; rack gaps = crawl/flank routes |
| Automation: conveyor loop + sorter (elevated crossings you can walk under), AGV loop, platform + stair | `auto_n`, `auto_s`, `buehne` | 12 × 48 m |
| High-bay store with stacker crane | `akl` | 12 × 34 m, 11 levels |
| Palletising robot cell (mesh fence) | `roboter` | 12 × 14 m |
| Shipping (2 docks, Tor 5 half open = crawl entry), cold store | `versand`, `kuehl` | |
| Basement: technical room, supply tunnel linking goods-in and the hall | `technik`, `tunnel`, `keller_treppe(_h)` | floor y -3.7, no daylight |

Routes from the yard: open dock Tor 2, side door west, personnel door south, half-open Tor 5 (crouch), north
emergency exit. Inside: hall ↔ goods-in passage, packing ↔ hall door, storage ↔ hall door, catwalk control room ↔
platform, partition door + big opening hall ↔ automation, basement tunnel goods-in ↔ hall.

Data available (all in `LAYOUT`, `src/world/layout/index.js`): `zones`, `arch`, `props` + `propTypes` + `raw`
(racks/AKL/pipes), `conveyors`, `sorter`, `agvRoutes`, `agvs`, `cranes`, `robots`, `sun`, `sky`, `circuits`,
`fixtures` (light fixtures with circuit), `playerSpawn`, `enemies` (22: id, role guard/patrol/sleeper/ambusher,
pos, yaw, weapon, patrol waypoints, trigger), `moments` (10 staged moments with trigger boxes and beat briefs),
`extraction`, `benchViews` (7 heaviest views). Generated (`generateWorld(LAYOUT)` → `ctx.world.gen`): `boxes`,
`faces`, `glass` (42 panes), `doors` (25, with kind swing/roller/slide and state), `openings`, `lm`, `hash`.

## 4. ctx — the shared context (`window.__ctx`)

| Property | Owner | Content |
|---|---|---|
| `layout`, `events`, `settings`, `input`, `time {now, dt, frame, mission}`, `state`, `setState(s)`, `restart()`, `ORDER`, `debug {allZones, god}`, `dev`, `perf`, `lod`, `combat`, `timings` | core | see §5–§7 |
| `render` | core/B | `{ renderer, gl, scene, camera, vmScene, vmCamera, composite, U, stats, resolution, trackTexture(name, bytes) }` |
| `quality` | B | `{ tier {id,name,…}, mode, scale, gpu, setMode(mode) }` |
| `exposure` | B | `{ value, target, avgLum, gain, frozen }` |
| `world` | core | §6 |
| `machines` | A | `agv(id) {dispatch(), stop(), state}`, `conveyor(id) {start(), stop(), state}`, `robot(id) {start(), stop()}`, `crane(id)`, lists `agvs, conveyors, robots, cranes` |
| `player` | C | `pos {x,y,z}` (feet), `vel`, `yaw`, `pitch`, `eye` (Vector3), `forward` (Vector3), `health`, `dead`, `crouched`, `moving` (m/s), `flashlight` (bool), `teleport([x,y,z], yaw, pitch, freeze)`; hittable (`kind 'player'`, `team 'police'`) |
| `weapon` | C | `ammo`, `reserve`, `reloading` |
| `fx` | C | `impact(res)`, `blood(point, dir, amount)`, `muzzle()` |
| `enemies` | D | `list[]` (each: `id, def, pos (Vector3), yaw, health, dead, alerted, lod`), `alert(ids|null, pos)`, `alive()` |
| `audio` | E | `play(id, opts)`, `playAt(id, pos, opts)`, `unlock()`, `setVolume(v)` |
| `director` | F | free; must drive `setState` transitions and the UI |

Game states: `boot → loading → menu ⇄ playing ⇄ paused`, `playing → dead | done → menu` (F decides). Modules
check `ctx.state` themselves in `update`.

## 5. Module factory, update order, frame

```js
export function createX(ctx) { return {
  id: 'x', order: ctx.ORDER.x,
  async load(loader) {},   // optional: fetch/build assets (loader.json/bin/gltf/texture/step) — during loading screen
  init() {},               // optional: after all loads, before shader warm-up (register hittables, add meshes)
  update(dt) {},           // every frame; dt seconds (clamped 0.1)
  reset() {},              // mission restart (die-and-retry)
}; }
```
Per frame (src/core/app.js): `director 10 → player 20 → weapon 30 → enemies 40 → machines 50 → world 60 (visibility,
circuits, doors, triggers) → fx 70 → audio 80 → exposure 90 → render (scene + view model → composite) → input.endFrame()`.
All meshes/materials must exist by the end of `init()` so `render.warmup()` compiles every shader before the menu
(**no shader compiles during play**; tier switches change uniforms/targets only).

## 6. World API (`ctx.world`, core)

- `worldHit(o, d, maxDist, out, opts?)` → bool. `o, d` `{x,y,z}` (d normalised). `out = { hit, t, point, normal,
  surface, kind: 'static'|'door'|'glass'|'dynamic', id, box, zone, owner }`. Default mask = bullet blockers;
  `opts.ignoreGlass`. Allocation-free; reuse `out`.
- `lineOfSight(a, b)` → bool (static opaque geometry and closed doors block; glass and mesh fences don't).
- `groundHeight(x, z, refY, r = 0)` → highest solid top ≤ refY under the point/disc (`-Infinity` if none).
- `collision.move(pos, d, {radius, height, step}, state)`, `collision.blocked(...)`, `collision.addDynamic(min, max,
  owner)` → record `{min, max, enabled, owner}` (owner `{kind, id, surface, shoot, sight}`) — AGVs, doors, glass, …
- `nav` (0.5 m layered grid): `nearest(x,y,z)`, `findPath(a, b, outInt32)` (reversed node ids), `nodeX/nodeZ(k)`,
  `nodeY[k]`, `nodeZone[k]`, `nodeDoor[k]`, `doorBlocked[doorIndex]`, `reachable(a)`.
- `zoneAt(x,y,z)` → index; `zoneId(i)`; `cameraZone`; `zoneVisible` (Uint8Array, PVS this frame);
  `isZoneVisible(i)`; `isPointVisible(x,y,z)`; `addZoneObject(obj, zone)` (A: merged art per zone follows PVS).
- `doors.get(id)`, `doors.set(id, 'open'|'closed'|'half'|'locked', {speed, instant})`, `doors.use(x,y,z,fx,fz)`, `doors.list`.
- `glass.break(id, point)`, `glass.list`.
- `lights.setCircuit(id, level, fadeSeconds, flicker)`, `lights.level(id)`, `lights.ids` — circuits:
  `halle, auto, west_eg, og, keller, kuehl, aussen` (baked ART lightmap/probe layer × level; emissive lamps follow).
- `triggers.list` (moment boxes + extraction), `probes.sample(x,y,z,out)` (baked light: `r,g,b` day L0,
  `ar,ag,ab` artificial L0, `dx,dy,dz` dominant direction, `sun` visibility) — CPU, allocation-free.
- `gen` — the generated greybox (boxes/faces/glass/doors/zones/hash).

Combat (`ctx.combat`, core): `register(h)` / `unregister(h)` with `h = { id, kind, team, raycast(o, d, maxT, part) → t|-1
(set part.name 'head'|'torso'|'legs'|…), onHit(res) }`; `fire({ origin, dir, range, damage, shooter, team })` → shared
result `{ hit, t, point, normal, surface, kind, id, target, part, damage, shooter, origin, dir, glassBroken }`. Breakable
glass on the way shatters and the bullet continues. LOD helpers (`ctx.lod`): `level(x,y,z)` 0 < 15 m, 1 < 40 m,
2 far, 3 PVS-culled; `animStep(index, level)` → update this actor's skeleton this frame? (staggered, tier-aware).

## 7. Events (`ctx.events.on/once/off/emit`, synchronous; payloads are reused — copy what you keep)

| Event | Payload | Emitted by |
|---|---|---|
| `state` | `{from, to}` | core (`setState`) |
| `load:progress` | `{p, label}` | core loader |
| `quality:change` | tier | B |
| `mission:restart` | `{}` | core (`restart`) |
| `trigger:enter` / `trigger:exit` | `{id, def, first}` | core (player feet in a moment/extraction box) |
| `moment` | `{id, def}` | F (when it stages a moment) |
| `radio` | `{speaker, text, sound?}` | F (E plays, UI may subtitle) |
| `door:state` / `door:locked` | `{id, state, door}` / `{id, door}` | core doors |
| `glass:break` | `{id, point, pane}` | core |
| `lights:circuit` | `{id, level, fade}` | core |
| `machine:state` | `{id, kind: 'agv'|'conveyor'|'robot'|'crane', state}` | A |
| `shot` | combat result (every fired round) | core combat |
| `hit` | combat result (a hittable was hit) | core combat |
| `weapon:fire` / `weapon:reload` / `weapon:reloaded` / `weapon:empty` | `{ammo}` / weapon | C |
| `player:damage` / `player:death` / `player:flashlight` | `{amount, part, health, from}` / `{}` / `{on}` | C |
| `enemy:damage` / `enemy:death` / `enemy:fire` / `enemy:alert` | `{id, enemy, amount?, part?}` | D |

New events: prefix with your area (`a:…`, `d:…`) and list them in your section of this file via the lead.

Area events as built (integration pass 2026-11-21; all payloads reused):

| Event | Payload | Emitted by | Consumed by |
|---|---|---|---|
| `a:sorter` | `{id: chuteId, phase: 'divert'\|'burst', index}` | A (every carton diverted; staged `sorter.divert`) | E clack / carton burst at the chute |
| `a:robot` | `{id, phase: 'pick'\|'place'}` | A palletising robot | E gripper hiss / carton set down |
| `a:crane` | `{id, phase: 'pick'\|'drop'}` | A stacker crane | E fork clunk |
| `machine:state` (AGV) | also `state 'blocked'` (stopped for a person/vehicle ahead, beacon on) → `'running'`; `'estop'` for every machine after `machines.emergencyStop()` | A | E drive/beeper follow `rec.v`; one contactor clunk on e-stop |
| `c:footstep` | `{surface, x, y, z, speed, crouched, sprint, foot}` | C (one per footfall, surface from the ground ray) | E steps + gear/cloth foley |
| `c:casing` | `{x, y, z, surface, speed}` | C (each casing bounce, ≤ 3) | E casing tinks |
| `c:reload` | `{stage: 'start'\|'mag_out'\|'mag_pouch'\|'mag_in'\|'slide_release', kind: 'empty'\|'tactical', ammo}` | C, in sync with the reload clip | E reload sounds (then `weapon:reload/reloaded` are silent in E) |
| `c:slidelock` | `{ammo}` | C (last round fired, slide locks back) | E click |
| `d:voice` | `{id, enemy, kind: 'alert'\|'command'\|'reload'\|'pain'\|'death'\|'dying'\|'taunt'\|'plead'\|'surprise', pos, zone}` | D (D decides WHEN an enemy speaks) | E voices (one consistent voice per enemy, one death cry per body) |
| `d:step` | `{id, enemy, pos, run}` | D (one per stride, within 35 m of the player) | E enemy footsteps |
| `d:nearmiss` | `{id, enemy, point, dist}` | D (one per enemy shot, closest approach < 1.4 m) | E whizz |
| `d:state` | `{id, enemy, from, to}` | D | — |
| `d:surrender` / `d:executed` | `{id, enemy}` | D | F debrief |
| `f:tension` | `{level}` 0..1 | F pacing | E tension bed |
| `f:alarm` / `f:breach` | `{on}` / `{id}` | F | E swell |
| `f:objective` / `f:evidence` / `f:checkpoint` / `f:settings` | `{id, text}` / `{id, name, found}` / `{name}` / `{key, value}` | F | F UI |

Area APIs added on ctx (as built): `machines.emergencyStop(on)`, `machines.sorter.divert(chuteId, {burst})`,
`machines.anchor(name)`; `weapon.snapshot()/restore(s)` (checkpoint ammo), `weapon.frame` (view-model framing
offsets); `enemies.ambush/stage/despawn/wake/spawn/hold/moveTo/say/trigger/group`, `enemies.stats`;
`fx.powder(p)`, `fx.fog(…)`; `audio.has(id)`, `audio.setTension(v)`, `audio.setBusVolume(bus, v)`, `audio.stats()`;
`render.composite.uniforms.uFaces[6] / uFaceN` (privacy mosaic ellipses in source uv, filled by D each frame from
heads in line of sight; `settings.pixelateFaces` toggles it); `director.fire(id, variant)`, `director.status()`.

## 8. Rendering contract (core + B)

- ONE HDR scene target (RGBA16F when renderable, RGBA8 fallback) + ONE composite pass → canvas. The first-person
  scene (`render.vmScene`/`vmCamera`, C) renders into the same target after a depth clear. No shadow maps, no extra
  full-screen passes, no cubemap renders. Dynamic resolution = target viewport (no reallocations).
- All scene shaders write **exposed** linear HDR (`× U.uExposure`). Use the materials in `src/render/materials.js`:
  `createStaticMaterial` (world, internal), `createTransparentMaterial`, `createDynamicMaterial({color, map, probe:
  'volume'|'uniform', emissive})` (skinning + instancing supported), `convertToDynamic(gltfRoot)` for glTF models.
  Only lights: flashlight spot (`U.uFlash*`, C drives it) and the muzzle point light (`U.uMuzzle*`, C).
- Shared uniforms `U` (exposure, flashlight, muzzle, fog, circuits, probe textures, sun) — mutate in place.
- Bake format (`public/bake/manifest.json`): `lightmap {width, height, encoding 'rgbm8', range 16, day, art}` (zlib
  deflate of RGBA8, rows bottom-up = atlas y), `vertexLight {vertices}` (day then art RGBM per vertex of every
  vertex-lit face in `gen.faces` order, corners (u0,v0),(u1,v0),(u1,v1),(u0,v1)), `probes {origin, spacing, dims}`
  (L0 day RGBM, dir·0.5+0.5 + sun visibility, L0 art RGBM; x fastest), `pvs {zoneId: [visible zone ids]}`, `hash`
  (must equal `generateWorld(LAYOUT).hash`, else the runtime shows "Bake veraltet").
- Static world draw: per zone one opaque mesh (lightmapped + vertex-lit) + one transparent mesh (glass, mesh fences),
  shown by PVS(camera zone ∪ zones 0.7 m around) and frustum. Vertex attributes: `position, normal (int8), aColor
  (rgb albedo, a), aLmUv (uint16), aVlDay/aVlArt (rgbm8), aMisc (circuit, emissive·16, surface index, 0)`.
- Quality tiers (`quality.js`, as tuned by B):

  | tier | output height | scene scale (dynamic) | MSAA | bloom | grain | material detail layer | anim rate |
  |---|---|---|---|---|---|---|---|
  | `vlow` Sehr niedrig | 540p (browser upscales) | 70–100 % | – | – | 0.05 | off | 0.5 |
  | `low` Niedrig | 720p | 60–90 % | – | – | 0.045 | off | 0.75 |
  | `mid` Mittel | 1080p | 55–80 % | – | 0.12 | 0.04 | on | 1 |
  | `high` Hoch | 1440p | 60–90 % | 4× | 0.16 | 0.038 | on | 1 |

  Auto mode by GPU string: software → vlow, Intel UHD/HD Gen9 → vlow, other Intel iGPU / AMD APU / mobile → low,
  Apple → mid, RTX/RX/Arc/GTX 10-16 → high, other dedicated → mid; steps down (to 35 % scale) when frames stay slow.

## 9. Budgets (lowest tier, worst view; `src/core/budgets.js`, live in the perf HUD — F9 or ^)

| | draw calls | triangles in view | texture MB | notes |
|---|---|---|---|---|
| **Frame total** | **≤ 120** | **≤ 200 k** | **≤ 150** | ≤ 2 full-screen passes, 1 dynamic light + muzzle, 16.7 ms |
| static world (A art + B materials) | ≤ 60 | ≤ 140 k | ≤ 70 | merged per zone; greybox today: ≤ 55 draws / 86 k tris before frustum culling (npm test) |
| A dynamic machines, doors, glass FX | ≤ 10 | ≤ 15 k | ≤ 20 | AGVs, crane, robot; animate only when `isPointVisible` |
| B sky + composite (+ lightmaps/probes) | 2 | 0.2 k | ≤ 30 | lightmaps today 2048×928 ×2 RGBA8 = 14.5 MB, probes 3.7 MB |
| C arms + weapon + fx | ≤ 6 | ≤ 12 k | ≤ 12 | decals/impacts pooled & instanced |
| D enemies | ≤ 32 | ≤ 30 k | ≤ 16 | ≤ 8 k tris LOD0 (< 15 m), ≤ 2.5 k LOD1, skinning only for visible; `lod.animStep` throttling; one draw per character + weapon |
| E audio | 0 | 0 | 0 | ≤ 24 voices, decoded audio ≤ 60 MB |
| F world-space UI | ≤ 2 | ≤ 0.5 k | ≤ 4 | HUD/menus are DOM |

Hot paths (any `update`, raycasts, combat): **no per-frame allocations** (reuse vectors/objects, typed arrays,
preallocated callbacks). Load to menu ≤ 5 s on a warm cache (today ≈ 1.1 s).

## 10. Tests

- `npm test` runs `scripts/test.mjs` (core: ids, every spawn/trigger/waypoint in a zone and on the nav grid, nav
  connectivity spawn → every enemy/waypoint/trigger/extraction, every door passable, z-fighting (coplanar
  overlapping faces), overlapping solids, AGV routes clear, bake freshness, PVS static budgets) and then every
  `scripts/test-*.mjs`. A workstream test exports `default async ({ W, bvh, nav, LAYOUT, ok, warn }) => {}`; use
  `ok(cond, msg)` for failures and `warn` for warnings. Keep it Node-only and fast (< 5 s).
- Browser: `node scripts/browser-check.mjs tour` must end in state `done` (spawn → extraction) after layout
  changes; `bench` reports GPU-synced frame time, draw calls and triangles per tier for `LAYOUT.benchViews`.

## 11. Staged moments (F) — trigger ids and briefs live in `moments.js`

`m01_ankunft` (yard), `m02_tor_faellt` (Tor 2 slams behind the player), `m03_packerei` (radio stops, ambush e08),
`m04_keller_licht` (basement lights out, flashlight only), `m05_halle_dunkel` (hall lights out, patrol torches),
`m06_foerderband` (conveyor + sorter start, masking noise), `m07_agv` (AMR crosses with warning beep), `m08_schrei`
(scream behind the locked cash-room door), `m09_roboter` (robot swings, ambush e19), `m10_kuehl` (cold store door,
fog, ambush e22); `extract` = extraction. The director stub already wires the world hooks for each.

As built by F (14 moments × 3 variants, data-driven timelines in `moments.js`, run order by `order`/`pre`):
`m01_ankunft` [musik, stille, husten] · `m02_tor_faellt` [tor, licht, spaet] · `m03_packerei` [stille, musik, koeder] ·
`m04_keller_licht` [ausfall, schnarchen, flackern] · `m05_halle_dunkel` [abschnitte, laeufer, ploetzlich] ·
`m07_agv` [nur_agv, neugierig, stillstand] · `m11_telefon` [klingeln, geweckt, fernseher] · `m08_schrei` [streit,
flehen, fluestern] · `m12_geldraum` [aufgabe, koeder, feuer] · `m13_steg` [magazin, schritte, nachladen] ·
`m06_foerderband` [anlauf, hupe, fehlstart] · `m09_roboter` [schwenk, zelle, still] · `m10_kuehl` [nebel, klopfen,
dunkel] · `m14_verladung` [tor4, verwundet, tor5]. Debug: `__ctx.director.fire(id, variant)`, `__ctx.director.debug()`.
Checkpoint snapshots store position, dead enemies, finished moments + variants, evidence, objectives, breaches,
stats and the ammo state (`weapon.snapshot()`), restored on "erneut".
