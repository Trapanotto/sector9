// Loads the Poly Haven prop models (public/assets/models, see scripts/models-assets.py) and turns each one into
// a few "parts" (one merged geometry per material) that can be drawn as InstancedMeshes.
// Browser only: nothing here runs in the Node self-test (props.js guards the call).
import * as THREE from 'three';

function modelBase() {
  let base = '/';
  try { base = import.meta.env.BASE_URL || '/'; } catch { /* not under Vite */ }
  return base.replace(/\/?$/, '/') + 'assets/models/';
}
export const MODEL_BASE = modelBase();

// Per-model fix-ups: norm = uniform scale to metres (some sources are authored in decimetres),
// env = envMapIntensity, side = override material side, rough = roughness multiplier clamp.
const FIX = {
  steel_frame_shelves_01: { norm: 0.1 },
  korean_fire_extinguisher_01: { keepAlpha: true },
  plastic_crate_02: { opaque: true },
};

let loaderPromise = null;
async function getLoader() {
  if (!loaderPromise) {
    loaderPromise = import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader());
  }
  return loaderPromise;
}
let mergePromise = null;
async function getMerge() {
  if (!mergePromise) mergePromise = import('three/addons/utils/BufferGeometryUtils.js').then((m) => m.mergeGeometries);
  return mergePromise;
}

const cache = new Map();
let manifestPromise = null;
export function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MODEL_BASE + 'manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return manifestPromise;
}

/**
 * Load one model by Poly Haven id.
 * @returns {Promise<{ id, parts: {geometry, material}[], box: THREE.Box3, info }>}
 */
export function loadModel(id, { env = 0.35, center = false } = {}) {
  if (cache.has(id)) return cache.get(id);
  const p = (async () => {
    const manifest = await loadManifest();
    const info = manifest?.models?.[id];
    if (!info) throw new Error('model not in manifest: ' + id);
    const [loader, merge] = await Promise.all([getLoader(), getMerge()]);
    const gltf = await loader.loadAsync(MODEL_BASE + info.gltf);
    const fix = FIX[id] || {};
    const root = gltf.scene;
    if (fix.norm) root.scale.setScalar(fix.norm);
    root.updateMatrixWorld(true);
    const byMat = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      const m = o.material;
      if (!byMat.has(m)) byMat.set(m, []);
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      byMat.get(m).push(g);
    });
    const parts = [];
    const box = new THREE.Box3();
    for (const [m, list] of byMat) {
      const geometry = list.length === 1 ? list[0] : merge(list, false);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      box.union(geometry.boundingBox);
      tuneMaterial(m, env, fix);
      parts.push({ geometry, material: m });
    }
    // origin: bottom centre (or bounding-box centre for things that get rotated freely, like tyres)
    const c = box.getCenter(new THREE.Vector3());
    const shift = new THREE.Vector3(-c.x, center ? -c.y : -box.min.y, -c.z);
    for (const p of parts) { p.geometry.translate(shift.x, shift.y, shift.z); p.geometry.computeBoundingBox(); p.geometry.computeBoundingSphere(); }
    box.translate(shift);
    return { id, parts, box, info };
  })();
  cache.set(id, p);
  return p;
}

function tuneMaterial(m, env, fix) {
  m.envMapIntensity = env;
  // scans are closed meshes; back faces only cost fill-rate and cause shadow acne
  if (!fix.keepAlpha) m.side = THREE.FrontSide;
  m.shadowSide = THREE.BackSide;
  if (fix.opaque || (!fix.keepAlpha && m.transparent)) { m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true; }
  if (m.map) m.map.anisotropy = 4;
  if (m.aoMap) m.aoMapIntensity = 1.0;
  m.needsUpdate = true;
}

const texLoader = new THREE.TextureLoader();
/** Alternative texture set for a model (Poly Haven ships colour variants for some assets). */
export async function variantMaterial(id, variant, baseMaterial) {
  const manifest = await loadManifest();
  const v = manifest?.models?.[id]?.variants?.[variant];
  if (!v) return baseMaterial;
  const load = (rel, srgb) => new Promise((res) => {
    if (!rel) return res(null);
    texLoader.load(MODEL_BASE + id + '/' + rel, (t) => {
      t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; res(t);
    }, undefined, () => res(null));
  });
  const [diff, nor, arm] = await Promise.all([load(v.diff, true), load(v.nor, false), load(v.arm, false)]);
  const m = baseMaterial.clone();
  if (diff) m.map = diff;
  if (nor) m.normalMap = nor;
  if (arm) { m.roughnessMap = arm; m.metalnessMap = arm; m.aoMap = arm; }
  m.needsUpdate = true;
  return m;
}
