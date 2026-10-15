import "dotenv/config";

import {
  getHistoricalSectionStats,
} from "./historicalTrafficClient.js";

const result =
  await getHistoricalSectionStats({
    scope: "freeway",
    date: "2026-09-25",
    timeBucket: "21:00",

    sectionIds: [
      "0204",
      "0202",
      "0200",
      "0196",
      "0198",
    ],

    cacheOnly: false,
  });

console.log(
  JSON.stringify(
    result,
    null,
    2
  )
);
