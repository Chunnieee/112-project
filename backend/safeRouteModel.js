// =========================================================
// safeRouteModel.js  —  安全模式 Safety Mode
// ---------------------------------------------------------
// Safety score of a route (0–100, higher = safer):
//
//   Safety = 路燈分數 × 30%  +  便利商店分數 × 30%  +  事故分數 × 40%
//
//   路燈分數 Light score
//     = % of the route that has a streetlight within LIGHT_RADIUS_M
//
//   便利商店分數 Store score
//     = % of the route that has a convenience store within STORE_RADIUS_M
//
//   事故分數 Accident score
//     = 100 when there are no accidents near the route,
//       goes down to 0 when accidents per km reach ACCIDENTS_PER_KM_FOR_ZERO
//       (A1 death accidents count 3×, A2 injury accidents count 1×)
//
// All numbers come from your TablePlus database (safetyDatabase.js).
// =========================================================

import {
  closeSafetyDb,
  loadSafetyIndex,
  hasCoverageAt,
  queryStreetlights,
  queryStores,
  queryAccidents,
} from "./safetyDatabase.js";

// ---------------------------------------------------------
// SETTINGS (you can tune these)
// ---------------------------------------------------------

export const SAFETY_WEIGHTS = {
  light: 0.3, // 路燈 30%
  store: 0.3, // 便利商店 30%
  accident: 0.4, // 事故 40%
};

const SAMPLE_STEP_M = 20; // check the route every 20 m
const LIGHT_RADIUS_M = 30; // a point is "lit" if a lamp is within 30 m
const STORE_RADIUS_M = 200; // a store within 200 m (≈ 2–3 min walk)
const ACCIDENT_BUFFER_M = 30; // accidents within 30 m of the route count
const ACCIDENT_WEIGHT = { A1: 3, A2: 1 };
const ACCIDENTS_PER_KM_FOR_ZERO = 6; // 6 weighted accidents/km → score 0
const MIN_LENGTH_KM = 0.2; // avoid huge per-km numbers on tiny routes

const GRID_CELL_DEG = 0.001; // ≈ 100 m grid for fast searching

// ---------------------------------------------------------
// GEOMETRY HELPERS
// ---------------------------------------------------------

const M_PER_DEG_LAT = 111320;

function distanceM(lat1, lon1, lat2, lon2) {
  // Accurate enough for short distances inside a city.
  const x =
    (lon2 - lon1) *
    M_PER_DEG_LAT *
    Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(x * x + y * y);
}

function insideBounds(lat, lon, b, marginM = 100) {
  if (!b) return false;
  const dLat = marginM / M_PER_DEG_LAT;
  const dLon = marginM / (M_PER_DEG_LAT * Math.cos(lat * (Math.PI / 180)));
  return (
    lat >= b.minLat - dLat &&
    lat <= b.maxLat + dLat &&
    lon >= b.minLon - dLon &&
    lon <= b.maxLon + dLon
  );
}

// Turn the route line into points every SAMPLE_STEP_M metres.
// coords are GeoJSON style: [[lon, lat], [lon, lat], ...]
function samplePoints(coords, stepM = SAMPLE_STEP_M) {
  const points = [];
  let totalM = 0;

  if (!Array.isArray(coords) || coords.length === 0) {
    return { points, lengthM: 0 };
  }

  points.push({ lat: Number(coords[0][1]), lon: Number(coords[0][0]) });

  for (let i = 1; i < coords.length; i++) {
    const lat1 = Number(coords[i - 1][1]);
    const lon1 = Number(coords[i - 1][0]);
    const lat2 = Number(coords[i][1]);
    const lon2 = Number(coords[i][0]);

    const segM = distanceM(lat1, lon1, lat2, lon2);
    totalM += segM;

    const pieces = Math.max(1, Math.ceil(segM / stepM));
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      points.push({
        lat: lat1 + (lat2 - lat1) * t,
        lon: lon1 + (lon2 - lon1) * t,
      });
    }
  }

  return { points, lengthM: totalM };
}

// ---------------------------------------------------------
// GRID INDEX — finds nearby points quickly
// (98,000 streetlights would be too slow to check one by one)
// ---------------------------------------------------------

class GridIndex {
  constructor(items, cellDeg = GRID_CELL_DEG) {
    this.cellDeg = cellDeg;
    this.cells = new Map();

    for (const item of items) {
      const key = this.key(
        Math.floor(item.lat / cellDeg),
        Math.floor(item.lon / cellDeg)
      );
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(item);
    }
  }

  key(i, j) {
    return i + ":" + j;
  }

  // Calls onFound(item, distance) for every item within radiusM.
  forEachNear(lat, lon, radiusM, onFound) {
    const dLat = radiusM / M_PER_DEG_LAT;
    const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(lat * (Math.PI / 180)));

    const iMin = Math.floor((lat - dLat) / this.cellDeg);
    const iMax = Math.floor((lat + dLat) / this.cellDeg);
    const jMin = Math.floor((lon - dLon) / this.cellDeg);
    const jMax = Math.floor((lon + dLon) / this.cellDeg);

    for (let i = iMin; i <= iMax; i++) {
      for (let j = jMin; j <= jMax; j++) {
        const cell = this.cells.get(this.key(i, j));
        if (!cell) continue;
        for (const item of cell) {
          const d = distanceM(lat, lon, item.lat, item.lon);
          if (d <= radiusM) onFound(item, d);
        }
      }
    }
  }
}

// ---------------------------------------------------------
// LOAD DATA (once, when the server starts)
// ---------------------------------------------------------

let safetyIndex = null;
let loadError = null;

export function initSafetyModel() {
  try {
    closeSafetyDb(); // so /api/safety/reload picks up a rebuilt database
    safetyIndex = loadSafetyIndex();
    loadError = null;

    console.log(
      `Safety DB loaded: ${safetyIndex.counts.streetlights} streetlights, ` +
        `${safetyIndex.counts.stores} stores, ` +
        `${safetyIndex.counts.accidents} accidents ` +
        `(tables: ${safetyIndex.tables.streetlights}/` +
        `${safetyIndex.tables.stores}/${safetyIndex.tables.accidents})`
    );
    console.log(
      `Safety coverage: ${safetyIndex.coverage.streetlights.size} light cells, ` +
        `${safetyIndex.coverage.stores.size} store cells, ` +
        `${safetyIndex.coverage.accidents.size} accident cells (~1 km each)`
    );
  } catch (error) {
    loadError = error;
    safetyIndex = null;
    console.error("Safety DB load failed:", error.message);
  }
}

// Rows are no longer held in memory, so each route loads just the
// box it needs and indexes that. A 5 km route pulls a few thousand
// rows instead of 1.9 million.
function loadRegion(points, marginM) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const midLat = (minLat + maxLat) / 2;
  const dLat = marginM / M_PER_DEG_LAT;
  const dLon = marginM / (M_PER_DEG_LAT * Math.cos(midLat * (Math.PI / 180)));

  const box = {
    minLat: minLat - dLat,
    maxLat: maxLat + dLat,
    minLon: minLon - dLon,
    maxLon: maxLon + dLon,
  };

  const streetlights = queryStreetlights(box);
  const stores = queryStores(box);
  const accidents = queryAccidents(box);

  streetlights.forEach((p, i) => (p.idx = i));
  stores.forEach((p, i) => (p.idx = i));
  accidents.forEach((p, i) => (p.idx = i));

  return {
    box,
    streetlights,
    stores,
    accidents,
    indexes: {
      streetlights: new GridIndex(streetlights),
      stores: new GridIndex(stores),
      accidents: new GridIndex(accidents),
    },
  };
}

function requireData() {
  if (!safetyIndex) {
    const err = new Error(
      "安全資料庫尚未載入 (safety database not loaded): " +
        (loadError?.message || "unknown error")
    );
    err.status = 503;
    throw err;
  }
}

// ---------------------------------------------------------
// SCORE ONE ROUTE
// ---------------------------------------------------------

function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function safetyLevel(score) {
  if (score >= 75) return { level: "safe", label: "安全", color: "#1f9d6b" };
  if (score >= 50) return { level: "medium", label: "普通", color: "#c98209" };
  return { level: "caution", label: "注意", color: "#d64545" };
}

export function scoreRouteSafety(geometry) {
  requireData();

  const coords = geometry?.coordinates || geometry;
  const { points, lengthM } = samplePoints(coords);

  if (points.length < 2) {
    throw new Error("Route geometry needs at least 2 points");
  }

  const lengthKm = lengthM / 1000;

  // Pull only the rows around this route, then index them.
  const region = loadRegion(points, Math.max(STORE_RADIUS_M, LIGHT_RADIUS_M) + 50);
  const indexes = region.indexes;
  const lightCoverageCells = safetyIndex.coverage.streetlights;
  const storeCoverageCells = safetyIndex.coverage.stores;

  // --- 路燈 streetlights ---
  let lightCheckedPoints = 0; // points where we HAVE streetlight data
  let litPoints = 0;
  const lampsNearRoute = new Set();
  const darkSegments = [];
  let currentDark = null;

  // --- 便利商店 stores ---
  let storeCheckedPoints = 0; // points where we HAVE store data
  let storeCoveredPoints = 0;
  const storesNearRoute = new Map(); // idx -> {store, distance}

  // --- 事故 accidents ---
  const accidentsNearRoute = new Map(); // idx -> {accident, distance}

  let pointsInCity = 0;

  for (const p of points) {
    const hasStoreData = hasCoverageAt(storeCoverageCells, p.lat, p.lon);
    if (hasStoreData) {
      pointsInCity++;
      storeCheckedPoints++;
    }

    // Streetlights (only where the streetlight table has data)
    if (hasCoverageAt(lightCoverageCells, p.lat, p.lon)) {
      lightCheckedPoints++;
      let lit = false;
      indexes.streetlights.forEachNear(p.lat, p.lon, LIGHT_RADIUS_M, (lamp) => {
        lit = true;
        lampsNearRoute.add(lamp.idx);
      });

      if (lit) {
        litPoints++;
        if (currentDark && currentDark.length >= 2) darkSegments.push(currentDark);
        currentDark = null;
      } else {
        if (!currentDark) currentDark = [];
        currentDark.push([round(p.lat, 6), round(p.lon, 6)]);
      }
    } else if (currentDark) {
      if (currentDark.length >= 2) darkSegments.push(currentDark);
      currentDark = null;
    }

    // Convenience stores
    let hasStore = false;
    indexes.stores.forEachNear(p.lat, p.lon, STORE_RADIUS_M, (store, d) => {
      hasStore = true;
      const old = storesNearRoute.get(store.idx);
      if (!old || d < old.distance) {
        storesNearRoute.set(store.idx, { store, distance: d });
      }
    });
    if (hasStore) storeCoveredPoints++;

    // Accidents
    indexes.accidents.forEachNear(p.lat, p.lon, ACCIDENT_BUFFER_M, (acc, d) => {
      const old = accidentsNearRoute.get(acc.idx);
      if (!old || d < old.distance) {
        accidentsNearRoute.set(acc.idx, { accident: acc, distance: d });
      }
    });
  }
  if (currentDark && currentDark.length >= 2) darkSegments.push(currentDark);

  // ---------- Scores (0–100) ----------

  const lightCoverage = lightCheckedPoints / points.length;
  const lightScore =
    lightCheckedPoints > 0 ? (litPoints / lightCheckedPoints) * 100 : null;

  const storeScore =
    storeCheckedPoints > 0
      ? (storeCoveredPoints / storeCheckedPoints) * 100
      : null;

  let weightedAccidents = 0;
  let a1Count = 0;
  let a2Count = 0;
  for (const { accident } of accidentsNearRoute.values()) {
    const cat = String(accident.category || "").toUpperCase();
    if (cat === "A1") a1Count++;
    else a2Count++;
    weightedAccidents += ACCIDENT_WEIGHT[cat] ?? 1;
  }
  const accidentsPerKm = weightedAccidents / Math.max(lengthKm, MIN_LENGTH_KM);
  const accidentScore =
    100 * Math.max(0, 1 - accidentsPerKm / ACCIDENTS_PER_KM_FOR_ZERO);

  // ---------- Final weighted score ----------
  // If a route is completely outside the streetlight data area,
  // we cannot judge lighting, so we split its 30% over the other two
  // (and tell the user with lightDataAvailable = false).
  let safetyScore;
  let usedWeights;

  // Only score what we actually have data for, and spread the missing
  // weight over the rest. Otherwise a city with no streetlight or no
  // store table would always look dangerous.
  const parts = [
    { key: "light", score: lightScore, weight: SAFETY_WEIGHTS.light },
    { key: "store", score: storeScore, weight: SAFETY_WEIGHTS.store },
    { key: "accident", score: accidentScore, weight: SAFETY_WEIGHTS.accident },
  ];

  const usable = parts.filter((p) => p.score !== null);
  const totalWeight = usable.reduce((sum, p) => sum + p.weight, 0);

  usedWeights = { light: 0, store: 0, accident: 0 };
  for (const part of usable) {
    usedWeights[part.key] = part.weight / totalWeight;
  }

  safetyScore = usable.reduce(
    (sum, p) => sum + p.score * usedWeights[p.key],
    0
  );

  const warnings = [];

  // With nothing but the accident table available, an empty countryside
  // road scores 100 simply because no one has crashed on it. Say so.
  if (usable.length <= 1) {
    warnings.push("這個區域的安全資料很少，分數僅供參考。");
  }
  if (lightScore === null) {
    warnings.push("這條路線不在路燈資料範圍內，路燈分數無法計算。");
  } else if (lightCoverage < 0.8) {
    warnings.push(
      `只有 ${Math.round(lightCoverage * 100)}% 的路段有路燈資料，路燈分數只根據這部分計算。`
    );
  }
  if (storeScore === null) {
    warnings.push("這條路線不在便利商店資料範圍內，便利商店分數無法計算。");
  } else if (storeCheckedPoints / points.length < 0.8) {
    warnings.push(
      `只有 ${Math.round((storeCheckedPoints / points.length) * 100)}% 的路段有便利商店資料。`
    );
  }

  const stores = [...storesNearRoute.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 60)
    .map(({ store, distance }) => ({
      lat: store.lat,
      lon: store.lon,
      type: store.type,
      name: store.name,
      address: store.address,
      distanceM: Math.round(distance),
    }));

  const accidents = [...accidentsNearRoute.values()]
    .slice(0, 150)
    .map(({ accident }) => ({
      lat: accident.lat,
      lon: accident.lon,
      date: accident.date,
      time: accident.time,
      location: accident.location,
      category: accident.category,
      severity:
        accident.severity ??
        (accident.dead > 0
          ? `死亡${accident.dead};受傷${accident.injured ?? 0}`
          : `受傷${accident.injured ?? 0}`),
    }));

  const finalScore = round(safetyScore, 1);

  return {
    safetyScore: finalScore,
    ...safetyLevel(finalScore),

    breakdown: {
      light: {
        score: lightScore === null ? null : round(lightScore, 1),
        weight: usedWeights.light,
        litRatio: lightScore === null ? null : round(lightScore / 100, 3),
        lampsNearRoute: lampsNearRoute.size,
        dataCoverageRatio: round(lightCoverage, 3),
      },
      store: {
        score: storeScore === null ? null : round(storeScore, 1),
        weight: usedWeights.store,
        storesNearRoute: storesNearRoute.size,
        radiusM: STORE_RADIUS_M,
      },
      accident: {
        score: round(accidentScore, 1),
        weight: usedWeights.accident,
        count: accidentsNearRoute.size,
        a1Count,
        a2Count,
        weightedPerKm: round(accidentsPerKm, 2),
      },
    },

    lengthKm: round(lengthKm, 2),
    lightDataAvailable: lightScore !== null,
    storeDataAvailable: storeScore !== null,
    dataComponentsUsed: usable.length,
    warnings,

    // For drawing on the map
    darkSegments: darkSegments.slice(0, 200),
    stores,
    accidents,
  };
}

// ---------------------------------------------------------
// OSRM (get candidate routes)
// ---------------------------------------------------------
//
// WHY THIS MATTERS:
// The public OSRM server (router.project-osrm.org) only has a CAR
// profile. Even if you ask for "/foot/", it silently returns a CAR
// route with CAR time. That is why walking looked as fast as driving
// (台北車站 → 西門町 "2 minutes").
//
// Fix:
//   walk  → use a real walking router (routing.openstreetmap.de/routed-foot)
//           and ALWAYS compute time = distance ÷ 4.8 km/h
//           (same walking speed your teammate uses in multimodal mode)
//   drive → use OSRM car route and OSRM car time
// ---------------------------------------------------------

export const WALKING_SPEED_KMH = 4.8;

const FOOT_ROUTER_URL =
  process.env.SAFETY_FOOT_ROUTER_URL ||
  "https://routing.openstreetmap.de/routed-foot";

async function requestOsrm(fetchWithTimeout, baseUrl, profile, coordList, alternatives = true) {
  // coordList: [[lon, lat], [lon, lat], ...]
  const coordText = coordList.map((c) => `${c[0]},${c[1]}`).join(";");
  const attempts = alternatives ? ["3", "true"] : ["false"];
  let lastError = null;

  for (const alt of attempts) {
    try {
      const url =
        `${baseUrl}/route/v1/${profile}/${coordText}` +
        `?overview=full&geometries=geojson&steps=false&alternatives=${alt}`;

      const response = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": "112-project-safety-mode/1.0" } },
        10000
      );
      const data = await response.json();

      if (data.code === "Ok" && Array.isArray(data.routes) && data.routes.length) {
        return data.routes;
      }
      lastError = new Error(data.message || data.code || "OSRM returned no route");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("OSRM failed");
}

// ---------------------------------------------------------
// EXTRA ALTERNATIVES
// OSRM often returns only 1 route for short trips. To give the user
// real choices, we also ask for routes that pass a point slightly to
// the left / right of the straight line, then remove duplicates and
// routes that make a big detour.
// ---------------------------------------------------------

const MAX_ROUTES = 4;
const MAX_DETOUR_RATIO = 1.5; // drop routes longer than 1.5 × the shortest
const DUPLICATE_OVERLAP = 0.8; // 80% the same road → duplicate
const CELL = 0.0003; // ≈ 30 m

function cellKey(p) {
  return Math.floor(p.lat / CELL) + ":" + Math.floor(p.lon / CELL);
}

function viaPoints(sLon, sLat, eLon, eLat) {
  const midLat = (sLat + eLat) / 2;
  const midLon = (sLon + eLon) / 2;
  const cosLat = Math.cos(midLat * (Math.PI / 180));

  const dx = (eLon - sLon) * M_PER_DEG_LAT * cosLat;
  const dy = (eLat - sLat) * M_PER_DEG_LAT;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 300) return []; // too short for alternatives

  const px = -dy / len; // perpendicular direction
  const py = dx / len;
  const offset = Math.min(1200, Math.max(150, len * 0.22));

  return [1, -1].map((side) => [
    midLon + (px * offset * side) / (M_PER_DEG_LAT * cosLat),
    midLat + (py * offset * side) / M_PER_DEG_LAT,
  ]);
}

function overlapRatio(routeA, routeB) {
  const setA = new Set(samplePoints(routeA.geometry.coordinates, 25).points.map(cellKey));
  const b = samplePoints(routeB.geometry.coordinates, 25).points;
  const same = b.filter((p) => setA.has(cellKey(p))).length;
  return b.length ? same / b.length : 1;
}

// A via-route can walk to the via point and come back the same way.
function hasBacktrack(route) {
  const pts = samplePoints(route.geometry.coordinates, 25).points;
  const firstSeen = new Map();
  let repeats = 0;
  pts.forEach((p, i) => {
    const key = cellKey(p);
    if (firstSeen.has(key) && i - firstSeen.get(key) > 6) repeats++;
    if (!firstSeen.has(key)) firstSeen.set(key, i);
  });
  return repeats / Math.max(1, pts.length) > 0.12;
}

function pickDistinctRoutes(routes) {
  if (!routes.length) return [];
  const shortest = Math.min(...routes.map((r) => r.distance));
  const kept = [];

  for (const r of [...routes].sort((a, b) => a.distance - b.distance)) {
    if (r.distance > shortest * MAX_DETOUR_RATIO) continue;
    if (kept.length && hasBacktrack(r)) continue;
    if (kept.some((k) => overlapRatio(k, r) > DUPLICATE_OVERLAP)) continue;
    kept.push(r);
    if (kept.length >= MAX_ROUTES) break;
  }
  return kept;
}

async function collectRoutes(fetchWithTimeout, baseUrl, profile, sLon, sLat, eLon, eLat) {
  const main = await requestOsrm(
    fetchWithTimeout, baseUrl, profile, [[sLon, sLat], [eLon, eLat]], true
  );

  const viaResults = await Promise.allSettled(
    viaPoints(sLon, sLat, eLon, eLat).map((via) =>
      requestOsrm(fetchWithTimeout, baseUrl, profile, [[sLon, sLat], via, [eLon, eLat]], false)
    )
  );

  const extra = viaResults
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value[0])
    .filter(Boolean);

  return pickDistinctRoutes([...main, ...extra]);
}

async function getCandidateRoutes({ travelMode, osrmBaseUrl, fetchWithTimeout, sLon, sLat, eLon, eLat }) {
  if (travelMode === "drive") {
    const routes = await collectRoutes(fetchWithTimeout, osrmBaseUrl, "driving", sLon, sLat, eLon, eLat);
    return {
      routes: routes.map((r) => ({
        ...r,
        durationMin: r.duration / 60,
      })),
      routeSource: "OSRM driving",
      timeSource: "OSRM 開車估計（自由車流，未含紅綠燈與塞車）",
    };
  }

  // WALK: try the real walking router first
  const walkTime = (distanceM) => (distanceM / 1000 / WALKING_SPEED_KMH) * 60;

  try {
    // Note: this server uses "driving" in the URL but it IS the foot profile.
    const routes = await collectRoutes(fetchWithTimeout, FOOT_ROUTER_URL, "driving", sLon, sLat, eLon, eLat);
    return {
      routes: routes.map((r) => ({ ...r, durationMin: walkTime(r.distance) })),
      routeSource: "OSRM foot (routing.openstreetmap.de)",
      timeSource: `步行距離 ÷ ${WALKING_SPEED_KMH} km/h`,
    };
  } catch (error) {
    console.warn("Foot router failed, falling back to OSRM_BASE_URL:", error.message);
  }

  // Fallback: road geometry from your OSRM, but time is still WALKING time
  const routes = await collectRoutes(fetchWithTimeout, osrmBaseUrl, "foot", sLon, sLat, eLon, eLat);
  return {
    routes: routes.map((r) => ({ ...r, durationMin: walkTime(r.distance) })),
    routeSource: "OSRM_BASE_URL (可能是汽車道路形狀)",
    timeSource: `步行距離 ÷ ${WALKING_SPEED_KMH} km/h`,
  };
}

// ---------------------------------------------------------
// RECOMMENDATION (safety + time + distance)
// ---------------------------------------------------------
//
//   推薦分數 = 安全分數 × 50% + 時間分數 × 30% + 距離分數 × 20%
//
//   時間分數 = 最快路線的時間 ÷ 這條路線的時間 × 100
//   距離分數 = 最短路線的距離 ÷ 這條路線的距離 × 100
//
// So the fastest route gets 100 for time, a route that takes
// twice as long gets 50.
// ---------------------------------------------------------

export const RECOMMEND_WEIGHTS = {
  safety: 0.5,
  time: 0.3,
  distance: 0.2,
};

function recommendReason(best, fastest, safest) {
  const extraMin = best.durationMin - fastest.durationMin;
  const isFastest = best.routeId === fastest.routeId;
  const isSafest = best.routeId === safest.routeId;

  if (isFastest && isSafest) return "最快，也最安全";
  if (isSafest && extraMin > 0) return `比最快路線多 ${extraMin} 分鐘，但更安全`;
  if (isSafest) return "時間差不多，但更安全";
  if (
    isFastest &&
    (safest.safety.label !== best.safety.label ||
      safest.safety.safetyScore - best.safety.safetyScore >= 10)
  ) {
    const moreMin = safest.durationMin - best.durationMin;
    return `最快；最安全的路線要多 ${moreMin} 分鐘`;
  }
  if (isFastest) return "最快，安全程度也不錯";
  return "時間、距離與安全最平衡";
}

function buildRecommendation(scored) {
  const fastestMin = Math.min(...scored.map((r) => r.durationMin));
  const shortestKm = Math.min(...scored.map((r) => r.distanceKm));

  for (const r of scored) {
    r.timeScore = round((fastestMin / r.durationMin) * 100, 1);
    r.distanceScore = round((shortestKm / r.distanceKm) * 100, 1);
    r.recommendScore = round(
      r.safety.safetyScore * RECOMMEND_WEIGHTS.safety +
        r.timeScore * RECOMMEND_WEIGHTS.time +
        r.distanceScore * RECOMMEND_WEIGHTS.distance,
      1
    );
    r.extraMin = r.durationMin - fastestMin;
    r.extraDistanceKm = round(r.distanceKm - shortestKm, 2);
  }

  // Best recommendation first.
  // If two routes are almost tied (less than 1 point), the safer one wins.
  scored.sort((a, b) => {
    const diff = b.recommendScore - a.recommendScore;
    if (Math.abs(diff) < 1) return b.safety.safetyScore - a.safety.safetyScore;
    return diff;
  });

  const fastest = [...scored].sort(
    (a, b) => a.durationMin - b.durationMin || b.safety.safetyScore - a.safety.safetyScore
  )[0];
  const safest = [...scored].sort(
    (a, b) => b.safety.safetyScore - a.safety.safetyScore || a.durationMin - b.durationMin
  )[0];

  const routes = scored.map((r, i) => {
    const tags = [];
    if (i === 0) tags.push("推薦");
    if (scored.length > 1 && r.routeId === fastest.routeId) tags.push("最快");
    if (scored.length > 1 && r.routeId === safest.routeId) tags.push("最安全");

    return {
      ...r,
      label: `路線 ${String.fromCharCode(65 + i)}`,
      isRecommended: i === 0,
      tags,
    };
  });

  const best = routes[0];
  return {
    routes,
    recommendation: {
      routeId: best.routeId,
      label: best.label,
      reason: recommendReason(best, fastest, safest),
      durationMin: best.durationMin,
      distanceKm: best.distanceKm,
      safetyScore: best.safety.safetyScore,
      safetyLabel: best.safety.label,
      recommendScore: best.recommendScore,
    },
  };
}

// ---------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------

export function registerSafetyRoutes(app, { osrmBaseUrl, fetchWithTimeout }) {
  initSafetyModel();

  // Check that the database is connected
  app.get("/api/safety/status", (req, res) => {
    res.json({
      loaded: !!safetyIndex,
      error: loadError?.message || null,
      counts: safetyIndex?.counts || null,
      tables: safetyIndex?.tables || null,
      coverageCells: safetyIndex
        ? {
            streetlights: safetyIndex.coverage.streetlights.size,
            stores: safetyIndex.coverage.stores.size,
            accidents: safetyIndex.coverage.accidents.size,
            cellDeg: safetyIndex.cellDeg,
          }
        : null,
      weights: SAFETY_WEIGHTS,
      loadedAt: safetyIndex?.loadedAt || null,
    });
  });

  // Reload after you change data in TablePlus
  app.get("/api/safety/reload", (req, res) => {
    initSafetyModel();
    res.json({ reloaded: !!safetyIndex, error: loadError?.message || null });
  });

  // Score any route you already have (e.g. from the risk mode)
  // body: { geometry: { type: "LineString", coordinates: [[lon,lat],...] } }
  app.post("/api/safety/score", (req, res) => {
    try {
      res.json(scoreRouteSafety(req.body?.geometry));
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message });
    }
  });

  // 安全模式：get routes and sort them by safety
  app.get("/api/safety-route", async (req, res) => {
    try {
      requireData();

      const sLon = Number(req.query.startLon);
      const sLat = Number(req.query.startLat);
      const eLon = Number(req.query.endLon);
      const eLat = Number(req.query.endLat);

      if (![sLon, sLat, eLon, eLat].every(Number.isFinite)) {
        return res.status(400).json({
          error: "Missing or invalid startLon, startLat, endLon, endLat",
        });
      }

      // walk (default) or drive
      const travelMode = req.query.mode === "drive" ? "drive" : "walk";

      const { routes: osrmRoutes, routeSource, timeSource } = await getCandidateRoutes({
        travelMode,
        osrmBaseUrl,
        fetchWithTimeout,
        sLon,
        sLat,
        eLon,
        eLat,
      });

      const scored = osrmRoutes.map((route, i) => ({
        routeId: `safety-${i}`,
        geometry: route.geometry,
        distanceKm: round(route.distance / 1000, 2),
        durationMin: Math.max(1, Math.round(route.durationMin)),
        safety: scoreRouteSafety(route.geometry),
      }));

      const result = buildRecommendation(scored);

      res.json({
        mode: "safety",
        travelMode,
        travelModeLabel: travelMode === "drive" ? "開車" : "步行",
        routeSource,
        timeSource,
        safetyWeights: SAFETY_WEIGHTS,
        recommendWeights: RECOMMEND_WEIGHTS,
        safetyFormula: "安全分數 = 路燈 30% + 便利商店 30% + 事故 40%",
        recommendFormula: "推薦分數 = 安全 50% + 時間 30% + 距離 20%",
        routes: result.routes,
        recommendation: result.recommendation,
      });
    } catch (error) {
      console.error("Safety route error:", error);
      res.status(error.status || 500).json({
        error: "Safety route error",
        detail: error.message,
      });
    }
  });
}