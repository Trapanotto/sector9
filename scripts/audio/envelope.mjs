// Print a coarse peak envelope (dBFS per 100 ms) of audio files, for checking clips by eye in the terminal.
//   node scripts/audio/envelope.mjs ir/hall_01.mp3 voice/scream_20.mp3   (paths relative to public/assets/audio)
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/assets/audio');
const step = 0.1;
for (const f of process.argv.slice(2)) {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', resolve(BASE, f), '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const w = Math.round(22050 * step), o = [];
  for (let i = 0; i + w <= x.length; i += w) { let p = 0; for (let j = i; j < i + w; j++) p = Math.max(p, Math.abs(x[j])); o.push((20 * Math.log10(p + 1e-9)).toFixed(0)); }
  console.log(`${f}: ${o.join(' ')}`);
}
