// Runs the in-browser audio harness (scripts/audio/harness.html) in a THROWAWAY headless browser profile
// (InPrivate/guest, sync + extensions off, fresh user-data-dir) against a Vite dev server on port 5186, then
// writes scripts/audio/out/harness.json and the spectrogram PNGs.
//   node scripts/audio/run-harness.mjs [--scenes memory,yard,agc,...] [--no-server]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(HERE, 'out');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = +opt('--port', 5196), DBG = 9486;   // 5186 was taken by another workstream's server
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let alive = false;
try { alive = (await (await fetch(`http://localhost:${PORT}/scripts/audio/harness.html`)).text()).includes('audio harness'); } catch { /* no server yet */ }
if (!alive && !argv.includes('--no-server')) {
  server = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* starting */ } await sleep(250); }
}
const prof = resolve(ROOT, `tmp/audio-harness-profile-${Date.now()}`);
const exe = process.env.BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!exe) { console.error('no browser found (set $BROWSER)'); process.exit(2); }
const browser = spawn(exe, ['--headless=new', exe.includes('msedge') ? '--inprivate' : '--incognito', '--guest', '--disable-sync', '--disable-extensions',
  '--no-first-run', `--user-data-dir=${prof}`, `--remote-debugging-port=${DBG}`, '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 75; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(200); }
const page = targets?.find((t) => t.type === 'page');
if (!page) { console.error('browser did not start'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.consoleAPICalled') console.log('  [page]', d.params.args.map((a) => a.value ?? a.description).join(' ')); if (d.method === 'Runtime.exceptionThrown') console.log('  [page error]', d.params.exceptionDetails?.exception?.description); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');
const scenes = opt('--scenes', '');
await send('Page.navigate', { url: `http://localhost:${PORT}/scripts/audio/harness.html${scenes ? '?scenes=' + scenes : ''}` });
let res = null;
for (let i = 0; i < 1200 && !res; i++) { await sleep(500); res = await ev('window.__harness ? JSON.stringify(window.__harness) : null'); }
ws.close(); browser.kill(); server?.kill();
await sleep(500); try { rmSync(prof, { recursive: true, force: true }); } catch { /* still locked */ }
if (!res) { console.error('harness timed out'); process.exit(1); }
const out = JSON.parse(res);
for (const [name, url] of Object.entries(out.pngs)) writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
delete out.pngs;
writeFileSync(resolve(OUT, 'harness.json'), JSON.stringify(out, null, 1));
const fails = out.checks.filter((c) => !c.ok);
console.log(`\nharness: ${out.checks.length} checks, ${fails.length} failures (${out.ms} ms) → scripts/audio/out/harness.json + PNGs`);
for (const f of fails) console.log(`  FAIL ${f.msg}`);
await sleep(300);
process.exit(fails.length ? 1 : 0);
