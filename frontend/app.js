console.log("APP JS LOADED REAL TDX FRONTEND v50");

// =========================================================
// CONFIG
// =========================================================

const BACKEND_BASE_URL = "http://localhost:3000";


// =========================================================
// MAP
// =========================================================

const map = L.map("map").setView(
  [25.033, 121.5654],
  13
);

L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "&copy; OpenStreetMap contributors",
  }
).addTo(map);


// =========================================================
// STATE
// =========================================================

let startMarker = null;
let endMarker = null;

let waypointMarkers = [];
let routeLines = [];

let myLocation = null;
let latestRoutes = [];

let waypointCounter = 0;


// =========================================================
// MODE LABEL
// =========================================================

const modeText = {
  walk: "步行",
  bus: "公車",
  mrt: "捷運",
  train: "台鐵",
  hsr: "高鐵",
  drive: "開車",
};


// =========================================================
// HELPERS
// =========================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function formatNumber(value, digits = 1) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return "-";
  }

  return n.toFixed(digits);
}


function formatPercent(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return "0%";
  }

  return Math.round(n * 100) + "%";
}


function formatTime(iso) {
  if (!iso) {
    return "-";
  }

  try {
    const date = new Date(iso);

    return date.toLocaleTimeString(
      "zh-TW",
      {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Taipei",
      }
    );
  } catch {
    return iso;
  }
}


async function fetchJson(url, options = {}) {
  const response = await fetch(
    url,
    options
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "伺服器沒有回傳 JSON：" +
        text.slice(0, 300)
    );
  }

  if (!response.ok) {
    const message =
      data.detail ||
      data.error ||
      data.message ||
      JSON.stringify(data);

    throw new Error(message);
  }

  return data;
}


// =========================================================
// GEOCODING
// =========================================================

async function geocode(address) {
  if (address === "我的位置") {
    if (!myLocation) {
      throw new Error(
        "請先按「使用我的位置當起點」"
      );
    }

    return {
      ...myLocation,
      displayName: "我的位置"
    };
  }

  const params =
    new URLSearchParams({
      q: address
    });


  // 像一般地圖搜尋一樣：
  // 有 GPS 就使用 GPS，
  // 否則使用目前地圖中心做搜尋偏好。
  let bias = null;

  if (
    myLocation &&
    Number.isFinite(
      Number(myLocation.lat)
    ) &&
    Number.isFinite(
      Number(myLocation.lon)
    )
  ) {
    bias = myLocation;
  } else if (
    typeof map !== "undefined" &&
    map &&
    typeof map.getCenter === "function"
  ) {
    const center =
      map.getCenter();

    bias = {
      lat:
        center.lat,

      lon:
        center.lng
    };
  }


  if (bias) {
    params.set(
      "nearLat",
      String(bias.lat)
    );

    params.set(
      "nearLon",
      String(bias.lon)
    );
  }


  const response =
    await fetch(
      BACKEND_BASE_URL +
      "/api/smart-geocode?" +
      params.toString()
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      data?.detail ||
      data?.error ||
      ("找不到地點：" + address)
    );
  }


  const result =
    data?.result;


  const lat =
    Number(result?.lat);

  const lon =
    Number(result?.lon);


  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    throw new Error(
      "搜尋結果沒有可用座標：" +
      address
    );
  }


  return {
    ...result,
    lat,
    lon,

    searchCandidates:
      data?.candidates || []
  };
}

function useMyLocation() {
  if (!navigator.geolocation) {
    alert(
      "你的瀏覽器不支援定位功能"
    );

    return;
  }


  document.getElementById(
    "status"
  ).innerHTML =
    "正在取得目前位置...";


  navigator.geolocation.getCurrentPosition(

    function (position) {

      myLocation = {
        lat:
          position.coords.latitude,

        lon:
          position.coords.longitude,
      };


      document.getElementById(
        "startInput"
      ).value =
        "我的位置";


      if (startMarker) {
        map.removeLayer(
          startMarker
        );
      }


      startMarker =
        L.marker([
          myLocation.lat,
          myLocation.lon,
        ])
          .addTo(map)
          .bindPopup(
            "我的位置"
          )
          .openPopup();


      map.setView(
        [
          myLocation.lat,
          myLocation.lon,
        ],
        15
      );


      document.getElementById(
        "status"
      ).innerHTML =
        "已取得目前位置。";

    },

    function (error) {

      console.error(
        "Geolocation error:",
        error
      );

      document.getElementById(
        "status"
      ).innerHTML =
        "<span style='color:red;'>無法取得目前位置，請確認 Safari 定位權限。</span>";

    },

    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000,
    }
  );
}


// =========================================================
// VOICE INPUT
// =========================================================

function startVoiceInput(
  targetInputId
) {

  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;


  if (!SpeechRecognition) {
    alert(
      "Safari 可能不支援目前的語音輸入功能，建議用 Chrome 測試。"
    );

    return;
  }


  const recognition =
    new SpeechRecognition();


  recognition.lang =
    "zh-TW";

  recognition.interimResults =
    false;

  recognition.maxAlternatives =
    1;


  document.getElementById(
    "status"
  ).innerHTML =
    "正在聽你說話...";


  recognition.onresult =
    function (event) {

      const text =
        event.results[0][0]
          .transcript
          .trim();


      const input =
        document.getElementById(
          targetInputId
        );


      if (input) {
        input.value =
          text;
      }


      document.getElementById(
        "status"
      ).innerHTML =
        "語音輸入完成：" +
        escapeHtml(text);
    };


  recognition.onerror =
    function (event) {

      document.getElementById(
        "status"
      ).innerHTML =
        "<span style='color:red;'>語音輸入失敗：" +
        escapeHtml(event.error) +
        "</span>";
    };


  recognition.start();
}


// =========================================================
// WAYPOINT
// =========================================================

function addWaypoint(
  defaultMode = "walk",
  defaultAddress = ""
) {

  waypointCounter += 1;

  const id =
    "waypoint_" +
    waypointCounter;


  const html = `
    <div
      class="waypointCard"
      id="${id}"
    >

      <div class="waypointHeader">

        <span>
          中途點 ${waypointCounter}
        </span>

        <button
          class="removeBtn"
          type="button"
          onclick="removeWaypoint('${id}')"
        >
          刪除
        </button>

      </div>


      <label class="fieldLabel">
        到這個中途點的交通工具
      </label>


      <select class="waypointMode">

        <option
          value="walk"
          ${
            defaultMode === "walk"
              ? "selected"
              : ""
          }
        >
          步行
        </option>

        <option
          value="bus"
          ${
            defaultMode === "bus"
              ? "selected"
              : ""
          }
        >
          公車
        </option>

        <option
          value="mrt"
          ${
            defaultMode === "mrt"
              ? "selected"
              : ""
          }
        >
          捷運
        </option>

        <option
          value="train"
          ${
            defaultMode === "train"
              ? "selected"
              : ""
          }
        >
          台鐵
        </option>

        <option
          value="hsr"
          ${
            defaultMode === "hsr"
              ? "selected"
              : ""
          }
        >
          高鐵
        </option>

        <option
          value="drive"
          ${
            defaultMode === "drive"
              ? "selected"
              : ""
          }
        >
          開車
        </option>

      </select>


      <label class="fieldLabel">
        中途點地址 / 站名
      </label>


      <div class="inputRow">

        <input
          class="waypointAddress"
          id="${id}_input"
          type="text"
          placeholder="例如：台北車站"
          value="${escapeHtml(
            defaultAddress
          )}"
        />

        <button
          class="voiceBtn"
          type="button"
          onclick="startVoiceInput('${id}_input')"
        >
          🎤
        </button>

      </div>

    </div>
  `;


  document
    .getElementById(
      "waypointList"
    )
    .insertAdjacentHTML(
      "beforeend",
      html
    );
}


function removeWaypoint(id) {
  const element =
    document.getElementById(id);

  if (element) {
    element.remove();
  }
}


// =========================================================
// CLEAR
// =========================================================

function removeMapRoutes() {

  routeLines.forEach(
    (line) => {

      try {
        map.removeLayer(line);
      } catch {}
    }
  );


  routeLines = [];
}


function clearOnlyMapRoutes() {

  removeMapRoutes();


  waypointMarkers.forEach(
    (marker) => {

      try {
        map.removeLayer(marker);
      } catch {}
    }
  );


  waypointMarkers = [];


  if (startMarker) {

    try {
      map.removeLayer(
        startMarker
      );
    } catch {}

    startMarker = null;
  }


  if (endMarker) {

    try {
      map.removeLayer(
        endMarker
      );
    } catch {}

    endMarker = null;
  }
}


function clearRoutes() {

  clearOnlyMapRoutes();


  latestRoutes = [];


  document.getElementById(
    "routeList"
  ).innerHTML =
    "";


  document.getElementById(
    "recommendationBox"
  ).innerHTML =
    "";


  document.getElementById(
    "status"
  ).innerHTML =
    "已清除路線。";
}


// =========================================================
// SINGLE ROUTE
// =========================================================

async function calculateRoute() {

  try {

    const startText =
      document
        .getElementById(
          "startInput"
        )
        .value
        .trim();


    const endText =
      document
        .getElementById(
          "endInput"
        )
        .value
        .trim();


    if (
      !startText ||
      !endText
    ) {

      alert(
        "請輸入起點和終點"
      );

      return;
    }


    // -------------------------
    // Loading
    // -------------------------

    document.getElementById(
      "routeList"
    ).innerHTML =
      "";


    document.getElementById(
      "recommendationBox"
    ).innerHTML =
      "";


    document.getElementById(
      "status"
    ).innerHTML =
      "正在解析起點...";


    // -------------------------
    // Geocode start
    // -------------------------

    const startPoint =
      await geocode(
        startText
      );


    document.getElementById(
      "status"
    ).innerHTML =
      "正在解析終點...";


    // -------------------------
    // Geocode end
    // -------------------------

    const endPoint =
      await geocode(
        endText
      );


    console.log(
      "Start:",
      startPoint
    );

    console.log(
      "End:",
      endPoint
    );


    // -------------------------
    // Clear old route
    // -------------------------

    clearOnlyMapRoutes();


    // -------------------------
    // Markers
    // -------------------------

    startMarker =
      L.marker([
        startPoint.lat,
        startPoint.lon,
      ])
        .addTo(map)
        .bindPopup(
          "起點：" +
            escapeHtml(
              startText
            )
        );


    endMarker =
      L.marker([
        endPoint.lat,
        endPoint.lon,
      ])
        .addTo(map)
        .bindPopup(
          "終點：" +
            escapeHtml(
              endText
            )
        );


    // -------------------------
    // Show geocode result
    // -------------------------

    document.getElementById(
      "status"
    ).innerHTML =
      "<b>地點解析：</b>" +
      escapeHtml(
        startPoint.displayName
      ) +
      " → " +
      escapeHtml(
        endPoint.displayName
      ) +
      "<br>" +
      "<span style='font-size:12px;'>" +
      escapeHtml(
        startPoint.source
      ) +
      " / " +
      escapeHtml(
        endPoint.source
      ) +
      "</span><br>" +
      "正在取得 OSRM 路線與 TDX 即時交通...";


    // -------------------------
    // Route API
    // -------------------------

    const params =
      new URLSearchParams({
        startLon:
          String(
            startPoint.lon
          ),

        startLat:
          String(
            startPoint.lat
          ),

        endLon:
          String(
            endPoint.lon
          ),

        endLat:
          String(
            endPoint.lat
          ),
      });


    const routeUrl =
      BACKEND_BASE_URL +
      "/api/route?" +
      params.toString();


    console.log(
      "Route URL:",
      routeUrl
    );


    const routeData =
      await fetchJson(
        routeUrl
      );


    console.log(
      "ROUTE DATA:",
      routeData
    );


    if (
      !Array.isArray(
        routeData.routes
      ) ||
      routeData.routes.length ===
        0
    ) {

      throw new Error(
        "Backend 有回應，但沒有 routes"
      );
    }


    // -------------------------
    // Save
    // -------------------------

    latestRoutes =
      routeData.routes;


    // -------------------------
    // Draw
    // -------------------------

    drawAllRoutes(
      routeData.routes
    );


    // -------------------------
    // Cards
    // -------------------------

    renderRecommendation(
      routeData.recommendation,
      routeData.traffic
    );


    renderRouteCards(
      routeData.routes
    );


    // -------------------------
    // Complete
    // -------------------------

    const firstRoute =
      routeData.routes[0];


    const coverage =
      formatPercent(
        firstRoute
          .combinedLiveCoverageRatio ??
        firstRoute
          .tdxCoverageRatio ??
        0
      );


    document.getElementById(
      "status"
    ).innerHTML =
      "<b>單段路線規劃完成。</b><br>" +
      escapeHtml(
        startPoint.displayName
      ) +
      " → " +
      escapeHtml(
        endPoint.displayName
      ) +
      "<br>" +
      "TDX Live Coverage：" +
      coverage;


  } catch (error) {

    console.error(
      "calculateRoute error:",
      error
    );


    document.getElementById(
      "status"
    ).innerHTML =
      "<span style='color:red;'>" +
      "<b>路線規劃錯誤：</b>" +
      escapeHtml(
        error.message
      ) +
      "</span>";
  }
}


// =========================================================
// DRAW ROUTES
// =========================================================

function drawAllRoutes(routes) {

  removeMapRoutes();


  routes.forEach(
    function (
      route,
      index
    ) {

      const geometry =
        route.geometry ||
        route.raw?.geometry;


      if (
        !geometry ||
        !Array.isArray(
          geometry.coordinates
        ) ||
        geometry.coordinates.length <
          2
      ) {

        console.warn(
          "Route has no geometry:",
          route
        );

        return;
      }


      const coordinates =
        geometry.coordinates.map(
          function (coord) {

            return [
              Number(coord[1]),
              Number(coord[0]),
            ];
          }
        );


      const line =
        L.polyline(
          coordinates,
          {
            weight:
              index === 0
                ? 7
                : 5,

            opacity:
              index === 0
                ? 0.95
                : 0.45,
          }
        ).addTo(map);


      const coverage =
        formatPercent(
          route
            .combinedLiveCoverageRatio ??
          route
            .tdxCoverageRatio ??
          0
        );


      line.bindPopup(
        "<b>" +
          escapeHtml(
            route.label
          ) +
          "</b>" +

        "<br>Expected：" +
          escapeHtml(
            route.expectedMin
          ) +
          " 分鐘" +

        "<br>Worst 10%：" +
          escapeHtml(
            route.worst10Min
          ) +
          " 分鐘" +

        "<br>Base OSRM：" +
          escapeHtml(
            route.baseOsrmMin
          ) +
          " 分鐘" +

        "<br>TDX Coverage：" +
          coverage +

        "<br>Stability：" +
          escapeHtml(
            route.stabilityScore
          ) +
          "/100"
      );


      routeLines.push(
        line
      );
    }
  );


  if (
    routeLines.length >
    0
  ) {

    const group =
      L.featureGroup(
        routeLines
      );


    map.fitBounds(
      group.getBounds(),
      {
        padding: [30, 30],
      }
    );


    selectRoute(0);
  }
}


// =========================================================
// SELECT ROUTE
// =========================================================

function selectRoute(
  selectedIndex
) {

  routeLines.forEach(
    function (
      line,
      index
    ) {

      line.setStyle({
        weight:
          index ===
          selectedIndex
            ? 8
            : 4,

        opacity:
          index ===
          selectedIndex
            ? 1
            : 0.28,
      });
    }
  );


  const cards =
    document.querySelectorAll(
      ".routeCard"
    );


  cards.forEach(
    function (
      card,
      index
    ) {

      card.classList.toggle(
        "selected",
        index ===
          selectedIndex
      );
    }
  );


  if (
    routeLines[
      selectedIndex
    ]
  ) {

    map.fitBounds(
      routeLines[
        selectedIndex
      ].getBounds(),
      {
        padding: [30, 30],
      }
    );
  }
}


// =========================================================
// RECOMMENDATION
// =========================================================


function displayMinutes(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? `${n} 分鐘`
    : "資料不足";
}


function displayRisk(route) {
  if (!route || route.riskStatus !== "ready") {
    const count = Number(
      route?.riskSampleCount || 0
    );

    const need = Number(
      route?.riskMinRequiredUniqueDays || 8
    );

    return `資料不足（${count}/${need} 個不同日期）`;
  }

  return displayMinutes(
    route.worst10Min
  );
}


function displayNullable(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== ""
  )
    ? value
    : "資料不足";
}


function renderRecommendation(recommendation, traffic) {
  if (!recommendation) return;

  /*
    新 backend：
    recommendation.selected = 真正推薦的 route
    recommendation.fastest = 目前最快 route

    歷史資料不足時 selected 通常就是 fastest。
  */
  const selected =
    recommendation.selected ||
    recommendation.fastest ||
    recommendation.conservative ||
    null;

  const fastest =
    recommendation.fastest ||
    selected;

  function validNumber(value) {
    return (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      Number.isFinite(Number(value))
    );
  }

  function minutes(value) {
    return validNumber(value)
      ? Number(value).toFixed(1) + " 分鐘"
      : "資料不足";
  }

  const expectedText =
    selected && validNumber(selected.expectedMin)
      ? minutes(selected.expectedMin)
      : fastest && validNumber(fastest.expectedMin)
      ? minutes(fastest.expectedMin)
      : "資料不足";

  const riskReady =
    selected?.riskStatus === "ready";

  const sampleCount =
    Number(
      selected?.riskSampleCount ||
      0
    );

  const minSamples =
    Number(
      selected?.riskMinRequiredUniqueDays ||
      8
    );

  const worst10Text =
    riskReady &&
    validNumber(selected?.worst10Min)
      ? minutes(selected.worst10Min)
      : `資料不足（${sampleCount}/${minSamples} 個不同日期）`;

  const varianceText =
    riskReady &&
    validNumber(selected?.variance)
      ? selected.variance
      : "資料不足";

  const sdText =
    riskReady &&
    validNumber(selected?.standardDeviationMin)
      ? minutes(selected.standardDeviationMin)
      : "資料不足";

  const coverage =
    Number(
      selected?.liveCoverageRatio ??
      selected?.tdxCoverageRatio ??
      traffic?.combinedLiveCoverageRatio
    );

  const coverageText =
    Number.isFinite(coverage)
      ? Math.round(coverage * 100) + "%"
      : "資料不足";

  const latest =
    selected?.latestLiveDataTime ||
    traffic?.latestLiveDataTime ||
    null;

  const tdxObserved =
    selected?.tdxObservedMin ??
    traffic?.tdxObservedMin;

  const osrmFallback =
    selected?.osrmFallbackMin ??
    traffic?.osrmFallbackMin;

  let trafficHtml = "";

  if (traffic || selected) {
    trafficHtml =
      "<br><br><b>即時資料來源：</b>" +

      "<br>TDX Live Coverage：" +
      coverageText +

      (
        validNumber(tdxObserved)
          ? "<br>TDX 實測時間：" +
            minutes(tdxObserved)
          : ""
      ) +

      (
        validNumber(osrmFallback)
          ? "<br>OSRM fallback：" +
            minutes(osrmFallback)
          : ""
      ) +

      (
        latest
          ? "<br>TDX 最新資料：" +
            latest
          : ""
      ) +

      (
        traffic?.description
          ? "<br><span style='font-size:12px;color:#555;'>" +
            traffic.description +
            "</span>"
          : ""
      );
  }

  let fastestHtml = "";

  if (
    fastest &&
    validNumber(fastest.expectedMin)
  ) {
    fastestHtml =
      "<br><br>⚡ <b>Fastest：</b> " +
      (fastest.label || "-") +
      "，" +
      minutes(fastest.expectedMin);
  }

  document.getElementById(
    "recommendationBox"
  ).innerHTML =
    "<div class='recommendBox'>" +

    "<b>系統推薦：" +
    (
      recommendation.label ||
      selected?.label ||
      fastest?.label ||
      "-"
    ) +
    "</b><br>" +

    "類型：" +
    (
      recommendation.routeType ||
      selected?.routeType ||
      "-"
    ) +

    "<br><b>Expected：</b> " +
    expectedText +

    "<br><b>Worst 10%：</b> " +
    worst10Text +

    "<br><b>Variance：</b> " +
    varianceText +

    "<br><b>Standard Deviation：</b> " +
    sdText +

    "<br><b>TDX Live Coverage：</b> " +
    coverageText +

    fastestHtml +

    "<br><br>" +
    (
      recommendation.reason ||
      ""
    ) +

    trafficHtml +

    "</div>";
}


function renderRouteCards(routes) {
  let html = "";

  routes.forEach(function(route, index) {
    const coverage =
      Number(
        route.tdxCoverageRatio ??
        route.combinedLiveCoverageRatio
      );

    const coverageText =
      Number.isFinite(coverage)
        ? `${Math.round(coverage * 100)}%`
        : "資料不足";

    const riskReady =
      route.riskStatus === "ready";

    html +=
      "<div class='routeCard' onclick='selectRoute(" +
      index +
      ")'>" +

      "<div class='routeTitle'><span>" +
      route.label +
      "</span><span class='badge'>" +
      route.routeType +
      "</span></div>" +

      "<div class='trafficMetric'><b>目前 Expected：</b> " +
      displayMinutes(route.expectedMin) +
      "</div>" +

      "<div class='metric'><b>Base OSRM：</b> " +
      displayMinutes(route.baseOsrmMin) +
      "</div>" +

      "<div class='trafficMetric'><b>TDX Live Coverage：</b> " +
      coverageText +
      "</div>" +

      (
        Number.isFinite(
          Number(route.tdxObservedMin)
        )
          ? "<div class='trafficMetric'><b>TDX 實測時間：</b> " +
            displayMinutes(route.tdxObservedMin) +
            "</div>"
          : ""
      ) +

      (
        Number.isFinite(
          Number(route.osrmFallbackMin)
        )
          ? "<div class='metric'><b>OSRM fallback：</b> " +
            displayMinutes(route.osrmFallbackMin) +
            "</div>"
          : ""
      ) +

      "<div class='metric'><b>Worst 10%：</b> " +
      (
        riskReady
          ? displayMinutes(route.worst10Min)
          : displayRisk(route)
      ) +
      "</div>" +

      "<div class='metric'><b>Variance：</b> " +
      (
        riskReady
          ? displayNullable(route.variance)
          : "資料不足"
      ) +
      "</div>" +

      "<div class='metric'><b>Standard Deviation：</b> " +
      (
        riskReady
          ? displayMinutes(
              route.standardDeviationMin
            )
          : "資料不足"
      ) +
      "</div>" +

      "<div class='metric'><b>Distance：</b> " +
      route.distanceKm +
      " 公里</div>" +

      "</div>";
  });

  document.getElementById(
    "routeList"
  ).innerHTML = html;
}


function renderMultiModalSummary(
  data
) {

  const summary =
    data.summary || {};


  document.getElementById(
    "recommendationBox"
  ).innerHTML = `

    <div class="recommendBox">

      <b>
        多點路線總時間：
        ${escapeHtml(
          summary.totalExpectedMin ??
          data.totalExpectedMin ??
          "-"
        )}
        分鐘
      </b>

      <br>

      基礎移動時間：
      ${escapeHtml(
        summary.totalBaseMin ??
        "-"
      )}
      分鐘

      <br>

      等待 / 轉乘：
      ${escapeHtml(
        summary.totalWaitMin ??
        "-"
      )}
      分鐘

      <br>

      總距離：
      ${escapeHtml(
        summary.totalDistanceKm ??
        "-"
      )}
      公里

      <br>

      Worst 10%：
      ${escapeHtml(
        summary.worst10Min ??
        "-"
      )}
      分鐘

    </div>
  `;


  let html =
    "";


  data.segments.forEach(
    function (
      segment,
      index
    ) {

      html += `

        <div
          class="routeCard"
          onclick="selectRoute(${index})"
        >

          <div class="routeTitle">

            <span>
              第
              ${escapeHtml(
                segment.segmentId
              )}
              段
            </span>

            <span class="badge">

              ${escapeHtml(
                segment.modeLabel ||
                modeText[
                  segment.mode
                ] ||
                "-"
              )}

            </span>

          </div>


          <div class="metric">

            <b>
              From：
            </b>

            ${escapeHtml(
              segment.from
            )}

          </div>


          <div class="metric">

            <b>
              To：
            </b>

            ${escapeHtml(
              segment.to
            )}

          </div>


          <div class="trafficMetric">

            <b>
              Expected：
            </b>

            ${escapeHtml(
              segment.expectedMin
            )}

            分鐘

          </div>


          <div class="metric">

            <b>
              距離：
            </b>

            ${escapeHtml(
              segment.distanceKm ??
              "-"
            )}

            公里

          </div>


          <div class="metric">

            <b>
              資料來源：
            </b>

            ${escapeHtml(
              segment.source ||
              "-"
            )}

          </div>

        </div>
      `;
    }
  );


  document.getElementById(
    "routeList"
  ).innerHTML =
    html;
}


// =========================================================
// MAKE FUNCTIONS GLOBAL
// =========================================================

window.useMyLocation =
  useMyLocation;

window.startVoiceInput =
  startVoiceInput;

window.addWaypoint =
  addWaypoint;

window.removeWaypoint =
  removeWaypoint;

window.calculateRoute =
  calculateRoute;

window.calculateMultiModalRoute =
  calculateMultiModalRoute;

window.clearRoutes =
  clearRoutes;

window.selectRoute =
  selectRoute;


// =========================================================
// READY
// =========================================================

console.log(
  "REAL TDX FRONTEND READY"
);