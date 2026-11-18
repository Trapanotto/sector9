import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HAND_GRIP } from './bodygen.js';

// Enemy weapons: side silhouettes extruded with bevels (frame, slide, receiver, furniture, curved magazine),
// cylinders for barrels. One merged geometry per weapon variant (vertex colour + roughness/metalness),
// the magazine is separate so the reload can move it. Local frame: origin = top of the pistol grip, +Z = barrel.

const lin = (hex) => new THREE.Color().setHex(hex);
const STEEL = { c: lin(0x2a2b2e), r: 0.42, m: 0.7 };
const STEEL_WORN = { c: lin(0x3a3b3d), r: 0.36, m: 0.8 };
const POLY = { c: lin(0x1b1c1d), r: 0.62, m: 0.0 };
const WOOD = { c: lin(0x6e4128), r: 0.5, m: 0.0 };

function paint(geom, p) {
  geom = geom.index ? geom.toNonIndexed() : geom;
  geom.deleteAttribute('uv');
  const n = geom.attributes.position.count;
  const col = new Float32Array(n * 3), pbr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { col[i * 3] = p.c.r; col[i * 3 + 1] = p.c.g; col[i * 3 + 2] = p.c.b; pbr[i * 2] = p.r; pbr[i * 2 + 1] = p.m; }
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 2));
  geom.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  return geom;
}

/** Extrude a side silhouette given as [z, y] points (plus optional holes) to a part of the given width centred on x = 0. */
function side(pts, width, bevel, holes = []) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  const depth = Math.max(0.001, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);   // shape x -> +Z (barrel), extrusion -> X
  return g;
}
function cyl(r, z0, z1, y, seg = 12, x = 0) {
  const g = new THREE.CylinderGeometry(r, r, z1 - z0, seg, 1);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}
function box(sx, sy, sz, x, y, z) { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(x, y, z); return g; }
function bez(p0, p1, p2, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
  return out;
}

// Hand placement: right hand wraps the pistol grip (grip axis = canonical hand Z), see bodygen buildHand.
function handOnGrip(gripMid, rake, gripLocal) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 + rake);
  const off = new THREE.Vector3(gripLocal[0], gripLocal[1], 0).applyQuaternion(q);
  return { quat: q, wrist: new THREE.Vector3().fromArray(gripMid).sub(off) };
}

const cache = new Map();
function build(type, wood) {
  const parts = [];
  let mag, magPos, magRot = 0, info;
  if (type === 'rifle') {
    const furn = wood ? WOOD : POLY;
    parts.push(paint(side([[-0.065, -0.004], [0.215, -0.004], [0.215, 0.05], [-0.065, 0.05]], 0.044, 0.003), STEEL));                       // receiver
    parts.push(paint(side([[-0.058, 0.048], [0.2, 0.048], [0.2, 0.06], [0.02, 0.071], [-0.058, 0.066]], 0.04, 0.004), STEEL));              // dust cover
    parts.push(paint(side([[0.212, 0.0], [0.4, 0.008], [0.402, 0.044], [0.212, 0.047]], 0.054, 0.007), furn));                            // lower handguard
    parts.push(paint(side([[0.24, 0.048], [0.39, 0.05], [0.39, 0.07], [0.24, 0.075]], 0.042, 0.007), furn));                                // upper handguard
    parts.push(paint(cyl(0.0105, 0.38, 0.62, 0.028), STEEL_WORN));                                                                          // barrel
    parts.push(paint(cyl(0.0085, 0.38, 0.52, 0.063), STEEL));                                                                               // gas tube
    parts.push(paint(side([[0.505, 0.02], [0.53, 0.02], [0.53, 0.07], [0.505, 0.07]], 0.03, 0.003), STEEL));                                // gas block
    parts.push(paint(side([[0.545, 0.018], [0.575, 0.018], [0.575, 0.072], [0.562, 0.086], [0.556, 0.086], [0.548, 0.07]], 0.024, 0.002), STEEL));   // front sight
    parts.push(paint(cyl(0.0145, 0.6, 0.655, 0.028, 10), STEEL));                                                                          // muzzle brake
    parts.push(paint(side([[0.2, 0.048], [0.24, 0.048], [0.24, 0.068], [0.205, 0.072]], 0.036, 0.002), STEEL));                             // rear sight block
    parts.push(paint(side([[-0.026, 0.002], [0.014, 0.002], [-0.014, -0.094], [-0.054, -0.088]], 0.032, 0.006), POLY));                     // pistol grip
    parts.push(paint(side([[0.0, -0.003], [0.075, -0.003], [0.07, -0.03], [0.025, -0.032], [0.008, -0.02]], 0.01, 0.0015,
      [[[0.014, -0.008], [0.064, -0.008], [0.06, -0.024], [0.028, -0.026], [0.016, -0.017]]]), STEEL));                                    // trigger guard
    parts.push(paint(box(0.005, 0.02, 0.006, 0, -0.014, 0.035), STEEL));                                                                    // trigger
    parts.push(paint(side([[-0.062, 0.046], [-0.062, 0.0], [-0.11, -0.012], [-0.3, -0.046], [-0.425, -0.064], [-0.44, -0.066], [-0.442, 0.03],
      [-0.43, 0.04], [-0.3, 0.036], [-0.1, 0.044]], 0.04, 0.006), furn));                                                                  // stock
    parts.push(paint(box(0.044, 0.1, 0.012, 0, -0.016, -0.446), POLY));                                                                     // butt pad
    parts.push(paint(side([[0.1, 0.03], [0.175, 0.03], [0.175, 0.036], [0.1, 0.036]], 0.05, 0.001), STEEL_WORN));                           // selector lever
    const front = bez([0.058, 0.0], [0.054, -0.11], [0.1, -0.19], 8), back = bez([0.0, 0.0], [-0.003, -0.1], [0.042, -0.2], 8);
    mag = paint(side([...front, ...back.reverse()], 0.028, 0.003), STEEL);
    magPos = new THREE.Vector3(0, -0.004, 0.115);
    const R = handOnGrip([0, -0.046, -0.021], 0.3, HAND_GRIP);
    const supQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -2.5));
    const supOff = new THREE.Vector3(-HAND_GRIP[0], HAND_GRIP[1], 0).applyQuaternion(supQ);
    info = {
      muzzle: new THREE.Vector3(0, 0.028, 0.66), eject: new THREE.Vector3(-0.03, 0.04, 0.11),
      rightWrist: R.wrist, rightQuat: R.quat,
      supportPos: new THREE.Vector3(0, 0.0, 0.315).sub(supOff), supportQuat: supQ,
      magwell: new THREE.Vector3(0.04, -0.12, 0.14), handMagPos: new THREE.Vector3(-0.03, -0.072, 0.01),
    };
  } else {
    parts.push(paint(side([[-0.036, 0.013], [0.152, 0.013], [0.156, 0.03], [0.15, 0.045], [-0.031, 0.045], [-0.037, 0.036]], 0.026, 0.0025), STEEL));   // slide
    parts.push(paint(side([[-0.032, -0.002], [0.146, -0.002], [0.146, 0.014], [-0.032, 0.014]], 0.024, 0.0015), POLY));                               // frame
    parts.push(paint(side([[0.0, 0.0], [0.072, 0.0], [0.072, -0.012], [0.06, -0.034], [0.02, -0.036], [0.0, -0.028]], 0.011, 0.0015,
      [[[0.009, -0.006], [0.063, -0.006], [0.054, -0.027], [0.022, -0.029], [0.01, -0.022]]]), POLY));                                                // trigger guard
    parts.push(paint(side([[-0.035, 0.001], [0.013, 0.001], [-0.016, -0.1], [-0.064, -0.094]], 0.03, 0.005), POLY));                                 // grip
    parts.push(paint(box(0.005, 0.018, 0.006, 0, -0.012, 0.03), STEEL));                                                                              // trigger
    parts.push(paint(box(0.005, 0.007, 0.008, 0, 0.048, 0.142), STEEL));                                                                              // front sight
    parts.push(paint(box(0.016, 0.008, 0.008, 0, 0.049, -0.022), STEEL));                                                                             // rear sight
    mag = paint(side([[-0.026, 0.0], [0.018, 0.0], [-0.008, -0.1], [-0.058, -0.096], [-0.058, -0.104], [-0.004, -0.108]], 0.022, 0.002), STEEL);
    magPos = new THREE.Vector3(0, 0, -0.012);
    const R = handOnGrip([0, -0.048, -0.026], 0.28, HAND_GRIP);
    const supQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.28, 0.0, 0.0, 'XYZ'));
    const supOff = new THREE.Vector3(-HAND_GRIP[0], HAND_GRIP[1], 0).applyQuaternion(supQ);
    info = {
      muzzle: new THREE.Vector3(0, 0.03, 0.158), eject: new THREE.Vector3(-0.02, 0.05, 0.06),
      rightWrist: R.wrist, rightQuat: R.quat,
      supportPos: new THREE.Vector3(0.026, -0.062, -0.02).sub(supOff), supportQuat: supQ,
      magwell: new THREE.Vector3(0.04, -0.15, -0.01), handMagPos: new THREE.Vector3(-0.03, -0.072, 0.03),
    };
  }
  const body = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  body.computeBoundingSphere();
  mag.computeBoundingSphere();
  return { body, mag, magPos, magRot, info };
}

export function getWeaponGeometry(type, wood) {
  const key = type + (wood ? ':wood' : '');
  let g = cache.get(key);
  if (!g) { g = build(type, wood); cache.set(key, g); }
  return g;
}
