const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// An isolated, virtual clock and users. Reuses the production recommendation
// function and never calls the real choice store.
export class NavigationSimulation {
  constructor(plan, evaluate) {
    this.plan = { routes:plan.routes, night:plan.night, journey:plan.journey, distribution:true }; this.evaluate = evaluate;
    this.now = 0; this.issued = 0; this.expired = 0; this.nextId = 1;
    this.users = new Map(); this.events = [];
  }
  counts() {
    const counts = Object.fromEntries(this.plan.routes.map(r => [r.key,0]));
    for (const user of this.users.values()) counts[user.routeKey]++;
    return counts;
  }
  recommendation(userId) { return this.evaluate(this.plan,this.counts(),`simulation:${userId}`); }
  record(event) { this.events.unshift({ ...event,minute:this.now }); this.events.length = Math.min(100,this.events.length); }
  add(count, routeKey = null) {
    if (!Number.isInteger(count) || count < 1 || count > 100) fail('每批可加入 1–100 位虛擬使用者。');
    if (this.users.size + count > 2000) fail('最多同時模擬 2,000 人，請推進時間或重設。');
    if (routeKey && !this.plan.routes.some(r => r.key === routeKey)) fail('請選擇有效路線。');
    if (!routeKey && this.recommendation(`user-${this.nextId}`).recommendedIndex === null) fail('目前沒有符合安全與時間條件的推薦路線；仍可指定路線模擬自行選擇。');
    for (let i=0;i<count;i++) {
      const userId = `user-${this.nextId++}`;
      const before = this.recommendation(userId);
      const row = routeKey ? before.routes.find(r => r.key === routeKey) : before.routes[before.recommendedIndex];
      const user = { userId,routeKey:row.key,createdAt:this.now,expiresAt:this.now + 10 };
      this.users.set(userId,user); this.issued++;
      this.record({ kind:'choose',userId,routeKey:row.key,label:row.label,manual:!!routeKey,
        reasons:row.reasons.map(r => r.replace('位匿名使用者','位虛擬使用者')),
        probability:row.model?.probability ?? null, cost:row.model?.total ?? null });
    }
  }
  advance(minutes) {
    if (![1,5,10].includes(minutes)) fail('每次可推進 1、5 或 10 分鐘。');
    this.now += minutes; let released = 0;
    for (const [id,user] of this.users) if (user.expiresAt <= this.now) { this.users.delete(id); released++; }
    this.expired += released; this.record({ kind:'expire',released });
  }
  switchRoute(userId, routeKey) {
    const user = this.users.get(userId);
    if (!user) fail('此虛擬使用者已到期，請加入新使用者。');
    if (!this.plan.routes.some(r => r.key === routeKey)) fail('請選擇有效路線。');
    if (user.routeKey === routeKey) return;
    const previousRoute = user.routeKey; user.routeKey = routeKey;
    this.record({ kind:'switch',userId,routeKey,previousRoute });
  }
  snapshot() {
    const next = this.recommendation(`user-${this.nextId}`);
    return { ...next, simulated:true,minute:this.now,issued:this.issued,active:this.users.size,expired:this.expired,
      users:[...this.users.values()].slice(-50).reverse(),events:this.events.slice(0,30),
      routes:next.routes.map((r,i) => ({ ...r,expectedMin:this.plan.routes[i].expectedMin,
        reasons:r.reasons.map(s => s.replace('位匿名使用者','位虛擬使用者')) })) };
  }
}
