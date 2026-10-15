const VALHALLA_BASE_URL =
  process.env.VALHALLA_BASE_URL ||
  "http://localhost:8002";

function requireFinite(value, name) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}`);
  }

  return n;
}

function buildMotorScooterOptions() {
  const options = {};

  /*
   * V1 deliberately keeps Valhalla's native motor_scooter
   * defaults unless an explicit test value is configured.
   *
   * Do NOT infer a legal Taiwan speed limit from this option.
   * It is only a routing-model parameter.
   */
  const configuredTopSpeed =
    Number(process.env.SCOOTER_TOP_SPEED_KMH);

  if (
    Number.isFinite(configuredTopSpeed) &&
    configuredTopSpeed >= 20 &&
    configuredTopSpeed <= 120
  ) {
    options.top_speed = configuredTopSpeed;
  }

  return options;
}

function normalizeRoute(route, index) {
  if (!route) {
    throw new Error("Empty Valhalla scooter route");
  }

  return {
    routeId: index + 1,

    label:
      `Route ${String.fromCharCode(65 + index)}`,

    duration:
      Number(route.duration || 0),

    distance:
      Number(route.distance || 0),

    geometry:
      route.geometry || null,

    legs:
      Array.isArray(route.legs)
        ? route.legs
        : [],

    routingEngine:
      "valhalla",

    transportMode:
      "scooter",

    /*
     * V1:
     * - no car V9
     * - no car calibration
     * - no historical correction
     * - no OSRM driving fallback
     */
    scooterEta: {
      version: "SCOOTER_V1",
      trafficApplied: false,
      historicalApplied: false,
      calibrationApplied: false,
      cacheApplied: false,
    },

    /*
     * Reserved for V2 frontend congestion overlay.
     * We do not invent traffic segments in V1.
     */
    congestionSegments: [],
  };
}

export async function getScooterRoutes({
  startLon,
  startLat,
  endLon,
  endLat,
  alternatives = 2,
  timeoutMs = 10000,
}) {
  const sLon = requireFinite(startLon, "startLon");
  const sLat = requireFinite(startLat, "startLat");
  const eLon = requireFinite(endLon, "endLon");
  const eLat = requireFinite(endLat, "endLat");

  const controller = new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const body = {
      locations: [
        {
          lat: sLat,
          lon: sLon,
          type: "break",
        },
        {
          lat: eLat,
          lon: eLon,
          type: "break",
        },
      ],

      costing:
        "motor_scooter",

      costing_options: {
        motor_scooter:
          buildMotorScooterOptions(),
      },

      /*
       * OSRM-compatible output gives us:
       * routes[]
       * duration
       * distance
       * GeoJSON geometry
       *
       * This is still Valhalla routing.
       */
      format:
        "osrm",

      shape_format:
        "geojson",

      units:
        "kilometers",

      alternates:
        Math.max(
          0,
          Math.min(
            2,
            Number(alternatives) || 0
          )
        ),

      directions_options: {
        units:
          "kilometers",
      },
    };

    const response =
      await fetch(
        `${VALHALLA_BASE_URL}/route`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(body),

          signal:
            controller.signal,
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !Array.isArray(data?.routes) ||
      !data.routes.length
    ) {
      throw new Error(
        `Valhalla motor_scooter failed: HTTP ${response.status} ${JSON.stringify(data)}`
      );
    }

    return data.routes.map(
      normalizeRoute
    );
  } finally {
    clearTimeout(timer);
  }
}
