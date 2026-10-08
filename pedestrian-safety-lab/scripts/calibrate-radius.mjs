// scripts/calibrate-radius.mjs
//
// Why: every score is a DENSITY (things per km² of buffer). Accidents,
// streetlights and stores all sit ON roads, so the narrower the buffer, the
// larger the share of it that is road and the higher every density gets.
// A fixed threshold calibrated at 150 m (walking) / 50 m (vehicles) therefore
// saturates at small radii (30 m: accident score 0 on almost any street) and
// is too lenient at large ones.
//
// Fix: the same percentile matching calibrate-modes.mjs uses, repeated at
// several radii. At each radius the threshold is the density at the SAME
// percentile of Taipei road points that the reference threshold sits at in
// its reference radius. modes.js / scoring.js interpolate between radii.
//
// Run:  node scripts/calibrate-radius.mjs      (N=6000 node ... for more samples)

import { realStreetlights, realConvenienceStores, countyAt } from "../nationalData.js";
import { accidentsInBox, FLAGS, yearsSpan } from "../accidentIndex.js";
import { accidentDistanceWeight } from "../pedestrianSafety/routeAnalysis.js";

const N = Number(process.env.N || 4000);
const RADII = [20, 30, 50, 75, 100, 150, 200, 300];
// Reference points: walking 150 m (38 weighted accidents, 1,800 lights,
// 90 stores per km²), vehicles 50 m (scooter 1,140 / car 420 accidents, 2,550 lights).
const REF = { walkR: 150, walkAcc: 38, walkLight: 1800, walkStore: 90, vehR: 50, scooterAcc: 1140, carAcc: 420, vehLight: 2550 };

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261006);
const inTaipei = (p) => p.latitude > 24.95 && p.latitude < 25.22 && p.longitude > 121.45 && p.longitude < 121.67 &&
  countyAt(p.latitude, p.longitude) === "臺北市";
const lights = realStreetlights.filter(inTaipei);
const stores = realConvenienceStores.filter(inTaipei);
const samples = Array.from({ length: N }, () => lights[Math.floor(rand() * lights.length)]);

const M = 111320;
const box = (p, r) => {
  const dLat = r / M, dLon = r / (M * Math.cos((p.latitude * Math.PI) / 180));
  return { minLat: p.latitude - dLat, maxLat: p.latitude + dLat, minLon: p.longitude - dLon, maxLon: p.longitude + dLon };
};
const dist = (p, q) => Math.hypot((q.latitude - p.latitude) * M, (q.longitude - p.longitude) * M * Math.cos((p.latitude * Math.PI) / 180));
function grid(points) {
  const g = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.latitude * 300)},${Math.floor(p.longitude * 300)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p);
  }
  return (p, r) => {
    const b = box(p, r); const out = [];
    for (let i = Math.floor(b.minLat * 300); i <= Math.floor(b.maxLat * 300); i++)
      for (let j = Math.floor(b.minLon * 300); j <= Math.floor(b.maxLon * 300); j++)
        for (const q of g.get(`${i},${j}`) || []) out.push(q);
    return out;
  };
}
const lightsNear = grid(lights), storesNear = grid(stores);
const area = (r) => (Math.PI * r * r) / 1e6;
const countIn = (list, p, r) => list.filter((q) => dist(p, q) <= r).length;
const weighted = (p, r, flag) => accidentsInBox(box(p, r), flag).reduce((s, q) => s + accidentDistanceWeight(dist(p, q), r), 0);

function quantile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const pos = Math.min(s.length - 1, Math.max(0, q * (s.length - 1)));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const share = (arr, x) => arr.filter((v) => v <= x).length / arr.length;

const m = {};
const RS = [...new Set([...RADII, REF.walkR, REF.vehR])];
for (const r of RS) {
  m[r] = { wAcc: [], sAcc: [], cAcc: [], light: [], store: [] };
  const big = Math.max(r, 1);
  for (const p of samples) {
    m[r].wAcc.push(weighted(p, r, FLAGS.pedestrian) / area(r) / yearsSpan);
    m[r].sAcc.push(weighted(p, r, FLAGS.scooter) / area(r) / yearsSpan);
    m[r].cAcc.push(weighted(p, r, FLAGS.car) / area(r) / yearsSpan);
    m[r].light.push(countIn(lightsNear(p, big), p, r) / area(r));
    m[r].store.push(countIn(storesNear(p, big), p, r) / area(r));
  }
}
const pWAcc = share(m[REF.walkR].wAcc, REF.walkAcc);
const pWLight = share(m[REF.walkR].light, REF.walkLight);
const pWStore = share(m[REF.walkR].store, REF.walkStore);
const pSAcc = share(m[REF.vehR].sAcc, REF.scooterAcc);
const pCAcc = share(m[REF.vehR].cAcc, REF.carAcc);
const pVLight = share(m[REF.vehR].light, REF.vehLight);

const table = { walk: {}, scooter: {}, car: {} };
for (const r of RADII) {
  table.walk[r] = { acc: Math.round(quantile(m[r].wAcc, pWAcc)), light: Math.round(quantile(m[r].light, pWLight)), store: Math.round(quantile(m[r].store, pWStore)) };
  table.scooter[r] = { acc: Math.round(quantile(m[r].sAcc, pSAcc)), light: Math.round(quantile(m[r].light, pVLight)) };
  table.car[r] = { acc: Math.round(quantile(m[r].cAcc, pCAcc)), light: Math.round(quantile(m[r].light, pVLight)) };
}
console.log(JSON.stringify({ samples: N, percentiles: { pWAcc, pWLight, pWStore, pSAcc, pCAcc, pVLight }, table }, null, 1));
