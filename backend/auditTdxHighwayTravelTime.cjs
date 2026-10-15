require("dotenv").config({ override: true });

const fs = require("fs");

const CLIENT_ID = process.env.TDX_CLIENT_ID;
const CLIENT_SECRET = process.env.TDX_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing TDX_CLIENT_ID / TDX_CLIENT_SECRET");
  process.exit(1);
}

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const BASE =
  "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic";

const LIVE_URL =
  `${BASE}/Live/Highway?$format=JSON`;

const SECTION_URL =
  `${BASE}/Section/Highway?$format=JSON`;


async function getToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`TDX token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();

  if (!json.access_token) {
    throw new Error("TDX token response has no access_token");
  }

  return json.access_token;
}


async function tdxFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`${url}\nHTTP ${res.status}\n${await res.text()}`);
  }

  return res.json();
}


function unwrapArray(obj, preferredKeys = []) {
  if (Array.isArray(obj)) return obj;

  for (const key of preferredKeys) {
    if (Array.isArray(obj?.[key])) {
      return obj[key];
    }
  }

  if (obj && typeof obj === "object") {
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}


function parseMile(value) {
  if (typeof value !== "string") return null;

  const s = value.trim();

  // examples:
  // 23K+800
  // 12K+0
  // 10K+700
  const m = s.match(/^(\d+(?:\.\d+)?)K(?:\+(\d+(?:\.\d+)?))?$/i);

  if (!m) return null;

  const km = Number(m[1]);
  const meters = m[2] ? Number(m[2]) : 0;

  if (!Number.isFinite(km) || !Number.isFinite(meters)) {
    return null;
  }

  return km + meters / 1000;
}


function relError(actual, target) {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(target) ||
    target <= 0
  ) {
    return Infinity;
  }

  return Math.abs(actual - target) / target;
}


function median(values) {
  const arr = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return null;

  const mid = Math.floor(arr.length / 2);

  return arr.length % 2
    ? arr[mid]
    : (arr[mid - 1] + arr[mid]) / 2;
}


function percentile(values, p) {
  const arr = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return null;

  const index = Math.min(
    arr.length - 1,
    Math.max(0, Math.floor((arr.length - 1) * p))
  );

  return arr[index];
}


function pct(n, d) {
  if (!d) return "0.00%";
  return `${((n / d) * 100).toFixed(2)}%`;
}


function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}


(async () => {
  console.log("=== TDX HIGHWAY TRAVELTIME AUDIT ===");
  console.log("No production ETA code will be modified.");
  console.log("");

  const token = await getToken();

  console.log("TDX token: OK");
  console.log("Loading Highway static + live feeds...");

  const [staticRaw, liveRaw] = await Promise.all([
    tdxFetch(SECTION_URL, token),
    tdxFetch(LIVE_URL, token),
  ]);

  const staticSections = unwrapArray(staticRaw, [
    "Sections",
    "Section",
  ]);

  const liveSections = unwrapArray(liveRaw, [
    "LiveTraffics",
    "LiveTraffic",
  ]);

  console.log(`Static sections: ${staticSections.length}`);
  console.log(`Live sections:   ${liveSections.length}`);
  console.log("");

  const staticById = new Map();

  for (const section of staticSections) {
    if (section?.SectionID) {
      staticById.set(section.SectionID, section);
    }
  }

  const rows = [];

  let noStatic = 0;
  let badMile = 0;
  let badSpeed = 0;
  let badTime = 0;

  for (const live of liveSections) {
    const id = live?.SectionID;

    if (!id) continue;

    const stat = staticById.get(id);

    if (!stat) {
      noStatic++;
      continue;
    }

    const speed = Number(live.TravelSpeed);
    const travelTime = Number(live.TravelTime);

    if (!Number.isFinite(speed) || speed <= 0) {
      badSpeed++;
      continue;
    }

    if (!Number.isFinite(travelTime) || travelTime <= 0) {
      badTime++;
      continue;
    }

    const startKm = parseMile(stat?.SectionMile?.StartKM);
    const endKm = parseMile(stat?.SectionMile?.EndKM);

    if (
      !Number.isFinite(startKm) ||
      !Number.isFinite(endKm)
    ) {
      badMile++;
      continue;
    }

    const distanceKm = Math.abs(endKm - startKm);

    if (!(distanceKm > 0)) {
      badMile++;
      continue;
    }

    const expectedSecFromSpeed =
      (distanceKm / speed) * 3600;

    if (!(expectedSecFromSpeed > 0)) {
      continue;
    }

    const ratio =
      travelTime / expectedSecFromSpeed;

    const openLRCount =
      Array.isArray(stat.OpenLRs)
        ? stat.OpenLRs.length
        : Array.isArray(live.OpenLRs)
        ? live.OpenLRs.length
        : 0;

    const linkCount =
      Array.isArray(stat.LinkIDs)
        ? stat.LinkIDs.length
        : 0;

    const normalizedByOpenLR =
      openLRCount > 0
        ? travelTime / openLRCount
        : null;

    const normalizedByLink =
      linkCount > 0
        ? travelTime / linkCount
        : null;

    const speedFromRawTravelTime =
      distanceKm / (travelTime / 3600);

    const speedFromOpenLRNormalized =
      normalizedByOpenLR > 0
        ? distanceKm / (normalizedByOpenLR / 3600)
        : null;

    const speedFromLinkNormalized =
      normalizedByLink > 0
        ? distanceKm / (normalizedByLink / 3600)
        : null;

    rows.push({
      id,
      roadName: stat.RoadName || "",
      direction: stat.RoadDirection || "",
      startKm,
      endKm,
      distanceKm,
      travelSpeed: speed,
      travelTime,
      expectedSecFromSpeed,
      ratio,

      openLRCount,
      linkCount,

      ratioErrorTo1:
        relError(ratio, 1),

      ratioErrorToOpenLR:
        openLRCount > 0
          ? relError(ratio, openLRCount)
          : Infinity,

      ratioErrorToLink:
        linkCount > 0
          ? relError(ratio, linkCount)
          : Infinity,

      speedFromRawTravelTime,

      speedFromOpenLRNormalized,
      openLRSpeedError:
        Number.isFinite(speedFromOpenLRNormalized)
          ? relError(speedFromOpenLRNormalized, speed)
          : Infinity,

      speedFromLinkNormalized,
      linkSpeedError:
        Number.isFinite(speedFromLinkNormalized)
          ? relError(speedFromLinkNormalized, speed)
          : Infinity,
    });
  }


  // ---------------------------------------------------------
  // overall classification
  // ---------------------------------------------------------

  const TOLERANCES = [0.05, 0.10, 0.15, 0.20];

  console.log("========================================");
  console.log("VALID DATA");
  console.log("========================================");
  console.log(`Valid comparable sections: ${rows.length}`);
  console.log(`Missing static section:     ${noStatic}`);
  console.log(`Invalid SectionMile:        ${badMile}`);
  console.log(`Invalid TravelSpeed:        ${badSpeed}`);
  console.log(`Invalid TravelTime:         ${badTime}`);
  console.log("");


  console.log("========================================");
  console.log("HYPOTHESIS TEST");
  console.log("ratio = TravelTime / expectedTimeFromPublishedSpeed");
  console.log("========================================");

  for (const tol of TOLERANCES) {
    const close1 = rows.filter(
      r => r.ratioErrorTo1 <= tol
    ).length;

    const closeOpen = rows.filter(
      r =>
        r.openLRCount > 0 &&
        r.ratioErrorToOpenLR <= tol
    ).length;

    const closeLink = rows.filter(
      r =>
        r.linkCount > 0 &&
        r.ratioErrorToLink <= tol
    ).length;

    console.log(
      `${Math.round(tol * 100)}% tolerance:`
    );

    console.log(
      `  ratio ≈ 1:            ${close1}/${rows.length} (${pct(close1, rows.length)})`
    );

    console.log(
      `  ratio ≈ OpenLR count: ${closeOpen}/${rows.length} (${pct(closeOpen, rows.length)})`
    );

    console.log(
      `  ratio ≈ LinkID count: ${closeLink}/${rows.length} (${pct(closeLink, rows.length)})`
    );
  }

  console.log("");


  // ---------------------------------------------------------
  // OpenLR vs Link ID structural check
  // ---------------------------------------------------------

  const bothCounts = rows.filter(
    r => r.openLRCount > 0 && r.linkCount > 0
  );

  const countSame = bothCounts.filter(
    r => r.openLRCount === r.linkCount
  ).length;

  const countDifferent = bothCounts.length - countSame;

  console.log("========================================");
  console.log("OPENLR vs LINK STRUCTURE");
  console.log("========================================");

  console.log(
    `Both counts available: ${bothCounts.length}`
  );

  console.log(
    `OpenLR count == LinkID count: ${countSame} (${pct(countSame, bothCounts.length)})`
  );

  console.log(
    `OpenLR count != LinkID count: ${countDifferent} (${pct(countDifferent, bothCounts.length)})`
  );

  console.log("");


  // ---------------------------------------------------------
  // bucket by OpenLR count
  // ---------------------------------------------------------

  const buckets = new Map();

  for (const r of rows) {
    const n = r.openLRCount;

    if (!buckets.has(n)) {
      buckets.set(n, []);
    }

    buckets.get(n).push(r);
  }

  console.log("========================================");
  console.log("BY OPENLR COUNT");
  console.log("========================================");
  console.log(
    "N | sections | median ratio | p10 | p90 | median raw-speed error | median normalized-speed error"
  );

  for (
    const [n, group]
    of [...buckets.entries()].sort(
      (a, b) => a[0] - b[0]
    )
  ) {
    const ratios =
      group.map(r => r.ratio);

    const rawErrors =
      group.map(r =>
        relError(
          r.speedFromRawTravelTime,
          r.travelSpeed
        )
      );

    const normalizedErrors =
      group.map(r => r.openLRSpeedError);

    console.log(
      [
        n,
        group.length,
        round(median(ratios)),
        round(percentile(ratios, 0.10)),
        round(percentile(ratios, 0.90)),
        `${round(median(rawErrors) * 100, 2)}%`,
        `${round(median(normalizedErrors) * 100, 2)}%`,
      ].join(" | ")
    );
  }

  console.log("");


  // ---------------------------------------------------------
  // Key comparison: n = 1 versus n > 1
  // ---------------------------------------------------------

  const one = rows.filter(
    r => r.openLRCount === 1
  );

  const multi = rows.filter(
    r => r.openLRCount > 1
  );

  console.log("========================================");
  console.log("SINGLE vs MULTI OPENLR");
  console.log("========================================");

  for (const [label, group] of [
    ["OpenLR = 1", one],
    ["OpenLR > 1", multi],
  ]) {
    console.log(label);
    console.log(`  sections: ${group.length}`);

    if (group.length) {
      console.log(
        `  median ratio: ${round(
          median(group.map(r => r.ratio))
        )}`
      );

      console.log(
        `  median raw TravelTime speed error: ${round(
          median(
            group.map(r =>
              relError(
                r.speedFromRawTravelTime,
                r.travelSpeed
              )
            )
          ) * 100,
          2
        )}%`
      );

      console.log(
        `  median OpenLR-normalized speed error: ${round(
          median(
            group.map(r => r.openLRSpeedError)
          ) * 100,
          2
        )}%`
      );
    }
  }

  console.log("");


  // ---------------------------------------------------------
  // "winner" test
  // which hypothesis is closer?
  // ---------------------------------------------------------

  let winnerOne = 0;
  let winnerOpen = 0;
  let tie = 0;

  for (const r of rows) {
    if (!(r.openLRCount > 0)) continue;

    const e1 = r.ratioErrorTo1;
    const eN = r.ratioErrorToOpenLR;

    if (Math.abs(e1 - eN) < 0.01) {
      tie++;
    } else if (eN < e1) {
      winnerOpen++;
    } else {
      winnerOne++;
    }
  }

  const winnerTotal =
    winnerOne + winnerOpen + tie;

  console.log("========================================");
  console.log("WHICH MODEL FITS BETTER?");
  console.log("========================================");

  console.log(
    `ratio≈1 closer:      ${winnerOne}/${winnerTotal} (${pct(winnerOne, winnerTotal)})`
  );

  console.log(
    `ratio≈OpenLR closer: ${winnerOpen}/${winnerTotal} (${pct(winnerOpen, winnerTotal)})`
  );

  console.log(
    `tie:                 ${tie}/${winnerTotal} (${pct(tie, winnerTotal)})`
  );

  console.log("");


  // ---------------------------------------------------------
  // anomalies
  // ---------------------------------------------------------

  const strongSupport = rows
    .filter(
      r =>
        r.openLRCount > 1 &&
        r.ratioErrorToOpenLR <= 0.10 &&
        r.ratioErrorTo1 > 0.30
    )
    .sort(
      (a, b) =>
        a.ratioErrorToOpenLR -
        b.ratioErrorToOpenLR
    );

  console.log("========================================");
  console.log("STRONG MULTIPLIER EXAMPLES");
  console.log("ratio within 10% of OpenLR count");
  console.log("========================================");

  for (const r of strongSupport.slice(0, 20)) {
    console.log({
      SectionID: r.id,
      Road: r.roadName,
      DistanceKm: round(r.distanceKm),
      TravelSpeed: r.travelSpeed,
      TravelTime: r.travelTime,
      OpenLRs: r.openLRCount,
      LinkIDs: r.linkCount,
      Ratio: round(r.ratio),
      RawDerivedSpeed:
        round(r.speedFromRawTravelTime, 1),
      NormalizedDerivedSpeed:
        round(
          r.speedFromOpenLRNormalized,
          1
        ),
    });
  }

  console.log("");


  const anomalies = rows
    .filter(
      r =>
        r.openLRCount > 0 &&
        r.ratioErrorToOpenLR > 0.25 &&
        r.ratioErrorTo1 > 0.25
    )
    .sort(
      (a, b) =>
        Math.min(
          b.ratioErrorTo1,
          b.ratioErrorToOpenLR
        ) -
        Math.min(
          a.ratioErrorTo1,
          a.ratioErrorToOpenLR
        )
    );

  console.log("========================================");
  console.log("DOES NOT FIT EITHER MODEL");
  console.log("========================================");

  for (const r of anomalies.slice(0, 20)) {
    console.log({
      SectionID: r.id,
      Road: r.roadName,
      DistanceKm: round(r.distanceKm),
      TravelSpeed: r.travelSpeed,
      TravelTime: r.travelTime,
      OpenLRs: r.openLRCount,
      LinkIDs: r.linkCount,
      Ratio: round(r.ratio),
    });
  }


  // ---------------------------------------------------------
  // save CSV for later inspection
  // ---------------------------------------------------------

  const csvHeader = [
    "SectionID",
    "RoadName",
    "Direction",
    "DistanceKm",
    "TravelSpeed",
    "TravelTime",
    "ExpectedSecFromSpeed",
    "Ratio",
    "OpenLRCount",
    "LinkIDCount",
    "RawDerivedSpeed",
    "OpenLRNormalizedSpeed",
    "RatioErrorTo1",
    "RatioErrorToOpenLR",
  ];

  const csvRows = rows.map(r => [
    r.id,
    JSON.stringify(r.roadName),
    r.direction,
    r.distanceKm,
    r.travelSpeed,
    r.travelTime,
    r.expectedSecFromSpeed,
    r.ratio,
    r.openLRCount,
    r.linkCount,
    r.speedFromRawTravelTime,
    r.speedFromOpenLRNormalized,
    r.ratioErrorTo1,
    r.ratioErrorToOpenLR,
  ]);

  fs.writeFileSync(
    "tdx-highway-traveltime-audit.csv",
    [
      csvHeader.join(","),
      ...csvRows.map(row => row.join(",")),
    ].join("\n")
  );

  console.log("");
  console.log(
    "Saved: tdx-highway-traveltime-audit.csv"
  );

  console.log("");
  console.log("=== AUDIT COMPLETE ===");

})().catch(err => {
  console.error("");
  console.error("AUDIT FAILED");
  console.error(err);
  process.exit(1);
});
