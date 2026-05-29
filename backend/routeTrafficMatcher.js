// routeTrafficMatcher.js

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
  const x = point.lng;
  const y = point.lat;

  const x1 = a.lng;
  const y1 = a.lat;
  const x2 = b.lng;
  const y2 = b.lat;

  const A = x - x1;
  const B = y - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;

  let param = -1;

  if (lenSq !== 0) {
    param = dot / lenSq;
  }

  let xx;
  let yy;

  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  return haversineKm(y, x, yy, xx);
}

function getTrafficList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.LiveTraffics)) return data.LiveTraffics;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.samples)) return data.samples;
  return [];
}

function normalizeDecodedPolyline(decoded) {
  if (!decoded) return [];

  if (!Array.isArray(decoded)) return [];

  return decoded
    .map((p) => {
      if (Array.isArray(p)) {
        return {
          lng: Number(p[0]),
          lat: Number(p[1])
        };
      }

      if (typeof p === "object") {
        return {
          lat: Number(p.lat),
          lng: Number(p.lng)
        };
      }

      return null;
    })
    .filter(
      (p) =>
        p &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng)
    );
}

function buildTrafficSections({
  freewayData,
  highwayData,
  openLrToPolyline
}) {
  const rawSections = [
    ...getTrafficList(freewayData),
    ...getTrafficList(highwayData)
  ];

  const sections = [];

  for (const section of rawSections) {
    const openLRs = section.OpenLRs || section.openLRs || [];

    const travelSpeed = Number(
      section.TravelSpeed ??
        section.travelSpeed ??
        section.Speed ??
        section.speed ??
        0
    );

    const congestionLevel = Number(
      section.CongestionLevel ??
        section.CongestionLevelID ??
        section.congestionLevel ??
        0
    );

    if (!Array.isArray(openLRs) || openLRs.length === 0) continue;
    if (!travelSpeed || travelSpeed <= 0) continue;

    for (const item of openLRs) {
      try {
        const openlrString = item.OpenLR || item.openLR || item;
        const decoded = openLrToPolyline(openlrString);
        const polyline = normalizeDecodedPolyline(decoded);

        if (polyline.length >= 2) {
          sections.push({
            sectionId: section.SectionID,
            sectionName: section.SectionName,
            travelSpeed,
            congestionLevel,
            dataCollectTime: section.DataCollectTime,
            polyline
          });
        }
      } catch (error) {
        // skip decode failed section
      }
    }
  }

  return sections;
}

function findMatchedSection(
  segmentMidPoint,
  trafficSections,
  matchThresholdKm
) {
  let bestMatch = null;
  let bestDistanceKm = Infinity;

  for (const section of trafficSections) {
    const polyline = section.polyline;

    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1];
      const b = polyline[i];

      const distanceKm = pointToSegmentDistanceKm(
        segmentMidPoint,
        a,
        b
      );

      if (
        distanceKm <= matchThresholdKm &&
        distanceKm < bestDistanceKm
      ) {
        bestDistanceKm = distanceKm;
        bestMatch = section;
      }
    }
  }

  return bestMatch;
}

export function calculateRouteSpecificTraffic({
  route,
  freewayData,
  highwayData,
  openLrToPolyline,
  matchThresholdKm = 0.25
}) {
  const coordinates = route?.geometry?.coordinates || [];

  if (!route || coordinates.length < 2) {
    return {
      adjustedMin: route?.duration
        ? Number((route.duration / 60).toFixed(1))
        : 0,
      delayMin: 0,
      trafficFactor: 1,
      matchedCount: 0,
      matchedDistanceKm: 0,
      matchedSections: [],
      segmentBased: true
    };
  }

  const trafficSections = buildTrafficSections({
    freewayData,
    highwayData,
    openLrToPolyline
  });

  const baseDurationSec = route.duration;
  const baseDistanceKm = route.distance / 1000;

  const baseAvgSpeedKmh =
    baseDistanceKm / (baseDurationSec / 3600);

  let adjustedSec = 0;
  let matchedCount = 0;
  let matchedDistanceKm = 0;

  const matchedSections = [];

  for (let i = 1; i < coordinates.length; i++) {
    const prev = coordinates[i - 1];
    const curr = coordinates[i];

    const prevPoint = {
      lng: Number(prev[0]),
      lat: Number(prev[1])
    };

    const currPoint = {
      lng: Number(curr[0]),
      lat: Number(curr[1])
    };

    const segmentKm = haversineKm(
      prevPoint.lat,
      prevPoint.lng,
      currPoint.lat,
      currPoint.lng
    );

    if (!Number.isFinite(segmentKm) || segmentKm <= 0) continue;

    const segmentMidPoint = {
      lat: (prevPoint.lat + currPoint.lat) / 2,
      lng: (prevPoint.lng + currPoint.lng) / 2
    };

    const matchedSection = findMatchedSection(
      segmentMidPoint,
      trafficSections,
      matchThresholdKm
    );

    let segmentSpeedKmh = baseAvgSpeedKmh;

    if (matchedSection) {
      const tdxSpeed = Number(matchedSection.travelSpeed);

segmentSpeedKmh = Math.min(
  baseAvgSpeedKmh,
  Math.max(15, tdxSpeed)
);
      matchedCount += 1;
      matchedDistanceKm += segmentKm;

      matchedSections.push({
        sectionId: matchedSection.sectionId,
        sectionName: matchedSection.sectionName,
        travelSpeed: matchedSection.travelSpeed,
        congestionLevel: matchedSection.congestionLevel,
        dataCollectTime: matchedSection.dataCollectTime,
        segmentKm: Number(segmentKm.toFixed(3))
      });
    }

    adjustedSec += (segmentKm / segmentSpeedKmh) * 3600;
  }

  const baseMin = baseDurationSec / 60;
  const adjustedMin = adjustedSec / 60;
  const delayMin = adjustedMin - baseMin;
  const trafficFactor = adjustedMin / baseMin;

  return {
    adjustedMin: Number(adjustedMin.toFixed(1)),
    delayMin: Number(delayMin.toFixed(1)),
    trafficFactor: Number(trafficFactor.toFixed(2)),
    matchedCount,
    matchedDistanceKm: Number(matchedDistanceKm.toFixed(2)),
    matchedSections: matchedSections.slice(0, 30),
    segmentBased: true
  };
}