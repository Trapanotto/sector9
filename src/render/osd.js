// Bodycam on-screen display: timestamp, device id, blinking REC dot.
// Rendered into a small canvas that the encoder pass burns into the image (so it goes through
// chroma subsampling, block quantisation and noise, but not through the lens), the way a camera's
// own overlay is recorded. Falls back to a DOM overlay when no 2D canvas is available.

import * as THREE from 'three';

export const OSD_DEVICE_ID = 'AX-9 CAM 04 · UNIT 7C21';

const pad = (n) => String(n).padStart(2, '0');

function stampOf(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}  ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function createDomOSD(overlay) {
  if (!overlay) return { update() {}, el: null, texture: null };
  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = [
    'position:absolute', 'top:2.4vh', 'right:2.2vw', 'text-align:right',
    'font-family:"DejaVu Sans Mono","Consolas","Menlo","Courier New",monospace',
    'font-weight:600', 'font-size:clamp(11px,1.02vw,16px)', 'line-height:1.38',
    'letter-spacing:0.06em', 'color:rgba(244,246,242,0.86)',
    'text-shadow:0 0 1px rgba(0,0,0,0.9),0 1px 3px rgba(0,0,0,0.65)',
    'white-space:pre', 'user-select:none', 'pointer-events:none',
  ].join(';');
  const line1 = document.createElement('div');
  const line2 = document.createElement('div');
  line2.textContent = OSD_DEVICE_ID;
  root.append(line1, line2);
  overlay.appendChild(root);
  return {
    el: root, texture: null,
    update(s) {
      const now = new Date();
      const on = s.standby || now.getMilliseconds() < 600;
      line1.textContent = `${on ? '●' : ' '} ${s.standby ? 'STBY' : 'REC '}  ${stampOf(now)}`;
      root.style.opacity = s.glitch > 0.05 && Math.random() < s.glitch * 0.35 ? '0.4' : '1';
    },
  };
}

export function createOSD(overlay) {
  let cv, g;
  try {
    cv = document.createElement('canvas');
    g = cv.getContext('2d');
  } catch { g = null; }
  if (!g) return createDomOSD(overlay);

  cv.width = 8; cv.height = 8;
  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // region in output uv (x0, y0 bottom-left, w, h) and pixel size; recomputed on resize
  const rect = new THREE.Vector4(0.6, 0.88, 0.38, 0.1);
  let dbW = 0, dbH = 0;
  let key = '';

  function layout(w, h) {
    dbW = w; dbH = h;
    const fs = Math.max(11, Math.round(h * 0.0215));
    const cw = Math.min(w, Math.round(fs * 27));
    const ch = Math.round(fs * 3.2);
    cv.width = cw; cv.height = ch;
    const right = Math.round(w * 0.022), top = Math.round(h * 0.026);
    rect.set((w - right - cw) / w, 1 - (top + ch) / h, cw / w, ch / h);
    key = '';
    return fs;
  }
  let fontPx = 14;

  function draw(standby, dotOn, stamp) {
    const W = cv.width, H = cv.height, fs = fontPx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = `600 ${fs}px "DejaVu Sans Mono", Consolas, Menlo, "Courier New", monospace`;
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    const x = W - Math.round(fs * 0.4);
    const y1 = Math.round(fs * 1.25), y2 = Math.round(fs * 2.6);
    const line1 = `${standby ? 'STBY' : 'REC'}   ${stamp}`;
    // dark key line under the text (overlay generators draw an edge so text reads on white)
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, fs * 0.16);
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.strokeText(line1, x, y1);
    g.strokeText(OSD_DEVICE_ID, x, y2);
    g.fillStyle = 'rgba(238,240,236,0.95)';
    g.fillText(line1, x, y1);
    g.fillStyle = 'rgba(238,240,236,0.80)';
    g.fillText(OSD_DEVICE_ID, x, y2);
    if (dotOn) {
      const tw = g.measureText(line1).width;
      const r = fs * 0.32;
      const cx = x - tw - fs * 0.62, cy = y1 - fs * 0.36;
      g.beginPath(); g.arc(cx, cy, r + g.lineWidth * 0.5, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fill();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = standby ? '#8a8a86' : '#e8261c'; g.fill();
    }
    texture.needsUpdate = true;
  }

  return {
    el: null,
    texture,
    rect,
    /** @param {{standby:boolean, glitch:number, width:number, height:number}} s */
    update(s) {
      if (s.width !== dbW || s.height !== dbH) fontPx = layout(s.width, s.height);
      const now = new Date();
      const dotOn = s.standby ? true : now.getMilliseconds() < 600;
      const stamp = stampOf(now);
      const k = `${s.standby}|${dotOn}|${stamp}`;
      if (k !== key) { key = k; draw(s.standby, dotOn, stamp); }
      // signal-loss flicker of the overlay
      return s.glitch > 0.05 && Math.random() < s.glitch * 0.35 ? 0.25 + Math.random() * 0.5 : 1;
    },
  };
}
