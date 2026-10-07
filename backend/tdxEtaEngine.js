import { selectTdxLiveObservation } from "./etaEvidenceV6.js";

export const ETA_ENGINE_V8_CANONICAL_SECTION_GEOMETRY = true;

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


function directionAxisDiffDeg(a, b) {
  const directed = angleDiffDeg(a, b);
  return Math.min(directed, Math.abs(180 - directed));
}

function directionSemanticClass(diffDeg, maxDirectionDiffDeg) {
  const diff = Number(diffDeg);
  if (!Number.isFinite(diff)) return "unknown";
  if (diff <= maxDirectionDiffDeg) return "aligned";
  if (diff >= 180 - maxDirectionDiffDeg) return "reverse_axis_aligned";
  return "oblique_wrong_direction";
}

export function classifyUncoveredCandidateV7_2({
  candidate = null,
  thresholdKm = 0.06,
} = {}) {
  if (!candidate) return "no_candidate";

  const distanceKm = Number(candidate.distanceKm);
  const directionClass = candidate.directionClass || "unknown";
  const withinDistance = Number.isFinite(distanceKm) && distanceKm <= thresholdKm;

  if (directionClass === "aligned") {
    return withinDistance ? "eligible_but_unselected" : "aligned_but_too_far";
  }
  if (directionClass === "reverse_axis_aligned") {
    return withinDistance ? "opposite_direction" : "opposite_direction_and_too_far";
  }
  if (directionClass === "oblique_wrong_direction") {
    return withinDistance ? "crossing_or_adjacent_road" : "wrong_road_or_too_far";
  }
  return withinDistance ? "direction_unknown" : "no_nearby_eligible_evidence";
}


function annotateTdxSectionMatchBearings(pieces) {
  if (!Array.isArray(pieces) || !pieces.length) return pieces || [];

  const configuredMeters = Number(process.env.TDX_SECTION_BEARING_WINDOW_M || 120);
  const windowKm = Math.max(0.03, Math.min(0.4, configuredMeters / 1000));
  const halfWindowKm = windowKm / 2;

  for (let i = 0; i < pieces.length; i += 1) {
    let left = i;
    let right = i;
    let leftKm = 0;
    let rightKm = 0;

    while (left > 0 && leftKm < halfWindowKm) {
      left -= 1;
      leftKm += Number(pieces[left]?.km || 0);
    }

    while (right < pieces.length - 1 && rightKm < halfWindowKm) {
      right += 1;
      rightKm += Number(pieces[right]?.km || 0);
    }

    const a = pieces[left]?.a;
    const b = pieces[right]?.b;
    const smoothed = a && b ? bearingDeg(a, b) : bearingDeg(pieces[i].a, pieces[i].b);
    pieces[i].matchBearing = Number.isFinite(smoothed)
      ? smoothed
      : bearingDeg(pieces[i].a, pieces[i].b);
    pieces[i].matchBearingWindowKm =
      leftKm + Number(pieces[i]?.km || 0) + rightKm;
  }

  return pieces;
}

export function __testSmoothTdxSectionBearings(pieces) {
  return annotateTdxSectionMatchBearings(pieces);
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
    return process.env.TDX_REQUIRE_LIVE_TIMESTAMP === "0";
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



function extractTdxStaticList(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function sectionIdentity(item) {
  return String(item?.SectionID ?? item?.SectionUID ?? item?.sectionId ?? item?.sectionUid ?? "").trim();
}

function parseCoordinatePair(raw) {
  const nums = String(raw || "")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length < 2) return null;
  return { lon: nums[0], lat: nums[1] };
}

function parseTdxSectionShapeGeometry(value) {
  if (!value) return [];

  if (typeof value === "object") {
    const coords = value?.coordinates;
    const type = String(value?.type || "").toLowerCase();
    if (type === "linestring" && Array.isArray(coords)) {
      const line = normalizeDecodedPolyline(coords);
      return line.length >= 2 ? [line] : [];
    }
    if (type === "multilinestring" && Array.isArray(coords)) {
      return coords
        .map(normalizeDecodedPolyline)
        .filter((line) => line.length >= 2);
    }
  }

  const text = String(value || "").trim();
  if (!text) return [];

  const parseLineBody = (body) =>
    String(body || "")
      .split(",")
      .map(parseCoordinatePair)
      .filter(Boolean);

  const multi = text.match(/^MULTILINESTRING\s*\(\s*(.*)\s*\)$/i);
  if (multi) {
    const body = multi[1];
    const groups = [];
    let depth = 0;
    let current = "";
    for (const ch of body) {
      if (ch === "(") {
        if (depth > 0) current += ch;
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth > 0) current += ch;
        if (depth === 0 && current.trim()) {
          const line = parseLineBody(current);
          if (line.length >= 2) groups.push(line);
          current = "";
        }
      } else if (depth > 0) {
        current += ch;
      }
    }
    return groups;
  }

  const lineMatch = text.match(/^LINESTRING\s*\(\s*(.*)\s*\)$/i);
  const body = lineMatch ? lineMatch[1] : text.replace(/^\(+|\)+$/g, "");
  const line = parseLineBody(body);
  return line.length >= 2 ? [line] : [];
}

function roadDirectionBearing(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return null;
  const normalized = raw
    .replace(/向|BOUND|BOUNDARY|方向/g, "")
    .replace(/NORTH/g, "N")
    .replace(/SOUTH/g, "S")
    .replace(/EAST/g, "E")
    .replace(/WEST/g, "W")
    .replace(/北/g, "N")
    .replace(/南/g, "S")
    .replace(/東/g, "E")
    .replace(/西/g, "W")
    .replace(/\s+/g, "");
  const map = new Map([
    ["N", 0], ["NB", 0],
    ["NE", 45],
    ["E", 90], ["EB", 90],
    ["SE", 135],
    ["S", 180], ["SB", 180],
    ["SW", 225],
    ["W", 270], ["WB", 270],
    ["NW", 315],
  ]);
  return map.has(normalized) ? map.get(normalized) : null;
}

function orientCanonicalLine(line, roadDirection) {
  if (!Array.isArray(line) || line.length < 2) return line || [];
  const target = roadDirectionBearing(roadDirection);
  if (!Number.isFinite(target)) return line;
  const forward = bearingDeg(line[0], line[line.length - 1]);
  const reverse = normalizeBearing(forward + 180);
  return angleDiffDeg(reverse, target) < angleDiffDeg(forward, target)
    ? [...line].reverse()
    : line;
}

function canonicalScopeGeometryIndex(shapeData, sectionData, scope) {
  const shapes = extractTdxStaticList(shapeData, ["SectionShapes", "Shapes"]);
  const sections = extractTdxStaticList(sectionData, ["Sections"]);
  const metadata = new Map();
  for (const item of sections) {
    const id = sectionIdentity(item);
    if (id) metadata.set(id, item);
  }

  const bySectionId = new Map();
  let geometryCount = 0;
  for (const shape of shapes) {
    const id = sectionIdentity(shape);
    if (!id) continue;
    const meta = metadata.get(id) || null;
    const rawGeometry =
      shape?.LineString ??
      shape?.Geometry ??
      shape?.geometry ??
      shape?.WKT ??
      shape?.Shape ??
      null;
    const lines = parseTdxSectionShapeGeometry(rawGeometry)
      .map((line) => orientCanonicalLine(line, meta?.RoadDirection))
      .filter((line) => line.length >= 2);
    if (!lines.length) continue;
    bySectionId.set(id, {
      sectionId: id,
      scope,
      lines,
      roadName: meta?.RoadName || shape?.RoadName || null,
      roadDirection: meta?.RoadDirection || shape?.RoadDirection || null,
      sectionLength: Number(meta?.SectionLength ?? shape?.SectionLength),

      // HIGHWAY_LINK_TRAVELTIME_NORMALIZATION_FINAL
      linkCount:
        Array.isArray(meta?.LinkIDs)
          ? meta.LinkIDs.length
          : 0,
    });
    geometryCount += 1;
  }

  return {
    bySectionId,
    shapeCount: shapes.length,
    metadataCount: metadata.size,
    geometryCount,
  };
}

export function __testCanonicalRoadGeometry({
  freewayShapeData = null,
  highwayShapeData = null,
  freewaySectionData = null,
  highwaySectionData = null,
} = {}) {
  return {
    freeway: canonicalScopeGeometryIndex(freewayShapeData, freewaySectionData, "freeway"),
    highway: canonicalScopeGeometryIndex(highwayShapeData, highwaySectionData, "highway"),
  };
}

export function buildTdxRoadIndex({
  freewayData,
  highwayData,
  openLrToPolyline,
  freewaySectionShapeData = null,
  highwaySectionShapeData = null,
  freewaySectionData = null,
  highwaySectionData = null,
  maxAgeMin = Number(process.env.TDX_LIVE_MAX_AGE_MIN || 20),
  cellDeg = 0.004,
}) {
  const grid = new Map();
  let segmentCount = 0;
  const evidenceDiagnostics = {
    rawSections: 0,
    acceptedSections: 0,
    high: 0,
    medium: 0,
    low: 0,
    rejected: 0,
    travelTime: 0,
    travelSpeed: 0,
  };

  const canonical = {
    freeway: canonicalScopeGeometryIndex(
      freewaySectionShapeData,
      freewaySectionData,
      "freeway"
    ),
    highway: canonicalScopeGeometryIndex(
      highwaySectionShapeData,
      highwaySectionData,
      "highway"
    ),
  };

  const geometryDiagnostics = {
    canonicalShapeSections:
      canonical.freeway.geometryCount + canonical.highway.geometryCount,
    canonicalShapeFreeway: canonical.freeway.geometryCount,
    canonicalShapeHighway: canonical.highway.geometryCount,
    staticMetadataFreeway: canonical.freeway.metadataCount,
    staticMetadataHighway: canonical.highway.metadataCount,
    liveSectionsUsingCanonicalShape: 0,
    liveSectionsUsingOpenLrFallback: 0,
    acceptedSegmentsCanonicalShape: 0,
    acceptedSegmentsOpenLrFallback: 0,
    liveSectionsMissingGeometry: 0,
  };

  const sources = [
    { scope: "freeway", data: freewayData, canonical: canonical.freeway },
    { scope: "highway", data: highwayData, canonical: canonical.highway },
  ];

  evidenceDiagnostics.rawSections = sources.reduce(
    (sum, source) => sum + getTrafficList(source.data).length,
    0
  );

  for (const sourceBundle of sources) {
    for (const section of getTrafficList(sourceBundle.data)) {
      const dataCollectTime =
        section?.DataCollectTime ||
        section?.UpdateTime ||
        null;

      const sectionId = sectionIdentity(section);
      const canonicalEntry = sectionId
        ? sourceBundle.canonical.bySectionId.get(sectionId)
        : null;

      let decodedLines = [];
      let geometrySource = null;
      let roadName = canonicalEntry?.roadName || section?.RoadName || null;
      let roadDirection = canonicalEntry?.roadDirection || section?.RoadDirection || null;

      if (canonicalEntry?.lines?.length) {
        decodedLines = canonicalEntry.lines.map((line) => [...line]);
        geometrySource = "SectionShape";
        geometryDiagnostics.liveSectionsUsingCanonicalShape += 1;
      } else {
        const openLRs = section?.OpenLRs || section?.openLRs || [];
        if (Array.isArray(openLRs)) {
          for (const item of openLRs) {
            try {
              const encoded = item?.OpenLR || item?.openLR || item;
              const line = normalizeDecodedPolyline(openLrToPolyline(encoded));
              if (line.length >= 2) decodedLines.push(line);
            } catch {
              // A bad OpenLR record must not invalidate the remaining live feed.
            }
          }
        }
        if (decodedLines.length) {
          geometrySource = "OpenLR";
          geometryDiagnostics.liveSectionsUsingOpenLrFallback += 1;
        }
      }

      if (!decodedLines.length) {
        geometryDiagnostics.liveSectionsMissingGeometry += 1;
        continue;
      }

      const pieceLines = [];
      let geometryLengthKm = 0;
      for (const line of decodedLines) {
        const pieces = [];
        for (let i = 1; i < line.length; i += 1) {
          const a = line[i - 1];
          const b = line[i];
          const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
          if (!Number.isFinite(km) || km <= 0.002) continue;
          pieces.push({ a, b, km });
          geometryLengthKm += km;
        }
        if (pieces.length) pieceLines.push(annotateTdxSectionMatchBearings(pieces));
      }

      if (!pieceLines.length || geometryLengthKm <= 0) continue;

      const rawTravelTimeSec = Number(
        section?.TravelTime ??
        section?.travelTime ??
        section?.TravelTimeSec ??
        section?.travelTimeSec
      );

      const travelSpeedKmh = Number(
        section?.TravelSpeed ??
        section?.travelSpeed ??
        section?.Speed ??
        section?.speed
      );

      /*
       * HIGHWAY_LINK_TRAVELTIME_NORMALIZATION_FINAL
       *
       * Highway audit:
       * raw TDX TravelTime scales with static LinkIDs.length.
       *
       * Highway only.
       * Freeway remains untouched.
       */

      const highwayLinkCount =
        sourceBundle.scope === "highway"
          ? Number(canonicalEntry?.linkCount || 0)
          : 0;


      const normalizedTravelTimeSec =
        sourceBundle.scope === "highway"
          ? (
              Number.isFinite(rawTravelTimeSec) &&
              rawTravelTimeSec > 0 &&
              highwayLinkCount > 0
                ? rawTravelTimeSec / highwayLinkCount
                : NaN
            )
          : rawTravelTimeSec;


      const normalizedSpeedFromTravelTime =
        Number.isFinite(normalizedTravelTimeSec) &&
        normalizedTravelTimeSec > 0
          ? geometryLengthKm /
            (normalizedTravelTimeSec / 3600)
          : NaN;


      const travelTimeVsSpeedError =
        Number.isFinite(normalizedSpeedFromTravelTime) &&
        normalizedSpeedFromTravelTime > 0 &&
        Number.isFinite(travelSpeedKmh) &&
        travelSpeedKmh > 0
          ? Math.abs(
              normalizedSpeedFromTravelTime -
              travelSpeedKmh
            ) / travelSpeedKmh
          : null;


      /*
       * If Highway normalized TravelTime is still >20%
       * away from published TravelSpeed, discard TravelTime.
       *
       * selectTdxLiveObservation() can then use TravelSpeed.
       */
      const rejectNormalizedHighwayTravelTime =
        sourceBundle.scope === "highway" &&
        Number.isFinite(travelTimeVsSpeedError) &&
        travelTimeVsSpeedError > 0.20;


      const travelTimeSec =
        sourceBundle.scope === "highway"
          ? (
              rejectNormalizedHighwayTravelTime
                ? NaN
                : normalizedTravelTimeSec
            )
          : rawTravelTimeSec;


      const evidence = selectTdxLiveObservation({
        dataCollectTime,
        travelTimeSec,
        sectionLengthKm: geometryLengthKm,
        travelSpeedKmh,
        maxAgeMin,
        requireTimestamp: process.env.TDX_REQUIRE_LIVE_TIMESTAMP !== "0",
      });

      if (!evidence.accepted) {
        evidenceDiagnostics.rejected += 1;
        continue;
      }

      evidenceDiagnostics.acceptedSections += 1;
      evidenceDiagnostics[evidence.confidence] =
        (evidenceDiagnostics[evidence.confidence] || 0) + 1;
      evidenceDiagnostics[
        evidence.observedFrom === "TravelTime" ? "travelTime" : "travelSpeed"
      ] += 1;

      for (const pieces of pieceLines) {
        for (const piece of pieces) {
          const segment = {
            a: piece.a,
            b: piece.b,
            bearing: bearingDeg(piece.a, piece.b),
            matchBearing: Number.isFinite(Number(piece.matchBearing))
              ? Number(piece.matchBearing)
              : bearingDeg(piece.a, piece.b),
            matchBearingWindowKm: Number(piece.matchBearingWindowKm || 0),
            observedSpeedKmh: evidence.observedSpeedKmh,
            scope: sourceBundle.scope,
            sectionId: sectionId || null,
            sectionName: section?.SectionName || null,
            roadName,
            roadDirection,
            geometrySource,
            dataCollectTime,
            dataAgeMin: evidence.dataAgeMin,
            observedFrom: evidence.observedFrom,
            evidenceConfidence: evidence.confidence,
            evidenceReason: evidence.reason,
            evidenceQualityScore: evidence.qualityScore,
            travelTimeSec:
              Number.isFinite(travelTimeSec) && travelTimeSec > 0
                ? travelTimeSec
                : null,
            travelSpeedKmh:
              Number.isFinite(travelSpeedKmh) && travelSpeedKmh > 0
                ? travelSpeedKmh
                : null,
            sectionLengthKm: geometryLengthKm,
            source:
              sourceBundle.scope === "freeway"
                ? "TDX Freeway LiveTraffic"
                : "TDX Highway LiveTraffic",
          };

          addSegmentToGrid(grid, cellDeg, segment);
          segmentCount += 1;
          if (geometrySource === "SectionShape") {
            geometryDiagnostics.acceptedSegmentsCanonicalShape += 1;
          } else {
            geometryDiagnostics.acceptedSegmentsOpenLrFallback += 1;
          }
        }
      }
    }
  }

  return {
    grid,
    cellDeg,
    segmentCount,
    evidenceDiagnostics,
    geometryDiagnostics,
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


    const candidateBearing =
      Number.isFinite(Number(segment?.matchBearing))
        ? Number(segment.matchBearing)
        : Number(segment.bearing);

    const directionDiffDeg = angleDiffDeg(
      routeBearing,
      candidateBearing
    );

    if (
      directionDiffDeg >
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

      best = {
        ...segment,
        directionDiffDeg,
        directionAxisDiffDeg: directionAxisDiffDeg(routeBearing, candidateBearing),
        directionClass: "aligned",
        candidateBearingDeg: candidateBearing,
        rawCandidateBearingDeg: segment.bearing,
      };
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



function inspectNearestTdxCandidate(
  point,
  routeBearing,
  index,
  thresholdKm,
  maxDirectionDiffDeg,
  scope
) {
  let best = null;
  let bestDistanceKm = Infinity;

  for (
    const segment
    of candidatesNear(
      point,
      index
    )
  ) {
    const speed =
      Number(
        segment?.observedSpeedKmh
      );

    if (
      !Number.isFinite(speed) ||
      speed <= 0
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
      !Number.isFinite(distanceKm) ||
      distanceKm >= bestDistanceKm
    ) {
      continue;
    }


    const candidateBearing =
      Number.isFinite(Number(segment?.matchBearing))
        ? Number(segment.matchBearing)
        : Number(segment?.bearing);

    const directionDiffDeg =
      Number.isFinite(candidateBearing)
        ? angleDiffDeg(
            routeBearing,
            candidateBearing
          )
        : null;


    bestDistanceKm =
      distanceKm;


    best = {
      scope,

      distanceKm,

      directionDiffDeg,

      directionAxisDiffDeg:
        Number.isFinite(directionDiffDeg)
          ? directionAxisDiffDeg(routeBearing, candidateBearing)
          : null,

      directionClass:
        directionSemanticClass(directionDiffDeg, maxDirectionDiffDeg),

      candidateBearingDeg:
        Number.isFinite(candidateBearing) ? candidateBearing : null,

      rawCandidateBearingDeg:
        Number.isFinite(Number(segment?.bearing)) ? Number(segment.bearing) : null,

      sectionId:
        segment?.sectionId ||
        null,

      sectionName:
        segment?.sectionName ||
        null,

      city:
        segment?.city ||
        null,

      observedFrom:
        segment?.observedFrom ||
        null,

      observedSpeedKmh:
        speed
    };
  }


  if (!best) {
    return null;
  }


  const tooFar =
    best.distanceKm >
    thresholdKm;


  const wrongDirection =
    Number.isFinite(
      best.directionDiffDeg
    ) &&
    best.directionDiffDeg >
      maxDirectionDiffDeg;


  let rejectionReason =
    "eligible";


  if (
    tooFar &&
    wrongDirection
  ) {
    rejectionReason =
      "too_far+wrong_direction";

  } else if (tooFar) {

    rejectionReason =
      "too_far";

  } else if (
    wrongDirection
  ) {

    rejectionReason =
      "wrong_direction";
  }


  return {
    ...best,

    thresholdKm,

    rejectionReason
  };
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


function annotateRouteMatchBearings(segments) {
  if (!Array.isArray(segments) || !segments.length) return segments || [];

  const configuredMeters = Number(process.env.TDX_ROUTE_BEARING_WINDOW_M || 120);
  const windowKm = Math.max(0.03, Math.min(0.4, configuredMeters / 1000));
  const halfWindowKm = windowKm / 2;

  const identity = (value) =>
    String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i];
    const roadIdentity = identity(current.roadName);
    let left = i;
    let right = i;
    let leftKm = 0;
    let rightKm = 0;

    while (left > 0 && leftKm < halfWindowKm) {
      const candidate = segments[left - 1];
      if (roadIdentity && identity(candidate.roadName) !== roadIdentity) break;
      left -= 1;
      leftKm += Number(candidate.km || 0);
    }

    while (right < segments.length - 1 && rightKm < halfWindowKm) {
      const candidate = segments[right + 1];
      if (roadIdentity && identity(candidate.roadName) !== roadIdentity) break;
      right += 1;
      rightKm += Number(candidate.km || 0);
    }

    const a = segments[left]?.a;
    const b = segments[right]?.b;
    const smoothed = a && b ? bearingDeg(a, b) : current.bearing;
    current.matchBearing = Number.isFinite(smoothed) ? smoothed : current.bearing;
    current.matchBearingWindowKm = leftKm + Number(current.km || 0) + rightKm;
  }

  return segments;
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
    return annotateRouteMatchBearings(segments);
  }


  return annotateRouteMatchBearings(
    lineSegments(
      route?.geometry
        ?.coordinates ||
        [],

      Number(
        route?.duration ||
        0
      ),
      ""
    )
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



// UNCOVERED_PRIOR_V9_ENGINE
function v9RoadType(
  roadName,
  match
) {
  const scope =
    String(
      match?.scope ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    scope === "freeway"
  ) {
    return "freeway";
  }

  if (
    scope === "highway"
  ) {
    return "highway";
  }

  const name =
    String(
      roadName ||
      ""
    ).trim();

  if (
    /交流道|匝道|ramp/i
      .test(name)
  ) {
    return "ramp";
  }

  if (
    /快速道路|高架/
      .test(name)
  ) {
    return "expressway";
  }

  if (
    /^(?:台|省道|縣道|北|市)?\s*\d+[甲乙丙丁戊]?$/
      .test(name)
  ) {
    return "numbered_road";
  }

  if (
    /大道|路|街|巷|弄|橋/
      .test(name)
  ) {
    return "urban_road";
  }

  return "other";
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


  let positiveDelaySec =
    0;

  let positiveDelayAdjustedDistanceKm =
    0;



  const sectionMap =
    new Map();

  const matchedRunsRaw = [];
  let activeMatchedRun = null;
  let matchedRunSequence = 0;

  const flushMatchedRun = () => {
    if (!activeMatchedRun) return;
    activeMatchedRun.positiveDelaySec = Math.max(
      0,
      activeMatchedRun.observedSec - activeMatchedRun.baselineSec
    );
    matchedRunsRaw.push(activeMatchedRun);
    activeMatchedRun = null;
  };


  const unmatchedSegmentMap =
    new Map();

  // UNCOVERED_PRIOR_V9_TELEMETRY
  const v9PriorTrainingGroups =
    [];

  const v9PriorUncoveredGroups =
    [];



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
        segment.matchBearing ?? segment.bearing,
        cityIndex,
        cityMatchThresholdKm,
        maxDirectionDiffDeg
      );


    const roadMatch =
      findMatch(
        segment.midpoint,
        segment.matchBearing ?? segment.bearing,
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
            segment.matchBearing ?? segment.bearing,
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


      /*
       * Compare TDX observation with this
       * exact route-piece baseline.
       */
      const segmentPositiveDelaySec =
        Math.max(
          0,
          observedSec -
            baselineSec
        );


      positiveDelaySec +=
        segmentPositiveDelaySec;


      if (
        segmentPositiveDelaySec >
        0
      ) {
        positiveDelayAdjustedDistanceKm +=
          segment.km;
      }


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

          scope:
            match.scope ||
            (match.city ? "city" : null),

          geometrySource:
            match.geometrySource || null,

          roadName:
            match.roadName || null,

          roadDirection:
            match.roadDirection || null,

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

          dataAgeMin:
            Number.isFinite(Number(match.dataAgeMin))
              ? Number(match.dataAgeMin)
              : null,

          evidenceConfidence:
            match.evidenceConfidence ||
            null,

          evidenceReason:
            match.evidenceReason ||
            null,

          evidenceQualityScore:
            Number.isFinite(Number(match.evidenceQualityScore))
              ? Number(match.evidenceQualityScore)
              : null,

          travelSpeedKmh:
            Number.isFinite(Number(match.travelSpeedKmh))
              ? Number(match.travelSpeedKmh)
              : null,

          matchedDistanceKm:
            0,

          baselineSec:
            0,

          observedSec:
            0,

          positiveDelaySec:
            0,

          nearestMatchKm:
            Infinity
        };


      current.matchedDistanceKm +=
        segment.km;

      current.baselineSec +=
        baselineSec;

      current.observedSec +=
        observedSec;

      current.positiveDelaySec +=
        segmentPositiveDelaySec;


      current.nearestMatchKm =
        Math.min(
          current.nearestMatchKm,
          match.matchDistanceKm
        );

      if (!activeMatchedRun || activeMatchedRun.key !== key) {
        flushMatchedRun();
        matchedRunSequence += 1;
        activeMatchedRun = {
          runIndex: matchedRunSequence,
          key,
          source: current.source,
          scope: current.scope,
          geometrySource: current.geometrySource,
          roadName: current.roadName,
          roadDirection: current.roadDirection,
          city: current.city,
          sectionId: current.sectionId,
          sectionName: current.sectionName,
          observedFrom: current.observedFrom,
          observedSpeedKmh: speed,
          dataCollectTime: current.dataCollectTime,
          dataAgeMin: current.dataAgeMin,
          evidenceConfidence: current.evidenceConfidence,
          evidenceReason: current.evidenceReason,
          evidenceQualityScore: current.evidenceQualityScore,
          travelSpeedKmh: current.travelSpeedKmh,
          matchedDistanceKm: 0,
          baselineSec: 0,
          observedSec: 0,
          positiveDelaySec: 0,
          nearestMatchKm: Infinity,
        };
      }

      activeMatchedRun.matchedDistanceKm += segment.km;
      activeMatchedRun.baselineSec += baselineSec;
      activeMatchedRun.observedSec += observedSec;
      activeMatchedRun.nearestMatchKm = Math.min(
        activeMatchedRun.nearestMatchKm,
        match.matchDistanceKm
      );


      sectionMap.set(
        key,
        current
      );

      /*
       * V9 training evidence:
       * only segments that already passed
       * the strict TDX map-matching policy.
       *
       * This does NOT change ETA here.
       */
      v9PriorTrainingGroups.push({
        roadType:
          v9RoadType(
            segment.roadName,
            match
          ),

        scope:
          match?.scope ||
          null,

        city:
          match?.city ||
          null,

        /*
         * CURRENT_UNCOVERED_PROXY_V1
         *
         * Only high-confidence live evidence may
         * be extrapolated to an uncovered piece.
         */
        evidenceConfidence:
          match?.evidenceConfidence ||
          null,

        evidenceReason:
          match?.evidenceReason ||
          null,

        observedFrom:
          match?.observedFrom ||
          null,

        distanceKm:
          Number(
            segment.km ||
            0
          ),

        baselineSec:
          Number(
            baselineSec ||
            0
          ),

        observedSec:
          Number(
            observedSec ||
            0
          ),

        point:
          segment.midpoint ||
          null,
      });

    } else {
      flushMatchedRun();
      /*
        沒有可靠 TDX match：
        保留這一小段原本 OSRM step duration。
      */

      const uncoveredRoadName =
        String(
          segment.roadName ||
          "(unnamed)"
        ).trim() ||
        "(unnamed)";


      const currentUnmatched =
        unmatchedSegmentMap.get(
          uncoveredRoadName
        ) ||
        {
          roadName:
            uncoveredRoadName,

          distanceKm:
            0,

          baselineSec:
            0,

          segmentCount:
            0,

          rejectionCounts:
            {},

          nearestCandidateKm:
            Infinity,

          nearestCandidateScope:
            null,

          nearestCandidateSectionId:
            null,

          nearestCandidateSectionName:
            null,

          nearestCandidateGeometrySource:
            null,

          nearestCandidateRoadName:
            null,

          nearestCandidateRoadDirection:
            null,

          nearestCandidateDirectionDiffDeg:
            null,

          nearestCandidateDirectionAxisDiffDeg:
            null,

          nearestCandidateDirectionClass:
            null,

          nearestCandidateReason:
            null,

          nearestCandidateSpeedKmh:
            null,

          uncoveredClass:
            "no_candidate"
        };


      const cityCandidateDiagnostic =
        inspectNearestTdxCandidate(
          segment.midpoint,
          segment.matchBearing ?? segment.bearing,
          cityIndex,
          cityMatchThresholdKm,
          maxDirectionDiffDeg,
          "city"
        );


      const roadCandidateDiagnostic =
        inspectNearestTdxCandidate(
          segment.midpoint,
          segment.matchBearing ?? segment.bearing,
          roadIndex,
          roadMatchThresholdKm,
          maxDirectionDiffDeg,
          "freeway/highway"
        );


      const candidateDiagnostics =
        [
          cityCandidateDiagnostic,
          roadCandidateDiagnostic
        ]
          .filter(Boolean)
          .sort(
            (a, b) =>
              a.distanceKm -
              b.distanceKm
          );


      const nearestCandidateDiagnostic =
        candidateDiagnostics[0] ||
        null;


      const rejectionReason =
        nearestCandidateDiagnostic
          ?.rejectionReason ||
        "no_candidate";

      const classificationThresholdKm =
        nearestCandidateDiagnostic?.scope === "city"
          ? cityMatchThresholdKm
          : roadMatchThresholdKm;

      currentUnmatched.uncoveredClass = classifyUncoveredCandidateV7_2({
        candidate: nearestCandidateDiagnostic,
        thresholdKm: classificationThresholdKm,
      });


      currentUnmatched
        .rejectionCounts[
          rejectionReason
        ] =
          (
            currentUnmatched
              .rejectionCounts[
                rejectionReason
              ] ||
            0
          ) +
          1;


      if (
        nearestCandidateDiagnostic &&
        nearestCandidateDiagnostic
          .distanceKm <
          currentUnmatched
            .nearestCandidateKm
      ) {
        currentUnmatched
          .nearestCandidateKm =
            nearestCandidateDiagnostic
              .distanceKm;


        currentUnmatched
          .nearestCandidateScope =
            nearestCandidateDiagnostic
              .scope;


        currentUnmatched
          .nearestCandidateSectionId =
            nearestCandidateDiagnostic
              .sectionId;


        currentUnmatched
          .nearestCandidateSectionName =
            nearestCandidateDiagnostic
              .sectionName;


        currentUnmatched
          .nearestCandidateGeometrySource =
            nearestCandidateDiagnostic
              .geometrySource || null;


        currentUnmatched
          .nearestCandidateRoadName =
            nearestCandidateDiagnostic
              .roadName || null;


        currentUnmatched
          .nearestCandidateRoadDirection =
            nearestCandidateDiagnostic
              .roadDirection || null;


        currentUnmatched
          .nearestCandidateDirectionDiffDeg =
            nearestCandidateDiagnostic
              .directionDiffDeg;


        currentUnmatched
          .nearestCandidateDirectionAxisDiffDeg =
            nearestCandidateDiagnostic
              .directionAxisDiffDeg;


        currentUnmatched
          .nearestCandidateDirectionClass =
            nearestCandidateDiagnostic
              .directionClass;


        currentUnmatched
          .nearestCandidateReason =
            nearestCandidateDiagnostic
              .rejectionReason;


        currentUnmatched
          .nearestCandidateSpeedKmh =
            nearestCandidateDiagnostic
              .observedSpeedKmh;
      }


      currentUnmatched.distanceKm +=
        segment.km;


      currentUnmatched.baselineSec +=
        baselineSec;


      currentUnmatched.segmentCount +=
        1;


      unmatchedSegmentMap.set(
        uncoveredRoadName,
        currentUnmatched
      );


      expectedSec +=
        baselineSec;

      osrmFallbackSec +=
        baselineSec;

      /*
       * V9 uncovered target:
       * still uses original router baseline here.
       * No historical multiplier is applied
       * inside the matching engine.
       */
      v9PriorUncoveredGroups.push({
        roadType:
          v9RoadType(
            segment.roadName,
            null
          ),

        scope:
          null,

        city:
          null,

        distanceKm:
          Number(
            segment.km ||
            0
          ),

        baselineSec:
          Number(
            baselineSec ||
            0
          ),

        observedSec:
          null,

        point:
          segment.midpoint ||
          null,
      });
    }
  }


  flushMatchedRun();

  positiveDelaySec = matchedRunsRaw.reduce(
    (sum, run) => sum + Math.max(0, Number(run.positiveDelaySec || 0)),
    0
  );

  positiveDelayAdjustedDistanceKm = matchedRunsRaw.reduce(
    (sum, run) =>
      sum + (Number(run.positiveDelaySec || 0) > 0 ? Number(run.matchedDistanceKm || 0) : 0),
    0
  );

  // Safe ETA: full router baseline + only positive delay after each contiguous
  // TDX section run has been netted internally.
  expectedSec = baseOsrmSec + positiveDelaySec;

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

        baselineSec:
          round(
            item.baselineSec,
            2
          ),

        observedSec:
          round(
            item.observedSec,
            2
          ),

        baselineMin:
          round(
            item.baselineSec /
              60,
            3
          ),

        observedMin:
          round(
            item.observedSec /
              60,
            3
          ),

        positiveDelayMin:
          round(
            Math.max(0, item.observedSec - item.baselineSec) /
              60,
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


  const matchedRuns = matchedRunsRaw.map((run) => ({
    ...run,
    observedSpeedKmh: round(run.observedSpeedKmh, 1),
    matchedDistanceKm: round(run.matchedDistanceKm, 3),
    baselineSec: round(run.baselineSec, 2),
    observedSec: round(run.observedSec, 2),
    baselineMin: round(run.baselineSec / 60, 3),
    observedMin: round(run.observedSec / 60, 3),
    positiveDelaySec: round(run.positiveDelaySec, 2),
    positiveDelayMin: round(run.positiveDelaySec / 60, 3),
    nearestMatchKm: round(run.nearestMatchKm, 3),
  }));


  const unmatchedSegments =
    [
      ...unmatchedSegmentMap.values()
    ]
      .map((item) => ({
        roadName:
          item.roadName,

        distanceKm:
          round(
            item.distanceKm,
            3
          ),

        baselineMin:
          round(
            item.baselineSec /
              60,
            3
          ),

        segmentCount:
          item.segmentCount,

        rejectionCounts:
          item.rejectionCounts ||
          {},

        nearestCandidateM:
          Number.isFinite(
            item.nearestCandidateKm
          )
            ? round(
                item.nearestCandidateKm *
                  1000,
                1
              )
            : null,

        nearestCandidateScope:
          item.nearestCandidateScope ||
          null,

        nearestCandidateSectionId:
          item.nearestCandidateSectionId ||
          null,

        nearestCandidateSectionName:
          item.nearestCandidateSectionName ||
          null,

        nearestCandidateGeometrySource:
          item.nearestCandidateGeometrySource ||
          null,

        nearestCandidateRoadName:
          item.nearestCandidateRoadName ||
          null,

        nearestCandidateRoadDirection:
          item.nearestCandidateRoadDirection ||
          null,

        nearestCandidateDirectionDiffDeg:
          Number.isFinite(
            item.nearestCandidateDirectionDiffDeg
          )
            ? round(
                item.nearestCandidateDirectionDiffDeg,
                1
              )
            : null,

        nearestCandidateDirectionAxisDiffDeg:
          Number.isFinite(
            item.nearestCandidateDirectionAxisDiffDeg
          )
            ? round(
                item.nearestCandidateDirectionAxisDiffDeg,
                1
              )
            : null,

        nearestCandidateDirectionClass:
          item.nearestCandidateDirectionClass ||
          null,

        nearestCandidateReason:
          item.nearestCandidateReason ||
          null,

        nearestCandidateSpeedKmh:
          Number.isFinite(
            item.nearestCandidateSpeedKmh
          )
            ? round(
                item.nearestCandidateSpeedKmh,
                1
              )
            : null,

        uncoveredClass:
          item.uncoveredClass ||
          "no_candidate"
      }))
      .sort(
        (a, b) =>
          b.baselineMin -
          a.baselineMin
      )
      .slice(
        0,
        30
      );


  return {
    expectedMin:
      round(
        Math.max(
          expectedSec,
          baseOsrmSec
        ) / 60,
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
        Math.max(
          0,
          expectedSec -
            baseOsrmSec
        ) /
        60,
        3
      ),

    positiveDelayMin:
      round(
        positiveDelaySec /
          60,
        3
      ),

    positiveDelayAdjustedDistanceKm:
      round(
        positiveDelayAdjustedDistanceKm,
        3
      ),


    matchedCount,

    matchedSections,

    matchedRuns,

    unmatchedSegments,

    v9PriorTrainingGroups,

    v9PriorUncoveredGroups,

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

      routeBearingMode:
        "same-road smoothed corridor bearing",

      routeBearingWindowM:
        Math.max(30, Math.min(400, Number(process.env.TDX_ROUTE_BEARING_WINDOW_M || 120))),

      reverseGeometryAutoAccepted:
        false,

      directionSemantics:
        "directed match remains strict; near-180 geometry is classified separately instead of being silently accepted",

      roadGeometryPolicy:
        "Freeway/Highway SectionShape is canonical when available; live OpenLR geometry is a fallback only",

      vdRule:
        "Supplemental diagnostic only. VD spot speed is NOT currently used to replace route-segment ETA.",

      vdUsedForEta:
        false,

      oneObservationPerRoutePiece:
        true,

      arbitraryTrafficMultiplier:
        false,

      speedClampAgainstOsrm:
        true
    }
  };
}