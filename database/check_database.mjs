// database/check_database.mjs
//
//   npm run db:check            quick check (a few seconds)
//   npm run db:check -- --full  also runs SQLite's full integrity_check (slower)
//
// Confirms that database/pedestrian_safety.db is healthy AND that the app
// really reads it:
//   1. the file opens, has every table, the right schema version, no empty tables
//   2. SQLite integrity + foreign-key checks pass
//   3. record counts match the original files in pedestrianSafety/data
//      (when those files are present)
//   4. the app's own data modules load from the database and can score a route
// Exits with code 1 if anything fails.

import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_SOURCE = "sqlite"; // fail loudly instead of silently using the JSON files
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "pedestrianSafety", "data");
const full = process.argv.includes("--full");

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`  info  ${msg}`);
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));
const fmt = (n) => Number(n).toLocaleString("en-US");

console.log("1. Open + structure");
let dbMod;
try {
  dbMod = await import("../db.js");
} catch (err) {
  fail(err.message.replace(/^\[db\] /, ""));
  console.log("\nRESULT: FAILED -- build the database with: npm run db:build");
  process.exit(1);
}
const { db, dbStatus, dbMetadata } = dbMod;
pass(`opened ${path.relative(ROOT, dbStatus.path)} (${fmt(dbStatus.sizeMB)} MB, built ${dbStatus.builtAt}, schema v${dbStatus.schemaVersion})`);
pass("all tables present, schema version matches, no empty data tables");

console.log(`2. SQLite integrity${full ? " (full)" : " (quick -- use --full for the complete check)"}`);
const integrity = db.prepare(full ? "PRAGMA integrity_check" : "PRAGMA quick_check").pluck().all();
check(integrity.length === 1 && integrity[0] === "ok", `${full ? "integrity_check" : "quick_check"}: ${integrity.slice(0, 3).join("; ")}`);
const fk = db.prepare("PRAGMA foreign_key_check").all();
check(fk.length === 0, `foreign keys: ${fk.length ? `${fmt(fk.length)} broken references` : "all references valid"}`);
const nullCounty = db.prepare("SELECT count(*) FROM accidents WHERE county_id IS NULL").pluck().get();
check(nullCounty === 0, `every accident has a county (${fmt(nullCounty)} without)`);

console.log("3. Counts vs. the original data files");
const q = (sql) => db.prepare(sql).pluck().get();
const counts = {
  accidents: q("SELECT count(*) FROM accidents WHERE duplicate_of_id IS NULL"),
  pedestrian: q("SELECT count(*) FROM accidents WHERE involves_pedestrian = 1"),
  parties: q("SELECT count(*) FROM accident_parties"),
  streetlights: q("SELECT count(*) FROM streetlights"),
  stores: q("SELECT count(*) FROM convenience_stores"),
  roadAlerts: q("SELECT count(*) FROM road_alerts"),
};
const readJson = (name) => {
  const f = path.join(DATA, name);
  if (!existsSync(f)) return null;
  const buf = readFileSync(f);
  return JSON.parse(name.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8"));
};
const compare = (label, dbCount, fileCount, fileName) => {
  if (fileCount == null) info(`${label}: ${fmt(dbCount)} in database (${fileName} not present to compare)`);
  else check(dbCount === fileCount, `${label}: database ${fmt(dbCount)} / ${fileName} ${fmt(fileCount)}`);
};
compare("all accidents", counts.accidents, readJson("accidentsAllTaiwan.meta.json")?.count, "accidentsAllTaiwan.meta.json");
compare("pedestrian accidents", counts.pedestrian, readJson("realAccidentsTaiwan.json")?.length, "realAccidentsTaiwan.json");
const cov = readJson("realStreetlightsCoverage.json");
compare("streetlights", counts.streetlights, cov ? Object.values(cov.countsByCity).reduce((a, b) => a + b, 0) : null, "realStreetlightsCoverage.json");
compare("convenience stores", counts.stores, readJson("realConvenienceStoresTaiwan.json")?.length, "realConvenienceStoresTaiwan.json");
info(`accident parties: ${fmt(counts.parties)}${dbMetadata.accident_parties_included === "false" ? " (built with --skip-parties)" : ""}`);
info(`road alerts: ${fmt(counts.roadAlerts)}`);
for (const r of db.prepare("SELECT dataset, count(*) AS files, sum(rows_rejected) AS rejected FROM source_files GROUP BY dataset").all()) {
  info(`${r.dataset}: ${r.files} source file(s), ${fmt(r.rejected)} rows rejected (see view v_import_report)`);
}

console.log("4. The app reads the database");
const nd = await import("../nationalData.js");
const ai = await import("../accidentIndex.js");
const { analyzePedestrianRouteSafety } = await import("../pedestrianSafety/index.js");
check(nd.dataBackend === "sqlite", `nationalData.js backend: ${nd.dataBackend}`);
check(ai.source === "sqlite", `accidentIndex.js backend: ${ai.source}`);
check(nd.realAccidents.length === counts.pedestrian, `walking accidents loaded: ${fmt(nd.realAccidents.length)}`);
check(nd.realStreetlights.length === counts.streetlights, `streetlights loaded: ${fmt(nd.realStreetlights.length)}`);
check(nd.realConvenienceStores.length === counts.stores, `stores loaded: ${fmt(nd.realConvenienceStores.length)}`);
check(ai.totalCount === counts.accidents, `scooter/car accident index loaded: ${fmt(ai.totalCount)}`);
// Taipei Main Station -> Taipei City Hall, straight line sampled every ~400 m
const route = Array.from({ length: 13 }, (_, k) => ({ lat: 25.0478 + (25.0418 - 25.0478) * (k / 12), lon: 121.517 + (121.5654 - 121.517) * (k / 12) }));
const near = nd.prefilterForRoute(route, 150);
const score = nd.applyCoverage(analyzePedestrianRouteSafety(route, near.accidents, near.streetlights, near.stores, 150), route);
check(
  Number.isFinite(score.finalSafetyScore) && score.pedestrianAccidents > 0 && score.streetlights > 0,
  `sample walking score (台北車站 → 市政府): ${score.finalSafetyScore} ` +
    `(${score.pedestrianAccidents} accidents, ${score.streetlights} streetlights, ${score.convenienceStores} stores nearby)`
);

console.log(failures ? `\nRESULT: FAILED (${failures} problem${failures > 1 ? "s" : ""})` : "\nRESULT: ALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
