// Surface detail that is not part of the tiling texture sets, all procedural (canvas) so it costs no download:
//  - the world-space ground mask (puddles / damp, dirt drifts, oil, worn traffic paths) read by the floor shaders
//  - a grime decal atlas (colour + normal): stains, rust runs, peeling paint, bullet pocks, tyre marks, safety lines,
//    hazard stripes, leaves, dirt fans, cracks, broken tiles, graffiti, floor stencils — one merged mesh, one draw call
//  - signage atlas (signs, wall stencils) — one draw call
//  - breakable window glass: one merged mesh for every pane (one draw call) plus invisible per-pane proxy meshes in
//    `glassPanes` that combat raycasts and shatters (`userData.shatter(point, dir)`), `resetGlass()` restores them.
import * as THREE from 'three';
import { makeCanvas, SURF_UNIFORMS } from './materials.js';
import { rng, windowGrid } from './geometry.js';

/** Intact (breakable) window panes; filled by buildDecals. Each: Mesh with userData { surface:'glass', breakable, broken, shatter() }. */
export const glassPanes = [];
let glassState = null;

/** Restores every breakable pane to intact (mission restart). */
export function resetGlass() {
  if (!glassState) return;
  for (const p of glassPanes) setPaneBroken(p, false);
}

function setPaneBroken(p, broken) {
  const { attr } = glassState;
  const i0 = p.userData.vertexStart;
  for (let i = 0; i < 4; i++) attr.array[i0 + i] = broken ? 1 : 0;
  attr.needsUpdate = true;
  p.userData.broken = broken;
}

// ------------------------------------------------------------------------------------------------ helpers
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function canvasTex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}
// irregular blob from many soft radial dabs
function blob(g, R, cx, cy, r, rgb, a, n = 30, hard = 0) {
  for (let i = 0; i < n; i++) {
    const ang = R() * Math.PI * 2, d = Math.sqrt(R()) * r * 0.6;
    const x = cx + Math.cos(ang) * d, y = cy + Math.sin(ang) * d, rr = r * (0.15 + R() * 0.4);
    const grd = g.createRadialGradient(x, y, rr * hard, x, y, rr);
    grd.addColorStop(0, `rgba(${rgb},${a})`); grd.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
}
function jagged(g, R, cx, cy, r, k = 0.5, step = 0.3) {
  g.beginPath();
  for (let a = 0; a < Math.PI * 2; a += step * (0.6 + R() * 0.8)) {
    const rr = r * (1 - k / 2 + R() * k);
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
}
// height (grey) canvas -> tangent-space normal map canvas (OpenGL convention, +Y up in texture space)
function normalFromHeight(hc, strength) {
  const W = hc.width, H = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, W, H).data;
  const out = makeCanvas(W, H), og = out.getContext('2d'), img = og.createImageData(W, H), d = img.data;
  const h = (x, y) => src[(((y + H) % H) * W + ((x + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    // canvas y runs down = texture v runs up after flipY, so +dy in canvas is -dv
    let nx = -dx, ny = dy, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * W + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  return out;
}

// ------------------------------------------------------------------------------------------------ ground mask
// RGBA over the layout GROUND rect: R wet, G dirt, B oil, A wear. Read by floor / lino / asphalt shaders.
function buildGroundMask(layout, opts, R) {
  const N = 1024;
  const rect = SURF_UNIFORMS.sGroundRect.value;   // minX, minZ, sizeX, sizeZ
  const sx = N / rect.z, sz = N / rect.w;
  const X = (x) => (x - rect.x) * sx, Z = (z) => (z - rect.y) * sz;
  const rr = (a, b) => a + (b - a) * R();
  const ch = [0, 1, 2, 3].map(() => { const c = makeCanvas(N, N), g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, N, N); return { c, g }; });
  const [wet, dirt, oil, wear] = ch.map((o) => o.g);
  const W = '255,255,255';
  const inside = (x, z) => x > -24 && x < 20 && z > -18 && z < 16;

  // ---- wet: puddles (+ damp halo), rain under the roof holes, blown in at the doors; the yard is damp overall
  wet.fillStyle = 'rgba(255,255,255,0.18)'; wet.fillRect(0, Z(16), N, Z(26.5) - Z(16));
  wet.fillStyle = 'rgba(255,255,255,0.12)'; wet.fillRect(0, 0, N, Z(-18)); wet.fillRect(0, Z(16), X(-24), N);
  const puddle = (x, z, s, core = 0.85) => {
    blob(wet, R, X(x), Z(z), s * 1.25 * sx, W, 0.28, 18);
    blob(wet, R, X(x), Z(z), s * 0.7 * sx, W, core, 26, 0.35);
  };
  for (const [x, z, s] of opts.puddles || []) puddle(x, z, s);
  for (const h of layout.roofHoles || []) {
    const cx = (h.min[0] + h.max[0]) / 2, cz = (h.min[2] + h.max[2]) / 2, w = h.max[0] - h.min[0], d = h.max[2] - h.min[2];
    blob(wet, R, X(cx), Z(cz), Math.max(w, d) * 0.9 * sx, W, 0.35, 30);
    for (let i = 0; i < 4; i++) puddle(cx + rr(-w, w) * 0.45, cz + rr(-d, d) * 0.45, rr(0.6, 1.4));
  }
  for (let i = 0; i < 26; i++) puddle(rr(-23, 19), rr(16.6, 25.4), rr(0.5, 2.2), 0.8);   // yard
  for (let i = 0; i < 14; i++) { const x = rr(-23, 19), z = rr(-17.4, 15.4); puddle(x, z, rr(0.3, 0.9), 0.7); }
  for (const d of layout.doors) {
    const [cx, cz] = d.center;
    const outA = d.normal === 'z' ? !inside(cx, cz + 1) || !inside(cx, cz - 1) : !inside(cx + 1, cz) || !inside(cx - 1, cz);
    if (!outA) continue;
    blob(wet, R, X(cx), Z(cz), (d.width * 0.8 + 0.6) * sx, W, 0.3, 20);
  }

  // ---- dirt: drifts along every wall base, heavier in corners (overlap), around machine feet, at the doors
  dirt.filter = 'blur(5px)';
  for (const s of layout.solids) {
    if (!(s.kind === 'wall' || s.kind === 'pillar') || s.min[1] > 0.05) continue;
    for (const [m, a] of [[0.9, 0.22], [0.45, 0.35], [0.18, 0.55]]) {
      dirt.fillStyle = `rgba(255,255,255,${a})`;
      dirt.fillRect(X(s.min[0] - m), Z(s.min[2] - m), (s.max[0] - s.min[0] + 2 * m) * sx, (s.max[2] - s.min[2] + 2 * m) * sz);
    }
  }
  for (const s of layout.solids) {
    if (s.kind !== 'prop' || s.min[1] > 0.05) continue;
    const m = 0.25;
    dirt.fillStyle = 'rgba(255,255,255,0.35)';
    dirt.fillRect(X(s.min[0] - m), Z(s.min[2] - m), (s.max[0] - s.min[0] + 2 * m) * sx, (s.max[2] - s.min[2] + 2 * m) * sz);
  }
  dirt.filter = 'none';
  for (const d of layout.doors) {
    const [cx, cz] = d.center;
    blob(dirt, R, X(cx), Z(cz), (d.width * 0.7 + 0.8) * sx, W, 0.3, 24);
  }
  for (let i = 0; i < 70; i++) blob(dirt, R, X(rr(-23.5, 19.5)), Z(rr(-17.5, 25.5)), rr(0.6, 2.6) * sx, W, 0.16, 10);
  // the yard: grit everywhere near fence and facades
  dirt.fillStyle = 'rgba(255,255,255,0.1)'; dirt.fillRect(0, Z(16), N, N - Z(16));

  // ---- oil: under machines and vehicles, drips along forklift lanes
  const oilSpot = (x, z, r, a = 0.8) => blob(oil, R, X(x), Z(z), r * sx, W, a, 22, 0.2);
  for (const [x, z, r] of [[-8.1, -10.7, 1.1], [-7.6, -11.8, 0.6], [4.2, 14.0, 1.0], [-9.2, 3.8, 1.3], [-1.8, 4.0, 0.8],
    [14.0, 20.8, 1.2], [14.2, 22.6, 0.8], [-11.4, 12.1, 0.7], [-3.0, 12.1, 0.5], [4.5, -2.5, 0.9], [-17.4, -15.8, 0.8],
    [12.2, -13.2, 0.7], [-1.0, -8.0, 0.6], [-6.0, 20.6, 0.7], [17.0, -10.0, 0.5]]) oilSpot(x, z, r);
  for (let i = 0; i < 90; i++) oilSpot(rr(-15, 1), rr(-14.5, -6.6), rr(0.04, 0.16), 0.6);
  for (const [x, z] of opts.oilSpots || []) oilSpot(x, z, 0.6);

  // ---- wear: polished traffic paths
  const path = (pts, w, a) => {
    wear.filter = 'blur(8px)';
    wear.strokeStyle = `rgba(255,255,255,${a})`; wear.lineWidth = w * sx; wear.lineJoin = 'round'; wear.lineCap = 'round';
    wear.beginPath(); pts.forEach(([x, z], i) => (i ? wear.lineTo(X(x), Z(z)) : wear.moveTo(X(x), Z(z)))); wear.stroke();
    wear.filter = 'none';
  };
  path([[-8, 15.6], [-8, 13.4], [0.8, 13.4], [0.8, 6.8], [-4.2, 6.8], [-4.2, -1.4], [-4, -5.8], [-4, -13.6], [14, -13.6]], 1.8, 0.75);
  path([[-12.8, 6.8], [-12.8, -1.4], [-4.2, -1.4]], 1.4, 0.6);
  path([[-13, -5.8], [-12.8, -1.4]], 1.2, 0.6);
  path([[-15, -13.6], [0.5, -13.6], [0.5, -7.0], [-15, -7.0], [-15, -13.6]], 2.2, 0.55);
  path([[-17.5, -15.5], [-17.5, -8]], 2.0, 0.45);
  path([[9.4, 15.6], [9.4, -5.8]], 1.3, 0.8);
  path([[10.4, 12.8], [17.0, 12.8], [17.0, 10.0], [17.7, 7.4], [13.4, 4.4], [12.6, 1.7], [17.7, -0.3], [17.7, -3.6], [13.2, -3.6]], 1.2, 0.55);
  path([[-9, 24], [-8, 16], [9.3, 16.4], [16.7, 16.4]], 2.4, 0.4);
  path([[3, 21], [14, 21]], 2.6, 0.35);

  // combine
  const datas = ch.map((o) => o.g.getImageData(0, 0, N, N).data);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = datas[k][i * 4];
  const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat);
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  SURF_UNIFORMS.sGround.value = t;
  return t;
}

// ------------------------------------------------------------------------------------------------ grime decal atlas
// 4x4 cells of 512 px (colour 2048², height/normal 1024²).
const GC = {
  oil: 0, tide: 1, rust: 2, grime: 3, tyre: 4, line: 5, hazard: 6, peel: 7,
  pocks: 8, leaves: 9, dirtfan: 10, crack: 11, tiles: 12, tagA: 13, tagB: 14, stencil: 15,
};
function grimeAtlas(R) {
  const S = 512, N = S * 4, HS = 256;
  const c = makeCanvas(N, N), g = c.getContext('2d');
  const hc = makeCanvas(HS * 4, HS * 4), h = hc.getContext('2d');
  h.fillStyle = 'rgb(128,128,128)'; h.fillRect(0, 0, HS * 4, HS * 4);
  const rr = (a, b) => a + (b - a) * R();
  const cell = (i, fn) => {
    const x0 = (i % 4) * S, y0 = Math.floor(i / 4) * S;
    g.save(); g.beginPath(); g.rect(x0, y0, S, S); g.clip(); g.translate(x0, y0);
    h.save(); h.beginPath(); h.rect((i % 4) * HS, Math.floor(i / 4) * HS, HS, HS); h.clip(); h.translate((i % 4) * HS, Math.floor(i / 4) * HS); h.scale(HS / S, HS / S);
    fn(g, h);
    g.restore(); h.restore();
  };
  const crackPath = (gg, x, y, ang, len, w, depth = 0) => {
    gg.lineWidth = w; gg.beginPath(); gg.moveTo(x, y);
    let a = ang;
    for (let s = 0; s < len; s += 6) {
      a += (R() - 0.5) * 0.6; x += Math.cos(a) * 6; y += Math.sin(a) * 6; gg.lineTo(x, y);
      if (depth < 2 && R() < 0.04) { gg.stroke(); crackPath(gg, x, y, a + (R() < 0.5 ? 1 : -1) * rr(0.4, 1.1), len * 0.4, w * 0.6, depth + 1); gg.lineWidth = w; gg.beginPath(); gg.moveTo(x, y); }
    }
    gg.stroke();
  };

  cell(GC.oil, (g) => {
    blob(g, R, 256, 256, 200, '12,11,10', 0.5, 40, 0.3);
    blob(g, R, 256, 256, 110, '6,6,6', 0.6, 20, 0.5);
    g.strokeStyle = 'rgba(5,5,5,0.4)'; g.lineWidth = 6; jagged(g, R, 256, 256, 205, 0.25, 0.2); g.stroke();
    for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(8,8,8,0.55)'; g.beginPath(); g.arc(rr(30, 480), rr(30, 480), rr(2, 9), 0, 7); g.fill(); }
  });
  cell(GC.tide, (g) => {
    blob(g, R, 256, 230, 230, '58,48,36', 0.16, 50);
    for (let k = 0; k < 3; k++) { g.strokeStyle = `rgba(70,52,30,${0.35 - k * 0.08})`; g.lineWidth = 5 - k; jagged(g, R, 256, 230, 150 + k * 40, 0.3, 0.15); g.stroke(); }
  });
  cell(GC.rust, (g) => {
    for (let i = 0; i < 46; i++) {
      const x = rr(150, 362), w = rr(3, 22), len = rr(120, 500);
      const grd = g.createLinearGradient(0, 0, 0, len);
      grd.addColorStop(0, 'rgba(96,46,16,0.6)'); grd.addColorStop(0.3, 'rgba(84,42,18,0.35)'); grd.addColorStop(1, 'rgba(70,40,20,0)');
      g.fillStyle = grd; g.fillRect(x - w / 2, 0, w, len);
    }
    blob(g, R, 256, 20, 90, '80,36,12', 0.5, 20);
  });
  cell(GC.grime, (g) => { blob(g, R, 256, 256, 230, '24,21,18', 0.2, 70); blob(g, R, 256, 256, 120, '14,13,12', 0.18, 30); });
  cell(GC.tyre, (g, h) => {
    // two treads running along v (vertical in the cell), tileable top/bottom
    for (const cx of [150, 362]) {
      const grd = g.createLinearGradient(cx - 60, 0, cx + 60, 0);
      grd.addColorStop(0, 'rgba(14,13,12,0)'); grd.addColorStop(0.3, 'rgba(14,13,12,0.26)'); grd.addColorStop(0.7, 'rgba(14,13,12,0.26)'); grd.addColorStop(1, 'rgba(14,13,12,0)');
      g.fillStyle = grd; g.fillRect(cx - 60, 0, 120, 512);
      for (let y = 0; y < 512; y += 16) {
        g.fillStyle = 'rgba(6,6,6,0.08)'; g.fillRect(cx - 45, y, 90, 5);
        h.fillStyle = 'rgb(140,140,140)'; h.fillRect(cx - 45, y, 90, 5);
      }
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,0,${rr(0.2, 0.7)})`; g.beginPath(); g.arc(cx + rr(-60, 60), rr(0, 512), rr(3, 18), 0, 7); g.fill(); }
      g.globalCompositeOperation = 'source-over';
    }
  });
  cell(GC.line, (g) => {
    g.fillStyle = 'rgba(214,170,40,0.92)'; g.fillRect(0, 196, 512, 120);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${rr(0.3, 1)})`; g.beginPath(); g.arc(rr(0, 512), rr(190, 322), rr(1, 10), 0, 7); g.fill(); }
    for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(0,0,0,0.85)'; jagged(g, R, rr(0, 512), rr(200, 310), rr(15, 45), 0.8); g.fill(); }
    g.globalCompositeOperation = 'source-over';
    blob(g, R, 256, 256, 260, '40,34,24', 0.12, 30);
  });
  cell(GC.hazard, (g) => {
    g.save(); g.beginPath(); g.rect(0, 176, 512, 160); g.clip();
    g.fillStyle = 'rgba(222,176,34,0.95)'; g.fillRect(0, 176, 512, 160);
    g.fillStyle = 'rgba(20,20,20,0.95)';
    for (let k = -4; k < 10; k++) { g.beginPath(); g.moveTo(k * 128, 336); g.lineTo(k * 128 + 64, 336); g.lineTo(k * 128 + 224, 176); g.lineTo(k * 128 + 160, 176); g.fill(); }
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(0,0,0,${rr(0.3, 1)})`; g.beginPath(); g.arc(rr(0, 512), rr(170, 342), rr(1, 9), 0, 7); g.fill(); }
    g.globalCompositeOperation = 'source-over';
    blob(g, R, 256, 256, 300, '40,34,24', 0.15, 30);
  });
  cell(GC.peel, (g, h) => {
    for (let i = 0; i < 18; i++) {
      const x = rr(80, 430), y = rr(80, 430), r = rr(8, 42);
      jagged(g, R, x, y, r, 0.9, 0.5);
      g.fillStyle = `rgba(${96 + R() * 20},${92 + R() * 16},${84},0.92)`; g.fill();
      g.strokeStyle = 'rgba(40,34,28,0.7)'; g.lineWidth = 2.5; g.stroke();
      jagged(h, R, x, y, r, 0.9, 0.5); h.fillStyle = 'rgb(90,90,90)'; h.fill();
    }
  });
  cell(GC.pocks, (g, h) => {
    for (let i = 0; i < 14; i++) {
      const x = rr(70, 440), y = rr(70, 440), r = rr(5, 18) * (R() < 0.3 ? 0.5 : 1);
      blob(g, R, x, y, r * 2.4, '150,144,132', 0.12, 6);          // faint crushed plaster halo
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(18,16,14,0.95)'); grd.addColorStop(0.6, 'rgba(60,54,48,0.85)'); grd.addColorStop(1, 'rgba(90,84,76,0)');
      g.fillStyle = grd; jagged(g, R, x, y, r, 0.6, 0.45); g.fill();
      const hg = h.createRadialGradient(x, y, 0, x, y, r * 1.2);
      hg.addColorStop(0, 'rgb(20,20,20)'); hg.addColorStop(0.75, 'rgb(105,105,105)'); hg.addColorStop(1, 'rgb(128,128,128)');
      h.fillStyle = hg; jagged(h, R, x, y, r * 1.2, 0.6, 0.45); h.fill();
      g.strokeStyle = 'rgba(30,28,26,0.5)'; for (let k = 0; k < 4; k++) crackPath(g, x, y, rr(0, 7), rr(20, 60), 1.2, 2);
    }
  });
  cell(GC.leaves, (g, h) => {
    for (let i = 0; i < 140; i++) {
      const x = rr(20, 492), y = rr(20, 492), l = rr(10, 26), a = rr(0, 7);
      const col = [[96, 70, 30], [120, 84, 34], [70, 52, 26], [110, 96, 44], [60, 48, 30]][Math.floor(R() * 5)];
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = `rgba(${col},0.95)`; g.beginPath(); g.ellipse(0, 0, l, l * 0.45, 0, 0, 7); g.fill();
      g.strokeStyle = 'rgba(40,30,16,0.8)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(-l, 0); g.lineTo(l * 1.2, 0); g.stroke();
      g.restore();
      h.save(); h.translate(x, y); h.rotate(a); h.fillStyle = 'rgb(175,175,175)'; h.beginPath(); h.ellipse(0, 0, l, l * 0.45, 0, 0, 7); h.fill(); h.restore();
    }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${50 + R() * 40},${42 + R() * 30},${30},${rr(0.3, 0.8)})`; g.fillRect(rr(0, 512), rr(0, 512), rr(1, 4), rr(1, 4)); }
  });
  cell(GC.dirtfan, (g, h) => {
    blob(g, R, 256, 300, 220, '70,60,46', 0.22, 50);
    for (let i = 0; i < 2200; i++) {
      const a = rr(-1.4, 1.4), d = Math.abs(R() + R() - 1) * 260;
      const x = 256 + Math.sin(a) * d, y = 470 - Math.cos(a) * d * 1.4;
      g.fillStyle = `rgba(${60 + R() * 50},${52 + R() * 40},${40 + R() * 30},${rr(0.3, 0.9)})`; g.fillRect(x, y, rr(1, 4), rr(1, 4));
      if (R() < 0.2) { h.fillStyle = 'rgb(160,160,160)'; h.fillRect(x, y, 3, 3); }
    }
    // boot prints
    for (let i = 0; i < 7; i++) {
      const x = 200 + (i % 2) * 90 + rr(-10, 10), y = 460 - i * 60;
      g.save(); g.translate(x, y); g.rotate(rr(-0.2, 0.2));
      g.fillStyle = 'rgba(40,34,26,0.35)'; g.beginPath(); g.ellipse(0, -14, 15, 24, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(0, 22, 12, 14, 0, 0, 7); g.fill();
      g.restore();
    }
  });
  cell(GC.crack, (g, h) => {
    g.strokeStyle = 'rgba(14,12,10,0.85)'; h.strokeStyle = 'rgb(10,10,10)';
    for (let k = 0; k < 2; k++) {
      const st = [rr(0, 60), rr(100, 400)], a = rr(-0.3, 0.3);
      crackPath(g, st[0], st[1], a, 520, 3.2);
    }
    // the height canvas gets its own (similar) crack set; exact match is not needed at decal scale
    for (let k = 0; k < 2; k++) crackPath(h, rr(0, 60), rr(100, 400), rr(-0.3, 0.3), 520, 5);
    blob(g, R, 256, 256, 240, '30,26,22', 0.07, 20);
  });
  cell(GC.tiles, (g, h) => {
    // broken floor tiles: grid of 30 cm tiles, some missing (screed showing), some cracked
    const T = 128;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const x = i * T, y = j * T, r = R();
      if (r < 0.4) {
        g.fillStyle = 'rgba(92,90,84,0.97)'; g.fillRect(x + 2, y + 2, T - 4, T - 4);
        blob(g, R, x + 64, y + 64, 70, '60,58,54', 0.4, 8);
        h.fillStyle = 'rgb(60,60,60)'; h.fillRect(x + 2, y + 2, T - 4, T - 4);
        g.strokeStyle = 'rgba(20,18,16,0.8)'; g.lineWidth = 3; g.strokeRect(x + 3, y + 3, T - 6, T - 6);
      } else if (r < 0.7) {
        g.strokeStyle = 'rgba(20,18,16,0.85)'; crackPath(g, x + rr(0, T), y, Math.PI / 2 + rr(-0.5, 0.5), T, 2);
        h.strokeStyle = 'rgb(40,40,40)'; crackPath(h, x + rr(0, T), y, Math.PI / 2, T, 3);
        if (R() < 0.5) { g.fillStyle = 'rgba(80,78,72,0.9)'; jagged(g, R, x + rr(20, 100), y + rr(20, 100), rr(12, 28), 0.8); g.fill(); }
      }
    }
    g.globalCompositeOperation = 'destination-in';
    const grd = g.createRadialGradient(256, 256, 120, 256, 256, 256); grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    g.globalCompositeOperation = 'source-over';
  });
  const tag = (g, text, font, fill, stroke, rot) => {
    g.translate(256, 256); g.rotate(rot);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.shadowColor = fill; g.shadowBlur = 10;
    g.strokeStyle = stroke; g.lineWidth = 16; g.strokeText(text, 0, 0, 480);
    g.fillStyle = fill; g.fillText(text, 0, 0, 480);
    g.shadowBlur = 0;
    for (let i = 0; i < 12; i++) { const x = rr(-200, 200); g.fillStyle = fill; g.fillRect(x, rr(20, 50), 3, rr(20, 90)); }   // drips
    g.setTransform(1, 0, 0, 1, 0, 0);
  };
  cell(GC.tagA, (g) => { tag(g, 'KR4H', 'italic 900 170px Impact, Arial Black, Arial', 'rgba(40,40,46,0.9)', 'rgba(226,226,220,0.85)', -0.12); });
  cell(GC.tagB, (g) => { tag(g, 'S9', '900 260px Arial Black, Impact, Arial', 'rgba(170,44,40,0.88)', 'rgba(20,20,20,0.9)', 0.08); });
  cell(GC.stencil, (g) => {
    g.fillStyle = 'rgba(230,226,214,0.9)'; g.font = 'bold 60px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('FLUCHTWEG', 256, 330); g.fillText('FREIHALTEN', 256, 400);
    g.beginPath(); g.moveTo(256, 60); g.lineTo(366, 190); g.lineTo(296, 190); g.lineTo(296, 270); g.lineTo(216, 270); g.lineTo(216, 190); g.lineTo(146, 190); g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    for (let x = 30; x < 500; x += rr(28, 44)) { g.fillStyle = 'rgba(0,0,0,1)'; g.fillRect(x, 300, 4, 130); }   // stencil bridges
    for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(0,0,0,${rr(0.3, 1)})`; g.beginPath(); g.arc(rr(0, 512), rr(40, 440), rr(1, 8), 0, 7); g.fill(); }
    g.globalCompositeOperation = 'source-over';
  });
  return { map: canvasTex(c, true), normal: canvasTex(normalFromHeight(hc, 4.0), false) };
}
const gUV = (i, u0 = 0, u1 = 1, v0 = 0, v1 = 1) => {
  const col = i % 4, row = Math.floor(i / 4), e = 0.002;
  const U = (u) => (col + e + u * (1 - 2 * e)) / 4, V = (v) => 1 - (row + e + (1 - v) * (1 - 2 * e)) / 4;
  return [U(u0), V(v0), U(u1), V(v1)];
};

// ------------------------------------------------------------------------------------------------ signs
export const SIGNS = [
  { text: 'KESSLER STAHLGUSS', bg: '#1d3a5f', fg: '#e8e4d8', font: 'bold 64px Arial' },      // 0
  { text: 'HALLE 2 · SEKTOR 9', bg: '#d8b23a', fg: '#151515', font: 'bold 62px Arial' },    // 1
  { text: '← NOTAUSGANG', bg: '#1f7a3a', fg: '#f2f2f2', font: 'bold 66px Arial' },      // 2
  { text: 'RAUCHEN VERBOTEN', bg: '#f0ede4', fg: '#b51f1f', font: 'bold 56px Arial', border: '#b51f1f' }, // 3
  { text: 'BETRETEN VERBOTEN', bg: '#f0ede4', fg: '#1a1a1a', font: 'bold 54px Arial', border: '#b51f1f' }, // 4
  { text: 'VERLADUNG  TOR 3', bg: '#2b2b2b', fg: '#e6c84a', font: 'bold 62px Arial' },       // 5
  { text: 'UMKLEIDE', bg: '#e9e6dc', fg: '#222', font: 'bold 70px Arial' },                  // 6
  { text: 'BÜRO  MEISTEREI', bg: '#e9e6dc', fg: '#222', font: 'bold 62px Arial' },      // 7
  { text: 'LAGER  B-04', bg: '#e9e6dc', fg: '#222', font: 'bold 66px Arial' },               // 8
  { text: 'LEITSTAND', bg: '#e9e6dc', fg: '#222', font: 'bold 70px Arial' },                 // 9
  { text: 'ACHTUNG STAPLERVERKEHR', bg: '#e8c22c', fg: '#111', font: 'bold 46px Arial', border: '#111' }, // 10
  { text: '⚡ HOCHSPANNUNG', bg: '#e8c22c', fg: '#111', font: 'bold 58px Arial' },       // 11
  { hazard: true },                                                                        // 12
  { text: 'S9 ✕ KRAH', bg: null, fg: 'rgba(200,40,40,0.9)', font: 'italic bold 96px Impact, Arial', graffiti: true }, // 13
  { text: 'AUSGANG →', bg: '#1f7a3a', fg: '#f2f2f2', font: 'bold 70px Arial' },        // 14
  { text: 'ABHOLPUNKT', bg: null, fg: 'rgba(230,200,60,0.85)', font: 'bold 90px Arial', graffiti: true }, // 15
  // stencilled wall paint (sprayed through a template: bridges, overspray)
  { text: 'HALLE 2', fg: 'rgba(225,222,210,0.85)', font: 'bold 104px Arial', stencil: true },            // 16
  { text: 'TOR 3', fg: 'rgba(230,196,60,0.9)', font: 'bold 104px Arial', stencil: true },                // 17
  { text: 'KRAN MAX. 5 t', fg: 'rgba(225,222,210,0.85)', font: 'bold 84px Arial', stencil: true },       // 18
  { text: 'NICHT ABSTELLEN', fg: 'rgba(210,60,48,0.85)', font: 'bold 70px Arial', stencil: true },       // 19
  { text: 'ABT. 7 · PRESSEREI', fg: 'rgba(225,222,210,0.8)', font: 'bold 64px Arial', stencil: true },   // 20
  { text: 'FEUERLÖSCHER', bg: '#b51f1f', fg: '#f2f2f2', font: 'bold 62px Arial' },                  // 21
  { text: 'D-17', fg: 'rgba(25,25,25,0.85)', font: 'bold 110px Arial', stencil: true },                  // 22
  { text: 'TRAFO 2 · 10 kV', bg: '#e8c22c', fg: '#111', font: 'bold 60px Arial', border: '#111' },       // 23
];
const SIGN_ROWS = 12;

function signAtlas(R) {
  const W = 1024, Hc = 128, c = makeCanvas(W, Hc * SIGN_ROWS), g = c.getContext('2d');
  g.clearRect(0, 0, W, Hc * SIGN_ROWS);
  const rr = (a, b) => a + (b - a) * R();
  SIGNS.forEach((s, i) => {
    const x0 = (i % 2) * 512, y0 = Math.floor(i / 2) * Hc;
    g.save(); g.beginPath(); g.rect(x0, y0, 512, Hc); g.clip();
    if (s.hazard) {
      g.fillStyle = '#e2b92a'; g.fillRect(x0, y0, 512, Hc);
      g.fillStyle = '#141414';
      for (let k = -4; k < 12; k++) { g.beginPath(); g.moveTo(x0 + k * 64, y0 + Hc); g.lineTo(x0 + k * 64 + 32, y0 + Hc); g.lineTo(x0 + k * 64 + 32 + Hc, y0); g.lineTo(x0 + k * 64 + Hc, y0); g.fill(); }
    } else if (s.stencil) {
      g.font = s.font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = s.fg; g.shadowBlur = 6; g.fillStyle = s.fg; g.globalAlpha = 0.35;
      g.fillText(s.text, x0 + 256, y0 + Hc / 2 + 4, 490);      // overspray
      g.shadowBlur = 0; g.globalAlpha = 1;
      g.fillText(s.text, x0 + 256, y0 + Hc / 2 + 4, 490);
      g.globalCompositeOperation = 'destination-out';
      const tw = Math.min(490, g.measureText(s.text).width), n = s.text.length;
      for (let k = 0; k < n * 2; k++) { const x = x0 + 256 - tw / 2 + (k + 0.5) * tw / (n * 2); g.fillStyle = 'rgba(0,0,0,0.95)'; g.fillRect(x - 2, y0 + Hc * 0.42, 4, Hc * 0.16); }
      for (let k = 0; k < 500; k++) { g.fillStyle = `rgba(0,0,0,${rr(0.3, 1)})`; g.beginPath(); g.arc(x0 + rr(0, 512), y0 + rr(0, Hc), rr(0.5, 5), 0, 7); g.fill(); }
      g.globalCompositeOperation = 'source-over';
    } else {
      if (s.bg) { g.fillStyle = s.bg; g.fillRect(x0 + 4, y0 + 4, 504, Hc - 8); }
      if (s.border) { g.strokeStyle = s.border; g.lineWidth = 8; g.strokeRect(x0 + 10, y0 + 10, 492, Hc - 20); }
      g.fillStyle = s.fg; g.font = s.font; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (s.graffiti) { g.translate(x0 + 256, y0 + 66); g.rotate(-0.05); g.fillText(s.text, 0, 0, 490); }
      else g.fillText(s.text, x0 + 256, y0 + Hc / 2 + 3, 480);
    }
    // weathering: grime, chips, fading, rust bleeding from the screw holes
    g.restore(); g.save(); g.beginPath(); g.rect(x0, y0, 512, Hc); g.clip();
    if (!s.graffiti && !s.stencil) {
      for (let k = 0; k < 260; k++) {
        const x = x0 + R() * 512, y = y0 + R() * Hc, r = R() * 6;
        g.fillStyle = `rgba(${40 + R() * 30},${32 + R() * 20},${20},${R() * 0.35})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 10; k++) { g.fillStyle = 'rgba(0,0,0,0.9)'; jagged(g, R, x0 + (R() < 0.5 ? rr(0, 30) : rr(482, 512)), y0 + rr(0, Hc), rr(4, 16), 0.9); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      const grd = g.createLinearGradient(0, y0, 0, y0 + Hc);
      grd.addColorStop(0, 'rgba(30,25,18,0.05)'); grd.addColorStop(1, 'rgba(30,25,18,0.45)');
      g.fillStyle = grd; g.fillRect(x0, y0, 512, Hc);
      for (const sx of [x0 + 18, x0 + 494]) {
        const rg = g.createLinearGradient(0, y0 + 14, 0, y0 + Hc);
        rg.addColorStop(0, 'rgba(110,50,16,0.7)'); rg.addColorStop(1, 'rgba(110,50,16,0)');
        g.fillStyle = rg; g.fillRect(sx - 2, y0 + 14, 4, Hc - 14);
        g.fillStyle = 'rgba(30,26,22,0.9)'; g.beginPath(); g.arc(sx, y0 + 16, 3.5, 0, 7); g.fill();
      }
    }
    g.restore();
  });
  const t = canvasTex(c, true);
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------------------------------------ glass atlas
// 4x4 cells of 256: row 0 intact dusty, row 1 cracked, row 2 broken remnants (shards in the frame), row 3 almost empty.
function glassAtlas(R) {
  const S = 256, N = S * 4;
  const c = makeCanvas(N, N), g = c.getContext('2d');
  const rc = makeCanvas(N, N), r = rc.getContext('2d');     // roughness (G) — dusty = rough, clean = glossy
  g.clearRect(0, 0, N, N); r.fillStyle = 'rgb(0,30,0)'; r.fillRect(0, 0, N, N);
  const rr = (a, b) => a + (b - a) * R();
  const dusty = (x0, y0) => {
    // base film, heavier towards the bottom and the corners, cleaner rain-washed streaks
    const grd = g.createLinearGradient(0, y0, 0, y0 + S);
    grd.addColorStop(0, 'rgba(118,120,112,0.30)'); grd.addColorStop(0.65, 'rgba(112,110,100,0.42)'); grd.addColorStop(1, 'rgba(96,90,78,0.72)');
    g.fillStyle = grd; g.fillRect(x0, y0, S, S);
    const rg = r.createLinearGradient(0, y0, 0, y0 + S);
    rg.addColorStop(0, 'rgb(0,90,0)'); rg.addColorStop(1, 'rgb(0,190,0)');
    r.fillStyle = rg; r.fillRect(x0, y0, S, S);
    for (let k = 0; k < 40; k++) blob(g, R, x0 + rr(0, S), y0 + rr(0, S), rr(10, 50), '80,78,68', 0.12, 4);
    for (const [cx, cy] of [[x0, y0], [x0 + S, y0], [x0, y0 + S], [x0 + S, y0 + S]]) blob(g, R, cx, cy, 70, '60,56,48', 0.35, 10);
    g.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 14; k++) {
      const x = x0 + rr(0, S), w = rr(2, 9), l = rr(40, S);
      const sg = g.createLinearGradient(0, y0, 0, y0 + l); sg.addColorStop(0, 'rgba(0,0,0,0.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg; g.fillRect(x, y0, w, l);
      r.fillStyle = 'rgba(0,25,0,0.6)'; r.fillRect(x, y0, w, l * 0.7);
    }
    g.globalCompositeOperation = 'source-over';
  };
  const cracks = (x0, y0, n, cx, cy) => {
    g.strokeStyle = 'rgba(225,232,228,0.5)'; g.lineWidth = 1.1;
    for (let k = 0; k < n; k++) {
      let x = cx, y = cy; const a0 = rr(0, Math.PI * 2);
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 10; s++) { x += Math.cos(a0 + rr(-0.4, 0.4)) * rr(14, 30); y += Math.sin(a0 + rr(-0.4, 0.4)) * rr(14, 30); g.lineTo(x, y); }
      g.stroke();
    }
    for (let ring = 1; ring <= 2; ring++) { g.beginPath(); jagged(g, R, cx, cy, 14 * ring + rr(0, 8), 0.6, 0.6); g.stroke(); }
    g.fillStyle = 'rgba(240,244,240,0.5)'; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fill();
  };
  // shard outline: alpha kept only in a jagged band along the frame
  const remnant = (x0, y0, amount) => {
    g.save(); g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    const P = [];
    const steps = 18;
    for (let k = 0; k < steps; k++) {          // walk the inner outline around the pane, depth varies wildly
      const t = k / steps, side = Math.floor(t * 4), f = (t * 4) % 1;
      const d = (R() < amount ? rr(2, 10) : rr(20, 110));
      const p = side === 0 ? [x0 + f * S, y0 + d] : side === 1 ? [x0 + S - d, y0 + f * S] : side === 2 ? [x0 + S - f * S, y0 + S - d] : [x0 + d, y0 + S - f * S];
      P.push(p);
    }
    P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath(); g.fillStyle = 'rgba(0,0,0,1)'; g.fill();
    g.restore();
    g.strokeStyle = 'rgba(230,236,232,0.6)'; g.lineWidth = 1.5;
    g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
  };
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x0 = col * S, y0 = row * S;
    g.save(); g.beginPath(); g.rect(x0, y0, S, S); g.clip();
    r.save(); r.beginPath(); r.rect(x0, y0, S, S); r.clip();
    dusty(x0, y0);
    if (row === 1) cracks(x0, y0, 7 + Math.floor(R() * 6), x0 + rr(50, 206), y0 + rr(50, 206));
    if (row === 0 && col === 3) cracks(x0, y0, 3, x0 + rr(30, 220), y0 + rr(150, 230));
    if (row === 2) remnant(x0, y0, 0.35);
    if (row === 3) remnant(x0, y0, 0.9);
    g.restore(); r.restore();
  }
  return { map: canvasTex(c, true), rough: canvasTex(rc, false) };
}
const glassUV = (row, col) => [col / 4 + 0.003, 1 - (row + 1) / 4 + 0.003, (col + 1) / 4 - 0.003, 1 - row / 4 - 0.003];

// ------------------------------------------------------------------------------------------------ quad accumulation
class Quads {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.idx = []; }
  // center, normal axis string ('+x','-x','+y','+z','-z'), width, height, uv rect [u0,v0,u1,v1], rotation (floor only)
  add(c, axis, w, h, uvr, rot = 0) {
    const n = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] }[axis];
    let r, u;
    if (axis === '+y') { r = [Math.cos(rot), 0, -Math.sin(rot)]; u = [-Math.sin(rot), 0, -Math.cos(rot)]; }
    else { u = [0, 1, 0]; r = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]]; }
    const b = this.pos.length / 3;
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (const [sx, sy] of corners) {
      this.pos.push(c[0] + r[0] * sx * w + u[0] * sy * h, c[1] + r[1] * sx * w + u[1] * sy * h, c[2] + r[2] * sx * w + u[2] * sy * h);
      this.nor.push(...n);
      this.uv.push(sx < 0 ? uvr[0] : uvr[2], sy < 0 ? uvr[1] : uvr[3]);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    return b;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const signUV = (i) => {
  const col = i % 2, row = Math.floor(i / 2);
  return [col * 0.5 + 0.004, 1 - (row + 1) / SIGN_ROWS + 0.004, col * 0.5 + 0.5 - 0.004, 1 - row / SIGN_ROWS - 0.004];
};

// Sign placements: [signIndex, center, axis, width, height]
const SIGN_PLACES = [
  [0, [-9.0, 6.0, 16.03], '+z', 6.0, 1.5],
  [5, [-12.0, 3.2, 16.03], '+z', 1.8, 0.45],
  [4, [0.0, 1.5, 25.78], '-z', 1.4, 0.35],
  [13, [-9.0, 1.35, 22.03], '+z', 2.4, 0.6],
  [1, [-9.0, 5.6, -5.78], '+z', 3.6, 0.9],
  [2, [-12.3, 2.7, -5.78], '+z', 1.1, 0.27],
  [2, [9.4, 2.55, 15.58], '-z', 1.1, 0.27],
  [3, [7.78, 1.8, 10.5], '-x', 1.0, 0.25],
  [3, [-23.58, 1.9, -3.0], '+x', 1.0, 0.25],
  [10, [2.8, 2.6, -6.22], '-z', 2.2, 0.55],
  [11, [-19.75, 1.6, 11.83], '+z', 0.9, 0.22],
  [6, [10.58, 1.75, 9.1], '-x', 0.8, 0.2],
  [7, [10.58, 1.75, 14.6], '-x', 0.8, 0.2],
  [8, [10.58, 1.75, 3.1], '-x', 0.8, 0.2],
  [9, [10.58, 1.75, -1.9], '-x', 0.8, 0.2],
  [14, [-14.4, 2.5, -17.58], '+z', 1.2, 0.3],
  [12, [-17.5, 4.15, -17.58], '+z', 3.2, 0.2],
  [12, [-16.98, 3.12, -1.9], '+x', 7.8, 0.22],
  [12, [-8.0, 4.4, 16.03], '+z', 4.0, 0.2],
  [13, [-23.58, 2.2, 6.0], '+x', 2.2, 0.55],
  [13, [8.22, 1.4, 4.0], '+x', 1.6, 0.4],
  // stencils
  [16, [-1.0, 6.6, 15.58], '-z', 4.4, 1.1],
  [17, [-8.0, 4.95, 15.58], '-z', 2.0, 0.5],
  [18, [-17.5, 6.1, -5.78], '+z', 3.0, 0.75],
  [19, [-8.0, 0.75, 15.58], '-z', 1.8, 0.45],
  [19, [-17.5, 0.9, -17.58], '+z', 1.6, 0.4],
  [20, [-23.58, 3.0, 12.0], '+x', 3.0, 0.75],
  [21, [-6.4, 1.9, -5.78], '+z', 0.9, 0.22],
  [21, [10.58, 1.7, -4.9], '-x', 0.8, 0.2],
  [22, [7.78, 3.0, 0.5], '-x', 1.2, 0.3],
  [22, [19.58, 3.0, -9.0], '-x', 1.2, 0.3],
  [23, [7.78, 1.5, 13.5], '-x', 1.4, 0.35],
];

// ------------------------------------------------------------------------------------------------ build
export function buildDecals(scene, layout, opts = {}) {
  const R = rng(1234);
  const rr = (a, b) => a + (b - a) * R();
  const out = { meshes: [], panes: glassPanes };
  const inside = (x, z) => x > -24 && x < 20 && z > -18 && z < 16;
  const props = layout.solids.filter((s) => s.collide && s.kind !== 'wall' && s.max[1] - s.min[1] > 0.1);
  const underProp = (x, z, m = 0) => props.some((s) => x > s.min[0] - m && x < s.max[0] + m && z > s.min[2] - m && z < s.max[2] + m);

  buildGroundMask(layout, opts, rng(77));

  // ---- grime decals (one mesh, one draw call)
  const D = new Quads();
  const atlas = grimeAtlas(R);
  const FY = () => 0.004 + R() * 0.003;
  const floorDecal = (x, z, s, cellI, rot = R() * 6.28, sh = s) => D.add([x, FY(), z], '+y', s, sh, gUV(cellI), rot);
  for (const [x, z, s, k] of opts.floorSpots || []) {
    if (k === 1) floorDecal(x, z, s * 0.8, GC.oil); else if (R() < 0.6) floorDecal(x, z, s, GC.grime);
  }
  // cracks on the floor slabs and the yard
  for (let i = 0; i < 34; i++) { const x = rr(-23, 19), z = rr(-17.4, 25.4); if (!underProp(x, z)) floorDecal(x, z, rr(1.2, 3.2), GC.crack, R() * 6.28, rr(0.8, 1.6)); }
  // broken tiles in the lino rooms
  for (const [x, z] of [[12.4, 14.6], [18.4, 11.0], [12.0, 8.6], [18.5, 5.6], [12.2, -5.0], [18.6, -2.4], [16.2, 12.4]]) floorDecal(x, z, rr(1.2, 1.8), GC.tiles);
  // leaves and dirt fans at every door to the outside, on both sides
  for (const d of layout.doors) {
    const [cx, cz] = d.center;
    const nrm = d.normal === 'z' ? [0, 1] : [1, 0];
    const outside = !inside(cx + nrm[0], cz + nrm[1]) || !inside(cx - nrm[0], cz - nrm[1]);
    for (const s of [-1, 1]) {
      const px = cx + nrm[0] * s * 1.0, pz = cz + nrm[1] * s * 1.0;
      if (underProp(px, pz, 0.2)) continue;
      const rot = Math.atan2(nrm[0] * s, nrm[1] * s) + Math.PI;   // fan points away from the door
      floorDecal(px, pz, Math.min(3.2, d.width * 1.1 + 0.6), GC.dirtfan, rot, 2.0);
      if (outside) {
        floorDecal(cx + nrm[0] * s * 0.7 + rr(-0.4, 0.4), cz + nrm[1] * s * 0.7 + rr(-0.4, 0.4), rr(1.2, 2.0), GC.leaves);
        if (d.width > 2) floorDecal(cx + nrm[0] * s * 1.6 + rr(-1, 1), cz + nrm[1] * s * 1.6, rr(1.4, 2.4), GC.leaves);
      }
    }
  }
  for (let i = 0; i < 14; i++) floorDecal(rr(-23, 19), rr(16.3, 25.6), rr(1.0, 2.2), GC.leaves);   // yard, along the fence
  // tyre marks: forklift arcs in the bay, van and lorry tracks in the yard
  const tyre = (pts, w = 0.55) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const l = Math.hypot(x1 - x0, z1 - z0); if (l < 0.05) continue;
      const rot = Math.atan2(x1 - x0, z1 - z0) + Math.PI;
      D.add([(x0 + x1) / 2, 0.005, (z0 + z1) / 2], '+y', w, l + 0.04, gUV(GC.tyre, 0, 1, 0, Math.min(1, l / 1.6)), rot);
    }
  };
  const arc = (cx, cz, r, a0, a1, n = 10) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; });
  tyre(arc(-6.0, -11.5, 3.2, 0.2, 2.2)); tyre(arc(-6.4, -12.0, 2.8, 0.4, 2.6), 0.45);
  tyre([[-15, -13.2], [-11, -13.4], [-6, -13.6], [0, -13.5], [6, -13.2]]);
  tyre(arc(-2.0, -9.5, 4.0, -1.4, 0.6));
  tyre([[-8.4, 25.6], [-8.2, 22.6]], 0.7); tyre([[-9.8, 16.2], [-9.6, 18.8]], 0.7);
  tyre(arc(10.0, 21.0, 4.0, 1.7, 3.6), 0.6); tyre([[14.0, 18.2], [14.0, 16.4]], 0.6);
  // safety lines along the walkways + hazard borders around machines (faded floor paint)
  const line = (x0, z0, x1, z1, w = 0.1, cellI = GC.line) => {
    const l = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(l / 2.0));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const x = x0 + (x1 - x0) * (t0 + t1) / 2, z = z0 + (z1 - z0) * (t0 + t1) / 2;
      const u0 = R() * 0.5;
      D.add([x, 0.0055, z], '+y', l / n + 0.01, w * (cellI === GC.line ? 2.2 : 3.2), gUV(cellI, u0, u0 + 0.5, 0.25, 0.75), Math.atan2(-(z1 - z0), x1 - x0));
    }
  };
  line(-15, -14.9, 1.0, -14.9); line(-15, -12.2, -3.0, -12.2); line(9.0, -14.9, 19.0, -14.9);
  line(-22.8, 3.0, -22.8, 15.0); line(-15.5, 10.6, 1.0, 10.6); line(-15.5, -4.9, 6.0, -4.9);
  line(-3.6, -5.6, -3.6, -1.0); line(-6.4, -5.6, -6.4, -1.0);
  const hazardRing = (x0, z0, x1, z1) => { line(x0, z0, x1, z0, 0.1, GC.hazard); line(x0, z1, x1, z1, 0.1, GC.hazard); line(x0, z0, x0, z1, 0.1, GC.hazard); line(x1, z0, x1, z1, 0.1, GC.hazard); };
  hazardRing(-11.6, 1.4, -6.9, 6.1); hazardRing(2.6, -4.4, 6.4, -0.6); hazardRing(2.5, 12.7, 5.9, 15.3);
  floorDecal(-4.0, -3.4, 1.6, GC.stencil, 0, 1.6); floorDecal(-15.0, -10.5, 1.6, GC.stencil, Math.PI / 2, 1.6); floorDecal(9.4, 6.0, 1.3, GC.stencil, 0, 1.3);

  // ---- walls: stains under windows, rust runs below fixings, peeling paint, bullet pocks, graffiti
  const wallDecal = (c, axis, w, h, cellI, u = [0, 1, 0, 1]) => D.add(c, axis, w, h, gUV(cellI, u[0], u[1], u[2], u[3]));
  for (const w of layout.windows) {     // rust / water streaks under windows on both faces
    const cx = (w.min[0] + w.max[0]) / 2, cz = (w.min[2] + w.max[2]) / 2, wid = (w.normal === 'z' ? w.max[0] - w.min[0] : w.max[2] - w.min[2]);
    const h = Math.min(w.min[1] - 0.12, 2.6);
    if (h < 0.4) continue;
    const y = w.min[1] - 0.06 - h / 2;
    if (w.normal === 'z') { wallDecal([cx, y, w.max[2] + 0.012], '+z', wid, h, GC.rust); wallDecal([cx, y, w.min[2] - 0.012], '-z', wid, h, GC.rust); }
    else { wallDecal([w.max[0] + 0.012, y, cz], '+x', wid, h, GC.rust); wallDecal([w.min[0] - 0.012, y, cz], '-x', wid, h, GC.rust); }
  }
  for (const [c, axis, w, h] of opts.wallSoot || []) wallDecal(c, axis, w, h, GC.grime);
  // collect big vertical wall faces for random placements
  const faces = [];
  for (const s of layout.solids) {
    if (s.kind !== 'wall' || !s.visual || s.max[1] - s.min[1] < 2.5 || s.min[1] > 0.05) continue;
    for (const f of ['px', 'nx', 'pz', 'nz']) {
      const key = typeof s.mat === 'string' ? s.mat : s.mat[f];
      if (!key || key.startsWith('corrugated')) continue;
      const alongX = f[1] === 'z', sg = f[0] === 'p' ? 1 : -1;
      const c = alongX ? (sg > 0 ? s.max[2] : s.min[2]) : (sg > 0 ? s.max[0] : s.min[0]);
      const a0 = alongX ? s.min[0] : s.min[2], a1 = alongX ? s.max[0] : s.max[2];
      if (a1 - a0 < 1.5) continue;
      faces.push({ key, alongX, sg, c: c + sg * 0.012, a0, a1, top: s.max[1], axis: (sg > 0 ? '+' : '-') + (alongX ? 'z' : 'x') });
    }
  }
  const pick = (pred) => { const L = faces.filter(pred); return L[Math.floor(R() * L.length)]; };
  const onFace = (F, a, y, w, h, cellI, u) => wallDecal(F.alongX ? [a, y, F.c] : [F.c, y, a], F.axis, w, h, cellI, u);
  for (let i = 0; i < 40; i++) {      // rust runs from fixings / roof edge
    const F = pick(() => true); if (!F) break;
    const a = rr(F.a0 + 0.4, F.a1 - 0.4), len = rr(1.0, 3.2), y = rr(Math.min(2.6, F.top - 0.4), F.top - 0.2) - len / 2;
    onFace(F, a, y, rr(0.35, 0.8), len, GC.rust);
  }
  for (let i = 0; i < 26; i++) {
    const F = pick((f) => f.key.startsWith('wall')); if (!F) break;
    onFace(F, rr(F.a0 + 0.5, F.a1 - 0.5), rr(0.6, 2.6), rr(0.6, 1.4), rr(0.6, 1.4), GC.peel);
  }
  for (let i = 0; i < 16; i++) {
    const F = pick((f) => f.key.startsWith('wall') || f.key.startsWith('brick')); if (!F) break;
    onFace(F, rr(F.a0 + 0.8, F.a1 - 0.8), rr(1.5, F.top - 1), rr(1.4, 2.6), rr(1.2, 2.2), GC.tide);
  }
  // bullet pocks where earlier fights happened (near cover in the hall, corridor end, control room, bay door)
  for (const [c, axis, s] of [[[-13.0, 1.3, -5.78], '+z', 1.4], [[-6.5, 1.5, 0.81], '+z', 0.55], [[1.81, 1.2, 8.0], '+x', 0.55],
    [[9.4, 1.4, -5.78], '+z', 1.2], [[19.58, 1.3, -3.4], '-x', 1.4], [[-23.58, 1.6, 9.0], '+x', 1.6], [[7.78, 1.2, -3.0], '-x', 1.2],
    [[-14.19, 1.4, 8.0], '+x', 0.55], [[10.58, 1.5, 6.0], '-x', 1.0], [[14.0, 1.3, -0.98], '+z', 1.1], [[-2.0, 1.1, 15.58], '-z', 1.5]]) {
    wallDecal(c, axis, s, s, GC.pocks);
  }
  // graffiti tags: yard side of the facade, the fence, the bay
  for (const [c, axis, w, cellI] of [[[-17.0, 1.4, 16.012], '+z', 2.0, GC.tagA], [[5.5, 1.5, 16.012], '+z', 1.6, GC.tagB], [[-3.0, 1.3, 25.79], '-z', 2.2, GC.tagB],
    [[12.0, 1.2, 25.79], '-z', 1.8, GC.tagA], [[19.588, 1.5, -14.0], '-x', 1.8, GC.tagA], [[-23.988, 1.5, -10.0], '-x', 2.0, GC.tagB],
    [[20.012, 1.4, 4.0], '+x', 2.0, GC.tagA], [[-0.5, 1.5, -6.212], '-z', 1.5, GC.tagB]]) wallDecal(c, axis, w, w, cellI);

  const decalMat = new THREE.MeshStandardMaterial({
    map: atlas.map, normalMap: atlas.normal, transparent: true, depthWrite: false, roughness: 0.82, metalness: 0, envMapIntensity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  decalMat.name = 'decals';
  const decalMesh = new THREE.Mesh(D.geometry(), decalMat);
  decalMesh.name = 'decals'; decalMesh.receiveShadow = true; decalMesh.renderOrder = 1;
  out.meshes.push(decalMesh);

  // ---- signage
  const signs = new Quads();
  for (const [i, c, axis, w, h] of SIGN_PLACES) signs.add(c, axis, w, h, signUV(i));
  const ex = opts.extraction;
  if (ex) {
    const y = 0.01, cx = (ex.min[0] + ex.max[0]) / 2, cz = (ex.min[2] + ex.max[2]) / 2, w = ex.max[0] - ex.min[0], d = ex.max[2] - ex.min[2];
    signs.add([cx, y, ex.max[2] - 0.1], '+y', w, 0.2, signUV(12));
    signs.add([ex.min[0] + 0.1, y, cz], '+y', d, 0.2, signUV(12), Math.PI / 2);
    signs.add([ex.max[0] - 0.1, y, cz], '+y', d, 0.2, signUV(12), Math.PI / 2);
    signs.add([cx, y + 0.001, cz + 0.3], '+y', 2.4, 0.6, signUV(15));
  }
  const signMat = new THREE.MeshStandardMaterial({
    map: signAtlas(R), transparent: true, alphaTest: 0.05, roughness: 0.75, metalness: 0, envMapIntensity: 0.4,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  signMat.name = 'signs';
  const signMesh = new THREE.Mesh(signs.geometry(), signMat);
  signMesh.name = 'signs'; signMesh.receiveShadow = true; signMesh.renderOrder = 2;
  out.meshes.push(signMesh);

  // ---- window glass: one merged mesh, one quad per pane between the mullions; per-pane proxies for combat
  glassPanes.length = 0;
  const glass = new Quads();
  const uvB = [], brokenA = [];
  const paneInfo = [];
  const GR = rng(4242);
  for (const w of layout.windows) {
    const G = windowGrid(w);
    const kind = w.glass || 'broken';
    const pBroken = kind === 'empty' ? 0.92 : kind === 'broken' ? 0.5 : 0.06;
    const pCracked = kind === 'cracked' ? 0.6 : 0.2;
    for (const p of G.panes) {
      const ca = (p.a0 + p.a1) / 2, cy = (p.y0 + p.y1) / 2, pw = p.a1 - p.a0 + 0.012, ph = p.y1 - p.y0 + 0.012;
      const c = G.alongX ? [ca, cy, G.plane] : [G.plane, cy, ca];
      const col = Math.floor(GR() * 4);
      const intact = GR() < pCracked ? glassUV(1, col) : glassUV(0, Math.floor(GR() * 4));
      const rem = glassUV(GR() < 0.6 ? 2 : 3, Math.floor(GR() * 4));
      const start = glass.add(c, G.alongX ? '+z' : '+x', pw, ph, intact);
      const broken = GR() < pBroken;
      for (let k = 0; k < 4; k++) { brokenA.push(broken ? 1 : 0); }
      const q = glass.uv.length - 8;
      for (let k = 0; k < 4; k++) { const sx = glass.uv[q + k * 2] === intact[0] ? rem[0] : rem[2], sy = glass.uv[q + k * 2 + 1] === intact[1] ? rem[1] : rem[3]; uvB.push(sx, sy); }
      paneInfo.push({ start, broken, c, alongX: G.alongX, pw, ph });
    }
  }
  const glassGeo = glass.geometry();
  glassGeo.setAttribute('uvBroken', new THREE.Float32BufferAttribute(uvB, 2));
  const brokenAttr = new THREE.Float32BufferAttribute(brokenA, 1);
  brokenAttr.setUsage(THREE.DynamicDrawUsage);
  glassGeo.setAttribute('aBroken', brokenAttr);
  const gAt = glassAtlas(R);
  const glassMat = new THREE.MeshStandardMaterial({
    map: gAt.map, roughnessMap: gAt.rough, roughness: 1, metalness: 0, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, envMapIntensity: 1.0, color: 0xd8dcd6, premultipliedAlpha: true,
  });
  glassMat.name = 'glass';
  glassMat.customProgramCacheKey = () => 'glass-panes';
  glassMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 uvBroken;\nattribute float aBroken;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = mix( vMapUv, uvBroken, aBroken );\n#ifdef USE_ROUGHNESSMAP\nvRoughnessMapUv = vMapUv;\n#endif');
    // glass: diffuse film is alpha-blended, the specular reflection is added on top (premultiplied blending)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <premultiplied_alpha_fragment>', '')
      .replace('#include <opaque_fragment>',
        'outgoingLight = totalDiffuse * diffuseColor.a + totalSpecular * smoothstep( 0.02, 0.12, diffuseColor.a ) * 1.6;\n#include <opaque_fragment>');
  };
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.name = 'glass'; glassMesh.renderOrder = 3; glassMesh.userData.surface = 'glass';
  out.meshes.push(glassMesh);
  glassState = { attr: brokenAttr, mesh: glassMesh };

  const proxyGeo = new THREE.PlaneGeometry(1, 1);
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  const proxyRoot = new THREE.Group(); proxyRoot.name = 'glass-panes';
  for (const p of paneInfo) {
    if (p.broken) continue;
    const m = new THREE.Mesh(proxyGeo, proxyMat);
    m.name = 'glass-pane';
    m.position.set(p.c[0], p.c[1], p.c[2]);
    m.scale.set(p.pw, p.ph, 1);
    if (!p.alongX) m.rotation.y = Math.PI / 2;
    m.userData.surface = 'glass';
    m.userData.breakable = true;
    m.userData.broken = false;
    m.userData.vertexStart = p.start;
    m.userData.shatter = (point, dir) => { void point; void dir; if (!m.userData.broken) setPaneBroken(m, true); };
    m.matrixAutoUpdate = false; m.updateMatrix();
    proxyRoot.add(m);
    glassPanes.push(m);
  }
  scene.add(proxyRoot);
  proxyRoot.updateMatrixWorld(true);
  out.glassProxyRoot = proxyRoot;

  for (const m of out.meshes) { m.castShadow = false; m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); }
  return out;
}
