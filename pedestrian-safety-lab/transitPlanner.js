// transitPlanner.js
//
// 大眾運輸:用 TDX 的 MaaS 路徑規劃 API(https://tdx.transportdata.tw/api/maas/routing)
// 從起點到終點自動規劃「步行 → 公車/捷運/台鐵/高鐵/輕軌… → 步行」的行程,
// 取最多 3 個方案。
//
// 安全評分只看「步行段」(走去搭車、轉乘時走路、下車走到目的地),用原本的
// 行人安全評分;搭乘中的那段不評分(沒有對應的事故/路燈意義)。所以分數的
// 意思是:「這個方案需要走的那些路,對行人安不安全」。
//
// TDX 金鑰讀 .env 的 TDX_CLIENT_ID / TDX_CLIENT_SECRET(跟 112-project 一樣),
// 取得 token 的方式也跟主專案 tdxRealClient.js 相同。
//
// TDX 的 swagger 只寫了請求參數,沒寫回應格式,所以這裡的解析刻意寬鬆:
//   - 路線:data.routes / routes
//   - 每段:sections / legs;type 'pedestrian'|'walk' 是步行,其餘是搭乘
//   - 座標:departure.place.location {lat,lng} 等多種寫法
//   - 線形:flexible polyline 字串(HERE 格式)、座標陣列,都沒有的話步行段改用
//     OSRM 步行路線、搭乘段畫虛線直線
// 想看 TDX 實際回了什麼:GET /api/transit/raw?startLat=..&startLon=..&endLat=..&endLon=..

import { ensureRoads } from "./roadNetwork.js";
import {
  WEIGHTS,
  calculatePedestrianAccidentScore,
  calculateStreetlightScore,
  calculateConvenienceStoreScore,
} from "./pedestrianSafety/scoring.js";

const TOKEN_URL =
  process.env.TDX_TOKEN_URL || "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const ROUTING_URL = process.env.TDX_ROUTING_URL || "https://tdx.transportdata.tw/api/maas/routing";

let cachedToken = null;
let tokenExpireAt = 0;

async function getToken(fetchWithTimeout, force = false) {
  if (!force && cachedToken && Date.now() < tokenExpireAt - 60000) return cachedToken;
  const id = process.env.TDX_CLIENT_ID;
  const secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("大眾運輸需要 TDX 金鑰:請在 .env 設定 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET");
  }
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  const response = await fetchWithTimeout(
    TOKEN_URL,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    10000
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`TDX 登入失敗(HTTP ${response.status}),請確認 .env 的 TDX 金鑰`);
  cachedToken = data.access_token;
  tokenExpireAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Taiwan local time "YYYY-MM-DDTHH:mm:ss" (what TDX expects for depart).
function taipeiNowIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19);
}

async function callRouting({ start, end, depart, fetchWithTimeout, top = 5 }) {
  const params = new URLSearchParams({
    origin: `${start.lat},${start.lon}`,
    destination: `${end.lat},${end.lon}`,
    gc: "1.0", // 1 = 最快, 0 = 最便宜
    top: String(top),
    transit: "3,4,5,6,7,8,9", // 高鐵, 台鐵, 公車, 捷運, 輕軌, 渡輪, 纜車
    depart: depart || taipeiNowIso(),
    first_mile_mode: "0", // 步行
    first_mile_time: "15",
    last_mile_mode: "0",
    last_mile_time: "15",
  });
  const url = `${ROUTING_URL}?${params}`;
  let token = await getToken(fetchWithTimeout);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchWithTimeout(
      url,
      { headers: { authorization: `Bearer ${token}`, accept: "application/json", "accept-encoding": "gzip" } },
      20000
    );
    if (response.status === 401) {
      token = await getToken(fetchWithTimeout, true);
      continue;
    }
    if (response.status === 429) {
      const wait = Math.min(5000, Number(response.headers.get("retry-after") || 1) * 1000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`TDX 路徑規劃回應不是 JSON(HTTP ${response.status}):${text.slice(0, 150)}`);
    }
    if (!response.ok) throw new Error(`TDX 路徑規劃失敗(HTTP ${response.status}):${JSON.stringify(data).slice(0, 200)}`);
    return data;
  }
  throw new Error("TDX 路徑規劃暫時無法使用(連續被限流或驗證失敗),請稍後再試");
}

export async function transitRaw({ start, end, depart, fetchWithTimeout }) {
  if (![start.lat, start.lon, end.lat, end.lon].every(Number.isFinite)) throw new Error("Missing or invalid coordinates");
  return callRouting({ start, end, depart, fetchWithTimeout, top: 3 });
}

// ----------------------------------------------------------------------
// Parsing (tolerant -- see header comment)
// ----------------------------------------------------------------------

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** HERE flexible polyline -> [{lat, lon}] (verified against HERE's published examples). */
export function decodeFlexiblePolyline(str) {
  const vals = [];
  let value = 0;
  let shift = 0;
  for (const ch of str) {
    const v = TABLE.indexOf(ch);
    if (v < 0) throw new Error("not a flexible polyline");
    value += (v & 0x1f) * 2 ** shift;
    if (v & 0x20) shift += 5;
    else {
      vals.push(value);
      value = 0;
      shift = 0;
    }
  }
  if (vals.length < 4) throw new Error("polyline too short");
  const header = vals[1];
  const factor = 10 ** (header % 16);
  const step = Math.floor(header / 16) % 8 ? 3 : 2;
  const unzig = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const out = [];
  let lat = 0;
  let lon = 0;
  for (let i = 2; i + 1 < vals.length; i += step) {
    lat += unzig(vals[i]);
    lon += unzig(vals[i + 1]);
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

const inTaiwan = (p) => p && p.lat > 21 && p.lat < 27 && p.lon > 118 && p.lon < 124;

function toPoint(obj) {
  if (!obj || typeof obj !== "object") return null;
  const cand = [obj.place?.location, obj.location, obj.place, obj.position, obj.Position, obj.StopPosition, obj];
  for (const c of cand) {
    if (!c) continue;
    const lat = Number(c.lat ?? c.latitude ?? c.Lat ?? c.PositionLat);
    const lon = Number(c.lng ?? c.lon ?? c.longitude ?? c.Lon ?? c.PositionLon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

function placeName(obj) {
  const n = obj?.place?.name ?? obj?.name ?? obj?.place?.Name ?? obj?.StopName?.Zh_tw ?? obj?.StationName?.Zh_tw;
  return typeof n === "string" ? n : n?.Zh_tw || null;
}

function parseGeometry(sec) {
  const g = sec.polyline ?? sec.geometry ?? sec.shape ?? sec.path;
  if (typeof g === "string" && g.length > 3) {
    try {
      const pts = decodeFlexiblePolyline(g);
      if (pts.length >= 2 && pts.every(inTaiwan)) return pts;
    } catch {
      // not flexible polyline
    }
  }
  const arr = Array.isArray(g) ? g : Array.isArray(g?.coordinates) ? g.coordinates : null;
  if (arr && arr.length >= 2) {
    const pts = arr.map((c) => (Array.isArray(c) ? { a: Number(c[0]), b: Number(c[1]) } : { a: Number(c.lat ?? c.y), b: Number(c.lng ?? c.lon ?? c.x) }));
    // [lat, lon] or [lon, lat]? Taiwan's lat ~22-26, lon ~118-122.
    const asLatLon = pts.map((p) => ({ lat: p.a, lon: p.b }));
    if (asLatLon.every(inTaiwan)) return asLatLon;
    const asLonLat = pts.map((p) => ({ lat: p.b, lon: p.a }));
    if (asLonLat.every(inTaiwan)) return asLonLat;
  }
  return null;
}

const MODE_ZH = {
  pedestrian: "步行", walk: "步行", walking: "步行",
  bus: "公車", busRapid: "公車", intercityBus: "客運", coach: "客運",
  subway: "捷運", metro: "捷運", mrt: "捷運", lightRail: "輕軌", tram: "輕軌",
  regionalTrain: "台鐵", train: "台鐵", intercityTrain: "台鐵", rail: "台鐵", cityTrain: "台鐵",
  highSpeedTrain: "高鐵", hsr: "高鐵", ferry: "渡輪", aerial: "纜車", cableCar: "纜車", monorail: "纜車",
};

function isWalk(sec) {
  const t = String(sec.type ?? sec.mode ?? sec.transport?.mode ?? "").toLowerCase();
  return t === "pedestrian" || t === "walk" || t === "walking" || t === "0";
}

function secondsBetween(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && tb >= ta ? (tb - ta) / 1000 : null;
}

function lengthMeters(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    d += Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
  }
  return d;
}

async function parseRoutes(raw, { start, end, footRoute }) {
  const list = raw?.data?.routes ?? raw?.routes ?? raw?.data ?? [];
  const routes = Array.isArray(list) ? list : [];
  const parsed = [];
  for (const r of routes) {
    const secs = r.sections ?? r.legs ?? r.Sections ?? [];
    if (!Array.isArray(secs) || !secs.length) continue;
    const legs = [];
    let prevEnd = start;
    for (const sec of secs) {
      const from = toPoint(sec.departure ?? sec.from ?? sec.origin) || prevEnd;
      const to = toPoint(sec.arrival ?? sec.to ?? sec.destination);
      const walk = isWalk(sec);
      const t = sec.transport ?? {};
      const rawMode = String(t.mode ?? sec.mode ?? sec.type ?? "");
      let geometry = parseGeometry(sec);
      let geometrySource = geometry ? "tdx" : null;
      if (!geometry && from && to) {
        geometry = walk ? await footRoute(from, to) : [from, to];
        geometrySource = walk ? "osrm-foot" : "straight";
      }
      if (!geometry) continue;
      const summary = sec.travelSummary ?? sec.summary ?? {};
      const duration =
        Number(summary.duration) ||
        secondsBetween(sec.departure?.time, sec.arrival?.time) ||
        Number(sec.duration) ||
        (walk ? (lengthMeters(geometry) / 1000 / 4.8) * 3600 : null);
      legs.push({
        type: walk ? "walk" : "transit",
        mode: walk ? "walk" : rawMode,
        modeLabel: walk ? "步行" : MODE_ZH[rawMode] || MODE_ZH[rawMode.toLowerCase()] || rawMode || "搭乘",
        name: walk ? null : t.name ?? t.shortName ?? t.longName ?? sec.routeName ?? null,
        headsign: walk ? null : t.headsign ?? null,
        from: placeName(sec.departure ?? sec.from) || null,
        to: placeName(sec.arrival ?? sec.to) || null,
        departTime: sec.departure?.time ?? null,
        arriveTime: sec.arrival?.time ?? null,
        durationSeconds: duration ? Math.round(duration) : null,
        distanceMeters: Math.round(Number(summary.length) || lengthMeters(geometry)),
        geometry,
        geometrySource,
      });
      prevEnd = geometry[geometry.length - 1];
    }
    if (!legs.length) continue;
    const total =
      secondsBetween(r.start_time ?? legs[0].departTime, r.end_time ?? legs[legs.length - 1].arriveTime) ||
      legs.reduce((s, l) => s + (l.durationSeconds || 0), 0);
    parsed.push({
      legs,
      durationSeconds: Math.round(total),
      transfers: Number.isFinite(Number(r.transfers)) ? Number(r.transfers) : Math.max(0, legs.filter((l) => l.type === "transit").length - 1),
      startTime: r.start_time ?? legs[0].departTime ?? null,
      endTime: r.end_time ?? legs[legs.length - 1].arriveTime ?? null,
    });
  }
  // A route with no legs reaching the destination area is suspicious; keep anyway, but de-dupe identical itineraries.
  const seen = new Set();
  return parsed.filter((p) => {
    const key = p.legs.map((l) => `${l.type}:${l.modeLabel}:${l.name || ""}`).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ----------------------------------------------------------------------
// Scoring: walking legs only
// ----------------------------------------------------------------------

function combineWalkScores(legResults) {
  // Area-weighted average of each factor over the walking legs (= the same
  // density over the combined walking buffer when every leg has full data).
  const factors = [
    ["accident", "accidentScore"],
    ["streetlight", "streetlightScore"],
    ["convenienceStore", "convenienceStoreScore"],
  ];
  const out = { accidentScore: null, streetlightScore: null, convenienceStoreScore: null };
  for (const [, key] of factors) {
    let sum = 0;
    let w = 0;
    for (const r of legResults) {
      if (r[key] === null || r[key] === undefined) continue;
      sum += r[key] * r.bufferAreaKm2;
      w += r.bufferAreaKm2;
    }
    out[key] = w > 0 ? Math.round((sum / w) * 10) / 10 : null;
  }
  let sum = 0;
  let w = 0;
  for (const [factor, key] of factors) {
    if (out[key] === null) continue;
    sum += out[key] * WEIGHTS[factor];
    w += WEIGHTS[factor];
  }
  out.finalSafetyScore = w > 0 ? Math.round((sum / w) * 10) / 10 : null;
  return out;
}

export async function planTransit({ start, end, bufferRadius, depart, fetchWithTimeout, scoreWalkLeg, footRoute }) {
  const raw = await callRouting({ start, end, depart, fetchWithTimeout, top: 5 });
  const options = (await parseRoutes(raw, { start, end, footRoute })).slice(0, 3);
  if (!options.length) {
    const msg = raw?.message || raw?.data?.message || "";
    throw new Error(`TDX 沒有找到大眾運輸路線${msg ? `(${msg})` : ""}。距離太近、附近沒有站牌,或末班車已過都有可能。`);
  }

  // Automatic attribution (bufferRadius null): fetch the road network around
  // every walking leg first (see roadNetwork.js).
  if (bufferRadius == null) {
    await ensureRoads(options.flatMap((o) => o.legs.filter((l) => l.type === "walk" && l.geometry.length >= 2).map((l) => l.geometry)));
  }
  const scored = options.map((opt) => {
    const walkLegs = opt.legs.filter((l) => l.type === "walk" && l.geometry.length >= 2 && l.distanceMeters >= 20);
    const legResponses = walkLegs.map((l) => scoreWalkLeg(l.geometry));
    const legResults = legResponses.map((r) => r.result);
    const combined = legResults.length ? combineWalkScores(legResults) : { finalSafetyScore: null, accidentScore: null, streetlightScore: null, convenienceStoreScore: null };
    const sum = (k) => legResults.reduce((s, r) => s + (r[k] || 0), 0);
    const walkingMeters = walkLegs.reduce((s, l) => s + l.distanceMeters, 0);
    const counties = [...new Set(legResults.flatMap((r) => r.coverage?.routeCounties || []))];
    const coverageAdjusted = legResults.some((r) => r.coverage?.adjusted);
    const result = {
      ...combined,
      pedestrianAccidents: sum("pedestrianAccidents"),
      accidentWeightedCount: Math.round(sum("accidentWeightedCount") * 10) / 10,
      streetlights: sum("streetlights"),
      convenienceStores: sum("convenienceStores"),
      bufferAreaKm2: Math.round(legResults.reduce((s, r) => s + r.bufferAreaKm2, 0) * 1000) / 1000,
      attribution: legResults.length && legResults.every((r) => r.attribution?.method === "nearest-road")
        ? { method: "nearest-road", maxRadius: legResults[0].attribution.maxRadius }
        : legResults[0]?.attribution || null,
      // Length-weighted average of each leg's (effective) radius, for the map band.
      bufferRadiusMeters: walkingMeters
        ? Math.round(legResults.reduce((s, r) => s + (r.bufferRadiusMeters || 0) * (r.routeLengthMeters || 0), 0) /
            Math.max(1, legResults.reduce((s, r) => s + (r.routeLengthMeters || 0), 0)))
        : null,
      routeLengthMeters: walkingMeters,
      accidentDataDateRange: legResults[0]?.accidentDataDateRange || null,
      accidentDataYearsSpan: legResults[0]?.accidentDataYearsSpan || null,
      nearbyAccidentPoints: legResults.flatMap((r) => r.nearbyAccidentPoints || []).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 40),
      nearbyStreetlightPoints: legResults.flatMap((r) => r.nearbyStreetlightPoints || []).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 40),
      nearbyStorePoints: legResults.flatMap((r) => r.nearbyStorePoints || []).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 40),
      coverage: coverageAdjusted
        ? {
            adjusted: true,
            routeCounties: counties,
            status: legResults.find((r) => r.coverage?.adjusted)?.coverage.status || {},
            fraction: legResults.find((r) => r.coverage?.adjusted)?.coverage.fraction || {},
            coveredCounties: legResults[0]?.coverage?.coveredCounties || {},
            note: "部分步行段所在縣市缺少某些資料,該項目只用有資料的步行段計算。",
          }
        : { adjusted: false, routeCounties: counties },
    };
    const mapLayers = {
      routeGeometry: opt.legs.flatMap((l) => l.geometry.map((p) => [p.lat, p.lon])),
      accidents: legResponses.flatMap((r) => r.mapLayers.accidents),
      stores: legResponses.flatMap((r) => r.mapLayers.stores),
      streetlights: legResponses.flatMap((r) => r.mapLayers.streetlights),
    };
    return {
      ...opt,
      legs: opt.legs.map((l) => ({ ...l, geometry: l.geometry.map((p) => [p.lat, p.lon]) })),
      walkingMeters,
      result,
      mapLayers,
      metrics: {
        finalSafetyScore: combined.finalSafetyScore,
        accidentScore: combined.accidentScore,
        streetlightScore: combined.streetlightScore,
        convenienceStoreScore: combined.convenienceStoreScore,
        accidents: result.pedestrianAccidents,
        streetlights: result.streetlights,
        stores: result.convenienceStores,
        walkingMeters,
        transfers: opt.transfers,
      },
    };
  });

  // Ranking: walking-leg safety first; within 1 point, the faster trip.
  scored.sort((a, b) => {
    const sa = a.metrics.finalSafetyScore ?? -1;
    const sb = b.metrics.finalSafetyScore ?? -1;
    if (Math.abs(sb - sa) > 1) return sb - sa;
    return a.durationSeconds - b.durationSeconds;
  });
  const labels = ["推薦路線", "備選1", "備選2"];
  const fastest = Math.min(...scored.map((s) => s.durationSeconds));
  const fewestWalk = Math.min(...scored.map((s) => s.walkingMeters));
  scored.forEach((s, i) => {
    s.rank = i + 1;
    s.rankLabel = labels[i];
    const tags = [];
    if (scored.length > 1 && s.durationSeconds === fastest) tags.push("最快");
    if (scored.length > 1 && s.walkingMeters === fewestWalk) tags.push("走最少路");
    s.title = labels[i] + (tags.length ? `(${tags.join("、")})` : "");
    s.summary = s.legs
      .filter((l) => l.type === "transit")
      .map((l) => `${l.modeLabel}${l.name ? " " + l.name : ""}`)
      .join(" → ") || "全程步行";
  });

  const min = (sec) => Math.round(sec / 60);
  const analysis = [
    "大眾運輸的安全分數只評估「步行段」(走去搭車、轉乘、下車後走到目的地),搭乘中的路段不評分。",
  ];
  const rec = scored[0];
  analysis.push(
    `【${rec.title}】${rec.summary},約 ${min(rec.durationSeconds)} 分鐘、轉乘 ${rec.transfers} 次、步行 ${rec.walkingMeters} 公尺;步行段安全分數 ${rec.metrics.finalSafetyScore ?? "無資料"}。`
  );
  for (const alt of scored.slice(1)) {
    const dt = min(alt.durationSeconds) - min(rec.durationSeconds);
    analysis.push(
      `【${alt.title}】${alt.summary},${dt === 0 ? "時間差不多" : dt > 0 ? `多 ${dt} 分鐘` : `少 ${-dt} 分鐘`},步行 ${alt.walkingMeters} 公尺,步行段分數 ${alt.metrics.finalSafetyScore ?? "無資料"}。` +
        (dt < -5 && (rec.metrics.finalSafetyScore ?? 0) - (alt.metrics.finalSafetyScore ?? 0) < 5 ? "趕時間可以考慮這個方案。" : "")
    );
  }
  if (scored.some((s) => s.legs.some((l) => l.type === "transit" && l.geometrySource === "straight"))) {
    analysis.push("部分搭乘路段 TDX 沒有提供線形,地圖上以虛線直線表示(只是示意,不是實際行駛路徑)。");
  }

  return {
    status: "ok",
    mode: "transit",
    modeLabel: "大眾運輸",
    accidentNoun: "行人事故",
    bufferRadius,
    waypoints: [],
    departTime: depart || taipeiNowIso(),
    rankingRule: "依步行段的行人安全分數(事故 40% + 路燈 30% + 便利商店 30%)由高到低排序;差 1 分以內選比較快的方案。",
    routes: scored.map((s) => ({
      rank: s.rank,
      rankLabel: s.rankLabel,
      title: s.title,
      summary: s.summary,
      legs: s.legs,
      durationSeconds: s.durationSeconds,
      distanceMeters: s.legs.reduce((sum, l) => sum + l.distanceMeters, 0),
      walkingMeters: s.walkingMeters,
      transfers: s.transfers,
      startTime: s.startTime,
      endTime: s.endTime,
      profile: "transit",
      metrics: s.metrics,
      result: s.result,
      mapLayers: s.mapLayers,
      hotspot: null,
    })),
    analysis,
  };
}
