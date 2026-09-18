import { fetchTdxJson } from "./tdxClient.js";

const TDX_POI_SWAGGER_PAGE =
  "https://tdx.transportdata.tw/api-service/swagger/advanced/75571df3-8f34-45ee-862d-525774ff7250";

let discoveredOasUrl = null;

let oasCache = null;
let workingOperationKey = null;
const resultCache = new Map();
const OAS_CACHE_MS = 6 * 60 * 60 * 1000;
const RESULT_CACHE_MS = 24 * 60 * 60 * 1000;


async function fetchTextWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json,*/*",

        "User-Agent":
          "TDX-PROJECT/1.0",
      },

      signal: controller.signal,
    });


    const text =
      await response.text();


    if (!response.ok) {
      throw new Error(
        `TDX Swagger page HTTP ${response.status}: ${text.slice(0, 300)}`
      );
    }


    return text;

  } finally {
    clearTimeout(timer);
  }
}


async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`TDX POI OAS HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`TDX POI OAS returned non-JSON: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value) {
  return String(value || "")
    .replaceAll("臺", "台")
    .replace(/\s+/g, " ")
    .trim();
}

function comparable(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s,，.。\-_/()（）·・:：]/g, "")
    .replace(/(股份有限公司|有限公司|分公司|門市|旗艦店)$/g, "")
    .trim();
}

function scoreName(query, name) {
  const q = comparable(query);
  const n = comparable(name);
  if (!q || !n) return -1;
  if (q === n) return 140;
  if (n.includes(q)) return 115;
  if (q.includes(n) && n.length >= 3) return 95;

  // Conservative token overlap for names such as "台北 101" / "台北101購物中心".
  const qChars = new Set([...q]);
  const nChars = new Set([...n]);
  let hit = 0;
  for (const ch of qChars) if (nChars.has(ch)) hit += 1;
  const overlap = hit / Math.max(qChars.size, nChars.size, 1);
  return overlap >= 0.75 ? Math.round(75 + overlap * 15) : -1;
}

function parsePointGeometry(value) {
  if (!value) return null;

  if (typeof value === "object") {
    if (String(value.type || "").toLowerCase() === "point" && Array.isArray(value.coordinates)) {
      const lon = Number(value.coordinates[0]);
      const lat = Number(value.coordinates[1]);
      if (validTaiwanCoordinate(lat, lon)) return { lat, lon };
    }
  }

  const match = String(value).match(
    /POINT(?:\s+Z)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+-?\d+(?:\.\d+)?)?\s*\)/i
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return validTaiwanCoordinate(lat, lon) ? { lat, lon } : null;
}

function validTaiwanCoordinate(lat, lon) {
  return (
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lon)) &&
    Number(lat) >= 21 &&
    Number(lat) <= 27 &&
    Number(lon) >= 118 &&
    Number(lon) <= 124
  );
}

function readLocalized(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(
    value.Zh_tw ??
      value.ZhTW ??
      value.zh_tw ??
      value.zhTW ??
      value.Name ??
      value.name ??
      value.En ??
      ""
  ).trim();
}

function firstText(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    const text = readLocalized(value);
    if (text) return text;
  }
  return "";
}

function findPosition(item, depth = 0) {
  if (!item || typeof item !== "object" || depth > 3) return null;

  const directPairs = [
    [item.PositionLat, item.PositionLon],
    [item.Latitude, item.Longitude],
    [item.latitude, item.longitude],
    [item.lat, item.lon],
    [item.lat, item.lng],
    [item.Y, item.X],
    [item.y, item.x],
  ];

  for (const [latRaw, lonRaw] of directPairs) {
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (validTaiwanCoordinate(lat, lon)) return { lat, lon };
  }

  const geometryKeys = ["Geometry", "geometry", "WKT", "GeoJSON"];
  for (const key of geometryKeys) {
    const point = parsePointGeometry(item?.[key]);
    if (point) return point;
  }

  const nestedKeys = [
    "Position",
    "POIPosition",
    "LocationPosition",
    "StationPosition",
    "StopPosition",
    "Coordinate",
    "Coordinates",
    "Location",
    "Center",
    "Point",
  ];

  for (const key of nestedKeys) {
    const child = item?.[key];
    if (child && typeof child === "object") {
      const point = findPosition(child, depth + 1);
      if (point) return point;
    }
  }

  return null;
}

function candidateFromObject(item, queries, cityHint) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const position = findPosition(item);
  if (!position) return null;

  const name = firstText(item, [
    "POIName",
    "PoiName",
    "poiName",
    "Name",
    "name",
    "LandmarkName",
    "LandMarkName",
    "FacilityName",
    "StationName",
    "StopName",
    "ScenicSpotName",
    "RestaurantName",
    "HotelName",
    "Title",
    "title",
  ]);

  const address = firstText(item, [
    "Address",
    "AddressNew",
    "FullAddress",
    "FormattedAddress",
    "LocationDescription",
    "Description",
  ]);

  if (!name && !address) return null;

  let bestScore = -1;
  let matchedQuery = "";
  for (const query of queries) {
    const score = Math.max(scoreName(query, name), scoreName(query, address));
    if (score > bestScore) {
      bestScore = score;
      matchedQuery = query;
    }
  }

  if (bestScore < 75) return null;

  if (cityHint) {
    const city = comparable(cityHint);
    const haystack = comparable(
      [
        address,
        item.City,
        item.County,
        item.CityName,
        item.CountyName,
        item.Municipality,
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (city && haystack && !haystack.includes(city) && !city.includes(haystack)) {
      bestScore -= 25;
    } else if (city && haystack.includes(city)) {
      bestScore += 15;
    }
  }

  if (bestScore < 75) return null;

  return {
    lat: position.lat,
    lon: position.lon,
    displayName: name || address,
    address: address || null,
    placeId:
      item.POIID ||
      item.PoiID ||
      item.ID ||
      item.Id ||
      item.id ||
      `tdx-poi:${position.lat},${position.lon}`,
    locationType: "tdx_advanced_poi",
    rawTypes: ["TDX Advanced POI v3"],
    matchedQuery,
    matchScore: bestScore,
  };
}

function collectCandidates(value, queries, cityHint, out = [], depth = 0, seen = new Set()) {
  if (depth > 6 || value == null) return out;
  if (typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, queries, cityHint, out, depth + 1, seen);
    return out;
  }

  const candidate = candidateFromObject(value, queries, cityHint);
  if (candidate) out.push(candidate);

  for (const [key, child] of Object.entries(value)) {
    if (["Geometry", "geometry", "WKT", "GeoJSON"].includes(key)) continue;
    if (child && typeof child === "object") {
      collectCandidates(child, queries, cityHint, out, depth + 1, seen);
    }
  }
  return out;
}

async function discoverPoiOasUrl() {

  if (discoveredOasUrl) {
    return discoveredOasUrl;
  }


  /*
    IMPORTANT:

    Swagger 文件頁的 UUID
    不一定就是 OAS 檔案 UUID。

    所以先下載官方 Swagger 頁面，
    再從頁面內容找真正的：

    /backend/api/File/Swagger/V3/{uuid}
  */

  const html =
    await fetchTextWithTimeout(
      TDX_POI_SWAGGER_PAGE,
      12000
    );


  // ---------------------------------------------
  // Absolute URL
  // ---------------------------------------------

  let match = html.match(
    /https:\/\/tdx\.transportdata\.tw\/backend\/api\/File\/Swagger\/V3\/[0-9a-fA-F-]{36}/
  );


  if (match) {
    discoveredOasUrl =
      match[0];

    console.log(
      "TDX POI real OAS URL:",
      discoveredOasUrl
    );

    return discoveredOasUrl;
  }


  // ---------------------------------------------
  // Escaped URL inside JSON / JS
  // ---------------------------------------------

  const normalizedHtml =
    html
      .replaceAll("\\/", "/")
      .replaceAll("\\u002F", "/");


  match =
    normalizedHtml.match(
      /\/backend\/api\/File\/Swagger\/V3\/[0-9a-fA-F-]{36}/
    );


  if (match) {

    discoveredOasUrl =
      "https://tdx.transportdata.tw" +
      match[0];


    console.log(
      "TDX POI discovered OAS URL:",
      discoveredOasUrl
    );


    return discoveredOasUrl;
  }


  /*
    如果 TDX 前端之後改成完全 client-side，
    錯誤訊息會清楚告訴我們，而不是再亂猜 UUID。
  */

  throw new Error(
    "TDX POI Swagger 頁面可以開啟，但目前無法從 HTML 找到真正的 OAS URL。"
  );
}


async function getOas() {

  if (
    oasCache &&
    Date.now() - oasCache.at <
      OAS_CACHE_MS
  ) {
    return oasCache.value;
  }


  const oasUrl =
    await discoverPoiOasUrl();


  const value =
    await fetchJsonWithTimeout(
      oasUrl,
      12000
    );


  oasCache = {
    at: Date.now(),
    value,
  };


  return value;
}


function mergedParameters(pathItem, operation) {
  const all = [...(pathItem?.parameters || []), ...(operation?.parameters || [])];
  const map = new Map();
  for (const p of all) map.set(`${p.in}:${p.name}`, p);
  return [...map.values()];
}

function parameterValue(parameter, query, cityHint) {
  const name = String(parameter?.name || "");
  const lower = name.toLowerCase();
  const schema = parameter?.schema || {};

  if (lower === "$format" || lower === "format") return "JSON";
  if (lower === "$top" || lower === "top" || lower.includes("limit")) return "20";
  if (lower === "$count" || lower === "count") return "false";
  if (lower === "$skip" || lower === "skip") return "0";

  if (/city|county|municipality|region/.test(lower)) {
    if (cityHint) return cityHint;
    if (schema.default != null) return String(schema.default);
    if (Array.isArray(schema.enum) && schema.enum.length) {
      const all = schema.enum.find((x) => /all|全部|全國/i.test(String(x)));
      if (all != null) return String(all);
    }
    return null;
  }

  if (
    /keyword|query|search|name|poi|landmark|place|location|address|text|term|word|input|key/.test(
      lower
    ) &&
    !lower.includes("type") &&
    !lower.includes("category")
  ) {
    return query;
  }

  if (schema.default != null) return String(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (schema.type === "boolean") return "false";
  return null;
}

function buildRequest(spec, path, pathItem, operation, query, cityHint) {
  const base =
    operation?.servers?.[0]?.url ||
    pathItem?.servers?.[0]?.url ||
    spec?.servers?.[0]?.url ||
    "https://tdx.transportdata.tw/api/advanced";

  const parameters = mergedParameters(pathItem, operation);
  let filledPath = path;
  const params = new URLSearchParams();

  for (const parameter of parameters) {
    const value = parameterValue(parameter, query, cityHint);
    if (parameter.in === "path") {
      if (value == null) {
        if (parameter.required) return null;
        continue;
      }
      filledPath = filledPath.replace(`{${parameter.name}}`, encodeURIComponent(value));
    } else if (parameter.in === "query") {
      if (value == null) {
        if (parameter.required) return null;
        continue;
      }
      params.set(parameter.name, value);
    }
  }

  if (/\{[^}]+\}/.test(filledPath)) return null;

  const url = `${String(base).replace(/\/$/, "")}/${String(filledPath).replace(/^\//, "")}`;
  const queryString = params.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function operationScore(path, operation) {
  const text = [
    path,
    operation?.summary,
    operation?.description,
    ...(operation?.tags || []),
    operation?.operationId,
  ]
    .filter(Boolean)
    .join(" ");

  let score = 0;
  if (/POI/i.test(text)) score += 50;
  if (/定位|地標|搜尋|search|locator/i.test(text)) score += 35;
  if (/nearby|周邊|spatial/i.test(text)) score -= 10;
  return score;
}

async function operationList() {
  const spec = await getOas();
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec?.paths || {})) {
    const operation = pathItem?.get;
    if (!operation) continue;
    operations.push({
      key: `GET ${path}`,
      path,
      pathItem,
      operation,
      score: operationScore(path, operation),
      spec,
    });
  }
  operations.sort((a, b) => b.score - a.score);

  if (workingOperationKey) {
    operations.sort((a, b) => {
      if (a.key === workingOperationKey) return -1;
      if (b.key === workingOperationKey) return 1;
      return b.score - a.score;
    });
  }
  return operations;
}

export async function searchTdxAdvancedPoi({ queries, cityHint = "" }) {
  const uniqueQueries = [...new Set((queries || []).map(cleanText).filter(Boolean))].slice(0, 4);
  if (!uniqueQueries.length) return null;

  const cacheKey = `${uniqueQueries.join("|")}::${cleanText(cityHint)}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESULT_CACHE_MS) return cached.value;

  const operations = await operationList();
  const attempts = [];
  let best = null;

  // Avoid burning TDX quota: try at most four operation/query combinations.
  outer: for (const entry of operations.slice(0, 5)) {
    for (const query of uniqueQueries.slice(0, 2)) {
      const url = buildRequest(entry.spec, entry.path, entry.pathItem, entry.operation, query, cityHint);
      if (!url) {
        attempts.push({ operation: entry.key, skipped: "required parameter could not be resolved" });
        continue;
      }

      try {
        const data = await fetchTdxJson(url, {
          timeoutMs: 10000,
          cacheMs: 6 * 60 * 60 * 1000,
          max429Retries: 1,
        });
        const candidates = collectCandidates(data, uniqueQueries, cityHint)
          .sort((a, b) => b.matchScore - a.matchScore);

        attempts.push({ operation: entry.key, query, candidateCount: candidates.length });
        if (candidates[0] && (!best || candidates[0].matchScore > best.matchScore)) {
          best = { ...candidates[0], tdxOperation: entry.key };
          workingOperationKey = entry.key;
        }
        if (best?.matchScore >= 115) break outer;
      } catch (error) {
        attempts.push({ operation: entry.key, query, error: error.message });
        if (error?.status === 429 || error?.code === "TDX_RATE_LIMIT") throw error;
      }

      if (attempts.length >= 4) break outer;
    }
  }

  if (best) {
    resultCache.set(cacheKey, { at: Date.now(), value: best });
    return best;
  }
  return null;
}

export async function getTdxAdvancedPoiDebug() {
  const spec = await getOas();
  const operations = await operationList();
  return {
    swaggerPage: TDX_POI_SWAGGER_PAGE,
    discoveredOasUrl,
    title: spec?.info?.title || null,
    version: spec?.info?.version || null,
    servers: spec?.servers || [],
    operations: operations.map((entry) => ({
      key: entry.key,
      summary: entry.operation?.summary || null,
      description: entry.operation?.description || null,
      parameters: mergedParameters(entry.pathItem, entry.operation).map((p) => ({
        name: p.name,
        in: p.in,
        required: Boolean(p.required),
        schema: p.schema || null,
      })),
    })),
    workingOperationKey,
  };
}