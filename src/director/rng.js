// Seeded RNG (mulberry32) + string hash. Deterministic per mission seed; no allocation per draw. Owner: F.
export function hash32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function createRng(seed = 1) {
  let s = seed >>> 0;
  const r = {
    seed(v) { s = v >>> 0; return r; },
    /** [0, 1) */
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(a, b) { return a + (b - a) * r.next(); },
    /** symmetric jitter in [-j, j] */
    jit(j) { return j ? (r.next() * 2 - 1) * j : 0; },
    int(n) { return Math.floor(r.next() * n); },
  };
  return r;
}
