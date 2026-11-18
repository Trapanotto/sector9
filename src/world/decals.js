// Canvas-generated decal atlases (stains, puddles, signage, dirty/broken glass) and the merged decal meshes.
import * as THREE from 'three';
import { makeCanvas } from './materials.js';
import { rng } from './geometry.js';

// ------------------------------------------------------------ textures
function stainAtlas(R) {
  const N = 1024, c = makeCanvas(N, N), g = c.getContext('2d');
  g.clearRect(0, 0, N, N);
  const blob = (cx, cy, r, rgb, a, n = 30) => {
    for (let i = 0; i < n; i++) {
      const ang = R() * Math.PI * 2, d = Math.sqrt(R()) * r * 0.6;
      const x = cx + Math.cos(ang) * d, y = cy + Math.sin(ang) * d, rr = r * (0.15 + R() * 0.4);
      const grd = g.createRadialGradient(x, y, 0, x, y, rr);
      grd.addColorStop(0, `rgba(${rgb},${a})`); grd.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    }
  };
  // 0: dark grime blotch, 1: oil stain with ring, 2: rust/water streak (vertical), 3: soot smear
  blob(256, 256, 230, '28,24,20', 0.22, 60);
  blob(768, 256, 160, '10,10,12', 0.35, 30);
  g.strokeStyle = 'rgba(8,8,8,0.35)'; g.lineWidth = 10; g.beginPath(); g.arc(768, 256, 170, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 40; i++) {
    const x = 60 + R() * 392, w = 4 + R() * 26, len = 120 + R() * 360;
    const grd = g.createLinearGradient(0, 512, 0, 512 + len);
    grd.addColorStop(0, 'rgba(70,40,20,0.35)'); grd.addColorStop(1, 'rgba(70,40,20,0)');
    g.fillStyle = grd; g.fillRect(x, 512, w, len);
  }
  blob(768, 768, 230, '15,14,13', 0.18, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function puddleTex(R) {
  const N = 512, c = makeCanvas(N, N), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 26; i++) {
    const x = 256 + (R() - 0.5) * 260, y = 256 + (R() - 0.5) * 260, r = 40 + R() * 110;
    const grd = g.createRadialGradient(x, y, r * 0.55, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

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
];

function signAtlas(R) {
  const W = 1024, Hc = 128, c = makeCanvas(W, Hc * 8), g = c.getContext('2d');
  g.clearRect(0, 0, W, Hc * 8);
  SIGNS.forEach((s, i) => {
    const x0 = (i % 2) * 512, y0 = Math.floor(i / 2) * Hc;
    g.save(); g.beginPath(); g.rect(x0, y0, 512, Hc); g.clip();
    if (s.hazard) {
      g.fillStyle = '#e2b92a'; g.fillRect(x0, y0, 512, Hc);
      g.fillStyle = '#141414';
      for (let k = -4; k < 12; k++) { g.beginPath(); g.moveTo(x0 + k * 64, y0 + Hc); g.lineTo(x0 + k * 64 + 32, y0 + Hc); g.lineTo(x0 + k * 64 + 32 + Hc, y0); g.lineTo(x0 + k * 64 + Hc, y0); g.fill(); }
    } else {
      if (s.bg) { g.fillStyle = s.bg; g.fillRect(x0 + 4, y0 + 4, 504, Hc - 8); }
      if (s.border) { g.strokeStyle = s.border; g.lineWidth = 8; g.strokeRect(x0 + 10, y0 + 10, 492, Hc - 20); }
      g.fillStyle = s.fg; g.font = s.font; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (s.graffiti) { g.translate(x0 + 256, y0 + 66); g.rotate(-0.05); g.fillText(s.text, 0, 0, 490); }
      else g.fillText(s.text, x0 + 256, y0 + Hc / 2 + 3, 480);
    }
    // weathering: grime, scratches, missing paint
    g.restore(); g.save(); g.beginPath(); g.rect(x0, y0, 512, Hc); g.clip();
    for (let k = 0; k < 220; k++) {
      const x = x0 + R() * 512, y = y0 + R() * Hc, r = R() * 6;
      g.fillStyle = `rgba(${40 + R() * 30},${32 + R() * 20},${20},${s.graffiti ? 0 : R() * 0.35})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    if (!s.graffiti) {
      const grd = g.createLinearGradient(0, y0, 0, y0 + Hc);
      grd.addColorStop(0, 'rgba(30,25,18,0.05)'); grd.addColorStop(1, 'rgba(30,25,18,0.4)');
      g.fillStyle = grd; g.fillRect(x0, y0, 512, Hc);
    }
    g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Glass atlas, 3 columns: cracked / broken (big holes) / empty (shards along the frame only).
function glassAtlas(R) {
  const N = 512, c = makeCanvas(N * 3, N), g = c.getContext('2d');
  g.clearRect(0, 0, N * 3, N);
  for (let col = 0; col < 3; col++) {
    const x0 = col * N;
    g.save(); g.beginPath(); g.rect(x0, 0, N, N); g.clip();
    g.fillStyle = 'rgba(120,128,118,0.55)'; g.fillRect(x0, 0, N, N);
    for (let k = 0; k < 300; k++) {
      g.fillStyle = `rgba(60,58,50,${R() * 0.25})`;
      g.beginPath(); g.arc(x0 + R() * N, R() * N, R() * 30, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'destination-out';
    const holes = col === 0 ? 1 : col === 1 ? 4 : 0;
    for (let h = 0; h < holes; h++) {
      const cx = x0 + 80 + R() * (N - 160), cy = 80 + R() * (N - 160), r = col === 0 ? 30 : 90 + R() * 120;
      g.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.35) {
        const rr = r * (0.4 + R() * 0.9);
        g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.closePath(); g.fill();
    }
    if (col === 2) {
      g.beginPath(); g.moveTo(x0 + 30, 30);
      for (let a = 0; a < 40; a++) g.lineTo(x0 + 30 + R() * (N - 60), 30 + R() * (N - 60));
      g.fill();
      g.fillRect(x0 + 40, 40, N - 80, N - 80);
    }
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(230,235,230,0.55)'; g.lineWidth = 1.5;
    for (let k = 0; k < (col === 0 ? 14 : 8); k++) {
      const sx = x0 + N * (0.3 + R() * 0.4), sy = N * (0.3 + R() * 0.4);
      g.beginPath(); g.moveTo(sx, sy);
      let x = sx, y = sy;
      const a0 = R() * Math.PI * 2;
      for (let s = 0; s < 6; s++) { x += Math.cos(a0 + (R() - 0.5)) * 50; y += Math.sin(a0 + (R() - 0.5)) * 50; g.lineTo(x, y); }
      g.stroke();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------ quad accumulation
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
  return [col * 0.5 + 0.004, 1 - (row + 1) / 8 + 0.004, col * 0.5 + 0.5 - 0.004, 1 - row / 8 - 0.004];
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
];

export function buildDecals(scene, layout, opts = {}) {
  const R = rng(1234);
  const rr = (a, b) => a + (b - a) * R();
  const out = { meshes: [] };

  // ---- stains (floors + walls)
  const stains = new Quads();
  const sTex = stainAtlas(R);
  const cell = (i) => [(i % 2) * 0.5, 1 - (Math.floor(i / 2) + 1) * 0.5, (i % 2) * 0.5 + 0.5, 1 - Math.floor(i / 2) * 0.5];
  const floorSpots = opts.floorSpots || [];
  for (const [x, z, s, k] of floorSpots) stains.add([x, 0.006 + R() * 0.002, z], '+y', s, s, cell(k), R() * 6);
  for (const w of layout.windows) {     // rust / water streaks under windows on both faces
    const cx = (w.min[0] + w.max[0]) / 2, cz = (w.min[2] + w.max[2]) / 2, wid = (w.normal === 'z' ? w.max[0] - w.min[0] : w.max[2] - w.min[2]);
    const h = Math.min(w.min[1] - 0.05, 2.5);
    if (h < 0.4) continue;
    const y = w.min[1] - h / 2;
    if (w.normal === 'z') { stains.add([cx, y, w.max[2] + 0.012], '+z', wid, h, cell(2)); stains.add([cx, y, w.min[2] - 0.012], '-z', wid, h, cell(2)); }
    else { stains.add([w.max[0] + 0.012, y, cz], '+x', wid, h, cell(2)); stains.add([w.min[0] - 0.012, y, cz], '-x', wid, h, cell(2)); }
  }
  for (const [c, axis, w, h] of opts.wallSoot || []) stains.add(c, axis, w, h, cell(3));
  const stainMat = new THREE.MeshStandardMaterial({
    map: sTex, transparent: true, depthWrite: false, roughness: 0.85, metalness: 0, envMapIntensity: 0.3,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const stainMesh = new THREE.Mesh(stains.geometry(), stainMat);
  stainMesh.receiveShadow = true; stainMesh.renderOrder = 1;
  out.meshes.push(stainMesh);

  // ---- puddles (low roughness, reflect the sky)
  const pud = new Quads();
  for (const [x, z, s] of opts.puddles || []) pud.add([x, 0.008, z], '+y', s * rr(0.8, 1.2), s * rr(0.7, 1.1), [0, 0, 1, 1], R() * 6);
  const pudMat = new THREE.MeshStandardMaterial({
    color: 0x0d0e0f, roughness: 0.04, metalness: 0, alphaMap: puddleTex(R), transparent: true, depthWrite: false,
    envMapIntensity: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const pudMesh = new THREE.Mesh(pud.geometry(), pudMat);
  pudMesh.receiveShadow = true; pudMesh.renderOrder = 2;
  out.meshes.push(pudMesh);

  // ---- signage
  const signs = new Quads();
  for (const [i, c, axis, w, h] of SIGN_PLACES) signs.add(c, axis, w, h, signUV(i));
  // floor markings around the extraction zone
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
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const signMesh = new THREE.Mesh(signs.geometry(), signMat);
  signMesh.receiveShadow = true;
  out.meshes.push(signMesh);

  // ---- window glass (dirty, cracked, broken)
  const glass = new Quads();
  const col = { cracked: 0, broken: 1, empty: 2 };
  for (const w of layout.windows) {
    const k = col[w.glass] ?? 1;
    const cx = (w.min[0] + w.max[0]) / 2, cy = (w.min[1] + w.max[1]) / 2, cz = (w.min[2] + w.max[2]) / 2;
    const wid = w.normal === 'z' ? w.max[0] - w.min[0] : w.max[2] - w.min[2], h = w.max[1] - w.min[1];
    const u0 = k / 3 + rr(0, 0.04), uv = [u0, rr(0, 0.1), u0 + 1 / 3 - 0.05, 1 - rr(0, 0.1)];
    glass.add([cx, cy, cz], w.normal === 'z' ? '+z' : '+x', wid, h, uv);
  }
  const glassMat = new THREE.MeshStandardMaterial({
    map: glassAtlas(R), transparent: true, depthWrite: false, roughness: 0.12, metalness: 0, side: THREE.DoubleSide,
    envMapIntensity: 1.0, color: 0xc8d0cc,
  });
  const glassMesh = new THREE.Mesh(glass.geometry(), glassMat);
  glassMesh.renderOrder = 3;
  out.meshes.push(glassMesh);

  for (const m of out.meshes) { m.castShadow = false; m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); }
  return out;
}
