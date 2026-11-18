// Zone / portal visibility for the static world.
//
// Every static mesh is split per zone (rooms, halls, basement sections, outdoors; layout ZONES) and parented to one
// group per zone. Each frame the camera's zone is found and the zones visible through open portals (doorways,
// windows, roof openings, stair shafts) are collected by recursive portal traversal with screen-space rectangle
// clipping (conservative: a portal crossing the near plane counts as covering the whole screen). Invisible zone
// groups are switched off, which removes them from the main pass and from every shadow pass rendered this frame.
//
// Also: raycast proxies clustered in a coarse grid with box-rejecting parent nodes (combat / line-of-sight
// raycasts test a handful of cluster boxes instead of every proxy).
import * as THREE from 'three';
import { ZONES, zoneIndexAt, insideBuilding, BUILDINGS } from './layout.js';

const _v = new THREE.Vector4(), _m = new THREE.Matrix4();

export function createZoneCuller(layout) {
  const N = ZONES.length;
  const groups = ZONES.map((z, i) => {
    const g = new THREE.Group();
    g.name = 'zone:' + z.name; g.userData.static = true; g.userData.zone = i;
    return g;
  });
  const visible = new Uint8Array(N).fill(1);
  const forced = new Uint8Array(N);   // zones kept visible regardless (e.g. while capturing)

  // ---------------------------------------------------------------- portals
  const portals = [];
  const pAdj = Array.from({ length: N }, () => []);
  const addPortal = (a, b, corners, name) => {
    if (a === b || a < 0 || b < 0) return;
    const p = { a, b, c: corners.map((q) => new THREE.Vector3(...q)), name };
    p.center = p.c.reduce((s, q) => s.add(q), new THREE.Vector3()).multiplyScalar(0.25);
    // occlusion samples: centre, corners and edge midpoints pulled 15 % toward the centre (a 4x3 grid on big openings)
    const big = p.c[0].distanceTo(p.c[1]) > 2.5 || p.c[1].distanceTo(p.c[2]) > 2.5;
    p.samples = [];
    const nu = big ? 5 : 3, nv = big ? 4 : 3;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const u = 0.075 + 0.85 * i / (nu - 1), v = 0.075 + 0.85 * j / (nv - 1);
      const a0 = p.c[0].clone().lerp(p.c[1], u), a1 = p.c[3].clone().lerp(p.c[2], u);
      p.samples.push(a0.lerp(a1, v));
    }
    p.samples.sort((q, r) => q.distanceTo(p.center) - r.distanceTo(p.center));
    p.building = buildingAt(p.center.x, p.center.z, 0.45);
    portals.push(p); pAdj[a].push(p); pAdj[b].push(p);
  };
  // zone on one side of an opening: probe a bit away from the wall at mid height
  const side = (x, y, z) => zoneAtSoft(x, y, z);
  for (const d of layout.doors) {
    const y0 = d.y || 0, y1 = y0 + d.height, ym = y0 + Math.min(1.2, d.height / 2);
    const [cx, cz] = d.center, tm = (d.t0 + d.t1) / 2;
    let a, b, corners;
    if (d.axis === 'x') {
      a = side(cx, ym, d.t0 - 0.6); b = side(cx, ym, d.t1 + 0.6);
      corners = [[d.a[0], y0, tm], [d.a[1], y0, tm], [d.a[1], y1, tm], [d.a[0], y1, tm]];
    } else {
      a = side(d.t0 - 0.6, ym, cz); b = side(d.t1 + 0.6, ym, cz);
      corners = [[tm, y0, d.a[0]], [tm, y0, d.a[1]], [tm, y1, d.a[1]], [tm, y1, d.a[0]]];
    }
    addPortal(a, b, corners, d.name);
  }
  for (const w of layout.windows) {
    const ym = (w.min[1] + w.max[1]) / 2;
    let a, b, corners;
    if (w.normal === 'z') {
      const t = (w.min[2] + w.max[2]) / 2;
      a = side((w.min[0] + w.max[0]) / 2, ym, w.min[2] - 0.6); b = side((w.min[0] + w.max[0]) / 2, ym, w.max[2] + 0.6);
      corners = [[w.min[0], w.min[1], t], [w.max[0], w.min[1], t], [w.max[0], w.max[1], t], [w.min[0], w.max[1], t]];
    } else {
      const t = (w.min[0] + w.max[0]) / 2;
      a = side(w.min[0] - 0.6, ym, (w.min[2] + w.max[2]) / 2); b = side(w.max[0] + 0.6, ym, (w.min[2] + w.max[2]) / 2);
      corners = [[t, w.min[1], w.min[2]], [t, w.min[1], w.max[2]], [t, w.max[1], w.max[2]], [t, w.max[1], w.min[2]]];
    }
    addPortal(a, b, corners, 'window');
  }
  for (const h of layout.roofHoles || []) {
    const y = h.min[1], cx = (h.min[0] + h.max[0]) / 2, cz = (h.min[2] + h.max[2]) / 2;
    addPortal(side(cx, y - 0.5, cz), 0, [[h.min[0], y, h.min[2]], [h.max[0], y, h.min[2]], [h.max[0], y, h.max[2]], [h.min[0], y, h.max[2]]], 'roof');
  }
  for (const p of layout.portals || []) {
    const a = ZONES.findIndex((z) => z.name === p.a), b = ZONES.findIndex((z) => z.name === p.b), y = p.min[1];
    addPortal(a, b, [[p.min[0], y, p.min[2]], [p.max[0], y, p.min[2]], [p.max[0], y, p.max[2]], [p.min[0], y, p.max[2]]], 'shaft');
  }

  // ---------------------------------------------------------------- building occluders (outdoor traversal)
  // The outdoors is one zone, so a portal on the far side of another building would otherwise count as visible.
  // Portals entered from the outdoors are tested against the building volumes (minus the camera's own building and
  // the portal's building): if every sample segment is blocked, the portal is hidden.
  function buildingAt(x, z, m = 0) {
    return BUILDINGS.findIndex((b) => x > b.min[0] - m && x < b.max[0] + m && z > b.min[1] - m && z < b.max[1] + m);
  }
  const occ = BUILDINGS.map((b) => ({ min: [b.min[0] + 0.05, -1, b.min[1] + 0.05], max: [b.max[0] - 0.05, b.roof ?? 8, b.max[1] - 0.05] }));
  function segBlocked(a, b, box) {
    let t0 = 0, t1 = 1;
    const o = [a.x, a.y, a.z], d = [b.x - a.x, b.y - a.y, b.z - a.z];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-9) { if (o[k] < box.min[k] || o[k] > box.max[k]) return false; continue; }
      let u0 = (box.min[k] - o[k]) / d[k], u1 = (box.max[k] - o[k]) / d[k];
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1;
      if (t0 > t1) return false;
    }
    return true;
  }
  let camB = -1;
  const camPos = new THREE.Vector3();
  // Architectural occluders (walls, slabs, roofs, pillars) in a 4 m xz grid. A portal is hidden when the segment
  // from the camera to each of its sample points (pulled 30 cm toward the camera so the opening's own wall pieces
  // are not hit) crosses an occluder.
  const CELL = 4;
  const occList = layout.solids.filter((s) => s.ray && ['wall', 'roof', 'floor', 'pillar'].includes(s.kind) &&
    [0, 1, 2].filter((k) => s.max[k] - s.min[k] > 0.6).length >= 2);
  const grid = new Map();
  const gk = (i, k) => i * 4096 + k;
  occList.forEach((s, n) => {
    for (let i = Math.floor(s.min[0] / CELL); i <= Math.floor(s.max[0] / CELL); i++) for (let k = Math.floor(s.min[2] / CELL); k <= Math.floor(s.max[2] / CELL); k++) {
      const key = gk(i, k);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(n);
    }
  });
  const stamp = new Uint32Array(occList.length);
  let stampId = 1;
  const _os = new THREE.Vector3(), _od = new THREE.Vector3();
  function testCell(ci, ck, a, b) {
    const list = grid.get(gk(ci, ck));
    if (!list) return false;
    for (let j = 0; j < list.length; j++) {
      const n = list[j];
      if (stamp[n] === stampId) continue;
      stamp[n] = stampId;
      if (segBlocked(a, b, occList[n])) return true;
    }
    return false;
  }
  // 2D DDA over the xz cells crossed by the segment
  function rayBlocked(a, b) {
    stampId++;
    const dx = b.x - a.x, dz = b.z - a.z;
    let ci = Math.floor(a.x / CELL), ck = Math.floor(a.z / CELL);
    const ce = Math.floor(b.x / CELL), cke = Math.floor(b.z / CELL);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-9 ? Math.abs(CELL / dx) : Infinity, tdz = Math.abs(dz) > 1e-9 ? Math.abs(CELL / dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-9 ? ((sx > 0 ? (ci + 1) * CELL - a.x : a.x - ci * CELL) / Math.abs(dx)) : Infinity;
    let tmz = Math.abs(dz) > 1e-9 ? ((sz > 0 ? (ck + 1) * CELL - a.z : a.z - ck * CELL) / Math.abs(dz)) : Infinity;
    for (let guard = 0; guard < 256; guard++) {
      if (testCell(ci, ck, a, b)) return true;
      if (ci === ce && ck === cke) return false;
      if (tmx < tmz) { if (tmx > 1) return false; ci += sx; tmx += tdx; } else { if (tmz > 1) return false; ck += sz; tmz += tdz; }
    }
    return false;
  }
  // Occlusion depends on the camera position only: results are cached per portal until the camera moves 15 cm.
  function occluded(p) {
    if (p.occPos && p.occPos.distanceToSquared(camPos) < 0.0225) return p.occ;
    p.occPos = (p.occPos || new THREE.Vector3()).copy(camPos);
    p.occ = occludedNow(p);
    return p.occ;
  }
  function occludedNow(p) {
    for (const s of p.samples) {
      _od.subVectors(camPos, s);
      const l = _od.length();
      if (l < 0.6) return false;
      _os.copy(s).addScaledVector(_od, 0.3 / l);
      if (!rayBlocked(camPos, _os)) return false;
    }
    return true;
  }
  void camB; void occ;

  // ---------------------------------------------------------------- zone lookup
  function zoneAtSoft(x, y, z) {
    const i = zoneIndexAt(x, y, z);
    if (i > 0) return i;
    if (!insideBuilding(x, z) && y > -0.3) return 0;
    const j = zoneIndexAt(x, y, z, 0.7);
    return j;
  }
  // all zones whose boxes are within `m` of the point (camera standing in a doorway sees both rooms)
  const near = [];
  function zonesNear(x, y, z, m) {
    near.length = 0;
    for (let i = 1; i < N; i++) {
      for (const b of ZONES[i].boxes) {
        if (x >= b.min[0] - m && x <= b.max[0] + m && y >= b.min[1] - m && y <= b.max[1] + m && z >= b.min[2] - m && z <= b.max[2] + m) { near.push(i); break; }
      }
    }
    return near;
  }

  // ---------------------------------------------------------------- splitting static geometry by zone
  // Triangles are assigned by their centroid pushed 15 cm along the face normal: the side of a wall a face looks
  // into decides its zone. Faces inside wall thickness / between zones are duplicated into every adjacent zone.
  function zonesOfPoint(x, y, z) {
    const i = zoneIndexAt(x, y, z);
    if (i > 0) return [i];
    if (!insideBuilding(x, z) && y > -0.3) return [0];
    // above every room at this spot (roof tops, wall crowns): outdoors
    let top = -Infinity;
    for (let k = 1; k < N; k++) for (const b of ZONES[k].boxes) if (x >= b.min[0] - 0.45 && x <= b.max[0] + 0.45 && z >= b.min[2] - 0.45 && z <= b.max[2] + 0.45) top = Math.max(top, b.max[1]);
    if (y > top + 0.02) return [0];
    const list = zonesNear(x, y, z, 0.6).slice();
    if (!list.length) return [insideBuilding(x, z) || y < -0.3 ? zoneIndexAt(x, y, z, 2.0) : 0];
    return list;
  }
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3();
  function splitGeometry(geo, matrix = null) {
    const pos = geo.attributes.position;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? idx.length / 3 : pos.count / 3;
    const per = Array.from({ length: N }, () => []);
    const get = (k, out) => { out.fromBufferAttribute(pos, k); if (matrix) out.applyMatrix4(matrix); return out; };
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      get(i0, _a); get(i1, _b); get(i2, _c);
      _n.subVectors(_b, _a).cross(_e.subVectors(_c, _a));
      const l = _n.length();
      if (l > 1e-10) _n.multiplyScalar(0.15 / l); else _n.set(0, 0, 0);
      const x = (_a.x + _b.x + _c.x) / 3 + _n.x, y = (_a.y + _b.y + _c.y) / 3 + _n.y, z = (_a.z + _b.z + _c.z) / 3 + _n.z;
      for (const zi of zonesOfPoint(x, y, z)) per[zi].push(i0, i1, i2);
    }
    const out = [];
    for (let zi = 0; zi < N; zi++) {
      const list = per[zi];
      if (!list.length) continue;
      const remap = new Map();
      const order = [];
      const ni = new Uint32Array(list.length);
      for (let k = 0; k < list.length; k++) {
        let v = remap.get(list[k]);
        if (v === undefined) { v = order.length; remap.set(list[k], v); order.push(list[k]); }
        ni[k] = v;
      }
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) {
        const s = attr.itemSize, src = attr.array, dst = new src.constructor(order.length * s);
        for (let k = 0; k < order.length; k++) for (let c = 0; c < s; c++) dst[k * s + c] = src[order[k] * s + c];
        g.setAttribute(name, new THREE.BufferAttribute(dst, s, attr.normalized));
      }
      g.setIndex(new THREE.BufferAttribute(order.length > 65535 ? ni : Uint16Array.from(ni), 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      out.push([zi, g]);
    }
    return out;
  }
  function cloneMeshProps(src, dst) {
    dst.name = src.name; dst.castShadow = src.castShadow; dst.receiveShadow = src.receiveShadow;
    dst.renderOrder = src.renderOrder; dst.frustumCulled = src.frustumCulled;
    dst.userData = { ...src.userData };
    dst.matrixAutoUpdate = false; dst.matrix.copy(src.matrix); dst.matrixWorld.copy(src.matrixWorld);
    if (src.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow) dst.onBeforeShadow = src.onBeforeShadow;
    if (src.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow) dst.onAfterShadow = src.onAfterShadow;
  }
  /** Splits a static mesh (world-space geometry, identity transform) into per-zone meshes added to the zone groups. */
  function addSplit(mesh) {
    if (mesh.isInstancedMesh) return addInstanced(mesh);
    mesh.updateMatrixWorld(true);
    const isId = mesh.matrixWorld.equals(_m.identity());
    const parts = splitGeometry(mesh.geometry, isId ? null : mesh.matrixWorld);
    for (const [zi, g] of parts) {
      if (!isId) g.applyMatrix4(_m.copy(mesh.matrixWorld).invert());
      const m = new THREE.Mesh(g, mesh.material);
      cloneMeshProps(mesh, m);
      m.name = mesh.name + '@' + ZONES[zi].name;
      groups[zi].add(m);
    }
    mesh.geometry.dispose();
    return parts.length;
  }
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _im = new THREE.Matrix4();
  function addInstanced(mesh) {
    mesh.updateMatrixWorld(true);
    const per = new Map();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, _im);
      _im.premultiply(mesh.matrixWorld);
      _p.setFromMatrixPosition(_im);
      const zi = zonesOfPoint(_p.x, _p.y + 0.2, _p.z)[0];
      if (!per.has(zi)) per.set(zi, []);
      per.get(zi).push(i);
    }
    for (const [zi, list] of per) {
      const m = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      const col = new THREE.Color();
      list.forEach((src, k) => {
        mesh.getMatrixAt(src, _im); m.setMatrixAt(k, _im);
        if (mesh.instanceColor) { mesh.getColorAt(src, col); m.setColorAt(k, col); }
      });
      cloneMeshProps(mesh, m);
      m.name = mesh.name + '@' + ZONES[zi].name;
      m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere(); m.computeBoundingBox?.();
      groups[zi].add(m);
    }
    return per.size;
  }
  /** Adds a small object (fixture, lamp) whole to the zone of its position. */
  function addAt(obj, pos) {
    const p = pos || new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    const zi = zonesOfPoint(p.x, p.y, p.z)[0];
    groups[zi].add(obj);
    return zi;
  }

  // ---------------------------------------------------------------- per-frame visibility
  const rect = new Float32Array(N * 4);      // union of the screen rects a zone was entered with this frame
  const has = new Uint8Array(N);
  const vp = new THREE.Matrix4();
  const stats = { zone: -1, visible: 0, portals: 0 };
  function project(p, out) {
    let behind = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of p.c) {
      _v.set(c.x, c.y, c.z, 1).applyMatrix4(vp);
      if (_v.w < 0.05) { behind++; continue; }
      const x = _v.x / _v.w, y = _v.y / _v.w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (behind === 4) return false;
    if (behind > 0) { out[0] = -1; out[1] = 1; out[2] = -1; out[3] = 1; return true; }
    out[0] = x0 - 0.02; out[1] = x1 + 0.02; out[2] = y0 - 0.02; out[3] = y1 + 0.02;
    return true;
  }
  const tmp = new Float32Array(4);
  function visit(z, r0, r1, r2, r3, depth, from) {
    visible[z] = 1;
    if (depth > 24) return;
    for (const p of pAdj[z]) {
      if (p === from) continue;
      stats.portals++;
      if (!project(p, tmp)) continue;
      if (occluded(p)) { stats.occluded++; continue; }
      const a0 = Math.max(r0, tmp[0]), a1 = Math.min(r1, tmp[1]), b0 = Math.max(r2, tmp[2]), b1 = Math.min(r3, tmp[3]);
      if (a0 >= a1 || b0 >= b1) continue;
      const o = p.a === z ? p.b : p.a, k = o * 4;
      if (has[o] && rect[k] <= a0 && rect[k + 1] >= a1 && rect[k + 2] <= b0 && rect[k + 3] >= b1) continue;   // nothing new
      if (has[o]) { rect[k] = Math.min(rect[k], a0); rect[k + 1] = Math.max(rect[k + 1], a1); rect[k + 2] = Math.min(rect[k + 2], b0); rect[k + 3] = Math.max(rect[k + 3], b1); }
      else { has[o] = 1; rect[k] = a0; rect[k + 1] = a1; rect[k + 2] = b0; rect[k + 3] = b1; }
      visit(o, a0, a1, b0, b1, depth + 1, p);
    }
  }
  let enabled = true;
  function update(camera) {
    if (!enabled) { visible.fill(1); apply(); return; }
    camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const c = camera.getWorldPosition(_p);
    camPos.copy(c); camB = buildingAt(c.x, c.z);
    visible.fill(0); has.fill(0); stats.portals = 0; stats.occluded = 0;
    const tq = performance.now();
    const start = zonesNear(c.x, c.y, c.z, 0.3).slice();
    const inner = zoneIndexAt(c.x, c.y, c.z);
    if (!start.length || (inner === 0 && !insideBuilding(c.x, c.z) && c.y > -0.3)) start.push(0);
    stats.zone = inner;
    for (const z of start) { has[z] = 1; rect.set([-1, 1, -1, 1], z * 4); }
    for (const z of start) visit(z, -1, 1, -1, 1, 0, null);
    stats.ms = performance.now() - tq;
    apply();
  }
  function apply() {
    let n = 0;
    for (let i = 0; i < N; i++) {
      const on = !!(visible[i] || forced[i]);
      groups[i].visible = on;
      if (on) n++;
    }
    stats.visible = n;
  }
  function showAll() { visible.fill(1); apply(); }
  /** Zones reachable from zone z within `hops` portals (for probe captures). */
  function neighbourhood(z, hops = 2) {
    const seen = new Set([z]);
    let frontier = [z];
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const u of frontier) for (const p of pAdj[u]) { const o = p.a === u ? p.b : p.a; if (!seen.has(o)) { seen.add(o); next.push(o); } }
      frontier = next;
    }
    return seen;
  }
  function showOnly(set) { for (let i = 0; i < N; i++) groups[i].visible = set.has(i); }
  const isVisible = (x, y, z) => {
    const list = zonesOfPoint(x, y + 1.0, z);
    return list.some((i) => visible[i]);
  };

  return {
    groups, portals, visible, forced, stats,
    addSplit, addInstanced, addAt, update, showAll, showOnly, neighbourhood, isVisible,
    zoneOf: (x, y, z) => zonesOfPoint(x, y, z)[0],
    set enabled(v) { enabled = !!v; if (!enabled) showAll(); }, get enabled() { return enabled; },
  };
}

// ------------------------------------------------------------------ raycast proxies in clusters
// Proxies (unit boxes scaled to each solid) are grouped in a coarse xz grid. Each cluster group rejects rays that
// miss its bounding box (Object3D.raycast returning false stops the recursion in three's Raycaster).
export function clusterProxies(proxies, cell = 10) {
  const big = [], cells = new Map();
  const box = new THREE.Box3(), _p = new THREE.Vector3();
  for (const m of proxies) {
    box.setFromObject(m);
    const sz = box.getSize(_p);
    if (Math.max(sz.x, sz.z) > cell * 1.5) { big.push(m); continue; }
    const c = box.getCenter(_p);
    const k = Math.floor(c.x / cell) + ':' + Math.floor(c.z / cell);
    if (!cells.has(k)) cells.set(k, { list: [], box: new THREE.Box3() });
    const e = cells.get(k);
    e.list.push(m); e.box.union(box);
  }
  const roots = [...big];
  const _t = new THREE.Vector3();
  for (const { list, box: b } of cells.values()) {
    const g = new THREE.Group();
    g.name = 'proxy-cluster';
    g.userData.box = b.clone().expandByScalar(0.01);
    g.raycast = function (raycaster) {
      const bb = this.userData.box, ray = raycaster.ray;
      if (bb.containsPoint(ray.origin)) return undefined;
      const hit = ray.intersectBox(bb, _t);
      if (!hit || hit.distanceTo(ray.origin) > raycaster.far) return false;
      return undefined;
    };
    for (const m of list) g.add(m);
    g.updateMatrixWorld(true);
    roots.push(g);
  }
  return roots;
}
