import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  getHistoricalCityBucket,
} from "./historicalTrafficClient.js";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/*
 * Prevent multiple route alternatives from downloading
 * the same city / bucket / target at the same time.
 */
const inFlightEnsures =
  new Map();

function arg(name, fallback = null) {
  const prefix = `--${name}=`;

  const hit =
    process.argv.find(
      (value) =>
        value.startsWith(prefix)
    );

  return hit
    ? hit.slice(prefix.length)
    : fallback;
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function dateKey(date) {
  const yyyy =
    date.getUTCFullYear();

  const mm =
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");

  const dd =
    String(
      date.getUTCDate()
    ).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function taipeiTodayUtc() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const get =
    (type) =>
      Number(
        parts.find(
          (part) =>
            part.type === type
        )?.value
      );

  return new Date(
    Date.UTC(
      get("year"),
      get("month") - 1,
      get("day")
    )
  );
}

function safeName(value) {
  return String(value)
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
}

function cacheFile({
  city,
  date,
  timeBucket,
}) {
  return path.join(
    __dirname,
    "data",
    "tdx-history-cache",
    safeName(city),
    `${date}-${timeBucket.replace(":", "")}.json`
  );
}

function inspectBucket({
  city,
  date,
  timeBucket,
}) {
  const file =
    cacheFile({
      city,
      date,
      timeBucket,
    });

  if (!fs.existsSync(file)) {
    return {
      exists: false,
      usable: false,
    };
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          file,
          "utf8"
        )
      );

    const sectionCount =
      Number(
        data?.sectionCount || 0
      );

    const validDataRows =
      Number(
        data?.validDataRows || 0
      );

    return {
      exists: true,

      usable:
        !data?.unavailable &&
        !data?.negativeCache &&
        sectionCount > 0 &&
        validDataRows > 0,

      sectionCount,
      validDataRows,

      unavailable:
        Boolean(
          data?.unavailable
        ),

      negativeCache:
        Boolean(
          data?.negativeCache
        ),
    };
  } catch {
    return {
      exists: true,
      usable: false,
    };
  }
}

/*
 * Same weekday as today, walking backwards
 * one week at a time.
 *
 * week = 1 => previous week.
 */
function previousSameWeekdayDates(
  maxWeeks
) {
  const today =
    taipeiTodayUtc();

  const dates = [];

  for (
    let week = 1;
    week <= maxWeeks;
    week += 1
  ) {
    const d =
      new Date(
        today.getTime() -
          week *
            7 *
            24 *
            60 *
            60 *
            1000
      );

    dates.push(
      dateKey(d)
    );
  }

  return dates;
}

async function runEnsureHistoricalCoverage({
  city,
  timeBucket,
  minimumSamples,
  maxWeeks,
  delayMs,
  log,
}) {
  const candidates =
    previousSameWeekdayDates(
      maxWeeks
    );

  let usableDays = 0;

  const usableDates = [];

  const say =
    (...values) => {
      if (log) {
        console.log(
          ...values
        );
      }
    };

  say(
    `[history ensure] ${city} ${timeBucket}`
  );

  say(
    `[history ensure] target=${minimumSamples}, maxWeeks=${maxWeeks}`
  );

  for (
    let i = 0;
    i < candidates.length;
    i += 1
  ) {
    const date =
      candidates[i];

    let state =
      inspectBucket({
        city,
        date,
        timeBucket,
      });

    say(
      `\n[history ensure] week ${i + 1}: ${date}`
    );

    /*
     * Only download if this city-day
     * does not already exist locally.
     *
     * One city-day request materializes
     * all 48 half-hour buckets.
     */
    if (!state.exists) {
      say(
        `[history ensure] cache missing, requesting TDX city-day`
      );

      try {
        await getHistoricalCityBucket({
          city,
          date,
          timeBucket,
          cacheOnly: false,
        });
      } catch (error) {
        console.error(
          `[history ensure] download failed ${city} ${date}:`,
          error.message
        );
      }

      state =
        inspectBucket({
          city,
          date,
          timeBucket,
        });

      if (delayMs > 0) {
        await sleep(
          delayMs
        );
      }
    }

    if (state.usable) {
      usableDays += 1;

      usableDates.push(
        date
      );

      say(
        `[history ensure] usable ✅ ` +
          `(${usableDays}/${minimumSamples}) ` +
          `sections=${state.sectionCount}`
      );
    } else {
      say(
        `[history ensure] unusable, skip ❌ ` +
          `unavailable=${Boolean(
            state.unavailable
          )} ` +
          `negative=${Boolean(
            state.negativeCache
          )}`
      );
    }

    if (
      usableDays >=
      minimumSamples
    ) {
      break;
    }
  }

  const result = {
    city,
    timeBucket,
    usableDays,
    minimumSamples,
    usableDates,

    ready:
      usableDays >=
      minimumSamples,
  };

  say(
    `\n[history ensure] finished`
  );

  if (log) {
    console.log(result);
  }

  return result;
}

/*
 * Importable API for server.js.
 *
 * Calls with the same parameters share the same
 * in-flight promise, so Route A/B/C will not all
 * download the same Historical city-day separately.
 */
export async function ensureHistoricalCoverage({
  city = "Taipei",
  timeBucket = "22:30",
  minimumSamples = 8,
  maxWeeks = 26,
  delayMs = 2000,
  log = true,
} = {}) {
  const normalizedCity =
    String(
      city || "Taipei"
    ).trim();

  const normalizedBucket =
    String(
      timeBucket || "22:30"
    ).trim();

  const normalizedMinimum =
    Math.max(
      1,
      Number(
        minimumSamples
      ) || 8
    );

  const normalizedMaxWeeks =
    Math.max(
      normalizedMinimum,
      Number(
        maxWeeks
      ) || 26
    );

  const normalizedDelay =
    Math.max(
      0,
      Number(
        delayMs
      ) || 0
    );

  const key =
    [
      normalizedCity,
      normalizedBucket,
      normalizedMinimum,
      normalizedMaxWeeks,
    ].join("|");

  if (
    inFlightEnsures.has(key)
  ) {
    if (log) {
      console.log(
        `[history ensure] join existing job ${key}`
      );
    }

    return inFlightEnsures.get(
      key
    );
  }

  const promise =
    runEnsureHistoricalCoverage({
      city:
        normalizedCity,

      timeBucket:
        normalizedBucket,

      minimumSamples:
        normalizedMinimum,

      maxWeeks:
        normalizedMaxWeeks,

      delayMs:
        normalizedDelay,

      log,
    }).finally(() => {
      inFlightEnsures.delete(
        key
      );
    });

  inFlightEnsures.set(
    key,
    promise
  );

  return promise;
}

/*
 * Keep the old CLI behavior.
 *
 * Example:
 * node ensureHistoricalCoverage.js \
 *   --city=Taipei \
 *   --bucket=22:30 \
 *   --minimum=8 \
 *   --maxWeeks=26
 */
const runningAsCli =
  process.argv[1] &&
  path.resolve(
    process.argv[1]
  ) === __filename;

if (runningAsCli) {
  await ensureHistoricalCoverage({
    city:
      arg(
        "city",
        "Taipei"
      ),

    timeBucket:
      arg(
        "bucket",
        "22:30"
      ),

    minimumSamples:
      Number(
        arg(
          "minimum",
          "8"
        )
      ),

    maxWeeks:
      Number(
        arg(
          "maxWeeks",
          "26"
        )
      ),

    delayMs:
      Number(
        arg(
          "delayMs",
          "2000"
        )
      ),

    log: true,
  });
}