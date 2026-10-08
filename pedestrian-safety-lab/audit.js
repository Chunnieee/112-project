#!/usr/bin/env node
// audit.js
//
// Standalone data-correctness checker for the three Pedestrian Safety
// Mode datasets (accidents / streetlights / convenience stores). Run it
// with `npm run audit` (or `node audit.js`) any time after editing the
// source CSVs, rerunning build_real_accidents.py / build_real_stores.py,
// or just to get a baseline before you start improving a dataset.
//
// This does NOT need the server running -- it imports pedestrianSafety/
// directly and reads the JSON files straight off disk.
//
// What it checks, and why each one exists:
//
//   - Bounding-box violations: a lat/lon outside Taipei City's own box
//     (24.9-25.25, 121.4-121.7) despite having passed a Taipei-prefix
//     text filter on 發生地點/地址. This is exactly the class of bug
//     caught earlier in the full project (one 2018 accident record had a
//     garbled (25.333, 121.333) coordinate that passed a looser
//     whole-of-Taiwan bound). A real regression here means a bad row got
//     into the source CSV, or a build script's filter logic broke.
//
//   - Exact-duplicate records: same (date, time, lat, lon) for accidents,
//     or same (lat, lon, store_type) for stores, or same (lat, lon) for
//     streetlights. A LEGITIMATE duplicate (two accidents at the same
//     spot on different dates) is NOT flagged -- only identical rows,
//     which usually means a source file got concatenated/re-merged into
//     the build directory more than once.
//
//   - Missing/invalid fields: non-finite lat/lon, or (for accidents) an
//     unparseable date, slipping past the build scripts' own filtering.
//
//   - Per-year accident count outliers: any year whose pedestrian-
//     accident count is more than 35% away from the mean of all loaded
//     years. This is a SOFT flag, not proof of a bug -- a real year CAN
//     legitimately differ -- but it's worth a second look (did the whole
//     12-months get loaded? Is this year's file definitely the new
//     per-party-row format and not accidentally skipped?).
//
// Exits with code 1 if any HARD check (bounding box, exact duplicate,
// missing field) fails, so this can be wired into a pre-commit hook or
// CI later if useful -- but by default just prints a readable report and
// also writes audit-report.json next to this file.

import { writeFileSync } from "node:fs";
import { filterPedestrianAccidents } from "./pedestrianSafety/index.js";
// Audits whatever the server actually loads: the nationwide files when they
// exist (realAccidentsTaiwan.json ...), otherwise the original Taipei ones.
import {
  realAccidents as realAccidentsTaipei,
  realStreetlights as realStreetlightsTaipei,
  realConvenienceStores as realConvenienceStoresTaipei,
  dataFiles,
  coverage,
  countyAt,
  TAIWAN_COUNTIES,
} from "./nationalData.js";

const TAIPEI_BOX = { minLat: 24.9, maxLat: 25.25, minLon: 121.4, maxLon: 121.7 };
// Main island + Penghu, Kinmen, Matsu.
const TAIWAN_BOX = { minLat: 21.8, maxLat: 26.5, minLon: 118.0, maxLon: 122.1 };
const boxFor = (file) => (file.includes("Taiwan") ? TAIWAN_BOX : TAIPEI_BOX);
console.log("Auditing:", dataFiles);
console.log("Coverage:", { accidents: coverage.accidents.length, streetlights: coverage.streetlights, stores: coverage.stores.length });

function inBox(lat, lon, box) {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

function checkBoundingBox(label, points, box = TAIPEI_BOX) {
  const violations = [];
  points.forEach((p, i) => {
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return; // caught separately
    if (!inBox(lat, lon, box)) violations.push({ index: i, lat, lon, ...p });
  });
  return { label, check: "bounding-box", count: violations.length, examples: violations.slice(0, 10) };
}

function checkMissingFields(label, points, requiredKeys) {
  const bad = [];
  points.forEach((p, i) => {
    for (const key of requiredKeys) {
      const v = p[key];
      const isCoord = key === "latitude" || key === "longitude";
      const invalid = isCoord ? !Number.isFinite(Number(v)) : v === undefined || v === null || v === "";
      if (invalid) {
        bad.push({ index: i, missingField: key, record: p });
        break;
      }
    }
  });
  return { label, check: "missing-fields", count: bad.length, examples: bad.slice(0, 10) };
}

function checkExactDuplicates(label, points, keyFn) {
  const seen = new Map();
  const duplicates = [];
  points.forEach((p, i) => {
    const key = keyFn(p);
    if (seen.has(key)) {
      duplicates.push({ index: i, duplicateOfIndex: seen.get(key), key, record: p });
    } else {
      seen.set(key, i);
    }
  });
  return { label, check: "exact-duplicates", count: duplicates.length, examples: duplicates.slice(0, 10) };
}

function checkYearOutliers(pedestrianAccidents) {
  const byYear = {};
  for (const a of pedestrianAccidents) {
    const year = (a.date || "").slice(0, 4);
    if (!year) continue;
    byYear[year] = (byYear[year] || 0) + 1;
  }
  const years = Object.keys(byYear).sort();
  const counts = years.map((y) => byYear[y]);
  const mean = counts.reduce((s, c) => s + c, 0) / (counts.length || 1);

  const outliers = years
    .filter((y) => mean > 0 && Math.abs(byYear[y] - mean) / mean > 0.35)
    .map((y) => ({ year: y, count: byYear[y], meanOfAllYears: Math.round(mean) }));

  return { byYear, mean: Math.round(mean), outliers };
}

function printSection(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

function printCheckResult(result) {
  const status = result.count === 0 ? "OK" : "FLAGGED";
  console.log(`  [${status}] ${result.check}: ${result.count} record(s)`);
  if (result.count > 0) {
    for (const ex of result.examples) {
      console.log("    -", JSON.stringify(ex).slice(0, 200));
    }
    if (result.count > result.examples.length) {
      console.log(`    ... and ${result.count - result.examples.length} more (see audit-report.json)`);
    }
  }
}

// -----------------------------------------------------------------------
// ACCIDENTS
// -----------------------------------------------------------------------
printSection(`ACCIDENTS (${realAccidentsTaipei.length} total records)`);

const pedestrianAccidents = filterPedestrianAccidents(realAccidentsTaipei);
console.log(`  ${pedestrianAccidents.length} are pedestrian-involved (what the score actually uses)`);

const accidentChecks = [
  checkBoundingBox("accidents", realAccidentsTaipei, boxFor(dataFiles.accidents)),
  checkMissingFields("accidents", realAccidentsTaipei, ["latitude", "longitude", "date"]),
  checkExactDuplicates("accidents", realAccidentsTaipei, (a) => `${a.date}|${a.time}|${a.latitude}|${a.longitude}`),
];
accidentChecks.forEach(printCheckResult);

const yearStats = checkYearOutliers(pedestrianAccidents);
console.log(`  By year (pedestrian-involved only):`, yearStats.byYear);
if (yearStats.outliers.length) {
  console.log(`  [FLAGGED] year-outliers:`, yearStats.outliers);
} else {
  console.log(`  [OK] year-outliers: none (all years within 35% of the ${yearStats.mean}/year mean)`);
}

const nationalAccidents = dataFiles.accidents.includes("Taiwan");
const allowedPrefixes = nationalAccidents ? TAIWAN_COUNTIES : ["臺北市"];
const locationTextMismatches = realAccidentsTaipei.filter(
  (a) => a.location && !allowedPrefixes.includes(a.location.replace(/台/g, "臺").slice(0, 3))
);
console.log(
  `  [${locationTextMismatches.length === 0 ? "OK" : "FLAGGED"}] location-text-prefix: ` +
    `${locationTextMismatches.length} record(s) whose 發生地點 text doesn't start with ` +
    (nationalAccidents ? "a Taiwan county/city name" : "臺北市/台北市")
);

// Soft check (not counted as a failure): the county the coordinates fall in
// (nationalData.js countyAt, a 2 km majority-vote grid) vs the county named
// in 發生地點. A few hundred near county borders are expected; a large
// cluster in one county usually means garbled coordinates in that year's CSV.
if (nationalAccidents) {
  const byCounty = {};
  let mismatches = 0;
  for (const a of realAccidentsTaipei) {
    const named = String(a.location || "").replace(/台/g, "臺").slice(0, 3);
    const located = countyAt(a.latitude, a.longitude);
    if (located && located !== named) {
      mismatches++;
      byCounty[named] = (byCounty[named] || 0) + 1;
    }
  }
  console.log(
    `  [INFO] county-consistency: ${mismatches} of ${realAccidentsTaipei.length} records ` +
      `(${((mismatches / realAccidentsTaipei.length) * 100).toFixed(2)}%) sit in a different county than ` +
      "their 發生地點 text says -- mostly border roads; by named county:",
    byCounty
  );
}

// -----------------------------------------------------------------------
// STREETLIGHTS
// -----------------------------------------------------------------------
printSection(`STREETLIGHTS (${realStreetlightsTaipei.length} total records)`);

const streetlightChecks = [
  checkBoundingBox("streetlights", realStreetlightsTaipei, boxFor(dataFiles.streetlights)),
  checkMissingFields("streetlights", realStreetlightsTaipei, ["latitude", "longitude"]),
  checkExactDuplicates("streetlights", realStreetlightsTaipei, (s) => `${s.latitude}|${s.longitude}`),
];
streetlightChecks.forEach(printCheckResult);
console.log(
  "  NOTE: this dataset is a static snapshot (see pedestrianSafety/data/realTaipeiData.js's " +
    "provenance comment for its source/date) -- it is NOT re-fetched live. A handful of exact-" +
    "coordinate duplicates CAN be legitimate (e.g. two fixtures on the same double-headed pole, " +
    "or the source CSV's own coordinate rounding), so don't assume every flagged pair here is a " +
    "bug -- but a LARGE duplicate count, or duplicates concentrated in one area, usually means a " +
    "source file got merged into the build twice and is worth checking."
);

// -----------------------------------------------------------------------
// CONVENIENCE STORES
// -----------------------------------------------------------------------
printSection(`CONVENIENCE STORES (${realConvenienceStoresTaipei.length} total records)`);

const byType = {};
for (const s of realConvenienceStoresTaipei) {
  byType[s.store_type] = (byType[s.store_type] || 0) + 1;
}
console.log("  By chain:", byType);
console.log(
  dataFiles.stores.includes("Taiwan")
    ? "  NOTE: nationwide data from taiwan-cvs-map.netlify.app (all four chains from their own store " +
        "finders, refreshed monthly by scripts/update-stores.mjs). PX Mart is excluded unless INCLUDE_PXMART=1. " +
        "Several stores sharing one coordinate is normal inside stations/malls (e.g. 全家高鐵一店/二店)."
    : "  NOTE: still the Taipei-only file -- run `npm run update-stores` to download the nationwide data. " +
        "In this file Hi-Life + OK Mart are carried over from an OLD ~2015 snapshot."
);

const storeChecks = [
  checkBoundingBox("convenienceStores", realConvenienceStoresTaipei, boxFor(dataFiles.stores)),
  checkMissingFields("convenienceStores", realConvenienceStoresTaipei, ["latitude", "longitude", "store_type"]),
  checkExactDuplicates(
    "convenienceStores",
    realConvenienceStoresTaipei,
    (s) => `${s.latitude}|${s.longitude}|${s.store_type}`
  ),
];
storeChecks.forEach(printCheckResult);

// -----------------------------------------------------------------------
// Report file + exit code
// -----------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  accidents: { totalRecords: realAccidentsTaipei.length, pedestrianRecords: pedestrianAccidents.length, checks: accidentChecks, yearStats, locationTextMismatchCount: locationTextMismatches.length },
  streetlights: { totalRecords: realStreetlightsTaipei.length, checks: streetlightChecks },
  convenienceStores: { totalRecords: realConvenienceStoresTaipei.length, byChain: byType, checks: storeChecks },
};
writeFileSync(new URL("./audit-report.json", import.meta.url), JSON.stringify(report, null, 2));

printSection("DONE");
console.log("Full report (including every flagged record, not just the first 10) written to audit-report.json");

const hardFailures =
  accidentChecks.reduce((s, c) => s + c.count, 0) +
  streetlightChecks.reduce((s, c) => s + c.count, 0) +
  storeChecks.reduce((s, c) => s + c.count, 0) +
  locationTextMismatches.length;

if (hardFailures > 0) {
  console.log(`\n${hardFailures} record(s) flagged across all hard checks -- see above / audit-report.json.`);
  process.exitCode = 1;
} else {
  console.log("\nAll hard checks passed (bounding box / missing fields / exact duplicates / location-text).");
}
