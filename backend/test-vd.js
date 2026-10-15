import "dotenv/config";

import {
  getCityVDStatic,
  getCityVDLive,
} from "./tdxClient.js";


function getList(data) {
  if (Array.isArray(data)) {
    return data;
  }

  const possible = [
    data?.VDs,
    data?.VehicleDetectors,
    data?.VDList,
    data?.data,
  ];

  for (const item of possible) {
    if (Array.isArray(item)) {
      return item;
    }
  }

  if (
    data &&
    typeof data === "object"
  ) {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}


function position(vd) {
  const pos =
    vd?.Position ||
    vd?.VDPosition ||
    {};

  return {
    lat:
      Number(
        pos?.PositionLat ??
        vd?.PositionLat
      ),

    lon:
      Number(
        pos?.PositionLon ??
        vd?.PositionLon
      ),
  };
}


try {
  console.log("");
  console.log("===== TDX Taipei VD STATIC =====");

  const staticData =
    await getCityVDStatic(
      "Taipei"
    );

  const vds =
    getList(staticData);

  console.log(
    "VD count:",
    vds.length
  );

  console.log("");
  console.log("First 5:");

  console.log(
    JSON.stringify(
      vds
        .slice(0, 5)
        .map((vd) => ({
          VDID:
            vd?.VDID,

          RoadName:
            vd?.RoadName,

          RoadClass:
            vd?.RoadClass,

          LaneNum:
            vd?.LaneNum,

          DetectionLinks:
            vd?.DetectionLinks,

          Position:
            position(vd),
        })),
      null,
      2
    )
  );


  const sample =
    vds.find(
      (vd) =>
        vd?.VDID
    );


  if (!sample) {
    throw new Error(
      "找不到任何有 VDID 的 VD"
    );
  }


  console.log("");
  console.log("===== SAMPLE VD LIVE =====");
  console.log(
    "VDID:",
    sample.VDID
  );
  console.log(
    "Road:",
    sample.RoadName
  );


  const liveData =
    await getCityVDLive(
      "Taipei",
      sample.VDID
    );


  console.log(
    JSON.stringify(
      liveData,
      null,
      2
    ).slice(0, 12000)
  );


} catch (error) {
  console.error("");
  console.error(
    "VD TEST ERROR:"
  );

  console.error(
    error?.stack ||
    error?.message ||
    error
  );

  process.exitCode = 1;
}
