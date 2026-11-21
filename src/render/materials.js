// Scene materials. Owner: B (look). All scene shaders write EXPOSED linear HDR (× uExposure) into the scene
// target; the composite pass does tone mapping and the bodycam look. Every material shares ONE uniform set
// (`U`, below) so a frame updates flashlight/exposure/circuits once for all of them.
//
//   createStaticMaterial()            merged world geometry: lightmap + vertex-baked light, circuits, emissive
//   createTransparentMaterial()       glass panes + see-through mesh (fences, curtains) of the static world
//   createDynamicMaterial(opts)       moving objects (doors, AGVs, enemies, weapon): probe volume lighting,
//                                     supports skinning / instancing / an albedo map; opts.probe = 'uniform' uses
//                                     U.uProbeAmb/uProbeDir/uProbeSun (CPU-sampled, for the first-person view)
//   convertToDynamic(object3D, opts)  replace glTF materials (MeshStandard…) by dynamic materials (keeps map/color)
import * as THREE from 'three';

export const MAX_CIRCUITS = 8;

/** Shared uniforms (mutated in place each frame by pipeline / world / player). */
export const U = {
  uExposure: { value: 1 },
  uTime: { value: 0 },
  uLmDay: { value: null }, uLmArt: { value: null },
  uCirc: { value: new Float32Array(MAX_CIRCUITS).fill(1) },
  uFlashPos: { value: new THREE.Vector3() }, uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
  uFlashColor: { value: new THREE.Vector3(0, 0, 0) }, uFlashCone: { value: new THREE.Vector2(0.82, 0.97) },
  uFlashRange: { value: 28 },
  uMuzzlePos: { value: new THREE.Vector3() }, uMuzzleColor: { value: new THREE.Vector3() },
  uFogColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uFogDensity: { value: 0.004 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) },
  uProbeL0: { value: null }, uProbeDirSun: { value: null }, uProbeArt: { value: null },
  uProbeOrigin: { value: new THREE.Vector3() }, uProbeInvSize: { value: new THREE.Vector3(1, 1, 1) },
  uProbeArtLevel: { value: 1 },
  uProbeAmb: { value: new THREE.Vector3(0.3, 0.3, 0.3) }, uProbeDirU: { value: new THREE.Vector3() }, uProbeSunU: { value: 0 },
  uGrid: { value: 1 },   // greybox 1 m grid lines (B may switch off when textures arrive)
};

const COMMON = /* glsl */`
uniform float uExposure, uTime, uFlashRange, uFogDensity, uGrid;
uniform vec3 uFlashPos, uFlashDir, uFlashColor, uMuzzlePos, uMuzzleColor, uFogColor, uSunDir, uSunColor;
uniform vec2 uFlashCone;
vec3 decodeRGBM(vec4 c) { return c.rgb * c.a * 16.0; }
// flashlight (unshadowed spot) + muzzle flash (point), the only dynamic lights
vec3 dynLight(vec3 P, vec3 N) {
  vec3 L = uFlashPos - P; float d2 = max(dot(L, L), 1e-4); float d = sqrt(d2); L /= d;
  float cd = dot(-L, uFlashDir);
  float spot = smoothstep(uFlashCone.x, uFlashCone.y, cd) * (0.55 + 0.45 * smoothstep(uFlashCone.y, 1.0, cd));
  float att = spot / (0.35 + d2 * 0.09) * clamp(1.0 - d / uFlashRange, 0.0, 1.0);
  vec3 c = uFlashColor * (att * max(dot(N, L), 0.0));
  vec3 M = uMuzzlePos - P; float m2 = max(dot(M, M), 1e-3);
  c += uMuzzleColor * (max(dot(N, M * inversesqrt(m2)), 0.0) / (0.2 + m2));
  return c;
}
vec3 applyFog(vec3 c, float dist) { return mix(uFogColor, c, exp(-uFogDensity * dist)); }
float gridLines(vec3 wp, vec3 n) {
  vec3 a = abs(n);
  vec2 q = a.y > 0.5 ? wp.xz : (a.x > 0.5 ? wp.zy : wp.xy);
  vec2 g = abs(fract(q + 0.5) - 0.5) / max(fwidth(q), 1e-4);
  return 1.0 - 0.10 * uGrid * (1.0 - clamp(min(g.x, g.y), 0.0, 1.0));
}
`;

export function createStaticMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9Static',
    uniforms: { ...U, uCirc: U.uCirc },
    vertexShader: /* glsl */`
      uniform float uCirc[${MAX_CIRCUITS}];
      attribute vec4 aColor; attribute vec2 aLmUv; attribute vec4 aVlDay; attribute vec4 aVlArt; attribute vec4 aMisc;
      varying vec3 vAlbedo; varying vec2 vLmUv; varying vec3 vVl; varying float vCirc; varying float vEmit;
      varying vec3 vWorld; varying vec3 vN; varying float vDist;
      vec3 dec(vec4 c) { return c.rgb * c.a * 16.0; }
      void main() {
        vAlbedo = aColor.rgb;
        vLmUv = aLmUv;
        vCirc = uCirc[int(aMisc.x + 0.5)];
        vVl = dec(aVlDay) + dec(aVlArt) * vCirc;
        vEmit = aMisc.y / 16.0;
        vec4 wp = modelMatrix * vec4(position, 1.0);   // merged zone meshes: translation only
        vWorld = wp.xyz; vN = normal;
        vec4 mv = viewMatrix * wp;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      ${COMMON}
      uniform sampler2D uLmDay, uLmArt;
      varying vec3 vAlbedo; varying vec2 vLmUv; varying vec3 vVl; varying float vCirc; varying float vEmit;
      varying vec3 vWorld; varying vec3 vN; varying float vDist;
      void main() {
        vec3 light = decodeRGBM(texture(uLmDay, vLmUv)) + decodeRGBM(texture(uLmArt, vLmUv)) * vCirc + vVl;
        light += dynLight(vWorld, normalize(vN));
        vec3 c = vAlbedo * light * gridLines(vWorld, vN) + vAlbedo * vEmit * vCirc * 4.0;
        c = applyFog(c, vDist);
        gl_FragColor = vec4(c * uExposure, 1.0);
      }`,
  });
}

export function createTransparentMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9Glass',
    uniforms: { ...U },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec4 aColor;
      varying vec4 vColor; varying vec3 vWorld; varying vec3 vN; varying float vDist;
      void main() {
        vColor = aColor; vN = normal;
        vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp; vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      ${COMMON}
      varying vec4 vColor; varying vec3 vWorld; varying vec3 vN; varying float vDist;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(V, normalize(vN))), 4.0);
        // glass: faint tint + fresnel sky reflection; mesh (alpha > 0.3): dark wire, lit by fog colour
        vec3 refl = uFogColor * 1.6;
        vec3 c = mix(vColor.rgb * uFogColor * 1.2, refl, fres);
        float a = clamp(vColor.a + fres * 0.5, 0.0, 0.85);
        c += dynLight(vWorld, normalize(vN)) * vColor.rgb;
        gl_FragColor = vec4(applyFog(c, vDist) * uExposure, a);
      }`,
  });
}

/** opts: { color, map, skinning (auto), probe: 'volume'|'uniform', emissive: [r,g,b] } */
export function createDynamicMaterial(opts = {}) {
  const defines = {};
  if (opts.map) defines.USE_S9MAP = '';
  if (opts.probe === 'uniform') defines.PROBE_UNIFORM = '';
  const m = new THREE.ShaderMaterial({
    name: 'S9Dynamic',
    defines,
    uniforms: {
      ...U,
      uColor: { value: new THREE.Color(...(opts.color ?? [0.6, 0.6, 0.6])) },
      uMap: { value: opts.map ?? null },
      uEmissive: { value: new THREE.Vector3(...(opts.emissive ?? [0, 0, 0])) },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform sampler3D uProbeL0, uProbeDirSun, uProbeArt;
      uniform vec3 uProbeOrigin, uProbeInvSize, uSunDir, uSunColor, uProbeAmb, uProbeDirU;
      uniform float uProbeArtLevel, uProbeSunU;
      varying vec3 vIrr; varying vec3 vWorld; varying vec3 vN; varying float vDist; varying vec2 vUv;
      vec3 dec(vec4 c) { return c.rgb * c.a * 16.0; }
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          objectNormal = mat3(instanceMatrix) * objectNormal;
        #endif
        wp = modelMatrix * wp;
        vec3 N = normalize(mat3(modelMatrix) * objectNormal);
        #ifdef PROBE_UNIFORM
          vec3 l0 = uProbeAmb; vec3 pd = uProbeDirU; float sv = uProbeSunU; vec3 art = vec3(0.0);
        #else
          vec3 uvw = (wp.xyz - uProbeOrigin) * uProbeInvSize;
          vec3 l0 = dec(texture(uProbeL0, uvw));
          vec4 ds = texture(uProbeDirSun, uvw);
          vec3 pd = ds.xyz * 2.0 - 1.0; float sv = ds.w;
          vec3 art = dec(texture(uProbeArt, uvw)) * uProbeArtLevel;
        #endif
        vIrr = l0 * max(0.15, 1.0 + dot(pd, N)) + art + uSunColor * (sv * max(dot(N, uSunDir), 0.0));
        vWorld = wp.xyz; vN = N; vUv = uv;
        vec4 mv = viewMatrix * wp; vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      ${COMMON}
      uniform vec3 uColor, uEmissive;
      #ifdef USE_S9MAP
        uniform sampler2D uMap;
      #endif
      varying vec3 vIrr; varying vec3 vWorld; varying vec3 vN; varying float vDist; varying vec2 vUv;
      void main() {
        vec3 albedo = uColor;
        #ifdef USE_S9MAP
          albedo *= texture(uMap, vUv).rgb;
        #endif
        vec3 c = albedo * (vIrr + dynLight(vWorld, normalize(vN))) + uEmissive;
        gl_FragColor = vec4(applyFog(c, vDist) * uExposure, 1.0);
      }`,
  });
  return m;
}

/** Replace the materials of a loaded model (glTF) by dynamic materials, keeping colour + base colour map. */
export function convertToDynamic(root, opts = {}) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const conv = (src) => {
      if (cache.has(src)) return cache.get(src);
      const map = src.map ?? null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const c = src.color ? [src.color.r, src.color.g, src.color.b] : [0.6, 0.6, 0.6];
      const m = createDynamicMaterial({ ...opts, map, color: c });
      cache.set(src, m);
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
  return root;
}
