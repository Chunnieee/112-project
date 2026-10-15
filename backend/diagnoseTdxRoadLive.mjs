import dotenv from "dotenv";

dotenv.config({
  override: true,
});

console.log("TDX credentials:", {
  clientId: process.env.TDX_CLIENT_ID ? "Loaded" : "Missing",
  clientSecret: process.env.TDX_CLIENT_SECRET ? "Loaded" : "Missing",
});

const {
  getFreewayLiveTraffic,
  getHighwayLiveTraffic,
} = await import("./tdxClient.js");

function inspect(name, data) {
  console.log("");
  console.log(`========== ${name} ==========`);

  console.log(
    "type:",
    Array.isArray(data)
      ? "array"
      : typeof data
  );

  console.log(
    "top-level keys:",
    data && typeof data === "object"
      ? Object.keys(data)
      : []
  );

  const candidates = [];

  if (Array.isArray(data)) {
    candidates.push({
      key: "<root array>",
      value: data,
    });
  }

  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        candidates.push({
          key,
          value,
        });
      }
    }
  }

  console.log(
    "array fields:",
    candidates.map((item) => ({
      key: item.key,
      count: item.value.length,
    }))
  );

  for (const item of candidates) {
    if (!item.value.length) continue;

    console.log("");
    console.log(`FIRST ITEM FROM ${item.key}:`);

    console.dir(
      item.value[0],
      {
        depth: 6,
        maxArrayLength: 10,
      }
    );

    break;
  }
}

async function test(name, fn) {
  try {
    const started = Date.now();

    const data = await fn();

    console.log(
      `\n${name} REQUEST OK in ${Date.now() - started} ms`
    );

    inspect(name, data);
  } catch (error) {
    console.log(`\n${name} REQUEST FAILED`);

    console.log({
      name: error?.name,
      message: error?.message,
      code: error?.code,
      status: error?.status,
      tdxDetail: error?.tdxDetail,
    });
  }
}

await test(
  "FREEWAY LIVE",
  getFreewayLiveTraffic
);

await test(
  "HIGHWAY LIVE",
  getHighwayLiveTraffic
);
