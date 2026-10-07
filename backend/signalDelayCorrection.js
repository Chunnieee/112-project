// signalDelayCorrection.js
//
// Corrects a structural under-estimate shared by every routing baseline this
// project has tried (OSRM, Valhalla, and TDX highway-class speed sections):
// none of them reliably account for the stop-and-wait time at signalized
// intersections. This module adds that time back, using real OSM traffic
// signal node positions (loaded from the local cache; see
// signalDensityCache.js), not a route-engine-specific config knob.
//
// IMPORTANT: secondsPerSignal is a calibration constant. The default below
// is a placeholder. Calibrate it against 2-3 real routes with a known
// signal count and a known real travel time before trusting the output.

import { loadCachedSignals } from "./signalDensityCache.js";

const DEFAULT_SECONDS_PER_SIGNAL = Number(
  process.env.SIGNAL_DELAY_SEC_PER_SIGNAL || 18
); // placeholder -- calibrate this

const MATCH_RADIUS_METERS = Number(
  process.env.SIGNAL_MATCH_RADIUS_M || 25
);

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * routeCoordinates: array of [lon, lat] pairs (GeoJSON order), the full
 * route geometry already produced by Valhalla/OSRM.
 * cityKey: which cached signal set to use (see signalDensityCache.js).
 *
 * Returns { signalCount, delaySec, delayMin, secondsPerSignal, cityKey }
 * so the caller can attach this as a transparent, auditable correction
 * rather than silently baking it into expectedMin.
 */
export function countSignalsAlongRoute({ routeCoordinates, cityKey }) {
  const cached = loadCachedSignals(cityKey);

  if (!cached || !Array.isArray(cached.signals) || !cached.signals.length) {
    return {
      signalCount: 0,
      delaySec: 0,
      delayMin: 0,
      secondsPerSignal: DEFAULT_SECONDS_PER_SIGNAL,
      cityKey,
      cacheAvailable: false,
    };
  }

  if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
    return {
      signalCount: 0,
      delaySec: 0,
      delayMin: 0,
      secondsPerSignal: DEFAULT_SECONDS_PER_SIGNAL,
      cityKey,
      cacheAvailable: true,
    };
  }

  // Avoid counting the same signal twice if the route geometry has many
  // closely-spaced points near one intersection.
  const matchedSignalKeys = new Set();

  for (const signal of cached.signals) {
    for (let i = 0; i < routeCoordinates.length; i += 1) {
      const [lon, lat] = routeCoordinates[i];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const distanceM = haversineMeters(lat, lon, signal.lat, signal.lon);

      if (distanceM <= MATCH_RADIUS_METERS) {
        matchedSignalKeys.add(`${signal.lat.toFixed(6)},${signal.lon.toFixed(6)}`);
        break;
      }
    }
  }

  const signalCount = matchedSignalKeys.size;
  const delaySec = signalCount * DEFAULT_SECONDS_PER_SIGNAL;

  return {
    signalCount,
    delaySec,
    delayMin: Number((delaySec / 60).toFixed(2)),
    secondsPerSignal: DEFAULT_SECONDS_PER_SIGNAL,
    cityKey,
    cacheAvailable: true,
  };
}
