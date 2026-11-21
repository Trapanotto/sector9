// Enemy materials: the contract's dynamic material (probe-lit, skinning, instancing) with two small D-local
// shader patches, plus the cheap contact-shadow blobs. Owner: D.
//  - characters: bodycam privacy mosaic over the head (vertices skinned to the Head bone): screen-space blocks of
//    ~5 cm, colour from a blurred texture mip extrapolated to the block centre (also hides the weak faces)
//  - weapons: vertex colours (the CC0 weapon models are vertex-coloured)
import * as THREE from 'three';
import { createDynamicMaterial, U } from '../render/materials.js';

export function createCharacterMaterial(map, headBone, tint = [1, 1, 1]) {
  const m = createDynamicMaterial({ map, color: tint });
  m.name = 'S9Enemy';
  m.uniforms.uHeadBone = { value: headBone };
  m.vertexShader = m.vertexShader
    .replace('varying vec3 vIrr;', 'uniform float uHeadBone; varying float vHead; varying vec3 vIrr;')
    .replace('vec4 wp = vec4(transformed, 1.0);', `vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_SKINNING
          vHead = dot(skinWeight, vec4(equal(skinIndex, vec4(uHeadBone))));
        #else
          vHead = 0.0;
        #endif`);
  m.fragmentShader = m.fragmentShader
    .replace('varying vec3 vIrr;', 'varying float vHead; varying vec3 vIrr;')
    .replace('albedo *= texture(uMap, vUv).rgb;', `
          // privacy mosaic (head): derivatives outside the branch, blocks ≈ 5 cm on screen
          float mpp = length(fwidth(vWorld)) * 0.7071;
          float blk = clamp(0.055 / max(mpp, 1e-5), 2.0, 48.0);
          vec2 off = (floor(gl_FragCoord.xy / blk) + 0.5) * blk - gl_FragCoord.xy;
          vec2 uvB = vUv + dFdx(vUv) * off.x + dFdy(vUv) * off.y;
          vec3 irrB = vIrr + dFdx(vIrr) * off.x + dFdy(vIrr) * off.y;
          float hm = step(0.5, vHead);
          vec3 tx = mix(texture(uMap, vUv).rgb, textureLod(uMap, uvB, 4.5).rgb * 0.92, hm);
          albedo *= tx;
          vec3 irrUse = mix(vIrr, max(irrB, vec3(0.0)), hm);`)
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
