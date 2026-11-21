import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeRenderer, daylight, load, label, params } from './common.js';

// Bodycam setup like the game: fp_root's origin IS the chest camera. Scene and viewmodel are drawn with the
// game's lens (112 deg horizontal, then the same fisheye resample as src/render/composite.js, uFish 0.7).
const renderer = makeRenderer();
renderer.autoClear = false;
const scene = new THREE.Scene();
daylight(scene);
const crate = new THREE.MeshStandardMaterial({ color: 0x8a6d47, roughness: 0.9 });
for (const [x, z, s] of [[-1.2, -3, 0.8], [1.5, -4.5, 1], [0.2, -6, 0.6]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crate);
  m.position.set(x, s / 2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}
const wall = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 0.2), new THREE.MeshStandardMaterial({ color: 0xa0a4a8 }));
wall.position.set(0, 2, -9);
scene.add(wall);
// aim check: a small target 15 m out on the camera axis (ADS is zeroed there)
const tgt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.02), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
scene.add(tgt);

const vmScene = new THREE.Scene();
vmScene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5048, 1.5));
const key = new THREE.DirectionalLight(0xfff2e0, 2.0);
key.position.set(1, 3, 2);
vmScene.add(key);

const g = await load('/assets/arms/fp_arms_pistol.glb');
const clipsInfo = await (await fetch('/assets/arms/fp_arms_pistol.clips.json')).json();
const fp = g.scene;
fp.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
const CAM_H = 1.42;
fp.position.set(0, CAM_H, 0); // fp_root's origin is the chest camera
vmScene.add(fp);
tgt.position.set(0, CAM_H, -15);
const mixer = new THREE.AnimationMixer(fp);
const clips = g.animations.filter((c) => !c.name.startsWith('fp_pose'));

const view = params.get('view') || 'chest';
const HFOV = Number(params.get('hfov') || 112);
const vfov = (a) => 2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / a) * 180 / Math.PI;
const camScene = new THREE.PerspectiveCamera(vfov(innerWidth / innerHeight), innerWidth / innerHeight, 0.05, 200);
const camVM = new THREE.PerspectiveCamera(vfov(innerWidth / innerHeight), innerWidth / innerHeight, 0.01, 10);
const orbitCam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 50);
const controls = new OrbitControls(orbitCam, renderer.domElement);
orbitCam.position.fromArray((params.get('camx') || '0.6,1.45,-0.1').split(',').map(Number));
controls.target.fromArray((params.get('tgt') || '0,1.36,-0.33').split(',').map(Number));
controls.update();
for (const c of [camScene, camVM]) { c.position.set(0, CAM_H, 0); c.rotation.set(0, 0, 0); c.updateMatrixWorld(); }

// fisheye composite (same mapping as the game's composite pass)
const size = new THREE.Vector2();
renderer.getDrawingBufferSize(size);
const rt = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, colorSpace: THREE.SRGBColorSpace });
const fishMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: rt.texture }, uAspect: { value: innerWidth / innerHeight }, uTanHalfV: { value: 1 }, uFish: { value: params.has('nofish') ? 0 : 0.7 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D t; uniform float uAspect, uTanHalfV, uFish; varying vec2 vUv;
    void main(){ vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0); float r = length(p);
      float thetaEdge = atan(uTanHalfV * uAspect); float theta = r * thetaEdge / uAspect;
      float rs = tan(min(theta, 1.45)) / uTanHalfV; float rm = mix(r, rs, uFish);
      vec2 q = r > 1e-5 ? p * (rm / r) : p; vec2 uv = (q / vec2(uAspect, 1.0)) * 0.5 + 0.5;
      gl_FragColor = texture2D(t, clamp(uv, 0.0, 1.0)); }`,
  depthTest: false, depthWrite: false,
});
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fishMat);
const postScene = new THREE.Scene(); postScene.add(post);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function fit() {
  const a = innerWidth / innerHeight;
  for (const c of [camScene, camVM]) { c.aspect = a; c.fov = vfov(a); c.updateProjectionMatrix(); }
  orbitCam.aspect = a; orbitCam.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.getDrawingBufferSize(size); rt.setSize(size.x, size.y);
  fishMat.uniforms.uAspect.value = a;
  fishMat.uniforms.uTanHalfV.value = Math.tan((camScene.fov * Math.PI) / 360);
}
fit();
addEventListener('resize', fit);

const sel = document.getElementById('clip');
for (const c of clips) sel.add(new Option(`${c.name} (${c.duration.toFixed(2)}s)`, c.name));
const viewSel = document.getElementById('view');
viewSel.value = view;
let mode = view;
viewSel.onchange = () => { mode = viewSel.value; };
const cycle = document.getElementById('cycle');
let current, start = 0;
function play(name, t = 0) {
  current = clips.find((c) => c.name === name) || clips[0];
  sel.value = current.name;
  mixer.stopAllAction();
  const info = clipsInfo.find((c) => c.name === current.name) || {};
  const a = mixer.clipAction(current);
  a.setLoop(info.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  a.clampWhenFinished = true;
  a.play();
  mixer.setTime(t);
  start = performance.now() / 1000 - t;
  label(`${current.name}  t=${t.toFixed(2)}/${current.duration.toFixed(2)}s  ${info.loop ? 'loop' : 'once'}  ${info.source || ''}\nview: ${mode === 'orbit' ? 'orbit inspect' : `chest camera, ${HFOV} deg horizontal + bodycam fisheye (same as the game)`}`);
}
sel.onchange = () => play(sel.value);
const paused = params.has('paused');
if (paused) cycle.checked = false;
play(params.get('clip') || 'fp_idle', Number(params.get('t') || 0));

window.__clips = clipsInfo;
window.__setClip = (n, t) => { play(n, t); mixer.update(0); render(); return true; };
window.__orbit = (cam, target) => { mode = 'orbit'; orbitCam.position.fromArray(cam); controls.target.fromArray(target); controls.update(); render(); return true; };
window.__chest = () => { mode = 'chest'; render(); return true; };
const clock = new THREE.Clock();
function render() {
  if (mode === 'orbit') {
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, orbitCam);
    renderer.render(vmScene, orbitCam);
    return;
  }
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camScene);
  renderer.clearDepth();
  renderer.render(vmScene, camVM);
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(postScene, postCam);
}
renderer.setAnimationLoop(() => {
  mixer.update(paused ? 0 : clock.getDelta());
  if (cycle.checked && current && performance.now() / 1000 - start > Math.max(2.5, current.duration * 1.5)) {
    play(clips[(clips.indexOf(current) + 1) % clips.length].name);
  }
  controls.update();
  render();
  window.__ready = true;
});
