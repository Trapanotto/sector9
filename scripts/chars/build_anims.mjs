// Stage 3: shared enemy animation set (one GLB) on the 41-joint UAL skeleton.
// usage: node build_anims.mjs <cache_dir> <reference_raw_variant.glb> <out.glb>
import fs from 'node:fs';
import path from 'node:path';
import { loadGLB, THREE } from './threeio.mjs';
import { importUalClip, writeAnimGLB, readJSON } from './animlib.mjs';
import { authorClips } from './author.mjs';

const [, , cache, refPath, outPath] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const skel = readJSON(path.join(here, 'skeleton.json'));
const bones = skel.enemy.map((b) => b[0]);

const ual1 = await loadGLB(path.join(cache, 'universal_animation_librarystandard', 'Animation Library[Standard]', 'Godot', 'AnimationLibrary_Godot_Standard.glb'));
const ual2 = await loadGLB(path.join(cache, 'universal_animation_library_2standard', 'Universal Animation Library 2 [Standard]', 'Unreal-Godot', 'UAL2_Standard.glb'));
const ref = await loadGLB(refPath);

const src = (lib, name) => {
  const c = (lib === 1 ? ual1 : ual2).animations.find((a) => a.name === name);
  if (!c) throw new Error('missing clip ' + name);
  return c;
};

// [our name, library, UAL clip, loop]
const SOURCED = [
  ['idle', 1, 'Idle_Loop', true],
  ['idle_talk', 1, 'Idle_Talking_Loop', true],
  ['idle_arms_folded', 2, 'Idle_FoldArms_Loop', true],
  ['idle_phone', 2, 'Idle_TalkingPhone_Loop', true],
  ['walk', 1, 'Walk_Loop', true],
  ['run', 1, 'Jog_Fwd_Loop', true],
  ['sprint', 1, 'Sprint_Loop', true],
  ['crouch_idle', 1, 'Crouch_Idle_Loop', true],
  ['crouch_walk', 1, 'Crouch_Fwd_Loop', true],
  ['pistol_idle', 1, 'Pistol_Idle_Loop', true],
  ['pistol_aim', 1, 'Pistol_Aim_Neutral', true],
  ['pistol_aim_up', 1, 'Pistol_Aim_Up', true],
  ['pistol_aim_down', 1, 'Pistol_Aim_Down', true],
  ['pistol_fire', 1, 'Pistol_Shoot', false],
  ['pistol_reload', 1, 'Pistol_Reload', false],
  ['hit_chest', 1, 'Hit_Chest', false],
  ['hit_head', 1, 'Hit_Head', false],
  ['hit_knockback', 2, 'Hit_Knockback', false],
  ['death_backward', 1, 'Death01', false],
  ['sit_enter', 1, 'Sitting_Enter', false],
  ['sit_idle', 1, 'Sitting_Idle_Loop', true],
  ['sit_talk', 1, 'Sitting_Talking_Loop', true],
  ['sit_exit', 1, 'Sitting_Exit', false],
  ['lying_to_idle', 2, 'LayToIdle', false],
  ['melee_jab', 1, 'Punch_Jab', false],
  ['melee_cross', 1, 'Punch_Cross', false],
  ['melee_hook', 2, 'Melee_Hook', false],
  ['kneel_fix', 1, 'Fixing_Kneeling', true],
  ['interact', 1, 'Interact', false],
  ['pickup', 1, 'PickUp_Table', false],
  ['no', 2, 'Idle_No_Loop', true],
];

const clips = [];
const meta = {};
const lib = {};
for (const [name, l, ualName, loop] of SOURCED) {
  const c = importUalClip(src(l, ualName), bones, { ual1: l === 1, name });
  clips.push(c);
  lib[name] = c;
  meta[name] = { loop, source: `Quaternius UAL${l} ${ualName}`, made: false };
}

// Rest skeleton of the reference character (names/hierarchy for the GLB, rest pose for authoring)
let rootBone = null;
ref.scene.traverse((o) => { if (o.isBone && o.name === 'root') rootBone = o; });
const made = authorClips({ THREE, lib, rootBone, bones });
for (const { clip, loop, note } of made) {
  clips.push(clip);
  meta[clip.name] = { loop, source: note, made: true };
}
// gltf-transform needs per-node rest TRS; root scale normalised to 1 here (variants carry their own)
const restRoot = rootBone.clone();
restRoot.scale.set(1, 1, 1);
await writeAnimGLB(outPath, restRoot, clips, meta);
for (const c of clips) console.log(c.name.padEnd(22), c.duration.toFixed(2) + 's', meta[c.name].loop ? 'loop' : 'once', meta[c.name].made ? 'MADE' : '');
fs.writeFileSync(outPath.replace(/\.glb$/, '.clips.json'), JSON.stringify(clips.map((c) => ({ name: c.name, duration: +c.duration.toFixed(3), ...meta[c.name] })), null, 1));
