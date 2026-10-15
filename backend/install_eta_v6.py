from pathlib import Path
from datetime import datetime
import shutil
import re
import subprocess
import sys

backend = Path.cwd()
server_path = backend / "server.js"
engine_path = backend / "tdxEtaEngine.js"
calibration_path = backend / "etaCalibrationV5.js"
frontend = backend.parent / "frontend"
index_path = frontend / "index.html"
tracker_path = frontend / "etaTripTracker.js"

bundle = Path(__file__).resolve().parent
evidence_src = bundle / "etaEvidenceV6.js"
tracker_src = bundle / "etaTripTracker.js"
test_src = bundle / "testEtaV6.js"

required = [
    server_path,
    engine_path,
    calibration_path,
    evidence_src,
    tracker_src,
    test_src,
]
for p in required:
    if not p.exists():
        raise SystemExit(f"FILE NOT FOUND: {p}")

# Guard: V6 is designed for the V5.1 architecture, not old pre-refactor files.
server_original = server_path.read_text(encoding="utf-8")
if "etaSystemCore.js" not in server_original or "corridorKey: etaCorridorKey" not in server_original:
    raise SystemExit(
        "ETA V6 requires the V5.1 system refactor first. "
        "server.js does not contain the expected V5.1 architecture markers."
    )

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = []
for p in [server_path, engine_path, calibration_path, tracker_path, index_path]:
    if not p.exists():
        continue
    backup = p.with_name(f"{p.stem}.before-eta-v6-{stamp}{p.suffix}")
    shutil.copy2(p, backup)
    backups.append((p, backup))
    print("Backup:", backup)


def rollback(message):
    for target, backup in backups:
        try:
            shutil.copy2(backup, target)
        except Exception:
            pass
    raise SystemExit(message)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        rollback(f"PATCH FAILED: {label} expected exactly 1 literal match, found {count}")
    return text.replace(old, new, 1)


def sub_once(text, pattern, replacement, label, flags=re.S):
    rx = re.compile(pattern, flags)
    matches = list(rx.finditer(text))
    if len(matches) != 1:
        rollback(f"PATCH FAILED: {label} expected exactly 1 regex match, found {len(matches)}")
    return rx.sub(replacement, text, count=1)


def node_check(path):
    result = subprocess.run(
        ["node", "--check", str(path)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        rollback(f"SYNTAX FAILED: {path.name}\n{result.stderr}")


# ===========================================================================
# STAGE 1 — Historical blind-spot correction uses uncovered BASELINE TIME,
# not merely uncovered distance. Cold-start still requires real historical days.
# ===========================================================================
cal = calibration_path.read_text(encoding="utf-8")

if 'from "./etaEvidenceV6.js"' not in cal:
    cal = 'import { calculateHistoricalBlindSpotSupplement } from "./etaEvidenceV6.js";\n' + cal

hist_pattern = r'''export function calculateHistoricalGapSupplement\(\{.*?\n\}\n\nexport function recordEtaActualObservation'''
hist_replacement = r'''export function calculateHistoricalGapSupplement(args) {
  return calculateHistoricalBlindSpotSupplement(args);
}

export function recordEtaActualObservation'''
cal = sub_once(cal, hist_pattern, hist_replacement, "historical gap supplement")

# ===========================================================================
# STAGE 2 — Actual-trip collection reliability is implemented by replacing the
# browser tracker at commit time. The backend calibration model remains robust
# exact-route -> corridor; no fabricated samples are created.
# ===========================================================================

# ===========================================================================
# STAGE 3 + 6 — One evidence selector for freshness + TravelTime quality.
# ===========================================================================
s = server_original

if 'from "./etaEvidenceV6.js"' not in s:
    marker = 'from "./etaSystemCore.js";'
    evidence_import = '''\nimport {\n  selectTdxLiveObservation,\n} from "./etaEvidenceV6.js";'''
    if marker not in s:
        rollback("PATCH FAILED: etaSystemCore import marker missing")
    s = s.replace(marker, marker + evidence_import, 1)

# Strict-by-default timestamp validation. Set TDX_REQUIRE_LIVE_TIMESTAMP=0 only
# for diagnostics when a provider demonstrably omits timestamps.
old_fresh = '''function isFreshLive(item, maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20)) {
  const value = item?.DataCollectTime || item?.UpdateTime;
  if (!value) return true;
  const age = liveAgeMin(value);
  if (!Number.isFinite(age)) return true;
  return age >= -2 && age <= maxAgeMin;
}'''
new_fresh = '''function isFreshLive(item, maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20)) {
  const value = item?.DataCollectTime || item?.UpdateTime;
  const requireTimestamp = process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0";
  if (!value) return !requireTimestamp;
  const age = liveAgeMin(value);
  if (!Number.isFinite(age)) return !requireTimestamp;
  return age >= -2 && age <= maxAgeMin;
}'''
s = replace_once(s, old_fresh, new_fresh, "strict city freshness")

city_func_pattern = r'''function buildCityObservedSections\(city, shapeData, sectionLinkData, liveData\) \{.*?\n\}\n\nfunction gridKey'''
city_func_replacement = r'''function buildCityObservedSections(city, shapeData, sectionLinkData, liveData) {
  const shapes = extractSectionShapes(shapeData);
  const sectionLinks = extractSectionLinks(sectionLinkData);
  const allLives = extractLiveTraffics(liveData);
  const lives = allLives.filter((item) => isFreshLive(item));

  const directBySection = new Map();
  const byLink = new Map();

  for (const live of lives) {
    const sectionId = normalizeId(live?.SectionID || live?.SectionUID);
    const linkId = normalizeId(live?.LinkID);
    if (sectionId) directBySection.set(sectionId, live);
    if (linkId) byLink.set(linkId, live);
  }

  const linkIdsBySection = new Map();
  for (const item of sectionLinks) {
    const sectionId = normalizeId(item?.SectionID || item?.SectionUID);
    if (!sectionId) continue;
    const ids = getExplicitLinkIds(item);
    if (ids.length) linkIdsBySection.set(sectionId, ids);
  }

  const observedSections = [];
  const qualityCounts = { high: 0, medium: 0, low: 0, rejected: 0 };

  for (const shape of shapes) {
    const sectionId = normalizeId(shape?.SectionID || shape?.SectionUID);
    if (!sectionId) continue;

    const polylines = parseWktPolylines(shape?.Geometry || shape?.geometry);
    if (!polylines.length) continue;

    const sectionLengthKm = polylines.reduce(
      (sum, line) => sum + polylineLengthKm(line),
      0
    );
    if (!Number.isFinite(sectionLengthKm) || sectionLengthKm <= 0.02) continue;

    let live = directBySection.get(sectionId) || null;
    let source = "SectionID";
    let dataCollectTime = live?.DataCollectTime || live?.UpdateTime || null;
    let travelTimeSec = Number(live?.TravelTime);
    let travelSpeedKmh = Number(live?.TravelSpeed);
    let dataSources = live?.DataSources || null;
    let constituentLiveCount = live ? 1 : 0;

    if (!live) {
      const linkIds = linkIdsBySection.get(sectionId) || [];
      const linkLives = linkIds.map((id) => byLink.get(id)).filter(Boolean);

      if (linkIds.length && linkLives.length === linkIds.length) {
        source = "LinkID aggregate";
        constituentLiveCount = linkLives.length;
        dataCollectTime = latestIsoTime(linkLives);

        const validTimes = linkLives
          .map((item) => Number(item?.TravelTime))
          .filter((value) => Number.isFinite(value) && value > 0);

        const validSpeeds = linkLives
          .map((item) => Number(item?.TravelSpeed))
          .filter((value) => Number.isFinite(value) && value >= 1 && value <= 160);

        travelTimeSec =
          validTimes.length === linkLives.length
            ? validTimes.reduce((sum, value) => sum + value, 0)
            : NaN;

        travelSpeedKmh = validSpeeds.length
          ? validSpeeds.reduce((sum, value) => sum + value, 0) / validSpeeds.length
          : NaN;

        dataSources = linkLives.map((item) => item?.DataSources).filter(Boolean);
      }
    }

    if (!live && source === "SectionID") continue;

    const evidence = selectTdxLiveObservation({
      dataCollectTime,
      travelTimeSec,
      sectionLengthKm,
      travelSpeedKmh,
      maxAgeMin: Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20),
      requireTimestamp: process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0",
    });

    if (!evidence.accepted) {
      qualityCounts.rejected += 1;
      continue;
    }

    qualityCounts[evidence.confidence] =
      (qualityCounts[evidence.confidence] || 0) + 1;

    observedSections.push({
      city,
      sectionId,
      polylines,
      sectionLengthKm,
      observedSpeedKmh: evidence.observedSpeedKmh,
      observedFrom: evidence.observedFrom,
      travelTimeSec: Number.isFinite(travelTimeSec) ? travelTimeSec : null,
      travelSpeedKmh: Number.isFinite(travelSpeedKmh) ? travelSpeedKmh : null,
      congestionLevel: live?.CongestionLevel ?? null,
      congestionLevelID: live?.CongestionLevelID ?? null,
      dataCollectTime,
      dataAgeMin: evidence.dataAgeMin,
      evidenceConfidence: evidence.confidence,
      evidenceReason: evidence.reason,
      evidenceQualityScore: evidence.qualityScore,
      dataSources,
      constituentLiveCount,
      liveSource: source,
    });
  }

  return {
    city,
    observedSections,
    shapeCount: shapes.length,
    rawLiveCount: allLives.length,
    liveCount: lives.length,
    directSectionCount: directBySection.size,
    linkLiveCount: byLink.size,
    evidenceQualityCounts: qualityCounts,
  };
}

function gridKey'''
s = sub_once(s, city_func_pattern, city_func_replacement, "city observed section evidence pipeline")

# Do not silently cap long-route jurisdictions at six.
old_cities = '''    const cities = [
      ...new Set(
        routeCityLists.flat()
      ),
    ].slice(0, 6);'''
new_cities = '''    const maxRouteJurisdictions = Math.max(
      1,
      Math.min(22, Number(process.env.TDX_MAX_ROUTE_JURISDICTIONS || 12))
    );

    const cities = [
      ...new Set(
        routeCityLists.flat()
      ),
    ].slice(0, maxRouteJurisdictions);'''
s = replace_once(s, old_cities, new_cities, "route jurisdiction cap")

old_pkg_log = '''    console.log("[TDX city packages]", cityPackages.map(pkg => ({
      city: pkg.city,
      shapeCount: pkg.shapeCount,
      liveCount: pkg.liveCount,
      usableObservedSectionCount: pkg.observedSections?.length || 0,
    })));'''
new_pkg_log = '''    console.log("[TDX city packages]", cityPackages.map(pkg => ({
      city: pkg.city,
      shapeCount: pkg.shapeCount,
      rawLiveCount: pkg.rawLiveCount ?? pkg.liveCount,
      freshLiveCount: pkg.liveCount,
      usableObservedSectionCount: pkg.observedSections?.length || 0,
      evidenceQualityCounts: pkg.evidenceQualityCounts || null,
    })));'''
s = replace_once(s, old_pkg_log, new_pkg_log, "city package diagnostics")

# ===========================================================================
# Engine: road freshness/quality + contiguous-run aggregation.
# ===========================================================================
e = engine_path.read_text(encoding="utf-8")
if 'from "./etaEvidenceV6.js"' not in e:
    e = 'import { selectTdxLiveObservation } from "./etaEvidenceV6.js";\n\n' + e

road_builder_pattern = r'''export function buildTdxRoadIndex\(\{.*?\}\s*function candidatesNear\('''
road_builder_replacement = r'''export function buildTdxRoadIndex({
  freewayData,
  highwayData,
  openLrToPolyline,
  maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20),
  cellDeg = 0.004,
}) {
  const grid = new Map();
  let segmentCount = 0;
  const evidenceDiagnostics = {
    rawSections: 0,
    acceptedSections: 0,
    high: 0,
    medium: 0,
    low: 0,
    rejected: 0,
    travelTime: 0,
    travelSpeed: 0,
  };

  const rawSections = [
    ...getTrafficList(freewayData),
    ...getTrafficList(highwayData),
  ];
  evidenceDiagnostics.rawSections = rawSections.length;

  for (const section of rawSections) {
    const dataCollectTime =
      section?.DataCollectTime ||
      section?.UpdateTime ||
      null;

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

    const evidence = selectTdxLiveObservation({
      dataCollectTime,
      travelTimeSec,
      sectionLengthKm: decodedLengthKm,
      travelSpeedKmh,
      maxAgeMin,
      requireTimestamp: process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0",
    });

    if (!evidence.accepted) {
      evidenceDiagnostics.rejected += 1;
      continue;
    }

    evidenceDiagnostics.acceptedSections += 1;
    evidenceDiagnostics[evidence.confidence] =
      (evidenceDiagnostics[evidence.confidence] || 0) + 1;
    evidenceDiagnostics[evidence.observedFrom === "TravelTime" ? "travelTime" : "travelSpeed"] += 1;

    for (const pieces of decodedLines) {
      for (const piece of pieces) {
        const segment = {
          a: piece.a,
          b: piece.b,
          bearing: bearingDeg(piece.a, piece.b),
          observedSpeedKmh: evidence.observedSpeedKmh,
          sectionId: section?.SectionID || section?.SectionUID || null,
          sectionName: section?.SectionName || null,
          dataCollectTime,
          dataAgeMin: evidence.dataAgeMin,
          observedFrom: evidence.observedFrom,
          evidenceConfidence: evidence.confidence,
          evidenceReason: evidence.reason,
          evidenceQualityScore: evidence.qualityScore,
          travelTimeSec:
            Number.isFinite(travelTimeSec) && travelTimeSec > 0
              ? travelTimeSec
              : null,
          travelSpeedKmh:
            Number.isFinite(travelSpeedKmh) && travelSpeedKmh > 0
              ? travelSpeedKmh
              : null,
          sectionLengthKm: decodedLengthKm,
          source: "TDX freeway/highway LiveTraffic",
        };

        addSegmentToGrid(grid, cellDeg, segment);
        segmentCount += 1;
      }
    }
  }

  return { grid, cellDeg, segmentCount, evidenceDiagnostics };
}

function candidatesNear('''
e = sub_once(e, road_builder_pattern, road_builder_replacement, "road live evidence pipeline")

# Strict engine freshness helper (kept for any other call sites).
old_engine_fresh = '''function isFresh(
  value,
  maxAgeMin
) {
  const age =
    liveAgeMin(value);

  if (age === null) {
    return true;
  }

  return (
    age >= -2 &&
    age <= maxAgeMin
  );
}'''
new_engine_fresh = '''function isFresh(
  value,
  maxAgeMin
) {
  const age =
    liveAgeMin(value);

  if (age === null) {
    return process.env.TDX_REQUIRE_LIVE_TIMESTAMP === "0";
  }

  return (
    age >= -2 &&
    age <= maxAgeMin
  );
}'''
if old_engine_fresh in e:
    e = e.replace(old_engine_fresh, new_engine_fresh, 1)

# Add contiguous run state after sectionMap declaration.
run_marker = '''  const sectionMap =
    new Map();


  const unmatchedSegmentMap =
    new Map();'''
run_insert = '''  const sectionMap =
    new Map();

  const matchedRunsRaw = [];
  let activeMatchedRun = null;
  let matchedRunSequence = 0;

  const flushMatchedRun = () => {
    if (!activeMatchedRun) return;
    activeMatchedRun.positiveDelaySec = Math.max(
      0,
      activeMatchedRun.observedSec - activeMatchedRun.baselineSec
    );
    matchedRunsRaw.push(activeMatchedRun);
    activeMatchedRun = null;
  };


  const unmatchedSegmentMap =
    new Map();'''
e = replace_once(e, run_marker, run_insert, "contiguous run state")

# Keep the old per-piece variables for compatibility while building; V6
# overwrites them from contiguous runs after the loop.
# Enrich sectionMap current object with evidence metadata.
old_current_meta = '''          dataCollectTime:
            match.dataCollectTime ||
            null,

          matchedDistanceKm:
            0,'''
new_current_meta = '''          dataCollectTime:
            match.dataCollectTime ||
            null,

          dataAgeMin:
            Number.isFinite(Number(match.dataAgeMin))
              ? Number(match.dataAgeMin)
              : null,

          evidenceConfidence:
            match.evidenceConfidence ||
            null,

          evidenceReason:
            match.evidenceReason ||
            null,

          evidenceQualityScore:
            Number.isFinite(Number(match.evidenceQualityScore))
              ? Number(match.evidenceQualityScore)
              : null,

          travelSpeedKmh:
            Number.isFinite(Number(match.travelSpeedKmh))
              ? Number(match.travelSpeedKmh)
              : null,

          matchedDistanceKm:
            0,'''
e = replace_once(e, old_current_meta, new_current_meta, "section evidence metadata")

# Insert run aggregation after section current is updated and before sectionMap.set.
run_aggregation_marker = '''      current.nearestMatchKm =
        Math.min(
          current.nearestMatchKm,
          match.matchDistanceKm
        );


      sectionMap.set(
        key,
        current
      );'''
run_aggregation_replacement = '''      current.nearestMatchKm =
        Math.min(
          current.nearestMatchKm,
          match.matchDistanceKm
        );

      if (!activeMatchedRun || activeMatchedRun.key !== key) {
        flushMatchedRun();
        matchedRunSequence += 1;
        activeMatchedRun = {
          runIndex: matchedRunSequence,
          key,
          source: current.source,
          city: current.city,
          sectionId: current.sectionId,
          sectionName: current.sectionName,
          observedFrom: current.observedFrom,
          observedSpeedKmh: speed,
          dataCollectTime: current.dataCollectTime,
          dataAgeMin: current.dataAgeMin,
          evidenceConfidence: current.evidenceConfidence,
          evidenceReason: current.evidenceReason,
          evidenceQualityScore: current.evidenceQualityScore,
          travelSpeedKmh: current.travelSpeedKmh,
          matchedDistanceKm: 0,
          baselineSec: 0,
          observedSec: 0,
          positiveDelaySec: 0,
          nearestMatchKm: Infinity,
        };
      }

      activeMatchedRun.matchedDistanceKm += segment.km;
      activeMatchedRun.baselineSec += baselineSec;
      activeMatchedRun.observedSec += observedSec;
      activeMatchedRun.nearestMatchKm = Math.min(
        activeMatchedRun.nearestMatchKm,
        match.matchDistanceKm
      );


      sectionMap.set(
        key,
        current
      );'''
e = replace_once(e, run_aggregation_marker, run_aggregation_replacement, "contiguous run aggregation")

# An uncovered piece breaks a contiguous section run.
unmatched_marker = '''    } else {
      /*
        沒有可靠 TDX match：'''
unmatched_replacement = '''    } else {
      flushMatchedRun();
      /*
        沒有可靠 TDX match：'''
e = replace_once(e, unmatched_marker, unmatched_replacement, "flush run on uncovered piece")

# Finalize runs and recompute positive delay at run level before coverage.
coverage_marker = '''  const coverage =
    Math.max('''
coverage_replacement = '''  flushMatchedRun();

  positiveDelaySec = matchedRunsRaw.reduce(
    (sum, run) => sum + Math.max(0, Number(run.positiveDelaySec || 0)),
    0
  );

  positiveDelayAdjustedDistanceKm = matchedRunsRaw.reduce(
    (sum, run) =>
      sum + (Number(run.positiveDelaySec || 0) > 0 ? Number(run.matchedDistanceKm || 0) : 0),
    0
  );

  // Safe ETA: full router baseline + only positive delay after each contiguous
  // TDX section run has been netted internally.
  expectedSec = baseOsrmSec + positiveDelaySec;

  const coverage =
    Math.max('''
e = replace_once(e, coverage_marker, coverage_replacement, "run-level delay recomputation")

# Fix the section-level diagnostic field: do not sum piece-level positive clips.
old_positive_map = '''        positiveDelayMin:
          round(
            item.positiveDelaySec /
              60,
            3
          ),'''
new_positive_map = '''        positiveDelayMin:
          round(
            Math.max(0, item.observedSec - item.baselineSec) /
              60,
            3
          ),'''
e = replace_once(e, old_positive_map, new_positive_map, "section diagnostic positive delay")

# Add matchedRuns before unmatchedSegments.
unmatched_list_marker = '''  const unmatchedSegments =
    ['''
matched_runs_block = '''  const matchedRuns = matchedRunsRaw.map((run) => ({
    ...run,
    observedSpeedKmh: round(run.observedSpeedKmh, 1),
    matchedDistanceKm: round(run.matchedDistanceKm, 3),
    baselineSec: round(run.baselineSec, 2),
    observedSec: round(run.observedSec, 2),
    baselineMin: round(run.baselineSec / 60, 3),
    observedMin: round(run.observedSec / 60, 3),
    positiveDelaySec: round(run.positiveDelaySec, 2),
    positiveDelayMin: round(run.positiveDelaySec / 60, 3),
    nearestMatchKm: round(run.nearestMatchKm, 3),
  }));


  const unmatchedSegments =
    ['''
e = replace_once(e, unmatched_list_marker, matched_runs_block, "matched runs output")

# Return matchedRuns alongside matchedSections.
return_marker = '''    matchedSections,

    unmatchedSegments,'''
return_replacement = '''    matchedSections,

    matchedRuns,

    unmatchedSegments,'''
e = replace_once(e, return_marker, return_replacement, "matched runs return")

# ===========================================================================
# Server uses contiguous runs for ETA and exposes evidence/freshness quality.
# ===========================================================================
old_live_sections = '''      const liveSectionsForEta =
        Array.isArray(
          eta.matchedSections
        )
          ? eta.matchedSections
          : [];'''
new_live_sections = '''      const liveSectionsForEta =
        Array.isArray(eta.matchedRuns) && eta.matchedRuns.length
          ? eta.matchedRuns
          : Array.isArray(eta.matchedSections)
            ? eta.matchedSections
            : [];'''
s = replace_once(s, old_live_sections, new_live_sections, "server uses contiguous runs")

counter_marker = '''      let tdxSpeedOnlyEvidenceKm =
        0;


      for ('''
counter_replacement = '''      let tdxSpeedOnlyEvidenceKm =
        0;

      let tdxHighConfidenceTravelTimeEvidenceKm =
        0;

      let tdxFreshEvidenceKm =
        0;

      let tdxMediumConfidenceEvidenceKm =
        0;


      for ('''
s = replace_once(s, counter_marker, counter_replacement, "evidence quality counters")

# Add evidence counters immediately after TravelTime/Speed coverage accounting.
evidence_counter_marker = '''        } else {
          tdxSpeedOnlyEvidenceKm +=
            distanceKm;
        }


        /*
         * Compare TDX live traffic'''
evidence_counter_replacement = '''        } else {
          tdxSpeedOnlyEvidenceKm +=
            distanceKm;
        }

        if (
          String(section?.observedFrom || "") === "TravelTime" &&
          String(section?.evidenceConfidence || "") === "high"
        ) {
          tdxHighConfidenceTravelTimeEvidenceKm += distanceKm;
        }

        if (String(section?.evidenceConfidence || "") === "medium") {
          tdxMediumConfidenceEvidenceKm += distanceKm;
        }

        const evidenceAgeMin = Number(section?.dataAgeMin);
        if (Number.isFinite(evidenceAgeMin) && evidenceAgeMin >= -2 &&
            evidenceAgeMin <= Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20)) {
          tdxFreshEvidenceKm += distanceKm;
        }


        /*
         * Compare TDX live traffic'''
s = replace_once(s, evidence_counter_marker, evidence_counter_replacement, "evidence counters inside ETA loop")

# Compute uncovered baseline once so Historical can weight the blind spot by time.
uncovered_marker = '''      const uncoveredForAudit =
        Array.isArray(
          eta.unmatchedSegments
        )
          ? eta.unmatchedSegments
          : [];


      console.log('''
uncovered_replacement = '''      const uncoveredForAudit =
        Array.isArray(
          eta.unmatchedSegments
        )
          ? eta.unmatchedSegments
          : [];

      const uncoveredBaselineMin =
        uncoveredForAudit.reduce(
          (sum, item) => sum + Number(item?.baselineMin || 0),
          0
        );


      console.log('''
s = replace_once(s, uncovered_marker, uncovered_replacement, "uncovered baseline metric")

# Avoid recomputing it differently inside the audit.
old_uncovered_sum = '''          uncoveredBaselineMin:
            Number(
              uncoveredForAudit
                .reduce(
                  (sum, item) =>
                    sum +
                    Number(
                      item.baselineMin ||
                      0
                    ),
                  0
                )
                .toFixed(2)
            ),'''
new_uncovered_sum = '''          uncoveredBaselineMin:
            Number(uncoveredBaselineMin.toFixed(2)),

          uncoveredBaselineSharePct:
            baseRouterMin > 0
              ? Number((uncoveredBaselineMin / baseRouterMin * 100).toFixed(1))
              : 0,'''
s = replace_once(s, old_uncovered_sum, new_uncovered_sum, "uncovered audit time share")

# Audit uses applied run-level positive delay and prints freshness/quality.
old_audit_tail = '''            positiveDelayMin:
              Number(
                section?.positiveDelayMin || 0
              ),

            nearestMatchM:
              Number(
                section?.nearestMatchKm || 0
              ) * 1000,'''
new_audit_tail = '''            positiveDelayMin:
              Math.max(
                0,
                Number(section?.observedMin || 0) -
                  Number(section?.baselineMin || 0)
              ),

            dataCollectTime:
              section?.dataCollectTime || null,

            dataAgeMin:
              Number.isFinite(Number(section?.dataAgeMin))
                ? Number(Number(section.dataAgeMin).toFixed(2))
                : null,

            evidenceConfidence:
              section?.evidenceConfidence || null,

            evidenceReason:
              section?.evidenceReason || null,

            nearestMatchM:
              Number(
                section?.nearestMatchKm || 0
              ) * 1000,'''
s = replace_once(s, old_audit_tail, new_audit_tail, "section audit freshness and quality")

# Road evidence diagnostics after index construction.
road_index_marker = '''    const roadIndex =
      buildTdxRoadIndex({
        freewayData:
          freewayLiveTrafficData,

        highwayData:
          highwayLiveTrafficData,

        openLrToPolyline
      });'''
road_index_replacement = '''    const roadIndex =
      buildTdxRoadIndex({
        freewayData:
          freewayLiveTrafficData,

        highwayData:
          highwayLiveTrafficData,

        openLrToPolyline
      });

    console.log(
      "[TDX road evidence quality]",
      roadIndex?.evidenceDiagnostics || null
    );'''
s = replace_once(s, road_index_marker, road_index_replacement, "road evidence diagnostics")

# Historical supplement now receives uncovered baseline time.
hist_call_marker = '''    matchedCoverageRatio: tdxCoverageRatio,
    historicalMedianMin: risk.historicalMedianMin,'''
hist_call_replacement = '''    matchedCoverageRatio: tdxCoverageRatio,
    uncoveredBaselineMin,
    historicalMedianMin: risk.historicalMedianMin,'''
s = replace_once(s, hist_call_marker, hist_call_replacement, "historical uncovered time input")

# Add quality coverage ratios near existing V3 ratios.
ratio_marker = '''const effectiveDelayAdjustedCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxDelayAdjustedDistanceKm / routeDistanceKm)
    : 0;

const uncoveredCoverageRatio ='''
ratio_replacement = '''const effectiveDelayAdjustedCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxDelayAdjustedDistanceKm / routeDistanceKm)
    : 0;

const highConfidenceTravelTimeCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxHighConfidenceTravelTimeEvidenceKm / routeDistanceKm)
    : 0;

const freshEvidenceCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxFreshEvidenceKm / routeDistanceKm)
    : 0;

const mediumConfidenceEvidenceCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxMediumConfidenceEvidenceKm / routeDistanceKm)
    : 0;

const uncoveredCoverageRatio ='''
s = replace_once(s, ratio_marker, ratio_replacement, "quality coverage ratios")

# City evidence state is diagnostic; it never invents traffic.
city_diag_marker = '''const empiricalEtaCalibration =
  getEtaCalibrationCorrection({'''
city_diag_replacement = '''const matchedCityDistanceKmForEvidence =
  liveSectionsForEta
    .filter((section) => Boolean(section?.city))
    .reduce((sum, section) => sum + Number(section?.matchedDistanceKm || 0), 0);

const routeCityPackageDiagnostics =
  routeJurisdictions.map((scope) => {
    const pkg = cityPackages.find((item) => item?.city === scope) || null;
    return {
      scope,
      providerLoaded: Boolean(pkg),
      observedSectionCount: pkg?.observedSections?.length || 0,
      freshLiveCount: pkg?.liveCount || 0,
      rawLiveCount: pkg?.rawLiveCount ?? pkg?.liveCount ?? 0,
      evidenceQualityCounts: pkg?.evidenceQualityCounts || null,
    };
  });

const anyCityProviderLoaded =
  routeCityPackageDiagnostics.some((item) => item.providerLoaded && item.observedSectionCount > 0);

const cityTrafficEvidenceState =
  matchedCityDistanceKmForEvidence > 0
    ? "matched"
    : !routeJurisdictions.length
      ? "not_applicable"
      : !anyCityProviderLoaded
        ? "provider_unavailable_or_no_usable_live_sections"
        : tdxCoverageRatio >= 0.75
          ? "available_but_route_is_road_dominant_or_city_not_nearest_match"
          : "available_but_unmatched_needs_matcher_review";

const empiricalEtaCalibration =
  getEtaCalibrationCorrection({'''
s = replace_once(s, city_diag_marker, city_diag_replacement, "city evidence state")

# Expand final audit.
audit_marker = '''  calibrationScope: empiricalEtaCalibration.scope,
  calibrationSamples: empiricalEtaCalibration.sampleCount,
  corridorKey: etaCorridorKey,
  routeJurisdictions,
});'''
audit_replacement = '''  calibrationScope: empiricalEtaCalibration.scope,
  calibrationSamples: empiricalEtaCalibration.sampleCount,
  historicalStatus: risk.riskStatus,
  historicalSamples: risk.sampleCount,
  historicalReason: historicalGapCorrection.reason,
  highConfidenceTravelTimeCoveragePct: roundNumber(
    highConfidenceTravelTimeCoverageRatio * 100,
    1
  ),
  freshEvidenceCoveragePct: roundNumber(
    freshEvidenceCoverageRatio * 100,
    1
  ),
  mediumConfidenceEvidenceCoveragePct: roundNumber(
    mediumConfidenceEvidenceCoverageRatio * 100,
    1
  ),
  uncoveredBaselineMin: roundNumber(uncoveredBaselineMin, 2),
  uncoveredBaselineSharePct:
    baseRouterMin > 0
      ? roundNumber(uncoveredBaselineMin / baseRouterMin * 100, 1)
      : 0,
  cityTrafficEvidenceState,
  cityMatchedDistanceKm: roundNumber(matchedCityDistanceKmForEvidence, 3),
  cityProviderDiagnostics: routeCityPackageDiagnostics,
  corridorKey: etaCorridorKey,
  routeJurisdictions,
});'''
s = replace_once(s, audit_marker, audit_replacement, "eta final audit V6 diagnostics")

# Expand etaEvidence response without changing public legacy fields.
eta_evidence_marker = '''          effectiveDelayAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          uncoveredCoverageRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          calibrationScope:'''
eta_evidence_replacement = '''          effectiveDelayAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          highConfidenceTravelTimeCoverageRatio:
            roundNumber(highConfidenceTravelTimeCoverageRatio, 4),
          freshEvidenceCoverageRatio:
            roundNumber(freshEvidenceCoverageRatio, 4),
          mediumConfidenceEvidenceCoverageRatio:
            roundNumber(mediumConfidenceEvidenceCoverageRatio, 4),
          uncoveredCoverageRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          uncoveredBaselineMin:
            roundNumber(uncoveredBaselineMin, 3),
          uncoveredBaselineShareRatio:
            baseRouterMin > 0
              ? roundNumber(uncoveredBaselineMin / baseRouterMin, 4)
              : 0,
          historicalStatus:
            risk.riskStatus,
          historicalSamples:
            risk.sampleCount,
          historicalSupplementEligible:
            Boolean(historicalGapCorrection.eligible),
          historicalSupplementReason:
            historicalGapCorrection.reason,
          cityTrafficEvidenceState,
          cityMatchedDistanceKm:
            roundNumber(matchedCityDistanceKmForEvidence, 3),
          cityProviderDiagnostics:
            routeCityPackageDiagnostics,
          calibrationScope:'''
s = replace_once(s, eta_evidence_marker, eta_evidence_replacement, "etaEvidence V6 fields")

# ===========================================================================
# STAGE 5 — uncovered coverage is mitigated by historical time-share + actual
# residual; it is NOT fabricated into 100% coverage.
# (implemented above by uncoveredBaselineMin and the existing calibration layer)
# ===========================================================================

# ===========================================================================
# STAGE 7 — city provider/matcher diagnostics. The route now preserves up to 12
# jurisdictions and explicitly reports provider availability vs no match.
# ===========================================================================

# Commit modules/files after syntax guards.
backend.mkdir(parents=True, exist_ok=True)
frontend.mkdir(parents=True, exist_ok=True)

# Write temp files first for syntax checks.
tmp_server = backend / ".__eta_v6_server_check.js"
tmp_engine = backend / ".__eta_v6_engine_check.js"
tmp_cal = backend / ".__eta_v6_calibration_check.js"
tmp_server.write_text(s, encoding="utf-8")
tmp_engine.write_text(e, encoding="utf-8")
tmp_cal.write_text(cal, encoding="utf-8")
if evidence_src.resolve() != (backend / "etaEvidenceV6.js").resolve():
    shutil.copy2(evidence_src, backend / "etaEvidenceV6.js")

try:
    node_check(tmp_server)
    node_check(tmp_engine)
    node_check(tmp_cal)
    node_check(backend / "etaEvidenceV6.js")
    node_check(tracker_src)
finally:
    tmp_server.unlink(missing_ok=True)
    tmp_engine.unlink(missing_ok=True)
    tmp_cal.unlink(missing_ok=True)

server_path.write_text(s, encoding="utf-8")
engine_path.write_text(e, encoding="utf-8")
calibration_path.write_text(cal, encoding="utf-8")
if tracker_src.resolve() != tracker_path.resolve():
    shutil.copy2(tracker_src, tracker_path)
if test_src.resolve() != (backend / "testEtaV6.js").resolve():
    shutil.copy2(test_src, backend / "testEtaV6.js")

if index_path.exists():
    html = index_path.read_text(encoding="utf-8")
    html = re.sub(r'etaTripTracker\.js\?v=[^"\']+', 'etaTripTracker.js?v=6', html)
    if "etaTripTracker.js" not in html and "</body>" in html:
        html = html.replace("</body>", '  <script src="etaTripTracker.js?v=6"></script>\n</body>', 1)
    index_path.write_text(html, encoding="utf-8")

print("ETA V6 EVIDENCE PIPELINE INSTALLED")
print("Stage 1: Historical blind-spot weighting uses uncovered baseline time")
print("Stage 2: Actual-trip tracker is more reliable and retries completed feedback")
print("Stage 3: Freshness is validated before live evidence enters ETA")
print("Stage 4: Positive delay is aggregated by contiguous section run")
print("Stage 5: Uncovered share is mitigated by evidence, never fake 100% coverage")
print("Stage 6: TravelTime evidence is quality-graded; implausible TT falls back safely")
print("Stage 7: City-provider vs matcher state is explicit, with up to 12 jurisdictions")
