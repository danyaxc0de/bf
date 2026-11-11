const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  premium_until INTEGER
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  telegram_id TEXT,
  created_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS found_usernames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  length INTEGER NOT NULL,
  score INTEGER NOT NULL,
  score_breakdown TEXT,
  status TEXT NOT NULL DEFAULT 'free',
  fragment_price TEXT,
  found_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_id INTEGER NOT NULL REFERENCES found_usernames(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  code TEXT UNIQUE NOT NULL,
  referred_by_code TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  value INTEGER NOT NULL,
  uses_left INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL
);
`);

module.exports = db;
