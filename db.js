const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Use Postgres when DATABASE_URL is set (e.g. Neon); otherwise fall back to
// a local SQLite file.
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_POSTGRES = !!DATABASE_URL;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  school_id     TEXT NOT NULL,
  program       TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  ign           TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration','ongoing','completed')),
  champion_team_id  INTEGER,
  certificates_sent INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  match_date    TEXT NOT NULL,
  match_time    TEXT NOT NULL,
  venue         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id      INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  captain_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL COLLATE NOCASE,
  members            TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  seed               INTEGER,
  qualified_notified INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tournament_id, captain_id),
  UNIQUE (tournament_id, name)
);

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  label         INTEGER NOT NULL,
  team1_id      INTEGER,
  team2_id      INTEGER,
  score1        INTEGER,
  score2        INTEGER,
  winner_id     INTEGER,
  UNIQUE (tournament_id, label)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  emailed    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  school_id     TEXT NOT NULL,
  program       TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  ign           TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tournaments (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration','ongoing','completed')),
  champion_team_id  INTEGER,
  certificates_sent INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedules (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  match_date    TEXT NOT NULL,
  match_time    TEXT NOT NULL,
  venue         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id                 SERIAL PRIMARY KEY,
  tournament_id      INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  captain_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  members            TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  seed               INTEGER,
  qualified_notified INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, captain_id),
  UNIQUE (tournament_id, name)
);

CREATE TABLE IF NOT EXISTS matches (
  id            SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  label         INTEGER NOT NULL,
  team1_id      INTEGER,
  team2_id      INTEGER,
  score1        INTEGER,
  score2        INTEGER,
  winner_id     INTEGER,
  UNIQUE (tournament_id, label)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  emailed    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let pgPool = null;
let sqlite = null;

/* ---------- SQLite helpers ---------- */
// All SQLite work is queued so a transaction cannot be interleaved with
// another request while it awaits (better-sqlite3 is synchronous).
let sqliteQueue = Promise.resolve();
function sqliteLocked(fn) {
  const result = sqliteQueue.then(fn, fn);
  sqliteQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

function runSqlite(sql, params) {
  const stmt = sqlite.prepare(sql);
  const returnsRows = /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
  if (returnsRows) return { rows: stmt.all(...params), rowCount: 0 };
  const info = stmt.run(...params);
  return { rows: [], rowCount: info.changes };
}

/* ---------- query API (works with both databases) ---------- */
// Postgres uses $1 placeholders; the app writes ? everywhere.
function toPgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function query(sql, params = []) {
  if (USE_POSTGRES) {
    const result = await pgPool.query(toPgSql(sql), params);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  return sqliteLocked(() => runSqlite(sql, params));
}

const all = async (sql, params = []) => (await query(sql, params)).rows;
const get = async (sql, params = []) => (await all(sql, params))[0] || null;
const run = async (sql, params = []) => (await query(sql, params)).rowCount;

async function withTransaction(work) {
  if (USE_POSTGRES) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        all: async (sql, params = []) => (await client.query(toPgSql(sql), params)).rows,
        get: async (sql, params = []) => (await client.query(toPgSql(sql), params)).rows[0] || null,
        run: async (sql, params = []) => (await client.query(toPgSql(sql), params)).rowCount,
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return sqliteLocked(async () => {
    sqlite.exec('BEGIN');
    try {
      const tx = {
        all: async (sql, params = []) => runSqlite(sql, params).rows,
        get: async (sql, params = []) => runSqlite(sql, params).rows[0] || null,
        run: async (sql, params = []) => runSqlite(sql, params).rowCount,
      };
      const result = await work(tx);
      sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  });
}

async function initDb() {
  if (USE_POSTGRES) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /sslmode=disable/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
    pgPool.on('error', (err) => console.error('Postgres pool error:', err.message));
    for (const statement of POSTGRES_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pgPool.query(statement);
    }
    console.log('Database: Postgres (DATABASE_URL)');
    return;
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error('better-sqlite3 is not installed. Set DATABASE_URL to use Postgres instead.');
  }

  // DB_PATH lets a host mount a persistent disk (e.g. /data/database.sqlite).
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SQLITE_SCHEMA);
  console.log(`Database: SQLite (${dbPath})`);
}

// Creates the single admin account from .env if it does not exist yet.
async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account created.');
    return;
  }
  if (await get('SELECT id FROM users WHERE email = ?', [email])) return;
  await run(
    `INSERT INTO users (full_name, school_id, program, email, ign, password_hash, role)
     VALUES (?, 'ADMIN', 'ADMIN', ?, 'ADMIN', ?, 'admin')`,
    [process.env.ADMIN_NAME || 'Admin', email, bcrypt.hashSync(password, 10)]
  );
  console.log(`Admin account created: ${email}`);
}

const isUniqueViolation = (err) =>
  !!err && (err.code === '23505' || String(err.code || '').startsWith('SQLITE_CONSTRAINT'));

module.exports = { initDb, seedAdmin, get, all, run, withTransaction, isUniqueViolation };
