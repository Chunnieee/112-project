// db.js
//
// Opens database/pedestrian_safety.db (SQLite, built by database/build_database.py
// / `npm run db:build`) and exposes it to the rest of the app. nationalData.js
// and accidentIndex.js are the two modules that actually decide whether to use
// it -- this file's job is just "try to open it, validate it, say whether it
// worked".
//
// DATA_SOURCE env var (optional, see .env.example):
//   unset / "auto"  -- (default) use the database if it exists and passes the
//                      checks below; otherwise fall back to the JSON/binary
//                      files in pedestrianSafety/data/ silently (a console.warn
//                      only -- the app keeps working either way). This means:
//                      once you build the database once, the app starts
//                      reading from it automatically, no flag needed.
//   "sqlite"        -- require the database; THROW instead of silently
//                      falling back. Used by database/check_database.mjs to
//                      prove the database path actually works end to end.
//   "json"          -- ignore the database even if it exists and is valid;
//                      use the original JSON/binary files (for comparing
//                      results, or rolling back without deleting anything).

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "database", "pedestrian_safety.db");

// Keep this in sync with SCHEMA_VERSION in database/build_database.py.
const SCHEMA_VERSION = "1";
const REQUIRED_TABLES = ["accidents", "streetlights", "convenience_stores", "counties", "metadata"];

const mode = (process.env.DATA_SOURCE || "auto").toLowerCase();
const forceSqlite = mode === "sqlite";

function fail(message) {
  if (forceSqlite) throw new Error(`[db] ${message}`);
  console.warn(`[db] ${message} -- falling back to the JSON/binary files in pedestrianSafety/data/`);
}

export let db = null;
export let available = false;
export let dbStatus = null;
export let dbMetadata = {};

if (mode === "json") {
  // Explicitly disabled -- don't even try to open the file.
} else if (!existsSync(DB_PATH)) {
  fail("Missing database/pedestrian_safety.db (build it with: python database/build_database.py)");
} else {
  try {
    // Dynamic import so a missing `better-sqlite3` install (e.g. before the
    // first `npm install` after this dependency was added) degrades the same
    // way a missing database file does, instead of crashing the whole app.
    const { default: Database } = await import("better-sqlite3");
    const candidate = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    const existingTables = new Set(
      candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all()
    );
    const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));

    if (missingTables.length) {
      candidate.close();
      fail(`database/pedestrian_safety.db is missing table(s): ${missingTables.join(", ")} -- rebuild it`);
    } else {
      const metaRows = candidate.prepare("SELECT key, value FROM metadata").all();
      const metadata = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

      const emptyTables = REQUIRED_TABLES.filter(
        (t) => t !== "metadata" && candidate.prepare(`SELECT count(*) FROM ${t}`).pluck().get() === 0
      );

      if (emptyTables.length) {
        candidate.close();
        fail(`database/pedestrian_safety.db has empty table(s): ${emptyTables.join(", ")} -- rebuild it`);
      } else if (metadata.schema_version !== SCHEMA_VERSION) {
        candidate.close();
        fail(
          `database/pedestrian_safety.db schema v${metadata.schema_version || "?"} ` +
            `does not match the app's expected v${SCHEMA_VERSION} -- rebuild it`
        );
      } else {
        db = candidate;
        dbMetadata = metadata;
        dbStatus = {
          path: DB_PATH,
          sizeMB: Math.round((statSync(DB_PATH).size / 1e6) * 10) / 10,
          builtAt: metadata.built_at || null,
          schemaVersion: metadata.schema_version || null,
        };
        available = true;
      }
    }
  } catch (err) {
    fail(`could not open database/pedestrian_safety.db (${err.message})`);
  }
}
