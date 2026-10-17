/*
 * 帳號模組：註冊、登入、取得目前使用者、登出
 *
 * - 帳號存在 backend/data/users.sqlite（與 route-choices.sqlite 分開）
 * - 密碼使用 Node 內建 crypto.scrypt 加鹽雜湊，不需要額外套件
 * - 登入後發 Bearer token；資料庫只存 token 的 SHA-256，30 天到期
 *
 * 掛載方式（server.js）：
 *   import { createAuthRouter } from "./authStore.js";
 *   app.use("/api/auth", createAuthRouter());
 */
import express from "express";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "data", "users.sqlite");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored).split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  const expected = Buffer.from(keyHex, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function openAuthDb(dbPath = process.env.AUTH_DB_PATH || DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  return db;
}

const publicUser = (row) => ({ id: row.id, email: row.email, displayName: row.display_name });

export function createAuthRouter({ db = openAuthDb() } = {}) {
  const router = express.Router();

  const findByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const insertUser = db.prepare(
    "INSERT INTO users (email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)"
  );
  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  );
  const findSession = db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `);
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const purgeExpired = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  function issueToken(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    purgeExpired.run(now);
    insertSession.run(sha256(token), userId, now, now + TOKEN_TTL_MS);
    return token;
  }

  const bearer = (req) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    return match ? match[1].trim() : "";
  };

  router.post("/register", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || "").trim() || email.split("@")[0];

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "請輸入有效的電子郵件" });
    if (password.length < 8) return res.status(400).json({ error: "密碼至少需要 8 個字元" });
    if (displayName.length > 40) return res.status(400).json({ error: "暱稱最多 40 個字" });
    if (findByEmail.get(email)) return res.status(409).json({ error: "這個電子郵件已經註冊，請直接登入" });

    try {
      const hash = await hashPassword(password);
      const info = insertUser.run(email, displayName, hash, Date.now());
      const user = { id: Number(info.lastInsertRowid), email, display_name: displayName };
      res.status(201).json({ token: issueToken(user.id), user: publicUser(user) });
    } catch (error) {
      if (String(error?.code).startsWith("SQLITE_CONSTRAINT")) {
        return res.status(409).json({ error: "這個電子郵件已經註冊，請直接登入" });
      }
      console.error("[auth] register failed", error);
      res.status(500).json({ error: "註冊失敗，請稍後再試" });
    }
  });

  router.post("/login", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const row = email ? findByEmail.get(email) : null;
    const ok = row ? await verifyPassword(password, row.password_hash) : false;
    if (!ok) return res.status(401).json({ error: "電子郵件或密碼不正確" });
    res.json({ token: issueToken(row.id), user: publicUser(row) });
  });

  router.get("/me", (req, res) => {
    const token = bearer(req);
    const row = token ? findSession.get(sha256(token), Date.now()) : null;
    if (!row) return res.status(401).json({ error: "登入已過期，請重新登入" });
    res.json({ user: publicUser(row) });
  });

  router.post("/logout", (req, res) => {
    const token = bearer(req);
    if (token) deleteSession.run(sha256(token));
    res.json({ ok: true });
  });

  return router;
}
