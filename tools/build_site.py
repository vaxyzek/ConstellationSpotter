#!/usr/bin/env python3
"""Assemble dist/ -- the static site, ready to publish.

The source tree keeps pages in web/ and data in data/, so the pages fetch
`../data/*.json`. A published site wants the game at its root instead, with the
data beside it, so this flattens the layout and rewrites that one path.

Everything in dist/ is generated; it is never edited by hand or committed.

    python3 tools/build_data.py    # produces data/*.json
    python3 tools/build_site.py    # produces dist/
"""

import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
DIST = os.path.join(ROOT, "dist")

# Pages and code copied to the root of dist/.
ASSETS = ["index.html", "compare.html", "game.js", "compare.js", "sky.js",
          "game.css", "compare.css"]
# Datasets copied to dist/data/.
DATASETS = ["constellations.json", "stars.json"]


def main():
    missing = [f for f in DATASETS if not os.path.exists(os.path.join(DATA, f))]
    if missing:
        sys.exit(f"missing {missing} -- run tools/build_data.py first")

    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, "data"))

    rewritten = 0
    for name in ASSETS:
        src = os.path.join(WEB, name)
        if not os.path.exists(src):
            sys.exit(f"missing web/{name}")
        with open(src, encoding="utf-8") as fh:
            text = fh.read()
        # data/ is a sibling of the pages in dist/, not one level up.
        text, n = re.subn(r"\.\./data/", "data/", text)
        rewritten += n
        with open(os.path.join(DIST, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    for name in DATASETS:
        shutil.copy2(os.path.join(DATA, name), os.path.join(DIST, "data", name))

    charts = os.path.join(WEB, "iau")
    n_charts = 0
    if os.path.isdir(charts):
        shutil.copytree(charts, os.path.join(DIST, "iau"))
        n_charts = len(os.listdir(os.path.join(DIST, "iau")))

    # A stray ../data/ would 404 only at runtime, so fail the build instead.
    for name in ASSETS:
        with open(os.path.join(DIST, name), encoding="utf-8") as fh:
            if "../data/" in fh.read():
                sys.exit(f"dist/{name} still refers to ../data/")

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(DIST) for f in fs)
    print(f"dist/           : {len(ASSETS)} pages/scripts, "
          f"{len(DATASETS)} datasets, {n_charts} IAU charts")
    print(f"path rewrites   : {rewritten}")
    print(f"total size      : {total / 1e6:.1f} MB")
    print("entry points    : /index.html (game), /compare.html (line check)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
