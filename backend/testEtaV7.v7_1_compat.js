import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  resolveRouteJurisdictions,
  resetRouteJurisdictionCache,
} from "./routeJurisdictionV7.js";
import {
  resolveTaiwanJurisdictionFromReverse,
  buildEtaCorridorKey,
} from "./etaSystemCore.js";
import {
  buildTdxRoadIndex,
  calculateTdxHybridEta,
} from "./tdxEtaEngine.js";

function fakeRoute(lons) {
  return {
    geometry: {
      coordinates: lons.map((lon) => [lon, 25]),
    },
  };
}

test("jurisdiction resolver retries transient 503s with bounded sequence semantics", async () => {
  resetRouteJurisdictionCache();
  const attempts = new Map();
  const route = fakeRoute([121.0, 121.1, 121.25, 121.35, 121.5]);

  const result = await resolveRouteJurisdictions({
    route,
    maxSamples: 5,
    concurrency: 2,
    retries: 1,
    offlineFallback: false,
    reverseGeocodeCoordinate: async ({ lon }) => {
      const key = lon.toFixed(2);
      const count = (attempts.get(key) || 0) + 1;
      attempts.set(key, count);
      if (count === 1) {
        const error = new Error("Photon reverse HTTP 503");
        error.status = 503;
        throw error;
      }
      return {
        city: lon < 121.2 ? "Taipei" : lon < 121.45 ? "New Taipei" : "Taipei",
      };
    },
    resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
  });

  assert.deepEqual(result.jurisdictions, ["Taipei", "NewTaipei", "Taipei"]);
  assert.equal(result.diagnostics.resolvedCount, 5);
  assert.equal(result.diagnostics.retryResolved, 5);
  assert.equal(result.diagnostics.providerFailureCount, 0);
});

test("failed reverse lookups do not poison the positive cache", async () => {
  resetRouteJurisdictionCache();
  const route = fakeRoute([121.0, 121.1]);

  const first = await resolveRouteJurisdictions({
    route,
    maxSamples: 2,
    retries: 0,
    offlineFallback: false,
    reverseGeocodeCoordinate: async () => {
      const error = new Error("Photon reverse HTTP 503");
      error.status = 503;
      throw error;
    },
    resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
  });
  assert.deepEqual(first.jurisdictions, []);

  const second = await resolveRouteJurisdictions({
    route,
    maxSamples: 2,
    retries: 0,
    offlineFallback: false,
    reverseGeocodeCoordinate: async () => ({ city: "Taipei" }),
    resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
  });
  assert.deepEqual(second.jurisdictions, ["Taipei"]);
});

test("unknown jurisdiction does not create a shared Unknown corridor", () => {
  assert.equal(buildEtaCorridorKey({ jurisdictions: [], distanceKm: 74.6 }), null);
});

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

test("direction matching uses a same-road smoothed bearing instead of one noisy vertex", () => {
  const coords = [
    [121.0, 25.0],
    [121.0035, 25.0],
    [121.0036, 25.00035],
    [121.007, 25.0],
  ];
  const distanceKm = coords.slice(1).reduce((sum, point, i) => sum + haversineKm(coords[i], point), 0);

  const roadIndex = buildTdxRoadIndex({
    freewayData: [
      {
        SectionID: "SMOOTH-TEST",
        TravelTime: 60,
        TravelSpeed: 50,
        DataCollectTime: new Date().toISOString(),
        OpenLRs: [{ OpenLR: "fake" }],
      },
    ],
    highwayData: [],
    openLrToPolyline: () => [
      { lat: 25.0, lng: 121.0 },
      { lat: 25.0, lng: 121.007 },
    ],
    maxAgeMin: 60,
  });

  const emptyIndex = { grid: new Map(), cellDeg: 0.004, segmentCount: 0 };
  const eta = calculateTdxHybridEta({
    route: {
      duration: 70,
      distance: distanceKm * 1000,
      geometry: { coordinates: coords },
      legs: [
        {
          steps: [
            {
              duration: 70,
              name: "1",
              geometry: { coordinates: coords },
            },
          ],
        },
      ],
    },
    cityIndex: emptyIndex,
    roadIndex,
    vdIndex: emptyIndex,
    roadMatchThresholdKm: 0.06,
    maxDirectionDiffDeg: 35,
  });

  assert.ok(eta.tdxCoverageRatio > 0.9, `coverage was ${eta.tdxCoverageRatio}`);
  assert.equal(eta.matchingPolicy.routeBearingMode, "same-road smoothed corridor bearing");
  assert.equal(eta.matchingPolicy.reverseGeometryAutoAccepted, false);
});

test("actual-trip feedback is idempotent by tripId", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risknav-v7-"));
  const dbPath = path.join(dir, "eta.sqlite");
  process.env.ETA_CALIBRATION_DB_PATH = dbPath;

  let mod;
  try {
    mod = await import(`./etaCalibrationV5.js?v7test=${Date.now()}`);
  } catch (error) {
    delete process.env.ETA_CALIBRATION_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
    if (String(error?.message || "").includes("better-sqlite3")) {
      t.skip("better-sqlite3 is not installed in this isolated test container");
      return;
    }
    throw error;
  }

  const tripId = `trip-${Date.now()}`;
  const input = {
    tripId,
    routeHash: "route-v7-test",
    corridorKey: "Taipei>NewTaipei|10-15km",
    originJurisdiction: "Taipei",
    destinationJurisdiction: "NewTaipei",
    distanceKm: 12,
    preCalibrationExpectedMin: 30,
    actualMin: 34,
    observedAt: new Date("2026-10-04T08:00:00+08:00"),
  };

  const first = mod.recordEtaActualObservation(input);
  const second = mod.recordEtaActualObservation(input);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.id, second.id);
  assert.equal(second.tripId, tripId);

  delete process.env.ETA_CALIBRATION_DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});
