export function getTimeOfDayTrafficFactor() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    if (hour >= 11 && hour < 20) {
      return {
        factor: 1.2,
        level: "Weekend Traffic",
        description: "Weekend daytime traffic adjustment"
      };
    }

    return {
      factor: 1.1,
      level: "Weekend Low Traffic",
      description: "Weekend low traffic adjustment"
    };
  }

  if (hour >= 7 && hour < 10) {
    return {
      factor: 1.35,
      level: "Morning Peak",
      description: "Weekday morning peak traffic"
    };
  }

  if (hour >= 17 && hour < 20) {
    return {
      factor: 1.45,
      level: "Evening Peak",
      description: "Weekday evening peak traffic"
    };
  }

  if (hour >= 11 && hour < 14) {
    return {
      factor: 1.2,
      level: "Midday Traffic",
      description: "Weekday midday traffic"
    };
  }

  if (hour >= 0 && hour < 6) {
    return {
      factor: 1.05,
      level: "Low Traffic",
      description: "Late night or early morning low traffic"
    };
  }

  return {
    factor: 1.15,
    level: "Normal Traffic",
    description: "Normal weekday traffic adjustment"
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
    .filter((speed) => Number.isFinite(speed) && speed > 0);

  if (speeds.length === 0) return null;

  const sum = speeds.reduce((acc, speed) => acc + speed, 0);
  return sum / speeds.length;
}

function calculateCongestionStats(liveTraffics) {
  let smooth = 0;
  let normal = 0;
  let slow = 0;
  let congested = 0;
  let unknown = 0;

  liveTraffics.forEach((item) => {
    const id = String(item.CongestionLevelID || "").toUpperCase();
    const level = String(item.CongestionLevel || "");

    if (id === "A") {
      smooth += 1;
    } else if (id === "B") {
      normal += 1;
    } else if (id === "C") {
      slow += 1;
    } else if (id === "D" || id === "E") {
      congested += 1;
    } else if (level === "1") {
      smooth += 1;
    } else if (level === "2") {
      normal += 1;
    } else if (level === "3") {
      slow += 1;
    } else if (level === "4" || level === "5") {
      congested += 1;
    } else {
      unknown += 1;
    }
  });

  const total = liveTraffics.length || 1;

  return {
    smooth,
    normal,
    slow,
    congested,
    unknown,
    slowRatio: slow / total,
    congestedRatio: congested / total
  };
}

export function calculateLiveTrafficFactor(baseTrafficInfo, freewayData, highwayData) {
  const freewayLiveTraffics = extractLiveTraffics(freewayData);
  const highwayLiveTraffics = extractLiveTraffics(highwayData);

  const allLiveTraffics = [
    ...freewayLiveTraffics,
    ...highwayLiveTraffics
  ];

  const liveDataAvailable = allLiveTraffics.length > 0;
  const liveDataCount = allLiveTraffics.length;

  if (!liveDataAvailable) {
    return {
      factor: baseTrafficInfo.factor,
      level: baseTrafficInfo.level + " + No TDX Live Data",
      description:
        baseTrafficInfo.description +
        ". No usable TDX live traffic data found, using time-of-day fallback.",
      liveDataAvailable: false,
      liveDataCount: 0,
      averageSpeed: null,
      slowRatio: 0,
      congestedRatio: 0,
      liveTrafficPenalty: 0
    };
  }

  const averageSpeed = calculateAverageSpeed(allLiveTraffics);
  const congestionStats = calculateCongestionStats(allLiveTraffics);

  let liveTrafficPenalty = 0;

  /*
    重要：
    目前這裡是全域 TDX traffic，不是只針對使用者路線。
    所以 penalty 不能加太多，不然 ETA 會被全台資料放大。
  */

  if (averageSpeed !== null) {
    if (averageSpeed < 25) {
      liveTrafficPenalty += 0.2;
    } else if (averageSpeed < 40) {
      liveTrafficPenalty += 0.12;
    } else if (averageSpeed < 55) {
      liveTrafficPenalty += 0.06;
    } else if (averageSpeed > 80) {
      liveTrafficPenalty -= 0.03;
    }
  }

  if (congestionStats.congestedRatio > 0.2) {
    liveTrafficPenalty += 0.15;
  } else if (congestionStats.congestedRatio > 0.1) {
    liveTrafficPenalty += 0.1;
  } else if (congestionStats.congestedRatio > 0.05) {
    liveTrafficPenalty += 0.05;
  }

  if (congestionStats.slowRatio > 0.25) {
    liveTrafficPenalty += 0.08;
  } else if (congestionStats.slowRatio > 0.15) {
    liveTrafficPenalty += 0.04;
  }

  // 沒有 route-level matching 前，全域 TDX 修正最多只加 0.25
  liveTrafficPenalty = Math.max(-0.05, Math.min(0.25, liveTrafficPenalty));

  // MVP 安全上限，避免 28 分鐘被放大到 60+ 分鐘
  const finalFactor = Math.min(
    1.65,
    baseTrafficInfo.factor + liveTrafficPenalty
  );

  let liveLevel = "TDX Normal";

  if (liveTrafficPenalty >= 0.18) {
    liveLevel = "TDX Heavy Traffic";
  } else if (liveTrafficPenalty >= 0.1) {
    liveLevel = "TDX Moderate Traffic";
  } else if (liveTrafficPenalty > 0) {
    liveLevel = "TDX Light Delay";
  } else if (liveTrafficPenalty < 0) {
    liveLevel = "TDX Smooth Traffic";
  }

  return {
    factor: Number(finalFactor.toFixed(2)),
    level: baseTrafficInfo.level + " + " + liveLevel,
    description:
      baseTrafficInfo.description +
      ". TDX live traffic data is connected and used to moderately adjust ETA.",
    liveDataAvailable: true,
    liveDataCount,
    freewayLiveDataCount: freewayLiveTraffics.length,
    highwayLiveDataCount: highwayLiveTraffics.length,
    averageSpeed: averageSpeed === null ? null : Number(averageSpeed.toFixed(1)),
    slowRatio: Number(congestionStats.slowRatio.toFixed(3)),
    congestedRatio: Number(congestionStats.congestedRatio.toFixed(3)),
    liveTrafficPenalty: Number(liveTrafficPenalty.toFixed(2))
  };
}