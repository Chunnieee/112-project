// bestDepartureTime.js
//
// 最佳出發時間推薦
//
// 核心原則：
// 1. 使用 TomTom time-dependent routing，不硬寫固定尖峰時間。
// 2. 先排除無法準時抵達的候選。
// 3. 找出車程接近最短的一群候選。
// 4. 再從這些候選裡選「最晚出發」。
//    → 避免變成「越早出發越好」。

const TOMTOM_ROUTING_URL =
  "https://api.tomtom.com/routing/1/calculateRoute";

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_LOOKBACK_MINUTES = 120;
const MAX_CANDIDATES = 9;


// ========================================================
// Basic helpers
// ========================================================

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}


function addMinutes(timeMs, minutes) {

  return (
    timeMs +
    minutes * 60 * 1000
  );

}


// ========================================================
// Congestion labels
// ========================================================

function congestionLabel(ratio) {

  if (!Number.isFinite(ratio)) {
    return "未知";
  }

  if (ratio <= 1.08) {
    return "低";
  }

  if (ratio <= 1.18) {
    return "偏低";
  }

  if (ratio <= 1.35) {
    return "中等";
  }

  if (ratio <= 1.55) {
    return "偏高";
  }

  return "高";

}


function trafficPeriodLabel(ratio) {

  if (!Number.isFinite(ratio)) {
    return "資料不足";
  }

  if (ratio <= 1.10) {
    return "離峰";
  }

  if (ratio <= 1.25) {
    return "一般時段";
  }

  if (ratio <= 1.45) {
    return "接近高峰";
  }

  return "高峰";

}


// ========================================================
// TomTom geometry
// ========================================================

function parseTomTomGeometry(route) {

  const points = [];


  for (
    const leg of
    route?.legs || []
  ) {

    for (
      const p of
      leg?.points || []
    ) {

      const lat =
        Number(p.latitude);

      const lon =
        Number(p.longitude);


      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        continue;
      }


      const previous =
        points[
          points.length - 1
        ];


      if (
        !previous ||
        Math.abs(
          previous[0] - lat
        ) > 1e-10 ||
        Math.abs(
          previous[1] - lon
        ) > 1e-10
      ) {

        points.push([
          lat,
          lon
        ]);

      }

    }

  }


  return points;

}


// ========================================================
// Normalize TomTom response
// ========================================================

function normalizeTomTomRoute(
  route,
  requestedDepartureMs = null
) {

  const summary =
    route?.summary || {};


  const travelSeconds =
    Number(
      summary.travelTimeInSeconds
    );


  const noTrafficSeconds =
    Number(
      summary.noTrafficTravelTimeInSeconds
    );


  const historicSeconds =
    Number(
      summary.historicTrafficTravelTimeInSeconds
    );


  const liveSeconds =
    Number(
      summary.liveTrafficIncidentsTravelTimeInSeconds
    );


  const realTimeDelay =
    Number(
      summary.trafficDelayInSeconds
    );


  const distanceMeters =
    Number(
      summary.lengthInMeters
    );


  // ------------------------------------------
  // Departure time
  // ------------------------------------------

  const parsedDeparture =
    Date.parse(
      summary.departureTime
    );


  const departureMs =
    Number.isFinite(
      parsedDeparture
    )
      ?
      parsedDeparture
      :
      requestedDepartureMs;


  // ------------------------------------------
  // Arrival time
  // ------------------------------------------

  const parsedArrival =
    Date.parse(
      summary.arrivalTime
    );


  const arrivalMs =
    Number.isFinite(
      parsedArrival
    )
      ?
      parsedArrival
      :
      (
        Number.isFinite(
          departureMs
        ) &&
        Number.isFinite(
          travelSeconds
        )
          ?
          departureMs +
          travelSeconds * 1000
          :
          null
      );


  // ------------------------------------------
  // Congestion ratio
  //
  // 例如：
  //
  // 無交通：30 min
  // 實際：45 min
  //
  // ratio = 45 / 30 = 1.5
  // ------------------------------------------

  const congestionRatio =

    Number.isFinite(
      noTrafficSeconds
    ) &&
    noTrafficSeconds > 0 &&
    Number.isFinite(
      travelSeconds
    )

      ?

    travelSeconds /
    noTrafficSeconds

      :

    null;


  // ------------------------------------------
  // Traffic delay
  // ------------------------------------------

  const modelDelay =

    Number.isFinite(
      noTrafficSeconds
    ) &&
    Number.isFinite(
      travelSeconds
    )

      ?

    Math.max(
      0,
      travelSeconds -
      noTrafficSeconds
    )

      :

    0;


  const trafficDelaySeconds =
    Math.max(

      Number.isFinite(
        realTimeDelay
      )
        ?
        realTimeDelay
        :
        0,

      modelDelay

    );


  return {

    departureMs,

    arrivalMs,

    distanceMeters:
      Number.isFinite(
        distanceMeters
      )
        ?
        distanceMeters
        :
        null,

    travelSeconds:
      Number.isFinite(
        travelSeconds
      )
        ?
        travelSeconds
        :
        null,

    noTrafficSeconds:
      Number.isFinite(
        noTrafficSeconds
      )
        ?
        noTrafficSeconds
        :
        null,

    historicTrafficSeconds:
      Number.isFinite(
        historicSeconds
      )
        ?
        historicSeconds
        :
        null,

    liveTrafficSeconds:
      Number.isFinite(
        liveSeconds
      )
        ?
        liveSeconds
        :
        null,

    trafficDelaySeconds,

    congestionRatio:
      Number.isFinite(
        congestionRatio
      )
        ?
        Math.round(
          congestionRatio * 100
        ) / 100
        :
        null,

    congestionLevel:
      congestionLabel(
        congestionRatio
      ),

    trafficPeriod:
      trafficPeriodLabel(
        congestionRatio
      ),

    geometry:
      parseTomTomGeometry(
        route
      ),

  };

}


// ========================================================
// Call TomTom
// ========================================================

async function tomTomRoute({

  start,

  end,

  apiKey,

  fetchWithTimeout,

  travelMode,

  departAtMs = null,

  arriveAtMs = null,

}) {

  const locations =

    `${start.lat},${start.lon}` +

    ":" +

    `${end.lat},${end.lon}`;


  const params =
    new URLSearchParams({

      key:
        apiKey,

      routeType:
        "fastest",

      traffic:
        "true",

      travelMode,

      computeTravelTimeFor:
        "all",

      routeRepresentation:
        "polyline",

      language:
        "zh-TW",

    });


  if (
    Number.isFinite(
      departAtMs
    )
  ) {

    params.set(
      "departAt",
      new Date(
        departAtMs
      ).toISOString()
    );

  }


  if (
    Number.isFinite(
      arriveAtMs
    )
  ) {

    params.set(
      "arriveAt",
      new Date(
        arriveAtMs
      ).toISOString()
    );

  }


  const url =

    `${TOMTOM_ROUTING_URL}/` +

    `${locations}/json?` +

    params.toString();


  const response =
    await fetchWithTimeout(

      url,

      {},

      12000

    );


  let data;


  try {

    data =
      await response.json();

  } catch {

    data =
      null;

  }


  if (
    !response.ok ||
    !data?.routes?.length
  ) {

    const detail =

      data?.detailedError?.message ||

      data?.error?.description ||

      (typeof data?.error === "string" ? data.error : "") ||

      `HTTP ${response.status}`;


    // 401 / 403：金鑰無效、過期或沒有開 Routing API 權限。
    // 訊息裡帶 TOMTOM_API_KEY，server.js 會據此回 503 並給清楚提示。

    if (
      response.status === 401 ||
      response.status === 403
    ) {

      const error =
        new Error(
          `TOMTOM_API_KEY 無效或沒有 Routing API 權限（TomTom 回應：${detail}）`
        );

      error.code =
        "TOMTOM_KEY_INVALID";

      throw error;

    }


    throw new Error(
      `TomTom 路線查詢失敗：${detail}`
    );

  }


  return normalizeTomTomRoute(

    data.routes[0],

    departAtMs

  );

}


// ========================================================
// Candidate times
// ========================================================

function uniqueSortedTimes(
  times
) {

  return [

    ...new Set(

      times
        .filter(
          Number.isFinite
        )
        .map(
          Math.round
        )

    )

  ].sort(
    (a, b) =>
      a - b
  );

}


function buildCandidateTimes(

  latestDepartureMs,

  lookbackMinutes,

  intervalMinutes

) {

  const times = [];


  for (

    let minutesBefore =
      lookbackMinutes;

    minutesBefore >= 0;

    minutesBefore -=
      intervalMinutes

  ) {

    times.push(

      addMinutes(

        latestDepartureMs,

        -minutesBefore

      )

    );

  }


  times.push(
    latestDepartureMs
  );


  const unique =
    uniqueSortedTimes(
      times
    );


  if (
    unique.length <=
    MAX_CANDIDATES
  ) {

    return unique;

  }


  // 如果太多，只平均抽樣 MAX_CANDIDATES 個
  // 避免每次按一下就打太多 API。

  const sampled = [];


  for (
    let i = 0;
    i < MAX_CANDIDATES - 1;
    i++
  ) {

    const index =
      Math.round(

        (
          i /
          (MAX_CANDIDATES - 2)
        ) *

        (
          unique.length - 2
        )

      );


    sampled.push(
      unique[index]
    );

  }


  sampled.push(
    unique[
      unique.length - 1
    ]
  );


  return uniqueSortedTimes(
    sampled
  );

}


// ========================================================
// Recommendation logic
// ========================================================

function chooseRecommendation(

  candidates,

  latestAcceptableArrivalMs

) {

  // 先排除會遲到的候選

  const feasible =
    candidates.filter(

      (candidate) =>

        Number.isFinite(
          candidate.arrivalMs
        ) &&

        candidate.arrivalMs <=
        latestAcceptableArrivalMs

    );


  if (
    !feasible.length
  ) {

    return null;

  }


  // ------------------------------------------
  // 找最短車程
  // ------------------------------------------

  const shortestTravel =
    Math.min(

      ...feasible.map(
        (candidate) =>
          candidate.travelSeconds
      )

    );


  // ------------------------------------------
  // 不要求一定是「絕對最短」
  //
  // 容許：
  //
  // 5 分鐘
  // 或
  // 最短車程的 10%
  //
  // 取較大的
  // ------------------------------------------

  const toleranceSeconds =
    Math.max(

      5 * 60,

      shortestTravel *
      0.10

    );


  const nearOptimal =
    feasible.filter(

      (candidate) =>

        candidate.travelSeconds <=

        shortestTravel +
        toleranceSeconds

    );


  // ------------------------------------------
  // 在接近最佳的候選中
  //
  // 選「最晚出發」
  //
  // 這就是避免：
  // 越早越好的關鍵
  // ------------------------------------------

  const recommended =
    nearOptimal.reduce(

      (best, candidate) =>

        best.departureMs >
        candidate.departureMs

          ?

        best

          :

        candidate

    );


  // ------------------------------------------
  // 最晚還能準時的時間
  // ------------------------------------------

  const latestFeasible =
    feasible.reduce(

      (best, candidate) =>

        best.departureMs >
        candidate.departureMs

          ?

        best

          :

        candidate

    );


  // ------------------------------------------
  // 最順的時間
  // ------------------------------------------

  const smoothest =

    [...feasible]

      .sort(
        (a, b) => {

          const ar =
            a.congestionRatio ??
            Infinity;

          const br =
            b.congestionRatio ??
            Infinity;


          return (

            ar - br ||

            a.travelSeconds -
            b.travelSeconds ||

            b.departureMs -
            a.departureMs

          );

        }
      )[0];


  // ------------------------------------------
  // 建議時間區間
  // ------------------------------------------

  const sortedNear =
    [...nearOptimal].sort(

      (a, b) =>
        a.departureMs -
        b.departureMs

    );


  let windowStartMs =
    recommended.departureMs;


  for (
    let i =
      sortedNear.length - 1;

    i >= 0;

    i--
  ) {

    const candidate =
      sortedNear[i];


    if (

      recommended.departureMs -
      candidate.departureMs <=
      30 * 60 * 1000

    ) {

      windowStartMs =
        candidate.departureMs;

    }

  }


  return {

    recommended,

    latestFeasible,

    smoothest,

    shortestTravelSeconds:
      shortestTravel,

    recommendedWindow: {

      startMs:
        windowStartMs,

      endMs:
        recommended.departureMs,

    },

  };

}


// ========================================================
// Explain result
// ========================================================

function explainRecommendation({

  choice,

  latestAcceptableArrivalMs,

  arrivalBufferMinutes,

}) {

  const lines = [];


  if (!choice) {
    return lines;
  }


  const recommended =
    choice.recommended;


  const latest =
    choice.latestFeasible;


  const smoothest =
    choice.smoothest;


  lines.push(

    "系統先排除無法在指定時間前抵達的選項，再找出車程接近最短的候選，最後從中選擇較晚出發的一個，避免為了少塞一點而過早出門。"

  );


  if (
    arrivalBufferMinutes > 0
  ) {

    lines.push(

      `已替你預留 ${arrivalBufferMinutes} 分鐘抵達緩衝。`

    );

  }


  const delayMinutes =
    Math.round(

      (
        recommended
          .trafficDelaySeconds ||
        0
      ) / 60

    );


  if (
    delayMinutes > 0
  ) {

    lines.push(

      `推薦時段因交通狀況約增加 ${delayMinutes} 分鐘車程，目前判定為「${recommended.trafficPeriod}／壅塞${recommended.congestionLevel}」。`

    );

  } else {

    lines.push(

      `推薦時段接近無壅塞車程，目前判定為「${recommended.trafficPeriod}／壅塞${recommended.congestionLevel}」。`

    );

  }


  if (

    latest &&

    latest.departureMs !==
    recommended.departureMs

  ) {

    const laterMinutes =
      Math.round(

        (
          latest.departureMs -
          recommended.departureMs
        ) /
        60000

      );


    const slowerMinutes =
      Math.round(

        (
          latest.travelSeconds -
          recommended.travelSeconds
        ) /
        60

      );


    if (
      laterMinutes > 0 &&
      slowerMinutes > 0
    ) {

      lines.push(

        `雖然最晚還可以再晚約 ${laterMinutes} 分鐘出發，但預估車程會多約 ${slowerMinutes} 分鐘，因此沒有選最晚出發。`

      );

    }

  }


  if (

    smoothest &&

    smoothest.departureMs !==
    recommended.departureMs

  ) {

    const earlierMinutes =
      Math.round(

        (
          recommended.departureMs -
          smoothest.departureMs
        ) /
        60000

      );


    if (
      earlierMinutes > 0
    ) {

      lines.push(

        `更早約 ${earlierMinutes} 分鐘出發可能更順，但系統不採用「越早越好」的推薦方式。`

      );

    }

  }


  const spareMinutes =
    Math.floor(

      (
        latestAcceptableArrivalMs -
        recommended.arrivalMs
      ) /
      60000

    );


  if (
    spareMinutes > 0
  ) {

    lines.push(

      `推薦方案預估仍有約 ${spareMinutes} 分鐘額外餘裕。`

    );

  }


  return lines;

}


// ========================================================
// Public function
// ========================================================

export async function recommendBestDepartureTime({

  start,

  end,

  targetArrivalMs,

  arrivalBufferMinutes = 10,

  travelMode = "car",

  intervalMinutes =
    DEFAULT_INTERVAL_MINUTES,

  lookbackMinutes =
    DEFAULT_LOOKBACK_MINUTES,

  tomtomApiKey,

  fetchWithTimeout,

}) {

  // ------------------------------------------
  // Validation
  // ------------------------------------------

  if (!tomtomApiKey) {

    throw new Error(
      "Missing TOMTOM_API_KEY in .env"
    );

  }


  if (!fetchWithTimeout) {

    throw new Error(
      "fetchWithTimeout is required"
    );

  }


  if (

    ![

      start?.lat,

      start?.lon,

      end?.lat,

      end?.lon,

      targetArrivalMs,

    ].every(
      Number.isFinite
    )

  ) {

    throw new Error(

      "Invalid start/end coordinates or target arrival time"

    );

  }


  if (

    ![
      "car",
      "motorcycle"
    ].includes(
      travelMode
    )

  ) {

    throw new Error(

      "travelMode must be car or motorcycle"

    );

  }


  const safeBuffer =
    clamp(

      Number(
        arrivalBufferMinutes
      ) || 0,

      0,

      60

    );


  const safeInterval =
    clamp(

      Number(
        intervalMinutes
      ) ||
      DEFAULT_INTERVAL_MINUTES,

      5,

      30

    );


  const safeLookback =
    clamp(

      Number(
        lookbackMinutes
      ) ||
      DEFAULT_LOOKBACK_MINUTES,

      60,

      240

    );


  // ------------------------------------------
  // User says 09:00 arrival
  //
  // buffer 10 min
  //
  // actually use 08:50 as deadline
  // ------------------------------------------

  const latestAcceptableArrivalMs =
    addMinutes(

      targetArrivalMs,

      -safeBuffer

    );


  if (

    latestAcceptableArrivalMs <=
    Date.now() +
    5 * 60 * 1000

  ) {

    throw new Error(

      "希望抵達時間太接近現在，請至少預留一些行程時間"

    );

  }


  // ======================================================
  // Step 1
  //
  // Ask TomTom:
  //
  // 「如果我要在這個時間抵達，
  // 最晚大約幾點出發？」
  // ======================================================

  const arriveByRoute =
    await tomTomRoute({

      start,

      end,

      apiKey:
        tomtomApiKey,

      fetchWithTimeout,

      travelMode,

      arriveAtMs:
        latestAcceptableArrivalMs,

    });


  const latestDepartureAnchor =

    Number.isFinite(
      arriveByRoute.departureMs
    )

      ?

    arriveByRoute.departureMs

      :

    (
      latestAcceptableArrivalMs -

      (
        arriveByRoute
          .travelSeconds ||

        30 * 60
      ) *

      1000
    );


  // ======================================================
  // Step 2
  //
  // 向前分析約 2 小時
  //
  // 每 15 分鐘測一次
  // ======================================================

  const candidateTimes =

    buildCandidateTimes(

      latestDepartureAnchor,

      safeLookback,

      safeInterval

    )

      .filter(

        (time) =>

          time >
          Date.now() -
          60 * 1000

      );


  if (
    !candidateTimes.length
  ) {

    return {

      status:
        "ok",

      canArriveOnTime:
        false,

      targetArrivalMs,

      latestAcceptableArrivalMs,

      arrivalBufferMinutes:
        safeBuffer,

      travelMode,

      candidates:
        [],

      dataSource:
        "TomTom time-dependent routing",

    };

  }


  // ======================================================
  // Step 3
  //
  // Query each departure time
  // ======================================================

  const candidates = [];


  // Sequential intentionally.
  // Avoid sending many routing requests at once.

  for (
    const departAtMs of
    candidateTimes
  ) {

    try {

      const route =
        await tomTomRoute({

          start,

          end,

          apiKey:
            tomtomApiKey,

          fetchWithTimeout,

          travelMode,

          departAtMs,

        });


      candidates.push({

        ...route,

        feasible:

          Number.isFinite(
            route.arrivalMs
          ) &&

          route.arrivalMs <=
          latestAcceptableArrivalMs,

      });


    } catch (
      error
    ) {

      candidates.push({

        departureMs:
          departAtMs,

        arrivalMs:
          null,

        travelSeconds:
          null,

        feasible:
          false,

        error:
          error.message,

        geometry:
          [],

      });

    }

  }


  // Only candidates with valid route estimates

  const validCandidates =
    candidates.filter(

      (candidate) =>

        Number.isFinite(
          candidate.travelSeconds
        )

    );


  if (
    !validCandidates.length
  ) {

    throw new Error(

      "所有候選時間的路線預估都失敗，請稍後再試"

    );

  }


  // ======================================================
  // Step 4
  //
  // Choose recommended time
  // ======================================================

  const choice =
    chooseRecommendation(

      validCandidates,

      latestAcceptableArrivalMs

    );


  if (!choice) {

    return {

      status:
        "ok",

      canArriveOnTime:
        false,

      targetArrivalMs,

      latestAcceptableArrivalMs,

      arrivalBufferMinutes:
        safeBuffer,

      travelMode,

      candidates:
        validCandidates,

      dataSource:
        "TomTom time-dependent routing",

    };

  }


  const recommended =
    choice.recommended;


  const recommendedIndex =
    validCandidates
      .findIndex(

        (candidate) =>

          candidate.departureMs ===
          recommended.departureMs

      );


  return {

    status:
      "ok",

    canArriveOnTime:
      true,

    targetArrivalMs,

    latestAcceptableArrivalMs,

    arrivalBufferMinutes:
      safeBuffer,

    travelMode,

    recommendedIndex,

    recommended: {

      ...recommended,

      windowStartMs:
        choice
          .recommendedWindow
          .startMs,

      windowEndMs:
        choice
          .recommendedWindow
          .endMs,

    },

    latestFeasibleDepartureMs:

      choice
        .latestFeasible
        ?.departureMs ??
      null,

    smoothestDepartureMs:

      choice
        .smoothest
        ?.departureMs ??
      null,

    shortestTravelSeconds:
      choice
        .shortestTravelSeconds,

    candidates:
      validCandidates,

    explanation:
      explainRecommendation({

        choice,

        latestAcceptableArrivalMs,

        arrivalBufferMinutes:
          safeBuffer,

      }),

    dataSource:
      "TomTom time-dependent routing",

    methodology:

      "排除遲到 → 找接近最短車程的候選 → 從中選較晚出發的時間",

  };

}