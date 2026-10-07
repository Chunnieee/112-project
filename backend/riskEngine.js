import "dotenv/config";

import {
  getHistoricalSectionStats,
} from "./historicalTrafficClient.js";


function envInteger(
  name,
  fallback,
  minimum = 1
) {
  const value =
    Number(
      process.env[name]
    );

  if (
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.floor(value)
  );
}


const MIN_UNIQUE_DAYS =
  envInteger(
    "RISK_MIN_UNIQUE_DAYS",
    8,
    3
  );


/*
 * HISTORICAL_20_TARGET_FINAL_V1
 *
 * 8 usable days  = Historical Ready
 * 20 usable days = Background target
 */
const TARGET_UNIQUE_DAYS =
  Math.max(
    MIN_UNIQUE_DAYS,
    envInteger(
      "RISK_TARGET_UNIQUE_DAYS",
      20,
      MIN_UNIQUE_DAYS
    )
  );


const LOOKBACK_WEEKS =
  Math.max(
    TARGET_UNIQUE_DAYS,

    envInteger(
      "RISK_HISTORY_LOOKBACK_WEEKS",
      26,
      TARGET_UNIQUE_DAYS
    )
  );


console.log(
  `[risk history] config: minimum=${MIN_UNIQUE_DAYS} unique days, target=${TARGET_UNIQUE_DAYS} unique days, lookback=${LOOKBACK_WEEKS} weeks`
);


function round(
  value,
  digits = 2
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return null;
  }

  const p =
    10 ** digits;

  return (
    Math.round(n * p) /
    p
  );
}


function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function taipeiCurrentParts() {
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

        weekday:
          "short",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hourCycle:
          "h23",
      }
    ).formatToParts(
      new Date()
    );

  const map =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ]
      )
    );

  return {
    dateKey:
      `${map.year}-${map.month}-${map.day}`,

    weekday:
      map.weekday,

    hour:
      Number(
        map.hour
      ),

    minute:
      Number(
        map.minute
      ),
  };
}


function resolveTimeBucket(
  departureTime,
  currentHour,
  currentMinute
) {
  let hour =
    currentHour;

  let minute =
    currentMinute;

  const match =
    String(
      departureTime ||
      ""
    ).match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (match) {
    const requestedHour =
      Number(
        match[1]
      );

    const requestedMinute =
      Number(
        match[2]
      );

    if (
      Number.isInteger(
        requestedHour
      ) &&
      requestedHour >= 0 &&
      requestedHour <= 23 &&
      Number.isInteger(
        requestedMinute
      ) &&
      requestedMinute >= 0 &&
      requestedMinute <= 59
    ) {
      hour =
        requestedHour;

      minute =
        requestedMinute;
    }
  }

  return (
    `${String(hour).padStart(
      2,
      "0"
    )}:` +
    `${
      minute < 30
        ? "00"
        : "30"
    }`
  );
}


function shiftDateKey(
  dateKey,
  deltaDays
) {
  const match =
    String(
      dateKey
    ).match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    throw new Error(
      `Invalid dateKey: ${dateKey}`
    );
  }

  const date =
    new Date(
      Date.UTC(
        Number(
          match[1]
        ),

        Number(
          match[2]
        ) - 1,

        Number(
          match[3]
        ) +
          Number(
            deltaDays ||
            0
          )
      )
    );

  return (
    `${date.getUTCFullYear()}-` +
    `${String(
      date.getUTCMonth() +
        1
    ).padStart(
      2,
      "0"
    )}-` +
    `${String(
      date.getUTCDate()
    ).padStart(
      2,
      "0"
    )}`
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
  if (
    !sorted.length
  ) {
    return null;
  }

  const index =
    Math.min(
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


function empiricalStats(
  values
) {
  const sorted =
    values
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );

  if (
    !sorted.length
  ) {
    return null;
  }

  const mean =
    sorted.reduce(
      (
        sum,
        value
      ) =>
        sum +
        value,

      0
    ) /
    sorted.length;

  const variance =
    sorted.length > 1
      ? sorted.reduce(
          (
            sum,
            value
          ) =>
            sum +
            (
              value -
              mean
            ) ** 2,

          0
        ) /
        (
          sorted.length -
          1
        )
      : 0;

  const sd =
    Math.sqrt(
      variance
    );

  return {
    meanMin:
      round(
        mean,
        1
      ),

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
        4
      ),

    standardDeviationMin:
      round(
        sd,
        3
      ),

    coefficientOfVariation:
      mean > 0
        ? round(
            sd /
              mean,

            4
          )
        : null,
  };
}


/*
 * Decide which TDX Historical
 * archive owns a matched section.
 */
function normalizeSectionScope(
  item
) {
  const explicit =
    String(
      item?.scope ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    explicit ===
      "freeway" ||
    explicit ===
      "highway" ||
    explicit ===
      "city"
  ) {
    return explicit;
  }

  /*
   * Backward compatibility for
   * existing City matched sections.
   */
  const city =
    String(
      item?.city ||
      ""
    ).trim();

  if (city) {
    return "city";
  }

  return null;
}


/*
 * Normalize and aggregate route
 * sections before Historical lookup.
 *
 * Key includes scope so an identical
 * SectionID from different archives
 * cannot accidentally collide.
 */
function cleanMatchedSections(
  matchedSections
) {
  const map =
    new Map();

  for (
    const item of
    matchedSections || []
  ) {
    const scope =
      normalizeSectionScope(
        item
      );

    const city =
      String(
        item?.city ||
        ""
      ).trim();

    const sectionId =
      String(
        item?.sectionId ||
        ""
      ).trim();

    const matchedDistanceKm =
      Number(
        item?.matchedDistanceKm
      );

    const sectionLengthKm =
      Number(
        item?.sectionLengthKm
      );

    if (
      !scope ||
      !sectionId ||
      !Number.isFinite(
        matchedDistanceKm
      ) ||
      matchedDistanceKm <= 0
    ) {
      continue;
    }

    if (
      scope === "city" &&
      !city
    ) {
      continue;
    }

    const key =
      scope === "city"
        ? `${scope}:${city}:${sectionId}`
        : `${scope}:${sectionId}`;

    const existing =
      map.get(key) || {
        scope,
        city:
          scope ===
            "city"
            ? city
            : "",

        sectionId,

        matchedDistanceKm:
          0,

        sectionLengthKm:
          Number.isFinite(
            sectionLengthKm
          ) &&
          sectionLengthKm > 0
            ? sectionLengthKm
            : null,
      };

    existing
      .matchedDistanceKm +=
      matchedDistanceKm;

    /*
     * Preserve a valid full
     * section length if one exists.
     */
    if (
      !existing.sectionLengthKm &&
      Number.isFinite(
        sectionLengthKm
      ) &&
      sectionLengthKm > 0
    ) {
      existing.sectionLengthKm =
        sectionLengthKm;
    }

    map.set(
      key,
      existing
    );
  }

  return [
    ...map.values(),
  ];
}


/*
 * Historical lookup groups:
 *
 * city:Taipei
 * city:Taichung
 * freeway
 * highway
 */
function groupSectionsBySource(
  sections
) {
  const grouped =
    new Map();

  for (
    const section of
    sections
  ) {
    const key =
      section.scope ===
        "city"
        ? `city:${section.city}`
        : section.scope;

    if (
      !grouped.has(
        key
      )
    ) {
      grouped.set(
        key,
        {
          scope:
            section.scope,

          city:
            section.scope ===
              "city"
              ? section.city
              : "",

          sections: [],
        }
      );
    }

    grouped
      .get(key)
      .sections
      .push(
        section
      );
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

  /*
   * When full section length is
   * known, TravelTime-derived speed
   * mirrors the live ETA policy.
   */
  if (
    Number.isFinite(
      historicalTravelTime
    ) &&
    historicalTravelTime >
      0 &&
    Number.isFinite(
      sectionLengthKm
    ) &&
    sectionLengthKm >
      0
  ) {
    const speed =
      sectionLengthKm /
      (
        historicalTravelTime /
        3600
      );

    if (
      Number.isFinite(
        speed
      ) &&
      speed >= 1 &&
      speed <= 160
    ) {
      return speed;
    }
  }

  /*
   * Freeway / Highway matched
   * sections normally do not carry
   * full section length, so use
   * TDX's Historical TravelSpeed.
   */
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


function historicalScopeDescription() {
  return (
    "TDX Historical Road/Traffic/Live " +
    "City + Freeway + Highway sections; " +
    "route portions without a matched historical observation " +
    "remain at routing baseline."
  );
}


function historicalDataSourceDescription() {
  return (
    "Empirical distribution of same-weekday, same-30-minute-bucket " +
    "route ETAs reconstructed from real TDX Historical " +
    "Road/Traffic/Live City, Freeway and Highway observations. " +
    "Uncovered route portions remain at routing baseline. " +
    "No normal-distribution multiplier, guessed CV, " +
    "time-of-day multiplier, or incident penalty."
  );
}


/*
 * Product-level percentile confidence.
 *
 * This is a sample-size quality label,
 * not a formal confidence interval.
 *
 * 8-11  -> low
 * 12-19 -> medium
 * 20+   -> high
 */
function historicalPercentileConfidence(
  sampleCount
) {
  const n =
    Math.max(
      0,
      Number(sampleCount) || 0
    );

  if (
    n >= TARGET_UNIQUE_DAYS
  ) {
    return "high";
  }

  if (
    n >= 12
  ) {
    return "medium";
  }

  if (
    n >= MIN_UNIQUE_DAYS
  ) {
    return "low";
  }

  return "insufficient";
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

    historicalTargetUniqueDays:
      TARGET_UNIQUE_DAYS,

    historicalTargetReached:
      sampleCount >=
      TARGET_UNIQUE_DAYS,

    percentileConfidence:
      historicalPercentileConfidence(
        sampleCount
      ),

    lookbackWeeks:
      LOOKBACK_WEEKS,

    weekday,

    timeBucket,

    worst10Min:
      null,

    worst5Min:
      null,

    variance:
      null,

    varianceLabel:
      null,

    likelyRangeMin:
      null,

    standardDeviationMin:
      null,

    coefficientOfVariation:
      null,

    stabilityScore:
      null,

    stabilityLevel:
      null,

    historicalMeanMin:
      null,

    historicalMedianMin:
      null,

    historicalAverageTdxCoverageRatio:
      historicalAverageCoverage,

    sampleDates,

    attemptedDates,

    historicalScope:
      historicalScopeDescription(),

    riskDataSource:
      historicalDataSourceDescription(),
  };
}


export async function assessHistoricalRisk({
  baseOsrmMin,
  routeDistanceKm,

  /*
   * New API.
   */
  matchedSections = null,

  /*
   * Temporary compatibility with
   * old server.js callers.
   */
  matchedCitySections = null,

  departureTime = null,
}) {
  const baseMin =
    Number(
      baseOsrmMin
    );

  const distanceKm =
    Number(
      routeDistanceKm
    );

  const current =
    taipeiCurrentParts();

  const timeBucket =
    resolveTimeBucket(
      departureTime,
      current.hour,
      current.minute
    );

  const sourceSections =
    Array.isArray(
      matchedSections
    ) &&
    matchedSections.length
      ? matchedSections
      : (
          matchedCitySections ||
          []
        );

  const sections =
    cleanMatchedSections(
      sourceSections
    );

  const scopeCounts =
    sections.reduce(
      (
        acc,
        section
      ) => {
        acc[
          section.scope
        ] =
          (
            acc[
              section.scope
            ] ||
            0
          ) + 1;

        return acc;
      },

      {
        city: 0,
        freeway: 0,
        highway: 0,
      }
    );

  console.log(
    "[risk history sections]",
    {
      total:
        sections.length,

      city:
        scopeCounts.city,

      freeway:
        scopeCounts.freeway,

      highway:
        scopeCounts.highway,
    }
  );

  if (
    !Number.isFinite(
      baseMin
    ) ||
    baseMin <= 0 ||
    !Number.isFinite(
      distanceKm
    ) ||
    distanceKm <= 0 ||
    !sections.length
  ) {
    return emptyRiskResult({
      sampleCount:
        0,

      weekday:
        current.weekday,

      timeBucket,

      sampleDates:
        [],

      attemptedDates:
        [],

      historicalAverageCoverage:
        null,
    });
  }

  const grouped =
    groupSectionsBySource(
      sections
    );

  const baseSec =
    baseMin *
    60;

  const baseSecPerKm =
    baseSec /
    distanceKm;

  /*
   * HISTORICAL_COVERAGE_QUALITY_GATE_V1
   *
   * A historical day must cover a meaningful
   * portion of the route's normally observable
   * TDX distance before it can count as one of
   * the required unique sample days.
   *
   * This prevents a day with, for example,
   * only 2.5% route coverage from counting
   * equally with an 83% coverage day.
   */
  const routeHistoricalTargetCoverage =
    clamp(
      sections.reduce(
        (sum, section) =>
          sum +
          Number(
            section.matchedDistanceKm ||
            0
          ),
        0
      ) /
        distanceKm,
      0,
      1
    );

  const absoluteCoverageFloor =
    Math.max(
      0,
      Math.min(
        1,
        Number(
          process.env
            .RISK_MIN_HISTORICAL_COVERAGE ||
          0.20
        )
      )
    );

  const relativeCoverageFloor =
    Math.max(
      0,
      Math.min(
        1,
        Number(
          process.env
            .RISK_MIN_HISTORICAL_COVERAGE_RELATIVE ||
          0.60
        )
      )
    );

  const minimumAcceptedHistoricalCoverage =
    Math.min(
      routeHistoricalTargetCoverage,
      Math.max(
        absoluteCoverageFloor,
        routeHistoricalTargetCoverage *
          relativeCoverageFloor
      )
    );

  const rejectedLowCoverageDates = [];

  const candidateDates =
    priorSameWeekdayDates(
      current.dateKey,
      LOOKBACK_WEEKS
    );

  const samples = [];

  const attemptedDates =
    [];

  for (
    const date of
    candidateDates
  ) {
    attemptedDates.push(
      date
    );

    let totalDeltaSec =
      0;

    let matchedDistanceKm =
      0;

    let matchedSectionCount =
      0;

    let dateFetchFailed =
      false;

    for (
      const group of
      grouped.values()
    ) {
      let historical;

      const label =
        group.scope ===
          "city"
          ? `city:${group.city}`
          : group.scope;

      try {
        historical =
          await getHistoricalSectionStats(
            {
              scope:
                group.scope,

              city:
                group.city,

              date,

              timeBucket,

              sectionIds:
                group.sections.map(
                  (
                    section
                  ) =>
                    section.sectionId
                ),

              /*
               * Navigation itself must
               * never start a huge
               * Historical download.
               * Missing cache remains
               * missing until backfill.
               */
              cacheOnly:
                true,
            }
          );
      } catch (
        error
      ) {
        console.log(
          `[risk history] ${label} ${date} ${timeBucket} failed:`,
          error.message
        );

        dateFetchFailed =
          true;

        break;
      }

      if (
        !historical
      ) {
        continue;
      }

      for (
        const routeSection of
        group.sections
      ) {
        const historicalSection =
          historical.sections?.[
            routeSection
              .sectionId
          ];

        if (
          !historicalSection
        ) {
          continue;
        }

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

        const distance =
          Number(
            routeSection
              .matchedDistanceKm
          );

        if (
          !Number.isFinite(
            distance
          ) ||
          distance <= 0
        ) {
          continue;
        }

        const observedSec =
          (
            distance /
            speed
          ) *
          3600;

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

        /*
         * Replace routing baseline
         * only on the exact route
         * distance covered by this
         * historical section.
         */
        totalDeltaSec +=
          Math.max(
            0,
            observedSec -
              baselineSec
          );

        matchedDistanceKm +=
          distance;

        matchedSectionCount +=
          1;
      }
    }

    if (
      dateFetchFailed
    ) {
      console.log(
        `[risk history] ${date} ${timeBucket}: skipped because Historical lookup failed`
      );

      continue;
    }

    if (
      matchedDistanceKm <=
      0
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
      historicalRouteSec <=
        0
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

    /*
     * A tiny fragment of historical data is
     * real data, but it is NOT representative
     * enough to count as a full route sample.
     */
    if (
      coverageRatio <
      minimumAcceptedHistoricalCoverage
    ) {
      rejectedLowCoverageDates.push({
        date,

        coverageRatio:
          round(
            coverageRatio,
            4
          ),

        coveragePct:
          round(
            coverageRatio *
              100,
            1
          ),

        matchedDistanceKm:
          round(
            matchedDistanceKm,
            3
          ),

        matchedSectionCount,
      });

      console.log(
        `[risk history] ${date} ${timeBucket}: ` +
        `REJECTED low coverage ` +
        `${round(coverageRatio * 100, 1)}% ` +
        `< required ` +
        `${round(minimumAcceptedHistoricalCoverage * 100, 1)}%`
      );

      continue;
    }

    samples.push({
      date,

      etaMin:
        historicalRouteSec /
        60,

      coverageRatio,

      matchedDistanceKm,

      matchedSectionCount,
    });

    console.log(
      `[risk history] ${date} ${timeBucket}: ` +
        `${round(
          historicalRouteSec /
            60,
          1
        )} min, ` +
        `${round(
          coverageRatio *
            100,
          0
        )}% route historical coverage, ` +
        `${matchedSectionCount} section(s)`
    );

    if (
      samples.length >=
      TARGET_UNIQUE_DAYS
    ) {
      break;
    }
  }

  const averageCoverage =
    samples.length
      ? samples.reduce(
          (
            sum,
            sample
          ) =>
            sum +
            sample
              .coverageRatio,

          0
        ) /
        samples.length
      : null;

  const sampleDates =
    samples.map(
      (
        sample
      ) =>
        sample.date
    );

  /*
   * HISTORICAL_SAMPLE_AUDIT_V1
   *
   * Preserve the actual per-day values used
   * to build P90 / P95 / mean / SD.
   *
   * Diagnostic only:
   * this does NOT change ETA calculation.
   */
  const sampleDetails =
    samples.map(
      (sample) => ({
        date:
          sample.date,

        etaMin:
          round(
            sample.etaMin,
            3
          ),

        coverageRatio:
          round(
            sample.coverageRatio,
            4
          ),

        coveragePct:
          round(
            sample.coverageRatio *
              100,
            1
          ),

        matchedDistanceKm:
          round(
            sample.matchedDistanceKm,
            3
          ),

        matchedSectionCount:
          sample.matchedSectionCount,
      })
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
        (
          sample
        ) =>
          sample.etaMin
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
    riskStatus:
      "ready",

    sampleCount:
      samples.length,

    minRequiredUniqueDays:
      MIN_UNIQUE_DAYS,

    historicalTargetUniqueDays:
      TARGET_UNIQUE_DAYS,

    historicalTargetReached:
      samples.length >=
      TARGET_UNIQUE_DAYS,

    percentileConfidence:
      historicalPercentileConfidence(
        samples.length
      ),

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

    varianceLabel:
      null,

    likelyRangeMin: {
      low:
        stats.p10Min,

      high:
        stats.p90Min,
    },

    standardDeviationMin:
      stats
        .standardDeviationMin,

    coefficientOfVariation:
      stats
        .coefficientOfVariation,

    stabilityScore:
      null,

    stabilityLevel:
      null,

    historicalMeanMin:
      stats.meanMin,

    historicalMedianMin:
      stats.medianMin,

    historicalAverageTdxCoverageRatio:
      round(
        averageCoverage,
        3
      ),


    historicalCoveragePct:
      round(
        averageCoverage *
          100,
        1
      ),

    historicalCoverageState:
      averageCoverage >= 0.999
        ? "full"
        : "partial",

    routeHistoricalTargetCoverageRatio:
      round(
        routeHistoricalTargetCoverage,
        4
      ),

    routeHistoricalTargetCoveragePct:
      round(
        routeHistoricalTargetCoverage *
          100,
        1
      ),

    minimumAcceptedHistoricalCoverageRatio:
      round(
        minimumAcceptedHistoricalCoverage,
        4
      ),

    minimumAcceptedHistoricalCoveragePct:
      round(
        minimumAcceptedHistoricalCoverage *
          100,
        1
      ),

    rejectedLowCoverageDates,

    sampleDates,

    sampleDetails,

    attemptedDates,

    historicalScope:
      historicalScopeDescription(),

    riskDataSource:
      historicalDataSourceDescription(),
  };
}


// Temporary compatibility alias.
export const assessAndRecordRisk =
  assessHistoricalRisk;
