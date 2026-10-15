function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => (Number(v) * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}


function normalizeBearing(value) {
  const n = Number(value);
  return ((n % 360) + 360) % 360;
}


function bearingDeg(a, b) {
  const lat1 =
    (a.lat * Math.PI) / 180;

  const lat2 =
    (b.lat * Math.PI) / 180;

  const dLon =
    ((b.lon - a.lon) * Math.PI) /
    180;

  const y =
    Math.sin(dLon) *
    Math.cos(lat2);

  const x =
    Math.cos(lat1) *
      Math.sin(lat2) -
    Math.sin(lat1) *
      Math.cos(lat2) *
      Math.cos(dLon);

  return normalizeBearing(
    (Math.atan2(y, x) * 180) /
      Math.PI
  );
}


function angleDiffDeg(a, b) {
  const diff =
    Math.abs(
      normalizeBearing(a) -
        normalizeBearing(b)
    );

  return Math.min(
    diff,
    360 - diff
  );
}


function pointToSegmentDistanceKm(
  point,
  a,
  b
) {
  const refLat =
    ((point.lat + a.lat + b.lat) /
      3) *
    Math.PI /
    180;

  const kmPerDegLat =
    111.32;

  const kmPerDegLon =
    111.32 *
    Math.cos(refLat);

  const px =
    point.lon *
    kmPerDegLon;

  const py =
    point.lat *
    kmPerDegLat;

  const ax =
    a.lon *
    kmPerDegLon;

  const ay =
    a.lat *
    kmPerDegLat;

  const bx =
    b.lon *
    kmPerDegLon;

  const by =
    b.lat *
    kmPerDegLat;

  const abx =
    bx - ax;

  const aby =
    by - ay;

  const apx =
    px - ax;

  const apy =
    py - ay;

  const denom =
    abx * abx +
    aby * aby;

  const t =
    denom > 0
      ? Math.max(
          0,
          Math.min(
            1,
            (
              apx * abx +
              apy * aby
            ) /
              denom
          )
        )
      : 0;

  const dx =
    px -
    (ax + t * abx);

  const dy =
    py -
    (ay + t * aby);

  return Math.sqrt(
    dx * dx +
    dy * dy
  );
}


function getTrafficList(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (
    Array.isArray(
      data?.LiveTraffics
    )
  ) {
    return data.LiveTraffics;
  }

  if (
    Array.isArray(
      data?.data
    )
  ) {
    return data.data;
  }

  return [];
}


function normalizeDecodedPolyline(
  decoded
) {
  if (!Array.isArray(decoded)) {
    return [];
  }

  return decoded
    .map((point) => {
      if (
        Array.isArray(point)
      ) {
        const lon =
          Number(point[0]);

        const lat =
          Number(point[1]);

        return (
          Number.isFinite(lon) &&
          Number.isFinite(lat)
        )
          ? { lon, lat }
          : null;
      }

      const lon =
        Number(
          point?.lon ??
          point?.lng
        );

      const lat =
        Number(
          point?.lat
        );

      return (
        Number.isFinite(lon) &&
        Number.isFinite(lat)
      )
        ? { lon, lat }
        : null;
    })
    .filter(Boolean);
}


function liveAgeMin(value) {
  const ms =
    Date.parse(
      value || ""
    );

  return Number.isFinite(ms)
    ? (Date.now() - ms) /
        60000
    : null;
}


function isFresh(
  value,
  maxAgeMin
) {
  const age =
    liveAgeMin(value);

  if (age === null) {
    return true;
  }

  return (
    age >= -2 &&
    age <= maxAgeMin
  );
}


function gridKey(x, y) {
  return `${x}:${y}`;
}


function addSegmentToGrid(
  grid,
  cellDeg,
  segment
) {
  const minLon =
    Math.min(
      segment.a.lon,
      segment.b.lon
    );

  const maxLon =
    Math.max(
      segment.a.lon,
      segment.b.lon
    );

  const minLat =
    Math.min(
      segment.a.lat,
      segment.b.lat
    );

  const maxLat =
    Math.max(
      segment.a.lat,
      segment.b.lat
    );

  const minX =
    Math.floor(
      minLon / cellDeg
    );

  const maxX =
    Math.floor(
      maxLon / cellDeg
    );

  const minY =
    Math.floor(
      minLat / cellDeg
    );

  const maxY =
    Math.floor(
      maxLat / cellDeg
    );

  for (
    let x = minX;
    x <= maxX;
    x += 1
  ) {
    for (
      let y = minY;
      y <= maxY;
      y += 1
    ) {
      const key =
        gridKey(x, y);

      if (!grid.has(key)) {
        grid.set(
          key,
          []
        );
      }

      grid
        .get(key)
        .push(segment);
    }
  }
}


export function buildTdxRoadIndex({
  freewayData,
  highwayData,
  openLrToPolyline,

  maxAgeMin =
    Number(
      process.env
        .TDX_LIVE_MAX_AGE_MIN ||
      20
    ),

  cellDeg = 0.004
}) {
  const grid =
    new Map();

  let segmentCount = 0;

  const rawSections = [
    ...getTrafficList(
      freewayData
    ),

    ...getTrafficList(
      highwayData
    )
  ];


  for (
    const section
    of rawSections
  ) {
    const speed =
      Number(
        section?.TravelSpeed ??
        section?.travelSpeed ??
        section?.Speed ??
        section?.speed
      );


    if (
      !Number.isFinite(speed) ||
      speed < 1 ||
      speed > 160
    ) {
      continue;
    }


    const dataCollectTime =
      section?.DataCollectTime ||
      section?.UpdateTime ||
      null;


    if (
      !isFresh(
        dataCollectTime,
        maxAgeMin
      )
    ) {
      continue;
    }


    const openLRs =
      section?.OpenLRs ||
      section?.openLRs ||
      [];


    if (
      !Array.isArray(
        openLRs
      )
    ) {
      continue;
    }


    for (
      const item
      of openLRs
    ) {
      try {
        const encoded =
          item?.OpenLR ||
          item?.openLR ||
          item;


        const line =
          normalizeDecodedPolyline(
            openLrToPolyline(
              encoded
            )
          );


        for (
          let i = 1;
          i < line.length;
          i += 1
        ) {
          const a =
            line[i - 1];

          const b =
            line[i];


          const km =
            haversineKm(
              a.lat,
              a.lon,
              b.lat,
              b.lon
            );


          if (
            !Number.isFinite(km) ||
            km <= 0.002
          ) {
            continue;
          }


          const segment = {
            a,
            b,

            bearing:
              bearingDeg(
                a,
                b
              ),

            observedSpeedKmh:
              speed,

            sectionId:
              section?.SectionID ||
              section?.SectionUID ||
              null,

            sectionName:
              section?.SectionName ||
              null,

            dataCollectTime,

            observedFrom:
              "TravelSpeed",

            source:
              "TDX freeway/highway LiveTraffic"
          };


          addSegmentToGrid(
            grid,
            cellDeg,
            segment
          );


          segmentCount += 1;
        }
      } catch {
        // 單一 OpenLR decode 失敗不影響其他道路。
      }
    }
  }


  return {
    grid,
    cellDeg,
    segmentCount
  };
}


function candidatesNear(
  point,
  index
) {
  if (
    !index?.grid ||
    !index?.cellDeg
  ) {
    return [];
  }


  const x =
    Math.floor(
      point.lon /
      index.cellDeg
    );

  const y =
    Math.floor(
      point.lat /
      index.cellDeg
    );


  const out = [];
  const seen =
    new Set();


  for (
    let dx = -1;
    dx <= 1;
    dx += 1
  ) {
    for (
      let dy = -1;
      dy <= 1;
      dy += 1
    ) {
      for (
        const item
        of (
          index.grid.get(
            gridKey(
              x + dx,
              y + dy
            )
          ) || []
        )
      ) {
        if (
          seen.has(item)
        ) {
          continue;
        }

        seen.add(item);
        out.push(item);
      }
    }
  }


  return out;
}


function findMatch(
  point,
  routeBearing,
  index,
  thresholdKm,
  maxDirectionDiffDeg
) {
  let best = null;

  let bestDistanceKm =
    Infinity;


  for (
    const segment
    of candidatesNear(
      point,
      index
    )
  ) {
    if (
      !Number.isFinite(
        Number(
          segment
            ?.observedSpeedKmh
        )
      )
    ) {
      continue;
    }


    if (
      angleDiffDeg(
        routeBearing,
        segment.bearing
      ) >
      maxDirectionDiffDeg
    ) {
      continue;
    }


    const distanceKm =
      pointToSegmentDistanceKm(
        point,
        segment.a,
        segment.b
      );


    if (
      distanceKm <=
        thresholdKm &&
      distanceKm <
        bestDistanceKm
    ) {
      bestDistanceKm =
        distanceKm;

      best =
        segment;
    }
  }


  return best
    ? {
        ...best,

        matchDistanceKm:
          bestDistanceKm
      }
    : null;
}


function lineSegments(
  coords,
  totalDurationSec,
  roadName = ""
) {
  if (
    !Array.isArray(coords) ||
    coords.length < 2
  ) {
    return [];
  }


  const raw = [];
  let totalKm = 0;


  for (
    let i = 1;
    i < coords.length;
    i += 1
  ) {
    const a = {
      lon:
        Number(
          coords[i - 1]?.[0]
        ),

      lat:
        Number(
          coords[i - 1]?.[1]
        )
    };


    const b = {
      lon:
        Number(
          coords[i]?.[0]
        ),

      lat:
        Number(
          coords[i]?.[1]
        )
    };


    if (
      ![
        a.lon,
        a.lat,
        b.lon,
        b.lat
      ].every(
        Number.isFinite
      )
    ) {
      continue;
    }


    const km =
      haversineKm(
        a.lat,
        a.lon,
        b.lat,
        b.lon
      );


    if (
      !Number.isFinite(km) ||
      km <= 0
    ) {
      continue;
    }


    raw.push({
      a,
      b,
      km
    });

    totalKm += km;
  }


  if (
    !raw.length ||
    totalKm <= 0
  ) {
    return [];
  }


  return raw.map(
    (item) => ({
      ...item,

      roadName:
        String(
          roadName ||
          ""
        ),

      midpoint: {
        lon:
          (
            item.a.lon +
            item.b.lon
          ) / 2,

        lat:
          (
            item.a.lat +
            item.b.lat
          ) / 2
      },

      bearing:
        bearingDeg(
          item.a,
          item.b
        ),

      // 這不是交通係數。
      // 只是把 OSRM 這個 step 的真實 duration
      // 按該 step 的 geometry 分配到小段。
      baselineSec:
        Number(
          totalDurationSec
        ) *
        (
          item.km /
          totalKm
        )
    })
  );
}


function buildRouteSegments(
  route
) {
  const segments = [];

  const steps =
    (route?.legs || [])
      .flatMap(
        (leg) =>
          leg?.steps ||
          []
      );


  for (
    const step
    of steps
  ) {
    const durationSec =
      Number(
        step?.duration
      );

    const coords =
      step?.geometry
        ?.coordinates;


    if (
      !Number.isFinite(
        durationSec
      ) ||
      durationSec < 0
    ) {
      continue;
    }


    segments.push(
      ...lineSegments(
        coords,
        durationSec,
        step?.name || ""
      )
    );
  }


  if (
    segments.length
  ) {
    return segments;
  }


  return lineSegments(
    route?.geometry
      ?.coordinates ||
      [],

    Number(
      route?.duration ||
      0
    ),
    ""
  );
}


function latestIso(items) {
  let best = null;

  let bestMs =
    -Infinity;


  for (
    const item
    of items
  ) {
    const value =
      item?.dataCollectTime ||
      item?.DataCollectTime ||
      null;


    const ms =
      Date.parse(
        value || ""
      );


    if (
      Number.isFinite(ms) &&
      ms > bestMs
    ) {
      bestMs = ms;
      best = value;
    }
  }


  return best;
}


function round(
  value,
  digits = 2
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return null;
  }


  const p =
    10 ** digits;

  return (
    Math.round(
      n * p
    ) / p
  );
}



export function buildTdxVdIndex(
  observations,
  cellDeg = 0.003
) {
  const grid =
    new Map();

  let pointCount =
    0;


  for (
    const item
    of (
      observations ||
      []
    )
  ) {
    const lat =
      Number(item?.lat);

    const lon =
      Number(item?.lon);

    const speed =
      Number(
        item
          ?.observedSpeedKmh
      );


    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(speed) ||
      speed < 1 ||
      speed > 160
    ) {
      continue;
    }


    const x =
      Math.floor(
        lon /
        cellDeg
      );

    const y =
      Math.floor(
        lat /
        cellDeg
      );

    const key =
      gridKey(x, y);


    if (
      !grid.has(key)
    ) {
      grid.set(
        key,
        []
      );
    }


    grid.get(key).push({
      ...item,

      lat,
      lon,

      sectionId:
        `VD:${item.vdId || "unknown"}`,

      sectionName:
        item.roadName ||
        null,

      source:
        "TDX City VD Live"
    });


    pointCount += 1;
  }


  return {
    grid,
    cellDeg,
    pointCount
  };
}


function normalizedRoadName(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("臺", "台")
    .replace(
      /[\s\-_/()（）]/g,
      ""
    )
    .trim();
}


function vdRoadCompatible(
  routeRoad,
  vdRoad
) {
  const a =
    normalizedRoadName(
      routeRoad
    );

  const b =
    normalizedRoadName(
      vdRoad
    );


  if (!a || !b) {
    return true;
  }


  /*
    市民大道 ≠ 市民大道高架道路。

    這是為了避免把高架道路 VD
    套到下面平面道路。
  */

  const aElevated =
    a.includes("高架");

  const bElevated =
    b.includes("高架");


  if (
    aElevated !==
    bElevated
  ) {
    return false;
  }


  return (
    a === b ||
    a.includes(b) ||
    b.includes(a)
  );
}


function findVdMatch(
  point,
  routeBearing,
  routeRoadName,
  index,
  thresholdKm = 0.08,
  maxDirectionDiffDeg = 35
) {
  if (
    !index?.grid ||
    !index?.cellDeg
  ) {
    return null;
  }


  const x =
    Math.floor(
      point.lon /
      index.cellDeg
    );

  const y =
    Math.floor(
      point.lat /
      index.cellDeg
    );


  let best =
    null;

  let bestKm =
    Infinity;


  for (
    let dx = -1;
    dx <= 1;
    dx += 1
  ) {
    for (
      let dy = -1;
      dy <= 1;
      dy += 1
    ) {
      const list =
        index.grid.get(
          gridKey(
            x + dx,
            y + dy
          )
        ) ||
        [];


      for (
        const vd
        of list
      ) {

        if (
          !vdRoadCompatible(
            routeRoadName,
            vd.roadName
          )
        ) {
          continue;
        }


        if (
          Number.isFinite(
            Number(
              vd.bearing
            )
          ) &&
          angleDiffDeg(
            routeBearing,
            Number(
              vd.bearing
            )
          ) >
          maxDirectionDiffDeg
        ) {
          continue;
        }


        const km =
          haversineKm(
            point.lat,
            point.lon,
            vd.lat,
            vd.lon
          );


        if (
          km <= thresholdKm &&
          km < bestKm
        ) {
          bestKm =
            km;

          best =
            vd;
        }
      }
    }
  }


  return best
    ? {
        ...best,

        matchDistanceKm:
          bestKm
      }
    : null;
}


export function calculateTdxHybridEta({
  route,
  cityIndex,
  roadIndex,
  vdIndex,

  cityMatchThresholdKm =
    0.05,

  roadMatchThresholdKm =
    0.06,

  vdMatchThresholdKm =
    0.08,

  maxDirectionDiffDeg =
    35
}) {
  const routeSegments =
    buildRouteSegments(
      route
    );


  const baseOsrmSec =
    Number(
      route?.duration ||
      0
    );


  const routeDistanceKm =
    Number(
      route?.distance ||
      0
    ) / 1000;


  if (
    !routeSegments.length ||
    baseOsrmSec <= 0 ||
    routeDistanceKm <= 0
  ) {
    return {
      expectedMin:
        baseOsrmSec / 60,

      baseOsrmMin:
        baseOsrmSec / 60,

      tdxCoverageRatio: 0,

      matchedDistanceKm: 0,

      tdxObservedMin: 0,

      osrmFallbackMin:
        baseOsrmSec / 60,

      osrmBaselineOnMatchedMin:
        0,

      delayMin: 0,

      matchedCount: 0,

      matchedSections: [],

      latestLiveDataTime:
        null,

      source:
        "OSRM baseline only"
    };
  }


  /*
    OSRM step duration 加總理論上會等於 route.duration。
    這個 scale 只處理 OSRM geometry 小數誤差，
    不是交通修正。
  */

  const decomposedBaselineSec =
    routeSegments.reduce(
      (sum, segment) =>
        sum +
        segment.baselineSec,
      0
    );


  const baselineScale =
    decomposedBaselineSec > 0
      ? baseOsrmSec /
        decomposedBaselineSec
      : 1;


  let expectedSec = 0;

  let tdxObservedSec = 0;

  let osrmFallbackSec = 0;

  let matchedBaselineSec = 0;

  let matchedDistanceKm = 0;

  let matchedCount = 0;


  const sectionMap =
    new Map();


  for (
    const segment
    of routeSegments
  ) {
    const baselineSec =
      segment.baselineSec *
      baselineScale;


    const cityMatch =
      findMatch(
        segment.midpoint,
        segment.bearing,
        cityIndex,
        cityMatchThresholdKm,
        maxDirectionDiffDeg
      );


    const roadMatch =
      findMatch(
        segment.midpoint,
        segment.bearing,
        roadIndex,
        roadMatchThresholdKm,
        maxDirectionDiffDeg
      );


    /*
      同一小段最多只能吃一次 TDX。

      如果 City 與 Highway 同時命中，
      只選幾何距離最近的資料。
    */

    let match = null;


    if (
      cityMatch &&
      roadMatch
    ) {
      match =
        cityMatch
          .matchDistanceKm <=
        roadMatch
          .matchDistanceKm
          ? cityMatch
          : roadMatch;
    } else {
      match =
        cityMatch ||
        roadMatch;
    }


    /*
      IMPORTANT:

      VD 是「點位速度」，不是整段 TravelTime。

      所以在還沒有把 VD DetectionLinks.LinkID
      精確對到 TDX 路網 Link geometry 前，
      VD 不可以直接取代 route segment ETA。

      VD 仍然會被下載、記錄、顯示，
      但 Expected ETA 只使用：

      1. TDX City published LiveTraffic
      2. TDX Freeway / Highway LiveTraffic
      3. OSRM only for genuinely uncovered pieces

      這樣不會因為附近某支 VD 量到 65 km/h，
      就把周圍道路全部算成 65 km/h。
    */

    const vdDiagnosticMatch =
      !match
        ? findVdMatch(
            segment.midpoint,
            segment.bearing,
            segment.roadName,
            vdIndex,
            vdMatchThresholdKm,
            maxDirectionDiffDeg
          )
        : null;


    const speed =
      Number(
        match
          ?.observedSpeedKmh
      );


    if (
      match &&
      Number.isFinite(speed) &&
      speed >= 1 &&
      speed <= 160
    ) {
      /*
        這裡直接使用 TDX 發布的 observed speed。
        不再：
        Math.min(OSRM...)
        Math.max(15,...)
        × peak factor
        × congestion factor
      */

      const observedSec =
        (
          segment.km /
          speed
        ) *
        3600;


      expectedSec +=
        observedSec;

      tdxObservedSec +=
        observedSec;

      matchedBaselineSec +=
        baselineSec;

      matchedDistanceKm +=
        segment.km;

      matchedCount += 1;


      const key =
        `${
          match.source ||
          match.city ||
          "TDX"
        }:${
          match.sectionId ||
          "unknown"
        }`;


      const current =
        sectionMap.get(key) ||
        {
          source:
            match.source ||
            (
              match.city
                ? `TDX ${match.city} City LiveTraffic`
                : "TDX LiveTraffic"
            ),

          city:
            match.city ||
            null,

          sectionId:
            match.sectionId ||
            null,

          sectionName:
            match.sectionName ||
            null,

          observedFrom:
            match.observedFrom ||
            null,

          observedSpeedKmh:
            speed,

          dataCollectTime:
            match.dataCollectTime ||
            null,

          matchedDistanceKm:
            0,

          nearestMatchKm:
            Infinity
        };


      current.matchedDistanceKm +=
        segment.km;


      current.nearestMatchKm =
        Math.min(
          current.nearestMatchKm,
          match.matchDistanceKm
        );


      sectionMap.set(
        key,
        current
      );

    } else {
      /*
        沒有可靠 TDX match：
        保留這一小段原本 OSRM step duration。
      */

      expectedSec +=
        baselineSec;

      osrmFallbackSec +=
        baselineSec;
    }
  }


  const coverage =
    Math.max(
      0,
      Math.min(
        1,
        matchedDistanceKm /
          routeDistanceKm
      )
    );


  const matchedSections =
    [
      ...sectionMap.values()
    ]
      .map((item) => ({
        ...item,

        observedSpeedKmh:
          round(
            item.observedSpeedKmh,
            1
          ),

        matchedDistanceKm:
          round(
            item.matchedDistanceKm,
            3
          ),

        nearestMatchKm:
          round(
            item.nearestMatchKm,
            3
          )
      }))
      .sort(
        (a, b) =>
          b.matchedDistanceKm -
          a.matchedDistanceKm
      )
      .slice(
        0,
        30
      );


  return {
    expectedMin:
      round(
        expectedSec / 60,
        3
      ),

    baseOsrmMin:
      round(
        baseOsrmSec / 60,
        3
      ),

    tdxCoverageRatio:
      round(
        coverage,
        4
      ),

    matchedDistanceKm:
      round(
        matchedDistanceKm,
        3
      ),

    tdxObservedMin:
      round(
        tdxObservedSec / 60,
        3
      ),

    osrmFallbackMin:
      round(
        osrmFallbackSec / 60,
        3
      ),

    osrmBaselineOnMatchedMin:
      round(
        matchedBaselineSec /
        60,
        3
      ),

    delayMin:
      round(
        (
          expectedSec -
          baseOsrmSec
        ) /
        60,
        3
      ),

    matchedCount,

    matchedSections,

    latestLiveDataTime:
      latestIso(
        matchedSections
      ),

    source:
      coverage > 0
        ? "TDX City/Freeway/Highway published LiveTraffic on strictly matched road pieces + OSRM on uncovered pieces. VD is supplemental diagnostic data until exact LinkID geometry matching is implemented."
        : "OSRM baseline only — no fresh TDX road piece matched",

    matchingPolicy: {
      cityMaxDistanceM:
        cityMatchThresholdKm *
        1000,

      roadMaxDistanceM:
        roadMatchThresholdKm *
        1000,

      vdMaxDistanceM:
        vdMatchThresholdKm *
        1000,

      maxDirectionDiffDeg,

      vdRule:
        "Supplemental diagnostic only. VD spot speed is NOT currently used to replace route-segment ETA.",

      vdUsedForEta:
        false,

      oneObservationPerRoutePiece:
        true,

      arbitraryTrafficMultiplier:
        false,

      speedClampAgainstOsrm:
        false
    }
  };
}
