# Character asset credits (SECTOR 9 v2)

Every third-party file used to build `public/assets/chars/**` and `public/assets/arms/**` is
CC0 1.0 / public domain. Nothing was taken from behind a login. All files fetched 2026-11-21 by
`scripts/chars/fetch_sources.py` (it records the exact URLs below).

| Asset | Author | Source URL | Licence | Used for |
|---|---|---|---|---|
| Universal Animation Library (Standard, free tier) | Quaternius | https://opengameart.org/content/universal-animation-library (file `universal_animation_librarystandard.zip`); pack page https://quaternius.com/packs/universalanimationlibrary.html | CC0 1.0 (`License.txt` in the zip; OGA page lists CC0) | Rig (skeleton orientations) + 25 sourced clips |
| Universal Animation Library 2 (Standard, free tier) | Quaternius | https://opengameart.org/content/universal-animation-library-2 (file `universal_animation_library_2standard.zip`); pack page https://quaternius.com/packs/universalanimationlibrary2.html | CC0 1.0 (`License.txt` in the zip; OGA page lists CC0) | Rig rest pose / bone names (UAL2 naming) + 6 sourced clips |
| MakeHuman 1.x base mesh `hm08`, macro targets, default skeleton + weights | MakeHuman team (Data Collection AB, Joel Palmius, Jonas Hauquier, Manuel Bastioni) | https://github.com/makehumancommunity/makehuman/tree/master/makehuman/data (raw files under `3dobjs/`, `rigs/`, `targets/macrodetails/`) | CC0 1.0 (assets section of `makehuman/license.txt`; each target file states "released as CC0") | Bodies |
| MakeHuman system assets pack | MakeHuman team ("makehuman_system") | https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip (page https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html) | CC0 | Proxies `male_generic`, `female_generic`; skins `young_caucasian_male`, `young_african_male`, `middleage_caucasian_male`, `young_caucasian_female`; clothes `male_casualsuit03/05/06`, `male_worksuit01`, `shoes03/04/05/06`; hair `ponytail01`; eyes `low-poly` + `brown` |
| Shirts 01 pack | Margaret Toigo (`toigo_fisherman_sweater`), Joel Palmius (`joepal_crude_t-shirt_female`) | https://files.makehumancommunity.org/asset_packs/shirts01/shirts01_cc0.zip | CC0 | Hoodie body, FP sleeves, female tee |
| Pants 01 pack | Cortu (`cortu_cargo_pants`), Margaret Toigo (`toigo_wool_pants`) | https://files.makehumancommunity.org/asset_packs/pants01/pants01_cc0.zip | CC0 | Trousers |
| Masks 01 pack | culturalibre (`hero-heroine_hood_1`, `hero_mask_1`), Joel Palmius (`joepal_medical_mouth_protection`) | https://files.makehumancommunity.org/asset_packs/masks01/masks01_cc0.zip | CC0 | Hood, beanie (cropped hood), balaclava, face cover |
| Hats 01 pack | Margaret Toigo (`toigo_maga_hat`, print removed/recoloured to a plain navy cap) | https://files.makehumancommunity.org/asset_packs/hats01/hats01_cc0.zip | CC0 | Baseball cap |
| Shoes 01 pack | Margaret Toigo (`toigo_ankle_boots_female`) | https://files.makehumancommunity.org/asset_packs/shoes01/shoes01_cc0.zip | CC0 | Female boots |
| Gloves 01 pack | Margaret Toigo (`toigo_gloves_short`) | https://files.makehumancommunity.org/asset_packs/gloves01/gloves01_cc0.zip | CC0 | First-person gloves |

## Self-made (released with the project, CC0)

- All enemy weapons (`weapons/pistol|smg|shotgun.glb`) and the first-person pistol: procedural
  geometry in `scripts/chars/weapons.mjs` / `fppistol.mjs`.
- 25 enemy clips and all 7 first-person clips: authored in code (`author.mjs`, `build_arms.mjs`)
  from UAL frames, keyed rotations and IK. The clip table in `public/assets/chars/README.md` says
  which clips are sourced and which are made.
- Texture recolouring, atlasing, re-posing onto the UAL rig, LODs: pipeline in `scripts/chars/`.

No CMU mocap, Mixamo, CC-BY or ripped game assets are used.
