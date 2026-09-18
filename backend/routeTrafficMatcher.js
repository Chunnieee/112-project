// routeTrafficMatcher.js
// Route-specific TDX live-traffic matching for freeway/highway feeds.
//
// Design rule for this version:
// - Never invent a traffic multiplier.
// - A matched route segment uses TDX's observed TravelSpeed (or TravelTime
//   converted to speed when possible).
// - An unmatched route segment keeps the OSRM baseline share.
// - CongestionLevel is diagnostic only; it is NOT converted into a fake factor.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function haversineKm(lat1, lon1, lat2, lon2) {
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

function pointToSegmentDistanceKm(point, a, b) {
  const refLatRad = (point.lat * Math.PI) / 180;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos(refLatRad);

  const px = point.lng * kmPerDegLon;
  const py = point.lat * kmPerDegLat;
  const ax = a.lng * kmPerDegLon;
  const ay = a.lat * kmPerDegLat;
  const bx = b.lng * kmPerDegLon;
  const by = b.lat * kmPerDegLat;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;

  if (!lenSq) return Math.hypot(px - ax, py - ay);

  const t = clamp((apx * abx + apy * aby) / lenSq, 0, 1);
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function bearingDeg(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function angleDiffDeg(a, b) {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

function getTrafficList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.LiveTraffics)) return data.LiveTraffics;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.samples)) return data.samples;
  return [];
}

function isPlausibleTaiwanPoint(point) {
  return (
    point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= 21.5 &&
    point.lat <= 26.5 &&
    point.lng >= 118 &&
    point.lng <= 123.5
  );
}

function normalizeDecodedPolyline(decoded) {
  if (!Array.isArray(decoded)) return [];

  return decoded
    .map((p) => {
      if (Array.isArray(p)) return { lng: Number(p[0]), lat: Number(p[1]) };
      if (p && typeof p === "object") {
        return { lat: Number(p.lat), lng: Number(p.lng) };
      }
      return null;
    })
    .filter(isPlausibleTaiwanPoint);
}

function isFresh(dataCollectTime, maxAgeMin = 20) {
  if (!dataCollectTime) return true;
  const ms = Date.parse(dataCollectTime);
  if (!Number.isFinite(ms)) return true;
  const ageMin = (Date.now() - ms) / 60000;
  return ageMin >= -2 && ageMin <= maxAgeMin;
}

function observedSpeedFromSection(section, polylineLengthKm) {
  const travelTimeSec = Number(section?.TravelTime ?? section?.travelTime);
  const travelSpeed = Number(
    section?.TravelSpeed ??
      section?.travelSpeed ??
      section?.Speed ??
      section?.speed
  );

  // Prefer the directly published TravelTime when the decoded OpenLR length
  // makes the resulting speed physically plausible.
  if (
    Number.isFinite(travelTimeSec) &&
    travelTimeSec > 0 &&
    Number.isFinite(polylineLengthKm) &&
    polylineLengthKm > 0.02
  ) {
    const fromTime = polylineLengthKm / (travelTimeSec / 3600);
    if (fromTime >= 1 && fromTime <= 160) {
      return { speedKmh: fromTime, source: "TravelTime", travelTimeSec };
    }
  }

  if (Number.isFinite(travelSpeed) && travelSpeed >= 1 && travelSpeed <= 160) {
    return { speedKmh: travelSpeed, source: "TravelSpeed", travelTimeSec: null };
  }

  return null;
}

function polylineLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineKm(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng
    );
  }
  return total;
}

function buildTrafficSegments({ freewayData, highwayData, openLrToPolyline }) {
  const rawSections = [
    ...getTrafficList(freewayData),
    ...getTrafficList(highwayData),
  ];

  const segments = [];

  for (const section of rawSections) {
    if (!isFresh(section?.DataCollectTime || section?.UpdateTime)) continue;

    const openLRs = section.OpenLRs || section.openLRs || [];
    if (!Array.isArray(openLRs) || !openLRs.length) continue;

    for (const item of openLRs) {
      try {
        const openlrString = item?.OpenLR || item?.openLR || item;
        const polyline = normalizeDecodedPolyline(openLrToPolyline(openlrString));
        if (polyline.length < 2) continue;

        const observed = observedSpeedFromSection(
          section,
          polylineLengthKm(polyline)
        );
        if (!observed) continue;

        for (let i = 1; i < polyline.length; i += 1) {
          const a = polyline[i - 1];
          const b = polyline[i];
          segments.push({
            sectionId: section.SectionID || section.SectionUID || null,
            sectionName: section.SectionName || section.RoadName || null,
            travelSpeed: Number(section.TravelSpeed ?? section.travelSpeed ?? null),
            observedSpeedKmh: observed.speedKmh,
            observedFrom: observed.source,
            travelTimeSec: observed.travelTimeSec,
            congestionLevel: section.CongestionLevel ?? null,
            congestionLevelID: section.CongestionLevelID || null,
            dataCollectTime: section.DataCollectTime || section.UpdateTime || null,
            a,
            b,
            bearing: bearingDeg(a, b),
          });
        }
      } catch {
        // Skip a malformed OpenLR item without failing the whole route.
      }
    }
  }

  return segments;
}

function gridKey(x, y) {
  return `${x}:${y}`;
}

function makeSpatialIndex(trafficSegments, cellDeg = 0.015) {
  const grid = new Map();

  for (const segment of trafficSegments) {
    const minLng = Math.min(segment.a.lng, segment.b.lng);
    const maxLng = Math.max(segment.a.lng, segment.b.lng);
    const minLat = Math.min(segment.a.lat, segment.b.lat);
    const maxLat = Math.max(segment.a.lat, segment.b.lat);

    const x0 = Math.floor(minLng / cellDeg);
    const x1 = Math.floor(maxLng / cellDeg);
    const y0 = Math.floor(minLat / cellDeg);
    const y1 = Math.floor(maxLat / cellDeg);

    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = gridKey(x, y);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(segment);
      }
    }
  }

  return { grid, cellDeg };
}

function candidatesNear(point, index) {
  const x = Math.floor(point.lng / index.cellDeg);
  const y = Math.floor(point.lat / index.cellDeg);
  const results = [];
  const seen = new Set();

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const segment of index.grid.get(gridKey(x + dx, y + dy)) || []) {
        if (seen.has(segment)) continue;
        seen.add(segment);
        results.push(segment);
      }
    }
  }

  return results;
}

function findMatchedSection(mid, routeBearing, index, matchThresholdKm) {
  let best = null;
  let bestDistanceKm = Infinity;

  for (const segment of candidatesNear(mid, index)) {
    const directionDiff = angleDiffDeg(routeBearing, segment.bearing);
    if (directionDiff > 70) continue;

    const distanceKm = pointToSegmentDistanceKm(mid, segment.a, segment.b);
    if (distanceKm <= matchThresholdKm && distanceKm < bestDistanceKm) {
      bestDistanceKm = distanceKm;
      best = segment;
    }
  }

  return best ? { ...best, matchDistanceKm: bestDistanceKm } : null;
}

function confidenceFromCoverage(coverageRatio) {
  if (coverageRatio >= 0.65) return "high";
  if (coverageRatio >= 0.25) return "medium";
  return "low";
}

export function calculateRouteSpecificTraffic({
  route,
  freewayData,
  highwayData,
  openLrToPolyline,
  matchThresholdKm = 0.18,
}) {
  const coordinates = route?.geometry?.coordinates || [];
  const baseDurationSec = Number(route?.duration || 0);
  const routeDistanceKm = Number(route?.distance || 0) / 1000;

  const baseResult = {
    adjustedMin: baseDurationSec > 0 ? Number((baseDurationSec / 60).toFixed(1)) : 0,
    delayMin: 0,
    trafficFactor: 1,
    matchedAreaFactor: 1,
    matchedCount: 0,
    matchedDistanceKm: 0,
    coverageRatio: 0,
    confidence: "low",
    matchedSections: [],
    segmentBased: true,
    noArtificialMultiplier: true,
  };

  if (
    coordinates.length < 2 ||
    !Number.isFinite(baseDurationSec) ||
    baseDurationSec <= 0 ||
    !Number.isFinite(routeDistanceKm) ||
    routeDistanceKm <= 0
  ) {
    return baseResult;
  }

  const trafficSegments = buildTrafficSegments({
    freewayData,
    highwayData,
    openLrToPolyline,
  });
  if (!trafficSegments.length) return baseResult;

  const index = makeSpatialIndex(trafficSegments);

  let geometryDistanceKm = 0;
  const rawSegments = [];

  for (let i = 1; i < coordinates.length; i += 1) {
    const prev = coordinates[i - 1];
    const curr = coordinates[i];
    const a = { lng: Number(prev?.[0]), lat: Number(prev?.[1]) };
    const b = { lng: Number(curr?.[0]), lat: Number(curr?.[1]) };
    if (!isPlausibleTaiwanPoint(a) || !isPlausibleTaiwanPoint(b)) continue;

    const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
    if (!Number.isFinite(km) || km <= 0 || km > 30) continue;

    geometryDistanceKm += km;
    rawSegments.push({ a, b, km });
  }

  if (!geometryDistanceKm || !rawSegments.length) return baseResult;

  const geometryScale = routeDistanceKm / geometryDistanceKm;
  const baseSecPerKm = baseDurationSec / routeDistanceKm;

  let adjustedSec = 0;
  let matchedDistanceKm = 0;
  let matchedBaseSec = 0;
  let matchedObservedSec = 0;
  let matchedCount = 0;
  const matchedSectionMap = new Map();

  for (const raw of rawSegments) {
    const segmentKm = raw.km * geometryScale;
    const baselineSec = segmentKm * baseSecPerKm;
    const mid = {
      lat: (raw.a.lat + raw.b.lat) / 2,
      lng: (raw.a.lng + raw.b.lng) / 2,
    };
    const routeBearing = bearingDeg(raw.a, raw.b);
    const match = findMatchedSection(mid, routeBearing, index, matchThresholdKm);

    if (!match || !Number.isFinite(match.observedSpeedKmh) || match.observedSpeedKmh <= 0) {
      adjustedSec += baselineSec;
      continue;
    }

    const observedSec = (segmentKm / match.observedSpeedKmh) * 3600;
    if (!Number.isFinite(observedSec) || observedSec <= 0) {
      adjustedSec += baselineSec;
      continue;
    }

    adjustedSec += observedSec;
    matchedDistanceKm += segmentKm;
    matchedBaseSec += baselineSec;
    matchedObservedSec += observedSec;
    matchedCount += 1;

    const key =
      match.sectionId ||
      `${match.sectionName || "unknown"}:${match.dataCollectTime || ""}`;

    const existing = matchedSectionMap.get(key) || {
      sectionId: match.sectionId,
      sectionName: match.sectionName,
      observedSpeedKmh: match.observedSpeedKmh,
      observedFrom: match.observedFrom,
      travelSpeed: Number.isFinite(match.travelSpeed) ? match.travelSpeed : null,
      travelTimeSec: match.travelTimeSec,
      congestionLevel: match.congestionLevel,
      congestionLevelID: match.congestionLevelID,
      dataCollectTime: match.dataCollectTime,
      matchedDistanceKm: 0,
      nearestMatchKm: Infinity,
    };

    existing.matchedDistanceKm += segmentKm;
    existing.nearestMatchKm = Math.min(
      existing.nearestMatchKm,
      Number(match.matchDistanceKm ?? Infinity)
    );
    matchedSectionMap.set(key, existing);
  }

  const coverageRatio = clamp(matchedDistanceKm / routeDistanceKm, 0, 1);
  const baseMin = baseDurationSec / 60;
  const adjustedMin = adjustedSec / 60;
  const trafficFactor = adjustedMin / baseMin;
  const matchedAreaFactor =
    matchedBaseSec > 0 ? matchedObservedSec / matchedBaseSec : 1;

  const matchedSections = [...matchedSectionMap.values()]
    .map((section) => ({
      ...section,
      observedSpeedKmh: Number(section.observedSpeedKmh.toFixed(1)),
      matchedDistanceKm: Number(section.matchedDistanceKm.toFixed(2)),
      nearestMatchKm: Number(section.nearestMatchKm.toFixed(3)),
    }))
    .sort((a, b) => b.matchedDistanceKm - a.matchedDistanceKm)
    .slice(0, 20);

  return {
    adjustedMin: Number(adjustedMin.toFixed(1)),
    delayMin: Number((adjustedMin - baseMin).toFixed(1)),
    trafficFactor: Number(trafficFactor.toFixed(3)),
    matchedAreaFactor: Number(matchedAreaFactor.toFixed(3)),
    matchedCount,
    matchedDistanceKm: Number(matchedDistanceKm.toFixed(2)),
    coverageRatio: Number(coverageRatio.toFixed(3)),
    confidence: confidenceFromCoverage(coverageRatio),
    matchedSections,
    segmentBased: true,
    noArtificialMultiplier: true,
  };
}