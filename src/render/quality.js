// Hardware tier detection (before anything big is allocated) and the automatic quality controller.
//
// detectTier(): conservative first guess from the GPU string (WEBGL_debug_renderer_info), CPU threads, device
// memory and screen size. Software renderers and phone GPUs start at 'minimal', integrated Intel / AMD graphics at
// 'minimal' or 'low', unknown hardware at 'medium', recognised discrete GPUs at 'high'.
// createAutoQuality(): watches real frame times (only while the tab is visible) and steps down within about two
// seconds when far below target (two tiers at once when very slow), then lowers the render scale below the lowest
// tier so the game never sits at a single-digit frame rate; it steps back up only after a long stretch with clear
// headroom, never above the detected ceiling.

export const TIERS = ['minimal', 'low', 'medium', 'high'];

export function gpuInfo() {
  let renderer = '', vendor = '', webgl2 = false, float = false, tex3d = false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (gl) {
      webgl2 = true;
      tex3d = typeof gl.texImage3D === 'function';
      float = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
      vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL */ }
  return { renderer, vendor, webgl2, float, tex3d };
}

export function detectTier(info = gpuInfo()) {
  const r = (info.renderer + ' ' + info.vendor).toLowerCase();
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;            // Chrome only, capped at 8
  const px = (screen.width || 1920) * (screen.height || 1080) * Math.min(2, devicePixelRatio || 1) ** 2;
  let tier = 'medium', why = 'unbekannte GPU';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r)) { tier = 'minimal'; why = 'Software-Renderer'; }
  else if (/mali|adreno|powervr|apple gpu|videocore/.test(r) && !/apple m\d/.test(r)) { tier = 'minimal'; why = 'Mobil-GPU'; }
  else if (/intel/.test(r)) {
    if (/iris\(r\) xe|iris xe|arc/.test(r)) { tier = /arc/.test(r) ? 'medium' : 'low'; why = 'Intel Iris Xe / Arc'; }
    else { tier = 'minimal'; why = 'Intel integriert'; }
  } else if (/amd|radeon|ati/.test(r)) {
    // APUs report "AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon 680M" ...
    if (/radeon\(tm\) graphics|vega \d+ graphics|radeon graphics|r\d graphics|6[0-9]0m|7[0-9]0m/.test(r)) { tier = 'low'; why = 'AMD integriert'; }
    else if (/rx\s?[5-9]\d{2,3}|rx\s?\d{4}|pro w|radeon vii/.test(r)) { tier = 'high'; why = 'AMD dediziert'; }
  } else if (/nvidia|geforce|quadro|rtx|gtx/.test(r)) {
    if (/gt \d{3}|mx\s?\d{3}|gtx (6|7|9)\d0m?/.test(r)) { tier = 'low'; why = 'NVIDIA Einstieg'; }
    else { tier = 'high'; why = 'NVIDIA dediziert'; }
  } else if (/apple m\d/.test(r)) { tier = 'medium'; why = 'Apple Silicon'; }
  // weak CPU / little memory caps the tier (enemy AI, light bake and texture decode share these)
  if ((cores <= 4 || mem <= 4) && TIERS.indexOf(tier) > 1) { tier = 'low'; why += `, ${cores} Threads / ${mem} GB`; }
  if (cores <= 2 && tier !== 'minimal') { tier = 'minimal'; why += ', 2 Threads'; }
  // very large drawing buffers (4K at DPR 2) on mid hardware: one step down
  if (px > 3840 * 2160 * 1.2 && tier === 'medium') tier = 'low';
  return { tier, why, cores, mem, gpu: info.renderer };
}

/**
 * Frame-time controller. apply(tier, scale) is called on every change. In 'auto' mode it adapts; with a manual
 * tier it only lowers the render scale as a last resort when the frame rate collapses.
 */
export function createAutoQuality({ apply, ceiling = 'high', start = 'medium' }) {
  const st = {
    mode: 'auto', tier: start, scale: 1, ceiling,
    win: [], slowT: 0, fastT: 0, sinceChange: 0, frames: 0, last: [],
  };
  const target = (t) => (TIERS.indexOf(t) >= 2 ? 1000 / 55 : 1000 / 30);      // ms; high/medium aim at 60, low tiers at 30
  function set(tier, scale) {
    const changed = tier !== st.tier || Math.abs(scale - st.scale) > 1e-3;
    st.tier = tier; st.scale = scale; st.slowT = 0; st.fastT = 0; st.sinceChange = 0; st.win.length = 0;
    if (changed) apply(tier, scale);
  }
  return {
    state: st,
    get tier() { return st.tier; },
    get scale() { return st.scale; },
    setMode(mode) {
      st.mode = mode;
      if (mode === 'auto') set(TIERS.indexOf(st.tier) > TIERS.indexOf(st.ceiling) ? st.ceiling : st.tier, 1);
      else set(mode, 1);
    },
    /** call once per rendered frame with the real frame time (ms); paused / hidden frames must not be fed */
    sample(ms) {
      if (!(ms > 0) || ms > 500) return;
      st.frames++;
      st.sinceChange += ms / 1000;
      if (st.sinceChange < 0.6) return;                 // let a change settle (shader compiles, RT reallocation)
      st.win.push(ms); if (st.win.length > 45) st.win.shift();
      if (st.win.length < 20) return;
      const sorted = st.win.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length * 0.5)];
      const tgt = target(st.tier);
      const i = TIERS.indexOf(st.tier);
      if (med > tgt * 1.2) st.slowT += ms / 1000; else st.slowT = Math.max(0, st.slowT - ms / 2000);
      if (med < tgt * 0.62) st.fastT += ms / 1000; else st.fastT = 0;
      const verySlow = med > tgt * 2;
      if (st.slowT > (verySlow ? 1.0 : 1.8)) {
        if (st.mode === 'auto' && i > 0) set(TIERS[Math.max(0, i - (verySlow ? 2 : 1))], 1);
        else if (st.scale > 0.5) set(st.tier, Math.max(0.5, st.scale * (verySlow ? 0.75 : 0.87)));
        return;
      }
      if (st.mode === 'auto' && st.fastT > 8 && st.sinceChange > 20) {
        if (st.scale < 1) set(st.tier, Math.min(1, st.scale / 0.87));
        else if (i < TIERS.indexOf(st.ceiling)) set(TIERS[i + 1], 1);
      }
    },
  };
}
