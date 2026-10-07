import test from "node:test";
import assert from "node:assert/strict";
import { selectTdxLiveObservation } from "./etaEvidenceV6.js";

const nowMs = Date.parse("2026-10-04T18:21:00+08:00");
const fresh = "2026-10-04T18:19:34+08:00";

function run(overrides = {}) {
  return selectTdxLiveObservation({
    dataCollectTime: fresh,
    maxAgeMin: 20,
    nowMs,
    ...overrides,
  });
}

test("default extreme threshold is actually 5 km/h, not 1 km/h", () => {
  const r = run({ sectionLengthKm: 1.321, travelTimeSec: (1.321 / 1.3) * 3600, travelSpeedKmh: 0 });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "extreme_travel_time_uncorroborated_no_speed");
  assert.equal(r.extremeCrawlThresholdKmh, 5);
});

test("null optional threshold does not coerce to zero", () => {
  const r = selectTdxLiveObservation({
    dataCollectTime: fresh,
    maxAgeMin: 20,
    nowMs,
    extremeCrawlKmh: null,
    sectionLengthKm: 1,
    travelTimeSec: 1800, // 2 km/h
    travelSpeedKmh: null,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "extreme_travel_time_uncorroborated_no_speed");
});

test("blank env/config style value is treated as missing", () => {
  const r = selectTdxLiveObservation({
    dataCollectTime: fresh,
    maxAgeMin: 20,
    nowMs,
    extremeCrawlKmh: "",
    sectionLengthKm: 1,
    travelTimeSec: 1200, // 3 km/h
    travelSpeedKmh: 0,
  });
  assert.equal(r.accepted, false);
});

test("normal 11.5 km/h congestion remains accepted", () => {
  const r = run({
    sectionLengthKm: 1.581,
    travelTimeSec: (1.581 / 11.5) * 3600,
    travelSpeedKmh: 0,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelTime");
});

test("extreme TravelTime with normal independent speed falls back", () => {
  const r = run({
    sectionLengthKm: 1.321,
    travelTimeSec: (1.321 / 1.3) * 3600,
    travelSpeedKmh: 42,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelSpeed");
  assert.equal(r.observedSpeedKmh, 42);
});

test("extreme TravelTime corroborated by extreme published speed is retained as medium", () => {
  const r = run({
    sectionLengthKm: 1.321,
    travelTimeSec: (1.321 / 1.3) * 3600,
    travelSpeedKmh: 2,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.observedFrom, "TravelTime");
  assert.equal(r.confidence, "medium");
});
