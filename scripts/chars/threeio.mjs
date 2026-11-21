// Helpers to use three.js r170 GLTFLoader headless in Node (geometry/animation only).
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// GLTFLoader only touches these for images; we never decode textures here.
globalThis.self ??= globalThis;
if (!globalThis.createImageBitmap) globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

export async function loadGLB(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder?.((await import('three/examples/jsm/libs/meshopt_decoder.module.js')).MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

export { THREE };
