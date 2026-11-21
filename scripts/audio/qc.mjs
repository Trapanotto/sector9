// Audio library QC by signal analysis (nobody has listened to the files).
//
//   node scripts/audio/qc.mjs            analyse every manifest variation, write markers into the manifest
//                                        (onset, peakAt, tailEnd) and scripts/audio/qc.md (flags per clip)
//   node scripts/audio/qc.mjs --check    analyse only, exit 1 if a non-disabled clip has a hard flag
//
// Needs ffmpeg on PATH (decodes the shipped MP3 to mono f32 at 22.05 kHz). Markers (seconds, decoded time base,
// i.e. including the MP3 decoder delay the browser also sees):
//   onset   first sample within 30 dB of the clip peak  → the engine starts one-shots at onset-0.01 s
//   peakAt  time of the absolute peak                    → used to align slams/hits with game events
//   tailEnd last 10 ms frame above -50 dBFS              → long files are faded there
// Flags (hard = likely a bad clip, soft = check by ear):
//   hard: decode failure, NaN, digital clipping (> 20 samples ≥ 0.999), DC offset > 0.05, silent (< -45 dBFS peak),
//         loop seam jump > 12 dB of local RMS
//   soft: leading silence > 0.12 s on a one-shot, peak very late (> 70 % of a short one-shot), voice clip with
//         little speech-band energy, very long one-shot tail of silence
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const MAN = resolve(ROOT, 'public/assets/audio/manifest.json');
const SR = 22050;
const check = process.argv.includes('--check');
const man = JSON.parse(readFileSync(MAN, 'utf8'));

function decode(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', resolve(ROOT, 'public/assets/audio', file), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

// simple speech-band energy ratio: one-pole band split (rough, enough for "is this a voice at all")
function bandRatio(x) {
  let lp1 = 0, lp2 = 0, eAll = 0, eBand = 0;
  const a1 = Math.exp(-2 * Math.PI * 250 / SR), a2 = Math.exp(-2 * Math.PI * 4000 / SR);
  for (let i = 0; i < x.length; i++) {
    lp1 = a1 * lp1 + (1 - a1) * x[i]; lp2 = a2 * lp2 + (1 - a2) * x[i];
    const band = lp2 - lp1; eAll += x[i] * x[i]; eBand += band * band;
  }
  return eAll > 0 ? eBand / eAll : 0;
}

const rows = [];
let hard = 0, soft = 0, n = 0;
for (const [name, s] of Object.entries(man.sounds)) {
  for (const v of s.variations) {
    n++;
    const flags = [], softFlags = [];
    let x;
    try { x = decode(v.file); } catch (e) { flags.push('decode failed'); rows.push({ name, v, flags, softFlags }); hard++; continue; }
    let peak = 0, peakI = 0, nan = 0, clip = 0, sum = 0;
    for (let i = 0; i < x.length; i++) {
      const a = x[i];
      if (!Number.isFinite(a)) { nan++; continue; }
      const m = Math.abs(a); sum += a;
      if (m > peak) { peak = m; peakI = i; }
      if (m >= 0.999) clip++;
    }
    const dc = sum / x.length;
    const thr = peak * 10 ** (-30 / 20);
    let onsetI = 0; while (onsetI < x.length && Math.abs(x[onsetI]) < thr) onsetI++;
    // tail: last 10 ms frame with RMS above -50 dBFS
    const fr = Math.round(SR * 0.01);
    let tailI = 0;
    for (let f = 0; f + fr <= x.length; f += fr) { let e = 0; for (let i = f; i < f + fr; i++) e += x[i] * x[i]; if (db(Math.sqrt(e / fr)) > -50) tailI = f + fr; }
    const dur = x.length / SR;
    if (nan) flags.push(`${nan} NaN`);
    if (clip > 20) flags.push(`${clip} clipped samples`);
    if (Math.abs(dc) > 0.05) flags.push(`DC ${dc.toFixed(3)}`);
    if (db(peak) < -45) flags.push(`silent (peak ${db(peak).toFixed(1)} dBFS)`);
    if (!v.loop && !name.startsWith('ir.')) {
      if (onsetI / SR > 0.12) softFlags.push(`lead silence ${(onsetI / SR).toFixed(2)} s`);
      if (dur < 3 && peakI / x.length > 0.7) softFlags.push(`late peak ${(peakI / SR).toFixed(2)}/${dur.toFixed(2)} s`);
      if (dur - tailI / SR > 0.6) softFlags.push(`trailing silence ${(dur - tailI / SR).toFixed(2)} s`);
    }
    if (name.startsWith('voice.') && !name.includes('breath') && !name.includes('snore') && !name.includes('muffled')) {
      const br = bandRatio(x);
      if (br < 0.45) softFlags.push(`speech-band ratio ${br.toFixed(2)}`);
    }
    if (v.loop) {
      // seam: compare the samples around loopEnd→loopStart with the local RMS
      const a = Math.round(v.loopStart * SR), b = Math.round(v.loopEnd * SR);
      if (b < x.length && a > 2) {
        let e = 0; const w = Math.round(SR * 0.02);
        for (let i = b - w; i < b; i++) e += x[i] * x[i];
        const rms = Math.sqrt(e / w) + 1e-6;
        const jump = Math.abs(x[b - 1] - x[a]) - Math.abs(x[b - 1] - x[b - 2]);
        const jdb = db(Math.max(1e-9, jump)) - db(rms);
        if (jdb > 12) flags.push(`loop seam jump ${jdb.toFixed(1)} dB over local RMS`);
        v.seamDb = +jdb.toFixed(1);
      }
    }
    v.onset = +(onsetI / SR).toFixed(3);
    v.peakAt = +(peakI / SR).toFixed(3);
    v.tailEnd = +(tailI / SR).toFixed(3);
    if (flags.length && !v.disabled) hard++;
    if (softFlags.length && !v.disabled) soft++;
    rows.push({ name, v, flags, softFlags });
  }
}

const out = ['# Audio QC (signal analysis — nobody has listened)', '',
  `Generated by \`node scripts/audio/qc.mjs\`: ${n} clips, ${hard} with hard flags, ${soft} with soft flags (disabled clips excluded).`,
  'Disable a clip with `node scripts/audio/disable.mjs <file> "reason"` (the engine skips `disabled` variations).', '',
  '| sound | file | dur | onset | peakAt | tail | flags | soft flags | disabled |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  if (!r.flags.length && !r.softFlags.length && !r.v.disabled) continue;
  out.push(`| ${r.name} | ${r.v.file} | ${r.v.duration} | ${r.v.onset ?? ''} | ${r.v.peakAt ?? ''} | ${r.v.tailEnd ?? ''} | ${r.flags.join('; ')} | ${r.softFlags.join('; ')} | ${r.v.disabled ?? ''} |`);
}
out.push('', `Clips without any flag are not listed (${rows.filter((r) => !r.flags.length && !r.softFlags.length).length}).`);
writeFileSync(resolve(HERE, 'qc.md'), out.join('\n') + '\n');
if (!check) writeFileSync(MAN, JSON.stringify(man, null, 1) + '\n');
console.log(`qc: ${n} clips, ${hard} hard, ${soft} soft flags → scripts/audio/qc.md${check ? '' : ' (markers written to manifest.json)'}`);
if (check && hard) process.exit(1);
