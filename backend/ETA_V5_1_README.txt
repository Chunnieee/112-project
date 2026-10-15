RiskNav ETA V5.1 System Refactor

Why V5.1 exists
- V5 installer failed on a formatting mismatch in the existing V3 calibration block.
- V5.1 uses regex/structural matching for the V3 blocks and was tested against the V3-patched server snapshot.

Architecture changes
1. All-Taiwan jurisdiction canonicalization (22 jurisdictions).
2. Per-endpoint TDX City/County capability learning.
3. TravelTime-first freeway/highway live evidence, TravelSpeed fallback.
4. Exact-route then corridor actual-trip residual calibration.
5. Automatic privacy-preserving completed-trip feedback.
6. No global guessed multiplier and no fixed signal penalty added to ETA.

Install from backend directory:
python3 install_eta_v5_1.py
node --check server.js
node --check tdxEtaEngine.js
node --check etaSystemCore.js
node --check etaCalibrationV5.js
node --check ../frontend/etaTripTracker.js
node --test testEtaSystemV5.js
node --test testGeocodingRegression.js
node server.js
