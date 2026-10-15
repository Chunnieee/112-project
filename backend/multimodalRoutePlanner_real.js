// multimodalRoutePlanner.js
// 一次整合 walk / drive / mrt / hsr / train / bus 的多段規劃器。

import {
  planSegment,
  addMinutesToTime,
  MODE_LABEL,
} from "./tdxFullTransitPlanner.js";

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

export async function planMultiModalRoute({
  points,
  departureTime = "09:00",
  osrmBaseUrl = DEFAULT_OSRM_BASE_URL,
}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("points must contain at least start and end");
  }

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
      city: point.city || null,
      routeName: point.routeName || null,
      railSystem: point.railSystem || null,
    };
  });

  const segments = [];
  let currentTime = departureTime;
  let totalExpectedMin = 0;
  let totalRideMin = 0;
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

    const rideMinutes = Number(result.rideMinutes || 0);
    const waitMinutes = Number(result.waitMinutes || 0);
    const totalMinutes = Number(result.totalMinutes || rideMinutes + waitMinutes);

    const arriveTime = addMinutesToTime(currentTime, totalMinutes);

    totalRideMin += rideMinutes;
    totalWaitMin += waitMinutes;
    totalExpectedMin += totalMinutes;
    totalDistanceKm += Number(result.distanceKm || 0);

    segments.push({
      segmentId: i,
      from: start.name,
      to: end.name,
      mode,
      modeLabel: MODE_LABEL[mode] || mode,
      departTime: currentTime,
      arriveTime,
      distanceKm: round(result.distanceKm || 0, 2),
      rideMinutes: round(rideMinutes, 1),
      waitMinutes: round(waitMinutes, 1),
      expectedMin: round(totalMinutes, 1),
      source: result.source,
      geometry: result.geometry,
      detail: result.detail || result,
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
      totalRideMin: round(totalRideMin, 1),
      totalWaitMin: round(totalWaitMin, 1),
      totalDistanceKm: round(totalDistanceKm, 2),
      segmentCount: segments.length,
    },
    note:
      "walk/drive use OSRM. HSR/TRA use TDX DailyTimetable. MRT uses TDX station graph and LiveBoard when available. Bus uses TDX ETA only when city and routeName are provided.",
  };
}