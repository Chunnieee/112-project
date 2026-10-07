import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveTaiwanJurisdictionOffline,
  resetOfflineJurisdictionCache,
  __test as offlineTest,
} from "./taiwanJurisdictionOfflineV7_1.js";
import {
  resolveRouteJurisdictions,
  resetRouteJurisdictionCache,
} from "./routeJurisdictionV7.js";
import {
  resolveTaiwanJurisdictionFromReverse,
  canonicalizeTaiwanJurisdiction,
} from "./etaSystemCore.js";
import {
  __testSmoothTdxSectionBearings,
} from "./tdxEtaEngine.js";

function writeSyntheticGeoJson(file) {
  const features = [];
  // Two meaningful features used by tests.
  features.push({
    type: "Feature",
    properties: { COUNTYNAME: "臺北市" },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [121.0, 25.0], [121.8, 25.0], [121.8, 25.8], [121.0, 25.8], [121.0, 25.0],
      ]],
    },
  });
  features.push({
    type: "Feature",
    properties: { COUNTYNAME: "桃園縣" },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [120.0, 24.0], [120.8, 24.0], [120.8, 24.8], [120.0, 24.8], [120.0, 24.0],
      ]],
    },
  });
  // Loader intentionally requires >=20 features, mirroring the real 22-county
  // dataset. Put harmless synthetic counties far from Taiwan test points.
  for (let i = 0; i < 20; i += 1) {
    features.push({
      type: "Feature",
      properties: { COUNTYNAME: i % 2 ? "花蓮縣" : "臺東縣" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [130 + i, 30], [130.2 + i, 30], [130.2 + i, 30.2], [130 + i, 30.2], [130 + i, 30],
        ]],
      },
    });
  }
  fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));
}

function withSyntheticGeoJson() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risknav-v71-"));
  const file = path.join(dir, "counties.geojson");
  writeSyntheticGeoJson(file);
  process.env.TAIWAN_ADMIN_GEOJSON = file;
  resetOfflineJurisdictionCache();
  resetRouteJurisdictionCache();
  return { dir, file };
}

function cleanupSynthetic(dir) {
  delete process.env.TAIWAN_ADMIN_GEOJSON;
  resetOfflineJurisdictionCache();
  resetRouteJurisdictionCache();
  fs.rmSync(dir, { recursive: true, force: true });
}

test("offline point-in-polygon resolves a Taiwan jurisdiction", () => {
  const { dir } = withSyntheticGeoJson();
  try {
    const result = resolveTaiwanJurisdictionOffline({ lat: 25.2, lon: 121.2 });
    assert.equal(result?.jurisdiction, "Taipei");
  } finally {
    cleanupSynthetic(dir);
  }
});

test("legacy county names canonicalize to current scopes", () => {
  assert.equal(canonicalizeTaiwanJurisdiction("桃園縣"), "Taoyuan");
  assert.equal(canonicalizeTaiwanJurisdiction("臺北縣"), "NewTaipei");
  assert.equal(canonicalizeTaiwanJurisdiction("高雄縣"), "Kaohsiung");
});

test("offline compiler recognizes legacy county property values", () => {
  const compiled = offlineTest.compileGeoJson({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { COUNTYNAME: "桃園縣" },
      geometry: {
        type: "Polygon",
        coordinates: [[[120,24],[121,24],[121,25],[120,25],[120,24]]],
      },
    }],
  });
  assert.equal(compiled[0]?.jurisdiction, "Taoyuan");
});

test("provider outage falls back to offline boundary instead of Unknown", async () => {
  const { dir } = withSyntheticGeoJson();
  try {
    const route = {
      geometry: {
        coordinates: [
          [121.1, 25.1],
          [121.2, 25.2],
          [121.3, 25.3],
          [121.4, 25.4],
        ],
      },
    };
    const result = await resolveRouteJurisdictions({
      route,
      maxSamples: 4,
      concurrency: 2,
      retries: 0,
      reverseGeocodeCoordinate: async () => {
        const error = new Error("Photon reverse HTTP 503");
        error.status = 503;
        throw error;
      },
      resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
    });
    assert.deepEqual(result.jurisdictions, ["Taipei"]);
    assert.equal(result.diagnostics.resolvedCount, 4);
    assert.ok(result.diagnostics.offlineResolved >= 4);
    assert.equal(result.diagnostics.status, "complete");
  } finally {
    cleanupSynthetic(dir);
  }
});

test("provider circuit breaker prevents every sample from hammering a dead reverse provider", async () => {
  const { dir } = withSyntheticGeoJson();
  let calls = 0;
  try {
    const route = {
      geometry: {
        coordinates: Array.from({ length: 12 }, (_, i) => [121.05 + i * 0.02, 25.05 + i * 0.02]),
      },
    };
    const result = await resolveRouteJurisdictions({
      route,
      maxSamples: 12,
      concurrency: 2,
      retries: 0,
      reverseGeocodeCoordinate: async () => {
        calls += 1;
        const error = new Error("Photon reverse HTTP 503");
        error.status = 503;
        throw error;
      },
      resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
    });
    assert.deepEqual(result.jurisdictions, ["Taipei"]);
    assert.ok(calls <= 4, `dead provider was called ${calls} times`);
    assert.ok(result.diagnostics.circuitSkippedProvider > 0);
  } finally {
    cleanupSynthetic(dir);
  }
});

test("TDX side bearing smoothing removes a single noisy micro-segment tangent", () => {
  const pieces = [
    { a: { lat: 25.0, lon: 121.0 }, b: { lat: 25.0, lon: 121.0005 }, km: 0.05 },
    { a: { lat: 25.0, lon: 121.0005 }, b: { lat: 25.0001, lon: 121.00051 }, km: 0.011 },
    { a: { lat: 25.0001, lon: 121.00051 }, b: { lat: 25.0001, lon: 121.0011 }, km: 0.06 },
  ];
  const result = __testSmoothTdxSectionBearings(pieces);
  assert.ok(result[1].matchBearing > 55 && result[1].matchBearing < 115, String(result[1].matchBearing));
  assert.ok(result[1].matchBearingWindowKm >= 0.1);
});

test("TDX bearing smoothing preserves reverse direction semantics", () => {
  const pieces = [
    { a: { lat: 25.0, lon: 121.0011 }, b: { lat: 25.0, lon: 121.0006 }, km: 0.05 },
    { a: { lat: 25.0, lon: 121.0006 }, b: { lat: 25.0, lon: 121.0 }, km: 0.06 },
  ];
  const result = __testSmoothTdxSectionBearings(pieces);
  assert.ok(result[0].matchBearing > 240 && result[0].matchBearing < 300, String(result[0].matchBearing));
});
