// Shared input state (adapted from v1). Raw mouse via pointer lock { unadjustedMovement: true } with fallback;
// absurd single deltas (lock / focus warps) are dropped. Clicks are counted, never merged.
// Test hook: window.__fakeLock = true makes the game behave as if the pointer were locked (automation).
// Owner: core. Actions are resolved through ctx.settings bindings: input.held('forward'), input.hit('use').
const SPURIOUS_ABS = 700, SPURIOUS_RATIO = 12, SPURIOUS_MIN = 220;

export function createInput(dom, settings) {
  const keys = new Set();
  const pressed = new Set();   // edge-triggered, cleared in endFrame()
  const mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, leftClicks: 0, rawMovement: false, dropped: 0, wheel: 0 };
  let avgMag = 0, skipEvents = 0;
  const locked = () => !!window.__fakeLock || document.pointerLockElement === dom;
  const blockSet = () => {
    const s = new Set(['Tab', 'Space']);
    for (const ks of Object.values(settings.data.bindings)) for (const k of ks) if (k !== 'Escape' && k !== 'F9') s.add(k);
    return s;
  };
  let BLOCK = blockSet();

  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
    if ((locked() && BLOCK.has(e.code)) || e.code === 'F9') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); mouse.left = mouse.right = false; });
  addEventListener('mousemove', (e) => {
    if (!locked()) return;
    const x = e.movementX || 0, y = e.movementY || 0;
    if (skipEvents > 0) { skipEvents--; return; }
    const m = Math.abs(x) + Math.abs(y);
    if (Math.abs(x) > SPURIOUS_ABS || Math.abs(y) > SPURIOUS_ABS || (m > SPURIOUS_MIN && m > SPURIOUS_RATIO * Math.max(avgMag, 4))) { mouse.dropped++; return; }
    avgMag += (m - avgMag) * 0.2;
    mouse.dx += x; mouse.dy += y;
  });
  addEventListener('mousedown', (e) => {
    if (!locked()) return;
    if (e.button === 0) { mouse.left = true; mouse.leftPressed = true; mouse.leftClicks++; }
    if (e.button === 2) { mouse.right = true; mouse.rightPressed = true; }
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) mouse.left = false; if (e.button === 2) mouse.right = false; });
  addEventListener('wheel', (e) => { if (locked()) mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
  addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => { skipEvents = 2; avgMag = 0; mouse.dx = 0; mouse.dy = 0; });

  function requestLock() {
    if (window.__fakeLock) return Promise.resolve();
    if (!dom.requestPointerLock) return Promise.reject(new Error('no pointer lock'));
    const plain = () => { mouse.rawMovement = false; const r = dom.requestPointerLock(); return r && typeof r.then === 'function' ? r : Promise.resolve(); };
    let r;
    try { r = dom.requestPointerLock({ unadjustedMovement: true }); } catch { return plain(); }
    if (!r || typeof r.then !== 'function') { mouse.rawMovement = false; return Promise.resolve(); }
    return r.then(() => { mouse.rawMovement = true; }, (err) => { if (err && err.name === 'NotSupportedError') return plain(); throw err; });
  }
  const anyDown = (codes) => { for (let i = 0; i < codes.length; i++) if (keys.has(codes[i])) return true; return false; };
  const anyPressed = (codes) => { for (let i = 0; i < codes.length; i++) if (pressed.has(codes[i])) return true; return false; };

  return {
    mouse,
    get locked() { return locked(); },
    down: (code) => keys.has(code),
    pressed: (code) => pressed.has(code),
    anyDown, anyPressed,
    /** action held (any bound key) */
    held: (action) => anyDown(settings.keys(action)),
    /** action pressed this frame */
    hit: (action) => anyPressed(settings.keys(action)),
    /** mouse delta since the last call (writes into out to avoid allocations) */
    takeMouse(out) { out.dx = mouse.dx; out.dy = mouse.dy; mouse.dx = 0; mouse.dy = 0; return out; },
    requestLock,
    exitLock() { if (!window.__fakeLock) document.exitPointerLock?.(); },
    rebuildBlock() { BLOCK = blockSet(); },
    /** automation: press/release a key code virtually (devtools autopilot) */
    inject(code, down) { if (down) { if (!keys.has(code)) pressed.add(code); keys.add(code); } else keys.delete(code); },
    endFrame() { pressed.clear(); mouse.leftPressed = false; mouse.rightPressed = false; mouse.leftClicks = 0; mouse.wheel = 0; },
  };
}
