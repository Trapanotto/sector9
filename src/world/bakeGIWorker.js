// Web Worker wrapper around the irradiance bake kernel. One worker traces an interleaved set of probe z-slices.
import { voxelize, createTracer } from './bakeGIKernel.js';

let tracer = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const vox = voxelize(m.boxes);
      tracer = createTracer({ vox, albedo: m.albedo, sky: m.sky, sun: m.sun, lamp: m.lamp });
      tracer.traceSlices(m.zs, m.rays, m.seed);
      self.postMessage({ type: 'traced' });
    } else if (m.type === 'gather') {
      const out = tracer.gather(m.prev);
      self.postMessage({ type: 'gathered', out }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
