const DEFAULT_TIME_ZONE = "Asia/Taipei";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLocalParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseClock(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

function minuteOfDay(hour, minute) {
  return hour * 60 + minute;
}

function inRange(current, startHour, startMinute, endHour, endMinute) {
  const start = minuteOfDay(startHour, startMinute);
  const end = minuteOfDay(endHour, endMinute);
  return current >= start && current < end;
}

/**
 * A deliberately mild time-of-day prior.
 *
 * OSRM already has road-class-based travel times. The old model multiplied every
 * route by 1.35-1.45 during peaks, which made city trips wildly inaccurate.
 * This function now only supplies a small prior for the part of a route that
 * does not have route-specific TDX traffic coverage.
 */
export function getTimeOfDayTrafficFactor({
  departureTime = null,
  date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const local = getLocalParts(date, timeZone);
  const requested = parseClock(departureTime);

  const hour = requested?.hour ?? local.hour;
  const minute = requested?.minute ?? local.minute;
  const current = minuteOfDay(hour, minute);

  const isWeekend = local.weekday === "Sat" || local.weekday === "Sun";

  let factor = 1.03;
  let level = "Normal Traffic Prior";
  let description = "Mild Taiwan weekday traffic prior";
  let isPeak = false;

  if (isWeekend) {
    if (inRange(current, 11, 0, 20, 0)) {
      factor = 1.06;
      level = "Weekend Daytime Prior";
      description = "Mild weekend daytime traffic prior";
    } else {
      factor = 1.01;
      level = "Weekend Light Prior";
      description = "Very small weekend traffic prior";
    }
  } else if (inRange(current, 7, 0, 9, 30)) {
    factor = 1.12;
    level = "Morning Peak Prior";
    description = "Mild weekday morning peak prior";
    isPeak = true;
  } else if (inRange(current, 16, 30, 19, 30)) {
    factor = 1.15;
    level = "Evening Peak Prior";
    description = "Mild weekday evening peak prior";
    isPeak = true;
  } else if (inRange(current, 11, 30, 13, 30)) {
    factor = 1.05;
    level = "Midday Prior";
    description = "Small weekday midday traffic prior";
  } else if (current >= 22 * 60 || current < 6 * 60) {
    factor = 1.0;
    level = "Night Prior";
    description = "No extra traffic multiplier at night";
  }

  return {
    factor,
    level,
    description,
    isPeak,
    timeZone,
    localHour: hour,
    localMinute: minute,
    departureTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(
      2,
      "0"
    )}`,
    weekday: local.weekday,
    isWeekend,
  };
}

function extractLiveTraffics(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.LiveTraffics)) return data.LiveTraffics;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.samples)) return data.samples;
  return [];
}

function calculateAverageSpeed(liveTraffics) {
  const speeds = liveTraffics
    .map((item) => Number(item.TravelSpeed))
    .filter((speed) => Number.isFinite(speed) && speed > 0 && speed < 180);

  if (!speeds.length) return null;

  return speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
}

function calculateCongestionStats(liveTraffics) {
  let smooth = 0;
  let normal = 0;
  let slow = 0;
  let congested = 0;
  let unknown = 0;

  for (const item of liveTraffics) {
    const id = String(item.CongestionLevelID || "").toUpperCase();
    const level = String(item.CongestionLevel ?? "");

    if (id === "A" || level === "1") smooth += 1;
    else if (id === "B" || level === "2") normal += 1;
    else if (id === "C" || level === "3") slow += 1;
    else if (id === "D" || id === "E" || level === "4" || level === "5") {
      congested += 1;
    } else {
      unknown += 1;
    }
  }

  const total = liveTraffics.length || 1;

  return {
    smooth,
    normal,
    slow,
    congested,
    unknown,
    slowRatio: slow / total,
    congestedRatio: congested / total,
  };
}

/**
 * Global TDX traffic is useful as telemetry, but it must NOT be used to modify
 * every user's ETA. Only route-specific TDX matching should materially change
 * an ETA. This function therefore preserves the mild time prior and exposes
 * the nationwide TDX statistics for diagnostics/UI only.
 */
export function calculateLiveTrafficFactor(
  baseTrafficInfo,
  freewayData,
  highwayData
) {
  const freewayLiveTraffics = extractLiveTraffics(freewayData);
  const highwayLiveTraffics = extractLiveTraffics(highwayData);
  const allLiveTraffics = [...freewayLiveTraffics, ...highwayLiveTraffics];

  const averageSpeed = calculateAverageSpeed(allLiveTraffics);
  const congestionStats = calculateCongestionStats(allLiveTraffics);
  const liveDataAvailable = allLiveTraffics.length > 0;

  return {
    factor: clamp(Number(baseTrafficInfo?.factor || 1), 0.95, 1.2),
    level: liveDataAvailable
      ? `${baseTrafficInfo?.level || "Traffic Prior"} + TDX telemetry available`
      : `${baseTrafficInfo?.level || "Traffic Prior"} + no TDX telemetry`,
    description: liveDataAvailable
      ? `${baseTrafficInfo?.description || "Traffic prior"}. Nationwide TDX data is shown for diagnostics only; ETA uses route-specific TDX matching when available.`
      : `${baseTrafficInfo?.description || "Traffic prior"}. No TDX live telemetry was available.`,
    liveDataAvailable,
    liveDataCount: allLiveTraffics.length,
    freewayLiveDataCount: freewayLiveTraffics.length,
    highwayLiveDataCount: highwayLiveTraffics.length,
    averageSpeed: averageSpeed === null ? null : Number(averageSpeed.toFixed(1)),
    slowRatio: Number(congestionStats.slowRatio.toFixed(3)),
    congestedRatio: Number(congestionStats.congestedRatio.toFixed(3)),
    liveTrafficPenalty: 0,
  };
}