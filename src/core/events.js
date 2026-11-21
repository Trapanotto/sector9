// Tiny synchronous event bus. Listener lists are copy-on-write, so emit() never allocates and listeners may
// (un)subscribe while an event is being dispatched. Payload objects should be reused by emitters in hot paths.
export function createEvents() {
  const map = new Map();
  return {
    on(type, fn) { map.set(type, [...(map.get(type) ?? []), fn]); return () => this.off(type, fn); },
    once(type, fn) { const w = (p) => { this.off(type, w); fn(p); }; return this.on(type, w); },
    off(type, fn) { const l = map.get(type); if (l) map.set(type, l.filter((f) => f !== fn)); },
    emit(type, payload) {
      const l = map.get(type);
      if (!l) return;
      for (let i = 0; i < l.length; i++) {
        try { l[i](payload); } catch (e) { console.error(`[events] ${type}:`, e); }
      }
    },
    /** debug: list of event types with listener counts */
    dump() { return [...map].map(([k, l]) => `${k}:${l.length}`); },
  };
}
