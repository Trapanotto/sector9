// Contact sheet: every clip at several normalised times, one cell each.
// usage: node sheet.mjs <url> <out.png> [cell=360] [times=0,0.5,1] [filter regex]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const [, , url, out, cellArg = '360', timesArg = '0.05,0.5,0.98', filter = ''] = process.argv;
const cell = Number(cellArg);
const times = timesArg.split(',').map(Number);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'charviewer-'));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new', userDataDir: profile,
  args: ['--guest', '--disable-sync', '--disable-extensions', '--no-first-run', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
const page = (await browser.pages())[0];
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewport({ width: cell, height: cell });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__ready === true', { timeout: 180000 });
await page.evaluate(() => { const l = document.getElementById('ui'); if (l) l.style.display = 'none'; });
let clips = await page.evaluate(() => window.__clips);
if (filter) clips = clips.filter((c) => new RegExp(filter).test(c.name));
const tiles = [];
for (const c of clips) {
  for (const f of times) {
    await page.evaluate((n, t) => window.__setClip(n, t), c.name, f * c.duration);
    await page.evaluate((txt) => { const el = document.getElementById('label'); el.textContent = txt; el.style.fontSize = '11px'; }, `${c.name} ${(f * c.duration).toFixed(2)}s${c.made ? ' [made]' : ''}`);
    tiles.push(await page.screenshot({ type: 'png' }));
  }
}
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
const cols = times.length * Math.max(1, Math.floor(12 / times.length / 1.5));
const rows = Math.ceil(tiles.length / cols);
const comp = tiles.map((buf, i) => ({ input: buf, left: (i % cols) * cell, top: Math.floor(i / cols) * cell }));
await sharp({ create: { width: cols * cell, height: rows * cell, channels: 3, background: '#222' } }).composite(comp).png().toFile(out);
console.log('sheet', out, tiles.length, 'tiles', cols, 'x', rows);
