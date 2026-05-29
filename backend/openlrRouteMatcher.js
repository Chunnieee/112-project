import * as turf from "@turf/turf";
import * as openlr from "openlr-js";

function extractLiveTraffics(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.LiveTraffics)) return data.LiveTraffics;
  return [];
}

function getRoutePoints(route) {
  const coordinates = route?.geometry?.coordinates || [];

  return coordinates
    .filter((coord) => Array.isArray(coord) && coord.length >= 2)
    .map(([lng, lat]) => turf.point([lng, lat]));
}

function tryDecodeOpenLR(openlrBase64) {
  try {
    /*
      openlr-js 不同版本 export 方式可能不同，
      所以這裡用比較保守的方式嘗試抓 decoder。
    */

    if (typeof openlr.decode === "function") {
      return openlr.decode(openlrBase64);
    }

    if (openlr.default && typeof openlr.default.decode === "function") {
      return openlr.default.decode(openlrBase64);
    }

    if (openlr.BinaryDecoder) {
      const decoder = new openlr.BinaryDecoder();
      return decoder.decode(openlrBase64);
    }

    return null;
  } catch (error) {
    return null;
  }
}

function collectCoordinatesFromDecoded(decoded) {
  const coords = [];

  function walk(value) {
    if (!value) return;

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === "object") {
      const possibleLat =
        value.lat ??
        value.latitude ??
        value.Latitude ??
        value.Lat;

      const possibleLng =
        value.lng ??
        value.lon ??
        value.longitude ??
        value.Longitude ??
        value.Lon ??
        value.Lng;

      const lat = Number(possibleLat);
      const lng = Number(possibleLng);

      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
      ) {
        coords.push([lng, lat]);
      }

      Object.values(value).forEach(walk);
    }
  }

  walk(decoded);

  return coords;
}

function decodeOpenLRsToPoints(openlrs = []) {
  const points = [];

  openlrs.forEach((entry) => {
    const openlrBase64 = entry?.OpenLR;

    if (!openlrBase64) return;

    const decoded = tryDecodeOpenLR(openlrBase64);
    const coords = collectCoordinatesFromDecoded(decoded);

    coords.forEach(([lng, lat]) => {
      points.push(turf.point([lng, lat]));
    });
  });

  return points;
}

function minDistanceKmToRoute(sectionPoints, routePoints) {
  if (sectionPoints.length === 0 || routePoints.length === 0) {
    return Infinity;
  }

  let minDistance = Infinity;

  for (const sectionPoint of sectionPoints) {
    for (const routePoint of routePoints) {
      const distance = turf.distance(sectionPoint, routePoint, {
        units: "kilometers"
      });

      if (distance < minDistance) {
        minDistance = distance;
      }
    }
  }

  return minDistance;
}

function calculatePenaltyFromMatchedSections(matchedSections) {
  if (matchedSections.length === 0) {
    return {
      matchedCount: 0,
      averageSpeed: null,
      slowRatio: 0,
      congestedRatio: 0,
      liveTrafficPenalty: 0,
      level: "No route-level TDX match"
    };
  }

  const speeds = matchedSections
    .map((item) => Number(item.TravelSpeed))
    .filter((speed) => Number.isFinite(speed) && speed > 0);

  const averageSpeed =
    speeds.length > 0
      ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length
      : null;

  let slow = 0;
  let congested = 0;

  matchedSections.forEach((item) => {
    const id = String(item.CongestionLevelID || "").toUpperCase();
    const level = String(item.CongestionLevel || "");

    /*
      根據你目前 TDX sample：
      CongestionLevelID = A/B/C/D...
      CongestionLevel = 1/2/3...
      先採用：
      A/B 或 1/2 = 順暢/普通
      C 或 3 = 慢速
      D/E 或 4/5 = 壅塞
    */

    if (id === "C" || level === "3") {
      slow += 1;
    }

    if (id === "D" || id === "E" || level === "4" || level === "5") {
      congested += 1;
    }
  });

  const slowRatio = slow / matchedSections.length;
  const congestedRatio = congested / matchedSections.length;

  let liveTrafficPenalty = 0;

  if (averageSpeed !== null) {
    if (averageSpeed < 25) liveTrafficPenalty += 0.5;
    else if (averageSpeed < 40) liveTrafficPenalty += 0.35;
    else if (averageSpeed < 55) liveTrafficPenalty += 0.2;
    else if (averageSpeed > 80) liveTrafficPenalty -= 0.05;
  }

  if (congestedRatio > 0.2) liveTrafficPenalty += 0.35;
  else if (congestedRatio > 0.1) liveTrafficPenalty += 0.2;
  else if (congestedRatio > 0.05) liveTrafficPenalty += 0.1;

  if (slowRatio > 0.25) liveTrafficPenalty += 0.15;
  else if (slowRatio > 0.15) liveTrafficPenalty += 0.08;

  liveTrafficPenalty = Math.max(-0.1, Math.min(0.8, liveTrafficPenalty));

  let level = "TDX Route Normal";

  if (liveTrafficPenalty >= 0.45) level = "TDX Route Heavy Traffic";
  else if (liveTrafficPenalty >= 0.25) level = "TDX Route Moderate Traffic";
  else if (liveTrafficPenalty > 0) level = "TDX Route Light Delay";
  else if (liveTrafficPenalty < 0) level = "TDX Route Smooth Traffic";

  return {
    matchedCount: matchedSections.length,
    averageSpeed: averageSpeed === null ? null : Number(averageSpeed.toFixed(1)),
    slowRatio: Number(slowRatio.toFixed(3)),
    congestedRatio: Number(congestedRatio.toFixed(3)),
    liveTrafficPenalty: Number(liveTrafficPenalty.toFixed(2)),
    level
  };
}

export function calculateOpenLRRouteLevelTraffic({
  route,
  freewayData,
  highwayData,
  matchThresholdKm = 0.25
}) {
  const routePoints = getRoutePoints(route);

  const allLiveTraffics = [
    ...extractLiveTraffics(freewayData),
    ...extractLiveTraffics(highwayData)
  ];

  const matchedSections = [];
  const debugSamples = [];

  for (const item of allLiveTraffics) {
    const sectionPoints = decodeOpenLRsToPoints(item.OpenLRs);

    if (sectionPoints.length === 0) {
      continue;
    }

    const minDistanceKm = minDistanceKmToRoute(sectionPoints, routePoints);

    if (minDistanceKm <= matchThresholdKm) {
      matchedSections.push(item);

      if (debugSamples.length < 8) {
        debugSamples.push({
          SectionID: item.SectionID,
          TravelSpeed: item.TravelSpeed,
          CongestionLevelID: item.CongestionLevelID,
          CongestionLevel: item.CongestionLevel,
          minDistanceMeters: Number((minDistanceKm * 1000).toFixed(1))
        });
      }
    }
  }

  const stats = calculatePenaltyFromMatchedSections(matchedSections);

  return {
    modelType: "OpenLR LRP-based route-level matching",
    matchThresholdMeters: matchThresholdKm * 1000,
    totalTdxSections: allLiveTraffics.length,
    matchedSections: debugSamples,
    ...stats
  };
}