import "dotenv/config";
import {
  getHistoricalSectionStats,
} from "./historicalTrafficClient.js";
import {
  upsertHistoricalObservation,
  getHistoricalObservations,
} from "./historicalDb.js";

function envInteger(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.floor(value)
  );
}

const MIN_UNIQUE_DAYS = envInteger(
  "RISK_MIN_UNIQUE_DAYS",
  8,
  3
);

const LOOKBACK_WEEKS = Math.max(
  MIN_UNIQUE_DAYS,
  envInteger(
    "RISK_HISTORY_LOOKBACK_WEEKS",
    26,
    MIN_UNIQUE_DAYS
  )
);

console.log(
  `[risk history] config: minimum=${MIN_UNIQUE_DAYS} unique days, lookback=${LOOKBACK_WEEKS} weeks, mode=cache-only`
);
console.log(
  `[risk history] navigation requests will never download TDX Historical data`
);

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function taipeiCurrentParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(new Date());

  const map = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ])
  );

  return {
    dateKey:
      `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function resolveTimeBucket(
  departureTime,
  currentHour,
  currentMinute
) {
  let hour = currentHour;
  let minute = currentMinute;

  const match = String(
    departureTime || ""
  ).match(/^(\d{1,2}):(\d{2})$/);

  if (match) {
    const requestedHour =
      Number(match[1]);

    const requestedMinute =
      Number(match[2]);

    if (
      Number.isInteger(requestedHour) &&
      requestedHour >= 0 &&
      requestedHour <= 23 &&
      Number.isInteger(requestedMinute) &&
      requestedMinute >= 0 &&
      requestedMinute <= 59
    ) {
      hour = requestedHour;
      minute = requestedMinute;
    }
  }

  return (
    `${String(hour).padStart(2, "0")}:` +
    `${minute < 30 ? "00" : "30"}`
  );
}

function shiftDateKey(
  dateKey,
  deltaDays
) {
  const match = String(
    dateKey
  ).match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    throw new Error(
      `Invalid dateKey: ${dateKey}`
    );
  }

  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]) +
        Number(deltaDays || 0)
    )
  );

  return (
    `${date.getUTCFullYear()}-` +
    `${String(
      date.getUTCMonth() + 1
    ).padStart(2, "0")}-` +
    `${String(
      date.getUTCDate()
    ).padStart(2, "0")}`
  );
}

function priorSameWeekdayDates(
  referenceDateKey,
  count
) {
  const result = [];

  for (
    let week = 1;
    week <= count;
    week += 1
  ) {
    result.push(
      shiftDateKey(
        referenceDateKey,
        -7 * week
      )
    );
  }

  return result;
}

function nearestRank(
  sorted,
  probability
) {
  if (!sorted.length) {
    return null;
  }

  const index = Math.min(
    sorted.length - 1,
    Math.max(
      0,
      Math.ceil(
        probability *
          sorted.length
      ) - 1
    )
  );

  return sorted[index];
}

function empiricalStats(values) {
  const sorted = values
    .filter(Number.isFinite)
    .sort(
      (a, b) => a - b
    );

  if (!sorted.length) {
    return null;
  }

  const mean =
    sorted.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / sorted.length;

  const variance =
    sorted.length > 1
      ? sorted.reduce(
          (sum, value) =>
            sum +
            (value - mean) ** 2,
          0
        ) /
        (sorted.length - 1)
      : 0;

  const sd =
    Math.sqrt(variance);

  return {
    meanMin:
      round(mean, 1),

    medianMin:
      round(
        nearestRank(
          sorted,
          0.5
        ),
        1
      ),

    p10Min:
      round(
        nearestRank(
          sorted,
          0.1
        ),
        1
      ),

    p90Min:
      round(
        nearestRank(
          sorted,
          0.9
        ),
        1
      ),

    p95Min:
      round(
        nearestRank(
          sorted,
          0.95
        ),
        1
      ),

    variance:
      round(
        variance,
        2
      ),

    standardDeviationMin:
      round(
        sd,
        1
      ),

    coefficientOfVariation:
      mean > 0
        ? round(
            sd / mean,
            3
          )
        : null,
  };
}

function cleanMatchedSections(
  matchedCitySections
) {
  return (
    matchedCitySections || []
  )
    .map((item) => ({
      city:
        String(
          item?.city || ""
        ).trim(),

      sectionId:
        String(
          item?.sectionId || ""
        ).trim(),

      matchedDistanceKm:
        Number(
          item?.matchedDistanceKm
        ),

      sectionLengthKm:
        Number(
          item?.sectionLengthKm
        ),
    }))
    .filter(
      (item) =>
        item.city &&
        item.sectionId &&
        Number.isFinite(
          item.matchedDistanceKm
        ) &&
        item.matchedDistanceKm >
          0
    );
}

function groupSectionsByCity(
  sections
) {
  const grouped =
    new Map();

  for (
    const section of sections
  ) {
    if (
      !grouped.has(
        section.city
      )
    ) {
      grouped.set(
        section.city,
        []
      );
    }

    grouped
      .get(section.city)
      .push(section);
  }

  return grouped;
}

function historicalSpeedForSection(
  routeSection,
  historicalSection
) {
  const historicalTravelTime =
    Number(
      historicalSection
        ?.medianTravelTimeSec
    );

  const sectionLengthKm =
    Number(
      routeSection
        ?.sectionLengthKm
    );

  // Mirror the live ETA policy:
  // prefer a speed derived from
  // TDX TravelTime when the
  // full section length is known.
  if (
    Number.isFinite(
      historicalTravelTime
    ) &&
    historicalTravelTime >
      0 &&
    Number.isFinite(
      sectionLengthKm
    ) &&
    sectionLengthKm > 0
  ) {
    const speed =
      sectionLengthKm /
      (
        historicalTravelTime /
        3600
      );

    if (
      Number.isFinite(speed) &&
      speed >= 1 &&
      speed <= 160
    ) {
      return speed;
    }
  }

  const historicalSpeed =
    Number(
      historicalSection
        ?.medianTravelSpeedKmh
    );

  if (
    Number.isFinite(
      historicalSpeed
    ) &&
    historicalSpeed >= 1 &&
    historicalSpeed <= 160
  ) {
    return historicalSpeed;
  }

  return null;
}

function emptyRiskResult({
  sampleCount,
  weekday,
  timeBucket,
  sampleDates,
  attemptedDates,
  historicalAverageCoverage,
}) {
  return {
    riskStatus:
      "insufficient_data",

    sampleCount,

    minRequiredUniqueDays:
      MIN_UNIQUE_DAYS,

    lookbackWeeks:
      LOOKBACK_WEEKS,

    weekday,
    timeBucket,

    worst10Min: null,
    worst5Min: null,
    variance: null,
    varianceLabel: null,
    likelyRangeMin: null,

    standardDeviationMin:
      null,

    coefficientOfVariation:
      null,

    stabilityScore: null,
    stabilityLevel: null,

    historicalMeanMin:
      null,

    historicalMedianMin:
      null,

    historicalAverageTdxCoverageRatio:
      historicalAverageCoverage,

    sampleDates,
    attemptedDates,

    historicalScope:
      "TDX Historical city road sections only; historical freeway/highway archive is not yet included.",

    riskDataSource:
      "TDX Historical Road/Traffic/Live/City observations; uncovered historical road portions remain OSRM baseline; no guessed multiplier.",
  };
}

export async function assessHistoricalRisk({
  baseOsrmMin,
  routeDistanceKm,

  routeHash = null,
  routingEngine = "unknown",

  matchedCitySections,
  departureTime = null,
}) {
  const baseMin =
    Number(baseOsrmMin);

  const distanceKm =
    Number(routeDistanceKm);

  const current =
    taipeiCurrentParts();

  const timeBucket =
    resolveTimeBucket(
      departureTime,
      current.hour,
      current.minute
    );

  const sections =
    cleanMatchedSections(
      matchedCitySections
    );

  if (
    !Number.isFinite(baseMin) ||
    baseMin <= 0 ||
    !Number.isFinite(
      distanceKm
    ) ||
    distanceKm <= 0 ||
    !sections.length
  ) {
    return emptyRiskResult({
      sampleCount: 0,
      weekday:
        current.weekday,
      timeBucket,
      sampleDates: [],
      attemptedDates: [],
      historicalAverageCoverage:
        null,
    });
  }

  const grouped =
    groupSectionsByCity(
      sections
    );

  const baseSec =
    baseMin * 60;

  const baseSecPerKm =
    baseSec / distanceKm;

  const candidateDates =
    priorSameWeekdayDates(
      current.dateKey,
      LOOKBACK_WEEKS
    );

  const oldestCandidateDate =
  candidateDates.length
    ? candidateDates[
        candidateDates.length - 1
      ]
    : null;


// ============================================================
// 1. FIRST: load already-persisted observations from SQLite
// ============================================================

let samples = [];

if (routeHash) {
  try {
    const storedObservations =
      getHistoricalObservations({
        routeHash,

        routingEngine,

        modelVersion: "v1",

        weekday:
          current.weekday,

        bucketStart:
          timeBucket,

        beforeDate:
          current.dateKey,

        afterDate:
          oldestCandidateDate,

        // We keep more than the minimum in the DB.
        // 26 same-weekday observations = 26 weeks.
        limit:
          LOOKBACK_WEEKS,
      });

    samples =
      storedObservations
        .filter(
          (row) =>
            Number.isFinite(
              Number(
                row.historicalEtaSec
              )
            ) &&
            Number(
              row.historicalEtaSec
            ) > 0
        )
        .map(
          (row) => ({
            date:
              row.observationDate,

            etaMin:
              Number(
                row.historicalEtaSec
              ) / 60,

            coverageRatio:
              Number(
                row.coverageRatio ??
                0
              ),

            matchedDistanceKm:
              Number(
                row.matchedDistanceM ??
                0
              ) / 1000,

            matchedSectionCount:
              Number(
                row.matchedSectionCount ??
                0
              ),
          })
        );

    console.log(
      `[risk db] loaded ${samples.length} stored sample(s) ` +
      `for ${timeBucket}`
    );
  } catch (error) {
    console.warn(
      "[risk db] failed to load stored observations:",
      error.message
    );

    samples = [];
  }
}


const attemptedDates = [];

const storedDates =
  new Set(
    samples.map(
      (sample) =>
        sample.date
    )
  );

  for (
  const date of candidateDates
) {
  /*
   * This date is already persisted for
   * exactly this route + weekday + bucket.
   * Do not reconstruct it from cache again.
   */
  if (
    storedDates.has(date)
  ) {
    continue;
  }

  /*
   * If SQLite already satisfies the minimum,
   * there is no reason to scan more cache files.
   */


  attemptedDates.push(date);

  let totalDeltaSec = 0;

    let matchedDistanceKm = 0;

    let matchedSectionCount = 0;

    // If any city's Historical fetch fails (timeout/429/network), skip the
    // entire date. A transport failure must never masquerade as low coverage.
    let dateFetchFailed = false;

    for (
      const [
        city,
        routeSections,
      ] of grouped.entries()
    ) {
      let historical;

      try {
        historical =
          await getHistoricalSectionStats(
            {
              city,
              date,
              timeBucket,

              sectionIds:
                routeSections.map(
                  (section) =>
                    section.sectionId
                ),

              // Navigation must NEVER trigger a Historical download.
              // Missing cache stays missing and is reported as insufficient data.
              cacheOnly: true,
            }
          );
      } catch (error) {
        console.log(
          `[risk history] ${city} ${date} ${timeBucket} fetch failed:`,
          error.message
        );

        dateFetchFailed = true;
        break;
      }
let requestedSectionCount =
  routeSections.length;

let historicalFoundCount = 0;

let validSpeedCount = 0;

let matchedDistanceThisCityKm = 0;

const missingSectionIds = [];
      for (
        const routeSection of
        routeSections
      ) {
        const historicalSection =
          historical.sections?.[
            routeSection
              .sectionId
          ];

       if (
  !historicalSection
) {
  missingSectionIds.push(
    routeSection.sectionId
  );

  continue;
}

historicalFoundCount += 1;

        const speed =
          historicalSpeedForSection(
            routeSection,
            historicalSection
          );

        if (
          !Number.isFinite(
            speed
          ) ||
          speed <= 0
        ) {
          continue;
        }
        validSpeedCount += 1;

        const distance =
          routeSection
            .matchedDistanceKm;
            matchedDistanceThisCityKm +=
  Number(distance || 0);

        const observedSec =
          (
            distance /
            speed
          ) * 3600;

        const baselineSec =
          distance *
          baseSecPerKm;

        if (
          !Number.isFinite(
            observedSec
          ) ||
          observedSec <= 0 ||
          !Number.isFinite(
            baselineSec
          ) ||
          baselineSec < 0
        ) {
          continue;
        }

        totalDeltaSec +=
          observedSec -
          baselineSec;

        matchedDistanceKm +=
          distance;

        matchedSectionCount +=
          1;
      }
      console.log(
  `[risk debug] ${city} ${date} ${timeBucket} | ` +
  `requested=${requestedSectionCount}, ` +
  `historicalFound=${historicalFoundCount}, ` +
  `validSpeed=${validSpeedCount}, ` +
  `matchedKm=${matchedDistanceThisCityKm.toFixed(3)}, ` +
  `missing=${missingSectionIds.length}`
);

if (
  missingSectionIds.length > 0
) {
  console.log(
    `[risk debug] missing SectionIDs:`,
    missingSectionIds.slice(0, 10)
  );
}
    }

    if (dateFetchFailed) {
      console.log(
        `[risk history] ${date} ${timeBucket}: skipped because Historical fetch failed`
      );
      continue;
    }

    if (
      matchedDistanceKm <= 0
    ) {
      console.log(
        `[risk history] ${date} ${timeBucket}: no matched historical route sections`
      );

      continue;
    }

    const historicalRouteSec =
      baseSec +
      totalDeltaSec;

    if (
      !Number.isFinite(
        historicalRouteSec
      ) ||
      historicalRouteSec <= 0
    ) {
      continue;
    }

    const coverageRatio =
      clamp(
        matchedDistanceKm /
          distanceKm,
        0,
        1
      );

    const sample = {
  date,

  etaMin:
    historicalRouteSec /
    60,

  coverageRatio,

  matchedDistanceKm,

  matchedSectionCount,
};

samples.push(sample);


/*
 * Persist the exact route-level historical
 * observation that was already accepted by
 * the risk engine.
 *
 * Database persistence must NOT change the
 * statistical result.
 */
if (routeHash) {
  try {
    const matchedBaselineSec =
      baseSecPerKm *
      matchedDistanceKm;

    const historicalObservedSec =
      matchedBaselineSec +
      totalDeltaSec;

    const uncoveredBaselineSec =
      Math.max(
        0,
        baseSec -
        matchedBaselineSec
      );

    const cities =
      [
        ...new Set(
          sections
            .map(
              (section) =>
                section.city
            )
            .filter(Boolean)
        ),
      ]
        .sort()
        .join(",");

    upsertHistoricalObservation({
      routeHash,

      routingEngine,

      modelVersion: "v1",

      city:
        cities ||
        "Unknown",

      observationDate:
        date,

      weekday:
        current.weekday,

      bucketStart:
        timeBucket,

      historicalEtaSec:
        historicalRouteSec,

      tdxObservedSec:
        historicalObservedSec,

      uncoveredBaselineSec,

      routeDistanceM:
        distanceKm * 1000,

      matchedDistanceM:
        matchedDistanceKm *
        1000,

      coverageRatio,

      matchedSectionCount,

      source:
        "TDX Historical",
    });
    storedDates.add(date);

    console.log(
      `[risk db] saved ${date} ${timeBucket} | ` +
      `${round(
        historicalRouteSec / 60,
        2
      )} min | ` +
      `${round(
        coverageRatio * 100,
        0
      )}% coverage`
    );
  } catch (error) {
    /*
     * A database write failure must NEVER
     * break navigation or change risk results.
     */
    console.warn(
      `[risk db] failed to save ${date} ${timeBucket}:`,
      error.message
    );
  }
}

    console.log(
      `[risk history] ${date} ${timeBucket}: ` +
      `${round(
        historicalRouteSec /
          60,
        1
      )} min, ` +
      `${round(
        coverageRatio * 100,
        0
      )}% route historical coverage`
    );

    // Stop after enough genuinely
    // different historical days.
    // Increase RISK_MIN_UNIQUE_DAYS
    // if a larger empirical sample
    // is desired.
    if (
      samples.length >=
      LOOKBACK_WEEKS    ) {
      break;
    }
  }

  const averageCoverage =
    samples.length
      ? samples.reduce(
          (sum, sample) =>
            sum +
            sample.coverageRatio,
          0
        ) /
        samples.length
      : null;

  const sampleDates =
    samples.map(
      (sample) =>
        sample.date
    );

  if (
    samples.length <
    MIN_UNIQUE_DAYS
  ) {
    return emptyRiskResult({
      sampleCount:
        samples.length,

      weekday:
        current.weekday,

      timeBucket,

      sampleDates,

      attemptedDates,

      historicalAverageCoverage:
        averageCoverage ===
        null
          ? null
          : round(
              averageCoverage,
              3
            ),
    });
  }

  const stats =
    empiricalStats(
      samples.map(
        (sample) =>
          sample.etaMin
      )
    );
    console.log(
  "[risk stats]",
  JSON.stringify(
    {
      sampleCount:
        samples.length,

      values:
        samples.map(
          (sample) =>
            sample.etaMin
        ),

      stats,
    }
  )
);

  if (!stats) {
    return emptyRiskResult({
      sampleCount:
        samples.length,

      weekday:
        current.weekday,

      timeBucket,

      sampleDates,

      attemptedDates,

      historicalAverageCoverage:
        averageCoverage ===
        null
          ? null
          : round(
              averageCoverage,
              3
            ),
    });
  }

  return {
    riskStatus: "ready",

    sampleCount:
      samples.length,

    minRequiredUniqueDays:
      MIN_UNIQUE_DAYS,

    lookbackWeeks:
      LOOKBACK_WEEKS,

    weekday:
      current.weekday,

    timeBucket,

    worst10Min:
      stats.p90Min,

    worst5Min:
      stats.p95Min,

    variance:
      stats.variance,

    varianceLabel: null,

    likelyRangeMin: {
      low:
        stats.p10Min,

      high:
        stats.p90Min,
    },

    standardDeviationMin:
      stats.standardDeviationMin,

    coefficientOfVariation:
      stats.coefficientOfVariation,

    stabilityScore: null,
    stabilityLevel: null,

    historicalMeanMin:
      stats.meanMin,

    historicalMedianMin:
      stats.medianMin,

    historicalAverageTdxCoverageRatio:
      round(
        averageCoverage,
        3
      ),

    sampleDates,
    attemptedDates,

    historicalScope:
      "TDX Historical city road sections only; uncovered road stays at OSRM baseline. Historical freeway/highway archive is not yet included.",

    riskDataSource:
      "Empirical distribution of same-weekday, same-30-minute-bucket route ETAs reconstructed from TDX Historical Road/Traffic/Live/City observations. No normal-distribution multiplier, guessed CV, or incident penalty.",
  };
}

// Temporary compatibility alias.
// New code should call
// assessHistoricalRisk().
export const assessAndRecordRisk =
  assessHistoricalRisk;