"""Shrink the downloaded Poly Haven textures to the sizes the game actually decodes (see SETS in
src/world/materials.js) so the public build downloads quickly. Run after `npm run assets`:
    python scripts/optimize-assets.py
Overwrites files in public/assets/textures in place."""
import json, os, sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets')
BIG_DIFF = {'floor', 'wall', 'brick'}          # 2k diffuse only where the player looks at it up close
SIZE = lambda name, kind: 2048 if (kind == 'diff' and name in BIG_DIFF) else 1024
QUALITY = {'diff': 76, 'nor': 82, 'arm': 74}

man = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
before = after = 0
for name, tex in man['textures'].items():
    for kind, rel in tex['maps'].items():
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        before += os.path.getsize(path)
        im = Image.open(path); im.load()
        size = SIZE(name, kind)
        if max(im.size) > size:
            im = im.resize((size, size), Image.LANCZOS)
        im.convert('RGB').save(path, 'JPEG', quality=QUALITY.get(kind, 78), optimize=True, progressive=True)
        after += os.path.getsize(path)
print(f'textures: {before/1e6:.1f} MB -> {after/1e6:.1f} MB')
