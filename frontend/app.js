console.log("APP JS LOADED v10");

const BACKEND_BASE_URL = "http://localhost:3000";

const map = L.map("map").setView([25.033, 121.5654], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let startMarker = null;
let endMarker = null;
let routeLines = [];
let myLocation = null;
let latestRoutes = [];

L.marker([25.033, 121.5654])
  .addTo(map)
  .bindPopup("台北 101")
  .openPopup();

async function geocode(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=tw&q=" +
    encodeURIComponent(address + ", Taiwan");

  console.log("Geocoding:", url);

  const response = await fetch(url);
  const data = await response.json();

  if (!data || data.length === 0) {
    throw new Error("找不到地點：" + address);
  }

  const result = data[0];

  const lat = parseFloat(result.lat);
  const lon = parseFloat(result.lon);

  console.log("Geocode result:", {
    input: address,
    lat,
    lon,
    displayName: result.display_name
  });

  if (lat < 21 || lat > 26 || lon < 119 || lon > 123) {
    throw new Error("地點不在台灣範圍內：" + address);
  }

  return {
    lat,
    lon,
    displayName: result.display_name
  };
}

function useMyLocation() {
  if (!navigator.geolocation) {
    alert("你的瀏覽器不支援定位功能");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (position) {
      myLocation = {
        lat: position.coords.latitude,
        lon: position.coords.longitude
      };

      document.getElementById("startInput").value = "我的位置";

      if (startMarker) {
        map.removeLayer(startMarker);
      }

      startMarker = L.marker([myLocation.lat, myLocation.lon])
        .addTo(map)
        .bindPopup("我的位置")
        .openPopup();

      map.setView([myLocation.lat, myLocation.lon], 15);

      document.getElementById("status").innerHTML =
        "已取得目前位置。請輸入終點後按「規劃風險路線」。";
    },
    function () {
      alert("無法取得目前位置，請確認瀏覽器定位權限。");
    }
  );
}

function clearRoutes() {
  routeLines.forEach(function (line) {
    map.removeLayer(line);
  });

  routeLines = [];
  latestRoutes = [];

  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }

  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }

  document.getElementById("routeList").innerHTML = "";
  document.getElementById("recommendationBox").innerHTML = "";
  document.getElementById("status").innerHTML = "已清除路線。";
}

function clearOnlyMapRoutes() {
  routeLines.forEach(function (line) {
    map.removeLayer(line);
  });

  routeLines = [];

  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }

  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }
}

async function calculateRoute() {
  try {
    const startText = document.getElementById("startInput").value.trim();
    const endText = document.getElementById("endInput").value.trim();

    if (!startText || !endText) {
      alert("請輸入起點和終點");
      return;
    }

    document.getElementById("status").innerHTML = "正在搜尋地點與規劃路線...";
    document.getElementById("routeList").innerHTML = "";
    document.getElementById("recommendationBox").innerHTML = "";

    let startPoint;

    if (startText === "我的位置") {
      if (!myLocation) {
        alert("請先按「使用我的位置當起點」");
        return;
      }

      startPoint = myLocation;
    } else {
      startPoint = await geocode(startText);
    }

    const endPoint = await geocode(endText);

    console.log("Final startPoint:", startPoint);
    console.log("Final endPoint:", endPoint);

    clearOnlyMapRoutes();

    startMarker = L.marker([startPoint.lat, startPoint.lon])
      .addTo(map)
      .bindPopup("起點：" + startText);

    endMarker = L.marker([endPoint.lat, endPoint.lon])
      .addTo(map)
      .bindPopup("終點：" + endText);

    const params = new URLSearchParams({
      startLon: startPoint.lon,
      startLat: startPoint.lat,
      endLon: endPoint.lon,
      endLat: endPoint.lat
    });

    const routeUrl = BACKEND_BASE_URL + "/api/route?" + params.toString();

    console.log("Calling backend:", routeUrl);

    const routeResponse = await fetch(routeUrl);
    const routeData = await routeResponse.json();

    console.log("Backend routeData:", routeData);

    if (!routeResponse.ok) {
      console.error("Backend route error detail:", routeData);

      throw new Error(
        (routeData.error || "Backend route API error") +
          "：" +
          JSON.stringify(routeData.detail || routeData)
      );
    }

    if (!routeData.routes || routeData.routes.length === 0) {
      throw new Error("找不到可用路線");
    }

    latestRoutes = routeData.routes;

    drawAllRoutes(routeData.routes);
    renderRecommendation(routeData.recommendation, routeData.traffic);
    renderRouteCards(routeData.routes);

    document.getElementById("status").innerHTML =
      "路線規劃完成。點選下方 Route 卡片可以切換地圖上的重點路線。";
  } catch (error) {
    console.error("calculateRoute error:", error);

    document.getElementById("status").innerHTML =
      "<span style='color:red;'>錯誤：" + error.message + "</span><br>" +
      "<span style='font-size:12px;'>請確認：Backend localhost:3000 與 OSRM localhost:5000 都有開，且地點座標在台灣道路上。</span>";
  }
}

function drawAllRoutes(routes) {
  routes.forEach(function (route, index) {
    if (
      !route.geometry ||
      !route.geometry.coordinates ||
      !Array.isArray(route.geometry.coordinates)
    ) {
      console.warn("Invalid route geometry:", route);
      return;
    }

    const routeCoordinates = route.geometry.coordinates
      .map(function (coord) {
        return [coord[1], coord[0]];
      })
      .filter(function (coord) {
        return Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
      });

    if (routeCoordinates.length < 2) {
      console.warn("Route has not enough valid coordinates:", route);
      return;
    }

    const line = L.polyline(routeCoordinates, {
      weight: index === 0 ? 6 : 4,
      opacity: index === 0 ? 0.9 : 0.45
    }).addTo(map);

    line.bindPopup(
      route.label +
        "<br>Base OSRM: " + route.baseOsrmMin + " min" +
        "<br>Traffic-adjusted: " + route.expectedMin + " min" +
        "<br>Worst 10%: " + route.worst10Min + " min" +
        "<br>Traffic: " + route.trafficLevel +
        "<br>Factor: ×" + route.trafficFactor +
        "<br>Stability: " + route.stabilityScore + "/100"
    );

    routeLines.push(line);
  });

  if (routeLines.length > 0) {
    map.fitBounds(routeLines[0].getBounds());
  }

  selectRoute(0);
}

function selectRoute(selectedIndex) {
  routeLines.forEach(function (line, index) {
    line.setStyle({
      weight: index === selectedIndex ? 7 : 4,
      opacity: index === selectedIndex ? 1 : 0.3
    });
  });

  const cards = document.querySelectorAll(".routeCard");
  cards.forEach(function (card, index) {
    if (index === selectedIndex) {
      card.classList.add("selected");
    } else {
      card.classList.remove("selected");
    }
  });

  if (routeLines[selectedIndex]) {
    map.fitBounds(routeLines[selectedIndex].getBounds());
  }
}

function renderRecommendation(recommendation, traffic) {
  if (!recommendation) {
    return;
  }

  let trafficHtml = "";

  if (traffic) {
    trafficHtml =
      "<br><br>" +
      "<b>目前交通修正：</b>" + traffic.level + "<br>" +
      "Traffic Factor：×" + traffic.factor + "<br>" +
      "<span style='font-size:12px; color:#555;'>" + traffic.description + "</span>";
  }

  document.getElementById("recommendationBox").innerHTML =
    "<div class='recommendBox'>" +
      "<b>系統推薦：" + recommendation.label + "</b><br>" +
      "類型：" + recommendation.routeType + "<br>" +
      "原因：" + recommendation.reason +
      trafficHtml +
    "</div>";
}

function renderRouteCards(routes) {
  let html = "";

  routes.forEach(function (route, index) {
    html +=
      "<div class='routeCard' onclick='selectRoute(" + index + ")'>" +
        "<div class='routeTitle'>" +
          "<span>" + route.label + "</span>" +
          "<span class='badge'>" + route.routeType + "</span>" +
        "</div>" +

        "<div class='metric'><b>Base OSRM Time：</b>" + route.baseOsrmMin + " 分鐘</div>" +
        "<div class='trafficMetric'><b>Traffic-adjusted Expected：</b>" + route.expectedMin + " 分鐘</div>" +
        "<div class='metric'><b>Worst 10%：</b>" + route.worst10Min + " 分鐘</div>" +
        "<div class='trafficMetric'><b>Traffic Level：</b>" + route.trafficLevel + "</div>" +
        "<div class='trafficMetric'><b>Traffic Factor：</b>×" + route.trafficFactor + "</div>" +
        "<div class='metric'><b>Distance：</b>" + route.distanceKm + " 公里</div>" +
        "<div class='metric'><b>Variance：</b>" + route.variance + "</div>" +
        "<div class='metric'><b>Stability：</b>" + route.stabilityLevel + " (" + route.stabilityScore + "/100)</div>" +
        "<div class='metric'><b>Risk Factor：</b>" + route.riskFactor + "</div>" +
      "</div>";
  });

  document.getElementById("routeList").innerHTML = html;
}