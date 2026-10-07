import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(
  DATA_DIR,
  "uncovered-prior-v9.jsonl"
);

const MIN_UNIQUE_DAYS = Math.max(
  8,
  Number(
    process.env.UNCOVERED_PRIOR_MIN_UNIQUE_DAYS || 8
  )
);


function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


function round(value, digits = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = 10 ** digits;
  return Math.round(n * p) / p;
}


function median(values) {
  const nums = (values || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) {
    return null;
  }

  const middle = Math.floor(nums.length / 2);

  if (nums.length % 2 === 1) {
    return nums[middle];
  }

  return (
    nums[middle - 1] +
    nums[middle]
  ) / 2;
}


function getTaipeiClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
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
  )
    .formatToParts(date)
    .reduce((out, part) => {
      if (part.type !== "literal") {
        out[part.type] = part.value;
      }

      return out;
    }, {});

  return {
    dateKey:
      `${parts.year}-${parts.month}-${parts.day}`,

    weekday:
      parts.weekday,

    hour:
      Number(parts.hour),

    minute:
      Number(parts.minute),
  };
}


function makeTimeBucket(hour, minute) {
  const h = Math.max(
    0,
    Math.min(23, Number(hour) || 0)
  );

  const m =
    Number(minute) >= 30
      ? 30
      : 0;

  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}`
  );
}


function getRequestedBucket(
  departureTime,
  fallbackClock
) {
  const match = String(
    departureTime || ""
  ).match(/^(\d{1,2}):(\d{2})/);

  if (!match) {
    return makeTimeBucket(
      fallbackClock.hour,
      fallbackClock.minute
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return makeTimeBucket(
      fallbackClock.hour,
      fallbackClock.minute
    );
  }

  return makeTimeBucket(
    hour,
    minute
  );
}


function haversineKm(a, b) {
  if (!a || !b) {
    return Infinity;
  }

  const lon1 = Number(a.lon);
  const lat1 = Number(a.lat);
  const lon2 = Number(b.lon);
  const lat2 = Number(b.lat);

  if (
    ![
      lon1,
      lat1,
      lon2,
      lat2,
    ].every(Number.isFinite)
  ) {
    return Infinity;
  }

  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLon =
    ((lon2 - lon1) * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(1 - x)
    )
  );
}


function nearestJurisdiction(
  point,
  jurisdictionSamples
) {
  let best = null;
  let bestKm = Infinity;

  for (const sample of jurisdictionSamples || []) {
    if (
      !sample?.point ||
      !sample?.jurisdiction
    ) {
      continue;
    }

    const km = haversineKm(
      point,
      sample.point
    );

    if (km < bestKm) {
      bestKm = km;
      best = String(sample.jurisdiction);
    }
  }

  return best;
}


function aggregateGroups({
  groups,
  jurisdictionSamples,
  requireObserved,
}) {
  const map = new Map();

  for (const group of groups || []) {
    const baselineSec = finite(
      group?.baselineSec
    );

    const observedSec = finite(
      group?.observedSec
    );

    if (
      baselineSec === null ||
      baselineSec <= 0
    ) {
      continue;
    }

    if (
      requireObserved &&
      (
        observedSec === null ||
        observedSec <= 0
      )
    ) {
      continue;
    }

    const jurisdiction =
      group?.city ||
      nearestJurisdiction(
        group?.point,
        jurisdictionSamples
      );

    const roadType = String(
      group?.roadType || ""
    ).trim();

    if (
      !jurisdiction ||
      !roadType
    ) {
      continue;
    }

    const key =
      `${jurisdiction}|${roadType}`;

    const current =
      map.get(key) ||
      {
        jurisdiction,
        roadType,
        baselineSec: 0,
        observedSec: 0,
        distanceKm: 0,
        groupCount: 0,
      };

    current.baselineSec += baselineSec;

    if (observedSec !== null) {
      current.observedSec += observedSec;
    }

    current.distanceKm += Number(
      group?.distanceKm || 0
    );

    current.groupCount += 1;

    map.set(key, current);
  }

  return [...map.values()];
}


async function readHistory() {
  try {
    const text = await fs.readFile(
      DATA_FILE,
      "utf8"
    );

    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}


async function appendHistory(rows) {
  if (!rows.length) {
    return;
  }

  await fs.mkdir(
    DATA_DIR,
    {
      recursive: true,
    }
  );

  await fs.appendFile(
    DATA_FILE,
    rows
      .map((row) => JSON.stringify(row))
      .join("\n") +
      "\n",
    "utf8"
  );
}


function getDailyRatios({
  history,
  jurisdiction,
  roadType,
  weekday,
  timeBucket,
  currentDateKey,
}) {
  const byDay = new Map();

  for (const row of history) {
    if (
      row?.jurisdiction !== jurisdiction ||
      row?.roadType !== roadType ||
      row?.weekday !== weekday ||
      row?.timeBucket !== timeBucket ||
      row?.dateKey === currentDateKey
    ) {
      continue;
    }

    const baselineSec = finite(
      row?.baselineSec
    );

    const observedSec = finite(
      row?.observedSec
    );

    if (
      baselineSec === null ||
      observedSec === null ||
      baselineSec <= 0 ||
      observedSec <= 0
    ) {
      continue;
    }

    const current =
      byDay.get(row.dateKey) ||
      {
        baselineSec: 0,
        observedSec: 0,
      };

    current.baselineSec += baselineSec;
    current.observedSec += observedSec;

    byDay.set(
      row.dateKey,
      current
    );
  }

  return [...byDay.values()]
    .map(
      (item) =>
        item.observedSec /
        item.baselineSec
    )
    .filter(
      (ratio) =>
        Number.isFinite(ratio) &&
        ratio > 0 &&
        ratio <= 6
    );
}


export async function assessAndRecordUncoveredPriorV9({
  trainingGroups = [],
  uncoveredGroups = [],
  jurisdictionSamples = [],
  departureTime = null,
} = {}) {
  const now = new Date();
  const clock = getTaipeiClock(now);

  const trainingTimeBucket =
    makeTimeBucket(
      clock.hour,
      clock.minute
    );

  const applicationTimeBucket =
    getRequestedBucket(
      departureTime,
      clock
    );

  const history =
    await readHistory();

  /*
   * CURRENT_UNCOVERED_PROXY_V1
   *
   * Do not spread medium-confidence disagreement
   * into uncovered road pieces or future V9 history.
   */
  const highConfidenceTrainingGroups =
    (trainingGroups || [])
      .filter(
        (group) =>
          String(
            group?.evidenceConfidence ||
            ""
          )
            .trim()
            .toLowerCase() ===
          "high"
      );


  const training =
    aggregateGroups({
      groups:
        highConfidenceTrainingGroups,
      jurisdictionSamples,
      requireObserved: true,
    });

  const uncovered =
    aggregateGroups({
      groups: uncoveredGroups,
      jurisdictionSamples,
      requireObserved: false,
    });


  /*
   * Current high-confidence evidence indexed by
   * exact jurisdiction + road type.
   *
   * No nearest-road guessing.
   * No cross-road-type multiplier.
   */
  const currentTrainingByKey =
    new Map(
      training.map(
        (group) => [
          `${group.jurisdiction}|${group.roadType}`,
          group,
        ]
      )
    );


  const rowsToWrite = [];

  for (const group of training) {
    /*
     * Do not train from tiny
     * matched fragments.
     */
    if (
      group.distanceKm < 0.5 ||
      group.baselineSec < 60
    ) {
      continue;
    }

    const slowdownRatio =
      group.observedSec /
      group.baselineSec;

    if (
      !Number.isFinite(slowdownRatio) ||
      slowdownRatio <= 0 ||
      slowdownRatio > 6
    ) {
      continue;
    }

    rowsToWrite.push({
      version: 9,

      observedAt:
        now.toISOString(),

      dateKey:
        clock.dateKey,

      weekday:
        clock.weekday,

      timeBucket:
        trainingTimeBucket,

      jurisdiction:
        group.jurisdiction,

      roadType:
        group.roadType,

      baselineSec:
        round(
          group.baselineSec,
          3
        ),

      observedSec:
        round(
          group.observedSec,
          3
        ),

      slowdownRatio:
        round(
          slowdownRatio,
          5
        ),

      distanceKm:
        round(
          group.distanceKm,
          3
        ),
    });
  }


    let supplementSec = 0;

  let appliedGroupCount = 0;

  let maxUniqueDays = 0;


  let currentProxyEligibleGroupCount = 0;

  let currentProxyAppliedGroupCount = 0;

  let historicalPriorEligibleGroupCount = 0;

  let historicalPriorAppliedGroupCount = 0;


  const diagnostics = [];


  for (const group of uncovered) {
    const ratios =
      getDailyRatios({
        history,

        jurisdiction:
          group.jurisdiction,

        roadType:
          group.roadType,

        weekday:
          clock.weekday,

        timeBucket:
          applicationTimeBucket,

        currentDateKey:
          clock.dateKey,
      });


    maxUniqueDays =
      Math.max(
        maxUniqueDays,
        ratios.length
      );


    /*
     * CURRENT_UNCOVERED_PROXY_V1
     *
     * Current evidence may proxy an uncovered
     * piece ONLY when it is:
     *
     *   - high-confidence
     *   - same jurisdiction
     *   - same roadType
     *   - same 30-minute bucket
     *   - >= 0.5 km of matched evidence
     *   - >= 60 sec matched baseline
     *
     * This does not pretend that the uncovered
     * road itself was observed by TDX.
     */
    const currentKey =
      `${group.jurisdiction}|${group.roadType}`;


    const currentGroup =
      currentTrainingByKey.get(
        currentKey
      ) ||
      null;


    const currentRatio =
      currentGroup &&
      Number(currentGroup.baselineSec) > 0
        ? Number(currentGroup.observedSec) /
          Number(currentGroup.baselineSec)
        : null;


    const currentProxyEligible =
      trainingTimeBucket ===
        applicationTimeBucket &&

      currentGroup !== null &&

      Number(currentGroup.distanceKm) >=
        0.5 &&

      Number(currentGroup.baselineSec) >=
        60 &&

      Number.isFinite(currentRatio) &&

      currentRatio > 0 &&

      currentRatio <= 6;


    let source =
      "none";

    let multiplier =
      1;

    let empiricalMedian =
      null;


    /*
     * Current traffic has precedence over
     * historical traffic for the same group.
     */
    if (currentProxyEligible) {
      currentProxyEligibleGroupCount +=
        1;

      source =
        "current_live_proxy";

      /*
       * Positive-delay-only.
       *
       * A currently fast road does not make
       * Valhalla shorter and does not fall back
       * to an older congestion multiplier.
       */
      multiplier =
        Math.max(
          1,
          currentRatio
        );

    } else if (
      ratios.length >=
      MIN_UNIQUE_DAYS
    ) {
      historicalPriorEligibleGroupCount +=
        1;

      empiricalMedian =
        median(ratios);

      source =
        "historical_prior";

      /*
       * Original V9 behavior:
       * positive-delay-only.
       */
      multiplier =
        Math.max(
          1,

          Number(
            empiricalMedian ||
            1
          )
        );

    } else {
      diagnostics.push({
        jurisdiction:
          group.jurisdiction,

        roadType:
          group.roadType,

        source:
          "baseline_only",

        uniqueDays:
          ratios.length,

        baselineMin:
          round(
            group.baselineSec /
            60,
            3
          ),

        currentEvidenceKm:
          currentGroup
            ? round(
                currentGroup.distanceKm,
                3
              )
            : 0,

        currentEvidenceBaselineMin:
          currentGroup
            ? round(
                currentGroup.baselineSec /
                60,
                3
              )
            : 0,

        currentSlowdown:
          Number.isFinite(currentRatio)
            ? round(
                currentRatio,
                4
              )
            : null,

        multiplier:
          1,

        addedMin:
          0,

        applied:
          false,
      });

      continue;
    }


    const addedSec =
      group.baselineSec *
      (multiplier - 1);


    if (
      Number.isFinite(addedSec) &&
      addedSec > 0
    ) {
      supplementSec +=
        addedSec;

      appliedGroupCount +=
        1;


      if (
        source ===
        "current_live_proxy"
      ) {
        currentProxyAppliedGroupCount +=
          1;
      }


      if (
        source ===
        "historical_prior"
      ) {
        historicalPriorAppliedGroupCount +=
          1;
      }
    }


    diagnostics.push({
      jurisdiction:
        group.jurisdiction,

      roadType:
        group.roadType,

      source,

      uniqueDays:
        ratios.length,

      baselineMin:
        round(
          group.baselineSec /
          60,
          3
        ),

      currentEvidenceKm:
        currentGroup
          ? round(
              currentGroup.distanceKm,
              3
            )
          : 0,

      currentEvidenceBaselineMin:
        currentGroup
          ? round(
              currentGroup.baselineSec /
              60,
              3
            )
          : 0,

      currentSlowdown:
        Number.isFinite(currentRatio)
          ? round(
              currentRatio,
              4
            )
          : null,

      empiricalMedianSlowdown:
        empiricalMedian === null
          ? null
          : round(
              empiricalMedian,
              4
            ),

      multiplier:
        round(
          multiplier,
          4
        ),

      addedMin:
        round(
          Math.max(
            0,
            addedSec
          ) /
          60,
          3
        ),

      applied:
        multiplier > 1,
    });
  }




  /*
   * Important:
   * calculate prior first,
   * then append today's evidence.
   * Today cannot train itself.
   */
  await appendHistory(
    rowsToWrite
  );


  return {
    version: "V9",

    status:
      appliedGroupCount > 0
        ? "ready"
        : "insufficient_data",

    supplementMin:
      round(
        supplementSec / 60,
        3
      ),

    sampleCount:
      maxUniqueDays,

    minRequiredUniqueDays:
      MIN_UNIQUE_DAYS,


    currentProxyEligibleGroupCount,

    currentProxyAppliedGroupCount,

    historicalPriorEligibleGroupCount,

    historicalPriorAppliedGroupCount,

    appliedGroupCount,

    trainingRowsWritten:
      rowsToWrite.length,

    trainingGroupCount:
      training.length,

    uncoveredGroupCount:
      uncovered.length,

    weekday:
      clock.weekday,

    trainingTimeBucket,

    applicationTimeBucket,

    reason:
      appliedGroupCount > 0
        ? "V9 empirical median slowdown applied only to uncovered baseline"
        : "insufficient exact jurisdiction × road-type × weekday × time-bucket history; uncovered stays at Valhalla baseline",

    diagnostics,
  };
}
