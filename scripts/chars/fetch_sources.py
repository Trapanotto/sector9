"""Download every third-party CC0 source used by the character pipeline into a cache dir.

usage: python -I fetch_sources.py <cache_dir>

All sources are CC0 / public domain (see CREDITS-CHARS.md). Nothing here needs a login.
"""
import os
import sys
import urllib.request
import zipfile

CACHE = sys.argv[1]
UA = {'User-Agent': 'asset-fetch/1.0'}

MH_RAW = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/'
MH_PACKS = 'https://files.makehumancommunity.org/asset_packs/'
OGA = 'https://opengameart.org/sites/default/files/'


def get(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req) as r, open(dst + '.part', 'wb') as f:
        f.write(r.read())
    os.replace(dst + '.part', dst)
    print('got', url)


def unzip(src, dst):
    if os.path.isdir(dst):
        return
    with zipfile.ZipFile(src) as z:
        z.extractall(dst)


core = os.path.join(CACHE, 'mh_core')
files = ['3dobjs/base.obj', 'rigs/default.mhskel', 'rigs/default_weights.mhw']
for g in ('male', 'female'):
    for r in ('caucasian', 'african', 'asian'):
        files.append(f'targets/macrodetails/{r}-{g}-young.target')
    for mu in ('minmuscle', 'averagemuscle', 'maxmuscle'):
        for w in ('minweight', 'averageweight', 'maxweight'):
            files.append(f'targets/macrodetails/universal-{g}-young-{mu}-{w}.target')
            files.append(f'targets/macrodetails/proportions/{g}-young-{mu}-{w}-idealproportions.target')
            for h in ('minheight', 'maxheight'):
                files.append(f'targets/macrodetails/height/{g}-young-{mu}-{w}-{h}.target')
for f in files:
    get(MH_RAW + f, os.path.join(core, f))

for pack in ('makehuman_system_assets', 'masks01', 'hats01', 'gloves01', 'pants01', 'shirts01', 'shoes01'):
    z = os.path.join(CACHE, 'mh_' + pack + '.zip')
    get(f'{MH_PACKS}{pack}/{pack}_cc0.zip', z)
    unzip(z, os.path.join(CACHE, 'mh_' + pack))

for name in ('universal_animation_librarystandard', 'universal_animation_library_2standard'):
    z = os.path.join(CACHE, name + '.zip')
    get(OGA + name + '.zip', z)
    unzip(z, os.path.join(CACHE, name))
print('ok')
