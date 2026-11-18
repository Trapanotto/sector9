// Sky / IBL, overcast sun, practical lights (dying fluorescent tubes, one shadowed work lamp),
// fake daylight shafts and dust motes. Exposes update(dt) for flicker / sway / dust animation.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FIXTURES, WORK_LAMP, BOUNCE_LIGHTS, H } from './layout.js';
import { ASSET_BASE, makeCanvas } from './materials.js';
import { rng } from './geometry.js';

export const SUN_DIR = new THREE.Vector3(0.42, -0.72, -0.55).normalize(); // direction the light travels

async function loadSky(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  let bg = null;
  try {
    const r = await fetch(ASSET_BASE + 'manifest.json');
    const man = r.ok ? await r.json() : null;
    if (!man?.hdri?.file) throw new Error('no hdri in manifest');
    bg = await new RGBELoader().loadAsync(ASSET_BASE + man.hdri.file);
    bg.mapping = THREE.EquirectangularReflectionMapping;
  } catch (e) {
    console.warn('[world] HDRI unavailable, using gradient sky:', e.message);
    const c = makeCanvas(512, 256), g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#9aa3ab'); grd.addColorStop(0.48, '#d4d8da'); grd.addColorStop(0.52, '#7d7f7c'); grd.addColorStop(1, '#4a4a47');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
    bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    bg.mapping = THREE.EquirectangularReflectionMapping;
  }
  const env = pmrem.fromEquirectangular(bg).texture;
  pmrem.dispose();
  scene.background = bg;
  scene.environment = env;
  scene.backgroundIntensity = 1.0;
  scene.environmentIntensity = 1.0;
  return { bg, env };
}

// Additive light-shaft prism from an opening rectangle along the sun direction down to the floor.
// Distance along the sun ray from p to the first ray-blocking solid (or the floor).
function rayEnd(p, solids) {
  const L = SUN_DIR;
  let best = p.y / -L.y;
  const o = [p.x, p.y, p.z], d = [L.x, L.y, L.z];
  for (const s of solids) {
    if (!s.ray || s.kind === 'roof') continue;
    let t0 = 0.05, t1 = best;
    for (let k = 0; k < 3 && t0 <= t1; k++) {
      if (Math.abs(d[k]) < 1e-9) { if (o[k] <= s.min[k] || o[k] >= s.max[k]) t1 = -1; continue; }
      let a = (s.min[k] - o[k]) / d[k], b = (s.max[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 <= t1 && t0 < best) best = t0;
  }
  return best;
}

function shaftGeometry(list, solids) {
  const pos = [], tt = [], nor = [];
  const L = SUN_DIR;
  for (const raw of list) {
    // shrink slightly so rays starting on the opening edge do not graze the surrounding wall boxes
    const ctr = raw.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(0.25);
    const corners = raw.map((c) => c.clone().lerp(ctr, 0.03));
    const proj = corners.map((c) => c.clone().addScaledVector(L, rayEnd(c, solids)));
    raw.tEnd = Math.min(...corners.map((c) => rayEnd(c, solids)));
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4], pb = proj[(i + 1) % 4], pa = proj[i];
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(pa, a)).normalize();
      for (const [p, t] of [[a, 0], [b, 0], [pb, 1], [a, 0], [pb, 1], [pa, 1]]) { pos.push(p.x, p.y, p.z); tt.push(t); nor.push(n.x, n.y, n.z); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1));
  g.computeBoundingSphere();
  return g;
}

const shaftMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xdfe6ee) }, uStrength: { value: 0.07 } },
  vertexShader: /* glsl */`
    attribute float aT; varying float vT; varying vec3 vN; varying vec3 vW;
    void main(){ vT = aT; vN = normalize(normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform vec3 uColor; uniform float uStrength; varying float vT; varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      float facing = pow(abs(dot(normalize(vN), V)), 1.6);
      float along = (1.0 - vT) * smoothstep(0.0, 0.12, vT + 0.02) + 0.15 * (1.0 - vT);
      float d = length(cameraPosition - vW);
      float nearFade = smoothstep(0.4, 3.5, d);
      float swirl = 0.75 + 0.25 * sin(vW.x * 1.7 + uTime * 0.21) * sin(vW.z * 1.3 - uTime * 0.17 + vW.y * 0.8);
      float a = uStrength * facing * along * nearFade * swirl;
      gl_FragColor = vec4(uColor * a, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
});

function dustPoints(list, count, R) {
  const pos = [], seed = [];
  const L = SUN_DIR;
  for (let i = 0; i < count; i++) {
    const c = list[Math.floor(R() * list.length)];
    const a = c[0], b = c[1], d = c[3];
    const u = R(), v = R();
    const p = a.clone().lerp(b, u).add(d.clone().sub(a).multiplyScalar(v));
    const t = R() * (c.tEnd ?? p.y / -L.y) * 0.95;
    p.addScaledVector(L, t);
    pos.push(p.x, p.y, p.z); seed.push(R());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  g.computeBoundingSphere();
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 600 } },
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
      void main(){
        vec3 p = position;
        float t = uTime * (0.6 + aSeed);
        p += vec3(sin(t * 0.31 + aSeed * 40.0) * 0.35, sin(t * 0.17 + aSeed * 23.0) * 0.45, cos(t * 0.23 + aSeed * 31.0) * 0.35);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        vA = (0.4 + 0.6 * fract(aSeed * 7.13)) * smoothstep(14.0, 4.0, dist) * smoothstep(0.2, 0.8, dist);
        gl_PointSize = clamp(uScale * (0.008 + 0.012 * fract(aSeed * 3.7)) / max(dist, 0.1), 1.0, 6.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard;
        float a = vA * (1.0 - r * 4.0) * 0.55; gl_FragColor = vec4(vec3(0.95, 0.93, 0.88) * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

export async function setupLighting(ctx, layout, onProgress = () => {}) {
  const { renderer, scene } = ctx;
  const R = rng(4242);
  onProgress(0, 'Himmel');
  await loadSky(renderer, scene);
  onProgress(1, 'Himmel');
  scene.fog = new THREE.FogExp2(0x8a8f94, 0.0105);

  const root = new THREE.Group(); root.name = 'lighting';
  scene.add(root);

  // ---- overcast sun (the only directional, one well-fitted shadow map over the whole site)
  const sun = new THREE.DirectionalLight(0xe4eaf2, 2.4);
  const center = new THREE.Vector3(-2, 0, 2);
  sun.position.copy(center).addScaledVector(SUN_DIR, -60);
  sun.target.position.copy(center);
  sun.castShadow = true;
  const big = (renderer.capabilities.maxTextureSize || 4096) >= 8192;
  sun.shadow.mapSize.set(big ? 4096 : 2048, big ? 4096 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -36; sc.right = 36; sc.top = 34; sc.bottom = -34; sc.near = 20; sc.far = 110;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.035;
  root.add(sun, sun.target);

  // ---- work lamp (single shadow-casting spot)
  const lampPos = new THREE.Vector3(...WORK_LAMP.pos), lampTgt = new THREE.Vector3(...WORK_LAMP.target);
  const spot = new THREE.SpotLight(0xffd6a0, 90, 24, 0.72, 0.65, 2);
  spot.position.copy(lampPos); spot.target.position.copy(lampTgt);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0006; spot.shadow.normalBias = 0.02;
  spot.shadow.camera.near = 0.3; spot.shadow.camera.far = 24;
  root.add(spot, spot.target);
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.5, metalness: 0.7 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffe0b0, emissiveIntensity: 6 });
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, lampPos.y + 0.05, 6), steel);
      const foot = new THREE.Vector3(lampPos.x + Math.cos(a) * 0.55, 0, lampPos.z + Math.sin(a) * 0.55);
      leg.position.copy(foot).lerp(lampPos, 0.5);
      leg.lookAt(lampPos); leg.rotateX(Math.PI / 2);
      g.add(leg);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.16), steel);
    head.position.copy(lampPos); head.lookAt(lampTgt);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.26), lens);
    face.position.set(0, 0, 0.081); head.add(face);
    g.add(head);
    g.traverse((o) => { o.castShadow = o !== face && o.isMesh; o.userData.surface = 'metal'; });
    face.castShadow = false;
    root.add(g);
  }

  // ---- fluorescent fixtures
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.55, metalness: 0.6 });
  const onMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 3.2, roughness: 0.3 });
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x8c8e8a, roughness: 0.35 });
  const chainMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.8 });
  const fixtures = [];
  for (const f of FIXTURES) {
    const len = f.len;
    const housing = new THREE.BoxGeometry(len + 0.1, 0.07, 0.2).translate(0, 0.035, 0);
    const tubes = mergeGeometries([
      new THREE.CylinderGeometry(0.014, 0.014, len, 8).rotateZ(Math.PI / 2).translate(0, -0.015, -0.05),
      new THREE.CylinderGeometry(0.014, 0.014, len, 8).rotateZ(Math.PI / 2).translate(0, -0.015, 0.05),
    ]);
    const grp = new THREE.Group();
    grp.position.set(...f.pos);
    if (Math.abs(f.pos[0] - 9.4) < 0.01 || f.pos[2] > 100) grp.rotation.y = Math.PI / 2; // corridor tubes run along z
    const hm = new THREE.Mesh(housing, housingMat); hm.castShadow = true;
    let mat = f.state === 'dead' ? deadMat : onMat;
    if (f.state === 'flicker') mat = onMat.clone();
    if (f.tint) { mat = mat === onMat ? onMat.clone() : mat; mat.emissive.set(f.tint); }
    const tm = new THREE.Mesh(tubes, mat);
    if (f.state === 'dead' && R() < 0.6) { tm.rotation.z = 0.25; tm.position.y = -0.06; }   // a tube hanging loose
    grp.add(hm, tm);
    if (f.hang) {
      const top = f.pos[2] < -6 ? H.bay : H.hall;
      const L = top - f.pos[1];
      for (const dx of [-len / 2 + 0.1, len / 2 - 0.1]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, L, 4), chainMat);
        c.position.set(dx, L / 2 + 0.07, 0); grp.add(c);
      }
    }
    let light = null;
    if (f.point && f.state !== 'dead') {
      light = new THREE.PointLight(f.tint ?? 0xe8eef8, f.hang ? 22 : 9, f.hang ? 16 : 9, 2);
      light.position.set(f.pos[0], f.pos[1] - 0.25, f.pos[2]);
      root.add(light);
    }
    root.add(grp);
    fixtures.push({
      f, grp, mat, light, base: light ? light.intensity : 0, baseE: mat.emissiveIntensity ?? 0,
      level: 1, timer: R() * 2, phase: R() * 10,
    });
  }

  // ---- cheap daylight bounce fills near the big openings (no shadows)
  for (const b of BOUNCE_LIGHTS) {
    const l = new THREE.PointLight(b.color, b.intensity, b.distance, 1.6);
    l.position.set(...b.pos);
    root.add(l);
  }

  // ---- daylight shafts + dust in them
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const openings = [];
  for (const w of layout.windows) {
    if (w.glass === undefined) continue;
    const [x0, y0, z0] = w.min, [x1, y1, z1] = w.max;
    if (w.normal === 'z' && z1 >= 15.9 && y0 >= 4) openings.push([V(x0, y1, z1), V(x1, y1, z1), V(x1, y0, z1), V(x0, y0, z1)]);
    if (w.normal === 'x' && x0 <= -23.9 && y0 >= 4) openings.push([V(x0, y1, z1), V(x0, y1, z0), V(x0, y0, z0), V(x0, y0, z1)]);
  }
  for (const h of layout.roofHoles) {
    const y = h.max[1];
    openings.push([V(h.min[0], y, h.min[2]), V(h.max[0], y, h.min[2]), V(h.max[0], y, h.max[2]), V(h.min[0], y, h.max[2])]);
  }
  const shaftMat = shaftMaterial();
  const shafts = new THREE.Mesh(shaftGeometry(openings, layout.solids), shaftMat);
  shafts.renderOrder = 5; shafts.frustumCulled = false;
  root.add(shafts);
  const dust = dustPoints(openings, 1800, R);
  dust.renderOrder = 6;
  root.add(dust);

  // ---- per-frame animation
  let time = 0;
  function update(dt) {
    time += dt;
    shaftMat.uniforms.uTime.value = time;
    dust.material.uniforms.uTime.value = time;
    const cam = ctx.camera;
    if (cam?.isPerspectiveCamera) dust.material.uniforms.uScale.value = (renderer.domElement.height || 900) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    for (const fx of fixtures) {
      if (fx.f.hang) fx.grp.rotation.x = Math.sin(time * 0.6 + fx.phase) * 0.012;
      if (fx.f.state !== 'flicker') continue;
      fx.timer -= dt;
      if (fx.timer <= 0) {
        const r = R();
        if (r < 0.5) { fx.level = 1; fx.timer = 0.4 + R() * 3.5; }
        else if (r < 0.8) { fx.level = R() * 0.25; fx.timer = 0.03 + R() * 0.12; }
        else if (r < 0.93) { fx.level = 0.55; fx.timer = 0.05 + R() * 0.3; }
        else { fx.level = 0; fx.timer = 0.8 + R() * 2.5; }
      }
      const hum = fx.level > 0.5 ? 0.93 + 0.07 * Math.sin(time * 190 + fx.phase) : 1;
      const k = fx.level * hum;
      fx.mat.emissiveIntensity = fx.baseE * k;
      if (fx.light) fx.light.intensity = fx.base * k;
    }
    spot.intensity = 90 * (0.985 + 0.015 * Math.sin(time * 120));
  }

  return { update, sun, spot, root };
}
