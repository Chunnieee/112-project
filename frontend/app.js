import * as maplibregl from "https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.mjs";

const BACKEND_BASE_URL =
  window.location.port === "3000"
    ? window.location.origin
    : "http://localhost:3000";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: [121.5354, 25.0418],
  zoom: 12.4,
  pitch: 0,
  bearing: 0,
  attributionControl: false,
});

map.addControl(
  new maplibregl.NavigationControl({
    showCompass: false,
    visualizePitch: false,
  }),
  "bottom-right"
);

map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution: "OpenFreeMap · OpenStreetMap",
  }),
  "bottom-right"
);

const mapReady = new Promise((resolve) => {
  if (map.loaded()) resolve();
  else map.once("load", resolve);
});

let startMarker = null;
let endMarker = null;
let waypointMarkers = [];
let latestRoutes = [];
let selectedRouteIndex = 0;
let routePreference = "fastest";
let myLocation = null;
let waypointCounter = 0;

const modeText = {
  walk: "步行",
  bus: "公車",
  mrt: "捷運",
  train: "台鐵",
  hsr: "高鐵",
  drive: "開車",
};

const els = {
  startInput: document.getElementById("startInput"),
  endInput: document.getElementById("endInput"),
  status: document.getElementById("status"),
  routeList: document.getElementById("routeList"),
  recommendationBox: document.getElementById("recommendationBox"),
  backendStatus: document.getElementById("backendStatus"),
  backendStatusText: document.getElementById("backendStatusText"),
  fastestModeBtn: document.getElementById("fastestModeBtn"),
  reliableModeBtn: document.getElementById("reliableModeBtn"),
  mapStatus: document.getElementById("mapStatus"),
  mapStatusText: document.getElementById("mapStatusText"),
  floatingSummary: document.getElementById("floatingSummary"),
  floatingRoute: document.getElementById("floatingRoute"),
  floatingEta: document.getElementById("floatingEta"),
  floatingMeta: document.getElementById("floatingMeta"),
  drawer: document.getElementById("detailsDrawer"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  drawerTitle: document.getElementById("drawerTitle"),
  drawerContent: document.getElementById("drawerContent"),
};

function fmt(value, digits = 1, fallback = "—") {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return String(Number(n.toFixed(digits)));
}

function pct(value, fallback = "—") {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : fallback;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, state = "") {
  els.status.textContent = message;
  els.status.className = "status-message" + (state ? ` ${state}` : "");
}

function engineName(route) {
  const value =
    route?.routingEngine ||
    route?.raw?.routingEngine ||
    route?.raw?.engine ||
    "";

  const lower = String(value).toLowerCase();

  if (lower.includes("valhalla")) return "Valhalla";
  if (lower.includes("osrm")) return "OSRM fallback";
  return value ? String(value) : "Routing engine";
}

function baselineMin(route) {
  if (finite(route?.baseRouterMin)) return Number(route.baseRouterMin);
  if (finite(route?.baseOsrmMin)) return Number(route.baseOsrmMin);
  if (finite(route?.raw?.duration)) return Number(route.raw.duration) / 60;
  return null;
}

function uncoveredBaselineMin(route) {
  if (finite(route?.routingFallbackMin)) return Number(route.routingFallbackMin);
  if (finite(route?.osrmFallbackMin)) return Number(route.osrmFallbackMin);
  return baselineMin(route);
}

function historicalCoverage(route) {
  const candidates = [
    route?.historicalAverageTdxCoverageRatio,
    route?.historicalCoverageRatio,
    route?.riskCoverageRatio,
    route?.historicalMatchedCoverageRatio,
    route?.riskHistoricalCoverageRatio,
    route?.riskCoverage,
  ];

  for (const value of candidates) {
    if (finite(value)) return Number(value);
  }

  return null;
}

function riskReady(route) {
  return route?.riskStatus === "ready" && finite(route?.worst10Min);
}

function riskSamples(route) {
  return Number(route?.riskSampleCount || 0);
}

function minRiskSamples(route) {
  return Number(route?.riskMinRequiredUniqueDays || 8);
}

function fastestIndex() {
  if (!latestRoutes.length) return null;

  let best = 0;

  latestRoutes.forEach((route, index) => {
    if (
      Number(route.expectedMin) <
      Number(latestRoutes[best].expectedMin)
    ) {
      best = index;
    }
  });

  return best;
}

function reliableIndex() {
  let best = null;

  latestRoutes.forEach((route, index) => {
    if (!riskReady(route)) return;

    if (
      best === null ||
      Number(route.worst10Min) <
        Number(latestRoutes[best].worst10Min)
    ) {
      best = index;
    }
  });

  return best;
}

function routeBadge(route, index) {
  const fast = fastestIndex();
  const reliable = reliableIndex();

  if (index === fast && index === reliable) {
    return { text: "FAST + RELIABLE", className: "combo" };
  }

  if (index === reliable) {
    return { text: "MOST RELIABLE", className: "reliable" };
  }

  if (index === fast) {
    return { text: "FASTEST", className: "fast" };
  }

  return { text: "ALTERNATIVE", className: "" };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      payload?.detail ||
      payload?.error ||
      payload?.message ||
      `${response.status} ${response.statusText}`
    );
  }

  return payload;
}

function extractGeocodeResult(payload) {
  const candidates = [
    payload?.result,
    payload?.location,
    payload?.data?.result,
    payload?.data,
    payload,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const lat = Number(
      candidate?.lat ??
      candidate?.latitude ??
      candidate?.PositionLat ??
      candidate?.position?.lat ??
      candidate?.position?.PositionLat
    );

    const lon = Number(
      candidate?.lon ??
      candidate?.lng ??
      candidate?.longitude ??
      candidate?.PositionLon ??
      candidate?.position?.lon ??
      candidate?.position?.lng ??
      candidate?.position?.PositionLon
    );

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return {
        lat,
        lon,
        displayName:
          candidate?.displayName ||
          candidate?.name ||
          candidate?.address ||
          `${lat}, ${lon}`,
      };
    }
  }

  return null;
}

async function geocode(address) {
  if (address === "我的位置") {
    if (!myLocation) {
      throw new Error("請先取得目前位置。");
    }

    return {
      ...myLocation,
      displayName: "我的位置",
    };
  }

  const payload = await fetchJson(
    `${BACKEND_BASE_URL}/api/smart-geocode?q=${encodeURIComponent(address)}`
  );

  const result = extractGeocodeResult(payload);

  if (!result) {
    throw new Error(`找不到地點：${address}`);
  }

  return result;
}

function makeMarkerElement(kind, label) {
  const element = document.createElement("div");
  element.className = `map-marker ${kind}`;
  element.textContent = label;
  return element;
}

function removeMarker(marker) {
  if (marker) marker.remove();
}

function setStartMarker(point) {
  removeMarker(startMarker);

  startMarker = new maplibregl.Marker({
    element: makeMarkerElement("start", "A"),
    anchor: "center",
  })
    .setLngLat([point.lon, point.lat])
    .addTo(map);
}

function setEndMarker(point) {
  removeMarker(endMarker);

  endMarker = new maplibregl.Marker({
    element: makeMarkerElement("end", "B"),
    anchor: "center",
  })
    .setLngLat([point.lon, point.lat])
    .addTo(map);
}

function useMyLocation() {
  if (!navigator.geolocation) {
    setStatus("瀏覽器不支援定位功能。", "error");
    return;
  }

  setStatus("正在取得目前位置…", "loading");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      myLocation = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };

      els.startInput.value = "我的位置";
      setStartMarker(myLocation);

      map.easeTo({
        center: [myLocation.lon, myLocation.lat],
        zoom: 15,
        duration: 700,
      });

      setStatus("已取得目前位置。", "success");
    },
    () => {
      setStatus("無法取得位置，請確認瀏覽器定位權限。", "error");
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000,
    }
  );
}

function startVoiceInput(targetId) {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setStatus("此瀏覽器不支援語音輸入。", "error");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-TW";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  setStatus("正在聆聽…", "loading");

  recognition.onresult = (event) => {
    const text =
      event.results[0][0].transcript.trim();

    document.getElementById(targetId).value =
      text;

    setStatus(
      `語音輸入完成：${text}`,
      "success"
    );
  };

  recognition.onerror = (event) => {
    setStatus(
      `語音輸入失敗：${event.error}`,
      "error"
    );
  };

  recognition.start();
}

function swapEndpoints() {
  const start = els.startInput.value;
  els.startInput.value = els.endInput.value;
  els.endInput.value = start;
}

function addWaypoint(
  defaultMode = "walk",
  defaultAddress = ""
) {
  waypointCounter += 1;

  const id =
    `waypoint_${waypointCounter}`;

  const wrapper =
    document.createElement("div");

  wrapper.className =
    "waypointCard";

  wrapper.id = id;

  wrapper.innerHTML = `
    <div class="waypointHeader">
      <span>中途點 ${waypointCounter}</span>
      <button class="removeBtn" type="button">移除</button>
    </div>

    <select class="waypointMode">
      ${Object.entries(modeText)
        .map(
          ([value, text]) =>
            `<option value="${value}" ${
              value === defaultMode
                ? "selected"
                : ""
            }>${text}</option>`
        )
        .join("")}
    </select>

    <input
      class="waypointAddress"
      type="text"
      placeholder="輸入中途點"
      value="${esc(defaultAddress)}"
    />
  `;

  wrapper
    .querySelector(".removeBtn")
    .addEventListener(
      "click",
      () => wrapper.remove()
    );

  document
    .getElementById("waypointList")
    .appendChild(wrapper);
}

function removeRouteLayers() {
  if (!map.getStyle()) return;

  for (let i = 0; i < 20; i += 1) {
    const layerId = `route-line-${i}`;
    const casingId = `route-casing-${i}`;
    const sourceId = `route-source-${i}`;

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }

    if (map.getLayer(casingId)) {
      map.removeLayer(casingId);
    }

    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  }
}

function removeAllMapContent() {
  removeRouteLayers();

  removeMarker(startMarker);
  removeMarker(endMarker);

  startMarker = null;
  endMarker = null;

  waypointMarkers.forEach(
    (marker) => marker.remove()
  );

  waypointMarkers = [];
}

function linePaintForIndex(index) {
  const selected =
    index === selectedRouteIndex;

  return {
    "line-color":
      selected
        ? "#4f8cff"
        : "#536477",

    "line-width":
      selected
        ? 6
        : 4,

    "line-opacity":
      selected
        ? 0.97
        : 0.44,
  };
}

function casingPaintForIndex(index) {
  const selected =
    index === selectedRouteIndex;

  return {
    "line-color":
      selected
        ? "#07101e"
        : "#05080c",

    "line-width":
      selected
        ? 9
        : 7,

    "line-opacity":
      selected
        ? 0.9
        : 0.5,
  };
}

async function drawRoutes(routes) {
  await mapReady;

  removeRouteLayers();

  routes.forEach((route, index) => {
    if (
      !Array.isArray(
        route?.geometry?.coordinates
      )
    ) {
      return;
    }

    const sourceId =
      `route-source-${index}`;

    const casingId =
      `route-casing-${index}`;

    const lineId =
      `route-line-${index}`;

    map.addSource(sourceId, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {
          index,
        },
        geometry: route.geometry,
      },
    });

    map.addLayer({
      id: casingId,
      type: "line",
      source: sourceId,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint:
        casingPaintForIndex(index),
    });

    map.addLayer({
      id: lineId,
      type: "line",
      source: sourceId,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint:
        linePaintForIndex(index),
    });

    map.on(
      "click",
      lineId,
      () => {
        selectRoute(
          index,
          { fit: false }
        );
      }
    );

    map.on(
      "mouseenter",
      lineId,
      () => {
        map.getCanvas().style.cursor =
          "pointer";
      }
    );

    map.on(
      "mouseleave",
      lineId,
      () => {
        map.getCanvas().style.cursor =
          "";
      }
    );
  });

  fitAllRoutes(routes);
}

function fitAllRoutes(routes) {
  const bounds =
    new maplibregl.LngLatBounds();

  let hasPoint = false;

  routes.forEach((route) => {
    const coords =
      route?.geometry?.coordinates;

    if (!Array.isArray(coords)) {
      return;
    }

    coords.forEach((coord) => {
      if (
        Array.isArray(coord) &&
        coord.length >= 2
      ) {
        bounds.extend(coord);
        hasPoint = true;
      }
    });
  });

  if (!hasPoint) return;

  const leftPadding =
    window.innerWidth > 850
      ? 445
      : 45;

  map.fitBounds(bounds, {
    padding: {
      top: 65,
      right: 70,
      bottom: 70,
      left: leftPadding,
    },
    maxZoom: 15.7,
    duration: 650,
  });
}

function fitRoute(route) {
  const coords =
    route?.geometry?.coordinates;

  if (!Array.isArray(coords)) return;

  const bounds =
    new maplibregl.LngLatBounds();

  let hasPoint = false;

  coords.forEach((coord) => {
    if (
      Array.isArray(coord) &&
      coord.length >= 2
    ) {
      bounds.extend(coord);
      hasPoint = true;
    }
  });

  if (!hasPoint) return;

  map.fitBounds(bounds, {
    padding: {
      top: 70,
      right: 70,
      bottom: 70,
      left:
        window.innerWidth > 850
          ? 445
          : 45,
    },
    maxZoom: 16,
    duration: 550,
  });
}

function updateRouteLayerStyles() {
  latestRoutes.forEach(
    (_, index) => {
      const lineId =
        `route-line-${index}`;

      const casingId =
        `route-casing-${index}`;

      if (map.getLayer(lineId)) {
        const paint =
          linePaintForIndex(index);

        Object.entries(paint)
          .forEach(
            ([key, value]) => {
              map.setPaintProperty(
                lineId,
                key,
                value
              );
            }
          );
      }

      if (map.getLayer(casingId)) {
        const paint =
          casingPaintForIndex(index);

        Object.entries(paint)
          .forEach(
            ([key, value]) => {
              map.setPaintProperty(
                casingId,
                key,
                value
              );
            }
          );
      }
    }
  );

  const lineId =
    `route-line-${selectedRouteIndex}`;

  const casingId =
    `route-casing-${selectedRouteIndex}`;

  if (map.getLayer(casingId)) {
    map.moveLayer(casingId);
  }

  if (map.getLayer(lineId)) {
    map.moveLayer(lineId);
  }
}

function reliableEta(route) {
  return riskReady(route)
    ? Number(route.worst10Min)
    : null;
}

function differenceFromFastest(route) {
  const fast = fastestIndex();

  if (fast === null) return null;

  return (
    Number(route.expectedMin) -
    Number(
      latestRoutes[fast].expectedMin
    )
  );
}

function routeStateChips(route) {
  const coverage =
    Number(
      route
        ?.combinedLiveCoverageRatio ??
      route?.tdxCoverageRatio ??
      0
    );

  const liveClass =
    coverage > 0
      ? "good"
      : "";

  const historyClass =
    riskReady(route)
      ? "good"
      : "warn";

  const historyText =
    riskReady(route)
      ? "Historical ready"
      : `History ${riskSamples(route)}/${minRiskSamples(route)}`;

  return `
    <span class="state-chip ${liveClass}">
      Live data ${pct(coverage)}
    </span>
    <span class="state-chip ${historyClass}">
      ${esc(historyText)}
    </span>
  `;
}

function renderRecommendation() {
  if (!latestRoutes.length) {
    els.recommendationBox.innerHTML =
      "";
    return;
  }

  const route =
    latestRoutes[
      selectedRouteIndex
    ];

  const ready =
    riskReady(route);

  const p90 =
    reliableEta(route);

  const delta =
    differenceFromFastest(route);

  const label =
    routePreference === "reliable" &&
    ready
      ? "RELIABLE CHOICE"
      : "FASTEST CHOICE";

  const secondLabel =
    ready
      ? "Reliable ETA"
      : "History";

  const secondValue =
    ready
      ? `${fmt(p90)} min`
      : `${riskSamples(route)}/${minRiskSamples(route)} days`;

  const deltaValue =
    delta !== null &&
    delta > 0.05
      ? `+${fmt(delta)} min`
      : "Fastest";

  els.recommendationBox.innerHTML = `
    <div class="recommend-card">
      <div class="recommend-top">
        <div>
          <div class="recommend-kicker">RECOMMENDATION</div>
          <div class="recommend-title">${esc(route.label)}</div>
        </div>
        <span class="recommend-label">${label}</span>
      </div>

      <div class="recommend-main">
        <div class="recommend-eta">
          <strong>${fmt(route.expectedMin)} min</strong>
          <span>Expected ETA</span>
        </div>

        <div class="recommend-side">
          <span>Distance</span>
          <strong>${fmt(route.distanceKm, 2)} km</strong>
        </div>
      </div>

      <div class="recommend-subrow">
        <div class="recommend-subcell">
          <span>${secondLabel}</span>
          <strong>${esc(secondValue)}</strong>
        </div>
        <div class="recommend-subcell">
          <span>vs Fastest</span>
          <strong>${esc(deltaValue)}</strong>
        </div>
      </div>
    </div>
  `;
}

function renderRouteCards() {
  if (!latestRoutes.length) {
    renderEmptyState();
    return;
  }

  els.routeList.innerHTML =
    latestRoutes
      .map((route, index) => {
        const badge =
          routeBadge(route, index);

        const p90 =
          reliableEta(route);

        const delta =
          differenceFromFastest(route);

        const insightA =
          p90 !== null
            ? `
              <div class="insight">
                <span>Reliable ETA</span>
                <strong>${fmt(p90)} min</strong>
              </div>
            `
            : `
              <div class="insight">
                <span>History</span>
                <strong>${riskSamples(route)}/${minRiskSamples(route)} days</strong>
              </div>
            `;

        const insightB =
          `
            <div class="insight">
              <span>vs Fastest</span>
              <strong>${
                delta !== null &&
                delta > 0.05
                  ? `+${fmt(delta)} min`
                  : "Fastest"
              }</strong>
            </div>
          `;

        const note =
          riskReady(route)
            ? "Reliable ETA uses empirical historical P90."
            : "Reliability waits for enough empirical history.";

        return `
          <article
            class="route-card ${
              index === selectedRouteIndex
                ? "selected"
                : ""
            }"
            data-route-index="${index}"
          >
            <div class="route-card-top">
              <div class="route-card-title">
                ${esc(route.label)}
              </div>

              <span class="route-card-badge ${badge.className}">
                ${badge.text}
              </span>
            </div>

            <div class="route-card-main">
              <div class="route-time">
                <strong>${fmt(route.expectedMin)}</strong>
                <span>MIN EXPECTED</span>
              </div>

              <div class="route-distance">
                ${fmt(route.distanceKm, 2)} km
              </div>
            </div>

            <div class="route-insights">
              ${insightA}
              ${insightB}
            </div>

            <div class="state-row">
              ${routeStateChips(route)}
            </div>

            <div class="route-card-footer">
              <span class="route-card-note">
                ${esc(note)}
              </span>

              <button
                class="details-button"
                type="button"
                data-details-index="${index}"
              >
                Details →
              </button>
            </div>
          </article>
        `;
      })
      .join("");

  els.routeList
    .querySelectorAll(
      ".route-card"
    )
    .forEach((card) => {
      card.addEventListener(
        "click",
        (event) => {
          if (
            event.target.closest(
              ".details-button"
            )
          ) {
            return;
          }

          selectRoute(
            Number(
              card.dataset.routeIndex
            )
          );
        }
      );
    });

  els.routeList
    .querySelectorAll(
      ".details-button"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        (event) => {
          event.stopPropagation();

          const index =
            Number(
              button.dataset
                .detailsIndex
            );

          openDetails(index);
        }
      );
    });
}

function renderEmptyState() {
  els.routeList.innerHTML = `
    <div class="empty-state">
      <strong>No route selected</strong>
      <span>
        Route cards will show only the information needed to choose a trip.
        Research metrics are kept in Details.
      </span>
    </div>
  `;
}

function updateFloatingSummary(route) {
  if (!route) {
    els.floatingSummary.hidden =
      true;
    return;
  }

  els.floatingSummary.hidden =
    false;

  els.floatingRoute.textContent =
    route.label;

  els.floatingEta.textContent =
    `${fmt(route.expectedMin)} min`;

  els.floatingMeta.textContent =
    `${fmt(route.distanceKm, 2)} km`;
}

function updateModeAvailability() {
  const reliable =
    reliableIndex();

  els.reliableModeBtn.disabled =
    reliable === null;

  if (
    reliable === null &&
    routePreference === "reliable"
  ) {
    routePreference =
      "fastest";
  }

  els.fastestModeBtn
    .classList.toggle(
      "active",
      routePreference ===
        "fastest"
    );

  els.reliableModeBtn
    .classList.toggle(
      "active",
      routePreference ===
        "reliable"
    );
}

function chooseByPreference() {
  const index =
    routePreference === "reliable"
      ? reliableIndex()
      : fastestIndex();

  if (index !== null) {
    selectRoute(index);
  }
}

function selectRoute(
  index,
  { fit = true } = {}
) {
  if (!latestRoutes[index]) {
    return;
  }

  selectedRouteIndex = index;

  updateRouteLayerStyles();

  document
    .querySelectorAll(
      ".route-card"
    )
    .forEach((card, cardIndex) => {
      card.classList.toggle(
        "selected",
        cardIndex === index
      );
    });

  updateFloatingSummary(
    latestRoutes[index]
  );

  renderRecommendation();

  if (fit) {
    fitRoute(
      latestRoutes[index]
    );
  }
}

function detailsRow(label, value) {
  return `
    <div class="detail-row">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `;
}

function openDetails(index) {
  const route =
    latestRoutes[index];

  if (!route) return;

  selectRoute(
    index,
    { fit: false }
  );

  const coverage =
    Number(
      route
        ?.combinedLiveCoverageRatio ??
      route?.tdxCoverageRatio ??
      0
    );

  const histCoverage =
    historicalCoverage(route);

  const base =
    baselineMin(route);

  const fallback =
    uncoveredBaselineMin(route);

  const tdxObserved =
    finite(route?.tdxObservedMin)
      ? Number(route.tdxObservedMin)
      : 0;

  const p90 =
    riskReady(route)
      ? `${fmt(route.worst10Min)} min`
      : "Pending";

  const p95 =
    riskReady(route) &&
    finite(route?.worst5Min)
      ? `${fmt(route.worst5Min)} min`
      : "Pending";

  const sd =
    riskReady(route) &&
    finite(
      route?.standardDeviationMin
    )
      ? `${fmt(route.standardDeviationMin, 2)} min`
      : "—";

  const variance =
    riskReady(route) &&
    finite(route?.variance)
      ? fmt(route.variance, 3)
      : "—";

  const cv =
    riskReady(route) &&
    finite(
      route?.coefficientOfVariation
    )
      ? `${fmt(
          Number(
            route
              .coefficientOfVariation
          ) *
            (
              Number(
                route
                  .coefficientOfVariation
              ) <= 1
                ? 100
                : 1
            ),
          1
        )}%`
      : "—";

  const mean =
    riskReady(route) &&
    finite(
      route?.historicalMeanMin
    )
      ? `${fmt(route.historicalMeanMin, 2)} min`
      : "—";

  const median =
    riskReady(route) &&
    finite(
      route?.historicalMedianMin
    )
      ? `${fmt(route.historicalMedianMin, 2)} min`
      : "—";

  els.drawerTitle.textContent =
    route.label;

  els.drawerContent.innerHTML = `
    <section class="detail-section">
      <div class="detail-section-title">
        CURRENT ESTIMATE
      </div>

      <div class="detail-grid">
        ${detailsRow(
          "Expected ETA",
          `${fmt(route.expectedMin)} min`
        )}
        ${detailsRow(
          "Distance",
          `${fmt(route.distanceKm, 2)} km`
        )}
        ${detailsRow(
          "Routing baseline",
          finite(base)
            ? `${fmt(base)} min`
            : "—"
        )}
        ${detailsRow(
          "TDX observed",
          `${fmt(tdxObserved, 2)} min`
        )}
        ${detailsRow(
          "Uncovered baseline",
          finite(fallback)
            ? `${fmt(fallback, 2)} min`
            : "—"
        )}
        ${detailsRow(
          "Live coverage",
          pct(coverage)
        )}
      </div>
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        HISTORICAL RELIABILITY
      </div>

      <div class="detail-grid">
        ${detailsRow(
          "Worst 10% · P90",
          p90
        )}
        ${detailsRow(
          "Worst 5% · P95",
          p95
        )}
        ${detailsRow(
          "Standard deviation",
          sd
        )}
        ${detailsRow(
          "Variance",
          variance
        )}
        ${detailsRow(
          "Coefficient of variation",
          cv
        )}
        ${detailsRow(
          "Historical mean",
          mean
        )}
        ${detailsRow(
          "Historical median",
          median
        )}
        ${detailsRow(
          "Sample days",
          `${riskSamples(route)} / ${minRiskSamples(route)}`
        )}
        ${detailsRow(
          "Historical coverage",
          histCoverage === null
            ? "—"
            : pct(histCoverage)
        )}
      </div>

     <div class="detail-note">
  ${
    riskReady(route)
      ? `Based on ${riskSamples(route)} empirical same-weekday, same-30-minute-bucket historical observations.`
      : `Risk metrics remain unavailable until at least ${minRiskSamples(route)} empirical same-weekday, same-30-minute-bucket historical observations are available.`
  }
</div>
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        DATA & METHOD
      </div>

      <div class="detail-grid">
        ${detailsRow(
          "Routing engine",
          engineName(route)
        )}
        ${detailsRow(
          "Live source",
          coverage > 0
            ? "TDX live + routing fallback"
            : "Routing baseline only"
        )}
        ${detailsRow(
          "Historical source",
          route?.riskDataSource ||
            "TDX Historical"
        )}
        ${detailsRow(
          "Risk method",
          "Empirical P90 / P95"
        )}
      </div>
    </section>
  `;

  els.drawer.classList.add("open");
  els.drawer.setAttribute(
    "aria-hidden",
    "false"
  );

  els.drawerBackdrop.hidden =
    false;
}

function closeDetails() {
  els.drawer.classList.remove("open");
  els.drawer.setAttribute(
    "aria-hidden",
    "true"
  );
  els.drawerBackdrop.hidden =
    true;
}

async function calculateRoute() {
  try {
    const startText =
      els.startInput.value.trim();

    const endText =
      els.endInput.value.trim();

    if (
      !startText ||
      !endText
    ) {
      setStatus(
        "請輸入起點與目的地。",
        "error"
      );
      return;
    }

    setStatus(
      "正在計算候選路線…",
      "loading"
    );

    const [
      startPoint,
      endPoint,
    ] = await Promise.all([
      geocode(startText),
      geocode(endText),
    ]);

    await mapReady;

    removeAllMapContent();

    setStartMarker(startPoint);
    setEndMarker(endPoint);

    const params =
      new URLSearchParams({
        startLon:
          startPoint.lon,
        startLat:
          startPoint.lat,
        endLon:
          endPoint.lon,
        endLat:
          endPoint.lat,
      });

    const data =
      await fetchJson(
        `${BACKEND_BASE_URL}/api/route?${params.toString()}`
      );

    if (
      !Array.isArray(data?.routes) ||
      !data.routes.length
    ) {
      throw new Error(
        "找不到可用路線。"
      );
    }

    latestRoutes =
      data.routes;

    routePreference =
      "fastest";

    selectedRouteIndex =
      fastestIndex() ?? 0;

    updateModeAvailability();

    await drawRoutes(
      latestRoutes
    );

    renderRouteCards();
    renderRecommendation();

    selectRoute(
      selectedRouteIndex,
      { fit: false }
    );

    setStatus(
      `已找到 ${latestRoutes.length} 條候選路線。`,
      "success"
    );
  } catch (error) {
    console.error(error);

    setStatus(
      `規劃失敗：${error.message}`,
      "error"
    );
  }
}

async function calculateMultiModalRoute() {
  try {
    const startText =
      els.startInput.value.trim();

    const endText =
      els.endInput.value.trim();

    if (
      !startText ||
      !endText
    ) {
      setStatus(
        "請輸入起點與目的地。",
        "error"
      );
      return;
    }

    setStatus(
      "正在計算多段路線…",
      "loading"
    );

    const points = [];

    const startPoint =
      await geocode(
        startText
      );

    points.push({
      name: startText,
      lat: startPoint.lat,
      lon: startPoint.lon,
    });

    for (
      const card
      of document.querySelectorAll(
        ".waypointCard"
      )
    ) {
      const address =
        card
          .querySelector(
            ".waypointAddress"
          )
          .value
          .trim();

      const mode =
        card
          .querySelector(
            ".waypointMode"
          )
          .value;

      if (!address) continue;

      const point =
        await geocode(
          address
        );

      points.push({
        name: address,
        lat: point.lat,
        lon: point.lon,
        modeFromPrevious:
          mode,
      });
    }

    const endPoint =
      await geocode(
        endText
      );

    points.push({
      name: endText,
      lat: endPoint.lat,
      lon: endPoint.lon,
      modeFromPrevious:
        document
          .getElementById(
            "endMode"
          )
          .value,
    });

    const data =
      await fetchJson(
        `${BACKEND_BASE_URL}/api/multimodal-route`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify({
              points,
            }),
        }
      );

    setStatus(
      `多段路線完成：${fmt(data?.summary?.totalExpectedMin)} min`,
      "success"
    );

  } catch (error) {
    setStatus(
      `多段路線失敗：${error.message}`,
      "error"
    );
  }
}

function clearRoutes() {
  removeAllMapContent();

  latestRoutes = [];
  selectedRouteIndex = 0;
  routePreference = "fastest";

  updateModeAvailability();

  els.recommendationBox.innerHTML =
    "";

  els.floatingSummary.hidden =
    true;

  closeDetails();

  renderEmptyState();

  setStatus(
    "已清除路線。"
  );
}

async function checkBackend() {
  try {
    await fetchJson(
      `${BACKEND_BASE_URL}/api/health`
    );

    els.backendStatus
      .classList.add(
        "online"
      );

    els.backendStatusText
      .textContent =
        "Backend online";

    els.mapStatus
      .classList.add(
        "online"
      );

    els.mapStatusText
      .textContent =
        "Routing ready";
  } catch {
    els.backendStatus
      .classList.add(
        "offline"
      );

    els.backendStatusText
      .textContent =
        "Backend offline";

    els.mapStatusText
      .textContent =
        "Backend offline";
  }
}

els.fastestModeBtn
  .addEventListener(
    "click",
    () => {
      routePreference =
        "fastest";

      updateModeAvailability();
      chooseByPreference();
    }
  );

els.reliableModeBtn
  .addEventListener(
    "click",
    () => {
      if (
        reliableIndex() ===
        null
      ) {
        return;
      }

      routePreference =
        "reliable";

      updateModeAvailability();
      chooseByPreference();
    }
  );

document
  .getElementById(
    "routeBtn"
  )
  .addEventListener(
    "click",
    calculateRoute
  );

document
  .getElementById(
    "locationBtn"
  )
  .addEventListener(
    "click",
    useMyLocation
  );

document
  .getElementById(
    "mapLocationBtn"
  )
  .addEventListener(
    "click",
    useMyLocation
  );

document
  .getElementById(
    "swapBtn"
  )
  .addEventListener(
    "click",
    swapEndpoints
  );

document
  .getElementById(
    "clearBtn"
  )
  .addEventListener(
    "click",
    clearRoutes
  );

document
  .getElementById(
    "startVoiceBtn"
  )
  .addEventListener(
    "click",
    () =>
      startVoiceInput(
        "startInput"
      )
  );

document
  .getElementById(
    "endVoiceBtn"
  )
  .addEventListener(
    "click",
    () =>
      startVoiceInput(
        "endInput"
      )
  );

document
  .getElementById(
    "addWaypointBtn"
  )
  .addEventListener(
    "click",
    () => addWaypoint()
  );

document
  .getElementById(
    "multiRouteBtn"
  )
  .addEventListener(
    "click",
    calculateMultiModalRoute
  );

document
  .getElementById(
    "drawerCloseBtn"
  )
  .addEventListener(
    "click",
    closeDetails
  );

els.drawerBackdrop
  .addEventListener(
    "click",
    closeDetails
  );

els.startInput
  .addEventListener(
    "keydown",
    (event) => {
      if (
        event.key ===
        "Enter"
      ) {
        calculateRoute();
      }
    }
  );

els.endInput
  .addEventListener(
    "keydown",
    (event) => {
      if (
        event.key ===
        "Enter"
      ) {
        calculateRoute();
      }
    }
  );

map.on("load", () => {
  els.mapStatus
    .classList.add(
      "online"
    );

  els.mapStatusText
    .textContent =
      "Map ready";
});

map.on("error", (event) => {
  console.warn(
    "MapLibre:",
    event?.error ||
    event
  );
});

window.addWaypoint =
  addWaypoint;

window.calculateRoute =
  calculateRoute;

window.useMyLocation =
  useMyLocation;

renderEmptyState();
updateModeAvailability();
checkBackend();