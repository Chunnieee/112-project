import test from "node:test";
import assert from "node:assert/strict";

import {
  selectTdxLiveObservation,
  liveAgeMin,
  calculateHistoricalBlindSpotSupplement,
} from "./etaEvidenceV6.js";

const NOW = Date.parse("2026-10-04T17:30:00+08:00");

function isoMinutesAgo(min) {
  return new Date(NOW - min * 60000).toISOString();
}

test("fresh TravelTime is preferred over TravelSpeed", () => {
  const result = selectTdxLiveObservation({
    dataCollectTime: isoMinutesAgo(2),
    travelTimeSec: 600,
    sectionLengthKm: 5,
    travelSpeedKmh: 55,
    maxAgeMin: 20,
    nowMs: NOW,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.observedFrom, "TravelTime");
  assert.equal(Math.round(result.observedSpeedKmh), 30);
  assert.equal(result.confidence, "high");
});

test("stale live data is rejected", () => {
  const result = selectTdxLiveObservation({
    dataCollectTime: isoMinutesAgo(25),
    travelTimeSec: 600,
    sectionLengthKm: 5,
    travelSpeedKmh: 30,
    maxAgeMin: 20,
    nowMs: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "stale_live_data");
});

test("missing timestamp is rejected by default", () => {
  const result = selectTdxLiveObservation({
    dataCollectTime: null,
    travelTimeSec: 600,
    sectionLengthKm: 5,
    travelSpeedKmh: 30,
    nowMs: NOW,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "missing_or_invalid_timestamp");
});

test("very slow fresh TravelTime remains valid congestion evidence", () => {
  const result = selectTdxLiveObservation({
    dataCollectTime: isoMinutesAgo(3),
    travelTimeSec: 1800,
    sectionLengthKm: 5,
    travelSpeedKmh: 11,
    nowMs: NOW,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.observedFrom, "TravelTime");
  assert.ok(result.observedSpeedKmh < 15);
});

test("implausibly fast TravelTime falls back to valid TravelSpeed", () => {
  const result = selectTdxLiveObservation({
    dataCollectTime: isoMinutesAgo(2),
    travelTimeSec: 90,
    sectionLengthKm: 5,
    travelSpeedKmh: 95,
    nowMs: NOW,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.observedFrom, "TravelSpeed");
  assert.equal(result.observedSpeedKmh, 95);
  assert.match(result.reason, /fallback/);
});

test("130-145 km/h TravelTime is accepted but downgraded", () => {
  const speed = 132;
  const result = selectTdxLiveObservation({
    dataCollectTime: isoMinutesAgo(1),
    travelTimeSec: (5 / speed) * 3600,
    sectionLengthKm: 5,
    travelSpeedKmh: 128,
    nowMs: NOW,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.observedFrom, "TravelTime");
  assert.equal(result.confidence, "medium");
});

test("historical supplement waits for enough real samples", () => {
  const result = calculateHistoricalBlindSpotSupplement({
    baseRouterMin: 40,
    liveExpectedMin: 48,
    matchedCoverageRatio: 0.8,
    uncoveredBaselineMin: 10,
    historicalMedianMin: 55,
    historicalCoverageRatio: 0.7,
    historicalSampleCount: 3,
  });
  assert.equal(result.supplementMin, 0);
  assert.equal(result.eligible, false);
});

test("historical blind spot uses uncovered baseline TIME share", () => {
  const result = calculateHistoricalBlindSpotSupplement({
    baseRouterMin: 40,
    liveExpectedMin: 48,
    matchedCoverageRatio: 0.9,
    uncoveredBaselineMin: 12,
    historicalMedianMin: 56,
    historicalCoverageRatio: 0.65,
    historicalSampleCount: 8,
  });
  // historical delay 16 - current live delay 8 = 8 missing;
  // uncovered time share = 12/40 = .3; strength=1 -> 2.4 min.
  assert.equal(result.eligible, true);
  assert.equal(result.supplementMin, 2.4);
  assert.equal(result.uncoveredTimeShare, 0.3);
});

test("liveAgeMin is deterministic with supplied clock", () => {
  assert.equal(Math.round(liveAgeMin(isoMinutesAgo(7), NOW)), 7);
});
