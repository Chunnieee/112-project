function validCoordinate(lat, lon) {
  return (
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lon)) &&
    Number(lat) >= -90 &&
    Number(lat) <= 90 &&
    Number(lon) >= -180 &&
    Number(lon) <= 180
  );
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 10000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

function taipeiDateString() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Taipei",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (const part of parts) {
    if (
      part.type !==
      "literal"
    ) {
      values[part.type] =
        part.value;
    }
  }

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}

function normalizeDepartureTime(
  value
) {
  const text =
    String(value || "")
      .trim();

  if (!text) {
    return "now";
  }

  if (
    text.toLowerCase() ===
    "now"
  ) {
    return "now";
  }

  /*
   * Already an ISO datetime.
   */
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(
      text
    )
  ) {
    return text;
  }

  /*
   * Existing frontend normally sends HH:mm.
   * Convert it to today's Taipei datetime.
   */
  const match =
    text.match(
      /^([01]\d|2[0-3]):([0-5]\d)$/
    );

  if (match) {
    return (
      `${taipeiDateString()}T` +
      `${match[1]}:${match[2]}:00+08:00`
    );
  }

  return "now";
}

function flattenRoutePoints(
  route
) {
  const result = [];

  const addPoint =
    (point) => {

      const lat =
        Number(
          point?.latitude ??
          point?.lat
        );

      const lon =
        Number(
          point?.longitude ??
          point?.lon ??
          point?.lng
        );

      if (
        !validCoordinate(
          lat,
          lon
        )
      ) {
        return;
      }

      const previous =
        result[
          result.length - 1
        ];

      if (
        previous &&
        Math.abs(
          previous[0] -
          lon
        ) <
          1e-8 &&
        Math.abs(
          previous[1] -
          lat
        ) <
          1e-8
      ) {
        return;
      }

      result.push([
        lon,
        lat,
      ]);
    };


  for (
    const leg of
    route?.legs || []
  ) {
    for (
      const point of
      leg?.points || []
    ) {
      addPoint(point);
    }
  }


  /*
   * Fallback in case TomTom changes
   * response nesting.
   */
  if (!result.length) {
    for (
      const point of
      route?.points || []
    ) {
      addPoint(point);
    }
  }

  return result;
}

function safeNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : null;
}

export async function getTomTomTrafficRoutes({
  startLon,
  startLat,
  endLon,
  endLat,
  apiKey,
  alternatives = 2,
  departureTime = null,
  timeoutMs = 10000,
}) {

  if (!apiKey) {
    throw new Error(
      "Missing TOMTOM_API_KEY"
    );
  }

  if (
    !validCoordinate(
      startLat,
      startLon
    ) ||
    !validCoordinate(
      endLat,
      endLon
    )
  ) {
    throw new Error(
      "Invalid TomTom route coordinates"
    );
  }

  const locations =
    `${Number(startLat)},${Number(startLon)}:` +
    `${Number(endLat)},${Number(endLon)}`;


  const params =
    new URLSearchParams({
      key:
        apiKey,

      traffic:
        "true",

      travelMode:
        "car",

      routeType:
        "fastest",

      maxAlternatives:
        String(
          Math.max(
            0,
            Math.min(
              2,
              Number(
                alternatives
              ) || 0
            )
          )
        ),

      computeTravelTimeFor:
        "all",

      routeRepresentation:
        "polyline",

      departAt:
        normalizeDepartureTime(
          departureTime
        ),
    });


  const url =
    "https://api.tomtom.com/routing/1/calculateRoute/" +
    encodeURI(locations) +
    "/json?" +
    params.toString();


  const response =
    await fetchWithTimeout(
      url,
      {
        headers: {
          Accept:
            "application/json",
        },
      },
      timeoutMs
    );


  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data = null;
  }


  if (!response.ok) {
    throw new Error(
      `TomTom Routing HTTP ${response.status}: ` +
      String(text).slice(
        0,
        300
      )
    );
  }


  const routes =
    Array.isArray(
      data?.routes
    )
      ? data.routes
      : [];


  if (!routes.length) {
    throw new Error(
      "TomTom returned no route"
    );
  }


  return routes
    .map(
      (route, index) => {

        const summary =
          route?.summary ||
          {};

        const coordinates =
          flattenRoutePoints(
            route
          );


        if (
          coordinates.length <
          2
        ) {
          return null;
        }


        const durationSec =
          safeNumber(
            summary
              ?.travelTimeInSeconds
          );


        const distanceM =
          safeNumber(
            summary
              ?.lengthInMeters
          );


        if (
          !durationSec ||
          durationSec <= 0 ||
          !distanceM ||
          distanceM <= 0
        ) {
          return null;
        }


        const geometry = {
          type:
            "LineString",

          coordinates,
        };


        /*
         * Normalize into the route shape
         * the existing ETA engine expects.
         *
         * The synthetic step is only for
         * geometry decomposition / TDX
         * map matching.
         *
         * It does NOT invent traffic.
         */
        const normalizedLegs = [
          {
            duration:
              durationSec,

            distance:
              distanceM,

            steps: [
              {
                duration:
                  durationSec,

                distance:
                  distanceM,

                geometry,
              },
            ],
          },
        ];


        return {
          routeId:
            index + 1,

          label:
            `Route ${String.fromCharCode(
              65 + index
            )}`,

          /*
           * IMPORTANT:
           * duration is TomTom's
           * traffic-aware ETA.
           */
          duration:
            durationSec,

          distance:
            distanceM,

          geometry,

          legs:
            normalizedLegs,

          routingEngine:
            "tomtom-traffic",

          tomtom: {
            travelTimeSec:
              durationSec,

            trafficDelaySec:
              safeNumber(
                summary
                  ?.trafficDelayInSeconds
              ),

            noTrafficTravelTimeSec:
              safeNumber(
                summary
                  ?.noTrafficTravelTimeInSeconds
              ),

            historicTrafficTravelTimeSec:
              safeNumber(
                summary
                  ?.historicTrafficTravelTimeInSeconds
              ),

            liveTrafficIncidentsTravelTimeSec:
              safeNumber(
                summary
                  ?.liveTrafficIncidentsTravelTimeInSeconds
              ),

            departureTime:
              summary
                ?.departureTime ||
              null,

            arrivalTime:
              summary
                ?.arrivalTime ||
              null,
          },

          rawTomTomSummary:
            summary,
        };
      }
    )
    .filter(Boolean);
}
