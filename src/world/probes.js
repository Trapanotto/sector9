// Probe volume (baked ambient light for dynamic objects): GPU 3D textures + an allocation-free CPU sampler
// (used for auto-exposure, fog colour, the first-person view and anything that needs "how bright is it here").
// Owner: core (format) / B (quality).
import * as THREE from 'three';

export function createProbes(manifest, bytes) {
  const P = manifest.probes, [nx, ny, nz] = P.dims, n = nx * ny * nz, R = P.range;
  const l0 = bytes.subarray(0, n * 4), ds = bytes.subarray(n * 4, n * 8), art = bytes.subarray(n * 8, n * 12);
  const mk = (data) => {
    const t = new THREE.Data3DTexture(data, nx, ny, nz);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1; t.needsUpdate = true;
    return t;
  };
  const tex = { l0: mk(l0), dirSun: mk(ds), art: mk(art) };
  const origin = new THREE.Vector3(...P.origin);
  // uvw = (p - origin) * invSize + half texel  → we fold the half texel into origin
  const sp = P.spacing;
  const invSize = new THREE.Vector3(1 / (nx * sp), 1 / (ny * sp), 1 / (nz * sp));
  const texOrigin = new THREE.Vector3(P.origin[0] - sp / 2, P.origin[1] - sp / 2, P.origin[2] - sp / 2);

  /** trilinear sample at world point → out { r,g,b (day L0), ar,ag,ab (art L0), dx,dy,dz, sun } */
  function sample(x, y, z, out) {
    let fx = (x - P.origin[0]) / sp, fy = (y - P.origin[1]) / sp, fz = (z - P.origin[2]) / sp;
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy)); fz = Math.max(0, Math.min(nz - 1.001, fz));
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    out.r = out.g = out.b = out.ar = out.ag = out.ab = out.dx = out.dy = out.dz = out.sun = 0;
    for (let c = 0; c < 8; c++) {
      const cx = c & 1, cy = (c >> 1) & 1, cz = c >> 2;
      const w = (cx ? tx : 1 - tx) * (cy ? ty : 1 - ty) * (cz ? tz : 1 - tz);
      const i = ((ix + cx) + nx * ((iy + cy) + ny * (iz + cz))) * 4;
      const m = l0[i + 3] / 255 * R * w / 255, ma = art[i + 3] / 255 * R * w / 255;
      out.r += l0[i] * m; out.g += l0[i + 1] * m; out.b += l0[i + 2] * m;
      out.ar += art[i] * ma; out.ag += art[i + 1] * ma; out.ab += art[i + 2] * ma;
      out.dx += (ds[i] / 127.5 - 1) * w; out.dy += (ds[i + 1] / 127.5 - 1) * w; out.dz += (ds[i + 2] / 127.5 - 1) * w;
      out.sun += ds[i + 3] / 255 * w;
    }
    return out;
  }
  return {
    tex, origin: texOrigin, invSize, sample, bytes: n * 12,
    dispose() { tex.l0.dispose(); tex.dirSun.dispose(); tex.art.dispose(); },
  };
}
