export const ETA_V8_1_PARTIAL_CITY_COVERAGE = true;

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs} ms`);
  error.code = "CITY_SCOPE_TIMEOUT";
  return error;
}

export function withCityScopeTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function loadCityPackagesResilient({
  cities,
  getShape,
  getLink,
  getLive,
  buildPackage,
  perScopeTimeoutMs = 5500,
  logger = console,
}) {
  const uniqueCities = [...new Set((cities || []).map((x) => String(x || "").trim()).filter(Boolean))];

  const diagnostics = [];

  const tasks = uniqueCities.map(async (city) => {
    try {
      const result = await withCityScopeTimeout(
        (async () => {
          const [shapeResult, linkResult, liveResult] = await Promise.allSettled([
            getShape(city),
            getLink(city),
            getLive(city),
          ]);

          const diagnostic = {
            city,
            shape: shapeResult.status,
            link: linkResult.status,
            live: liveResult.status,
            usable: false,
            reason: null,
          };

          if (shapeResult.status !== "fulfilled") {
            diagnostic.reason = shapeResult.reason?.message || "SectionShape unavailable";
            return { package: null, diagnostic };
          }

          if (liveResult.status !== "fulfilled") {
            diagnostic.reason = liveResult.reason?.message || "Live/City unavailable";
            return { package: null, diagnostic };
          }

          const sectionLinkData =
            linkResult.status === "fulfilled" ? linkResult.value : [];

          const pkg = buildPackage(
            city,
            shapeResult.value,
            sectionLinkData,
            liveResult.value
          );

          diagnostic.usable = true;
          diagnostic.reason = linkResult.status === "fulfilled"
            ? "ok"
            : "ok_without_optional_section_link";

          return { package: pkg, diagnostic };
        })(),
        perScopeTimeoutMs,
        `TDX city scope ${city}`
      );

      diagnostics.push(result.diagnostic);
      return result.package;
    } catch (error) {
      diagnostics.push({
        city,
        shape: "unknown",
        link: "unknown",
        live: "unknown",
        usable: false,
        reason: error?.message || String(error),
        timeout: error?.code === "CITY_SCOPE_TIMEOUT",
      });
      return null;
    }
  });

  const packages = (await Promise.all(tasks)).filter(Boolean);

  try {
    logger.log("[TDX city partial coverage]", {
      requestedScopes: uniqueCities,
      usableScopes: packages.map((pkg) => pkg?.city).filter(Boolean),
      packageCount: packages.length,
      diagnostics,
    });
  } catch {}

  return { packages, diagnostics };
}
