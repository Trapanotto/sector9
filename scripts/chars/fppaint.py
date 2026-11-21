"""Mesh-driven texture painting for the first-person arms (self-made, CC0).

The CC0 glove / sweater textures are flat. Here every texel of a garment's UV islands is rasterised back onto
the 3D rest mesh (position + normal), and detail is painted from the hand/arm anatomy:
  glove : two-tone tactical glove (dark back, suede palm), moulded knuckle strip, finger pads, side seams with
          stitching, reinforced thumb crotch, wrist cuff with a hook-and-loop tab, fabric grain
  sleeve: navy uniform twill (diagonal weave), flat-felled seam on the underside, cuff band with stitching,
          large-scale folds kept from the source texture
Positions are MakeHuman rest metres; joints from build_character (P = joint heads, tips = finger ends).
"""
import numpy as np
from PIL import Image, ImageFilter


def _srgb(c):
    return np.array(c, dtype=np.float32) / 255.0


def raster(part, size, nrm):
    """Per-texel 3D position / normal / mask of a part's UV islands (rest pose, metres)."""
    w, h = size
    P = np.zeros((h, w, 3), np.float32)
    N = np.zeros((h, w, 3), np.float32)
    M = np.zeros((h, w), bool)
    pos = part.pos * 0.1
    uv = part.uvs
    for vi, ti in part.faces:
        for k in range(1, len(vi) - 1):
            ids = (0, k, k + 1)
            # same mapping as the atlas packing in mhbuild (2 px inset)
            tv = np.array([[2 + np.clip(uv[ti[i]][0], 0, 1) * (w - 4), 2 + (1 - np.clip(uv[ti[i]][1], 0, 1)) * (h - 4)] for i in ids])
            x0, y0 = np.floor(tv.min(0)).astype(int)
            x1, y1 = np.ceil(tv.max(0)).astype(int)
            x0, y0 = max(x0, 0), max(y0, 0)
            x1, y1 = min(x1, w - 1), min(y1, h - 1)
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            a, b, c = tv
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(den) < 1e-12:
                continue
            l0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
            l1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
            l2 = 1 - l0 - l1
            ins = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
            if not ins.any():
                continue
            pv = pos[[vi[i] for i in ids]]
            nv = nrm[[vi[i] for i in ids]]
            L = np.stack([l0, l1, l2], -1)[ins]
            yy, xx = (ys[ins] - 0.5).astype(int), (xs[ins] - 0.5).astype(int)
            P[yy, xx] = L @ pv
            N[yy, xx] = L @ nv
            M[yy, xx] = True
    # dilate into the gutters (mip-map bleeding)
    for _ in range(6):
        grow = ~M
        acc = np.zeros_like(P)
        accn = np.zeros_like(N)
        cnt = np.zeros((h, w), np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            m2 = np.roll(np.roll(M, dy, 0), dx, 1)
            acc += np.roll(np.roll(P, dy, 0), dx, 1) * m2[..., None]
            accn += np.roll(np.roll(N, dy, 0), dx, 1) * m2[..., None]
            cnt += m2
        sel = grow & (cnt > 0)
        P[sel] = acc[sel] / cnt[sel, None]
        N[sel] = accn[sel] / cnt[sel, None]
        M = M | sel
    n = np.linalg.norm(N, axis=-1, keepdims=True)
    N = N / np.maximum(n, 1e-6)
    return P, N, M


def _noise(shape, seed, blur=0.0):
    rng = np.random.default_rng(seed)
    a = rng.normal(0, 1, shape).astype(np.float32)
    if blur:
        im = Image.fromarray(((a * 0.18 + 0.5).clip(0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
        a = (np.asarray(im).astype(np.float32) / 255 - 0.5) / 0.18
        a /= max(a.std(), 1e-6)
    return a


def _seg_dist(p, a, b):
    """distance of points p (...,3) to segment a-b, and the segment parameter"""
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(p - (a + t[..., None] * ab), axis=-1), t


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


FINGERS = ('index', 'middle', 'ring', 'pinky')


def _hand_frame(P, tips, s):
    W = P[f'hand_{s}']
    f = P[f'middle_01_{s}'] - W
    f /= np.linalg.norm(f)
    side = P[f'index_01_{s}'] - P[f'pinky_01_{s}']
    side -= f * (side @ f)
    side /= np.linalg.norm(side)
    n = np.cross(f, side)
    th = P[f'thumb_01_{s}'] - W
    if th @ n < 0:  # palm side = where the thumb base sits
        n = -n
    return W, f, side, n


def paint_glove(part, size, nrm, P, tips, spec):
    Pm, Nm, M = raster(part, size, nrm)
    h, w = M.shape
    base = _srgb(spec.get('back', (66, 66, 60)))
    palm_c = _srgb(spec.get('palm', (104, 94, 76)))
    pad_c = _srgb(spec.get('pad', (30, 30, 31)))
    stitch_c = _srgb(spec.get('stitch', (128, 124, 110)))
    out = np.tile(base, (h, w, 1))
    shade = np.ones((h, w), np.float32)
    lsign = 1.0 if P['hand_l'][0] > 0 else -1.0
    for s in ('l', 'r'):
        sel = (Pm[..., 0] * lsign > 0) if s == 'l' else (Pm[..., 0] * lsign <= 0)
        sel &= M
        if not sel.any():
            continue
        W, f, side, n = _hand_frame(P, tips, s)
        p, nn = Pm[sel], Nm[sel]
        t = (p - W) @ f                 # along the hand (m), 0 at the wrist joint
        lat = (p - W) @ side            # across the knuckles (thumb side +)
        palmness = nn @ n               # +1 palm, -1 back
        col = np.tile(base, (len(p), 1))
        sh = np.ones(len(p), np.float32)
        # suede palm + palm side of the fingers
        kp = _smoothstep(0.05, 0.3, palmness)
        col = col * (1 - kp[:, None]) + palm_c * kp[:, None]
        # nearest finger bone segment (for pads / seams / creases)
        best = np.full(len(p), 9.0, np.float32)
        best_k = np.zeros(len(p), np.int32)
        best_t = np.zeros(len(p), np.float32)
        segs = []
        for fi, fn in enumerate(FINGERS + ('thumb',)):
            pts = [P[f'{fn}_01_{s}'], P[f'{fn}_02_{s}'], P[f'{fn}_03_{s}'], tips.get(f'{fn}_03_{s}', P[f'{fn}_03_{s}'])]
            for k in range(3):
                d, tt = _seg_dist(p, pts[k], pts[k + 1])
                m = d < best
                best[m], best_k[m], best_t[m] = d[m], fi * 3 + k, tt[m]
                segs.append((fi, k))
        on_finger = best < 0.016
        fidx, phal = best_k // 3, best_k % 3
        # moulded knuckle strip (back of the hand over the MCP joints) + pads on the proximal phalanges
        tm = np.mean([(P[f'{fn}_01_{s}'] - W) @ f for fn in FINGERS])
        latmin = min((P[f'{fn}_01_{s}'] - W) @ side for fn in FINGERS) - 0.012
        latmax = max((P[f'{fn}_01_{s}'] - W) @ side for fn in FINGERS) + 0.012
        back = _smoothstep(0.1, 0.45, -palmness)
        strip = back * _smoothstep(0.016, 0.011, np.abs(t - tm + 0.004)) * _smoothstep(latmin - 0.004, latmin + 0.002, lat) * _smoothstep(latmax + 0.004, latmax - 0.002, lat)
        # segment the strip per knuckle (small gaps between)
        kl = np.array([(P[f'{fn}_01_{s}'] - W) @ side for fn in FINGERS])
        mids = (kl[:-1] + kl[1:]) / 2
        gap = np.ones(len(p), np.float32)
        for mv in mids:
            gap *= _smoothstep(0.0012, 0.003, np.abs(lat - mv))
        strip *= 0.35 + 0.65 * gap
        pad = back * (on_finger & (fidx < 4) & (phal == 0)).astype(np.float32) * _smoothstep(0.25, 0.45, best_t) * _smoothstep(0.95, 0.75, best_t)
        hard = np.clip(strip + pad, 0, 1)
        col = col * (1 - hard[:, None]) + pad_c * hard[:, None]
        sh *= 1 + 0.25 * hard * _smoothstep(0.4, 0.9, -palmness)   # raised rubber catches light on top
        # pad rims (dark outline where the rubber meets the fabric)
        rim = np.clip(hard * (1 - hard) * 4, 0, 1)
        sh *= 1 - 0.35 * rim
        # side seams with stitching along the fingers (palm/back boundary)
        seam = on_finger * _smoothstep(0.12, 0.03, np.abs(palmness - 0.1))
        dash = (np.sin((t + lat * 0.3) * 2 * np.pi / 0.0032) > 0.1).astype(np.float32)
        col = col * (1 - (seam * 0.6)[:, None]) + stitch_c * (seam * 0.6 * dash)[:, None]
        sh *= 1 - 0.25 * seam * (1 - dash)
        # joint creases on the palm side and fabric wrinkles on the back over the finger joints
        crease = np.zeros(len(p), np.float32)
        for k in (0, 1):
            crease += (phal == k + 1) * _smoothstep(0.12, 0.0, best_t) + (phal == k) * _smoothstep(0.88, 1.0, best_t)
        crease *= on_finger
        sh *= 1 - 0.3 * np.clip(crease, 0, 1)
        # fingertips: worn, slightly darker
        tipm = (phal == 2) * _smoothstep(0.55, 0.9, best_t) * on_finger
        sh *= 1 - 0.18 * tipm
        # reinforced thumb crotch (palm side between thumb and index)
        th0, ix0 = P[f'thumb_01_{s}'], P[f'index_01_{s}']
        dcr, _ = _seg_dist(p, th0, ix0)
        cr = _smoothstep(0.02, 0.012, dcr) * _smoothstep(-0.1, 0.2, palmness)
        col = col * (1 - (cr * 0.7)[:, None]) + pad_c * 1.6 * (cr * 0.7)[:, None]
        # wrist cuff: band + hook-and-loop tab on the back
        cuff = _smoothstep(0.006, -0.002, t)
        col = col * (1 - (cuff * 0.85)[:, None]) + (pad_c * 1.25) * (cuff * 0.85)[:, None]
        cuff_edge = _smoothstep(0.0025, 0.0, np.abs(t - 0.006))
        sh *= 1 - 0.3 * cuff_edge
        tab = cuff * back * _smoothstep(0.016, 0.012, np.abs(lat - (kl.mean())))
        col = col * (1 - (tab * 0.8)[:, None]) + _srgb((44, 44, 44)) * (tab * 0.8)[:, None]
        out[sel] = col
        shade[sel] = sh
    # fabric grain (fine) + mottling (coarse)
    g = _noise((h, w), 11) * 0.045 + _noise((h, w), 12, blur=6) * 0.05
    weave = np.sin(np.arange(w)[None, :] * 1.9) * np.sin(np.arange(h)[:, None] * 1.9) * 0.025
    out = out * (shade * (1 + g + weave))[..., None]
    out = np.clip(out, 0, 1)
    im = Image.fromarray((out * 255).astype(np.uint8), 'RGB').convert('RGBA')
    return im


def paint_sleeve(part, size, nrm, P, tips, spec, src=None):
    Pm, Nm, M = raster(part, size, nrm)
    h, w = M.shape
    base = _srgb(spec.get('color', (30, 36, 52)))
    out = np.tile(base, (h, w, 1))
    shade = np.ones((h, w), np.float32)
    # large-scale folds from the source texture (blurred: no knit pattern)
    if src is not None:
        a = np.asarray(src.convert('L').resize((w, h))).astype(np.float32) / 255
        a = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10))).astype(np.float32) / 255
        med = float(np.median(a[M])) if M.any() else 0.5
        shade *= np.clip(1 + (a / max(med, 1e-3) - 1) * 0.6, 0.6, 1.3)
    lsign = 1.0 if P['hand_l'][0] > 0 else -1.0
    for s in ('l', 'r'):
        sel = ((Pm[..., 0] * lsign > 0) if s == 'l' else (Pm[..., 0] * lsign <= 0)) & M
        if not sel.any():
            continue
        Wr, El, Sh = P[f'hand_{s}'], P[f'lowerarm_{s}'], P[f'upperarm_{s}']
        p, nn = Pm[sel], Nm[sel]
        axis = Wr - El
        L = np.linalg.norm(axis)
        axis /= L
        t = (p - El) @ axis                    # along the forearm, wrist at L
        dwr = L - t                            # distance from the wrist (m)
        sh = np.ones(len(p), np.float32)
        # underside seam: the side of the sleeve facing the body (towards the pelvis/side)
        down = np.array([0.0, -1.0, 0.0])
        rad = p - (El + np.clip(t, -1, 2)[:, None] * axis)
        rad -= axis * (rad @ axis)[:, None]
        rad /= np.maximum(np.linalg.norm(rad, axis=1, keepdims=True), 1e-6)
        under = rad @ (down - axis * (down @ axis))
        seam = _smoothstep(0.985, 0.998, under)
        sh *= 1 - 0.35 * seam
        sh *= 1 + 0.12 * _smoothstep(0.96, 0.985, under) * (1 - seam)
        # cuff band (4 cm), stitched edge
        cuff = _smoothstep(0.05, 0.043, dwr)
        sh *= 1 - 0.12 * cuff
        st = _smoothstep(0.0015, 0.0, np.abs(dwr - 0.045)) * (np.sin(np.arctan2(rad[:, 2], rad[:, 0]) * 70) > 0)
        sh *= 1 + 0.35 * st
        edge = _smoothstep(0.004, 0.0, np.abs(dwr - 0.05))
        sh *= 1 - 0.25 * edge
        # creases near the elbow / wrist (bunching)
        bunch = _smoothstep(0.08, 0.0, np.abs(dwr - 0.075)) * (np.sin(t * 2 * np.pi / 0.018 + rad[:, 0] * 3) * 0.5 + 0.5)
        sh *= 1 - 0.12 * bunch
        shade[sel] *= sh
    # twill: fine diagonal weave in texture space + grain
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    tw = np.sin((xx + yy) * 2 * np.pi / 3.2) * 0.05 + np.sin((xx - yy) * 2 * np.pi / 9.0) * 0.015
    g = _noise((h, w), 21) * 0.035 + _noise((h, w), 22, blur=8) * 0.05
    out = out * (shade * (1 + tw + g))[..., None]
    out = np.clip(out, 0, 1)
    return Image.fromarray((out * 255).astype(np.uint8), 'RGB').convert('RGBA')


def paint(kind, part, size, nrm, P, tips, spec, src=None):
    if kind == 'glove':
        return paint_glove(part, size, nrm, P, tips, spec)
    if kind == 'sleeve':
        return paint_sleeve(part, size, nrm, P, tips, spec, src)
    raise ValueError(kind)


def fit_gap(pos_dm, surf_dm, gap_m=0.004, keep=0.35):
    """Pull a loose garment towards the body: distance to the nearest body vertex d -> gap + keep*(d - gap)."""
    out = pos_dm.copy()
    g = gap_m * 10
    for a in range(0, len(pos_dm), 512):
        p = pos_dm[a:a + 512]
        d2 = ((p[:, None, :] - surf_dm[None, :, :]) ** 2).sum(-1)
        k = d2.argmin(1)
        q = surf_dm[k]
        v = p - q
        d = np.linalg.norm(v, axis=1)
        nd = np.where(d > g, g + keep * (d - g), d)
        out[a:a + 512] = q + v * (nd / np.maximum(d, 1e-9))[:, None]
    return out
