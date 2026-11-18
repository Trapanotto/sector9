"""Turn the Poly Haven 2k source JPGs cached by scripts/fetch-assets.mjs into the WebP files the game ships,
and write public/assets/manifest.json. Run after `npm run assets`:
    python -I scripts/optimize-assets.py
Reproducible: wipes and rewrites public/assets/textures from the cache.

Per set: <id>_diff.webp (sRGB albedo), <id>_nor.webp (OpenGL normal), <id>_arm.webp (R=AO, G=roughness, B=metalness).
For the surfaces that use parallax occlusion mapping (HEIGHT), the displacement map is auto-levelled and stored in the
ARM alpha channel (WebP keeps alpha in its own lossless-ish plane, so it does not bleed into AO/roughness).
SIZES must match SETS in src/world/materials.js (the decode size)."""
import json, os, shutil
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
CACHE = os.path.join(ROOT, 'node_modules', '.cache', 'polyhaven')
PUB = os.path.join(ROOT, 'public', 'assets')
OUT = os.path.join(PUB, 'textures')

# key: (diff, nor, arm) pixel size. 2k only where the player sees the surface up close.
SIZES = {
    'floor':      (2048, 2048, 1024),
    'wall':       (2048, 2048, 1024),
    'brick':      (2048, 2048, 1024),
    'ceiling':    (1024, 1024, 1024),
    'floor2':     (1024, 1024, 1024),
    'debris':     (1024, 1024, 512),
    'asphalt':    (1024, 1024, 512),
    'corrugated': (1024, 1024, 512),
    'rust':       (1024, 1024, 512),
    'plate':      (1024, 1024, 512),
    'wood':       (1024, 1024, 512),
    'paint':      (1024, 512, 512),
    'lino':       (1024, 1024, 512),
}
HEIGHT = {'floor', 'floor2', 'debris', 'wall', 'brick', 'ceiling'}
QUALITY = {'diff': 80, 'nor': 76, 'arm': 74}
DIFF_Q = {'floor': 90, 'wall': 88, 'floor2': 86, 'ceiling': 86}   # low-contrast sets lose scratches below ~86


def save(im, path, q, alpha=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(quality=q, method=6)
    if alpha:
        kw.update(alpha_quality=70, exact=True)
    im.save(path, 'WEBP', **kw)
    return os.path.getsize(path)


def fit(im, size):
    return im.resize((size, size), Image.LANCZOS) if max(im.size) != size else im


def main():
    src = json.load(open(os.path.join(CACHE, 'sources.json'), encoding='utf-8'))
    old = {}
    try:
        old = json.load(open(os.path.join(PUB, 'manifest.json'), encoding='utf-8'))
    except Exception:
        pass
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    man = {'source': src['source'], 'format': 'webp', 'textures': {}, 'hdri': src.get('hdri') or old.get('hdri')}
    total = 0
    for key, t in src['textures'].items():
        if key not in SIZES:
            continue
        sd, sn, sa = SIZES[key]
        maps = {}
        m = t['maps']
        def p(slot):
            return os.path.join(CACHE, m[slot]) if slot in m else None
        if p('diff'):
            im = fit(Image.open(p('diff')).convert('RGB'), sd)
            rel = f'textures/{key}/{t["id"]}_diff.webp'
            total += save(im, os.path.join(PUB, rel), DIFF_Q.get(key, QUALITY['diff'])); maps['diff'] = rel
        if p('nor'):
            im = fit(Image.open(p('nor')).convert('RGB'), sn)
            rel = f'textures/{key}/{t["id"]}_nor.webp'
            total += save(im, os.path.join(PUB, rel), QUALITY['nor']); maps['nor'] = rel
        if p('arm'):
            im = fit(Image.open(p('arm')).convert('RGB'), sa)
            alpha = False
            if key in HEIGHT and p('disp'):
                h = fit(Image.open(p('disp')).convert('L'), sa)
                h = ImageOps.autocontrast(h, cutoff=0.5)
                im = im.convert('RGBA'); im.putalpha(h); alpha = True
            rel = f'textures/{key}/{t["id"]}_arm.webp'
            total += save(im, os.path.join(PUB, rel), QUALITY['arm'], alpha); maps['arm'] = rel
            if alpha:
                maps['height'] = 'arm.a'
        man['textures'][key] = {'id': t['id'], 'use': t['use'], 'maps': maps}
        print(f'{key:11s} ' + ' '.join(f'{s}:{os.path.getsize(os.path.join(PUB, r)) // 1024}k' for s, r in maps.items() if r != 'arm.a'))
    man['totalBytes'] = total
    json.dump(man, open(os.path.join(PUB, 'manifest.json'), 'w', encoding='utf-8'), indent=2)
    print(f'textures: {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
