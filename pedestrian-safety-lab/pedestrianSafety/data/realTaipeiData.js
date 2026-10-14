// pedestrianSafety/data/realTaipeiData.js
//
// REAL Taiwan open-data. Ported unchanged from the standalone
// pedestrian-safety-mode prototype where noted; only the JSON loading
// mechanism was changed (plain fs.readFileSync, so this works on any
// Node 18+ without extra ESM/JSON-import flags).
//
// ── realAccidentsTaipei ──────────────────────────────────────────────
// Source: the project's OWN 內政部警政署 (National Police Agency) A1
// (fatal/within 24hr) + A2 (injury) traffic-accident CSVs, covering TWO
// different export schemas Taiwan has published across years (see
// pedestrianSafety/data/build_real_accidents.py's docstring for the full
// column-level detail of each):
//   - 110年度 (2021): one row per accident, 車種 is a single ";"-joined
//     field listing every party.
//   - 111-114年度 (2022-2025): one row per PARTY (an accident with 3
//     people is 3 rows sharing the same date/time/location), pedestrian
//     party identified by 車種子類別名稱=="行人" specifically (not just
//     "人", which also covers passengers/bystanders in this schema).
//     114年度 adds one trailing column vs. 111-113年度 but every field
//     this project reads is at the same index in both, so no extra
//     handling was needed for that year specifically.
// Converted by pedestrianSafety/data/build_real_accidents.py, which
// auto-detects and handles both formats from the same --sql-dir -- rerun
// that script if the sql/ CSVs are ever refreshed with newer years (every
// source file, old- and new-format alike, is optional; the script runs
// fine even if a given year isn't present, it just skips it).
// Filtered to Taipei City (發生地點 starts with 臺北市/台北市) + at least
// one pedestrian party. Dates converted to Gregorian; 經度/緯度 were
// already WGS84 in the source CSVs, but a coordinate is only kept if it
// also falls inside Taipei City's actual lat/lon box (24.9-25.25,
// 121.4-121.7) -- this catches garbled rows (e.g. a coordinate that
// passes a whole-of-Taiwan sanity bound but is nowhere near the district
// its own 發生地點 text said it was in).
//
// SCOPE (changed 2026-09-24 at the project owner's request): this used to
// cover 107-114年度 (2018-2025, 8 years). The owner deleted the
// 107-109年度 (2018-2020) source CSVs from sql/ and asked to scope the
// dataset down to a rolling "近5年" (recent 5 years) window instead --
// 110-114年度 -- so OLD_FORMAT_SOURCE_FILES in build_real_accidents.py
// now only lists 110年度's 3 files. Re-adding 107-109年度's CSVs to
// sql/ later would bring them back in with no code change (see that
// script's comment above the list).
// Result: 9,296 records (108 A1 + 9,188 A2), date range 2021-01-01 to
// 2025-12-31 (5 full ROC years 110-114). Per-year counts: 2021:1909,
// 2022:2070, 2023:1872, 2024:1704, 2025:1741 -- consistent magnitude,
// no anomalies. See scoring.js's accidentDataYearsSpan, which is computed
// from this range at runtime, not hardcoded, so it self-corrects to "5"
// automatically now that the window is narrower (2026 accidents still
// aren't in here -- 民國115年's official A1/A2 export isn't out yet as of
// this writing).
//
// A separate community-maintained mirror (kiang/NPA_TMA, supplied by the
// project owner as NPA_TMA3.csv) DOES cover part of 2026 (115年01月01日
// through 115年07月31日 in the copy checked), but was evaluated and NOT
// used: it has no 經度/緯度 columns at all (only date/location-text/車種),
// so it can't be plotted or buffer-matched without a separate geocoding
// step -- and even setting that aside, 0 of its 2,593 Taipei rows for
// that period carry a 行人 (pedestrian) party, versus ~1,700-2,200/year
// in the official CSVs above; that's not "Taipei got dramatically safer
// in 2026", it's this particular mirror not reliably carrying pedestrian-
// party data for Taipei specifically (it clearly captures 行人 elsewhere:
// 490 pedestrian rows nationwide in the same period, just none of them in
// Taipei). Re-evaluate once Taiwan's own 115年度 A1/A2 export ships.
// `category`/`severity`/`time`/`location` are kept as passthrough
// metadata (not currently used by the scoring math, only
// `latitude`/`longitude`/`date`/`accident_type` are).
//
// Replaces a prior data source that was NOT built from this project's own
// CSVs at all -- it was a community GitHub mirror (kiang/NPA_TMA) covering
// 2025-01-01 to 2026-09-02, a different multi-year window than the CSVs
// actually sitting in sql/. Before that, an even older 2018-only snapshot
// (2,038 records) was used.
//
// ── realStreetlightsTaipei ───────────────────────────────────────────
// Source: TaipeiLight.csv (Taipei City streetlight registry), converted
// from TWD97 TM2 to WGS84. Filtered to the 12 Taipei City districts.
// Result: 145,813 points, covering all of Taipei City (lat 24.96-25.19,
// lon 121.46-121.66) -- kept as-is; a newer-looking candidate dataset was
// evaluated alongside the accidents/stores refresh above but measured out
// to CENTRAL Taipei only (lat 25.02-25.06, lon 121.49-121.59, ~98k
// points), a strictly smaller coverage area, so it was not used.
//
// ── realConvenienceStoresTaipei ──────────────────────────────────────
// Still NOT the project's own sql/全國5大超商資料集 (1).csv -- that CSV is
// a government BUSINESS-REGISTRY export (公司名稱/分公司地址/...), not a
// store locator, so it has no latitude/longitude at all, only text
// addresses (~3,327 of them for Taipei, across
// 統一超商/全家/萊爾富/富達零售(OK)/全聯). Geocoding all of those was
// judged not worth doing one-address-at-a-time through a rate-limited
// public geocoder; see the project owner's conversation log for the
// options that were weighed (a paid-but-effectively-free-at-this-volume
// Google Geocoding API key, or a slow Photon batch) -- left undecided for
// now.
//
// 7-Eleven + FamilyMart (the two biggest chains) are instead built from
// pedestrianSafety/data/build_real_stores.py, using a copy of the
// "taiwan-cvs-map" project (github.com/Minato1123/taiwan-cvs-map,
// supplied by the project owner) that queries each chain's OWN official
// store-locator API directly (7-Eleven's emap.pcsc.com.tw, FamilyMart's
// api.map.com.tw) -- real chain-reported coordinates, no geocoding step
// needed at all. Source snapshot dated 2026/09/01 (see
// taiwan-cvs-map-source/last_updated_date.json next to this file); rerun
// build_real_stores.py against a newer taiwan-cvs-map export to refresh.
//
// Hi-Life + OK Mart aren't covered by taiwan-cvs-map, so those two are
// still carried over unchanged from the previous ~2015
// ctiml/convenience-store-data mirror snapshot until the CSV-geocoding
// gap above is resolved.
//
// Current result: 1,940 stores across Taipei City (975 7-Eleven, 645
// FamilyMart -- both live/2026-09, 211 Hi-Life, 109 OK Mart -- both still
// ~2015-vintage). 全聯 (PX Mart) is not included; it's a supermarket
// chain, not one of the four brands this dataset has ever tracked.
// Replaces 9 hand-placed mock points that only existed along one sample
// corridor -- see data/mockTaipeiData.js for what "mock mode" still uses.
//
// ── NOT included: 道路施工_災害路段提醒.csv ──────────────────────────
// No lat/lon, only freeway interchange names + timestamps; describes
// freeway conditions, not city-street conditions relevant to walking.
 
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
export const realAccidentsTaipei = JSON.parse(
  readFileSync(path.join(__dirname, "realAccidentsTaipei.json"), "utf8")
);
 
export const realStreetlightsTaipei = JSON.parse(
  readFileSync(path.join(__dirname, "realStreetlightsTaipei.json"), "utf8")
);
 
export const realConvenienceStoresTaipei = JSON.parse(
  readFileSync(
    path.join(__dirname, "realConvenienceStoresTaipei.json"),
    "utf8"
  )
);
 