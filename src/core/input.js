// Shared input state. Mouse deltas accumulate until consumeMouse() is called (once per frame by the player).
export function createInput(dom) {
  const keys = new Set();
  const pressed = new Set(); // edge-triggered, cleared in endFrame()
  const mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };

  const locked = () => !!window.__fakeLock || document.pointerLockElement === dom;

  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) pressed.add(e.code);
    keys.add(e.code);
    if (locked() && ['Tab', 'Space', 'KeyF', 'KeyR'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); mouse.left = mouse.right = false; });
  addEventListener('mousemove', (e) => {
    if (!locked()) return;
    mouse.dx += e.movementX; mouse.dy += e.movementY;
  });
  addEventListener('mousedown', (e) => {
    if (!locked()) return;
    if (e.button === 0) { mouse.left = true; mouse.leftPressed = true; }
    if (e.button === 2) { mouse.right = true; mouse.rightPressed = true; }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.left = false;
    if (e.button === 2) mouse.right = false;
  });
  addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    mouse,
    get locked() { return locked(); },
    down: (code) => keys.has(code),
    pressed: (code) => pressed.has(code),
    consumeMouse() { const d = { dx: mouse.dx, dy: mouse.dy }; mouse.dx = 0; mouse.dy = 0; return d; },
    requestLock() { dom.requestPointerLock?.(); },
    exitLock() { document.exitPointerLock?.(); },
    endFrame() { pressed.clear(); mouse.leftPressed = false; mouse.rightPressed = false; },
  };
}
