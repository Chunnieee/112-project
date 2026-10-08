// app.js — pedestrian-safety-lab frontend.
// Plain vanilla JS + Leaflet (no build step), same library/CDN as the
// full 112-project frontend, kept deliberately small since this lab's
// job is data inspection, not a polished navigation UI.

const map = L.map("map").setView([25.0375, 121.5637], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

let startMarker = null;
let endMarker = null;
let pointMarker = null;
let pointRadiusCircle = null;
let resultLayer = L.layerGroup().addTo(map);

// -----------------------------------------------------------------------
// Route result layers: real road geometry + buffer band + every data
// point inside the buffer. Canvas renderer keeps thousands of streetlight
// dots smooth.
// -----------------------------------------------------------------------
const canvasRenderer = L.canvas({ padding: 0.5 });
let routeLayers = null;   // { corridor, route, accidents, stores, streetlights }
let routeLayerControl = null;

function clearRouteLayers() {
  if (routeLayers) Object.values(routeLayers).forEach((l) => map.removeLayer(l));
  if (routeLayerControl) map.removeControl(routeLayerControl);
  routeLayers = null;
  routeLayerControl = null;
  streetlightLayer = null;
}

// Leaflet line widths are in pixels; convert the buffer radius (meters)
// to pixels at the current zoom so the band shows the real search width.
function metersToPixels(meters, lat) {
  const metersPerPixel = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom() + 8);
  return meters / metersPerPixel;
}
let corridorState = null; // { line, radius, lat }
let streetlightLayer = null;
// Streetlight dot radius in pixels: bigger when zoomed in, never tiny.
function lightRadius(zoom) {
  return zoom >= 18 ? 6 : zoom >= 17 ? 5 : zoom >= 16 ? 4.5 : zoom >= 15 ? 3.5 : 3;
}
// Glow halo only when zoomed in enough to tell lamps apart (zoomed out, the
// halos of a dense street would merge into one yellow smear).
const haloRadius = (zoom) => (zoom >= 15 ? lightRadius(zoom) * 2.4 : 0);
map.on("zoomend", () => {
  if (corridorState) corridorState.line.setStyle({ weight: metersToPixels(corridorState.radius * 2, corridorState.lat) });
  if (streetlightLayer) {
    const r = lightRadius(map.getZoom());
    streetlightLayer.eachLayer((m) => m.setRadius(m.options.lightHalo ? haloRadius(map.getZoom()) : r));
  }
});

function drawRouteLayers(
  layers,
  bufferRadius,
  { color = "#1d4ed8", fit = true, label = "實際步行路線", accidentLabel = "行人事故", showStores = true, legs = null, autoRange = false } = {}
) {
  clearRouteLayers();
  if (!layers || !layers.routeGeometry || layers.routeGeometry.length < 2) return;

  const geom = layers.routeGeometry;
  const midLat = geom[Math.floor(geom.length / 2)][0];

  // Fit first so the corridor width is computed for the final zoom.
  if (fit) {
    map.stop();
    map.fitBounds(L.latLngBounds(geom), { padding: [50, 50], animate: false });
  }

  // Transit: the buffer only surrounds the walking legs (rides aren't scored).
  const corridorGeom = legs ? legs.filter((l) => l.type === "walk").map((l) => l.geometry) : geom;
  const corridor = L.polyline(corridorGeom, {
    color: "#60a5fa", opacity: 0.18, lineCap: "round", lineJoin: "round",
    weight: metersToPixels(bufferRadius * 2, midLat), interactive: false,
  });
  corridorState = { line: corridor, radius: bufferRadius, lat: midLat };

  const route = legs
    ? L.featureGroup(
        legs.flatMap((l) => {
          if (l.type === "walk") {
            return [L.polyline(l.geometry, { color, weight: 5, opacity: 0.95 })
              .bindTooltip(`步行 ${l.distanceMeters} m${l.durationSeconds ? `,約 ${Math.round(l.durationSeconds / 60)} 分` : ""}`, { sticky: true })];
          }
          const name = `${l.modeLabel}${l.name ? " " + l.name : ""}`;
          return [
            L.polyline(l.geometry, { color: "#0f172a", weight: 6, opacity: 0.85, dashArray: l.geometrySource === "straight" ? "2 10" : "10 6" })
              .bindTooltip(`${name}${l.from || l.to ? `(${l.from || "?"} → ${l.to || "?"})` : ""}`, { sticky: true }),
            ...[l.geometry[0], l.geometry[l.geometry.length - 1]].map((p, k) =>
              L.circleMarker(p, { radius: 6, color: "#0f172a", weight: 2, fillColor: "#fff", fillOpacity: 1 })
                .bindTooltip(`${k === 0 ? "上車" : "下車"}:${(k === 0 ? l.from : l.to) || name}`)),
          ];
        })
      )
    : L.polyline(geom, { color, weight: 6, opacity: 0.95 }).bindTooltip(label, { sticky: true });

  // Streetlights: bright amber dot with a dark outline plus a soft "glow"
  // halo, sized by zoom (see lightRadius) so they stay visible on top of the
  // corridor band and the base map. Still on the canvas renderer, which
  // handles thousands of them.
  const lightZoom = map.getZoom();
  const streetlights = L.layerGroup(
    (layers.streetlights || []).flatMap(([lat, lon, d]) => [
      L.circleMarker([lat, lon], {
        renderer: canvasRenderer, radius: haloRadius(lightZoom), stroke: false,
        fillColor: "#fde047", fillOpacity: 0.28, interactive: false, lightHalo: true,
      }),
      L.circleMarker([lat, lon], {
        renderer: canvasRenderer, radius: lightRadius(lightZoom), color: "#92400e", weight: 1.2,
        fillColor: "#facc15", fillOpacity: 1, lightDot: true,
      }).bindPopup(`💡 路燈<br>距路線 ${d} m<br>${lat}, ${lon}`),
    ])
  );
  streetlightLayer = streetlights;
  const stores = L.layerGroup(
    (layers.stores || []).map((s) =>
      L.circleMarker([s.latitude, s.longitude], {
        renderer: canvasRenderer, radius: 6, color: "#fff", weight: 1.5,
        fillColor: "#16a34a", fillOpacity: 1,
      }).bindPopup(`<b>${escapeHtml(s.store_type)} ${escapeHtml(s.name || "")}</b><br>${escapeHtml(s.address || "")}<br>距路線 ${s.distanceMeters} m`))
  );
  const accidents = L.layerGroup(
    (layers.accidents || []).map((a) =>
      L.circleMarker([a.latitude, a.longitude], {
        renderer: canvasRenderer, radius: 6, color: "#fff", weight: 1.5,
        fillColor: "#dc2626", fillOpacity: 1,
      }).bindPopup(`<b>行人事故 ${escapeHtml(a.date || "")}</b><br>${escapeHtml(a.location || "")}<br>${escapeHtml(a.severity || "")}<br>距路線 ${a.distanceMeters} m`))
  );

  routeLayers = { corridor, route, streetlights, stores, accidents };
  [corridor, route, streetlights, accidents].concat(showStores ? [stores] : []).forEach((l) => l.addTo(map));

  const n = (arr) => (arr || []).length;
  routeLayerControl = L.control.layers(null, {
    [`<span class="lg" style="background:#60a5fa;opacity:.5"></span>${legs ? "步行段" : ""}${autoRange ? `資料範圍(自動判定,平均約 ${bufferRadius} m)` : `緩衝範圍 ${bufferRadius} m`}`]: corridor,
    [`<span class="lg" style="background:${color}"></span>${escapeHtml(label)}`]: route,
    [`<span class="lg round" style="background:#dc2626"></span>${escapeHtml(accidentLabel)} (${n(layers.accidents)})`]: accidents,
    ...(showStores ? { [`<span class="lg round" style="background:#16a34a"></span>便利商店 (${n(layers.stores)})`]: stores } : {}),
    [`<span class="lg round" style="background:#facc15;border:1.5px solid #92400e;box-shadow:0 0 0 3px rgba(253,224,71,.45)"></span>路燈 (${n(layers.streetlights)})`]: streetlights,
  }, { collapsed: false, position: "bottomleft" }).addTo(map);
}

function fmt(n, digits = 1) {
  if (n === null || n === undefined) return "無資料";
  return Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "-";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// -----------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------
fetch("/api/health")
  .then((r) => r.json())
  .then((data) => {
    const c = data.datasetCounts;
    const cov = data.coverage || {};
    document.getElementById("healthLine").textContent =
      `事故 ${c.accidents.toLocaleString()} 筆(${cov.accidents}) ・ ` +
      `路燈 ${c.streetlights.toLocaleString()} 盞(${cov.streetlights}) ・ ` +
      `便利商店 ${c.stores.toLocaleString()} 家(${cov.stores})`;
  })
  .catch(() => {
    document.getElementById("healthLine").textContent = "連線失敗 — 伺服器是否已啟動？(npm start)";
  });

// -----------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------
let activeTab = "route";
document.querySelectorAll(".tabBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tabBtn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tabPanel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + activeTab));
    updateMapHint();
  });
});

function updateMapHint() {
  const hint = document.getElementById("mapHint");
  if (activeTab === "route") {
    hint.textContent = "在右邊輸入或說出起點/終點(也可以點地圖:第一下起點、第二下終點)";
  } else if (activeTab === "point") {
    hint.textContent = "在右邊輸入或說出地點(也可以直接點地圖)";
  } else {
    hint.textContent = "";
  }
}
updateMapHint();

function parseLatLon(text) {
  const m = String(text || "").trim().match(/^(-?\d+(\.\d+)?)\s*[,，]\s*(-?\d+(\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// -----------------------------------------------------------------------
// Place fields: type a place name / address / "lat,lon", or speak it.
// Each field remembers the coordinates it resolved to, so the user can
// keep a friendly name ("台北車站") in the box.
// -----------------------------------------------------------------------
const MARKER_TITLES = { start: "起點", end: "終點", point: "查詢點" };
const fields = {};
const vias = []; // waypoint fields, in order (start → vias… → end)
const MAX_VIAS = 5;

function markerTitle(f) {
  return f.key.startsWith("via") ? `中途點${vias.indexOf(f) + 1}` : MARKER_TITLES[f.key];
}

// Wires up one place box (text / Enter / 🔍 / 🎤). Used for 起點, 終點,
// 查詢點 and every 中途點 added later.
function registerField(el, key) {
  const f = {
    key,
    el,
    input: el.querySelector("input"),
    status: el.querySelector(".placeStatus"),
    list: el.querySelector(".placeResults"),
    micBtn: el.querySelector(".micBtn"),
    resolved: null, // { lat, lon, label }
    marker: null,
    searchSeq: 0,
  };
  f.input.addEventListener("input", () => clearResolved(f));
  f.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      searchPlace(f);
    }
  });
  el.querySelector(".searchBtn").addEventListener("click", () => searchPlace(f));
  const speechOk = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!speechOk) {
    f.micBtn.disabled = true;
    f.micBtn.title = "這個瀏覽器不支援語音輸入,請改用 Chrome 或 Edge";
  }
  f.micBtn.addEventListener("click", () => {
    if (!speechOk) return;
    setStatus(f, "🎤 請說出地點...");
    listen({
      button: f.micBtn,
      onInterim: (t) => { f.input.value = t; },
      onFinal: (t) => {
        f.input.value = t;
        clearResolved(f);
        searchPlace(f);
      },
      onError: (msg) => setStatus(f, msg, "err"),
    });
  });
  return f;
}

document.querySelectorAll(".placeField").forEach((el) => {
  fields[el.dataset.field] = registerField(el, el.dataset.field);
});

function setStatus(f, text, cls = "") {
  f.status.textContent = text;
  f.status.className = "placeStatus" + (cls ? " " + cls : "");
}

function closeList(f) {
  f.list.classList.remove("open");
  f.list.innerHTML = "";
}

function setResolved(f, place, { pan = true } = {}) {
  f.resolved = { lat: place.lat, lon: place.lon, label: place.label || place.name || "" };
  if (f.marker) map.removeLayer(f.marker);
  f.marker = f.key.startsWith("via")
    ? L.marker([place.lat, place.lon], {
        title: markerTitle(f),
        icon: L.divIcon({ className: "viaIcon", html: String(vias.indexOf(f) + 1), iconSize: [24, 24] }),
        zIndexOffset: 1000, // keep stops above the route-name labels
      })
    : L.marker([place.lat, place.lon], { title: markerTitle(f), zIndexOffset: 1000 });
  f.marker.bindTooltip(markerTitle(f), { permanent: false }).addTo(map);
  if (f.key === "start") startMarker = f.marker;
  if (f.key === "end") endMarker = f.marker;
  if (f.key === "point") pointMarker = f.marker;

  if (place.source === "keep") return; // renumbering only: marker refreshed, keep status/view
  const coordText = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
  const label = place.source === "coordinates" ? coordText : `${f.resolved.label}(${coordText})`;
  setStatus(f, (place.approximate ? "⚠ 只找到路段,位置是近似的:" : "✓ ") + label, place.approximate ? "warn" : "ok");

  if (pan) {
    const s = fields.start?.resolved;
    const e = fields.end?.resolved;
    if (f.key !== "point" && s && e) {
      const pts = [s, ...vias.map((v) => v.resolved).filter(Boolean), e].map((p) => [p.lat, p.lon]);
      map.fitBounds(pts, { padding: [60, 60] });
    } else {
      map.setView([place.lat, place.lon], Math.max(map.getZoom(), 15));
    }
  }
}

function clearResolved(f) {
  f.resolved = null;
  f.searchSeq++;
  setStatus(f, "");
  closeList(f);
}

// Look the text up on the server; auto-pick the best match, and list the
// rest so the user can switch if the first one is wrong.
async function searchPlace(f, { pan = true } = {}) {
  const q = f.input.value.trim();
  closeList(f);
  if (!q) {
    setStatus(f, "請輸入地點", "err");
    return null;
  }
  const coords = parseLatLon(q);
  if (coords) {
    setResolved(f, { ...coords, source: "coordinates" }, { pan });
    return f.resolved;
  }

  const seq = ++f.searchSeq;
  setStatus(f, "搜尋「" + q + "」中...");
  try {
    // Bias the search toward the other end of the trip, if it's already known.
    const other = neighborOf(f);
    const nearParam = other ? `&near=${other.lat.toFixed(5)},${other.lon.toFixed(5)}` : "";
    const res = await fetch("/api/geocode?q=" + encodeURIComponent(q) + nearParam);
    const data = await res.json();
    if (seq !== f.searchSeq) return f.resolved; // user typed something newer meanwhile
    if (data.status !== "ok" || !data.results?.length) {
      setStatus(f, data.error || "找不到這個地點", "err");
      return null;
    }
    setResolved(f, { ...data.results[0], approximate: data.approximate }, { pan });
    if (data.warning) setStatus(f, "⚠ " + data.warning + ":" + (f.resolved.label || ""), "warn");
    if (data.results.length > 1) {
      f.list.innerHTML =
        "<li class='listHead'><small>不是這個?從下面選:</small></li>" +
        data.results
          .map((r, i) =>
            `<li data-i="${i}">${escapeHtml(r.name || r.label)}<small>${escapeHtml(r.label || "")}</small></li>`)
          .join("");
      f.list.classList.add("open");
      f.list.querySelectorAll("li[data-i]").forEach((li) => {
        li.addEventListener("click", () => {
          setResolved(f, { ...data.results[Number(li.dataset.i)], approximate: data.approximate });
          closeList(f);
        });
      });
    }
    return f.resolved;
  } catch (err) {
    if (seq === f.searchSeq) setStatus(f, "搜尋失敗:" + err.message, "err");
    return null;
  }
}

// The closest already-known stop in trip order (start → vias → end), used to
// bias the search: a 中途點 or 終點 is most likely near the previous stop.
function neighborOf(f) {
  if (f.key === "point") return null;
  const order = [fields.start, ...vias, fields.end];
  const i = order.indexOf(f);
  for (let d = 1; d < order.length; d++) {
    for (const j of [i - d, i + d]) {
      if (j >= 0 && j < order.length && order[j].resolved) return order[j].resolved;
    }
  }
  return null;
}

// Returns coordinates for a field, looking the text up first if needed.
async function resolveField(f) {
  if (f.resolved) return f.resolved;
  return searchPlace(f, { pan: false }); // the route drawing will fit the view
}


// -----------------------------------------------------------------------
// Voice input (Web Speech API — works in Chrome / Edge / Safari; needs
// http://localhost or https, and microphone permission).
// -----------------------------------------------------------------------
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognition = null;

function listen({ button, onInterim, onFinal, onError }) {
  if (activeRecognition) {
    activeRecognition.abort();
    return;
  }
  const rec = new SpeechRecognitionImpl();
  rec.lang = "zh-TW";
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  activeRecognition = rec;
  button.classList.add("listening");

  let finalText = "";
  rec.onresult = (e) => {
    let text = "";
    for (const r of e.results) text += r[0].transcript;
    if (e.results[e.results.length - 1].isFinal) finalText = text;
    onInterim(text);
  };
  rec.onerror = (e) => {
    const msg = {
      "not-allowed": "麥克風權限被拒絕,請在網址列左邊允許使用麥克風",
      "service-not-allowed": "瀏覽器不允許語音辨識(需要用 http://localhost 或 https 開啟)",
      "no-speech": "沒有聽到聲音,再試一次",
      "audio-capture": "找不到麥克風",
      network: "語音辨識需要網路連線",
      aborted: "",
    }[e.error] ?? "語音辨識錯誤:" + e.error;
    if (msg) onError(msg);
  };
  rec.onend = () => {
    button.classList.remove("listening");
    activeRecognition = null;
    const t = finalText.trim().replace(/[。．.!！?？,，\s]+$/, "");
    if (t) onFinal(t);
  };
  rec.start();
}

if (!SpeechRecognitionImpl) {
  document.querySelectorAll(".micBtn, #voiceBothBtn").forEach((b) => {
    b.disabled = true;
    b.title = "這個瀏覽器不支援語音輸入,請改用 Chrome 或 Edge";
  });
  document.getElementById("voiceBothStatus").textContent = "(這個瀏覽器不支援語音輸入,請改用 Chrome 或 Edge;打字一樣可以用)";
}

// "從台北車站走到台北101"            -> { from: "台北車站", vias: [], to: "台北101" }
// "從這裡經過西門町和龍山寺到台北車站" -> { from: HERE, vias: ["西門町","龍山寺"], to: "台北車站" }
const HERE = Symbol("current-location");
const HERE_WORDS = /^(這裡|這邊|我這裡|我這邊|我現在的位置|我目前的位置|目前位置|現在位置|我的位置|我家這裡)$/;
function parseFromTo(text) {
  const t = text
    .replace(/\s+/g, "")
    .replace(/[。．.!！?？]+$/, "")
    .replace(/先到/g, "先去") // so "先到B再到C" isn't split at the first 到
    .replace(/再去/g, "再到");
  const m = t.match(/^(?:我要|我想|請問)?(?:從|由)?(.+?)(?:走路|步行|走)?(?:(?<!先)到|(?<!先)去|至|往)(.+)$/);
  if (!m) return null;
  let from = m[1];
  let vias = [];
  // "A經過B、C" / "A經由B" / "A途經B" / "A先去B再" → waypoints
  const v = from.match(/^(.+?)(?:經過|經由|途經|順路經過|中途經過|先去|先到)(.+?)(?:再)?$/);
  if (v) {
    from = v[1];
    vias = v[2].split(/、|,|，|和|跟|還有|然後/).map((x) => x.replace(/^(再|先)/, "")).filter(Boolean);
  }
  const to = m[2].replace(/(怎麼走|要怎麼走|的路線|安不安全|安全嗎|嗎)$/, "");
  if (!from || !to) return null;
  return { from: HERE_WORDS.test(from) ? HERE : from, vias: vias.slice(0, MAX_VIAS), to };
}

const voiceBothBtn = document.getElementById("voiceBothBtn");
const voiceBothStatus = document.getElementById("voiceBothStatus");
voiceBothBtn.addEventListener("click", () => {
  if (!SpeechRecognitionImpl) return;
  voiceBothStatus.textContent = "🎤 請說:「從 ___ 到 ___」(可加「經過 ___」,起點可以說「這裡」)";
  listen({
    button: voiceBothBtn,
    onInterim: (t) => { voiceBothStatus.textContent = "🎤 " + t; },
    onFinal: async (t) => {
      const parsed = parseFromTo(t);
      if (!parsed) {
        voiceBothStatus.textContent = `聽到「${t}」,但分不出起點和終點。請說「從 A 到 B」(可加「經過 C」),或用各欄位旁邊的 🎤 分開說。`;
        return;
      }
      const fromText = parsed.from === HERE ? "目前位置" : parsed.from;
      voiceBothStatus.textContent =
        `聽到:從「${fromText}」` + (parsed.vias.length ? `經過「${parsed.vias.join("、")}」` : "") + `到「${parsed.to}」`;
      // Reset waypoints to exactly what was said.
      while (vias.length) removeVia(vias[vias.length - 1]);
      parsed.vias.forEach((name) => addVia(name));
      fields.end.input.value = parsed.to;
      clearResolved(fields.end);
      let s;
      if (parsed.from === HERE) {
        s = await locateMe();
      } else {
        fields.start.input.value = parsed.from;
        clearResolved(fields.start);
        s = await searchPlace(fields.start, { pan: false });
      }
      let ok = Boolean(s);
      for (const v of vias) ok = Boolean(await searchPlace(v, { pan: false })) && ok;
      const e = await searchPlace(fields.end, { pan: false });
      if (ok && e) document.getElementById("runRouteBtn").click();
    },
    onError: (msg) => { voiceBothStatus.textContent = msg; },
  });
});

// -----------------------------------------------------------------------
// Waypoints (中途點)
// -----------------------------------------------------------------------
const viaList = document.getElementById("viaList");
const addViaBtn = document.getElementById("addViaBtn");
const viaTemplate = document.getElementById("viaTemplate");
let viaSeq = 0;

function renumberVias() {
  vias.forEach((v, i) => {
    v.el.querySelector(".viaLabel").textContent = `中途點 ${i + 1}`;
    if (v.marker && v.resolved) setResolved(v, { ...v.resolved, source: "keep" }, { pan: false });
    if (v.resolved) setStatus(v, "✓ " + v.resolved.label, "ok");
  });
  addViaBtn.disabled = vias.length >= MAX_VIAS;
  addViaBtn.textContent = vias.length >= MAX_VIAS ? `中途點最多 ${MAX_VIAS} 個` : "＋ 新增中途點";
}

function addVia(text = "") {
  if (vias.length >= MAX_VIAS) return null;
  const el = viaTemplate.content.firstElementChild.cloneNode(true);
  viaList.appendChild(el);
  const f = registerField(el, `via${++viaSeq}`);
  vias.push(f);
  el.querySelector(".removeViaBtn").addEventListener("click", () => removeVia(f));
  f.input.value = text;
  renumberVias();
  if (!text) f.input.focus();
  return f;
}

function removeVia(f) {
  const i = vias.indexOf(f);
  if (i < 0) return;
  if (f.marker) map.removeLayer(f.marker);
  f.el.remove();
  vias.splice(i, 1);
  renumberVias();
}

addViaBtn.addEventListener("click", () => addVia());

// -----------------------------------------------------------------------
// 📍 Current location as the start point
// -----------------------------------------------------------------------
const locateBtn = document.getElementById("locateBtn");

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("這個瀏覽器不支援定位"));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 60000,
    });
  });
}

async function locateMe() {
  const f = fields.start;
  clearResolved(f);
  f.input.value = "目前位置";
  setStatus(f, "📍 定位中...(第一次會詢問是否允許存取位置)");
  locateBtn.classList.add("listening");
  try {
    const pos = await getPosition();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const acc = Math.round(pos.coords.accuracy || 0);
    setResolved(f, { lat, lon, label: "目前位置", source: "geolocation" }, { pan: true });
    const accText = acc ? `(精確度約 ±${acc} 公尺)` : "";
    setStatus(f, `✓ 目前位置 ${lat.toFixed(5)}, ${lon.toFixed(5)}${accText}`, acc > 500 ? "warn" : "ok");
    if (acc > 500) {
      setStatus(f, `⚠ 定位不太準(±${acc} 公尺,電腦通常只能用 Wi-Fi 估計位置)。建議看一下地圖上的起點對不對,不對的話直接輸入起點。`, "warn");
    }
    // Look up a readable address for the label (best effort).
    fetch(`/api/reverse?lat=${lat}&lon=${lon}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.label && f.resolved && f.resolved.lat === lat && f.resolved.lon === lon) {
          f.resolved.label = `目前位置:${d.label}`;
          f.input.value = `目前位置:${d.label}`;
          if (acc <= 500) setStatus(f, `✓ ${d.label}${accText}`, "ok");
        }
      })
      .catch(() => {});
    return f.resolved;
  } catch (err) {
    const msg =
      err.code === 1 ? "沒有定位權限:請在網址列左邊允許「位置」,或到 Windows 設定 → 隱私權 → 位置 開啟定位服務" :
      err.code === 2 ? "目前無法取得位置(電腦沒有 GPS,也找不到 Wi-Fi 定位)" :
      err.code === 3 ? "定位逾時,請再試一次" :
      "定位失敗:" + err.message;
    f.input.value = "";
    setStatus(f, msg, "err");
    return null;
  } finally {
    locateBtn.classList.remove("listening");
  }
}

locateBtn.addEventListener("click", () => locateMe());

// -----------------------------------------------------------------------
// Map click still works as a fallback.
// -----------------------------------------------------------------------
map.on("click", (e) => {
  const { lat, lng } = e.latlng;
  const place = { lat, lon: lng, source: "coordinates" };
  const text = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  let f = null;
  if (activeTab === "route") {
    // 1st click = start, 2nd = end, 3rd starts over (same as before)
    f = !fields.start.resolved || fields.end.resolved ? fields.start : fields.end;
    if (f.key === "start" && fields.end.resolved) {
      clearResolved(fields.end);
      fields.end.input.value = "";
      if (fields.end.marker) { map.removeLayer(fields.end.marker); fields.end.marker = endMarker = null; }
    }
  } else if (activeTab === "point") {
    f = fields.point;
  }
  if (!f) return;
  f.input.value = text;
  clearResolved(f);
  setResolved(f, place, { pan: false });
});

// -----------------------------------------------------------------------
// Travel mode (步行 / 機車 / 開車 / 大眾運輸)
// -----------------------------------------------------------------------
// Fallback copy of the server's /api/modes (replaced by the real one on load).
let MODE_INFO = {
  walk: { label: "步行", icon: "🚶", defaultBuffer: 150, weights: { accident: 0.4, streetlight: 0.3, convenienceStore: 0.3 }, accidentNoun: "行人事故" },
  scooter: { label: "機車", icon: "🛵", defaultBuffer: 50, weights: { accident: 0.7, streetlight: 0.3, convenienceStore: 0 }, accidentNoun: "機車事故" },
  car: { label: "開車", icon: "🚗", defaultBuffer: 50, weights: { accident: 0.7, streetlight: 0.3, convenienceStore: 0 }, accidentNoun: "汽車事故" },
  transit: { label: "大眾運輸", icon: "🚇", defaultBuffer: 150, weights: { accident: 0.4, streetlight: 0.3, convenienceStore: 0.3 }, accidentNoun: "行人事故" },
};
let transitConfigured = true;
fetch("/api/modes")
  .then((r) => r.json())
  .then((d) => {
    if (d.status !== "ok") return;
    for (const m of d.modes) MODE_INFO[m.key] = m;
    transitConfigured = d.transitConfigured;
    setMode(currentMode, { keepBuffer: true });
  })
  .catch(() => {});

const MODE_NOTES = {
  walk: "步行路網;評分:行人事故 40% + 路燈 30% + 便利商店 30%(資料範圍自動判定:每筆資料歸給離它最近的道路,最遠 150 m)。",
  scooter: "汽車路網但排除國道/快速道路;評分:有機車涉入的事故 70% + 路燈 30%(資料範圍自動判定:歸給最近的車道,最遠 80 m)。",
  car: "汽車路網;評分:有汽車涉入的事故 70% + 路燈 30%(資料範圍自動判定:歸給最近的車道,最遠 80 m)。",
  transit: "TDX 路徑規劃(公車、捷運、台鐵、高鐵、輕軌…);只評「走路去搭車 / 下車走到目的地」的步行段。不支援中途點。",
};

let currentMode = "walk";
const modeIsVehicle = (m = currentMode) => m === "scooter" || m === "car";

function setMode(mode, { keepBuffer = false } = {}) {
  currentMode = mode;
  document.querySelectorAll(".modeBtn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const info = MODE_INFO[mode];
  let note = MODE_NOTES[mode];
  if (mode === "transit" && !transitConfigured) note += " ⚠ 伺服器的 .env 沒有 TDX 金鑰,大眾運輸無法使用。";
  document.getElementById("modeNote").textContent = note;
  // Waypoints: not supported for transit.
  const transit = mode === "transit";
  addViaBtn.classList.toggle("hiddenForMode", transit);
  viaList.classList.toggle("hiddenForMode", transit);
  document.getElementById("departRow").hidden = !transit;
  if (transit && !document.getElementById("departTime").value) {
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    document.getElementById("departTime").value = now.toISOString().slice(0, 16);
  }
  // Mock data only exists for walking.
  const ds = document.getElementById("dataSource");
  if (mode !== "walk") ds.value = "real";
  ds.disabled = mode !== "walk";
}

document.querySelectorAll(".modeBtn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
setMode("walk", { keepBuffer: true });

// -----------------------------------------------------------------------
// ROUTE TAB
// -----------------------------------------------------------------------
document.getElementById("runRouteBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("routeResult");
  resultEl.innerHTML = "<div class='loadingBox'>尋找起點/中途點/終點位置...</div>";
  const start = await resolveField(fields.start);
  // Empty waypoint boxes are simply ignored.
  const activeVias = currentMode === "transit" ? [] : vias.filter((v) => v.resolved || v.input.value.trim());
  const viaPoints = [];
  for (const v of activeVias) {
    const p = await resolveField(v);
    if (!p) {
      resultEl.innerHTML = `<div class='errorBox'>${escapeHtml(markerTitle(v))}找不到位置,請看輸入框下方的提示,換個說法或移除它</div>`;
      return;
    }
    viaPoints.push(p);
  }
  const end = start ? await resolveField(fields.end) : null;
  const dataSource = document.getElementById("dataSource").value;

  if (!start || !end) {
    resultEl.innerHTML = "<div class='errorBox'>起點或終點找不到位置,請看輸入框下方的提示,換個說法再試(或點地圖)</div>";
    return;
  }

  resultEl.innerHTML = `<div class='loadingBox'>規劃並比較多條${MODE_INFO[currentMode].label}路線中(約 5~20 秒)...</div>`;
  resultLayer.clearLayers();
  clearRouteLayers();
  clearComparison();

  try {
    const params = new URLSearchParams({
      startLon: String(start.lon),
      startLat: String(start.lat),
      endLon: String(end.lon),
      endLat: String(end.lat),
      dataSource,
    });
    if (viaPoints.length) params.set("via", viaPoints.map((p) => `${p.lat},${p.lon}`).join(";"));
    params.set("mode", currentMode);
    if (currentMode === "transit") {
      const dep = document.getElementById("departTime").value;
      if (dep) params.set("depart", dep.length === 16 ? dep + ":00" : dep);
    }
    const data = await fetch("/api/pedestrian-safety/compare?" + params.toString()).then((r) => r.json());

    if (data.status !== "ok") {
      resultEl.innerHTML = "<div class='errorBox'>" + escapeHtml((data.message || data.error || "失敗") + (data.detail ? ":" + data.detail : "")) + "</div>";
      return;
    }

    comparison = { data, selected: 0 };
    renderComparison(true);
    closeList(fields.start);
    closeList(fields.end);
    vias.forEach(closeList);
  } catch (err) {
    resultEl.innerHTML = "<div class='errorBox'>" + escapeHtml(err.message) + "</div>";
  }
});

// -----------------------------------------------------------------------
// Route comparison (推薦 / 備選1 / 備選2)
// -----------------------------------------------------------------------
const ROUTE_COLORS = ["#1d4ed8", "#7c3aed", "#0d9488"];
let comparison = null;          // { data, selected }
let otherRoutesLayer = null;    // unselected route lines + labels
let hotspotLayer = null;

function clearComparison() {
  if (otherRoutesLayer) map.removeLayer(otherRoutesLayer);
  if (hotspotLayer) map.removeLayer(hotspotLayer);
  otherRoutesLayer = null;
  hotspotLayer = null;
}

function selectRoute(i) {
  if (!comparison || comparison.selected === i) return;
  comparison.selected = i;
  renderComparison(false);
}

function renderComparison(fit) {
  const { data, selected } = comparison;
  // The data range is decided per route by the server (nearest-road
  // attribution); draw the band at that route's effective radius.
  const bufferRadius = (data.routes[selected] && data.routes[selected].result.bufferRadiusMeters) || data.bufferRadius || 150;
  const autoRange = data.routes[selected] && data.routes[selected].result.attribution &&
    data.routes[selected].result.attribution.method === "nearest-road";
  const routes = data.routes;
  const sel = routes[selected];

  // ---- map: selected route with its corridor + points; others as thinner lines
  clearComparison();
  if (fit) {
    const all = routes.flatMap((r) => r.mapLayers.routeGeometry);
    map.stop();
    map.fitBounds(L.latLngBounds(all), { padding: [50, 50], animate: false });
  }
  otherRoutesLayer = L.layerGroup().addTo(map);
  routes.forEach((r, i) => {
    if (i === selected) return;
    L.polyline(r.mapLayers.routeGeometry, {
      color: ROUTE_COLORS[i], weight: 5, opacity: 0.55, dashArray: "8 8",
    })
      .bindTooltip(`${r.rankLabel}(點一下切換)`, { sticky: true })
      .on("click", () => selectRoute(i))
      .addTo(otherRoutesLayer);
  });
  drawRouteLayers(sel.mapLayers, bufferRadius, {
    color: ROUTE_COLORS[selected],
    fit: false,
    label: sel.rankLabel,
    accidentLabel: data.accidentNoun || "行人事故",
    showStores: !modeIsVehicle(data.mode),
    legs: data.mode === "transit" ? sel.legs : null,
    autoRange,
  });
  // Rank labels placed at different points along each line so they don't stack
  routes.forEach((r, i) => {
    const g = r.mapLayers.routeGeometry;
    const at = g[Math.floor(g.length * (0.3 + 0.2 * i))] || g[0];
    L.marker(at, {
      interactive: true,
      icon: L.divIcon({
        className: "routeTag",
        html: `<span style="background:${ROUTE_COLORS[i]}">${escapeHtml(r.rankLabel)} ${fmt(r.metrics.finalSafetyScore)}</span>`,
        iconSize: null,
      }),
    }).on("click", () => selectRoute(i)).addTo(otherRoutesLayer);
  });
  if (sel.hotspot) {
    hotspotLayer = L.layerGroup([
      L.circle([sel.hotspot.lat, sel.hotspot.lon], {
        radius: 125, color: "#dc2626", weight: 2, dashArray: "4 4", fillOpacity: 0.06,
      }),
      L.marker([sel.hotspot.lat, sel.hotspot.lon], {
        icon: L.divIcon({ className: "hotspotIcon", html: "⚠", iconSize: [26, 26] }),
      }).bindPopup(
        `<b>這條路線事故最集中的路段</b><br>${escapeHtml(sel.hotspot.place || "")}<br>約 250 公尺內 ${sel.hotspot.accidentCount} 件行人事故(近5年)`
      ),
    ]).addTo(map);
  }

  // ---- sidebar
  const resultEl = document.getElementById("routeResult");
  resultEl.innerHTML =
    "<div class='analysisBox'><h4>比較分析</h4><ul>" +
    data.analysis.map((t) => `<li>${escapeHtml(t)}</li>`).join("") +
    "</ul><div class='scoreMeta'>" + escapeHtml(data.rankingRule) + "</div></div>" +
    "<div class='routeCards'>" + routes.map((r, i) => renderRouteCard(r, i, i === selected)).join("") + "</div>" +
    renderComparisonTable(routes, selected) +
    `<h4 class='detailHead' style='border-color:${ROUTE_COLORS[selected]}'>${escapeHtml(sel.title)} 的詳細資料</h4>` +
    renderRouteDetail(sel);

  resultEl.querySelectorAll(".routeCard, .cmpTable th[data-i]").forEach((el) => {
    el.addEventListener("click", () => selectRoute(Number(el.dataset.i)));
  });
}

const LEG_ICON = { 步行: "🚶", 公車: "🚌", 客運: "🚌", 捷運: "🚇", 輕軌: "🚊", 台鐵: "🚆", 高鐵: "🚄", 渡輪: "⛴️", 纜車: "🚡" };
function renderItinerary(legs) {
  return "<div class='itin'>" + legs.map((l) => {
    const icon = LEG_ICON[l.modeLabel] || "🚍";
    const text = l.type === "walk"
      ? `${icon} ${l.durationSeconds ? Math.max(1, Math.round(l.durationSeconds / 60)) + " 分" : l.distanceMeters + " m"}`
      : `${icon} ${escapeHtml(l.name || l.modeLabel)}`;
    return `<span class='leg${l.type === "walk" ? "" : " ride"}'>${text}</span>`;
  }).join("<span class='arrow'>›</span>") + "</div>";
}

function renderRouteCard(r, i, active) {
  const m = r.metrics;
  const bar = (label, v) =>
    v === null || v === undefined
      ? `<div class='miniBar nodata'><span>${label}</span><div></div><b>無資料</b></div>`
      : `<div class='miniBar'><span>${label}</span><div><i style='width:${Math.max(0, Math.min(100, v))}%'></i></div><b>${fmt(v)}</b></div>`;
  return (
    `<div class='routeCard${active ? " active" : ""}' data-i='${i}' style='--c:${ROUTE_COLORS[i]}'>` +
    `<div class='rcHead'><span class='rcBadge'>${escapeHtml(r.rankLabel)}</span>` +
    `<span class='rcTags'>${escapeHtml(r.title.replace(r.rankLabel, "").replace(/^[((]|[))]$/g, ""))}</span></div>` +
    `<div class='rcMain'><span class='rcScore'>${fmt(m.finalSafetyScore)}</span><span class='rcUnit'>/ 100</span>` +
    (r.legs
      ? `<span class='rcTrip'>${Math.round(r.durationSeconds / 60)} 分鐘 ・ 轉乘 ${r.transfers} 次 ・ 步行 ${r.walkingMeters} m</span></div>` +
        renderItinerary(r.legs)
      : `<span class='rcTrip'>${Math.round(r.durationSeconds / 60)} 分鐘 ・ ${(r.distanceMeters / 1000).toFixed(2)} km</span></div>`) +
    bar("事故", m.accidentScore) + bar("路燈", m.streetlightScore) +
    (modeIsVehicle(comparison.data.mode) ? "" : bar("商店", m.convenienceStoreScore)) +
    `<div class='rcWhy'>${escapeHtml(r.originReason || "")}</div>` +
    (r.result.coverage && r.result.coverage.adjusted
      ? `<div class='rcCov'>經過 ${escapeHtml(r.result.coverage.routeCounties.join("、"))}:${coverageText(r.result.coverage)}</div>`
      : "") +
    "</div>"
  );
}

function renderComparisonTable(routes, selected) {
  // [label, getter, format, higherIsBetter (null = no highlight)]
  const mode = comparison.data.mode || "walk";
  const info = MODE_INFO[mode] || MODE_INFO.walk;
  const pct = (w) => `${Math.round((w || 0) * 100)}%`;
  const noun = comparison.data.accidentNoun || info.accidentNoun;
  const vehicle = modeIsVehicle(mode);
  const transit = mode === "transit";
  let rows = [
    [transit ? "步行段安全分數" : "安全分數", (r) => r.metrics.finalSafetyScore, (v) => fmt(v), true],
    [`事故安全分數(${pct(info.weights.accident)})`, (r) => r.metrics.accidentScore, (v) => fmt(v), true],
    [`路燈分數(${pct(info.weights.streetlight)})`, (r) => r.metrics.streetlightScore, (v) => fmt(v), true],
    ...(vehicle ? [] : [[`商店分數(${pct(info.weights.convenienceStore)})`, (r) => r.metrics.convenienceStoreScore, (v) => fmt(v), true]]),
    [transit ? "全程時間" : `${info.label}時間`, (r) => r.durationSeconds, (v) => Math.round(v / 60) + " 分", false],
    ...(transit
      ? [
          ["轉乘次數", (r) => r.transfers, (v) => v + " 次", false],
          ["步行距離", (r) => r.walkingMeters, (v) => (v / 1000).toFixed(2) + " km", false],
        ]
      : [["距離", (r) => r.distanceMeters, (v) => (v / 1000).toFixed(2) + " km", false]]),
    [`${noun}(近5年)`, (r) => r.metrics.accidents, (v) => v + " 件", null],
    ["其中有人死亡", (r) => r.metrics.fatalAccidents, (v) => v + " 件", false],
    [`每公里${noun}`, (r) => r.metrics.accidentsPerKm, (v) => fmt(v) + " 件", false],
    ["每公里路燈", (r) => r.metrics.streetlightsPerKm, (v) => fmt(v, 0) + " 盞", true],
    ...(vehicle ? [] : [["每公里便利商店", (r) => r.metrics.storesPerKm, (v) => fmt(v) + " 家", true]]),
    ...(transit ? [] : [["最危險路段", (r) => (r.hotspot ? r.hotspot.accidentCount : 0), (v) => (v ? v + " 件/250m" : "無聚集"), false]]),
  ];
  // Drop rows no route has a value for (e.g. per-km figures for transit).
  rows = rows.filter(([, get]) => routes.some((r) => get(r) !== undefined && get(r) !== null));
  let html = "<table class='cmpTable'><thead><tr><th></th>" +
    routes.map((r, i) =>
      `<th data-i='${i}' class='${i === selected ? "sel" : ""}' style='color:${ROUTE_COLORS[i]}'>${escapeHtml(r.rankLabel)}</th>`).join("") +
    "</tr></thead><tbody>";
  for (const [label, get, f, higher] of rows) {
    const vals = routes.map(get);
    const nums = vals.filter((v) => v !== null && v !== undefined);
    const bestVal = higher === null || nums.length < 2 ? null : (higher ? Math.max(...nums) : Math.min(...nums));
    const worstVal = higher === null || nums.length < 2 ? null : (higher ? Math.min(...nums) : Math.max(...nums));
    const allSame = nums.every((v) => Math.abs(v - nums[0]) < 1e-9);
    html += `<tr><td>${label}</td>` + vals.map((v, i) =>
      `<td class='${i === selected ? "sel" : ""}${bestVal !== null && v !== null && !allSame && Math.abs(v - bestVal) < 1e-9 ? " best" : ""}${worstVal !== null && v !== null && !allSame && Math.abs(v - worstVal) < 1e-9 ? " worst" : ""}'>${v === null || v === undefined ? "無資料" : f(v)}</td>`).join("") + "</tr>";
  }
  return html + "</tbody></table><div class='scoreMeta'>所有「分數」都是 0–100,<b>越高越安全</b>(事故安全分數高 = 事故少)。" +
    "<span class='legendBest'>綠色</span> = 該項目在幾條路線中最好,<span class='legendWorst'>紅色</span> = 最差。</div>";
}

function coverageText(cov) {
  const label = { accident: "事故", streetlight: "路燈", convenienceStore: "便利商店" };
  return Object.entries(cov.status)
    .filter(([, v]) => v !== "full" && v !== "unused")
    .map(([k, v]) => `${label[k]}${v === "no-data" ? "無資料(不計分)" : `只涵蓋 ${Math.round(cov.fraction[k] * 100)}% 路段`}`)
    .join("、");
}

const PROFILE_TEXT = {
  foot: "真正的步行路網",
  "driving-fallback-for-walk": "汽車路網換算(時間以 4.8 km/h 估算)",
  car: "汽車路網",
  "scooter-no-motorway": "汽車路網,排除國道/快速道路",
  "scooter-car-network": "汽車路網(⚠ 未能排除國道,可能含機車不能走的路段)",
  transit: "TDX 大眾運輸路徑規劃;只評步行段",
};

function renderLegList(legs) {
  const t = (iso) => (iso ? String(iso).slice(11, 16) : "");
  return "<ul class='legList'>" + legs.map((l) => {
    const icon = LEG_ICON[l.modeLabel] || "🚍";
    const mins = l.durationSeconds ? `約 ${Math.max(1, Math.round(l.durationSeconds / 60))} 分` : "";
    if (l.type === "walk") {
      return `<li>${icon} 步行 ${l.distanceMeters} m ${mins}<small>${escapeHtml(l.to ? "走到 " + l.to : "")}</small></li>`;
    }
    return `<li>${icon} <b>${escapeHtml(l.modeLabel)} ${escapeHtml(l.name || "")}</b>${l.headsign ? `(往 ${escapeHtml(l.headsign)})` : ""} ${mins}` +
      `<small>${escapeHtml(l.from || "?")} ${t(l.departTime)} → ${escapeHtml(l.to || "?")} ${t(l.arriveTime)}` +
      `${l.geometrySource === "straight" ? "(線形未提供,地圖以直線示意)" : ""}</small></li>`;
  }).join("") + "</ul>";
}

function renderRouteDetail(route) {
  const r = route.result;
  const cov = r.coverage;
  return (
    (cov && cov.adjusted
      ? `<div class='covBox'>⚠ 這條路線經過 ${escapeHtml(cov.routeCounties.join("、"))}。${escapeHtml(coverageText(cov))}。${escapeHtml(cov.note || "")}` +
        `<br>路燈資料目前只有:${escapeHtml(cov.coveredCounties.streetlight.join("、"))}。</div>`
      : "") +
    (route.legs ? renderLegList(route.legs) : "") +
    "<div class='scoreMeta'>路線來源:" + escapeHtml(PROFILE_TEXT[route.profile] || route.profile || "-") +
    " ・ " + (r.attribution && r.attribution.method === "nearest-road"
      ? "資料範圍:自動判定(每筆資料歸給離它最近的道路,最遠 " + r.attribution.maxRadius + " m;這條路線平均約 " + r.bufferRadiusMeters + " m)"
      : "緩衝半徑 " + (r.bufferRadiusMeters || "-") + " m(道路資料暫時無法取得,改用固定範圍)") +
    " ・ 範圍面積 " + fmt(r.bufferAreaKm2, 3) + " km² ・ 事故資料 " +
    (r.accidentDataDateRange ? r.accidentDataDateRange.from + " ~ " + r.accidentDataDateRange.to : "-") + "</div>" +
    "<div class='scoreMeta'>地圖上畫出這條路線計分用到的全部資料點(離隔壁道路比較近的不算);下面表格只列離路線最近的 40 筆。</div>" +
    "<h4>附近" + escapeHtml(comparison.data.accidentNoun || "事故") + "(" + r.pedestrianAccidents + " 筆,表格列出 " + (r.nearbyAccidentPoints || []).length + " 筆)</h4>" +
    renderAccidentTable(r.nearbyAccidentPoints || []) +
    "<h4>附近路燈(" + r.streetlights + " 筆,表格列出 " + (r.nearbyStreetlightPoints || []).length + " 筆)</h4>" +
    renderStreetlightTable(r.nearbyStreetlightPoints || []) +
    (modeIsVehicle(comparison.data.mode)
      ? ""
      : "<h4>附近便利商店(" + r.convenienceStores + " 筆,表格列出 " + (r.nearbyStorePoints || []).length + " 筆)</h4>" +
        renderStoreTable(r.nearbyStorePoints || []))
  );
}

function renderAccidentTable(points) {
  if (!points.length) return "<div class='emptyNote'>(無資料)</div>";
  let html = "<table class='dataTable'><thead><tr><th>日期</th><th>地點</th><th>傷亡</th><th>距離(m)</th></tr></thead><tbody>";
  for (const a of points) {
    html += `<tr><td>${escapeHtml(a.date)}</td><td>${escapeHtml(a.location || "")}</td><td>${escapeHtml(a.severity || "")}</td><td>${a.distanceMeters}</td></tr>`;
  }
  return html + "</tbody></table>";
}

function renderStreetlightTable(points) {
  if (!points.length) return "<div class='emptyNote'>(無資料)</div>";
  let html = "<table class='dataTable'><thead><tr><th>緯度</th><th>經度</th><th>距離(m)</th></tr></thead><tbody>";
  for (const s of points) {
    html += `<tr><td>${s.latitude}</td><td>${s.longitude}</td><td>${s.distanceMeters}</td></tr>`;
  }
  return html + "</tbody></table>";
}

function renderStoreTable(points) {
  if (!points.length) return "<div class='emptyNote'>(無資料)</div>";
  let html = "<table class='dataTable'><thead><tr><th>品牌</th><th>名稱</th><th>地址</th><th>距離(m)</th></tr></thead><tbody>";
  for (const s of points) {
    html += `<tr><td>${escapeHtml(s.store_type)}</td><td>${escapeHtml(s.name || "")}</td><td>${escapeHtml(s.address || "")}</td><td>${s.distanceMeters}</td></tr>`;
  }
  return html + "</tbody></table>";
}

// -----------------------------------------------------------------------
// POINT (RAW DATA INSPECTOR) TAB
// -----------------------------------------------------------------------
document.getElementById("runPointBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("pointResult");
  resultEl.innerHTML = "<div class='loadingBox'>尋找地點位置...</div>";
  const point = await resolveField(fields.point);
  const radius = Number(document.getElementById("pointRadius").value) || 150;
  const type = document.getElementById("pointType").value;

  if (!point) {
    resultEl.innerHTML = "<div class='errorBox'>找不到這個地點,請看輸入框下方的提示,換個說法再試(或點地圖)</div>";
    return;
  }

  resultEl.innerHTML = "<div class='loadingBox'>查詢中...</div>";
  resultLayer.clearLayers();
  clearRouteLayers();
  clearComparison();

  try {
    const params = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon), radius: String(radius), type });
    const data = await fetch("/api/nearby?" + params.toString()).then((r) => r.json());

    if (data.status !== "ok") {
      resultEl.innerHTML = "<div class='errorBox'>" + escapeHtml(data.error || "失敗") + "</div>";
      return;
    }

    let table;
    if (type === "accidents" || type === "scooterAccidents" || type === "carAccidents") table = renderAccidentTable(data.matches);
    else if (type === "streetlights") table = renderStreetlightTable(data.matches);
    else table = renderStoreTable(data.matches);

    resultEl.innerHTML =
      (data.hasData === false
        ? `<div class='covBox'>⚠ ${escapeHtml(data.county || "這個位置")}沒有這種資料,所以 0 筆不代表真的沒有。</div>`
        : "") +
      `<div class='scoreMeta'>${escapeHtml(data.county || "")} ・ 半徑 ${radius} 公尺內共 ${data.matchCount} 筆(依距離排序,由近到遠)</div>` + table;

    resultLayer.addLayer(L.circleMarker([point.lat, point.lon], { radius: 6, color: "#2563eb" }));
    pointRadiusCircle = L.circle([point.lat, point.lon], { radius, color: "#2563eb", fillOpacity: 0.05 });
    resultLayer.addLayer(pointRadiusCircle);

    for (const m of data.matches) {
      L.circleMarker([m.latitude, m.longitude], { radius: 5, color: "#f59e0b", fillOpacity: 0.8 })
        .bindPopup(JSON.stringify(m, null, 1).slice(0, 300))
        .addTo(resultLayer);
    }
  } catch (err) {
    resultEl.innerHTML = "<div class='errorBox'>" + escapeHtml(err.message) + "</div>";
  }
});

// -----------------------------------------------------------------------
// SUMMARY / AUDIT TAB
// -----------------------------------------------------------------------
document.getElementById("runSummaryBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("summaryResult");
  resultEl.innerHTML = "<div class='loadingBox'>讀取中...</div>";

  try {
    const data = await fetch("/api/data-summary").then((r) => r.json());

    const byYearRows = Object.entries(data.accidents.byYear)
      .sort()
      .map(([y, c]) => `<tr><td>${y}</td><td>${c}</td></tr>`)
      .join("");

    const byChainRows = Object.entries(data.convenienceStores.byStoreType)
      .map(([t, c]) => `<tr><td>${escapeHtml(t)}</td><td>${c}</td></tr>`)
      .join("");

    function countyTable(obj, label) {
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v.toLocaleString()}</td></tr>`).join("");
      return `<details><summary class='scoreMeta'>各縣市${label}筆數</summary><table class='dataTable'><thead><tr><th>縣市</th><th>筆數</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }

    function bboxLine(b) {
      if (!b) return "(無資料)";
      return `lat ${fmt(b.minLat, 4)} ~ ${fmt(b.maxLat, 4)} ・ lon ${fmt(b.minLon, 4)} ~ ${fmt(b.maxLon, 4)}`;
    }

    resultEl.innerHTML =
      "<h4>事故資料</h4>" +
      `<div class='scoreMeta'>總筆數 ${data.accidents.totalRecords}(行人事故 ${data.accidents.pedestrianRecords} 筆)</div>` +
      `<div class='scoreMeta'>日期範圍：${data.accidents.dateRange ? data.accidents.dateRange.from + " ~ " + data.accidents.dateRange.to : "-"}</div>` +
      `<div class='scoreMeta'>座標範圍：${bboxLine(data.accidents.boundingBox)}</div>` +
      `<table class='dataTable'><thead><tr><th>年度</th><th>筆數</th></tr></thead><tbody>${byYearRows}</tbody></table>` +

      (data.accidents.byCounty ? countyTable(data.accidents.byCounty, "行人事故") : "") +
      (data.allAccidents
        ? `<div class='scoreMeta'>機車/開車模式用的全部事故:${data.allAccidents.total.toLocaleString()} 筆(有機車涉入 ${(data.allAccidents.byInvolvement.scooter || 0).toLocaleString()}、有汽車涉入 ${(data.allAccidents.byInvolvement.car || 0).toLocaleString()}),${escapeHtml(data.allAccidents.dateRange.from)} ~ ${escapeHtml(data.allAccidents.dateRange.to)}</div>`
        : "") +
      "<h4>路燈資料</h4>" +
      (data.coverage ? `<div class='scoreMeta'>涵蓋縣市:${escapeHtml(data.coverage.streetlights.join("、"))}(其他縣市沒有路燈資料,該項不計分)</div>` : "") +
      `<div class='scoreMeta'>總筆數 ${data.streetlights.totalRecords}</div>` +
      `<div class='scoreMeta'>座標範圍：${bboxLine(data.streetlights.boundingBox)}</div>` +

      "<h4>便利商店資料</h4>" +
      `<div class='scoreMeta'>總筆數 ${data.convenienceStores.totalRecords}</div>` +
      `<div class='scoreMeta'>座標範圍：${bboxLine(data.convenienceStores.boundingBox)}</div>` +
      `<table class='dataTable'><thead><tr><th>品牌</th><th>筆數</th></tr></thead><tbody>${byChainRows}</tbody></table>` +
      (data.convenienceStores.fetched
        ? `<div class='scoreMeta'>來源:${escapeHtml(data.convenienceStores.fetched.source)},下載時間 ${escapeHtml(String(data.convenienceStores.fetched.fetchedAt).slice(0, 10))}</div>`
        : "<div class='scoreMeta'>目前是台北市資料;執行 npm start 會自動下載全台資料。</div>") +
      (data.convenienceStores.byCounty ? countyTable(data.convenienceStores.byCounty, "便利商店") : "") +
      (data.files ? `<div class='scoreMeta'>使用中的檔案:${escapeHtml(Object.values(data.files).join("、"))}</div>` : "") +

      "<div class='scopeNote'>想看完整的資料正確性檢查(邊界違規/重複值/缺漏欄位),請在終端機執行 <code>npm run audit</code>。</div>";
  } catch (err) {
    resultEl.innerHTML = "<div class='errorBox'>" + escapeHtml(err.message) + "</div>";
  }
});
