import fs from "node:fs/promises";

import { fetchTdxJson } from "./tdxClient.js";
import {
  getTHSRStations,
  getTRAStations,
  getMetroStations,
} from "./tdxRealClient.js";

const PHOTON_URL = "https://photon.komoot.io/api/";

/*
 * NOMINATIM_FALLBACK_FUNCTION_V2
 *
 * Grounded backup geocoder for explicit
 * user place searches only.
 * Never used by autocomplete.
 */
const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search";

let lastNominatimRequestAt = 0;



const PLACE_SEARCH_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.PLACE_SEARCH_CACHE_MAX_ENTRIES || 500)
);

const PHOTON_CACHE_TTL_MS = Math.max(
  60_000,
  Number(
    process.env.PLACE_SEARCH_PHOTON_CACHE_TTL_MS ||
    24 * 60 * 60_000
  )
);

const GROQ_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.PLACE_SEARCH_GROQ_CACHE_TTL_MS || 24 * 60 * 60_000)
);

/*
 * PLACE_SEARCH_RELIABILITY_V2
 *
 * If Photon is temporarily unreachable, do not let
 * four aliases each wait for another failed request.
 */
const PHOTON_CIRCUIT_BREAK_MS =
  Math.max(
    5_000,
    Number(
      process.env.PLACE_SEARCH_PHOTON_CIRCUIT_MS ||
      30_000
    )
  );

let photonCircuitOpenUntil = 0;


/*
 * Final grounded place results are persisted locally.
 * This is NOT a hard-coded place database.
 *
 * A result enters this cache only after one of the
 * normal grounded providers successfully resolved it.
 */
const RESOLVED_PLACE_CACHE_FILE =
  new URL(
    "./data/resolved-place-cache.json",
    import.meta.url
  );

const RESOLVED_PLACE_CACHE_TTL_MS =
  Math.max(
    60_000,
    Number(
      process.env.PLACE_SEARCH_RESOLVED_CACHE_TTL_MS ||
      24 * 60 * 60_000
    )
  );

let resolvedPlaceDiskCache = null;


class TTLCache {
  constructor({
    ttlMs,
    maxEntries = PLACE_SEARCH_CACHE_MAX_ENTRIES,
  }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }

    // Map insertion order is used as a tiny LRU.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  clear() {
    this.map.clear();
  }
}

const photonSearchCache = new TTLCache({
  ttlMs: PHOTON_CACHE_TTL_MS,
});

const groqNormalizeCache = new TTLCache({
  ttlMs: GROQ_CACHE_TTL_MS,
});

const photonSearchInflight = new Map();
const groqNormalizeInflight = new Map();

async function cachedAsync({
  cache,
  inflight,
  key,
  loader,
  shouldCache = () => true,
}) {
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  if (inflight.has(key)) {
    return await inflight.get(key);
  }

  const promise = (async () => {
    const value = await loader();

    if (shouldCache(value)) {
      cache.set(key, value);
    }

    return value;
  })();

  inflight.set(key, promise);

  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
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

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvedPlaceCacheKey(
  rawQuery,
  nearLat,
  nearLon
) {
  const lat = Number(nearLat);
  const lon = Number(nearLon);

  const nearKey =
    validTaiwanCoordinate(
      lat,
      lon
    )
      ? `${lat.toFixed(3)},${lon.toFixed(3)}`
      : "";

  return (
    clean(rawQuery)
      .toLowerCase()
      .replaceAll("臺", "台") +
    "|" +
    nearKey
  );
}


async function loadResolvedPlaceDiskCache() {
  if (resolvedPlaceDiskCache) {
    return resolvedPlaceDiskCache;
  }

  try {
    const text =
      await fs.readFile(
        RESOLVED_PLACE_CACHE_FILE,
        "utf8"
      );

    const parsed =
      JSON.parse(text);

    resolvedPlaceDiskCache =
      parsed &&
      parsed.version === 1 &&
      parsed.entries &&
      typeof parsed.entries === "object"
        ? parsed
        : {
            version: 1,
            entries: {},
          };

  } catch (error) {
    if (
      error?.code !==
      "ENOENT"
    ) {
      console.warn(
        "[place resolved cache] read failed:",
        error.message
      );
    }

    resolvedPlaceDiskCache = {
      version: 1,
      entries: {},
    };
  }

  return resolvedPlaceDiskCache;
}


async function getResolvedPlaceCache(
  key
) {
  const store =
    await loadResolvedPlaceDiskCache();

  const entry =
    store.entries[key];

  if (!entry) {
    return null;
  }

  if (
    Number(entry.expiresAt || 0) <=
    Date.now()
  ) {
    delete store.entries[key];
    return null;
  }

  return entry.value || null;
}


async function setResolvedPlaceCache(
  key,
  value
) {
  if (
    !key ||
    !value?.result ||
    !validTaiwanCoordinate(
      value.result.lat,
      value.result.lon
    )
  ) {
    return;
  }

  const store =
    await loadResolvedPlaceDiskCache();

  store.entries[key] = {
    savedAt:
      new Date().toISOString(),

    expiresAt:
      Date.now() +
      RESOLVED_PLACE_CACHE_TTL_MS,

    value,
  };

  /*
   * Keep the cache bounded.
   */
  const entries =
    Object.entries(
      store.entries
    );

  if (entries.length > 500) {
    entries
      .sort(
        (a, b) =>
          Number(
            a[1]?.savedAt
              ? Date.parse(
                  a[1].savedAt
                )
              : 0
          ) -
          Number(
            b[1]?.savedAt
              ? Date.parse(
                  b[1].savedAt
                )
              : 0
          )
      )
      .slice(
        0,
        entries.length - 500
      )
      .forEach(
        ([oldKey]) => {
          delete store.entries[
            oldKey
          ];
        }
      );
  }

  await fs.mkdir(
    new URL(
      "./data/",
      import.meta.url
    ),
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    RESOLVED_PLACE_CACHE_FILE,
    JSON.stringify(
      store,
      null,
      2
    ),
    "utf8"
  );
}


const TAIWAN_CITY_ALIASES = [
  {
    canonical: "Taipei",
    names: [
      "台北",
      "臺北",
      "台北市",
      "臺北市",
      "Taipei",
    ],
  },
  {
    canonical: "New Taipei",
    names: [
      "新北",
      "新北市",
      "New Taipei",
    ],
  },
  {
    canonical: "Taoyuan",
    names: [
      "桃園",
      "桃園市",
      "Taoyuan",
    ],
  },
  {
    canonical: "Taichung",
    names: [
      "台中",
      "臺中",
      "台中市",
      "臺中市",
      "Taichung",
    ],
  },
  {
    canonical: "Tainan",
    names: [
      "台南",
      "臺南",
      "台南市",
      "臺南市",
      "Tainan",
    ],
  },
  {
    canonical: "Kaohsiung",
    names: [
      "高雄",
      "高雄市",
      "Kaohsiung",
    ],
  },
  {
    canonical: "Keelung",
    names: [
      "基隆",
      "基隆市",
      "Keelung",
    ],
  },
  {
    canonical: "Hsinchu",
    names: [
      "新竹",
      "新竹市",
      "新竹縣",
      "Hsinchu",
    ],
  },
  {
    canonical: "Miaoli",
    names: [
      "苗栗",
      "苗栗縣",
      "Miaoli",
    ],
  },
  {
    canonical: "Changhua",
    names: [
      "彰化",
      "彰化縣",
      "Changhua",
    ],
  },
  {
    canonical: "Nantou",
    names: [
      "南投",
      "南投縣",
      "Nantou",
    ],
  },
  {
    canonical: "Yunlin",
    names: [
      "雲林",
      "雲林縣",
      "Yunlin",
    ],
  },
  {
    canonical: "Chiayi",
    names: [
      "嘉義",
      "嘉義市",
      "嘉義縣",
      "Chiayi",
    ],
  },
  {
    canonical: "Pingtung",
    names: [
      "屏東",
      "屏東縣",
      "Pingtung",
    ],
  },
  {
    canonical: "Yilan",
    names: [
      "宜蘭",
      "宜蘭縣",
      "Yilan",
    ],
  },
  {
    canonical: "Hualien",
    names: [
      "花蓮",
      "花蓮縣",
      "Hualien",
    ],
  },
  {
    canonical: "Taitung",
    names: [
      "台東",
      "臺東",
      "台東縣",
      "臺東縣",
      "Taitung",
    ],
  },
];

function normalizeCityName(value) {
  const text = clean(value).toLowerCase();

  if (!text) {
    return "";
  }

  let bestMatch = null;
  let bestMatchLength = 0;

  for (const item of TAIWAN_CITY_ALIASES) {
    for (const name of item.names) {
      const lowerName = name.toLowerCase();

      if (text.includes(lowerName) && lowerName.length > bestMatchLength) {
        bestMatch = item.canonical;
        bestMatchLength = lowerName.length;
      }
    }
  }

  return bestMatch || "";
}

/*
 * 城市名有時只是專有名詞的一部分，例如「台北大學」在新北三峽，
 * 「台中科技大學」不一定在台中。這種情況不能當成「使用者要找這座城市」
 * 的明確條件，否則正確答案會被扣分。
 */
const EMBEDDED_CITY_SUFFIX =
  "(?:大學|學院|科大|科技大學|師範|專科|高中|高工|高商|國中|國小|醫院|榮總|銀行|農會|日報|電台|電視台|\\s*university|\\s*college|\\s*hospital)";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMBEDDED_CITY_PATTERN = new RegExp(
  `(${TAIWAN_CITY_ALIASES.flatMap((item) => item.names)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?=${EMBEDDED_CITY_SUFFIX})`,
  "gi"
);

function detectCityMention(text) {
  const raw = clean(text);

  if (!raw) {
    return { city: "", embedded: false };
  }

  const embeddedCities = [];

  const masked = raw.replace(EMBEDDED_CITY_PATTERN, (match) => {
    const city = normalizeCityName(match);

    if (city) {
      embeddedCities.push(city);
    }

    return "·";
  });

  const city = normalizeCityName(masked);

  if (city) {
    return { city, embedded: false };
  }

  if (embeddedCities.length) {
    return { city: embeddedCities[0], embedded: true };
  }

  return { city: "", embedded: false };
}

/*
 * 鄉鎮市區 -> 縣市。
 *
 * Photon / OSM 常只給「板橋區」而沒有「新北市」，
 * 沒有這張表就只能當 unknown。
 * 目前涵蓋六都、基隆、新竹市、嘉義市；其他縣的鄉鎮之後可以再補。
 * 同名的區（中正區、東區…）會對應到多個縣市，由
 * evaluateCityConsistency 視為 ambiguous，不會誤判成衝突。
 */
const TAIWAN_DISTRICTS_BY_CITY = {
  Taipei: [
    "中正區", "萬華區", "大同區", "中山區", "松山區", "大安區",
    "信義區", "內湖區", "南港區", "士林區", "北投區", "文山區",
  ],
  "New Taipei": [
    "板橋區", "三重區", "中和區", "永和區", "新莊區", "新店區",
    "土城區", "蘆洲區", "樹林區", "汐止區", "鶯歌區", "三峽區",
    "淡水區", "瑞芳區", "五股區", "泰山區", "林口區", "深坑區",
    "石碇區", "坪林區", "三芝區", "石門區", "八里區", "平溪區",
    "雙溪區", "貢寮區", "金山區", "萬里區", "烏來區",
  ],
  Taoyuan: [
    "桃園區", "中壢區", "平鎮區", "八德區", "楊梅區", "蘆竹區",
    "大溪區", "龍潭區", "龜山區", "大園區", "觀音區", "新屋區",
    "復興區",
  ],
  Taichung: [
    "中區", "東區", "南區", "西區", "北區", "北屯區", "西屯區",
    "南屯區", "太平區", "大里區", "霧峰區", "烏日區", "豐原區",
    "后里區", "石岡區", "東勢區", "和平區", "新社區", "潭子區",
    "大雅區", "神岡區", "大肚區", "沙鹿區", "龍井區", "梧棲區",
    "清水區", "大甲區", "外埔區", "大安區",
  ],
  Tainan: [
    "新營區", "鹽水區", "白河區", "柳營區", "後壁區", "東山區",
    "麻豆區", "下營區", "六甲區", "官田區", "大內區", "佳里區",
    "學甲區", "西港區", "七股區", "將軍區", "北門區", "新化區",
    "善化區", "新市區", "安定區", "山上區", "玉井區", "楠西區",
    "南化區", "左鎮區", "仁德區", "歸仁區", "關廟區", "龍崎區",
    "永康區", "東區", "南區", "北區", "安南區", "安平區", "中西區",
  ],
  Kaohsiung: [
    "楠梓區", "左營區", "鼓山區", "三民區", "鹽埕區", "前金區",
    "新興區", "苓雅區", "前鎮區", "旗津區", "小港區", "鳳山區",
    "林園區", "大寮區", "大樹區", "大社區", "仁武區", "鳥松區",
    "岡山區", "橋頭區", "燕巢區", "田寮區", "阿蓮區", "路竹區",
    "湖內區", "茄萣區", "永安區", "彌陀區", "梓官區", "旗山區",
    "美濃區", "六龜區", "甲仙區", "杉林區", "內門區", "茂林區",
    "桃源區", "那瑪夏區",
  ],
  Keelung: [
    "仁愛區", "信義區", "中正區", "中山區", "安樂區", "暖暖區",
    "七堵區",
  ],
  Hsinchu: ["東區", "北區", "香山區"],
  Chiayi: ["東區", "西區"],
};

const DISTRICT_CITY_INDEX = (() => {
  const index = new Map();

  for (const [city, districts] of Object.entries(TAIWAN_DISTRICTS_BY_CITY)) {
    for (const district of districts) {
      if (!index.has(district)) {
        index.set(district, []);
      }

      index.get(district).push(city);
    }
  }

  return index;
})();

// 長的先比對：「中西區」要先於「西區」，否則會誤判成台中/嘉義。
const DISTRICT_NAMES_LONGEST_FIRST = [...DISTRICT_CITY_INDEX.keys()].sort(
  (a, b) => b.length - a.length
);

function districtCitiesFromText(value) {
  let text = clean(value).replace(/臺/g, "台");

  if (!text) {
    return [];
  }

  const result = [];

  for (const name of DISTRICT_NAMES_LONGEST_FIRST) {
    if (!text.includes(name)) {
      continue;
    }

    for (const city of DISTRICT_CITY_INDEX.get(name)) {
      if (!result.includes(city)) {
        result.push(city);
      }
    }

    // 已用掉的字不能再被較短的區名重複命中。
    text = text.split(name).join(" ");
  }

  return result;
}

function inferCityHint(
  ...values
) {
  for (const value of values) {
    const city =
      normalizeCityName(
        value
      );

    if (city) {
      return city;
    }
  }

  return "";
}


function collectCityHints(...values) {
  const result = [];

  for (const value of values.flat(Infinity)) {
    const city = normalizeCityName(value);

    if (city && !result.includes(city)) {
      result.push(city);
    }
  }

  return result;
}

function cityQueryTerms(cityHint) {
  if (!cityHint) {
    return [];
  }

  const item = TAIWAN_CITY_ALIASES.find(
    (entry) => entry.canonical === cityHint
  );

  if (!item) {
    return [cityHint];
  }

  const chineseNames = item.names.filter(
    (name) => /[^\x00-\x7F]/.test(name)
  );

  return unique([
    cityHint,
    ...chineseNames,
  ]).slice(0, 3);
}


/*
 * RAW_DISTRICT_CITY_V3
 *
 * Deterministic Taiwan administrative knowledge.
 *
 * Example:
 *   板橋長江路一段220號
 * must never become:
 *   台北市板橋區長江路一段220號
 */
const NEW_TAIPEI_RAW_DISTRICTS = [
  "板橋",
  "三重",
  "中和",
  "永和",
  "新莊",
  "新店",
  "樹林",
  "鶯歌",
  "三峽",
  "淡水",
  "汐止",
  "瑞芳",
  "土城",
  "蘆洲",
  "五股",
  "泰山",
  "林口",
  "深坑",
  "石碇",
  "坪林",
  "三芝",
  "石門",
  "八里",
  "平溪",
  "雙溪",
  "貢寮",
  "金山",
  "萬里",
  "烏來",
];

function rawDistrictContext(
  value
) {
  const text =
    String(value || "")
      .replace(/臺/g, "台")
      .replace(/\s+/g, "")
      .trim();

  /*
   * Only infer a bare district name when
   * the input actually looks like an address.
   */
  const addressLike =
    /路|街|大道|巷|弄|號/.test(
      text
    );

  for (
    const district of
    NEW_TAIPEI_RAW_DISTRICTS
  ) {
    if (
      text.includes(
        `${district}區`
      ) ||
      (
        addressLike &&
        text.startsWith(
          district
        )
      )
    ) {
      return {
        city:
          "New Taipei",

        cityZh:
          "新北市",

        district,
      };
    }
  }

  return null;
}

function canonicalAddressFromRawDistrict(
  value,
  context
) {
  if (!context) {
    return "";
  }

  let text =
    String(value || "")
      .replace(/臺/g, "台")
      .replace(/\s+/g, "")
      .trim();

  if (!text) {
    return "";
  }

  if (
    text.startsWith(
      context.cityZh
    )
  ) {
    return text;
  }

  /*
   * 板橋區長江路...
   * -> 新北市板橋區長江路...
   */
  if (
    text.startsWith(
      `${context.district}區`
    )
  ) {
    return (
      context.cityZh +
      text
    );
  }

  /*
   * 板橋長江路...
   * -> 新北市板橋區長江路...
   */
  if (
    text.startsWith(
      context.district
    )
  ) {
    return (
      context.cityZh +
      context.district +
      "區" +
      text.slice(
        context.district.length
      )
    );
  }

  return "";
}

function resolveCityHintInfo({
  rawQuery,
  normalizedQuery,
  aiCityHint,
}) {
  const rawMention = detectCityMention(rawQuery);

  if (rawMention.city && !rawMention.embedded) {
    return {
      cityHint: rawMention.city,
      source: "raw-query",
      strength: "explicit",
    };
  }

  const rawDistrict =
    rawDistrictContext(
      rawQuery
    );

  if (rawDistrict) {
    return {
      cityHint:
        rawDistrict.city,

      source:
        "raw-district",

      strength:
        "explicit",
    };
  }

  const normalizedMention = detectCityMention(normalizedQuery);

  if (normalizedMention.city && !normalizedMention.embedded) {
    return {
      cityHint: normalizedMention.city,
      source: "normalized-query",
      strength: "ai",
    };
  }

  const ai = normalizeCityName(aiCityHint);
  const embeddedCity = rawMention.city || normalizedMention.city;

  /*
   * 城市名只出現在專有名詞裡（台北大學、台中科技大學…）：
   * 不是「請在這座城市找」，所以只給很弱的加分、不扣分。
   * 如果 AI 給了不同的城市，採用 AI 的判斷。
   */
  if (embeddedCity) {
    if (ai && ai !== embeddedCity) {
      return {
        cityHint: ai,
        source: "ai-hint",
        strength: "ai",
      };
    }

    return {
      cityHint: embeddedCity,
      source: "embedded-in-name",
      strength: "embedded",
    };
  }

  if (ai) {
    return {
      cityHint: ai,
      source: "ai-hint",
      strength: "ai",
    };
  }

  return {
    cityHint: "",
    source: "none",
    strength: "none",
  };
}

function candidateCityEvidence(candidate) {
  const administrativeCities = collectCityHints(
    candidate?.administrativeCity,
    candidate?.state,
    candidate?.county,
    candidate?.municipality,
    candidate?.city,
    candidate?.subdivision
  );

  if (administrativeCities.length) {
    return {
      cities: administrativeCities,
      source: "administrative-fields",
    };
  }

  /*
   * 沒有縣市欄位時，用「區名」反查縣市（板橋區 -> New Taipei）。
   * 只看結構化欄位，不看 displayName，避免店名誤判。
   */
  const districtCities = [];

  for (const value of [
    candidate?.district,
    candidate?.city,
    candidate?.locality,
  ]) {
    for (const city of districtCitiesFromText(value)) {
      if (!districtCities.includes(city)) {
        districtCities.push(city);
      }
    }
  }

  if (districtCities.length) {
    return {
      cities: districtCities,
      source: "district-lookup",
    };
  }

  const weakCities = collectCityHints(
    candidate?.district,
    candidate?.locality,
    candidate?.address,
    candidate?.displayName
  );

  if (weakCities.length) {
    return {
      cities: weakCities,
      source: "weak-text-fallback",
    };
  }

  const addressDistrictCities = districtCitiesFromText(candidate?.address);

  if (addressDistrictCities.length) {
    return {
      cities: addressDistrictCities,
      source: "district-lookup",
    };
  }

  return {
    cities: [],
    source: "unknown",
  };
}

function evaluateCityConsistency(
  candidate,
  cityHint,
  cityHintStrength = "explicit"
) {
  if (!cityHint) {
    return {
      status: "not-requested",
      candidateCities: [],
      adjustment: 0,
      source: "none",
    };
  }

  const evidence = candidateCityEvidence(candidate);
  const cities = evidence.cities;

  if (!cities.length) {
    return {
      status: "unknown",
      candidateCities: [],
      adjustment: cityHintStrength === "embedded" ? 0 : -5,
      source: evidence.source,
    };
  }

  const containsHint = cities.includes(cityHint);
  const ambiguous = cities.length > 1;

  const weights = {
    explicit: {
      match: 95,
      ambiguousMatch: 45,
      conflict: -70,
    },
    normalized: {
      match: 15,
      ambiguousMatch: 6,
      conflict: -5,
    },

    /*
     * AI did not receive coordinates and did not
     * observe the real candidate set.
     * It is only a weak tie-breaker.
     */
    ai: {
      match: 8,
      ambiguousMatch: 3,
      conflict: -2,
    },
    // 城市名只是專有名詞的一部分：弱加分、不扣分。
    embedded: {
      match: 25,
      ambiguousMatch: 12,
      conflict: 0,
    },
  };

  const weight = weights[cityHintStrength] || weights.ai;

  if (containsHint) {
    return {
      status: ambiguous ? "ambiguous-match" : "match",
      candidateCities: cities,
      adjustment: ambiguous
        ? weight.ambiguousMatch
        : weight.match,
      source: evidence.source,
    };
  }

  return {
    status: "conflict",
    candidateCities: cities,
    adjustment: weight.conflict,
    source: evidence.source,
  };
}

function normalizeComparable(
  value
) {
  return clean(value)
    .toLowerCase()
    .replace(
      /臺/g,
      "台"
    )
    .replace(
      /[\s,，.。\-_/()（）]/g,
      ""
    );
}

function placeTypeFromText(
  value
) {
  const lower =
    clean(value).toLowerCase();

  const text =
    normalizeComparable(
      value
    );

  if (!text) {
    return "unknown";
  }

  /*
   * 路名 / 門牌先判斷。
   *   「中山北路二段」「忠孝東路四段216號」是地址，
   *   但「路易莎」「九份老街」「士林夜市」不是。
   * 以前只要出現「路」就算 address，會把「路易莎咖啡」
   * 判成地址，連 TDX Tourism 都不查。
   */
  const endsWithRoad =
    /(?:路|街|大道)(?:[一二三四五六七八九十\d]+段)?$/.test(text) &&
    !/老街|夜市|商圈/.test(text);

  const hasAddressNumber =
    /(?:路|街|大道|巷|弄|段)[^\s]{0,8}?\d+號|\d+巷|\d+弄|[一二三四五六七八九十\d]+段/
      .test(text);

  if (endsWithRoad || hasAddressNumber) {
    return "address";
  }

  // 公車站、客運站不是鐵路 / 捷運車站。
  if (/公車|客運|巴士/.test(text)) {
    return "unknown";
  }

  if (
    /捷運|高鐵|台鐵|火車站|車站/.test(text) ||
    /\b(?:railway|metro|mrt|station)\b/.test(lower)
  ) {
    return "station";
  }

  if (
    /餐廳|餐館|食堂|燒肉|烤肉|火鍋|牛排|拉麵|麵店|小吃|早餐|早午餐|便當|咖啡|甜點|茶飲|居酒屋/
      .test(text) ||
    /\b(?:restaurant|cafe|coffee|bistro|steakhouse)\b/.test(lower)
  ) {
    return "restaurant";
  }

  if (
    /飯店|旅館|旅店|民宿|酒店|汽車旅館|度假村/.test(text) ||
    /\b(?:hotel|hostel|motel|inn|resort)\b/.test(lower)
  ) {
    return "hotel";
  }

  if (
    /景點|博物館|美術館|紀念館|動物園|樂園|公園|古蹟|寺|廟|教堂|遊客中心|老街|夜市|風景區|步道|瀑布|溫泉|海灘/
      .test(text) ||
    /\b(?:museum|attraction|zoo|park)\b/.test(lower)
  ) {
    return "attraction";
  }

  if (
    /港口|港區|碼頭|漁港|商港/.test(text) ||
    /\b(?:harbou?r|port)\b/.test(lower)
  ) {
    return "port";
  }

  if (
    /大學|學院|學校/.test(text) ||
    /\b(?:university|college|school)\b/.test(lower)
  ) {
    return "school";
  }

  return "unknown";
}


function candidateTypeMatches(
  candidate,
  expectedType
) {
  if (
    !expectedType ||
    expectedType === "unknown"
  ) {
    return false;
  }

  const haystack =
    [
      candidate?.displayName,
      candidate?.locationType,
      ...(candidate?.rawTypes || []),
      candidate?.source,
    ]
      .join(" ")
      .toLowerCase();

  if (
    expectedType === "station"
  ) {
    return /station|railway|train|metro|mrt/
      .test(haystack);
  }

  if (
    expectedType === "restaurant"
  ) {
    return /restaurant|food|餐飲/
      .test(haystack);
  }

  if (
    expectedType === "hotel"
  ) {
    return /hotel|lodging|accommodation|旅館|旅宿/
      .test(haystack);
  }

  if (
    expectedType === "attraction" ||
    expectedType === "museum"
  ) {
    return /attraction|tourism|scenic|museum/
      .test(haystack);
  }

  if (
    expectedType === "port"
  ) {
    return /port|harbour|harbor|ship_port/
      .test(haystack);
  }

  if (
    expectedType === "school"
  ) {
    return /university|college|school/
      .test(haystack);
  }

  if (
    expectedType === "address"
  ) {
    return /house|street|address/
      .test(haystack);
  }

  if (
    expectedType === "poi"
  ) {
    /*
     * POI_RANKING_V2
     *
     * "poi" is a generic physical destination,
     * not only restaurants/hotels/tourism.
     *
     * Malls, shops, markets, cinemas, stadiums,
     * parks, hospitals, banks, etc. must also
     * qualify as POIs.
     */
    return /poi|tourism|restaurant|hotel|attraction|museum|mall|shop|store|market|supermarket|department_store|commercial|retail|amenity|leisure|cinema|theatre|theater|stadium|park|hospital|clinic|pharmacy|bank|cafe|fast_food/
      .test(haystack);
  }

  return false;
}


const CITY_ALIASES_COMPARABLE = TAIWAN_CITY_ALIASES
  .flatMap((item) => item.names)
  .map((name) => normalizeComparable(name))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

function stripCityMentions(comparableText) {
  let result = comparableText;

  for (const alias of CITY_ALIASES_COMPARABLE) {
    result = result.split(alias).join("");
  }

  return result;
}

function charBigrams(text) {
  const grams = new Map();

  if (text.length < 2) {
    if (text) {
      grams.set(text, 1);
    }

    return grams;
  }

  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }

  return grams;
}

/*
 * 字元 bigram Dice 係數，0~1。
 * 比單純 includes() 更能容忍少一兩個字、前綴城市名、錯字。
 */
function nameSimilarity(a, b) {
  const x = normalizeComparable(a);
  const y = normalizeComparable(b);

  if (!x || !y) {
    return 0;
  }

  if (x === y) {
    return 1;
  }

  const gx = charBigrams(x);
  const gy = charBigrams(y);

  let total = 0;
  let overlap = 0;

  for (const count of gx.values()) total += count;
  for (const count of gy.values()) total += count;

  for (const [gram, count] of gx) {
    overlap += Math.min(count, gy.get(gram) || 0);
  }

  return total ? (2 * overlap) / total : 0;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/*
 * 離使用者越近加越多分（最多 20，約 30 公里後歸零）。
 * 沒有提供位置就不加分，也不影響其他訊號。
 */
function proximityBonus(candidate, nearLat, nearLon) {
  const aLat = Number(nearLat);
  const aLon = Number(nearLon);

  if (
    !validTaiwanCoordinate(aLat, aLon) ||
    !validTaiwanCoordinate(candidate?.lat, candidate?.lon)
  ) {
    return 0;
  }

  const km = distanceKm(
    aLat,
    aLon,
    Number(candidate.lat),
    Number(candidate.lon)
  );

  return Math.round(Math.max(0, 20 - 4 * Math.log2(1 + km)));
}

function candidateLooksLikeStreet(candidate) {
  const haystack = [
    candidate?.locationType,
    ...(candidate?.rawTypes || []),
  ]
    .join(" ")
    .toLowerCase();

  return /\b(?:highway|street|road)\b/.test(haystack);
}

function scoreCandidate(
  candidate,
  {
    rawQuery,
    normalizedQuery,
    cityHint,
    cityHintStrength = "explicit",
    placeType,
    nearLat = null,
    nearLon = null,
  }
) {
  let score = 0;

  /*
   * 城市一致性是重要證據，但不是一票否決。
   * OSM / Photon 的行政欄位可能缺漏、層級不同或互相衝突，
   * 所以 mismatch 只扣分；如果候選缺乏可判定的城市資料，
   * 只做小幅保守扣分，而不是直接淘汰。
   */
  const cityConsistency =
    evaluateCityConsistency(
      candidate,
      cityHint,
      cityHintStrength
    );

  score += cityConsistency.adjustment;

  const queryText =
    normalizeComparable(
      normalizedQuery ||
        rawQuery
    );

  const candidateText =
    normalizeComparable(
      [
        candidate
          ?.displayName,
        candidate?.address,
      ].join(" ")
    );

  if (
    queryText &&
    candidateText
  ) {
    if (
      candidateText.includes(
        queryText
      )
    ) {
      score += 60;
    }

    if (
      queryText.includes(
        candidateText
      )
    ) {
      score += 40;
    }
  }

  /*
   * 名稱相似度：同時比較「原句」與「去掉城市名後的原句」，取較高者。
   * 例：「新北市板橋車站」vs 候選「板橋車站」。
   */
  const candidateName =
    normalizeComparable(candidate?.displayName);

  if (queryText && candidateName) {
    const similarity = Math.max(
      nameSimilarity(queryText, candidateName),
      nameSimilarity(stripCityMentions(queryText), candidateName)
    );

    if (similarity === 1) {
      score += 40;
    }

    score += Math.round(similarity * 40);
  }

  score += proximityBonus(candidate, nearLat, nearLon);

  if (
    candidateTypeMatches(
      candidate,
      placeType
    )
  ) {
    score += 30;
  }

  /*
   * 查的是學校 / 餐廳 / 飯店 / 景點 / 車站等具體地點，
   * 但候選其實是一條路（例如「台北大學路」之於「台北大學」）：
   * 名稱雖然高度重疊，卻幾乎一定不是使用者要的。
   */
  if (
    candidateLooksLikeStreet(candidate) &&
    placeType &&
    !["address", "unknown", "poi", "district", "coordinate"].includes(
      placeType
    )
  ) {
    score -= 30;
  }

  /*
   * Provider 自己的排名仍有參考價值，
   * 但不能凌駕城市一致性。
   */
  const rank =
    Number(
      candidate
        ?.providerRank
    );

  if (
    Number.isFinite(rank)
  ) {
    score +=
      Math.max(
        0,
        10 - rank
      );
  }

  return score;
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);

    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function directCoordinate(query) {
  const match = String(query)
    .trim()
    .match(
      /^\s*(-?\d+(?:\.\d+)?)\s*[,， ]\s*(-?\d+(?:\.\d+)?)\s*$/
    );

  if (!match) return null;

  const a = Number(match[1]);
  const b = Number(match[2]);

  if (validTaiwanCoordinate(a, b)) {
    return {
      lat: a,
      lon: b,
    };
  }

  if (validTaiwanCoordinate(b, a)) {
    return {
      lat: b,
      lon: a,
    };
  }

  return null;
}

async function normalizeWithGroq(query, apiKey) {
  const fallback = {
    normalizedQuery: query,
    aliases: [],
    cityHint: "",
    placeType: "unknown",
    confidence: 0,
    reason: "AI normalization unavailable or unnecessary",
  };

  if (!apiKey) {
    return fallback;
  }

  const cacheKey = clean(query).toLowerCase();

  return await cachedAsync({
    cache: groqNormalizeCache,
    inflight: groqNormalizeInflight,
    key: cacheKey,
    shouldCache: (value) => Boolean(value?.model),
    loader: async () => {
      // 目前 Groq 官方仍支援這兩個 production model。
      // 任一失敗就試下一個；全部失敗也不會阻止地點搜尋。
      const models = [
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
      ];

      for (const model of models) {
        try {
          const response = await fetchWithTimeout(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",

              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },

              body: JSON.stringify({
                model,
                temperature: 0,

                messages: [
                  {
                    role: "system",
                    content:
                      "你是台灣地點搜尋文字導正器。" +
                      "你只能修正名稱、補全正式名稱、提供別名、城市提示和地點類型。" +
                      "絕對不可以產生經緯度。" +
                      "只輸出 JSON。",
                  },

                  {
                    role: "user",
                    content:
                      `使用者輸入：${query}\n` +
                      '輸出格式：{"normalizedQuery":"...","aliases":["..."],"cityHint":"...","placeType":"station|restaurant|hotel|attraction|port|address|poi|district|unknown","confidence":0.0,"reason":"..."}\n' +
                      "例如：政治大學可以導正為國立政治大學；" +
                      "台北101可以保留台北101；" +
                      "動物園如果沒有其他上下文，不要自己發明地址。",
                  },
                ],
              }),
            },
            8000
          );

          if (!response.ok) {
            console.log(
              `Groq ${model} unavailable: HTTP ${response.status}`
            );
            continue;
          }

          const data = await response.json();

          const responseText =
            data?.choices?.[0]?.message?.content || "";

          const parsed = parseJsonLoose(responseText);

          if (!parsed) {
            continue;
          }

          return {
            normalizedQuery:
              clean(parsed.normalizedQuery) || query,

            aliases:
              Array.isArray(parsed.aliases)
                ? unique(parsed.aliases).slice(0, 6)
                : [],

            cityHint:
              clean(parsed.cityHint),

            placeType:
              clean(parsed.placeType) || "unknown",

            confidence:
              Number(parsed.confidence) || 0,

            reason:
              clean(parsed.reason),

            model,
          };
        } catch (error) {
          console.log(
            `Groq ${model} unavailable:`,
            error.message
          );
        }
      }

      return fallback;
    },
  });
}




const tdxTourismCache =
  new TTLCache({
    ttlMs:
      Math.max(
        60_000,
        Number(
          process.env
            .PLACE_SEARCH_TDX_TOURISM_CACHE_TTL_MS ||
          6 * 60 * 60_000
        )
      ),
  });

const tdxTourismInflight =
  new Map();


const TDX_TOURISM_RESOURCES = {
  attraction: {
    endpoints: [
      {
        path: "ScenicSpot",
        nameField: "ScenicSpotName",
      },
      {
        path: "Attraction",
        nameField: "AttractionName",
      },
    ],

    nameFields: [
      "AttractionName",
      "ScenicSpotName",
      "Name",
    ],

    idFields: [
      "AttractionID",
      "ScenicSpotID",
      "ID",
    ],

    locationType:
      "attraction",

    source:
      "TDX Tourism Attraction",
  },

  restaurant: {
    endpoints: [
      {
        path: "Restaurant",
        nameField: "RestaurantName",
      },
    ],

    nameFields: [
      "RestaurantName",
      "Name",
    ],

    idFields: [
      "RestaurantID",
      "ID",
    ],

    locationType:
      "restaurant",

    source:
      "TDX Tourism Restaurant",
  },

  hotel: {
    endpoints: [
      {
        path: "Hotel",
        nameField: "HotelName",
      },
    ],

    nameFields: [
      "HotelName",
      "Name",
    ],

    idFields: [
      "HotelID",
      "ID",
    ],

    locationType:
      "hotel",

    source:
      "TDX Tourism Hotel",
  },
};


function tourismText(
  value
) {
  if (
    typeof value === "string"
  ) {
    return clean(value);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return clean(
      value.Zh_tw ||
      value.ZhTW ||
      value.zh_tw ||
      value.En ||
      value.en ||
      ""
    );
  }

  return "";
}


function tourismFirstText(
  item,
  fields
) {
  for (
    const field
    of fields
  ) {
    const value =
      tourismText(
        item?.[field]
      );

    if (value) {
      return value;
    }
  }

  return "";
}


function tourismPosition(
  item
) {
  const candidates = [
    item?.Position,
    item?.AttractionPosition,
    item?.ScenicSpotPosition,
    item?.RestaurantPosition,
    item?.HotelPosition,
  ];

  for (
    const pos
    of candidates
  ) {
    if (!pos) {
      continue;
    }

    const lat =
      Number(
        pos?.PositionLat ??
        pos?.Latitude
      );

    const lon =
      Number(
        pos?.PositionLon ??
        pos?.Longitude
      );

    if (
      validTaiwanCoordinate(
        lat,
        lon
      )
    ) {
      return {
        lat,
        lon,
      };
    }
  }

  const lat =
    Number(
      item?.PositionLat ??
      item?.Latitude
    );

  const lon =
    Number(
      item?.PositionLon ??
      item?.Longitude
    );

  if (
    validTaiwanCoordinate(
      lat,
      lon
    )
  ) {
    return {
      lat,
      lon,
    };
  }

  return null;
}


function tourismAddress(
  item
) {
  const direct =
    tourismText(
      item?.Address
    );

  if (direct) {
    return direct;
  }

  const postal =
    item?.PostalAddress;

  if (
    typeof postal ===
      "string"
  ) {
    return clean(postal);
  }

  if (
    postal &&
    typeof postal ===
      "object"
  ) {
    return unique([
      tourismText(
        postal.City
      ),
      tourismText(
        postal.Town
      ),
      tourismText(
        postal.Address
      ),
      tourismText(
        postal.StreetAddress
      ),
    ])
      .join("");
  }

  return null;
}


function tourismResourcePlan(
  placeType
) {
  if (
    placeType ===
      "restaurant"
  ) {
    return [
      "restaurant",
    ];
  }

  if (
    placeType ===
      "hotel"
  ) {
    return [
      "hotel",
    ];
  }

  if (
    placeType ===
      "attraction" ||
    placeType ===
      "museum"
  ) {
    return [
      "attraction",
    ];
  }

  /*
   * Generic POI / unknown:
   *
   * Do not trust classification enough
   * to search only one Tourism dataset.
   *
   * A business name such as 鼎泰豐 does
   * not contain the word "restaurant".
   */
  if (
    placeType ===
      "poi" ||
    placeType ===
      "unknown" ||
    !placeType
  ) {
    return [
      "restaurant",
      "hotel",
      "attraction",
    ];
  }

  return [];
}


async function searchTdxTourismResource({
  resourceType,
  query,
}) {
  const definition =
    TDX_TOURISM_RESOURCES[
      resourceType
    ];

  if (!definition) {
    return {
      candidates: [],
      available: false,
      errors: [],
    };
  }

  const cacheKey =
    `${resourceType}|${clean(query).toLowerCase()}`;

  return await cachedAsync({
    cache:
      tdxTourismCache,

    inflight:
      tdxTourismInflight,

    key:
      cacheKey,

    /*
     * Cache successful zero-result calls too.
     * A miss should not repeatedly consume TDX calls.
     */
    shouldCache:
      value =>
        value?.available ===
        true,

    loader:
      async () => {
        const errors = [];

        for (
          const endpoint
          of definition.endpoints
        ) {
          const escaped =
            clean(query)
              .replace(
                /'/g,
                "''"
              );

          const params =
            new URLSearchParams({
              "$filter":
                `contains(${endpoint.nameField},'${escaped}')`,

              "$top":
                "10",

              "$format":
                "JSON",
            });

          const url =
            `https://tdx.transportdata.tw/api/basic/v2/Tourism/${endpoint.path}?` +
            params.toString();

          try {
            const data =
              await fetchTdxJson(
                url,
                {
                  timeoutMs:
                    10000,

                  cacheMs:
                    6 *
                    60 *
                    60 *
                    1000,

                  max429Retries:
                    1,
                }
              );

            const rows =
              Array.isArray(data)
                ? data
                : Array.isArray(
                    data?.data
                  )
                  ? data.data
                  : Array.isArray(
                      data?.Restaurants
                    )
                    ? data.Restaurants
                    : Array.isArray(
                        data?.Hotels
                      )
                      ? data.Hotels
                      : Array.isArray(
                          data?.Attractions
                        )
                        ? data.Attractions
                        : Array.isArray(
                            data?.ScenicSpots
                          )
                          ? data.ScenicSpots
                          : [];

            const candidates =
              rows
                .map(
                  (
                    item,
                    index
                  ) => {
                    const name =
                      tourismFirstText(
                        item,
                        definition
                          .nameFields
                      );

                    const position =
                      tourismPosition(
                        item
                      );

                    if (
                      !name ||
                      !position
                    ) {
                      return null;
                    }

                    const address =
                      tourismAddress(
                        item
                      );

                    const cityText =
                      tourismFirstText(
                        item,
                        [
                          "City",
                          "CityName",
                        ]
                      );

                    const locatedCityText =
                      Array.isArray(
                        item
                          ?.LocatedCities
                      )
                        ? item.LocatedCities
                            .map(
                              tourismText
                            )
                            .filter(Boolean)
                            .join(" ")
                        : "";

                    const administrativeCity =
                      inferCityHint(
                        cityText,
                        locatedCityText,
                        address,
                        name
                      ) ||
                      null;

                    let placeId = "";

                    for (
                      const field
                      of definition
                        .idFields
                    ) {
                      const value =
                        clean(
                          item?.[field]
                        );

                      if (value) {
                        placeId =
                          value;

                        break;
                      }
                    }

                    return {
                      lat:
                        position.lat,

                      lon:
                        position.lon,

                      displayName:
                        name,

                      address,

                      city:
                        cityText ||
                        null,

                      county:
                        cityText ||
                        null,

                      state:
                        null,

                      district:
                        null,

                      locality:
                        null,

                      administrativeCity,

                      placeId:
                        placeId ||
                        `tdx-tourism:${resourceType}:${name}:${position.lat},${position.lon}`,

                      locationType:
                        definition
                          .locationType,

                      rawTypes: [
                        "poi",
                        "tourism",
                        resourceType,
                        `TDX Tourism ${resourceType}`,
                      ],

                      source:
                        definition
                          .source,

                      providerRank:
                        index,

                      coordinatesGrounded:
                        true,
                    };
                  }
                )
                .filter(Boolean);

            return {
              candidates:
                dedupeCandidates(
                  candidates
                ),

              available:
                true,

              endpoint:
                endpoint.path,

              errors,
            };

          } catch (error) {
            errors.push(
              `${endpoint.path}: ${error.message}`
            );

            /*
             * Attraction naming changed between
             * Tourism schema generations.
             * 404 means try the compatible path.
             */
            if (
              String(
                error.message
              ).includes(
                "HTTP 404"
              )
            ) {
              continue;
            }

            return {
              candidates: [],
              available: false,
              errors,
            };
          }
        }

        return {
          candidates: [],
          available: false,
          errors,
        };
      },
  });
}


function stripLeadingCityName(value) {
  const text = clean(value);

  const names = TAIWAN_CITY_ALIASES
    .flatMap((item) => item.names)
    .filter((name) => /[^\x00-\x7F]/.test(name))
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    if (text.startsWith(name)) {
      const rest = text.slice(name.length).trim();

      return rest.length >= 2 ? rest : "";
    }
  }

  return "";
}

/*
 * TDX 用 contains(名稱, '關鍵字') 比對，查詢字串多一個字就是 0 筆。
 * 「台北君悅酒店」這種開頭帶城市名的輸入，額外送一條去掉城市名的版本。
 *
 * 注意：fetchTdxJson 有全域請求佇列，所有 TDX 請求其實是逐一執行的，
 * 所以變體數量直接等於最壞情況的請求數。泛類型（餐廳 + 飯店 + 景點
 * 三個資料集）只留 2 個變體；單一類型才留到 3 個。
 * 順序是交錯的：原句、去掉城市名的原句、正規化句、去掉城市名的正規化句。
 */
function tourismQueryVariants(queries, max = 3) {
  const base = unique(queries).slice(0, 2);

  const interleaved = [];

  for (const query of base) {
    interleaved.push(query, stripLeadingCityName(query));
  }

  return unique(interleaved).slice(0, Math.max(1, max));
}


async function searchTdxTourismCandidates({
  queries,
  placeType,
}) {
  const resources =
    tourismResourcePlan(
      placeType
    );

  if (!resources.length) {
    return {
      candidates: [],
      errors: [],
      available: false,
      resourceStatus: {},
    };
  }

  const plannedQueries =
    tourismQueryVariants(
      queries,
      resources.length > 1 ? 2 : 3
    );

  /*
   * 三個資料集互不相依，所以用 Promise.all 發出；但 fetchTdxJson 會把
   * 所有 TDX 請求排進同一個佇列逐一執行，實際上不會比循序更快。
   * 每個資料集內依序嘗試 query，第一個有結果就停。
   */
  const perResource =
    await Promise.all(
      resources.map(
        async (resourceType) => {
          const found = [];
          const errors = [];

          let available = false;

          for (
            const query
            of plannedQueries
          ) {
            const result =
              await searchTdxTourismResource({
                resourceType,
                query,
              });

            if (result.available) {
              available = true;
            }

            found.push(
              ...(result.candidates || [])
            );

            errors.push(
              ...(result.errors || [])
            );

            if (
              result.candidates?.length
            ) {
              break;
            }
          }

          return {
            resourceType,
            found,
            errors,
            available,
          };
        }
      )
    );

  const resourceStatus = {};

  for (const item of perResource) {
    resourceStatus[item.resourceType] = {
      available: item.available,
      candidates: item.found.length,
    };
  }

  return {
    candidates:
      dedupeCandidates(
        perResource.flatMap(
          (item) => item.found
        )
      ),

    errors:
      unique(
        perResource.flatMap(
          (item) => item.errors
        )
      ),

    available:
      perResource.some(
        (item) => item.available
      ),

    resourceStatus,
  };
}


const tdxPortCache =
  new TTLCache({
    ttlMs:
      Math.max(
        60_000,
        Number(
          process.env
            .PLACE_SEARCH_TDX_PORT_CACHE_TTL_MS ||
          6 * 60 * 60_000
        )
      ),
  });

const tdxPortInflight =
  new Map();


function tdxLocalizedText(
  value
) {
  if (
    typeof value ===
    "string"
  ) {
    return clean(value);
  }

  if (
    value &&
    typeof value ===
      "object"
  ) {
    return clean(
      value.Zh_tw ||
      value.ZhTW ||
      value.zh_tw ||
      value.En ||
      value.en ||
      Object.values(value)
        .find(
          item =>
            typeof item ===
            "string"
        ) ||
      ""
    );
  }

  return "";
}


function looksLikePortQuery(
  value
) {
  return (
    /港口|港$|碼頭|漁港|商港|港區|harbour|harbor|port$/i
      .test(
        clean(value)
      )
  );
}


function normalizePortName(
  value
) {
  return normalizeComparable(
    value
  )
    .replace(
      /台灣|臺灣/g,
      ""
    )
    .replace(
      /國際/g,
      ""
    )
    .replace(
      /港口|港區|碼頭|漁港|商港|港/g,
      ""
    )
    .replace(
      /harbour|harbor|port/gi,
      ""
    );
}


async function loadTdxPorts() {
  return await cachedAsync({
    cache:
      tdxPortCache,

    inflight:
      tdxPortInflight,

    key:
      "all-ship-ports",

    shouldCache:
      value =>
        value?.available ===
        true,

    loader:
      async () => {

        /*
         * TDX shipping is currently v3.
         * Keep v2 as a compatibility fallback only.
         */
        const urls = [
          "https://tdx.transportdata.tw/api/basic/v3/Ship/Port?$top=200&$format=JSON",
          "https://tdx.transportdata.tw/api/basic/v2/Ship/Port?$top=200&$format=JSON",
        ];

        const errors = [];

        for (
          const url
          of urls
        ) {
          try {
            const data =
              await fetchTdxJson(
                url,
                {
                  timeoutMs:
                    10000,

                  cacheMs:
                    6 * 60 *
                    60 * 1000,

                  max429Retries:
                    1,
                }
              );

            const rows =
              Array.isArray(data)
                ? data
                : Array.isArray(
                    data?.Ports
                  )
                  ? data.Ports
                  : Array.isArray(
                      data?.data
                    )
                    ? data.data
                    : [];

            /*
             * A successful HTTP response is enough
             * to mark the provider as available,
             * even when the result is empty.
             */
            return {
              available:
                true,

              rows,

              endpoint:
                url,
            };

          } catch (error) {
            errors.push(
              error.message
            );

            /*
             * Endpoint-version mismatch:
             * try the compatibility endpoint.
             */
            if (
              String(
                error.message
              ).includes(
                "HTTP 404"
              )
            ) {
              continue;
            }

            throw error;
          }
        }

        const error =
          new Error(
            errors.join(
              " | "
            ) ||
            "TDX Ship Port unavailable"
          );

        throw error;
      },
  });
}


async function searchTdxPortCandidates({
  queries,
}) {
  if (
    !queries.some(
      looksLikePortQuery
    )
  ) {
    return {
      candidates: [],
      errors: [],
      available: false,
    };
  }

  try {
    const loaded =
      await loadTdxPorts();

    const rows =
      loaded.rows ||
      [];

    const candidates = [];

    for (
      const item
      of rows
    ) {
      const name =
        tdxLocalizedText(
          item?.PortName
        ) ||
        clean(
          item?.Name
        );

      const pos =
        item?.PortPosition ||
        item?.Position ||
        {};

      const lat =
        Number(
          pos?.PositionLat ??
          item?.PositionLat ??
          item?.Latitude
        );

      const lon =
        Number(
          pos?.PositionLon ??
          item?.PositionLon ??
          item?.Longitude
        );

      if (
        !name ||
        !validTaiwanCoordinate(
          lat,
          lon
        )
      ) {
        continue;
      }

      let bestScore = -1;
      let matchedQuery = null;

      const normalizedName =
        normalizePortName(
          name
        );

      for (
        const query
        of queries
      ) {
        if (
          !looksLikePortQuery(
            query
          )
        ) {
          continue;
        }

        const normalizedQuery =
          normalizePortName(
            query
          );

        if (
          !normalizedQuery ||
          !normalizedName
        ) {
          continue;
        }

        let score = -1;

        if (
          normalizedQuery ===
          normalizedName
        ) {
          score = 140;
        } else if (
          normalizedName.includes(
            normalizedQuery
          )
        ) {
          score = 110;
        } else if (
          normalizedQuery.includes(
            normalizedName
          )
        ) {
          score = 95;
        }

        if (
          score >
          bestScore
        ) {
          bestScore =
            score;

          matchedQuery =
            query;
        }
      }

      if (
        bestScore < 80
      ) {
        continue;
      }

      const cityText =
        tdxLocalizedText(
          item?.City
        ) ||
        clean(
          item?.CityName
        ) ||
        null;

      candidates.push({
        lat,
        lon,

        displayName:
          name,

        address:
          clean(
            item?.PortAddress ||
            item?.Address
          ) ||
          null,

        city:
          cityText,

        county:
          cityText,

        state:
          null,

        district:
          null,

        locality:
          null,

        administrativeCity:
          inferCityHint(
            cityText,
            name
          ) ||
          null,

        placeId:
          clean(
            item?.PortID ||
            item?.PortUID ||
            item?.PortCode
          ) ||
          `tdx-port:${name}:${lat},${lon}`,

        locationType:
          "port",

        rawTypes: [
          "port",
          "ship_port",
          "TDX",
        ],

        source:
          "TDX Ship Port",

        matchedQuery,

        providerRank:
          Math.max(
            0,
            10 -
            Math.round(
              bestScore /
              20
            )
          ),

        coordinatesGrounded:
          true,
      });
    }

    return {
      candidates:
        dedupeCandidates(
          candidates
        ),

      errors: [],

      available:
        loaded.available,

      endpoint:
        loaded.endpoint,
    };

  } catch (error) {
    console.warn(
      "TDX Port unavailable:",
      error.message
    );

    return {
      candidates: [],
      errors: [
        error.message,
      ],
      available: false,
    };
  }
}


const TGOS_POI_URL =
  "http://gis.tgos.tw/addresslocator/locate.aspx";

const tgosPoiCache =
  new TTLCache({
    ttlMs:
      Math.max(
        60_000,
        Number(
          process.env
            .PLACE_SEARCH_TGOS_CACHE_TTL_MS ||
          6 * 60 * 60_000
        )
      ),
  });

const tgosPoiInflight =
  new Map();


async function searchTgosPoiOne(
  query
) {
  const cleaned =
    clean(query);

  if (!cleaned) {
    return [];
  }

  const key =
    cleaned
      .toLowerCase();

  return await cachedAsync({
    cache:
      tgosPoiCache,

    inflight:
      tgosPoiInflight,

    key,

    shouldCache:
      (value) =>
        Array.isArray(value) &&
        value.length > 0,

    loader:
      async () => {
        const params =
          new URLSearchParams({
            op:
              "poi",

            format:
              "json",

            keyword:
              cleaned,
          });

        const response =
          await fetchWithTimeout(
            `${TGOS_POI_URL}?${params.toString()}`,
            {
              headers: {
                Accept:
                  "application/json,text/plain,*/*",

                "User-Agent":
                  "tdx-navigation-project/1.0",
              },
            },
            8000
          );

        if (!response.ok) {
          throw new Error(
            `TGOS HTTP ${response.status}`
          );
        }

        const text =
          await response.text();

        let data;

        try {
          data =
            JSON.parse(text);
        } catch {
          throw new Error(
            `TGOS returned non-JSON: ${text.slice(0, 100)}`
          );
        }

        const rows =
          Array.isArray(
            data?.Table
          )
            ? data.Table
            : Array.isArray(data)
              ? data
              : [];

        return rows
          .map(
            (
              item,
              index
            ) => {
              const lon =
                Number(
                  item?.E
                );

              const lat =
                Number(
                  item?.N
                );

              if (
                !validTaiwanCoordinate(
                  lat,
                  lon
                )
              ) {
                return null;
              }

              const name =
                clean(
                  item?.LANDMARKNA ||
                  item?.NAME
                );

              const address =
                clean(
                  item?.ADDRESS
                ) ||
                null;

              const county =
                clean(
                  item?.COUNTYNAME
                ) ||
                null;

              const district =
                clean(
                  item?.TOWNNAME
                ) ||
                null;

              const administrativeCity =
                inferCityHint(
                  county,
                  district,
                  address,
                  name
                ) ||
                null;

              return {
                lat,
                lon,

                displayName:
                  name ||
                  cleaned,

                address,

                state:
                  null,

                county,

                city:
                  county,

                district,

                locality:
                  null,

                administrativeCity,

                placeId:
                  `tgos:${name || cleaned}:${lat},${lon}`,

                locationType:
                  "poi",

                rawTypes: [
                  "poi",
                  "landmark",
                  "TGOS",
                ],

                source:
                  "TGOS POI",

                providerRank:
                  index,

                coordinatesGrounded:
                  true,
              };
            }
          )
          .filter(Boolean);
      },
  });
}


async function searchTgosPoiCandidates({
  queries,
}) {
  const candidates = [];
  const errors = [];

  /*
   * TGOS is fallback, so avoid blasting every
   * expanded city alias query.
   *
   * Raw query / normalized query / first aliases
   * are normally at the front of this array.
   */
  const planned =
    unique(
      queries
    )
      .slice(
        0,
        4
      );

  for (
    const query
    of planned
  ) {
    try {
      candidates.push(
        ...await searchTgosPoiOne(
          query
        )
      );
    } catch (error) {
      errors.push(
        error.message
      );

      console.warn(
        "TGOS POI unavailable:",
        query,
        error.message
      );
    }
  }

  return {
    candidates:
      dedupeCandidates(
        candidates
      ),

    errors,
  };
}


const tdxStationCache =
  new TTLCache({
    ttlMs:
      Math.max(
        60_000,
        Number(
          process.env
            .PLACE_SEARCH_TDX_STATION_CACHE_TTL_MS ||
          6 * 60 * 60_000
        )
      ),
  });

const tdxStationInflight =
  new Map();


function normalizeStationSearchText(
  value
) {
  return normalizeComparable(
    value
  )
    .replace(
      /台灣高速鐵路|臺灣高速鐵路|高鐵/g,
      ""
    )
    .replace(
      /台灣鐵路|臺灣鐵路|台鐵|臺鐵|火車/g,
      ""
    )
    .replace(
      /捷運|metro|mrt/gi,
      ""
    )
    .replace(
      /車站|station|站/gi,
      ""
    )
    .trim();
}


function stationName(
  station
) {
  return clean(
    station
      ?.StationName
      ?.Zh_tw ||
    station
      ?.StationName
      ?.ZhTW ||
    station
      ?.StationName
      ?.En ||
    station
      ?.StationName ||
    station
      ?.name ||
    ""
  );
}


function stationPosition(
  station
) {
  const pos =
    station?.StationPosition ||
    station?.Position ||
    station?.StationLocation ||
    station?.LocationPosition ||
    {};

  const lon =
    Number(
      pos?.PositionLon ??
      pos?.Longitude ??
      pos?.lon ??
      pos?.lng ??
      station?.PositionLon ??
      station?.Longitude
    );

  const lat =
    Number(
      pos?.PositionLat ??
      pos?.Latitude ??
      pos?.lat ??
      station?.PositionLat ??
      station?.Latitude
    );

  if (
    !validTaiwanCoordinate(
      lat,
      lon
    )
  ) {
    return null;
  }

  return {
    lat,
    lon,
  };
}


function metroSystemsForQuery({
  queries,
  cityHint,
}) {
  const text =
    queries.join(" ");

  if (
    cityHint === "Taipei" ||
    cityHint === "New Taipei" ||
    /台北|臺北|新北/.test(text)
  ) {
    return ["TRTC"];
  }

  if (
    cityHint === "Taoyuan" ||
    /桃園/.test(text)
  ) {
    return ["TYMC"];
  }

  if (
    cityHint === "Taichung" ||
    /台中|臺中/.test(text)
  ) {
    return ["TMRT"];
  }

  if (
    cityHint === "Kaohsiung" ||
    /高雄/.test(text)
  ) {
    return ["KRTC"];
  }

  /*
   * No reliable city hint:
   * search every supported metro system.
   * This is safer than guessing Taipei.
   */
  return [
    "TRTC",
    "TYMC",
    "TMRT",
    "KRTC",
  ];
}


function stationSearchPlan({
  queries,
  cityHint,
}) {
  const text =
    queries.join(" ");

  if (/高鐵/.test(text)) {
    return [
      {
        system:
          "THSR",

        load:
          () =>
            getTHSRStations(),
      },
    ];
  }

  if (/捷運|metro|mrt/i.test(text)) {
    return metroSystemsForQuery({
      queries,
      cityHint,
    })
      .map(
        (system) => ({
          system:
            `MRT:${system}`,

          load:
            () =>
              getMetroStations(
                system
              ),
        })
      );
  }

  if (
    /台鐵|臺鐵|火車|車站/.test(
      text
    )
  ) {
    return [
      {
        system:
          "TRA",

        load:
          () =>
            getTRAStations(),
      },
    ];
  }

  return [];
}


async function loadTdxStationSystem(
  item
) {
  return await cachedAsync({
    cache:
      tdxStationCache,

    inflight:
      tdxStationInflight,

    key:
      item.system,

    shouldCache:
      (value) =>
        Array.isArray(value) &&
        value.length > 0,

    loader:
      item.load,
  });
}


function stationDisplayName(
  name,
  system
) {
  if (
    system.startsWith(
      "MRT:"
    )
  ) {
    return `${name}捷運站`;
  }

  if (
    system ===
    "THSR"
  ) {
    return `高鐵${name}站`;
  }

  if (
    system ===
    "TRA"
  ) {
    return `${name}車站`;
  }

  return name;
}


function stationQueryScore(
  query,
  stationNameValue,
  system
) {
  const q =
    normalizeStationSearchText(
      query
    );

  const n =
    normalizeStationSearchText(
      stationNameValue
    );

  if (
    !q ||
    !n
  ) {
    return -1;
  }

  let score = -1;

  if (q === n) {
    score = 120;
  } else if (
    n.includes(q)
  ) {
    score = 95;
  } else if (
    q.includes(n)
  ) {
    score = 85;
  } else {
    return -1;
  }

  const raw =
    String(query || "");

  if (
    /捷運|metro|mrt/i.test(raw) &&
    system.startsWith("MRT:")
  ) {
    score += 40;
  }

  if (
    /高鐵/.test(raw) &&
    system === "THSR"
  ) {
    score += 40;
  }

  if (
    /台鐵|臺鐵|火車/.test(raw) &&
    system === "TRA"
  ) {
    score += 40;
  }

  return score;
}


async function searchTdxStationCandidates({
  queries,
  cityHint,
}) {
  const plan =
    stationSearchPlan({
      queries,
      cityHint,
    });

  if (!plan.length) {
    return {
      candidates: [],
      errors: [],
      available: false,
      successfulSystems: [],
    };
  }


  /*
   * These are semantic city aliases for THSR stations,
   * not coordinate hard-coding.
   *
   * They are only used AFTER:
   *   1. the query explicitly requests THSR, and
   *   2. normal station-name matching did not succeed.
   *
   * Station coordinates still come exclusively from TDX.
   */
  const THSR_CITY_STATION_ALIASES =
    new Map([
      [
        "Taipei",
        ["台北"],
      ],

      [
        "New Taipei",
        ["板橋"],
      ],

      [
        "Taoyuan",
        ["桃園"],
      ],

      [
        "Hsinchu",
        ["新竹"],
      ],

      [
        "Miaoli",
        ["苗栗"],
      ],

      [
        "Taichung",
        ["台中"],
      ],

      [
        "Changhua",
        ["彰化"],
      ],

      [
        "Yunlin",
        ["雲林"],
      ],

      [
        "Chiayi",
        ["嘉義"],
      ],

      [
        "Tainan",
        ["台南"],
      ],

      [
        "Kaohsiung",
        ["左營"],
      ],
    ]);


  function localizedText(
    value
  ) {
    if (
      typeof value ===
      "string"
    ) {
      return clean(value);
    }

    if (
      value &&
      typeof value ===
        "object"
    ) {
      return clean(
        value.Zh_tw ||
        value.ZhTW ||
        value.zh_tw ||
        value.En ||
        value.en ||
        Object.values(value)
          .find(
            item =>
              typeof item ===
              "string"
          ) ||
        ""
      );
    }

    return "";
  }


  function stationAddressText(
    station
  ) {
    const values = [
      station?.StationAddress,
      station?.Address,
      station?.StationAddressZh,
      station?.LocationAddress,
    ];

    for (
      const value
      of values
    ) {
      const text =
        localizedText(
          value
        );

      if (text) {
        return text;
      }
    }

    return "";
  }


  function stationAdministrativeCity(
    station,
    name
  ) {
    const address =
      stationAddressText(
        station
      );

    const city =
      inferCityHint(
        station?.City,
        station?.CityName,
        station?.County,
        station?.CountyName,
        address
      );

    if (city) {
      return city;
    }

    /*
     * Name itself is only weak fallback evidence.
     */
    return inferCityHint(
      name
    );
  }


  function thsrCitySemanticMatch(
    name,
    targetCity
  ) {
    if (
      !targetCity
    ) {
      return false;
    }

    const aliases =
      THSR_CITY_STATION_ALIASES
        .get(
          targetCity
        ) ||
      [];

    const normalizedName =
      normalizeStationSearchText(
        name
      );

    return aliases.some(
      alias =>
        normalizeStationSearchText(
          alias
        ) ===
        normalizedName
    );
  }


  const settled =
    await Promise.allSettled(
      plan.map(
        item =>
          loadTdxStationSystem(
            item
          )
      )
    );


  const candidates = [];
  const errors = [];
  const successfulSystems =
    [];


  settled.forEach(
    (
      result,
      index
    ) => {
      const system =
        plan[index].system;


      if (
        result.status !==
        "fulfilled"
      ) {
        errors.push(
          `TDX ${system}: ${
            result.reason
              ?.message ||
            "unknown error"
          }`
        );

        return;
      }


      /*
       * Important:
       *
       * Provider health and candidate matching
       * are two different things.
       *
       * A successful empty list means:
       * provider is available, but no match.
       */
      successfulSystems.push(
        system
      );


      const stations =
        Array.isArray(
          result.value
        )
          ? result.value
          : [];


      for (
        const station
        of stations
      ) {
        const name =
          stationName(
            station
          );

        const position =
          stationPosition(
            station
          );

        if (
          !name ||
          !position
        ) {
          continue;
        }


        let bestScore =
          -1;

        let matchedQuery =
          null;


        /*
         * First priority:
         * actual station-name matching.
         */
        for (
          const query
          of queries
        ) {
          const score =
            stationQueryScore(
              query,
              name,
              system
            );

          if (
            score >
            bestScore
          ) {
            bestScore =
              score;

            matchedQuery =
              query;
          }
        }


        const address =
          stationAddressText(
            station
          );

        const stationCity =
          stationAdministrativeCity(
            station,
            name
          );


        /*
         * City consistency may BOOST a real name match,
         * but does not blindly turn unrelated MRT / TRA
         * stations into matches.
         */
        if (
          bestScore >= 0 &&
          cityHint &&
          stationCity ===
            cityHint
        ) {
          bestScore +=
            25;
        }


        /*
         * THSR-specific semantic fallback:
         *
         * User language often describes the station
         * by destination city rather than official
         * StationName.
         *
         * Example:
         * 高雄高鐵站 -> official 左營站.
         *
         * Coordinates still come from official TDX
         * station data.
         */
        if (
          system ===
            "THSR" &&
          cityHint &&
          bestScore < 80
        ) {
          const metadataCityMatch =
            stationCity ===
            cityHint;

          const officialAliasMatch =
            thsrCitySemanticMatch(
              name,
              cityHint
            );

          if (
            metadataCityMatch ||
            officialAliasMatch
          ) {
            bestScore =
              metadataCityMatch
                ? 118
                : 112;

            matchedQuery =
              queries[0] ||
              null;
          }
        }


        if (
          bestScore < 80
        ) {
          continue;
        }


        const displayName =
          system === "THSR"
            ? `高鐵${name}站`
            : system.startsWith(
                "MRT:"
              )
              ? `${name}捷運站`
              : `${name}車站`;


        candidates.push({
          lat:
            position.lat,

          lon:
            position.lon,

          displayName,

          address:
            address ||
            null,

          placeId:
            clean(
              station
                ?.StationUID ||
              station
                ?.StationID
            ) ||
            `${system}:${name}`,

          locationType:
            "station",

          rawTypes: [
            "station",
            "railway",
            system,
            "TDX",
          ],

          stationSystem:
            system,

          matchedQuery,

          city:
            stationCity ||
            null,

          county:
            null,

          state:
            null,

          district:
            null,

          locality:
            null,

          administrativeCity:
            stationCity ||
            null,

          coordinatesGrounded:
            true,

          source:
            "TDX Station",

          providerRank:
            Math.max(
              0,
              10 -
              Math.round(
                bestScore /
                20
              )
            ),

          stationMatchScore:
            bestScore,
        });
      }
    }
  );


  return {
    candidates:
      dedupeCandidates(
        candidates
      ),

    errors,

    available:
      successfulSystems
        .length > 0,

    successfulSystems,
  };
}


async function searchPhoton({
  query,
  nearLat,
  nearLon,
}) {
  const hasNear = validTaiwanCoordinate(
    Number(nearLat),
    Number(nearLon)
  );

  const cacheKey = [
    clean(query).toLowerCase(),
    hasNear
      ? Number(nearLat).toFixed(4)
      : "",
    hasNear
      ? Number(nearLon).toFixed(4)
      : "",
  ].join("|");

  return await cachedAsync({
    cache: photonSearchCache,
    inflight: photonSearchInflight,
    key: cacheKey,
    loader: async () => {
      if (
        Date.now() <
        photonCircuitOpenUntil
      ) {
        const error =
          new Error(
            "Photon circuit open"
          );

        error.code =
          "PHOTON_CIRCUIT_OPEN";

        throw error;
      }

      const params = new URLSearchParams({
        q: query,
        limit: "10",

        // 台灣及離島的大範圍 bbox。
        bbox: "118,21,124,27",
      });

      if (hasNear) {
        params.set(
          "lat",
          String(Number(nearLat))
        );

        params.set(
          "lon",
          String(Number(nearLon))
        );
      }

      // 不再使用 lang=zh。
      let response;

      try {
        response =
          await fetchWithTimeout(
            `${PHOTON_URL}?${params.toString()}`,
            {
              headers: {
                Accept:
                  "application/json",

                "Accept-Language":
                  "zh-TW,zh;q=0.9,en;q=0.7",

                "User-Agent":
                  "tdx-navigation-project/1.0",
              },
            },
            9000
          );

        /*
         * Provider recovered.
         */
        photonCircuitOpenUntil =
          0;

      } catch (error) {
        photonCircuitOpenUntil =
          Date.now() +
          PHOTON_CIRCUIT_BREAK_MS;

        throw error;
      }

      if (!response.ok) {
        const responseText = await response.text();

        throw new Error(
          `Photon HTTP ${response.status}: ${responseText.slice(0, 150)}`
        );
      }

      const data = await response.json();

      const features =
        Array.isArray(data?.features)
          ? data.features
          : [];

      return features
        .map((feature, index) => {
          const props =
            feature?.properties || {};

          const coords =
            feature?.geometry?.coordinates || [];

          const lon = Number(coords[0]);
          const lat = Number(coords[1]);

          if (!validTaiwanCoordinate(lat, lon)) {
            return null;
          }

          const state = clean(props?.state) || null;
          const county = clean(props?.county) || null;
          const city = clean(props?.city) || null;
          const district = clean(props?.district) || null;
          const locality = clean(
            props?.locality ||
            props?.suburb ||
            props?.neighbourhood
          ) || null;

          const administrativeCity =
            inferCityHint(
              state,
              county,
              city,
              district,
              locality
            ) || null;

          const name =
            clean(props?.name) ||
            clean(props?.street) ||
            city ||
            district ||
            query;

          const address = [
            props?.housenumber && props?.street
              ? `${props.street} ${props.housenumber}`
              : props?.street,

            locality,
            district,
            city,
            county,
            state,
            props?.postcode,
            props?.country,
          ]
            .filter(Boolean)
            .filter(
              (value, i, arr) =>
                arr.indexOf(value) === i
            )
            .join(", ");

          return {
            lat,
            lon,

            displayName: name,

            address:
              address || null,

            // Keep raw administrative levels instead of assuming Photon
            // always puts the municipality in props.city.
            city,
            county,
            state,
            district,
            locality,
            administrativeCity,

            placeId:
              `photon:${props?.osm_type || "x"}:${props?.osm_id || `${lat},${lon}`}`,

            locationType:
              props?.type ||
              props?.osm_value ||
              "place",

            rawTypes: [
              props?.osm_key,
              props?.osm_value,
              props?.type,
            ].filter(Boolean),

            source:
              "Photon / OpenStreetMap",

            providerRank:
              index,

            coordinatesGrounded:
              true,
          };
        })
        .filter(Boolean);
    },
  });
}



/*
 * TDX_ADDRESS_V3_PROVIDER_V5
 *
 * Official Taiwan address geocoder.
 *
 * Proven endpoint:
 * /api/advanced/V3/Map/GeoCode/Coordinate/Address/{address}
 *
 * This provider is used only for address-like searches.
 * AI never creates coordinates.
 */
function parseTdxPointGeometry(
  geometry
) {
  const match =
    String(
      geometry || ""
    ).match(
      /POINT(?:\s+Z)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+-?\d+(?:\.\d+)?)?\s*\)/i
    );

  if (!match) {
    return null;
  }

  const lon =
    Number(match[1]);

  const lat =
    Number(match[2]);

  if (
    !validTaiwanCoordinate(
      lat,
      lon
    )
  ) {
    return null;
  }

  return {
    lat,
    lon,
  };
}


async function searchTdxAddressV3({
  queries,
  cityHint,
}) {
  const attempts =
    unique(
      queries || []
    )
      .filter(Boolean)
      .slice(
        0,
        3
      );

  const candidates = [];
  const errors = [];

  let available = false;

  /*
   * Dynamic import avoids changing the module's
   * existing top-level dependency structure.
   */
  let fetchTdxJson;

  try {
    ({
      fetchTdxJson,
    } = await import(
      "./tdxClient.js"
    ));
  } catch (error) {
    return {
      candidates: [],
      errors: [
        `TDX address client unavailable: ${error.message}`,
      ],
      available: false,
    };
  }

  for (
    const query of
    attempts
  ) {
    const url =
      "https://tdx.transportdata.tw/api/advanced/V3/Map/GeoCode/Coordinate/Address/" +
      encodeURIComponent(
        query
      ) +
      "?%24format=JSON";

    try {
      const data =
        await fetchTdxJson(
          url,
          {
            timeoutMs:
              12000,

            cacheMs:
              24 *
              60 *
              60 *
              1000,

            max429Retries:
              1,
          }
        );

      available = true;

      const list =
        Array.isArray(data)
          ? data
          : Array.isArray(
              data?.GeoCodes
            )
            ? data.GeoCodes
            : Array.isArray(
                data?.data
              )
              ? data.data
              : [];

      console.log(
        "[TDX address V3]",
        {
          query,
          results:
            list.length,
        }
      );

      for (
        const item of
        list
      ) {
        const point =
          parseTdxPointGeometry(
            item?.Geometry ||
            item?.geometry ||
            item?.WKT
          );

        const lat =
          Number(
            item?.PositionLat ??
            item?.Latitude ??
            item?.lat ??
            point?.lat
          );

        const lon =
          Number(
            item?.PositionLon ??
            item?.Longitude ??
            item?.lon ??
            item?.lng ??
            point?.lon
          );

        if (
          !validTaiwanCoordinate(
            lat,
            lon
          )
        ) {
          continue;
        }

        const address =
          clean(
            item?.AddressNew ||
            item?.Address ||
            item?.Name ||
            query
          );

        candidates.push({
          lat,
          lon,

          displayName:
            address ||
            query,

          address:
            address ||
            query,

          city:
            cityHint ||
            null,

          county:
            null,

          state:
            null,

          district:
            null,

          locality:
            null,

          administrativeCity:
            cityHint ||
            null,

          placeId:
            item?.PlaceID ||
            item?.ID ||
            `tdx-address:${query}:${lat},${lon}`,

          locationType:
            "address",

          rawTypes: [
            "address",
            "house",
            "TDX Advanced Address Geocoding V3",
          ],

          source:
            "TDX Advanced Address Geocoding V3",

          matchedQuery:
            query,

          coordinatesGrounded:
            true,

          geometry:
            item?.Geometry ||
            null,

          providerRank:
            0,
        });
      }

      /*
       * An exact official result is enough.
       * Do not keep querying aliases.
       */
      if (
        candidates.length
      ) {
        break;
      }

    } catch (error) {
      errors.push(
        String(
          error?.message ||
          error
        )
      );

      console.log(
        "[TDX address V3] unavailable:",
        query,
        error.message
      );
    }
  }

  return {
    candidates:
      dedupeCandidates(
        candidates
      ),

    errors,

    available,
  };
}


function dedupeCandidates(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key =
      `${Number(item.lat).toFixed(5)},` +
      `${Number(item.lon).toFixed(5)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

const PHOTON_MAX_QUERIES = Math.max(
  1,
  Number(process.env.PLACE_SEARCH_PHOTON_MAX_QUERIES || 6)
);

const PHOTON_CONCURRENCY = Math.max(
  1,
  Number(process.env.PLACE_SEARCH_PHOTON_CONCURRENCY || 3)
);

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      run
    )
  );

  return results;
}


async function searchNominatimFallback({
  queries,
}) {
  const sourceQueries =
    unique(
      queries || []
    );

  const expanded = [];

  for (
    const query of
    sourceQueries
  ) {
    expanded.push(
      query
    );

    /*
     * 台中勤美誠品
     * -> 勤美誠品
     */
    const withoutCity =
      clean(query)
        .replace(
          /^(台北|臺北|新北|桃園|新竹|苗栗|台中|臺中|彰化|南投|雲林|嘉義|台南|臺南|高雄|基隆|宜蘭|花蓮|台東|臺東)(市|縣)?\s*/u,
          ""
        )
        .trim();

    if (
      withoutCity &&
      withoutCity !==
        query
    ) {
      expanded.push(
        withoutCity
      );
    }
  }

  /*
   * One user action:
   * maximum two Nominatim requests.
   */
  const attempts =
    unique(
      expanded
    ).slice(
      0,
      2
    );

  const found = [];
  const errors = [];

  for (
    const query of
    attempts
  ) {
    try {
      /*
       * Keep public service request rate
       * below one request per second.
       */
      const elapsed =
        Date.now() -
        lastNominatimRequestAt;

      if (
        elapsed <
        1100
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1100 -
                elapsed
            )
        );
      }

      lastNominatimRequestAt =
        Date.now();

      const params =
        new URLSearchParams({
          q:
            query,

          format:
            "jsonv2",

          addressdetails:
            "1",

          limit:
            "8",

          countrycodes:
            "tw",

          "accept-language":
            "zh-TW,zh,en",
        });

      const response =
        await fetchWithTimeout(
          `${NOMINATIM_URL}?${params.toString()}`,
          {
            headers: {
              Accept:
                "application/json",

              "User-Agent":
                "RiskNav/1.0 Taiwan navigation research project",
            },
          },
          10000
        );

      if (
        !response.ok
      ) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const data =
        await response.json();

      const rows =
        Array.isArray(
          data
        )
          ? data
          : [];

      const candidates =
        rows
          .map(
            (
              item,
              index
            ) => {
              const lat =
                Number(
                  item?.lat
                );

              const lon =
                Number(
                  item?.lon
                );

              if (
                !validTaiwanCoordinate(
                  lat,
                  lon
                )
              ) {
                return null;
              }

              const address =
                item?.address ||
                {};

              const administrativeCity =
                clean(
                  address.city ||
                  address.municipality ||
                  address.county ||
                  address.state
                ) ||
                null;

              return {
                lat,
                lon,

                displayName:
                  clean(
                    item?.name ||
                    String(
                      item
                        ?.display_name ||
                      ""
                    ).split(
                      ","
                    )[0]
                  ) ||
                  query,

                address:
                  clean(
                    item
                      ?.display_name
                  ) ||
                  null,

                city:
                  clean(
                    address.city
                  ) ||
                  null,

                county:
                  clean(
                    address.county
                  ) ||
                  null,

                state:
                  clean(
                    address.state
                  ) ||
                  null,

                district:
                  clean(
                    address.city_district ||
                    address.suburb ||
                    address.town
                  ) ||
                  null,

                locality:
                  clean(
                    address.neighbourhood ||
                    address.village
                  ) ||
                  null,

                administrativeCity,

                placeId:
                  `nominatim:${
                    item?.osm_type ||
                    "x"
                  }:${
                    item?.osm_id ||
                    `${lat},${lon}`
                  }`,

                locationType:
                  clean(
                    item?.type ||
                    item?.category
                  ) ||
                  "place",

                rawTypes: [
                  item?.category,
                  item?.type,
                  item?.addresstype,
                ].filter(
                  Boolean
                ),

                source:
                  "OpenStreetMap / Nominatim",

                providerRank:
                  index,

                coordinatesGrounded:
                  true,

                matchedQuery:
                  query,
              };
            }
          )
          .filter(
            Boolean
          );

      console.log(
        "[Nominatim fallback]",
        {
          query,
          candidates:
            candidates.length,
        }
      );

      if (
        candidates.length
      ) {
        found.push(
          ...candidates
        );

        break;
      }

    } catch (
      error
    ) {
      errors.push(
        `Nominatim ${query}: ${error.message}`
      );

      console.warn(
        "Nominatim search unavailable:",
        query,
        error.message
      );
    }
  }

  return {
    candidates:
      dedupeCandidates(
        found
      ),

    errors,
  };
}


async function searchQueries({
  queries,
  nearLat,
  nearLon,
}) {
  const found = [];
  const errors = [];

  for (
    const query of
    unique(queries)
  ) {
    try {
      const items =
        await searchPhoton({
          query,
          nearLat,
          nearLon,
        });

      found.push(
        ...items
      );
    } catch (error) {
      const message =
        String(
          error?.message ||
          error
        );

      errors.push(
        message
      );

      console.log(
        "Photon search unavailable:",
        message
      );

      /*
       * Once the Photon circuit is open,
       * don't repeat the same doomed request
       * for every alias.
       */
      if (
        /circuit open/i.test(
          message
        )
      ) {
        break;
      }
    }
  }

  return {
    candidates:
      dedupeCandidates(
        found
      ),

    errors,
  };
}

const TDX_CITY_RULES = [
  ["NewTaipei", [
    "新北市",
    "new taipei city",
    "new taipei"
  ]],

  ["Taipei", [
    "台北市",
    "臺北市",
    "taipei city"
  ]],

  ["Taoyuan", [
    "桃園市",
    "taoyuan city"
  ]],

  ["Taichung", [
    "台中市",
    "臺中市",
    "taichung city"
  ]],

  ["Tainan", [
    "台南市",
    "臺南市",
    "tainan city"
  ]],

  ["Kaohsiung", [
    "高雄市",
    "kaohsiung city"
  ]],

  ["Keelung", [
    "基隆市",
    "keelung city"
  ]],

  ["HsinchuCounty", [
    "新竹縣",
    "hsinchu county"
  ]],

  ["Hsinchu", [
    "新竹市",
    "hsinchu city"
  ]],

  ["MiaoliCounty", [
    "苗栗縣",
    "miaoli county"
  ]],

  ["ChanghuaCounty", [
    "彰化縣",
    "changhua county"
  ]],

  ["NantouCounty", [
    "南投縣",
    "nantou county"
  ]],

  ["YunlinCounty", [
    "雲林縣",
    "yunlin county"
  ]],

  ["ChiayiCounty", [
    "嘉義縣",
    "chiayi county"
  ]],

  ["Chiayi", [
    "嘉義市",
    "chiayi city"
  ]],

  ["PingtungCounty", [
    "屏東縣",
    "pingtung county"
  ]],

  ["YilanCounty", [
    "宜蘭縣",
    "yilan county"
  ]],

  ["HualienCounty", [
    "花蓮縣",
    "hualien county"
  ]],

  ["TaitungCounty", [
    "台東縣",
    "臺東縣",
    "taitung county"
  ]],

  ["PenghuCounty", [
    "澎湖縣",
    "penghu county"
  ]],

  ["KinmenCounty", [
    "金門縣",
    "kinmen county"
  ]],

  ["LienchiangCounty", [
    "連江縣",
    "lienchiang county"
  ]],
];


// ADMIN_CITY_FIX_V1
function tdxCityFromAdministrativeText(value) {
  const normalize = v => String(v || "").replace(/臺/g, "台")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const fields = Array.isArray(value) ? value : [value];
  for (const field of fields) {
    const text = normalize(field);
    if (!text) continue;
    for (const [code, aliases] of TDX_CITY_RULES) {
      const names = [...aliases];
      // Hsinchu / Chiayi alone cannot distinguish city from county.
      if (!["Hsinchu", "Chiayi"].includes(code)) names.push(code);
      if (names.some(name => normalize(name) === text)) return code;
    }
  }
  return null;
}

const reverseGeocodeCache =
  new Map();


export async function reverseGeocodeCoordinate({
  lat,
  lon,
}) {
  const latitude =
    Number(lat);

  const longitude =
    Number(lon);

  if (
    !validTaiwanCoordinate(
      latitude,
      longitude
    )
  ) {
    return null;
  }

  const cacheKey =
    `${latitude.toFixed(4)},${longitude.toFixed(4)}`;

  if (
    reverseGeocodeCache.has(
      cacheKey
    )
  ) {
    return reverseGeocodeCache.get(
      cacheKey
    );
  }

  const params =
    new URLSearchParams({
      lat:
        String(latitude),

      lon:
        String(longitude),
    });

  const response =
    await fetchWithTimeout(
      `https://photon.komoot.io/reverse?${params.toString()}`,
      {
        headers: {
          Accept:
            "application/json",

          "Accept-Language":
            "zh-TW,zh;q=0.9,en;q=0.7",

          "User-Agent":
            "tdx-navigation-project/1.0",
        },
      },
      8000
    );

  if (!response.ok) {
    throw new Error(
      `Photon reverse HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const feature =
    Array.isArray(
      data?.features
    )
      ? data.features[0]
      : null;

  const props =
    feature?.properties ||
    null;

  if (!props) {
    console.warn(
      "[Photon reverse] no feature",
      {
        lat:
          latitude,

        lon:
          longitude,
      }
    );

    return null;
  }

  const administrativeText =
    [
      props?.state,
      props?.county,
      props?.city,
      props?.district,
    ]
      .filter(Boolean)
      .join(" ");

  const tdxCity =
    tdxCityFromAdministrativeText(
      administrativeText
    );

  const result = {
    lat:
      latitude,

    lon:
      longitude,

    tdxCity,

    city:
      clean(
        props?.city
      ) || null,

    county:
      clean(
        props?.county
      ) || null,

    municipality:
      clean(
        props?.city
      ) || null,

    subdivision:
      clean(
        props?.state ||
        props?.county
      ) || null,

    district:
      clean(
        props?.district
      ) || null,

    address:
      [
        props?.name,
        props?.street,
        props?.district,
        props?.city,
        props?.county,
        props?.state,
      ]
        .filter(Boolean)
        .filter(
          (value, index, array) =>
            array.indexOf(value) === index
        )
        .join(", ") ||
      null,

    source:
      "Photon Reverse Geocoding",
  };

  console.log(
    "[Photon reverse]",
    {
      lat:
        latitude,

      lon:
        longitude,

      city:
        result.city,

      county:
        result.county,

      subdivision:
        result.subdivision,

      district:
        result.district,

      tdxCity:
        result.tdxCity,
    }
  );

  /*
   * Only cache successfully classified
   * administrative areas.
   */
  if (result.tdxCity) {
    reverseGeocodeCache.set(
      cacheKey,
      result
    );
  }

  return result;
}


export async function resolvePlaceUniversal({
  query,
  groqApiKey = "",
  nearLat = null,
  nearLon = null,
}) {
  const rawQuery =
    clean(query);

  if (!rawQuery) {
    const error =
      new Error("請輸入地點");

    error.status = 400;
    throw error;
  }

  /*
   * 直接輸入經緯度時，
   * 不需要做文字搜尋。
   */
  const direct =
    directCoordinate(
      rawQuery
    );

  if (direct) {
    const result = {
      ...direct,

      displayName:
        rawQuery,

      address:
        null,

      placeId:
        `coordinate:${direct.lat},${direct.lon}`,

      locationType:
        "coordinate",

      rawTypes: [
        "coordinate",
      ],

      source:
        "Direct coordinate",

      coordinatesGrounded:
        true,
    };

    return {
      input:
        rawQuery,

      normalized: {
        normalizedQuery:
          rawQuery,

        aliases: [],

        cityHint: "",

        placeType:
          "coordinate",

        confidence: 1,

        reason:
          "Direct coordinate",
      },

      result,

      candidates: [
        result,
      ],

      source:
        result.source,

      validation: {
        accepted: true,

        coordinatesGrounded:
          true,

        aiGeneratedCoordinates:
          false,

        taiwanOnly:
          true,

        locationBiasUsed:
          false,
      },
    };
  }

  const resolvedCacheKey =
    resolvedPlaceCacheKey(
      rawQuery,
      nearLat,
      nearLon
    );

  const cachedResolved =
    await getResolvedPlaceCache(
      resolvedCacheKey
    );

  if (
    cachedResolved?.result &&
    validTaiwanCoordinate(
      cachedResolved.result.lat,
      cachedResolved.result.lon
    )
  ) {
    const cachedResult = {
      ...cachedResolved.result,
    };

    console.log(
      "[place resolved cache] HIT",
      {
        query:
          rawQuery,

        displayName:
          cachedResult
            .displayName,

        source:
          cachedResult.source,
      }
    );

    return {
      input:
        rawQuery,

      normalized:
        cachedResolved.normalized || {
          normalizedQuery:
            rawQuery,

          aliases: [],

          cityHint: "",

          cityHintSource:
            "cache",

          cityHintStrength:
            "cache",

          placeType:
            cachedResult
              .locationType ||
            "poi",

          confidence: 1,

          reason:
            "Previously grounded resolved-place cache",
        },

      result:
        cachedResult,

      candidates: [
        cachedResult,
      ],

      source:
        cachedResult.source,

      validation: {
        accepted: true,

        coordinatesGrounded:
          true,

        aiGeneratedCoordinates:
          false,

        taiwanOnly:
          true,

        locationBiasUsed:
          validTaiwanCoordinate(
            Number(nearLat),
            Number(nearLon)
          ),

        resolvedPlaceCacheHit:
          true,
      },
    };
  }


  /*
   * 每次都做文字理解。
   *
   * Groq 只能：
   * - 修正錯字
   * - 正規化名稱
   * - 提供 aliases
   * - 判斷城市 / 類型
   *
   * AI 絕對不產生座標。
   */
  const normalized =
    await normalizeWithGroq(
      rawQuery,
      groqApiKey
    );

  /*
   * 城市不只依賴 AI。
   * 使用者原始輸入本身如果包含
   * 台中、台南、高雄等，就直接辨識。
   */
  let cityHintInfo =
    resolveCityHintInfo({
      rawQuery,
      normalizedQuery:
        normalized.normalizedQuery,
      aiCityHint:
        normalized.cityHint,
    });

  let cityHint =
    cityHintInfo.cityHint;

  /*
   * NEARBY_CITY_CONTEXT_V1
   *
   * Explicit city text always wins.
   *
   * Otherwise, if the user shared current location,
   * derive the nearby administrative city from
   * grounded reverse geocoding.
   *
   * This is especially useful for:
   *   長江路一段220號
   *   中山路100號
   *   民權路三段...
   */
  if (
    ![
      "raw-query",
      "raw-district",
    ].includes(
      cityHintInfo.source
    ) &&
    validTaiwanCoordinate(
      Number(nearLat),
      Number(nearLon)
    )
  ) {
    try {
      const nearArea =
        await reverseGeocodeCoordinate({
          lat:
            Number(nearLat),

          lon:
            Number(nearLon),
        });

      const nearbyCity =
        nearArea?.tdxCity ||
        inferCityHint(
          nearArea?.city,
          nearArea?.county,
          nearArea?.subdivision,
          nearArea?.district
        );

      if (nearbyCity) {
        cityHint =
          nearbyCity;

        cityHintInfo = {
          cityHint:
            nearbyCity,

          source:
            "near-location",

          strength:
            "normalized",
        };

        console.log(
          "[place nearby context]",
          {
            cityHint:
              nearbyCity,

            district:
              nearArea?.district ||
              null,
          }
        );
      }
    } catch (error) {
      console.log(
        "[place nearby context] unavailable:",
        error.message
      );
    }
  }

  /*
   * RAW_DISTRICT_ADDRESS_NORMALIZATION_V3
   */
  const rawDistrictFix =
    rawDistrictContext(
      rawQuery
    );

  const canonicalRawAddress =
    canonicalAddressFromRawDistrict(
      rawQuery,
      rawDistrictFix
    );

  if (
    canonicalRawAddress
  ) {
    const safeAliases =
      Array.isArray(
        normalized.aliases
      )
        ? normalized.aliases.filter(
            (alias) => {
              const aliasCity =
                normalizeCityName(
                  alias
                );

              return (
                !aliasCity ||
                aliasCity ===
                  rawDistrictFix.city
              );
            }
          )
        : [];

    normalized.normalizedQuery =
      canonicalRawAddress;

    normalized.aliases =
      unique([
        canonicalRawAddress,
        rawQuery,
        ...safeAliases,
      ]);

    normalized.cityHint =
      rawDistrictFix.city;

    console.log(
      "[place raw district context]",
      {
        rawQuery,
        city:
          rawDistrictFix.city,
        district:
          rawDistrictFix.district,
        canonical:
          canonicalRawAddress,
      }
    );
  }

  const detectedPlaceType =
    normalized.placeType &&
    normalized.placeType !==
      "unknown"
      ? normalized.placeType
      : placeTypeFromText(
          rawQuery
        );

  /*
   * 搜尋多種文字版本。
   *
   * 例如：
   * 台中車佔
   * ↓
   * 台中車站
   * Taichung 台中車站
   */
  /*
   * Never turn an AI guess like Taipei into
   * "台北 巨蛋站".
   *
   * Only a city explicitly typed by the user
   * may constrain / expand provider queries.
   */
  const cityTerms =
    cityHintInfo.strength ===
      "explicit"
      ? cityQueryTerms(
          cityHint
        )
      : [];

  /*
   * 城市前綴只用「一個中文名稱」，而且原句已經有城市名就不再加。
   * 以前會產生 6 條以上的城市別名 query（還混英文 canonical），
   * 對 Photon 只是雜訊，也讓搜尋變慢。
   */
  const cityPrefix =
    cityTerms.find((term) => /[^\x00-\x7F]/.test(term)) ||
    "";

  const withCityPrefix = (text) =>
    cityPrefix && text && !normalizeCityName(text)
      ? `${cityPrefix} ${text}`
      : "";

  const queries =
    unique([
      rawQuery,

      normalized.normalizedQuery,

      ...(normalized.aliases || []),

      withCityPrefix(
        normalized.normalizedQuery || rawQuery
      ),

      withCityPrefix(rawQuery),
    ]);

  console.log(
    "[place search]",
    {
      rawQuery,

      normalizedQuery:
        normalized
          .normalizedQuery,

      aliases:
        normalized.aliases,

      cityHint,

      cityHintSource:
        cityHintInfo.source,

      cityHintStrength:
        cityHintInfo.strength,

      placeType:
        detectedPlaceType,

      queries,
    }
  );

  /*
   * Photon grounded place search.
   * Groq only normalizes text and never
   * generates coordinates.
   */
  /*
   * Run grounded providers independently.
   *
   * Photon:
   *   general POI / address provider
   *
   * TDX:
   *   authoritative rail / metro station provider
   *
   * A Photon outage must NOT make all station
   * searches fail.
   */
  const [
    photonSearch,
    tdxStationSearch,
  ] =
    await Promise.all([
      searchQueries({
        queries,
        nearLat,
        nearLon,
      }),

      detectedPlaceType === "station"
        ? searchTdxStationCandidates({
            queries,
            cityHint,
          })
        : Promise.resolve({
            candidates: [],
            errors: [],
          }),
    ]);


  /*
   * Generic Taiwan POI fallback.
   *
   * Do not depend on Photon alone.
   *
   * TDX handles official rail/metro stations.
   * TGOS handles general Taiwan landmarks / POIs
   * when Photon is unavailable or returns nothing.
   */
  let tgosSearch = {
    candidates: [],
    errors: [],
  };

  /*
   * Legacy TGOS endpoint currently rejects anonymous
   * requests with "Invalid key".
   *
   * Keep the implementation isolated but disabled by
   * default instead of treating it as a reliable fallback.
   */
  if (
    String(
      process.env
        .TGOS_LEGACY_POI_ENABLED ||
      ""
    ).toLowerCase() ===
      "true" &&
    photonSearch
      .candidates
      .length === 0 &&
    detectedPlaceType !==
      "station"
  ) {
    tgosSearch =
      await searchTgosPoiCandidates({
        queries,
      });
  }


  const search = {
    candidates:
      dedupeCandidates([
        ...tdxStationSearch
          .candidates,

        ...photonSearch
          .candidates,

        ...tgosSearch
          .candidates,
      ]),

    errors: [
      ...photonSearch
        .errors,

      ...tdxStationSearch
        .errors,

      ...tgosSearch
        .errors,
    ],

    providers: {
      photonCandidates:
        photonSearch
          .candidates
          .length,

      tdxStationCandidates:
        tdxStationSearch
          .candidates
          .length,

      tgosCandidates:
        tgosSearch
          .candidates
          .length,
    },
  };



  /*
   * General Taiwan POI source.
   *
   * This is independent of Photon, therefore a Photon
   * outage must not take down POI search.
   */
  const tdxTourismSearch =
    (
      detectedPlaceType !==
        "station" &&
      detectedPlaceType !==
        "address"
    )
      ? await searchTdxTourismCandidates({
          queries,
          placeType:
            detectedPlaceType,
        })
      : {
          candidates: [],
          errors: [],
          available: false,
          successfulQueries: 0,
        };


  if (
    tdxTourismSearch
      .candidates
      .length
  ) {
    search.candidates =
      dedupeCandidates([
        ...tdxTourismSearch
          .candidates,

        ...search.candidates,
      ]);
  }


  search.errors.push(
    ...tdxTourismSearch
      .errors
  );


  search.providers
    .tdxTourismCandidates =
      tdxTourismSearch
        .candidates
        .length;


  search.providers
    .tdxTourismAvailable =
      tdxTourismSearch
        .available;

  search.providers
    .tdxTourismResources =
      tdxTourismSearch
        .resourceStatus ||
      {};



  const tdxPortSearch =
    await searchTdxPortCandidates({
      queries,
    });


  if (
    tdxPortSearch
      .candidates
      .length
  ) {
    search.candidates =
      dedupeCandidates([
        ...tdxPortSearch
          .candidates,

        ...search.candidates,
      ]);
  }


  search.errors.push(
    ...tdxPortSearch
      .errors
  );


  search.providers
    .tdxPortCandidates =
      tdxPortSearch
        .candidates
        .length;


  search.providers
    .tdxPortAvailable =
      tdxPortSearch
        .available;


  search.providers
    .tdxStationAvailable =
      Boolean(
        tdxStationSearch
          .available
      );

  search.providers
    .tdxStationSuccessfulSystems =
      tdxStationSearch
        .successfulSystems ||
      [];


  /*
   * TDX_ADDRESS_HOOK_V5
   *
   * Official Taiwan address data gets priority
   * over the public OSM fallback.
   */
  if (
    detectedPlaceType ===
      "address" &&
    !search.candidates.length
  ) {
    const tdxAddressSearch =
      await searchTdxAddressV3({
        queries: [
          normalized
            .normalizedQuery ||
            rawQuery,

          rawQuery,

          ...(normalized
            .aliases ||
            []),
        ],

        cityHint,
      });

    if (
      tdxAddressSearch
        .candidates
        .length
    ) {
      search.candidates =
        dedupeCandidates([
          ...tdxAddressSearch
            .candidates,

          ...search.candidates,
        ]);
    }

    search.errors.push(
      ...tdxAddressSearch
        .errors
    );

    search.providers
      .tdxAddressCandidates =
        tdxAddressSearch
          .candidates
          .length;

    search.providers
      .tdxAddressAvailable =
        tdxAddressSearch
          .available;

    console.log(
      "[TDX address hook]",
      {
        candidates:
          tdxAddressSearch
            .candidates
            .length,

        available:
          tdxAddressSearch
            .available,

        errors:
          tdxAddressSearch
            .errors,
      }
    );
  } else {
    search.providers
      .tdxAddressCandidates =
        0;

    search.providers
      .tdxAddressAvailable =
        null;
  }


  /*
   * NOMINATIM_ADDRESS_HOOK_V4B
   *
   * Photon stays primary.
   *
   * If this is an address search and all primary
   * grounded providers returned no candidate,
   * try the project's existing throttled
   * searchNominatimFallback().
   */
  if (
    detectedPlaceType ===
      "address" &&
    !search.candidates.length
  ) {
    const nominatimFallback =
      await searchNominatimFallback({
        queries: [
          normalized
            .normalizedQuery ||
            rawQuery,
        ],
      });

    const nominatimCandidates =
      Array.isArray(
        nominatimFallback
      )
        ? nominatimFallback
        : Array.isArray(
            nominatimFallback
              ?.candidates
          )
          ? nominatimFallback
              .candidates
          : [];

    const nominatimErrors =
      Array.isArray(
        nominatimFallback
          ?.errors
      )
        ? nominatimFallback
            .errors
        : [];

    if (
      nominatimCandidates.length
    ) {
      search.candidates =
        dedupeCandidates([
          ...nominatimCandidates,
          ...search.candidates,
        ]);
    }

    search.errors.push(
      ...nominatimErrors
    );

    search.providers
      .nominatimCandidates =
        nominatimCandidates.length;

    /*
     * 0 candidates + 0 errors means the provider
     * answered normally but did not find a match.
     * That should become 404, not 503.
     */
    search.providers
      .nominatimAvailable =
        nominatimErrors.length ===
          0;

    console.log(
      "[Nominatim address hook]",
      {
        candidates:
          nominatimCandidates.length,

        available:
          search.providers
            .nominatimAvailable,

        errors:
          nominatimErrors,
      }
    );
  } else {
    search.providers
      .nominatimCandidates =
        0;

    search.providers
      .nominatimAvailable =
        null;
  }


  console.log(
    "[place providers]",
    search.providers
  );


  if (
    !search.candidates.length
  ) {
    /*
     * 503 only when no applicable grounded provider
     * was able to answer.
     *
     * Example:
     * Photon down + TDX Tourism successfully returns
     * zero results = genuine 404, not provider outage.
     */
    const providerFailure =
      detectedPlaceType ===
        "station"
        ? (
            !search.providers
              .tdxStationAvailable &&
            search.errors.length > 0
          )
        : detectedPlaceType ===
            "address"
          ? (
              photonSearch
                .candidates
                .length === 0 &&
              search.providers
                .nominatimAvailable !==
                  true &&
              search.errors.length > 0
            )
          : (
              !search.providers
                .tdxTourismAvailable &&
              !search.providers
                .tdxPortAvailable &&
              search.errors.length > 0
            );

    const error =
      new Error(
        providerFailure
          ? `地點搜尋服務暫時不可用：${rawQuery}。`
          : `找不到地點：${rawQuery}。`
      );

    /*
     * Distinguish:
     *
     * 404 = providers worked, but no place matched.
     * 503 = provider failure / outage.
     *
     * Never report an external provider outage as
     * if the user's place does not exist.
     */
    error.status =
      providerFailure
        ? 503
        : 404;

    error.providerErrors =
      search.errors;

    throw error;
  }

  /*
   * 對所有候選重新評分。
   */
  console.log(
    "[score debug]",
    cityHint,
    search.candidates.map((c) => ({
      city: c.city,
      county: c.county,
      state: c.state,
      district: c.district,
      administrativeCity: c.administrativeCity,
      address: c.address,
      displayName: c.displayName,
      cityEvidence: candidateCityEvidence(c),
    }))
  );
  const rankedCandidates =
    search.candidates
      .map(
        (candidate) => {
          const cityConsistency =
            evaluateCityConsistency(
              candidate,
              cityHint,
              cityHintInfo.strength
            );

          return {
            candidate,
            cityConsistency,

            score:
              scoreCandidate(
                candidate,
                {
                  rawQuery,

                  normalizedQuery:
                    normalized
                      .normalizedQuery,

                  cityHint,

                  cityHintStrength:
                    cityHintInfo.strength,

                  placeType:
                    detectedPlaceType,

                  nearLat,
                  nearLon,
                }
              ),
          };
        }
      )

      /*
       * No hard city veto here. A candidate with conflicting or incomplete
       * OSM administrative metadata remains available as a fallback.
       * City evidence is one ranking signal among name/type/provider evidence.
       */
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  if (!rankedCandidates.length) {
    const error =
      new Error(
        `無法排序地點候選：${rawQuery}`
      );

    error.status = 404;
    throw error;
  }

  const best =
    rankedCandidates[0];

  const result = {
    ...best.candidate,

    matchScore:
      best.score,

    cityConsistency:
      best.cityConsistency,
  };

  /*
   * Persist only a successful grounded winner.
   *
   * If the user explicitly supplied a city and
   * the selected candidate conflicts with it,
   * do not make that mistake persistent.
   */
  if (
    cityHintInfo.strength !==
      "explicit" ||
    best.cityConsistency
      .status !==
      "conflict"
  ) {
    await setResolvedPlaceCache(
      resolvedCacheKey,
      {
        result,

        normalized: {
          ...normalized,

          cityHint,

          cityHintSource:
            cityHintInfo.source,

          cityHintStrength:
            cityHintInfo.strength,

          placeType:
            detectedPlaceType,
        },

        source:
          result.source,
      }
    );
  }


  const candidates =
    rankedCandidates
      .slice(0, 5)
      .map(
        (item) => ({
          ...item.candidate,

          matchScore:
            item.score,

          cityConsistency:
            item.cityConsistency,
        })
      );

  const resolvedCityEvidence =
    candidateCityEvidence(
      result
    );

  const resolvedCity =
    resolvedCityEvidence
      .cities[0] ||
    "";

  return {
    input:
      rawQuery,

    normalized: {
      ...normalized,

      cityHint,

      cityHintSource:
        cityHintInfo.source,

      cityHintStrength:
        cityHintInfo.strength,

      placeType:
        detectedPlaceType,
    },

    result,

    candidates,

    source:
      result.source,

    validation: {
      accepted: true,

      coordinatesGrounded:
        Boolean(
          result
            .coordinatesGrounded
        ),

      aiGeneratedCoordinates:
        false,

      taiwanOnly:
        validTaiwanCoordinate(
          result.lat,
          result.lon
        ),

      locationBiasUsed:
        validTaiwanCoordinate(
          Number(
            nearLat
          ),
          Number(
            nearLon
          )
        ),

      cityHint,

      cityHintSource:
        cityHintInfo.source,

      cityHintStrength:
        cityHintInfo.strength,

      resolvedCity,

      resolvedCities:
        resolvedCityEvidence.cities,

      cityConsistency:
        best.cityConsistency,

      needsReview:
        best.cityConsistency.status === "conflict",

      matchScore:
        best.score,
    },
  };
}


function suggestionLabel(candidate) {
  return [
    candidate.displayName,
    candidate.district,
    candidate.city || candidate.county,
  ]
    .filter(Boolean)
    .filter((value, i, arr) => arr.indexOf(value) === i)
    .join("，");
}

/*
 * 打字即時建議。
 *
 * 以前 /api/autocomplete 直接打 Photon，沒有 TDX 車站、沒有評分，
 * 使用者看到的建議跟最後 smart-geocode 選出的點常常不一致。
 * 現在建議清單和正式搜尋共用同一套候選來源與評分；
 * 為了速度，這裡不呼叫 Groq，也不查 TDX Tourism / Port。
 *
 * 建議項目已經帶 lat/lon，前端選取後請直接使用，
 * 不需要再用文字重新 geocode 一次。
 */
export async function suggestPlaces({
  query,
  nearLat = null,
  nearLon = null,
  limit = 7,
}) {
  const q = clean(query);

  if (q.length < 2) {
    return [];
  }

  const cityInfo = resolveCityHintInfo({
    rawQuery: q,
    normalizedQuery: q,
    aiCityHint: "",
  });

  const placeType = placeTypeFromText(q);

  const [photonCandidates, stationCandidates] =
    await Promise.all([
      searchPhoton({
        query: q,
        nearLat,
        nearLon,
      }).catch((error) => {
        console.log(
          "Autocomplete Photon unavailable:",
          error.message
        );

        return [];
      }),

      placeType === "station"
        ? searchTdxStationCandidates({
            queries: [q],
            cityHint: cityInfo.cityHint,
          })
            .then((result) => result.candidates || [])
            .catch(() => [])
        : Promise.resolve([]),
    ]);

  return dedupeCandidates([
    ...stationCandidates,
    ...photonCandidates,
  ])
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, {
        rawQuery: q,
        normalizedQuery: q,
        cityHint: cityInfo.cityHint,
        cityHintStrength: cityInfo.strength,
        placeType,
        nearLat,
        nearLon,
      }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => ({
      displayName: suggestionLabel(candidate),
      lat: candidate.lat,
      lon: candidate.lon,
      type: candidate.locationType || "place",
      source: candidate.source,
      placeId: candidate.placeId,
    }))
    .filter((item) => item.displayName);
}


// Test-only exports. They keep regression tests deterministic and offline;
// production code should continue to use resolvePlaceUniversal().
export const __placeSearchTestables = {
  TTLCache,
  normalizeCityName,
  inferCityHint,
  collectCityHints,
  cityQueryTerms,
  resolveCityHintInfo,
  candidateCityEvidence,
  evaluateCityConsistency,
  scoreCandidate,
  normalizeComparable,
  placeTypeFromText,
  candidateTypeMatches,
  directCoordinate,
  detectCityMention,
  districtCitiesFromText,
  nameSimilarity,
  candidateLooksLikeStreet,
  distanceKm,
  proximityBonus,
  stripLeadingCityName,
  tourismQueryVariants,
  mapWithConcurrency,
};