import "dotenv/config";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import {
  getScooterRoutes,
} from "./scooterValhallaClient.js";

import {
  applyScooterLiveTrafficV1,
} from "./scooterLiveTrafficV1.js";

// SCOOTER_LIVE_TRAFFIC_V1

const app = express();

const PORT =
  Number(
    process.env.SCOOTER_PORT || 3001
  );

app.use(cors());
app.use(express.json());

app.use(
  "/api",
  rateLimit({
    windowMs:
      60 * 1000,

    max:
      60,

    message: {
      error:
        "Too many scooter requests",
    },
  })
);

app.get(
  "/api/scooter-health",
  (req, res) => {
    res.json({
      status:
        "ok",

      transportMode:
        "scooter",

      routingEngine:
        "valhalla",

      costing:
        "motor_scooter",

      isolation: {
        carRouteModified:
          false,

        carV9Used:
          false,

        carCalibrationUsed:
          false,

        historicalUsed:
          false,

        osrmDrivingFallback:
          false,

        cacheUsed:
          false,
      },
    });
  }
);

app.get(
  "/api/scooter-route",
  async (req, res) => {
    try {
      const {
        startLon,
        startLat,
        endLon,
        endLat,
      } = req.query;

      if (
        !startLon ||
        !startLat ||
        !endLon ||
        !endLat
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing startLon, startLat, endLon, or endLat",
          });
      }

      const routes =
        await getScooterRoutes({
          startLon,
          startLat,
          endLon,
          endLat,
          alternatives:
            2,
          timeoutMs:
            10000,
        });

      console.log(
        `[scooter] Valhalla returned ${routes.length} route(s)`
      );

      /*
       * Live traffic is intentionally isolated from
       * car V9 / car historical / car calibration.
       *
       * A TDX traffic failure must NOT make scooter
       * routing fail. We simply return the baseline.
       */
      const enhancedRoutes =
        await Promise.all(
          routes.map(
            async (route) => {
              try {
                const live =
                  await applyScooterLiveTrafficV1(
                    route
                  );

                return {
                  ...route,

                  congestionSegments:
                    live
                      .congestionSegments,

                  liveTraffic:
                    live
                      .liveTraffic,

                  scooterEta: {
                    ...route
                      .scooterEta,

                    trafficEvidenceAvailable:
                      live
                        .liveTraffic
                        .matchedCoverageRatio >
                      0,

                    trafficApplied:
                      false,
                  },
                };
              } catch (error) {
                console.warn(
                  "[scooter live traffic skipped]",
                  error.message
                );

                return {
                  ...route,

                  congestionSegments:
                    [],

                  liveTraffic: {
                    version:
                      "SCOOTER_LIVE_TRAFFIC_V1",

                    trafficAppliedToEta:
                      false,

                    status:
                      "unavailable",

                    error:
                      error.message,
                  },
                };
              }
            }
          )
        );

      res.json({
        status:
          "ok",

        transportMode:
          "scooter",

        etaModel: {
          version:
            "SCOOTER_V1",

          baseline:
            "Valhalla motor_scooter",

          liveTraffic:
            false,

          historical:
            false,

          empiricalCalibration:
            false,

          cache:
            false,
        },

        routes:
          enhancedRoutes,
      });
    } catch (error) {
      console.error(
        "[scooter route]",
        error
      );

      /*
       * IMPORTANT:
       * Scooter must not silently fall back to
       * OSRM /driving because that would become
       * a car route.
       */
      res
        .status(503)
        .json({
          status:
            "error",

          transportMode:
            "scooter",

          error:
            "Scooter routing unavailable",

          detail:
            error.message,

          fallback:
            "none",
        });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Scooter backend running at http://localhost:${PORT}`
    );

    console.log(
      "Scooter routing: Valhalla motor_scooter only; car pipeline untouched"
    );
  }
);
