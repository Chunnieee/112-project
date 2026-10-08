/* Pure model: also runs in Node for verification. No network or backend access. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RouteLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DEFAULT_ROUTES = [
    { id: "A", name: "市區直達線", eta: 28, risk: 55, capacity: 40, color: "#546ce4" },
    { id: "B", name: "外環平衡線", eta: 31, risk: 25, capacity: 30, color: "#159d87" },
    { id: "C", name: "河岸替代線", eta: 33, risk: 12, capacity: 20, color: "#d98a30" },
  ];
  const DEFAULT_CONFIG = { riskWeight: 8, lambda: 1, alpha: 10, beta: 4, temperature: 1.5, maxDetour: 5, maxRisk: 80, windowMinutes: 10 };
  function validate(routes, config) {
    if (!Array.isArray(routes) || !routes.length) throw new Error("至少需要一條路線。");
    const ids = new Set();
    for (const r of routes) {
      if (typeof r.id !== "string" || !r.id || ids.has(r.id)) throw new Error("路線 ID 必須唯一。");
      ids.add(r.id);
      for (const key of ["eta", "risk", "capacity"]) if (!Number.isFinite(r[key])) throw new Error("路線資料必須是有限數值。");
      if (r.eta <= 0 || r.eta > 1440 || r.risk < 0 || r.risk > 100 || !Number.isInteger(r.capacity) || r.capacity < 1 || r.capacity > 10000) throw new Error("請檢查旅行時間、風險與分配額度的範圍。");
    }
    const ranges = { riskWeight: [0, 60], lambda: [0, 5], alpha: [0, 60], beta: [1, 6], temperature: [0.1, 20], maxDetour: [0, 60], maxRisk: [0, 100], windowMinutes: [1, 60] };
    for (const [key, [lo, hi]] of Object.entries(ranges)) if (!Number.isFinite(config[key]) || config[key] < lo || config[key] > hi) throw new Error(`參數 ${key} 超出允許範圍。`);
  }
  function cost(route, count, config) {
    const riskCost = config.riskWeight * route.risk / 100;
    const loadRatio = count / route.capacity;
    const loadCost = config.lambda * config.alpha * Math.pow(loadRatio, config.beta);
    return { riskCost, loadRatio, loadCost, total: route.eta + riskCost + loadCost };
  }
  function evaluate(routes, config, counts = {}) {
    validate(routes, config);
    const fastest = Math.min(...routes.map(r => r.eta));
    const result = routes.map(r => {
      const count = counts[r.id] ?? 0;
      if (!Number.isInteger(count) || count < 0) throw new Error("分配人數必須是非負整數。");
      const reasons = [];
      if (r.eta > fastest + config.maxDetour) reasons.push(`多於最快路線 ${config.maxDetour} 分鐘`);
      if (r.risk > config.maxRisk) reasons.push(`風險超過 ${config.maxRisk}`);
      return { ...r, count, ...cost(r, count, config), eligible: reasons.length === 0, reasons, probability: 0 };
    });
    const eligible = result.filter(r => r.eligible);
    if (!eligible.length) return result;
    const min = Math.min(...eligible.map(r => r.total));
    const weights = eligible.map(r => Math.exp(-(r.total - min) / config.temperature));
    const denominator = weights.reduce((a, b) => a + b, 0);
    eligible.forEach((r, i) => { r.probability = weights[i] / denominator; });
    return result;
  }
  // Stable pseudo-random draw for a reproducible demo; not an identity/security mechanism.
  function uniform(seed) {
    let h = 2166136261;
    for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  class Simulation {
    constructor(routes = DEFAULT_ROUTES, config = DEFAULT_CONFIG) {
      validate(routes, config);
      this.routes = routes.map(r => ({ ...r })); this.config = { ...config };
      this.now = 0; this.active = new Map(); this.logs = []; this.history = [];
      this.issued = 0; this.expired = 0; this.nextId = 1; this.lastResult = null;
      this.recordHistory();
    }
    counts() {
      const result = Object.fromEntries(this.routes.map(r => [r.id, 0]));
      for (const a of this.active.values()) result[a.routeId]++;
      return result;
    }
    snapshot() { return evaluate(this.routes, this.config, this.counts()); }
    recordHistory() {
      this.history.push({ index: this.issued, minute: this.now, costs: this.snapshot().map(r => ({ id: r.id, total: r.total })) });
      if (this.history.length > 201) this.history.shift();
    }
    log(kind, message, before, after, userId = null) {
      const event = { kind, message, minute: this.now, userId, before, after };
      this.logs.unshift(event); this.logs = this.logs.slice(0, 200); this.recordHistory(); return event;
    }
    freshId() {
      let id;
      do { id = `user-${String(this.nextId++).padStart(3, "0")}`; } while (this.active.has(id));
      return id;
    }
    recommend(userId) {
      userId = String(userId).trim();
      if (!userId || userId.length > 64) throw new Error("請輸入 1–64 字的模擬使用者代號。");
      const existing = this.active.get(userId);
      if (existing) return this.lastResult = { ...existing, cached: true };
      const before = this.snapshot(), eligible = before.filter(r => r.eligible);
      if (!eligible.length) throw new Error("沒有符合時間與風險門檻的路線。請先調整條件。");
      if (this.active.size >= 2000) throw new Error("本輪最多模擬 2,000 人，請推進時間或重新開始。");
      const draw = uniform(`${userId}|${this.now}|${this.issued}|route-lab-v1`);
      let cumulative = 0;
      const selected = eligible.find(r => { cumulative += r.probability; return draw < cumulative; }) || eligible.at(-1);
      const assignment = { userId, routeId: selected.id, createdAt: this.now, probabilityAtDecision: selected.probability, costAtDecision: selected.total };
      this.active.set(userId, assignment); this.issued++;
      this.log("recommend", `${userId} → ${selected.id}，有效分配 +1`, before, this.snapshot(), userId);
      return this.lastResult = { ...assignment, cached: false };
    }
    batch(count) {
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("每批請輸入 1–100 人。");
      if (this.active.size + count > 2000) throw new Error("本輪最多模擬 2,000 人，請推進時間或重新開始。");
      for (let i = 0; i < count; i++) this.recommend(this.freshId());
      return this.lastResult;
    }
    switchRoute(userId, routeId) {
      const assignment = this.active.get(userId);
      if (!assignment) throw new Error("此使用者的分配已到期，請重新取得推薦。");
      const before = this.snapshot(), target = before.find(r => r.id === routeId);
      if (!target?.eligible) throw new Error("此替代路線不符合目前的時間或風險門檻。");
      if (assignment.routeId === routeId) return this.lastResult = { ...assignment, cached: true };
      const previous = assignment.routeId;
      assignment.routeId = routeId; assignment.manual = true;
      // Switching transfers the existing reservation; its original expiry is preserved.
      this.log("switch", `${userId} 改選 ${routeId}：${previous} −1、${routeId} +1`, before, this.snapshot(), userId);
      return this.lastResult = { ...assignment, cached: false };
    }
    advance(minutes) {
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("推進時間必須大於 0。");
      const before = this.snapshot(); this.now += minutes; let released = 0;
      for (const [id, entry] of this.active) {
        if (entry.createdAt + this.config.windowMinutes <= this.now) { this.active.delete(id); released++; }
      }
      this.expired += released;
      this.log("expire", `時間 +${minutes} 分鐘，釋放 ${released} 筆到期分配`, before, this.snapshot());
      return released;
    }
  }
  // Finite, identical, unit-demand players on independent routes. A deviator adds
  // one unit to the destination; omitting this +1 would test a different game.
  function deviation(routes, config, counts) {
    const allowed = evaluate(routes, config, counts).filter(r => r.eligible);
    let best = { gain: 0, from: null, to: null };
    for (const from of allowed) {
      if (!counts[from.id]) continue;
      for (const to of allowed) {
        if (from.id === to.id) continue;
        const gain = cost(from, counts[from.id], config).total - cost(to, (counts[to.id] || 0) + 1, config).total;
        if (gain > best.gain) best = { gain, from: from.id, to: to.id };
      }
    }
    return best;
  }
  function equilibrium(routes, config, players = 100) {
    if (!Number.isInteger(players) || players < 1 || players > 2000) throw new Error("平衡比較人數需介於 1–2,000。");
    const allowed = evaluate(routes, config).filter(r => r.eligible);
    if (!allowed.length) throw new Error("沒有符合門檻的路線，無法進行平衡比較。");
    const counts = Object.fromEntries(routes.map(r => [r.id, 0])); counts[allowed[0].id] = players;
    let moves = 0, best = deviation(routes, config, counts);
    while (best.gain > 1e-8 && moves < 100000) {
      counts[best.from]--; counts[best.to]++; moves++;
      best = deviation(routes, config, counts);
    }
    return { counts, moves, gain: best.gain, converged: best.gain <= 1e-8, rows: evaluate(routes, config, counts) };
  }
  return { DEFAULT_ROUTES, DEFAULT_CONFIG, Simulation, evaluate, cost, equilibrium, deviation };
});

