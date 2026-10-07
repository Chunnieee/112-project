// RiskNav V7.1 offline Taiwan jurisdiction resolver.
// Uses a local county/city GeoJSON snapshot so route jurisdiction discovery
// does not depend on Photon availability at request time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeTaiwanJurisdiction } from "./etaSystemCore.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GEOJSON_PATH = path.join(HERE, "data", "taiwan_counties.geojson");

let compiledCache = null;
let compiledPath = null;
let loadError = null;

const LEGACY_ADMIN_ALIAS = new Map([
  ["台北縣", "NewTaipei"],
  ["臺北縣", "NewTaipei"],
  ["台北县", "NewTaipei"],
  ["桃園縣", "Taoyuan"],
  ["桃园县", "Taoyuan"],
  ["台中縣", "Taichung"],
  ["臺中縣", "Taichung"],
  ["台中县", "Taichung"],
  ["台南縣", "Tainan"],
  ["臺南縣", "Tainan"],
  ["台南县", "Tainan"],
  ["高雄縣", "Kaohsiung"],
  ["高雄县", "Kaohsiung"],
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function legacyAlias(value) {
  const text = normalizeText(value);
  return LEGACY_ADMIN_ALIAS.get(text) || null;
}

function featureJurisdiction(feature) {
  const props = feature?.properties || {};

  const preferredKeys = [
    "COUNTYNAME",
    "COUNTYENG",
    "countyname",
    "countyeng",
    "CountyName",
    "CountyEng",
    "name",
    "NAME",
    "Name",
  ];

  for (const key of preferredKeys) {
    const value = props?.[key];
    const scope = canonicalizeTaiwanJurisdiction(value) || legacyAlias(value);
    if (scope) return scope;
  }

  for (const value of Object.values(props)) {
    if (typeof value !== "string") continue;
    const scope = canonicalizeTaiwanJurisdiction(value) || legacyAlias(value);
    if (scope) return scope;
  }

  return null;
}

function geometryBbox(geometry) {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords)) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      Number.isFinite(Number(value[0])) &&
      Number.isFinite(Number(value[1])) &&
      !Array.isArray(value[0]) &&
      !Array.isArray(value[1])
    ) {
      const lon = Number(value[0]);
      const lat = Number(value[1]);
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
      return;
    }
    for (const child of value) walk(child);
  };

  walk(coords);

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function pointOnSegment(lon, lat, a, b, eps = 1e-10) {
  const ax = Number(a?.[0]);
  const ay = Number(a?.[1]);
  const bx = Number(b?.[0]);
  const by = Number(b?.[1]);
  if (![ax, ay, bx, by].every(Number.isFinite)) return false;

  const cross = (lon - ax) * (by - ay) - (lat - ay) * (bx - ax);
  if (Math.abs(cross) > eps) return false;

  const dot = (lon - ax) * (lon - bx) + (lat - ay) * (lat - by);
  return dot <= eps;
}

function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    const ax = Number(a?.[0]);
    const ay = Number(a?.[1]);
    const bx = Number(b?.[0]);
    const by = Number(b?.[1]);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;

    if (pointOnSegment(lon, lat, a, b)) return true;

    const intersects =
      ((ay > lat) !== (by > lat)) &&
      lon < ((bx - ax) * (lat - ay)) / ((by - ay) || Number.EPSILON) + ax;
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygon(lon, lat, polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(lon, lat, polygon[i])) return false;
  }
  return true;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry || typeof geometry !== "object") return false;
  if (geometry.type === "Polygon") {
    return pointInPolygon(lon, lat, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).some((polygon) =>
      pointInPolygon(lon, lat, polygon)
    );
  }
  return false;
}

function compileGeoJson(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const compiled = [];

  for (const feature of features) {
    const jurisdiction = featureJurisdiction(feature);
    if (!jurisdiction) continue;
    const bbox = geometryBbox(feature?.geometry);
    if (!bbox) continue;
    compiled.push({
      jurisdiction,
      geometry: feature.geometry,
      bbox,
      properties: feature.properties || {},
    });
  }

  return compiled;
}

function currentDataPath() {
  return path.resolve(process.env.TAIWAN_ADMIN_GEOJSON || DEFAULT_GEOJSON_PATH);
}

function ensureLoaded() {
  const target = currentDataPath();
  if (compiledCache && compiledPath === target) return compiledCache;

  compiledCache = null;
  compiledPath = target;
  loadError = null;

  try {
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    const compiled = compileGeoJson(parsed);
    if (compiled.length < 20) {
      throw new Error(`expected >=20 Taiwan jurisdictions, got ${compiled.length}`);
    }
    compiledCache = compiled;
  } catch (error) {
    loadError = error;
    compiledCache = [];
  }

  return compiledCache;
}

export function resetOfflineJurisdictionCache() {
  compiledCache = null;
  compiledPath = null;
  loadError = null;
}

export function getOfflineJurisdictionStatus() {
  const features = ensureLoaded();
  return {
    loaded: features.length >= 20,
    featureCount: features.length,
    path: currentDataPath(),
    error: loadError?.message || null,
  };
}

export function resolveTaiwanJurisdictionOffline(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  for (const feature of ensureLoaded()) {
    const { bbox } = feature;
    if (
      lon < bbox.minLon ||
      lon > bbox.maxLon ||
      lat < bbox.minLat ||
      lat > bbox.maxLat
    ) {
      continue;
    }

    if (pointInGeometry(lon, lat, feature.geometry)) {
      return {
        jurisdiction: feature.jurisdiction,
        source: "offline_boundary",
        properties: feature.properties,
      };
    }
  }

  return null;
}

// Test-only exports kept explicit so production logic does not depend on them.
export const __test = {
  pointInRing,
  pointInPolygon,
  pointInGeometry,
  compileGeoJson,
  featureJurisdiction,
};
