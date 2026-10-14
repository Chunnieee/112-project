// pedestrianSafety/routeAnalysis.js
//
// Turns a route (list of lat/lon points) into something we can measure:
// its total length, and which nearby data points (accidents, streetlights,
// stores) fall inside a buffer distance of the route.
// Ported from the standalone pedestrian-safety-mode prototype (CommonJS -> ESM),
// logic unchanged.

import { toLocalXY, pointToSegmentDistance } from "./geoUtils.js";

/**
 * Converts a route into local X/Y meters (relative to its first point)
 * and calculates the total route length in meters.
 */
export function prepareRoute(route) {
  if (!route || route.length === 0) {
    return { localPoints: [], lengthMeters: 0, refLat: 0, refLon: 0 };
  }

  const refLat = route[0].lat;
  const refLon = route[0].lon;
  const localPoints = route.map((p) => toLocalXY(p.lat, p.lon, refLat, refLon));

  let lengthMeters = 0;
  for (let i = 0; i < localPoints.length - 1; i++) {
    const a = localPoints[i];
    const b = localPoints[i + 1];
    lengthMeters += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return { localPoints, lengthMeters, refLat, refLon };
}

/**
 * Counts how many points in `dataPoints` fall within `bufferRadius` meters
 * of ANY segment of the route (i.e. they are "near the route").
 *
 * dataPoints must each have { latitude, longitude }.
 */
export function countPointsNearRoute(dataPoints, routeInfo, bufferRadius) {
  const { localPoints, refLat, refLon } = routeInfo;
  if (!dataPoints || dataPoints.length === 0) return 0;
  if (localPoints.length === 0) return 0;

  let count = 0;

  for (const point of dataPoints) {
    const p = toLocalXY(point.latitude, point.longitude, refLat, refLon);

    let minDistance = Infinity;
    if (localPoints.length === 1) {
      minDistance = Math.hypot(p.x - localPoints[0].x, p.y - localPoints[0].y);
    } else {
      for (let i = 0; i < localPoints.length - 1; i++) {
        const d = pointToSegmentDistance(p, localPoints[i], localPoints[i + 1]);
        if (d < minDistance) minDistance = d;
      }
    }

    if (minDistance <= bufferRadius) count++;
  }

  return count;
}

/**
 * Same "distance from any route segment" logic as countPointsNearRoute,
 * but returns the actual matched points (with their distance to the
 * route attached) instead of just a count, sorted nearest-first. Added
 * for map display (pin the closest N points instead of every point in
 * the buffer, which for streetlights especially can be in the thousands).
 *
 * This does not change countPointsNearRoute's behavior or output -- it's
 * an additive sibling function so the already-verified scoring math is
 * untouched.
 *
 * dataPoints must each have { latitude, longitude, ...anything else }.
 */
export function findPointsNearRoute(dataPoints, routeInfo, bufferRadius) {
  const { localPoints, refLat, refLon } = routeInfo;
  if (!dataPoints || dataPoints.length === 0) return [];
  if (localPoints.length === 0) return [];

  const matched = [];

  for (const point of dataPoints) {
    const p = toLocalXY(point.latitude, point.longitude, refLat, refLon);

    let minDistance = Infinity;
    if (localPoints.length === 1) {
      minDistance = Math.hypot(p.x - localPoints[0].x, p.y - localPoints[0].y);
    } else {
      for (let i = 0; i < localPoints.length - 1; i++) {
        const d = pointToSegmentDistance(p, localPoints[i], localPoints[i + 1]);
        if (d < minDistance) minDistance = d;
      }
    }

    if (minDistance <= bufferRadius) {
      matched.push({ ...point, distanceMeters: Math.round(minDistance) });
    }
  }

  matched.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return matched;
}

/**
 * Distance weight for an accident that lies `distanceMeters` from the route
 * (2026-10 change). An accident ON the road you walk counts fully; one on a
 * parallel street behind a wall barely counts:
 *   - within the inner core (bufferRadius / 5 = 30 m for walking, 10 m for
 *     scooter / car): weight 1
 *   - from there out to the buffer edge: falls linearly to 0
 * Before this change every accident anywhere inside 150 m counted as 1, so
 * a path through a campus 100 m from a busy road "inherited" all of that
 * road's accidents.
 */
export function accidentDistanceWeight(distanceMeters, bufferRadius) {
  const inner = bufferRadius / 5;
  if (distanceMeters <= inner) return 1;
  if (distanceMeters >= bufferRadius) return 0;
  return (bufferRadius - distanceMeters) / (bufferRadius - inner);
}

/** Sum of accidentDistanceWeight over points already matched by findPointsNearRoute. */
export function weightedCount(matchedPoints, bufferRadius) {
  let sum = 0;
  for (const p of matchedPoints) sum += accidentDistanceWeight(p.distanceMeters, bufferRadius);
  return sum;
}

/**
 * Area of the buffer zone around the route, in km^2.
 *
 * 2026-10 change: the points counted for a route are everything within
 * bufferRadius of ANY segment, which includes a half-disc beyond each end
 * and only counts the overlap once where the route bends or doubles back.
 * The old "length x 2r" rectangle ignored the end caps (half the real area
 * for a 250 m route, so short routes got their densities doubled) and
 * double-counted overlaps.
 *
 * With routeInfo: the real area of the union of all segment buffers,
 * measured on a grid of bufferRadius/10 cells (15 m for walking).
 * Without routeInfo: length x 2r + pi r^2 (the exact area of a straight route).
 */
export function calculateBufferAreaKm2(routeLengthMeters, bufferRadiusMeters, routeInfo = null) {
  const r = bufferRadiusMeters;
  if (routeLengthMeters === 0) {
    return (Math.PI * r * r) / 1_000_000;
  }
  const pts = routeInfo && routeInfo.localPoints;
  if (!pts || pts.length < 2) {
    return (routeLengthMeters * 2 * r + Math.PI * r * r) / 1_000_000;
  }
  const cell = r / 10;
  const OFF = 1 << 20;
  const marked = new Set();
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const i0 = Math.floor((Math.min(a.x, b.x) - r) / cell);
    const i1 = Math.floor((Math.max(a.x, b.x) + r) / cell);
    const j0 = Math.floor((Math.min(a.y, b.y) - r) / cell);
    const j1 = Math.floor((Math.max(a.y, b.y) + r) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = (i + OFF) * 2 * OFF + (j + OFF);
        if (marked.has(key)) continue;
        const c = { x: (i + 0.5) * cell, y: (j + 0.5) * cell };
        if (pointToSegmentDistance(c, a, b) <= r) marked.add(key);
      }
    }
  }
  return (marked.size * cell * cell) / 1_000_000;
}
