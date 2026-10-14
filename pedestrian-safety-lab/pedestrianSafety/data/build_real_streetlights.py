#!/usr/bin/env python3
"""
build_real_streetlights.py

Builds realStreetlightsTaiwan.json (a list of [lat, lon] pairs) from any mix of these streetlight CSVs
(each --csv may be a file or a folder of CSVs; the format is detected from
the header row):

  1. merged format -- csv/路燈資料/台北路燈/street_light_all.csv, produced by
     sql/street_light.py from TaipeiLight.csv + 新北市路燈資料.csv:
       lamp_id, city, district, address, lamp_type, wattage, longitude, latitude
  2. 臺中市 open-data format -- csv/路燈資料/台中路燈/路燈資料-<區>_N.csv (one
     file per district):
       序號, 區編碼, 路燈編號, 地理座標-WGS84-北緯, 地理座標-WGS84-東經,
       行政轄區, 燈泡形式, 類別碼, 作業區分, 材質, 使用狀態
     Only 使用狀態 == "使用" (in service) is kept; "停用" lamps are dropped.
  3. 基隆市 -- 縣市, 行政區, 鄉里, 圖號座標, 形式, 桿號, TWD_97_X, TWD_97_Y
     (TWD97 only; converted to WGS84 below)
  4. 新竹市 -- 路燈編碼, ..., 所屬鄉鎮, ..., TWD97座標X/Y, WGS84座標東經度/北緯度
  5. 桃園市中壢區公所 -- 流水號, 編號, 區域, 里, ..., X, Y (TWD97). The file has no
     .csv extension, so pass it with its own --csv.
  6. 臺南市 -- 路燈編碼, 設立方式, 燈泡材質, 燈泡瓦數, 所屬群組 | 行政區域代碼, 緯度, 經度
     (some districts are published twice, once by name and once by code;
     the duplicate rows are dropped by lamp id + position)
  7. 高雄市 -- 行政區, 行政里, 編號, 路燈編號, ..., 經度E, 緯度N, x97坐標, y97坐標
     (one file per district; WGS84 used, TWD97 as fallback)

Cities whose data covers only SOME districts (臺南市, 桃園市 = 中壢區 only,
高雄市 = no 茂林/桃源/那瑪夏) are passed with --partial. For those, the
coverage file lists the 0.005° cells (~550 m) that actually have lamps
(small holes closed), and the server treats only those cells as "has
streetlight data"; the rest of that city counts as "no data", not "dark".

There is NO nationwide streetlight dataset in Taiwan -- each city/county
publishes its own (or nothing), in its own format. So this file only covers
the cities found in the inputs, and that list is written into the
output's companion file (realStreetlightsCoverage.json) so the server can
tell "this road has few streetlights" apart from "we have no streetlight
data for this county" (the latter must NOT score as 0 / pitch-dark).

To add another city later: either convert it into the merged format, or add
a small reader for its format in read_rows() below, then pass it with another
--csv; the coverage list updates itself.

Usage (from the project root):
    python3 pedestrianSafety/data/build_real_streetlights.py \
        --csv csv/路燈資料/台北路燈/street_light_all.csv \
        --csv csv/路燈資料/台中路燈 \
        --csv csv/路燈資料/基隆路燈 --csv csv/路燈資料/新竹路燈 \
        --csv csv/路燈資料/桃園路燈/桃園中壢區公所路燈資料 \
        --csv csv/路燈資料/台南路燈 --csv csv/路燈資料/高雄路燈 \
        --partial 臺南市 --partial 桃園市 --partial 高雄市 \
        --out pedestrianSafety/data/realStreetlightsTaiwan.json.gz
"""

import argparse
import csv
import gzip
import json
import math
import sys
from collections import Counter
from pathlib import Path

# Rough Taiwan bounds (main island + Penghu/Kinmen/Matsu) for sanity checks.
LAT_MIN, LAT_MAX = 21.8, 26.5
LON_MIN, LON_MAX = 118.0, 122.1

# Rough per-city boxes for the newer sources -- drops rows whose coordinates
# are typos (e.g. Y missing a digit), which otherwise land in the sea.
CITY_BOXES = {
    "基隆市": (25.03, 25.21, 121.60, 121.82),
    "新竹市": (24.70, 24.86, 120.88, 121.04),
    "桃園市": (24.58, 25.13, 120.97, 121.50),
    "臺南市": (22.88, 23.42, 120.02, 120.66),
    "高雄市": (22.44, 23.48, 120.17, 121.05),
}

PARTIAL_CELL = 0.005  # degrees (~550 m); must match nationalData.js


def twd97_to_wgs84(x, y):
    """TWD97 TM2 (EPSG:3826, GRS80, central meridian 121°E, k0 0.9999,
    false easting 250 km) -> (lat, lon). Checked against 新竹市's own paired
    columns: median error < 1 mm over 29,476 lamps."""
    a = 6378137.0
    f = 1 / 298.257222101
    b = a * (1 - f)
    e2 = (a * a - b * b) / (a * a)
    k0 = 0.9999
    x -= 250000.0
    mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
          + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
          + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    ep2 = e2 / (1 - e2)
    c1 = ep2 * math.cos(p1) ** 2
    t1 = math.tan(p1) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (
        d * d / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720)
    lon = math.radians(121) + (
        d - (1 + 2 * t1 + c1) * d ** 3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lat), math.degrees(lon)


def from_twd97(x_s, y_s):
    try:
        x, y = float(x_s), float(y_s)
    except (TypeError, ValueError):
        return None, None
    if x <= 0 or y <= 0:
        return None, None
    return twd97_to_wgs84(x, y)


def valid(lat_s, lon_s):
    try:
        lat, lon = float(lat_s), float(lon_s)
    except (TypeError, ValueError):
        return False
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


def norm_city(c: str) -> str:
    return (c or "").strip().replace("台", "臺")

def read_rows(path, dropped):
    """Yields (city, lamp_id, lat_str, lon_str) from one CSV of either format."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        # Some exports carry a second BOM inside the first header cell.
        reader.fieldnames = [(h or "").lstrip("\ufeff").strip() for h in reader.fieldnames or []]
        fields = set(reader.fieldnames)
        if {"latitude", "longitude", "city"} <= fields:
            for row in reader:
                yield norm_city(row.get("city")), (row.get("lamp_id") or "").strip(), row.get("latitude"), row.get("longitude")
        elif {"地理座標-WGS84-北緯", "地理座標-WGS84-東經"} <= fields:
            for row in reader:
                if (row.get("使用狀態") or "使用").strip() != "使用":
                    dropped["not-in-service"] += 1
                    continue
                lamp_id = f'{(row.get("區編碼") or "").strip()}-{(row.get("路燈編號") or "").strip()}'
                yield "臺中市", lamp_id, row.get("地理座標-WGS84-北緯"), row.get("地理座標-WGS84-東經")
        elif {"TWD_97_X", "TWD_97_Y", "縣市"} <= fields:  # 基隆市
            for row in reader:
                lat, lon = from_twd97(row.get("TWD_97_X"), row.get("TWD_97_Y"))
                yield norm_city(row.get("縣市")) or "基隆市", (row.get("桿號") or "").strip(), lat, lon
        elif {"WGS84座標北緯度", "WGS84座標東經度"} <= fields:  # 新竹市
            for row in reader:
                lat, lon = row.get("WGS84座標北緯度"), row.get("WGS84座標東經度")
                if not valid(lat, lon):
                    lat, lon = from_twd97(row.get("TWD97座標X"), row.get("TWD97座標Y"))
                yield "新竹市", (row.get("路燈編碼") or "").strip(), lat, lon
        elif {"流水號", "編號", "X", "Y"} <= fields:  # 桃園市中壢區公所
            for row in reader:
                lat, lon = from_twd97(row.get("X"), row.get("Y"))
                yield "桃園市", (row.get("流水號") or "").strip(), lat, lon
        elif {"路燈編碼", "緯度", "經度"} <= fields:  # 臺南市
            for row in reader:
                yield "臺南市", (row.get("路燈編碼") or "").strip(), row.get("緯度"), row.get("經度")
        elif {"經度E", "緯度N"} <= fields:  # 高雄市
            for row in reader:
                lat, lon = row.get("緯度N"), row.get("經度E")
                if not valid(lat, lon):
                    lat, lon = from_twd97(row.get("x97坐標"), row.get("y97坐標"))
                lamp_id = f'{(row.get("行政區") or "").strip()}-{(row.get("路燈編號") or row.get("編號") or "").strip()}'
                yield "高雄市", lamp_id, lat, lon
        else:
            dropped["skipped-file"] += 1
            print(f"SKIPPING {path}: not a streetlight-position file (header {reader.fieldnames[:6]})", file=sys.stderr)


def expand(paths):
    for p in paths:
        p = Path(p)
        if p.is_dir():
            for f in sorted(p.glob("*.csv")):
                # Windows "copy (1)" duplicates of a file that is also present
                if " (1)" in f.stem and f.with_name(f.stem.replace(" (1)", "") + f.suffix).exists():
                    print(f"SKIPPING {f.name}: duplicate download", file=sys.stderr)
                    continue
                yield f
        else:
            yield p


def partial_cells(points):
    """0.005° cells holding >= 2 lamps, then a morphological closing (dilate +
    erode, 8-neighbourhood) so ~500 m gaps inside the covered area are kept
    as covered while the outer edge doesn't grow."""
    count = Counter((math.floor(lat / PARTIAL_CELL), math.floor(lon / PARTIAL_CELL)) for lat, lon in points)
    cells = {c for c, n in count.items() if n >= 2}
    nb = [(di, dj) for di in (-1, 0, 1) for dj in (-1, 0, 1)]
    dil = {(i + di, j + dj) for i, j in cells for di, dj in nb}
    closed = {c for c in dil if all((c[0] + di, c[1] + dj) in dil for di, dj in nb)}
    return sorted(closed | cells)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, action="append", help="CSV file or folder; repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--partial", action="append", default=[],
                    help="city whose data covers only some districts (e.g. 臺南市); repeatable")
    args = ap.parse_args()

    out, seen = [], set()
    per_city, dropped = Counter(), Counter()
    sources = []
    partial = {norm_city(c) for c in args.partial}
    by_partial_city = {c: [] for c in partial}
    for path in expand(args.csv):
        sources.append(path.name)
        for city, lamp_id, lat_s, lon_s in read_rows(path, dropped):
            try:
                lat = float(lat_s)
                lon = float(lon_s)
            except (TypeError, ValueError):
                dropped["bad-coordinate"] += 1
                continue
            if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
                dropped["outside-taiwan"] += 1
                continue
            box = CITY_BOXES.get(city)
            if box and not (box[0] <= lat <= box[1] and box[2] <= lon <= box[3]):
                dropped["outside-its-city"] += 1
                continue
            lat, lon = round(lat, 6), round(lon, 6)
            # Same lamp_id + same point listed twice = a true duplicate row.
            key = (city, lamp_id, lat, lon)
            if key in seen:
                dropped["duplicate-row"] += 1
                continue
            seen.add(key)
            out.append([lat, lon])
            per_city[city] += 1
            if city in by_partial_city:
                by_partial_city[city].append((lat, lon))

    # Compact [lat, lon] pairs (half the size of {latitude, longitude} objects);
    # nationalData.js expands them back to objects when the server loads.
    # An --out ending in .gz is gzipped (1M+ lamps is ~23 MB of plain JSON).
    payload = json.dumps(out, separators=(",", ":")).encode("utf-8")
    if args.out.endswith(".gz"):
        payload = gzip.compress(payload, compresslevel=9, mtime=0)
    Path(args.out).write_bytes(payload)
    coverage = {
        "coveredCities": sorted(c for c in per_city if c not in partial),
        "partialCities": {
            c: [f"{i},{j}" for i, j in partial_cells(pts)] for c, pts in sorted(by_partial_city.items()) if pts
        },
        "partialCellDegrees": PARTIAL_CELL,
        "countsByCity": dict(per_city),
        "sources": sources,
        "note": "Streetlight data exists for all of coveredCities, and for partialCities only "
                "inside the listed cells (key = floor(lat/cell),floor(lon/cell), cell = partialCellDegrees). Routes elsewhere "
                "get a 'no streetlight data' factor instead of a 0 score.",
    }
    cov_path = Path(args.out).parent / "realStreetlightsCoverage.json"
    cov_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"{len(out)} streetlights written to {args.out}", file=sys.stderr)
    print(f"by city: {dict(per_city)}", file=sys.stderr)
    print(f"dropped: {dict(dropped)}", file=sys.stderr)
    for c, cells in coverage["partialCities"].items():
        print(f"partial coverage {c}: {len(cells)} cells of {PARTIAL_CELL}°", file=sys.stderr)
    print(f"coverage written to {cov_path}", file=sys.stderr)

if __name__ == "__main__":
    main()
