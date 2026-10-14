#!/usr/bin/env python3
"""
build_real_stores.py

Rebuilds realConvenienceStoresTaipei.json using two better sources than the
previous ~2015 ctiml/convenience-store-data mirror:

1. 7-Eleven + FamilyMart: taken from the "taiwan-cvs-map" project
   (https://github.com/Minato1123/taiwan-cvs-map), whose scripts/
   fetch-711-mart-list.ts and fetch-familymart-list.ts hit the chains' own
   OFFICIAL store-locator APIs directly (7-Eleven's emap.pcsc.com.tw,
   FamilyMart's api.map.com.tw) -- so these already have real,
   chain-reported coordinates with no geocoding needed at all. The project
   owner supplied a copy of that repo's pre-fetched s_data.json (7-Eleven,
   7,371 stores nationwide) and f_data.json (FamilyMart, 4,521 nationwide),
   dated 2026/09/01 per its last_updated_date.json -- see the
   taiwan-cvs-map-source/ folder alongside this script for the originals.

2. Hi-Life + OK Mart: taiwan-cvs-map doesn't cover these two, and the
   project's own sql/全國5大超商資料集 CSV has no coordinates for them
   either (see realTaipeiData.js's comment on that gap). So these two
   brands are carried over UNCHANGED from the previous ~2015 mirror
   snapshot until that gap is closed -- kept here in old_store_json so
   this script produces the full combined file in one run.

Usage:
    python3 build_real_stores.py \
        --s-data taiwan-cvs-map-source/s_data.json \
        --f-data taiwan-cvs-map-source/f_data.json \
        --old-stores realConvenienceStoresTaipei.json \
        --out realConvenienceStoresTaipei.json
"""

import argparse
import json


def convert_seven_eleven(records):
    out = []
    for r in records:
        if r.get("city") != "台北市":
            continue
        lat, lng = r.get("lat"), r.get("lng")
        if lat is None or lng is None:
            continue
        out.append(
            {
                "latitude": lat,
                "longitude": lng,
                "store_type": "7-Eleven",
                "name": r.get("name", "").removesuffix("門市"),
                "address": r.get("address", ""),
            }
        )
    return out


def convert_familymart(records):
    out = []
    for r in records:
        if r.get("city") != "台北市":
            continue
        lat, lng = r.get("lat"), r.get("lng")
        if lat is None or lng is None:
            continue
        out.append(
            {
                "latitude": lat,
                "longitude": lng,
                "store_type": "FamilyMart",
                "name": r.get("name", ""),
                "address": r.get("address", ""),
            }
        )
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--s-data", required=True, help="taiwan-cvs-map s_data.json (7-Eleven)")
    parser.add_argument("--f-data", required=True, help="taiwan-cvs-map f_data.json (FamilyMart)")
    parser.add_argument("--old-stores", required=True, help="previous realConvenienceStoresTaipei.json (for Hi-Life/OK Mart passthrough)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.s_data, encoding="utf-8") as f:
        seven_eleven_raw = json.load(f)
    with open(args.f_data, encoding="utf-8") as f:
        familymart_raw = json.load(f)
    with open(args.old_stores, encoding="utf-8") as f:
        old_stores = json.load(f)

    seven_eleven = convert_seven_eleven(seven_eleven_raw)
    familymart = convert_familymart(familymart_raw)
    passthrough = [s for s in old_stores if s.get("store_type") in ("Hi-Life", "OK Mart")]

    combined = seven_eleven + familymart + passthrough
    combined.sort(key=lambda s: (s["store_type"], s["name"]))

    counts = {}
    for s in combined:
        counts[s["store_type"]] = counts.get(s["store_type"], 0) + 1

    print("Store counts:", counts)
    print("Total:", len(combined))

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(combined, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
