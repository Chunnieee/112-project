const PHOTON_URL = "https://photon.komoot.io/api/";

// Real users don't type full official names -- they type whatever short,
// "representative" word they'd say out loud ("101", "政大", "故宮"), the
// way Google Maps handles it. Photon (OpenStreetMap-based) already resolves
// most of these fine on its own, because OSM tags many places with
// alt_name/short_name entries Photon's fuzzy match can find -- e.g. "政大"
// already works, because National Chengchi University's OSM node carries
// that abbreviation.
//
// "101" is the confirmed counter-example: OSM has several small POIs
// literally *named* "101" (a road, a stationery shop, an optician, a hotel,
// a restaurant -- see the bug report), and Photon's relevance ranking has
// no way to know the user almost certainly means the 101-story landmark
// tower, because Taipei 101's own OSM node is tagged with its full name
// ("台北101"/"Taipei 101"), not the bare digits "101". A plain substring/
// fuzzy match on "101" scores those small exact-name-match POIs at least as
// well as the tower, sometimes better.
//
// This table is a deliberately small, curated fix for exactly that failure
// mode: well-known landmarks whose short/colloquial form is either (a) not
// how the landmark is actually named in OSM, or (b) also happens to be the
// literal name of unrelated small POIs that would otherwise outrank it.
// Keys are matched only as a *whole, trimmed, exact* query (not a
// substring), so this never touches longer queries the user actually
// intends literally -- someone searching "long 101號" or "忠孝東路101號"
// won't hit this table since their full query differs from the bare key.
// It is intentionally NOT exhaustive; genuinely ambiguous short words with
// no single obvious landmark (e.g. "動物園", "植物園" -- which zoo/garden?)
// are left out on purpose rather than guessing, matching the same caution
// the AI normalization prompt below already uses for those cases.
const LANDMARK_ALIASES = {
  "101": "台北101",
  "台北101大樓": "台北101",
  "小巨蛋": "台北小巨蛋",
  "台北小巨蛋": "台北小巨蛋",
  "故宮": "國立故宮博物院",
  "北車": "台北車站",
  "北車站": "台北車站",
  "桃機": "桃園國際機場",
  "松機": "台北松山機場",
  "西門": "西門町",
  "228公園": "二二八和平公園",
  "二二八公園": "二二八和平公園",
};

function resolveLandmarkAlias(query) {
  const key = clean(query);
  return LANDMARK_ALIASES[key] || null;
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

  // 目前 Groq 官方仍支援這兩個 production model。
  // 任一失敗就試下一個；全部失敗也不會阻止地點搜尋。
  const models = [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
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
                  '輸出格式：{"normalizedQuery":"...","aliases":["..."],"cityHint":"...","placeType":"station|address|poi|district|unknown","confidence":0.0,"reason":"..."}\n' +
                  "使用者常常只打代表性關鍵字、不是正式全名，" +
                  "例如打「101」其實是指「台北101」這棟地標，" +
                  "打「政治大學」可以導正為「國立政治大學」；" +
                  "如果輸入本身已經是知名地標的正式或常用名稱（例如台北101、故宮），直接保留；" +
                  "但「動物園」「植物園」這種全台各地都有、" +
                  "沒有其他上下文就無法判斷是哪一個的詞，" +
                  "不要自己猜一個地址，normalizedQuery 保持原樣、confidence 給低分即可。",
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

      const text =
        data?.choices?.[0]?.message?.content || "";

      const parsed = parseJsonLoose(text);

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
}

async function searchTomTom({
  query,
  apiKey,
  nearLat,
  nearLon,
}) {
  if (!apiKey) {
    return [];
  }

  const params = new URLSearchParams({
    key: apiKey,
    countrySet: "TW",
    limit: "10",
    typeahead: "false",
    maxFuzzyLevel: "3",
    view: "TW",
  });

  if (
    validTaiwanCoordinate(
      Number(nearLat),
      Number(nearLon)
    )
  ) {
    params.set(
      "geobias",
      `point:${Number(nearLat)},${Number(nearLon)}`
    );
  }

  const url =
    "https://api.tomtom.com/search/2/search/" +
    encodeURIComponent(query) +
    ".json?" +
    params.toString();

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
      },
    },
    9000
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `TomTom HTTP ${response.status}: ${text.slice(0, 150)}`
    );
  }

  const data = await response.json();

  const results = Array.isArray(data?.results)
    ? data.results
    : [];

  return results
    .map((item, index) => {
      const lat = Number(item?.position?.lat);
      const lon = Number(item?.position?.lon);

      if (!validTaiwanCoordinate(lat, lon)) {
        return null;
      }

      const name =
        clean(item?.poi?.name) ||
        clean(item?.address?.freeformAddress) ||
        clean(item?.address?.streetName) ||
        query;

      return {
        lat,
        lon,

        displayName: name,

        address:
          clean(item?.address?.freeformAddress) ||
          null,

        city:
          clean(
            item?.address?.municipality ||
            item?.address?.municipalitySubdivision
          ) || null,

        district:
          clean(
            item?.address?.countrySecondarySubdivision ||
            item?.address?.municipalitySubdivision
          ) || null,

        placeId:
          item?.id ||
          `tomtom:${lat},${lon}`,

        locationType:
          item?.type ||
          item?.entityType ||
          "place",

        rawTypes: [
          item?.type,
          item?.entityType,
          item?.poi?.categories?.[0],
        ].filter(Boolean),

        source:
          "TomTom Search",

        providerRank:
          index,

        coordinatesGrounded:
          true,
      };
    })
    .filter(Boolean);
}

async function searchPhoton({
  query,
  nearLat,
  nearLon,
}) {
  const params = new URLSearchParams({
    q: query,
    limit: "10",

    // 台灣及離島的大範圍 bbox。
    bbox: "118,21,124,27",
  });

  if (
    validTaiwanCoordinate(
      Number(nearLat),
      Number(nearLon)
    )
  ) {
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
  const response = await fetchWithTimeout(
    `${PHOTON_URL}?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",

        "Accept-Language":
          "zh-TW,zh;q=0.9,en;q=0.7",

        "User-Agent":
          "tdx-navigation-project/1.0",
      },
    },
    9000
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Photon HTTP ${response.status}: ${text.slice(0, 150)}`
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

      const name =
        clean(props?.name) ||
        clean(props?.street) ||
        clean(props?.city) ||
        clean(props?.district) ||
        query;

      const address = [
        props?.housenumber && props?.street
          ? `${props.street} ${props.housenumber}`
          : props?.street,

        props?.district,
        props?.city,
        props?.county,
        props?.state,
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

        city:
          clean(
            props?.city ||
            props?.county
          ) || null,

        district:
          clean(props?.district) || null,

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

async function searchQueries({
  queries,
  tomtomApiKey,
  nearLat,
  nearLon,
}) {
  const found = [];
  const errors = [];

  for (const query of queries) {
    if (tomtomApiKey) {
      try {
        const items = await searchTomTom({
          query,
          apiKey: tomtomApiKey,
          nearLat,
          nearLon,
        });

        if (items.length) {
          found.push(...items);

          // TomTom 有結果時直接使用它。
          break;
        }
      } catch (error) {
        errors.push(error.message);

        console.log(
          "TomTom search unavailable:",
          error.message
        );
      }
    }

    try {
      const items = await searchPhoton({
        query,
        nearLat,
        nearLon,
      });

      if (items.length) {
        found.push(...items);
        break;
      }
    } catch (error) {
      errors.push(error.message);

      console.log(
        "Photon search unavailable:",
        error.message
      );
    }
  }

  return {
    candidates:
      dedupeCandidates(found),

    errors,
  };
}

export async function resolvePlaceUniversal({
  query,
  groqApiKey = "",
  tomtomApiKey = "",
  nearLat = null,
  nearLon = null,
}) {
  const rawQuery = clean(query);

  if (!rawQuery) {
    const error =
      new Error("請輸入地點");

    error.status = 400;
    throw error;
  }

  const direct =
    directCoordinate(rawQuery);

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
        "coordinate"
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

        aliases:
          [],

        cityHint:
          "",

        placeType:
          "coordinate",

        confidence:
          1,

        reason:
          "Direct coordinate",
      },

      result,

      candidates: [
        result
      ],

      source:
        result.source,
    };
  }

  /*
    第一輪直接搜使用者原文。

    這樣即使 Groq 掛掉，
    地點搜尋仍然可以正常工作。

    如果原文剛好命中 LANDMARK_ALIASES（使用者只打了代表性關鍵字，例如
    「101」)，先試搜尋清單裡的正式名稱（例如「台北101」)，原文本身還是
    留在清單最後面當 fallback -- searchQueries 會依序嘗試，只要別名那句
    有結果就直接採用，不會漏掉原文本來就能命中的情況。
  */

  const landmarkAlias =
    resolveLandmarkAlias(rawQuery);

  let first =
    await searchQueries({
      queries:
        landmarkAlias
          ? unique([landmarkAlias, rawQuery])
          : [rawQuery],

      tomtomApiKey,

      nearLat,
      nearLon,
    });

  let normalized = {
    normalizedQuery:
      rawQuery,

    aliases:
      [],

    cityHint:
      "",

    placeType:
      "unknown",

    confidence:
      0,

    reason:
      "Raw query resolved without AI",
  };

  /*
    原文找不到時，
    AI 才負責導正文字再搜尋一次。
  */

  if (!first.candidates.length) {
    normalized =
      await normalizeWithGroq(
        rawQuery,
        groqApiKey
      );

    const secondQueries =
      unique([
        normalized.normalizedQuery,

        ...(normalized.aliases || []),

        normalized.cityHint
          ? `${normalized.cityHint} ${normalized.normalizedQuery}`
          : "",

        rawQuery,
      ]);

    const second =
      await searchQueries({
        queries:
          secondQueries,

        tomtomApiKey,

        nearLat,
        nearLon,
      });

    first = {
      candidates:
        second.candidates,

      errors: [
        ...first.errors,
        ...second.errors,
      ],
    };
  }

  if (!first.candidates.length) {
    const error =
      new Error(
        `找不到地點：${rawQuery}。` +
        (
          first.errors.length
            ? `搜尋服務：${first.errors.join(" | ")}`
            : "搜尋服務沒有符合結果。"
        )
      );

    error.status = 404;
    throw error;
  }

  const result =
    first.candidates[0];

  return {
    input:
      rawQuery,

    normalized,

    result,

    candidates:
      first.candidates.slice(0, 5),

    source:
      result.source,

    validation: {
      accepted:
        true,

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
    },
  };
}
