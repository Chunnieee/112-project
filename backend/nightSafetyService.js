// Adapter for the safety lab. Preserve its calibrated scoring and missing-data rules.
import { analyzePedestrianRouteSafety } from './nightSafety/pedestrianSafety/scoring.js';
import { prefilterForRoute, applyCoverage, dataFiles, dataBackend } from './nightSafety/nationalData.js';
import { scoreVehicleRoute, MODES } from './nightSafety/modes.js';
import { ensureRoads, roadsNearRoute } from './nightSafety/roadNetwork.js';
import { prepareRoute, findPointsNearRoute } from './nightSafety/pedestrianSafety/routeAnalysis.js';
import { mapPointCollection } from './nightMapPoints.js';

export async function scoreNightRoutes(routes, mode) {
  const paths = routes.map(r => r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })));
  if (process.env.NIGHT_SAFETY_ROADS !== 'off') await ensureRoads(paths);
  return paths.map(path => {
    let result, lights, stores;
    if (mode === 'walk') {
      const near = prefilterForRoute(path, 150);
      const raw = analyzePedestrianRouteSafety(path, near.accidents, near.streetlights, near.stores,
        null, undefined, { roads: roadsNearRoute(path) });
      result = applyCoverage(raw, path);
      lights = raw.matched.streetlights; stores = raw.matched.stores;
    } else {
      const vehicle = scoreVehicleRoute(path, mode, null);
      result = vehicle.result;
      lights = vehicle.mapLayers.streetlights.map(([latitude,longitude,distanceMeters]) => ({ latitude,longitude,distanceMeters }));
      stores = findPointsNearRoute(prefilterForRoute(path,150).stores, prepareRoute(path),150);
    }
    const safety = {
      status: Number.isFinite(result.finalSafetyScore) ? 'ok' : 'unavailable',
      score: result.finalSafetyScore, mode, weights: MODES[mode].weights,
      factors: { accident: result.accidentScore, streetlight: result.streetlightScore, store: result.convenienceStoreScore },
      counts: { accidents: result.pedestrianAccidents, streetlights: result.streetlights, stores: result.convenienceStores },
      coverage: result.coverage, attribution: result.attribution, dateRange: result.accidentDataDateRange,
      dataBackend, dataFiles,
    };
    // Send geometry only on demand for the selected route, not on every count poll.
    Object.defineProperty(safety, 'mapPoints', { value: {
      streetlights: mapPointCollection(lights, 'streetlights'), stores: mapPointCollection(stores, 'stores',500),
      note: mode === 'walk' ? '顯示此路線評分使用的路燈與商店點位。' : '路燈與此路線評分一致；便利商店顯示路線 150 公尺內點位，未計入車輛評分。',
    } });
    return safety;
  });
}
