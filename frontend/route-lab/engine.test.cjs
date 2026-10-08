const test = require("node:test");
const assert = require("node:assert/strict");
const { Simulation, DEFAULT_ROUTES: routes, DEFAULT_CONFIG: config, evaluate, cost, equilibrium, deviation } = require("./engine.js");
const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test("baseline: ETA + weighted risk; probabilities sum to one", () => {
  const rows = evaluate(routes, config);
  near(rows[0].total, 32.4); near(rows[1].total, 33); near(rows[2].total, 33.96);
  near(rows.reduce((sum, row) => sum + row.probability, 0), 1);
  assert.ok(rows[0].probability > rows[1].probability && rows[1].probability > rows[2].probability);
});
test("same extra person has different penalty depending on route quota and load", () => {
  const large = { ...routes[0], capacity: 40 }, small = { ...routes[0], capacity: 20 };
  const change = r => cost(r, 21, config).loadCost - cost(r, 20, config).loadCost;
  assert.ok(change(small) > change(large));
  assert.ok(cost(large, 40, config).loadCost > cost(large, 20, config).loadCost);
});
test("one recommendation increases only the chosen route cost; all probabilities update", () => {
  const sim = new Simulation(), before = sim.snapshot(); const result = sim.recommend("someone"); const after = sim.snapshot();
  for (let i = 0; i < after.length; i++) {
    if (after[i].id === result.routeId) { assert.equal(after[i].count, 1); assert.ok(after[i].total > before[i].total); assert.ok(after[i].probability < before[i].probability); }
    else { near(after[i].total, before[i].total); assert.ok(after[i].probability > before[i].probability); }
  }
});
test("same user is cached without increasing counts, logs, or refreshing expiry", () => {
  const sim = new Simulation(), initial = sim.recommend("test-user"); sim.advance(5);
  const issued = sim.issued, logs = sim.logs.length, result = sim.recommend("test-user");
  assert.equal(result.routeId, initial.routeId); assert.equal(result.createdAt, 0); assert.equal(result.cached, true);
  assert.equal(sim.issued, issued); assert.equal(sim.logs.length, logs); assert.equal(sim.active.size, 1);
});
test("staggered expiry removes only expired recommendations, at the exact boundary", () => {
  const sim = new Simulation(); sim.batch(10); sim.advance(5); sim.batch(10);
  assert.equal(sim.advance(5), 10); assert.equal(sim.active.size, 10);
  assert.equal(sim.advance(5), 10); assert.equal(sim.active.size, 0);
  const current = sim.snapshot(), baseline = evaluate(routes, config);
  current.forEach((row, i) => { near(row.total, baseline[i].total); near(row.probability, baseline[i].probability); });
  assert.equal(sim.issued, 20); assert.equal(sim.expired, 20);
});
test("manual switch transfers rather than duplicates load and preserves original expiry", () => {
  const sim = new Simulation(), first = sim.recommend("user"); sim.advance(5);
  const other = routes.find(r => r.id !== first.routeId).id;
  sim.switchRoute("user", other);
  assert.equal(sim.counts()[first.routeId], 0); assert.equal(sim.counts()[other], 1); assert.equal(sim.active.size, 1);
  assert.equal(sim.issued, 1); assert.equal(sim.active.get("user").createdAt, 0); assert.equal(sim.advance(5), 1);
  assert.throws(() => sim.switchRoute("user", other), /到期/);
});
test("time and risk constraints exclude routes, including rejection when no route qualifies", () => {
  const rows = evaluate(routes, { ...config, maxDetour: 0 }); near(rows[0].probability, 1); near(rows[1].probability, 0);
  const sim = new Simulation(routes, { ...config, maxRisk: 0 });
  assert.ok(sim.snapshot().every(r => !r.eligible && r.probability === 0));
  assert.throws(() => sim.recommend("blocked"), /沒有符合/); assert.equal(sim.active.size, 0);
  assert.throws(() => equilibrium(routes, { ...config, maxRisk: 0 }), /沒有符合/);
});
test("risk threshold boundary is inclusive; manual choice cannot bypass filters", () => {
  const sim = new Simulation(routes, { ...config, maxRisk: 25 });
  assert.equal(sim.snapshot()[1].eligible, true); const result = sim.recommend("user");
  assert.notEqual(result.routeId, "A"); assert.throws(() => sim.switchRoute("user", "A"), /不符合/);
});
test("invalid external risk data is rejected instead of assumed safe", () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, 101]) assert.throws(() => new Simulation([{ ...routes[0], risk: bad }], config));
  assert.throws(() => new Simulation([{ ...routes[0], capacity: 0 }], config));
  assert.throws(() => new Simulation(routes, { ...config, temperature: 0 }));
});
test("a batch equals sequential recommendations and conserves 100 assignments", () => {
  const batch = new Simulation(), sequence = new Simulation(); batch.batch(100);
  for (let i = 0; i < 100; i++) sequence.recommend(sequence.freshId());
  assert.deepEqual(batch.counts(), sequence.counts()); assert.equal(Object.values(batch.counts()).reduce((a, b) => a + b), 100);
  assert.ok(Object.values(batch.counts()).every(v => v > 0));
  assert.ok(batch.snapshot().every(r => Number.isFinite(r.total) && Number.isFinite(r.probability)));
});
test("zero lambda removes load penalty even after many recommendations", () => {
  const sim = new Simulation(routes, { ...config, lambda: 0 }); const before = sim.snapshot(); sim.batch(100);
  sim.snapshot().forEach((r, i) => { near(r.total, before[i].total); near(r.probability, before[i].probability); });
});
test("softmax stays finite with extreme valid counts and temperature", () => {
  const rows = evaluate(routes.map(r => ({ ...r, capacity: 1 })), { ...config, beta: 6, temperature: 0.1 }, { A: 1998, B: 1, C: 1 });
  assert.ok(rows.every(r => Number.isFinite(r.probability))); near(rows.reduce((a, r) => a + r.probability, 0), 1);
});
test("finite Nash result conserves players and has no profitable unilateral move", () => {
  for (const players of [1, 17, 100, 300]) {
    const result = equilibrium(routes, config, players);
    assert.equal(Object.values(result.counts).reduce((a, b) => a + b), players); assert.equal(result.converged, true);
    for (const from of routes) for (const to of routes) {
      if (from.id === to.id || result.counts[from.id] === 0) continue;
      assert.ok(cost(from, result.counts[from.id], config).total <= cost(to, result.counts[to.id] + 1, config).total + 1e-8);
    }
  }
});
test("Nash deviation includes the entrant; empty route is not automatically attractive", () => {
  const toy = [{ ...routes[0], eta: 1, risk: 0, capacity: 1 }, { ...routes[1], eta: 1, risk: 0, capacity: 1 }];
  const best = deviation(toy, { ...config, alpha: 10 }, { A: 1, B: 0 }); near(best.gain, 0);
});
test("equilibrium respects candidate filters and zero-load-weight case", () => {
  const one = equilibrium(routes, { ...config, maxDetour: 0 }); assert.deepEqual(one.counts, { A: 100, B: 0, C: 0 });
  const noPenalty = equilibrium(routes, { ...config, lambda: 0 }); assert.deepEqual(noPenalty.counts, { A: 100, B: 0, C: 0 });
});

