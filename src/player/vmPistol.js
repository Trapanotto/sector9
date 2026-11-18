import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  extrudeRounded, loftZ, latheZ, circlePts, roundRectPts, filletFixed, transformed, merge,
} from './vmGeom.js';

// Procedural striker-fired service pistol (original design, no markings).
//
// Gun-local frame: origin = top of the grip just under the slide; -Z = muzzle, +Y = up, +X = right.
// Side profiles are (u, v) = (forward, up) -> (x, y, z) = (x, v, -u).
// The measurements that other code depends on are kept from the previous model:
//   slide top 0.04476, sight height 0.0075 (sightY 0.05226), rear sight z 0.024, front sight z -0.141,
//   bore y 0.028 / muzzle z -0.160, magwell origin (0, -0.020, 0.003) raked by GRIP_ANGLE, slide half width 0.013.

export const GRIP_ANGLE = 0.31;
export const BORE_Y = 0.028;
export const SLIDE_TOP = 0.04476;
export const SLIDE_HALF_W = 0.013;
export const SIGHT_H = 0.0075;
export const REAR_Z = 0.024, FRONT_Z = -0.141;
export const MAG_ORIGIN = [0, -0.020, 0.003];
export const LIGHT_Y = -0.017;

const SLIDE_BOT = 0.0102;
const SLIDE_REAR = 0.0378, SLIDE_FRONT = -0.1558;
const PORT_Z0 = -0.066, PORT_Z1 = -0.025, PORT_X = -0.0045, PORT_DEPTH = 0.012;

// ---------------------------------------------------------------- slide cross-section
// One fixed-count profile; variants collapse/move points for serration grooves and the ejection port.
function slideProfile({ inset = 0, groove = 0, port = false } = {}) {
  const W = SLIDE_HALF_W - inset, b = SLIDE_BOT + inset, t = SLIDE_TOP - inset;
  const ch = 0.0058 - inset * 0.5, cw = 0.0042 - inset * 0.5;
  const g0 = b + 0.0042, g1 = t - ch - 0.0016;
  const gd = groove;
  const yp = SLIDE_TOP - PORT_DEPTH;
  const R = [];      // right half, bottom centre -> top centre (CCW seen from +z)
  const P = (x, y, r) => R.push([x, y, r]);
  P(0, b, 0);
  P(W - 0.0014, b, 0);
  P(W, b, 0.0007);
  P(W, b + 0.0014, 0);
  P(W, g0, 0); P(W - gd, g0, 0); P(W - gd, g1, 0); P(W, g1, 0);
  if (!port) {
    P(W, t - ch - 0.0011, 0);
    P(W, t - ch, 0.0012);
    P(W - cw * 0.28, t - ch * 0.72, 0);
    P(W - cw, t, 0.0014);
    P(W - cw - 0.0013, t, 0);
  } else {
    R[6] = [W, yp, 0]; R[7] = [W, yp, 0];      // groove points pulled down to the port floor
    P(W, yp, 0);
    P(W, yp, 0);
    P(PORT_X, yp, 0);
    P(PORT_X, yp, 0);
    P(PORT_X, t, 0);
  }
  // left half: mirror of the right half without the port (the port is on the right only)
  const L = [];
  {
    const tmp = [];
    const Q = (x, y, r) => tmp.push([x, y, r]);
    Q(0, b, 0);
    Q(W - 0.0014, b, 0);
    Q(W, b, 0.0007);
    Q(W, b + 0.0014, 0);
    Q(W, g0, 0); Q(W - gd, g0, 0); Q(W - gd, g1, 0); Q(W, g1, 0);
    Q(W, t - ch - 0.0011, 0);
    Q(W, t - ch, 0.0012);
    Q(W - cw * 0.28, t - ch * 0.72, 0);
    Q(W - cw, t, 0.0014);
    Q(W - cw - 0.0013, t, 0);
    for (let i = tmp.length - 1; i >= 1; i--) L.push([-tmp[i][0], tmp[i][1], tmp[i][2]]);
  }
  // top centre (port inner wall top sits at PORT_X, on the left of centre)
  const poly = [...R, [port ? PORT_X : PORT_X, t, 0], ...L];
  return filletFixed(poly.map((p) => [p[0], p[1]]), poly.map((p) => p[2]), 3);
}

function buildSlide(mats) {
  const rings = [];
  const ring = (z, o) => rings.push({ z, pts: slideProfile(o) });
  // muzzle end: rounded nose
  ring(SLIDE_FRONT, { inset: 0.0017 });
  ring(SLIDE_FRONT + 0.0004, { inset: 0.0009 });
  ring(SLIDE_FRONT + 0.0010, { inset: 0.0003 });
  ring(SLIDE_FRONT + 0.0018, {});
  // front serrations
  const grooves = (z0, n, pitch, w, depth) => {
    for (let i = 0; i < n; i++) {
      const za = z0 + i * pitch, zb = za + w;
      ring(za, {}); ring(za, { groove: depth }); ring(zb, { groove: depth }); ring(zb, {});
    }
  };
  grooves(-0.1350, 6, 0.0031, 0.0015, 0.0010);
  // ejection port
  ring(PORT_Z0, {}); ring(PORT_Z0, { port: true }); ring(PORT_Z1, { port: true }); ring(PORT_Z1, {});
  // rear serrations
  grooves(0.0050, 9, 0.0031, 0.0015, 0.0010);
  // rear end
  ring(SLIDE_REAR - 0.0018, {});
  ring(SLIDE_REAR - 0.0010, { inset: 0.0003 });
  ring(SLIDE_REAR - 0.0004, { inset: 0.0009 });
  ring(SLIDE_REAR, { inset: 0.0017 });

  const holes = [
    circlePts(0.0074, 24).map(([x, y]) => [x, y + BORE_Y]),
    circlePts(0.0041, 16).map(([x, y]) => [x, y + 0.0158]),
  ];
  const slideG = loftZ(rings, { caps: { start: holes, end: true }, crease: 0.62, center: [0, 0.027] });

  const parts = [slideG];
  // extractor (right flank, just behind the port)
  parts.push(transformed(new RoundedBoxGeometry(0.0016, 0.0042, 0.0165, 2, 0.0006), { pos: [SLIDE_HALF_W - 0.0003, 0.0300, -0.0175] }));
  // rear sight: base + two posts forming the notch (dimensions unchanged: the ADS picture depends on them)
  parts.push(transformed(new RoundedBoxGeometry(0.021, 0.0035, 0.007, 2, 0.0005), { pos: [0, SLIDE_TOP + 0.00175, REAR_Z] }));
  const post = () => new RoundedBoxGeometry(0.0050, SIGHT_H, 0.007, 2, 0.0004);
  parts.push(transformed(post(), { pos: [-0.0042, SLIDE_TOP + SIGHT_H / 2, REAR_Z] }));
  parts.push(transformed(post(), { pos: [0.0042, SLIDE_TOP + SIGHT_H / 2, REAR_Z] }));
  // rear sight base flares back with a sloped face toward the shooter (snag-free)
  parts.push(transformed(new RoundedBoxGeometry(0.019, 0.0028, 0.004, 2, 0.0005), { pos: [0, SLIDE_TOP + 0.0012, REAR_Z + 0.0045], rot: [0.5, 0, 0] }));
  // front sight post
  parts.push(transformed(new RoundedBoxGeometry(0.0034, SIGHT_H, 0.006, 2, 0.0004), { pos: [0, SLIDE_TOP + SIGHT_H / 2, FRONT_Z] }));
  const slideMesh = new THREE.Mesh(merge(parts), mats.slide);

  // tritium dots
  const dot = new THREE.CylinderGeometry(0.0011, 0.0011, 0.0006, 10);
  const dots = merge([
    transformed(dot.clone(), { pos: [0, SLIDE_TOP + SIGHT_H - 0.0026, FRONT_Z + 0.0033], rot: [Math.PI / 2, 0, 0] }),
    transformed(dot.clone(), { pos: [-0.0042, SLIDE_TOP + SIGHT_H - 0.0029, REAR_Z + 0.0038], rot: [Math.PI / 2, 0, 0] }),
    transformed(dot.clone(), { pos: [0.0042, SLIDE_TOP + SIGHT_H - 0.0029, REAR_Z + 0.0038], rot: [Math.PI / 2, 0, 0] }),
  ]);
  const dotMesh = new THREE.Mesh(dots, mats.dot);

  // rear cover plate + striker indicator
  const plate = loftZ([
    { z: SLIDE_REAR - 0.0004, pts: roundRectPts(0, 0.0250, 0.0072, 0.0092, 0.0020, 3) },
    { z: SLIDE_REAR + 0.0003, pts: roundRectPts(0, 0.0250, 0.0072, 0.0092, 0.0020, 3) },
    { z: SLIDE_REAR + 0.0006, pts: roundRectPts(0, 0.0250, 0.0066, 0.0086, 0.0016, 3) },
  ], { caps: { end: true }, center: [0, 0.025] });
  const ind = transformed(new RoundedBoxGeometry(0.0022, 0.0042, 0.0012, 1, 0.0004), { pos: [0, 0.0262, SLIDE_REAR + 0.0007] });
  const plateMesh = new THREE.Mesh(merge([plate, ind]), mats.polymer);

  const group = new THREE.Group();
  group.add(slideMesh, dotMesh, plateMesh);
  return group;
}

// ---------------------------------------------------------------- frame
function buildFrame(mats) {
  const frameParts = [];
  // upper frame: dust cover, rails, tang and beavertail
  frameParts.push(extrudeRounded(
    [[0.1500, 0.0115], [-0.0340, 0.0115], [-0.0465, 0.0085], [-0.0490, 0.0005], [-0.0350, -0.0062],
      [-0.0277, -0.0150], [-0.0258, -0.0130], [0.0170, -0.0130], [0.0170, -0.0095], [0.0720, -0.0095],
      [0.0740, -0.0080], [0.1505, -0.0080]],
    null, 0.01075, 0.0012,
    { radii: [0.0014, 0.0030, 0.0035, 0.0040, 0.0045, 0.0015, 0.0013, 0.0013, 0.0013, 0.0013, 0.0013, 0.0016] }));
  // grip with palm swell; straight front strap, raked like the magwell
  frameParts.push(extrudeRounded(
    [[0.0172, -0.0060], [0.0108, -0.0410], [0.0020, -0.0700], [-0.0186, -0.1326], [-0.0595, -0.1194],
      [-0.0428, -0.0604], [-0.0232, -0.0060]],
    null, 0.0148, 0.0042,
    { radii: [0.0050, 0.0200, 0.0400, 0.0055, 0.0060, 0.0400, 0.0050], filletSegs: 4, edgeSegs: 3 }));
  // trigger guard with undercut behind it, squared front
  frameParts.push(extrudeRounded(
    [[0.0745, -0.0060], [0.0732, -0.0360], [0.0650, -0.0455], [0.0240, -0.0462], [0.0160, -0.0425],
      [0.0128, -0.0340], [0.0140, -0.0060]],
    [[[0.0185, -0.0090], [0.0670, -0.0090], [0.0672, -0.0305], [0.0600, -0.0392], [0.0260, -0.0395], [0.0175, -0.0340]]],
    0.0058, 0.0021,
    { radii: [0.0024, 0.0075, 0.0060, 0.0055, 0.0040, 0.0030, 0.0024], holeRadii: [0.0025, 0.0025, 0.0060, 0.0050, 0.0050, 0.0040] }));
  // accessory rail with cross slots (visible between guard and light)
  const railProf = (slot) => filletFixed([
    [-0.0080, -0.0076], [0.0080, -0.0076], [0.0080, -0.0099], [0.0064, -0.0108], [0.0064, slot ? -0.0112 : -0.0128],
    [-0.0064, slot ? -0.0112 : -0.0128], [-0.0064, -0.0108], [-0.0080, -0.0099]], 0.0004, 1);
  const rr = [];
  rr.push({ z: -0.0738, pts: railProf(false) });
  for (const z0 of [-0.0790, -0.0890]) {
    rr.push({ z: z0, pts: railProf(false) }, { z: z0, pts: railProf(true) }, { z: z0 - 0.0045, pts: railProf(true) }, { z: z0 - 0.0045, pts: railProf(false) });
  }
  rr.push({ z: -0.1490, pts: railProf(false) });
  frameParts.push(loftZ(rr, { caps: { start: true, end: true }, center: [0, -0.010] }));
  // magazine release (left, behind the guard) — slightly proud of the grip, polymer
  frameParts.push(transformed(new RoundedBoxGeometry(0.0026, 0.0068, 0.0105, 2, 0.0010), { pos: [-0.0150, -0.0235, -0.0100] }));
  const frameMesh = new THREE.Mesh(merge(frameParts), mats.frame);

  // small steel parts: slide stop, takedown levers, pins
  const steelParts = [];
  steelParts.push(extrudeRounded([[-0.0060, 0.0015], [0.0260, 0.0028], [0.0325, 0.0080], [0.0270, 0.0106], [-0.0060, 0.0078]],
    null, 0.0009, 0.0004, { radii: [0.0030, 0.0015, 0.0020, 0.0015, 0.0030] }));
  steelParts[0].translate(-0.0117, 0, 0);
  for (const sx of [-1, 1]) {
    const tk = extrudeRounded([[0.0500, 0.0010], [0.0595, 0.0010], [0.0595, 0.0068], [0.0500, 0.0068]], null, 0.0007, 0.0003, { radii: 0.0010 });
    tk.translate(sx * 0.0112, 0, 0);
    steelParts.push(tk);
  }
  for (const [u, v] of [[0.0215, 0.0030], [-0.0115, 0.0020], [0.0330, -0.0040]]) {
    steelParts.push(transformed(latheZ([[0.0, -0.0118], [0.0010, -0.01175], [0.0013, -0.0115], [0.0013, 0.0115], [0.0010, 0.01175], [0.0, 0.0118]], 10),
      { pos: [0, v, -u], rot: [0, Math.PI / 2, 0] }));
  }
  const steelMesh = new THREE.Mesh(merge(steelParts), mats.steel);

  // trigger: curved blade + safety blade
  const trig = [];
  trig.push(extrudeRounded([[0.0378, -0.0080], [0.0442, -0.0095], [0.0420, -0.0215], [0.0436, -0.0330], [0.0392, -0.0328], [0.0362, -0.0215], [0.0368, -0.0090]],
    null, 0.0031, 0.0011, { radii: [0.001, 0.0015, 0.012, 0.0016, 0.0016, 0.012, 0.001] }));
  trig.push(extrudeRounded([[0.0420, -0.0150], [0.0452, -0.0205], [0.0448, -0.0285], [0.0418, -0.0300], [0.0410, -0.0160]],
    null, 0.0009, 0.0003, { radii: 0.0007 }));
  const trigMesh = new THREE.Mesh(merge(trig), mats.polymer);

  const g = new THREE.Group();
  g.add(frameMesh, steelMesh, trigMesh);
  return { group: g, trigger: trigMesh };
}

// ---------------------------------------------------------------- barrel + recoil guide (static)
function buildBarrel(mats) {
  const b = [];
  // chamber hood (flush with the slide top, visible through the port) + barrel tube with crowned muzzle
  b.push(transformed(new RoundedBoxGeometry(0.0132, 0.0185, 0.0400, 2, 0.0008), { pos: [0, SLIDE_TOP - 0.0002 - 0.00925, -0.0450] }));
  b.push(latheZ([[0.0068, -0.0640], [0.0068, -0.1588], [0.0064, -0.15975], [0.0052, -0.1600], [0.0047, -0.1596]], 28, { crease: 0.5 }));
  // loaded chamber indicator cut-out at the rear of the hood (brass peeks through)
  const barrel = new THREE.Mesh(merge(b), mats.barrel);
  // bore with rifling (polygonal lands, twisted), dark
  const bore = new THREE.Mesh(latheZ([[0.0047, -0.1597], [0.0046, -0.1590], [0.0046, -0.1350]], 24,
    { lobes: { n: 6, amp: 0.035 }, twist: 30, caps: { end: true } }), mats.dark);
  // gap rings around the barrel and the guide rod in the slide nose, the guide rod tip and a hint of spring
  const darkParts = [
    latheZ([[0.0074, -0.1559], [0.0074, -0.1500]], 24),
    latheZ([[0.0041, -0.1559], [0.0041, -0.1480]], 16, { caps: { end: true } }),
  ];
  darkParts[1].translate(0, 0.0158, 0);
  darkParts[0].translate(0, BORE_Y, 0);
  const dark = new THREE.Mesh(merge(darkParts), mats.dark);
  dark.material.side = THREE.DoubleSide;
  const guide = latheZ([[0.0, -0.1551], [0.0018, -0.1550], [0.0029, -0.1544], [0.0030, -0.1500]], 16);
  guide.translate(0, 0.0158, 0);
  const coil = new THREE.TorusGeometry(0.0035, 0.0004, 5, 16);
  coil.translate(0, 0.0158, -0.1522);
  const guideMesh = new THREE.Mesh(merge([guide, coil]), mats.steel);
  const g = new THREE.Group();
  g.add(barrel, bore, dark, guideMesh);
  return g;
}

// ---------------------------------------------------------------- weapon light
function buildLight(mats) {
  const Y = LIGHT_Y;
  const prof = (hw, hh, r) => roundRectPts(0, Y, hw, hh, r, 4);
  const rings = [
    { z: -0.0940, pts: prof(0.0120, 0.0078, 0.0040) },
    { z: -0.0952, pts: prof(0.0138, 0.0092, 0.0052) },
    { z: -0.0965, pts: prof(0.0140, 0.0095, 0.0055) },
  ];
  // body with three shallow grip grooves
  for (const z0 of [-0.1180, -0.1220, -0.1260]) {
    rings.push({ z: z0, pts: prof(0.0140, 0.0095, 0.0055) }, { z: z0 - 0.0006, pts: prof(0.0134, 0.0089, 0.0050) },
      { z: z0 - 0.0016, pts: prof(0.0134, 0.0089, 0.0050) }, { z: z0 - 0.0022, pts: prof(0.0140, 0.0095, 0.0055) });
  }
  // flared head / bezel
  rings.push({ z: -0.1350, pts: prof(0.0140, 0.0095, 0.0055) }, { z: -0.1395, pts: prof(0.0148, 0.0102, 0.0062) },
    { z: -0.1490, pts: prof(0.0148, 0.0102, 0.0062) }, { z: -0.1500, pts: prof(0.0140, 0.0094, 0.0055) },
    { z: -0.1504, pts: prof(0.0130, 0.0086, 0.0050) });
  const lensHole = circlePts(0.0084, 28).map(([x, y]) => [x, y + Y]);
  const body = loftZ(rings, { caps: { start: true, end: [lensHole] }, center: [0, Y], crease: 0.62 });
  // rear switch paddles on both sides
  const sw = [];
  for (const sx of [-1, 1]) sw.push(transformed(new RoundedBoxGeometry(0.0034, 0.0100, 0.0110, 2, 0.0012), { pos: [sx * 0.0142, Y, -0.1010] }));
  const bodyMesh = new THREE.Mesh(merge([body, ...sw]), mats.lightBody);
  // reflector cone behind the lens
  const refl = latheZ([[0.0085, -0.1500], [0.0084, -0.1488], [0.0030, -0.1440], [0.0, -0.1438]], 24);
  refl.translate(0, Y, 0);
  const reflMesh = new THREE.Mesh(refl, mats.reflector);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.0084, 0.0084, 0.0012, 28), mats.lens);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, Y, -0.1497);
  const g = new THREE.Group();
  g.add(bodyMesh, reflMesh, lens);
  return { group: g, lens };
}

// ---------------------------------------------------------------- magazine
export function buildMag(mats) {
  const g = new THREE.Group();
  // body: steel tube, local -Y down the magwell. Built along z and rotated.
  const prof = (hw, hd, r) => roundRectPts(0, 0, hw, hd, r, 4);
  const body = loftZ([
    { z: 0.0, pts: prof(0.0088, 0.0148, 0.0045) },
    { z: 0.0006, pts: prof(0.0093, 0.0153, 0.0048) },
    { z: 0.1120, pts: prof(0.0093, 0.0153, 0.0048) },
  ], { caps: { start: true, end: true } });
  body.rotateX(Math.PI / 2);   // z (0..0.105) -> -y
  const bodyMesh = new THREE.Mesh(body, mats.magBody);
  g.add(bodyMesh);
  // top round: brass case + copper bullet, pointing forward (-z)
  const round = new THREE.Group();
  const caseG = latheZ([[0.0, 0.0096], [0.0046, 0.0096], [0.0049, 0.0090], [0.0049, -0.0090], [0.0046, -0.0096]], 16);
  const bullet = latheZ([[0.0046, -0.0096], [0.0045, -0.0130], [0.0035, -0.0165], [0.0015, -0.0180], [0.0, -0.0182]], 16);
  round.add(new THREE.Mesh(caseG, mats.brass), new THREE.Mesh(bullet, mats.copper));
  round.position.set(0.0018, -0.0048, 0.0010);
  g.add(round);
  // base plate with front lip
  const base = new THREE.Mesh(merge([
    new RoundedBoxGeometry(0.0225, 0.0085, 0.0370, 2, 0.0028),
    transformed(new RoundedBoxGeometry(0.0200, 0.0060, 0.0060, 2, 0.0020), { pos: [0, -0.0016, -0.0185] }),
  ]), mats.polymer);
  base.position.set(0, -0.1163, 0.0012);
  g.add(base);
  return g;
}

export function buildPistol(mats) {
  const slide = new THREE.Group();
  slide.add(buildSlide(mats));
  const frame = buildFrame(mats);
  const barrel = buildBarrel(mats);
  const light = buildLight(mats);
  return { slide, frame: frame.group, trigger: frame.trigger, barrel, light: light.group, lens: light.lens };
}
