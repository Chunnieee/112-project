#!/usr/bin/env python3
"""
database/build_database.py

Builds database/pedestrian_safety.db (SQLite) from the raw data in csv/ plus the
downloaded convenience-store list. The server reads its data from this
database (see db.js); open the same file in TablePlus to browse it.

    npm run db:build          (= python database/build_database.py)

What goes in (all paths relative to the project root):
  accidents      csv/<year>.../*A1*.csv, *A2*.csv     -> accidents, accident_parties
  streetlights   csv/路燈資料/...                       -> streetlights, streetlight_coverage(_cells)
  stores         pedestrianSafety/data/realConvenienceStoresTaiwan.json
                 (downloaded by `npm run update-stores`) -> convenience_stores
  road alerts    csv/道路施工、災害路段提醒.csv            -> road_alerts (reference only)

The CSV parsing is NOT re-implemented here: it imports the existing
pedestrianSafety/data/build_*.py scripts and uses their readers, file lists,
coordinate checks and de-duplication rules, so the database holds exactly the
same records the app used before.

Safety:
  * builds into pedestrian_safety.db.building and only replaces the real file
    after every check passed -- a failed or interrupted build never leaves a
    half-written database behind (the old one keeps working);
  * every table has type/range CHECK constraints and foreign keys;
  * runs PRAGMA integrity_check + foreign_key_check and sanity checks on the
    row counts before publishing.

Options:
  --csv-dir DIR         folder with the CSVs (default: csv)
  --out FILE            output database (default: database/pedestrian_safety.db)
  --skip-parties        leave accident_parties empty (smaller, faster build)
  --skip-road-alerts    leave road_alerts empty
"""

import argparse
import csv
import datetime as dt
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "pedestrianSafety" / "data"
sys.path.insert(0, str(DATA_DIR))

import build_real_accidents as acc_base  # noqa: E402
import build_accidents_all_modes as acc_modes  # noqa: E402
import build_real_streetlights as lights_base  # noqa: E402

SCHEMA_VERSION = "1"
SCHEMA_SQL = Path(__file__).with_name("schema.sql")
INDEX_SQL = Path(__file__).with_name("indexes_and_views.sql")

TAIWAN_COUNTIES = [
    "臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣",
    "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣",
    "金門縣", "連江縣",
]

# Same inputs as the documented build_real_streetlights.py command in README.md.
STREETLIGHT_SOURCES = [
    "路燈資料/台北路燈/street_light_all.csv",   # 臺北市 + 新北市 (merged)
    "路燈資料/台中路燈",
    "路燈資料/基隆路燈",
    "路燈資料/新竹路燈",
    "路燈資料/桃園路燈/桃園中壢區公所路燈資料",
    "路燈資料/台南路燈",
    "路燈資料/高雄路燈",
]
STREETLIGHT_PARTIAL = ["臺南市", "桃園市", "高雄市"]
ROAD_ALERTS_FILE = "道路施工、災害路段提醒.csv"

# New-format (111年度+) accident columns, by position (see build_real_accidents.py)
C_POLICE, C_WEATHER, C_LIGHT, C_ROAD_CLASS, C_SPEED = 5, 7, 8, 9, 10
C_LAYOUT_MAJOR, C_LAYOUT_MINOR = 11, 12
C_COLLISION_MAJOR, C_COLLISION_MINOR = 28, 29
C_CAUSE_MAIN = 31
C_PARTY_ORDER, C_GENDER, C_AGE, C_GEAR, C_PHONE = 33, 36, 37, 38, 39
C_ACTION, C_PARTY_CAUSE, C_HIT_RUN = 41, 47, 48

BATCH = 20000


def log(msg):
    print(f"[db:build] {msg}", flush=True)


def rel(path):
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def as_int(text):
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return None


def clean(text):
    text = (text or "").strip()
    return text or None


def joined(a, b):
    a, b = clean(a), clean(b)
    if a and b and a != b:
        return f"{a}/{b}"
    return a or b


class Builder:
    def __init__(self, db, skip_parties):
        self.db = db
        self.skip_parties = skip_parties
        self.county_id = {}
        self.next_accident_id = 1
        self.next_party_id = 1
        self.acc_rows = []
        self.party_rows = []
        self.ped_seen = set()

    # ------------------------------------------------------------------ util
    def add_source(self, dataset, path, fmt):
        cur = self.db.execute(
            "INSERT INTO source_files (dataset, file_path, file_format, file_bytes, imported_at) VALUES (?,?,?,?,?)",
            (dataset, rel(path), fmt, Path(path).stat().st_size if Path(path).exists() else None, now_iso()),
        )
        return cur.lastrowid

    def finish_source(self, source_id, read, imported, rejects):
        self.db.execute(
            "UPDATE source_files SET rows_read=?, rows_imported=?, rows_rejected=?, reject_reasons=? WHERE id=?",
            (read, imported, sum(rejects.values()), json.dumps(dict(rejects), ensure_ascii=False), source_id),
        )

    def set_meta(self, key, value):
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False)
        self.db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", (key, value))

    def counties(self):
        for i, name in enumerate(TAIWAN_COUNTIES, start=1):
            self.db.execute("INSERT INTO counties (id, name) VALUES (?, ?)", (i, name))
            self.county_id[name] = i

    def county_of_text(self, text):
        head = str(text or "").replace("台", "臺")[:3]
        return self.county_id.get(head)

    # ------------------------------------------------------------- accidents
    def flush_accidents(self, force=False):
        if self.acc_rows and (force or len(self.acc_rows) >= BATCH):
            self.db.executemany(
                "INSERT INTO accidents (id, occurred_date, occurred_time, category, county_id, location, latitude, longitude,"
                " deaths, injuries, severity_text, involves_pedestrian, involves_scooter, involves_car, involves_bicycle,"
                " police_unit, weather, light_condition, road_class, speed_limit, road_layout, collision_type, primary_cause,"
                " duplicate_of_id, source_file_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                self.acc_rows,
            )
            self.acc_rows = []
        if self.party_rows and (force or len(self.party_rows) >= BATCH):
            self.db.executemany(
                "INSERT INTO accident_parties (id, accident_id, party_order, vehicle_class, vehicle_subclass, gender, age,"
                " protective_gear, phone_use, action, cause, hit_and_run) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                self.party_rows,
            )
            self.party_rows = []

    def add_accident(self, seen, rejects, *, date_iso, time_s, lat, lon, flags, severity, category, location,
                     source_id, details=None, parties=()):
        """Same acceptance rules as build_accidents_all_modes.add() (vehicle
        modes) and build_real_accidents.py (walking): a repeat of an earlier
        record is dropped, unless it is the first pedestrian copy of a record
        whose earlier copy had no pedestrian -- see accidents.duplicate_of_id."""
        key = (date_iso, time_s, round(lon, 6), round(lat, 6), severity)
        has_ped = bool(flags & acc_modes.F_WALK)
        duplicate_of = None
        if key in seen:
            if not has_ped or key in self.ped_seen:
                rejects["duplicate-of-earlier-record"] += 1
                return False
            duplicate_of = seen[key]
        aid = self.next_accident_id
        if duplicate_of is None:
            seen[key] = aid
        if has_ped:
            self.ped_seen.add(key)
        day = (dt.date.fromisoformat(date_iso) - acc_modes.DAY0).days
        if not (0 <= day < 65535):
            rejects["date-out-of-range"] += 1
            return False
        deaths, injuries = acc_modes.parse_severity(severity)
        county = self.county_of_text(location)
        d = details or {}
        self.next_accident_id += 1
        self.acc_rows.append((
            aid, date_iso, time_s, category if category in ("A1", "A2") else "A2", county, location, lat, lon,
            deaths, injuries, severity,
            int(bool(flags & acc_modes.F_WALK)), int(bool(flags & acc_modes.F_SCOOTER)),
            int(bool(flags & acc_modes.F_CAR)), int(bool(flags & acc_modes.F_BIKE)),
            d.get("police_unit"), d.get("weather"), d.get("light_condition"), d.get("road_class"), d.get("speed_limit"),
            d.get("road_layout"), d.get("collision_type"), d.get("primary_cause"), duplicate_of, source_id,
        ))
        if not self.skip_parties:
            for p in parties:
                self.party_rows.append((self.next_party_id, aid) + p)
                self.next_party_id += 1
        self.flush_accidents()
        return True

    def import_accidents(self, csv_dir):
        acc_base.REGION = "taiwan"
        seen = {}  # dedupe key -> id of the kept accident
        total = 0

        for filename, category in acc_base.OLD_FORMAT_SOURCE_FILES:
            path = acc_base.find_source(csv_dir, filename)
            if not path.exists():
                log(f"  skip (not found): {filename}")
                continue
            sid = self.add_source("accidents", path, "110年度 (one row per accident)")
            rejects, read, imported = Counter(), 0, 0
            with open(path, encoding="utf-8-sig", newline="") as f:
                r = csv.reader(f)
                next(r, None)
                for row in r:
                    read += 1
                    if len(row) < 6:
                        rejects["short-row"] += 1
                        continue
                    occurred, location, severity, vehicles, lon_s, lat_s = row[:6]
                    if not acc_base.location_in_region(location):
                        rejects["not-taiwan-location"] += 1
                        continue
                    date_iso, time_s = acc_base.roc_to_gregorian_date_time(occurred)
                    if date_iso is None:
                        rejects["bad-date"] += 1
                        continue
                    try:
                        lon, lat = float(lon_s), float(lat_s)
                    except ValueError:
                        rejects["bad-coordinate"] += 1
                        continue
                    if not acc_base.coordinate_ok(location, lat, lon):
                        rejects["coordinate-outside-county"] += 1
                        continue
                    parties = []
                    for n, party in enumerate(str(vehicles or "").split(";"), start=1):
                        sub, _, major = party.strip().rpartition("-")
                        if party.strip():
                            parties.append((n, clean(major), clean(sub), None, None, None, None, None, None, None))
                    if self.add_accident(seen, rejects, date_iso=date_iso, time_s=time_s, lat=lat, lon=lon,
                                         flags=acc_modes.flags_old_field(vehicles), severity=severity,
                                         category=category, location=location, source_id=sid, parties=parties):
                        imported += 1
            self.finish_source(sid, read, imported, rejects)
            total += imported
            log(f"  {filename}: {imported:,} accidents (rejected {sum(rejects.values()):,})")

        for filename in acc_base.NEW_FORMAT_SOURCE_FILES:
            path = acc_base.find_source(csv_dir, filename)
            if not path.exists():
                log(f"  skip (not found): {filename}")
                continue
            sid = self.add_source("accidents", path, "111年度+ (one row per party)")
            rejects, read, imported = Counter(), 0, 0
            groups = {}
            with open(path, encoding="utf-8-sig", newline="") as f:
                r = csv.reader(f)
                next(r, None)
                for row in r:
                    read += 1
                    if len(row) < 51:
                        rejects["short-row"] += 1
                        continue
                    location = row[acc_base.COL_LOCATION]
                    date_iso = acc_base.yyyymmdd_to_iso(row[acc_base.COL_DATE])
                    if date_iso is None:
                        rejects["bad-date"] += 1
                        continue
                    key = (date_iso, row[acc_base.COL_TIME].strip(), location)
                    g = groups.get(key)
                    if g is None:
                        g = groups[key] = {"row": row, "flags": 0, "parties": []}
                    major = row[acc_base.COL_PARTY_MAJOR].strip()
                    minor = row[acc_base.COL_PARTY_MINOR].strip()
                    g["flags"] |= acc_modes.flags_new_party(major, minor)
                    hr = row[C_HIT_RUN].strip()
                    g["parties"].append((
                        as_int(row[C_PARTY_ORDER]) or len(g["parties"]) + 1, clean(major), clean(minor),
                        clean(row[C_GENDER]), as_int(row[C_AGE]), clean(row[C_GEAR]), clean(row[C_PHONE]),
                        clean(row[C_ACTION]), clean(row[C_PARTY_CAUSE]), 1 if hr == "是" else 0 if hr == "否" else None,
                    ))
            for (date_iso, time_s, location), g in groups.items():
                row = g["row"]
                if not acc_base.location_in_region(location):
                    rejects["not-taiwan-location"] += 1
                    continue
                try:
                    lon, lat = float(row[acc_base.COL_LON]), float(row[acc_base.COL_LAT])
                except ValueError:
                    rejects["bad-coordinate"] += 1
                    continue
                if not acc_base.coordinate_ok(location, lat, lon):
                    rejects["coordinate-outside-county"] += 1
                    continue
                details = {
                    "police_unit": clean(row[C_POLICE]),
                    "weather": clean(row[C_WEATHER]),
                    "light_condition": clean(row[C_LIGHT]),
                    "road_class": clean(row[C_ROAD_CLASS]),
                    "speed_limit": as_int(row[C_SPEED]),
                    "road_layout": joined(row[C_LAYOUT_MAJOR], row[C_LAYOUT_MINOR]),
                    "collision_type": joined(row[C_COLLISION_MAJOR], row[C_COLLISION_MINOR]),
                    "primary_cause": clean(row[C_CAUSE_MAIN]),
                }
                if self.add_accident(seen, rejects, date_iso=date_iso, time_s=time_s, lat=lat, lon=lon,
                                     flags=g["flags"], severity=row[acc_base.COL_SEVERITY],
                                     category=row[acc_base.COL_CATEGORY].strip() or "A2", location=location,
                                     source_id=sid, details=details, parties=g["parties"]):
                    imported += 1
            self.finish_source(sid, read, imported, rejects)
            total += imported
            log(f"  {filename}: {imported:,} accidents from {read:,} rows (rejected {sum(rejects.values()):,})")
        self.flush_accidents(force=True)
        return total

    # ---------------------------------------------------------- streetlights
    def import_streetlights(self, csv_dir):
        partial = {lights_base.norm_city(c) for c in STREETLIGHT_PARTIAL}
        seen = set()
        per_city = Counter()
        by_partial = {c: [] for c in partial}
        total = 0
        rows = []
        for src in STREETLIGHT_SOURCES:
            target = csv_dir / src
            if not target.exists():
                log(f"  skip (not found): {src}")
                continue
            for path in lights_base.expand([target]):
                dropped = Counter()
                sid = self.add_source("streetlights", path, "streetlight csv")
                read = imported = 0
                for city, lamp_id, lat_s, lon_s in lights_base.read_rows(path, dropped):
                    read += 1
                    try:
                        lat, lon = float(lat_s), float(lon_s)
                    except (TypeError, ValueError):
                        dropped["bad-coordinate"] += 1
                        continue
                    if not (lights_base.LAT_MIN <= lat <= lights_base.LAT_MAX and lights_base.LON_MIN <= lon <= lights_base.LON_MAX):
                        dropped["outside-taiwan"] += 1
                        continue
                    box = lights_base.CITY_BOXES.get(city)
                    if box and not (box[0] <= lat <= box[1] and box[2] <= lon <= box[3]):
                        dropped["outside-its-city"] += 1
                        continue
                    lat, lon = round(lat, 6), round(lon, 6)
                    key = (city, lamp_id, lat, lon)
                    if key in seen:
                        dropped["duplicate-row"] += 1
                        continue
                    county = self.county_id.get(city)
                    if county is None:
                        dropped["unknown-county"] += 1
                        continue
                    seen.add(key)
                    rows.append((county, lamp_id or None, lat, lon, sid))
                    per_city[city] += 1
                    if city in by_partial:
                        by_partial[city].append((lat, lon))
                    imported += 1
                    if len(rows) >= BATCH:
                        self.db.executemany(
                            "INSERT INTO streetlights (county_id, lamp_id, latitude, longitude, source_file_id) VALUES (?,?,?,?,?)", rows)
                        rows = []
                if "skipped-file" in dropped:
                    self.db.execute("DELETE FROM source_files WHERE id = ?", (sid,))
                    continue
                # rows_read also counts rows the reader itself dropped (e.g. lamps not in service)
                self.finish_source(sid, imported + sum(dropped.values()), imported, dropped)
                total += imported
        if rows:
            self.db.executemany(
                "INSERT INTO streetlights (county_id, lamp_id, latitude, longitude, source_file_id) VALUES (?,?,?,?,?)", rows)

        for city, n in per_city.items():
            ctype = "partial" if city in partial else "full"
            self.db.execute("INSERT INTO streetlight_coverage (county_id, coverage_type, lamp_count) VALUES (?,?,?)",
                            (self.county_id[city], ctype, n))
        for city, pts in by_partial.items():
            if not pts:
                continue
            cells = lights_base.partial_cells(pts)
            self.db.executemany(
                "INSERT INTO streetlight_coverage_cells (county_id, cell_i, cell_j) VALUES (?,?,?)",
                [(self.county_id[city], i, j) for i, j in cells])
            log(f"  partial coverage {city}: {len(cells):,} cells")
        self.set_meta("streetlight_partial_cell_degrees", str(lights_base.PARTIAL_CELL))
        log("  by county: " + ", ".join(f"{c} {n:,}" for c, n in per_city.most_common()))
        return total

    # ---------------------------------------------------------------- stores
    def import_stores(self):
        path = DATA_DIR / "realConvenienceStoresTaiwan.json"
        meta_path = DATA_DIR / "realConvenienceStoresTaiwan.meta.json"
        if not path.exists():
            path = DATA_DIR / "realConvenienceStoresTaipei.json"
        if not path.exists():
            log("  no convenience-store file found -- run `npm run update-stores` first")
            return 0
        sid = self.add_source("convenience_stores", path, "store json (from update-stores)")
        stores = json.loads(path.read_text(encoding="utf-8"))
        rows, rejects = [], Counter()
        for s in stores:
            try:
                lat, lon = float(s["latitude"]), float(s["longitude"])
            except (KeyError, TypeError, ValueError):
                rejects["bad-coordinate"] += 1
                continue
            if not (21.8 <= lat <= 26.5 and 118.0 <= lon <= 122.1):
                rejects["outside-taiwan"] += 1
                continue
            county = self.county_of_text(s.get("city")) or self.county_of_text(s.get("address"))
            rows.append((s.get("store_type") or "unknown", s.get("name"), s.get("address"), county,
                         s.get("district"), lat, lon))
        self.db.executemany(
            "INSERT INTO convenience_stores (brand, name, address, county_id, district, latitude, longitude) VALUES (?,?,?,?,?,?,?)",
            rows)
        self.finish_source(sid, len(stores), len(rows), rejects)
        if meta_path.exists() and "Taiwan" in path.name:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.set_meta("stores_source", meta.get("source", ""))
            self.set_meta("stores_source_credit", meta.get("sourceCredit", ""))
            self.set_meta("stores_fetched_at", meta.get("fetchedAt", ""))
            self.set_meta("stores_by_brand", meta.get("byBrand", {}))
            self.set_meta("stores_include_pxmart", str(bool(meta.get("includePxMart"))).lower())
        self.set_meta("stores_scope", "taiwan" if "Taiwan" in path.name else "taipei")
        return len(rows)

    # ----------------------------------------------------------- road alerts
    def import_road_alerts(self, csv_dir):
        path = csv_dir / ROAD_ALERTS_FILE
        if not path.exists():
            log(f"  skip (not found): {ROAD_ALERTS_FILE}")
            return 0
        sid = self.add_source("road_alerts", path, "road alert csv")
        rows, read = [], 0
        cols = ["類別", "公告名稱", "公告內容", "影響區段", "發生時間", "管制開始時間", "管制結束時間", "備註"]
        with open(path, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            reader.fieldnames = [(h or "").lstrip("﻿").strip() for h in reader.fieldnames or []]
            for row in reader:
                read += 1
                rows.append(tuple(clean(row.get(c)) for c in cols) + (sid,))
                if len(rows) >= BATCH:
                    self.db.executemany("INSERT INTO road_alerts (alert_type, title, content, affected_section, occurred_at,"
                                        " control_start, control_end, note, source_file_id) VALUES (?,?,?,?,?,?,?,?,?)", rows)
                    rows = []
        if rows:
            self.db.executemany("INSERT INTO road_alerts (alert_type, title, content, affected_section, occurred_at,"
                                " control_start, control_end, note, source_file_id) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        self.finish_source(sid, read, read, Counter())
        return read


def verify(db):
    """Checks that must pass before the new database replaces the old one."""
    problems = []
    res = db.execute("PRAGMA integrity_check").fetchone()[0]
    if res != "ok":
        problems.append(f"integrity_check: {res}")
    fk = db.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        problems.append(f"foreign_key_check: {len(fk)} broken references, e.g. {fk[:3]}")
    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
              for t in ("accidents", "streetlights", "convenience_stores", "counties")}
    if counts["counties"] != len(TAIWAN_COUNTIES):
        problems.append("counties table incomplete")
    if counts["accidents"] < 1000:
        problems.append(f"only {counts['accidents']} accidents imported -- are the CSVs in the csv folder?")
    if db.execute("SELECT count(*) FROM accidents WHERE involves_pedestrian = 1").fetchone()[0] == 0:
        problems.append("no pedestrian accidents imported")
    if counts["streetlights"] < 1000:
        problems.append(f"only {counts['streetlights']} streetlights imported")
    if counts["convenience_stores"] == 0:
        problems.append("no convenience stores imported (run `npm run update-stores` first)")
    return problems, counts


def main():
    # Windows consoles may not use UTF-8; never crash on printing a Chinese file name.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", default=str(ROOT / "csv"))
    ap.add_argument("--out", default=str(ROOT / "database" / "pedestrian_safety.db"))
    ap.add_argument("--skip-parties", action="store_true")
    ap.add_argument("--skip-road-alerts", action="store_true")
    args = ap.parse_args()

    csv_dir = Path(args.csv_dir)
    if not csv_dir.is_absolute():
        csv_dir = (Path.cwd() / csv_dir).resolve()
    if not csv_dir.is_dir():
        sys.exit(f"[db:build] CSV folder not found: {csv_dir}")
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".building")
    for p in (tmp, Path(str(tmp) + "-journal")):
        if p.exists():
            p.unlink()

    started = time.time()
    log(f"building {rel(tmp)} from {rel(csv_dir)}")
    db = sqlite3.connect(tmp)
    try:
        db.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-200000;")
        db.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
        db.execute("PRAGMA foreign_keys=OFF")  # checked in one pass at the end (foreign_key_check)
        b = Builder(db, args.skip_parties)
        b.counties()

        log("accidents ...")
        n_acc = b.import_accidents(csv_dir)
        log(f"accidents: {n_acc:,}")
        log("streetlights ...")
        n_lights = b.import_streetlights(csv_dir)
        log(f"streetlights: {n_lights:,}")
        log("convenience stores ...")
        n_stores = b.import_stores()
        log(f"convenience stores: {n_stores:,}")
        n_alerts = 0
        if not args.skip_road_alerts:
            log("road alerts ...")
            n_alerts = b.import_road_alerts(csv_dir)
            log(f"road alerts: {n_alerts:,}")

        dr = db.execute("SELECT min(occurred_date), max(occurred_date) FROM accidents").fetchone()
        b.set_meta("schema_version", SCHEMA_VERSION)
        b.set_meta("built_at", now_iso())
        b.set_meta("built_by", "database/build_database.py")
        b.set_meta("accidents_date_from", dr[0] or "")
        b.set_meta("accidents_date_to", dr[1] or "")
        b.set_meta("accidents_day0", acc_modes.DAY0.isoformat())
        b.set_meta("accident_parties_included", "false" if args.skip_parties else "true")
        b.set_meta("car_classes", sorted(acc_modes.CAR_CLASSES))
        db.commit()

        log("indexes + views ...")
        db.executescript(INDEX_SQL.read_text(encoding="utf-8"))
        db.execute("ANALYZE")
        db.commit()

        log("verifying ...")
        problems, counts = verify(db)
        db.execute("PRAGMA journal_mode=DELETE")
        db.commit()
    except Exception:
        db.close()
        log("FAILED -- the existing database (if any) was left untouched.")
        raise
    db.close()

    if problems:
        log("NOT publishing the new database, because:")
        for p in problems:
            log(f"  - {p}")
        log(f"(the incomplete build is kept at {rel(tmp)} for inspection)")
        sys.exit(1)

    try:
        os.replace(tmp, out)
    except PermissionError:
        sys.exit(f"[db:build] could not replace {rel(out)} -- it is open in another program "
                 "(stop the server / close TablePlus) and run again. New build kept at " + rel(tmp))

    size_mb = out.stat().st_size / 1e6
    log(f"done in {time.time() - started:.0f}s -> {rel(out)} ({size_mb:,.0f} MB)")
    log("  " + ", ".join(f"{k} {v:,}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
