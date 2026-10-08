// modes.js
//
// 交通方式設定與「機車 / 開車」的安全評分。步行沿用原本 pedestrianSafety/
// 模組(完全沒改);機車、開車用同一套評分函式(事故分數、路燈分數),只是:
//   - 事故改成「有機車涉入」/「有汽車涉入」的事故(accidentsAllTaiwan.bin.gz)
//   - 緩衝半徑 50 m(車輛走在路面上,只看路線本身的事故;步行 150 m 含兩側人行道)
//   - 事故依距離加權(跟步行同一規則:內圈 = 緩衝半徑/5 內算 1 件,往外線性降到 0)
//   - 權重:事故 70% + 路燈 30%,不計便利商店(便利商店代表「路上有人看著」,
//     是步行安全的指標,對騎車開車意義不大)
//   - 門檻用 scripts/calibrate-modes.mjs 校正成跟步行「一樣嚴格」(在台北實際
//     道路點上取同一個百分位數),數字見下面 config 的註解
// 大眾運輸的評分在 transitPlanner.js:只評「走路去搭車 / 下車走到目的地」的步行段。

import {
  DEFAULT_CONFIG,
  WEIGHTS,
  calculatePedestrianAccidentScore,
  calculateStreetlightScore,
} from "./pedestrianSafety/scoring.js";
import { configForRadius } from "./pedestrianSafety/radiusThresholds.js";
import { buildAttribution } from "./pedestrianSafety/roadAttribution.js";
import { roadsNearRoute } from "./roadNetwork.js";
import { prepareRoute, countPointsNearRoute, findPointsNearRoute, calculateBufferAreaKm2, weightedCount } from "./pedestrianSafety/routeAnalysis.js";
import { accidentsInBox, FLAGS, yearsSpan, meta as accidentMeta, available as vehicleDataAvailable } from "./accidentIndex.js";
import { realStreetlights, applyCoverage, TAIWAN_COUNTIES } from "./nationalData.js";

export const MODES = {
  walk: {
    key: "walk",
    label: "步行",
    icon: "🚶",
    defaultBuffer: 150,
    weights: WEIGHTS, // 事故 40 / 路燈 30 / 便利商店 30(原專案規格)
    config: DEFAULT_CONFIG,
    accidentNoun: "行人事故",
  },
  scooter: {
    key: "scooter",
    label: "機車",
    icon: "🛵",
    defaultBuffer: 50,
    weights: { accident: 0.7, streetlight: 0.3, convenienceStore: 0 },
    // calibrate-modes.mjs(台北 3,000 / 6,000 / 12,000 個道路點):原本步行門檻
    // 80 件/km²/年(未加權)在第 98.9 百分位 → 機車「距離加權」事故密度同一
    // 百分位 ≈ 1,140(三次 1,186 / 1,095 / 1,136;未加權時是 2,300);路燈
    // 1,800 盞/km²(150 m)在第 81.8 百分位 → 50 m 緩衝的同一百分位 ≈ 2,550。
    config: { ...DEFAULT_CONFIG, maxAcceptableAccidentDensity: 1140, idealStreetlightDensity: 2550 },
    accidentFlag: FLAGS.scooter,
    accidentNoun: "機車事故",
  },
  car: {
    key: "car",
    label: "開車",
    icon: "🚗",
    defaultBuffer: 50,
    weights: { accident: 0.7, streetlight: 0.3, convenienceStore: 0 },
    // 同上方法:汽車「距離加權」事故密度第 98.9 百分位 ≈ 420(421 / 398 / 435;
    // 未加權時是 850)。
    config: { ...DEFAULT_CONFIG, maxAcceptableAccidentDensity: 420, idealStreetlightDensity: 2550 },
    accidentFlag: FLAGS.car,
    accidentNoun: "汽車事故",
  },
  transit: {
    key: "transit",
    label: "大眾運輸",
    icon: "🚇",
    defaultBuffer: 150,
    weights: WEIGHTS, // 只評步行段,所以跟步行一樣
    config: DEFAULT_CONFIG,
    accidentNoun: "行人事故",
  },
};

export function modeOf(key) {
  return MODES[key] || MODES.walk;
}

function routeBox(route, marginMeters) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of route) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const dLat = marginMeters / 111320;
  const dLon = marginMeters / (111320 * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

/** Mode accidents near a route (for detour search / hotspot detection). */
export function modeAccidentsNear(route, mode, marginMeters = 400) {
  return accidentsInBox(routeBox(route, marginMeters), mode.accidentFlag);
}

/**
 * Scooter / car score for one route. Same output shape as the walking
 * result (so the comparison + UI code is shared): pedestrianAccidents holds
 * the count of THIS mode's accidents.
 */
export function scoreVehicleRoute(route, modeKey, bufferRadius) {
  const mode = modeOf(modeKey);
  if (!vehicleDataAvailable) throw new Error("缺少 accidentsAllTaiwan.bin.gz,無法計算機車/開車的事故分數");
  const routeInfo = prepareRoute(route);
  // bufferRadius null = automatic: each accident / streetlight goes to its
  // nearest DRIVABLE road (pedestrianSafety/roadAttribution.js); falls back
  // to the mode's fixed buffer when the road network isn't available.
  const roads = bufferRadius == null ? roadsNearRoute(route) : null;
  const attribution = roads ? buildAttribution(routeInfo, roads, "vehicle") : null;
  const searchRadius = attribution ? attribution.maxRadius : bufferRadius ?? mode.defaultBuffer;
  const radius = attribution ? attribution.effectiveRadius : searchRadius;
  const keep = attribution ? (list) => list.filter((p) => attribution.keep(p)) : (list) => list;
  // Thresholds were calibrated at 50 m; scale them to the (effective) radius.
  const cfg = configForRadius(mode.config, radius, mode.key);
  const area =
    attribution && attribution.areaKm2 > 0
      ? attribution.areaKm2
      : calculateBufferAreaKm2(routeInfo.lengthMeters, radius, routeInfo);
  const box = routeBox(route, searchRadius + 100);
  const accidents = accidentsInBox(box, mode.accidentFlag);
  const lights = realStreetlights.filter(
    (p) => p.latitude >= box.minLat && p.latitude <= box.maxLat && p.longitude >= box.minLon && p.longitude <= box.maxLon
  );

  const nearAcc = keep(findPointsNearRoute(accidents, routeInfo, searchRadius));
  const nearLights = keep(findPointsNearRoute(lights, routeInfo, searchRadius));
  const nLights = nearLights.length;
  // Score uses the distance-weighted count (same rule as walking).
  const accWeighted = weightedCount(nearAcc, radius);
  const accidentScore = calculatePedestrianAccidentScore(accWeighted, area, yearsSpan, cfg);
  const streetlightScore = calculateStreetlightScore(nLights, area, cfg);
  const w = mode.weights;
  const final = (accidentScore * w.accident + streetlightScore * w.streetlight) / (w.accident + w.streetlight);

  const raw = {
    routeLengthMeters: Math.round(routeInfo.lengthMeters),
    bufferRadiusMeters: radius,
    bufferAreaKm2: Math.round(area * 1000) / 1000,
    attribution: attribution
      ? { method: "nearest-road", maxRadius: attribution.maxRadius, effectiveRadius: attribution.effectiveRadius }
      : { method: "fixed-buffer", radius },
    pedestrianAccidents: nearAcc.length,
    accidentWeightedCount: Math.round(accWeighted * 10) / 10,
    streetlights: nLights,
    convenienceStores: 0,
    accidentScore: Math.round(accidentScore * 10) / 10,
    streetlightScore: Math.round(streetlightScore * 10) / 10,
    convenienceStoreScore: null, // not used in this mode
    finalSafetyScore: Math.round(Math.max(0, Math.min(100, final)) * 10) / 10,
    accidentDataYearsSpan: Math.round(yearsSpan * 100) / 100,
    accidentDataDateRange: accidentMeta ? accidentMeta.dateRange : null,
    nearbyAccidentPoints: nearAcc.slice(0, 40),
    nearbyStreetlightPoints: nearLights.slice(0, 40),
    nearbyStorePoints: [],
    mode: mode.key,
    scoringThresholds: {
      maxAcceptableAccidentDensity: Math.round(cfg.maxAcceptableAccidentDensity),
      idealStreetlightDensity: Math.round(cfg.idealStreetlightDensity),
    },
  };
  const result = applyCoverage(raw, route, {
    weights: mode.weights,
    config: cfg,
    accidentCoverage: TAIWAN_COUNTIES,
  });

  const mapLayers = {
    routeGeometry: route.map((p) => [p.lat, p.lon]),
    accidents: nearAcc.map((a) => ({
      latitude: a.latitude,
      longitude: a.longitude,
      date: a.date,
      location: `涉入:${a.involved}`,
      severity: a.severity,
      distanceMeters: a.distanceMeters,
    })),
    stores: [],
    streetlights: nearLights.map((l) => [l.latitude, l.longitude, l.distanceMeters]),
  };
  return { result, mapLayers };
}
