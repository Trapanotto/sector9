"""Shared skeleton definitions.

The skeleton is the Quaternius Universal Animation Library (UAL2 naming, CC0) rig, trimmed for
enemies (41 joints: ring/pinky fingers merged into the middle finger, no leaf bones) and kept
complete for the first-person arms. Rest orientations are taken verbatim from UAL so every UAL
clip plays without retargeting maths at runtime.
"""

# name, parent
ENEMY_BONES = [
    ('root', None),
    ('pelvis', 'root'),
    ('spine_01', 'pelvis'), ('spine_02', 'spine_01'), ('spine_03', 'spine_02'),
    ('neck_01', 'spine_03'), ('Head', 'neck_01'),
]
for s in ('l', 'r'):
    ENEMY_BONES += [
        (f'clavicle_{s}', 'spine_03'), (f'upperarm_{s}', f'clavicle_{s}'),
        (f'lowerarm_{s}', f'upperarm_{s}'), (f'hand_{s}', f'lowerarm_{s}'),
    ]
    for f in ('thumb', 'index', 'middle'):
        ENEMY_BONES += [(f'{f}_01_{s}', f'hand_{s}'), (f'{f}_02_{s}', f'{f}_01_{s}'), (f'{f}_03_{s}', f'{f}_02_{s}')]
for s in ('l', 'r'):
    ENEMY_BONES += [(f'thigh_{s}', 'pelvis'), (f'calf_{s}', f'thigh_{s}'), (f'foot_{s}', f'calf_{s}'), (f'ball_{s}', f'foot_{s}')]

# First-person arms: full hands (5 fingers x 3) + the upper body chain for the camera reference.
ARMS_BONES = [b for b in ENEMY_BONES if not b[0].startswith(('thigh', 'calf', 'foot', 'ball'))]
for s in ('l', 'r'):
    for f in ('ring', 'pinky'):
        ARMS_BONES += [(f'{f}_01_{s}', f'hand_{s}'), (f'{f}_02_{s}', f'{f}_01_{s}'), (f'{f}_03_{s}', f'{f}_02_{s}')]

FINGER_MH = {'thumb': 1, 'index': 2, 'middle': 3, 'ring': 4, 'pinky': 5}


def mh_side(s):
    return 'L' if s == 'l' else 'R'


def mh_joint_sources(bone):
    """MakeHuman reference for a UAL joint: list of ('head'|'tail', mh_bone) averaged."""
    if bone == 'root':
        return None
    if bone == 'pelvis':
        return [('head', 'root')]
    simple = {'spine_01': 'spine04', 'spine_02': 'spine02', 'spine_03': 'spine01', 'neck_01': 'neck01', 'Head': 'head'}
    if bone in simple:
        return [('head', simple[bone])]
    name, s = bone.rsplit('_', 1)
    S = mh_side(s)
    if name == 'clavicle':
        return [('head', f'clavicle.{S}')]
    if name == 'upperarm':
        return [('head', f'upperarm01.{S}')]
    if name == 'lowerarm':
        return [('head', f'lowerarm01.{S}')]
    if name == 'hand':
        return [('head', f'wrist.{S}')]
    if name == 'thigh':
        return [('head', f'upperleg01.{S}')]
    if name == 'calf':
        return [('head', f'lowerleg01.{S}')]
    if name == 'foot':
        return [('head', f'foot.{S}')]
    if name == 'ball':
        return [('head', f'toe{i}-1.{S}') for i in range(1, 6)]
    f, seg = name.split('_')
    return [('head', f'finger{FINGER_MH[f]}-{int(seg)}.{S}')]


def mh_tip_sources(bone):
    """End point for bones that have no child joint in the trimmed skeleton."""
    if bone == 'Head':
        return [('tail', 'head')]
    if '_' not in bone or bone.startswith('spine') or bone.startswith('neck'):
        return None
    name, s = bone.rsplit('_', 1)
    S = mh_side(s)
    if name == 'ball':
        return [('tail', f'toe{i}-{2 if i == 1 else 3}.{S}') for i in range(1, 6)]
    if name.endswith('_03'):
        f = name.split('_')[0]
        return [('tail', f'finger{FINGER_MH[f]}-3.{S}')]
    return None


def mh_bone_map(full_hands):
    """Returns f(mh_bone) -> target bone (or None)."""
    def f(b):
        if b in ('root', 'spine05', 'pelvis.L', 'pelvis.R'):
            return 'pelvis'
        if b in ('spine04', 'spine03'):
            return 'spine_01'
        if b == 'spine02':
            return 'spine_02'
        if b in ('spine01', 'breast.L', 'breast.R'):
            return 'spine_03'
        if b.startswith('neck'):
            return 'neck_01'
        if '.' not in b:
            return 'Head'  # head, jaw, tongue, face rig
        base, S = b.rsplit('.', 1)
        s = 'l' if S == 'L' else 'r'
        if base in ('clavicle', 'shoulder01'):
            return f'clavicle_{s}'
        if base.startswith('upperarm'):
            return f'upperarm_{s}'
        if base.startswith('lowerarm'):
            return f'lowerarm_{s}'
        if base == 'wrist' or base.startswith('metacarpal'):
            return f'hand_{s}'
        if base.startswith('finger'):
            fi, seg = base[6:].split('-')
            fname = {1: 'thumb', 2: 'index', 3: 'middle', 4: 'ring', 5: 'pinky'}[int(fi)]
            if not full_hands and fname in ('ring', 'pinky'):
                fname = 'middle'
            return f'{fname}_0{seg}_{s}'
        if base.startswith('upperleg'):
            return f'thigh_{s}'
        if base.startswith('lowerleg'):
            return f'calf_{s}'
        if base == 'foot':
            return f'foot_{s}'
        if base.startswith('toe'):
            return f'ball_{s}'
        return 'Head'  # eyes, face muscles (.L/.R)
    return f


# UAL1 (DEF-*) -> UAL2 names, for the clips that only exist in the first library.
def ual1_to_ual2(n):
    m = {'root': 'root', 'DEF-hips': 'pelvis', 'DEF-spine.001': 'spine_01', 'DEF-spine.002': 'spine_02',
         'DEF-spine.003': 'spine_03', 'DEF-neck': 'neck_01', 'DEF-head': 'Head'}
    if n in m:
        return m[n]
    if not n.startswith('DEF-'):
        return None
    b = n[4:]
    base, S = b.rsplit('.', 1)
    s = S.lower()
    simple = {'shoulder': 'clavicle', 'upper_arm': 'upperarm', 'forearm': 'lowerarm', 'hand': 'hand',
              'thigh': 'thigh', 'shin': 'calf', 'foot': 'foot', 'toe': 'ball'}
    if base in simple:
        return f'{simple[base]}_{s}'
    if base.startswith('f_'):
        f, seg = base[2:].split('.')
        return f'{f}_{seg}_{s}'
    if base.startswith('thumb.'):
        return f'thumb_{base.split(".")[1]}_{s}'
    return None
