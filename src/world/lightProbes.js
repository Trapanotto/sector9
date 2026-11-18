// Local reflection probes: one cube capture per zone (hall, corridor, each side room, bay, yard), prefiltered with
// PMREMGenerator and copied into one texture array so the global light patch can pick / blend them per pixel with
// box-projected (parallax-corrected) lookups.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LP, MAX_REFL, REFL_SIZE } from './lightShader.js';
import { ZONES } from './layout.js';

// One probe per layout zone (rooms, halls, basement sections). Zone 0 is the outdoor default: it fills whatever
// weight the interior zones leave. Multi-box zones use their largest box for the parallax correction.
const vol = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
export const REFL_ZONES = ZONES.map((z, i) => {
  const b = i === 0 ? { min: [-60, -0.05, -80], max: [80, 40, 70] } : [...z.boxes].sort((p, q) => vol(q) - vol(p))[0];
  return { name: z.name, min: b.min, max: b.max, pos: z.probe, zone: i };
});

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
  function capture(scene, { hide = [], normAt = null, culler = null } = {}) {
    const t0 = performance.now();
    const prevOn = LP.lpReflOn.value, prevRT = renderer.getRenderTarget();
    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    LP.lpReflOn.value = 0;      // captured surfaces use the GI volume for their own specular (no feedback)
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    for (let i = 0; i < N; i++) {
      const z = REFL_ZONES[i];
      if (culler) culler.showOnly(culler.neighbourhood(z.zone, i === 0 ? 1 : 2));
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
