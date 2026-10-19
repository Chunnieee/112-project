import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "risknav.sqlite");

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});

const db = new Database(DB_PATH);

// Better local durability/performance.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS historical_route_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    route_hash TEXT NOT NULL,
    routing_engine TEXT NOT NULL DEFAULT 'valhalla',
    model_version TEXT NOT NULL DEFAULT 'v1',

    city TEXT NOT NULL,

    observation_date TEXT NOT NULL,
    weekday INTEGER NOT NULL,

    bucket_start TEXT NOT NULL,

    historical_eta_sec REAL NOT NULL,

    tdx_observed_sec REAL,
    uncovered_baseline_sec REAL,

    route_distance_m REAL,
    matched_distance_m REAL,

    coverage_ratio REAL,

    matched_section_count INTEGER DEFAULT 0,

    source TEXT NOT NULL DEFAULT 'TDX Historical',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (
      route_hash,
      routing_engine,
      model_version,
      observation_date,
      bucket_start
    )
  );

  CREATE INDEX IF NOT EXISTS idx_history_lookup
  ON historical_route_observations (
    route_hash,
    routing_engine,
    model_version,
    weekday,
    bucket_start,
    observation_date
  );

  CREATE INDEX IF NOT EXISTS idx_history_city_date
  ON historical_route_observations (
    city,
    observation_date
  );
`);


/**
 * Create a stable identifier for a route geometry.
 *
 * Route A/B/C labels are NOT stable enough for database identity.
 * Instead, we hash the actual route geometry.
 */
export function createRouteHash(route) {
  const geometry =
    route?.geometry ??
    route?.raw?.geometry;

  if (!geometry) {
    throw new Error(
      "Cannot create route hash: route geometry is missing."
    );
  }

  let coordinates;

  if (
    geometry.type === "LineString" &&
    Array.isArray(geometry.coordinates)
  ) {
    coordinates = geometry.coordinates;
  } else if (Array.isArray(geometry.coordinates)) {
    coordinates = geometry.coordinates;
  } else {
    throw new Error(
      "Cannot create route hash: unsupported route geometry."
    );
  }

  // Round slightly so insignificant floating-point noise
  // does not create a completely new route identity.
  const normalized = coordinates.map((point) => {
    if (!Array.isArray(point) || point.length < 2) {
      return point;
    }

    return [
      Number(point[0].toFixed(5)),
      Number(point[1].toFixed(5)),
    ];
  });

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}


/**
 * Convert YYYY-MM-DD to weekday in Taiwan time.
 *
 * 0 = Sunday
 * 1 = Monday
 * ...
 * 6 = Saturday
 */
export function weekdayFromDate(dateString) {
  const d = new Date(
    `${dateString}T12:00:00+08:00`
  );

  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Invalid date: ${dateString}`
    );
  }

  return d.getDay();
}


/**
 * Insert or update one historical route observation.
 *
 * One row = one route + one historical date + one time bucket.
 */
export function upsertHistoricalObservation({
  routeHash,

  routingEngine = "valhalla",
  modelVersion = "v1",

  city,

  observationDate,
  weekday,

  bucketStart,

  historicalEtaSec,

  tdxObservedSec = null,
  uncoveredBaselineSec = null,

  routeDistanceM = null,
  matchedDistanceM = null,

  coverageRatio = null,

  matchedSectionCount = 0,

  source = "TDX Historical",
}) {
  if (!routeHash) {
    throw new Error(
      "routeHash is required."
    );
  }

  if (!city) {
    throw new Error(
      "city is required."
    );
  }

  if (!observationDate) {
    throw new Error(
      "observationDate is required."
    );
  }

  if (!bucketStart) {
    throw new Error(
      "bucketStart is required."
    );
  }

  if (
    !Number.isFinite(historicalEtaSec) ||
    historicalEtaSec <= 0
  ) {
    throw new Error(
      `Invalid historicalEtaSec: ${historicalEtaSec}`
    );
  }

  const weekdayValue =
    Number.isInteger(weekday)
      ? weekday
      : weekdayFromDate(observationDate);

  const stmt = db.prepare(`
    INSERT INTO historical_route_observations (
      route_hash,
      routing_engine,
      model_version,

      city,

      observation_date,
      weekday,
      bucket_start,

      historical_eta_sec,

      tdx_observed_sec,
      uncovered_baseline_sec,

      route_distance_m,
      matched_distance_m,

      coverage_ratio,

      matched_section_count,

      source,

      updated_at
    )

    VALUES (
      @routeHash,
      @routingEngine,
      @modelVersion,

      @city,

      @observationDate,
      @weekday,
      @bucketStart,

      @historicalEtaSec,

      @tdxObservedSec,
      @uncoveredBaselineSec,

      @routeDistanceM,
      @matchedDistanceM,

      @coverageRatio,

      @matchedSectionCount,

      @source,

      CURRENT_TIMESTAMP
    )

    ON CONFLICT (
      route_hash,
      routing_engine,
      model_version,
      observation_date,
      bucket_start
    )

    DO UPDATE SET
      city = excluded.city,

      weekday = excluded.weekday,

      historical_eta_sec =
        excluded.historical_eta_sec,

      tdx_observed_sec =
        excluded.tdx_observed_sec,

      uncovered_baseline_sec =
        excluded.uncovered_baseline_sec,

      route_distance_m =
        excluded.route_distance_m,

      matched_distance_m =
        excluded.matched_distance_m,

      coverage_ratio =
        excluded.coverage_ratio,

      matched_section_count =
        excluded.matched_section_count,

      source =
        excluded.source,

      updated_at =
        CURRENT_TIMESTAMP
  `);

  return stmt.run({
    routeHash,

    routingEngine,
    modelVersion,

    city,

    observationDate,
    weekday: weekdayValue,

    bucketStart,

    historicalEtaSec,

    tdxObservedSec,
    uncoveredBaselineSec,

    routeDistanceM,
    matchedDistanceM,

    coverageRatio,

    matchedSectionCount,

    source,
  });
}


/**
 * Get historical samples for one current route.
 *
 * Same:
 * - route
 * - routing engine
 * - model version
 * - weekday
 * - 30-minute bucket
 *
 * Only dates BEFORE the current date are returned.
 */
export function getHistoricalObservations({
  routeHash,

  routingEngine = "valhalla",
  modelVersion = "v1",

  weekday,
  bucketStart,

  beforeDate,

  afterDate = null,

  limit = 26,
}) {
  if (!routeHash) {
    throw new Error(
      "routeHash is required."
    );
  }

  if (!beforeDate) {
    throw new Error(
      "beforeDate is required."
    );
  }

  let sql = `
    SELECT
      id,

      route_hash AS routeHash,
      routing_engine AS routingEngine,
      model_version AS modelVersion,

      city,

      observation_date AS observationDate,
      weekday,
      bucket_start AS bucketStart,

      historical_eta_sec AS historicalEtaSec,

      tdx_observed_sec AS tdxObservedSec,
      uncovered_baseline_sec AS uncoveredBaselineSec,

      route_distance_m AS routeDistanceM,
      matched_distance_m AS matchedDistanceM,

      coverage_ratio AS coverageRatio,

      matched_section_count AS matchedSectionCount,

      source,

      created_at AS createdAt,
      updated_at AS updatedAt

    FROM historical_route_observations

    WHERE route_hash = @routeHash
      AND routing_engine = @routingEngine
      AND model_version = @modelVersion
      AND weekday = @weekday
      AND bucket_start = @bucketStart
      AND observation_date < @beforeDate
  `;

  if (afterDate) {
    sql += `
      AND observation_date >= @afterDate
    `;
  }

  sql += `
    ORDER BY observation_date DESC
    LIMIT @limit
  `;

  const stmt = db.prepare(sql);

  return stmt.all({
    routeHash,
    routingEngine,
    modelVersion,
    weekday,
    bucketStart,
    beforeDate,
    afterDate,
    limit,
  });
}


/**
 * Get every stored observation for debugging / inspection.
 */
export function listHistoricalObservations(
  limit = 100
) {
  return db
    .prepare(`
      SELECT
        id,

        substr(route_hash, 1, 12) AS routeHashShort,

        routing_engine AS routingEngine,
        model_version AS modelVersion,

        city,

        observation_date AS observationDate,
        weekday,
        bucket_start AS bucketStart,

        ROUND(
          historical_eta_sec / 60.0,
          2
        ) AS historicalEtaMin,

        ROUND(
          coverage_ratio * 100.0,
          1
        ) AS coveragePercent,

        matched_section_count AS matchedSectionCount,

        source

      FROM historical_route_observations

      ORDER BY
        observation_date DESC,
        bucket_start DESC

      LIMIT ?
    `)
    .all(limit);
}


/**
 * Basic database status.
 */
export function getHistoricalDbStatus() {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS observationCount,

        COUNT(
          DISTINCT observation_date
        ) AS uniqueDates,

        MIN(
          observation_date
        ) AS oldestDate,

        MAX(
          observation_date
        ) AS newestDate

      FROM historical_route_observations
    `)
    .get();

  return {
    databasePath: DB_PATH,

    observationCount:
      row.observationCount,

    uniqueDates:
      row.uniqueDates,

    oldestDate:
      row.oldestDate,

    newestDate:
      row.newestDate,
  };
}



// ROUTE_SECTION_CACHE_V1
//
// Persistent route geometry -> TDX SectionID mapping.
//
// Purpose:
// Once a route has successfully been matched to TDX road sections,
// preserve that mapping locally so Historical Risk does not depend
// on the live TDX API being available on every future request.
//
db.exec(`
  CREATE TABLE IF NOT EXISTS route_metadata (
    route_hash TEXT PRIMARY KEY,

    routing_engine TEXT NOT NULL DEFAULT 'valhalla',
    route_label TEXT,

    route_distance_m REAL,

    start_lon REAL,
    start_lat REAL,
    end_lon REAL,
    end_lat REAL,

    geometry_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS route_section_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    route_hash TEXT NOT NULL,

    scope TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    section_id TEXT NOT NULL,

    matched_distance_km REAL NOT NULL,
    section_length_km REAL,

    road_name TEXT,
    road_direction TEXT,

    source TEXT,
    geometry_source TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (route_hash)
      REFERENCES route_metadata(route_hash)
      ON DELETE CASCADE,

    UNIQUE (
      route_hash,
      scope,
      city,
      section_id
    )
  );

  CREATE INDEX IF NOT EXISTS idx_route_section_map_route
  ON route_section_map(route_hash);

  CREATE INDEX IF NOT EXISTS idx_route_section_map_section
  ON route_section_map(scope, city, section_id);
`);


const upsertRouteMetadataStatement =
  db.prepare(`
    INSERT INTO route_metadata (
      route_hash,
      routing_engine,
      route_label,
      route_distance_m,
      start_lon,
      start_lat,
      end_lon,
      end_lat,
      geometry_json
    )
    VALUES (
      @routeHash,
      @routingEngine,
      @routeLabel,
      @routeDistanceM,
      @startLon,
      @startLat,
      @endLon,
      @endLat,
      @geometryJson
    )

    ON CONFLICT(route_hash)
    DO UPDATE SET
      routing_engine = excluded.routing_engine,
      route_label = excluded.route_label,
      route_distance_m = excluded.route_distance_m,

      start_lon = excluded.start_lon,
      start_lat = excluded.start_lat,
      end_lon = excluded.end_lon,
      end_lat = excluded.end_lat,

      geometry_json = excluded.geometry_json,

      updated_at = CURRENT_TIMESTAMP
  `);


const deleteRouteSectionsStatement =
  db.prepare(`
    DELETE FROM route_section_map
    WHERE route_hash = ?
  `);


const insertRouteSectionStatement =
  db.prepare(`
    INSERT INTO route_section_map (
      route_hash,
      scope,
      city,
      section_id,
      matched_distance_km,
      section_length_km,
      road_name,
      road_direction,
      source,
      geometry_source
    )
    VALUES (
      @routeHash,
      @scope,
      @city,
      @sectionId,
      @matchedDistanceKm,
      @sectionLengthKm,
      @roadName,
      @roadDirection,
      @source,
      @geometrySource
    )
  `);


const saveRouteSectionMappingTransaction =
  db.transaction(({
    metadata,
    sections,
  }) => {

    upsertRouteMetadataStatement.run(
      metadata
    );

    /*
     * Replace the mapping atomically.
     *
     * We only call this function when a non-empty successful
     * TDX match exists, so a provider outage can never erase
     * the last-good route mapping.
     */
    deleteRouteSectionsStatement.run(
      metadata.routeHash
    );

    for (const section of sections) {
      insertRouteSectionStatement.run(
        section
      );
    }

    return {
      routeHash:
        metadata.routeHash,

      sectionCount:
        sections.length,
    };
  });


export function saveRouteSectionMapping({
  routeHash,
  route,
  routingEngine = "valhalla",
  routeDistanceKm = null,
  matchedSections = [],
}) {

  const normalizedRouteHash =
    String(routeHash || "").trim();

  if (!normalizedRouteHash) {
    throw new Error(
      "routeHash is required"
    );
  }


  if (
    !Array.isArray(matchedSections) ||
    matchedSections.length === 0
  ) {
    return {
      saved: false,
      routeHash:
        normalizedRouteHash,
      sectionCount: 0,
      reason:
        "no matched sections",
    };
  }


  const geometry =
    route?.geometry ??
    route?.raw?.geometry ??
    null;


  const coordinates =
    (
      geometry?.type === "LineString" &&
      Array.isArray(
        geometry?.coordinates
      )
    )
      ? geometry.coordinates
      : [];


  const startPoint =
    coordinates.length
      ? coordinates[0]
      : null;


  const endPoint =
    coordinates.length
      ? coordinates[
          coordinates.length - 1
        ]
      : null;


  const distanceKm =
    Number(routeDistanceKm);


  const fallbackDistanceM =
    Number(
      route?.distance ??
      route?.raw?.distance
    );


  const routeDistanceM =
    Number.isFinite(distanceKm) &&
    distanceKm > 0
      ? distanceKm * 1000
      : (
          Number.isFinite(
            fallbackDistanceM
          )
            ? fallbackDistanceM
            : null
        );


  const sections =
    matchedSections
      .map((item) => {

        const scope =
          String(
            item?.scope ||
            ""
          )
            .trim()
            .toLowerCase();


        const sectionId =
          String(
            item?.sectionId ||
            ""
          ).trim();


        const city =
          String(
            item?.city ||
            ""
          ).trim();


        const matchedDistanceKm =
          Number(
            item?.matchedDistanceKm
          );


        if (
          ![
            "city",
            "freeway",
            "highway",
          ].includes(scope) ||
          !sectionId ||
          !Number.isFinite(
            matchedDistanceKm
          ) ||
          matchedDistanceKm <= 0
        ) {
          return null;
        }


        return {
          routeHash:
            normalizedRouteHash,

          scope,

          city:
            scope === "city"
              ? city
              : "",

          sectionId,

          matchedDistanceKm,

          sectionLengthKm:
            Number.isFinite(
              Number(
                item?.sectionLengthKm
              )
            )
              ? Number(
                  item.sectionLengthKm
                )
              : null,

          roadName:
            item?.roadName
              ? String(
                  item.roadName
                )
              : null,

          roadDirection:
            item?.roadDirection
              ? String(
                  item.roadDirection
                )
              : null,

          source:
            item?.source
              ? String(
                  item.source
                )
              : null,

          geometrySource:
            item?.geometrySource
              ? String(
                  item.geometrySource
                )
              : null,
        };
      })
      .filter(Boolean);


  if (!sections.length) {
    return {
      saved: false,
      routeHash:
        normalizedRouteHash,
      sectionCount: 0,
      reason:
        "no usable matched sections",
    };
  }


  const result =
    saveRouteSectionMappingTransaction({
      metadata: {
        routeHash:
          normalizedRouteHash,

        routingEngine:
          String(
            routingEngine ||
            "valhalla"
          ),

        routeLabel:
          route?.label
            ? String(route.label)
            : null,

        routeDistanceM,

        startLon:
          Array.isArray(startPoint)
            ? Number(startPoint[0])
            : null,

        startLat:
          Array.isArray(startPoint)
            ? Number(startPoint[1])
            : null,

        endLon:
          Array.isArray(endPoint)
            ? Number(endPoint[0])
            : null,

        endLat:
          Array.isArray(endPoint)
            ? Number(endPoint[1])
            : null,

        geometryJson:
          geometry
            ? JSON.stringify(
                geometry
              )
            : null,
      },

      sections,
    });


  return {
    saved: true,
    ...result,
  };
}


export function getRouteSectionMapping(
  routeHash
) {

  const normalizedRouteHash =
    String(routeHash || "").trim();

  if (!normalizedRouteHash) {
    return null;
  }


  const metadata =
    db.prepare(`
      SELECT
        route_hash AS routeHash,
        routing_engine AS routingEngine,
        route_label AS routeLabel,
        route_distance_m AS routeDistanceM,

        start_lon AS startLon,
        start_lat AS startLat,
        end_lon AS endLon,
        end_lat AS endLat,

        geometry_json AS geometryJson,

        created_at AS createdAt,
        updated_at AS updatedAt

      FROM route_metadata

      WHERE route_hash = ?
    `)
    .get(
      normalizedRouteHash
    );


  if (!metadata) {
    return null;
  }


  const sections =
    db.prepare(`
      SELECT
        scope,
        city,
        section_id AS sectionId,

        matched_distance_km
          AS matchedDistanceKm,

        section_length_km
          AS sectionLengthKm,

        road_name AS roadName,
        road_direction AS roadDirection,

        source,
        geometry_source AS geometrySource

      FROM route_section_map

      WHERE route_hash = ?

      ORDER BY id ASC
    `)
    .all(
      normalizedRouteHash
    )
    .map((item) => ({
      ...item,

      city:
        item.city ||
        null,
    }));


  return {
    ...metadata,

    geometry:
      metadata.geometryJson
        ? JSON.parse(
            metadata.geometryJson
          )
        : null,

    sections,
  };
}



export {
  db,
  DB_PATH,
};