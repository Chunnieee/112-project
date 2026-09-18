import {
  getCityVDStatic,
  getCityVDLive,
} from "./tdxClient.js";


function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => Number(v) * Math.PI / 180;

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


function getVdList(data) {
  if (Array.isArray(data)) return data;

  for (const list of [
    data?.VDs,
    data?.VehicleDetectors,
    data?.VDList,
    data?.data,
  ]) {
    if (Array.isArray(list)) return list;
  }

  if (
    data &&
    typeof data === "object"
  ) {
    for (
      const value
      of Object.values(data)
    ) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}


function getPosition(vd) {
  const pos =
    vd?.Position ||
    vd?.VDPosition ||
    {};

  const lat =
    Number(
      pos?.PositionLat ??
      vd?.PositionLat
    );

  const lon =
    Number(
      pos?.PositionLon ??
      vd?.PositionLon
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }

  return {
    lat,
    lon
  };
}


const BEARING = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};


function bearingDegrees(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const numeric =
    Number(value);

  if (
    Number.isFinite(numeric)
  ) {
    return (
      (numeric % 360) +
      360
    ) % 360;
  }

  const key =
    String(value)
      .trim()
      .toUpperCase();

  return (
    BEARING[key] ??
    null
  );
}


function routeSamples(routes) {
  const result = [];

  (routes || []).forEach(
    (route, routeIndex) => {

      const coords =
        route?.geometry
          ?.coordinates ||
        [];

      if (!coords.length) return;

      const step =
        Math.max(
          1,
          Math.floor(
            coords.length / 100
          )
        );

      for (
        let i = 0;
        i < coords.length;
        i += step
      ) {
        const lon =
          Number(
            coords[i]?.[0]
          );

        const lat =
          Number(
            coords[i]?.[1]
          );

        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) {
          continue;
        }

        result.push({
          lat,
          lon,
          routeIndex,

          progress:
            coords.length > 1
              ? i /
                (coords.length - 1)
              : 0
        });
      }
    }
  );

  return result;
}


function selectNearbyVds(
  vds,
  samples,
  maxKm
) {
  const result = [];

  for (const vd of vds) {
    const pos =
      getPosition(vd);

    const vdId =
      String(
        vd?.VDID ||
        ""
      ).trim();

    if (
      !pos ||
      !vdId
    ) {
      continue;
    }


    let nearestKm =
      Infinity;

    let nearestSample =
      null;


    for (
      const sample
      of samples
    ) {
      const km =
        distanceKm(
          pos.lat,
          pos.lon,
          sample.lat,
          sample.lon
        );

      if (
        km <
        nearestKm
      ) {
        nearestKm =
          km;

        nearestSample =
          sample;
      }
    }


    if (
      nearestKm >
      maxKm
    ) {
      continue;
    }


    result.push({
      vd,
      pos,
      nearestKm,

      routeIndex:
        nearestSample?.routeIndex ??
        0,

      bin:
        Math.min(
          11,
          Math.max(
            0,
            Math.floor(
              (
                nearestSample?.progress ||
                0
              ) *
              12
            )
          )
        )
    });
  }


  /*
    不把所有 request 都浪費在同一小區域。

    每一段路先挑距離最近的一支 VD。
  */

  const byBin =
    new Map();


  for (
    const item
    of result
  ) {
    const key =
      `${item.routeIndex}:${item.bin}`;

    const old =
      byBin.get(key);

    if (
      !old ||
      item.nearestKm <
      old.nearestKm
    ) {
      byBin.set(
        key,
        item
      );
    }
  }


  return [
    ...byBin.values()
  ].sort(
    (a, b) =>
      a.nearestKm -
      b.nearestKm
  );
}


function laneReading(lanes) {
  const valid =
    (lanes || []).filter(
      (lane) => {

        const speed =
          Number(
            lane?.Speed
          );

        const error =
          String(
            lane?.ErrorType ||
            ""
          )
            .trim()
            .toLowerCase();

        return (
          Number.isFinite(speed) &&
          speed >= 1 &&
          speed <= 160 &&
          (
            !error ||
            error === "diag0"
          )
        );
      }
    );


  if (!valid.length) {
    return null;
  }


  let totalVolume = 0;
  let weightedSpeed = 0;

  let totalOccupancy = 0;
  let occupancyCount = 0;

  let simpleSpeed = 0;


  for (
    const lane
    of valid
  ) {
    const speed =
      Number(
        lane.Speed
      );

    const volume =
      (lane?.Vehicles || [])
        .map(
          (v) =>
            Number(
              v?.Volume
            )
        )
        .filter(
          (v) =>
            Number.isFinite(v) &&
            v >= 0
        )
        .reduce(
          (sum, v) =>
            sum + v,
          0
        );


    simpleSpeed +=
      speed;


    if (volume > 0) {
      weightedSpeed +=
        speed *
        volume;

      totalVolume +=
        volume;
    }


    const occupancy =
      Number(
        lane?.Occupancy
      );

    if (
      Number.isFinite(
        occupancy
      )
    ) {
      totalOccupancy +=
        occupancy;

      occupancyCount +=
        1;
    }
  }


  return {
    speedKmh:
      totalVolume > 0
        ? weightedSpeed /
          totalVolume
        : simpleSpeed /
          valid.length,

    occupancy:
      occupancyCount
        ? totalOccupancy /
          occupancyCount
        : null,

    volume:
      totalVolume
  };
}


function parseLive(
  city,
  selected,
  data
) {
  const lives =
    Array.isArray(
      data?.VDLives
    )
      ? data.VDLives
      : [];


  const id =
    String(
      selected?.vd?.VDID ||
      ""
    );


  const live =
    lives.find(
      (item) =>
        String(
          item?.VDID ||
          ""
        ) === id
    ) ||
    lives[0];


  /*
    Status = 0 才使用。
  */

  if (
    !live ||
    Number(
      live?.Status ??
      0
    ) !== 0
  ) {
    return [];
  }


  const links =
    Array.isArray(
      selected?.vd
        ?.DetectionLinks
    )
      ? selected.vd
          .DetectionLinks
      : [];


  const observations =
    [];


  for (
    const flow
    of (
      live?.LinkFlows ||
      []
    )
  ) {
    const reading =
      laneReading(
        flow?.Lanes
      );

    if (!reading) {
      continue;
    }


    const linkId =
      String(
        flow?.LinkID ||
        ""
      );


    const staticLink =
      links.find(
        (item) =>
          String(
            item?.LinkID ||
            ""
          ) === linkId
      ) ||
      links[0] ||
      {};


    observations.push({
      city,

      vdId:
        id,

      linkId:
        linkId ||
        null,

      roadName:
        selected?.vd
          ?.RoadName ||
        null,

      roadClass:
        selected?.vd
          ?.RoadClass ??
        null,

      lat:
        selected.pos.lat,

      lon:
        selected.pos.lon,

      bearing:
        bearingDegrees(
          staticLink?.Bearing ??
          staticLink
            ?.RoadDirection
        ),

      observedSpeedKmh:
        reading.speedKmh,

      occupancy:
        reading.occupancy,

      vehicleVolume:
        reading.volume,

      observedFrom:
        "TDX VD lane Speed",

      dataCollectTime:
        live?.DataCollectTime ||
        data?.SrcUpdateTime ||
        data?.UpdateTime ||
        null
    });
  }


  return observations;
}


export async function loadRouteVdObservations({
  cities,
  routes,

  maxSensors =
    Number(
      process.env
        .TDX_VD_ROUTE_MAX_SENSORS ||
      12
    ),

  maxStaticDistanceKm =
    Number(
      process.env
        .TDX_VD_STATIC_ROUTE_MAX_KM ||
      0.22
    )
}) {

  const samples =
    routeSamples(routes);


  const diagnostics = {
    cities:
      cities || [],

    staticCount:
      0,

    nearbySensors:
      0,

    requestedSensors:
      0,

    successfulSensors:
      0,

    observations:
      0,

    errors:
      []
  };


  if (
    !samples.length ||
    !cities?.length
  ) {
    return {
      observations: [],
      diagnostics
    };
  }


  const candidates =
    [];


  for (
    const city
    of cities
  ) {
    try {
      const data =
        await getCityVDStatic(
          city
        );


      const vds =
        getVdList(data);


      diagnostics.staticCount +=
        vds.length;


      const nearby =
        selectNearbyVds(
          vds,
          samples,
          maxStaticDistanceKm
        );


      diagnostics.nearbySensors +=
        nearby.length;


      for (
        const item
        of nearby
      ) {
        candidates.push({
          ...item,
          city
        });
      }

    } catch (error) {
      diagnostics.errors.push(
        `${city} static: ${error.message}`
      );
    }
  }


  /*
    最多只打 12 支 VD。

    原因不是資料不想用，
    是 TDX 有 rate limit。

    靜態資料已先把離路線太遠的 VD 全部排除。
  */

  candidates.sort(
    (a, b) =>
      a.nearestKm -
      b.nearestKm
  );


  const selected =
    [];

  const used =
    new Set();


  for (
    const item
    of candidates
  ) {
    if (
      selected.length >=
      maxSensors
    ) {
      break;
    }

    const key =
      `${item.city}:${item.vd.VDID}`;

    if (
      used.has(key)
    ) {
      continue;
    }

    used.add(key);

    selected.push(
      item
    );
  }


  diagnostics.requestedSensors =
    selected.length;


  const observations =
    [];


  /*
    故意 sequential。
    tdxClient 本身也有 queue，
    這樣比較不容易再次 429。
  */

  for (
    const selectedVd
    of selected
  ) {
    try {

      const live =
        await getCityVDLive(
          selectedVd.city,
          selectedVd.vd.VDID
        );


      const parsed =
        parseLive(
          selectedVd.city,
          selectedVd,
          live
        );


      if (
        parsed.length
      ) {
        diagnostics.successfulSensors +=
          1;
      }


      observations.push(
        ...parsed
      );

    } catch (error) {

      diagnostics.errors.push(
        `${selectedVd.city}/${selectedVd.vd.VDID}: ${error.message}`
      );


      /*
        一旦 429 就不要繼續轟 TDX。
        原本 LiveTraffic ETA 還是可以正常使用。
      */

      if (
        error?.status === 429 ||
        error?.code ===
          "TDX_RATE_LIMIT"
      ) {
        break;
      }
    }
  }


  diagnostics.observations =
    observations.length;


  return {
    observations,
    diagnostics
  };
}
