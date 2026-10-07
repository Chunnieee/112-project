import {
  getOfflineJurisdictionStatus,
  resolveTaiwanJurisdictionOffline,
} from "./taiwanJurisdictionOfflineV7_1.js";

// RiskNav V7 route-jurisdiction resolver.
// Goal: make jurisdiction discovery resilient without inventing geography.
// - bounded concurrency to avoid hammering reverse geocoder
// - retry only transient failures
// - positive-only TTL cache (never poison cache with null/503)
// - ordered jurisdiction sequence with re-entry preserved
// - no rectangle/bounding-box guessing

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const positiveCache = new Map();
const providerCircuit = {
  failureStreak: 0,
  openUntil: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanPoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function cacheKey(point) {
  return `${Number(point.lat).toFixed(4)},${Number(point.lon).toFixed(4)}`;
}

function cacheGet(point, nowMs = Date.now()) {
  const key = cacheKey(point);
  const item = positiveCache.get(key);
  if (!item) return null;
  if (Number(item.expiresAt || 0) <= nowMs) {
    positiveCache.delete(key);
    return null;
  }
  return item;
}

function cacheSet(point, value, jurisdiction, ttlMs = DEFAULT_TTL_MS) {
  if (!value || !jurisdiction) return;
  positiveCache.set(cacheKey(point), {
    value,
    jurisdiction,
    expiresAt: Date.now() + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS),
  });
}

export function resetRouteJurisdictionCache() {
  positiveCache.clear();
  providerCircuit.failureStreak = 0;
  providerCircuit.openUntil = 0;
}

function statusFromError(error) {
  const direct = Number(error?.status || error?.statusCode);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(error?.message || error || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function isTransient(error) {
  const status = statusFromError(error);
  if (status === 429) return true;
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  const text = String(error?.message || error || "").toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("abort") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("econn")
  );
}

export function routeJurisdictionSamplePoints(route, maxSamples = 12) {
  const coordinates = Array.isArray(route?.geometry?.coordinates)
    ? route.geometry.coordinates
    : [];
  if (!coordinates.length) return [];

  const sampleCount = Math.max(1, Math.min(Number(maxSamples) || 12, coordinates.length));
  const sampled = [];
  const seen = new Set();

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = sampleCount === 1 ? 0 : i / (sampleCount - 1);
    const index = Math.round(ratio * (coordinates.length - 1));
    const [lonRaw, latRaw] = coordinates[index] || [];
    const point = cleanPoint({ lat: latRaw, lon: lonRaw });
    if (!point) continue;
    const key = cacheKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    sampled.push({ ...point, sampleIndex: sampled.length, geometryIndex: index });
  }

  return sampled;
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(items.length || 1, Number(limit) || 1));

  async function runner() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: count }, () => runner()));
  return out;
}

async function resolveOne({
  point,
  reverseGeocodeCoordinate,
  resolveJurisdictionFromReverse,
  retries = 2,
  cacheTtlMs = DEFAULT_TTL_MS,
  offlineFallback = true,
}) {
  const cached = cacheGet(point);
  if (cached) {
    return {
      point,
      reverse: cached.value,
      jurisdiction: cached.jurisdiction,
      source: "cache",
      attempts: 0,
      providerFailedBeforeFallback: false,
      circuitSkippedProvider: false,
      error: null,
    };
  }

  const offlineResolve = (source, extra = {}) => {
    if (!offlineFallback) return null;
    const offline = resolveTaiwanJurisdictionOffline(point);
    if (!offline?.jurisdiction) return null;
    const syntheticReverse = {
      lat: point.lat,
      lon: point.lon,
      tdxCity: offline.jurisdiction,
      source: "Offline Taiwan administrative boundary",
    };
    cacheSet(point, syntheticReverse, offline.jurisdiction, cacheTtlMs);
    return {
      point,
      reverse: syntheticReverse,
      jurisdiction: offline.jurisdiction,
      source,
      attempts: Number(extra.attempts || 0),
      providerFailedBeforeFallback: Boolean(extra.providerFailedBeforeFallback),
      circuitSkippedProvider: Boolean(extra.circuitSkippedProvider),
      error: extra.error || null,
    };
  };

  /*
   * OFFLINE_JURISDICTION_FIRST_V1
   *
   * Taiwan jurisdiction is first resolved from the local
   * administrative boundary dataset.
   *
   * Photon reverse geocoding is now fallback-only:
   * it runs only when the local boundary dataset cannot
   * classify the coordinate.
   *
   * This changes jurisdiction lookup order only.
   * It does NOT modify routing, TDX matching, or ETA.
   */
  const offlinePrimary =
    offlineResolve(
      "offline_boundary_primary",
      {
        attempts: 0,
        providerFailedBeforeFallback: false,
        circuitSkippedProvider: false,
      }
    );

  if (offlinePrimary) {
    return offlinePrimary;
  }


  // Circuit breaker: once repeated final provider failures prove Photon is
  // unavailable, stop hammering it for every sample and resolve locally.
  if (providerCircuit.openUntil > Date.now()) {
    const offline = offlineResolve("offline_boundary_circuit", {
      attempts: 0,
      providerFailedBeforeFallback: true,
      circuitSkippedProvider: true,
    });
    if (offline) return offline;
  }

  let lastError = null;
  let attemptsMade = 0;
  const maxAttempts = Math.max(1, Number(retries) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attemptsMade = attempt + 1;
    try {
      const reverse = await reverseGeocodeCoordinate({
        lat: point.lat,
        lon: point.lon,
      });
      const jurisdiction = resolveJurisdictionFromReverse(reverse);

      if (reverse && jurisdiction) {
        providerCircuit.failureStreak = 0;
        providerCircuit.openUntil = 0;
        cacheSet(point, reverse, jurisdiction, cacheTtlMs);
        return {
          point,
          reverse,
          jurisdiction,
          source: attempt > 0 ? "reverse_retry" : "reverse",
          attempts: attempt + 1,
          providerFailedBeforeFallback: false,
          circuitSkippedProvider: false,
          error: null,
        };
      }

      // Provider answered but did not classify the point. Local boundary data
      // is allowed to fill the administrative identity without guessing.
      const offline = offlineResolve("offline_boundary_unclassified", {
        attempts: attempt + 1,
      });
      if (offline) return offline;

      return {
        point,
        reverse: reverse || null,
        jurisdiction: null,
        source: "reverse_unclassified",
        attempts: attempt + 1,
        providerFailedBeforeFallback: false,
        circuitSkippedProvider: false,
        error: null,
      };
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt >= maxAttempts - 1) break;
      await sleep(180 * (2 ** attempt));
    }
  }

  if (isTransient(lastError)) {
    providerCircuit.failureStreak += 1;
    if (providerCircuit.failureStreak >= 2) {
      providerCircuit.openUntil = Date.now() + 60_000;
    }
  }

  const offline = offlineResolve("offline_boundary_after_reverse_failure", {
    attempts: attemptsMade,
    providerFailedBeforeFallback: true,
    error: lastError,
  });
  if (offline) return offline;

  return {
    point,
    reverse: null,
    jurisdiction: null,
    source: "reverse_failed",
    attempts: attemptsMade,
    providerFailedBeforeFallback: true,
    circuitSkippedProvider: false,
    error: lastError,
  };
}

function collapseConsecutive(values) {
  const out = [];
  for (const value of values) {
    if (!value) continue;
    if (out[out.length - 1] !== value) out.push(value);
  }
  return out;
}

export async function resolveRouteJurisdictions({
  route,
  reverseGeocodeCoordinate,
  resolveJurisdictionFromReverse,
  maxSamples = 12,
  concurrency = 2,
  retries = 2,
  cacheTtlMs = DEFAULT_TTL_MS,
  offlineFallback = process.env.TDX_OFFLINE_JURISDICTION !== "0",
} = {}) {
  if (typeof reverseGeocodeCoordinate !== "function") {
    throw new Error("reverseGeocodeCoordinate function is required");
  }
  if (typeof resolveJurisdictionFromReverse !== "function") {
    throw new Error("resolveJurisdictionFromReverse function is required");
  }

  const points = routeJurisdictionSamplePoints(route, maxSamples);
  if (!points.length) {
    return {
      jurisdictions: [],
      samples: [],
      diagnostics: {
        sampleCount: 0,
        resolvedCount: 0,
        successRatio: 0,
        cacheHits: 0,
        retryResolved: 0,
        failedCount: 0,
        providerFailureCount: 0,
        status: "no_route_geometry",
      },
    };
  }

  // Process endpoints first, then interior points. Endpoints materially affect
  // corridor identity, while bounded concurrency prevents Photon 503 storms.
  const taskOrder = [];
  if (points.length) taskOrder.push(0);
  if (points.length > 1) taskOrder.push(points.length - 1);
  for (let i = 1; i < points.length - 1; i += 1) taskOrder.push(i);

  const orderedTasks = taskOrder.map((pointIndex) => ({ pointIndex, point: points[pointIndex] }));
  const taskResults = await mapWithConcurrency(
    orderedTasks,
    concurrency,
    (task) => resolveOne({
      point: task.point,
      reverseGeocodeCoordinate,
      resolveJurisdictionFromReverse,
      retries,
      cacheTtlMs,
      offlineFallback,
    })
  );

  const samples = new Array(points.length).fill(null);
  for (let i = 0; i < orderedTasks.length; i += 1) {
    samples[orderedTasks[i].pointIndex] = taskResults[i];
  }

  const jurisdictions = collapseConsecutive(samples.map((item) => item?.jurisdiction || null));
  const resolvedCount = samples.filter((item) => item?.jurisdiction).length;
  const failed = samples.filter((item) => !item?.jurisdiction);
  const providerFailures = samples.filter((item) => item?.providerFailedBeforeFallback);
  const offlineResolved = samples.filter((item) =>
    String(item?.source || "").startsWith("offline_boundary")
  ).length;
  const reverseResolved = samples.filter((item) =>
    item?.source === "reverse" || item?.source === "reverse_retry"
  ).length;
  const circuitSkippedProvider = samples.filter((item) => item?.circuitSkippedProvider).length;
  const offlineStatus = getOfflineJurisdictionStatus();

  return {
    jurisdictions,
    samples,
    diagnostics: {
      sampleCount: samples.length,
      resolvedCount,
      successRatio: samples.length ? resolvedCount / samples.length : 0,
      cacheHits: samples.filter((item) => item?.source === "cache").length,
      offlineResolved,
      reverseResolved,
      offlineBoundaryLoaded: offlineStatus.loaded,
      offlineBoundaryFeatureCount: offlineStatus.featureCount,
      offlineBoundaryError: offlineStatus.error,
      circuitSkippedProvider,
      providerCircuitOpen: providerCircuit.openUntil > Date.now(),
      retryResolved: samples.filter((item) => item?.source === "reverse_retry").length,
      failedCount: failed.length,
      providerFailureCount: providerFailures.length,
      status:
        resolvedCount === samples.length
          ? "complete"
          : resolvedCount > 0
            ? "partial"
            : providerFailures.length
              ? "provider_unavailable"
              : "unresolved",
      failures: failed.slice(0, 8).map((item) => ({
        point: item?.point || null,
        source: item?.source || "unknown",
        status: statusFromError(item?.error),
        message: item?.error?.message || null,
      })),
    },
  };
}
