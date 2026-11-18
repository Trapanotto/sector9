"""Fetch and pack the CC0 Poly Haven cloth textures used by the enemy characters.

Usage:  python -I scripts/characters-assets.py <download_dir>

For every set it downloads the 1k Diffuse, nor_gl and Rough JPGs from Poly Haven and packs them into ONE
grayscale WebP atlas (2x2 quadrants):  top-left = normal X, top-right = normal Y,
bottom-left = roughness, bottom-right = albedo luminance detail (normalised so the mean is 0.5).
Grayscale WebP keeps full-resolution luma (no chroma subsampling), so the normal channels stay sharp.
The browser splits the quadrants back into one RGBA texture (src/enemies/clothtex.js).
Writes public/assets/characters/<name>.webp and public/assets/characters/manifest.json.
"""
import json
import os
import sys
import urllib.request

from PIL import Image

SETS = {
    # key: (polyhaven id, quadrant size)
    'cotton': ('cotton_jersey', 512),
    'denim': ('denim_fabric_04', 512),
    'leather': ('brown_leather', 512),
    'knit': ('knitted_fleece', 512),
}
API = 'https://api.polyhaven.com/files/'
UA = {'User-Agent': 'asset-fetch/1.0'}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return json.load(r)


def fetch(url, path):
    if not os.path.exists(path):
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def main():
    dl = os.path.abspath(sys.argv[1])
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'public', 'assets', 'characters')
    os.makedirs(dl, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    manifest = {'license': 'CC0 (Poly Haven)', 'textures': []}
    for key, (pid, q) in SETS.items():
        files = get_json(API + pid)
        maps = {}
        for m in ('Diffuse', 'nor_gl', 'Rough'):
            url = files[m]['1k']['jpg']['url']
            maps[m] = Image.open(fetch(url, os.path.join(dl, f'{pid}_{m}.jpg')))
        nor = maps['nor_gl'].convert('RGB').resize((q, q), Image.LANCZOS)
        nx, ny, _ = nor.split()
        rough = maps['Rough'].convert('L').resize((q, q), Image.LANCZOS)
        lum = maps['Diffuse'].convert('L').resize((q, q), Image.LANCZOS)
        hist = lum.histogram()
        mean = sum(i * c for i, c in enumerate(hist)) / max(1, sum(hist))
        lum = lum.point(lambda v: max(0, min(255, int(round(v / max(mean, 1) * 128)))))
        atlas = Image.new('L', (q * 2, q * 2))
        atlas.paste(nx, (0, 0)); atlas.paste(ny, (q, 0)); atlas.paste(rough, (0, q)); atlas.paste(lum, (q, q))
        out = os.path.join(out_dir, key + '.webp')
        atlas.save(out, 'WEBP', quality=88, method=6)
        manifest['textures'].append({
            'file': key + '.webp', 'source': f'https://polyhaven.com/a/{pid}', 'polyhaven_id': pid,
            'maps': ['nor_gl.x', 'nor_gl.y', 'Rough', 'Diffuse luminance (mean-normalised)'],
            'resolution': f'1k source, {q}px quadrants', 'bytes': os.path.getsize(out),
        })
        print(key, pid, os.path.getsize(out))
    with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)


if __name__ == '__main__':
    main()
