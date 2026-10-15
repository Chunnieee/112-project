RiskNav ETA V3
==============

What this patch changes
-----------------------
1. Fixes per-section positiveDelayMin aggregation in tdxEtaEngine.js.
2. Separates live-data metrics:
   - matched coverage
   - TravelTime coverage
   - speed-only coverage
   - effective delay-adjusted coverage
   - uncovered coverage
3. Keeps fixed 18 sec/signal as diagnostic only. It is NOT added to ETA.
4. Adds a conservative Historical TDX supplement only for the current live uncovered share.
   Requirements: >= 8 samples and historical average coverage >= 35%.
5. Adds empirical ETA residual calibration from actual completed trips.
   This learns systematic missing time such as signals, queues, turn waits, parking-lot exits, etc.
6. Adds:
   POST /api/eta-feedback
   GET  /api/eta-calibration
7. Final ETA is:
   Valhalla baseline
   + current positive TDX live delay
   + evidence-gated Historical uncovered-gap supplement
   + learned actual-trip residual correction

Install
-------
1. Put these two files in the backend folder:
   - install_eta_v3.py
   - etaCalibration.js

2. Stop the backend (Ctrl+C), then run:

   cd /Users/chunnie/Desktop/tdx-project/backend
   python3 install_eta_v3.py
   node --check server.js
   node --check tdxEtaEngine.js
   node --check etaCalibration.js
   node server.js

The installer creates timestamped backups and rolls back on patch/syntax failure.

Verify
------
Run a route and look for:

  [eta final audit]

Key fields:
  liveExpectedMin
  historicalSupplementMin
  learnedResidualCorrectionMin
  expectedMin
  matchedCoveragePct
  travelTimeCoveragePct
  effectiveDelayAdjustedCoveragePct
  uncoveredCoveragePct

How to teach the model the real trip time
-----------------------------------------
Each route response now contains an etaFeedback object. After a completed trip, POST it with actualMin.

Example:

curl -sS -X POST http://localhost:3000/api/eta-feedback \
  -H 'Content-Type: application/json' \
  -d '{
    "routeHash":"<etaFeedback.routeHash>",
    "city":"<etaFeedback.city>",
    "departureTime":"<etaFeedback.departureTime>",
    "preCalibrationExpectedMin":25.2,
    "actualMin":31.0,
    "matchedCoverageRatio":0.61,
    "travelTimeCoverageRatio":0.44,
    "effectiveAdjustedCoverageRatio":0.28,
    "signalCount":0
  }' | python3 -m json.tool

You may also send departedAt + arrivedAt instead of actualMin.

Calibration behavior
--------------------
- Exact route + weekday + 30-minute bucket can start learning after 1 actual trip, with shrinkage.
- Exact route across times requires at least 3 observations.
- City + weekday + bucket requires at least 8 observations.
- City-wide fallback requires at least 15 observations.
- Robust median + MAD filtering reduces sensitivity to accidental/outlier feedback.
- Corrections are bounded to avoid one bad sample destroying the ETA.

Important
---------
This patch removes structural optimism where evidence exists, but no system can guarantee "real travel time" without actual-trip ground truth. The actual-trip calibration layer is what lets RiskNav learn the residual bias instead of inventing a multiplier.
