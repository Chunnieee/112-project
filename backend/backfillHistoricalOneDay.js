import "dotenv/config";
import { getHistoricalCityBucket } from "./historicalTrafficClient.js";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const city = String(arg("city", "Taipei") || "").trim();
const date = String(arg("date", "") || "").trim();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Usage: node backfillHistoricalOneDay.js --city=Taipei --date=YYYY-MM-DD");
  process.exit(2);
}

console.log(`[manual history] ONE-DAY backfill requested: ${city} ${date}`);
console.log("[manual history] This command can download at most one city-day CSV.");

const result = await getHistoricalCityBucket({
  city,
  date,
  timeBucket: "00:00",
  cacheOnly: false,
});

console.log({
  city: result?.city || city,
  date: result?.date || date,
  unavailable: Boolean(result?.unavailable),
  negativeCache: Boolean(result?.negativeCache),
  cacheHit: Boolean(result?.cacheHit),
});