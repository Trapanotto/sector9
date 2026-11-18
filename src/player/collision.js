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
 * Circle (radius r in XZ, vertical extent y0..y1) against the colliders: pushes pos out of every box it overlaps
 * along the shortest way out. Rounded body: box corners deflect the player around them instead of snagging.
 * Writes the summed contact normal into nOut ({x, z}, not normalised) and returns the number of contacts.
 */
export function collideCircle(pos, r, y0, y1, boxes, nOut) {
  let contacts = 0;
  if (nOut) { nOut.x = 0; nOut.z = 0; }
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.max.y <= y0 || b.min.y >= y1) continue;
      if (pos.x + r <= b.min.x || pos.x - r >= b.max.x || pos.z + r <= b.min.z || pos.z - r >= b.max.z) continue;
      const cx = pos.x < b.min.x ? b.min.x : pos.x > b.max.x ? b.max.x : pos.x;
      const cz = pos.z < b.min.z ? b.min.z : pos.z > b.max.z ? b.max.z : pos.z;
      let nx = pos.x - cx, nz = pos.z - cz;
      const d2 = nx * nx + nz * nz;
      let push;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        if (d >= r) continue;
        nx /= d; nz /= d; push = r - d + EPS;
      } else {
        // centre inside the box: leave through the nearest face
        const a = pos.x - b.min.x, bb = b.max.x - pos.x, c = pos.z - b.min.z, e = b.max.z - pos.z;
        const m = Math.min(a, bb, c, e);
        nx = m === a ? -1 : m === bb ? 1 : 0; nz = m === c ? -1 : m === e ? 1 : 0;
        if (nx && nz) nz = 0;
        push = m + r + EPS;
      }
      pos.x += nx * push; pos.z += nz * push;
      if (nOut) { nOut.x += nx; nOut.z += nz; }
      contacts++; moved = true;
    }
    if (!moved) break;
  }
  return contacts;
}

/**
 * Highest collider top under a small disc around (x, z) within [yMin, yMax] (low clutter the player can stand
 * on). Returns -Infinity when there is none.
 */
export function boxGround(boxes, x, z, r, yMin, yMax) {
  let best = -Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const t = b.max.y;
    if (t < yMin || t > yMax || t <= best) continue;
    if (x + r <= b.min.x || x - r >= b.max.x || z + r <= b.min.z || z - r >= b.max.z) continue;
    best = t;
  }
  return best;
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
