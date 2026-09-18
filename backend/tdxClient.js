const TDX_TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

// 先暫存 token，避免每次 API 都重新拿 token
let cachedToken = null;
let tokenExpireAt = 0;

// TDX 會員方案有不同的存取頻率限制。
// 所有 TDX GET request 經過同一個 queue，避免 Promise.all 一瞬間打出十幾個 request 而收到 HTTP 429。
const TDX_MIN_INTERVAL_MS = Math.max(150, Number(process.env.TDX_MIN_INTERVAL_MS || 450));
let tdxRequestChain = Promise.resolve();
let lastTdxRequestAt = 0;
let tdxCooldownUntil = 0;

const tdxResponseCache = new Map();
const tdxInFlight = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreshTdxResponseCache(url, maxAgeMs) {
  if (!maxAgeMs) return null;
  const item = tdxResponseCache.get(url);
  if (!item) return null;
  if (Date.now() - item.at > maxAgeMs) {
    tdxResponseCache.delete(url);
    return null;
  }
  return item.value;
}

async function scheduleTdxRequest(task) {
  const run = async () => {
    const now = Date.now();
    const normalWait = Math.max(0, TDX_MIN_INTERVAL_MS - (now - lastTdxRequestAt));
    const cooldownWait = Math.max(0, tdxCooldownUntil - now);
    const waitMs = Math.max(normalWait, cooldownWait);
    if (waitMs > 0) await sleep(waitMs);

    lastTdxRequestAt = Date.now();
    return await task();
  };

  const scheduled = tdxRequestChain.then(run, run);
  // Keep the queue alive even if one request fails.
  tdxRequestChain = scheduled.catch(() => {});
  return scheduled;
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return 1500;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - Date.now());
  return 1500;
}

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

export async function getTdxAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpireAt) {
    return cachedToken;
  }

  const clientId = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in .env");
  }

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);

  const response = await fetchWithTimeout(TDX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("TDX token error:", data);
    throw new Error("Failed to get TDX access token");
  }

  cachedToken = data.access_token;

  // expires_in 通常是秒，這裡提早 60 秒更新
  tokenExpireAt = now + (data.expires_in - 60) * 1000;

  return cachedToken;
}

export async function fetchTdxJson(
  url,
  { timeoutMs = 10000, cacheMs = 0, max429Retries = 1 } = {}
) {
  const cached = getFreshTdxResponseCache(url, cacheMs);
  if (cached !== null) return cached;

  if (tdxInFlight.has(url)) {
    return await tdxInFlight.get(url);
  }

  const promise = (async () => {
    async function requestOnce(token) {
      return await scheduleTdxRequest(async () => {
        const response = await fetchWithTimeout(
          url,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
          },
          timeoutMs
        );

        const text = await response.text();
        let data = null;

        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }

        return { response, data };
      });
    }

    let token = await getTdxAccessToken();
    let result = await requestOnce(token);

    // Refresh a stale token once.
    if (result.response.status === 401) {
      resetCachedToken();
      token = await getTdxAccessToken();
      result = await requestOnce(token);
    }

    // 429 means rate limited, not "location not found".
    // Respect Retry-After and retry at most once by default.
    let retryCount = 0;
    while (result.response.status === 429 && retryCount < max429Retries) {
      const waitMs = retryAfterMs(result.response);
      tdxCooldownUntil = Math.max(tdxCooldownUntil, Date.now() + waitMs);
      await sleep(waitMs);
      result = await requestOnce(token);
      retryCount += 1;
    }

    if (!result.response.ok) {
  console.error(
    "TDX API error:",
    result.response.status,
    result.data
  );

  let detail = "";

  try {
    detail =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);
  } catch {
    detail = String(result.data || "");
  }

  if (detail.length > 600) {
    detail = detail.slice(0, 600) + "...";
  }

  const error = new Error(
    `TDX API request failed: HTTP ${result.response.status}` +
      (detail ? ` - ${detail}` : "")
  );

  error.status = result.response.status;

  error.code =
    result.response.status === 429
      ? "TDX_RATE_LIMIT"
      : "TDX_HTTP_ERROR";

  error.tdxDetail = result.data;

  if (result.response.status === 429) {
    const waitMs = retryAfterMs(result.response);

    error.retryAfterMs = waitMs;

    tdxCooldownUntil = Math.max(
      tdxCooldownUntil,
      Date.now() + waitMs
    );
  }

  throw error;
}

    if (cacheMs > 0) {
      tdxResponseCache.set(url, { at: Date.now(), value: result.data });
    }

    return result.data;
  })();

  tdxInFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    tdxInFlight.delete(url);
  }
}

// 先抓國道即時路段旅行時間資料作為第一版 live traffic source
export async function getFreewayLiveTravelTimes() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway/TravelTime?$format=JSON";

  return await fetchTdxJson(url, { cacheMs: 30 * 1000 });
}

// 測試 token 用
export async function testTdxConnection() {
  const token = await getTdxAccessToken();

  return {
    ok: true,
    tokenPreview: token.slice(0, 12) + "..."
  };
}
// 測試：國道即時路況
export async function getFreewayLiveTraffic() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON";

  return await fetchTdxJson(url, { cacheMs: 30 * 1000 });
}

// 測試：省道即時路況
export async function getHighwayLiveTraffic() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Highway?$format=JSON";

  return await fetchTdxJson(url, { cacheMs: 30 * 1000 });
}

// 測試：國道即時事件
export async function getFreewayLiveIncident() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway/Incident?$format=JSON";

  return await fetchTdxJson(url, { cacheMs: 60 * 1000 });
}

// 測試：省道即時事件
export async function getHighwayLiveIncident() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Highway/Incident?$format=JSON";

  return await fetchTdxJson(url, { cacheMs: 60 * 1000 });
}


// ---------------------------------------------------------
// TDX city-level VD (Vehicle Detector) support
// ---------------------------------------------------------
// Static VD metadata changes slowly, so cache it for 6 hours.
// Individual live VD readings are cached for 45 seconds to avoid
// hammering TDX when the user requests multiple alternative routes.
const cityVdStaticCache = new Map();
const cityVdLiveCache = new Map();
const CITY_VD_STATIC_CACHE_MS = 6 * 60 * 60 * 1000;
const CITY_VD_LIVE_CACHE_MS = 45 * 1000;

function readFreshCache(cache, key, maxAgeMs) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.at > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

export async function getCityVDStatic(city) {
  const cityName = String(city || "").trim();
  if (!cityName) throw new Error("Missing TDX city name");

  const cacheKey = cityName.toLowerCase();
  const cached = readFreshCache(
    cityVdStaticCache,
    cacheKey,
    CITY_VD_STATIC_CACHE_MS
  );
  if (cached) return cached;

  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/City/${encodeURIComponent(cityName)}` +
    `?$format=JSON`;

  const data = await fetchTdxJson(url, { timeoutMs: 12000, cacheMs: CITY_VD_STATIC_CACHE_MS });
  cityVdStaticCache.set(cacheKey, { at: Date.now(), value: data });
  return data;
}

export async function getCityVDLive(city, vdId) {
  const cityName = String(city || "").trim();
  const id = String(vdId || "").trim();
  if (!cityName || !id) throw new Error("Missing city or VDID");

  const cacheKey = `${cityName.toLowerCase()}:${id}`;
  const cached = readFreshCache(
    cityVdLiveCache,
    cacheKey,
    CITY_VD_LIVE_CACHE_MS
  );
  if (cached) return cached;

  // TDX documents city VD live data as a per-device endpoint.
  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/City/${encodeURIComponent(cityName)}/` +
    `${encodeURIComponent(id)}?$format=JSON`;

  const data = await fetchTdxJson(url, { timeoutMs: 10000, cacheMs: CITY_VD_LIVE_CACHE_MS });
  cityVdLiveCache.set(cacheKey, { at: Date.now(), value: data });
  return data;
}


// ---------------------------------------------------------
// TDX city published-section live traffic
// ---------------------------------------------------------
// These endpoints expose the road authority's published sections and their
// current TravelTime / TravelSpeed. Static geometry/link mapping is cached
// for hours; live traffic is cached briefly.
const CITY_SECTION_STATIC_CACHE_MS = 6 * 60 * 60 * 1000;
const CITY_SECTION_LIVE_CACHE_MS = 30 * 1000;

// ---------------------------------------------------------
// TDX city published-section live traffic
// ---------------------------------------------------------



// =========================================================
// Section Shape
// =========================================================

export async function getCitySectionShapes(city) {
  const cityName =
    String(city || "").trim();

  if (!cityName) {
    throw new Error(
      "Missing TDX city name"
    );
  }

  /*
    不使用 $select。

    原因：
    不同 TDX endpoint / city schema
    可用欄位不完全相同。

    如果 $select 裡面放到不存在的欄位，
    TDX 會直接回 HTTP 400。
  */

  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/SectionShape/City/` +
    `${encodeURIComponent(cityName)}` +
    `?%24format=JSON`;

  console.log(
    "[TDX] SectionShape:",
    url
  );

  return await fetchTdxJson(
    url,
    {
      timeoutMs: 25000,
      cacheMs:
        CITY_SECTION_STATIC_CACHE_MS,
    }
  );
}


// =========================================================
// Section Link
// =========================================================

export async function getCitySectionLinks(city) {
  const cityName =
    String(city || "").trim();

  if (!cityName) {
    throw new Error(
      "Missing TDX city name"
    );
  }

  /*
    IMPORTANT:

    不可以寫：

    $select=SectionID,SectionUID,...

    因為 TDX SectionLink
    沒有 SectionUID。

    直接抓原始 JSON，
    再由程式自己解析。
  */

  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/SectionLink/City/` +
    `${encodeURIComponent(cityName)}` +
    `?%24format=JSON`;

  console.log(
    "[TDX] SectionLink:",
    url
  );

  return await fetchTdxJson(
    url,
    {
      timeoutMs: 25000,
      cacheMs:
        CITY_SECTION_STATIC_CACHE_MS,
    }
  );
}


// =========================================================
// Live City Traffic
// =========================================================

export async function getCityLiveTraffic(city) {
  const cityName =
    String(city || "").trim();

  if (!cityName) {
    throw new Error(
      "Missing TDX city name"
    );
  }

  /*
    這裡同樣完全不用 $select。

    TravelTime / TravelSpeed
    從 TDX 完整回傳資料內解析。

    這樣不會再因為 OData 欄位名稱
    不相容而 HTTP 400。
  */

  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/City/` +
    `${encodeURIComponent(cityName)}` +
    `?%24format=JSON`;

  console.log(
    "[TDX] Live City:",
    url
  );

  return await fetchTdxJson(
    url,
    {
      timeoutMs: 20000,
      cacheMs:
        CITY_SECTION_LIVE_CACHE_MS,
    }
  );
}

function readSignedInt24BE(buffer, offset) {
  let value =
    (buffer[offset] << 16) |
    (buffer[offset + 1] << 8) |
    buffer[offset + 2];

  // sign extension for 24-bit signed integer
  if (value & 0x800000) {
    value = value | 0xff000000;
  }

  return value;
}

function decodeOpenLRStringToPolyline(openlrString) {
  const buffer = Buffer.from(openlrString, "base64");

  if (buffer.length < 10) {
    return [];
  }

  const points = [];

  // OpenLR absolute coordinate:
  // 24-bit signed integer, scaled by 360 / 2^24
  let lng = (readSignedInt24BE(buffer, 1) * 360) / 16777216;
  let lat = (readSignedInt24BE(buffer, 4) * 360) / 16777216;

  points.push({
    lat,
    lng,
  });

  /*
    After the first absolute coordinate, later OpenLR points use
    relative longitude / latitude offsets.

    Each relative point roughly follows:
    relLon: 2 bytes
    relLat: 2 bytes
    attributes: about 3 bytes

    The coordinate offset scale is 0.00001 degrees.
  */
  let index = 10;

  while (index + 4 <= buffer.length - 2) {
    const relLng = buffer.readInt16BE(index) * 0.00001;
    const relLat = buffer.readInt16BE(index + 2) * 0.00001;

    lng += relLng;
    lat += relLat;

    points.push({
      lat,
      lng,
    });

    // move to next relative point
    index += 7;
  }

  return points;
}

export function openLrToPolyline(input) {
  try {
    // Case 1: already decoded object
    if (input && typeof input === "object" && Array.isArray(input._points)) {
      return input._points.map((point) => ({
        lat: point._latitude,
        lng: point._longitude,
        bearing: point._bearing,
        distanceToNext: point._distanceToNext,
        frc: point._frc,
        fow: point._fow,
        isLast: point._isLast,
      }));
    }

    // Case 2: { OpenLR: "..." }
    if (input && typeof input === "object" && typeof input.OpenLR === "string") {
      return decodeOpenLRStringToPolyline(input.OpenLR);
    }

    // Case 3: "C1aROxHdYgATA/+B/3YAEwP/ff95ABMAAA=="
    if (typeof input === "string") {
      return decodeOpenLRStringToPolyline(input);
    }

    return [];
  } catch (error) {
    console.log("openLrToPolyline failed:", error.message);
    return [];
  }
}
const MRT_LINE_AVG_MIN_PER_STOP = {
  BL: 2.1,   // 板南線
  R: 2.0,    // 淡水信義線
  G: 2.0,    // 松山新店線
  O: 2.1,    // 中和新蘆線
  BR: 1.8,   // 文湖線
  Y: 2.2,    // 環狀線
};

function normalizeMrtName(name) {
  return String(name || "")
    .replace("臺", "台")
    .replace("捷運", "")
    .replace("站", "")
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

  return stationName === inputName || stationName.includes(inputName) || inputName.includes(stationName);
}

function findMrtStationCandidates(stations, input) {
  return stations.filter((station) => stationNameMatches(input, station));
}

function getMrtFallbackWaitMinutes(time) {
  const [hh, mm] = String(time || "09:00").split(":").map(Number);
  const minutes = hh * 60 + mm;

  // 尖峰：7-9, 17-19，平均等 3 分鐘
  if ((minutes >= 7 * 60 && minutes <= 9 * 60) || (minutes >= 17 * 60 && minutes <= 19 * 60)) {
    return 3;
  }

  // 晚上或清晨班距較長
  if (minutes >= 22 * 60 || minutes <= 6 * 60) {
    return 8;
  }

  // 平常時間
  return 5;
}

function findLiveBoardWaitMinutes({ liveBoard, fromStationID, directionToStationNumber }) {
  if (!Array.isArray(liveBoard)) return null;

  const records = liveBoard.filter((item) => item.StationID === fromStationID);

  if (records.length === 0) return null;

  for (const item of records) {
    const destinationId = item.DestinationStationID || item.DestinationStaionID;
    const destNo = getMrtStationNumber(destinationId);

    if (!Number.isFinite(destNo)) continue;

    // 往比較小的站號，例如 BL12 -> BL05，方向要往 BL01 頂埔
    if (directionToStationNumber < getMrtStationNumber(fromStationID) && destNo < getMrtStationNumber(fromStationID)) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }

    // 往比較大的站號，例如 BL05 -> BL12，方向要往南港展覽館
    if (directionToStationNumber > getMrtStationNumber(fromStationID) && destNo > getMrtStationNumber(fromStationID)) {
      return Math.ceil(Number(item.EstimateTime || 0) / 60);
    }
  }

  return null;
}

export async function planMrtSameLineRoute({ from, to, time = "09:00", railSystem = "TRTC" }) {
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