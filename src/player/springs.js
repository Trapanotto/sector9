// Fixed-step integration: every spring advances in exact H-second steps from an accumulator, so the motion
// is identical at 30, 60 or 144 fps (the frame rate only changes when it is sampled). The visible value is
// extrapolated by the leftover time (< H) so there is no added latency.
export const H = 1 / 600;

/** Damped scalar spring (semi-implicit Euler at a fixed 600 Hz). */
export class Spring {
  /** @param {number} omega angular frequency (rad/s)  @param {number} zeta damping ratio */
  constructor(omega, zeta) {
    this.set(omega, zeta);
    this.x = 0;        // visible value (extrapolated by the accumulator remainder)
    this.v = 0;
    this.target = 0;
    this._x = 0;       // integrator state at the last whole step
    this._acc = 0;
  }
  set(omega, zeta) { this.k = omega * omega; this.c = 2 * zeta * omega; return this; }
  impulse(v) { this.v += v; }
  reset(x = 0) { this.x = this._x = x; this.v = 0; this.target = x; this._acc = 0; }
  update(dt) {
    // external code may write x (clamps); keep the integrator in sync with that
    if (this.x !== this._vis) this._x = this.x;
    this._acc += dt;
    while (this._acc >= H) {
      this._acc -= H;
      const a = this.k * (this.target - this._x) - this.c * this.v;
      this.v += a * H;
      this._x += this.v * H;
    }
    this.x = this._vis = this._x + this.v * this._acc;
    return this.x;
  }
}

/**
 * Critically-damped follower with velocity feed-forward: tracks a moving target with ZERO steady-state lag at a
 * constant turn rate, so it only smooths changes of speed (jerky input, frame pacing) instead of dragging behind.
 * The target is interpolated linearly across the frame, which makes the result frame-rate independent.
 */
export class Follower {
  constructor(omega) { this.omega = omega; this.x = 0; this.v = 0; this.target = 0; this._prev = 0; this._x = 0; this._acc = 0; this._t = 0; }
  reset(x = 0) { this.x = this._x = this.target = this._prev = x; this.v = 0; this._acc = 0; }
  /** move both the state and the target by d (wrap-around / teleports) */
  shift(d) { this.x += d; this._x += d; this.target += d; this._prev += d; }
  update(dt) {
    if (!(dt > 0)) return this.x;
    const w = this.omega, k = w * w, c = 2 * w;
    const t0 = this._prev, t1 = this.target, tv = (t1 - t0) / dt;
    // the accumulator remainder from the last frame belongs to this frame's interval
    let tau = -this._acc;
    this._acc += dt;
    while (this._acc >= H) {
      this._acc -= H;
      tau += H;
      const tg = t0 + (t1 - t0) * Math.min(1, Math.max(0, tau / dt));
      const a = k * (tg - this._x) + c * (tv - this.v);
      this.v += a * H;
      this._x += this.v * H;
    }
    this._prev = t1;
    this.x = this._x + this.v * this._acc;
    return this.x;
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
/** smoothstep of t between t0 and t1 */
export const seg = (t, t0, t1) => smooth01((t - t0) / (t1 - t0));
/** frame-rate independent exponential approach factor */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
