// Render pipeline: scene (+ first-person view) → ONE HDR scene target → ONE composite pass to the canvas.
// No shadow maps, no extra full-screen passes, dynamic resolution via the target viewport (no reallocations).
// Owner: core (structure) / B (look parameters). Exposes ctx.render (see CONTRACT.md §render).
import * as THREE from 'three';
import { U } from './materials.js';
import { createCompositeMaterial } from './composite.js';
import { createSky } from './sky.js';
import { createOsd } from './osd.js';

export function createPipeline(ctx, canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  renderer.autoClear = false;
  renderer.info.autoReset = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  const gl = renderer.getContext();
  const hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;
  const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 700);
  camera.rotation.order = 'YXZ';
  // first-person layer (arms + weapon): own scene/camera, drawn after clearing depth (C owns the content)
  const vmScene = new THREE.Scene();
  const vmCamera = new THREE.PerspectiveCamera(70, 16 / 9, 0.01, 10);

  const compMat = createCompositeMaterial();
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(quadGeo, compMat);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene(); postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const osd = createOsd();
  compMat.uniforms.tOsd.value = osd.texture;

  let rt = null, rtKey = '';
  const out = { w: 0, h: 0 }, internal = { w: 0, h: 0 };
  const texTrack = new Map();   // name → bytes (estimate, for the perf HUD)

  function ensureTarget(maxW, maxH) {
    const t = ctx.quality.tier;
    const key = `${maxW}x${maxH}:${t.msaa}:${t.bloom > 0}`;
    if (key === rtKey) return;
    rt?.dispose();
    const bloom = t.bloom > 0;
    rt = new THREE.WebGLRenderTarget(maxW, maxH, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      depthBuffer: true, stencilBuffer: false, samples: t.msaa,
      generateMipmaps: bloom, minFilter: bloom ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    rt.texture.name = 'sceneHDR';
    rtKey = key;
    const bpp = hdr ? 8 : 4;
    texTrack.set('sceneTarget', maxW * maxH * (bpp * (bloom ? 1.34 : 1) + 4) * (t.msaa ? t.msaa + 1 : 1));
    compMat.uniforms.tScene.value = rt.texture;
  }

  function resize() {
    const t = ctx.quality.tier;
    const cw = Math.max(1, canvas.clientWidth), ch = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let h = Math.min(Math.round(ch * dpr), t.outH);
    let w = Math.round(h * cw / ch);
    if (w !== out.w || h !== out.h) {
      out.w = w; out.h = h;
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
    }
    const s = ctx.quality.scale;
    internal.w = Math.max(64, Math.round(w * s)); internal.h = Math.max(36, Math.round(h * s));
    ensureTarget(Math.round(w * t.scaleMax), Math.round(h * t.scaleMax));
    internal.w = Math.min(internal.w, rt.width); internal.h = Math.min(internal.h, rt.height);
    const aspect = w / h;
    const hfov = (ctx.settings.data.fov ?? 112) * Math.PI / 180;
    const tanV = Math.tan(hfov / 2) / aspect;
    camera.aspect = aspect; camera.fov = 2 * Math.atan(tanV) * 180 / Math.PI; camera.updateProjectionMatrix();
    vmCamera.aspect = aspect; vmCamera.fov = camera.fov; vmCamera.updateProjectionMatrix();
    const cu = compMat.uniforms;
    cu.uAspect.value = aspect; cu.uTanHalfV.value = tanV;
    cu.uRes.value.set(w, h); cu.uSrcRes.value.set(internal.w, internal.h);
    cu.uScale.value.set(internal.w / rt.width, internal.h / rt.height);
    cu.uBloom.value = t.bloom; cu.uNoise.value = t.noise;
    const os = h / 720;
    cu.uOsdRect.value.set(Math.round(18 * os), Math.round(14 * os), Math.round(osd.width * 0.62 * os), Math.round(osd.height * 0.62 * os));
  }

  const sky = createSky(ctx.layout.sky, ctx.layout.sun);
  scene.add(sky);

  const stats = { calls: 0, triangles: 0, sceneCalls: 0, sceneTriangles: 0, textures: 0, textureMB: 0, passes: 0 };

  function render() {
    resize();
    renderer.info.reset();
    U.uTime.value = ctx.time.now;
    sky.position.copy(camera.position);
    camera.updateMatrixWorld();
    // scene → target (viewport = dynamic resolution)
    rt.viewport.set(0, 0, internal.w, internal.h);
    rt.scissor.set(0, 0, internal.w, internal.h);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    if (vmScene.children.length) {
      renderer.clearDepth();
      vmCamera.updateMatrixWorld();
      renderer.render(vmScene, vmCamera);
    }
    stats.sceneCalls = renderer.info.render.calls; stats.sceneTriangles = renderer.info.render.triangles;
    // composite → canvas (the only full-screen pass)
    osd.update(ctx.time.mission ?? ctx.time.now);
    compMat.uniforms.uTime.value = ctx.time.now;
    compMat.uniforms.uFrame.value = ctx.time.frame % 4096;
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, out.w, out.h);
    renderer.render(postScene, postCam);
    stats.calls = renderer.info.render.calls; stats.triangles = renderer.info.render.triangles;
    stats.passes = 2;
    stats.textures = renderer.info.memory.textures;
    let b = 0; for (const v of texTrack.values()) b += v;
    stats.textureMB = b / 1048576;
  }

  /** compile every material in the scenes now (no shader compiles during play) */
  async function warmup() {
    resize();
    const t0 = performance.now();
    if (renderer.compileAsync) {
      await renderer.compileAsync(scene, camera);
      if (vmScene.children.length) await renderer.compileAsync(vmScene, vmCamera);
      await renderer.compileAsync(postScene, postCam);
    } else { renderer.compile(scene, camera); renderer.compile(vmScene, vmCamera); renderer.compile(postScene, postCam); }
    // one real frame with everything visible uploads all buffers/textures before play
    const hidden = [];
    scene.traverse((o) => { if (o.isMesh && !o.visible) { hidden.push(o); o.visible = true; } });
    render();
    for (const o of hidden) o.visible = false;
    return performance.now() - t0;
  }

  return {
    renderer, gl, hdr, scene, camera, vmScene, vmCamera, composite: compMat, sky, osd, stats, U,
    resolution: { out, internal },
    render, resize, warmup,
    /** register an estimated texture size for the perf HUD (bytes) */
    trackTexture(name, bytes) { if (bytes) texTrack.set(name, bytes); else texTrack.delete(name); },
  };
}
