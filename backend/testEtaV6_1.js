import test from "node:test";
import assert from "node:assert/strict";
import { selectTdxLiveObservation } from "./etaEvidenceV6.js";

const nowMs = Date.parse("2026-10-04T18:05:00+08:00");
const fresh = "2026-10-04T18:01:00+08:00";

function select(overrides = {}) {
  return selectTdxLiveObservation({
    dataCollectTime: fresh,
    maxAgeMin: 20,
    nowMs,
    extremeCrawlKmh: 5,
    ...overrides,
  });
}

test("normal fresh 15 km/h TravelTime remains usable", () => {
  const r = select({ sectionLengthKm: 1, travelTimeSec: 240, travelSpeedKmh: null });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelTime");
  assert.equal(r.confidence, "high");
});

test("uncorroborated 1.3 km/h TravelTime without TravelSpeed is excluded", () => {
  const r = select({ sectionLengthKm: 1.3, travelTimeSec: 3600, travelSpeedKmh: null });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "extreme_travel_time_uncorroborated_no_speed");
});

test("extreme TravelTime that conflicts with normal TravelSpeed falls back to TravelSpeed", () => {
  const r = select({ sectionLengthKm: 1.3, travelTimeSec: 3600, travelSpeedKmh: 42 });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelSpeed");
  assert.equal(r.observedSpeedKmh, 42);
  assert.equal(r.reason, "extreme_travel_time_uncorroborated_fallback_to_speed");
});

test("extreme crawl corroborated by TravelSpeed is kept, but only medium confidence", () => {
  const r = select({ sectionLengthKm: 1.3, travelTimeSec: 3600, travelSpeedKmh: 2 });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelTime");
  assert.equal(r.confidence, "medium");
  assert.equal(r.reason, "extreme_crawl_corroborated_by_travel_speed");
});

test("11.5 km/h jam from prior valid example is not filtered", () => {
  const r = select({ sectionLengthKm: 1.581, travelTimeSec: (1.581 / 11.5) * 3600, travelSpeedKmh: null });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelTime");
});

test("very high implausible TravelTime still falls back to TravelSpeed", () => {
  const r = select({ sectionLengthKm: 2, travelTimeSec: (2 / 180) * 3600, travelSpeedKmh: 104 });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelSpeed");
});

test("stale data stays rejected", () => {
  const r = selectTdxLiveObservation({
    dataCollectTime: "2026-10-04T17:00:00+08:00",
    sectionLengthKm: 1,
    travelTimeSec: 60,
    travelSpeedKmh: 60,
    maxAgeMin: 20,
    nowMs,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "stale_live_data");
});
