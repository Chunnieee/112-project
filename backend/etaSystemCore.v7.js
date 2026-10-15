const JURISDICTIONS = [
  { scope: "Taipei", zh: ["台北市", "臺北市", "台北", "臺北"], en: ["taipei", "taipei city"] },
  { scope: "NewTaipei", zh: ["新北市", "新北"], en: ["new taipei", "new taipei city", "newtaipei"] },
  { scope: "Taoyuan", zh: ["桃園市", "桃园市", "桃園", "桃园"], en: ["taoyuan", "taoyuan city"] },
  { scope: "Taichung", zh: ["台中市", "臺中市", "台中", "臺中"], en: ["taichung", "taichung city"] },
  { scope: "Tainan", zh: ["台南市", "臺南市", "台南", "臺南"], en: ["tainan", "tainan city"] },
  { scope: "Kaohsiung", zh: ["高雄市", "高雄"], en: ["kaohsiung", "kaohsiung city"] },
  { scope: "Keelung", zh: ["基隆市", "基隆"], en: ["keelung", "keelung city"] },
  { scope: "Hsinchu", zh: ["新竹市"], en: ["hsinchu city"] },
  { scope: "Chiayi", zh: ["嘉義市", "嘉义市"], en: ["chiayi city"] },
  { scope: "YilanCounty", zh: ["宜蘭縣", "宜兰县", "宜蘭", "宜兰"], en: ["yilan county", "ilan county"] },
  { scope: "HsinchuCounty", zh: ["新竹縣", "新竹县"], en: ["hsinchu county"] },
  { scope: "MiaoliCounty", zh: ["苗栗縣", "苗栗县", "苗栗"], en: ["miaoli county"] },
  { scope: "ChanghuaCounty", zh: ["彰化縣", "彰化县", "彰化"], en: ["changhua county"] },
  { scope: "NantouCounty", zh: ["南投縣", "南投县", "南投"], en: ["nantou county"] },
  { scope: "YunlinCounty", zh: ["雲林縣", "云林县", "雲林", "云林"], en: ["yunlin county"] },
  { scope: "ChiayiCounty", zh: ["嘉義縣", "嘉义县"], en: ["chiayi county"] },
  { scope: "PingtungCounty", zh: ["屏東縣", "屏东县", "屏東", "屏东"], en: ["pingtung county"] },
  { scope: "HualienCounty", zh: ["花蓮縣", "花莲县", "花蓮", "花莲"], en: ["hualien county"] },
  { scope: "TaitungCounty", zh: ["台東縣", "臺東縣", "台东县", "台東", "臺東"], en: ["taitung county", "taitung"] },
  { scope: "PenghuCounty", zh: ["澎湖縣", "澎湖县", "澎湖"], en: ["penghu county", "penghu"] },
  { scope: "KinmenCounty", zh: ["金門縣", "金门县", "金門", "金门"], en: ["kinmen county", "kinmen"] },
  { scope: "LienchiangCounty", zh: ["連江縣", "连江县", "連江", "连江", "馬祖", "马祖"], en: ["lienchiang county", "matsu"] },
];

const aliasMap = new Map();

function normalizeAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("臺", "台")
    .replace(/\s+/g, " ")
    .replace(/[，,。\.]/g, "")
    .trim();
}

for (const item of JURISDICTIONS) {
  aliasMap.set(normalizeAlias(item.scope), item.scope);
  for (const alias of [...item.zh, ...item.en]) {
    aliasMap.set(normalizeAlias(alias), item.scope);
  }
}

export const TAIWAN_TDX_JURISDICTIONS = Object.freeze(
  JURISDICTIONS.map((item) => item.scope)
);

export function canonicalizeTaiwanJurisdiction(value) {
  const normalized = normalizeAlias(value);
  if (!normalized) return null;

  if (aliasMap.has(normalized)) {
    return aliasMap.get(normalized);
  }

  // Some reverse geocoders return values such as "Hsinchu County, Taiwan".
  // Match only complete known administrative names. Do NOT strip City/County,
  // because Hsinchu City and Hsinchu County are different TDX scopes.
  for (const item of JURISDICTIONS) {
    for (const alias of [...item.zh, ...item.en]) {
      const a = normalizeAlias(alias);
      if (a && (normalized === a || normalized.startsWith(`${a} `))) {
        return item.scope;
      }
    }
  }

  return null;
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function resolveTaiwanJurisdictionFromReverse(item) {
  if (!item || typeof item !== "object") return null;

  const address = item.address || item.raw?.address || {};

  /*
   * Administrative fields are intentionally ordered by jurisdiction strength.
   * County/subdivision must beat locality/city because reverse geocoders often
   * return "Guanxi" as city and "Hsinchu County" as county. TDX needs the
   * jurisdiction, not the township/locality.
   */
  const strongAdministrativeFields = uniqueNonEmpty([
    item.tdxCity,
    item.county,
    item.countrySubdivision,
    item.countrySubdivisionName,
    item.administrativeArea,
    item.adminArea,
    item.state,
    address.county,
    address.countrySubdivision,
    address.countrySubdivisionName,
    address.state,
    address.region,
  ]);

  for (const value of strongAdministrativeFields) {
    const scope = canonicalizeTaiwanJurisdiction(value);
    if (scope) return scope;
  }

  const municipalityFields = uniqueNonEmpty([
    item.municipality,
    item.administrativeCity,
    address.municipality,
    address.city,
  ]);

  for (const value of municipalityFields) {
    const scope = canonicalizeTaiwanJurisdiction(value);
    if (scope) return scope;
  }

  const weakLocalityFields = uniqueNonEmpty([
    item.city,
    item.locality,
    item.district,
    address.town,
    address.city_district,
  ]);

  for (const value of weakLocalityFields) {
    const scope = canonicalizeTaiwanJurisdiction(value);
    if (scope) return scope;
  }

  return null;
}

const endpointCapabilities = new Map();

function capabilityState(endpointKey) {
  if (!endpointCapabilities.has(endpointKey)) {
    endpointCapabilities.set(endpointKey, {
      acceptedScopes: null,
      unsupportedScopes: new Set(),
      updatedAt: 0,
    });
  }
  return endpointCapabilities.get(endpointKey);
}

export function parseTdxAcceptedScopes(errorOrMessage) {
  const detail =
    errorOrMessage?.tdxDetail?.Message ||
    errorOrMessage?.tdxDetail?.message ||
    errorOrMessage?.message ||
    String(errorOrMessage || "");

  const text = String(detail || "");
  const match = text.match(/accepted\s+but\s+(.+)$/i);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/["'}.]+$/g, ""))
    .map((value) => canonicalizeTaiwanJurisdiction(value) || value)
    .filter((value) => TAIWAN_TDX_JURISDICTIONS.includes(value));
}

export function getTdxEndpointCapability(endpointKey) {
  const state = capabilityState(endpointKey);
  return {
    endpointKey,
    acceptedScopes: state.acceptedScopes
      ? [...state.acceptedScopes]
      : null,
    unsupportedScopes: [...state.unsupportedScopes],
    updatedAt: state.updatedAt || null,
  };
}

export function resetTdxEndpointCapabilities() {
  endpointCapabilities.clear();
}

export async function callTdxScopeEndpoint({
  endpointKey,
  scope,
  loader,
}) {
  const canonicalScope = canonicalizeTaiwanJurisdiction(scope);
  if (!canonicalScope) {
    return {
      ok: false,
      scope: null,
      endpointKey,
      unsupported: true,
      reason: "unknown Taiwan jurisdiction",
      data: null,
    };
  }

  const state = capabilityState(endpointKey);

  if (
    state.acceptedScopes &&
    !state.acceptedScopes.has(canonicalScope)
  ) {
    state.unsupportedScopes.add(canonicalScope);
    return {
      ok: false,
      scope: canonicalScope,
      endpointKey,
      unsupported: true,
      reason: "scope excluded by learned endpoint capability",
      acceptedScopes: [...state.acceptedScopes],
      data: null,
    };
  }

  if (state.unsupportedScopes.has(canonicalScope)) {
    return {
      ok: false,
      scope: canonicalScope,
      endpointKey,
      unsupported: true,
      reason: "scope previously rejected by this endpoint",
      acceptedScopes: state.acceptedScopes
        ? [...state.acceptedScopes]
        : null,
      data: null,
    };
  }

  try {
    const data = await loader(canonicalScope);

    // Successful request is direct evidence that the endpoint supports scope.
    if (state.acceptedScopes) {
      state.acceptedScopes.add(canonicalScope);
    }
    state.unsupportedScopes.delete(canonicalScope);
    state.updatedAt = Date.now();

    return {
      ok: true,
      scope: canonicalScope,
      endpointKey,
      unsupported: false,
      reason: "ok",
      data,
    };
  } catch (error) {
    const accepted = parseTdxAcceptedScopes(error);

    if (Number(error?.status) === 400 && accepted.length) {
      state.acceptedScopes = new Set(accepted);
      state.updatedAt = Date.now();

      if (!state.acceptedScopes.has(canonicalScope)) {
        state.unsupportedScopes.add(canonicalScope);
      }

      return {
        ok: false,
        scope: canonicalScope,
        endpointKey,
        unsupported: !state.acceptedScopes.has(canonicalScope),
        reason: "TDX endpoint rejected jurisdiction scope",
        acceptedScopes: [...state.acceptedScopes],
        error,
        data: null,
      };
    }

    return {
      ok: false,
      scope: canonicalScope,
      endpointKey,
      unsupported: false,
      reason: error?.message || "TDX request failed",
      error,
      data: null,
    };
  }
}

export async function loadTdxCityTrafficBundle({
  scope,
  getShapes,
  getLinks,
  getLive,
  buildPackage,
}) {
  const canonicalScope = canonicalizeTaiwanJurisdiction(scope);
  if (!canonicalScope) {
    return {
      package: null,
      diagnostics: {
        scope,
        canonicalScope: null,
        usable: false,
        reason: "unknown jurisdiction",
      },
    };
  }

  /*
   * Endpoint support is learned independently. SectionLink is optional for
   * direct SectionID live data, while SectionShape + Live are required for
   * geometry matching. This prevents one unsupported endpoint from killing an
   * otherwise usable city package.
   */
  const [shapeResult, linkResult, liveResult] = await Promise.all([
    callTdxScopeEndpoint({
      endpointKey: "SectionShape/City",
      scope: canonicalScope,
      loader: getShapes,
    }),
    callTdxScopeEndpoint({
      endpointKey: "SectionLink/City",
      scope: canonicalScope,
      loader: getLinks,
    }),
    callTdxScopeEndpoint({
      endpointKey: "Live/City",
      scope: canonicalScope,
      loader: getLive,
    }),
  ]);

  const diagnostics = {
    scope: canonicalScope,
    usable: Boolean(shapeResult.ok && liveResult.ok),
    shape: summarizeEndpointResult(shapeResult),
    link: summarizeEndpointResult(linkResult),
    live: summarizeEndpointResult(liveResult),
  };

  if (!shapeResult.ok || !liveResult.ok) {
    return {
      package: null,
      diagnostics,
    };
  }

  const pkg = buildPackage(
    canonicalScope,
    shapeResult.data,
    linkResult.ok ? linkResult.data : [],
    liveResult.data
  );

  return {
    package: pkg,
    diagnostics,
  };
}

function summarizeEndpointResult(result) {
  return {
    ok: Boolean(result?.ok),
    unsupported: Boolean(result?.unsupported),
    reason: result?.reason || null,
    acceptedScopes: result?.acceptedScopes || null,
  };
}

export function buildEtaCorridorKey({
  jurisdictions = [],
  distanceKm = null,
} = {}) {
  const scopes = jurisdictions
    .map(canonicalizeTaiwanJurisdiction)
    .filter(Boolean);

  // Never pool unrelated routes into an "Unknown>Unknown" calibration bucket.
  // Exact-route calibration can still work through routeHash when reverse
  // geocoding is temporarily unavailable.
  if (!scopes.length) return null;

  const origin = scopes[0];
  const destination = scopes[scopes.length - 1] || origin;
  const distance = Number(distanceKm);

  // Short urban trips need a finer distance band; long intercity trips can use
  // broader bands without fragmenting the calibration data too much.
  let bucket = "unknown";
  if (Number.isFinite(distance) && distance >= 0) {
    const step = distance < 30 ? 5 : distance < 100 ? 10 : 25;
    const lower = Math.floor(distance / step) * step;
    bucket = `${lower}-${lower + step}km`;
  }

  return `${origin}>${destination}|${bucket}`;
}
