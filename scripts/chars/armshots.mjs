// Inspection grid for the first-person arms (char viewer): chest-camera views of the holds and clip frames plus
// orbit close-ups of the grip from the right, left, front and top. Throwaway headless Edge profile.
// usage: node armshots.mjs <viewer url (…/arms.html)> <out.jpg> [cellW=640] [cellH=360] [set=grip|reload|chest]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const [, , url, out, cwArg = '640', chArg = '360', set = 'grip'] = process.argv;
const W = Number(cwArg), H = Number(chArg);
const Y = 1.42; // chest camera height in the viewer
const orbit = (cam, tgt) => `__orbit([${cam}],[${tgt}])`;
const SETS = {
  grip: [
    ['fp_idle', 0, '__chest()', 'chest: hip/ready'],
    ['fp_aim', 0, '__chest()', 'chest: ADS'],
    ['fp_aim', 0, orbit([0.42, Y - 0.06, -0.28], [0, Y - 0.1, -0.33]), 'aim: right side'],
    ['fp_aim', 0, orbit([-0.42, Y - 0.06, -0.28], [0, Y - 0.1, -0.33]), 'aim: left side'],
    ['fp_aim', 0, orbit([0.12, Y - 0.3, -0.85], [0, Y - 0.1, -0.33]), 'aim: front low'],
    ['fp_aim', 0, orbit([0.05, Y + 0.3, -0.12], [0, Y - 0.1, -0.36]), 'aim: top'],
    ['fp_fire', 0.06, '__chest()', 'chest: fire 0.06 s'],
    ['fp_fire', 0.06, orbit([0.3, Y - 0.1, -0.33], [0, Y - 0.13, -0.33]), 'fire 0.06: trigger finger (right)'],
    ['fp_lowready', 0, '__chest()', 'chest: low ready'],
  ],
  reload: [0.1, 0.3, 0.55, 0.8, 1.05, 1.3, 1.45, 1.6, 1.85, 2.15].map((t) => ['fp_reload', t, '__chest()', `reload ${t}s`])
    .concat([[1.3, 1.45].map((t) => ['fp_reload', t, orbit([-0.4, Y - 0.25, -0.2], [0, Y - 0.15, -0.3]), `reload ${t}s left-low`])].flat()),
  chest: [['fp_idle', 0, '__chest()', 'hip'], ['fp_aim', 0, '__chest()', 'ADS'], ['fp_fire', 0.05, '__chest()', 'fire'], ['fp_lowready', 0, '__chest()', 'low ready'], ['fp_sprint', 0.2, '__chest()', 'sprint'], ['fp_reload', 1.0, '__chest()', 'reload 1.0']],
};
const jobs = SETS[set];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'armshots-'));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new', userDataDir: profile,
  args: ['--guest', '--disable-sync', '--disable-extensions', '--no-first-run', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = (await browser.pages())[0] || await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 200)); });
await page.setViewport({ width: W, height: H });
await page.goto(url + (url.includes('?') ? '&' : '?') + 'paused', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
const cells = [];
for (const [clip, t, ev, title] of jobs) {
  await page.evaluate((c, tt) => window.__setClip(c, tt), clip, t);
  await page.evaluate(ev);
  await page.evaluate((s) => { const el = document.getElementById('label'); if (el) el.textContent = s; document.getElementById('ui').style.display = 'none'; }, title);
  await new Promise((r) => setTimeout(r, 120));
  cells.push(await page.screenshot({ type: 'png' }));
}
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
const cols = Math.min(3, cells.length), rows = Math.ceil(cells.length / cols);
const comp = cells.map((b, i) => ({ input: b, left: (i % cols) * W, top: Math.floor(i / cols) * H }));
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#222' } }).composite(comp).jpeg({ quality: 82 }).toFile(out);
console.log('wrote', out);
