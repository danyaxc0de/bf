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
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    const existing = global.db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(login);
    if (existing) return res.status(400).json({ error: 'Логин занят' });

    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at, coins) VALUES (?, ?, ?, ?)').run(login, 'free', Date.now(), 30);
      const userId = info.lastInsertRowid;
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
      const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token, coins: 30 });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token, tier: user.tier, coins: user.coins });
  });

  // --- ПОИСК (СПИСАНИЕ ЮКОВ) ---
  app.get('/check/:username', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    
    if (user.coins < 10) return res.status(403).json({ error: 'Недостаточно ЮК. Купи в профиле.' });

    const username = req.params.username.replace('@', '');
    if (!isValidFormat(username)) return res.status(400).json({ error: 'Некорректный формат' });
    
    global.db.prepare('UPDATE users SET coins = coins - 10 WHERE id = ?').run(user.id);

    const result = await fullUsernameCheck(username);
    if (result.status === 'free') {
      const { total, breakdown } = evaluateUsername(username);
      result.score = total; result.score_breakdown = breakdown;
    }
    res.json(result);
  });

  // --- ИМЕННЫЕ ---
  app.get('/search-by-name/:name', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT tier, premium_until FROM users WHERE id = ?').get(req.user.id);
    if (user.tier !== 'premium' || (user.premium_until && user.premium_until < Date.now())) {
      return res.status(403).json({ error: 'Доступно только с Premium' });
    }

    const baseName = req.params.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (baseName.length < 2) return res.status(400).json({ error: 'Имя короткое' });

    const variations = [baseName + '1', baseName + '7', baseName + '0', baseName + '9', baseName + '77', baseName + '228', baseName + 'x', baseName + 'pro', baseName + 'top', baseName + 'vip'];
    const results = [];
    for (const username of variations) {
      if (!isValidFormat(username)) continue;
      const check = await fullUsernameCheck(username);
      if (check.status === 'free') {
        const { total } = evaluateUsername(username);
        results.push({ username, score: total });
      }
      await new Promise(r => setTimeout(r, 200)); 
    }
    results.sort((a, b) => b.score - a.score);
    res.json({ base: baseName, results });
  });

  // --- НАХОДКИ И РЕФЕРАЛКИ ---
  app.get('/pool/top-finds', (req, res) => {
    res.json(global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all());
  });

  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    res.json({ code: row.code, link: `${APP_URL}/r/${row.code}`, invited: 0, bonusPerInvite: '' });
  });

  // --- ВЕБХУК ОПЛАТЫ (С БОНУСАМИ) ---
  app.post('/auth/premium-webhook', (req, res) => {
    const { telegram_id, plan, type } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (type === 'coins') {
      let coinsToAdd = 0;
      if (plan === 'coins_50') coinsToAdd = 50;
      if (plan === 'coins_150') coinsToAdd = 150;
      if (plan === 'coins_500') coinsToAdd = 500;
      global.db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coinsToAdd, user.id);
      return res.json({ ok: true });
    }

    if (type === 'premium') {
      let addDays = 0;
      let bonusCoins = 0;
      if (plan === 'day') { addDays = 1; bonusCoins = 20; }
      if (plan === 'week') { addDays = 7; bonusCoins = 150; }
      if (plan === 'month') { addDays = 30; bonusCoins = 700; }
      if (plan === 'forever') { addDays = 36500; bonusCoins = 5000; }

      const now = Date.now();
      const currentPremium = user.premium_until || now;
      const newPremium = currentPremium + (addDays * 24 * 60 * 60 * 1000);

      global.db.prepare('UPDATE users SET tier = ?, premium_until = ?, coins = coins + ? WHERE id = ?').run('premium', newPremium, bonusCoins, user.id);
      res.json({ ok: true });
    }
  });

  // --- АДМИНКА ---
  const checkAdmin = (req, res, next) => {
    const user = global.db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.user.id);
    if (!ADMIN_IDS.includes(user.telegram_id)) return res.status(403).json({ error: 'Доступ запрещен' });
    next();
  };

  app.post('/admin/create-promo', requireAuth, checkAdmin, (req, res) => {
    const { code, value, uses_left } = req.body;
    try {
      global.db.prepare('INSERT INTO promo_codes (code, type, value, uses_left, created_at) VALUES (?, ?, ?, ?, ?)').run(code.toUpperCase(), 'coins', value, uses_left, Date.now());
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
  });

  app.get('/admin/users', requireAuth, checkAdmin, (req, res) => {
    res.json(global.db.prepare('SELECT id, telegram_id, tier, coins, created_at FROM users ORDER BY created_at DESC').all());
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер на порту ${PORT}`);
    const { startScanner } = require('./scanner');
    startScanner({ intervalMs: 10000 });
    try { spawn('python3', ['bot.py']); } catch (e) {}
  });
});
