// Seeded deterministic RNG (mulberry32). The AI uses ONLY this (never Math.random) so headless simulations
// (scripts/test-d-enemies.mjs) are reproducible. Owner: D.
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const r = {
    /** float in [0, 1) */
    next() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(lo, hi) { return lo + (hi - lo) * r.next(); },
    chance(p) { return r.next() < p; },
    /** approx. normal(0, 1) (sum of 3 uniforms) */
    gauss() { return (r.next() + r.next() + r.next() - 1.5) * 2; },
    seed(s) { a = s >>> 0; },
    get state() { return a; },
  };
  return r;
}
