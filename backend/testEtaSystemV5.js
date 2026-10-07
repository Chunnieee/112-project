import test from "node:test";
import assert from "node:assert/strict";

import {
  TAIWAN_TDX_JURISDICTIONS,
  canonicalizeTaiwanJurisdiction,
  resolveTaiwanJurisdictionFromReverse,
  parseTdxAcceptedScopes,
  callTdxScopeEndpoint,
  getTdxEndpointCapability,
  resetTdxEndpointCapabilities,
  buildEtaCorridorKey,
} from "./etaSystemCore.js";

import { buildTdxRoadIndex } from "./tdxEtaEngine.js";

test("all 22 Taiwan jurisdictions are represented", () => {
  assert.equal(TAIWAN_TDX_JURISDICTIONS.length, 22);
  assert.equal(new Set(TAIWAN_TDX_JURISDICTIONS).size, 22);
});

test("county identity is preserved instead of stripping County", () => {
  assert.equal(canonicalizeTaiwanJurisdiction("Hsinchu County"), "HsinchuCounty");
  assert.equal(canonicalizeTaiwanJurisdiction("新竹縣"), "HsinchuCounty");
  assert.equal(canonicalizeTaiwanJurisdiction("Hsinchu City"), "Hsinchu");
});

test("reverse resolver prioritizes county over township/locality", () => {
  assert.equal(
    resolveTaiwanJurisdictionFromReverse({
      city: "Guanxi",
      county: "Hsinchu County",
    }),
    "HsinchuCounty"
  );

  assert.equal(
    resolveTaiwanJurisdictionFromReverse({
      city: "Toufen",
      county: "Miaoli County",
    }),
    "MiaoliCounty"
  );
});

test("direct municipality remains a direct municipality", () => {
  assert.equal(
    resolveTaiwanJurisdictionFromReverse({ city: "New Taipei" }),
    "NewTaipei"
  );
  assert.equal(
    resolveTaiwanJurisdictionFromReverse({ city: "Taichung" }),
    "Taichung"
  );
});

test("TDX accepted scope parser learns endpoint capabilities from real error shape", () => {
  const scopes = parseTdxAcceptedScopes({
    status: 400,
    tdxDetail: {
      Message:
        "City: 'Hsinchu' is not accepted but YilanCounty, HsinchuCounty, ChanghuaCounty, Keelung, Taipei, NewTaipei, Taichung, Tainan, Taoyuan",
    },
  });

  assert.ok(scopes.includes("HsinchuCounty"));
  assert.ok(scopes.includes("NewTaipei"));
  assert.ok(!scopes.includes("Hsinchu"));
});

test("endpoint capability cache is endpoint-specific, not global", async () => {
  resetTdxEndpointCapabilities();

  const rejected = await callTdxScopeEndpoint({
    endpointKey: "SectionShape/City",
    scope: "Hsinchu",
    loader: async () => {
      const error = new Error("bad scope");
      error.status = 400;
      error.tdxDetail = {
        Message: "City: 'Hsinchu' is not accepted but HsinchuCounty, Taipei, Taichung",
      };
      throw error;
    },
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.unsupported, true);

  const shapeCapability = getTdxEndpointCapability("SectionShape/City");
  assert.ok(shapeCapability.acceptedScopes.includes("HsinchuCounty"));

  const liveOk = await callTdxScopeEndpoint({
    endpointKey: "Live/City",
    scope: "Hsinchu",
    loader: async () => [{ ok: true }],
  });

  assert.equal(liveOk.ok, true);
});

test("corridor key uses origin, destination, and distance band", () => {
  assert.equal(
    buildEtaCorridorKey({
      jurisdictions: ["NewTaipei", "HsinchuCounty", "Taichung"],
      distanceKm: 148.4,
    }),
    "NewTaipei>Taichung|125-150km"
  );
});

test("freeway/highway road index prefers TravelTime over TravelSpeed when valid", () => {
  const freewayData = [
    {
      SectionID: "TEST",
      TravelTime: 120,
      TravelSpeed: 110,
      DataCollectTime: new Date().toISOString(),
      OpenLRs: [{ OpenLR: "fake" }],
    },
  ];

  const index = buildTdxRoadIndex({
    freewayData,
    highwayData: [],
    openLrToPolyline: () => [
      { lat: 25.0, lng: 121.0 },
      { lat: 25.0, lng: 121.02 },
    ],
    maxAgeMin: 60,
  });

  const segments = [...index.grid.values()].flat();
  assert.ok(segments.length > 0);
  assert.equal(segments[0].observedFrom, "TravelTime");
  assert.equal(segments[0].sectionId, "TEST");
});
