// Weapon / impact effects (workstream C). Pooled and allocation-free, 4 draw calls at most:
//   decals  — ONE instanced quad mesh, multiply-blended, procedural atlas (bullet holes per surface, blood)
//   debris  — ONE instanced box mesh: chips, sparks, glass shards, casings, blood droplets, powder, tracers
//   puffs   — ONE instanced camera-facing quad mesh: dust, white powder ("bricks" in the drug depot), blood mist
//   muzzle  — ONE small additive star in the view-model scene (only visible for the flash frames)
// Lighting: debris and puffs sample the baked probe volume like every dynamic object (+ flashlight / muzzle).
// API (CONTRACT §4): impact(res), blood(point, dir, amount), muzzle(...); plus casing(), tracer(), glass shards.
import * as THREE from 'three';
import { U } from '../render/materials.js';

const DRUG_ZONES = new Set(['packerei', 'labor', 'lager_w', 'geld']);
const MAX_DECALS = 192, MAX_DEBRIS = 128, MAX_PUFFS = 40;
// decal atlas cells (4 x 2 of 128 px)
const CELL = { concrete: 0, metal: 1, wood: 2, cardboard: 3, plaster: 0, tile: 0, plastic: 2, dirt: 0, rubber: 2, fabric: 2, glass: 1, blood_wall: 4, blood_floor: 5, blood_drip: 6, powder: 7 };

// shared shader bits (same light model as materials.js: probe volume + flashlight + muzzle, exposed HDR)
const LIGHT = /* glsl */`
uniform sampler3D uProbeL0, uProbeDirSun, uProbeArt;
uniform vec3 uProbeOrigin, uProbeInvSize, uSunDir, uSunColor;
uniform float uProbeArtLevel;
uniform vec3 uFlashPos, uFlashDir, uFlashColor, uMuzzlePos, uMuzzleColor;
uniform vec2 uFlashCone;
uniform float uFlashRange;
vec3 dec(vec4 c) { return c.rgb * c.a * 16.0; }
vec3 probeLight(vec3 P, vec3 N) {
  vec3 uvw = (P - uProbeOrigin) * uProbeInvSize;
  vec3 l0 = dec(texture(uProbeL0, uvw));
  vec4 ds = texture(uProbeDirSun, uvw);
  vec3 pd = ds.xyz * 2.0 - 1.0;
  vec3 art = dec(texture(uProbeArt, uvw)) * uProbeArtLevel;
  return l0 * max(0.15, 1.0 + dot(pd, N)) + art + uSunColor * (ds.w * max(dot(N, uSunDir), 0.0));
}
vec3 dynL(vec3 P, vec3 N) {
  vec3 L = uFlashPos - P; float d2 = max(dot(L, L), 1e-4); float d = sqrt(d2); L /= d;
  float cd = dot(-L, uFlashDir);
  float spot = smoothstep(uFlashCone.x, uFlashCone.y, cd);
  float att = spot / (0.35 + d2 * 0.09) * clamp(1.0 - d / uFlashRange, 0.0, 1.0);
  vec3 c = uFlashColor * (att * max(dot(N, L), 0.0));
  vec3 M = uMuzzlePos - P; float m2 = max(dot(M, M), 1e-3);
  c += uMuzzleColor * (max(dot(N, M * inversesqrt(m2)), 0.0) / (0.2 + m2));
  return c;
}`;

function makeAtlas() {
  const W = 512, H = 256, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * 128 + 64, Math.floor(i / 4) * 128 + 64); fn(); g.restore(); };
  const radial = (r0, r1, c0, c1) => { const gr = g.createRadialGradient(0, 0, r0, 0, 0, r1); gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr; };
  const blob = (r, n, jitter) => { g.beginPath(); for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2, rr = r * (1 - jitter + rnd() * jitter * 2); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); };
  // 0 concrete/plaster: chipped crater + dark hole + hairline cracks
  cell(0, () => {
    g.fillStyle = radial(6, 46, 'rgba(120,118,112,1)', 'rgba(255,255,255,0)'); blob(46, 18, 0.35); g.fill();
    g.fillStyle = 'rgb(70,68,64)'; blob(20, 12, 0.3); g.fill();
    g.fillStyle = 'rgb(12,12,12)'; blob(8, 10, 0.2); g.fill();
    g.strokeStyle = 'rgba(90,88,84,0.8)'; g.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) { const a = rnd() * 6.28; g.beginPath(); g.moveTo(Math.cos(a) * 12, Math.sin(a) * 12); g.lineTo(Math.cos(a + 0.2) * (30 + rnd() * 25), Math.sin(a + 0.2) * (30 + rnd() * 25)); g.stroke(); }
  });
  // 1 metal: clean dark hole, bright scuffed ring (multiply can't brighten: lighter grey ring)
  cell(1, () => {
    g.fillStyle = radial(8, 30, 'rgba(150,150,150,1)', 'rgba(255,255,255,0)'); g.beginPath(); g.arc(0, 0, 30, 0, 7); g.fill();
    g.fillStyle = 'rgb(40,38,36)'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
    g.fillStyle = 'rgb(5,5,5)'; g.beginPath(); g.arc(0, 0, 6.5, 0, 7); g.fill();
  });
  // 2 wood / plastic: splintered hole
  cell(2, () => {
    g.fillStyle = radial(4, 40, 'rgba(110,80,55,1)', 'rgba(255,255,255,0)'); blob(40, 10, 0.5); g.fill();
    g.fillStyle = 'rgb(25,18,12)'; blob(9, 8, 0.3); g.fill();
  });
  // 3 cardboard: torn hole
  cell(3, () => {
    g.fillStyle = 'rgba(140,110,80,1)'; blob(16, 9, 0.45); g.fill();
    g.fillStyle = 'rgb(20,16,12)'; blob(8, 8, 0.4); g.fill();
  });
  // 4 blood on a wall: spatter with streaks
  cell(4, () => {
    g.fillStyle = 'rgb(105,18,16)'; blob(26, 22, 0.45); g.fill();
    for (let k = 0; k < 26; k++) { const a = rnd() * 6.28, r = 22 + rnd() * 36, s = 1 + rnd() * 4; g.beginPath(); g.ellipse(Math.cos(a) * r, Math.sin(a) * r, s * 1.6, s, a, 0, 7); g.fill(); }
    g.fillStyle = 'rgb(70,10,10)'; blob(14, 12, 0.3); g.fill();
  });
  // 5 blood pool on the floor
  cell(5, () => { g.fillStyle = 'rgb(80,12,12)'; blob(48, 26, 0.18); g.fill(); g.fillStyle = 'rgb(55,8,8)'; blob(30, 20, 0.2); g.fill(); });
  // 6 drips / small spots
  cell(6, () => { g.fillStyle = 'rgb(95,15,14)'; for (let k = 0; k < 14; k++) { g.beginPath(); g.arc((rnd() - 0.5) * 90, (rnd() - 0.5) * 90, 2 + rnd() * 6, 0, 7); g.fill(); } });
  // 7 powder residue (barely darkening) — the white puff is in the air, not on the wall
  cell(7, () => { g.fillStyle = radial(2, 50, 'rgba(225,225,222,1)', 'rgba(255,255,255,0)'); g.beginPath(); g.arc(0, 0, 50, 0, 7); g.fill(); });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace; // multiply factors, linear
  t.generateMipmaps = true; t.anisotropy = 4;
  return t;
}

export function createFx(ctx) {
  const fx = { id: 'fx', order: ctx.ORDER.fx, stats: { decals: 0, debris: 0, puffs: 0 } };
  let decals, debris, puffs, flash, atlas;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), nv = new THREE.Vector3();
  const Zp = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(), col = new THREE.Color();
  const hitTmp = { hit: false, t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: '', kind: '', id: '', box: -1, zone: -1, owner: null };
  const o3 = { x: 0, y: 0, z: 0 }, d3 = { x: 0, y: 0, z: 0 };
  const casingEvt = { x: 0, y: 0, z: 0, surface: 'concrete', speed: 0 };

  // ---------------------------------------------------------------- pools (struct of arrays)
  const D = { // debris
    n: 0, px: new Float32Array(MAX_DEBRIS), py: new Float32Array(MAX_DEBRIS), pz: new Float32Array(MAX_DEBRIS),
    vx: new Float32Array(MAX_DEBRIS), vy: new Float32Array(MAX_DEBRIS), vz: new Float32Array(MAX_DEBRIS),
    q: new Float32Array(MAX_DEBRIS * 4), sp: new Float32Array(MAX_DEBRIS * 4), // orientation, spin axis + rate
    sx: new Float32Array(MAX_DEBRIS), sy: new Float32Array(MAX_DEBRIS), sz: new Float32Array(MAX_DEBRIS),
    life: new Float32Array(MAX_DEBRIS), age: new Float32Array(MAX_DEBRIS), floor: new Float32Array(MAX_DEBRIS),
    kind: new Uint8Array(MAX_DEBRIS), emit: new Float32Array(MAX_DEBRIS), cr: new Float32Array(MAX_DEBRIS), cg: new Float32Array(MAX_DEBRIS), cb: new Float32Array(MAX_DEBRIS),
    bounced: new Uint8Array(MAX_DEBRIS),
  };
  const K = { chip: 0, spark: 1, shard: 2, casing: 3, drop: 4, tracer: 5, grain: 6 };
  const Pf = { // puffs
    n: 0, px: new Float32Array(MAX_PUFFS), py: new Float32Array(MAX_PUFFS), pz: new Float32Array(MAX_PUFFS),
    vx: new Float32Array(MAX_PUFFS), vy: new Float32Array(MAX_PUFFS), vz: new Float32Array(MAX_PUFFS),
    s0: new Float32Array(MAX_PUFFS), s1: new Float32Array(MAX_PUFFS), a0: new Float32Array(MAX_PUFFS),
    life: new Float32Array(MAX_PUFFS), age: new Float32Array(MAX_PUFFS), cr: new Float32Array(MAX_PUFFS), cg: new Float32Array(MAX_PUFFS), cb: new Float32Array(MAX_PUFFS),
    drag: new Float32Array(MAX_PUFFS),
  };
  let nDecal = 0, decalCount = 0;

  function debrisMaterial() {
    return new THREE.ShaderMaterial({
      name: 'S9FxDebris',
      uniforms: { ...U },
      vertexShader: /* glsl */`
        ${LIGHT}
        attribute float aEmit;
        varying vec3 vC; varying float vDist;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec3 N = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vec3 c = instanceColor;
          vC = aEmit > 0.0 ? c * aEmit : c * (probeLight(wp.xyz, N) + dynL(wp.xyz, N));
          vec4 mv = viewMatrix * wp; vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uExposure, uFogDensity; uniform vec3 uFogColor;
        varying vec3 vC; varying float vDist;
        void main() { gl_FragColor = vec4(mix(uFogColor, vC, exp(-uFogDensity * vDist)) * uExposure, 1.0); }`,
    });
  }
  function puffMaterial() {
    return new THREE.ShaderMaterial({
      name: 'S9FxPuff', transparent: true, depthWrite: false,
      uniforms: { ...U },
      vertexShader: /* glsl */`
        ${LIGHT}
        attribute float aAlpha;
        varying vec3 vC; varying float vA; varying vec2 vUv; varying float vDist;
        void main() {
          vec3 c0 = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
          float s = length(instanceMatrix[0].xyz);
          vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 u = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = c0 + (r * position.x + u * position.y) * s;
          vec3 N = normalize(cameraPosition - c0);
          vC = instanceColor * (probeLight(c0, vec3(0.0, 1.0, 0.0)) * 0.7 + probeLight(c0, N) * 0.3 + dynL(c0, N) * 0.6);
          vA = aAlpha; vUv = uv;
          vec4 mv = viewMatrix * vec4(wp, 1.0); vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uExposure, uFogDensity; uniform vec3 uFogColor;
        varying vec3 vC; varying float vA; varying vec2 vUv; varying float vDist;
        float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float n = h(floor(vUv * 9.0)) * 0.25 + h(floor(vUv * 23.0)) * 0.15;
          float a = smoothstep(1.0, 0.25, r + n * 0.6) * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(uFogColor, vC, exp(-uFogDensity * vDist)) * uExposure, a);
        }`,
    });
  }
  function decalMaterial(map) {
    return new THREE.ShaderMaterial({
      name: 'S9FxDecal', transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { uMap: { value: map } },
      vertexShader: /* glsl */`
        attribute float aCell; attribute float aFade;
        varying vec2 vUv; varying float vFade;
        void main() {
          vec2 cell = vec2(mod(aCell, 4.0), floor(aCell / 4.0));
          vUv = (cell + uv) / vec2(4.0, 2.0);
          vUv.y = 1.0 - ((cell.y + (1.0 - uv.y)) / 2.0);
          vFade = aFade;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; varying vec2 vUv; varying float vFade;
        void main() { vec3 m = texture(uMap, vUv).rgb; gl_FragColor = vec4(mix(vec3(1.0), m, vFade), 1.0); }`,
    });
  }
  function flashMaterial() {
    return new THREE.ShaderMaterial({
      name: 'S9FxMuzzle', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uExposure: U.uExposure, uI: { value: 1 }, uSeed: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */`
        uniform float uExposure, uI, uSeed; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float a = atan(p.y, p.x), r = length(p);
          float star = pow(abs(cos(a * 2.5 + uSeed)), 6.0) * 0.6 + 0.4;
          float core = smoothstep(1.0, 0.0, r / (0.35 + 0.65 * star));
          vec3 c = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.7), core * core) * core * core * 7.0 * uI;
          gl_FragColor = vec4(c * max(uExposure, 0.25), 1.0);
        }`,
    });
  }

  fx.init = () => {
    const scene = ctx.render.scene;
    atlas = makeAtlas();
    ctx.render.trackTexture('fx-decals', 512 * 256 * 4 * 1.33);
    const dg = new THREE.PlaneGeometry(1, 1);
    dg.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS), 1));
    dg.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS), 1));
    decals = new THREE.InstancedMesh(dg, decalMaterial(atlas), MAX_DECALS);
    decals.count = 0; decals.frustumCulled = false; decals.renderOrder = 5; decals.visible = false;
    decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(decals);
    const bg = new THREE.BoxGeometry(1, 1, 1);
    bg.setAttribute('aEmit', new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS), 1).setUsage(THREE.DynamicDrawUsage));
    debris = new THREE.InstancedMesh(bg, debrisMaterial(), MAX_DEBRIS);
    debris.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    debris.count = 0; debris.frustumCulled = false; debris.visible = false;
    scene.add(debris);
    const pg = new THREE.PlaneGeometry(1, 1);
    pg.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS), 1).setUsage(THREE.DynamicDrawUsage));
    puffs = new THREE.InstancedMesh(pg, puffMaterial(), MAX_PUFFS);
    puffs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    puffs.count = 0; puffs.frustumCulled = false; puffs.renderOrder = 6; puffs.visible = false;
    scene.add(puffs);
    // muzzle flash: two crossed quads along the bore + one facing back at the camera
    const fg = new THREE.BufferGeometry();
    const P = [], UV = [], I = [];
    const quad = (a, b, c, d) => { const o = P.length / 3; P.push(...a, ...b, ...c, ...d); UV.push(0, 0, 1, 0, 1, 1, 0, 1); I.push(o, o + 1, o + 2, o, o + 2, o + 3); };
    quad([-0.05, 0, 0], [0.05, 0, 0], [0.05, 0, 0.16], [-0.05, 0, 0.16]);
    quad([0, -0.05, 0], [0, 0.05, 0], [0, 0.05, 0.16], [0, -0.05, 0.16]);
    quad([-0.06, -0.06, 0.01], [0.06, -0.06, 0.01], [0.06, 0.06, 0.01], [-0.06, 0.06, 0.01]);
    fg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    fg.setIndex(I);
    flash = new THREE.Mesh(fg, flashMaterial());
    flash.frustumCulled = false; flash.visible = false; flash.renderOrder = 10;
    ctx.render.vmScene.add(flash);
    fx.flashMesh = flash;
    // gameplay hooks
    ctx.events.on('shot', (r) => { if (r.hit && r.kind !== 'enemy' && r.kind !== 'player') fx.impact(r); });
    ctx.events.on('hit', (r) => { if (r.kind === 'enemy') fx.blood(r.point, r.dir, r.part === 'head' ? 1.4 : 1); });
    ctx.events.on('glass:break', (e) => fx.glass(e.point, e.pane));
  };

  // ---------------------------------------------------------------- spawning
  function addDecal(cell, point, normal, size, rot, lift = 0.003) {
    const i = nDecal++ % MAX_DECALS;
    nv.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(Zp, nv);
    q2.setFromAxisAngle(Zp, rot); q.multiply(q2);
    pv.set(point.x, point.y, point.z).addScaledVector(nv, lift + (i % 7) * 0.0002);
    sc.set(size, size, 1);
    m4.compose(pv, q, sc);
    decals.setMatrixAt(i, m4);
    decals.geometry.attributes.aCell.array[i] = cell;
    decals.geometry.attributes.aFade.array[i] = 1;
    decals.instanceMatrix.needsUpdate = true;
    decals.geometry.attributes.aCell.needsUpdate = true;
    decals.geometry.attributes.aFade.needsUpdate = true;
    decalCount = Math.min(MAX_DECALS, decalCount + 1);
    decals.count = decalCount; decals.visible = true;
  }
  function addDebris(kind, x, y, z, vx, vy, vz, size, life, r, g, b, emit = 0) {
    if (D.n >= MAX_DEBRIS) return -1;
    const i = D.n++;
    D.px[i] = x; D.py[i] = y; D.pz[i] = z; D.vx[i] = vx; D.vy[i] = vy; D.vz[i] = vz;
    D.kind[i] = kind; D.life[i] = life; D.age[i] = 0; D.emit[i] = emit; D.bounced[i] = 0;
    D.cr[i] = r; D.cg[i] = g; D.cb[i] = b;
    D.sx[i] = size; D.sy[i] = size * (kind === K.shard ? 0.15 : kind === K.chip ? 0.6 + Math.random() * 0.4 : 1); D.sz[i] = size * (kind === K.chip ? 0.5 + Math.random() * 0.8 : 1);
    q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    q.toArray(D.q, i * 4);
    ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    D.sp[i * 4] = ax.x; D.sp[i * 4 + 1] = ax.y; D.sp[i * 4 + 2] = ax.z; D.sp[i * 4 + 3] = (kind === K.casing ? 25 : 12) * (0.5 + Math.random());
    const g0 = ctx.world.groundHeight(x, z, y + 0.05, 0);
    D.floor[i] = g0 > -Infinity ? g0 : y - 50;
    return i;
  }
  function addPuff(x, y, z, vx, vy, vz, s0, s1, a0, life, r, g, b, drag = 2) {
    let i;
    if (Pf.n < MAX_PUFFS) i = Pf.n++;
    else { i = 0; let best = -1; for (let k = 0; k < Pf.n; k++) { const f = Pf.age[k] / Pf.life[k]; if (f > best) { best = f; i = k; } } }
    Pf.px[i] = x; Pf.py[i] = y; Pf.pz[i] = z; Pf.vx[i] = vx; Pf.vy[i] = vy; Pf.vz[i] = vz;
    Pf.s0[i] = s0; Pf.s1[i] = s1; Pf.a0[i] = a0; Pf.life[i] = life; Pf.age[i] = 0; Pf.cr[i] = r; Pf.cg[i] = g; Pf.cb[i] = b; Pf.drag[i] = drag;
    return i;
  }
  const rs = (a) => (Math.random() - 0.5) * 2 * a;

  /** bullet impact on a surface: res { point, normal, surface, kind, id, zone, dir } */
  fx.impact = (res) => {
    const p = res.point, n = res.normal, s = res.surface || 'concrete';
    const dynamic = res.kind === 'door' || res.kind === 'dynamic';
    // reflect-ish spray direction: mostly along the normal, some back along the shot
    const ox = p.x + n.x * 0.02, oy = p.y + n.y * 0.02, oz = p.z + n.z * 0.02;
    const zoneId = res.zone >= 0 ? ctx.world.zoneId?.(res.zone) : null;
    const brick = s === 'cardboard' && (DRUG_ZONES.has(zoneId) || (typeof res.id === 'string' && res.id.startsWith('packing_table')));
    if (!dynamic && s !== 'glass') addDecal(brick ? CELL.cardboard : (CELL[s] ?? 0), p, n, s === 'metal' ? 0.045 + Math.random() * 0.015 : 0.06 + Math.random() * 0.03, Math.random() * 6.28);
    if (s === 'metal') {
      const ns = 6 + (Math.random() * 5) | 0;
      for (let k = 0; k < ns; k++) addDebris(K.spark, ox, oy, oz, n.x * 3 + rs(3.5), n.y * 3 + rs(3.5) + 1, n.z * 3 + rs(3.5), 0.006, 0.12 + Math.random() * 0.18, 1, 0.55, 0.2, 14);
      addPuff(ox, oy, oz, n.x * 0.5, n.y * 0.5 + 0.1, n.z * 0.5, 0.05, 0.25, 0.35, 0.5, 0.5, 0.5, 0.5);
    } else if (s === 'wood' || s === 'plastic' || s === 'rubber' || s === 'fabric') {
      const c = s === 'wood' ? [0.45, 0.33, 0.2] : s === 'plastic' ? [0.2, 0.3, 0.42] : [0.12, 0.11, 0.1];
      for (let k = 0; k < 6; k++) addDebris(K.chip, ox, oy, oz, n.x * 2 + rs(1.6), n.y * 2 + rs(1.6) + 1.2, n.z * 2 + rs(1.6), 0.012 + Math.random() * 0.012, 2.5, c[0], c[1], c[2]);
      addPuff(ox, oy, oz, n.x * 0.6, n.y * 0.6, n.z * 0.6, 0.06, 0.3, 0.45, 0.8, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3);
    } else if (s === 'cardboard') {
      for (let k = 0; k < 5; k++) addDebris(K.chip, ox, oy, oz, n.x * 1.6 + rs(1.4), n.y * 1.6 + rs(1.4) + 1, n.z * 1.6 + rs(1.4), 0.014 + Math.random() * 0.014, 2.5, 0.5, 0.38, 0.24);
      if (brick) {
        // drug "bricks": a burst of white powder hanging in the air, slowly sinking
        for (let k = 0; k < 3; k++) addPuff(ox + rs(0.05), oy + rs(0.05), oz + rs(0.05), n.x * (0.9 + k * 0.4) + rs(0.3), n.y * 0.5 + 0.25 + rs(0.15), n.z * (0.9 + k * 0.4) + rs(0.3), 0.1, 0.75 + k * 0.25, 0.75, 3.2 + k, 0.95, 0.95, 0.93, 1.6);
        for (let k = 0; k < 10; k++) addDebris(K.grain, ox, oy, oz, n.x * 2 + rs(1.8), n.y * 2 + rs(1.8) + 0.8, n.z * 2 + rs(1.8), 0.004, 1.5, 0.95, 0.95, 0.93);
      } else addPuff(ox, oy, oz, n.x * 0.5, n.y * 0.5, n.z * 0.5, 0.06, 0.28, 0.4, 0.7, 0.62, 0.52, 0.4);
    } else if (s === 'glass') {
      for (let k = 0; k < 6; k++) addDebris(K.shard, ox, oy, oz, n.x * 1.5 + rs(1.2), rs(1.2), n.z * 1.5 + rs(1.2), 0.02 + Math.random() * 0.02, 2, 0.75, 0.85, 0.88);
    } else {
      // concrete / plaster / tile / dirt: chips + dust
      const c = s === 'plaster' ? [0.75, 0.74, 0.7] : s === 'dirt' ? [0.3, 0.26, 0.2] : [0.5, 0.49, 0.46];
      for (let k = 0; k < 5; k++) addDebris(K.chip, ox, oy, oz, n.x * 2.5 + rs(2), n.y * 2.5 + rs(2) + 1, n.z * 2.5 + rs(2), 0.008 + Math.random() * 0.01, 2.2, c[0], c[1], c[2]);
      addPuff(ox, oy, oz, n.x * 0.8 + rs(0.2), n.y * 0.8 + 0.15, n.z * 0.8 + rs(0.2), 0.06, 0.4, 0.55, 1.1, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2);
      addPuff(ox, oy, oz, n.x * 0.3, n.y * 0.3 + 0.05, n.z * 0.3, 0.04, 0.22, 0.4, 0.6, c[0], c[1], c[2], 3);
    }
  };

  /** blood on an enemy hit: spray mist + droplets, spatter on the wall behind (≤ 2.5 m) and drops on the floor */
  fx.blood = (point, dir, amount = 1) => {
    const x = point.x, y = point.y, z = point.z;
    addPuff(x, y, z, dir.x * 0.9, dir.y * 0.9 + 0.1, dir.z * 0.9, 0.05, 0.35 * amount, 0.7, 0.45, 0.32, 0.03, 0.03, 4);
    addPuff(x, y, z, -dir.x * 0.3, 0.05, -dir.z * 0.3, 0.04, 0.18, 0.45, 0.3, 0.3, 0.03, 0.03, 4);
    for (let k = 0; k < 8 * amount; k++) addDebris(K.drop, x, y, z, dir.x * 3 + rs(1.3), dir.y * 3 + rs(1.3) + 0.6, dir.z * 3 + rs(1.3), 0.006 + Math.random() * 0.006, 1.5, 0.28, 0.02, 0.02);
    // wall behind the target
    o3.x = x + dir.x * 0.25; o3.y = y + dir.y * 0.25; o3.z = z + dir.z * 0.25; d3.x = dir.x; d3.y = dir.y; d3.z = dir.z;
    if (ctx.world.worldHit(o3, d3, 2.5, hitTmp) && hitTmp.kind === 'static') addDecal(CELL.blood_wall, hitTmp.point, hitTmp.normal, (0.35 + Math.random() * 0.3) * amount * (1 - hitTmp.t / 4), Math.random() * 6.28);
    // floor
    const fx0 = x + dir.x * 0.5 + rs(0.15), fz0 = z + dir.z * 0.5 + rs(0.15);
    const g = ctx.world.groundHeight(fx0, fz0, y, 0);
    if (g > -Infinity && y - g < 2.2) addDecal(Math.random() < 0.5 ? CELL.blood_drip : CELL.blood_floor, { x: fx0, y: g, z: fz0 }, UPN, (0.25 + Math.random() * 0.35) * amount, Math.random() * 6.28, 0.004);
  };
  const UPN = { x: 0, y: 1, z: 0 };

  /** breakable glass shattered: shards fall from the pane around the bullet */
  fx.glass = (point, pane) => {
    if (!point) return;
    void pane;
    for (let k = 0; k < 24; k++) {
      const x = point.x + rs(0.35), y = point.y + rs(0.35), z = point.z + rs(0.35);
      addDebris(K.shard, x, y, z, rs(1.5), rs(0.8), rs(1.5), 0.025 + Math.random() * 0.04, 3.5, 0.72, 0.8, 0.84);
    }
  };

  /** muzzle flash in the view model (posVm/dirVm: view-model world space) */
  fx.muzzle = (posVm, dirVm) => {
    if (!flash || !posVm) return;
    flash.position.copy(posVm);
    flash.quaternion.setFromUnitVectors(Zp, dirVm);
    q2.setFromAxisAngle(Zp, Math.random() * 6.28); flash.quaternion.multiply(q2);
    const s = 0.8 + Math.random() * 0.5; flash.scale.set(s, s, s * (0.8 + Math.random() * 0.6));
    flash.material.uniforms.uSeed.value = Math.random() * 6.28;
    flash.visible = true;
    fx.flashT = 0.045;
  };
  fx.flashT = 0;

  /** spent casing from the ejection port (world-lens position), thrown to the right, up and a bit back */
  fx.casing = (port, rightDir, cam) => {
    const r = rightDir;
    const bx = cam ? -Math.sin(cam.rotation.y) * -0.4 : 0, bz = cam ? -Math.cos(cam.rotation.y) * -0.4 : 0;
    const i = addDebris(K.casing, port.x, port.y, port.z, r.x * (1.6 + Math.random()) + bx, 1.6 + Math.random() * 0.8, r.z * (1.6 + Math.random()) + bz, 0.0095, 7, 0.72, 0.52, 0.22);
    if (i >= 0) { D.sz[i] = 0.019; D.sx[i] = 0.0095; D.sy[i] = 0.0095; }
  };

  /** tracer streak from the muzzle to the impact */
  fx.tracer = (from, to) => {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz);
    if (L < 3) return;
    const v = 320;
    const i = addDebris(K.tracer, from.x + dx / L * 1.5, from.y + dy / L * 1.5, from.z + dz / L * 1.5, dx / L * v, dy / L * v, dz / L * v, 0.004, (L - 1.5) / v, 1, 0.75, 0.4, 9);
    if (i >= 0) { D.sz[i] = 0.9; }
  };

  // ---------------------------------------------------------------- simulation + upload
  function killDebris(i) {
    const j = --D.n;
    if (i === j) return;
    D.px[i] = D.px[j]; D.py[i] = D.py[j]; D.pz[i] = D.pz[j]; D.vx[i] = D.vx[j]; D.vy[i] = D.vy[j]; D.vz[i] = D.vz[j];
    for (let k = 0; k < 4; k++) { D.q[i * 4 + k] = D.q[j * 4 + k]; D.sp[i * 4 + k] = D.sp[j * 4 + k]; }
    D.sx[i] = D.sx[j]; D.sy[i] = D.sy[j]; D.sz[i] = D.sz[j]; D.life[i] = D.life[j]; D.age[i] = D.age[j]; D.floor[i] = D.floor[j];
    D.kind[i] = D.kind[j]; D.emit[i] = D.emit[j]; D.cr[i] = D.cr[j]; D.cg[i] = D.cg[j]; D.cb[i] = D.cb[j]; D.bounced[i] = D.bounced[j];
  }
  function killPuff(i) {
    const j = --Pf.n;
    if (i === j) return;
    for (const a of PUFF_KEYS) Pf[a][i] = Pf[a][j];
  }
  const PUFF_KEYS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 's0', 's1', 'a0', 'life', 'age', 'cr', 'cg', 'cb', 'drag'];

  fx.update = (dt) => {
    if (!debris) return;
    // muzzle flash: 1-2 frames
    if (fx.flashT > 0) { fx.flashT -= dt; flash.material.uniforms.uI.value = Math.max(0, fx.flashT / 0.045); if (fx.flashT <= 0) flash.visible = false; }
    const g = 9.81;
    const emitA = debris.geometry.attributes.aEmit.array, ic = debris.instanceColor.array;
    for (let i = D.n - 1; i >= 0; i--) {
      D.age[i] += dt;
      if (D.age[i] >= D.life[i]) { killDebris(i); continue; }
      const kind = D.kind[i];
      if (kind !== K.tracer) {
        const drag = kind === K.grain ? 3 : kind === K.spark ? 0.5 : 0.15;
        D.vy[i] -= g * dt * (kind === K.grain ? 0.35 : 1);
        const f = Math.exp(-drag * dt);
        D.vx[i] *= f; D.vy[i] *= f; D.vz[i] *= f;
      }
      D.px[i] += D.vx[i] * dt; D.py[i] += D.vy[i] * dt; D.pz[i] += D.vz[i] * dt;
      const fl = D.floor[i] + D.sy[i] * 0.5;
      if (D.py[i] < fl && kind !== K.tracer) {
        D.py[i] = fl;
        if (kind === K.spark || kind === K.drop || kind === K.grain) { D.life[i] = Math.min(D.life[i], D.age[i] + (kind === K.drop ? 0.02 : 0.08)); D.vx[i] = D.vy[i] = D.vz[i] = 0; }
        else {
          const sp = Math.abs(D.vy[i]);
          if (kind === K.casing && D.bounced[i] < 3 && sp > 0.4) {
            casingEvt.x = D.px[i]; casingEvt.y = D.py[i]; casingEvt.z = D.pz[i]; casingEvt.speed = sp;
            casingEvt.surface = ctx.player?.surface || 'concrete';
            ctx.events.emit('c:casing', casingEvt);
          }
          D.bounced[i]++;
          D.vy[i] = sp > 0.5 ? sp * (kind === K.casing ? 0.35 : 0.2) : 0;
          D.vx[i] *= 0.45; D.vz[i] *= 0.45;
          D.sp[i * 4 + 3] *= 0.5;
        }
      }
      // orientation
      const o = i * 4;
      if (kind === K.spark || kind === K.tracer) {
        nv.set(D.vx[i], D.vy[i], D.vz[i]);
        const sp = nv.length();
        if (sp > 1e-4) q.setFromUnitVectors(Zp, nv.multiplyScalar(1 / sp));
        sc.set(D.sx[i], D.sx[i], kind === K.spark ? Math.min(0.12, 0.01 + sp * 0.012) : D.sz[i]);
      } else {
        q.fromArray(D.q, o);
        const rate = D.sp[o + 3] * (D.py[i] <= fl + 1e-4 && Math.abs(D.vy[i]) < 0.01 ? 0 : 1);
        if (rate > 0) { ax.set(D.sp[o], D.sp[o + 1], D.sp[o + 2]); q2.setFromAxisAngle(ax, rate * dt); q.multiply(q2); q.toArray(D.q, o); }
        sc.set(D.sx[i], D.sy[i], D.sz[i]);
      }
      pv.set(D.px[i], D.py[i], D.pz[i]);
      m4.compose(pv, q, sc);
      debris.setMatrixAt(i, m4);
      // fade sparks / tracers by brightness
      const life = D.life[i], k = 1 - D.age[i] / life;
      emitA[i] = D.emit[i] > 0 ? D.emit[i] * (kind === K.tracer ? 1 : k * k) : 0;
      // casings: fade out (shrink) at the end of their life
      if (kind === K.casing && k < 0.1) { m4.compose(pv, q, sc.multiplyScalar(k / 0.1)); debris.setMatrixAt(i, m4); }
      ic[i * 3] = D.cr[i]; ic[i * 3 + 1] = D.cg[i]; ic[i * 3 + 2] = D.cb[i];
    }
    debris.count = D.n; debris.visible = D.n > 0;
    if (D.n) { debris.instanceMatrix.needsUpdate = true; debris.instanceColor.needsUpdate = true; debris.geometry.attributes.aEmit.needsUpdate = true; }
    // puffs
    const pa = puffs.geometry.attributes.aAlpha.array, pc = puffs.instanceColor.array;
    for (let i = Pf.n - 1; i >= 0; i--) {
      Pf.age[i] += dt;
      if (Pf.age[i] >= Pf.life[i]) { killPuff(i); continue; }
      const f = Math.exp(-Pf.drag[i] * dt);
      Pf.vx[i] *= f; Pf.vy[i] = Pf.vy[i] * f - 0.15 * dt; Pf.vz[i] *= f;
      Pf.px[i] += Pf.vx[i] * dt; Pf.py[i] += Pf.vy[i] * dt; Pf.pz[i] += Pf.vz[i] * dt;
      const t = Pf.age[i] / Pf.life[i];
      const s = Pf.s0[i] + (Pf.s1[i] - Pf.s0[i]) * (1 - (1 - t) * (1 - t));
      pv.set(Pf.px[i], Pf.py[i], Pf.pz[i]);
      q.identity(); sc.set(s, s, s);
      m4.compose(pv, q, sc);
      puffs.setMatrixAt(i, m4);
      pa[i] = Pf.a0[i] * (1 - t) * Math.min(1, t * 12);
      pc[i * 3] = Pf.cr[i]; pc[i * 3 + 1] = Pf.cg[i]; pc[i * 3 + 2] = Pf.cb[i];
    }
    puffs.count = Pf.n; puffs.visible = Pf.n > 0;
    if (Pf.n) { puffs.instanceMatrix.needsUpdate = true; puffs.instanceColor.needsUpdate = true; puffs.geometry.attributes.aAlpha.needsUpdate = true; }
    fx.stats.decals = decalCount; fx.stats.debris = D.n; fx.stats.puffs = Pf.n;
  };

  fx.reset = () => {
    D.n = 0; Pf.n = 0; nDecal = 0; decalCount = 0;
    if (decals) { decals.count = 0; decals.visible = false; debris.count = 0; debris.visible = false; puffs.count = 0; puffs.visible = false; flash.visible = false; }
  };
  void col; void up;
  return fx;
}
