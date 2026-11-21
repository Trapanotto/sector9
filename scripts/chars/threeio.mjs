// Helpers to use three.js r170 GLTFLoader headless in Node (geometry/animation only).
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// GLTFLoader only touches these for images; we never decode textures here.
globalThis.self ??= globalThis;
if (!globalThis.createImageBitmap) globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

/** Drop texture references from a GLB (geometry/animation-only loading in Node). */
function stripTextures(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const js = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  if (!js.textures) return buf;
  for (const m of js.materials || []) {
    if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture;
    delete m.normalTexture;
  }
  delete js.textures; delete js.images; delete js.samplers;
  js.extensionsRequired = (js.extensionsRequired || []).filter((e) => e !== 'EXT_texture_webp');
  let j = Buffer.from(JSON.stringify(js));
  const pad = (4 - (j.length % 4)) % 4;
  j = Buffer.concat([j, Buffer.alloc(pad, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + j.length + rest.length, 8);
  head.writeUInt32LE(j.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, j, rest]);
}

export async function loadGLB(path) {
  const buf = stripTextures(fs.readFileSync(path));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder?.((await import('three/examples/jsm/libs/meshopt_decoder.module.js')).MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

export { THREE };
