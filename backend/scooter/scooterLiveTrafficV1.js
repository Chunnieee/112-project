/*
 * SCOOTER_LIVE_TRAFFIC_V1
 *
 * IMPORTANT
 * ---------
 * This module is READ-ONLY with respect to the existing car ETA system.
 *
 * It:
 *   - reads TDX Freeway / Highway live traffic
 *   - matches it against the scooter route geometry
 *   - uses strict geometry + direction checks
 *   - returns congestionSegments for visualization
 *
 * It does NOT:
 *   - write V9
 *   - use car calibration
 *   - use historical data
 *   - change scooter ETA yet
 *   - use nearest VD
 *   - fabricate traffic where TDX has no evidence
 */

import {
  getFreewayLiveTraffic,
  getHighwayLiveTraffic,
  openLrToPolyline,
} from "../tdxClient.js";

import {
  loadScooterCityLiveSegmentsV2,
} from "./scooterCityLiveV2.js";

// SCOOTER_CITY_LIVE_V2

const EARTH_RADIUS_KM = 6371;

function toRad(value) {
  return (
    Number(value) *
    Math.PI /
    180
  );
}

function haversineKm(
  a,
  b
) {
  const lat1 =
    Number(a?.lat);

  const lon1 =
    Number(a?.lon);

  const lat2 =
    Number(b?.lat);

  const lon2 =
    Number(b?.lon);

  if (
    ![
      lat1,
      lon1,
      lat2,
      lon2,
    ].every(Number.isFinite)
  ) {
    return Infinity;
  }

  const dLat =
    toRad(
      lat2 - lat1
    );

  const dLon =
    toRad(
      lon2 - lon1
    );

  const x =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      toRad(lat1)
    ) *
      Math.cos(
        toRad(lat2)
      ) *
      Math.sin(
        dLon / 2
      ) ** 2;

  return (
    2 *
    EARTH_RADIUS_KM *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(
        1 - x
      )
    )
  );
}

function bearingDeg(
  a,
  b
) {
  const lat1 =
    toRad(a.lat);

  const lat2 =
    toRad(b.lat);

  const dLon =
    toRad(
      b.lon -
      a.lon
    );

  const y =
    Math.sin(dLon) *
    Math.cos(lat2);

  const x =
    Math.cos(lat1) *
      Math.sin(lat2) -
    Math.sin(lat1) *
      Math.cos(lat2) *
      Math.cos(dLon);

  const deg =
    Math.atan2(
      y,
      x
    ) *
    180 /
    Math.PI;

  return (
    deg +
    360
  ) % 360;
}

function angleDiffDeg(
  a,
  b
) {
  const raw =
    Math.abs(
      Number(a) -
      Number(b)
    ) % 360;

  return Math.min(
    raw,
    360 - raw
  );
}

function midpoint(
  a,
  b
) {
  return {
    lon:
      (
        Number(a.lon) +
        Number(b.lon)
      ) /
      2,

    lat:
      (
        Number(a.lat) +
        Number(b.lat)
      ) /
      2,
  };
}

/*
 * Short-distance local projection.
 * Good enough for ~60 m matching thresholds.
 */
function pointToSegmentDistanceKm(
  p,
  a,
  b
) {
  const lat0 =
    toRad(
      (
        Number(p.lat) +
        Number(a.lat) +
        Number(b.lat)
      ) /
      3
    );

  const scaleX =
    111.32 *
    Math.cos(lat0);

  const scaleY =
    110.57;

  const px =
    (
      Number(p.lon) -
      Number(a.lon)
    ) *
    scaleX;

  const py =
    (
      Number(p.lat) -
      Number(a.lat)
    ) *
    scaleY;

  const bx =
    (
      Number(b.lon) -
      Number(a.lon)
    ) *
    scaleX;

  const by =
    (
      Number(b.lat) -
      Number(a.lat)
    ) *
    scaleY;

  const denom =
    bx * bx +
    by * by;

  if (
    !Number.isFinite(
      denom
    ) ||
    denom <= 0
  ) {
    return haversineKm(
      p,
      a
    );
  }

  const t =
    Math.max(
      0,
      Math.min(
        1,
        (
          px * bx +
          py * by
        ) /
        denom
      )
    );

  const dx =
    px -
    t * bx;

  const dy =
    py -
    t * by;

  return Math.sqrt(
    dx * dx +
    dy * dy
  );
}

function trafficList(
  data
) {
  if (
    Array.isArray(data)
  ) {
    return data;
  }

  const keys = [
    "LiveTraffics",
    "liveTraffics",
    "TrafficData",
    "data",
  ];

  for (
    const key
    of keys
  ) {
    if (
      Array.isArray(
        data?.[key]
      )
    ) {
      return data[key];
    }
  }

  return [];
}

function normalizePolyline(
  raw
) {
  if (
    !Array.isArray(raw)
  ) {
    return [];
  }

  return raw
    .map(
      (point) => {
        if (
          Array.isArray(point)
        ) {
          const first =
            Number(point[0]);

          const second =
            Number(point[1]);

          if (
            !Number.isFinite(first) ||
            !Number.isFinite(second)
          ) {
            return null;
          }

          /*
           * tdxClient openLR decoder may use
           * {lat,lon} or [lon,lat].
           */
          return {
            lon:
              first,
            lat:
              second,
          };
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

        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat)
        ) {
          return null;
        }

        return {
          lon,
          lat,
        };
      }
    )
    .filter(Boolean);
}

function isFresh(
  value,
  maxAgeMinutes = 20
) {
  if (!value) {
    return true;
  }

  const ms =
    Date.parse(value);

  if (
    !Number.isFinite(ms)
  ) {
    return true;
  }

  const ageMs =
    Date.now() -
    ms;

  return (
    ageMs >=
      -5 * 60 * 1000 &&
    ageMs <=
      maxAgeMinutes *
        60 *
        1000
  );
}

function severityFromSpeed({
  observedSpeedKmh,
  scooterBaselineSpeedKmh,
}) {
  const observed =
    Number(
      observedSpeedKmh
    );

  const baseline =
    Number(
      scooterBaselineSpeedKmh
    );

  if (
    !Number.isFinite(
      observed
    ) ||
    observed <= 0 ||
    !Number.isFinite(
      baseline
    ) ||
    baseline <= 0
  ) {
    return null;
  }

  const ratio =
    observed /
    baseline;

  /*
   * V1 visualization thresholds.
   *
   * These are NOT legal definitions and NOT TDX LOS.
   * They only express how slow the observed roadway
   * traffic is relative to this scooter route baseline.
   */
  if (
    ratio <= 0.45
  ) {
    return "heavy";
  }

  if (
    ratio <= 0.70
  ) {
    return "moderate";
  }

  return null;
}

function buildObservedSegments(
  freewayData,
  highwayData
) {
  const output = [];

  const sources = [
    {
      type:
        "freeway",

      data:
        freewayData,
    },

    {
      type:
        "highway",

      data:
        highwayData,
    },
  ];

  for (
    const source
    of sources
  ) {
    for (
      const section
      of trafficList(
        source.data
      )
    ) {
      const speed =
        Number(
          section
            ?.TravelSpeed ??
          section
            ?.travelSpeed ??
          section
            ?.Speed ??
          section
            ?.speed
        );

      if (
        !Number.isFinite(
          speed
        ) ||
        speed < 1 ||
        speed > 160
      ) {
        continue;
      }

      const dataCollectTime =
        section
          ?.DataCollectTime ??
        section
          ?.UpdateTime ??
        null;

      if (
        !isFresh(
          dataCollectTime
        )
      ) {
        continue;
      }

      const openLRs =
        section
          ?.OpenLRs ??
        section
          ?.openLRs ??
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
            item?.OpenLR ??
            item?.openLR ??
            item;

          const decoded =
            normalizePolyline(
              openLrToPolyline(
                encoded
              )
            );

          for (
            let i = 1;
            i <
            decoded.length;
            i += 1
          ) {
            const a =
              decoded[i - 1];

            const b =
              decoded[i];

            const km =
              haversineKm(
                a,
                b
              );

            if (
              !Number.isFinite(
                km
              ) ||
              km <
                0.002
            ) {
              continue;
            }

            output.push({
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
                section
                  ?.SectionID ??
                section
                  ?.SectionUID ??
                null,

              sectionName:
                section
                  ?.SectionName ??
                section
                  ?.RoadName ??
                null,

              dataCollectTime,

              roadType:
                source.type,

              source:
                "TDX LiveTraffic",
            });
          }
        } catch {
          /*
           * One malformed OpenLR must not
           * kill scooter routing.
           */
        }
      }
    }
  }

  return output;
}

function routeSegments(
  route
) {
  const coords =
    route
      ?.geometry
      ?.coordinates;

  if (
    !Array.isArray(
      coords
    ) ||
    coords.length <
      2
  ) {
    return [];
  }

  const output = [];

  for (
    let i = 1;
    i <
    coords.length;
    i += 1
  ) {
    const aRaw =
      coords[i - 1];

    const bRaw =
      coords[i];

    if (
      !Array.isArray(
        aRaw
      ) ||
      !Array.isArray(
        bRaw
      )
    ) {
      continue;
    }

    const a = {
      lon:
        Number(aRaw[0]),

      lat:
        Number(aRaw[1]),
    };

    const b = {
      lon:
        Number(bRaw[0]),

      lat:
        Number(bRaw[1]),
    };

    if (
      ![
        a.lon,
        a.lat,
        b.lon,
        b.lat,
      ].every(
        Number.isFinite
      )
    ) {
      continue;
    }

    const km =
      haversineKm(
        a,
        b
      );

    if (
      !Number.isFinite(
        km
      ) ||
      km <= 0
    ) {
      continue;
    }

    output.push({
      a,
      b,
      km,

      midpoint:
        midpoint(
          a,
          b
        ),

      bearing:
        bearingDeg(
          a,
          b
        ),

      geometry: {
        type:
          "LineString",

        coordinates: [
          [
            a.lon,
            a.lat,
          ],
          [
            b.lon,
            b.lat,
          ],
        ],
      },
    });
  }

  return output;
}

function findBestMatch(
  routeSegment,
  observedSegments,
  {
    maxDistanceKm =
      0.06,

    maxDirectionDiffDeg =
      35,
  } = {}
) {
  let best = null;

  let bestDistance =
    Infinity;

  for (
    const observed
    of observedSegments
  ) {
    const directionDiff =
      angleDiffDeg(
        routeSegment
          .bearing,
        observed
          .bearing
      );

    if (
      directionDiff >
      maxDirectionDiffDeg
    ) {
      continue;
    }

    const distance =
      pointToSegmentDistanceKm(
        routeSegment
          .midpoint,
        observed.a,
        observed.b
      );

    const effectiveMaxDistanceKm =
      Number.isFinite(
        Number(
          observed
            ?.matchThresholdKm
        )
      )
        ? Math.min(
            maxDistanceKm,
            Number(
              observed
                .matchThresholdKm
            )
          )
        : maxDistanceKm;

    if (
      distance >
        effectiveMaxDistanceKm ||
      distance >=
        bestDistance
    ) {
      continue;
    }

    bestDistance =
      distance;

    best = {
      ...observed,

      matchDistanceKm:
        distance,

      directionDiffDeg:
        directionDiff,
    };
  }

  return best;
}

function mergeCongestionSegments(
  segments
) {
  if (
    !segments.length
  ) {
    return [];
  }

  const output = [];

  for (
    const segment
    of segments
  ) {
    const previous =
      output[
        output.length -
        1
      ];

    const sameEvidence =
      previous &&
      previous.severity ===
        segment.severity &&
      previous.sectionId ===
        segment.sectionId &&
      previous.roadType ===
        segment.roadType;

    if (
      !sameEvidence
    ) {
      output.push({
        ...segment,

        geometry: {
          type:
            "LineString",

          coordinates:
            [
              ...segment
                .geometry
                .coordinates,
            ],
        },
      });

      continue;
    }

    const coords =
      previous
        .geometry
        .coordinates;

    const addition =
      segment
        .geometry
        .coordinates;

    coords.push(
      addition[
        addition.length -
        1
      ]
    );

    previous.distanceKm +=
      segment.distanceKm;
  }

  return output.map(
    (item) => ({
      ...item,

      distanceKm:
        Number(
          item
            .distanceKm
            .toFixed(3)
        ),

      observedSpeedKmh:
        Number(
          item
            .observedSpeedKmh
            .toFixed(1)
        ),

      matchDistanceKm:
        Number(
          item
            .matchDistanceKm
            .toFixed(3)
        ),
    })
  );
}

export async function applyScooterLiveTrafficV1(
  route
) {
  const [
    freewayResult,
    highwayResult,
    cityResult,
  ] =
    await Promise.allSettled([
      getFreewayLiveTraffic(),
      getHighwayLiveTraffic(),
      loadScooterCityLiveSegmentsV2(
        route
      ),
    ]);

  const freewayData =
    freewayResult.status ===
    "fulfilled"
      ? freewayResult.value
      : null;

  const highwayData =
    highwayResult.status ===
    "fulfilled"
      ? highwayResult.value
      : null;

  const roadObservedSegments =
    buildObservedSegments(
      freewayData,
      highwayData
    );

  const cityObservedSegments =
    cityResult.status ===
      "fulfilled" &&
    Array.isArray(
      cityResult.value
        ?.segments
    )
      ? cityResult.value.segments
      : [];

  const observedSegments = [
    ...cityObservedSegments,
    ...roadObservedSegments,
  ];

  const chunks =
    routeSegments(
      route
    );

  const routeDistanceKm =
    Number(
      route?.distance ||
      0
    ) /
    1000;

  const routeDurationSec =
    Number(
      route?.duration ||
      0
    );

  const scooterBaselineSpeedKmh =
    routeDurationSec > 0 &&
    routeDistanceKm > 0
      ? (
          routeDistanceKm /
          (
            routeDurationSec /
            3600
          )
        )
      : null;

  const matched = [];

  let matchedDistanceKm =
    0;

  for (
    const chunk
    of chunks
  ) {
    const match =
      findBestMatch(
        chunk,
        observedSegments,
        {
          maxDistanceKm:
            0.06,

          maxDirectionDiffDeg:
            35,
        }
      );

    if (!match) {
      continue;
    }

    matchedDistanceKm +=
      chunk.km;

    const severity =
      severityFromSpeed({
        observedSpeedKmh:
          match
            .observedSpeedKmh,

        scooterBaselineSpeedKmh,
      });

    /*
     * Matched traffic that is not slower than
     * the scooter baseline is useful evidence,
     * but not a congestion overlay.
     */
    if (!severity) {
      continue;
    }

    matched.push({
      geometry:
        chunk.geometry,

      severity,

      distanceKm:
        chunk.km,

      observedSpeedKmh:
        match
          .observedSpeedKmh,

      scooterBaselineSpeedKmh,

      roadType:
        match
          .roadType,

      sectionId:
        match
          .sectionId,

      sectionName:
        match
          .sectionName,

      source:
        match
          .source,

      dataCollectTime:
        match
          .dataCollectTime,

      matchDistanceKm:
        match
          .matchDistanceKm,
    });
  }

  const congestionSegments =
    mergeCongestionSegments(
      matched
    );

  return {
    congestionSegments,

    liveTraffic: {
      version:
        "SCOOTER_LIVE_TRAFFIC_V1",

      trafficAppliedToEta:
        false,

      source:
        "TDX City + Freeway/Highway LiveTraffic",

      genericTrafficProxy:
        true,

      scooterSpecificSpeed:
        false,

      strictMatch: {
        maxDistanceM:
          60,

        maxDirectionDiffDeg:
          35,
      },

      routeDistanceKm:
        Number(
          routeDistanceKm
            .toFixed(3)
        ),

      matchedDistanceKm:
        Number(
          matchedDistanceKm
            .toFixed(3)
        ),

      matchedCoverageRatio:
        routeDistanceKm > 0
          ? Number(
              Math.min(
                1,
                matchedDistanceKm /
                  routeDistanceKm
              ).toFixed(4)
            )
          : 0,

      observedSegmentCount:
        observedSegments.length,

      cityObservedSegmentCount:
        cityObservedSegments.length,

      roadObservedSegmentCount:
        roadObservedSegments.length,

      cityStatus:
        cityResult.status,

      cityDiagnostics:
        cityResult.status ===
          "fulfilled"
          ? cityResult.value
              ?.diagnostics ||
            null
          : {
              error:
                cityResult.reason
                  ?.message ||
                String(
                  cityResult.reason ||
                  "unknown"
                ),
            },

      congestedSegmentCount:
        congestionSegments.length,

      scooterBaselineSpeedKmh:
        Number.isFinite(
          scooterBaselineSpeedKmh
        )
          ? Number(
              scooterBaselineSpeedKmh
                .toFixed(1)
            )
          : null,

      freewayStatus:
        freewayResult.status,

      highwayStatus:
        highwayResult.status,

      note:
        "TDX generic roadway traffic is used only as live congestion evidence in V1. Scooter ETA is not modified yet.",
    },
  };
}
