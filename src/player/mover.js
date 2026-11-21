// Character movement (pure, allocation-free): grounded acceleration/friction on top of the core collision API
// (ctx.world.collision.move). Shared by the player controller and the headless controller regression test
// (scripts/test-c-player.mjs), so what the test walks is exactly what the game walks.
export const MOVE = {
  radius: 0.3, height: 1.78, crouchHeight: 1.12, step: 0.45,
  walk: 2.35, sprint: 4.5, crouch: 1.25, slow: 1.15, ads: 1.6, back: 0.8,   // back: factor walking backwards
  accel: 11, decel: 14, airAccel: 1.5, gravity: 9.81, maxFall: 30,
};

/** state object for one body */
export function createBody() {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    st: { grounded: true, vy: 0, hitWall: false, groundY: 0 },
    d: { x: 0, y: 0, z: 0 },
    height: MOVE.height, stuck: 0, lastX: 0, lastZ: 0,
  };
}

/**
 * One step. wishX/wishZ: desired world-space velocity (m/s, horizontal). Returns the body.
 * Ground: velocity approaches the wish with `accel` (speeding up) / `decel` (slowing, friction) in m/s².
 */
export function moveBody(b, collision, wishX, wishZ, dt, frozen = false) {
  const v = b.vel, st = b.st;
  const dx = wishX - v.x, dz = wishZ - v.z;
  const dl = Math.hypot(dx, dz);
  if (dl > 1e-6) {
    const speeding = wishX * wishX + wishZ * wishZ > v.x * v.x + v.z * v.z + 1e-4;
    const rate = (st.grounded ? (speeding ? MOVE.accel : MOVE.decel) : MOVE.airAccel) * dt;
    const k = dl > rate ? rate / dl : 1;
    v.x += dx * k; v.z += dz * k;
  }
  if (st.grounded) v.y = 0; else v.y = Math.max(-MOVE.maxFall, v.y - MOVE.gravity * dt);
  if (frozen) return b;
  const d = b.d;
  d.x = v.x * dt; d.z = v.z * dt; d.y = st.grounded ? -0.06 : v.y * dt;
  const px = b.pos.x, pz = b.pos.z;
  collision.move(b.pos, d, { radius: MOVE.radius, height: b.height, step: MOVE.step }, st);
  // wall contact: keep only the velocity that actually happened (no pushing into walls / no ice skating)
  if (st.hitWall && dt > 0) {
    const ax = (b.pos.x - px) / dt, az = (b.pos.z - pz) / dt;
    if (ax * v.x + az * v.z < v.x * v.x + v.z * v.z) { v.x = ax; v.z = az; }
  }
  return b;
}
