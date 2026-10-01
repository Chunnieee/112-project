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

  if (
    !fs.existsSync(file)
  ) {
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
 * Returns previous dates with the same weekday.
 *
 * weekOffset = 1 means previous week.
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


const city =
  String(
    arg(
      "city",
      "Taipei"
    )
  ).trim();


const timeBucket =
  String(
    arg(
      "bucket",
      "22:30"
    )
  ).trim();


const minimumSamples =
  Math.max(
    1,
    Number(
      arg(
        "minimum",
        "8"
      )
    ) || 8
  );


const maxWeeks =
  Math.max(
    minimumSamples,
    Number(
      arg(
        "maxWeeks",
        "26"
      )
    ) || 26
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


const candidates =
  previousSameWeekdayDates(
    maxWeeks
  );


let usableDays = 0;

const usableDates = [];


console.log(
  `[history ensure] ${city} ${timeBucket}`
);

console.log(
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


  console.log(
    `\n[history ensure] week ${i + 1}: ${date}`
  );


  /*
   * Missing cache:
   * download this city-day once.
   */
  if (
    !state.exists
  ) {
    console.log(
      `[history ensure] cache missing, requesting TDX city-day`
    );

    try {
      await getHistoricalCityBucket({
        city,
        date,

        // One request materializes all 48 buckets.
        timeBucket,

        cacheOnly: false,
      });
    } catch (error) {
      console.error(
        `[history ensure] download failed ${date}:`,
        error.message
      );
    }

    state =
      inspectBucket({
        city,
        date,
        timeBucket,
      });

    if (
      delayMs > 0
    ) {
      await sleep(
        delayMs
      );
    }
  }


  if (
    state.usable
  ) {
    usableDays += 1;

    usableDates.push(
      date
    );

    console.log(
      `[history ensure] usable ✅ ` +
      `(${usableDays}/${minimumSamples}) ` +
      `sections=${state.sectionCount}`
    );
  } else {
    console.log(
      `[history ensure] unusable, skip ❌ ` +
      `unavailable=${Boolean(state.unavailable)} ` +
      `negative=${Boolean(state.negativeCache)}`
    );
  }


  /*
   * We only need to backfill until the
   * minimum number of genuinely usable
   * historical weekdays exists.
   */
  if (
    usableDays >=
    minimumSamples
  ) {
    break;
  }
}


console.log(
  "\n[history ensure] finished"
);

console.log({
  usableDays,
  minimumSamples,
  usableDates,
  ready:
    usableDays >=
    minimumSamples,
});