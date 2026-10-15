RiskNav ETA V6 — Evidence Pipeline Refactor
===========================================

Target: an existing ETA V5.1 installation.

What changes, in order
----------------------
1. Historical blind spot
   - Keeps the existing >=8 real same-weekday/time-bucket sample requirement.
   - Does NOT invent historical data on cold start.
   - When history is ready, supplement weighting uses uncovered ROUTER BASELINE TIME
     instead of uncovered distance, which is more appropriate for ramps/urban pieces.

2. Actual-trip calibration
   - Keeps exact-route -> corridor residual learning.
   - Browser tracker now counts trip time from the confirmed origin sample rather than
     180m later.
   - Completed feedback is queued in localStorage on upload failure and retried later.
   - No raw GPS track is uploaded or persisted.

3. Live freshness
   - Stale live observations are rejected before ETA use.
   - Missing/invalid timestamps are rejected by default.
   - Set TDX_REQUIRE_LIVE_TIMESTAMP=0 only for provider diagnostics if necessary.

4. Contiguous-run aggregation
   - ETA positive delay is netted after each contiguous TDX section run is aggregated.
   - Faster micro-pieces can offset slower micro-pieces inside the same run.
   - Prevents piece-level positive clipping bias.

5. Uncovered coverage
   - Does NOT fake 100% coverage and does not widen geometry thresholds blindly.
   - Uncovered pieces keep Valhalla baseline.
   - Historical blind-spot correction + actual-trip residual learning compensate only
     when there is evidence.

6. TravelTime quality
   - Fresh plausible TravelTime remains preferred.
   - 130–145 km/h derived speeds are accepted but downgraded.
   - >145 km/h TravelTime falls back to valid TravelSpeed when available.
   - Fresh very slow speeds remain valid congestion evidence.
   - ETA response exposes high-confidence and fresh-evidence coverage separately.

7. City traffic diagnosis
   - Long routes may resolve up to 12 jurisdictions by default instead of silently
     truncating at 6 (override with TDX_MAX_ROUTE_JURISDICTIONS, max 22).
   - ETA audit distinguishes city provider unavailable vs available-but-unmatched vs
     route dominated by freeway/highway evidence.

Important
---------
Historical and actual-trip calibration are evidence layers. The installer cannot make
real samples appear instantly. A first-time route can still show historicalSamples: 0
and calibrationSamples: 0. That is expected; the system now reports those states
explicitly rather than fabricating corrections.

Expected new logs
-----------------
[TDX road evidence quality]
[TDX city packages] ... evidenceQualityCounts
[eta section audit] ... dataAgeMin/evidenceConfidence/evidenceReason
[eta final audit] ... historicalStatus/highConfidenceTravelTimeCoveragePct/
                      freshEvidenceCoveragePct/cityTrafficEvidenceState

The installer creates timestamped backups before editing server.js,
tdxEtaEngine.js, etaCalibrationV5.js, frontend/etaTripTracker.js, and index.html.
