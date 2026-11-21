// Workstream A tests (world art + machines): models exist for every prop type, stay inside their proxy footprint,
// respect per-instance triangle budgets; static art fits the PVS budgets together with the remaining greybox;
// machine mesh within its budget; conveyor paths continuous; atlas tiles fit.
import { buildStaticArt } from '../src/world/art/build.js';
import { MODELS } from '../src/world/art/models.js';
import { Builder, M } from '../src/world/art/kit.js';
import { TILES, ATLAS_W, ATLAS_H } from '../src/world/art/tiles.js';
import { conveyorPath, pathPoint } from '../src/world/art/conveyors.js';
import * as MCH from '../src/world/art/machinery.js';
import { BUDGETS } from '../src/core/budgets.js';
import { readFileSync, existsSync } from 'node:fs';

// per-instance LOD0 triangle caps (default 1500)
const TRI_CAP = { forklift: 2200, trailer: 1500, truck: 1500, shelf: 1200, packing_table: 1200, cash_table: 1500, lab_table: 1200, car: 1200 };
// proxy footprint tolerance (m); loose clutter on top of tables etc. may stand a little above the proxy
const TOL = 0.06, TOL_TOP = { table: 0.16, desk: 0.12, pallet_cartons: 0.02, packing_table: 0.06, control_desk: 0.05, tv: 0.02, gas_bottles: 0.02 };

export default async ({ W, LAYOUT, ok, warn }) => {
  const L = LAYOUT;
  // ---- every prop type has a model and is hidden from the greybox
  for (const t of Object.keys(L.propTypes)) {
    ok(typeof MODELS[t] === 'function', `art: no model for prop type ${t}`);
    if (!t.startsWith('lamp_')) ok(L.hideProxyGroups.includes(t), `art: prop type ${t} has a model but its proxy is still drawn`);
  }
  // ---- per type: local-frame geometry inside the proxy union, triangle cap
  for (const [t, T] of Object.entries(L.propTypes)) {
    if (t.startsWith('lamp_')) continue;
    const ids = [...new Set(L.props.filter((p) => p.type === t).map((p) => p.id ?? ''))];
    const zones = [...new Set(L.props.filter((p) => p.type === t).map((p) => L.zones[W.zoneLookup.nearest(p.p[0], p.p[1] + 0.5, p.p[2])]?.id))];
    const u = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const bx of T.boxes) for (let k = 0; k < 3; k++) { u[k] = Math.min(u[k], bx[k]); u[k + 3] = Math.max(u[k + 3], bx[k + 3]); }
    for (const id of ids.length ? ids : ['']) for (const zone of zones.length ? zones : ['']) for (const near of [true, false]) {
      const b = new Builder(); b.target(['x']); b.groundY = 0;
      let seed = 1;
      const X = { b, id, zone, lodNear: near, rnd: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), lod: () => {} };
      MODELS[t](X);
      const P = b.pos.view();
      let bad = 0; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = P[i + k];
        if (!Number.isFinite(v)) bad++;
        mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v);
      }
      ok(bad === 0, `art: ${t} has non-finite vertices`);
      const top = TOL_TOP[t] ?? 0;
      const inside = mn[0] >= u[0] - TOL && mn[1] >= u[1] - TOL && mn[2] >= u[2] - TOL && mx[0] <= u[3] + TOL && mx[1] <= u[4] + TOL + top && mx[2] <= u[5] + TOL;
      ok(inside, `art: ${t}${id ? `(${id})` : ''} ${near ? 'LOD0' : 'LOD1'} bbox ${mn.map((v) => v.toFixed(2))}..${mx.map((v) => v.toFixed(2))} outside proxy ${u.map((v) => v.toFixed(2))}`);
      // proxy covers the art reasonably (art fills ≥ 60 % of the proxy extent on each axis)
      for (let k = 0; k < 3; k++) warn((mx[k] - mn[k]) >= 0.6 * (u[k + 3] - u[k]) - 0.05, `art: ${t} fills only ${((mx[k] - mn[k]) / (u[k + 3] - u[k]) * 100).toFixed(0)} % of its proxy on axis ${'xyz'[k]}`);
      if (near) ok(b.tris <= (TRI_CAP[t] ?? 1500), `art: ${t} LOD0 ${b.tris} tris > cap ${TRI_CAP[t] ?? 1500}`);
      else ok(b.tris <= (TRI_CAP[t] ?? 1500), `art: ${t} LOD1 ${b.tris} tris`);
    }
  }

  // ---- full static art build: chunk budgets per PVS row (art LOD0 everywhere = worst case, no frustum culling)
  const t0 = performance.now();
  const res = buildStaticArt(L, (x, y, z) => W.zoneLookup.nearest(x, y, z), L.zones.map((z) => z.id));
  const ms = performance.now() - t0;
  ok(ms < 2500, `art: static build took ${ms.toFixed(0)} ms`);
  const nz = L.zones.length, art0 = new Float64Array(nz), art1 = new Float64Array(nz);
  for (const c of res.chunks) { art0[c.zone] += (res.b.targets.get(c.lists[0])?.n ?? 0) / 3; art1[c.zone] += (res.b.targets.get(c.lists[1])?.n ?? 0) / 3; }
  const hidden = new Set(L.hideProxyGroups);
  const grey = new Float64Array(nz);
  for (const f of W.faces) if (!hidden.has(W.boxes[f.box].group)) grey[f.zone] += 2;
  for (const g of W.glass) grey[g.zone] += 4;
  const manPath = 'public/bake/manifest.json';
  if (existsSync(manPath)) {
    const man = JSON.parse(readFileSync(manPath, 'utf8'));
    let worst = { tris: 0, zone: '' }, worstLod = { tris: 0, zone: '' };
    for (const [zid, vis] of Object.entries(man.pvs)) {
      let all0 = 0, mixed = 0;
      for (const v of vis) {
        const i = W.zoneIndex.get(v); if (i === undefined) continue;
        all0 += grey[i] + art0[i];
        mixed += grey[i] + (v === zid ? art0[i] : art1[i]);   // own zone near, the rest far (typical)
      }
      if (all0 > worst.tris) worst = { tris: all0, zone: zid };
      if (mixed > worstLod.tris) worstLod = { tris: mixed, zone: zid };
      ok(mixed <= BUDGETS.static.triangles, `art: PVS of ${zid}: ${mixed} static triangles (greybox + art, own zone LOD0) > ${BUDGETS.static.triangles}`);
    }
    console.log(`  art: ${res.b.vcount} vertices, ${res.b.tris} triangles, ${res.chunks.length} chunks, built in ${ms.toFixed(0)} ms`);
    console.log(`  worst PVS (greybox + art all LOD0, before frustum): ${worst.zone} ${Math.round(worst.tris)} tris; own-zone LOD0 rest LOD1: ${worstLod.zone} ${Math.round(worstLod.tris)} tris`);
  }
  // static art = 1 draw call; greybox per zone: opaque + transparent (unchanged)

  // ---- machines mesh budget (A dynamic)
  {
    const b = new Builder({ skin: true }); b.target(['m']);
    for (const a of L.agvs) { MCH.agvBody(b, a.kind); MCH.agvBeacon(b); }
    for (const c of L.cranes) { MCH.craneMast(b, c.mastH); MCH.craneCarriage(b); MCH.craneFork(b); MCH.craneLoad(b); }
    for (let i = 0; i < L.robots.length; i++) { MCH.robotTurret(b); MCH.robotUpper(b, 1.35); MCH.robotFore(b, 1.45); MCH.robotWrist(b); MCH.robotGripper(b, 0.42); }
    for (let i = 0; i < 18 + 3 + 13; i++) MCH.cartonPart(b);
    for (let i = 0; i < L.sorter.chutes.length; i++) MCH.paddlePart(b);
    ok(b.tris <= BUDGETS.A.triangles - 3000, `art: machines mesh ${b.tris} tris (budget ${BUDGETS.A.triangles} incl. doors)`);
    console.log(`  machines: ${b.tris} triangles in one skinned draw`);
  }
  // ---- conveyor paths: continuous, closed loops close
  for (const c of L.conveyors) {
    const p = conveyorPath(c), a = [0, 0, 0, 0], q = [0, 0, 0, 0];
    let maxJump = 0;
    for (let s = 0; s < p.total - (c.closed ? 0 : 0.06); s += 0.05) { pathPoint(p, s, a); pathPoint(p, s + 0.05, q); maxJump = Math.max(maxJump, Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2])); }
    ok(maxJump < 0.2, `art: conveyor ${c.id} path jumps ${maxJump.toFixed(2)} m`);
  }
  // ---- atlas
  ok(ATLAS_H <= ATLAS_W && Object.values(TILES).every((t) => t.x + t.w <= ATLAS_W && t.y + t.h <= ATLAS_H), 'art: atlas tiles overflow');
  void M;
};
