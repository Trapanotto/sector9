"""Curation helper: search Freesound (public HTML search page, no account / API key)
for CC0-only sounds and print candidates.  Not part of the build itself; it is how
the entries in sources.json were found.

usage: python -I scripts/audio/fs_search.py "query words" [pages] [sort]
sort: rating | downloads | relevance (default rating)
"""
import html
import re
import sys
import time
import urllib.parse
import urllib.request

import os

UA = "Mozilla/5.0 (compatible; sector9-asset-fetch/1.0)"
USER = os.environ.get("FS_USER", "")  # optional: restrict to one uploader
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
SORTS = {
    "rating": "Rating (highest first)",
    "downloads": "Downloads (most first)",
    "relevance": "Automatic by relevance",
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def search(q, pages=1, sort="rating", group_packs=False):
    out = []
    for p in range(1, pages + 1):
        params = {
            "q": q,
            "f": 'license:"Creative Commons 0"' + (f' username:"{USER}"' if USER else ""),
            "s": SORTS.get(sort, sort),
            "page": str(p),
            "g": "1" if group_packs else "",
        }
        page = fetch("https://freesound.org/search/?" + urllib.parse.urlencode(params))
        blocks = page.split('class="bw-player"')[1:]
        for b in blocks:
            def attr(n):
                m = re.search(n + r'="([^"]*)"', b)
                return html.unescape(m.group(1)) if m else ""
            sid = attr("data-sound-id")
            if not sid:
                continue
            desc_m = re.search(r'overflow-hidden v-spacing-1" >\s*(.*?)\s*</div>', b, re.S)
            desc = html.unescape(re.sub(r"<[^>]+>", "", desc_m.group(1))).strip() if desc_m else ""
            tags = re.findall(r'/browse/tags/([^/]+)/', b)
            out.append({
                "id": int(sid),
                "user": attr("data-username"),
                "title": attr("data-title"),
                "dur": float(attr("data-duration") or 0),
                "sr": attr("data-samplerate"),
                "dl": int(attr("data-num-downloads") or 0),
                "desc": desc[:160].replace("\n", " "),
                "tags": tags[:10],
            })
        time.sleep(1.0)
    return out


if __name__ == "__main__":
    q = sys.argv[1]
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sort = sys.argv[3] if len(sys.argv) > 3 else "rating"
    seen = set()
    for r in search(q, pages, sort):
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        print(f'{r["id"]:>7} {r["dur"]:6.2f}s dl={r["dl"]:<6} {r["user"][:16]:16} | {r["title"][:60]} | {r["desc"][:110]} | {",".join(r["tags"][:6])}')
