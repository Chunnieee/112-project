#!/usr/bin/env python3
"""
build_accidents_all_modes.py

Builds accidentsAllTaiwan.bin.gz (+ accidentsAllTaiwan.meta.json): EVERY
A1/A2 accident in Taiwan (not just pedestrian ones), tagged with which kinds
of road users were involved, so the scooter / car modes can score routes by
"accidents involving scooters" / "accidents involving cars".

Reuses build_real_accidents.py for everything about reading the government
CSVs (file list, old/new formats, ROC dates, per-county coordinate checks,
A1/A2 de-duplication), so both outputs are built from the same rows.

Why binary: 2021-2025 has ~1.9 million accidents. As JSON with address text
that is several hundred MB; this packs each accident into 13 bytes:

    float32 lat, float32 lon,           (little-endian)
    uint16  day   (days since 2021-01-01),
    uint8   flags (bit0 pedestrian, bit1 scooter/motorcycle, bit2 car/truck/bus,
                   bit3 bicycle/慢車, bit4 A1 = death within 24h),
    uint8   deaths, uint8 injuries      (capped at 255)

Records are sorted by 0.01-degree grid cell so they gzip well and the server
can build a spatial index quickly. The meta file documents the layout.

Party classification (new 111+ format, per party row):
    pedestrian : 當事者 子類別 == "行人"
    scooter    : 大類別 == "機車"
    car        : 大類別 in CAR_CLASSES (小客車, 小貨車, 大貨車, 大客車, 曳引車, 聯結車, 特種車, 軍車)
    bicycle    : 大類別 == "慢車"
Old 110 format: the ";"-joined 車種 field, "<子類>-<大類>" per party.

Usage (from the project root):
    python3 pedestrianSafety/data/build_accidents_all_modes.py --sql-dir csv \
        --out pedestrianSafety/data/accidentsAllTaiwan.bin.gz
"""

import argparse
import csv
import datetime as dt
import gzip
import json
import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_real_accidents as base  # noqa: E402

CAR_CLASSES = {"小客車", "小貨車(含客、貨兩用)", "大貨車", "大客車", "曳引車", "半聯結車", "全聯結車", "特種車", "軍車"}
F_WALK, F_SCOOTER, F_CAR, F_BIKE, F_A1 = 1, 2, 4, 8, 16
DAY0 = dt.date(2021, 1, 1)
RECORD = struct.Struct("<ffHBBB")


def parse_severity(text):
    """'死亡1;受傷2' -> (1, 2)"""
    deaths = injuries = 0
    for part in str(text or "").split(";"):
        part = part.strip()
        try:
            if part.startswith("死亡"):
                deaths = int(part[2:] or 0)
            elif part.startswith("受傷"):
                injuries = int(part[2:] or 0)
        except ValueError:
            pass
    return min(deaths, 255), min(injuries, 255)


def flags_new_party(major, minor):
    f = 0
    if minor == "行人":
        f |= F_WALK
    if major == "機車":
        f |= F_SCOOTER
    if major in CAR_CLASSES:
        f |= F_CAR
    if major == "慢車":
        f |= F_BIKE
    return f


def flags_old_field(vehicles):
    f = 0
    for party in str(vehicles or "").split(";"):
        sub, _, major = party.strip().rpartition("-")
        if sub == "行人" and major == "人":
            f |= F_WALK
        if major == "機車":
            f |= F_SCOOTER
        if major in CAR_CLASSES:
            f |= F_CAR
        if major == "慢車":
            f |= F_BIKE
    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sql-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    base.REGION = "taiwan"
    root = Path(args.sql_dir)

    records = []  # (lat, lon, day, flags, deaths, injuries)
    seen = set()
    rejected = Counter()

    def add(date_iso, time_s, lat, lon, flags, severity, category):
        key = (date_iso, time_s, round(lon, 6), round(lat, 6), severity)
        if key in seen:
            return
        seen.add(key)
        d, i = parse_severity(severity)
        if category == "A1" or d > 0:
            flags |= F_A1
        day = (dt.date.fromisoformat(date_iso) - DAY0).days
        if not (0 <= day < 65535):
            rejected["date-out-of-range"] += 1
            return
        records.append((lat, lon, day, flags, d, i))

    for filename, category in base.OLD_FORMAT_SOURCE_FILES:
        path = base.find_source(root, filename)
        if not path.exists():
            print(f"SKIPPING (not found): {filename}", file=sys.stderr)
            continue
        with open(path, encoding="utf-8-sig", newline="") as f:
            r = csv.reader(f)
            next(r, None)
            for row in r:
                if len(row) < 6:
                    continue
                occurred, location, severity, vehicles, lon_s, lat_s = row[:6]
                if not base.location_in_region(location):
                    rejected["not-taiwan-location"] += 1
                    continue
                date_iso, time_s = base.roc_to_gregorian_date_time(occurred)
                if date_iso is None:
                    rejected["bad-date"] += 1
                    continue
                try:
                    lon, lat = float(lon_s), float(lat_s)
                except ValueError:
                    rejected["bad-coordinate"] += 1
                    continue
                if not base.coordinate_ok(location, lat, lon):
                    rejected["coordinate-outside-county"] += 1
                    continue
                add(date_iso, time_s, lat, lon, flags_old_field(vehicles), severity, category)
        print(f"{filename}: total so far {len(records)}", file=sys.stderr)

    for filename in base.NEW_FORMAT_SOURCE_FILES:
        path = base.find_source(root, filename)
        if not path.exists():
            print(f"SKIPPING (not found): {filename}", file=sys.stderr)
            continue
        groups = {}
        with open(path, encoding="utf-8-sig", newline="") as f:
            r = csv.reader(f)
            next(r, None)
            for row in r:
                if len(row) < 51:
                    continue
                location = row[base.COL_LOCATION]
                date_iso = base.yyyymmdd_to_iso(row[base.COL_DATE])
                if date_iso is None:
                    continue
                key = (date_iso, row[base.COL_TIME].strip(), location)
                g = groups.get(key)
                if g is None:
                    g = groups[key] = {"row": row, "flags": 0}
                g["flags"] |= flags_new_party(row[base.COL_PARTY_MAJOR].strip(), row[base.COL_PARTY_MINOR].strip())
        for (date_iso, time_s, location), g in groups.items():
            row = g["row"]
            if not base.location_in_region(location):
                rejected["not-taiwan-location"] += 1
                continue
            try:
                lon, lat = float(row[base.COL_LON]), float(row[base.COL_LAT])
            except ValueError:
                rejected["bad-coordinate"] += 1
                continue
            if not base.coordinate_ok(location, lat, lon):
                rejected["coordinate-outside-county"] += 1
                continue
            add(date_iso, time_s, lat, lon, g["flags"], row[base.COL_SEVERITY], row[base.COL_CATEGORY].strip() or "A2")
        print(f"{filename}: total so far {len(records)}", file=sys.stderr)

    # Sort by 0.01° cell, then date, for compression + fast indexing.
    records.sort(key=lambda r: (int(r[0] * 100), int(r[1] * 100), r[2]))
    buf = bytearray(RECORD.size * len(records))
    for n, rec in enumerate(records):
        RECORD.pack_into(buf, n * RECORD.size, *rec)
    with gzip.open(args.out, "wb", compresslevel=9) as f:
        f.write(bytes(buf))

    counts = Counter()
    for rec in records:
        for name, bit in (("pedestrian", F_WALK), ("scooter", F_SCOOTER), ("car", F_CAR), ("bicycle", F_BIKE), ("A1", F_A1)):
            if rec[3] & bit:
                counts[name] += 1
    days = [r[2] for r in records]
    meta = {
        "format": "gzip of little-endian records: float32 lat, float32 lon, uint16 day, uint8 flags, uint8 deaths, uint8 injuries (13 bytes)",
        "recordSize": RECORD.size,
        "count": len(records),
        "day0": DAY0.isoformat(),
        "dateRange": {
            "from": (DAY0 + dt.timedelta(days=min(days))).isoformat(),
            "to": (DAY0 + dt.timedelta(days=max(days))).isoformat(),
        },
        "flags": {"pedestrian": F_WALK, "scooter": F_SCOOTER, "car": F_CAR, "bicycle": F_BIKE, "A1": F_A1},
        "countsByInvolvement": dict(counts),
        "rejected": dict(rejected),
        "carClasses": sorted(CAR_CLASSES),
    }
    Path(args.out).with_name("accidentsAllTaiwan.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(meta, ensure_ascii=False, indent=2), file=sys.stderr)


if __name__ == "__main__":
    main()
