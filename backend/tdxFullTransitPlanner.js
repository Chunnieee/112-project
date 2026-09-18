// tdxFullTransitPlanner.js
// 真實路線版：walk / drive 用 OSRM 彎曲道路
// mrt / hsr / train / bus 不再用起訖直線
// mrt：用 TDX 捷運站點路徑畫站點折線
// hsr：用高鐵站點順序畫折線
// train：用台鐵停靠站站點畫折線
// bus：用 TDX StopOfRoute 站點畫折線；若 TDX Bus Shape 可用則優先用 shape

import {
  tdxGet,
  getMetroStations,
  getMetroLiveBoard,
  findNextTHSRTrain,
} from "./tdxRealClient.js";

const DEFAULT_OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "http://localhost:5000";

const MODE_LABEL = {
  walk: "步行",
  drive: "開車",
  mrt: "捷運",
  hsr: "高鐵",
  train: "台鐵",
  bus: "公車",
};

const MRT_LINE_AVG_MIN_PER_STOP = {
  BL: 2.1,
  R: 2.0,
  G: 2.0,
  O: 2.1,
  BR: 1.8,
  Y: 2.2,
};

const CITY_ALIASES = {
  台北: "Taipei",
  臺北: "Taipei",
  新北: "NewTaipei",
  桃園: "Taoyuan",
  台中: "Taichung",
  臺中: "Taichung",
  台南: "Tainan",
  臺南: "Tainan",
  高雄: "Kaohsiung",
  基隆: "Keelung",
  新竹: "Hsinchu",
  苗栗: "MiaoliCounty",
  彰化: "ChanghuaCounty",
  南投: "NantouCounty",
  雲林: "YunlinCounty",
  嘉義: "Chiayi",
  屏東: "PingtungCounty",
  宜蘭: "YilanCounty",
  花蓮: "HualienCounty",
  台東: "TaitungCounty",
  臺東: "TaitungCounty",
};

const THSR_STATIONS = [
  { name: "南港", lon: 121.6070, lat: 25.0533 },
  { name: "台北", lon: 121.5170, lat: 25.0478 },
  { name: "板橋", lon: 121.4642, lat: 25.0143 },
  { name: "桃園", lon: 121.2147, lat: 25.0129 },
  { name: "新竹", lon: 121.0393, lat: 24.8084 },
  { name: "苗栗", lon: 120.8256, lat: 24.6054 },
  { name: "台中", lon: 120.6158, lat: 24.1120 },
  { name: "彰化", lon: 120.5746, lat: 23.8744 },
  { name: "雲林", lon: 120.4160, lat: 23.7362 },
  { name: "嘉義", lon: 120.3232, lat: 23.4591 },
  { name: "台南", lon: 120.2858, lat: 22.9249 },
  { name: "左營", lon: 120.3075, lat: 22.6874 },
];

function round(n, d = 1) {
  const p = 10 ** d;
  return Math.round(Number(n || 0) * p) / p;
}

function parseTimeToMinutes(time = "09:00") {
  const [hh, mm] = String(time).split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 9 * 60;
  return hh * 60 + mm;
}

function minutesToHHMM(total) {
  const m = ((Math.round(total) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalizeName(name) {
  return String(name || "")
    .replaceAll("臺", "台")
    .replaceAll("捷運", "")
    .replaceAll("高鐵", "")
    .replaceAll("台鐵", "")
    .replaceAll("火車", "")
    .replaceAll("車站", "")
    .replaceAll("站", "")
    .trim();
}

function stationZh(station) {
  return station?.StationName?.Zh_tw || station?.StationName?.En || "";
}

function stopZh(stop) {
  return (
    stop?.StopName?.Zh_tw ||
    stop?.StopName?.En ||
    stop?.StationName?.Zh_tw ||
    stop?.StationName?.En ||
    ""
  );
}

function stationMatch(input, stationOrStop) {
  const a = normalizeName(input);
  const b = normalizeName(stationZh(stationOrStop) || stopZh(stationOrStop));

  return a === b || a.includes(b) || b.includes(a);
}

function linePrefix(stationId) {
  return String(stationId || "").match(/^[A-Z]+/)?.[0] || "";
}

function stationNo(stationId) {
  const n = String(stationId || "").match(/\d+/)?.[0];
  return n ? Number(n) : null;
}

function getPosition(obj) {
  const pos =
    obj?.StationPosition ||
    obj?.StopPosition ||
    obj?.Position ||
    obj?.StopPointPosition;

  if (!pos) return null;

  const lon = Number(pos.PositionLon ?? pos.lon ?? pos.lng);
  const lat = Number(pos.PositionLat ?? pos.lat);

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  return [lon, lat];
}

function geometryFromObjects(items) {
  const coordinates = items.map(getPosition).filter(Boolean);

  if (coordinates.length < 2) return null;

  return {
    type: "LineString",
    coordinates,
  };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(s));
}

function straightGeometry(start, end) {
  return {
    type: "LineString",
    coordinates: [
      [start.lon, start.lat],
      [end.lon, end.lat],
    ],
  };
}

function geometryDistanceKm(geometry) {
  const coordinates = geometry?.coordinates || [];
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const [lon1, lat1] = coordinates[i - 1] || [];
    const [lon2, lat2] = coordinates[i] || [];
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) continue;
    total += haversineKm(
      { lat: lat1, lon: lon1 },
      { lat: lat2, lon: lon2 }
    );
  }
  return total;
}

async function osrmRoute(
  start,
  end,
  profile = "driving",
  osrmBaseUrl = DEFAULT_OSRM_BASE_URL
) {
  const url =
    `${osrmBaseUrl}/route/v1/${profile}/` +
    `${start.lon},${start.lat};${end.lon},${end.lat}` +
    `?overview=full&geometries=geojson&steps=true`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.code !== "Ok" || !data.routes?.[0]) {
    throw new Error(`OSRM ${profile} failed`);
  }

  const route = data.routes[0];

  return {
    mode: profile === "foot" ? "walk" : "drive",
    rideMinutes: route.duration / 60,
    waitMinutes: 0,
    totalMinutes: route.duration / 60,
    distanceKm: route.distance / 1000,
    geometry: route.geometry,
    source: `OSRM ${profile}`,
    detail: null,
  };
}

async function osrmOrFallback(start, end, options) {
  const { profile, speedKmh, osrmBaseUrl } = options;

  try {
    return await osrmRoute(start, end, profile, osrmBaseUrl);
  } catch {
    const distanceKm = haversineKm(start, end);
    const totalMinutes = (distanceKm / speedKmh) * 60;

    return {
      mode: profile === "foot" ? "walk" : "drive",
      rideMinutes: totalMinutes,
      waitMinutes: 0,
      totalMinutes,
      distanceKm,
      geometry: straightGeometry(start, end),
      source: `fallback ${speedKmh}km/h`,
      detail: null,
    };
  }
}

function mrtWaitByTime(time) {
  const m = parseTimeToMinutes(time);

  if ((m >= 7 * 60 && m <= 9 * 60) || (m >= 17 * 60 && m <= 19 * 60)) {
    return 3;
  }

  if (m >= 22 * 60 || m <= 6 * 60) {
    return 8;
  }

  return 5;
}

function liveBoardWait({ liveBoard, fromStationID, nextStationID }) {
  const records = (liveBoard || []).filter((x) => x.StationID === fromStationID);
  if (!records.length) return null;

  const fromNo = stationNo(fromStationID);
  const nextNo = stationNo(nextStationID);

  if (!Number.isFinite(fromNo) || !Number.isFinite(nextNo)) return null;

  for (const item of records) {
    const destId = item.DestinationStationID || item.DestinationStaionID;
    const destNo = stationNo(destId);

    if (!Number.isFinite(destNo)) continue;

    if (nextNo < fromNo && destNo < fromNo) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }

    if (nextNo > fromNo && destNo > fromNo) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }
  }

  return null;
}

function buildMrtGraph(stations) {
  const nodes = new Map();
  const edges = new Map();

  for (const s of stations) {
    nodes.set(s.StationID, s);
    edges.set(s.StationID, []);
  }

  const byLine = new Map();

  for (const s of stations) {
    const line = linePrefix(s.StationID);
    if (!line) continue;

    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(s);
  }

  for (const [line, arr] of byLine.entries()) {
    arr.sort((a, b) => stationNo(a.StationID) - stationNo(b.StationID));

    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i].StationID;
      const b = arr[i + 1].StationID;
      const w = MRT_LINE_AVG_MIN_PER_STOP[line] || 2.1;

      edges.get(a).push({ to: b, minutes: w, type: "ride", line });
      edges.get(b).push({ to: a, minutes: w, type: "ride", line });
    }
  }

  const byName = new Map();

  for (const s of stations) {
    const name = normalizeName(stationZh(s));
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s);
  }

  for (const arr of byName.values()) {
    if (arr.length < 2) continue;

    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i].StationID;
        const b = arr[j].StationID;

        edges.get(a).push({ to: b, minutes: 5, type: "transfer" });
        edges.get(b).push({ to: a, minutes: 5, type: "transfer" });
      }
    }
  }

  return { nodes, edges };
}

function dijkstra(graph, starts, goals) {
  const goalSet = new Set(goals.map((x) => x.StationID));
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();

  for (const id of graph.nodes.keys()) {
    dist.set(id, Infinity);
  }

  for (const s of starts) {
    dist.set(s.StationID, 0);
  }

  while (true) {
    let u = null;
    let best = Infinity;

    for (const [id, d] of dist.entries()) {
      if (!visited.has(id) && d < best) {
        u = id;
        best = d;
      }
    }

    if (!u) break;

    if (goalSet.has(u)) {
      const path = [];
      let cur = u;

      while (cur) {
        path.unshift(cur);
        cur = prev.get(cur)?.from;
      }

      return { minutes: best, path, goal: u, prev };
    }

    visited.add(u);

    for (const e of graph.edges.get(u) || []) {
      const nd = best + e.minutes;

      if (nd < dist.get(e.to)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: u, edge: e });
      }
    }
  }

  return null;
}

async function planMrtRoute({ from, to, time = "09:00", railSystem = "TRTC" }) {
  const stations = await getMetroStations(railSystem);
  const liveBoard = await getMetroLiveBoard(railSystem).catch(() => []);

  const fromStations = stations.filter((s) => stationMatch(from, s));
  const toStations = stations.filter((s) => stationMatch(to, s));

  if (!fromStations.length) {
    throw new Error(`找不到捷運起站：${from}`);
  }

  if (!toStations.length) {
    throw new Error(`找不到捷運迄站：${to}`);
  }

  const graph = buildMrtGraph(stations);
  const result = dijkstra(graph, fromStations, toStations);

  if (!result) {
    throw new Error(`找不到捷運路徑：${from} → ${to}`);
  }

  const pathStations = result.path.map((id) => graph.nodes.get(id));
  const first = result.path[0];
  const second = result.path[1] || result.path[0];

  const liveWait = liveBoardWait({
    liveBoard,
    fromStationID: first,
    nextStationID: second,
  });

  const waitMinutes = liveWait === null ? mrtWaitByTime(time) : liveWait;
  const rideMinutes = Math.ceil(result.minutes);

  const transferCount = result.path.filter((id, index) => {
    if (index === 0) return false;
    return result.prev.get(id)?.edge?.type === "transfer";
  }).length;

  const geometry = geometryFromObjects(pathStations);

  if (!geometry) {
    throw new Error(`捷運沒有取得站點 geometry：${from} → ${to}`);
  }

  return {
    mode: "mrt",
    label: "捷運",
    fromStationID: first,
    toStationID: result.goal,
    fromStationName: stationZh(graph.nodes.get(first)),
    toStationName: stationZh(graph.nodes.get(result.goal)),
    path: pathStations.map((s) => ({
      stationID: s.StationID,
      name: stationZh(s),
      line: linePrefix(s.StationID),
    })),
    transferCount,
    rideMinutes,
    waitMinutes,
    totalMinutes: rideMinutes + waitMinutes,
    waitSource: liveWait === null ? "fallback_by_time_period" : "TDX_liveboard",
    distanceKm: round(geometryDistanceKm(geometry), 2),
    geometry,
    source: "TDX Metro station path + LiveBoard when available",
    detail: {
      pathStationCount: pathStations.length,
      geometryPointCount: geometry.coordinates.length,
    },
  };
}

function findTHSRIndex(name) {
  const n = normalizeName(name);
  return THSR_STATIONS.findIndex((s) => normalizeName(s.name) === n);
}

function thsrGeometry(from, to) {
  const fromIndex = findTHSRIndex(from);
  const toIndex = findTHSRIndex(to);

  if (fromIndex === -1 || toIndex === -1) return null;

  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);

  let stations = THSR_STATIONS.slice(start, end + 1);

  if (fromIndex > toIndex) {
    stations = stations.reverse();
  }

  return {
    type: "LineString",
    coordinates: stations.map((s) => [s.lon, s.lat]),
  };
}

async function planTHSRRoute({ from, to, time }) {
  const cleanFrom = normalizeName(from);
  const cleanTo = normalizeName(to);

  const geometry = thsrGeometry(cleanFrom, cleanTo);

  if (!geometry) {
    throw new Error(
      `高鐵站名必須是高鐵站，例如：南港、台北、板橋、桃園、新竹、苗栗、台中、彰化、雲林、嘉義、台南、左營。你輸入的是：${from} → ${to}`
    );
  }

  try {
    const train = await findNextTHSRTrain({
      from: cleanFrom,
      to: cleanTo,
      time,
    });

    if (train) {
      return {
        mode: "hsr",
        label: "高鐵",
        rideMinutes: train.travelMinutes,
        waitMinutes: train.waitMinutes,
        totalMinutes: train.totalMinutes,
        distanceKm: round(geometryDistanceKm(geometry), 2),
        geometry,
        source: "TDX THSR DailyTimetable + THSR station path",
        detail: train,
      };
    }
  } catch (error) {
    console.log("TDX THSR timetable unavailable, using fallback:", error.message);
  }

  const fromIndex = findTHSRIndex(cleanFrom);
  const toIndex = findTHSRIndex(cleanTo);
  const stopDiff = Math.abs(toIndex - fromIndex);

  const fallbackTable = {
    "台北-左營": 95,
    "南港-左營": 105,
    "板橋-左營": 90,
    "台北-台南": 90,
    "台北-台中": 50,
    "台北-桃園": 20,
    "台中-左營": 45,
    "台南-左營": 15,
  };

  const key1 = `${cleanFrom}-${cleanTo}`;
  const key2 = `${cleanTo}-${cleanFrom}`;

  const rideMinutes =
    fallbackTable[key1] ||
    fallbackTable[key2] ||
    Math.max(15, stopDiff * 10);

  const waitMinutes = 15;

  return {
    mode: "hsr",
    label: "高鐵",
    rideMinutes,
    waitMinutes,
    totalMinutes: rideMinutes + waitMinutes,
    distanceKm: round(geometryDistanceKm(geometry), 2),
    geometry,
    source: "Fallback THSR estimated timetable because TDX rate limit exceeded",
    detail: {
      note: "TDX rate limit exceeded, using demo fallback estimate.",
      from: cleanFrom,
      to: cleanTo,
      rideMinutes,
      waitMinutes,
    },
  };
}
async function getTRAStations() {
  return await tdxGet("/Rail/TRA/Station", {
    $format: "JSON",
  });
}

function railTrainNo(train) {
  return (
    train?.DailyTrainInfo?.TrainNo ||
    train?.TrainNo ||
    train?.TrainInfo?.TrainNo ||
    "unknown"
  );
}

async function planTRARoute({ from, to, time }) {
  const stations = await getTRAStations();

  const fromStation = stations.find((s) => stationMatch(from, s));
  const toStation = stations.find((s) => stationMatch(to, s));

  if (!fromStation) throw new Error(`找不到台鐵起站：${from}`);
  if (!toStation) throw new Error(`找不到台鐵迄站：${to}`);

  const timetables = await tdxGet("/Rail/TRA/DailyTrainTimetable/Today", {
    $format: "JSON",
  });

  const requested = parseTimeToMinutes(time);
  const stationMap = new Map(stations.map((s) => [String(s.StationID), s]));
  const candidates = [];

  for (const train of timetables) {
    const stops = train?.StopTimes || train?.DailyTrainInfo?.StopTimes || [];
    if (!Array.isArray(stops) || !stops.length) continue;

    const fs = stops.find((s) => String(s.StationID) === String(fromStation.StationID));
    const ts = stops.find((s) => String(s.StationID) === String(toStation.StationID));

    if (!fs || !ts) continue;

    const fseq = Number(fs.StopSequence);
    const tseq = Number(ts.StopSequence);

    if (!Number.isFinite(fseq) || !Number.isFinite(tseq) || fseq >= tseq) {
      continue;
    }

    const dep = fs.DepartureTime || fs.ArrivalTime;
    const arr = ts.ArrivalTime || ts.DepartureTime;

    if (!dep || !arr) continue;

    const depMin = parseTimeToMinutes(dep);
    let arrMin = parseTimeToMinutes(arr);
    if (arrMin < depMin) arrMin += 24 * 60;

    if (depMin < requested) continue;

    const slicedStops = stops.slice(fseq - 1, tseq);

    const stationObjects = slicedStops
      .map((stop) => stationMap.get(String(stop.StationID)))
      .filter(Boolean);

    candidates.push({
      trainNo: railTrainNo(train),
      departureTime: dep,
      arrivalTime: arr,
      waitMinutes: depMin - requested,
      travelMinutes: arrMin - depMin,
      totalMinutes: arrMin - requested,
      geometry: geometryFromObjects(stationObjects),
      stationPath: stationObjects.map((s) => stationZh(s)),
    });
  }

  candidates.sort((a, b) => a.waitMinutes - b.waitMinutes);

  const best = candidates[0];

  if (!best) {
    throw new Error(`找不到台鐵班次：${from} → ${to} after ${time}`);
  }

  if (!best.geometry) {
    throw new Error(`台鐵沒有取得站點 geometry：${from} → ${to}`);
  }

  return {
    mode: "train",
    label: "台鐵",
    rideMinutes: best.travelMinutes,
    waitMinutes: best.waitMinutes,
    totalMinutes: best.totalMinutes,
    distanceKm: round(geometryDistanceKm(best.geometry), 2),
    geometry: best.geometry,
    source: "TDX TRA DailyTrainTimetable + TRA station path",
    detail: best,
  };
}

function normalizeCity(city) {
  return CITY_ALIASES[city] || city || "Taipei";
}

function findStopByName(stops, input) {
  return stops.find((s) => stationMatch(input, s));
}

function parseWktLineString(wkt) {
  if (!wkt || typeof wkt !== "string") return null;

  const match = wkt.match(/LINESTRING\s*\((.+)\)/i);
  if (!match) return null;

  const coordinates = match[1]
    .split(",")
    .map((pair) => {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return [lon, lat];
    })
    .filter(Boolean);

  if (coordinates.length < 2) return null;

  return {
    type: "LineString",
    coordinates,
  };
}

function geometryFromShape(shape) {
  if (!shape) return null;

  const possible =
    shape.Geometry ||
    shape.geometry ||
    shape.Shape ||
    shape.shape ||
    shape.EncodedPolyline ||
    shape.encodedPolyline ||
    shape.Polyline ||
    shape.polyline;

  if (!possible) return null;

  if (typeof possible === "object") {
    if (possible.type === "LineString" && Array.isArray(possible.coordinates)) {
      return possible;
    }

    if (possible.type === "MultiLineString" && Array.isArray(possible.coordinates)) {
      return {
        type: "LineString",
        coordinates: possible.coordinates.flat(),
      };
    }
  }

  if (typeof possible === "string") {
    const trimmed = possible.trim();

    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);

        if (parsed.type === "LineString") return parsed;

        if (parsed.type === "MultiLineString") {
          return {
            type: "LineString",
            coordinates: parsed.coordinates.flat(),
          };
        }
      } catch {}
    }

    return parseWktLineString(trimmed);
  }

  return null;
}

async function getBusShapeGeometry(cityCode, routeName) {
  try {
    const shapes = await tdxGet(
      `/Bus/Shape/City/${cityCode}/${encodeURIComponent(routeName)}`,
      {
        $format: "JSON",
      }
    );

    return geometryFromShape(shapes?.[0]);
  } catch {
    return null;
  }
}

async function planBusRoute({ from, to, city, routeName }) {
  if (!city || !routeName) {
    throw new Error(
      "公車真實路線需要 city 和 routeName，例如 city=Taipei, routeName=307。"
    );
  }

  const cityCode = normalizeCity(city);
  const encodedRoute = encodeURIComponent(routeName);

  const eta = await tdxGet(
    `/Bus/EstimatedTimeOfArrival/City/${cityCode}/${encodedRoute}`,
    {
      $format: "JSON",
    }
  );

  const stopOfRoute = await tdxGet(
    `/Bus/StopOfRoute/City/${cityCode}/${encodedRoute}`,
    {
      $format: "JSON",
    }
  );

  const directions = [];

  for (const dir of stopOfRoute) {
    const stops = dir.Stops || [];
    const fs = findStopByName(stops, from);
    const ts = findStopByName(stops, to);

    if (!fs || !ts) continue;

    const fseq = Number(fs.StopSequence);
    const tseq = Number(ts.StopSequence);

    if (Number.isFinite(fseq) && Number.isFinite(tseq) && fseq < tseq) {
      directions.push({
        direction: dir.Direction,
        stops,
        fromStop: fs,
        toStop: ts,
        fromSeq: fseq,
        toSeq: tseq,
        stopCount: tseq - fseq,
      });
    }
  }

  const best = directions[0];

  if (!best) {
    throw new Error(`找不到公車 ${routeName} 的站序：${from} → ${to}`);
  }

  const etaRecords = eta.filter(
    (x) => Number(x.Direction) === Number(best.direction)
  );

  const fromEta = etaRecords.find((x) => {
    const name = x.StopName?.Zh_tw || x.StopName?.En || "";
    return normalizeName(name) === normalizeName(stopZh(best.fromStop));
  });

  let waitMinutes = 8;
  let waitSource = "fallback";

  if (fromEta && Number.isFinite(Number(fromEta.EstimateTime))) {
    waitMinutes = Math.max(0, Math.ceil(Number(fromEta.EstimateTime) / 60));
    waitSource = "TDX_bus_ETA";
  }

  const shapeGeometry = await getBusShapeGeometry(cityCode, routeName);
  const stopGeometry = geometryFromObjects(
    best.stops.slice(best.fromSeq - 1, best.toSeq)
  );

  const geometry = shapeGeometry || stopGeometry;

  if (!geometry) {
    throw new Error(`公車沒有取得路線 geometry：${routeName}`);
  }

  const distanceKm = geometryDistanceKm(geometry);
  // Without the value-added stop-to-stop travel-time API, use a conservative
  // blend of route distance and stop count rather than the old fixed 2.5 min/stop.
  const distanceEstimateMin = distanceKm > 0 ? (distanceKm / 18) * 60 : 0;
  const stopEstimateMin = best.stopCount * 1.4;
  const rideMinutes = Math.max(3, Math.ceil(Math.max(distanceEstimateMin, stopEstimateMin)));

  return {
    mode: "bus",
    label: "公車",
    routeName,
    city: cityCode,
    direction: best.direction,
    fromStopName: stopZh(best.fromStop),
    toStopName: stopZh(best.toStop),
    stopCount: best.stopCount,
    rideMinutes,
    waitMinutes,
    totalMinutes: rideMinutes + waitMinutes,
    waitSource,
    distanceKm: round(distanceKm, 2),
    geometry,
    source: shapeGeometry
      ? "TDX Bus Shape + ETA"
      : "TDX Bus StopOfRoute station path + ETA",
    detail: fromEta || null,
  };
}

export async function planSegment({
  start,
  end,
  mode,
  departureTime,
  options = {},
  osrmBaseUrl = DEFAULT_OSRM_BASE_URL,
}) {
  if (mode === "walk") {
  // 走路不能用開車時間。
  // 優先使用 OSRM foot；如果本機 OSRM 沒有 foot profile，
  // 才用 driving 的 geometry，但時間一定重新用步行速度計算。
  try {
    const footRoute = await osrmRoute(start, end, "foot", osrmBaseUrl);

    return {
      ...footRoute,
      mode: "walk",
      label: "步行",
      rideMinutes: footRoute.distanceKm / 4.8 * 60,
      waitMinutes: 0,
      totalMinutes: footRoute.distanceKm / 4.8 * 60,
      source: "OSRM foot geometry + walking speed 4.8 km/h",
    };
  } catch {
    try {
      const drivingGeometryRoute = await osrmRoute(
        start,
        end,
        "driving",
        osrmBaseUrl
      );

      const walkingMinutes = (drivingGeometryRoute.distanceKm / 4.8) * 60;

      return {
        mode: "walk",
        label: "步行",
        rideMinutes: walkingMinutes,
        waitMinutes: 0,
        totalMinutes: walkingMinutes,
        distanceKm: drivingGeometryRoute.distanceKm,
        geometry: drivingGeometryRoute.geometry,
        source:
          "OSRM driving geometry fallback + walking speed 4.8 km/h",
        detail: {
          note:
            "Local OSRM has no foot profile. Geometry uses road path, but time is recalculated as walking time.",
          walkingSpeedKmh: 4.8,
        },
      };
    } catch {
      const distanceKm = haversineKm(start, end);
      const walkingMinutes = (distanceKm / 4.8) * 60;

      return {
        mode: "walk",
        label: "步行",
        rideMinutes: walkingMinutes,
        waitMinutes: 0,
        totalMinutes: walkingMinutes,
        distanceKm,
        geometry: straightGeometry(start, end),
        source: "straight distance fallback + walking speed 4.8 km/h",
        detail: {
          walkingSpeedKmh: 4.8,
        },
      };
    }
  }
}

  if (mode === "drive") {
    return await osrmOrFallback(start, end, {
      profile: "driving",
      speedKmh: 35,
      osrmBaseUrl,
    });
  }

  if (mode === "mrt") {
    const result = await planMrtRoute({
      from: start.name,
      to: end.name,
      time: departureTime,
      railSystem: options.railSystem || "TRTC",
    });

    if (!result.geometry) {
      throw new Error(`捷運沒有取得實際路線 geometry：${start.name} → ${end.name}`);
    }

    return result;
  }

  if (mode === "hsr") {
    const result = await planTHSRRoute({
      from: start.name,
      to: end.name,
      time: departureTime,
    });

    if (!result.geometry) {
      throw new Error(`高鐵沒有取得實際路線 geometry：${start.name} → ${end.name}`);
    }

    return result;
  }

  if (mode === "train") {
    const result = await planTRARoute({
      from: start.name,
      to: end.name,
      time: departureTime,
    });

    if (!result.geometry) {
      throw new Error(`台鐵沒有取得實際路線 geometry：${start.name} → ${end.name}`);
    }

    return result;
  }

  if (mode === "bus") {
    const result = await planBusRoute({
      from: start.name,
      to: end.name,
      city: options.city,
      routeName: options.routeName,
    });

    if (!result.geometry) {
      throw new Error(`公車沒有取得實際路線 geometry：${start.name} → ${end.name}`);
    }

    return result;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

export function addMinutesToTime(time, addMinutes) {
  return minutesToHHMM(parseTimeToMinutes(time) + addMinutes);
}

export { MODE_LABEL };