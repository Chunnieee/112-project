// nationalData.js
//
// 載入全台資料:預設從 SQLite 資料庫讀(database/pedestrian_safety.db,跑
// `npm run db:build` 產生),資料庫不存在或還沒建置時,自動退回原本的
// JSON/二進位檔(pedestrianSafety/data/ 底下),行為對外完全不變 -- 下面
// export 出去的每一樣東西,不管資料來自哪一邊,格式都一樣。見 db.js 開頭
// 的 DATA_SOURCE 環境變數說明(可以強制指定其中一邊,平常不用管)。
//
// 提供:
//   - coverage:每一種資料涵蓋哪些縣市(路燈只有部分縣市;臺南/桃園/高雄只有
//     部分行政區,用一個小格子記錄哪裡有資料 → streetlightCoveredAt())
//   - countyAt(lat, lon):查某個座標在哪個縣市(用事故地點文字 + 便利商店縣市
//     建的 2 公里格網,多數決;不需要行政區界檔案)
//   - prefilterForRoute():只取路線附近的點交給評分模組,結果跟全掃一樣但快很多
//   - applyCoverage():路線經過「沒有資料的縣市」時,那一項改成「無資料」
//     而不是 0 分(否則台中每條路都會變成「完全沒有路燈」)
//
// pedestrianSafety/ 評分模組本身完全沒改,這裡只是包在外面。

import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configForRadius } from "./pedestrianSafety/radiusThresholds.js";
import {
  WEIGHTS,
  DEFAULT_CONFIG,
  calculatePedestrianAccidentScore,
  calculateStreetlightScore,
  calculateConvenienceStoreScore,
} from "./pedestrianSafety/scoring.js";
import { db, available as dbAvailable } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "pedestrianSafety", "data");

export const TAIWAN_COUNTIES = [
  "臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣",
  "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣",
  "金門縣", "連江縣",
];

// "auto" (default) = use the database when db.js managed to open it, else
// fall back to the JSON files below. "json" forces the JSON files even if
// the database exists. "sqlite" is handled by db.js itself (it throws at
// import time if the database isn't usable, so by the time we get here
// dbAvailable is already true).
const DATA_SOURCE_MODE = (process.env.DATA_SOURCE || "auto").toLowerCase();
const useDb = DATA_SOURCE_MODE === "json" ? false : dbAvailable;
export const dataBackend = useDb ? "sqlite" : "json";

function loadFirst(candidates) {
  for (const name of candidates) {
    const file = path.join(DATA_DIR, name);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    const text = name.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return { data: JSON.parse(text), file: name };
  }
  throw new Error(`None of ${candidates.join(", ")} found in ${DATA_DIR}`);
}

function readJsonIfExists(name) {
  const file = path.join(DATA_DIR, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// ----------------------------------------------------------------------
// Load from the JSON/binary files (original behaviour, unchanged)
// ----------------------------------------------------------------------
function loadFromJsonFiles() {
  const acc = loadFirst(["realAccidentsTaiwan.json", "realAccidentsTaipei.json"]);
  // .json.gz = current build (1M+ lamps); plain .json = older builds.
  const lights = loadFirst(["realStreetlightsTaiwan.json.gz", "realStreetlightsTaiwan.json", "realStreetlightsTaipei.json"]);
  const stores = loadFirst(["realConvenienceStoresTaiwan.json", "realConvenienceStoresTaipei.json"]);

  // realStreetlightsTaiwan.json stores compact [lat, lon] pairs; expand them
  // to the {latitude, longitude} objects the scoring module expects.
  const streetlights = lights.data.map((p) => (Array.isArray(p) ? { latitude: p[0], longitude: p[1] } : p));

  const lightCoverageFile = readJsonIfExists("realStreetlightsCoverage.json");
  const storesMeta = readJsonIfExists("realConvenienceStoresTaiwan.meta.json");

  const lightsNational = lights.file.includes("Taiwan") && lightCoverageFile;
  const lightFullCities = lightsNational ? lightCoverageFile.coveredCities : ["臺北市"];
  const partialCell = (lightsNational && lightCoverageFile.partialCellDegrees) || 0.01;
  const lightPartial = new Map(
    Object.entries((lightsNational && lightCoverageFile.partialCities) || {}).map(([c, cells]) => [c, new Set(cells)])
  );

  return {
    accidents: acc.data,
    streetlights,
    stores: stores.data,
    dataFiles: { accidents: acc.file, streetlights: lights.file, stores: stores.file },
    lightFullCities,
    lightPartial,
    partialCell,
    storesInfo: storesMeta
      ? { fetchedAt: storesMeta.fetchedAt, source: storesMeta.sourceCredit, byBrand: storesMeta.byBrand }
      : null,
  };
}

// ----------------------------------------------------------------------
// Load from database/pedestrian_safety.db (same shapes as loadFromJsonFiles)
// ----------------------------------------------------------------------
function loadFromDatabase() {
  // Pedestrian-involved accidents, with the address text (location) the
  // county-voting grid below needs -- same filter build_database.py's
  // "kept duplicate" rule leaves in place, so this matches
  // realAccidentsTaiwan.json's record count.
  const accidents = db
    .prepare(
      `SELECT latitude, longitude, occurred_date AS date, 'pedestrian' AS accident_type,
              category, severity_text AS severity, occurred_time AS time, location
       FROM accidents
       WHERE involves_pedestrian = 1`
    )
    .all();

  const streetlights = db.prepare(`SELECT latitude, longitude FROM streetlights`).all();

  const stores = db
    .prepare(
      `SELECT s.latitude, s.longitude, s.brand AS store_type, s.name, s.address, c.name AS city, s.district
       FROM convenience_stores s
       LEFT JOIN counties c ON c.id = s.county_id`
    )
    .all();

  const coverageRows = db
    .prepare(
      `SELECT c.name AS county, sc.coverage_type
       FROM streetlight_coverage sc JOIN counties c ON c.id = sc.county_id`
    )
    .all();
  const lightFullCities = coverageRows.filter((r) => r.coverage_type === "full").map((r) => r.county);
  const partialCounties = coverageRows.filter((r) => r.coverage_type === "partial").map((r) => r.county);

  const partialCellRaw = db
    .prepare(`SELECT value FROM metadata WHERE key = 'streetlight_partial_cell_degrees'`)
    .pluck()
    .get();
  const partialCell = Number(partialCellRaw) || 0.01;

  // Same cell-key format as nationalData.js's streetlightCoveredAt()
  // (`${Math.floor(lat/PARTIAL_CELL)},${Math.floor(lon/PARTIAL_CELL)}`) --
  // build_database.py computed cell_i/cell_j with that exact formula.
  const lightPartial = new Map(partialCounties.map((c) => [c, new Set()]));
  if (partialCounties.length) {
    const cellRows = db
      .prepare(
        `SELECT c.name AS county, cc.cell_i, cc.cell_j
         FROM streetlight_coverage_cells cc JOIN counties c ON c.id = cc.county_id`
      )
      .all();
    for (const r of cellRows) {
      const set = lightPartial.get(r.county);
      if (set) set.add(`${r.cell_i},${r.cell_j}`);
    }
  }

  const metaRows = db.prepare(`SELECT key, value FROM metadata`).all();
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  const storesInfo = meta.stores_fetched_at
    ? {
        fetchedAt: meta.stores_fetched_at,
        source: meta.stores_source_credit,
        byBrand: meta.stores_by_brand ? JSON.parse(meta.stores_by_brand) : {},
      }
    : null;

  return {
    accidents,
    streetlights,
    stores,
    // Keep "Taiwan" in these strings -- coverage.accidents/coverage.stores
    // below (and audit.js's boxFor()) decide "nationwide vs. Taipei-only" by
    // checking for that substring.
    dataFiles: {
      accidents: "database/pedestrian_safety.db#accidents (Taiwan)",
      streetlights: "database/pedestrian_safety.db#streetlights (Taiwan)",
      stores: "database/pedestrian_safety.db#convenience_stores (Taiwan)",
    },
    lightFullCities,
    lightPartial,
    partialCell,
    storesInfo,
  };
}

const loaded = useDb ? loadFromDatabase() : loadFromJsonFiles();

export const realAccidents = loaded.accidents;
export const realStreetlights = loaded.streetlights;
export const realConvenienceStores = loaded.stores;
export const dataFiles = loaded.dataFiles;
export const storesInfo = loaded.storesInfo;

const lightFullCities = loaded.lightFullCities;
const lightPartial = loaded.lightPartial;
const PARTIAL_CELL = loaded.partialCell;

export const coverage = {
  accidents: dataFiles.accidents.includes("Taiwan") ? TAIWAN_COUNTIES : ["臺北市"],
  // Display list: partial cities carry a "(部分地區)" suffix.
  streetlights: TAIWAN_COUNTIES.flatMap((c) =>
    lightFullCities.includes(c) ? [c] : lightPartial.has(c) ? [`${c}(部分地區)`] : []
  ),
  streetlightFullCities: lightFullCities,
  streetlightPartialCities: [...lightPartial.keys()],
  stores: dataFiles.stores.includes("Taiwan") ? TAIWAN_COUNTIES : ["臺北市"],
};

/** Does streetlight data exist at this point? county = countyAt(lat, lon) if already known. */
export function streetlightCoveredAt(lat, lon, county = countyAt(lat, lon)) {
  if (county && lightFullCities.includes(county)) return true;
  if (!lightPartial.size) return false;
  const k = `${Math.floor(lat / PARTIAL_CELL)},${Math.floor(lon / PARTIAL_CELL)}`;
  // Cells are only kept for the partial cities, so look in all of them (a
  // route sample right on a city border may get the neighbour's label).
  for (const cells of lightPartial.values()) if (cells.has(k)) return true;
  return false;
}

// ----------------------------------------------------------------------
// County lookup: 0.02° (~2 km) grid, majority vote of labelled points
// ----------------------------------------------------------------------

const CELL = 0.02;
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
const countyGrid = new Map(); // key -> Map(county -> count)

function vote(lat, lon, county) {
  if (!county || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const k = cellKey(lat, lon);
  let m = countyGrid.get(k);
  if (!m) countyGrid.set(k, (m = new Map()));
  m.set(county, (m.get(county) || 0) + 1);
}

const COUNTY_SET = new Set(TAIWAN_COUNTIES);
const normCounty = (s) => {
  const c = String(s || "").replace(/台/g, "臺").slice(0, 3);
  return COUNTY_SET.has(c) ? c : null;
};
for (const a of realAccidents) vote(a.latitude, a.longitude, normCounty(a.location));
for (const s of realConvenienceStores) vote(s.latitude, s.longitude, normCounty(s.city) || normCounty(s.address));

const countyCache = new Map();
export function countyAt(lat, lon) {
  const ci = Math.floor(lat / CELL);
  const cj = Math.floor(lon / CELL);
  const ck = `${ci},${cj}`;
  if (countyCache.has(ck)) return countyCache.get(ck);
  let answer = null;
  // Own cell first, then rings out to ~6 km (mountains/sea have few points).
  for (let r = 0; r <= 3 && !answer; r++) {
    const tally = new Map();
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const m = countyGrid.get(`${ci + di},${cj + dj}`);
        if (m) for (const [c, n] of m) tally.set(c, (tally.get(c) || 0) + n);
      }
    }
    let best = 0;
    for (const [c, n] of tally) if (n > best) { best = n; answer = c; }
  }
  countyCache.set(ck, answer);
  return answer;
}

// ----------------------------------------------------------------------
// Route prefilter (same results as scanning everything, much faster)
// ----------------------------------------------------------------------

// The accident score annualizes by the WHOLE dataset's date span
// (computeAccidentDataYearsSpan), so after cutting the list down to one
// route's neighbourhood we append two far-away "sentinel" records carrying
// the dataset's first and last dates. They keep the span identical and can
// never fall inside a route buffer (they sit at the South Pole).
const accidentDates = realAccidents.map((a) => a.date).filter(Boolean).sort();
const DATE_SENTINELS = accidentDates.length
  ? [
      { latitude: -89.9, longitude: 0, date: accidentDates[0], accident_type: "pedestrian", _sentinel: true },
      { latitude: -89.9, longitude: 0, date: accidentDates[accidentDates.length - 1], accident_type: "pedestrian", _sentinel: true },
    ]
  : [];

function routeBox(route, marginMeters) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of route) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const dLat = marginMeters / 111320;
  const dLon = marginMeters / (111320 * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

const inBox = (b) => (p) =>
  p.latitude >= b.minLat && p.latitude <= b.maxLat && p.longitude >= b.minLon && p.longitude <= b.maxLon;

export function prefilterForRoute(route, bufferRadius) {
  const box = routeBox(route, bufferRadius + 100);
  const f = inBox(box);
  return {
    accidents: realAccidents.filter(f).concat(DATE_SENTINELS),
    streetlights: realStreetlights.filter(f),
    stores: realConvenienceStores.filter(f),
  };
}

// ----------------------------------------------------------------------
// Coverage-aware scoring
// ----------------------------------------------------------------------

function sampleRoute(route, stepMeters = 50) {
  const out = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepMeters));
    for (let k = 0; k < n; k++) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
  }
  if (route.length) out.push(route[route.length - 1]);
  return out;
}

const FULL = 0.98; // ≥98% of the route covered → use the original score untouched
const NONE = 0.1; //  <10% covered → this factor is "no data"

/**
 * Takes the unchanged scoring result and, for any factor whose data doesn't
 * cover (all of) the route's counties:
 *   - partly covered (10–98%): recompute that factor's density over only the
 *     covered share of the buffer area (otherwise the uncovered stretch would
 *     count as "zero streetlights there");
 *   - basically not covered (<10%): mark it null = no data, and compute the
 *     final score from the remaining factors with their weights rescaled.
 * Returns a new result object plus a `coverage` block describing what was done.
 */
export function applyCoverage(result, route, opts = {}) {
  // Per-mode overrides (scooter / car use other weights + thresholds, and
  // their accident data -- accidentsAllTaiwan.bin.gz -- is always nationwide).
  const weights = opts.weights || WEIGHTS;
  // Walking passes no config: use the defaults scaled to the route's buffer
  // radius (same as analyzePedestrianRouteSafety). Vehicle modes pass an
  // already-scaled config.
  const config = opts.config || configForRadius(DEFAULT_CONFIG, result.bufferRadiusMeters, "walk");
  const accidentCoverage = opts.accidentCoverage || coverage.accidents;
  const samples = sampleRoute(route);
  const counties = samples.map((p) => countyAt(p.lat, p.lon));
  const routeCounties = [...new Set(counties.filter(Boolean))];
  const frac = (list) => {
    if (!samples.length) return 1;
    const set = new Set(list);
    return counties.filter((c) => c && set.has(c)).length / samples.length;
  };

  const lightHits = samples.filter((p, i) => streetlightCoveredAt(p.lat, p.lon, counties[i])).length;
  const f = {
    accident: frac(accidentCoverage),
    streetlight: samples.length ? lightHits / samples.length : 1,
    convenienceStore: frac(coverage.stores),
  };
  const area = result.bufferAreaKm2;
  const span = result.accidentDataYearsSpan;
  const out = { ...result };
  const status = {};

  const rescore = {
    accident: (ff) =>
      calculatePedestrianAccidentScore(result.accidentWeightedCount ?? result.pedestrianAccidents, area * ff, span, config),
    streetlight: (ff) => calculateStreetlightScore(result.streetlights, area * ff, config),
    convenienceStore: (ff) => calculateConvenienceStoreScore(result.convenienceStores, area * ff, config),
  };
  const keyOf = { accident: "accidentScore", streetlight: "streetlightScore", convenienceStore: "convenienceStoreScore" };

  let changed = false;
  for (const factor of Object.keys(f)) {
    const ff = f[factor];
    if (!weights[factor]) {
      status[factor] = "unused"; // this mode doesn't score this factor at all
      continue;
    }
    if (ff >= FULL) {
      status[factor] = "full";
    } else if (ff < NONE) {
      status[factor] = "no-data";
      out[keyOf[factor]] = null;
      changed = true;
    } else {
      status[factor] = "partial";
      out[keyOf[factor]] = Math.round(rescore[factor](ff) * 10) / 10;
      changed = true;
    }
  }

  if (changed) {
    let sum = 0;
    let w = 0;
    for (const factor of Object.keys(f)) {
      const v = out[keyOf[factor]];
      if (v === null || v === undefined) continue;
      if (!weights[factor]) continue;
      sum += v * weights[factor];
      w += weights[factor];
    }
    out.finalSafetyScore = w > 0 ? Math.round(Math.max(0, Math.min(100, sum / w)) * 10) / 10 : null;
  }

  out.coverage = {
    routeCounties,
    fraction: {
      accident: Math.round(f.accident * 100) / 100,
      streetlight: Math.round(f.streetlight * 100) / 100,
      convenienceStore: Math.round(f.convenienceStore * 100) / 100,
    },
    status,
    coveredCounties: { streetlight: coverage.streetlights, accident: coverage.accidents.length === TAIWAN_COUNTIES.length ? "全台" : coverage.accidents, convenienceStore: coverage.stores.length === TAIWAN_COUNTIES.length ? "全台" : coverage.stores },
    adjusted: changed,
    note: changed
      ? "路線有部分或全部不在某些資料的涵蓋範圍內:部分涵蓋的項目只用有資料的那段計算密度;完全沒有資料的項目不計分,總分由其餘項目依原權重比例換算。"
      : null,
  };
  return out;
}
