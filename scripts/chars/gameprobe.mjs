// Debug helper: start the game in a throwaway headless Edge profile, enter play, evaluate JS files/expressions.
// usage: node gameprobe.mjs <url> <expr-or-file.js> [screenshot.jpg] [WxH]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [, , url, exprArg, shot, size = '1280x720'] = process.argv;
const expr = fs.existsSync(exprArg) ? fs.readFileSync(exprArg, 'utf8') : exprArg;
const [W, H] = size.split('x').map(Number);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameprobe-'));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new', userDataDir: profile,
  args: ['--guest', '--disable-sync', '--disable-extensions', '--no-first-run', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = (await browser.pages())[0] || await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
await page.setViewport({ width: W, height: H });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("window.__ctx && window.__ctx.state === 'menu'", { timeout: 120000 });
await page.evaluate(() => { window.__fakeLock = true; const b = document.querySelector('[data-a=start]'); if (b) b.click(); else window.__ctx.setState('playing'); });
await new Promise((r) => setTimeout(r, 1500));
const v = await page.evaluate(`(async () => { const c = window.__ctx; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${expr} })()`);
console.log(JSON.stringify(v, null, 1));
if (shot) await page.screenshot({ path: shot, type: 'jpeg', quality: 88 });
console.log(logs.filter((l) => !l.startsWith('[log]') && !l.startsWith('[info]') && !l.startsWith('[debug]')).slice(0, 20).join('\n'));
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
