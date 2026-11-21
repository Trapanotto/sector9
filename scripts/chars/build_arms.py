"""First-person arms (stage 1): MakeHuman CC0 male arms + CC0 gloves + sweater sleeves,
cropped to the arm chains and bound to the 45-joint UAL upper-body skeleton with full fingers.

usage: python -I build_arms.py <cache_dir> <out_raw.glb>
Stage 2 (pistol, poses, animations, export) is build_arms.mjs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import charspec  # noqa: E402
import mhbuild  # noqa: E402

SYS = 'mh_makehuman_system_assets'

ARMS = dict(
    gender='male', race={'caucasian': 0.7, 'african': 0.3}, muscle=0.65, weight=0.5, height=0.5, proportions=0.5,
    proxy=SYS + '/proxymeshes/male_generic/male_generic.proxy',
    skin=SYS + '/skins/young_caucasian_male/young_lightskinned_male_diffuse.png', skin_rect=(0, 640, 256, 256),
    arm_crop=0.6, unit_scale=True, skin_solid=(40, 40, 38),  # only the wrist gap shows: match the glove cuff
    items=[
        # navy uniform sleeves: the CC0 sweater pulled in to a shirt-sleeve fit (fit_gap) and repainted as
        # uniform twill with seam + cuff; two-tone tactical gloves (CC0 mesh) repainted with knuckle strip,
        # pads, seams and cuff (fppaint.py). Atlas: gloves 640², sleeves 384x640, skin 256², pistol palette.
        dict(mhclo='mh_shirts01/clothes/toigo_fisherman_sweater/toigo_fisherman_sweater.mhclo', rect=(640, 0, 384, 640),
             fit_gap=(0.005, 0.3), offset=0.001, tint=dict(color=(30, 36, 52), detail=0.55, flatten=1),
             paint='sleeve', paint_spec=dict(color=(34, 41, 60))),
        dict(mhclo='mh_gloves01/clothes/toigo_gloves_short/toigo_gloves_short.mhclo', rect=(0, 0, 640, 640),
             paint='glove', paint_spec=dict(back=(70, 70, 64), palm=(112, 100, 80), pad=(30, 30, 31))),
    ],
)


def main():
    cache, out = sys.argv[1], sys.argv[2]
    ual = mhbuild.UalRest(os.path.join(cache, 'universal_animation_library_2standard',
                                       'Universal Animation Library 2 [Standard]', 'Unreal-Godot', 'UAL2_Standard.glb'))
    geo, rig, atlas, alpha, stats = mhbuild.build_character(ARMS, cache, ual, charspec.ARMS_BONES, full_hands=True, atlas_size=1024)
    print('arms: verts', len(geo['pos']), 'tris', len(geo['idx']), stats)
    mhbuild.write_glb(out, geo, rig, atlas, alpha, 'fp_arms', extras={'note': 'first-person arms raw'})
    atlas.save(out.replace('.glb', '_atlas.png'))


if __name__ == '__main__':
    main()
