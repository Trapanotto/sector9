// Full character pipeline. usage: node scripts/chars/build_all.mjs <cache_dir> [--skip-fetch] [--only enemies|anims|arms]
// Requires: python 3 with numpy + pillow, node deps from scripts/chars/package.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const repo = path.resolve(here, '../..');
const chars = path.join(repo, 'public/assets/chars');
const arms = path.join(repo, 'public/assets/arms');
const raw = path.join(chars, '_raw');
const [cache, ...flags] = process.argv.slice(2);
if (!cache) { console.error('usage: node build_all.mjs <cache_dir>'); process.exit(1); }
const only = flags.includes('--only') ? flags[flags.indexOf('--only') + 1] : null;
const run = (cmd, args) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', cwd: here }); };
fs.mkdirSync(raw, { recursive: true });
fs.mkdirSync(arms, { recursive: true });

if (!flags.includes('--skip-fetch')) run('python', ['-I', 'fetch_sources.py', cache]);
const variants = ['thug_jacket', 'thug_hoodie', 'thug_balaclava', 'thug_worker', 'thug_tee', 'thug_female'];
if (!only || only === 'enemies') {
  run('python', ['-I', 'build_enemies.py', cache, raw]);
  for (const v of variants) run('node', ['optimize.mjs', path.join(raw, `${v}_raw.glb`), path.join(chars, `${v}.glb`), '8000', '2500', '1024']);
}
const ref = path.join(raw, 'thug_jacket_raw.glb');
if (!only || only === 'enemies' || only === 'anims') {
  run('node', ['build_weapons.mjs', cache, ref, chars]);
  run('node', ['build_anims.mjs', cache, ref, path.join(chars, 'enemy_anims.glb')]);
  run('node', ['build_hitboxes.mjs', ref, path.join(chars, 'hitboxes.json')]);
  run('node', ['build_manifest.mjs', chars, raw]);
}
if (!only || only === 'arms') {
  run('python', ['-I', 'build_arms.py', cache, path.join(raw, 'arms_raw.glb')]);
  run('node', ['build_arms.mjs', cache, path.join(raw, 'arms_raw.glb'), arms]);
  run('node', ['check_penetration.mjs', path.join(arms, 'fp_arms_pistol.glb'), path.join(arms, 'penetration_mesh_check.json')]);
}
