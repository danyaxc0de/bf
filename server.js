const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const { createAuthToken, confirmAuthToken, requireAuth, requirePremium, logAction, countRecentActions, grantPremiumDays } = require('./auth');
const { fullUsernameCheck, isValidFormat } = require('./telegram');
const { evaluateUsername } = require('./scoring');
const { startScanner } = require('./scanner');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use(globalLimiter);

const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PREMIUM = 100;
const TRIAL_DAYS = 3;

// --- АВТОРИЗАЦИЯ ---
app.post('/auth/telegram-init', (req, res) => {
  const token = createAuthToken();
  const botUsername = process.env.PREMIUM_BOT_USERNAME;
  res.json({ url: `https://t.me/${botUsername}?start=auth_${token}` });
});

app.post('/auth/telegram-confirm', async (req, res) => {
  const { token, telegram_id } = req.body;
  if (!token || !telegram_id) return res.status(400).json({ error: 'Нет данных' });
  const jwtToken = confirmAuthToken(token, telegram_id);
  if (!jwtToken) return res.status(400).json({ error: 'Токен неверный или уже использован' });
  res.json({ token: jwtToken });
});

// --- ПРОВЕРКА ЮЗЕРНЕЙМА ---
app.get('/check/:username', requireAuth, async (req, res) => {
  const username = req.params.username.replace('@', '');
  const user = req.user;

  if (!isValidFormat(username)) {
    return res.status(400).json({ error: 'Некорректный формат' });
  }

  const now = Date.now();
  const daysSinceReg = (now - user.created_at) / (1000 * 60 * 60 * 24);
  if (user.tier === 'free' && daysSinceReg > TRIAL_DAYS) {
    return res.status(403).json({ error: 'Пробный период закончился. Купи Premium.' });
  }

  const minLength = user.tier === 'premium' ? 5 : 6;
  if (username.length < minLength) {
    return res.status(403).json({ error: `Юзернеймы от 5 символов доступны только с Premium` });
  }

  const limit = user.tier === 'premium' ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_FREE;
  const used = countRecentActions(user.id, 'check');
  if (used >= limit) {
    return res.status(429).json({ error: `Дневной лимит (${limit}) исчерпан` });
  }

  logAction(user.id, 'check');

  const result = await fullUsernameCheck(username);
  if (result.status === 'free' || result.status === 'fragment_sale' || result.status === 'fragment_locked') {
    const { total, breakdown } = evaluateUsername(username);
    result.score = total;
    result.score_breakdown = breakdown;
  }

  res.json(result);
});

// --- ПРЕМИУМ ПОИСК ---
app.get('/search-by-name/:name', requireAuth, requirePremium, async (req, res) => {
  const base = req.params.name.toLowerCase().replace(/[^a-z]/g, '');
  if (!base) return res.status(400).json({ error: 'Укажи имя латиницей' });

  const suffixes = ['', 'tg', 'official', 'real', 'me', 'ru', 'pro', 'x'];
  const variants = new Set();

  for (const s of suffixes) variants.add(base + s);
  variants.add(base + base.slice(-1).repeat(3));
  variants.add(base + '_' + base.slice(0, 2));

  logAction(req.user.id, 'search_by_name');

  const results = [];
  for (const candidate of variants) {
    if (!isValidFormat(candidate)) continue;
    const result = await fullUsernameCheck(candidate);
    if (result.status === 'free') {
      const { total } = evaluateUsername(candidate);
      results.push({ username: candidate, score: total });
    }
  }

  res.json({ base, results: results.sort((a, b) => b.score - a.score) });
});

// --- РЕФЕРАЛКИ ---
const APP_URL = process.env.APP_URL || 'https://bubfind.app';

app.get('/referral/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Реф. код не найден' });

  const invitedCount = db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referred_by_code = ?').get(row.code).cnt;

  res.json({
    code: row.code,
    link: `${APP_URL}/?ref=${row.code}`,
    invited: invitedCount,
    bonusPerInvite: '3 дня Premium обоим',
  });
});

// --- ПРОМОКОДЫ ---
app.post('/promo/redeem', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Укажи промокод' });

  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code.toUpperCase());
  if (!promo || promo.uses_left <= 0) return res.status(404).json({ error: 'Промокод не найден' });

  const already = db.prepare('SELECT 1 FROM promo_redemptions WHERE user_id = ? AND code = ?').get(req.user.id, promo.code);
  if (already) return res.status(409).json({ error: 'Уже использован' });

  if (promo.type === 'premium_days') grantPremiumDays(req.user.id, promo.value);

  db.prepare('UPDATE promo_codes SET uses_left = uses_left - 1 WHERE code = ?').run(promo.code);
  db.prepare('INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES (?, ?, ?)').run(req.user.id, promo.code, Date.now());

  res.json({ ok: true, granted: `${promo.value} дней Premium` });
});

// --- АДМИНКА ---
const ADMIN_LOGINS = (process.env.ADMIN_LOGINS || '').split(',');

function requireAdmin(req, res, next) {
  if (!ADMIN_LOGINS.includes(req.user.telegram_id)) {
    return res.status(403).json({ error: 'Только для администратора' });
  }
  next();
}

app.post('/admin/promo/create', requireAuth, requireAdmin, (req, res) => {
  const { code, type, value, uses_left } = req.body;
  db.prepare('INSERT INTO promo_codes (code, type, value, uses_left, created_at) VALUES (?, ?, ?, ?, ?)').run(code.toUpperCase(), type, value, uses_left, Date.now());
  res.json({ ok: true });
});

// --- ОПЛАТА ---
app.get('/premium/purchase-link', requireAuth, (req, res) => {
  const payload = Buffer.from(String(req.user.id)).toString('base64url');
  res.json({ url: `https://t.me/${process.env.PREMIUM_BOT_USERNAME}?start=buy_${payload}` });
});

// --- ПУЛ НАХОДОК ---
app.get('/pool/top-finds', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT username, length, score, status, fragment_price, found_at
    FROM found_usernames
    WHERE status IN ('free', 'fragment_sale', 'fragment_locked')
    ORDER BY score DESC LIMIT 50
  `).all();
  res.json(rows);
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер на порту ${PORT}`);
  startScanner({ intervalMs: 4000 });

  // Запуск Python-бота вместе с сайтом
  try {
    const botProcess = spawn('python3', ['bot.py']);
    botProcess.stdout.on('data', (data) => console.log(`[BOT]: ${data}`));
    botProcess.stderr.on('data', (data) => console.error(`[BOT ERROR]: ${data}`));
  } catch (e) {
    console.error('Не удалось запустить бота:', e);
  }
});
