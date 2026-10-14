// routeAlternatives.js
//
// Synthesizes an additional walking-route CANDIDATE when OSRM's own
// `alternatives=true` only found one path (common outside dense street
// grids -- a single mountain/rural road has no real second route for
// OSRM to offer). This does NOT replace OSRM or call any other routing
// provider: it uses OSRM's own, already-documented multi-waypoint
// support (passing 3+ coordinates to /route/v1/{profile}/... routes
// through all of them in order) to force a detour, by inserting one
// extra "via" coordinate between the real start and end.
//
// Two ways to pick that via-point, tried in this order:
//
//   1. RISK-AWARE (buildRiskAwareDetourPoint): finds the worst cluster of
//      pedestrian accidents within bufferRadius of the direct route (using
//      the same accident data + buffer-matching math as the pedestrian
//      safety scoring module), and places the via-point on the opposite
//      side of that cluster from the route -- i.e. "steer away from
//      wherever accidents are concentrated on this route". This only
//      works where there IS real accident data to steer by (Taipei walk
//      routes with an actual nearby cluster, not just an isolated point).
//
//   2. SYMMETRIC FALLBACK (buildSymmetricDetourPoints): a plain geometric
//      offset from the route's midpoint, perpendicular to the straight
//      start->end line, on both sides. Used when (1) found nothing to
//      steer around -- outside Taipei, or a route with no nearby accident
//      cluster at all -- so there's still SOMETHING to compare against the
//      single native route, even if it isn't a risk-motivated detour.
//
// Both are HEURISTICS, not a real alternative-routing algorithm: they
// give OSRM a point to route through and hope the resulting path is a
// genuinely different, still-sane road route, which OSRM's own pathing
// then has to make walkable. The caller (server.js's /api/route) is
// responsible for querying OSRM with the returned via-point, checking the
// result actually looks like a distinct route (not a near-duplicate of
// one already found), and discarding anything that fails outright rather
// than trusting it blindly.

import { toLocalXY, toLatLon, pointToSegmentDistance } from "./pedestrianSafety/geoUtils.js";
import { filterPedestrianAccidents } from "./pedestrianSafety/index.js";

/**
 * Finds the worst along-route cluster of pedestrian accidents near a
 * route, by bucketing accidents-within-bufferRadius into fixed-length
 * bins along the route's own path and returning whichever bin has the
 * most hits (ties broken by whichever comes first).
 *
 * Requires at least 2 accidents in the same ~binSizeMeters stretch to
 * count as a "cluster" worth detouring around -- a single isolated
 * accident point is too weak a signal to justify rerouting on, and would
 * make this trigger on essentially every route in Taipei (the dataset has
 * thousands of records city-wide).
 *
 * @param {Array<{lat:number, lon:number}>} routeLatLon
 * @param {Array} accidentData - same shape as realAccidentsTaipei
 * @param {number} bufferRadius - meters, should match the pedestrian
 *   safety scoring module's own buffer (default 150) so "risky" here
 *   means the same thing it means on the safety score card.
 * @param {number} binSizeMeters - along-route bucket size
 * @returns {null | { accidentCount, centroidLocal:{x,y}, nearestRouteIndex, localPoints, refLat, refLon }}
 */
export function findRiskiestRouteCluster(
  routeLatLon,
  accidentData,
  bufferRadius = 150,
  binSizeMeters = 250
) {
  if (!Array.isArray(routeLatLon) || routeLatLon.length < 2) return null;

  const refLat = routeLatLon[0].lat;
  const refLon = routeLatLon[0].lon;
  const localPoints = routeLatLon.map((p) => toLocalXY(p.lat, p.lon, refLat, refLon));

  const cumDist = [0];
  for (let i = 1; i < localPoints.length; i++) {
    cumDist.push(
      cumDist[i - 1] +
        Math.hypot(
          localPoints[i].x - localPoints[i - 1].x,
          localPoints[i].y - localPoints[i - 1].y
        )
    );
  }
  const totalLength = cumDist[cumDist.length - 1];
  if (totalLength <= 0) return null;

  const pedestrianAccidents = filterPedestrianAccidents(accidentData || []);
  if (!pedestrianAccidents.length) return null;

  const hits = [];
  for (const acc of pedestrianAccidents) {
    const lat = Number(acc.latitude);
    const lon = Number(acc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const p = toLocalXY(lat, lon, refLat, refLon);
    let minDist = Infinity;
    let bestAlong = 0;

    for (let i = 0; i < localPoints.length - 1; i++) {
      const a = localPoints[i];
      const b = localPoints[i + 1];
      const d = pointToSegmentDistance(p, a, b);
      if (d < minDist) {
        minDist = d;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        bestAlong = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);
      }
    }

    if (minDist <= bufferRadius) {
      hits.push({ along: bestAlong, x: p.x, y: p.y });
    }
  }

  if (!hits.length) return null;

  const binCount = Math.max(1, Math.ceil(totalLength / binSizeMeters));
  const bins = Array.from({ length: binCount }, () => []);
  for (const hit of hits) {
    let idx = Math.floor(hit.along / binSizeMeters);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].push(hit);
  }

  let worstIdx = -1;
  let worstCount = 0;
  bins.forEach((bin, i) => {
    if (bin.length > worstCount) {
      worstCount = bin.length;
      worstIdx = i;
    }
  });

  if (worstIdx === -1 || worstCount < 2) return null;

  const worstBin = bins[worstIdx];
  const centroidLocal = {
    x: worstBin.reduce((s, h) => s + h.x, 0) / worstBin.length,
    y: worstBin.reduce((s, h) => s + h.y, 0) / worstBin.length,
  };

  let nearestRouteIndex = 0;
  let nearestDist = Infinity;
  localPoints.forEach((lp, i) => {
    const d = Math.hypot(lp.x - centroidLocal.x, lp.y - centroidLocal.y);
    if (d < nearestDist) {
      nearestDist = d;
      nearestRouteIndex = i;
    }
  });

  return {
    accidentCount: worstBin.length,
    centroidLocal,
    nearestRouteIndex,
    localPoints,
    refLat,
    refLon,
  };
}

/**
 * Builds one via-point that steers away from a route's worst pedestrian-
 * accident cluster (see findRiskiestRouteCluster). Returns null when
 * there's no real cluster to steer around, so the caller can fall back to
 * buildSymmetricDetourPoints instead.
 *
 * @param {Array<{lat:number, lon:number}>} routeLatLon
 * @param {Array} accidentData
 * @param {{bufferRadius?:number, pushMeters?:number}} options
 */
export function buildRiskAwareDetourPoint(
  routeLatLon,
  accidentData,
  { bufferRadius = 150, pushMeters = 300 } = {}
) {
  const cluster = findRiskiestRouteCluster(routeLatLon, accidentData, bufferRadius);
  if (!cluster) return null;

  const { centroidLocal, nearestRouteIndex, localPoints, refLat, refLon, accidentCount } = cluster;
  const routePoint = localPoints[nearestRouteIndex];

  // Direction FROM the accident cluster TO the route at that point,
  // extended further the same way, pushes the via-point past the route
  // onto the side away from the cluster -- i.e. "the other side of the
  // street/block from where these accidents happened".
  let dx = routePoint.x - centroidLocal.x;
  let dy = routePoint.y - centroidLocal.y;
  let mag = Math.hypot(dx, dy);

  if (mag < 1) {
    // Cluster centroid sits almost exactly on the route itself (mag ~0,
    // so the push direction above is numerically unstable) -- fall back
    // to the route's own local perpendicular direction at that point.
    const a = localPoints[Math.max(0, nearestRouteIndex - 1)];
    const b = localPoints[Math.min(localPoints.length - 1, nearestRouteIndex + 1)];
    const rdx = b.x - a.x;
    const rdy = b.y - a.y;
    const rmag = Math.hypot(rdx, rdy) || 1;
    dx = -rdy / rmag;
    dy = rdx / rmag;
    mag = 1;
  }

  const ux = dx / mag;
  const uy = dy / mag;

  const via = toLatLon(
    routePoint.x + ux * pushMeters,
    routePoint.y + uy * pushMeters,
    refLat,
    refLon
  );

  return {
    lat: via.lat,
    lon: via.lon,
    kind: "risk-aware",
    reason:
      `為避開路線上事故密度最高的一段（半徑 ${bufferRadius} 公尺內偵測到 ${accidentCount} 件近5年行人事故聚集),` +
      "系統自動於附近插入繞行中途點產生的替代路線。",
    accidentCount,
  };
}

/**
 * Plain geometric fallback: two via-points offset perpendicular to the
 * straight start->end line, one on each side. Used when there's no
 * accident cluster to steer around (buildRiskAwareDetourPoint returned
 * null) -- still gives OSRM something to route through so there's a
 * second candidate to compare, just not a risk-motivated one.
 *
 * @param {{lat:number, lon:number}} start
 * @param {{lat:number, lon:number}} end
 * @param {number} offsetFraction - offset distance as a fraction of the
 *   straight-line start->end distance.
 */
export function buildSymmetricDetourPoints(start, end, offsetFraction = 0.35) {
  const refLat = start.lat;
  const refLon = start.lon;
  const s = toLocalXY(start.lat, start.lon, refLat, refLon);
  const e = toLocalXY(end.lat, end.lon, refLat, refLon);

  const midX = (s.x + e.x) / 2;
  const midY = (s.y + e.y) / 2;
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const mag = Math.hypot(dx, dy) || 1;
  const offset = mag * offsetFraction;

  const ux = -dy / mag;
  const uy = dx / mag;

  const a = toLatLon(midX + ux * offset, midY + uy * offset, refLat, refLon);
  const b = toLatLon(midX - ux * offset, midY - uy * offset, refLat, refLon);

  const reason = "系統自動產生之替代路線(幾何偏移,附近無明顯事故聚集可供避開)。";

  return [
    { lat: a.lat, lon: a.lon, kind: "symmetric", reason },
    { lat: b.lat, lon: b.lon, kind: "symmetric", reason },
  ];
}

/**
 * Convenience wrapper: risk-aware candidate first (if any), then enough
 * symmetric candidates to reach `maxCandidates` total. server.js tries
 * these in order against OSRM and keeps whichever produce genuinely
 * distinct, valid routes.
 */
export function buildDetourCandidates(
  routeLatLon,
  start,
  end,
  accidentData,
  { bufferRadius = 150, pushMeters = 300, maxCandidates = 2 } = {}
) {
  const candidates = [];

  const riskAware = buildRiskAwareDetourPoint(routeLatLon, accidentData, {
    bufferRadius,
    pushMeters,
  });
  if (riskAware) candidates.push(riskAware);

  if (candidates.length < maxCandidates) {
    for (const symmetric of buildSymmetricDetourPoints(start, end)) {
      if (candidates.length >= maxCandidates) break;
      candidates.push(symmetric);
    }
  }

  return candidates.slice(0, maxCandidates);
}
