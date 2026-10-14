// server.js
//
// Standalone test bed for the Pedestrian Safety Mode scoring module,
// split out of the full Risk-Aware Navigation project (112-project) so
// its THREE data sources -- real traffic accidents, real streetlights,
// real convenience stores -- can be audited and improved on their own,
// without needing the rest of the navigation app (OSRM multi-modal
// routing, TDX live traffic, geocoding, etc.) running at the same time.
//
// This file is a deliberately trimmed copy of 112-project/backend's own
// /api/pedestrian-safety GET + POST handlers (same request/response
// shape, same scoring math -- pedestrianSafety/ here is an unmodified
// copy of that project's module) PLUS two new endpoints that exist only
// in this lab, specifically for data-correctness work:
//
//   GET /api/data-summary -- counts, date ranges, and bounding boxes for
//     all three datasets, recomputed from the actual loaded JSON every
//     time (never hardcoded), so a bad regeneration run shows up
//     immediately instead of silently drifting from what the comments say.
//
//   GET /api/nearby -- raw matched records (with every field, not just
//     what the score needs) within a radius of ANY point you give it, so
//     you can manually cross-check a specific intersection or block
//     against Google Street View / the government's own portal, rather
//     than only ever looking at data through the lens of a full route.
//
// See README.md for how to run this, and for a per-dataset checklist of
// what "improve data correctness" concretely means for each of the three.

import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  analyzePedestrianRouteSafety,
  filterPedestrianAccidents,
  mockAccidentsTaipei,
  mockStreetlightsTaipei,
  mockConvenienceStoresTaipei,
} from "./pedestrianSafety/index.js";

// prepareRoute/findPointsNearRoute live in routeAnalysis.js specifically,
// which index.js (an unmodified copy of 112-project's own module) does
// NOT re-export -- importing straight from the sub-module here rather
// than adding an export to index.js, so pedestrianSafety/ stays an exact
// copy you can diff against the full project.
import { prepareRoute, findPointsNearRoute } from "./pedestrianSafety/routeAnalysis.js";
// Same place resolver the main 112-project uses (landmark aliases like
// 101 -> 台北101, TomTom/Groq when keys are set, Photon otherwise).
import { resolvePlaceUniversal } from "./placeSearchEngine.js";
import { compareWalkingRoutes } from "./routeComparison.js";
import { recommendBestDepartureTime } from "./bestDepartureTime.js";
import { MODES, modeOf, scoreVehicleRoute, modeAccidentsNear } from "./modes.js";
import { accidentsInBox, FLAGS as ACCIDENT_FLAGS, meta as allAccidentsMeta } from "./accidentIndex.js";
import { planTransit, transitRaw } from "./transitPlanner.js";
import { ensureRoads, roadsNearRoute } from "./roadNetwork.js";
// Nationwide data when built (realAccidentsTaiwan.json etc.), Taipei files
// otherwise, plus coverage-aware scoring -- see nationalData.js.
import {
  realAccidents,
  realStreetlights,
  realConvenienceStores,
  prefilterForRoute,
  applyCoverage,
  streetlightCoveredAt,
  coverage,
  dataFiles,
  storesInfo,
  countyAt,
} from "./nationalData.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Only used to fetch a real walking-road geometry between two addresses'
// coordinates for the GET /api/pedestrian-safety?startLon=...&endLon=...
// form below -- exactly the same public demo server and the same
// foot->driving-fallback logic as the full project (see that project's
// own README/conversation history: this public server does NOT actually
// serve a distinct foot profile, so this already expects and flags that).
// Point OSRM_BASE_URL at a self-hosted instance in .env if you have one.
const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";

// A server that actually has a WALKING profile (FOSSGIS / openstreetmap.de,
// free, no key). router.project-osrm.org only serves car routing no matter
// which profile is in the URL, so its "foot" routes follow one-way streets
// and expressways. This is tried first; OSRM_BASE_URL stays as the fallback.
const OSRM_FOOT_BASE_URL =
  process.env.OSRM_FOOT_BASE_URL || "https://routing.openstreetmap.de/routed-foot";
// Same FOSSGIS service, car network (used for 開車, and for 機車 with
// exclude=motorway since ordinary scooters may not use 國道).
const OSRM_CAR_BASE_URL =
  process.env.OSRM_CAR_BASE_URL || "https://routing.openstreetmap.de/routed-car";

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    purpose: "pedestrian-safety-lab -- standalone pedestrian safety data test bed",
    osrm: OSRM_BASE_URL,
    datasetCounts: {
      accidents: realAccidents.length,
      streetlights: realStreetlights.length,
      stores: realConvenienceStores.length,
    },
    coverage: {
      accidents: coverage.accidents.length > 1 ? "全台" : coverage.accidents.join("、"),
      streetlights: coverage.streetlights.join("、"),
      stores: coverage.stores.length > 1 ? "全台" : coverage.stores.join("、"),
    },
  });
});

// =========================================================
// PEDESTRIAN SAFETY SCORE (ported, unchanged logic, from 112-project)
// =========================================================

app.get("/api/pedestrian-safety", async (req, res) => {
  try {
    // No bufferRadius = automatic (nearest-road attribution).
    const bufferRadius = Number(req.query.bufferRadius) > 0 ? Number(req.query.bufferRadius) : null;
    const dataSource = req.query.dataSource === "mock" ? "mock" : "real";

    let route;
    let profileUsed;

    if (req.query.geometry) {
      let parsed;
      try {
        parsed = JSON.parse(req.query.geometry);
      } catch {
        return res.status(400).json({ error: "Invalid geometry JSON" });
      }
      if (!Array.isArray(parsed) || parsed.length < 2) {
        return res
          .status(400)
          .json({ error: "geometry must be an array of at least 2 [lon,lat] pairs" });
      }
      route = parsed
        .map((pt) => ({ lon: Number(pt?.[0]), lat: Number(pt?.[1]) }))
        .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
      if (route.length < 2) {
        return res.status(400).json({ error: "geometry has no valid [lon,lat] pairs" });
      }
      profileUsed = "provided-route";
    } else {
      const { startLon, startLat, endLon, endLat } = req.query;

      if (!startLon || !startLat || !endLon || !endLat) {
        return res.status(400).json({
          error: "Missing startLon, startLat, endLon, or endLat (or provide geometry)",
        });
      }

      const sLon = Number(startLon);
      const sLat = Number(startLat);
      const eLon = Number(endLon);
      const eLat = Number(endLat);

      if (![sLon, sLat, eLon, eLat].every(Number.isFinite)) {
        return res.status(400).json({ error: "Invalid coordinate format" });
      }

      async function getWalkingGeometry() {
        try {
          const realFootUrl =
            `${OSRM_FOOT_BASE_URL}/route/v1/foot/` +
            `${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson`;
          const response = await fetchWithTimeout(realFootUrl, {}, 9000);
          const data = await response.json();
          if (response.ok && data.code === "Ok" && data.routes?.length) {
            return { geometry: data.routes[0].geometry, profileUsed: "foot(真正的步行路線)" };
          }
        } catch {
          // fall through to OSRM_BASE_URL below
        }

        const footUrl =
          `${OSRM_BASE_URL}/route/v1/foot/` +
          `${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson`;
        try {
          const response = await fetchWithTimeout(footUrl, {}, 9000);
          const data = await response.json();
          if (response.ok && data.code === "Ok" && data.routes?.length) {
            return { geometry: data.routes[0].geometry, profileUsed: "foot-on-OSRM_BASE_URL(若是 router.project-osrm.org,其實是汽車路線)" };
          }
        } catch {
          // fall through to the driving-geometry fallback below
        }

        const drivingUrl =
          `${OSRM_BASE_URL}/route/v1/driving/` +
          `${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson`;
        const response = await fetchWithTimeout(drivingUrl, {}, 9000);
        const data = await response.json();
        if (!response.ok || data.code !== "Ok" || !data.routes?.length) {
          throw new Error(`OSRM ${response.status}: ${JSON.stringify(data)}`);
        }
        return { geometry: data.routes[0].geometry, profileUsed: "driving-fallback" };
      }

      const walking = await getWalkingGeometry();
      route = (walking.geometry.coordinates || []).map(([lon, lat]) => ({ lat, lon }));
      profileUsed = walking.profileUsed;
    }

    if (route.length < 2) {
      return res.status(404).json({ error: "No walkable route found between these points" });
    }

    if (bufferRadius == null) await ensureRoads([route]);
    res.json(buildPedestrianSafetyResponse(route, profileUsed, dataSource, bufferRadius));
  } catch (error) {
    console.error("Pedestrian safety error:", error);
    res.status(500).json({
      status: "error",
      message: "Pedestrian safety scoring failed",
      detail: error.message,
    });
  }
});

app.post("/api/pedestrian-safety", async (req, res) => {
  try {
    // No bufferRadius = automatic (nearest-road attribution).
    const bufferRadius = Number(req.body.bufferRadius) > 0 ? Number(req.body.bufferRadius) : null;
    const dataSource = req.body.dataSource === "mock" ? "mock" : "real";

    const parsed = req.body.geometry;
    if (!Array.isArray(parsed) || parsed.length < 2) {
      return res.status(400).json({
        error: "geometry must be an array of at least 2 [lon,lat] pairs",
      });
    }
    const route = parsed
      .map((pt) => ({ lon: Number(pt?.[0]), lat: Number(pt?.[1]) }))
      .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
    if (route.length < 2) {
      return res.status(400).json({ error: "geometry has no valid [lon,lat] pairs" });
    }

    if (bufferRadius == null) await ensureRoads([route]);
    res.json(buildPedestrianSafetyResponse(route, "provided-route", dataSource, bufferRadius));
  } catch (error) {
    console.error("Pedestrian safety error (POST):", error);
    res.status(500).json({
      status: "error",
      message: "Pedestrian safety scoring failed",
      detail: error.message,
    });
  }
});

function buildPedestrianSafetyResponse(route, profileUsed, dataSource, bufferRadius) {
  const real = dataSource === "real";
  // Real data: only hand the scorer the points near this route (identical
  // result, see nationalData.js prefilterForRoute), then apply coverage.
  // bufferRadius null = automatic: data goes to its nearest road
  // (OSM road network, see roadNetwork.js / pedestrianSafety/roadAttribution.js);
  // falls back to a fixed 150 m buffer when the road network isn't available.
  const searchRadius = bufferRadius == null ? 150 : bufferRadius;
  const near0 = real ? prefilterForRoute(route, searchRadius) : null;
  const accidents = real ? near0.accidents : mockAccidentsTaipei;
  const streetlights = real ? near0.streetlights : mockStreetlightsTaipei;
  const stores = real ? near0.stores : mockConvenienceStoresTaipei;
  const roads = bufferRadius == null ? roadsNearRoute(route) : null;

  const rawResult = analyzePedestrianRouteSafety(route, accidents, streetlights, stores, bufferRadius, undefined, { roads });
  const result = real ? applyCoverage(rawResult, route) : rawResult;

  const accidentRangeLabel =
    dataSource === "real" && result.accidentDataDateRange
      ? `${result.accidentDataDateRange.from} to ${result.accidentDataDateRange.to}`
      : dataSource === "real"
      ? "an undated real dataset"
      : "mock data";

  // For the map: the actual road geometry the score was computed on, plus
  // EVERY data point the score counted (the score's own lists are capped at
  // the nearest 40, which made the map look sparse and lopsided).
  // Streetlights are sent as compact [lat, lon, distanceMeters] triples
  // because a long route can have a few thousand of them.
  const matched = rawResult.matched;
  const mapLayers = {
    routeGeometry: route.map((p) => [p.lat, p.lon]),
    accidents: matched.accidents.map((a) => ({
      latitude: a.latitude,
      longitude: a.longitude,
      date: a.date,
      location: a.location,
      severity: a.severity,
      distanceMeters: a.distanceMeters,
    })),
    stores: matched.stores.map((s) => ({
      latitude: s.latitude,
      longitude: s.longitude,
      store_type: s.store_type,
      name: s.name,
      address: s.address,
      distanceMeters: s.distanceMeters,
    })),
    streetlights: matched.streetlights.map((l) => [l.latitude, l.longitude, l.distanceMeters]),
  };

  return {
    status: "ok",
    profileUsed,
    dataSource,
    mapLayers,
    scope:
      `事故:${coverage.accidents.length > 1 ? "全台" : coverage.accidents.join("、")}(${accidentRangeLabel});` +
      `便利商店:${coverage.stores.length > 1 ? "全台" : coverage.stores.join("、")};` +
      `路燈:${coverage.streetlights.join("、")}。沒有資料的縣市,該項目不計分(見 result.coverage)。` +
      "評分門檻是用台北市路段校正的,其他縣市的分數僅供參考。",
    result,
    limitations: [
      "Estimated score only, not a guarantee of actual safety.",
      "Convenience-store density is a proxy for foot traffic (\"eyes on the street\"), not a direct safety measurement.",
      "Streetlight density measures potential visibility only, not whether lights actually work.",
      `Accident data covers ${accidentRangeLabel} and does not reflect any changes since.`,
      "Crime/incident data is not yet integrated -- \"歷史事故\" reflects traffic-accident counts only.",
    ],
  };
}

// =========================================================
// NEW IN THIS LAB: data-correctness tools
// =========================================================

// GET /api/data-summary
// Recomputes (never hardcodes) size/date-range/bounding-box/breakdown
// stats straight from the loaded JSON files, so this always reflects
// whatever is ACTUALLY in pedestrianSafety/data/ right now -- including
// right after you've edited build_real_accidents.py or build_real_stores.py
// and rerun them. Use this as the first thing to check after any data
// change: did the counts move the way you expected, and does the
// bounding box still look like "Taipei" and nothing else.
app.get("/api/data-summary", (req, res) => {
  function bbox(points) {
    if (!points.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points) {
      const lat = Number(p.latitude);
      const lon = Number(p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return { minLat, maxLat, minLon, maxLon };
  }

  function countBy(items, keyFn) {
    const counts = {};
    for (const item of items) {
      const key = keyFn(item) ?? "(missing)";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  const pedestrianAccidents = filterPedestrianAccidents(realAccidents);
  const dates = pedestrianAccidents.map((a) => a.date).filter(Boolean).sort();

  res.json({
    accidents: {
      totalRecords: realAccidents.length,
      pedestrianRecords: pedestrianAccidents.length,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      byYear: countBy(pedestrianAccidents, (a) => (a.date || "").slice(0, 4)),
      byCategory: countBy(pedestrianAccidents, (a) => a.category),
      byCounty: countBy(pedestrianAccidents, (a) => String(a.location || "").replace(/台/g, "臺").slice(0, 3)),
      boundingBox: bbox(realAccidents),
    },
    streetlights: {
      totalRecords: realStreetlights.length,
      boundingBox: bbox(realStreetlights),
    },
    convenienceStores: {
      totalRecords: realConvenienceStores.length,
      byStoreType: countBy(realConvenienceStores, (s) => s.store_type),
      byCounty: countBy(realConvenienceStores, (s) =>
        String(s.city || s.address || "").replace(/台/g, "臺").slice(0, 3)),
      boundingBox: bbox(realConvenienceStores),
      fetched: storesInfo,
    },
    files: dataFiles,
    coverage,
    allAccidents: allAccidentsMeta
      ? { total: allAccidentsMeta.count, byInvolvement: allAccidentsMeta.countsByInvolvement, dateRange: allAccidentsMeta.dateRange }
      : null,
    note:
      "All numbers here are computed live from pedestrianSafety/data/*.json on " +
      "every request -- rerun the build_*.py scripts and refresh this endpoint " +
      "to see the effect of a data change immediately, no server restart needed " +
      "for the JSON files themselves (only needed if you change the .js module " +
      "code, since Node caches imports at startup).",
  });
});

// GET /api/nearby?lat=...&lon=...&radius=150&type=accidents|streetlights|stores
// Raw matched records (every field, not just score inputs) within radius
// meters of a single point -- for manually checking one specific spot
// against ground truth (Google Street View, the government's own portal,
// a site visit) rather than only ever seeing data filtered through a
// whole route's buffer.
app.get("/api/nearby", (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Number(req.query.radius) > 0 ? Number(req.query.radius) : 150;
  const type = String(req.query.type || "accidents");

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Missing or invalid lat/lon" });
  }

  const local = prefilterForRoute([{ lat, lon }], radius);
  const dLat = (radius + 50) / 111320;
  const dLon = (radius + 50) / (111320 * Math.cos((lat * Math.PI) / 180));
  const box = { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
  const withInvolved = (list) => list.map((a) => ({ ...a, location: `涉入:${a.involved}` }));
  const datasets = {
    accidents: filterPedestrianAccidents(local.accidents.filter((a) => !a._sentinel)),
    streetlights: local.streetlights,
    stores: local.stores,
    scooterAccidents: withInvolved(accidentsInBox(box, ACCIDENT_FLAGS.scooter)),
    carAccidents: withInvolved(accidentsInBox(box, ACCIDENT_FLAGS.car)),
  };

  if (!datasets[type]) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(datasets).join(", ")}` });
  }

  // A single-point "route" -- prepareRoute/findPointsNearRoute already
  // handle length-1 routes as a plain point-to-point distance check.
  const routeInfo = prepareRoute([{ lat, lon }]);
  const matched = findPointsNearRoute(datasets[type], routeInfo, radius);

  res.json({
    status: "ok",
    type,
    county: countyAt(lat, lon),
    hasData:
      type === "scooterAccidents" || type === "carAccidents"
        ? true
        : type === "streetlights"
          ? streetlightCoveredAt(lat, lon)
          : (type === "stores" ? coverage.stores : coverage.accidents).includes(countyAt(lat, lon)),
    center: { lat, lon },
    radiusMeters: radius,
    matchCount: matched.length,
    matches: matched,
  });
});

// Real walking geometry between two points (transit access/egress legs when
// TDX doesn't return a usable polyline). Falls back to a straight line.
async function walkingLegGeometry(a, b) {
  try {
    const url = `${OSRM_FOOT_BASE_URL}/route/v1/foot/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const response = await fetchWithTimeout(url, {}, 8000);
    const data = await response.json();
    if (response.ok && data.code === "Ok" && data.routes?.length) {
      return data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
    }
  } catch {
    // fall through
  }
  return [a, b];
}

// GET /api/modes -> the travel-mode settings the page shows (labels, default buffer, weights)
app.get("/api/modes", (req, res) => {
  res.json({
    status: "ok",
    modes: Object.values(MODES).map((m) => ({
      key: m.key,
      label: m.label,
      icon: m.icon,
      defaultBuffer: m.defaultBuffer,
      weights: m.weights,
      accidentNoun: m.accidentNoun,
      thresholds: {
        maxAcceptableAccidentDensity: m.config.maxAcceptableAccidentDensity,
        idealStreetlightDensity: m.config.idealStreetlightDensity,
        idealConvenienceStoreDensity: m.config.idealConvenienceStoreDensity,
      },
    })),
    transitConfigured: Boolean(process.env.TDX_CLIENT_ID && process.env.TDX_CLIENT_SECRET),
  });
});

// GET /api/transit/raw?startLat=&startLon=&endLat=&endLon= -> TDX routing
// response exactly as TDX returns it (no keys or tokens in the output). For
// checking/adjusting the parser in transitPlanner.js.
app.get("/api/transit/raw", async (req, res) => {
  try {
    const data = await transitRaw({
      start: { lat: Number(req.query.startLat), lon: Number(req.query.startLon) },
      end: { lat: Number(req.query.endLat), lon: Number(req.query.endLon) },
      depart: req.query.depart ? String(req.query.depart) : null,
      fetchWithTimeout,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// =========================================================
// MULTI-ROUTE COMPARISON: 推薦 / 備選1 / 備選2
// =========================================================
// GET /api/pedestrian-safety/compare?startLat=&startLon=&endLat=&endLon=&bufferRadius=150&dataSource=real
// Builds up to 3 distinct walking routes the same way the main project's
// walk mode does (OSRM alternatives + routeAlternatives.js detours), scores
// each with the unchanged pedestrian safety formula, and ranks them.
// See routeComparison.js for the full rules.
app.get("/api/pedestrian-safety/compare", async (req, res) => {
  try {
    const mode = modeOf(String(req.query.mode || "walk"));
    // bufferRadius is no longer asked from the user: by default each data
    // point is attributed to its nearest road (null = automatic). A number
    // in the query still forces the old fixed buffer (for experiments).
    const bufferRadius = Number(req.query.bufferRadius) > 0 ? Number(req.query.bufferRadius) : null;
    const searchRadius = bufferRadius ?? mode.defaultBuffer;
    // Mock data only exists for walking.
    const dataSource = req.query.dataSource === "mock" && mode.key === "walk" ? "mock" : "real";
    const start = { lat: Number(req.query.startLat), lon: Number(req.query.startLon) };
    const end = { lat: Number(req.query.endLat), lon: Number(req.query.endLon) };
    if (![start.lat, start.lon, end.lat, end.lon].every(Number.isFinite)) {
      return res.status(400).json({ status: "error", error: "Missing or invalid startLat/startLon/endLat/endLon" });
    }

    // Optional waypoints: via=lat,lon;lat,lon (in order, at most 5)
    const waypoints = String(req.query.via || "")
      .split(";")
      .filter(Boolean)
      .map((pair) => pair.split(",").map(Number))
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
      .map(([lat, lon]) => ({ lat, lon }));
    if (waypoints.length > 5) {
      return res.status(400).json({ status: "error", error: "中途點最多 5 個" });
    }

    if (mode.key === "transit") {
      if (waypoints.length) {
        return res.status(400).json({ status: "error", error: "大眾運輸目前不支援中途點,請先移除中途點" });
      }
      const result = await planTransit({
        start,
        end,
        bufferRadius,
        depart: req.query.depart ? String(req.query.depart) : null,
        fetchWithTimeout,
        scoreWalkLeg: (coords) => buildPedestrianSafetyResponse(coords, "foot", "real", bufferRadius),
        footRoute: (a, b) => walkingLegGeometry(a, b),
      });
      return res.json(result);
    }

    const result = await compareWalkingRoutes({
      start,
      end,
      waypoints,
      mode: mode.key,
      modeInfo: { label: mode.label, accidentNoun: mode.accidentNoun },
      carBaseUrl: OSRM_CAR_BASE_URL,
      bufferRadius,
      dataSource,
      accidents: dataSource === "real" ? realAccidents : mockAccidentsTaipei,
      // Accidents near a given route only (fast path for detour/hotspot search).
      accidentsNear:
        mode.key !== "walk"
          ? (coords) => modeAccidentsNear(coords, mode, searchRadius + 400)
          : dataSource === "real"
          ? (coords) => prefilterForRoute(coords, searchRadius + 400).accidents.filter((a) => !a._sentinel)
          : () => mockAccidentsTaipei,
      footBaseUrl: OSRM_FOOT_BASE_URL,
      osrmBaseUrl: OSRM_BASE_URL,
      fetchWithTimeout,
      buildPedestrianSafetyResponse: (coords, profile, ds, radius) =>
        mode.key === "walk"
          ? buildPedestrianSafetyResponse(coords, profile, ds, radius)
          : { status: "ok", profileUsed: profile, ...scoreVehicleRoute(coords, mode.key, radius) },
    });
    res.json(result);
  } catch (error) {
    console.error("Route comparison error:", error);
    res.status(500).json({ status: "error", message: "路線比較失敗", detail: error.message });
  }
});

// =========================================================
// BEST DEPARTURE TIME
// =========================================================
//
// Example:
//
// GET /api/best-departure-time
// ?startLat=25.0478
// &startLon=121.5170
// &endLat=24.9875
// &endLon=121.5760
// &targetArrivalMs=...
//
// =========================================================

app.get(

  "/api/best-departure-time",

  async (
    req,
    res
  ) => {

    try {

      // -----------------------------------------
      // Start / End
      // -----------------------------------------

      const start = {

        lat:
          Number(
            req.query.startLat
          ),

        lon:
          Number(
            req.query.startLon
          ),

      };


      const end = {

        lat:
          Number(
            req.query.endLat
          ),

        lon:
          Number(
            req.query.endLon
          ),

      };


      // -----------------------------------------
      // Arrival requirement
      // -----------------------------------------

      const targetArrivalMs =
        Number(
          req.query.targetArrivalMs
        );


      const arrivalBufferMinutes =
        Number(

          req.query
            .arrivalBufferMinutes ??

          10

        );


      // -----------------------------------------
      // Candidate settings
      // -----------------------------------------

      const intervalMinutes =
        Number(

          req.query
            .intervalMinutes ??

          15

        );


      const lookbackMinutes =
        Number(

          req.query
            .lookbackMinutes ??

          120

        );


      // -----------------------------------------
      // Travel mode
      // -----------------------------------------

      const travelMode =

        req.query.travelMode ===
        "motorcycle"

          ?

        "motorcycle"

          :

        "car";


      // -----------------------------------------
      // Validation
      // -----------------------------------------

      if (

        ![

          start.lat,

          start.lon,

          end.lat,

          end.lon,

          targetArrivalMs,

        ].every(
          Number.isFinite
        )

      ) {

        return res
          .status(400)
          .json({

            status:
              "error",

            error:

              "Missing or invalid startLat/startLon/endLat/endLon/targetArrivalMs",

          });

      }


      // -----------------------------------------
      // Recommendation
      // -----------------------------------------

      const result =

        await recommendBestDepartureTime({

          start,

          end,

          targetArrivalMs,

          arrivalBufferMinutes,

          travelMode,

          intervalMinutes,

          lookbackMinutes,

          tomtomApiKey:

            process.env
              .TOMTOM_API_KEY ||

            "",

          fetchWithTimeout,

        });


      res.json(
        result
      );


    } catch (
      error
    ) {

      console.error(

        "Best departure time error:",

        error

      );


      const missingKey =

        String(
          error.message ||
          ""
        )
          .includes(
            "TOMTOM_API_KEY"
          );


      res
        .status(
          missingKey
            ?
          503
            :
          500
        )
        .json({

          status:
            "error",

          message:

            error.code ===
            "TOMTOM_KEY_INVALID"

              ?

            "TomTom 不接受 .env 裡的 TOMTOM_API_KEY，請確認貼上的是 TomTom 的 API Key（32 個英數字，沒有連字號），改完後重新啟動伺服器。"

              :

            missingKey

              ?

            "最佳出發時間需要 TOMTOM_API_KEY，請先在 .env 設定。"

              :

            "最佳出發時間推薦失敗",

          detail:
            error.message,

        });

    }

  }

);
// =========================================================
// GEOCODING: place name / address text -> coordinates
// =========================================================
// Lets the frontend take "台北車站" or "台北市信義區市府路45號" (typed or
// spoken) instead of requiring a map click. Proxied through the server so
// we can send a proper User-Agent (required by Nominatim's usage policy),
// cache repeat lookups, and keep to Nominatim's 1 request/second limit.
//
// Primary: OpenStreetMap Nominatim. Fallback: Photon (komoot), which is
// also OSM-based but more forgiving with partial/fuzzy names.
// Override either with NOMINATIM_BASE_URL / PHOTON_BASE_URL in .env.
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org";
const PHOTON_BASE_URL = process.env.PHOTON_BASE_URL || "https://photon.komoot.io";
const GEOCODER_USER_AGENT =
  process.env.GEOCODER_USER_AGENT || "pedestrian-safety-lab/1.0 (NCCU student project)";

// Taipei-ish box used to bias results (not a hard filter, so 新北 places
// near the border still work). lon/lat order as the APIs expect.
// No fixed "near Taipei" bias any more: it made 「台中車站」 resolve to 台北車站.
// A bias point is only used when the caller passes one (the other end of the
// trip), and county names in the query are enforced below (countyHints).

const geocodeCache = new Map();
let lastNominatimCall = 0;

async function nominatimSearch(q, near = null) {
  // Respect the 1 req/s policy (several fallback variants may run back-to-back).
  const wait = lastNominatimCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();

  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "5",
    countrycodes: "tw",
    "accept-language": "zh-TW",
  });
  if (near) {
    // Prefer (not require) results within ~30 km of the other end of the trip.
    params.set("viewbox", `${near.lon - 0.3},${near.lat + 0.3},${near.lon + 0.3},${near.lat - 0.3}`);
    params.set("bounded", "0");
  }
  const response = await fetchWithTimeout(
    `${NOMINATIM_BASE_URL}/search?${params}`,
    { headers: { "User-Agent": GEOCODER_USER_AGENT } },
    8000
  );
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const data = await response.json();
  return (Array.isArray(data) ? data : []).map((d) => ({
    name: d.name || String(d.display_name || "").split(",")[0],
    label: d.display_name,
    lat: Number(d.lat),
    lon: Number(d.lon),
    source: "nominatim",
  }));
}

async function photonSearch(q, near = null) {
  const params = new URLSearchParams({
    q,
    limit: "5",
    // Whole of Taiwan incl. outlying islands.
    bbox: "118,21,124,27",
  });
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lon));
  }
  const response = await fetchWithTimeout(
    `${PHOTON_BASE_URL}/api/?${params}`,
    { headers: { "User-Agent": GEOCODER_USER_AGENT } },
    8000
  );
  if (!response.ok) throw new Error(`Photon ${response.status}`);
  const data = await response.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const parts = [p.name, p.street && `${p.street}${p.housenumber ? p.housenumber + "號" : ""}`, p.district, p.city]
      .filter(Boolean);
    return {
      name: p.name || p.street || "",
      label: [...new Set(parts)].join(", "),
      lat: Number(f.geometry?.coordinates?.[1]),
      lon: Number(f.geometry?.coordinates?.[0]),
      source: "photon",
    };
  });
}

// OSM in Taiwan mixes 台/臺, and house-number coverage is patchy, so try a
// few progressively looser variants of the query before giving up.
function queryVariants(q) {
  const swapped = (s) => [s, s.replace(/台/g, "臺"), s.replace(/臺/g, "台")];
  const exact = [];
  const approx = [];
  // "…路45號3樓" -> "…路45號" (same building, still exact)
  const noFloor = q.replace(/\d+\s*(樓|F|f)(之\d+)?$/, "").replace(/[,，]\s*$/, "").trim();
  exact.push(...swapped(q), ...swapped(noFloor));
  // -> "…路" (road-level only, flagged approximate)
  const roadOnly = noFloor.replace(/\d+(之\d+)?\s*號.*$/, "").replace(/\d+\s*(巷|弄)\s*$/, "").trim();
  if (roadOnly && roadOnly !== noFloor) approx.push(...swapped(roadOnly));

  const seen = new Set();
  return [
    ...exact.map((text) => ({ text, approximate: false })),
    ...approx.map((text) => ({ text, approximate: true })),
  ].filter((v) => v.text && !seen.has(v.text) && seen.add(v.text));
}

app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .replace(/[。．.!！?？]+$/, "");
  if (!q) return res.status(400).json({ status: "error", error: "請輸入地點" });

  // Raw "lat,lon" still works, no network needed.
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    return res.json({
      status: "ok",
      query: q,
      results: [{ name: q, label: "座標", lat, lon, source: "coordinates" }],
    });
  }

  // Optional bias point: "lat,lon" of the trip's other end (sent by the page).
  const nm = String(req.query.near || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const near = nm && Number(nm[1]) > 21 && Number(nm[1]) < 27 && Number(nm[2]) > 118 && Number(nm[2]) < 124
    ? { lat: Number(nm[1]), lon: Number(nm[2]) }
    : null;

  // County/city named in the query (「台中車站」→ 臺中市). Results elsewhere are
  // demoted, and if an engine returns none inside that county we ask the next
  // engine instead of trusting a fuzzy match from another city.
  const hints = countyHints(q);
  const fits = (r) => !hints.length || hints.includes(countyAt(r.lat, r.lon));

  const cacheKey = `${q}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ""}`;
  if (geocodeCache.has(cacheKey)) return res.json(geocodeCache.get(cacheKey));

  const errors = [];
  let outsideHint = null; // best answer that ignored the county hint, kept as a last resort

  function take(results, meta) {
    const good = results.filter(fits);
    if (good.length) {
      const payload = {
        status: "ok",
        query: q,
        ...meta,
        countyHint: hints.length ? hints.join("/") : null,
        results: [...good, ...results.filter((r) => !fits(r))].slice(0, 5),
      };
      geocodeCache.set(cacheKey, payload);
      res.json(payload);
      return true;
    }
    if (!outsideHint && results.length) outsideHint = { ...meta, results };
    return false;
  }

  // 1) The main project's resolver, so both apps turn names into the same points.
  try {
    const found = await resolvePlaceUniversal({
      query: q,
      groqApiKey: process.env.GROQ_API_KEY || "",
      tomtomApiKey: process.env.TOMTOM_API_KEY || "",
      nearLat: near ? near.lat : null,
      nearLon: near ? near.lon : null,
    });
    const results = (found.candidates || [])
      .map((c) => ({
        name: c.displayName,
        label: [c.displayName, c.address].filter(Boolean).join(", "),
        lat: Number(c.lat),
        lon: Number(c.lon),
        source: c.source,
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (take(results, { matchedQuery: found.normalized?.normalizedQuery || q, approximate: false })) return;
  } catch (err) {
    errors.push(`placeSearchEngine: ${err.message}`);
  }

  // 2) Fallback: Nominatim + Photon with 台/臺 and road-level variants.
  const deadEngines = new Set(); // an engine that errored once is skipped for the rest
  const variants = queryVariants(q);
  for (const variant of variants) {
    for (const [engine, fn] of [["nominatim", nominatimSearch], ["photon", photonSearch]]) {
      if (deadEngines.has(engine)) continue;
      try {
        const results = (await fn(variant.text, near)).filter(
          (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)
        );
        if (take(results, { matchedQuery: variant.text, approximate: variant.approximate })) return;
      } catch (err) {
        errors.push(`${engine}: ${err.message}`);
        deadEngines.add(engine);
      }
    }
  }

  // Nothing inside the named county from any engine: return the best other
  // answer, flagged so the page can say so (e.g. 「新竹」 is ambiguous).
  if (outsideHint) {
    const payload = {
      status: "ok",
      query: q,
      ...outsideHint,
      countyHint: hints.join("/"),
      warning: `沒有找到位於${hints.join("/")}的結果,以下是其他地區最接近的結果,請確認是不是你要的地方`,
    };
    geocodeCache.set(cacheKey, payload);
    return res.json(payload);
  }

  const allFailed = deadEngines.size === 2;
  res.status(allFailed ? 502 : 404).json({
    status: "error",
    query: q,
    error:
      allFailed
        ? "連不到地理編碼服務(Nominatim / Photon),請確認網路,或改輸入 lat,lon"
        : `找不到「${q}」,試試更完整的名稱(例如加上縣市)或附近的地標`,
    detail: errors,
  });
});

// GET /api/reverse?lat=&lon= -> a short human-readable address for a point
// (used to label "目前位置"). Nominatim reverse, zh-TW; returns label=null
// (not an error) when the service can't be reached, so the page just shows
// the coordinates instead.
const reverseCache = new Map();
app.get("/api/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ status: "error", error: "Missing or invalid lat/lon" });
  }
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (reverseCache.has(key)) return res.json(reverseCache.get(key));
  let label = null;
  try {
    const wait = lastNominatimCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimCall = Date.now();
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: "18", "accept-language": "zh-TW" });
    const response = await fetchWithTimeout(
      `${NOMINATIM_BASE_URL}/reverse?${params}`,
      { headers: { "User-Agent": GEOCODER_USER_AGENT } },
      8000
    );
    if (response.ok) {
      const d = await response.json();
      const a = d.address || {};
      const district = a.city_district || a.suburb || a.town || a.village || "";
      const road = a.road ? `${a.road}${a.house_number ? a.house_number + "號" : ""}` : "";
      label = [a.city || a.county || "", district, road || d.name || ""].filter(Boolean).join("") || d.display_name || null;
    }
  } catch {
    // offline -> label stays null
  }
  const payload = { status: "ok", lat, lon, county: countyAt(lat, lon), label };
  if (label) reverseCache.set(key, payload);
  res.json(payload);
});

// 「台中車站」→ ["臺中市"]; 「新竹」→ both 新竹市 and 新竹縣. 「新北投」 is a
// neighbourhood of 臺北市, not 新北市, so it's removed before matching.
const COUNTY_HINT_PATTERNS = [
  [/臺北|台北/, ["臺北市"]], [/新北/, ["新北市"]], [/基隆/, ["基隆市"]], [/桃園/, ["桃園市"]],
  [/新竹/, ["新竹市", "新竹縣"]], [/苗栗/, ["苗栗縣"]], [/臺中|台中/, ["臺中市"]], [/彰化/, ["彰化縣"]],
  [/南投/, ["南投縣"]], [/雲林/, ["雲林縣"]], [/嘉義/, ["嘉義市", "嘉義縣"]], [/臺南|台南/, ["臺南市"]],
  [/高雄/, ["高雄市"]], [/屏東/, ["屏東縣"]], [/宜蘭/, ["宜蘭縣"]], [/花蓮/, ["花蓮縣"]],
  [/臺東|台東/, ["臺東縣"]], [/澎湖/, ["澎湖縣"]], [/金門/, ["金門縣"]], [/連江|馬祖/, ["連江縣"]],
];
function countyHints(q) {
  const text = String(q).replace(/新北投/g, "");
  const out = new Set();
  for (const [re, counties] of COUNTY_HINT_PATTERNS) if (re.test(text)) counties.forEach((c) => out.add(c));
  return [...out];
}

app.listen(PORT, () => {
  console.log(`pedestrian-safety-lab listening on http://localhost:${PORT}`);
  console.log(
    `Loaded: ${realAccidents.length} accident records, ` +
      `${realStreetlights.length} streetlights, ` +
      `${realConvenienceStores.length} convenience stores.`
  );
  console.log(
    `Files: ${dataFiles.accidents}, ${dataFiles.streetlights}, ${dataFiles.stores} ` +
      `(streetlight coverage: ${coverage.streetlights.join(", ")})`
  );
});
