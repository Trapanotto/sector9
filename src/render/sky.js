// Sky dome drawn last at the far plane (fills only uncovered pixels). Radiance = SKY_GLSL from
// src/world/skymodel.js, the exact model the bake uses for sky light — keep the two in sync there. Owner: B.
import * as THREE from 'three';
import { U } from './materials.js';
import { SKY_GLSL } from '../world/skymodel.js';

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
      ${SKY_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyRadiance(d);
        // sun disc (radiance far above anything else: always clips)
        c += uSunColor * (uSunI * 40.0) * smoothstep(0.99985, 0.99993, dot(d, uSunDir));
        gl_FragColor = vec4(c * uExposure, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.name = 'sky';
  return mesh;
}
