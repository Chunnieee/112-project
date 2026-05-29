
const TDX_TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

// 先暫存 token，避免每次 API 都重新拿 token
let cachedToken = null;
let tokenExpireAt = 0;

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

  const response = await fetch(TDX_TOKEN_URL, {
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

export async function fetchTdxJson(url) {
  const token = await getTdxAccessToken();

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("TDX API error:", data);
    throw new Error("TDX API request failed");
  }

  return data;
}

// 先抓國道即時路段旅行時間資料作為第一版 live traffic source
export async function getFreewayLiveTravelTimes() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway/TravelTime?$format=JSON";

  return await fetchTdxJson(url);
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

  return await fetchTdxJson(url);
}

// 測試：省道即時路況
export async function getHighwayLiveTraffic() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Highway?$format=JSON";

  return await fetchTdxJson(url);
}

// 測試：國道即時事件
export async function getFreewayLiveIncident() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway/Incident?$format=JSON";

  return await fetchTdxJson(url);
}

// 測試：省道即時事件
export async function getHighwayLiveIncident() {
  const url =
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Highway/Incident?$format=JSON";

  return await fetchTdxJson(url);
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