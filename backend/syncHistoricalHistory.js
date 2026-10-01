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


function taipeiDateParts() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const get =
    (type) =>
      parts.find(
        (part) =>
          part.type === type
      )?.value;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}


function dateKeyUtc(date) {
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


function priorDates(count) {
  const {
    year,
    month,
    day,
  } =
    taipeiDateParts();

  const today =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  const dates = [];

  /*
   * Oldest -> newest.
   *
   * Today itself is intentionally excluded
   * because today's Historical archive may
   * not be finalized yet.
   */
  for (
    let i = count;
    i >= 1;
    i -= 1
  ) {
    const d =
      new Date(
        today.getTime() -
        i *
          24 *
          60 *
          60 *
          1000
      );

    dates.push(
      dateKeyUtc(d)
    );
  }

  return dates;
}


function safeName(value) {
  return String(value)
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
}


function cityCacheDir(city) {
  return path.join(
    __dirname,
    "data",
    "tdx-history-cache",
    safeName(city)
  );
}


function bucketCachePath({
  city,
  date,
  bucket = "00:00",
}) {
  return path.join(
    cityCacheDir(city),
    `${safeName(date)}-${bucket.replace(":", "")}.json`
  );
}


/**
 * Inspect one cached bucket only to decide
 * whether the entire day was previously
 * negative-cached.
 */
function inspectDayCache({
  city,
  date,
}) {
  const file =
    bucketCachePath({
      city,
      date,
      bucket: "00:00",
    });

  if (
    !fs.existsSync(file)
  ) {
    return {
      exists: false,
      negative: false,
      unavailable: false,
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

    return {
      exists: true,

      negative:
        Boolean(
          data?.negativeCache
        ),

      unavailable:
        Boolean(
          data?.unavailable
        ),

      sectionCount:
        Number(
          data?.sectionCount ||
          0
        ),
    };
  } catch (error) {
    return {
      exists: true,
      negative: false,
      unavailable: false,
      unreadable: true,
    };
  }
}


/**
 * A failed city-day download creates
 * 48 negative-cache bucket files.
 *
 * For recent dates we intentionally remove
 * those files before retrying TDX so a
 * temporary archive delay does not become
 * permanent.
 */
function removeDayCache({
  city,
  date,
}) {
  const dir =
    cityCacheDir(city);

  if (
    !fs.existsSync(dir)
  ) {
    return 0;
  }

  const prefix =
    `${safeName(date)}-`;

  let removed = 0;

  for (
    const fileName of
    fs.readdirSync(dir)
  ) {
    if (
      !fileName.startsWith(prefix) ||
      !fileName.endsWith(".json")
    ) {
      continue;
    }

    fs.unlinkSync(
      path.join(
        dir,
        fileName
      )
    );

    removed += 1;
  }

  return removed;
}


const city =
  String(
    arg(
      "city",
      "Taipei"
    ) || ""
  ).trim();


const days =
  Math.max(
    1,
    Number(
      arg(
        "days",
        "14"
      )
    ) || 14
  );


const delayMs =
  Math.max(
    0,
    Number(
      arg(
        "delayMs",
        "2000"
      )
    ) || 2000
  );


/*
 * Only retry negative caches inside this
 * recent window.
 *
 * We do NOT repeatedly hammer very old dates
 * that TDX may no longer provide.
 */
const retryNegativeDays =
  Math.max(
    1,
    Number(
      arg(
        "retryNegativeDays",
        "14"
      )
    ) || 14
  );


const dates =
  priorDates(days);


console.log(
  `[history sync] city=${city}`
);

console.log(
  `[history sync] checking ${dates.length} day(s)`
);

console.log(
  `[history sync] retry negative cache within last ${retryNegativeDays} day(s)`
);

console.log(
  `[history sync] ${dates[0]} -> ${dates[dates.length - 1]}`
);


for (
  let index = 0;
  index < dates.length;
  index += 1
) {
  const date =
    dates[index];

  const daysAgo =
    dates.length - index;

  console.log(
    `\n[history sync] ` +
    `[${index + 1}/${dates.length}] ` +
    `${city} ${date}`
  );


  const cacheState =
    inspectDayCache({
      city,
      date,
    });


  /*
   * Positive cache:
   * keep it permanently.
   */
  if (
    cacheState.exists &&
    !cacheState.negative &&
    !cacheState.unavailable &&
    !cacheState.unreadable
  ) {
    console.log(
      `[history sync] positive cache exists, keep ${date}`
    );

    continue;
  }


  /*
   * Negative cache:
   * retry only if date is recent enough.
   */
  if (
    cacheState.exists &&
    (
      cacheState.negative ||
      cacheState.unavailable
    )
  ) {
    if (
      daysAgo <=
      retryNegativeDays
    ) {
      const removed =
        removeDayCache({
          city,
          date,
        });

      console.log(
        `[history sync] removed ${removed} negative-cache file(s) for retry`
      );
    } else {
      console.log(
        `[history sync] old negative cache retained: ${date}`
      );

      continue;
    }
  }


  /*
   * If a cache file is corrupt/unreadable,
   * remove the day's files and rebuild.
   */
  if (
    cacheState.unreadable
  ) {
    const removed =
      removeDayCache({
        city,
        date,
      });

    console.log(
      `[history sync] removed ${removed} unreadable cache file(s)`
    );
  }


  try {
    const result =
      await getHistoricalCityBucket({
        city,
        date,

        /*
         * One city-day download generates
         * all 48 half-hour buckets.
         */
        timeBucket: "00:00",

        cacheOnly: false,
      });


    console.log({
      city:
        result?.city ||
        city,

      date:
        result?.date ||
        date,

      cacheHit:
        Boolean(
          result?.cacheHit
        ),

      unavailable:
        Boolean(
          result?.unavailable
        ),

      negativeCache:
        Boolean(
          result?.negativeCache
        ),
    });
  } catch (error) {
    /*
     * Never stop the entire weekly sync
     * because one date failed.
     */
    console.error(
      `[history sync] failed ${date}:`,
      error.message
    );
  }


  if (
    index <
    dates.length - 1 &&
    delayMs > 0
  ) {
    await sleep(
      delayMs
    );
  }
}


console.log(
  "\n[history sync] finished"
);