// Allocation-free delayed calls: fixed pool of entries { t, fn, s, x, y, z, a, b, k }. `fn` must be a
// long-lived function (module-level), never a fresh closure, so scheduling allocates nothing. Owner: E.
export function createScheduler(cap = 160) {
  const items = Array.from({ length: cap }, () => ({ on: false, t: 0, fn: null, s: '', x: 0, y: 0, z: 0, a: null, b: 0, k: 0 }));
  let dropped = 0;
  const S = {
    items,
    get dropped() { return dropped; },
    /** call fn(item) at time t (same clock as run(now)) */
    at(t, fn, s = '', x = 0, y = 0, z = 0, a = null, b = 0, k = 0) {
      for (let i = 0; i < cap; i++) {
        const it = items[i];
        if (it.on) continue;
        it.on = true; it.t = t; it.fn = fn; it.s = s; it.x = x; it.y = y; it.z = z; it.a = a; it.b = b; it.k = k;
        return it;
      }
      dropped++;
      return null;
    },
    run(now) {
      for (let i = 0; i < cap; i++) {
        const it = items[i];
        if (!it.on || it.t > now) continue;
        it.on = false;
        try { it.fn(it); } catch (e) { console.error('[audio] scheduled', e); }
      }
    },
    /** cancel entries matching fn (and optional k) */
    cancel(fn, k = -1) { for (const it of items) if (it.on && (!fn || it.fn === fn) && (k < 0 || it.k === k)) it.on = false; },
    clear() { for (const it of items) it.on = false; },
    pending() { let n = 0; for (const it of items) if (it.on) n++; return n; },
  };
  return S;
}
