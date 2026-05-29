import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { getTimeOfDayTrafficFactor, calculateLiveTrafficFactor } from "./trafficModel.js";
import { calculateOpenLRRouteLevelTraffic } from "./openlrRouteMatcher.js";
import { openLrToPolyline } from "./tdxClient.js";
import { calculateRouteSpecificTraffic } from "./routeTrafficMatcher.js";
import {
  getFreewayLiveTravelTimes,
  getFreewayLiveTraffic,
  getHighwayLiveTraffic,
  getFreewayLiveIncident,
  getHighwayLiveIncident,
  testTdxConnection
} from "./tdxClient.js";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "../frontend")));

const PORT = process.env.PORT || 3000;
const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "https://router.project-osrm.org";

app.use(cors());
app.use(express.json());

// 限制 API 使用頻率，避免被大量請求打爆
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    error: "Too many requests. Please try again later."
  }
});

app.use("/api", limiter);

// 測試 backend 是否正常
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    osrm: OSRM_BASE_URL
  });
});
app.get("/api/tdx-test", async (req, res) => {
  try {
    const result = await testTdxConnection();

    res.json({
      status: "ok",
      message: "TDX token successfully received",
      result
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "TDX connection failed",
      detail: error.message
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
      rawPreview: data
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed to load TDX live traffic sample",
      detail: error.message
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
        sample
      };
    } catch (error) {
      results[name] = {
        ok: false,
        error: error.message
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
    results
  });
});

// Traffic Adjustment Model
// 目的：OSRM 原始時間通常偏理想，所以加入交通修正係數，讓預估時間更接近實際交通。


// Risk-Aware Navigation Route API
// Risk-Aware Navigation Route API
app.get("/api/route", async (req, res) => {
  try {
    const { startLon, startLat, endLon, endLat } = req.query;

    if (!startLon || !startLat || !endLon || !endLat) {
      return res.status(400).json({
        error: "Missing startLon, startLat, endLon, or endLat"
      });
    }

    let url =
      `${OSRM_BASE_URL}/route/v1/driving/` +
      `${startLon},${startLat};${endLon},${endLat}` +
      `?overview=full&geometries=geojson&steps=true&alternatives=true`;

    let response = await fetch(url);
    let data = await response.json();

    if (!response.ok || data.code !== "Ok") {
      console.log("Alternative route failed, retrying single route...");
      console.log(data);

      url =
        `${OSRM_BASE_URL}/route/v1/driving/` +
        `${startLon},${startLat};${endLon},${endLat}` +
        `?overview=full&geometries=geojson&steps=true`;

      response = await fetch(url);
      data = await response.json();
    }

    if (!response.ok || data.code !== "Ok") {
      return res.status(response.status).json({
        error: "OSRM request failed",
        detail: data,
        requestUrl: url
      });
    }

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({
        error: "No route found",
        requestUrl: url
      });
    }

    const baseTrafficInfo = getTimeOfDayTrafficFactor();

    let freewayLiveTrafficData = null;
    let highwayLiveTrafficData = null;

    try {
      freewayLiveTrafficData = await getFreewayLiveTraffic();
    } catch (tdxError) {
      console.log("TDX freeway live traffic unavailable.");
      console.log(tdxError.message);
    }

    try {
      highwayLiveTrafficData = await getHighwayLiveTraffic();
    } catch (tdxError) {
      console.log("TDX highway live traffic unavailable.");
      console.log(tdxError.message);
    }

    const trafficInfo = calculateLiveTrafficFactor(
      baseTrafficInfo,
      freewayLiveTrafficData,
      highwayLiveTrafficData
    );

    const firstRouteSpecificTraffic = calculateRouteSpecificTraffic({
      route: data.routes[0],
      freewayData: freewayLiveTrafficData,
      highwayData: highwayLiveTrafficData,
      openLrToPolyline,
      matchThresholdKm: 0.25
    });

    const firstRouteAdjustedMin =
      firstRouteSpecificTraffic.adjustedMin ||
      data.routes[0].duration / 60;

    const enhancedRoutes = data.routes.map((route, index) => {
      const baseOsrmMin = route.duration / 60;
      const distanceKm = route.distance / 1000;

      const routeSpecificTraffic = calculateRouteSpecificTraffic({
        route,
        freewayData: freewayLiveTrafficData,
        highwayData: highwayLiveTrafficData,
        openLrToPolyline,
        matchThresholdKm: 0.25
      });

      const expectedMin = routeSpecificTraffic.adjustedMin;

      let riskFactor;

      if (index === 0) {
        riskFactor = 0.16;
      } else if (index === 1) {
        riskFactor = 0.28;
      } else {
        riskFactor = 0.22;
      }

      if (distanceKm > 10) {
        riskFactor += 0.05;
      }

      if (distanceKm > 20) {
        riskFactor += 0.08;
      }

      if (expectedMin > 30) {
        riskFactor += 0.04;
      }

      if (expectedMin > 60) {
        riskFactor += 0.08;
      }

      if (routeSpecificTraffic.delayMin > 5) {
        riskFactor += 0.04;
      }

      if (routeSpecificTraffic.matchedDistanceKm > 3) {
        riskFactor += 0.04;
      }

      const variance = expectedMin * riskFactor;
      const stdDev = Math.sqrt(variance);
      const worst10Min = expectedMin + 1.28 * stdDev;

      const stabilityScore = Math.max(
        0,
        Math.min(100, Math.round(100 - riskFactor * 180))
      );

      let stabilityLevel = "Medium";

      if (stabilityScore >= 75) {
        stabilityLevel = "High";
      } else if (stabilityScore < 55) {
        stabilityLevel = "Low";
      }

      let routeType = "Balanced Route";

      if (expectedMin <= firstRouteAdjustedMin + 2) {
        routeType = "Fast Route";
      }

      if (stabilityScore >= 75) {
        routeType = "Stable Route";
      }

      if (expectedMin <= firstRouteAdjustedMin + 2 && stabilityScore >= 70) {
        routeType = "Recommended Route";
      }

      return {
        routeId: index + 1,
        label: `Route ${String.fromCharCode(65 + index)}`,
        routeType,

        baseOsrmMin: Number(baseOsrmMin.toFixed(1)),
        expectedMin: Number(expectedMin.toFixed(1)),

        worst10Min: Number(worst10Min.toFixed(1)),
        variance: Number(variance.toFixed(2)),
        stabilityScore,
        stabilityLevel,
        distanceKm: Number(distanceKm.toFixed(2)),
        riskFactor: Number(riskFactor.toFixed(2)),

        trafficFactor: routeSpecificTraffic.trafficFactor,
        globalTrafficFactor: Number(trafficInfo.factor.toFixed(2)),
        delayMin: routeSpecificTraffic.delayMin,

        matchedCount: routeSpecificTraffic.matchedCount,
        matchedDistanceKm: routeSpecificTraffic.matchedDistanceKm,
        matchedSections: routeSpecificTraffic.matchedSections,

        segmentBased: true,

        trafficLevel:
          routeSpecificTraffic.matchedCount > 0
            ? "TDX segment-based traffic matched"
            : "No nearby TDX segment matched",

        trafficDescription:
          routeSpecificTraffic.matchedCount > 0
            ? "Only matched route segments are adjusted using TDX TravelSpeed. Unmatched segments keep OSRM average speed."
            : "No TDX OpenLR section matched this route, so OSRM base duration is mostly preserved.",

        geometry: route.geometry,
        raw: route
      };
    });

    let recommendedRoute = enhancedRoutes[0];

    for (const route of enhancedRoutes) {
      const currentScore =
        recommendedRoute.expectedMin * 0.5 +
        recommendedRoute.worst10Min * 0.3 -
        recommendedRoute.stabilityScore * 0.2;

      const candidateScore =
        route.expectedMin * 0.5 +
        route.worst10Min * 0.3 -
        route.stabilityScore * 0.2;

      if (candidateScore < currentScore) {
        recommendedRoute = route;
      }
    }

    res.json({
      routes: enhancedRoutes,
      recommendation: {
        routeId: recommendedRoute.routeId,
        label: recommendedRoute.label,
        routeType: recommendedRoute.routeType,
        reason:
          "Recommended because it balances segment-based traffic-adjusted expected time, worst-case delay risk, and route stability."
      },
      traffic: {
        factor: Number(trafficInfo.factor.toFixed(2)),
        level: trafficInfo.level,
        description: trafficInfo.description,
        segmentBased: true
      },
      note:
        "This prototype now uses segment-based traffic adjustment. OSRM route geometry is split into small segments. Only segments matched with nearby TDX OpenLR traffic sections are adjusted using TDX TravelSpeed."
    });
  } catch (error) {
    console.error("Route API error:", error);

    res.status(500).json({
      error: "Server error",
      detail: error.message
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

    const samples = [...freewayList, ...highwayList]
      .slice(0, 10)
      .map(item => ({
        SectionID: item.SectionID,
        OpenLRs: item.OpenLRs,
        TravelSpeed: item.TravelSpeed,
        CongestionLevelID: item.CongestionLevelID,
        CongestionLevel: item.CongestionLevel,
        DataCollectTime: item.DataCollectTime
      }));

    res.json({
      status: "ok",
      count: freewayList.length + highwayList.length,
      samples
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      status: "error",
      message: error.message
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
      highwayFirstItem: highwayList[0] || null
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});
app.get("/api/openlr-route-match-test", async (req, res) => {
  try {
    const { startLat, startLng, endLat, endLng } = req.query;

    if (!startLat || !startLng || !endLat || !endLng) {
      return res.status(400).json({
        status: "error",
        message: "Missing startLat, startLng, endLat, endLng"
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
        message: "No OSRM route found"
      });
    }

    const routeTraffic = calculateOpenLRRouteLevelTraffic({
      route,
      freewayData,
      highwayData,
      matchThresholdKm: 0.25
    });

    res.json({
      status: "ok",
      routeDistanceKm: Number((route.distance / 1000).toFixed(2)),
      routeDurationMin: Number((route.duration / 60).toFixed(1)),
      routeTraffic
    });
  } catch (error) {
    console.error("OpenLR route match test error:", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
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

    console.log("rawData type:", Array.isArray(rawData) ? "array" : typeof rawData);
    console.log(
      "rawData keys:",
      rawData && typeof rawData === "object" ? Object.keys(rawData) : []
    );
    console.log("TDX trafficSections length:", trafficSections.length);

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
            console.log(
              "OpenLR decode failed:",
              section.SectionID,
              error.message
            );
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
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});