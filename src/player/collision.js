// Player collision helpers: a vertical box of half-width r (XZ) from y0 to y1 against axis-aligned THREE.Box3 colliders.
// Everything here is allocation-free.
const EPS = 1e-4;

export function overlaps(b, x, z, r, y0, y1) {
  return !(b.max.y <= y0 || b.min.y >= y1 ||
    x + r <= b.min.x || x - r >= b.max.x ||
    z + r <= b.min.z || z - r >= b.max.z);
}

/** True if any collider intersects the box. */
export function blocked(boxes, x, z, r, y0, y1) {
  for (let i = 0; i < boxes.length; i++) if (overlaps(boxes[i], x, z, r, y0, y1)) return true;
  return false;
}

/** Push pos out of any collider it already overlaps, along the axis of least penetration. */
export function depenetrate(pos, r, y0, y1, boxes) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!overlaps(b, pos.x, pos.z, r, y0, y1)) continue;
      const pxNeg = pos.x + r - b.min.x;   // move -x by this
      const pxPos = b.max.x - (pos.x - r); // move +x by this
      const pzNeg = pos.z + r - b.min.z;
      const pzPos = b.max.z - (pos.z - r);
      const m = Math.min(pxNeg, pxPos, pzNeg, pzPos);
      if (m === pxNeg) pos.x -= pxNeg + EPS;
      else if (m === pxPos) pos.x += pxPos + EPS;
      else if (m === pzNeg) pos.z -= pzNeg + EPS;
      else pos.z += pzPos + EPS;
      moved = true;
    }
    if (!moved) return;
  }
}

/**
 * Move pos by d along one axis (0 = x, 2 = z) and slide against colliders.
 * Assumes pos was free before the move (call depenetrate first). Returns true on contact.
 */
export function moveAxis(pos, axis, d, r, y0, y1, boxes) {
  if (d === 0) return false;
  let hit = false;
  if (axis === 0) pos.x += d; else pos.z += d;
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!overlaps(b, pos.x, pos.z, r, y0, y1)) continue;
      if (axis === 0) pos.x = d > 0 ? b.min.x - r - EPS : b.max.x + r + EPS;
      else pos.z = d > 0 ? b.min.z - r - EPS : b.max.z + r + EPS;
      hit = any = true;
    }
    if (!any) break;
  }
  return hit;
}

/**
 * Ray (origin o, unit dir d) against colliders inflated by `inflate`. Returns the nearest hit distance,
 * or maxDist when nothing is hit. A ray starting inside a box returns 0.
 */
export function rayBoxes(o, d, maxDist, inflate, boxes) {
  let best = maxDist;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let tmin = 0, tmax = best, miss = false;
    for (let a = 0; a < 3 && !miss; a++) {
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
      const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      const mn = (a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z) - inflate;
      const mx = (a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z) + inflate;
      if (Math.abs(da) < 1e-9) {
        if (oa < mn || oa > mx) miss = true;
      } else {
        let t1 = (mn - oa) / da, t2 = (mx - oa) / da;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) miss = true;
      }
    }
    if (!miss && tmin < best) best = tmin;
  }
  return best;
}
