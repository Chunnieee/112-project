import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTdxAccessToken } from "./tdxClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep version 1 so already-valid per-bucket cache files remain reusable.
const CACHE_VERSION = 1;
const CACHE_DIR =
  process.env.TDX_HISTORY_CACHE_DIR ||
  path.join(__dirname, "data", "tdx-history-cache");

const HEADER_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.TDX_HISTORY_HEADER_TIMEOUT_MS || 60000)
);

// This is an IDLE timeout, not a total-download timeout. Large historical CSV
// files are allowed to take longer than this overall as long as chunks keep
// arriving. This avoids aborting a healthy 1.5M-row download after 3 minutes.
const STREAM_IDLE_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.TDX_HISTORY_STREAM_IDLE_TIMEOUT_MS || 120000)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  values.push(current);
  return values;
}

function median(values) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function normalizeBucket(timeBucket) {
  const match = String(timeBucket || "").match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    throw new Error(
      `Invalid historical time bucket: ${timeBucket}. Expected HH:00 or HH:30`
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    ![0, 30].includes(minute)
  ) {
    throw new Error(
      `Invalid historical time bucket: ${timeBucket}. Expected HH:00 or HH:30`
    );
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function allBucketKeys() {
  const keys = [];

  for (let hour = 0; hour < 24; hour += 1) {
    const hh = String(hour).padStart(2, "0");
    keys.push(`${hh}:00`, `${hh}:30`);
  }

  return keys;
}

const ALL_BUCKET_KEYS = allBucketKeys();

function bucketFromIsoTime(value) {
  const match = String(value || "").match(/T(\d{2}):(\d{2}):/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${minute < 30 ? "00" : "30"}`;
}

function safeName(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function historicalCacheKey({
  scope = "city",
  city = "",
}) {
  const normalizedScope =
    normalizeHistoricalScope(scope);

  if (normalizedScope === "city") {
    return (
      `City-${String(city || "").trim()}`
    );
  }

  if (normalizedScope === "freeway") {
    return "Freeway";
  }

  return "Highway";
}

function cacheFilePath(
  scope,
  city,
  date,
  timeBucket
) {
  const bucket =
    normalizeBucket(
      timeBucket
    ).replace(":", "");

  const key =
    historicalCacheKey({
      scope,
      city,
    });

  return path.join(
    CACHE_DIR,
    safeName(key),
    `${safeName(date)}-${bucket}.json`
  );
}

async function readCache(
  scope,
  city,
  date,
  timeBucket
) {
const file =
  cacheFilePath(
    scope,
    city,
    date,
    timeBucket
  );

  try {
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text);

    if (
      data?.cacheVersion !== CACHE_VERSION ||
      data?.city !== city ||
      data?.date !== date ||
      data?.timeBucket !== normalizeBucket(timeBucket)
    ) {
      return null;
    }

    return {
      ...data,
      cacheHit: true,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;

    console.log(
      `Historical cache unreadable (${city} ${date} ${timeBucket}):`,
      error.message
    );

    return null;
  }
}

async function writeCache(
  scope,
  city,
  date,
  timeBucket,
  data
) {
  const file =
    cacheFilePath(
      scope,
      city,
      date,
      timeBucket
    );

  await fs.mkdir(path.dirname(file), {
    recursive: true,
  });

  // Atomic-ish write so an interrupted process does not leave half JSON behind.
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;

  await fs.writeFile(
    tempFile,
    JSON.stringify(data),
    "utf8"
  );

  await fs.rename(tempFile, file);
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return 2000;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(1000, seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(1000, dateMs - Date.now());
  }

  return 2000;
}

async function fetchHistoricalCsvOnce(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    HEADER_TIMEOUT_MS
  );

  try {
    // The timer is only for obtaining the HTTP response headers. Once fetch()
    // resolves, the body is governed by a per-chunk idle timeout below.
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/csv",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHistoricalScope(scope) {
  const value =
    String(scope || "city")
      .trim()
      .toLowerCase();

  if (
    value === "city" ||
    value === "freeway" ||
    value === "highway"
  ) {
    return value;
  }

  throw new Error(
    `Unsupported historical scope: ${scope}`
  );
}

function historicalEndpointPath({
  scope,
  city,
}) {
  const normalizedScope =
    normalizeHistoricalScope(scope);

  if (normalizedScope === "city") {
    const cityName =
      String(city || "").trim();

    if (!cityName) {
      throw new Error(
        "Missing historical TDX city"
      );
    }

    return (
      "Historical/Road/Traffic/Live/City/" +
      encodeURIComponent(cityName)
    );
  }

  if (normalizedScope === "freeway") {
    return (
      "Historical/Road/Traffic/Live/Freeway"
    );
  }

  return (
    "Historical/Road/Traffic/Live/Highway"
  );
}

async function openHistoricalCsv({
  scope = "city",
  city = "",
  date,
}) {
  const token =
    await getTdxAccessToken();

  const endpoint =
    historicalEndpointPath({
      scope,
      city,
    });

  const url =
    `https://tdx.transportdata.tw/api/historical/v2/` +
    endpoint +
    `?Dates=${encodeURIComponent(date)}` +
    `&%24format=CSV`;

  let response =
    await fetchHistoricalCsvOnce(
      url,
      token
    );

  if (response.status === 429) {
    const waitMs =
      retryAfterMs(response);

    try {
      await response.body?.cancel();
    } catch {}

    console.log(
      `TDX Historical rate limited; waiting ${Math.ceil(
        waitMs / 1000
      )} sec...`
    );

    await sleep(waitMs);

    response =
      await fetchHistoricalCsvOnce(
        url,
        token
      );
  }

  if (!response.ok) {
    const text =
      await response.text();

    const error =
      new Error(
        `TDX Historical HTTP ${response.status}: ` +
        text.slice(0, 500)
      );

    error.status =
      response.status;

    throw error;
  }

  if (!response.body) {
    throw new Error(
      "TDX Historical response has no body"
    );
  }

  return response;
}

async function readChunkWithIdleTimeout(reader) {
  let timer = null;

  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `TDX Historical stream idle timeout after ${Math.round(
              STREAM_IDLE_TIMEOUT_MS / 1000
            )} sec`
          );
          error.code = "TDX_HISTORY_STREAM_IDLE_TIMEOUT";
          reject(error);
        }, STREAM_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// One network download per city + date. All route alternatives and all
// requested 30-minute buckets join the same Promise.
const historicalDayInFlight = new Map();

// Serialize large Historical downloads so route alternatives do not hammer TDX.
let historicalDownloadTail = Promise.resolve();

function enqueueHistoricalDownload(task) {
  const run = historicalDownloadTail.then(task, task);
  historicalDownloadTail = run.catch(() => {});
  return run;
}

function createBucketAccumulator() {
  return {
    bucketDataRows: 0,
    validDataRows: 0,
    // sectionId -> { seenTimes, speeds, times }
    sections: new Map(),
  };
}

function buildSectionStats(sectionId, accumulator) {
  const speeds = accumulator.speeds;
  const times = accumulator.times;

  return {
    sectionId,
    observationCount: speeds.length,
    medianTravelSpeedKmh: round(median(speeds), 2),
    medianTravelTimeSec: round(median(times), 2),
    minTravelSpeedKmh: round(Math.min(...speeds), 2),
    maxTravelSpeedKmh: round(Math.max(...speeds), 2),
    minTravelTimeSec: round(Math.min(...times), 2),
    maxTravelTimeSec: round(Math.max(...times), 2),
  };
}

function emptyBucketResult({
  scope = "city",
  city,
  date,
  timeBucket,
  totalDataRows,
  createdAt,
}) {
  /*
   * EMPTY_BUCKET_SCOPE_FIX_V1
   *
   * emptyBucketResult previously referenced
   * normalizedScope without defining it.
   */
  const normalizedScope =
    normalizeHistoricalScope(
      scope
    );

  return {
    cacheVersion: CACHE_VERSION,

    scope:
      normalizedScope,

    source:
      normalizedScope === "city"
        ? `TDX Historical Road/Traffic/Live/City/${city} CSV`
        : normalizedScope === "freeway"
          ? "TDX Historical Road/Traffic/Live/Freeway CSV"
          : "TDX Historical Road/Traffic/Live/Highway CSV",
    city,
    date,
    timeBucket,
    totalDataRows,
    bucketDataRows: 0,
    validDataRows: 0,
    sectionCount: 0,
    sections: {},
    createdAt,
    cacheHit: false,
  };
}

async function downloadAndBuildWholeDay({
  scope = "city",
  city = "",
  date,
}) {
    const normalizedScope =
    normalizeHistoricalScope(
      scope
    );
  console.log(
    `[history cache] START DAY ${city} ${date}`
  );

 const response =
  await openHistoricalCsv({
    scope:
      normalizedScope,
    city,
    date,
  });

  console.log(
    `[history cache] STREAM OPEN DAY ${city} ${date}`
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let header = null;
  let indexes = null;
  let totalDataRows = 0;
  let totalValidRows = 0;

  const bucketAccumulators = new Map(
    ALL_BUCKET_KEYS.map((bucket) => [
      bucket,
      createBucketAccumulator(),
    ])
  );

  function processLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) return;

    if (!header) {
      header = parseCsvLine(line);

      indexes = {
        sectionId: header.indexOf("SectionID"),
        travelTime: header.indexOf("TravelTime"),
        travelSpeed: header.indexOf("TravelSpeed"),
        dataCollectTime: header.indexOf("DataCollectTime"),
        infoDate:
  header.indexOf("InfoDate"),
      };

     for (
  const name of [
    "sectionId",
    "travelTime",
    "travelSpeed",
    "dataCollectTime",
  ]
) {
  if (indexes[name] < 0) {
    throw new Error(
      `TDX Historical CSV missing required column: ${name}`
    );
  }
}

      return;
    }

    totalDataRows += 1;

    if (totalDataRows % 250000 === 0) {
      console.log(
        `[history cache] ${city} ${date}: ` +
        `${totalDataRows.toLocaleString()} rows scanned`
      );
    }

    const values = parseCsvLine(line);
    if (
  indexes.infoDate >= 0
) {
  const infoDate =
    String(
      values[
        indexes.infoDate
      ] || ""
    ).trim();

  /*
   * TDX archive occasionally contains
   * a boundary observation belonging
   * to the adjacent calendar day.
   */
  if (
    infoDate &&
    infoDate !== date
  ) {
    return;
  }
}

    const dataCollectTime = String(
      values[indexes.dataCollectTime] || ""
    ).trim();

    const bucket = bucketFromIsoTime(dataCollectTime);
    if (!bucket) return;

    const bucketAccumulator = bucketAccumulators.get(bucket);
    if (!bucketAccumulator) return;

    bucketAccumulator.bucketDataRows += 1;

    const sectionId = String(
      values[indexes.sectionId] || ""
    ).trim();

    const travelTime = Number(
      values[indexes.travelTime]
    );

    const travelSpeed = Number(
      values[indexes.travelSpeed]
    );

    // TDX uses values such as -99 for unavailable observations.
    if (
      !sectionId ||
      !dataCollectTime ||
      !Number.isFinite(travelTime) ||
      travelTime <= 0 ||
      !Number.isFinite(travelSpeed) ||
      travelSpeed <= 0
    ) {
      return;
    }

    let sectionAccumulator =
      bucketAccumulator.sections.get(sectionId);

    if (!sectionAccumulator) {
      sectionAccumulator = {
        seenTimes: new Set(),
        speeds: [],
        times: [],
      };
      bucketAccumulator.sections.set(
        sectionId,
        sectionAccumulator
      );
    }

    // One observation per SectionID + DataCollectTime. Repeated rows do not
    // receive extra statistical weight.
    if (sectionAccumulator.seenTimes.has(dataCollectTime)) {
      return;
    }

    sectionAccumulator.seenTimes.add(dataCollectTime);
    sectionAccumulator.speeds.push(travelSpeed);
    sectionAccumulator.times.push(travelTime);

    bucketAccumulator.validDataRows += 1;
    totalValidRows += 1;
  }

  try {
    while (true) {
      const { done, value } =
        await readChunkWithIdleTimeout(reader);

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true,
      });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }

  buffer += decoder.decode();
  if (buffer) processLine(buffer);

  const createdAt = new Date().toISOString();
  const results = {};

  // A 200 response with no data rows means the archived day is genuinely
  // unavailable. Negative-cache ALL 48 buckets. Network failures/429/timeouts
  // never reach this block, so they are never mistaken for empty archive data.
  if (totalDataRows === 0) {
    for (const timeBucket of ALL_BUCKET_KEYS) {
      results[timeBucket] = {
        ...emptyBucketResult({
          scope:
            normalizedScope,

          city,
          date,
          timeBucket,
          totalDataRows: 0,
          createdAt,
        }),
        unavailable: true,
        negativeCache: true,
      };
    }

    await Promise.all(
      ALL_BUCKET_KEYS.map((timeBucket) =>
        writeCache(
normalizedScope,
  city,
  date,
  timeBucket,
  results[timeBucket]
)
      )
    );

    console.log(
      `[history cache] EMPTY DAY ${city} ${date} — all 48 buckets negative cached`
    );

    return results;
  }

  for (const timeBucket of ALL_BUCKET_KEYS) {
    const bucketAccumulator =
      bucketAccumulators.get(timeBucket);

    const sections = {};

    for (const [sectionId, accumulator] of
      bucketAccumulator.sections.entries()) {
      if (!accumulator.speeds.length || !accumulator.times.length) {
        continue;
      }

      sections[sectionId] = buildSectionStats(
        sectionId,
        accumulator
      );
    }

    results[timeBucket] = {
      cacheVersion: CACHE_VERSION,
      source: "TDX Historical Road/Traffic/Live/City CSV",
      city,
      date,
      timeBucket,
      totalDataRows,
      bucketDataRows:
        bucketAccumulator.bucketDataRows,
      validDataRows:
        bucketAccumulator.validDataRows,
      sectionCount: Object.keys(sections).length,
      sections,
      createdAt,
      cacheHit: false,
    };
  }

  // One completed daily download materializes all 48 half-hour caches.
  await Promise.all(
    ALL_BUCKET_KEYS.map((timeBucket) =>
     writeCache(
normalizedScope,
  city,
  date,
  timeBucket,
  results[timeBucket]
)
    )
  );

  console.log(
    `[history cache] DONE DAY ${city} ${date} | ` +
    `${totalDataRows.toLocaleString()} rows | ` +
    `${totalValidRows.toLocaleString()} valid unique observations | ` +
    `48 buckets cached`
  );

  return results;
}

export async function getHistoricalRoadBucket({
  scope = "city",
  city = "",
  date,
  timeBucket,
  forceRefresh = false,
  cacheOnly = false,
}) {
  const normalizedScope =
    normalizeHistoricalScope(
      scope
    );

  const cityName =
    normalizedScope === "city"
      ? String(
          city || ""
        ).trim()
      : "";

  const dateKey =
    String(
      date || ""
    ).trim();

  const bucket =
    normalizeBucket(
      timeBucket
    );

  if (
    normalizedScope ===
      "city" &&
    !cityName
  ) {
    throw new Error(
      "Missing historical TDX city"
    );
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      dateKey
    )
  ) {
    throw new Error(
      `Invalid historical date: ${dateKey}`
    );
  }

  const cacheLabel =
    historicalCacheKey({
      scope:
        normalizedScope,
      city:
        cityName,
    });

  if (!forceRefresh) {
    const cached =
      await readCache(
        normalizedScope,
        cityName,
        dateKey,
        bucket
      );

    if (cached) {
      console.log(
        `[history cache] HIT ${cacheLabel} ${dateKey} ${bucket}`
      );

      return cached;
    }
  }

  /*
   * Navigation requests must not
   * download large Historical files.
   */
  if (cacheOnly) {
    console.log(
      `[history cache] MISS ${cacheLabel} ${dateKey} ${bucket} (cache-only)`
    );

    return null;
  }

  const flightKey =
    `${normalizedScope}|` +
    `${cityName}|` +
    `${dateKey}`;

  const existingFlight =
    historicalDayInFlight.get(
      flightKey
    );

  if (existingFlight) {
    console.log(
      `[history cache] JOIN DAY ${cacheLabel} ${dateKey} (need ${bucket})`
    );

    const results =
      await existingFlight;

    return (
      results[bucket] ||
      null
    );
  }

  const flight =
    enqueueHistoricalDownload(
      async () => {
        console.log(
          `[history cache] QUEUED DAY DOWNLOAD ${cacheLabel} ${dateKey}`
        );

        return await downloadAndBuildWholeDay({
          scope:
            normalizedScope,

          city:
            cityName,

          date:
            dateKey,
        });
      }
    ).finally(() => {
      historicalDayInFlight.delete(
        flightKey
      );
    });

  historicalDayInFlight.set(
    flightKey,
    flight
  );

  const results =
    await flight;

  return (
    results[bucket] ||
    null
  );
}


/*
 * Backwards compatibility:
 * existing City code can keep
 * calling this function.
 */
export async function getHistoricalCityBucket(
  options
) {
  return getHistoricalRoadBucket({
    ...options,
    scope: "city",
  });
}
export async function getHistoricalSectionStats({
  scope = "city",
  city = "",
  date,
  timeBucket,
  sectionIds,
  cacheOnly = false,
}) {
    const normalizedScope =
    normalizeHistoricalScope(
      scope
    );

  const cityName =
    normalizedScope === "city"
      ? String(
          city || ""
        ).trim()
      : "";
  const ids = [
    ...new Set(
      (sectionIds || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    return {
      city,
      date,
      timeBucket: normalizeBucket(timeBucket),
      cacheHit: false,
      requestedSectionCount: 0,
      matchedSectionCount: 0,
      sections: {},
    };
  }

  const bucket =
  await getHistoricalRoadBucket({
    scope:
      normalizedScope,

    city:
      cityName,

    date,

    timeBucket,

    cacheOnly,
  });

  if (!bucket) {
    return {
      city,
      date,
      timeBucket: normalizeBucket(timeBucket),
      cacheHit: false,
      cacheOnly: true,
      unavailable: true,
      requestedSectionCount: ids.length,
      matchedSectionCount: 0,
      sections: {},
    };
  }

  const sections = {};

  for (const sectionId of ids) {
    if (bucket.sections?.[sectionId]) {
      sections[sectionId] =
        bucket.sections[sectionId];
    }
  }

  return {
    source: bucket.source,
    city: bucket.city,
    date: bucket.date,
    timeBucket: bucket.timeBucket,
    cacheHit: bucket.cacheHit,
    unavailable: Boolean(bucket.unavailable),
    negativeCache: Boolean(bucket.negativeCache),
    requestedSectionCount: ids.length,
    matchedSectionCount:
      Object.keys(sections).length,
    sections,
  };
}