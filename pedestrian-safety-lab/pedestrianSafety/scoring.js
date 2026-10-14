// pedestrianSafety/scoring.js
//
// The actual Pedestrian Safety Mode scoring logic.
// Ported from the standalone pedestrian-safety-mode prototype (CommonJS -> ESM).
// Calibration thresholds were reviewed and re-derived against the current
// real data -- see the DEFAULT_CONFIG comments below for how and when.
//
// IMPORTANT LIMITATIONS (keep these in mind / surface them to users):
//   - This produces an ESTIMATED safety score, not a guarantee of actual
//     safety. It reflects three narrow, measurable proxies only.
//   - Convenience-store density is only a PROXY for pedestrian activity /
//     "eyes on the street" -- it does not directly measure safety. As of
//     the data refresh described in data/realTaipeiData.js it IS real
//     data in "real" mode (1,479 stores city-wide); mock mode still uses
//     9 hand-placed points.
//   - Streetlight density does not mean every streetlight is functioning.
//   - Accident history describes what happened in the past. It does not
//     guarantee future risk, especially if conditions changed. The real
//     dataset covers 2025-01-01 to 2026-09-02 (~1.67 years) -- see
//     computeAccidentDataYearsSpan() below, which reads this span from
//     the data itself so the density calculation self-corrects if the
//     dataset is refreshed again later, instead of silently drifting out
//     of calibration the way a hardcoded "per year" assumption would.
 
import { configForRadius } from "./radiusThresholds.js";
import { buildAttribution } from "./roadAttribution.js";
import {
  prepareRoute,
  countPointsNearRoute,
  findPointsNearRoute,
  calculateBufferAreaKm2,
  weightedCount,
} from "./routeAnalysis.js";
 
// Cap on how many nearby accident/streetlight points are returned for map
// display (findPointsNearRoute already sorts nearest-first, so this keeps
// the closest ones). A dense city buffer can have thousands of streetlights
// -- returning all of them would bloat the response and the map. This does
// not affect the score itself, which is still computed from the full count.
const MAX_MAP_POINTS = 40;
 
// ----------------------------------------------------------------------
// Configuration (fixed weights, per project spec -- do not change these)
// ----------------------------------------------------------------------
export const WEIGHTS = {
  accident: 0.4,
  streetlight: 0.3,
  convenienceStore: 0.3,
};
 
// Recalibrated against real Taipei data. accident/streetlight thresholds
// carry forward the original module's methodology (density observed
// across a spread of real sample corridors, from dense commercial to
// quiet residential); the convenience-store threshold below was newly
// calibrated the same way once real store data became available -- see
// each field's comment for the actual measured numbers.
export const DEFAULT_CONFIG = {
  // Pedestrian accidents per km^2 PER YEAR (within the buffer) at which
  // the accident score reaches 0 -- "per year" because
  // calculatePedestrianAccidentScore divides by the accident dataset's
  // own time span before comparing against this, so it stays meaningful
  // however many months/years of data are loaded.
  //
  // Originally calibrated against 7 real Taipei corridors (dense retail
  // to quiet residential) using an EARLIER accident dataset (a 2025-01 to
  // 2026-09 community mirror, ~1.67 years): observed annualized densities
  // ranged ~3-80/km^2/yr, topping out at Zhongxiao Dunhua. That dataset
  // has since been replaced with the project's own real 內政部警政署
  // A1/A2 CSVs, and this threshold has NOT been formally re-derived
  // against it. A quick 3-corridor spot check, re-run each time the
  // dataset's scope changed, still lands under/near 80 each time:
  //   - against 2018-2021 (4yr): 政大→台北車站 17.1, 台北車站→台北101
  //     36.8, 西門町→台北車站 61.2/km^2/yr
  //   - against 2018-2025 (8yr): 政大→台北車站 14.2, 台北車站→台北101
  //     26.3, 西門町→台北車站 73.8/km^2/yr
  //   - against 2021-2025 (5yr, current scope -- see realTaipeiData.js
  //     for why it's 5 years and not 8): 政大→台北車站 12.9, 台北車站
  //     →台北101 26.0, 西門町→台北車站 68.4/km^2/yr
  // So it isn't obviously miscalibrated under any of these windows, but
  // that's still not the same as re-running the original 7-corridor
  // derivation against the current data -- do that before treating 80 as
  // validated. Worth flagging for the thesis write-up either way: 西門町
  // →台北車站 keeps landing closest to (and, in the 8yr window, above)
  // this ceiling across all three windows, so it's the corridor most
  // sensitive to exactly where 80 is set -- if re-deriving the threshold,
  // start there.
  //
  // 2026-10: the score now uses a DISTANCE-WEIGHTED accident count
  // (routeAnalysis.js accidentDistanceWeight: full weight within 30 m of
  // the route, falling to 0 at 150 m) and the real buffer area (end caps
  // included). Weighted densities are about half the plain ones, so the
  // threshold was re-derived to stay exactly as strict: on Taipei road
  // points, plain density 80 sits at the 98.9th percentile; the weighted
  // density at that percentile is 38 (scripts/calibrate-modes.mjs, 3,000 /
  // 6,000 / 12,000 points -> 37 / 39 / 38).
  maxAcceptableAccidentDensity: 38,
 
  // Streetlights per km^2 at which the streetlight score reaches 100.
  // Calibrated near the upper end of the real observed range (585-2,200/km^2).
  idealStreetlightDensity: 1800,
 
  // Convenience stores per km^2 at which the store-density score reaches
  // 100. Calibrated against the real store dataset (1,479 stores
  // city-wide) using the same 7 corridors as the accident threshold
  // above: observed densities ranged ~5.5/km^2 (quiet Neihu residential)
  // to ~93.6/km^2 (Ximending). Set near that observed maximum. The
  // previous value (25) was a placeholder from when this factor was
  // still paired with 9 hand-placed mock points -- it would have
  // saturated to a 100 score on almost every real corridor, including
  // quiet residential ones, and provided no real discrimination.
  idealConvenienceStoreDensity: 90,
};
 
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
 
/**
 * Keeps only accident records that are pedestrian-involved.
 */
export function filterPedestrianAccidents(accidentData) {
  return (accidentData || []).filter((a) => {
    if (!a.accident_type) return true;
    return a.accident_type.toLowerCase().includes("pedestrian");
  });
}
 
// A dataset covering a different time span than it was calibrated for
// silently skews the accident score: the same real corridor looks
// "riskier" if scored against 20 months of data than against 12, purely
// because more months means more accumulated accidents, with nothing to
// do with the corridor itself. Deriving the span from the data's own
// min/max `date` (rather than assuming "this is one year of data," which
// stopped being true when the accident dataset was refreshed to a ~1.67
// year window) keeps the density calculation self-correcting: refresh the
// dataset again to a different span later, and this adapts automatically
// instead of needing maxAcceptableAccidentDensity manually re-tuned.
export function computeAccidentDataYearsSpan(accidentData) {
  const times = (accidentData || [])
    .map((a) => a && a.date)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t));
 
  if (times.length < 2) return 1; // not enough data to measure a span -- assume 1 year
 
  const spanMs = Math.max(...times) - Math.min(...times);
  const spanYears = spanMs / (365.25 * 24 * 3600 * 1000);
 
  // Guard against a degenerate near-zero span (e.g. every record on the
  // same day) blowing the density up toward infinity.
  return spanYears > 0.05 ? spanYears : 1;
}
 
/**
 * FACTOR 1: Pedestrian accidents -> 0-100 safety score (40% weight).
 * density = accidentCount / bufferAreaKm2 / accidentDataYearsSpan
 * score   = 100 - (density / maxAcceptableAccidentDensity) * 100
 *
 * accidentDataYearsSpan defaults to 1 (i.e. behaves exactly like the
 * original un-annualized formula) when not supplied, so any external
 * caller of this function directly keeps working unchanged.
 */
export function calculatePedestrianAccidentScore(
  accidentCount,
  bufferAreaKm2,
  accidentDataYearsSpan = 1,
  config = DEFAULT_CONFIG
) {
  if (bufferAreaKm2 <= 0) return 100; // no measurable area -> assume safest default
  const yearsSpan = accidentDataYearsSpan > 0 ? accidentDataYearsSpan : 1;
  const density = accidentCount / bufferAreaKm2 / yearsSpan;
  const score = 100 - (density / config.maxAcceptableAccidentDensity) * 100;
  return clamp(score, 0, 100);
}
 
/**
 * FACTOR 2: Streetlight density -> 0-100 score (30% weight).
 * density = streetlightCount / bufferAreaKm2
 * score   = (density / idealStreetlightDensity) * 100
 */
export function calculateStreetlightScore(streetlightCount, bufferAreaKm2, config = DEFAULT_CONFIG) {
  if (bufferAreaKm2 <= 0) return 0;
  const density = streetlightCount / bufferAreaKm2;
  const score = (density / config.idealStreetlightDensity) * 100;
  return clamp(score, 0, 100);
}
 
/**
 * FACTOR 3: Convenience-store density -> 0-100 score (30% weight).
 * Explicitly a PROXY for pedestrian activity / "eyes on the street".
 */
export function calculateConvenienceStoreScore(storeCount, bufferAreaKm2, config = DEFAULT_CONFIG) {
  if (bufferAreaKm2 <= 0) return 0;
  const density = storeCount / bufferAreaKm2;
  const score = (density / config.idealConvenienceStoreDensity) * 100;
  return clamp(score, 0, 100);
}
 
/**
 * Combines the three factor scores into the final weighted score.
 */
export function calculatePedestrianSafetyScore(accidentScore, streetlightScore, convenienceStoreScore) {
  const final =
    accidentScore * WEIGHTS.accident +
    streetlightScore * WEIGHTS.streetlight +
    convenienceStoreScore * WEIGHTS.convenienceStore;
  return Math.round(clamp(final, 0, 100) * 10) / 10; // round to 1 decimal place
}
 
/**
 * MAIN ENTRY POINT.
 *
 * @param {Array<{lat:number, lon:number}>} route - ordered route points
 * @param {Array<{latitude, longitude, date, accident_type}>} accidentData
 * @param {Array<{latitude, longitude}>} streetlightData
 * @param {Array<{latitude, longitude, store_type}>} convenienceStoreData
 * @param {number|null} bufferRadius - fixed buffer radius in meters, or
 *   null = automatic (nearest-road attribution, needs opts.roads)
 * @param {object} config - optional override of the scoring thresholds above
 * @param {object} opts - { roads: OSM ways around the route (roadNetwork.js) }
 */
export function analyzePedestrianRouteSafety(
  route,
  accidentData = [],
  streetlightData = [],
  convenienceStoreData = [],
  bufferRadius = 150,
  config = DEFAULT_CONFIG,
  opts = {}
) {
  const routeInfo = prepareRoute(route);

  // Which data belongs to this route:
  //  - automatic (bufferRadius null + road network available): every point
  //    goes to its NEAREST road (roadAttribution.js); the corridor follows
  //    the real street layout and has an effective radius;
  //  - otherwise a fixed buffer (bufferRadius, or 150 m if null).
  const attribution =
    bufferRadius == null && opts.roads ? buildAttribution(routeInfo, opts.roads, "walk") : null;
  const searchRadius = attribution ? attribution.maxRadius : bufferRadius || 150;
  const radius = attribution ? attribution.effectiveRadius : searchRadius;
  const keep = attribution ? (list) => list.filter((p) => attribution.keep(p)) : (list) => list;
  const bufferAreaKm2 =
    attribution && attribution.areaKm2 > 0
      ? attribution.areaKm2
      : calculateBufferAreaKm2(routeInfo.lengthMeters, radius, routeInfo); // incl. end caps / bends

  // Thresholds were calibrated at 150 m; scale them to the (effective)
  // radius (narrow corridors are mostly road, so every density is higher).
  config = configForRadius(config, radius, "walk");

  const pedestrianOnlyAccidents = filterPedestrianAccidents(accidentData);
  const accidentDataYearsSpan = computeAccidentDataYearsSpan(accidentData);

  // pedestrianAccidents = plain count (shown to the user); the SCORE uses
  // the distance-weighted count (accidentDistanceWeight in routeAnalysis.js).
  const nearAccidents = keep(findPointsNearRoute(pedestrianOnlyAccidents, routeInfo, searchRadius));
  const pedestrianAccidents = nearAccidents.length;
  const accidentWeightedCount = weightedCount(nearAccidents, radius);
  const nearLights = keep(findPointsNearRoute(streetlightData, routeInfo, searchRadius));
  const nearStores = keep(findPointsNearRoute(convenienceStoreData, routeInfo, searchRadius));
  const streetlights = nearLights.length;
  const convenienceStores = nearStores.length;

  const accidentScore = calculatePedestrianAccidentScore(
    accidentWeightedCount,
    bufferAreaKm2,
    accidentDataYearsSpan,
    config
  );
  const streetlightScore = calculateStreetlightScore(streetlights, bufferAreaKm2, config);
  const convenienceStoreScore = calculateConvenienceStoreScore(convenienceStores, bufferAreaKm2, config);
 
  const finalSafetyScore = calculatePedestrianSafetyScore(
    accidentScore,
    streetlightScore,
    convenienceStoreScore
  );
 
  // Actual min/max date found in the accident dataset (not the whole
  // route's data -- just this factor's), so the frontend can show *which*
  // period "歷史事故" actually covers instead of a hardcoded year that
  // silently goes stale the next time this data is refreshed.
  const accidentDates = pedestrianOnlyAccidents
    .map((a) => a && a.date)
    .filter(Boolean)
    .sort();
  const accidentDataDateRange =
    accidentDates.length > 0
      ? { from: accidentDates[0], to: accidentDates[accidentDates.length - 1] }
      : null;
 
  const out = {
    routeLengthMeters: Math.round(routeInfo.lengthMeters),
    bufferRadiusMeters: radius,
    bufferAreaKm2: Math.round(bufferAreaKm2 * 1000) / 1000,
    attribution: attribution
      ? { method: "nearest-road", maxRadius: attribution.maxRadius, effectiveRadius: attribution.effectiveRadius }
      : { method: "fixed-buffer", radius },
    pedestrianAccidents,
    accidentWeightedCount: Math.round(accidentWeightedCount * 10) / 10,
    streetlights,
    convenienceStores,
    accidentScore: Math.round(accidentScore * 10) / 10,
    streetlightScore: Math.round(streetlightScore * 10) / 10,
    convenienceStoreScore: Math.round(convenienceStoreScore * 10) / 10,
    finalSafetyScore,
    accidentDataYearsSpan: Math.round(accidentDataYearsSpan * 100) / 100,
    accidentDataDateRange,
    scoringThresholds: {
      maxAcceptableAccidentDensity: Math.round(config.maxAcceptableAccidentDensity),
      idealStreetlightDensity: Math.round(config.idealStreetlightDensity),
      idealConvenienceStoreDensity: Math.round(config.idealConvenienceStoreDensity),
    },
    // Capped, nearest-first point lists for map markers (added for the
    // TV-6-style route detail view). Does not affect the score above --
    // that's still computed from the full pedestrianAccidents/streetlights
    // counts a few lines up.
    nearbyAccidentPoints: nearAccidents.slice(0, MAX_MAP_POINTS),
    nearbyStreetlightPoints: nearLights.slice(0, MAX_MAP_POINTS),
    nearbyStorePoints: nearStores.slice(0, MAX_MAP_POINTS),
  };
  // Full lists (the same points the score used) for map layers; not
  // enumerable so they never end up in JSON responses.
  Object.defineProperty(out, "matched", {
    value: { accidents: nearAccidents, streetlights: nearLights, stores: nearStores },
    enumerable: false,
  });
  return out;
}
 