const DEFAULT_MAX_AGE_MIN = 20;
const DEFAULT_EXTREME_CRAWL_KMH = 5;

// ETA_EVIDENCE_V6_2_DEFAULT_THRESHOLD_FIX
// Fixes null -> 0 coercion that accidentally reduced the default extreme-crawl threshold from 5 km/h to 1 km/h.
// Extremely low TravelTime-derived speeds can represent a real closure/gridlock,
// but they are too influential to trust from a single field alone. They must be
// corroborated by the independently published TravelSpeed; otherwise we fall
// back to TravelSpeed (when available) or exclude the observation from ETA.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value) {
  // IMPORTANT: Number(null) and Number("") are both 0 in JavaScript.
  // For optional config/evidence fields, null/undefined/blank mean "missing",
  // not a real numeric zero. Treat them as absent before coercion.
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNumber(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function liveAgeMin(value, nowMs = Date.now()) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / 60000;
}

function qualityRank(value) {
  switch (value) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

function confidenceFromFreshness(ageMin, maxAgeMin) {
  if (!Number.isFinite(ageMin)) return "low";
  if (ageMin <= Math.min(8, maxAgeMin * 0.5)) return "high";
  if (ageMin <= maxAgeMin) return "medium";
  return "rejected";
}

/**
 * Choose one ETA-safe live observation for a TDX section.
 *
 * Policy:
 * - stale data is rejected;
 * - timestamp-less data is rejected by default (can be explicitly allowed);
 * - TravelTime is preferred when its geometry-derived speed is plausible;
 * - clearly implausible TravelTime may fall back to published TravelSpeed;
 * - very low speeds are NOT rejected: a fresh 8–15 km/h TravelTime can be a real jam;
 * - high speeds are treated as evidence-quality issues, not as reasons to invent delay.
 */
export function selectTdxLiveObservation({
  dataCollectTime = null,
  travelTimeSec = null,
  sectionLengthKm = null,
  travelSpeedKmh = null,
  maxAgeMin = DEFAULT_MAX_AGE_MIN,
  requireTimestamp = true,
  nowMs = Date.now(),
  extremeCrawlKmh = null,
} = {}) {
  const maxAge = Math.max(1, finiteNumber(maxAgeMin) ?? DEFAULT_MAX_AGE_MIN);
  const envExtreme =
    typeof process !== "undefined" && process?.env
      ? finiteNumber(process.env.TDX_EXTREME_CRAWL_KMH)
      : null;
  const extremeCrawl = Math.max(
    1,
    finiteNumber(extremeCrawlKmh) ?? envExtreme ?? DEFAULT_EXTREME_CRAWL_KMH
  );
  const ageMin = liveAgeMin(dataCollectTime, nowMs);

  if (ageMin === null && requireTimestamp) {
    return {
      accepted: false,
      observedFrom: null,
      observedSpeedKmh: null,
      dataAgeMin: null,
      confidence: "rejected",
      qualityScore: 0,
      reason: "missing_or_invalid_timestamp",
    };
  }

  if (Number.isFinite(ageMin) && (ageMin < -2 || ageMin > maxAge)) {
    return {
      accepted: false,
      observedFrom: null,
      observedSpeedKmh: null,
      dataAgeMin: ageMin,
      confidence: "rejected",
      qualityScore: 0,
      reason: ageMin < -2 ? "future_timestamp" : "stale_live_data",
    };
  }

  const sectionKm = finiteNumber(sectionLengthKm);
  const timeSec = finiteNumber(travelTimeSec);
  const publishedSpeed = finiteNumber(travelSpeedKmh);

  const travelTimeSpeed =
    sectionKm && sectionKm > 0 && timeSec && timeSec > 0
      ? sectionKm / (timeSec / 3600)
      : null;

  const validPublishedSpeed =
    publishedSpeed !== null && publishedSpeed >= 1 && publishedSpeed <= 160
      ? publishedSpeed
      : null;

  const freshnessConfidence = confidenceFromFreshness(ageMin, maxAge);

  let selected = null;

  // Extreme crawl guard: do not let one uncorroborated TravelTime field add
  // tens of minutes to a short road section. No speed is clamped and no time
  // multiplier is invented: the evidence is either corroborated, replaced by
  // the independently published TravelSpeed, or excluded from ETA.
  if (
    travelTimeSpeed !== null &&
    travelTimeSpeed >= 1 &&
    travelTimeSpeed < extremeCrawl
  ) {
    if (validPublishedSpeed !== null) {
      const high = Math.max(travelTimeSpeed, validPublishedSpeed);
      const low = Math.max(0.1, Math.min(travelTimeSpeed, validPublishedSpeed));
      const ratio = high / low;
      const diff = Math.abs(travelTimeSpeed - validPublishedSpeed);
      const independentlyCorroborated =
        validPublishedSpeed < extremeCrawl * 1.5 &&
        (ratio <= 2.5 || diff <= 3);

      if (independentlyCorroborated) {
        selected = {
          accepted: true,
          observedFrom: "TravelTime",
          observedSpeedKmh: travelTimeSpeed,
          dataAgeMin: ageMin,
          confidence: "medium",
          qualityScore: 0.7,
          reason: "extreme_crawl_corroborated_by_travel_speed",
          travelTimeDerivedSpeedKmh: travelTimeSpeed,
          travelSpeedKmh: validPublishedSpeed,
          extremeCrawlThresholdKmh: extremeCrawl,
        };
      } else {
        selected = {
          accepted: true,
          observedFrom: "TravelSpeed",
          observedSpeedKmh: validPublishedSpeed,
          dataAgeMin: ageMin,
          confidence: "medium",
          qualityScore: 0.65,
          reason: "extreme_travel_time_uncorroborated_fallback_to_speed",
          travelTimeDerivedSpeedKmh: travelTimeSpeed,
          travelSpeedKmh: validPublishedSpeed,
          extremeCrawlThresholdKmh: extremeCrawl,
        };
      }
    } else {
      return {
        accepted: false,
        observedFrom: null,
        observedSpeedKmh: null,
        dataAgeMin: ageMin,
        confidence: "rejected",
        qualityScore: 0,
        reason: "extreme_travel_time_uncorroborated_no_speed",
        travelTimeDerivedSpeedKmh: travelTimeSpeed,
        travelSpeedKmh: null,
        extremeCrawlThresholdKmh: extremeCrawl,
      };
    }
  }

  if (
    !selected &&
    travelTimeSpeed !== null &&
    travelTimeSpeed >= extremeCrawl &&
    travelTimeSpeed <= 145
  ) {
    let confidence = freshnessConfidence;
    const reasons = ["fresh_travel_time"];

    // 130–145 km/h is not automatically wrong, but it should not count as
    // the same quality as normal fresh travel-time evidence.
    if (travelTimeSpeed > 130 && qualityRank(confidence) > qualityRank("medium")) {
      confidence = "medium";
      reasons.push("high_derived_speed");
    }

    if (validPublishedSpeed !== null) {
      const high = Math.max(travelTimeSpeed, validPublishedSpeed);
      const low = Math.max(1, Math.min(travelTimeSpeed, validPublishedSpeed));
      const ratio = high / low;
      const diff = Math.abs(travelTimeSpeed - validPublishedSpeed);

      if ((ratio > 2.5 || diff > 70) && qualityRank(confidence) > qualityRank("medium")) {
        confidence = "medium";
        reasons.push("travel_time_speed_disagreement");
      }
    }

    selected = {
      accepted: true,
      observedFrom: "TravelTime",
      observedSpeedKmh: travelTimeSpeed,
      dataAgeMin: ageMin,
      confidence,
      qualityScore: confidence === "high" ? 1 : confidence === "medium" ? 0.75 : 0.4,
      reason: reasons.join("+") || "travel_time",
      travelTimeDerivedSpeedKmh: travelTimeSpeed,
      travelSpeedKmh: validPublishedSpeed,
    };
  }

  // Clearly implausible TravelTime-derived speed: use the published speed if
  // it is independently valid instead of throwing away the whole section.
  if (!selected && validPublishedSpeed !== null) {
    const confidence = freshnessConfidence === "high" ? "medium" : freshnessConfidence;
    selected = {
      accepted: true,
      observedFrom: "TravelSpeed",
      observedSpeedKmh: validPublishedSpeed,
      dataAgeMin: ageMin,
      confidence,
      qualityScore: confidence === "medium" ? 0.7 : confidence === "high" ? 0.85 : 0.35,
      reason:
        travelTimeSpeed !== null && travelTimeSpeed > 145
          ? "travel_time_implausible_fallback_to_speed"
          : "travel_speed_fallback",
      travelTimeDerivedSpeedKmh: travelTimeSpeed,
      travelSpeedKmh: validPublishedSpeed,
    };
  }

  if (!selected) {
    return {
      accepted: false,
      observedFrom: null,
      observedSpeedKmh: null,
      dataAgeMin: ageMin,
      confidence: "rejected",
      qualityScore: 0,
      reason:
        travelTimeSpeed !== null && travelTimeSpeed > 145
          ? "implausible_travel_time_no_speed_fallback"
          : "no_usable_travel_time_or_speed",
      travelTimeDerivedSpeedKmh: travelTimeSpeed,
      travelSpeedKmh: validPublishedSpeed,
    };
  }

  return selected;
}

export function summarizeEvidenceQuality(items = []) {
  const summary = {
    total: 0,
    accepted: 0,
    high: 0,
    medium: 0,
    low: 0,
    rejected: 0,
    stale: 0,
    missingTimestamp: 0,
    travelTime: 0,
    travelSpeed: 0,
  };

  for (const item of items || []) {
    summary.total += 1;
    if (item?.accepted) summary.accepted += 1;
    const confidence = String(item?.confidence || "rejected");
    if (Object.prototype.hasOwnProperty.call(summary, confidence)) {
      summary[confidence] += 1;
    }
    if (item?.reason === "stale_live_data") summary.stale += 1;
    if (item?.reason === "missing_or_invalid_timestamp") summary.missingTimestamp += 1;
    if (item?.observedFrom === "TravelTime") summary.travelTime += 1;
    if (item?.observedFrom === "TravelSpeed") summary.travelSpeed += 1;
  }

  return summary;
}

export function confidenceWeight(confidence) {
  switch (confidence) {
    case "high": return 1;
    case "medium": return 0.75;
    case "low": return 0.35;
    default: return 0;
  }
}

export function clampRatio(value) {
  return clamp(Number(value || 0), 0, 1);
}


export function calculateHistoricalBlindSpotSupplement({
  baseRouterMin,
  liveExpectedMin,
  matchedCoverageRatio,
  uncoveredBaselineMin = null,
  historicalMedianMin,
  historicalCoverageRatio,
  historicalSampleCount,
}) {
  const base = Number(baseRouterMin);
  const live = Number(liveExpectedMin);
  const matchedCoverage = clamp(Number(matchedCoverageRatio || 0), 0, 1);
  const uncoveredBaseline = Number(uncoveredBaselineMin);
  const historicalMedian = Number(historicalMedianMin);
  const historicalCoverage = clamp(Number(historicalCoverageRatio || 0), 0, 1);
  const samples = Number(historicalSampleCount || 0);

  if (
    !Number.isFinite(base) ||
    base <= 0 ||
    !Number.isFinite(live) ||
    !Number.isFinite(historicalMedian) ||
    samples < 8 ||
    historicalCoverage < 0.35
  ) {
    return {
      supplementMin: 0,
      eligible: false,
      reason: "insufficient historical route evidence",
      sampleCount: samples,
      historicalCoverageRatio: roundNumber(historicalCoverage, 4),
    };
  }

  const historicalDelayMin = Math.max(0, historicalMedian - base);
  const currentLiveDelayMin = Math.max(0, live - base);
  const missingTypicalDelayMin = Math.max(0, historicalDelayMin - currentLiveDelayMin);

  const uncoveredTimeShare =
    Number.isFinite(uncoveredBaseline) && uncoveredBaseline >= 0
      ? clamp(uncoveredBaseline / base, 0, 1)
      : clamp(1 - matchedCoverage, 0, 1);

  const historicalStrength = clamp(historicalCoverage / 0.65, 0, 1);
  const supplementMin = missingTypicalDelayMin * uncoveredTimeShare * historicalStrength;

  return {
    supplementMin: roundNumber(supplementMin, 3),
    eligible: true,
    historicalDelayMin: roundNumber(historicalDelayMin, 3),
    currentLiveDelayMin: roundNumber(currentLiveDelayMin, 3),
    missingTypicalDelayMin: roundNumber(missingTypicalDelayMin, 3),
    uncoveredTimeShare: roundNumber(uncoveredTimeShare, 4),
    historicalStrength: roundNumber(historicalStrength, 4),
    sampleCount: samples,
    historicalCoverageRatio: roundNumber(historicalCoverage, 4),
    reason: "same-weekday/time-bucket historical delay fills only the current live blind spot, weighted by uncovered baseline time",
  };
}
