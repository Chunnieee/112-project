// RiskNav ETA actual-trip tracker V7.
// Privacy: raw GPS samples remain in browser memory and are never posted.
// Only completed-trip duration + route/corridor ETA metadata are sent.

(() => {
  if (window.__riskNavEtaTripTrackerInstalled) return;
  window.__riskNavEtaTripTrackerInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  const PENDING_KEY = "risknav_eta_feedback_pending_v6";
  const ACTIVE_KEY = "risknav_eta_active_trip_v7";

  let armed = null;
  let watchId = null;
  let lastRouteResponse = null;
  let lastSavedFeedback = null;

  function makeTripId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `trip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function feedbackKey(payload) {
    return String(
      payload?.tripId ||
      `${payload?.routeHash || "route"}:${payload?.departedAt || "manual"}:${payload?.actualMin || ""}`
    );
  }

  function mergeRoutes(existing, incoming) {
    const out = [];
    const seen = new Set();
    for (const route of [...(existing || []), ...(incoming || [])]) {
      const key = String(route?.etaFeedback?.routeHash || route?.routeId || route?.label || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(route);
    }
    return out;
  }

  function readActiveSession() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || "null");
      if (!parsed || !parsed.tripId || !Number.isFinite(Number(parsed.departedAt))) return null;
      if (Date.now() - Number(parsed.departedAt) > 12 * 60 * 60 * 1000) {
        sessionStorage.removeItem(ACTIVE_KEY);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeActiveSession(value) {
    try {
      if (!value) {
        sessionStorage.removeItem(ACTIVE_KEY);
        return;
      }
      sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(value));
    } catch {
      // Session persistence is best-effort only.
    }
  }

  function persistActiveTrip() {
    if (!armed?.departedAt) return;
    writeActiveSession({
      tripId: armed.tripId,
      departedAt: armed.departedAt,
      traveledMeters: Math.max(0, Number(armed.traveledMeters || 0)),
      destination: armed.destination,
    });
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const p1 = toRad(a.lat);
    const p2 = toRad(b.lat);
    const dp = toRad(b.lat - a.lat);
    const dl = toRad(b.lon - a.lon);
    const h =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function routePoints(route) {
    const coords = route?.geometry?.coordinates;
    if (!Array.isArray(coords)) return [];

    const step = Math.max(1, Math.floor(coords.length / 180));
    const out = [];
    for (let i = 0; i < coords.length; i += step) {
      const [lon, lat] = coords[i] || [];
      if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
        out.push({ lat: Number(lat), lon: Number(lon) });
      }
    }

    const last = coords[coords.length - 1];
    if (Array.isArray(last) && last.length >= 2) {
      out.push({ lat: Number(last[1]), lon: Number(last[0]) });
    }
    return out;
  }

  function nearestRouteDistanceMeters(point, route) {
    const points = route.__etaTrackerPoints || (route.__etaTrackerPoints = routePoints(route));
    let best = Infinity;
    for (const p of points) best = Math.min(best, distanceMeters(point, p));
    return best;
  }

  function chooseActualRoute(track, routes) {
    if (!track.length || !routes.length) return routes[0] || null;
    const stride = Math.max(1, Math.floor(track.length / 40));
    const samples = track.filter((_, i) => i % stride === 0);

    let best = null;
    let bestScore = Infinity;

    for (const route of routes) {
      let sum = 0;
      let count = 0;
      for (const point of samples) {
        const d = nearestRouteDistanceMeters(point, route);
        if (Number.isFinite(d)) {
          sum += Math.min(d, 3000);
          count += 1;
        }
      }
      if (!count) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = route;
      }
    }

    return best || routes[0] || null;
  }

  function stopWatch() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }

  function readPending() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.slice(-20) : [];
    } catch {
      return [];
    }
  }

  function writePending(items) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify((items || []).slice(-20)));
    } catch {
      // Storage failure must not break navigation.
    }
  }

  function queuePending(payload) {
    const items = readPending();
    const key = feedbackKey(payload);
    const next = items.filter((item) => feedbackKey(item?.payload) !== key);
    next.push({ payload, queuedAt: new Date().toISOString() });
    writePending(next);
  }

  function removePending(payload) {
    const key = feedbackKey(payload);
    writePending(readPending().filter((item) => feedbackKey(item?.payload) !== key));
  }

  async function postFeedback(payload, { queueOnFailure = true } = {}) {
    // Outbox-first: if the tab closes after the server write but before the
    // response arrives, the payload is still recoverable. Backend tripId
    // idempotency makes retry safe.
    if (queueOnFailure) queuePending(payload);

    try {
      const response = await nativeFetch("/api/eta-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
      }

      removePending(payload);
      lastSavedFeedback = {
        at: new Date().toISOString(),
        tripId: payload.tripId || null,
        actualMin: Number(Number(payload.actualMin).toFixed(2)),
        routeHash: payload.routeHash || null,
        saved: data?.saved || null,
        calibration: data?.calibration || null,
      };

      console.log("[ETA tracker] actual trip saved", lastSavedFeedback);
      return true;
    } catch (error) {
      console.warn("[ETA tracker] feedback upload failed:", error.message);
      if (!queueOnFailure) queuePending(payload);
      return false;
    }
  }

  async function retryPending() {
    const items = readPending();
    if (!items.length) return { attempted: 0, saved: 0, remaining: 0 };

    const remaining = [];
    let saved = 0;

    for (const item of items) {
      const ok = await postFeedback(item.payload, { queueOnFailure: false });
      if (ok) saved += 1;
      else remaining.push(item);
    }

    writePending(remaining);
    return { attempted: items.length, saved, remaining: remaining.length };
  }

  async function submitTrip(route, departedAt, arrivedAt, tripId) {
    const feedback = route?.etaFeedback;
    if (!feedback) return;

    const actualMin = (arrivedAt - departedAt) / 60000;
    if (!Number.isFinite(actualMin) || actualMin < 2 || actualMin > 720) return;

    await postFeedback({
      ...feedback,
      tripId: tripId || makeTripId(),
      actualMin,
      departedAt: new Date(departedAt).toISOString(),
      arrivedAt: new Date(arrivedAt).toISOString(),
      trackerVersion: "v7",
    });
  }

  function beginWatch(routes, origin, destination) {
    if (armed) {
      const destinationShift = distanceMeters(armed.destination, destination);
      if (Number.isFinite(destinationShift) && destinationShift <= 1500) {
        armed.routes = mergeRoutes(armed.routes, routes);
        armed.destination = destination;
        console.log("[ETA tracker] route refresh merged", {
          tripId: armed.tripId,
          departed: Boolean(armed.departedAt),
          routeCount: armed.routes.length,
          destinationShiftM: Math.round(destinationShift),
        });
        return;
      }

      console.warn("[ETA tracker] destination changed; abandoning incomplete trip", {
        tripId: armed.tripId,
        departed: Boolean(armed.departedAt),
        destinationShiftM: Number.isFinite(destinationShift) ? Math.round(destinationShift) : null,
      });
      writeActiveSession(null);
      armed = null;
      stopWatch();
    }

    const persisted = readActiveSession();
    const canResume =
      persisted?.destination &&
      Number.isFinite(distanceMeters(persisted.destination, destination)) &&
      distanceMeters(persisted.destination, destination) <= 1500;

    stopWatch();

    armed = {
      tripId: canResume ? persisted.tripId : makeTripId(),
      routes,
      origin,
      destination,
      armedAt: Date.now(),
      departedAt: canResume ? Number(persisted.departedAt) : null,
      startPosition: null,
      lastPosition: null,
      track: [],
      traveledMeters: canResume ? Math.max(0, Number(persisted.traveledMeters || 0)) : 0,
      arrivalHits: 0,
      lastPersistAt: 0,
    };

    console.log(canResume ? "[ETA tracker] resumed" : "[ETA tracker] armed", {
      tripId: armed.tripId,
      routeCount: routes.length,
      departed: Boolean(armed.departedAt),
      privacy:
        "raw GPS remains in browser memory; session recovery stores only trip id/time/distance/destination metadata",
    });

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (!armed) return;

        const point = {
          lat: Number(position.coords.latitude),
          lon: Number(position.coords.longitude),
          at: Date.now(),
          speedMps: Number(position.coords.speed),
          accuracy: Number(position.coords.accuracy),
        };

        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
        if (Number.isFinite(point.accuracy) && point.accuracy > 120) return;

        if (!armed.startPosition) {
          if (!armed.departedAt) {
            const originDistance = distanceMeters(point, armed.origin);
            if (originDistance > 1200) return;

            console.log("[ETA tracker] start area confirmed", {
              tripId: armed.tripId,
              originDistanceM: Math.round(originDistance),
            });
          } else {
            console.log("[ETA tracker] active trip watch resumed", {
              tripId: armed.tripId,
            });
          }

          armed.startPosition = point;
          armed.lastPosition = point;
          armed.track.push(point);
          return;
        }

        const stepDistance = distanceMeters(armed.lastPosition, point);
        if (Number.isFinite(stepDistance) && stepDistance < 2000) {
          armed.traveledMeters += stepDistance;
        }
        armed.lastPosition = point;

        if (
          !armed.track.length ||
          point.at - armed.track[armed.track.length - 1].at >= 12000 ||
          distanceMeters(armed.track[armed.track.length - 1], point) >= 60
        ) {
          armed.track.push(point);
        }

        if (!armed.departedAt) {
          const fromStart = distanceMeters(armed.startPosition, point);
          const elapsedSec = (point.at - armed.startPosition.at) / 1000;
          const movingFast = Number.isFinite(point.speedMps) && point.speedMps >= 2.0;

          if (
            fromStart >= 180 &&
            elapsedSec >= 45 &&
            (movingFast || armed.traveledMeters >= 250)
          ) {
            // Use the first confirmed origin sample as departure time so the
            // first ~180 m are not systematically omitted.
            armed.departedAt = armed.startPosition.at;
            persistActiveTrip();
            console.log("[ETA tracker] trip started", {
              tripId: armed.tripId,
              detectedAfterSec: Math.round(elapsedSec),
            });
          }
          return;
        }

        if (point.at - Number(armed.lastPersistAt || 0) >= 30000) {
          armed.lastPersistAt = point.at;
          persistActiveTrip();
        }

        const toDestination = distanceMeters(point, armed.destination);
        const slowEnoughToBeArriving =
          !Number.isFinite(point.speedMps) || point.speedMps <= 10;

        if (toDestination <= 150 && slowEnoughToBeArriving) {
          armed.arrivalHits += 1;
        } else if (toDestination > 220) {
          armed.arrivalHits = 0;
        }

        const tripMin = (point.at - armed.departedAt) / 60000;
        if (armed.arrivalHits >= 3 && tripMin >= 2 && armed.traveledMeters >= 1000) {
          const finished = armed;
          armed = null;
          writeActiveSession(null);
          stopWatch();

          const actualRoute = chooseActualRoute(finished.track, finished.routes);
          submitTrip(actualRoute, finished.departedAt, point.at, finished.tripId);
        }
      },
      (error) => {
        console.warn("[ETA tracker] geolocation unavailable:", error.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000,
      }
    );
  }

  async function canArmWithoutPrompt() {
    try {
      if (!navigator.permissions?.query) return false;
      const result = await navigator.permissions.query({ name: "geolocation" });
      return result?.state === "granted";
    } catch {
      return false;
    }
  }

  async function armFromRouteResponse(data) {
    const startInput = document.getElementById("startInput");
    if (!navigator.geolocation) {
      console.log("[ETA tracker] not armed", { reason: "geolocation_unavailable" });
      return;
    }

    const routes = Array.isArray(data?.routes)
      ? data.routes.filter((route) => route?.etaFeedback && route?.geometry?.coordinates)
      : [];
    if (!routes.length) return;

    lastRouteResponse = data;

    const firstRoutePoints = routePoints(routes[0]);
    if (firstRoutePoints.length < 2) return;

    const explicitMyLocation = startInput?.value?.trim() === "我的位置";
    const alreadyGranted = explicitMyLocation ? true : await canArmWithoutPrompt();

    // Never create a new permission prompt merely because a route was planned.
    if (!explicitMyLocation && !alreadyGranted) {
      console.log("[ETA tracker] not armed", {
        reason: "geolocation_permission_not_granted",
        hint: "use 我的位置 or grant location permission before the trip",
      });
      return;
    }

    beginWatch(
      routes,
      firstRoutePoints[0],
      firstRoutePoints[firstRoutePoints.length - 1]
    );
  }

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);

    try {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url || "";
      if (/\/api\/route(?:\?|$)/.test(url) && response.ok) {
        const data = await response.clone().json();
        armFromRouteResponse(data);
      }
    } catch (error) {
      console.warn("[ETA tracker] route capture failed:", error.message);
    }

    return response;
  };

  window.RiskNavEtaTracker = {
    status() {
      return {
        installed: true,
        version: "v7",
        armed: Boolean(armed),
        tripId: armed?.tripId || null,
        departed: Boolean(armed?.departedAt),
        pendingFeedback: readPending().length,
        resumableTrip: Boolean(readActiveSession()),
        lastSavedFeedback,
        lastRouteCount: Array.isArray(lastRouteResponse?.routes)
          ? lastRouteResponse.routes.length
          : 0,
      };
    },
    retryPending,
    stop() {
      armed = null;
      writeActiveSession(null);
      stopWatch();
    },
    async submitActualMinutes(routeIndex, actualMin) {
      const routes = lastRouteResponse?.routes || [];
      const route = routes[Number(routeIndex) || 0];
      const feedback = route?.etaFeedback;
      const minutes = Number(actualMin);
      if (!feedback || !Number.isFinite(minutes) || minutes <= 0 || minutes > 720) {
        throw new Error("valid route index and actual minutes are required");
      }
      return postFeedback({
        ...feedback,
        tripId: makeTripId(),
        actualMin: minutes,
        trackerVersion: "v7-manual",
      });
    },
  };

  window.addEventListener("beforeunload", stopWatch);
  window.addEventListener("online", () => retryPending().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryPending().catch(() => {});
  });
  retryPending().catch(() => {});
  console.log("[ETA tracker] installed v7");
})();
