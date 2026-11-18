"""Fetch + pack the CC0 Poly Haven textures used by the first-person viewmodel.

Run: python -I scripts/viewmodel-assets.py <download-dir>
Each texture becomes one packed WebP in public/assets/viewmodel/:
  R,G = tangent-space normal X,Y (OpenGL convention, Z is reconstructed in the shader)
  B   = roughness
Writes public/assets/viewmodel/manifest.json.
"""
import json, os, sys, urllib.request
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'assets', 'viewmodel')
SIZE = 1024
GAIN = 2.5   # scans are very low contrast; amplify the XY tilt so 8-bit WebP keeps it (shader divides back)

# id -> purpose
TEXTURES = {
    'bi_stretch': 'glove back / finger fabric (stretch polyester)',
    'leather_white': 'glove palm synthetic leather',
    'stretch_poplin': 'sleeve cloth',
}


def fetch(url, dest):
    if not os.path.exists(dest):
        req = urllib.request.Request(url, headers={'User-Agent': 'asset-fetch/1.0'})
        with urllib.request.urlopen(req) as r, open(dest, 'wb') as f:
            f.write(r.read())
    return dest


def main():
    dl = sys.argv[1]
    os.makedirs(dl, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for tid, purpose in TEXTURES.items():
        req = urllib.request.Request(f'https://api.polyhaven.com/files/{tid}', headers={'User-Agent': 'asset-fetch/1.0'})
        files = json.load(urllib.request.urlopen(req))
        nor = files['nor_gl']['1k']['jpg']['url']
        rough = files['Rough']['1k']['jpg']['url']
        pn = fetch(nor, os.path.join(dl, f'{tid}_nor.jpg'))
        pr = fetch(rough, os.path.join(dl, f'{tid}_rough.jpg'))
        n = Image.open(pn).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        r = Image.open(pr).convert('L').resize((SIZE, SIZE), Image.LANCZOS)
        nr, ng, _ = n.split()
        amp = lambda v: max(0, min(255, int(round(128 + (v - 128) * GAIN))))
        nr, ng = nr.point(amp), ng.point(amp)
        packed = Image.merge('RGB', (nr, ng, r))
        name = f'{tid}_nr.webp'
        dest = os.path.join(OUT, name)
        packed.save(dest, 'WEBP', quality=88, method=6)
        manifest.append({
            'file': name, 'source': f'https://polyhaven.com/a/{tid}', 'license': 'CC0',
            'maps': ['nor_gl 1k', 'Rough 1k'], 'packing': f'R,G normal XY (GL, tilt x{GAIN}) / B roughness',
            'size': f'{SIZE}x{SIZE}', 'bytes': os.path.getsize(dest), 'use': purpose,
        })
        print(name, os.path.getsize(dest))
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump({'note': 'First-person viewmodel textures (Poly Haven, CC0). Everything else is procedural.',
                   'assets': manifest}, f, indent=2)


if __name__ == '__main__':
    main()
