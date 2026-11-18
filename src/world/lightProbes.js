// Local reflection probes: one cube capture per zone (hall, corridor, each side room, bay, yard), prefiltered with
// PMREMGenerator and copied into one texture array so the global light patch can pick / blend them per pixel with
// box-projected (parallax-corrected) lookups.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LP, MAX_REFL, REFL_SIZE } from './lightShader.js';

// Zone 0 is the outdoor default: it fills whatever weight the interior zones leave.
export const REFL_ZONES = [
  { name: 'yard', min: [-30, -0.05, 16.0], max: [26, 40, 32], pos: [-4, 1.7, 20.5] },
  { name: 'hall', min: [-23.6, 0, -5.8], max: [7.8, 8.0, 15.6], pos: [-5.0, 2.0, 6.5] },
  { name: 'corridor', min: [8.2, 0, -5.8], max: [10.6, 3.2, 15.6], pos: [9.4, 1.6, 5.0] },
  { name: 'office', min: [11.0, 0, 10.2], max: [19.6, 3.2, 15.6], pos: [16.2, 1.6, 12.9] },
  { name: 'lockers', min: [11.0, 0, 4.6], max: [19.6, 3.2, 9.8], pos: [16.6, 1.6, 8.2] },
  { name: 'storage', min: [11.0, 0, -1.0], max: [19.6, 3.2, 4.2], pos: [13.0, 1.6, 2.0] },
  { name: 'control', min: [11.0, 0, -5.8], max: [19.6, 3.2, -1.4], pos: [15.0, 1.6, -3.6] },
  { name: 'bay', min: [-23.6, 0, -17.6], max: [19.6, 7.0, -6.2], pos: [-4.0, 2.2, -11.6] },
];

export function createReflectionProbes(renderer) {
  const N = Math.min(MAX_REFL, REFL_ZONES.length);
  const arrayRT = new THREE.WebGLArrayRenderTarget(REFL_SIZE.w, REFL_SIZE.h, N, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  arrayRT.texture.minFilter = arrayRT.texture.magFilter = THREE.LinearFilter;
  const cubeRT = new THREE.WebGLCubeRenderTarget(REFL_SIZE.cube, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cubeCam = new THREE.CubeCamera(0.05, 150, cubeRT);
  cubeCam.layers.enableAll();
  for (const c of cubeCam.children) c.layers.enableAll();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const copy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tSrc; void main(){ gl_FragColor = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }',
    depthTest: false, depthWrite: false,
  }));

  for (let i = 0; i < N; i++) {
    const z = REFL_ZONES[i];
    LP.lpReflMin.value[i].set(...z.min);
    LP.lpReflMax.value[i].set(...z.max);
    LP.lpReflPos.value[i].set(...z.pos);
  }

  /** Captures all probes. hide: objects to hide during the capture (moving things). normAt(x,y,z) -> luminance. */
  function capture(scene, { hide = [], normAt = null } = {}) {
    const t0 = performance.now();
    const prevOn = LP.lpReflOn.value, prevRT = renderer.getRenderTarget();
    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    LP.lpReflOn.value = 0;      // captured surfaces use the GI volume for their own specular (no feedback)
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    for (let i = 0; i < N; i++) {
      const z = REFL_ZONES[i];
      cubeCam.position.set(...z.pos);
      cubeCam.updateMatrixWorld(true);
      cubeCam.update(renderer, scene);
      const pm = pmrem.fromCubemap(cubeRT.texture);
      copy.material.uniforms.tSrc.value = pm.texture;
      renderer.setRenderTarget(arrayRT, i);
      copy.render(renderer);
      pm.dispose();
      LP.lpReflNorm.value[i] = normAt ? Math.max(1e-4, normAt(...z.pos)) : 1;
    }
    hide.forEach((o, k) => { o.visible = vis[k]; });
    renderer.setRenderTarget(prevRT);
    renderer.toneMapping = prevTM;
    LP.lpRefl.value = arrayRT.texture;
    LP.lpReflCount.value = N;
    LP.lpReflOn.value = prevOn || 1;
    return performance.now() - t0;
  }

  return { capture, zones: REFL_ZONES, texture: arrayRT.texture };
}
