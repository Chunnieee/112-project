from pathlib import Path
from datetime import datetime
import shutil
import re
import subprocess

backend = Path.cwd()
server_path = backend / "server.js"
engine_path = backend / "tdxEtaEngine.js"
frontend = backend.parent / "frontend"
index_path = frontend / "index.html"

bundle = Path(__file__).resolve().parent
core_src = bundle / "etaSystemCore.js"
cal_src = bundle / "etaCalibrationV5.js"
tracker_src = bundle / "etaTripTracker.js"
test_src = bundle / "testEtaSystemV5.js"

for p in [server_path, engine_path, core_src, cal_src, tracker_src, test_src]:
    if not p.exists():
        raise SystemExit(f"FILE NOT FOUND: {p}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = []

for p in [server_path, engine_path]:
    backup = p.with_name(f"{p.stem}.before-eta-v5-1-{stamp}{p.suffix}")
    shutil.copy2(p, backup)
    backups.append((p, backup))
    print("Backup:", backup)

if index_path.exists():
    backup = index_path.with_name(f"{index_path.stem}.before-eta-v5-1-{stamp}{index_path.suffix}")
    shutil.copy2(index_path, backup)
    backups.append((index_path, backup))
    print("Backup:", backup)


def rollback(message):
    for target, backup in backups:
        try:
            shutil.copy2(backup, target)
        except Exception:
            pass
    raise SystemExit(message)


def sub_once(text, pattern, replacement, label, flags=re.S):
    rx = re.compile(pattern, flags)
    matches = list(rx.finditer(text))
    if len(matches) != 1:
        rollback(
            f"PATCH FAILED: {label} expected exactly 1 match, found {len(matches)}"
        )
    return rx.sub(replacement, text, count=1)


def node_check_text(text, suffix, label):
    temp = backend / f".__eta_v5_1_check_{label}{suffix}"
    temp.write_text(text, encoding="utf-8")
    try:
        result = subprocess.run(
            ["node", "--check", str(temp)],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            rollback(
                f"PATCH FAILED: {label} syntax check failed:\n{result.stderr}"
            )
    finally:
        temp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# server.js
# ---------------------------------------------------------------------------
s = server_path.read_text(encoding="utf-8")

# Replace V3 calibration module import with V5.1 module.
if 'from "./etaCalibrationV5.js"' not in s:
    s, count = re.subn(
        r'from\s+["\']\.\/etaCalibration\.js["\'];',
        'from "./etaCalibrationV5.js";',
        s,
        count=1,
    )
    if count != 1:
        rollback("PATCH FAILED: etaCalibration.js import not found")

# Insert the all-Taiwan architecture import once.
if 'from "./etaSystemCore.js"' not in s:
    marker = 'from "./etaCalibrationV5.js";'
    if marker not in s:
        rollback("PATCH FAILED: etaCalibrationV5 import marker missing")
    core_import = '''\nimport {\n  TAIWAN_TDX_JURISDICTIONS,\n  canonicalizeTaiwanJurisdiction,\n  resolveTaiwanJurisdictionFromReverse,\n  loadTdxCityTrafficBundle,\n  buildEtaCorridorKey,\n} from "./etaSystemCore.js";'''
    s = s.replace(marker, marker + core_import, 1)

# Replace the old lossy City/County suffix stripping with one canonical resolver.
if "function normalizeTdxCityName(" in s:
    start = s.find("function normalizeTdxCityName(")
    end = s.find("async function routeCandidateCities(", start)
    if start < 0 or end < 0 or end <= start:
        rollback("PATCH FAILED: jurisdiction resolver boundaries not found")
    resolver = '''function normalizeTdxCityName(value) {\n  return canonicalizeTaiwanJurisdiction(value);\n}\n\nfunction tdxCityFromReverse(item) {\n  return resolveTaiwanJurisdictionFromReverse(item);\n}\n\n'''
    s = s[:start] + resolver + s[end:]
elif "canonicalizeTaiwanJurisdiction(value)" not in s:
    rollback("PATCH FAILED: no jurisdiction resolver found")

# Long routes need enough reverse-geocode samples to preserve county transitions.
if not re.search(r'routeCitySamplePoints\(\s*route\s*,\s*12\s*\)', s, re.S):
    s = sub_once(
        s,
        r'routeCitySamplePoints\(\s*route\s*,\s*5\s*\)',
        'routeCitySamplePoints(\n      route,\n      12\n    )',
        "route city sample count",
    )

# Each TDX city endpoint learns support independently. SectionLink is optional.
if "[TDX jurisdiction capability]" not in s:
    city_loader_pattern = (
        r'async function loadCityLivePackages\(cities\)\s*\{.*?\n\}\n\n'
        r'function roundNumber'
    )
    city_loader_replacement = '''async function loadCityLivePackages(cities) {
  if (!cities.length) return [];

  const packages = [];

  for (const city of cities) {
    const result =
      await loadTdxCityTrafficBundle({
        scope: city,
        getShapes: getCitySectionShapes,
        getLinks: getCitySectionLinks,
        getLive: getCityLiveTraffic,
        buildPackage: buildCityObservedSections,
      });

    console.log(
      "[TDX jurisdiction capability]",
      result.diagnostics
    );

    if (result.package) {
      packages.push(result.package);
    }
  }

  return packages;
}

function roundNumber'''
    s = sub_once(
        s,
        city_loader_pattern,
        city_loader_replacement,
        "loadCityLivePackages",
    )

# Environment test override should use the same resolver and not a hardcoded 2-city list.
test_override = re.compile(
    r'''    const testCities = String\(process\.env\.TDX_TEST_CITIES \|\| ""\)\n'''
    r'''      \.split\(","\).*?console\.warn\("\[route city TEST fallback\]", cities\);\n'''
    r'''    \}''',
    re.S,
)
if test_override.search(s):
    s = test_override.sub(
        '''    const testCities = String(process.env.TDX_TEST_CITIES || "")
      .split(",")
      .map((value) => canonicalizeTaiwanJurisdiction(value))
      .filter(Boolean);

    if (!cities.length && testCities.length) {
      cities.push(...new Set(testCities));
      console.warn("[route jurisdiction TEST fallback]", cities);
    }''',
        s,
        count=1,
    )

s = s.replace(
    '"[route cities from coordinates]"',
    '"[route jurisdiction scopes]"',
)

# Replace V3 route/city calibration with exact-route -> corridor calibration.
if "const etaCorridorKey =" not in s:
    calibration_pattern = (
        r'const\s+empiricalEtaCalibration\s*=\s*'
        r'getEtaCalibrationCorrection\(\{.*?\}\);'
    )
    calibration_replacement = '''const routeJurisdictions =
  Array.isArray(routeCityLists?.[index])
    ? routeCityLists[index]
    : [];

const etaOriginJurisdiction =
  routeJurisdictions[0] ||
  null;

const etaDestinationJurisdiction =
  routeJurisdictions[
    routeJurisdictions.length - 1
  ] ||
  etaOriginJurisdiction;

const etaCorridorKey =
  buildEtaCorridorKey({
    jurisdictions:
      routeJurisdictions,
    distanceKm:
      routeDistanceKm,
  });

const empiricalEtaCalibration =
  getEtaCalibrationCorrection({
    routeHash,
    corridorKey:
      etaCorridorKey,
    departureTime:
      requestedDepartureTime,
    preCalibrationExpectedMin,
  });'''
    # Anchor on the declaration so the feedback endpoint lookup isn't touched.
    s = sub_once(
        s,
        calibration_pattern,
        calibration_replacement,
        "ETA calibration call block",
    )

# Add corridor diagnostics to the final audit if absent.
if "routeJurisdictions," not in s[s.find('console.log("[eta final audit]"'):s.find('console.log("[eta final audit]"') + 1800]:
    audit_pattern = (
        r'calibrationScope:\s*empiricalEtaCalibration\.scope,\s*'
        r'calibrationSamples:\s*empiricalEtaCalibration\.sampleCount,'
    )
    audit_replacement = '''calibrationScope: empiricalEtaCalibration.scope,
  calibrationSamples: empiricalEtaCalibration.sampleCount,
  corridorKey: etaCorridorKey,
  routeJurisdictions,'''
    s = sub_once(
        s,
        audit_pattern,
        audit_replacement,
        "eta final audit calibration diagnostics",
    )

# Expand per-route feedback metadata. Handles both compact and multiline V3 formatting.
eta_feedback_window = s.find("etaFeedback: {")
if eta_feedback_window < 0:
    rollback("PATCH FAILED: etaFeedback response block not found")
if "corridorKey:" not in s[eta_feedback_window:eta_feedback_window + 800]:
    feedback_pattern = (
        r'etaFeedback:\s*\{\s*routeHash,\s*'
        r'city:\s*cities\?\.\[0\]\s*\|\|\s*null,\s*'
        r'departureTime:\s*requestedDepartureTime,'
    )
    feedback_replacement = '''etaFeedback: {
          routeHash,
          corridorKey: etaCorridorKey,
          originJurisdiction: etaOriginJurisdiction,
          destinationJurisdiction: etaDestinationJurisdiction,
          jurisdictions: routeJurisdictions,
          distanceKm: roundNumber(routeDistanceKm, 2),
          city: etaOriginJurisdiction,
          departureTime: requestedDepartureTime,'''
    s = sub_once(
        s,
        feedback_pattern,
        feedback_replacement,
        "etaFeedback block",
    )

# Feedback endpoint: store corridor metadata, not city-wide fallback.
record_start = s.find("recordEtaActualObservation({")
if record_start < 0:
    rollback("PATCH FAILED: recordEtaActualObservation endpoint call not found")
record_end = s.find("});", record_start)
record_block = s[record_start:record_end + 3]
if "corridorKey:" not in record_block:
    record_new, n = re.subn(
        r'city:\s*body\.city,\s*departureTime:\s*body\.departureTime,',
        '''corridorKey: body.corridorKey,
      originJurisdiction: body.originJurisdiction,
      destinationJurisdiction: body.destinationJurisdiction,
      distanceKm: body.distanceKm,
      departureTime: body.departureTime,''',
        record_block,
        count=1,
        flags=re.S,
    )
    if n != 1:
        rollback("PATCH FAILED: eta feedback save payload not found")
    s = s[:record_start] + record_new + s[record_end + 3:]

# Calibration lookup returned by POST /api/eta-feedback.
endpoint_lookup_anchor = s.find("calibration: getEtaCalibrationCorrection({")
if endpoint_lookup_anchor < 0:
    rollback("PATCH FAILED: eta feedback calibration lookup not found")
endpoint_lookup_end = s.find("}),", endpoint_lookup_anchor)
lookup_block = s[endpoint_lookup_anchor:endpoint_lookup_end + 3]
if "corridorKey:" not in lookup_block:
    lookup_new, n = re.subn(
        r'city:\s*saved\.city,\s*departureTime:\s*body\.departureTime,',
        '''corridorKey: saved.corridorKey,
        departureTime: body.departureTime,''',
        lookup_block,
        count=1,
        flags=re.S,
    )
    if n != 1:
        rollback("PATCH FAILED: eta feedback correction lookup not found")
    s = s[:endpoint_lookup_anchor] + lookup_new + s[endpoint_lookup_end + 3:]

# GET /api/eta-calibration uses routeHash and/or corridorKey.
summary_anchor = s.find("summary: getEtaCalibrationSummary({")
if summary_anchor < 0:
    rollback("PATCH FAILED: eta calibration summary endpoint not found")
summary_end = s.find("}),", summary_anchor)
summary_block = s[summary_anchor:summary_end + 3]
if "corridorKey:" not in summary_block:
    summary_new, n = re.subn(
        r'city:\s*req\.query\.city\s*\|\|\s*null,',
        'corridorKey: req.query.corridorKey || null,',
        summary_block,
        count=1,
        flags=re.S,
    )
    if n != 1:
        rollback("PATCH FAILED: eta calibration summary query not found")
    s = s[:summary_anchor] + summary_new + s[summary_end + 3:]

# Expose evidence quality clearly in each route.
cal_response_anchor = s.find("etaCalibration:")
if cal_response_anchor < 0:
    rollback("PATCH FAILED: etaCalibration response marker not found")
cal_window = s[cal_response_anchor:cal_response_anchor + 1200]
if "etaEvidence:" not in cal_window:
    cal_marker_pattern = r'etaCalibration:\s*empiricalEtaCalibration,'
    cal_replacement = '''etaCalibration:
          empiricalEtaCalibration,

        etaEvidence: {
          matchedCoverageRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeCoverageRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          speedOnlyCoverageRatio:
            roundNumber(tdxSpeedOnlyCoverageRatio, 4),
          effectiveDelayAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          uncoveredCoverageRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          calibrationScope:
            empiricalEtaCalibration.scope,
          calibrationSamples:
            empiricalEtaCalibration.sampleCount,
          corridorKey:
            etaCorridorKey,
        },'''
    s = sub_once(
        s,
        cal_marker_pattern,
        cal_replacement,
        "etaCalibration response marker",
    )

# ---------------------------------------------------------------------------
# tdxEtaEngine.js — official TravelTime wins over TravelSpeed when usable.
# ---------------------------------------------------------------------------
e = engine_path.read_text(encoding="utf-8")
if "sectionLengthKm: decodedLengthKm" not in e:
    start = e.find("export function buildTdxRoadIndex({")
    end = e.find("function candidatesNear(", start)
    if start < 0 or end < 0:
        rollback("PATCH FAILED: buildTdxRoadIndex boundaries not found")

    new_builder = r'''export function buildTdxRoadIndex({
  freewayData,
  highwayData,
  openLrToPolyline,
  maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20),
  cellDeg = 0.004,
}) {
  const grid = new Map();
  let segmentCount = 0;

  const rawSections = [
    ...getTrafficList(freewayData),
    ...getTrafficList(highwayData),
  ];

  for (const section of rawSections) {
    const dataCollectTime =
      section?.DataCollectTime ||
      section?.UpdateTime ||
      null;

    if (!isFresh(dataCollectTime, maxAgeMin)) continue;

    const openLRs = section?.OpenLRs || section?.openLRs || [];
    if (!Array.isArray(openLRs) || !openLRs.length) continue;

    const decodedLines = [];
    let decodedLengthKm = 0;

    for (const item of openLRs) {
      try {
        const encoded = item?.OpenLR || item?.openLR || item;
        const line = normalizeDecodedPolyline(openLrToPolyline(encoded));
        if (!Array.isArray(line) || line.length < 2) continue;

        const pieces = [];
        for (let i = 1; i < line.length; i += 1) {
          const a = line[i - 1];
          const b = line[i];
          const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
          if (!Number.isFinite(km) || km <= 0.002) continue;
          pieces.push({ a, b, km });
          decodedLengthKm += km;
        }

        if (pieces.length) decodedLines.push(pieces);
      } catch {
        // One OpenLR decode failure must not invalidate other sections.
      }
    }

    if (!decodedLines.length || decodedLengthKm <= 0) continue;

    const travelTimeSec = Number(
      section?.TravelTime ??
      section?.travelTime ??
      section?.TravelTimeSec ??
      section?.travelTimeSec
    );

    const travelSpeedKmh = Number(
      section?.TravelSpeed ??
      section?.travelSpeed ??
      section?.Speed ??
      section?.speed
    );

    let observedSpeedKmh = null;
    let observedFrom = null;

    if (Number.isFinite(travelTimeSec) && travelTimeSec > 0) {
      const speedFromTravelTime = decodedLengthKm / (travelTimeSec / 3600);
      if (speedFromTravelTime >= 1 && speedFromTravelTime <= 160) {
        observedSpeedKmh = speedFromTravelTime;
        observedFrom = "TravelTime";
      }
    }

    if (
      observedSpeedKmh === null &&
      Number.isFinite(travelSpeedKmh) &&
      travelSpeedKmh >= 1 &&
      travelSpeedKmh <= 160
    ) {
      observedSpeedKmh = travelSpeedKmh;
      observedFrom = "TravelSpeed";
    }

    if (!Number.isFinite(observedSpeedKmh) || observedSpeedKmh <= 0) continue;

    for (const pieces of decodedLines) {
      for (const piece of pieces) {
        const segment = {
          a: piece.a,
          b: piece.b,
          bearing: bearingDeg(piece.a, piece.b),
          observedSpeedKmh,
          sectionId: section?.SectionID || section?.SectionUID || null,
          sectionName: section?.SectionName || null,
          dataCollectTime,
          observedFrom,
          travelTimeSec:
            Number.isFinite(travelTimeSec) && travelTimeSec > 0
              ? travelTimeSec
              : null,
          sectionLengthKm: decodedLengthKm,
          source: "TDX freeway/highway LiveTraffic",
        };

        addSegmentToGrid(grid, cellDeg, segment);
        segmentCount += 1;
      }
    }
  }

  return { grid, cellDeg, segmentCount };
}


'''
    e = e[:start] + new_builder + e[end:]

# ---------------------------------------------------------------------------
# frontend — automatic, privacy-preserving actual-trip feedback.
# ---------------------------------------------------------------------------
html = index_path.read_text(encoding="utf-8") if index_path.exists() else None
if html is not None and "etaTripTracker.js" not in html:
    if "</body>" not in html:
        rollback("PATCH FAILED: index.html has no </body>")
    html = html.replace(
        "</body>",
        '  <script src="etaTripTracker.js?v=5.1"></script>\n</body>',
        1,
    )

# Syntax-check patched server/engine before writing them.
node_check_text(s, ".js", "server")
node_check_text(e, ".js", "engine")

# Commit code only after all patch guards passed.
server_path.write_text(s, encoding="utf-8")
engine_path.write_text(e, encoding="utf-8")
frontend.mkdir(parents=True, exist_ok=True)
if html is not None:
    index_path.write_text(html, encoding="utf-8")

def copy_if_needed(src, dst):
    src = src.resolve()
    dst = dst.resolve()
    if src != dst:
        shutil.copy2(src, dst)

copy_if_needed(core_src, backend / "etaSystemCore.js")
copy_if_needed(cal_src, backend / "etaCalibrationV5.js")
copy_if_needed(test_src, backend / "testEtaSystemV5.js")
copy_if_needed(tracker_src, frontend / "etaTripTracker.js")

print("ETA V5.1 SYSTEM REFACTOR INSTALLED")
print("- all-Taiwan jurisdiction resolver")
print("- endpoint-specific TDX jurisdiction capability learning")
print("- TravelTime-first freeway/highway live evidence")
print("- exact-route then corridor actual-trip calibration")
print("- automatic privacy-preserving completed-trip feedback")
