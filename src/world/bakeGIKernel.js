// Irradiance-volume bake kernel (pure JS, no three.js; runs inside Web Workers or on the main thread).
//
// The static world is voxelised from the layout's axis-aligned solid boxes (0.25 m voxels). Every probe of a
// 0.5 m grid shoots stratified rays through the voxel grid (3D DDA). A ray that leaves the grid sees the sky
// (sampled from the actual HDRI); a ray that hits a solid gathers the radiance leaving that face:
//   albedo/pi * (direct sun * sun visibility + work lamp + indirect irradiance from the previous iteration).
// Each iteration adds one bounce. The result is stored as L1 spherical-harmonic *irradiance* per colour channel:
//   E(n) = c0 + c1 . n      (c0 = pi * mean(L), c1 = 2 pi * mean(L * dir))
// which is exactly what three's indirect-diffuse term wants.

export const VOX = { x0: -30, y0: -0.5, z0: -26, s: 0.25, nx: 224, ny: 42, nz: 232 };
// Probe centres coincide with voxel centres (probe i sits on voxel 2i+1 along each axis, offset 17 in x/z, 1 in y).
export const PROBE = { x0: -25.625, y0: -0.125, z0: -21.625, s: 0.5, nx: 96, ny: 20, nz: 100 };
export const PROBE_VOX_OFF = [
  Math.round((PROBE.x0 - VOX.x0) / VOX.s - 0.5),
  Math.round((PROBE.y0 - VOX.y0) / VOX.s - 0.5),
  Math.round((PROBE.z0 - VOX.z0) / VOX.s - 0.5),
];

// Fill voxels whose centre lies inside each box (thin boxes still claim the nearest voxel layer).
// boxes: [{ min, max, id }] with id >= 1; later boxes overwrite earlier ones.
export function voxelize(boxes) {
  const { x0, y0, z0, s, nx, ny, nz } = VOX;
  const vox = new Uint16Array(nx * ny * nz);
  const range = (a, b, o, n) => {
    let i0 = Math.ceil((a - o) / s - 0.5), i1 = Math.floor((b - o) / s - 0.5);
    if (i1 < i0) { const m = Math.round(((a + b) / 2 - o) / s - 0.5); i0 = i1 = m; }
    return [Math.max(0, i0), Math.min(n - 1, i1)];
  };
  for (const b of boxes) {
    const [ia, ib] = range(b.min[0], b.max[0], x0, nx);
    const [ja, jb] = range(b.min[1], b.max[1], y0, ny);
    const [ka, kb] = range(b.min[2], b.max[2], z0, nz);
    for (let k = ka; k <= kb; k++) for (let j = ja; j <= jb; j++) {
      const row = nx * (j + ny * k);
      for (let i = ia; i <= ib; i++) vox[row + i] = b.id;
    }
  }
  return vox;
}

// ------------------------------------------------------------------------------------------------ tracer
export function createTracer(params) {
  const { vox, albedo, sky, sun, lamp } = params;
  const { x0, y0, z0, s, nx, ny, nz } = VOX;
  const strideY = nx, strideZ = nx * ny;
  const sunVis = new Uint8Array(nx * ny * nz);    // 0 unknown, 1 shadowed, 2 lit
  const lampVis = new Uint8Array(nx * ny * nz);

  // Generic occlusion march from a voxel centre along d (unit) for at most maxT metres. true = blocked.
  function blocked(ix, iy, iz, dx, dy, dz, maxT) {
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(s / dx) : 1e30, tdy = dy !== 0 ? Math.abs(s / dy) : 1e30, tdz = dz !== 0 ? Math.abs(s / dz) : 1e30;
    let tmx = tdx * 0.5, tmy = tdy * 0.5, tmz = tdz * 0.5;
    let idx = ix + strideY * iy + strideZ * iz;
    for (;;) {
      if (tmx < tmy && tmx < tmz) {
        if (tmx > maxT) return false;
        ix += stepX; if (ix < 0 || ix >= nx) return false; idx += stepX; tmx += tdx;
      } else if (tmy < tmz) {
        if (tmy > maxT) return false;
        iy += stepY; if (iy < 0 || iy >= ny) return false; idx += stepY * strideY; tmy += tdy;
      } else {
        if (tmz > maxT) return false;
        iz += stepZ; if (iz < 0 || iz >= nz) return false; idx += stepZ * strideZ; tmz += tdz;
      }
      if (vox[idx] !== 0) return true;
    }
  }

  function sunVisible(idx, ix, iy, iz) {
    let v = sunVis[idx];
    if (v === 0) { v = blocked(ix, iy, iz, sun.dx, sun.dy, sun.dz, 200) ? 1 : 2; sunVis[idx] = v; }
    return v === 2;
  }

  // Sky radiance (lat-long table in three's equirect convention).
  const TW = sky.w, TH = sky.h, SK = sky.data;
  const INV2PI = 1 / (2 * Math.PI), INVPI = 1 / Math.PI;
  function skyIdx(dx, dy, dz) {
    const u = Math.atan2(dz, dx) * INV2PI + 0.5;
    const v = Math.asin(dy < -1 ? -1 : dy > 1 ? 1 : dy) * INVPI + 0.5;
    let iu = (u * TW) | 0, iv = (v * TH) | 0;
    if (iu >= TW) iu = TW - 1; if (iv >= TH) iv = TH - 1; if (iu < 0) iu = 0; if (iv < 0) iv = 0;
    return (iv * TW + iu) * 3;
  }

  const P = PROBE, pnx = P.nx, pny = P.ny, pnz = P.nz;
  // Nearest-probe irradiance lookup into the previous iteration (E = c0 + c1.n, clamped).
  function prevIrr(prev, wx, wy, wz, n0, n1, n2, out) {
    let i = Math.round((wx - P.x0) / P.s), j = Math.round((wy - P.y0) / P.s), k = Math.round((wz - P.z0) / P.s);
    if (i < 0) i = 0; else if (i >= pnx) i = pnx - 1;
    if (j < 0) j = 0; else if (j >= pny) j = pny - 1;
    if (k < 0) k = 0; else if (k >= pnz) k = pnz - 1;
    const o = (i + pnx * (j + pny * k)) * 12;
    const r = prev[o] + prev[o + 3] * n0 + prev[o + 4] * n1 + prev[o + 5] * n2;
    const g = prev[o + 1] + prev[o + 6] * n0 + prev[o + 7] * n1 + prev[o + 8] * n2;
    const b = prev[o + 2] + prev[o + 9] * n0 + prev[o + 10] * n1 + prev[o + 11] * n2;
    out[0] = r > 0 ? r : 0; out[1] = g > 0 ? g : 0; out[2] = b > 0 ? b : 0;
  }

  const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const tmp = [0, 0, 0];
  const cosA = lamp ? Math.cos(lamp.angle) : 1, cosP = lamp ? Math.cos(lamp.angle * (1 - lamp.penumbra)) : 1;

  // Radiance leaving the face of solid voxel `hitIdx` seen from the air voxel (ax,ay,az).
  function faceRadiance(hitId, face, aIdx, ax, ay, az, prev, out) {
    const n = FN[face];
    let er = 0, eg = 0, eb = 0;
    const ndl = n[0] * sun.dx + n[1] * sun.dy + n[2] * sun.dz;
    if (ndl > 0 && sunVisible(aIdx, ax, ay, az)) { er += sun.r * ndl; eg += sun.g * ndl; eb += sun.b * ndl; }
    const wx = x0 + (ax + 0.5) * s, wy = y0 + (ay + 0.5) * s, wz = z0 + (az + 0.5) * s;
    if (lamp) {
      let lx = lamp.x - wx, ly = lamp.y - wy, lz = lamp.z - wz;
      const d2 = lx * lx + ly * ly + lz * lz, d = Math.sqrt(d2);
      if (d < lamp.range) {
        lx /= d; ly /= d; lz /= d;
        const nl = n[0] * lx + n[1] * ly + n[2] * lz;
        const cd = -(lx * lamp.dx + ly * lamp.dy + lz * lamp.dz);
        if (nl > 0 && cd > cosA) {
          let lv = lampVis[aIdx];
          if (lv === 0) { lv = blocked(ax, ay, az, lx, ly, lz, d - 0.3) ? 1 : 2; lampVis[aIdx] = lv; }
          if (lv === 2) {
            let sp = (cd - cosA) / Math.max(1e-4, cosP - cosA); sp = sp > 1 ? 1 : sp; sp = sp * sp * (3 - 2 * sp);
            let win = 1 - (d / lamp.range) ** 4; win = win > 0 ? win * win : 0;
            const k = lamp.i * nl * sp * win / Math.max(d2, 0.25);
            er += lamp.r * k; eg += lamp.g * k; eb += lamp.b * k;
          }
        }
      }
    }
    if (prev) {
      prevIrr(prev, wx + n[0] * 0.25, wy + n[1] * 0.25, wz + n[2] * 0.25, n[0], n[1], n[2], tmp);
      er += tmp[0]; eg += tmp[1]; eb += tmp[2];
    }
    const a = (hitId - 1) * 18 + face * 3;
    out[0] = albedo[a] * er * INVPI; out[1] = albedo[a + 1] * eg * INVPI; out[2] = albedo[a + 2] * eb * INVPI;
  }

  // Pass 1 (expensive, once): trace every ray of every probe in the given z-slices and remember what it hit.
  // code >= 0: (air voxel index * 8 + face) of the hit; code < 0: -(sky table index + 1).
  // Pass 2 (cheap, once per bounce): gather() turns the stored hits into SH irradiance using the previous bounce.
  const GOLD = 0.6180339887498949;
  let hits = null, jit = null, slices = null, nRays = 0;
  // rays climbing above every roof only meet the sky (distant silhouettes are ignored from up there)
  const skyY = Math.ceil(((params.skyHeight ?? 8.7) - y0) / s);

  function traceSlices(zs, rays, seed) {
    slices = zs; nRays = rays;
    const nProbes = zs.length * pnx * pny;
    hits = new Int32Array(nProbes * rays);
    jit = new Float32Array(nProbes * 2);
    let p = 0;
    for (const pk of zs) for (let pj = 0; pj < pny; pj++) for (let pi = 0; pi < pnx; pi++, p++) {
      const ix0 = pi * 2 + PROBE_VOX_OFF[0], iy0 = pj * 2 + PROBE_VOX_OFF[1], iz0 = pk * 2 + PROBE_VOX_OFF[2];
      const idx0 = ix0 + strideY * iy0 + strideZ * iz0;
      let h = (seed ^ Math.imul(pi + 1, 73856093) ^ Math.imul(pj + 1, 19349663) ^ Math.imul(pk + 1, 83492791)) >>> 0;
      const rnd = () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const ju = rnd(), jv = rnd();
      jit[p * 2] = ju; jit[p * 2 + 1] = jv;
      const hb = p * rays;
      if (vox[idx0] !== 0) { hits[hb] = 0x7fffffff; continue; }     // probe inside a solid
      for (let r = 0; r < rays; r++) {
        const dy = 1 - 2 * ((r + ju) / rays);
        const rad = Math.sqrt(Math.max(0, 1 - dy * dy));
        const ph = 2 * Math.PI * ((r * GOLD + jv) % 1);
        const dx = rad * Math.cos(ph), dz = rad * Math.sin(ph);
        let ix = ix0, iy = iy0, iz = iz0, idx = idx0, aIdx = idx0, face = 0, hit = false;
        const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
        const tdx = dx !== 0 ? Math.abs(1 / dx) : 1e30, tdy = dy !== 0 ? Math.abs(1 / dy) : 1e30, tdz = dz !== 0 ? Math.abs(1 / dz) : 1e30;
        let tmx = tdx * 0.5, tmy = tdy * 0.5, tmz = tdz * 0.5;
        for (;;) {
          aIdx = idx;
          if (tmx < tmy && tmx < tmz) {
            ix += stepX; if (ix < 0 || ix >= nx) break; idx += stepX; tmx += tdx; face = stepX > 0 ? 1 : 0;
          } else if (tmy < tmz) {
            iy += stepY; if (iy < 0 || iy >= ny || (stepY > 0 && iy >= skyY)) break; idx += stepY * strideY; tmy += tdy; face = stepY > 0 ? 3 : 2;
          } else {
            iz += stepZ; if (iz < 0 || iz >= nz) break; idx += stepZ * strideZ; tmz += tdz; face = stepZ > 0 ? 5 : 4;
          }
          if (vox[idx] !== 0) { hit = true; break; }
        }
        hits[hb + r] = hit ? aIdx * 8 + face : -(skyIdx(dx, dy, dz) / 3 + 1);
      }
    }
  }

  // Direct (sun + lamp) radiance cache per stored hit code is not kept: faceRadiance uses the visibility caches.
  const L = [0, 0, 0];
  function gather(prev) {
    const rays = nRays, per = pnx * pny * 12;
    const out = new Float32Array(slices.length * per);
    const k0 = Math.PI / rays, k1 = 2 * Math.PI / rays;
    let p = 0;
    for (let si = 0; si < slices.length; si++) for (let pj = 0; pj < pny; pj++) for (let pi = 0; pi < pnx; pi++, p++) {
      const hb = p * rays, o = si * per + (pi + pnx * pj) * 12;
      if (hits[hb] === 0x7fffffff) continue;
      const ju = jit[p * 2], jv = jit[p * 2 + 1];
      let sr = 0, sg = 0, sb = 0, xr = 0, yr = 0, zr = 0, xg = 0, yg = 0, zg = 0, xb = 0, yb = 0, zb = 0;
      for (let r = 0; r < rays; r++) {
        const code = hits[hb + r];
        if (code < 0) { const si3 = (-code - 1) * 3; L[0] = SK[si3]; L[1] = SK[si3 + 1]; L[2] = SK[si3 + 2]; }
        else {
          const aIdx = code >> 3, face = code & 7;
          const az = (aIdx / strideZ) | 0, rem = aIdx - az * strideZ, ay = (rem / strideY) | 0, ax = rem - ay * strideY;
          const sIdx = aIdx + (face === 0 ? -1 : face === 1 ? 1 : face === 2 ? -strideY : face === 3 ? strideY : face === 4 ? -strideZ : strideZ);
          faceRadiance(vox[sIdx], face, aIdx, ax, ay, az, prev, L);
        }
        let lr = L[0], lg = L[1], lb = L[2];
        const m = Math.max(lr, lg, lb);
        if (m > 30) { const k = 30 / m; lr *= k; lg *= k; lb *= k; }      // firefly clamp
        const dy = 1 - 2 * ((r + ju) / rays);
        const rad = Math.sqrt(Math.max(0, 1 - dy * dy));
        const ph = 2 * Math.PI * ((r * GOLD + jv) % 1);
        const dx = rad * Math.cos(ph), dz = rad * Math.sin(ph);
        sr += lr; sg += lg; sb += lb;
        xr += lr * dx; yr += lr * dy; zr += lr * dz;
        xg += lg * dx; yg += lg * dy; zg += lg * dz;
        xb += lb * dx; yb += lb * dy; zb += lb * dz;
      }
      out[o] = sr * k0; out[o + 1] = sg * k0; out[o + 2] = sb * k0;
      out[o + 3] = xr * k1; out[o + 4] = yr * k1; out[o + 5] = zr * k1;
      out[o + 6] = xg * k1; out[o + 7] = yg * k1; out[o + 8] = zg * k1;
      out[o + 9] = xb * k1; out[o + 10] = yb * k1; out[o + 11] = zb * k1;
    }
    return out;
  }

  return { traceSlices, gather, sunVisible, blocked };
}

// ------------------------------------------------------------------------------------------------ post
const probeVoxIdx = (i, j, k) => (i * 2 + PROBE_VOX_OFF[0]) + VOX.nx * ((j * 2 + PROBE_VOX_OFF[1]) + VOX.ny * (k * 2 + PROBE_VOX_OFF[2]));

export function probeValidity(vox) {
  const { nx, ny, nz } = PROBE;
  const valid = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    valid[i + nx * (j + ny * k)] = vox[probeVoxIdx(i, j, k)] === 0 ? 1 : 0;
  }
  return valid;
}

// Separable [1 2 1] blur between valid probes that see each other (the voxel between them is empty).
export function denoise(sh, valid, vox, passes = 1) {
  const { nx, ny, nz } = PROBE;
  const strides = [1, nx, nx * ny];
  const vstr = [1, VOX.nx, VOX.nx * VOX.ny];
  const dims = [nx, ny, nz];
  const tmp = new Float32Array(sh.length);
  const acc = new Float32Array(12);
  for (let p = 0; p < passes; p++) for (let axis = 0; axis < 3; axis++) {
    tmp.set(sh);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k);
      if (!valid[id]) continue;
      const c = axis === 0 ? i : axis === 1 ? j : k;
      let w = 2;
      for (let q = 0; q < 12; q++) acc[q] = tmp[id * 12 + q] * 2;
      for (const dir of [-1, 1]) {
        const cc = c + dir;
        if (cc < 0 || cc >= dims[axis]) continue;
        const nid = id + dir * strides[axis];
        if (!valid[nid]) continue;
        const mid = probeVoxIdx(i, j, k) + dir * vstr[axis];
        if (vox[mid] !== 0) continue;
        for (let q = 0; q < 12; q++) acc[q] += tmp[nid * 12 + q];
        w += 1;
      }
      for (let q = 0; q < 12; q++) sh[id * 12 + q] = acc[q] / w;
    }
  }
}

// Probes inside solids copy the nearest valid probe across the closest solid face, so hardware trilinear
// filtering never mixes light from the far side of a wall (sampling uses a normal offset of ~0.3 m).
export function fillInvalid(sh, valid, vox, cache = null) {
  if (cache && cache.map) {
    const m = cache.map;
    for (let q = 0; q < m.length; q += 2) { const d = m[q] * 12, s0 = m[q + 1] * 12; for (let c = 0; c < 12; c++) sh[d + c] = sh[s0 + c]; }
    return m.length / 2;
  }
  const pairs = [];
  const { nx, ny, nz } = PROBE;
  const V = VOX;
  const vstr = [1, V.nx, V.nx * V.ny], vdim = [V.nx, V.ny, V.nz];
  const pstr = [1, nx, nx * ny], pdim = [nx, ny, nz];
  let filled = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = i + nx * (j + ny * k);
    if (valid[id]) continue;
    const pc = [i, j, k];
    const vc = [i * 2 + PROBE_VOX_OFF[0], j * 2 + PROBE_VOX_OFF[1], k * 2 + PROBE_VOX_OFF[2]];
    const base = probeVoxIdx(i, j, k);
    const cand = [];
    for (let axis = 0; axis < 3; axis++) for (const dir of [-1, 1]) {
      let d = 0, v = vc[axis], idx = base;
      while (d < 24) { v += dir; idx += dir * vstr[axis]; d++; if (v < 0 || v >= vdim[axis]) { d = 99; break; } if (vox[idx] === 0) break; }
      cand.push([d, axis, dir]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    let done = false;
    for (const [d, axis, dir] of cand) {
      if (d >= 99) continue;
      let c = pc[axis], nid = id;
      for (let s = 0; s < 8; s++) {
        c += dir; nid += dir * pstr[axis];
        if (c < 0 || c >= pdim[axis]) break;
        if (valid[nid]) { for (let q = 0; q < 12; q++) sh[id * 12 + q] = sh[nid * 12 + q]; pairs.push(id, nid); done = true; break; }
      }
      if (done) break;
    }
    if (done) filled++;
  }
  if (cache) cache.map = Int32Array.from(pairs);
  return filled;
}
