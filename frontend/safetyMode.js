// =========================================================
// safetyMode.js — main route planner
// ---------------------------------------------------------
// One button "規劃路線":
//   步行 / 開車 (no waypoints) → compare several routes, recommend one
//                                (safety + time + distance)
//   捷運 / 公車 / 台鐵 / 高鐵 or waypoints → teammate's multi-modal planner
//
// Uses helpers from app.js: map, geocode, fetchJson, escapeHtml,
// routeLines, removeMapRoutes, clearOnlyMapRoutes, clearRoutes ...
// Load this file AFTER app.js.
// =========================================================

console.log("ROUTE PLANNER JS LOADED");

// ---------- Map look ----------

map.zoomControl.setPosition("bottomright");

const COLORS = {
  active: "#3a44c9",
  other: "#9aa1b2",
  casing: "#ffffff",
  store: "#1f9d6b",
  accident: "#d64545",
  dark: "#1c2230",
};

const INITIAL_STATUS =
  "輸入起點和終點，系統會比較幾條路線，推薦兼顧時間與安全的一條。";

// ---------- State ----------

const safetyOverlay = L.layerGroup().addTo(map);
let plans = []; // routes from /api/safety-route
let planLines = []; // [{ casing, line }]
let activePlan = -1;
let lastPlanData = null;

function clearSafetyOverlay() {
  safetyOverlay.clearLayers();
}

// ---------- Mode chips ----------

function setMode(mode) {
  document.getElementById("endMode").value = mode;
  document.querySelectorAll(".modeChip").forEach(function (chip) {
    chip.setAttribute("aria-checked", String(chip.dataset.mode === mode));
  });
}

document.querySelectorAll(".modeChip").forEach(function (chip) {
  chip.addEventListener("click", function () {
    setMode(chip.dataset.mode);
  });
});

// ---------- Small helpers ----------

function swapPlaces() {
  const a = document.getElementById("startInput");
  const b = document.getElementById("endInput");
  const t = a.value;
  a.value = b.value;
  b.value = t;
}

function setBusy(isBusy) {
  const btn = document.getElementById("planBtn");
  btn.disabled = isBusy;
  btn.textContent = isBusy ? "規劃中…" : "規劃路線";
}

function setStatus(html) {
  document.getElementById("status").innerHTML = html;
}

function showError(message) {
  setStatus("<div class='statusError'>" + escapeHtml(message) + "</div>");
}

function statusClass(level) {
  return level === "safe" ? "status--safe" : level === "medium" ? "status--medium" : "status--caution";
}

function statusPill(safety) {
  return (
    "<span class='status " + statusClass(safety.level) + "'>" +
    escapeHtml(safety.label) +
    "</span>"
  );
}

function barColor(score) {
  if (score === null || score === undefined) return "#d5d9e2";
  return score >= 75 ? "#1f9d6b" : score >= 50 ? "#e0a12a" : "#d64545";
}

function fmt(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : "—";
}

function formatAccidentTime(date, time) {
  const d = String(date || "");
  const t = String(time || "").padStart(6, "0");
  if (d.length !== 8) return d;
  return d.slice(0, 4) + "/" + d.slice(4, 6) + "/" + d.slice(6, 8) + " " + t.slice(0, 2) + ":" + t.slice(2, 4);
}

function hasWaypoints() {
  return Array.from(document.querySelectorAll("#waypointList .waypointAddress")).some(function (input) {
    return input.value.trim() !== "";
  });
}

function pinIcon(kind) {
  return L.divIcon({
    className: "",
    html: "<div class='pin pin--" + kind + "'></div>",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// =========================================================
// MAIN BUTTON
// =========================================================

async function planRoute() {
  const mode = document.getElementById("endMode").value || "walk";

  // Transit or waypoints → teammate's multi-modal planner
  if (hasWaypoints() || (mode !== "walk" && mode !== "drive")) {
    setBusy(true);
    try {
      clearPlanResults();
      await calculateMultiModalRoute();
    } finally {
      setBusy(false);
    }
    return;
  }

  await planSafeRoutes(mode);
}

// Advanced: teammate's TDX driving risk analysis
async function runRiskAnalysis() {
  setMode("drive");
  setBusy(true);
  try {
    clearPlanResults();
    await calculateRoute();
  } finally {
    setBusy(false);
  }
}

function clearPlanResults() {
  plans = [];
  planLines = [];
  activePlan = -1;
  clearSafetyOverlay();
  document.getElementById("recommendationBox").innerHTML = "";
  document.getElementById("routeList").innerHTML = "";
}

function resetPlanner() {
  clearRoutes(); // from app.js
  clearPlanResults();
  setStatus(INITIAL_STATUS);
}

// =========================================================
// 步行 / 開車: several routes + recommendation
// =========================================================

async function planSafeRoutes(mode) {
  const startText = document.getElementById("startInput").value.trim();
  const endText = document.getElementById("endInput").value.trim();

  if (!startText || !endText) {
    showError("請輸入起點和終點。");
    return;
  }

  setBusy(true);
  clearPlanResults();

  try {
    setStatus("正在找地點…");
    const startPoint = await geocode(startText);
    const endPoint = await geocode(endText);

    clearOnlyMapRoutes();

    startMarker = L.marker([startPoint.lat, startPoint.lon], { icon: pinIcon("start") })
      .addTo(map)
      .bindPopup("起點：" + escapeHtml(startPoint.displayName || startText));

    endMarker = L.marker([endPoint.lat, endPoint.lon], { icon: pinIcon("end") })
      .addTo(map)
      .bindPopup("終點：" + escapeHtml(endPoint.displayName || endText));

    setStatus("正在比較路線…");

    const params = new URLSearchParams({
      mode: mode,
      startLon: String(startPoint.lon),
      startLat: String(startPoint.lat),
      endLon: String(endPoint.lon),
      endLat: String(endPoint.lat),
    });

    const data = await fetchJson(BACKEND_BASE_URL + "/api/safety-route?" + params.toString());
    console.log("ROUTE PLANS:", data);

    if (!Array.isArray(data.routes) || data.routes.length === 0) {
      throw new Error("找不到可以走的路線，請換一個起點或終點試試。");
    }

    plans = data.routes;
    lastPlanData = data;

    setStatus("");
    drawPlans();
    renderPlans(data);
    selectPlan(0, { fit: true });

    // On phones, scroll the panel to the results
    if (window.innerWidth <= 640) {
      document.querySelector(".resultsHead")?.scrollIntoView({ block: "start" });
    }
  } catch (error) {
    console.error("planSafeRoutes error:", error);
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

// ---------- Map lines ----------

function drawPlans() {
  removeMapRoutes();
  planLines = [];

  plans.forEach(function (plan, index) {
    const coords = (plan.geometry?.coordinates || []).map(function (c) {
      return [Number(c[1]), Number(c[0])];
    });
    if (coords.length < 2) {
      planLines.push(null);
      return;
    }

    const casing = L.polyline(coords, { color: COLORS.casing, weight: 10, opacity: 1 }).addTo(map);
    const line = L.polyline(coords, { color: COLORS.other, weight: 5, opacity: 0.9 }).addTo(map);

    [casing, line].forEach(function (layer) {
      layer.on("click", function () {
        selectPlan(index);
      });
    });

    line.bindTooltip(plan.label + "　" + plan.durationMin + " 分鐘", { sticky: true });

    routeLines.push(casing, line); // so app.js can clear them
    planLines.push({ casing: casing, line: line });
  });
}

function selectPlan(index, options) {
  if (!plans[index]) return;
  activePlan = index;

  planLines.forEach(function (pair, i) {
    if (!pair) return;
    const isActive = i === index;
    pair.line.setStyle({
      color: isActive ? COLORS.active : COLORS.other,
      weight: isActive ? 7 : 5,
      opacity: isActive ? 1 : 0.85,
    });
    pair.casing.setStyle({ weight: isActive ? 12 : 9 });
  });

  // bring active line to the top
  const active = planLines[index];
  if (active) {
    active.casing.bringToFront();
    active.line.bringToFront();
  }

  document.querySelectorAll(".plan").forEach(function (card, i) {
    card.classList.toggle("isActive", i === index);
  });

  // Show safety layers only when this route's details are open
  const details = document.querySelector(".plan[data-index='" + index + "'] .planDetails");
  if (details && details.open) drawSafetyOverlay(plans[index]);
  else clearSafetyOverlay();

  if (options?.fit) {
    const group = L.featureGroup(planLines.filter(Boolean).map(function (p) { return p.line; }));
    const isMobile = window.innerWidth <= 640;
    map.fitBounds(group.getBounds(), {
      paddingTopLeft: isMobile ? [24, 24] : [420, 40],
      paddingBottomRight: isMobile ? [24, Math.round(window.innerHeight * 0.62) + 16] : [40, 40],
    });
  }
}

// Stores, accidents and dark sections for one route
function drawSafetyOverlay(plan) {
  clearSafetyOverlay();
  if (!plan?.safety) return;
  const s = plan.safety;

  s.darkSegments.forEach(function (seg) {
    L.polyline(seg, { color: COLORS.dark, weight: 3, dashArray: "4 6", opacity: 0.9 })
      .bindTooltip("30 公尺內沒有路燈")
      .addTo(safetyOverlay);
  });

  s.stores.forEach(function (store) {
    L.circleMarker([store.lat, store.lon], {
      radius: 5,
      color: "#fff",
      weight: 1.5,
      fillColor: COLORS.store,
      fillOpacity: 1,
    })
      .bindPopup(
        "<b>" + escapeHtml(store.type) + " " + escapeHtml(store.name) + "</b><br>" +
        escapeHtml(store.address) + "<br>距離路線約 " + store.distanceM + " 公尺"
      )
      .addTo(safetyOverlay);
  });

  s.accidents.forEach(function (acc) {
    L.circleMarker([acc.lat, acc.lon], {
      radius: acc.category === "A1" ? 7 : 5,
      color: "#fff",
      weight: 1.5,
      fillColor: COLORS.accident,
      fillOpacity: 1,
    })
      .bindPopup(
        "<b>" + escapeHtml(acc.category) + " 事故</b><br>" +
        escapeHtml(formatAccidentTime(acc.date, acc.time)) + "<br>" +
        escapeHtml(acc.location) + "<br>" + escapeHtml(acc.severity)
      )
      .addTo(safetyOverlay);
  });
}

// ---------- Panel ----------

function renderPlans(data) {
  const isDrive = data.travelMode === "drive";
  let html =
    "<div class='resultsHead'><span>" +
    (isDrive ? "開車" : "步行") + "，找到 " + plans.length + " 條路線" +
    "</span></div>";

  plans.forEach(function (plan, index) {
    const isRec = index === 0;
    const tags = plan.tags
      .map(function (t) {
        return "<span class='tag" + (t === "推薦" ? " tag--rec" : "") + "'>" + escapeHtml(t) + "</span>";
      })
      .join("");

    html +=
      "<article class='plan" + (isRec ? " plan--rec" : "") + "' data-index='" + index + "'>" +
      "<button type='button' class='planMain' onclick='selectPlan(" + index + ")'>" +
      (isRec ? "<div class='planTags'>" + tags + "</div>" : "") +
      "<div class='planTop'>" +
      "<span class='planName'>" + escapeHtml(plan.label) + "</span>" +
      "<span class='planTime'>" + plan.durationMin + "<small>分鐘</small></span>" +
      "<span class='planDist'>" + plan.distanceKm + " 公里</span>" +
      statusPill(plan.safety) +
      "</div>" +
      (isRec
        ? "<p class='planReason'>" + escapeHtml(data.recommendation.reason) + "</p>"
        : "<div class='planTags'>" + tags + "</div>") +
      "</button>" +
      "<details class='planDetails'>" +
      "<summary>查看詳細數據</summary>" +
      renderDetails(plan) +
      "</details>" +
      "</article>";
  });

  html +=
    "<p class='resultsFoot'>" +
    (isDrive
      ? "開車時間為一般車流估計，未含紅綠燈與塞車。"
      : "步行時間以每小時 4.8 公里計算。") +
    "</p>";

  document.getElementById("routeList").innerHTML = html;

  // Open details → select route and show its safety layers
  document.querySelectorAll(".planDetails").forEach(function (details) {
    details.addEventListener("toggle", function () {
      const index = Number(details.closest(".plan").dataset.index);
      if (details.open) {
        document.querySelectorAll(".planDetails").forEach(function (other) {
          if (other !== details) other.open = false;
        });
        selectPlan(index);
      } else if (index === activePlan) {
        clearSafetyOverlay();
      }
    });
  });
}

function renderDetails(plan) {
  const s = plan.safety;
  const b = s.breakdown;

  const lightHint =
    b.light.score === null
      ? "這一區還沒有路燈資料"
      : "附近 " + b.light.lampsNearRoute + " 盞路燈，" + Math.round(b.light.litRatio * 100) + "% 的路段有照明";

  const storeHint = "沿路 " + b.store.radiusM + " 公尺內有 " + b.store.storesNearRoute + " 間";

  const accidentHint =
    b.accident.count === 0
      ? "路線附近沒有事故紀錄"
      : "路線附近 " + b.accident.count + " 件（死亡 A1：" + b.accident.a1Count + "，受傷 A2：" + b.accident.a2Count + "）";

  function bar(label, score, weight, hint) {
    return (
      "<div class='bar'>" +
      "<div class='barTop'><span>" + label + "（" + Math.round(weight * 100) + "%）</span><b>" + fmt(score) + "</b></div>" +
      "<div class='barTrack'><div class='barFill' style='width:" + (score === null ? 0 : score) + "%;background:" + barColor(score) + "'></div></div>" +
      "<div class='barHint'>" + hint + "</div>" +
      "</div>"
    );
  }

  return (
    "<div class='detailBody'>" +

    "<div class='detailTitle'><span>推薦分數</span><span>" + fmt(plan.recommendScore) + "</span></div>" +
    "<div class='scoreGrid'>" +
    "<div class='scoreCell'><b>" + fmt(s.safetyScore) + "</b><span>安全 50%</span></div>" +
    "<div class='scoreCell'><b>" + fmt(plan.timeScore) + "</b><span>時間 30%</span></div>" +
    "<div class='scoreCell'><b>" + fmt(plan.distanceScore) + "</b><span>距離 20%</span></div>" +
    "</div>" +

    "<div class='detailTitle'><span>安全分數</span><span>" + fmt(s.safetyScore) + " / 100</span></div>" +
    bar("路燈", b.light.score, b.light.weight, lightHint) +
    bar("便利商店", b.store.score, b.store.weight, storeHint) +
    bar("事故（分數越高越少）", b.accident.score, b.accident.weight, accidentHint) +

    s.warnings.map(function (w) {
      return "<div class='detailNote'>" + escapeHtml(w) + "</div>";
    }).join("") +

    "<div class='mapLegend'>" +
    "<span><i style='background:" + COLORS.store + "'></i>便利商店</span>" +
    "<span><i style='background:" + COLORS.accident + "'></i>事故地點</span>" +
    "<span><i class='dash'></i>沒有路燈</span>" +
    "</div>" +

    "</div>"
  );
}

// make functions available to onclick="" in HTML
window.planRoute = planRoute;
window.runRiskAnalysis = runRiskAnalysis;
window.resetPlanner = resetPlanner;
window.swapPlaces = swapPlaces;
window.selectPlan = selectPlan;
window.setMode = setMode;
