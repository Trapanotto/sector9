"""Downloads CC0 prop models from Poly Haven (https://polyhaven.com) and prepares them for the web.

Usage (from the repo root):  python -I scripts/models-assets.py [--force]

- Source: the glTF 1k variant of each model (https://api.polyhaven.com/files/<id>), plus optional
  alternative texture sets ("variants") that Poly Haven ships for some models.
- Raw downloads are cached in <tmp>/sector9-models-cache (override with env MODELS_CACHE); files already
  present are not downloaded again, outputs already present are not rebuilt (unless --force).
- Textures are converted to WebP with Pillow at 1024 or 512 px; the glTF JSON is rewritten to the .webp
  URIs and gets an occlusionTexture pointing at the ARM map (R = AO) when the source has none.
- Output: public/assets/models/<id>/<id>.gltf + .bin + *.webp and public/assets/models/manifest.json.
"""
import json
import os
import sys
import tempfile
import urllib.request
from io import BytesIO

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'models')
CACHE = os.environ.get('MODELS_CACHE') or os.path.join(tempfile.gettempdir(), 'sector9-models-cache')
API = 'https://api.polyhaven.com/files/'
UA = {'User-Agent': 'asset-fetch-script'}
FORCE = '--force' in sys.argv

# id: Poly Haven asset id; size: max texture size; variants: extra texture sets (diff/nor/arm) to ship.
# tris: triangle budget after decimation (instanced clutter must stay cheap; shadow passes multiply it).
MODELS = [
    {'id': 'Barrel_01', 'size': 1024, 'tris': 1800, 'variants': ['oxide_green', 'oxide_grey'], 'use': 'steel oil drums'},
    {'id': 'Barrel_02', 'size': 512, 'tris': 1600, 'use': 'blue plastic drums'},
    {'id': 'metal_office_desk', 'size': 1024, 'tris': 3500, 'use': 'office desks'},
    {'id': 'SchoolChair_01', 'size': 512, 'tris': 2000, 'use': 'office / control room chairs'},
    {'id': 'plastic_monobloc_chair_01', 'size': 512, 'tris': 1600, 'use': 'chairs in yard / locker room'},
    {'id': 'steel_frame_shelves_01', 'size': 1024, 'tris': 3000, 'use': 'storage shelving'},
    {'id': 'worn_metal_rack', 'size': 512, 'tris': 3000, 'use': 'office wall racks'},
    {'id': 'metal_tool_chest', 'size': 1024, 'tris': 3500, 'use': 'tool chests at the workbench'},
    {'id': 'old_tyre', 'size': 512, 'tris': 1200, 'use': 'tyres in yard and bay'},
    {'id': 'cement_bag', 'size': 512, 'use': 'cement sack piles'},
    {'id': 'WetFloorSign_01', 'size': 512, 'use': 'wet floor sign in corridor'},
    {'id': 'Television_01', 'size': 512, 'use': 'old CRT monitors on desks / consoles'},
    {'id': 'plastic_crate_02', 'size': 512, 'tris': 1400, 'use': 'stackable plastic crates'},
    {'id': 'propane_tank', 'size': 512, 'tris': 1200, 'use': 'gas bottles'},
    {'id': 'trashbag', 'size': 512, 'tris': 1200, 'use': 'rubbish bags'},
    {'id': 'can_rusted', 'size': 512, 'tris': 300, 'use': 'rusty paint cans (clutter)'},
    {'id': 'bench_vice_01', 'size': 512, 'tris': 1200, 'use': 'vice on the workbench'},
    {'id': 'sledgehammer_01', 'size': 512, 'tris': 800, 'use': 'tool leaning on the bench'},
    {'id': 'Drill_01', 'size': 512, 'tris': 800, 'use': 'cordless drill on the bench'},
    {'id': 'plastic_jerrycan', 'size': 512, 'tris': 1200, 'use': 'jerry cans'},
    {'id': 'hand_truck', 'size': 512, 'tris': 3000, 'use': 'sack truck in the bay'},
    {'id': 'utility_box_01', 'size': 512, 'tris': 1500, 'use': 'electrical boxes'},
]


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def cached(url, rel):
    p = os.path.join(CACHE, rel)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return open(p, 'rb').read()
    data = get(url)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data)
    return data


def kind_of(name):
    n = name.lower()
    if 'nor' in n:
        return 'nor'
    if 'arm' in n or 'rough' in n or 'metal' in n or '_ao' in n:
        return 'arm'
    return 'diff'


def to_webp(data, size, kind, alpha):
    im = Image.open(BytesIO(data))
    im = im.convert('RGBA' if alpha else 'RGB')
    if max(im.size) > size:
        s = size / max(im.size)
        im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
    q = {'diff': 80, 'nor': 88, 'arm': 80}[kind]
    out = BytesIO()
    im.save(out, 'WEBP', quality=q, method=6)
    return out.getvalue()


COMP = {5126: ('f4', 4), 5123: ('u2', 2), 5125: ('u4', 4), 5121: ('u1', 1)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_acc(g, bin_data, i):
    a = g['accessors'][i]
    bv = g['bufferViews'][a['bufferView']]
    dt, size = COMP[a['componentType']]
    n = NCOMP[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0) or size * n
    if stride == size * n:
        out = np.frombuffer(bin_data, dtype='<' + dt, count=a['count'] * n, offset=off).reshape(-1, n)
        return out if n > 1 else out[:, 0]
    raw = np.frombuffer(bin_data, dtype=np.uint8, count=stride * (a['count'] - 1) + size * n, offset=off)
    out = np.empty((a['count'], n), dtype=np.dtype('<' + dt))
    for k in range(a['count']):
        out[k] = np.frombuffer(raw[k * stride:k * stride + size * n].tobytes(), dtype='<' + dt)
    return out if n > 1 else out[:, 0]


def decimate(P, F, target):
    """Quadric edge-collapse (half-edge: a vertex collapses onto a neighbour, so normals/UVs stay valid).
    Open edges (mesh borders and UV seams) are locked, and collapses that flip a face are rejected."""
    import heapq
    nv = len(P)
    P64 = P.astype(np.float64)
    faces = [list(f) for f in F]
    alive = [True] * len(faces)
    vf = [set() for _ in range(nv)]
    for fi, f in enumerate(faces):
        for v in f:
            vf[v].add(fi)
    Q = np.zeros((nv, 4, 4))
    for f in faces:
        p0, p1, p2 = P64[f[0]], P64[f[1]], P64[f[2]]
        n = np.cross(p1 - p0, p2 - p0)
        area = np.linalg.norm(n)
        if area < 1e-14:
            continue
        n /= area
        pl = np.append(n, -n.dot(p0))
        K = np.outer(pl, pl) * area
        for v in f:
            Q[v] += K
    ecount = {}
    for f in faces:
        for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
            e = (min(a, b), max(a, b))
            ecount[e] = ecount.get(e, 0) + 1
    locked = np.zeros(nv, bool)
    for (a, b), c in ecount.items():
        if c != 2:
            locked[a] = locked[b] = True
    ver = [0] * nv
    heap = []

    def cost(a, b):  # a -> b
        v = np.append(P64[b], 1.0)
        return float(v @ (Q[a] + Q[b]) @ v)

    def push_edges(v):
        nb = set()
        for fi in vf[v]:
            nb.update(faces[fi])
        nb.discard(v)
        for u in nb:
            for a, b in ((v, u), (u, v)):
                if not locked[a]:
                    heapq.heappush(heap, (cost(a, b), a, b, ver[a], ver[b]))

    for v in range(nv):
        if not locked[v]:
            push_edges(v)
    nfaces = len(faces)
    while nfaces > target and heap:
        c, a, b, va, vb = heapq.heappop(heap)
        if va != ver[a] or vb != ver[b] or not vf[a]:
            continue
        shared = [fi for fi in vf[a] if b in faces[fi]]
        if not shared:
            continue
        ok = True
        for fi in vf[a]:
            if fi in shared:
                continue
            f = faces[fi]
            p = [P64[x] for x in f]
            n0 = np.cross(p[1] - p[0], p[2] - p[0])
            q = [P64[b] if x == a else P64[x] for x in f]
            n1 = np.cross(q[1] - q[0], q[2] - q[0])
            l0, l1 = np.linalg.norm(n0), np.linalg.norm(n1)
            if l1 < 1e-14 or (l0 > 1e-14 and n0.dot(n1) / (l0 * l1) < 0.35):
                ok = False
                break
        if not ok:
            continue
        for fi in shared:
            alive[fi] = False
            nfaces -= 1
            for x in faces[fi]:
                vf[x].discard(fi)
        for fi in list(vf[a]):
            faces[fi] = [b if x == a else x for x in faces[fi]]
            vf[b].add(fi)
        vf[a].clear()
        Q[b] += Q[a]
        ver[a] += 1
        ver[b] += 1
        push_edges(b)
    out = np.array([faces[i] for i in range(len(faces)) if alive[i]], dtype=np.int64)
    used = np.unique(out)
    remap = -np.ones(nv, np.int64)
    remap[used] = np.arange(len(used))
    return used, remap[out]


def rebuild_geometry(g, bin_data, target_tris):
    """Rewrite every primitive (POSITION/NORMAL/TEXCOORD_0 + indices) into a fresh tightly packed buffer,
    decimating when target_tris is set (budget shared across primitives by triangle count)."""
    prims = [p for mesh in g['meshes'] for p in mesh['primitives']]
    total = sum(g['accessors'][p['indices']]['count'] // 3 for p in prims)
    ratio = min(1.0, target_tris / total) if target_tris else 1.0
    buf = bytearray()
    views, accs = [], []

    def add(arr, comp, typ, target=None, minmax=False):
        while len(buf) % 4:
            buf.append(0)
        data = arr.astype({5126: '<f4', 5123: '<u2', 5125: '<u4'}[comp]).tobytes()
        view = {'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data)}
        if target:
            view['target'] = target
        views.append(view)
        buf.extend(data)
        acc = {'bufferView': len(views) - 1, 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
        if minmax:
            acc['min'] = [float(x) for x in arr.min(0)]
            acc['max'] = [float(x) for x in arr.max(0)]
        accs.append(acc)
        return len(accs) - 1

    tris_out = 0
    for p in prims:
        A = p['attributes']
        P = read_acc(g, bin_data, A['POSITION']).astype(np.float32)
        N = read_acc(g, bin_data, A['NORMAL']).astype(np.float32) if 'NORMAL' in A else None
        T = read_acc(g, bin_data, A['TEXCOORD_0']).astype(np.float32) if 'TEXCOORD_0' in A else None
        F = read_acc(g, bin_data, p['indices']).astype(np.int64).reshape(-1, 3)
        if ratio < 0.999 and len(F) > 64:
            used, F = decimate(P, F, max(16, int(len(F) * ratio)))
            P = P[used]
            N = N[used] if N is not None else None
            T = T[used] if T is not None else None
        tris_out += len(F)
        attrs = {'POSITION': add(P, 5126, 'VEC3', 34962, True)}
        if N is not None:
            attrs['NORMAL'] = add(N, 5126, 'VEC3', 34962)
        if T is not None:
            attrs['TEXCOORD_0'] = add(T, 5126, 'VEC2', 34962)
        p['attributes'] = attrs
        p['indices'] = add(F.reshape(-1), 5123 if len(P) < 65536 else 5125, 'SCALAR', 34963)
    g['accessors'] = accs
    g['bufferViews'] = views
    # static props: drop rigs / animations (their accessors are gone)
    g.pop('skins', None)
    g.pop('animations', None)
    for n in g.get('nodes', []):
        n.pop('skin', None)
    return bytes(buf), tris_out


def process(m):
    mid, size = m['id'], m['size']
    dst = os.path.join(OUT, mid)
    gltf_out = os.path.join(dst, mid + '.gltf')
    if os.path.exists(gltf_out) and not FORCE:
        print('skip', mid)
        return json.load(open(os.path.join(dst, 'info.json')))
    files = json.loads(cached(API + mid, f'{mid}/files.json'))
    entry = files['gltf']['1k']['gltf']
    g = json.loads(cached(entry['url'], f'{mid}/{mid}_1k.gltf'))
    raw = {}
    for rel, inc in entry.get('include', {}).items():
        raw[rel] = cached(inc['url'], f'{mid}/{rel}')
    os.makedirs(dst, exist_ok=True)

    # images -> webp
    alpha_images = set()
    for mat in g.get('materials', []):
        if mat.get('alphaMode') in ('BLEND', 'MASK'):
            bct = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture')
            if bct is not None:
                alpha_images.add(g['textures'][bct['index']]['source'])
    total = 0
    for i, img in enumerate(g.get('images', [])):
        uri = img['uri']
        kind = kind_of(os.path.basename(uri))
        base = os.path.splitext(os.path.basename(uri))[0].replace('_1k', '')
        out_name = base + '.webp'
        data = to_webp(raw[uri], size, kind, i in alpha_images)
        open(os.path.join(dst, out_name), 'wb').write(data)
        total += len(data)
        img['uri'] = out_name
        img['mimeType'] = 'image/webp'
    # AO from the ARM map (R channel) when the material has none
    for mat in g.get('materials', []):
        mr = mat.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture')
        if mr is not None and 'occlusionTexture' not in mat:
            src = g['images'][g['textures'][mr['index']]['source']]['uri']
            if 'arm' in src:
                mat['occlusionTexture'] = {'index': mr['index']}
    # geometry: repacked (only POSITION/NORMAL/TEXCOORD_0), decimated to the model's triangle budget
    assert len(g['buffers']) == 1
    data, tris = rebuild_geometry(g, raw[g['buffers'][0]['uri']], m.get('tris'))
    name = mid + '.bin'
    open(os.path.join(dst, name), 'wb').write(data)
    total += len(data)
    g['buffers'] = [{'uri': name, 'byteLength': len(data)}]
    # alternative texture sets
    variants = {}
    for v in m.get('variants', []):
        maps = {}
        for slot, key in (('diff', f'{v}_diff'), ('nor', f'{v}_nor_gl'), ('arm', f'{v}_arm')):
            info = files.get(key, {}).get('1k', {}).get('jpg')
            if not info:
                continue
            data = to_webp(cached(info['url'], f'{mid}/variants/{key}_1k.jpg'), size, slot, False)
            name = f'{mid}_{key}.webp'
            open(os.path.join(dst, name), 'wb').write(data)
            total += len(data)
            maps[slot] = name
        variants[v] = maps
    s = json.dumps(g, separators=(',', ':'))
    open(gltf_out, 'w').write(s)
    total += len(s)
    info = {'id': mid, 'use': m.get('use', ''), 'url': f'https://polyhaven.com/a/{mid}', 'license': 'CC0',
            'gltf': f'{mid}/{mid}.gltf', 'textureSize': size, 'triangles': tris, 'bytes': total, 'variants': variants}
    json.dump(info, open(os.path.join(dst, 'info.json'), 'w'), indent=1)
    print(f'{mid:30s} {total / 1e6:5.2f} MB  {tris} tris')
    return info


def main():
    os.makedirs(OUT, exist_ok=True)
    infos = {}
    for m in MODELS:
        try:
            infos[m['id']] = process(m)
        except Exception as e:  # fail soft per model; runtime falls back to procedural geometry
            print('FAILED', m['id'], e)
    total = sum(i['bytes'] for i in infos.values())
    manifest = {'source': 'Poly Haven (polyhaven.com), all models CC0', 'totalBytes': total, 'models': infos}
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    print(f'total {total / 1e6:.2f} MB in {len(infos)} models')


if __name__ == '__main__':
    main()
