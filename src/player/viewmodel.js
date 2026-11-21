// First-person arms + pistol (authored rig public/assets/arms/fp_arms_pistol.glb, ONE skinned mesh / ONE draw).
//
// Space: the view model lives in WORLD space at the camera pose (so baked probe light, flashlight, muzzle light
// and the sun shade it exactly like the surroundings), but is drawn with its own narrower lens (vmScene
// onBeforeRender sets the view-model camera's fov) — the classic view-model trick that keeps the hands at a
// readable size while the 112° bodycam lens stays wide. aim.js maps directions between the two lenses.
//
// Per frame: clip layers (hip/aim/low/sprint holds, reloads) → procedural index finger / trigger / slide →
// gun offset (free aim, sway, bob, breathing, recoil, wall retraction) → two-bone IK for both arms so the
// hands stay on the moved gun (support hand blends to its clip pose during reloads).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { U, createDynamicMaterial } from '../render/materials.js';

export const VM_ZOOM = 1.55; // view-model lens magnification relative to the world lens (tan ratio)
const HOLDS = ['fp_idle', 'fp_aim', 'fp_lowready', 'fp_sprint'];
const RELOADS = ['fp_reload', 'fp_reload_tac'];

export function createViewmodel(ctx) {
  const vm = {
    ready: false, root: null, mesh: null, mixer: null, extras: null,
    // inputs (weapon writes these each frame)
    w: { hip: 1, aim: 0, low: 0, sprint: 0 },
    reload: { name: '', time: 0, weight: 0 },
    onTrig: 0, press: 0, slide: 0, slideOverride: false, supportGrip: 1, visible: true,
    off: { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 },   // gun offset in camera space (rad, m)
    // outputs (world space of the view model)
    muzzle: new THREE.Vector3(), rearSight: new THREE.Vector3(), barrel: new THREE.Vector3(0, 0, -1),
    port: new THREE.Vector3(), portRight: new THREE.Vector3(1, 0, 0), gunPos: new THREE.Vector3(),
    tris: 0, zoom: VM_ZOOM,
  };
  const B = {};      // bones / markers by name
  const actions = {};
  const pose = { off: [], trig: [], press: [] }; // index finger local quaternions
  const IDX = ['index_01_r', 'index_02_r', 'index_03_r'];
  const pistolInHandInv = new THREE.Matrix4(), supportInPistol = new THREE.Matrix4();
  const trigRest = new THREE.Quaternion(), slideRest = new THREE.Vector3();
  const trigAxis = new THREE.Vector3(1, 0, 0);
  let trigTravel = 0.28, slideTravel = 0.032;

  vm.load = async (loader) => {
    const bytes = await loader.bin('assets/arms/fp_arms_pistol.glb', { weight: 0.6 });
    const gltf = await new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
      .parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', res, rej));
    const root = gltf.scene.getObjectByName('fp_root') || gltf.scene.children[0];
    vm.root = root;
    vm.extras = root.userData || {};
    root.traverse((o) => {
      if (o.name) B[o.name] = o;
      if (o.isSkinnedMesh) { vm.mesh = o; o.frustumCulled = false; }
    });
    const src = vm.mesh.material;
    const map = src.map ?? null;
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4; }
    vm.mesh.material = createDynamicMaterial({ map, color: [1, 1, 1], probe: 'uniform' });
    vm.mesh.material.name = 'S9Viewmodel';
    src.dispose?.();
    if (map) ctx.render.trackTexture('viewmodel', (map.image?.width ?? 1024) * (map.image?.height ?? 1024) * 4 * 1.33);
    vm.tris = vm.mesh.geometry.index ? vm.mesh.geometry.index.count / 3 : vm.mesh.geometry.attributes.position.count / 3;
    // gltf.scene holds fp_root under a group; we drive fp_root directly in world space
    gltf.scene.remove(root);
    root.matrixAutoUpdate = true;
    vm.mixer = new THREE.AnimationMixer(root);
    for (const c of gltf.animations) {
      if (c.name.startsWith('fp_pose_index')) {
        const k = c.name.endsWith('_off') ? 'off' : c.name.endsWith('_trigger') ? 'trig' : 'press';
        for (const bn of IDX) {
          const tr = c.tracks.find((t) => t.name === `${bn}.quaternion`);
          pose[k].push(new THREE.Quaternion().fromArray(tr.values, 0));
        }
        continue;
      }
      const a = vm.mixer.clipAction(c);
      a.enabled = true;
      if (RELOADS.includes(c.name) || c.name === 'fp_fire' || c.name === 'fp_dry_fire') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      else a.setLoop(THREE.LoopRepeat, Infinity);
      actions[c.name] = a;
    }
    for (const n of HOLDS) { actions[n].play(); actions[n].setEffectiveWeight(n === 'fp_idle' ? 1 : 0); }
    for (const n of RELOADS) { actions[n].play(); actions[n].paused = true; actions[n].setEffectiveWeight(0); }
    const ex = vm.extras;
    if (ex.pistolInHand) pistolInHandInv.fromArray(ex.pistolInHand).invert();
    if (ex.supportInPistol) supportInPistol.fromArray(ex.supportInPistol);
    if (ex.trigger) trigTravel = ex.trigger.travel;
    if (ex.slideTravel) slideTravel = ex.slideTravel;
    trigRest.copy(B.pistol_trigger.quaternion);
    slideRest.copy(B.pistol_slide.position);
    vm.reloadDur = { fp_reload: actions.fp_reload.getClip().duration, fp_reload_tac: actions.fp_reload_tac.getClip().duration };
  };

  vm.init = () => {
    const scene = ctx.render.vmScene;
    scene.add(vm.root);
    // own lens + per-pass light scaling (the chest light / muzzle flash are centimetres from the gun)
    const flashSave = new THREE.Vector3(), muzSave = new THREE.Vector3(), muzPosSave = new THREE.Vector3();
    scene.onBeforeRender = (renderer, sc, cam) => {
      const world = ctx.render.camera;
      const tanW = Math.tan((world.fov * Math.PI) / 360);
      cam.fov = (Math.atan(tanW / vm.zoom) * 360) / Math.PI;
      cam.aspect = world.aspect;
      cam.near = 0.01; cam.far = 10;
      cam.updateProjectionMatrix();
      flashSave.copy(U.uFlashColor.value); muzSave.copy(U.uMuzzleColor.value); muzPosSave.copy(U.uMuzzlePos.value);
      U.uFlashColor.value.multiplyScalar(0.1);
      U.uMuzzleColor.value.multiplyScalar(0.06);
      U.uMuzzlePos.value.copy(vm.muzzle);
    };
    scene.onAfterRender = () => {
      U.uFlashColor.value.copy(flashSave); U.uMuzzleColor.value.copy(muzSave); U.uMuzzlePos.value.copy(muzPosSave);
    };
    vm.ready = true;
  };

  // ---------------------------------------------------------------------------------------------- IK helpers
  const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3(), _T = new THREE.Vector3();
  const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _Bn = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _pole = new THREE.Vector3();
  function worldQuat(o, out) { o.matrixWorld.decompose(_s, out, _s); return out; }
  function rotateWorld(bone, from, to) {
    _q.setFromUnitVectors(from.normalize(), to.normalize());
    worldQuat(bone, _qw);
    _qw.premultiply(_q);
    worldQuat(bone.parent, _qp);
    bone.quaternion.copy(_qp.invert().multiply(_qw));
    bone.updateMatrixWorld(true);
  }
  function setWorldQuat(bone, q) {
    worldQuat(bone.parent, _qp);
    bone.quaternion.copy(_qp.invert().multiply(q));
    bone.updateMatrixWorld(true);
  }
  /** two-bone IK: upper → lower → hand reaches (tp, tq); the elbow stays in the plane of its current position */
  function ik(upper, lower, hand, tp, tq) {
    _A.setFromMatrixPosition(upper.matrixWorld);
    _B.setFromMatrixPosition(lower.matrixWorld);
    _C.setFromMatrixPosition(hand.matrixWorld);
    _pole.copy(_B);
    const l1 = _A.distanceTo(_B), l2 = _B.distanceTo(_C);
    _d.subVectors(tp, _A);
    const dist = Math.min(Math.max(_d.length(), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
    _d.normalize();
    _p.subVectors(_pole, _A);
    _p.addScaledVector(_d, -_p.dot(_d));
    if (_p.lengthSq() < 1e-10) _p.set(0, -1, 0);
    _p.normalize();
    const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    _Bn.copy(_A).addScaledVector(_d, l1 * cosA).addScaledVector(_p, l1 * sinA);
    rotateWorld(upper, _u.subVectors(_B, _A), _v.subVectors(_Bn, _A));
    _B.setFromMatrixPosition(lower.matrixWorld);
    _C.setFromMatrixPosition(hand.matrixWorld);
    _T.copy(_A).addScaledVector(_d, dist);
    rotateWorld(lower, _u.subVectors(_C, _B), _v.subVectors(_T, _B));
    setWorldQuat(hand, tq);
  }

  // ---------------------------------------------------------------------------------------------- per frame
  const camM = new THREE.Matrix4(), camInv = new THREE.Matrix4(), offM = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const gunW = new THREE.Matrix4(), handT = new THREE.Matrix4(), supT = new THREE.Matrix4();
  const offQ = new THREE.Quaternion(), offE = new THREE.Euler(0, 0, 0, 'YXZ'), pivot = new THREE.Vector3(0, -0.12, 0.05);
  const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), fp = new THREE.Vector3(), fq = new THREE.Quaternion();
  const ps = { r: 0, g: 0, b: 0, ar: 0, ag: 0, ab: 0, dx: 0, dy: 0, dz: 0, sun: 0 };
  const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(-1, 0, 0);

  vm.update = (dt, cam) => {
    if (!vm.ready) return;
    const root = vm.root;
    root.visible = vm.visible;
    if (!vm.visible) return;
    root.position.copy(cam.position);
    root.quaternion.copy(cam.quaternion);
    // --- clip layers
    const r = vm.reload, rw = r.weight;
    const hw = 1 - rw;
    actions.fp_idle.setEffectiveWeight(vm.w.hip * hw);
    actions.fp_aim.setEffectiveWeight(vm.w.aim * hw);
    actions.fp_lowready.setEffectiveWeight(vm.w.low * hw);
    actions.fp_sprint.setEffectiveWeight(vm.w.sprint * hw);
    for (const n of RELOADS) {
      const a = actions[n];
      if (n === r.name && rw > 0) { a.setEffectiveWeight(rw); a.time = Math.min(r.time, a.getClip().duration - 1e-3); }
      else a.setEffectiveWeight(0);
    }
    vm.mixer.update(dt);
    // --- index finger / trigger / slide (procedural, local to the hand)
    const ot = vm.onTrig, pr = vm.press;
    for (let i = 0; i < 3; i++) {
      const b = B[IDX[i]];
      b.quaternion.copy(pose.off[i]).slerp(pose.trig[i], ot);
      if (pr > 0) b.quaternion.slerp(pose.press[i], pr * ot);
    }
    B.pistol_trigger.quaternion.copy(trigRest);
    if (pr > 0) { _q.setFromAxisAngle(trigAxis, trigTravel * pr * ot); B.pistol_trigger.quaternion.multiply(_q); }
    if (vm.slideOverride) B.pistol_slide.position.set(slideRest.x, slideRest.y, slideRest.z - slideTravel * vm.slide);
    root.updateMatrixWorld(true);
    // --- gun offset in camera space (about a pivot under the camera ~ the chest), then IK both arms onto it
    camM.compose(cam.position, cam.quaternion, _s.set(1, 1, 1));
    camInv.copy(camM).invert();
    const o = vm.off;
    offE.set(o.pitch, o.yaw, o.roll);
    offQ.setFromEuler(offE);
    offM.makeTranslation(pivot.x, pivot.y, pivot.z);
    tmpM.makeRotationFromQuaternion(offQ); offM.multiply(tmpM);
    tmpM.makeTranslation(-pivot.x + o.x, -pivot.y + o.y, -pivot.z + o.z); offM.multiply(tmpM);
    gunW.copy(B.pistol.matrixWorld);
    // desired gun = C · O · C⁻¹ · G
    gunW.premultiply(camInv).premultiply(offM).premultiply(camM);
    // strong hand: hand = gun · pistolInHand⁻¹
    handT.multiplyMatrices(gunW, pistolInHandInv);
    handT.decompose(tp, tq, _s);
    ik(B.upperarm_r, B.lowerarm_r, B.hand_r, tp, tq);
    // support hand: on the gun (grip) blended with its clip pose (reload)
    supT.multiplyMatrices(gunW, supportInPistol);
    supT.decompose(tp, tq, _s);
    const sg = vm.supportGrip;
    if (sg < 1) {
      B.hand_l.matrixWorld.decompose(fp, fq, _s);
      // the clip pose is relative to the un-offset gun: carry it along with the offset
      tmpM.compose(fp, fq, _s.set(1, 1, 1)).premultiply(camInv).premultiply(offM).premultiply(camM);
      tmpM.decompose(fp, fq, _s);
      tp.lerp(fp, 1 - sg); tq.slerp(fq, 1 - sg);
    }
    ik(B.upperarm_l, B.lowerarm_l, B.hand_l, tp, tq);
    // --- outputs
    B.pistol.matrixWorld.decompose(vm.gunPos, _qw, _s);
    vm.barrel.copy(Z).applyQuaternion(_qw);
    vm.portRight.copy(X).applyQuaternion(_qw);
    B.pistol_muzzle.getWorldPosition(vm.muzzle);
    B.pistol_sight_rear.getWorldPosition(vm.rearSight);
    B.pistol_port.getWorldPosition(vm.port);
    // --- lighting: baked probe at the gun (the view model's own uniform probe term)
    const lit = ctx.world.probes;
    if (lit) {
      lit.sample(vm.gunPos.x, vm.gunPos.y, vm.gunPos.z, ps);
      const cl = U.uProbeArtLevel.value;
      U.uProbeAmb.value.set(ps.r + ps.ar * cl, ps.g + ps.ag * cl, ps.b + ps.ab * cl);
      U.uProbeDirU.value.set(ps.dx, ps.dy, ps.dz);
      U.uProbeSunU.value = ps.sun;
    }
  };

  /** world-lens position of a view-model point (e.g. muzzle for the world light / casings / tracers) */
  const _vs = new THREE.Vector3();
  vm.toWorldLens = (p, cam, out) => {
    _vs.copy(p).sub(cam.position).applyQuaternion(_qp.copy(cam.quaternion).invert());
    const k = vm.zoom;
    _vs.x *= k; _vs.y *= k;
    return out.copy(_vs).applyQuaternion(cam.quaternion).add(cam.position);
  };
  /** view-space (camera) coordinates of a view-model point / direction */
  vm.toView = (p, cam, out) => out.copy(p).sub(cam.position).applyQuaternion(_qp.copy(cam.quaternion).invert());
  vm.dirToView = (d, cam, out) => out.copy(d).applyQuaternion(_qp.copy(cam.quaternion).invert());
  vm.reset = () => {};
  return vm;
}
