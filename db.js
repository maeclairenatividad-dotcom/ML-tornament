const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// DB_PATH lets a host mount a persistent disk (e.g. /data/database.sqlite).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);

// Creates the single admin account from .env if it does not exist yet.
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account created.');
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;
  db.prepare(
    `INSERT INTO users (full_name, school_id, program, email, ign, password_hash, role)
     VALUES (?, 'ADMIN', 'ADMIN', ?, 'ADMIN', ?, 'admin')`
  ).run(process.env.ADMIN_NAME || 'Admin', email, bcrypt.hashSync(password, 10));
  console.log(`Admin account created: ${email}`);
}

module.exports = { db, seedAdmin };
