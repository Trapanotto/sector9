// Drop (or restore) a single variation without rebuilding the library. The engine never plays a variation
// whose manifest entry has `disabled` set; a sound whose variations are all disabled falls back to its
// stand-in (see FALLBACK in src/audio/bank.js) or stays silent.
//
//   node scripts/audio/disable.mjs voice/pain_07.mp3 "clicks at the start"
//   node scripts/audio/disable.mjs --enable voice/pain_07.mp3
//   node scripts/audio/disable.mjs --list
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAN = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/assets/audio/manifest.json');
const man = JSON.parse(readFileSync(MAN, 'utf8'));
const args = process.argv.slice(2);
const all = Object.entries(man.sounds).flatMap(([name, s]) => s.variations.map((v) => [name, v]));
if (args[0] === '--list' || !args.length) {
  const d = all.filter(([, v]) => v.disabled);
  console.log(d.length ? d.map(([n, v]) => `${n}  ${v.file}  — ${v.disabled}`).join('\n') : 'no disabled variations');
  process.exit(0);
}
const enable = args[0] === '--enable';
const file = enable ? args[1] : args[0];
const hit = all.find(([, v]) => v.file === file || v.file.endsWith('/' + file));
if (!hit) { console.error(`no variation with file ${file}`); process.exit(1); }
const [name, v] = hit;
if (enable) delete v.disabled; else v.disabled = args[1] || 'disabled by hand';
const left = man.sounds[name].variations.filter((x) => !x.disabled).length;
writeFileSync(MAN, JSON.stringify(man, null, 1) + '\n');
console.log(`${enable ? 'enabled' : 'disabled'} ${v.file} (${name}: ${left} variation(s) left)`);
