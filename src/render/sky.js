// Sky dome drawn last at the far plane (fills only uncovered pixels). Radiance model mirrors
// src/world/skymodel.js (used by the bake) — keep in sync. Owner: B.
import * as THREE from 'three';
import { U } from './materials.js';

export function createSky(sky, sun) {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const mat = new THREE.ShaderMaterial({
    name: 'S9Sky',
    uniforms: {
      uExposure: U.uExposure,
      uZenith: { value: new THREE.Vector3(...sky.zenith) }, uHorizon: { value: new THREE.Vector3(...sky.horizon) },
      uGround: { value: new THREE.Vector3(...sky.ground) }, uGlow: { value: sky.glow }, uScale: { value: sky.scale },
      uSunDir: { value: new THREE.Vector3(...sun.dir) }, uSunColor: { value: new THREE.Vector3(...sun.color) },
      uSunI: { value: sun.intensity },
    },
    side: THREE.BackSide, depthWrite: false, depthTest: true,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;   // at the far plane
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor;
      uniform float uGlow, uScale, uExposure, uSunI;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c;
        if (d.y < 0.0) c = mix(uHorizon * 0.8, uGround, smoothstep(0.0, 0.08, -d.y));
        else {
          float t = sqrt(min(1.0, d.y));
          float cs = max(0.0, dot(d, uSunDir));
          c = uHorizon + (uZenith - uHorizon) * t + uGlow * pow(cs, 8.0) * uSunColor;
          c += uSunColor * uSunI * 60.0 * smoothstep(0.9995, 0.9998, cs);   // sun disc
        }
        gl_FragColor = vec4(c * uScale * uExposure, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.name = 'sky';
  return mesh;
}
