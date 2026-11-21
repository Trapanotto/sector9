// Enemy materials: the contract's dynamic material (probe-lit, skinning, instancing) with two small D-local
// shader patches, plus the cheap contact-shadow blobs. Owner: D.
//  - characters: bodycam privacy mosaic over the head (vertices skinned to the Head bone): screen-space blocks of
//    ~5 cm, colour from a blurred texture mip extrapolated to the block centre (also hides the weak faces)
//  - weapons: vertex colours (the CC0 weapon models are vertex-coloured)
import * as THREE from 'three';
import { createDynamicMaterial, U } from '../render/materials.js';

export function createCharacterMaterial(map, headInv, tint = [1, 1, 1]) {
  const m = createDynamicMaterial({ map, color: tint });
  m.name = 'S9Enemy';
  m.uniforms.uHeadInv = { value: headInv };   // inverse bind matrix of the Head bone
  m.uniforms.uPixelate = { value: 1 };   // settings.pixelateFaces
  m.vertexShader = m.vertexShader
    .replace('varying vec3 vIrr;', 'uniform mat4 uHeadInv; varying float vHead; varying vec3 vIrr;')
    .replace('vec4 wp = vec4(transformed, 1.0);', `vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_SKINNING
          // rest pose in Head-bone space: above the chin line (y > -0.065 bone units) = head (hair, face, ears)
          vec4 hp = uHeadInv * bindMatrix * vec4(position, 1.0);
          vHead = step(-0.065, hp.y) * step(length(hp.xz), 0.16);
        #else
          vHead = 0.0;
        #endif`);
  m.fragmentShader = m.fragmentShader
    .replace('varying vec3 vIrr;', 'uniform float uPixelate; varying float vHead; varying vec3 vIrr;')
    .replace('albedo *= texture(uMap, vUv).rgb;', `
// privacy mosaic (head): the head's texture sampled on a coarse grid in atlas space (cells stay on
          // the face island, move rigidly with the head; reads as a pixelated face at any distance)
          float hm = step(0.5, vHead) * uPixelate;
          vec2 uvQ = (floor(vUv * 12.0) + 0.5) / 12.0;
          vec3 mos = textureLod(uMap, uvQ, 2.5).rgb;
          mos = mix(vec3(dot(mos, vec3(0.3, 0.55, 0.15))), mos, 0.7);
          albedo *= mix(texture(uMap, vUv).rgb, mos, hm);
          vec3 irrUse = vIrr;`)
    .replace('vec3 c = albedo * (vIrr + dynLight(vWorld, normalize(vN))) + uEmissive;', `
        #ifdef USE_S9MAP
          vec3 c = albedo * (irrUse + dynLight(vWorld, normalize(vN))) + uEmissive;
        #else
          vec3 c = albedo * (vIrr + dynLight(vWorld, normalize(vN))) + uEmissive;
        #endif`);
  return m;
}

export function createWeaponMaterial() {
  const m = createDynamicMaterial({ color: [1, 1, 1] });
  m.name = 'S9EnemyWeapon';
  m.vertexColors = true;
  m.vertexShader = m.vertexShader
    .replace('varying vec3 vIrr;', 'varying vec3 vCol; varying vec3 vIrr;')
    .replace('vec4 wp = vec4(transformed, 1.0);', `vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_COLOR
          vCol = color.rgb;
        #else
          vCol = vec3(1.0);
        #endif`);
  m.fragmentShader = m.fragmentShader
    .replace('varying vec3 vIrr;', 'varying vec3 vCol; varying vec3 vIrr;')
    .replace('vec3 albedo = uColor;', 'vec3 albedo = uColor * vCol;');
  return m;
}

/** contact shadow: multiplicative darkening disc on the floor (one instanced draw for every visible enemy) */
export function createBlobMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9EnemyBlob',
    uniforms: { uFogDensity: U.uFogDensity },
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() {
        vP = position.xz * 2.0;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float k = (1.0 - smoothstep(0.25, 1.0, r)) * 0.55;
        gl_FragColor = vec4(vec3(1.0 - k), 1.0);
      }`,
  });
}

/** visible torch beam (enemy flashlights; no extra dynamic light — the contract allows one): additive cone */
export function createTorchMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9EnemyTorch',
    uniforms: { uExposure: U.uExposure },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying float vT; varying vec3 vW; varying vec3 vN;
      void main() {
        vT = clamp(position.z / 7.0, 0.0, 1.0);
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uExposure;
      varying float vT; varying vec3 vW; varying vec3 vN;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float edge = pow(1.0 - abs(dot(V, normalize(vN))), 1.5);   // soft volume look: fades at the silhouette
        float near = smoothstep(0.8, 4.0, length(cameraPosition - vW));   // no full-screen wash when looking into it
        float a = (1.0 - vT) * (1.0 - vT) * (1.0 - edge) * (1.0 - edge) * near * smoothstep(0.0, 0.06, vT) * 0.09;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * a * 1.6 * uExposure, 1.0);
      }`,
  });
}