import {
  createRouteHash,
} from "./historicalDb.js";
import dotenv from "dotenv";

dotenv.config({
  override: true,
});
import express from "express";
import { createNavigationRouter } from "./navigationFeatures.js";
import { assessHistoricalRisk } from "./riskEngine.js";
import { assessAndRecordUncoveredPriorV9 } from "./uncoveredPriorV9.js";
import { buildTdxRoadIndex, buildTdxVdIndex, calculateTdxHybridEta } from "./tdxEtaEngine.js";
import { loadRouteVdObservations } from "./tdxVdRouteEngine.js";
import {
  resolvePlaceUniversal,
  reverseGeocodeCoordinate,
} from "./placeSearchEngine.js";
import { getValhallaRoutes } from "./valhallaClient.js";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { planMultiModalRoute } from "./multimodalRoutePlanner.js";
import { calculateRouteSpecificTraffic } from "./routeTrafficMatcher.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { calculateOpenLRRouteLevelTraffic } from "./openlrRouteMatcher.js";
import {
  openLrToPolyline,
  getCityVDStatic,
  getCityVDLive,
  getCitySectionShapes,
  getCitySectionLinks,
  getCityLiveTraffic,
} from "./tdxClient.js";

import {
  getTHSRStations,
  getTRAStations,
  findNextTHSRTrain,
  getMetroStations,
  getMetroLiveBoard,
  planMrtSameLineRoute,
} from "./tdxRealClient.js";

import {
  fetchTdxJson,
  getFreewayLiveTravelTimes,
  getFreewayLiveTraffic,
  getHighwayLiveTraffic,
  getFreewayLiveIncident,
  getHighwayLiveIncident,
  testTdxConnection,
  getFreewaySectionShapes,
  getHighwaySectionShapes,
  getFreewaySections,
  getHighwaySections,
} from "./tdxClient.js";
import {
  getHistoricalRoadBucket,
} from "./historicalTrafficClient.js";
import { countSignalsAlongRoute } from "./signalDelayCorrection.js";
import {
  calculateHistoricalGapSupplement,
  getEtaCalibrationCorrection,
  getEtaCalibrationSummary,
  recordEtaActualObservation,
} from "./etaCalibrationV5.js";
import {
  TAIWAN_TDX_JURISDICTIONS,
  canonicalizeTaiwanJurisdiction,
  resolveTaiwanJurisdictionFromReverse,
  loadTdxCityTrafficBundle,
  buildEtaCorridorKey,
} from "./etaSystemCore.js";
import {
  selectTdxLiveObservation,
} from "./etaEvidenceV6.js";
import {
  resolveRouteJurisdictions,
} from "./routeJurisdictionV7.js";
import { loadCityPackagesResilient } from "./cityCoverageV8_1.js";


const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "../frontend")));

const PORT = process.env.PORT || 3000;

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || "").trim();

const TDX_STATION_CACHE_MS = 6 * 60 * 60 * 1000;
const GEOCODE_CACHE_MS = 24 * 60 * 60 * 1000;
let tdxStationPoolsCache = null;
let tdxStationPoolsCacheAt = 0;
const geocodeCache = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function promiseWithTimeout(
  promise,
  timeoutMs,
  label
) {
  let timer;

  try {
    return await Promise.race([
      promise,

      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error =
            new Error(
              `${label} timed out after ${timeoutMs} ms`
            );

          error.code =
            "LOCAL_TIMEOUT";

          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
function resolveHistoricalTimeBucket(
  departureTime = null
) {
  const text =
    String(
      departureTime ||
      ""
    ).trim();

  /*
   * Supports:
   * 21:15
   * 2026-10-03T21:15
   */
  const match =
    text.match(
      /(?:^|T|\s)(\d{1,2}):(\d{2})/
    );

  if (
    match
  ) {
    const hour =
      Math.min(
        23,
        Math.max(
          0,
          Number(
            match[1]
          )
        )
      );

    const minute =
      Number(
        match[2]
      );

    return (
      `${String(
        hour
      ).padStart(
        2,
        "0"
      )}:` +
      (
        minute < 30
          ? "00"
          : "30"
      )
    );
  }


  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Taipei",

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

  const minute =
    Number(
      map.minute ||
      0
    );

  return (
    `${map.hour}:` +
    (
      minute < 30
        ? "00"
        : "30"
    )
  );
}


function safeHistoryName(
  value
) {
  return String(
    value ||
    "unknown"
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


async function readHistoricalRiskSnapshot({
  routeHash,
  departureTime,
}) {
  if (
    !routeHash
  ) {
    return null;
  }

  const timeBucket =
    resolveHistoricalTimeBucket(
      departureTime
    );

  const filePath =
    path.join(
      __dirname,
      "data",
      "route-risk-snapshots",

      `${safeHistoryName(
        routeHash
      )}__${safeHistoryName(
        timeBucket
      )}.json`
    );


  try {
    const text =
      await fs.readFile(
        filePath,
        "utf8"
      );

    const payload =
      JSON.parse(
        text
      );

    if (
      payload?.timeBucket !==
      timeBucket
    ) {
      return null;
    }

    return (
      payload?.risk ||
      null
    );

  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return null;
    }

    console.warn(
      "[history snapshot] read failed:",
      error.message
    );

    return null;
  }
}


async function readHistoricalRiskSnapshotByBucket({
  routeHash,
  timeBucket,
}) {
  const normalizedRouteHash =
    String(routeHash || "").trim();

  const normalizedBucket =
    String(timeBucket || "").trim();

  if (
    !normalizedRouteHash ||
    !/^\d{2}:(?:00|30)$/.test(normalizedBucket)
  ) {
    return null;
  }

  const filePath =
    path.join(
      __dirname,
      "data",
      "route-risk-snapshots",
      `${safeHistoryName(normalizedRouteHash)}__${safeHistoryName(normalizedBucket)}.json`
    );

  try {
    const text =
      await fs.readFile(
        filePath,
        "utf8"
      );

    const payload =
      JSON.parse(text);

    if (
      payload?.timeBucket !==
      normalizedBucket
    ) {
      return null;
    }

    return {
      risk:
        payload?.risk ||
        null,

      updatedAt:
        payload?.updatedAt ||
        null,
    };
  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return null;
    }

    console.warn(
      "[history status] snapshot read failed:",
      error.message
    );

    return null;
  }
}


async function enqueueHistoricalBackfill({
  riskArgs,
  matchedSectionsForRisk,
}) {
  const routeHash =
    String(
      riskArgs?.routeHash ||
      ""
    ).trim();

  if (
    !routeHash ||
    !Array.isArray(
      matchedSectionsForRisk
    ) ||
    !matchedSectionsForRisk.length
  ) {
    return;
  }


  const sourceMap =
    new Map();


  for (
    const section of
    matchedSectionsForRisk
  ) {
    const scope =
      String(
        section?.scope ||
        ""
      )
        .trim()
        .toLowerCase();

    const city =
      String(
        section?.city ||
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


    const key =
      scope === "city"
        ? `city:${city}`
        : scope;


    if (
      !sourceMap.has(
        key
      )
    ) {
      sourceMap.set(
        key,
        {
          scope,

          city:
            scope ===
              "city"
              ? city
              : "",
        }
      );
    }
  }


  const historicalSources =
    [
      ...sourceMap.values(),
    ];


  if (
    !historicalSources.length
  ) {
    return;
  }


  const timeBucket =
    resolveHistoricalTimeBucket(
      riskArgs.departureTime
    );


  const jobDir =
    path.join(
      __dirname,
      "data",
      "history-jobs"
    );


  await fs.mkdir(
    jobDir,
    {
      recursive:
        true,
    }
  );


  /*
   * One pending job per route + time bucket.
   *
   * Repeated clicking won't create hundreds
   * of duplicate jobs.
   */
  const jobPath =
    path.join(
      jobDir,

      `${safeHistoryName(
        routeHash
      )}__${safeHistoryName(
        timeBucket
      )}.json`
    );


  const job = {
    createdAt:
      new Date()
        .toISOString(),

    timeBucket,

    historicalSources,

    riskArgs:
      JSON.parse(
        JSON.stringify(
          riskArgs
        )
      ),
  };


  await fs.writeFile(
    jobPath,
    JSON.stringify(
      job,
      null,
      2
    ),
    "utf8"
  );


  /*
   * Start a completely separate Node process.
   *
   * No await.
   * No Historical parsing in Express process.
   */
  const child =
    spawn(
      process.execPath,

      [
        path.join(
          __dirname,
          "historicalBackfillWorker.js"
        ),
      ],

      {
        cwd:
          __dirname,

        detached:
          true,

        stdio:
          "ignore",

        env:
          process.env,
      }
    );


  child.unref();


  console.log(
    "[history queue] queued",
    {
      route:
        routeHash.slice(
          0,
          16
        ),

      timeBucket,

      sources:
        historicalSources,
    }
  );
}
console.log("Groq Key:", GROQ_API_KEY ? "Loaded" : "Missing");
console.log("Geocoding: Photon coordinates + Photon reverse; Groq text normalization only");
console.log(
  "Routing: Valhalla primary + TDX positive-delay layer; OSRM final fallback"
);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({
  skip: (req) =>
    req.path === "/place-suggest",
  windowMs: 60 * 1000,
  max: 60,
  message: {
    error: "Too many requests. Please try again later.",
  },
});

app.use("/api", limiter);
app.use('/api/navigation', createNavigationRouter());

/*
 * Lightweight polling endpoint for the frontend.
 *
 * It only reads tiny precomputed route-risk snapshots.
 * It never downloads or parses TDX Historical archives.
 */
app.post("/api/history-status", async (req, res) => {
  try {
    /*
     * HISTORICAL_ACTIVE_ROUTE_PRIORITY_V1
     *
     * The frontend tells us which selected route currently
     * needs its minimum 8 usable Historical days first.
     */
    const activeRoute =
      req.body?.activeRoute ||
      null;

    const activeRouteHash =
      String(
        activeRoute?.routeHash ||
        ""
      ).trim();

    const activeTimeBucket =
      String(
        activeRoute?.timeBucket ||
        ""
      ).trim();

    const activeHistoryPath =
      path.join(
        __dirname,
        "data",
        "active-history-route.json"
      );

    if (
      activeRouteHash &&
      /^\d{2}:(?:00|30)$/.test(
        activeTimeBucket
      )
    ) {
      await fs.mkdir(
        path.dirname(
          activeHistoryPath
        ),
        {
          recursive: true,
        }
      );

      await fs.writeFile(
        activeHistoryPath,
        JSON.stringify(
          {
            routeHash:
              activeRouteHash,

            timeBucket:
              activeTimeBucket,

            updatedAt:
              new Date()
                .toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );

    } else {
      try {
        await fs.unlink(
          activeHistoryPath
        );
      } catch (error) {
        if (
          error?.code !==
          "ENOENT"
        ) {
          throw error;
        }
      }
    }


    const requests =
      Array.isArray(req.body?.routes)
        ? req.body.routes.slice(0, 10)
        : [];

    const results = [];

    for (const item of requests) {
      const routeId =
        item?.routeId ??
        null;

      const routeHash =
        String(
          item?.routeHash ||
          ""
        ).trim();

      const timeBucket =
        String(
          item?.timeBucket ||
          ""
        ).trim();

      const snapshot =
        await readHistoricalRiskSnapshotByBucket({
          routeHash,
          timeBucket,
        });

      results.push({
        routeId,
        routeHash,
        timeBucket,
        snapshotAvailable:
          Boolean(snapshot?.risk),
        updatedAt:
          snapshot?.updatedAt ||
          null,
        risk:
          snapshot?.risk ||
          null,
      });
    }

    res.json({
      status: "ok",
      results,
    });
  } catch (error) {
    console.error(
      "History status API error:",
      error
    );

    res.status(500).json({
      status: "error",
      error:
        "Failed to read historical status",
      detail:
        error.message,
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    osrm: OSRM_BASE_URL,
    geocoding: "Groq text normalization + Photon grounded coordinates/reverse geocoding",
    routing: "TDX observed live sections + OSRM uncovered-road fallback",
    timeZone: "Asia/Taipei",
  });
});


app.get("/api/architecture", (req, res) => {
  res.json({
    placeSearch: {
      aiRole:
        "normalize names / aliases / city / place type only",

      coordinatePolicy:
        "AI never generates coordinates",

      primarySources: [
        "TDX rail / metro",
        "TDX Tourism",
        "TDX advanced address geocoding"
      ],

      fallback:
        "AI normalization only after raw place search fails"
    },

    driving: {
      routeGeometry:
        "OSRM",

      expectedEta:
        "TDX TravelTime / TravelSpeed on matched road pieces + OSRM baseline only for uncovered pieces",

      artificialTrafficMultiplier:
        false,

      timeOfDayMultiplier:
        false,

      urbanMultiplier:
        false,

      incidentMinutePenalty:
        false
    },

    risk: {
      guessedCV:
        false,

      inventedWorst10:
        false,

      method:
        "empirical same-route historical TDX-informed observations",

      insufficientHistory:
        "return null"
    }
  });
});

app.get("/api/tdx-token-test", async (req, res) => {
  try {
    const result = await testTdxConnection();

    res.json({
      status: "ok",
      message: "TDX token successfully received",
      result,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "TDX connection failed",
      detail: error.message,
    });
  }
});


app.get("/api/tdx-city-vd-test", async (req, res) => {
  try {
    const city =
      String(
        req.query.city ||
        "Taipei"
      ).trim();

    const staticData =
      await getCityVDStatic(city);

    const vds =
      extractVdStaticListForRoadMetadata(
        staticData
      );

    if (!vds.length) {
      return res.status(404).json({
        status: "error",
        city,
        message:
          "TDX city VD static list is empty",
        staticTopLevelKeys:
          staticData &&
          typeof staticData === "object"
            ? Object.keys(staticData)
            : [],
      });
    }


    function inspectPayload(data) {
      const arrays = [];

      if (Array.isArray(data)) {
        arrays.push({
          key: "<root>",
          count: data.length,
          firstItem: data[0] || null,
        });
      }

      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data)
      ) {
        for (
          const [key, value]
          of Object.entries(data)
        ) {
          if (Array.isArray(value)) {
            arrays.push({
              key,
              count: value.length,
              firstItem:
                value[0] || null,
            });
          }
        }
      }

      return {
        type:
          Array.isArray(data)
            ? "array"
            : typeof data,

        topLevelKeys:
          data &&
          typeof data === "object"
            ? Object.keys(data)
            : [],

        arrays,
      };
    }


    /*
     * Test a few devices rather than only one.
     * One broken/offline VD must not make us conclude
     * the whole city has no live feed.
     */
    const sampleVds =
      vds.slice(0, 3);

    const liveResults =
      await Promise.allSettled(
        sampleVds.map(
          async (vd) => {
            const vdId =
              String(
                vd?.VDID || ""
              ).trim();

            const liveData =
              await getCityVDLive(
                city,
                vdId
              );

            return {
              vdId,

              roadName:
                vd?.RoadName ||
                null,

              position:
                vd?.Position ||
                vd?.VDPosition ||
                null,

              detectionLinks:
                Array.isArray(
                  vd?.DetectionLinks
                )
                  ? vd.DetectionLinks
                      .slice(0, 5)
                  : [],

              livePayload:
                inspectPayload(
                  liveData
                ),
            };
          }
        )
      );


    res.json({
      status: "ok",
      city,

      staticCount:
        vds.length,

      staticTopLevelKeys:
        staticData &&
        typeof staticData === "object"
          ? Object.keys(staticData)
          : [],

      staticFirstItem:
        vds[0] || null,

      liveSamples:
        liveResults.map(
          (result) =>
            result.status ===
            "fulfilled"
              ? {
                  status:
                    "fulfilled",
                  ...result.value,
                }
              : {
                  status:
                    "rejected",
                  error:
                    result.reason
                      ?.message ||
                    "unknown error",
                }
        ),
    });

  } catch (error) {
    res.status(500).json({
      status: "error",
      message:
        "TDX city VD test failed",
      detail:
        error.message,
    });
  }
});


app.get("/api/tdx-live-sample", async (req, res) => {
  try {
    const data = await getFreewayLiveTravelTimes();

    res.json({
      status: "ok",
      message: "TDX raw structure loaded",
      dataType: Array.isArray(data) ? "array" : typeof data,
      topLevelKeys: data && typeof data === "object" ? Object.keys(data) : [],
      rawPreview: data,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to load TDX live traffic sample",
      detail: error.message,
    });
  }
});

app.get("/api/tdx-sources-test", async (req, res) => {
  const results = {};

  async function testSource(name, fetchFunction) {
    try {
      const data = await fetchFunction();

      let count = 0;
      let sample = [];

      if (Array.isArray(data)) {
        count = data.length;
        sample = data.slice(0, 2);
      } else if (data && typeof data === "object") {
        const keys = Object.keys(data);

        for (const key of keys) {
          if (Array.isArray(data[key])) {
            count = data[key].length;
            sample = data[key].slice(0, 2);
            break;
          }
        }
      }

      results[name] = {
        ok: true,
        dataType: Array.isArray(data) ? "array" : typeof data,
        topLevelKeys: data && typeof data === "object" ? Object.keys(data) : [],
        count,
        sample,
      };
    } catch (error) {
      results[name] = {
        ok: false,
        error: error.message,
      };
    }
  }

  await testSource("freewayTravelTime", getFreewayLiveTravelTimes);
  await testSource("freewayLiveTraffic", getFreewayLiveTraffic);
  await testSource("highwayLiveTraffic", getHighwayLiveTraffic);
  await testSource("freewayIncident", getFreewayLiveIncident);
  await testSource("highwayIncident", getHighwayLiveIncident);

  res.json({
    status: "ok",
    message: "TDX source test completed",
    results,
  });
});

// 單段風險預測導航 API
// 單段風險預測導航 API
// Expected ETA uses matched real TDX live observations + OSRM uncovered fallback.
// Risk / Worst 10% / Variance use empirical TDX Historical route samples only.
// =========================================================
// ETA ACTUAL-TRIP CALIBRATION
// =========================================================
app.post("/api/eta-feedback", (req, res) => {
  try {
    const body = req.body || {};
    let actualMin = Number(body.actualMin);

    if (
      !Number.isFinite(actualMin) &&
      body.departedAt &&
      body.arrivedAt
    ) {
      const departedMs = Date.parse(body.departedAt);
      const arrivedMs = Date.parse(body.arrivedAt);

      if (
        Number.isFinite(departedMs) &&
        Number.isFinite(arrivedMs) &&
        arrivedMs > departedMs
      ) {
        actualMin = (arrivedMs - departedMs) / 60000;
      }
    }

    const actualDepartureAt =
      body.departedAt && Number.isFinite(Date.parse(body.departedAt))
        ? new Date(body.departedAt)
        : null;

    const saved = recordEtaActualObservation({
      tripId: body.tripId,
      routeHash: body.routeHash,
      corridorKey: body.corridorKey,
      originJurisdiction: body.originJurisdiction,
      destinationJurisdiction: body.destinationJurisdiction,
      distanceKm: body.distanceKm,
      // Completed trips are bucketed by the ACTUAL departure timestamp.
      // Planned departureTime is used only for manual feedback without a
      // departedAt timestamp.
      departureTime: actualDepartureAt ? null : body.departureTime,
      observedAt: actualDepartureAt || new Date(),
      preCalibrationExpectedMin: body.preCalibrationExpectedMin,
      actualMin,
      matchedCoverageRatio: body.matchedCoverageRatio,
      travelTimeCoverageRatio: body.travelTimeCoverageRatio,
      effectiveAdjustedCoverageRatio:
        body.effectiveAdjustedCoverageRatio,
      signalCount: body.signalCount,
    });

    return res.json({
      status: "ok",
      saved,
      calibration: getEtaCalibrationCorrection({
        routeHash: saved.routeHash,
        corridorKey: saved.corridorKey,
        departureTime: actualDepartureAt ? null : body.departureTime,
        date: actualDepartureAt || new Date(),
        preCalibrationExpectedMin:
          saved.preCalibrationExpectedMin,
      }),
    });
  } catch (error) {
    return res.status(400).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/eta-calibration", (req, res) => {
  try {
    return res.json({
      status: "ok",
      summary: getEtaCalibrationSummary({
        routeHash: req.query.routeHash || null,
        corridorKey: req.query.corridorKey || null,
      }),
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// Groq + TDX grounded geocoding：AI 只導正文字，不產生座標
// TDX-only smart geocoding.
// Search order: raw coordinates -> TDX rail/metro station -> TDX Advanced Geocoding.
// No Google billing and no public Nominatim dependency.
app.get("/api/smart-geocode", async (req, res) => {
  try {
    const payload =
      await resolvePlaceUniversal({
        query:
          req.query.q,

        groqApiKey:
          GROQ_API_KEY,

        nearLat:
          req.query.nearLat,

        nearLon:
          req.query.nearLon
      });

    res.json(payload);

  } catch (error) {

    console.error(
      "Smart geocode error:",
      error
    );

    res
      .status(
        error?.status ||
        500
      )
      .json({
        error:
          "Smart geocode failed",

        detail:
          error.message
      });
  }
});
// ── AUTOCOMPLETE（打字即時建議）──────────────────────
app.get("/api/autocomplete", async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (q.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const photonRes = await fetchWithTimeout(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=zh&limit=7&bbox=120.0,21.5,122.1,25.5`,
      {},
      5000
    );
    const data = await photonRes.json();

    const suggestions = (data.features || [])
      .filter(f => {
        const lat = f.geometry.coordinates[1];
        const lon = f.geometry.coordinates[0];
        return lat >= 21 && lat <= 27 && lon >= 118 && lon <= 124;
      })
      .map(f => {
        const p = f.properties;
        const parts = [p.name, p.district, p.city || p.county]
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i); // 去重
        return {
          displayName: parts.join("，"),
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          type: p.type || "place",
        };
      })
      .filter(s => s.displayName);

    res.json({ suggestions });

  } catch (e) {
    res.json({ suggestions: [] });
  }
});


// ============================================================
// RISK_NAV_AUTOCOMPLETE_V1
// ============================================================

const PLACE_SUGGEST_CACHE_MS =
  5 * 60 * 1000;

const placeSuggestCache =
  new Map();


function normalizeSuggestText(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /臺/g,
      "台"
    )
    .replace(
      /[\s,，.。\-_/()（）]/g,
      ""
    );
}


function scorePlaceSuggestion(
  candidate,
  query
) {
  const q =
    normalizeSuggestText(
      query
    );

  const name =
    normalizeSuggestText(
      candidate?.displayName ||
      candidate?.name
    );

  const address =
    normalizeSuggestText(
      candidate?.address
    );

  let score =
    Number(
      candidate?.matchScore ||
      0
    );

  if (
    q &&
    name === q
  ) {
    score += 300;

  } else if (
    q &&
    name.startsWith(q)
  ) {
    score += 220;

  } else if (
    q &&
    name.includes(q)
  ) {
    score += 160;

  } else if (
    q &&
    address.includes(q)
  ) {
    score += 80;
  }

  return score;
}


function autocompleteCandidate(
  candidate,
  query
) {
  const lat =
    Number(
      candidate?.lat ??
      candidate?.latitude
    );

  const lon =
    Number(
      candidate?.lon ??
      candidate?.lng ??
      candidate?.longitude
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }

  const displayName =
    String(
      candidate?.displayName ||
      candidate?.name ||
      candidate?.address ||
      ""
    ).trim();

  if (!displayName) {
    return null;
  }

  return {
    lat,
    lon,

    displayName,

    address:
      candidate?.address ||
      null,

    city:
      candidate?.administrativeCity ||
      candidate?.city ||
      candidate?.county ||
      null,

    locationType:
      candidate?.locationType ||
      "place",

    source:
      candidate?.source ||
      "Grounded place search",

    score:
      scorePlaceSuggestion(
        candidate,
        query
      ),
  };
}


app.get("/api/place-suggest", async (req, res) => {
  const query =
    String(
      req.query.q ||
      ""
    ).trim();

  if (!query) {
    return res.json({
      status:
        "ok",

      query,

      suggestions:
        [],
    });
  }


  const hasHan =
    /[\u3400-\u9fff]/
      .test(query);

  if (
    query.length <
    (
      hasHan
        ? 1
        : 2
    )
  ) {
    return res.json({
      status:
        "ok",

      query,

      suggestions:
        [],
    });
  }


  const cacheKey =
    [
      query.toLowerCase(),

      req.query.nearLat ||
      "",

      req.query.nearLon ||
      "",
    ].join("|");


  const cached =
    placeSuggestCache
      .get(
        cacheKey
      );

  if (
    cached &&
    Date.now() -
      cached.at <
      PLACE_SUGGEST_CACHE_MS
  ) {
    return res.json({
      status:
        "ok",

      query,

      cached:
        true,

      suggestions:
        cached.suggestions,
    });
  }


  /*
   * The first search is always exactly what
   * the user typed.
   *
   * For short city/station-like input, also
   * try common transit completions.
   *
   * Example:
   * 桃園
   * → 桃園
   * → 桃園車站
   * → 桃園高鐵站
   * → 桃園捷運站
   *
   * All returned coordinates still come from
   * the normal grounded resolver.
   */
  const variants =
    [
      query,
    ];


  const stationLike =
    /高鐵|捷運|火車|車站|站$/u
      .test(query);

  const cityLike =
    /台北|臺北|新北|桃園|新竹|苗栗|台中|臺中|彰化|雲林|嘉義|台南|臺南|高雄|基隆|宜蘭|花蓮|台東|臺東/u
      .test(query);


  if (
    cityLike &&
    !stationLike
  ) {
    variants.push(
      `${query}車站`,
      `${query}高鐵站`,
      `${query}捷運站`
    );
  }


  const uniqueVariants =
    [...new Set(
      variants
    )];


  const settled =
    await Promise.allSettled(
      uniqueVariants.map(
        variant =>
          resolvePlaceUniversal({
            query:
              variant,

            groqApiKey:
              GROQ_API_KEY,

            nearLat:
              req.query.nearLat,

            nearLon:
              req.query.nearLon,
          })
      )
    );


  const collected =
    [];


  for (
    const result
    of settled
  ) {
    if (
      result.status !==
      "fulfilled"
    ) {
      continue;
    }


    const payload =
      result.value;


    const candidates =
      [
        payload?.result,

        ...(
          Array.isArray(
            payload?.candidates
          )
            ? payload.candidates
            : []
        ),
      ]
        .filter(Boolean);


    for (
      const candidate
      of candidates
    ) {
      const item =
        autocompleteCandidate(
          candidate,
          query
        );

      if (item) {
        collected.push(
          item
        );
      }
    }
  }


  /*
   * Deduplicate by coordinates + name.
   */
  const seen =
    new Set();

  const suggestions =
    collected
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .filter(
        item => {
          const key =
            [
              item.displayName,
              item.lat.toFixed(5),
              item.lon.toFixed(5),
            ]
              .join("|");

          if (
            seen.has(key)
          ) {
            return false;
          }

          seen.add(key);
          return true;
        }
      )
      .slice(
        0,
        Math.max(
          1,
          Math.min(
            Number(
              req.query.limit ||
              8
            ),
            10
          )
        )
      );


  placeSuggestCache.set(
    cacheKey,
    {
      at:
        Date.now(),

      suggestions,
    }
  );


  /*
   * Bound the cache.
   */
  if (
    placeSuggestCache.size >
    500
  ) {
    const firstKey =
      placeSuggestCache
        .keys()
        .next()
        .value;

    placeSuggestCache.delete(
      firstKey
    );
  }


  return res.json({
    status:
      "ok",

    query,

    cached:
      false,

    suggestions,
  });
});



// =========================================================
// REAL TDX LIVE TRAFFIC MATCHING
// =========================================================
// ETA policy in this version:
// 1. OSRM is used only for route geometry and the baseline time of road pieces
//    where TDX has no live observation.
// 2. TDX city published-section LiveTraffic + SectionShape are map-matched to
//    the actual OSRM route. A matched piece uses TDX TravelTime/TravelSpeed.
// 3. TDX freeway/highway live OpenLR is also map-matched to the route.
// 4. No time-of-day multiplier, no urban speed ceiling, no congestion-level
//    multiplier, and no incident penalty is applied to Expected ETA.
// 5. The response always reports live-data coverage. Uncovered road stays OSRM.


/*
 * =========================================================
 * COORDINATE-FIRST ADMINISTRATIVE AREA RESOLUTION
 * =========================================================
 *
 * Old implementation used large overlapping bounding boxes.
 *
 * Taipei and New Taipei overlap heavily, therefore places
 * such as Banqiao / Zhonghe could incorrectly become Taipei.
 *
 * Now:
 *
 * route geometry coordinate
 *        ↓
 * Photon Reverse Geocoding
 *        ↓
 * real administrative city/county
 *        ↓
 * TDX city code
 *
 * No rectangle guessing.
 */

async function routeCandidateCities(route) {
  const result = await resolveRouteJurisdictions({
    route,
    reverseGeocodeCoordinate,
    resolveJurisdictionFromReverse: resolveTaiwanJurisdictionFromReverse,
    maxSamples: Math.max(4, Math.min(22, Number(process.env.TDX_ROUTE_JURISDICTION_SAMPLES || 12))),
    concurrency: Math.max(1, Math.min(4, Number(process.env.TDX_ROUTE_REVERSE_CONCURRENCY || 2))),
    retries: Math.max(0, Math.min(4, Number(process.env.TDX_ROUTE_REVERSE_RETRIES || 2))),
  });

  route.__jurisdictionDiagnostics = result.diagnostics;

  // UNCOVERED_PRIOR_V9_JURISDICTION_SAMPLES
  route.__jurisdictionSamples =
    (result.samples || [])
      .map((item) => ({
        point:
          item?.point ||
          null,

        jurisdiction:
          item?.jurisdiction ||
          null,
      }))
      .filter(
        (item) =>
          item.point &&
          item.jurisdiction
      );

  console.log("[route jurisdiction resolution]", {
    jurisdictions: result.jurisdictions,
    diagnostics: result.diagnostics,
    samples: result.samples.map((item) => ({
      point: item?.point || null,
      jurisdiction: item?.jurisdiction || null,
      source: item?.source || null,
      city: item?.reverse?.city || null,
      county: item?.reverse?.county || null,
      municipality: item?.reverse?.municipality || null,
      subdivision: item?.reverse?.subdivision || null,
    })),
  });

  return result.jurisdictions;
}


function routePointDistanceKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractSectionShapes(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.SectionShapes)) return data.SectionShapes;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractSectionLinks(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.SectionLinks)) return data.SectionLinks;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractLiveTraffics(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.LiveTraffics)) return data.LiveTraffics;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function parseCoordinatePair(value) {
  const pieces = String(value || "").trim().split(/\s+/);
  if (pieces.length < 2) return null;
  const lon = Number(pieces[0]);
  const lat = Number(pieces[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lat < 21.5 || lat > 26.5 || lon < 118 || lon > 123.5) return null;
  return { lon, lat };
}

function parseWktPolylines(geometry) {
  if (!geometry) return [];

  if (typeof geometry === "object") {
    if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
      const line = geometry.coordinates
        .map((p) => ({ lon: Number(p?.[0]), lat: Number(p?.[1]) }))
        .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
      return line.length >= 2 ? [line] : [];
    }

    if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates
        .map((line) =>
          (line || [])
            .map((p) => ({ lon: Number(p?.[0]), lat: Number(p?.[1]) }))
            .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
        )
        .filter((line) => line.length >= 2);
    }
  }

  let text = String(geometry).trim();
  text = text.replace(/^SRID=\d+;/i, "");

  if (/^LINESTRING/i.test(text)) {
    const start = text.indexOf("(");
    const end = text.lastIndexOf(")");
    if (start < 0 || end <= start) return [];
    const line = text
      .slice(start + 1, end)
      .split(",")
      .map(parseCoordinatePair)
      .filter(Boolean);
    return line.length >= 2 ? [line] : [];
  }

  if (/^MULTILINESTRING/i.test(text)) {
    const lines = [];
    const matches = text.matchAll(/\(([^()]+)\)/g);
    for (const match of matches) {
      const line = String(match[1] || "")
        .split(",")
        .map(parseCoordinatePair)
        .filter(Boolean);
      if (line.length >= 2) lines.push(line);
    }
    return lines;
  }

  // Some providers return only the comma-separated coordinates without the
  // LINESTRING keyword.
  if (/\d+\.\d+\s+\d+\.\d+/.test(text)) {
    const line = text
      .replace(/[()]/g, "")
      .split(",")
      .map(parseCoordinatePair)
      .filter(Boolean);
    return line.length >= 2 ? [line] : [];
  }

  return [];
}

function polylineLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += routePointDistanceKm(
      points[i - 1].lon,
      points[i - 1].lat,
      points[i].lon,
      points[i].lat
    );
  }
  return total;
}

function bearingDeg(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function angleDiffDeg(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function pointToSegmentDistanceKm(point, a, b) {
  const refLatRad = (point.lat * Math.PI) / 180;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos(refLatRad);

  const px = point.lon * kmPerDegLon;
  const py = point.lat * kmPerDegLat;
  const ax = a.lon * kmPerDegLon;
  const ay = a.lat * kmPerDegLat;
  const bx = b.lon * kmPerDegLon;
  const by = b.lat * kmPerDegLat;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  if (!lenSq) return Math.hypot(px - ax, py - ay);

  const t = clampNumber((apx * abx + apy * aby) / lenSq, 0, 1);
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function normalizeId(value) {
  return String(value || "").trim();
}

function getExplicitLinkIds(sectionLink) {
  const result = [];
  const containers = [
    sectionLink?.LinkIDs,
    sectionLink?.Links?.LinkIDs,
    sectionLink?.Links,
  ];

  for (const container of containers) {
    if (!container) continue;

    if (Array.isArray(container)) {
      for (const item of container) {
        const id = normalizeId(item?.LinkID ?? item);
        if (id) result.push(id);
      }
      continue;
    }

    if (Array.isArray(container?.LinkID)) {
      for (const item of container.LinkID) {
        const id = normalizeId(item?.LinkID ?? item);
        if (id) result.push(id);
      }
      continue;
    }

    const single = normalizeId(container?.LinkID);
    if (single) result.push(single);
  }

  return [...new Set(result)];
}

function latestIsoTime(items) {
  let best = null;
  let bestMs = -Infinity;
  for (const item of items) {
    const value = item?.DataCollectTime || item?.dataCollectTime || item?.UpdateTime || item?.updateTime || null;
    const ms = Date.parse(value || "");
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

function liveAgeMin(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / 60000;
}

function isFreshLive(item, maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20)) {
  const value = item?.DataCollectTime || item?.UpdateTime;
  const requireTimestamp = process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0";
  if (!value) return !requireTimestamp;
  const age = liveAgeMin(value);
  if (!Number.isFinite(age)) return !requireTimestamp;
  return age >= -2 && age <= maxAgeMin;
}

function buildCityObservedSections(city, shapeData, sectionLinkData, liveData) {
  const shapes = extractSectionShapes(shapeData);
  const sectionLinks = extractSectionLinks(sectionLinkData);
  const allLives = extractLiveTraffics(liveData);
  const lives = allLives.filter((item) => isFreshLive(item));

  const directBySection = new Map();
  const byLink = new Map();

  for (const live of lives) {
    const sectionId = normalizeId(live?.SectionID || live?.SectionUID);
    const linkId = normalizeId(live?.LinkID);
    if (sectionId) directBySection.set(sectionId, live);
    if (linkId) byLink.set(linkId, live);
  }

  const linkIdsBySection = new Map();
  for (const item of sectionLinks) {
    const sectionId = normalizeId(item?.SectionID || item?.SectionUID);
    if (!sectionId) continue;
    const ids = getExplicitLinkIds(item);
    if (ids.length) linkIdsBySection.set(sectionId, ids);
  }

  const observedSections = [];
  const qualityCounts = { high: 0, medium: 0, low: 0, rejected: 0 };

  for (const shape of shapes) {
    const sectionId = normalizeId(shape?.SectionID || shape?.SectionUID);
    if (!sectionId) continue;

    const polylines = parseWktPolylines(shape?.Geometry || shape?.geometry);
    if (!polylines.length) continue;

    const sectionLengthKm = polylines.reduce(
      (sum, line) => sum + polylineLengthKm(line),
      0
    );
    if (!Number.isFinite(sectionLengthKm) || sectionLengthKm <= 0.02) continue;

    let live = directBySection.get(sectionId) || null;
    let source = "SectionID";
    let dataCollectTime = live?.DataCollectTime || live?.UpdateTime || null;
    let travelTimeSec = Number(live?.TravelTime);
    let travelSpeedKmh = Number(live?.TravelSpeed);
    let dataSources = live?.DataSources || null;
    let constituentLiveCount = live ? 1 : 0;

    if (!live) {
      const linkIds = linkIdsBySection.get(sectionId) || [];
      const linkLives = linkIds.map((id) => byLink.get(id)).filter(Boolean);

      if (linkIds.length && linkLives.length === linkIds.length) {
        source = "LinkID aggregate";
        constituentLiveCount = linkLives.length;
        dataCollectTime = latestIsoTime(linkLives);

        const validTimes = linkLives
          .map((item) => Number(item?.TravelTime))
          .filter((value) => Number.isFinite(value) && value > 0);

        const validSpeeds = linkLives
          .map((item) => Number(item?.TravelSpeed))
          .filter((value) => Number.isFinite(value) && value >= 1 && value <= 160);

        travelTimeSec =
          validTimes.length === linkLives.length
            ? validTimes.reduce((sum, value) => sum + value, 0)
            : NaN;

        travelSpeedKmh = validSpeeds.length
          ? validSpeeds.reduce((sum, value) => sum + value, 0) / validSpeeds.length
          : NaN;

        dataSources = linkLives.map((item) => item?.DataSources).filter(Boolean);
      }
    }

    if (!live && source === "SectionID") continue;

    const evidence = selectTdxLiveObservation({
      dataCollectTime,
      travelTimeSec,
      sectionLengthKm,
      travelSpeedKmh,
      maxAgeMin: Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20),
      requireTimestamp: process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0",
    });

    if (!evidence.accepted) {
      qualityCounts.rejected += 1;
      continue;
    }

    qualityCounts[evidence.confidence] =
      (qualityCounts[evidence.confidence] || 0) + 1;

    observedSections.push({
      city,
      sectionId,
      polylines,
      sectionLengthKm,
      observedSpeedKmh: evidence.observedSpeedKmh,
      observedFrom: evidence.observedFrom,
      travelTimeSec: Number.isFinite(travelTimeSec) ? travelTimeSec : null,
      travelSpeedKmh: Number.isFinite(travelSpeedKmh) ? travelSpeedKmh : null,
      congestionLevel: live?.CongestionLevel ?? null,
      congestionLevelID: live?.CongestionLevelID ?? null,
      dataCollectTime,
      dataAgeMin: evidence.dataAgeMin,
      evidenceConfidence: evidence.confidence,
      evidenceReason: evidence.reason,
      evidenceQualityScore: evidence.qualityScore,
      dataSources,
      constituentLiveCount,
      liveSource: source,
    });
  }

  return {
    city,
    observedSections,
    shapeCount: shapes.length,
    rawLiveCount: allLives.length,
    liveCount: lives.length,
    directSectionCount: directBySection.size,
    linkLiveCount: byLink.size,
    evidenceQualityCounts: qualityCounts,
  };
}

function gridKey(x, y) {
  return `${x}:${y}`;
}

function buildObservedSegmentIndex(citySectionPackages, cellDeg = 0.012) {
  const grid = new Map();
  let segmentCount = 0;

  for (const pkg of citySectionPackages) {
    for (const section of pkg.observedSections || []) {
      for (const line of section.polylines || []) {
        for (let i = 1; i < line.length; i += 1) {
          const a = line[i - 1];
          const b = line[i];
          const segment = {
            ...section,
            a,
            b,
            bearing: bearingDeg(a, b),
          };

          const minLon = Math.min(a.lon, b.lon);
          const maxLon = Math.max(a.lon, b.lon);
          const minLat = Math.min(a.lat, b.lat);
          const maxLat = Math.max(a.lat, b.lat);

          const x0 = Math.floor(minLon / cellDeg);
          const x1 = Math.floor(maxLon / cellDeg);
          const y0 = Math.floor(minLat / cellDeg);
          const y1 = Math.floor(maxLat / cellDeg);

          for (let x = x0; x <= x1; x += 1) {
            for (let y = y0; y <= y1; y += 1) {
              const key = gridKey(x, y);
              if (!grid.has(key)) grid.set(key, []);
              grid.get(key).push(segment);
            }
          }

          segmentCount += 1;
        }
      }
    }
  }

  return { grid, cellDeg, segmentCount };
}

function candidatesNearObserved(point, index) {
  const x = Math.floor(point.lon / index.cellDeg);
  const y = Math.floor(point.lat / index.cellDeg);
  const out = [];
  const seen = new Set();

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const segment of index.grid.get(gridKey(x + dx, y + dy)) || []) {
        if (seen.has(segment)) continue;
        seen.add(segment);
        out.push(segment);
      }
    }
  }

  return out;
}

function findObservedCitySection(routeChunk, index, thresholdKm = 0.05) {
  const midpoint = routeChunk?.midpoint;
  const routeBearing = routeChunk?.bearing;
  const routeA = routeChunk?.a;
  const routeB = routeChunk?.b;

  if (!midpoint || !routeA || !routeB || !Number.isFinite(routeBearing)) {
    return null;
  }

  let best = null;
  let bestScore = Infinity;

  for (const segment of candidatesNearObserved(midpoint, index)) {
    const directionDiff = angleDiffDeg(routeBearing, segment.bearing);
    if (directionDiff > 35) continue;

    const dMid = pointToSegmentDistanceKm(midpoint, segment.a, segment.b);
    if (!Number.isFinite(dMid) || dMid > thresholdKm) continue;

    const dA = pointToSegmentDistanceKm(routeA, segment.a, segment.b);
    const dB = pointToSegmentDistanceKm(routeB, segment.a, segment.b);

    const nearCount = [dA, dMid, dB].filter(
      (d) => Number.isFinite(d) && d <= 0.06
    ).length;

    // Require at least two of start/mid/end points to align with the same TDX section.
    // This rejects many adjacent parallel roads and ramps.
    if (nearCount < 2) continue;

    const score = dMid + directionDiff / 1000;
    if (score < bestScore) {
      bestScore = score;
      best = {
        ...segment,
        matchDistanceKm: dMid,
        directionDiffDeg: directionDiff,
        routeEndpointDistanceKm: { a: dA, b: dB },
      };
    }
  }

  return best;
}

function buildRouteChunks(route, maxChunks = 180) {
  const coords = route?.geometry?.coordinates || [];
  if (coords.length < 2) return [];

  const stride = Math.max(1, Math.ceil((coords.length - 1) / maxChunks));
  const chunks = [];

  for (let start = 0; start < coords.length - 1; start += stride) {
    const end = Math.min(coords.length - 1, start + stride);
    let geometryKm = 0;

    for (let i = start + 1; i <= end; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      geometryKm += routePointDistanceKm(
        Number(a?.[0]),
        Number(a?.[1]),
        Number(b?.[0]),
        Number(b?.[1])
      );
    }

    const a = { lon: Number(coords[start]?.[0]), lat: Number(coords[start]?.[1]) };
    const b = { lon: Number(coords[end]?.[0]), lat: Number(coords[end]?.[1]) };
    const midCoord = coords[Math.floor((start + end) / 2)];
    const midpoint = { lon: Number(midCoord?.[0]), lat: Number(midCoord?.[1]) };

    if (
      !Number.isFinite(a.lon) ||
      !Number.isFinite(a.lat) ||
      !Number.isFinite(b.lon) ||
      !Number.isFinite(b.lat) ||
      !Number.isFinite(midpoint.lon) ||
      !Number.isFinite(midpoint.lat) ||
      !Number.isFinite(geometryKm) ||
      geometryKm <= 0
    ) {
      continue;
    }

    chunks.push({
      a,
      b,
      midpoint,
      geometryKm,
      bearing: bearingDeg(a, b),
    });
  }

  return chunks;
}


function extractVdStaticListForRoadMetadata(data) {
  if (Array.isArray(data)) return data;

  for (const list of [
    data?.VDs,
    data?.VehicleDetectors,
    data?.VDList,
    data?.data
  ]) {
    if (Array.isArray(list)) return list;
  }

  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}


async function attachVdStaticRoadMetadata(cityPackages) {

  for (const pkg of cityPackages || []) {

    try {
      const staticData =
        await getCityVDStatic(
          pkg.city
        );

      const vds =
        extractVdStaticListForRoadMetadata(
          staticData
        );

      const byLink =
        new Map();


      for (const vd of vds) {

        const links =
          Array.isArray(
            vd?.DetectionLinks
          )
            ? vd.DetectionLinks
            : [];


        for (const link of links) {

          const linkId =
            String(
              link?.LinkID ||
              ""
            ).trim();

          if (!linkId) continue;


          byLink.set(
            linkId,
            {
              roadName:
                String(
                  vd?.RoadName ||
                  ""
                ).trim() ||
                null,

              roadClass:
                vd?.RoadClass ??
                null,

              bearing:
                link?.Bearing ??
                null,

              roadDirection:
                link?.RoadDirection ??
                null,

              vdId:
                vd?.VDID ||
                null
            }
          );
        }
      }


      let annotated = 0;


      for (
        const section
        of (
          pkg.observedSections ||
          []
        )
      ) {

        const sectionId =
          String(
            section?.sectionId ||
            ""
          ).trim();


        /*
          TDX 這批資料可看到：
          SectionID = L_2000200000200A
          Detection LinkID = 2000200000200A
        */

        const linkId =
          sectionId.replace(
            /^L_/,
            ""
          );


        const metadata =
          byLink.get(
            linkId
          );


        if (!metadata) {
          continue;
        }


        section.linkId =
          linkId;

        section.sectionName =
          metadata.roadName;

        section.roadClass =
          metadata.roadClass;

        section.vdStaticBearing =
          metadata.bearing;

        section.vdRoadDirection =
          metadata.roadDirection;

        section.vdId =
          metadata.vdId;

        annotated += 1;
      }


      console.log(
        `[TDX LINK META] ${pkg.city}: ${annotated} live sections annotated from VD static LinkID`
      );

    } catch (error) {

      console.log(
        `[TDX LINK META] ${pkg.city} unavailable:`,
        error.message
      );
    }
  }


  return cityPackages;
}


async function loadCityLivePackages(cities) {
  // ROAD_LIVE_PREFETCH_V8_2
  // Put freeway/highway live feeds at the front of the TDX request queue.
  // City scope timeouts do not necessarily cancel their underlying requests,
  // so road evidence must be requested before the city fan-out.
  Promise.allSettled([
    getFreewayLiveTraffic(),
    getHighwayLiveTraffic(),
  ]).then((results) => {
    const freeway =
      results[0].status === "fulfilled"
        ? results[0].value
        : null;

    const highway =
      results[1].status === "fulfilled"
        ? results[1].value
        : null;

    console.log("[TDX road prefetch V8.2]", {
      freewayStatus: results[0].status,
      freewayCount:
        Array.isArray(freeway?.LiveTraffics)
          ? freeway.LiveTraffics.length
          : Array.isArray(freeway)
            ? freeway.length
            : 0,

      highwayStatus: results[1].status,
      highwayCount:
        Array.isArray(highway?.LiveTraffics)
          ? highway.LiveTraffics.length
          : Array.isArray(highway)
            ? highway.length
            : 0,

      freewayError:
        results[0].status === "rejected"
          ? results[0].reason?.message
          : null,

      highwayError:
        results[1].status === "rejected"
          ? results[1].reason?.message
          : null,
    });
  });

  // CITY_PROVIDER_FILTER_V8_3
  /*
   * TDX Road/Traffic/Live/City does not expose every Taiwan
   * jurisdiction. Do not send known-unsupported jurisdictions
   * into the City LiveTraffic fan-out.
   *
   * This list is based on the accepted City values returned by
   * the current TDX Live/City API itself.
   *
   * Unsupported scopes are NOT treated as having no traffic.
   * They are explicitly reserved for alternate evidence such as
   * TDX VD / link-level observations.
   */
  const TDX_LIVE_CITY_SUPPORTED_V8_3 =
    new Set([
      "YilanCounty",
      "ChanghuaCounty",
      "YunlinCounty",
      "PingtungCounty",
      "Keelung",
      "Taipei",
      "Taichung",
      "Tainan",
      "Taoyuan",
    ]);

  const cityScopesForLiveV8_3 =
    (cities || []).filter(
      (city) =>
        TDX_LIVE_CITY_SUPPORTED_V8_3.has(
          String(city || "").trim()
        )
    );

  const cityScopesForAlternateProviderV8_3 =
    (cities || []).filter(
      (city) =>
        !TDX_LIVE_CITY_SUPPORTED_V8_3.has(
          String(city || "").trim()
        )
    );

  console.log(
    "[TDX city provider filter V8.3]",
    {
      routeScopes:
        cities,

      liveCityScopes:
        cityScopesForLiveV8_3,

      alternateProviderNeeded:
        cityScopesForAlternateProviderV8_3,

      policy:
        "Unsupported Live/City scopes are skipped, not treated as zero traffic.",
    }
  );


  const { packages } = await loadCityPackagesResilient({
    cities: cityScopesForLiveV8_3,
    getShape: getCitySectionShapes,
    getLink: getCitySectionLinks,
    getLive: getCityLiveTraffic,
    buildPackage: buildCityObservedSections,
    // Network-resilience timeout only. This never changes ETA values.
    // One unsupported/slow jurisdiction cannot erase already-usable
    // city traffic from the other jurisdictions on the route.
    perScopeTimeoutMs: 5500,
    logger: console,
  });

  return packages;
}

function roundNumber(value, digits = 1) {
  const p = 10 ** digits;
  return Math.round(Number(value || 0) * p) / p;
}

function confidenceFromCoverage(coverageRatio) {
  if (coverageRatio >= 0.7) return "High";
  if (coverageRatio >= 0.3) return "Medium";
  return "Low";
}


const RISK_STORE_PATH =
  process.env.RISK_OBSERVATION_FILE ||
  path.join(
    __dirname,
    "data",
    "route-risk-observations.jsonl"
  );


const RISK_MIN_UNIQUE_DAYS =
  Math.max(
    3,
    Number(
      process.env.RISK_MIN_UNIQUE_DAYS ||
      8
    )
  );


function routeFingerprint({
  startLat,
  startLon,
  endLat,
  endLon,
  geometry
}) {

  const coords =
    Array.isArray(
      geometry?.coordinates
    )
      ? geometry.coordinates
      : [];


  const sample = [];

  const count =
    Math.min(
      12,
      coords.length
    );


  for (
    let i = 0;
    i < count;
    i += 1
  ) {

    const index =
      Math.round(
        i *
        (coords.length - 1) /
        Math.max(
          1,
          count - 1
        )
      );


    const point =
      coords[index] ||
      [];


    sample.push(
      `${Number(point[0]).toFixed(3)},${Number(point[1]).toFixed(3)}`
    );
  }


  const geometryHash =
    crypto
      .createHash("sha1")
      .update(
        sample.join("|")
      )
      .digest("hex")
      .slice(0, 16);


  return (
    [
      startLat,
      startLon,
      endLat,
      endLon
    ]
      .map(
        (n) =>
          Number(n).toFixed(4)
      )
      .join(",")
    +
    ":" +
    geometryHash
  );
}


function taipeiObservationBucket(
  date = new Date()
) {

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
          "h23"
      }
    )
      .formatToParts(
        date
      );


  const map =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value
        ]
      )
    );


  const minute =
    Number(
      map.minute ||
      0
    );


  return {
    dateKey:
      `${map.year}-${map.month}-${map.day}`,

    weekday:
      map.weekday,

    timeBucket:
      `${map.hour}:${minute < 30 ? "00" : "30"}`
  };
}


async function readRiskObservations() {

  try {

    const text =
      await fs.readFile(
        RISK_STORE_PATH,
        "utf8"
      );


    return text
      .split("\n")
      .filter(Boolean)
      .slice(-20000)
      .map(
        (line) => {

          try {

            return JSON.parse(
              line
            );

          } catch {

            return null;
          }
        }
      )
      .filter(Boolean);

  } catch (error) {

    if (
      error?.code ===
      "ENOENT"
    ) {
      return [];
    }


    throw error;
  }
}


async function appendRiskObservation(
  observation
) {

  await fs.mkdir(
    path.dirname(
      RISK_STORE_PATH
    ),
    {
      recursive:
        true
    }
  );


  await fs.appendFile(
    RISK_STORE_PATH,
    JSON.stringify(
      observation
    ) + "\n",
    "utf8"
  );
}


function empiricalPercentile(
  values,
  p
) {

  if (!values.length) {
    return null;
  }


  const index =
    Math.min(
      values.length - 1,

      Math.max(
        0,
        Math.ceil(
          p *
          values.length
        ) - 1
      )
    );


  return values[index];
}


async function assessEmpiricalRisk({
  startLat,
  startLon,
  endLat,
  endLon,
  geometry,
  expectedMin,
  tdxCoverageRatio,
  latestLiveDataTime,
  routeId
}) {

  const bucket =
    taipeiObservationBucket();


  const routeKey =
    routeFingerprint({
      startLat,
      startLon,
      endLat,
      endLon,
      geometry
    });


  const all =
    await readRiskObservations();


  const prior =
    all.filter(
      (item) =>
        item.routeKey === routeKey &&
        item.weekday === bucket.weekday &&
        item.timeBucket === bucket.timeBucket &&
        item.dateKey !== bucket.dateKey &&
        Number.isFinite(
          Number(
            item.expectedMin
          )
        ) &&
        Number(
          item.tdxCoverageRatio ||
          0
        ) > 0
    );


  const byDay =
    new Map();


  for (
    const item
    of prior
  ) {

    byDay.set(
      item.dateKey,
      item
    );
  }


  const uniqueDays =
    [
      ...byDay.values()
    ];


  /*
    只記錄有真正 TDX live coverage 的 observation。

    今天重複按 100 次，
    未來統計仍然只算今天一次。
  */

  if (
    Number.isFinite(
      Number(expectedMin)
    ) &&
    Number(
      tdxCoverageRatio ||
      0
    ) > 0
  ) {

    await appendRiskObservation({
      version:
        1,

      routeKey,

      routeId,

      observedAt:
        new Date()
          .toISOString(),

      ...bucket,

      expectedMin:
        roundNumber(
          expectedMin,
          3
        ),

      tdxCoverageRatio:
        roundNumber(
          tdxCoverageRatio,
          4
        ),

      latestLiveDataTime,

      dataBasis:
        "TDX live TravelTime/TravelSpeed + OSRM baseline only for uncovered road pieces"
    });
  }


  /*
    歷史樣本不足：
    不猜 CV。
    不猜 Worst10。
  */

  if (
    uniqueDays.length <
    RISK_MIN_UNIQUE_DAYS
  ) {

    return {
      riskStatus:
        "insufficient_data",

      sampleCount:
        uniqueDays.length,

      minRequiredUniqueDays:
        RISK_MIN_UNIQUE_DAYS,

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

      riskDataSource:
        "real prior TDX-informed observations only; no guessed coefficient"
    };
  }


  const values =
    uniqueDays
      .map(
        (item) =>
          Number(
            item.expectedMin
          )
      )
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );


  const mean =
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length;


  const variance =
    values.length > 1
      ? values.reduce(
          (sum, value) =>
            sum +
            (value - mean) ** 2,
          0
        ) /
        (values.length - 1)
      : 0;


  const sd =
    Math.sqrt(
      variance
    );


  const median =
    empiricalPercentile(
      values,
      0.5
    );


  const p10 =
    empiricalPercentile(
      values,
      0.1
    );


  const p90 =
    empiricalPercentile(
      values,
      0.9
    );


  const p95 =
    empiricalPercentile(
      values,
      0.95
    );


  return {
    riskStatus:
      "ready",

    sampleCount:
      values.length,

    minRequiredUniqueDays:
      RISK_MIN_UNIQUE_DAYS,

    worst10Min:
      roundNumber(
        p90,
        1
      ),

    worst5Min:
      roundNumber(
        p95,
        1
      ),

    variance:
      roundNumber(
        variance,
        2
      ),

    varianceLabel:
      null,

    likelyRangeMin: {
      low:
        roundNumber(
          p10,
          1
        ),

      high:
        roundNumber(
          p90,
          1
        )
    },

    standardDeviationMin:
      roundNumber(
        sd,
        1
      ),

    coefficientOfVariation:
      mean > 0
        ? roundNumber(
            sd / mean,
            3
          )
        : null,

    stabilityScore:
      null,

    stabilityLevel:
      null,

    historicalMeanMin:
      roundNumber(
        mean,
        1
      ),

    historicalMedianMin:
      roundNumber(
        median,
        1
      ),

    riskDataSource:
      "empirical historical TDX-informed observations; no artificial coefficient"
  };
}


app.get("/api/tdx-city-section-test", async (req, res) => {
  try {
    const city =
      String(
        req.query.city ||
        "Taipei"
      ).trim();

    const requestedSectionId =
      String(
        req.query.sectionId ||
        ""
      ).trim();

    const [
      shapeData,
      sectionLinkData,
      liveData
    ] =
      await Promise.all([
        getCitySectionShapes(city),
        getCitySectionLinks(city),
        getCityLiveTraffic(city),
      ]);

    const pkg =
      buildCityObservedSections(
        city,
        shapeData,
        sectionLinkData,
        liveData
      );

    const nowMs =
      Date.now();

    const rows =
      (
        requestedSectionId
          ? pkg.observedSections.filter(
              (item) =>
                String(
                  item?.sectionId ||
                  ""
                ).trim() ===
                requestedSectionId
            )
          : pkg.observedSections.slice(
              0,
              10
            )
      )
        .map((item) => {
          const collectedMs =
            Date.parse(
              item?.dataCollectTime ||
              ""
            );

          const ageMin =
            Number.isFinite(
              collectedMs
            )
              ? (
                  nowMs -
                  collectedMs
                ) /
                60000
              : null;

          return {
            sectionId:
              item.sectionId,

            sectionName:
              item.sectionName ||
              null,

            liveSource:
              item.liveSource ||
              null,

            sectionLengthKm:
              roundNumber(
                item.sectionLengthKm,
                3
              ),

            observedFrom:
              item.observedFrom,

            calculatedSpeedKmh:
              roundNumber(
                item.observedSpeedKmh,
                1
              ),

            rawTravelTimeSec:
              item.travelTimeSec,

            rawTravelSpeedKmh:
              item.travelSpeedKmh,

            dataCollectTime:
              item.dataCollectTime,

            dataAgeMin:
              Number.isFinite(
                ageMin
              )
                ? roundNumber(
                    ageMin,
                    2
                  )
                : null,

            constituentLiveCount:
              item.constituentLiveCount,

            congestionLevel:
              item.congestionLevel ??
              null,

            congestionLevelID:
              item.congestionLevelID ??
              null,
          };
        });

    res.json({
      status:
        "ok",

      city,

      requestedSectionId:
        requestedSectionId ||
        null,

      shapeCount:
        pkg.shapeCount,

      liveCount:
        pkg.liveCount,

      usableObservedSectionCount:
        pkg.observedSections.length,

      matchedCount:
        rows.length,

      sections:
        rows,

      note:
        "Diagnostic only. This endpoint does not modify ETA."
    });

  } catch (error) {
    res
      .status(
        error?.status === 429
          ? 429
          : 500
      )
      .json({
        status:
          "error",

        message:
          error.message,
      });
  }
});


app.get("/api/tdx-road-section-test", async (req, res) => {
  try {
    const sectionId =
      String(
        req.query.sectionId || ""
      ).trim();

    if (!sectionId) {
      return res.status(400).json({
        status: "error",
        message: "Missing sectionId",
      });
    }

    function trafficList(data) {
      if (Array.isArray(data)) {
        return data;
      }

      if (Array.isArray(data?.LiveTraffics)) {
        return data.LiveTraffics;
      }

      if (Array.isArray(data?.liveTraffics)) {
        return data.liveTraffics;
      }

      if (Array.isArray(data?.data)) {
        return data.data;
      }

      return [];
    }

    function normalizePolyline(decoded) {
      if (!Array.isArray(decoded)) {
        return [];
      }

      return decoded
        .map((point) => {
          if (Array.isArray(point)) {
            const lon = Number(point[0]);
            const lat = Number(point[1]);

            return (
              Number.isFinite(lon) &&
              Number.isFinite(lat)
            )
              ? { lon, lat }
              : null;
          }

          const lon =
            Number(
              point?.lon ??
              point?.lng
            );

          const lat =
            Number(
              point?.lat
            );

          return (
            Number.isFinite(lon) &&
            Number.isFinite(lat)
          )
            ? { lon, lat }
            : null;
        })
        .filter(Boolean);
    }

    function haversineKm(a, b) {
      const R = 6371;

      const rad =
        (v) =>
          v * Math.PI / 180;

      const dLat =
        rad(b.lat - a.lat);

      const dLon =
        rad(b.lon - a.lon);

      const lat1 =
        rad(a.lat);

      const lat2 =
        rad(b.lat);

      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(dLon / 2) ** 2;

      return (
        2 *
        R *
        Math.asin(
          Math.sqrt(h)
        )
      );
    }

    function bearingDeg(a, b) {
      const rad =
        (v) =>
          v * Math.PI / 180;

      const deg =
        (v) =>
          v * 180 / Math.PI;

      const lat1 =
        rad(a.lat);

      const lat2 =
        rad(b.lat);

      const dLon =
        rad(b.lon - a.lon);

      const y =
        Math.sin(dLon) *
        Math.cos(lat2);

      const x =
        Math.cos(lat1) *
          Math.sin(lat2) -
        Math.sin(lat1) *
          Math.cos(lat2) *
          Math.cos(dLon);

      return (
        deg(
          Math.atan2(y, x)
        ) +
        360
      ) % 360;
    }

    function summarizePolyline(points) {
      let lengthKm = 0;

      for (
        let i = 1;
        i < points.length;
        i += 1
      ) {
        lengthKm +=
          haversineKm(
            points[i - 1],
            points[i]
          );
      }

      return {
        pointCount:
          points.length,

        lengthKm:
          Number(
            lengthKm.toFixed(3)
          ),

        start:
          points[0] || null,

        end:
          points[
            points.length - 1
          ] || null,

        startBearing:
          points.length >= 2
            ? Number(
                bearingDeg(
                  points[0],
                  points[1]
                ).toFixed(1)
              )
            : null,

        endBearing:
          points.length >= 2
            ? Number(
                bearingDeg(
                  points[
                    points.length - 2
                  ],
                  points[
                    points.length - 1
                  ]
                ).toFixed(1)
              )
            : null,

        samplePoints:
          points.length
            ? [
                points[0],
                points[
                  Math.floor(
                    points.length / 2
                  )
                ],
                points[
                  points.length - 1
                ],
              ]
            : [],
      };
    }

    const [
      freewayData,
      highwayData,
    ] =
      await Promise.all([
        getFreewayLiveTraffic(),
        getHighwayLiveTraffic(),
      ]);

    const sources = [
      {
        scope: "freeway",
        data: freewayData,
      },
      {
        scope: "highway",
        data: highwayData,
      },
    ];

    const matches = [];

    for (const source of sources) {
      for (
        const section of
        trafficList(source.data)
      ) {
        const id =
          String(
            section?.SectionID ||
            section?.SectionUID ||
            ""
          ).trim();

        if (id !== sectionId) {
          continue;
        }

        const decodedOpenLRs = [];

        for (
          const item of
          (
            Array.isArray(
              section?.OpenLRs
            )
              ? section.OpenLRs
              : []
          )
        ) {
          try {
            const encoded =
              item?.OpenLR ||
              item?.openLR ||
              item;

            const points =
              normalizePolyline(
                openLrToPolyline(
                  encoded
                )
              );

            decodedOpenLRs.push({
              encodedPreview:
                String(
                  encoded || ""
                ).slice(0, 24),

              ...summarizePolyline(
                points
              ),
            });

          } catch (error) {
            decodedOpenLRs.push({
              decodeError:
                error.message,
            });
          }
        }

        matches.push({
          scope:
            source.scope,

          rawKeys:
            Object.keys(section),

          sectionId:
            id,

          sectionName:
            section?.SectionName ??
            null,

          roadName:
            section?.RoadName ??
            null,

          roadId:
            section?.RoadID ??
            null,

          roadClass:
            section?.RoadClass ??
            null,

          direction:
            section?.Direction ??
            section?.RoadDirection ??
            null,

          start:
            section?.Start ??
            section?.StartPoint ??
            null,

          end:
            section?.End ??
            section?.EndPoint ??
            null,

          travelTimeSec:
            section?.TravelTime ??
            null,

          travelSpeedKmh:
            section?.TravelSpeed ??
            null,

          congestionLevel:
            section?.CongestionLevel ??
            null,

          congestionLevelID:
            section?.CongestionLevelID ??
            null,

          dataCollectTime:
            section?.DataCollectTime ??
            null,

          dataSources:
            section?.DataSources ??
            null,

          openLRCount:
            Array.isArray(
              section?.OpenLRs
            )
              ? section.OpenLRs.length
              : 0,

          decodedOpenLRs,
        });
      }
    }


    // -----------------------------------------
    // Compare with the actual Valhalla routes.
    // Defaults = 桃園高鐵站 -> 桃園火車站.
    // -----------------------------------------

    const startLon =
      Number(
        req.query.startLon ??
        121.213451
      );

    const startLat =
      Number(
        req.query.startLat ??
        25.009907
      );

    const endLon =
      Number(
        req.query.endLon ??
        121.315469
      );

    const endLat =
      Number(
        req.query.endLat ??
        24.989973
      );

    const routes =
      await getValhallaRoutes({
        startLon,
        startLat,
        endLon,
        endLat,
        alternatives: 2,
        timeoutMs: 10000,
      });

    const routeRoadAudit =
      routes.map((route) => {
        const steps =
          (route.legs || [])
            .flatMap(
              (leg) =>
                leg.steps || []
            );

        const relevant =
          steps
            .filter((step) => {
              const names = [
                step?.name,

                ...(
                  step?.valhalla
                    ?.street_names ||
                  []
                ),
              ]
                .map(
                  (v) =>
                    String(v || "")
                );

              return names.some(
                (name) =>
                  name.includes("113") ||
                  name.includes("丙")
              );
            })
            .map((step) => ({
              name:
                step?.name ||
                null,

              streetNames:
                step?.valhalla
                  ?.street_names ||
                [],

              distanceKm:
                Number(
                  (
                    Number(
                      step?.distance || 0
                    ) /
                    1000
                  ).toFixed(3)
                ),

              durationSec:
                Number(
                  step?.duration || 0
                ),

              beginShapeIndex:
                step?.valhalla
                  ?.begin_shape_index ??
                null,

              endShapeIndex:
                step?.valhalla
                  ?.end_shape_index ??
                null,
            }));

        return {
          label:
            route.label,

          distanceKm:
            Number(
              (
                Number(
                  route.distance || 0
                ) /
                1000
              ).toFixed(3)
            ),

          durationMin:
            Number(
              (
                Number(
                  route.duration || 0
                ) /
                60
              ).toFixed(2)
            ),

          relevant113Steps:
            relevant,
        };
      });

    res.json({
      status:
        "ok",

      sectionId,

      found:
        matches.length,

      tdxSections:
        matches,

      valhalla:
        routeRoadAudit,

      note:
        "Diagnostic only. No matching threshold or ETA logic is changed.",
    });

  } catch (error) {
    console.error(
      "TDX road section diagnostic error:",
      error
    );

    res.status(500).json({
      status:
        "error",

      message:
        error.message,
    });
  }
});


app.get("/api/route", async (req, res) => {
  try {
    const { startLon, startLat, endLon, endLat } = req.query;
    const requestedDepartureTime = String(req.query.departureTime || "").trim() || null;

    if (!startLon || !startLat || !endLon || !endLat) {
      return res.status(400).json({
        error: "Missing startLon, startLat, endLon, or endLat",
      });
    }

    const sLon = Number(startLon);
    const sLat = Number(startLat);
    const eLon = Number(endLon);
    const eLat = Number(endLat);

    if (![sLon, sLat, eLon, eLat].every(Number.isFinite)) {
      return res.status(400).json({ error: "Invalid coordinate format" });
    }

    async function getOsrmRoutes() {
      const queries = [
        "?overview=full&geometries=geojson&steps=true&alternatives=true",
        "?overview=full&geometries=geojson&steps=true",
      ];

      let lastError = null;
      for (const query of queries) {
        try {
          const url =
            `${OSRM_BASE_URL}/route/v1/driving/` +
            `${sLon},${sLat};${eLon},${eLat}${query}`;
          const response = await fetchWithTimeout(url, {}, 9000);
          const data = await response.json();

          if (!response.ok || data.code !== "Ok" || !data.routes?.length) {
            lastError = new Error(`OSRM ${response.status}: ${JSON.stringify(data)}`);
            continue;
          }

          return data.routes.map((route, index) => ({
            routeId: index + 1,
            label: `Route ${String.fromCharCode(65 + index)}`,
            duration: Number(route.duration),
            distance: Number(route.distance),
            geometry: route.geometry,
            legs: route.legs || [],
            google: null,
          }));
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error("OSRM route failed");
    }

    async function getBaseRoutes() {
      /*
       * PRIMARY ROUTER = Valhalla
       *
       * Valhalla:
       *   geometry + full-route baseline.
       *
       * TDX:
       *   traffic evidence / positive delay layer.
       *
       * OSRM:
       *   final emergency fallback only.
       */

      try {
        const routes =
          await getValhallaRoutes({
            startLon:
              sLon,

            startLat:
              sLat,

            endLon:
              eLon,

            endLat:
              eLat,

            alternatives:
              2,

            timeoutMs:
              10000,
          });


        console.log(
          `[routing] Valhalla returned ${routes.length} route(s)`
        );


        return routes.map(
          (route) => ({
            ...route,

            routingEngine:
              route.routingEngine ||
              "valhalla",
          })
        );

      } catch (error) {

        console.warn(
          "[routing] Valhalla unavailable -> OSRM final fallback:",
          error.message
        );


        const routes =
          await getOsrmRoutes();


        return routes.map(
          (route) => ({
            ...route,

            routingEngine:
              "osrm",
          })
        );
      }
    }

    const baseRoutes = await getBaseRoutes();

    if (!baseRoutes.length) {
      return res.status(404).json({ error: "No route found" });
    }

    /*
     * ROUTE_JURISDICTION_PARALLEL_V1
     *
     * Same jurisdiction resolver and same result order.
     * Only change: resolve alternative routes concurrently
     * instead of waiting for Route A -> B -> C sequentially.
     *
     * ETA logic is untouched.
     */
    const routeJurisdictionStartMs =
      Date.now();

    const routeCityLists =
      await Promise.all(
        baseRoutes.map(
          (route) =>
            routeCandidateCities(
              route
            )
        )
      );

    console.log(
      "[route jurisdiction parallel]",
      {
        routeCount:
          baseRoutes.length,

        elapsedMs:
          Date.now() -
          routeJurisdictionStartMs,
      }
    );

    const maxRouteJurisdictions = Math.max(
      1,
      Math.min(22, Number(process.env.TDX_MAX_ROUTE_JURISDICTIONS || 12))
    );

    const cities = [
      ...new Set(
        routeCityLists.flat()
      ),
    ].slice(0, maxRouteJurisdictions);

    const testCities = String(process.env.TDX_TEST_CITIES || "")
      .split(",")
      .map((value) => canonicalizeTaiwanJurisdiction(value))
      .filter(Boolean);

    if (!cities.length && testCities.length) {
      cities.push(...new Set(testCities));
      console.warn("[route jurisdiction TEST fallback]", cities);
    }
    console.log(
      "[route jurisdiction scopes]",
      cities
    );

    let cityPackages = [];

try {
  cityPackages =
    await promiseWithTimeout(
      loadCityLivePackages(
        cities
      ),
      Math.max(7000, Math.min(60000,
        Number(process.env.TDX_CITY_TIMEOUT_MS) || 7000)),
      "TDX city traffic"
    );
} catch (error) {
  console.warn(
    "[route] city traffic skipped:",
    error.message
  );

  cityPackages = [];
}

    /*
      用 VD Static 的 DetectionLinks.LinkID
      補 City LiveTraffic section 的道路名稱。

      這不會使用 VD speed 修改 ETA。
    */
    if (
  cityPackages.length
) {
  try {
    await promiseWithTimeout(
      attachVdStaticRoadMetadata(
        cityPackages
      ),
      4000,
      "TDX VD static metadata"
    );
  } catch (error) {
    console.warn(
      "[route] VD metadata skipped:",
      error.message
    );
  }
}

    console.log("[TDX city packages]", cityPackages.map(pkg => ({
      city: pkg.city,
      shapeCount: pkg.shapeCount,
      rawLiveCount: pkg.rawLiveCount ?? pkg.liveCount,
      freshLiveCount: pkg.liveCount,
      usableObservedSectionCount: pkg.observedSections?.length || 0,
      evidenceQualityCounts: pkg.evidenceQualityCounts || null,
    })));
    const cityIndex =
      buildObservedSegmentIndex(
        cityPackages
      );

    /*
      更多 TDX 即時資料：
      先從 VD static 找路線附近感測器，
      再只查那些 VD 的 live data。
    */

    /*
      VD Live 暫時不在每次 route request 中逐支同步取得。

      原因：
      1. spot-speed 目前不直接參與 ETA
      2. per-device requests 會拖慢 navigation
      3. 容易觸發 TDX rate limit

      VD Static LinkID metadata 已經用來提高 matching 精度。
    */

    const vdBundle = {
      observations: [],

      diagnostics: {
        mode:
          "static-link-metadata-only",

        nearbySensors:
          0,

        requestedSensors:
          0,

        successfulSensors:
          0,

        observations:
          0,

        errors: []
      }
    };


    const vdIndex =
      buildTdxVdIndex(
        []
      );


    console.log(
      "[TDX VD]",
      {
        static:
          vdBundle
            .diagnostics
            .staticCount,

        nearby:
          vdBundle
            .diagnostics
            .nearbySensors,

        requested:
          vdBundle
            .diagnostics
            .requestedSensors,

        successful:
          vdBundle
            .diagnostics
            .successfulSensors,

        observations:
          vdBundle
            .diagnostics
            .observations
      }
    );


    // Freeway/highway live feeds are actual TDX observed TravelSpeed/TravelTime.
    // They are requested once and shared by every alternative route.
    const roadLiveResults =
  await Promise.allSettled([
    promiseWithTimeout(
      getFreewayLiveTraffic(),
      6000,
      "TDX Freeway LiveTraffic"
    ),

    promiseWithTimeout(
      getHighwayLiveTraffic(),
      6000,
      "TDX Highway LiveTraffic"
    ),
  ]);

    const freewayLiveTrafficData =
      roadLiveResults[0].status === "fulfilled" ? roadLiveResults[0].value : null;
    const highwayLiveTrafficData =
      roadLiveResults[1].status === "fulfilled" ? roadLiveResults[1].value : null;

    // ROAD_LIVE_INPUT_DIAGNOSTIC_V8_2
    console.log("[TDX road live input V8.2]", {
      freewayStatus:
        roadLiveResults[0].status,

      freewayCount:
        Array.isArray(freewayLiveTrafficData?.LiveTraffics)
          ? freewayLiveTrafficData.LiveTraffics.length
          : Array.isArray(freewayLiveTrafficData)
            ? freewayLiveTrafficData.length
            : 0,

      freewayError:
        roadLiveResults[0].status === "rejected"
          ? roadLiveResults[0].reason?.message
          : null,

      highwayStatus:
        roadLiveResults[1].status,

      highwayCount:
        Array.isArray(highwayLiveTrafficData?.LiveTraffics)
          ? highwayLiveTrafficData.LiveTraffics.length
          : Array.isArray(highwayLiveTrafficData)
            ? highwayLiveTrafficData.length
            : 0,

      highwayError:
        roadLiveResults[1].status === "rejected"
          ? roadLiveResults[1].reason?.message
          : null,
    });


    // Incidents are optional diagnostics/risk inputs only. They never increase
    // Expected ETA in this real-data mode.
    let freewayIncidentData = null;
    let highwayIncidentData = null;
    if (Number(req.query.includeIncidents || 0) === 1) {
      const incidentResults = await Promise.allSettled([
        getFreewayLiveIncident(),
        getHighwayLiveIncident(),
      ]);
      freewayIncidentData =
        incidentResults[0].status === "fulfilled" ? incidentResults[0].value : null;
      highwayIncidentData =
        incidentResults[1].status === "fulfilled" ? incidentResults[1].value : null;
    }

    function getIncidentList(data) {
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.Incidents)) return data.Incidents;
      if (Array.isArray(data?.LiveIncidents)) return data.LiveIncidents;
      if (Array.isArray(data?.TrafficIncidents)) return data.TrafficIncidents;
      if (Array.isArray(data?.data)) return data.data;
      return [];
    }

    function getIncidentPosition(item) {
      const pos =
        item?.Position ||
        item?.IncidentPosition ||
        item?.LocationPosition ||
        item?.RoadSection?.Position;
      const lon = Number(
        pos?.PositionLon ?? pos?.lon ?? pos?.lng ?? item?.PositionLon ?? item?.Longitude
      );
      const lat = Number(pos?.PositionLat ?? pos?.lat ?? item?.PositionLat ?? item?.Latitude);
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    }

    function countNearbyIncidents(route, thresholdKm = 0.8) {
      const coords = route?.geometry?.coordinates || [];
      if (!coords.length) return { count: 0, incidents: [] };

      const all = [
        ...getIncidentList(freewayIncidentData),
        ...getIncidentList(highwayIncidentData),
      ];
      const matched = [];
      const step = Math.max(1, Math.floor(coords.length / 120));

      for (const incident of all) {
        const pos = getIncidentPosition(incident);
        if (!pos) continue;
        let nearestKm = Infinity;

        for (let i = 0; i < coords.length; i += step) {
          const [lon, lat] = coords[i] || [];
          if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) continue;
          nearestKm = Math.min(
            nearestKm,
            routePointDistanceKm(pos.lon, pos.lat, Number(lon), Number(lat))
          );
        }

        if (nearestKm <= thresholdKm) {
          matched.push({
            title:
              incident?.Description ||
              incident?.IncidentDescription ||
              incident?.RoadName ||
              incident?.SectionName ||
              "TDX incident",
            type:
              incident?.IncidentType ||
              incident?.IncidentTypeName ||
              incident?.EventType ||
              "incident",
            distanceKm: roundNumber(nearestKm, 2),
            updateTime:
              incident?.UpdateTime ||
              incident?.DataCollectTime ||
              incident?.SrcUpdateTime ||
              null,
          });
        }
      }

      return { count: matched.length, incidents: matched.slice(0, 5) };
    }

    // =====================================================
    // REAL ETA V2
    //
    // OSRM:
    // route geometry + each step's own baseline duration
    //
    // TDX:
    // strictly map-matched observed TravelTime/TravelSpeed
    //
    // One road piece can use only ONE TDX observation.
    // =====================================================

    // ETA V8: official published SectionShape/Section metadata is the
    // canonical freeway/highway geometry. OpenLR remains a safe fallback.
    // ROAD_INDEX_TIMING_V1
    const roadStaticStartMs =
      Date.now();

    const roadStaticResults = await Promise.allSettled([
      getFreewaySectionShapes(),
      getHighwaySectionShapes(),
      getFreewaySections(),
      getHighwaySections(),
    ]);

    console.log(
      "[perf road static data]",
      {
        elapsedMs:
          Date.now() -
          roadStaticStartMs,
      }
    );

    const freewaySectionShapeData =
      roadStaticResults[0].status === "fulfilled" ? roadStaticResults[0].value : null;
    const highwaySectionShapeData =
      roadStaticResults[1].status === "fulfilled" ? roadStaticResults[1].value : null;
    const freewaySectionData =
      roadStaticResults[2].status === "fulfilled" ? roadStaticResults[2].value : null;
    const highwaySectionData =
      roadStaticResults[3].status === "fulfilled" ? roadStaticResults[3].value : null;

    const roadIndexBuildStartMs =
      Date.now();

    const roadIndex =
      buildTdxRoadIndex({
        freewayData:
          freewayLiveTrafficData,

        highwayData:
          highwayLiveTrafficData,



        freewaySectionShapeData,
        highwaySectionShapeData,
        freewaySectionData,
        highwaySectionData,

        openLrToPolyline
      });

console.log(
  "[perf road index build]",
  {
    elapsedMs:
      Date.now() -
      roadIndexBuildStartMs,
    segmentCount:
      roadIndex?.segmentCount || 0,
  }
);

console.log("[TDX canonical road geometry]",
  roadIndex?.geometryDiagnostics || null
);

    console.log(
      "[TDX road evidence quality]",
      roadIndex?.evidenceDiagnostics || null
    );

/*
 * Preserve the real TDX archive scope for each SectionID.
 *
 * freewayLiveTrafficData -> Historical Freeway
 * highwayLiveTrafficData -> Historical Highway
 *
 * We use exact SectionID membership.
 * We do NOT guess scope from the ID format.
 */
const freewaySectionIds =
  new Set(
    extractLiveTraffics(
      freewayLiveTrafficData
    )
      .map(
        (item) =>
          String(
            item?.SectionID ||
            item?.SectionUID ||
            ""
          ).trim()
      )
      .filter(Boolean)
  );


const highwaySectionIds =
  new Set(
    extractLiveTraffics(
      highwayLiveTrafficData
    )
      .map(
        (item) =>
          String(
            item?.SectionID ||
            item?.SectionUID ||
            ""
          ).trim()
      )
      .filter(Boolean)
  );


console.log(
  "[history scope index]",
  {
    freeway:
      freewaySectionIds.size,

    highway:
      highwaySectionIds.size,
  }
);

    const enhancedRoutes = [];


    for (
      let index = 0;
      index < baseRoutes.length;
      index += 1
    ) {
      const route =
        baseRoutes[index];


      const baseOsrmMin =
        Number(
          route.duration ||
          0
        ) / 60;


      const routeDistanceKm =
        Number(
          route.distance ||
          0
        ) / 1000;


      const eta =
        calculateTdxHybridEta({
          route,

          cityIndex,

          roadIndex,

          vdIndex,

          cityMatchThresholdKm:
            0.05,

          roadMatchThresholdKm:
            0.06,

          maxDirectionDiffDeg:
            35
        });


      /*
       * =====================================================
       * SAFE ETA POLICY
       * =====================================================
       *
       * Full Valhalla route time is the baseline.
       *
       * TDX observation is allowed to ADD delay.
       * It is NOT allowed to make the complete
       * navigation route shorter than Valhalla.
       *
       * This prevents road detector movement speed
       * from erasing traffic-signal / intersection /
       * turning costs on urban roads.
       */

      const baseRouterMin =
        baseOsrmMin;


      const liveSectionsForEta =
        Array.isArray(eta.matchedRuns) && eta.matchedRuns.length
          ? eta.matchedRuns
          : Array.isArray(eta.matchedSections)
            ? eta.matchedSections
            : [];


      let tdxPositiveDelaySec =
        0;

      let tdxDelayAdjustedDistanceKm =
        0;

      let tdxTravelTimeEvidenceKm =
        0;

      let tdxSpeedOnlyEvidenceKm =
        0;

      let tdxHighConfidenceTravelTimeEvidenceKm =
        0;

      let tdxFreshEvidenceKm =
        0;

      let tdxMediumConfidenceEvidenceKm =
        0;


      for (
        const section of
        liveSectionsForEta
      ) {

        const distanceKm =
          Number(
            section?.matchedDistanceKm
          );

        const speedKmh =
          Number(
            section?.observedSpeedKmh
          );

        const sectionBaselineSec =
          Number(
            section?.baselineSec
          );

        const sectionObservedSec =
          Number(
            section?.observedSec
          );


        if (
          !Number.isFinite(distanceKm) ||
          distanceKm <= 0 ||
          !Number.isFinite(sectionBaselineSec) ||
          sectionBaselineSec <= 0
        ) {
          continue;
        }


        const observedSec =
          Number.isFinite(sectionObservedSec) &&
          sectionObservedSec > 0
            ? sectionObservedSec
            : (
                Number.isFinite(speedKmh) &&
                speedKmh > 0
                  ? (
                      distanceKm /
                      speedKmh
                    ) * 3600
                  : NaN
              );


        if (
          !Number.isFinite(observedSec) ||
          observedSec <= 0
        ) {
          continue;
        }


        if (
          String(
            section?.observedFrom ||
            ""
          ) ===
          "TravelTime"
        ) {
          tdxTravelTimeEvidenceKm +=
            distanceKm;

        } else {
          tdxSpeedOnlyEvidenceKm +=
            distanceKm;
        }

        if (
          String(section?.observedFrom || "") === "TravelTime" &&
          String(section?.evidenceConfidence || "") === "high"
        ) {
          tdxHighConfidenceTravelTimeEvidenceKm += distanceKm;
        }

        if (String(section?.evidenceConfidence || "") === "medium") {
          tdxMediumConfidenceEvidenceKm += distanceKm;
        }

        const evidenceAgeMin = Number(section?.dataAgeMin);
        if (Number.isFinite(evidenceAgeMin) && evidenceAgeMin >= -2 &&
            evidenceAgeMin <= Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20)) {
          tdxFreshEvidenceKm += distanceKm;
        }


        /*
         * Compare TDX live traffic with the baseline
         * of THIS SAME route section.
         *
         * Faster detector speed is not allowed to
         * erase signal / turn / intersection costs.
         *
         * Slower traffic can add delay.
         */
        const positiveDelaySec =
          Math.max(
            0,
            observedSec -
            sectionBaselineSec
          );


        if (
          positiveDelaySec >
          0
        ) {
          tdxPositiveDelaySec +=
            positiveDelaySec;

          tdxDelayAdjustedDistanceKm +=
            distanceKm;
        }
      }

const CITY_SIGNAL_CACHE_MAP = {
  Taipei: "taipei-central",
  Taichung: "taichung-central",
};

const signalCityKey =
  CITY_SIGNAL_CACHE_MAP[cities?.[0]] || null;

const signalCorrection =
  signalCityKey
    ? countSignalsAlongRoute({
        routeCoordinates: route.geometry.coordinates,
        cityKey: signalCityKey,
      })
    : {
        signalCount: 0,
        delaySec: 0,
        delayMin: 0,
        secondsPerSignal: 18,
        cityKey: null,
        cacheAvailable: false,
        reason: `no signal cache mapped for city: ${cities?.[0] || "unknown"}`,
      };
      const liveExpectedMin =
        baseRouterMin +
        (
          tdxPositiveDelaySec /
          60
        );

      /* ETA_EVIDENCE_FUSION_V3
       * expectedMin is finalized only after Historical evidence and
       * actual-trip residual calibration are available.
       */
      let expectedMin =
        liveExpectedMin;


      const riskBaselineMin =
        baseRouterMin;


      /*
       * Compatibility with fields created
       * during the TomTom experiment.
       */
      const isTomTomTraffic =
        false;


      const tdxCoverageRatio =
        Number(
          eta.tdxCoverageRatio ||
          0
        );


      const uncoveredForAudit =
        Array.isArray(
          eta.unmatchedSegments
        )
          ? eta.unmatchedSegments
          : [];

      const uncoveredBaselineMin =
        uncoveredForAudit.reduce(
          (sum, item) => sum + Number(item?.baselineMin || 0),
          0
        );


      console.log(
        "[eta uncovered audit]",
        {
          route:
            route.label,

          uncoveredPct:
            Number(
              (
                (
                  1 -
                  Number(
                    eta.tdxCoverageRatio ||
                    0
                  )
                ) *
                100
              ).toFixed(1)
            ),

          uncoveredKm:
            Number(
              uncoveredForAudit
                .reduce(
                  (sum, item) =>
                    sum +
                    Number(
                      item.distanceKm ||
                      0
                    ),
                  0
                )
                .toFixed(3)
            ),

          uncoveredBaselineMin:
            Number(uncoveredBaselineMin.toFixed(2)),

          uncoveredBaselineSharePct:
            baseRouterMin > 0
              ? Number((uncoveredBaselineMin / baseRouterMin * 100).toFixed(1))
              : 0,

          roads:
            uncoveredForAudit
        }
      );


      console.log(
        "[eta section audit]",
        liveSectionsForEta
          .map((section) => ({
            city:
              section?.city || null,

            sectionId:
              section?.sectionId || null,

            sectionName:
              section?.sectionName || null,

            source:
              section?.source || null,

            observedFrom:
              section?.observedFrom || null,

            speedKmh:
              Number(
                section?.observedSpeedKmh || 0
              ),

            distanceKm:
              Number(
                section?.matchedDistanceKm || 0
              ),

            baselineMin:
              Number(
                section?.baselineMin || 0
              ),

            observedMin:
              Number(
                section?.observedMin || 0
              ),

            positiveDelayMin:
              Math.max(
                0,
                Number(section?.observedMin || 0) -
                  Number(section?.baselineMin || 0)
              ),

            dataCollectTime:
              section?.dataCollectTime || null,

            dataAgeMin:
              Number.isFinite(Number(section?.dataAgeMin))
                ? Number(Number(section.dataAgeMin).toFixed(2))
                : null,

            evidenceConfidence:
              section?.evidenceConfidence || null,

            evidenceReason:
              section?.evidenceReason || null,

            publishedTravelSpeedKmh:
              section?.travelSpeedKmh !== null &&
              section?.travelSpeedKmh !== undefined &&
              Number.isFinite(Number(section.travelSpeedKmh)) &&
              Number(section.travelSpeedKmh) > 0
                ? Number(Number(section.travelSpeedKmh).toFixed(1))
                : null,

            nearestMatchM:
              Number(
                section?.nearestMatchKm || 0
              ) * 1000,
          }))
          .sort(
            (a, b) =>
              b.positiveDelayMin -
              a.positiveDelayMin
          )
      );


      console.log(
        "[eta audit]",
        {
          route:
            route.label,

          engine:
            route.routingEngine ||
            "unknown",

          distanceKm:
            Number(
              routeDistanceKm
                .toFixed(2)
            ),

          baseRouterMin:
            Number(
              baseRouterMin
                .toFixed(2)
            ),

          tdxDataCoveragePct:
            Number(
              (
                tdxCoverageRatio *
                100
              ).toFixed(1)
            ),

          tdxTravelTimeCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxTravelTimeEvidenceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          tdxSpeedOnlyCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxSpeedOnlyEvidenceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          effectiveDelayAdjustedCoveragePct:
            routeDistanceKm > 0
              ? Number(
                  (
                    tdxDelayAdjustedDistanceKm /
                    routeDistanceKm *
                    100
                  ).toFixed(1)
                )
              : 0,

          uncoveredCoveragePct:
            Number(
              (
                (1 - tdxCoverageRatio) *
                100
              ).toFixed(1)
            ),

          tdxTravelTimeEvidenceKm:
            Number(
              tdxTravelTimeEvidenceKm
                .toFixed(3)
            ),

          tdxSpeedOnlyEvidenceKm:
            Number(
              tdxSpeedOnlyEvidenceKm
                .toFixed(3)
            ),

          tdxDelayAdjustedKm:
            Number(
              tdxDelayAdjustedDistanceKm
                .toFixed(3)
            ),

          tdxAppliedDelayMin:
            Number(
              (
                tdxPositiveDelaySec /
                60
              ).toFixed(2)
            ),

          liveExpectedMin:
            Number(
              liveExpectedMin
                .toFixed(2)
            ),

          signalCorrection:
            {
              ...signalCorrection,
              appliedToEta: false,
              reason:
                signalCorrection?.cacheAvailable
                  ? "diagnostic-only until calibrated by actual-trip residuals"
                  : signalCorrection?.reason ||
                    "signal cache unavailable",
            },
        }
      );



      const incidentInfo =
        countNearbyIncidents(
          route
        );
        let routeHash = null;

try {
  routeHash =
    createRouteHash(route);
} catch (error) {
  console.warn(
    "[risk db] unable to create route hash:",
    error.message
  );
}


/*
 * Give every route-matched TDX section
 * an explicit Historical scope.
 *
 * city
 *   -> Historical/.../City/{city}
 *
 * freeway
 *   -> Historical/.../Freeway
 *
 * highway
 *   -> Historical/.../Highway
 *
 * If tdxEtaEngine already gives us a
 * freeway/highway scope, preserve it.
 *
 * Otherwise recover the scope using
 * exact SectionID membership from the
 * same live TDX datasets used for ETA.
 *
 * If the same SectionID appears in both
 * archives, do NOT guess.
 */
const matchedSectionsForRisk =
  (
    eta.matchedSections ||
    []
  )
    .map((item) => {
      const sectionId =
        String(
          item?.sectionId ||
          ""
        ).trim();

      const city =
        String(
          item?.city ||
          ""
        ).trim();

      let scope =
        String(
          item?.scope ||
          ""
        )
          .trim()
          .toLowerCase();


      /*
       * A matched City section always
       * belongs to the City archive.
       */
      if (city) {
        scope =
          "city";
      }


      /*
       * Older tdxEtaEngine output may
       * have city:null and no scope.
       *
       * Recover Freeway/Highway from
       * exact SectionID membership.
       */
      if (
        !city &&
        sectionId &&
        ![
          "freeway",
          "highway",
        ].includes(
          scope
        )
      ) {
        const inFreeway =
          freewaySectionIds.has(
            sectionId
          );

        const inHighway =
          highwaySectionIds.has(
            sectionId
          );


        if (
          inFreeway &&
          !inHighway
        ) {
          scope =
            "freeway";
        }

        else if (
          inHighway &&
          !inFreeway
        ) {
          scope =
            "highway";
        }

        else if (
          inFreeway &&
          inHighway
        ) {
          /*
           * Same ID in both archives:
           * skip rather than fabricate
           * an archive assignment.
           */
          console.warn(
            `[history scope] ambiguous SectionID ${sectionId} exists in both Freeway and Highway; skipped`
          );

          scope =
            "";
        }
      }


      return {
        ...item,

        scope,

        city:
          city ||
          null,

        sectionId,
      };
    })
    .filter(
      (item) =>
        [
          "city",
          "freeway",
          "highway",
        ].includes(
          item.scope
        ) &&

        item.sectionId &&

        Number(
          item.matchedDistanceKm ||
          0
        ) > 0 &&

        (
          item.scope !==
            "city" ||
          item.city
        )
    );


console.log(
  "[risk section mix]",
  {
    allMatched:
      (
        eta.matchedSections ||
        []
      ).length,

    riskMatched:
      matchedSectionsForRisk
        .length,

    city:
      matchedSectionsForRisk
        .filter(
          (item) =>
            item.scope ===
            "city"
        ).length,

    freeway:
      matchedSectionsForRisk
        .filter(
          (item) =>
            item.scope ===
            "freeway"
        ).length,

    highway:
      matchedSectionsForRisk
        .filter(
          (item) =>
            item.scope ===
            "highway"
        ).length,

    totalMatchedKm:
      eta.matchedDistanceKm,

    sections:
      matchedSectionsForRisk
        .slice(
          0,
          20
        )
        .map(
          (item) => ({
            scope:
              item.scope,

            city:
              item.city,

            sectionId:
              item.sectionId,

            source:
              item.source,

            matchedDistanceKm:
              item.matchedDistanceKm,
          })
        ),
  }
);


/*
 * riskEngine now receives ALL usable
 * matched TDX road sections.
 */
const riskArgs = {
  baseOsrmMin:
    riskBaselineMin,

  routeDistanceKm,

  routeHash,

  routingEngine:
    route.routingEngine ||
    route.raw?.routingEngine ||
    "unknown",

  matchedSections:
    matchedSectionsForRisk,

  departureTime:
    requestedDepartureTime,
};

console.log("[TEST] skipping historical risk");

let risk = {
  riskStatus: "insufficient_data",
  sampleCount: 0,
  minRequiredUniqueDays: 8,

  weekday: null,
  timeBucket: null,

  worst10Min: null,
  worst5Min: null,
  variance: null,
  varianceLabel: null,
  likelyRangeMin: null,
  standardDeviationMin: null,
  coefficientOfVariation: null,
  stabilityScore: null,
  stabilityLevel: null,

  historicalMeanMin: null,
  historicalMedianMin: null,
  historicalAverageTdxCoverageRatio: null,

  sampleDates: [],
  attemptedDates: [],

  historicalScope: "temporarily disabled for route-speed test",
  riskDataSource: "temporarily disabled for route-speed test",
};

/*
 * FAST PATH:
 *
 * Only read the tiny precomputed snapshot.
 *
 * Never scan Historical files here.
 * Never download Historical here.
 */
const cachedHistoricalRisk =
  await readHistoricalRiskSnapshot({
    routeHash,

    departureTime:
      requestedDepartureTime,
  });


if (
  cachedHistoricalRisk
) {
  risk =
    cachedHistoricalRisk;

  console.log(
    "[history snapshot] HIT",
    {
      route:
        String(
          routeHash ||
          ""
        ).slice(
          0,
          16
        ),

      samples:
        risk.sampleCount,

      status:
        risk.riskStatus,

      p90:
        risk.worst10Min,
    }
  );

} else {
  console.log(
    "[history snapshot] MISS"
  );

  /*
   * LOCAL_HISTORY_REBUILD_ON_SNAPSHOT_MISS_V1
   *
   * A route-specific snapshot may not exist even
   * though the shared Historical daily cache is
   * already available.
   *
   * assessHistoricalRisk() is cache-only, so this
   * performs local reconstruction only:
   *
   *   - no TDX Historical download
   *   - no giant CSV request
   *   - no remote wait
   *
   * This lets a completely new route immediately
   * benefit from Historical days already stored
   * on this machine.
   */
  const localHistoryStartedAt =
    Date.now();

  try {
    const locallyRebuiltRisk =
      await assessHistoricalRisk(
        riskArgs
      );

    if (
      locallyRebuiltRisk
    ) {
      risk =
        locallyRebuiltRisk;
    }

    console.log(
      "[history local rebuild]",
      {
        route:
          String(
            routeHash ||
            ""
          ).slice(
            0,
            16
          ),

        samples:
          Number(
            risk?.sampleCount ||
            0
          ),

        status:
          risk?.riskStatus,

        timeBucket:
          risk?.timeBucket,

        p90:
          risk?.worst10Min,

        elapsedMs:
          Date.now() -
          localHistoryStartedAt,

        remoteDownload:
          false,
      }
    );

  } catch (error) {
    console.warn(
      "[history local rebuild] failed:",
      error.message
    );
  }
}


/*
 * Queue background Historical work.
 *
 * IMPORTANT:
 * no await here.
 */
const historicalTargetUniqueDaysForBackfill =
  Number(
    risk?.historicalTargetUniqueDays
  ) ||
  20;

const historicalBackfillCompletedAtMs =
  Date.parse(
    risk?.historicalBackfillCompletedAt ||
    ""
  );

const historicalBackfillRetryDue =
  !Number.isFinite(
    historicalBackfillCompletedAtMs
  ) ||
  Date.now() -
    historicalBackfillCompletedAtMs >=
      7 * 24 * 60 * 60 * 1000;

/*
 * FORCE_UNDER_8_BACKFILL_V1
 *
 * Fewer than 8 usable samples is always urgent.
 * Do not let a previous "backfill complete" marker
 * block the route from reaching reliability readiness.
 *
 * From 8 to the enrichment target, keep the normal
 * complete / retry-age protection.
 */
const historicalSampleCount =
  Number(
    risk?.sampleCount ||
    0
  );

const historicalUrgentBackfill =
  historicalSampleCount < 8;

const historicalNeedsBackfill =
  historicalSampleCount <
    historicalTargetUniqueDaysForBackfill &&
  (
    historicalUrgentBackfill ||
    risk?.historicalBackfillComplete !==
      true ||
    historicalBackfillRetryDue
  );

if (
  historicalNeedsBackfill
) {
  void enqueueHistoricalBackfill({
    riskArgs,

    matchedSectionsForRisk,
  }).catch(
    (error) => {
      console.warn(
        "[history queue] failed:",
        error.message
      );
    }
  );
}
/*
 * =========================================================
 * AUTOMATIC HISTORICAL BACKFILL
 * =========================================================
 *
 * assessHistoricalRisk itself is cache-only.
 *
 * That is intentional:
 * navigation/risk calculation should never
 * unexpectedly start downloading giant TDX
 * Historical files.
 *
 * THIS block is the explicit population step.
 *
 * It downloads only the Historical archives
 * actually needed by this route:
 *
 *   City/Taipei
 *   City/Taichung
 *   Freeway
 *   Highway
 *
 * etc.
 *
 * After each date is cached, risk is rebuilt.
 * Stop immediately when 8 usable unique days
 * have been obtained.
 */
if (false
) {

  /*
   * Build a unique list of Historical
   * sources required by this route.
   *
   * Example:
   *
   * [
   *   {scope:"city", city:"Taipei"},
   *   {scope:"freeway", city:""},
   *   {scope:"highway", city:""}
   * ]
   */
  const historicalSourceMap =
    new Map();


  for (
    const section of
    matchedSectionsForRisk
  ) {

    const key =
      section.scope ===
        "city"

        ? `city:${section.city}`

        : section.scope;


    if (
      !historicalSourceMap.has(
        key
      )
    ) {

      historicalSourceMap.set(
        key,
        {
          scope:
            section.scope,

          city:
            section.scope ===
              "city"
              ? section.city
              : "",
        }
      );
    }
  }


  const historicalSources =
    [
      ...historicalSourceMap
        .values(),
    ];


  /*
   * riskEngine already generated the
   * correct same-weekday candidate dates.
   *
   * Reuse them instead of independently
   * inventing dates here.
   */
  const candidateDates =
    Array.isArray(
      risk.attemptedDates
    )

      ? [
          ...new Set(
            risk.attemptedDates
          ),
        ].slice(
          0,
          26
        )

      : [];


  console.log(
    "[risk auto-backfill] sources=",
    historicalSources,

    "candidateDates=",
    candidateDates.length
  );


  /*
   * Download one historical DATE at a time.
   *
   * Each daily download automatically builds
   * all 48 half-hour bucket caches.
   */
  for (
    const date of
    candidateDates
  ) {

    if (
      risk.riskStatus ===
      "ready"
    ) {
      break;
    }


    console.log(
      `[risk auto-backfill] route=${String(
        routeHash ||
        "unknown"
      ).slice(
        0,
        12
      )} ` +

      `date=${date} ` +

      `samples=${risk.sampleCount || 0}/8`
    );


    /*
     * A route may need more than one
     * archive on the same date.
     */
    for (
      const source of
      historicalSources
    ) {

      const label =
        source.scope ===
          "city"

          ? `city:${source.city}`

          : source.scope;


      try {

        await getHistoricalRoadBucket({
          scope:
            source.scope,

          city:
            source.city,

          date,

          timeBucket:
            risk.timeBucket,

          /*
           * If this day already exists
           * locally, use the cache.
           */
          forceRefresh:
            false,

          /*
           * This is the explicit backfill
           * step, so remote Historical
           * downloads ARE allowed here.
           */
          cacheOnly:
            false,
        });

      } catch (error) {

        /*
         * One unavailable archive must not
         * cause fake data or crash the
         * entire route calculation.
         */
        console.warn(
          `[risk auto-backfill] ${label} ${date} failed:`,
          error.message
        );
      }
    }


    /*
     * New caches may now exist.
     * Reconstruct the route's historical
     * distribution again.
     */
    risk =
      await assessHistoricalRisk(
        riskArgs
      );


    console.log(
      `[risk auto-backfill] route samples now ` +

      `${risk.sampleCount || 0}/8 ` +

      `status=${risk.riskStatus} ` +

      `coverage=${
        risk
          .historicalAverageTdxCoverageRatio ??
        "n/a"
      }`
    );


    /*
     * Be gentle with TDX Historical.
     * The files are huge.
     */
   if (false
) {
  /*
   * IMPORTANT:
   *
   * Historical backfill runs in the background.
   * The route API does NOT wait for all Historical
   * downloads before returning the route.
   *
   * Current request:
   *   returns immediately with whatever Historical
   *   data is already cached.
   *
   * Background:
   *   progressively fills City / Freeway / Highway
   *   historical caches.
   *
   * Next route request:
   *   automatically sees the newly cached samples.
   */

  const initialRisk =
    risk;

  void (
    async () => {
      let backgroundRisk =
        initialRisk;


      /*
       * Build unique Historical sources
       * required by this route.
       */
      const historicalSourceMap =
        new Map();


      for (
        const section of
        matchedSectionsForRisk
      ) {
        const key =
          section.scope ===
            "city"
            ? `city:${section.city}`
            : section.scope;


        if (
          !historicalSourceMap.has(
            key
          )
        ) {
          historicalSourceMap.set(
            key,
            {
              scope:
                section.scope,

              city:
                section.scope ===
                  "city"
                  ? section.city
                  : "",
            }
          );
        }
      }


      const historicalSources =
        [
          ...historicalSourceMap.values(),
        ];


      /*
       * riskEngine already calculated the
       * correct prior same-weekday dates.
       */
      const candidateDates =
        Array.isArray(
          backgroundRisk.attemptedDates
        )
          ? [
              ...new Set(
                backgroundRisk.attemptedDates
              ),
            ].slice(
              0,
              26
            )
          : [];


      console.log(
        "[risk background-backfill] START",
        {
          route:
            String(
              routeHash ||
              "unknown"
            ).slice(
              0,
              12
            ),

          sources:
            historicalSources,

          candidateDates:
            candidateDates.length,

          currentSamples:
            backgroundRisk.sampleCount ||
            0,
        }
      );


      /*
       * Download one prior weekday
       * at a time.
       */
      for (
        const date of
        candidateDates
      ) {
        if (
          backgroundRisk.riskStatus ===
            "ready"
        ) {
          break;
        }


        console.log(
          `[risk background-backfill] ` +
          `route=${String(
            routeHash ||
            "unknown"
          ).slice(
            0,
            12
          )} ` +
          `date=${date} ` +
          `samples=${
            backgroundRisk.sampleCount ||
            0
          }/8`
        );


        for (
          const source of
          historicalSources
        ) {
          const label =
            source.scope ===
              "city"
              ? `city:${source.city}`
              : source.scope;


          try {
            await getHistoricalRoadBucket({
              scope:
                source.scope,

              city:
                source.city,

              date,

              timeBucket:
                backgroundRisk.timeBucket,

              forceRefresh:
                false,

              cacheOnly:
                false,
            });

          } catch (error) {
            console.warn(
              `[risk background-backfill] ` +
              `${label} ${date} failed:`,
              error.message
            );
          }
        }


        /*
         * Recalculate after this date
         * has been cached.
         */
        backgroundRisk =
          await assessHistoricalRisk(
            riskArgs
          );


        console.log(
          `[risk background-backfill] ` +
          `samples=${
            backgroundRisk.sampleCount ||
            0
          }/8 ` +
          `status=${
            backgroundRisk.riskStatus
          } ` +
          `coverage=${
            backgroundRisk
              .historicalAverageTdxCoverageRatio ??
            "n/a"
          }`
        );


        /*
         * Avoid hammering TDX.
         */
        if (
          backgroundRisk.riskStatus !==
            "ready"
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                2000
              )
          );
        }
      }


      console.log(
        "[risk background-backfill] FINISHED",
        {
          route:
            String(
              routeHash ||
              "unknown"
            ).slice(
              0,
              12
            ),

          status:
            backgroundRisk.riskStatus,

          samples:
            backgroundRisk.sampleCount,

          p90:
            backgroundRisk.worst10Min,

          coverage:
            backgroundRisk
              .historicalAverageTdxCoverageRatio,
        }
      );
    }
  )().catch(
    (error) => {
      console.warn(
        "[risk background-backfill] unexpected failure:",
        error.message
      );
    }
  );
}
  }
}


console.log(
  "[route response risk]",
  {
    routeHash:
      String(
        routeHash ||
        ""
      ).slice(
        0,
        12
      ),

    riskStatus:
      risk.riskStatus,

    sampleCount:
      risk.sampleCount,

    p90:
      risk.worst10Min,

    historicalCoverage:
      risk
        .historicalAverageTdxCoverageRatio,
  }
);

/*
 * ETA_EVIDENCE_FUSION_V3
 * 1) current live TDX positive delay
 * 2) Historical TDX supplement only on current uncovered share
 * 3) robust residual learned from actual completed trips
 */
const tdxTravelTimeCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxTravelTimeEvidenceKm / routeDistanceKm)
    : 0;

const tdxSpeedOnlyCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxSpeedOnlyEvidenceKm / routeDistanceKm)
    : 0;

const effectiveDelayAdjustedCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxDelayAdjustedDistanceKm / routeDistanceKm)
    : 0;

const highConfidenceTravelTimeCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxHighConfidenceTravelTimeEvidenceKm / routeDistanceKm)
    : 0;

const freshEvidenceCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxFreshEvidenceKm / routeDistanceKm)
    : 0;

const mediumConfidenceEvidenceCoverageRatio =
  routeDistanceKm > 0
    ? Math.min(1, tdxMediumConfidenceEvidenceKm / routeDistanceKm)
    : 0;

const uncoveredCoverageRatio =
  Math.max(0, 1 - tdxCoverageRatio);

const historicalGapCorrection =
  calculateHistoricalGapSupplement({
    baseRouterMin,
    liveExpectedMin,
    matchedCoverageRatio: tdxCoverageRatio,
    uncoveredBaselineMin,
    historicalMedianMin: risk.historicalMedianMin,
    historicalCoverageRatio:
      risk.historicalAverageTdxCoverageRatio,
    historicalSampleCount: risk.sampleCount,
  });

const preCalibrationExpectedMin =
  Math.max(
    baseRouterMin,
    liveExpectedMin +
      Number(historicalGapCorrection.supplementMin || 0)
  );

const routeJurisdictions =
  Array.isArray(routeCityLists?.[index])
    ? routeCityLists[index]
    : [];

const etaOriginJurisdiction =
  routeJurisdictions[0] ||
  null;

const etaDestinationJurisdiction =
  routeJurisdictions[
    routeJurisdictions.length - 1
  ] ||
  etaOriginJurisdiction;

const etaCorridorKey =
  buildEtaCorridorKey({
    jurisdictions:
      routeJurisdictions,
    distanceKm:
      routeDistanceKm,
  });

const matchedCityDistanceKmForEvidence =
  liveSectionsForEta
    .filter((section) => Boolean(section?.city))
    .reduce((sum, section) => sum + Number(section?.matchedDistanceKm || 0), 0);

const routeCityPackageDiagnostics =
  routeJurisdictions.map((scope) => {
    const pkg = cityPackages.find((item) => item?.city === scope) || null;
    return {
      scope,
      providerLoaded: Boolean(pkg),
      observedSectionCount: pkg?.observedSections?.length || 0,
      freshLiveCount: pkg?.liveCount || 0,
      rawLiveCount: pkg?.rawLiveCount ?? pkg?.liveCount ?? 0,
      evidenceQualityCounts: pkg?.evidenceQualityCounts || null,
    };
  });

const anyCityProviderLoaded =
  routeCityPackageDiagnostics.some((item) => item.providerLoaded && item.observedSectionCount > 0);

const cityTrafficEvidenceState =
  matchedCityDistanceKmForEvidence > 0
    ? "matched"
    : !routeJurisdictions.length
      ? "jurisdiction_unresolved"
      : !anyCityProviderLoaded
        ? "provider_unavailable_or_no_usable_live_sections"
        : tdxCoverageRatio >= 0.75
          ? "available_but_route_is_road_dominant_or_city_not_nearest_match"
          : "available_but_unmatched_needs_matcher_review";

// UNCOVERED_PRIOR_V9_INSTALLED
const v9UncoveredPrior =
  await assessAndRecordUncoveredPriorV9({
    trainingGroups:
      eta.v9PriorTrainingGroups ||
      [],

    uncoveredGroups:
      eta.v9PriorUncoveredGroups ||
      [],

    jurisdictionSamples:
      route.__jurisdictionSamples ||
      [],

    departureTime:
      requestedDepartureTime,
  });


/*
 * V9 replaces the OLD historical gap
 * supplement as an ETA input.
 *
 * Old historical risk remains available
 * for P90 / reliability statistics.
 */
const v9PreCalibrationExpectedMin =
  Math.max(
    baseRouterMin,

    liveExpectedMin +
      Number(
        v9UncoveredPrior
          .supplementMin ||
        0
      )
  );


console.log(
  "[uncovered prior V9]",
  {
    route:
      route.label,

    status:
      v9UncoveredPrior.status,

    supplementMin:
      v9UncoveredPrior
        .supplementMin,

    samples:
      v9UncoveredPrior
        .sampleCount,

    minRequiredUniqueDays:
      v9UncoveredPrior
        .minRequiredUniqueDays,

    trainingRowsWritten:
      v9UncoveredPrior
        .trainingRowsWritten,

    trainingGroups:
      v9UncoveredPrior
        .trainingGroupCount,

    uncoveredGroups:
      v9UncoveredPrior
        .uncoveredGroupCount,

    appliedGroups:
      v9UncoveredPrior
        .appliedGroupCount,


    currentProxyEligibleGroups:
      v9UncoveredPrior
        .currentProxyEligibleGroupCount ||
      0,

    currentProxyAppliedGroups:
      v9UncoveredPrior
        .currentProxyAppliedGroupCount ||
      0,

    historicalPriorEligibleGroups:
      v9UncoveredPrior
        .historicalPriorEligibleGroupCount ||
      0,

    historicalPriorAppliedGroups:
      v9UncoveredPrior
        .historicalPriorAppliedGroupCount ||
      0,

    weekday:
      v9UncoveredPrior
        .weekday,

    trainingTimeBucket:
      v9UncoveredPrior
        .trainingTimeBucket,

    applicationTimeBucket:
      v9UncoveredPrior
        .applicationTimeBucket,

    reason:
      v9UncoveredPrior
        .reason,
  }
);


const empiricalEtaCalibration =
  getEtaCalibrationCorrection({
    routeHash,
    corridorKey:
      etaCorridorKey,
    departureTime:
      requestedDepartureTime,
    preCalibrationExpectedMin:
      v9PreCalibrationExpectedMin,
  });

expectedMin =
  Math.max(
    baseRouterMin,
    v9PreCalibrationExpectedMin +
      Number(empiricalEtaCalibration.correctionMin || 0)
  );

console.log("[eta final audit]", {
  route: route.label,
  baseRouterMin: roundNumber(baseRouterMin, 2),
  liveExpectedMin: roundNumber(liveExpectedMin, 2),
  historicalSupplementMin: roundNumber(
    v9UncoveredPrior.supplementMin || 0,
    2
  ),
  preCalibrationExpectedMin: roundNumber(
    v9PreCalibrationExpectedMin,
    2
  ),
  learnedResidualCorrectionMin: roundNumber(
    empiricalEtaCalibration.correctionMin || 0,
    2
  ),
  expectedMin: roundNumber(expectedMin, 2),
  matchedCoveragePct: roundNumber(tdxCoverageRatio * 100, 1),
  travelTimeCoveragePct: roundNumber(
    tdxTravelTimeCoverageRatio * 100,
    1
  ),
  effectiveDelayAdjustedCoveragePct: roundNumber(
    effectiveDelayAdjustedCoverageRatio * 100,
    1
  ),
  uncoveredCoveragePct: roundNumber(
    uncoveredCoverageRatio * 100,
    1
  ),
  calibrationScope: empiricalEtaCalibration.scope,
  calibrationSamples: empiricalEtaCalibration.sampleCount,
  historicalStatus: risk.riskStatus,
  historicalSamples: risk.sampleCount,
  historicalReason:
    v9UncoveredPrior.reason,

  uncoveredPriorStatus:
    v9UncoveredPrior.status,

  uncoveredPriorSamples:
    v9UncoveredPrior.sampleCount,

  uncoveredPriorAppliedGroups:
    v9UncoveredPrior.appliedGroupCount,
  highConfidenceTravelTimeCoveragePct: roundNumber(
    highConfidenceTravelTimeCoverageRatio * 100,
    1
  ),
  freshEvidenceCoveragePct: roundNumber(
    freshEvidenceCoverageRatio * 100,
    1
  ),
  mediumConfidenceEvidenceCoveragePct: roundNumber(
    mediumConfidenceEvidenceCoverageRatio * 100,
    1
  ),
  uncoveredBaselineMin: roundNumber(uncoveredBaselineMin, 2),
  uncoveredBaselineSharePct:
    baseRouterMin > 0
      ? roundNumber(uncoveredBaselineMin / baseRouterMin * 100, 1)
      : 0,
  cityTrafficEvidenceState,
  cityMatchedDistanceKm: roundNumber(matchedCityDistanceKmForEvidence, 3),
  cityProviderDiagnostics: routeCityPackageDiagnostics,
  corridorKey: etaCorridorKey,
  routeJurisdictions,
  jurisdictionResolution: route.__jurisdictionDiagnostics || null,
});

try {
  routeHash =
    createRouteHash(route);
} catch (error) {
  console.warn(
    "[risk db] unable to create route hash:",
    error.message
  );
}

      const citySections =
        (
          eta.matchedSections ||
          []
        ).filter(
          (item) =>
            item.city
        );


      const cityMatchedDistanceKm =
        citySections.reduce(
          (sum, item) =>
            sum +
            Number(
              item.matchedDistanceKm ||
              0
            ),
          0
        );


      const cityCoverageRatio =
        routeDistanceKm > 0
          ? Math.min(
              1,
              cityMatchedDistanceKm /
                routeDistanceKm
            )
          : 0;


      enhancedRoutes.push({
        routeId:
          index + 1,

        label:
          route.label,

        /*
         * Frontend history polling key.
         * This is only a deterministic route hash + 30-minute bucket;
         * it does not contain raw Historical data.
         */
        historyRouteHash:
          routeHash,

        historyTimeBucket:
          resolveHistoricalTimeBucket(
            requestedDepartureTime
          ),

        historyPending:
          risk.riskStatus !==
            "ready" &&
          matchedSectionsForRisk.length >
            0,

        etaFeedback: {
          routeHash,
          corridorKey: etaCorridorKey,
          originJurisdiction: etaOriginJurisdiction,
          destinationJurisdiction: etaDestinationJurisdiction,
          jurisdictions: routeJurisdictions,
          distanceKm: roundNumber(routeDistanceKm, 2),
          city: etaOriginJurisdiction,
          departureTime: requestedDepartureTime,
          preCalibrationExpectedMin:
            roundNumber(preCalibrationExpectedMin, 2),
          matchedCoverageRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeCoverageRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          effectiveAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          signalCount:
            Number(signalCorrection?.signalCount || 0),
        },


        // -----------------------------
        // ETA
        // -----------------------------

        routingEngine:
          route.routingEngine ||
          "unknown",

        baseRouterMin:
          roundNumber(
            baseOsrmMin,
            1
          ),

        /*
         * Legacy frontend compatibility.
         * This may now be TomTom, not OSRM.
         */
        baseOsrmMin:
          roundNumber(
            baseOsrmMin,
            1
          ),

        tomtomTraffic:
          isTomTomTraffic
            ? {
                currentMin:
                  roundNumber(
                    Number(
                      route
                        ?.tomtom
                        ?.travelTimeSec ||
                      0
                    ) / 60,
                    1
                  ),

                noTrafficMin:
                  Number.isFinite(
                    Number(
                      route
                        ?.tomtom
                        ?.noTrafficTravelTimeSec
                    )
                  )
                    ? roundNumber(
                        Number(
                          route
                            .tomtom
                            .noTrafficTravelTimeSec
                        ) / 60,
                        1
                      )
                    : null,

                historicTrafficMin:
                  Number.isFinite(
                    Number(
                      route
                        ?.tomtom
                        ?.historicTrafficTravelTimeSec
                    )
                  )
                    ? roundNumber(
                        Number(
                          route
                            .tomtom
                            .historicTrafficTravelTimeSec
                        ) / 60,
                        1
                      )
                    : null,

                trafficDelayMin:
                  Number.isFinite(
                    Number(
                      route
                        ?.tomtom
                        ?.trafficDelaySec
                    )
                  )
                    ? roundNumber(
                        Number(
                          route
                            .tomtom
                            .trafficDelaySec
                        ) / 60,
                        1
                      )
                    : null,

                departureTime:
                  route
                    ?.tomtom
                    ?.departureTime ||
                  null,

                arrivalTime:
                  route
                    ?.tomtom
                    ?.arrivalTime ||
                  null,
              }
            : null,

        expectedMin:
          roundNumber(
            expectedMin,
            1
          ),

        liveExpectedMin:
          roundNumber(
            liveExpectedMin,
            2
          ),

        preCalibrationExpectedMin:
          roundNumber(
            v9PreCalibrationExpectedMin,
            2
          ),

        historicalGapSupplementMin:
          roundNumber(
            v9UncoveredPrior.supplementMin || 0,
            2
          ),

        learnedResidualCorrectionMin:
          roundNumber(
            empiricalEtaCalibration.correctionMin || 0,
            2
          ),

        etaCalibration:
          empiricalEtaCalibration,

        uncoveredPriorV9:
          v9UncoveredPrior,

        etaEvidence: {
          matchedCoverageRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeCoverageRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          speedOnlyCoverageRatio:
            roundNumber(tdxSpeedOnlyCoverageRatio, 4),
          effectiveDelayAdjustedCoverageRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          highConfidenceTravelTimeCoverageRatio:
            roundNumber(highConfidenceTravelTimeCoverageRatio, 4),
          freshEvidenceCoverageRatio:
            roundNumber(freshEvidenceCoverageRatio, 4),
          mediumConfidenceEvidenceCoverageRatio:
            roundNumber(mediumConfidenceEvidenceCoverageRatio, 4),
          uncoveredCoverageRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          uncoveredBaselineMin:
            roundNumber(uncoveredBaselineMin, 3),
          uncoveredBaselineShareRatio:
            baseRouterMin > 0
              ? roundNumber(uncoveredBaselineMin / baseRouterMin, 4)
              : 0,
          historicalStatus:
            risk.riskStatus,
          historicalSamples:
            risk.sampleCount,
          historicalSupplementEligible:
            Boolean(historicalGapCorrection.eligible),
          historicalSupplementReason:
            historicalGapCorrection.reason,
          cityTrafficEvidenceState,
          cityMatchedDistanceKm:
            roundNumber(matchedCityDistanceKmForEvidence, 3),
          cityProviderDiagnostics:
            routeCityPackageDiagnostics,
          calibrationScope:
            empiricalEtaCalibration.scope,
          calibrationSamples:
            empiricalEtaCalibration.sampleCount,
          corridorKey:
            etaCorridorKey,
        },

        delayMin:
          isTomTomTraffic &&
          Number.isFinite(
            Number(
              route
                ?.tomtom
                ?.trafficDelaySec
            )
          )
            ? roundNumber(
                Number(
                  route
                    .tomtom
                    .trafficDelaySec
                ) / 60,
                1
              )
            : roundNumber(
                expectedMin -
                  baseOsrmMin,
                1
              ),

        distanceKm:
          roundNumber(
            routeDistanceKm,
            2
          ),


        /*
          這三個值是讓你查帳用的：

          Expected
          =
          TDX observed
          +
          OSRM uncovered fallback
        */

        tdxObservedMin:
          roundNumber(
            eta.tdxObservedMin,
            2
          ),

        osrmFallbackMin:
          roundNumber(
            eta.osrmFallbackMin,
            2
          ),

        osrmBaselineOnMatchedMin:
          roundNumber(
            eta.osrmBaselineOnMatchedMin,
            2
          ),

        tdxObservedDeltaMin:
          roundNumber(
            Number(
              eta.tdxObservedMin ||
              0
            )
            -
            Number(
              eta.osrmBaselineOnMatchedMin ||
              0
            ),
            2
          ),


        tdxCoverageRatio:
          roundNumber(
            tdxCoverageRatio,
            3
          ),

        combinedLiveCoverageRatio:
          roundNumber(
            tdxCoverageRatio,
            3
          ),

        liveCoverage: {
          matchedRatio:
            roundNumber(tdxCoverageRatio, 4),
          travelTimeRatio:
            roundNumber(tdxTravelTimeCoverageRatio, 4),
          speedOnlyRatio:
            roundNumber(tdxSpeedOnlyCoverageRatio, 4),
          effectiveDelayAdjustedRatio:
            roundNumber(effectiveDelayAdjustedCoverageRatio, 4),
          uncoveredRatio:
            roundNumber(uncoveredCoverageRatio, 4),
          historicalAverageRatio:
            Number.isFinite(
              Number(risk.historicalAverageTdxCoverageRatio)
            )
              ? roundNumber(
                  Number(risk.historicalAverageTdxCoverageRatio),
                  4
                )
              : null,
        },

        matchedDistanceKm:
          roundNumber(
            eta.matchedDistanceKm,
            2
          ),

        matchedCount:
          eta.matchedCount,

        vdLive: {
          candidateSensorCount:
            vdBundle
              .diagnostics
              .nearbySensors,

          requestedSensorCount:
            vdBundle
              .diagnostics
              .requestedSensors,

          successfulSensorCount:
            vdBundle
              .diagnostics
              .successfulSensors,

          observationCount:
            vdBundle
              .diagnostics
              .observations,

          errors:
            vdBundle
              .diagnostics
              .errors
        },

        matchedSections:
          eta.matchedSections ||
          [],


        latestLiveDataTime:
          eta.latestLiveDataTime,


        liveDataAgeMin:
          eta.latestLiveDataTime &&
          Number.isFinite(
            liveAgeMin(
              eta.latestLiveDataTime
            )
          )
            ? roundNumber(
                liveAgeMin(
                  eta.latestLiveDataTime
                ),
                1
              )
            : null,


        matchingPolicy:
          eta.matchingPolicy,


        etaSource:
          isTomTomTraffic
            ? "TomTom traffic-aware full-network routing"
            : eta.source,

        trafficSource:
          isTomTomTraffic
            ? "TomTom current traffic"
            : eta.source,

        trafficLevel:
          isTomTomTraffic
            ? "Traffic-aware routing"
            : eta.source,


        trafficDescription:
          isTomTomTraffic
            ? (
                `Expected ETA uses TomTom traffic-aware routing across the full route. ` +
                `TDX official LiveTraffic matched ${roundNumber(
                  tdxCoverageRatio * 100,
                  0
                )}% (${roundNumber(
                  eta.matchedDistanceKm,
                  2
                )} km) as an independent validation/data layer.`
              )

            : tdxCoverageRatio > 0
              ? `TDX live covers ${roundNumber(
                  tdxCoverageRatio * 100,
                  0
                )}% (${roundNumber(
                  eta.matchedDistanceKm,
                  2
                )} km).`

              : "No fresh TDX road observation matched; routing-engine baseline is used.",


        /*
          舊 frontend 相容欄位。

          注意：
          這只是結果比例。
          沒有拿來乘時間。
        */

        trafficFactor:
          isTomTomTraffic &&
          Number(
            route
              ?.tomtom
              ?.noTrafficTravelTimeSec ||
            0
          ) > 0

            ? roundNumber(
                Number(
                  route
                    .tomtom
                    .travelTimeSec
                ) /
                Number(
                  route
                    .tomtom
                    .noTrafficTravelTimeSec
                ),
                3
              )

            : baseOsrmMin > 0
              ? roundNumber(
                  expectedMin /
                  baseOsrmMin,
                  3
                )
              : 1,


        timeOfDayFactor:
          1,

        incidentPenalty:
          0,

        noArtificialMultiplier:
          true,


        cityTraffic: {
          available:
            cityCoverageRatio >
            0,

          cities,

          coverageRatio:
            roundNumber(
              cityCoverageRatio,
              3
            ),

          matchedSectionCount:
            citySections.length,

          matchedSections:
            citySections,

          source:
            "TDX city published LiveTraffic"
        },


        // -----------------------------
        // REAL RISK
        // -----------------------------

        riskStatus:
          risk.riskStatus,

        riskSampleCount:
          risk.sampleCount,

        riskMinRequiredUniqueDays:
          risk.minRequiredUniqueDays,

        riskHistoricalTargetUniqueDays:
          risk.historicalTargetUniqueDays,

        riskHistoricalTargetReached:
          Boolean(
            risk.historicalTargetReached
          ),

        riskPercentileConfidence:
          risk.percentileConfidence,

        riskHistoricalBackfillComplete:
          Boolean(
            risk.historicalBackfillComplete
          ),

        riskHistoricalBackfillCompletedAt:
          risk.historicalBackfillCompletedAt ||
          null,

        riskDataSource:
          risk.riskDataSource,

        worst10Min:
          risk.worst10Min,

        worst5Min:
          risk.worst5Min,

        variance:
          risk.variance,

        varianceLabel:
          null,

        standardDeviationMin:
          risk.standardDeviationMin,

        coefficientOfVariation:
          risk.coefficientOfVariation,

        historicalMeanMin:
          risk.historicalMeanMin,

        historicalMedianMin:
          risk.historicalMedianMin,

          historicalAverageTdxCoverageRatio:
  risk.historicalAverageTdxCoverageRatio,

        /*
          不再自己發明 0-100 Stability。
        */

        stabilityScore:
          null,

        stabilityLevel:
          null,


        etaConfidence:
          confidenceFromCoverage(
            tdxCoverageRatio
          ),

        etaCalibrationAvailable:
          empiricalEtaCalibration.available,


        // -----------------------------
        // Incident
        // -----------------------------

        incidentCount:
          incidentInfo.count,

        incidents:
          incidentInfo.incidents,


        geometry:
          route.geometry,

        raw:
          route
      });
    }


    const fastestRoute =
      enhancedRoutes.reduce(
        (best, route) =>
          route.expectedMin <
          best.expectedMin
            ? route
            : best
      );


    const riskReadyRoutes =
      enhancedRoutes.filter(
        (route) =>
          route.riskStatus ===
            "ready" &&
          Number.isFinite(
            Number(
              route.worst10Min
            )
          )
      );


    const reliableRoute =
      riskReadyRoutes.length
        ? riskReadyRoutes.reduce(
            (best, route) =>
              route.worst10Min <
              best.worst10Min
                ? route
                : best
          )
        : null;


    /*
      Risk 資料不夠時，
      不准假裝知道哪條最可靠。
    */

    const selectedRoute =
      reliableRoute ||
      fastestRoute;


    const finalRoutes =
      enhancedRoutes.map(
        (route) => {

          const isFastest =
            route.routeId ===
            fastestRoute.routeId;


          const isReliable =
            reliableRoute &&
            route.routeId ===
              reliableRoute.routeId;


          let routeType =
            "Alternative Route";


          if (
            isFastest &&
            isReliable
          ) {
            routeType =
              "Fast + Most Reliable";

          } else if (
            isReliable
          ) {
            routeType =
              "Most Reliable Route";

          } else if (
            isFastest
          ) {
            routeType =
              "Fast Route";
          }


          return {
            ...route,

            routeType,

            fastestExpectedMin:
              fastestRoute.expectedMin,

            bestWorst10Min:
              reliableRoute
                ?.worst10Min ??
              null,

            userChoiceHint:
              isReliable
                ? "由真實歷史 TDX observation 的 empirical P90 選出。"
                : isFastest
                ? "目前以 live TDX + Historical uncovered-gap supplement + actual-trip residual calibration 的 Expected ETA 最短。"
                : route.incidentCount > 0
                ? "TDX 回報附近事件；事件只顯示，不自行增加分鐘。"
                : "候選道路路線。"
          };
        }
      );


    res.json({
      mode:
        "real-tdx-live-navigation-v2",

      departureTime:
        requestedDepartureTime,

      timeZone:
        "Asia/Taipei",

      etaSource:
        "OSRM route + per-step baseline; each road piece uses at most one strictly map-matched TDX observation",

      routes:
        finalRoutes,


      recommendation: {
        label:
          selectedRoute.label,

        routeType:
          reliableRoute
            ? "Most Reliable Route"
            : "Fastest Available Route",

        reason:
          reliableRoute
            ? "已有足夠真實歷史 observation，因此使用 empirical P90 最低者。"
            : "歷史樣本不足，不假造 Worst 10%；目前先推薦 Expected ETA 最短的路線。",

        selected: {
          routeId:
            selectedRoute.routeId,

          label:
            selectedRoute.label,

          expectedMin:
            selectedRoute.expectedMin,

          worst10Min:
            selectedRoute.worst10Min,

          riskStatus:
            selectedRoute.riskStatus,

          riskSampleCount:
            selectedRoute.riskSampleCount,

          liveCoverageRatio:
            selectedRoute
              .combinedLiveCoverageRatio
        },

        fastest: {
          routeId:
            fastestRoute.routeId,

          label:
            fastestRoute.label,

          expectedMin:
            fastestRoute.expectedMin,

          worst10Min:
            fastestRoute.worst10Min,

          riskStatus:
            fastestRoute.riskStatus,

          liveCoverageRatio:
            fastestRoute
              .combinedLiveCoverageRatio
        }
      },


      traffic: {
        /*
          factor 保留只是為了舊 frontend，
          它不是 ETA input。
        */

        factor:
          selectedRoute
            .trafficFactor,

        level:
          selectedRoute
            .trafficLevel,

        description:
          selectedRoute
            .trafficDescription,

        period:
          "Current TDX live data",

        combinedLiveCoverageRatio:
          selectedRoute
            .combinedLiveCoverageRatio,

        latestLiveDataTime:
          selectedRoute
            .latestLiveDataTime,

        tdxObservedMin:
          selectedRoute
            .tdxObservedMin,

        osrmFallbackMin:
          selectedRoute
            .osrmFallbackMin,

        segmentBased:
          true,

        noArtificialMultiplier:
          true
      },


      dataQuality: {
        eta:
          "OSRM duration is decomposed using each real OSRM step duration instead of one whole-route average speed.",

        matching:
          "TDX match requires <=50m for City, <=60m for freeway/highway, and <=35-degree direction difference.",

        oneMatchPerPiece:
          "Each route piece can use at most one TDX observation, so City and Highway cannot both modify the same piece.",

        risk:
          "Worst 10%, variance and SD are empirical only. If there are not enough distinct prior days, values are null.",

        incidents:
          "Incidents are diagnostics only and never add arbitrary minutes."
      },


      explanation:
        "Expected = Valhalla baseline + current positive TDX live delay + evidence-gated Historical supplement for current uncovered share + learned residual from actual completed trips. Signal count remains diagnostic until empirical calibration exists; no fixed global multiplier is applied."
    });

  } catch (error) {
    console.error("Real TDX route API error:", error);

    if (error?.status === 429 || error?.code === "TDX_RATE_LIMIT") {
      return res.status(429).json({
        error: "TDX rate limited",
        detail:
          "TDX 回傳 HTTP 429。這版已使用 queue/cache；請稍後重試，或把 TDX_MIN_INTERVAL_MS 調大。",
      });
    }

    res.status(500).json({ error: "Server error", detail: error.message });
  }
});



// 多點＋多交通工具 API
// 多點＋多交通工具 API
app.post("/api/multimodal-route", async (req, res) => {
  try {
    const { points, departureTime = "09:00" } = req.body;

    if (!Array.isArray(points) || points.length < 2) {
      return res.status(400).json({
        error: "points must be an array with at least 2 points",
      });
    }

    // 只有開車/公車才需要道路即時路況
    // walk / mrt / hsr / train 不需要 freeway/highway live traffic
    const needsRoadTraffic = points.some((point) => {
      const mode = point.modeFromPrevious;
      return mode === "drive" || mode === "bus";
    });

    let freewayLiveTrafficData = null;
    let highwayLiveTrafficData = null;
    let trafficInfo = {
      factor: 1,
      level: "No road traffic needed",
      description:
        "This route does not use road traffic data because it has no drive/bus segment.",
    };

    if (needsRoadTraffic) {
      const results = await Promise.allSettled([
        getFreewayLiveTraffic(),
        getHighwayLiveTraffic(),
      ]);

      freewayLiveTrafficData =
        results[0].status === "fulfilled" ? results[0].value : null;
      highwayLiveTrafficData =
        results[1].status === "fulfilled" ? results[1].value : null;

      trafficInfo = {
        factor: 1,
        level: "TDX route-specific live only",
        description:
          "No global or time-of-day multiplier. Drive/bus segments use matched TDX observed road speed where available; uncovered road stays at OSRM baseline.",
      };
    }

    const result = await planMultiModalRoute({
      points,
      departureTime,
      globalTrafficFactor: 1,
      trafficInfo,
      freewayData: freewayLiveTrafficData,
      highwayData: highwayLiveTrafficData,
      osrmBaseUrl: OSRM_BASE_URL,
    });

    res.json({
      ...result,
      traffic: {
        factor: Number((trafficInfo.factor || 1).toFixed(2)),
        level: trafficInfo.level,
        description: trafficInfo.description,
      },
    });
  } catch (error) {
    console.error("Multimodal route API error:", error);

    res.status(500).json({
      error: "Server error",
      detail: error.message,
    });
  }
});

app.get("/api/tdx-openlr-sample", async (req, res) => {
  try {
    const freewayData = await getFreewayLiveTraffic();
    const highwayData = await getHighwayLiveTraffic();

    const freewayList = Array.isArray(freewayData?.LiveTraffics)
      ? freewayData.LiveTraffics
      : Array.isArray(freewayData)
      ? freewayData
      : [];

    const highwayList = Array.isArray(highwayData?.LiveTraffics)
      ? highwayData.LiveTraffics
      : Array.isArray(highwayData)
      ? highwayData
      : [];

    const samples = [...freewayList, ...highwayList].slice(0, 10).map(
      (item) => ({
        SectionID: item.SectionID,
        OpenLRs: item.OpenLRs,
        TravelSpeed: item.TravelSpeed,
        CongestionLevelID: item.CongestionLevelID,
        CongestionLevel: item.CongestionLevel,
        DataCollectTime: item.DataCollectTime,
      })
    );

    res.json({
      status: "ok",
      count: freewayList.length + highwayList.length,
      samples,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/tdx-raw-sample", async (req, res) => {
  try {
    const freewayData = await getFreewayLiveTraffic();
    const highwayData = await getHighwayLiveTraffic();

    const freewayList = Array.isArray(freewayData?.LiveTraffics)
      ? freewayData.LiveTraffics
      : Array.isArray(freewayData)
      ? freewayData
      : [];

    const highwayList = Array.isArray(highwayData?.LiveTraffics)
      ? highwayData.LiveTraffics
      : Array.isArray(highwayData)
      ? highwayData
      : [];

    res.json({
      status: "ok",
      freewayCount: freewayList.length,
      highwayCount: highwayList.length,
      freewayFirstItem: freewayList[0] || null,
      highwayFirstItem: highwayList[0] || null,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/openlr-route-match-test", async (req, res) => {
  try {
    const { startLat, startLng, endLat, endLng } = req.query;

    if (!startLat || !startLng || !endLat || !endLng) {
      return res.status(400).json({
        status: "error",
        message: "Missing startLat, startLng, endLat, endLng",
      });
    }

    const osrmUrl =
      `${OSRM_BASE_URL}/route/v1/driving/` +
      `${startLng},${startLat};${endLng},${endLat}` +
      `?alternatives=true&overview=full&geometries=geojson&steps=true`;

    const osrmResponse = await fetch(osrmUrl);
    const osrmData = await osrmResponse.json();

    const freewayData = await getFreewayLiveTraffic();
    const highwayData = await getHighwayLiveTraffic();

    const route = osrmData.routes?.[0];

    if (!route) {
      return res.status(404).json({
        status: "error",
        message: "No OSRM route found",
      });
    }

    const routeTraffic = calculateOpenLRRouteLevelTraffic({
      route,
      freewayData,
      highwayData,
      matchThresholdKm: 0.25,
    });

    res.json({
      status: "ok",
      routeDistanceKm: Number((route.distance / 1000).toFixed(2)),
      routeDurationMin: Number((route.duration / 60).toFixed(1)),
      routeTraffic,
    });
  } catch (error) {
    console.error("OpenLR route match test error:", error);

    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/tdx-live-traffic-polylines", async (req, res) => {
  try {
    const rawData = await getHighwayLiveTraffic();

    const trafficSections = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.LiveTraffics)
      ? rawData.LiveTraffics
      : Array.isArray(rawData?.samples)
      ? rawData.samples
      : Array.isArray(rawData?.data)
      ? rawData.data
      : [];

    const sections = trafficSections
      .filter((section) => {
        const level = Number(section.CongestionLevel);
        return level >= 2;
      })
      .slice(0, 50)
      .map((section) => {
        const polylines = [];
        const openLRs = section.OpenLRs || [];

        openLRs.forEach((item) => {
          try {
            const openlrString = item.OpenLR || item.openLR || item;
            const decoded = openLrToPolyline(openlrString);

            if (decoded && decoded.length > 0) {
              polylines.push(decoded);
            }
          } catch (error) {
            console.log("OpenLR decode failed:", section.SectionID, error.message);
          }
        });

        return {
          sectionId: section.SectionID,
          travelSpeed: section.TravelSpeed,
          congestionLevel: section.CongestionLevel,
          dataCollectTime: section.DataCollectTime,
          openLRCount: openLRs.length,
          polylines,
        };
      });

    res.json({
      status: "ok",
      sourceCount: trafficSections.length,
      count: sections.length,
      sections,
    });
  } catch (error) {
    console.error("Failed to get TDX live traffic polylines:", error);

    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/api/tdx-test", async (req, res) => {
  try {
    const thsrStations = await getTHSRStations();
    const traStations = await getTRAStations();

    res.json({
      success: true,
      message: "TDX connected successfully",
      thsrStationCount: thsrStations.length,
      traStationCount: traStations.length,
      sampleTHSR: thsrStations.slice(0, 3),
      sampleTRA: traStations.slice(0, 3),
    });
  } catch (error) {
    console.error("TDX test failed:", error);

    res.status(500).json({
      success: false,
      message: "TDX test failed",
      error: error.message,
    });
  }
});

function fixChineseQueryText(value) {
  if (!value) return "";

  const text = String(value);

  if (/[\u4e00-\u9fff]/.test(text)) {
    return text;
  }

  try {
    return Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }
}

app.get("/api/thsr-next", async (req, res) => {
  try {
    const from = fixChineseQueryText(req.query.from || "台北");
    const to = fixChineseQueryText(req.query.to || "左營");
    const time = req.query.time || "09:00";

    const nextTrain = await findNextTHSRTrain({
      from,
      to,
      time,
    });

    if (!nextTrain) {
      return res.status(404).json({
        success: false,
        message: "No THSR train found after requested time",
        from,
        to,
        requestedTime: time,
      });
    }

    res.json({
      success: true,
      type: "THSR_REAL_TIMETABLE",
      from,
      to,
      requestedTime: time,
      nextTrain,
    });
  } catch (error) {
    console.error("THSR next train failed:", error);

    res.status(500).json({
      success: false,
      message: "THSR next train failed",
      error: error.message,
    });
  }
});

app.get("/api/mrt-stations", async (req, res) => {
  try {
    const railSystem = req.query.system || "TRTC";
    const stations = await getMetroStations(railSystem);

    res.json({
      success: true,
      railSystem,
      count: stations.length,
      sample: stations.slice(0, 5),
    });
  } catch (error) {
    console.error("MRT stations failed:", error);

    res.status(500).json({
      success: false,
      message: "MRT stations failed",
      error: error.message,
    });
  }
});

app.get("/api/mrt-liveboard", async (req, res) => {
  try {
    const railSystem = req.query.system || "TRTC";
    const liveBoard = await getMetroLiveBoard(railSystem);

    res.json({
      success: true,
      railSystem,
      count: liveBoard.length,
      sample: liveBoard.slice(0, 10),
    });
  } catch (error) {
    console.error("MRT liveboard failed:", error);

    res.status(500).json({
      success: false,
      message: "MRT liveboard failed",
      error: error.message,
    });
  }
});

app.get("/api/mrt-route", async (req, res) => {
  try {
    const from = fixChineseQueryText(req.query.from || "台北車站");
    const to = fixChineseQueryText(req.query.to || "亞東醫院");
    const time = req.query.time || "09:00";
    const railSystem = req.query.system || "TRTC";

    const route = await planMrtSameLineRoute({
      from,
      to,
      time,
      railSystem,
    });

    res.json({
      success: true,
      type: "MRT_REALISTIC_ROUTE",
      from,
      to,
      requestedTime: time,
      route,
    });
  } catch (error) {
    console.error("MRT route failed:", error);

    res.status(500).json({
      success: false,
      message: "MRT route failed",
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
