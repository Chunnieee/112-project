#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import json
import shutil
import sys
import urllib.request
import subprocess

ROOT = Path.cwd()
BUNDLE = Path(__file__).resolve().parent

SERVER = ROOT / "server.js"
ROUTE = ROOT / "routeJurisdictionV7.js"
ENGINE = ROOT / "tdxEtaEngine.js"
CORE = ROOT / "etaSystemCore.js"
EVIDENCE = ROOT / "etaEvidenceV6.js"
TEST_V7 = ROOT / "testEtaV7.js"
DATA_DIR = ROOT / "data"
BOUNDARY = DATA_DIR / "taiwan_counties.geojson"
OFFLINE_MODULE = ROOT / "taiwanJurisdictionOfflineV7_1.js"
TEST_V71 = ROOT / "testEtaV7_1.js"
README_V71 = ROOT / "ETA_V7_1_README.txt"

required = [SERVER, ROUTE, ENGINE, CORE, EVIDENCE]
for path in required:
    if not path.exists():
        raise SystemExit(f"PATCH FAILED: missing required file: {path}")

server_text = SERVER.read_text()
route_text = ROUTE.read_text()
engine_text = ENGINE.read_text()
core_text = CORE.read_text()
evidence_text = EVIDENCE.read_text()

checks = [
    (server_text, 'from "./routeJurisdictionV7.js"', "server is not V7"),
    (route_text, "resolveRouteJurisdictions", "routeJurisdictionV7 is missing"),
    (engine_text, "same-road smoothed corridor bearing", "tdxEtaEngine is not V7"),
    (evidence_text, "ETA_EVIDENCE_V6_2_DEFAULT_THRESHOLD_FIX", "V6.2 extreme guard is missing"),
    (core_text, "TAIWAN_TDX_JURISDICTIONS", "etaSystemCore is missing jurisdiction core"),
]
for text, marker, message in checks:
    if marker not in text:
        raise SystemExit(f"PATCH FAILED: {message}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup_targets = [ROUTE, ENGINE, CORE]
if TEST_V7.exists():
    backup_targets.append(TEST_V7)
for optional in (BOUNDARY, OFFLINE_MODULE, TEST_V71, README_V71):
    if optional.exists():
        backup_targets.append(optional)

backups = {}
for path in backup_targets:
    suffix = path.suffix
    backup = path.with_name(f"{path.stem}.before-eta-v7-1-{stamp}{suffix}")
    shutil.copy2(path, backup)
    backups[path] = backup
    print(f"Backup: {backup}")

created = []

def restore_all():
    for path, backup in backups.items():
        if backup.exists():
            shutil.copy2(backup, path)
    for path in created:
        if path.exists() and path not in backups:
            try:
                path.unlink()
            except OSError:
                pass


def copy_if_needed(src, dst):
    src = Path(src).resolve()
    dst = Path(dst).resolve()
    if src == dst:
        return
    shutil.copy2(src, dst)


def valid_boundary_file(path):
    try:
        data = json.loads(Path(path).read_text())
        features = data.get("features") if isinstance(data, dict) else None
        if not isinstance(features, list) or len(features) < 20:
            return False
        polygon_count = 0
        for feature in features:
            geometry = (feature or {}).get("geometry") or {}
            if geometry.get("type") in ("Polygon", "MultiPolygon"):
                polygon_count += 1
        return polygon_count >= 20
    except Exception:
        return False


def download_boundary(path):
    urls = [
        "https://raw.githubusercontent.com/ronnywang/twgeojson/master/twcounty2010.4.json",
        "https://github.com/ronnywang/twgeojson/raw/refs/heads/master/twcounty2010.4.json",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    last_error = None
    for url in urls:
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "RiskNav-V7.1-installer/1.0"},
            )
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = response.read()
            tmp.write_bytes(payload)
            if valid_boundary_file(tmp):
                tmp.replace(path)
                print(f"Boundary data ready: {path} ({path.stat().st_size} bytes)")
                return
            last_error = RuntimeError(f"downloaded boundary file from {url} failed validation")
        except Exception as exc:
            last_error = exc
            try:
                completed = subprocess.run(
                    ["curl", "-fL", "--connect-timeout", "10", "--max-time", "40", "-A", "RiskNav-V7.1-installer/1.0", url, "-o", str(tmp)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if completed.returncode == 0 and valid_boundary_file(tmp):
                    tmp.replace(path)
                    print(f"Boundary data ready via curl: {path} ({path.stat().st_size} bytes)")
                    return
                if completed.returncode != 0:
                    last_error = RuntimeError(completed.stderr.strip() or f"curl exit {completed.returncode}")
            except Exception as curl_exc:
                last_error = curl_exc
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
    raise RuntimeError(f"could not download Taiwan boundary GeoJSON: {last_error}")

try:
    if not valid_boundary_file(BOUNDARY):
        existed_before = BOUNDARY.exists()
        download_boundary(BOUNDARY)
        if not existed_before:
            created.append(BOUNDARY)
    else:
        print(f"Boundary data already valid: {BOUNDARY}")

    for src_name, dst in [
        ("taiwanJurisdictionOfflineV7_1.js", OFFLINE_MODULE),
        ("testEtaV7_1.js", TEST_V71),
        ("ETA_V7_1_README.txt", README_V71),
    ]:
        existed = dst.exists()
        copy_if_needed(BUNDLE / src_name, dst)
        if not existed:
            created.append(dst)

    copy_if_needed(BUNDLE / "routeJurisdictionV7.v7_1.js", ROUTE)
    copy_if_needed(BUNDLE / "tdxEtaEngine.v7_1.js", ENGINE)
    copy_if_needed(BUNDLE / "etaSystemCore.v7_1.js", CORE)
    copy_if_needed(BUNDLE / "testEtaV7.v7_1_compat.js", TEST_V7)

    print("ETA V7.1 RESILIENCE INSTALLED")
    print("- offline county/city point-in-polygon fallback + provider circuit breaker")
    print("- TDX section bearing smoothing before strict direction comparison")
    print("- V7 actual-trip idempotency/resume/outbox behavior preserved")
except Exception as exc:
    restore_all()
    print(f"PATCH FAILED: {exc}", file=sys.stderr)
    raise SystemExit(1)
