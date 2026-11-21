import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const params = new URLSearchParams(location.search);

export function makeRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  return renderer;
}

export function daylight(scene) {
  scene.background = new THREE.Color(0x9aa3ab);
  scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5048, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
  sun.position.set(4, 8, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 });
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(60, 60, 0x333333, 0x555555);
  grid.position.y = 0.001;
  scene.add(grid);
  return sun;
}

/** 1.8 m reference pole with 10 cm ticks. */
export function heightPole(x = 0, z = 0) {
  const g = new THREE.Group();
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.03),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffffff : 0xd02020 }));
    m.position.y = 0.05 + i * 0.1;
    g.add(m);
  }
  g.position.set(x, 0, z);
  return g;
}

export const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
export const load = (url) => loader.loadAsync(url);

export function label(text) {
  let el = document.getElementById('label');
  if (!el) {
    el = document.createElement('div');
    el.id = 'label';
    el.style.cssText = 'position:fixed;left:8px;top:8px;font:14px/1.4 monospace;color:#fff;background:#000a;padding:6px 10px;white-space:pre;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = text;
}
