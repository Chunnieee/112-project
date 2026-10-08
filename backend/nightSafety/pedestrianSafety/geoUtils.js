// pedestrianSafety/geoUtils.js
//
// Small geographic helper functions used by the Pedestrian Safety Mode module.
// Ported from the standalone pedestrian-safety-mode prototype (CommonJS -> ESM),
// logic unchanged.
//
// For a city-scale area like Taipei, we approximate the curved surface of
// the Earth as a local flat plane centered on the route. This is called an
// "equirectangular" projection. It is not accurate for huge distances, but
// for buffers of a few hundred meters around a walking route inside one
// city, the error is negligible (a few centimeters).

export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Converts a lat/lon point into local X/Y coordinates, in meters,
 * relative to a reference point (refLat, refLon).
 */
export function toLocalXY(lat, lon, refLat, refLon) {
  const metersPerDegLat = 111320; // ~constant everywhere on Earth
  const metersPerDegLon = 111320 * Math.cos(toRadians(refLat)); // shrinks away from equator

  const x = (lon - refLon) * metersPerDegLon;
  const y = (lat - refLat) * metersPerDegLat;
  return { x, y };
}

/**
 * Shortest distance (in meters) from point p to the line segment a-b.
 * All inputs must already be in local X/Y meters (see toLocalXY).
 */
export function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t)); // clamp onto the segment

  const closest = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - closest.x, p.y - closest.y);
}

/**
 * Inverse of toLocalXY: turns a local X/Y meters offset (relative to
 * refLat/refLon) back into a lat/lon. Added for routeAlternatives.js,
 * which needs to place a synthesized via-point (computed in local XY, so
 * ordinary vector math like "push this point 300m away from that one"
 * works) back onto the map as a real coordinate to hand OSRM. Same flat-
 * plane approximation as toLocalXY, so it's only accurate at the same
 * city-block scale toLocalXY already documents itself as valid for.
 */
export function toLatLon(x, y, refLat, refLon) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(toRadians(refLat));

  return {
    lat: refLat + y / metersPerDegLat,
    lon: refLon + x / metersPerDegLon,
  };
}
