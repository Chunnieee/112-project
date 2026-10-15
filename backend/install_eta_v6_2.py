#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil, subprocess, sys

ROOT = Path.cwd()
SERVER = ROOT / "server.js"
EVIDENCE = ROOT / "etaEvidenceV6.js"
SOURCE_EVIDENCE = Path(__file__).with_name("etaEvidenceV6_2.js")
SOURCE_TEST = Path(__file__).with_name("testEtaV6_2.js")
TEST = ROOT / "testEtaV6_2.js"

for p in (SERVER, EVIDENCE, SOURCE_EVIDENCE, SOURCE_TEST):
    if not p.exists():
        raise SystemExit(f"PATCH FAILED: missing {p}")

server = SERVER.read_text()
if "etaEvidenceV6.js" not in server or "TDX road evidence quality" not in server:
    raise SystemExit("PATCH FAILED: ETA V6 architecture not detected")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = []
for p in (SERVER, EVIDENCE):
    b = p.with_name(f"{p.stem}.before-eta-v6-2-{stamp}{p.suffix}")
    shutil.copy2(p, b)
    backups.append((p, b))
    print(f"Backup: {b}")

try:
    # Force-write the corrected selector even if V6.1's marker is already present.
    # V6.1's installer could incorrectly consider the helper installed while the
    # default threshold still evaluated to 1 because Number(null) === 0.
    EVIDENCE.write_text(SOURCE_EVIDENCE.read_text())

    # Fix audit semantics: null/absent TravelSpeed must render as null, never 0.
    old = '''            publishedTravelSpeedKmh:\n              Number.isFinite(Number(section?.travelSpeedKmh))\n                ? Number(Number(section.travelSpeedKmh).toFixed(1))\n                : null,'''
    new = '''            publishedTravelSpeedKmh:\n              section?.travelSpeedKmh !== null &&\n              section?.travelSpeedKmh !== undefined &&\n              Number.isFinite(Number(section.travelSpeedKmh)) &&\n              Number(section.travelSpeedKmh) > 0\n                ? Number(Number(section.travelSpeedKmh).toFixed(1))\n                : null,'''
    if old in server:
        server = server.replace(old, new, 1)
    elif "publishedTravelSpeedKmh" not in server:
        raise RuntimeError("V6.1 audit field not found")
    SERVER.write_text(server)

    if SOURCE_TEST.resolve() != TEST.resolve():
        shutil.copy2(SOURCE_TEST, TEST)

    subprocess.run(["node", "--check", str(EVIDENCE)], check=True)
    subprocess.run(["node", "--check", str(SERVER)], check=True)
    subprocess.run(["node", "--test", str(TEST)], check=True)

    # Runtime smoke-test the DEFAULT path (no explicit extremeCrawlKmh).
    smoke = '''import { selectTdxLiveObservation as s } from "./etaEvidenceV6.js";\nconst r=s({dataCollectTime:new Date().toISOString(),sectionLengthKm:1.321,travelTimeSec:(1.321/1.3)*3600,travelSpeedKmh:0,maxAgeMin:20});\nif(r.accepted || r.reason!=="extreme_travel_time_uncorroborated_no_speed" || r.extremeCrawlThresholdKmh!==5){console.error(r);process.exit(1)}\nconsole.log("default extreme guard verified", r.reason, r.extremeCrawlThresholdKmh);'''
    subprocess.run(["node", "--input-type=module", "-e", smoke], cwd=str(ROOT), check=True)
except Exception:
    for target, backup in backups:
        if backup.exists():
            shutil.copy2(backup, target)
    raise

print("ETA V6.2 DEFAULT THRESHOLD FIX INSTALLED")
print("Fix: null/blank optional values no longer coerce to numeric zero")
print("Default TDX_EXTREME_CRAWL_KMH is now truly 5 km/h")
