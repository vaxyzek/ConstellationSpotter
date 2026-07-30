#!/usr/bin/env python3
"""Build constellation + star datasets from Stellarium (Sky & Telescope) and HYG.

Inputs  (data/raw/):
  modern_st_index.json  Stellarium "modern_st" sky culture: 88 constellations,
                        stick-figure lines as HIP-number polylines, plus the
                        IAU boundary edges (B1875).
  hygdata_v41.csv       HYG v4.1 star catalogue: HIP -> RA/Dec/mag/colour.

Outputs (data/):
  constellations.json   lines (as HIP polylines), boundary polygons (J2000),
                        centre + angular radius for framing.
  stars.json            every star to MAG_LIMIT, plus every star referenced by
                        a constellation line regardless of magnitude.

The S&T line set is used because the official IAU constellation charts were
drawn by Sky & Telescope, so the stick figures should match the IAU GIFs
exactly -- which is what tools/compare lets us verify by eye.
"""

import csv
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data")

MAG_LIMIT = 6.5  # naked-eye limit under a dark sky

# HYG blanks the `hip` column for a few resolved doubles, so stars referenced by
# a constellation line can go missing. Fall back to the HD number for those.
HIP_TO_HD = {
    55203: 98231,  # Xi UMa / Alula Australis, split into A+B by HYG
}

# Serpens is officially one constellation, but its two halves lie on opposite
# sides of Ophiuchus -- roughly 70 degrees apart -- so a single entry can never
# be framed sensibly, and the IAU charts them on separate sheets anyway. They
# are emitted as two entries carrying `parent: "Ser"`, which also means every
# entry has exactly one chart and one boundary region.
SPLITS = {
    "Ser": [
        {"abbr": "SerCp", "name": "Serpens Caput", "english": "Serpent's Head",
         "lines": [0], "edges": "SER1", "iau": "SERCP"},
        {"abbr": "SerCd", "name": "Serpens Cauda", "english": "Serpent's Tail",
         "lines": [1], "edges": "SER2", "iau": "SERCD"},
    ],
}

# Boundary codes that are deliberately not folded into an abbreviation, because
# a split above consumes them individually.
EDGE_ONLY_CODES = {"SER1", "SER2"}

# Deliberate departures from Stellarium's modern_st, each checked by eye against
# the IAU chart for that constellation. `expect` is the upstream figure these
# were decided against -- if upstream changes, the build warns instead of
# silently applying a stale correction.
FIGURE_OVERRIDES = {
    # Sky & Telescope draws no figure for these two: they have zero records in
    # SnT_constellations.txt, and the IAU charts show an empty region. The
    # alpha-beta line modern_st carries has no counterpart on the chart.
    "Men": {"expect": [[29271, 23467]], "lines": []},
    "Mic": {"expect": [[102831, 102989]], "lines": []},

    # S&T ends the alpha line at a point it labels 'd-g' -- the exact midpoint
    # of gamma and delta, not a star (measured 0.9 px from the midpoint on the
    # chart, vs 6.5 and 7.8 px from the two stars). modern_st snapped it to
    # gamma; delta is equidistant and reads closer to the drawn line.
    "Aps": {"expect": [[72370, 81065], [80047, 81852, 81065]],
            "lines": [[72370, 80047], [80047, 81852, 81065]]},
}

# Russian names come from Stellarium's translation of the S&T figure names, which
# is the conventional Russian name in almost every case. These few are literal
# translations of the English rather than the name Russian astronomy actually
# uses, so they are corrected here.
RU_OVERRIDES = {
    "Peg": "Пегас",           # po has "Крылатый конь" (winged horse)
    "Pic": "Живописец",       # po has "Мольберт художника" (painter's easel)
    "Hya": "Гидра",           # po has "Водяная змея", which reads as Hydrus
    "Dor": "Золотая Рыба",    # po has "Рыба-меч" (swordfish)
    # The split halves have no S&T entry of their own.
    "SerCp": "Голова Змеи",
    "SerCd": "Хвост Змеи",
}


def load_russian_names():
    """english S&T figure name -> Russian, from the Stellarium .po catalogue."""
    path = os.path.join(RAW, "ru_skycultures.po")
    if not os.path.exists(path):
        print("  WARNING: data/raw/ru_skycultures.po missing; no Russian names.")
        return {}

    def unescape(s):
        # C-style escapes, decoded without mangling the UTF-8 underneath.
        return (s.encode("utf-8").decode("unicode_escape")
                 .encode("latin-1").decode("utf-8"))

    out, cur, key = {}, {}, None

    def flush():
        if (cur.get("msgctxt") == "S&T constellation name"
                and cur.get("msgid") and cur.get("msgstr")):
            out[cur["msgid"]] = cur["msgstr"]

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            m = re.match(r'(msgctxt|msgid|msgstr)\s+(.*)', line)
            if m:
                key = m.group(1)
                cur[key] = ""
                line = m.group(2)
            elif not line.startswith('"'):
                if not line.strip():
                    flush()
                    cur, key = {}, None
                continue
            if key:
                q = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
                if q:
                    cur[key] += unescape(q[0])
    flush()
    return out


# ---------------------------------------------------------------- precession

def _precession_matrix_b1875_to_j2000():
    """IAU 1976 (Lieske) rotation from the B1875.0 mean equinox to J2000.0."""
    # B1875.0 = JD 2405889.25855 -> Julian centuries from J2000
    t0 = (2405889.25855 - 2451545.0) / 36525.0
    t = -t0  # interval from B1875 forward to J2000

    a = 2306.2181 + 1.39656 * t0 - 0.000139 * t0 * t0
    zeta = (a * t + (0.30188 - 0.000344 * t0) * t * t + 0.017998 * t ** 3)
    z = (a * t + (1.09468 + 0.000066 * t0) * t * t + 0.018203 * t ** 3)
    b = 2004.3109 - 0.85330 * t0 - 0.000217 * t0 * t0
    theta = (b * t - (0.42665 + 0.000217 * t0) * t * t - 0.041833 * t ** 3)

    zeta, z, theta = (math.radians(x / 3600.0) for x in (zeta, z, theta))
    cz, sz = math.cos(zeta), math.sin(zeta)
    ct, st = math.cos(theta), math.sin(theta)
    cZ, sZ = math.cos(z), math.sin(z)
    return [
        [cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ],
        [cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ],
        [cz * st,                -sz * st,                 ct],
    ]

_P = _precession_matrix_b1875_to_j2000()


def to_vec(ra_deg, dec_deg):
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    c = math.cos(dec)
    return (c * math.cos(ra), c * math.sin(ra), math.sin(dec))


def to_radec(v):
    x, y, z = v
    ra = math.degrees(math.atan2(y, x)) % 360.0
    dec = math.degrees(math.asin(max(-1.0, min(1.0, z / math.sqrt(x * x + y * y + z * z)))))
    return ra, dec


def precess_b1875_to_j2000(ra_deg, dec_deg):
    x, y, z = to_vec(ra_deg, dec_deg)
    return to_radec(tuple(r[0] * x + r[1] * y + r[2] * z for r in _P))


# ---------------------------------------------------------------- star table

def load_stars():
    """HIP -> star record, from HYG. Returns (by_hip, all_rows)."""
    path = os.path.join(RAW, "hygdata_v41.csv")
    by_hip, by_hd, rows = {}, {}, []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["proper"] == "Sol" or not r["mag"]:
                continue
            try:
                mag = float(r["mag"])
                ra = float(r["ra"]) * 15.0  # HYG stores RA in hours
                dec = float(r["dec"])
            except ValueError:
                continue
            star = {
                "hip": int(r["hip"]) if r["hip"] else None,
                "ra": round(ra, 6),
                "dec": round(dec, 6),
                "mag": round(mag, 3),
                "ci": round(float(r["ci"]), 3) if r["ci"] else None,
                "name": r["proper"] or None,
                "bayer": r["bayer"] or None,
                "con": r["con"] or None,
            }
            rows.append(star)
            # HYG can hold split components; keep the brightest per identifier.
            if star["hip"] is not None:
                prev = by_hip.get(star["hip"])
                if prev is None or star["mag"] < prev["mag"]:
                    by_hip[star["hip"]] = star
            if r["hd"]:
                hd = int(r["hd"])
                prev = by_hd.get(hd)
                if prev is None or star["mag"] < prev["mag"]:
                    by_hd[hd] = star

    for hip, hd in HIP_TO_HD.items():
        if hip not in by_hip and hd in by_hd:
            star = by_hd[hd]
            star["hip"] = hip  # adopt the HIP id so lines can reference it
            by_hip[hip] = star

    return by_hip, rows


# ------------------------------------------------------------ constellations

def load_sky_culture():
    with open(os.path.join(RAW, "modern_st_index.json"), encoding="utf-8") as fh:
        return json.load(fh)


BOUNDARY_STEP_DEG = 2.0  # subdivision of boundary arcs before precessing



def parse_edges(edges, abbrs):
    """Group IAU boundary segments by constellation, precessed to J2000.

    Each line looks like:
      '001:002 M+ 22:52:00 +34:30:00 22:52:00 +52:30:00 AND LAC'
    i.e. a type flag, two endpoints (RA h:m:s, Dec d:m:s) and the two
    constellations the segment divides. The flag is M for a meridian (constant
    RA) and P for a parallel (constant Dec) -- but only in B1875. Precession
    bends both into curves, so each edge is subdivided along its B1875 path
    and every sample precessed, giving a polyline that stays on the boundary.
    """
    def hms(s):
        h, m, sec = (float(x) for x in s.split(":"))
        return (h + m / 60.0 + sec / 3600.0) * 15.0

    def dms(s):
        sign = -1.0 if s.lstrip()[0] == "-" else 1.0
        d, m, sec = (float(x) for x in s.lstrip("+-").split(":"))
        return sign * (d + m / 60.0 + sec / 3600.0)

    # Edge records name constellations in upper case ("CMA"), which is not the
    # abbreviation's own casing ("CMa") -- match case-insensitively rather than
    # trying to reconstruct it.
    by_upper = {a.upper(): a for a in abbrs}

    per_con, unknown = {}, set()
    for line in edges:
        p = line.split()
        if len(p) < 8:
            continue
        ra1, dec1 = hms(p[2]), dms(p[3])
        ra2, dec2 = hms(p[4]), dms(p[5])

        # RA runs the short way round, so edges spanning 0h behave.
        dra = ((ra2 - ra1 + 180.0) % 360.0) - 180.0
        ddec = dec2 - dec1
        span = max(abs(dra) * math.cos(math.radians((dec1 + dec2) / 2.0)), abs(ddec))
        n = max(1, int(math.ceil(span / BOUNDARY_STEP_DEG)))

        poly = []
        for i in range(n + 1):
            f = i / n
            ra, dec = precess_b1875_to_j2000(ra1 + dra * f, dec1 + ddec * f)
            poly.append([round(ra, 5), round(dec, 5)])

        for code in (p[6], p[7]):
            key = code.upper()
            abbr = key if key in EDGE_ONLY_CODES else by_upper.get(key)
            if abbr is None:
                unknown.add(code)
                continue
            per_con.setdefault(abbr, []).append(poly)

    if unknown:
        print(f"  WARNING: boundary edges name unknown constellations: "
              f"{sorted(unknown)} -- those boundaries were dropped.")
    return per_con


def centre_and_radius(points):
    """Mean direction + angular radius (deg) of a set of (ra, dec) points."""
    vx = vy = vz = 0.0
    for ra, dec in points:
        x, y, z = to_vec(ra, dec)
        vx, vy, vz = vx + x, vy + y, vz + z
    n = math.sqrt(vx * vx + vy * vy + vz * vz)
    if n == 0:
        return 0.0, 0.0, 0.0
    c = (vx / n, vy / n, vz / n)
    cra, cdec = to_radec(c)
    worst = 0.0
    for ra, dec in points:
        v = to_vec(ra, dec)
        dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(c, v))))
        worst = max(worst, math.degrees(math.acos(dot)))
    return round(cra, 5), round(cdec, 5), round(worst, 4)


def main():
    if not os.path.isdir(RAW):
        sys.exit("missing data/raw -- run tools/fetch_sources.sh first")

    by_hip, all_stars = load_stars()
    culture = load_sky_culture()
    ru_names = load_russian_names()
    abbrs = [c["id"].rsplit(" ", 1)[-1] for c in culture["constellations"]]
    boundaries = parse_edges(culture["edges"], abbrs)

    # HIP -> preferred proper name from the sky culture's own name list.
    sc_names = {}
    for key, entries in (culture.get("common_names") or {}).items():
        if key.startswith("HIP ") and entries:
            e = entries[0]
            sc_names[int(key[4:])] = e.get("english") or e.get("native")

    constellations = []
    missing = {}
    used_hips = set()

    for c in culture["constellations"]:
        abbr = c["id"].rsplit(" ", 1)[-1]  # 'CON modern_st And' -> 'And'
        cname = c.get("common_name") or {}
        name = cname.get("native") or cname.get("english") or abbr

        lines = []
        for poly in c["lines"]:
            resolved = []
            for hip in poly:
                if by_hip.get(hip) is None:
                    missing.setdefault(abbr, []).append(hip)
                    continue
                # S&T brackets a borrowed star with two points either side of it
                # to leave a visual gap; Stellarium maps both to the same HIP,
                # which would emit a zero-length segment. Collapse the repeat.
                if resolved and resolved[-1] == hip:
                    continue
                resolved.append(hip)
            if len(resolved) >= 2:
                lines.append(resolved)

        override = FIGURE_OVERRIDES.get(abbr)
        if override:
            if lines != override["expect"]:
                print(f"  WARNING: {abbr} upstream figure changed; the override "
                      f"in FIGURE_OVERRIDES was decided against {override['expect']} "
                      f"but upstream now has {lines}. Re-check against the IAU chart.")
            lines = [list(l) for l in override["lines"]]

        pts = []
        for line in lines:
            for hip in line:
                used_hips.add(hip)
                s = by_hip[hip]
                pts.append((s["ra"], s["dec"]))

        def entry(abbr, name, lines, bnd, english=None, parent=None, iau=None):
            frame = [(by_hip[h]["ra"], by_hip[h]["dec"]) for l in lines for h in l]
            frame = frame or [p for seg in bnd for p in seg]
            cra, cdec, radius = centre_and_radius(frame)
            return {
                "abbr": abbr,
                "name": name,
                "name_ru": RU_OVERRIDES.get(abbr) or ru_names.get(english),
                "english": english,
                "pronounce": cname.get("pronounce") if parent is None else None,
                "lines": lines,
                "boundary": bnd,
                "center": [cra, cdec],
                "radius": radius,
                "iau": iau or abbr.upper(),  # IAU chart basename
                "parent": parent,            # set when this is half of a split
                "playable": bool(lines),     # no figure -> nothing to show
            }

        split = SPLITS.get(abbr)
        if split:
            for part in split:
                constellations.append(entry(
                    part["abbr"], part["name"],
                    [lines[i] for i in part["lines"] if i < len(lines)],
                    boundaries.get(part["edges"], []),
                    english=part["english"], parent=abbr, iau=part["iau"],
                ))
        else:
            constellations.append(entry(
                abbr, name, lines, boundaries.get(abbr, []),
                english=cname.get("english"),
            ))

    constellations.sort(key=lambda c: c["abbr"])

    # Stars: everything to the magnitude limit, plus every line vertex.
    stars = [s for s in all_stars
             if s["mag"] <= MAG_LIMIT or (s["hip"] in used_hips)]
    for s in stars:
        if s["hip"] in sc_names and not s["name"]:
            s["name"] = sc_names[s["hip"]]

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "constellations.json"), "w", encoding="utf-8") as fh:
        json.dump({"epoch": "J2000",
                   "source": "Stellarium modern_st (Sky & Telescope) + IAU edges",
                   "constellations": constellations}, fh, ensure_ascii=False)
    with open(os.path.join(OUT, "stars.json"), "w", encoding="utf-8") as fh:
        json.dump({"epoch": "J2000", "mag_limit": MAG_LIMIT,
                   "source": "HYG v4.1", "stars": stars}, fh, ensure_ascii=False)

    n_lines = sum(len(c["lines"]) for c in constellations)
    n_seg = sum(len(p) - 1 for c in constellations for p in c["lines"])
    n_play = sum(1 for c in constellations if c["playable"])
    print(f"entries        : {len(constellations)} "
          f"({n_play} playable, {len(constellations) - n_play} with no figure)")
    print(f"polylines      : {n_lines}  ({n_seg} segments)")
    print(f"line stars     : {len(used_hips)}")
    print(f"stars written  : {len(stars)}  (mag <= {MAG_LIMIT})")
    print(f"boundaries     : {sum(len(c['boundary']) for c in constellations)} segments")
    if missing:
        print("\nUNRESOLVED HIP ids:")
        for k, v in missing.items():
            print(f"  {k}: {v}")
    else:
        print("\nall line stars resolved against HYG")

    # Every constellation is bounded, so an empty boundary always means the
    # edge records failed to match rather than that there is nothing to draw.
    no_ru = [c["abbr"] for c in constellations if not c["name_ru"]]
    if no_ru:
        print(f"WARNING: no Russian name for {no_ru}")
    else:
        print("every constellation has a Russian name")

    unbounded = [c["abbr"] for c in constellations if not c["boundary"]]
    if unbounded:
        print(f"ERROR: {len(unbounded)} constellations have no boundary: {unbounded}")
        return 1
    print("every constellation has a boundary")
    return 0


if __name__ == "__main__":
    sys.exit(main())
