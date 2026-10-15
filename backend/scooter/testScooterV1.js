import "dotenv/config";

import {
  getScooterRoutes,
} from "./scooterValhallaClient.js";

const routes =
  await getScooterRoutes({
    // Taipei Main Station
    startLon:
      121.5170,
    startLat:
      25.0478,

    // Taipei 101 area
    endLon:
      121.5645,
    endLat:
      25.0339,

    alternatives:
      2,

    timeoutMs:
      10000,
  });

console.log(
  "=== SCOOTER V1 RESULT ==="
);

console.log(
  "routes:",
  routes.length
);

for (const route of routes) {
  console.log({
    routeId:
      route.routeId,

    mode:
      route.transportMode,

    engine:
      route.routingEngine,

    distanceKm:
      Number(
        (
          route.distance /
          1000
        ).toFixed(2)
      ),

    etaMin:
      Number(
        (
          route.duration /
          60
        ).toFixed(1)
      ),

    geometryType:
      route.geometry?.type ||
      typeof route.geometry,

    carLearningUsed:
      false,
  });
}
