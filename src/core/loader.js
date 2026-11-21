// Asset loader with weighted progress. All URLs are relative to import.meta.env.BASE_URL (GitHub Pages
// sub-path). Owner: core. Modules register work in their load(loader) hook:
//   loader.json('bake/manifest.json'), loader.bin('bake/lm_day.bin', { inflate: true }), loader.gltf('models/x.glb'),
//   loader.texture('textures/x.webp')
// Progress: ctx.events 'load:progress' { p: 0..1, label }.
import * as THREE from 'three';

export const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './';
export const url = (p) => BASE + p.replace(/^\//, '');

export function createLoader(events) {
  const jobs = [];   // { weight, done (0..1), label }
  let label = '';
  const report = () => {
    let w = 0, d = 0; for (const j of jobs) { w += j.weight; d += j.weight * j.done; }
    events.emit('load:progress', { p: w ? d / w : 0, label });
  };
  const job = (weight, l) => { const j = { weight, done: 0, label: l }; jobs.push(j); label = l; report(); return j; };

  async function fetchBytes(path, j) {
    const res = await fetch(url(path));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || 0;
    if (!res.body || !total) { const b = new Uint8Array(await res.arrayBuffer()); j.done = 1; report(); return b; }
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      j.done = Math.min(0.99, got / total); report();
    }
    const out = new Uint8Array(got);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    j.done = 1; report();
    return out;
  }
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    get progress() { let w = 0, d = 0; for (const j of jobs) { w += j.weight; d += j.weight * j.done; } return w ? d / w : 0; },
    async json(path, weight = 0.2) { const j = job(weight, path); const b = await fetchBytes(path, j); return JSON.parse(new TextDecoder().decode(b)); },
    async bin(path, { inflate: z = false, weight = 1 } = {}) { const j = job(weight, path); const b = await fetchBytes(path, j); return z ? inflate(b) : b; },
    async gltf(path, weight = 1) {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const j = job(weight, path);
      const g = await new GLTFLoader().loadAsync(url(path), (e) => { if (e.total) { j.done = Math.min(0.99, e.loaded / e.total); report(); } });
      j.done = 1; report();
      return g;
    },
    async texture(path, weight = 0.3) {
      const j = job(weight, path);
      const t = await new THREE.TextureLoader().loadAsync(url(path));
      j.done = 1; report();
      return t;
    },
    /** arbitrary step (e.g. building meshes) so the bar keeps moving */
    step(l, weight = 0.2) { const j = job(weight, l); return () => { j.done = 1; report(); }; },
  };
}
