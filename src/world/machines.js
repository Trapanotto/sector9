// STUB (workstream A): moving machines as greybox proxies + the control API used by the director.
//   ctx.machines.agv(id).dispatch() / .stop()       AGVs/AMRs follow their routes (layout/machines.js)
//   ctx.machines.conveyor(id).start() / .stop()     state + event (belt/roller animation is A's job)
//   ctx.machines.robot(id).start() / .stop()        palletising robot swings
//   ctx.machines.crane(id)                          stacker crane runs along its rail
// Events: 'machine:state' { id, kind, state }. AGVs are dynamic colliders (block player and bullets).
import * as THREE from 'three';
import { createDynamicMaterial } from '../render/materials.js';

export function createMachines(ctx) {
  const L = ctx.layout;
  const m = { id: 'machines', order: ctx.ORDER.machines, agvs: [], conveyors: [], robots: [], cranes: [] };
  const evt = { id: '', kind: '', state: '' };
  const emit = (id, kind, state) => { evt.id = id; evt.kind = kind; evt.state = state; ctx.events.emit('machine:state', evt); };

  function routeLen(pts, loop) {
    const segs = []; let total = 0;
    const n = loop ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, l, s: total }); total += l; }
    return { segs, total };
  }

  m.init = () => {
    const agvMat = createDynamicMaterial({ color: [0.75, 0.55, 0.1] });
    const lightMat = createDynamicMaterial({ color: [0.2, 0.2, 0.2], emissive: [2.5, 1.2, 0.1] });
    for (const a of L.agvs) {
      const r = L.agvRoutes.find((x) => x.id === a.route);
      const route = routeLen(r.points, r.loop);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 1.4), agvMat); body.position.y = 0.225;
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), lightMat); beacon.position.set(0, 0.52, -0.5);
      g.add(body, beacon);
      if (a.kind === 'tugger') { const load = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 1.0), createDynamicMaterial({ color: [0.55, 0.42, 0.27] })); load.position.y = 0.9; g.add(load); }
      ctx.render.scene.add(g);
      const col = ctx.world.collision.addDynamic([0, 0, 0], [0, 0, 0], { kind: 'agv', id: a.id, surface: 'metal', shoot: true });
      const rec = { ...a, group: g, beacon, route, s: a.start * route.total, state: a.state, col, speed: a.speed };
      rec.dispatch = () => { rec.state = 'running'; emit(a.id, 'agv', 'running'); };
      rec.stop = () => { rec.state = 'parked'; emit(a.id, 'agv', 'parked'); };
      m.agvs.push(rec);
      place(rec, 0);
    }
    for (const c of L.conveyors) {
      const rec = { ...c, state: c.state };
      rec.start = () => { rec.state = 'running'; emit(c.id, 'conveyor', 'running'); };
      rec.stop = () => { rec.state = 'stopped'; emit(c.id, 'conveyor', 'stopped'); };
      m.conveyors.push(rec);
    }
    for (const r of L.robots) {
      const arm = new THREE.Group();
      const mat = createDynamicMaterial({ color: [0.85, 0.45, 0.05] });
      const a1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.4, 0.35), mat); a1.position.y = 0.7;
      const a2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, r.reach), mat); a2.position.set(0, 1.4, -r.reach / 2);
      arm.add(a1, a2); arm.position.set(...r.base);
      ctx.render.scene.add(arm);
      const rec = { ...r, arm, state: r.state, t: 0 };
      rec.start = () => { rec.state = 'running'; emit(r.id, 'robot', 'running'); };
      rec.stop = () => { rec.state = 'idle'; emit(r.id, 'robot', 'idle'); };
      m.robots.push(rec);
    }
    for (const c of L.cranes) {
      const mat = createDynamicMaterial({ color: [0.75, 0.75, 0.72] });
      const g = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.5, c.mastH, 0.7), mat); mast.position.y = c.mastH / 2;
      const car = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.2), mat); car.position.y = 3;
      g.add(mast, car); g.position.set(c.x, 0, c.z0);
      ctx.render.scene.add(g);
      m.cranes.push({ ...c, group: g, car, t: 0, state: c.state });
    }
  };

  function place(a, dt) {
    const R = a.route;
    if (a.state === 'running') a.s = (a.s + a.speed * dt) % R.total;
    let seg = R.segs[0];
    for (let i = 0; i < R.segs.length; i++) { const s = R.segs[i]; if (a.s >= s.s && a.s <= s.s + s.l) seg = s; }
    const f = (a.s - seg.s) / seg.l;
    const x = seg.a[0] + (seg.b[0] - seg.a[0]) * f, z = seg.a[1] + (seg.b[1] - seg.a[1]) * f;
    const yaw = Math.atan2(-(seg.b[0] - seg.a[0]), -(seg.b[1] - seg.a[1]));
    a.group.position.set(x, 0, z); a.group.rotation.y = yaw;
    const alongX = Math.abs(seg.b[0] - seg.a[0]) > Math.abs(seg.b[1] - seg.a[1]);
    const hx = alongX ? 0.7 : 0.45, hz = alongX ? 0.45 : 0.7;
    a.col.min[0] = x - hx; a.col.min[1] = 0; a.col.min[2] = z - hz;
    a.col.max[0] = x + hx; a.col.max[1] = a.kind === 'tugger' ? 1.35 : 0.5; a.col.max[2] = z + hz;
    a.group.visible = ctx.world.isPointVisible(x, 0, z);
    a.beacon.visible = a.state === 'running' && (ctx.time.now * 2 % 1) < 0.5;
  }

  m.update = (dt) => {
    if (ctx.state !== 'playing' && ctx.state !== 'menu') dt = 0;
    for (const a of m.agvs) place(a, dt);
    for (const r of m.robots) {
      if (r.state === 'running') r.t += dt;
      r.arm.rotation.y = Math.sin(r.t * 0.9) * 1.6;
      r.arm.visible = ctx.world.isPointVisible(r.base[0], 0, r.base[2]);
    }
    for (const c of m.cranes) {
      if (c.state === 'running') c.t += dt;
      const u = 0.5 - 0.5 * Math.cos(c.t * c.speed / (c.z1 - c.z0) * Math.PI);
      c.group.position.z = c.z0 + (c.z1 - c.z0) * u;
      c.car.position.y = 1.5 + 4.5 * (0.5 - 0.5 * Math.cos(c.t * 0.4));
      c.group.visible = ctx.world.isPointVisible(c.x, 2, c.group.position.z);
    }
  };
  m.reset = () => {
    for (const a of m.agvs) { const d = L.agvs.find((x) => x.id === a.id); a.state = d.state; a.s = d.start * a.route.total; place(a, 0); }
    for (const c of m.conveyors) c.state = L.conveyors.find((x) => x.id === c.id).state;
    for (const r of m.robots) { r.state = 'idle'; r.t = 0; }
  };
  m.agv = (id) => m.agvs.find((a) => a.id === id);
  m.conveyor = (id) => m.conveyors.find((c) => c.id === id);
  m.robot = (id) => m.robots.find((r) => r.id === id);
  m.crane = (id) => m.cranes.find((c) => c.id === id);
  return m;
}
