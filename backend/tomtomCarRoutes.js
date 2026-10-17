/*
 * TomTom 路況路線（取代 TDX 的汽車路況來源）
 *
 * 使用 TomTom Routing API calculateRoute：
 *   - travelTimeInSeconds              依目前即時路況（traffic=true）計算的行車時間
 *   - historicTrafficTravelTimeInSeconds 依歷史路況，「平常這個時段」的行車時間
 *   - noTrafficTravelTimeInSeconds     不塞車時的行車時間
 *   - trafficDelayInSeconds            即時路況造成的延誤
 * 指定 departAt（未來時間）時，TomTom 依歷史路況模型預估，可用於「最佳出發時間」。
 *
 * 需要 .env 的 TOMTOM_API_KEY（地點搜尋已在使用同一把金鑰）。
 * 回傳格式與 Valhalla 路線相同（geometry、duration、distance、legs[].steps[].valhalla），
 * 前端不必分辨來源。
 */

const TOMTOM_BASE = "https://api.tomtom.com/routing/1/calculateRoute";
const TAIPEI_OFFSET = "+08:00";
import { alongRoute } from "./routeRiskSegments.js";

export const hasTomTomKey = () => Boolean(String(process.env.TOMTOM_API_KEY || "").trim());

/* "18:30" → 下一個台北時間 18:30 的 RFC 3339 字串；已過的時間改為明天 */
export function departAtFromClock(hhmm) {
  /* 也接受完整的台北當地時間 "2026-10-16T18:30"（最佳出發時間會指定日期）；已過的時間回傳 null（＝現在出發） */
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(hhmm || "").trim());
  if (iso) {
    const t = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4] - 8, +iso[5]);
    return t > Date.now() + 60 * 1000 ? `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:00${TAIPEI_OFFSET}` : null;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 3600 * 1000); // 以 UTC 欄位表示台北時間
  const target = new Date(Date.UTC(taipeiNow.getUTCFullYear(), taipeiNow.getUTCMonth(), taipeiNow.getUTCDate(), Number(m[1]), Number(m[2])));
  if (target.getTime() <= taipeiNow.getTime() + 60 * 1000) target.setUTCDate(target.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${target.getUTCFullYear()}-${p(target.getUTCMonth() + 1)}-${p(target.getUTCDate())}T${p(target.getUTCHours())}:${p(target.getUTCMinutes())}:00${TAIPEI_OFFSET}`;
}

/* TomTom maneuver → Valhalla 的 type 數字（前端用來選轉彎圖示） */
function maneuverType(maneuver = "") {
  if (/ARRIVE/.test(maneuver)) return 4;
  if (/DEPART/.test(maneuver)) return 1;
  if (/RIGHT/.test(maneuver)) return 10;
  if (/LEFT/.test(maneuver)) return 15;
  return 8;
}

/*
 * TomTom traffic sections → 目前正在塞車／施工的路段（即時資料）
 * magnitudeOfDelay：0 未知、1 輕微、2 中等、3 嚴重、4 封閉／無法估計
 */
const MAGNITUDE = { 0: "未知", 1: "輕微", 2: "中等", 3: "嚴重", 4: "封閉" };
const CATEGORY = { JAM: "壅塞", ROAD_WORK: "施工", ROAD_CLOSURE: "道路封閉", OTHER: "其他事件" };
function toCongestion(route, coords) {
  const sections = (route.sections || []).filter((sec) => sec.sectionType === "TRAFFIC" && Number.isInteger(sec.startPointIndex) && Number.isInteger(sec.endPointIndex));
  if (!sections.length || coords.length < 2) return [];
  const along = alongRoute(coords.map(([lon, lat]) => ({ lat, lon })));
  const ins = route?.guidance?.instructions || [];
  const streetAt = (idx) => { let name = ""; for (const x of ins) if ((x.pointIndex ?? 0) <= idx && x.street) name = x.street; return name; };
  return sections.map((sec, i) => {
    const a = Math.max(0, sec.startPointIndex), b = Math.min(coords.length - 1, sec.endPointIndex);
    const fromM = along.cum[a] ?? 0, toM = along.cum[b] ?? fromM;
    return {
      id: i + 1,
      coords: coords.slice(a, b + 1),
      fromM: Math.round(fromM), toM: Math.round(toM), lengthM: Math.round(toM - fromM),
      center: along.pointAt((fromM + toM) / 2),
      category: sec.simpleCategory || "OTHER", // JAM / ROAD_WORK / ROAD_CLOSURE / OTHER
      categoryText: CATEGORY[sec.simpleCategory] || "其他事件",
      delayMin: Number.isFinite(sec.delayInSeconds) ? sec.delayInSeconds / 60 : null,
      speedKmh: Number.isFinite(sec.effectiveSpeedInKmh) ? sec.effectiveSpeedInKmh : null,
      magnitude: Number.isFinite(sec.magnitudeOfDelay) ? sec.magnitudeOfDelay : 0,
      magnitudeText: MAGNITUDE[sec.magnitudeOfDelay] || "未知",
      street: streetAt(a),
    };
  }).filter((c) => c.coords.length >= 2);
}

function toSteps(route, coords) {
  const list = route?.guidance?.instructions || [];
  if (!list.length) return [];
  return list.map((ins, i) => {
    const next = list[i + 1];
    const distance = next ? Math.max(0, (next.routeOffsetInMeters || 0) - (ins.routeOffsetInMeters || 0)) : 0;
    const duration = next ? Math.max(0, (next.travelTimeInSeconds || 0) - (ins.travelTimeInSeconds || 0)) : 0;
    const pt = ins.point ? [ins.point.longitude, ins.point.latitude] : coords[ins.pointIndex] || coords[0];
    return {
      distance,
      duration,
      name: ins.street || "",
      geometry: { type: "LineString", coordinates: [pt, pt] },
      valhalla: { instruction: ins.message || (ins.street ? `沿 ${ins.street} 前進` : "繼續前進"), type: maneuverType(ins.maneuver) },
    };
  });
}

export async function getTomTomCarRoutes({ startLon, startLat, endLon, endLat, departAt = null, timeoutMs = 12000 }) {
  const key = String(process.env.TOMTOM_API_KEY || "").trim();
  if (!key) throw new Error("TOMTOM_API_KEY 未設定");
  const params = new URLSearchParams({
    key,
    traffic: "true",
    travelMode: "car",
    routeType: "fastest",
    maxAlternatives: "2",
    computeTravelTimeFor: "all",
    routeRepresentation: "polyline",
    instructionsType: "text",
    language: "zh-TW",
    sectionType: "traffic",
  });
  if (departAt) params.set("departAt", departAt);
  const url = `${TOMTOM_BASE}/${startLat},${startLon}:${endLat},${endLon}/json?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 認證或額度錯誤會回 XML */ }
  if (!res.ok || !Array.isArray(data?.routes) || !data.routes.length) {
    const why = data?.detailedError?.message || data?.error?.description || (res.status === 403 ? "金鑰無效或額度用完" : `HTTP ${res.status}`);
    const err = new Error(`TomTom 路線失敗：${why}`);
    err.status = res.status;
    throw err;
  }
  const generatedAt = new Date().toISOString();
  return data.routes.map((route, i) => {
    const coords = (route.legs || []).flatMap((leg) => (leg.points || []).map((p) => [p.longitude, p.latitude]));
    const s = route.summary || {};
    const min = (sec) => (Number.isFinite(sec) ? sec / 60 : null);
    const delayMin = Math.max(0, min(s.trafficDelayInSeconds) ?? 0);
    return {
      routeId: i + 1,
      label: `路線 ${String.fromCharCode(65 + i)}`,
      routingEngine: "tomtom-traffic",
      duration: s.travelTimeInSeconds,
      distance: s.lengthInMeters,
      geometry: { type: "LineString", coordinates: coords },
      legs: [{ steps: toSteps(route, coords) }],
      congestionSegments: toCongestion(route, coords),
      expectedMin: min(s.travelTimeInSeconds),
      distanceKm: Number.isFinite(s.lengthInMeters) ? s.lengthInMeters / 1000 : null,
      delayMin,
      freeFlowMin: min(s.noTrafficTravelTimeInSeconds),
      historicMin: min(s.historicTrafficTravelTimeInSeconds),
      liveIncidentMin: min(s.liveTrafficIncidentsTravelTimeInSeconds),
      departureTime: s.departureTime || null,
      arrivalTime: s.arrivalTime || null,
      trafficSource: "TomTom",
      trafficDescription: delayMin >= 1 ? `目前路況延誤約 ${Math.round(delayMin)} 分鐘` : "目前路況順暢",
      etaGeneratedAt: generatedAt,
      riskStatus: "tomtom",
      worst10Min: null,
    };
  }).filter((r) => r.geometry.coordinates.length >= 2);
}
