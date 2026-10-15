#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
BUNDLE = Path(__file__).resolve().parent

CORE = ROOT / "etaSystemCore.js"
ENGINE = ROOT / "tdxEtaEngine.js"
TEST = ROOT / "testEtaV7_2.js"
README = ROOT / "ETA_V7_2_README.txt"

for path in (CORE, ENGINE):
    if not path.exists():
        raise SystemExit(f"PATCH FAILED: missing required file: {path}")

core_text = CORE.read_text()
engine_text = ENGINE.read_text()
checks = [
    (core_text, "TAIWAN_TDX_JURISDICTIONS", "etaSystemCore is not V5+"),
    (engine_text, "TDX_SECTION_BEARING_WINDOW_M", "tdxEtaEngine is not V7.1+"),
    (engine_text, "matchedRunsRaw", "tdxEtaEngine is missing V6 run aggregation"),
]
for text, marker, message in checks:
    if marker not in text:
        raise SystemExit(f"PATCH FAILED: {message}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = {}
for path in (CORE, ENGINE):
    backup = path.with_name(f"{path.stem}.before-eta-v7-2-{stamp}{path.suffix}")
    shutil.copy2(path, backup)
    backups[path] = backup
    print(f"Backup: {backup}")

created = []

def restore_all():
    for path, backup in backups.items():
        if backup.exists():
            shutil.copy2(backup, path)
    for path in created:
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass


def copy_file(src_name, dst):
    src = (BUNDLE / src_name).resolve()
    dst = dst.resolve()
    existed = dst.exists()
    if src != dst:
        shutil.copy2(src, dst)
    if not existed:
        created.append(dst)

try:
    shutil.copy2(BUNDLE / "etaSystemCore.v7_2.js", CORE)
    shutil.copy2(BUNDLE / "tdxEtaEngine.v7_2.js", ENGINE)
    copy_file("testEtaV7_2.js", TEST)
    copy_file("ETA_V7_2_README.txt", README)

    print("ETA V7.2 COVERAGE RESILIENCE INSTALLED")
    print("- TDX endpoint capability cache is now exact endpoint+scope with retry TTL")
    print("- accepted-scope strings are diagnostic hints, never global exclusion rules")
    print("- uncovered audit now classifies crossing/opposite/aligned-too-far gaps")
    print("- no direction threshold or ETA multiplier was loosened")
except Exception as exc:
    restore_all()
    print(f"PATCH FAILED: {exc}", file=sys.stderr)
    raise SystemExit(1)
