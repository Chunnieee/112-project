import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "risknav.sqlite");
const MODEL_VERSION = "eta-v3";
const TIME_ZONE = "Asia/Taipei";

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS eta_actual_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_version TEXT NOT NULL DEFAULT '${MODEL_VERSION}',
    route_hash TEXT NOT NULL,
    city TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_eta_actual_route_bucket
  ON eta_actual_observations (
    model_version,
    route_hash,
    weekday,
    bucket_start,
    observed_at
  );

  CREATE INDEX IF NOT EXISTS idx_eta_actual_city_bucket
  ON eta_actual_observations (
    model_version,
    city,
    weekday,
    bucket_start,
    observed_at
  );
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
  const raw = values
    .map(Number)
    .filter(Number.isFinite);

  if (!raw.length) {
    return {
      sampleCount: 0,
      medianResidualMin: 0,
      madMin: null,
      filteredCount: 0,
    };
  }

  const med = median(raw);
  const mad = median(
    raw.map((value) => Math.abs(value - med))
  );

  let filtered = raw;

  if (Number.isFinite(mad) && mad > 0) {
    const robustSigma = mad * 1.4826;
    const maxDeviation = Math.max(2, robustSigma * 3.5);
    filtered = raw.filter(
      (value) => Math.abs(value - med) <= maxDeviation
    );
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

export function calculateHistoricalGapSupplement({
  baseRouterMin,
  liveExpectedMin,
  matchedCoverageRatio,
  historicalMedianMin,
  historicalCoverageRatio,
  historicalSampleCount,
}) {
  const base = Number(baseRouterMin);
  const live = Number(liveExpectedMin);
  const matchedCoverage = clamp(Number(matchedCoverageRatio || 0), 0, 1);
  const historicalMedian = Number(historicalMedianMin);
  const historicalCoverage = clamp(
    Number(historicalCoverageRatio || 0),
    0,
    1
  );
  const samples = Number(historicalSampleCount || 0);

  if (
    !Number.isFinite(base) ||
    !Number.isFinite(live) ||
    !Number.isFinite(historicalMedian) ||
    samples < 8 ||
    historicalCoverage < 0.35
  ) {
    return {
      supplementMin: 0,
      eligible: false,
      reason: "insufficient historical route evidence",
    };
  }

  const historicalDelayMin = Math.max(0, historicalMedian - base);
  const currentLiveDelayMin = Math.max(0, live - base);
  const missingTypicalDelayMin = Math.max(
    0,
    historicalDelayMin - currentLiveDelayMin
  );

  const uncoveredRatio = 1 - matchedCoverage;

  // Historical TDX only fills the CURRENT live-traffic blind spot.
  // It never replaces live traffic and never multiplies the full route.
  const historicalStrength = clamp(historicalCoverage / 0.65, 0, 1);
  const supplementMin =
    missingTypicalDelayMin * uncoveredRatio * historicalStrength;

  return {
    supplementMin: round(supplementMin, 3),
    eligible: true,
    historicalDelayMin: round(historicalDelayMin, 3),
    currentLiveDelayMin: round(currentLiveDelayMin, 3),
    missingTypicalDelayMin: round(missingTypicalDelayMin, 3),
    uncoveredRatio: round(uncoveredRatio, 4),
    historicalStrength: round(historicalStrength, 4),
    reason: "historical same-weekday/time-bucket delay used only on current uncovered share",
  };
}

export function recordEtaActualObservation({
  routeHash,
  city = null,
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
  const predicted = Number(preCalibrationExpectedMin);
  const actual = Number(actualMin);

  if (!route) {
    throw new Error("routeHash is required");
  }

  if (!Number.isFinite(predicted) || predicted <= 0) {
    throw new Error("preCalibrationExpectedMin must be a positive number");
  }

  if (!Number.isFinite(actual) || actual <= 0 || actual > 720) {
    throw new Error("actualMin must be between 0 and 720 minutes");
  }

  const { weekday, bucketStart } = resolveEtaCalibrationTime({
    departureTime,
    date: observedAt,
  });

  const residualMin = actual - predicted;

  const info = db
    .prepare(`
      INSERT INTO eta_actual_observations (
        model_version,
        route_hash,
        city,
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
        @routeHash,
        @city,
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
      routeHash: route,
      city: String(city || "").trim() || null,
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
      effectiveAdjustedCoverageRatio: Number.isFinite(
        Number(effectiveAdjustedCoverageRatio)
      )
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
    routeHash: route,
    city: String(city || "").trim() || null,
    weekday,
    bucketStart,
    preCalibrationExpectedMin: round(predicted, 2),
    actualMin: round(actual, 2),
    residualMin: round(residualMin, 2),
  };
}

function queryResiduals({
  routeHash = null,
  city = null,
  weekday = null,
  bucketStart = null,
  limit = 80,
}) {
  const where = ["model_version = @modelVersion"];
  const params = {
    modelVersion: MODEL_VERSION,
    limit,
  };

  if (routeHash) {
    where.push("route_hash = @routeHash");
    params.routeHash = routeHash;
  }

  if (city) {
    where.push("city = @city");
    params.city = city;
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
      FROM eta_actual_observations
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
  city = null,
  departureTime = null,
  preCalibrationExpectedMin,
  date = new Date(),
}) {
  const route = String(routeHash || "").trim();
  const normalizedCity = String(city || "").trim() || null;
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
      minSamples: 1,
      shrinkPrior: 1.5,
      residuals: queryResiduals({
        routeHash: route,
        weekday,
        bucketStart,
        limit: 40,
      }),
    },
    {
      scope: "route",
      minSamples: 3,
      shrinkPrior: 4,
      residuals: queryResiduals({
        routeHash: route,
        limit: 60,
      }),
    },
    ...(normalizedCity
      ? [
          {
            scope: "city+weekday+bucket",
            minSamples: 8,
            shrinkPrior: 10,
            residuals: queryResiduals({
              city: normalizedCity,
              weekday,
              bucketStart,
              limit: 80,
            }),
          },
          {
            scope: "city",
            minSamples: 15,
            shrinkPrior: 20,
            residuals: queryResiduals({
              city: normalizedCity,
              limit: 100,
            }),
          },
        ]
      : []),
  ];

  for (const tier of tiers) {
    const stats = robustResidualStats(tier.residuals);

    if (stats.filteredCount < tier.minSamples) {
      continue;
    }

    const shrink =
      stats.filteredCount / (stats.filteredCount + tier.shrinkPrior);

    const rawCorrection = stats.medianResidualMin * shrink;

    // Learned correction is empirical, but still bounded against a bad or
    // accidental user observation. The bound is symmetric so the model can
    // learn both optimistic and pessimistic bias.
    const maxAbsCorrection = Math.max(3, predicted * 0.35);
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
      modelVersion: MODEL_VERSION,
      reason: "robust median residual learned from actual trip durations",
    };
  }

  return {
    correctionMin: 0,
    available: false,
    scope: "none",
    sampleCount: 0,
    weekday,
    bucketStart,
    modelVersion: MODEL_VERSION,
    reason: "not enough actual-trip calibration observations yet",
  };
}

export function getEtaCalibrationSummary({
  routeHash = null,
  city = null,
} = {}) {
  const where = ["model_version = @modelVersion"];
  const params = { modelVersion: MODEL_VERSION };

  if (routeHash) {
    where.push("route_hash = @routeHash");
    params.routeHash = String(routeHash).trim();
  }

  if (city) {
    where.push("city = @city");
    params.city = String(city).trim();
  }

  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sampleCount,
        AVG(residual_min) AS meanResidualMin,
        MIN(observed_at) AS firstObservedAt,
        MAX(observed_at) AS lastObservedAt
      FROM eta_actual_observations
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
