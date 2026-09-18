import "dotenv/config";
import express from "express";
import { assessHistoricalRisk } from "./riskEngine.js";
import { buildTdxRoadIndex, buildTdxVdIndex, calculateTdxHybridEta } from "./tdxEtaEngine.js";
import { loadRouteVdObservations } from "./tdxVdRouteEngine.js";
import { resolvePlaceUniversal } from "./placeSearchEngine.js";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { planMultiModalRoute } from "./multimodalRoutePlanner.js";
import { calculateRouteSpecificTraffic } from "./routeTrafficMatcher.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
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
} from "./tdxClient.js";


const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "../frontend")));

const PORT = process.env.PORT || 3000;

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || "").trim();
const TOMTOM_API_KEY = String(process.env.TOMTOM_API_KEY || "").trim();

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

console.log("Groq Key:", GROQ_API_KEY ? "Loaded" : "Missing");
console.log("Geocoding: Groq normalization + grounded TDX data; TGOS government fallback");
console.log("Routing: Real TDX live sections + OSRM uncovered-road fallback (no artificial traffic multiplier)");

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    error: "Too many requests. Please try again later.",
  },
});

app.use("/api", limiter);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    osrm: OSRM_BASE_URL,
    geocoding: "AI text normalization + TDX grounded coordinates + TGOS fallback",
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
    const city = String(req.query.city || "Taipei").trim();
    const staticData = await getCityVDStatic(city);
    const vds = extractVdList(staticData);

    if (!vds.length) {
      return res.status(404).json({
        status: "error",
        city,
        message: "TDX city VD static list is empty",
      });
    }

    const sampleVds = vds.slice(0, 1);
    const liveResults = await Promise.allSettled(
      sampleVds.map(async (vd) => {
        const data = await getCityVDLive(city, vd.VDID);
        return {
          vdId: vd.VDID,
          roadName: vd.RoadName || null,
          position: vdPosition(vd),
          live: parseVdLiveReading(data, vd.VDID),
        };
      })
    );

    res.json({
      status: "ok",
      city,
      staticCount: vds.length,
      samples: liveResults.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : { error: result.reason?.message || "unknown error" }
      ),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "TDX city VD test failed",
      detail: error.message,
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

        tomtomApiKey:
          TOMTOM_API_KEY,

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

const TDX_CITY_BOUNDS = [
  { city: "Taipei", minLat: 24.95, maxLat: 25.22, minLon: 121.43, maxLon: 121.69 },
  { city: "Keelung", minLat: 25.03, maxLat: 25.21, minLon: 121.60, maxLon: 121.82 },
  { city: "NewTaipei", minLat: 24.62, maxLat: 25.34, minLon: 121.25, maxLon: 122.08 },
  { city: "Taoyuan", minLat: 24.72, maxLat: 25.16, minLon: 120.97, maxLon: 121.36 },
  { city: "Hsinchu", minLat: 24.70, maxLat: 24.92, minLon: 120.84, maxLon: 121.08 },
  { city: "Taichung", minLat: 23.98, maxLat: 24.36, minLon: 120.43, maxLon: 121.00 },
  { city: "Tainan", minLat: 22.86, maxLat: 23.42, minLon: 120.00, maxLon: 120.62 },
  { city: "Kaohsiung", minLat: 22.45, maxLat: 23.10, minLon: 120.14, maxLon: 120.60 },
  { city: "Chiayi", minLat: 23.40, maxLat: 23.56, minLon: 120.37, maxLon: 120.53 },
];

function cityForPoint(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return (
    TDX_CITY_BOUNDS.find(
      (item) =>
        lat >= item.minLat &&
        lat <= item.maxLat &&
        lon >= item.minLon &&
        lon <= item.maxLon
    )?.city || null
  );
}

function routeCandidateCities(route) {
  const coordinates = route?.geometry?.coordinates || [];
  if (!coordinates.length) return [];

  const counts = new Map();
  const step = Math.max(1, Math.floor(coordinates.length / 100));

  for (let i = 0; i < coordinates.length; i += step) {
    const [lon, lat] = coordinates[i] || [];
    const city = cityForPoint(Number(lon), Number(lat));
    if (!city) continue;
    counts.set(city, (counts.get(city) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([city]) => city);
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
  if (!value) return true;
  const age = liveAgeMin(value);
  if (!Number.isFinite(age)) return true;
  return age >= -2 && age <= maxAgeMin;
}

function buildCityObservedSections(city, shapeData, sectionLinkData, liveData) {
  const shapes = extractSectionShapes(shapeData);
  const sectionLinks = extractSectionLinks(sectionLinkData);
  const lives = extractLiveTraffics(liveData).filter((item) => isFreshLive(item));

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
    let dataCollectTime = live?.DataCollectTime || null;
    let travelTimeSec = Number(live?.TravelTime);
    let travelSpeedKmh = Number(live?.TravelSpeed);
    let dataSources = live?.DataSources || null;
    let constituentLiveCount = live ? 1 : 0;

    if (!live) {
      const linkIds = linkIdsBySection.get(sectionId) || [];
      const linkLives = linkIds.map((id) => byLink.get(id)).filter(Boolean);

      // Only aggregate when SectionLink explicitly lists all LinkIDs. We do not
      // guess the internal links from StartLinkID/EndLinkID alone.
      if (linkIds.length && linkLives.length) {
        source = "LinkID aggregate";
        constituentLiveCount = linkLives.length;
        dataCollectTime = latestIsoTime(linkLives);

        const validTimes = linkLives
          .map((item) => Number(item?.TravelTime))
          .filter((value) => Number.isFinite(value) && value > 0);

        const validSpeeds = linkLives
          .map((item) => Number(item?.TravelSpeed))
          .filter((value) => Number.isFinite(value) && value >= 1 && value <= 160);

        // A summed link TravelTime is the best available observed section time
        // when the authority publishes link-based LiveTraffic.
        if (validTimes.length === linkLives.length) {
          travelTimeSec = validTimes.reduce((sum, value) => sum + value, 0);
        } else {
          travelTimeSec = NaN;
        }

        travelSpeedKmh = validSpeeds.length
          ? validSpeeds.reduce((sum, value) => sum + value, 0) / validSpeeds.length
          : NaN;

        dataSources = linkLives.map((item) => item?.DataSources).filter(Boolean);
      }
    }

    if (!live && source === "SectionID") continue;

    let observedSpeedKmh = null;
    let observedFrom = null;

    if (Number.isFinite(travelTimeSec) && travelTimeSec > 0) {
      const speedFromTravelTime = sectionLengthKm / (travelTimeSec / 3600);
      if (speedFromTravelTime >= 1 && speedFromTravelTime <= 160) {
        observedSpeedKmh = speedFromTravelTime;
        observedFrom = "TravelTime";
      }
    }

    if (
      observedSpeedKmh === null &&
      Number.isFinite(travelSpeedKmh) &&
      travelSpeedKmh >= 1 &&
      travelSpeedKmh <= 160
    ) {
      observedSpeedKmh = travelSpeedKmh;
      observedFrom = "TravelSpeed";
    }

    if (!Number.isFinite(observedSpeedKmh) || observedSpeedKmh <= 0) continue;

    observedSections.push({
      city,
      sectionId,
      polylines,
      sectionLengthKm,
      observedSpeedKmh,
      observedFrom,
      travelTimeSec: Number.isFinite(travelTimeSec) ? travelTimeSec : null,
      travelSpeedKmh: Number.isFinite(travelSpeedKmh) ? travelSpeedKmh : null,
      congestionLevel: live?.CongestionLevel ?? null,
      congestionLevelID: live?.CongestionLevelID ?? null,
      dataCollectTime,
      dataSources,
      constituentLiveCount,
    });
  }

  return {
    city,
    observedSections,
    shapeCount: shapes.length,
    liveCount: lives.length,
    directSectionCount: directBySection.size,
    linkLiveCount: byLink.size,
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
  if (!cities.length) return [];

  const packages = [];

  // Keep the city-level requests sequential. fetchTdxJson already queues all
  // TDX calls, but this also avoids a large Promise.all burst at this layer.
  for (const city of cities) {
    try {
      const [shapeData, sectionLinkData, liveData] = await Promise.all([
        getCitySectionShapes(city),
        getCitySectionLinks(city),
        getCityLiveTraffic(city),
      ]);

      packages.push(
        buildCityObservedSections(city, shapeData, sectionLinkData, liveData)
      );
    } catch (error) {
      console.log(`TDX city section traffic unavailable (${city}):`, error.message);
    }
  }

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
    const city = String(req.query.city || "Taipei").trim();
    const [shapeData, sectionLinkData, liveData] = await Promise.all([
      getCitySectionShapes(city),
      getCitySectionLinks(city),
      getCityLiveTraffic(city),
    ]);

    const pkg = buildCityObservedSections(city, shapeData, sectionLinkData, liveData);

    res.json({
      status: "ok",
      city,
      shapeCount: pkg.shapeCount,
      liveCount: pkg.liveCount,
      directlySectionKeyedLiveCount: pkg.directSectionCount,
      linkKeyedLiveCount: pkg.linkLiveCount,
      usableObservedSectionCount: pkg.observedSections.length,
      sample: pkg.observedSections.slice(0, 5).map((item) => ({
        sectionId: item.sectionId,
        observedFrom: item.observedFrom,
        observedSpeedKmh: roundNumber(item.observedSpeedKmh, 1),
        travelTimeSec: item.travelTimeSec,
        travelSpeedKmh: item.travelSpeedKmh,
        dataCollectTime: item.dataCollectTime,
        constituentLiveCount: item.constituentLiveCount,
      })),
      note: "These are TDX published live section observations. No traffic coefficient is generated here.",
    });
  } catch (error) {
    res.status(error?.status === 429 ? 429 : 500).json({
      status: "error",
      message: error.message,
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

    const baseRoutes = await getOsrmRoutes();
    if (!baseRoutes.length) {
      return res.status(404).json({ error: "No route found" });
    }

    const cities = [
      ...new Set(baseRoutes.flatMap((route) => routeCandidateCities(route))),
    ].slice(0, 2);

    const cityPackages =
      await loadCityLivePackages(
        cities
      );

    /*
      用 VD Static 的 DetectionLinks.LinkID
      補 City LiveTraffic section 的道路名稱。

      這不會使用 VD speed 修改 ETA。
    */
    await attachVdStaticRoadMetadata(
      cityPackages
    );

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
    const roadLiveResults = await Promise.allSettled([
      getFreewayLiveTraffic(),
      getHighwayLiveTraffic(),
    ]);

    const freewayLiveTrafficData =
      roadLiveResults[0].status === "fulfilled" ? roadLiveResults[0].value : null;
    const highwayLiveTrafficData =
      roadLiveResults[1].status === "fulfilled" ? roadLiveResults[1].value : null;

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

    const roadIndex =
      buildTdxRoadIndex({
        freewayData:
          freewayLiveTrafficData,

        highwayData:
          highwayLiveTrafficData,

        openLrToPolyline
      });


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


      const expectedMin =
        Number(
          eta.expectedMin ||
          baseOsrmMin
        );


      const tdxCoverageRatio =
        Number(
          eta.tdxCoverageRatio ||
          0
        );


      const incidentInfo =
        countNearbyIncidents(
          route
        );


      const risk =
        await assessHistoricalRisk({
          baseOsrmMin,
          routeDistanceKm,

          // calculateTdxHybridEta 已經把同一路線實際命中的
          // TDX section 與 matchedDistanceKm 整理好了。
          // Historical risk 只使用有 city + SectionID 的部分。
          matchedCitySections:
            (
              eta.matchedSections ||
              []
            ).filter(
              (item) =>
                item.city &&
                item.sectionId &&
                Number(
                  item.matchedDistanceKm ||
                  0
                ) > 0
            ),

          departureTime:
            requestedDepartureTime
        });


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


        // -----------------------------
        // ETA
        // -----------------------------

        baseOsrmMin:
          roundNumber(
            baseOsrmMin,
            1
          ),

        expectedMin:
          roundNumber(
            expectedMin,
            1
          ),

        delayMin:
          roundNumber(
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
          eta.source,

        trafficSource:
          eta.source,

        trafficLevel:
          eta.source,


        trafficDescription:
          tdxCoverageRatio > 0
            ? `TDX live covers ${roundNumber(tdxCoverageRatio * 100, 0)}% (${roundNumber(eta.matchedDistanceKm, 2)} km). Expected = ${roundNumber(eta.tdxObservedMin, 2)} min TDX observed + ${roundNumber(eta.osrmFallbackMin, 2)} min OSRM uncovered baseline.`
            : "No fresh TDX road observation matched. Expected ETA equals OSRM baseline.",


        /*
          舊 frontend 相容欄位。

          注意：
          這只是結果比例。
          沒有拿來乘時間。
        */

        trafficFactor:
          baseOsrmMin > 0
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
                ? "目前 TDX live + OSRM uncovered baseline 的 Expected ETA 最短。"
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
        "Expected = TDX-observed time on strictly matched pieces + original OSRM step baseline on uncovered pieces. No peak-hour coefficient, speed clamp, congestion multiplier, incident penalty, or guessed risk coefficient is used."
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