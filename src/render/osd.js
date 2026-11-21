// Burned-in bodycam OSD (timestamp, unit id, REC). Drawn into a small canvas once per second and composited in
// the single post pass. Owner: B (look) / F may change the text. Fictional device name — no real brand.
import * as THREE from 'three';

export function createOsd() {
  const W = 512, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  let last = -1;
  const start = new Date('2026-11-21T15:40:12');
  const pad = (n) => String(n).padStart(2, '0');
  function draw(seconds, rec) {
    const t = new Date(start.getTime() + seconds * 1000);
    const s1 = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}  ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} +0100`;
    const s2 = `S9-BWC 0417  POLIZEI  ${rec ? '● REC' : ''}`;
    g.clearRect(0, 0, W, H);
    g.font = '600 22px "Consolas", "DejaVu Sans Mono", monospace';
    g.textBaseline = 'top';
    // red channel = text, alpha = outline (the composite shader reads both)
    for (const [txt, y] of [[s1, 4], [s2, 34]]) {
      g.strokeStyle = 'rgba(0,0,0,1)'; g.lineWidth = 4; g.strokeText(txt, 6, y);
      g.fillStyle = 'rgba(255,255,255,1)'; g.fillText(txt, 6, y);
    }
    tex.needsUpdate = true;
  }
  return {
    texture: tex, width: W, height: H,
    update(seconds) {
      const s = Math.floor(seconds);
      if (s === last) return;
      last = s;
      draw(s, s % 2 === 0);
    },
  };
}
