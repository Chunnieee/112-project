import dotenv from "dotenv";
import {
  getHistoricalSectionStats,
} from "./historicalTrafficClient.js";

dotenv.config();

const result = await getHistoricalSectionStats({
  city: "Taipei",
  date: "2026-09-05",
  timeBucket: "17:30",
  sectionIds: [
    "L_2000500000170A",
  ],
});

console.log();
console.log("===== HISTORICAL CLIENT RESULT =====");
console.log("City:", result.city);
console.log("Date:", result.date);
console.log("Bucket:", result.timeBucket);
console.log("Cache hit:", result.cacheHit);
console.log(
  "Requested sections:",
  result.requestedSectionCount
);
console.log(
  "Matched sections:",
  result.matchedSectionCount
);
console.log();
console.log(
  result.sections["L_2000500000170A"]
);
