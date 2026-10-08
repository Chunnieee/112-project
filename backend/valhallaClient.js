const VALHALLA_BASE_URL =
  process.env.VALHALLA_BASE_URL ||
  "http://localhost:8002";

function decodePolyline6(encoded) {
  if (!encoded) return [];

  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat =
      result & 1
        ? ~(result >> 1)
        : result >> 1;

    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLon =
      result & 1
        ? ~(result >> 1)
        : result >> 1;

    lon += deltaLon;

    // GeoJSON uses [lon, lat]
    coordinates.push([
      lon / 1e6,
      lat / 1e6,
    ]);
  }

  return coordinates;
}

function mergeCoordinates(target, incoming) {
  for (const point of incoming) {
    const previous =
      target[target.length - 1];

    if (
      previous &&
      previous[0] === point[0] &&
      previous[1] === point[1]
    ) {
      continue;
    }

    target.push(point);
  }
}

function convertLeg(leg) {
  const coordinates =
    decodePolyline6(leg?.shape);

  const maneuvers =
    Array.isArray(leg?.maneuvers)
      ? leg.maneuvers
      : [];

  const steps = maneuvers.map(
    (maneuver) => {
      const begin =
        Math.max(
          0,
          Number(
            maneuver
              ?.begin_shape_index ??
            0
          )
        );

      const end =
        Math.max(
          begin,
          Number(
            maneuver
              ?.end_shape_index ??
            begin
          )
        );

      let stepCoordinates =
        coordinates.slice(
          begin,
          end + 1
        );

      if (
        stepCoordinates.length === 1
      ) {
        stepCoordinates = [
          stepCoordinates[0],
          stepCoordinates[0],
        ];
      }

      return {
        distance:
          Number(
            maneuver?.length || 0
          ) * 1000,

        duration:
          Number(
            maneuver?.time || 0
          ),

        name:
          Array.isArray(
            maneuver?.street_names
          )
            ? maneuver.street_names[0] || ""
            : "",

        geometry: {
          type: "LineString",
          coordinates:
            stepCoordinates,
        },

        maneuver: {
          type:
            maneuver?.type ?? null,

          bearing_before:
            maneuver?.bearing_before ??
            null,

          bearing_after:
            maneuver?.bearing_after ??
            null,
        },

        valhalla: maneuver,
      };
    }
  );

  return {
    distance:
      Number(
        leg?.summary?.length || 0
      ) * 1000,

    duration:
      Number(
        leg?.summary?.time || 0
      ),

    steps,

    geometry: {
      type: "LineString",
      coordinates,
    },
  };
}

function convertTrip(trip, index) {
  const rawLegs =
    Array.isArray(trip?.legs)
      ? trip.legs
      : [];

  const legs =
    rawLegs.map(convertLeg);

  const coordinates = [];

  for (const leg of legs) {
    mergeCoordinates(
      coordinates,
      leg.geometry.coordinates
    );
  }

  return {
    routeId: index + 1,

    label:
      `Route ${String.fromCharCode(
        65 + index
      )}`,

    duration:
      Number(
        trip?.summary?.time || 0
      ),

    distance:
      Number(
        trip?.summary?.length || 0
      ) * 1000,

    geometry: {
      type: "LineString",
      coordinates,
    },

    legs,

    routingEngine:
      "valhalla",

    google: null,

    valhalla: {
      status:
        trip?.status ?? null,

      statusMessage:
        trip?.status_message ??
        null,
    },
  };
}

export async function getValhallaRoutes({
  startLon,
  startLat,
  endLon,
  endLat,
  alternatives = 2,
  timeoutMs = 10000,
  costing = "auto",
}) {
  if (!["auto", "pedestrian", "motor_scooter"].includes(costing)) throw new Error("Unsupported routing mode");
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        `${VALHALLA_BASE_URL}/route`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          signal:
            controller.signal,

          body:
            JSON.stringify({
              locations: [
                {
                  lat:
                    Number(startLat),

                  lon:
                    Number(startLon),
                },
                {
                  lat:
                    Number(endLat),

                  lon:
                    Number(endLon),
                },
              ],

              costing,

              // 2 = primary + up to 2 alternatives
              alternates:
                Math.max(
                  0,
                  Number(
                    alternatives || 0
                  )
                ),

              directions_options: {
                units:
                  "kilometers",

                language:
                  "zh-TW",
              },
            }),
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        `Valhalla ${response.status}: ${JSON.stringify(
          data
        )}`
      );
    }

    const trips = [];

    if (data?.trip) {
      trips.push(data.trip);
    }

    if (
      Array.isArray(
        data?.alternates
      )
    ) {
      for (
        const alternative
        of data.alternates
      ) {
        const trip =
          alternative?.trip ||
          alternative;

        if (trip?.legs) {
          trips.push(trip);
        }
      }
    }

    if (!trips.length) {
      throw new Error(
        "Valhalla returned no routes"
      );
    }

    return trips.map(
      (trip, index) =>
        convertTrip(
          trip,
          index
        )
    );
  } finally {
    clearTimeout(timer);
  }
}
