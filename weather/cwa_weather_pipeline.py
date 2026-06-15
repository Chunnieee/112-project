#!/usr/bin/env python3
"""
CWA weather pipeline: fetch -> clean -> parse -> risk-score -> output.

One run can print a table, write a CSV, and/or upsert into a SQLite
database. Risk scoring runs in the same pass.

Setup:
    python -m pip install requests truststore
    export CWA_API_KEY="CWA-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"   # mac/linux
    setx CWA_API_KEY "CWA-..."                                      # windows

Examples:
    python cwa_weather_pipeline.py --print
    python cwa_weather_pipeline.py --csv weather.csv --print
    python cwa_weather_pipeline.py --csv weather.csv --db weather.db
    python cwa_weather_pipeline.py --dataid O-A0002-001 --print

If you get an SSL certificate error, the script tries to use the Windows
certificate store automatically (via the 'truststore' package). If that
still fails, add --insecure to skip verification for a quick test.
"""

import argparse
import csv
import os
import sqlite3
import sys

import requests

# Prefer the operating system's certificate store (fixes most Windows /
# antivirus / corporate-proxy SSL verification errors). Harmless if absent.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore"

FIELDS = ["station_id", "station_name", "obs_time",
          "temp", "rh", "pressure", "wind", "wind_dir", "rain", "risk"]


# --------------------------------------------------------------------------
# Step 1-4: fetch from the API
# --------------------------------------------------------------------------
def fetch(api_key, dataid, verify=True):
    """Call the CWA datastore endpoint and return the raw 'records' object."""
    url = f"{BASE_URL}/{dataid}"
    resp = requests.get(
        url,
        params={"format": "JSON"},
        headers={"Authorization": api_key, "accept": "application/json"},
        timeout=30,
        verify=verify,
    )
    resp.raise_for_status()
    data = resp.json()
    if str(data.get("success")).lower() != "true":
        raise RuntimeError(f"API returned failure: {data}")
    return data["records"]


# --------------------------------------------------------------------------
# Step 5: clean CWA sentinel values into proper Python values
# --------------------------------------------------------------------------
def to_num(value):
    """Convert a CWA cell into a float, or None when there is no data.

    CWA uses: '-' (no value), 'X' (instrument error), '/' (no observation),
    'T' (trace precipitation), and -99 / -999 style codes for missing data.
    """
    if value in ("-", "X", "/", "", None):
        return None
    text = str(value).strip()
    if text == "T":
        return 0.0
    if text.startswith("-99"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Step 6: pull out the fields we care about
# --------------------------------------------------------------------------
def _get(node, *keys):
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def parse(records):
    """Extract a flat list of dict rows from the O-A0001-001 structure.

    The exact nesting differs by dataset, so adjust the keys here if you
    switch dataid. This targets the automatic-station observation format.
    """
    stations = records.get("Station") or records.get("location") or []
    rows = []
    for s in stations:
        we = s.get("WeatherElement", {})
        rows.append({
            "station_id":   s.get("StationId") or s.get("stationId"),
            "station_name": s.get("StationName") or s.get("locationName"),
            "obs_time":     _get(s, "ObsTime", "DateTime") or s.get("obsTime"),
            "temp":         to_num(we.get("AirTemperature")),
            "rh":           to_num(we.get("RelativeHumidity")),
            "pressure":     to_num(we.get("AirPressure")),
            "wind":         to_num(we.get("WindSpeed")),
            "wind_dir":     to_num(we.get("WindDirection")),
            "rain":         to_num(_get(we, "Now", "Precipitation")),
        })
    return rows


# --------------------------------------------------------------------------
# Step 7: risk scoring (tune thresholds / weights to your model)
# --------------------------------------------------------------------------
def risk_score(row):
    """Return a 0-100 risk score from the parsed weather row."""
    score = 0
    if row["rain"] is not None and row["rain"] > 40:
        score += 50
    if row["wind"] is not None and row["wind"] > 17:
        score += 30
    if row["temp"] is not None and row["temp"] > 36:
        score += 20
    return min(score, 100)


# --------------------------------------------------------------------------
# Output: table, CSV, database
# --------------------------------------------------------------------------
def print_table(rows):
    if not rows:
        print("(no rows)")
        return
    widths = {f: len(f) for f in FIELDS}
    for r in rows:
        for f in FIELDS:
            widths[f] = max(widths[f], len(str(r.get(f, ""))))
    print("  ".join(f.ljust(widths[f]) for f in FIELDS))
    print("  ".join("-" * widths[f] for f in FIELDS))
    for r in rows:
        print("  ".join(str(r.get(f, "")).ljust(widths[f]) for f in FIELDS))


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {path}")


def upsert_db(rows, db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS weather_obs (
            station_id   TEXT,
            station_name TEXT,
            obs_time     TEXT,
            temp         REAL,
            rh           REAL,
            pressure     REAL,
            wind         REAL,
            wind_dir     REAL,
            rain         REAL,
            risk         INTEGER,
            PRIMARY KEY (station_id, obs_time)
        )
    """)
    conn.executemany("""
        INSERT INTO weather_obs
            (station_id, station_name, obs_time, temp, rh,
             pressure, wind, wind_dir, rain, risk)
        VALUES
            (:station_id, :station_name, :obs_time, :temp, :rh,
             :pressure, :wind, :wind_dir, :rain, :risk)
        ON CONFLICT(station_id, obs_time) DO UPDATE SET
            temp=excluded.temp, rh=excluded.rh, pressure=excluded.pressure,
            wind=excluded.wind, wind_dir=excluded.wind_dir,
            rain=excluded.rain, risk=excluded.risk
    """, rows)
    conn.commit()
    conn.close()
    print(f"Upserted {len(rows)} rows into {db_path}")


# --------------------------------------------------------------------------
# Glue
# --------------------------------------------------------------------------
def run(api_key, dataid, csv_path, do_print, db_path, verify=True):
    rows = parse(fetch(api_key, dataid, verify=verify))
    for r in rows:
        r["risk"] = risk_score(r)

    if do_print:
        print_table(rows)
    if csv_path:
        write_csv(rows, csv_path)
    if db_path:
        upsert_db(rows, db_path)
    if not (do_print or csv_path or db_path):
        print(f"Fetched and scored {len(rows)} rows. "
              f"Use --print, --csv, or --db to output them.")
    return rows


def main():
    parser = argparse.ArgumentParser(
        description="Fetch CWA weather data, score risk, and output it.")
    parser.add_argument("--dataid", default="O-A0001-001",
                        help="CWA dataset id (default: O-A0001-001)")
    parser.add_argument("--csv", metavar="PATH",
                        help="write output to this CSV file")
    parser.add_argument("--print", dest="do_print", action="store_true",
                        help="print an aligned table to the console")
    parser.add_argument("--db", metavar="PATH",
                        help="upsert into this SQLite database file")
    parser.add_argument("--key", default=os.environ.get("CWA_API_KEY"),
                        help="CWA authorization key (else uses $CWA_API_KEY)")
    parser.add_argument("--insecure", action="store_true",
                        help="skip SSL certificate verification (testing only)")
    args = parser.parse_args()

    if not args.key:
        sys.exit("Error: set CWA_API_KEY env var or pass --key.")

    verify = not args.insecure
    if args.insecure:
        import urllib3
        urllib3.disable_warnings()

    run(args.key, args.dataid, args.csv, args.do_print, args.db, verify=verify)


if __name__ == "__main__":
    main()
