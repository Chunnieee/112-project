import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );

const JOB_DIR =
  path.join(
    DATA_DIR,
    "history-jobs"
  );

const SNAPSHOT_DIR =
  path.join(
    DATA_DIR,
    "route-risk-snapshots"
  );

const LOCK_PATH =
  path.join(
    DATA_DIR,
    "historical-worker.lock"
  );

const LOG_PATH =
  path.join(
    DATA_DIR,
    "history-worker.log"
  );

/*
 * HISTORICAL_REMOTE_BUDGET_V1
 *
 * Global protection for large TDX Historical
 * archive downloads.
 *
 * Local cache / negative-cache hits cost 0.
 */
const REMOTE_ARCHIVE_BUDGET =
  Math.max(
    1,
    Number.parseInt(
      process.env.HISTORICAL_REMOTE_ARCHIVE_BUDGET ||
      "3",
      10
    ) || 3
  );

const REMOTE_COOLDOWN_MINUTES =
  Math.max(
    1,
    Number.parseInt(
      process.env.HISTORICAL_REMOTE_COOLDOWN_MINUTES ||
      "30",
      10
    ) || 30
  );

const REMOTE_COOLDOWN_MS =
  REMOTE_COOLDOWN_MINUTES *
  60 *
  1000;

const REMOTE_COOLDOWN_PATH =
  path.join(
    DATA_DIR,
    "historical-download-cooldown.json"
  );

/*
 * Shared by every queued job handled by THIS
 * worker process.
 */
let remoteArchivesUsed =
  0;

const remoteBudgetStartedAt =
  new Date().toISOString();




function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}



async function readHistoricalCooldown() {
  try {
    const raw =
      await fs.readFile(
        REMOTE_COOLDOWN_PATH,
        "utf8"
      );

    const state =
      JSON.parse(
        raw
      );

    const untilMs =
      Date.parse(
        state?.cooldownUntil ||
        ""
      );

    if (
      Number.isFinite(untilMs) &&
      untilMs > Date.now()
    ) {
      return {
        active:
          true,

        cooldownUntil:
          new Date(
            untilMs
          ).toISOString(),

        remainingMs:
          untilMs -
          Date.now(),
      };
    }


    /*
     * Expired or invalid cooldown.
     */
    try {
      await fs.unlink(
        REMOTE_COOLDOWN_PATH
      );
    } catch {
      // Ignore.
    }

  } catch (error) {
    if (
      error?.code !==
      "ENOENT"
    ) {
      await log(
        "[worker] cooldown read failed",
        error.message
      );
    }
  }


  return {
    active:
      false,

    cooldownUntil:
      null,

    remainingMs:
      0,
  };
}


async function activateHistoricalCooldown({
  reason,
  routeHash,
  timeBucket,
}) {
  const now =
    Date.now();

  const state = {
    version:
      1,

    reason,

    createdAt:
      new Date(
        now
      ).toISOString(),

    cooldownUntil:
      new Date(
        now +
        REMOTE_COOLDOWN_MS
      ).toISOString(),

    cooldownMinutes:
      REMOTE_COOLDOWN_MINUTES,

    remoteArchivesUsed,

    remoteArchiveBudget:
      REMOTE_ARCHIVE_BUDGET,

    workerStartedAt:
      remoteBudgetStartedAt,

    routeHash:
      String(
        routeHash ||
        ""
      ),

    timeBucket:
      String(
        timeBucket ||
        ""
      ),
  };


  const temp =
    `${REMOTE_COOLDOWN_PATH}.` +
    `${process.pid}.tmp`;


  await fs.mkdir(
    DATA_DIR,
    {
      recursive:
        true,
    }
  );


  await fs.writeFile(
    temp,
    JSON.stringify(
      state,
      null,
      2
    ),
    "utf8"
  );


  await fs.rename(
    temp,
    REMOTE_COOLDOWN_PATH
  );


  return state;
}


/*
 * processJob() deletes its queue file immediately
 * after reading it.
 *
 * If budget stops us early, restore that job.
 *
 * flag:"wx" prevents us from overwriting a newer
 * job created by server.js while this one ran.
 */
async function ensureJobRequeued(
  jobPath,
  raw
) {
  try {
    await fs.writeFile(
      jobPath,
      raw,
      {
        encoding:
          "utf8",

        flag:
          "wx",
      }
    );


    await log(
      "[worker] job requeued after budget pause",
      path.basename(
        jobPath
      )
    );

  } catch (error) {
    if (
      error?.code ===
      "EEXIST"
    ) {
      await log(
        "[worker] newer pending job already exists",
        path.basename(
          jobPath
        )
      );

      return;
    }

    throw error;
  }
}


function safeName(value) {
  return String(
    value || "unknown"
  )
    .replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    )
    .slice(
      0,
      120
    );
}


async function log(
  ...parts
) {
  const line =
    [
      new Date()
        .toISOString(),

      ...parts.map(
        (item) =>
          typeof item ===
          "string"
            ? item
            : JSON.stringify(
                item
              )
      ),
    ].join(" ") +
    "\n";

  try {
    await fs.mkdir(
      DATA_DIR,
      {
        recursive:
          true,
      }
    );

    await fs.appendFile(
      LOG_PATH,
      line,
      "utf8"
    );
  } catch {
    // Logging must never kill worker.
  }
}


function taipeiDateKey() {
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

  const map =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ]
      )
    );

  return (
    `${map.year}-` +
    `${map.month}-` +
    `${map.day}`
  );
}


function previousSameWeekdayDates(
  weeks = 26
) {
  const [
    year,
    month,
    day,
  ] =
    taipeiDateKey()
      .split("-")
      .map(Number);

  /*
   * Use noon UTC so date arithmetic
   * is stable and DST-independent.
   */
  const base =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        12,
        0,
        0
      )
    );

  const output = [];

  for (
    let week = 1;
    week <= weeks;
    week += 1
  ) {
    const date =
      new Date(
        base.getTime()
      );

    date.setUTCDate(
      date.getUTCDate() -
        week * 7
    );

    output.push(
      date
        .toISOString()
        .slice(
          0,
          10
        )
    );
  }

  return output;
}


async function acquireLock() {
  await fs.mkdir(
    DATA_DIR,
    {
      recursive:
        true,
    }
  );

  /*
   * Remove a stale lock after 2 hours.
   */
  try {
    const stat =
      await fs.stat(
        LOCK_PATH
      );

    if (
      Date.now() -
        stat.mtimeMs >
      2 * 60 * 60 * 1000
    ) {
      await fs.unlink(
        LOCK_PATH
      );
    }
  } catch {
    // No existing lock.
  }


  try {
    const handle =
      await fs.open(
        LOCK_PATH,
        "wx"
      );

    await handle.writeFile(
      JSON.stringify({
        pid:
          process.pid,

        startedAt:
          new Date()
            .toISOString(),
      })
    );

    await handle.close();

    return true;

  } catch (error) {
    if (
      error?.code ===
      "EEXIST"
    ) {
      return false;
    }

    throw error;
  }
}


async function releaseLock() {
  try {
    await fs.unlink(
      LOCK_PATH
    );
  } catch {
    // Already gone.
  }
}


async function writeSnapshot({
  routeHash,
  timeBucket,
  risk,
}) {
  if (
    !routeHash ||
    !timeBucket
  ) {
    return;
  }

  await fs.mkdir(
    SNAPSHOT_DIR,
    {
      recursive:
        true,
    }
  );

  const filename =
    `${safeName(
      routeHash
    )}__${safeName(
      timeBucket
    )}.json`;

  const finalPath =
    path.join(
      SNAPSHOT_DIR,
      filename
    );

  const tempPath =
    finalPath +
    ".tmp";

  const payload = {
    routeHash,

    timeBucket,

    updatedAt:
      new Date()
        .toISOString(),

    risk,
  };

  await fs.writeFile(
    tempPath,
    JSON.stringify(
      payload,
      null,
      2
    ),
    "utf8"
  );

  await fs.rename(
    tempPath,
    finalPath
  );
}


async function processJob(
  jobPath,
  modules
) {
  let raw;

  try {
    raw =
      await fs.readFile(
        jobPath,
        "utf8"
      );

  } catch (error) {
    await log(
      "[worker] cannot read job",
      jobPath,
      error.message
    );

    return;
  }


  /*
   * Delete immediately after reading.
   *
   * If the same route is requested again
   * while this job is running, server can
   * create a new pending job file.
   */
  try {
    await fs.unlink(
      jobPath
    );
  } catch {
    // Ignore.
  }


  let job;

  try {
    job =
      JSON.parse(
        raw
      );

  } catch (error) {
    await log(
      "[worker] invalid job JSON",
      error.message
    );

    return;
  }


  const riskArgs =
    job?.riskArgs;

  const routeHash =
    String(
      riskArgs?.routeHash ||
      ""
    ).trim();

  if (
    !routeHash ||
    !Array.isArray(
      riskArgs?.matchedSections
    ) ||
    !riskArgs
      .matchedSections
      .length
  ) {
    await log(
      "[worker] invalid route job",
      routeHash
    );

    return;
  }


  const {
    getHistoricalRoadBucket,
    assessHistoricalRisk,
  } =
    modules;


  await log(
    "[worker] START",
    {
      routeHash:
        routeHash.slice(
          0,
          16
        ),

      sections:
        riskArgs
          .matchedSections
          .length,

      sources:
        job
          .historicalSources,
    }
  );


  /*
   * First check:
   * SQLite + already-cached Historical.
   *
   * This happens ONLY in the child process,
   * never inside /api/route.
   */
  let risk;

  /*
   * HISTORICAL_TWO_STAGE_8_TO_20_V1
   *
   * <8  = urgent, target 8
   * 8-19 = enrichment, target 20
   */
  let phaseTargetUniqueDays = 20;

  try {
    risk =
      await assessHistoricalRisk(
        riskArgs
      );

  } catch (error) {
    await log(
      "[worker] initial risk failed",
      error.message
    );

    return;
  }


  let timeBucket =
    risk?.timeBucket ||
    job?.timeBucket ||
    null;


  if (
    timeBucket
  ) {
    await writeSnapshot({
      routeHash,
      timeBucket,
      risk,
    });
  }



  phaseTargetUniqueDays =
    Number(risk?.sampleCount || 0) < 8
      ? 8
      : 20;

if (
    Number(risk?.sampleCount || 0) >= phaseTargetUniqueDays
  ) {
    await log(
      "[worker] historical target already reached",
      {
        routeHash:
          routeHash.slice(
            0,
            16
          ),

        samples:
          risk.sampleCount,

        p90:
          risk.worst10Min,
      }
    );

    return;
  }


  /*
   * riskEngine normally returns the exact
   * 26 same-weekday dates it attempted.
   *
   * Fallback generation is here only in case
   * attemptedDates is absent.
   */
  const candidateDates =
    Array.isArray(
      risk?.attemptedDates
    ) &&
    risk.attemptedDates.length

      ? [
          ...new Set(
            risk
              .attemptedDates
          ),
        ].slice(
          0,
          26
        )

      : previousSameWeekdayDates(
          26
        );


  const sources =
    Array.isArray(
      job?.historicalSources
    )
      ? job.historicalSources
      : [];


  for (
    const date of
    candidateDates
  ) {
    if (
      Number(risk?.sampleCount || 0) >= phaseTargetUniqueDays
    ) {
      break;
    }


    await log(
      "[worker] date",
      {
        route:
          routeHash.slice(
            0,
            16
          ),

        date,

        samples:
          risk?.sampleCount ||
          0,

        target:
          phaseTargetUniqueDays,
      }
    );


        /*
     * Track network activity for THIS candidate date.
     */
    let dateTouchedRemote =
      false;

    let budgetPausedThisDate =
      false;


/*
     * Download only archives actually used
     * by this route:
     *
     * City/Taipei
     * Freeway
     * Highway
     * etc.
     */
    for (
      const source of
      sources
    ) {
      const scope =
        String(
          source?.scope ||
          ""
        )
          .trim()
          .toLowerCase();

      const city =
        String(
          source?.city ||
          ""
        ).trim();


      if (
        ![
          "city",
          "freeway",
          "highway",
        ].includes(
          scope
        )
      ) {
        continue;
      }


      if (
        scope === "city" &&
        !city
      ) {
        continue;
      }


      const label =
        scope === "city"
          ? `city:${city}`
          : scope;


      try {
        /*
         * First check LOCAL cache only.
         *
         * This happens before any possible
         * Historical network request.
         */
        const cachedBucket =
          await getHistoricalRoadBucket({
            scope,

            city,

            date,

            timeBucket,

            forceRefresh:
              false,

            cacheOnly:
              true,
          });


        if (
          cachedBucket
        ) {
          await log(
            "[worker] cache hit",
            label,
            date,
            timeBucket
          );

          continue;
        }


        /*
         * This source/date is not local.
         *
         * Never start another Historical archive
         * after the global worker budget is used.
         */
        /*
         * NO_COOLDOWN_UNTIL_8_V1
         *
         * Before 8 usable historical samples, keep
         * downloading without the normal archive budget pause.
         * Once 8 samples are ready, restore the normal
         * remote archive budget / cooldown protection.
         */
        if (
          remoteArchivesUsed >=
            REMOTE_ARCHIVE_BUDGET &&
          Number(risk?.sampleCount || 0) >= 8
        ) {
          budgetPausedThisDate =
            true;

          await log(
            "[worker] remote budget reached",
            {
              used:
                remoteArchivesUsed,

              budget:
                REMOTE_ARCHIVE_BUDGET,

              next:
                `${label} ${date}`,
            }
          );

          break;
        }


        /*
         * Count BEFORE contacting TDX.
         *
         * Failed network attempts also consume one
         * unit because they still touched TDX.
         */
        remoteArchivesUsed +=
          1;

        dateTouchedRemote =
          true;


        await log(
          "[worker] remote materialize",
          {
            source:
              label,

            date,

            timeBucket,

            used:
              remoteArchivesUsed,

            budget:
              REMOTE_ARCHIVE_BUDGET,
          }
        );


        const bucketResult =
          await getHistoricalRoadBucket({
            scope,

            city,

            date,

            timeBucket,

            forceRefresh:
              false,

            cacheOnly:
              false,
          });


        await log(
          "[worker] remote materialized",
          {
            source:
              label,

            date,

            unavailable:
              Boolean(
                bucketResult?.unavailable
              ),

            negativeCache:
              Boolean(
                bucketResult?.negativeCache
              ),

            used:
              remoteArchivesUsed,

            budget:
              REMOTE_ARCHIVE_BUDGET,
          }
        );

      } catch (error) {
        await log(
          "[worker] download failed",
          label,
          date,
          error.message
        );
      }

    }


    /*
     * Reconstruct risk after new Historical
     * cache is available.
     *
     * Your SQLite-enabled riskEngine also
     * upserts each reconstructed observation.
     */
    try {
      risk =
        await assessHistoricalRisk(
          riskArgs
        );

      timeBucket =
        risk?.timeBucket ||
        timeBucket;


      if (
        timeBucket
      ) {
        await writeSnapshot({
          routeHash,
          timeBucket,
          risk,
        });
      }


      await log(
        "[worker] recalculated",
        {
          samples:
            risk?.sampleCount ||
            0,

          status:
            risk?.riskStatus,

          p90:
            risk?.worst10Min,

          coverage:
            risk
              ?.historicalAverageTdxCoverageRatio,
        }
      );

    } catch (error) {
      await log(
        "[worker] recalc failed",
        error.message
      );
    }


    /*
     * Don't hammer TDX.
     */
    if (
      budgetPausedThisDate &&
      Number(risk?.sampleCount || 0) < phaseTargetUniqueDays
    ) {
      const cooldownState =
        await activateHistoricalCooldown({
          reason:
            "remote_archive_budget_exhausted",

          routeHash,

          timeBucket,
        });


      await ensureJobRequeued(
        jobPath,
        raw
      );


      await log(
        "[worker] PAUSED remote budget",
        {
          route:
            routeHash.slice(
              0,
              16
            ),

          samples:
            risk?.sampleCount ||
            0,

          target:
            phaseTargetUniqueDays,

          used:
            remoteArchivesUsed,

          budget:
            REMOTE_ARCHIVE_BUDGET,

          cooldownUntil:
            cooldownState
              .cooldownUntil,
        }
      );


      return {
        budgetExhausted:
          true,
      };
    }


    /*
     * Pure local cache dates continue immediately.
     *
     * Only actual remote Historical activity
     * receives the 2-second throttle.
     */
    if (
      Number(risk?.sampleCount || 0) < phaseTargetUniqueDays &&
      dateTouchedRemote
    ) {
      await log(
        "[worker] TDX throttle",
        {
          ms:
            2000,

          used:
            remoteArchivesUsed,

          budget:
            REMOTE_ARCHIVE_BUDGET,
        }
      );

      await sleep(
        2000
      );
    }
  }
  /*
   * Stage 1 -> Stage 2 handoff.
   *
   * The route is now usable at 8 days.
   * Requeue it for later enrichment to 20.
   */
  if (
    phaseTargetUniqueDays === 8 &&
    Number(risk?.sampleCount || 0) >= 8 &&
    Number(risk?.sampleCount || 0) < 20
  ) {
    risk = {
      ...(risk || {}),
      historicalBackfillComplete: false,
      historicalBackfillCompletedAt: null,
    };

    if (timeBucket) {
      await writeSnapshot({
        routeHash,
        timeBucket,
        risk,
      });
    }

    await fs.writeFile(
      jobPath,
      raw,
      'utf8'
    );

    await log(
      '[worker] MINIMUM READY - requeued for enrichment',
      {
        route: routeHash.slice(0, 16),
        samples: Number(risk?.sampleCount || 0),
        nextTarget: 20,
      }
    );

    return {
      yieldedForEnrichment: true,
    };
  }




  /*
   * Finished one complete background pass.
   *
   * It may have reached 20, or may have exhausted
   * the available lookback data below 20.
   */
  risk = {
    ...(risk || {}),

    historicalBackfillComplete:
      true,

    historicalBackfillCompletedAt:
      new Date().toISOString(),
  };

  if (
    timeBucket
  ) {
    await writeSnapshot({
      routeHash,
      timeBucket,
      risk,
    });
  }


  await log(
    "[worker] FINISHED",
    {
      route:
        routeHash.slice(
          0,
          16
        ),

      status:
        risk?.riskStatus,

      samples:
        risk?.sampleCount,

      p90:
        risk?.worst10Min,
    }
  );
}



async function queuedHistorySamples(filename) {
  try {
    const raw =
      await fs.readFile(
        path.join(
          SNAPSHOT_DIR,
          filename
        ),
        'utf8'
      );

    const payload = JSON.parse(raw);
    const n = Number(payload?.risk?.sampleCount || 0);

    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}


async function prioritizeHistoricalJobs(files) {
  const jobs =
    await Promise.all(
      files.map(
        async (filename) => {
          const samples =
            await queuedHistorySamples(filename);

          return {
            filename,
            samples,
            priority:
              samples < 8
                ? 0
                : samples < 20
                  ? 1
                  : 2,
          };
        }
      )
    );

  jobs.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.samples - b.samples ||
      a.filename.localeCompare(b.filename)
  );

  await log(
    '[worker] queue priority',
    {
      urgent:
        jobs.filter(x => x.samples < 8).length,

      enrichment:
        jobs.filter(
          x => x.samples >= 8 && x.samples < 20
        ).length,

      complete:
        jobs.filter(x => x.samples >= 20).length,
    }
  );

  return jobs.map(x => x.filename);
}


async function main() {
  await fs.mkdir(
    JOB_DIR,
    {
      recursive:
        true,
    }
  );

  await fs.mkdir(
    SNAPSHOT_DIR,
    {
      recursive:
        true,
    }
  );


  const locked =
    await acquireLock();

  /*
   * Another worker is already processing
   * the queue.
   */
  if (
    !locked
  ) {
    return;
  }


  const cooldown =
    await readHistoricalCooldown();


  if (
    cooldown.active
  ) {
    await log(
      "[worker] cooldown active",
      {
        cooldownUntil:
          cooldown.cooldownUntil,

        remainingMinutes:
          Math.max(
            1,
            Math.ceil(
              cooldown.remainingMs /
              60000
            )
          ),

        pendingJobsPreserved:
          true,
      }
    );


    await log(
      '[worker] automatic cooldown wait',
      {
        remainingSeconds:
          Math.ceil(
            Number(cooldown.remainingMs || 0) / 1000
          ),
      }
    );

    await sleep(
      Math.max(
        1000,
        Number(cooldown.remainingMs || 0) + 1000
      )
    );

    remoteArchivesUsed = 0;

    /*
     * readHistoricalCooldown() removes the expired
     * cooldown state.
     */
    await readHistoricalCooldown();

    await log(
      '[worker] cooldown expired - resuming queue'
    );
  }


  try {
    const historicalModule =
      await import(
        "./historicalTrafficClient.js"
      );

    const riskModule =
      await import(
        "./riskEngine.js"
      );

    const modules = {
      getHistoricalRoadBucket:
        historicalModule
          .getHistoricalRoadBucket,

      assessHistoricalRisk:
        riskModule
          .assessHistoricalRisk,
    };


    /*
     * Keep draining queue.
     *
     * Two empty scans 1 second apart mean
     * there are currently no more jobs.
     */
    let emptyScans = 0;

    while (
      emptyScans < 2
    ) {
      const files =
        (
          await fs.readdir(
            JOB_DIR
          )
        )
          .filter(
            (name) =>
              name.endsWith(
                ".json"
              )
          )
          .sort();

      const prioritizedFiles =
        await prioritizeHistoricalJobs(
          files
        );


      if (
        !files.length
      ) {
        emptyScans += 1;

        await sleep(
          1000
        );

        continue;
      }


      emptyScans = 0;


      for (
        const filename of prioritizedFiles
      ) {
        const jobPath =
          path.join(
            JOB_DIR,
            filename
          );

        try {
          const jobResult =
            await processJob(
              jobPath,
              modules
            );


          if (
            jobResult?.budgetExhausted ===
            true
          ) {
            await log(
              "[worker] queue drain paused",
              {
                reason:
                  "remote_archive_budget_exhausted",

                used:
                  remoteArchivesUsed,

                budget:
                  REMOTE_ARCHIVE_BUDGET,
              }
            );

            const resumeCooldown =
              await readHistoricalCooldown();

            if (resumeCooldown.active) {
              await log(
                '[worker] automatic cooldown resume scheduled',
                {
                  remainingSeconds:
                    Math.ceil(
                      Number(
                        resumeCooldown.remainingMs || 0
                      ) / 1000
                    ),
                }
              );

              await sleep(
                Math.max(
                  1000,
                  Number(
                    resumeCooldown.remainingMs || 0
                  ) + 1000
                )
              );
            }

            remoteArchivesUsed = 0;

            await readHistoricalCooldown();

            await log(
              '[worker] cooldown expired - queue resumes'
            );

            break;

          }

        } catch (error) {
          await log(
            "[worker] job crashed",
            filename,
            error.message,
            error.stack || ""
          );

          try {
            await fs.unlink(
              jobPath
            );
          } catch {
            // Ignore.
          }
        }
      }
    }

  } finally {
    await releaseLock();
  }
}


main()
  .catch(
    async (error) => {
      await log(
        "[worker] fatal",
        error.message,
        error.stack || ""
      );

      await releaseLock();

      process.exitCode =
        1;
    }
  );
