import * as THREE from 'three';

// Central hitscan resolver. Everything that shoots goes through fire().
export function createCombat(ctx) {
  const ray = new THREE.Raycaster();
  const tmpN = new THREE.Vector3();

  function worldHit(origin, dir, maxDist) {
    ray.set(origin, dir); ray.near = 0; ray.far = maxDist;
    const hits = ray.intersectObjects(ctx.level.raycastMeshes, true);
    const h = hits[0];
    if (!h) return null;
    if (h.face) tmpN.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    else tmpN.copy(dir).negate();
    return { point: h.point, normal: tmpN.clone(), distance: h.distance, object: h.object };
  }

  // Ray vs. player capsule approximated by a sphere chain (feet..head).
  function playerHit(origin, dir, maxDist) {
    const p = ctx.player;
    if (!p || !p.alive) return null;
    const r = 0.32; let best = null;
    const c = new THREE.Vector3(), oc = new THREE.Vector3();
    for (let y = 0.3; y <= p.height; y += 0.3) {
      c.set(p.position.x, p.position.y + y, p.position.z);
      oc.subVectors(c, origin);
      const t = oc.dot(dir);
      if (t < 0 || t > maxDist) continue;
      const d2 = oc.lengthSq() - t * t;
      if (d2 <= r * r && (!best || t < best.distance)) best = { distance: t, point: origin.clone().addScaledVector(dir, t) };
    }
    return best;
  }

  /**
   * @param {{origin:THREE.Vector3, dir:THREE.Vector3, from:'player'|'enemy', shooter?:object, damage?:number, maxDist?:number}} o
   * @returns {{type:'world'|'enemy'|'player'|'none', point?:THREE.Vector3, distance:number}}
   */
  function fire(o) {
    const maxDist = o.maxDist ?? 120;
    const dir = o.dir.clone().normalize();
    const w = worldHit(o.origin, dir, maxDist);
    const limit = w ? w.distance : maxDist;
    let result = { type: 'none', distance: maxDist, point: o.origin.clone().addScaledVector(dir, maxDist) };

    if (o.from === 'player') {
      const e = ctx.enemies.raycast(o.origin, dir, limit);
      if (e) {
        e.enemy.takeDamage(o.damage ?? 50, e.part, dir, e.point);
        ctx.fx.blood(e.point, dir);
        ctx.audio.play('impact_flesh', { position: e.point });
        result = { type: 'enemy', point: e.point, distance: e.distance, enemy: e.enemy, part: e.part };
      }
    } else {
      const p = playerHit(o.origin, dir, limit);
      if (p) {
        ctx.player.takeDamage(o.damage ?? 40, dir);
        result = { type: 'player', point: p.point, distance: p.distance };
      }
    }
    if (result.type === 'none' && w) {
      const surface = ctx.level.surfaceOf(w.object);
      ctx.fx.impact(w.point, w.normal, surface);
      ctx.audio.play('impact_' + surface, { position: w.point, volume: 0.6, from: o.from });
      result = { type: 'world', point: w.point, distance: w.distance, surface };
    }
    if (o.from !== 'player' && result.type !== 'player') nearMiss(o, dir, result.distance);
    ctx.fx.tracer(o.origin, result.point);
    return result;
  }

  // Near miss: closest approach of the shot segment to the player's head -> supersonic crack / whizz.
  const nmHead = new THREE.Vector3(), nmOff = new THREE.Vector3();
  function nearMiss(o, dir, len) {
    const p = ctx.player;
    if (!p || !p.alive || !ctx.audio) return;
    if (p.eye) nmHead.copy(p.eye); else nmHead.set(p.position.x, p.position.y + (p.height || 1.8) - 0.12, p.position.z);
    nmOff.subVectors(nmHead, o.origin);
    const along = nmOff.dot(dir);
    if (along < 2 || along > len + 1.5) return;   // passed behind the shooter's muzzle area or stopped well short
    const miss = Math.sqrt(Math.max(0, nmOff.lengthSq() - along * along));
    if (miss > 2.2) return;
    const point = o.origin.clone().addScaledVector(dir, Math.min(along, len));
    ctx.audio.play('bullet_flyby', {
      position: point, missDistance: miss, along, dir,
      weapon: o.shooter?.weaponType || 'pistol', volume: 1,
    });
  }

  // True if nothing static blocks the segment a->b (used by AI for line of sight).
  function lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    return !worldHit(a, d.multiplyScalar(1 / len), len - 0.05);
  }

  return { fire, lineOfSight, worldHit };
}
