// Persisted settings (localStorage, guarded). Owner: core; F edits values through the settings UI.
// Bindings: each action has a primary and a secondary key (KeyboardEvent.code). Movement works with WASD and
// the arrow keys out of the box.
const KEY = 'sector9.settings.v2';

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'], crouch: ['KeyC', 'ControlRight'], walk: ['AltLeft', 'Numpad0'],
  use: ['KeyE', 'Enter'], flashlight: ['KeyF', 'KeyL'], reload: ['KeyR', 'Backspace'],
  leanLeft: ['KeyQ', 'Delete'], leanRight: ['KeyX', 'PageDown'],
  perf: ['F9', 'Backquote'], pause: ['Escape', 'KeyP'],
};
export const BINDING_NAMES = {
  forward: 'Vorwärts', back: 'Rückwärts', left: 'Links', right: 'Rechts', sprint: 'Laufen', crouch: 'Ducken',
  walk: 'Langsam gehen', use: 'Benutzen / Tür', flashlight: 'Taschenlampe', reload: 'Nachladen',
  leanLeft: 'Lehnen links', leanRight: 'Lehnen rechts', perf: 'Leistungsanzeige', pause: 'Pause',
};

const DEFAULTS = {
  quality: 'auto', sensitivity: 1.0, invertY: false, fov: 112, volume: 0.8, flashlightDefault: false,
  bindings: DEFAULT_BINDINGS, showPerf: false,
};

export function createSettings() {
  let data = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      data = { ...data, ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings ?? {}) } };
    }
  } catch { /* private mode / blocked storage: defaults */ }
  return {
    data,
    save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ } },
    reset() { data = structuredClone(DEFAULTS); this.data = data; this.save(); },
    keys(action) { return data.bindings[action] ?? DEFAULT_BINDINGS[action] ?? []; },
  };
}
