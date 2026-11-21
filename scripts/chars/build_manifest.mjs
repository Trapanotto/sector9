// Writes public/assets/chars/manifest.json from the stage outputs.
// usage: node build_manifest.mjs <chars_dir> <raw_dir>
import fs from 'node:fs';
import path from 'node:path';

const [, , dir, rawDir] = process.argv;
const meta = JSON.parse(fs.readFileSync(path.join(rawDir, 'meta.json'), 'utf8'));
const weapons = JSON.parse(fs.readFileSync(path.join(dir, 'weapons', 'weapons.json'), 'utf8'));
const clips = JSON.parse(fs.readFileSync(path.join(dir, 'enemy_anims.clips.json'), 'utf8'));
const defaultWeapon = { thug_jacket: 'pistol', thug_hoodie: 'smg', thug_balaclava: 'shotgun', thug_worker: 'pistol', thug_tee: 'smg', thug_female: 'pistol' };
const size = (f) => fs.statSync(path.join(dir, f)).size;
const manifest = {
  version: 1,
  convention: { units: 'metres', up: '+Y', forward: '+Z (glTF default; rotate by PI to face -Z)', left: '+X' },
  skeleton: { joints: 41, root: 'root', note: 'variants carry their height in the root bone scale (rootScale)' },
  variants: Object.entries(meta).map(([name, m]) => ({
    name, file: `${name}.glb`, lod0: `${name}_LOD0`, lod1: `${name}_LOD1`, lod2: `${name}_LOD2`, rootScale: m.root_scale, height: m.height_m,
    weapon: defaultWeapon[name] || 'pistol', bytes: size(`${name}.glb`),
  })),
  anims: 'enemy_anims.glb',
  clips,
  weapons: Object.fromEntries(Object.entries(weapons).map(([k, w]) => [k, { ...w, bytes: size(w.file) }])),
  hitboxes: 'hitboxes.json',
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('manifest:', manifest.variants.length, 'variants,', clips.length, 'clips');
