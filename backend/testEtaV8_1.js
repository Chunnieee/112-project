import test from "node:test";
import assert from "node:assert/strict";
import { loadCityPackagesResilient } from "./cityCoverageV8_1.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pkg(city) { return { city, observedSections: [{ sectionId: city }] }; }

const buildPackage = (city) => pkg(city);

test("one rejected city does not discard successful cities", async () => {
  const result = await loadCityPackagesResilient({
    cities: ["Taipei", "NewTaipei", "Taoyuan"],
    getShape: async (city) => ({ city }),
    getLink: async (city) => ({ city }),
    getLive: async (city) => {
      if (city === "NewTaipei") throw new Error("HTTP 400 unsupported");
      return { city };
    },
    buildPackage,
    perScopeTimeoutMs: 100,
    logger: { log() {} },
  });
  assert.deepEqual(result.packages.map((x) => x.city).sort(), ["Taipei", "Taoyuan"]);
});

test("one slow city times out without blocking successful city", async () => {
  const result = await loadCityPackagesResilient({
    cities: ["Taipei", "HsinchuCounty"],
    getShape: async (city) => ({ city }),
    getLink: async (city) => ({ city }),
    getLive: async (city) => {
      if (city === "HsinchuCounty") { await sleep(120); return { city }; }
      return { city };
    },
    buildPackage,
    perScopeTimeoutMs: 30,
    logger: { log() {} },
  });
  assert.deepEqual(result.packages.map((x) => x.city), ["Taipei"]);
  assert.equal(result.diagnostics.find((x) => x.city === "HsinchuCounty")?.timeout, true);
});

test("SectionLink remains optional", async () => {
  const result = await loadCityPackagesResilient({
    cities: ["Taipei"],
    getShape: async () => ({}),
    getLink: async () => { throw new Error("no link endpoint"); },
    getLive: async () => ({}),
    buildPackage,
    perScopeTimeoutMs: 100,
    logger: { log() {} },
  });
  assert.equal(result.packages.length, 1);
  assert.equal(result.diagnostics[0].reason, "ok_without_optional_section_link");
});

test("duplicate jurisdictions are loaded once", async () => {
  let liveCalls = 0;
  const result = await loadCityPackagesResilient({
    cities: ["Taipei", "Taipei", "Taoyuan"],
    getShape: async () => ({}),
    getLink: async () => ({}),
    getLive: async () => { liveCalls += 1; return {}; },
    buildPackage,
    perScopeTimeoutMs: 100,
    logger: { log() {} },
  });
  assert.equal(liveCalls, 2);
  assert.equal(result.packages.length, 2);
});
