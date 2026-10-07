import dotenv from "dotenv";

dotenv.config({
  override: true,
});

const {
  getHistoricalRoadBucket,
} = await import(
  "./historicalTrafficClient.js"
);

/*
 * HISTORICAL_SOURCE_PRELOADER_SAFE_V1
 *
 * Purpose:
 * Preload reusable Historical source/date caches.
 *
 * IMPORTANT:
 * - cache-only check happens FIRST
 * - cached days never trigger another download
 * - remote attempts are capped
 * - one successful daily archive automatically
 *   creates all 48 half-hour buckets
 */

const weeks = Math.max(
  1,
  Number(
    process.env.PRELOAD_WEEKS ||
    8
  )
);

const cities =
  String(
    process.env.PRELOAD_CITIES ||
    "Taipei,NewTaipei"
  )
    .split(",")
    .map(
      value =>
        value.trim()
    )
    .filter(Boolean);

const includeFreeway =
  String(
    process.env.PRELOAD_FREEWAY ||
    "false"
  ).toLowerCase() ===
  "true";

const includeHighway =
  String(
    process.env.PRELOAD_HIGHWAY ||
    "false"
  ).toLowerCase() ===
  "true";

const maxRemoteArchives =
  Math.max(
    0,
    Number(
      process.env
        .PRELOAD_MAX_REMOTE_ARCHIVES ||
      4
    )
  );

const explicitTargetDate =
  String(
    process.env
      .PRELOAD_TARGET_DATE ||
    ""
  ).trim();


function taipeiDateString() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Taipei",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const values =
    Object.fromEntries(
      parts.map(
        part => [
          part.type,
          part.value,
        ]
      )
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}


function parseDate(
  value
) {
  const match =
    String(value).match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    throw new Error(
      `Invalid date: ${value}`
    );
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      12,
      0,
      0
    )
  );
}


function formatDate(
  date
) {
  return [
    date.getUTCFullYear(),

    String(
      date.getUTCMonth() + 1
    ).padStart(
      2,
      "0"
    ),

    String(
      date.getUTCDate()
    ).padStart(
      2,
      "0"
    ),
  ].join("-");
}


function buildSameWeekdayDates(
  targetDate,
  count
) {
  const base =
    parseDate(
      targetDate
    );

  const dates = [];

  for (
    let i = 1;
    i <= count;
    i += 1
  ) {
    const date =
      new Date(
        base.getTime()
      );

    date.setUTCDate(
      date.getUTCDate() -
      7 * i
    );

    dates.push(
      formatDate(
        date
      )
    );
  }

  return dates;
}


const targetDate =
  explicitTargetDate ||
  taipeiDateString();

const dates =
  buildSameWeekdayDates(
    targetDate,
    weeks
  );

const sources =
  cities.map(
    city => ({
      scope:
        "city",

      city,

      label:
        `City-${city}`,
    })
  );

if (
  includeFreeway
) {
  sources.push({
    scope:
      "freeway",

    city:
      "",

    label:
      "Freeway",
  });
}

if (
  includeHighway
) {
  sources.push({
    scope:
      "highway",

    city:
      "",

    label:
      "Highway",
  });
}


console.log("");
console.log(
  "=== SAFE HISTORICAL PRELOADER ==="
);

console.log(
  "Target date:",
  targetDate
);

console.log(
  "Weeks:",
  weeks
);

console.log(
  "Sources:",
  sources.map(
    source =>
      source.label
  )
);

console.log(
  "Remote archive cap:",
  maxRemoteArchives
);

console.log(
  "Potential source/date pairs:",
  sources.length *
  dates.length
);

console.log("");


let cacheHits = 0;
let remoteAttempts = 0;
let remoteSuccess = 0;
let remoteFailed = 0;
let unavailable = 0;

let stop = false;


for (
  const date of
  dates
) {
  if (stop) {
    break;
  }

  console.log(
    `\n========== ${date} ==========`
  );

  for (
    const source of
    sources
  ) {
    /*
     * STEP 1:
     * LOCAL CACHE ONLY.
     *
     * This must never trigger
     * a remote TDX download.
     */
    let result = null;

    try {
      result =
        await getHistoricalRoadBucket({
          scope:
            source.scope,

          city:
            source.city,

          date,

          timeBucket:
            "00:00",

          forceRefresh:
            false,

          cacheOnly:
            true,
        });
    } catch (error) {
      console.log(
        "[preload] CACHE CHECK FAILED",
        {
          source:
            source.label,

          date,

          error:
            error?.message ||
            String(error),
        }
      );
    }


    if (result) {
      cacheHits += 1;

      if (
        result.unavailable ||
        result.negativeCache
      ) {
        unavailable += 1;
      }

      console.log(
        "[preload] CACHE HIT",
        {
          source:
            source.label,

          date,

          unavailable:
            Boolean(
              result.unavailable ||
              result.negativeCache
            ),

          sectionCount:
            Number(
              result.sectionCount ||
              0
            ),
        }
      );

      continue;
    }


    /*
     * STEP 2:
     * Hard stop BEFORE another
     * remote Historical request.
     */
    if (
      remoteAttempts >=
      maxRemoteArchives
    ) {
      console.log("");
      console.log(
        "[preload] REMOTE CAP REACHED"
      );

      console.log({
        remoteAttempts,
        maxRemoteArchives,
        next:
          `${source.label} ${date}`,
      });

      console.log(
        "No more TDX Historical downloads in this run."
      );

      stop = true;
      break;
    }


    /*
     * Count BEFORE request.
     *
     * A failed request can still
     * consume API/network resources,
     * so it counts toward the safety cap.
     */
    remoteAttempts += 1;

    console.log(
      "[preload] REMOTE ATTEMPT",
      {
        attempt:
          remoteAttempts,

        max:
          maxRemoteArchives,

        source:
          source.label,

        date,
      }
    );


    try {
      result =
        await getHistoricalRoadBucket({
          scope:
            source.scope,

          city:
            source.city,

          date,

          /*
           * Requesting one bucket triggers
           * the daily archive build.
           *
           * The client then writes all
           * 48 half-hour buckets.
           */
          timeBucket:
            "00:00",

          forceRefresh:
            false,

          cacheOnly:
            false,
        });

      remoteSuccess += 1;

      if (
        result?.unavailable ||
        result?.negativeCache
      ) {
        unavailable += 1;
      }

      console.log(
        "[preload] REMOTE COMPLETE",
        {
          source:
            source.label,

          date,

          unavailable:
            Boolean(
              result?.unavailable ||
              result?.negativeCache
            ),

          sectionCount:
            Number(
              result?.sectionCount ||
              0
            ),
        }
      );

    } catch (error) {
      remoteFailed += 1;

      console.log(
        "[preload] REMOTE FAILED",
        {
          source:
            source.label,

          date,

          error:
            error?.message ||
            String(error),
        }
      );
    }
  }
}


console.log("");
console.log(
  "=== PRELOAD RUN SUMMARY ==="
);

console.log({
  targetDate,
  weeks,

  sources:
    sources.map(
      source =>
        source.label
    ),

  cacheHits,
  remoteAttempts,
  remoteSuccess,
  remoteFailed,
  unavailable,

  maxRemoteArchives,
});

console.log(
  "Safety cap respected:",
  remoteAttempts <=
    maxRemoteArchives
);
