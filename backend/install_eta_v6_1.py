#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil, subprocess, sys

ROOT = Path.cwd()
SERVER = ROOT / "server.js"
EVIDENCE = ROOT / "etaEvidenceV6.js"
SOURCE_EVIDENCE = Path(__file__).with_name("etaEvidenceV6_1.js")
SOURCE_TEST = Path(__file__).with_name("testEtaV6_1.js")
TEST = ROOT / "testEtaV6_1.js"

for p in (SERVER, EVIDENCE, SOURCE_EVIDENCE, SOURCE_TEST):
    if not p.exists():
        raise SystemExit(f"PATCH FAILED: missing {p}")

server = SERVER.read_text()
old_evidence = EVIDENCE.read_text()
new_evidence = SOURCE_EVIDENCE.read_text()

if "etaEvidenceV6.js" not in server or "TDX road evidence quality" not in server:
    raise SystemExit("PATCH FAILED: ETA V6 base architecture not detected")

already_evidence = "ETA_EVIDENCE_V6_1_EXTREME_GUARD" in old_evidence
already_audit = "publishedTravelSpeedKmh" in server
if already_evidence and already_audit:
    if SOURCE_TEST.resolve() != TEST.resolve():
        shutil.copy2(SOURCE_TEST, TEST)
    subprocess.run(["node", "--check", str(EVIDENCE)], check=True)
    subprocess.run(["node", "--check", str(SERVER)], check=True)
    subprocess.run(["node", "--test", str(TEST)], check=True)
    print("ETA V6.1 extreme guard already installed and verified")
    sys.exit(0)

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
for p in (SERVER, EVIDENCE):
    backup = p.with_name(f"{p.stem}.before-eta-v6-1-{stamp}{p.suffix}")
    shutil.copy2(p, backup)
    print(f"Backup: {backup}")

# Add the raw published speed to the audit so a future disagreement is visible.
if not already_audit:
    marker = '''            evidenceReason:\n              section?.evidenceReason || null,\n\n            nearestMatchM:'''
    replacement = '''            evidenceReason:\n              section?.evidenceReason || null,\n\n            publishedTravelSpeedKmh:\n              Number.isFinite(Number(section?.travelSpeedKmh))\n                ? Number(Number(section.travelSpeedKmh).toFixed(1))\n                : null,\n\n            nearestMatchM:'''
    if marker not in server:
        raise SystemExit("PATCH FAILED: V6 audit marker not found")
    server = server.replace(marker, replacement, 1)

try:
    if not already_evidence:
        EVIDENCE.write_text(new_evidence)
    SERVER.write_text(server)
    if SOURCE_TEST.resolve() != TEST.resolve():
        shutil.copy2(SOURCE_TEST, TEST)

    subprocess.run(["node", "--check", str(EVIDENCE)], check=True)
    subprocess.run(["node", "--check", str(SERVER)], check=True)
    subprocess.run(["node", "--test", str(TEST)], check=True)
except Exception:
    # Restore from the just-created backups.
    for p in (SERVER, EVIDENCE):
        b = p.with_name(f"{p.stem}.before-eta-v6-1-{stamp}{p.suffix}")
        if b.exists(): shutil.copy2(b, p)
    raise

print("ETA V6.1 EXTREME EVIDENCE GUARD INSTALLED")
print("Policy: TravelTime < configurable extreme-crawl threshold requires TravelSpeed corroboration")
print("Default: TDX_EXTREME_CRAWL_KMH=5; no ETA multiplier or speed clamp is introduced")
