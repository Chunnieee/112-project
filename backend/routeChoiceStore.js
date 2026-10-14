import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const hash = value => createHash('sha256').update(String(value)).digest('hex');

// Geometry, direction and mode identify a route, never its A/B/C display order.
export function routeKey(route, mode) {
  const points = route.geometry.coordinates;
  const quantized = points.map(p => p.map(n => Number(n.toFixed(5))));
  // Remove collinear vertices so harmless changes in polyline sampling share counts.
  const simplified = [];
  for (const p of quantized) {
    if (JSON.stringify(p) === JSON.stringify(simplified.at(-1))) continue;
    while (simplified.length > 1) {
      const a = simplified.at(-2), b = simplified.at(-1);
      const cross = (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
      const forward = (b[0]-a[0])*(p[0]-b[0])+(b[1]-a[1])*(p[1]-b[1]);
      if (Math.abs(cross) > 1e-12 || forward < 0) break;
      simplified.pop();
    }
    simplified.push(p);
  }
  return hash(JSON.stringify([mode, simplified]));
}

export function journeyKey(routes, mode) {
  const p = routes[0].geometry.coordinates;
  return hash(JSON.stringify([mode, p[0].map(n => n.toFixed(3)), p.at(-1).map(n => n.toFixed(3))]));
}

export function createChoiceStore(filename, windowMs = 10 * 60 * 1000) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_catalog (
      route_key TEXT PRIMARY KEY, mode TEXT NOT NULL, geometry_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_choices (
      participant TEXT NOT NULL, journey TEXT NOT NULL, route_key TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (participant, journey)
    );
    CREATE INDEX IF NOT EXISTS choice_route_expiry ON route_choices(route_key, expires_at);
    CREATE TABLE IF NOT EXISTS route_choice_events (
      id INTEGER PRIMARY KEY, participant TEXT NOT NULL, journey TEXT NOT NULL,
      previous_route TEXT, route_key TEXT NOT NULL, chosen_at INTEGER NOT NULL,
      decision_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_participant ON route_choice_events(participant, chosen_at);
  `);
  const active = (participant, journey, now) => db.prepare(
    'SELECT * FROM route_choices WHERE participant = ? AND journey = ? AND expires_at > ?'
  ).get(participant, journey, now) || null;
  return {
    active,
    registerRoutes: db.transaction((routes, mode) => {
      const insert = db.prepare('INSERT OR IGNORE INTO route_catalog(route_key,mode,geometry_json) VALUES (?,?,?)');
      for (const route of routes) insert.run(route.key,mode,JSON.stringify(route.geometry));
    }),
    counts(keys, now) {
      const q = db.prepare('SELECT count(DISTINCT participant) n FROM route_choices WHERE route_key = ? AND expires_at > ?');
      return Object.fromEntries(keys.map(key => [key, q.get(key, now).n]));
    },
    choose: db.transaction(({ participant, journey, routeKey: key, now, decision }) => {
      const old = active(participant, journey, now);
      if (old?.route_key === key) return { changed: false, previousRoute: key, expiresAt: old.expires_at };
      const expiresAt = old?.expires_at ?? now + windowMs;
      db.prepare(`INSERT INTO route_choices VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(participant, journey) DO UPDATE SET route_key=excluded.route_key,
        created_at=excluded.created_at, expires_at=excluded.expires_at`).run(participant, journey, key, old?.created_at ?? now, expiresAt);
      db.prepare('INSERT INTO route_choice_events(participant,journey,previous_route,route_key,chosen_at,decision_json) VALUES (?,?,?,?,?,?)')
        .run(participant, journey, old?.route_key ?? null, key, now, JSON.stringify(decision));
      return { changed: true, previousRoute: old?.route_key ?? null, expiresAt };
    }),
    history(participant) {
      return db.prepare(`SELECT e.id, e.previous_route, e.route_key, e.chosen_at, e.decision_json, c.mode, c.geometry_json
        FROM route_choice_events e LEFT JOIN route_catalog c ON c.route_key=e.route_key
        WHERE participant = ? ORDER BY e.id DESC LIMIT 20`)
        .all(participant).map(({ decision_json, geometry_json, ...r }) => ({ ...r,
          geometry: geometry_json ? JSON.parse(geometry_json) : null, decision: JSON.parse(decision_json) }));
    },
    close: () => db.close(),
  };
}
