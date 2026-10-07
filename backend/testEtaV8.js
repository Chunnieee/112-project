import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTdxRoadIndex,
  calculateTdxHybridEta,
  __testCanonicalRoadGeometry,
  ETA_ENGINE_V8_CANONICAL_SECTION_GEOMETRY,
} from "./tdxEtaEngine.js";

const now = new Date().toISOString();

function routeForLine(coords, duration = 120) {
  return {
    duration,
    distance: 1110,
    geometry: { type: "LineString", coordinates: coords },
    legs: [{
      steps: [{
        duration,
        name: "1",
        geometry: { type: "LineString", coordinates: coords },
      }],
    }],
  };
}

function live(sectionId = "S1", speed = 30) {
  return [{
    SectionID: sectionId,
    TravelSpeed: speed,
    DataCollectTime: now,
    OpenLRs: [{ OpenLR: "synthetic" }],
  }];
}

test("V8 marker exists", () => {
  assert.equal(ETA_ENGINE_V8_CANONICAL_SECTION_GEOMETRY, true);
});

test("canonical SectionShape is preferred over conflicting OpenLR geometry", () => {
  const roadIndex = buildTdxRoadIndex({
    freewayData: live("S1", 30),
    highwayData: [],
    freewaySectionShapeData: {
      SectionShapes: [{ SectionID: "S1", LineString: "LINESTRING (121 25, 121 25.01)" }],
    },
    freewaySectionData: {
      Sections: [{ SectionID: "S1", RoadName: "1", RoadDirection: "N" }],
    },
    openLrToPolyline: () => [[120.99, 25.005], [121.01, 25.005]],
  });

  assert.equal(roadIndex.geometryDiagnostics.liveSectionsUsingCanonicalShape, 1);
  assert.equal(roadIndex.geometryDiagnostics.liveSectionsUsingOpenLrFallback, 0);

  const eta = calculateTdxHybridEta({
    route: routeForLine([[121, 25], [121, 25.01]]),
    cityIndex: null,
    roadIndex,
    vdIndex: null,
    roadMatchThresholdKm: 0.06,
    maxDirectionDiffDeg: 35,
  });

  assert.ok(eta.tdxCoverageRatio > 0.95, JSON.stringify(eta));
  assert.equal(eta.matchedSections[0].geometrySource, "SectionShape");
  assert.equal(eta.matchedSections[0].scope, "freeway");
});

test("OpenLR remains a fallback when canonical SectionShape is unavailable", () => {
  const roadIndex = buildTdxRoadIndex({
    freewayData: live("S2", 35),
    highwayData: [],
    openLrToPolyline: () => [[121, 25], [121, 25.01]],
  });
  assert.equal(roadIndex.geometryDiagnostics.liveSectionsUsingCanonicalShape, 0);
  assert.equal(roadIndex.geometryDiagnostics.liveSectionsUsingOpenLrFallback, 1);
  const eta = calculateTdxHybridEta({
    route: routeForLine([[121, 25], [121, 25.01]]),
    cityIndex: null,
    roadIndex,
    vdIndex: null,
  });
  assert.ok(eta.tdxCoverageRatio > 0.95);
  assert.equal(eta.matchedSections[0].geometrySource, "OpenLR");
});

test("RoadDirection can orient a reversed static SectionShape", () => {
  const canonical = __testCanonicalRoadGeometry({
    highwayShapeData: {
      SectionShapes: [{ SectionID: "H1", LineString: "LINESTRING (121 25.01, 121 25)" }],
    },
    highwaySectionData: {
      Sections: [{ SectionID: "H1", RoadDirection: "N", RoadName: "台1線" }],
    },
  });
  const item = canonical.highway.bySectionId.get("H1");
  assert.ok(item);
  assert.ok(item.lines[0][0].lat < item.lines[0].at(-1).lat);
  assert.equal(item.roadDirection, "N");
});

test("scope-specific static geometry keeps duplicate SectionIDs isolated", () => {
  const roadIndex = buildTdxRoadIndex({
    freewayData: live("DUP", 50),
    highwayData: live("DUP", 45),
    freewaySectionShapeData: {
      SectionShapes: [{ SectionID: "DUP", LineString: "LINESTRING (121 25, 121.01 25)" }],
    },
    highwaySectionShapeData: {
      SectionShapes: [{ SectionID: "DUP", LineString: "LINESTRING (121 25, 121 25.01)" }],
    },
    openLrToPolyline: () => [],
  });
  const scopes = new Set();
  for (const list of roadIndex.grid.values()) {
    for (const segment of list) scopes.add(segment.scope);
  }
  assert.ok(scopes.has("freeway"));
  assert.ok(scopes.has("highway"));
});

test("MULTILINESTRING static geometry is parsed", () => {
  const canonical = __testCanonicalRoadGeometry({
    freewayShapeData: {
      SectionShapes: [{
        SectionID: "M1",
        LineString: "MULTILINESTRING ((121 25,121 25.001),(121 25.001,121 25.002))",
      }],
    },
  });
  assert.equal(canonical.freeway.bySectionId.get("M1").lines.length, 2);
});

import { classifyUncoveredCandidateV7_2 } from "./tdxEtaEngine.js";

test("V7.2 uncovered classification survives V8", () => {
  assert.equal(
    classifyUncoveredCandidateV7_2({
      candidate: { distanceKm: 0.0009, directionClass: "oblique_wrong_direction" },
      thresholdKm: 0.06,
    }),
    "crossing_or_adjacent_road"
  );
  assert.equal(
    classifyUncoveredCandidateV7_2({
      candidate: { distanceKm: 0.024, directionClass: "reverse_axis_aligned" },
      thresholdKm: 0.06,
    }),
    "opposite_direction"
  );
});
