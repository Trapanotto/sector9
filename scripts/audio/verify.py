#!/usr/bin/env python3
"""Post-build verification of the shipped library (no listening involved).

* every manifest entry exists, decodes with ffmpeg, and its decoded duration matches the manifest
* loops: the decoded audio around loopEnd must match the audio around loopStart (seam test),
  because the file carries periodic padding on both sides of the loop body
* decoded peak / inter-sample clipping after MP3 encoding
* total size vs budget

usage: python -I scripts/audio/verify.py      (writes scripts/audio/verify.md)
"""
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "audio")
SR = 44100
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def decode(p, ch):
    """decode keeping the native channel layout (ffmpeg's -ac 1 downmix is not a plain average)."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-f", "f32le", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.float32).reshape(-1, ch)
    return a


def lowpass(x, fc):
    N = 1 << int(np.ceil(np.log2(len(x) + 1)))
    X = np.fft.rfft(x, N)
    f = np.fft.rfftfreq(N, 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** 8), N)[: len(x)]


def main():
    with open(os.path.join(OUT, "manifest.json"), encoding="utf-8") as f:
        man = json.load(f)
    rows, bad, total = [], [], 0
    for name, s in man["sounds"].items():
        for v in s["variations"]:
            p = os.path.join(OUT, v["file"])
            if not os.path.exists(p):
                bad.append(f"{v['file']}: missing")
                continue
            total += os.path.getsize(p)
            xa = decode(p, v["channels"])
            pk = float(np.max(np.abs(xa)))
            x = np.mean(xa, axis=1)
            dur = len(x) / SR
            exp = v["duration"] + (2 * v["loopStart"] if v.get("loop") else 0)
            note = []
            if abs(dur - exp) > 0.08:
                note.append(f"duration {dur:.3f} != {exp:.3f}")
            if pk > 1.0:
                note.append(f"decoded peak {20*np.log10(pk):.2f} dBFS (inter-sample over)")
            seam = ""
            if v.get("loop"):
                ls, le = int(v["loopStart"] * SR), int(v["loopEnd"] * SR)
                w = int(0.02 * SR)
                # the audio 20 ms either side of loopEnd must equal the audio either side of loopStart.
                # (an untrimmed encoder delay shifts both points equally, so this also holds then)
                # compare below 1.5 kHz: MP3 does not preserve the waveform of noise-like highs, so a
                # broadband sample comparison would measure the codec, not the seam
                lo = lowpass(x, 1500)
                a, b = lo[ls - w: ls + w], lo[le - w: le + w]
                c = float(np.corrcoef(a, b)[0, 1]) if np.std(a) > 0 and np.std(b) > 0 else 1.0
                # level step heard at the wrap: last 20 ms before loopEnd vs first 20 ms after loopStart
                r1 = np.sqrt(np.mean(x[le - w: le] ** 2)) + 1e-9
                r2 = np.sqrt(np.mean(x[ls: ls + w] ** 2)) + 1e-9
                step = abs(20 * np.log10(r2 / r1))
                quiet = 20 * np.log10(np.sqrt(np.mean(a ** 2)) + 1e-12)
                seam = f"lf-corr {c:.4f} (seam window {quiet:.0f} dBFS) level change over seam {step:.1f} dB"
                # the level change is content (e.g. breathing rhythm) and is reported only; the correlation
                # proves the periodicity, unless the seam sits in near-silence where it is meaningless
                if c < 0.95 and quiet > -45:
                    note.append(f"loop seam mismatch ({seam})")
            rows.append((v["file"], f"{dur:.3f}", f"{20*np.log10(max(pk,1e-9)):.2f}", seam, "; ".join(note) or "ok"))
            if note:
                bad.append(f"{v['file']}: {'; '.join(note)}")
    md = ["# Library verification", "", f"{len(rows)} files decoded with ffmpeg, total {total/1e6:.2f} MB "
          f"(budget 12 MB, hard cap 20 MB).", "",
          f"Problems: {len(bad)}", ""] + [f"- {b}" for b in bad] + ["", "| file | decoded s | peak dBFS | loop seam | status |",
                                                                   "|---|---|---|---|---|"]
    md += [f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |" for r in rows]
    with open(os.path.join(HERE, "verify.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print(f"{len(rows)} files, {total/1e6:.2f} MB, {len(bad)} problems")
    for b in bad:
        print("  ", b)


if __name__ == "__main__":
    main()
