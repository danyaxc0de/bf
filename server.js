const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { spawn } = require('child_process');
const { init } = require('./db');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use(globalLimiter);

const PORT = process.env.PORT || 3000;
const ADMIN_IDS = ['8192413936'];
const APP_URL = process.env.APP_URL || 'https://bubfind.js.org';

init().then((database) => {
  console.log('База данных готова к работе!');
  global.db = database;

  const { requireAuth } = require('./auth');
  const { fullUsernameCheck, isValidFormat } = require('./telegram');
  const { evaluateUsername } = require('./scoring');

  // --- АВТОРИЗАЦИЯ ---
  app.post('/auth/register', (req, res) => {
    const { login, password, ref } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at) VALUES (?, ?, ?)').run(login, 'free', Date.now());
      const userId = info.lastInsertRowid;
      
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());

      if (ref) {
        const refUser = global.db.prepare('SELECT user_id FROM referrals WHERE code = ?').get(ref);
        if (refUser) {
          global.db.prepare('UPDATE referrals SET referred_by_code = ? WHERE user_id = ?').run(ref, userId);
          checkReferralBonus(refUser.user_id);
        }
      }

      const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token });
    } catch (e) { res.status(500).json({ error: 'Пользователь уже существует' }); }
  });

  function checkReferralBonus(userId) {
    const count = global.db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referred_by_code = (SELECT code FROM referrals WHERE user_id = ?)').get(userId).cnt;
    if (count >= 5) {
      const existing = global.db.prepare('SELECT code FROM promo_codes WHERE created_at = ?').get(userId);
      if (!existing) {
        const promoCode = 'VIP-' + Math.random().toString(36).slice(2, 7).toUpperCase();
        global.db.prepare('INSERT INTO promo_codes (code, type, value, uses_left, created_at) VALUES (?, ?, ?, ?, ?)').run(promoCode, 'premium_days', 1, 1, userId);
      }
    }
  }

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token, tier: user.tier });
  });

  // --- ВЕБХУК ОТ БОТА (Промокоды) ---
  app.post('/promo/redeem', (req, res) => {
    const { code, telegram_id } = req.body;
    const promo = global.db.prepare('SELECT * FROM promo_codes WHERE code = ? AND uses_left > 0').get(code);
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    
    const user = global.db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(telegram_id);
    if (!user) return res.status(404).json({ error: 'Юзер не найден' });

    const now = Date.now();
    const addDays = 1;
    const newPremium = now + (addDays * 24 * 60 * 60 * 1000);

    global.db.prepare('UPDATE users SET tier = ?, premium_until = ? WHERE id = ?').run('premium', newPremium, user.id);
    global.db.prepare('UPDATE promo_codes SET uses_left = uses_left - 1 WHERE code = ?').run(code);
    res.json({ ok: true });
  });

  // --- РЕФЕРАЛЬНАЯ ССЫЛКА ---
  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    const invitedCount = global.db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referred_by_code = ?').get(row.code).cnt;
    res.json({ code: row.code, link: `${APP_URL}/r/${row.code}`, invited: invitedCount, bonusPerInvite: '5 друзей = 1 день Premium' });
  });

  app.get('/r/:code', (req, res) => { res.redirect(`/?ref=${req.params.code}`); });

  // --- ПОИСК ---
  app.get('/check/:username', async (req, res) => {
    const username = req.params.username.replace('@', '');
    if (!isValidFormat(username)) return res.status(400).json({ error: 'Некорректный формат' });
    const result = await fullUsernameCheck(username);
    if (result.status === 'free') {
      const { total, breakdown } = evaluateUsername(username);
      result.score = total; result.score_breakdown = breakdown;
    }
    res.json(result);
  });

  app.get('/search-by-name/:name', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT tier, premium_until FROM users WHERE id = ?').get(req.user.id);
    if (user.tier !== 'premium' || (user.premium_until && user.premium_until < Date.now())) {
      return res.status(403).json({ error: 'Доступно только с Premium-подпиской' });
    }

    const baseName = req.params.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (baseName.length < 2) return res.status(400).json({ error: 'Имя слишком короткое' });

    const variations = [baseName + '1', baseName + '7', baseName + '0', baseName + '9', baseName + '77', baseName + '228', baseName + 'x', baseName + 'pro', baseName + 'top', baseName + 'vip'];
    const results = [];
    for (const username of variations) {
      if (!isValidFormat(username)) continue;
      const check = await fullUsernameCheck(username);
      if (check.status === 'free') {
        const { total } = evaluateUsername(username);
        results.push({ username, score: total });
      }
      await new Promise(r => setTimeout(r, 150)); 
    }
    results.sort((a, b) => b.score - a.score);
    res.json({ base: baseName, results });
  });

  app.get('/pool/top-finds', (req, res) => {
    const rows = global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all();
    res.json(rows);
  });

  // --- АДМИНКА ---
  const checkAdmin = (req, res, next) => {
    const user = global.db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.user.id);
    if (!ADMIN_IDS.includes(user.telegram_id)) return res.status(403).json({ error: 'Доступ запрещен' });
    next();
  };

  app.get('/admin/users', requireAuth, checkAdmin, (req, res) => {
    const users = global.db.prepare('SELECT id, telegram_id, tier, premium_until, created_at FROM users ORDER BY created_at DESC').all();
    res.json(users);
  });

  app.get('/admin/user/:id', requireAuth, checkAdmin, (req, res) => {
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Юзер не найден' });
    const claimed = global.db.prepare('SELECT * FROM found_usernames WHERE claimed_by = ?').all(user.telegram_id);
    res.json({ user, claimed });
  });

  app.post('/admin/toggle-hide/:id', requireAuth, checkAdmin, (req, res) => {
    const { is_hidden } = req.body;
    global.db.prepare('UPDATE found_usernames SET is_hidden = ? WHERE id = ?').run(is_hidden ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер на порту ${PORT}`);
    const { startScanner } = require('./scanner');
    startScanner({ intervalMs: 10000 });
    try { spawn('python3', ['bot.py']); } catch (e) {}
  });
});
