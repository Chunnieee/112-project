// roadNetwork.js
//
// OpenStreetMap road geometry around a route, used by the automatic
// "nearest-road" data attribution (pedestrianSafety/roadAttribution.js).
//
// Roads are fetched from the Overpass API in 0.01° tiles (~1 km), kept in
// memory and cached on disk (pedestrianSafety/data/osmRoadCache/, 30 days),
// so a route that was planned once works offline afterwards.
//
//   await ensureRoads(routes, extraMeters)  -- fetch missing tiles (async)
//   roadsNearRoute(route, extraMeters)      -- cached ways, or null if any
//                                              tile is missing (sync)
//
// If Overpass is unreachable everything keeps working: roadsNearRoute
// returns null and scoring falls back to a fixed buffer radius.
//
// Env (optional): OVERPASS_URL -- one endpoint, or several separated by commas.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "pedestrianSafety", "data", "osmRoadCache");
const TILE = 0.01;
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_TILES_PER_ROUTE = 80; // longer routes skip attribution (fixed buffer)
const ENDPOINTS = (process.env.OVERPASS_URL ||
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Not roads anyone walks or drives along (or not built yet).
const EXCLUDE =
  "proposed|construction|platform|elevator|bus_stop|corridor|raceway|abandoned|razed|disused|escape|bridleway";

// After a failed request, don't try Overpass again for a while (so an
// offline machine doesn't wait for a timeout on every route).
let downUntil = 0;
const DOWN_MS = 5 * 60 * 1000;

const memory = new Map(); // tileKey -> { ts, ways: [{ id, hw, g: [[lat,lon],...] }] }
const inflight = new Map(); // tileKey -> Promise

const tileKey = (i, j) => `${i}_${j}`;
const tileBox = (i, j) => ({ s: i * TILE, w: j * TILE, n: (i + 1) * TILE, e: (j + 1) * TILE });

/** Tiles covering the route plus `extraMeters` around it. */
export function tilesForRoute(route, extraMeters) {
  const keys = new Map();
  const pad = extraMeters / 111320;
  const add = (lat, lon) => {
    const padLon = pad / Math.cos((lat * Math.PI) / 180);
    for (let i = Math.floor((lat - pad) / TILE); i <= Math.floor((lat + pad) / TILE); i++)
      for (let j = Math.floor((lon - padLon) / TILE); j <= Math.floor((lon + padLon) / TILE); j++)
        keys.set(tileKey(i, j), [i, j]);
  };
  for (let k = 0; k < route.length; k++) {
    const a = route[k];
    add(a.lat, a.lon);
    const b = route[k + 1];
    if (!b) break;
    // Sample long segments every ~100 m so no tile in between is missed.
    const steps = Math.ceil(Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 101000) / 100);
    for (let s = 1; s < steps; s++) add(a.lat + ((b.lat - a.lat) * s) / steps, a.lon + ((b.lon - a.lon) * s) / steps);
  }
  return [...keys.values()];
}

function readDisk(key) {
  try {
    const f = path.join(CACHE_DIR, key + ".json");
    if (!existsSync(f)) return null;
    const v = JSON.parse(readFileSync(f, "utf8"));
    if (!v || Date.now() - v.ts > TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}
function writeDisk(key, v) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify(v));
  } catch {
    // cache is best-effort
  }
}
function cached(key) {
  const m = memory.get(key);
  if (m && Date.now() - m.ts < TTL_MS) return m;
  const d = readDisk(key);
  if (d) memory.set(key, d);
  return d;
}

async function overpass(query) {
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pedestrian-safety-lab" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass unreachable");
}

async function fetchTiles(tiles) {
  const bboxes = tiles.map(([i, j]) => {
    const b = tileBox(i, j);
    return `way["highway"]["highway"!~"^(${EXCLUDE})$"]["area"!="yes"](${b.s},${b.w},${b.n},${b.e});`;
  });
  const data = await overpass(`[out:json][timeout:12];(${bboxes.join("")});out geom qt;`);
  const per = new Map(tiles.map(([i, j]) => [tileKey(i, j), []]));
  for (const el of data.elements || []) {
    if (el.type !== "way" || !el.geometry) continue;
    const g = el.geometry.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]);
    const way = { id: el.id, hw: el.tags && el.tags.highway, g };
    // A way goes into every requested tile any of its segments touches
    // (a long straight segment can cross a tile without a vertex in it).
    const seen = new Set();
    for (let s = 0; s < g.length; s++) {
      const a = g[s];
      const b = g[s + 1] || a;
      for (let i = Math.floor(Math.min(a[0], b[0]) / TILE); i <= Math.floor(Math.max(a[0], b[0]) / TILE); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / TILE); j <= Math.floor(Math.max(a[1], b[1]) / TILE); j++) {
          const k = tileKey(i, j);
          if (per.has(k) && !seen.has(k)) {
            seen.add(k);
            per.get(k).push(way);
          }
        }
    }
  }
  const ts = Date.now();
  for (const [k, ways] of per) {
    const v = { ts, ways };
    memory.set(k, v);
    writeDisk(k, v);
  }
}

/**
 * Makes sure road tiles for every route are cached. Never throws: on
 * failure those routes simply fall back to a fixed buffer.
 * @param {Array<Array<{lat,lon}>>} routes
 */
export async function ensureRoads(routes, extraMeters = 300) {
  const missing = new Map();
  for (const r of routes) {
    if (!r || r.length < 2) continue;
    const tiles = tilesForRoute(r, extraMeters);
    if (tiles.length > MAX_TILES_PER_ROUTE) continue;
    for (const [i, j] of tiles) {
      const k = tileKey(i, j);
      if (!cached(k)) missing.set(k, [i, j]);
    }
  }
  if (missing.size && Date.now() < downUntil) return;
  const waits = [];
  const toFetch = [];
  for (const [k, t] of missing) {
    if (inflight.has(k)) waits.push(inflight.get(k));
    else toFetch.push(t);
  }
  // Batches of 12 tiles per Overpass request.
  for (let s = 0; s < toFetch.length; s += 12) {
    const batch = toFetch.slice(s, s + 12);
    const p = fetchTiles(batch).catch((e) => {
      downUntil = Date.now() + DOWN_MS;
      console.warn("[roads] Overpass failed (fixed buffer for 5 min):", e.message);
    });
    for (const [i, j] of batch) inflight.set(tileKey(i, j), p);
    waits.push(p.finally(() => batch.forEach(([i, j]) => inflight.delete(tileKey(i, j)))));
  }
  await Promise.all(waits);
}

/**
 * Cached road ways around the route (deduplicated), or null when the route
 * is too long or any tile is not cached (-> caller uses a fixed buffer).
 */
export function roadsNearRoute(route, extraMeters = 300) {
  if (!route || route.length < 2) return null;
  const tiles = tilesForRoute(route, extraMeters);
  if (tiles.length > MAX_TILES_PER_ROUTE) return null;
  const byId = new Map();
  for (const [i, j] of tiles) {
    const v = cached(tileKey(i, j));
    if (!v) return null;
    for (const w of v.ways) byId.set(w.id, w);
  }
  return [...byId.values()];
}

/** For tests: put ways straight into the memory cache. */
export function _seedTiles(ways, tiles) {
  const ts = Date.now();
  for (const [i, j] of tiles) {
    const k = tileKey(i, j);
    const b = tileBox(i, j);
    memory.set(k, {
      ts,
      ways: ways.filter((w) => w.g.some(([lat, lon]) => lat >= b.s && lat < b.n && lon >= b.w && lon < b.e)),
    });
  }
}
