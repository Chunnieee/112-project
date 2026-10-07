import "dotenv/config";

import {
  getTdxAccessToken,
} from "./tdxClient.js";

const date =
  process.argv[2] ||
  "2026-09-25";

const candidates = [
  {
    name: "Live Freeway",
    path: "Historical/Road/Traffic/Live/Freeway",
  },
  {
    name: "Live Highway",
    path: "Historical/Road/Traffic/Live/Highway",
  },
  {
    name: "VD Freeway",
    path: "Historical/Road/Traffic/VD/Freeway",
  },
  {
    name: "VD Highway",
    path: "Historical/Road/Traffic/VD/Highway",
  },
];

const token =
  await getTdxAccessToken();

for (const item of candidates) {
  const url =
    "https://tdx.transportdata.tw/api/historical/v2/" +
    item.path +
    `?Dates=${encodeURIComponent(date)}` +
    "&%24format=CSV";

  console.log("\n====================");
  console.log(item.name);

  try {
    const response =
      await fetch(url, {
        headers: {
          Authorization:
            `Bearer ${token}`,
          Accept: "text/csv",
        },
      });

    console.log(
      "status:",
      response.status
    );

    if (!response.ok) {
      console.log(
        await response.text()
      );
      continue;
    }

    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    let text = "";

    while (
      text
        .split("\n")
        .filter(Boolean)
        .length < 2
    ) {
      const {
        done,
        value,
      } =
        await reader.read();

      if (done) break;

      text +=
        decoder.decode(
          value,
          {
            stream: true,
          }
        );
    }

    const lines =
      text
        .split("\n")
        .filter(Boolean)
        .slice(0, 2);

    console.log("HEADER:");
    console.log(
      lines[0] || "(none)"
    );

    console.log("FIRST ROW:");
    console.log(
      lines[1] || "(none)"
    );

    try {
      await reader.cancel();
    } catch {}
  } catch (error) {
    console.log(
      "ERROR:",
      error.message
    );
  }
}
