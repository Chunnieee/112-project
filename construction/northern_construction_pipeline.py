#!/usr/bin/env python3
"""
Northern Taiwan construction pipeline (Taipei, New Taipei, Taoyuan, Keelung).

Each city publishes construction data differently, so every city has its own
"adapter": a URL plus a function that maps that city's raw fields into one
shared schema. All cities are then written to a single CSV / table / SQLite
table, keyed on (city, case_id).

Status of each adapter:
  - taipei      : WORKING. Real-time feed, ~10 min, includes coordinates.
  - new_taipei  : WORKING (verify the dataset UUID on the portal if it 404s).
  - taoyuan     : OFF. No confirmed open API yet - set URL + mapping to enable.
  - keelung     : OFF. No confirmed open feed yet - set URL + mapping to enable.

Setup:
    python -m pip install requests truststore

Examples:
    python northern_construction_pipeline.py --print
    python northern_construction_pipeline.py --csv north.csv --db north.db
    python northern_construction_pipeline.py --city taipei --print
"""

import argparse
import csv
import sqlite3

import requests

try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

# Shared schema written to CSV / DB.
FIELDS = ["city", "case_id", "category", "district", "addr",
          "x", "y", "start_date", "end_date",
          "blocks_traffic", "unit", "source"]


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def clean(value):
    if value is None:
        return None
    text = str(value).strip()
    return None if text in ("", "-", "null", "None") else text


def to_float(value):
    text = clean(value)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def get_json(url, verify=True):
    resp = requests.get(url, timeout=30, verify=verify)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict):
        # Unwrap common container shapes (e.g. {"result":{"records":[...]}}).
        for key in ("records", "result", "data", "rows"):
            node = data.get(key)
            if isinstance(node, list):
                return node
            if isinstance(node, dict) and isinstance(node.get("records"), list):
                return node["records"]
        for value in data.values():
            if isinstance(value, list):
                return value
        return [data]
    return data


def row(city, case_id, source, **kw):
    """Build a normalized row, filling missing fields with None."""
    base = {f: None for f in FIELDS}
    base.update(city=city, case_id=case_id, source=source, **kw)
    return base


# Date helpers - normalize every city's dates to ISO "YYYY-MM-DD".
def roc_slash_to_iso(value):
    """'115/04/22' (ROC year) -> '2026-04-22'."""
    text = clean(value)
    if not text:
        return None
    try:
        y, m, d = text.split("/")
        return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"
    except Exception:
        return text


def roc_compact_to_iso(value):
    """'1090218' (ROC yyymmdd) -> '2020-02-18'."""
    text = clean(value)
    if not text or not text.isdigit() or len(text) < 5:
        return text
    try:
        y = int(text[:-4]) + 1911
        return f"{y:04d}-{int(text[-4:-2]):02d}-{int(text[-2:]):02d}"
    except Exception:
        return text


def ad_slash_to_iso(value):
    """'2026/6/14' (Gregorian) -> '2026-06-14'."""
    text = clean(value)
    if not text:
        return None
    try:
        y, m, d = text.split("/")
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    except Exception:
        return text


# --------------------------------------------------------------------------
# Adapter: Taipei  (WORKING - real-time, with coordinates)
# --------------------------------------------------------------------------
TAIPEI_URL = "https://tpnco.blob.core.windows.net/blobfs/Appwork.json"
TAIPEI_MODE = {"0": "construction", "3": "milling/paving", "4": "emergency repair",
               "5": "road maintenance", "6": "manhole work", "B": "facility restoration"}


def taipei(verify=True):
    out = []
    for feat in get_json(TAIPEI_URL, verify=verify):
        # Taipei is GeoJSON: real fields live inside each feature's "properties".
        r = feat.get("properties", {}) if isinstance(feat, dict) else {}
        ac_no, sno = clean(r.get("Ac_no")), clean(r.get("sno"))
        if not ac_no or not sno:
            continue
        mode = clean(r.get("AppMode"))
        out.append(row(
            "taipei", f"{ac_no}-{sno}", TAIPEI_URL,
            category=TAIPEI_MODE.get(mode, mode),
            district=clean(r.get("C_Name")),
            addr=clean(r.get("Addr")),
            x=to_float(r.get("X")), y=to_float(r.get("Y")),
            start_date=roc_slash_to_iso(r.get("Cb_Da")),
            end_date=roc_slash_to_iso(r.get("Ce_Da")),
            blocks_traffic=clean(r.get("IsBlock")),
            unit=clean(r.get("App_Name")),
        ))
    return out


# --------------------------------------------------------------------------
# Adapter: New Taipei  (WORKING - daily road-excavation dataset)
# If this 404s, open https://data.ntpc.gov.tw , search "道路挖掘", and replace
# the UUID below with the one shown on that dataset's page.
# --------------------------------------------------------------------------
NTPC_UUID = "96b6101b-c033-4834-8bd5-e312651db7a0"
NTPC_URL = f"https://data.ntpc.gov.tw/api/datasets/{NTPC_UUID}/json?page=0&size=2000"


def new_taipei(verify=True):
    out = []
    for r in get_json(NTPC_URL, verify=verify):
        case_id = clean(r.get("caseid"))
        if not case_id:
            continue
        out.append(row(
            "new_taipei", case_id, NTPC_URL,
            category=clean(r.get("casetype")),
            district=clean(r.get("district")),
            addr=clean(r.get("digsite")),
            x=to_float(r.get("twd97x")), y=to_float(r.get("twd97y")),
            start_date=roc_compact_to_iso(r.get("casestartdate_yyymmddroc")),
            end_date=roc_compact_to_iso(r.get("caseenddate_yyymmddroc")),
            unit=clean(r.get("constructionunit")),
        ))
    return out


# --------------------------------------------------------------------------
# Adapter: Taoyuan  (WORKING - road-dig management portal feed)
# Internal endpoint behind the TYRGIS map; returns today's in-progress
# dig/construction cases. It is undocumented, so it can change without
# notice - if it stops working, re-capture the URL the same way.
# --------------------------------------------------------------------------
TYCG_URL = "https://rmic.tycg.gov.tw/TYRGIS/Ajax/GetDigCaseOnWork_Today"


def taoyuan(verify=True):
    if not TYCG_URL:
        return []
    headers = {
        "User-Agent": "Mozilla/5.0",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }
    # The endpoint may answer to GET or POST; try GET first, then POST.
    try:
        resp = requests.get(TYCG_URL, headers=headers, timeout=30, verify=verify)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        resp = requests.post(TYCG_URL, headers=headers, timeout=30, verify=verify)
        resp.raise_for_status()
        payload = resp.json()

    records = payload.get("Data", []) if isinstance(payload, dict) else payload
    out = []
    for r in records:
        case_id = clean(r.get("CaseCode")) or clean(r.get("CaseID"))
        if not case_id:
            continue
        out.append(row(
            "taoyuan", case_id, TYCG_URL,
            district=clean(r.get("TownName")),
            addr=clean(r.get("DigSite")),
            start_date=ad_slash_to_iso(r.get("Date_SStr")),
            end_date=ad_slash_to_iso(r.get("Date_EStr")),
            unit=clean(r.get("FNA")),
        ))
    return out


# --------------------------------------------------------------------------
# Adapter: Keelung  (OFF - needs a confirmed data URL)
# --------------------------------------------------------------------------
KLCG_URL = None


def keelung(verify=True):
    if not KLCG_URL:
        return []
    out = []
    for r in get_json(KLCG_URL, verify=verify):
        # TODO: map Keelung's real field names once the dataset is confirmed.
        case_id = clean(r.get("CaseID")) or clean(r.get("id"))
        if not case_id:
            continue
        out.append(row("keelung", case_id, KLCG_URL,
                       addr=clean(r.get("Address")),
                       start_date=clean(r.get("StartDate")),
                       end_date=clean(r.get("EndDate"))))
    return out


SOURCES = {
    "taipei":     {"fn": taipei,     "enabled": True},
    "new_taipei": {"fn": new_taipei, "enabled": True},
    "taoyuan":    {"fn": taoyuan,    "enabled": bool(TYCG_URL)},
    "keelung":    {"fn": keelung,    "enabled": bool(KLCG_URL)},
}


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def print_table(rows, limit=25):
    if not rows:
        print("(no rows)")
        return
    cols = ["city", "case_id", "category", "district", "addr",
            "blocks_traffic", "start_date", "end_date"]
    shown = rows[:limit]
    w = {c: len(c) for c in cols}
    for r in shown:
        for c in cols:
            w[c] = max(w[c], len(str(r.get(c) or "")))
    print("  ".join(c.ljust(w[c]) for c in cols))
    print("  ".join("-" * w[c] for c in cols))
    for r in shown:
        print("  ".join(str(r.get(c) or "").ljust(w[c]) for c in cols))
    if len(rows) > limit:
        print(f"... ({len(rows) - limit} more rows; full set is in the CSV/DB)")


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {path}")


def upsert_db(rows, db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS construction (
            city TEXT, case_id TEXT, category TEXT, district TEXT, addr TEXT,
            x REAL, y REAL, start_date TEXT, end_date TEXT,
            blocks_traffic TEXT, unit TEXT, source TEXT,
            PRIMARY KEY (city, case_id)
        )
    """)
    conn.executemany("""
        INSERT INTO construction
            (city, case_id, category, district, addr, x, y,
             start_date, end_date, blocks_traffic, unit, source)
        VALUES
            (:city, :case_id, :category, :district, :addr, :x, :y,
             :start_date, :end_date, :blocks_traffic, :unit, :source)
        ON CONFLICT(city, case_id) DO UPDATE SET
            category=excluded.category, district=excluded.district,
            addr=excluded.addr, x=excluded.x, y=excluded.y,
            start_date=excluded.start_date, end_date=excluded.end_date,
            blocks_traffic=excluded.blocks_traffic, unit=excluded.unit,
            source=excluded.source
    """, rows)
    conn.commit()
    conn.close()
    print(f"Upserted {len(rows)} rows into {db_path}")


# --------------------------------------------------------------------------
# Glue
# --------------------------------------------------------------------------
def run(csv_path, do_print, db_path, only_city, verify=True):
    rows = []
    for name, src in SOURCES.items():
        if only_city and name != only_city:
            continue
        if not src["enabled"]:
            print(f"[skip] {name}: adapter is off (no data URL set).")
            continue
        try:
            got = src["fn"](verify=verify)
            print(f"[ok]   {name}: {len(got)} records")
            rows.extend(got)
        except Exception as e:
            print(f"[fail] {name}: {e}")

    if do_print:
        print_table(rows)
    if csv_path:
        write_csv(rows, csv_path)
    if db_path:
        upsert_db(rows, db_path)
    if not (do_print or csv_path or db_path):
        print(f"\nCollected {len(rows)} records. "
              f"Use --print, --csv, or --db to output them.")
    return rows


def main():
    p = argparse.ArgumentParser(
        description="Fetch northern Taiwan construction data into one table.")
    p.add_argument("--csv", metavar="PATH", help="write output to this CSV file")
    p.add_argument("--print", dest="do_print", action="store_true",
                   help="print a table to the console")
    p.add_argument("--db", metavar="PATH", help="upsert into this SQLite db")
    p.add_argument("--city", choices=list(SOURCES),
                   help="run only one city")
    p.add_argument("--insecure", action="store_true",
                   help="skip SSL verification (testing only)")
    args = p.parse_args()

    verify = not args.insecure
    if args.insecure:
        import urllib3
        urllib3.disable_warnings()

    run(args.csv, args.do_print, args.db, args.city, verify=verify)


if __name__ == "__main__":
    main()