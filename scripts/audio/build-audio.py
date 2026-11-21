#!/usr/bin/env python3
"""SECTOR 9 recorded sound library builder.

Reproducible pipeline:  sources.json  ->  download (cache)  ->  licence check
->  decode  ->  cut / split into one-shots / build loops  ->  process  ->  QC
->  encode MP3  ->  public/assets/audio/**  +  manifest.json  +  CREDITS-AUDIO.md
+  scripts/audio/report.md / report.csv

usage
  python -I scripts/audio/build-audio.py build          # full build
  python -I scripts/audio/build-audio.py build voice.   # only entries whose name starts with "voice."
  python -I scripts/audio/build-audio.py inspect fs:325548 [thresh] [gap]
                                                         # print auto-split segments of a source

Requirements: Python 3.10+, numpy, ffmpeg (with libmp3lame) on PATH.
Only CC0 / public-domain sources are accepted: every Freesound page is fetched and its
licence link must be the CC0 deed (or the Public Domain Mark); Kenney packs must ship a
License.txt naming CC0.  Anything else aborts the build.

Nobody has listened to the output: all quality control is by signal analysis.
"""
import csv
import datetime
import hashlib
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
import zlib
from http.cookiejar import CookieJar

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(ROOT, "public", "assets", "audio")
SR = 48000            # internal processing rate
OUT_SR = 44100        # shipped rate
UA = "Mozilla/5.0 (compatible; sector9-asset-fetch/1.0)"
LOOP_PAD = 0.25       # seconds of periodic padding around loop bodies (see manifest docs)
CC0_RE = re.compile(r"creativecommons\.org/publicdomain/(zero/1\.0|mark/1\.0)")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------- category defaults
# norm: ("peak", dBFS) or ("rms", dBFS of active part, peak ceiling dBFS)
# gain: suggested base gain (linear) for the engine's mixer, relative between categories
# q:    LAME VBR quality (lower = better/bigger)
CATS = [
    ("voice.player",    dict(norm=("rms", -22, -3), gain=0.55, q=5)),
    ("voice.muffled",   dict(norm=("rms", -26, -6), gain=0.6, q=6)),
    ("voice.distant",   dict(norm=("rms", -24, -4), gain=0.45, q=6)),
    ("voice.snore",     dict(norm=("rms", -26, -6), gain=0.5, q=6)),
    ("voice.breath",    dict(norm=("rms", -24, -4), gain=0.5, q=5)),
    ("voice.",          dict(norm=("rms", -18, -1), gain=0.9, q=5)),
    ("weapon.pistol.shot", dict(norm=("peak", -0.5), gain=1.0, q=3)),
    ("weapon.distant",  dict(norm=("peak", -1.0), gain=0.35, q=5)),
    ("weapon.casing",   dict(norm=("peak", -3.0), gain=0.5, q=5)),
    ("weapon.",         dict(norm=("peak", -1.0), gain=0.9, q=4)),
    ("impact.",         dict(norm=("peak", -2.0), gain=0.8, q=4)),
    ("bullet.",         dict(norm=("peak", -2.0), gain=0.8, q=4)),
    ("debris.",         dict(norm=("peak", -3.0), gain=0.6, q=5)),
    ("glass.",          dict(norm=("peak", -2.0), gain=0.8, q=4)),
    ("machine.alarm",   dict(norm=("rms", -20, -2), gain=0.6, q=5)),
    ("step.",           dict(norm=("peak", -4.0), gain=0.45, q=5)),
    ("foley.",          dict(norm=("peak", -3.0), gain=0.7, q=5)),
    ("door.",           dict(norm=("peak", -2.0), gain=0.8, q=5)),
    ("machine.",        dict(norm=("rms", -24, -3), gain=0.7, q=5)),
    ("loop.",           dict(norm=("rms", -26, -6), gain=0.5, q=6)),
    ("amb.",            dict(norm=("rms", -28, -8), gain=0.45, q=6)),
    ("ir.",             dict(norm=("peak", -1.0), gain=1.0, q=4)),
    ("",                dict(norm=("peak", -3.0), gain=0.7, q=5)),
]


def cat_of(name):
    for pre, d in CATS:
        if name.startswith(pre):
            return d
    raise KeyError(name)


# ---------------------------------------------------------------- network
_last_req = [0.0]


def http_get(url, headers=None, opener=None, polite=1.0):
    wait = polite - (time.time() - _last_req[0])
    if wait > 0:
        time.sleep(wait)
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    for attempt in range(4):
        try:
            with (opener.open(req, timeout=120) if opener else urllib.request.urlopen(req, timeout=120)) as r:
                data = r.read()
                _last_req[0] = time.time()
                return data, r.geturl()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f"  retry {url}: {e}")
            time.sleep(3 * (attempt + 1))


def today():
    return datetime.date.today().isoformat()


def fs_fetch(sid):
    """Freesound sound: fetch page (licence + metadata) and HQ preview. Returns meta dict."""
    d = os.path.join(CACHE, "freesound")
    os.makedirs(d, exist_ok=True)
    mpath = os.path.join(d, f"{sid}.json")
    if os.path.exists(mpath):
        with open(mpath, encoding="utf-8") as f:
            meta = json.load(f)
        if os.path.exists(os.path.join(d, meta["file"])):
            return meta
    page, final = http_get(f"https://freesound.org/s/{sid}/")
    page = page.decode("utf-8", "replace")
    m = re.search(r"<title>Freesound - (.*?) by ([^<]*)</title>", page, re.S)
    if not m:
        raise RuntimeError(f"freesound {sid}: cannot parse title")
    title, user = html.unescape(m.group(1)).strip(), html.unescape(m.group(2)).strip()
    lic = re.search(r'title="Go to the full license text" href="([^"]+)"', page)
    if not lic or not CC0_RE.search(lic.group(1)):
        raise RuntimeError(f"freesound {sid} ({title}): licence is not CC0: {lic.group(1) if lic else '??'}")
    prev = re.search(r'(https://cdn\.freesound\.org/previews/\d+/\d+_\d+)-hq\.mp3', page)
    if not prev:
        raise RuntimeError(f"freesound {sid}: no preview url")
    base = prev.group(1)
    fname, data = None, None
    for ext in ("-hq.ogg", "-hq.mp3"):
        try:
            data, _ = http_get(base + ext, polite=0.5)
            fname = f"{sid}{ext.replace('-hq', '')}"
            break
        except Exception:  # noqa: BLE001
            continue
    if data is None:
        raise RuntimeError(f"freesound {sid}: preview download failed")
    with open(os.path.join(d, fname), "wb") as f:
        f.write(data)
    meta = dict(id=sid, title=title, author=user, url=final, licence="CC0 1.0" if "zero" in lic.group(1) else "Public Domain Mark 1.0",
                licence_url=lic.group(1), file=fname, fetched=today(), preview=base + ext,
                sha1=hashlib.sha1(data).hexdigest())
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    return meta


KENNEY_PACKS = {
    "impact-sounds": "Impact Sounds",
    "rpg-audio": "RPG Audio",
}


def kenney_fetch(pack, member):
    d = os.path.join(CACHE, "kenney")
    os.makedirs(d, exist_ok=True)
    zpath = os.path.join(d, pack + ".zip")
    xdir = os.path.join(d, pack)
    mpath = os.path.join(d, pack + ".json")
    if not os.path.exists(zpath):
        cj = CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        page_url = f"https://kenney.nl/assets/{pack}"
        page, _ = http_get(page_url, opener=op)
        page = page.decode("utf-8", "replace")
        if "CC0" not in page:
            raise RuntimeError(f"kenney {pack}: page does not state CC0")
        did = re.search(r"data-download-id='([0-9a-f]+)'", page).group(1)
        link, _ = http_get(f"https://kenney.nl/download-link/{did}", opener=op, headers={"Referer": page_url})
        url = json.loads(link)["url"]
        data, _ = http_get(url, opener=op, headers={"Referer": page_url})
        with open(zpath, "wb") as f:
            f.write(data)
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(dict(fetched=today(), url=page_url, sha1=hashlib.sha1(data).hexdigest()), f)
    if not os.path.isdir(xdir):
        with zipfile.ZipFile(zpath) as z:
            for n in z.namelist():  # safe extraction
                p = os.path.normpath(os.path.join(xdir, n))
                if not p.startswith(os.path.normpath(xdir)):
                    raise RuntimeError("zip path escape")
            z.extractall(xdir)
    with open(os.path.join(xdir, "License.txt"), encoding="utf-8", errors="replace") as f:
        if "CC0" not in f.read():
            raise RuntimeError(f"kenney {pack}: License.txt does not name CC0")
    with open(mpath, encoding="utf-8") as f:
        pm = json.load(f)
    fpath = os.path.join(xdir, member)
    if not os.path.exists(fpath):
        raise RuntimeError(f"kenney {pack}: missing {member}")
    return dict(id=f"{pack}/{member}", title=f"{KENNEY_PACKS.get(pack, pack)} - {os.path.basename(member)}",
                author="Kenney (kenney.nl)", url=pm["url"], licence="CC0 1.0",
                licence_url="http://creativecommons.org/publicdomain/zero/1.0/", fetched=pm["fetched"],
                path=fpath, pack=pack)


def source(src):
    kind, ref = src.split(":", 1)
    if kind == "fs":
        meta = fs_fetch(int(ref))
        meta["path"] = os.path.join(CACHE, "freesound", meta["file"])
        meta["key"] = f"freesound:{ref}"
        return meta
    if kind == "kenney":
        pack, member = ref.split("/", 1)
        meta = kenney_fetch(pack, member)
        meta["key"] = f"kenney:{pack}"
        return meta
    raise ValueError(src)


# ---------------------------------------------------------------- audio io
def decode(path, channels):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", str(channels), "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T.copy()
    return a  # shape (ch, n)


def encode_mp3(x, path, q):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ch = x.shape[0]
    data = np.ascontiguousarray(x.T.astype(np.float32)).tobytes()
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(ch), "-i", "-",
           "-ar", str(OUT_SR), "-c:a", "libmp3lame", "-q:a", str(q), "-map_metadata", "-1",
           "-id3v2_version", "0", "-write_xing", "1", path]
    subprocess.run(cmd, input=data, check=True)


def decoded_peak(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return float(np.max(np.abs(np.frombuffer(raw, np.float32))))


# ---------------------------------------------------------------- dsp helpers
def db(x):
    return 20 * np.log10(np.maximum(x, 1e-9))


def frame_rms(m, hop=0.01, win=0.02):
    h, w = int(SR * hop), int(SR * win)
    n = max(1, (len(m) - w) // h + 1)
    if len(m) < w:
        return np.array([np.sqrt(np.mean(m ** 2) + 1e-20)])
    idx = np.arange(n)[:, None] * h + np.arange(w)[None, :]
    return np.sqrt(np.mean(m[idx] ** 2, axis=1) + 1e-20)


def segments(m, thresh=-30.0, gap=0.12, min_len=0.12, pre=0.03, tail=0.35, max_len=None, floor_margin=10.0):
    """Auto-split mono signal into events. Returns list of (start, end) in samples."""
    env = db(frame_rms(m))
    hop = int(SR * 0.01)
    ref = np.max(env)
    floor = np.percentile(env, 10)
    th = max(ref + thresh, floor + floor_margin)
    act = env > th
    segs, i, n = [], 0, len(env)
    while i < n:
        if act[i]:
            j = i
            while j < n and act[j]:
                j += 1
            segs.append([i, j])
            i = j
        else:
            i += 1
    merged = []
    for s in segs:
        if merged and (s[0] - merged[-1][1]) * 0.01 < gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    out = []
    for k, (a, b) in enumerate(merged):
        lo = merged[k - 1][1] if k > 0 else 0
        hi = merged[k + 1][0] if k + 1 < len(merged) else n
        a2 = max(lo, a - int(pre / 0.01))
        b2 = b
        lim = min(hi, b + int(tail / 0.01))
        while b2 < lim and env[b2] > th - 18:
            b2 += 1
        sa, sb = a2 * hop, min(len(m), b2 * hop + hop)
        if (sb - sa) / SR < min_len:
            continue
        if max_len and (sb - sa) / SR > max_len:
            sb = sa + int(max_len * SR)
        out.append((sa, sb))
    return out


def fade(x, fin=0.003, fout=0.03):
    x = x.copy()
    n = x.shape[-1]
    a, b = min(n // 4, int(fin * SR)), min(n // 3, int(fout * SR))
    if a > 0:
        x[..., :a] *= np.linspace(0, 1, a) ** 2
    if b > 0:
        x[..., n - b:] *= np.linspace(1, 0, b) ** 2
    return x


def spectral_filter(x, hp=None, lp=None, order=2):
    n = x.shape[-1]
    N = 1 << int(np.ceil(np.log2(n + 1)))
    X = np.fft.rfft(x, N, axis=-1)
    f = np.fft.rfftfreq(N, 1 / SR)
    g = np.ones_like(f)
    if lp:
        g *= 1 / np.sqrt(1 + (f / lp) ** (2 * order))
    if hp:
        with np.errstate(divide="ignore"):
            g *= 1 / np.sqrt(1 + (hp / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * g, N, axis=-1)[..., :n].astype(np.float32)


def synth_ir(decay, seed, predelay=0.02, lp=6000, length=None, stereo=False):
    rng = np.random.default_rng(seed)
    L = int(SR * (length or decay * 1.2))
    t = np.arange(L) / SR
    ch = 2 if stereo else 1
    ir = rng.standard_normal((ch, L)).astype(np.float32) * np.exp(-6.91 * t / decay)
    ir = spectral_filter(ir, lp=lp, order=1)
    pd = int(SR * predelay)
    ir = np.concatenate([np.zeros((ch, pd), np.float32), ir], axis=1)
    return ir / np.sqrt(np.sum(ir ** 2))


def convolve(x, ir):
    n = x.shape[-1] + ir.shape[-1] - 1
    N = 1 << int(np.ceil(np.log2(n)))
    y = np.fft.irfft(np.fft.rfft(x, N, axis=-1) * np.fft.rfft(ir, N, axis=-1), N, axis=-1)[..., :n]
    return y.astype(np.float32)


def reverb(x, decay, wet, seed=1, predelay=0.02, lp=5000):
    ir = synth_ir(decay, seed, predelay, lp)
    pad = np.zeros((x.shape[0], ir.shape[-1]), np.float32)
    dry = np.concatenate([x, pad], axis=1)
    w = convolve(x, ir[:1])[..., :dry.shape[-1]]
    if w.shape[-1] < dry.shape[-1]:
        w = np.pad(w, ((0, 0), (0, dry.shape[-1] - w.shape[-1])))
    w *= np.sqrt(np.mean(x ** 2) / max(np.mean(w ** 2), 1e-20))
    y = dry * (1 - wet) + w * wet
    # trim reverb tail below -60 dB of peak
    env = db(frame_rms(np.max(np.abs(y), axis=0)))
    pk = np.max(env)
    last = np.nonzero(env > pk - 55)[0]
    end = min(y.shape[-1], (last[-1] + 2) * int(SR * 0.01)) if len(last) else y.shape[-1]
    return fade(y[..., :end], 0, 0.05)


def resample_speed(x, factor):
    n = x.shape[-1]
    m = int(n / factor)
    t = np.linspace(0, n - 1, m)
    return np.stack([np.interp(t, np.arange(n), c) for c in x]).astype(np.float32)


def apply_fx(x, fx, seed):
    for f in fx or []:
        k, _, v = f.partition(":")
        if k == "lp":
            x = spectral_filter(x, lp=float(v), order=2)
        elif k == "hp":
            x = spectral_filter(x, hp=float(v), order=2)
        elif k == "gain":
            x = x * 10 ** (float(v) / 20)
        elif k == "speed":
            x = resample_speed(x, float(v))
        elif k == "muffle":      # heard through a closed door / wall
            x = spectral_filter(x, hp=90, lp=float(v or 420), order=3)
            x = reverb(x, 0.35, 0.25, seed)
        elif k == "distant":     # heard from another room in a big concrete building
            x = spectral_filter(x, hp=180, lp=float(v or 1800), order=2)
            x = reverb(x, 1.8, 0.65, seed, predelay=0.04, lp=2500)
        elif k == "far":         # far away outdoors: air absorption + a little slap-back
            x = spectral_filter(x, hp=150, lp=float(v or 1200), order=2)
            x = reverb(x, 0.9, 0.4, seed, predelay=0.06, lp=2000)
        elif k == "room":
            d, _, w = v.partition(",")
            x = reverb(x, float(d), float(w or 0.3), seed)
        elif k == "reverse":
            x = x[..., ::-1].copy()
        else:
            raise ValueError(f"unknown fx {f}")
    return x


def make_loop(x, length, xfade):
    """Return periodic loop body of `length` s built from x with an equal-power crossfade."""
    L, X = int(length * SR), int(xfade * SR)
    if x.shape[-1] < L + X:
        raise RuntimeError(f"loop source too short: {x.shape[-1] / SR:.1f}s < {length + xfade:.1f}s")
    body = x[..., :L].copy()
    t = np.linspace(0, np.pi / 2, X)
    body[..., :X] = x[..., L:L + X] * np.cos(t) + x[..., :X] * np.sin(t)
    return body


# ---------------------------------------------------------------- analysis
def k_weight_gain(f):
    """|H(f)| of the BS.1770 K-weighting (shelf + RLB high-pass) evaluated analytically."""
    def biq(b, a, f):
        z = np.exp(-1j * 2 * np.pi * f / 48000)
        return np.abs((b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z))
    s = biq([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585], f)
    h = biq([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621], f)
    return s * h


def lufs(x):
    n = x.shape[-1]
    N = 1 << int(np.ceil(np.log2(n + 1)))
    X = np.fft.rfft(x, N, axis=-1)
    f = np.fft.rfftfreq(N, 1 / SR)
    y = np.fft.irfft(X * k_weight_gain(f), N, axis=-1)[..., :n]
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if n < blk:
        z = np.sum(np.mean(y ** 2, axis=-1))
        return -0.691 + 10 * np.log10(max(z, 1e-12)), True
    starts = np.arange(0, n - blk + 1, hop)
    z = np.array([np.sum(np.mean(y[:, s:s + blk] ** 2, axis=-1)) for s in starts])
    l = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
    g = z[l > -70]
    if len(g) == 0:
        return -70.0, False
    rel = -0.691 + 10 * np.log10(np.mean(g)) - 10
    g2 = z[(l > -70) & (l > rel)]
    return -0.691 + 10 * np.log10(np.mean(g2)), False


def analyse(x, src_clip_runs=0):
    m = np.mean(x, axis=0)
    n = len(m)
    peak = float(np.max(np.abs(x)))
    env = db(frame_rms(m))
    loud, short = lufs(x)
    act = env > np.max(env) - 30
    rms_act = float(db(np.sqrt(np.mean((10 ** (env[act] / 20)) ** 2)))) if act.any() else -120.0
    N = 1 << int(np.ceil(np.log2(n + 1)))
    P = np.abs(np.fft.rfft(m, N)) ** 2
    f = np.fft.rfftfreq(N, 1 / SR)
    band = (f >= 20)
    tot = np.sum(P[band]) + 1e-20
    centroid = float(np.sum(f[band] * P[band]) / tot)
    speech = float(np.sum(P[(f >= 250) & (f <= 4000)]) / tot)
    low = float(np.sum(P[(f >= 20) & (f < 250)]) / tot)
    clip = int(np.sum(np.abs(x) >= 0.999))
    silence = float(np.mean(env < -50))
    floor = float(np.percentile(env, 10))
    top = float(np.percentile(env, 95))
    return dict(dur=round(n / SR, 3), peak_db=round(float(db(peak)), 2), lufs=round(float(loud), 1), lufs_short=short,
                rms_act_db=round(rms_act, 1), centroid=int(centroid), speech_ratio=round(speech, 3),
                low_ratio=round(low, 3), clip=clip, src_clip_runs=src_clip_runs, silence=round(silence, 3),
                snr_db=round(top - floor, 1))


def clip_runs(x, run=3):
    """count runs of >= `run` consecutive near-full-scale samples (flat-topped clipping in the source)."""
    c = 0
    for ch in x:
        hot = np.abs(ch) >= 0.98 * np.max(np.abs(ch))
        if np.max(np.abs(ch)) < 0.9:
            continue
        d = np.diff(np.concatenate([[0], hot.astype(np.int8), [0]]))
        s, e = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
        c += int(np.sum((e - s) >= run))
    return c


def normalise(x, norm):
    peak = float(np.max(np.abs(x))) + 1e-12
    if norm[0] == "peak":
        return x * (10 ** (norm[1] / 20) / peak)
    target, ceil = norm[1], norm[2]
    env = frame_rms(np.mean(x, axis=0))
    act = env[db(env) > db(np.max(env)) - 30]
    r = float(np.sqrt(np.mean(act ** 2)))
    g = 10 ** (target / 20) / max(r, 1e-9)
    g = min(g, 10 ** (ceil / 20) / peak)   # never limit/compress: reduce gain instead
    return x * g


# ---------------------------------------------------------------- QC rules
def qc(name, a, e):
    why = []
    if a["clip"] > 0:
        why.append(f"clipped output samples ({a['clip']})")
    if e.get("qc") == "off":
        return why
    if name.startswith("voice.") and not name.startswith(("voice.snore", "voice.muffled", "voice.distant")):
        if a["speech_ratio"] < 0.35 and not name.startswith("voice.breath"):
            why.append(f"speech-band energy {a['speech_ratio']:.2f} < 0.35")
    # continuous beds (loops) have no silence by design, so the dynamic-range test only applies to one-shots
    if e.get("mode") != "loop" and not name.startswith(("loop.", "amb.", "ir.", "machine.")) \
            and a["snr_db"] < e.get("min_snr", 12):
        why.append(f"low dynamic range / noisy (snr {a['snr_db']} dB)")
    if a["src_clip_runs"] > e.get("max_clip_runs", 40):
        why.append(f"source heavily clipped ({a['src_clip_runs']} flat runs)")
    return why


# ---------------------------------------------------------------- build
def load_sources():
    with open(os.path.join(HERE, "sources.json"), encoding="utf-8") as f:
        return json.load(f)


def out_name(name, idx):
    parts = name.split(".")
    return os.path.join(parts[0], "_".join(parts[1:]) + f"_{idx:02d}.mp3")


def cut_entry(e, meta):
    ch = 2 if e.get("stereo") else 1
    x = decode(meta["path"], ch)
    if "range" in e:
        a, b = e["range"]
        x = x[:, int(a * SR): int(b * SR) if b else None]
        if e.get("onset", e.get("mode", "whole") == "whole"):
            # start exactly on the first strong transient inside the range (avoids starting in a tail)
            env = db(frame_rms(np.mean(x, axis=0), hop=0.002, win=0.004))
            k = int(np.argmax(env > np.max(env) - 12))
            x = x[:, max(0, k * int(SR * 0.002) - int(SR * 0.004)):]
    src_runs = clip_runs(x)
    mode = e.get("mode", "whole")
    clips = []
    if mode == "whole":
        m = np.mean(x, axis=0)
        sp = e.get("split", {})
        segs = segments(m, sp.get("thresh", -45), gap=1e9, min_len=0.0, tail=sp.get("tail", 2.0))
        if segs and e.get("trim", True):
            a, b = segs[0][0], segs[-1][1]
            x = x[:, a:b]
        clips = [x]
    elif mode == "split":
        m = np.mean(x, axis=0)
        sp = e.get("split", {})
        segs = segments(m, sp.get("thresh", -30), sp.get("gap", 0.12), sp.get("min", 0.12), sp.get("pre", 0.03),
                        sp.get("tail", 0.35), sp.get("max"), sp.get("floor_margin", 10.0))
        clips = [x[:, a:b] for a, b in segs]
        if "pick" in e:
            clips = [clips[i] for i in e["pick"] if i < len(clips)]
        if "minpk" in e and clips:   # keep only takes within minpk dB of the loudest take
            pk = [float(np.max(np.abs(c))) for c in clips]
            clips = [c for c, p in zip(clips, pk) if db(p) >= db(max(pk)) + e["minpk"]]
        if "max" in e and len(clips) > e["max"]:   # evenly spread across the recording
            idx = np.round(np.linspace(0, len(clips) - 1, e["max"])).astype(int)
            clips = [clips[i] for i in idx]
    elif mode == "loop":
        lp = e["loop"]
        # effects go on the source *before* the loop is closed, so reverb tails wrap seamlessly
        x = apply_fx(x, e.get("fx"), seed=zlib.crc32(e["src"].encode()) % 1000)
        clips = [make_loop(x, lp["len"], lp.get("xfade", 1.0))]
    else:
        raise ValueError(mode)
    return clips, src_runs


def build(prefix=""):
    entries = load_sources()
    entries = [e for e in entries if e["name"].startswith(prefix)]
    manifest_path = os.path.join(OUT, "manifest.json")
    old = {}
    if prefix and os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            old = json.load(f)
    sounds, credits, rows, rejected = {}, {}, [], []
    counters = {}
    if not prefix:
        for dp, _, fns in os.walk(OUT):
            for fn in fns:
                if fn.endswith(".mp3"):
                    os.remove(os.path.join(dp, fn))
    else:
        for n in list(old.get("sounds", {})):
            if n.startswith(prefix):
                for v in old["sounds"][n]["variations"]:
                    p = os.path.join(OUT, v["file"])
                    if os.path.exists(p):
                        os.remove(p)
    for ei, e in enumerate(entries):
        name = e["name"]
        try:
            meta = source(e["src"])
        except Exception as ex:  # noqa: BLE001
            print(f"!! {name} {e['src']}: {ex}")
            rejected.append(dict(name=name, src=e["src"], why=str(ex)))
            continue
        clips, src_runs = cut_entry(e, meta)
        cat = cat_of(name)
        for ci, c in enumerate(clips):
            is_loop = e.get("mode") == "loop"
            if not is_loop:
                c = apply_fx(c, e.get("fx"), seed=ei * 100 + ci)
            if not is_loop:
                c = fade(c, e.get("fade_in", 0.002), e.get("fade_out", 0.03))
            c = normalise(c, tuple(e.get("norm", cat["norm"])))
            if e.get("gain_db"):
                c = c * 10 ** (e["gain_db"] / 20)
            a = analyse(c, src_runs)
            why = qc(name, a, e)
            label = f"{name} <- {e['src']}#{ci}"
            row = dict(name=name, src=e["src"], seg=ci, **a)
            if why and not e.get("force"):
                row["status"] = "REJECT: " + "; ".join(why)
                rows.append(row)
                rejected.append(dict(name=name, src=e["src"], seg=ci, why="; ".join(why)))
                print(f"-- reject {label}: {'; '.join(why)}")
                continue
            idx = counters.get(name, 0) + 1
            counters[name] = idx
            rel = out_name(name, idx).replace("\\", "/")
            body = c
            loop_info = None
            if is_loop:
                P = int(LOOP_PAD * SR)
                body = np.concatenate([c[:, -P:], c, c[:, :P]], axis=1)
                loop_info = dict(loopStart=LOOP_PAD, loopEnd=round(LOOP_PAD + c.shape[-1] / SR, 6))
            encode_mp3(body, os.path.join(OUT, rel), e.get("q", cat["q"]))
            # MP3 can overshoot the source peak (inter-sample / pre-echo); decode and back off if needed
            for _ in range(2):
                dpk = decoded_peak(os.path.join(OUT, rel))
                if dpk <= 10 ** (-0.3 / 20):
                    break
                g = 10 ** (-0.6 / 20) / dpk
                c, body = c * g, body * g
                encode_mp3(body, os.path.join(OUT, rel), e.get("q", cat["q"]))
                a = analyse(c, src_runs)
                row.update(a)
            size = os.path.getsize(os.path.join(OUT, rel))
            row.update(status="ok" + (" (forced: " + "; ".join(why) + ")" if why else ""), file=rel, bytes=size)
            rows.append(row)
            var = dict(file=rel, duration=a["dur"], peak_db=a["peak_db"], lufs=a["lufs"], channels=int(c.shape[0]),
                       loop=bool(is_loop), bytes=size, source=meta["key"] if meta["key"].startswith("kenney") else f"freesound:{meta['id']}")
            if loop_info:
                var.update(loop_info)
            if e.get("text"):
                var["text"] = e["text"][ci] if isinstance(e["text"], list) else e["text"]
            s = sounds.setdefault(name, dict(gain=e.get("base_gain", cat["gain"]), variations=[]))
            if "desc" in e and "desc" not in s:
                s["desc"] = e["desc"]
            s["variations"].append(var)
            ckey = meta["key"] if meta["key"].startswith("freesound") else f"kenney:{meta['pack']}"
            cr = credits.setdefault(ckey, dict(title=meta["title"] if ckey.startswith("freesound") else KENNEY_PACKS[meta["pack"]],
                                               author=meta["author"], url=meta["url"], licence=meta["licence"],
                                               licence_url=meta["licence_url"], fetched=meta["fetched"], outputs=[]))
            cr["outputs"].append(rel)
            print(f"ok {rel:44s} {a['dur']:6.2f}s pk {a['peak_db']:6.1f} L {a['lufs']:6.1f} cen {a['centroid']:5d} sp {a['speech_ratio']:.2f} snr {a['snr_db']}")
    if prefix and old:
        for n, s in old.get("sounds", {}).items():
            if not n.startswith(prefix):
                sounds.setdefault(n, s)
        for k, c in old.get("_credits", {}).items():
            outs = [o for o in c["outputs"] if not any(o == v["file"] for n2, s in old["sounds"].items() if n2.startswith(prefix) for v in s["variations"])]
            if k in credits:
                credits[k]["outputs"] = sorted(set(credits[k]["outputs"]) | set(outs))
            elif outs:
                c = dict(c)
                c["outputs"] = outs
                credits[k] = c
    write_outputs(sounds, credits, rows, rejected, prefix)


def write_outputs(sounds, credits, rows, rejected, prefix):
    total = sum(v["bytes"] for s in sounds.values() for v in s["variations"])
    manifest = {
        "version": 1,
        "generated": today(),
        "format": "mp3 (MPEG-1 Layer III, LAME VBR, 44.1 kHz) - decodable by decodeAudioData in Chromium, Firefox and Safari",
        "notes": [
            "gain = suggested base gain (linear) for the mixer; files are normalised per category (peak for weapons/impacts, active-RMS for voices/loops).",
            "Loops: play with source.loop=true, loopStart/loopEnd (seconds). The file carries "
            f"{LOOP_PAD}s of periodic padding on both sides, so the loop stays seamless whether or not the browser trims the MP3 encoder delay.",
            "Mono files are positional one-shots; stereo files are non-positional beds.",
            "Nobody has listened to these files; QC was by signal analysis only (see scripts/audio/report.md).",
        ],
        "totalBytes": total,
        "sounds": dict(sorted(sounds.items())),
        "_credits": dict(sorted(credits.items())),
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
    # credits markdown
    lines = ["# Audio credits (SECTOR 9)", "",
             "Every shipped sound in `public/assets/audio/` is derived from a CC0 / public-domain recording.",
             "The licence of each source was read from its source page at fetch time by `scripts/audio/build-audio.py`",
             "(the build aborts if a Freesound page does not link the CC0 deed / Public Domain Mark, or if a Kenney pack's",
             "License.txt does not name CC0). Attribution is not required by CC0 but is given here anyway.",
             "Freesound files were taken from the public HQ preview of the sound page (no account used).", "",
             "Derivative processing (cutting, filtering, synthetic reverb, normalisation, MP3 encoding) was done by the build script",
             "and is likewise released under CC0.", "",
             "| # | Title | Author | Source | Licence | Fetched | Output files |", "|---|---|---|---|---|---|---|"]
    for i, (k, c) in enumerate(sorted(credits.items()), 1):
        outs = ", ".join(f"`{o}`" for o in sorted(c["outputs"]))
        t = c["title"].replace("|", "\\|")
        lines.append(f"| {i} | {t} | {c['author']} | <{c['url']}> | [{c['licence']}]({c['licence_url']}) | {c['fetched']} | {outs} |")
    with open(os.path.join(ROOT, "CREDITS-AUDIO.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if prefix:
        print(f"partial build ({prefix}): report not rewritten")
        return
    cols = ["status", "name", "file", "src", "seg", "dur", "peak_db", "lufs", "rms_act_db", "centroid", "speech_ratio",
            "low_ratio", "silence", "snr_db", "clip", "src_clip_runs", "bytes"]
    with open(os.path.join(HERE, "report.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    md = ["# Audio QC report", "", f"Generated {today()} by build-audio.py. Nobody has listened to these files.", "",
          f"Shipped: {sum(len(s['variations']) for s in sounds.values())} files in {len(sounds)} logical sounds, "
          f"{total / 1e6:.2f} MB. Rejected clips: {len(rejected)}.", "",
          "Columns: dur s, peak dBFS, integrated LUFS (`*` = clip shorter than 400 ms, single block), active RMS dBFS,",
          "spectral centroid Hz, speech-band (250-4000 Hz) energy ratio, <250 Hz energy ratio, silence ratio (frames < -50 dBFS),",
          "dynamic range p95-p10 of 10 ms frames (dB), clipped output samples, flat-topped runs in the source.", "",
          "## Per logical sound", "", "| sound | n | dur range s | mean LUFS | mean centroid | gain |", "|---|---|---|---|---|---|"]
    for n, s in sorted(sounds.items()):
        v = s["variations"]
        md.append(f"| {n} | {len(v)} | {min(x['duration'] for x in v):.2f}-{max(x['duration'] for x in v):.2f} | "
                  f"{np.mean([x['lufs'] for x in v]):.1f} | "
                  f"{int(np.mean([r['centroid'] for r in rows if r.get('file') in [x['file'] for x in v]]))} | {s['gain']} |")
    md += ["", "## All clips", "",
           "| status | file / name | src | dur | peak | LUFS | cent | speech | low | sil | DR | clip | srcclip |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r['status']} | {r.get('file', r['name'])} | {r['src']}#{r['seg']} | {r['dur']} | {r['peak_db']} | "
                  f"{r['lufs']}{'*' if r['lufs_short'] else ''} | {r['centroid']} | {r['speech_ratio']} | {r['low_ratio']} | "
                  f"{r['silence']} | {r['snr_db']} | {r['clip']} | {r['src_clip_runs']} |")
    if rejected:
        md += ["", "## Rejected", ""] + [f"- {r['name']} {r['src']}#{r.get('seg', '-')}: {r['why']}" for r in rejected]
    with open(os.path.join(HERE, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print(f"\n{sum(len(s['variations']) for s in sounds.values())} files, {len(sounds)} sounds, {total / 1e6:.2f} MB, {len(rejected)} rejected")


def inspect(src, thresh=-30.0, gap=0.12, stereo=False):
    meta = source(src)
    x = decode(meta["path"], 1)
    m = x[0]
    print(f"{meta['title']} by {meta['author']} ({meta['licence']}) {len(m) / SR:.2f}s peak {db(np.max(np.abs(m))):.1f} dB src-clip-runs {clip_runs(x)}")
    a = analyse(x)
    print(f"  whole: cent {a['centroid']} speech {a['speech_ratio']} low {a['low_ratio']} snr {a['snr_db']} sil {a['silence']}")
    for i, (s, e) in enumerate(segments(m, thresh, gap)):
        c = x[:, s:e]
        a = analyse(c)
        print(f"  [{i:2d}] {s / SR:7.2f}-{e / SR:7.2f} ({(e - s) / SR:5.2f}s) pk {a['peak_db']:6.1f} rms {a['rms_act_db']:6.1f} cent {a['centroid']:5d} sp {a['speech_ratio']:.2f} low {a['low_ratio']:.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    if cmd == "build":
        build(sys.argv[2] if len(sys.argv) > 2 else "")
    elif cmd == "inspect":
        for s in sys.argv[2].split(","):
            inspect(s, float(sys.argv[3]) if len(sys.argv) > 3 else -30.0, float(sys.argv[4]) if len(sys.argv) > 4 else 0.12)
    else:
        print(__doc__)
