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

function cacheFilePath(city, date, timeBucket) {
  const bucket = normalizeBucket(timeBucket).replace(":", "");

  return path.join(
    CACHE_DIR,
    safeName(city),
    `${safeName(date)}-${bucket}.json`
  );
}

async function readCache(city, date, timeBucket) {
  const file = cacheFilePath(city, date, timeBucket);

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

async function writeCache(city, date, timeBucket, data) {
  const file = cacheFilePath(city, date, timeBucket);

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

async function openHistoricalCsv({ city, date }) {
  const token = await getTdxAccessToken();

  const url =
    `https://tdx.transportdata.tw/api/historical/v2/` +
    `Historical/Road/Traffic/Live/City/${encodeURIComponent(city)}` +
    `?Dates=${encodeURIComponent(date)}&%24format=CSV`;

  let response = await fetchHistoricalCsvOnce(url, token);

  // Historical files are very large. Respect Retry-After and retry 429 once.
  if (response.status === 429) {
    const waitMs = retryAfterMs(response);

    try {
      await response.body?.cancel();
    } catch {}

    console.log(
      `TDX Historical rate limited; waiting ${Math.ceil(waitMs / 1000)} sec...`
    );

    await sleep(waitMs);
    response = await fetchHistoricalCsvOnce(url, token);
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(
      `TDX Historical HTTP ${response.status}: ${text.slice(0, 500)}`
    );
    error.status = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error("TDX Historical response has no body");
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

function emptyBucketResult({ city, date, timeBucket, totalDataRows, createdAt }) {
  return {
    cacheVersion: CACHE_VERSION,
    source: "TDX Historical Road/Traffic/Live/City CSV",
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

async function downloadAndBuildWholeDay({ city, date }) {
  console.log(
    `[history cache] START DAY ${city} ${date}`
  );

  const response = await openHistoricalCsv({
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
      };

      for (const [name, index] of Object.entries(indexes)) {
        if (index < 0) {
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

export async function getHistoricalCityBucket({
  city,
  date,
  timeBucket,
  forceRefresh = false,
  cacheOnly = false,
}) {
  const cityName = String(city || "").trim();
  const dateKey = String(date || "").trim();
  const bucket = normalizeBucket(timeBucket);

  if (!cityName) {
    throw new Error("Missing historical TDX city");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(
      `Invalid historical date: ${dateKey}`
    );
  }

  if (!forceRefresh) {
    const cached = await readCache(
      cityName,
      dateKey,
      bucket
    );

    if (cached) {
      console.log(
        `[history cache] HIT ${cityName} ${dateKey} ${bucket}`
      );
      return cached;
    }
  }

  // Strict cache-only callers (navigation) return immediately on a miss.
  // They do not start OR wait for any remote Historical download.
  if (cacheOnly) {
    console.log(
      `[history cache] MISS ${cityName} ${dateKey} ${bucket} (cache-only)`
    );
    return null;
  }

  const flightKey =
    `${cityName}|${dateKey}`;

  const existingFlight =
    historicalDayInFlight.get(flightKey);

  // Joining an already-running day download does not create another TDX call.
  if (existingFlight) {
    console.log(
      `[history cache] JOIN DAY ${cityName} ${dateKey} (need ${bucket})`
    );

    const results = await existingFlight;
    return results[bucket] || null;
  }

  const flight =
    enqueueHistoricalDownload(
      async () => {
        console.log(
          `[history cache] QUEUED DAY DOWNLOAD ${cityName} ${dateKey}`
        );

        return await downloadAndBuildWholeDay({
          city: cityName,
          date: dateKey,
        });
      }
    ).finally(() => {
      historicalDayInFlight.delete(flightKey);
    });

  historicalDayInFlight.set(
    flightKey,
    flight
  );

  const results = await flight;
  return results[bucket] || null;
}

export async function getHistoricalSectionStats({
  city,
  date,
  timeBucket,
  sectionIds,
  cacheOnly = false,
}) {
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

  const bucket = await getHistoricalCityBucket({
    city,
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