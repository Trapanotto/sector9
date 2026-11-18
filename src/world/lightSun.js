// Static sun shadow: one high-resolution orthographic depth map of every static caster, rendered once at load
// (and again via refresh() when late props arrive). Sampled with hardware PCF by the global light patch.
// Moving objects get their sun shadows from three's own (small, per-frame) shadow map on the sun light,
// from which the static casters are excluded (see excludeFromSunCascade).
import * as THREE from 'three';
import { LP } from './lightShader.js';

// Is this object part of the static world? (own or ancestor flag; never anything attached to the camera)
export function isStatic(o, camera) {
  if (o.isSkinnedMesh) return false;
  let static_ = false;
  for (let p = o; p; p = p.parent) {
    if (p === camera || p.userData?.dynamic) return false;
    if (p.userData?.static === true || p.matrixAutoUpdate === false) static_ = true;
  }
  return static_;
}

export function createStaticSun(renderer, { dirTravel, center, halfX, halfY, size }) {
  const depthTex = new THREE.DepthTexture(size, size);
  depthTex.type = THREE.UnsignedIntType;
  depthTex.compareFunction = THREE.LessEqualCompare;
  depthTex.minFilter = depthTex.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture: depthTex,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const near = 1, far = 150;
  const cam = new THREE.OrthographicCamera(-halfX, halfX, halfY, -halfY, near, far);
  const d = new THREE.Vector3().copy(dirTravel).normalize();
  cam.position.copy(center).addScaledVector(d, -90);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  LP.lpSunMatrix.value.copy(bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  LP.lpSunTo.value.copy(d).negate();
  LP.lpSunTexel.value = 1 / size;
  LP.lpSunBias.value = 0.012 / (far - near);
  LP.lpSunNBias.value = Math.max(0.02, (2 * halfX / size) * 1.6);

  const depthMats = new Map();
  const baseMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const depthMatFor = (m) => {
    if (!m || !(m.alphaTest > 0) || !m.map) return baseMat;
    let dm = depthMats.get(m);
    if (!dm) { dm = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, map: m.map, alphaTest: m.alphaTest }); depthMats.set(m, dm); }
    return dm;
  };

  function render(scene, camera) {
    const tmp = new THREE.Scene();
    tmp.matrixWorldAutoUpdate = false;
    let n = 0;
    scene.updateMatrixWorld(true);
    scene.traverseVisible((o) => {
      if (!o.isMesh || !o.castShadow || !isStatic(o, camera)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && (mat.transparent && !(mat.alphaTest > 0))) return;
      let p;
      if (o.isInstancedMesh) { p = new THREE.InstancedMesh(o.geometry, depthMatFor(mat), o.count); p.instanceMatrix = o.instanceMatrix; }
      else p = new THREE.Mesh(o.geometry, depthMatFor(mat));
      p.matrixAutoUpdate = false;
      p.matrix.copy(o.matrixWorld); p.matrixWorld.copy(o.matrixWorld);
      p.frustumCulled = false;
      tmp.add(p); n++;
    });
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, false);
    renderer.render(tmp, cam);
    renderer.setRenderTarget(prevRT);
    renderer.shadowMap.autoUpdate = prevAuto;
    LP.lpSunMap.value = depthTex;
    LP.lpSunOn.value = 1;
    return n;
  }

  return { render, camera: cam, target: rt, texture: depthTex };
}

// Static casters skip the per-frame sun cascade (they are in the static map); they still cast for other lights.
export function excludeFromSunCascade(o, sunShadowCamera) { excludeFromShadowCamera(o, sunShadowCamera); }
// Generic: the object draws nothing into the given shadow camera's map (three filters shadow casters by the viewing
// camera's layers, not the shadow camera's, so the draw range is zeroed for that pass instead).
export function excludeFromShadowCamera(o, shadowCamera) {
  const set = o.userData.__lpShadowSkip || (o.userData.__lpShadowSkip = new Set());
  if (set.has(shadowCamera)) return;
  const first = set.size === 0;
  set.add(shadowCamera);
  if (!first) return;
  const prevB = o.onBeforeShadow, prevA = o.onAfterShadow;
  let saved = -1;
  o.onBeforeShadow = function (r, obj, cam, shadowCam, geometry, depthMat, group) {
    if (set.has(shadowCam)) { saved = geometry.drawRange.count; geometry.drawRange.count = 0; }
    prevB.call(this, r, obj, cam, shadowCam, geometry, depthMat, group);
  };
  o.onAfterShadow = function (r, obj, cam, shadowCam, geometry, depthMat, group) {
    if (saved !== -1) { geometry.drawRange.count = saved; saved = -1; }
    prevA.call(this, r, obj, cam, shadowCam, geometry, depthMat, group);
  };
}
