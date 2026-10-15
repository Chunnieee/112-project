/*
 * SCOOTER_CITY_LIVE_V2
 *
 * Read-only adapter around the EXISTING traffic infrastructure.
 *
 * Uses:
 * - Photon reverse geocoding
 * - routeJurisdictionV7
 * - cityCoverageV8_1
 * - TDX SectionShape / SectionLink / Live/City
 * - etaEvidenceV6 selection policy
 *
 * Does NOT write:
 * - car V9
 * - car historical
 * - car calibration
 * - scooter history
 */

import {
  getCitySectionShapes,
  getCitySectionLinks,
  getCityLiveTraffic,
} from "../tdxClient.js";

import {
  reverseGeocodeCoordinate,
} from "../placeSearchEngine.js";

import {
  resolveTaiwanJurisdictionFromReverse,
} from "../etaSystemCore.js";

import {
  resolveRouteJurisdictions,
} from "../routeJurisdictionV7.js";

import {
  loadCityPackagesResilient,
} from "../cityCoverageV8_1.js";

import {
  selectTdxLiveObservation,
} from "../etaEvidenceV6.js";

const LIVE_CITY_ALLOWLIST =
  new Set([
    "YilanCounty",
    "ChanghuaCounty",
    "YunlinCounty",
    "PingtungCounty",
    "Keelung",
    "Taipei",
    "Taichung",
    "Tainan",
    "Taoyuan",
  ]);

const R = 6371;

function rad(v) {
  return Number(v) *
    Math.PI /
    180;
}

function haversineKm(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lon);

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
    rad(lat2 - lat1);

  const dLon =
    rad(lon2 - lon1);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(1 - x)
    )
  );
}

function bearingDeg(a, b) {
  const lat1 =
    rad(a.lat);

  const lat2 =
    rad(b.lat);

  const dLon =
    rad(
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

  return (
    Math.atan2(y, x) *
      180 /
      Math.PI +
    360
  ) % 360;
}

function listFrom(
  data,
  preferred = []
) {
  if (Array.isArray(data)) {
    return data;
  }

  for (
    const key
    of preferred
  ) {
    if (
      Array.isArray(
        data?.[key]
      )
    ) {
      return data[key];
    }
  }

  if (
    data &&
    typeof data === "object"
  ) {
    for (
      const value
      of Object.values(data)
    ) {
      if (
        Array.isArray(value)
      ) {
        return value;
      }
    }
  }

  return [];
}

function normalizeId(value) {
  return String(
    value || ""
  ).trim();
}

function normalizeCoordinate(
  value
) {
  if (
    !Array.isArray(value) ||
    value.length < 2
  ) {
    return null;
  }

  const lon =
    Number(value[0]);

  const lat =
    Number(value[1]);

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

function parseCoordinateText(
  text
) {
  return String(text || "")
    .split(",")
    .map(
      (pair) => {
        const values =
          pair
            .trim()
            .split(/\s+/)
            .map(Number);

        if (
          values.length < 2 ||
          !Number.isFinite(values[0]) ||
          !Number.isFinite(values[1])
        ) {
          return null;
        }

        return {
          lon:
            values[0],

          lat:
            values[1],
        };
      }
    )
    .filter(Boolean);
}

function parseWktPolylines(
  geometry
) {
  if (!geometry) {
    return [];
  }

  if (
    typeof geometry ===
    "object"
  ) {
    const type =
      String(
        geometry?.type || ""
      ).toLowerCase();

    const coords =
      geometry?.coordinates;

    if (
      type === "linestring" &&
      Array.isArray(coords)
    ) {
      const line =
        coords
          .map(
            normalizeCoordinate
          )
          .filter(Boolean);

      return line.length >= 2
        ? [line]
        : [];
    }

    if (
      type ===
        "multilinestring" &&
      Array.isArray(coords)
    ) {
      return coords
        .map(
          (line) =>
            Array.isArray(line)
              ? line
                  .map(
                    normalizeCoordinate
                  )
                  .filter(Boolean)
              : []
        )
        .filter(
          (line) =>
            line.length >= 2
        );
    }
  }

  const text =
    String(geometry)
      .trim();

  const upper =
    text.toUpperCase();

  if (
    upper.startsWith(
      "LINESTRING"
    )
  ) {
    const start =
      text.indexOf("(");

    const end =
      text.lastIndexOf(")");

    if (
      start < 0 ||
      end <= start
    ) {
      return [];
    }

    const line =
      parseCoordinateText(
        text.slice(
          start + 1,
          end
        )
      );

    return line.length >= 2
      ? [line]
      : [];
  }

  if (
    upper.startsWith(
      "MULTILINESTRING"
    )
  ) {
    const start =
      text.indexOf("((");

    const end =
      text.lastIndexOf("))");

    if (
      start < 0 ||
      end <= start
    ) {
      return [];
    }

    return text
      .slice(
        start + 2,
        end
      )
      .split(/\)\s*,\s*\(/)
      .map(
        parseCoordinateText
      )
      .filter(
        (line) =>
          line.length >= 2
      );
  }

  return [];
}

function polylineLengthKm(
  line
) {
  let total = 0;

  for (
    let i = 1;
    i < line.length;
    i += 1
  ) {
    total +=
      haversineKm(
        line[i - 1],
        line[i]
      );
  }

  return total;
}

function latestTime(items) {
  let best =
    null;

  let bestMs =
    -Infinity;

  for (
    const item
    of items || []
  ) {
    const value =
      item
        ?.DataCollectTime ??
      item
        ?.UpdateTime ??
      item
        ?.dataCollectTime ??
      null;

    const ms =
      Date.parse(
        value || ""
      );

    if (
      Number.isFinite(ms) &&
      ms > bestMs
    ) {
      bestMs =
        ms;

      best =
        value;
    }
  }

  return best;
}

function explicitLinkIds(
  item
) {
  const output = [];

  const candidates = [
    item?.LinkIDs,
    item?.Links?.LinkIDs,
    item?.Links,
  ];

  for (
    const candidate
    of candidates
  ) {
    if (!candidate) {
      continue;
    }

    if (
      Array.isArray(candidate)
    ) {
      for (
        const value
        of candidate
      ) {
        const id =
          normalizeId(
            value?.LinkID ??
            value
          );

        if (id) {
          output.push(id);
        }
      }

      continue;
    }

    if (
      Array.isArray(
        candidate?.LinkID
      )
    ) {
      for (
        const value
        of candidate.LinkID
      ) {
        const id =
          normalizeId(
            value?.LinkID ??
            value
          );

        if (id) {
          output.push(id);
        }
      }

      continue;
    }

    const id =
      normalizeId(
        candidate?.LinkID
      );

    if (id) {
      output.push(id);
    }
  }

  return [
    ...new Set(output),
  ];
}

function buildCityPackage(
  city,
  shapeData,
  sectionLinkData,
  liveData
) {
  const shapes =
    listFrom(
      shapeData,
      [
        "SectionShapes",
        "sectionShapes",
      ]
    );

  const links =
    listFrom(
      sectionLinkData,
      [
        "SectionLinks",
        "sectionLinks",
      ]
    );

  const lives =
    listFrom(
      liveData,
      [
        "LiveTraffics",
        "liveTraffics",
      ]
    );

  const directBySection =
    new Map();

  const byLink =
    new Map();

  for (
    const live
    of lives
  ) {
    const sectionId =
      normalizeId(
        live?.SectionID ??
        live?.SectionUID
      );

    const linkId =
      normalizeId(
        live?.LinkID
      );

    if (sectionId) {
      directBySection.set(
        sectionId,
        live
      );
    }

    if (linkId) {
      byLink.set(
        linkId,
        live
      );
    }
  }

  const linksBySection =
    new Map();

  for (
    const item
    of links
  ) {
    const sectionId =
      normalizeId(
        item?.SectionID ??
        item?.SectionUID
      );

    if (!sectionId) {
      continue;
    }

    const ids =
      explicitLinkIds(
        item
      );

    if (ids.length) {
      linksBySection.set(
        sectionId,
        ids
      );
    }
  }

  const observedSections =
    [];

  const quality = {
    high: 0,
    medium: 0,
    rejected: 0,
  };

  for (
    const shape
    of shapes
  ) {
    const sectionId =
      normalizeId(
        shape?.SectionID ??
        shape?.SectionUID
      );

    if (!sectionId) {
      continue;
    }

    const polylines =
      parseWktPolylines(
        shape?.Geometry ??
        shape?.geometry
      );

    if (!polylines.length) {
      continue;
    }

    const sectionLengthKm =
      polylines.reduce(
        (
          sum,
          line
        ) =>
          sum +
          polylineLengthKm(
            line
          ),
        0
      );

    if (
      !Number.isFinite(
        sectionLengthKm
      ) ||
      sectionLengthKm <=
        0.02
    ) {
      continue;
    }

    let live =
      directBySection.get(
        sectionId
      ) || null;

    let travelTimeSec =
      Number(
        live?.TravelTime
      );

    let travelSpeedKmh =
      Number(
        live?.TravelSpeed
      );

    let dataCollectTime =
      live
        ?.DataCollectTime ??
      live
        ?.UpdateTime ??
      null;

    if (!live) {
      const linkIds =
        linksBySection.get(
          sectionId
        ) || [];

      const linkLives =
        linkIds
          .map(
            (id) =>
              byLink.get(id)
          )
          .filter(Boolean);

      if (
        linkIds.length &&
        linkLives.length
      ) {
        const times =
          linkLives
            .map(
              (item) =>
                Number(
                  item?.TravelTime
                )
            )
            .filter(
              (value) =>
                Number.isFinite(
                  value
                ) &&
                value > 0
            );

        const speeds =
          linkLives
            .map(
              (item) =>
                Number(
                  item?.TravelSpeed
                )
            )
            .filter(
              (value) =>
                Number.isFinite(
                  value
                ) &&
                value >= 1 &&
                value <= 160
            );

        travelTimeSec =
          times.length ===
          linkLives.length
            ? times.reduce(
                (
                  sum,
                  value
                ) =>
                  sum +
                  value,
                0
              )
            : NaN;

        travelSpeedKmh =
          speeds.length
            ? speeds.reduce(
                (
                  sum,
                  value
                ) =>
                  sum +
                  value,
                0
              ) /
              speeds.length
            : NaN;

        dataCollectTime =
          latestTime(
            linkLives
          );
      }
    }

    const evidence =
      selectTdxLiveObservation({
        dataCollectTime,

        travelTimeSec,

        sectionLengthKm,

        travelSpeedKmh,
      });

    if (
      !evidence?.accepted
    ) {
      quality.rejected += 1;
      continue;
    }

    /*
     * Scooter traffic overlay stays conservative.
     * Medium-confidence car evidence must not
     * automatically spread into scooter traffic.
     */
    if (
      evidence.confidence !==
      "high"
    ) {
      quality.medium += 1;
      continue;
    }

    quality.high += 1;

    observedSections.push({
      city,

      sectionId,

      polylines,

      sectionLengthKm,

      observedSpeedKmh:
        Number(
          evidence
            .observedSpeedKmh
        ),

      observedFrom:
        evidence
          .observedFrom,

      evidenceConfidence:
        evidence
          .confidence,

      evidenceReason:
        evidence
          .reason,

      dataCollectTime,

      congestionLevel:
        live
          ?.CongestionLevel ??
        null,

      congestionLevelID:
        live
          ?.CongestionLevelID ??
        null,
    });
  }

  return {
    city,

    observedSections,

    shapeCount:
      shapes.length,

    rawLiveCount:
      lives.length,

    evidenceQualityCounts:
      quality,
  };
}

function segmentsFromPackages(
  packages
) {
  const output = [];

  for (
    const pkg
    of packages || []
  ) {
    for (
      const section
      of pkg
        ?.observedSections ||
      []
    ) {
      for (
        const line
        of section
          ?.polylines ||
        []
      ) {
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
              a,
              b
            );

          if (
            !Number.isFinite(
              km
            ) ||
            km <= 0.002
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
              Number(
                section
                  .observedSpeedKmh
              ),

            sectionId:
              section
                .sectionId,

            sectionName:
              null,

            dataCollectTime:
              section
                .dataCollectTime,

            roadType:
              "city",

            city:
              pkg.city,

            source:
              `TDX ${pkg.city} Live/City`,

            matchThresholdKm:
              0.05,

            evidenceConfidence:
              section
                .evidenceConfidence,
          });
        }
      }
    }
  }

  return output;
}

export async function loadScooterCityLiveSegmentsV2(
  route
) {
  const jurisdictionResult =
    await resolveRouteJurisdictions({
      route,

      reverseGeocodeCoordinate,

      resolveJurisdictionFromReverse:
        resolveTaiwanJurisdictionFromReverse,

      maxSamples:
        8,

      concurrency:
        2,

      retries:
        1,
    });

  const routeScopes =
    Array.isArray(
      jurisdictionResult
        ?.jurisdictions
    )
      ? jurisdictionResult
          .jurisdictions
      : [];

  const cityScopes =
    routeScopes.filter(
      (city) =>
        LIVE_CITY_ALLOWLIST.has(
          city
        )
    );

  const unsupportedScopes =
    routeScopes.filter(
      (city) =>
        !LIVE_CITY_ALLOWLIST.has(
          city
        )
    );

  if (
    !cityScopes.length
  ) {
    return {
      segments: [],

      diagnostics: {
        routeScopes,
        cityScopes: [],
        unsupportedScopes,
        packageCount: 0,
        observedSectionCount: 0,
        observedSegmentCount: 0,
      },
    };
  }

  const result =
    await loadCityPackagesResilient({
      cities:
        cityScopes,

      getShape:
        getCitySectionShapes,

      getLink:
        getCitySectionLinks,

      getLive:
        getCityLiveTraffic,

      buildPackage:
        buildCityPackage,

      perScopeTimeoutMs:
        5500,

      logger:
        console,
    });

  const packages =
    result?.packages || [];

  const segments =
    segmentsFromPackages(
      packages
    );

  return {
    segments,

    diagnostics: {
      routeScopes,

      cityScopes,

      unsupportedScopes,

      packageCount:
        packages.length,

      observedSectionCount:
        packages.reduce(
          (
            sum,
            pkg
          ) =>
            sum +
            Number(
              pkg
                ?.observedSections
                ?.length ||
              0
            ),
          0
        ),

      observedSegmentCount:
        segments.length,

      packageDiagnostics:
        result?.diagnostics ||
        [],
    },
  };
}
