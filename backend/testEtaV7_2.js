import test from "node:test";
import assert from "node:assert/strict";

import {
  callTdxScopeEndpoint,
  getTdxEndpointCapability,
  resetTdxEndpointCapabilities,
} from "./etaSystemCore.js";
import { classifyUncoveredCandidateV7_2 } from "./tdxEtaEngine.js";

function rejectedScopeError(message) {
  const error = new Error(message);
  error.status = 400;
  error.tdxDetail = { Message: message };
  return error;
}

test("accepted-scope hint never globally excludes an untested jurisdiction", async () => {
  resetTdxEndpointCapabilities();
  let firstCalls = 0;
  let secondCalls = 0;

  const a = await callTdxScopeEndpoint({
    endpointKey: "Live/City",
    scope: "NewTaipei",
    loader: async () => {
      firstCalls += 1;
      throw rejectedScopeError(
        "City: 'NewTaipei' is not accepted but Taipei, Taichung, Taoyuan"
      );
    },
  });
  assert.equal(a.ok, false);
  assert.equal(firstCalls, 1);

  const b = await callTdxScopeEndpoint({
    endpointKey: "Live/City",
    scope: "HsinchuCounty",
    loader: async () => {
      secondCalls += 1;
      return { LiveTraffics: [] };
    },
  });

  assert.equal(b.ok, true);
  assert.equal(secondCalls, 1);
});

test("only the exact rejected endpoint+scope is negatively cached", async () => {
  resetTdxEndpointCapabilities();
  let calls = 0;

  const loader = async () => {
    calls += 1;
    throw rejectedScopeError(
      "City: 'NewTaipei' is not accepted but Taipei, Taoyuan"
    );
  };

  await callTdxScopeEndpoint({ endpointKey: "Live/City", scope: "NewTaipei", loader });
  const second = await callTdxScopeEndpoint({ endpointKey: "Live/City", scope: "NewTaipei", loader });

  assert.equal(calls, 1);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "scope temporarily rejected by this endpoint");
  assert.ok(second.retryAfter);

  const capability = getTdxEndpointCapability("Live/City");
  assert.deepEqual(capability.unsupportedScopes, ["NewTaipei"]);
  assert.ok(capability.acceptedScopeHints.includes("Taipei"));
});

test("negative capability is isolated per endpoint", async () => {
  resetTdxEndpointCapabilities();
  await callTdxScopeEndpoint({
    endpointKey: "Live/City",
    scope: "NewTaipei",
    loader: async () => {
      throw rejectedScopeError("City: 'NewTaipei' is not accepted but Taipei");
    },
  });

  let shapeCalls = 0;
  const shape = await callTdxScopeEndpoint({
    endpointKey: "SectionShape/City",
    scope: "NewTaipei",
    loader: async () => {
      shapeCalls += 1;
      return [];
    },
  });
  assert.equal(shape.ok, true);
  assert.equal(shapeCalls, 1);
});

test("crossing candidate is classified, not treated as direction threshold evidence", () => {
  const cls = classifyUncoveredCandidateV7_2({
    candidate: {
      distanceKm: 0.0009,
      directionClass: "oblique_wrong_direction",
    },
    thresholdKm: 0.06,
  });
  assert.equal(cls, "crossing_or_adjacent_road");
});

test("reverse-axis candidate remains opposite direction", () => {
  const cls = classifyUncoveredCandidateV7_2({
    candidate: {
      distanceKm: 0.02,
      directionClass: "reverse_axis_aligned",
    },
    thresholdKm: 0.06,
  });
  assert.equal(cls, "opposite_direction");
});

test("aligned candidate outside threshold is diagnosed separately", () => {
  const cls = classifyUncoveredCandidateV7_2({
    candidate: {
      distanceKm: 0.0613,
      directionClass: "aligned",
    },
    thresholdKm: 0.06,
  });
  assert.equal(cls, "aligned_but_too_far");
});
