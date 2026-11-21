"""Builds a skinned character (MakeHuman body + clothes) bound to the shared UAL skeleton.

The MakeHuman mesh is first re-posed (linear blend skinning with the MakeHuman weights) so that
every bone points exactly like the UAL rest pose; then it is bound to a skeleton whose joints sit
at the MakeHuman joint positions but whose rest *orientations* are the UAL ones. UAL clips can
therefore be played unchanged (only the pelvis translation is rescaled once, see build_anims).
"""
import io
import os

import numpy as np
from PIL import Image, ImageFilter

import charspec
import glbio
import mhlib

H_REF = 0.98  # reference pelvis height (m) of the shared animation set; variants use root scale


# ----------------------------------------------------------------------------- UAL rest pose
class UalRest:
    def __init__(self, ual2_glb):
        js, _ = glbio.read_glb(ual2_glb)
        world, parent, local = glbio.node_world(js)
        self.R, self.P, self.local = {}, {}, {}
        for i, n in enumerate(js['nodes']):
            name = n.get('name')
            self.R[name] = world[i][:3, :3].copy()
            self.P[name] = world[i][:3, 3].copy()
            self.local[name] = n
        self.pelvis_local_t = np.array(js['nodes'][self._idx(js, 'pelvis')]['translation'])

    @staticmethod
    def _idx(js, name):
        for i, n in enumerate(js['nodes']):
            if n.get('name') == name:
                return i
        raise KeyError(name)


# ----------------------------------------------------------------------------- texture helpers
def load_rgba(path):
    im = Image.open(path)
    if im.mode == 'P':
        im = im.convert('RGBA')
    return im.convert('RGBA')


def tint(im, spec):
    """Recolour a texture while keeping its shading detail.

    spec: None | dict(color=(r,g,b), detail=0..1, flatten=radius, gain=float)."""
    if not spec:
        return im
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    opaque = alpha[..., 0] > 0.5
    if opaque.any() and not opaque.all():
        lum = np.where(opaque, lum, float(np.median(lum[opaque])))  # transparent texels are often white
    if spec.get('flatten'):
        # remove prints/logos: keep only large-scale shading (folds/AO)
        L = Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(spec['flatten']))
        lum = np.asarray(L).astype(np.float32) / 255.0
    m = float(np.median(lum[alpha[..., 0] > 0.5])) if (alpha > 0.5).any() else float(lum.mean())
    rel = lum / max(m, 1e-3)
    d = spec.get('detail', 0.8)
    rel = 1 + (rel - 1) * d
    col = np.array(spec['color'], dtype=np.float32) / 255.0
    out = np.clip(col[None, None, :] * rel[..., None] * spec.get('gain', 1.0), 0, 1)
    if spec.get('noise'):
        rng = np.random.default_rng(7)
        n = rng.normal(0, spec['noise'], lum.shape).astype(np.float32)
        out = np.clip(out * (1 + n[..., None]), 0, 1)
    return Image.fromarray((np.concatenate([out, alpha], -1) * 255).astype(np.uint8), 'RGBA')


def multiply_ao(im, ao_path, strength=0.8):
    if not ao_path or not os.path.exists(ao_path):
        return im
    ao = Image.open(ao_path).convert('L').resize(im.size, Image.BILINEAR)
    a = np.asarray(im).astype(np.float32)
    o = np.asarray(ao).astype(np.float32)[..., None] / 255.0
    a[..., :3] *= (1 - strength) + strength * o
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def vertex_normals(part):
    vn = np.zeros_like(part.pos)
    for vi, _ in part.faces:
        p = part.pos[vi]
        n = np.cross(p[1] - p[0], p[-1] - p[0])
        vn[vi] += n
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def uv_mask(part, vsel, size, blur=0.003):
    """L-mode mask (texture space) covering the UV polygons of faces whose vertices all satisfy vsel."""
    from PIL import ImageDraw
    w, h = size
    m = Image.new('L', size, 0)
    d = ImageDraw.Draw(m)
    for vi, ti in part.faces:
        if all(vsel[v] for v in vi):
            pts = [(part.uvs[t][0] * w, (1 - part.uvs[t][1]) * h) for t in ti]
            d.polygon(pts, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(w * blur))
    return m


# ----------------------------------------------------------------------------- mesh part
class Part:
    def __init__(self, name, pos, faces, uvs, weights, tex, rect, cull=None):
        self.name, self.pos, self.faces, self.uvs, self.W = name, pos, faces, uvs, weights
        self.tex, self.rect = tex, rect
        self.cull = cull  # optional boolean mask of vertices to drop


def part_from_proxy(name, proxy, base_v, Wbase, tex, rect, cull=None, surface=None):
    pos = proxy.fit(base_v)
    if surface is None:
        W = mhlib.proxy_weights(proxy, Wbase)
    else:
        W = transfer_weights(pos, *surface)
    return Part(name, pos, proxy.obj.faces, proxy.obj.vt, W, tex, rect, cull)


def transfer_weights(pos, sv, sw, k=6):
    """Skin weights from the nearest body-surface vertices (inverse-distance weighted).

    MakeHuman clothes reference helper geometry with negative barycentric weights; inheriting
    weights through those references drags e.g. shoe heels with the calf. Nearest-surface
    transfer is what DCC tools do and is robust for every garment."""
    out = np.zeros((len(pos), sw.shape[1]))
    for a in range(0, len(pos), 1024):
        p = pos[a:a + 1024]
        d2 = ((p[:, None, :] - sv[None, :, :]) ** 2).sum(-1)
        idx = np.argpartition(d2, k, axis=1)[:, :k]
        dd = np.take_along_axis(d2, idx, 1)
        w = 1.0 / (np.sqrt(dd) + 1e-4) ** 2
        w /= w.sum(1, keepdims=True)
        out[a:a + 1024] = (sw[idx] * w[..., None]).sum(1)
    return out


# ----------------------------------------------------------------------------- build
def build_character(cfg, cache, ual, bones, full_hands, atlas_size=1024, keep_parts=None):
    core = os.path.join(cache, 'mh_core')
    base = mhlib.Obj(os.path.join(core, '3dobjs', 'base.obj'))
    tg = mhlib.macro_targets(core, cfg['gender'], cfg['race'], cfg['muscle'], cfg['weight'], cfg['height'], cfg.get('proportions', 0.5))
    bv = mhlib.apply_targets(base.v, tg)
    skel = mhlib.MHSkeleton(core)
    names = [b for b, _ in bones]
    parent = {b: p for b, p in bones}
    Wbase = mhlib.base_weights(skel, len(bv), charspec.mh_bone_map(full_hands), names)

    # body surface (no helper geometry) for clothing weight transfer
    body_vidx = np.unique(np.concatenate([np.array(f[0]) for f, g in zip(base.faces, base.fgroups) if g == 'body']))
    surface = (bv[body_vidx], Wbase[body_vidx])

    # ---- clothes, hidden body vertices
    parts = []
    deleted = np.zeros(len(bv), dtype=bool)
    atlas = Image.new('RGBA', (atlas_size, atlas_size), (128, 128, 128, 255))
    alpha_used = False
    for item in cfg['items']:
        px = mhlib.Proxy(os.path.join(cache, item['mhclo']))
        if item.get('hide_body', True):
            deleted[np.array(px.delete, dtype=np.int64)] = True
        tex_path = item.get('texture') or px.diffuse_texture()
        im = load_rgba(os.path.join(cache, tex_path) if item.get('texture') else tex_path)
        if item.get('ao'):
            im = multiply_ao(im, tex_path.replace('_diffuse', '_ao'), item.get('ao'))
        im = tint(im, item.get('tint'))
        part = part_from_proxy(px.name, px, bv, Wbase, im, item['rect'], surface=surface)
        for rt in item.get('region_tints', []):
            # recolour only the UV islands of faces whose vertices satisfy a height test
            # (e.g. the shirt of a shirt+jeans suit); heights relative to the hip joint, metres
            hip = skel.head(bv, 'root')[1]
            rel = (part.pos[:, 1] - hip) * 0.1
            if 'notblue_above' in rt:
                # UV islands above a height, minus denim-blue texels (shirt+jeans share islands at the waist)
                isl = np.asarray(uv_mask(part, rel > rt['notblue_above'], im.size, blur=0)).astype(np.float32) / 255
                a = np.asarray(im.convert('RGB')).astype(np.float32) / 255
                blue = (a[..., 2] > a[..., 0] + 0.06)
                m = (isl * (~blue)) * 255
                mask = Image.fromarray(m.astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.0))
            else:
                sel = (rel > rt['above']) if 'above' in rt else (rel < rt['below'])
                mask = uv_mask(part, sel, im.size)
            im = Image.composite(tint(im, rt['tint']), im, mask)
        part.tex = im
        if item.get('alpha'):
            alpha_used = True
        else:
            im.putalpha(255)
        part.tex = im
        if item.get('clip_y') is not None:
            # keep only geometry above a height relative to the head joint (e.g. hood -> beanie)
            hy = skel.head(bv, 'head')[1] + item['clip_y'] * 10
            part.cull = part.pos[:, 1] < hy
        if item.get('offset'):
            part.pos = part.pos + vertex_normals(part) * item['offset'] * 10
        if item.get('inflate'):
            c = (skel.head(bv, 'head') + skel.tail(bv, 'head')) / 2
            part.pos = c + (part.pos - c) * (1 + item['inflate'])
        parts.append((item, part))

    body = mhlib.Proxy(os.path.join(cache, cfg['proxy']))
    skin = load_rgba(os.path.join(cache, cfg['skin']))
    skin.putalpha(255)
    bpart = part_from_proxy('body', body, bv, Wbase, skin, cfg['skin_rect'])
    if cfg.get('buzzcut'):
        # short hair painted on the scalp: mask the UV islands of scalp faces (mesh-driven)
        hj = skel.head(bv, 'head')
        rel = (bpart.pos - hj) * 0.1
        zc = rel[:, 2]
        scalp = (rel[:, 1] > 0.095) | ((rel[:, 1] > 0.035) & (zc < 0.03)) | ((rel[:, 1] > -0.01) & (zc < -0.03))
        mask = uv_mask(bpart, scalp, skin.size, blur=0.004)
        col = Image.new('RGBA', skin.size, tuple(cfg['buzzcut']) + (255,))
        hair = tint(col, dict(color=cfg['buzzcut'], detail=0.0, noise=0.35))
        bpart.tex = Image.composite(hair, skin, mask)
    # a body vertex is hidden when any of its reference vertices is covered by clothes
    bpart.cull = deleted[body.refs].any(1) if cfg.get('cull_any', True) else         deleted[body.refs[np.arange(len(body.refs)), body.w.argmax(1)]]
    parts.insert(0, ({'name': 'body'}, bpart))

    # ---- joint positions (MakeHuman rest, metres)
    s10 = 0.1

    def jp(srcs):
        return np.mean([(skel.head(bv, b) if k == 'head' else skel.tail(bv, b)) for k, b in srcs], 0) * s10

    P = {}
    for b in names:
        src = charspec.mh_joint_sources(b)
        if src:
            P[b] = jp(src)
    # extra MakeHuman references used for orientation
    extra = {}
    for s in ('l', 'r'):
        S = charspec.mh_side(s)
        extra[f'index_01_{s}'] = jp([('head', f'finger2-1.{S}')])
        extra[f'pinky_01_{s}'] = jp([('head', f'finger5-1.{S}')])
        extra[f'middle_01_{s}'] = jp([('head', f'finger3-1.{S}')])
    tips = {}
    for b in names:
        t = charspec.mh_tip_sources(b)
        if t:
            tips[b] = jp(t)

    children = {b: [c for c, p in bones if p == b] for b in names}
    main_child = {'pelvis': 'spine_01', 'spine_03': 'neck_01'}
    for s in ('l', 'r'):
        main_child[f'hand_{s}'] = f'middle_01_{s}'

    # ---- per-bone world delta rotation (MH rest -> UAL rest directions)
    D, NP = {}, {}
    for b in names:
        p = parent[b]
        if p is None:
            D[b] = np.eye(3)
            continue
        Dp = D[p] if p != 'root' else np.eye(3)
        child = main_child.get(b) or (children[b][0] if children[b] else None)
        if child is not None:
            tgt_mh = P.get(child, extra.get(child))
            d_mh = tgt_mh - P[b]
            d_ual = ual.P[child] - ual.P[b]
        else:
            d_mh = tips[b] - P[b]
            d_ual = ual.R[b][:, 1]
        d_mh = d_mh / np.linalg.norm(d_mh)
        d_ual = d_ual / np.linalg.norm(d_ual)
        if b.startswith('hand_'):
            s = b[-1]
            sec_mh = extra[f'index_01_{s}'] - extra[f'pinky_01_{s}']
            sec_ual = ual.P[f'index_01_{s}'] - ual.P[f'pinky_01_{s}']

            def frame(d, sv):
                sv = sv - d * np.dot(sv, d)
                sv /= np.linalg.norm(sv)
                return np.stack([d, sv, np.cross(d, sv)], 1)
            D[b] = frame(d_ual, sec_ual) @ frame(d_mh, sec_mh).T
        else:
            D[b] = glbio.min_arc(Dp @ d_mh, d_ual) @ Dp
    # FK of new joint positions
    for b in names:
        p = parent[b]
        if p is None:
            continue
        if p == 'root':
            NP[b] = P[b].copy()
        else:
            NP[b] = NP[p] + D[p] @ (P[b] - P[p])

    # ---- assemble geometry, repose by LBS
    col = {b: i for i, b in enumerate(names)}
    out_pos, out_nrm, out_uv, out_j, out_w, out_idx = [], [], [], [], [], []
    voff = 0
    stats = {}
    for item, part in parts:
        if keep_parts and part.name not in keep_parts and item.get('name') not in keep_parts:
            continue
        pos = part.pos * s10
        Wp = part.W
        # LBS repose
        newpos = np.zeros_like(pos)
        for b in names:
            if b == 'root':
                continue
            w = Wp[:, col[b]]
            m = w > 0
            if not m.any():
                continue
            newpos[m] += w[m, None] * ((pos[m] - P[b]) @ D[b].T + NP[b])
        ws = Wp.sum(1)
        newpos[ws == 0] = pos[ws == 0]
        # faces -> triangles, unique (v, vt) corners
        cull = part.cull
        corner_map = {}
        vlist, tlist = [], []
        tris = []
        for vi, ti in part.faces:
            if cull is not None and any(cull[v] for v in vi):
                continue
            ids = []
            for v, t in zip(vi, ti):
                key = (v, t)
                k = corner_map.get(key)
                if k is None:
                    k = len(vlist)
                    corner_map[key] = k
                    vlist.append(v)
                    tlist.append(t)
                ids.append(k)
            for i in range(1, len(ids) - 1):
                tris.append((ids[0], ids[i], ids[i + 1]))
        if not tris:
            continue
        vlist = np.array(vlist)
        tlist = np.array(tlist)
        tris = np.array(tris, dtype=np.int64)
        # smooth normals on position index (ignores UV seams)
        fn = np.cross(newpos[vlist[tris[:, 1]]] - newpos[vlist[tris[:, 0]]], newpos[vlist[tris[:, 2]]] - newpos[vlist[tris[:, 0]]])
        vn = np.zeros_like(newpos)
        for k in range(3):
            np.add.at(vn, vlist[tris[:, k]], fn)
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        uv = part.uvs[tlist] if len(part.uvs) else np.zeros((len(vlist), 2))
        if (uv < -0.01).any() or (uv > 1.01).any():
            print(f'  warn: {part.name} uv out of range [{uv.min():.2f},{uv.max():.2f}] -> clamped')
        uv = np.clip(uv, 0, 1)
        x, y, w, h = part.rect
        pad = 2
        u2 = (x + pad + uv[:, 0] * (w - 2 * pad)) / atlas_size
        v2 = (y + pad + (1 - uv[:, 1]) * (h - 2 * pad)) / atlas_size
        atlas.paste(part.tex.resize((w, h), Image.LANCZOS), (x, y))
        # top-4 influences
        Wv = Wp[vlist]
        order = np.argsort(-Wv, axis=1)[:, :4]
        wv = np.take_along_axis(Wv, order, 1)
        wv /= np.maximum(wv.sum(1, keepdims=True), 1e-9)
        out_pos.append(newpos[vlist])
        out_nrm.append(vn[vlist])
        out_uv.append(np.stack([u2, v2], 1))
        out_j.append(order)
        out_w.append(wv)
        out_idx.append(tris + voff)
        voff += len(vlist)
        stats[part.name] = len(tris)
    pos = np.concatenate(out_pos)
    # ground: lowest vertex at y = 0
    ground = pos[:, 1].min()
    pos[:, 1] -= ground
    for b in NP:
        NP[b] = NP[b] - np.array([0, ground, 0])
    root_pos = np.array([NP['pelvis'][0], 0.0, NP['pelvis'][2]])
    pelvis_h = NP['pelvis'][1]
    scale = pelvis_h / H_REF
    geo = dict(pos=pos, nrm=np.concatenate(out_nrm), uv=np.concatenate(out_uv), joints=np.concatenate(out_j),
               weights=np.concatenate(out_w), idx=np.concatenate(out_idx))
    rig = dict(names=names, parent=parent, NP=NP, root_pos=root_pos, scale=scale, R={b: ual.R[b] for b in names})
    return geo, rig, atlas, alpha_used, stats


def joint_world(rig):
    """World bind matrices (4x4) for every joint, including the uniform root scale."""
    out = {}
    for b in rig['names']:
        m = np.eye(4)
        m[:3, :3] = rig['R'][b] * rig['scale']
        m[:3, 3] = rig['root_pos'] if b == 'root' else rig['NP'][b]
        out[b] = m
    return out


def write_glb(path, geo, rig, atlas, alpha_used, name, extras=None, extra_nodes=None):
    g = glbio.GlbWriter()
    js = g.js
    names = rig['names']
    world = joint_world(rig)
    nodes = [{'name': name, 'children': []}]
    js['nodes'] = nodes
    mesh_node = len(nodes)
    nodes.append({'name': name + '_mesh', 'mesh': 0, 'skin': 0})
    nodes[0]['children'].append(mesh_node)
    jidx = {}
    for b in names:
        jidx[b] = len(nodes)
        nodes.append({'name': b})
    for b in names:
        p = rig['parent'][b]
        n = nodes[jidx[b]]
        if p is None:
            nodes[0]['children'].append(jidx[b])
            local = world[b]
        else:
            nodes[jidx[p]].setdefault('children', []).append(jidx[b])
            local = np.linalg.inv(world[p]) @ world[b]
        t = local[:3, 3]
        r = local[:3, :3]
        sc = np.linalg.norm(r[:, 0])
        q = glbio.mat_to_quat(r / sc)
        n['translation'] = [float(x) for x in t]
        n['rotation'] = [float(x) for x in q]
        if abs(sc - 1) > 1e-6:
            n['scale'] = [float(sc)] * 3
    for en in (extra_nodes or []):
        idx = len(nodes)
        nodes.append({k: v for k, v in en.items() if k != 'parent'})
        nodes[jidx[en['parent']]].setdefault('children', []).append(idx)
    ibm = np.stack([np.linalg.inv(world[b]).T.reshape(-1) for b in names]).astype(np.float32)
    js['skins'] = [{'name': 'UAL', 'joints': [jidx[b] for b in names], 'skeleton': jidx['root'],
                    'inverseBindMatrices': g.add_accessor(ibm, 'MAT4', 5126)}]
    ARRAY, ELEM = 34962, 34963
    attrs = {
        'POSITION': g.add_accessor(geo['pos'].astype(np.float32), 'VEC3', 5126, ARRAY, minmax=True),
        'NORMAL': g.add_accessor(geo['nrm'].astype(np.float32), 'VEC3', 5126, ARRAY),
        'TEXCOORD_0': g.add_accessor(geo['uv'].astype(np.float32), 'VEC2', 5126, ARRAY),
        'JOINTS_0': g.add_accessor(geo['joints'].astype(np.uint8), 'VEC4', 5121, ARRAY),
        'WEIGHTS_0': g.add_accessor(geo['weights'].astype(np.float32), 'VEC4', 5126, ARRAY),
    }
    nv = len(geo['pos'])
    idx = g.add_accessor(geo['idx'].reshape(-1, 1).astype(np.uint16 if nv < 65536 else np.uint32), 'SCALAR',
                         5123 if nv < 65536 else 5125, ELEM)
    js['meshes'] = [{'name': name, 'primitives': [{'attributes': attrs, 'indices': idx, 'material': 0}]}]
    buf = io.BytesIO()
    atlas.save(buf, 'PNG')
    g.add_image(buf.getvalue(), 'image/png')
    js['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}]
    js['textures'] = [{'sampler': 0, 'source': 0}]
    mat = {'name': name + '_mat', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0.0,
                                                          'roughnessFactor': 0.85}}
    if alpha_used:
        mat['alphaMode'] = 'MASK'
        mat['alphaCutoff'] = 0.5
    js['materials'] = [mat]
    js['scenes'] = [{'nodes': [0]}]
    js['scene'] = 0
    if extras:
        nodes[0]['extras'] = extras
    g.save(path)
