#!/usr/bin/env python3
"""
taiwan_construction_fetch.py  (updated — all Taiwan cities)
=============================================================
Collects road construction / excavation data for the whole of Taiwan from:

  Tier 1 – Direct URLs (no auth, fetch immediately)
    • Taipei        – real-time JSON, updates every 10 min

  Tier 2 – data.gov.tw CKAN API (auto-resolves download URL at runtime)
    • New Taipei    – dataset 122989
    • Hsinchu City  – dataset 131133
    • Tainan        – dataset 172476
    • Chiayi City   – dataset 149650

  Tier 3 – City open-data portals (paste the URL you find there)
    • Taoyuan       – https://data.tycg.gov.tw  → search 道路挖掘
    • Taichung      – https://opendata.taichung.gov.tw → search 道路挖掘
    • Kaohsiung     – https://data.kcg.gov.tw   → search 道路挖掘
    • Hsinchu Cty   – https://data.hsinchu.gov.tw → search 道路挖掘
    • Nantou        – https://data.nantou.gov.tw → search 道路施工
    • Taitung       – https://data.taitung.gov.tw → search 道路施工
    • Yilan         – https://data.yilan.gov.tw  → search 道路挖掘
    • Penghu        – https://data.penghu.gov.tw → search 道路施工
    • Kinmen        – https://data.kinmen.gov.tw → search 道路施工

  No open data available (confirmed):
    • Keelung, Miaoli, Changhua, Chiayi County,
      Pingtung, Hualien, Lienchiang (Matsu)

  National highways / provincial roads:
    • TDX API (requires free account at tdx.transportdata.tw)

Requirements:
    pip install requests psycopg2-binary pyproj
"""

import json, re, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import requests

# ══════════════════════════════════════════════════════════════════════════════
#  CONFIGURATION  ← edit these values before running
# ══════════════════════════════════════════════════════════════════════════════

# TDX credentials  (https://tdx.transportdata.tw → 會員中心 → API金鑰管理)
TDX_CLIENT_ID     = "YOUR_CLIENT_ID"
TDX_CLIENT_SECRET = "YOUR_CLIENT_SECRET"
TDX_ENABLED       = False   # set True once you have credentials

# PostgreSQL
DB_CONFIG = {
    "host":     "localhost",
    "port":     5432,
    "dbname":   "your_database",
    "user":     "your_user",
    "password": "your_password",
}
DB_ENABLED = False  # set True to write to database

# ── Tier 1: Direct URLs — paste URL, ready to use ────────────────────────────
DIRECT_SOURCES = {
    "Taipei": "https://tpnco.blob.core.windows.net/blobfs/Todaywork.json",

    # Paste more direct URLs here once you find them on the city portals:
    # "Taoyuan":   "https://...",
    # "Taichung":  "https://...",
    # "Kaohsiung": "https://...",
    # "Nantou":    "https://...",
    # "Taitung":   "https://...",
    # "Yilan":     "https://...",
    # "Penghu":    "https://...",
    # "Kinmen":    "https://...",
}

# ── Tier 2: data.gov.tw dataset IDs (auto-resolved at runtime) ────────────────
# Format: "CityName": numeric_id_from_data.gov.tw_URL
DATAGOV_DATASETS = {
    "NewTaipei":  122989,   # 新北市政府道路挖掘資訊
    "HsinchuCity": 131133,  # 新竹市道路挖掘資訊
    "Tainan":     172476,   # 臺南市政府道路挖掘案件資料
    "ChiayiCity": 149650,   # 嘉義市管線挖掘資訊
}

# ── Cities with their own portals — find URL then add to DIRECT_SOURCES ──────
PORTAL_HINTS = {
    "Taoyuan":    ("https://data.tycg.gov.tw",         "search: 道路挖掘"),
    "Taichung":   ("https://opendata.taichung.gov.tw", "search: 道路挖掘"),
    "Kaohsiung":  ("https://data.kcg.gov.tw",          "search: 道路施工"),
    "HsinchuCty": ("https://data.hsinchu.gov.tw",      "search: 道路挖掘"),
    "Nantou":     ("https://data.nantou.gov.tw",       "search: 道路施工"),
    "Taitung":    ("https://data.taitung.gov.tw",      "search: 道路施工"),
    "Yilan":      ("https://data.yilan.gov.tw",        "search: 道路挖掘"),
    "Penghu":     ("https://data.penghu.gov.tw",       "search: 道路施工"),
    "Kinmen":     ("https://data.kinmen.gov.tw",       "search: 道路施工"),
}

TW_TZ = timezone(timedelta(hours=8))

# ══════════════════════════════════════════════════════════════════════════════
#  HELPER UTILITIES
# ══════════════════════════════════════════════════════════════════════════════

def safe_float(v):
    try: return float(v)
    except: return None

def parse_iso_dt(val):
    if not val: return None
    if isinstance(val, datetime): return val if val.tzinfo else val.replace(tzinfo=TW_TZ)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z","%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S","%Y-%m-%d","%Y/%m/%d"):
        try:
            dt = datetime.strptime(str(val).strip(), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=TW_TZ)
        except ValueError: pass
    return None

def parse_roc_date(val):
    """Taiwan ROC calendar: '1130601' → 2024-06-01"""
    if not val: return None
    digits = re.sub(r"\D","",str(val))
    if len(digits) == 7:
        try:
            return datetime(int(digits[:3])+1911, int(digits[3:5]),
                            int(digits[5:7]), tzinfo=TW_TZ)
        except ValueError: return None
    return parse_iso_dt(val)

def to_wgs84(x, y):
    from pyproj import Transformer
    lon, lat = Transformer.from_crs("EPSG:3826","EPSG:4326",
                                    always_xy=True).transform(x, y)
    return lat, lon

def detect_coords(x_raw, y_raw):
    """Auto-detect coordinate system and return (lat, lon) in WGS84."""
    x, y = safe_float(x_raw), safe_float(y_raw)
    if x is None or y is None: return None, None
    if 100_000 < x < 400_000 and 2_000_000 < y < 3_000_000:
        return to_wgs84(x, y)                          # TWD97 TM2
    if -90 <= y <= 90 and -180 <= x <= 180: return y, x   # WGS84 (X=lon, Y=lat)
    if -90 <= x <= 90 and -180 <= y <= 180: return x, y   # WGS84 (X=lat, Y=lon)
    return None, None

# ══════════════════════════════════════════════════════════════════════════════
#  TIER 2 — data.gov.tw CKAN RESOLVER
# ══════════════════════════════════════════════════════════════════════════════

def resolve_datagov_url(dataset_id):
    """
    Call data.gov.tw CKAN API to get the actual JSON download URL
    for a given numeric dataset ID.
    Returns (city_name, url) or raises an exception.
    """
    api = f"https://data.gov.tw/api/v2/rest/dataset/{dataset_id}"
    r   = requests.get(api, timeout=15)
    r.raise_for_status()
    meta = r.json()

    # Find JSON distribution
    for dist in meta.get("distribution", []):
        fmt = (dist.get("format") or "").upper()
        url = dist.get("downloadURL") or dist.get("accessURL") or ""
        if "JSON" in fmt and url:
            return url

    # Fallback: first available URL
    for dist in meta.get("distribution", []):
        url = dist.get("downloadURL") or dist.get("accessURL") or ""
        if url: return url

    raise ValueError(f"No download URL found in dataset {dataset_id}")

# ══════════════════════════════════════════════════════════════════════════════
#  TDX (national highways + provincial roads)
# ══════════════════════════════════════════════════════════════════════════════

def get_tdx_token():
    r = requests.post(
        "https://tdx.transportdata.tw/auth/realms/TDXConnect/"
        "protocol/openid-connect/token",
        data={"grant_type":"client_credentials",
              "client_id": TDX_CLIENT_ID,
              "client_secret": TDX_CLIENT_SECRET},
        timeout=30)
    r.raise_for_status()
    print("  ✓ TDX token acquired")
    return r.json()["access_token"]

def fetch_tdx_construction(token):
    url = ("https://tdx.transportdata.tw/api/basic"
           "/v2/Road/Traffic/Construction")
    r = requests.get(url,
                     headers={"Authorization": f"Bearer {token}",
                               "Accept-Encoding": "gzip"},
                     params={"$format":"JSON"}, timeout=60)
    if r.status_code == 404:
        print("  ⚠  404 — open https://tdx.transportdata.tw/api-service/swagger")
        print("     search '施工' to find the exact endpoint, then update the URL above.")
        return []
    r.raise_for_status()
    data = r.json()
    print(f"  ✓ {len(data)} records  |  sample keys: {list(data[0].keys()) if data else '—'}")
    return data

# ══════════════════════════════════════════════════════════════════════════════
#  FIELD NORMALISERS  (city-specific → standard schema)
# ══════════════════════════════════════════════════════════════════════════════

def norm_tdx(rec):
    def pick(*keys):
        for k in keys:
            v = rec.get(k)
            if v is not None: return v
        return None
    lat = safe_float(pick("PositionLat","StartLat","Lat","Latitude"))
    lon = safe_float(pick("PositionLon","StartLon","Lon","Longitude"))
    if lat and lon and not (21<=lat<=26 and 119<=lon<=123):
        lat, lon = lon, lat
    return {"road_name": str(pick("RoadName","RoadSectionName",
                                  "Description","EventDescription") or "")[:100],
            "lat": lat, "lon": lon,
            "start_time": parse_iso_dt(pick("StartTime","ClosureStartTime","EventStartTime")),
            "end_time":   parse_iso_dt(pick("EndTime","ClosureEndTime","EventEndTime"))}

def norm_taipei(rec):
    """Taipei 今日施工資訊 — X/Y in TWD97, dates in ROC calendar."""
    lat, lon = detect_coords(rec.get("X"), rec.get("Y"))
    if lat is None:
        pos = rec.get("Positions")
        if pos:
            try:
                if isinstance(pos, str): pos = json.loads(pos)
                if isinstance(pos, list) and pos:
                    p = pos[0]
                    lat = safe_float(p.get("lat") or p.get("Lat") or p.get("Y"))
                    lon = safe_float(p.get("lon") or p.get("Lon") or p.get("X"))
            except: pass
    return {"road_name":  str(rec.get("Addr") or "")[:100],
            "lat": lat, "lon": lon,
            "start_time": parse_roc_date(rec.get("Cb_Da")),
            "end_time":   parse_roc_date(rec.get("Ce_Da"))}

def norm_newtaipei(rec):
    """New Taipei 新北市道路挖掘 — TWD97 coords, field names in English."""
    lat, lon = detect_coords(rec.get("X") or rec.get("x"),
                              rec.get("Y") or rec.get("y"))
    return {"road_name": str(rec.get("DigSite") or rec.get("CaseName") or "")[:100],
            "lat": lat, "lon": lon,
            "start_time": parse_roc_date(rec.get("CaseStart")),
            "end_time":   parse_roc_date(rec.get("CaseEnd"))}

def norm_generic(rec):
    """Catch-all for any other city (tries common field name patterns)."""
    def pick(*keys):
        for k in keys:
            v = rec.get(k)
            if v is not None: return v
        return None
    lat, lon = detect_coords(
        pick("X","x","lon","Lon","longitude","Longitude","x_coord"),
        pick("Y","y","lat","Lat","latitude","Latitude","y_coord"))
    start = parse_roc_date(pick("CaseStart","start_time","StartDate",
                                "施工起日","Cb_Da","start","begin")) \
         or parse_iso_dt(pick("CaseStart","start_time","StartDate","start"))
    end   = parse_roc_date(pick("CaseEnd","end_time","EndDate",
                                "施工迄日","Ce_Da","end")) \
         or parse_iso_dt(pick("CaseEnd","end_time","EndDate","end"))
    road  = pick("DigSite","road_name","RoadName","Addr","addr",
                 "address","location","施工地點","CaseName","road")
    return {"road_name": str(road or "")[:100],
            "lat": lat, "lon": lon,
            "start_time": start, "end_time": end}

NORMALISERS = {
    "Taipei":     norm_taipei,
    "NewTaipei":  norm_newtaipei,
}

def normalise(city, rec):
    fn = NORMALISERS.get(city, norm_generic)
    return fn(rec)

# ══════════════════════════════════════════════════════════════════════════════
#  FETCH + NORMALISE ONE SOURCE
# ══════════════════════════════════════════════════════════════════════════════

def load_json(source):
    if source.startswith("http"):
        r = requests.get(source, timeout=30)
        r.raise_for_status()
        return r.json()
    return json.loads(Path(source).read_text(encoding="utf-8"))

def fetch_city(city, url):
    raw = load_json(url)
    # Unwrap common top-level wrappers
    if isinstance(raw, dict):
        for key in ("data","Data","features","result","records","rows"):
            if isinstance(raw.get(key), list):
                raw = raw[key]; break
    if not isinstance(raw, list):
        print(f"    ⚠  unexpected format (not a list); skipping")
        return []
    records = [normalise(city, r) for r in raw]
    records = [r for r in records
               if r["road_name"] or (r["lat"] is not None)]
    return records

# ══════════════════════════════════════════════════════════════════════════════
#  DATABASE
# ══════════════════════════════════════════════════════════════════════════════

def cleanup_old(source_name, keep_hours=24):
    import psycopg2
    conn = psycopg2.connect(**DB_CONFIG)
    cur  = conn.cursor()
    cur.execute("""
        DELETE FROM nav_data.traffic_snapshots
        WHERE  source = %s
          AND  fetched_at < NOW() - INTERVAL '%s hours'
    """, (source_name[:20], keep_hours))
    if cur.rowcount:
        print(f"    removed {cur.rowcount} old snapshot(s) for {source_name}")
    conn.commit(); cur.close(); conn.close()

def insert_batch(source_name, records):
    import psycopg2
    from psycopg2.extras import execute_values
    conn = psycopg2.connect(**DB_CONFIG)
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO nav_data.traffic_snapshots (source, record_count, fetched_at)
            VALUES (%s,%s,%s) RETURNING snapshot_id
        """, (source_name[:20], len(records), datetime.now(TW_TZ)))
        sid = cur.fetchone()[0]
        execute_values(cur, """
            INSERT INTO nav_data.road_constructions
                (snapshot_id, road_name, lat, lon, start_time, end_time)
            VALUES %s
        """, [(sid,r["road_name"],r["lat"],r["lon"],
               r["start_time"],r["end_time"]) for r in records])
        conn.commit()
        print(f"    ✓ snapshot_id={sid}  →  {len(records)} rows")
    except Exception as e:
        conn.rollback(); raise e
    finally:
        cur.close(); conn.close()

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*62)
    print("  Taiwan Construction Fetcher — all cities")
    print("="*62)
    all_batches = []   # [(city_name, [records])]

    # ── TDX national roads ───────────────────────────────────────────────────
    print("\n[TDX] National + provincial roads")
    if not TDX_ENABLED:
        print("  Skipped (set TDX_ENABLED = True + add credentials)")
    else:
        try:
            token   = get_tdx_token()
            raw     = fetch_tdx_construction(token)
            records = [norm_tdx(r) for r in raw]
            records = [r for r in records if r["lat"] is not None]
            all_batches.append(("TDX", records))
        except Exception as e:
            print(f"  ✗ {e}")

    # ── Tier 1: Direct URLs ──────────────────────────────────────────────────
    print(f"\n[Direct] {len(DIRECT_SOURCES)} cities configured")
    for city, url in DIRECT_SOURCES.items():
        print(f"\n  • {city}")
        try:
            records = fetch_city(city, url)
            all_batches.append((city, records))
            s = records[0] if records else {}
            print(f"    ✓ {len(records)} records | "
                  f"sample: {s.get('road_name','')[:35]} | "
                  f"lat={s.get('lat')} lon={s.get('lon')}")
        except Exception as e:
            print(f"    ✗ {e}")

    # ── Tier 2: data.gov.tw CKAN auto-resolve ────────────────────────────────
    print(f"\n[data.gov.tw] Auto-resolving {len(DATAGOV_DATASETS)} datasets")
    for city, dataset_id in DATAGOV_DATASETS.items():
        print(f"\n  • {city}  (dataset {dataset_id})")
        try:
            url     = resolve_datagov_url(dataset_id)
            print(f"    resolved → {url[:70]}")
            records = fetch_city(city, url)
            all_batches.append((city, records))
            s = records[0] if records else {}
            print(f"    ✓ {len(records)} records | "
                  f"sample: {s.get('road_name','')[:35]}")
        except Exception as e:
            print(f"    ✗ {e}")
            print(f"    → manual: https://data.gov.tw/dataset/{dataset_id}")

    # ── Tier 3: Portal hints (no URL yet) ────────────────────────────────────
    if PORTAL_HINTS:
        print(f"\n[Portals] {len(PORTAL_HINTS)} cities need manual URL setup")
        for city, (portal, hint) in PORTAL_HINTS.items():
            if city not in DIRECT_SOURCES:
                print(f"  • {city:15s} → {portal}  ({hint})")
                print(f"             Copy the JSON download URL and add it to DIRECT_SOURCES")

    # ── Summary ──────────────────────────────────────────────────────────────
    total = sum(len(r) for _, r in all_batches)
    print(f"\n{'─'*62}")
    print(f"Total records: {total}")
    for name, recs in all_batches:
        ok_coord = sum(1 for r in recs if r["lat"] is not None)
        print(f"  {name:<20} {len(recs):>5} records  "
              f"({ok_coord} with GPS coords)")

    # ── Insert ────────────────────────────────────────────────────────────────
    if not DB_ENABLED:
        print("\nDB_ENABLED = False — skipping insert.")
        if all_batches:
            _, preview = all_batches[0]
            print("Preview (first 2 records):")
            print(json.dumps(preview[:2], default=str, indent=2))
        return

    print("\n[DB] Inserting into PostgreSQL…")
    try:
        import psycopg2
    except ImportError:
        print("  ✗ psycopg2 not installed: pip install psycopg2-binary")
        return
    for name, records in all_batches:
        if not records: continue
        print(f"\n  {name}")
        try:
            cleanup_old(name)
            insert_batch(name, records)
        except Exception as e:
            print(f"  ✗ {e}")

    print("\nDone.")

if __name__ == "__main__":
    main()
