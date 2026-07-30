#!/usr/bin/env bash
# Download every upstream source this project derives data from.
# Re-run to refresh; everything lands in data/raw/ and web/iau/.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/raw web/iau

echo "== Stellarium modern_st (Sky & Telescope constellation figures)"
curl -sSLf -o data/raw/modern_st_index.json \
  https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern_st/index.json
curl -sSLf -o data/raw/SnT_constellations.txt \
  https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern_st/SnT_constellations.txt

echo "== Stellarium sky-culture translations (Russian names)"
curl -sSLf -o data/raw/ru_skycultures.po \
  https://raw.githubusercontent.com/Stellarium/stellarium/master/po/stellarium-skycultures/ru.po

echo "== HYG v4.1 star catalogue (32 MB)"
curl -sSLf -o data/raw/hygdata_v41.csv \
  https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv

echo "== IAU reference charts (89 GIFs; Serpens is charted on two sheets)"
# Every abbreviation is its own basename except Serpens -> SERCP + SERCD.
charts=$(python3 -c "
import json
d=json.load(open('data/raw/modern_st_index.json'))
a=sorted(c['id'].rsplit(' ',1)[-1].upper() for c in d['constellations'])
a=[x for x in a if x!='SER']+['SERCP','SERCD']
print(' '.join(a))")

for c in $charts; do
  curl -sSLf -o "web/iau/$c.gif" \
    "https://iauarchive.eso.org/static/public/constellations/gif/$c.gif" \
    || echo "FAILED $c" >&2
done

got=$(ls web/iau/*.gif 2>/dev/null | wc -l | tr -d " ")
echo "IAU charts on disk: $got / 89"
