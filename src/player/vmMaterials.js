import * as THREE from 'three';

// PBR materials for the first-person viewmodel. All are MeshStandardMaterial with small shader injections:
//  - metal:   curvature-driven edge wear (screen-space normal derivatives) revealing bright steel on convex edges,
//             grime in concave corners, smudge roughness variation
//  - polymer: matte with molded micro texture; stippled grip panels (analytic panel mask in gun space)
//  - glove:   triplanar Poly Haven fabric (back) / synthetic leather (palm) normal+roughness, side seams,
//             rubber knuckle armour, wrist strap and hook-and-loop tab (regions come from a per-vertex attribute)
//  - sleeve:  UV-mapped cloth normal+roughness with faded dirt variation
// Textures are packed WebP: RG = normal XY (tilt amplified x2.5 at pack time), B = roughness.

const GAIN = 2.5;
// The player's own torso and head sit right behind the hands: surfaces facing the camera (view-space +Z, the backs
// of the hands and the tops of the sleeves) see the dark body, not the room the irradiance volume describes. Without
// this the dark gloves read as pale grey clay outdoors.
// The volume also has no idea of the arms shadowing each other and the gun: a flat 0.6 on top.
const BODY_OCC = '(0.6 * (1.0 - 0.6 * smoothstep(-0.2, 0.85, normal.z) - 0.15 * smoothstep(0.0, 0.8, -normal.y)))';

function assetBase() {
  let base = '/';
  try { base = import.meta.env.BASE_URL || '/'; } catch { /* not under Vite */ }
  return base.replace(/\/?$/, '/') + 'assets/viewmodel/';
}

const GLSL_COMMON = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjNrm;
float vmHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vmNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vmHash(i), vmHash(i + vec3(1,0,0)), f.x), mix(vmHash(i + vec3(0,1,0)), vmHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vmHash(i + vec3(0,0,1)), vmHash(i + vec3(1,0,1)), f.x), mix(vmHash(i + vec3(0,1,1)), vmHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float vmFbm(vec3 p) { return 0.5 * vmNoise(p) + 0.25 * vmNoise(p * 2.03 + 1.7) + 0.125 * vmNoise(p * 4.01 + 3.1); }
mat3 vmTBN(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos); vec3 q1 = dFdy(eye_pos); vec2 st0 = dFdx(uv); vec2 st1 = dFdy(uv);
  vec3 N = surf_norm; vec3 q1perp = cross(q1, N); vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x; vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B)); float sc = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, N);
}
// height H in metres -> perturbed normal (three's perturbNormalArb with physical slope scaling)
vec3 vmBump(vec3 surf_pos, vec3 surf_norm, float H, float fd) {
  vec3 dpx = dFdx(surf_pos), dpy = dFdy(surf_pos);
  vec2 dHdxy = vec2(dFdx(H) / max(length(dpx), 1e-7), dFdy(H) / max(length(dpy), 1e-7));
  vec3 vSigmaX = normalize(dpx); vec3 vSigmaY = normalize(dpy);
  vec3 R1 = cross(vSigmaY, surf_norm); vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * fd;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
vec3 vmMapN(vec4 t, float s) { vec2 xy = (t.rg * 2.0 - 1.0) * (s / ${GAIN.toFixed(2)}); return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))); }
vec3 vmTriplanar(sampler2D tex, float scale, float strength, vec3 N, vec3 eyePos, out float rough) {
  vec3 w = pow(abs(normalize(vObjNrm)), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec2 ux = vObjPos.zy * scale, uy = vObjPos.xz * scale + 0.37, uz = vObjPos.xy * scale + 0.71;
  vec4 tx = texture2D(tex, ux), ty = texture2D(tex, uy), tz = texture2D(tex, uz);
  rough = tx.b * w.x + ty.b * w.y + tz.b * w.z;
  vec3 r = w.x * (vmTBN(eyePos, N, ux) * vmMapN(tx, strength))
         + w.y * (vmTBN(eyePos, N, uy) * vmMapN(ty, strength))
         + w.z * (vmTBN(eyePos, N, uz) * vmMapN(tz, strength));
  return normalize(r);
}
// screen-space curvature (1/m) and convexity of the geometric normal
float vmCurv(vec3 n, vec3 p, out float convex) {
  vec3 dnx = dFdx(n), dny = dFdy(n), dpx = dFdx(p), dpy = dFdy(p);
  convex = sign(dot(dnx, dpx) + dot(dny, dpy));
  return (length(dnx) + length(dny)) / max(length(dpx) + length(dpy), 1e-7);
}
`;

function inject(mat, key, { vertexHead = '', vertexBody = '', fragHead = '', fragBody = '', fragBegin = '', fragLights = '', fragOcc = '', uniforms = {} }) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;\n${vertexHead}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvObjNrm = objectNormal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvObjPos = transformed;\n${vertexBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\n${fragHead}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\nvec3 vmGeoN = normal;\n${fragBegin}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragBody}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${fragLights}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${fragOcc}`);
  };
  mat.customProgramCacheKey = () => 'vm-' + key;
  return mat;
}

export function createVmMaterials() {
  const tex = {};
  const ready = { value: 0 };
  const loader = new THREE.TextureLoader();
  let pending = 3;
  const load = (name) => {
    const t = loader.load(assetBase() + name, () => { if (--pending === 0) ready.value = 1; },
      undefined, () => console.warn('[viewmodel] texture missing:', name));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    return { value: t };
  };
  tex.fabric = load('bi_stretch_nr.webp');
  tex.leather = load('leather_white_nr.webp');
  tex.cloth = load('stretch_poplin_nr.webp');

  // ---------------------------------------------------------------- metals
  const metal = (key, color, rough, wearColor, opts = {}) => inject(
    new THREE.MeshStandardMaterial({ color, metalness: opts.metalness ?? 0.85, roughness: rough }), key, {
      fragBody: /* glsl */`
      {
        float convex; float curv = vmCurv(vmGeoN, -vViewPosition, convex);
        float edge = smoothstep(${(opts.wearLo ?? 260).toFixed(1)}, ${(opts.wearHi ?? 900).toFixed(1)}, curv);
        float brk = vmFbm(vObjPos * 900.0);
        float wear = edge * max(convex, 0.0) * smoothstep(0.30, 0.62, brk + edge * 0.25) * ${(opts.wear ?? 1).toFixed(2)};
        float grime = edge * max(-convex, 0.0) * 0.7;
        float smudge = vmFbm(vObjPos * 70.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${wearColor}), wear);
        diffuseColor.rgb *= 1.0 - grime * 0.6;
        roughnessFactor = clamp(roughnessFactor + (smudge - 0.5) * ${(opts.smudge ?? 0.22).toFixed(2)} - wear * 0.16 + grime * 0.25, 0.08, 1.0);
        float micro = (vmNoise(vObjPos * 5200.0) - 0.5) * 0.000006 * ${(opts.micro ?? 1).toFixed(2)};
        normal = vmBump(-vViewPosition, normal, micro, faceDirection);
      }`,
    });

  // ---------------------------------------------------------------- polymer frame
  const GO = [0, -0.020, 0.003];                 // grip frame origin (magwell top, see vmPistol)
  const GA = [0, -Math.cos(0.31), Math.sin(0.31)];
  const GF = [0, -Math.sin(0.31), -Math.cos(0.31)];
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(5)).join(',')})`;
  const polymer = (key, color, rough, grip) => inject(
    new THREE.MeshStandardMaterial({ color, metalness: 0.0, roughness: rough }), key, {
      fragBody: /* glsl */`
      {
        vec3 P = vObjPos;
        float H = (vmFbm(P * 260.0) - 0.5) * 0.000025;          // molded surface undulation
        float panel = 0.0;
        ${grip ? `
        vec3 rel = P - ${v3(GO)};
        float s = dot(rel, ${v3(GA)}), f = dot(rel, ${v3(GF)});
        float side = smoothstep(0.55, 0.8, abs(normalize(vObjNrm).x));
        // side panels with a moulded border, straps stippled over their full width
        float inS = smoothstep(0.012, 0.0135, s) * (1.0 - smoothstep(0.099, 0.1005, s));
        float inF = smoothstep(-0.0185, -0.017, f) * (1.0 - smoothstep(0.0125, 0.014, f));
        panel = inS * mix(1.0, inF, side);
        float border = inS * side * (smoothstep(-0.0195, -0.0185, f) - smoothstep(0.014, 0.015, f) + 1.0 - inF) ;
        float st = vmNoise(P * 1500.0);
        float aa = clamp(1.6 - length(fwidth(P * 1500.0)), 0.0, 1.0);
        H += panel * (st - 0.5) * 0.00022 * aa;
        H -= (1.0 - inF) * inS * side * 0.0;
        diffuseColor.rgb *= 1.0 - panel * 0.10;
        ` : ''}
        roughnessFactor = clamp(roughnessFactor + panel * 0.16 + (vmFbm(P * 90.0) - 0.5) * 0.12, 0.2, 1.0);
        normal = vmBump(-vViewPosition, normal, H, faceDirection);
        float convex; float curv = vmCurv(vmGeoN, -vViewPosition, convex);
        float edge = smoothstep(300.0, 1100.0, curv) * max(convex, 0.0);
        diffuseColor.rgb *= 1.0 + edge * 0.35;                  // scuffed lighter polymer on edges
        roughnessFactor -= edge * 0.12;
      }`,
    });

  // ---------------------------------------------------------------- glove
  // Regions come from the explicit hand mesh (vmHands.js): aGlove = (leather, rubber, strap 0/1/2 = velcro, cuff),
  // aOcc = baked AO (self, contact with gun / other hand), aLen = metres along the part (stitch spacing).
  // Shading: matte black stretch fabric on the back (sheen, low specular), slightly glossy synthetic leather on the
  // palm / finger sides / tips, satin rubber knuckle guard and finger pads, woven strap, fuzzy hook-and-loop tab,
  // neoprene gauntlet; seams are grooves with raised stitch dashes; baked AO darkens diffuse AND specular (glossy
  // leather does not shine inside the creases); a sky rim term separates the silhouette from the floor.
  const shared = { rim: { value: 0.0 } };   // set per frame from the sky visibility (viewmodel.setEnvironment)
  const makeGlove = (contact) => inject(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.85, specularIntensity: 0.999,
    sheen: 1.0, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.05, 0.05, 0.052),
  }), 'glove', {
    uniforms: { uFabric: tex.fabric, uLeather: tex.leather, uTexReady: ready, uContact: contact, uRim: shared.rim },
    vertexHead: 'attribute vec4 aGlove;\nattribute vec2 aOcc;\nattribute float aLen;\nvarying vec4 vGlove;\nvarying vec2 vOcc;\nvarying float vLen;',
    vertexBody: 'vGlove = aGlove; vOcc = aOcc; vLen = aLen;',
    fragHead: 'uniform sampler2D uFabric; uniform sampler2D uLeather; uniform float uTexReady; uniform float uContact; uniform float uRim;\n' +
      'varying vec4 vGlove; varying vec2 vOcc; varying float vLen;',
    fragBegin: 'float vmSpecK = 1.0; float vmSheenK = 1.0; float vmOccD = 1.0; float vmOccS = 1.0; float vmRimK = 1.0;',
    fragBody: /* glsl */`
    {
      vec4 R = vGlove;
      float leather = smoothstep(0.35, 0.65, R.x);
      float rubber = smoothstep(0.3, 0.7, R.y);
      float strap = smoothstep(0.4, 0.6, R.z);
      float velcro = smoothstep(1.4, 1.6, R.z);
      float cuff = smoothstep(0.4, 0.9, R.w) * (1.0 - strap);
      float fabric = (1.0 - leather) * (1.0 - rubber) * (1.0 - strap) * (1.0 - cuff);
      vec3 eyeP = -vViewPosition;
      // stretch-fabric wrinkles (ridged noise) on fabric and neoprene
      float wn = vmFbm(vObjPos * vec3(110.0, 140.0, 110.0) + 4.0);
      float ridge = 1.0 - abs(2.0 * wn - 1.0);
      float wr = ridge * ridge * (fabric + cuff * 0.5);
      float H = wr * 0.00022;
      // seam where leather meets fabric: a groove with stitch dashes on the fabric side
      float dL = abs(R.x - 0.5), wL = max(fwidth(R.x), 1e-4);
      float seam = (1.0 - smoothstep(0.0, wL * 1.5, dL)) * (1.0 - strap) * (1.0 - rubber);
      float band = smoothstep(wL * 1.4, wL * 2.0, dL) * (1.0 - smoothstep(wL * 2.6, wL * 3.4, dL)) * step(R.x, 0.5);
      float dash = smoothstep(0.25, 0.4, fract(vLen / 0.0026)) * (1.0 - smoothstep(0.75, 0.9, fract(vLen / 0.0026)));
      float stitch = band * dash * (1.0 - strap) * (1.0 - rubber) * clamp(2.0 - wL * 60.0, 0.0, 1.0);
      H += -seam * 0.00045 + stitch * 0.00012;
      // rubber: moulded fine texture and a rounded raised edge; strap: woven ribs; velcro: hooks
      H += rubber * (vmNoise(vObjPos * 1900.0) - 0.5) * 0.00005;
      H += strap * (1.0 - velcro) * sin(vLen * 2400.0) * 0.00003;
      H += velcro * (vmNoise(vObjPos * 3200.0) - 0.5) * 0.00008;
      normal = vmBump(eyeP, normal, H, faceDirection);
      float rF, rL;
      vec3 nF = vmTriplanar(uFabric, strap > 0.5 ? 18.0 : 13.0, 2.4, normal, eyeP, rF);
      vec3 nL = vmTriplanar(uLeather, 8.0, 1.8, normal, eyeP, rL);
      vec3 nT = normalize(mix(nF, nL, leather));
      float rT = mix(rF, rL, leather);
      nT = normalize(mix(nT, normal, rubber * 0.9));
      normal = normalize(mix(normal, nT, uTexReady));
      // albedo (linear): blacks that still separate from each other
      // (separated on purpose: black stretch back, lighter worn leather on palm / finger sides / tips, near-black
      // satin rubber on the knuckles, so the form reads at a glance under the bodycam lens)
      vec3 cFab = vec3(0.013, 0.0135, 0.014);
      vec3 cLea = vec3(0.060, 0.052, 0.044);
      vec3 cRub = vec3(0.008, 0.008, 0.0085);
      vec3 cStr = vec3(0.030, 0.030, 0.029);
      vec3 cVel = vec3(0.018, 0.018, 0.018);
      vec3 cCuf = vec3(0.011, 0.0115, 0.012);
      vec3 col = cFab;
      col = mix(col, cLea, leather);
      col = mix(col, cCuf, cuff);
      col = mix(col, cRub, rubber);
      col = mix(col, cStr, strap);
      col = mix(col, cVel, velcro);
      float dirt = vmFbm(vObjPos * 60.0);
      col *= (0.82 + 0.36 * dirt) * (1.0 - wr * 0.2) * (1.0 - seam * 0.5) * (1.0 + stitch * 0.6);
      // worn, slightly lighter leather on the most exposed convex palm/finger edges
      float convex; float curv = vmCurv(vmGeoN, eyeP, convex);
      col *= 1.0 + leather * smoothstep(200.0, 700.0, curv) * max(convex, 0.0) * 0.35;
      diffuseColor.rgb = col;
      float rough = 0.9;
      rough = mix(rough, 0.40, leather);
      rough = mix(rough, 0.72, cuff);
      rough = mix(rough, 0.32, rubber);
      rough = mix(rough, 0.74, strap);
      rough = mix(rough, 0.97, velcro);
      roughnessFactor = clamp(rough + (rT - 0.5) * 0.3 * uTexReady * (1.0 - rubber) + (dirt - 0.5) * 0.08, 0.3, 1.0);
      vmSpecK = 0.3 * fabric + 1.0 * leather + 0.85 * rubber + 0.55 * strap * (1.0 - velcro) + 0.15 * velcro + 0.6 * cuff;
      vmSheenK = fabric + cuff * 0.6 + strap * 0.5;
      // baked occlusion: self + contact (fades out when the support hand leaves the gun)
      float occ = clamp(vOcc.x * 0.85 + vOcc.y * uContact * 0.9, 0.0, 1.0);
      vmOccD = 1.0 - occ * 0.92;
      vmOccS = 1.0 - smoothstep(0.05, 0.6, occ) * 0.97;
      vmRimK = (1.0 - occ) * (0.6 + 0.4 * fabric);
    }`,
    fragLights: /* glsl */`
      material.specularColor *= vmSpecK;
      material.specularF90 *= vmSpecK;
      #ifdef USE_SHEEN
      material.sheenColor *= vmSheenK;
      #endif`,
    fragOcc: /* glsl */`
    {
      float vmBody = ${BODY_OCC};
      reflectedLight.indirectDiffuse *= vmOccD * vmBody;
      reflectedLight.indirectSpecular *= vmOccS * mix(1.0, vmBody, 0.6);
      reflectedLight.directDiffuse *= mix(1.0, vmOccD, 0.6);
      reflectedLight.directSpecular *= mix(1.0, vmOccS, 0.75);
      // sky rim: grazing light from the overcast sky / skylights outlines the dark glove against the floor
      float fr = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
      reflectedLight.indirectSpecular += iblIrradiance * RECIPROCAL_PI * fr * uRim * vmRimK;
    }`,
  });
  const contactStrong = { value: 1 }, contactSupport = { value: 1 };
  const glove = makeGlove(contactStrong);
  const gloveSupport = makeGlove(contactSupport);

  // ---------------------------------------------------------------- sleeve
  // dark navy duty shirt: a step lighter and bluer than the black gloves so wrist and sleeve separate
  const sleeve = inject(new THREE.MeshPhysicalMaterial({ color: 0x232a38, metalness: 0, roughness: 0.92, sheen: 0.6, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.03, 0.033, 0.038) }), 'sleeve', {
    uniforms: { uCloth: tex.cloth, uTexReady: ready, uRim: shared.rim },
    vertexHead: 'varying vec2 vVmUv;',
    vertexBody: 'vVmUv = uv;',
    fragHead: 'uniform sampler2D uCloth; uniform float uTexReady; uniform float uRim; varying vec2 vVmUv;',
    fragBody: /* glsl */`
    {
      vec2 uv = vVmUv;
      vec4 t = texture2D(uCloth, uv);
      vec3 nT = normalize(vmTBN(-vViewPosition, normal, uv) * vmMapN(t, 1.6));
      // rib-knit cuff band (first 3 cm): fine ribs along the arm
      float rib = 1.0 - smoothstep(0.53, 0.56, uv.y);
      normal = vmBump(-vViewPosition, normal, rib * sin(uv.x * 260.0) * 0.00007, faceDirection);
      normal = normalize(mix(normal, nT, uTexReady * (1.0 - rib * 0.7)));
      float dirt = vmFbm(vObjPos * 18.0);
      diffuseColor.rgb *= (0.8 + 0.4 * dirt) * (1.0 - rib * 0.25);
      roughnessFactor = clamp(0.9 + (t.b - 0.5) * 0.3 * uTexReady, 0.6, 1.0);
    }`,
    fragOcc: /* glsl */`
    {
      float vmBody = ${BODY_OCC};
      reflectedLight.indirectDiffuse *= vmBody;
      reflectedLight.indirectSpecular *= mix(1.0, vmBody, 0.6);
      float fr = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
      reflectedLight.indirectSpecular += iblIrradiance * RECIPROCAL_PI * fr * uRim * 0.7;
    }`,
  });

  const mats = {
    slide: metal('slide', 0x17181a, 0.44, '0.42, 0.42, 0.41', { metalness: 0.78, wear: 1.0 }),
    steel: metal('steel', 0x2a2a29, 0.36, '0.62, 0.61, 0.58', { metalness: 0.9, wear: 0.9, wearLo: 500, wearHi: 1500 }),
    barrel: metal('barrel', 0x46453f, 0.28, '0.78, 0.77, 0.72', { metalness: 0.95, wear: 0.8, wearLo: 500, wearHi: 1500 }),
    magBody: metal('mag', 0x18191b, 0.4, '0.40, 0.40, 0.39', { metalness: 0.8, wear: 0.8 }),
    brass: metal('brass', 0xb08a40, 0.3, '0.85, 0.70, 0.40', { metalness: 0.95, wear: 0.0 }),
    copper: metal('copper', 0xb0704a, 0.32, '0.85, 0.60, 0.45', { metalness: 0.95, wear: 0.0 }),
    frame: polymer('frame', 0x16171a, 0.62, true),
    polymer: polymer('poly', 0x17181b, 0.58, false),
    lightBody: metal('light', 0x1a1b1d, 0.52, '0.40, 0.40, 0.40', { metalness: 0.55, wear: 0.9, smudge: 0.15 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x050505, metalness: 0.3, roughness: 0.8 }),
    dot: new THREE.MeshStandardMaterial({ color: 0xd8e6c4, emissive: 0x7d9a40, emissiveIntensity: 0.7, roughness: 0.4 }),
    lens: new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.3, roughness: 0.08, emissive: 0xfff2d8, emissiveIntensity: 0 }),
    reflector: new THREE.MeshStandardMaterial({ color: 0xd0d2d4, metalness: 1.0, roughness: 0.15, emissive: 0xfff2d8, emissiveIntensity: 0 }),
    watchGlass: new THREE.MeshStandardMaterial({ color: 0x050607, metalness: 0.0, roughness: 0.12 }),
    glove,
    gloveSupport,
    sleeve,
  };
  // IBL strength under open sky (the viewmodel scales these down under a roof, see viewmodel.setEnvironment).
  // These only take effect because the viewmodel assigns material.envMap explicitly (three ignores
  // envMapIntensity for materials lit by scene.environment alone).
  for (const m of Object.values(mats)) m.envMapIntensity = 0.7;
  mats.slide.envMapIntensity = 0.75;
  mats.steel.envMapIntensity = 0.9;
  mats.barrel.envMapIntensity = 0.9;
  mats.brass.envMapIntensity = 0.9;
  mats.copper.envMapIntensity = 0.9;
  mats.lens.envMapIntensity = 1.0;
  mats.reflector.envMapIntensity = 1.0;
  mats.glove.envMapIntensity = 0.45;
  mats.gloveSupport.envMapIntensity = 0.45;
  mats.sleeve.envMapIntensity = 0.55;
  mats.watchGlass.envMapIntensity = 0.5;
  // base IBL strengths; the viewmodel scales them by sky visibility (indoors the sky must not light the hands)
  const baseEnv = new Map();
  for (const m of Object.values(mats)) baseEnv.set(m, m.envMapIntensity);
  Object.defineProperty(mats, '_env', { value: { baseEnv, rim: shared.rim, contactStrong, contactSupport }, enumerable: false });
  return mats;
}
