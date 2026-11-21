import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeRenderer, daylight, load, label, params } from './common.js';

// Bodycam setup: scene camera ~0.25 m below the eye with a wide 95 deg FOV; the arms are drawn
// by a second "viewmodel" camera at the same place with a 70 deg FOV after clearing depth.
const renderer = makeRenderer();
renderer.autoClear = false;
const scene = new THREE.Scene();
daylight(scene);
// some context: crates and a wall in front
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

const vmScene = new THREE.Scene();
vmScene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5048, 1.5));
const key = new THREE.DirectionalLight(0xfff2e0, 2.0);
key.position.set(1, 3, 2);
vmScene.add(key);

const g = await load('/assets/arms/fp_arms_pistol.glb');
const clipsInfo = await (await fetch('/assets/arms/fp_arms_pistol.clips.json')).json();
const fp = g.scene;
fp.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
const EYE_H = 1.65;
fp.position.set(0, EYE_H, 0); // fp_root puts the eye at its origin
vmScene.add(fp);
const mixer = new THREE.AnimationMixer(fp);
const clips = g.animations;

const view = params.get('view') || 'chest';
const camScene = new THREE.PerspectiveCamera(95, innerWidth / innerHeight, 0.05, 200);
const camVM = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 10);
const orbitCam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 50);
const controls = new OrbitControls(orbitCam, renderer.domElement);
orbitCam.position.fromArray((params.get('camx') || '0.6,1.55,-0.2').split(',').map(Number));
controls.target.fromArray((params.get('tgt') || '0,1.45,-0.45').split(',').map(Number));
controls.update();
function placeCams(v) {
  const y = v === 'eye' ? EYE_H : EYE_H - 0.25;
  for (const c of [camScene, camVM]) { c.position.set(0, y, 0.02); c.rotation.set(0, 0, 0); c.updateMatrixWorld(); }
}
placeCams(view);
addEventListener('resize', () => {
  for (const c of [camScene, camVM, orbitCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
  renderer.setSize(innerWidth, innerHeight);
});

const sel = document.getElementById('clip');
for (const c of clips) sel.add(new Option(`${c.name} (${c.duration.toFixed(2)}s)`, c.name));
const viewSel = document.getElementById('view');
viewSel.value = view;
let mode = view;
viewSel.onchange = () => { mode = viewSel.value; placeCams(mode); };
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
  label(`${current.name}  ${current.duration.toFixed(2)}s  ${info.loop ? 'loop' : 'once'}  ${info.source || ''}\nview: ${mode === 'orbit' ? 'orbit inspect' : mode === 'eye' ? 'eye camera' : 'chest camera 0.25 m below eye, scene FOV 95, viewmodel FOV 70'}`);
}
sel.onchange = () => play(sel.value);
const paused = params.has('paused');
if (paused) cycle.checked = false;
play(params.get('clip') || 'fp_idle', Number(params.get('t') || 0));

window.__clips = clipsInfo;
window.__setClip = (n, t) => { play(n, t); mixer.update(0); render(); return true; };
const clock = new THREE.Clock();
function render() {
  renderer.clear();
  if (mode === 'orbit') {
    renderer.render(scene, orbitCam);
    renderer.render(vmScene, orbitCam);
    return;
  }
  renderer.render(scene, camScene);
  renderer.clearDepth();
  renderer.render(vmScene, camVM);
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
