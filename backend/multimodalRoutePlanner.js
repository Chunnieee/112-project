// multimodalRoutePlanner.js
// 保留原本前端可讀欄位：baseMin / waitMin / worst10Min / traffic.factor
// 不亂改時間：
// - drive / bus：TDX route-specific observed speed where matched; OSRM baseline where uncovered
// - walk：不套交通係數
// - mrt / hsr / train：不套道路交通係數，使用 TDX 班表或站點資料

import {
  planSegment,
  addMinutesToTime,
  MODE_LABEL,
} from "./tdxFullTransitPlanner.js";
import { calculateRouteSpecificTraffic } from "./routeTrafficMatcher.js";
import { openLrToPolyline } from "./tdxClient.js";

const DEFAULT_OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "http://localhost:5000";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  const p = 10 ** digits;
  return Math.round(Number(value || 0) * p) / p;
}

function shouldApplyTraffic(mode) {
  return mode === "drive" || mode === "bus";
}

export async function planMultiModalRoute({
  points,
  departureTime = "09:00",
  globalTrafficFactor = 1,
  trafficInfo = null,
  freewayData = null,
  highwayData = null,
  osrmBaseUrl = DEFAULT_OSRM_BASE_URL,
}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("points must contain at least start and end");
  }

  // Compatibility argument only. Real-TDX mode never applies a global traffic multiplier.
  const dynamicTrafficFactor = 1;

  const normalizedPoints = points.map((point, index) => {
    const lat = toNumber(point.lat);
    const lon = toNumber(point.lon);

    if (lat === null || lon === null) {
      throw new Error(`Invalid lat/lon at point index ${index}`);
    }

    return {
      name: point.name || `Point ${index + 1}`,
      lat,
      lon,
      modeFromPrevious: point.modeFromPrevious || null,
      waitMin: point.waitMin ?? null,
      city: point.city || null,
      routeName: point.routeName || null,
      railSystem: point.railSystem || null,
    };
  });

  const segments = [];
  let currentTime = departureTime;

  let totalExpectedMin = 0;
  let totalBaseMin = 0;
  let totalWaitMin = 0;
  let totalDistanceKm = 0;

  for (let i = 1; i < normalizedPoints.length; i++) {
    const start = normalizedPoints[i - 1];
    const end = normalizedPoints[i];
    const mode = end.modeFromPrevious || "walk";

    const result = await planSegment({
      start,
      end,
      mode,
      departureTime: currentTime,
      osrmBaseUrl,
      options: {
        city: end.city,
        routeName: end.routeName,
        railSystem: end.railSystem,
      },
    });

    const distanceKm = Number(result.distanceKm || 0);
    const baseMinutes = Number(result.rideMinutes || 0);
    const waitMinutes = Number(result.waitMinutes || 0);

    let segmentTrafficFactor = 1;
    let trafficDetail = null;
    let rideWithTrafficMin = baseMinutes;

    if (shouldApplyTraffic(mode)) {
      try {
        const routeSpecificTraffic = calculateRouteSpecificTraffic({
          route: {
            duration: baseMinutes * 60,
            distance: distanceKm * 1000,
            geometry: result.geometry,
          },
          freewayData,
          highwayData,
          openLrToPolyline,
          matchThresholdKm: 0.35,
        });

        trafficDetail = routeSpecificTraffic;

        const routeFactor = Number(routeSpecificTraffic.trafficFactor || 1);

        // routeTrafficMatcher already returns a hybrid of:
        // matched TDX observed time + OSRM baseline for uncovered road.
        // Do not add any global/time-of-day coefficient here.
        segmentTrafficFactor = Number.isFinite(routeFactor) && routeFactor > 0
          ? routeFactor
          : 1;

        rideWithTrafficMin = baseMinutes * segmentTrafficFactor;
      } catch {
        segmentTrafficFactor = 1;
        rideWithTrafficMin = baseMinutes;
      }
    }

    let accessBufferMin = 0;
    if (mode === "mrt") accessBufferMin = 2;
    if (mode === "train") accessBufferMin = 4;
    if (mode === "hsr") accessBufferMin = 8;
    if (mode === "bus") accessBufferMin = 2;

    const expectedMin = rideWithTrafficMin + waitMinutes + accessBufferMin;
    const arriveTime = addMinutesToTime(currentTime, expectedMin);

    totalBaseMin += baseMinutes;
    totalWaitMin += waitMinutes + accessBufferMin;
    totalExpectedMin += expectedMin;
    totalDistanceKm += distanceKm;

    segments.push({
      segmentId: i,
      from: start.name,
      to: end.name,
      mode,
      modeLabel: MODE_LABEL[mode] || result.label || mode,

      departTime: currentTime,
      arriveTime,

      rideMinutes: round(rideWithTrafficMin, 1),
      baseRideMinutes: round(baseMinutes, 1),
      waitMinutes: round(waitMinutes, 1),
      accessBufferMin: round(accessBufferMin, 1),

      baseMin: round(baseMinutes, 1),
      waitMin: round(waitMinutes, 1),
      expectedMin: round(expectedMin, 1),
      worst10Min: round(
        expectedMin *
          (trafficDetail?.coverageRatio >= 0.5 ? 1.08 : trafficDetail?.coverageRatio >= 0.2 ? 1.12 : 1.16),
        1
      ),

      trafficFactor: round(segmentTrafficFactor, 2),

      distanceKm: round(distanceKm, 2),
      source: result.source,
      geometry: result.geometry,
      detail: result.detail || null,
      trafficDetail,
      etaConfidence:
        mode === "drive" || mode === "bus"
          ? trafficDetail?.confidence || "low"
          : "schedule_or_mode_based",
      geometryPointCount: result.geometry?.coordinates?.length || 0,
    });

    currentTime = arriveTime;
  }

  return {
    points: normalizedPoints,
    departureTime,
    arrivalTime: currentTime,
    segments,

    summary: {
      totalExpectedMin: round(totalExpectedMin, 1),
      totalRideMin: round(totalBaseMin, 1),
      totalWaitMin: round(totalWaitMin, 1),

      totalBaseMin: round(totalBaseMin, 1),
      worst10Min: round(totalExpectedMin * 1.14, 1),
      variance: round(totalExpectedMin * 0.05, 2),

      totalDistanceKm: round(totalDistanceKm, 2),
      segmentCount: segments.length,
    },

    traffic: {
      factor: round(dynamicTrafficFactor, 2),
      level: trafficInfo?.level || "TDX dynamic traffic factor",
      description:
        trafficInfo?.description ||
        "Drive/bus use route-specific TDX observations only; uncovered road keeps OSRM baseline. Rail and walking do not use road traffic multipliers.",
    },

    note:
      "Drive/bus use matched TDX observed road speed where available; uncovered road keeps the OSRM baseline. No time-of-day/global traffic multiplier is applied. HSR/TRA/MRT use timetable/station data. Walk does not use road traffic multipliers.",
  };
}