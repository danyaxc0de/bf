const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_12345';
const TOKEN_TTL = '7d';

function generateReferralCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createAuthToken() {
  const token = Math.random().toString(36).slice(2, 12);
  db.prepare('INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)').run(token, Date.now());
  return token;
}

function confirmAuthToken(token, telegramId) {
  const record = db.prepare('SELECT * FROM auth_tokens WHERE token = ? AND used = 0').get(token);
  if (!record) return null;

  db.prepare('UPDATE auth_tokens SET telegram_id = ?, used = 1 WHERE token = ?').run(telegramId, token);
  
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) {
    const info = db.prepare('INSERT INTO users (telegram_id, tier, created_at) VALUES (?, ?, ?)').run(telegramId, 'free', Date.now());
    const userId = info.lastInsertRowid;
    let code = generateReferralCode();
    while (db.prepare('SELECT 1 FROM referrals WHERE code = ?').get(code)) {
      code = generateReferralCode();
    }
    db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  }

  return issueToken(user.id);
}

function issueToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'Нужна авторизация' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, tier, created_at, telegram_id FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Токен недействителен' });
  }
}

function requirePremium(req, res, next) {
  if (req.user.tier !== 'premium') {
    return res.status(403).json({ error: 'Доступно только с премиум-подпиской' });
  }
  next();
}

function logAction(userId, action) {
  db.prepare('INSERT INTO request_log (user_id, action, created_at) VALUES (?, ?, ?)').run(userId, action, Date.now());
}

function countRecentActions(userId, action, hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const row = db.prepare('SELECT COUNT(*) as cnt FROM request_log WHERE user_id = ? AND action = ? AND created_at > ?').get(userId, action, since);
  return row.cnt;
}

function grantPremiumDays(userId, days) {
  const user = db.prepare('SELECT premium_until FROM users WHERE id = ?').get(userId);
  const now = Date.now();
  const base = user.premium_until && user.premium_until > now ? user.premium_until : now;
  db.prepare('UPDATE users SET tier = ?, premium_until = ? WHERE id = ?').run('premium', base + days * 24 * 60 * 60 * 1000, userId);
}

module.exports = {
  createAuthToken, confirmAuthToken, requireAuth, requirePremium, logAction, countRecentActions, grantPremiumDays,
};
