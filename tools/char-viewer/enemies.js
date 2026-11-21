import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { makeRenderer, daylight, heightPole, load, label, params } from './common.js';

const BASE = '/assets/chars/';
const renderer = makeRenderer();
const scene = new THREE.Scene();
daylight(scene);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});

let manifest;
if (params.get('set') === 'raw') {
  const names = (params.get('variants') || 'thug_jacket').split(',');
  manifest = {
    anims: 'enemy_anims.glb', clipsJson: 'enemy_anims.clips.json',
    variants: names.map((n) => ({ name: n, file: params.get('opt') ? `${n}.glb` : `_raw/${n}_raw.glb` })),
  };
} else {
  manifest = await (await fetch(BASE + 'manifest.json')).json();
}
const only = params.get('variants')?.split(',');
const variants = manifest.variants.filter((v) => !only || only.includes(v.name));
const animGltf = await load(BASE + manifest.anims);
const clips = animGltf.animations;
const clipMeta = Object.fromEntries(clips.map((c) => [c.name, c.userData ?? {}]));
// GLTFLoader puts animation extras into clip.userData only for nodes; read our sidecar instead
if (!manifest.clips && manifest.clipsJson) manifest.clips = await (await fetch(BASE + manifest.clipsJson)).json();
const animInfo = manifest.clips ? Object.fromEntries(manifest.clips.map((c) => [c.name, c])) : clipMeta;

const hitboxes = manifest.hitboxes ? await (await fetch(BASE + manifest.hitboxes)).json() : null;
const weaponDefs = manifest.weapons || {};
const weaponModels = {};
for (const [k, w] of Object.entries(weaponDefs)) weaponModels[k] = (await load(BASE + w.file)).scene;

const actors = [];
const spacing = Number(params.get('spacing') || 0.95);
const lodMode = params.get('lod') || 'both';
async function spawn(v, lod, x, z) {
  const g = await load(BASE + (v.file || (lod === 0 ? v.lod0 : v.lod1)));
  const model = SkeletonUtils.clone(g.scene);
  model.position.set(x, 0, z);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
      // one file holds both LODs (…_LOD0 / …_LOD1) sharing skeleton + material
      if (/_LOD\d$/.test(o.name)) o.visible = o.name.endsWith('_LOD' + lod);
    }
  });
  scene.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const helper = new THREE.SkeletonHelper(model);
  helper.visible = false;
  scene.add(helper);
  const bones = {};
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  // hit capsules
  const caps = new THREE.Group();
  if (hitboxes) {
    for (const c of hitboxes.capsules) {
      const len = Math.max(0.001, new THREE.Vector3(...c.a).distanceTo(new THREE.Vector3(...c.b)));
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, len, 4, 10),
        new THREE.MeshBasicMaterial({ color: c.part === 'head' ? 0xff3030 : 0x30ff60, wireframe: true }));
      m.userData = c;
      caps.add(m);
    }
  }
  caps.visible = false;
  scene.add(caps);
  // weapon in hand
  let weapon = null;
  const wkey = v.weapon || 'pistol';
  if (weaponModels[wkey]) {
    const def = weaponDefs[wkey];
    weapon = weaponModels[wkey].clone();
    weapon.position.fromArray(def.offset.position);
    weapon.quaternion.fromArray(def.offset.quaternion);
    // offsets are in metres; cancel the root scale the bone inherits
    const s = model.getObjectByName('root').scale.x;
    weapon.scale.setScalar(1 / s);
    bones[def.bone].add(weapon);
  }
  actors.push({ v, lod, model, mixer, helper, caps, bones, weapon });
}
const n = variants.length;
for (let i = 0; i < n; i++) {
  const x = (i - (n - 1) / 2) * spacing;
  if (lodMode === 'both' || lodMode === '0') await spawn(variants[i], 0, x, 0);
  if (lodMode === 'both' || lodMode === '1') await spawn(variants[i], 1, x, lodMode === 'both' ? -2.2 : 0);
}
scene.add(heightPole((n / 2 + 0.3) * spacing, 0));

// camera presets
const camPreset = params.get('cam') || 'front';
const presets = {
  front: [[0, 1.5, 6.5 + n * 0.5], [0, 0.95, -0.6]],
  close: [[0, 1.55, 3.2], [0, 1.0, 0]],
  side: [[7, 1.3, 0], [0, 0.9, 0]],
  back: [[0, 1.6, -7], [0, 0.95, 0]],
  top: [[0, 6, 2.5], [0, 0.4, 0]],
  low: [[0, 0.35, 3.5], [0, 0.4, 0]],
};
const [cp, ct] = presets[camPreset] || presets.front;
camera.position.fromArray(cp);
controls.target.fromArray(ct);
if (params.get('camx')) camera.position.fromArray(params.get('camx').split(',').map(Number));
if (params.get('tgt')) controls.target.fromArray(params.get('tgt').split(',').map(Number));
controls.update();

// UI
const sel = document.getElementById('clip');
for (const c of clips) sel.add(new Option(`${c.name} (${c.duration.toFixed(2)}s)`, c.name));
const cycle = document.getElementById('cycle');
let current = null;
let clipStart = 0;
function play(name, t = 0) {
  current = clips.find((c) => c.name === name) || clips[0];
  sel.value = current.name;
  for (const a of actors) {
    a.mixer.stopAllAction();
    const act = a.mixer.clipAction(current);
    const info = animInfo[current.name] || {};
    act.setLoop(info.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = true;
    act.play();
    a.mixer.setTime(t);
  }
  clipStart = performance.now() / 1000 - t;
  const info = animInfo[current.name] || {};
  label(`${current.name}  ${current.duration.toFixed(2)}s  ${info.loop === false ? 'once' : 'loop'}  ${info.made ? 'MADE: ' : 'sourced: '}${info.source || ''}\n` +
    `${variants.map((v) => v.name).join('  ')}   ${lodMode === 'both' ? 'front row LOD0, back row LOD1' : 'LOD' + lodMode}`);
}
sel.onchange = () => play(sel.value);
for (const id of ['skel', 'hit', 'weapons']) {
  document.getElementById(id).onchange = (e) => {
    for (const a of actors) {
      if (id === 'skel') a.helper.visible = e.target.checked;
      if (id === 'hit') a.caps.visible = e.target.checked;
      if (id === 'weapons' && a.weapon) a.weapon.visible = e.target.checked;
    }
  };
}
if (params.get('skel')) { document.getElementById('skel').checked = true; for (const a of actors) a.helper.visible = true; }
if (params.get('hit')) { document.getElementById('hit').checked = true; for (const a of actors) a.caps.visible = true; }
if (params.get('noweapon')) for (const a of actors) if (a.weapon) a.weapon.visible = false;

const paused = params.has('paused');
if (paused) cycle.checked = false;
play(params.get('clip') || clips[0].name, Number(params.get('t') || 0));

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
function updateCaps(a) {
  if (!a.caps.visible) return;
  for (const m of a.caps.children) {
    const c = m.userData;
    const bone = a.bones[c.bone];
    tmpA.fromArray(c.a); tmpB.fromArray(c.b);
    bone.localToWorld(tmpA); bone.localToWorld(tmpB);
    m.scale.setScalar(a.bones.root.scale.x);
    m.position.copy(tmpA).add(tmpB).multiplyScalar(0.5);
    const d = tmpB.clone().sub(tmpA);
    if (d.lengthSq() > 1e-10) m.quaternion.setFromUnitVectors(up, d.normalize());
  }
}

const clock = new THREE.Clock();
window.__setClip = (name, t) => { play(name, t); for (const a of actors) { a.mixer.update(0); a.model.updateMatrixWorld(true); updateCaps(a); } renderer.render(scene, camera); return true; };
window.__clips = clips.map((c) => ({ name: c.name, duration: c.duration, ...(animInfo[c.name] || {}) }));
window.__actors = actors;
window.__scene = scene;
renderer.setAnimationLoop(() => {
  const dt = paused ? 0 : clock.getDelta();
  for (const a of actors) { a.mixer.update(dt); updateCaps(a); }
  if (cycle.checked && current) {
    const el = performance.now() / 1000 - clipStart;
    if (el > Math.max(2.5, current.duration * (animInfo[current.name]?.loop === false ? 1.4 : 2))) {
      const i = clips.indexOf(current);
      play(clips[(i + 1) % clips.length].name);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
});
