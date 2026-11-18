// Damped scalar spring, integrated with fixed sub-steps so it stays stable at low frame rates.
export class Spring {
  /** @param {number} omega angular frequency (rad/s)  @param {number} zeta damping ratio */
  constructor(omega, zeta) {
    this.k = omega * omega;
    this.c = 2 * zeta * omega;
    this.x = 0;
    this.v = 0;
    this.target = 0;
  }
  impulse(v) { this.v += v; }
  reset(x = 0) { this.x = x; this.v = 0; this.target = x; }
  update(dt) {
    const n = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = this.k * (this.target - this.x) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
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
