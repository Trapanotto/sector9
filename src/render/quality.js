// Quality tiers, GPU detection and dynamic resolution. Owner: B (may retune), core (interface).
// Tiers never change shaders (all switches are uniforms or render-target settings), so switching mid-game
// causes no shader compile. Event: 'quality:change' { tier }.

export const TIERS = {
  vlow: { id: 'vlow', name: 'Sehr niedrig', outH: 720, scaleMin: 0.5, scaleMax: 0.75, msaa: 0, bloom: 0, hdr: true, anim: 0.5, noise: 0.05 },
  low:  { id: 'low', name: 'Niedrig', outH: 720, scaleMin: 0.6, scaleMax: 1.0, msaa: 0, bloom: 0, hdr: true, anim: 0.75, noise: 0.045 },
  mid:  { id: 'mid', name: 'Mittel', outH: 1080, scaleMin: 0.6, scaleMax: 0.9, msaa: 0, bloom: 0.12, hdr: true, anim: 1, noise: 0.04 },
  high: { id: 'high', name: 'Hoch', outH: 1440, scaleMin: 0.7, scaleMax: 1.0, msaa: 4, bloom: 0.16, hdr: true, anim: 1, noise: 0.038 },
};
export const MODES = [['auto', 'Automatisch'], ['vlow', 'Sehr niedrig'], ['low', 'Niedrig'], ['mid', 'Mittel'], ['high', 'Hoch']];
const ORDER = ['vlow', 'low', 'mid', 'high'];

/** Classify the GPU from the unmasked renderer string. Returns { tier, renderer, software, reason }. */
export function detectGPU(gl) {
  let r = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* ignore */ }
  const s = String(r).toLowerCase();
  const has = (...k) => k.some((x) => s.includes(x));
  if (has('swiftshader', 'llvmpipe', 'software', 'basic render', 'microsoft basic')) return { tier: 'vlow', renderer: r, software: true, reason: 'Software-Rendering' };
  if (has('intel') && !has('arc')) return { tier: 'low', renderer: r, reason: 'Intel iGPU' };
  if (has('radeon(tm) graphics', 'radeon graphics', 'vega', 'radeon(tm) r', 'amd custom gpu')) return { tier: 'low', renderer: r, reason: 'AMD APU' };
  if (has('mali', 'adreno', 'powervr', 'apple gpu')) return { tier: 'low', renderer: r, reason: 'Mobil-GPU' };
  if (has('apple m', 'apple')) return { tier: 'mid', renderer: r, reason: 'Apple Silicon' };
  if (has('rtx', 'radeon rx', 'rx 6', 'rx 7', 'arc a', 'arc(tm)', 'quadro', 'geforce gtx 16', 'gtx 10')) return { tier: 'high', renderer: r, reason: 'dedizierte GPU' };
  if (has('nvidia', 'geforce', 'radeon')) return { tier: 'mid', renderer: r, reason: 'dedizierte GPU (älter)' };
  return { tier: 'low', renderer: r, reason: 'unbekannt' };
}

export function createQuality(ctx, gl) {
  const gpu = detectGPU(gl);
  const q = {
    gpu, mode: ctx.settings.data.quality ?? 'auto',
    tier: null, scale: 1,
    get tierId() { return q.tier.id; },
    setMode(mode) {
      q.mode = mode;
      ctx.settings.data.quality = mode; ctx.settings.save();
      q._apply(mode === 'auto' ? gpu.tier : mode);
    },
    _apply(id) {
      q.tier = TIERS[id];
      q.scale = q.tier.scaleMax;
      ctx.events.emit('quality:change', q.tier);
    },
    // ---- dynamic resolution: frame time ring → adjust scale within the tier; auto mode can step tiers
    _ring: new Float32Array(90), _n: 0, _sorted: new Float32Array(90), _cool: 0, _downCount: 0,
    /** call once per frame with the measured frame interval (ms) */
    update(ms) {
      if (ctx.bench) return;   // benchmark: fixed tier at its max scale
      const r = q._ring; r[q._n++ % r.length] = ms;
      if (q._cool > 0) { q._cool--; return; }
      if (q._n < r.length) return;
      q._sorted.set(r); q._sorted.sort();
      const med = q._sorted[45], p90 = q._sorted[81];
      const t = q.tier;
      const target = 16.9;
      if (med > target + 2.5 || p90 > 33) {
        if (q.scale > t.scaleMin + 1e-3) { q.scale = Math.max(t.scaleMin, q.scale * (med > 30 ? 0.8 : 0.9)); q._cool = 45; }
        else if (q.mode === 'auto' && ORDER.indexOf(t.id) > 0 && ++q._downCount >= 2) {
          q._apply(ORDER[ORDER.indexOf(t.id) - 1]); q.scale = q.tier.scaleMax; q._cool = 120; q._downCount = 0;
        } else q._cool = 60;
      } else if (med < target - 1.0 && p90 < 20 && q.scale < t.scaleMax - 1e-3) {
        // vsync hides headroom: creep up slowly, the next slow window pushes back down
        q.scale = Math.min(t.scaleMax, q.scale * 1.05); q._cool = 90;
      }
    },
  };
  q._apply(q.mode === 'auto' ? gpu.tier : q.mode);
  return q;
}
