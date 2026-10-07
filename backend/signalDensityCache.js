// signalDensityCache.js
//
// Fetches traffic-signal node locations (highway=traffic_signals) from OSM
// Overpass for a bounding box, ONCE, and caches them to disk.
//
// Design rule (same as the rest of this project): never call an external
// API inside the hot request path. This module is meant to be run ahead of
// time (via the CLI entry point) or lazily on first use, then reused from
// disk for every subsequent route request.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(__dirname, "data", "osm-signal-cache");

// Try multiple mirrors in order; the public overpass-api.de main server is
// frequently overloaded (504) for larger bounding boxes.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheFile(cityKey) {
  return path.join(CACHE_DIR, `${cityKey}.json`);
}

/**
 * bbox = { south, west, north, east } in decimal degrees.
 * cityKey = a short identifier you choose, e.g. "taichung-central".
 */
export async function fetchAndCacheSignals({ cityKey, bbox, maxAgeDays = 180 }) {
  const file = cacheFile(cityKey);

  if (fs.existsSync(file)) {
    const stat = fs.statSync(file);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays <= maxAgeDays) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  }

  // "out skel" returns just type/id/lat/lon (no tags), much lighter than
  // "out body" and far less likely to time out on a city-sized bbox.
  const query = `
    [out:json][timeout:120];
    node["highway"="traffic_signals"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    out skel;
  `;

  let data = null;
  let lastError = null;

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      console.log(`[signal cache] trying ${mirror} ...`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);

      const response = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "tdx-project-graduation-thesis/1.0",
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${mirror}`);
        console.log(`[signal cache] ${mirror} failed: ${lastError.message}`);
        continue;
      }

      data = await response.json();
      console.log(`[signal cache] succeeded via ${mirror}`);
      break;
    } catch (error) {
      lastError = error;
      console.log(`[signal cache] ${mirror} failed: ${error.message}`);
    }
  }

  if (!data) {
    throw new Error(
      `All Overpass mirrors failed. Last error: ${lastError?.message}`
    );
  }

  const signals = (data.elements || [])
    .filter((el) => el.type === "node" && Number.isFinite(el.lat) && Number.isFinite(el.lon))
    .map((el) => ({ lat: el.lat, lon: el.lon }));

  const payload = {
    cityKey,
    bbox,
    fetchedAt: new Date().toISOString(),
    count: signals.length,
    signals,
  };

  fs.writeFileSync(file, JSON.stringify(payload));
  console.log(`[signal cache] ${cityKey}: cached ${signals.length} traffic signal nodes`);

  return payload;
}

export function loadCachedSignals(cityKey) {
  const file = cacheFile(cityKey);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// CLI usage, run once ahead of time per city you plan to demo:
//   node signalDensityCache.js --cityKey=taichung-central --south=24.10 --west=120.60 --north=24.20 --east=120.72
const runningAsCli =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (runningAsCli) {
  const arg = (name) => {
    const hit = process.argv.find((v) => v.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const cityKey = arg("cityKey");
  const bbox = {
    south: Number(arg("south")),
    west: Number(arg("west")),
    north: Number(arg("north")),
    east: Number(arg("east")),
  };

  if (!cityKey || Object.values(bbox).some((v) => !Number.isFinite(v))) {
    console.error("Usage: node signalDensityCache.js --cityKey=NAME --south=.. --west=.. --north=.. --east=..");
    process.exit(1);
  }

  await fetchAndCacheSignals({ cityKey, bbox });
}
