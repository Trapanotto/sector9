"""Stage 1: MakeHuman (CC0) bodies + clothes -> raw skinned GLBs on the shared UAL skeleton.

usage: python -I build_enemies.py <cache_dir> <out_dir> [variant ...]
Stage 2 (LODs, texture compression, meshopt) is optimize.mjs.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import charspec  # noqa: E402
import mhbuild  # noqa: E402

SYS = 'mh_makehuman_system_assets'
CL = SYS + '/clothes'

# atlas rectangles (x, y, w, h) in a 1024 atlas
R_SKIN = (0, 0, 512, 512)
R_TOP = (512, 0, 512, 512)
R_LOW = (0, 512, 512, 512)
R_SHOE = (512, 512, 256, 256)
R_HEAD = (768, 512, 256, 256)
R_HAIR = (512, 768, 256, 256)
R_EYES = (768, 768, 128, 128)
R_FACE = (896, 768, 128, 128)
R_X1 = (768, 896, 256, 128)

EYES = {'mhclo': SYS + '/eyes/low-poly/low-poly.mhclo', 'texture': SYS + '/eyes/materials/brown_eye.png',
        'rect': R_EYES, 'hide_body': False}


VARIANTS = {
    # 1: padded jacket, jeans, boots, knit beanie
    'thug_jacket': dict(
        gender='male', race={'caucasian': 0.8, 'asian': 0.2}, muscle=0.6, weight=0.55, height=0.45, proportions=0.5,
        proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
        skin=SYS + '/skins/young_caucasian_male/young_lightskinned_male_diffuse.png', skin_rect=R_SKIN,
        items=[
            dict(mhclo=CL + '/male_casualsuit05/male_casualsuit05.mhclo', rect=R_TOP, ao=0.7),
            dict(mhclo=CL + '/shoes03/shoes03.mhclo', rect=R_SHOE, ao=0.5),
            dict(mhclo='mh_masks01/clothes/culturalibre_hero-heroine_hood_1/culturalibre_hero-heroine_hood_1.mhclo',
                 rect=R_HEAD, clip_y=0.07, inflate=0.05, hide_body=False,
                 tint=dict(color=(30, 30, 33), detail=0.0, noise=0.12)),
            EYES,
        ]),
    # 2: grey hoodie (sweater + hood), black cargo pants, white sneakers, black face cover
    'thug_hoodie': dict(
        gender='male', race={'caucasian': 0.5, 'african': 0.5}, muscle=0.5, weight=0.45, height=0.5, proportions=0.5,
        proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
        skin=SYS + '/skins/young_african_male/young_darkskinned_male_diffuse.png', skin_rect=R_SKIN,
        items=[
            dict(mhclo='mh_shirts01/clothes/toigo_fisherman_sweater/toigo_fisherman_sweater.mhclo', rect=R_TOP, offset=0.006,
                 tint=dict(color=(92, 94, 98), detail=0.45, flatten=2)),
            dict(mhclo='mh_masks01/clothes/culturalibre_hero-heroine_hood_1/culturalibre_hero-heroine_hood_1.mhclo',
                 rect=R_HEAD, inflate=0.09, tint=dict(color=(84, 86, 90), detail=0.0, noise=0.10)),
            dict(mhclo='mh_pants01/clothes/toigo_wool_pants/toigo_wool_pants.mhclo', rect=R_LOW,
                 tint=dict(color=(32, 33, 35), detail=0.9)),
            dict(mhclo=CL + '/shoes05/shoes05.mhclo', rect=R_SHOE, ao=0.5),
            dict(mhclo='mh_masks01/clothes/joepal_medical_mouth_protection/joepal_medical_mouth_protection.mhclo',
                 rect=R_FACE, tint=dict(color=(22, 22, 24), detail=0.3, flatten=2), hide_body=False),
            EYES,
        ]),
    # 3: plaid shirt + jeans, black balaclava, work shoes
    'thug_balaclava': dict(
        gender='male', race={'caucasian': 1.0}, muscle=0.65, weight=0.5, height=0.45, proportions=0.5,
        proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
        skin=SYS + '/skins/middleage_caucasian_male/middleage_lightskinned_male_diffuse.png', skin_rect=R_SKIN,
        items=[
            dict(mhclo=CL + '/male_casualsuit03/male_casualsuit03.mhclo', rect=R_TOP, ao=0.7),
            dict(mhclo='mh_masks01/clothes/culturalibre_hero_mask_1/culturalibre_hero_mask_1.mhclo', rect=R_HEAD,
                 tint=dict(color=(20, 20, 22), detail=0.35, flatten=2, noise=0.06)),
            dict(mhclo=CL + '/shoes04/shoes04.mhclo', rect=R_SHOE, ao=0.5),
            dict(mhclo='mh_masks01/clothes/joepal_medical_mouth_protection/joepal_medical_mouth_protection.mhclo',
                 rect=R_FACE, tint=dict(color=(18, 18, 20), detail=0.3, flatten=2), hide_body=False),
            EYES,
        ]),
    # 4: overalls + tee, baseball cap, boots, heavier build
    'thug_worker': dict(
        gender='male', race={'african': 0.8, 'caucasian': 0.2}, muscle=0.6, weight=0.75, height=0.4, proportions=0.5,
        proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
        skin=SYS + '/skins/young_african_male/young_darkskinned_male_diffuse.png', skin_rect=R_SKIN,
        items=[
            dict(mhclo=CL + '/male_worksuit01/male_worksuit01.mhclo', rect=R_TOP, ao=0.7,
                 tint=dict(color=(66, 74, 60), detail=0.85)),
            dict(mhclo='mh_hats01/clothes/toigo_maga_hat/toigo_maga_hat.mhclo', rect=R_HEAD,
                 tint=dict(color=(30, 36, 52), detail=0.6, flatten=6, noise=0.05)),
            dict(mhclo=CL + '/shoes03/shoes03.mhclo', rect=R_SHOE, ao=0.5),
            EYES,
        ]),
    # 5: dark tee + jeans, buzz cut, sneakers, muscular
    'thug_tee': dict(
        gender='male', race={'caucasian': 0.6, 'asian': 0.4}, muscle=0.8, weight=0.5, height=0.55, proportions=0.6,
        proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
        skin=SYS + '/skins/young_caucasian_male/young_lightskinned_male_diffuse.png', skin_rect=R_SKIN,
        buzzcut=(26, 22, 19),
        items=[
            dict(mhclo=CL + '/male_casualsuit06/male_casualsuit06.mhclo', rect=R_TOP, ao=0.7,
                 region_tints=[dict(notblue_above=-0.08, tint=dict(color=(36, 37, 40), detail=0.6, flatten=6))]),
            dict(mhclo=CL + '/shoes06/shoes06.mhclo', rect=R_SHOE, ao=0.5),
            EYES,
        ]),
    # 6: woman, tee + cargo pants, ponytail, ankle boots
    'thug_female': dict(
        gender='female', race={'caucasian': 0.5, 'asian': 0.5}, muscle=0.55, weight=0.45, height=0.55, proportions=0.6,
        proxy=SYS + '/proxymeshes/female_generic/female_generic.proxy',
        skin=SYS + '/skins/young_caucasian_female/young_lightskinned_female_diffuse.png', skin_rect=R_SKIN,
        items=[
            dict(mhclo='mh_shirts01/clothes/joepal_crude_t-shirt_female/joepal_crude_t-shirt_female.mhclo', rect=R_TOP,
                 tint=dict(color=(70, 26, 30), detail=0.7)),
            dict(mhclo='mh_pants01/clothes/cortu_cargo_pants/cortu_cargo_pants.mhclo', rect=R_LOW,
                 tint=dict(color=(58, 60, 46), detail=0.9)),
            dict(mhclo='mh_shoes01/clothes/toigo_ankle_boots_female/toigo_ankle_boots_female.mhclo', rect=R_SHOE),
            dict(mhclo=SYS + '/hair/ponytail01/ponytail01.mhclo', rect=R_HAIR, alpha=True, hide_body=False),
            EYES,
        ]),
}


def main():
    cache, out = sys.argv[1], sys.argv[2]
    only = sys.argv[3:]
    os.makedirs(out, exist_ok=True)
    ual = mhbuild.UalRest(os.path.join(cache, 'universal_animation_library_2standard',
                                       'Universal Animation Library 2 [Standard]', 'Unreal-Godot', 'UAL2_Standard.glb'))
    mp = os.path.join(out, 'meta.json')
    meta = json.load(open(mp)) if os.path.exists(mp) else {}
    for name, cfg in VARIANTS.items():
        if only and name not in only:
            continue
        geo, rig, atlas, alpha, stats = mhbuild.build_character(cfg, cache, ual, charspec.ENEMY_BONES, full_hands=False)
        h = float(geo['pos'][:, 1].max())
        print(f'{name}: verts {len(geo["pos"])} tris {len(geo["idx"])} height {h:.3f} m root scale {rig["scale"]:.4f} parts {stats}')
        mhbuild.write_glb(os.path.join(out, name + '_raw.glb'), geo, rig, atlas, alpha, name,
                          extras={'variant': name, 'height_m': h, 'rootScale': rig['scale']})
        atlas.save(os.path.join(out, name + '_atlas.png'))
        meta[name] = {'height_m': round(h, 3), 'root_scale': round(float(rig['scale']), 5), 'raw_tris': int(len(geo['idx'])),
                      'parts': stats, 'pelvis': [round(float(x), 4) for x in rig['NP']['pelvis']]}
    json.dump(meta, open(mp, 'w'), indent=1)


if __name__ == '__main__':
    main()
