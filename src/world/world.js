// World runtime: greybox meshes (merged per zone), baked light, PVS visibility, collision, nav, raycasts, doors,
// glass, light circuits, trigger volumes. Owner: core. Public API = ctx.world (CONTRACT.md §world).
import * as THREE from 'three';
import { generateWorld, faceCorner, boxFlags, F_SHOOT, F_OCC, TAN } from './gen.js';
import { BLACK_TEXEL } from './lmpack.js';
import { BoxBVH } from './bvh.js';
import { buildNav } from './nav.js';
import { createCollision } from './collision.js';
import { createDoors } from './doors.js';
import { createProbes } from './probes.js';
import { SURF } from './layout/surfaces.js';
import { U, createStaticMaterial, createTransparentMaterial, MAX_CIRCUITS, loadMaterials } from '../render/materials.js';

export function createWorld(ctx) {
  const L = ctx.layout;
  const world = {
    id: 'world', order: 60,
    ready: false, bakeOk: false, bakeWarning: '',
    zones: L.zones, zoneVisible: null, cameraZone: -1, visibleZoneCount: 0,
  };
  let W, bvh, nav, collision, doors, probes, manifest;
  const zoneMeshes = [];   // per zone: { opaque, trans }
  const glassRec = [];     // per pane: { pane, geo, offset, alive, col }
  const circIndex = new Map(L.circuitIds.map((id, i) => [id, i]));
  const surfIndex = new Map(Object.keys(SURF).map((k, i) => [k, i]));   // aMisc.z = surface index (B: textures)
  const circ = L.circuitIds.map((id) => ({ id, level: L.circuits[id], target: L.circuits[id], speed: 0, flicker: 0 }));

  world.load = async (loader) => {
    const t0 = performance.now();
    W = generateWorld(L);
    world.gen = W;
    const done = loader.step('Welt erzeugen', 0.3);
    bvh = new BoxBVH(W.boxes, Uint8Array.from(W.boxes, boxFlags));
    collision = createCollision(bvh);
    nav = buildNav(W, bvh);
    done();
    let lmDay = null, lmArt = null, vlight = null, probeBytes = null;
    try {
      manifest = await loader.json('bake/manifest.json');
      [lmDay, lmArt, vlight, probeBytes] = await Promise.all([
        loader.bin('bake/' + manifest.lightmap.day, { inflate: true, weight: 1 }),
        loader.bin('bake/' + manifest.lightmap.art, { inflate: true, weight: 1 }),
        loader.bin('bake/' + manifest.vertexLight.file, { inflate: true, weight: 0.6 }),
        loader.bin('bake/' + manifest.probes.file, { inflate: true, weight: 1.2 }),
      ]);
      world.bakeOk = manifest.hash === W.hash && manifest.lightmap.width === W.lm.width && manifest.lightmap.height === W.lm.height;
      if (!world.bakeOk) world.bakeWarning = `Bake veraltet (${manifest.hash} ≠ ${W.hash}) – npm run bake`;
    } catch (e) {
      world.bakeWarning = `Kein Bake gefunden (${e.message}) – npm run bake`;
    }
    if (world.bakeWarning) console.warn('[world]', world.bakeWarning);
    await loadMaterials(ctx, loader, world.bakeOk ? manifest : null);   // B: surface layers + env cubes
    const done2 = loader.step('Geometrie', 0.5);
    setupLighting(lmDay, lmArt, probeBytes);
    buildMeshes(world.bakeOk ? vlight : null);
    doors = createDoors(ctx, W, collision, nav);
    world.doors = doors;
    setupPVS();
    done2();
    world.ready = true;
    world.loadMs = performance.now() - t0;
  };

  // ------------------------------------------------------------------------------------------------------
  function setupLighting(lmDay, lmArt, probeBytes) {
    const AW = W.lm.width, AH = W.lm.height;
    const mkLm = (data, name) => {
      const ok = data && data.length === AW * AH * 4;
      const t = new THREE.DataTexture(ok ? data : fallbackLm(AW, AH, name === 'lmDay'), AW, AH, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
      t.flipY = false; t.needsUpdate = true; t.name = name;
      ctx.render.trackTexture(name, AW * AH * 4);
      return t;
    };
    U.uLmDay.value = mkLm(world.bakeOk ? lmDay : null, 'lmDay');
    U.uLmArt.value = mkLm(world.bakeOk ? lmArt : null, 'lmArt');
    if (world.bakeOk && probeBytes) {
      probes = createProbes(manifest, probeBytes);
    } else {
      // flat fallback probe (1x1x1)
      probes = createProbes({ probes: { dims: [2, 2, 2], origin: [-16, -4, -16], spacing: 200, range: 16 } },
        new Uint8Array(96).map((_, i) => (i < 32 ? (i % 4 === 3 ? 8 : 128) : i < 64 ? (i % 4 === 3 ? 255 : 128) : 0)));
    }
    world.probes = probes;
    U.uProbeL0.value = probes.tex.l0; U.uProbeDirSun.value = probes.tex.dirSun; U.uProbeArt.value = probes.tex.art;
    U.uProbeOrigin.value.copy(probes.origin); U.uProbeInvSize.value.copy(probes.invSize);
    ctx.render.trackTexture('probes', probes.bytes);
    U.uSunDir.value.set(...L.sun.dir);
    U.uSunColor.value.set(...L.sun.color).multiplyScalar(L.sun.intensity);
  }
  function fallbackLm(w, h, day) {
    const a = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = 255; a[i * 4 + 3] = day ? 5 : 0; }
    return a;
  }

  // ------------------------------------------------------------------------------------------------------
  function buildMeshes(vlight) {
    const nz = W.zones.length;
    const AW = W.lm.width, AH = W.lm.height;
    // vertex-light base index per face (same order as the bake)
    const vbase = new Int32Array(W.faces.length).fill(-1);
    let nv = 0;
    W.faces.forEach((f, i) => { if (f.render === 'vl' || f.render === 'mesh') { vbase[i] = nv; nv += 4; } });
    const vlOk = vlight && vlight.length === nv * 8;
    const perZone = Array.from({ length: nz }, () => ({ op: [], tr: [] }));
    const hidden = new Set(L.hideProxyGroups ?? []);
    W.faces.forEach((f, i) => {
      if (hidden.has(W.boxes[f.box].group)) return;   // art renders these (A)
      (f.render === 'mesh' ? perZone[f.zone].tr : perZone[f.zone].op).push(i);
    });
    W.glass.forEach((g, gi) => perZone[g.zone].tr.push(-1 - gi));
    const opMat = createStaticMaterial(), trMat = createTransparentMaterial();
    world.materials = { opaque: opMat, transparent: trMat };
    const c = [0, 0, 0];
    let bytes = 0;
    for (let z = 0; z < nz; z++) {
      const rec = { opaque: null, trans: null, tris: 0, extra: [] };
      // ---- opaque
      const fl = perZone[z].op;
      if (fl.length) {
        const n = fl.length * 4;
        const pos = new Float32Array(n * 3), nrm = new Int8Array(n * 3), col = new Uint8Array(n * 4), lmuv = new Uint16Array(n * 2);
        const vd = new Uint8Array(n * 4), va = new Uint8Array(n * 4), misc = new Uint8Array(n * 4);
        const idx = n > 65535 ? new Uint32Array(fl.length * 6) : new Uint16Array(fl.length * 6);
        fl.forEach((fi, q) => {
          const f = W.faces[fi], b = W.boxes[f.box], v0 = q * 4;
          const ci = circIndex.get(f.circuit) ?? 0;
          for (let k = 0; k < 4; k++) {
            const v = v0 + k;
            faceCorner(f, k, c); pos.set(c, v * 3);
            nrm[v * 3 + f.axis] = f.pos ? 127 : -127;
            col[v * 4] = Math.round(b.color[0] * 255); col[v * 4 + 1] = Math.round(b.color[1] * 255); col[v * 4 + 2] = Math.round(b.color[2] * 255); col[v * 4 + 3] = 255;
            if (f.lm) {
              const [rx, ry, rw, rh] = f.lmRect;
              lmuv[v * 2] = Math.round((rx + (k === 1 || k === 2 ? rw : 0)) / AW * 65535);
              lmuv[v * 2 + 1] = Math.round((ry + (k >= 2 ? rh : 0)) / AH * 65535);
            } else {
              lmuv[v * 2] = Math.round(BLACK_TEXEL[0] / AW * 65535); lmuv[v * 2 + 1] = Math.round(BLACK_TEXEL[1] / AH * 65535);
              if (vlOk) {
                const s = (vbase[fi] + k) * 4;
                vd.set(vlight.subarray(s, s + 4), v * 4); va.set(vlight.subarray(nv * 4 + s, nv * 4 + s + 4), v * 4);
              } else { vd[v * 4] = vd[v * 4 + 1] = vd[v * 4 + 2] = 255; vd[v * 4 + 3] = 4; }
            }
            misc[v * 4] = ci; misc[v * 4 + 1] = Math.min(255, Math.round((b.emit ?? 0) * 16)); misc[v * 4 + 2] = surfIndex.get(b.surf) ?? 0;
          }
          // winding: e_u × e_v = -x, -y, +z for axes 0,1,2
          const base = f.axis === 2 ? 1 : -1, flip = base * (f.pos ? 1 : -1) < 0;
          const o = q * 6;
          if (!flip) { idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2; idx[o + 3] = v0; idx[o + 4] = v0 + 2; idx[o + 5] = v0 + 3; }
          else { idx[o] = v0; idx[o + 1] = v0 + 2; idx[o + 2] = v0 + 1; idx[o + 3] = v0; idx[o + 4] = v0 + 3; idx[o + 5] = v0 + 2; }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
        geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4, true));
        geo.setAttribute('aLmUv', new THREE.BufferAttribute(lmuv, 2, true));
        geo.setAttribute('aVlDay', new THREE.BufferAttribute(vd, 4, true));
        geo.setAttribute('aVlArt', new THREE.BufferAttribute(va, 4, true));
        geo.setAttribute('aMisc', new THREE.BufferAttribute(misc, 4, false));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        rec.opaque = finishMesh(geo, opMat, `zone:${W.zones[z].id}`);
        rec.tris += fl.length * 2;
        bytes += pos.byteLength + nrm.byteLength + col.byteLength + lmuv.byteLength + vd.byteLength * 3 + idx.byteLength;
      }
      // ---- transparent (see-through mesh faces + glass panes)
      const tl = perZone[z].tr;
      if (tl.length) {
        const n = tl.length * 4;
        const pos = new Float32Array(n * 3), nrm = new Int8Array(n * 3), col = new Uint8Array(n * 4);
        const idx = new Uint16Array(tl.length * 6);
        const geo = new THREE.BufferGeometry();
        tl.forEach((fi, q) => {
          const v0 = q * 4;
          let f, rgba;
          if (fi >= 0) { f = W.faces[fi]; rgba = [20, 20, 22, 110]; }
          else {
            const g = W.glass[-1 - fi], a = g.axis, [ua, va] = TAN[a];
            f = { axis: a, plane: (g.min[a] + g.max[a]) / 2, ua, va, u0: g.min[ua], u1: g.max[ua], v0: g.min[va], v1: g.max[va], pos: true };
            rgba = g.skylight ? [150, 160, 165, 40] : [140, 158, 160, 22];
            glassRec[-1 - fi] = { pane: g, geo, offset: v0, alive: true, zone: z, face: f };
          }
          for (let k = 0; k < 4; k++) {
            faceCorner(f, k, c); pos.set(c, (v0 + k) * 3);
            nrm[(v0 + k) * 3 + f.axis] = f.pos ? 127 : -127;
            col.set(rgba, (v0 + k) * 4);
          }
          const o = q * 6;
          idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2; idx[o + 3] = v0; idx[o + 4] = v0 + 2; idx[o + 5] = v0 + 3;
        });
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
        geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4, true));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        rec.trans = finishMesh(geo, trMat, `zone:${W.zones[z].id}:trans`);
        rec.trans.renderOrder = 10;
        rec.tris += tl.length * 2;
      }
      zoneMeshes.push(rec);
    }
    world.geometryMB = bytes / 1048576;
    // glass colliders (intact panes block movement; breakable ones can be shot out)
    glassRec.forEach((g) => {
      const p = g.pane;
      g.col = collision.addDynamic(p.min, p.max, { kind: 'glass', id: p.id, surface: 'glass', shoot: true });
    });
  }
  function finishMesh(geo, mat, name) {
    geo.computeBoundingBox();
    const ctr = new THREE.Vector3(); geo.boundingBox.getCenter(ctr);
    geo.translate(-ctr.x, -ctr.y, -ctr.z);   // so three can sort zone meshes front to back
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(ctr); m.name = name; m.matrixAutoUpdate = false; m.updateMatrix();
    ctx.render.scene.add(m);
    return m;
  }

  // ------------------------------------------------------------------------------------------------------
  // PVS (baked, zone → zones). Falls back to "everything visible" without a bake.
  let pvs = null;
  function setupPVS() {
    const nz = W.zones.length;
    world.zoneVisible = new Uint8Array(nz);
    pvs = W.zones.map(() => new Uint8Array(nz).fill(1));
    if (manifest?.pvs && world.bakeOk) {
      W.zones.forEach((z, i) => {
        const row = pvs[i]; row.fill(0); row[i] = 1;
        for (const id of manifest.pvs[z.id] ?? []) { const j = W.zoneIndex.get(id); if (j !== undefined) row[j] = 1; }
      });
    }
  }
  const OFFS = [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]];
  function updateVisibility() {
    const p = ctx.render.camera.position, vis = world.zoneVisible, zl = W.zoneLookup;
    vis.fill(0);
    let cz = zl.at(p.x, p.y, p.z);
    if (cz < 0) cz = zl.nearest(p.x, p.y, p.z);
    world.cameraZone = cz;
    if (ctx.debug.allZones) vis.fill(1);
    else for (let o = 0; o < OFFS.length; o++) {
      const z = zl.at(p.x + OFFS[o][0], p.y, p.z + OFFS[o][1]);
      const row = pvs[z >= 0 ? z : cz];
      for (let i = 0; i < row.length; i++) vis[i] |= row[i];
    }
    let n = 0;
    for (let z = 0; z < zoneMeshes.length; z++) {
      const r = zoneMeshes[z], v = vis[z] === 1;
      if (r.opaque) r.opaque.visible = v;
      if (r.trans) r.trans.visible = v;
      for (let k = 0; k < r.extra.length; k++) r.extra[k].visible = v;
      n += v ? 1 : 0;
    }
    world.visibleZoneCount = n;
  }

  // ------------------------------------------------------------------------------------------------------
  // light circuits
  world.lights = {
    ids: L.circuitIds,
    level: (id) => circ[circIndex.get(id)]?.level ?? 0,
    /** set an artificial light circuit (lightmap ART layer, emissive lamps, probes) to level over fade seconds */
    setCircuit(id, level, fade = 0, flicker = 0) {
      const c = circ[circIndex.get(id)]; if (!c) return false;
      c.target = level; c.speed = fade > 0 ? Math.abs(level - c.level) / fade : 0; c.flicker = flicker;
      if (!fade) c.level = level;
      ctx.events.emit('lights:circuit', { id, level, fade });
      return true;
    },
  };
  function updateCircuits(dt) {
    for (let i = 0; i < circ.length && i < MAX_CIRCUITS; i++) {
      const c = circ[i];
      if (c.level !== c.target) {
        const s = c.speed * dt;
        c.level = c.level < c.target ? Math.min(c.target, c.level + s) : Math.max(c.target, c.level - s);
      }
      let v = c.level;
      if (c.flicker > 0 && c.level !== c.target) v *= Math.random() < 0.35 ? 0.15 : 1;
      U.uCirc.value[i] = v;
    }
    const zc = W.zones[world.cameraZone]?.circuit;
    U.uProbeArtLevel.value = U.uCirc.value[circIndex.get(zc) ?? 0] ?? 1;
  }

  // ------------------------------------------------------------------------------------------------------
  // triggers (player feet point)
  const trig = [...L.moments, L.extraction].map((m) => ({ id: m.id, box: m.box, once: m.once, inside: false, fired: false, def: m }));
  const tEvt = { id: '', def: null };
  function updateTriggers() {
    const p = ctx.player?.pos;
    if (!p || ctx.state !== 'playing') return;
    for (const t of trig) {
      const b = t.box;
      const inside = p.x >= b[0] && p.x <= b[3] && p.y >= b[1] && p.y <= b[4] && p.z >= b[2] && p.z <= b[5];
      if (inside !== t.inside) {
        t.inside = inside;
        tEvt.id = t.id; tEvt.def = t.def;
        if (inside) { const first = !t.fired; t.fired = true; tEvt.first = first; ctx.events.emit('trigger:enter', tEvt); }
        else ctx.events.emit('trigger:exit', tEvt);
      }
    }
  }
  world.triggers = { list: trig, reset() { for (const t of trig) { t.inside = false; t.fired = false; } } };

  // ------------------------------------------------------------------------------------------------------
  // glass
  world.glass = {
    list: glassRec,
    /** shatter a pane (collapses its quad, removes its collider). Emits 'glass:break' { id, point, pane } */
    break(id, point) {
      const g = glassRec.find((r) => r.pane.id === id);
      if (!g || !g.alive || !g.pane.breakable) return false;
      g.alive = false; g.col.enabled = false;
      const pos = g.geo.attributes.position;
      for (let k = 0; k < 4; k++) pos.setXYZ(g.offset + k, 0, 0, 0);
      pos.addUpdateRange(g.offset * 3, 12); pos.needsUpdate = true;
      ctx.events.emit('glass:break', { id, point, pane: g.pane });
      return true;
    },
    reset() {
      const c = [0, 0, 0];
      for (const g of glassRec) {
        if (g.alive) continue;
        g.alive = true; g.col.enabled = true;
        const pos = g.geo.attributes.position, mesh = zoneMeshes[g.zone].trans;
        for (let k = 0; k < 4; k++) { faceCorner(g.face, k, c); pos.setXYZ(g.offset + k, c[0] - mesh.position.x, c[1] - mesh.position.y, c[2] - mesh.position.z); }
        pos.needsUpdate = true;
      }
    },
  };

  // ------------------------------------------------------------------------------------------------------
  // raycasts
  const hitTmp = { t: 0, side: 0 };
  const NORM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  /**
   * Bullet / probe ray against static geometry (F_SHOOT), closed doors, intact glass and dynamic colliders.
   * out: { hit, t, point{x,y,z}, normal{x,y,z}, surface, kind:'static'|'door'|'glass'|'dynamic', id, box, zone, owner }
   * opts.mask (default F_SHOOT), opts.ignoreGlass (sight rays pass glass)
   */
  world.worldHit = (o, d, maxDist, out, opts) => {
    const mask = opts?.mask ?? F_SHOOT;
    out.hit = false; out.t = maxDist; out.kind = ''; out.id = ''; out.box = -1; out.owner = null; out.surface = '';
    const b = bvh.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxDist, mask, hitTmp);
    if (b >= 0) {
      out.hit = true; out.t = hitTmp.t; out.kind = 'static'; out.box = b;
      const n = NORM[hitTmp.side]; out.normal.x = n[0]; out.normal.y = n[1]; out.normal.z = n[2];
      const bx = W.boxes[b]; out.surface = SURF[bx.surf]?.impact ?? 'concrete'; out.zone = bx.zone; out.id = bx.tag ?? '';
    }
    const dyn = collision.dynamic;
    for (let i = 0; i < dyn.length; i++) {
      const c = dyn[i];
      if (!c.enabled || !c.owner || c.owner.shoot === false) continue;
      if (opts?.ignoreGlass && c.owner.kind === 'glass') continue;
      const t = rayAabb(o, d, c.min, c.max, out.t);
      if (t >= 0 && t < out.t) {
        out.hit = true; out.t = t; out.kind = c.owner.kind === 'door' || c.owner.kind === 'glass' ? c.owner.kind : 'dynamic';
        out.id = c.owner.id; out.owner = c.owner; out.surface = c.owner.surface ?? 'metal'; out.box = -1;
        setAabbNormal(o, d, t, c.min, c.max, out.normal);
      }
    }
    out.point.x = o.x + d.x * out.t; out.point.y = o.y + d.y * out.t; out.point.z = o.z + d.z * out.t;
    return out.hit;
  };
  /** true if nothing opaque (static F_OCC geometry, closed doors) lies between a and b. Glass and fences don't block. */
  world.lineOfSight = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (bvh.occluded(a.x, a.y, a.z, dx, dy, dz, 1, F_OCC)) return false;
    const dyn = collision.dynamic;
    for (let i = 0; i < dyn.length; i++) {
      const c = dyn[i];
      if (!c.enabled || !c.owner || c.owner.kind === 'glass' || c.owner.sight === false) continue;
      _d.x = dx; _d.y = dy; _d.z = dz;
      const t = rayAabb(a, _d, c.min, c.max, 1);
      if (t >= 0 && t < 1) return false;
    }
    return true;
  };
  const _d = { x: 0, y: 0, z: 0 };

  /** attach a static object (e.g. merged art meshes of a zone) to a zone: shown/hidden with the zone's PVS state */
  world.addZoneObject = (obj, zoneIndex) => {
    const z = typeof zoneIndex === 'string' ? W.zoneIndex.get(zoneIndex) : zoneIndex;
    zoneMeshes[z].extra.push(obj);
    if (!obj.parent) ctx.render.scene.add(obj);
    return obj;
  };
  world.zoneAt = (x, y, z) => W.zoneLookup.at(x, y, z);
  world.zoneId = (i) => W.zones[i]?.id ?? null;
  world.isZoneVisible = (i) => i >= 0 && world.zoneVisible[i] === 1;
  /** convenience: is a world point in a currently visible zone (for culling / anim throttling of dynamic objects) */
  world.isPointVisible = (x, y, z) => { const i = W.zoneLookup.at(x, y + 0.5, z); return i < 0 || world.zoneVisible[i] === 1; };
  world.groundHeight = (x, z, refY, r = 0) => collision.groundHeight(x, z, refY, r);
  Object.defineProperties(world, {
    nav: { get: () => nav }, collision: { get: () => collision }, bvh: { get: () => bvh },
    zoneMeshes: { get: () => zoneMeshes },
  });

  world.update = (dt) => {
    updateVisibility();
    updateCircuits(dt);
    doors.update(dt, world.zoneVisible);
    updateTriggers();
  };
  world.reset = () => {
    doors.reset(); world.glass.reset(); world.triggers.reset();
    circ.forEach((c) => { c.level = c.target = L.circuits[c.id]; c.flicker = 0; });
  };
  return world;
}

function rayAabb(o, d, mn, mx, tmax) {
  let t0 = 0, t1 = tmax;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z, da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    if (Math.abs(da) < 1e-12) { if (oa < mn[a] || oa > mx[a]) return -1; continue; }
    let n = (mn[a] - oa) / da, f = (mx[a] - oa) / da;
    if (n > f) { const s = n; n = f; f = s; }
    if (n > t0) t0 = n; if (f < t1) t1 = f;
    if (t0 > t1) return -1;
  }
  return t0;
}
function setAabbNormal(o, d, t, mn, mx, n) {
  const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
  let k = 0, best = Math.abs(px - mn[0]), v;
  if ((v = Math.abs(px - mx[0])) < best) { best = v; k = 1; }
  if ((v = Math.abs(py - mn[1])) < best) { best = v; k = 2; }
  if ((v = Math.abs(py - mx[1])) < best) { best = v; k = 3; }
  if ((v = Math.abs(pz - mn[2])) < best) { best = v; k = 4; }
  if ((v = Math.abs(pz - mx[2])) < best) { best = v; k = 5; }
  n.x = k === 0 ? -1 : k === 1 ? 1 : 0; n.y = k === 2 ? -1 : k === 3 ? 1 : 0; n.z = k === 4 ? -1 : k === 5 ? 1 : 0;
}
