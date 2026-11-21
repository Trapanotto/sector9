// Screenshot automation for tools/char-viewer pages.
// Launches Edge headless with a throwaway profile (--guest, no sync, no extensions).
// usage: node shoot.mjs <jobs.json>   jobs: [{url, out, w?, h?, clip?, t?, wait?, eval?}]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'charviewer-'));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  userDataDir: profile,
  args: ['--guest', '--disable-sync', '--disable-extensions', '--no-first-run', '--use-angle=d3d11', '--enable-gpu',
    '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = (await browser.pages())[0] || await browser.newPage();
page.on('console', (m) => { if (['error', 'warn'].includes(m.type())) console.log('[page]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let lastUrl = null;
for (const j of jobs) {
  await page.setViewport({ width: j.w || 1600, height: j.h || 900 });
  if (j.url !== lastUrl) {
    await page.goto(j.url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__ready === true', { timeout: 180000 });
    lastUrl = j.url;
  }
  if (j.clip) await page.evaluate((c, t) => window.__setClip(c, t), j.clip, j.t || 0);
  if (j.eval) console.log('eval:', JSON.stringify(await page.evaluate(j.eval)));
  await new Promise((r) => setTimeout(r, j.wait ?? 150));
  if (j.out) {
    fs.mkdirSync(path.dirname(j.out), { recursive: true });
    await page.screenshot({ path: j.out });
    console.log('shot', j.out);
  }
}
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
