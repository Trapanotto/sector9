// Browser checks through a THROWAWAY headless browser profile (InPrivate, sync + extensions off, fresh
// user-data-dir) driven over the DevTools protocol. Never uses a personal profile.
//
//   node scripts/browser-check.mjs <mode> [--url http://localhost:5181/] [--out tmp/check] [--swiftshader] [--uncapped]
//   modes: bench  — __bench.run over all tiers (GPU-synced frame cost, draw calls, triangles)
//          shots  — screenshots of every LAYOUT.benchViews view
//          tour   — walks the whole level spawn → extraction with the real controller (__ctx.dev.autopilot)
//          walk   — holds W / ArrowLeft through real key events (input path)
//          alloc  — sampling heap profile (bytes allocated per frame, top sites)
//          script — --jsfile f.js (async body, `c` = __ctx) then a screenshot
//          text   — page text after load, e.g. with --flags "--disable-webgl" (error screens)
// Browser: $BROWSER, else Edge / Chrome default install paths on Windows.
// NOTE: numbers measured with --swiftshader are CPU software rendering, not a GPU benchmark.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'bench';
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const url = opt('--url', 'http://localhost:5181/'), out = resolve(opt('--out', 'tmp/check')), port = +opt('--port', 9471);
const sw = argv.includes('--swiftshader');
mkdirSync(out, { recursive: true });
const prof = resolve(out, 'profile');
rmSync(prof, { recursive: true, force: true });
const exe = process.env.BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find((p) => existsSync(p));
if (!exe) { console.error('no browser found (set $BROWSER)'); process.exit(2); }
const args = ['--headless=new', exe.includes('msedge') ? '--inprivate' : '--incognito', '--disable-sync', '--disable-extensions',
  '--no-first-run', `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--window-size=1280,720',
  '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ...(sw ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--use-angle=d3d11']),
  ...(argv.includes('--uncapped') || mode === 'bench' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ...(opt('--flags', '') ? opt('--flags', '').split(' ') : []), 'about:blank'];
const browser = spawn(exe, args, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 75; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(200); }
if (!targets) { console.error('browser did not start'); process.exit(2); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description }; return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }); writeFileSync(`${out}/${name}.jpg`, Buffer.from(r.result.data, 'base64')); };
const errors = [];
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' ')); });
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await send('Page.navigate', { url });
if (mode === 'text') {
  // e.g. --flags "--disable-webgl": print the page text after load (error screens)
  await sleep(4000);
  console.log(await ev('document.body.innerText'));
  ws.close(); browser.kill(); await sleep(300); process.exit(0);
}
for (let i = 0; i < 600; i++) { if ((await ev('window.__ctx?.state')) === 'menu') break; await sleep(100); }
const result = { mode, wallToMenuMs: Date.now() - t0, timings: await ev('window.__ctx.timings'), gpu: await ev('window.__ctx.quality.gpu'), tierAuto: await ev('window.__ctx.quality.tier.id') };
await ev("window.__fakeLock = true; document.querySelector('[data-a=start]').click(); 1");
await sleep(1500);
if (mode === 'bench') {
  result.bench = await ev(`window.__bench.run({ tiers: ${sw ? "['vlow']" : "['vlow','low','mid','high']"}, frames: ${sw ? 20 : 150}, settle: ${sw ? 5 : 40} })`);
} else if (mode === 'shots') {
  const n = await ev('window.__ctx.layout.benchViews.length');
  await ev('window.__ctx.debug.god = true; 1');
  for (let i = 0; i < n; i++) {
    const vid = await ev(`(()=>{const v=window.__ctx.layout.benchViews[${i}]; window.__ctx.player.teleport(v.pos,v.yaw,v.pitch||0,true); return v.id})()`);
    await sleep(2500);
    await shot(vid);
  }
} else if (mode === 'tour') {
  result.tour = await ev("window.__ctx.debug.god = true; window.__ctx.dev.autopilot(window.__ctx.dev.tour, { timeout: 400, speedKey: 'ShiftLeft' })");
  result.state = await ev('window.__ctx.state');
  await shot('tour_end');
} else if (mode === 'script') {
  // --js "<async body>" or --jsfile file.js evaluated in the page while playing, then a screenshot script.jpg
  const js = opt('--jsfile') ? (await import('node:fs')).readFileSync(opt('--jsfile'), 'utf8') : opt('--js', '');
  result.value = await ev(`(async () => { const c = window.__ctx; ${js} })()`);
  await shot(opt('--name', 'script'));
} else if (mode === 'alloc') {
  // sampling heap profiler while standing in the heaviest view: top allocation sites (hot-path allocation hunt)
  await ev('(()=>{const c=window.__ctx; c.debug.god=true; const v=c.layout.benchViews[0]; c.player.teleport(v.pos,v.yaw,0,false); return 1})()');
  await sleep(3000);
  await send('HeapProfiler.enable');
  await send('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const f0 = await ev('window.__ctx.time.frame');
  await sleep(6000);
  const prof = (await send('HeapProfiler.stopSampling')).result.profile;
  const frames = (await ev('window.__ctx.time.frame')) - f0;
  const sites = new Map();
  const walk = (n) => {
    const cf = n.callFrame, key = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/(src|node_modules)\//, '$1/')}:${cf.lineNumber + 1}`;
    sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
    for (const ch of n.children) walk(ch);
  };
  walk(prof.head);
  const total = [...sites.values()].reduce((a, b) => a + b, 0);
  result.alloc = { frames, bytesPerFrame: Math.round(total / frames), top: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${Math.round(v / frames)} B/frame  ${k}`) };
} else if (mode === 'walk') {
  const p0 = await ev('({...window.__ctx.player.pos})');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w' }); await sleep(3000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowLeft', key: 'ArrowLeft' }); await sleep(1000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowLeft', key: 'ArrowLeft' });
  result.walk = { p0, p1: await ev('({...window.__ctx.player.pos})') };
  await shot('walk');
}
result.errors = errors;
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
ws.close(); browser.kill();
await sleep(500);
process.exit(0);
