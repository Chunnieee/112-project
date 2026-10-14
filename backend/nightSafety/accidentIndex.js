// accidentIndex.js
//
// 全台事故索引,給機車/汽車模式用(步行模式繼續用 nationalData.js 的
// realAccidents,因為那邊有地址文字可以做縣市投票)。預設從 SQLite 資料庫
// 查詢(database/pedestrian_safety.db),資料庫不存在或還沒建置時,自動退回
// 原本的二進位檔 pedestrianSafety/data/accidentsAllTaiwan.bin.gz(每台
// A1/A2 事故,約 190 萬筆,用 0.01° 格子索引,讓一條路線只需要掃附近的
// 事故)。見 db.js 開頭的 DATA_SOURCE 環境變數說明。

import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, available as dbAvailable } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "pedestrianSafety", "data");
const BIN = path.join(DATA_DIR, "accidentsAllTaiwan.bin.gz");
const META = path.join(DATA_DIR, "accidentsAllTaiwan.meta.json");

export const FLAGS = { pedestrian: 1, scooter: 2, car: 4, bicycle: 8, A1: 16 };
const INVOLVED_LABEL = [
  [FLAGS.pedestrian, "行人"],
  [FLAGS.scooter, "機車"],
  [FLAGS.car, "汽車"],
  [FLAGS.bicycle, "自行車"],
];

// See nationalData.js for what the three DATA_SOURCE values mean -- same
// rule here, decided independently (both modules agree in practice, since
// both just look at db.js's `available`).
const DATA_SOURCE_MODE = (process.env.DATA_SOURCE || "auto").toLowerCase();
const useDb = DATA_SOURCE_MODE === "json" ? false : dbAvailable;
export const source = useDb ? "sqlite" : "bin";

// ----------------------------------------------------------------------
// Load from database/pedestrian_safety.db
// ----------------------------------------------------------------------
function loadFromDatabase() {
  const row = db
    .prepare(
      `SELECT count(*) AS n, min(occurred_date) AS minD, max(occurred_date) AS maxD,
              sum(involves_pedestrian) AS pedestrian, sum(involves_scooter) AS scooter,
              sum(involves_car) AS car, sum(involves_bicycle) AS bicycle, sum(category = 'A1') AS a1
       FROM accidents
       WHERE duplicate_of_id IS NULL`
    )
    .get();

  // duplicate_of_id IS NULL matches how accidentsAllTaiwan.bin.gz itself was
  // built (build_accidents_all_modes.py): the handful of rows kept only for
  // the walking dataset's pedestrian-duplicate rule are excluded here too.
  const counts = { scooter: row.scooter, bicycle: row.bicycle, car: row.car, A1: row.a1, pedestrian: row.pedestrian };
  const metaOut = {
    format: "sqlite (database/pedestrian_safety.db, table accidents)",
    count: row.n,
    dateRange: { from: row.minD, to: row.maxD },
    flags: FLAGS,
    countsByInvolvement: counts,
  };
  const span = row.minD && row.maxD ? (Date.parse(row.maxD) - Date.parse(row.minD)) / (365.25 * 86400000) : 1;

  const FLAG_COLUMNS = [
    [FLAGS.pedestrian, "involves_pedestrian = 1"],
    [FLAGS.scooter, "involves_scooter = 1"],
    [FLAGS.car, "involves_car = 1"],
    [FLAGS.bicycle, "involves_bicycle = 1"],
    [FLAGS.A1, "category = 'A1'"],
  ];
  // One prepared statement per distinct flagMask actually used (there are at
  // most a handful -- scooter, car, etc.), built lazily and cached.
  const stmtCache = new Map();
  function stmtFor(flagMask) {
    let stmt = stmtCache.get(flagMask);
    if (stmt) return stmt;
    const conds = FLAG_COLUMNS.filter(([bit]) => flagMask & bit).map(([, sql]) => sql);
    const extra = conds.length ? `AND (${conds.join(" OR ")})` : "";
    stmt = db.prepare(
      `SELECT latitude, longitude, occurred_date AS date, severity_text AS severity, category,
              involves_pedestrian, involves_scooter, involves_car, involves_bicycle
       FROM accidents
       WHERE duplicate_of_id IS NULL
         AND latitude BETWEEN ? AND ?
         AND longitude BETWEEN ? AND ?
         ${extra}`
    );
    stmtCache.set(flagMask, stmt);
    return stmt;
  }

  function involvedLabel(r) {
    const parts = [];
    if (r.involves_pedestrian) parts.push("行人");
    if (r.involves_scooter) parts.push("機車");
    if (r.involves_car) parts.push("汽車");
    if (r.involves_bicycle) parts.push("自行車");
    return parts.join("、");
  }

  function accidentsInBoxImpl(box, flagMask) {
    return stmtFor(flagMask)
      .all(box.minLat, box.maxLat, box.minLon, box.maxLon)
      .map((r) => ({
        latitude: r.latitude,
        longitude: r.longitude,
        date: r.date,
        severity: r.severity,
        category: r.category,
        involved: involvedLabel(r),
      }));
  }

  return {
    available: true,
    meta: metaOut,
    totalCount: row.n,
    yearsSpan: span,
    accidentsInBox: accidentsInBoxImpl,
    countsByInvolvement: () => counts,
  };
}

// ----------------------------------------------------------------------
// Load from pedestrianSafety/data/accidentsAllTaiwan.bin.gz (original
// behaviour, unchanged)
// ----------------------------------------------------------------------
function loadFromBinFile() {
  const availableFlag = existsSync(BIN) && existsSync(META);
  const metaData = availableFlag ? JSON.parse(readFileSync(META, "utf8")) : null;

  let lat, lon, day, flags, deaths, injuries;
  let count = 0;
  const cells = new Map(); // "ci,cj" -> [[start, end), ...]
  const DAY0_MS = metaData ? Date.parse(metaData.day0 + "T00:00:00Z") : 0;

  if (availableFlag) {
    const buf = gunzipSync(readFileSync(BIN));
    const size = metaData.recordSize;
    count = Math.floor(buf.length / size);
    lat = new Float32Array(count);
    lon = new Float32Array(count);
    day = new Uint16Array(count);
    flags = new Uint8Array(count);
    deaths = new Uint8Array(count);
    injuries = new Uint8Array(count);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let curKey = null;
    let curStart = 0;
    const close = (end) => {
      if (curKey === null) return;
      let list = cells.get(curKey);
      if (!list) cells.set(curKey, (list = []));
      list.push([curStart, end]);
    };
    for (let i = 0; i < count; i++) {
      const o = i * size;
      lat[i] = view.getFloat32(o, true);
      lon[i] = view.getFloat32(o + 4, true);
      day[i] = view.getUint16(o + 8, true);
      flags[i] = view.getUint8(o + 10);
      deaths[i] = view.getUint8(o + 11);
      injuries[i] = view.getUint8(o + 12);
      const key = `${Math.floor(lat[i] * 100)},${Math.floor(lon[i] * 100)}`;
      if (key !== curKey) {
        close(i);
        curKey = key;
        curStart = i;
      }
    }
    close(count);
  }

  function toRecord(i) {
    const involved = INVOLVED_LABEL.filter(([bit]) => flags[i] & bit).map(([, name]) => name);
    return {
      latitude: Math.round(lat[i] * 1e6) / 1e6,
      longitude: Math.round(lon[i] * 1e6) / 1e6,
      date: new Date(DAY0_MS + day[i] * 86400000).toISOString().slice(0, 10),
      severity: `死亡${deaths[i]};受傷${injuries[i]}`,
      category: flags[i] & FLAGS.A1 ? "A1" : "A2",
      involved: involved.join("、"),
      // no accident_type on purpose: scoring.js's filterPedestrianAccidents
      // keeps records without it, so these work with the shared helpers
      // unchanged.
    };
  }

  function accidentsInBoxImpl(box, flagMask) {
    if (!availableFlag) return [];
    const out = [];
    const ci0 = Math.floor(box.minLat * 100);
    const ci1 = Math.floor(box.maxLat * 100);
    const cj0 = Math.floor(box.minLon * 100);
    const cj1 = Math.floor(box.maxLon * 100);
    for (let ci = ci0; ci <= ci1; ci++) {
      for (let cj = cj0; cj <= cj1; cj++) {
        const ranges = cells.get(`${ci},${cj}`);
        if (!ranges) continue;
        for (const [s, e] of ranges) {
          for (let i = s; i < e; i++) {
            if (!(flags[i] & flagMask)) continue;
            if (lat[i] < box.minLat || lat[i] > box.maxLat || lon[i] < box.minLon || lon[i] > box.maxLon) continue;
            out.push(toRecord(i));
          }
        }
      }
    }
    return out;
  }

  const yearsSpanVal = metaData
    ? (Date.parse(metaData.dateRange.to) - Date.parse(metaData.dateRange.from)) / (365.25 * 86400000)
    : 1;

  return {
    available: availableFlag,
    meta: metaData,
    totalCount: count,
    yearsSpan: yearsSpanVal,
    accidentsInBox: accidentsInBoxImpl,
    countsByInvolvement: () => (metaData ? metaData.countsByInvolvement : {}),
  };
}

const loaded = useDb ? loadFromDatabase() : loadFromBinFile();

export const available = loaded.available;
export const meta = loaded.meta;
export const totalCount = loaded.totalCount;
export const yearsSpan = loaded.yearsSpan;

/**
 * Accidents whose flags include `flagMask` (e.g. FLAGS.scooter) inside a
 * lat/lon box. Returns plain objects ({latitude, longitude, date, ...}).
 */
export function accidentsInBox(box, flagMask) {
  if (!loaded.available) return [];
  return loaded.accidentsInBox(box, flagMask);
}

/** Count per involvement flag (for the data summary). */
export function countsByInvolvement() {
  return loaded.countsByInvolvement();
}
