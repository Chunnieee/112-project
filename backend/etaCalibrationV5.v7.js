import { calculateHistoricalBlindSpotSupplement } from "./etaEvidenceV6.js";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.ETA_CALIBRATION_DB_PATH
  ? path.resolve(process.env.ETA_CALIBRATION_DB_PATH)
  : path.join(DATA_DIR, "risknav.sqlite");
const MODEL_VERSION = "eta-v5";
const TIME_ZONE = "Asia/Taipei";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS eta_actual_observations_v5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_version TEXT NOT NULL DEFAULT '${MODEL_VERSION}',
    trip_id TEXT,
    route_hash TEXT NOT NULL,
    corridor_key TEXT,
    origin_jurisdiction TEXT,
    destination_jurisdiction TEXT,
    distance_km REAL,
    weekday INTEGER NOT NULL,
    bucket_start TEXT NOT NULL,
    pre_calibration_expected_min REAL NOT NULL,
    actual_min REAL NOT NULL,
    residual_min REAL NOT NULL,
    matched_coverage_ratio REAL,
    travel_time_coverage_ratio REAL,
    effective_adjusted_coverage_ratio REAL,
    signal_count INTEGER,
    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_eta_v5_route_bucket
  ON eta_actual_observations_v5 (
    model_version,
    route_hash,
    weekday,
    bucket_start,
    observed_at
  );

  CREATE INDEX IF NOT EXISTS idx_eta_v5_corridor_bucket
  ON eta_actual_observations_v5 (
    model_version,
    corridor_key,
    weekday,
    bucket_start,
    observed_at
  );
`);

// V7 idempotency migration. Pending feedback can be retried after a network
// interruption; trip_id prevents the same completed trip from becoming two
// calibration samples when the first server write succeeded but the response
// was lost.
const etaV5Columns = db
  .prepare("PRAGMA table_info(eta_actual_observations_v5)")
  .all()
  .map((row) => String(row?.name || ""));

if (!etaV5Columns.includes("trip_id")) {
  db.exec("ALTER TABLE eta_actual_observations_v5 ADD COLUMN trip_id TEXT");
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eta_v5_trip_id
  ON eta_actual_observations_v5 (model_version, trip_id)
  WHERE trip_id IS NOT NULL;
`);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function robustResidualStats(values) {
  const raw = values.map(Number).filter(Number.isFinite);

  if (!raw.length) {
    return {
      sampleCount: 0,
      filteredCount: 0,
      medianResidualMin: 0,
      madMin: null,
    };
  }

  const med = median(raw);
  const mad = median(raw.map((value) => Math.abs(value - med)));

  let filtered = raw;
  if (Number.isFinite(mad) && mad > 0) {
    const robustSigma = mad * 1.4826;
    const maxDeviation = Math.max(2, robustSigma * 3.5);
    filtered = raw.filter((value) => Math.abs(value - med) <= maxDeviation);
  }

  return {
    sampleCount: raw.length,
    filteredCount: filtered.length,
    medianResidualMin: median(filtered) ?? med ?? 0,
    madMin: Number.isFinite(mad) ? mad : null,
  };
}

function localParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[parts.weekday],
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseDepartureTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

export function resolveEtaCalibrationTime({
  departureTime = null,
  date = new Date(),
} = {}) {
  const current = localParts(date);
  const requested = parseDepartureTime(departureTime);
  const hour = requested?.hour ?? current.hour;
  const minute = requested?.minute ?? current.minute;
  const bucketMinute = minute < 30 ? 0 : 30;

  return {
    weekday: current.weekday,
    bucketStart: `${String(hour).padStart(2, "0")}:${String(
      bucketMinute
    ).padStart(2, "0")}`,
  };
}

export function calculateHistoricalGapSupplement(args) {
  return calculateHistoricalBlindSpotSupplement(args);
}

export function recordEtaActualObservation({
  tripId = null,
  routeHash,
  corridorKey = null,
  originJurisdiction = null,
  destinationJurisdiction = null,
  distanceKm = null,
  departureTime = null,
  preCalibrationExpectedMin,
  actualMin,
  matchedCoverageRatio = null,
  travelTimeCoverageRatio = null,
  effectiveAdjustedCoverageRatio = null,
  signalCount = null,
  observedAt = new Date(),
}) {
  const route = String(routeHash || "").trim();
  const corridor = String(corridorKey || "").trim() || null;
  const trip = String(tripId || "").trim() || null;
  const predicted = Number(preCalibrationExpectedMin);
  const actual = Number(actualMin);

  if (!route) throw new Error("routeHash is required");
  if (!Number.isFinite(predicted) || predicted <= 0) {
    throw new Error("preCalibrationExpectedMin must be a positive number");
  }
  if (!Number.isFinite(actual) || actual <= 0 || actual > 720) {
    throw new Error("actualMin must be between 0 and 720 minutes");
  }

  if (trip) {
    const existing = db
      .prepare(`
        SELECT
          id, trip_id AS tripId, route_hash AS routeHash,
          corridor_key AS corridorKey, origin_jurisdiction AS originJurisdiction,
          destination_jurisdiction AS destinationJurisdiction, distance_km AS distanceKm,
          weekday, bucket_start AS bucketStart,
          pre_calibration_expected_min AS preCalibrationExpectedMin,
          actual_min AS actualMin, residual_min AS residualMin
        FROM eta_actual_observations_v5
        WHERE model_version = ? AND trip_id = ?
        LIMIT 1
      `)
      .get(MODEL_VERSION, trip);

    if (existing) {
      return {
        ...existing,
        modelVersion: MODEL_VERSION,
        distanceKm: round(existing.distanceKm, 2),
        preCalibrationExpectedMin: round(existing.preCalibrationExpectedMin, 2),
        actualMin: round(existing.actualMin, 2),
        residualMin: round(existing.residualMin, 2),
        deduplicated: true,
      };
    }
  }

  const { weekday, bucketStart } = resolveEtaCalibrationTime({
    departureTime,
    date: observedAt,
  });

  const residualMin = actual - predicted;

  const info = db
    .prepare(`
      INSERT INTO eta_actual_observations_v5 (
        model_version,
        trip_id,
        route_hash,
        corridor_key,
        origin_jurisdiction,
        destination_jurisdiction,
        distance_km,
        weekday,
        bucket_start,
        pre_calibration_expected_min,
        actual_min,
        residual_min,
        matched_coverage_ratio,
        travel_time_coverage_ratio,
        effective_adjusted_coverage_ratio,
        signal_count,
        observed_at
      ) VALUES (
        @modelVersion,
        @tripId,
        @routeHash,
        @corridorKey,
        @originJurisdiction,
        @destinationJurisdiction,
        @distanceKm,
        @weekday,
        @bucketStart,
        @predicted,
        @actual,
        @residualMin,
        @matchedCoverageRatio,
        @travelTimeCoverageRatio,
        @effectiveAdjustedCoverageRatio,
        @signalCount,
        @observedAt
      )
    `)
    .run({
      modelVersion: MODEL_VERSION,
      tripId: trip,
      routeHash: route,
      corridorKey: corridor,
      originJurisdiction: String(originJurisdiction || "").trim() || null,
      destinationJurisdiction: String(destinationJurisdiction || "").trim() || null,
      distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : null,
      weekday,
      bucketStart,
      predicted,
      actual,
      residualMin,
      matchedCoverageRatio: Number.isFinite(Number(matchedCoverageRatio))
        ? clamp(Number(matchedCoverageRatio), 0, 1)
        : null,
      travelTimeCoverageRatio: Number.isFinite(Number(travelTimeCoverageRatio))
        ? clamp(Number(travelTimeCoverageRatio), 0, 1)
        : null,
      effectiveAdjustedCoverageRatio: Number.isFinite(Number(effectiveAdjustedCoverageRatio))
        ? clamp(Number(effectiveAdjustedCoverageRatio), 0, 1)
        : null,
      signalCount: Number.isFinite(Number(signalCount))
        ? Math.max(0, Math.round(Number(signalCount)))
        : null,
      observedAt: observedAt.toISOString(),
    });

  return {
    id: Number(info.lastInsertRowid),
    modelVersion: MODEL_VERSION,
    tripId: trip,
    routeHash: route,
    corridorKey: corridor,
    originJurisdiction: String(originJurisdiction || "").trim() || null,
    destinationJurisdiction: String(destinationJurisdiction || "").trim() || null,
    distanceKm: round(distanceKm, 2),
    weekday,
    bucketStart,
    preCalibrationExpectedMin: round(predicted, 2),
    actualMin: round(actual, 2),
    residualMin: round(residualMin, 2),
    deduplicated: false,
  };
}

function queryResiduals({
  routeHash = null,
  corridorKey = null,
  weekday = null,
  bucketStart = null,
  limit = 100,
}) {
  const where = ["model_version = @modelVersion"];
  const params = { modelVersion: MODEL_VERSION, limit };

  if (routeHash) {
    where.push("route_hash = @routeHash");
    params.routeHash = routeHash;
  }
  if (corridorKey) {
    where.push("corridor_key = @corridorKey");
    params.corridorKey = corridorKey;
  }
  if (weekday !== null && weekday !== undefined) {
    where.push("weekday = @weekday");
    params.weekday = weekday;
  }
  if (bucketStart) {
    where.push("bucket_start = @bucketStart");
    params.bucketStart = bucketStart;
  }

  return db
    .prepare(`
      SELECT residual_min AS residualMin
      FROM eta_actual_observations_v5
      WHERE ${where.join(" AND ")}
      ORDER BY observed_at DESC
      LIMIT @limit
    `)
    .all(params)
    .map((row) => Number(row.residualMin))
    .filter(Number.isFinite);
}

export function getEtaCalibrationCorrection({
  routeHash,
  corridorKey = null,
  departureTime = null,
  preCalibrationExpectedMin,
  date = new Date(),
}) {
  const route = String(routeHash || "").trim();
  const corridor = String(corridorKey || "").trim() || null;
  const predicted = Number(preCalibrationExpectedMin);

  if (!route || !Number.isFinite(predicted) || predicted <= 0) {
    return {
      correctionMin: 0,
      available: false,
      scope: "none",
      sampleCount: 0,
      reason: "missing routeHash or pre-calibration ETA",
    };
  }

  const { weekday, bucketStart } = resolveEtaCalibrationTime({
    departureTime,
    date,
  });

  const tiers = [
    {
      scope: "route+weekday+bucket",
      minSamples: 2,
      shrinkPrior: 2,
      residuals: queryResiduals({
        routeHash: route,
        weekday,
        bucketStart,
        limit: 50,
      }),
    },
    {
      scope: "route",
      minSamples: 4,
      shrinkPrior: 4,
      residuals: queryResiduals({
        routeHash: route,
        limit: 80,
      }),
    },
    ...(corridor
      ? [
          {
            scope: "corridor+weekday+bucket",
            minSamples: 5,
            shrinkPrior: 8,
            residuals: queryResiduals({
              corridorKey: corridor,
              weekday,
              bucketStart,
              limit: 100,
            }),
          },
          {
            scope: "corridor",
            minSamples: 10,
            shrinkPrior: 15,
            residuals: queryResiduals({
              corridorKey: corridor,
              limit: 120,
            }),
          },
        ]
      : []),
  ];

  for (const tier of tiers) {
    const stats = robustResidualStats(tier.residuals);
    if (stats.filteredCount < tier.minSamples) continue;

    const shrink =
      stats.filteredCount / (stats.filteredCount + tier.shrinkPrior);
    const rawCorrection = stats.medianResidualMin * shrink;

    // Empirical, but bounded to prevent one bad trip from destabilizing ETA.
    const maxAbsCorrection = Math.min(
      45,
      Math.max(4, predicted * 0.30)
    );

    const correctionMin = clamp(
      rawCorrection,
      -maxAbsCorrection,
      maxAbsCorrection
    );

    return {
      correctionMin: round(correctionMin, 3),
      available: true,
      scope: tier.scope,
      sampleCount: stats.filteredCount,
      rawSampleCount: stats.sampleCount,
      medianResidualMin: round(stats.medianResidualMin, 3),
      madMin: round(stats.madMin, 3),
      shrinkage: round(shrink, 4),
      weekday,
      bucketStart,
      corridorKey: corridor,
      modelVersion: MODEL_VERSION,
      reason: "robust actual-trip residual learned by exact route, then corridor fallback",
    };
  }

  return {
    correctionMin: 0,
    available: false,
    scope: "none",
    sampleCount: 0,
    weekday,
    bucketStart,
    corridorKey: corridor,
    modelVersion: MODEL_VERSION,
    reason: "not enough actual-trip observations yet",
  };
}

export function getEtaCalibrationSummary({
  routeHash = null,
  corridorKey = null,
} = {}) {
  const where = ["model_version = @modelVersion"];
  const params = { modelVersion: MODEL_VERSION };

  if (routeHash) {
    where.push("route_hash = @routeHash");
    params.routeHash = String(routeHash).trim();
  }
  if (corridorKey) {
    where.push("corridor_key = @corridorKey");
    params.corridorKey = String(corridorKey).trim();
  }

  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sampleCount,
        AVG(residual_min) AS meanResidualMin,
        MIN(observed_at) AS firstObservedAt,
        MAX(observed_at) AS lastObservedAt
      FROM eta_actual_observations_v5
      WHERE ${where.join(" AND ")}
    `)
    .get(params);

  return {
    modelVersion: MODEL_VERSION,
    sampleCount: Number(row?.sampleCount || 0),
    meanResidualMin: round(row?.meanResidualMin, 3),
    firstObservedAt: row?.firstObservedAt || null,
    lastObservedAt: row?.lastObservedAt || null,
  };
}
