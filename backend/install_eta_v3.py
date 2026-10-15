#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil
import re
import subprocess
import sys

ROOT = Path.cwd()
SERVER = ROOT / "server.js"
ENGINE = ROOT / "tdxEtaEngine.js"
CAL = ROOT / "etaCalibration.js"
SOURCE_CAL = Path(__file__).with_name("etaCalibration.js")
MARKER = "ETA_EVIDENCE_FUSION_V3"


def fail(msg):
    raise SystemExit(msg)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        fail(f"PATCH FAILED {label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def node_check(path):
    result = subprocess.run(
        ["node", "--check", str(path)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"node --check failed for {path}:\n{result.stderr}"
        )


if not SERVER.exists():
    fail(f"Missing {SERVER}")
if not ENGINE.exists():
    fail(f"Missing {ENGINE}")
if not SOURCE_CAL.exists():
    fail(f"Missing installer companion file: {SOURCE_CAL}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = {}
for p in [SERVER, ENGINE]:
    backup = p.with_name(f"{p.name}.before-eta-v3-{stamp}")
    shutil.copy2(p, backup)
    backups[p] = backup
    print("Backup:", backup)

if CAL.exists() and CAL.resolve() != SOURCE_CAL.resolve():
    cal_backup = CAL.with_name(f"{CAL.name}.before-eta-v3-{stamp}")
    shutil.copy2(CAL, cal_backup)
    backups[CAL] = cal_backup
    print("Backup:", cal_backup)

try:
    engine = ENGINE.read_text(encoding="utf-8")

    if "positiveDelaySec:\n            0," not in engine:
        engine = replace_once(
            engine,
            """          observedSec:
            0,

          nearestMatchKm:
            Infinity
        };""",
            """          observedSec:
            0,

          positiveDelaySec:
            0,

          nearestMatchKm:
            Infinity
        };""",
            "engine section accumulator init",
        )

    if "current.positiveDelaySec +=" not in engine:
        engine = replace_once(
            engine,
            """      current.observedSec +=
        observedSec;


      current.nearestMatchKm =""",
            """      current.observedSec +=
        observedSec;

      current.positiveDelaySec +=
        segmentPositiveDelaySec;


      current.nearestMatchKm =""",
            "engine positive delay accumulation",
        )

    server = SERVER.read_text(encoding="utf-8")

    if MARKER not in server:
        import_anchor = 'import { countSignalsAlongRoute } from "./signalDelayCorrection.js";\n'
        import_new = """import { countSignalsAlongRoute } from "./signalDelayCorrection.js";
import {
  calculateHistoricalGapSupplement,
  getEtaCalibrationCorrection,
  getEtaCalibrationSummary,
  recordEtaActualObservation,
} from "./etaCalibration.js";
"""
        server = replace_once(
            server,
            import_anchor,
            import_new,
            "calibration import",
        )

        server = replace_once(
            server,
            """      const expectedMin =
        baseRouterMin +
        (
          tdxPositiveDelaySec /
          60
        );""",
            """      const liveExpectedMin =
        baseRouterMin +
        (
          tdxPositiveDelaySec /
          60
        );

      /* ETA_EVIDENCE_FUSION_V3
       * expectedMin is finalized only after Historical evidence and
       * actual-trip residual calibration are available.
       */
      let expectedMin =
        liveExpectedMin;""",
            "live expected ETA",
        )

        server = replace_once(
            server,
            """          tdxDataCoveragePct:
            Number(
              (
                tdxCoverageRatio *
                100
              ).toFixed(1)
            ),

          tdxTravelTimeEvidenceKm:""",
            """          tdxDataCoveragePct:
            Number(
              (
                tdxCoverageRatio *
                100
              ).toFixed(1)
            ),

          tdxTravelTimeCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxTravelTimeEvidenceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          tdxSpeedOnlyCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxSpeedOnlyEvidenceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          effectiveDelayAdjustedCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxDelayAdjustedDistanceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          uncoveredCoveragePct:
            Number(
              (
                (1 - tdxCoverageRatio) *
                100
              ).toFixed(1)
            ),

          tdxTravelTimeEvidenceKm:""",
            "coverage diagnostics",
        )

        server = replace_once(
            server,
            """          expectedMin:
            Number(
              expectedMin
                .toFixed(2)
            ),
             signalCorrection,""",
            """          liveExpectedMin:
            Number(
              liveExpectedMin
                .toFixed(2)
            ),

          signalCorrection:
            {
              ...signalCorrection,
              appliedToEta: false,
              reason:
                signalCorrection?.cacheAvailable
                  ? "diagnostic-only until calibrated by actual-trip residuals"
                  : signalCorrection?.reason ||
                    "signal cache unavailable",
            },""",
            "preliminary ETA audit",
        )

        risk_pattern = re.compile(
            r'''console\.log\(\s*"\[route response risk\]",[\s\S]*?\n\);\n\ntry \{\n  routeHash =\n    createRouteHash\(route\);''',
            re.M,
        )
        match = risk_pattern.search(server)
        if not match:
            fail("PATCH FAILED: could not locate route response risk block")

        matched_text = match.group(0)
        try_pos = matched_text.rfind('try {\n  routeHash =')
        if try_pos < 0:
            fail("PATCH FAILED: route hash continuation not found")
        risk_log = matched_text[:try_pos]
        continuation = matched_text[try_pos:]

        fusion = r'''/*
 * ETA_EVIDENCE_FUSION_V3
 * 1) current live TDX positive delay
 * 2) Historical TDX supplement only on current uncovered share
 * 3) robust residual learned from actual completed trips
 */
const tdxTravelTimeCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxTravelTimeEvidenceKm / routeDistanceKm)
    : 0;

const tdxSpeedOnlyCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxSpeedOnlyEvidenceKm / routeDistanceKm)
    : 0;

const effectiveDelayAdjustedCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxDelayAdjustedDistanceKm / routeDistanceKm)
    : 0;

const uncoveredCoverageRatio =
  Math.max(0, 1 - tdxCoverageRatio);

const historicalGapCorrection =
  calculateHistoricalGapSupplement({
    baseRouterMin,
    liveExpectedMin,
    matchedCoverageRatio: tdxCoverageRatio,
    historicalMedianMin: risk.historicalMedianMin,
    historicalCoverageRatio:
      risk.historicalAverageTdxCoverageRatio,
    historicalSampleCount: risk.sampleCount,
  });

const preCalibrationExpectedMin =
  Math.max(
    baseRouterMin,
    liveExpectedMin +
      Number(historicalGapCorrection.supplementMin || 0)
  );

const empiricalEtaCalibration =
  getEtaCalibrationCorrection({
    routeHash,
    city: cities?.[0] || null,
    departureTime: requestedDepartureTime,
    preCalibrationExpectedMin,
  });

expectedMin =
  Math.max(
    baseRouterMin,
    preCalibrationExpectedMin +
      Number(empiricalEtaCalibration.correctionMin || 0)
  );

console.log("[eta final audit]", {
  route: route.label,
  baseRouterMin: roundNumber(baseRouterMin, 2),
  liveExpectedMin: roundNumber(liveExpectedMin, 2),
  historicalSupplementMin: roundNumber(
    historicalGapCorrection.supplementMin || 0,
    2
  ),
  preCalibrationExpectedMin: roundNumber(
    preCalibrationExpectedMin,
    2
  ),
  learnedResidualCorrectionMin: roundNumber(
    empiricalEtaCalibration.correctionMin || 0,
    2
  ),
  expectedMin: roundNumber(expectedMin, 2),
  matchedCoveragePct: roundNumber(tdxCoverageRatio * 100, 1),
  travelTimeCoveragePct: roundNumber(
    tdxTravelTimeCoverageRatio * 100,
    1
  ),
  effectiveDelayAdjustedCoveragePct: roundNumber(
    effectiveDelayAdjustedCoverageRatio * 100,
    1
  ),
  uncoveredCoveragePct: roundNumber(
    uncoveredCoverageRatio * 100,
    1
  ),
  calibrationScope: empiricalEtaCalibration.scope,
  calibrationSamples: empiricalEtaCalibration.sampleCount,
});

'''

        server = (
            server[:match.start()]
            + risk_log
            + fusion
            + continuation
            + server[match.end():]
        )

        server = replace_once(
            server,
            """        expectedMin:
          roundNumber(
            expectedMin,
            1
          ),

        delayMin:""",
            """        expectedMin:
          roundNumber(
            expectedMin,
            1
          ),

        liveExpectedMin:
          roundNumber(
            liveExpectedMin,
            2
          ),

        preCalibrationExpectedMin:
          roundNumber(
            preCalibrationExpectedMin,
            2
          ),

        historicalGapSupplementMin:
          roundNumber(
            historicalGapCorrection.supplementMin || 0,
            2
          ),

        learnedResidualCorrectionMin:
          roundNumber(
            empiricalEtaCalibration.correctionMin || 0,
            2
          ),

        etaCalibration:
          empiricalEtaCalibration,

        delayMin:""",
            "response ETA fields",
        )

        server = replace_once(
            server,
            """        combinedLiveCoverageRatio:
          roundNumber(
            tdxCoverageRatio,
            3
          ),

        matchedDistanceKm:""",
            """        combinedLiveCoverageRatio:
          roundNumber(
            tdxCoverageRatio,
            3
          ),

        liveCoverage: {
          matchedRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          speedOnlyRatio:
            roundNumber(tdxSpeedOnlyCoverageRatio, 4),
          effectiveDelayAdjustedRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          uncoveredRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          historicalAverageRatio:
            Number.isFinite(
              Number(risk.historicalAverageTdxCoverageRatio)
            )
              ? roundNumber(
                  Number(risk.historicalAverageTdxCoverageRatio),
                  4
                )
              : null,
        },

        matchedDistanceKm:""",
            "response coverage fields",
        )

        server = replace_once(
            server,
            """        historyPending:
          risk.riskStatus !==
            "ready" &&
          matchedSectionsForRisk.length >
            0,


        // -----------------------------""",
            """        historyPending:
          risk.riskStatus !==
            "ready" &&
          matchedSectionsForRisk.length >
            0,

        etaFeedback: {
          routeHash,
          city: cities?.[0] || null,
          departureTime: requestedDepartureTime,
          preCalibrationExpectedMin:
            roundNumber(preCalibrationExpectedMin, 2),
          matchedCoverageRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeCoverageRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          effectiveAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          signalCount:
            Number(signalCorrection?.signalCount || 0),
        },


        // -----------------------------""",
            "feedback metadata",
        )

        server = replace_once(
            server,
            """        etaConfidence:
          confidenceFromCoverage(
            tdxCoverageRatio
          ),""",
            """        etaConfidence:
          confidenceFromCoverage(
            tdxCoverageRatio
          ),

        etaCalibrationAvailable:
          empiricalEtaCalibration.available,""",
            "calibration availability",
        )

        if '"目前 TDX live + OSRM uncovered baseline 的 Expected ETA 最短。"' in server:
            server = server.replace(
                '"目前 TDX live + OSRM uncovered baseline 的 Expected ETA 最短。"',
                '"目前以 live TDX + Historical uncovered-gap supplement + actual-trip residual calibration 的 Expected ETA 最短。"',
                1,
            )

        server = replace_once(
            server,
            '        "Expected = TDX-observed time on strictly matched pieces + original OSRM step baseline on uncovered pieces. No peak-hour coefficient, speed clamp, congestion multiplier, incident penalty, or guessed risk coefficient is used."',
            '        "Expected = Valhalla baseline + current positive TDX live delay + evidence-gated Historical supplement for current uncovered share + learned residual from actual completed trips. Signal count remains diagnostic until empirical calibration exists; no fixed global multiplier is applied."',
            "response explanation",
        )

        endpoint_marker = '// Groq + TDX grounded geocoding：AI 只導正文字，不產生座標\n'
        pos = server.find(endpoint_marker)
        if pos < 0:
            fail("PATCH FAILED: ETA feedback endpoint insertion marker not found")

        endpoints = r'''// =========================================================
// ETA ACTUAL-TRIP CALIBRATION
// =========================================================
app.post("/api/eta-feedback", (req, res) => {
  try {
    const body = req.body || {};
    let actualMin = Number(body.actualMin);

    if (
      !Number.isFinite(actualMin) &&
      body.departedAt &&
      body.arrivedAt
    ) {
      const departedMs = Date.parse(body.departedAt);
      const arrivedMs = Date.parse(body.arrivedAt);

      if (
        Number.isFinite(departedMs) &&
        Number.isFinite(arrivedMs) &&
        arrivedMs > departedMs
      ) {
        actualMin = (arrivedMs - departedMs) / 60000;
      }
    }

    const saved = recordEtaActualObservation({
      routeHash: body.routeHash,
      city: body.city,
      departureTime: body.departureTime,
      preCalibrationExpectedMin: body.preCalibrationExpectedMin,
      actualMin,
      matchedCoverageRatio: body.matchedCoverageRatio,
      travelTimeCoverageRatio: body.travelTimeCoverageRatio,
      effectiveAdjustedCoverageRatio:
        body.effectiveAdjustedCoverageRatio,
      signalCount: body.signalCount,
    });

    return res.json({
      status: "ok",
      saved,
      calibration: getEtaCalibrationCorrection({
        routeHash: saved.routeHash,
        city: saved.city,
        departureTime: body.departureTime,
        preCalibrationExpectedMin:
          saved.preCalibrationExpectedMin,
      }),
    });
  } catch (error) {
    return res.status(400).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/eta-calibration", (req, res) => {
  try {
    return res.json({
      status: "ok",
      summary: getEtaCalibrationSummary({
        routeHash: req.query.routeHash || null,
        city: req.query.city || null,
      }),
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

'''
        server = server[:pos] + endpoints + server[pos:]

    # Copy companion calibration module into the current backend.
    if SOURCE_CAL.resolve() != CAL.resolve():
        shutil.copy2(SOURCE_CAL, CAL)

    tmp_server = ROOT / ".server.eta-v3.tmp.js"
    tmp_engine = ROOT / ".tdxEtaEngine.eta-v3.tmp.js"
    tmp_server.write_text(server, encoding="utf-8")
    tmp_engine.write_text(engine, encoding="utf-8")

    node_check(tmp_server)
    node_check(tmp_engine)
    node_check(CAL)

    SERVER.write_text(server, encoding="utf-8")
    ENGINE.write_text(engine, encoding="utf-8")

    tmp_server.unlink(missing_ok=True)
    tmp_engine.unlink(missing_ok=True)

    print("ETA V3 patch installed.")
    print("- TDX section positiveDelayMin aggregation fixed")
    print("- matched / TravelTime / speed-only / effective coverage separated")
    print("- Historical TDX can fill only the current uncovered gap")
    print("- fixed 18 sec/signal remains diagnostic-only")
    print("- actual-trip residual calibration added")
    print("- POST /api/eta-feedback added")
    print("- GET /api/eta-calibration added")

except Exception as exc:
    print("ERROR:", exc, file=sys.stderr)
    for target, backup in backups.items():
        try:
            shutil.copy2(backup, target)
            print("Rolled back:", target, file=sys.stderr)
        except Exception as rollback_exc:
            print("Rollback failed:", target, rollback_exc, file=sys.stderr)
    raise
