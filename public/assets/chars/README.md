# SECTOR 9 character assets

Built by `scripts/chars/` (see "Rebuilding" below); credits and licences in `/CREDITS-CHARS.md`
(everything CC0). Viewer pages: `tools/char-viewer/` (`npx vite --config tools/char-viewer/vite.config.js`, port 5183).

## Conventions

- Units metres, **+Y up**, characters **face +Z** (glTF default). To face -Z rotate the actor by PI about Y.
  Character left = +X.
- All clips are **in place** (no root motion). The `root` bone is never animated; the game moves/rotates the actor.
  `startled_turn` ends rotated 180 deg in the pelvis: after it finishes rotate the actor by PI and play `idle`.
- Variants have different heights. Each variant GLB stores its size in the **`root` bone scale**
  (`manifest.json -> variants[].rootScale`, ~0.90-1.02). The shared animations only rotate bones and translate
  `pelvis` in reference units (pelvis height 0.98), so feet stay planted for every variant.
  Never key `root.scale` from code.

## Files

| file | content | size |
|---|---|---|
| `thug_jacket.glb` `thug_hoodie.glb` `thug_balaclava.glb` `thug_worker.glb` `thug_tee.glb` `thug_female.glb` | one skinned character each: meshes `<name>_LOD0` (8 000 tris), `<name>_LOD1` (2 500 tris) and `<name>_LOD2` (800 tris, added by workstream D with `scripts/chars/add_lod2.mjs`) sharing one skeleton, one material, one 1024 WebP atlas | 166-213 KB each |
| `enemy_anims.glb` | skeleton + 56 clips (no mesh) | 0.97 MB |
| `enemy_anims.clips.json` | per clip: duration, loop flag, sourced/made, source | |
| `weapons/pistol.glb` `smg.glb` `shotgun.glb` | enemy weapons (208 / 320 / 276 tris, vertex colours) | ~6 KB each |
| `weapons/weapons.json` | attach bone + offset per weapon, muzzle/support points | |
| `hitboxes.json` | per-bone capsules | |
| `manifest.json` | everything above in one index | |
| `../arms/fp_arms_pistol.glb` | first-person arms + pistol, 8 clips + 4 index-finger poses (8 352 + 644 tris, 1 material) | 299 KB |
| `../arms/fp_arms_pistol.clips.json`, `penetration_report.json`, `penetration_mesh_check.json` | FP clip list and finger/gun penetration checks | |

Meshes are `EXT_meshopt_compression` + `KHR_mesh_quantization`; textures `EXT_texture_webp`.
three r170 needs `loader.setMeshoptDecoder(MeshoptDecoder)` (WebP and quantization work out of the box).

## Skeleton (enemies, 41 joints, Quaternius UAL2 names)

```
root
└ pelvis
  ├ spine_01 ─ spine_02 ─ spine_03
  │   ├ neck_01 ─ Head
  │   ├ clavicle_l ─ upperarm_l ─ lowerarm_l ─ hand_l ─ {thumb,index,middle}_0{1,2,3}_l
  │   └ clavicle_r ─ upperarm_r ─ lowerarm_r ─ hand_r ─ {thumb,index,middle}_0{1,2,3}_r
  ├ thigh_l ─ calf_l ─ foot_l ─ ball_l
  └ thigh_r ─ calf_r ─ foot_r ─ ball_r
```

Ring and little finger are skinned to the `middle_0x` bones on enemies. Rest orientations are exactly the
UAL ones, so any other Quaternius UAL clip can be imported with `scripts/chars/animlib.mjs:importUalClip`.
The first-person file uses the upper body of the same rig plus `ring_0x` / `pinky_0x` (45 joints).

## Clips (`enemy_anims.glb`)

"sourced" = Quaternius Universal Animation Library (CC0), re-targeted only by renaming and pelvis scaling.
"made" = authored in `scripts/chars/author.mjs` (keyed rotations, impulse curves, 2-bone IK, layered UAL frames).

| clip | s | loop | origin | notes |
|---|---|---|---|---|
| idle | 2.50 | loop | sourced | UAL1 Idle_Loop |
| idle_talk | 2.93 | loop | sourced | UAL1 Idle_Talking_Loop (2nd idle) |
| idle_arms_folded | 2.50 | loop | sourced | UAL2 Idle_FoldArms_Loop |
| idle_phone | 2.93 | loop | sourced | UAL2 Idle_TalkingPhone_Loop |
| look_around | 6.00 | loop | made | idle + keyed spine/neck/head yaw |
| walk | 1.33 | loop | sourced | UAL1 Walk_Loop |
| run | 0.93 | loop | sourced | UAL1 Jog_Fwd_Loop |
| sprint | 0.67 | loop | sourced | UAL1 Sprint_Loop |
| crouch_idle | 2.93 | loop | sourced | UAL1 Crouch_Idle_Loop |
| crouch_walk | 2.00 | loop | sourced | UAL1 Crouch_Fwd_Loop |
| pistol_idle | 1.67 | loop | sourced | UAL1 Pistol_Idle_Loop |
| pistol_aim / _up / _down | 0.17 | loop | sourced | UAL1 Pistol_Aim_* (single poses; blend for aim pitch) |
| pistol_aim_crouch | 2.00 | loop | made | crouch legs + pistol-aim torso, chest held upright |
| pistol_fire | 0.63 | once | sourced | UAL1 Pistol_Shoot |
| pistol_reload | 1.67 | once | sourced | UAL1 Pistol_Reload |
| smg_idle / shotgun_idle | 2.50 | loop | made | low ready, IK both hands on the weapon |
| smg_aim / shotgun_aim | 2.00 | loop | made | shouldered, IK |
| smg_aim_crouch / shotgun_aim_crouch | 2.00 | loop | made | crouch legs + shouldered |
| smg_fire | 0.12 | loop | made | one recoil cycle, loop for automatic fire |
| shotgun_fire | 0.55 | once | made | recoil |
| smg_reload / shotgun_reload | 2.20 | once | made | support hand to the gun/belt and back (simple) |
| hit_chest | 0.33 | once | sourced | UAL1 Hit_Chest |
| hit_head | 0.43 | once | sourced | UAL1 Hit_Head |
| hit_knockback | 0.83 | once | sourced | UAL2 Hit_Knockback (falls on the back) |
| hit_front / hit_back / hit_left / hit_right | 0.70 | once | made | flinch impulse in the hit direction |
| death_forward | 1.80 | once | made | knees buckle, falls face down |
| death_backward | 2.40 | once | sourced | UAL1 Death01 |
| death_slump | 2.00 | once | made | sags onto the backside, slumps |
| death_headshot | 1.40 | once | made | limp collapse, topples face down |
| sit_enter / sit_idle / sit_talk / sit_exit | 1.30 / 1.67 / 2.93 / 1.03 | once/loop/loop/once | sourced | UAL1 Sitting_*; seat height ~0.45 m, chair behind the pelvis |
| sleep_lying | 4.00 | loop | made | UAL2 LayToIdle frame 0 (on the back) + breathing |
| lying_to_idle | 1.53 | once | sourced | UAL2 LayToIdle (wake up from sleep_lying) |
| lean_wall | 4.00 | loop | made | back against a wall ~0.25 m behind the heels, one foot on the wall |
| surrender | 3.00 | loop | made | hands up, open palms |
| kneel_hands_head | 3.00 | loop | made | kneeling on both knees, hands on the head |
| kneel_fix | 5.20 | loop | sourced | UAL1 Fixing_Kneeling (working on the floor) |
| startled_turn | 0.90 | once | made | 180 deg pivot, see conventions |
| melee_jab / melee_cross / melee_hook | 0.87 / 1.00 / 0.47 | once | sourced | UAL Punch_Jab, Punch_Cross, Melee_Hook |
| shove | 0.80 | once | made | two-handed push |
| interact / pickup / no | 2.00 / 0.83 / 2.50 | once/once/loop | sourced | UAL Interact, PickUp_Table, Idle_No_Loop |

## Weapons and attach point

All weapons attach to **`hand_r`**. `weapons.json` gives `offset.position` (bone-local units) and
`offset.quaternion` (xyzw). Weapon space: origin = grip centre, +Z muzzle, +Y up. Because the bone inherits the
variant's root scale, set `weapon.scale.setScalar(1 / rootScale)` to keep real size:

```js
const def = manifest.weapons.pistol;
const gun = (await loader.loadAsync('/assets/chars/' + def.file)).scene;
gun.position.fromArray(def.offset.position);
gun.quaternion.fromArray(def.offset.quaternion);
gun.scale.setScalar(1 / actor.getObjectByName('root').scale.x);
actor.getObjectByName(def.bone).add(gun);
```

The pistol offset is calibrated to the UAL pistol clips (barrel level in `pistol_aim`); SMG/shotgun clips were
authored with the same offsets, so `smg_*`/`shotgun_*` hold their weapon by construction. Muzzle point
(weapon space): `weapons.json -> muzzle`.

## Hitboxes

`hitboxes.json -> capsules[]`: `{part, bone, a, b, r, damage}`. `a`/`b` are capsule segment end points in the
bone's local frame, `r` the radius in bone-local units (world radius = `r * rootScale`).
`world = bone.localToWorld(new Vector3(...a))`. 17 capsules: head (x4 damage), neck, chest, stomach, pelvis,
upper/lower arms, hands, thighs, calves, feet. Fitted on `thug_jacket`; shared by all variants. The head capsule was refitted by\nworkstream D (vertical segment, covers chin to skull top/hair on all six variants; see `build_hitboxes.mjs`).

## Loading (three r170)

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const manifest = await (await fetch('/assets/chars/manifest.json')).json();
const anims = (await loader.loadAsync('/assets/chars/enemy_anims.glb')).animations; // shared by all variants
const templates = {};
for (const v of manifest.variants) templates[v.name] = (await loader.loadAsync('/assets/chars/' + v.file)).scene;

function spawn(name) {
  const actor = SkeletonUtils.clone(templates[name]);   // own skeleton per instance, shared geometry/material
  const lod0 = actor.getObjectByName(name + '_LOD0'), lod1 = actor.getObjectByName(name + '_LOD1');
  lod1.visible = false;                                  // switch by distance, e.g. > 12 m -> LOD1
  actor.traverse((o) => { if (o.isMesh) o.frustumCulled = false; }); // skinned bounds are the bind pose
  const mixer = new THREE.AnimationMixer(actor);
  const play = (clip, loop = true) => {
    const a = mixer.clipAction(THREE.AnimationClip.findByName(anims, clip));
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    return a.reset().play();
  };
  return { actor, mixer, play };
}
```

Loop flags: `manifest.clips[].loop`. Faces get pixelated by the game, so there are no blend shapes.

## First-person arms (`../arms/fp_arms_pistol.glb`, v2)

```
fp_root            (origin = CHEST CAMERA (bodycam on the sternum, 0.30 m below the eyes), looking down -Z)
├ fp_arms          ONE SkinnedMesh / ONE draw: MakeHuman arms, navy uniform sleeves, coyote tactical gloves + pistol
└ root … hand_r ─ pistol (joint) ─ pistol_slide | pistol_trigger | pistol_magazine (joints)
                                  └ pistol_muzzle, pistol_port, pistol_sight_rear (markers)
```

8 352 arm + 644 pistol triangles, one 1024 WebP atlas, 299 KB. In the game (`src/player/viewmodel.js`) the arms live
in world space at the camera pose and are drawn with their own narrower lens (`VM_ZOOM` 1.25); two-bone IK keeps both
hands on the gun while `weapon.js` layers free aim, sway, bob, recoil, wall retraction and the framing offsets
(`ctx.weapon.frame`: hip raised 4.5 cm, ADS raised 6.5 cm and tipped 3°) on top of the clips.

| clip | s | loop | notes |
|---|---|---|---|
| fp_idle | 1.00 | loop | hip/ready hold: gun 30 cm in front of the chest camera and 11 cm low, finger indexed, thumbs forward |
| fp_aim | 1.00 | loop | ADS from the chest camera: sights 3.5 cm under the lens axis, 33 cm out, zeroed at 15 m, finger on the trigger |
| fp_lowready | 1.00 | loop | muzzle depressed 38°, finger indexed |
| fp_sprint | 0.66 | loop | tucked low with a two-step bob |
| fp_fire / fp_dry_fire | 0.30 / 0.45 | once | trigger press, slide cycle 32 mm (fire), muzzle flip 5° |
| fp_reload | 2.50 | once | empty reload: slide locked, mag drop, new mag from the belt, insert, slide-stop release |
| fp_reload_tac | 2.20 | once | tactical reload (round chambered): mag drop, new mag from the belt, insert |
| fp_pose_index_off / _mid / _trigger / _press | 0.1 | pose | index finger poses blended procedurally (trigger discipline, press) |

Reload stage times used by the game (`RL` in `src/player/weapon.js`): mag out 0.30 s, pouch 0.75 s, mag in 1.45 s,
slide release 2.03 s. The grip is contact-solved against the pistol's signed distance field (2.5 mm margin).
Penetration: `penetration_report.json` (modelling SDF) and `penetration_mesh_check.json` (exported GLB, CPU-skinned
glove vertices vs the exact pistol SDF, 60 fps): **0 mm in every clip including both reloads and the procedural
trigger press**. Known limit (integration QA 2026-11-21): the strong thumb misses its forward target by 3 cm
(`grip.strongThumbSearch.tipMiss` 0.0305 m) and rests across the back of the grip; fixing it needs a rebuild with the
CC0 source cache (`STRONG_THUMB` / `STRONG_THUMB_MCP` in `build_arms.mjs`).
## Rebuilding

```
cd scripts/chars && npm install
node build_all.mjs <cache_dir>          # downloads the CC0 sources (~430 MB) into <cache_dir>, builds everything
node build_all.mjs <cache_dir> --skip-fetch --only enemies|anims|arms
```

Needs Python 3 with numpy + Pillow (MakeHuman stage) and Node 20+. Intermediate files go to
`public/assets/chars/_raw/` (git-ignored). No Blender or MakeHuman application is required: the MakeHuman
formats (targets, proxies, mhclo, mhskel, mhw) are read directly by `mhlib.py`.
