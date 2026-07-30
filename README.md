# Constellation Spotter — data + line verification

Groundwork for a "name that constellation" game: the star catalogue, the 88
constellation stick figures, the IAU boundaries, and a side-by-side tool for
checking the figures against the official IAU charts.

## The line data does not need to be recovered from the GIFs

The IAU's constellation charts were drawn by **Sky & Telescope**, and that same
stick-figure set is published as machine-readable data in Stellarium's
`modern_st` sky culture, as polylines of Hipparcos (HIP) star numbers. So the
lines come straight from the source the IAU charts were made from — no image
processing, no tracing, no guessing.

The GIFs are still worth having: they are the reference to *verify* against,
which is what `web/` is for.

## Sources

| What | Where |
|---|---|
| Stick figures (HIP polylines) | Stellarium `skycultures/modern_st/index.json` |
| Constellation boundaries | Same file — IAU edges, epoch B1875, via pbarbier.com |
| Star positions / magnitudes | HYG database v4.1 (`astronexus/HYG-Database`) |
| Russian names | Stellarium `po/stellarium-skycultures/ru.po` |
| Reference charts | `iauarchive.eso.org` — 89 GIFs (Serpens is on two sheets) |

## Build

```sh
tools/fetch_sources.sh     # downloads everything into data/raw/ and web/iau/
python3 tools/build_data.py
```

Produces:

- **`data/constellations.json`** — 89 entries for the 88 constellations. Per
  entry: `abbr`, `name`, `name_ru`, `lines` (polylines of HIP ids), `boundary`
  (1 562 J2000 polylines), `center`, `radius`, `iau` (chart basename), `parent`,
  `playable`.

- **`data/stars.json`** — 8 920 stars to magnitude 6.5, plus every star a line
  references. Each has `hip`, `ra`, `dec` (J2000 degrees), `mag`, `ci` (colour
  index), and names where known.

Russian names are taken from Stellarium's translation of the S&T figure names,
which is the conventional Russian name in almost every case. Four were literal
translations of the English rather than the name Russian astronomy uses, and are
corrected in `RU_OVERRIDES` — Pegasus (was "Крылатый конь" → **Пегас**), Pictor
("Мольберт художника" → **Живописец**), Hydra ("Водяная змея", which reads as
Hydrus → **Гидра**) and Dorado ("Рыба-меч" → **Золотая Рыба**). The build warns
if any entry ends up without a Russian name.

Current build: **146 polylines, 837 segments, 741 line stars, all resolved.**

Upstream quirks handled explicitly in `tools/build_data.py`:

- HYG blanks the `hip` column for some resolved doubles, so ξ UMa (Alula
  Australis) is looked up by HD number instead — see `HIP_TO_HD`.
- Boundaries are meridian/parallel arcs **in B1875**; precession bends them, so
  each edge is subdivided before being precessed to J2000 rather than stored as
  a straight segment.
- S&T brackets a *borrowed* star (one belonging to a neighbouring constellation)
  with two points either side of it, to leave a small gap in the drawn line.
  Stellarium maps both to the same HIP, which produced five zero-length
  segments; consecutive repeats are collapsed.
- Boundary edges name constellations in upper case (`CMA`, `UMI`), which is not
  the abbreviation's own casing (`CMa`, `UMi`), and the IAU file splits Serpens
  into `SER1`/`SER2` for its two disjoint regions. Matching is case-insensitive
  with an alias for Serpens; the build fails if any constellation ends up
  without a boundary, since every constellation has one.

## Verification results

All 88 were checked against the IAU charts. 84 matched first time; the four
that did not are resolved in `FIGURE_OVERRIDES`, each verified against the
chart and against the raw `SnT_constellations.txt`:

| | Finding | Resolution |
|---|---|---|
| **Mensa** | Zero records in the S&T source; the IAU chart shows an empty region. `modern_st` carries an α–β line with no counterpart on the chart. | Figure dropped |
| **Microscopium** | Same — no S&T records, empty chart. | Figure dropped |
| **Apus** | S&T ends the α line at a point it labels `d-g`: the *exact* midpoint of γ and δ, not a star (0.9 px from the midpoint on the chart, vs 6.5 and 7.8 px from the two stars). `modern_st` snapped it to γ. | Re-attached to δ¹ |
| **Serpens** | Data was correct on both sheets. The comparison tool was labelling *borrowed* stars with the displayed constellation — ν Oph appeared as "Nu Ser". | Tool bug; labels now use the star's own constellation |

`FIGURE_OVERRIDES` records the upstream figure each correction was decided
against, so if Stellarium changes the data the build warns rather than silently
applying a stale fix.

Two constellations (Mensa, Microscopium) have **no line data at all**, which is
faithful to the charts. They carry `playable: false` and the game skips them.

## Serpens is two entries

Serpens is officially one constellation, but its halves sit ~70° apart on either
side of Ophiuchus, so a single entry can never be framed sensibly — and the IAU
charts them on separate sheets anyway. The build emits **`SerCp` (Serpens Caput)**
and **`SerCd` (Serpens Cauda)** as separate entries, each carrying
`parent: "Ser"`, its own boundary region (`SER1`/`SER2`) and its own chart.

That is why the dataset has 89 entries for 88 constellations — and it means
every entry has exactly one chart and one boundary region, which removed the
multi-sheet special case from both the data and the viewer.

Also noted, not acted on: `SnT_constellations.txt` tags 22 Eridanus records
`Erj` instead of `Eri` — a typo in the S&T file. We inherit Stellarium's
already-correct Eridanus, so it only matters if the raw file is ever parsed
directly.

## Verification tool

```sh
python3 -m http.server 8765
open http://localhost:8765/web/compare.html
```

IAU chart on the left, the same patch of sky rebuilt from `data/*.json` on the
right — same orientation as the charts (north up, RA increasing left).

- `←` / `→` or the dropdown to move between constellations; `?c=Ori` deep-links.
- `y` marks a constellation as matching, `n` flags it. Progress is kept in
  `localStorage`; **export report** writes `line-verification.json`.
- Toggles for labels, boundaries, neighbouring figures, grid, and true star
  colour; sliders for limiting magnitude and zoom.

The canvas matches each sheet's aspect ratio and fits the figure to its actual
projected extent, so wide constellations (Hydra), tall ones (Eridanus) and
polar ones (Ursa Minor) all frame sensibly.

All 88 have been checked — see **Verification results** above.

## The game

```sh
python3 -m http.server 8765
open http://localhost:8765/web/
```

A patch of night sky centred on one constellation; name it from four choices,
each labelled `Latin (Русское)`. Score and settings persist.

| Key | |
|---|---|
| `1`–`4` | answer |
| `S` | skip |
| `Enter` / `Space` | next round |
| `L` | toggle figure lines |
| `O` | toggle random orientation |
| `C` | toggle star colour |

Shortcuts stay live while a checkbox or slider has focus (letters mean nothing
to those), and are suppressed only for text inputs and `<select>`. Sliders take
`←`/`→` natively once focused.

Difficulty, as individual controls plus **easy / normal / hard** presets:

- **show figure lines** — on for easy; otherwise the figure is only revealed
  after you answer.
- **random orientation** — rolls the sky by a random angle. The framing measures
  the figure's extent *after* the roll, so a rotated constellation still fits.
- **light pollution** — a Bortle 1–9 slider. It sets the limiting magnitude
  (6.5 → 3.8) *and* the sky glow, and fades the faintest magnitude out rather
  than cutting it off, so stars dim away instead of popping out of existence.
  Class 1 is capped at mag 6.5 because that is where the catalogue stops.
- **field of view** — how many figure-widths of sky to show. Wider means more
  surrounding stars to get lost in.

A round is shareable as a URL: `?c=Ori&lines=1&rotate=1&bortle=6&fov=3.2`.

`web/sky.js` — projection, star sizing, colour — is shared by the game and the
comparison view.

## Deploying

The site is entirely static. `tools/build_site.py` assembles `dist/`: it
flattens `web/` and `data/*.json` into one directory and rewrites the pages'
`../data/` references to `data/`, so the game sits at the site root rather than
at `/web/`. It fails the build if any `../data/` reference survives, since that
would only 404 at runtime.

```sh
python3 tools/build_data.py     # data/*.json
python3 tools/build_site.py     # dist/  (13 MB, 11 MB of it IAU charts)
```

`.github/workflows/pages.yml` runs that on every push to `main` and publishes
`dist/` to GitHub Pages. `data/*.json` are committed, so CI never needs to
re-download the 32 MB source catalogue; `data/raw/` is gitignored.

Because a GitHub project page is served from a subpath
(`user.github.io/<repo>/`), every asset reference must stay relative — there are
no root-absolute (`/data/...`) paths, and adding one would break the deploy
while still working locally.

## Next

- Free-text answers with autocomplete, as an alternative to multiple choice.
- Weight the question pool by how often you get each one wrong.
- Distractors chosen to be plausible (similar size or neighbouring) rather than
  uniformly random.
