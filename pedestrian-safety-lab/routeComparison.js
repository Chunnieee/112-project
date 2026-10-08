// routeComparison.js
//
// 多路線比較:對同一組起終點產生最多 3 條「真的不一樣」的步行路線,每條都用
// 原本的行人安全評分(pedestrianSafety/scoring.js,事故 40% / 路燈 30% /
// 便利商店 30%)打分,排出「推薦 / 備選1 / 備選2」,並產生文字比較分析。
//
// 路線候選的產生方式完全照 112-project 主系統 /api/route 的步行模式設定:
//   1. 先跟 OSRM 要 alternatives=true(路網本身的替代路線)
//   2. 不足 3 條時,用 routeAlternatives.js(從主專案原封不動複製)補繞行路線:
//      先「避開事故聚集段」(risk-aware,bufferRadius 150m、pushMeters 300m),
//      沒有聚集再用「垂直幾何偏移」(symmetric),經由中途點讓 OSRM 重算
//   3. 最多保留 3 條;沒有真正步行 profile 時,時間用 4.8 km/h 由距離換算
//
// 跟主系統唯一的差別:主系統只在「OSRM 只給 1 條」時才補繞行,並只用「距離差
// 3% 以內」判斷重複。這裡為了穩定湊滿推薦+備選1+備選2,只要不足 3 條就補,
// 而且重複判斷改成比對路線形狀重疊度(兩條長度差不多但走完全不同街道的路線,
// 不會再被誤判成重複)。

import { ensureRoads } from "./roadNetwork.js";
import { buildDetourCandidates, findRiskiestRouteCluster } from "./routeAlternatives.js";
import { toLocalXY, toLatLon, pointToSegmentDistance } from "./pedestrianSafety/geoUtils.js";
import { filterPedestrianAccidents } from "./pedestrianSafety/index.js";

const WALK_SPEED_KMH = 4.8; // 與主系統相同
const MAX_ROUTES = 3;
const DETOUR_SETTINGS = { bufferRadius: 150, pushMeters: 300 }; // 與主系統相同
const OVERLAP_SAMPLE_METERS = 25;
const OVERLAP_NEAR_METERS = 30; // 取樣點離既有路線 30m 內 = 走同一條路
const DUPLICATE_OVERLAP = 0.85; // 85% 以上重疊視為同一條路線
const SCORE_TIE = 1.0; // 分數差 1 分以內視為平手,改選較短的

// ----------------------------------------------------------------------
// OSRM
// ----------------------------------------------------------------------

function looksLikeDriving(route) {
  const steps = route?.legs?.flatMap((leg) => leg.steps || []) || [];
  const modes = new Set(steps.map((s) => s.mode));
  return modes.has("driving") && !modes.has("walking");
}

/**
 * 依序嘗試:真正的步行伺服器 → OSRM_BASE_URL 的 foot(檢查是不是其實是汽車)
 * → OSRM_BASE_URL 的 driving(時間改用步行速度換算)。
 * coords: [{lat, lon}, ...](2 個以上,中間的是繞行中途點)
 */
// 依交通方式向 OSRM 要路線,依序嘗試直到成功:
//   walk    : 步行伺服器 foot → OSRM_BASE_URL foot(檢查是不是其實是汽車)→ driving(時間用 4.8 km/h 換算)
//   car     : 開車伺服器 driving → OSRM_BASE_URL driving
//   scooter : 開車伺服器 driving 但排除 motorway(國道/快速道路機車不能走)→ OSRM_BASE_URL 同樣排除
//             → 都失敗才不排除(並標示可能含機車不能走的路段)
function routeAttempts(mode, path, query, { footBaseUrl, carBaseUrl, osrmBaseUrl }) {
  if (mode === "car") {
    return [
      { url: `${carBaseUrl}/route/v1/driving/${path}${query}`, profile: "car" },
      { url: `${osrmBaseUrl}/route/v1/driving/${path}${query}`, profile: "car" },
    ];
  }
  if (mode === "scooter") {
    return [
      { url: `${carBaseUrl}/route/v1/driving/${path}${query}&exclude=motorway`, profile: "scooter-no-motorway" },
      { url: `${osrmBaseUrl}/route/v1/driving/${path}${query}&exclude=motorway`, profile: "scooter-no-motorway" },
      { url: `${carBaseUrl}/route/v1/driving/${path}${query}`, profile: "scooter-car-network" },
    ];
  }
  return [
    { url: `${footBaseUrl}/route/v1/foot/${path}${query}`, profile: "foot", checkDriving: false },
    { url: `${osrmBaseUrl}/route/v1/foot/${path}${query}`, profile: "foot", checkDriving: true },
    { url: `${osrmBaseUrl}/route/v1/driving/${path}${query}`, profile: "driving-fallback-for-walk", checkDriving: false },
  ];
}

async function fetchRoutes(coords, { alternatives, mode = "walk", footBaseUrl, carBaseUrl, osrmBaseUrl, fetchWithTimeout }) {
  const path = coords.map((c) => `${c.lon},${c.lat}`).join(";");
  const query = `?overview=full&geometries=geojson&steps=true${alternatives ? "&alternatives=true" : ""}`;
  const attempts = routeAttempts(mode, path, query, { footBaseUrl, carBaseUrl, osrmBaseUrl });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await fetchWithTimeout(attempt.url, {}, 9000);
      const data = await response.json();
      if (!response.ok || data.code !== "Ok" || !data.routes?.length) {
        lastError = new Error(`OSRM ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
        continue;
      }
      if (attempt.checkDriving && looksLikeDriving(data.routes[0])) {
        lastError = new Error("OSRM foot profile 其實回傳汽車路線");
        continue;
      }
      return data.routes.map((r) => {
        const distance = Number(r.distance);
        if (mode !== "walk") {
          return {
            coordinates: (r.geometry?.coordinates || []).map(([lon, lat]) => ({ lat, lon })),
            distanceMeters: distance,
            durationSeconds: Number(r.duration),
            profile: attempt.profile,
          };
        }
        const realFoot = attempt.profile === "foot" && !looksLikeDriving(r);
        return {
          coordinates: (r.geometry?.coordinates || []).map(([lon, lat]) => ({ lat, lon })),
          distanceMeters: distance,
          durationSeconds: realFoot ? Number(r.duration) : (distance / 1000 / WALK_SPEED_KMH) * 3600,
          profile: realFoot ? "foot" : "driving-fallback-for-walk",
        };
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("OSRM route failed");
}

// ----------------------------------------------------------------------
// 重複路線判斷:沿候選路線每 25m 取樣,看有幾成落在既有路線 30m 內
// ----------------------------------------------------------------------

function samplePoints(coords, stepMeters) {
  if (coords.length < 2) return coords.slice();
  const ref = coords[0];
  const local = coords.map((c) => toLocalXY(c.lat, c.lon, ref.lat, ref.lon));
  const out = [local[0]];
  let carry = 0;
  for (let i = 0; i < local.length - 1; i++) {
    const a = local[i];
    const b = local[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = stepMeters - carry;
    while (d <= len) {
      out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
      d += stepMeters;
    }
    carry = len - (d - stepMeters);
  }
  out.push(local[local.length - 1]);
  return out.map((p) => toLatLon(p.x, p.y, ref.lat, ref.lon));
}

function overlapRatio(candidate, existing) {
  const ref = existing[0];
  const existingLocal = existing.map((c) => toLocalXY(c.lat, c.lon, ref.lat, ref.lon));
  const samples = samplePoints(candidate, OVERLAP_SAMPLE_METERS);
  let near = 0;
  for (const s of samples) {
    const p = toLocalXY(s.lat, s.lon, ref.lat, ref.lon);
    let min = Infinity;
    for (let i = 0; i < existingLocal.length - 1 && min > OVERLAP_NEAR_METERS; i++) {
      const d = pointToSegmentDistance(p, existingLocal[i], existingLocal[i + 1]);
      if (d < min) min = d;
    }
    if (min <= OVERLAP_NEAR_METERS) near++;
  }
  return samples.length ? near / samples.length : 1;
}

function isDuplicate(candidate, kept) {
  return kept.some(
    (k) => overlapRatio(candidate.coordinates, k.coordinates) >= DUPLICATE_OVERLAP &&
      overlapRatio(k.coordinates, candidate.coordinates) >= DUPLICATE_OVERLAP
  );
}

// ----------------------------------------------------------------------
// 路線上最危險的一段(用主系統的 findRiskiestRouteCluster,250m 一段)
// ----------------------------------------------------------------------

function describeHotspot(coords, accidents, bufferRadius) {
  const cluster = findRiskiestRouteCluster(coords, accidents, bufferRadius);
  if (!cluster) return null;
  const c = toLatLon(cluster.centroidLocal.x, cluster.centroidLocal.y, cluster.refLat, cluster.refLon);
  // 用離聚集中心最近的一筆事故的「發生地點」文字當作這段路的名稱
  let nearest = null;
  let best = Infinity;
  for (const a of filterPedestrianAccidents(accidents)) {
    const d = Math.hypot(a.latitude - c.lat, (a.longitude - c.lon) * Math.cos((c.lat * Math.PI) / 180));
    if (d < best) {
      best = d;
      nearest = a;
    }
  }
  const place = nearest?.location
    ? nearest.location
        .split(" / ")[0]
        .replace(/^[^市縣]{2}[市縣]/, "") // drop the county prefix (臺北市/臺中市/新北市…)
        .replace(/(前|後|旁|附近)?\s*[\d.]+\s*公尺$/, "")
        .trim()
    : null;
  return { accidentCount: cluster.accidentCount, lat: c.lat, lon: c.lon, place };
}

// ----------------------------------------------------------------------
// 比較分析文字
// ----------------------------------------------------------------------

const fmtMin = (sec) => Math.round(sec / 60);
const perKm = (count, meters) => (meters > 0 ? count / (meters / 1000) : 0);
const signed = (n, digits = 1) => (n > 0 ? "+" : "") + n.toFixed(digits);

function buildAnalysis(routes, modeInfo = { label: "步行", accidentNoun: "行人事故" }) {
  const noun = modeInfo.accidentNoun;
  const travel = modeInfo.label === "步行" ? "步行約" : `${modeInfo.label}約`;
  const [rec, ...alts] = routes;
  const lines = [];
  const r = rec.result;

  const strengths = [];
  const best = (key) =>
    rec.metrics[key] !== null && routes.every((x) => x.metrics[key] === null || rec.metrics[key] >= x.metrics[key]);
  if (routes.length > 1) {
    if (best("accidentScore")) strengths.push(`事故分數最高(經過的${noun}最少)`);
    if (best("streetlightScore")) strengths.push("路燈最密");
    if (best("convenienceStoreScore")) strengths.push("便利商店最多");
  }
  lines.push(
    `【${rec.title}】安全分數 ${r.finalSafetyScore},${travel} ${fmtMin(rec.durationSeconds)} 分鐘(${(rec.distanceMeters / 1000).toFixed(2)} 公里)。` +
      (strengths.length ? `在${routes.length}條路線中${strengths.join("、")}。` : "") +
      (rec.tieBrokenByDistance ? "(與另一條路線分數相差不到 1 分,選擇較短的那條。)" : "")
  );

  for (const alt of alts) {
    const a = alt.result;
    const scoreDiff = a.finalSafetyScore - r.finalSafetyScore;
    const minDiff = fmtMin(alt.durationSeconds) - fmtMin(rec.durationSeconds);
    const parts = [];
    parts.push(`分數 ${a.finalSafetyScore}(${signed(scoreDiff)})`);
    const verb = modeInfo.label === "步行" ? "走" : "花";
    parts.push(minDiff === 0 ? "時間差不多" : minDiff > 0 ? `多${verb} ${minDiff} 分鐘` : `少${verb} ${-minDiff} 分鐘`);
    const accDiff = alt.metrics.accidentsPerKm - rec.metrics.accidentsPerKm;
    const lightDiff = alt.metrics.streetlightsPerKm - rec.metrics.streetlightsPerKm;
    const storeDiff = alt.metrics.storesPerKm - rec.metrics.storesPerKm;
    const detail = [];
    if (Math.abs(accDiff) >= 1) detail.push(`每公里${noun}${accDiff > 0 ? "多" : "少"} ${Math.abs(accDiff).toFixed(1)} 件(近5年)`);
    if (Math.abs(lightDiff) >= 5) detail.push(`每公里路燈${lightDiff > 0 ? "多" : "少"} ${Math.abs(lightDiff).toFixed(0)} 盞`);
    if (Math.abs(storeDiff) >= 0.5) detail.push(`每公里便利商店${storeDiff > 0 ? "多" : "少"} ${Math.abs(storeDiff).toFixed(1)} 家`);
    let line = `【${alt.title}】${parts.join(",")}` + (detail.length ? `;跟推薦路線比,${detail.join("、")}` : "") + "。";
    if (minDiff < 0 && scoreDiff > -5) line += "趕時間的話可以考慮這條,安全分數差距不大。";
    else if (minDiff < 0) line += "比較快,但安全分數明顯較低。";
    lines.push(line);
  }

  // 推薦路線的事故分數不是最好時,明講取捨,讓最在意事故的人自己選
  const fewestAccidents = routes.reduce((b, x) => ((x.metrics.accidentScore ?? -1) > (b.metrics.accidentScore ?? -1) ? x : b), rec);
  if (fewestAccidents !== rec && rec.metrics.accidentScore !== null && fewestAccidents.metrics.accidentScore - rec.metrics.accidentScore >= 3) {
    lines.push(
      `取捨:推薦路線是綜合分數最高,主要靠${modeInfo.label === "步行" || modeInfo.label === "大眾運輸" ? "路燈和便利商店" : "路燈"}加分;如果你最在意「交通事故」這一項,` +
        `${fewestAccidents.rankLabel}的事故分數最高(${fewestAccidents.metrics.accidentScore} vs ${rec.metrics.accidentScore})。`
    );
  }

  const cov = rec.result.coverage;
  if (cov && cov.adjusted) {
    const label = { accident: "交通事故", streetlight: "路燈", convenienceStore: "便利商店" };
    const missing = Object.entries(cov.status).filter(([, v]) => v === "no-data").map(([k]) => label[k]);
    const partial = Object.entries(cov.status).filter(([, v]) => v === "partial").map(([k]) => label[k]);
    lines.push(
      `資料涵蓋:路線經過${cov.routeCounties.join("、") || "未知縣市"}。` +
        (missing.length ? `這裡沒有${missing.join("、")}資料,該項不計分,總分由其他項目依權重比例換算。` : "") +
        (partial.length ? `${partial.join("、")}資料只涵蓋部分路段,只用有資料的那段計算。` : "")
    );
  }

  const hot = rec.hotspot;
  if (hot) {
    lines.push(
      `注意:推薦路線上事故最集中的一段在${hot.place ? `「${hot.place}」` : "地圖上標示的位置"}附近(約 250 公尺內 ${hot.accidentCount} 件${noun},近5年),經過時請特別留意。`
    );
  }
  if (routes.length < MAX_ROUTES) {
    lines.push(`這組起終點附近只找到 ${routes.length} 條明顯不同的${modeInfo.label}路線(其他候選路線跟現有路線幾乎重疊、繞太遠,或規劃失敗,已排除)。`);
  }
  if (routes.some((x) => x.profile === "driving-fallback-for-walk")) {
    lines.push("部分路線是用汽車路網換算的(連不到步行路線伺服器),可能包含行人不能走的路段,時間以 4.8 km/h 估算。");
  }
  if (routes.some((x) => x.profile === "scooter-car-network")) {
    lines.push("路線伺服器不支援「排除國道」,部分機車路線是用一般汽車路網規劃的,可能經過機車不能走的國道或快速道路,請自行確認。");
  }
  if (modeInfo.label !== "步行") {
    lines.push(`分數只適合比較同一種交通方式的路線;${modeInfo.label}和步行的門檻不同,分數不能直接互相比較。`);
  }

  return lines;
}

// ----------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------

// 直線距離(公尺),只用來決定繞行點插在哪一段
function straight(a, b) {
  const dy = (b.lat - a.lat) * 111320;
  const dx = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
}

// 把繞行點插進「多走最少」的那一段,維持使用者中途點的順序
// (start → 中途點1 → 中途點2 → end)
function insertDetour(points, detour) {
  let bestIdx = 1;
  let bestCost = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const cost = straight(points[i], detour) + straight(detour, points[i + 1]) - straight(points[i], points[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      bestIdx = i + 1;
    }
  }
  return [...points.slice(0, bestIdx), detour, ...points.slice(bestIdx)];
}

export async function compareWalkingRoutes({
  start,
  end,
  waypoints = [], // 使用者指定的中途點(依序經過)
  bufferRadius,
  dataSource,
  accidents,
  accidentsNear = () => accidents,
  footBaseUrl,
  carBaseUrl,
  osrmBaseUrl,
  fetchWithTimeout,
  buildPedestrianSafetyResponse,
  mode = "walk",
  modeInfo = { label: "步行", accidentNoun: "行人事故" },
}) {
  const ctx = { footBaseUrl, carBaseUrl, osrmBaseUrl, fetchWithTimeout, mode };

  const stops = [start, ...waypoints, end];

  // 1) 路網本身的替代路線(有中途點時 OSRM 通常只給 1 條,其餘靠下面的繞行補)
  const native = await fetchRoutes(stops, { ...ctx, alternatives: true });
  const kept = [];
  for (const r of native) {
    if (kept.length >= MAX_ROUTES) break;
    if (r.coordinates.length >= 2 && !isDuplicate(r, kept)) {
      kept.push({ ...r, origin: "osrm", originReason: kept.length === 0 ? "路網最短步行路線" : "路網提供的替代路線" });
    }
  }
  if (!kept.length) throw new Error("找不到步行路線");

  // 2) 不足 3 條 → 用主系統的繞行中途點補
  if (kept.length < MAX_ROUTES) {
    // 幾何偏移用「最長的一段」的兩端來算,事故聚集則看整條路線
    let legA = stops[0];
    let legB = stops[1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (straight(stops[i], stops[i + 1]) > straight(legA, legB)) {
        legA = stops[i];
        legB = stops[i + 1];
      }
    }
    const candidates = buildDetourCandidates(kept[0].coordinates, legA, legB, accidentsNear(kept[0].coordinates), {
      ...DETOUR_SETTINGS,
      maxCandidates: 3, // risk-aware(若有)+ 兩側幾何偏移,多試一個以免被判重複
    });
    for (const c of candidates) {
      if (kept.length >= MAX_ROUTES) break;
      try {
        const [r] = await fetchRoutes(insertDetour(stops, { lat: c.lat, lon: c.lon }), { ...ctx, alternatives: false });
        if (!r || r.coordinates.length < 2 || isDuplicate(r, kept)) continue;
        // 繞太遠(超過最短路線 1.8 倍)的不算合理的步行選項
        if (r.distanceMeters > kept[0].distanceMeters * 1.8) continue;
        kept.push({ ...r, origin: c.kind, originReason: c.reason, via: { lat: c.lat, lon: c.lon } });
      } catch {
        // 單一候選失敗不影響其他路線
      }
    }
  }

  // 3) 每條路線用原本的評分公式打分
  //    bufferRadius 為 null = 自動判定:先抓好路線附近的 OSM 道路,
  //    每筆資料歸給「最近的那條路」(見 pedestrianSafety/roadAttribution.js)
  if (bufferRadius == null) await ensureRoads(kept.map((r) => r.coordinates));
  const hotspotRadius = bufferRadius ?? (mode === "walk" ? DETOUR_SETTINGS.bufferRadius : 50);
  const scored = kept.map((r) => {
    const response = buildPedestrianSafetyResponse(r.coordinates, r.profile, dataSource, bufferRadius);
    const res = response.result;
    const a1 = (response.mapLayers.accidents || []).filter((x) => /死亡[1-9]/.test(x.severity || "")).length;
    return {
      ...r,
      result: res,
      mapLayers: response.mapLayers,
      hotspot: describeHotspot(r.coordinates, accidentsNear(r.coordinates), hotspotRadius),
      metrics: {
        finalSafetyScore: res.finalSafetyScore,
        accidentScore: res.accidentScore,
        streetlightScore: res.streetlightScore,
        convenienceStoreScore: res.convenienceStoreScore,
        accidents: res.pedestrianAccidents,
        fatalAccidents: a1,
        streetlights: res.streetlights,
        stores: res.convenienceStores,
        accidentsPerKm: perKm(res.pedestrianAccidents, r.distanceMeters),
        streetlightsPerKm: perKm(res.streetlights, r.distanceMeters),
        storesPerKm: perKm(res.convenienceStores, r.distanceMeters),
      },
    };
  });

  // 4) 排名:安全分數高的優先;差 1 分以內視為平手,選較短的
  scored.sort((x, y) => {
    const d = y.metrics.finalSafetyScore - x.metrics.finalSafetyScore;
    if (Math.abs(d) > SCORE_TIE) return d;
    return x.distanceMeters - y.distanceMeters;
  });
  if (scored.length > 1) {
    const top = scored[0];
    const higher = scored.slice(1).find((x) => x.metrics.finalSafetyScore > top.metrics.finalSafetyScore);
    top.tieBrokenByDistance = Boolean(higher);
  }

  const rankLabels = ["推薦路線", "備選1", "備選2"];
  scored.forEach((x, i) => {
    x.rank = i + 1;
    x.rankLabel = rankLabels[i];
    const tags = [];
    // 「最短」只標在明顯比其他路線短(3% 以上)的那條
    const others = scored.filter((y) => y !== x);
    if (others.length && others.every((y) => x.distanceMeters < y.distanceMeters * 0.97)) tags.push("最短");
    if (x.origin === "risk-aware") tags.push("避開事故聚集");
    x.title = `${rankLabels[i]}${tags.length ? `(${tags.join("、")})` : ""}`;
  });

  return {
    status: "ok",
    dataSource,
    bufferRadius, // null = 自動判定(每條路線的 result.attribution 有實際用的範圍)
    waypoints,
    rankingRule:
      "依原本的行人安全分數(事故 40% + 路燈 30% + 便利商店 30%)由高到低排序;分數差 1 分以內視為平手,改選距離較短的。",
    routes: scored.map((x) => ({
      rank: x.rank,
      rankLabel: x.rankLabel,
      title: x.title,
      origin: x.origin,
      originReason: x.originReason,
      via: x.via || null,
      profile: x.profile,
      distanceMeters: Math.round(x.distanceMeters),
      durationSeconds: Math.round(x.durationSeconds),
      metrics: x.metrics,
      hotspot: x.hotspot,
      result: x.result,
      mapLayers: x.mapLayers,
    })),
    mode,
    modeLabel: modeInfo.label,
    accidentNoun: modeInfo.accidentNoun,
    analysis: (waypoints.length
      ? [`每條路線都依序經過你指定的 ${waypoints.length} 個中途點。`]
      : []
    ).concat(buildAnalysis(scored, modeInfo)),
  };
}
