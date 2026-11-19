// Dev / test helpers for the player module. Not imported by the game; load from the browser console:
//   const dev = await import('/src/player/devtools.js');
//   await dev.start(-9, 24);            // start the mission (fake pointer lock), freeze the AI, teleport
//   dev.inspect([x, y, z, rx, ry, rz]); // pose the viewmodel freely in front of the camera (null = off)
//   await dev.sample([[u0, v0, u1, v1]]) // mean sRGB of screen rectangles (0..1 coordinates)
//   const r = dev.controlTest();        // automated mouse-path / frame-rate test (see controlTest below)

const ctx = () => window.__ctx;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function start(x = -9, z = 24, yaw = 0) {
  const c = ctx();
  for (let i = 0; i < 200 && c.game.state === 'loading'; i++) await wait(100);
  window.__fakeLock = true;
  if (c.game.state === 'menu') {
    [...document.querySelectorAll('button')].find((b) => /einsatz beginnen/i.test(b.textContent))?.click();
    await wait(300);
  }
  c.enemies.update = () => {};
  c.player.position.set(x, 0, z);
  c.player.setLook(yaw, 0);
  c.pipeline.resetExposure?.();
  await wait(1200);
}

/** wait for loading, start with frozen AI and an invulnerable player; exposes window.dev / window.T */
export async function boot(x, z, yaw) {
  for (let i = 0; i < 300 && (!window.__ctx || window.__ctx.game.state === 'loading'); i++) await wait(100);
  await start(x, z, yaw);
  ctx().player.takeDamage = () => {};
  window.T = ctx().player.tuning;
  return ctx().game.state;
}

/** run fn right after the next pipeline.render (the drawing buffer is still valid then) */
export function afterRender(fn) {
  const pl = ctx().pipeline;
  if (!pl.__devWrapped) {
    const orig = pl.render;
    pl.__devQ = [];
    pl.render = function (dt) { orig(dt); const q = pl.__devQ.splice(0); for (const f of q) f(); };
    pl.__devWrapped = true;
  }
  pl.__devQ.push(fn);
}

export function sample(rects) {
  return new Promise((res) => afterRender(() => afterRender(() => {
    const cnv = ctx().renderer.domElement, W = cnv.width, H = cnv.height;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); g.drawImage(cnv, 0, 0);
    res(rects.map(([u0, v0, u1, v1]) => {
      const d = g.getImageData(Math.round(u0 * W), Math.round(v0 * H), Math.max(1, Math.round((u1 - u0) * W)), Math.max(1, Math.round((v1 - v0) * H))).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
    }));
  })));
}

/**
 * Freeze the current frame into an overlay image in the top-left corner (width w CSS px; crop [u0,v0,u1,v1]
 * optional). Screenshot tools that only capture part of the page then still see the whole frame. snap(0) removes.
 */
export function snap(w = 480, crop = null) {
  let el = document.getElementById('__devsnap');
  if (!w) { el?.remove(); return Promise.resolve(); }
  return new Promise((res) => afterRender(() => {
    const cnv = ctx().renderer.domElement;
    const [u0, v0, u1, v1] = crop || [0, 0, 1, 1];
    const sw = (u1 - u0) * cnv.width, sh = (v1 - v0) * cnv.height;
    const cv = document.createElement('canvas');
    cv.width = Math.round(w); cv.height = Math.round(w * sh / sw);
    cv.getContext('2d').drawImage(cnv, u0 * cnv.width, v0 * cnv.height, sw, sh, 0, 0, cv.width, cv.height);
    if (!el) {
      el = document.createElement('img'); el.id = '__devsnap';
      el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;image-rendering:auto;';
      document.body.appendChild(el);
    }
    el.src = cv.toDataURL('image/png');
    el.style.width = `${cv.width}px`;
    el.onload = () => res();
  }));
}

/**
 * Render several states into one overlay image (cols per row, 1280 CSS px wide). Each entry is either a viewmodel
 * inspect pose array or an async function that sets up the state; crop is [u0, v0, u1, v1] of the canvas.
 */
export async function grid(states, crop = [0, 0, 1, 1], cols = 2) {
  const cnv = ctx().renderer.domElement;
  const out = document.createElement('canvas');
  const rows = Math.ceil(states.length / cols);
  const cw = Math.round(1280 / cols);
  const ch = Math.round(cw * ((crop[3] - crop[1]) * cnv.height) / ((crop[2] - crop[0]) * cnv.width));
  out.width = cw * cols; out.height = ch * rows;
  const g = out.getContext('2d');
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (typeof s === 'function') await s(); else inspect(s);
    await wait(250);
    await new Promise((r) => afterRender(() => {
      g.drawImage(cnv, crop[0] * cnv.width, crop[1] * cnv.height, (crop[2] - crop[0]) * cnv.width, (crop[3] - crop[1]) * cnv.height,
        (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
      r();
    }));
  }
  let el = document.getElementById('__devsnap');
  if (!el) {
    el = document.createElement('img'); el.id = '__devsnap';
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.src = out.toDataURL();
  el.style.width = '1280px';
  await new Promise((r) => { el.onload = r; });
  return [out.width, out.height];
}

/** Override the viewmodel pose (camera space position + YXZ euler) for close inspection; null restores. */
export function inspect(o) {
  const root = ctx().player.viewmodel.root;
  if (!root.__inspBase) {
    root.__inspBase = root.updateMatrixWorld.bind(root);
    root.updateMatrixWorld = function (f) {
      const v = root.__insp;
      if (v) { root.position.set(v[0], v[1], v[2]); root.rotation.set(v[3] || 0, v[4] || 0, v[5] || 0, 'YXZ'); }
      root.__inspBase(f);
    };
  }
  root.__insp = o;
}

/** Clean image chain for geometry inspection (no lens distortion, noise, DOF, TNR); call again with false. */
let saved = null;
export function clean(on = true) {
  const T = ctx().pipeline.tuning;
  if (on && !saved) {
    saved = { fisheye: T.fisheye, noise: T.noise, dof: T.dof, tnr: T.tnr, dirtStrength: T.dirtStrength, mosquito: T.mosquito };
    Object.assign(T, { fisheye: 0, noise: 0, dof: 0, tnr: 0, dirtStrength: 0, mosquito: 0 });
  } else if (!on && saved) { Object.assign(T, saved); saved = null; }
}

// ---------------------------------------------------------------------------------------------------------
// Automated control test.
//
// Drives player.update() directly with a fixed dt (simulated 30 / 60 / 144 Hz) and a scripted mouse path given as
// a continuous function of time (counts per second), so every rate sees exactly the same physical mouse motion.
// Measures, per rate:
//   - aimErr:   max |world aim yaw - integral of the mouse path * sensitivity| (latency/smoothing on the aim: 0)
//   - camLagMs: mean lag of the rendered camera yaw behind the body yaw during the steady part of a slow turn
//   - drift:    aim / camera change during 2 s without input after the path ends (should be 0 / settle)
//   - and compares the camera yaw trajectories of all rates at common timestamps (frame-rate independence).
// The real game state is saved and restored; the AI must be frozen (start() does that).
export function controlTest(opts = {}) {
  const c = ctx(), p = c.player, input = c.input;
  const rates = opts.rates || [30, 60, 144];
  const S = p.settings;
  const sens = 0.022 * Math.PI / 180 * S.sens;   // rad per count at the hip (matches tuning.SENS_UNIT)
  // mouse path (counts / s) over 4.5 s: slow tracking, fast flick right, small corrections, circle, flick back
  const path = opts.path || ((t) => {
    let vx = 0, vy = 0;
    if (t < 1.0) { vx = 300; vy = 60 * Math.sin(t * 6); }                         // slow track right
    else if (t < 1.15) { vx = 12000 * Math.sin((t - 1.0) / 0.15 * Math.PI); }      // fast flick right
    else if (t < 1.8) { vx = 120 * Math.sin((t - 1.15) * 25); vy = 80 * Math.cos((t - 1.15) * 19); }   // micro corrections
    else if (t < 3.3) { const a = (t - 1.8) * 4.2; vx = -900 * Math.sin(a); vy = 900 * Math.cos(a); }  // circles
    else if (t < 3.5) { vx = -9000 * Math.sin((t - 3.3) / 0.2 * Math.PI); }        // flick back left
    return [vx, vy];
  });
  const T_PATH = opts.duration || 3.6, T_IDLE = 2.0;

  // save state
  const origConsume = input.consumeMouse, origLocked = window.__fakeLock;
  const pos0 = p.position.clone();
  const res = {};
  const traces = {};
  window.__fakeLock = true;
  try {
    for (const hz of rates) {
      p.position.copy(pos0); p.velocity.set(0, 0, 0);
      p.setLook(0, 0);
      const dt = 1 / hz;
      let t = 0, mx = 0, my = 0, aimErr = 0, aimErrP = 0, lagSum = 0, lagN = 0;
      // integrate the path exactly over each frame (fine sub-sampling) so every rate gets the same total motion
      let pend = [0, 0];
      input.consumeMouse = () => { const d = { dx: pend[0], dy: pend[1] }; pend = [0, 0]; return d; };
      const tr = [];
      const nFrames = Math.round((T_PATH + T_IDLE) * hz);
      let endAim = null, endCam = null;
      for (let f = 0; f < nFrames; f++) {
        let dx = 0, dy = 0;
        const sub = 32;
        for (let i = 0; i < sub; i++) {
          const ts = t + (i + 0.5) * dt / sub;
          const [vx, vy] = ts < T_PATH ? path(ts) : [0, 0];
          dx += vx * dt / sub; dy += vy * dt / sub;
        }
        pend = [dx, dy]; mx += dx; my += dy;
        t += dt;
        p.update(dt);
        const a = p.debugAim();
        const aimYaw = a.bodyYaw + a.aimX, aimPitch = a.bodyPitch + a.aimY;
        const expYaw = -mx * sens, expPitch = -my * sens;
        // pitch can hit the limits; compare only while inside them
        aimErr = Math.max(aimErr, Math.abs(aimYaw - expYaw));
        if (Math.abs(expPitch) < 1.2) aimErrP = Math.max(aimErrP, Math.abs(aimPitch - expPitch));
        if (t > 0.35 && t < 0.95) {           // steady slow turn: camera lag behind the body, in ms
          const rate = 300 * sens;            // rad/s of the slow track
          lagSum += (a.bodyYaw - a.camYaw) / rate * 1000; lagN++;
        }
        if (Math.abs(t - T_PATH) < dt / 2 + 1e-9 && !endAim) { endAim = aimYaw; endCam = a.camYaw; }
        tr.push([t, a.camYaw, aimYaw, a.bodyYaw]);
      }
      const last = p.debugAim();
      // overshoot: camera passing its final resting angle while settling (fighting the player)
      let over = 0;
      const sgnS = Math.sign(last.camYaw - endCam) || 1;
      for (const s of tr) if (s[0] > T_PATH) over = Math.max(over, (s[1] - last.camYaw) * sgnS);
      // and during the whole path: camera ahead of the body in the direction the body is moving
      let lead = 0;
      for (let i = 1; i < tr.length; i++) {
        const dv = tr[i][3] - tr[i - 1][3];
        if (Math.abs(dv) > 1e-6) lead = Math.max(lead, (tr[i][1] - tr[i][3]) * Math.sign(dv));
      }
      res[hz] = {
        idleOvershootDeg: +(over * 180 / Math.PI).toFixed(3),
        camAheadOfBodyDeg: +(lead * 180 / Math.PI).toFixed(3),
        aimErrDeg: +(aimErr * 180 / Math.PI).toExponential(2),
        aimErrPitchDeg: +(aimErrP * 180 / Math.PI).toExponential(2),
        camLagMs: +(lagSum / Math.max(1, lagN)).toFixed(2),
        idleAimDriftDeg: +(((last.bodyYaw + last.aimX) - endAim) * 180 / Math.PI).toExponential(2),
        idleCamSettleDeg: +((last.camYaw - endCam) * 180 / Math.PI).toFixed(3),
        finalGunOffsetDeg: +(last.aimX * 180 / Math.PI).toFixed(3),
      };
      traces[hz] = tr;
    }
    // frame-rate independence: compare camera yaw of each rate with the highest rate at the lower rate's samples
    const ref = traces[rates[rates.length - 1]];
    const interp = (trc, t, k) => {
      let i = 1; while (i < trc.length - 1 && trc[i][0] < t) i++;
      const a = trc[i - 1], b = trc[i], f = (t - a[0]) / (b[0] - a[0] || 1);
      return a[k] + (b[k] - a[k]) * Math.min(1, Math.max(0, f));
    };
    for (const hz of rates.slice(0, -1)) {
      let mxCam = 0, mxBody = 0;
      for (const s of traces[hz]) {
        if (s[0] < 2 / hz) continue;
        mxCam = Math.max(mxCam, Math.abs(s[1] - interp(ref, s[0], 1)));
        mxBody = Math.max(mxBody, Math.abs(s[3] - interp(ref, s[0], 3)));
      }
      res[hz].camVsRefDeg = +(mxCam * 180 / Math.PI).toFixed(4);
      res[hz].bodyVsRefDeg = +(mxBody * 180 / Math.PI).toFixed(4);
    }
  } finally {
    input.consumeMouse = origConsume;
    window.__fakeLock = origLocked;
    p.position.copy(pos0); p.velocity.set(0, 0, 0); p.setLook(0, 0);
  }
  return { settings: { ...S }, results: res };
}
