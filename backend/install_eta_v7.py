#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re
import shutil
import sys

ROOT = Path.cwd()
FRONTEND = ROOT.parent / "frontend"
BUNDLE = Path(__file__).resolve().parent

SERVER = ROOT / "server.js"
TDX_ENGINE = ROOT / "tdxEtaEngine.js"
SYSTEM_CORE = ROOT / "etaSystemCore.js"
CALIBRATION = ROOT / "etaCalibrationV5.js"
TRACKER = FRONTEND / "etaTripTracker.js"

TARGETS = [SERVER, TDX_ENGINE, SYSTEM_CORE, CALIBRATION, TRACKER]

for path in TARGETS:
    if not path.exists():
        raise SystemExit(f"PATCH FAILED: missing required file: {path}")

# Require the architecture this patch was built for. Avoid silently applying to
# an unrelated older project state.
server_text = SERVER.read_text()
engine_text = TDX_ENGINE.read_text()
core_text = SYSTEM_CORE.read_text()
cal_text = CALIBRATION.read_text()
tracker_text = TRACKER.read_text()

required = [
    (server_text, 'from "./etaEvidenceV6.js"', "server is not V6+"),
    (engine_text, "matchedRunsRaw", "tdxEtaEngine is not V6+"),
    (core_text, "TAIWAN_TDX_JURISDICTIONS", "etaSystemCore is missing V5+ jurisdiction core"),
    (cal_text, "eta_actual_observations_v5", "etaCalibrationV5 is missing"),
    (tracker_text, "RiskNavEtaTracker", "etaTripTracker is missing"),
]
for text, marker, message in required:
    if marker not in text:
        raise SystemExit(f"PATCH FAILED: {message}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = {}
for path in TARGETS:
    backup = path.with_name(f"{path.stem}.before-eta-v7-{stamp}{path.suffix}")
    shutil.copy2(path, backup)
    backups[path] = backup
    print(f"Backup: {backup}")


def restore_all():
    for path, backup in backups.items():
        if backup.exists():
            shutil.copy2(backup, path)


def copy_if_needed(src, dst):
    src = Path(src).resolve()
    dst = Path(dst).resolve()
    if src == dst:
        return
    shutil.copy2(src, dst)

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)

try:
    # Generated V5/V6 modules are replaced as whole modules so direction and
    # calibration invariants cannot drift across partial hotfixes.
    copy_if_needed(BUNDLE / "tdxEtaEngine.v7.js", TDX_ENGINE)
    copy_if_needed(BUNDLE / "etaSystemCore.v7.js", SYSTEM_CORE)
    copy_if_needed(BUNDLE / "etaCalibrationV5.v7.js", CALIBRATION)
    copy_if_needed(BUNDLE / "etaTripTracker.v7.js", TRACKER)
    copy_if_needed(BUNDLE / "routeJurisdictionV7.js", ROOT / "routeJurisdictionV7.js")
    copy_if_needed(BUNDLE / "testEtaV7.js", ROOT / "testEtaV7.js")
    copy_if_needed(BUNDLE / "ETA_V7_README.txt", ROOT / "ETA_V7_README.txt")

    s = server_text

    # Import resilient jurisdiction resolver.
    if 'from "./routeJurisdictionV7.js"' not in s:
        anchor = '''import {\n  selectTdxLiveObservation,\n} from "./etaEvidenceV6.js";\n'''
        addition = anchor + '''import {\n  resolveRouteJurisdictions,\n} from "./routeJurisdictionV7.js";\n'''
        s = replace_once(s, anchor, addition, "server jurisdiction import")

    # Actual-trip idempotency + actual departure-time bucketing.
    if "const actualDepartureAt =" not in s:
        old = '''    const saved = recordEtaActualObservation({\n      routeHash: body.routeHash,\n      corridorKey: body.corridorKey,\n      originJurisdiction: body.originJurisdiction,\n      destinationJurisdiction: body.destinationJurisdiction,\n      distanceKm: body.distanceKm,\n      departureTime: body.departureTime,\n      preCalibrationExpectedMin: body.preCalibrationExpectedMin,'''
        new = '''    const actualDepartureAt =\n      body.departedAt && Number.isFinite(Date.parse(body.departedAt))\n        ? new Date(body.departedAt)\n        : null;\n\n    const saved = recordEtaActualObservation({\n      tripId: body.tripId,\n      routeHash: body.routeHash,\n      corridorKey: body.corridorKey,\n      originJurisdiction: body.originJurisdiction,\n      destinationJurisdiction: body.destinationJurisdiction,\n      distanceKm: body.distanceKm,\n      // Completed trips are bucketed by the ACTUAL departure timestamp.\n      // Planned departureTime is used only for manual feedback without a\n      // departedAt timestamp.\n      departureTime: actualDepartureAt ? null : body.departureTime,\n      observedAt: actualDepartureAt || new Date(),\n      preCalibrationExpectedMin: body.preCalibrationExpectedMin,'''
        s = replace_once(s, old, new, "server eta-feedback write")

        old = '''        departureTime: body.departureTime,\n        preCalibrationExpectedMin:\n          saved.preCalibrationExpectedMin,'''
        new = '''        departureTime: actualDepartureAt ? null : body.departureTime,\n        date: actualDepartureAt || new Date(),\n        preCalibrationExpectedMin:\n          saved.preCalibrationExpectedMin,'''
        s = replace_once(s, old, new, "server eta-feedback correction lookup")

    # Replace the old bursty reverse-geocoding block. The boundary marker keeps
    # unrelated routing code untouched.
    if "[route jurisdiction resolution]" not in s:
        pattern = re.compile(
            r"const routeAdministrativeCache\s*=.*?\n\}\n\n\nfunction routePointDistanceKm",
            re.S,
        )
        replacement = '''async function routeCandidateCities(route) {\n  const result = await resolveRouteJurisdictions({\n    route,\n    reverseGeocodeCoordinate,\n    resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,\n    maxSamples: Math.max(4, Math.min(22, Number(process.env.TDX_ROUTE_JURISDICTION_SAMPLES || 12))),\n    concurrency: Math.max(1, Math.min(4, Number(process.env.TDX_ROUTE_REVERSE_CONCURRENCY || 2))),\n    retries: Math.max(0, Math.min(4, Number(process.env.TDX_ROUTE_REVERSE_RETRIES || 2))),\n  });\n\n  route.__jurisdictionDiagnostics = result.diagnostics;\n\n  console.log("[route jurisdiction resolution]", {\n    jurisdictions: result.jurisdictions,\n    diagnostics: result.diagnostics,\n    samples: result.samples.map((item) => ({\n      point: item?.point || null,\n      jurisdiction: item?.jurisdiction || null,\n      source: item?.source || null,\n      city: item?.reverse?.city || null,\n      county: item?.reverse?.county || null,\n      municipality: item?.reverse?.municipality || null,\n      subdivision: item?.reverse?.subdivision || null,\n    })),\n  });\n\n  return result.jurisdictions;\n}\n\n\nfunction routePointDistanceKm'''
        s, n = pattern.subn(replacement, s, count=1)
        if n != 1:
            raise RuntimeError(f"server route-jurisdiction block: expected 1 match, found {n}")

    if '"jurisdiction_unresolved"' not in s:
        s = replace_once(
            s,
            '''    : !routeJurisdictions.length\n      ? "not_applicable"''',
            '''    : !routeJurisdictions.length\n      ? "jurisdiction_unresolved"''',
            "server city evidence state",
        )

    if "jurisdictionResolution: route.__jurisdictionDiagnostics" not in s:
        s = replace_once(
            s,
            '''  corridorKey: etaCorridorKey,\n  routeJurisdictions,\n});''',
            '''  corridorKey: etaCorridorKey,\n  routeJurisdictions,\n  jurisdictionResolution: route.__jurisdictionDiagnostics || null,\n});''',
            "server final audit diagnostics",
        )

    SERVER.write_text(s)

    print("ETA V7 RESILIENCE INSTALLED")
    print("- bounded/retried jurisdiction resolution; null failures are not cached")
    print("- strict direction semantics + smoothed same-road route bearing diagnostics")
    print("- tripId idempotency + actual departure bucketing + tracker resume/outbox")
except Exception as exc:
    restore_all()
    print(f"PATCH FAILED: {exc}", file=sys.stderr)
    raise SystemExit(1)
