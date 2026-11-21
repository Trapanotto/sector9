// Workstream A entry: world art + moving machines.
//   init(): paints the art atlas, builds the static art (one mesh/draw, src/world/art/static.js), swaps the door
//           leaves to art geometry, and builds ONE rigid-skinned mesh for every moving machine part.
// Machines API (CONTRACT.md §4, used by the director):
//   ctx.machines.agv(id)      { dispatch(), stop(), state 'running'|'parked'|'blocked'|'estop' }
//   ctx.machines.conveyor(id) { start(), stop(), state 'running'|'stopped'|'estop' }   (c_loop drives the sorter)
//   ctx.machines.robot(id)    { start(), stop(), state 'running'|'idle'|'estop' }
//   ctx.machines.crane(id)    { start(), stop(), state 'running'|'stopped'|'estop' }
//   ctx.machines.emergencyStop(on = true)   all machines halt (state 'estop'); false releases to the previous state
//   lists agvs, conveyors, robots, cranes; ctx.machines.art (stats)
// Events: 'machine:state' { id, kind: 'agv'|'conveyor'|'robot'|'crane', state } on every state change (AGVs also
// emit 'blocked' / 'running' when they stop for an obstacle). Additional (A): 'a:sorter' { id: chuteId, index }
// when the sorter diverts a carton; 'a:robot' { id, phase: 'pick'|'place' }; 'a:crane' { id, phase: 'pick'|'drop' }.
// Moving parts animate only while their zone is PVS-visible (they still advance deterministically in time).
import * as THREE from 'three';
import { paintAtlas } from './art/atlas.js';
import { ATLAS_W, ATLAS_H } from './art/tiles.js';
import { createArtMaterial, createAtlasTexture, geometryFromBuilder, MAX_BELTS } from './art/material.js';
import { createStaticArt } from './art/static.js';
import { Builder, M } from './art/kit.js';
import { conveyorPath, pathPoint, BELT_TILE_M } from './art/conveyors.js';
import { agvBody, agvBeacon, craneMast, craneCarriage, craneFork, craneLoad, robotTurret, robotUpper, robotFore, robotWrist, robotGripper, cartonPart, paddlePart, doorLeaf } from './art/machinery.js';

const ROB = { h1: 0.62, a1: 0.25, L2: 1.35, L3: 1.45, tool: 0.42 };

export function createMachines(ctx) {
  const L = ctx.layout;
  const m = { id: 'machines', order: ctx.ORDER.machines, agvs: [], conveyors: [], robots: [], cranes: [], art: null };
  const evt = { id: '', kind: '', state: '' };
  const emit = (id, kind, state) => { evt.id = id; evt.kind = kind; evt.state = state; ctx.events.emit('machine:state', evt); };
  const aEvt = { id: '', index: 0, phase: '' };
  const emitA = (name, id, phase, index = 0) => { aEvt.id = id; aEvt.phase = phase; aEvt.index = index; ctx.events.emit(name, aEvt); };
  let estop = false;
  let material = null, skinned = null;
  const bones = [];
  const tmp = [0, 0, 0, 0];

  function routeLen(pts, loop) {
    const segs = []; let total = 0;
    const n = loop ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, l, s: total }); total += l; }
    return { segs, total };
  }

  // ------------------------------------------------------------------------------------------------------
  m.init = () => {
    const t0 = performance.now();
    const atlas = createAtlasTexture(paintAtlas(), ctx.render.renderer);
    ctx.render.trackTexture('artAtlas', ATLAS_W * ATLAS_H * 4 * 1.333);
    material = createArtMaterial(atlas);
    const paintMs = performance.now() - t0;
    const st = createStaticArt(ctx, material);
    m.art = { paintMs, ...st.stats, perType: st.perType };
    swapDoors();
    buildMachines();
    m.art.totalMs = performance.now() - t0;
  };

  function swapDoors() {
    for (const d of ctx.world.doors?.list ?? []) {
      const b = new Builder();
      b.target(['d']);
      doorLeaf(b, d);
      const g = geometryFromBuilder(b);
      g.setIndex(new THREE.BufferAttribute(b.targets.get('d').view().slice(), 1));
      g.computeBoundingSphere();
      d.mesh.geometry.dispose();
      d.mesh.geometry = g;
      d.mesh.material = material;
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // one skinned mesh: every bone is a rigid part; geometry is authored in bone-local space
  function buildMachines() {
    const b = new Builder({ skin: true });
    b.target(['m']);
    const root = new THREE.Bone(); root.name = 'machines';
    const bone = (parent = root, build = null) => {
      const bn = new THREE.Bone(); bones.push(bn); (parent ?? root).add(bn);
      if (build) { b.bone = bones.length; b.groundY = -1e9; build(); }   // skin index = position in skeleton (root is 0)
      return bn;
    };
    // --- AGVs
    for (const a of L.agvs) {
      const r = L.agvRoutes.find((x) => x.id === a.route);
      const body = bone(root, () => agvBody(b, a.kind));
      const beacon = bone(body, () => agvBeacon(b));
      beacon.position.set(-0.36, 0.56, 0.6);
      const col = ctx.world.collision.addDynamic([0, 0, 0], [0, 0, 0], { kind: 'agv', id: a.id, surface: 'metal', shoot: true });
      const rec = { ...a, body, beacon, route: routeLen(r.points, r.loop), s: 0, state: a.state, col, speed: a.speed, v: 0, hold: 0, x: 0, z: 0, yaw: 0, prevState: a.state };
      rec.s = a.start * rec.route.total;
      rec.dispatch = () => setAgv(rec, 'running');
      rec.stop = () => setAgv(rec, 'parked');
      m.agvs.push(rec);
    }
    // --- conveyors: belt state + cartons on c_loop, sorter paddles; c_akl cartons for the robot
    for (const c of L.conveyors) {
      const rec = { ...c, state: c.state, s: 0, path: conveyorPath(c), prevState: c.state };
      rec.start = () => setConveyor(rec, 'running');
      rec.stop = () => setConveyor(rec, 'stopped');
      m.conveyors.push(rec);
    }
    const loop = m.conveyors.find((c) => c.id === L.sorter.conveyor);
    const NLOOP = 18;
    loop.cartons = [];
    for (let i = 0; i < NLOOP; i++) {
      const w = 0.4 + ((i * 7) % 3) * 0.08, h = 0.22 + ((i * 5) % 4) * 0.05, d = 0.3 + ((i * 3) % 2) * 0.08;
      const bn = bone(root, () => cartonPart(b, w, h, d, i % 2));
      loop.cartons.push({ bone: bn, slot: i, mode: 'belt', chute: -1, t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    }
    loop.spacing = loop.path.total / NLOOP;
    loop.chutes = L.sorter.chutes.map((ch, k) => {
      const pivot = bone(root, () => paddlePart(b));
      pivot.position.set(79.08, 0.82, (ch.z0 + ch.z1) / 2 - 0.35);
      return { ...ch, k, zc: (ch.z0 + ch.z1) / 2, pivot, fire: 0, held: [] };
    });
    // AKL outfeed cartons (wall hole → robot pick position)
    const akl = m.conveyors.find((c) => c.id === 'c_akl');
    if (akl) { akl.cartons = []; for (let i = 0; i < 3; i++) akl.cartons.push({ bone: bone(root, () => cartonPart(b, 0.5, 0.3, 0.35, i % 2)), u: -1 }); }
    // --- crane
    for (const c of L.cranes) {
      const mast = bone(root, () => craneMast(b, c.mastH));
      const car = bone(mast, () => craneCarriage(b));
      const fork = bone(car, () => craneFork(b));
      const ld = bone(root, () => craneLoad(b));
      const colM = ctx.world.collision.addDynamic([0, 0, 0], [0, 0, 0], { kind: 'crane', id: c.id, surface: 'metal', shoot: true });
      const colC = ctx.world.collision.addDynamic([0, 0, 0], [0, 0, 0], { kind: 'crane', id: c.id, surface: 'metal', shoot: true });
      const rec = { ...c, mast, car, fork, load: ld, colM, colC, state: c.state, prevState: c.state, t: 0, z: c.z0, y: 1.0, fx: 0, slots: aklSlots(c), plan: null, phase: 0, carry: false, loadAt: null, seq: 0 };
      rec.start = () => setCrane(rec, 'running');
      rec.stop = () => setCrane(rec, 'stopped');
      m.cranes.push(rec);
    }
    // --- robot
    for (const r of L.robots) {
      const turret = bone(root, () => robotTurret(b));
      const upper = bone(turret, () => robotUpper(b, ROB.L2));
      const fore = bone(upper, () => robotFore(b, ROB.L3));
      const wrist = bone(fore, () => robotWrist(b));
      const grip = bone(wrist, () => robotGripper(b, ROB.tool));
      turret.position.set(...r.base);
      upper.position.set(0, ROB.h1, ROB.a1); fore.position.set(0, ROB.L2, 0); wrist.position.set(0, ROB.L3, 0);
      const hand = bone(grip, () => cartonPart(b, 0.5, 0.3, 0.35, 1));
      hand.position.set(0, -ROB.tool - 0.3, 0);
      const placed = [];
      for (let i = 0; i < 12; i++) placed.push({ bone: bone(root, () => cartonPart(b, 0.5, 0.3, 0.35, i % 2)), on: false });
      const col = ctx.world.collision.addDynamic([0, 0, 0], [0, 0, 0], { kind: 'robot', id: r.id, surface: 'metal', shoot: true, sight: false });
      const rec = { ...r, turret, upper, fore, wrist, grip, hand, placed, col, state: r.state, prevState: r.state, t: 0, cyc: 0, held: -1, tool: new THREE.Vector3(), q: [0, 0.3, 0.6] };
      rec.start = () => setRobot(rec, 'running');
      rec.stop = () => setRobot(rec, 'idle');
      m.robots.push(rec);
    }
    // --- mesh
    const g = geometryFromBuilder(b);
    g.setIndex(new THREE.BufferAttribute(b.targets.get('m').view().slice(), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(70, 3, 30), 80);
    // own material instance (same uniforms object): three re-derives the program parameters every frame when ONE
    // material alternates between skinned and static meshes (≈ 7 KB garbage + CPU per frame)
    const skinMat = createArtMaterial(material.uniforms.uMap?.value ?? null);
    skinMat.uniforms = material.uniforms;
    skinned = new THREE.SkinnedMesh(g, skinMat);
    skinned.name = 'art:machines';
    skinned.frustumCulled = false;
    skinned.add(root);
    const all = [root, ...bones];
    skinned.bind(new THREE.Skeleton(all, all.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    ctx.render.scene.add(skinned);
    m.art.machineTris = b.tris; m.art.machineBones = all.length;
    m.reset();
  }

  /** empty AKL slots next to the crane aisle (bay, level, side) → world centre of a pallet position */
  function aklSlots(c) {
    const occ = new Set();
    for (const r of L.raw) if (r.group === 'akl' && r.surf !== 'steel') occ.add(`${r.rack}:${Math.round(r.min[1] * 100)}:${Math.round(r.min[2] * 10)}`);
    const out = [];
    for (const [rack, x0, x1, side] of [['akl_w', 84.1, 88.9, -1], ['akl_o', 90.5, 95.9, 1]]) {
      for (let k = 0; k < 12; k++) for (let l = 0; l < 11; l++) {
        const z0 = 0.4 + k * 2.75, y = 0.3 + l * 1.02;
        const key = `${rack}:${Math.round(y * 100)}:${Math.round((z0 + 0.06 + 0.04) * 10)}`;
        if (occ.has(key)) continue;
        out.push({ side, x: c.x + side * 1.4, y, z: z0 + 1.375 });
      }
    }
    return out.filter((s) => s.z > c.z0 && s.z < c.z1);
  }

  // ------------------------------------------------------------------------------------------------------
  // state setters (emit only on change)
  function setAgv(a, s) { if (estop && s === 'running') { a.prevState = s; return; } if (a.state === s) return; a.state = s; emit(a.id, 'agv', s); }
  function setConveyor(c, s) { if (estop && s === 'running') { c.prevState = s; return; } if (c.state === s) return; c.state = s; emit(c.id, 'conveyor', s); }
  function setRobot(r, s) { if (estop && s === 'running') { r.prevState = s; return; } if (r.state === s) return; r.state = s; emit(r.id, 'robot', s); }
  function setCrane(c, s) { if (estop && s === 'running') { c.prevState = s; return; } if (c.state === s) return; c.state = s; emit(c.id, 'crane', s); }
  m.emergencyStop = (on = true) => {
    if (on === estop) return;
    estop = on;
    const all = [[m.agvs, 'agv'], [m.conveyors, 'conveyor'], [m.robots, 'robot'], [m.cranes, 'crane']];
    for (const [list, kind] of all) for (const x of list) {
      if (on) { x.prevState = x.state === 'blocked' ? 'running' : x.state; x.state = 'estop'; emit(x.id, kind, 'estop'); }
      else { x.state = x.prevState; emit(x.id, kind, x.state); }
    }
  };

  // ------------------------------------------------------------------------------------------------------
  // AGVs: follow the route, slow down / stop for the player, enemies and other AGVs ahead
  function agvBlocked(a, fx, fz) {
    const ahead = 1.9, half = 0.65;
    const test = (px, pz) => {
      const dx = px - a.x, dz = pz - a.z, along = dx * fx + dz * fz, lat = Math.abs(-dx * fz + dz * fx);
      return along > 0.3 && along < ahead && lat < half;
    };
    const p = ctx.player?.pos;
    if (p && !ctx.player.dead && Math.abs(p.y) < 1.5 && test(p.x, p.z)) return true;
    const en = ctx.enemies?.list;
    if (en) for (let i = 0; i < en.length; i++) { const e = en[i]; if (!e.dead && e.pos && Math.abs(e.pos.y) < 1.5 && test(e.pos.x, e.pos.z)) return true; }
    for (let i = 0; i < m.agvs.length; i++) { const o = m.agvs[i]; if (o !== a && test(o.x, o.z)) return true; }
    return false;
  }
  function placeAgv(a, dt) {
    const R = a.route;
    let seg = R.segs[0];
    for (let i = 0; i < R.segs.length; i++) { const s = R.segs[i]; if (a.s >= s.s && a.s <= s.s + s.l) seg = s; }
    const fx = (seg.b[0] - seg.a[0]) / seg.l, fz = (seg.b[1] - seg.a[1]) / seg.l;
    const want = a.state === 'running' || a.state === 'blocked';
    if (want && dt > 0) {
      const blk = agvBlocked(a, fx, fz);
      if (blk) { a.hold = 1.0; if (a.state === 'running') setAgv(a, 'blocked'); }
      else if (a.hold > 0) { a.hold -= dt; if (a.hold <= 0 && a.state === 'blocked') setAgv(a, 'running'); }
      const target = a.state === 'running' ? a.speed : 0;
      a.v += Math.sign(target - a.v) * Math.min(Math.abs(target - a.v), (target > a.v ? 0.8 : 2.5) * dt);
    } else a.v = Math.max(0, a.v - 2.5 * dt);
    a.s = (a.s + a.v * dt) % R.total;
    // corner smoothing: blend heading over the last/first 0.6 m of a segment
    const f = (a.s - seg.s) / seg.l;
    a.x = seg.a[0] + (seg.b[0] - seg.a[0]) * f; a.z = seg.a[1] + (seg.b[1] - seg.a[1]) * f;
    let yaw = Math.atan2(-fx, -fz);
    const toEnd = seg.s + seg.l - a.s;
    if (toEnd < 0.6) {
      const nx = R.segs[(R.segs.indexOf(seg) + 1) % R.segs.length];
      const y2 = Math.atan2(-(nx.b[0] - nx.a[0]), -(nx.b[1] - nx.a[1]));
      let d = y2 - yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      yaw += d * 0.5 * (1 - toEnd / 0.6);
    } else if (a.s - seg.s < 0.6) {
      const pv = R.segs[(R.segs.indexOf(seg) - 1 + R.segs.length) % R.segs.length];
      const y0 = Math.atan2(-(pv.b[0] - pv.a[0]), -(pv.b[1] - pv.a[1]));
      let d = y0 - yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      yaw += d * 0.5 * (1 - (a.s - seg.s) / 0.6);
    }
    a.yaw = yaw;
    a.body.position.set(a.x, 0, a.z); a.body.rotation.y = yaw;
    const alongX = Math.abs(fx) > Math.abs(fz);
    const hx = alongX ? 0.7 : 0.45, hz = alongX ? 0.45 : 0.7;
    a.col.min[0] = a.x - hx; a.col.min[1] = 0; a.col.min[2] = a.z - hz;
    a.col.max[0] = a.x + hx; a.col.max[1] = a.kind === 'tugger' ? 1.35 : 0.5; a.col.max[2] = a.z + hz;
    const on = (a.state === 'running' || a.state === 'blocked') && (ctx.time.now * 1.6 % 1) < 0.45;
    a.beacon.scale.setScalar(on ? 1 : 0.0001);
  }

  // ------------------------------------------------------------------------------------------------------
  // conveyor loop + sorter
  const SORT_EVERY = 3;
  function updateLoop(c, dt) {
    const running = c.state === 'running';
    const v = running ? c.speed : 0;
    c.s += v * dt;
    U_BELT(0, -c.s / BELT_TILE_M);
    const sorter = L.sorter;
    const vis = ctx.world.isPointVisible(77, 0.8, 25);
    for (const k of c.chutes) {
      // paddle swing (fire → 0.35 s out, back)
      if (k.fire > 0) k.fire = Math.max(0, k.fire - dt);
      const ph = k.fire > 0 ? Math.sin((1 - k.fire / 0.7) * Math.PI) : 0;
      k.pivot.rotation.y = -ph * 0.9;
      // chute cleared while nobody looks (staff empties it)
      if (k.held.length && !vis) { for (const ct of k.held) ct.mode = 'gone'; k.held.length = 0; }
    }
    if (!vis) for (const ct of c.cartons) if (ct.mode === 'burst') ct.mode = 'gone';
    for (const ct of c.cartons) {
      if (ct.mode === 'gone') {
        // re-induct inside the scanner tunnel when its slot passes the induction point unseen
        const sPos = (c.s + ct.slot * c.spacing) % c.path.total;
        if (sPos > c.induct && sPos < c.induct + 0.3 && (!vis || !ctx.world.isPointVisible(74.5, 0.8, 29))) { ct.mode = 'belt'; ct.burst = false; ct.forced = false; }
        else { ct.bone.scale.setScalar(0.0001); continue; }
      }
      if (ct.mode === 'belt') {
        const s = c.s + ct.slot * c.spacing;
        pathPoint(c.path, s, tmp);
        const pz = ct.z;
        ct.x = tmp[0]; ct.y = tmp[1]; ct.z = tmp[2]; ct.yaw = tmp[3];
        // sorter: every SORT_EVERY-th carton goes to the chute picked by its slot, if the chute has room
        if (running && ct.slot % SORT_EVERY === 0 && Math.abs(ct.x - 79.5) < 0.05 && ct.z > sorter.z0 && ct.z < sorter.z1) {
          const k = c.chutes[(ct.slot / SORT_EVERY + Math.floor(c.s / c.path.total)) % c.chutes.length];
          if (k.held.length < 3 && pz < k.zc && ct.z >= k.zc) {
            ct.mode = 'divert'; ct.t = 0; ct.chute = k.k; k.fire = 0.7; k.held.push(ct); ct.rest = k.held.length - 1;
            emitA('a:sorter', k.id, 'divert', k.k);
          }
        }
      } else if (ct.mode === 'divert' && ct.burst) {
        // staged divert: pushed off the belt, over the chute lip, falls to the floor and bursts
        ct.t += dt;
        const k = c.chutes[ct.chute], u = Math.min(1, ct.t / 1.1);
        if (u < 0.3) { const f = u / 0.3; ct.x = 79.5 + f * 0.5; ct.y = 0.8 - f * 0.08; ct.z += (k.zc - ct.z) * Math.min(1, dt * 6); }
        else { const f = (u - 0.3) / 0.7; ct.x = 80.0 + f * 0.9; ct.y = Math.max(0, 0.72 + 0.6 * f - 1.32 * f * f * 1.0); ct.yaw += dt * 2.5; }
        if (u >= 1) {
          ct.mode = 'burst'; ct.y = 0;
          burstPt.x = ct.x; burstPt.y = 0.15; burstPt.z = ct.z;
          ctx.fx?.powder?.(burstPt);
          emitA('a:sorter', k.id, 'burst', k.k);
        }
      } else if (ct.mode === 'divert') {
        ct.t += dt * (running || ct.forced ? 1 : 0.0);
        const k = c.chutes[ct.chute];
        const u = Math.min(1, ct.t / 1.2);
        // across the belt (0..0.35), then down the slide to its rest place
        const xr = 80.62 - ct.rest * 0.0, zr = k.zc + (ct.rest - 1) * 0.36;
        if (u < 0.35) { const f = u / 0.35; ct.x = 79.5 + f * 0.45; ct.y = 0.8 - f * 0.06; ct.z += (k.zc - ct.z) * Math.min(1, dt * 6); ct.yaw += dt * 0.6; }
        else { const f = (u - 0.35) / 0.65; ct.x = 79.95 + (xr - 79.95) * f; ct.y = 0.74 - 0.22 * f; ct.z += (zr - ct.z) * Math.min(1, dt * 4); }
        ct.yaw *= Math.max(0, 1 - dt * 3);
        if (u >= 1) { ct.mode = 'chute'; ct.yaw = 0; }
      }
      if (ct.mode === 'burst') ct.bone.scale.set(1.15, 0.35, 1.1); else ct.bone.scale.setScalar(1);
      ct.bone.position.set(ct.x, ct.y, ct.z);
      ct.bone.rotation.set(ct.mode === 'chute' || (ct.mode === 'divert' && ct.t > 0.42) ? 0.0 : 0, ct.yaw, ct.mode === 'chute' ? -0.26 : 0);
    }
  }
  const burstPt = { x: 0, y: 0, z: 0 };
  /** staged sorter divert (director): the nearest belt carton is pushed into chute `chuteId` right now; with
   *  opts.burst it overshoots the chute, falls and bursts (ctx.fx.powder at the landing point, 'a:sorter' burst) */
  m.sorter = {
    divert(chuteId = 'chute3', opts = {}) {
      const c = m.conveyors.find((x) => x.id === L.sorter.conveyor); if (!c) return false;
      const k = c.chutes.find((x) => x.id === chuteId) ?? c.chutes[2];
      let best = null, bd = Infinity;
      for (const ct of c.cartons) if (ct.mode === 'belt') { const d = Math.abs(ct.x - 79.5) + Math.abs(ct.z - k.zc); if (d < bd) { bd = d; best = ct; } }
      if (!best) return false;
      best.mode = 'divert'; best.t = 0; best.chute = k.k; best.burst = !!opts.burst; best.forced = true; best.x = 79.5; best.y = 0.8; best.z = k.zc - 0.4;
      if (!best.burst) { k.held.push(best); best.rest = k.held.length - 1; }
      k.fire = 0.7;
      emitA('a:sorter', k.id, 'divert', k.k);
      return true;
    },
  };
  // anchors for staged moments (fog at the cold store door etc.)
  m.anchors = { coldStoreDoor: [85.8, 1.0, 56.7], sorterChute3: [80.4, 0.6, 24], robot: [90, 1.5, 41], craneIO: [89.7, 1.0, 31.5] };
  m.anchor = (name) => m.anchors[name] ?? null;
  function U_BELT(i, v) { if (material) material.uniforms.uBelt.value[i] = v - Math.floor(v); }

  // AKL outfeed: cartons appear in the wall hole, roll to the end stop; the robot picks the front one
  function updateAkl(c, dt) {
    const running = c.state === 'running' || m.robots.some((r) => r.state === 'running');
    c.s += (running ? c.speed : 0) * dt;
    U_BELT(1, -c.s / (2 * Math.PI * 0.025));
    const z0 = 33.6, zEnd = 38.0;
    let front = zEnd;
    // sorted by u descending: the leading carton stops at the end stop, the others queue behind
    const list = c.cartons;
    for (let i = 0; i < list.length; i++) {
      const ct = list[i];
      if (ct.u < 0) {
        // spawn when the queue has room
        if (running && !list.some((o) => o.u >= 0 && o.u < z0 + 0.6)) ct.u = z0;
        else { ct.bone.scale.setScalar(0.0001); continue; }
      }
    }
    list.sort((p, q) => q.u - p.u);
    for (const ct of list) {
      if (ct.u < 0) continue;
      const lim = front;
      if (running) ct.u = Math.min(lim, ct.u + c.speed * dt);
      front = ct.u - 0.4;
      ct.bone.scale.setScalar(1);
      ct.bone.position.set(89.75, 0.8, ct.u); ct.bone.rotation.set(0, 0, 0);
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // stacker crane: relocates one pallet between empty slots (Umlagerung) — deterministic plan
  function cranePlan(c) {
    const S = c.slots; if (!S.length) return null;
    const pick = c.loadAt ?? S[0];
    const k = (c.seq * 7 + 3) % S.length;
    let drop = S[k]; if (drop === pick) drop = S[(k + 1) % S.length];
    c.seq++;
    return { pick, drop };
  }
  // trapezoid move helper: returns new value moving towards target with speed v
  const moveTo = (cur, tgt, v, dt) => (Math.abs(tgt - cur) <= v * dt ? tgt : cur + Math.sign(tgt - cur) * v * dt);
  function updateCrane(c, dt) {
    const run = c.state === 'running';
    if (!c.plan) c.plan = cranePlan(c);
    const P = c.plan;
    if (run && P) {
      const tgt = c.phase < 4 ? P.pick : P.drop;
      const picking = c.phase < 4;
      const approach = picking ? tgt.y - 0.1 : tgt.y + 0.08, hy = picking ? tgt.y + 0.08 : tgt.y - 0.1;
      switch (c.phase % 4) {
        case 0: {   // travel + lift to the slot (fork level slightly below the pallet)
          const vz = Math.min(c.speed, 0.4 + Math.abs(tgt.z - c.z) * 0.9);
          c.z = moveTo(c.z, tgt.z, vz, dt); c.y = moveTo(c.y, approach, 0.9, dt);
          c.fx = moveTo(c.fx, 0, 0.6, dt);
          if (c.z === tgt.z && c.y === approach && c.fx === 0) c.phase++;
          break;
        }
        case 1: { c.fx = moveTo(c.fx, tgt.side * 1.4, 0.5, dt); if (c.fx === tgt.side * 1.4) c.phase++; break; }
        case 2: {
          c.y = moveTo(c.y, hy, 0.2, dt);
          if (c.y === hy) { c.carry = picking; if (!c.carry) c.loadAt = tgt; emitA('a:crane', c.id, c.carry ? 'pick' : 'drop'); c.phase++; }
          break;
        }
        case 3: { c.fx = moveTo(c.fx, 0, 0.5, dt); if (c.fx === 0) { c.phase++; if (c.phase >= 8) { c.phase = 0; c.t = 2.5; c.plan = null; } } break; }
        default: break;
      }
      if (c.t > 0) { c.t -= dt; }
    }
    c.mast.position.set(c.x, 0.08, c.z);
    c.car.position.set(0, c.y - 0.08 - 0.26, 0);
    c.fork.position.set(c.fx, 0, 0);
    if (c.carry) {
      c.fork.updateWorldMatrix(true, false);
      c.load.position.set(c.x + c.fx, c.y, c.z);
    } else {
      const at = c.loadAt ?? c.slots[0];
      if (at) c.load.position.set(at.x, at.y, at.z);
    }
    // colliders: mast + lifting carriage
    c.colM.min[0] = c.x - 0.45; c.colM.max[0] = c.x + 0.45; c.colM.min[1] = 0; c.colM.max[1] = c.mastH + 0.2;
    c.colM.min[2] = c.z - 0.3; c.colM.max[2] = c.z + 0.3;
    c.colC.min[0] = c.x - 0.72 + Math.min(0, c.fx); c.colC.max[0] = c.x + 0.72 + Math.max(0, c.fx); c.colC.min[1] = c.y - 0.35; c.colC.max[1] = c.y + 0.8;
    c.colC.min[2] = c.z - 0.75; c.colC.max[2] = c.z + 0.75;
  }

  // ------------------------------------------------------------------------------------------------------
  // palletising robot: pick at the AKL outfeed end, place in a 2 × 3 pattern on alternating stations
  const PATTERN = [[-0.27, -0.21, 0], [0.27, -0.21, 0], [-0.27, 0.21, 0], [0.27, 0.21, 0], [0, -0.21, 1], [0, 0.21, 1]];
  const v3 = new THREE.Vector3();
  function robotIK(r, x, y, z, yawTool) {
    const B = r.base;
    const dx = x - B[0], dz = z - B[2];
    const q1 = Math.atan2(dx, dz);
    const rr = Math.max(0.3, Math.hypot(dx, dz) - ROB.a1), yy = (y + ROB.tool) - (B[1] + ROB.h1);
    const d = Math.min(ROB.L2 + ROB.L3 - 1e-3, Math.hypot(rr, yy));
    const phi = Math.atan2(rr, yy);
    const beta = Math.acos(Math.max(-1, Math.min(1, (ROB.L2 * ROB.L2 + d * d - ROB.L3 * ROB.L3) / (2 * ROB.L2 * d))));
    const t2 = phi - beta;
    const ex = ROB.L2 * Math.sin(t2), ey = ROB.L2 * Math.cos(t2);
    const t = Math.atan2(rr * (d / Math.hypot(rr, yy)) - ex, yy * (d / Math.hypot(rr, yy)) - ey);
    r.turret.rotation.set(0, q1, 0);
    r.upper.rotation.set(t2, 0, 0);
    r.fore.rotation.set(t - t2, 0, 0);
    r.wrist.rotation.set(-t, 0, 0);
    r.grip.rotation.set(0, yawTool - q1, 0);
  }
  function updateRobot(r, dt) {
    const akl = m.conveyors.find((c) => c.id === 'c_akl');
    const run = r.state === 'running';
    const cycleT = 6.0;
    if (run) r.t += dt;
    const st = r.stations;
    const n = Math.floor(r.t / cycleT), ph = (r.t % cycleT) / cycleT;
    const station = st[n % 2], slot = Math.floor(n / 2) % 6, layer = PATTERN[slot][2];
    const pick = [89.75, 0.8 + 0.3, 37.95], place = [station[0] + PATTERN[slot][0], 1.0 + layer * 0.3 + 0.3, station[1] + PATTERN[slot][1]];
    const home = [r.base[0], 2.6, r.base[2] - 1.2];
    const lerp3 = (a, b, f) => { const e = f * f * (3 - 2 * f); v3.set(a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e); return v3; };
    const up = (p, h) => [p[0], p[1] + h, p[2]];
    let held = false, yawT = 0;
    // phases: 0-.15 home→above pick, .15-.25 down, .25-.32 up (holding), .32-.62 → above place, .62-.72 down, .72-.8 up, .8-1 → home
    if (ph < 0.15) lerp3(home, up(pick, 0.6), ph / 0.15);
    else if (ph < 0.25) lerp3(up(pick, 0.6), pick, (ph - 0.15) / 0.1);
    else if (ph < 0.32) { lerp3(pick, up(pick, 0.6), (ph - 0.25) / 0.07); held = true; }
    else if (ph < 0.62) { lerp3(up(pick, 0.6), up(place, 0.5), (ph - 0.32) / 0.3); held = true; yawT = ((ph - 0.32) / 0.3) * (slot >= 4 ? Math.PI / 2 : 0); }
    else if (ph < 0.72) { lerp3(up(place, 0.5), place, (ph - 0.62) / 0.1); held = true; yawT = slot >= 4 ? Math.PI / 2 : 0; }
    else if (ph < 0.8) lerp3(place, up(place, 0.5), (ph - 0.72) / 0.08);
    else lerp3(up(place, 0.5), home, (ph - 0.8) / 0.2);
    if (!run && r.t === 0) v3.set(home[0], home[1], home[2]);
    robotIK(r, v3.x, v3.y, v3.z, yawT);
    // events (once per phase crossing)
    const phase = held ? 1 : 0;
    if (run && phase !== r.lastHeld) { emitA('a:robot', r.id, held ? 'pick' : 'place'); r.lastHeld = phase; }
    // placed cartons: all slots completed in previous cycles of each station
    const done = Math.floor(r.t / cycleT);   // cycles completed
    for (let i = 0; i < r.placed.length; i++) {
      const sIdx = i % 2, sl = Math.floor(i / 2);
      const cyc = sl * 2 + sIdx;   // cycle index that placed this one (within the 12-cycle round)
      const round = Math.floor(done / 12), inRound = done - round * 12;
      const on = (run || r.t > 0) && cyc < inRound;
      const p = r.placed[i];
      if (on) {
        const s = st[sIdx], pt = PATTERN[sl];
        p.bone.scale.setScalar(1);
        p.bone.position.set(s[0] + pt[0], 1.0 + pt[2] * 0.3, s[1] + pt[1]);
        p.bone.rotation.set(0, sl >= 4 ? Math.PI / 2 : 0, 0);
      } else p.bone.scale.setScalar(0.0001);
    }
    // held carton follows the gripper; the AKL front carton is consumed at pick
    const hc = akl?.cartons;
    if (hc && held) {
      const front = hc.reduce((a, b2) => (b2.u > (a?.u ?? -1) ? b2 : a), null);
      if (front && front.u > 37.5) front.u = -1;   // taken
    }
    r.hand.scale.setScalar(held ? 1 : 0.0001);
    r.turret.updateWorldMatrix(false, true);
    // collider: AABB around upper arm + forearm
    r.fore.getWorldPosition(v3);
    const ex = v3.x, ey = v3.y, ez = v3.z;
    r.wrist.getWorldPosition(v3);
    r.col.min[0] = Math.min(ex, v3.x) - 0.25; r.col.max[0] = Math.max(ex, v3.x) + 0.25;
    r.col.min[1] = Math.min(ey, v3.y) - 0.3; r.col.max[1] = Math.max(ey, v3.y) + 0.25;
    r.col.min[2] = Math.min(ez, v3.z) - 0.25; r.col.max[2] = Math.max(ez, v3.z) + 0.25;
    r.held = held ? 1 : -1;
  }

  // ------------------------------------------------------------------------------------------------------
  m.update = (dt) => {
    if (!skinned) return;
    if (ctx.state !== 'playing' && ctx.state !== 'menu') dt = 0;
    for (const a of m.agvs) placeAgv(a, dt);
    for (const c of m.conveyors) {
      if (c.id === L.sorter.conveyor) updateLoop(c, dt);
      else if (c.id === 'c_akl') updateAkl(c, dt);
    }
    for (const c of m.cranes) updateCrane(c, dt);
    for (const r of m.robots) updateRobot(r, dt);
  };
  m.reset = () => {
    estop = false;
    for (const a of m.agvs) { const d = L.agvs.find((x) => x.id === a.id); a.state = d.state; a.s = d.start * a.route.total; a.v = d.state === 'running' ? a.speed : 0; a.hold = 0; placeAgv(a, 0); }
    for (const c of m.conveyors) {
      c.state = L.conveyors.find((x) => x.id === c.id).state; c.s = 0;
      c.cartons?.forEach((ct, i) => { ct.mode = 'belt'; ct.u = -1; ct.slot = ct.slot ?? i; ct.burst = false; ct.forced = false; ct.z = 0; });
      c.chutes?.forEach((k) => { k.held.length = 0; k.fire = 0; });
      if (c.path) c.induct = indPoint(c);
    }
    for (const c of m.cranes) { const d = L.cranes.find((x) => x.id === c.id); c.state = d.state; c.phase = 0; c.plan = null; c.seq = 0; c.carry = false; c.loadAt = null; c.z = c.z0; c.y = 1.0; c.fx = 0; c.x = d.x; }
    for (const r of m.robots) { r.state = L.robots.find((x) => x.id === r.id).state; r.t = 0; r.lastHeld = 0; }
    m.update(0);
  };
  function indPoint(c) {
    // induction (scanner tunnel) on the west leg at z ≈ 29 → path distance
    const segs = c.path.segs;
    for (const g of segs) if (Math.abs(g.P0[0] - 74.5) < 0.01 && Math.abs(g.P1[0] - 74.5) < 0.01 && g.P0[1] < 1 && g.P1[1] < 1) {
      const f = (g.P0[2] - 29) / (g.P0[2] - g.P1[2]);
      if (f >= 0 && f <= 1) return g.s0 + f * g.len3;
    }
    return 0;
  }
  m.agv = (id) => m.agvs.find((a) => a.id === id);
  m.conveyor = (id) => m.conveyors.find((c) => c.id === id);
  m.robot = (id) => m.robots.find((r) => r.id === id);
  m.crane = (id) => m.cranes.find((c) => c.id === id);
  void MAX_BELTS; void M;
  return m;
}
