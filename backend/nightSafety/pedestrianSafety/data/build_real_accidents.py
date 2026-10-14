#!/usr/bin/env python3
"""
build_real_accidents.py

Converts the user's own 內政部警政署 A1 (fatal/within 24hr) + A2 (injury)
traffic-accident CSVs into realAccidentsTaipei.json.

Handles TWO different export schemas the government has used across years:

  OLD FORMAT (民國107-110年度, i.e. 2018-2021), one row per accident:

      發生時間,發生地點,死亡受傷人數,車種,經度,緯度

  - 發生時間 is ROC-calendar: "107年01月01日 05時12分00秒"
  - 發生地點 is free text starting with the city/county name
  - 車種 is a ";"-separated list of every party involved, e.g.
    "自用-小客車;行人-人" -- a party of "行人-人" (literally "pedestrian-person")
    marks the record as pedestrian-involved
  - 經度/緯度 are already WGS84 decimal degrees (longitude, latitude)

  NEW FORMAT (民國111-114年度 so far, i.e. 2022-2025), ONE ROW PER PARTY --
  an accident with 3 people involved is 3 consecutive rows sharing the
  same 發生日期/發生時間/發生地點, distinguished by 當事者順位 (party
  sequence number, restarts at 1 for each new accident). 111-113年度 have
  51 columns; 114年度 added one trailing column (共享經濟或外送平台的名稱,
  "gig-economy/delivery-platform name", col 51) but every column this
  script actually reads (0-50) is at the same index in both variants, so
  no special-casing is needed -- rows are only required to have at least
  51 columns, not exactly 51. The columns this script uses:

      發生日期 (col 2, already Gregorian YYYYMMDD, e.g. "20220103")
      發生時間 (col 3, HHMMSS)
      事故類別名稱 (col 4, "A1"/"A2" -- in the data itself, not just the filename)
      發生地點 (col 6)
      死亡受傷人數 (col 32)
      當事者區分-類別-大類別名稱-車種 (col 34, e.g. "人"/"小客車"/"機車"/...)
      當事者區分-類別-子類別名稱-車種 (col 35, e.g. "行人"/"乘客"/"其他人"/"自用"/...)
      經度 (col 49), 緯度 (col 50)

  A party is the pedestrian iff 車種大類別=="人" AND 車種子類別=="行人" --
  子類別 "乘客" (passenger) and "其他人" (other/bystander) ALSO fall under
  大類別 "人", so a loose "人" or "行人" substring check (which is what the
  old-format parser correctly uses for its different field) would wrongly
  match passengers too here. This script therefore groups rows by
  (date, time, location) and marks a group pedestrian-involved only when
  one of its rows has 車種子類別名稱 exactly "行人".

Both formats are filtered the same way: Taipei City (發生地點 starts with
臺北市 or 台北市) AND at least one pedestrian party, and produce the SAME
output schema (one object per accident):

    {
      "latitude": float,
      "longitude": float,
      "date": "YYYY-MM-DD",        # Gregorian
      "accident_type": "pedestrian",
      "category": "A1" | "A2",     # from the data (new format) or filename (old format)
      "severity": "死亡N;受傷M",    # passthrough from 死亡受傷人數
      "time": "HHMMSS",
      "location": "..."             # passthrough from 發生地點
    }

Usage:
    python3 build_real_accidents.py --sql-dir /path/to/sql --out realAccidentsTaipei.json
    python3 build_real_accidents.py --sql-dir /path/to/sql --out realAccidentsTaiwan.json --region taiwan

--region taiwan keeps every county (發生地點 starting with any of the 22
counties/cities in COUNTY_BOXES) and checks each coordinate against that
county's padded bounding box instead of Taipei's.

Every source file, old-format and new-format alike, is looked for in the
same --sql-dir and is OPTIONAL -- if a given year's file isn't present,
it's just skipped (with a note on stderr). This is what lets the project
scope its dataset to a rolling window (e.g. "recent 5 years") just by
deleting/adding CSVs in sql/, with no code change required -- only add or
remove a filename from OLD_FORMAT_SOURCE_FILES / NEW_FORMAT_YEARS below
when a NEW calendar year needs picking up in a format not already listed.
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path

TIME_RE = re.compile(
    r"^(\d{2,3})年(\d{2})月(\d{2})日\s*(\d{2})時(\d{2})分(\d{2})秒$"
)

# (filename, category) -- category is which A1/A2 bucket the file belongs to.
# A1 = 24hr-fatal accidents, A2 = injury accidents. This is NOT in the CSV
# itself; it's determined by which file the row came from.
#
# 107-109年度 (2018-2020) were dropped from this list at the project
# owner's request (2026-09-24): they deleted those CSVs from sql/ to keep
# the dataset to a rolling recent window, "近5年" (110-114年度, i.e.
# 2021-2025) rather than 2018-2025. 110年度 is kept since it's still part
# of that 5-year window. Every entry here is looked up the same
# optional/skip-if-missing way as NEW_FORMAT_SOURCE_FILES below (see
# main()) -- so re-adding 107-109年度's files back to sql/ later would
# pick them up automatically without any code change, and removing 110
# in a future year (to keep rolling "recent 5 years" as 111-115年度, say)
# is just deleting its 3 lines here.
OLD_FORMAT_SOURCE_FILES = [
    ("110年度A1交通事故資料.csv", "A1"),
    ("110年度A2交通事故資料(110年1月-6月).csv", "A2"),
    ("110年度A2交通事故資料(110年7月-12月).csv", "A2"),
]

# New (111年度+) schema files -- category is read from 事故類別名稱 in the
# data itself, not from the filename. One A1 file + twelve monthly A2
# files per ROC year. NEW_FORMAT_YEARS is the only thing that needs
# updating to pick up another year published in this same format (e.g.
# add 115 once 民國115年 = 2026's export is available) -- each file is
# optional at read time (see main()), so listing a year whose files
# aren't in --sql-dir yet is harmless, it's just skipped.
NEW_FORMAT_YEARS = [111, 112, 113, 114]

NEW_FORMAT_SOURCE_FILES = [
    f"{year}年度A1交通事故資料.csv" for year in NEW_FORMAT_YEARS
] + [
    f"{year}年度A2交通事故資料_{month}.csv"
    for year in NEW_FORMAT_YEARS
    for month in range(1, 13)
]


def roc_to_gregorian_date_time(raw):
    """'107年01月01日 05時12分00秒' -> ('2018-01-01', '051200')."""
    m = TIME_RE.match(raw.strip())
    if not m:
        return None, None
    roc_year, month, day, hh, mm, ss = m.groups()
    year = int(roc_year) + 1911
    date = f"{year:04d}-{month}-{day}"
    time = f"{hh}{mm}{ss}"
    return date, time


def yyyymmdd_to_iso(raw):
    """'20220103' -> '2022-01-03'."""
    raw = raw.strip()
    if not re.fullmatch(r"\d{8}", raw):
        return None
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"


def is_taipei(location):
    return location.startswith("臺北市") or location.startswith("台北市")


# --region taiwan: every county/city, each with a rough bounding box
# (lat_min, lat_max, lon_min, lon_max) padded by BOX_PAD degrees. Same idea
# as in_taipei_box() below: a coordinate far outside the county named in
# 發生地點 is a garbled value in the source CSV, not a real accident there.
BOX_PAD = 0.05
COUNTY_BOXES = {
    "臺北市": (24.96, 25.21, 121.45, 121.67),
    "新北市": (24.67, 25.30, 121.28, 122.01),
    "基隆市": (25.05, 25.20, 121.62, 121.80),
    "桃園市": (24.58, 25.13, 120.98, 121.48),
    "新竹市": (24.73, 24.86, 120.88, 121.03),
    "新竹縣": (24.40, 24.95, 120.90, 121.43),
    "苗栗縣": (24.25, 24.75, 120.60, 121.27),
    "臺中市": (24.00, 24.45, 120.45, 121.46),
    "彰化縣": (23.78, 24.21, 120.23, 120.71),
    "南投縣": (23.43, 24.26, 120.60, 121.35),
    "雲林縣": (23.50, 23.84, 120.13, 120.73),
    "嘉義市": (23.44, 23.52, 120.39, 120.50),
    "嘉義縣": (23.13, 23.65, 120.08, 120.94),
    "臺南市": (22.88, 23.42, 120.03, 120.66),
    "高雄市": (22.47, 23.47, 120.17, 121.05),
    "屏東縣": (21.89, 22.88, 120.35, 120.92),
    "宜蘭縣": (24.30, 24.99, 121.30, 121.98),
    "花蓮縣": (23.09, 24.38, 120.98, 121.76),
    "臺東縣": (21.94, 23.45, 120.73, 121.62),
    "澎湖縣": (23.18, 23.80, 119.30, 119.73),
    "金門縣": (24.38, 24.53, 118.20, 118.50),
    "連江縣": (25.93, 26.40, 119.90, 120.52),
}

REGION = "taipei"  # set from --region in main()


def county_of(location):
    head = location[:3].replace("台", "臺")
    return head if head in COUNTY_BOXES else None


def location_in_region(location):
    if REGION == "taipei":
        return is_taipei(location)
    return county_of(location) is not None


def coordinate_ok(location, lat, lon):
    if REGION == "taipei":
        return in_taipei_box(lat, lon)
    county = county_of(location)
    if county is None:
        return False
    a, b, c, d = COUNTY_BOXES[county]
    ok = a - BOX_PAD <= lat <= b + BOX_PAD and c - BOX_PAD <= lon <= d + BOX_PAD
    if not ok:
        BOX_REJECTS[county] = BOX_REJECTS.get(county, 0) + 1
    return ok


BOX_REJECTS = {}


def in_taipei_box(lat, lon):
    # Sanity bound to Taipei City's actual bounding box (not all of
    # Taiwan) -- every row reaching this check already passed the
    # is_taipei() text-prefix filter, so a coordinate outside Taipei
    # itself is necessarily a bad/garbled value in the source CSV, not a
    # legitimate out-of-city accident. Found by spot-checking the old-
    # format output: one row (2018-09-22, 臺北市中正區寧波西街) carried
    # (25.333, 121.333) -- a real Taiwan coordinate, so a whole-of-Taiwan
    # bound would have let it through, but nowhere near Zhongzheng
    # District (~25.03, ~121.52), so it was clearly a data-entry error.
    return 24.9 <= lat <= 25.25 and 121.4 <= lon <= 121.7


def is_pedestrian_old_format(vehicle_field):
    # Each party is "<type>-<class>", e.g. "行人-人", all joined into one
    # ";"-separated field. A plain substring check on the whole field is
    # deliberately used (not an exact token match) so it still catches the
    # pedestrian party regardless of how many other parties are listed
    # before/after it. Safe here specifically because this field's only
    # "人"-containing values are compounds like "行人-人" -- unlike the new
    # format's separate 車種子類別 column, there's no bare "人"/"乘客" value
    # in this field that a loose substring check could false-positive on.
    return "行人" in vehicle_field


def convert_old_format_file(path, category, seen_keys):
    records = []
    skipped_bad_time = 0
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            return records, skipped_bad_time
        for row in reader:
            if len(row) < 6:
                continue
            occurred_at, location, severity, vehicles, lon_s, lat_s = row[:6]

            if not location_in_region(location):
                continue
            if not is_pedestrian_old_format(vehicles):
                continue

            date, time = roc_to_gregorian_date_time(occurred_at)
            if date is None:
                skipped_bad_time += 1
                continue

            try:
                lon = float(lon_s)
                lat = float(lat_s)
            except ValueError:
                continue
            if not coordinate_ok(location, lat, lon):
                continue

            # De-dupe: A1 records occasionally also appear verbatim in the
            # matching A2 export for the same half-year in these government
            # exports. Same (date, time, lon, lat, severity) is treated as
            # the same physical accident.
            key = (date, time, round(lon, 6), round(lat, 6), severity)
            if key in seen_keys:
                continue
            seen_keys.add(key)

            records.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "date": date,
                    "accident_type": "pedestrian",
                    "category": category,
                    "severity": severity,
                    "time": time,
                    "location": location,
                }
            )
    return records, skipped_bad_time


# New-format column indices (0-based), named for clarity at the call site.
COL_DATE = 2          # 發生日期, already YYYYMMDD Gregorian
COL_TIME = 3           # 發生時間, HHMMSS
COL_CATEGORY = 4       # 事故類別名稱, "A1"/"A2"
COL_LOCATION = 6       # 發生地點
COL_SEVERITY = 32      # 死亡受傷人數
COL_PARTY_MAJOR = 34   # 當事者區分-類別-大類別名稱-車種
COL_PARTY_MINOR = 35   # 當事者區分-類別-子類別名稱-車種
COL_LON = 49           # 經度
COL_LAT = 50           # 緯度


def convert_new_format_file(path, seen_keys):
    """
    New format is one row per PARTY, not per accident -- group consecutive
    rows sharing (date, time, location) into one accident, and flag it
    pedestrian-involved if any row in the group has 車種子類別名稱=="行人"
    (not just 大類別=="人", which also covers passengers/"其他人").
    """
    records = []
    skipped_bad_time = 0

    groups = {}  # (date, time, location) -> accumulated accident info
    order = []   # preserve first-seen order for stable output

    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            return records, skipped_bad_time

        for row in reader:
            if len(row) < 51:
                continue

            location = row[COL_LOCATION]
            if not location_in_region(location):
                continue

            date = yyyymmdd_to_iso(row[COL_DATE])
            if date is None:
                skipped_bad_time += 1
                continue
            time = row[COL_TIME].strip()

            key = (date, time, location)
            if key not in groups:
                try:
                    lon = float(row[COL_LON])
                    lat = float(row[COL_LAT])
                except ValueError:
                    continue
                if not coordinate_ok(location, lat, lon):
                    continue

                groups[key] = {
                    "latitude": lat,
                    "longitude": lon,
                    "date": date,
                    "accident_type": "pedestrian",
                    "category": row[COL_CATEGORY].strip() or "A2",
                    "severity": row[COL_SEVERITY],
                    "time": time,
                    "location": location,
                    "has_pedestrian": False,
                }
                order.append(key)

            if row[COL_PARTY_MINOR].strip() == "行人":
                groups[key]["has_pedestrian"] = True

    for key in order:
        info = groups[key]
        if not info.pop("has_pedestrian"):
            continue

        dedupe_key = (
            info["date"],
            info["time"],
            round(info["longitude"], 6),
            round(info["latitude"], 6),
            info["severity"],
        )
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        records.append(info)

    return records, skipped_bad_time


def find_source(sql_dir, filename):
    """The file directly in --sql-dir, or anywhere in its subfolders
    (e.g. sql/111年傷亡道路交通事故資料/111年度A1交通事故資料.csv)."""
    direct = sql_dir / filename
    if direct.exists():
        return direct
    return next(iter(sorted(sql_dir.rglob(filename))), direct)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sql-dir", required=True, help="Folder containing the A1/A2 CSVs")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--region", choices=["taipei", "taiwan"], default="taipei",
                        help="taipei (default, original behaviour) or taiwan (every county)")
    args = parser.parse_args()
    global REGION
    REGION = args.region

    sql_dir = Path(args.sql_dir)
    all_records = []
    seen_keys = set()
    total_skipped_bad_time = 0

    for filename, category in OLD_FORMAT_SOURCE_FILES:
        path = find_source(sql_dir, filename)
        if not path.exists():
            print(f"SKIPPING (not found): {path}", file=sys.stderr)
            continue
        records, skipped_bad_time = convert_old_format_file(path, category, seen_keys)
        total_skipped_bad_time += skipped_bad_time
        print(f"{filename}: {len(records)} {REGION} pedestrian-involved records "
              f"({skipped_bad_time} rows had unparsable timestamps)")
        all_records.extend(records)

    for filename in NEW_FORMAT_SOURCE_FILES:
        path = find_source(sql_dir, filename)
        if not path.exists():
            print(f"SKIPPING (not found): {path}", file=sys.stderr)
            continue
        records, skipped_bad_time = convert_new_format_file(path, seen_keys)
        total_skipped_bad_time += skipped_bad_time
        print(f"{filename}: {len(records)} {REGION} pedestrian-involved accidents "
              f"({skipped_bad_time} rows had unparsable dates)")
        all_records.extend(records)

    all_records.sort(key=lambda r: (r["date"], r["time"]))

    dates = [r["date"] for r in all_records]
    print()
    print(f"TOTAL: {len(all_records)} records")
    print(f"Date range: {min(dates)} .. {max(dates)}")
    print(f"Unparsable-date/time rows skipped across all files: {total_skipped_bad_time}")
    if REGION == "taiwan":
        from collections import Counter
        print("By county:", dict(Counter(county_of(r["location"]) for r in all_records).most_common()))
        print("Rows rejected for a coordinate outside their county's box (all parties, "
              "most are non-pedestrian rows that would be dropped anyway):", BOX_REJECTS)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(all_records, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
