// Workstream C tests (Node): ammo logic, free-aim maths, sight alignment on the exported arms rig, penetration
// reports (authoring + exported-GLB check, must match the shipped GLB), and a headless controller regression that
// walks the whole dev tour plus random nav legs with the REAL mover on the core collision API (stairs, mezzanine,
// catwalk, ramps, prop corners).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCollision } from '../src/world/collision.js';
import { F_SOLID } from '../src/world/gen.js';
import { MOVE, createBody, moveBody } from '../src/player/mover.js';
import { createAmmo, pull, canReload, reloadKind, swapMag, releaseSlide, inGun, reserve } from '../src/player/ammo.js';
import { freeAimStep, shotDirView, ZERO_M, FREE_AIM_DEG } from '../src/player/aim.js';
import { VM_ZOOM } from '../src/player/viewmodel.js';
import { createDevtools } from '../src/core/devtools.js';

export default async ({ W, bvh, nav, ok, warn }) => {
  const t0 = performance.now();
  // ------------------------------------------------------------------ ammo
  {
    const a = createAmmo([15, 15]);
    ok(inGun(a) === 16 && reserve(a) === 30, 'ammo: 15+1 loaded, 2 spare mags');
    ok(!canReload(a), 'ammo: no reload with a full gun');
    for (let i = 0; i < 10; i++) pull(a);
    ok(inGun(a) === 6 && a.chamber === 1, 'ammo: 10 shots leave 5+1');
    ok(canReload(a) && reloadKind(a) === 'tactical', 'ammo: tactical reload with a round chambered');
    swapMag(a);
    ok(inGun(a) === 16 && a.spares.includes(5) && reserve(a) === 20, 'ammo: partial magazine (5) retained in the pouch');
    let r; for (let i = 0; i < 16; i++) r = pull(a);
    ok(r === 'fired' && a.slideLocked && inGun(a) === 0, 'ammo: slide locks back on the last round');
    ok(pull(a) === 'locked', 'ammo: trigger on a locked slide does nothing');
    ok(reloadKind(a) === 'empty', 'ammo: empty reload when the slide is locked');
    swapMag(a); ok(a.dropped === 1 && a.mag === 15 && a.chamber === 0, 'ammo: empty magazine dropped, new one seated');
    releaseSlide(a); ok(!a.slideLocked && inGun(a) === 15, 'ammo: slide release chambers a round (14+1)');
    swapMag(a); ok(a.mag === 5, 'ammo: next reload takes the retained partial magazine');
  }
  // ------------------------------------------------------------------ free aim
  {
    const st = { yaw: 0, pitch: 0 }, out = { yaw: 0, pitch: 0 }, R = FREE_AIM_DEG.standard * Math.PI / 180;
    freeAimStep(st, R * 0.4, 0, R, 1 / 60, out);
    ok(Math.abs(out.yaw) < 1e-9 && Math.abs(st.yaw - R * 0.4) < 1e-9, 'free aim: small moves only move the gun');
    let cam = 0; for (let i = 0; i < 60; i++) { freeAimStep(st, R * 0.2, 0, R, 1 / 60, out); cam += out.yaw; }
    ok(st.yaw <= R + 1e-9 && Math.abs(cam + st.yaw - R * 0.4 - 60 * R * 0.2) < 1e-6, 'free aim: beyond the zone the camera turns, nothing is lost');
    const s2 = { yaw: 0.01, pitch: 0 }; freeAimStep(s2, 0.02, 0, 0, 1 / 60, out);
    ok(s2.yaw === 0 && Math.abs(out.yaw - 0.03) < 1e-12, 'free aim "aus": camera follows 1:1');
  }
  // ------------------------------------------------------------------ sight alignment (exported rig, fp_aim)
  const glb = 'public/assets/arms/fp_arms_pistol.glb';
  if (ok(existsSync(glb), 'arms GLB missing')) {
    let THREE, loadGLB;
    try { ({ THREE, loadGLB } = await import('./chars/threeio.mjs')); } catch (e) { warn(false, `sight test skipped (three loader: ${e.message})`); }
    if (loadGLB) {
      const g = await loadGLB(glb);
      const mixer = new THREE.AnimationMixer(g.scene);
      const tanW = Math.tan((80 * Math.PI) / 360), tanV = tanW / VM_ZOOM; // world vfov 80 (112° h at 16:9)
      const ndc = (v, tan) => [v.x / (-v.z * tan), v.y / (-v.z * tan)];
      const get = (n) => g.scene.getObjectByName(n);
      for (const [clip, maxCentreDeg] of [['fp_aim', 0.15], ['fp_idle', 12]]) {
        mixer.stopAllAction(); mixer.clipAction(g.animations.find((c) => c.name === clip)).reset().play(); mixer.setTime(0);
        g.scene.updateMatrixWorld(true);
        const rs = get('pistol_sight_rear').getWorldPosition(new THREE.Vector3());
        const fs = get('pistol_sight_front').getWorldPosition(new THREE.Vector3());
        const q = get('pistol').getWorldQuaternion(new THREE.Quaternion());
        const bore = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        const out = shotDirView(rs, bore, VM_ZOOM, new THREE.Vector3());
        // where the shot appears on screen (world lens) vs where the sight line points at the zero distance
        // and vs the front sight post as drawn (view-model lens)
        const sZero = ndc(rs.clone().addScaledVector(bore, ZERO_M), tanV), sShot = ndc(out, tanW), sFront = ndc(fs, tanV);
        const degPerNdc = (Math.atan(tanW) * 180) / Math.PI;
        const eZero = Math.hypot(sZero[0] - sShot[0], sZero[1] - sShot[1]) * degPerNdc;
        const eFront = Math.hypot(sFront[0] - sShot[0], sFront[1] - sShot[1]) * degPerNdc;
        const eCentre = (Math.acos(Math.min(1, -out.z)) * 180) / Math.PI;
        console.log(`  ${clip}: shot vs sight line @${ZERO_M} m ${eZero.toFixed(3)}°, vs front sight post on screen ${eFront.toFixed(2)}°, vs image centre ${eCentre.toFixed(2)}°`);
        ok(eZero < 0.05, `${clip}: shot does not land where the sight line points (${eZero.toFixed(3)}°)`);
        ok(eCentre <= maxCentreDeg, `${clip}: aim point ${eCentre.toFixed(2)}° from the image centre`);
        // (the front post is NOT over the point of impact on screen: the chest camera sits above the sight line —
        //  bodycam parallax; the shot follows the sight line itself, checked above)
      }
    }
  }
  // ------------------------------------------------------------------ penetration reports
  {
    const rep = JSON.parse(readFileSync('public/assets/arms/penetration_report.json', 'utf8'));
    for (const [k, c] of Object.entries(rep.clips)) {
      ok(c.maxDepth_mm <= 1, `authoring check: ${k} glove inside the pistol by ${c.maxDepth_mm} mm`);
      ok(c.maxWristReachError_mm <= 1, `authoring check: ${k} hand misses its IK target by ${c.maxWristReachError_mm} mm`);
    }
    const mesh = JSON.parse(readFileSync('public/assets/arms/penetration_mesh_check.json', 'utf8'));
    const sha = createHash('sha1').update(readFileSync(glb)).digest('hex');
    ok(mesh.sha1 === sha, 'penetration_mesh_check.json is not from the shipped GLB: run scripts/chars/check_penetration.mjs');
    for (const [k, c] of Object.entries(mesh.clips)) ok(c.maxDepth_mm <= 1, `exported GLB: ${k} glove inside the pistol by ${c.maxDepth_mm} mm (t=${c.worstAt_s})`);
    console.log(`  penetration (exported GLB, ${mesh.method.split(',').pop().trim()}): ${Object.entries(mesh.clips).map(([k, c]) => `${k} ${c.maxDepth_mm}`).join(', ')} mm`);
  }
  // ------------------------------------------------------------------ controller regression (headless)
  {
    const col = createCollision(bvh);
    const tour = createDevtools({}).tour;
    const path = new Int32Array(8192);
    const body = createBody();
    const walk = (from, to, sprint, label) => {
      body.pos.x = from[0]; body.pos.y = from[1]; body.pos.z = from[2]; body.vel.x = body.vel.z = 0; body.st.grounded = true;
      const g = col.groundHeight(from[0], from[2], from[1] + 0.5, 0.2); if (g > -Infinity) body.pos.y = g;
      const a = nav.nearest(body.pos.x, body.pos.y + 0.1, body.pos.z), b = nav.nearest(to[0], to[1] + 0.1, to[2]);
      const n = nav.findPath(a, b, path, 200000);
      if (!n) return { ok: false, why: 'no path' };
      const nodes = Array.from(path.subarray(0, n)).reverse();
      let i = 0, t = 0, best = -1, lastProg = 0;
      const dt = 1 / 60, speed = sprint ? MOVE.sprint : MOVE.walk;
      while (t < 240) {
        while (i < nodes.length - 1 && Math.hypot(nav.nodeX(nodes[i]) - body.pos.x, nav.nodeZ(nodes[i]) - body.pos.z) < 0.35 && Math.abs(nav.nodeY[nodes[i]] - body.pos.y) < 0.3) i++;
        const k = nodes[i], tx = nav.nodeX(k), tz = nav.nodeZ(k);
        const dx = tx - body.pos.x, dz = tz - body.pos.z, l = Math.hypot(dx, dz) || 1;
        moveBody(body, col, (dx / l) * speed, (dz / l) * speed, dt);
        t += dt;
        if (i > best) { best = i; lastProg = t; }
        if (Math.hypot(to[0] - body.pos.x, to[2] - body.pos.z) < 0.7 && Math.abs(body.pos.y - to[1]) < 0.8) return { ok: true, t };
        if (t - lastProg > 6) {
          // a nav segment that runs through a solid box is a layout/nav defect, not a controller one
          let navDefect = false;
          for (let j = Math.max(1, i - 2); j <= Math.min(nodes.length - 1, i + 2) && !navDefect; j++) {
            const p0 = nodes[j - 1], p1 = nodes[j];
            const x0 = Math.min(nav.nodeX(p0), nav.nodeX(p1)), x1 = Math.max(nav.nodeX(p0), nav.nodeX(p1)), z0 = Math.min(nav.nodeZ(p0), nav.nodeZ(p1)), z1 = Math.max(nav.nodeZ(p0), nav.nodeZ(p1)), y = nav.nodeY[p1];
            bvh.query(x0 - 0.02, y + 0.6, z0 - 0.02, x1 + 0.02, y + 1.5, z1 + 0.02, F_SOLID, () => { navDefect = true; });
          }
          return { ok: false, navDefect, why: `stuck at ${body.pos.x.toFixed(2)},${body.pos.y.toFixed(2)},${body.pos.z.toFixed(2)} (${label})${navDefect ? ' — nav path crosses a solid box (layout/nav defect)' : ''}` };
        }
        if (body.pos.y < -20) return { ok: false, why: 'fell out of the world' };
      }
      return { ok: false, why: 'timeout' };
    };
    let legs = 0, secs = 0;
    const spawn = [45, 0, 107.5];
    let prev = spawn;
    for (const [k, w] of tour.entries()) {
      for (const sprint of [false, true]) {
        const r = walk(prev, w, sprint, `tour leg ${k}${sprint ? ' sprint' : ''}`);
        ok(r.ok, `controller: tour leg ${k} → ${w} ${sprint ? '(sprint)' : ''}: ${r.why}`);
        legs++; secs += r.t || 0;
      }
      // and back again (stairs down / up both ways)
      const rb = walk(w, prev, false, `tour leg ${k} back`);
      ok(rb.ok, `controller: tour leg ${k} back → ${prev}: ${rb.why}`);
      legs++; secs += rb.t || 0;
      prev = w;
    }
    // beyond the tour: random reachable nav nodes (seeded) — prop corners, rack gaps, ramps, mezzanine
    let seed = 12345; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const reach = nav.reachable(nav.nearest(spawn[0], 0.1, spawn[2]));
    const pick = () => { for (;;) { const k = (rnd() * nav.n) | 0; if (reach[k]) return [nav.nodeX(k), nav.nodeY[k], nav.nodeZ(k)]; } };
    let fails = 0;
    for (let j = 0; j < 40; j++) {
      const a = pick(), b = pick();
      const r = walk(a, b, j % 2 === 1, `random ${j}`);
      if (!r.ok && r.navDefect) { warn(false, `controller: random leg ${j}: ${r.why}`); continue; }
      if (!r.ok) { fails++; if (fails <= 5) console.log(`  random leg ${a.map((v) => v.toFixed(1))} → ${b.map((v) => v.toFixed(1))}: ${r.why}`); }
      legs++; secs += r.t || 0;
    }
    ok(fails === 0, `controller: ${fails}/40 random nav legs got stuck`);
    console.log(`  controller: ${legs} legs walked headless (${(secs / 60).toFixed(1)} min of game time) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  void W;
};
