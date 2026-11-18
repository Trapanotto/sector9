// Sky / IBL, overcast sun (static high-res shadow + small per-frame cascade for moving objects), the shadowed
// work lamp with a visible beam, fluorescent fixtures as analytic tube lights (room-clipped, flickering, with
// bounce fill), daylight shafts and dust motes, zone-dependent haze. Indirect light comes from the baked
// irradiance volume and local reflection probes (lightGI.js / lightProbes.js / lightShader.js).
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FIXTURES, WORK_LAMP, H } from './layout.js';
import { ASSET_BASE, makeCanvas } from './materials.js';
import { rng } from './geometry.js';
import { LP, MAX_TUBES } from './lightShader.js';
import { REFL_ZONES } from './lightProbes.js';

export const SUN_DIR = new THREE.Vector3(0.42, -0.72, -0.55).normalize(); // direction the light travels
// Hazy sun through the overcast. Exterior light (sun + sky) is set high against the interiors so that, as in real
// footage, openings burn out from inside and the building reads black from the yard until the exposure adapts.
export const SUN = { color: 0xeaedf2, intensity: 4.6 };
export const SKY_GAIN = 1.5;   // HDRI radiance multiplier (background, bake and fallback environment)
export const LAMP = { color: 0xffd2a0, intensity: 100, angle: 0.68, penumbra: 0.55, range: 26 };

export async function loadSky(renderer, scene) {
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
  scene.backgroundIntensity = SKY_GAIN;
  scene.environmentIntensity = SKY_GAIN;
  return { bg, env };
}

// Linear RGB * intensity of a three colour (what the bake needs to match the real-time light).
export const linColor = (hex, k) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };

// ------------------------------------------------------------------------------------------------ shafts
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

// Additive in-scatter volume. Brightness is tied to the sun intensity so shafts match the patches they produce.
const shaftMaterial = (color, strength) => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: color }, uStrength: { value: strength } },
  vertexShader: /* glsl */`
    attribute float aT; varying float vT; varying vec3 vN; varying vec3 vW;
    void main(){ vT = aT; vN = normalize(normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform vec3 uColor; uniform float uStrength; varying float vT; varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      float facing = pow(abs(dot(normalize(vN), V)), 1.4);
      float along = (1.0 - vT) * smoothstep(0.0, 0.12, vT + 0.02) + 0.2 * (1.0 - vT);
      float d = length(cameraPosition - vW);
      float nearFade = smoothstep(0.4, 3.5, d);
      float floorFade = smoothstep(0.0, 0.5, vW.y);
      float swirl = 0.72 + 0.28 * sin(vW.x * 1.7 + uTime * 0.21) * sin(vW.z * 1.3 - uTime * 0.17 + vW.y * 0.8);
      float a = uStrength * facing * along * nearFade * swirl * floorFade;
      gl_FragColor = vec4(uColor * a, 1.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
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
    uniforms: { uTime: { value: 0 }, uScale: { value: 600 }, uColor: { value: new THREE.Color(0.95, 0.93, 0.88) } },
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
      uniform vec3 uColor; varying float vA;
      void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard;
        float a = vA * (1.0 - r * 4.0) * 0.55; gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

// Visible cone of the work lamp in the haze (additive, soft edges, fades into the floor).
function beamMesh(pos, tgt, angle, len, color, strength) {
  const r = Math.tan(angle) * len;
  const g = new THREE.CylinderGeometry(0.09, r, len, 40, 12, true).translate(0, -len / 2, 0).rotateX(-Math.PI / 2);
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uStrength: { value: strength }, uApex: { value: pos.clone() }, uAxis: { value: tgt.clone().sub(pos).normalize() },
      uCos: { value: Math.cos(angle) }, uLen: { value: len }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vW; varying vec3 vN;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uStrength; uniform vec3 uApex; uniform vec3 uAxis; uniform float uCos; uniform float uLen; uniform float uTime;
      varying vec3 vW; varying vec3 vN;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float facing = pow(abs(dot(normalize(vN), V)), 2.0);
        vec3 d = vW - uApex; float t = dot(d, uAxis);
        float fall = 1.0 / (1.0 + t * t * 0.35);
        float endFade = 1.0 - smoothstep(uLen * 0.55, uLen, t);
        float floorFade = smoothstep(0.0, 0.7, vW.y);
        float nearFade = smoothstep(0.3, 2.5, length(cameraPosition - vW));
        float n = 0.8 + 0.2 * sin(vW.x * 2.1 + uTime * 0.3) * sin(vW.z * 1.7 - uTime * 0.23 + vW.y);
        float a = uStrength * facing * fall * endFade * floorFade * nearFade * n;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(pos);
  mesh.lookAt(tgt);
  mesh.renderOrder = 6;
  mesh.userData.dynamic = true;
  return mesh;
}

// Room box (from the reflection zones) a fixture lives in; its light is clipped to it (tube lights cast no shadows).
function zoneBox(p) {
  for (let i = REFL_ZONES.length - 1; i >= 1; i--) {
    const z = REFL_ZONES[i];
    if (p[0] >= z.min[0] && p[0] <= z.max[0] && p[2] >= z.min[2] && p[2] <= z.max[2] && p[1] <= z.max[1] + 0.2) return z;
  }
  return REFL_ZONES[0];
}

// ------------------------------------------------------------------------------------------------ setup
export async function setupLighting(ctx, layout, { sky } = {}) {
  const { renderer, scene } = ctx;
  const R = rng(4242);
  if (!sky) await loadSky(renderer, scene);
  scene.fog = new THREE.FogExp2(0x8a8f94, 0.0105);

  const root = new THREE.Group(); root.name = 'lighting';
  root.userData.static = true;
  scene.add(root);

  // ---- sun: three's shadow map is a small cascade that follows the player and only holds moving casters;
  // static casters live in the high-resolution static map (lightSun.js).
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const CASCADE = 11;
  const sc = sun.shadow.camera;
  sc.left = -CASCADE; sc.right = CASCADE; sc.top = CASCADE; sc.bottom = -CASCADE; sc.near = 1; sc.far = 120;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; sun.shadow.radius = 2;
  root.add(sun, sun.target);
  const sunCenter = new THREE.Vector3(), lsX = new THREE.Vector3(), lsY = new THREE.Vector3();
  lsX.crossVectors(SUN_DIR, new THREE.Vector3(0, 1, 0)).normalize(); lsY.crossVectors(lsX, SUN_DIR).normalize();
  const texel = (2 * CASCADE) / 1024;
  function placeSun(p) {
    // snap the cascade to its texel grid in light space so the shadow edges do not crawl while moving
    const x = Math.round(p.dot(lsX) / texel) * texel, y = Math.round(p.dot(lsY) / texel) * texel, z = p.dot(SUN_DIR);
    sunCenter.set(0, 0, 0).addScaledVector(lsX, x).addScaledVector(lsY, y).addScaledVector(SUN_DIR, z);
    sun.target.position.copy(sunCenter);
    sun.position.copy(sunCenter).addScaledVector(SUN_DIR, -60);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  }
  placeSun(new THREE.Vector3(-9, 0, 20));

  // ---- work lamp (single shadow-casting spot, warm practical)
  const lampPos = new THREE.Vector3(...WORK_LAMP.pos), lampTgt = new THREE.Vector3(...WORK_LAMP.target);
  const spot = new THREE.SpotLight(LAMP.color, LAMP.intensity, LAMP.range, LAMP.angle, LAMP.penumbra, 2);
  spot.position.copy(lampPos); spot.target.position.copy(lampTgt);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004; spot.shadow.normalBias = 0.025;
  spot.shadow.camera.near = 0.3; spot.shadow.camera.far = LAMP.range; spot.shadow.radius = 2;
  root.add(spot, spot.target);
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.5, metalness: 0.7 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffe0b0, emissiveIntensity: 40 });
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
    // the lamp sits at the apex of its own shadow frustum: keep the head itself out of the spot's shadow map
    head.castShadow = false;
    root.add(g);
  }
  const beam = beamMesh(lampPos.clone().addScaledVector(lampTgt.clone().sub(lampPos).normalize(), 0.1), lampTgt, LAMP.angle * 0.8, 9,
    new THREE.Color(LAMP.color), 0.05);
  root.add(beam);

  // ---- fluorescent fixtures: emissive tubes + analytic tube lights (lightShader.js)
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.55, metalness: 0.6 });
  const onMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 4, roughness: 0.3 });
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x8c8e8a, roughness: 0.35 });
  const chainMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.8 });
  const fixtures = [];
  let nt = 0;
  for (const f of FIXTURES) {
    const len = f.len;
    const housing = new THREE.BoxGeometry(len + 0.1, 0.07, 0.2).translate(0, 0.035, 0);
    const tubes = mergeGeometries([
      new THREE.CylinderGeometry(0.014, 0.014, len, 8).rotateZ(Math.PI / 2).translate(0, -0.015, -0.05),
      new THREE.CylinderGeometry(0.014, 0.014, len, 8).rotateZ(Math.PI / 2).translate(0, -0.015, 0.05),
    ]);
    const grp = new THREE.Group();
    grp.position.set(...f.pos);
    const alongZ = Math.abs(f.pos[0] - 9.4) < 0.01 || f.pos[2] > 100;   // corridor tubes run along z
    if (alongZ) grp.rotation.y = Math.PI / 2;
    const hm = new THREE.Mesh(housing, housingMat); hm.castShadow = true;
    let mat = f.state === 'dead' ? deadMat : onMat;
    if (f.state === 'flicker' || f.tint) mat = onMat.clone();
    if (f.tint) mat.emissive.set(f.tint);
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
    root.add(grp);
    let tube = -1, power = 0;
    if (f.state !== 'dead' && nt < MAX_TUBES) {
      tube = nt++;
      const z = zoneBox(f.pos);
      const hang = !!f.hang;
      power = hang ? 34 : 11;
      LP.lpTubeA.value[tube].set(f.pos[0], f.pos[1] - 0.02, f.pos[2], len / 2);
      LP.lpTubeB.value[tube].set(alongZ ? 0 : 1, 0, alongZ ? 1 : 0, hang ? 15 : 7.5);
      const col = new THREE.Color(f.tint ?? 0xe9eef5);
      LP.lpTubeC.value[tube].set(col.r * power, col.g * power, col.b * power, hang ? 0.12 : 0.35);
      LP.lpTubeMin.value[tube].set(z.min[0] - 0.1, z.min[1] - 0.1, z.min[2] - 0.1);
      LP.lpTubeMax.value[tube].set(z.max[0] + 0.1, z.max[1] + 0.1, z.max[2] + 0.1);
    }
    fixtures.push({ f, grp, mat, tube, power, col: new THREE.Color(f.tint ?? 0xe9eef5), baseE: mat.emissiveIntensity ?? 0, level: 1, timer: R() * 2, phase: R() * 10 });
    if (!f.hang) { grp.updateMatrix(); grp.matrixAutoUpdate = false; }
  }
  LP.lpTubeCount.value = nt;

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
  const sunLin = new THREE.Color(SUN.color).multiplyScalar(SUN.intensity);
  const shaftMat = shaftMaterial(sunLin, 0.0035);
  const shafts = new THREE.Mesh(shaftGeometry(openings, layout.solids), shaftMat);
  shafts.renderOrder = 5; shafts.frustumCulled = false; shafts.userData.dynamic = true;
  root.add(shafts);
  const dust = dustPoints(openings, 1800, R);
  dust.renderOrder = 6; dust.userData.dynamic = true;
  dust.material.uniforms.uColor.value.copy(sunLin).multiplyScalar(0.22);
  root.add(dust);

  // ---- per-frame animation
  let time = 0;
  const tmpV = new THREE.Vector3();
  function update(dt) {
    time += dt;
    shaftMat.uniforms.uTime.value = time;
    dust.material.uniforms.uTime.value = time;
    beam.material.uniforms.uTime.value = time;
    const cam = ctx.camera;
    if (cam?.isPerspectiveCamera) dust.material.uniforms.uScale.value = (renderer.domElement.height || 900) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    // cascade follows the player (or the camera before the player exists)
    const p = ctx.player?.position || cam?.position;
    if (p) { tmpV.copy(p); tmpV.y = Math.max(0, tmpV.y); placeSun(tmpV); }
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
      if (fx.tube >= 0) LP.lpTubeC.value[fx.tube].set(fx.col.r * fx.power * k, fx.col.g * fx.power * k, fx.col.b * fx.power * k, LP.lpTubeC.value[fx.tube].w);
    }
    spot.intensity = LAMP.intensity * (0.985 + 0.015 * Math.sin(time * 120));
  }

  return { update, sun, spot, root, fixtures, shafts, dust, beam };
}
