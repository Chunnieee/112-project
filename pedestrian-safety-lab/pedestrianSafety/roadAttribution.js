// pedestrianSafety/roadAttribution.js
//
// Automatic "which data belongs to this route" (2026-10), replacing the
// user-typed buffer radius.
//
// A fixed radius is wrong either way: too wide and a campus path picks up
// the accidents of the busy road behind the wall; too narrow and accidents
// that really happened on the route (coordinates are often 10-30 m off) are
// missed. Instead, each data point is given to the NEAREST ROAD, using the
// real OpenStreetMap road network (roadNetwork.js):
//
//   - within CORE m of the route         -> always the route's (GPS error)
//   - farther than maxRadius             -> never
//   - otherwise: kept if no other road is closer than (distance - TOL)
//
// Roads within OWN m of the route (its sidewalks, the other carriageway,
// the mouth of a side street) count as part of the route, not as "other".
//
// The scoring area is the same rule applied to the ground itself: every
// 5 m cell within maxRadius that is closer to this route than to any other
// road. Its size gives an EFFECTIVE radius (the fixed radius a straight
// buffer of the same area would have), which picks the density thresholds
// (radiusThresholds.js) and the distance weighting, so a route in a dense
// street grid gets a narrow corridor and a path through a park a wide one.

import { toLocalXY, pointToSegmentDistance } from "./geoUtils.js";

export const ATTRIBUTION = {
  walk: { maxRadius: 150, own: 25, core: 15, tol: 10, roads: null },
  // Vehicles: only roads a car/scooter can use can "take" an accident, and
  // the opposite carriageway of a dual road (often 20-30 m away) is own.
  vehicle: {
    maxRadius: 80,
    own: 30,
    core: 10,
    tol: 8,
    roads: new Set([
      "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
      "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
      "residential", "living_street", "service", "road",
    ]),
  },
};

const PIECE = 20;
const OFF = 1 << 20; // road geometry is cut into pieces of at most 20 m

// Grid index of segments for "distance to nearest segment within maxD".
class SegIndex {
  constructor(cell) {
    this.cell = cell;
    this.grid = new Map();
  }
  add(a, b) {
    const c = this.cell;
    for (let i = Math.floor(Math.min(a.x, b.x) / c); i <= Math.floor(Math.max(a.x, b.x) / c); i++)
      for (let j = Math.floor(Math.min(a.y, b.y) / c); j <= Math.floor(Math.max(a.y, b.y) / c); j++) {
        const k = i * 1e6 + j;
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push([a, b]);
      }
  }
  /** Nearest distance, or Infinity if nothing within maxD. */
  nearest(p, maxD) {
    const c = this.cell;
    const r = Math.ceil(maxD / c);
    const ci = Math.floor(p.x / c);
    const cj = Math.floor(p.y / c);
    let best = Infinity;
    for (let i = ci - r; i <= ci + r; i++)
      for (let j = cj - r; j <= cj + r; j++) {
        const list = this.grid.get(i * 1e6 + j);
        if (!list) continue;
        for (const [a, b] of list) {
          const d = pointToSegmentDistance(p, a, b);
          if (d < best) best = d;
        }
      }
    return best <= maxD ? best : Infinity;
  }
}

/**
 * @param routeInfo  prepareRoute() output (localPoints, refLat, refLon, lengthMeters)
 * @param ways       roadNetwork.roadsNearRoute() output ([{ hw, g: [[lat,lon],...] }])
 * @param kind       "walk" | "vehicle"
 * @returns null if it cannot be applied, else
 *   { method, maxRadius, effectiveRadius, areaKm2, keep(point) }
 */
export function buildAttribution(routeInfo, ways, kind = "walk") {
  const P = ATTRIBUTION[kind] || ATTRIBUTION.walk;
  const pts = routeInfo && routeInfo.localPoints;
  if (!ways || !pts || pts.length < 2 || !(routeInfo.lengthMeters > 0)) return null;
  const { refLat, refLon } = routeInfo;
  const R = P.maxRadius;

  const route = new SegIndex(50);
  for (let k = 0; k < pts.length - 1; k++) route.add(pts[k], pts[k + 1]);

  // Other roads: every road piece farther than OWN from the route, within
  // reach of anything we may need to compare (2R).
  const other = new SegIndex(25);
  let otherCount = 0;
  for (const w of ways) {
    if (P.roads && !P.roads.has(w.hw)) continue;
    const g = w.g.map(([lat, lon]) => toLocalXY(lat, lon, refLat, refLon));
    for (let s = 0; s < g.length - 1; s++) {
      const a = g[s];
      const b = g[s + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / PIECE));
      for (let t = 0; t < n; t++) {
        const p0 = { x: a.x + ((b.x - a.x) * t) / n, y: a.y + ((b.y - a.y) * t) / n };
        const p1 = { x: a.x + ((b.x - a.x) * (t + 1)) / n, y: a.y + ((b.y - a.y) * (t + 1)) / n };
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        const d = route.nearest(mid, 2 * R + PIECE);
        if (d <= P.own || d === Infinity) continue;
        other.add(p0, p1);
        otherCount++;
      }
    }
  }

  // Is a location at distance dRoute from the route closer to it than to any other road?
  const ours = (p, dRoute) => {
    if (dRoute <= P.core) return true;
    if (dRoute > R) return false;
    return other.nearest(p, dRoute - P.tol) === Infinity;
  };

  // Area: 5 m cells (coarser for very long routes to bound the work).
  const L = routeInfo.lengthMeters;
  const cell = Math.max(5, Math.sqrt((L * 2 * R) / 200000));
  const dist = new Map();
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    for (let i = Math.floor((Math.min(a.x, b.x) - R) / cell); i <= Math.floor((Math.max(a.x, b.x) + R) / cell); i++)
      for (let j = Math.floor((Math.min(a.y, b.y) - R) / cell); j <= Math.floor((Math.max(a.y, b.y) + R) / cell); j++) {
        const c = { x: (i + 0.5) * cell, y: (j + 0.5) * cell };
        const d = pointToSegmentDistance(c, a, b);
        if (d > R) continue;
        const key = (i + OFF) * 2 * OFF + (j + OFF);
        const prev = dist.get(key);
        if (prev === undefined || d < prev) dist.set(key, d);
      }
  }
  let n = 0;
  for (const [key, d] of dist) {
    const i = Math.floor(key / (2 * OFF)) - OFF;
    const j = (key % (2 * OFF)) - OFF;
    if (ours({ x: (i + 0.5) * cell, y: (j + 0.5) * cell }, d)) n++;
  }
  const area = n * cell * cell; // m²
  // Radius of a straight buffer with the same area: L*2r + pi r^2 = area.
  let rEff = (-2 * L + Math.sqrt(4 * L * L + 4 * Math.PI * area)) / (2 * Math.PI);
  rEff = Math.max(P.core, Math.min(R, rEff));

  return {
    method: "nearest-road",
    kind,
    maxRadius: R,
    effectiveRadius: Math.round(rEff),
    areaKm2: area / 1e6,
    otherRoadPieces: otherCount,
    /** point: { latitude, longitude, distanceMeters } (from findPointsNearRoute with maxRadius) */
    keep(point) {
      const p = toLocalXY(point.latitude, point.longitude, refLat, refLon);
      return ours(p, point.distanceMeters);
    },
  };
}
