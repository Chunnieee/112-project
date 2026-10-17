/*
 * Google 地圖底圖（Map Tiles API 2D roadmap tiles）
 *
 * 金鑰只放在後端 .env：GOOGLE_MAPS_API_KEY=...
 * 前端只跟這裡要圖磚，不會看到金鑰。
 *   GET /api/map/google/status                    → { enabled }
 *   GET /api/map/google/tiles/:theme/:z/:x/:y     → 圖磚（theme = light / dark）
 *   GET /api/map/google/viewport/:theme?zoom&north&south&east&west → { copyright }（地圖上必須顯示的版權文字）
 * Session 依主題各建一個，過期前自動重建。圖磚不在伺服器端快取，只轉送 Google 的回應。
 */
import express from "express";

const BASE = "https://tile.googleapis.com";
const key = () => String(process.env.GOOGLE_MAPS_API_KEY || "").trim();

/* 深色主題：與 App 深色介面相近的低亮度樣式 */
const DARK_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#1d2420" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#c9c3b2" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#141a17" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#232c27" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1f2e25" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#33403a" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a211d" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#4a5a50" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2a332e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#13202a" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6d8796" }] },
];

const sessions = new Map(); // theme → { token, expiry, pending }

async function getSession(theme) {
  const s = sessions.get(theme);
  if (s?.token && s.expiry - Date.now() > 10 * 60 * 1000) return s.token;
  if (s?.pending) return s.pending;
  const body = { mapType: "roadmap", language: "zh-TW", region: "TW", scale: "scaleFactor2x", highDpi: true };
  if (theme === "dark") body.styles = DARK_STYLES;
  const pending = (async () => {
    const res = await fetch(`${BASE}/v1/createSession?key=${encodeURIComponent(key())}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.session) {
      sessions.delete(theme);
      throw new Error(`Google createSession 失敗：${data?.error?.message || `HTTP ${res.status}`}`);
    }
    const expiry = Number(data.expiry) * 1000 || Date.now() + 24 * 3600 * 1000;
    sessions.set(theme, { token: data.session, expiry });
    return data.session;
  })();
  sessions.set(theme, { pending });
  return pending;
}

export function createMapTilesRouter() {
  const router = express.Router();
  const themeOf = (t) => (t === "dark" ? "dark" : "light");

  router.get("/google/status", async (_req, res) => {
    if (!key()) return res.json({ enabled: false, reason: "GOOGLE_MAPS_API_KEY 未設定" });
    try { await getSession("light"); res.json({ enabled: true }); }
    catch (e) { res.json({ enabled: false, reason: e.message }); }
  });

  router.get("/google/tiles/:theme/:z/:x/:y", async (req, res) => {
    if (!key()) return res.status(503).end();
    const { z, x, y } = req.params;
    if (![z, x, y].every((v) => /^\d+$/.test(v))) return res.status(400).end();
    try {
      const theme = themeOf(req.params.theme);
      const url = (token) => `${BASE}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(key())}`;
      let r = await fetch(url(await getSession(theme)), { signal: AbortSignal.timeout(10000) });
      if (r.status === 401 || r.status === 403) { sessions.delete(theme); r = await fetch(url(await getSession(theme)), { signal: AbortSignal.timeout(10000) }); }
      if (!r.ok) return res.status(r.status).end();
      res.set("Content-Type", r.headers.get("content-type") || "image/png");
      const cc = r.headers.get("cache-control"); if (cc) res.set("Cache-Control", cc);
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.status(502).end();
    }
  });

  router.get("/google/viewport/:theme", async (req, res) => {
    if (!key()) return res.status(503).json({ copyright: "" });
    const q = req.query, nums = ["zoom", "north", "south", "east", "west"].map((k) => Number(q[k]));
    if (!nums.every(Number.isFinite)) return res.status(400).json({ copyright: "" });
    const clamp = (v, a) => Math.max(-a, Math.min(a, v));
    const [zoom, north, south, east, west] = nums;
    try {
      const token = await getSession(themeOf(req.params.theme));
      const p = new URLSearchParams({ session: token, key: key(), zoom: String(Math.round(zoom)),
        north: String(clamp(north, 89.9)), south: String(clamp(south, 89.9)), east: String(clamp(east, 179.9)), west: String(clamp(west, 179.9)) });
      const r = await fetch(`${BASE}/tile/v1/viewport?${p}`, { signal: AbortSignal.timeout(8000) });
      const data = await r.json().catch(() => ({}));
      res.json({ copyright: data.copyright || "" });
    } catch {
      res.json({ copyright: "" });
    }
  });
  return router;
}
