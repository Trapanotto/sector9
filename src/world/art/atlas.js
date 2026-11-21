// Procedural texture atlas for the world art (workstream A). Painted once at load into ONE canvas (no downloads,
// no third-party assets), uploaded as one sRGB texture with mipmaps. Tile rects come from tiles.js.
// All painters are deterministic (seeded noise) so every run looks the same.
import { TILES, ATLAS_W, ATLAS_H, GUTTER } from './tiles.js';

// ---- tileable value noise ------------------------------------------------------------------------------------
function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const m = (a, p) => ((a % p) + p) % p;
  const a = hash2(m(xi, px), m(yi, py), s), b = hash2(m(xi + 1, px), m(yi, py), s);
  const c = hash2(m(xi, px), m(yi + 1, py), s), d = hash2(m(xi + 1, px), m(yi + 1, py), s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** fbm in 0..1, tileable over the tile (u, v in 0..1), base frequency f cells per tile */
function fbm(u, v, f, oct, s, fy = f) {
  let sum = 0, amp = 0.5, tot = 0, F = f, G = fy;
  for (let o = 0; o < oct; o++) { sum += amp * vnoise(u * F, v * G, F, G, s + o * 31); tot += amp; amp *= 0.5; F *= 2; G *= 2; }
  return sum / tot;
}
const clamp = (v, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- per-pixel helper --------------------------------------------------------------------------------------------
function pixels(g, w, h, fn) {
  const img = g.createImageData(w, h), d = img.data, o = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    o[3] = 255; fn((x + 0.5) / w, (y + 0.5) / h, o, x, y);
    const i = (y * w + x) * 4; d[i] = clamp(o[0]); d[i + 1] = clamp(o[1]); d[i + 2] = clamp(o[2]); d[i + 3] = clamp(o[3]);
  }
  g.putImageData(img, 0, 0);
}
const rgb = (o, r, g, b, a = 255) => { o[0] = r; o[1] = g; o[2] = b; o[3] = a; };
function grime(g, w, h, seed, amount = 0.25, color = '40,34,28') {
  // soft dirt blotches (multiplied over existing pixels)
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const [cr, cg, cb] = color.split(',').map(Number);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = fbm(x / w, y / h, 4, 4, seed);
    const t = sstep(0.55, 0.8, n) * amount;
    const i = (y * w + x) * 4;
    d[i] = mix(d[i], cr, t); d[i + 1] = mix(d[i + 1], cg, t); d[i + 2] = mix(d[i + 2], cb, t);
  }
  g.putImageData(img, 0, 0);
}
function text(g, s, x, y, size, color, o = {}) {
  g.save();
  g.font = `${o.weight ?? 'bold'} ${size}px ${o.font ?? 'Arial, Helvetica, sans-serif'}`;
  g.fillStyle = color; g.textAlign = o.align ?? 'center'; g.textBaseline = o.base ?? 'middle';
  if (o.scaleX) { g.translate(x, y); g.scale(o.scaleX, 1); g.fillText(s, 0, 0); } else g.fillText(s, x, y);
  g.restore();
}
function barcode(g, x, y, w, h, seed) {
  let px = x; let k = seed;
  g.fillStyle = '#111';
  while (px < x + w - 2) { k = (k * 1103515245 + 12345) >>> 0; const bw = 1 + ((k >>> 16) % 3); if ((k >>> 8) & 1) g.fillRect(px, y, bw, h); px += bw + 1; }
}

// ---- painters (canvas 2D context, tile width, height) ----------------------------------------------------------------
const PAINT = {
  paint(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const n = fbm(u, v, 6, 5, 11), s = fbm(u, v, 40, 2, 12);
      let c = 212 + (n - 0.5) * 34 + (s - 0.5) * 10;
      const scr = vnoise(u * 3, v * 90, 3, 90, 13); if (scr > 0.93) c += 25;          // fine scratches
      const chip = fbm(u, v, 32, 3, 14); if (chip > 0.8) c *= 0.82;                  // small paint chips
      rgb(o, c, c, c * 0.98);
    });
    grime(g, w, h, 15, 0.12);
  },
  steel(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const b = vnoise(u * 2, v * 120, 2, 120, 21), n = fbm(u, v, 5, 4, 22);
      const c = 150 + (b - 0.5) * 22 + (n - 0.5) * 30;
      rgb(o, c, c * 1.01, c * 1.03);
    });
    grime(g, w, h, 23, 0.25);
  },
  galv(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const cellN = vnoise(u * 14, v * 14, 14, 14, 31), n = fbm(u, v, 4, 4, 32);
      const c = 168 + (Math.round(cellN * 4) / 4 - 0.5) * 24 + (n - 0.5) * 20;
      rgb(o, c, c * 1.01, c * 1.02);
    });
  },
  plastic(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 205 + (fbm(u, v, 5, 4, 41) - 0.5) * 22; rgb(o, c, c, c); }); },
  rubber(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 46 + (fbm(u, v, 8, 4, 51) - 0.5) * 18 + (hash2(u * 999 | 0, v * 999 | 0, 5) - 0.5) * 6; rgb(o, c, c, c * 1.03); }); },
  tread(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      // diamond checker plate (two orientations alternating)
      const cx = (u * 4) % 1, cy = (v * 4) % 1, odd = ((Math.floor(u * 4) + Math.floor(v * 4)) & 1) === 1;
      const dx = cx - 0.5, dy = cy - 0.5;
      const a = odd ? (dx + dy) : (dx - dy), b = odd ? (dx - dy) : (dx + dy);
      const lens = Math.abs(a) < 0.07 && Math.abs(b) < 0.32;
      let c = 120 + (fbm(u, v, 6, 3, 61) - 0.5) * 30;
      if (lens) c += 45 * (1 - Math.abs(b) / 0.32);
      rgb(o, c, c, c * 1.02);
    });
    grime(g, w, h, 62, 0.35);
  },
  hazard(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const s = ((u * w + v * h) / (h * 1.0)) % 1;
      const worn = fbm(u, v, 8, 4, 71);
      if (s < 0.5) rgb(o, 232, 178, 18); else rgb(o, 26, 25, 24);
      if (worn > 0.68) { const t = sstep(0.68, 0.8, worn); o[0] = mix(o[0], 120, t); o[1] = mix(o[1], 118, t); o[2] = mix(o[2], 112, t); }
    });
  },
  wood(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const grain = Math.sin((v * 9 + fbm(u, v, 3, 3, 81, 2) * 3.5) * Math.PI * 2) * 0.5 + 0.5;
      const n = fbm(u, v, 2, 5, 82, 6);
      let r = 196, gg = 160, b = 114;
      const k = 0.82 + grain * 0.12 + (n - 0.5) * 0.3;
      const knot = vnoise(u * 5, v * 2, 5, 2, 83) > 0.9 ? 0.6 : 1;
      const dirt = fbm(u, v, 3, 4, 84) > 0.62 ? 0.75 : 1;
      rgb(o, r * k * knot * dirt, gg * k * knot * dirt, b * k * knot * dirt * 0.97);
    });
  },
  woodboard(g, w, h) {
    // OSB: random flakes
    pixels(g, w, h, (u, v, o) => { const c = 175 + (fbm(u, v, 4, 3, 91) - 0.5) * 40; rgb(o, c, c * 0.8, c * 0.55); });
    let k = 7;
    for (let i = 0; i < 420; i++) {
      k = (k * 16807) % 2147483647; const x = (k % 1000) / 1000 * w; k = (k * 16807) % 2147483647; const y = (k % 1000) / 1000 * h;
      k = (k * 16807) % 2147483647; const a = (k % 628) / 100; k = (k * 16807) % 2147483647; const t = 0.75 + (k % 50) / 100;
      g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = `rgba(${150 * t | 0},${112 * t | 0},${70 * t | 0},0.55)`;
      g.fillRect(-14, -4, 28, 8); g.restore();
    }
  },
  laminate(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 200 + (fbm(u, v, 6, 4, 101) - 0.5) * 12; rgb(o, c, c * 0.98, c * 0.93); }); grime(g, w, h, 102, 0.15); },
  concrete(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 160 + (fbm(u, v, 6, 5, 111) - 0.5) * 50; rgb(o, c, c, c * 0.97); }); },
  glassdark(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 26 + (1 - v) * 30 + (fbm(u, v, 3, 3, 121) - 0.5) * 10; rgb(o, c, c * 1.08, c * 1.18); }); },
  light(g, w, h) { pixels(g, w, h, (u, v, o) => rgb(o, 255, 252, 244)); },
  cardboard(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const n = fbm(u, v, 8, 5, 131), f = Math.sin(u * w * 0.9) * 0.5 + 0.5;
      const k = 0.92 + (n - 0.5) * 0.22 + f * 0.025;
      rgb(o, 178 * k, 134 * k, 88 * k);
    });
  },
  carton(g, w, h) { cartonFace(g, w, h, 0); },
  carton2(g, w, h) { cartonFace(g, w, h, 1); },
  cartonstack(g, w, h) {
    // a pallet face of 2 columns × 3 rows of cartons
    PAINT.cardboard(g, w, h);
    const cols = 2, rows = 3;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * w / cols, y = r * h / rows, cw = w / cols, ch = h / rows;
      g.fillStyle = `rgba(0,0,0,${0.05 + ((r * 7 + c * 3) % 5) * 0.025})`; g.fillRect(x, y, cw, ch);
      g.fillStyle = 'rgba(30,20,10,0.75)'; g.fillRect(x, y + ch - 3, cw, 3); g.fillRect(x + cw - 2, y, 2, ch);
      g.fillStyle = 'rgba(205,170,120,0.55)'; g.fillRect(x + cw / 2 - 9, y, 18, ch * 0.18);   // tape flap
      if ((r + c) % 2 === 0) { g.fillStyle = '#ecebe4'; g.fillRect(x + 10, y + ch - 38, 44, 28); barcode(g, x + 13, y + ch - 30, 38, 14, r * 5 + c); }
      text(g, (r + c) % 3 === 0 ? '↑↑' : '', x + cw - 22, y + 20, 18, 'rgba(40,30,20,0.7)');
    }
    grime(g, w, h, 141, 0.18);
  },
  wrap(g, w, h) {
    PAINT.cartonstack(g, w, h);
    pixels2(g, w, h, (u, v, d, i) => {
      // stretch film: milky, diagonal wraps + vertical crease highlights
      const band = Math.sin((v * 7 + u * 1.2) * Math.PI * 2) * 0.5 + 0.5;
      const crease = Math.pow(vnoise(u * 18, v * 2, 18, 2, 151), 6);
      const t = 0.42 + band * 0.12 + crease * 0.35 + (fbm(u, v, 5, 3, 152) - 0.5) * 0.15;
      d[i] = mix(d[i], 232, t); d[i + 1] = mix(d[i + 1], 236, t); d[i + 2] = mix(d[i + 2], 240, t);
    });
  },
  wraptop(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const a = Math.atan2(v - 0.5, u - 0.5), r = Math.hypot(u - 0.5, v - 0.5);
      const cr = Math.pow(Math.abs(Math.sin(a * 7 + fbm(u, v, 3, 2, 161) * 4)), 8) * sstep(0.1, 0.5, r);
      const c = 196 + cr * 40 + (fbm(u, v, 6, 3, 162) - 0.5) * 20;
      rgb(o, c * 0.96, c * 0.95, c * 0.93);
    });
  },
  brick(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const n = fbm(u, v, 6, 4, 171), shine = Math.pow(vnoise(u * 6, v * 3, 6, 3, 172), 5);
      const tape = Math.abs(v - 0.5) < 0.18 || Math.abs(u - 0.3) < 0.08;
      if (tape) rgb(o, 150 + n * 30, 112 + n * 20, 60 + n * 10); else rgb(o, 205 + n * 30, 200 + n * 25, 178 + n * 20);
      o[0] += shine * 50; o[1] += shine * 50; o[2] += shine * 50;
    });
    g.strokeStyle = 'rgba(160,20,20,0.85)'; g.lineWidth = 3; g.beginPath(); g.arc(w * 0.75, h * 0.5, 12, 0, 7); g.stroke();
    text(g, 'K9', w * 0.75, h * 0.5, 11, 'rgba(160,20,20,0.9)');
  },
  money(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const edge = Math.sin(v * h * 2.2) * 0.5 + 0.5;
      const n = fbm(u, v, 6, 3, 181);
      rgb(o, 150 + n * 30 + edge * 15, 165 + n * 25 + edge * 15, 140 + n * 20 + edge * 10);
    });
    g.fillStyle = 'rgba(70,110,90,0.35)'; g.fillRect(w * 0.15, 0, w * 0.3, h);
    g.fillStyle = '#d9cfae'; g.fillRect(w * 0.42, 0, w * 0.16, h);   // paper band
    g.fillStyle = 'rgba(90,60,30,0.6)'; g.fillRect(w * 0.42, 0, 2, h); g.fillRect(w * 0.58 - 2, 0, 2, h);
  },
  pallet_side(g, w, h) { palletSide(g, w, h, true); },
  pallet_end(g, w, h) { palletSide(g, w, h, false); },
  pallet_top(g, w, h) {
    g.clearRect(0, 0, w, h);
    const tmp = makeTile('wood', 256, 128);
    // 5 deck boards along u (1200), widths 145/100/145/100/145 of 800 across v
    const bw = [145, 100, 145, 100, 145], gap = (800 - 635) / 4;
    let z = 0;
    for (let i = 0; i < 5; i++) {
      const y0 = z / 800 * h, y1 = (z + bw[i]) / 800 * h;
      g.drawImage(tmp, 0, (i * 37) % 64, 256, 64, 0, y0, w, y1 - y0);
      g.fillStyle = `rgba(0,0,0,${0.06 * (i % 3)})`; g.fillRect(0, y0, w, y1 - y0);
      // nail heads
      g.fillStyle = 'rgba(60,60,60,0.8)';
      for (const xx of [0.06, 0.5, 0.94]) for (const dy of [0.3, 0.7]) g.fillRect(xx * w - 1, y0 + (y1 - y0) * dy - 1, 2, 2);
      z += bw[i] + gap;
    }
  },
  upright(g, w, h) {
    // gentian-blue C-profile face with a double column of teardrop slots, 8 per tile (50 mm pitch over 0.4 m)
    pixels(g, w, h, (u, v, o) => { const n = fbm(u, v, 3, 4, 191, 12); const e = Math.min(u, 1 - u) < 0.08 ? 0.75 : 1; rgb(o, 24 * e + n * 10, 58 * e + n * 14, 128 * e + n * 22); });
    g.fillStyle = '#05070c';
    for (let k = 0; k < 8; k++) for (const cx of [0.3, 0.7]) {
      const y = (k + 0.5) * h / 8, x = cx * w;
      g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x + 3.5, y - 3); g.arc(x, y + 2, 4.5, -0.3, Math.PI + 0.3); g.closePath(); g.fill();
    }
    grime(g, w, h, 192, 0.2);
    scuffs(g, w, h, 193, 'rgba(160,160,150,0.5)', 10);
  },
  beam(g, w, h) {
    pixels(g, w, h, (u, v, o) => { const n = fbm(u, v, 8, 3, 201, 2), hl = 1 - Math.abs(v - 0.35) * 0.6; rgb(o, (200 + n * 30) * hl, (82 + n * 14) * hl, (24 + n * 8) * hl); });
    scuffs(g, w, h, 202, 'rgba(90,70,60,0.6)', 6);
  },
  lacing(g, w, h) {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgb(26,60,132)'; g.lineWidth = 7; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(-4, -h * 0.02); g.lineTo(w + 4, h * 0.5); g.lineTo(-4, h * 1.02); g.stroke();
    g.strokeStyle = 'rgba(10,25,60,0.6)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-4, h * 0.0 + 4); g.lineTo(w + 4, h * 0.5 + 4); g.lineTo(-4, h * 1.0 + 4); g.stroke();
  },
  wiredeck(g, w, h) {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgb(150,152,150)';
    for (let i = 0; i < 4; i++) g.fillRect(i * w / 4, 0, 2, h);
    for (let i = 0; i < 8; i++) g.fillRect(0, i * h / 8, w, 2);
  },
  mesh(g, w, h) {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgb(140,142,140)';
    for (let i = 0; i < 4; i++) { g.fillRect(i * w / 4, 0, 3, h); g.fillRect(0, i * h / 4, w, 3); }
  },
  labels(g, w, h) {
    g.fillStyle = '#e9e8e2'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      const c = i % 2, r = (i / 2) | 0, x = c * w / 2, y = r * h / 4;
      g.fillStyle = '#f2f2ec'; g.fillRect(x + 2, y + 2, w / 2 - 4, h / 4 - 4);
      text(g, `${String.fromCharCode(65 + (i % 4))}-${String(3 + i * 2).padStart(2, '0')}-0${1 + (i % 5)}`, x + 40, y + h / 8, 13, '#111');
      barcode(g, x + 78, y + 6, 46, h / 4 - 12, i * 13 + 1);
    }
  },
  loadsign(g, w, h) {
    g.fillStyle = '#f1c40f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#111'; g.lineWidth = 3; g.strokeRect(3, 3, w - 6, h - 6);
    text(g, 'max. Fachlast', w / 2, 20, 13, '#111'); text(g, '1000 kg', w / 2, 44, 22, '#111');
    text(g, 'max. Feldlast 6000 kg', w / 2, 72, 11, '#111');
  },
  signs(g, w, h) { paintSigns(g, w, h); },
  screen(g, w, h) {
    g.fillStyle = '#1d2a35'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2f4456'; g.fillRect(0, 0, w, 12);
    text(g, 'FÖRDERTECHNIK  ÜBERSICHT', 6, 6, 8, '#c8d6e0', { align: 'left' });
    g.strokeStyle = '#6f8a9c'; g.lineWidth = 5; g.strokeRect(30, 26, 190, 80);
    g.strokeStyle = '#3fbf5a'; g.lineWidth = 5; g.beginPath(); g.moveTo(30, 26); g.lineTo(150, 26); g.stroke();
    g.strokeStyle = '#d9a21c'; g.beginPath(); g.moveTo(220, 50); g.lineTo(220, 106); g.stroke();
    for (let i = 0; i < 5; i++) { g.fillStyle = i === 2 ? '#d64232' : '#3fbf5a'; g.fillRect(226, 36 + i * 14, 14, 8); }
    g.fillStyle = '#d64232'; g.fillRect(6, 114, 60, 10); text(g, 'STÖRUNG', 36, 119, 7, '#fff');
    pixels2(g, w, h, (u, v, d, i) => { const s = (Math.sin(v * h * Math.PI) * 0.5 + 0.5) * 0.12; d[i] *= 1 - s; d[i + 1] *= 1 - s; d[i + 2] *= 1 - s; });
  },
  panel(g, w, h) {
    g.fillStyle = '#b9bcb8'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f1c40f'; g.beginPath(); g.arc(40, 64, 30, 0, 7); g.fill();
    g.fillStyle = '#b3160e'; g.beginPath(); g.arc(40, 64, 20, 0, 7); g.fill();
    g.fillStyle = '#e0302a'; g.beginPath(); g.arc(36, 60, 12, 0, 7); g.fill();
    text(g, 'NOT-HALT', 40, 108, 10, '#111');
    const B = [['#2e9a45', 'EIN'], ['#e8e8e8', 'AUS'], ['#2b6cc4', 'QUIT'], ['#e8a91c', 'HAND']];
    B.forEach(([c, l], i) => { g.fillStyle = '#333'; g.beginPath(); g.arc(104 + i * 38, 54, 13, 0, 7); g.fill(); g.fillStyle = c; g.beginPath(); g.arc(104 + i * 38, 54, 10, 0, 7); g.fill(); text(g, l, 104 + i * 38, 80, 9, '#111'); });
    g.fillStyle = '#222'; g.fillRect(96, 94, 150, 22); g.fillStyle = '#4fd26a'; text(g, 'BEREIT  0,60 m/s', 171, 105, 10, '#4fd26a');
  },
  floorline(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const wear = fbm(u, v, 4, 5, 221);
      rgb(o, 226, 180, 28);
      const t = sstep(0.55, 0.75, wear) * 0.75; o[0] = mix(o[0], 120, t); o[1] = mix(o[1], 118, t); o[2] = mix(o[2], 110, t);
    });
  },
  stencil(g, w, h) {
    pixels(g, w, h, (u, v, o) => rgb(o, 105, 104, 100, 0));
    text(g, 'ACHTUNG  FTS', w / 2, h / 2, 72, 'rgb(230,182,30)', { scaleX: 1.0 });
    pixels2(g, w, h, (u, v, d, i) => { const wear = fbm(u, v, 6, 4, 231); if (wear > 0.62) d[i + 3] = 0; });
  },
  decals(g, w, h) {
    const c = w / 2;
    // 0: forklift capacity plate
    g.fillStyle = '#ddd'; g.fillRect(0, 0, c, c); g.fillStyle = '#111'; g.fillRect(6, 6, c - 12, 22);
    text(g, 'TRAGFÄHIGKEIT', c / 2, 17, 12, '#fff'); text(g, '2500 kg', c / 2, 56, 26, '#111'); text(g, 'LSP 500 mm', c / 2, 88, 14, '#111');
    // 1: AGV label
    g.fillStyle = '#1c1c1c'; g.fillRect(c, 0, c, c); text(g, 'FTS', c * 1.5, 34, 30, '#f1c40f'); text(g, '03', c * 1.5, 82, 40, '#fff');
    // 2: warning triangle
    g.fillStyle = '#eee'; g.fillRect(0, c, c, c);
    g.fillStyle = '#f1c40f'; g.strokeStyle = '#111'; g.lineWidth = 6; g.beginPath(); g.moveTo(c / 2, c + 14); g.lineTo(c - 12, 2 * c - 16); g.lineTo(12, 2 * c - 16); g.closePath(); g.fill(); g.stroke();
    text(g, '!', c / 2, c + 74, 46, '#111');
    // 3: data matrix / floor code
    g.fillStyle = '#fff'; g.fillRect(c, c, c, c);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (x === 0 || y === 9 || ((x * 7 + y * 13 + x * y) % 3 === 0)) { g.fillStyle = '#111'; g.fillRect(c + 14 + x * 10, c + 14 + y * 10, 10, 10); }
  },
  totes(g, w, h) {
    // stacked blue KLT bins: 2 × 2 per tile, lighter rims, grip holes, white labels
    pixels(g, w, h, (u, v, o) => { const n = fbm(u, v, 6, 3, 341); rgb(o, 28 + n * 14, 70 + n * 20, 150 + n * 25); });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      const x = c * w / 2, y = r * h / 2;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y + h / 2 - 4, w / 2, 4); g.fillRect(x + w / 2 - 2, y, 2, h / 2);
      g.fillStyle = 'rgba(120,170,230,0.45)'; g.fillRect(x, y, w / 2, 5);
      g.fillStyle = '#0a1a33'; g.fillRect(x + w / 4 - 10, y + 10, 20, 7);
      g.fillStyle = '#eeeeea'; g.fillRect(x + 8, y + 26, 30, 18); barcode(g, x + 10, y + 34, 26, 8, r * 3 + c);
    }
  },
  facade(g, w, h) {
    g.fillStyle = '#14295e'; g.fillRect(0, 0, w, h);
    text(g, 'LOGISTIKZENTRUM  HAFENSTRASSE', w / 2, h / 2 + 2, 54, '#f2f2ee', { scaleX: 1.0 });
    pixels2(g, w, h, (u, v, d, i) => { const n = fbm(u, v, 24, 3, 247, 2); const t = n * 0.12; d[i] *= 1 - t; d[i + 1] *= 1 - t; d[i + 2] *= 1 - t; });
  },
  slats(g, w, h) {
    // roller door curtain: horizontal ribbed slats (8 per tile), light grey
    pixels(g, w, h, (u, v, o) => { const p = (v * 8) % 1; const sh = p < 0.12 ? 0.62 : p < 0.5 ? 1.0 : p < 0.6 ? 1.1 : 0.9; const c = 190 * sh * (0.95 + (fbm(u, v, 4, 3, 251) - 0.5) * 0.12); rgb(o, c, c * 1.01, c * 1.03); });
    grime(g, w, h, 252, 0.2);
  },
  container(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      // trapezoidal corrugation: 4 ribs per tile (flat outer face, slanted flanks, flat inner face)
      const p = (u * 4) % 1;
      const sh = p < 0.1 ? 0.62 : p < 0.45 ? 1.0 : p < 0.55 ? 1.18 : 0.86;
      const n = fbm(u, v, 3, 4, 241), streak = fbm(u, v, 24, 2, 242, 3);
      let c = 200 * sh * (0.94 + (n - 0.5) * 0.12);
      const rust = sstep(0.7, 0.85, streak * (0.55 + (1 - v) * 0.5)) * 0.6;
      rgb(o, mix(c, 120, rust), mix(c, 70, rust), mix(c, 40, rust));
    });
    grime(g, w, h, 243, 0.3);
  },
  trailer(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const strap = (u * 22) % 1 < 0.06;
      const fold = Math.sin(u * 22 * Math.PI * 2) * 0.04;
      const n = fbm(u, v, 12, 4, 251, 3);
      let c = 218 * (1 + fold + (n - 0.5) * 0.08);
      if (strap) c *= 0.55;
      const dirt = sstep(0.75, 1.0, v) * 0.35;
      rgb(o, c * (1 - dirt) , c * (1 - dirt), c * (1 - dirt * 0.9));
    });
    text(g, 'HOLM', 150, 56, 64, 'rgba(25,55,110,0.92)', { scaleX: 1.15 });
    text(g, 'SPEDITION · KÜHLLOGISTIK', 150, 96, 16, 'rgba(25,55,110,0.92)');
    text(g, 'HOLM', 380, 56, 64, 'rgba(25,55,110,0.0)');
  },
  tarp(g, w, h) { pixels(g, w, h, (u, v, o) => { const c = 120 + (fbm(u, v, 6, 4, 261) - 0.5) * 30; rgb(o, c * 0.8, c * 0.9, c); }); },
  belt(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const weave = ((Math.floor(u * 64) + Math.floor(v * 64)) & 1) * 6;
      const n = fbm(u, v, 4, 4, 271);
      let c = 38 + weave + (n - 0.5) * 14;
      if (Math.abs(v - 0.5) < 0.012) c += 30;   // splice line (makes the motion readable)
      rgb(o, c, c, c);
    });
  },
  roller(g, w, h) {
    pixels(g, w, h, (u, v, o) => { let c = 170 + (fbm(u, v, 4, 3, 281) - 0.5) * 30 + (vnoise(u * 2, v * 40, 2, 40, 282) - 0.5) * 20; if (v < 0.08) c *= 0.45; rgb(o, c, c, c * 1.02); });
  },
  fabric(g, w, h) { pixels(g, w, h, (u, v, o) => { const wv = ((Math.floor(u * 96) ^ Math.floor(v * 96)) & 1) * 8; const c = 150 + wv + (fbm(u, v, 5, 4, 291) - 0.5) * 40; rgb(o, c, c, c); }); },
  mattress(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const stripe = (u * 18) % 1 < 0.35;
      const n = fbm(u, v, 5, 4, 301);
      rgb(o, stripe ? 150 : 215, stripe ? 165 : 212, stripe ? 182 : 200);
      o[0] *= 0.92 + n * 0.12; o[1] *= 0.92 + n * 0.12; o[2] *= 0.92 + n * 0.12;
      const st = fbm(u, v, 3, 4, 302);
      const t = sstep(0.6, 0.72, st) * 0.45; o[0] = mix(o[0], 140, t); o[1] = mix(o[1], 110, t); o[2] = mix(o[2], 60, t);
      const q = (Math.abs(((u * 6) % 1) - 0.5) < 0.02 && Math.abs(((v * 8) % 1) - 0.5) < 0.02); if (q) { o[0] *= 0.6; o[1] *= 0.6; o[2] *= 0.6; }
    });
  },
  cabinet(g, w, h) {
    pixels(g, w, h, (u, v, o) => { const c = 200 + (fbm(u, v, 5, 4, 311) - 0.5) * 16; rgb(o, c, c, c * 0.97); });
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(w / 2 - 1, 4, 2, h - 8);                                          // door split
    g.fillStyle = '#333'; g.fillRect(w / 2 - 12, h * 0.45, 5, 26); g.fillRect(w / 2 + 7, h * 0.45, 5, 26);         // handles
    for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(30,30,30,0.7)'; g.fillRect(10, h - 50 + i * 7, w / 2 - 22, 3); g.fillRect(w / 2 + 12, h - 50 + i * 7, w / 2 - 22, 3); }
    g.fillStyle = '#f1c40f'; g.beginPath(); g.moveTo(32, 30); g.lineTo(48, 58); g.lineTo(16, 58); g.closePath(); g.fill();
    g.fillStyle = '#111'; g.beginPath(); g.moveTo(34, 38); g.lineTo(28, 49); g.lineTo(33, 49); g.lineTo(30, 56); g.lineTo(37, 46); g.lineTo(32, 46); g.lineTo(36, 38); g.fill();
    g.fillStyle = '#fff'; g.fillRect(w / 2 + 10, 28, 40, 16); text(g, '=A1+S2', w / 2 + 30, 36, 8, '#111');
    grime(g, w, h, 312, 0.15);
  },
  locker(g, w, h) {
    pixels(g, w, h, (u, v, o) => { const c = 165 + (fbm(u, v, 5, 4, 321) - 0.5) * 16; rgb(o, c * 0.92, c * 0.96, c); });
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(w / 2 - 1, 0, 2, h); g.fillRect(0, 0, 2, h); g.fillRect(w - 2, 0, 2, h);
    for (const x0 of [0, w / 2]) {
      for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(20,20,20,0.75)'; g.fillRect(x0 + 14, 18 + i * 6, w / 2 - 28, 3); g.fillRect(x0 + 14, h - 46 + i * 6, w / 2 - 28, 3); }
      g.fillStyle = '#ddd'; g.fillRect(x0 + w / 4 - 10, 60, 20, 10);
      g.fillStyle = '#222'; g.fillRect(x0 + w / 2 - 12, h * 0.52, 5, 14);
    }
    grime(g, w, h, 322, 0.2);
  },
  drum(g, w, h) {
    pixels(g, w, h, (u, v, o) => {
      const rib = Math.abs(v - 0.33) < 0.03 || Math.abs(v - 0.66) < 0.03 ? 0.72 : 1;
      const n = fbm(u, v, 6, 4, 331);
      const c = (0.9 + (n - 0.5) * 0.2) * rib;
      rgb(o, 205 * c, 205 * c, 205 * c);
    });
    grime(g, w, h, 332, 0.25);
  },
  trash(g, w, h) {
    // 2×2: pizza box top, crumpled paper, can, takeaway bag
    const c = w / 2;
    g.fillStyle = '#c9b48d'; g.fillRect(0, 0, c, c); g.fillStyle = '#b3261e'; text(g, 'PIZZA', c / 2, c / 2 - 8, 18, '#b3261e'); text(g, 'EXPRESS', c / 2, c / 2 + 12, 11, '#2a2a2a');
    g.fillStyle = 'rgba(90,60,20,0.35)'; g.beginPath(); g.arc(c * 0.3, c * 0.75, 12, 0, 7); g.fill();
    g.fillStyle = '#eee'; g.fillRect(c, 0, c, c); for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(0,0,0,${0.05 + (i % 4) * 0.04})`; g.beginPath(); g.moveTo(c + (i * 37) % c, (i * 53) % c); g.lineTo(c + (i * 71) % c, (i * 29) % c); g.stroke(); }
    g.fillStyle = '#1b4fa3'; g.fillRect(0, c, c, c); g.fillStyle = '#ddd'; g.fillRect(0, c + 8, c, 6); g.fillRect(0, 2 * c - 14, c, 6); text(g, 'ENERGY', c / 2, c * 1.5, 16, '#f1c40f');
    g.fillStyle = '#e8e2d2'; g.fillRect(c, c, c, c); text(g, 'DÖNER', c * 1.5, c * 1.45, 18, '#b3261e'); text(g, 'Haus', c * 1.5, c * 1.62, 11, '#333');
  },
};

function scuffs(g, w, h, seed, color, n) {
  let k = seed * 9973;
  g.strokeStyle = color; g.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    k = (k * 16807) % 2147483647; const x = (k % 1000) / 1000 * w; k = (k * 16807) % 2147483647; const y = (k % 1000) / 1000 * h;
    k = (k * 16807) % 2147483647; const l = 3 + (k % 12);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (k % 5) - 2); g.stroke();
  }
}
function pixels2(g, w, h, fn) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fn((x + 0.5) / w, (y + 0.5) / h, d, (y * w + x) * 4);
  g.putImageData(img, 0, 0);
}
function cartonFace(g, w, h, variant) {
  PAINT.cardboard(g, w, h);
  // tape over the top edge
  g.fillStyle = variant ? 'rgba(210,200,180,0.75)' : 'rgba(196,150,90,0.8)';
  g.fillRect(w * 0.42, 0, w * 0.16, h * 0.16);
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(w * 0.42, 0, w * 0.04, h * 0.16);
  // edges darker (crushed corners)
  pixels2(g, w, h, (u, v, d, i) => { const e = Math.min(u, 1 - u, v, 1 - v); const t = (1 - sstep(0, 0.05, e)) * 0.35; d[i] *= 1 - t; d[i + 1] *= 1 - t; d[i + 2] *= 1 - t; });
  if (variant === 0) {
    g.fillStyle = '#efeee8'; g.fillRect(w * 0.08, h * 0.58, w * 0.42, h * 0.3);
    barcode(g, w * 0.11, h * 0.72, w * 0.36, h * 0.12, 77);
    text(g, 'Lager 3 · Sendung 0471', w * 0.29, h * 0.64, 10, '#222');
    text(g, '↑↑', w * 0.8, h * 0.28, 34, 'rgba(40,30,20,0.75)');
  } else {
    text(g, 'NORDWARE', w * 0.5, h * 0.42, 34, 'rgba(30,30,30,0.72)');
    text(g, 'Haushaltswaren · 12 Stück', w * 0.5, h * 0.55, 12, 'rgba(30,30,30,0.7)');
    g.strokeStyle = 'rgba(30,30,30,0.6)'; g.lineWidth = 3; g.strokeRect(w * 0.7, h * 0.7, w * 0.16, h * 0.16);
    text(g, 'GLAS', w * 0.78, h * 0.78, 11, 'rgba(30,30,30,0.7)');
  }
  grime(g, w, h, 140 + variant, 0.18);
}
function palletSide(g, w, h, long) {
  g.clearRect(0, 0, w, h);
  const wood = makeTile('wood', 256, 128);
  const L = long ? 1200 : 800, sy = h / 144, sx = w / L;
  const plank = (x0, y0, x1, y1, shade = 1, off = 0) => {
    g.drawImage(wood, off % 128, 0, 128, 40, x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
    if (shade !== 1) { g.fillStyle = `rgba(0,0,0,${1 - shade})`; g.fillRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy); }
  };
  const blocks = [[0, 145], [L / 2 - 72.5, L / 2 + 72.5], [L - 145, L]];
  if (long) {
    plank(0, 0, L, 22, 1, 0);                                        // top deck board
    for (const [a, b] of blocks) { plank(a, 22, b, 44, 0.9, 30); plank(a, 44, b, 122, 0.8, 60); }   // stringer ends + blocks
    plank(0, 122, L, 144, 0.95, 90);                                  // bottom board
  } else {
    // ends of the 5 deck boards, stringer board, 3 blocks, ends of the 3 bottom boards
    const bw = [145, 100, 145, 100, 145], gap = (800 - 635) / 4; let x = 0;
    for (const b of bw) { plank(x, 0, x + b, 22, 0.85, x); x += b + gap; }
    plank(0, 22, L, 44, 1, 10);
    for (const [a, b] of blocks) plank(a, 44, b, 122, 0.8, 40 + a);
    for (const [a, b] of [[0, 100], [L / 2 - 72.5, L / 2 + 72.5], [L - 100, L]]) plank(a, 122, b, 144, 0.9, 70 + a);
  }
  // EPAL / EUR branding on the corner blocks (burnt-in marks)
  g.fillStyle = 'rgba(40,25,10,0.55)';
  text(g, 'EPAL', (blocks[0][0] + 72) * sx, 83 * sy, Math.max(7, 26 * sy), 'rgba(40,25,10,0.55)');
  text(g, 'EUR', (blocks[2][0] + 72) * sx, 83 * sy, Math.max(7, 26 * sy), 'rgba(40,25,10,0.55)');
}
function paintSigns(g, w, h) {
  const c = w / 4;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  const cellXY = (i) => [(i % 4) * c, Math.floor(i / 4) * c];
  const green = '#0b8a45', red = '#c8102e', blue = '#1f5aa6', yellow = '#f3c300';
  const man = (x, y, s, col, flip) => {   // running man pictogram
    g.save(); g.translate(x, y); if (flip) g.scale(-1, 1); g.fillStyle = col; g.strokeStyle = col; g.lineCap = 'round';
    g.beginPath(); g.arc(4 * s, -16 * s, 4 * s, 0, 7); g.fill();
    g.lineWidth = 5 * s; g.beginPath(); g.moveTo(2 * s, -10 * s); g.lineTo(-3 * s, 4 * s); g.lineTo(6 * s, 12 * s); g.moveTo(-3 * s, 4 * s); g.lineTo(-10 * s, 14 * s);
    g.moveTo(1 * s, -7 * s); g.lineTo(10 * s, -2 * s); g.moveTo(1 * s, -7 * s); g.lineTo(-8 * s, -4 * s); g.stroke(); g.restore();
  };
  // 0/1 Notausgang (green, door + running man + arrow)
  for (const [i, dir] of [[0, -1], [1, 1]]) {
    const [x, y] = cellXY(i);
    g.fillStyle = green; g.fillRect(x + 2, y + 24, c - 4, c - 48);
    man(x + c / 2 + dir * -14, y + c / 2 - 6, 1.3, '#fff', dir < 0);
    g.fillStyle = '#fff'; g.beginPath();
    const ax = x + c / 2 + dir * 30, ay = y + c / 2 - 8; g.moveTo(ax + dir * 14, ay); g.lineTo(ax, ay - 12); g.lineTo(ax, ay + 12); g.fill();
    g.fillRect(dir > 0 ? ax - 16 : ax, ay - 4, 16, 8);
    text(g, 'NOTAUSGANG', x + c / 2, y + c - 34, 15, '#fff');
  }
  // 2 Feuerlöscher (red square, extinguisher)
  { const [x, y] = cellXY(2); g.fillStyle = red; g.fillRect(x + 8, y + 8, c - 16, c - 16);
    g.fillStyle = '#fff'; g.fillRect(x + 50, y + 40, 26, 56); g.beginPath(); g.arc(x + 63, y + 40, 13, Math.PI, 0); g.fill(); g.fillRect(x + 58, y + 22, 10, 10); g.fillRect(x + 66, y + 24, 22, 5);
    text(g, 'Feuerlöscher', x + c / 2, y + c - 18, 13, '#fff'); }
  // 3 Rauchen verboten (white, red ring + bar)
  { const [x, y] = cellXY(3); g.lineWidth = 11; g.strokeStyle = red; g.beginPath(); g.arc(x + c / 2, y + c / 2 - 6, 44, 0, 7); g.stroke();
    g.fillStyle = '#111'; g.fillRect(x + 36, y + 54, 50, 10); g.fillStyle = '#999'; g.fillRect(x + 86, y + 54, 6, 10);
    g.strokeStyle = red; g.beginPath(); g.moveTo(x + 34, y + 30); g.lineTo(x + 94, y + 86); g.stroke();
    text(g, 'Rauchen verboten', x + c / 2, y + c - 10, 12, '#111'); }
  // 4 Warnung vor Flurförderzeugen (yellow triangle, forklift)
  { const [x, y] = cellXY(4); g.fillStyle = yellow; g.strokeStyle = '#111'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(x + c / 2, y + 10); g.lineTo(x + c - 10, y + c - 26); g.lineTo(x + 10, y + c - 26); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#111'; g.fillRect(x + 44, y + 62, 30, 18); g.fillRect(x + 52, y + 48, 14, 14); g.fillRect(x + 74, y + 42, 4, 38); g.fillRect(x + 78, y + 74, 14, 4);
    g.beginPath(); g.arc(x + 50, y + 84, 6, 0, 7); g.arc(x + 70, y + 84, 6, 0, 7); g.fill();
    text(g, 'Staplerverkehr', x + c / 2, y + c - 10, 13, '#111'); }
  // 5 Gehörschutz benutzen (blue circle)
  { const [x, y] = cellXY(5); g.fillStyle = blue; g.beginPath(); g.arc(x + c / 2, y + c / 2 - 8, 48, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 6; g.beginPath(); g.arc(x + c / 2, y + c / 2 - 4, 22, Math.PI, 0); g.stroke();
    g.fillStyle = '#fff'; g.fillRect(x + c / 2 - 30, y + c / 2 - 8, 12, 22); g.fillRect(x + c / 2 + 18, y + c / 2 - 8, 12, 22);
    text(g, 'Gehörschutz', x + c / 2, y + c - 10, 13, '#111'); }
  // 6 Zutritt für Unbefugte verboten
  { const [x, y] = cellXY(6); g.lineWidth = 10; g.strokeStyle = red; g.beginPath(); g.arc(x + c / 2, y + 52, 40, 0, 7); g.stroke();
    man(x + c / 2, y + 56, 1.1, '#111', false); g.beginPath(); g.moveTo(x + 36, y + 24); g.lineTo(x + 92, y + 80); g.stroke();
    text(g, 'Zutritt für', x + c / 2, y + 104, 12, '#111'); text(g, 'Unbefugte verboten', x + c / 2, y + 118, 11, '#111'); }
  // 7 Hochspannung
  { const [x, y] = cellXY(7); g.fillStyle = yellow; g.strokeStyle = '#111'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(x + c / 2, y + 10); g.lineTo(x + c - 10, y + c - 26); g.lineTo(x + 10, y + c - 26); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#111'; g.beginPath(); g.moveTo(x + 70, y + 36); g.lineTo(x + 52, y + 66); g.lineTo(x + 66, y + 66); g.lineTo(x + 56, y + 92); g.lineTo(x + 80, y + 58); g.lineTo(x + 66, y + 58); g.lineTo(x + 76, y + 36); g.fill();
    text(g, 'Gefährliche Spannung', x + c / 2, y + c - 10, 11, '#111'); }
  // 8..12 Tor 1..5 (big number plates, yellow/black)
  for (let k = 0; k < 5; k++) {
    const [x, y] = cellXY(8 + k);
    g.fillStyle = yellow; g.fillRect(x + 2, y + 2, c - 4, c - 4); g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(x + 8, y + 8, c - 16, c - 16);
    text(g, 'TOR', x + c / 2, y + 30, 22, '#111'); text(g, String(k + 1), x + c / 2, y + 80, 70, '#111');
  }
  // 13 Erste Hilfe
  { const [x, y] = cellXY(13); g.fillStyle = green; g.fillRect(x + 8, y + 8, c - 16, c - 16); g.fillStyle = '#fff'; g.fillRect(x + 50, y + 28, 28, 72); g.fillRect(x + 28, y + 50, 72, 28); text(g, 'Erste Hilfe', x + c / 2, y + c - 18, 12, '#fff'); }
  // 14 Achtung Automatikbetrieb
  { const [x, y] = cellXY(14); g.fillStyle = yellow; g.fillRect(x + 2, y + 2, c - 4, c - 4); g.fillStyle = '#111'; g.fillRect(x + 2, y + 2, c - 4, 26);
    text(g, 'ACHTUNG', x + c / 2, y + 16, 16, yellow); text(g, 'Automatik-', x + c / 2, y + 54, 17, '#111'); text(g, 'betrieb', x + c / 2, y + 74, 17, '#111');
    text(g, 'Anlage läuft', x + c / 2, y + 100, 12, '#111'); text(g, 'selbsttätig an', x + c / 2, y + 114, 12, '#111'); }
  // 15 Sammelstelle / Fluchtweg arrow
  { const [x, y] = cellXY(15); g.fillStyle = green; g.fillRect(x + 4, y + 30, c - 8, c - 60); g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(x + 100, y + 64); g.lineTo(x + 76, y + 44); g.lineTo(x + 76, y + 56); g.lineTo(x + 26, y + 56); g.lineTo(x + 26, y + 72); g.lineTo(x + 76, y + 72); g.lineTo(x + 76, y + 84); g.fill();
    text(g, 'Fluchtweg', x + c / 2, y + c - 20, 12, '#111'); }
}

const cache = new Map();
function makeTile(name, w, h) {
  const key = `${name}:${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  PAINT[name](g, w, h);
  cache.set(key, cv);
  return cv;
}

/** paint every tile into one canvas (with wrapped gutters for mip filtering). Returns the canvas. */
export function paintAtlas() {
  const cv = document.createElement('canvas'); cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  for (const [name, t] of Object.entries(TILES)) {
    if (!PAINT[name]) throw new Error(`atlas: no painter for ${name}`);
    const src = makeTile(name, t.w, t.h);
    g.save();
    g.beginPath(); g.rect(t.x - GUTTER, t.y - GUTTER, t.w + GUTTER * 2, t.h + GUTTER * 2); g.clip();
    g.clearRect(t.x - GUTTER, t.y - GUTTER, t.w + GUTTER * 2, t.h + GUTTER * 2);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g.drawImage(src, t.x + dx * t.w, t.y + dy * t.h);
    g.restore();
  }
  cache.clear();
  return cv;
}
