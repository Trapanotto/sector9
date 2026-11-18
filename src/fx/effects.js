import * as THREE from 'three';

// Pooled visual effects for SECTOR 9: decals, particles, muzzle flashes, tracers, casings.
// Everything is allocated at creation; steady-state calls do not allocate.

// ---- Tunables -------------------------------------------------------------------------------
export const FX_TUNING = {
  holeCapacity: 150,
  bloodDecalCapacity: 160,     // wall/floor splatters + floor drip spots (shared ring)
  poolCapacity: 12,
  poolGrowSeconds: 8,
  bloodRay: 4,                 // max distance a spray can reach a wall/floor behind the target
  bloodSpeed: 9,               // m/s, delays the splatter appearing on the wall
  dustCapacity: 640, mistCapacity: 384, dropCapacity: 256, debrisCapacity: 256,
  sparkCapacity: 192, splinterCapacity: 128,
  shellCapacity: 32,
  flashLights: 2,              // pooled PointLights, kept in the scene at intensity 0
  flashIntensity: 28, flashDistance: 9, flashSeconds: 0.06,
  tracerOpacity: 0.22,
  dropSpotChance: 0.45,
};

const UP = new THREE.Vector3(0, 1, 0);
const ZAX = new THREE.Vector3(0, 0, 1);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (r, g, b) => [srgbToLin(r), srgbToLin(g), srgbToLin(b)];

// particle colours (sRGB, chosen to read correctly in a dim, overcast interior)
const COL = {
  dustConcrete: lin(0.52, 0.50, 0.46), dustWood: lin(0.42, 0.33, 0.22), dustMetal: lin(0.38, 0.37, 0.35),
  chipConcrete: lin(0.30, 0.29, 0.27), chipWood: lin(0.45, 0.33, 0.20),
  spark: [1.0, 0.62, 0.25], splinter: lin(0.55, 0.42, 0.26),
  mist: lin(0.32, 0.03, 0.03), drop: lin(0.26, 0.015, 0.02), smoke: lin(0.42, 0.42, 0.42),
  tracer: [1.0, 0.8, 0.55],
};

export function createEffects(ctx) {
  const T = FX_TUNING;
  const scene = ctx.scene;

  // temporaries
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vN = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const mA = new THREE.Matrix4(), sA = new THREE.Vector3(), colA = new THREE.Color();
  const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

  const groundAt = (x, z) => {
    const g = ctx.level?.groundHeight?.(x, z);
    return Number.isFinite(g) ? g : 0;
  };
  function randUnit(out) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return out.set(s * Math.cos(a), u, s * Math.sin(a));
  }

  // ---- textures -----------------------------------------------------------------------------
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c, srgb = true) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }
  function blob(g, cx, cy, r, jitter, n) {
    g.beginPath();
    const ph = [Math.random() * 6, Math.random() * 6, Math.random() * 6];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const k = 1 + jitter * (0.5 * Math.sin(3 * a + ph[0]) + 0.3 * Math.sin(5 * a + ph[1]) + 0.2 * Math.sin(11 * a + ph[2]))
        + jitter * 0.35 * (Math.random() - 0.5);
      const x = cx + Math.cos(a) * r * k, y = cy + Math.sin(a) * r * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

  // bullet holes: 2x2 atlas (0 concrete, 1 metal, 2 wood, 3 concrete variant)
  function makeHoleAtlas() {
    const S = 128, c = makeCanvas(S * 2, S * 2), g = c.getContext('2d');
    const cell = (i) => [(i % 2) * S + S / 2, ((i / 2) | 0) * S + S / 2];
    for (const i of [0, 3]) {
      const [cx, cy] = cell(i), R = S * 0.44;
      let gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      gr.addColorStop(0, 'rgba(175,170,160,0.55)'); gr.addColorStop(0.55, 'rgba(150,146,138,0.22)'); gr.addColorStop(1, 'rgba(150,146,138,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(118,113,106,0.95)'; blob(g, cx, cy, R * rnd(0.42, 0.52), 0.45, 26); g.fill();
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * 6.28, d = R * rnd(0.2, 0.4);
        g.fillStyle = `rgba(${150 + (Math.random() * 30 | 0)},${145 + (Math.random() * 30 | 0)},135,0.9)`;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * rnd(0.06, 0.12), 0.5, 8); g.fill();
      }
      g.fillStyle = 'rgba(70,66,62,1)'; blob(g, cx, cy, R * 0.27, 0.3, 18); g.fill();
      gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.2);
      gr.addColorStop(0, 'rgba(8,8,8,1)'); gr.addColorStop(1, 'rgba(30,28,26,1)');
      g.fillStyle = gr; blob(g, cx, cy, R * 0.18, 0.25, 14); g.fill();
      g.strokeStyle = 'rgba(40,38,35,0.75)';
      const nc = 3 + (Math.random() * 3 | 0);
      for (let k = 0; k < nc; k++) {
        let a = Math.random() * 6.28, d = R * 0.2;
        g.lineWidth = rnd(0.8, 1.6); g.beginPath(); g.moveTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
        const end = R * rnd(0.55, 0.95);
        while (d < end) { d += R * rnd(0.08, 0.16); a += rnd(-0.35, 0.35); g.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d); }
        g.stroke();
      }
    }
    { // metal
      const [cx, cy] = cell(1), R = S * 0.44;
      let gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.8);
      gr.addColorStop(0, 'rgba(22,20,18,0.75)'); gr.addColorStop(0.5, 'rgba(30,26,22,0.35)'); gr.addColorStop(1, 'rgba(30,26,22,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.8, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(205,203,196,0.95)'; g.lineWidth = R * 0.09;
      g.beginPath(); g.arc(cx, cy, R * 0.21, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(120,118,112,0.8)'; g.lineWidth = R * 0.05;
      g.beginPath(); g.arc(cx, cy, R * 0.29, 0, Math.PI * 2); g.stroke();
      g.fillStyle = 'rgba(5,5,5,1)'; g.beginPath(); g.arc(cx, cy, R * 0.16, 0, Math.PI * 2); g.fill();
    }
    { // wood
      const [cx, cy] = cell(2), R = S * 0.44;
      g.save(); g.translate(cx, cy); g.scale(1.6, 1);
      g.fillStyle = 'rgba(70,50,30,0.35)'; blob(g, 0, 0, R * 0.5, 0.3, 20); g.fill();
      g.fillStyle = 'rgba(196,156,104,0.95)';
      g.beginPath();
      const n = 22;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, spike = (i % 2 ? rnd(0.5, 1.0) : rnd(0.22, 0.32));
        const x = Math.cos(a) * R * spike * (Math.abs(Math.cos(a)) * 0.6 + 0.4), y = Math.sin(a) * R * spike * 0.6;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(120,88,52,0.7)'; g.lineWidth = 1;
      for (let k = 0; k < 6; k++) { const y = rnd(-R * 0.25, R * 0.25); g.beginPath(); g.moveTo(-R * 0.55, y); g.lineTo(R * 0.55, y + rnd(-2, 2)); g.stroke(); }
      g.restore();
      g.fillStyle = 'rgba(10,7,5,1)'; blob(g, cx, cy, R * 0.16, 0.3, 12); g.fill();
    }
    return tex(c);
  }

  // blood: 4x2 atlas, cells 0..6 splatters, 7 drip spots
  function makeBloodAtlas() {
    const S = 256, c = makeCanvas(S * 4, S * 2), g = c.getContext('2d');
    for (let i = 0; i < 7; i++) {
      const ox = (i % 4) * S, oy = ((i / 4) | 0) * S, cx = ox + S / 2, cy = oy + S / 2, R = S * 0.46;
      const dirA = Math.random() * Math.PI * 2, spread = rnd(0.5, 1.1);
      const r0 = S * rnd(0.09, 0.16);
      // spray droplets
      const N = 40 + (Math.random() * 60 | 0);
      for (let k = 0; k < N; k++) {
        const a = Math.random() < 0.75 ? dirA + gauss() * spread : Math.random() * 6.283;
        const d = Math.min(R - 6, r0 * 0.6 + Math.abs(gauss()) * R * 0.75);
        const f = d / R;
        const size = Math.max(0.7, (1 - f) * rnd(1.2, 6.5));
        const el = 1 + f * rnd(1, 2.6);
        g.save(); g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d); g.rotate(a);
        g.fillStyle = `rgba(${52 + (Math.random() * 26 | 0)},${3 + (Math.random() * 5 | 0)},${4 + (Math.random() * 4 | 0)},${rnd(0.75, 0.98).toFixed(2)})`;
        g.beginPath(); g.ellipse(0, 0, size * el, size, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      // streaks
      const ns = 2 + (Math.random() * 5 | 0);
      for (let k = 0; k < ns; k++) {
        const a = dirA + gauss() * spread * 0.8, L = rnd(0.4, 0.95) * (R - 8);
        let w = rnd(3, 7);
        for (let d = r0 * 0.5; d < L; d += 2) {
          w *= 0.975;
          g.fillStyle = 'rgba(58,4,5,0.9)';
          g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.5, w * 0.5), 0, 6.283); g.fill();
        }
      }
      // main body, darker and thicker in the middle
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * 1.3);
      gr.addColorStop(0, 'rgba(40,2,3,0.98)'); gr.addColorStop(0.6, 'rgba(62,5,6,0.96)'); gr.addColorStop(1, 'rgba(78,8,8,0.9)');
      g.fillStyle = gr; blob(g, cx, cy, r0, 0.5, 30); g.fill();
      g.strokeStyle = 'rgba(32,2,2,0.55)'; g.lineWidth = 1.5; g.stroke();
    }
    { // drip spots
      const ox = 3 * S, oy = S, cx = ox + S / 2, cy = oy + S / 2;
      const n = 6 + (Math.random() * 7 | 0);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * 6.283, d = Math.random() * S * 0.28, r = rnd(4, 14);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
        g.fillStyle = 'rgba(56,4,5,0.95)'; blob(g, x, y, r, 0.25, 14); g.fill();
        g.strokeStyle = 'rgba(30,2,2,0.6)'; g.lineWidth = 1.2; g.stroke();
        for (let j = 0; j < 4; j++) {
          const b = Math.random() * 6.283, dd = r * rnd(1.2, 2);
          g.beginPath(); g.arc(x + Math.cos(b) * dd, y + Math.sin(b) * dd, rnd(0.8, 2), 0, 6.283); g.fill();
        }
      }
    }
    return tex(c);
  }

  // pools: 2x2 atlas
  function makePoolAtlas() {
    const S = 256, c = makeCanvas(S * 2, S * 2), g = c.getContext('2d');
    for (let i = 0; i < 4; i++) {
      const cx = (i % 2) * S + S / 2, cy = ((i / 2) | 0) * S + S / 2, R = S * 0.34;
      const ph = [0, 0, 0, 0].map(() => Math.random() * 6.283);
      const path = () => {
        g.beginPath();
        for (let k = 0; k <= 64; k++) {
          const a = (k / 64) * 6.283;
          const r = R * (1 + 0.12 * Math.sin(2 * a + ph[0]) + 0.09 * Math.sin(3 * a + ph[1]) + 0.05 * Math.sin(7 * a + ph[2]) + 0.03 * Math.sin(13 * a + ph[3]));
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
      };
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
      gr.addColorStop(0, 'rgba(34,2,3,0.98)'); gr.addColorStop(0.7, 'rgba(52,4,5,0.97)'); gr.addColorStop(1, 'rgba(76,8,8,0.9)');
      g.fillStyle = gr; path(); g.fill();
      g.strokeStyle = 'rgba(26,2,2,0.6)'; g.lineWidth = 2; g.stroke();
      const lobes = 1 + (Math.random() * 3 | 0);
      for (let k = 0; k < lobes; k++) {
        const a = Math.random() * 6.283, d = R * rnd(0.95, 1.15), r = R * rnd(0.12, 0.26);
        g.fillStyle = 'rgba(56,4,5,0.95)'; blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0.3, 18); g.fill();
      }
    }
    return tex(c);
  }

  function makeSoftSprite() {
    const S = 64, c = makeCanvas(S, S), g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    return tex(c, false);
  }

  function makeFlashTex() {
    const S = 128, c = makeCanvas(S, S), g = c.getContext('2d'), cx = S / 2, R = S / 2;
    g.globalCompositeOperation = 'lighter';
    const n = 4 + (Math.random() * 4 | 0);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283 + k * (6.283 / n), L = R * rnd(0.45, 0.98), w = R * rnd(0.07, 0.16);
      g.save(); g.translate(cx, cx); g.rotate(a);
      const gr = g.createLinearGradient(0, 0, L, 0);
      gr.addColorStop(0, 'rgba(255,225,170,0.9)'); gr.addColorStop(0.5, 'rgba(255,160,70,0.45)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, -w); g.lineTo(L, 0); g.lineTo(0, w); g.closePath(); g.fill();
      g.restore();
    }
    const gr = g.createRadialGradient(cx, cx, 0, cx, cx, R * 0.5);
    gr.addColorStop(0, 'rgba(255,248,230,1)'); gr.addColorStop(0.35, 'rgba(255,200,120,0.75)'); gr.addColorStop(1, 'rgba(255,140,50,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    return tex(c);
  }

  // ---- instanced decal layer ----------------------------------------------------------------
  function makeDecalLayer({ map, cols, rows, capacity, roughness, metalness = 0, offset, renderOrder }) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    cellAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', cellAttr);
    const mat = new THREE.MeshStandardMaterial({
      map, transparent: true, depthWrite: false, roughness, metalness,
      polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset * 2,
    });
    const sx = (1 / cols).toFixed(6), sy = (1 / rows).toFixed(6);
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = vMapUv * vec2(${sx}, ${sy}) + aCell;\n#endif`);
    };
    mat.customProgramCacheKey = () => `s9decal_${cols}x${rows}`;
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.count = 0;
    colA.setScalar(1);
    for (let i = 0; i < capacity; i++) { mesh.setMatrixAt(i, ZERO_M); mesh.setColorAt(i, colA); }
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    let next = 0, count = 0;

    function setTransform(i, pos, normal, size, rot, lift = 0.003) {
      qA.setFromUnitVectors(ZAX, normal);
      qB.setFromAxisAngle(ZAX, rot);
      qC.multiplyQuaternions(qA, qB);
      vC.copy(pos).addScaledVector(normal, lift);
      sA.set(size, size, 1);
      mA.compose(vC, qC, sA);
      mesh.setMatrixAt(i, mA);
      mesh.instanceMatrix.needsUpdate = true;
    }
    function add(pos, normal, size, rot, cell, bright) {
      const i = next; next = (next + 1) % capacity;
      if (count < capacity) { count++; mesh.count = count; }
      setTransform(i, pos, normal, size, rot);
      const c = cell % cols, r = (cell / cols) | 0;
      cellAttr.setXY(i, c / cols, 1 - (r + 1) / rows);
      cellAttr.needsUpdate = true;
      colA.setScalar(bright); mesh.setColorAt(i, colA); mesh.instanceColor.needsUpdate = true;
      return i;
    }
    function clear() { next = 0; count = 0; mesh.count = 0; }
    return { mesh, add, setTransform, clear };
  }

  // ---- point particle system ----------------------------------------------------------------
  const pointVS = /* glsl */`
    attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
    uniform float uScale;
    varying vec3 vColor; varying float vAlpha;
    #include <fog_pars_vertex>
    void main() {
      vColor = aColor; vAlpha = aAlpha;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(-mvPosition.z, 0.05) : 0.0;
      #include <fog_vertex>
    }`;
  const pointFS = /* glsl */`
    uniform sampler2D map;
    varying vec3 vColor; varying float vAlpha;
    #include <fog_pars_fragment>
    void main() {
      float a = texture2D(map, gl_PointCoord).a * vAlpha;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;
  const LAND_NONE = 0, LAND_STOP = 1, LAND_SPOT = 2;
  const pointSystems = [];

  function makePoints(capacity, { additive = false, map, renderOrder = 5 }) {
    const pos = new Float32Array(capacity * 3), col = new Float32Array(capacity * 3);
    const size = new Float32Array(capacity), alpha = new Float32Array(capacity);
    const vel = new Float32Array(capacity * 3), life = new Float32Array(capacity), maxLife = new Float32Array(capacity);
    const grav = new Float32Array(capacity), drag = new Float32Array(capacity), grow = new Float32Array(capacity);
    const a0 = new Float32Array(capacity), ground = new Float32Array(capacity), land = new Uint8Array(capacity);
    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos); geo.setAttribute('aColor', aCol);
    geo.setAttribute('aSize', aSize); geo.setAttribute('aAlpha', aAlpha);
    const uniforms = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    uniforms.map = { value: map }; uniforms.uScale = { value: 800 };
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: pointVS, fragmentShader: pointFS, fog: true,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false; points.renderOrder = renderOrder;
    scene.add(points);
    let next = 0, alive = 0, dirty = false;

    function spawn(x, y, z, vx, vy, vz, s, l, c, al, g, dr, gr, landMode = LAND_NONE, groundY = -1e9) {
      const i = next; next = (next + 1) % capacity;
      if (life[i] <= 0) alive++;
      const i3 = i * 3;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      col[i3] = c[0]; col[i3 + 1] = c[1]; col[i3 + 2] = c[2];
      size[i] = s; life[i] = l; maxLife[i] = l; a0[i] = al; alpha[i] = al;
      grav[i] = g; drag[i] = dr; grow[i] = gr; land[i] = landMode; ground[i] = groundY;
      dirty = true;
    }
    function kill(i) { life[i] = 0; alpha[i] = 0; alive--; }
    function update(dt, onLand) {
      if (alive <= 0) { if (dirty) upload(); alive = 0; return; }
      for (let i = 0; i < capacity; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) { kill(i); continue; }
        const i3 = i * 3;
        const k = Math.max(0, 1 - drag[i] * dt);
        vel[i3] *= k; vel[i3 + 2] *= k; vel[i3 + 1] = vel[i3 + 1] * k - grav[i] * dt;
        pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
        if (land[i] !== LAND_NONE && pos[i3 + 1] <= ground[i]) {
          pos[i3 + 1] = ground[i];
          if (land[i] === LAND_SPOT) { onLand?.(pos[i3], ground[i], pos[i3 + 2]); kill(i); continue; }
          vel[i3] = vel[i3 + 1] = vel[i3 + 2] = 0; grav[i] = 0; land[i] = LAND_NONE;
        }
        size[i] += grow[i] * dt;
        const age = maxLife[i] - life[i], f = age / maxLife[i];
        alpha[i] = a0[i] * (1 - f) * Math.min(1, age * 25);
      }
      upload();
    }
    function upload() {
      aPos.needsUpdate = true; aCol.needsUpdate = true; aSize.needsUpdate = true; aAlpha.needsUpdate = true;
      dirty = false;
    }
    function clear() { life.fill(0); alpha.fill(0); alive = 0; dirty = true; }
    const sys = { spawn, update, clear, uniforms };
    pointSystems.push(sys);
    return sys;
  }

  // ---- streak (line) system for sparks / splinters --------------------------------------------
  function makeStreaks(capacity, { additive, color, opacity = 1, fog = true }) {
    const pos = new Float32Array(capacity * 6), col = new Float32Array(capacity * 6);
    const head = new Float32Array(capacity * 3), vel = new Float32Array(capacity * 3);
    const life = new Float32Array(capacity), maxLife = new Float32Array(capacity), len = new Float32Array(capacity);
    const grav = new Float32Array(capacity), ground = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos); geo.setAttribute('color', aCol);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity, depthWrite: false, fog,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false; lines.renderOrder = 6;
    scene.add(lines);
    let next = 0, alive = 0;
    function spawn(x, y, z, vx, vy, vz, l, length, g, groundY) {
      const i = next; next = (next + 1) % capacity;
      if (life[i] <= 0) alive++;
      const i3 = i * 3;
      head[i3] = x; head[i3 + 1] = y; head[i3 + 2] = z;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      life[i] = l; maxLife[i] = l; len[i] = length; grav[i] = g; ground[i] = groundY;
    }
    function update(dt) {
      if (alive <= 0) { alive = 0; return; }
      for (let i = 0; i < capacity; i++) {
        if (life[i] <= 0) continue;
        const i3 = i * 3, i6 = i * 6;
        life[i] -= dt;
        if (life[i] <= 0) {
          alive--;
          for (let k = 0; k < 6; k++) { col[i6 + k] = 0; pos[i6 + k] = head[i3 + (k % 3)]; }
          continue;
        }
        vel[i3 + 1] -= grav[i] * dt;
        const k = Math.max(0, 1 - 0.8 * dt);
        vel[i3] *= k; vel[i3 + 1] *= k; vel[i3 + 2] *= k;
        head[i3] += vel[i3] * dt; head[i3 + 1] += vel[i3 + 1] * dt; head[i3 + 2] += vel[i3 + 2] * dt;
        if (head[i3 + 1] < ground[i]) {
          head[i3 + 1] = ground[i]; vel[i3 + 1] = Math.abs(vel[i3 + 1]) * 0.3; vel[i3] *= 0.5; vel[i3 + 2] *= 0.5;
        }
        const sp = Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]) || 1;
        const L = len[i] < 0 ? -len[i] * sp : len[i]; // negative: motion-blur length per m/s
        pos[i6] = head[i3]; pos[i6 + 1] = head[i3 + 1]; pos[i6 + 2] = head[i3 + 2];
        pos[i6 + 3] = head[i3] - vel[i3] / sp * L; pos[i6 + 4] = head[i3 + 1] - vel[i3 + 1] / sp * L; pos[i6 + 5] = head[i3 + 2] - vel[i3 + 2] / sp * L;
        const f = life[i] / maxLife[i];
        const b = additive ? f * f : Math.min(1, f * 3);
        col[i6] = color[0] * b; col[i6 + 1] = color[1] * b; col[i6 + 2] = color[2] * b;
        const bt = additive ? b * 0.35 : b;
        col[i6 + 3] = color[0] * bt; col[i6 + 4] = color[1] * bt; col[i6 + 5] = color[2] * bt;
      }
      aPos.needsUpdate = true; aCol.needsUpdate = true;
    }
    function clear() { life.fill(0); col.fill(0); alive = 0; aCol.needsUpdate = true; }
    return { spawn, update, clear };
  }

  // ---- build everything ---------------------------------------------------------------------
  const softTex = makeSoftSprite();
  const holes = makeDecalLayer({ map: makeHoleAtlas(), cols: 2, rows: 2, capacity: T.holeCapacity, roughness: 0.95, offset: -4, renderOrder: 3 });
  const bloodDecals = makeDecalLayer({ map: makeBloodAtlas(), cols: 4, rows: 2, capacity: T.bloodDecalCapacity, roughness: 0.32, offset: -3, renderOrder: 2 });
  const pools = makeDecalLayer({ map: makePoolAtlas(), cols: 2, rows: 2, capacity: T.poolCapacity, roughness: 0.16, offset: -2, renderOrder: 1 });

  const dust = makePoints(T.dustCapacity, { map: softTex, renderOrder: 7 });
  const debris = makePoints(T.debrisCapacity, { map: softTex, renderOrder: 6 });
  const mist = makePoints(T.mistCapacity, { map: softTex, renderOrder: 6 });
  const drops = makePoints(T.dropCapacity, { map: softTex, renderOrder: 6 });
  const sparks = makeStreaks(T.sparkCapacity, { additive: true, color: COL.spark, fog: false });
  const splinters = makeStreaks(T.splinterCapacity, { additive: false, color: COL.splinter });

  // pool growth state
  const poolState = Array.from({ length: T.poolCapacity }, () => ({ active: false, age: 0, target: 1, rot: 0, pos: new THREE.Vector3() }));

  // delayed splatter queue (spray travel time to the wall)
  const pending = Array.from({ length: 24 }, () => ({ active: false, t: 0, pos: new THREE.Vector3(), normal: new THREE.Vector3(), size: 1, rot: 0, cell: 0, bright: 1 }));
  function queueSplat(pos, normal, size, delay, cell) {
    for (const p of pending) {
      if (p.active) continue;
      p.active = true; p.t = delay; p.pos.copy(pos); p.normal.copy(normal).normalize();
      p.size = size; p.rot = Math.random() * Math.PI * 2; p.cell = cell; p.bright = rnd(0.75, 1);
      return;
    }
    bloodDecals.add(pos, vN.copy(normal).normalize(), size, Math.random() * 6.283, cell, rnd(0.75, 1));
  }

  // muzzle flash sprites
  const flashTex = [makeFlashTex(), makeFlashTex(), makeFlashTex(), makeFlashTex()];
  const flashes = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.SpriteMaterial({ map: flashTex[0], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, color: 0xffe2b8 });
    const s = new THREE.Sprite(m); s.visible = false; s.renderOrder = 9; s.frustumCulled = false;
    scene.add(s);
    flashes.push({ sprite: s, frames: 0 });
  }
  let flashIdx = 0;
  const lights = [];
  for (let i = 0; i < T.flashLights; i++) {
    const l = new THREE.PointLight(0xffc27a, 0, T.flashDistance, 2);
    l.castShadow = false;
    scene.add(l);
    lights.push({ light: l, t: 0, peak: 0 });
  }
  let lightIdx = 0;

  // tracers
  const TRACERS = 8;
  const trPos = new Float32Array(TRACERS * 6), trCol = new Float32Array(TRACERS * 6), trFrames = new Int8Array(TRACERS);
  const trGeo = new THREE.BufferGeometry();
  const trAPos = new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage);
  const trACol = new THREE.BufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage);
  trGeo.setAttribute('position', trAPos); trGeo.setAttribute('color', trACol);
  const tracerLines = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: T.tracerOpacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  tracerLines.frustumCulled = false; tracerLines.renderOrder = 8;
  scene.add(tracerLines);
  let trIdx = 0;

  // casings
  const shellGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.019, 8, 1);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xb08a4e, metalness: 1, roughness: 0.32 });
  const shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, T.shellCapacity);
  shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shellMesh.frustumCulled = false;
  for (let i = 0; i < T.shellCapacity; i++) shellMesh.setMatrixAt(i, ZERO_M);
  scene.add(shellMesh);
  const shells = Array.from({ length: T.shellCapacity }, () => ({
    active: false, resting: false, bounces: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    q: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, ttl: 0,
  }));
  let shellIdx = 0;
  const SHELL_SCALE = new THREE.Vector3(1, 1, 1);
  const qRestX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  // ---- API ----------------------------------------------------------------------------------
  function impact(point, normal, surface) {
    if (!point) return;
    vN.copy(normal && normal.lengthSq() > 1e-8 ? normal : UP).normalize();
    const s = surface === 'metal' || surface === 'wood' ? surface : 'concrete';
    const cell = s === 'metal' ? 1 : s === 'wood' ? 2 : (Math.random() < 0.5 ? 0 : 3);
    const size = s === 'metal' ? rnd(0.03, 0.04) : s === 'wood' ? rnd(0.045, 0.06) : rnd(0.05, 0.075);
    holes.add(point, vN, size, Math.random() * 6.283, cell, rnd(0.8, 1));

    const gy = groundAt(point.x, point.z);
    const px = point.x + vN.x * 0.01, py = point.y + vN.y * 0.01, pz = point.z + vN.z * 0.01;
    const dc = s === 'wood' ? COL.dustWood : s === 'metal' ? COL.dustMetal : COL.dustConcrete;
    const nDust = s === 'metal' ? 5 : s === 'wood' ? 9 : 14;
    for (let i = 0; i < nDust; i++) {
      randUnit(vA); const sp = rnd(0.5, 2.6);
      dust.spawn(px, py, pz,
        vN.x * sp + vA.x * 0.8, vN.y * sp + vA.y * 0.8, vN.z * sp + vA.z * 0.8,
        rnd(0.02, 0.05), rnd(0.4, 0.9), dc, rnd(0.35, 0.6), 1.2, 3.5, 0.18);
    }
    // lingering puff
    const nPuff = s === 'metal' ? 1 : 3;
    for (let i = 0; i < nPuff; i++) {
      randUnit(vA); const sp = rnd(0.15, 0.4);
      dust.spawn(px, py, pz, vN.x * sp + vA.x * 0.1, vN.y * sp + vA.y * 0.1 + 0.03, vN.z * sp + vA.z * 0.1,
        rnd(0.12, 0.25), rnd(1.6, 3.0), dc, rnd(0.14, 0.24), -0.03, 1.2, rnd(0.12, 0.28));
    }
    if (s === 'concrete' || s === 'wood') {
      const cc = s === 'wood' ? COL.chipWood : COL.chipConcrete;
      const nChip = 4 + (Math.random() * 5 | 0);
      for (let i = 0; i < nChip; i++) {
        randUnit(vA); const sp = rnd(1, 4);
        debris.spawn(px, py, pz, vN.x * sp + vA.x * 1.5, vN.y * sp + vA.y * 1.5 + 0.5, vN.z * sp + vA.z * 1.5,
          rnd(0.006, 0.014), rnd(1.0, 2.0), cc, 1, 9.8, 0.3, 0, LAND_STOP, gy + 0.004);
      }
    }
    if (s === 'metal') {
      const n = 8 + (Math.random() * 9 | 0);
      for (let i = 0; i < n; i++) {
        randUnit(vA); const sp = rnd(1.5, 5);
        sparks.spawn(px, py, pz, vN.x * sp + vA.x * 3, vN.y * sp + vA.y * 3, vN.z * sp + vA.z * 3,
          rnd(0.12, 0.38), -0.014, 9.8, gy + 0.005);
      }
    } else if (s === 'wood') {
      const n = 5 + (Math.random() * 5 | 0);
      for (let i = 0; i < n; i++) {
        randUnit(vA); const sp = rnd(1, 3.5);
        splinters.spawn(px, py, pz, vN.x * sp + vA.x * 1.5, vN.y * sp + vA.y * 1.5, vN.z * sp + vA.z * 1.5,
          rnd(0.6, 1.4), rnd(0.015, 0.035), 9.8, gy + 0.003);
      }
    }
  }

  function onDropLand(x, y, z) {
    if (Math.random() > T.dropSpotChance) return;
    vB.set(x, y, z);
    bloodDecals.add(vB, UP, rnd(0.06, 0.16), Math.random() * 6.283, 7, rnd(0.7, 1));
  }

  function blood(point, dir) {
    if (!point) return;
    vB.copy(dir && dir.lengthSq() > 1e-8 ? dir : ZAX).normalize();
    const d = vB, px = point.x, py = point.y, pz = point.z;
    // exit mist
    for (let i = 0; i < 18; i++) {
      randUnit(vA); const sp = rnd(0.8, 3.2), r = rnd(0.2, 1.2);
      mist.spawn(px, py, pz, d.x * sp + vA.x * r, d.y * sp + vA.y * r, d.z * sp + vA.z * r,
        rnd(0.03, 0.07), rnd(0.25, 0.6), COL.mist, rnd(0.4, 0.6), 1.2, 4.5, rnd(0.08, 0.2));
    }
    // small back spray toward the shooter
    for (let i = 0; i < 6; i++) {
      randUnit(vA); const sp = rnd(0.3, 1.2);
      mist.spawn(px, py, pz, -d.x * sp + vA.x * 0.5, -d.y * sp + vA.y * 0.5, -d.z * sp + vA.z * 0.5,
        rnd(0.02, 0.05), rnd(0.2, 0.4), COL.mist, 0.4, 1.0, 5, 0.1);
    }
    // heavy droplets under gravity, leave spots on the floor
    const gy = groundAt(px, pz) + 0.002;
    for (let i = 0; i < 14; i++) {
      randUnit(vA); const sp = rnd(1.5, 4.5);
      drops.spawn(px, py, pz, d.x * sp + vA.x * 1.2, d.y * sp + vA.y * 1.2 + rnd(0, 1.2), d.z * sp + vA.z * 1.2,
        rnd(0.008, 0.02), 2.5, COL.drop, 0.95, 9.8, 0.3, 0, LAND_SPOT, gy);
    }
    // splatter on whatever is behind the target
    vC.set(px, py, pz).addScaledVector(d, 0.02);
    const hit = ctx.combat?.worldHit?.(vC, d, T.bloodRay);
    if (hit && hit.point && hit.normal) {
      const size = clamp(rnd(0.45, 0.9) * (0.7 + hit.distance * 0.3), 0.3, 1.8);
      vN.copy(hit.normal);
      if (vN.dot(d) > 0) vN.negate(); // back-face hit on double-sided geometry: face the spray
      queueSplat(hit.point, vN, size, hit.distance / T.bloodSpeed, (Math.random() * 7) | 0);
    } else if (Math.random() < 0.7) {
      const fwd = rnd(0.6, 1.6);
      vA.set(px + d.x * fwd, 0, pz + d.z * fwd); vA.y = groundAt(vA.x, vA.z);
      queueSplat(vA, UP, rnd(0.35, 0.7), 0.25, (Math.random() * 7) | 0);
    }
  }

  function bloodPool(position) {
    if (!position) return;
    const a = Math.random() * 6.283, off = rnd(0.05, 0.3);
    vA.set(position.x + Math.cos(a) * off, 0, position.z + Math.sin(a) * off);
    vA.y = groundAt(vA.x, vA.z);
    const rot = Math.random() * 6.283;
    const i = pools.add(vA, UP, 0.05, rot, (Math.random() * 4) | 0, rnd(0.85, 1));
    const st = poolState[i];
    st.active = true; st.age = 0; st.target = rnd(0.9, 1.5); st.rot = rot; st.pos.copy(vA);
  }

  function muzzleFlash(position, dir) {
    if (!position) return;
    vB.copy(dir && dir.lengthSq() > 1e-8 ? dir : ZAX).normalize();
    const f = flashes[flashIdx]; flashIdx = (flashIdx + 1) % flashes.length;
    f.sprite.position.copy(position).addScaledVector(vB, 0.04);
    const sc = rnd(0.18, 0.32);
    f.sprite.scale.set(sc, sc, 1);
    f.sprite.material.map = flashTex[(Math.random() * flashTex.length) | 0];
    f.sprite.material.rotation = Math.random() * 6.283;
    f.sprite.material.opacity = rnd(0.75, 1);
    f.sprite.visible = true;
    f.frames = Math.random() < 0.5 ? 1 : 2;
    const L = lights[lightIdx]; lightIdx = (lightIdx + 1) % lights.length;
    L.light.position.copy(position).addScaledVector(vB, 0.1);
    L.peak = T.flashIntensity * rnd(0.8, 1.2); L.t = T.flashSeconds; L.light.intensity = L.peak;
    // smoke wisp
    for (let i = 0; i < 3; i++) {
      randUnit(vA); const sp = rnd(0.3, 0.8);
      dust.spawn(position.x + vB.x * 0.05, position.y + vB.y * 0.05, position.z + vB.z * 0.05,
        vB.x * sp + vA.x * 0.08, vB.y * sp + vA.y * 0.08 + 0.12, vB.z * sp + vA.z * 0.08,
        rnd(0.03, 0.06), rnd(0.8, 1.4), COL.smoke, rnd(0.1, 0.18), -0.15, 2.0, rnd(0.18, 0.3));
    }
  }

  function tracer(from, to) {
    if (!from || !to) return;
    vA.subVectors(to, from);
    const len = vA.length();
    if (len < 3) return;
    vA.multiplyScalar(1 / len);
    const i = trIdx; trIdx = (trIdx + 1) % TRACERS;
    const s = rnd(1.5, 3), e = Math.min(len, s + rnd(4, 12));
    const i6 = i * 6;
    trPos[i6] = from.x + vA.x * s; trPos[i6 + 1] = from.y + vA.y * s; trPos[i6 + 2] = from.z + vA.z * s;
    trPos[i6 + 3] = from.x + vA.x * e; trPos[i6 + 4] = from.y + vA.y * e; trPos[i6 + 5] = from.z + vA.z * e;
    const b = rnd(0.5, 1);
    for (let k = 0; k < 2; k++) { trCol[i6 + k * 3] = COL.tracer[0] * b; trCol[i6 + k * 3 + 1] = COL.tracer[1] * b; trCol[i6 + k * 3 + 2] = COL.tracer[2] * b; }
    trFrames[i] = Math.random() < 0.5 ? 1 : 2;
    trAPos.needsUpdate = true; trACol.needsUpdate = true;
  }

  function shell(position, dir) {
    if (!position) return;
    const sh = shells[shellIdx]; shellIdx = (shellIdx + 1) % shells.length;
    vB.copy(dir && dir.lengthSq() > 1e-8 ? dir : UP).normalize();
    randUnit(vA);
    sh.active = true; sh.resting = false; sh.bounces = 0; sh.ttl = 6;
    sh.pos.copy(position);
    sh.vel.copy(vB).multiplyScalar(rnd(1.4, 2.4)).addScaledVector(vA, 0.35); sh.vel.y += rnd(0.6, 1.2);
    sh.axis.copy(randUnit(vA)); sh.spin = rnd(15, 35);
    sh.q.setFromAxisAngle(randUnit(vC), Math.random() * 6.283);
  }

  function updateShells(dt) {
    let dirty = false;
    for (let i = 0; i < shells.length; i++) {
      const sh = shells[i];
      if (!sh.active || sh.resting) continue;
      dirty = true;
      sh.vel.y -= 9.8 * dt;
      sh.pos.addScaledVector(sh.vel, dt);
      qA.setFromAxisAngle(sh.axis, sh.spin * dt);
      sh.q.premultiply(qA);
      const gy = groundAt(sh.pos.x, sh.pos.z) + 0.0045;
      if (sh.pos.y <= gy && sh.vel.y < 0) {
        sh.pos.y = gy;
        sh.bounces++;
        if (sh.bounces === 1) {
          ctx.audio?.play?.('shell', { position: sh.pos, volume: clamp(-sh.vel.y * 0.25, 0.2, 0.8) });
        }
        sh.vel.y = -sh.vel.y * 0.32; sh.vel.x *= 0.55; sh.vel.z *= 0.55; sh.spin *= 0.5;
        if (sh.bounces >= 3 || sh.vel.y < 0.35) {
          sh.resting = true;
          qB.setFromAxisAngle(UP, Math.random() * 6.283);
          sh.q.multiplyQuaternions(qB, qRestX);
        }
      }
      if ((sh.ttl -= dt) <= 0 && !sh.resting) { sh.resting = true; }
      mA.compose(sh.pos, sh.q, SHELL_SCALE);
      shellMesh.setMatrixAt(i, mA);
    }
    if (dirty) shellMesh.instanceMatrix.needsUpdate = true;
  }

  function update(dt) {
    const cam = ctx.camera;
    if (cam) {
      const h = ctx.renderer?.domElement?.height || innerHeight;
      const sc = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));
      for (let i = 0; i < pointSystems.length; i++) pointSystems[i].uniforms.uScale.value = sc;
    }
    dust.update(dt); debris.update(dt); mist.update(dt); drops.update(dt, onDropLand);
    sparks.update(dt); splinters.update(dt);

    for (const p of pending) {
      if (!p.active) continue;
      if ((p.t -= dt) <= 0) { p.active = false; bloodDecals.add(p.pos, p.normal, p.size, p.rot, p.cell, p.bright); }
    }
    for (let i = 0; i < poolState.length; i++) {
      const st = poolState[i];
      if (!st.active) continue;
      st.age += dt;
      const k = Math.min(1, st.age / T.poolGrowSeconds);
      const s = st.target * (0.08 + 0.92 * (1 - Math.pow(1 - k, 2.2)));
      pools.setTransform(i, st.pos, UP, s, st.rot, 0.002);
      if (k >= 1) st.active = false;
    }
    for (const f of flashes) {
      if (!f.sprite.visible) continue;
      if (f.frames-- <= 0) f.sprite.visible = false;
    }
    for (const L of lights) {
      if (L.t <= 0) continue;
      L.t -= dt;
      const k = Math.max(0, L.t / T.flashSeconds);
      L.light.intensity = L.peak * k * k;
    }
    let trDirty = false;
    for (let i = 0; i < TRACERS; i++) {
      if (trFrames[i] <= 0) continue;
      if (--trFrames[i] <= 0) { const i6 = i * 6; for (let k = 0; k < 6; k++) trCol[i6 + k] = 0; trDirty = true; }
    }
    if (trDirty) trACol.needsUpdate = true;
    updateShells(dt);
  }

  function reset() {
    holes.clear(); bloodDecals.clear(); pools.clear();
    for (const st of poolState) st.active = false;
    for (const p of pending) p.active = false;
    dust.clear(); debris.clear(); mist.clear(); drops.clear(); sparks.clear(); splinters.clear();
    for (const f of flashes) { f.sprite.visible = false; f.frames = 0; }
    for (const L of lights) { L.t = 0; L.light.intensity = 0; }
    trFrames.fill(0); trCol.fill(0); trACol.needsUpdate = true;
    for (let i = 0; i < shells.length; i++) { shells[i].active = false; shellMesh.setMatrixAt(i, ZERO_M); }
    shellMesh.instanceMatrix.needsUpdate = true;
  }

  return { impact, blood, bloodPool, muzzleFlash, tracer, shell, update, reset, tuning: T };
}
