// pedestrianSafety/radiusThresholds.js
//
// Scales the scoring thresholds to the buffer radius actually used (2026-10).
//
// Every score is a density (accidents / streetlights / stores per km² of
// buffer). All three sit ON roads, so a narrow buffer is mostly road and
// every density goes up; a wide one is mostly buildings and they go down.
// The thresholds were calibrated at one radius (walking 150 m, scooter /
// car 50 m). Used unchanged at 30 m, a normal street already exceeds the
// accident ceiling and scores 0.
//
// The table below comes from scripts/calibrate-radius.mjs (12,000 Taipei
// road points): at each radius, the density at the SAME percentile of road
// points that the reference threshold sits at in its reference radius.
// Values are normalised to the reference radius (= 1), so the thresholds in
// scoring.js / modes.js stay the single source of truth; between radii we
// interpolate on log(radius), outside 20-300 m we clamp.

const RADII = [20, 30, 50, 75, 100, 150, 200, 300];

// Raw calibrated densities (calibrate-radius.mjs, N = 12,000).
const RAW = {
  walk: {
    ref: 150,
    acc: [173, 137, 88, 63, 50, 38, 33, 28],
    light: [3979, 3183, 2546, 2207, 2037, 1799, 1679, 1542],
    store: [796, 354, 255, 170, 127, 85, 80, 67],
  },
  scooter: {
    ref: 50,
    acc: [1569, 1414, 1129, 934, 718, 527, 435, 327],
    light: [3979, 3183, 2569, 2207, 2037, 1811, 1679, 1546],
  },
  car: {
    ref: 50,
    acc: [606, 540, 414, 324, 255, 177, 139, 106],
    light: [3979, 3183, 2569, 2207, 2037, 1811, 1679, 1546],
  },
};

function interp(values, r) {
  const lr = Math.log(Math.min(RADII[RADII.length - 1], Math.max(RADII[0], r)));
  for (let i = 0; i < RADII.length - 1; i++) {
    const a = Math.log(RADII[i]);
    const b = Math.log(RADII[i + 1]);
    if (lr <= b) {
      const t = (lr - a) / (b - a);
      return Math.exp(Math.log(values[i]) * (1 - t) + Math.log(values[i + 1]) * t);
    }
  }
  return values[values.length - 1];
}

/** Multiplier for one threshold at radius r (1 at the mode's reference radius). */
export function radiusFactor(modeKey, kind, r) {
  const m = RAW[modeKey] || RAW.walk;
  const v = m[kind] || m.light;
  return interp(v, r) / interp(v, m.ref);
}

/**
 * Returns `config` with its density thresholds scaled to `bufferRadius`.
 * At the mode's reference radius it returns the config unchanged.
 */
export function configForRadius(config, bufferRadius, modeKey = "walk") {
  const m = RAW[modeKey] || RAW.walk;
  if (!(bufferRadius > 0) || Math.abs(bufferRadius - m.ref) < 1e-9) return config;
  const out = { ...config };
  out.maxAcceptableAccidentDensity = config.maxAcceptableAccidentDensity * radiusFactor(modeKey, "acc", bufferRadius);
  out.idealStreetlightDensity = config.idealStreetlightDensity * radiusFactor(modeKey, "light", bufferRadius);
  if (config.idealConvenienceStoreDensity != null) {
    out.idealConvenienceStoreDensity =
      config.idealConvenienceStoreDensity * radiusFactor(modeKey, "store", bufferRadius);
  }
  return out;
}
