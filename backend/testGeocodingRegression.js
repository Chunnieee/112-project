import test from "node:test";
import assert from "node:assert/strict";

import {
  __placeSearchTestables as t,
} from "./placeSearchEngine.js";

function baseCandidate(overrides = {}) {
  return {
    lat: 25.014,
    lon: 121.464,
    displayName: "板橋車站",
    address: "新北市板橋區縣民大道二段",
    city: "板橋區",
    county: null,
    state: "新北市",
    district: "板橋區",
    locality: null,
    administrativeCity: "New Taipei",
    locationType: "railway",
    rawTypes: ["railway", "station"],
    providerRank: 0,
    ...overrides,
  };
}

test("raw query city has priority over AI city hint", () => {
  const info = t.resolveCityHintInfo({
    rawQuery: "新北市板橋車站",
    normalizedQuery: "板橋車站",
    aiCityHint: "Taipei",
  });

  assert.equal(info.cityHint, "New Taipei");
  assert.equal(info.source, "raw-query");
  assert.equal(info.strength, "explicit");
});

test("administrative city can come from state/county, not only props.city", () => {
  const evidence = t.candidateCityEvidence(
    baseCandidate({
      city: "板橋區",
      administrativeCity: null,
      state: "新北市",
    })
  );

  assert.deepEqual(evidence.cities, ["New Taipei"]);
  assert.equal(evidence.source, "administrative-fields");
});

test("district-only metadata resolves through the district table, not a false conflict", () => {
  const candidate = baseCandidate({
    city: "板橋區",
    county: null,
    state: null,
    administrativeCity: null,
    address: "板橋區縣民大道二段",
    displayName: "板橋車站",
  });

  const result = t.evaluateCityConsistency(
    candidate,
    "New Taipei",
    "explicit"
  );

  assert.equal(result.status, "match");
  assert.equal(result.source, "district-lookup");
  assert.ok(result.adjustment >= 90);

  // 同一個區名換成別的目標城市時，是「衝突」(扣分)，不是 veto。
  const other = t.evaluateCityConsistency(candidate, "Taipei", "explicit");
  assert.equal(other.status, "conflict");
  assert.ok(other.adjustment > -10000);
});

test("candidate with no city information at all stays unknown", () => {
  const candidate = baseCandidate({
    city: null,
    county: null,
    state: null,
    district: null,
    locality: null,
    administrativeCity: null,
    address: null,
    displayName: "某個地點",
  });

  const result = t.evaluateCityConsistency(candidate, "New Taipei", "explicit");

  assert.equal(result.status, "unknown");
  assert.ok(result.adjustment > -10000);
});

test("cross-city mismatch is a penalty, never a hard veto", () => {
  const candidate = baseCandidate({
    displayName: "台北車站",
    address: "台北市中正區北平西路",
    city: "台北市",
    state: "台北市",
    administrativeCity: "Taipei",
  });

  const consistency = t.evaluateCityConsistency(
    candidate,
    "New Taipei",
    "explicit"
  );

  const score = t.scoreCandidate(candidate, {
    rawQuery: "新北市板橋車站",
    normalizedQuery: "板橋車站",
    cityHint: "New Taipei",
    cityHintStrength: "explicit",
    placeType: "station",
  });

  assert.equal(consistency.status, "conflict");
  assert.ok(Number.isFinite(score));
  assert.ok(score > -10000);
});

test("if conflicting admin fields include target city, candidate is not rejected", () => {
  const candidate = baseCandidate({
    city: "台北市",
    county: "新北市",
    state: null,
    administrativeCity: null,
  });

  const consistency = t.evaluateCityConsistency(
    candidate,
    "New Taipei",
    "explicit"
  );

  assert.equal(consistency.status, "ambiguous-match");
  assert.ok(consistency.adjustment > 0);
});

test("matching city still receives a strong positive signal", () => {
  const candidate = baseCandidate();

  const consistency = t.evaluateCityConsistency(
    candidate,
    "New Taipei",
    "explicit"
  );

  assert.equal(consistency.status, "match");
  assert.ok(consistency.adjustment >= 90);
});

test("city query expansion includes canonical and local aliases", () => {
  const terms = t.cityQueryTerms("New Taipei");

  assert.ok(terms.includes("New Taipei"));
  assert.ok(terms.some((value) => value.includes("新北")));
});

test("TTL cache returns a value before expiration and supports clear", () => {
  const cache = new t.TTLCache({
    ttlMs: 60_000,
    maxEntries: 2,
  });

  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);

  cache.clear();
  assert.equal(cache.get("a"), undefined);
});

test("TTL cache evicts oldest entries when bounded", () => {
  const cache = new t.TTLCache({
    ttlMs: 60_000,
    maxEntries: 2,
  });

  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("tourism place types are classified locally", () => {
  assert.equal(
    t.placeTypeFromText("王品牛排餐廳"),
    "restaurant"
  );

  assert.equal(
    t.placeTypeFromText("台北君悅酒店"),
    "hotel"
  );

  assert.equal(
    t.placeTypeFromText("木柵動物園"),
    "attraction"
  );
});

test("TDX tourism candidate types match expected search types", () => {
  assert.equal(
    t.candidateTypeMatches(
      {
        displayName: "測試餐廳",
        locationType: "restaurant",
        rawTypes: [
          "poi",
          "tourism",
          "restaurant",
        ],
        source:
          "TDX Tourism Restaurant",
      },
      "restaurant"
    ),
    true
  );

  assert.equal(
    t.candidateTypeMatches(
      {
        displayName: "測試飯店",
        locationType: "hotel",
        rawTypes: [
          "tourism",
          "hotel",
        ],
        source:
          "TDX Tourism Hotel",
      },
      "hotel"
    ),
    true
  );
});


// ---------------------------------------------------------------
// 以下是修正搜尋品質問題後新增的回歸測試
// ---------------------------------------------------------------

test("city name inside an institution name is not an explicit city constraint", () => {
  const info = t.resolveCityHintInfo({
    rawQuery: "台北大學",
    normalizedQuery: "國立臺北大學",
    aiCityHint: "",
  });

  assert.equal(info.strength, "embedded");
  assert.equal(info.source, "embedded-in-name");
});

test("embedded city never penalises a candidate in another city", () => {
  const sanxia = baseCandidate({
    displayName: "國立臺北大學",
    address: "新北市三峽區大學路",
    city: "三峽區",
    state: "新北市",
    administrativeCity: "New Taipei",
  });

  const result = t.evaluateCityConsistency(sanxia, "Taipei", "embedded");

  assert.equal(result.status, "conflict");
  assert.equal(result.adjustment, 0);
});

test("embedded city yields to a different AI city hint", () => {
  const info = t.resolveCityHintInfo({
    rawQuery: "台北大學",
    normalizedQuery: "國立臺北大學",
    aiCityHint: "New Taipei",
  });

  assert.equal(info.cityHint, "New Taipei");
  assert.equal(info.source, "ai-hint");
});

test("a real city in the query still wins over an embedded one", () => {
  const info = t.resolveCityHintInfo({
    rawQuery: "新北市台北大學",
    normalizedQuery: "",
    aiCityHint: "",
  });

  assert.equal(info.cityHint, "New Taipei");
  assert.equal(info.strength, "explicit");

  // 「台北市立大學」的「台北市」不是嵌在校名裡的簡稱，仍視為明確城市。
  const municipal = t.resolveCityHintInfo({
    rawQuery: "台北市立大學",
    normalizedQuery: "",
    aiCityHint: "",
  });

  assert.equal(municipal.cityHint, "Taipei");
  assert.equal(municipal.strength, "explicit");
});

test("district table handles generic and overlapping district names", () => {
  assert.deepEqual(t.districtCitiesFromText("板橋區"), ["New Taipei"]);

  // 中西區不能被拆成「西區」而誤判成台中 / 嘉義
  assert.deepEqual(t.districtCitiesFromText("中西區"), ["Tainan"]);

  const zhongzheng = t.districtCitiesFromText("中正區");
  assert.ok(zhongzheng.includes("Taipei"));
  assert.ok(zhongzheng.includes("Keelung"));

  assert.deepEqual(t.districtCitiesFromText("沒有區名"), []);
});

test("ambiguous district still counts as a (weaker) match for the target city", () => {
  const candidate = baseCandidate({
    city: "中正區",
    state: null,
    county: null,
    administrativeCity: null,
    address: null,
  });

  const result = t.evaluateCityConsistency(candidate, "Taipei", "explicit");

  assert.equal(result.status, "ambiguous-match");
  assert.ok(result.adjustment > 0);
});

test("place type: brand names containing 路 are not addresses", () => {
  assert.equal(t.placeTypeFromText("路易莎咖啡"), "restaurant");
  assert.notEqual(t.placeTypeFromText("路易莎"), "address");
});

test("place type: real road names and house numbers are addresses", () => {
  assert.equal(t.placeTypeFromText("中山北路二段"), "address");
  assert.equal(t.placeTypeFromText("忠孝東路四段216號"), "address");
  assert.equal(t.placeTypeFromText("公園路"), "address");
});

test("place type: night markets / old streets are attractions, not addresses", () => {
  assert.equal(t.placeTypeFromText("九份老街"), "attraction");
  assert.equal(t.placeTypeFromText("士林夜市"), "attraction");
});

test("place type: bus stops are not rail stations", () => {
  assert.equal(t.placeTypeFromText("板橋公車站"), "unknown");
  assert.equal(t.placeTypeFromText("板橋車站"), "station");
});

test("place type: English keywords match whole words only", () => {
  assert.notEqual(t.placeTypeFromText("Pinnacle Tower"), "hotel");
  assert.notEqual(t.placeTypeFromText("Parking lot"), "attraction");
  assert.equal(t.placeTypeFromText("Grand Hotel"), "hotel");
  assert.equal(t.placeTypeFromText("Taipei Main Station"), "station");
});

test("name similarity is tolerant to a missing character but still ranks exact matches first", () => {
  assert.equal(t.nameSimilarity("板橋車站", "板橋車站"), 1);

  const close = t.nameSimilarity("板橋車站", "板橋火車站");
  const far = t.nameSimilarity("板橋車站", "高雄港");

  assert.ok(close > 0.4);
  assert.ok(close > far);
  assert.equal(far, 0);
});

test("nearer candidates score higher when the user location is known", () => {
  const near = baseCandidate({ lat: 25.014, lon: 121.464 });
  const far = baseCandidate({ lat: 22.639, lon: 120.302 }); // 高雄

  const options = {
    rawQuery: "車站",
    normalizedQuery: "車站",
    cityHint: "",
    cityHintStrength: "none",
    placeType: "station",
    nearLat: 25.0,
    nearLon: 121.46,
  };

  assert.ok(
    t.scoreCandidate(near, options) > t.scoreCandidate(far, options)
  );

  // 沒有使用者位置時，距離不影響分數
  const withoutLocation = { ...options, nearLat: null, nearLon: null };

  assert.equal(
    t.scoreCandidate(near, withoutLocation),
    t.scoreCandidate(far, withoutLocation)
  );
});

test("proximity bonus is bounded", () => {
  const here = baseCandidate({ lat: 25.014, lon: 121.464 });

  assert.ok(t.proximityBonus(here, 25.014, 121.464) <= 20);
  assert.equal(t.proximityBonus(here, 22.6, 120.3), 0);
  assert.equal(t.proximityBonus(here, null, null), 0);
});

test("exact name match outranks a loosely related candidate", () => {
  const exact = baseCandidate({ displayName: "板橋車站", address: null });
  const loose = baseCandidate({
    displayName: "板橋車站停車場",
    address: null,
    lat: 25.015,
    lon: 121.465,
  });

  const options = {
    rawQuery: "板橋車站",
    normalizedQuery: "板橋車站",
    cityHint: "",
    cityHintStrength: "none",
    placeType: "station",
  };

  assert.ok(
    t.scoreCandidate(exact, options) > t.scoreCandidate(loose, options)
  );
});

test("TDX tourism query variants add a version without the leading city name", () => {
  assert.equal(t.stripLeadingCityName("台北君悅酒店"), "君悅酒店");
  assert.equal(t.stripLeadingCityName("君悅酒店"), "");

  const variants = t.tourismQueryVariants(["台北君悅酒店", "君悅酒店"]);

  assert.deepEqual(variants, ["台北君悅酒店", "君悅酒店"]);
});

test("TDX tourism query variants are capped, because the TDX queue is serial", () => {
  const input = ["台北君悅酒店", "台北君悅大飯店"];

  // 泛類型 (三個資料集)：最多 2 條，且去掉城市名的版本排在第二
  const generic = t.tourismQueryVariants(input, 2);
  assert.equal(generic.length, 2);
  assert.equal(generic[1], "君悅酒店");

  // 單一類型：最多 3 條
  assert.equal(t.tourismQueryVariants(input, 3).length, 3);
});

test("mapWithConcurrency keeps result order and respects the limit", async () => {
  let running = 0;
  let maxRunning = 0;

  const results = await t.mapWithConcurrency(
    [30, 10, 20, 5, 15],
    2,
    async (delay, index) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);

      await new Promise((resolve) => setTimeout(resolve, delay));

      running -= 1;
      return index;
    }
  );

  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.ok(maxRunning <= 2);
});

test("a street that merely contains the place name does not beat the real place", () => {
  const road = baseCandidate({
    displayName: "台北大學路",
    address: "台北大學路, 大安區, 台北市",
    city: "大安區",
    state: "台北市",
    administrativeCity: "Taipei",
    lat: 25.014,
    lon: 121.5436,
    locationType: "street",
    rawTypes: ["highway", "residential"],
  });

  const university = baseCandidate({
    displayName: "國立臺北大學",
    address: "三峽區, 新北市",
    city: null,
    district: "三峽區",
    state: "新北市",
    administrativeCity: "New Taipei",
    lat: 24.943,
    lon: 121.37,
    locationType: "university",
    rawTypes: ["amenity", "university"],
    providerRank: 1,
  });

  assert.equal(t.candidateLooksLikeStreet(road), true);
  assert.equal(t.candidateLooksLikeStreet(university), false);

  const options = {
    rawQuery: "台北大學",
    normalizedQuery: "台北大學",
    cityHint: "Taipei",
    cityHintStrength: "embedded",
    placeType: t.placeTypeFromText("台北大學"),
    nearLat: 25.03,
    nearLon: 121.56,
  };

  assert.ok(
    t.scoreCandidate(university, options) > t.scoreCandidate(road, options)
  );

  // 真的在找路時不能被這條規則影響
  const roadQuery = { ...options, rawQuery: "台北大學路", normalizedQuery: "台北大學路", placeType: "address" };
  assert.ok(Number.isFinite(t.scoreCandidate(road, roadQuery)));
});