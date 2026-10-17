/*
 * 路段層級的風險：
 *   accidentHotspots()  沿線歷史事故最密集的路段（以「距起點公尺數」滑動視窗計算）
 *   alongRoute()        路線累計距離、點位投影、依距離切出子路線
 * 事故清單與安全分數使用的是同一批點（mapLayers.accidents / matched.accidents），
 * 所以熱點與分數一致，不另外抓資料。
 */

const R = 6371000;
const toXY = (lat, lon, lat0, lon0) => ({
  x: ((lon - lon0) * Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180),
  y: ((lat - lat0) * Math.PI / 180) * R,
});

/* path: [{lat, lon}] → 每個點的累計距離（公尺）與投影工具 */
export function alongRoute(path) {
  const lat0 = path[0]?.lat ?? 0, lon0 = path[0]?.lon ?? 0;
  const xy = path.map(p => toXY(p.lat, p.lon, lat0, lon0));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  const length = cum[cum.length - 1] || 0;

  /* 點位投影到最近的路段，回傳距起點公尺數與離路線距離 */
  function project(lat, lon) {
    const p = toXY(lat, lon, lat0, lon0);
    let best = { along: 0, dist: Infinity };
    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d < best.dist) best = { along: cum[i] + t * Math.sqrt(len2), dist: d };
    }
    return best;
  }

  /* 依距離取點 */
  function pointAt(m) {
    m = Math.max(0, Math.min(length, m));
    let i = cum.findIndex(c => c >= m); if (i <= 0) return [path[0].lon, path[0].lat];
    const seg = cum[i] - cum[i - 1], t = seg ? (m - cum[i - 1]) / seg : 0;
    return [path[i - 1].lon + (path[i].lon - path[i - 1].lon) * t, path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t];
  }

  /* 切出 fromM～toM 的子路線 [[lon,lat]] */
  function slice(fromM, toM) {
    const out = [pointAt(fromM)];
    for (let i = 0; i < path.length; i++) if (cum[i] > fromM && cum[i] < toM) out.push([path[i].lon, path[i].lat]);
    out.push(pointAt(toM));
    return out;
  }
  return { cum, length, project, pointAt, slice };
}

/* 嚴重度文字格式為「死亡0;受傷1」：死亡人數 ≥ 1 或類別 A1 才算死亡事故 */
const isSevere = a => a.category === 'A1' || /死亡\s*[1-9]/.test(String(a.severity || ''));

/*
 * accidents: [{latitude, longitude, date, severity}]
 * 以 windowM 公尺的視窗沿路線滑動，挑出事故最多、彼此不重疊的路段，最多 maxSpots 段。
 * 至少要 minCount 件，且明顯高於全線平均（≥ 1.5 倍）才算熱點，避免把零星事故標成熱點。
 */
export function accidentHotspots(path, accidents, { windowM = 300, maxSpots = 3, minCount = 3 } = {}) {
  if (!Array.isArray(path) || path.length < 2 || !Array.isArray(accidents) || !accidents.length) return [];
  const route = alongRoute(path);
  if (route.length < windowM) return [];
  const pts = accidents
    .filter(a => Number.isFinite(a.latitude) && Number.isFinite(a.longitude))
    .map(a => ({ ...a, along: route.project(a.latitude, a.longitude).along }))
    .sort((a, b) => a.along - b.along);
  if (pts.length < minCount) return [];
  const avgPerWindow = pts.length * windowM / route.length;
  const spots = [];
  const used = new Set();
  while (spots.length < maxSpots) {
    let best = null;
    for (let i = 0, j = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      if (j < i) j = i;
      while (j + 1 < pts.length && pts[j + 1].along - pts[i].along <= windowM) j++;
      let n = 0; for (let k = i; k <= j; k++) if (!used.has(k)) n++;
      if (!best || n > best.n) best = { i, j, n };
    }
    if (!best || best.n < minCount || best.n < avgPerWindow * 1.5) break;
    const members = [];
    for (let k = best.i; k <= best.j; k++) if (!used.has(k)) { used.add(k); members.push(pts[k]); }
    const first = members[0].along, last = members[members.length - 1].along;
    const pad = Math.max(0, (windowM - (last - first)) / 2);
    const fromM = Math.max(0, first - pad), toM = Math.min(route.length, last + pad);
    const years = members.map(m => String(m.date || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)).sort();
    spots.push({
      fromM: Math.round(fromM), toM: Math.round(toM),
      count: members.length,
      fatal: members.filter(isSevere).length,
      perKm: Math.round(members.length / Math.max(0.1, (toM - fromM) / 1000)),
      center: route.pointAt((fromM + toM) / 2),
      coords: route.slice(fromM, toM),
      years: years.length ? { from: years[0], to: years[years.length - 1] } : null,
    });
    // 已選路段附近的事故也不再參與下一輪，避免熱點黏在一起
    pts.forEach((p, k) => { if (p.along >= fromM - windowM / 2 && p.along <= toM + windowM / 2) used.add(k); });
  }
  return spots.sort((a, b) => a.fromM - b.fromM).map((s, i) => ({ id: i + 1, ...s }));
}
