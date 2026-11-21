// Aim maths (pure, allocation-free; unit-tested in scripts/test-c-player.mjs).
//
// Free aim (bodycam style): the mouse moves the GUN first; the gun leads inside a soft zone around the image
// centre and only drags the camera when it reaches the edge of the zone. Zone radius per setting (degrees).
//
// View-model lens: the arms are drawn with their own (narrower) field of view. A direction in the view-model's
// view space therefore appears on screen where the WORLD camera sees the direction (x·k, y·k, z) with
// k = tan(worldHalfV) / tan(vmHalfV). Shots use exactly that mapping, so bullets land where the sights / barrel
// visibly point on screen.
export const FREE_AIM_DEG = { off: 0, low: 2.5, standard: 5, strong: 9, aus: 0, gering: 2.5, stark: 9 }; // UI values (src/ui/ui.js) + German labels
export const ZERO_M = 15; // sights zeroed (meet the bore line on screen) at 15 m

/**
 * st: { yaw, pitch } gun offset from the camera (radians, mutated). dYaw/dPitch: mouse input this frame (rad).
 * Returns the camera rotation this frame in out { yaw, pitch }.
 */
export function freeAimStep(st, dYaw, dPitch, radius, dt, out) {
  out.yaw = 0; out.pitch = 0;
  if (radius <= 1e-5) { out.yaw = dYaw + st.yaw; out.pitch = dPitch + st.pitch; st.yaw = 0; st.pitch = 0; return out; }
  st.yaw += dYaw; st.pitch += dPitch;
  // elliptic zone (a bit flatter vertically)
  const ry = radius, rp = radius * 0.75;
  const m = Math.hypot(st.yaw / ry, st.pitch / rp);
  if (m > 1) {
    // hard edge: everything beyond the zone turns the camera
    const k = 1 - 1 / m;
    out.yaw += st.yaw * k; out.pitch += st.pitch * k;
    st.yaw -= st.yaw * k; st.pitch -= st.pitch * k;
  }
  // soft part: past 55 % of the zone the camera already follows a little (no hard stop feel)
  const m2 = Math.hypot(st.yaw / ry, st.pitch / rp);
  if (m2 > 0.55) {
    const f = Math.min(1, ((m2 - 0.55) / 0.45)) * Math.min(1, dt * 6);
    out.yaw += st.yaw * f * 0.5; out.pitch += st.pitch * f * 0.5;
    st.yaw -= st.yaw * f * 0.5; st.pitch -= st.pitch * f * 0.5;
  }
  return out;
}
/** clamp an existing offset into a (new, smaller) zone, e.g. when entering ADS; returns camera rotation */
export function freeAimClamp(st, radius, out) {
  out.yaw = 0; out.pitch = 0;
  if (radius <= 1e-5) { out.yaw = st.yaw; out.pitch = st.pitch; st.yaw = st.pitch = 0; return out; }
  const m = Math.hypot(st.yaw / radius, st.pitch / (radius * 0.75));
  if (m > 1) { const k = 1 - 1 / m; out.yaw = st.yaw * k; out.pitch = st.pitch * k; st.yaw -= out.yaw; st.pitch -= out.pitch; }
  return out;
}

/** k factor between the view-model lens and the world lens (vertical half-angle tangents) */
export const lensK = (tanWorld, tanVm) => tanWorld / tanVm;

/**
 * Shot direction in VIEW space (camera looks down -z) from the view-model sight line: the point where the
 * sight line is ZERO_M metres out, seen through the world lens. rs: rear sight, dir: bore direction (both
 * view-model view space). out: normalised direction (view space, world lens).
 */
export function shotDirView(rs, dir, k, out, zero = ZERO_M) {
  const px = rs.x + dir.x * zero, py = rs.y + dir.y * zero, pz = rs.z + dir.z * zero;
  out.x = px * k; out.y = py * k; out.z = pz;
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l; out.y /= l; out.z /= l;
  return out;
}
