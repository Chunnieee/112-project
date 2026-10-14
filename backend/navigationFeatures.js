import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import routeLab from '../frontend/route-lab/engine.js';
import { getValhallaRoutes } from './valhallaClient.js';
import { createChoiceStore, hash, routeKey, journeyKey } from './routeChoiceStore.js';
import { NavigationSimulation } from './navigationSimulation.js';

const WINDOW_MINUTES = 10;
const PLAN_TTL = 30 * 60 * 1000;
const numeric = n => typeof n === 'number' && Number.isFinite(n);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const identity = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw error('匿名使用者代號格式不正確。');
  return hash(value);
};

export function validatePlan(body) {
  if (!body || !['car', 'scooter', 'walk'].includes(body.mode)) throw error('請選擇汽車、機車或步行。');
  if (typeof body.night !== 'boolean' || typeof body.distribution !== 'boolean') throw error('模式設定格式不正確。');
  if (!Array.isArray(body.routes) || body.routes.length < 1 || body.routes.length > 5) throw error('候選路線需為 1–5 條。');
  let vertices = 0;
  const routes = body.routes.map((r, i) => {
    const points = r?.geometry?.coordinates;
    if (r?.geometry?.type !== 'LineString' || !Array.isArray(points) || points.length < 2 || points.length > 12000 ||
        points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(numeric) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85)) throw error('路線座標格式不正確。');
    vertices += points.length;
    if (!numeric(r.expectedMin) || r.expectedMin <= 0 || r.expectedMin > 1440) throw error('行程時間需為有效分鐘數（最多 24 小時）。');
    return { index: i, label: `路線 ${String.fromCharCode(65 + i)}`, expectedMin: r.expectedMin,
      geometry: { type: 'LineString', coordinates: points }, key: routeKey(r, body.mode) };
  });
  if (vertices > 24000) throw error('路線資料過大。');
  if (new Set(routes.map(r => r.key)).size !== routes.length) throw error('候選路線形狀重複，請重新規劃。');
  // Alternative routes must share the same trip (allow routing snap offsets).
  const first = routes[0].geometry.coordinates;
  for (const r of routes.slice(1)) {
    const p = r.geometry.coordinates;
    if ([0, -1].some(i => Math.hypot(p.at(i)[0]-first.at(i)[0], p.at(i)[1]-first.at(i)[1]) > 0.005)) throw error('候選路線的起終點不一致。');
  }
  return routes;
}

export function evaluateNavigation(plan, counts, participant, selectedKey = null) {
  const scored = plan.routes.filter(r => numeric(r.safety?.score));
  const bestSafety = scored.length ? Math.max(...scored.map(r => r.safety.score)) : null;
  // Night recommendations stay within 5 points of the best scored candidate.
  const candidates = plan.night ? scored.filter(r => r.safety.score >= bestSafety - 5) : plan.routes;
  const minTime = Math.min(...plan.routes.map(r => r.expectedMin));
  const config = { ...routeLab.DEFAULT_CONFIG, maxRisk: 100, maxDetour: 5,
    riskWeight: plan.night ? 16 : 0, lambda: plan.distribution ? 1 : 0, windowMinutes: WINDOW_MINUTES };
  const engineConfig = { ...config, maxDetour: candidates.length ? Math.max(0, minTime + 5 - Math.min(...candidates.map(r => r.expectedMin))) : 5 };
  const engineRows = candidates.length ? routeLab.evaluate(candidates.map(r => ({
    id: r.key, name: r.label, eta: r.expectedMin,
    risk: plan.night ? 100 - r.safety.score : 0, capacity: 20,
  })), engineConfig, counts) : [];
  for (const e of engineRows) if (e.eta > minTime + 5) { e.eligible = false; e.probability = 0; }
  let eligible = engineRows.filter(r => r.eligible);
  let recommended = null;
  if (plan.distribution && eligible.length) {
    // Stable per-device draw; refreshes do not repeatedly roll a new recommendation.
    const draw = parseInt(hash(`${participant}:${plan.journey}`).slice(0, 12), 16) / 0x1000000000000;
    let cumulative = 0;
    recommended = eligible.find(r => { cumulative += r.probability; return draw < cumulative; }) ?? eligible.at(-1);
  } else if (!plan.distribution && plan.night && scored.length) {
    const winner = [...scored].sort((a,b) => b.safety.score-a.safety.score || a.expectedMin-b.expectedMin)[0];
    recommended = { id: winner.key };
  }
  const rows = plan.routes.map(r => {
    const e = engineRows.find(e => e.id === r.key);
    const reasons = [];
    if (plan.night && numeric(r.safety?.score)) reasons.push(`夜間安全 ${r.safety.score.toFixed(1)} 分（越高越好）`);
    if (plan.night && scored.length > 1) {
      for (const [key,label,coverageKey] of [['accident','事故指標','accident'],['streetlight','照明指標','streetlight'],['store','沿途商店指標','convenienceStore']]) {
        const value = r.safety?.factors?.[key];
        const peers = scored.filter(other => other.key !== r.key);
        if (numeric(value) && r.safety.coverage?.status?.[coverageKey] === 'full' &&
          peers.every(other => numeric(other.safety?.factors?.[key]) && other.safety.coverage?.status?.[coverageKey] === 'full' && value >= other.safety.factors[key]) &&
          peers.some(other => value > other.safety.factors[key] + 0.1)) reasons.push(`同類候選路線中，${label}分數較佳`);
      }
    }
    if (plan.distribution) {
      reasons.push(`近 ${WINDOW_MINUTES} 分鐘 ${counts[r.key] || 0} 位匿名使用者選擇`);
      if (eligible.some(other => (counts[other.id] || 0) > (counts[r.key] || 0)))
        reasons.push('目前選擇人數較少，有助分散本平台的集中選路');
      if (e?.eligible) reasons.push(`預估 ${r.expectedMin.toFixed(1)} 分鐘，比最快多 ${Math.max(0,r.expectedMin-minTime).toFixed(1)} 分鐘`);
      if (!e) reasons.push(plan.night && !numeric(r.safety?.score) ? '安全資料不足，未列入自動推薦' : '安全分數距離最佳路線超過 5 分，未列入分流推薦');
      else if (!e.eligible) reasons.push('超過可接受的額外 5 分鐘，未列入分流推薦');
    }
    if (plan.routes.length === 1) reasons.push('目前只有一條候選路線，尚無替代路線可分流');
    return { index: r.index, key: r.key, label: r.label, safety: r.safety ?? null,
      count: counts[r.key] || 0, recommended: recommended?.id === r.key,
      selected: selectedKey === r.key, reasons,
      model: e ? { total: e.total, riskCost: e.riskCost, loadCost: e.loadCost, probability: e.probability, eligible: e.eligible } : null };
  });
  return { routes: rows, recommendedIndex: rows.find(r => r.recommended)?.index ?? null,
    windowMinutes: WINDOW_MINUTES, config: { ...config, allocationReference: 20 },
    explanation: plan.distribution
      ? '依行程時間、開啟夜間模式時的安全分數，以及近期選擇人數計算成本，再按推薦權重分配。分流成本是排序依據，不會加到預估時間。'
      : '依同交通方式的安全分數推薦；分數相同時優先選擇較快路線。',
    safetyUnavailable: plan.night && !scored.length,
    overlapNote: '以完整路線分別統計；重疊路段尚未合併計算，不代表道路實際車流或已達奈許平衡。' };
}

export function createNavigationRouter({ store, scoreRoutes, now = Date.now } = {}) {
  store ??= createChoiceStore(fileURLToPath(new URL('./data/route-choices.sqlite', import.meta.url)));
  scoreRoutes ??= async (routes, mode) => (await import('./nightSafetyService.js')).scoreNightRoutes(routes, mode);
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  const plans = new Map();
  router.get('/route', async (req,res,next) => {
    try {
      const mode = req.query.mode;
      if (!['walk','scooter'].includes(mode)) throw error('交通方式不正確。');
      const coord = Object.fromEntries(['startLon','startLat','endLon','endLat'].map(k => [k, Number(req.query[k])]));
      if (Object.values(coord).some(n => !Number.isFinite(n)) ||
          ['startLat','endLat'].some(k => Math.abs(coord[k]) > 85) ||
          ['startLon','endLon'].some(k => Math.abs(coord[k]) > 180)) throw error('請提供有效的起終點座標。');
      let routes;
      try { routes = await getValhallaRoutes({ ...coord, costing: mode === 'walk' ? 'pedestrian' : 'motor_scooter' }); }
      catch (e) {
        if (mode !== 'walk') throw error('機車路由服務無法連線，請啟動支援 motor_scooter 的 Valhalla 服務。', 503);
        const base = process.env.OSRM_FOOT_BASE_URL || 'https://routing.openstreetmap.de/routed-foot';
        const response = await fetch(`${base}/route/v1/foot/${coord.startLon},${coord.startLat};${coord.endLon},${coord.endLat}?overview=full&geometries=geojson&steps=true&alternatives=true`, { signal: AbortSignal.timeout(12000) });
        const data = await response.json();
        if (!response.ok || data.code !== 'Ok' || !data.routes?.length) throw error('步行路由服務暫時無法取得路線。', 503);
        routes = data.routes.map((r,i) => ({ ...r, routeId: i+1, label: `路線 ${String.fromCharCode(65+i)}`, routingEngine: 'osrm-foot' }));
      }
      res.json({ routes: routes.slice(0,5).map(r => ({ ...r, transportMode: mode,
        expectedMin: r.duration / 60, distanceKm: r.distance / 1000,
        riskStatus: 'not-applicable', worst10Min: null, congestionSegments: [] })) });
    } catch(e) { next(e); }
  });
  const snapshot = (plan, participant) => {
    const counts = store.counts(plan.routes.map(r => r.key), now());
    const choice = store.active(participant, plan.journey, now());
    return { planId: plan.id, expiresAt: plan.expiresAt, updatedAt: now(),
      ...evaluateNavigation(plan, counts, participant, choice?.route_key),
      choiceExpiresAt: choice?.expires_at ?? null };
  };
  const readPlan = body => {
    const participant = identity(body?.participantId);
    const plan = plans.get(body?.planId);
    if (!plan || plan.expiresAt <= now()) throw error('路線分析已到期，請重新整理分析。', 410);
    if (plan.participant !== participant) throw error('這組路線不屬於目前使用者。', 403);
    return { plan, participant };
  };
  router.post('/analyze', async (req,res,next) => {
    try {
      const participant = identity(req.body?.participantId);
      const routes = validatePlan(req.body);
      if (req.body.night) {
        try {
          const scores = await scoreRoutes(routes, req.body.mode);
          routes.forEach((r,i) => { r.safety = scores[i]; });
        } catch (e) {
          console.warn('[night safety]', e.message);
          routes.forEach(r => { r.safety = { status: 'unavailable', score: null, message: '安全資料暫時無法取得，請稍後重試。' }; });
        }
      }
      for (const [id,p] of plans) if (p.expiresAt <= now()) plans.delete(id);
      if (plans.size >= 1000) plans.delete(plans.keys().next().value);
      const plan = { id: randomUUID(), participant, routes, night: req.body.night, distribution: req.body.distribution,
        tripLabel: typeof req.body.tripLabel === 'string' ? req.body.tripLabel.slice(0,250) : '',
        journey: journeyKey(routes, req.body.mode), expiresAt: now() + PLAN_TTL };
      if (plan.distribution) store.registerRoutes(routes,req.body.mode);
      plans.set(plan.id, plan);
      res.json(snapshot(plan, participant));
    } catch (e) { next(e); }
  });
  router.post('/status', (req,res,next) => {
    try { const { plan,participant } = readPlan(req.body); res.json(snapshot(plan,participant)); } catch(e) { next(e); }
  });
  router.post('/map-points', (req,res,next) => {
    try {
      const { plan } = readPlan(req.body);
      if (!plan.night) throw error('請先開啟夜間安全模式。');
      const route = plan.routes.find(r => r.key === req.body.routeKey);
      if (!route) throw error('請選擇目前候選路線。');
      if (!route.safety?.mapPoints) throw error('這條路線的點位資料暫時無法取得，請重新分析。',503);
      res.json({ routeKey:route.key,label:route.label,...route.safety.mapPoints,coverage:route.safety.coverage });
    } catch(e) { next(e); }
  });
  router.post('/simulation', (req,res,next) => {
    try {
      const { plan } = readPlan(req.body);
      if (!plan.distribution) throw error('請先開啟分流功能。');
      const { action = 'snapshot', count, routeKey, userId, minutes } = req.body;
      if (!['snapshot','reset','add','switch','advance'].includes(action)) throw error('模擬操作不正確。');
      if (!plan.simulation || action === 'reset') plan.simulation = new NavigationSimulation(plan,evaluateNavigation);
      const sim = plan.simulation;
      if (action === 'add') sim.add(count,routeKey);
      if (action === 'switch') sim.switchRoute(userId,routeKey);
      if (action === 'advance') sim.advance(minutes);
      res.json(sim.snapshot());
    } catch(e) { next(e); }
  });
  router.post('/choice', (req,res,next) => {
    try {
      const { plan,participant } = readPlan(req.body);
      if (!plan.distribution) throw error('請先開啟分流功能。');
      const route = plan.routes.find(r => r.key === req.body.routeKey);
      if (!route) throw error('請選擇目前候選路線。');
      const before = snapshot(plan,participant);
      const row = before.routes.find(r => r.key === route.key);
      const change = store.choose({ participant, journey: plan.journey, routeKey: route.key, now: now(),
        decision: { label: route.label, tripLabel: plan.tripLabel, expectedMin: route.expectedMin, night: plan.night,
          safetyScore: route.safety?.score ?? null, recommended: row.recommended, reasons: row.reasons,
          model: row.model, config: before.config } });
      const after = snapshot(plan,participant);
      res.json({ ...after, change, before: before.routes.map(r => ({ key: r.key, count: r.count, model: r.model })) });
    } catch(e) { next(e); }
  });
  router.post('/history', (req,res,next) => {
    try { res.json({ events: store.history(identity(req.body?.participantId)) }); } catch(e) { next(e); }
  });
  router.use((err,req,res,next) => {
    res.status(err.status || 500).json({ error: err.status ? err.message : '分析服務暫時無法使用，請稍後重試。' });
  });
  return router;
}
