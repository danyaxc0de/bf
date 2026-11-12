const Database = require('better-sqlite3');
const fs = require('fs');
const https = require('https');

const DB_PATH = '/tmp/app.db';

async function downloadDb() {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${process.env.GITHUB_REPO}/main/app.db`;
    https.get(url, (res) => {
      if (res.statusCode === 200) {
        const file = fs.createWriteStream(DB_PATH);
        res.pipe(file);
        file.on('finish', () => { file.close(); console.log('База скачана с GitHub.'); resolve(); });
      } else { resolve(); }
    }).on('error', () => resolve());
  });
}

async function uploadDb() {
  if (!fs.existsSync(DB_PATH)) return;
  const content = fs.readFileSync(DB_PATH).toString('base64');
  
  const data = JSON.stringify({
    message: 'Update database',
    content: content,
    sha: await getFileSha(),
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${process.env.GITHUB_REPO}/contents/app.db`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'Node.js',
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => { console.log('База загружена на GitHub.'); resolve(); });
    });
    req.write(data);
    req.end();
  });
}

async function getFileSha() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${process.env.GITHUB_REPO}/contents/app.db`,
      method: 'GET',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'Node.js' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { const json = JSON.parse(body); resolve(json.sha || ''); } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.end();
  });
}

async function init() {
  await downloadDb();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT UNIQUE NOT NULL, tier TEXT NOT NULL DEFAULT 'free', created_at INTEGER NOT NULL, premium_until INTEGER);
    CREATE TABLE IF NOT EXISTS auth_tokens (token TEXT PRIMARY KEY, telegram_id TEXT, created_at INTEGER NOT NULL, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS found_usernames (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, length INTEGER NOT NULL, score INTEGER NOT NULL, score_breakdown TEXT, status TEXT NOT NULL DEFAULT 'free', fragment_price TEXT, found_at INTEGER NOT NULL, last_checked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, username_id INTEGER NOT NULL, user_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL, code TEXT UNIQUE NOT NULL, referred_by_code TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS promo_codes (code TEXT PRIMARY KEY, type TEXT NOT NULL, value INTEGER NOT NULL, uses_left INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS promo_redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT NOT NULL, redeemed_at INTEGER NOT NULL);
  `);
  
  setInterval(uploadDb, 120000);
  return db;
}

module.exports = { init, uploadDb };
