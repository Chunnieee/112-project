// scripts/calibrate-modes.mjs
//
// Derives the scooter / car scoring thresholds so they are exactly as strict
// as the original walking thresholds (which were calibrated on Taipei
// corridors): "a road scores 0 for accidents" should mean the same relative
// thing in every mode.
//
// Method (percentile matching on real road locations):
//   1. Sample N points on real Taipei roads (streetlight positions, which by
//      definition sit on roads), fixed random seed so it is reproducible.
//   2. Walking: measure pedestrian-accident density (per km² per year) and
//      streetlight density in a 150 m radius around each point; find the
//      share p of points at or below the walking thresholds (80 accidents,
//      1,800 lights per km²).
//   3. Each vehicle mode: measure ITS accident density (accidents involving a
//      scooter / a car) and streetlight density in that mode's own buffer
//      radius (50 m: on the road itself), and take the same p-th percentile.
//
// Run:  node scripts/calibrate-modes.mjs        (prints the numbers to paste into modes.js)

import { realStreetlights, countyAt } from "../nationalData.js";
import { accidentsInBox, FLAGS, yearsSpan } from "../accidentIndex.js";
import { DEFAULT_CONFIG } from "../pedestrianSafety/scoring.js";
import { accidentDistanceWeight } from "../pedestrianSafety/routeAnalysis.js";

// The original walking threshold (80 / km² / yr, plain accident COUNT).
// Since 2026-10 the score uses a DISTANCE-WEIGHTED count, so the walking
// threshold itself is re-derived here too: the weighted-density value at the
// same percentile the old 80 sat at.
const ORIGINAL_WALK_ACC = 80;

const N = Number(process.env.N || 3000);
const WALK_R = 150;
const VEHICLE_R = 50;

// Small deterministic PRNG (mulberry32) so results are reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261001);

const taipeiLights = realStreetlights.filter(
  (p) => p.latitude > 24.95 && p.latitude < 25.22 && p.longitude > 121.45 && p.longitude < 121.67 &&
    countyAt(p.latitude, p.longitude) === "臺北市"
);
const samples = Array.from({ length: N }, () => taipeiLights[Math.floor(rand() * taipeiLights.length)]);

const M_PER_DEG_LAT = 111320;
function box(p, r) {
  const dLat = r / M_PER_DEG_LAT;
  const dLon = r / (M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180));
  return { minLat: p.latitude - dLat, maxLat: p.latitude + dLat, minLon: p.longitude - dLon, maxLon: p.longitude + dLon };
}
function within(p, q, r) {
  const dy = (q.latitude - p.latitude) * M_PER_DEG_LAT;
  const dx = (q.longitude - p.longitude) * M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180);
  return dx * dx + dy * dy <= r * r;
}
const areaKm2 = (r) => (Math.PI * r * r) / 1e6;

// Streetlight grid for fast neighbour counts.
const LGRID = new Map();
for (const p of taipeiLights) {
  const k = `${Math.floor(p.latitude * 500)},${Math.floor(p.longitude * 500)}`;
  if (!LGRID.has(k)) LGRID.set(k, []);
  LGRID.get(k).push(p);
}
function lightsWithin(p, r) {
  const b = box(p, r);
  let n = 0;
  for (let i = Math.floor(b.minLat * 500); i <= Math.floor(b.maxLat * 500); i++)
    for (let j = Math.floor(b.minLon * 500); j <= Math.floor(b.maxLon * 500); j++)
      for (const q of LGRID.get(`${i},${j}`) || []) if (within(p, q, r)) n++;
  return n;
}
const accWithin = (p, r, flag) => accidentsInBox(box(p, r), flag).filter((q) => within(p, q, r)).length;
function distM(p, q) {
  const dy = (q.latitude - p.latitude) * M_PER_DEG_LAT;
  const dx = (q.longitude - p.longitude) * M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
const accWeighted = (p, r, flag) =>
  accidentsInBox(box(p, r), flag).reduce((s, q) => s + accidentDistanceWeight(distM(p, q), r), 0);

const walkAcc = [], walkLight = [], scooterAcc = [], carAcc = [], vehLight = [];
const walkAccW = [], scooterAccW = [], carAccW = [];
for (const p of samples) {
  walkAcc.push(accWithin(p, WALK_R, FLAGS.pedestrian) / areaKm2(WALK_R) / yearsSpan);
  walkLight.push(lightsWithin(p, WALK_R) / areaKm2(WALK_R));
  scooterAcc.push(accWithin(p, VEHICLE_R, FLAGS.scooter) / areaKm2(VEHICLE_R) / yearsSpan);
  carAcc.push(accWithin(p, VEHICLE_R, FLAGS.car) / areaKm2(VEHICLE_R) / yearsSpan);
  vehLight.push(lightsWithin(p, VEHICLE_R) / areaKm2(VEHICLE_R));
  walkAccW.push(accWeighted(p, WALK_R, FLAGS.pedestrian) / areaKm2(WALK_R) / yearsSpan);
  scooterAccW.push(accWeighted(p, VEHICLE_R, FLAGS.scooter) / areaKm2(VEHICLE_R) / yearsSpan);
  carAccW.push(accWeighted(p, VEHICLE_R, FLAGS.car) / areaKm2(VEHICLE_R) / yearsSpan);
}

const share = (arr, x) => arr.filter((v) => v <= x).length / arr.length;
function quantile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const pos = Math.min(s.length - 1, Math.max(0, q * (s.length - 1)));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const pAcc = share(walkAcc, ORIGINAL_WALK_ACC);
const pLight = share(walkLight, DEFAULT_CONFIG.idealStreetlightDensity);
const result = {
  samples: N,
  taipeiRoadPointsAvailable: taipeiLights.length,
  weightedThresholds: {
    walk: Math.round(quantile(walkAccW, pAcc)),
    scooter: Math.round(quantile(scooterAccW, pAcc)),
    car: Math.round(quantile(carAccW, pAcc)),
  },
  walking: {
    originalAccidentThreshold: ORIGINAL_WALK_ACC,
    currentAccidentThreshold: DEFAULT_CONFIG.maxAcceptableAccidentDensity,
    shareOfRoadPointsAtOrBelow: +pAcc.toFixed(3),
    lightIdeal: DEFAULT_CONFIG.idealStreetlightDensity,
    lightShareAtOrBelow: +pLight.toFixed(3),
  },
  scooter: {
    maxAcceptableAccidentDensity: Math.round(quantile(scooterAcc, pAcc)),
    idealStreetlightDensity: Math.round(quantile(vehLight, pLight)),
  },
  car: {
    maxAcceptableAccidentDensity: Math.round(quantile(carAcc, pAcc)),
    idealStreetlightDensity: Math.round(quantile(vehLight, pLight)),
  },
  medians: {
    walkAcc: +quantile(walkAcc, 0.5).toFixed(1),
    scooterAcc: +quantile(scooterAcc, 0.5).toFixed(1),
    carAcc: +quantile(carAcc, 0.5).toFixed(1),
    walkLight: Math.round(quantile(walkLight, 0.5)),
    vehLight: Math.round(quantile(vehLight, 0.5)),
  },
};
console.log(JSON.stringify(result, null, 2));
