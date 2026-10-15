from pathlib import Path
from datetime import datetime
import shutil
import re
import sys

backend = Path.cwd()
server = backend / "server.js"
eta_engine = backend / "tdxEtaEngine.js"
frontend = backend.parent / "frontend"
index = frontend / "index.html"

bundle = Path(__file__).resolve().parent
core_src = bundle / "etaSystemCore.js"
cal_src = bundle / "etaCalibrationV5.js"
tracker_src = bundle / "etaTripTracker.js"

for p in [server, eta_engine, core_src, cal_src, tracker_src]:
    if not p.exists():
        raise SystemExit(f"FILE NOT FOUND: {p}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = []

for p in [server, eta_engine]:
    backup = p.with_name(f"{p.stem}.before-eta-v5-{stamp}{p.suffix}")
    shutil.copy2(p, backup)
    backups.append((p, backup))
    print("Backup:", backup)

if index.exists():
    backup = index.with_name(f"{index.stem}.before-eta-v5-{stamp}{index.suffix}")
    shutil.copy2(index, backup)
    backups.append((index, backup))
    print("Backup:", backup)


def fail(message):
    for target, backup in backups:
        try:
            shutil.copy2(backup, target)
        except Exception:
            pass
    raise SystemExit(message)


# ---------------------------------------------------------------------------
# Copy new architecture modules.
# ---------------------------------------------------------------------------
def copy_if_needed(src, dst):
    src = src.resolve()
    dst = dst.resolve()
    if src != dst:
        shutil.copy2(src, dst)

copy_if_needed(core_src, backend / "etaSystemCore.js")
copy_if_needed(cal_src, backend / "etaCalibrationV5.js")
frontend.mkdir(parents=True, exist_ok=True)
copy_if_needed(tracker_src, frontend / "etaTripTracker.js")


# ---------------------------------------------------------------------------
# SERVER: imports.
# ---------------------------------------------------------------------------
s = server.read_text(encoding="utf-8")

if 'from "./etaCalibrationV5.js"' not in s:
    s = re.sub(
        r'from\s+["\']\.\/etaCalibration\.js["\'];',
        'from "./etaCalibrationV5.js";',
        s,
        count=1,
    )

if 'from "./etaSystemCore.js"' not in s:
    marker = 'from "./etaCalibrationV5.js";'
    if marker not in s:
        fail("PATCH FAILED: eta calibration import marker missing")

    core_import = '''\nimport {\n  TAIWAN_TDX_JURISDICTIONS,\n  canonicalizeTaiwanJurisdiction,\n  resolveTaiwanJurisdictionFromReverse,\n  loadTdxCityTrafficBundle,\n  buildEtaCorridorKey,\n} from "./etaSystemCore.js";'''

    s = s.replace(marker, marker + core_import, 1)


# ---------------------------------------------------------------------------
# SERVER: replace the old suffix-stripping jurisdiction resolver.
# ---------------------------------------------------------------------------
start = s.find("function normalizeTdxCityName(")
end = s.find("async function routeCandidateCities(")
if start < 0 or end < 0 or end <= start:
    fail("PATCH FAILED: jurisdiction resolver block not found")

new_resolver = '''function normalizeTdxCityName(value) {\n  return canonicalizeTaiwanJurisdiction(value);\n}\n\nfunction tdxCityFromReverse(item) {\n  return resolveTaiwanJurisdictionFromReverse(item);\n}\n\n'''

s = s[:start] + new_resolver + s[end:]

# More route samples so long intercity routes do not collapse to 5 coarse points.
s = s.replace(
    '''routeCitySamplePoints(\n      route,\n      5\n    )''',
    '''routeCitySamplePoints(\n      route,\n      12\n    )''',
    1,
)


# ---------------------------------------------------------------------------
# SERVER: endpoint-aware city traffic loader.
# ---------------------------------------------------------------------------
pattern = re.compile(
    r'async function loadCityLivePackages\(cities\) \{.*?\n\}\n\nfunction roundNumber',
    re.S,
)

replacement = r'''async function loadCityLivePackages(cities) {
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

if not pattern.search(s):
    fail("PATCH FAILED: loadCityLivePackages block not found")
s = pattern.sub(replacement, s, count=1)


# ---------------------------------------------------------------------------
# SERVER: test-city override should use the same all-Taiwan resolver.
# ---------------------------------------------------------------------------
old_test = '''    const testCities = String(process.env.TDX_TEST_CITIES || "")
      .split(",").map(v => v.trim()).filter(Boolean);
    if (testCities.some(v => !["Taipei", "NewTaipei"].includes(v))) {
      throw new Error("TDX_TEST_CITIES only supports Taipei or NewTaipei for this test");
    }
    if (!cities.length && testCities.length) {
      cities.push(...new Set(testCities));
      console.warn("[route city TEST fallback]", cities);
    }'''

new_test = '''    const testCities = String(process.env.TDX_TEST_CITIES || "")
      .split(",")
      .map((value) => canonicalizeTaiwanJurisdiction(value))
      .filter(Boolean);

    if (!cities.length && testCities.length) {
      cities.push(...new Set(testCities));
      console.warn("[route jurisdiction TEST fallback]", cities);
    }'''

if old_test in s:
    s = s.replace(old_test, new_test, 1)

s = s.replace(
    '''    console.log(
      "[route cities from coordinates]",
      cities
    );''',
    '''    console.log(
      "[route jurisdiction scopes]",
      cities
    );''',
    1,
)


# ---------------------------------------------------------------------------
# SERVER: ETA calibration uses route/corridor identity, not start-city fallback.
# ---------------------------------------------------------------------------
needle = '''const empiricalEtaCalibration =
  getEtaCalibrationCorrection({
    routeHash,
    city:
      cities?.[0] ||
      null,
    departureTime:
      requestedDepartureTime,
    preCalibrationExpectedMin,
  });'''

replacement = '''const routeJurisdictions =
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

if needle not in s:
    fail("PATCH FAILED: ETA calibration call block not found")
s = s.replace(needle, replacement, 1)

# Add corridor diagnostics to final audit.
s = s.replace(
    '''    calibrationScope:
      empiricalEtaCalibration.scope,
    calibrationSamples:
      empiricalEtaCalibration.sampleCount,''',
    '''    calibrationScope:
      empiricalEtaCalibration.scope,
    calibrationSamples:
      empiricalEtaCalibration.sampleCount,
    corridorKey:
      etaCorridorKey,
    routeJurisdictions,''',
    1,
)

# Expand feedback payload.
needle = '''        etaFeedback: {
          routeHash,
          city:
            cities?.[0] ||
            null,
          departureTime:
            requestedDepartureTime,'''

replacement = '''        etaFeedback: {
          routeHash,
          corridorKey:
            etaCorridorKey,
          originJurisdiction:
            etaOriginJurisdiction,
          destinationJurisdiction:
            etaDestinationJurisdiction,
          jurisdictions:
            routeJurisdictions,
          distanceKm:
            roundNumber(
              routeDistanceKm,
              2
            ),
          city:
            etaOriginJurisdiction,
          departureTime:
            requestedDepartureTime,'''

if needle not in s:
    fail("PATCH FAILED: etaFeedback block not found")
s = s.replace(needle, replacement, 1)


# ---------------------------------------------------------------------------
# SERVER: feedback endpoint saves/reads corridor metadata.
# ---------------------------------------------------------------------------
s = s.replace(
    '''        city:
          body.city,
        departureTime:
          body.departureTime,''',
    '''        corridorKey:
          body.corridorKey,
        originJurisdiction:
          body.originJurisdiction,
        destinationJurisdiction:
          body.destinationJurisdiction,
        distanceKm:
          body.distanceKm,
        departureTime:
          body.departureTime,''',
    1,
)

s = s.replace(
    '''          city:
            saved.city,
          departureTime:
            body.departureTime,''',
    '''          corridorKey:
            saved.corridorKey,
          departureTime:
            body.departureTime,''',
    1,
)

# Summary endpoint: corridor, not generic city fallback.
s = s.replace(
    '''          city:
            req.query.city ||
            null,''',
    '''          corridorKey:
            req.query.corridorKey ||
            null,''',
    1,
)


# ---------------------------------------------------------------------------
# SERVER: expose evidence quality clearly.
# ---------------------------------------------------------------------------
needle = '''        etaCalibration:
          empiricalEtaCalibration,'''
replacement = '''        etaCalibration:
          empiricalEtaCalibration,

        etaEvidence: {
          matchedCoverageRatio:
            roundNumber(
              tdxCoverageRatio,
              4
            ),
          travelTimeCoverageRatio:
            roundNumber(
              tdxTravelTimeCoverageRatio,
              4
            ),
          speedOnlyCoverageRatio:
            roundNumber(
              tdxSpeedOnlyCoverageRatio,
              4
            ),
          effectiveDelayAdjustedCoverageRatio:
            roundNumber(
              effectiveDelayAdjustedCoverageRatio,
              4
            ),
          uncoveredCoverageRatio:
            roundNumber(
              uncoveredCoverageRatio,
              4
            ),
          calibrationScope:
            empiricalEtaCalibration.scope,
          calibrationSamples:
            empiricalEtaCalibration.sampleCount,
          corridorKey:
            etaCorridorKey,
        },'''

if needle not in s:
    fail("PATCH FAILED: etaCalibration response marker not found")
s = s.replace(needle, replacement, 1)

server.write_text(s, encoding="utf-8")


# ---------------------------------------------------------------------------
# TDX ETA ENGINE: prefer official TravelTime when a section provides it.
# ---------------------------------------------------------------------------
e = eta_engine.read_text(encoding="utf-8")
start = e.find("export function buildTdxRoadIndex({")
end = e.find("function candidatesNear(", start)
if start < 0 or end < 0:
    fail("PATCH FAILED: buildTdxRoadIndex boundaries not found")

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
eta_engine.write_text(e, encoding="utf-8")


# ---------------------------------------------------------------------------
# FRONTEND: install privacy-preserving actual-trip learning as a drop-in file.
# ---------------------------------------------------------------------------
if index.exists():
    html = index.read_text(encoding="utf-8")
    if "etaTripTracker.js" not in html:
        script = '  <script src="etaTripTracker.js?v=5"></script>\n'
        if "</body>" not in html:
            fail("PATCH FAILED: index.html has no </body>")
        html = html.replace("</body>", script + "</body>", 1)
    index.write_text(html, encoding="utf-8")

print("ETA V5 SYSTEM REFACTOR INSTALLED")
print("- all-Taiwan jurisdiction resolver")
print("- endpoint-specific TDX capability learning")
print("- TravelTime-first freeway/highway evidence")
print("- route/corridor actual-trip calibration")
print("- privacy-preserving automatic trip feedback")
