// =========================================================
// safetyDatabase.js
// ---------------------------------------------------------
// 這個檔案負責「連接資料庫」。
//
// It reads the unified tables built by sql/build_safety_db.py:
//
//   streetlights        → 路燈 (全台，各縣市合併)
//   convenience_stores  → 便利商店
//   accidents           → 事故 (A1 + A2，全台)
//   coverage_cells      → 哪些 1 公里方格真的有資料
//
// If those tables do not exist yet it falls back to the old
// taipei_* tables, so the server still starts.
//
// Unlike the old version it does NOT read every row into memory.
// 1.4 million accidents would cost ~700 MB and ~15 s at startup.
// Instead the file stays open and each route asks only for the
// rows inside its own bounding box.
// =========================================================

import Database from "better-sqlite3";
import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SAFETY_DB_PATH =
  process.env.SAFETY_DB_PATH ||
  path.join(__dirname, "..", "TablePlus", "Taiwan_SafetyData.sqlite");

// Must match CELL_DEG in sql/build_safety_db.py
export const COVERAGE_CELL_DEG = 0.01;

// The safety model walks people down streets, so by default it counts
// only accidents that involved a pedestrian (行人). Counting all 1.38 M
// A1+A2 records would push every urban street past the "worst" threshold
// and make every route score 0. Set SAFETY_ALL_ACCIDENTS=1 to use them all.
export const PEDESTRIAN_ONLY =
  String(process.env.SAFETY_ALL_ACCIDENTS || "").trim() !== "1";

let db = null;
let schema = null;

function tableExists(connection, name) {
  const row = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

function firstTable(connection, names) {
  return names.find((n) => tableExists(connection, n)) || null;
}

function columnsOf(connection, table) {
  return connection
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name);
}

// The merged tables use lat/lon; the old Taipei tables use latitude/longitude.
function coordNames(connection, table) {
  const cols = columnsOf(connection, table);
  const lat = cols.includes("lat") ? "lat" : "latitude";
  const lon = cols.includes("lon") ? "lon" : "longitude";
  return { lat, lon, cols };
}

function openDatabase() {
  if (db) return db;

  if (!fs.existsSync(SAFETY_DB_PATH)) {
    throw new Error(
      `找不到資料庫檔案 (database file not found): ${SAFETY_DB_PATH}`
    );
  }

  db = new Database(SAFETY_DB_PATH, { readonly: true, fileMustExist: true });

  schema = {
    streetlights: firstTable(db, ["streetlights", "taipei_streetlights"]),
    stores: firstTable(db, ["convenience_stores", "taipei_convenience_stores"]),
    accidents: firstTable(db, ["accidents", "taipei_pedestrian_accidents"]),
    hasCoverage: tableExists(db, "coverage_cells"),
  };

  if (!schema.streetlights || !schema.stores || !schema.accidents) {
    throw new Error(
      "資料庫缺少必要的表格 (missing tables). 請先執行 python sql/build_safety_db.py"
    );
  }

  return db;
}

export function closeSafetyDb() {
  if (db) {
    db.close();
    db = null;
    schema = null;
  }
}

// ---------------------------------------------------------
// COVERAGE — which ~1 km squares actually contain data
// ---------------------------------------------------------
// The old code kept one min/max rectangle per dataset. With only
// Taipei loaded that worked. Once several cities are merged the
// rectangle spans everything between them, so empty countryside
// looked "covered" and scores came out wrong. Cells fix that.

function cellKey(lat, lon) {
  return `${Math.floor(lat / COVERAGE_CELL_DEG)}:${Math.floor(
    lon / COVERAGE_CELL_DEG
  )}`;
}

function readCoverage(connection, kind, table) {
  if (schema.hasCoverage) {
    const rows = connection
      .prepare("SELECT cell FROM coverage_cells WHERE kind = ?")
      .all(kind);
    if (rows.length) return new Set(rows.map((r) => r.cell));
  }

  // Fallback: derive it now (slower, but the server still works).
  const { lat, lon } = coordNames(connection, table);
  const rows = connection
    .prepare(
      `SELECT DISTINCT
         CAST(FLOOR(${lat} / ${COVERAGE_CELL_DEG}) AS INTEGER) AS i,
         CAST(FLOOR(${lon} / ${COVERAGE_CELL_DEG}) AS INTEGER) AS j
       FROM "${table}"
       WHERE ${lat} IS NOT NULL AND ${lon} IS NOT NULL`
    )
    .all();
  return new Set(rows.map((r) => `${r.i}:${r.j}`));
}

// Stores are sparse (one per few hundred metres), so a raw 1 km cell map
// would call a block with no shop "no data". Grow the store map by a
// couple of cells: that distinguishes "city we have no shop data for"
// from "street that happens to have no shop".
function dilate(cells, rings) {
  if (rings <= 0) return cells;
  const out = new Set();
  for (const key of cells) {
    const [i, j] = key.split(":").map(Number);
    for (let di = -rings; di <= rings; di++) {
      for (let dj = -rings; dj <= rings; dj++) {
        out.add(`${i + di}:${j + dj}`);
      }
    }
  }
  return out;
}

export function hasCoverageAt(coverage, lat, lon) {
  if (!coverage || coverage.size === 0) return false;
  return coverage.has(cellKey(lat, lon));
}

// ---------------------------------------------------------
// STARTUP: counts + coverage only (fast, a few MB)
// ---------------------------------------------------------

export function loadSafetyIndex() {
  const connection = openDatabase();

  const count = (table) =>
    connection.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;

  return {
    tables: { ...schema },
    counts: {
      streetlights: count(schema.streetlights),
      stores: count(schema.stores),
      accidents: count(schema.accidents),
      accidentsUsed:
        PEDESTRIAN_ONLY &&
        columnsOf(connection, schema.accidents).includes("is_pedestrian")
          ? connection
              .prepare(
                `SELECT COUNT(*) AS n FROM "${schema.accidents}" WHERE is_pedestrian = 1`
              )
              .get().n
          : count(schema.accidents),
    },
    pedestrianOnly: PEDESTRIAN_ONLY,
    coverage: {
      streetlights: readCoverage(connection, "streetlights", schema.streetlights),
      stores: dilate(readCoverage(connection, "stores", schema.stores), 2),
      accidents: readCoverage(connection, "accidents", schema.accidents),
    },
    cellDeg: COVERAGE_CELL_DEG,
    loadedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------
// PER-ROUTE: fetch only the rows inside a bounding box
// ---------------------------------------------------------

function selectBox(table, extraCols, box) {
  const connection = openDatabase();
  const { lat, lon, cols } = coordNames(connection, table);

  const picked = extraCols
    .filter((c) => cols.includes(c))
    .map((c) => `"${c}"`)
    .join(", ");

  const sql =
    `SELECT ${lat} AS lat, ${lon} AS lon${picked ? ", " + picked : ""} ` +
    `FROM "${table}" ` +
    `WHERE ${lat} BETWEEN ? AND ? AND ${lon} BETWEEN ? AND ?`;

  return connection
    .prepare(sql)
    .all(box.minLat, box.maxLat, box.minLon, box.maxLon);
}

export function queryStreetlights(box) {
  openDatabase();
  return selectBox(schema.streetlights, ["pole_id", "city"], box);
}

export function queryStores(box) {
  openDatabase();
  return selectBox(schema.stores, ["store_type", "name", "address"], box);
}

export function queryAccidents(box) {
  const connection = openDatabase();
  const rows = selectBox(
    schema.accidents,
    ["date", "time", "location", "category", "severity", "dead", "injured", "is_pedestrian"],
    box
  );

  const hasFlag = columnsOf(connection, schema.accidents).includes("is_pedestrian");
  if (PEDESTRIAN_ONLY && hasFlag) {
    return rows.filter((r) => Number(r.is_pedestrian) === 1);
  }
  return rows;
}

// Kept so any old import of loadSafetyData() still resolves.
export function loadSafetyData() {
  return loadSafetyIndex();
}