// In-game screenshots of the first-person view (C acceptance shots): bright yard, dim hall, dark basement at
// 1280x720 and 760x630, hip / ADS / fire / reload. Throwaway headless Edge profile (--guest, no sync/extensions).
// usage: node gameshots.mjs <game url> <out dir> [views=all]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const [, , url = 'http://localhost:5184/', out = 'tmp/c-shots', only = ''] = process.argv;
fs.mkdirSync(out, { recursive: true });
const PLACES = {
  yard: { pos: [45, 0, 100], yaw: 0, pitch: -0.05, light: true },
  hall: { pos: [47, 0, 28.5], yaw: Math.PI / 2, pitch: -0.03 },
  basement: { pos: [20, -3.7, 47.6], yaw: -Math.PI / 2, pitch: -0.05, flash: true, dark: true },
};
const POSES = {
  hip: 'c.input.mouse.right=false;',
  ads: 'c.input.mouse.right=true;',
  fire: 'c.input.mouse.right=true; c.input.mouse.leftClicks=1;',
  reload: 'c.input.mouse.right=false; c.weapon.mags.mag=3; c.input.inject("KeyR",true); setTimeout(()=>c.input.inject("KeyR",false),50);',
};
const SIZES = [[1280, 720], [760, 630]];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshots-'));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new', userDataDir: profile,
  args: ['--guest', '--disable-sync', '--disable-extensions', '--no-first-run', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = (await browser.pages())[0] || await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
const stats = {};
const cells = [];
for (const [W, H] of SIZES) {
  await page.setViewport({ width: W, height: H });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("window.__ctx && window.__ctx.state === 'menu'", { timeout: 120000 });
  await page.evaluate(() => { window.__fakeLock = true; const b = document.querySelector('[data-a=start]'); if (b) b.click(); else window.__ctx.setState('playing'); });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => { const c = window.__ctx; c.debug.god = true; c.setState('playing'); });
  for (const [pn, P] of Object.entries(PLACES)) {
    for (const [posn, js] of Object.entries(POSES)) {
      const name = `${pn}_${posn}_${W}x${H}`;
      if (only && !name.includes(only)) continue;
      await page.evaluate((P) => {
        const c = window.__ctx;
        c.weapon.reset?.(); c.input.mouse.right = false;
        c.player.teleport(P.pos, P.yaw, P.pitch, false);
        if (c.player.flashlight !== !!P.flash) c.player.flashlight = !!P.flash;
        if (P.dark) c.world.lights?.setCircuit?.('keller', 0, 0);
      }, P);
      await new Promise((r) => setTimeout(r, 1300));
      await page.evaluate(`(()=>{const c=window.__ctx; ${js} })()`);
      await new Promise((r) => setTimeout(r, posn === 'fire' ? 30 : posn === 'reload' ? 1150 : 700));
      const s = await page.evaluate(() => { const c = window.__ctx, st = c.render.stats; return { calls: st.calls, sceneCalls: st.sceneCalls, tris: st.triangles, ammo: c.weapon.ammo, reserve: c.weapon.reserve, fps: c.perf?.fps, state: c.state }; });
      stats[name] = s;
      const file = path.join(out, name + '.jpg');
      await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
      cells.push({ file, W, H });
      await page.evaluate(() => { const c = window.__ctx; c.input.mouse.right = false; });
    }
  }
}
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
// contact sheets per size
for (const [W, H] of SIZES) {
  const cs = cells.filter((c) => c.W === W);
  if (!cs.length) continue;
  const cw = Math.round(W / 2), ch = Math.round(H / 2), cols = 4, rows = Math.ceil(cs.length / cols);
  const comp = await Promise.all(cs.map(async (c, i) => ({ input: await sharp(c.file).resize(cw, ch).toBuffer(), left: (i % cols) * cw, top: Math.floor(i / cols) * ch })));
  await sharp({ create: { width: cols * cw, height: rows * ch, channels: 3, background: '#222' } }).composite(comp).jpeg({ quality: 80 }).toFile(path.join(out, `sheet_${W}x${H}.jpg`));
}
fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify({ stats, errors }, null, 1));
console.log(JSON.stringify({ errors: errors.slice(0, 10), sample: Object.entries(stats).slice(0, 4) }, null, 1));
