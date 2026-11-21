"""Minimal re-implementation of the MakeHuman 1.x asset formats needed to build game characters
without the MakeHuman application or Blender.

Formats handled (all plain text, all CC0 assets):
  base.obj            hm08 base mesh (decimetres, +Y up, faces +Z)
  *.target            sparse vertex offsets ("idx dx dy dz")
  *.proxy / *.mhclo   meshes fitted to the base mesh through 3 reference vertices + offset
  default.mhskel      joints = vertex groups whose centroid is the joint position
  default_weights.mhw skinning weights per MakeHuman bone on the base mesh
"""
import json
import os
import re

import numpy as np


# ----------------------------------------------------------------------------- OBJ
class Obj:
    def __init__(self, path):
        vs, vts, faces, fgroups = [], [], [], []
        group = None
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if line.startswith('v '):
                    vs.append([float(x) for x in line.split()[1:4]])
                elif line.startswith('vt '):
                    vts.append([float(x) for x in line.split()[1:3]])
                elif line.startswith('g '):
                    group = line.split(None, 1)[1].strip()
                elif line.startswith('f '):
                    vi, ti = [], []
                    for tok in line.split()[1:]:
                        parts = tok.split('/')
                        vi.append(int(parts[0]) - 1)
                        ti.append(int(parts[1]) - 1 if len(parts) > 1 and parts[1] else -1)
                    faces.append((vi, ti))
                    fgroups.append(group)
        self.v = np.array(vs, dtype=np.float64)
        self.vt = np.array(vts, dtype=np.float64) if vts else np.zeros((0, 2))
        self.faces = faces
        self.fgroups = fgroups


# ----------------------------------------------------------------------------- targets
_target_cache = {}


def load_target(path):
    if path in _target_cache:
        return _target_cache[path]
    idx, d = [], []
    with open(path) as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            p = line.split()
            idx.append(int(p[0]))
            d.append([float(p[1]), float(p[2]), float(p[3])])
    r = (np.array(idx, dtype=np.int64), np.array(d, dtype=np.float64).reshape(-1, 3))
    _target_cache[path] = r
    return r


def _tri(x):
    """MakeHuman macro slider (0..1, 0.5 = average) -> weights for (min, average, max)."""
    if x < 0.5:
        return {'min': (0.5 - x) * 2, 'average': 1 - (0.5 - x) * 2, 'max': 0.0}
    return {'min': 0.0, 'average': 1 - (x - 0.5) * 2, 'max': (x - 0.5) * 2}


def macro_targets(core, gender, race, muscle, weight, height, proportions):
    """List of (path, weight) for an adult (age 25) of the given sex.

    race: dict like {'caucasian': 1.0}. muscle/weight/height in 0..1 (0.5 = average)."""
    md = os.path.join(core, 'targets', 'macrodetails')
    out = []
    for r, w in race.items():
        if w > 0:
            out.append((os.path.join(md, f'{r}-{gender}-young.target'), w))
    mw, ww = _tri(muscle), _tri(weight)
    hw = _tri(height)
    for mk, mv in mw.items():
        for wk, wv in ww.items():
            f = mv * wv
            if f <= 0:
                continue
            out.append((os.path.join(md, f'universal-{gender}-young-{mk}muscle-{wk}weight.target'), f))
            for hk in ('min', 'max'):
                if hw[hk] > 0:
                    out.append((os.path.join(md, 'height', f'{gender}-young-{mk}muscle-{wk}weight-{hk}height.target'), f * hw[hk]))
            if proportions > 0:
                out.append((os.path.join(md, 'proportions', f'{gender}-young-{mk}muscle-{wk}weight-idealproportions.target'), f * proportions))
    return out


def apply_targets(base_v, targets):
    v = base_v.copy()
    for path, w in targets:
        if not os.path.exists(path):
            continue  # the "average/average" universal targets are empty placeholders
        idx, d = load_target(path)
        if len(idx):
            v[idx] += w * d
    return v


# ----------------------------------------------------------------------------- proxy / clothes
def _parse_ranges(tokens):
    out = []
    i = 0
    while i < len(tokens):
        a = int(tokens[i])
        if i + 2 < len(tokens) and tokens[i + 1] == '-':
            b = int(tokens[i + 2])
            out.extend(range(a, b + 1))
            i += 3
        else:
            out.append(a)
            i += 1
    return out


class Proxy:
    """A .proxy (body topology) or .mhclo (clothes/hair/eyes) file."""

    def __init__(self, path):
        self.path = path
        self.dir = os.path.dirname(path)
        self.scales = {}
        self.refs, self.w, self.off = [], [], []
        self.delete = []
        self.material = None
        self.obj_file = None
        self.name = None
        self.z_depth = 50
        mode = None
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith('#'):
                    continue
                p = s.split()
                key = p[0]
                if key == 'verts':
                    mode = 'verts'
                    continue
                if key == 'delete_verts':
                    mode = 'delete'
                    continue
                if mode == 'verts' and re.match(r'^-?\d', key):
                    nums = [float(x) for x in p]
                    if len(nums) == 1:
                        self.refs.append([int(nums[0])] * 3)
                        self.w.append([1.0, 0.0, 0.0])
                        self.off.append([0.0, 0.0, 0.0])
                    else:
                        self.refs.append([int(nums[0]), int(nums[1]), int(nums[2])])
                        self.w.append(nums[3:6])
                        self.off.append(nums[6:9] if len(nums) >= 9 else [0.0, 0.0, 0.0])
                    continue
                if mode == 'delete' and re.match(r'^\d', key):
                    self.delete.extend(_parse_ranges(p))
                    continue
                if key in ('x_scale', 'y_scale', 'z_scale'):
                    self.scales[key[0]] = (int(p[1]), int(p[2]), float(p[3]))
                elif key == 'obj_file':
                    self.obj_file = os.path.join(self.dir, p[1])
                elif key == 'material':
                    self.material = os.path.join(self.dir, p[1])
                elif key == 'name':
                    self.name = p[1]
                elif key == 'z_depth':
                    self.z_depth = int(p[1])
        self.refs = np.array(self.refs, dtype=np.int64)
        self.w = np.array(self.w, dtype=np.float64)
        self.off = np.array(self.off, dtype=np.float64)
        self.obj = Obj(self.obj_file)

    def fit(self, base_v):
        s = np.ones(3)
        for i, k in enumerate('xyz'):
            if k in self.scales:
                a, b, den = self.scales[k]
                s[i] = abs(base_v[a, i] - base_v[b, i]) / den
        v = (base_v[self.refs] * self.w[:, :, None]).sum(1) + self.off * s
        return v

    def diffuse_texture(self):
        if not self.material or not os.path.exists(self.material):
            return None
        return read_mhmat(self.material).get('diffuseTexture')


def read_mhmat(path):
    out = {}
    d = os.path.dirname(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith('#') or s.startswith('//'):
                continue
            p = s.split(None, 1)
            if len(p) < 2:
                continue
            k, val = p
            if k.endswith('Texture'):
                out[k] = os.path.join(d, os.path.basename(val.strip()))
            else:
                out[k] = val.strip()
    return out


# ----------------------------------------------------------------------------- skeleton
class MHSkeleton:
    def __init__(self, core):
        d = json.load(open(os.path.join(core, 'rigs', 'default.mhskel')))
        self.bones = d['bones']
        self.joints = d['joints']
        w = json.load(open(os.path.join(core, 'rigs', 'default_weights.mhw')))
        self.weights = w['weights']

    def joint_pos(self, v, joint):
        return v[self.joints[joint]].mean(0)

    def head(self, v, bone):
        return self.joint_pos(v, self.bones[bone]['head'])

    def tail(self, v, bone):
        return self.joint_pos(v, self.bones[bone]['tail'])


def base_weights(skel, nverts, bone_map, out_bones):
    """Dense (nverts, len(out_bones)) weight matrix: every MakeHuman bone is merged into out_bones via bone_map."""
    W = np.zeros((nverts, len(out_bones)), dtype=np.float64)
    col = {b: i for i, b in enumerate(out_bones)}
    for mh_bone, lst in skel.weights.items():
        tgt = bone_map(mh_bone)
        if tgt is None:
            continue
        if tgt not in col:
            tgt = 'pelvis'  # bone absent from this (trimmed) skeleton
        c = col[tgt]
        arr = np.array(lst, dtype=np.float64).reshape(-1, 2)
        np.add.at(W[:, c], arr[:, 0].astype(np.int64), arr[:, 1])
    s = W.sum(1, keepdims=True)
    s[s == 0] = 1
    return W / s


def proxy_weights(proxy, Wbase):
    return (Wbase[proxy.refs] * proxy.w[:, :, None]).sum(1)
