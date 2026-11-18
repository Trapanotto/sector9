// Shared input state. Mouse deltas accumulate until consumeMouse() is called (once per frame by the player).
//
// Raw mouse: pointer lock is requested with { unadjustedMovement: true } (no OS acceleration, counts straight
// from the device) and falls back to a plain lock where that is unsupported. Browsers occasionally deliver a
// single absurd movement delta (on lock, on focus changes, when the hidden cursor warps); those are dropped.
//
// Clicks are counted, not just flagged, so two presses inside one frame are never merged into one.

// Movement deltas larger than this in a single event are treated as spurious (raw devices at 1000 Hz deliver at
// most a few hundred counts per event even in very fast flicks).
const SPURIOUS_ABS = 700;
// ...or a sudden jump this many times larger than the recent average movement (and above SPURIOUS_MIN).
const SPURIOUS_RATIO = 12, SPURIOUS_MIN = 220;

// Keys whose browser default (scrolling, find-as-you-type, focus moves) is suppressed while the game has the lock.
const BLOCK = new Set(['Tab', 'Space', 'KeyF', 'KeyR', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageDown', 'PageUp', 'End', 'Home', 'Delete', 'Enter', 'NumpadEnter', 'Numpad0', 'Numpad1', 'NumpadDecimal',
  'ControlRight', 'ShiftRight', 'Backspace', 'Slash', 'Quote']);

export function createInput(dom) {
  const keys = new Set();
  const pressed = new Set(); // edge-triggered, cleared in endFrame()
  const mouse = {
    dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false,
    leftClicks: 0,             // number of left presses since the last endFrame() (never merged)
    rawMovement: false,        // true when the lock was granted with unadjustedMovement
    dropped: 0,                // spurious deltas discarded (diagnostics)
  };
  let avgMag = 0;              // running mean |delta| of recent events
  let skipEvents = 0;          // events to ignore right after the lock is acquired

  const locked = () => !!window.__fakeLock || document.pointerLockElement === dom;

  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
    if (locked() && BLOCK.has(e.code)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); mouse.left = mouse.right = false; });
  addEventListener('mousemove', (e) => {
    if (!locked()) return;
    const x = e.movementX || 0, y = e.movementY || 0;
    if (skipEvents > 0) { skipEvents--; return; }
    const m = Math.abs(x) + Math.abs(y);
    if (Math.abs(x) > SPURIOUS_ABS || Math.abs(y) > SPURIOUS_ABS ||
        (m > SPURIOUS_MIN && m > SPURIOUS_RATIO * Math.max(avgMag, 4))) {
      mouse.dropped++;
      return;
    }
    avgMag += (m - avgMag) * 0.2;
    mouse.dx += x; mouse.dy += y;
  });
  addEventListener('mousedown', (e) => {
    if (!locked()) return;
    if (e.button === 0) { mouse.left = true; mouse.leftPressed = true; mouse.leftClicks++; }
    if (e.button === 2) { mouse.right = true; mouse.rightPressed = true; }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.left = false;
    if (e.button === 2) mouse.right = false;
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    // the first event(s) after a lock change often carry the cursor warp: drop them, reset the jump filter
    skipEvents = 2; avgMag = 0; mouse.dx = 0; mouse.dy = 0;
  });

  /** Pointer lock with raw (unaccelerated) movement where supported, plain lock otherwise. Returns a promise. */
  function requestLock() {
    if (!dom.requestPointerLock) return Promise.reject(new Error('no pointer lock'));
    const plain = () => {
      mouse.rawMovement = false;
      const r = dom.requestPointerLock();
      return r && typeof r.then === 'function' ? r : Promise.resolve();
    };
    let r;
    try { r = dom.requestPointerLock({ unadjustedMovement: true }); } catch (e) { return plain(); }
    if (!r || typeof r.then !== 'function') { mouse.rawMovement = false; return Promise.resolve(); }   // old API
    return r.then(() => { mouse.rawMovement = true; }, (err) => {
      // NotSupportedError (no raw input on this platform) -> plain lock; other errors (no user gesture, too soon
      // after an exit) are passed on so the caller can show a hint
      if (err && err.name === 'NotSupportedError') return plain();
      throw err;
    });
  }

  return {
    mouse,
    get locked() { return locked(); },
    down: (code) => keys.has(code),
    pressed: (code) => pressed.has(code),
    /** true if any of the codes is held / was pressed this frame */
    anyDown: (codes) => { for (const c of codes) if (keys.has(c)) return true; return false; },
    anyPressed: (codes) => { for (const c of codes) if (pressed.has(c)) return true; return false; },
    consumeMouse() { const d = { dx: mouse.dx, dy: mouse.dy }; mouse.dx = 0; mouse.dy = 0; return d; },
    requestLock,
    exitLock() { document.exitPointerLock?.(); },
    endFrame() { pressed.clear(); mouse.leftPressed = false; mouse.rightPressed = false; mouse.leftClicks = 0; },
  };
}
