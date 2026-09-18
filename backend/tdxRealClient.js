// tdxRealClient.js
// 真正呼叫 TDX API 的 client
// 作用：取得 Access Token、快取 Token、呼叫 TDX API

const TDX_TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const TDX_API_BASE = "https://tdx.transportdata.tw/api/basic/v2";

let cachedToken = null;
let tokenExpireAt = 0;

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function resetCachedToken() {
  cachedToken = null;
  tokenExpireAt = 0;
}

function getEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export async function getTdxAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpireAt - 60 * 1000) {
    return cachedToken;
  }

  const clientId = getEnv("TDX_CLIENT_ID");
  const clientSecret = getEnv("TDX_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetchWithTimeout(TDX_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("TDX token error:", data);
    throw new Error("Failed to get TDX access token");
  }

  cachedToken = data.access_token;
  tokenExpireAt = Date.now() + Number(data.expires_in || 3600) * 1000;

  return cachedToken;
}

export async function tdxGet(path, query = {}) {
  const token = await getTdxAccessToken();

  const url = new URL(TDX_API_BASE + path);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  async function requestOnce(accessToken) {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "accept-encoding": "gzip",
        },
      },
      10000
    );

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return { response, data };
  }

  let result = await requestOnce(token);

  if (result.response.status === 401) {
    resetCachedToken();
    const refreshedToken = await getTdxAccessToken();
    result = await requestOnce(refreshedToken);
  }

  if (!result.response.ok) {
    console.error("TDX API error:", result.response.status, result.data);
    throw new Error(`TDX API failed: ${result.response.status}`);
  }

  return result.data;
}

// 先做一個最簡單的測試：抓高鐵站資料
export async function getTHSRStations() {
  return await tdxGet("/Rail/THSR/Station", {
    $format: "JSON",
  });
}

// 再做一個台鐵站資料測試
export async function getTRAStations() {
  return await tdxGet("/Rail/TRA/Station", {
    $format: "JSON",
  });
}
const THSR_STATION_ALIASES = {
  南港: ["南港", "Nangang"],
  台北: ["台北", "臺北", "Taipei"],
  臺北: ["台北", "臺北", "Taipei"],
  板橋: ["板橋", "Banqiao"],
  桃園: ["桃園", "Taoyuan"],
  新竹: ["新竹", "Hsinchu"],
  苗栗: ["苗栗", "Miaoli"],
  台中: ["台中", "臺中", "Taichung"],
  臺中: ["台中", "臺中", "Taichung"],
  彰化: ["彰化", "Changhua"],
  雲林: ["雲林", "Yunlin"],
  嘉義: ["嘉義", "Chiayi"],
  台南: ["台南", "臺南", "Tainan"],
  臺南: ["台南", "臺南", "Tainan"],
  左營: ["左營", "Zuoying"],
};

function normalizeTimeToMinutes(timeText) {
  const [hh, mm] = String(timeText).split(":").map(Number);

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error("Invalid time format. Use HH:mm, for example 14:00");
  }

  return hh * 60 + mm;
}

function getTHSRStops(train) {
  return train?.StopTimes || [];
}

function getTrainNo(train) {
  return train?.DailyTrainInfo?.TrainNo || train?.TrainNo || "unknown";
}

function getStopName(stop) {
  return (
    stop?.StationName?.Zh_tw ||
    stop?.StationName?.Zh_tw ||
    stop?.StationName?.En ||
    ""
  );
}

function stationMatches(input, stationName) {
  const trimmed = String(input || "").trim();
  const aliases = THSR_STATION_ALIASES[trimmed] || [trimmed];

  return aliases.some((alias) => String(stationName).includes(alias));
}

function findStop(stops, stationInput) {
  return stops.find((stop) => {
    const name = getStopName(stop);
    return stationMatches(stationInput, name);
  });
}

export async function getTHSRTodayTimetable() {
  return await tdxGet("/Rail/THSR/DailyTimetable/Today", {
    $format: "JSON",
  });
}

export async function findNextTHSRTrain({ from, to, time }) {
  const requestedMinutes = normalizeTimeToMinutes(time);
  const timetables = await getTHSRTodayTimetable();

  const candidates = [];

  for (const train of timetables) {
    const stops = getTHSRStops(train);

    if (!Array.isArray(stops) || stops.length === 0) continue;

    const fromStop = findStop(stops, from);
    const toStop = findStop(stops, to);

    if (!fromStop || !toStop) continue;

    const fromSeq = Number(fromStop.StopSequence);
    const toSeq = Number(toStop.StopSequence);

    if (Number.isFinite(fromSeq) && Number.isFinite(toSeq) && fromSeq >= toSeq) {
      continue;
    }

    const departureTime = fromStop.DepartureTime || fromStop.ArrivalTime;
    const arrivalTime = toStop.ArrivalTime || toStop.DepartureTime;

    if (!departureTime || !arrivalTime) continue;

    const departureMinutes = normalizeTimeToMinutes(departureTime);
    const arrivalMinutes = normalizeTimeToMinutes(arrivalTime);

    if (departureMinutes < requestedMinutes) continue;

    candidates.push({
      trainNo: getTrainNo(train),
      fromStationName: getStopName(fromStop),
      toStationName: getStopName(toStop),
      departureTime,
      arrivalTime,
      departureMinutes,
      arrivalMinutes,
      waitMinutes: departureMinutes - requestedMinutes,
      travelMinutes: arrivalMinutes - departureMinutes,
      totalMinutes: arrivalMinutes - requestedMinutes,
    });
  }

  candidates.sort((a, b) => a.departureMinutes - b.departureMinutes);

  const nextTrain = candidates[0];

  if (!nextTrain) return null;

  return {
    trainNo: nextTrain.trainNo,
    fromStationName: nextTrain.fromStationName,
    toStationName: nextTrain.toStationName,
    departureTime: nextTrain.departureTime,
    arrivalTime: nextTrain.arrivalTime,
    waitMinutes: nextTrain.waitMinutes,
    travelMinutes: nextTrain.travelMinutes,
    totalMinutes: nextTrain.totalMinutes,
  };
}
export async function getMetroStations(railSystem = "TRTC") {
  return await tdxGet(`/Rail/Metro/Station/${railSystem}`, {
    $format: "JSON",
  });
}

export async function getMetroLiveBoard(railSystem = "TRTC") {
  return await tdxGet(`/Rail/Metro/LiveBoard/${railSystem}`, {
    $format: "JSON",
  });
}
const MRT_LINE_AVG_MIN_PER_STOP = {
  BL: 2.1,
  R: 2.0,
  G: 2.0,
  O: 2.1,
  BR: 1.8,
  Y: 2.2,
};

function normalizeMrtName(name) {
  return String(name || "")
    .replaceAll("臺", "台")
    .replaceAll("捷運", "")
    .replaceAll("站", "")
    .trim();
}

function getMrtStationName(station) {
  return station?.StationName?.Zh_tw || station?.StationName?.En || "";
}

function getMrtLinePrefix(stationId) {
  const match = String(stationId || "").match(/^[A-Z]+/);
  return match ? match[0] : "";
}

function getMrtStationNumber(stationId) {
  const match = String(stationId || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function stationNameMatches(input, station) {
  const inputName = normalizeMrtName(input);
  const stationName = normalizeMrtName(getMrtStationName(station));

  return (
    stationName === inputName ||
    stationName.includes(inputName) ||
    inputName.includes(stationName)
  );
}

function findMrtStationCandidates(stations, input) {
  return stations.filter((station) => stationNameMatches(input, station));
}

function getMrtFallbackWaitMinutes(time) {
  const [hh, mm] = String(time || "09:00").split(":").map(Number);
  const minutes = hh * 60 + mm;

  if (
    (minutes >= 7 * 60 && minutes <= 9 * 60) ||
    (minutes >= 17 * 60 && minutes <= 19 * 60)
  ) {
    return 3;
  }

  if (minutes >= 22 * 60 || minutes <= 6 * 60) {
    return 8;
  }

  return 5;
}

function findLiveBoardWaitMinutes({
  liveBoard,
  fromStationID,
  directionToStationNumber,
}) {
  if (!Array.isArray(liveBoard)) return null;

  const records = liveBoard.filter((item) => item.StationID === fromStationID);
  if (records.length === 0) return null;

  const fromNo = getMrtStationNumber(fromStationID);

  for (const item of records) {
    const destinationId = item.DestinationStationID || item.DestinationStaionID;
    const destNo = getMrtStationNumber(destinationId);

    if (!Number.isFinite(destNo) || !Number.isFinite(fromNo)) continue;

    if (directionToStationNumber < fromNo && destNo < fromNo) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }

    if (directionToStationNumber > fromNo && destNo > fromNo) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }
  }

  return null;
}

export async function planMrtSameLineRoute({
  from,
  to,
  time = "09:00",
  railSystem = "TRTC",
}) {
  const stations = await getMetroStations(railSystem);
  const liveBoard = await getMetroLiveBoard(railSystem).catch(() => []);

  const fromCandidates = findMrtStationCandidates(stations, from);
  const toCandidates = findMrtStationCandidates(stations, to);

  if (fromCandidates.length === 0) {
    throw new Error(`找不到捷運起站：${from}`);
  }

  if (toCandidates.length === 0) {
    throw new Error(`找不到捷運迄站：${to}`);
  }

  let bestPair = null;

  for (const fromStation of fromCandidates) {
    for (const toStation of toCandidates) {
      const fromLine = getMrtLinePrefix(fromStation.StationID);
      const toLine = getMrtLinePrefix(toStation.StationID);

      if (fromLine && fromLine === toLine) {
        bestPair = {
          fromStation,
          toStation,
          line: fromLine,
        };
        break;
      }
    }

    if (bestPair) break;
  }

  if (!bestPair) {
    return {
      transferRequired: true,
      message: "這兩站不在同一條捷運線，下一步需要做轉乘演算法。",
      fromCandidates: fromCandidates.map((s) => ({
        stationID: s.StationID,
        name: getMrtStationName(s),
      })),
      toCandidates: toCandidates.map((s) => ({
        stationID: s.StationID,
        name: getMrtStationName(s),
      })),
    };
  }

  const fromStationID = bestPair.fromStation.StationID;
  const toStationID = bestPair.toStation.StationID;
  const fromNo = getMrtStationNumber(fromStationID);
  const toNo = getMrtStationNumber(toStationID);

  if (!Number.isFinite(fromNo) || !Number.isFinite(toNo)) {
    throw new Error("捷運站代碼無法解析站號");
  }

  const stopCount = Math.abs(fromNo - toNo);
  const avgMinPerStop = MRT_LINE_AVG_MIN_PER_STOP[bestPair.line] || 2.1;
  const rideMinutes = Math.ceil(stopCount * avgMinPerStop);

  const liveWait = findLiveBoardWaitMinutes({
    liveBoard,
    fromStationID,
    directionToStationNumber: toNo,
  });

  const fallbackWait = getMrtFallbackWaitMinutes(time);
  const waitMinutes = liveWait === null ? fallbackWait : liveWait;

  return {
    transferRequired: false,
    railSystem,
    line: bestPair.line,
    fromStationID,
    toStationID,
    fromStationName: getMrtStationName(bestPair.fromStation),
    toStationName: getMrtStationName(bestPair.toStation),
    stopCount,
    rideMinutes,
    waitMinutes,
    totalMinutes: rideMinutes + waitMinutes,
    waitSource: liveWait === null ? "fallback_by_time_period" : "TDX_liveboard",
    note:
      liveWait === null
        ? "TDX LiveBoard 沒有提供此站此方向即時到站，因此使用時段班距估算等車時間。"
        : "使用 TDX LiveBoard 即時到站資料估算等車時間。",
  };
}
