import "dotenv/config";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import {
  getScooterRoutes,
} from "./scooterValhallaClient.js";

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

        routes,
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
