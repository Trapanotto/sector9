"""Tiny GLB reader/writer (numpy) for the character pipeline."""
import json
import struct

import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    data = open(path, 'rb').read()
    magic, ver, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67
    off = 12
    js, binc = None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        else:
            binc = chunk
        off += 8 + clen
    return js, binc


def accessor(js, binc, i):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    dt = CT[a['componentType']]
    n = NC[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride')
    isz = np.dtype(dt).itemsize
    if stride and stride != n * isz:
        raw = np.frombuffer(binc, dtype=np.uint8, count=stride * a['count'], offset=start).reshape(a['count'], stride)
        arr = raw[:, :n * isz].copy().view(dt).reshape(a['count'], n)
    else:
        arr = np.frombuffer(binc, dtype=dt, count=a['count'] * n, offset=start).reshape(a['count'], n).copy()
    if a.get('normalized'):
        if dt == np.uint8:
            arr = arr / 255.0
        elif dt == np.uint16:
            arr = arr / 65535.0
        elif dt == np.int16:
            arr = np.maximum(arr / 32767.0, -1)
        elif dt == np.int8:
            arr = np.maximum(arr / 127.0, -1)
    return arr


# ----------------------------------------------------------------------------- math
def quat_to_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_to_quat(m):
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    return q / np.linalg.norm(q)


def trs(t=(0, 0, 0), r=(0, 0, 0, 1), s=(1, 1, 1)):
    m = np.eye(4)
    m[:3, :3] = quat_to_mat(r) * np.array(s)[None, :]
    m[:3, 3] = t
    return m


def min_arc(a, b):
    """Rotation matrix taking unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        axis = np.cross(a, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return axis_angle(axis, np.pi)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def axis_angle(axis, ang):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    x, y, z = axis
    c, s = np.cos(ang), np.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def node_world(js):
    """World matrices of all nodes of the default scene; returns (world list, parent list)."""
    nodes = js['nodes']
    parent = [-1] * len(nodes)
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    local = []
    for n in nodes:
        if 'matrix' in n:
            local.append(np.array(n['matrix']).reshape(4, 4).T)
        else:
            local.append(trs(n.get('translation', (0, 0, 0)), n.get('rotation', (0, 0, 0, 1)), n.get('scale', (1, 1, 1))))
    world = [None] * len(nodes)

    def w(i):
        if world[i] is None:
            world[i] = local[i] if parent[i] < 0 else w(parent[i]) @ local[i]
        return world[i]
    for i in range(len(nodes)):
        w(i)
    return world, parent, local


# ----------------------------------------------------------------------------- writer
class GlbWriter:
    def __init__(self):
        self.js = {'asset': {'version': '2.0', 'generator': 'sector9 chars pipeline'},
                   'buffers': [{'byteLength': 0}], 'bufferViews': [], 'accessors': []}
        self.bin = bytearray()

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            bv['target'] = target
        self.js['bufferViews'].append(bv)
        return len(self.js['bufferViews']) - 1

    def add_accessor(self, arr, typ, ctype, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr.astype(CT[ctype]))
        bv = self._view(arr.tobytes(), target)
        a = {'bufferView': bv, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
        if normalized:
            a['normalized'] = True
        if minmax:
            a['min'] = [float(x) for x in arr.reshape(arr.shape[0], -1).min(0)]
            a['max'] = [float(x) for x in arr.reshape(arr.shape[0], -1).max(0)]
        self.js['accessors'].append(a)
        return len(self.js['accessors']) - 1

    def add_image(self, data, mime):
        bv = self._view(data)
        self.js.setdefault('images', []).append({'bufferView': bv, 'mimeType': mime})
        return len(self.js['images']) - 1

    def save(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.js['buffers'][0]['byteLength'] = len(self.bin)
        j = json.dumps(self.js, separators=(',', ':')).encode()
        while len(j) % 4:
            j += b' '
        out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(self.bin))
        out += struct.pack('<II', len(j), 0x4E4F534A) + j
        out += struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin)
        open(path, 'wb').write(out)
